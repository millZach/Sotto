import { cleanSettingsHistory } from './settings/privacyCleanup'
import { registerHostQuitDrain, type HostQuitHandles } from './app/hostQuitDrain'
import { HOSTS_CHANGED } from '../shared/hosts'
import { parseHostEntityKey } from '../shared/clientIdentity'
import { DesktopHostRouter } from './hosts/desktopHostRouter'
import { DesktopHosts } from './hosts/desktopHosts'
import { HostSetup, hostSetupRequests } from './hosts/hostSetup'
import { agentJobTools, HostSetupToolServer } from './hosts/hostSetupTools'
import { HostProviderJobs } from './hosts/hostProviderJob'
import { HostUpdates } from './hosts/hostUpdate'
import { threadKeepsHostBusy } from '../shared/hostUpdates'
import { coordinatorSetupThreads } from './hosts/hostSetupThreads'
import { inactiveLocalHost, emptyDesktopState, requireLocalHistoryCleanup } from './hosts/inactiveLocalHost'
import { registerHostsIpc } from './hosts/ipc'
import { PhoneAccess, type PhoneAccessEvent } from './phones/phoneAccess'
import { TailscaleCli, tailscaleInvoker } from './phones/tailscale'
import { HostTailscale } from './hosts/tailscale'
import { registerPhonesIpc } from './phones/ipc'
import { e2eTailscale } from './e2e/tailscale'
import { e2eHostsTailscale } from './e2e/hostsTailscale'
import { e2eSshStandIn } from './e2e/sshStandIn'
import { SshHostLauncher } from './hosts/sshLauncher'
import { HostPhones } from './hosts/hostPhones'
import { PHONES_CHANGED } from '../shared/phones'
import { discoverSshHosts } from './hosts/sshSuggestions'
import { DevinAcpHost } from './agents/devin'
import { PersonalChatService } from './agents/personalChats'
import { ChatPromptService } from './agents/chatPrompts'
import { registerChatPromptIpc } from './agents/chatPromptIpc'
import { connectCheckpoints } from './tools/checkpointIntegration'
import { RequestDraftService, personalRequestDraftState } from './agents/requestDrafts'
import { registerRequestDraftIpc } from './agents/requestDraftIpc'
import { isThreadProviderConnected, type ProviderId } from '../shared/agents'
import { requestDraftProvider } from '../shared/requestDrafts'
import { registerPersonalChatIpc } from './agents/personalChatIpc'
import { PERSONAL_CHAT_STATE } from '../shared/personalChats'
import { version as appVersion } from '../../package.json'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  screen,
  session,
  safeStorage,
  shell,
  systemPreferences,
  Tray,
  type Event as ElectronEvent,
  type MenuItemConstructorOptions,
  type WebContentsWillFrameNavigateEventParams,
  type WebContentsWillNavigateEventParams,
  type WebContentsWillRedirectEventParams,
} from 'electron'
import { spawn } from 'node:child_process'
import { appendFile, rename, stat, writeFile } from 'node:fs/promises'
import { release as osRelease } from 'node:os'
import { isAbsolute, join } from 'node:path'

import {
  bootstrapSotto,
  installSessionPermissionPolicy,
  NativeRuntimeController,
  type BootstrapDiagnostic,
  type NativeRuntimeDiagnostic,
  type PermissionCheckHandler,
  type PermissionRequestHandler,
  type SessionPermissionAdapter,
} from './app/bootstrap'
import { buildApplicationMenuTemplate } from './app/applicationMenu'
import { installGuiPath } from './app/guiPath'
import { NativeMessageDelivery } from './app/nativeMessageDelivery'
import { NativeDictationLifecycle } from './app/nativeDictationLifecycle'
import { HotkeyManager, syncEscapeForWidgetSnapshot } from './hotkeys/hotkeyManager'
import { isAuthorizedIpcSender, registerIpc } from './ipc/registerIpc'
import { createMicrophoneAccessGate } from './media/microphoneAccess'
import {
  createSpawnProcessAdapter,
  OutputService,
  type PasteProcessAdapter,
} from './output/outputService'
import {
  ALWAYS_TRUSTED_ACCESSIBILITY,
  createAccessibilityGate,
  createAccessibilityGatedPasteAdapter,
  type AccessibilityTrustAdapter,
} from './output/pasteAccessibility'
import { createPasteCommands } from './output/pasteCommand'
import { createWarmPasteAdapter } from './output/pasteHelper'
import { TranscriptPolishService } from './llm/transcriptPolishService'
import { OpenRouterTranscriptionService } from './asr/openRouterTranscriptionService'
import { createElectronUpdaterAdapter } from './updates/electronUpdaterAdapter'
import { UpdateService } from './updates/updateService'
import { platformProfile, windowFrostFor, type WidgetAlwaysOnTopLevel } from './platformProfile'
import { RecoveryNoticeCenter } from './storage/recoveryNoticeCenter'
import { createStorageRepositories } from './storage/repositories'
import { migrateLegacyUserData } from './storage/migrateLegacyUserData'
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
  type DockAdapter,
  type NavigationEventName,
  type Rectangle,
  type RendererDiagnostic,
  type WebContentsLike,
  type WindowConstructorOptions,
} from './windows/windowManager'
import {
  DICTATION_COMMAND,
  RECOVERY_NOTICE,
  SETTINGS_CHANGED,
  UPDATE_CHECK_REQUESTED,
  UPDATE_STATUS,
} from '../shared/channels'
import { APP_ID, APP_NAME } from '../shared/constants'
import type { DictationCommand } from '../shared/contracts'
import type { WidgetSnapshot } from '../shared/dictation'
import { widgetPresentationFor } from '../shared/themeBranding'
import { resolvePlatform } from '../shared/platform'
import { defaultSettings, type AppSettings } from '../shared/settings'
import { blockSpellcheckDictionaryDownloads, enableWasmThreadSupport } from './security'
import {
  beginRuntimeVerification,
  registerLocalAssetProtocols,
  registerModelSchemesAsPrivileged,
} from './models/modelProtocol'
import {
  createE2EClipboard,
  createE2EGlobalShortcuts,
  createE2ENativeState,
  createE2EPasteProcess,
  resolveE2EConfiguration,
  isTrustedMainE2ESender,
  snapshotE2EState,
} from './e2e/e2eBoundary'
import { E2E_SNAPSHOT_CHANNEL, E2E_TRIGGER_SHORTCUT_CHANNEL, E2E_BROWSER_AGENT_CHANNEL, E2E_HOST_SETUP_TOOL_CHANNEL, e2eBrowserAgentSchema, e2eHostSetupToolSchema, e2eAgentEventSchema } from '../shared/e2e'
import { AGENT_STATE, AGENT_E2E, AGENT_THREAD_DETAIL } from '../shared/agents'
import { AgentCredentials } from './agents/credentials'
import { migrateDesktopKey } from './settings/migrateDesktopKey'
import { SecureSettings } from './agents/secureSettings'
import { registerSubagentIpc } from './agents/subagentIpc'
import { SUBAGENTS_CHANGED } from '../shared/subagents'
import { coalesceAgentStatePublishes, coalesceAgentThreadDetailPublishes } from './agents/control'
import { AgentStateBroadcaster } from './agents/agentStateBroadcast'
import { ConfiguredAgentReasoner } from './agents/reasoning'
import { ClaudeSubscriptionClient } from './agents/subscriptionClaude'
import { GrokSubscriptionClient } from './agents/subscriptionGrok'
import { CodexSubscriptionClient } from './agents/subscriptionCodex'
import { registerAgentIpc } from './agents/ipc'
import { desktopWindowClient } from './agents/hostService'
import { createAgentRuntime } from './agents/runtime'
import { loadHostIdentity } from './agents/hostIdentity'
import { registerFilesIpc } from './files/ipc'
import { FilesService } from './files/service'
import { registerToolsIpc } from './tools/ipc'
import { registerThemesIpc } from './themes/ipc'
import { OpenVsxClient } from './themes/openVsx'
import { createOpenVsxFixtureFetch } from './themes/openVsxFixture'
import { TerminalService } from './tools/terminal'
import { BrowserService } from './tools/browser'
import { createBrowserAgentServer } from './tools/browserAgentTools'
import { GitChangesService } from './tools/gitChanges'
import { CloudIphoneService } from './tools/cloudIphone/service'
import { CloudUsageLedger } from './tools/cloudIphone/usageLedger'
import { RunCloudClient } from './tools/cloudIphone/runCloudClient'
import { registerCloudIphoneIpc } from './tools/cloudIphoneIpc'
import { CLOUD_IPHONE_EVENT } from '../shared/cloudIphone'
import { TERMINAL_EVENT } from '../shared/terminal'
import { TERMINALS_EVENT } from '../shared/terminalWorkspace'
import { TerminalWorkspaceService } from './terminals/service'
import { registerTerminalWorkspaceIpc } from './terminals/ipc'
import { TERMINAL_WORKTREE_HOME, ThreadWorktrees, runWorktreeGit } from './agents/threadWorktrees'
import { githubPullRequestMerged } from './agents/worktreeCleanup'
import { ClaudeStreamJsonHost, type ClaudeAdapterEvent } from './agents/claude'
import { CodexAppServerHost } from './agents/codex'
import { BROWSER_EVENT } from '../shared/browser'
import { GIT_CHANGES_EVENT } from '../shared/gitChanges'
import { NaturalSpeechModels } from './agents/speechModels'
import { GrokSpeechService } from './agents/grokSpeech'
import { KokoroSpeechService } from './agents/kokoroSpeech'
import { e2eGrokSpeechFetch, e2eKokoroSpeechFetch } from './e2e/agentSpeech'
import { E2EAgentHost, e2eAgentReasoner } from './e2e/agentEffects'
import { E2EPersonalChatHost } from './e2e/personalChatHost'
import { openRuntimeMemory } from './memory/runtime'
import { PolicyStore } from './memory/policies'
import { MemoryProfile } from './memory/profile'
import { registerMemoryIpc } from './memory/ipc'
import { MEMORY_CHANGED } from '../shared/memory'
import { probeMemoryStore } from './memory/probe'

