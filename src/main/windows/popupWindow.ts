import { POPUP_MAX_SHARE, POPUP_MIN_HEIGHT, POPUP_SHOWN, POPUP_WIDTH } from '../../shared/popup'
import { PLATFORM_ARGUMENT_PREFIX, type SottoPlatform } from '../../shared/platform'
import type { WidgetAlwaysOnTopLevel } from '../platformProfile'
import { selectRendererSource } from '../security'
import type { WindowRendererIdentity } from './windowManager'

interface Rectangle { x: number; y: number; width: number; height: number }

/** The part of an Electron `BrowserWindow` the popup uses, so a test can stand in for it. */
export interface PopupBrowserWindow {
  readonly webContents: WindowRendererIdentity['webContents'] & {
    on(event: 'will-navigate' | 'will-redirect' | 'render-process-gone', listener: (event: { preventDefault(): void }) => void): void
  }
  isDestroyed(): boolean
  isVisible(): boolean
  isFocused(): boolean
  show(): void
  showInactive(): void
  hide(): void
  focus(): void
  destroy(): void
  getBounds(): Rectangle
  setBounds(bounds: Rectangle): void
  setAlwaysOnTop(flag: boolean, level: WidgetAlwaysOnTopLevel): void
  setVisibleOnAllWorkspaces(flag: boolean, options: { visibleOnFullScreen: boolean; skipTransformProcessType: boolean }): void
  loadFile(path: string): Promise<void>
  loadURL(url: string): Promise<void>
  on(event: 'moved' | 'closed', listener: () => void): void
}

export interface PopupWindowOptions {
  readonly width: number
  readonly height: number
  readonly show: false
  readonly frame: false
  readonly transparent: true
  readonly resizable: false
  readonly maximizable: false
  readonly minimizable: false
  readonly fullscreenable: false
  readonly alwaysOnTop: true
  readonly skipTaskbar: true
  readonly hasShadow: boolean
  readonly autoHideMenuBar: true
  readonly backgroundColor: string
  readonly type?: 'panel'
  readonly webPreferences: {
    readonly preload: string
    readonly additionalArguments: string[]
    readonly contextIsolation: true
    readonly nodeIntegration: false
    readonly sandbox: true
  }
}

export interface PopupWindowDependencies {
  readonly create: (options: PopupWindowOptions) => PopupBrowserWindow
  /** The work area of the display under the pointer, where a popup shown for the first time goes. */
  readonly workArea: () => Rectangle
  /** Every display's work area, so a remembered place on a display since unplugged is not reused. */
  readonly workAreas: () => readonly Rectangle[]
  readonly platform: SottoPlatform
  readonly chrome: { readonly widgetIsPanel: boolean; readonly widgetAlwaysOnTopLevel: WidgetAlwaysOnTopLevel; readonly widgetVisibleOnAllWorkspaces: boolean }
  readonly preloadPath: string
  readonly htmlPath: string
  readonly developmentUrl: URL | undefined
  readonly isPackaged: boolean
  /** The window's renderer arguments beyond its role and platform, read as it is made (the interface language). */
  readonly extraArguments: () => string[]
  /** Told when the popup is shown or hidden, so main forwards its thread only while it is on screen. */
  readonly onVisible?: (visible: boolean) => void
  readonly log: (code: 'popup-load-failed' | 'popup-renderer-gone') => void
}

/**
 * The popup's window (ADR-0181): frameless, always on top, out of the taskbar, a panel on macOS so it floats on the
 * current Space without bringing the main window forward. It takes the keyboard while shown. Its width is fixed, since a
 * transparent window cannot be resized by hand; its height follows the card, growing upward from a bottom edge that stays
 * where the user last dragged it for the rest of the run.
 */
export class PopupWindow {
  private window: PopupBrowserWindow | null = null
  private ready: Promise<PopupBrowserWindow> | null = null
  private loadedUrl: string | null = null
  /** Where the user left it, by its left edge and bottom edge; null until it is first shown. */
  private place: { x: number; bottom: number } | null = null
  private height = POPUP_MIN_HEIGHT
  private moving = false
  private disposed = false
  private opening = false
  private showVersion = 0

  constructor(private readonly dependencies: PopupWindowDependencies) {}

  /** Shows the popup, or hides it when it is showing and has the keyboard; a popup behind another window comes forward. */
  async toggle(): Promise<void> {
    const window = this.window
    if (this.opening || (window !== null && !window.isDestroyed() && window.isVisible() && window.isFocused())) { this.hide(); return }
    await this.show()
  }

  async show(): Promise<void> {
    if (this.disposed) return
    const version = ++this.showVersion
    this.opening = true
    try {
      const window = await this.load()
      // Loading the first renderer can outlive Escape, a second shortcut press, or Open in Sotto. A cancelled show
      // must never bring the popup back and take the keyboard after the user has left it.
      if (version !== this.showVersion || this.disposed || window.isDestroyed()) return
      this.placeOnScreen(window)
      // macOS: a panel shown without activating Sotto and then focused takes the keyboard while the app in front stays in
      // front, so the main window is not brought forward with it. Elsewhere showing the window focuses it.
      if (this.dependencies.platform === 'darwin') window.showInactive()
      else window.show()
      window.focus()
      this.dependencies.onVisible?.(true)
      if (!window.webContents.isDestroyed()) window.webContents.send(POPUP_SHOWN, null)
    } finally {
      if (version === this.showVersion) this.opening = false
    }
  }

