import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WIDGET_VISIBILITY } from '../../../src/shared/channels'
import {
  parseDevelopmentRendererSources,
  RendererLoadError,
  WindowManager,
  type BrowserWindowLike,
  type Rectangle,
  type WindowConstructorOptions,
} from '../../../src/main/windows/windowManager'
import type { StoredWidgetPlacement } from '../../../src/main/storage/widgetPlacementRepository'
import { platformProfile } from '../../../src/main/platformProfile'

type WindowEvent = 'close' | 'closed' | 'moved'

class FakeWindow implements BrowserWindowLike {
  readonly webContents = {
    mainFrame: {
      parent: null,
      url: 'file:///C:/Sotto/out/renderer/index.html',
    },
    send: vi.fn(),
    getURL: vi.fn(() => 'file:///C:/Sotto/out/renderer/index.html'),
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
  readonly setAlwaysOnTop = vi.fn()
  readonly setVisibleOnAllWorkspaces = vi.fn()
  bounds: Rectangle = { x: 0, y: 0, width: 124, height: 54 }
  readonly setBoundsCalls: Rectangle[] = []
  readonly setPositionCalls: Array<readonly [number, number]> = []
  readonly setSizeCalls: Array<readonly [number, number]> = []
  emitMovedOnSetBounds = false
  readonly getBounds = vi.fn((): Rectangle => ({ ...this.bounds }))
  readonly setBounds = vi.fn((bounds: Rectangle): void => {
    this.bounds = { ...bounds }
    this.setBoundsCalls.push({ ...bounds })
    if (this.emitMovedOnSetBounds) this.emit('moved')
  })
  readonly setPosition = vi.fn((x: number, y: number): void => {
    this.bounds = { ...this.bounds, x, y }
    this.setPositionCalls.push([x, y])
  })
  readonly getPosition = vi.fn(() => [this.bounds.x, this.bounds.y] as const)
  readonly setSize = vi.fn((width: number, height: number): void => {
    this.bounds = { ...this.bounds, width, height }
    this.setSizeCalls.push([width, height])
  })
  readonly setIgnoreMouseEvents = vi.fn()
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

function darwinOverrides(): Partial<ConstructorParameters<typeof WindowManager>[0]> {
  return { platform: 'darwin', chrome: platformProfile('darwin') }
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
  const onWidgetMoved = vi.fn()
  const manager = new WindowManager({
    createWindow,
    display: {
      getCursorScreenPoint: () => ({ x: 1_700, y: 970 }),
      getDisplayNearestPoint: () => ({
        workArea: { x: 1_000, y: 100, width: 1_200, height: 900 },
      }),
    },
    platform: 'win32',
    chrome: platformProfile('win32'),
    dock: null,
    preloadPath: 'C:/Sotto/out/preload/index.js',
    mainHtmlPath: 'C:/Sotto/out/renderer/index.html',
    widgetHtmlPath: 'C:/Sotto/out/renderer/widget.html',
    developmentSources: undefined,
    isPackaged: true,
    log,
    getWidgetPlacement: () => null,
    onWidgetMoved,
    ...overrides,
  })

  visibilityGenerationReaders.set(manager, () => {
    for (const window of [...windows].reverse()) {
      for (const [channel, payload] of [...window.webContents.send.mock.calls].reverse()) {
        if (
          channel === WIDGET_VISIBILITY &&
          typeof payload === 'object' &&
          payload !== null &&
          'generation' in payload &&
          typeof payload.generation === 'number'
        ) {
          return payload.generation
        }
      }
    }
    return 0
  })

  return { createWindow, log, manager, onWidgetMoved, options, windows }
}

const visibilityGenerationReaders = new WeakMap<WindowManager, () => number>()

function currentWidgetVisibilityGeneration(manager: WindowManager): number {
  return visibilityGenerationReaders.get(manager)?.() ?? 0
}

function setWidgetPresentation(
  manager: WindowManager,
  presentation: 'idle-resting' | 'idle-hovered' | 'active',
  generation = currentWidgetVisibilityGeneration(manager),
): void {
  manager.setWidgetPresentation({ presentation, generation })
}

const dragGestureStates = new WeakMap<
  WindowManager,
  { activeGestureId: number | null; nextGestureId: number }
>()

function reportWidgetDrag(
  manager: WindowManager,
  phase: 'start' | 'move' | 'end',
  generation = currentWidgetVisibilityGeneration(manager),
): void {
  const state = dragGestureStates.get(manager) ?? {
    activeGestureId: null,
    nextGestureId: 0,
  }
  dragGestureStates.set(manager, state)
  if (phase === 'start') {
    state.activeGestureId = state.nextGestureId
    state.nextGestureId += 1
  }
  const gestureId = state.activeGestureId ?? state.nextGestureId
  manager.reportWidgetDrag({ phase, generation, gestureId })
  if (phase === 'end' && state.activeGestureId === gestureId) {
    state.activeGestureId = null
  }
}

interface GenerationBoundWindowManager {
  setWidgetPresentation(report: {
    readonly presentation: 'idle-resting' | 'idle-hovered' | 'active'
    readonly generation: number
  }): void
  reportWidgetDrag(report: {
    readonly phase: 'start' | 'move' | 'end'
    readonly generation: number
    readonly gestureId: number
  }): void
}

function generationBound(manager: WindowManager): GenerationBoundWindowManager {
  return manager as unknown as GenerationBoundWindowManager
}

const monitorWorkAreas = {
  left: { x: 0, y: 0, width: 1_000, height: 800 },
  right: { x: 1_000, y: 100, width: 1_200, height: 900 },
} as const

function createMutableTwoDisplayAdapter() {
  const cursor = { current: { x: 100, y: 100 } }
  const failures: { cursor: Error | null; display: Error | null } = {
    cursor: null,
    display: null,
  }
  const getCursorScreenPoint = vi.fn(() => {
    if (failures.cursor !== null) {
      const failure = failures.cursor
      failures.cursor = null
      throw failure
    }
    return cursor.current
  })
  const getDisplayNearestPoint = vi.fn((point: { readonly x: number }) => {
    if (failures.display !== null) {
      const failure = failures.display
      failures.display = null
      throw failure
    }
    return {
      workArea: point.x < 1_000 ? monitorWorkAreas.left : monitorWorkAreas.right,
    }
  })

  return {
    cursor,
    display: { getCursorScreenPoint, getDisplayNearestPoint },
    failures,
    getCursorScreenPoint,
    getDisplayNearestPoint,
  }
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
        title: 'Sotto',
        backgroundColor: '#1b1917',
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
        },
      },
    ])
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

  it('reasserts widget always-on-top at the explicit normal level after creation', async () => {
    // Windows 11 silently drops the constructor's alwaysOnTop (and the
    // implicit 'floating' level); only an explicit post-create level sticks.
    const { manager, windows } = createHarness()

    await manager.createWidgetWindow()

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
      backgroundColor: '#1b1917',
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
      },
    })
    expect(options[0]).not.toHaveProperty('frame')
  })

  it('raises the macOS widget to the floating level and spans workspaces', async () => {
    const { manager, options, windows } = createHarness(darwinOverrides())

    await manager.createWidgetWindow()

    expect(options[0]?.focusable).toBe(false)
    expect(windows[0]!.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating')
    expect(windows[0]!.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true,
    })
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

describe('WindowManager cursor monitor following', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('follows the cursor monitor in every widget presentation', async () => {
    const presentations = [
      {
        presentation: 'idle-resting' as const,
        bounds: { x: 1_538, y: 930, width: 124, height: 54 },
      },
      {
        presentation: 'idle-hovered' as const,
        bounds: { x: 1_476, y: 908, width: 248, height: 76 },
      },
      {
        presentation: 'active' as const,
        bounds: { x: 1_476, y: 896, width: 248, height: 88 },
      },
    ]

    for (const { bounds, presentation } of presentations) {
      const adapter = createMutableTwoDisplayAdapter()
      const { manager, windows } = createHarness({ display: adapter.display })
      await manager.showWidget()
      setWidgetPresentation(manager, presentation)
      const widget = windows[0]!
      widget.setBounds.mockClear()

      adapter.cursor.current = { x: 1_700, y: 970 }
      vi.advanceTimersByTime(200)

      expect(widget.setBounds).toHaveBeenCalledOnce()
      expect(widget.setBounds).toHaveBeenCalledWith(bounds, false)
      manager.dispose()
    }
  })

  it('preserves the edge and centers on the target monitor', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({
      display: adapter.display,
      getWidgetPlacement: () => ({ kind: 'edge', edge: 'left' }),
    })
    await manager.showWidget()
    const widget = windows[0]!
    widget.setBounds.mockClear()

    adapter.cursor.current = { x: 1_700, y: 970 }
    vi.advanceTimersByTime(100)

    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_016, y: 488, width: 54, height: 124 },
      false,
    )
  })

  it('does no native work while the cursor remains on one monitor', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!
    widget.setBounds.mockClear()
    widget.setPosition.mockClear()
    widget.setSize.mockClear()
    adapter.getCursorScreenPoint.mockClear()
    adapter.getDisplayNearestPoint.mockClear()

    adapter.cursor.current = { x: 900, y: 700 }
    vi.advanceTimersByTime(100)

    expect(adapter.getCursorScreenPoint).toHaveBeenCalledOnce()
    expect(adapter.getDisplayNearestPoint).toHaveBeenCalledOnce()
    expect(widget.setBounds).not.toHaveBeenCalled()
    expect(widget.setPosition).not.toHaveBeenCalled()
    expect(widget.setSize).not.toHaveBeenCalled()
  })

  it('pauses monitor following while drag ownership is active', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!
    reportWidgetDrag(manager, 'start')
    widget.setBounds.mockClear()
    adapter.getCursorScreenPoint.mockClear()
    adapter.getDisplayNearestPoint.mockClear()

    adapter.cursor.current = { x: 1_700, y: 970 }
    vi.advanceTimersByTime(200)

    expect(vi.getTimerCount()).toBe(1)
    expect(adapter.getCursorScreenPoint).not.toHaveBeenCalled()
    expect(adapter.getDisplayNearestPoint).not.toHaveBeenCalled()
    expect(widget.setBounds).not.toHaveBeenCalled()
  })

  it('resumes following after drag end', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!
    reportWidgetDrag(manager, 'start')
    adapter.cursor.current = { x: 1_700, y: 970 }
    reportWidgetDrag(manager, 'end')
    widget.setBounds.mockClear()
    adapter.getCursorScreenPoint.mockClear()
    adapter.getDisplayNearestPoint.mockClear()

    vi.advanceTimersByTime(100)

    expect(adapter.getCursorScreenPoint).toHaveBeenCalledOnce()
    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_476, y: 908, width: 248, height: 76 },
      false,
    )
  })

  it('keeps an idle reveal resting after a delayed active report from the previous visible generation', async () => {
    const { manager, windows } = createHarness()
    await manager.showWidget()
    const widget = windows[0]!

    manager.hideWidget()
    await manager.showWidget()
    widget.setBounds.mockClear()

    generationBound(manager).setWidgetPresentation({
      presentation: 'active',
      generation: 1,
    })

    expect(widget.bounds).toEqual({ x: 1_538, y: 930, width: 124, height: 54 })
    expect(widget.setBounds).not.toHaveBeenCalled()
    expect(widget.showInactive).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('remembers a current hidden idle report before the next reveal', async () => {
    const { manager, windows } = createHarness()
    await manager.showWidget()
    const widget = windows[0]!
    generationBound(manager).setWidgetPresentation({
      presentation: 'active',
      generation: 1,
    })
    expect(widget.bounds).toEqual({ x: 1_476, y: 896, width: 248, height: 88 })

    manager.hideWidget()
    generationBound(manager).setWidgetPresentation({
      presentation: 'idle-resting',
      generation: 2,
    })
    widget.setBounds.mockClear()

    await manager.showWidget()

    expect(widget.bounds).toEqual({ x: 1_538, y: 930, width: 124, height: 54 })
    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_538, y: 930, width: 124, height: 54 },
      false,
    )
  })

  it('reconciles a current show-generation active republish during the reveal gap', async () => {
    const { manager, windows } = createHarness()
    await manager.showWidget()
    const widget = windows[0]!
    manager.hideWidget()
    widget.setBounds.mockClear()

    const reveal = manager.showWidget()
    generationBound(manager).setWidgetPresentation({
      presentation: 'active',
      generation: 3,
    })
    await reveal

    expect(widget.webContents.send).toHaveBeenLastCalledWith(
      WIDGET_VISIBILITY,
      { visible: true, generation: 3 },
    )
    expect(widget.bounds).toEqual({ x: 1_476, y: 896, width: 248, height: 88 })
  })

  it('rejects delayed drag phases from a previous visible generation after rapid hide and show', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!
    manager.hideWidget()
    await manager.showWidget()
    widget.setBounds.mockClear()
    widget.setPosition.mockClear()
    adapter.getCursorScreenPoint.mockClear()
    adapter.getDisplayNearestPoint.mockClear()

    const stale = generationBound(manager)
    stale.reportWidgetDrag({ phase: 'start', generation: 1, gestureId: 0 })
    stale.reportWidgetDrag({ phase: 'move', generation: 1, gestureId: 0 })
    stale.reportWidgetDrag({ phase: 'end', generation: 1, gestureId: 0 })

    expect(widget.bounds).toEqual({ x: 438, y: 730, width: 124, height: 54 })
    expect(widget.setPosition).not.toHaveBeenCalled()
    expect(widget.setBounds).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)

    adapter.cursor.current = { x: 1_700, y: 970 }
    vi.advanceTimersByTime(100)

    expect(adapter.getCursorScreenPoint).toHaveBeenCalledOnce()
    expect(adapter.getDisplayNearestPoint).toHaveBeenCalledOnce()
    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_538, y: 930, width: 124, height: 54 },
      false,
    )
  })

  it('rejects a hover report from the previous visibility generation after reveal', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!

    setWidgetPresentation(manager, 'idle-hovered')
    expect(widget.bounds).toEqual({ x: 376, y: 708, width: 248, height: 76 })

    manager.hideWidget()
    widget.setBounds.mockClear()
    await manager.showWidget()

    setWidgetPresentation(manager, 'idle-hovered', 1)

    expect(widget.bounds).toEqual({ x: 438, y: 730, width: 124, height: 54 })
    expect(widget.setBounds).toHaveBeenCalledOnce()
    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 438, y: 730, width: 124, height: 54 },
      false,
    )
    expect(widget.showInactive).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('accepts a current hover after reveal when the cursor resynchronizes it', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!
    manager.hideWidget()
    await manager.showWidget()
    widget.setBounds.mockClear()
    adapter.cursor.current = { x: 500, y: 750 }

    setWidgetPresentation(manager, 'idle-hovered')

    expect(widget.bounds).toEqual({ x: 376, y: 708, width: 248, height: 76 })
    expect(widget.setBounds).toHaveBeenCalledOnce()
  })

  it('preserves an active presentation across concealment and reveal', async () => {
    const { manager, windows } = createHarness()
    await manager.showWidget()
    const widget = windows[0]!
    setWidgetPresentation(manager, 'active')
    expect(widget.bounds).toEqual({ x: 1_476, y: 896, width: 248, height: 88 })

    manager.hideWidget()
    widget.setBounds.mockClear()
    await manager.showWidget()

    expect(widget.bounds).toEqual({ x: 1_476, y: 896, width: 248, height: 88 })
    expect(widget.setBounds).not.toHaveBeenCalled()
    expect(widget.showInactive).toHaveBeenCalledTimes(2)
  })

  it('uses an active presentation published during the reveal gap', async () => {
    const { manager, windows } = createHarness()
    await manager.showWidget()
    const widget = windows[0]!
    manager.hideWidget()
    widget.setBounds.mockClear()

    const reveal = manager.showWidget()
    setWidgetPresentation(manager, 'active', 3)
    await reveal

    expect(widget.bounds).toEqual({ x: 1_476, y: 896, width: 248, height: 88 })
    expect(widget.setBounds).toHaveBeenCalledOnce()
    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_476, y: 896, width: 248, height: 88 },
      false,
    )
  })

  it('expands a vertical idle drag to the active footprint without releasing drag ownership', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({
      display: adapter.display,
      getWidgetPlacement: () => ({ kind: 'edge', edge: 'left' }),
    })
    await manager.showWidget()
    const widget = windows[0]!
    setWidgetPresentation(manager, 'idle-hovered')
    expect(widget.bounds).toEqual({ x: 16, y: 338, width: 88, height: 124 })

    reportWidgetDrag(manager, 'start')
    widget.setBounds.mockClear()
    widget.setPosition.mockClear()
    adapter.getCursorScreenPoint.mockClear()
    adapter.getDisplayNearestPoint.mockClear()
    widget.setBounds.mockImplementationOnce((bounds: Rectangle): void => {
      widget.bounds = { ...bounds, x: bounds.x + 1, y: bounds.y + 2 }
    })

    setWidgetPresentation(manager, 'active')

    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 16, y: 338, width: 88, height: 248 },
      false,
    )
    expect(widget.bounds).toEqual({ x: 17, y: 340, width: 88, height: 248 })
    expect(vi.getTimerCount()).toBe(1)

    adapter.cursor.current = { x: 1_700, y: 970 }
    vi.advanceTimersByTime(200)
    expect(adapter.getCursorScreenPoint).not.toHaveBeenCalled()
    expect(adapter.getDisplayNearestPoint).not.toHaveBeenCalled()
    expect(widget.setBounds).toHaveBeenCalledOnce()

    adapter.cursor.current = { x: 120, y: 130 }
    reportWidgetDrag(manager, 'move')
    expect(widget.setPosition).toHaveBeenCalledWith(37, 370, false)
  })

  it('shrinks a vertical active drag through idle presentations without leaving an oversized blocker', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({
      display: adapter.display,
      getWidgetPlacement: () => ({ kind: 'edge', edge: 'left' }),
    })
    await manager.showWidget()
    const widget = windows[0]!
    setWidgetPresentation(manager, 'active')
    expect(widget.bounds).toEqual({ x: 16, y: 276, width: 88, height: 248 })

    reportWidgetDrag(manager, 'start')
    widget.setBounds.mockClear()
    widget.setPosition.mockClear()

    setWidgetPresentation(manager, 'idle-hovered')
    setWidgetPresentation(manager, 'idle-resting')

    expect(widget.setBounds).toHaveBeenCalledOnce()
    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 16, y: 276, width: 88, height: 124 },
      false,
    )
    expect(widget.bounds).toEqual({ x: 16, y: 276, width: 88, height: 124 })

    adapter.cursor.current = { x: 130, y: 115 }
    reportWidgetDrag(manager, 'move')
    expect(widget.setPosition).toHaveBeenCalledWith(46, 291, false)
  })

  it.each([
    {
      initial: 'idle-hovered' as const,
      next: 'active' as const,
      initialBounds: { x: 16, y: 338, width: 88, height: 124 },
      desiredBounds: { x: 16, y: 338, width: 88, height: 248 },
    },
    {
      initial: 'active' as const,
      next: 'idle-hovered' as const,
      initialBounds: { x: 16, y: 276, width: 88, height: 248 },
      desiredBounds: { x: 16, y: 276, width: 88, height: 124 },
    },
  ])(
    'retries a failed $initial to $next resize while drag ownership is active',
    async ({ desiredBounds, initial, initialBounds, next }) => {
      const adapter = createMutableTwoDisplayAdapter()
      const { manager, windows } = createHarness({
        display: adapter.display,
        getWidgetPlacement: () => ({ kind: 'edge', edge: 'left' }),
      })
      await manager.showWidget()
      const widget = windows[0]!
      setWidgetPresentation(manager, initial)
      expect(widget.bounds).toEqual(initialBounds)

      reportWidgetDrag(manager, 'start')
      widget.setBounds.mockClear()
      adapter.getCursorScreenPoint.mockClear()
      adapter.getDisplayNearestPoint.mockClear()
      widget.setBounds.mockImplementationOnce(() => {
        throw new Error('native resize unavailable')
      })

      setWidgetPresentation(manager, next)

      expect(widget.setBounds).toHaveBeenCalledOnce()
      expect(widget.bounds).toEqual(initialBounds)

      vi.advanceTimersByTime(100)

      expect(widget.setBounds).toHaveBeenCalledTimes(2)
      expect(widget.setBounds).toHaveBeenLastCalledWith(desiredBounds, false)
      expect(widget.bounds).toEqual(desiredBounds)
      expect(adapter.getCursorScreenPoint).not.toHaveBeenCalled()
      expect(adapter.getDisplayNearestPoint).not.toHaveBeenCalled()
    },
  )

  it('retries after cursor or display lookup failure', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!
    widget.setBounds.mockClear()
    adapter.cursor.current = { x: 1_700, y: 970 }
    adapter.getCursorScreenPoint.mockImplementationOnce(() => {
      throw new Error('cursor unavailable')
    })

    vi.advanceTimersByTime(100)
    expect(widget.setBounds).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)
    expect(widget.setBounds).toHaveBeenLastCalledWith(
      { x: 1_538, y: 930, width: 124, height: 54 },
      false,
    )

    widget.setBounds.mockClear()
    adapter.cursor.current = { x: 100, y: 100 }
    adapter.getDisplayNearestPoint.mockImplementationOnce(() => {
      throw new Error('display unavailable')
    })

    vi.advanceTimersByTime(100)
    expect(widget.setBounds).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)
    expect(widget.setBounds).toHaveBeenLastCalledWith(
      { x: 438, y: 730, width: 124, height: 54 },
      false,
    )
  })

  it('retries the same target monitor after a transient bounds failure', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!
    widget.setBounds.mockClear()
    adapter.cursor.current = { x: 1_700, y: 970 }
    widget.setBounds.mockImplementationOnce(() => {
      throw new Error('native bounds unavailable')
    })

    vi.advanceTimersByTime(100)
    expect(widget.setBounds).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(100)

    expect(widget.setBounds).toHaveBeenCalledTimes(2)
    expect(widget.setBounds).toHaveBeenLastCalledWith(
      { x: 1_538, y: 930, width: 124, height: 54 },
      false,
    )
  })

  it('reapplies snapped bounds after a drag move readback failure', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    setWidgetPresentation(manager, 'idle-hovered')
    const widget = windows[0]!
    widget.setBounds.mockClear()
    widget.setPosition.mockClear()

    reportWidgetDrag(manager, 'start')
    adapter.cursor.current = { x: 200, y: 100 }
    widget.getBounds.mockImplementationOnce(() => {
      throw new Error('post-move bounds unavailable')
    })

    reportWidgetDrag(manager, 'move')

    expect(widget.setPosition).toHaveBeenCalledWith(476, 708, false)
    expect(widget.bounds).toEqual({ x: 476, y: 708, width: 248, height: 76 })

    widget.setBounds.mockClear()
    adapter.getCursorScreenPoint.mockClear()
    adapter.getDisplayNearestPoint.mockClear()
    vi.advanceTimersByTime(100)

    expect(adapter.getCursorScreenPoint).toHaveBeenCalledOnce()
    expect(adapter.getDisplayNearestPoint).toHaveBeenCalledOnce()
    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 376, y: 708, width: 248, height: 76 },
      false,
    )
    expect(widget.bounds).toEqual({ x: 376, y: 708, width: 248, height: 76 })
  })

  it('reapplies desired bounds after a moved-event readback failure', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, onWidgetMoved, windows } = createHarness({
      display: adapter.display,
    })
    await manager.showWidget()
    const widget = windows[0]!
    widget.setBounds.mockClear()
    widget.bounds = { x: 100, y: 300, width: 124, height: 54 }
    widget.getBounds.mockImplementationOnce(() => {
      throw new Error('moved bounds unavailable')
    })

    widget.emit('moved')

    expect(widget.setBounds).not.toHaveBeenCalled()
    expect(onWidgetMoved).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)

    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 438, y: 730, width: 124, height: 54 },
      false,
    )
    expect(widget.bounds).toEqual({ x: 438, y: 730, width: 124, height: 54 })
  })

  it('stops checks when hidden', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!
    widget.setBounds.mockClear()
    adapter.getCursorScreenPoint.mockClear()
    adapter.getDisplayNearestPoint.mockClear()

    manager.hideWidget()
    vi.advanceTimersByTime(200)

    expect(vi.getTimerCount()).toBe(0)
    expect(adapter.getCursorScreenPoint).not.toHaveBeenCalled()
    expect(adapter.getDisplayNearestPoint).not.toHaveBeenCalled()
    expect(widget.setBounds).not.toHaveBeenCalled()
  })

  it('does not reveal after hide wins an in-flight widget load', async () => {
    const rendererLoad = createDeferred<void>()
    const { manager, windows } = createHarness({}, (window) => {
      window.loadFile.mockImplementationOnce(() => rendererLoad.promise)
    })

    const reveal = manager.showWidget()
    const widget = windows[0]!

    manager.hideWidget()
    rendererLoad.resolve()
    await reveal

    expect(widget.hide).toHaveBeenCalledOnce()
    expect(widget.webContents.send.mock.calls.filter(
      ([channel]) => channel === WIDGET_VISIBILITY,
    )).toHaveLength(0)
    expect(widget.showInactive).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    manager.hideWidget()
    expect(widget.webContents.send.mock.calls.filter(
      ([channel]) => channel === WIDGET_VISIBILITY,
    )).toHaveLength(0)
  })

  it('rolls back a failed native reveal so a later reveal retries and restarts monitoring', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness(
      { display: adapter.display },
      (window) => {
        window.showInactive.mockImplementationOnce(() => {
          throw new Error('native reveal failed')
        })
      },
    )

    await expect(manager.showWidget()).rejects.toThrow('native reveal failed')
    const widget = windows[0]!

    expect(widget.webContents.send).toHaveBeenNthCalledWith(
      1,
      WIDGET_VISIBILITY,
      { visible: true, generation: 1 },
    )
    expect(widget.webContents.send).toHaveBeenNthCalledWith(
      2,
      WIDGET_VISIBILITY,
      { visible: false, generation: 2 },
    )
    expect(widget.showInactive).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)

    widget.getBounds.mockClear()
    reportWidgetDrag(manager, 'start')
    expect(widget.getBounds).not.toHaveBeenCalled()

    await manager.showWidget()

    expect(widget.webContents.send).toHaveBeenNthCalledWith(
      3,
      WIDGET_VISIBILITY,
      { visible: true, generation: 3 },
    )
    expect(widget.showInactive).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)

    widget.setBounds.mockClear()
    adapter.cursor.current = { x: 1_700, y: 970 }
    vi.advanceTimersByTime(100)

    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_538, y: 930, width: 124, height: 54 },
      false,
    )
  })

  it('rejects late drag reports while hidden and resumes reveal monitoring', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!

    manager.hideWidget()
    reportWidgetDrag(manager, 'start')
    reportWidgetDrag(manager, 'move')
    await manager.showWidget()

    expect(widget.showInactive).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)

    widget.setBounds.mockClear()
    widget.setPosition.mockClear()
    adapter.getCursorScreenPoint.mockClear()
    adapter.getDisplayNearestPoint.mockClear()

    reportWidgetDrag(manager, 'move')
    expect(widget.setPosition).not.toHaveBeenCalled()

    adapter.cursor.current = { x: 1_700, y: 970 }
    vi.advanceTimersByTime(100)

    expect(adapter.getCursorScreenPoint).toHaveBeenCalledOnce()
    expect(adapter.getDisplayNearestPoint).toHaveBeenCalledOnce()
    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_538, y: 930, width: 124, height: 54 },
      false,
    )
  })

  it('stops checks when widget closes or renderer is lost', async () => {
    const closedAdapter = createMutableTwoDisplayAdapter()
    const closedHarness = createHarness({ display: closedAdapter.display })
    await closedHarness.manager.showWidget()
    closedAdapter.getCursorScreenPoint.mockClear()
    closedAdapter.getDisplayNearestPoint.mockClear()

    closedHarness.windows[0]!.emit('closed')
    vi.advanceTimersByTime(200)

    expect(vi.getTimerCount()).toBe(0)
    expect(closedAdapter.getCursorScreenPoint).not.toHaveBeenCalled()
    expect(closedAdapter.getDisplayNearestPoint).not.toHaveBeenCalled()

    const lostAdapter = createMutableTwoDisplayAdapter()
    const lostHarness = createHarness({ display: lostAdapter.display })
    await lostHarness.manager.showWidget()
    lostAdapter.getCursorScreenPoint.mockClear()
    lostAdapter.getDisplayNearestPoint.mockClear()

    lostHarness.windows[0]!.emitRenderProcessGone()
    vi.advanceTimersByTime(200)

    expect(vi.getTimerCount()).toBe(0)
    expect(lostAdapter.getCursorScreenPoint).not.toHaveBeenCalled()
    expect(lostAdapter.getDisplayNearestPoint).not.toHaveBeenCalled()
  })

  it('stops checks when WindowManager is disposed', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!
    widget.setBounds.mockClear()
    adapter.getCursorScreenPoint.mockClear()
    adapter.getDisplayNearestPoint.mockClear()

    manager.dispose()
    vi.advanceTimersByTime(200)

    expect(vi.getTimerCount()).toBe(0)
    expect(adapter.getCursorScreenPoint).not.toHaveBeenCalled()
    expect(adapter.getDisplayNearestPoint).not.toHaveBeenCalled()
    expect(widget.setBounds).not.toHaveBeenCalled()
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

  it('brackets main-window visibility with dock presence', async () => {
    const events: string[] = []
    const dock = {
      show: vi.fn(() => {
        events.push('dock:show')
      }),
      hide: vi.fn(() => {
        events.push('dock:hide')
      }),
    }
    const { manager, windows } = createHarness({ dock }, (window) => {
      window.show.mockImplementation(() => {
        events.push('window:show')
      })
      window.hide.mockImplementation(() => {
        events.push('window:hide')
      })
    })

    await manager.showMain()
    manager.hideMain()
    await manager.showMain()
    windows[0]!.emit('close')

    expect(events).toEqual([
      'dock:show',
      'window:show',
      'window:hide',
      'dock:hide',
      'dock:show',
      'window:show',
      'window:hide',
      'dock:hide',
    ])
  })

  it('keeps showing and hiding the main window where there is no runtime dock', async () => {
    const { manager, windows } = createHarness({ dock: null })

    await manager.showMain()
    manager.hideMain()

    expect(windows[0]!.show).toHaveBeenCalledOnce()
    expect(windows[0]!.hide).toHaveBeenCalledOnce()
  })

  it('contains a failing dock so window visibility still changes', async () => {
    const dock = {
      show: vi.fn(() => {
        throw new Error('dock unavailable')
      }),
      hide: vi.fn(() => {
        throw new Error('dock unavailable')
      }),
    }
    const { manager, windows } = createHarness({ dock })

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

  it('constructs the widget at the bottom idle-resting footprint', async () => {
    const { manager, options, windows } = createHarness()

    await manager.createWidgetWindow()

    expect(options[0]).toMatchObject({ width: 124, height: 54 })
    expect(windows[0]!.setIgnoreMouseEvents).not.toHaveBeenCalled()
  })

  it('applies presentation changes through one bounds path', async () => {
    const { manager, windows } = createHarness()
    await manager.showWidget()
    const widget = windows[0]!
    widget.setBounds.mockClear()
    widget.setPosition.mockClear()
    widget.setSize.mockClear()

    setWidgetPresentation(manager, 'idle-hovered')
    setWidgetPresentation(manager, 'active')

    expect(widget.setBounds.mock.calls).toStrictEqual([
      [{ x: 1_476, y: 908, width: 248, height: 76 }, false],
      [{ x: 1_476, y: 896, width: 248, height: 88 }, false],
    ])
    expect(widget.setPosition).not.toHaveBeenCalled()
    expect(widget.setSize).not.toHaveBeenCalled()
  })

  it('preserves the selected edge and center while presentation changes', async () => {
    const { manager, onWidgetMoved, windows } = createHarness({
      getWidgetPlacement: () => ({ kind: 'edge', edge: 'left' }),
    })
    await manager.showWidget()
    const widget = windows[0]!

    expect(widget.setBounds).toHaveBeenLastCalledWith(
      { x: 1_016, y: 488, width: 54, height: 124 },
      false,
    )

    setWidgetPresentation(manager, 'active')

    expect(widget.setBounds).toHaveBeenLastCalledWith(
      { x: 1_016, y: 426, width: 88, height: 248 },
      false,
    )
    expect(onWidgetMoved).not.toHaveBeenCalled()
  })

  it('skips native work when desired bounds already match', async () => {
    const { manager, windows } = createHarness()
    await manager.showWidget()
    const widget = windows[0]!

    await manager.showWidget()
    setWidgetPresentation(manager, 'idle-resting')
    manager.hideWidget()
    await manager.showWidget()

    expect(widget.setBounds).toHaveBeenCalledOnce()
    expect(widget.showInactive).toHaveBeenCalledTimes(2)
  })

  it('reads back applied bounds and retries a mismatched native result', async () => {
    const { manager, windows } = createHarness()
    await manager.createWidgetWindow()
    const widget = windows[0]!
    widget.setBounds.mockImplementationOnce((bounds: Rectangle): void => {
      widget.bounds = { ...bounds, height: bounds.height + 2 }
      widget.setBoundsCalls.push({ ...widget.bounds })
    })

    await manager.showWidget()
    expect(widget.bounds).toEqual({ x: 1_538, y: 930, width: 124, height: 56 })

    await manager.showWidget()

    expect(widget.setBounds).toHaveBeenCalledTimes(2)
    expect(widget.bounds).toEqual({ x: 1_538, y: 930, width: 124, height: 54 })
  })

  it('loads remembered placement once', async () => {
    const getWidgetPlacement = vi.fn<() => StoredWidgetPlacement | null>(() => ({
      kind: 'edge',
      edge: 'top',
    }))
    const { manager } = createHarness({ getWidgetPlacement })

    await manager.showWidget()
    await manager.showWidget()
    setWidgetPresentation(manager, 'active')

    expect(getWidgetPlacement).toHaveBeenCalledOnce()
  })

  it('migrates a legacy point to a centered edge', async () => {
    const { manager, onWidgetMoved, windows } = createHarness({
      getWidgetPlacement: () => ({ kind: 'point', x: 1_100, y: 300 }),
    })

    await manager.showWidget()

    expect(windows[0]!.setBounds).toHaveBeenCalledWith(
      { x: 1_016, y: 488, width: 54, height: 124 },
      false,
    )
    expect(onWidgetMoved).toHaveBeenCalledOnce()
    expect(onWidgetMoved).toHaveBeenCalledWith({ edge: 'left' })
  })

  it('uses the current idle-resting footprint when migrating a legacy point', async () => {
    const { manager, onWidgetMoved, windows } = createHarness({
      getWidgetPlacement: () => ({ kind: 'point', x: 5, y: 708 }),
      display: {
        getCursorScreenPoint: () => ({ x: 500, y: 400 }),
        getDisplayNearestPoint: () => ({
          workArea: { x: 0, y: 0, width: 1_000, height: 800 },
        }),
      },
    })

    await manager.showWidget()

    expect(windows[0]!.setBounds).toHaveBeenCalledWith(
      { x: 16, y: 338, width: 54, height: 124 },
      false,
    )
    expect(onWidgetMoved).toHaveBeenCalledWith({ edge: 'left' })
  })

  it('falls back to centered bottom after storage or display failure', async () => {
    const storageFailure = createHarness({
      getWidgetPlacement: () => {
        throw new Error('placement store unavailable')
      },
    })
    await storageFailure.manager.showWidget()
    expect(storageFailure.windows[0]!.setBounds).toHaveBeenCalledWith(
      { x: 1_538, y: 930, width: 124, height: 54 },
      false,
    )

    let displayLookup = 0
    const displayFailure = createHarness({
      getWidgetPlacement: () => ({ kind: 'point', x: 1_100, y: 300 }),
      display: {
        getCursorScreenPoint: () => ({ x: 1_700, y: 970 }),
        getDisplayNearestPoint: () => {
          displayLookup += 1
          if (displayLookup === 1) throw new Error('legacy display unavailable')
          return { workArea: { x: 1_000, y: 100, width: 1_200, height: 900 } }
        },
      },
    })
    await displayFailure.manager.showWidget()
    expect(displayFailure.windows[0]!.setBounds).toHaveBeenCalledWith(
      { x: 1_538, y: 930, width: 124, height: 54 },
      false,
    )
    expect(displayFailure.onWidgetMoved).not.toHaveBeenCalled()
  })

  it('suppresses moved events caused by coordinator bounds', async () => {
    const { manager, onWidgetMoved, windows } = createHarness(
      {},
      (window) => {
        window.emitMovedOnSetBounds = true
      },
    )

    await manager.showWidget()

    expect(windows[0]!.setBounds).toHaveBeenCalledOnce()
    expect(onWidgetMoved).not.toHaveBeenCalled()
  })

  it('ignores native moved events while the widget is hidden', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, onWidgetMoved, windows } = createHarness({
      display: adapter.display,
    })
    await manager.showWidget()
    const widget = windows[0]!

    manager.hideWidget()
    widget.setBounds.mockClear()
    onWidgetMoved.mockClear()
    widget.bounds = { x: 100, y: 300, width: 124, height: 54 }

    widget.emit('moved')

    expect(widget.setBounds).not.toHaveBeenCalled()
    expect(onWidgetMoved).not.toHaveBeenCalled()
    expect(widget.bounds).toEqual({ x: 100, y: 300, width: 124, height: 54 })
  })

  it('reapplies the remembered edge after a hidden native move', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!

    manager.hideWidget()
    widget.bounds = { x: 100, y: 300, width: 124, height: 54 }
    widget.emit('moved')
    widget.setBounds.mockClear()

    await manager.showWidget()

    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 438, y: 730, width: 124, height: 54 },
      false,
    )
  })

  it('snaps a genuinely external move without recursion', async () => {
    const { manager, onWidgetMoved, windows } = createHarness(
      {},
      (window) => {
        window.emitMovedOnSetBounds = true
      },
    )
    await manager.showWidget()
    const widget = windows[0]!
    widget.setBounds.mockClear()
    onWidgetMoved.mockClear()
    widget.bounds = { x: 1_234, y: 567, width: 124, height: 54 }

    widget.emit('moved')

    expect(widget.setBounds).toHaveBeenCalledOnce()
    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_016, y: 488, width: 54, height: 124 },
      false,
    )
    expect(onWidgetMoved).toHaveBeenCalledOnce()
    expect(onWidgetMoved).toHaveBeenCalledWith({ edge: 'left' })
  })

  it('shows the widget without activation inside the active work area', async () => {
    const { manager, windows } = createHarness()
    await manager.createWidgetWindow()
    const widget = windows[0]!

    await manager.showWidget()

    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_538, y: 930, width: 124, height: 54 },
      false,
    )
    expect(widget.showInactive).toHaveBeenCalledOnce()
    expect(widget.show).not.toHaveBeenCalled()
    expect(widget.focus).not.toHaveBeenCalled()
  })

  it('shows the native widget once per visibility transition', async () => {
    const { manager, windows } = createHarness()
    await manager.createWidgetWindow()
    const widget = windows[0]!

    await manager.showWidget()
    await manager.showWidget()
    await manager.showWidget()

    expect(widget.setBounds).toHaveBeenCalledTimes(1)
    expect(widget.showInactive).toHaveBeenCalledTimes(1)

    manager.hideWidget()
    await manager.showWidget()

    expect(widget.setBounds).toHaveBeenCalledTimes(1)
    expect(widget.showInactive).toHaveBeenCalledTimes(2)
  })

  it('notifies the widget renderer before every native visibility transition', async () => {
    const { manager, windows } = createHarness()
    await manager.showWidget()
    const widget = windows[0]!

    expect(widget.webContents.send).toHaveBeenCalledWith(
      WIDGET_VISIBILITY,
      { visible: true, generation: 1 },
    )

    manager.hideWidget()

    expect(widget.webContents.send).toHaveBeenLastCalledWith(
      WIDGET_VISIBILITY,
      { visible: false, generation: 2 },
    )
    expect(widget.webContents.send.mock.invocationCallOrder.at(-1)).toBeLessThan(
      widget.hide.mock.invocationCallOrder[0]!,
    )
  })

  it('centers an edge-only stored placement instead of restoring a legacy offset', async () => {
    const { manager, windows } = createHarness({
      getWidgetPlacement: () => ({ kind: 'edge', edge: 'left' }),
    })
    await manager.createWidgetWindow()

    await manager.showWidget()

    expect(windows[0]!.setBounds).toHaveBeenCalledWith(
      { x: 1_016, y: 488, width: 54, height: 124 },
      false,
    )
  })

  it('chooses the nearest edge for a legacy point and centers it', async () => {
    const { manager, onWidgetMoved, windows } = createHarness({
      getWidgetPlacement: () => ({ kind: 'point', x: 1_100, y: 300 }),
    })
    await manager.createWidgetWindow()

    await manager.showWidget()

    expect(windows[0]!.setBounds).toHaveBeenCalledWith(
      { x: 1_016, y: 488, width: 54, height: 124 },
      false,
    )
    expect(onWidgetMoved).toHaveBeenCalledWith({ edge: 'left' })
  })

  it('centers a legacy remembered point that no longer fits any display work area', async () => {
    const { manager, windows } = createHarness({
      getWidgetPlacement: () => ({ kind: 'point', x: 5_000, y: 5_000 }),
    })
    await manager.createWidgetWindow()

    await manager.showWidget()

    expect(windows[0]!.setBounds).toHaveBeenCalledWith(
      { x: 1_538, y: 930, width: 124, height: 54 },
      false,
    )
  })

  it('falls back to the default anchor when reading the remembered position throws', async () => {
    const { manager, windows } = createHarness({
      getWidgetPlacement: () => {
        throw new Error('placement store unavailable')
      },
    })
    await manager.createWidgetWindow()

    await manager.showWidget()

    expect(windows[0]!.setBounds).toHaveBeenCalledWith(
      { x: 1_538, y: 930, width: 124, height: 54 },
      false,
    )
  })

  it('expands a resting idle widget before recording the drag origin', async () => {
    const { manager, windows } = createHarness()
    await manager.showWidget()
    const widget = windows[0]!
    widget.setBounds.mockClear()
    widget.getBounds.mockClear()

    reportWidgetDrag(manager, 'start')
    setWidgetPresentation(manager, 'idle-hovered')

    expect(widget.setBounds).toHaveBeenCalledOnce()
    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_476, y: 908, width: 248, height: 76 },
      false,
    )
    expect(widget.bounds).toEqual({ x: 1_476, y: 908, width: 248, height: 76 })
    expect(widget.setBounds.mock.invocationCallOrder[0]).toBeLessThan(
      widget.getBounds.mock.invocationCallOrder[0]!,
    )
  })

  it('does not acquire drag ownership when resting expansion fails', async () => {
    const { manager, onWidgetMoved, windows } = createHarness()
    await manager.showWidget()
    const widget = windows[0]!
    widget.setBounds.mockClear()
    widget.setPosition.mockClear()
    widget.setBounds.mockImplementationOnce(() => {
      throw new Error('native expansion unavailable')
    })

    reportWidgetDrag(manager, 'start')
    reportWidgetDrag(manager, 'move')
    reportWidgetDrag(manager, 'end')

    expect(widget.setBounds).toHaveBeenCalledOnce()
    expect(widget.setPosition).not.toHaveBeenCalled()
    expect(onWidgetMoved).not.toHaveBeenCalled()
  })

  it('records native window and Electron cursor origins on start', async () => {
    const cursor = { current: { x: 1_700, y: 970 } }
    const getCursorScreenPoint = vi.fn(() => ({ ...cursor.current }))
    const { manager, windows } = createHarness({
      display: {
        getCursorScreenPoint,
        getDisplayNearestPoint: () => ({
          workArea: { x: 1_000, y: 100, width: 1_200, height: 900 },
        }),
      },
    })
    await manager.showWidget()
    setWidgetPresentation(manager, 'idle-hovered')
    const widget = windows[0]!
    widget.bounds = { x: 1_200, y: 500, width: 248, height: 76 }
    getCursorScreenPoint.mockClear()

    reportWidgetDrag(manager, 'start')
    widget.bounds = { x: 1_400, y: 700, width: 248, height: 76 }
    cursor.current = { x: 1_730, y: 950 }
    reportWidgetDrag(manager, 'move')

    expect(widget.getBounds).toHaveBeenCalled()
    expect(getCursorScreenPoint).toHaveBeenCalledTimes(2)
    expect(widget.setPosition).toHaveBeenCalledWith(1_230, 480, false)
  })

  it('moves from Electron cursor deltas without renderer coordinates', async () => {
    const cursor = { current: { x: 1_700, y: 970 } }
    const { manager, windows } = createHarness({
      display: {
        getCursorScreenPoint: () => ({ ...cursor.current }),
        getDisplayNearestPoint: () => ({
          workArea: { x: 1_000, y: 100, width: 1_200, height: 900 },
        }),
      },
    })
    await manager.showWidget()
    setWidgetPresentation(manager, 'idle-hovered')
    const widget = windows[0]!
    widget.bounds = { x: 1_200, y: 500, width: 248, height: 76 }

    reportWidgetDrag(manager, 'start')
    cursor.current = { x: 1_730, y: 950 }
    reportWidgetDrag(manager, 'move')
    cursor.current = { x: 1_710, y: 975 }
    reportWidgetDrag(manager, 'move')

    expect(widget.setPosition.mock.calls).toStrictEqual([
      [1_230, 480, false],
      [1_210, 505, false],
    ])
  })

  it('replaces stale ownership on repeated start', async () => {
    const cursor = { current: { x: 100, y: 100 } }
    const { manager, windows } = createHarness({
      display: {
        getCursorScreenPoint: () => ({ ...cursor.current }),
        getDisplayNearestPoint: () => ({
          workArea: { x: 1_000, y: 100, width: 1_200, height: 900 },
        }),
      },
    })
    await manager.showWidget()
    setWidgetPresentation(manager, 'idle-hovered')
    const widget = windows[0]!
    widget.bounds = { x: 1_200, y: 500, width: 248, height: 76 }

    reportWidgetDrag(manager, 'start')
    widget.bounds = { x: 1_400, y: 700, width: 248, height: 76 }
    cursor.current = { x: 300, y: 200 }
    reportWidgetDrag(manager, 'start')
    cursor.current = { x: 315, y: 180 }
    reportWidgetDrag(manager, 'move')

    expect(widget.setPosition).toHaveBeenCalledOnce()
    expect(widget.setPosition).toHaveBeenCalledWith(1_415, 680, false)
  })

  it('ignores a delayed end from an earlier gesture in the current visibility generation', async () => {
    const cursor = { current: { x: 100, y: 100 } }
    const { manager, windows } = createHarness({
      display: {
        getCursorScreenPoint: () => ({ ...cursor.current }),
        getDisplayNearestPoint: () => ({
          workArea: { x: 1_000, y: 100, width: 1_200, height: 900 },
        }),
      },
    })
    await manager.showWidget()
    setWidgetPresentation(manager, 'idle-hovered')
    const widget = windows[0]!
    widget.bounds = { x: 1_200, y: 500, width: 248, height: 76 }
    const generation = currentWidgetVisibilityGeneration(manager)
    const drag = generationBound(manager)

    drag.reportWidgetDrag({ phase: 'start', generation, gestureId: 1 })
    widget.bounds = { x: 1_400, y: 700, width: 248, height: 76 }
    cursor.current = { x: 300, y: 200 }
    drag.reportWidgetDrag({ phase: 'start', generation, gestureId: 2 })
    drag.reportWidgetDrag({ phase: 'end', generation, gestureId: 1 })
    cursor.current = { x: 315, y: 180 }
    drag.reportWidgetDrag({ phase: 'move', generation, gestureId: 2 })

    expect(widget.setPosition).toHaveBeenCalledOnce()
    expect(widget.setPosition).toHaveBeenCalledWith(1_415, 680, false)
  })

  it('ignores move and end without ownership', async () => {
    const getCursorScreenPoint = vi.fn(() => ({ x: 1_700, y: 970 }))
    const getDisplayNearestPoint = vi.fn(() => ({
      workArea: { x: 1_000, y: 100, width: 1_200, height: 900 },
    }))
    const { manager, onWidgetMoved, windows } = createHarness({
      display: { getCursorScreenPoint, getDisplayNearestPoint },
    })
    await manager.createWidgetWindow()
    const widget = windows[0]!
    widget.getBounds.mockClear()

    reportWidgetDrag(manager, 'move')
    reportWidgetDrag(manager, 'end')

    expect(getCursorScreenPoint).not.toHaveBeenCalled()
    expect(getDisplayNearestPoint).not.toHaveBeenCalled()
    expect(widget.getBounds).not.toHaveBeenCalled()
    expect(widget.setPosition).not.toHaveBeenCalled()
    expect(widget.setBounds).not.toHaveBeenCalled()
    expect(onWidgetMoved).not.toHaveBeenCalled()
  })

  it('snaps on the display containing the native window center', async () => {
    const cursor = { current: { x: 100, y: 100 } }
    const getDisplayNearestPoint = vi.fn((point: { readonly x: number }) => ({
      workArea: point.x < 1_000 ? monitorWorkAreas.left : monitorWorkAreas.right,
    }))
    const { manager, windows } = createHarness({
      display: {
        getCursorScreenPoint: () => ({ ...cursor.current }),
        getDisplayNearestPoint,
      },
    })
    await manager.showWidget()
    setWidgetPresentation(manager, 'idle-hovered')
    const widget = windows[0]!
    widget.bounds = { x: 1_100, y: 300, width: 248, height: 76 }
    widget.setBounds.mockClear()

    reportWidgetDrag(manager, 'start')
    getDisplayNearestPoint.mockClear()
    reportWidgetDrag(manager, 'end')

    expect(getDisplayNearestPoint).toHaveBeenCalledWith({ x: 1_224, y: 338 })
    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_016, y: 488, width: 88, height: 124 },
      false,
    )
  })

  it('persists only the selected edge', async () => {
    const { manager, onWidgetMoved, windows } = createHarness()
    await manager.showWidget()
    setWidgetPresentation(manager, 'idle-hovered')
    const widget = windows[0]!
    widget.bounds = { x: 1_100, y: 300, width: 248, height: 76 }

    reportWidgetDrag(manager, 'start')
    reportWidgetDrag(manager, 'end')

    expect(onWidgetMoved).toHaveBeenCalledOnce()
    expect(onWidgetMoved).toHaveBeenCalledWith({ edge: 'left' })
  })

  it('centers the current presentation after orientation changes', async () => {
    const { manager, windows } = createHarness()
    await manager.showWidget()
    setWidgetPresentation(manager, 'active')
    const widget = windows[0]!
    widget.bounds = { x: 1_100, y: 300, width: 248, height: 88 }
    widget.setBounds.mockClear()

    reportWidgetDrag(manager, 'start')
    reportWidgetDrag(manager, 'end')

    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_016, y: 426, width: 88, height: 248 },
      false,
    )
  })

  it('clears ownership after cursor or native movement failure', async () => {
    const cursorAdapter = createMutableTwoDisplayAdapter()
    const cursorFailure = createHarness({ display: cursorAdapter.display })
    await cursorFailure.manager.showWidget()
    setWidgetPresentation(cursorFailure.manager, 'idle-hovered')
    const cursorFailureWidget = cursorFailure.windows[0]!
    cursorFailureWidget.setBounds.mockClear()
    reportWidgetDrag(cursorFailure.manager, 'start')
    cursorAdapter.getCursorScreenPoint.mockClear()
    cursorAdapter.failures.cursor = new Error('cursor unavailable')

    reportWidgetDrag(cursorFailure.manager, 'move')
    reportWidgetDrag(cursorFailure.manager, 'move')
    reportWidgetDrag(cursorFailure.manager, 'end')

    expect(cursorAdapter.getCursorScreenPoint).toHaveBeenCalledOnce()
    expect(cursorFailureWidget.setPosition).not.toHaveBeenCalled()
    expect(cursorFailureWidget.setBounds).not.toHaveBeenCalled()
    expect(cursorFailure.onWidgetMoved).not.toHaveBeenCalled()

    const nativeFailure = createHarness()
    await nativeFailure.manager.showWidget()
    setWidgetPresentation(nativeFailure.manager, 'idle-hovered')
    const nativeFailureWidget = nativeFailure.windows[0]!
    nativeFailureWidget.setBounds.mockClear()
    nativeFailureWidget.setPosition.mockImplementationOnce(() => {
      throw new Error('native movement unavailable')
    })
    reportWidgetDrag(nativeFailure.manager, 'start')

    reportWidgetDrag(nativeFailure.manager, 'move')
    reportWidgetDrag(nativeFailure.manager, 'move')
    reportWidgetDrag(nativeFailure.manager, 'end')

    expect(nativeFailureWidget.setPosition).toHaveBeenCalledOnce()
    expect(nativeFailureWidget.setBounds).not.toHaveBeenCalled()
    expect(nativeFailure.onWidgetMoved).not.toHaveBeenCalled()
  })

  it('clears ownership when hidden closed or renderer is lost', async () => {
    const hidden = createHarness()
    await hidden.manager.showWidget()
    setWidgetPresentation(hidden.manager, 'idle-hovered')
    hidden.windows[0]!.setBounds.mockClear()
    reportWidgetDrag(hidden.manager, 'start')
    hidden.manager.hideWidget()
    reportWidgetDrag(hidden.manager, 'end')
    expect(hidden.windows[0]!.setBounds).not.toHaveBeenCalled()
    expect(hidden.onWidgetMoved).not.toHaveBeenCalled()

    const closed = createHarness()
    await closed.manager.showWidget()
    setWidgetPresentation(closed.manager, 'idle-hovered')
    closed.windows[0]!.setBounds.mockClear()
    reportWidgetDrag(closed.manager, 'start')
    closed.windows[0]!.emit('closed')
    reportWidgetDrag(closed.manager, 'end')
    expect(closed.windows[0]!.setBounds).not.toHaveBeenCalled()
    expect(closed.onWidgetMoved).not.toHaveBeenCalled()

    const rendererLost = createHarness()
    await rendererLost.manager.showWidget()
    setWidgetPresentation(rendererLost.manager, 'idle-hovered')
    rendererLost.windows[0]!.setBounds.mockClear()
    reportWidgetDrag(rendererLost.manager, 'start')
    rendererLost.windows[0]!.emitRenderProcessGone()
    reportWidgetDrag(rendererLost.manager, 'end')
    expect(rendererLost.windows[0]!.setBounds).not.toHaveBeenCalled()
    expect(rendererLost.onWidgetMoved).not.toHaveBeenCalled()

    const disposed = createHarness()
    await disposed.manager.showWidget()
    setWidgetPresentation(disposed.manager, 'idle-hovered')
    disposed.windows[0]!.setBounds.mockClear()
    reportWidgetDrag(disposed.manager, 'start')
    disposed.manager.dispose()
    reportWidgetDrag(disposed.manager, 'end')
    expect(disposed.windows[0]!.setBounds).not.toHaveBeenCalled()
    expect(disposed.onWidgetMoved).not.toHaveBeenCalled()
  })

  it('resumes monitor following after every terminal path', async () => {
    vi.useFakeTimers()
    try {
      const terminalPaths: Array<
        (
          manager: WindowManager,
          widget: FakeWindow,
          adapter: ReturnType<typeof createMutableTwoDisplayAdapter>,
        ) => void
      > = [
        (manager) => {
          reportWidgetDrag(manager, 'end')
        },
        (manager, _widget, adapter) => {
          adapter.failures.cursor = new Error('cursor unavailable')
          reportWidgetDrag(manager, 'move')
        },
        (manager, widget) => {
          widget.setPosition.mockImplementationOnce(() => {
            throw new Error('native movement unavailable')
          })
          reportWidgetDrag(manager, 'move')
        },
        (manager, widget) => {
          widget.getBounds.mockImplementationOnce(() => {
            throw new Error('native bounds unavailable')
          })
          reportWidgetDrag(manager, 'end')
        },
        (manager, _widget, adapter) => {
          adapter.failures.display = new Error('display unavailable')
          reportWidgetDrag(manager, 'end')
        },
      ]

      for (const finishDrag of terminalPaths) {
        const adapter = createMutableTwoDisplayAdapter()
        const { manager, windows } = createHarness({ display: adapter.display })
        await manager.showWidget()
        const widget = windows[0]!
        reportWidgetDrag(manager, 'start')

        finishDrag(manager, widget, adapter)
        widget.setBounds.mockClear()
        adapter.getCursorScreenPoint.mockClear()
        adapter.getDisplayNearestPoint.mockClear()
        adapter.cursor.current = { x: 1_700, y: 970 }
        vi.advanceTimersByTime(100)

        expect(adapter.getCursorScreenPoint).toHaveBeenCalledOnce()
        expect(adapter.getDisplayNearestPoint).toHaveBeenCalledOnce()
        expect(widget.setBounds).toHaveBeenCalledWith(
          { x: 1_476, y: 908, width: 248, height: 76 },
          false,
        )
        manager.dispose()
      }
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('native drag-end snap failure clears ownership and the next monitor tick recovers', async () => {
    vi.useFakeTimers()
    try {
      const adapter = createMutableTwoDisplayAdapter()
      const { manager, onWidgetMoved, windows } = createHarness({ display: adapter.display })
      await manager.showWidget()
      const widget = windows[0]!
      reportWidgetDrag(manager, 'start')
      widget.setBounds.mockClear()
      widget.bounds = { x: 100, y: 300, width: 124, height: 54 }
      widget.setBounds.mockImplementationOnce(() => {
        throw new Error('native snap unavailable')
      })

      reportWidgetDrag(manager, 'end')
      reportWidgetDrag(manager, 'end')

      expect(widget.setBounds).toHaveBeenCalledOnce()
      expect(widget.setBounds).toHaveBeenLastCalledWith(
        { x: 16, y: 338, width: 88, height: 124 },
        false,
      )
      expect(onWidgetMoved).toHaveBeenCalledWith({ edge: 'left' })

      widget.setBounds.mockClear()
      adapter.getCursorScreenPoint.mockClear()
      adapter.getDisplayNearestPoint.mockClear()
      vi.advanceTimersByTime(100)

      expect(adapter.getCursorScreenPoint).toHaveBeenCalledOnce()
      expect(adapter.getDisplayNearestPoint).toHaveBeenCalledOnce()
      expect(widget.setBounds).toHaveBeenCalledWith(
        { x: 16, y: 338, width: 88, height: 124 },
        false,
      )
      expect(widget.bounds).toEqual({ x: 16, y: 338, width: 88, height: 124 })
      manager.dispose()
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('ignores drag reports without a widget window', () => {
    const { manager } = createHarness()

    expect(() => reportWidgetDrag(manager, 'start')).not.toThrow()
    expect(() => reportWidgetDrag(manager, 'move')).not.toThrow()
    expect(() => reportWidgetDrag(manager, 'end')).not.toThrow()
  })

  it('starts interactive and still honors explicit interactivity requests', async () => {
    const { manager, windows } = createHarness()
    await manager.createWidgetWindow()
    const widget = windows[0]!

    expect(widget.setIgnoreMouseEvents).not.toHaveBeenCalled()

    manager.setWidgetMouseInteractive(true)
    expect(widget.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)

    manager.setWidgetMouseInteractive(false)
    expect(widget.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true })
  })

  it('ignores interactivity requests without a widget window', () => {
    const { manager } = createHarness()

    expect(() => manager.setWidgetMouseInteractive(true)).not.toThrow()
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

  it('centers the idle footprint in a small negative-coordinate work area', async () => {
    const { manager, windows } = createHarness({
      display: {
        getCursorScreenPoint: () => ({ x: -1_900, y: -900 }),
        getDisplayNearestPoint: () => ({
          workArea: { x: -2_000, y: -1_000, width: 200, height: 90 },
        }),
      },
    })
    await manager.createWidgetWindow()

    await manager.showWidget()

    expect(windows[0]!.setBounds).toHaveBeenCalledWith(
      { x: -1_962, y: -980, width: 124, height: 54 },
      false,
    )
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
    expect(windows[1]!.removedListeners).toStrictEqual(['closed', 'moved'])
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
    expect(windows[1]!.loadFile).toHaveBeenCalledWith('C:/Sotto/out/renderer/index.html')
    expect(windows[1]!.show).toHaveBeenCalledOnce()
    expect(windows[1]!.focus).toHaveBeenCalledOnce()
  })

  it('reports renderer loss through the public lifecycle seam and contains handler details', async () => {
    const onRendererProcessGone = vi.fn(() => {
      throw new Error('private renderer crash detail')
    })
    const { log, manager, windows } = createHarness({ onRendererProcessGone })
    await manager.createMainWindow()

    expect(() => windows[0]!.emitRenderProcessGone()).not.toThrow()

    expect(onRendererProcessGone).toHaveBeenCalledWith('main')
    expect(log).toHaveBeenCalledWith('renderer-process-gone-handler-failed:main')
    expect(JSON.stringify(log.mock.calls)).not.toContain('private renderer crash detail')
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
        url: 'file:///C:/Sotto/out/renderer/index.html',
      },
      {
        role: 'widget',
        webContents: originalWidget.webContents,
        url: 'file:///C:/Sotto/out/renderer/index.html',
      },
    ])

    originalMain.emitRenderProcessGone()
    expect(manager.getTrustedRenderers()).toStrictEqual([
      {
        role: 'widget',
        webContents: originalWidget.webContents,
        url: 'file:///C:/Sotto/out/renderer/index.html',
      },
    ])

    await manager.createMainWindow()
    expect(manager.getTrustedRenderers()).toStrictEqual([
      {
        role: 'main',
        webContents: windows[2]!.webContents,
        url: 'file:///C:/Sotto/out/renderer/index.html',
      },
      {
        role: 'widget',
        webContents: originalWidget.webContents,
        url: 'file:///C:/Sotto/out/renderer/index.html',
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
    expect(crashed.removedListeners).toStrictEqual(['closed', 'moved'])
    expect(crashed.webContents.removeListener).toHaveBeenCalledTimes(3)
    expect(crashed.removeRenderProcessGoneListener).toHaveBeenCalledOnce()
    expect(manager.getWidgetWebContents()).toBeNull()

    await manager.showWidget()

    expect(createWindow).toHaveBeenCalledTimes(2)
    expect(windows[1]!.loadFile).toHaveBeenCalledWith('C:/Sotto/out/renderer/widget.html')
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
    expect(windows[0]!.loadFile).toHaveBeenCalledWith('C:/Sotto/out/renderer/index.html')
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
    expect(windows[0]!.loadFile).toHaveBeenCalledWith('C:/Sotto/out/renderer/index.html')
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
