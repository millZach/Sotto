// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { codexFixture } from '../fixtures/codexFixture'
import { ConfiguredProviderHost } from '../../src/main/agents/providerSwitch'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture(timeout = 1000) {
  const f = await codexFixture(undefined, true, timeout)
  const native = new ConfiguredProviderHost({ directory: f.root, provider: () => 'codex',
    threadProvider: id => f.registry.byThread(id)?.provider,
    hosts: { codex: f.host, claude: new FakeProviderHost(), grok: new FakeProviderHost() } })
  const workspace = new WorkspaceHost(native, f.root)
  cleanup.push(async () => { workspace.disconnect(); await f.adapter.closed(); await workspace.privacyChanged(); await f.cleanup() })
  await workspace.connect('codex')
  await workspace.execute({ type: 'create-project', commandId: 'project', projectId: 'scope', title: 'Project', path: f.root, provider: 'codex' })
  const snapshot = await workspace.snapshot()
  const model = snapshot.models[0]!
  await workspace.execute({ type: 'create-thread', commandId: 'local', threadId: 'sotto-task', projectId: 'scope', title: 'Task', modelId: model.id })
  return { f, workspace }
}

describe('workspace over native Codex transport', () => {
  it('creates native work only on first send and continues the same running work through settlement and restoration', async () => {
    const { f, workspace } = await fixture()
    expect((await f.driver.requests()).filter(record => record.method === 'thread/start')).toHaveLength(0)
    await workspace.execute({ type: 'send', commandId: 'prompt', threadId: 'sotto-task', messageId: 'prompt-message', text: 'Synthetic project work' })
    await expect.poll(async () => (await workspace.snapshot()).threads.find(thread => thread.id === 'sotto-task')?.status).toBe('running')
    const binding = f.registry.byThread('sotto-task')!
    await workspace.setWorkspaceSettled('thread', 'sotto-task', true)
    await workspace.setWorkspaceSettled('project', 'scope', true)
    await f.driver.raisePermission('sotto-task', 'Run the project build?')
    await expect.poll(async () => (await workspace.snapshot()).threads.find(thread => thread.id === 'sotto-task')?.requests.length).toBe(1)
    await workspace.setWorkspaceSettled('project', 'scope', false)
    expect(workspace.workspaceSnapshot().threads.find(thread => thread.id === 'sotto-task')?.workspaceSettledAt).toEqual(expect.any(String))
    await workspace.setWorkspaceSettled('thread', 'sotto-task', false)
    const request = workspace.workspaceSnapshot().threads.find(thread => thread.id === 'sotto-task')!.requests[0]!
    await workspace.execute({ type: 'answer', commandId: 'deny', threadId: 'sotto-task', requestId: request.id, answer: '', approved: false })
    await f.driver.completeTurn('sotto-task', 'Completed in the original native session')
    await expect.poll(async () => (await workspace.snapshot()).threads.find(thread => thread.id === 'sotto-task')?.messages.some(message => message.text === 'Completed in the original native session')).toBe(true)
    expect(f.registry.byThread('sotto-task')).toEqual(binding)
    const traffic = await f.driver.requests()
    expect(traffic.filter(record => record.method === 'thread/start')).toHaveLength(1)
    expect(traffic.filter(record => record.method === 'turn/start')).toHaveLength(1)
    expect(traffic.filter(record => record.method === 'turn/interrupt')).toHaveLength(0)
  })

  it('preserves native prompt uncertainty and reconciles a late acknowledgement without replay', async () => {
    const { f, workspace } = await fixture(200)
    await f.driver.delayNextAck('turn/start')
    expect(await workspace.execute({ type: 'send', commandId: 'delayed-prompt', threadId: 'sotto-task', messageId: 'late-message', text: 'Synthetic uncertain prompt' })).toEqual({ accepted: false, uncertain: true })
    await workspace.setWorkspaceSettled('project', 'scope', true)
    await expect.poll(async () => (await workspace.snapshot()).threads.find(thread => thread.id === 'sotto-task')?.messages.some(message => message.id === 'late-message')).toBe(true)
    await workspace.setWorkspaceSettled('project', 'scope', false)
    const traffic = await f.driver.requests()
    expect(traffic.filter(record => record.method === 'thread/start')).toHaveLength(1)
    expect(traffic.filter(record => record.method === 'turn/start')).toHaveLength(1)
  })
})
