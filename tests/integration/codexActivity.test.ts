// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { codexFixture } from '../fixtures/codexFixture'
import { activityItems } from '../fixtures/codexActivityFixture'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const f = await codexFixture()
  let history = true
  const workspace = new WorkspaceHost(f.host, f.root, () => history)
  cleanup.push(async () => { workspace.disconnect(); await f.adapter.closed(); await workspace.privacyChanged(); workspace.dispose(); await f.cleanup() })
  await workspace.connect()
  await workspace.execute({ type: 'create-project', commandId: 'project', projectId: 'project', title: 'Fixture', path: f.root })
  await workspace.execute({ type: 'create-thread', commandId: 'create', threadId: 'thread', projectId: 'project', title: 'Fixture', modelId: f.modelId })
  await workspace.execute({ type: 'send', commandId: 'send', threadId: 'thread', messageId: 'own-message', text: 'Fixture task' })
  const turnId = workspace.workspaceSnapshot().threads[0]!.lastTurn!.id
  const thread = () => workspace.workspaceSnapshot().threads[0]!
  const notify = async (method: string, params: Record<string, unknown>, persist = false) => {
    const event = new Promise<void>(resolve => { const off = f.host.subscribe(() => { off(); resolve() }) })
    await f.action('thread', { type: 'notify', method, params: { turnId, ...params }, persist })
    await event
  }
  return { f, workspace, turnId, thread, notify, setHistory: (value: boolean) => { history = value } }
}

