import { APP_NAME } from '../../shared/constants'
import type { WidgetDragPayload, WidgetPresentation } from '../../shared/contracts'
import { selectRendererSource, type RendererRole } from '../security'
import {
  DEFAULT_WIDGET_PLACEMENT,
  placementToBounds,
  snapToEdge,
  widgetSizeForPresentation,
  type WidgetPlacement,
} from './widgetPlacementMath'
import type { StoredWidgetPlacement } from '../storage/widgetPlacementRepository'

const WIDGET_BOTTOM_GAP = 16
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
  private widgetPlacement: WidgetPlacement = DEFAULT_WIDGET_PLACEMENT
  private widgetPlacementLoaded = false
  private widgetWorkArea: Rectangle | null = null
  private widgetPresentation: WidgetPresentation = 'idle-resting'
  private widgetLastAppliedBounds: Rectangle | null = null
  private widgetProgrammaticTarget: Rectangle | null = null
  private widgetVisible = false
  private widgetDrag: {
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
    if (this.widgetDrag !== null) return

    this.loadWidgetPlacement()
    const workArea = this.resolveCurrentWidgetWorkArea()
    if (workArea !== null) {
      const desired = placementToBounds(
        this.widgetPlacement,
        workArea,
        this.widgetPresentation,
        WIDGET_BOTTOM_GAP,
      )
      this.applyWidgetBounds(widget, desired)
    }

    this.assertRunning()
    const wasVisible = this.widgetVisible
    this.widgetVisible = true
    if (!wasVisible) widget.showInactive()
  }

  setWidgetPresentation(presentation: WidgetPresentation): void {
    this.widgetPresentation = presentation
    const widget = this.widgetWindow
    if (
      !this.widgetVisible ||
      widget === null ||
      widget.isDestroyed() ||
      this.widgetDrag !== null
    ) {
      return
    }

    const workArea = this.widgetWorkArea ?? this.resolveCurrentWidgetWorkArea()
    if (workArea === null) return
    this.applyWidgetBounds(
      widget,
      placementToBounds(
        this.widgetPlacement,
        workArea,
        this.widgetPresentation,
        WIDGET_BOTTOM_GAP,
      ),
    )
  }

  // Kept as compatibility seams for the existing dictation lifecycle. Widget
  // placement now follows the current display instead of locking per session.
  lockWidgetDisplay(): void {}

  unlockWidgetDisplay(): void {}

  /**
   * Applies one renderer-reported step of a widget drag gesture using Electron
   * cursor coordinates, then snaps the native bounds through the coordinator.
   */
  reportWidgetDrag(drag: WidgetDragPayload): void {
    const widget = this.widgetWindow
    if (widget === null || widget.isDestroyed()) {
      this.widgetDrag = null
      return
    }
    if (drag.phase === 'start') {
      try {
        const bounds = widget.getBounds()
        this.widgetDrag = {
          windowOrigin: { x: bounds.x, y: bounds.y },
          cursorOrigin: this.dependencies.display.getCursorScreenPoint(),
        }
      } catch {
        this.widgetDrag = null
      }
      return
    }
    if (drag.phase === 'move') {
      const origin = this.widgetDrag
      if (origin === null) return
      try {
        const cursor = this.dependencies.display.getCursorScreenPoint()
        const current = widget.getBounds()
        this.applyWidgetBounds(widget, {
          x: origin.windowOrigin.x + cursor.x - origin.cursorOrigin.x,
          y: origin.windowOrigin.y + cursor.y - origin.cursorOrigin.y,
          width: current.width,
          height: current.height,
        })
      } catch {
        // Dragging is best effort; the widget keeps its last good bounds.
      }
      return
    }
    if (this.widgetDrag === null) return
    this.widgetDrag = null
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
    this.widgetVisible = false
    this.widgetDrag = null
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
      this.widgetPlacement = snapToEdge(stored, workArea)
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

  private resolveCurrentWidgetWorkArea(): Rectangle | null {
    try {
      const cursor = this.dependencies.display.getCursorScreenPoint()
      const workArea = this.dependencies.display.getDisplayNearestPoint(cursor).workArea
      this.widgetWorkArea = workArea
      return workArea
    } catch {
      return this.widgetWorkArea
    }
  }

  private installWidgetInteractionLifecycle(window: BrowserWindowLike): void {
    this.widgetDrag = null
    this.widgetLastAppliedBounds = null
    this.widgetProgrammaticTarget = null
    this.widgetVisible = false

    const onMoved = (): void => {
      if (this.widgetDrag !== null || this.widgetProgrammaticTarget !== null) return
      try {
        if (sameRectangle(this.widgetLastAppliedBounds, window.getBounds())) return
      } catch {
        return
      }
      this.widgetLastAppliedBounds = null
      this.snapWidgetToEdge(window)
    }
    window.on('moved', onMoved)
    this.addCleanup(window, () => window.removeListener('moved', onMoved))
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
        WIDGET_BOTTOM_GAP,
      )
      this.widgetPlacement = placement
      this.widgetWorkArea = workArea
      this.applyWidgetBounds(window, desired)
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
    if (sameRectangle(this.widgetLastAppliedBounds, desired)) return false

    this.widgetProgrammaticTarget = desired
    try {
      widget.setBounds(desired, false)
      this.widgetLastAppliedBounds = desired
      return true
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
