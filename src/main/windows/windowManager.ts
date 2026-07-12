import { APP_NAME } from '../../shared/constants'
import { selectRendererSource } from '../security'

const WIDGET_WIDTH = 420
const WIDGET_HEIGHT = 92
const WIDGET_BOTTOM_GAP = 32

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
  on(event: 'close' | 'closed', listener: (event: CloseEventLike) => void): void
  removeListener(event: 'close' | 'closed', listener: (event: CloseEventLike) => void): void
  hide(): void
  show(): void
  focus(): void
  minimize(): void
  showInactive(): void
  setPosition(x: number, y: number, animate?: boolean): void
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
}

type WindowKind = 'main' | 'widget'

export type RendererDiagnostic =
  | 'renderer-load-failed:main:development'
  | 'renderer-load-failed:main:bundled'
  | 'renderer-load-failed:widget:development'
  | 'renderer-load-failed:widget:bundled'

export interface DevelopmentRendererSources {
  readonly main: URL
  readonly widget: URL
}

export class RendererLoadError extends Error {
  constructor(readonly windowKind: WindowKind) {
    super(`${windowKind} renderer unavailable`)
    this.name = 'RendererLoadError'
  }
}

function securePreferences(preloadPath: string): WindowWebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
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
    main: new URL('/src/renderer/index.html', source),
    widget: new URL('/src/renderer/widget.html', source),
  })
}

export class WindowManager {
  private mainWindow: BrowserWindowLike | null = null
  private widgetWindow: BrowserWindowLike | null = null
  private mainReady: Promise<BrowserWindowLike> | null = null
  private widgetReady: Promise<BrowserWindowLike> | null = null
  private quitting = false
  private disposed = false
  private readonly cleanupByWindow = new Map<BrowserWindowLike, Set<() => void>>()

  constructor(private readonly dependencies: WindowManagerDependencies) {}

  createMainWindow(): Promise<BrowserWindowLike> {
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
      backgroundColor: '#111318',
      autoHideMenuBar: true,
      webPreferences: securePreferences(this.dependencies.preloadPath),
    })
    this.mainWindow = window
    this.installMainLifecycle(window)
    this.installNavigationPolicy(window)

    const ready = this.loadRenderer(
      window,
      'main',
      this.dependencies.mainHtmlPath,
      this.dependencies.developmentSources?.main,
    ).then(
      () => window,
      (error: unknown) => {
        if (this.mainWindow === window) {
          this.mainWindow = null
        }
        this.disposeWindow(window)
        throw error
      },
    )
    const wrappedReady = ready.finally(() => {
      if (this.mainReady === wrappedReady) {
        this.mainReady = null
      }
    })
    this.mainReady = wrappedReady
    return wrappedReady
  }

  createWidgetWindow(): Promise<BrowserWindowLike> {
    if (this.widgetReady !== null) {
      return this.widgetReady
    }
    if (this.widgetWindow !== null && !this.widgetWindow.isDestroyed()) {
      return Promise.resolve(this.widgetWindow)
    }

    const window = this.dependencies.createWindow({
      width: WIDGET_WIDTH,
      height: WIDGET_HEIGHT,
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
        ...securePreferences(this.dependencies.preloadPath),
        backgroundThrottling: false,
      },
    })
    this.widgetWindow = window
    this.installClosedLifecycle(window, 'widget')
    this.installNavigationPolicy(window)

    const ready = this.loadRenderer(
      window,
      'widget',
      this.dependencies.widgetHtmlPath,
      this.dependencies.developmentSources?.widget,
    ).then(
      () => window,
      (error: unknown) => {
        if (this.widgetWindow === window) {
          this.widgetWindow = null
        }
        this.disposeWindow(window)
        throw error
      },
    )
    const wrappedReady = ready.finally(() => {
      if (this.widgetReady === wrappedReady) {
        this.widgetReady = null
      }
    })
    this.widgetReady = wrappedReady
    return wrappedReady
  }

  async createWindows(): Promise<void> {
    await this.createMainWindow()
    await this.createWidgetWindow()
  }

  async showMain(): Promise<void> {
    const window = await this.createMainWindow()
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
    const workArea = this.dependencies.display.getDisplayNearestPoint(
      this.dependencies.display.getCursorScreenPoint(),
    ).workArea
    const centeredX = Math.round(workArea.x + (workArea.width - WIDGET_WIDTH) / 2)
    const aboveBottom = workArea.y + workArea.height - WIDGET_HEIGHT - WIDGET_BOTTOM_GAP
    const x = clamp(centeredX, workArea.x, workArea.x + workArea.width - WIDGET_WIDTH)
    const y = clamp(aboveBottom, workArea.y, workArea.y + workArea.height - WIDGET_HEIGHT)
    widget.setPosition(x, y, false)
    widget.showInactive()
  }

  hideWidget(): void {
    this.widgetWindow?.hide()
  }

  sendToMain(channel: string, payload: unknown): void {
    this.mainWindow?.webContents.send(channel, payload)
  }

  sendToWidget(channel: string, payload: unknown): void {
    this.widgetWindow?.webContents.send(channel, payload)
  }

  getMainWebContents(): WebContentsLike | null {
    return this.mainWindow?.webContents ?? null
  }

  getWidgetWebContents(): WebContentsLike | null {
    return this.widgetWindow?.webContents ?? null
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

  private addCleanup(window: BrowserWindowLike, cleanup: () => void): void {
    const cleanups = this.cleanupByWindow.get(window) ?? new Set<() => void>()
    cleanups.add(cleanup)
    this.cleanupByWindow.set(window, cleanups)
  }

  private runWindowCleanup(window: BrowserWindowLike): void {
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
