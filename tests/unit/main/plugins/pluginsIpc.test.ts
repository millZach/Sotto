// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', async () => (await import('../../../fixtures/preloadElectron')).preloadElectron())
import { registerPluginsIpc } from '../../../../src/main/plugins/ipc'
import { createSottoBridge } from '../../../../src/preload'
import {
  PLUGINS_ACCOUNT_ADD, PLUGINS_ACCOUNT_REMOVE, PLUGINS_ACCOUNT_REPLACE, PLUGINS_ACCOUNT_UPDATE, PLUGINS_ACCOUNTS, PLUGINS_GITHUB_SIGN_IN, PLUGINS_PROJECTS, PLUGINS_RECENT_USE,
  type GitHubSignIn, type PluginAccount, type PluginAccountResult, type ShownPluginUse,
} from '../../../../src/shared/plugins'
import { ipcRegistry } from '../../../fixtures/ipcHarness'
import { preloadElectron } from '../../../fixtures/preloadElectron'

const used: ShownPluginUse = { id: '11111111-1111-4111-8111-111111111111', at: '2026-11-12T08:00:00.000Z', threadId: 'thread-one', plugin: 'github', tool: 'plugin_read', kind: 'issues', outcome: 'done', threadTitle: 'Fix the preview build' }

/** A made-up account and a made-up token: nothing here is a real credential. */
const account: PluginAccount = { id: '22222222-2222-4222-8222-000000000001', plugin: 'vercel', name: 'Work', savedAt: '2026-11-12T08:00:00.000Z', signedInAs: 'example-user', on: true, projects: null }
const TOKEN = 'made-up-vercel-token'

