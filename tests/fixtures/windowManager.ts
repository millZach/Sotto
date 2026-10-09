import { afterEach, beforeEach, vi } from 'vitest'
import { WIDGET_VISIBILITY } from '../../src/shared/channels'
import type { WidgetPresentation } from '../../src/shared/contracts'
import { WindowManager, type BrowserWindowLike, type Rectangle, type WindowConstructorOptions } from '../../src/main/windows/windowManager'
import { platformProfile } from '../../src/main/platformProfile'

type WindowEvent = 'maximize' | 'unmaximize' | 'close' | 'closed' | 'moved' | 'hide' | 'minimize'

export class FakeWindow implements BrowserWindowLike {
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
  readonly setFocusable = vi.fn()
  readonly maximize = vi.fn()
  readonly unmaximize = vi.fn()
  readonly isMaximized = vi.fn(() => false)
  readonly minimize = vi.fn()
  readonly isMinimized = vi.fn(() => false)
  readonly isFullScreen = vi.fn(() => false)
  readonly isVisible = vi.fn(() => true)
  readonly restore = vi.fn()
  readonly showInactive = vi.fn()
  readonly setAlwaysOnTop = vi.fn()
  readonly setVisibleOnAllWorkspaces = vi.fn()
  readonly setBackgroundColor = vi.fn()
  readonly setBackgroundMaterial = vi.fn()
  readonly setVibrancy = vi.fn()
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

export { deferred as createDeferred } from './deferred'

export function darwinOverrides(): Partial<ConstructorParameters<typeof WindowManager>[0]> {
  return { platform: 'darwin', chrome: platformProfile('darwin') }
}

export function createHarness(
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
    preloadPath: 'C:/Sotto/out/preload/index.js',
    mainHtmlPath: 'C:/Sotto/out/renderer/index.html',
    widgetHtmlPath: 'C:/Sotto/out/renderer/widget.html',
    developmentSources: undefined,
    brandIconPath: null,
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

export function currentWidgetVisibilityGeneration(manager: WindowManager): number {
  return visibilityGenerationReaders.get(manager)?.() ?? 0
}

export function setWidgetPresentation(
  manager: WindowManager,
  presentation: WidgetPresentation,
  generation = currentWidgetVisibilityGeneration(manager),
): void {
  manager.setWidgetPresentation({ presentation, generation })
}

const dragGestureStates = new WeakMap<
  WindowManager,
  { activeGestureId: number | null; nextGestureId: number }
>()

export function reportWidgetDrag(
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
    readonly presentation: WidgetPresentation
    readonly generation: number
  }): void
  reportWidgetDrag(report: {
    readonly phase: 'start' | 'move' | 'end'
    readonly generation: number
    readonly gestureId: number
  }): void
}

export function generationBound(manager: WindowManager): GenerationBoundWindowManager {
  return manager as unknown as GenerationBoundWindowManager
}

export const monitorWorkAreas = {
  left: { x: 0, y: 0, width: 1_000, height: 800 },
  right: { x: 1_000, y: 100, width: 1_200, height: 900 },
} as const

export function createMutableTwoDisplayAdapter() {
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

export function registerWidgetMonitorTimers(): void {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })
}
