import { WIDGET_VISIBILITY } from '../../shared/channels'
import { APP_NAME } from '../../shared/constants'
import type {
  WidgetDragPayload,
  WidgetPresentation,
  WidgetPresentationPayload,
  WidgetVisibilityPayload,
} from '../../shared/contracts'
import { PLATFORM_ARGUMENT_PREFIX, type SottoPlatform } from '../../shared/platform'
import type {
  MainWindowChrome,
  TrafficLightPosition,
  WidgetAlwaysOnTopLevel,
} from '../platformProfile'
import { selectRendererSource, type RendererRole } from '../security'
import {
  DEFAULT_WIDGET_PLACEMENT,
  placementToBounds,
  snapToEdge,
  widgetSizeForPresentation,
  type WidgetPlacement,
} from './widgetPlacementMath'
import type { StoredWidgetPlacement } from '../storage/widgetPlacementRepository'

const WIDGET_EDGE_INSET = 16
const WIDGET_MONITOR_INTERVAL_MS = 100
const IDLE_RESTING_WIDGET_SIZE = widgetSizeForPresentation('bottom', 'idle-resting')

export interface Point {
  readonly x: number
  readonly y: number
}

export interface Rectangle extends Point {
  readonly width: number
  readonly height: number
}

export interface DisplayLike {
  readonly workArea: Rectangle
}

export interface DisplayAdapter {
  getCursorScreenPoint(): Point
  getDisplayNearestPoint(point: Point): DisplayLike
}

export interface WindowWebPreferences {
  readonly preload: string
  // A mutable tuple: Electron's BrowserWindowConstructorOptions declares
  // additionalArguments as string[], which a readonly array cannot satisfy.
  readonly additionalArguments: [string, string]
  readonly contextIsolation: true
  readonly nodeIntegration: false
  readonly sandbox: true
  readonly backgroundThrottling?: false
}

export interface WindowConstructorOptions {
  readonly width: number
  readonly height: number
  readonly minWidth?: number
  readonly minHeight?: number
  readonly show: false
  readonly title?: string
  readonly backgroundColor?: string
  readonly autoHideMenuBar: true
  readonly resizable?: false
  readonly maximizable?: false
  readonly minimizable?: false
  readonly fullscreenable?: false
  readonly transparent?: true
  readonly frame?: false
  readonly titleBarStyle?: 'hiddenInset'
  readonly trafficLightPosition?: TrafficLightPosition
  readonly alwaysOnTop?: true
  readonly skipTaskbar?: true
  readonly focusable?: boolean
  readonly hasShadow?: true
  readonly webPreferences: WindowWebPreferences
}

/** Native chrome differs per platform; the values come from the platform profile. */
interface MainWindowChromeOptions {
  readonly frame?: false
  readonly titleBarStyle?: 'hiddenInset'
  readonly trafficLightPosition?: TrafficLightPosition
}

function mainWindowChromeOptions(
  chrome: WindowChromeProfile,
): MainWindowChromeOptions {
  if (chrome.mainWindowChrome === 'frameless') {
    return { frame: false }
  }
  if (chrome.trafficLightPosition === null) {
    return { titleBarStyle: 'hiddenInset' }
  }
  return {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: chrome.trafficLightPosition,
  }
}

interface CloseEventLike {
  preventDefault(): void
}

interface NavigateEventLike {
  preventDefault(): void
}

export type NavigationEventName =
  | 'will-navigate'
  | 'will-frame-navigate'
  | 'will-redirect'

export interface WebContentsLike {
  readonly mainFrame: {
    readonly parent: unknown | null
    readonly url: string
  }
  send(channel: string, payload: unknown): void
  getURL(): string
  isDestroyed(): boolean
  setWindowOpenHandler(
    handler: (details: { readonly url: string }) => { readonly action: 'deny' },
  ): void
}

export interface BrowserWindowLike {
  readonly webContents: WebContentsLike
  on(event: 'close' | 'closed' | 'moved', listener: (event: CloseEventLike) => void): void
  removeListener(
    event: 'close' | 'closed' | 'moved',
    listener: (event: CloseEventLike) => void,
  ): void
  hide(): void
  show(): void
  focus(): void
  minimize(): void
  isMinimized(): boolean
  restore(): void
  showInactive(): void
  setAlwaysOnTop(flag: boolean, level?: WidgetAlwaysOnTopLevel): void
  /** Absent on window backends that cannot span workspaces. */
  setVisibleOnAllWorkspaces?(
    visible: boolean,
    options?: { readonly visibleOnFullScreen: boolean },
  ): void
  /** Managed widget geometry uses the renderer content area in Electron DIPs. */
  getBounds(): Rectangle
  setBounds(bounds: Rectangle, animate?: boolean): void
  setPosition(x: number, y: number, animate?: boolean): void
  getPosition(): readonly [number, number]
  setSize(width: number, height: number, animate?: boolean): void
  setIgnoreMouseEvents(ignore: boolean, options?: { readonly forward: boolean }): void
  destroy(): void
  isDestroyed(): boolean
  loadURL(url: string): Promise<void>
  loadFile(path: string): Promise<void>
  onNavigation(
    event: NavigationEventName,
    listener: (event: NavigateEventLike, details: { readonly url: string }) => void,
  ): void
  removeNavigationListener(
    event: NavigationEventName,
    listener: (event: NavigateEventLike, details: { readonly url: string }) => void,
  ): void
  onRenderProcessGone(listener: () => void): void
  removeRenderProcessGoneListener(listener: () => void): void
}

