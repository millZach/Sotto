// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import type { AgentActivity, ObservedAgent } from '../../../src/shared/agentActivity'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import type { SubagentChange } from '../../../src/shared/subagents'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-subagents-workspace-'))
  const native = new FakeProviderHost()
  let history = true
  const host = new WorkspaceHost(native, directory, () => history)
  await host.initialize(); await host.connect()
  cleanups.push(async () => { host.dispose(); await rm(directory, { recursive: true, force: true }) })
  const thread = native.state.threads[0]!
  const observe = (agents: ObservedAgent[], activityId = 'spawn'): void => {
    thread.activities = [{ id: activityId, turnId: 'turn', sequence: 0, kind: 'subagent', title: 'Spawn agent', status: 'completed', agents }]
    native.emit()
  }
  return { host, native, directory, thread, observe, history: async (enabled: boolean) => { history = enabled; await host.privacyChanged() } }
}
function child(patch: Partial<ObservedAgent> = {}): ObservedAgent {
  return { id: 'child', assignmentId: 'assignment-1', title: 'Review provider mappings', prompt: 'Check the child lifecycle.', model: 'reported-model', status: 'running', observedAt: new Date().toISOString(), ...patch }
}

describe('retained agents across workspace lifecycle', () => {
  it('tracks a child independently of its finished spawn action and retains it after ordinary activity eviction', async () => {
    const f = await fixture()
    f.observe([child()])
    expect(f.host.workspaceSnapshot().threads[0]!.subagentSummary?.working).toBe(1)
    expect((await f.host.subagentPage({ threadId: f.thread.id })).rows[0]).toMatchObject({ title: 'Review provider mappings', model: 'reported-model', status: 'running' })
    f.thread.status = 'idle'
    f.thread.activities = Array.from({ length: 2_000 }, (_, index): AgentActivity => ({ id: `tool-${index}`, sequence: index + 1, turnId: 'later', kind: 'tool', status: 'completed', title: 'Read file' }))
    f.native.emit()
    expect(f.host.workspaceSnapshot().threads[0]!.subagentSummary?.working).toBe(1)
    expect((await f.host.subagentPage({ threadId: f.thread.id })).rows).toHaveLength(1)
    expect(JSON.stringify(f.host.workspaceSnapshot())).not.toContain('assignment-1')
  })
  it('keeps history after restart and waits for fresh provider evidence before restoring the working indicator', async () => {
    const f = await fixture()
    const original = child()
    f.observe([original])
    await f.host.privacyChanged()
    f.host.dispose()
    const native = new FakeProviderHost(f.native.state)
    const reopened = new WorkspaceHost(native, f.directory)
    await reopened.initialize()
    cleanups.push(async () => { reopened.dispose() })
    expect((await reopened.subagentPage({ threadId: f.thread.id })).rows[0]?.status).toBe('unknown')
    await reopened.connect()
    expect(reopened.workspaceSnapshot().threads[0]!.subagentSummary?.working).toBe(0)
    const observedAt = new Date(Date.now() + 1).toISOString()
    native.state.threads[0]!.activities![0]!.agents = [{ ...original, observedAt }]
    native.emit()
    expect(reopened.workspaceSnapshot().threads[0]!.subagentSummary?.working).toBe(1)
  })
  it('coalesces bursts, preserves result history on reuse and clears saved words when history is disabled', async () => {
    const f = await fixture()
    const changes: SubagentChange[] = []
    f.host.subscribeSubagents(change => changes.push(change))
    const now = Date.now()
    for (let index = 0; index < 30; index++) f.observe([child({ observedAt: new Date(now + index).toISOString(), description: `Step ${index}` })])
    f.observe([child({ status: 'completed', message: 'A retained private result', observedAt: new Date(now + 31).toISOString() })])
    f.observe([child({ assignmentId: 'assignment-2', title: 'Review the follow-up', observedAt: new Date(now + 32).toISOString() })], 'follow-up')
    const page = await f.host.subagentPage({ threadId: f.thread.id })
    expect(page.rows).toHaveLength(1)
    expect(page.rows[0]?.assignmentCount).toBe(2)
    const assignments = await f.host.subagentAssignments({ threadId: f.thread.id, agentId: 'child' })
    expect(assignments.assignments.some(item => item.result === 'A retained private result')).toBe(true)
    await expect.poll(() => changes.length).toBe(1)
    expect(changes[0]?.rows).toHaveLength(1)
    await f.history(false)
    expect((await f.host.subagentPage({ threadId: f.thread.id })).rows).toHaveLength(0)
    const bytes = await readFile(join(f.directory, 'subagents.sqlite'))
    expect(bytes.includes(Buffer.from('A retained private result'))).toBe(false)
    await f.history(true)
    f.native.emit()
    expect((await f.host.subagentPage({ threadId: f.thread.id })).rows).toHaveLength(0)
    f.observe([child({ assignmentId: 'assignment-1', status: 'completed', title: 'Review provider mappings', prompt: 'Check the child lifecycle.', message: 'A retained private result', observedAt: new Date(now + 40).toISOString() })])
    const erased = await f.host.subagentAssignments({ threadId: f.thread.id, agentId: 'child' })
    expect(erased.assignments[0]?.status).toBe('completed')
    expect(JSON.stringify(erased)).not.toContain('A retained private result')
    expect(JSON.stringify(erased)).not.toContain('Check the child lifecycle.')
    expect(JSON.stringify(erased)).not.toContain('Review provider mappings')
    f.observe([child({ assignmentId: 'fresh-assignment', status: 'completed', title: 'A fresh task', message: 'A fresh retained result', observedAt: new Date(now + 41).toISOString() })])
    expect((await f.host.subagentAssignments({ threadId: f.thread.id, agentId: 'child' })).assignments[0]?.result).toBe('A fresh retained result')
  })
  it('keeps subagent words out of workspace organization through privacy resets and cached lifecycle updates', async () => {
    const f = await fixture()
    const secret = 'Private-subagent-workspace-marker'
    const original = child({ title: secret, description: secret, prompt: secret, message: secret })
    const ordinary: AgentActivity = { id: 'ordinary', sequence: 1, turnId: 'turn', kind: 'command', title: 'Read files', status: 'completed', output: 'Ordinary output' }
    const emit = (status: ObservedAgent['status'], observedAt: string): void => {
      f.thread.activities = [
        { id: 'spawn', turnId: 'turn', sequence: 0, kind: 'subagent', title: secret, text: secret, output: secret, status: 'completed', agents: [{ ...original, status, observedAt }] },
        // A result can arrive after the original spawn leaves the activity window.
        { id: 'late-result', turnId: 'turn', sequence: 2, kind: 'tool', title: secret, output: secret, status: 'completed', agents: [{ ...original, status, observedAt }] },
        ordinary,
      ]
      f.native.emit()
    }
    const saved = async (): Promise<string> => readFile(join(f.directory, 'workspace.json'), 'utf8')
    emit('running', new Date().toISOString())
    await f.host.privacyChanged()
    expect(await saved()).not.toContain(secret)
    expect(await saved()).toContain('Ordinary output')
    expect(JSON.stringify(f.host.workspaceSnapshot())).toContain(secret)
    expect(JSON.stringify(await f.host.subagentAssignments({ threadId: f.thread.id, agentId: 'child' }))).toContain(secret)
    await f.history(false)
    expect(await saved()).not.toContain(secret)
    await f.history(true)
    expect(await saved()).not.toContain(secret)
    emit('completed', new Date(Date.now() + 1_000).toISOString())
    await f.host.privacyChanged()
    expect(await saved()).not.toContain(secret)
    expect(await saved()).toContain('Ordinary output')
    expect(JSON.stringify(await f.host.subagentAssignments({ threadId: f.thread.id, agentId: 'child' }))).not.toContain(secret)
  })
  it('persists exclusion-only classification changes without new child observations', async () => {
    const f = await fixture()
    f.observe([child()])
    expect(f.host.activity(f.thread.id, 'spawn')?.taskUpdatesExcluded).toBeUndefined()
    f.thread.activities![0]!.taskUpdatesExcluded = true
    f.native.emit()
    expect(f.host.activity(f.thread.id, 'spawn')?.taskUpdatesExcluded).toBe(true)
    f.thread.activities = []
    f.native.emit()
    expect(f.host.activity(f.thread.id, 'spawn')).toMatchObject({ taskUpdatesExcluded: true, title: 'Subagent' })
  })
  it('marks working children uncertain when the provider disconnects and never exposes another thread through a missing ID', async () => {
    const f = await fixture()
    f.observe([child()])
    f.host.disconnect()
    expect(f.host.workspaceSnapshot().threads[0]!.subagentSummary?.working).toBe(0)
    expect((await f.host.subagentPage({ threadId: f.thread.id })).rows[0]?.status).toBe('unknown')
    await expect(f.host.subagentPage({ threadId: 'missing' })).rejects.toThrow()
  })
})
