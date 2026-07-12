import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  screen,
  session,
  Tray,
  type Event as ElectronEvent,
  type MenuItemConstructorOptions,
  type WebContentsWillFrameNavigateEventParams,
  type WebContentsWillNavigateEventParams,
  type WebContentsWillRedirectEventParams,
} from 'electron'
import { join } from 'node:path'

import {
  bootstrapTalkType,
  installSessionPermissionPolicy,
  NativeRuntimeController,
  type BootstrapDiagnostic,
  type PermissionCheckHandler,
  type PermissionRequestHandler,
  type SessionPermissionAdapter,
} from './app/bootstrap'
import { HotkeyManager } from './hotkeys/hotkeyManager'
import { registerIpc, type TrustedIpcSender } from './ipc/registerIpc'
import { HistoryRepository } from './storage/historyRepository'
import { SettingsRepository } from './storage/settingsRepository'
import { StartupService } from './startup/startupService'
import {
  TrayController,
  type TrayAdapter,
  type TrayMenuItem,
  type TrayState,
} from './tray/trayController'
import {
  parseDevelopmentRendererSources,
  WindowManager,
  type BrowserWindowLike,
  type NavigationEventName,
  type RendererDiagnostic,
  type WebContentsLike,
  type WindowConstructorOptions,
} from './windows/windowManager'
import { DICTATION_COMMAND, WIDGET_STATE } from '../shared/channels'
import { APP_ID, APP_NAME } from '../shared/constants'
import type { DictationCommand } from '../shared/contracts'
import type { DictationState } from '../shared/dictation'

type NativeDiagnostic =
  | BootstrapDiagnostic
  | RendererDiagnostic
  | 'bootstrap-terminal-failed'
  | 'native-hotkey-registration-failed'
  | 'native-main-show-failed'
  | 'native-widget-show-failed'
  | 'settings-update-failed'

function logOperational(code: NativeDiagnostic): void {
  console.error(`[TalkType] ${code}`)
}

function toMenuTemplate(item: TrayMenuItem): MenuItemConstructorOptions {
  if (item.type === 'separator') {
    return { type: 'separator' }
  }
  if (item.type === 'checkbox') {
    return {
      type: 'checkbox',
      label: item.label ?? '',
      checked: item.checked ?? false,
      click: () => item.click?.(),
    }
  }
  return {
    type: 'normal',
    label: item.label ?? '',
    click: () => item.click?.(),
  }
}

function createPermissionAdapter(): SessionPermissionAdapter {
  return {
    setPermissionRequestHandler(handler: PermissionRequestHandler | null): void {
      session.defaultSession.setPermissionRequestHandler(
        handler === null
          ? null
          : (webContents, permission, callback, details) => {
              handler(webContents, permission, callback, details)
            },
      )
    },
    setPermissionCheckHandler(handler: PermissionCheckHandler | null): void {
      session.defaultSession.setPermissionCheckHandler(
        handler === null
          ? null
          : (webContents, permission, requestingOrigin, details) =>
              handler(webContents, permission, requestingOrigin, details),
      )
    },
  }
}

class ElectronBrowserWindowAdapter implements BrowserWindowLike {
  readonly webContents: WebContentsLike
  private readonly windowListenerCleanups = new Map<
    (event: { preventDefault(): void }) => void,
    () => void
  >()
  private readonly navigationCleanups = new Map<
    (event: { preventDefault(): void }, details: { readonly url: string }) => void,
    Map<NavigationEventName, () => void>
  >()

  constructor(private readonly window: BrowserWindow) {
    this.webContents = window.webContents
  }

  on(
    event: 'close' | 'closed',
    listener: (event: { preventDefault(): void }) => void,
  ): void {
    if (event === 'close') {
      const wrapped = (nativeEvent: { preventDefault(): void }): void => listener(nativeEvent)
      this.window.on('close', wrapped)
      this.windowListenerCleanups.set(listener, () => this.window.removeListener('close', wrapped))
      return
    }

    const wrapped = (): void => listener({ preventDefault: () => undefined })
    this.window.on('closed', wrapped)
    this.windowListenerCleanups.set(listener, () => this.window.removeListener('closed', wrapped))
  }

