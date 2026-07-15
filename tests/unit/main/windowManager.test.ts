import { describe, expect, it, vi } from 'vitest'

import {
  parseDevelopmentRendererSources,
  RendererLoadError,
  WindowManager,
  type BrowserWindowLike,
  type WindowConstructorOptions,
} from '../../../src/main/windows/windowManager'

type WindowEvent = 'close' | 'closed'

class FakeWindow implements BrowserWindowLike {
  readonly webContents = {
    mainFrame: {
      parent: null,
      url: 'file:///C:/TalkType/out/renderer/index.html',
    },
    send: vi.fn(),
    getURL: vi.fn(() => 'file:///C:/TalkType/out/renderer/index.html'),
    isDestroyed: vi.fn(() => false),
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  }

  readonly hide = vi.fn()
  readonly show = vi.fn()
  readonly focus = vi.fn()
  readonly minimize = vi.fn()
  readonly isMinimized = vi.fn(() => false)
  readonly restore = vi.fn()
  readonly showInactive = vi.fn()
  readonly setPosition = vi.fn()
  private destroyed = false
  readonly destroy = vi.fn(() => {
    this.destroyed = true
  })
  readonly isDestroyed = vi.fn(() => this.destroyed)
  readonly loadURL = vi.fn<(url: string) => Promise<void>>(async () => undefined)
  readonly loadFile = vi.fn<(path: string) => Promise<void>>(async () => undefined)
  readonly removedListeners: WindowEvent[] = []
  readonly renderProcessGoneListeners = new Set<() => void>()
  readonly onRenderProcessGone = vi.fn((listener: () => void) => {
    this.renderProcessGoneListeners.add(listener)
  })
  readonly removeRenderProcessGoneListener = vi.fn((listener: () => void) => {
    this.renderProcessGoneListeners.delete(listener)
  })

  private readonly listeners = new Map<WindowEvent, Set<(event: { preventDefault(): void }) => void>>()

  on(event: WindowEvent, listener: (event: { preventDefault(): void }) => void): void {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
  }

  onNavigation(
    event: 'will-navigate' | 'will-frame-navigate' | 'will-redirect',
    listener: (event: { preventDefault(): void }, details: { readonly url: string }) => void,
  ): void {
    this.webContents.on(event, listener)
  }

  removeNavigationListener(
    event: 'will-navigate' | 'will-frame-navigate' | 'will-redirect',
    listener: (event: { preventDefault(): void }, details: { readonly url: string }) => void,
  ): void {
    this.webContents.removeListener(event, listener)
  }

  removeListener(event: WindowEvent, listener: (event: { preventDefault(): void }) => void): void {
    this.removedListeners.push(event)
    this.listeners.get(event)?.delete(listener)
  }

  emit(event: WindowEvent, nativeEvent = { preventDefault: vi.fn() }): typeof nativeEvent {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(nativeEvent)
    }
    return nativeEvent
  }

  emitRenderProcessGone(): void {
    for (const listener of [...this.renderProcessGoneListeners]) {
      listener()
    }
  }
}

function createDeferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function createHarness(
  overrides: Partial<ConstructorParameters<typeof WindowManager>[0]> = {},
  configureWindow: (window: FakeWindow) => void = () => undefined,
) {
  const windows: FakeWindow[] = []
  const options: WindowConstructorOptions[] = []
  const createWindow = vi.fn((windowOptions: WindowConstructorOptions) => {
    options.push(windowOptions)
    const window = new FakeWindow()
    configureWindow(window)
    windows.push(window)
    return window
  })
  const log = vi.fn()
  const manager = new WindowManager({
    createWindow,
    display: {
      getCursorScreenPoint: () => ({ x: 1_700, y: 970 }),
      getDisplayNearestPoint: () => ({
        workArea: { x: 1_000, y: 100, width: 1_200, height: 900 },
      }),
    },
    preloadPath: 'C:/TalkType/out/preload/index.js',
    mainHtmlPath: 'C:/TalkType/out/renderer/index.html',
    widgetHtmlPath: 'C:/TalkType/out/renderer/widget.html',
    developmentSources: undefined,
    isPackaged: true,
    log,
    ...overrides,
  })

  return { createWindow, log, manager, options, windows }
}

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
        title: 'TalkType',
        backgroundColor: '#111318',
        autoHideMenuBar: true,
        webPreferences: {
          preload: 'C:/TalkType/out/preload/index.js',
          additionalArguments: ['--talktype-renderer-role=main'],
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      },
    ])
  })

  it('passes the complete non-focusing widget options to the real constructor seam', async () => {
    const { manager, options } = createHarness()

    await manager.createWidgetWindow()

    expect(options).toStrictEqual([
      {
        width: 420,
        height: 92,
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
          preload: 'C:/TalkType/out/preload/index.js',
          additionalArguments: ['--talktype-renderer-role=widget'],
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      },
    ])
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

describe('WindowManager lifecycle', () => {
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

  it('reports renderer delivery success and contains missing, destroyed, or throwing sends', async () => {
    const { manager, windows } = createHarness()

    expect(manager.sendToMain('talktype:test', { value: 1 })).toBe(false)
    await manager.createMainWindow()
    const main = windows[0]!

    expect(manager.sendToMain('talktype:test', { value: 2 })).toBe(true)
    expect(main.webContents.send).toHaveBeenCalledWith('talktype:test', { value: 2 })

    main.webContents.send.mockImplementationOnce(() => {
      throw new Error('renderer stopped between the guard and send')
    })
    expect(manager.sendToMain('talktype:test', { value: 3 })).toBe(false)

    main.webContents.isDestroyed.mockReturnValue(true)
    expect(manager.sendToMain('talktype:test', { value: 4 })).toBe(false)

    main.webContents.isDestroyed.mockImplementationOnce(() => {
      throw new Error('destroyed check raced with native teardown')
    })
    expect(manager.sendToMain('talktype:test', { value: 5 })).toBe(false)
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

  it('hides the main window on close until application quit begins', async () => {
    const { manager, windows } = createHarness()
    await manager.createMainWindow()
    const main = windows[0]!

    const ordinaryClose = main.emit('close')

    expect(ordinaryClose.preventDefault).toHaveBeenCalledOnce()
    expect(main.hide).toHaveBeenCalledOnce()

    manager.beginQuit()
    const quittingClose = main.emit('close')

    expect(quittingClose.preventDefault).not.toHaveBeenCalled()
    expect(main.hide).toHaveBeenCalledOnce()
  })

  it('shows the widget without activation and clamps it inside the active work area', async () => {
    const { manager, windows } = createHarness()
    await manager.createWidgetWindow()
    const widget = windows[0]!

    await manager.showWidget()

    expect(widget.setPosition).toHaveBeenCalledWith(1_390, 876, false)
    expect(widget.showInactive).toHaveBeenCalledOnce()
    expect(widget.show).not.toHaveBeenCalled()
    expect(widget.focus).not.toHaveBeenCalled()
  })

  it('does not report widget send success until renderer load completes', async () => {
    const load = createDeferred<void>()
    const { manager, windows } = createHarness({}, (window) => {
      window.loadFile.mockImplementationOnce(() => load.promise)
    })
    const creation = manager.createWidgetWindow()
    expect(manager.sendToWidget('state', { status: 'idle' })).toBe(false)
    expect(windows[0]!.webContents.send).not.toHaveBeenCalled()
    load.resolve()
    await creation
    expect(manager.sendToWidget('state', { status: 'idle' })).toBe(true)
  })

  it('clamps the widget to the left and top edges of a small negative-coordinate work area', async () => {
    const { manager, windows } = createHarness({
      display: {
        getCursorScreenPoint: () => ({ x: -1_900, y: -900 }),
        getDisplayNearestPoint: () => ({
          workArea: { x: -2_000, y: -1_000, width: 440, height: 110 },
        }),
      },
    })
    await manager.createWidgetWindow()

    await manager.showWidget()

    expect(windows[0]!.setPosition).toHaveBeenCalledWith(-1_990, -1_000, false)
  })

  it('disposes both windows idempotently and releases listeners', async () => {
    const { manager, windows } = createHarness()
    await manager.createWindows()

    manager.dispose()
    manager.dispose()

    expect(windows[0]!.destroy).toHaveBeenCalledOnce()
    expect(windows[1]!.destroy).toHaveBeenCalledOnce()
    expect(windows[0]!.removedListeners).toStrictEqual(['close', 'closed'])
    expect(windows[0]!.webContents.removeListener).toHaveBeenCalledTimes(3)
    expect(windows[1]!.removedListeners).toStrictEqual(['closed'])
    expect(windows[1]!.webContents.removeListener).toHaveBeenCalledTimes(3)
  })

  it('denies all renderer-created windows and subsequent navigation', async () => {
    const { manager, windows } = createHarness()
    await manager.createMainWindow()
    const contents = windows[0]!.webContents

    const openHandler = contents.setWindowOpenHandler.mock.calls[0]?.[0]
    expect(openHandler?.({ url: 'https://attacker.invalid' })).toEqual({ action: 'deny' })

    for (const eventName of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
      const navigationRegistration = contents.on.mock.calls.find(
        ([event]) => event === eventName,
      )
      const navigationEvent = { preventDefault: vi.fn() }
      navigationRegistration?.[1]?.(navigationEvent, { url: 'https://attacker.invalid' })
      expect(navigationEvent.preventDefault).toHaveBeenCalledOnce()
    }
  })

  it('rejects every create and show entry point after disposal without constructing a window', async () => {
    const { createWindow, manager } = createHarness()
    manager.dispose()

    await expect(manager.createMainWindow()).rejects.toMatchObject({
      name: 'WindowManagerStoppedError',
      code: 'WINDOW_MANAGER_STOPPED',
    })
    await expect(manager.createWidgetWindow()).rejects.toMatchObject({
      name: 'WindowManagerStoppedError',
      code: 'WINDOW_MANAGER_STOPPED',
    })
    await expect(manager.showMain()).rejects.toMatchObject({
      name: 'WindowManagerStoppedError',
      code: 'WINDOW_MANAGER_STOPPED',
    })
    await expect(manager.showWidget()).rejects.toMatchObject({
      name: 'WindowManagerStoppedError',
      code: 'WINDOW_MANAGER_STOPPED',
    })
    expect(createWindow).not.toHaveBeenCalled()
  })

  it('does not resurrect or cache a main window when disposal wins an in-flight renderer load', async () => {
    const rendererLoad = createDeferred<void>()
    const { createWindow, manager, windows } = createHarness({}, (window) => {
      window.loadFile.mockImplementationOnce(() => rendererLoad.promise)
    })
    const creation = manager.createMainWindow()

    manager.dispose()
    rendererLoad.resolve()

    await expect(creation).rejects.toMatchObject({
      name: 'WindowManagerStoppedError',
      code: 'WINDOW_MANAGER_STOPPED',
    })
    expect(windows[0]!.destroy).toHaveBeenCalledOnce()
    await expect(manager.createMainWindow()).rejects.toMatchObject({
      code: 'WINDOW_MANAGER_STOPPED',
    })
    expect(createWindow).toHaveBeenCalledOnce()
  })

  it('destroys and replaces the main window after its renderer process exits', async () => {
    const { createWindow, manager, windows } = createHarness()
    await manager.createMainWindow()
    const crashed = windows[0]!

    crashed.emitRenderProcessGone()

    expect(crashed.destroy).toHaveBeenCalledOnce()
    expect(crashed.removedListeners).toStrictEqual(['close', 'closed'])
    expect(crashed.webContents.removeListener).toHaveBeenCalledTimes(3)
    expect(crashed.removeRenderProcessGoneListener).toHaveBeenCalledOnce()
    expect(manager.getMainWebContents()).toBeNull()

    await manager.showMain()

    expect(createWindow).toHaveBeenCalledTimes(2)
    expect(windows[1]!.loadFile).toHaveBeenCalledWith('C:/TalkType/out/renderer/index.html')
    expect(windows[1]!.show).toHaveBeenCalledOnce()
    expect(windows[1]!.focus).toHaveBeenCalledOnce()
  })

  it('exposes only the live loaded renderer identities after crash recovery', async () => {
    const { manager, windows } = createHarness()
    await manager.createWindows()
    const originalMain = windows[0]!
    const originalWidget = windows[1]!

    expect(manager.getTrustedRenderers()).toStrictEqual([
      {
        role: 'main',
        webContents: originalMain.webContents,
        url: 'file:///C:/TalkType/out/renderer/index.html',
      },
      {
        role: 'widget',
        webContents: originalWidget.webContents,
        url: 'file:///C:/TalkType/out/renderer/index.html',
      },
    ])

    originalMain.emitRenderProcessGone()
    expect(manager.getTrustedRenderers()).toStrictEqual([
      {
        role: 'widget',
        webContents: originalWidget.webContents,
        url: 'file:///C:/TalkType/out/renderer/index.html',
      },
    ])

    await manager.createMainWindow()
    expect(manager.getTrustedRenderers()).toStrictEqual([
      {
        role: 'main',
        webContents: windows[2]!.webContents,
        url: 'file:///C:/TalkType/out/renderer/index.html',
      },
      {
        role: 'widget',
        webContents: originalWidget.webContents,
        url: 'file:///C:/TalkType/out/renderer/index.html',
      },
    ])
    expect(manager.getTrustedRenderers()).not.toContainEqual(
      expect.objectContaining({ webContents: originalMain.webContents }),
    )
  })

  it('destroys and replaces the widget window after its renderer process exits', async () => {
    const { createWindow, manager, windows } = createHarness()
    await manager.createWidgetWindow()
    const crashed = windows[0]!

    crashed.emitRenderProcessGone()

    expect(crashed.destroy).toHaveBeenCalledOnce()
    expect(crashed.removedListeners).toStrictEqual(['closed'])
    expect(crashed.webContents.removeListener).toHaveBeenCalledTimes(3)
    expect(crashed.removeRenderProcessGoneListener).toHaveBeenCalledOnce()
    expect(manager.getWidgetWebContents()).toBeNull()

    await manager.showWidget()

    expect(createWindow).toHaveBeenCalledTimes(2)
    expect(windows[1]!.loadFile).toHaveBeenCalledWith('C:/TalkType/out/renderer/widget.html')
    expect(windows[1]!.showInactive).toHaveBeenCalledOnce()
  })

  it('rejects an in-flight creation whose renderer exits and allows a fresh retry', async () => {
    const firstLoad = createDeferred<void>()
    let creationCount = 0
    const { createWindow, manager, windows } = createHarness({}, (window) => {
      if (creationCount === 0) {
        window.loadFile.mockImplementationOnce(() => firstLoad.promise)
      }
      creationCount += 1
    })
    const creation = manager.createMainWindow()

    windows[0]!.emitRenderProcessGone()
    firstLoad.resolve()

    await expect(creation).rejects.toMatchObject({
      name: 'RendererProcessGoneError',
      code: 'RENDERER_PROCESS_GONE',
    })
    expect(windows[0]!.destroy).toHaveBeenCalledOnce()
    expect(windows[0]!.removeRenderProcessGoneListener).toHaveBeenCalledOnce()

    await expect(manager.createMainWindow()).resolves.toBe(windows[1])
    expect(createWindow).toHaveBeenCalledTimes(2)
  })

  it('does not cache a renderer that exits synchronously while its load starts', async () => {
    const firstLoad = createDeferred<void>()
    let creationCount = 0
    const { createWindow, manager, windows } = createHarness({}, (window) => {
      if (creationCount === 0) {
        window.loadFile.mockImplementationOnce(() => {
          window.emitRenderProcessGone()
          return firstLoad.promise
        })
      }
      creationCount += 1
    })

    const firstCreation = manager.createMainWindow()
    const retry = manager.createMainWindow()

    await expect(retry).resolves.toBe(windows[1])
    expect(createWindow).toHaveBeenCalledTimes(2)
    firstLoad.resolve()
    await expect(firstCreation).rejects.toMatchObject({ code: 'RENDERER_PROCESS_GONE' })
  })

  it('does not duplicate cleanup when renderer exit overlaps a pending load and quit', async () => {
    const rendererLoad = createDeferred<void>()
    const { manager, windows } = createHarness({}, (window) => {
      window.loadFile.mockImplementationOnce(() => rendererLoad.promise)
    })
    const creation = manager.createWidgetWindow()

    manager.beginQuit()
    manager.dispose()
    windows[0]!.emitRenderProcessGone()
    rendererLoad.resolve()

    await expect(creation).rejects.toMatchObject({ code: 'WINDOW_MANAGER_STOPPED' })
    expect(windows[0]!.destroy).toHaveBeenCalledOnce()
    expect(windows[0]!.removeRenderProcessGoneListener).toHaveBeenCalledOnce()
    expect(windows[0]!.renderProcessGoneListeners.size).toBe(0)
  })
})

describe('WindowManager renderer loading', () => {
  it('withholds the bundled identity until loadFile resolves', async () => {
    const managerRef: { current?: WindowManager } = {}
    let identityDuringLoad: ReturnType<WindowManager['getTrustedRenderers']> = []
    const harness = createHarness({}, (window) => {
      window.loadFile.mockImplementationOnce(async () => {
        identityDuringLoad = managerRef.current!.getTrustedRenderers()
      })
    })
    managerRef.current = harness.manager

    await harness.manager.createMainWindow()

    expect(identityDuringLoad).toStrictEqual([])
  })

  it('withholds trust during development and bundled fallback loads', async () => {
    const managerRef: { current?: WindowManager } = {}
    let identityDuringDevelopmentLoad: ReturnType<
      WindowManager['getTrustedRenderers']
    > = []
    let identityDuringBundledFallback: ReturnType<
      WindowManager['getTrustedRenderers']
    > = []
    const harness = createHarness(
      {
        isPackaged: false,
        developmentSources: parseDevelopmentRendererSources('http://127.0.0.1:5173')!,
      },
      (window) => {
        window.loadURL.mockImplementationOnce(async () => {
          identityDuringDevelopmentLoad = managerRef.current!.getTrustedRenderers()
          throw new Error('development renderer unavailable')
        })
        window.loadFile.mockImplementationOnce(async () => {
          identityDuringBundledFallback = managerRef.current!.getTrustedRenderers()
        })
      },
    )
    managerRef.current = harness.manager

    await harness.manager.createMainWindow()

    expect(identityDuringDevelopmentLoad).toStrictEqual([])
    expect(identityDuringBundledFallback).toStrictEqual([])
  })

  it('falls back from a failed development URL to the bundled local renderer without leaking details', async () => {
    const loadFailure = new Error('token=secret C:/Users/private/source')
    const { log, manager, windows } = createHarness(
      {
        isPackaged: false,
        developmentSources: parseDevelopmentRendererSources('http://127.0.0.1:5173')!,
      },
      (window) => window.loadURL.mockRejectedValueOnce(loadFailure),
    )

    await manager.createMainWindow()

    expect(windows[0]!.loadURL).toHaveBeenCalledWith(
      'http://127.0.0.1:5173/index.html',
    )
    expect(windows[0]!.loadFile).toHaveBeenCalledWith('C:/TalkType/out/renderer/index.html')
    expect(log).toHaveBeenCalledWith('renderer-load-failed:main:development')
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret')
    expect(JSON.stringify(log.mock.calls)).not.toContain('C:/Users')
  })

  it('never trusts a development renderer URL in a packaged build', async () => {
    const { manager, windows } = createHarness({
      isPackaged: true,
      developmentSources: {
        main: new URL('https://attacker.invalid/main'),
        widget: new URL('https://attacker.invalid/widget'),
      },
    })

    const creation = manager.createMainWindow()
    await creation

    expect(windows[0]!.loadURL).not.toHaveBeenCalled()
    expect(windows[0]!.loadFile).toHaveBeenCalledWith('C:/TalkType/out/renderer/index.html')
  })

  it('rejects a failed bundled renderer with a sanitized operational error', async () => {
    const { log, manager } = createHarness(
      {},
      (window) =>
        window.loadFile.mockRejectedValueOnce(
          new Error('password=private C:/Users/private/out/renderer/index.html'),
        ),
    )

    await expect(manager.createMainWindow()).rejects.toEqual(new RendererLoadError('main'))
    expect(manager.getTrustedRenderers()).toStrictEqual([])
    expect(log).toHaveBeenCalledWith('renderer-load-failed:main:bundled')
    expect(JSON.stringify(log.mock.calls)).not.toContain('private')
  })

  it('clears a rejected creation promise so a later local renderer retry can recover', async () => {
    let creationCount = 0
    const { createWindow, manager } = createHarness({}, (window) => {
      if (creationCount === 0) {
        window.loadFile.mockRejectedValueOnce(new Error('first load fails'))
      }
      creationCount += 1
    })

    await expect(manager.createMainWindow()).rejects.toEqual(new RendererLoadError('main'))
    await expect(manager.createMainWindow()).resolves.toBeDefined()

    expect(createWindow).toHaveBeenCalledTimes(2)
  })

  it('loads distinct exact main and widget development URLs from validated URL objects', async () => {
    const { manager, windows } = createHarness({
      isPackaged: false,
      developmentSources: parseDevelopmentRendererSources('https://localhost:5173')!,
    })

    await manager.createWindows()

    expect(windows[0]!.loadURL).toHaveBeenCalledWith(
      'https://localhost:5173/index.html',
    )
    expect(windows[1]!.loadURL).toHaveBeenCalledWith(
      'https://localhost:5173/widget.html',
    )
  })
})

describe('parseDevelopmentRendererSources', () => {
  it.each([
    'https://attacker.invalid',
    'http://user:password@localhost:5173',
    'file:///C:/renderer/index.html',
    'ftp://127.0.0.1/renderer',
    'http://192.168.1.10:5173',
    'http://localhost:5173/not-the-dev-root',
    'not a URL',
  ])('rejects unsafe raw development renderer source %s', (raw) => {
    expect(parseDevelopmentRendererSources(raw)).toBeUndefined()
  })

  it.each(['http://localhost:5173', 'http://127.0.0.1:5173/', 'https://[::1]:5173/'])(
    'accepts loopback http(s) without credentials: %s',
    (raw) => {
      const sources = parseDevelopmentRendererSources(raw)

      expect(sources?.main).toBeInstanceOf(URL)
      expect(sources?.widget).toBeInstanceOf(URL)
      expect(sources?.main.href).toBe(`${new URL(raw).origin}/index.html`)
      expect(sources?.widget.href).toBe(`${new URL(raw).origin}/widget.html`)
    },
  )
})