  hide(): void {
    this.showVersion++
    this.opening = false
    const window = this.window
    if (window === null || window.isDestroyed() || !window.isVisible()) return
    window.hide()
    this.dependencies.onVisible?.(false)
  }

  isVisible(): boolean {
    return this.window !== null && !this.window.isDestroyed() && this.window.isVisible()
  }

  /** The card's height changed: the bottom edge stays put and the window grows or shrinks upward, within the work area. */
  fit(contentHeight: number): void {
    const window = this.window
    if (window === null || window.isDestroyed()) return
    const area = this.areaFor(window.getBounds())
    this.height = Math.round(Math.max(POPUP_MIN_HEIGHT, Math.min(contentHeight, area.height * POPUP_MAX_SHARE)))
    this.applyBounds(window, area)
  }

  send(channel: string, payload: unknown): void {
    const window = this.window
    if (window === null || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send(channel, payload)
  }

  trustedRenderers(): readonly WindowRendererIdentity[] {
    const window = this.window
    if (window === null || window.isDestroyed() || window.webContents.isDestroyed() || this.loadedUrl === null) return []
    return [{ role: 'popup', webContents: window.webContents, url: this.loadedUrl }]
  }

  dispose(): void {
    this.disposed = true
    const window = this.window
    this.window = null
    this.ready = null
    if (window !== null && !window.isDestroyed()) window.destroy()
  }

  private load(): Promise<PopupBrowserWindow> {
    if (this.window !== null && !this.window.isDestroyed() && this.ready === null) return Promise.resolve(this.window)
    if (this.ready !== null) return this.ready
    const { chrome, platform } = this.dependencies
    const window = this.dependencies.create({
      width: POPUP_WIDTH, height: this.height, show: false, frame: false, transparent: true, resizable: false,
      maximizable: false, minimizable: false, fullscreenable: false, alwaysOnTop: true, skipTaskbar: true,
      hasShadow: platform === 'darwin', autoHideMenuBar: true, backgroundColor: '#00000000',
      ...(chrome.widgetIsPanel ? { type: 'panel' as const } : {}),
      webPreferences: {
        preload: this.dependencies.preloadPath,
        additionalArguments: ['--sotto-renderer-role=popup', `${PLATFORM_ARGUMENT_PREFIX}${platform}`, ...this.dependencies.extraArguments()],
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    })
    this.window = window
    window.setAlwaysOnTop(true, chrome.widgetAlwaysOnTopLevel)
    if (chrome.widgetVisibleOnAllWorkspaces) {
      // Shown over whichever Space is current, full-screen apps included, without hiding the Dock (ADR-0052).
      try { window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }) } catch { /* The current Space alone. */ }
    }
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const stay = (event: { preventDefault(): void }): void => event.preventDefault()
    window.webContents.on('will-navigate', stay)
    window.webContents.on('will-redirect', stay)
    window.webContents.on('render-process-gone', () => {
      this.dependencies.log('popup-renderer-gone')
      this.forget(window)
      if (!window.isDestroyed()) window.destroy()
    })
    window.on('moved', () => {
      if (this.moving || window.isDestroyed()) return
      const bounds = window.getBounds()
      this.place = { x: bounds.x, bottom: bounds.y + bounds.height }
    })
    window.on('closed', () => this.forget(window))
    const source = selectRendererSource(this.dependencies.isPackaged, this.dependencies.developmentUrl, this.dependencies.htmlPath)
    const ready = (source.kind === 'url' ? window.loadURL(source.value) : window.loadFile(source.value)).then(() => {
      this.loadedUrl = window.webContents.getURL()
      this.ready = null
      return window
    }, (error: unknown) => {
      this.dependencies.log('popup-load-failed')
      this.forget(window)
      if (!window.isDestroyed()) window.destroy()
      throw error
    })
    this.ready = ready
    return ready
  }

  private forget(window: PopupBrowserWindow): void {
    if (this.window !== window) return
    this.window = null
    this.ready = null
    this.loadedUrl = null
    this.dependencies.onVisible?.(false)
  }

  /** The remembered place when it is still on a display, otherwise centred low on the display under the pointer. */
  private placeOnScreen(window: PopupBrowserWindow): void {
    const place = this.place
    const onScreen = place !== null && this.dependencies.workAreas().some(area => place.x + 40 >= area.x && place.x + 40 <= area.x + area.width
      && place.bottom - 20 >= area.y && place.bottom - 20 <= area.y + area.height)
    if (!onScreen) {
      const area = this.dependencies.workArea()
      this.place = { x: Math.round(area.x + (area.width - POPUP_WIDTH) / 2), bottom: area.y + area.height - 140 }
    }
    this.applyBounds(window, this.areaFor({ x: this.place!.x, y: this.place!.bottom - this.height, width: POPUP_WIDTH, height: this.height }))
  }

  private areaFor(bounds: Rectangle): Rectangle {
    const middle = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height }
    return this.dependencies.workAreas().find(area => middle.x >= area.x && middle.x <= area.x + area.width && middle.y >= area.y && middle.y <= area.y + area.height)
      ?? this.dependencies.workArea()
  }

  private applyBounds(window: PopupBrowserWindow, area: Rectangle): void {
    const place = this.place ?? { x: window.getBounds().x, bottom: window.getBounds().y + window.getBounds().height }
    const bottom = Math.min(place.bottom, area.y + area.height)
    const y = Math.max(area.y, bottom - this.height)
    this.moving = true
    try { window.setBounds({ x: place.x, y, width: POPUP_WIDTH, height: this.height }) } finally { this.moving = false }
  }
}
