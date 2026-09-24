// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { registerToolsIpc } from '../../../src/main/tools/ipc'
import { createToolsBridges } from '../../../src/preload/tools'
import { safeBrowserUrl } from '../../../src/shared/browser'
import type { IpcInvocationEvent } from '../../../src/main/ipc/registerIpc'

describe('tools IPC and preload boundary', () => {
  it('requires exact trusted main WebContents, exact mainFrame, URL and one argument for every method', () => {
    const operation = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    const make = (methods: string[]) => Object.fromEntries([...methods.map(method => [method, operation]), ['dispose', vi.fn()]])
    const services = { terminal: make(['list', 'create', 'read', 'write', 'resize', 'interrupt', 'close', 'reopen']), browser: make(['list', 'create', 'navigate', 'back', 'forward', 'reload', 'close', 'mount', 'openLink', 'tasks', 'share', 'controlTask', 'answerAction', 'revokePageOpening', 'viewport', 'capture']), gitChanges: make(['list', 'review', 'copyPath', 'reveal', 'watch', 'checkpoints', 'inspectCheckpoint', 'revertCheckpoint', 'recoverCheckpoint', 'reviewPullRequest', 'draftPullRequestText', 'actPullRequest']) } as unknown as Parameters<typeof registerToolsIpc>[1]
    const handlers = new Map<string, (event: IpcInvocationEvent, ...args: unknown[]) => unknown>()
    const url = 'file:///main.html', mainFrame = { parent: null, url }, sender = { mainFrame, getURL: () => url, isDestroyed: () => false }
    const cleanup = registerToolsIpc({ handle: (channel, fn) => { handlers.set(channel, fn) }, removeHandler: channel => { handlers.delete(channel) } }, services, () => [{ role: 'main', url, webContents: sender }])
    expect(handlers.size).toBe(36)
    for (const handler of handlers.values()) {
      for (const event of [{ sender: { ...sender }, senderFrame: mainFrame }, { sender, senderFrame: { ...mainFrame } }, { sender, senderFrame: { parent: {}, url } }, { sender, senderFrame: null }]) expect(() => handler(event, {})).toThrow('TOOLS_MAIN_WINDOW_REQUIRED')
      expect(() => handler({ sender, senderFrame: mainFrame }, {}, {})).toThrow()
      handler({ sender, senderFrame: mainFrame }, {})
    }
    expect(operation).toHaveBeenCalledTimes(36)
    sender.getURL = () => 'https://example.invalid'
    for (const handler of handlers.values()) expect(() => handler({ sender, senderFrame: mainFrame }, {})).toThrow('TOOLS_MAIN_WINDOW_REQUIRED')
    cleanup(); expect(handlers.size).toBe(0)
  })
  it('rejects invalid browser grants and actions before crossing the bridge', async () => {
    const invoke = vi.fn()
    const { browser } = createToolsBridges({ invoke, on: vi.fn(), removeListener: vi.fn() })
    const page = { threadId: 'thread', workspaceId: 'a'.repeat(64), pageId: 'f6a804fd-77c9-497c-bc16-ce0d0a7b7a59' }
    await expect(browser.share({ ...page, enabled: 'yes' } as never)).rejects.toThrow()
    await expect(browser.answerAction({ ...page, taskId: page.pageId, actionId: page.pageId, allow: 'true' } as never)).rejects.toThrow()
    await expect(browser.answerAction({ ...page, taskId: page.pageId, actionId: page.pageId, allow: true, forThread: 'yes' } as never)).rejects.toThrow()
    await expect(browser.revokePageOpening({ threadId: 'thread' } as never)).rejects.toThrow()
    await expect(browser.viewport({ ...page, width: 0, height: 800 })).rejects.toThrow()
    await expect(browser.capture({ ...page, point: { x: -1, y: 0 } })).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
    invoke.mockResolvedValue({ ok: false, error: { code: 'blocked', message: 'The page is no longer shared.' } })
    await browser.share({ ...page, enabled: false })
    expect(invoke).toHaveBeenLastCalledWith('sotto:browser:share', { ...page, enabled: false })
    await browser.answerAction({ ...page, taskId: page.pageId, actionId: page.pageId, allow: false })
    expect(invoke).toHaveBeenLastCalledWith('sotto:browser:answerAction', { ...page, taskId: page.pageId, actionId: page.pageId, allow: false })
    await browser.answerAction({ ...page, taskId: page.pageId, actionId: page.pageId, allow: true, forThread: true })
    expect(invoke).toHaveBeenLastCalledWith('sotto:browser:answerAction', { ...page, taskId: page.pageId, actionId: page.pageId, allow: true, forThread: true })
    invoke.mockResolvedValue({ ok: true, value: undefined })
    await browser.revokePageOpening({ threadId: 'thread', workspaceId: page.workspaceId })
    expect(invoke).toHaveBeenLastCalledWith('sotto:browser:revokePageOpening', { threadId: 'thread', workspaceId: page.workspaceId })
  })
  it('validates comparisons and explicit checkpoint confirmation before crossing IPC, and offers no staging, commit or branch call', async () => {
    const rejected = { ok: false as const, error: { code: 'blocked' as const, message: 'A native operation is pending.' } }
    const invoke = vi.fn().mockResolvedValue(rejected)
    const { gitChanges } = createToolsBridges({ invoke, on: vi.fn(), removeListener: vi.fn() })
    const target = { threadId: 'selected-thread', workspaceId: 'a'.repeat(64) }
    const checkpoint = { ...target, checkpointId: 'f6a804fd-77c9-497c-bc16-ce0d0a7b7a59' }
    // Staging left the UI with the Changes rebuild; commit and branch are the Git action's (ADR-0027).
    for (const retired of ['act', 'draftCommitMessage', 'branches', 'diff']) expect(retired in gitChanges).toBe(false)
    await expect(gitChanges.review({ ...target, scope: { kind: 'branch', base: '--output=/tmp/x' } })).rejects.toThrow()
    await expect(gitChanges.review({ ...target, scope: { kind: 'branch', base: 'main..HEAD' } })).rejects.toThrow()
    await expect(gitChanges.review({ ...target, scope: { kind: 'staged' } } as never)).rejects.toThrow()
    await expect(gitChanges.copyPath({ ...target, path: '../outside' })).rejects.toThrow()
    await expect(gitChanges.revertCheckpoint!({ ...checkpoint, confirmed: false } as never)).rejects.toThrow()
    await expect(gitChanges.revertCheckpoint!(checkpoint as never)).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
    const branch = { ...target, scope: { kind: 'branch' as const, base: 'origin/main' }, ignoreWhitespace: true }
    expect(await gitChanges.review(branch)).toEqual(rejected)
    expect(invoke).toHaveBeenLastCalledWith('sotto:git-changes:review', branch)
    expect(await gitChanges.checkpoints!(target)).toEqual(rejected)
    expect(invoke).toHaveBeenLastCalledWith('sotto:git-changes:checkpoints', target)
    expect(await gitChanges.inspectCheckpoint!(checkpoint)).toEqual(rejected)
    expect(invoke).toHaveBeenLastCalledWith('sotto:git-changes:inspectCheckpoint', checkpoint)
    expect(await gitChanges.revertCheckpoint!({ ...checkpoint, confirmed: true })).toEqual(rejected)
    expect(invoke).toHaveBeenLastCalledWith('sotto:git-changes:revertCheckpoint', { ...checkpoint, confirmed: true })
    expect(await gitChanges.recoverCheckpoint!(checkpoint)).toEqual(rejected)
    expect(invoke).toHaveBeenLastCalledWith('sotto:git-changes:recoverCheckpoint', checkpoint)
  })
  it('requires a reviewed working copy before publishing and retains recoverable publication errors', async () => {
    const rejected = { ok: false as const, error: { code: 'workspace-changed' as const, message: 'Review the changed remote again.' } }
    const invoke = vi.fn().mockResolvedValue(rejected)
    const { gitChanges } = createToolsBridges({ invoke, on: vi.fn(), removeListener: vi.fn() })
    const target = { threadId: 'selected-thread', workspaceId: 'a'.repeat(64) }
    await expect(gitChanges.actPullRequest!({ ...target, remote: 'origin', revision: '', action: 'push' })).rejects.toThrow()
    await expect(gitChanges.actPullRequest!({ threadId: target.threadId, remote: 'origin', revision: 'reviewed', action: 'push' } as never)).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
    expect(await gitChanges.reviewPullRequest!({ ...target, remote: 'origin' })).toEqual(rejected)
    expect(invoke).toHaveBeenLastCalledWith('sotto:git-changes:reviewPullRequest', { ...target, remote: 'origin' })
    const action = { ...target, remote: 'origin', revision: 'reviewed', action: 'push' as const }
    expect(await gitChanges.actPullRequest!(action)).toEqual(rejected)
    expect(invoke).toHaveBeenLastCalledWith('sotto:git-changes:actPullRequest', action)
  })
  it('rejects malformed payloads before invoke and drops malformed events without exposing Electron events', async () => {
    const invoke = vi.fn(), listeners = new Map<string, (...args: unknown[]) => void>()
    const bridges = createToolsBridges({ invoke, on: (channel, fn) => listeners.set(channel, fn), removeListener: channel => listeners.delete(channel) })
    await expect(bridges.browser.openLink({ url: 'file:///C:/secret' })).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
    const listener = vi.fn(), unsubscribe = bridges.terminal.onEvent(listener)
    const dispatch = [...listeners.values()][0]!
    dispatch({ privileged: true }, { type: 'output', data: 'bad' })
    expect(listener).not.toHaveBeenCalled()
    unsubscribe(); expect(listeners.size).toBe(0)
  })
  it('canonicalizes browser display URLs and rejects executable schemes, credentials, parser stripping and bidi spoofing', () => {
    for (const value of ['javascript:alert(1)', 'data:text/html,bad', 'file:///c:/foo', 'https://user:pass@example.com', 'https://example.com\n', 'https://example.com/\u202eevil']) expect(safeBrowserUrl(value)).toBeNull()
    expect(safeBrowserUrl('https://EXAMPLE.com')).toBe('https://example.com/')
    expect(safeBrowserUrl('http://127.0.0.1:5000')).toBe('http://127.0.0.1:5000/')
  })
})
