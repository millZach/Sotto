// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { workspaceFixture } from '../../fixtures/workspaceFixture'

import { type AgentHostSnapshot } from '../../../src/shared/agents'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { ThreadWorktrees } from '../../../src/main/agents/threadWorktrees'

import { cleanup, fixture, local, send, deferred } from '../../fixtures/workspaceTestFixture'

describe("durable project/thread organization", () => {
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

})