export { probeMemoryStore }

const e2eConfiguration = resolveE2EConfiguration(app.isPackaged, process.env)
if (e2eConfiguration === null) {
  delete process.env.SOTTO_E2E
  delete process.env.SOTTO_E2E_SCENARIO
  delete process.env.SOTTO_E2E_USER_DATA
} else if (e2eConfiguration !== null) {
  app.setPath('userData', e2eConfiguration.userDataPath)
}

// The only read of process.platform in the application; every platform-varying
// decision resolves through this profile.
const platform = resolvePlatform(process.platform)
const profile = platformProfile(platform)
const platformDefaults = defaultSettings(profile.defaultHotkey)

type NativeDiagnostic =
  | BootstrapDiagnostic
  | NativeRuntimeDiagnostic
  | RendererDiagnostic
  | 'bootstrap-terminal-failed'
  | 'native-main-send-failed'
  | 'native-widget-state-delivery-failed'
  | 'native-widget-show-failed'
  | 'settings-update-failed'
  | 'secure-key-migration-unavailable'
  | 'memory-store-open-failed'
  | 'history-temp-cleanup-failed'
  | 'checkpoint-unavailable'
  | 'worktree-cleanup-reclaimed'
  | 'worktree-cleanup-skipped'
  | 'thread-auto-settled'
  | 'thread-auto-settle-skipped'
  | ClaudeAdapterEvent
  | PhoneAccessEvent
  | 'host-phones-read-failed'
  | 'host-phones-command-failed'

