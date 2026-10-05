// @vitest-environment node
import { serialize } from 'node:v8'
import { describe, expect, it, vi } from 'vitest'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { desktopWindowClient } from '../../../src/main/agents/hostService'
import { HostConnectionError } from '../../../src/main/agents/socketHostService'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { hostForThread, capabilitiesForThread, noProviderRefusal, type AgentCommand } from '../../../src/shared/agents'

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
describe('desktop host routing', () => {
  it.each(['disconnected', 'unavailable', 'version_mismatch'] as const)('keeps %s failures on the uncertain command path', async code => {
    const router = new DesktopHostRouter(emptyDesktopState), remote = fixture(REMOTE, 'remote')
    router.add(remote.connection)
    const error = new HostConnectionError('The host did not confirm the command.', code)
    remote.command.mockRejectedValueOnce(error)
    await expect(router.command({ type: 'configure-thread', threadId: hostEntityKey(REMOTE, 'thread'), runtimeMode: 'full-access' }, desktopWindowClient())).rejects.toBe(error)
    expect(router.shell().error).toBeNull()
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
    it('goes where Later and a new thread take the host', async () => {
      const { router, local, moveLocalTo } = setup()
      await router.command({ type: 'select-thread', threadId: hostEntityKey(LOCAL, 'thread') }, desktopWindowClient())
      local.command.mockImplementationOnce(async () => { moveLocalTo('other'); return local.state })
      await router.command({ type: 'later' }, desktopWindowClient())
      expect(router.shell()).toMatchObject({ activeThreadId: hostEntityKey(LOCAL, 'other'), activeProjectId: hostEntityKey(LOCAL, 'project') })
      local.command.mockImplementationOnce(async () => { moveLocalTo('thread'); return local.state })
      await router.command({ type: 'create-thread', projectId: hostEntityKey(LOCAL, 'project'), title: 'Task', modelId: 'model' }, desktopWindowClient())
      expect(router.shell().activeThreadId).toBe(hostEntityKey(LOCAL, 'thread'))
    })
    it('still goes there when the command fails after the host moved', async () => {
      const { router, local, moveLocalTo } = setup()
      await router.command({ type: 'select-thread', threadId: hostEntityKey(LOCAL, 'thread') }, desktopWindowClient())
      local.command.mockImplementationOnce(async () => { moveLocalTo('other'); throw new Error('The reply was lost.') })
      await expect(router.command({ type: 'next' }, desktopWindowClient())).rejects.toThrow('reply was lost')
      expect(router.shell().activeThreadId).toBe(hostEntityKey(LOCAL, 'other'))
    })
    it('stays put when the host moves for an answer or on its own', async () => {
      const { router, local, moveLocalTo } = setup()
      await router.command({ type: 'select-thread', threadId: hostEntityKey(LOCAL, 'thread') }, desktopWindowClient())
      // Answering presents the host's next queued thread; the user stays in the thread they answered in.
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
        remote.command.mockImplementationOnce(() => new Promise(resolve => { finish = () => { addNewThread(remote); resolve(remote.state) } }))
        const creating = createFromWindow(router)
        await router.command({ type: 'select-thread', threadId: hostEntityKey(LOCAL, 'other') }, desktopWindowClient())
        finish(); await creating
        expect(router.shell().activeThreadId).toBe(hostEntityKey(LOCAL, 'other'))
      })
      it('keeps where Next took the window while the host created it', async () => {
        const { router, local, remote, moveLocalTo } = setup()
        await router.command({ type: 'select-thread', threadId: hostEntityKey(LOCAL, 'thread') }, desktopWindowClient())
        let finish: () => void = () => undefined
        remote.command.mockImplementationOnce(() => new Promise(resolve => { finish = () => { addNewThread(remote); resolve(remote.state) } }))
        const creating = createFromWindow(router)
        local.command.mockImplementationOnce(async () => { moveLocalTo('other'); return local.state })
        await router.command({ type: 'next' }, desktopWindowClient())
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
        remote.command.mockImplementationOnce(() => new Promise(resolve => { finish = () => { addNewThread(remote); resolve(remote.state) } }))
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
      local.command.mockImplementationOnce(() => new Promise(resolve => { finish = () => { moveLocalTo('other'); resolve(local.state) } }))
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
  it('splits observed threads, routes attention IDs, and refuses cross-host commands and local folder actions', async () => {
    const router = new DesktopHostRouter(emptyDesktopState), local = fixture(LOCAL, 'local'), remote = fixture(REMOTE, 'remote')
    router.add(local.connection); router.add(remote.connection)
    await router.command({ type: 'observe-threads', threadIds: [hostEntityKey(LOCAL, 'thread'), hostEntityKey(REMOTE, 'thread')] }, desktopWindowClient())
    expect(local.observe).toHaveBeenCalledWith(['thread']); expect(remote.observe).toHaveBeenCalledWith(['thread'])
    await router.command({ type: 'select-attention', itemId: hostEntityKey(REMOTE, 'attention') }, desktopWindowClient())
    expect(remote.command).toHaveBeenCalledWith({ type: 'select-attention', itemId: 'attention' }, desktopWindowClient())
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
})
