import { APP_NAME } from '../../shared/constants'
import type { WidgetDragPayload } from '../../shared/contracts'
import { selectRendererSource, type RendererRole } from '../security'
import {
  DEFAULT_WIDGET_PLACEMENT,
  placementToBounds,
  snapToEdge,
  widgetSizeForPresentation,
  type WidgetPlacement,
  type WidgetSize,
} from './widgetPlacementMath'
import type { StoredWidgetPlacement } from '../storage/widgetPlacementRepository'

const WIDGET_BOTTOM_GAP = 16
const ACTIVE_HORIZONTAL_WIDGET_SIZE = widgetSizeForPresentation('bottom', 'active')

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
  readonly additionalArguments: [string]
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
  readonly alwaysOnTop?: true
  readonly skipTaskbar?: true
  readonly focusable?: false
  readonly hasShadow?: true
  readonly webPreferences: WindowWebPreferences
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

export interface WindowManagerDependencies {
  readonly createWindow: (options: WindowConstructorOptions) => BrowserWindowLike
  readonly display: DisplayAdapter
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

function securePreferences(
  preloadPath: string,
  role: RendererRole,
): WindowWebPreferences {
  return {
    preload: preloadPath,
    additionalArguments: [`--talktype-renderer-role=${role}`],
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
  private widgetSessionAnchor: Point | null = null
  private widgetDragOrigin: Point | null = null
  private widgetLastReveal: (Point & WidgetSize) | null = null
  // The size the widget window currently has; the constructor seam always
  // builds the horizontal canvas and snapping to a side edge swaps it.
  private widgetSize: WidgetSize = ACTIVE_HORIZONTAL_WIDGET_SIZE
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
      frame: false,
      webPreferences: securePreferences(this.dependencies.preloadPath, 'main'),
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
      width: ACTIVE_HORIZONTAL_WIDGET_SIZE.width,
      height: ACTIVE_HORIZONTAL_WIDGET_SIZE.height,
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
        ...securePreferences(this.dependencies.preloadPath, 'widget'),
        backgroundThrottling: false,
      },
    })
    this.widgetWindow = window
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
    window.show()
    window.focus()
  }

  hideMain(): void {
    this.mainWindow?.hide()
  }

  minimizeMain(): void {
    this.mainWindow?.minimize()
  }

  async showWidget(): Promise<void> {
    const widget = await this.createWidgetWindow()
    this.assertRunning()
    // Reveals arrive per widget publication — at audio-level rate during a
    // session — so the window operations only run on a visibility transition
    // or when the target position actually changed. A renderer drag owns the
    // window position outright while it is active.
    if (this.widgetLastReveal !== null && this.widgetDragOrigin !== null) {
      return
    }
    // A locked session anchor keeps the widget on the display the cursor was
    // on when the dictation session started; otherwise follow the cursor.
    const anchor =
      this.widgetSessionAnchor ?? this.dependencies.display.getCursorScreenPoint()
    const workArea = this.dependencies.display.getDisplayNearestPoint(anchor).workArea
    const placement = this.rememberedWidgetPlacement()
    const bounds = placementToBounds(
      placement,
      workArea,
      'active',
      WIDGET_BOTTOM_GAP,
    )
    if (
      this.widgetLastReveal !== null &&
      this.widgetLastReveal.x === bounds.x &&
      this.widgetLastReveal.y === bounds.y &&
      this.widgetLastReveal.width === bounds.width &&
      this.widgetLastReveal.height === bounds.height
    ) {
      return
    }
    this.applyWidgetSize(widget, bounds)
    widget.setPosition(bounds.x, bounds.y, false)
    this.assertRunning()
    this.widgetLastReveal = bounds
    widget.showInactive()
  }

  /**
   * Anchors widget positioning to the display the cursor is on right now.
   * Locking is idempotent for the duration of a session; only unlocking
   * (when dictation returns to idle) releases the anchor.
   */
  lockWidgetDisplay(): void {
    if (this.widgetSessionAnchor !== null) {
      return
    }
    try {
      this.widgetSessionAnchor = this.dependencies.display.getCursorScreenPoint()
    } catch {
      // Without a cursor point the widget simply follows the default display.
    }
  }

  unlockWidgetDisplay(): void {
    this.widgetSessionAnchor = null
  }

  /**
   * Applies one renderer-reported step of a widget drag gesture. 'start'
   * records the drag origin and suspends edge snapping, 'move' repositions the
   * window by the cumulative delta from that origin, and 'end' releases the
   * session and snaps to the nearest edge of whichever display the window is
   * actually on. Out-of-order phases ('end' or 'move' without 'start',
   * repeated 'start') are harmless no-ops or refreshes.
   */
  reportWidgetDrag(drag: WidgetDragPayload): void {
    const widget = this.widgetWindow
    if (widget === null || widget.isDestroyed()) {
      this.widgetDragOrigin = null
      return
    }
    if (drag.phase === 'start') {
      try {
        const [x, y] = widget.getPosition()
        this.widgetDragOrigin = { x, y }
      } catch {
        this.widgetDragOrigin = null
      }
      return
    }
    if (drag.phase === 'move') {
      const origin = this.widgetDragOrigin
      if (origin === null) return
      try {
        widget.setPosition(origin.x + drag.deltaX, origin.y + drag.deltaY, false)
      } catch {
        // Dragging is best effort; the widget keeps its last good position.
      }
      return
    }
    if (this.widgetDragOrigin === null) return
    this.widgetDragOrigin = null
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
    this.widgetLastReveal = null
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

  private installMainLifecycle(window: BrowserWindowLike): void {
    const onClose = (event: CloseEventLike): void => {
      if (!this.quitting) {
        event.preventDefault()
        window.hide()
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

  private rememberedWidgetPlacement(): WidgetPlacement {
    let stored: StoredWidgetPlacement | null
    try {
      stored = this.dependencies.getWidgetPlacement()
    } catch {
      return DEFAULT_WIDGET_PLACEMENT
    }
    if (stored === null) return DEFAULT_WIDGET_PLACEMENT
    if (stored.kind === 'edge') return { edge: stored.edge }
    if (!Number.isFinite(stored.x) || !Number.isFinite(stored.y)) {
      return DEFAULT_WIDGET_PLACEMENT
    }

    const workArea = this.dependencies.display.getDisplayNearestPoint(stored).workArea
    const placement = snapToEdge(stored, workArea)
    this.dependencies.onWidgetMoved(placement)
    return placement
  }

  private installWidgetInteractionLifecycle(window: BrowserWindowLike): void {
    // A fresh widget window can never be mid-drag or revealed, and is always
    // constructed on the horizontal canvas.
    this.widgetDragOrigin = null
    this.widgetLastReveal = null
    this.widgetSize = ACTIVE_HORIZONTAL_WIDGET_SIZE
    // The widget rests as a click-through sliver; the renderer requests
    // interactivity for active states and sliver hover.
    try {
      window.setIgnoreMouseEvents(true, { forward: true })
    } catch {
      // A widget that cannot pass clicks through still renders dictation state.
    }
    const onMoved = (): void => {
      // An active renderer drag positions the window directly; snapping waits
      // for the drag to end so the window can follow the pointer freely. The
      // moved handler stays as the snap fallback for programmatic moves.
      if (this.widgetDragOrigin !== null) return
      this.snapWidgetToEdge(window)
    }
    window.on('moved', onMoved)
    this.addCleanup(window, () => window.removeListener('moved', onMoved))
  }

  private snapWidgetToEdge(window: BrowserWindowLike): void {
    try {
      const [x, y] = window.getPosition()
      const workArea = this.dependencies.display.getDisplayNearestPoint({
        x: x + this.widgetSize.width / 2,
        y: y + this.widgetSize.height / 2,
      }).workArea
      const placement = snapToEdge({ x, y }, workArea)
      const bounds = placementToBounds(
        placement,
        workArea,
        'active',
        WIDGET_BOTTOM_GAP,
      )
      // Snapping to a side edge swaps the canvas orientation; resize and
      // reposition together so the widget lands as one coherent operation.
      this.applyWidgetSize(window, bounds)
      // Skip the no-op reposition so a programmatic snap cannot loop through
      // further moved events.
      if (bounds.x !== x || bounds.y !== y) {
        window.setPosition(bounds.x, bounds.y, false)
      }
      this.dependencies.onWidgetMoved(placement)
    } catch {
      // Placement memory is best effort.
    }
  }

  private applyWidgetSize(window: BrowserWindowLike, size: WidgetSize): void {
    if (
      this.widgetSize.width === size.width &&
      this.widgetSize.height === size.height
    ) {
      return
    }
    window.setSize(size.width, size.height, false)
    this.widgetSize = size
  }

  private installClosedLifecycle(window: BrowserWindowLike, kind: 'widget'): void {
    const onClosed = (): void => {
      if (kind === 'widget' && this.widgetWindow === window) {
        this.widgetWindow = null
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
