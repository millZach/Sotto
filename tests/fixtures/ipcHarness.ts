// @vitest-environment node
import { vi } from 'vitest'
import {
  registerIpc,
  type IpcInvocationEvent,
  type IpcMainAdapter,
  type TrustedIpcSender,
} from '../../src/main/ipc/registerIpc'
import {
  type BrowserWindowLike,
  type NavigationEventName,
  type Rectangle,
  type WindowConstructorOptions
} from '../../src/main/windows/windowManager'
import type { WidgetSnapshot } from '../../src/shared/dictation'
import {
  DEFAULT_SETTINGS
} from '../../src/shared/settings'
import { DEFAULT_WIDGET_PALETTE } from '../../src/shared/themeBranding'

export class FakeIpcMain implements IpcMainAdapter {
  readonly handlers = new Map<string, (event: IpcInvocationEvent, ...args: unknown[]) => unknown>()
  readonly removed: string[] = []
  readonly removeFailures = new Set<string>()

  handle(
    channel: string,
    handler: (event: IpcInvocationEvent, ...args: unknown[]) => unknown,
  ): void {
    if (this.handlers.has(channel)) {
      throw new Error(`handler already exists: ${channel}`)
    }
    this.handlers.set(channel, handler)
  }

  removeHandler(channel: string): void {
    this.removed.push(channel)
    if (this.removeFailures.has(channel)) {
      throw new Error(`secret remove failure: ${channel}`)
    }
    this.handlers.delete(channel)
  }

  constructor(readonly defaultEvent: IpcInvocationEvent) {}

  invoke(channel: string, payload?: unknown, event = this.defaultEvent): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) {
      return Promise.reject(new Error(`missing handler: ${channel}`))
    }
    return Promise.resolve(arguments.length === 1 ? handler(event) : handler(event, payload))
  }

  invokeArgs(channel: string, args: readonly unknown[], event = this.defaultEvent): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) {
      return Promise.reject(new Error(`missing handler: ${channel}`))
    }
    return Promise.resolve(handler(event, ...args))
  }
}

/** Fresh identity and top-level frame. Tests can navigate or destroy it without changing another sender. */
export function trustedIpcSender(role: 'main' | 'widget', url = `file:///${role}.html`): TrustedIpcSender {
  return { role, url, webContents: { mainFrame: { parent: null, url }, getURL: () => url, isDestroyed: () => false } }
}

/** Registry only: the test chooses which IPC service to register and keeps hostile events visible. */
export function ipcRegistry(options: { mainUrl?: string; widgetUrl?: string } = {}) {
  const main = trustedIpcSender('main', options.mainUrl)
  const widget = trustedIpcSender('widget', options.widgetUrl)
  const event = (source = main): IpcInvocationEvent => ({ sender: source.webContents, senderFrame: source.webContents.mainFrame })
  const mainEvent = event()
  const widgetEvent = event(widget)
  const ipc = new FakeIpcMain(mainEvent)
  return { ipc, handlers: ipc.handlers, main, widget, mainEvent, widgetEvent, event,
    trustedSenders: () => [main, widget],
    invoke: async (channel: string, args: readonly unknown[] = [], source = mainEvent) => ipc.invokeArgs(channel, args, source),
    dispose: () => { ipc.handlers.clear() },
  }
}

export class IpcLifecycleWindow implements BrowserWindowLike {
  readonly webContents: BrowserWindowLike['webContents']
  readonly hide = vi.fn()
  readonly show = vi.fn()
  readonly focus = vi.fn()
  readonly maximize = vi.fn()
  readonly unmaximize = vi.fn()
  readonly isMaximized = vi.fn(() => false)
  readonly minimize = vi.fn()
  readonly isMinimized = vi.fn(() => false)
  readonly restore = vi.fn()
  readonly showInactive = vi.fn()
  readonly setAlwaysOnTop = vi.fn()
  bounds: Rectangle
  readonly getBounds = vi.fn((): Rectangle => ({ ...this.bounds }))
  readonly setBounds = vi.fn((bounds: Rectangle): void => {
    this.bounds = { ...bounds }
  })
  readonly setPosition = vi.fn((x: number, y: number): void => {
    this.bounds = { ...this.bounds, x, y }
  })
  readonly getPosition = vi.fn(() => [this.bounds.x, this.bounds.y] as const)
  readonly setSize = vi.fn((width: number, height: number): void => {
    this.bounds = { ...this.bounds, width, height }
  })
  readonly setIgnoreMouseEvents = vi.fn()
  readonly destroy = vi.fn()
  readonly isDestroyed = vi.fn(() => false)
  readonly loadURL = vi.fn(async () => undefined)
  readonly loadFile = vi.fn(async () => undefined)