function logOperational(code: NativeDiagnostic): void {
  console.error(`[Sotto] ${code}`)
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
    event: 'close' | 'closed' | 'moved' | 'maximize' | 'unmaximize' | 'hide' | 'minimize',
    listener: (event: { preventDefault(): void }) => void,
  ): void {
    if (event === 'close') {
      const wrapped = (nativeEvent: { preventDefault(): void }): void => listener(nativeEvent)
      this.window.on('close', wrapped)
      this.windowListenerCleanups.set(listener, () => this.window.removeListener('close', wrapped))
      return
    }
    if (event === 'hide' || event === 'minimize') {
      const wrapped = (): void => listener({ preventDefault: () => undefined })
      if (event === 'hide') {
        this.window.on('hide', wrapped)
        this.windowListenerCleanups.set(listener, () => this.window.removeListener('hide', wrapped))
      } else {
        this.window.on('minimize', wrapped)
        this.windowListenerCleanups.set(listener, () => this.window.removeListener('minimize', wrapped))
      }
      return
    }
    if (event === 'moved' || event === 'maximize' || event === 'unmaximize') {
      const wrapped = (): void => listener({ preventDefault: () => undefined })
      if (event === 'maximize') {
        this.window.on('maximize', wrapped)
        this.windowListenerCleanups.set(listener, () => this.window.removeListener('maximize', wrapped))
      } else if (event === 'unmaximize') {
        this.window.on('unmaximize', wrapped)
        this.windowListenerCleanups.set(listener, () => this.window.removeListener('unmaximize', wrapped))
      } else {
        this.window.on('moved', wrapped)
        this.windowListenerCleanups.set(listener, () => this.window.removeListener('moved', wrapped))
      }
      return
    }

    const wrapped = (): void => listener({ preventDefault: () => undefined })
    this.window.on('closed', wrapped)
    this.windowListenerCleanups.set(listener, () => this.window.removeListener('closed', wrapped))
  }

  removeListener(
    _event: 'close' | 'closed' | 'moved' | 'maximize' | 'unmaximize' | 'hide' | 'minimize',
    listener: (event: { preventDefault(): void }) => void,
  ): void {
    this.windowListenerCleanups.get(listener)?.()
    this.windowListenerCleanups.delete(listener)
  }

  getPosition(): readonly [number, number] {
    const { x, y } = this.window.getContentBounds()
    return [x, y]
  }

  setIgnoreMouseEvents(ignore: boolean, options?: { readonly forward: boolean }): void {
    this.window.setIgnoreMouseEvents(ignore, options)
  }

  setBackgroundColor(color: string): void {
    this.window.setBackgroundColor(color)
  }

  setBackgroundMaterial(material: 'acrylic' | 'none'): void {
    this.window.setBackgroundMaterial(material)
  }

  setVibrancy(type: 'under-window' | null): void {
    this.window.setVibrancy(type)
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
  setFocusable(focusable: boolean): void { this.window.setFocusable(focusable) }

  maximize(): void { this.window.maximize() }
  unmaximize(): void { this.window.unmaximize() }
  isMaximized(): boolean { return this.window.isMaximized() }

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

  setAlwaysOnTop(flag: boolean, level?: WidgetAlwaysOnTopLevel): void {
    this.window.setAlwaysOnTop(flag, level)
  }

  setVisibleOnAllWorkspaces(
    visible: boolean,
    options?: { readonly visibleOnFullScreen: boolean },
  ): void {
    this.window.setVisibleOnAllWorkspaces(visible, options)
  }

  getBounds(): Rectangle {
    return this.window.getContentBounds()
  }

  setBounds(bounds: Rectangle, animate?: boolean): void {
    this.window.setContentBounds(bounds, animate)
  }

  setPosition(x: number, y: number, animate?: boolean): void {
    const bounds = this.window.getContentBounds()
    this.window.setContentBounds({ ...bounds, x, y }, animate)
  }

  setSize(width: number, height: number, animate?: boolean): void {
    this.window.setContentSize(width, height, animate)
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
  blockSpellcheckDictionaryDownloads(session.defaultSession)
  // Dock and Finder launch with the system PATH. Provider CLIs live in the user's login PATH.
  await installGuiPath()
  const userDataPath = app.getPath('userData')
  const memoryStore = openRuntimeMemory(join(userDataPath, 'memory.sqlite'), logOperational)
  const memoryProfile = memoryStore === undefined ? undefined : new MemoryProfile(memoryStore)
  const authority = memoryStore === undefined ? undefined : new PolicyStore(memoryStore)
  app.on('will-quit', () => memoryStore?.close())
  const naturalSpeechModels = new NaturalSpeechModels(join(userDataPath, 'models'))
  const resourceRoot = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources')
  // The runtime's hash starts here so it overlaps the stores loading below rather than following them.
  // It is awaited where it always was, before any window, and a tampered runtime still fails startup.
  const runtimeVerification = e2eConfiguration === null
    ? beginRuntimeVerification(join(resourceRoot, 'runtime'))
    : null
  await naturalSpeechModels.initialize()
  // Packaged builds get the brand icon stamped onto the executable by
  // electron-builder; an unpackaged run has to name the repository icon itself.
  const unpackagedIconPath = app.isPackaged
    ? null
    : join(__dirname, '../../build/icon.ico')
  const recoveryNotices = new RecoveryNoticeCenter()
  const { settings: plainSettings, history } = createStorageRepositories(
    userDataPath,
    recoveryNotices,
    Date.now,
    platformDefaults,
    logOperational,
  )
  await history.initialize()
  const credentials = new AgentCredentials(userDataPath, safeStorage, notice => recoveryNotices.publish(notice))
  await credentials.load()
  const cloudIphoneLedger = new CloudUsageLedger(userDataPath)
  await cloudIphoneLedger.load()
  const grokSpeech = new GrokSpeechService({ credentials, ...(e2eConfiguration === null ? {} : { fetchFn: e2eGrokSpeechFetch }) })
  const kokoroSpeech = new KokoroSpeechService({ credentials, ...(e2eConfiguration === null ? {} : { fetchFn: e2eKokoroSpeechFetch }) })
  const settings = new SecureSettings(plainSettings, credentials)
  await migrateDesktopKey(settings, recoveryNotices, logOperational)
  await plainSettings.migrateProjectWorkingCopyDefaults(await loadHostIdentity(userDataPath))
  const startupSettings = await settings.get()
  let agentHistoryEnabled = startupSettings.historyEnabled
  let workingCopySettings = startupSettings
  // Two beta gates the renderer hides surfaces behind; main keeps their promise. With the voice coordinator
  // off no thread stays managed across a start, and with memory off no turn retrieves preferences.
  let agentVoiceCoordinatorEnabled = startupSettings.voiceCoordinatorEnabled
  const agentMemoryEnabled = startupSettings.memoryEnabled
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
  // Main owns the widget's presentation: every snapshot is stamped with the
  // current theme halves, so a theme change repaints the widget mid-session.
  let widgetPresentation = widgetPresentationFor(await settings.get())
  let handleRendererProcessGone: (kind: 'main' | 'widget') => void = () => undefined
  const nativeDock = app.dock
  const dock: DockAdapter | null =
    e2eConfiguration === null && profile.dockPresence === 'dynamic' && nativeDock !== undefined
      ? {
          show: () => {
            void nativeDock.show()
          },
          hide: () => {
            nativeDock.hide()
          },
        }
      : null
  if (dock !== null) {
    // The Dock icon is owned by main-window visibility, so it starts hidden and
    // WindowManager reveals it with the first window.
    try {
      dock.hide()
    } catch {
      // A Dock that refuses to hide is cosmetic and must not fail startup.
    }
  }
  const windows = new WindowManager({
    createWindow: createBrowserWindow,
    display: screen,
    platform: profile.platform,
    chrome: profile,
    dock,
    preloadPath: join(__dirname, '../preload/index.js'),
    mainHtmlPath: join(__dirname, '../renderer/index.html'),
    widgetHtmlPath: join(__dirname, '../renderer/widget.html'),
    developmentSources: app.isPackaged
      ? undefined
      : parseDevelopmentRendererSources(process.env.ELECTRON_RENDERER_URL),
    brandIconPath: unpackagedIconPath,
    isPackaged: app.isPackaged,
    log: logOperational,
    onRendererProcessGone: (kind) => handleRendererProcessGone(kind),
    getWidgetPlacement: () => widgetPlacement,
    onWidgetMoved: (placement) => {
      widgetPlacement = { kind: 'edge', ...placement }
      void widgetPlacementStore.save(placement)
    },
    windowFrost: windowFrostFor(profile.platform, osRelease()),
    frostedWindow: () => workingCopySettings.frostedWindow,
  })
  // This explicit development-only path drives the real adapter through a scripted ACP child.
  const devinFixtureRoot = e2eConfiguration !== null && !app.isPackaged ? process.env['SOTTO_E2E_DEVIN_ROOT'] : undefined
  const devinFixtureExecutable = process.env['SOTTO_E2E_DEVIN_EXECUTABLE']
  if (devinFixtureRoot && (!isAbsolute(devinFixtureRoot) || !devinFixtureExecutable || !isAbsolute(devinFixtureExecutable))) {
    throw new Error('The Devin test fixture requires absolute paths.')
  }
  // The same for Claude and Codex: the real adapters over the fake CLIs, so a benchmark measures what they hold.
  const nativeFixtureRoot = e2eConfiguration !== null && !app.isPackaged && !devinFixtureRoot ? process.env['SOTTO_E2E_NATIVE_FIXTURE_ROOT'] : undefined
  const nativeFixtureExecutable = process.env['SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE']
  if (nativeFixtureRoot && (!isAbsolute(nativeFixtureRoot) || !nativeFixtureExecutable || !isAbsolute(nativeFixtureExecutable))) {
    throw new Error('The native test fixture requires absolute paths.')
  }
  const testAgentHost = e2eConfiguration === null || devinFixtureRoot || nativeFixtureRoot ? null : new E2EAgentHost(e2eConfiguration.scenario)
  // A Playwright journey pushes to an owned remote and "creates" its pull request through a scripted gh; development only.
  const ghStandInScript = e2eConfiguration !== null && !app.isPackaged ? process.env['SOTTO_E2E_GH_SCRIPT'] : undefined
  const ghStandInExecutable = process.env['SOTTO_E2E_GH_EXECUTABLE']
  if (ghStandInScript && (!isAbsolute(ghStandInScript) || !ghStandInExecutable || !isAbsolute(ghStandInExecutable))) throw new Error('The gh test stand-in requires absolute paths.')
  const ghStandIn = ghStandInScript && ghStandInExecutable ? { executable: ghStandInExecutable, args: [ghStandInScript] } : undefined
  // Static design fixtures include deliberately unavailable folders. Interactive E2E
  // journeys need real, profile-owned folders and exercise the production cwd checks.
  if (testAgentHost !== null && process.env['SOTTO_DESIGN_CAPTURE'] !== '1') {
    await testAgentHost.initializeWorkingFolders(join(userDataPath, 'agent-workspaces'))
  }
  let openedThreadFolder: string | null = null
  // T3's rule for background Git reads: the window is showing and has the focus, or had it within the last 45 seconds.
  let windowBlurredAt = 0
  app.on('browser-window-focus', () => { windowBlurredAt = 0 })
  app.on('browser-window-blur', () => { windowBlurredAt = Date.now() })
  const windowInFront = (): boolean => BrowserWindow.getAllWindows().some(window => window.getTitle() === APP_NAME && window.isVisible() && !window.isMinimized()
    && (window.isFocused() || (windowBlurredAt !== 0 && Date.now() - windowBlurredAt < 45_000)))
  // Personal chats start after the runtime; until they do, a client update has nothing of theirs to tell.
  const personalClients: { updated?: (provider: ProviderId) => Promise<void> } = {}
  const localRuntime = startupSettings.localHostEnabled ? await createAgentRuntime({
    directory: userDataPath, credentials,
    clientUpdated: async provider => { await personalClients.updated?.(provider) },
    ...(app.isPackaged ? { claudeHistoryModulePath: join(process.resourcesPath, 'claude-sdk', 'sdk.mjs') } : {}),
    settings: () => workingCopySettings, writingSettings: () => settings.get(),
    historyEnabled: () => agentHistoryEnabled, coordinatorEnabled: () => agentVoiceCoordinatorEnabled,
    gitStatus: { fetchIntervalMs: () => workingCopySettings.gitFetchIntervalSeconds * 1000, foreground: windowInFront, ...(ghStandIn ? { ghStandIn } : {}) },
    openExternal: url => shell.openExternal(url),
    openThreadFolder: async path => {
      if (e2eConfiguration !== null) { openedThreadFolder = path; return }
      const error = await shell.openPath(path); if (error) throw new Error(error)
    },
    ...(authority === undefined ? {} : { authority }),
    ...(memoryProfile === undefined || !agentMemoryEnabled ? {} : { preferences: memoryProfile }),
    logFailure: (code, detail) => { console.error(`[Sotto] ${code} ${detail}`) },
    bindRequestDraftDecision: (target, decisionId, answers) => requestDrafts.bindDecision(target, decisionId, answers),
    ...(testAgentHost === null ? {} : { host: testAgentHost }),
    ...(devinFixtureRoot ? { providers: {
      codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(),
      devin: new DevinAcpHost(userDataPath, {
        executable: devinFixtureExecutable!, args: [join(__dirname, '../../tests/fixtures/fakeDevinAgent.mjs'), devinFixtureRoot],
        nativeConfigDirectory: join(devinFixtureRoot, 'native-config'), pollIntervalMs: 50,
      }),
    } } : {}),
    ...(nativeFixtureRoot ? { providers: {
      claude: new ClaudeStreamJsonHost({ userDataPath, executable: nativeFixtureExecutable!,
        args: [join(__dirname, '../../tests/fixtures/fakeClaudeThread.mjs'), join(nativeFixtureRoot, 'claude')], claudeHome: join(nativeFixtureRoot, 'claude', 'home') }),
      codex: new CodexAppServerHost({ userDataPath, executable: nativeFixtureExecutable!,
        args: [join(__dirname, '../../tests/fixtures/fakeCodexAppServer.mjs'), join(nativeFixtureRoot, 'codex')], codexHome: join(nativeFixtureRoot, 'codex', 'home') }),
      grok: new E2EAgentHost(), devin: new E2EAgentHost(),
    } } : {}),
    ...(e2eConfiguration === null ? {} : { reasoner: e2eAgentReasoner }),
    worktreeCleanup: { ...(e2eConfiguration === null ? { pullRequestMerged: githubPullRequestMerged } : {}), log: code => { logOperational(code) } },
    claudeSettingsLog: event => { logOperational(event) },
  }) : await inactiveLocalHost(userDataPath)
  const { agentHost, agentControl, threadRegistry, turns, hostService } = localRuntime
  // The window's panes show their threads only while it has the focus (ADR-0046). The widget taking the focus is the
  // window losing it, as is another app, minimising or hiding to the tray.
  const windowFocusChanged = (): void => {
    const focused = BrowserWindow.getFocusedWindow()
    hostService.setWindowFocused(focused !== null && focused.webContents === windows.getMainWebContents())
  }
  app.on('browser-window-focus', windowFocusChanged)
  app.on('browser-window-blur', windowFocusChanged)
  windowFocusChanged()
  const quitHandles: HostQuitHandles = { localRuntime }
  registerHostQuitDrain(app, quitHandles, () => console.error('[Sotto] host-shutdown-failed'), () => logOperational('phone-access-close-failed'))
  let browserService: BrowserService | undefined
  let cloudIphoneService: CloudIphoneService | undefined
  const browserAgentServer = createBrowserAgentServer(() => browserService, () => cloudIphoneService)
  agentHost.useBrowserTools(browserAgentServer)
  // The runtime builds the worktree cleanup (ADR-0041). Only the local host has worktrees on this
  // computer; with it off the inactive host's cleanup does nothing, and no terminal check is wired.
  const worktreeCleanup = startupSettings.localHostEnabled ? localRuntime.worktreeCleanup : null
  const hostRouter = new DesktopHostRouter(() => emptyDesktopState(agentControl.get().hostId))
  quitHandles.hostRouter = hostRouter
  if (startupSettings.localHostEnabled) hostRouter.add({
    hostId: agentControl.get().hostId!, name: 'This computer', kind: 'local', service: hostService,
    detail: id => agentControl.threadDetail(id), preview: request => agentControl.attachmentPreview(request),
    stage: image => agentControl.stageAttachment(image), content: digest => agentControl.attachmentContent(digest),
    gitRefs: request => agentControl.gitRefs(request), gitChangedFiles: request => agentControl.gitChangedFiles(request), gitPullRequest: request => agentControl.gitPullRequest(request),
    hostFolders: request => hostService.hostFolders(request),
    subscribeDetail: listener => agentControl.subscribeThreadDetail(listener),
  })
  // A Playwright journey adds hosts through a scripted ssh; development only, like the gh stand-in.
  const sshStandInScript = e2eConfiguration !== null && !app.isPackaged ? process.env['SOTTO_E2E_SSH_SCRIPT'] : undefined
  const sshStandInExecutable = process.env['SOTTO_E2E_SSH_EXECUTABLE']
  if (sshStandInScript && (!isAbsolute(sshStandInScript) || !sshStandInExecutable || !isAbsolute(sshStandInExecutable))) throw new Error('The ssh test stand-in requires absolute paths.')
  const sshStandIn = sshStandInScript && sshStandInExecutable ? e2eSshStandIn(sshStandInExecutable, sshStandInScript) : undefined
  /** The last page an end-to-end run asked the browser to open, which it never opens. */
  let openedExternalLink: string | null = null
  const desktopHosts = new DesktopHosts({ directory: userDataPath, credentials, router: hostRouter,
    localHostRunning: startupSettings.localHostEnabled, localHostEnabled: () => workingCopySettings.localHostEnabled,
    restart: () => { app.relaunch(); app.quit() },
    ...(sshStandIn ? { launcher: () => new SshHostLauncher({ spawn: sshStandIn }) } : {}),
    openExternal: async url => { if (e2eConfiguration === null) await shell.openExternal(url); else openedExternalLink = url },
  })
  quitHandles.desktopHosts = desktopHosts
  await desktopHosts.start()
  // Have my agent set this up (ADR-0035): a host setup thread on this computer, with the host setup tools while it
  // runs. The thread reaches the device through this computer's SSH setup, so it needs the local host.
  // Have my agent install it, update it or fix it on a host's provider tile runs the same way, in the same project, and
  // one agent job runs at a time: a host setup or a provider job.
  const agentJobThreads = coordinatorSetupThreads({ coordinator: agentControl, folder: join(userDataPath, 'host-setup'), localHostRunning: startupSettings.localHostEnabled })
  const providerJobs: HostProviderJobs = new HostProviderJobs({ threads: agentJobThreads,
    hosts: { host: id => desktopHosts.jobHost(id), provider: (id, provider) => desktopHosts.providerStatus(id, provider),
      refresh: (id, provider) => desktopHosts.refreshProvider(id, provider),
      subscribe: listener => { const off = [hostRouter.subscribe(() => listener()), desktopHosts.subscribe(() => listener())]; return () => { for (const item of off) item() } } },
    busy: (): string | undefined => { const setup = hostSetup.state(); return setup && (setup.phase === 'starting' || setup.phase === 'running') ? `An agent is setting up ${setup.name} now. Stop that setup first. Nothing was started.` : undefined } })
  const hostSetup: HostSetup = new HostSetup({ version: appVersion,
    hosts: { check: connection => desktopHosts.check(connection), add: connection => desktopHosts.setupAdd(connection), forget: id => desktopHosts.forgetSaved(id),
      attempt: id => desktopHosts.attempt(id), cancelAttempt: id => desktopHosts.cancelAttempt(id), savedAs: (target, port) => desktopHosts.savedAs(target, port) },
    threads: agentJobThreads, busy: (): string | undefined => providerJobs.busySentence() })
  const hostSetupTools = new HostSetupToolServer(agentJobTools(hostSetup, providerJobs))
  quitHandles.providerJobs = providerJobs
  quitHandles.hostSetup = hostSetup
  quitHandles.hostSetupTools = hostSetupTools
  hostSetup.useTools(threadId => hostSetupTools.revoke(threadId))
  providerJobs.useTools(threadId => hostSetupTools.revoke(threadId))
  agentHost.useHostSetupTools(hostSetupTools)
  agentControl.useSottoRequests(hostSetupRequests(hostSetup))
  desktopHosts.useSetup(hostSetup)
  desktopHosts.useProviderJob(providerJobs)
  // Hosts that run an older Sotto than this computer, and their updates from the Threads page (ADR-0040). Stop N threads
  // and update stops a turn the way the composer's Stop does. A development end-to-end run serves its own releases.
  const releasesStandIn = e2eConfiguration !== null && !app.isPackaged ? process.env['SOTTO_E2E_HOST_RELEASES_URL'] : undefined
  const hostUpdates = new HostUpdates({ version: appVersion, ...(releasesStandIn ? { releasesUrl: releasesStandIn } : {}),
    hosts: { candidates: () => desktopHosts.updateCandidates(), run: (id, operation, options) => desktopHosts.runUpdate(id, operation, options),
      restart: (id, version, options) => desktopHosts.restartForUpdate(id, version, options), subscribe: listener => desktopHosts.subscribe(() => listener()) },
    threads: {
      working: hostId => hostRouter.shell().host.threads.filter(thread => thread.hostId === hostId && threadKeepsHostBusy(thread)).map(thread => thread.id),
      interrupt: async threadId => { await hostRouter.command({ type: 'interrupt', threadId }, desktopWindowClient()) },
      subscribe: listener => hostRouter.subscribe(() => listener()),
    } })
  desktopHosts.useUpdates(hostUpdates)
  quitHandles.hostUpdates = hostUpdates
  // Each remote host runs its own phone access; its Phones dialog reads and changes it over the host's SSH connection (ADR-0050).
  const hostPhones = new HostPhones({
    hosts: { links: () => desktopHosts.phonesLinks(), subscribe: listener => desktopHosts.subscribe(() => listener()) },
    openExternal: async url => { if (e2eConfiguration === null) await shell.openExternal(url) },
    log: logOperational,
  })
  desktopHosts.usePhones(hostPhones)
  quitHandles.hostPhones = hostPhones
  // Phone access serves the local host's own threads to paired phones over the tailnet (ADR-0033). Its
  // Tailscale checks can take seconds, so they run beside startup rather than in front of the window.
  const phoneAccess = new PhoneAccess({ directory: userDataPath,
    service: startupSettings.localHostEnabled ? hostService : undefined,
    tailscale: e2eConfiguration === null ? new TailscaleCli() : e2eTailscale(userDataPath),
    settings: () => workingCopySettings, policy: authority,
    openExternal: async url => { if (e2eConfiguration === null) await shell.openExternal(url) },
    log: logOperational,
  })
  quitHandles.phoneAccess = phoneAccess
  void phoneAccess.start().catch(() => logOperational('phone-access-start-failed'))
  const testPersonalChatHosts = e2eConfiguration ? {
    codex: new E2EPersonalChatHost(userDataPath), claude: new E2EPersonalChatHost(userDataPath, 'claude'), grok: new E2EPersonalChatHost(userDataPath, 'grok'),
  } : undefined
  const personalChats = new PersonalChatService({ userDataPath,
    ...(app.isPackaged ? { claudeHistoryModulePath: join(process.resourcesPath, 'claude-sdk', 'sdk.mjs') } : {}), bindRequestDraftDecision: (target, decisionId, answers) => requestDrafts.bindDecision(target, decisionId, answers), configuration: () => agentControl.configuration(),
    ...(memoryProfile && agentMemoryEnabled ? { preferences: memoryProfile } : {}), historyEnabled: () => agentHistoryEnabled,
    ...(testPersonalChatHosts ? { hosts: testPersonalChatHosts } : {}) })
  quitHandles.personalChats = personalChats
  await personalChats.start()
  personalClients.updated = provider => personalChats.clientUpdated(provider)
  const promptSubscriptions = {
    claude: new ClaudeSubscriptionClient(join(userDataPath, 'reasoning', 'claude-prompts')),
    codex: new CodexSubscriptionClient(join(userDataPath, 'reasoning', 'codex-prompts')),
    grok: new GrokSubscriptionClient(join(userDataPath, 'reasoning', 'grok-prompts')),
  }
  // Transform text through the chat's original provider. Defaults cannot move
  // an existing discussion to another account, and this path has no host tools.
  const chatPrompts = new ChatPromptService(personalChats, async (system, input, chat) => {
    if (e2eConfiguration) {
      const source = input.messages.filter(message => message.role === 'user').at(-1)!
      return { objective: [{ text: source.text, evidence: [{ messageId: source.id, quote: source.text }] }],
        context: [], decisions: [], constraints: [], deliverables: [], acceptanceChecks: [], unresolvedQuestions: [], suggestions: [] }
    }
    return new ConfiguredAgentReasoner(() => ({ ...agentControl.configuration(),
      reasoning: chat.providerId, reasoningModel: chat.modelId.replace(/^(?:codex|claude|grok):/u, ''), reasoningEffort: chat.reasoningEffort ?? '',
    }), credentials, promptSubscriptions).transformText(system, input)
  })
  const requestDrafts: RequestDraftService = new RequestDraftService(userDataPath, owner => {
    if (owner.kind === 'personal') return personalRequestDraftState(personalChats.get(), owner)
    const key = parseHostEntityKey(owner.ownerId)
    const remote = key !== null && key.hostId !== agentControl.get().hostId
    const state = remote ? hostRouter.shell() : agentControl.shell()
    const id = remote ? owner.ownerId : key?.id ?? owner.ownerId
    const thread = state.host.threads.find(item => item.id === id
      && requestDraftProvider(state.host, item, state.configuration.provider) === owner.providerId)
    const recovery = remote ? { completed: [], uncertainRequestIds: thread?.requests.filter(request => request.delivery === 'uncertain').map(request => request.id) ?? [] } : agentControl.requestAnswerRecovery(id, owner.providerId)
    return thread ? { connected: isThreadProviderConnected(state.host, thread), ready: thread.historyStatus !== 'loading' && thread.historyStatus !== 'error',
      requests: thread.requests, ...recovery } : recovery.completed.length ? { connected: false, ready: false, requests: [], ...recovery } : undefined
  }, async owner => {
    if (owner.kind === 'personal') await personalChats.refresh(owner.ownerId)
    else { const key = parseHostEntityKey(owner.ownerId); if (key && key.hostId !== agentControl.get().hostId) await hostRouter.threadDetail(owner.ownerId); else await agentControl.refreshRequestDraft(key?.id ?? owner.ownerId) }
  })
  await requestDrafts.start()
  await requestDrafts.reconcile().catch(() => undefined)
  const reconcileRequestDrafts = (): void => { void requestDrafts.reconcile().catch(() => undefined) }
  const unsubscribePersonalChats = personalChats.subscribe(state => { reconcileRequestDrafts(); windows.sendToMain(PERSONAL_CHAT_STATE, state) })

  // The shell reaches both windows; the widget draws a thread's state, never its history, so it needs
  // nothing more. Only the threads the main window has declared viewed receive their messages.
  const agentStateBroadcaster = new AgentStateBroadcaster()
  const agentStatePublisher = coalesceAgentStatePublishes(state => {
    reconcileRequestDrafts()
    personalChats.configurationChanged()
    // A window's model catalog rarely changes; omitting a repeat is most of what this saves (issue #286).
    agentStateBroadcaster.send(state, 'main', payload => windows.sendToMain(AGENT_STATE, payload))
    agentStateBroadcaster.send(state, 'widget', payload => windows.sendToWidget(AGENT_STATE, payload))
    if (state.configuration.enabled) void windows.showWidget().catch(() => undefined)
  })
  const agentDetailPublisher = coalesceAgentThreadDetailPublishes(detail => windows.sendToMain(AGENT_THREAD_DETAIL, detail))
  const unsubscribeAgents = hostRouter.subscribe(state => agentStatePublisher.publish(state))
  const unsubscribeAgentDetail = hostRouter.subscribeThreadDetail(detail => agentDetailPublisher.publish(detail))
  // Quitting drops the held state with its timer: the windows it would reach are going away.
  quitHandles.stopPublishing = () => {
    unsubscribePersonalChats(); unsubscribeAgents(); unsubscribeAgentDetail()
    agentStatePublisher.dispose(); agentDetailPublisher.dispose()
  }
  const showTurnRecords = (): void => {
    void (async () => {
      await writeFile(turns.path(), '', { flag: 'wx' }).catch(() => undefined)
      shell.showItemInFolder(turns.path())
      console.log(`[Sotto] ${(await turns.recent(20)).length} recent turn records`)
    })().catch(() => console.error('[Sotto] turn-records-unavailable'))
  }
  // The window runs the check itself, so the macOS app menu and the tray share
  // the footer control's spinner, toasts, and offer rather than growing a
  // second path.
  const requestUpdateCheck = (): void => {
    void windows.showMain()
      .then(() => { windows.sendToMain(UPDATE_CHECK_REQUESTED, null) })
      .catch(() => logOperational('native-main-show-failed'))
  }
  const applicationMenuTemplate = buildApplicationMenuTemplate({
    platform,
    appName: APP_NAME,
    includeDeveloperTools: !app.isPackaged,
    onShowSettings: () => {
      void windows.showMain().catch(() => logOperational('native-main-show-failed'))
    },
    onCheckForUpdates: requestUpdateCheck,
    onShowTurnRecords: showTurnRecords,
  })
  if (applicationMenuTemplate !== null) {
    // Windows keeps Electron's default menu: installing null would also drop the
    // reload/devtools accelerators the app ships with today.
    Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate))
  }
  const runtimeSource = runtimeVerification === null ? null : await runtimeVerification
  const e2eState = e2eConfiguration === null ? null : createE2ENativeState()
  const pasteCommands = createPasteCommands(platform)
  const warmPaste = e2eConfiguration === null && pasteCommands.helper !== null
    ? createWarmPasteAdapter({
        spawnHelper: (invocation) =>
          spawn(invocation.executable, [...invocation.args], {
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'ignore'],
          }),
        fallback: createSpawnProcessAdapter((executable, args, options) =>
          spawn(executable, args, options),
        ),
      })
    : null
  // Pay the helper's one-time Add-Type compile at startup instead of on the
  // first dictation.
  warmPaste?.start()
  app.on('will-quit', () => warmPaste?.dispose())
  const basePaste: PasteProcessAdapter = e2eConfiguration === null
    ? warmPaste
      ?? createSpawnProcessAdapter((executable, args, options) => spawn(executable, args, options))
    : createE2EPasteProcess(e2eState!, e2eConfiguration.scenario, (text) => {
        const mainWindow = BrowserWindow.getAllWindows().find(
          (candidate) => candidate.getTitle() === APP_NAME,
        )
        mainWindow?.webContents.insertText(text)
      })
  const accessibilityTrust: AccessibilityTrustAdapter =
    e2eConfiguration === null && profile.pasteRequiresAccessibilityTrust
      ? { isTrusted: (prompt) => systemPreferences.isTrustedAccessibilityClient(prompt) }
      : ALWAYS_TRUSTED_ACCESSIBILITY
  const output = new OutputService({
    clipboard: e2eState === null ? clipboard : createE2EClipboard(e2eState, e2eConfiguration?.scenario),
    widget: windows,
    delay: (milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds)
      }),
    process: createAccessibilityGatedPasteAdapter({
      gate: createAccessibilityGate(accessibilityTrust),
      inner: basePaste,
      onUntrusted: () => recoveryNotices.publish({ code: 'ACCESSIBILITY_PERMISSION_REQUIRED' }),
    }),
    buildPasteInvocation: pasteCommands.oneShot,
  })

  const copyOutput = async (text: string): Promise<void> => {
    await output.deliver(text, { autoPaste: false, pasteDelayMs: 0 })
  }

  // Local, text-free diagnostics: one JSON line per event, rotated past 256 KB,
  // never sent anywhere. They carry counts and reasons, never words, audio or keys.
  const diagnosticsAppender = (fileName: string) => {
    const path = join(app.getPath('userData'), fileName)
    return (diagnostic: object): void => {
      void (async () => {
        const info = await stat(path).catch(() => null)
        if (info !== null && info.size > 256 * 1024) {
          await rename(path, `${path}.1`).catch(() => undefined)
        }
        await appendFile(path, `${JSON.stringify(diagnostic)}\n`)
      })().catch(() => undefined)
    }
  }

  // Formatting-pass HTTP calls stay deterministic and offline in E2E runs.
  // Word-count-only diagnostics (no transcript content) distinguish "raw text
  // was already short" from "polish truncated it" when users report loss.
  const transcriptPolish = new TranscriptPolishService({
    getSettings: () => settings.forFormatting(),
    onDiagnostic: diagnosticsAppender('polish-diagnostics.jsonl'),
    ...(e2eConfiguration === null
      ? {}
      : { fetchFn: () => Promise.reject(new Error('E2E_NETWORK_DISABLED')) }),
  })

  // Hosted transcription stays offline in E2E runs; the renderer uses its fake transcriber.
  // Each failed request records its reason and HTTP status, so a lost dictation can be
  // told apart afterwards: out of credit, rate limited, or a service error.
  const transcription = new OpenRouterTranscriptionService({
    getSettings: () => settings.forFormatting(),
    onFailure: diagnosticsAppender('transcription-diagnostics.jsonl'),
    ...(e2eConfiguration === null
      ? {}
      : { fetchFn: () => Promise.reject(new Error('E2E_NETWORK_DISABLED')) }),
  })

  // GitHub Releases is only a real feed for the packaged Windows build: the
  // macOS disk image ships no update metadata, and a development or E2E run
  // must never reach the network. Everywhere else the service resolves to the
  // 'unsupported' phase without constructing electron-updater at all.
  const updatesSupported = app.isPackaged && e2eConfiguration === null && platform === 'win32'
  const updates = new UpdateService({
    currentVersion: appVersion,
    getSettings: () => settings.get(),
    ...(updatesSupported ? { createUpdater: createElectronUpdaterAdapter } : {}),
    onStatusChanged: (status) => {
      windows.sendToMain(UPDATE_STATUS, status)
    },
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
        source: profile.trayIcon,
        executablePath: process.execPath,
        unpackagedIconPath,
        getFileIcon: (path, options) => app.getFileIcon(path, options),
        resolveResourcePath: (relativePath) => join(resourceRoot, relativePath),
        loadImageIcon: (path) => nativeImage.createFromPath(path),
        markTemplate: (icon) => icon.setTemplateImage(true),
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
    defaults: platformDefaults,
    onAutoPasteChanged(enabled): void {
      currentTrayState = { ...currentTrayState, autoPaste: enabled }
      trayController.update(currentTrayState)
    },
    async onSettingsChanged(settings): Promise<void> {
      const grantDefaultChanged = settings.browserWithoutAsking !== workingCopySettings.browserWithoutAsking
      if (settings.frostedWindow !== workingCopySettings.frostedWindow) windows.setMainWindowFrosted(settings.frostedWindow)
      workingCopySettings = settings
      worktreeCleanup?.settingsChanged()
      phoneAccess.settingsChanged()
      if (grantDefaultChanged) browserService?.settingChanged()
      agentHistoryEnabled = settings.historyEnabled
      agentVoiceCoordinatorEnabled = settings.voiceCoordinatorEnabled
      await cleanSettingsHistory(agentControl, personalChats, async () => {
        showWidgetWhenIdle = settings.showWidgetWhenIdle
        widgetPresentation = widgetPresentationFor(settings)
        if (!dictationLifecycle.isIdle()) {
          await dictationLifecycle.repaint()
        } else if (settings.onboardingComplete) {
          // Re-seed the resting sliver so theme/shortcut changes repaint it and
          // the idle-visibility reveal/conceal decision is re-evaluated.
          await publishIdleWidgetState(settings)
        } else if (!settings.showWidgetWhenIdle) {
          windows.hideWidget()
        }
        const delivered = await messageDelivery.sendToMain(SETTINGS_CHANGED, settings)
        if (!delivered) logOperational('native-main-send-failed')
      })
    },
  })
  const trayController = new TrayController(trayAdapter, {
    ...(!app.isPackaged ? { showTurnRecords } : {}),
    toggleDictation,
    setAutoPaste(enabled): void {
      void settingsCoordinator
        .updateSettings({ autoPaste: enabled })
        .catch(() => logOperational('settings-update-failed'))
    },
    show(): void {
      void windows.showMain().catch(() => logOperational('native-main-show-failed'))
    },
    // Only where a check can answer: the tray is the one menu Windows has.
    ...(updatesSupported ? { checkForUpdates: requestUpdateCheck } : {}),
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
    showWidgetWhenIdle: () => showWidgetWhenIdle,
    presentation: () => widgetPresentation,
    log: logOperational,
  })
  handleRendererProcessGone = (kind) => dictationLifecycle.rendererProcessGone(kind)
  const publishWidgetState = async (state: WidgetSnapshot): Promise<void> => {
    await dictationLifecycle.publish(state)
  }
  const publishIdleWidgetState = async (current: AppSettings): Promise<void> => {
    await dictationLifecycle.publish({
      status: 'idle',
      ...widgetPresentationFor(current),
      shortcut: current.hotkey,
      cancellable: false,
    })
  }

  const permissionAdapter = createPermissionAdapter()
  const microphoneAccess =
    e2eConfiguration === null && profile.requiresMediaAccessGate
      ? createMicrophoneAccessGate({
          status: () => systemPreferences.getMediaAccessStatus('microphone'),
          request: () => systemPreferences.askForMediaAccess('microphone'),
        })
      : null
  return new NativeRuntimeController({
    windows,
    hotkeys,
    tray,
    startup,
    settings,
    publishIdleWidgetState,
    installPermissions: () =>
      installSessionPermissionPolicy(
        permissionAdapter,
        () =>
          windows
            .getTrustedRenderers()
            .filter((renderer) => renderer.role === 'main'),
        // Omitted where no OS microphone gate exists, which keeps the grant
        // synchronous exactly as it is today.
        microphoneAccess === null ? undefined : () => microphoneAccess.ensure(),
        microphoneAccess === null ? undefined : () => microphoneAccess.isGranted(),
      ),
    installProtocols: runtimeSource === null
      ? () => () => undefined
      : () => registerLocalAssetProtocols({
          protocol,
          net,
          modelSources: () => naturalSpeechModels.protocolSources(),
          runtimeSource,
        }),
    registerIpc: () => {
      const cleanupPersonalChats = registerPersonalChatIpc(ipcMain, personalChats, () => windows.getTrustedRenderers())
      const cleanupChatPrompts = registerChatPromptIpc(ipcMain, chatPrompts, () => windows.getTrustedRenderers(), copyOutput)
      const cleanupRequestDrafts = registerRequestDraftIpc(ipcMain, requestDrafts, () => windows.getTrustedRenderers())
      const files = new FilesService({
        resolveBinding: threadId => agentControl.filesBinding(threadId),
        copyPath: copyOutput,
        reveal: path => shell.showItemInFolder(path),
      })
      const cleanupFiles = registerFilesIpc(ipcMain, files, () => windows.getTrustedRenderers())
      const cleanupSubagents = registerSubagentIpc(ipcMain, agentHost, () => windows.getTrustedRenderers(), change => windows.sendToMain(SUBAGENTS_CHANGED, change))
      const checkpointIntegration = connectCheckpoints({ historyEnabled: () => agentHistoryEnabled, files, directory: userDataPath, host: agentHost, control: agentControl, registry: threadRegistry,
        report: () => { logOperational('checkpoint-unavailable') } })
      agentHost.setMutationGuard(checkpointIntegration.canMutate)
      const gitChanges = new GitChangesService({ files, checkpoints: checkpointIntegration.checkpoints, canMutate: checkpointIntegration.canMutate,
        acted: threadId => { void agentHost.gitActionFinished(threadId).catch(() => undefined) },
        copyPath: copyOutput, reveal: path => shell.showItemInFolder(path), emit: event => { windows.sendToMain(GIT_CHANGES_EVENT, event) } })
      const cleanupTerminals = registerTerminalWorkspaceIpc(ipcMain, new TerminalWorkspaceService({
        projects: () => agentControl.projects(), git: runWorktreeGit,
        worktrees: new ThreadWorktrees(userDataPath, runWorktreeGit, TERMINAL_WORKTREE_HOME),
        emit: event => { windows.sendToMain(TERMINALS_EVENT, event) },
      }), () => windows.getTrustedRenderers())
      browserService = new BrowserService({ files,
        getWindow: () => BrowserWindow.getAllWindows().find(window => window.webContents === windows.getMainWebContents()) ?? null,
        emit: event => { windows.sendToMain(BROWSER_EVENT, event) },
        destination: async () => (await settingsCoordinator.getSettings()).webLinkDestination,
        openExternal: url => shell.openExternal(url),
        byDefault: () => workingCopySettings.browserWithoutAsking,
      })
      cloudIphoneService = new CloudIphoneService({
        files, credentials,
        settings: () => ({ monthlyMinutes: workingCopySettings.cloudIphoneMonthlyMinutes, idleMinutes: workingCopySettings.cloudIphoneIdleMinutes }),
        ledger: cloudIphoneLedger,
        threadTitle: threadId => agentControl.get().host.threads.find(thread => thread.id === threadId)?.title ?? threadId,
        getWindow: () => BrowserWindow.getAllWindows().find(window => window.webContents === windows.getMainWebContents()) ?? null,
        emit: event => { windows.sendToMain(CLOUD_IPHONE_EVENT, event) },
        provider: key => new RunCloudClient(key),
      })
      const cleanupCloudIphone = registerCloudIphoneIpc(ipcMain, cloudIphoneService, () => windows.getTrustedRenderers())
      // Quit waits for this (ADR-0047: run.cloud is never left billing), the same way it waits for other async shutdown.
      quitHandles.cloudIphone = { close: () => cloudIphoneService?.dispose() ?? Promise.resolve() }
      // Resumes any release or deletion a previous run could not finish, using the key already in the credential store.
      void cloudIphoneService.resumeCleanup()
      const terminalService = new TerminalService({ files, directory: userDataPath, emit: event => { windows.sendToMain(TERMINAL_EVENT, event) } })
      // A folder with a shell still running in it is not reclaimed under that shell.
      if (worktreeCleanup) {
        agentHost.setWorktreeInUse(threadId => terminalService.hasRunningTerminal(threadId))
        worktreeCleanup.start()
      }
      const cleanupTools = registerToolsIpc(ipcMain, {
        terminal: terminalService,
        browser: browserService,
        gitChanges,
      }, () => windows.getTrustedRenderers())
      // Theme export and Open VSX (ADR-0011). End-to-end runs use an offline Open VSX and a fixed export folder.
      const cleanupThemes = registerThemesIpc(ipcMain, {
        openVsx: new OpenVsxClient(e2eConfiguration === null ? undefined : createOpenVsxFixtureFetch()),
        chooseExportPath: async defaultName => {
          if (e2eConfiguration !== null) return join(userDataPath, defaultName)
          const parent = BrowserWindow.getAllWindows().find(window => window.webContents === windows.getMainWebContents())
          const options = { defaultPath: defaultName, filters: [{ name: 'Theme', extensions: ['json'] }] }
          const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
          return result.canceled || !result.filePath ? null : result.filePath
        },
      }, () => windows.getTrustedRenderers())
      const cleanupMemory = registerMemoryIpc(ipcMain, memoryProfile, () => windows.getTrustedRenderers(), snapshot => windows.sendToMain(MEMORY_CHANGED, snapshot))
      // An end-to-end run reads a stand-in SSH folder and a recorded Tailscale status inside its own profile,
      // never the machine's ~/.ssh or Tailscale, and opens no browser.
      const hostTailscale = new HostTailscale({
        ...(e2eConfiguration ? { invoke: tailscaleInvoker(e2eHostsTailscale(userDataPath), ['tailscale']) } : {}),
        suggestions: () => discoverSshHosts(e2eConfiguration ? { home: join(userDataPath, 'e2e-home') } : {}),
        openExternal: async url => { if (e2eConfiguration === null) await shell.openExternal(url) },
      })
      const cleanupHosts = registerHostsIpc(ipcMain, desktopHosts, () => windows.getTrustedRenderers(), state => windows.sendToMain(HOSTS_CHANGED, state), hostTailscale)
      const cleanupPhones = registerPhonesIpc(ipcMain, phoneAccess, () => windows.getTrustedRenderers(), state => windows.sendToMain(PHONES_CHANGED, state))
      const cleanupAgents = registerAgentIpc(ipcMain, hostRouter, hostRouter, () => windows.getTrustedRenderers(), platform, e2eConfiguration === null ? naturalSpeechModels : {
        status: async () => ({ ready: true, completedBytes: 1, totalBytes: 1 }),
        download: async () => ({ ready: true, completedBytes: 1, totalBytes: 1 }),
      }, grokSpeech, kokoroSpeech, { voiceCoordinatorEnabled: startupSettings.voiceCoordinatorEnabled, wakeControl: agentControl, encodeReceipt: agentStateBroadcaster.encodeReceipt, workingCopyOptions: projectId => { const key = parseHostEntityKey(projectId); if (key && key.hostId !== agentControl.get().hostId) throw new Error('Working-copy choices are on the host machine. Use the existing project folder or create its worktree there.'); return agentHost.workingCopyOptions(key?.id ?? projectId) } })
      const cleanup = registerIpc(ipcMain, {
        settings: {
          get: () => settingsCoordinator.getSettings(),
          update: (patch) => { requireLocalHistoryCleanup(startupSettings.localHostEnabled, agentHistoryEnabled, patch.historyEnabled); return settingsCoordinator.updateSettings(patch) },
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
          reload: () => windows.reloadMain(),
          toggleMaximize: () => windows.toggleMaximizeMain(),
          isMaximized: () => windows.isMainMaximized(),
          quit: () => app.quit(),
        },
        trustedSenders: () => windows.getTrustedRenderers(),
        openExternalLink: url => shell.openExternal(url),
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
        transcriptPolish: {
          polish: (text, asr) => transcriptPolish.polish(text, asr),
        },
        transcription: {
          transcribe: (request) => transcription.transcribe(request),
          cancel: (requestId) => transcription.cancel(requestId),
          checkKey: () => transcription.checkKey(),
        },
        updates: {
          status: () => updates.status(),
          check: () => updates.check('manual'),
          download: () => updates.download(),
          install: () => updates.install(),
        },
        widget: {
          setPresentation: (presentation) => windows.setWidgetPresentation(presentation),
          reportDrag: (payload) => windows.reportWidgetDrag(payload),
        },
        recoveryNotices: {
          list: () => recoveryNotices.list(),
        },
        ...(microphoneAccess === null ? {} : { microphoneAccess }),
      })
      const unsubscribeRecoveryNotices = recoveryNotices.subscribe((notice) => {
        void messageDelivery.sendToMain(RECOVERY_NOTICE, notice).then((delivered) => {
          if (!delivered) logOperational('native-main-send-failed')
        })
      })
      // Started here rather than at construction so the first status can reach
      // a renderer that is already able to receive it.
      updates.start()
      const cleanupNativeIpc = (): void => {
        cleanupAgents()
        cleanupHosts()
        cleanupPhones()
        cleanupPersonalChats()
        cleanupChatPrompts()
        checkpointIntegration.dispose()
        cleanupRequestDrafts()
        cleanupFiles()
        cleanupSubagents()
        cleanupTerminals()
        worktreeCleanup?.dispose()
        cleanupTools()
        browserService = undefined
        // The quit drain already awaited this service's own dispose (ADR-0047); this just drops its IPC handlers.
        void cleanupCloudIphone()
        cloudIphoneService = undefined
        void browserAgentServer.close()
        cleanupThemes()
        cleanupMemory()
        unsubscribeRecoveryNotices()
        // No renderer is left to receive them, so abandon in-flight uploads.
        transcription.dispose()
        updates.dispose()
        cleanup()
      }
      if (e2eState === null) return cleanupNativeIpc
      ipcMain.handle(E2E_BROWSER_AGENT_CHANNEL, (event, payload: unknown) => {
        if (!isAuthorizedIpcSender(event, windows.getTrustedRenderers(), ['main'])) throw new Error('E2E_SENDER_REJECTED')
        const request = e2eBrowserAgentSchema.parse(payload)
        return browserAgentServer.call(request.threadId, request.name, request.arguments)
      })
      ipcMain.handle(E2E_HOST_SETUP_TOOL_CHANNEL, (event, payload: unknown) => {
        if (!isAuthorizedIpcSender(event, windows.getTrustedRenderers(), ['main'])) throw new Error('E2E_SENDER_REJECTED')
        const request = e2eHostSetupToolSchema.parse(payload)
        return hostSetupTools.call(hostSetup.threadId() ?? providerJobs.threadId() ?? '', request.name, {})
      })
      ipcMain.handle(AGENT_E2E, (event, payload: unknown) => {
        if (!isTrustedMainE2ESender(event.sender, windows.getTrustedRenderers())) throw new Error('E2E_SENDER_REJECTED')
        const parsed = e2eAgentEventSchema.parse(payload)
        if (parsed.scope === 'personal') {
          const chat = personalChats.get().chats.find(chat => chat.id === parsed.threadId)
          if (!chat || !testPersonalChatHosts) throw new Error('E2E_PERSONAL_CHAT_UNAVAILABLE')
          return testPersonalChatHosts[chat.providerId].event(parsed)
        }
        testAgentHost?.event(parsed)
      })
      ipcMain.handle(E2E_SNAPSHOT_CHANNEL, (event) => {
        if (!isTrustedMainE2ESender(event.sender, windows.getTrustedRenderers())) {
          throw new Error('E2E_SENDER_REJECTED')
        }
        return { ...snapshotE2EState(
          e2eState,
          BrowserWindow.getAllWindows().some((candidate) => candidate.getTitle() === APP_NAME && candidate.isVisible()),
        ), openedThreadFolder, openedExternalLink }
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
        ipcMain.removeHandler(E2E_BROWSER_AGENT_CHANNEL)
        ipcMain.removeHandler(E2E_HOST_SETUP_TOOL_CHANNEL)
        ipcMain.removeHandler(AGENT_E2E)
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
// Hidden browser captures need a native surface on Windows (ADR-0020).
// Preserve any caller-supplied feature switches; background throttling remains per-view.
if (process.platform === 'win32') {
  const disabled = new Set(app.commandLine.getSwitchValue('disable-features').split(',').filter(Boolean))
  disabled.add('CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('disable-features', [...disabled].join(','))
}

app.setAppUserModelId(APP_ID)
// Sotto lives in the tray/menu bar, so losing every window must not quit it —
// Electron's unhandled default does exactly that.
app.on('window-all-closed', () => undefined)

void bootstrapSotto({ app, initialize: createRuntime, log: logOperational,
  ...(e2eConfiguration === null ? { prepareUserData: () => migrateLegacyUserData(app.getPath('userData')) } : {}),
}).catch(() => {
  logOperational('bootstrap-terminal-failed')
  app.quit()
})