/** Structural subset of the platform profile; the profile satisfies it as-is. */
export interface WindowChromeProfile {
  readonly mainWindowChrome: MainWindowChrome
  readonly trafficLightPosition: TrafficLightPosition | null
  readonly widgetAlwaysOnTopLevel: WidgetAlwaysOnTopLevel
  readonly widgetFocusable: boolean
  readonly widgetVisibleOnAllWorkspaces: boolean
}

/** Runtime Dock presence; null where the platform has no runtime-controlled Dock. */
export interface DockAdapter {
  show(): void
  hide(): void
}

export interface WindowManagerDependencies {
  readonly createWindow: (options: WindowConstructorOptions) => BrowserWindowLike
  readonly display: DisplayAdapter
  readonly platform: SottoPlatform
  readonly chrome: WindowChromeProfile
  readonly dock: DockAdapter | null
  readonly preloadPath: string
  readonly mainHtmlPath: string
  readonly widgetHtmlPath: string
  readonly developmentSources: DevelopmentRendererSources | undefined
  readonly isPackaged: boolean
  readonly log: (code: RendererDiagnostic) => void
  readonly onRendererProcessGone?: (kind: RendererRole) => void
  readonly getWidgetPlacement: () => StoredWidgetPlacement | null
  readonly onWidgetMoved: (placement: WidgetPlacement) => void
}

type WindowKind = RendererRole

export type RendererDiagnostic =
  | 'renderer-load-failed:main:development'
  | 'renderer-load-failed:main:bundled'
  | 'renderer-load-failed:widget:development'
  | 'renderer-load-failed:widget:bundled'
  | 'renderer-process-gone-handler-failed:main'
  | 'renderer-process-gone-handler-failed:widget'

export interface DevelopmentRendererSources {
  readonly main: URL
  readonly widget: URL
}

export interface WindowRendererIdentity {
  readonly role: WindowKind
  readonly webContents: WebContentsLike
  readonly url: string
}

export class RendererLoadError extends Error {
  constructor(readonly windowKind: WindowKind) {
    super(`${windowKind} renderer unavailable`)
    this.name = 'RendererLoadError'
  }
}

export class WindowManagerStoppedError extends Error {
  readonly code = 'WINDOW_MANAGER_STOPPED'

  constructor() {
    super('Window manager stopped')
    this.name = 'WindowManagerStoppedError'
  }
}

export class RendererProcessGoneError extends Error {
  readonly code = 'RENDERER_PROCESS_GONE'

  constructor(readonly windowKind: WindowKind) {
    super(`${windowKind} renderer process stopped`)
    this.name = 'RendererProcessGoneError'
  }
}

function sameRectangle(left: Rectangle | null, right: Rectangle): boolean {
  return (
    left !== null &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  )
}

function securePreferences(
  preloadPath: string,
  role: RendererRole,
  platform: SottoPlatform,
): WindowWebPreferences {
  return {
    preload: preloadPath,
    additionalArguments: [
      `--sotto-renderer-role=${role}`,
      `${PLATFORM_ARGUMENT_PREFIX}${platform}`,
    ],
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  }
}

export function parseDevelopmentRendererSources(
  rawSource: string | undefined,
): DevelopmentRendererSources | undefined {
  if (rawSource === undefined) {
    return undefined
  }

  let source: URL
  try {
    source = new URL(rawSource)
  } catch {
    return undefined
  }

  const hostname = source.hostname.toLowerCase()
  const isLoopback =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  if (
    (source.protocol !== 'http:' && source.protocol !== 'https:') ||
    !isLoopback ||
    source.username.length > 0 ||
    source.password.length > 0 ||
    source.pathname !== '/' ||
    source.search.length > 0 ||
    source.hash.length > 0
  ) {
    return undefined
  }

  return Object.freeze({
    main: new URL('/index.html', source),
    widget: new URL('/widget.html', source),
  })
}

