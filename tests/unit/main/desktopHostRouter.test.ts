// @vitest-environment node
import { serialize } from 'node:v8'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { DesktopHostRouter, hostAbsolutePath, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import type { FileListRequest, FileRequest } from '../../../src/shared/files'
import { EMPTY_SUBAGENT_SUMMARY } from '../../../src/shared/subagents'
import { hostVersionMismatch, type HostOperation } from '../../../src/shared/hostProtocol'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import type { RequestAnswerRecovery } from '../../../src/main/agents/hostService'
import { requestQuestionsDigest } from '../../../src/main/agents/requestDrafts'
import { desktopWindowClient } from '../../../src/main/agents/hostService'
import { HostConnectionError, SocketHostService } from '../../../src/main/agents/socketHostService'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { agentStateSchema, MAX_DELIVERED_DRAFTS, hostForThread, capabilitiesForThread, noProviderRefusal, type AgentCommand, type AgentState } from '../../../src/shared/agents'
import { deferred } from '../../fixtures/deferred'

const LOCAL = '11111111-1111-4111-8111-111111111111'
const REMOTE = '22222222-2222-4222-8222-222222222222'
function fixture(hostId: string, kind: 'local' | 'remote') {
  const state = emptyDesktopState(hostId)
  state.host.connected = true; state.connection = 'connected'
  state.host.projects = [{ id: 'project', title: 'Project', path: '/repo' }]
  state.host.threads = [{ id: 'thread', projectId: 'project', title: 'Task', modelId: '', status: 'idle', messages: [], requests: [] }]
  const command = vi.fn(async (_input: AgentCommand) => { void _input; return state })
  const detail = vi.fn(async (threadId: string) => ({ threadId, revision: 1, messages: [] }))
  const observe = vi.fn(async (_ids: string[]) => { void _ids })
  const connection: DesktopHostConnection = { hostId, name: kind === 'local' ? 'This computer' : 'Forge', kind,
    service: { shell: () => state, subscribe: () => () => undefined, command }, detail, observe, preview: () => null }
  return { state, command, detail, observe, connection }
}
function unsupportedComposer() {
  const router = new DesktopHostRouter(emptyDesktopState), remote = fixture(REMOTE, 'remote')
  remote.state.activeThreadId = 'thread'; remote.state.draftThreadId = 'thread'
  remote.state.draft = 'Previously saved text'; remote.state.composing = true
  const onPushError = vi.fn()
  const socket = () => {
    const service = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', catchUpEvents: false, onPushError })
    const call = vi.fn(async (operation: HostOperation) => operation.op === 'detail' ? null : remote.state)
    Object.assign(service, { cached: remote.state, features: [], call })
    return { service, call, connection: { ...remote.connection, service } }
  }
  const first = socket()
  router.add(first.connection); router.select(REMOTE)
  const notifications: { error: string | null; title: string; draft: string }[] = []
  router.subscribe(state => notifications.push({ error: state.error, title: state.host.threads[0]?.title ?? '', draft: state.draft }))
  const save = (text: string) => router.command({ type: 'compose', threadId: hostEntityKey(REMOTE, 'thread'), text }, desktopWindowClient())
  return { router, remote, ...first, notifications, save, socket, onPushError }
}

describe('desktop host routing', () => {
  it('qualifies and bounds exact retirement and delivery proof across two full host ledgers', () => {
    const router = new DesktopHostRouter(emptyDesktopState), local = fixture(LOCAL, 'local'), remote = fixture(REMOTE, 'remote')
    for (const f of [local, remote]) {
      f.state.obsoleteDrafts = Array.from({ length: MAX_DELIVERED_DRAFTS }, () => ({ threadId: 'thread', draftId: randomUUID() }))
      f.state.deliveredDrafts = Array.from({ length: MAX_DELIVERED_DRAFTS }, () => ({ threadId: 'thread', draftId: randomUUID() }))
      router.add(f.connection)
    }
    try {
      const result = agentStateSchema.parse(router.shell())
      expect(result.obsoleteDrafts).toHaveLength(MAX_DELIVERED_DRAFTS)
      expect(result.deliveredDrafts).toHaveLength(MAX_DELIVERED_DRAFTS)
      expect(result.obsoleteDrafts?.every(item => item.threadId === hostEntityKey(REMOTE, 'thread'))).toBe(true)
      expect(result.deliveredDrafts?.every(item => item.threadId === hostEntityKey(REMOTE, 'thread'))).toBe(true)
    } finally { router.dispose() }
  })
  it.each(['send', 'compose'] as const)('returns fixed update guidance for targeted %s to an older host without sending or losing its draft', async type => {
    const router = new DesktopHostRouter(emptyDesktopState), remote = fixture(REMOTE, 'remote')
    remote.state.activeThreadId = 'thread'
    remote.state.draft = 'The retained prompt'
    remote.state.draftThreadId = 'thread'
    remote.state.composing = true
    const service = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', catchUpEvents: false })
    const call = vi.fn()
    Object.assign(service, { cached: remote.state, features: ['answer-check'], call })
    router.add({ ...remote.connection, service })
    router.select(REMOTE)
    const draft = { threadId: hostEntityKey(REMOTE, 'thread'), text: 'The retained prompt', attachments: [] }
    const result = await router.command(type === 'send' ? { type, draft } : { type, ...draft }, desktopWindowClient())
    expect(result.error).toBe(type === 'send' ? 'Update the host before sending this draft. Your draft is kept on this computer.'
      : 'This host cannot save this draft yet. Your draft is kept on this computer and has not been saved on the host. Update the host.')
    expect(result.draft).toBe('The retained prompt')
    expect(result.draftThreadId).toBe(hostEntityKey(REMOTE, 'thread'))
    expect(result.composing).toBe(true)
    expect(call).not.toHaveBeenCalled()
    expect(service.state()).toMatchObject(remote.state)
    expect((service as unknown as { cached: unknown }).cached).toEqual(remote.state)
    expect(router.shell().error).toBe(result.error)
    router.dispose()
  })

  it('notifies unsupported autosave once while every edit remains refused and unsaved', async () => {
    const f = unsupportedComposer()
    try {
      for (const text of ['New edit', 'New edit two', 'New edit three']) {
        const result = await f.save(text)
        expect(result.error).toBe('This host cannot save this draft yet. Your draft is kept on this computer and has not been saved on the host. Update the host.')
      }
      expect(f.notifications).toHaveLength(4)
      expect(f.notifications.map(item => item.draft)).toEqual(['New edit', 'New edit', 'New edit two', 'New edit three'])
      expect(f.notifications.slice(1).every(item => item.error === f.router.shell().error)).toBe(true)
      expect(f.call).not.toHaveBeenCalled(); expect(f.onPushError).not.toHaveBeenCalled()
      expect(f.service.state().draft).toBe('New edit three')
      expect((f.service as unknown as { cached: { draft: string } }).cached.draft).toBe('Previously saved text')
    } finally { f.router.dispose() }
  })

  it.each(['error', 'selection', 'shell', 'reconnect'] as const)('does not suppress a refused autosave notice after an intervening %s while its reply is held', async intervening => {
    const f = unsupportedComposer()

    const { promise: gate, resolve: release } = deferred<void>(), { promise: entered, resolve: started } = deferred<void>()
    const actual = f.service.command.bind(f.service)
    let running: Promise<ReturnType<typeof f.router.shell>> | undefined
    try {
      const first = await f.save('First unsaved edit')
      const held = vi.spyOn(f.service, 'command').mockImplementationOnce(async (command, client, id) => {
        const result = await actual(command, client, id)
        started(); await gate
        return result
      })
      running = f.save('A newer unsaved edit')
      await entered
      if (intervening === 'error') {
        f.call.mockResolvedValueOnce({ ...f.remote.state, error: 'Another action failed.' })
        await f.router.command({ type: 'configure', patch: { reasoningEffort: 'high' } }, desktopWindowClient())
        expect(f.notifications.some(item => item.error === 'Another action failed.')).toBe(true)
      } else if (intervening === 'selection') {
        await f.router.command({ type: 'select-thread', threadId: hostEntityKey(REMOTE, 'thread') }, desktopWindowClient())
      } else if (intervening === 'shell') {
        const state = structuredClone(f.remote.state)
        state.host.threads[0]!.title = 'Changed while the save reply was held'
        const receiver = f.service as unknown as { receive(text: string): void }
        receiver.receive(JSON.stringify({ v: 1, event: 'shell', state }))
        expect(f.notifications.at(-1)!.title).toBe('Changed while the save reply was held')
      } else {
        f.router.replace(f.socket().connection)
      }
      const before = f.notifications.length
      release()
      expect((await running).error).toBe(first.error)
      expect(f.notifications).toHaveLength(before + (intervening === 'shell' ? 0 : 1))
      expect(f.notifications.at(-1)!.error).toBe(first.error)
      if (intervening === 'shell') expect(f.notifications.at(-1)!.title).toBe('Changed while the save reply was held')
      held.mockRestore()
      if (intervening === 'reconnect') {
        const reconnected = f.notifications.length
        expect((await f.save('Edit on the reconnected host')).error).toBe(first.error)
        expect(f.notifications).toHaveLength(reconnected + 2)
        expect(f.notifications.at(-1)!.draft).toBe('Edit on the reconnected host')
      }
      expect(f.call.mock.calls.every(([operation]) => operation.op !== 'command' || operation.command.type !== 'compose')).toBe(true)
      expect(f.onPushError).not.toHaveBeenCalled()
    } finally { release(); await running; f.router.dispose() }
  })

  it.each(['disconnected', 'unavailable', 'version_mismatch'] as const)('keeps %s failures on the uncertain command path', async code => {
    const router = new DesktopHostRouter(emptyDesktopState), remote = fixture(REMOTE, 'remote')
    router.add(remote.connection)
    const error = new HostConnectionError('The host did not confirm the command.', code)
    remote.command.mockRejectedValueOnce(error)
    await expect(router.command({ type: 'configure-thread', threadId: hostEntityKey(REMOTE, 'thread'), runtimeMode: 'full-access' }, desktopWindowClient())).rejects.toBe(error)
    expect(router.shell().error).toBeNull()
    router.dispose()
  })

  it('takes an early start to the thread’s own host and says nothing when that host refuses it or is away (#769)', async () => {
    const router = new DesktopHostRouter(emptyDesktopState), local = fixture(LOCAL, 'local'), remote = fixture(REMOTE, 'remote')
    router.add(local.connection); router.add(remote.connection)
    const publish = vi.fn(); router.subscribe(publish); publish.mockClear()
    await router.command({ type: 'start-thread-session', threadId: hostEntityKey(REMOTE, 'thread') }, desktopWindowClient())
    expect(remote.command).toHaveBeenCalledWith({ type: 'start-thread-session', threadId: 'thread' }, expect.anything())
    expect(local.command).not.toHaveBeenCalled()
    // An older host cannot read a command it does not know, which this client names as version skew; a host may also
    // refuse it, or drop and not answer. None of it is the user's to hear about.
    for (const error of [new HostConnectionError('This host runs another version of Sotto.', 'version_mismatch'), new HostConnectionError('This host refused the command.', 'forbidden')]) {
      remote.command.mockRejectedValueOnce(error)
      const refused = await router.command({ type: 'start-thread-session', threadId: hostEntityKey(REMOTE, 'thread') }, desktopWindowClient())
      expect(refused.error).toBeNull()
    }
    remote.command.mockRejectedValueOnce(new HostConnectionError('The host did not confirm the command.', 'disconnected'))
    await expect(router.command({ type: 'start-thread-session', threadId: hostEntityKey(REMOTE, 'thread') }, desktopWindowClient())).resolves.toMatchObject({ error: null })
    expect(router.shell().error).toBeNull()
    expect(publish).not.toHaveBeenCalled()
    router.dispose()
  })

  it('names the host in its no-provider refusal by the name this computer saved it under (#459)', async () => {
    const router = new DesktopHostRouter(emptyDesktopState), local = fixture(LOCAL, 'local'), remote = fixture(REMOTE, 'remote')
    router.add(local.connection); router.add({ ...remote.connection, name: 'forge' })
    router.select(REMOTE)
    remote.state.error = noProviderRefusal('host', false)
    remote.command.mockImplementationOnce(async () => ({ ...remote.state, error: noProviderRefusal('host', true) }))
    expect((await router.command({ type: 'manual-send', threadId: hostEntityKey(REMOTE, 'thread'), text: 'Reply' }, desktopWindowClient())).error)
      .toBe('No provider is connected on forge. Connect one in Settings > Hosts. Your draft is saved.')
    remote.command.mockImplementationOnce(async () => remote.state)
    await router.command({ type: 'create-project', title: 'Site', path: '/srv/site', useExisting: true }, desktopWindowClient())
    expect(router.shell().error).toBe('No provider is connected on forge. Connect one in Settings > Hosts.')
    // This computer's own refusal names this computer already and is passed on as it is.
    const own = new DesktopHostRouter(emptyDesktopState)
    own.add(local.connection)
    local.state.error = noProviderRefusal('desktop', false)
    expect(own.shell().error).toBe('No provider is connected on this computer. Connect one in Settings > Providers.')
  })
  it('returns a worktree preview only to its caller and explains older host failures', async () => {
    const router = new DesktopHostRouter(emptyDesktopState), remote = fixture(REMOTE, 'remote')
    router.add(remote.connection)
    const publish = vi.fn(); router.subscribe(publish); publish.mockClear()
    const preview = { path: '/checkout', branch: 'sotto/test', dirty: false, ignored: ['.env'], items: [{ path: '.env', bytes: 10, fileCount: 1 }], repositories: [], untracked: [] }
    remote.command.mockResolvedValueOnce({ ...remote.state, worktreeReclaimPreview: preview })
    expect((await router.command({ type: 'preview-reclaim-thread-worktree', threadId: hostEntityKey(REMOTE, 'thread') }, desktopWindowClient())).worktreeReclaimPreview).toEqual(preview)
    expect(router.shell().worktreeReclaimPreview).toBeUndefined()
    expect(publish).not.toHaveBeenCalled()
    remote.command.mockResolvedValueOnce(remote.state)
    expect((await router.command({ type: 'preview-reclaim-thread-worktree', threadId: hostEntityKey(REMOTE, 'thread') }, desktopWindowClient())).error).toContain('Update the host')
    remote.command.mockRejectedValueOnce(new Error('Unknown command'))
    expect((await router.command({ type: 'preview-reclaim-thread-worktree', threadId: hostEntityKey(REMOTE, 'thread') }, desktopWindowClient())).error).toContain('update the host')
    expect(publish).not.toHaveBeenCalled()
  })
  it('keeps colliding IDs distinct and dispatches every thread action to its owner', async () => {
    const router = new DesktopHostRouter(emptyDesktopState), local = fixture(LOCAL, 'local'), remote = fixture(REMOTE, 'remote')
    router.add(local.connection); router.add(remote.connection)
    expect(router.shell().host.threads.map(thread => [thread.id, thread.hostLabel])).toEqual([[hostEntityKey(LOCAL, 'thread'), 'This computer'], [hostEntityKey(REMOTE, 'thread'), 'Forge']])
    await router.command({ type: 'manual-send', threadId: hostEntityKey(REMOTE, 'thread'), text: 'Reply' }, desktopWindowClient())
    expect(remote.command).toHaveBeenCalledWith({ type: 'manual-send', threadId: 'thread', text: 'Reply' }, desktopWindowClient())
    expect(local.command).not.toHaveBeenCalled()
    expect((await router.threadDetail(hostEntityKey(REMOTE, 'thread')))?.threadId).toBe(hostEntityKey(REMOTE, 'thread'))
  })
  it('stages an image on the host that runs its thread, or the selected host for the coordinator, and reads it back there (ADR-0031)', async () => {
    const router = new DesktopHostRouter(emptyDesktopState), local = fixture(LOCAL, 'local'), remote = fixture(REMOTE, 'remote')
    const handle = { id: 'image', name: 'Shot.png', mimeType: 'image/png' as const, sizeBytes: 8, digest: 'a'.repeat(64) }
    const stages = { local: vi.fn(async () => handle), remote: vi.fn(async () => handle) }
    const contents = { local: vi.fn(async () => null), remote: vi.fn(async () => ({ mimeType: 'image/png' as const, bytes: new Uint8Array([1]) })) }
    router.add({ ...local.connection, stage: stages.local, content: contents.local })
    router.add({ ...remote.connection, stage: stages.remote, content: contents.remote })
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    await expect(router.stageAttachment({ threadId: hostEntityKey(REMOTE, 'thread'), name: 'Shot.png', mimeType: 'image/png', bytes })).resolves.toEqual(handle)
    expect(stages.remote).toHaveBeenCalledWith({ name: 'Shot.png', mimeType: 'image/png', bytes }); expect(stages.local).not.toHaveBeenCalled()
    await router.stageAttachment({ threadId: null, name: 'Shot.png', mimeType: 'image/png', bytes })
    expect(stages.local).toHaveBeenCalledOnce()
    expect(await router.attachmentContent({ threadId: hostEntityKey(REMOTE, 'thread'), digest: handle.digest })).toEqual({ mimeType: 'image/png', bytes: new Uint8Array([1]) })
    expect(contents.remote).toHaveBeenCalledWith(handle.digest); expect(contents.local).not.toHaveBeenCalled()
    router.remove(REMOTE)
    router.add({ ...remote.connection, stage: stages.remote, content: contents.remote, available: () => false })
    await expect(router.stageAttachment({ threadId: hostEntityKey(REMOTE, 'thread'), name: 'Shot.png', mimeType: 'image/png', bytes })).rejects.toThrow('Nothing was attached.')
    expect(await router.attachmentContent({ threadId: hostEntityKey(REMOTE, 'thread'), digest: handle.digest })).toBeNull()
  })
  it('passes each host\'s finished-unread mark to the window on that host\'s thread, and sends the window\'s panes to the host that owns them (ADR-0046)', async () => {
    const router = new DesktopHostRouter(emptyDesktopState), local = fixture(LOCAL, 'local'), remote = fixture(REMOTE, 'remote')
    router.add(local.connection); router.add(remote.connection)
    remote.state.host.threads = [{ ...remote.state.host.threads[0]!, finishedUnread: true }]
    const thread = (hostId: string) => router.shell().host.threads.find(item => item.id === hostEntityKey(hostId, 'thread'))
    expect(thread(REMOTE)?.finishedUnread).toBe(true)
    expect(thread(LOCAL)).not.toHaveProperty('finishedUnread')
    // Showing the remote thread is the remote host's to hear: it clears the mark there, and the next shell carries that.
    await router.command({ type: 'observe-threads', threadIds: [hostEntityKey(REMOTE, 'thread')] }, desktopWindowClient())
    expect(remote.observe).toHaveBeenCalledWith(['thread'])
    expect(local.observe).toHaveBeenCalledWith([])
    router.dispose()
  })
  it("names each host's unconfirmed settings changes by the thread's client key", () => {
    const router = new DesktopHostRouter(emptyDesktopState), local = fixture(LOCAL, 'local'), remote = fixture(REMOTE, 'remote')
    router.add(local.connection); router.add(remote.connection)
    expect(router.shell().unconfirmedSettings).toBeUndefined()
    remote.state.unconfirmedSettings = [{ threadId: 'thread', runtimeMode: 'full-access' }]
    expect(router.shell().unconfirmedSettings).toEqual([{ threadId: hostEntityKey(REMOTE, 'thread'), runtimeMode: 'full-access' }])
  })
  it('keeps selection client-local and uses the chosen host for commands without references', async () => {
    const router = new DesktopHostRouter(emptyDesktopState), local = fixture(LOCAL, 'local'), remote = fixture(REMOTE, 'remote')
    router.add(local.connection); router.add(remote.connection)
    await router.command({ type: 'select-thread', threadId: hostEntityKey(REMOTE, 'thread') }, desktopWindowClient())
    expect(router.shell().activeThreadId).toBe(hostEntityKey(REMOTE, 'thread'))
    expect(remote.command).toHaveBeenCalledWith({ type: 'select-thread', threadId: 'thread' }, desktopWindowClient())
    expect(local.command).not.toHaveBeenCalled()
    router.select(LOCAL)
    expect(router.shell().activeThreadId).toBeNull()
    await router.command({ type: 'connect' }, desktopWindowClient())
    expect(local.command).toHaveBeenCalledWith({ type: 'connect' }, desktopWindowClient())
    expect(remote.command).toHaveBeenCalledTimes(1)
  })
  describe('following a selection the host moved', () => {
    function setup() {
      const router = new DesktopHostRouter(emptyDesktopState), local = fixture(LOCAL, 'local'), remote = fixture(REMOTE, 'remote')
      local.state.host.threads.push({ id: 'other', projectId: 'project', title: 'Other', modelId: '', status: 'idle', messages: [], requests: [] })
      router.add(local.connection); router.add(remote.connection)
      const moveLocalTo = (threadId: string) => { local.state.activeThreadId = threadId; local.state.activeProjectId = 'project' }
      return { router, local, remote, moveLocalTo }
    }
    it('follows the selection a new project or thread takes on the host', async () => {
      const { router, local, moveLocalTo } = setup()
      await router.command({ type: 'select-thread', threadId: hostEntityKey(LOCAL, 'thread') }, desktopWindowClient())
      local.command.mockImplementationOnce(async () => { moveLocalTo('other'); return local.state })
      await router.command({ type: 'create-project', title: 'New project', path: '/repo/new' }, desktopWindowClient())
      expect(router.shell()).toMatchObject({ activeThreadId: hostEntityKey(LOCAL, 'other'), activeProjectId: hostEntityKey(LOCAL, 'project') })
      local.command.mockImplementationOnce(async () => { moveLocalTo('thread'); return local.state })
      await router.command({ type: 'create-thread', projectId: hostEntityKey(LOCAL, 'project'), title: 'Task', modelId: 'model' }, desktopWindowClient())
      expect(router.shell().activeThreadId).toBe(hostEntityKey(LOCAL, 'thread'))
    })
    it('still goes there when the command fails after the host moved', async () => {
      const { router, local, moveLocalTo } = setup()
      await router.command({ type: 'select-thread', threadId: hostEntityKey(LOCAL, 'thread') }, desktopWindowClient())
      local.command.mockImplementationOnce(async () => { moveLocalTo('other'); throw new Error('The reply was lost.') })
      await expect(router.command({ type: 'create-thread', projectId: hostEntityKey(LOCAL, 'project'), title: 'Task', modelId: 'model' }, desktopWindowClient())).rejects.toThrow('reply was lost')
      expect(router.shell().activeThreadId).toBe(hostEntityKey(LOCAL, 'other'))
    })
    it('stays put when the host moves for an answer or on its own', async () => {
      const { router, local, moveLocalTo } = setup()
      await router.command({ type: 'select-thread', threadId: hostEntityKey(LOCAL, 'thread') }, desktopWindowClient())
      // Another client may change the host's selection while this window answers.
      local.command.mockImplementationOnce(async () => { moveLocalTo('other'); return local.state })
      await router.command({ type: 'answer', threadId: hostEntityKey(LOCAL, 'thread'), requestId: 'request', answer: 'Yes' }, desktopWindowClient())
      expect(router.shell().activeThreadId).toBe(hostEntityKey(LOCAL, 'thread'))
      moveLocalTo('thread'); moveLocalTo('other')
      expect(router.shell().activeThreadId).toBe(hostEntityKey(LOCAL, 'thread'))
    })
    describe('a thread this window creates on a remote host', () => {
      // A remote host keeps a selection for each client and leaves it alone on create-thread, as forge did.
      const NEW_THREAD = '33333333-3333-4333-8333-333333333334'
      const newThread = hostEntityKey(REMOTE, NEW_THREAD)
      const addNewThread = (host: ReturnType<typeof fixture>) =>
        host.state.host.threads.push({ id: NEW_THREAD, projectId: 'project', title: 'New thread', modelId: '', status: 'idle', messages: [], requests: [] })
      /** The host's answer to create-thread: the thread added and its own selection unmoved, or a refusal. */
      function hostAnswersCreation(host: ReturnType<typeof fixture>, refusal: string | null = null) {
        host.command.mockImplementationOnce(async () => {
          if (refusal === null) addNewThread(host)
          return { ...host.state, error: refusal }
        })
      }
      const createFromWindow = (router: DesktopHostRouter, hostId = REMOTE, threadId: string | null = hostEntityKey(hostId, NEW_THREAD)) =>
        router.command({ type: 'create-thread', ...(threadId ? { threadId } : {}), projectId: hostEntityKey(hostId, 'project'), title: 'New thread', modelId: 'model' }, desktopWindowClient())
      const sentTypes = (host: ReturnType<typeof fixture>) => host.command.mock.calls.map(([request]) => request.type)

      it('opens it and tells the host, so the host composes and sends there', async () => {
        const { router, remote } = setup()
        await router.command({ type: 'select-thread', threadId: hostEntityKey(LOCAL, 'thread') }, desktopWindowClient())
        hostAnswersCreation(remote)
        await createFromWindow(router)
        expect(router.shell()).toMatchObject({ hostId: REMOTE, activeThreadId: newThread, activeProjectId: hostEntityKey(REMOTE, 'project') })
        expect(remote.command).toHaveBeenLastCalledWith({ type: 'select-thread', threadId: NEW_THREAD }, desktopWindowClient())
      })
      it('stays put when the host refuses it', async () => {
        const { router, remote } = setup()
        await router.command({ type: 'select-thread', threadId: hostEntityKey(LOCAL, 'thread') }, desktopWindowClient())
        hostAnswersCreation(remote, 'Choose an available project.')
        await createFromWindow(router)
        expect(router.shell().activeThreadId).toBe(hostEntityKey(LOCAL, 'thread'))
        expect(sentTypes(remote)).toEqual(['create-thread'])
      })
      it('keeps a selection the user made while the host created it', async () => {
        const { router, remote } = setup()
        let finish: () => void = () => undefined
        remote.command.mockImplementationOnce(() => { const pending = deferred<AgentState>(); finish = () => { addNewThread(remote); pending.resolve(remote.state) }; return pending.promise })
        const creating = createFromWindow(router)
        await router.command({ type: 'select-thread', threadId: hostEntityKey(LOCAL, 'other') }, desktopWindowClient())
        finish(); await creating
        expect(router.shell().activeThreadId).toBe(hostEntityKey(LOCAL, 'other'))
      })
      it('reports the creation, not a refusal, when the host loses or refuses the selection that follows', async () => {
        const { router, remote } = setup()
        hostAnswersCreation(remote)
        remote.command.mockRejectedValueOnce(new HostConnectionError('The host did not confirm the command.', 'disconnected'))
        await expect(createFromWindow(router)).resolves.toMatchObject({ error: null })
        expect(router.shell().activeThreadId).toBe(newThread)
      })
      it('reports the creation when the host refuses the selection that follows', async () => {
        const { router, remote } = setup()
        hostAnswersCreation(remote)
        remote.command.mockImplementationOnce(async () => ({ ...remote.state, error: 'That thread is unavailable.' }))
        await expect(createFromWindow(router)).resolves.toMatchObject({ error: null })
        expect(router.shell().activeThreadId).toBe(newThread)
      })
      it('leaves a host removed while it created the thread', async () => {
        const { router, remote } = setup()
        await router.command({ type: 'select-thread', threadId: hostEntityKey(LOCAL, 'thread') }, desktopWindowClient())
        let finish: () => void = () => undefined
        remote.command.mockImplementationOnce(() => { const pending = deferred<AgentState>(); finish = () => { addNewThread(remote); pending.resolve(remote.state) }; return pending.promise })
        const creating = createFromWindow(router)
        router.remove(REMOTE)
        finish(); await creating
        expect(router.shell().hostId).toBe(LOCAL)
        expect(sentTypes(remote)).toEqual(['create-thread'])
      })
      it('asks nothing more of a creation that names no thread, or of this computer, which selects what it creates', async () => {
        const { router, local, remote } = setup()
        hostAnswersCreation(remote)
        await createFromWindow(router, REMOTE, null)
        expect(sentTypes(remote)).toEqual(['create-thread'])
        hostAnswersCreation(local)
        await createFromWindow(router, LOCAL)
        expect(sentTypes(local)).toEqual(['create-thread'])
      })
    })
    it('keeps a selection the user made while the command ran', async () => {
      const { router, local, moveLocalTo } = setup()
      await router.command({ type: 'select-thread', threadId: hostEntityKey(LOCAL, 'thread') }, desktopWindowClient())
      let finish: () => void = () => undefined
      local.command.mockImplementationOnce(() => { const pending = deferred<AgentState>(); finish = () => { moveLocalTo('other'); pending.resolve(local.state) }; return pending.promise })
      const creating = router.command({ type: 'create-thread', projectId: hostEntityKey(LOCAL, 'project'), title: 'Task', modelId: 'model' }, desktopWindowClient())
      await router.command({ type: 'select-thread', threadId: hostEntityKey(REMOTE, 'thread') }, desktopWindowClient())
      finish(); await creating
      expect(router.shell().activeThreadId).toBe(hostEntityKey(REMOTE, 'thread'))
    })
  })
  it('forwards select-project to the owning host and keeps a disconnected host\'s selection local', async () => {
    const router = new DesktopHostRouter(emptyDesktopState), local = fixture(LOCAL, 'local'), remote = fixture(REMOTE, 'remote')
    const offline = fixture('33333333-3333-4333-8333-333333333333', 'remote')
    offline.connection = { ...offline.connection, available: () => false }
    router.add(local.connection); router.add(remote.connection); router.add(offline.connection)
    await router.command({ type: 'select-project', projectId: hostEntityKey(REMOTE, 'project') }, desktopWindowClient())
    expect(remote.command).toHaveBeenCalledWith({ type: 'select-project', projectId: 'project' }, desktopWindowClient())
    expect(router.shell().activeProjectId).toBe(hostEntityKey(REMOTE, 'project'))
    await router.command({ type: 'select-thread', threadId: hostEntityKey(offline.connection.hostId, 'thread') }, desktopWindowClient())
    expect(router.shell().activeThreadId).toBe(hostEntityKey(offline.connection.hostId, 'thread'))
    expect(offline.command).not.toHaveBeenCalled()
  })
  it('sends host-folders to the named host, not the selected one, and names the trouble when it cannot', async () => {
    const router = new DesktopHostRouter(emptyDesktopState), local = fixture(LOCAL, 'local'), remote = fixture(REMOTE, 'remote')
    const hostFolders = { local: vi.fn(async () => ({ status: 'listed' as const, path: 'C:\\', home: 'C:\\Users\\local', separator: '\\' as const, crumbs: [{ name: 'This computer', path: null }], folders: [], truncated: false })),
      remote: vi.fn(async () => ({ status: 'listed' as const, path: '/repo', home: '/home/forge', separator: '/' as const, crumbs: [{ name: '/', path: '/' }], folders: [], truncated: false })) }
    router.add({ ...local.connection, hostFolders: hostFolders.local })
    router.add({ ...remote.connection, hostFolders: hostFolders.remote })
    router.select(REMOTE) // selection must not matter: the request names its own host
    const result = await router.hostFolders({ hostId: LOCAL, path: undefined })
    expect(result.path).toBe('C:\\')
    expect(hostFolders.local).toHaveBeenCalledWith({})
    expect(hostFolders.remote).not.toHaveBeenCalled()
    await router.hostFolders({ hostId: REMOTE, path: '/repo' })
    expect(hostFolders.remote).toHaveBeenCalledWith({ path: '/repo' })
    await expect(router.hostFolders({ hostId: 'missing-host' })).rejects.toThrow('not connected')
    router.remove(REMOTE)
    router.add({ ...remote.connection, hostFolders: hostFolders.remote, available: () => false })
    await expect(router.hostFolders({ hostId: REMOTE })).rejects.toThrow('disconnected')
    router.remove(LOCAL)
    router.add({ ...local.connection })
    await expect(router.hostFolders({ hostId: LOCAL })).rejects.toThrow('cannot list its folders yet')
  })
  it('reads a paired host\'s Files, Changes and Agents by its own IDs and hands every ID back as the window\'s key (ADR-0025, October 5 amendment)', async () => {
    const router = new DesktopHostRouter(emptyDesktopState), local = fixture(LOCAL, 'local'), remote = fixture(REMOTE, 'remote')
    const key = hostEntityKey(REMOTE, 'thread'), workspaceId = 'a'.repeat(64)
    const workspace = { threadId: 'thread', projectId: 'project', workingDirectory: '/home/forge/repo', workspaceId }
    const agentRow = { id: 'claude:ui', sequence: 1, revision: 1, assignmentId: 'task-ui', assignmentCount: 1, title: 'Build the Agents view', description: 'Connect the roster.', status: 'running' as const, lastObservedAt: '2026-10-05T10:00:00.000Z' }
    const reads = {
      threadFiles: vi.fn(async (request: FileListRequest) => ({ ok: true as const, value: { workspace, path: request.path, truncated: false,
        entries: [{ name: 'a.txt', path: request.path ? `${request.path}/a.txt` : 'a.txt', kind: 'file' as const }] } })),
      threadFilePreview: vi.fn(async (request: FileRequest) => ({ ok: true as const, value: { workspace, path: request.path, name: 'a.txt', size: 1, content: { kind: 'text' as const, text: 'a' } } })),
      gitChanges: vi.fn(async () => ({ ok: true as const, value: { workspace, branch: 'main', revision: 'r1', files: [], truncated: false } })),
      gitReview: vi.fn(async () => ({ ok: true as const, value: { workspace, revision: 'r1', scope: { kind: 'working' as const }, files: [], truncated: false } })),
      subagentPage: vi.fn(async () => ({ threadId: 'thread', revision: 1, rows: [agentRow], summary: EMPTY_SUBAGENT_SUMMARY })),
      subagentAssignments: vi.fn(async () => ({ threadId: 'thread', agentId: 'agent', assignments: [] })),
    }
    router.add(local.connection); router.add({ ...remote.connection, ...reads })
    // The host is asked by its own ID, and its answer's thread and project come back keyed to it.
    await expect(router.threadFiles({ threadId: key, path: '' })).resolves.toMatchObject({ ok: true, value: { workspace: { threadId: key, projectId: hostEntityKey(REMOTE, 'project'), workingDirectory: '/home/forge/repo', workspaceId } } })
    expect(reads.threadFiles).toHaveBeenCalledWith({ threadId: 'thread', path: '' })
    await expect(router.threadFilePreview({ threadId: key, path: 'a.txt', workspaceId })).resolves.toMatchObject({ ok: true, value: { workspace: { threadId: key } } })
    expect(reads.threadFilePreview).toHaveBeenCalledWith({ threadId: 'thread', path: 'a.txt', workspaceId })
    await expect(router.gitChanges({ threadId: key, workspaceId })).resolves.toMatchObject({ ok: true, value: { workspace: { threadId: key } } })
    await expect(router.gitReview({ threadId: key, workspaceId, scope: { kind: 'working' } })).resolves.toMatchObject({ ok: true, value: { workspace: { threadId: key } } })
    expect(reads.gitReview).toHaveBeenCalledWith({ threadId: 'thread', workspaceId, scope: { kind: 'working' } })
    // The host's roster comes back whole, keyed to the host's thread.
    await expect(router.subagentPage({ threadId: key })).resolves.toMatchObject({ threadId: key, rows: [agentRow] })
    expect(reads.subagentPage).toHaveBeenCalledWith({ threadId: 'thread' })
    // An agent's ID is the provider's, not a Sotto reference, so it comes back as it went.
    await expect(router.subagentAssignments({ threadId: key, agentId: 'agent' })).resolves.toEqual({ threadId: key, agentId: 'agent', assignments: [] })
    // Copy path is the host's own path, in its format, once a listing of its folder shows the working folder and the entry.
    await expect(router.threadFilePath({ threadId: key, path: 'notes/a.txt', workspaceId })).resolves.toMatchObject({ ok: true, value: { path: 'notes/a.txt', absolutePath: '/home/forge/repo/notes/a.txt', workspace: { threadId: key } } })
    expect(reads.threadFiles).toHaveBeenLastCalledWith({ threadId: 'thread', path: 'notes', workspaceId })
    await expect(router.threadFilePath({ threadId: key, path: '', workspaceId })).resolves.toMatchObject({ ok: true, value: { absolutePath: '/home/forge/repo' } })
    await expect(router.threadFilePath({ threadId: key, path: 'gone.txt', workspaceId })).resolves.toMatchObject({ ok: false, error: { code: 'path-unavailable' } })
    await expect(router.gitChangesPath({ threadId: key, path: 'src/b.ts', workspaceId })).resolves.toMatchObject({ ok: true, value: { absolutePath: '/home/forge/repo/src/b.ts', workspace: { threadId: key } } })
    expect(local.command).not.toHaveBeenCalled()
  })
  it('answers Files and Changes with the host\'s trouble in words, and refuses Agents with the same words', async () => {
    const router = new DesktopHostRouter(emptyDesktopState), remote = fixture(REMOTE, 'remote')
    const key = hostEntityKey(REMOTE, 'thread'), workspaceId = 'a'.repeat(64)
    const older = new HostConnectionError(hostVersionMismatch('0.1.31', '0.1.30', false), 'version_mismatch')
    router.add({ ...remote.connection, threadFiles: vi.fn(async () => { throw older }), subagentPage: vi.fn(async () => { throw older }),
      gitChanges: vi.fn(async () => { throw new Error('{"issues":[]}') }) })
    // A host from before these reads says which side to update, where the listing would have been.
    await expect(router.threadFiles({ threadId: key, path: '' })).resolves.toEqual({ ok: false, error: { code: 'unavailable', message: older.message } })
    await expect(router.subagentPage({ threadId: key })).rejects.toThrow(older.message)
    // Anything else it could not read is named by the host, never shown raw.
    await expect(router.gitChanges({ threadId: key })).resolves.toEqual({ ok: false, error: { code: 'unavailable', message: 'Forge could not read this thread\'s changes. Nothing was changed. Try again.' } })
    await expect(router.gitReview({ threadId: key, workspaceId, scope: { kind: 'working' } })).resolves.toEqual({ ok: false, error: { code: 'unavailable', message: 'Changes is unavailable on this host. Nothing was changed. Check the host in Settings > Hosts.' } })
    await expect(router.subagentAssignments({ threadId: key, agentId: 'agent' })).rejects.toThrow('Agents is unavailable on this host.')
    router.remove(REMOTE)
    router.add({ ...remote.connection, threadFiles: vi.fn(), available: () => false })
    await expect(router.threadFiles({ threadId: key, path: '' })).resolves.toMatchObject({ ok: false, error: { code: 'unavailable', message: 'This host is disconnected. Nothing was changed. Connect again to read its files.' } })
    await expect(router.threadFiles({ threadId: hostEntityKey('33333333-3333-4333-8333-333333333333', 'thread'), path: '' })).resolves.toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })
  it('joins a paired host\'s path in that host\'s own format, never this computer\'s', () => {
    expect(hostAbsolutePath('/home/forge/repo', 'src/a.ts')).toBe('/home/forge/repo/src/a.ts')
    expect(hostAbsolutePath('/home/forge/repo/', 'src/a.ts')).toBe('/home/forge/repo/src/a.ts')
    expect(hostAbsolutePath('/', 'etc/hosts')).toBe('/etc/hosts')
    expect(hostAbsolutePath('/home/forge/back\\slash', 'a.txt')).toBe('/home/forge/back\\slash/a.txt')
    expect(hostAbsolutePath('C:\\work\\repo', 'src/a.ts')).toBe('C:\\work\\repo\\src\\a.ts')
    expect(hostAbsolutePath('C:\\', 'a.txt')).toBe('C:\\a.txt')
    expect(hostAbsolutePath('C:/work/repo', 'src/a.ts')).toBe('C:/work/repo/src/a.ts')
    expect(hostAbsolutePath('/home/forge/repo', '')).toBe('/home/forge/repo')
  })
  it('splits observed threads and refuses cross-host commands and local folder actions', async () => {
    const router = new DesktopHostRouter(emptyDesktopState), local = fixture(LOCAL, 'local'), remote = fixture(REMOTE, 'remote')
    router.add(local.connection); router.add(remote.connection)
    await router.command({ type: 'observe-threads', threadIds: [hostEntityKey(LOCAL, 'thread'), hostEntityKey(REMOTE, 'thread')] }, desktopWindowClient())
    expect(local.observe).toHaveBeenCalledWith(['thread']); expect(remote.observe).toHaveBeenCalledWith(['thread'])
    await expect(router.command({ type: 'create-thread', projectId: hostEntityKey(LOCAL, 'project'), threadId: hostEntityKey(REMOTE, 'thread'), title: 'Task', modelId: '' }, desktopWindowClient())).rejects.toThrow('different hosts')
    await expect(router.command({ type: 'open-thread-folder', threadId: hostEntityKey(REMOTE, 'thread') }, desktopWindowClient())).rejects.toThrow('host machine')
    router.remove(REMOTE)
    await expect(router.threadDetail(hostEntityKey(REMOTE, 'thread'))).rejects.toThrow('Connect a host')
  })
})

it('reads each owning host catalog and capabilities when model IDs collide', () => {
  const router = new DesktopHostRouter(emptyDesktopState), local = fixture(LOCAL, 'local'), remote = fixture(REMOTE, 'remote')
  local.state.host.models = [{ id: 'same-model', provider: 'Native', name: 'Local model', ready: true }]
  remote.state.host.models = [{ id: 'same-model', provider: 'Native', name: 'Forge model', ready: true }]
  local.state.host.capabilities.interrupt = false; remote.state.host.capabilities.interrupt = true
  router.add(local.connection); router.add(remote.connection); router.select(LOCAL)
  const state = router.shell(), [localThread, remoteThread] = state.host.threads
  expect(hostForThread(state.host, localThread!).models[0]!.name).toBe('Local model')
  expect(hostForThread(state.host, remoteThread!).models[0]!.name).toBe('Forge model')
  expect(capabilitiesForThread(state.host, localThread!).interrupt).toBe(false)
  expect(capabilitiesForThread(state.host, remoteThread!).interrupt).toBe(true)
})

it('sends each host catalog across IPC once, not again in the host entry', () => {
  // A window receives the shell through Electron's structured clone, which writes an array it meets twice once.
  const router = new DesktopHostRouter(emptyDesktopState), local = fixture(LOCAL, 'local'), remote = fixture(REMOTE, 'remote')
  const catalog = (host: string) => Array.from({ length: 600 }, (_, index) => ({ id: `model-${index}`, provider: 'Native', name: `${host} model ${index}`, ready: true,
    description: 'A model description long enough to weigh what a real catalog weighs on the wire.' }))
  local.state.host.models = catalog('Local'); remote.state.host.models = catalog('Forge')
  // The rest of the shell is small beside a catalog, so the bound allows each catalog once and a fifth for everything else.
  const catalogBytes = serialize(local.state.host.models).length
  router.add(local.connection)
  const alone = router.shell()
  expect(alone.host.clientHosts![0]!.models).toBe(alone.host.models)
  expect(serialize(alone).length).toBeLessThan(catalogBytes * 1.2)
  router.add(remote.connection); router.select(LOCAL)
  const both = router.shell()
  expect(serialize(both).length).toBeLessThan(catalogBytes * 2 * 1.2)
  expect(hostForThread(both.host, both.host.threads[1]!).models[0]!.name).toBe('Forge model 0')
})

describe('a host restarting for an update (ADR-0040)', () => {
  it('keeps its threads, reading Reconnecting, and takes the new connection in their place without losing the selection', async () => {
    const router = new DesktopHostRouter(emptyDesktopState), local = fixture(LOCAL, 'local'), remote = fixture(REMOTE, 'remote')
    let available = true
    router.add(local.connection); router.add({ ...remote.connection, available: () => available })
    await router.command({ type: 'select-thread', threadId: hostEntityKey(REMOTE, 'thread') }, desktopWindowClient())
    // The old connection drops while the host restarts: its thread stays, disconnected and reconnecting.
    available = false
    router.setReconnecting(REMOTE, true)
    const restarting = router.shell().host.threads.find(thread => thread.hostId === REMOTE)!
    expect(restarting).toMatchObject({ id: hostEntityKey(REMOTE, 'thread'), clientConnected: false, clientReconnecting: true })
    expect(router.shell().activeThreadId).toBe(hostEntityKey(REMOTE, 'thread'))
    // This computer's own thread does not read Reconnecting.
    expect(router.shell().host.threads.find(thread => thread.hostId === LOCAL)!.clientReconnecting).toBeUndefined()
    // The new connection takes its place: same thread, same selection, connected, and no longer reconnecting.
    const next = fixture(REMOTE, 'remote')
    router.replace(next.connection)
    const back = router.shell().host.threads.find(thread => thread.hostId === REMOTE)!
    expect(back).toMatchObject({ id: hostEntityKey(REMOTE, 'thread'), clientConnected: true })
    expect(back.clientReconnecting).toBeUndefined()
    expect(router.shell().activeThreadId).toBe(hostEntityKey(REMOTE, 'thread'))
    await router.command({ type: 'manual-send', threadId: hostEntityKey(REMOTE, 'thread'), text: 'After the update' }, desktopWindowClient())
    expect(next.command).toHaveBeenCalledWith({ type: 'manual-send', threadId: 'thread', text: 'After the update' }, desktopWindowClient())
  })
  it('passes a host’s client updates to the window only when the host offers them, so an older host shows nothing new (#480)', () => {
    const router = new DesktopHostRouter(emptyDesktopState), older = fixture(LOCAL, 'remote'), newer = fixture(REMOTE, 'remote')
    const reading = { id: 'codex' as const, installed: '0.155.1', published: '0.158.0', behind: true, channel: 'mise' as const, canInstall: true, checkedAt: '2026-09-29T00:00:00.000Z', state: 'updating' as const }
    for (const item of [older, newer]) { item.state.clientUpdates = [reading]; item.state.clientUpdateRun = { total: 2, done: 0 } }
    router.add(older.connection); router.add({ ...newer.connection, offersClientUpdates: () => true })
    const [first, second] = router.shell().host.clientHosts!
    expect(first).not.toHaveProperty('clientUpdates'); expect(first).not.toHaveProperty('clientUpdateRun')
    expect(second).toMatchObject({ clientUpdates: [reading], clientUpdateRun: { total: 2, done: 0 } })
    // This computer's corner card never shows a remote host's clients: they are on that host's tiles.
    router.select(REMOTE)
    expect(router.shell()).not.toHaveProperty('clientUpdates'); expect(router.shell()).not.toHaveProperty('clientUpdateRun')
    const own = new DesktopHostRouter(emptyDesktopState), local = fixture(LOCAL, 'local')
    local.state.clientUpdates = [reading]; own.add(local.connection)
    expect(own.shell().clientUpdates).toEqual([reading])
  })
  it('marks the hosts that babysit pull requests, so the window offers Babysit pull request only on their threads (ADR-0061)', async () => {
    const router = new DesktopHostRouter(emptyDesktopState), older = fixture(LOCAL, 'remote'), newer = fixture(REMOTE, 'remote')
    router.add(older.connection); router.add({ ...newer.connection, offersBabysitting: () => true })
    const [first, second] = router.shell().host.clientHosts!
    expect(first).not.toHaveProperty('pullRequestBabysit')
    expect(second).toMatchObject({ pullRequestBabysit: true })
    // The user's Stop babysitting reaches the thread's own host by its own thread ID, like every thread command.
    const url = 'https://github.com/o/r/pull/42'
    await router.command({ type: 'stop-babysitting', threadId: hostEntityKey(REMOTE, 'thread'), url }, desktopWindowClient())
    expect(newer.command).toHaveBeenCalledWith({ type: 'stop-babysitting', threadId: 'thread', url }, desktopWindowClient())
  })
})

describe('exact answer notice ownership', () => {
  function answerNoticeFixture() {
    const remote = fixture(REMOTE, 'remote')
    remote.state.host.threads[0]!.providerId = 'claude'
    remote.state.host.threads[0]!.requests = [{ id: 'question', kind: 'question', text: 'Question', options: [{ id: 'yes', label: 'Yes' }] }]
    const completed: RequestAnswerRecovery['completed'] = []
    const bound: RequestAnswerRecovery['completed'] = []
    remote.connection.service.requestAnswerRecovery = () => ({ uncertainRequestIds: [], completed })
    const router = new DesktopHostRouter(emptyDesktopState, { bindRequestDraftDecision: async (target, decisionId) => {
      bound.push({ requestId: target.requestId, questionsDigest: requestQuestionsDigest(target.questions), decisionId })
    } })
    router.add(remote.connection)
    const answer = { type: 'answer' as const, threadId: hostEntityKey(REMOTE, 'thread'), requestId: 'question', answer: 'yes' }
    return { remote, completed, bound, router, answer }
  }
  it.each(['before', 'after'] as const)('retires only its exact answer notice when proof arrives %s the command reply', async timing => {
    const f = answerNoticeFixture()
    f.remote.command.mockImplementationOnce(async () => {
      if (timing === 'before') f.completed.push(f.bound[0]!)
      return { ...f.remote.state, error: 'Synthetic unconfirmed answer' }
    })
    const result = await f.router.command(f.answer, desktopWindowClient())
    expect(result.error).toBe(timing === 'before' ? null : 'Synthetic unconfirmed answer')
    if (timing === 'after') f.completed.push(f.bound[0]!)
    expect(f.router.shell().error).toBeNull()
    f.router.dispose()
  })
  it.each(['answer', 'interrupt'] as const)('keeps a newer %s notice with the same wording when an older answer gains proof', async later => {
    const f = answerNoticeFixture()
    f.remote.command.mockImplementation(async () => ({ ...f.remote.state, error: 'Synthetic unconfirmed answer' }))
    await f.router.command(f.answer, desktopWindowClient())
    const oldProof = f.bound[0]!
    await f.router.command(later === 'answer' ? f.answer : { type: 'interrupt', threadId: f.answer.threadId }, desktopWindowClient())
    f.completed.push(oldProof)
    expect(f.router.shell().error).toBe('Synthetic unconfirmed answer')
    f.router.dispose()
  })
})

describe('explicit native answer checks', () => {
  it.each([
    ['uncertain', 'stable'], ['retry-ready', 'stable'], ['uncertain', 'cleared'], ['retry-ready', 'cleared'],
    ['uncertain', 'failed'], ['retry-ready', 'failed'],
  ] as const)('does not let an old receipt shortcut a %s native re-offer (receipt %s)', async (boundary, receiptOutcome) => {
    const remote = fixture(REMOTE, 'remote'), router = new DesktopHostRouter(emptyDesktopState)
    const questions = [{ id: '0', question: 'Question', options: [], multiSelect: false, allowFreeText: true }]
    remote.state.host.threads[0]!.providerId = 'grok'
    remote.state.host.threads[0]!.requests = [{ id: 'question', kind: 'question', text: 'Question', options: [], questions,
      ...(boundary === 'uncertain' ? { delivery: 'uncertain' as const } : { answerRetryReady: true }) }]
    const target = { kind: 'thread' as const, ownerId: hostEntityKey(REMOTE, 'thread'), providerId: 'grok' as const, requestId: 'question', questions }
    const digest = requestQuestionsDigest(questions)
    remote.connection.service.requestAnswerRecovery = () => ({ uncertainRequestIds: [], completed: [{ requestId: 'question', decisionId: 'old-answer', questionsDigest: digest }] })
    const receipt = vi.fn(async () => {
      if (receiptOutcome === 'cleared') remote.state.host.threads[0]!.requests = []
      if (receiptOutcome === 'failed') throw new Error('Synthetic receipt read failed')
    }), check = vi.fn(async () => undefined)
    remote.connection.refreshRequestAnswer = receipt
    Object.assign(remote.connection.service, { checkRequestAnswer: check })
    router.add(remote.connection)
    await router.refreshRequestDraft(target, 'old-answer')
    expect(check).toHaveBeenCalledWith({ threadId: 'thread', providerId: 'grok', requestId: 'question', questionsDigest: digest }, desktopWindowClient())
    expect(receipt).toHaveBeenCalledWith('old-answer', { threadId: 'thread', providerId: 'grok', requestId: 'question', questionsDigest: digest })
    expect(remote.detail).not.toHaveBeenCalled()
    router.dispose()
  })
  it('refuses an older host instead of treating cached detail as a fresh native Check', async () => {
    const remote = fixture(REMOTE, 'remote'), router = new DesktopHostRouter(emptyDesktopState)
    router.add(remote.connection)
    await expect(router.refreshRequestDraft({ kind: 'thread', ownerId: hostEntityKey(REMOTE, 'thread'), providerId: 'claude', requestId: 'question',
      questions: [{ id: '0', question: 'Question', options: [], multiSelect: false, allowFreeText: true }] })).rejects.toThrow('Update')
    expect(remote.detail).not.toHaveBeenCalled(); router.dispose()
  })
})
