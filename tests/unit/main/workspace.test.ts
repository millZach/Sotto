// @vitest-environment node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workspaceFixture } from '../../fixtures/workspaceFixture'
import { isThreadClosed, isWorkspaceThreadSettled } from '../../../src/shared/threadActivity'
import { agentCommandSchema, type AgentHostSnapshot } from '../../../src/shared/agents'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { runWorktreeGit as git, ThreadWorktrees } from '../../../src/main/agents/threadWorktrees'
import type { GitStatus } from '../../../src/shared/gitStatus'

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
  it('opens a new thread in a settled project while its older threads stay settled across restart', async () => {
    const f = await fixture(); const { project } = await local(f)
    await local(f, 'already-settled')
    await f.host.setWorkspaceSettled('thread', 'already-settled', true)
    await f.host.setWorkspaceSettled('project', project.id, true)
    const oldIds = f.host.workspaceSnapshot().threads.filter(thread => thread.projectId === project.id).map(thread => thread.id)
    const before = f.host.workspaceSnapshot()
    await local(f, 'new-work')
    const check = (snapshot: AgentHostSnapshot) => {
      const folder = snapshot.projects.find(item => item.id === project.id)!
      expect(isWorkspaceThreadSettled(snapshot.threads.find(item => item.id === 'new-work')!, folder)).toBe(false)
      for (const id of oldIds) expect(isWorkspaceThreadSettled(snapshot.threads.find(item => item.id === id)!, folder)).toBe(true)
    }
    check(f.host.workspaceSnapshot())
    const after = f.host.workspaceSnapshot()
    expect(after.projects.filter(item => item.id !== project.id)).toEqual(before.projects.filter(item => item.id !== project.id))
    expect(after.threads.filter(item => item.projectId !== project.id)).toEqual(before.threads.filter(item => item.projectId !== project.id))
    expect(after.threads.find(item => item.id === 'already-settled')?.workspaceSettledAt)
      .toBe(before.threads.find(item => item.id === 'already-settled')?.workspaceSettledAt)
    await f.host.snapshot()
    check(f.host.workspaceSnapshot())
    await f.stop()
    const reopened = await workspaceFixture(f.root); cleanup.push(reopened.stop)
    check(reopened.host.workspaceSnapshot())
  })

  it('leaves a settled folder unchanged when saving its new thread fails', async () => {
    const f = await fixture(); const { project, model } = await local(f)
    await f.host.setWorkspaceSettled('project', project.id, true)
    const before = f.host.workspaceSnapshot()
    const write = vi.spyOn(AtomicJsonStore.prototype, 'write').mockRejectedValue(new Error('Disk unavailable'))
    await expect(f.host.execute({ type: 'create-thread', commandId: 'new-failed', threadId: 'failed', projectId: project.id, modelId: model.id, title: 'New work' })).rejects.toThrow('Disk unavailable')
    expect(f.host.workspaceSnapshot().projects).toEqual(before.projects)
    expect(f.host.workspaceSnapshot().threads).toEqual(before.threads)
    write.mockRestore()
  })

  it.each([false, true])('preserves individual settlement (%s) when restoration overlaps a failed creation', async individuallySettled => {
    const f = await fixture(); const { project, model } = await local(f)
    if (individuallySettled) await f.host.setWorkspaceSettled('thread', 'local', true)
    const original = f.host.workspaceSnapshot().threads.find(item => item.id === 'local')!.workspaceSettledAt
    await f.host.setWorkspaceSettled('project', project.id, true)
    const writing = deferred(); const rejectWrite = deferred()
    const write = vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async () => {
      writing.release(); await rejectWrite.promise; throw new Error('Disk unavailable')
    })
    const creation = f.host.execute({ type: 'create-thread', commandId: 'overlapping-create', threadId: 'new-work', projectId: project.id, modelId: model.id, title: 'New work' })
    await writing.promise
    const restoration = f.host.setWorkspaceSettled('thread', 'local', false)
    const results = Promise.allSettled([creation, restoration])
    // Let restoration reach the shared write or queue behind creation; no elapsed-time assertion.
    await new Promise<void>(resolve => setImmediate(resolve))
    rejectWrite.release()
    const outcomes = await results
    expect(f.host.workspaceSnapshot().threads.find(item => item.id === 'local')?.workspaceSettledAt).toBe(original)
    // Restoring an already-unsettled thread is a no-op after creation rolls back.
    expect(outcomes.map(result => result.status)).toEqual(['rejected', individuallySettled ? 'rejected' : 'fulfilled'])
    write.mockRestore()
    const snapshot = await f.host.setWorkspaceSettled('project', project.id, false)
    expect(isWorkspaceThreadSettled(snapshot.threads.find(item => item.id === 'local')!, snapshot.projects.find(item => item.id === project.id))).toBe(individuallySettled)
  })

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

  it("keeps a provider's own permission mode on a thread that has not sent, and creates the thread under it", async () => {
    const f = await fixture()
    f.adapters.codex.state.models[0]!.providerModes = [{ id: 'ask-first', name: 'Ask first' }, { id: 'bypass', name: 'Bypass Permissions' }]
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    await f.host.execute({ type: 'create-thread', commandId: 'create-own', threadId: 'own', projectId: project.id, title: 'Own modes', modelId: model.id, providerMode: 'bypass' })
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'own')).toMatchObject({ nativeSessionStarted: false, providerMode: 'bypass' })
    await f.host.execute({ type: 'configure-thread', commandId: 'mode-own', threadId: 'own', providerMode: 'ask-first' })
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'own')).toMatchObject({ providerMode: 'ask-first' })
    // The mode chosen before the first message is the one the provider creates the thread under.
    await f.host.execute(send('own'))
    expect(f.adapters.codex.commands.find(command => command.type === 'create-thread')).toMatchObject({ providerMode: 'ask-first' })
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

  it('allocates no checkout when an independent thread opens and prepares exactly once on send', async () => {
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
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id, workingCopy: 'independent' })
    // The thread is durable and published while its checkout is still being prepared.
    expect(published.at(-1)?.threads.find(thread => thread.id === 'local')).toMatchObject({ title: 'New task', worktree: { status: 'pending' } })
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree?.status).toBe('pending')
    expect(spy).not.toHaveBeenCalled()
    const sent = f.host.execute(send())
    await Promise.resolve()
    expect(f.adapters.codex.commands).toEqual([])
    gate.release()
    await sent
    expect(spy).toHaveBeenCalledTimes(1) // the send joined the preparation instead of starting a second one
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree?.status).toBe('ready')
    expect(f.adapters.codex.commands.map(command => command.type)).toEqual(['create-thread', 'send'])
  })

  it('drains a pending branch name without renaming Git after shutdown starts', async () => {
    const f = await workspaceFixture()
    cleanup.push(async () => { f.native.disconnect(); await f.registry.flush(); await f.remove() })
    const repository = f.adapters.codex.state.projects[0]!.path
    await git(repository, ['init'])
    await writeFile(join(repository, 'tracked.txt'), 'baseline')
    await git(repository, ['add', '.'])
    await git(repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Baseline'])
    let finish!: (name: string) => void
    const writer = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
    f.host.setWorkingCopyDefaults(() => 'independent')
    f.host.setBranchNameWriter(writer)
    await local(f)
    await f.host.execute(send())
    await vi.waitFor(() => expect(writer).toHaveBeenCalledOnce())
    const thread = f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!
    const rename = vi.spyOn(ThreadWorktrees.prototype, 'renameTemporaryBranch')
    f.host.disconnect()
    const settled = vi.fn()
    const closed = f.host.close().then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    finish('sotto/late-generated-name')
    await closed
    expect(rename).not.toHaveBeenCalled()
    expect((await git(thread.workingDirectory!, ['branch', '--show-current'])).trim()).toBe(thread.worktree!.branch)
  })

  it('leaves an agent branch alone when it changes while descriptive naming is pending', async () => {
    const f = await fixture()
    const repository = f.adapters.codex.state.projects[0]!.path
    await git(repository, ['init'])
    await writeFile(join(repository, 'tracked.txt'), 'baseline')
    await git(repository, ['add', '.'])
    await git(repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Baseline'])
    let finish!: (name: string | null) => void
    const writer = vi.fn(() => new Promise<string | null>(resolve => { finish = resolve }))
    f.host.setWorkingCopyDefaults(() => 'independent')
    f.host.setBranchNameWriter(writer)
    await local(f)
    await f.host.execute(send())
    await vi.waitFor(() => expect(writer).toHaveBeenCalledTimes(1))
    // The branch is named by the thread whose first prompt it is, so its own provider is the one asked.
    expect(writer).toHaveBeenCalledWith('local', send().text)
    const thread = f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!
    await git(thread.workingDirectory!, ['switch', '-c', 'feat/agent-choice'])
    await f.host.updateThreadWorktree('local', false)
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree).toMatchObject({ branch: 'feat/agent-choice', temporaryBranch: false })
    finish('sotto/generated-name')
    // The rename joins the thread lane, so this read waits for it rather than sleeping.
    await Promise.resolve(); await Promise.resolve()
    await f.host.updateThreadWorktree('local', false)
    expect((await git(thread.workingDirectory!, ['branch', '--show-current'])).trim()).toBe('feat/agent-choice')
    await f.host.execute({ ...send(), commandId: 'next', messageId: 'next' })
    expect(writer).toHaveBeenCalledTimes(1)
  })

  it.each(['legacy', 'shared-subdirectory'] as const)('never requests or applies branch naming when a %s thread uses the checkout', async kind => {
    const f = await fixture()
    const repository = f.adapters.codex.state.projects[0]!.path
    await git(repository, ['init'])
    await writeFile(join(repository, 'tracked.txt'), 'baseline')
    await git(repository, ['add', '.'])
    await git(repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Baseline'])
    const writer = vi.fn(async () => 'sotto/do-not-rename')
    f.host.setWorkingCopyDefaults(() => 'independent')
    f.host.setBranchNameWriter(writer)
    await local(f)
    const execute = f.adapters.codex.execute.bind(f.adapters.codex)
    vi.spyOn(f.adapters.codex, 'execute').mockImplementation(async command => {
      if (command.type === 'send') {
        const owner = f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!
        const directory = kind === 'legacy' ? owner.workingDirectory! : join(owner.workingDirectory!, 'packages')
        if (kind === 'shared-subdirectory') await mkdir(directory)
        const other = f.adapters.codex.state.threads[0]!
        other.workingDirectory = directory
        if (kind === 'shared-subdirectory') other.worktree = { mode: 'shared', status: 'ready', path: directory }
      }
      return execute(command)
    })
    await f.host.execute(send())
    const owner = f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!
    await f.host.renameTemporaryBranch('local', 'sotto/do-not-rename')
    expect((await git(owner.workingDirectory!, ['branch', '--show-current'])).trim()).toBe(owner.worktree!.branch)
    expect(writer).not.toHaveBeenCalled()
  })

  it.each(['shared', 'independent'] as const)('discovers a legacy %s checkout without moving its provider session or history', async mode => {
    const f = await fixture()
    const project = f.adapters.codex.state.projects[0]!
    await git(project.path, ['init'])
    await writeFile(join(project.path, 'tracked.txt'), 'baseline')
    await git(project.path, ['add', '.'])
    await git(project.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Baseline'])
    const directory = mode === 'shared' ? project.path : join(f.root, 'legacy-checkout')
    if (mode === 'independent') await git(project.path, ['worktree', 'add', '-b', 'legacy-task', directory])
    const native = f.adapters.codex.state.threads[0]!
    native.workingDirectory = directory
    native.messages = [{ id: 'old-message', role: 'assistant', text: 'Retained history', createdAt: '2026-09-01T00:00:00Z' }]
    const snapshot = await f.host.connect()
    const thread = snapshot.threads.find(item => item.providerId === 'codex' && item.title === native.title)!
    const binding = structuredClone(f.registry.byThread(thread.id))
    await writeFile(join(directory, 'tracked.txt'), 'unfinished user edits')
    const discovered = (await f.host.updateThreadWorktree(thread.id, false)).threads.find(item => item.id === thread.id)!
    expect(discovered).toMatchObject({ workingDirectory: directory, worktree: { mode, status: 'ready' } })
    expect(discovered.messages).toEqual(native.messages)
    expect(f.registry.byThread(thread.id)).toEqual(binding)
    const original = discovered.worktree!.branch
    await f.host.execute(send(thread.id))
    await git(directory, ['switch', '-c', `next-${mode}`])
    const changed = (await f.host.updateThreadWorktree(thread.id, false)).threads.find(item => item.id === thread.id)!
    expect(changed.worktree).toMatchObject({ mode, branch: `next-${mode}`, sentBranch: original })
    await f.host.execute({ ...send(thread.id), commandId: 'next-send', messageId: 'next-message' })
    expect(f.host.workspaceSnapshot().threads.find(item => item.id === thread.id)?.worktree?.sentBranch).toBe(`next-${mode}`)
    expect(f.registry.byThread(thread.id)).toEqual(binding)
    expect(f.adapters.codex.commands.filter(command => command.type === 'create-thread')).toHaveLength(0)
    expect(await readFile(join(directory, 'tracked.txt'), 'utf8')).toBe('unfinished user edits')
  })

  it('uses a configured default only for new threads and keeps existing working-copy selections', async () => {
    const f = await fixture(); await local(f)
    f.host.setWorkingCopyDefaults(() => 'independent')
    await local(f, 'configured')
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'configured')?.worktree).toMatchObject({ mode: 'independent', status: 'pending' })
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree).toMatchObject({ mode: 'shared', status: 'ready' })
    await f.stop()
    const reopened = await workspaceFixture(f.root); cleanup.push(reopened.stop)
    expect(reopened.host.workspaceSnapshot().threads.find(thread => thread.id === 'configured')?.worktree).toMatchObject({ mode: 'independent', status: 'pending' })
    expect(reopened.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree).toMatchObject({ mode: 'shared', status: 'ready' })
  })

  it('changes an unsent working-copy choice without allocating or touching native identity', async () => {
    const f = await fixture(); const { project } = await local(f)
    const allocation = vi.spyOn(ThreadWorktrees.prototype, 'allocate')
    await f.host.configureThreadWorkingCopy('local', { workingCopy: 'independent', baseBranch: 'main' })
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree).toEqual(expect.objectContaining({ mode: 'independent', status: 'pending', baseBranch: 'main' }))
    expect(allocation).not.toHaveBeenCalled()
    await f.host.updateThreadWorktree('local', false)
    await f.host.updateThreadWorktree('local', true)
    expect(allocation).not.toHaveBeenCalled()
    await f.host.configureThreadWorkingCopy('local', { workingCopy: 'shared' })
    expect(await f.host.threadWorkingDirectory('local')).toBe(project.path)
    expect(f.registry.byThread('local')).toBeUndefined()
    await f.host.execute(send())
    await expect(f.host.configureThreadWorkingCopy('local', { workingCopy: 'independent' })).rejects.toThrow('already has a working folder')
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

  it('carries the Git status of the folder on the worktree record: the remote on a refresh, the timer while a window looks, and again after an action', async () => {
    const f = await fixture({ worktreeRefreshDelayMs: 5 })
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    const base: GitStatus = { isRepository: true, branch: 'main', upstream: 'origin/main', hasRemote: true, defaultBranch: 'main', isDefaultBranch: true, dirty: false, changedFiles: 0, insertions: 0, deletions: 0, ahead: 0, behind: 0, aheadOfDefault: null, pullRequest: null, fetchedAt: null, readAt: '2026-09-23T00:00:00.000Z' }
    let current = base, inFront = true
    const reads: Array<{ cwd: string; remote: boolean }> = []
    const source = { read: vi.fn(async (cwd: string, options: { remote: boolean }) => { reads.push({ cwd, remote: options.remote }); return current }), invalidate: vi.fn() }
    f.host.setGitStatus(source, { pollIntervalMs: () => 10, tickMs: 5, foreground: () => inFront })
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.execute(send())
    const record = () => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree
    // A refresh is an ask, so it reads the remote half too.
    await f.host.updateThreadWorktree('local', false)
    expect(record()?.git).toMatchObject({ branch: 'main', ahead: 0 })
    expect(reads.at(-1)).toEqual({ cwd: project.path, remote: true })
    // The timer reads only the threads a window is looking at.
    current = { ...base, ahead: 2 }
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(record()?.git?.ahead).toBe(0)
    f.host.observeThreads(['local'])
    await vi.waitFor(() => expect(record()?.git?.ahead).toBe(2))
    // Nothing is read while the window is not in front.
    inFront = false
    const before = reads.length
    current = { ...base, ahead: 3 }
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(reads.length).toBe(before)
    expect(record()?.git?.ahead).toBe(2)
    // A Git action drops the caches and reads at once.
    await f.host.gitActionFinished('local')
    expect(source.invalidate).toHaveBeenCalled()
    expect(record()?.git?.ahead).toBe(3)
    // An unchanged status publishes nothing.
    const published: AgentHostSnapshot[] = []
    f.host.subscribe(snapshot => published.push(snapshot))
    await f.host.gitActionFinished('local')
    expect(published).toHaveLength(0)
  })

  it('lists the branches of the folder a thread works in, a draft reading its project folder', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    const page = { refs: [{ name: 'main', current: true, isDefault: true, worktreePath: null }], isRepository: true, hasRemote: false, nextCursor: null, total: 1 }
    const listRefs = vi.fn(async () => page)
    f.host.setGitStatus({ read: vi.fn(async () => { throw new Error('not read here') }), invalidate: vi.fn(), listRefs }, { pollIntervalMs: () => 0 })
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await expect(f.host.listThreadRefs({ threadId: 'local', query: 'ma', limit: 10 })).resolves.toEqual(page)
    expect(listRefs).toHaveBeenCalledWith(project.path, { query: 'ma', limit: 10 })
    await expect(f.host.listThreadRefs({ threadId: 'missing' })).rejects.toThrow()
    // A status source with no listing, or none at all, refuses in plain words rather than guessing.
    f.host.setGitStatus({ read: vi.fn(async () => { throw new Error('not read here') }), invalidate: vi.fn() }, { pollIntervalMs: () => 0 })
    await expect(f.host.listThreadRefs({ threadId: 'local' })).rejects.toThrow('Branches are unavailable on this host.')
  })

  it('runs a Git action on the thread lane, reports it on the record as it goes, and refuses one while the thread works', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    const record = { mode: 'shared' as const, status: 'ready' as const, path: project.path, repositoryRoot: project.path, branch: 'main', baseCommit: 'fixture' }
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...record, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockResolvedValue(record)
    vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => ({ ...metadata, status: 'ready', branch: 'main' }))
    const base = { isRepository: true, branch: 'main', upstream: 'origin/main', hasRemote: true, defaultBranch: 'main', isDefaultBranch: true, dirty: true, changedFiles: 1, insertions: 1, deletions: 0, ahead: 0, behind: 0, aheadOfDefault: null, pullRequest: null, fetchedAt: null, readAt: '2026-09-23T00:00:00.000Z' }
    const source = { read: vi.fn(async () => base), invalidate: vi.fn() }
    f.host.setGitStatus(source, { pollIntervalMs: () => 0 })
    const seen: string[] = []
    const actions = {
      runStackedAction: vi.fn(async (input: { cwd: string; onProgress?: (event: unknown) => void }) => {
        seen.push(input.cwd)
        input.onProgress?.({ kind: 'action_started', phases: ['commit'], stages: ['Committing...'] })
        input.onProgress?.({ kind: 'phase_started', phase: 'commit', stage: 'Committing...' })
        input.onProgress?.({ kind: 'hook_started', hookName: 'pre-commit' })
        input.onProgress?.({ kind: 'hook_output', hookName: 'pre-commit', text: 'checking' })
        await new Promise(resolve => setTimeout(resolve, 30))
        return { action: 'commit', branch: { status: 'skipped_not_requested' }, commit: { status: 'created', sha: 'abc1234def', subject: 'Second' }, push: { status: 'skipped_not_requested' }, pr: { status: 'skipped_not_requested' }, toast: { title: 'Committed abc1234', description: 'Second', cta: { kind: 'run_action', label: 'Push', action: 'push' } } }
      }),
      pull: vi.fn(async () => ({ status: 'pulled' as const, branch: 'main', upstream: 'origin/main' })),
    }
    f.host.setGitActions(actions as never)
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.execute(send())
    const record_ = () => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')
    const session = f.adapters.codex.state.threads.at(-1)!
    session.status = 'idle'; f.adapters.codex.emit()
    await vi.waitFor(() => expect(record_()?.status).toBe('idle'))
    const published: string[] = []
    f.host.subscribe(snapshot => { const action = snapshot.threads.find(thread => thread.id === 'local')?.gitAction; if (action) published.push(`${action.status}:${action.stage ?? ''}:${action.hook?.output ?? ''}`) })
    const done = await f.host.runGitAction({ threadId: 'local', actionId: 'action-1', action: 'commit', commitMessage: 'Second' })
    expect(done.threads.find(thread => thread.id === 'local')?.gitAction).toMatchObject({ actionId: 'action-1', status: 'done', result: { commit: { sha: 'abc1234def' }, toast: { title: 'Committed abc1234' } }, error: null })
    expect(seen).toEqual([project.path])
    expect(published.some(entry => entry.startsWith('running:Committing...'))).toBe(true)
    expect(published.some(entry => entry === 'running:Committing...:checking')).toBe(true)
    expect(source.invalidate).toHaveBeenCalled()
    expect(source.read).toHaveBeenCalledWith(project.path, { remote: true })
    // A refusal from the service becomes the record's error, not a thrown exception.
    actions.runStackedAction.mockRejectedValueOnce(new Error('Commit local changes before creating a PR.'))
    await f.host.runGitAction({ threadId: 'local', actionId: 'action-2', action: 'create_pr' })
    expect(record_()?.gitAction).toMatchObject({ actionId: 'action-2', status: 'failed', error: 'Commit local changes before creating a PR.' })
    // A thread mid-turn keeps its folder to itself.
    session.status = 'running'; f.adapters.codex.emit()
    await vi.waitFor(() => expect(record_()?.status).toBe('running'))
    await expect(f.host.runGitAction({ threadId: 'local', actionId: 'action-3', action: 'commit' })).rejects.toThrow('Wait for the thread to finish its turn before changing Git.')
    session.status = 'idle'; f.adapters.codex.emit()
    await vi.waitFor(() => expect(record_()?.status).toBe('idle'))
    expect((await f.host.pullThreadBranch('local')).result).toEqual({ status: 'pulled', branch: 'main', upstream: 'origin/main' })
  })

  it('restores the branch of the last send by hand, and leaves uncommitted work alone until it is confirmed', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    const record = { mode: 'shared' as const, status: 'ready' as const, path: project.path, repositoryRoot: project.path, branch: 'sotto/thread-fixture', baseCommit: 'fixture' }
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

  it('reclaims a thread’s own worktree on request, keeps the record, and lets only a send put the folder back', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    // Its own folder, so no other thread of the project shares it.
    const checkout = join(project.path, 'own-worktree'); await mkdir(checkout)
    const record = { mode: 'independent' as const, status: 'ready' as const, path: checkout, repositoryRoot: project.path, branch: 'sotto/thread-fixture', baseCommit: 'fixture' }
    let present = true
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...record, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockResolvedValue(record)
    vi.spyOn(ThreadWorktrees.prototype, 'checkoutIdentity').mockImplementation(async path => path.toLowerCase())
    const restore = vi.spyOn(ThreadWorktrees.prototype, 'restore').mockImplementation(async metadata => { present = true; return { ...metadata, status: 'ready', error: undefined, reclaimedAt: undefined } })
    vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => {
      if (!present) throw new Error('The working folder is no longer this thread’s Git worktree. Restore its checkout before continuing.')
      return { ...metadata, status: 'ready', branch: 'sotto/thread-fixture', dirty: false, reclaimedAt: undefined }
    })
    const reclaim = vi.spyOn(ThreadWorktrees.prototype, 'reclaim').mockImplementation(async (metadata, options) => {
      if (options?.automatic) throw new Error('This folder holds ignored files besides installed dependencies, so a rule leaves it alone.')
      present = false; return { ...metadata, status: 'ready', dirty: undefined, reclaimedAt: '2026-09-22T00:00:00.000Z' }
    })
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.execute(send())
    const worktree = () => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree
    // A running thread keeps its folder; so does one something else still works in.
    await expect(f.host.reclaimThreadWorktree('local')).rejects.toThrow('still working')
    f.adapters.codex.state.threads.at(-1)!.status = 'idle'; f.adapters.codex.emit()
    await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.status).toBe('idle'))
    f.host.setWorktreeInUse(() => true)
    await expect(f.host.reclaimThreadWorktree('local')).rejects.toThrow('terminal is open')
    f.host.setWorktreeInUse(() => false)
    // A rule's refusal is the folder's own, and the record is untouched by it.
    await expect(f.host.reclaimThreadWorktree('local', { automatic: true })).rejects.toThrow('rule leaves it alone')
    expect(worktree()?.reclaimedAt).toBeUndefined()
    const published: AgentHostSnapshot[] = []
    f.host.subscribe(snapshot => published.push(snapshot))
    await f.host.reclaimThreadWorktree('local')
    expect(reclaim).toHaveBeenLastCalledWith(expect.objectContaining({ path: checkout }), {})
    expect(worktree()).toMatchObject({ status: 'ready', branch: 'sotto/thread-fixture', reclaimedAt: '2026-09-22T00:00:00.000Z' })
    expect(published.at(-1)?.threads.find(thread => thread.id === 'local')?.worktree?.reclaimedAt).toBe('2026-09-22T00:00:00.000Z')
    // Asking twice changes nothing; a refresh reads but does not put the folder back.
    await f.host.reclaimThreadWorktree('local')
    expect(reclaim).toHaveBeenCalledTimes(2)
    restore.mockClear()
    await f.host.updateThreadWorktree('local', false)
    expect(restore).not.toHaveBeenCalled()
    expect(worktree()).toMatchObject({ status: 'ready', reclaimedAt: '2026-09-22T00:00:00.000Z' })
    // The next send puts it back on its branch and the record says so.
    await expect(f.host.threadWorkingDirectory('local')).resolves.toBe(checkout)
    expect(restore).toHaveBeenCalled()
    expect(worktree()).toMatchObject({ status: 'ready', branch: 'sotto/thread-fixture', reclaimedAt: undefined })
    await expect(f.host.reclaimThreadWorktree('other')).rejects.toThrow('not known to Sotto')
  })

  it('marks the working copy error when its preparation fails, without turning creation into a rejection', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockRejectedValue(new Error('Git is unavailable.'))
    expect(await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id, workingCopy: 'independent' })).toEqual({ accepted: true })
    await expect(f.host.execute(send())).rejects.toThrow('Git is unavailable.')
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