export class WindowManager {
  private mainWindow: BrowserWindowLike | null = null
  private widgetWindow: BrowserWindowLike | null = null
  private mainReady: Promise<BrowserWindowLike> | null = null
  private widgetReady: Promise<BrowserWindowLike> | null = null
  private quitting = false
  private disposed = false
  private widgetPlacement: WidgetPlacement = DEFAULT_WIDGET_PLACEMENT
  private widgetPlacementLoaded = false
  private widgetWorkArea: Rectangle | null = null
  private widgetPresentation: WidgetPresentation = 'idle-resting'
  private widgetLastAppliedBounds: Rectangle | null = null
  private widgetProgrammaticTarget: Rectangle | null = null
  private widgetVisible = false
  private widgetVisibilityGeneration = 0
  private widgetRevealGeneration: number | null = null
  private widgetMonitorTimer: ReturnType<typeof setInterval> | null = null
  private widgetDragPresentationResizePending = false
  private widgetDrag: {
    readonly generation: number
    readonly gestureId: number
    readonly windowOrigin: Point
    readonly cursorOrigin: Point
  } | null = null
  private readonly cleanupByWindow = new Map<BrowserWindowLike, Set<() => void>>()
  private readonly loadedRendererUrls = new Map<BrowserWindowLike, string>()

  constructor(private readonly dependencies: WindowManagerDependencies) {}

  createMainWindow(): Promise<BrowserWindowLike> {
    if (this.isStopped()) {
      return Promise.reject(new WindowManagerStoppedError())
    }
    if (this.mainReady !== null) {
      return this.mainReady
    }
    if (this.mainWindow !== null && !this.mainWindow.isDestroyed()) {
      return Promise.resolve(this.mainWindow)
    }

    const window = this.dependencies.createWindow({
      width: 1_080,
      height: 720,
      minWidth: 820,
      minHeight: 560,
      show: false,
      title: APP_NAME,
      backgroundColor: '#1b1917',
      autoHideMenuBar: true,
      ...mainWindowChromeOptions(this.dependencies.chrome),
      webPreferences: securePreferences(
        this.dependencies.preloadPath,
        'main',
        this.dependencies.platform,
      ),
    })
    this.mainWindow = window
    this.installMainLifecycle(window)
    this.installRendererProcessLifecycle(window, 'main')
    this.installNavigationPolicy(window)

    const ready = this.loadRenderer(
      window,
      'main',
      this.dependencies.mainHtmlPath,
      this.dependencies.developmentSources?.main,
    ).then(
      () => {
        this.assertLoadedWindow(window, 'main')
        this.loadedRendererUrls.set(window, window.webContents.getURL())
        return window
      },
      (error: unknown) => {
        const rendererGone = this.isRendererGone(window, 'main')
        if (this.mainWindow === window) {
          this.mainWindow = null
        }
        this.disposeWindow(window)
        if (this.isStopped()) {
          throw new WindowManagerStoppedError()
        }
        if (rendererGone) {
          throw new RendererProcessGoneError('main')
        }
        throw error
      },
    )
    const wrappedReady = ready.finally(() => {
      if (this.mainReady === wrappedReady) {
        this.mainReady = null
      }
    })
    this.mainReady = wrappedReady
    if (this.isRendererGone(window, 'main')) {
      this.mainReady = null
    }
    return wrappedReady
  }