  constructor(readonly role: 'main' | 'widget', options: WindowConstructorOptions) {
    const url = `file:///C:/Sotto/out/renderer/${role === 'main' ? 'index' : 'widget'}.html`
    const mainFrame = { parent: null, url }
    this.webContents = {
      mainFrame,
      send: vi.fn(),
      getURL: vi.fn(() => url),
      isDestroyed: vi.fn(() => false),
      setWindowOpenHandler: vi.fn(),
    }
    this.bounds = { x: 0, y: 0, width: options.width, height: options.height }
  }

  on(
    event: 'close' | 'closed' | 'moved' | 'maximize' | 'unmaximize',
    listener: (event: { preventDefault(): void }) => void,
  ): void {
    void event
    void listener
  }
  removeListener(
    event: 'close' | 'closed' | 'moved' | 'maximize' | 'unmaximize',
    listener: (event: { preventDefault(): void }) => void,
  ): void {
    void event
    void listener
  }
  onNavigation(
    event: NavigationEventName,
    listener: (event: { preventDefault(): void }, details: { readonly url: string }) => void,
  ): void {
    void event
    void listener
  }
  removeNavigationListener(
    event: NavigationEventName,
    listener: (event: { preventDefault(): void }, details: { readonly url: string }) => void,
  ): void {
    void event
    void listener
  }
  onRenderProcessGone(listener: () => void): void {
    void listener
  }
  removeRenderProcessGoneListener(listener: () => void): void {
    void listener
  }
}

export function createIpcHarness(extra: Partial<Parameters<typeof registerIpc>[1]> = {}) {
  const trustedUrl = 'file:///C:/Sotto/out/renderer/index.html'
  const trustedFrame = { parent: null, url: trustedUrl }
  const trustedContents = {
    getURL: (): string => trustedUrl,
    isDestroyed: (): boolean => false,
    mainFrame: trustedFrame,
  }
  const trustedEvent = { sender: trustedContents, senderFrame: trustedFrame }
  const ipc = new FakeIpcMain(trustedEvent)
  const settings = {
    get: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
    update: vi.fn(async (patch: Partial<typeof DEFAULT_SETTINGS>) => ({
      ...DEFAULT_SETTINGS,
      ...patch,
    })),
    reset: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
  }
  const history = {
    list: vi.fn(async () => []),
    add: vi.fn(async () => []),
    search: vi.fn(async () => []),
    delete: vi.fn(async () => false),
    clear: vi.fn(async () => undefined),
  }
  const startup = {
    get: vi.fn(() => ({ enabled: false })),
    set: vi.fn((enabled: boolean) => ({ enabled })),
  }
  const hotkeys = {
    current: vi.fn(() => 'Primary'),
    replace: vi.fn(() => ({ ok: true as const })),
  }
  const app = {
    show: vi.fn(),
    hide: vi.fn(),
    minimize: vi.fn(),
    reload: vi.fn(),
    toggleMaximize: vi.fn(),
    isMaximized: vi.fn(() => false),
    quit: vi.fn(),
  }

  const openExternalLink = vi.fn<(url: string) => Promise<void>>(async () => undefined)
  const cleanup = registerIpc(ipc, {
    settings,
    history,
    startup,
    hotkeys,
    app,
    openExternalLink,
    trustedSenders: () => [
      { role: 'main', webContents: trustedContents, url: trustedUrl },
    ],
    ...extra,
  })
  return {
    app,
    openExternalLink,
    cleanup,
    history,
    hotkeys,
    ipc,
    settings,
    startup,
    trustedContents,
    trustedEvent,
    trustedFrame,
    trustedUrl,
  }
}

export const idleWidgetSnapshot = {
  status: 'idle',
  theme: 'system',
  palette: DEFAULT_WIDGET_PALETTE,
  reducedMotion: 'system',
  shortcut: 'Control+Shift+Space',
  cancellable: false,
} as const satisfies WidgetSnapshot