  removeListener(
    _event: 'close' | 'closed',
    listener: (event: { preventDefault(): void }) => void,
  ): void {
    this.windowListenerCleanups.get(listener)?.()
    this.windowListenerCleanups.delete(listener)
  }

  onNavigation(
    event: NavigationEventName,
    listener: (event: { preventDefault(): void }, details: { readonly url: string }) => void,
  ): void {
    let cleanup: () => void
    if (event === 'will-navigate') {
      const wrapped = (details: ElectronEvent<WebContentsWillNavigateEventParams>): void =>
        listener(details, { url: details.url })
      this.window.webContents.on('will-navigate', wrapped)
      cleanup = () => this.window.webContents.removeListener('will-navigate', wrapped)
    } else if (event === 'will-frame-navigate') {
      const wrapped = (details: ElectronEvent<WebContentsWillFrameNavigateEventParams>): void =>
        listener(details, { url: details.url })
      this.window.webContents.on('will-frame-navigate', wrapped)
      cleanup = () => this.window.webContents.removeListener('will-frame-navigate', wrapped)
    } else {
      const wrapped = (details: ElectronEvent<WebContentsWillRedirectEventParams>): void =>
        listener(details, { url: details.url })
      this.window.webContents.on('will-redirect', wrapped)
      cleanup = () => this.window.webContents.removeListener('will-redirect', wrapped)
    }

    const cleanups = this.navigationCleanups.get(listener) ?? new Map()
    cleanups.set(event, cleanup)
    this.navigationCleanups.set(listener, cleanups)
  }

  removeNavigationListener(
    event: NavigationEventName,
    listener: (event: { preventDefault(): void }, details: { readonly url: string }) => void,
  ): void {
    const cleanups = this.navigationCleanups.get(listener)
    cleanups?.get(event)?.()
    cleanups?.delete(event)
    if (cleanups?.size === 0) {
      this.navigationCleanups.delete(listener)
    }
  }

  hide(): void {
    this.window.hide()
  }

  show(): void {
    this.window.show()
  }

  focus(): void {
    this.window.focus()
  }

  minimize(): void {
    this.window.minimize()
  }

  showInactive(): void {
    this.window.showInactive()
  }

  setPosition(x: number, y: number, animate?: boolean): void {
    this.window.setPosition(x, y, animate)
  }

  destroy(): void {
    this.window.destroy()
  }

  isDestroyed(): boolean {
    return this.window.isDestroyed()
  }

  loadURL(url: string): Promise<void> {
    return this.window.loadURL(url)
  }

  loadFile(path: string): Promise<void> {
    return this.window.loadFile(path)
  }
}

function createBrowserWindow(options: WindowConstructorOptions): BrowserWindowLike {
  return new ElectronBrowserWindowAdapter(new BrowserWindow(options))
}

