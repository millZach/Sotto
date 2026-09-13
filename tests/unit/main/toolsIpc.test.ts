import { describe, expect, it, vi } from 'vitest'
import { registerToolsIpc } from '../../../src/main/tools/ipc'
import { createToolsBridges } from '../../../src/preload/tools'
import { safeBrowserUrl } from '../../../src/shared/browser'
import type { IpcInvocationEvent } from '../../../src/main/ipc/registerIpc'

describe('tools IPC and preload boundary', () => {
  it('requires exact trusted main WebContents, exact mainFrame, URL and one argument for every method', () => {
    const operation = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    const make = (methods: string[]) => Object.fromEntries([...methods.map(method => [method, operation]), ['dispose', vi.fn()]])
    const services = { terminal: make(['list', 'create', 'read', 'write', 'resize', 'interrupt', 'close', 'reopen']), browser: make(['list', 'create', 'navigate', 'back', 'forward', 'reload', 'close', 'mount', 'openLink']), gitChanges: make(['list', 'diff', 'copyPath', 'reveal', 'watch']) } as unknown as Parameters<typeof registerToolsIpc>[1]
    const handlers = new Map<string, (event: IpcInvocationEvent, ...args: unknown[]) => unknown>()
    const url = 'file:///main.html', mainFrame = { parent: null, url }, sender = { mainFrame, getURL: () => url, isDestroyed: () => false }
    const cleanup = registerToolsIpc({ handle: (channel, fn) => { handlers.set(channel, fn) }, removeHandler: channel => { handlers.delete(channel) } }, services, () => [{ role: 'main', url, webContents: sender }])
    expect(handlers.size).toBe(22)
    for (const handler of handlers.values()) {
      for (const event of [{ sender: { ...sender }, senderFrame: mainFrame }, { sender, senderFrame: { ...mainFrame } }, { sender, senderFrame: { parent: {}, url } }, { sender, senderFrame: null }]) expect(() => handler(event, {})).toThrow('TOOLS_MAIN_WINDOW_REQUIRED')
      expect(() => handler({ sender, senderFrame: mainFrame }, {}, {})).toThrow()
      handler({ sender, senderFrame: mainFrame }, {})
    }
    expect(operation).toHaveBeenCalledTimes(22)
    sender.getURL = () => 'https://example.invalid'
    for (const handler of handlers.values()) expect(() => handler({ sender, senderFrame: mainFrame }, {})).toThrow('TOOLS_MAIN_WINDOW_REQUIRED')
    cleanup(); expect(handlers.size).toBe(0)
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
