// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', async () => (await import('../../../fixtures/preloadElectron')).preloadElectron())
import { registerPluginsIpc } from '../../../../src/main/plugins/ipc'
import { createSottoBridge } from '../../../../src/preload'
import { PLUGINS_GITHUB_SIGN_IN, type GitHubSignIn } from '../../../../src/shared/plugins'
import { ipcRegistry } from '../../../fixtures/ipcHarness'
import { preloadElectron } from '../../../fixtures/preloadElectron'

function register(answer: GitHubSignIn = { state: 'signed-in', login: 'example-user' }) {
  const registry = ipcRegistry()
  const gitHubSignIn = vi.fn(async (): Promise<GitHubSignIn> => answer)
  const close = registerPluginsIpc(registry.ipc, { gitHubSignIn }, registry.trustedSenders)
  const renderer = preloadElectron().ipcRenderer
  renderer.invoke.mockImplementation((channel: string, ...args: unknown[]) => registry.invoke(channel, args))
  return { ...registry, gitHubSignIn, close, bridge: createSottoBridge(renderer, 'win32').plugins! }
}

describe('Settings › Plugins, from the window through preload to main (ADR-0205)', () => {
  it('carries gh’s sign-in to the window and answers nothing once closed', async () => {
    const { bridge, close, handlers } = register()
    await expect(bridge.gitHubSignIn()).resolves.toEqual({ state: 'signed-in', login: 'example-user' })
    close()
    expect(handlers.has(PLUGINS_GITHUB_SIGN_IN)).toBe(false)
  })

  it('answers the main window only, and takes no arguments', async () => {
    const { invoke, widgetEvent, gitHubSignIn } = register()
    await expect(invoke(PLUGINS_GITHUB_SIGN_IN, [], widgetEvent)).rejects.toThrow('Open Settings in the main Sotto window.')
    await expect(invoke(PLUGINS_GITHUB_SIGN_IN, ['extra'])).rejects.toThrow()
    expect(gitHubSignIn).not.toHaveBeenCalled()
  })

  it('sends back only what the schema names, so nothing gh said beside the account’s name can cross', async () => {
    const { invoke } = register({ state: 'signed-in', login: 'example-user', token: 'made-up-value' } as GitHubSignIn)
    await expect(invoke(PLUGINS_GITHUB_SIGN_IN, [])).rejects.toThrow()
  })
})