describe('Codex activity through native transport and workspace persistence', () => {
  it('keeps native image-generation completions from disconnecting other threads or poisoning reconnect', async () => {
    const { f, workspace, thread, notify } = await fixture()
    await workspace.execute({ type: 'create-thread', commandId: 'create-other', threadId: 'other', projectId: 'project', title: 'Other', modelId: f.modelId })
    await notify('item/completed', { item: { id: 'native-image', type: 'imageGeneration', status: 'completed', result: 'SYNTHETIC_IMAGE_RESULT', revisedPrompt: null } }, true)
    expect((await workspace.snapshot()).connected).toBe(true)
    expect(workspace.workspaceSnapshot().threads).toHaveLength(2)
    expect(JSON.stringify(thread())).not.toContain('SYNTHETIC_IMAGE_RESULT')
    workspace.disconnect(); await f.adapter.closed()
    await workspace.connect()
    expect((await workspace.snapshot()).connected).toBe(true)
    expect(workspace.workspaceSnapshot().threads).toHaveLength(2)
    expect((await f.driver.requests()).filter(record => record.method === 'turn/start')).toHaveLength(1)
  })
  it('restores commands, diffs, errors, summaries and child lifecycle without replay or duplicated final answers', async () => {
    const { f, workspace, thread, turnId, notify } = await fixture()
    await notify('item/started', { item: activityItems.command, startedAtMs: 1_000 }, true)
    await notify('item/commandExecution/outputDelta', { itemId: activityItems.command.id, delta: 'partial' })
    expect(thread().activities?.find(item => item.kind === 'command')?.output).toBe('partial')
    for (const item of [activityItems.commandDone, activityItems.change, activityItems.reasoning, activityItems.tool, activityItems.spawn]) {
      await notify('item/completed', { item, completedAtMs: 1_800 }, true)
    }
    await notify('turn/completed', { threadId: 'native-child', turn: { id: 'child-turn', status: 'completed', items: [] } })
    expect(thread().activities?.find(item => item.kind === 'subagent')?.agents?.[0]?.status).toBe('completed')
    const beforeCount = thread().activities!.length
    await notify('item/completed', { item: activityItems.commandDone, completedAtMs: 1_800 }, true)
    await notify('item/commandExecution/outputDelta', { itemId: activityItems.command.id, delta: 'duplicate late delta' })
    expect(thread().activities).toHaveLength(beforeCount)
    expect(thread().activities?.find(item => item.kind === 'command')?.output).toBe('2 tests passed\n')
    await f.driver.completeTurn('thread', 'One final answer')
    await expect.poll(() => thread().lastTurn?.status).toBe('completed')
    const final = thread().messages.find(message => message.role === 'assistant')!
    await notify('item/started', { item: { id: final.id, type: 'agentMessage', text: '' } })
    await notify('item/agentMessage/delta', { itemId: final.id, delta: 'One final answer' })
    expect(thread().messages.filter(message => message.role === 'assistant')).toEqual([final])
    await workspace.snapshot()
    const before = structuredClone(thread())
    const savedText = await readFile(join(f.root, 'workspace.json'), 'utf8')
    expect(savedText).toContain('2 tests passed')
    expect(savedText).not.toContain('PRIVATE_REASONING')
    expect(savedText).not.toContain('native-child')
    workspace.disconnect(); await f.adapter.closed(); await workspace.privacyChanged()
    const restarted = await codexFixture(f.root)
    const restored = new WorkspaceHost(restarted.host, f.root)
    cleanup.push(async () => { restored.disconnect(); await restarted.adapter.closed(); await restored.privacyChanged(); restored.dispose() })
    await restored.initialize()
    expect(restored.workspaceSnapshot().threads[0]?.activities?.filter(record => record.kind !== 'subagent' && !record.agents?.length)).toEqual(before.activities?.filter(record => record.kind !== 'subagent' && !record.agents?.length))
    expect(restored.workspaceSnapshot().threads[0]?.activities?.find(record => record.kind === 'subagent')).toMatchObject({ title: 'Subagent' })
    const child = before.activities!.find(record => record.kind === 'subagent')!.agents![0]!
    expect((await restored.subagentPage({ threadId: 'thread' })).rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: child.id, status: 'completed' })]))
    expect((await restored.subagentAssignments({ threadId: 'thread', agentId: child.id })).assignments[0]?.prompt).toBe('Review the fixture')
    restarted.host.observeThreads?.(['thread'])
    await restored.connect()
    const after = (await restored.snapshot()).threads[0]!
    expect(after.activities?.map(record => record.id)).toEqual(before.activities?.map(record => record.id))
    expect(after.activities?.find(record => record.kind === 'command')).toEqual(before.activities?.find(record => record.kind === 'command'))
    expect((await restored.subagentPage({ threadId: 'thread' })).rows.find(row => row.id === child.id)?.status).toBe('completed')
    expect(after.messages).toEqual(before.messages)
    expect(after.lastTurn).toEqual({ id: turnId, status: 'completed' })
    expect((await restarted.driver.requests()).filter(record => record.method === 'turn/start')).toHaveLength(1)
  })

  it('strips all activity detail from persisted history when history is disabled and on disabled startup', async () => {
    const { f, workspace, thread, notify, setHistory } = await fixture()
    await notify('item/completed', { item: activityItems.commandDone }, true)
    await workspace.privacyChanged()
    expect(await readFile(join(f.root, 'workspace.json'), 'utf8')).toContain('2 tests passed')
    setHistory(false); await workspace.privacyChanged()
    expect(thread().activities?.some(record => record.output)).toBe(true) // current live work remains visible
    const saved = await readFile(join(f.root, 'workspace.json'), 'utf8')
    expect(saved).not.toContain('2 tests passed')
    expect(saved).not.toContain('npm test')
    expect(JSON.parse(saved).snapshot.threads[0]).not.toHaveProperty('activities')
    // Exercise reading a previously enabled cache with privacy disabled at startup.
    setHistory(true); await workspace.privacyChanged()
    const restored = new WorkspaceHost(new FakeProviderHost(), f.root, () => false)
    await restored.initialize()
    expect(restored.workspaceSnapshot().threads[0]).not.toHaveProperty('activities')
    expect(await readFile(join(f.root, 'workspace.json'), 'utf8')).not.toContain('npm test')
    restored.dispose()
  })

  it('keeps retrying errors running, exposes interruption to the queue, and does not infer tool success', async () => {
    const { f, workspace, thread, turnId, notify } = await fixture()
    await notify('item/started', { item: activityItems.command, startedAtMs: 1_000 }, true)
    await notify('error', { error: { message: 'Temporary fixture disconnection' }, willRetry: true })
    expect(thread().status).toBe('running')
    expect(thread().lastTurn).toEqual({ id: turnId, status: 'running' })
    expect(thread().activities?.find(record => record.title === 'Codex is retrying')?.error).toBe('Temporary fixture disconnection')
    await workspace.execute({ type: 'interrupt', commandId: 'interrupt', threadId: 'thread' })
    expect(thread().lastTurn).toEqual({ id: turnId, status: 'interrupted' })
    expect(thread().activities?.find(record => record.kind === 'command')?.status).toBe('interrupted')
    await f.adapter.refreshThread('thread')
    expect(thread().lastTurn?.status).toBe('interrupted')
  })
})
