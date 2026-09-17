// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workspaceFixture } from '../../fixtures/workspaceFixture'
import { isThreadClosed, isWorkspaceThreadSettled } from '../../../src/shared/threadActivity'
import { agentCommandSchema, type AgentHostSnapshot } from '../../../src/shared/agents'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { ThreadWorktrees } from '../../../src/main/agents/threadWorktrees'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const f = await workspaceFixture()
  cleanup.push(async () => { await f.stop(); await f.remove() })
  return f
}
async function local(f: Awaited<ReturnType<typeof fixture>>, id = 'local') {
  const snapshot = await f.host.connect()
  const project = snapshot.projects.find(project => project.providerId === 'codex')!
  const model = snapshot.models.find(model => model.providerId === 'codex')!
  await f.host.execute({ type: 'create-thread', commandId: `create-${id}`, threadId: id, projectId: project.id, title: 'New task', modelId: model.id })
  return { project, model }
}
const send = (threadId = 'local') => ({ type: 'send' as const, commandId: `send-${threadId}`, threadId, messageId: `message-${threadId}`, text: 'Implement the task' })
function deferred() {
  let release!: () => void
  return { promise: new Promise<void>(resolve => { release = resolve }), release }
}

describe('durable project/thread organization', () => {
  it('keeps individual settlement across whole-project settlement, events, and restart without stopping work', async () => {
    const f = await fixture(); const { project } = await local(f)
    await local(f, 'other')
    await f.host.execute(send())
    await f.host.setWorkspaceSettled('thread', 'other', true)
    const calls = f.adapters.codex.commands.length
    let snapshot = await f.host.setWorkspaceSettled('project', project.id, true)
    const running = snapshot.threads.find(thread => thread.id === 'local')!
    expect(running.status).toBe('running')
    expect(running.workspaceSettledAt).toBeNull()
    expect(isWorkspaceThreadSettled(running, snapshot.projects.find(item => item.id === project.id))).toBe(true)
    expect(isThreadClosed(running)).toBe(false)
    expect(f.adapters.codex.commands).toHaveLength(calls)
    f.adapters.codex.emit()
    await f.stop()
    const reopened = await workspaceFixture(f.root); cleanup.push(reopened.stop)
    snapshot = reopened.host.workspaceSnapshot()
    expect(snapshot.connected).toBe(false)
    expect(snapshot.threads.find(thread => thread.id === 'local')).toMatchObject({ id: 'local', projectId: project.id, status: 'running', nativeSessionStarted: true, messages: [expect.objectContaining({ text: 'Implement the task' })] })
    snapshot = await reopened.host.setWorkspaceSettled('project', project.id, false)
    expect(isWorkspaceThreadSettled(snapshot.threads.find(thread => thread.id === 'local')!, snapshot.projects.find(item => item.id === project.id))).toBe(false)
    expect(isWorkspaceThreadSettled(snapshot.threads.find(thread => thread.id === 'other')!)).toBe(true)
    snapshot = await reopened.host.setWorkspaceSettled('thread', 'other', false)
    expect(snapshot.threads.find(thread => thread.id === 'other')?.workspaceSettledAt).toBeNull()
    expect(reopened.adapters.codex.commands).toHaveLength(0)
    expect(reopened.registry.byThread('local')).toBeUndefined() // provider registry has not even been opened
  })

  it('switches an empty local thread to a ready provider, retaining project scope and native ID on first send', async () => {
    const f = await fixture(); const { project } = await local(f)
    expect(f.registry.byThread('local')).toBeUndefined()
    expect(f.adapters.codex.commands).toHaveLength(0)
    const model = f.host.workspaceSnapshot().models.find(model => model.providerId === 'claude')!
    await f.host.execute({ type: 'configure-thread', commandId: 'switch', threadId: 'local', modelId: model.id, reasoningEffort: 'high' })
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')).toMatchObject({ nativeSessionStarted: false, providerId: 'claude', projectId: project.id, reasoningEffort: 'high' })
    await f.host.execute(send())
    const thread = (await f.host.snapshot()).threads.find(thread => thread.id === 'local')!
    expect(f.host.workspaceSnapshot().projects).toHaveLength(3)
    const binding = f.registry.byThread('local')!
    expect(binding.provider).toBe('claude')
    expect(binding.sessionId).not.toBe('local')
    expect(thread).toMatchObject({ nativeSessionStarted: true, projectId: project.id, status: 'running', providerId: 'claude' })
    expect(f.adapters.claude.commands.map(command => command.type)).toEqual(['create-project', 'create-thread', 'send'])
    expect(f.adapters.claude.commands.at(-1)).toMatchObject({ threadId: binding.sessionId })
    expect(f.adapters.codex.commands).toHaveLength(0)
    f.adapters.claude.state.threads.find(item => item.id === binding.sessionId)!.status = 'idle'; f.adapters.claude.emit()
    await expect(f.host.execute({ type: 'configure-thread', commandId: 'migrate', threadId: 'local', modelId: f.host.workspaceSnapshot().models.find(model => model.providerId === 'codex')!.id })).rejects.toThrow('cannot move')
    expect(f.registry.byThread('local')).toEqual(binding)
  })

  it('can start a retained local thread in a disconnected project using another ready provider after restart', async () => {
    const f = await fixture(); const { project } = await local(f)
    await f.stop()
    const reopened = await workspaceFixture(f.root); cleanup.push(reopened.stop)
    const snapshot = await reopened.host.connect('claude')
    expect(snapshot.projects.find(item => item.id === project.id)).toMatchObject({ title: project.title, path: project.path })
    const model = snapshot.models.find(model => model.providerId === 'claude')!
    await reopened.host.execute({ type: 'configure-thread', commandId: 'switch', threadId: 'local', modelId: model.id })
    await reopened.host.execute(send())
    expect((await reopened.host.snapshot()).threads.find(thread => thread.id === 'local')).toMatchObject({ projectId: project.id, providerId: 'claude', status: 'running' })
    expect(reopened.adapters.codex.connectCalls).toBe(0)
    expect(reopened.adapters.claude.commands[0]).toMatchObject({ type: 'create-project', path: project.path })
  })

  it('retains all disconnected provider histories and distinct project IDs across refresh and restart', async () => {
    const f = await fixture(); const snapshot = await f.host.connect()
    const ids = snapshot.projects.map(project => project.id)
    expect(new Set(ids).size).toBe(3)
    f.adapters.grok.state.threads[0]!.messages.push({ id: 'history', role: 'assistant', text: 'Searchable retained result', createdAt: new Date().toISOString() })
    f.adapters.grok.emit(); await f.stop()
    const reopened = await workspaceFixture(f.root); cleanup.push(reopened.stop)
    const retained = await reopened.host.snapshot()
    expect(retained.projects.map(project => project.id)).toEqual(ids)
    expect(retained.threads.map(thread => thread.id)).toEqual(snapshot.threads.map(thread => thread.id))
    expect(retained.threads.find(thread => thread.messages.some(message => message.id === 'history'))?.messages[0]?.text).toBe('Searchable retained result')
    expect(retained.models).toHaveLength(3)
    expect(retained.models.every(model => !model.ready)).toBe(true)
    expect(retained.threads.every(thread => thread.nativeSessionStarted)).toBe(true)
  })

  it('locks existing empty native threads and honors same-provider capabilities and model options', async () => {
    const f = await fixture(); const snapshot = await f.host.connect()
    const thread = snapshot.threads.find(thread => thread.providerId === 'codex')!
    expect(thread.messages).toEqual([])
    expect(thread.nativeSessionStarted).toBe(true)
    const configure = { type: 'configure-thread' as const, commandId: 'settings', threadId: thread.id, reasoningEffort: 'high' }
    await f.host.execute(configure)
    expect(f.adapters.codex.commands.at(-1)).toMatchObject({ reasoningEffort: 'high' })
    await expect(f.host.execute({ ...configure, reasoningEffort: 'unavailable' })).rejects.toThrow('not supported')
    f.adapters.codex.state.capabilities.configureThread = false; f.adapters.codex.emit()
    await expect(f.host.execute(configure)).rejects.toThrow('does not support')
    const count = f.adapters.codex.commands.length
    await local(f)
    await f.host.execute({ ...configure, threadId: 'local' })
    expect(f.adapters.codex.commands).toHaveLength(count)
  })

  it('never repeats uncertain native creation, including after restart, and does not send the prompt early', async () => {
    const f = await fixture(); await local(f)
    const execute = f.adapters.codex.execute.bind(f.adapters.codex)
    vi.spyOn(f.adapters.codex, 'execute').mockImplementation(async command => command.type === 'create-thread' ? { accepted: false, uncertain: true } : execute(command))
    await expect(f.host.execute(send())).rejects.toThrow('creation is not confirmed')
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.nativeSessionStarted).toBe(true)
    expect(f.adapters.codex.execute).toHaveBeenCalledTimes(1)
    await expect(f.host.execute(send())).rejects.toThrow('not create it twice')
    expect(f.adapters.codex.execute).toHaveBeenCalledTimes(1)
    const binding = f.registry.byThread('local')!
    await f.stop()
    const reopened = await workspaceFixture(f.root); cleanup.push(reopened.stop)
    await reopened.host.connect()
    await expect(reopened.host.execute(send())).rejects.toThrow('not create it twice')
    expect(reopened.adapters.codex.commands).toHaveLength(0)
    expect(reopened.registry.byThread('local')).toEqual(binding)
  })

  it('redacts stored transcripts and requests when local history is disabled, retaining identity and settlement', async () => {
    const f = await fixture(); await local(f); await f.host.execute(send())
    await f.host.setWorkspaceSettled('thread', 'local', true)
    const binding = f.registry.byThread('local')!
    f.adapters.codex.state.threads.find(thread => thread.id === binding.sessionId)!.requests.push({ id: 'sensitive', kind: 'question', text: 'Private request', options: [] })
    f.adapters.codex.emit(); f.setHistory(false); await f.host.privacyChanged()
    const contents = await readFile(join(f.root, 'workspace.json'), 'utf8')
    expect(contents).not.toContain('Implement the task')
    expect(contents).not.toContain('Private request')
    const saved = JSON.parse(contents).snapshot.threads.find((thread: { id: string }) => thread.id === 'local')
    expect(saved).toMatchObject({ id: 'local', messages: [], requests: [], nativeSessionStarted: true, workspaceSettledAt: expect.any(String) })
  })

  it('retries a definitively rejected creation with the same reserved native identity', async () => {
    const f = await fixture(); await local(f)
    const execute = f.adapters.codex.execute.bind(f.adapters.codex)
    const spy = vi.spyOn(f.adapters.codex, 'execute').mockImplementationOnce(async () => ({ accepted: false }))
    await expect(f.host.execute(send())).rejects.toThrow('rejected thread creation')
    const binding = f.registry.byThread('local')!
    spy.mockImplementation(execute)
    await f.host.execute(send())
    expect(f.registry.byThread('local')).toEqual(binding)
    expect(f.adapters.codex.commands.map(command => command.type)).toEqual(['create-thread', 'send'])
    expect((await f.host.snapshot()).threads.find(thread => thread.id === 'local')?.status).toBe('running')
  })

  it('unlocks a local thread when its project registration definitively fails before native binding', async () => {
    const f = await fixture(); await local(f)
    const model = f.host.workspaceSnapshot().models.find(model => model.providerId === 'claude')!
    await f.host.execute({ type: 'configure-thread', commandId: 'switch', threadId: 'local', modelId: model.id })
    vi.spyOn(f.adapters.claude, 'execute').mockRejectedValueOnce(new Error('Folder not available'))
    await expect(f.host.execute(send())).rejects.toThrow('Folder not available')
    expect(f.registry.byThread('local')).toBeUndefined()
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.nativeSessionStarted).toBe(false)
    await f.host.execute({ type: 'configure-thread', commandId: 'switch-back', threadId: 'local', modelId: f.host.workspaceSnapshot().models.find(model => model.providerId === 'codex')!.id })
    await f.host.execute(send())
    expect(f.registry.byThread('local')?.provider).toBe('codex')
  })

  it('does not dispatch native creation if saving its durable intent fails', async () => {
    const f = await fixture(); await local(f)
    const write = vi.spyOn(AtomicJsonStore.prototype, 'write').mockRejectedValue(new Error('Disk unavailable'))
    await expect(f.host.execute(send())).rejects.toThrow('Disk unavailable')
    expect(f.adapters.codex.commands).toHaveLength(0)
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.nativeSessionStarted).toBe(false)
    write.mockRestore()
    await f.host.execute(send())
    expect(f.adapters.codex.commands.filter(command => command.type === 'create-thread')).toHaveLength(1)
  })

  it('publishes the new thread before its working copy is prepared, and waits for that one preparation on send', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    const gate = deferred()
    const allocate = ThreadWorktrees.prototype.allocate
    const spy = vi.spyOn(ThreadWorktrees.prototype, 'allocate')
      .mockImplementation(async function (this: ThreadWorktrees, ...args: Parameters<typeof allocate>) { await gate.promise; return allocate.apply(this, args) })
    const published: AgentHostSnapshot[] = []
    f.host.subscribe(snapshot => published.push(snapshot))
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    // The thread is durable and published while its checkout is still being prepared.
    expect(published.at(-1)?.threads.find(thread => thread.id === 'local')).toMatchObject({ title: 'New task', worktree: { status: 'pending' } })
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree?.status).toBe('pending')
    const sent = f.host.execute(send())
    await Promise.resolve()
    expect(f.adapters.codex.commands).toEqual([])
    gate.release()
    await sent
    expect(spy).toHaveBeenCalledTimes(1) // the send joined the preparation instead of starting a second one
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree?.status).toBe('ready')
    expect(f.adapters.codex.commands.map(command => command.type)).toEqual(['create-thread', 'send'])
  })

  it('marks the working copy error when its preparation fails, without turning creation into a rejection', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockRejectedValue(new Error('Git is unavailable.'))
    expect(await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })).toEqual({ accepted: true })
    await expect(f.host.threadWorkingDirectory('local')).rejects.toThrow('Git is unavailable.')
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree).toMatchObject({ status: 'error', error: 'Git is unavailable.' })
    await expect(f.host.execute(send())).rejects.toThrow('Git is unavailable.')
    expect(f.adapters.codex.commands).toEqual([])
    expect(f.registry.byThread('local')).toBeUndefined()
  })

  it('strictly validates settlement commands and rejects missing entities', async () => {
    const f = await fixture()
    for (const type of ['settle-thread', 'restore-thread', 'settle-project', 'restore-project']) {
      const field = type.endsWith('project') ? 'projectId' : 'threadId'
      expect(agentCommandSchema.parse({ type, [field]: 'identity' })).toEqual({ type, [field]: 'identity' })
      expect(agentCommandSchema.safeParse({ type, [field]: 'identity', delete: true }).success).toBe(false)
    }
    await expect(f.host.setWorkspaceSettled('thread', 'missing', true)).rejects.toThrow('unavailable')
    await expect(f.host.setWorkspaceSettled('project', 'missing', true)).rejects.toThrow('unavailable')
  })
})