function register(answer: GitHubSignIn = { state: 'signed-in', login: 'example-user' }, uses: readonly ShownPluginUse[] = [used]) {
  const registry = ipcRegistry()
  const gitHubSignIn = vi.fn(async (): Promise<GitHubSignIn> => answer)
  const recentUse = vi.fn(async () => uses)
  const accounts = vi.fn(async (): Promise<PluginAccount[]> => [account])
  const saved: PluginAccountResult = { ok: true, accounts: [account] }
  const addAccount = vi.fn(async (): Promise<PluginAccountResult> => saved), replaceSecret = vi.fn(async (): Promise<PluginAccountResult> => saved)
  const removeAccount = vi.fn(async (): Promise<PluginAccountResult> => ({ ok: true, accounts: [] }))
  const updateAccount = vi.fn(async (): Promise<PluginAccountResult> => ({ ok: true, accounts: [{ ...account, on: false }] }))
  const projects = vi.fn(() => [{ id: 'p-sotto', title: 'Sotto', settled: false }])
  const close = registerPluginsIpc(registry.ipc, { gitHubSignIn, recentUse, accounts, addAccount, replaceSecret, removeAccount, updateAccount, projects }, registry.trustedSenders)
  const renderer = preloadElectron().ipcRenderer
  renderer.invoke.mockImplementation((channel: string, ...args: unknown[]) => registry.invoke(channel, args))
  return { ...registry, gitHubSignIn, recentUse, accounts, addAccount, replaceSecret, removeAccount, updateAccount, projects, close, bridge: createSottoBridge(renderer, 'win32').plugins! }
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
    // A thread's name may be as long as Sotto lets a thread be named, and still crosses.
    const { bridge: long } = register(undefined, [{ ...used, threadTitle: 'x'.repeat(512) }])
    await expect(long.recentUse()).resolves.toHaveLength(1)
    // A use that carried anything beside what the record names, such as what a read returned, does not cross either.
    const { invoke: uses } = register(undefined, [{ ...used, body: 'something read' } as ShownPluginUse])
    await expect(uses(PLUGINS_RECENT_USE, [])).rejects.toThrow()
  })

  it('carries an account’s secret to main once, and hands back accounts that hold none', async () => {
    const { bridge, addAccount, replaceSecret, removeAccount, close, handlers } = register()
    await expect(bridge.accounts()).resolves.toEqual([account])
    const added = await bridge.addAccount({ plugin: 'vercel', name: '  Work ', secret: TOKEN })
    expect(added).toEqual({ ok: true, accounts: [account] })
    expect(addAccount).toHaveBeenCalledWith({ plugin: 'vercel', name: 'Work', secret: TOKEN })
    expect(JSON.stringify(added)).not.toContain(TOKEN)
    await expect(bridge.replaceSecret({ id: account.id, secret: TOKEN })).resolves.toEqual({ ok: true, accounts: [account] })
    expect(replaceSecret).toHaveBeenCalledWith({ id: account.id, secret: TOKEN })
    await expect(bridge.removeAccount({ id: account.id })).resolves.toEqual({ ok: true, accounts: [] })
    expect(removeAccount).toHaveBeenCalledWith({ id: account.id })
    close()
    for (const channel of [PLUGINS_ACCOUNTS, PLUGINS_ACCOUNT_ADD, PLUGINS_ACCOUNT_REPLACE, PLUGINS_ACCOUNT_REMOVE]) expect(handlers.has(channel)).toBe(false)
  })

  it('takes account changes from the main window only, and never says back what it could not read', async () => {
    const { invoke, widgetEvent, addAccount, replaceSecret, removeAccount } = register()
    await expect(invoke(PLUGINS_ACCOUNT_ADD, [{ plugin: 'vercel', name: 'Work', secret: TOKEN }], widgetEvent)).rejects.toThrow('Open Settings in the main Sotto window.')
    await expect(invoke(PLUGINS_ACCOUNT_REMOVE, [{ id: account.id }], widgetEvent)).rejects.toThrow('Open Settings in the main Sotto window.')
    // A request with a part main does not know is turned away in fixed words, with nothing of the secret in them.
    const refused = await invoke(PLUGINS_ACCOUNT_ADD, [{ plugin: 'vercel', name: 'Work', secret: TOKEN, extra: true }]).catch((error: unknown) => String(error))
    expect(refused).toBe('Error: That could not be done. Nothing was changed.')
    await expect(invoke(PLUGINS_ACCOUNT_ADD, [{ plugin: 'github', name: 'Work', secret: TOKEN }])).rejects.toThrow(/^That could not be done\. Nothing was changed\.$/u)
    await expect(invoke(PLUGINS_ACCOUNT_REPLACE, [{ id: 'not-an-id', secret: TOKEN }])).rejects.toThrow(/^That could not be done\. Nothing was changed\.$/u)
    await expect(invoke(PLUGINS_ACCOUNT_ADD, [{ plugin: 'vercel', name: 'Work', secret: 'x'.repeat(1_001) }])).rejects.toThrow(/^That could not be done\. Nothing was changed\.$/u)
    expect(addAccount).not.toHaveBeenCalled()
    expect(replaceSecret).not.toHaveBeenCalled()
    expect(removeAccount).not.toHaveBeenCalled()
  })

  it('hands the window nothing of an account beyond what the schema names', async () => {
    const { invoke, accounts } = register()
    accounts.mockResolvedValueOnce([{ ...account, secret: TOKEN } as PluginAccount])
    await expect(invoke(PLUGINS_ACCOUNTS, [])).rejects.toThrow()
  })

  it('carries which threads may use an account to main, and this computer’s projects back, for the main window only', async () => {
    const { bridge, invoke, widgetEvent, updateAccount, projects, close, handlers } = register()
    await expect(bridge.updateAccount({ id: account.id, on: false })).resolves.toEqual({ ok: true, accounts: [{ ...account, on: false }] })
    expect(updateAccount).toHaveBeenCalledWith({ id: account.id, on: false })
    await bridge.updateAccount({ id: account.id, projects: ['p-sotto'] })
    await bridge.updateAccount({ id: account.id, projects: null })
    expect(updateAccount.mock.calls.map(call => (call as unknown[])[0])).toEqual([{ id: account.id, on: false }, { id: account.id, projects: ['p-sotto'] }, { id: account.id, projects: null }])
    await expect(bridge.projects()).resolves.toEqual([{ id: 'p-sotto', title: 'Sotto', settled: false }])
    updateAccount.mockClear()
    // A change that names nothing to change, no project at all, or anything else of the account, never reaches main.
    for (const bad of [{ id: account.id }, { id: account.id, projects: [] }, { id: account.id, on: false, name: 'Other' }, { id: 'not-an-id', on: false }, { id: account.id, on: 'no' }]) {
      await expect(invoke(PLUGINS_ACCOUNT_UPDATE, [bad]), JSON.stringify(bad)).rejects.toThrow('That could not be done. Nothing was changed.')
    }
    await expect(invoke(PLUGINS_ACCOUNT_UPDATE, [{ id: account.id, on: false }], widgetEvent)).rejects.toThrow('Open Settings in the main Sotto window.')
    await expect(invoke(PLUGINS_PROJECTS, [], widgetEvent)).rejects.toThrow('Open Settings in the main Sotto window.')
    expect(updateAccount).not.toHaveBeenCalled()
    // A project's folder is not something the page is told.
    projects.mockReturnValueOnce([{ id: 'p-sotto', title: 'Sotto', settled: false, path: 'C:/example/project' } as never])
    await expect(invoke(PLUGINS_PROJECTS, [])).rejects.toThrow()
    // With no projects to read, the page is told so rather than handed none.
    projects.mockImplementationOnce(() => { throw new Error('PLUGIN_PROJECTS_UNAVAILABLE') })
    await expect(bridge.projects()).rejects.toThrow()
    close()
    for (const channel of [PLUGINS_ACCOUNT_UPDATE, PLUGINS_PROJECTS]) expect(handlers.has(channel)).toBe(false)
  })
})
