// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', async () => (await import('../../../fixtures/preloadElectron')).preloadElectron())
import { registerPluginsIpc } from '../../../../src/main/plugins/ipc'
import { createSottoBridge } from '../../../../src/preload'
import { PLUGINS_GITHUB_SIGN_IN, PLUGINS_RECENT_USE, type GitHubSignIn, type ShownPluginUse } from '../../../../src/shared/plugins'
import { ipcRegistry } from '../../../fixtures/ipcHarness'
import { preloadElectron } from '../../../fixtures/preloadElectron'

const used: ShownPluginUse = { id: '11111111-1111-4111-8111-111111111111', at: '2026-11-12T08:00:00.000Z', threadId: 'thread-one', plugin: 'github', tool: 'plugin_read', kind: 'issues', outcome: 'done', threadTitle: 'Fix the preview build' }

function register(answer: GitHubSignIn = { state: 'signed-in', login: 'example-user' }, uses: readonly ShownPluginUse[] = [used]) {
  const registry = ipcRegistry()
  const gitHubSignIn = vi.fn(async (): Promise<GitHubSignIn> => answer)
  const recentUse = vi.fn(async () => uses)
  const close = registerPluginsIpc(registry.ipc, { gitHubSignIn, recentUse }, registry.trustedSenders)
  const renderer = preloadElectron().ipcRenderer
  renderer.invoke.mockImplementation((channel: string, ...args: unknown[]) => registry.invoke(channel, args))
  return { ...registry, gitHubSignIn, recentUse, close, bridge: createSottoBridge(renderer, 'win32').plugins! }
}

describe('Settings › Plugins, from the window through preload to main (ADR-0205)', () => {
  it('carries gh’s sign-in to the window and answers nothing once closed', async () => {
    const { bridge, close, handlers } = register()
    await expect(bridge.gitHubSignIn()).resolves.toEqual({ state: 'signed-in', login: 'example-user' })
    await expect(bridge.recentUse()).resolves.toEqual([used])
    close()
    expect(handlers.has(PLUGINS_GITHUB_SIGN_IN)).toBe(false)
    expect(handlers.has(PLUGINS_RECENT_USE)).toBe(false)
  })

  it('answers the main window only, and takes no arguments', async () => {
    const { invoke, widgetEvent, gitHubSignIn } = register()
    await expect(invoke(PLUGINS_GITHUB_SIGN_IN, [], widgetEvent)).rejects.toThrow('Open Settings in the main Sotto window.')
    await expect(invoke(PLUGINS_GITHUB_SIGN_IN, ['extra'])).rejects.toThrow()
    expect(gitHubSignIn).not.toHaveBeenCalled()
    const { invoke: again, widgetEvent: widget, recentUse } = register()
    await expect(again(PLUGINS_RECENT_USE, [], widget)).rejects.toThrow('Open Settings in the main Sotto window.')
    await expect(again(PLUGINS_RECENT_USE, ['extra'])).rejects.toThrow()
    expect(recentUse).not.toHaveBeenCalled()
  })

  it('sends back only what the schema names, so nothing gh said beside the account’s name can cross', async () => {
    const { invoke } = register({ state: 'signed-in', login: 'example-user', token: 'made-up-value' } as GitHubSignIn)
    await expect(invoke(PLUGINS_GITHUB_SIGN_IN, [])).rejects.toThrow()
    // A use that carried anything beside what the record names, such as what a read returned, does not cross either.
    const { invoke: uses } = register(undefined, [{ ...used, body: 'something read' } as ShownPluginUse])
    await expect(uses(PLUGINS_RECENT_USE, [])).rejects.toThrow()
  })
})
