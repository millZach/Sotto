// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', async () => (await import('../../fixtures/preloadElectron')).preloadElectron())
import { ProviderSignInRefusal } from '../../../src/host/providerSignIn'
import type { LocalProviderSignIn } from '../../../src/main/agents/localProviderSignIn'
import { registerLocalProviderSignInIpc } from '../../../src/main/agents/localProviderSignInIpc'
import { createSottoBridge } from '../../../src/preload'
import type { ProviderSignInView } from '../../../src/shared/hostProviders'
import { LOCAL_PROVIDER_SIGN_IN } from '../../../src/shared/localProviderSignIn'
import { ipcRegistry } from '../../fixtures/ipcHarness'
import { preloadElectron } from '../../fixtures/preloadElectron'

const SIGN_IN = '33333333-3333-4333-8333-333333333333'
const read = { type: 'read', signInId: SIGN_IN } as const
const view: ProviderSignInView = { id: SIGN_IN, provider: 'codex', shape: 'device-code', stage: 'waiting', code: 'TEST-CODE', page: 'auth.openai.com', expiresInMinutes: 15 }

function register() {
  const registry = ipcRegistry()
  const signIn = { request: vi.fn(async (): Promise<ProviderSignInView | null> => view), close: vi.fn() }
  const close = registerLocalProviderSignInIpc(registry.ipc, signIn as unknown as LocalProviderSignIn, registry.trustedSenders)
  const renderer = preloadElectron().ipcRenderer
  renderer.invoke.mockImplementation((channel: string, ...args: unknown[]) => registry.invoke(channel, args))
  return { ...registry, signIn, close, bridge: createSottoBridge(renderer, 'win32').providerSignIn! }
}

describe('this computer’s provider sign-in, from the window through preload to main (ADR-0200)', () => {
  it('carries a start, a read and a cancel, and stops every sign-in when it closes', async () => {
    const { bridge, signIn, close, handlers } = register()
    await expect(bridge.signIn({ type: 'start', provider: 'claude' })).resolves.toEqual(view)
    await expect(bridge.signIn(read)).resolves.toEqual(view)
    expect(signIn.request).toHaveBeenNthCalledWith(1, { type: 'start', provider: 'claude' })
    signIn.request.mockResolvedValue(null)
    await expect(bridge.signIn({ type: 'cancel', signInId: SIGN_IN })).resolves.toBeNull()
    close()
    expect(handlers.has(LOCAL_PROVIDER_SIGN_IN)).toBe(false)
    expect(signIn.close).toHaveBeenCalledTimes(1)
  })

  it('takes requests only from the main window, only for providers it signs in, and nothing extra', async () => {
    const { invoke, widgetEvent, signIn } = register()
    await expect(invoke(LOCAL_PROVIDER_SIGN_IN, [read], widgetEvent)).rejects.toThrow('Sign a provider in from the main Sotto window.')
    await expect(invoke(LOCAL_PROVIDER_SIGN_IN, [{ ...read, extra: 'unread' }])).rejects.toThrow('That sign-in is not available right now.')
    await expect(invoke(LOCAL_PROVIDER_SIGN_IN, [read, 'extra'])).rejects.toThrow('That sign-in is not available right now.')
    await expect(invoke(LOCAL_PROVIDER_SIGN_IN, [{ type: 'start', provider: 'devin' }])).rejects.toThrow('That sign-in is not available right now.')
    expect(signIn.request).not.toHaveBeenCalled()
  })

  it('shows a refusal’s own sentence, and nothing of any other failure or of the page’s address', async () => {
    const { invoke, signIn } = register()
    signIn.request.mockRejectedValueOnce(new ProviderSignInRefusal('Codex is not installed on this computer, so it cannot sign in. Nothing was changed.'))
    await expect(invoke(LOCAL_PROVIDER_SIGN_IN, [read])).rejects.toThrow('Codex is not installed on this computer, so it cannot sign in. Nothing was changed.')
    signIn.request.mockRejectedValueOnce(new Error('spawn /home/someone/.local/bin/codex ENOENT'))
    await expect(invoke(LOCAL_PROVIDER_SIGN_IN, [read])).rejects.toThrow(/^That sign-in is not available right now\. Nothing was changed\.$/u)
    signIn.request.mockResolvedValueOnce({ ...view, url: 'https://auth.openai.com/codex/device' } as ProviderSignInView)
    await expect(invoke(LOCAL_PROVIDER_SIGN_IN, [read])).rejects.toThrow(/^That sign-in is not available right now\. Nothing was changed\.$/u)
  })
})
