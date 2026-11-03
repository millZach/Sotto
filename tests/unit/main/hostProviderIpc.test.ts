// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', async () => (await import('../../fixtures/preloadElectron')).preloadElectron())
import { registerHostsIpc } from '../../../src/main/hosts/ipc'
import { createSottoBridge } from '../../../src/preload'
import {
  HOSTS_PROVIDER_ACTION, HOSTS_SIGN_IN, HOSTS_UPDATE_CLIENTS,
  type HostClientUpdateRequest, type ProviderSignInView,
} from '../../../src/shared/hostProviders'
import type { HostsState } from '../../../src/shared/hosts'
import { ipcRegistry } from '../../fixtures/ipcHarness'
import { preloadElectron } from '../../fixtures/preloadElectron'

const HOST = '22222222-2222-4222-8222-222222222222'
const SIGN_IN = '33333333-3333-4333-8333-333333333333'
const action = { id: HOST, provider: 'codex', action: 'refresh' } as const
const update = { id: HOST, action: 'update', providers: ['codex'] } satisfies HostClientUpdateRequest
const read = { type: 'read', id: HOST, signInId: SIGN_IN } as const
const view: ProviderSignInView = {
  id: SIGN_IN, provider: 'codex', shape: 'device-code', stage: 'waiting',
  code: 'TEST-CODE', page: 'auth.openai.com', expiresInMinutes: 15,
}

function register() {
  const registry = ipcRegistry()
  const state: HostsState = { hosts: [], localHostEnabled: false, localHostRunning: false }
  const hosts = {
    get: () => state, command: vi.fn(async () => state),
    providerAction: vi.fn(async () => ({})), updateClients: vi.fn(async () => ({})),
    signIn: vi.fn(async (): Promise<ProviderSignInView | null> => view),
    opencodeSignIn: vi.fn(async (): Promise<unknown> => undefined), subscribe: () => () => undefined,
  }
  const tailscale = {
    devices: vi.fn(), status: vi.fn(), connect: vi.fn(), openDownload: vi.fn(), dispose: vi.fn(),
  }
  const close = registerHostsIpc(registry.ipc, hosts, registry.trustedSenders, () => undefined, tailscale)
  const renderer = preloadElectron().ipcRenderer
  renderer.invoke.mockImplementation((channel: string, ...args: unknown[]) => registry.invoke(channel, args))
  const bridge = createSottoBridge(renderer, 'win32').hosts!
  return { ...registry, hosts, renderer, bridge, close }
}

describe('host-provider replies from handler through preload', () => {
  it('preserves action and update results, device codes, and cancellation', async () => {
    const { hosts, bridge, close, handlers } = register()
    await expect(bridge.providerAction(action)).resolves.toEqual({})
    hosts.updateClients.mockResolvedValue({ error: 'The host disconnected.' })
    await expect(bridge.updateClients(update)).resolves.toEqual({ error: 'The host disconnected.' })
    await expect(bridge.signIn(read)).resolves.toEqual(view)
    expect(hosts.providerAction).toHaveBeenCalledWith(action)
    expect(hosts.updateClients).toHaveBeenCalledWith(update)
    expect(hosts.signIn).toHaveBeenCalledWith(read)
    hosts.signIn.mockResolvedValue(null)
    await expect(bridge.signIn({ ...read, type: 'cancel' })).resolves.toBeNull()
    close()
    for (const channel of [HOSTS_PROVIDER_ACTION, HOSTS_UPDATE_CLIENTS, HOSTS_SIGN_IN]) expect(handlers.has(channel)).toBe(false)
  })

  it('rejects invalid requests, extra arguments and other windows before calling the host', async () => {
    const { invoke, widgetEvent, hosts } = register()
    for (const [channel, request] of [[HOSTS_PROVIDER_ACTION, action], [HOSTS_UPDATE_CLIENTS, update], [HOSTS_SIGN_IN, read]] as const) {
      await expect(invoke(channel, [{ ...request, extra: 'unread' }])).rejects.toThrow()
      await expect(invoke(channel, [request, 'extra'])).rejects.toThrow()
      await expect(invoke(channel, [request], widgetEvent)).rejects.toThrow('Open Hosts in the main Sotto window.')
    }
    expect(hosts.providerAction).not.toHaveBeenCalled()
    expect(hosts.updateClients).not.toHaveBeenCalled()
    expect(hosts.signIn).not.toHaveBeenCalled()
  })

  it('rejects service replies with extra content before they leave main', async () => {
    const { invoke, hosts } = register()
    hosts.providerAction.mockResolvedValue({ error: 42 })
    hosts.updateClients.mockResolvedValue({ key: 'made-up-fixture-key' })
    const withPage = { ...view, url: 'https://auth.openai.com/codex/device' }
    hosts.signIn.mockResolvedValue(withPage)
    await expect(invoke(HOSTS_PROVIDER_ACTION, [action])).rejects.toThrow()
    await expect(invoke(HOSTS_UPDATE_CLIENTS, [update])).rejects.toThrow()
    await expect(invoke(HOSTS_SIGN_IN, [read])).rejects.toThrow()
  })

  it('also rejects malformed wire replies in preload', async () => {
    const { bridge, renderer } = register()
    renderer.invoke.mockResolvedValue({ error: 42 })
    await expect(bridge.providerAction(action)).rejects.toThrow()
    renderer.invoke.mockResolvedValue({ extra: 'unread' })
    await expect(bridge.updateClients(update)).rejects.toThrow()
    renderer.invoke.mockResolvedValue({ ...view, url: 'https://auth.openai.com/codex/device' })
    await expect(bridge.signIn(read)).rejects.toThrow()
    renderer.invoke.mockResolvedValue({ ...view, stage: 'unknown' })
    await expect(bridge.signIn(read)).rejects.toThrow()
  })
})
