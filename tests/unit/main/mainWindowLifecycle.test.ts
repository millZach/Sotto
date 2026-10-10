// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { APP_MAXIMIZED, APP_WINDOW_HIDDEN } from '../../../src/shared/channels'
import { platformProfile } from '../../../src/main/platformProfile'
import { createDeferred, createHarness } from '../../fixtures/windowManager'

describe('WindowManager lifecycle', () => {
  it('reloads only the existing main document without recreating either window', async () => {
    const { manager, windows } = createHarness()
    await manager.createWindows()
    const main = windows[0]!
    const widget = windows[1]!
    widget.loadURL.mockClear()
    await manager.reloadMain()
    expect(main.loadURL).toHaveBeenLastCalledWith(main.webContents.getURL())
    expect(widget.loadURL).not.toHaveBeenCalled()
    expect(windows).toHaveLength(2)
  })

  it('notifies the main renderer when its native window hides or minimizes', async () => {
    const { manager, windows } = createHarness()
    await manager.createWindows()
    const main = windows[0]!
    const widget = windows[1]!
    main.emit('hide')
    main.emit('minimize')
    expect(main.webContents.send.mock.calls.filter(([channel]) => channel === APP_WINDOW_HIDDEN)).toEqual([
      [APP_WINDOW_HIDDEN, null], [APP_WINDOW_HIDDEN, null],
    ])
    expect(widget.webContents.send).not.toHaveBeenCalledWith(APP_WINDOW_HIDDEN, null)
    main.emit('closed')
    expect(main.removedListeners).toEqual(expect.arrayContaining(['hide', 'minimize']))
  })

  it('toggles only the main window and publishes native maximize changes', async () => {
    const { manager, windows } = createHarness()
    await manager.createWindows()
    const main = windows[0]!
    const widget = windows[1]!
    manager.toggleMaximizeMain()
    expect(main.maximize).toHaveBeenCalledOnce()
    expect(widget.maximize).not.toHaveBeenCalled()
    main.isMaximized.mockReturnValue(true)
    main.emit('maximize')
    expect(manager.isMainMaximized()).toBe(true)
    expect(main.webContents.send).toHaveBeenLastCalledWith(APP_MAXIMIZED, true)
    manager.toggleMaximizeMain()
    expect(main.unmaximize).toHaveBeenCalledOnce()
    main.isMaximized.mockReturnValue(false)
    main.emit('unmaximize')
    expect(main.webContents.send).toHaveBeenLastCalledWith(APP_MAXIMIZED, false)
  })

  it('restores a minimized main window before showing and focusing it', async () => {
    const { manager, windows } = createHarness()
    await manager.createMainWindow()
    const main = windows[0]!
    main.isMinimized.mockReturnValue(true)

    await manager.showMain()

    expect(main.restore).toHaveBeenCalledOnce()
    expect(main.restore.mock.invocationCallOrder[0]).toBeLessThan(
      main.show.mock.invocationCallOrder[0]!,
    )
    expect(main.show.mock.invocationCallOrder[0]).toBeLessThan(
      main.focus.mock.invocationCallOrder[0]!,
    )
  })

  it('shows and focuses a hidden non-minimized main window without restoring it', async () => {
    const { manager, windows } = createHarness()
    await manager.createMainWindow()
    const main = windows[0]!

    await manager.showMain()

    expect(main.restore).not.toHaveBeenCalled()
    expect(main.show).toHaveBeenCalledOnce()
    expect(main.focus).toHaveBeenCalledOnce()
    expect(main.show.mock.invocationCallOrder[0]).toBeLessThan(
      main.focus.mock.invocationCallOrder[0]!,
    )
  })

  it('shows and hides the main window', async () => {
    const { manager, windows } = createHarness()

    await manager.showMain()
    manager.hideMain()

    expect(windows[0]!.show).toHaveBeenCalledOnce()
    expect(windows[0]!.hide).toHaveBeenCalledOnce()
  })

  it('reports renderer delivery success and contains missing, destroyed, or throwing sends', async () => {
    const { manager, windows } = createHarness()

    expect(manager.sendToMain('sotto:test', { value: 1 })).toBe(false)
    await manager.createMainWindow()
    const main = windows[0]!

    expect(manager.sendToMain('sotto:test', { value: 2 })).toBe(true)
    expect(main.webContents.send).toHaveBeenCalledWith('sotto:test', { value: 2 })

    main.webContents.send.mockImplementationOnce(() => {
      throw new Error('renderer stopped between the guard and send')
    })
    expect(manager.sendToMain('sotto:test', { value: 3 })).toBe(false)

    main.webContents.isDestroyed.mockReturnValue(true)
    expect(manager.sendToMain('sotto:test', { value: 4 })).toBe(false)

    main.webContents.isDestroyed.mockImplementationOnce(() => {
      throw new Error('destroyed check raced with native teardown')
    })
    expect(manager.sendToMain('sotto:test', { value: 5 })).toBe(false)
  })

  it('does not report main send success until an in-flight renderer load completes', async () => {
    const load = createDeferred<void>()
    const { manager, windows } = createHarness({}, (window) => {
      window.loadFile.mockImplementationOnce(() => load.promise)
    })
    const creation = manager.createMainWindow()
    expect(manager.sendToMain('dictation', { type: 'toggle' })).toBe(false)
    expect(windows[0]!.webContents.send).not.toHaveBeenCalled()
    load.resolve()
    await creation
    expect(manager.sendToMain('dictation', { type: 'toggle' })).toBe(true)
  })

  it.each(['win32', 'darwin', 'linux'] as const)('hides the %s main window on close until application quit begins', async (platform) => {
    const { manager, windows } = createHarness({ platform, chrome: platformProfile(platform) })
    await manager.createMainWindow()
    const main = windows[0]!

    const ordinaryClose = main.emit('close')

    expect(ordinaryClose.preventDefault).toHaveBeenCalledOnce()
    expect(main.hide).toHaveBeenCalledOnce()
    expect(main.destroy).not.toHaveBeenCalled()
    expect(manager.sendToMain('still-running', null)).toBe(true)
    await manager.showMain()
    expect(windows).toHaveLength(1)
    expect(main.show).toHaveBeenCalled()

    manager.beginQuit()
    const quittingClose = main.emit('close')

    expect(quittingClose.preventDefault).not.toHaveBeenCalled()
    expect(main.hide).toHaveBeenCalledOnce()
  })
})