  createWidgetWindow(): Promise<BrowserWindowLike> {
    if (this.isStopped()) {
      return Promise.reject(new WindowManagerStoppedError())
    }
    if (this.widgetReady !== null) {
      return this.widgetReady
    }
    if (this.widgetWindow !== null && !this.widgetWindow.isDestroyed()) {
      return Promise.resolve(this.widgetWindow)
    }

    const window = this.dependencies.createWindow({
      width: IDLE_RESTING_WIDGET_SIZE.width,
      height: IDLE_RESTING_WIDGET_SIZE.height,
      show: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: this.dependencies.chrome.widgetFocusable,
      hasShadow: true,
      autoHideMenuBar: true,
      webPreferences: {
        ...securePreferences(
          this.dependencies.preloadPath,
          'widget',
          this.dependencies.platform,
        ),
        backgroundThrottling: false,
      },
    })
    this.widgetWindow = window
    // The constructor's alwaysOnTop (and setAlwaysOnTop's default 'floating'
    // level) silently fails to apply WS_EX_TOPMOST on current Windows 11
    // builds; the explicit 'normal' level sticks and survives hide/show.
    // The level is per-platform because 'normal' is kCGNormalWindowLevel on
    // macOS, which would leave the widget behind other applications.
    window.setAlwaysOnTop(true, this.dependencies.chrome.widgetAlwaysOnTopLevel)
    if (this.dependencies.chrome.widgetVisibleOnAllWorkspaces) {
      try {
        window.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true })
      } catch {
        // Spanning workspaces is best effort; the widget stays usable on the
        // active one.
      }
    }
    this.installClosedLifecycle(window, 'widget')
    this.installRendererProcessLifecycle(window, 'widget')
    this.installNavigationPolicy(window)
    this.installWidgetInteractionLifecycle(window)

    const ready = this.loadRenderer(
      window,
      'widget',
      this.dependencies.widgetHtmlPath,
      this.dependencies.developmentSources?.widget,
    ).then(
      () => {
        this.assertLoadedWindow(window, 'widget')
        this.loadedRendererUrls.set(window, window.webContents.getURL())
        return window
      },
      (error: unknown) => {
        const rendererGone = this.isRendererGone(window, 'widget')
        if (this.widgetWindow === window) {
          this.widgetWindow = null
        }
        this.disposeWindow(window)
        if (this.isStopped()) {
          throw new WindowManagerStoppedError()
        }
        if (rendererGone) {
          throw new RendererProcessGoneError('widget')
        }
        throw error
      },
    )
    const wrappedReady = ready.finally(() => {
      if (this.widgetReady === wrappedReady) {
        this.widgetReady = null
      }
    })
    this.widgetReady = wrappedReady
    if (this.isRendererGone(window, 'widget')) {
      this.widgetReady = null
    }
    return wrappedReady
  }

  async createWindows(): Promise<void> {
    await this.createMainWindow()
    this.assertRunning()
    await this.createWidgetWindow()
    this.assertRunning()
  }

  async showMain(): Promise<void> {
    const window = await this.createMainWindow()
    this.assertRunning()
    if (window.isMinimized()) {
      window.restore()
    }
    this.showDock()
    window.show()
    window.focus()
  }

  hideMain(): void {
    const main = this.mainWindow
    if (main === null) return
    main.hide()
    this.hideDock()
  }

  minimizeMain(): void {
    this.mainWindow?.minimize()
  }

  async showWidget(): Promise<void> {
    const visibilityGeneration = this.widgetVisible
      ? this.widgetVisibilityGeneration
      : this.widgetRevealGeneration ?? this.advanceWidgetVisibilityGeneration()
    if (!this.widgetVisible && this.widgetRevealGeneration === null) {
      this.widgetRevealGeneration = visibilityGeneration
    }

    try {
      const widget = await this.createWidgetWindow()
      this.assertRunning()
      if (visibilityGeneration !== this.widgetVisibilityGeneration) return
      if (this.widgetDrag !== null) return

      this.loadWidgetPlacement()
      const workArea = this.resolveCurrentWidgetWorkArea()
      if (workArea !== null) {
        const desired = placementToBounds(
          this.widgetPlacement,
          workArea,
          this.widgetPresentation,
          WIDGET_EDGE_INSET,
        )
        if (this.applyWidgetBounds(widget, desired)) {
          this.widgetWorkArea = workArea
        }
      }

      this.assertRunning()
      if (!this.widgetVisible) {
        const presentationBeforeVisibility = this.widgetPresentation
        const visibility: WidgetVisibilityPayload = {
          visible: true,
          generation: visibilityGeneration,
        }
        this.sendToWidget(WIDGET_VISIBILITY, visibility)
        if (visibilityGeneration !== this.widgetVisibilityGeneration) return

        // A synchronous show-generation republish can update the remembered
        // presentation while the native window is still hidden. Re-read it
        // before reveal; later asynchronous reports reconcile through the
        // ordinary visible presentation path.
        const revealWorkArea = this.widgetWorkArea ?? workArea
        if (
          this.widgetPresentation !== presentationBeforeVisibility &&
          revealWorkArea !== null
        ) {
          const desired = placementToBounds(
            this.widgetPlacement,
            revealWorkArea,
            this.widgetPresentation,
            WIDGET_EDGE_INSET,
          )
          if (this.applyWidgetBounds(widget, desired)) {
            this.widgetWorkArea = revealWorkArea
          }
        }

        try {
          widget.showInactive()
        } catch (error) {
          const rollbackGeneration = this.advanceWidgetVisibilityGeneration()
          this.widgetRevealGeneration = null
          this.widgetVisible = false
          this.widgetDrag = null
          this.widgetDragPresentationResizePending = false
          if (this.widgetPresentation === 'idle-hovered') {
            this.widgetPresentation = 'idle-resting'
          }
          this.sendToWidget(WIDGET_VISIBILITY, {
            visible: false,
            generation: rollbackGeneration,
          } satisfies WidgetVisibilityPayload)
          this.stopWidgetMonitor()
          throw error
        }
        if (visibilityGeneration !== this.widgetVisibilityGeneration) return
        this.widgetVisible = true
        this.startWidgetMonitor()
      }
    } finally {
      if (this.widgetRevealGeneration === visibilityGeneration) {
        this.widgetRevealGeneration = null
      }
    }
  }

  setWidgetPresentation({
    presentation,
    generation,
  }: WidgetPresentationPayload): void {
    if (generation !== this.widgetVisibilityGeneration) return

    this.widgetPresentation = presentation
    const widget = this.widgetWindow
    if (!this.widgetVisible || widget === null || widget.isDestroyed()) return
    if (this.widgetDrag !== null) {
      this.reconcileWidgetPresentationDuringDrag(widget)
      return
    }

    const workArea = this.widgetWorkArea ?? this.resolveCurrentWidgetWorkArea()
    if (workArea === null) return
    if (this.applyWidgetBounds(
      widget,
      placementToBounds(
        this.widgetPlacement,
        workArea,
        this.widgetPresentation,
        WIDGET_EDGE_INSET,
      ),
    )) {
      this.widgetWorkArea = workArea
    }
  }

  /**
   * Applies one renderer-reported step of a widget drag gesture using Electron
   * cursor coordinates, then snaps the native bounds through the coordinator.
   */
  reportWidgetDrag(drag: WidgetDragPayload): void {
    if (drag.generation !== this.widgetVisibilityGeneration) return

    const widget = this.widgetWindow
    if (widget === null || widget.isDestroyed() || !this.widgetVisible) {
      this.widgetDrag = null
      this.widgetDragPresentationResizePending = false
      return
    }
    if (drag.phase === 'start') {
      this.widgetDragPresentationResizePending = false
      try {
        if (this.widgetPresentation === 'idle-resting') {
          const workArea = this.widgetWorkArea ?? this.resolveCurrentWidgetWorkArea()
          if (workArea === null) {
        this.widgetDrag = null
            this.widgetDragPresentationResizePending = false
            return
          }
          this.widgetPresentation = 'idle-hovered'
          if (!this.applyWidgetBounds(
            widget,
            placementToBounds(
              this.widgetPlacement,
              workArea,
              this.widgetPresentation,
              WIDGET_EDGE_INSET,
            ),
          )) {
        this.widgetDrag = null
            this.widgetDragPresentationResizePending = false
            return
          }
          this.widgetWorkArea = workArea
        }
        const bounds = widget.getBounds()
        this.widgetDrag = {
          generation: drag.generation,
          gestureId: drag.gestureId,
          windowOrigin: { x: bounds.x, y: bounds.y },
          cursorOrigin: this.dependencies.display.getCursorScreenPoint(),
        }
      } catch {
        this.widgetDrag = null
        this.widgetDragPresentationResizePending = false
      }
      return
    }
    if (drag.phase === 'move') {
      const activeDrag = this.widgetDrag
      if (
        activeDrag === null ||
        activeDrag.generation !== drag.generation ||
        activeDrag.gestureId !== drag.gestureId
      ) return
      try {
        const cursor = this.dependencies.display.getCursorScreenPoint()
        widget.setPosition(
          activeDrag.windowOrigin.x + cursor.x - activeDrag.cursorOrigin.x,
          activeDrag.windowOrigin.y + cursor.y - activeDrag.cursorOrigin.y,
          false,
        )
        this.widgetLastAppliedBounds = null
        const current = widget.getBounds()
        this.widgetLastAppliedBounds = current
      } catch {
        this.widgetDrag = null
        this.widgetDragPresentationResizePending = false
      }
      return
    }
    if (
      this.widgetDrag?.generation !== drag.generation ||
      this.widgetDrag.gestureId !== drag.gestureId
    ) return
    this.widgetDrag = null
    this.widgetDragPresentationResizePending = false
    this.snapWidgetToEdge(widget)
  }

  setWidgetMouseInteractive(interactive: boolean): void {
    const widget = this.widgetWindow
    if (widget === null || widget.isDestroyed()) return
    try {
      if (interactive) widget.setIgnoreMouseEvents(false)
      else widget.setIgnoreMouseEvents(true, { forward: true })
    } catch {
      // Interactivity toggles are best effort; the widget stays usable either way.
    }
  }

  hideWidget(): void {
    const wasVisible = this.widgetVisible
    const hadPendingReveal = this.widgetRevealGeneration !== null
    if (wasVisible || hadPendingReveal) {
      const visibilityGeneration = this.advanceWidgetVisibilityGeneration()
      this.widgetRevealGeneration = null
      this.widgetVisible = false
      this.widgetDrag = null
      this.widgetDragPresentationResizePending = false
      if (this.widgetPresentation === 'idle-hovered') {
        this.widgetPresentation = 'idle-resting'
      }
      if (wasVisible) {
        this.sendToWidget(WIDGET_VISIBILITY, {
          visible: false,
          generation: visibilityGeneration,
        } satisfies WidgetVisibilityPayload)
      }
    }
    this.stopWidgetMonitor()
    this.widgetWindow?.hide()
  }

  sendToMain(channel: string, payload: unknown): boolean {
    const main = this.mainWindow
    if (main === null || !this.loadedRendererUrls.has(main)) return false
    return this.sendToWindow(main, channel, payload)
  }

  sendToWidget(channel: string, payload: unknown): boolean {
    const widget = this.widgetWindow
    if (widget === null || !this.loadedRendererUrls.has(widget)) return false
    return this.sendToWindow(widget, channel, payload)
  }

  getMainWebContents(): WebContentsLike | null {
    return this.mainWindow?.webContents ?? null
  }

  getWidgetWebContents(): WebContentsLike | null {
    return this.widgetWindow?.webContents ?? null
  }

  getTrustedRenderers(): readonly WindowRendererIdentity[] {
    const identities: WindowRendererIdentity[] = []
    this.addTrustedRendererIdentity(identities, this.mainWindow, 'main')
    this.addTrustedRendererIdentity(identities, this.widgetWindow, 'widget')
    return identities
  }

  beginQuit(): void {
    this.quitting = true
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.quitting = true
    this.widgetVisible = false
    this.widgetRevealGeneration = null
    this.widgetDrag = null
    this.widgetDragPresentationResizePending = false
    this.stopWidgetMonitor()

    const main = this.mainWindow
    const widget = this.widgetWindow
    this.mainWindow = null
    this.widgetWindow = null
    this.mainReady = null
    this.widgetReady = null
    if (main !== null) {
      this.disposeWindow(main)
    }
    if (widget !== null) {
      this.disposeWindow(widget)
    }
  }

  private showDock(): void {
    const dock = this.dependencies.dock
    if (dock === null) return
    try {
      dock.show()
    } catch {
      // Dock presence is cosmetic; the window still opens without it.
    }
  }

  private hideDock(): void {
    const dock = this.dependencies.dock
    if (dock === null) return
    try {
      dock.hide()
    } catch {
      // Dock presence is cosmetic; the window still hides without it.
    }
  }

  private installMainLifecycle(window: BrowserWindowLike): void {
    const onClose = (event: CloseEventLike): void => {
      if (!this.quitting) {
        event.preventDefault()
        window.hide()
        this.hideDock()
      }
    }
    const onClosed = (): void => {
      if (this.mainWindow === window) {
        this.mainWindow = null
      }
      this.runWindowCleanup(window)
    }
    window.on('close', onClose)
    window.on('closed', onClosed)
    this.addCleanup(window, () => {
      window.removeListener('close', onClose)
      window.removeListener('closed', onClosed)
    })
  }

  private loadWidgetPlacement(): void {
    if (this.widgetPlacementLoaded) return
    this.widgetPlacementLoaded = true

    let stored: StoredWidgetPlacement | null
    try {
      stored = this.dependencies.getWidgetPlacement()
    } catch {
      this.widgetPlacement = DEFAULT_WIDGET_PLACEMENT
      return
    }
    if (stored === null) {
      this.widgetPlacement = DEFAULT_WIDGET_PLACEMENT
      return
    }
    if (stored.kind === 'edge') {
      this.widgetPlacement = { edge: stored.edge }
      return
    }
    if (!Number.isFinite(stored.x) || !Number.isFinite(stored.y)) {
      this.widgetPlacement = DEFAULT_WIDGET_PLACEMENT
      return
    }

    try {
      const workArea = this.dependencies.display.getDisplayNearestPoint(stored).workArea
      this.widgetPlacement = snapToEdge(
        {
          ...stored,
          ...widgetSizeForPresentation(
            this.widgetPlacement.edge,
            this.widgetPresentation,
          ),
        },
        workArea,
      )
    } catch {
      this.widgetPlacement = DEFAULT_WIDGET_PLACEMENT
      return
    }
    try {
      this.dependencies.onWidgetMoved(this.widgetPlacement)
    } catch {
      // Migration persistence is best effort; the resolved edge remains usable.
    }
  }

  private advanceWidgetVisibilityGeneration(): number {
    this.widgetVisibilityGeneration += 1
    return this.widgetVisibilityGeneration
  }

  private resolveCurrentWidgetWorkArea(): Rectangle | null {
    try {
      const cursor = this.dependencies.display.getCursorScreenPoint()
      return this.dependencies.display.getDisplayNearestPoint(cursor).workArea
    } catch {
      return this.widgetWorkArea
    }
  }

  private startWidgetMonitor(): void {
    if (this.widgetMonitorTimer !== null) return
    this.widgetMonitorTimer = setInterval(
      () => this.followCursorMonitor(),
      WIDGET_MONITOR_INTERVAL_MS,
    )
  }

  private stopWidgetMonitor(): void {
    if (this.widgetMonitorTimer === null) return
    clearInterval(this.widgetMonitorTimer)
    this.widgetMonitorTimer = null
  }

  private followCursorMonitor(): void {
    const widget = this.widgetWindow
    if (!this.widgetVisible || widget === null || widget.isDestroyed()) {
      return
    }
    if (this.widgetDrag !== null) {
      if (this.widgetDragPresentationResizePending) {
        this.reconcileWidgetPresentationDuringDrag(widget)
      }
      return
    }

    try {
      const cursor = this.dependencies.display.getCursorScreenPoint()
      const workArea = this.dependencies.display.getDisplayNearestPoint(cursor).workArea
      const desired = placementToBounds(
        this.widgetPlacement,
        workArea,
        this.widgetPresentation,
        WIDGET_EDGE_INSET,
      )
      if (this.applyWidgetBounds(widget, desired)) {
        this.widgetWorkArea = workArea
      }
    } catch {
      // Retain last valid bounds and retry on the next tick.
    }
  }

  private installWidgetInteractionLifecycle(window: BrowserWindowLike): void {
    this.widgetDrag = null
    this.widgetDragPresentationResizePending = false
    this.widgetLastAppliedBounds = null
    this.widgetProgrammaticTarget = null
    this.widgetVisible = false

    const onMoved = (): void => {
      if (!this.widgetVisible) {
        this.widgetLastAppliedBounds = null
        return
      }
      if (this.widgetDrag !== null || this.widgetProgrammaticTarget !== null) return
      try {
        if (sameRectangle(this.widgetLastAppliedBounds, window.getBounds())) return
      } catch {
        this.widgetLastAppliedBounds = null
        return
      }
      this.widgetLastAppliedBounds = null
      this.snapWidgetToEdge(window)
    }
    window.on('moved', onMoved)
    this.addCleanup(window, () => window.removeListener('moved', onMoved))
  }

  private reconcileWidgetPresentationDuringDrag(widget: BrowserWindowLike): void {
    const drag = this.widgetDrag
    if (drag === null) return

    try {
      const current = widget.getBounds()
      this.widgetLastAppliedBounds = current
      const presentation =
        this.widgetPresentation === 'idle-resting'
          ? 'idle-hovered'
          : this.widgetPresentation
      const size = widgetSizeForPresentation(this.widgetPlacement.edge, presentation)
      const desired = { ...current, ...size }
      if (sameRectangle(current, desired)) {
        this.widgetDragPresentationResizePending = false
        return
      }

      const appliedExactly = this.applyWidgetBounds(widget, desired)
      const applied = this.widgetLastAppliedBounds
      const appliedSize =
        applied !== null &&
        applied.width === desired.width &&
        applied.height === desired.height
      if (!appliedExactly && !appliedSize) {
        this.widgetDragPresentationResizePending = true
        return
      }
      this.widgetDragPresentationResizePending = false
      if (applied === null) return

      // Native content resizing can round the window origin at a mixed-DPI
      // boundary. Rebase the drag origin by that native adjustment so the next
      // cumulative cursor delta continues from the actual applied position.
      this.widgetDrag = {
        generation: drag.generation,
        gestureId: drag.gestureId,
        windowOrigin: {
          x: drag.windowOrigin.x + applied.x - current.x,
          y: drag.windowOrigin.y + applied.y - current.y,
        },
        cursorOrigin: drag.cursorOrigin,
      }
    } catch {
      this.widgetDragPresentationResizePending = true
      // Keep drag ownership valid; the monitor retries without relocating the drag.
    }
  }

  private snapWidgetToEdge(window: BrowserWindowLike): void {
    try {
      const current = window.getBounds()
      const workArea = this.dependencies.display.getDisplayNearestPoint({
        x: current.x + current.width / 2,
        y: current.y + current.height / 2,
      }).workArea
      const placement = snapToEdge(current, workArea)
      const desired = placementToBounds(
        placement,
        workArea,
        this.widgetPresentation,
        WIDGET_EDGE_INSET,
      )
      this.widgetPlacement = placement
      if (this.applyWidgetBounds(window, desired)) {
        this.widgetWorkArea = workArea
      }
      try {
        this.dependencies.onWidgetMoved(placement)
      } catch {
        // Placement persistence is best effort.
      }
    } catch {
      // Placement and native bounds are best effort.
    }
  }

  private applyWidgetBounds(
    widget: BrowserWindowLike,
    desired: Rectangle,
  ): boolean {
    if (sameRectangle(this.widgetLastAppliedBounds, desired)) return true

    this.widgetProgrammaticTarget = desired
    try {
      widget.setBounds(desired, false)
      const applied = widget.getBounds()
      this.widgetLastAppliedBounds = applied
      return sameRectangle(applied, desired)
    } catch {
      return false
    } finally {
      this.widgetProgrammaticTarget = null
    }
  }

  private installClosedLifecycle(window: BrowserWindowLike, kind: 'widget'): void {
    const onClosed = (): void => {
      if (kind === 'widget' && this.widgetWindow === window) {
        this.widgetWindow = null
        this.widgetVisible = false
        this.widgetRevealGeneration = null
        this.widgetDrag = null
        this.widgetDragPresentationResizePending = false
        this.widgetPresentation = 'idle-resting'
        this.stopWidgetMonitor()
      }
      this.runWindowCleanup(window)
    }
    window.on('closed', onClosed)
    this.addCleanup(window, () => window.removeListener('closed', onClosed))
  }

  private installNavigationPolicy(window: BrowserWindowLike): void {
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const onNavigate = (event: NavigateEventLike): void => event.preventDefault()
    const navigationEvents = [
      'will-navigate',
      'will-frame-navigate',
      'will-redirect',
    ] as const
    for (const event of navigationEvents) {
      window.onNavigation(event, onNavigate)
    }
    this.addCleanup(window, () => {
      for (const event of navigationEvents) {
        window.removeNavigationListener(event, onNavigate)
      }
    })
  }

  private installRendererProcessLifecycle(
    window: BrowserWindowLike,
    kind: WindowKind,
  ): void {
    const onRendererProcessGone = (): void => {
      if (kind === 'main' && this.mainWindow === window) {
        this.mainWindow = null
        this.mainReady = null
      }
      if (kind === 'widget' && this.widgetWindow === window) {
        this.widgetWindow = null
        this.widgetReady = null
        this.widgetVisible = false
        this.widgetRevealGeneration = null
        this.widgetDrag = null
        this.widgetDragPresentationResizePending = false
        this.widgetPresentation = 'idle-resting'
        this.stopWidgetMonitor()
      }
      this.disposeWindow(window)
      try {
        this.dependencies.onRendererProcessGone?.(kind)
      } catch {
        this.dependencies.log(`renderer-process-gone-handler-failed:${kind}`)
      }
    }
    window.onRenderProcessGone(onRendererProcessGone)
    this.addCleanup(window, () => {
      window.removeRenderProcessGoneListener(onRendererProcessGone)
    })
  }

  private addCleanup(window: BrowserWindowLike, cleanup: () => void): void {
    const cleanups = this.cleanupByWindow.get(window) ?? new Set<() => void>()
    cleanups.add(cleanup)
    this.cleanupByWindow.set(window, cleanups)
  }

  private runWindowCleanup(window: BrowserWindowLike): void {
    this.loadedRendererUrls.delete(window)
    const cleanups = this.cleanupByWindow.get(window)
    if (cleanups === undefined || !this.cleanupByWindow.delete(window)) {
      return
    }
    for (const cleanup of cleanups) {
      cleanup()
    }
  }

  private disposeWindow(window: BrowserWindowLike): void {
    this.runWindowCleanup(window)
    if (!window.isDestroyed()) {
      window.destroy()
    }
  }

  private addTrustedRendererIdentity(
    identities: WindowRendererIdentity[],
    window: BrowserWindowLike | null,
    role: WindowKind,
  ): void {
    if (
      window === null ||
      window.isDestroyed() ||
      window.webContents.isDestroyed()
    ) {
      return
    }
    const url = this.loadedRendererUrls.get(window)
    if (url === undefined || url.length === 0) {
      return
    }
    identities.push({ role, webContents: window.webContents, url })
  }

  private sendToWindow(
    window: BrowserWindowLike | null,
    channel: string,
    payload: unknown,
  ): boolean {
    try {
      if (
        window === null ||
        window.isDestroyed() ||
        window.webContents.isDestroyed()
      ) {
        return false
      }
      window.webContents.send(channel, payload)
      return true
    } catch {
      return false
    }
  }

  private assertRunning(): void {
    if (this.isStopped()) {
      throw new WindowManagerStoppedError()
    }
  }

  private assertLoadedWindow(window: BrowserWindowLike, kind: WindowKind): void {
    if (this.isStopped()) {
      this.disposeWindow(window)
      throw new WindowManagerStoppedError()
    }
    if (this.isRendererGone(window, kind)) {
      this.disposeWindow(window)
      throw new RendererProcessGoneError(kind)
    }
  }

  private isRendererGone(window: BrowserWindowLike, kind: WindowKind): boolean {
    const current = kind === 'main' ? this.mainWindow : this.widgetWindow
    return current !== window || window.isDestroyed() || window.webContents.isDestroyed()
  }

  private isStopped(): boolean {
    return this.disposed || this.quitting
  }

  private async loadRenderer(
    window: BrowserWindowLike,
    kind: WindowKind,
    bundledPath: string,
    developmentSource: URL | undefined,
  ): Promise<void> {
    const source = selectRendererSource(
      this.dependencies.isPackaged,
      developmentSource,
      bundledPath,
    )
    if (source.kind === 'url') {
      try {
        await window.loadURL(source.value)
        return
      } catch {
        this.dependencies.log(`renderer-load-failed:${kind}:development`)
      }
    }

    try {
      await window.loadFile(bundledPath)
    } catch {
      this.dependencies.log(`renderer-load-failed:${kind}:bundled`)
      throw new RendererLoadError(kind)
    }
  }
}
