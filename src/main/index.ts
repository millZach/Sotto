import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  net,
  protocol,
  screen,
  session,
  Tray,
  type Event as ElectronEvent,
  type MenuItemConstructorOptions,
  type WebContentsWillFrameNavigateEventParams,
  type WebContentsWillNavigateEventParams,
  type WebContentsWillRedirectEventParams,
} from 'electron'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

import {
  bootstrapTalkType,
  installSessionPermissionPolicy,
  NativeRuntimeController,
  type BootstrapDiagnostic,
  type NativeRuntimeDiagnostic,
  type PermissionCheckHandler,
  type PermissionRequestHandler,
  type SessionPermissionAdapter,
} from './app/bootstrap'
import { NativeMessageDelivery } from './app/nativeMessageDelivery'
import { NativeDictationLifecycle } from './app/nativeDictationLifecycle'
import { HotkeyManager, syncEscapeForWidgetSnapshot } from './hotkeys/hotkeyManager'
import { registerIpc } from './ipc/registerIpc'
import { createSpawnProcessAdapter, OutputService } from './output/outputService'
import { RecoveryNoticeCenter } from './storage/recoveryNoticeCenter'
import { createStorageRepositories } from './storage/repositories'
import {
  WidgetPlacementRepository,
  type StoredWidgetPlacement,
} from './storage/widgetPlacementRepository'
import { NativeSettingsCoordinator } from './settings/nativeSettingsCoordinator'
import { StartupService } from './startup/startupService'
import {
  TrayController,
  type TrayAdapter,
  type TrayMenuItem,
  type TrayState,
} from './tray/trayController'
import {
  createTrayResource,
  NativeTrayCreationError,
} from './tray/trayIcon'
import {
  parseDevelopmentRendererSources,
  WindowManager,
  type BrowserWindowLike,
  type NavigationEventName,
  type RendererDiagnostic,
  type WebContentsLike,
  type WindowConstructorOptions,
} from './windows/windowManager'
import {
  DICTATION_COMMAND,
  MODEL_STATUS,
  RECOVERY_NOTICE,
  SETTINGS_CHANGED,
} from '../shared/channels'
import { APP_ID, APP_NAME } from '../shared/constants'
import type { DictationCommand } from '../shared/contracts'
import type { WidgetSnapshot } from '../shared/dictation'
import { enableWasmThreadSupport } from './security'
import { loadBundledModelManifest, loadCatalogLock, ModelManager } from './models/modelManager'
import { createModelIpcService } from './models/modelIpcService'
import {
  loadVerifiedRuntimeSource,
  registerLocalAssetProtocols,
  registerModelSchemesAsPrivileged,
} from './models/modelProtocol'
import {
  createE2EClipboard,
  createE2EGlobalShortcuts,
  createE2ENativeState,
  createE2EModelOperations,
  createE2EPasteProcess,
  resolveE2EConfiguration,
  isTrustedMainE2ESender,
  snapshotE2EState,
} from './e2e/e2eBoundary'
import { E2E_SNAPSHOT_CHANNEL, E2E_TRIGGER_SHORTCUT_CHANNEL } from '../shared/e2e'

const e2eConfiguration = resolveE2EConfiguration(app.isPackaged, process.env)
if (e2eConfiguration === null) {
  delete process.env.TALKTYPE_E2E
  delete process.env.TALKTYPE_E2E_SCENARIO
  delete process.env.TALKTYPE_E2E_USER_DATA
} else if (e2eConfiguration !== null) {
  app.setPath('userData', e2eConfiguration.userDataPath)
}

