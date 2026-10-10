// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { platformProfile } from '../../../src/main/platformProfile'
import { getReleaseTrack, releaseTrackName } from '../../../src/shared/releaseTrack'
import { darwinOverrides, createHarness } from '../../fixtures/windowManager'

describe('WindowManager construction', () => {
  it('passes the complete secure main-window options to the real constructor seam', async () => {
    const { manager, options } = createHarness()

    await manager.createMainWindow()

    expect(options).toStrictEqual([
      {
        width: 1_080,
        height: 720,
        minWidth: 820,
        minHeight: 560,
        show: false,
        title: 'Sotto',
        backgroundColor: '#000000',
        autoHideMenuBar: true,
        frame: false,
        webPreferences: {
          preload: 'C:/Sotto/out/preload/index.js',
          additionalArguments: [
            '--sotto-renderer-role=main',
            '--sotto-platform=win32',
          ],
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: true,
        },
      },
    ])
  })

  it('opens a frosted main window clear over acrylic and tells only its renderer that it can frost', async () => {
    const { manager, options } = createHarness({ windowFrost: 'acrylic', frostedWindow: () => true })

    await manager.createMainWindow()
    await manager.createWidgetWindow()

    expect(options[0]).toMatchObject({ backgroundColor: '#00000000', backgroundMaterial: 'acrylic' })
    expect(options[0]?.webPreferences.additionalArguments).toContain('--sotto-window-frost')
    expect(options[1]?.webPreferences.additionalArguments).not.toContain('--sotto-window-frost')
  })

  it('keeps the black window where the user has not asked for frost, still telling the renderer it could', async () => {
    const { manager, options } = createHarness({ windowFrost: 'acrylic', frostedWindow: () => false })

    await manager.createMainWindow()

    expect(options[0]).toMatchObject({ backgroundColor: '#000000' })
    expect(options[0]).not.toHaveProperty('backgroundMaterial')
    expect(options[0]?.webPreferences.additionalArguments).toContain('--sotto-window-frost')
  })

  it('never frosts where the system has no material, whatever the setting says', async () => {
    const { manager, options, windows } = createHarness({ windowFrost: null, frostedWindow: () => true })

    await manager.createMainWindow()
    manager.setMainWindowFrosted(true)

    expect(options[0]).toMatchObject({ backgroundColor: '#000000' })
    expect(options[0]?.webPreferences.additionalArguments).not.toContain('--sotto-window-frost')
    expect(windows[0]?.setBackgroundMaterial).not.toHaveBeenCalled()
    expect(windows[0]?.setBackgroundColor).not.toHaveBeenCalled()
  })

  it('turns acrylic on and off in place when the setting changes', async () => {
    const { manager, windows } = createHarness({ windowFrost: 'acrylic', frostedWindow: () => false })
    await manager.createMainWindow()

    manager.setMainWindowFrosted(true)
    expect(windows[0]?.setBackgroundMaterial).toHaveBeenLastCalledWith('acrylic')
    expect(windows[0]?.setBackgroundColor).toHaveBeenLastCalledWith('#00000000')

    manager.setMainWindowFrosted(false)
    expect(windows[0]?.setBackgroundMaterial).toHaveBeenLastCalledWith('none')
    expect(windows[0]?.setBackgroundColor).toHaveBeenLastCalledWith('#000000')
  })

  it('uses window vibrancy on macOS', async () => {
    const { manager, options, windows } = createHarness({ platform: 'darwin', chrome: platformProfile('darwin'), windowFrost: 'vibrancy', frostedWindow: () => true })

    await manager.createMainWindow()
    expect(options[0]).toMatchObject({ backgroundColor: '#00000000', vibrancy: 'under-window', visualEffectState: 'followWindow' })

    manager.setMainWindowFrosted(false)
    expect(windows[0]?.setVibrancy).toHaveBeenLastCalledWith(null)
    expect(windows[0]?.setBackgroundMaterial).not.toHaveBeenCalled()
  })

  it('passes the complete non-focusing widget options to the real constructor seam', async () => {
    const { manager, options } = createHarness()

    await manager.createWidgetWindow()

    expect(options).toStrictEqual([
      {
        width: 124,
        height: 54,
        show: false,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: false,
        hasShadow: true,
        autoHideMenuBar: true,
        webPreferences: {
          preload: 'C:/Sotto/out/preload/index.js',
          additionalArguments: [
            '--sotto-renderer-role=widget',
            '--sotto-platform=win32',
          ],
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      },
    ])
  })

  it('names the brand icon on both unpackaged Windows windows', async () => {
    // Unpackaged runs launch through the Electron binary, so without an
    // explicit icon the taskbar and alt-tab show Electron's own logo.
    const { manager, options } = createHarness({
      isPackaged: false,
      brandIconPath: 'C:/Sotto/build/icon.ico',
    })

    await manager.createMainWindow()
    await manager.createWidgetWindow()

    expect(options[0]?.icon).toBe('C:/Sotto/build/icon.ico')
    expect(options[1]?.icon).toBe('C:/Sotto/build/icon.ico')
  })

  it('leaves the window icon to the stamped executable in packaged builds', async () => {
    const { manager, options } = createHarness({
      isPackaged: true,
      brandIconPath: 'C:/Sotto/build/icon.ico',
    })

    await manager.createMainWindow()
    await manager.createWidgetWindow()

    expect(options[0]).not.toHaveProperty('icon')
    expect(options[1]).not.toHaveProperty('icon')
  })

  it('omits the window icon on macOS, which reads it from the bundle', async () => {
    const { manager, options } = createHarness({
      ...darwinOverrides(),
      isPackaged: false,
      brandIconPath: 'C:/Sotto/build/icon.ico',
    })

    await manager.createMainWindow()
    await manager.createWidgetWindow()

    expect(options[0]).not.toHaveProperty('icon')
    expect(options[1]).not.toHaveProperty('icon')
  })

  it('omits the window icon when the unpackaged brand icon path is unknown', async () => {
    const { manager, options } = createHarness({ isPackaged: false })

    await manager.createMainWindow()

    expect(options[0]).not.toHaveProperty('icon')
  })

  it('reasserts widget always-on-top at the explicit normal level after creation', async () => {
    // Windows 11 silently drops the constructor's alwaysOnTop (and the
    // implicit 'floating' level); only an explicit post-create level sticks.
    const { manager, windows } = createHarness()

    await manager.createWidgetWindow()

    expect(windows[0]!.setAlwaysOnTop).toHaveBeenCalledWith(true, 'normal')
  })

  it('reasserts widget always-on-top on every showWidget reveal', async () => {
    const { manager, windows } = createHarness()
    await manager.createWidgetWindow()
    windows[0]!.setAlwaysOnTop.mockClear()

    await manager.showWidget()

    expect(windows[0]!.setAlwaysOnTop).toHaveBeenCalledWith(true, 'normal')
    windows[0]!.setAlwaysOnTop.mockClear()

    await manager.showWidget()

    expect(windows[0]!.setAlwaysOnTop).toHaveBeenCalledWith(true, 'normal')
  })

  it('gives the macOS main window inset traffic lights instead of a removed frame', async () => {
    const { manager, options } = createHarness(darwinOverrides())

    await manager.createMainWindow()

    expect(options[0]).toStrictEqual({
      width: 1_080,
      height: 720,
      minWidth: 820,
      minHeight: 560,
      show: false,
      title: 'Sotto',
      backgroundColor: '#000000',
      autoHideMenuBar: true,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: platformProfile('darwin').trafficLightPosition,
      webPreferences: {
        preload: 'C:/Sotto/out/preload/index.js',
        additionalArguments: [
          '--sotto-renderer-role=main',
          '--sotto-platform=darwin',
        ],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true,
      },
    })
    expect(options[0]).not.toHaveProperty('frame')
  })

  it('raises the macOS widget to the floating level and spans workspaces', async () => {
    const { manager, options, windows } = createHarness(darwinOverrides())

    await manager.createWidgetWindow()

    expect(options[0]?.focusable).toBe(false)
    // A regular app's ordinary window cannot join another app's full-screen desktop; a panel can.
    expect(options[0]?.type).toBe('panel')
    expect(windows[0]!.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating')
    expect(windows[0]!.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    })
  })

  it('keeps the Windows widget an ordinary window and the main window never a panel', async () => {
    const { manager, options } = createHarness()

    await manager.createMainWindow()
    await manager.createWidgetWindow()

    expect(options[0]).not.toHaveProperty('type')
    expect(options[1]).not.toHaveProperty('type')
  })

  it('does not reassert the macOS widget level while the widget is already visible', async () => {
    const { manager, windows } = createHarness(darwinOverrides())
    await manager.showWidget()
    const widget = windows[0]!
    expect(widget.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating')
    widget.setAlwaysOnTop.mockClear()

    await manager.showWidget()

    expect(widget.setAlwaysOnTop).not.toHaveBeenCalled()
  })

  it('leaves a visible full-screen main window where it is when the app activates', async () => {
    const { manager, windows } = createHarness(darwinOverrides())
    await manager.createMainWindow()
    const main = windows[0]!
    main.isFullScreen.mockReturnValue(true)
    main.show.mockClear()
    main.focus.mockClear()

    await manager.showMainFromActivation()

    expect(main.show).not.toHaveBeenCalled()
    expect(main.focus).not.toHaveBeenCalled()
  })

  it('still raises a full-screen main window when show is asked for directly', async () => {
    const { manager, windows } = createHarness(darwinOverrides())
    await manager.createMainWindow()
    const main = windows[0]!
    main.isFullScreen.mockReturnValue(true)

    await manager.showMain()

    expect(main.show).toHaveBeenCalledOnce()
    expect(main.focus).toHaveBeenCalledOnce()
  })

  it('restores a minimized full-screen main window when the app activates', async () => {
    const { manager, windows } = createHarness(darwinOverrides())
    await manager.createMainWindow()
    const main = windows[0]!
    main.isFullScreen.mockReturnValue(true)
    main.isMinimized.mockReturnValue(true)

    await manager.showMainFromActivation()

    expect(main.restore).toHaveBeenCalledOnce()
    expect(main.show).toHaveBeenCalledOnce()
    expect(main.focus).toHaveBeenCalledOnce()
  })

  it('opens a hidden full-screen main window when the app activates', async () => {
    const { manager, windows } = createHarness(darwinOverrides())
    await manager.createMainWindow()
    const main = windows[0]!
    main.isFullScreen.mockReturnValue(true)
    main.isVisible.mockReturnValue(false)

    await manager.showMainFromActivation()

    expect(main.show).toHaveBeenCalledOnce()
    expect(main.focus).toHaveBeenCalledOnce()
  })

  it('leaves workspace spanning alone where the profile does not ask for it', async () => {
    const { manager, windows } = createHarness()

    await manager.createWidgetWindow()

    expect(windows[0]!.setVisibleOnAllWorkspaces).not.toHaveBeenCalled()
  })

  it('contains an unsupported or failing workspace-spanning request', async () => {
    const failing = createHarness(darwinOverrides(), (window) => {
      window.setVisibleOnAllWorkspaces.mockImplementation(() => {
        throw new Error('unsupported')
      })
    })
    const absent = createHarness(darwinOverrides(), (window) => {
      Reflect.deleteProperty(window, 'setVisibleOnAllWorkspaces')
    })

    await expect(failing.manager.createWidgetWindow()).resolves.toBe(
      failing.windows[0],
    )
    await expect(absent.manager.createWidgetWindow()).resolves.toBe(
      absent.windows[0],
    )
    expect(failing.windows[0]!.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating')
  })

  // Main names the window from app.getVersion() exactly this way; the page's own <title> says Sotto on every build.
  it.each([
    ['0.1.34', 'Sotto'],
    ['0.1.35-owl.20261009.1', 'Sotto Owl'],
  ])('titles the main window for the build it is (%s) and keeps that title against the page', async (version, title) => {
    const { manager, options, windows } = createHarness({ title: releaseTrackName(getReleaseTrack(version)) })

    await manager.createMainWindow()
    await manager.createWidgetWindow()

    expect(options[0]).toMatchObject({ title })
    expect(windows[0]!.emit('page-title-updated').preventDefault).toHaveBeenCalledOnce()
    // The widget's window is never named for the build.
    expect(options[1]).not.toHaveProperty('title')
  })

  it('retains one instance of each window', async () => {
    const { createWindow, manager } = createHarness()

    const firstMain = await manager.createMainWindow()
    const secondMain = await manager.createMainWindow()
    const firstWidget = await manager.createWidgetWindow()
    const secondWidget = await manager.createWidgetWindow()

    expect(secondMain).toBe(firstMain)
    expect(secondWidget).toBe(firstWidget)
    expect(createWindow).toHaveBeenCalledTimes(2)
  })
})
