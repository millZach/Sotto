// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { desktopWindowClient } from '../../../src/main/agents/hostService'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { hostForThread, capabilitiesForThread, type AgentCommand } from '../../../src/shared/agents'

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
  it('keeps colliding IDs distinct and dispatches every thread action to its owner', async () => {
    const router = new DesktopHostRouter(emptyDesktopState), local = fixture(LOCAL, 'local'), remote = fixture(REMOTE, 'remote')
    router.add(local.connection); router.add(remote.connection)
    expect(router.shell().host.threads.map(thread => [thread.id, thread.hostLabel])).toEqual([[hostEntityKey(LOCAL, 'thread'), 'This computer'], [hostEntityKey(REMOTE, 'thread'), 'Forge']])
    await router.command({ type: 'manual-send', threadId: hostEntityKey(REMOTE, 'thread'), text: 'Reply' }, desktopWindowClient())
    expect(remote.command).toHaveBeenCalledWith({ type: 'manual-send', threadId: 'thread', text: 'Reply' }, desktopWindowClient())
    expect(local.command).not.toHaveBeenCalled()
    expect((await router.threadDetail(hostEntityKey(REMOTE, 'thread')))?.threadId).toBe(hostEntityKey(REMOTE, 'thread'))
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
