// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { PopupWindow, type PopupBrowserWindow, type PopupWindowOptions } from '../../../../src/main/windows/popupWindow'
import { platformProfile } from '../../../../src/main/platformProfile'
import { POPUP_SHOWN } from '../../../../src/shared/popup'
import type { SottoPlatform } from '../../../../src/shared/platform'
import { deferred } from '../../../fixtures/deferred'

function fixture(platform: SottoPlatform = 'darwin') {
  const loaded = deferred()
  let visible = false, focused = false, destroyed = false
  let bounds = { x: 0, y: 0, width: 560, height: 64 }
  const calls: string[] = []
  const window: PopupBrowserWindow = {
    webContents: { mainFrame: { parent: null, url: 'file:///popup.html' }, getURL: () => 'file:///popup.html', isDestroyed: () => destroyed,
      send: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn() },
    isDestroyed: () => destroyed, isVisible: () => visible, isFocused: () => focused,
    show: vi.fn(() => { visible = true; focused = true; calls.push('show') }),
    showInactive: vi.fn(() => { visible = true; calls.push('showInactive') }),
    focus: vi.fn(() => { focused = true; calls.push('focus') }),
    hide: vi.fn(() => { visible = false; focused = false; calls.push('hide') }),
    destroy: vi.fn(() => { destroyed = true }),
    getBounds: () => bounds, setBounds: vi.fn(next => { bounds = next }),
    setAlwaysOnTop: vi.fn(), setVisibleOnAllWorkspaces: vi.fn(), on: vi.fn(),
    loadFile: vi.fn(() => loaded.promise), loadURL: vi.fn(() => loaded.promise),
  }
  const create = vi.fn<(options: PopupWindowOptions) => PopupBrowserWindow>(() => window)
  const onVisible = vi.fn()
  const area = { x: 0, y: 0, width: 1600, height: 1000 }
  const popup = new PopupWindow({ create, platform, chrome: platformProfile(platform),
    workArea: () => area, workAreas: () => [area], preloadPath: '/preload.js', htmlPath: '/popup.html',
    developmentUrl: undefined, isPackaged: true, extraArguments: () => [], onVisible, log: vi.fn() })
  return { popup, window, create, loaded, calls, onVisible, blur: () => { focused = false } }
}

describe('the popup keyboard focus', () => {
  it.each(['darwin', 'win32', 'linux'] as const)('shows %s through its platform path before taking focus, and only hides on close', async platform => {
    const f = fixture(platform)
    const show = f.popup.show()
    expect(f.window.focus).not.toHaveBeenCalled()
    f.loaded.resolve()
    await show
    expect(f.calls).toEqual([platform === 'darwin' ? 'showInactive' : 'show', 'focus'])
    expect(f.create.mock.calls[0]![0].type).toBe(platform === 'darwin' ? 'panel' : undefined)
    expect(f.window.webContents.send).toHaveBeenCalledExactlyOnceWith(POPUP_SHOWN, null)
    await f.popup.toggle()
    expect(f.calls.at(-1)).toBe('hide')
    expect(f.window.focus).toHaveBeenCalledTimes(1)
    expect(f.onVisible.mock.calls).toEqual([[true], [false]])
  })

  it('brings an unfocused visible popup forward instead of hiding it', async () => {
    const f = fixture()
    f.loaded.resolve()
    await f.popup.show()
    f.blur()
    await f.popup.toggle()
    expect(f.window.focus).toHaveBeenCalledTimes(2)
    expect(f.window.hide).not.toHaveBeenCalled()
  })

  it.each(['hide', 'toggle', 'dispose'] as const)('cancels a pending first show on %s without taking focus later', async action => {
    const f = fixture()
    const show = f.popup.toggle()
    await f.popup[action]()
    f.loaded.resolve()
    await show
    expect(f.window.focus).not.toHaveBeenCalled()
    expect(f.window.showInactive).not.toHaveBeenCalled()
    expect(f.window.webContents.send).not.toHaveBeenCalled()
    expect(f.popup.isVisible()).toBe(false)
  })

  it('shows only the latest request after hide and reopen during loading', async () => {
    const f = fixture()
    const first = f.popup.show()
    f.popup.hide()
    const latest = f.popup.show()
    f.loaded.resolve()
    await Promise.all([first, latest])
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.window.focus).toHaveBeenCalledTimes(1)
    expect(f.window.webContents.send).toHaveBeenCalledExactlyOnceWith(POPUP_SHOWN, null)
  })
})
