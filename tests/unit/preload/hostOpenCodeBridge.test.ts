// @vitest-environment node
import { preloadElectron } from '../../fixtures/preloadElectron'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', async () => (await import('../../fixtures/preloadElectron')).preloadElectron())
import { createSottoBridge } from '../../../src/preload'
import { HOSTS_OPENCODE_SIGN_IN } from '../../../src/shared/hostProviders'

const HOST = '22222222-2222-4222-8222-222222222222'
// Made up for this test; no real key ever goes near a fixture.
const KEY = 'sk-host-fixture-made-up-key-41c9e0'

describe('a host’s OpenCode sign-in through the preload (#1107)', () => {
  it('is there only while OpenCode is not held, whether or not this computer runs its local host', () => {
    const ipc = preloadElectron().ipcRenderer
    expect(createSottoBridge(ipc, 'win32').hosts!.opencodeSignIn).toBeUndefined()
    // This computer's own OpenCode bridge needs its local host; a host's does not.
    const bridge = createSottoBridge(ipc, 'win32', false, false, false, false, false, true)
    expect(bridge.opencode).toBeUndefined()
    expect(typeof bridge.hosts!.opencodeSignIn).toBe('function')
  })

  it('sends a call the window may make to main, and refuses one it may not before anything is sent', async () => {
    const ipc = preloadElectron().ipcRenderer
    ipc.invoke.mockResolvedValue({ status: 'ok', sources: { status: 'ok', zenModels: 2, sources: [] } })
    const hosts = createSottoBridge(ipc, 'win32', false, false, false, false, false, true).hosts!
    await expect(hosts.opencodeSignIn!({ id: HOST, call: { action: 'key', request: { sourceId: 'anthropic', key: KEY } } }))
      .resolves.toEqual({ status: 'ok', sources: { status: 'ok', zenModels: 2, sources: [] } })
    expect(ipc.invoke).toHaveBeenCalledWith(HOSTS_OPENCODE_SIGN_IN, { id: HOST, call: { action: 'key', request: { sourceId: 'anthropic', key: KEY } } })
    ipc.invoke.mockClear()
    // The window never asks a host for a page's address: main opens it.
    expect(() => hosts.opencodeSignIn!({ id: HOST, call: { action: 'page', request: { attemptId: 'con_1' } } } as never)).toThrow()
    expect(ipc.invoke).not.toHaveBeenCalled()
  })

  it('reads each answer against its call’s own schema, so an answer that carries anything more is refused', async () => {
    const ipc = preloadElectron().ipcRenderer
    const hosts = createSottoBridge(ipc, 'win32', false, false, false, false, false, true).hosts!
    ipc.invoke.mockResolvedValue({ status: 'ok', sources: { status: 'ok', zenModels: 2, sources: [] }, key: KEY })
    await expect(hosts.opencodeSignIn!({ id: HOST, call: { action: 'key', request: { sourceId: 'anthropic', key: KEY } } })).rejects.toThrow()
    ipc.invoke.mockResolvedValue({ status: 'not-opened', message: 'Your browser did not open the sign-in page.', address: 'https://sign-in.fixture.invalid/xai' })
    await expect(hosts.opencodeSignIn!({ id: HOST, call: { action: 'reopen', request: { attemptId: 'con_1' } } })).resolves.toMatchObject({ status: 'not-opened' })
    ipc.invoke.mockResolvedValue({ status: 'not-opened', message: 'Your browser did not open the sign-in page.', address: 'http://sign-in.fixture.invalid/xai' })
    await expect(hosts.opencodeSignIn!({ id: HOST, call: { action: 'reopen', request: { attemptId: 'con_1' } } })).rejects.toThrow()
  })
})
