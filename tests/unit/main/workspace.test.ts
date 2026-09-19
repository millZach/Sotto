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
async function fixture(options?: { worktreeRefreshDelayMs?: number }) {
  const f = await workspaceFixture(undefined, options)
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
    // Messages live in the thread store now; the restored snapshot carries the summary, and the window
    // arrives when a pane says it is looking at the thread.
    expect(snapshot.threads.find(thread => thread.id === 'local')).toMatchObject({ id: 'local', projectId: project.id, status: 'running', nativeSessionStarted: true, messages: [],
      summary: expect.objectContaining({ messageCount: 1, lastUser: expect.objectContaining({ text: 'Implement the task' }) }) })
    reopened.host.observeThreads(['local'])
    expect(reopened.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.messages).toEqual([expect.objectContaining({ text: 'Implement the task' })])
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
    const carrying = retained.threads.find(thread => thread.summary?.lastAssistant?.id === 'history')!
    expect(carrying.summary?.lastAssistant?.text).toBe('Searchable retained result')
    reopened.host.observeThreads([carrying.id])
    expect(reopened.host.workspaceSnapshot().threads.find(thread => thread.id === carrying.id)?.messages.map(message => message.text)).toContain('Searchable retained result')
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

  it('adopts the branch the worktree has checked out on send and publishes it', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    // The fixture project is a plain folder, so stand in for Git: an independent checkout whose branch moves under Sotto.
    const record = { mode: 'independent' as const, status: 'ready' as const, path: project.path, repositoryRoot: project.path, branch: 'sotto/thread-fixture', baseCommit: 'fixture' }
    let checkedOut = 'sotto/thread-fixture'
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...record, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockResolvedValue(record)
    vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => ({ ...metadata, status: 'ready', branch: checkedOut }))
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.threadWorkingDirectory('local')
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree).toMatchObject({ status: 'ready', branch: 'sotto/thread-fixture' })
    checkedOut = 'feat/user-chosen'
    const published: AgentHostSnapshot[] = []
    f.host.subscribe(snapshot => published.push(snapshot))
    await f.host.threadWorkingDirectory('local')
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree).toMatchObject({ status: 'ready', branch: 'feat/user-chosen' })
    expect(published.at(-1)?.threads.find(thread => thread.id === 'local')?.worktree?.branch).toBe('feat/user-chosen')
  })

  it('re-reads the worktree after finished work moved HEAD, and remembers the branch each send went to', async () => {
    const f = await fixture({ worktreeRefreshDelayMs: 5 })
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    const record = { mode: 'independent' as const, status: 'ready' as const, path: project.path, repositoryRoot: project.path, branch: 'sotto/thread-fixture', baseCommit: 'fixture' }
    let checkedOut = 'sotto/thread-fixture'
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...record, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockResolvedValue(record)
    const inspect = vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => ({ ...metadata, status: 'ready', branch: checkedOut }))
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.execute(send())
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree)
      .toMatchObject({ branch: 'sotto/thread-fixture', sentBranch: 'sotto/thread-fixture' })
    // The agent switched branches inside the folder mid-turn: no send, only a finished command.
    checkedOut = 'feat/agent-chose'
    const reads = inspect.mock.calls.length
    const session = f.adapters.codex.state.threads.at(-1)!
    session.activities = [{ id: 'command-1', turnId: 'turn-1', sequence: 0, kind: 'command', status: 'completed', title: 'Ran a command' }]
    f.adapters.codex.emit()
    session.activities = [...session.activities, { id: 'command-2', turnId: 'turn-1', sequence: 1, kind: 'file-change', status: 'completed', title: 'Edited files' }]
    f.adapters.codex.emit()
    await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree?.branch).toBe('feat/agent-chose'))
    expect(inspect.mock.calls.length - reads).toBe(1) // one re-read for the burst, not one per record
    // The branch of the last send is what the pane compares against, so it stays where it was.
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree?.sentBranch).toBe('sotto/thread-fixture')
  })

  it('restores the branch of the last send by hand, and leaves uncommitted work alone until it is confirmed', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    const record = { mode: 'independent' as const, status: 'ready' as const, path: project.path, repositoryRoot: project.path, branch: 'sotto/thread-fixture', baseCommit: 'fixture' }
    let checkedOut = 'sotto/thread-fixture'
    let dirty = true
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...record, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockResolvedValue(record)
    vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => ({ ...metadata, status: 'ready', branch: checkedOut, dirty }))
    const switched = vi.spyOn(ThreadWorktrees.prototype, 'switchBranch').mockImplementation(async (metadata, branch) => { checkedOut = branch; return { ...metadata, status: 'ready', branch, dirty } })
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.execute(send())
    checkedOut = 'feat/agent-chose'
    await expect(f.host.restoreThreadBranch('local', false)).rejects.toThrow('uncommitted changes')
    expect(switched).not.toHaveBeenCalled()
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree).toMatchObject({ branch: 'feat/agent-chose', sentBranch: 'sotto/thread-fixture' })
    const restored = await f.host.restoreThreadBranch('local', true)
    expect(switched).toHaveBeenCalledWith(expect.objectContaining({ branch: 'feat/agent-chose' }), 'sotto/thread-fixture')
    expect(restored.threads.find(thread => thread.id === 'local')?.worktree).toMatchObject({ branch: 'sotto/thread-fixture', sentBranch: 'sotto/thread-fixture' })
    // A clean folder needs no confirmation.
    dirty = false; checkedOut = 'feat/agent-chose'
    expect((await f.host.restoreThreadBranch('local', false)).threads.find(thread => thread.id === 'local')?.worktree?.branch).toBe('sotto/thread-fixture')
    await expect(f.host.restoreThreadBranch('other', false)).rejects.toThrow('not known to Sotto')
  })

  it('puts a deleted folder back before a refresh reads it, and a send repairs a record an earlier read marked as an error', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    const record = { mode: 'independent' as const, status: 'ready' as const, path: project.path, repositoryRoot: project.path, branch: 'sotto/thread-fixture', baseCommit: 'fixture' }
    let missing = false
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...record, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockResolvedValue(record)
    const restore = vi.spyOn(ThreadWorktrees.prototype, 'restore').mockImplementation(async metadata => { missing = false; return { ...metadata, status: 'ready', error: undefined } })
    const inspect = vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => {
      if (missing) throw new Error('The working folder is no longer this thread’s Git worktree. Restore its checkout before continuing.')
      return { ...metadata, status: 'ready', branch: 'sotto/thread-fixture', dirty: false }
    })
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.execute(send())
    const worktree = () => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree
    // Typing in the pane asks for one refresh; with the folder gone it is put back rather than marked as an error.
    missing = true; restore.mockClear(); inspect.mockClear()
    await f.host.updateThreadWorktree('local', false)
    expect(restore.mock.invocationCallOrder[0]).toBeLessThan(inspect.mock.invocationCallOrder[0]!)
    expect(worktree()).toMatchObject({ status: 'ready', branch: 'sotto/thread-fixture' })
    // A record an earlier read left as an error is given the same chance on the next send.
    restore.mockImplementationOnce(async metadata => metadata)
    missing = true
    await f.host.updateThreadWorktree('local', false)
    expect(worktree()?.status).toBe('error')
    await expect(f.host.threadWorkingDirectory('local')).resolves.toBe(project.path)
    expect(worktree()).toMatchObject({ status: 'ready', error: undefined })
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