type NativeDiagnostic =
  | BootstrapDiagnostic
  | NativeRuntimeDiagnostic
  | RendererDiagnostic
  | 'bootstrap-terminal-failed'
  | 'native-main-send-failed'
  | 'native-widget-state-delivery-failed'
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
  private readonly rendererProcessGoneCleanups = new Map<() => void, () => void>()

  constructor(private readonly window: BrowserWindow) {
    this.webContents = window.webContents
  }

  on(
    event: 'close' | 'closed' | 'moved',
    listener: (event: { preventDefault(): void }) => void,
  ): void {
    if (event === 'close') {
      const wrapped = (nativeEvent: { preventDefault(): void }): void => listener(nativeEvent)
      this.window.on('close', wrapped)
      this.windowListenerCleanups.set(listener, () => this.window.removeListener('close', wrapped))
      return
    }
    if (event === 'moved') {
      const wrapped = (): void => listener({ preventDefault: () => undefined })
      this.window.on('moved', wrapped)
      this.windowListenerCleanups.set(listener, () => this.window.removeListener('moved', wrapped))
      return
    }

    const wrapped = (): void => listener({ preventDefault: () => undefined })
    this.window.on('closed', wrapped)
    this.windowListenerCleanups.set(listener, () => this.window.removeListener('closed', wrapped))
  }

  removeListener(
    _event: 'close' | 'closed' | 'moved',
    listener: (event: { preventDefault(): void }) => void,
  ): void {
    this.windowListenerCleanups.get(listener)?.()
    this.windowListenerCleanups.delete(listener)
  }

  getPosition(): readonly [number, number] {
    const [x = 0, y = 0] = this.window.getPosition()
    return [x, y]
  }

  setIgnoreMouseEvents(ignore: boolean, options?: { readonly forward: boolean }): void {
    this.window.setIgnoreMouseEvents(ignore, options)
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

  onRenderProcessGone(listener: () => void): void {
    const wrapped = (): void => listener()
    this.window.webContents.on('render-process-gone', wrapped)
    this.rendererProcessGoneCleanups.set(listener, () => {
      this.window.webContents.removeListener('render-process-gone', wrapped)
    })
  }

  removeRenderProcessGoneListener(listener: () => void): void {
    this.rendererProcessGoneCleanups.get(listener)?.()
    this.rendererProcessGoneCleanups.delete(listener)
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

  isMinimized(): boolean {
    return this.window.isMinimized()
  }

  restore(): void {
    this.window.restore()
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
  const recoveryNotices = new RecoveryNoticeCenter()
  const { settings, history } = createStorageRepositories(userDataPath, recoveryNotices)
  let e2eOpenAtLogin = false
  const startup = new StartupService(e2eConfiguration === null ? app : {
    getLoginItemSettings: () => ({ openAtLogin: e2eOpenAtLogin }),
    setLoginItemSettings: ({ openAtLogin }) => { e2eOpenAtLogin = openAtLogin },
  })
  const widgetPlacementStore = new WidgetPlacementRepository(
    join(userDataPath, 'widget-placement.json'),
  )
  let widgetPlacement: StoredWidgetPlacement | null = await widgetPlacementStore.get()
  let showWidgetWhenIdle = (await settings.get()).showWidgetWhenIdle
  let handleRendererProcessGone: (kind: 'main' | 'widget') => void = () => undefined
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
    onRendererProcessGone: (kind) => handleRendererProcessGone(kind),
    getWidgetPlacement: () => widgetPlacement,
    onWidgetMoved: (placement) => {
      widgetPlacement = { kind: 'edge', ...placement }
      void widgetPlacementStore.save(placement)
    },
  })
  const productionModels = e2eConfiguration === null ? await (async () => {
    const resourceRoot = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources')
    const modelRoot = join(resourceRoot, 'models')
    const runtimeRoot = join(resourceRoot, 'runtime')
    const catalog = await loadCatalogLock(join(modelRoot, 'catalog.lock.json'))
    const bundledManifest = await loadBundledModelManifest(join(modelRoot, 'manifest.lock.json'), catalog)
    const runtimeSource = await loadVerifiedRuntimeSource(runtimeRoot)
    const manager = new ModelManager({
      catalog,
      bundledManifest,
      packagedRoot: modelRoot,
      userRoot: join(userDataPath, 'models'),
      onProgress(progress) {
        windows.sendToMain(MODEL_STATUS, { preset: progress.preset, state: 'downloading', progress: progress.totalBytes === 0 ? 0 : progress.completedBytes / progress.totalBytes })
      },
    })
    return { manager, runtimeSource }
  })() : null
  const models = productionModels?.manager ?? createE2EModelOperations()
  const e2eState = e2eConfiguration === null ? null : createE2ENativeState()
  const output = new OutputService({
    clipboard: e2eState === null ? clipboard : createE2EClipboard(e2eState),
    widget: windows,
    delay: (milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds)
      }),
    process: e2eConfiguration === null
      ? createSpawnProcessAdapter((executable, args, options) => spawn(executable, args, options))
      : createE2EPasteProcess(e2eState!, e2eConfiguration.scenario, (text) => {
        const mainWindow = BrowserWindow.getAllWindows().find(
          (candidate) => candidate.getTitle() === APP_NAME,
        )
        mainWindow?.webContents.insertText(text)
      }),
  })

  const messageDelivery = new NativeMessageDelivery(windows)
  let currentTrayState: TrayState = { dictating: false, autoPaste: true }
  const dispatchDictation = (command: DictationCommand): void => {
    void messageDelivery.sendToMain(DICTATION_COMMAND, command).then((delivered) => {
      if (!delivered) {
        logOperational('native-main-send-failed')
      }
    })
  }
  const showWidget = (): void => {
    void windows.showWidget().catch(() => logOperational('native-widget-show-failed'))
  }
  const toggleDictation = (): void => {
    dispatchDictation({ type: 'toggle' })
    showWidget()
  }

  const e2eShortcuts = e2eConfiguration === null
    ? null
    : createE2EGlobalShortcuts(e2eConfiguration.scenario)
  const hotkeys = new HotkeyManager(
    e2eShortcuts ?? globalShortcut,
    toggleDictation,
    () => {
    hotkeys.cancelListening()
    dispatchDictation({ type: 'cancel' })
    },
  )

  const nativeTray = e2eConfiguration === null
    ? await createTrayResource({
        executablePath: process.execPath,
        getFileIcon: (path, options) => app.getFileIcon(path, options),
        createTray: (icon) => new Tray(icon),
        configure: (tray) => tray.setToolTip(APP_NAME),
      })
    : { setContextMenu: () => undefined, destroy: () => undefined }
  try {
  const trayAdapter: TrayAdapter = {
    setMenu(items): void {
      nativeTray.setContextMenu(Menu.buildFromTemplate(items.map(toMenuTemplate)))
    },
    destroy(): void {
      nativeTray.destroy()
    },
  }
  const settingsCoordinator = new NativeSettingsCoordinator({
    repository: settings,
    hotkeys,
    startup,
    onAutoPasteChanged(enabled): void {
      currentTrayState = { ...currentTrayState, autoPaste: enabled }
      trayController.update(currentTrayState)
    },
    async onSettingsChanged(settings): Promise<void> {
      showWidgetWhenIdle = settings.showWidgetWhenIdle
      if (settings.onboardingComplete && settings.showWidgetWhenIdle) {
        showWidget()
      } else if (!settings.showWidgetWhenIdle && dictationLifecycle.isIdle()) {
        windows.hideWidget()
      }
      const delivered = await messageDelivery.sendToMain(SETTINGS_CHANGED, settings)
      if (!delivered) logOperational('native-main-send-failed')
    },
  })
  const trayController = new TrayController(trayAdapter, {
    toggleDictation,
    setAutoPaste(enabled): void {
      void settingsCoordinator
        .updateSettings({ autoPaste: enabled })
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

  const dictationLifecycle = new NativeDictationLifecycle({
    delivery: messageDelivery,
    getTrayState: () => currentTrayState,
    updateTray(state): void {
      currentTrayState = state
      trayController.update(state)
    },
    syncEscape: (state) => syncEscapeForWidgetSnapshot(hotkeys, state),
    widgetDisplay: {
      lock: () => windows.lockWidgetDisplay(),
      unlock: () => windows.unlockWidgetDisplay(),
    },
    showWidgetWhenIdle: () => showWidgetWhenIdle,
    log: logOperational,
  })
  handleRendererProcessGone = (kind) => dictationLifecycle.rendererProcessGone(kind)
  const publishWidgetState = async (state: WidgetSnapshot): Promise<void> => {
    await dictationLifecycle.publish(state)
  }

  const permissionAdapter = createPermissionAdapter()
  return new NativeRuntimeController({
    windows,
    hotkeys,
    tray,
    startup,
    settings,
    installPermissions: () =>
      installSessionPermissionPolicy(permissionAdapter, () =>
        windows
          .getTrustedRenderers()
          .filter((renderer) => renderer.role === 'main'),
      ),
    installProtocols: productionModels === null
      ? () => () => undefined
      : () => registerLocalAssetProtocols({
          protocol,
          net,
          modelSources: () => productionModels.manager.protocolSources(),
          runtimeSource: productionModels.runtimeSource,
        }),
    registerIpc: () => {
      const cleanup = registerIpc(ipcMain, {
        settings: {
          get: () => settingsCoordinator.getSettings(),
          update: (patch) => settingsCoordinator.updateSettings(patch),
          reset: () => settingsCoordinator.resetSettings(),
        },
        history,
        startup: {
          get: () => settingsCoordinator.getStartup(),
          set: (enabled) => settingsCoordinator.setStartup(enabled),
        },
        hotkeys: {
          current: () => settingsCoordinator.getHotkey(),
          replace: (accelerator) => settingsCoordinator.replaceHotkey(accelerator),
        },
        app: {
          show: () => windows.showMain(),
          hide: () => windows.hideMain(),
          minimize: () => windows.minimizeMain(),
          quit: () => app.quit(),
        },
        trustedSenders: () => windows.getTrustedRenderers(),
        dictation: {
          request(command): void {
            dispatchDictation(command)
            if (command.type === 'start' || command.type === 'toggle') {
              showWidget()
            }
          },
          publishWidgetState,
        },
        output,
        widget: {
          setMouseInteractive: (interactive) => windows.setWidgetMouseInteractive(interactive),
        },
        models: createModelIpcService(models, (status) => {
          windows.sendToMain(MODEL_STATUS, status)
        }),
        recoveryNotices: {
          list: () => recoveryNotices.list(),
        },
      })
      const unsubscribeRecoveryNotices = recoveryNotices.subscribe((notice) => {
        void messageDelivery.sendToMain(RECOVERY_NOTICE, notice).then((delivered) => {
          if (!delivered) logOperational('native-main-send-failed')
        })
      })
      const cleanupNativeIpc = (): void => {
        unsubscribeRecoveryNotices()
        cleanup()
      }
      if (e2eState === null) return cleanupNativeIpc
      ipcMain.handle(E2E_SNAPSHOT_CHANNEL, (event) => {
        if (!isTrustedMainE2ESender(event.sender, windows.getTrustedRenderers())) {
          throw new Error('E2E_SENDER_REJECTED')
        }
        return snapshotE2EState(
          e2eState,
          BrowserWindow.getAllWindows().some((candidate) => candidate.getTitle() === APP_NAME && candidate.isVisible()),
        )
      })
      ipcMain.handle(E2E_TRIGGER_SHORTCUT_CHANNEL, (event) => {
        if (!isTrustedMainE2ESender(event.sender, windows.getTrustedRenderers())) {
          throw new Error('E2E_SENDER_REJECTED')
        }
        const accelerator = hotkeys.current()
        if (accelerator === null || e2eShortcuts?.trigger(accelerator) !== true) {
          throw new Error('E2E_SHORTCUT_UNAVAILABLE')
        }
      })
      return () => {
        ipcMain.removeHandler(E2E_SNAPSHOT_CHANNEL)
        ipcMain.removeHandler(E2E_TRIGGER_SHORTCUT_CHANNEL)
        cleanupNativeIpc()
      }
    },
    log: logOperational,
  })
  } catch {
    try {
      nativeTray.destroy()
    } catch {
      // Startup will report one finite failure even if native tray cleanup also fails.
    }
    throw new NativeTrayCreationError()
  }
}

registerModelSchemesAsPrivileged(protocol)
enableWasmThreadSupport(app.commandLine)
app.setAppUserModelId(APP_ID)

void bootstrapTalkType({ app, initialize: createRuntime, log: logOperational }).catch(() => {
  logOperational('bootstrap-terminal-failed')
  app.quit()
})
