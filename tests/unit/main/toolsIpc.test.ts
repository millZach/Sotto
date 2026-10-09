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
    const services = { terminal: make(['list', 'create', 'read', 'write', 'resize', 'interrupt', 'close', 'reopen', 'pasteImage']), browser: make(['list', 'create', 'navigate', 'back', 'forward', 'reload', 'close', 'mount', 'openLink', 'tasks', 'share', 'controlTask', 'answerAction', 'stopGrant', 'viewport', 'capture']), gitChanges: make(['list', 'review', 'copyPath', 'reveal', 'watch', 'checkpoints', 'inspectCheckpoint', 'revertCheckpoint', 'recoverCheckpoint']) } as unknown as Parameters<typeof registerToolsIpc>[1]
    const handlers = new Map<string, (event: IpcInvocationEvent, ...args: unknown[]) => unknown>()
    const url = 'file:///main.html', mainFrame = { parent: null, url }, sender = { mainFrame, getURL: () => url, isDestroyed: () => false }
    const cleanup = registerToolsIpc({ handle: (channel, fn) => { handlers.set(channel, fn) }, removeHandler: channel => { handlers.delete(channel) } }, services, () => [{ role: 'main', url, webContents: sender }])
    expect(handlers.size).toBe(35)
    for (const [channel, handler] of handlers) {
      for (const event of [{ sender: { ...sender }, senderFrame: mainFrame }, { sender, senderFrame: { ...mainFrame } }, { sender, senderFrame: { parent: {}, url } }, { sender, senderFrame: null }]) expect(() => handler(event, {})).toThrow('TOOLS_MAIN_WINDOW_REQUIRED')
      expect(() => handler({ sender, senderFrame: mainFrame }, {}, {})).toThrow()
      handler({ sender, senderFrame: mainFrame }, channel === 'sotto:terminal:focus' ? false : {})
    }
    expect(operation).toHaveBeenCalledTimes(34)
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
    await expect(browser.stopGrant({ threadId: 'thread' } as never)).rejects.toThrow()
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
    await browser.stopGrant({ threadId: 'thread', workspaceId: page.workspaceId })
    expect(invoke).toHaveBeenLastCalledWith('sotto:browser:stopGrant', { threadId: 'thread', workspaceId: page.workspaceId })
  })
  it('validates terminal focus and image paste before invoking main', async () => {
    const invoke = vi.fn(async () => ({ ok: true, value: undefined }))
    const { terminal } = createToolsBridges({ invoke, on: vi.fn(), removeListener: vi.fn() })
    const target = { threadId: 'thread', workspaceId: 'a'.repeat(64), sessionId: 'f6a804fd-77c9-497c-bc16-ce0d0a7b7a59' }
    await expect(terminal.setFocused!('yes' as never)).rejects.toThrow()
    await expect(terminal.pasteImage({ ...target, dataUrl: 'x'.repeat(14_000_001) })).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
    await terminal.setFocused!(true)
    expect(invoke).toHaveBeenLastCalledWith('sotto:terminal:focus', true)
    await terminal.pasteImage({ ...target, dataUrl: 'data:image/png;base64,AAAA' })
    expect(invoke).toHaveBeenLastCalledWith('sotto:terminal:pasteImage', { ...target, dataUrl: 'data:image/png;base64,AAAA' })
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
  it('sends a paired host\'s thread to that host for the change list, comparisons and Copy path, and refuses the rest in words (ADR-0025, October 5 amendment)', async () => {
    const local = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    const make = (methods: string[]) => Object.fromEntries([...methods.map(method => [method, local]), ['dispose', vi.fn()]])
    const answer = { ok: true as const, value: { from: 'host' } }
    const hostedGitChanges = { list: vi.fn().mockResolvedValue(answer), review: vi.fn().mockResolvedValue(answer), copyPath: vi.fn().mockResolvedValue(answer) }
    const services = { terminal: make(['list', 'create', 'read', 'write', 'resize', 'interrupt', 'close', 'reopen', 'pasteImage']), browser: make(['list', 'create', 'navigate', 'back', 'forward', 'reload', 'close', 'mount', 'openLink', 'tasks', 'share', 'controlTask', 'answerAction', 'stopGrant', 'viewport', 'capture']),
      gitChanges: make(['list', 'review', 'copyPath', 'reveal', 'watch', 'checkpoints', 'inspectCheckpoint', 'revertCheckpoint', 'recoverCheckpoint']), hostedGitChanges } as unknown as Parameters<typeof registerToolsIpc>[1]
    const handlers = new Map<string, (event: IpcInvocationEvent, ...args: unknown[]) => unknown>()
    const url = 'file:///main.html', mainFrame = { parent: null, url }, sender = { mainFrame, getURL: () => url, isDestroyed: () => false }
    const cleanup = registerToolsIpc({ handle: (channel, fn) => { handlers.set(channel, fn) }, removeHandler: channel => { handlers.delete(channel) } }, services, () => [{ role: 'main', url, webContents: sender }])
    const call = (method: string, payload: unknown) => handlers.get(`sotto:git-changes:${method}`)!({ sender, senderFrame: mainFrame }, payload)
    const target = { threadId: 'host:22222222-2222-4222-8222-222222222222:thread', workspaceId: 'a'.repeat(64) }
    await expect(call('list', target)).resolves.toBe(answer)
    await expect(call('review', { ...target, scope: { kind: 'branch', base: null } })).resolves.toBe(answer)
    await expect(call('copyPath', { ...target, path: 'src/a.ts' })).resolves.toBe(answer)
    expect(hostedGitChanges.review).toHaveBeenCalledWith({ ...target, scope: { kind: 'branch', base: null } })
    // Checked as this computer's thread would be, before anything reaches the host.
    await expect(call('review', { ...target, scope: { kind: 'branch', base: '--output=/tmp/x' } })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    await expect(call('reveal', { ...target, path: 'src/a.ts' })).resolves.toMatchObject({ ok: false, error: { code: 'unavailable', message: expect.stringContaining('on the host machine') } })
    await expect(call('watch', { ...target, enabled: true })).resolves.toMatchObject({ ok: false, error: { code: 'unavailable' } })
    for (const method of ['checkpoints', 'inspectCheckpoint', 'revertCheckpoint', 'recoverCheckpoint']) await expect(call(method, target)).resolves.toMatchObject({ ok: false, error: { code: 'unavailable', message: 'Turn checkpoints are kept only for threads on this computer. Nothing was changed.' } })
    expect(hostedGitChanges.review).toHaveBeenCalledOnce()
    expect(local).not.toHaveBeenCalled()
    // This computer's own thread is read here, as before.
    await call('list', { threadId: 'thread' })
    expect(local).toHaveBeenCalledWith({ threadId: 'thread' })
    cleanup()
  })
})