async function createRuntime(): Promise<NativeRuntimeController> {
  const userDataPath = app.getPath('userData')
  const settings = new SettingsRepository(join(userDataPath, 'settings.json'))
  const history = new HistoryRepository(join(userDataPath, 'history.json'))
  const startup = new StartupService(app)
  const windows = new WindowManager({
    createWindow: createBrowserWindow,
    display: screen,
    preloadPath: join(__dirname, '../preload/index.js'),
    mainHtmlPath: join(__dirname, '../renderer/index.html'),
    widgetHtmlPath: join(__dirname, '../renderer/widget.html'),
    developmentSources: app.isPackaged
      ? undefined
      : parseDevelopmentRendererSources(process.env.ELECTRON_RENDERER_URL),
    isPackaged: app.isPackaged,
    log: logOperational,
  })

  let currentTrayState: TrayState = { dictating: false, autoPaste: true }
  const dispatchDictation = (command: DictationCommand): void => {
    windows.sendToMain(DICTATION_COMMAND, command)
  }
  const showWidget = (): void => {
    void windows.showWidget().catch(() => logOperational('native-widget-show-failed'))
  }
  const toggleDictation = (): void => {
    dispatchDictation({ type: 'toggle' })
    showWidget()
  }

  const hotkeys = new HotkeyManager(globalShortcut, toggleDictation, () => {
    hotkeys.cancelListening()
    dispatchDictation({ type: 'cancel' })
  })

  const nativeTray = new Tray(process.execPath)
  nativeTray.setToolTip(APP_NAME)
  const trayAdapter: TrayAdapter = {
    setMenu(items): void {
      nativeTray.setContextMenu(Menu.buildFromTemplate(items.map(toMenuTemplate)))
    },
    destroy(): void {
      nativeTray.destroy()
    },
  }
  const trayController = new TrayController(trayAdapter, {
    toggleDictation,
    setAutoPaste(enabled): void {
      void settings
        .update({ autoPaste: enabled })
        .then((updated) => {
          currentTrayState = { ...currentTrayState, autoPaste: updated.autoPaste }
          trayController.update(currentTrayState)
        })
        .catch(() => logOperational('settings-update-failed'))
    },
    show(): void {
      void windows.showMain().catch(() => logOperational('native-main-show-failed'))
    },
    quit(): void {
      app.quit()
    },
  })
  const tray = {
    update(state: TrayState): void {
      currentTrayState = state
      trayController.update(state)
    },
    dispose(): void {
      trayController.dispose()
    },
  }

  const publishWidgetState = (state: DictationState): void => {
    windows.sendToWidget(WIDGET_STATE, state)
    const listening = state.status === 'listening'
    currentTrayState = { ...currentTrayState, dictating: listening }
    trayController.update(currentTrayState)

    if (listening) {
      hotkeys.beginListening()
      showWidget()
      return
    }
    if (state.status === 'cancelled') {
      hotkeys.cancelListening()
    } else if (state.status === 'error') {
      hotkeys.failListening()
    } else {
      hotkeys.stopListening()
    }
  }

  const permissionAdapter = createPermissionAdapter()
  const trustedIpcSenders: TrustedIpcSender[] = []
  return new NativeRuntimeController({
    windows,
    hotkeys,
    tray,
    startup,
    settings,
    installPermissions: () => {
      const mainContents = windows.getMainWebContents()
      if (mainContents === null) {
        throw new Error('Main renderer unavailable')
      }
      const widgetContents = windows.getWidgetWebContents()
      trustedIpcSenders.splice(
        0,
        trustedIpcSenders.length,
        { webContents: mainContents, url: mainContents.getURL() },
        ...(widgetContents === null
          ? []
          : [{ webContents: widgetContents, url: widgetContents.getURL() }]),
      )
      const cleanupPermissions = installSessionPermissionPolicy(permissionAdapter, [
        { webContents: mainContents, url: mainContents.getURL() },
      ])
      return () => {
        trustedIpcSenders.splice(0)
        cleanupPermissions()
      }
    },
    registerIpc: () =>
      registerIpc(ipcMain, {
        settings,
        history,
        startup,
        hotkeys,
        app: {
          show: () => windows.showMain(),
          hide: () => windows.hideMain(),
          minimize: () => windows.minimizeMain(),
          quit: () => app.quit(),
        },
        trustedSenders: () => trustedIpcSenders,
        dictation: {
          request(command): void {
            dispatchDictation(command)
            if (command.type === 'start' || command.type === 'toggle') {
              showWidget()
            }
          },
          publishWidgetState,
        },
      }),
    log: logOperational,
  })
}

app.setAppUserModelId(APP_ID)

void bootstrapTalkType({ app, initialize: createRuntime, log: logOperational }).catch(() => {
  logOperational('bootstrap-terminal-failed')
  app.quit()
})
