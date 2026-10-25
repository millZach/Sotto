// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { registerHostsIpc } from '../../../src/main/hosts/ipc'
import type { DesktopHosts } from '../../../src/main/hosts/desktopHosts'
import { HOSTS_OPENCODE_SIGN_IN } from '../../../src/shared/hostProviders'
import { ipcRegistry } from '../../fixtures/ipcHarness'

const HOST = '22222222-2222-4222-8222-222222222222'
// Made up for this test; no real key ever goes near a fixture.
const KEY = 'sk-host-fixture-made-up-key-41c9e0'
function register(opencode: boolean) {
  const registry = ipcRegistry()
  const opencodeSignIn = vi.fn(async () => ({ status: 'ok', sources: { status: 'ok', zenModels: 0, sources: [] } }))
  const hosts = { get: vi.fn(), command: vi.fn(), providerAction: vi.fn(), updateClients: vi.fn(), signIn: vi.fn(), opencodeSignIn, subscribe: () => () => undefined } as unknown as DesktopHosts
  const tailscale = { devices: vi.fn(), status: vi.fn(), connect: vi.fn(), openDownload: vi.fn(), dispose: vi.fn() }
  const close = registerHostsIpc(registry.ipc, hosts, registry.trustedSenders, () => undefined, tailscale, { opencode })
  return { ...registry, opencodeSignIn, close }
}

describe('a host’s OpenCode sign-in from the window (#1107)', () => {
  it('goes to the host it names, and is not there at all while OpenCode is held', async () => {
    const held = register(false)
    expect(held.handlers.has(HOSTS_OPENCODE_SIGN_IN)).toBe(false)
    held.close()
    const { invoke, opencodeSignIn, handlers, close } = register(true)
    const request = { id: HOST, call: { action: 'key', request: { sourceId: 'anthropic', key: KEY } } }
    expect(await invoke(HOSTS_OPENCODE_SIGN_IN, [request])).toMatchObject({ status: 'ok' })
    expect(opencodeSignIn).toHaveBeenCalledWith(request)
    close()
    expect(handlers.has(HOSTS_OPENCODE_SIGN_IN)).toBe(false)
  })

  it('refuses a request it cannot read before anything reaches a host, and echoes nothing it was sent', async () => {
    const { invoke, opencodeSignIn, widgetEvent } = register(true)
    const answer = await invoke(HOSTS_OPENCODE_SIGN_IN, [{ id: HOST, call: { action: 'key', request: { sourceId: 'anthropic', key: KEY } }, extra: KEY }])
    expect(answer).toMatchObject({ status: 'refused' })
    expect(JSON.stringify(answer)).not.toContain(KEY)
    // The window may not ask a host for a page's address; main opens it.
    expect(await invoke(HOSTS_OPENCODE_SIGN_IN, [{ id: HOST, call: { action: 'page', request: { attemptId: 'con_1' } } }])).toMatchObject({ status: 'refused' })
    expect(opencodeSignIn).not.toHaveBeenCalled()
    // Only the main window asks.
    await expect(invoke(HOSTS_OPENCODE_SIGN_IN, [{ id: HOST, call: { action: 'sources' } }], widgetEvent)).rejects.toThrow('Open Hosts in the main Sotto window.')
  })
})
