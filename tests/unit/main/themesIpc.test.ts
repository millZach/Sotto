// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import type { IpcInvocationEvent } from '../../../src/main/ipc/registerIpc'
import { registerThemesIpc, type ThemesIpcServices } from '../../../src/main/themes/ipc'
import { OpenVsxFailure } from '../../../src/main/themes/openVsx'
import { createThemesBridge } from '../../../src/preload/themes'
import { THEMES_EXPORT, THEMES_INSTALL, THEMES_SEARCH } from '../../../src/shared/themes/bridge'
import { parseThemeFile, serializeThemeFile } from '../../../src/shared/themes/library'

type Handler = (event: IpcInvocationEvent, ...args: unknown[]) => unknown

function setup(overrides: Partial<ThemesIpcServices> = {}) {
  const url = 'file:///main.html'
  const mainFrame = { parent: null, url }
  const sender = { mainFrame, getURL: () => url, isDestroyed: () => false }
  const handlers = new Map<string, Handler>()
  const services: ThemesIpcServices = {
    openVsx: { search: vi.fn(async () => []), install: vi.fn(async () => { throw new OpenVsxFailure('rejected', 'Not a theme.') }) },
    chooseExportPath: vi.fn(async (name: string) => `C:/exports/${name}`),
    writeFile: vi.fn(async () => undefined),
    ...overrides,
  }
  const cleanup = registerThemesIpc({ handle: (channel, fn) => { handlers.set(channel, fn) }, removeHandler: channel => { handlers.delete(channel) } }, services, () => [{ role: 'main', url, webContents: sender }])
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender, senderFrame: mainFrame }, ...args)
  return { handlers, services, cleanup, call, sender, mainFrame }
}

const theme = parseThemeFile({ version: 1, name: 'Harbor', appearance: 'dark', colors: { canvas: '#102a33' } })

describe('themes IPC', () => {
  it('answers only the main window, with exactly one argument', () => {
    const { handlers, cleanup, sender, mainFrame } = setup()
    expect([...handlers.keys()].sort()).toEqual([THEMES_EXPORT, THEMES_INSTALL, THEMES_SEARCH].sort())
    for (const handler of handlers.values()) {
      expect(() => handler({ sender: { ...sender }, senderFrame: mainFrame }, {})).toThrow('THEMES_MAIN_WINDOW_REQUIRED')
      expect(() => handler({ sender, senderFrame: { parent: {}, url: mainFrame.url } }, {})).toThrow('THEMES_MAIN_WINDOW_REQUIRED')
      expect(() => handler({ sender, senderFrame: mainFrame }, {}, {})).toThrow()
    }
    cleanup()
    expect(handlers.size).toBe(0)
  })

  it('writes an export only when the contents are a real theme file and a path was chosen', async () => {
    const { call, services } = setup()
    await expect(call(THEMES_EXPORT, { fileName: 'harbor.json', contents: serializeThemeFile(theme) })).resolves.toEqual({ ok: true, value: { saved: true } })
    expect(services.writeFile).toHaveBeenCalledWith('C:/exports/harbor.json', serializeThemeFile(theme))

    for (const request of [
      { fileName: '../harbor.json', contents: serializeThemeFile(theme) },
      { fileName: 'harbor.exe', contents: serializeThemeFile(theme) },
      { fileName: 'harbor.json', contents: '{"version":1,"name":"x","appearance":"dark","colors":{"canvas":"url(https://evil.example)"}}' },
      { fileName: 'harbor.json', contents: 'not json' },
    ]) {
      await expect(call(THEMES_EXPORT, request)).resolves.toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    }
    expect(services.writeFile).toHaveBeenCalledTimes(1)
    expect(services.chooseExportPath).toHaveBeenCalledTimes(1)
  })

  it('reports a cancelled save and a failed write without throwing', async () => {
    const cancelled = setup({ chooseExportPath: vi.fn(async () => null) })
    await expect(cancelled.call(THEMES_EXPORT, { fileName: 'harbor.json', contents: serializeThemeFile(theme) })).resolves.toEqual({ ok: true, value: { saved: false } })
    expect(cancelled.services.writeFile).not.toHaveBeenCalled()

    const failing = setup({ writeFile: vi.fn(async () => { throw new Error('EACCES C:/secret/path') }) })
    const result = await failing.call(THEMES_EXPORT, { fileName: 'harbor.json', contents: serializeThemeFile(theme) })
    expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('passes Open VSX failures through as typed results and hides unexpected errors', async () => {
    const { call } = setup({ openVsx: { search: vi.fn(async () => { throw new Error('internal detail') }), install: vi.fn(async () => { throw new OpenVsxFailure('rejected', 'Not a theme.') }) } })
    await expect(call(THEMES_INSTALL, { namespace: 'a', name: 'b' })).resolves.toEqual({ ok: false, error: { code: 'rejected', message: 'Not a theme.' } })
    const search = await call(THEMES_SEARCH, { query: 'x', sortBy: 'rating' })
    expect(search).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(JSON.stringify(search)).not.toContain('internal detail')
  })
})

describe('themes preload bridge', () => {
  it('validates requests before invoking and results after', async () => {
    const invoke = vi.fn(async () => ({ ok: true, value: { saved: true } }))
    const bridge = createThemesBridge({ invoke, on: vi.fn(), removeListener: vi.fn() } as never)
    expect(Object.isFrozen(bridge)).toBe(true)
    await expect(bridge.installOpenVsx({ namespace: 'a', name: 'b/../../c' })).rejects.toThrow()
    await expect(bridge.exportTheme({ fileName: 'C:\\x.json', contents: '{}' })).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()

    await expect(bridge.exportTheme({ fileName: 'harbor.json', contents: serializeThemeFile(theme) })).resolves.toEqual({ ok: true, value: { saved: true } })
    invoke.mockResolvedValueOnce({ ok: true, value: [{ id: 'x', privileged: true }] } as never)
    await expect(bridge.searchOpenVsx({ query: 'x', sortBy: 'rating' })).rejects.toThrow()
  })
})
