import { cleanSettingsHistory } from './settings/privacyCleanup'
import { RetiredChatHistory } from './settings/retiredChats'
import { registerHostQuitDrain, type HostQuitHandles } from './app/hostQuitDrain'
import { HOSTS_CHANGED } from '../shared/hosts'
import { parseHostEntityKey } from '../shared/clientIdentity'
import { DesktopHostRouter } from './hosts/desktopHostRouter'
import { questionPageDestination } from './hosts/questionPageDestination'
import { DesktopHosts } from './hosts/desktopHosts'
import { HostSetup, hostSetupRequests } from './hosts/hostSetup'
import { agentJobTools, HostSetupToolServer } from './hosts/hostSetupTools'
import { VISUALIZE_TOOL, VisualToolServer } from './agents/visualTools'
import { PullRequestToolServer } from './agents/pullRequestTools'
import { DelegationToolServer } from './agents/delegationTools'
import { registerDelegationIpc } from './agents/delegationIpc'
import { registerContinueIpc } from './agents/continueThreadIpc'
import { desktopWindowClient } from './agents/hostService'
import { DELEGATION_RENDERER_ARGUMENT } from '../shared/delegation'
import { CONTINUE_RENDERER_ARGUMENT } from '../shared/continueThread'
import type { QuestionPageOpenResult } from '../shared/questionPageOpen'
import { installVisualSandbox, type VisualContentsLike } from './agents/visualSandbox'
import { startDeadProxy, VISUAL_SCHEME_PRIVILEGES } from './agents/visualSeal'
import { FIGTREE_FONT_FACES } from '../shared/figtreeFonts'
import { VISUAL_PARTITION } from '../shared/visualPages'
import { HostProviderJobs } from './hosts/hostProviderJob'
import { HostUpdates } from './hosts/hostUpdate'
import { routerBusyThreads } from './hosts/busyHost'
import { HostBootChanges } from './hosts/hostBootStart'
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
import { e2eTailnetMap } from './e2e/tailnetStandIn'
import { SshHostLauncher } from './hosts/sshLauncher'
import { HostPhones } from './hosts/hostPhones'
import { PHONES_CHANGED } from '../shared/phones'
import { discoverSshHosts } from './hosts/sshSuggestions'
import { detectInstalledProviders } from './agents/installedProviders'
import { DevinAcpHost } from './agents/devin'
import { MuseMspHost } from './agents/muse'
import { OpenCodeHost } from './agents/opencode'
import { connectCheckpoints } from './tools/checkpointIntegration'
import { RequestDraftService } from './agents/requestDrafts'
import { RetainedDraftStore } from './agents/retainedDraftStore'
import { registerRequestDraftIpc } from './agents/requestDraftIpc'
import { requestDraftOwnerState, requestDraftWatcherOwnerIds } from './agents/requestDraftOwners'
import { REQUEST_DRAFT_CHANGED } from '../shared/requestDrafts'
import { version as appVersion } from '../../package.json'
import {
  app,
  autoUpdater as nativeAutoUpdater,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  protocol,
  screen,
  session,
  safeStorage,
  shell,
  systemPreferences,
  Tray,
  type Event as ElectronEvent,
  type MenuItemConstructorOptions,
  type WebContents,
  type WebContentsWillFrameNavigateEventParams,
  type WebContentsWillNavigateEventParams,
  type WebContentsWillRedirectEventParams,
} from 'electron'
import { spawn } from 'node:child_process'
import { appendFile, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
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
import { createDictationShortcutRouter, type DictationShortcutEvent } from './hotkeys/dictationShortcutRouter'
import { holdCanStart } from './hotkeys/chordMatcher'
import { createKeyListener } from './hotkeys/keyListener'
import { createDictationShortcutLifecycle, interruptOnLockAndSleep } from './hotkeys/dictationShortcutLifecycle'
import { spawnKeyListenerHelper } from './hotkeys/keyListenerHelpers'
import { parseDictationEdge } from './hotkeys/dictationCommand'
import { LinuxDictationShell } from './hotkeys/linuxDictationShell'
import { ShellWidgetMonitor } from './windows/shellWidgetMonitor'
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
import { createHyprlandPasteAdapter, sanitizeLinuxPasteText } from './output/pasteCommand.linux'
import { createWaylandClipboard } from './output/waylandClipboard'
import { createWarmPasteAdapter } from './output/pasteHelper'
import { createHyprlandFocusedApp, createLsappinfoFocusedApp } from './output/focusedApp'
import { createOsascriptPasteAdapter, type OsascriptPasteEvent } from './output/pasteOsascript'
import { createSystemSettingsOpener } from './app/systemSettings'
import { TranscriptPolishService } from './llm/transcriptPolishService'
import { LocalTranscriptionService } from './asr/localTranscriptionService'
import { loadParakeetEngine } from './asr/speechEngine'
import { SpeechModelStore } from './asr/speechModelStore'
import { SpeechModelManager } from './asr/speechModelManager'
import { createDictationGate } from './hotkeys/dictationGate'
import { coreMlHelperAvailable, createCoreMlEngineLoader } from './asr/coreMlEngine'
import { findFluidAudioModels, fluidAudioModelsRoot } from './asr/fluidAudioModels'
import { checkOpenRouterKey } from './llm/openRouterKeyCheck'
import { listOpenRouterModels } from './llm/openRouterModels'
import { PARAKEET_V3, SOTTO_SPEECH_MODELS, sottoSpeechModel, sottoSpeechModelOption, type SpeechModelOption, type SpeechModelStatus } from '../shared/speechModel'
import { createElectronUpdaterAdapter } from './updates/electronUpdaterAdapter'
import { newVersionListener, UpdateService, waitingVersion } from './updates/updateService'
import { e2eUpdater } from './updates/e2eUpdater'
import { platformProfile, updatesInApp, type WidgetAlwaysOnTopLevel } from './platformProfile'
import { RecoveryNoticeCenter } from './storage/recoveryNoticeCenter'
import { createStorageRepositories } from './storage/repositories'
import type { HistoryLogEvent } from './storage/historyRepository'
import { migrateLegacyUserData } from './storage/migrateLegacyUserData'
import {
  WidgetPlacementRepository,
  type StoredWidgetPlacement,
} from './storage/widgetPlacementRepository'
import { NativeSettingsCoordinator } from './settings/nativeSettingsCoordinator'
import { StartupService } from './startup/startupService'
import { linuxAutostart, type LinuxAutostartEvent } from './startup/linuxAutostart'
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
import { menuBarOwlWanted, startMenuBarOwl, type MenuBarOwl } from './tray/menuBarOwl'
import { electronOwlEnvironment } from './tray/menuBarOwlElectron'
import {
  parseDevelopmentRendererSources,
  WindowManager,
  type BrowserWindowLike,
  type NavigationEventName,
  type Rectangle,
  type RendererDiagnostic,
  type WebContentsLike,
  type WindowEventName,
} from './windows/windowManager'
import {
  DICTATION_COMMAND,
  DICTATION_KEYS_HELD,
  DICTATION_KEYS_TAKEN,
  KEY_LISTENER_PERMISSION_CHANGED,
  RECOVERY_NOTICE,
  SETTINGS_CHANGED,
  UPDATE_CHECK_REQUESTED,
  UPDATE_STATUS,
  SPEECH_MODEL_STATUS,
} from '../shared/channels'
import { APP_ID, APP_NAME } from '../shared/constants'
import { getReleaseTrack, releaseTrackName } from '../shared/releaseTrack'
import { hostReleaseVersion, updateHostReleaseVersion } from './hosts/hostReleaseVersion'
import { WATCHER_CHANGED, WATCHER_MACHINES_RENDERER_ARGUMENT, WATCHER_RENDERER_ARGUMENT } from '../shared/watcherRoom'
import { runningVersion, owlFeaturesForRun } from './runningVersion'
import { heldProvidersOf, releasesHeldProvider } from '../shared/heldProviders'
import type { DictationCommand } from '../shared/contracts'
import type { WidgetSnapshot } from '../shared/dictation'
import { widgetPresentationFor } from '../shared/themeBranding'
import { dockPainter, readDockCoverage } from './dock/dockIcon'
import { resolvePlatform } from '../shared/platform'
import { configurePasswordStore } from './app/passwordStore'
import linuxTrayIconPath from '../../build/icon.png?asset'
import { defaultSettings, dictationOn, type AppSettings } from '../shared/settings'
import { blockSpellcheckDictionaryDownloads, disableDnsPrefetching, enableWasmThreadSupport } from './security'
import {
  createE2EClipboard,
  createE2EGlobalShortcuts,
  createE2ENativeState,
  createE2EPasteProcess,
  resolveE2EConfiguration,
  isTrustedMainE2ESender,
  snapshotE2EState,
} from './e2e/e2eBoundary'
import { E2E_SNAPSHOT_CHANNEL, E2E_TRIGGER_SHORTCUT_CHANNEL, E2E_BROWSER_AGENT_CHANNEL, E2E_HOST_SETUP_TOOL_CHANNEL, E2E_VISUAL_TOOL_CHANNEL, E2E_DELEGATION_TOOL_CHANNEL, e2eBrowserAgentSchema, e2eHostSetupToolSchema, e2eVisualToolSchema, e2eDelegationToolSchema, e2eAgentEventSchema } from '../shared/e2e'
import { AGENT_STATE, AGENT_E2E, AGENT_THREAD_DETAIL } from '../shared/agents'
import { AgentCredentials } from './agents/credentials'
import { migrateDesktopKey } from './settings/migrateDesktopKey'
import { SecureSettings } from './agents/secureSettings'
import { registerSubagentIpc } from './agents/subagentIpc'
import { registerUsageIpc } from './agents/usageIpc'
import { MainActivityService, type MainActivityLogEvent } from './performance/mainActivityService'
import { registerMainActivityIpc } from './performance/mainActivityIpc'
import { fakeNotification } from './e2e/fakeNotification'
import { createDesktopNotifier } from './notifications/desktopNotifier'
import { registerNotificationIpc } from './notifications/notificationIpc'
import { ThreadAlerts } from './notifications/threadAlerts'
import { mainProcessProfiler, windowProfiler } from './performance/profilers'
import { MAIN_ACTIVITY_CHANGED, MAIN_ACTIVITY_RENDERER_ARGUMENT } from '../shared/mainActivity'
import { DESKTOP_NOTIFICATIONS_RENDERER_ARGUMENT, NOTIFICATION_OPENED } from '../shared/desktopNotifications'
import { INTERFACE_LANGUAGE_CHANGED, interfaceLanguageArgument } from '../shared/interfaceLanguageBridge'
import { MainInterfaceLanguage, preferredSystemLanguages } from './interfaceLanguage'
import { USAGE_RENDERER_ARGUMENT } from '../shared/usageDashboard'
import { OPENCODE_HOSTS_RENDERER_ARGUMENT, OPENCODE_RENDERER_ARGUMENT } from '../shared/opencodeSignIn'
import { registerOpenCodeSignInIpc } from './agents/opencodeSignInIpc'
import { SUBAGENTS_CHANGED } from '../shared/subagents'
import { coalesceAgentStatePublishes, coalesceAgentThreadDetailPublishes } from './agents/control'
import { createWatcherRoomDesktop } from './agents/watcherRoomDesktop'
import { AgentStateBroadcaster } from './agents/agentStateBroadcast'
import { registerAgentIpc } from './agents/ipc'
import { createAgentRuntime } from './agents/runtime'
import { loadHostIdentity } from './agents/hostIdentity'
import { registerFilesIpc } from './files/ipc'
import { FilesService } from './files/service'
import { registerToolsIpc } from './tools/ipc'
import { registerThemesIpc } from './themes/ipc'
import { OmarchyThemeMonitor, initializeOmarchySelection } from './themes/omarchy'
import { OmarchySetup, findOmarchyResources } from './omarchy/setup'
import { registerOmarchySetupIpc } from './omarchy/ipc'
import { OMARCHY_SETUP_CHANGED, OMARCHY_SETUP_FOCUS } from '../shared/omarchySetup'
import { OpenVsxClient } from './themes/openVsx'
import { createOpenVsxFixtureFetch } from './themes/openVsxFixture'
import { TerminalService } from './tools/terminal'
import { terminalTakesMenuShortcut } from './terminals/menuShortcuts'
import { BrowserService } from './tools/browser'
import { createBrowserAgentServer } from './tools/browserAgentTools'
import { GitChangesService } from './tools/gitChanges'
import { CloudIphoneService } from './tools/cloudIphone/service'
import { CloudUsageLedger } from './tools/cloudIphone/usageLedger'
import { RunCloudClient } from './tools/cloudIphone/runCloudClient'
import { registerCloudIphoneIpc } from './tools/cloudIphoneIpc'
import { CLOUD_IPHONE_EVENT } from '../shared/cloudIphone'
import { TERMINAL_EVENT } from '../shared/terminal'
import { githubPullRequestMerged } from './agents/worktreeCleanup'
import type { GitHubRateLimitEvent } from './agents/github'
import type { BabysitEvent } from './agents/babysitting'
import { ClaudeStreamJsonHost, type ClaudeAdapterEvent } from './agents/claude'
import type { WatcherAutoSettleEvent } from './agents/watcher'
import { CodexAppServerHost, type CodexAdapterEvent } from './agents/codex'
import { BROWSER_EVENT } from '../shared/browser'
import { GIT_CHANGES_EVENT } from '../shared/gitChanges'
import { removeRetiredVoiceCache } from './agents/retiredVoiceCache'
import { E2EAgentHost, e2eAgentReasoner } from './e2e/agentEffects'
import { isImmutableActivities } from './agents/activitySnapshots'
import type { AgentActivity } from '../shared/agentActivity'
import { installRemoteHostE2E } from './e2e/remoteHost'
import { installBabysitPassE2E } from './e2e/babysitPass'
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
const platformDefaults = defaultSettings(profile.defaultHotkey, profile.defaultHoldShortcuts)

type NativeDiagnostic =
  | 'omarchy-theme-missing'
  | 'omarchy-theme-invalid'
  | 'omarchy-theme-watch-failed'
  | 'omarchy-theme-refresh-failed'
  | 'shell-pill-refresh-failed'
  | MainActivityLogEvent
  | LinuxAutostartEvent
  | BootstrapDiagnostic
  | NativeRuntimeDiagnostic
  | RendererDiagnostic
  | 'bootstrap-terminal-failed'
  | 'native-main-send-failed'
  | 'native-widget-state-delivery-failed'
  | 'native-widget-show-failed'
  | 'native-dictation-state-write-failed'
  | 'native-dictation-pid-start-unavailable'
  | 'settings-update-failed'
  | 'secure-key-migration-unavailable'
  | 'memory-store-open-failed'
  | HistoryLogEvent
  | 'delivered-app-unreadable'
  | 'checkpoint-unavailable'
  | 'worktree-cleanup-reclaimed'
  | 'worktree-cleanup-skipped'
  | 'thread-auto-settled'
  | 'thread-auto-settle-skipped'
  | WatcherAutoSettleEvent
  | GitHubRateLimitEvent
  | BabysitEvent
  | ClaudeAdapterEvent
  | CodexAdapterEvent
  | PhoneAccessEvent
  | 'host-phones-read-failed'
  | 'host-phones-command-failed'
  | OsascriptPasteEvent
  | DictationShortcutEvent
  | 'dock-icon-unavailable'
  | 'dock-icon-failed'
  | 'owl-frames-unavailable'
  | 'owl-failed'
  | 'desktop-notification-failed'
  | 'interface-language-load-failed'

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
  /** Held apart from `window`: once a window closes, its `webContents` getter throws, and the listeners still have to come off. */
  private readonly contents: WebContents

  constructor(private readonly window: BrowserWindow) {
    this.contents = window.webContents
    this.webContents = this.contents
  }

  on(
    event: WindowEventName,
    listener: (event: { preventDefault(): void }) => void,
  ): void {
    if (event === 'close') {
      const wrapped = (nativeEvent: { preventDefault(): void }): void => listener(nativeEvent)
      this.window.on('close', wrapped)
      this.windowListenerCleanups.set(listener, () => this.window.removeListener('close', wrapped))
      return
    }
    if (event === 'page-title-updated') {
      const wrapped = (nativeEvent: { preventDefault(): void }): void => listener(nativeEvent)
      this.window.on('page-title-updated', wrapped)
      this.windowListenerCleanups.set(listener, () => this.window.removeListener('page-title-updated', wrapped))
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
    _event: WindowEventName,
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

  onNavigation(
    event: NavigationEventName,
    listener: (event: { preventDefault(): void }, details: { readonly url: string }) => void,
  ): void {
    let cleanup: () => void
    if (event === 'will-navigate') {
      const wrapped = (details: ElectronEvent<WebContentsWillNavigateEventParams>): void =>
        listener(details, { url: details.url })
      this.contents.on('will-navigate', wrapped)
      cleanup = () => this.contents.removeListener('will-navigate', wrapped)
    } else if (event === 'will-frame-navigate') {
      const wrapped = (details: ElectronEvent<WebContentsWillFrameNavigateEventParams>): void =>
        listener(details, { url: details.url })
      this.contents.on('will-frame-navigate', wrapped)
      cleanup = () => this.contents.removeListener('will-frame-navigate', wrapped)
    } else {
      const wrapped = (details: ElectronEvent<WebContentsWillRedirectEventParams>): void =>
        listener(details, { url: details.url })
      this.contents.on('will-redirect', wrapped)
      cleanup = () => this.contents.removeListener('will-redirect', wrapped)
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
    this.contents.on('render-process-gone', wrapped)
    this.rendererProcessGoneCleanups.set(listener, () => {
      this.contents.removeListener('render-process-gone', wrapped)
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

  isFullScreen(): boolean {
    return this.window.isFullScreen()
  }

  isVisible(): boolean {
    return this.window.isVisible()
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
    options?: {
      readonly visibleOnFullScreen?: boolean
      readonly skipTransformProcessType?: boolean
    },
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

/**
 * Main's watch on itself (#1233). Development runs of the e2e suite may shorten the window and the recording; a packaged
 * build reads neither override.
 */
function createMainActivity(userDataPath: string, version: string): MainActivityService {
  const testing = e2eConfiguration !== null && !app.isPackaged
  const override = (name: string, max: number): number | undefined => {
    const value = testing ? Number(process.env[name]) : Number.NaN
    return Number.isInteger(value) && value > 0 && value <= max ? value : undefined
  }
  const windowSeconds = override('SOTTO_E2E_MAIN_LOOP_WINDOW_SECONDS', 600)
  const durationMs = override('SOTTO_E2E_ACTIVITY_RECORDING_MS', 600_000)
  const devOrigin = app.isPackaged ? undefined : parseOrigin(process.env.ELECTRON_RENDERER_URL)
  return new MainActivityService({
    directory: join(userDataPath, 'performance-recordings'),
    clock: { now: () => performance.now(), setInterval: (callback, ms) => setInterval(callback, ms), clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>) },
    ...(windowSeconds ? { windowSeconds } : {}), ...(durationMs ? { durationMs } : {}),
    mainProfiler: mainProcessProfiler,
    appRoots: [app.getAppPath(), ...(app.isPackaged ? [] : [process.cwd()])],
    ...(devOrigin ? { devOrigins: [devOrigin] } : {}),
    sottoVersion: version, platform: process.platform,
    revealFile: path => shell.showItemInFolder(path),
    log: logOperational,
  })
}

function parseOrigin(url: string | undefined): string | undefined {
  try { return url ? new URL(url).origin : undefined } catch { return undefined }
}

async function createRuntime(): Promise<NativeRuntimeController> {
  blockSpellcheckDictionaryDownloads(session.defaultSession)
  const resourceRoot = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources')
  // Dock and Finder launch with the system PATH. Provider CLIs live in the user's login PATH.
  await installGuiPath()
  const userDataPath = app.getPath('userData')
  const memoryStore = openRuntimeMemory(join(userDataPath, 'memory.sqlite'), logOperational)
  const memoryProfile = memoryStore === undefined ? undefined : new MemoryProfile(memoryStore)
  const authority = memoryStore === undefined ? undefined : new PolicyStore(memoryStore)
  app.on('will-quit', () => memoryStore?.close())
  await removeRetiredVoiceCache(userDataPath)
  // Packaged builds get the brand icon stamped onto the executable by
  // electron-builder; an unpackaged run has to name the repository icon itself.
  const unpackagedIconPath = app.isPackaged
    ? null
    : join(__dirname, platform === 'linux' ? '../../build/icon.png' : '../../build/icon.ico')
  // Packaging can override the version without editing the source manifest, so it is read from the app (ADR-0072).
  const appRunningVersion = runningVersion(app.getVersion(), process.versions.electron, appVersion)
  const owlFeatures = owlFeaturesForRun({ version: appRunningVersion, isPackaged: app.isPackaged,
    overrides: process.env.SOTTO_OWL_FEATURES, watcherOverride: process.env.SOTTO_WATCHER_ENABLED })
  // Existing Watcher options wrap the Owl feature list for branches in flight.
  const watcherEnabled = owlFeatures.watcher
  // The providers an Owl feature holds off this run (ADR-0072): every boundary asks this set, not a provider's own answer.
  const heldProviders = heldProvidersOf(owlFeatures)
  const usageEnabled = owlFeatures.usage
const cleanupModelEnabled = owlFeatures['cleanup-model']
  const delegationEnabled = owlFeatures['thread-delegation']
  const workerRolesEnabled = owlFeatures['worker-roles']
  const threadStartsEnabled = owlFeatures['continue-agent-thread']
  // The iPhone's Agents view (ADR-0103): offered to a paired iPhone only when the Owl list turns it on.
  const agentsViewEnabled = owlFeatures['iphone-agents-view']
  const continueEnabled = owlFeatures['continue-on-provider']
  // Work across machines (ADR-0082): where new workers start, a start's machine or system, the machines a delegating thread
  // may list (#1032), and this computer's live load and work placed but not started (#1311). Stable reads no setting for
  // it, samples nothing, offers none of it and asks no host for its projects' origins.
  const crossMachineEnabled = owlFeatures['cross-machine-work']
  // Main watches its own event loop and can record a minute of itself (#1233, ADR-0098): an Owl feature, so stable
  // builds no service, starts no monitor and registers no bridge.
  const mainActivity = owlFeatures['main-freeze'] ? createMainActivity(userDataPath, appRunningVersion) : null
  mainActivity?.start()
  app.on('will-quit', () => mainActivity?.dispose())
  // Notifications when a thread has finished everything or needs the user (ADR-0117): an Owl feature, on a Mac that can
  // show them. Anywhere else main builds nothing, passes no renderer argument and registers no channel.
  const desktopNotificationsEnabled = owlFeatures['desktop-notifications'] && profile.desktopNotifications && Notification.isSupported()
  const hostVersion = hostReleaseVersion(appRunningVersion, appVersion, usageEnabled || releasesHeldProvider(heldProviders))
  // With Update all on, the host version the update this computer is downloading brings, which a host may run before
  // Sotto restarts (ADR-0077 decision 6). It stays undefined while Update all is held, when hosts follow the running version alone.
  let waitingAppVersion: string | undefined
  let waitingHostVersion: string | undefined
  let waitingPhase: string | undefined
  let repaintOmarchy: () => void = () => undefined
  const omarchyTheme = new OmarchyThemeMonitor(platform, homedir(),
    () => repaintOmarchy(), logOperational)
  omarchyTheme.load()
  app.on('will-quit', () => omarchyTheme.dispose())
  // Whether Omarchy's shell pill has taken the floating widget's place; Settings reads it to explain the idle widget row.
  let shellPillInUse = false
  const recoveryNotices = new RecoveryNoticeCenter()
  const { settings: plainSettings, history } = createStorageRepositories(
    userDataPath,
    recoveryNotices,
    Date.now,
    platformDefaults,
    logOperational,
    { workerRolesEnabled, dictationHoldShortcutsEnabled: owlFeatures['dictation-hold-shortcuts'], interfaceLanguageEnabled: owlFeatures['interface-language'], ...(platform === 'linux' ? { omarchyTheme: () => omarchyTheme.get(), shellPillInUse: () => shellPillInUse } : {}) },
  )
  await initializeOmarchySelection(platform, omarchyTheme.get(), plainSettings)
  await history.initialize()
  const credentials = new AgentCredentials(userDataPath, safeStorage, notice => recoveryNotices.publish(notice))
  await credentials.load()
  const cloudIphoneLedger = new CloudUsageLedger(userDataPath)
  await cloudIphoneLedger.load()
  const settings = new SecureSettings(plainSettings, credentials, () => recoveryNotices.publish({ code: 'OPENROUTER_KEY_UNREADABLE' }))
  await migrateDesktopKey(settings, recoveryNotices, logOperational)
  await plainSettings.save(await plainSettings.get()).catch(() => console.warn('retired-voice-settings-save-failed'))
  await plainSettings.migrateProjectWorkingCopyDefaults(await loadHostIdentity(userDataPath))
  const startupSettings = await settings.get()
  // The interface language (ADR-0123), read before the tray, the menu or a window shows a word. An end-to-end run reads
  // English as the computer's language, so every test and design capture reads English on any machine; the setting still
  // applies there, and SOTTO_E2E_SYSTEM_LANGUAGES stands in for the computer's list.
  const interfaceLanguageEnabled = owlFeatures['interface-language']
  const interfaceLanguage = new MainInterfaceLanguage({
    enabled: interfaceLanguageEnabled,
    systemLanguages: e2eConfiguration === null ? preferredSystemLanguages(app) : (process.env.SOTTO_E2E_SYSTEM_LANGUAGES ?? 'en-US').split(','),
    override: app.isPackaged ? undefined : process.env.SOTTO_INTERFACE_LANGUAGE,
  })
  // A catalog that cannot be read leaves Sotto in English, which every window can show.
  const applyInterfaceLanguage = (current: AppSettings): Promise<boolean> =>
    interfaceLanguage.apply(current).catch(() => { logOperational('interface-language-load-failed'); return false })
  await applyInterfaceLanguage(startupSettings)
  const omarchyResources = platform === 'linux' ? await findOmarchyResources(e2eConfiguration ? userDataPath : process.resourcesPath, join(__dirname, '../..')) : null
  let agentHistoryEnabled = startupSettings.historyEnabled
  const retiredChatHistory = new RetiredChatHistory(userDataPath, () => agentHistoryEnabled)
  let workingCopySettings = startupSettings
  let e2eOpenAtLogin = false
  const startup = new StartupService(platform === 'linux' ? linuxAutostart({
    isPackaged: app.isPackaged, executable: process.execPath, configHome: process.env.XDG_CONFIG_HOME, log: logOperational,
  }) : e2eConfiguration !== null ? {
    getLoginItemSettings: () => ({ openAtLogin: e2eOpenAtLogin }),
    setLoginItemSettings: ({ openAtLogin }) => { e2eOpenAtLogin = openAtLogin },
  } : app)
  const widgetPlacementStore = new WidgetPlacementRepository(
    join(userDataPath, 'widget-placement.json'),
  )
  let widgetPlacement: StoredWidgetPlacement | null = await widgetPlacementStore.get()
  let linuxDictationShell: LinuxDictationShell | null = null
  let showWidgetWhenIdle = (await settings.get()).showWidgetWhenIdle
  // Main owns the widget's presentation: every snapshot is stamped with the
  // current theme halves, so a theme change repaints the widget mid-session.
  let widgetPresentation = widgetPresentationFor(await settings.get())
  // The Dock icon wears the saved theme's mark, as the main window's mark does, repainted when the theme or the
  // system's scheme changes. Without its coverage file the Dock keeps the bundle's icon, and a failed paint gives
  // the bundle's icon back rather than leaving an earlier theme's.
  const dockCoverage = platform === 'darwin' && app.dock !== undefined
    ? await readFile(join(resourceRoot, 'dock', 'mark-coverage.bin')).then(readDockCoverage, () => null)
    : null
  if (platform === 'darwin' && dockCoverage === null) logOperational('dock-icon-unavailable')
  let dockSettings = await settings.get()
  const paintDockFor = dockCoverage === null ? undefined : dockPainter(dockCoverage, {
    setIcon: png => {
      const image = nativeImage.createFromBuffer(png)
      if (image.isEmpty()) throw new Error('Unreadable Dock icon')
      app.dock?.setIcon(image)
    },
    // Electron hands macOS an empty image for null, which restores the bundle's icon; its types leave null out.
    restoreBundleIcon: () => app.dock?.setIcon(null as unknown as Electron.NativeImage),
    log: logOperational,
  })
  const paintDock = (): void => paintDockFor?.(dockSettings, nativeTheme.shouldUseDarkColors)
  paintDock()
  if (dockCoverage !== null) nativeTheme.on('updated', paintDock)
  let handleRendererProcessGone: (kind: 'main' | 'widget') => void = () => undefined
  const releaseTrack = getReleaseTrack(appRunningVersion)
  // What this build calls itself in words: the main window's title and the tray's tooltip, "Sotto Owl" on that track.
  const buildName = releaseTrackName(releaseTrack)
  // Windows updates itself on both tracks and a Mac on Owl only, the one signed with Sotto's Developer ID (ADR-0093).
  const inAppUpdates = updatesInApp(profile, releaseTrack)
  const terminalFocus = new WeakSet<Electron.WebContents>()
  const windows = new WindowManager({
    title: buildName,
    createWindow: options => {
      const mainRenderer = options.webPreferences?.additionalArguments?.includes('--sotto-renderer-role=main')
      const featureArguments = [...(interfaceLanguageEnabled ? [interfaceLanguageArgument(interfaceLanguage.current())] : []), ...(mainRenderer ? [...(watcherEnabled ? [WATCHER_RENDERER_ARGUMENT] : []), ...(usageEnabled ? [USAGE_RENDERER_ARGUMENT] : []),
        ...(delegationEnabled ? [DELEGATION_RENDERER_ARGUMENT] : []), ...(continueEnabled ? [CONTINUE_RENDERER_ARGUMENT] : []),
        ...(mainActivity ? [MAIN_ACTIVITY_RENDERER_ARGUMENT] : []),
        ...(desktopNotificationsEnabled ? [DESKTOP_NOTIFICATIONS_RENDERER_ARGUMENT] : []),
        ...(watcherEnabled && crossMachineEnabled ? [WATCHER_MACHINES_RENDERER_ARGUMENT] : []),
        ...(!heldProviders.has('opencode') && startupSettings.localHostEnabled ? [OPENCODE_RENDERER_ARGUMENT] : []),
        ...(!heldProviders.has('opencode') ? [OPENCODE_HOSTS_RENDERER_ARGUMENT] : [])] : [])]
      const window = new BrowserWindow(featureArguments.length
        ? { ...options, webPreferences: { ...options.webPreferences, additionalArguments: [...(options.webPreferences?.additionalArguments ?? []), ...featureArguments] } } : options)
      window.webContents.on('before-input-event', (_event, input) => {
        window.webContents.setIgnoreMenuShortcuts(terminalTakesMenuShortcut(input, terminalFocus.has(window.webContents), platform))
      })
      window.webContents.on('did-start-loading', () => terminalFocus.delete(window.webContents))
      return new ElectronBrowserWindowAdapter(window)
    },
    display: screen,
    platform: profile.platform,
    chrome: profile,
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
      linuxDictationShell?.place(placement.edge)
    },
  })
  // This explicit development-only path drives the real adapter through a scripted ACP child.
  const devinFixtureRoot = e2eConfiguration !== null && !app.isPackaged ? process.env['SOTTO_E2E_DEVIN_ROOT'] : undefined
  const devinFixtureExecutable = process.env['SOTTO_E2E_DEVIN_EXECUTABLE']
  if (devinFixtureRoot && (!isAbsolute(devinFixtureRoot) || !devinFixtureExecutable || !isAbsolute(devinFixtureExecutable))) {
    throw new Error('The Devin test fixture requires absolute paths.')
  }
  const museFixtureRoot = e2eConfiguration !== null && !app.isPackaged ? process.env['SOTTO_E2E_MUSE_ROOT'] : undefined
  const museFixtureExecutable = process.env['SOTTO_E2E_MUSE_EXECUTABLE']
  if (museFixtureRoot && (!isAbsolute(museFixtureRoot) || !museFixtureExecutable || !isAbsolute(museFixtureExecutable))) {
    throw new Error('The Muse test fixture requires absolute paths.')
  }
  // OpenCode's real adapter over the scripted server, the same way; its OpenCode folder is under the profile, as Sotto's is.
  const opencodeFixtureRoot = e2eConfiguration !== null && !app.isPackaged ? process.env['SOTTO_E2E_OPENCODE_ROOT'] : undefined
  const opencodeFixtureExecutable = process.env['SOTTO_E2E_OPENCODE_EXECUTABLE']
  if (opencodeFixtureRoot && (!isAbsolute(opencodeFixtureRoot) || !opencodeFixtureExecutable || !isAbsolute(opencodeFixtureExecutable))) {
    throw new Error('The OpenCode test fixture requires absolute paths.')
  }
  // The same for Claude and Codex: the real adapters over the fake CLIs, so a benchmark measures what they hold.
  const nativeFixtureRoot = e2eConfiguration !== null && !app.isPackaged && !devinFixtureRoot && !museFixtureRoot && !opencodeFixtureRoot ? process.env['SOTTO_E2E_NATIVE_FIXTURE_ROOT'] : undefined
  const nativeFixtureExecutable = process.env['SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE']
  if (nativeFixtureRoot && (!isAbsolute(nativeFixtureRoot) || !nativeFixtureExecutable || !isAbsolute(nativeFixtureExecutable))) {
    throw new Error('The native test fixture requires absolute paths.')
  }
  const testAgentHost = e2eConfiguration === null || devinFixtureRoot || museFixtureRoot || opencodeFixtureRoot || nativeFixtureRoot ? null : new E2EAgentHost(e2eConfiguration.scenario)
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
  const windowInFront = (): boolean => BrowserWindow.getAllWindows().some(window => window.getTitle() === buildName && window.isVisible() && !window.isMinimized()
    && (window.isFocused() || (windowBlurredAt !== 0 && Date.now() - windowBlurredAt < 45_000)))
  const localRuntime = startupSettings.localHostEnabled ? await createAgentRuntime({
    directory: userDataPath, credentials, watcherEnabled, heldProviders, usageEnabled, resumeAfterRestart: owlFeatures['resume-after-restart'], streamingPublishCost: owlFeatures['streaming-publish-cost'],
    delegationEnabled, workerRolesEnabled, continueEnabled, threadStartsEnabled, pullRequestViewEnabled: owlFeatures['iphone-pull-request-view'], agentsViewEnabled, crossMachineEnabled,
    ...(app.isPackaged ? { claudeHistoryModulePath: join(process.resourcesPath, 'claude-sdk', 'sdk.mjs') } : {}),
    settings: () => workingCopySettings, writingSettings: () => settings.get(),
    historyEnabled: () => agentHistoryEnabled,
    gitStatus: { fetchIntervalMs: () => workingCopySettings.gitFetchIntervalSeconds * 1000, foreground: windowInFront, ...(ghStandIn ? { ghStandIn } : {}), log: event => { logOperational(event) } },
    babysitting: { agentTool: () => workingCopySettings.babysitPullRequests },
    openExternal: url => shell.openExternal(url),
    openThreadFolder: async path => {
      if (e2eConfiguration !== null) { openedThreadFolder = path; return }
      const error = await shell.openPath(path); if (error) throw new Error(error)
    },
    ...(authority === undefined ? {} : { authority }),
    logFailure: (code, detail) => { console.error(`[Sotto] ${code} ${detail}`) },
    bindRequestDraftDecision: (target, decisionId, answers) => requestDrafts.bindDecision(target, decisionId, answers),
    ...(e2eConfiguration === null ? { installedProviders: () => detectInstalledProviders({ heldProviders }) } : {}),
    ...(testAgentHost === null ? {} : { host: testAgentHost }),
    ...(devinFixtureRoot ? { providers: {
      codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), opencode: new E2EAgentHost(),
      devin: new DevinAcpHost(userDataPath, {
        executable: devinFixtureExecutable!, args: [join(__dirname, '../../tests/fixtures/fakeDevinAgent.mjs'), devinFixtureRoot],
        nativeConfigDirectory: join(devinFixtureRoot, 'native-config'), pollIntervalMs: 50,
      }),
    } } : {}),
    ...(museFixtureRoot ? { providers: {
      codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost(), opencode: new E2EAgentHost(),
      ...(!heldProviders.has('muse') ? { muse: new MuseMspHost(userDataPath, {
        executable: museFixtureExecutable!, args: [join(__dirname, '../../tests/fixtures/fakeMuseAgent.mjs'), museFixtureRoot],
        // Read at connect, as the runtime's own Muse reads it, so a journey proves the switch reaches the host it starts.
        disableSandbox: (): boolean => localRuntime?.agentControl.configuration().museDisableSandbox === true,
      }) } : {}),
    } } : {}),
    ...(opencodeFixtureRoot ? { providers: {
      codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost(), muse: new E2EAgentHost(),
      ...(!heldProviders.has('opencode') ? { opencode: new OpenCodeHost(userDataPath, {
        executable: opencodeFixtureExecutable!, args: [join(__dirname, '../../tests/fixtures/fakeOpenCodeServer.mjs'), opencodeFixtureRoot], heldProviders,
        // A journey's sign-in page is written down for the spec to read, never opened in a browser.
        openExternal: url => appendFile(join(opencodeFixtureRoot, 'opened-pages.txt'), `${url}\n`, 'utf8'),
      }) } : {}),
    } } : {}),
    ...(nativeFixtureRoot ? { providers: {
      claude: new ClaudeStreamJsonHost({ userDataPath, executable: nativeFixtureExecutable!,
        args: [join(__dirname, '../../tests/fixtures/fakeClaudeThread.mjs'), join(nativeFixtureRoot, 'claude')], claudeHome: join(nativeFixtureRoot, 'claude', 'home') }),
      codex: new CodexAppServerHost({ userDataPath, executable: nativeFixtureExecutable!,
        args: [join(__dirname, '../../tests/fixtures/fakeCodexAppServer.mjs'), join(nativeFixtureRoot, 'codex')], codexHome: join(nativeFixtureRoot, 'codex', 'home') }),
      grok: new E2EAgentHost(), devin: new E2EAgentHost(), opencode: new E2EAgentHost(),
    } } : {}),
    ...(e2eConfiguration === null ? {} : { reasoner: e2eAgentReasoner }),
    worktreeCleanup: { ...(e2eConfiguration === null ? { pullRequestMerged: githubPullRequestMerged } : {}), log: code => { logOperational(code) } },
    watcherLog: event => { logOperational(event) },
    claudeSettingsLog: event => { logOperational(event) },
    codexLog: event => { logOperational(event) },
  }) : await inactiveLocalHost(userDataPath)
  const { agentHost, agentControl, threadRegistry, turns, hostService } = localRuntime
  // A Playwright journey runs a babysitting pass when it asks, rather than waiting on the two-minute timer; development only.
  if (e2eConfiguration !== null && !app.isPackaged && localRuntime.babysitter) installBabysitPassE2E(localRuntime.babysitter)
  const quitHandles: HostQuitHandles = { localRuntime }
  registerHostQuitDrain(app, quitHandles, () => console.error('[Sotto] host-shutdown-failed'), () => logOperational('phone-access-close-failed'), platform, powerMonitor)
  let browserService: BrowserService | undefined
  let cloudIphoneService: CloudIphoneService | undefined
  const browserAgentServer = createBrowserAgentServer(() => browserService, () => cloudIphoneService)
  agentHost.useBrowserTools(browserAgentServer)
  // The runtime builds the worktree cleanup (ADR-0041). Only the local host has worktrees on this
  // computer; with it off the inactive host's cleanup does nothing, and no terminal check is wired.
  const worktreeCleanup = startupSettings.localHostEnabled ? localRuntime.worktreeCleanup : null
  const hostRouter = new DesktopHostRouter(() => emptyDesktopState(agentControl.hostId()), { watcherEnabled, heldProviders, streamingPublishCost: owlFeatures['streaming-publish-cost'],
    bindRequestDraftDecision: (target, decisionId, answers) => requestDrafts.bindDecision(target, decisionId, answers),
  })
  quitHandles.hostRouter = hostRouter
  // The window's panes show their threads only while it has the focus (ADR-0046), on this computer's host and on every
  // remote host that keeps what is shown (ADR-0092).
  const windowFocusChanged = (): void => {
    const focused = BrowserWindow.getFocusedWindow()
    const shown = focused !== null && focused.webContents === windows.getMainWebContents()
    hostService.setWindowFocused(shown)
    hostRouter.setWindowFocused(shown)
  }
  app.on('browser-window-focus', windowFocusChanged)
  app.on('browser-window-blur', windowFocusChanged)
  windowFocusChanged()
  localRuntime.watcher?.useRemoteHosts(hostRouter.watcherHosts())
  if (startupSettings.localHostEnabled) hostRouter.add({
    hostId: agentControl.hostId()!, name: 'This computer', kind: 'local', service: hostService,
    detail: id => agentControl.threadDetail(id), preview: request => agentControl.attachmentPreview(request),
    stage: image => agentControl.stageAttachment(image), content: digest => agentControl.attachmentContent(digest),
    gitRefs: request => agentControl.gitRefs(request), gitChangedFiles: request => agentControl.gitChangedFiles(request), gitPullRequest: request => agentControl.gitPullRequest(request),
    offersBabysitting: () => hostService.supportsBabysitting === true,
    hostFolders: request => hostService.hostFolders(request),
    subscribeDetail: listener => agentControl.subscribeThreadDetail(listener),
    questionPage: token => agentControl.questionPage(token),
    questionPageOpened: token => agentControl.questionPageOpened(token),
  })
  // A Playwright journey adds hosts through a scripted ssh; development only, like the gh stand-in.
  const sshStandInScript = e2eConfiguration !== null && !app.isPackaged ? process.env['SOTTO_E2E_SSH_SCRIPT'] : undefined
  const sshStandInExecutable = process.env['SOTTO_E2E_SSH_EXECUTABLE']
  if (sshStandInScript && (!isAbsolute(sshStandInScript) || !sshStandInExecutable || !isAbsolute(sshStandInExecutable))) throw new Error('The ssh test stand-in requires absolute paths.')
  const sshStandIn = sshStandInScript && sshStandInExecutable ? e2eSshStandIn(sshStandInExecutable, sshStandInScript) : undefined
  // A Playwright journey stands a loopback proxy in for Tailscale Serve and maps one MagicDNS name to it; development only,
  // like the ssh stand-in, and only ever to this computer (ADR-0053).
  const tailnetStandIn = e2eConfiguration !== null && !app.isPackaged ? e2eTailnetMap(process.env['SOTTO_E2E_TAILNET_MAP']) : undefined
  /** The last page an end-to-end run asked the browser to open, which it never opens. */
  let openedExternalLink: string | null = null
  const retainedDrafts = new RetainedDraftStore({ directory: userDataPath, watcherEnabled, heldProviders, historyEnabled: () => agentHistoryEnabled,
    onRecovery: () => recoveryNotices.publish({ code: 'REMOTE_DRAFTS_UNREADABLE' }),
    onWriteFailure: () => recoveryNotices.publish({ code: 'REMOTE_DRAFT_STORAGE_NOT_UPDATED' }) })
  const desktopHosts = new DesktopHosts({ directory: userDataPath, credentials, router: hostRouter, retainedDrafts, watcherEnabled, heldProviders, streamingPublishCost: owlFeatures['streaming-publish-cost'], clientVersion: hostVersion,
    waitingClientVersion: () => waitingHostVersion,
    localHostRunning: startupSettings.localHostEnabled, localHostEnabled: () => workingCopySettings.localHostEnabled,
    restart: () => { app.relaunch(); app.quit() },
    ...(sshStandIn ? { launcher: () => new SshHostLauncher({ spawn: sshStandIn }) } : {}),
    ...(tailnetStandIn ? { resolveTailnet: tailnetStandIn } : {}),
    openExternal: async url => { if (e2eConfiguration === null) await shell.openExternal(url); else openedExternalLink = url },
  })
  quitHandles.desktopHosts = desktopHosts
  await desktopHosts.start()
  // Saved host identities filter recovery before disk drafts load. Unread originals stay untouched.
  await retainedDrafts.load()
  // Have my agent set this up (ADR-0035): a host setup thread on this computer, with the host setup tools while it
  // runs. The thread reaches the device through this computer's SSH setup, so it needs the local host.
  // Have my agent install it, update it or fix it on a host's provider tile runs the same way, in the same project, and
  // one agent job runs at a time: a host setup or a provider job.
  const agentJobThreads = coordinatorSetupThreads({ coordinator: agentControl, folder: join(userDataPath, 'host-setup'), localHostRunning: startupSettings.localHostEnabled })
  const providerJobs: HostProviderJobs = new HostProviderJobs({ threads: agentJobThreads,
    hosts: { host: id => desktopHosts.jobHost(id), provider: (id, provider) => desktopHosts.providerStatus(id, provider),
      refresh: (id, provider) => desktopHosts.refreshProvider(id, provider),
      subscribe: listener => { const off = [hostRouter.subscribeChanges(listener), desktopHosts.subscribe(() => listener())]; return () => { for (const item of off) item() } } },
    busy: (): string | undefined => { const setup = hostSetup.state(); return setup && (setup.phase === 'starting' || setup.phase === 'running') ? `An agent is setting up ${setup.name} now. Stop that setup first. Nothing was started.` : undefined } })
  const hostSetup: HostSetup = new HostSetup({ version: hostVersion,
    hosts: { check: connection => desktopHosts.check(connection), add: connection => desktopHosts.setupAdd(connection), forget: id => desktopHosts.forgetSaved(id),
      attempt: id => desktopHosts.attempt(id), cancelAttempt: id => desktopHosts.cancelAttempt(id), savedAs: (target, port) => desktopHosts.savedAs(target, port) },
    threads: agentJobThreads, busy: (): string | undefined => providerJobs.busySentence() })
  const hostSetupTools = new HostSetupToolServer(agentJobTools(hostSetup, providerJobs))
  quitHandles.providerJobs = providerJobs
  quitHandles.hostSetup = hostSetup
  quitHandles.hostSetupTools = hostSetupTools
  hostSetup.useTools(threadId => hostSetupTools.revoke(threadId))
  providerJobs.useTools(threadId => hostSetupTools.revoke(threadId))
  // Let an agent draw a visual in its thread (ADR-0056): every admitted launch gets the tool while the switch is on, read live.
  const visualTools = new VisualToolServer({ enabled: () => workingCopySettings.visualsInThreads,
    admits: threadId => agentHost.admitsVisuals(threadId), add: (threadId, input) => agentHost.addVisual(threadId, input) })
  quitHandles.visualTools = visualTools
  // Let an agent babysit its pull requests (ADR-0061): every Claude Code, Codex and Grok Build launch on this computer gets
  // the tool while the switch is on, read live; turned off, what agents started ends at once. Only the local host reads
  // GitHub for this computer's threads, so with it off no thread is offered the tool. Off at start, the runtime has
  // already ended what agents started, before its first pass.
  const pullRequestTools = new PullRequestToolServer({ enabled: () => workingCopySettings.babysitPullRequests, host: agentHost,
    babysitter: 'babysitter' in localRuntime ? localRuntime.babysitter : undefined, watcherEnabled })
  quitHandles.pullRequestTools = pullRequestTools
  // Let a thread delegate work to threads it starts (ADR-0081): an Owl feature, so stable offers no server and keeps its records.
  const delegationService = 'delegation' in localRuntime ? localRuntime.delegation : undefined
  // Continue a thread on another provider (ADR-0089): an Owl feature, so stable builds no service and registers no bridge.
  const continueService = 'continuation' in localRuntime ? localRuntime.continuation : undefined
  const delegationTools = delegationService ? new DelegationToolServer(delegationService, { roles: workerRolesEnabled, machines: crossMachineEnabled && watcherEnabled }) : undefined
  if (delegationTools) quitHandles.delegationTools = delegationTools
  agentHost.useThreadTools([hostSetupTools, visualTools, pullRequestTools, ...(delegationTools ? [delegationTools] : [])])
  // An interactive visual runs in a sealed page (ADR-0060): main serves it from this store, once per address. The session
  // and its proxy are set up the first time a page is asked for.
  const disposeVisualSandbox = installVisualSandbox({
    ipc: ipcMain,
    contentsCreated: listener => {
      const created = (event: ElectronEvent, contents: WebContents): void => listener(event, contents as unknown as VisualContentsLike)
      app.on('web-contents-created', created)
      return () => { app.removeListener('web-contents-created', created) }
    },
    session: () => session.fromPartition(VISUAL_PARTITION),
    startProxy: startDeadProxy,
  }, {
    read: (threadId, visualId) => agentHost.visual(threadId, visualId),
    localHostId: () => agentControl.hostId(),
    mainWebContents: () => windows.getMainWebContents(), senders: () => windows.getTrustedRenderers(),
    preloadDirectory: join(__dirname, '../preload'), fontCss: FIGTREE_FONT_FACES,
  })
  app.on('will-quit', disposeVisualSandbox)
  agentControl.useSottoRequests(hostSetupRequests(hostSetup))
  desktopHosts.useSetup(hostSetup)
  desktopHosts.useProviderJob(providerJobs)
  const busyThreads = routerBusyThreads(hostRouter)
  // Hosts that run an older Sotto than this computer, and their updates from the Threads page (ADR-0040). A development
  // end-to-end run serves its own releases.
  const releasesStandIn = e2eConfiguration !== null && !app.isPackaged ? process.env['SOTTO_E2E_HOST_RELEASES_URL'] : undefined
  const hostUpdates = new HostUpdates({ version: hostVersion, ...(releasesStandIn ? { releasesUrl: releasesStandIn } : {}),
    requiresManagementUpdate: hostId => hostRouter.requiresManagementUpdate(hostId),
    hosts: { candidates: () => desktopHosts.updateCandidates(), run: (id, operation, options) => desktopHosts.runUpdate(id, operation, options),
      restart: (id, version, options) => desktopHosts.restartForUpdate(id, version, options), subscribe: listener => desktopHosts.subscribe(() => listener()) },
    threads: busyThreads,
    // A host's own update waits for its client update line, read in place; the router's changes reach it through busyThreads.
    clients: { updating: hostId => hostRouter.clientLineRunning(hostId) } })
  desktopHosts.useUpdates(hostUpdates)
  quitHandles.hostUpdates = hostUpdates
  // Start at boot from Settings > Hosts & phones (ADR-0054), which asks the same busy-host question before it restarts a host.
  const hostBoot = new HostBootChanges({ threads: busyThreads,
    hosts: { candidate: id => desktopHosts.bootCandidate(id), keeps: id => desktopHosts.bootKeeps(id), setBootStart: (id, action) => desktopHosts.setBootStart(id, action), subscribe: listener => desktopHosts.subscribe(() => listener()) } })
  desktopHosts.useBoot(hostBoot)
  quitHandles.hostBoot = hostBoot
  // Each remote host runs its own phone access; its Phones dialog reads and changes it over the host's SSH connection (ADR-0050).
  const hostPhones = new HostPhones({
    hosts: { links: () => desktopHosts.phonesLinks(), subscribe: listener => desktopHosts.subscribe(() => listener()) },
    openExternal: async url => { if (e2eConfiguration === null) await shell.openExternal(url) },
    log: logOperational,
  })
  desktopHosts.usePhones(hostPhones)
  quitHandles.hostPhones = hostPhones
  const remoteHostE2E = e2eConfiguration !== null && !app.isPackaged ? installRemoteHostE2E(hostRouter, retainedDrafts, watcherEnabled, heldProviders) : undefined
  if (remoteHostE2E) quitHandles.desktopHosts = { close: async () => {
    try { await desktopHosts.close() }
    finally { try { await remoteHostE2E.close() } finally { await retainedDrafts.close() } }
  } }
  // Phone access serves the local host's own threads to paired phones over the tailnet (ADR-0033). Its
  // Tailscale checks can take seconds, so they run beside startup rather than in front of the window.
  const files = new FilesService({
    resolveBinding: threadId => agentControl.filesBinding(threadId),
    copyPath: path => copyOutput(path),
    reveal: path => shell.showItemInFolder(path),
  })
  // A pane drawer starts in the project folder, even for a thread with its own worktree.
  const terminalService = new TerminalService({ files, directory: userDataPath,
    projectFolder: projectId => agentControl.projects().find(project => project.id === projectId)?.path,
    acquireStart: workspace => agentHost.acquireTerminalStart(workspace.workingDirectory),
    emit: event => { windows.sendToMain(TERMINAL_EVENT, event) } })
  const phoneAccess = new PhoneAccess({ directory: userDataPath, listener: { sottoVersion: hostVersion, delegation: delegationEnabled },
    service: startupSettings.localHostEnabled ? hostService : undefined,
    tailscale: e2eConfiguration === null ? new TailscaleCli() : e2eTailscale(userDataPath),
    settings: () => workingCopySettings, policy: authority,
    openExternal: async url => { if (e2eConfiguration === null) await shell.openExternal(url) },
    log: logOperational,
  })
  quitHandles.phoneAccess = phoneAccess
  void phoneAccess.start().catch(() => logOperational('phone-access-start-failed'))
  const requestDrafts: RequestDraftService = new RequestDraftService(userDataPath, owner => requestDraftOwnerState(owner, agentControl, hostRouter), async (target, decisionId) => {
    if (target.kind !== 'thread') throw new Error('Standalone chats are no longer available.')
    const key = parseHostEntityKey(target.ownerId)
    if (key && key.hostId !== agentControl.hostId()) await hostRouter.refreshRequestDraft(target, decisionId)
    else await agentControl.refreshRequestDraft(key?.id ?? target.ownerId, target.requestId)
  }, undefined, watcherEnabled && !heldProviders.size ? undefined : owner => {
    if (owner.kind !== 'thread') return false
    const key = parseHostEntityKey(owner.ownerId)
    if (key && key.hostId !== agentControl.hostId()) return hostRouter.preservesDormantThread(owner.ownerId)
    return localRuntime?.agentHost.dormantThreadIds?.().includes(key?.id ?? owner.ownerId) ?? false
  }, () => requestDraftWatcherOwnerIds(agentControl, () => localRuntime?.agentHost.dormantThreadIds?.(), hostRouter))
  await requestDrafts.start()
  const unsubscribeRequestDrafts = requestDrafts.onChanged(owner => windows.sendToMain(REQUEST_DRAFT_CHANGED, owner))
  mainActivity?.subscribe(state => { windows.sendToMain(MAIN_ACTIVITY_CHANGED, state) })
  const cleanRetiredHistory = async (): Promise<void> => {
    const [chats, answers, remoteDrafts] = await Promise.allSettled([
      Promise.resolve().then(() => retiredChatHistory.privacyChanged()),
      Promise.resolve().then(() => requestDrafts.privacyChanged(agentHistoryEnabled)),
      Promise.resolve().then(() => retainedDrafts.privacyChanged()),
    ])
    if (chats.status === 'rejected') recoveryNotices.publish({ code: 'RETIRED_CHAT_HISTORY_NOT_CLEARED' })
    if (answers.status === 'rejected') recoveryNotices.publish({ code: 'ANSWER_HISTORY_NOT_CLEARED' })
    if (remoteDrafts.status === 'rejected') recoveryNotices.publish({ code: 'REMOTE_DRAFT_STORAGE_NOT_UPDATED' })
    if (chats.status === 'rejected') throw chats.reason
    if (answers.status === 'rejected') throw answers.reason
    if (remoteDrafts.status === 'rejected') throw remoteDrafts.reason
  }
  // Retired records never start a provider. Apply the saved privacy preference once,
  // and keep startup available when inaccessible storage needs a later Settings retry.
  await cleanRetiredHistory().catch(() => undefined)
  await hostRouter.reconcileRequestDrafts(requestDrafts).catch(() => undefined)

  // Only the threads the main window has declared viewed receive their messages.
  const agentStateBroadcaster = new AgentStateBroadcaster()
  const agentStatePublisher = coalesceAgentStatePublishes(state => {
    // Every published state asks for answer recovery; the router runs one pass at a time, at most twice a second.
    hostRouter.scheduleRequestDraftReconcile(requestDrafts)
    // A window's model catalog rarely changes and most thread records do not change between broadcasts; each goes out
    // again only when it changed since the window's last broadcast (issues #286 and #1330).
    agentStateBroadcaster.send(state, payload => windows.sendToMain(AGENT_STATE, payload))
  })
  // A detail that opens a message goes out at once; the shell waiting in its window goes just ahead of it, so the
  // window paints the two in one commit (issue #771).
  const agentDetailPublisher = coalesceAgentThreadDetailPublishes(detail => windows.sendToMain(AGENT_THREAD_DETAIL, detail),
    { beforeOpening: () => agentStatePublisher.flush() })
  const unsubscribeAgents = hostRouter.subscribe(state => agentStatePublisher.publish(state))
  const unsubscribeAgentDetail = hostRouter.subscribeThreadDetail(detail => agentDetailPublisher.publish(detail))
  // Quitting drops the held state with its timer: the windows it would reach are going away.
  quitHandles.stopPublishing = () => {
    unsubscribeRequestDrafts(); unsubscribeAgents(); unsubscribeAgentDetail()
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
  // Built again whenever the interface language changes, so the menu's own words follow it.
  const installApplicationMenu = (): void => {
    const applicationMenuTemplate = buildApplicationMenuTemplate({
      platform,
      appName: APP_NAME,
      includeDeveloperTools: !app.isPackaged,
      onShowSettings: () => {
        void windows.showMain().catch(() => logOperational('native-main-show-failed'))
      },
      // Stable on a Mac cannot update itself, so its app menu leaves the command out; Owl's carries it.
      ...(inAppUpdates ? { onCheckForUpdates: requestUpdateCheck } : {}),
      onShowTurnRecords: showTurnRecords,
    })
    if (applicationMenuTemplate !== null) {
      // Windows and Linux keep Electron's default menu: installing null would also drop the
      // reload/devtools accelerators the app ships with today.
      Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate))
    }
  }
  installApplicationMenu()
  const e2eState = e2eConfiguration === null ? null : createE2ENativeState()
  const linuxClipboard = e2eState === null && platform === 'linux'
    ? createWaylandClipboard(clipboard, () => recoveryNotices.publish({ code: 'DESKTOP_CLIPBOARD_UNAVAILABLE' }))
    : null
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
      ?? (platform === 'darwin'
        // osascript's stderr says which permission refused the paste; it is read, never logged.
        ? createOsascriptPasteAdapter({
            spawn: (executable, args, options) => spawn(executable, [...args], { ...options, stdio: [...options.stdio] }),
            onDenied: denial => recoveryNotices.publish({
              code: denial === 'automation' ? 'AUTOMATION_PERMISSION_REQUIRED' : 'ACCESSIBILITY_PERMISSION_REQUIRED',
            }),
            log: logOperational,
          })
        : platform === 'linux'
          ? createHyprlandPasteAdapter(undefined, undefined, undefined, () => linuxClipboard!.copyToPrimary())
          : createSpawnProcessAdapter((executable, args, options) => spawn(executable, args, options)))
    : createE2EPasteProcess(e2eState!, e2eConfiguration.scenario, (text) => {
        const mainWindow = BrowserWindow.getAllWindows().find(
          (candidate) => candidate.getTitle() === buildName,
        )
        mainWindow?.webContents.insertText(text)
      })
  const accessibilityTrust: AccessibilityTrustAdapter =
    e2eConfiguration === null && profile.pasteRequiresAccessibilityTrust
      ? { isTrusted: (prompt) => systemPreferences.isTrustedAccessibilityClient(prompt) }
      : ALWAYS_TRUSTED_ACCESSIBILITY
  const output = new OutputService({
    clipboard: e2eState === null
      ? linuxClipboard ?? clipboard
      : createE2EClipboard(e2eState, e2eConfiguration?.scenario),
    // After a paste, the widget comes back only while dictation is on (ADR-0107).
    widget: { hideWidget: () => windows.hideWidget(), showWidget: () => dictationActive ? windows.showWidget() : undefined },
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
    keepWidgetVisibleDuringPaste: platform === 'linux',
    ...(platform === 'linux' ? { preparePasteText: sanitizeLinuxPasteText } : {}),
    // The delivered app (ADR-0100). A test run delivers into Sotto's own window.
    readFocusedApp: e2eConfiguration !== null
      ? async () => 'Sotto'
      : platform === 'win32'
        ? async () => warmPaste?.readForegroundApp() ?? null
        : platform === 'darwin' ? createLsappinfoFocusedApp() : createHyprlandFocusedApp(),
    log: logOperational,
  })
  // Copy image waits for any dictation still being pasted, and only an image Electron can read reaches the clipboard.
  // A test run never touches the real clipboard. Linux goes through wl-copy like text does. Under Wayland a wl-copy
  // that fails is reported, because Electron's own write may not reach other apps there and would claim a copy that
  // never happened; without Wayland, Electron's write is the clipboard.
  const imageClipboard = {
    writePng: (png: Buffer): Promise<void> => output.afterDeliveries(async () => {
      const image = nativeImage.createFromBuffer(png)
      if (image.isEmpty()) throw new Error('Unreadable image')
      if (e2eState !== null) return
      if (linuxClipboard !== null) {
        const written = await linuxClipboard.writePng(png).then(() => true, (error: unknown) => {
          if (process.env.WAYLAND_DISPLAY) throw error
          return false
        })
        if (written) return
      }
      clipboard.writeImage(image)
    }),
  }

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
    chosenModel: cleanupModelEnabled,
    onDiagnostic: diagnosticsAppender('polish-diagnostics.jsonl'),
    ...(e2eConfiguration === null
      ? {}
      : { fetchFn: () => Promise.reject(new Error('E2E_NETWORK_DISABLED')) }),
  })

  // Dictation transcribes on this computer (ADR-0071) with the model the user chose (ADR-0094). Nothing
  // downloads until they choose Sotto's own; on an Apple silicon Mac the Core ML models FluidAudio keeps
  // are on offer too, run through Sotto's helper. E2E runs never download or look: they report the model
  // ready, and the renderer uses its fake transcriber. Each failed segment records why and how long it
  // was in the transcription diagnostics, never what was said.
  const transcriptionDiagnostics = diagnosticsAppender('transcription-diagnostics.jsonl')
  const coreMlHelperPath = app.isPackaged
    ? join(process.resourcesPath, 'coreml-asr', 'sotto-coreml-asr')
    : join(__dirname, '../../native/coreml-asr/.build/sotto-coreml-asr')
  // The settings coordinator is made further down; the choice is saved through it once it exists.
  let saveSpeechModelChoice: (id: string | null) => Promise<void> = () => Promise.reject(new Error('Settings are not ready yet'))
  // Turned off (ADR-0107, Owl), main spends nothing on dictation: no shortcuts, key listener, speech model or widget,
  // and every dictation command is refused. It follows the setting live, both ways.
  let dictationActive = dictationOn(startupSettings, owlFeatures['dictation-off'])
  const speechModelManager = e2eConfiguration === null
    ? new SpeechModelManager({
      // One folder per model under speech-models; Parakeet v3's is where ADR-0071 put it.
      stores: SOTTO_SPEECH_MODELS.map((model) => new SpeechModelStore({
        directory: join(userDataPath, 'speech-models'),
        model,
        loadEngine: loadParakeetEngine,
        onStatus: () => undefined,
      })),
      findFluidAudio: () => coreMlHelperAvailable(coreMlHelperPath)
        ? findFluidAudioModels(fluidAudioModelsRoot(app.getPath('appData')))
        : Promise.resolve([]),
      coreMlLoader: (version) => createCoreMlEngineLoader(coreMlHelperPath, version),
      modelBeforeChoosing: PARAKEET_V3.id,
      readChoice: () => workingCopySettings.speechModel,
      saveChoice: (id) => saveSpeechModelChoice(id),
      onStatus: (status) => { windows.sendToMain(SPEECH_MODEL_STATUS, status) },
    })
    : null
  const speechModel = {
    status: (): SpeechModelStatus => speechModelManager?.status() ?? { state: 'ready' },
    download: (): void => { if (dictationActive) speechModelManager?.download() },
    // E2E runs offer Parakeet v3 as already here and Sotto's other models as downloads, so setup and
    // Settings show real rows; choosing one only saves the choice, since an E2E model is always ready.
    list: (): Promise<SpeechModelOption[]> => speechModelManager?.list() ?? Promise.resolve(
      SOTTO_SPEECH_MODELS.map((model) => sottoSpeechModelOption(model, model.id === PARAKEET_V3.id)),
    ),
    choose: async (id: string): Promise<boolean> => {
      // Off, choosing would load the model; Settings hides the picker then (ADR-0107).
      if (!dictationActive) return false
      if (speechModelManager !== null) return speechModelManager.choose(id)
      if (sottoSpeechModel(id) === undefined) return false
      await saveSpeechModelChoice(id)
      return true
    },
  }
  const transcription = new LocalTranscriptionService({
    engine: () => speechModelManager?.currentEngine() ?? null,
    onFailure: transcriptionDiagnostics,
  })

  // GitHub Releases is a real feed only for the packaged Windows app and the
  // packaged Mac Owl: stable's macOS disk image ships no update metadata, and a
  // development or E2E run must never reach the network. Everywhere else the
  // service resolves to the 'unsupported' phase without constructing
  // electron-updater at all.
  const updatesSupported = app.isPackaged && e2eConfiguration === null && inAppUpdates
  // A development end-to-end run can be offered an update of its own, which downloads nothing and never installs.
  const updateStandIn = e2eConfiguration !== null && !app.isPackaged ? process.env['SOTTO_E2E_APP_UPDATE'] : undefined
  // What a Mac's installer does before it quits, for that stand-in: announce the restart, ask every window to close, and
  // announce it again once the last one has.
  const closeWindowsLikeInstaller = (): Promise<void> => new Promise(resolve => {
    const announce = (): boolean => nativeAutoUpdater.emit('before-quit-for-update')
    announce()
    const open = BrowserWindow.getAllWindows()
    let remaining = open.length
    const closed = (): void => {
      remaining -= 1
      if (remaining <= 0) { announce(); resolve() }
    }
    if (remaining === 0) closed()
    for (const window of open) {
      window.once('closed', closed)
      window.close()
    }
  })
  // A new version of Sotto has every machine check its clients afresh, so the card lists their updates beside it rather
  // than after the restart (ADR-0077). Nothing waits for the answers, and on stable the client update card and each
  // host's tiles read the same readings sooner.
  const newSottoVersion = newVersionListener(() => {
    void agentControl.checkClientsAfresh().catch(() => undefined)
    void hostRouter.checkHostClientsAfresh()
  })
  const updates = new UpdateService({
    currentVersion: appRunningVersion, owlFeatures, watcherEnabled,
    getSettings: () => settings.get(),
    // With Update all on, the restart waits for a host update under way, which it would otherwise cut off (ADR-0077).
    ...(owlFeatures['update-all'] ? { restartHold: () => hostUpdates.restartHold() } : {}),
    // A refused install ends the restart Electron announced (`before-quit-for-update`, below): the window comes back with
    // the reason on its update card.
    restartRefused: () => {
      windows.cancelQuit()
      void windows.showMain().catch(() => logOperational('native-main-show-failed'))
    },
    ...(updatesSupported ? { createUpdater: createElectronUpdaterAdapter } : updateStandIn ? { createUpdater: () => e2eUpdater(updateStandIn, undefined, closeWindowsLikeInstaller) } : {}),
    onStatusChanged: (status) => {
      windows.sendToMain(UPDATE_STATUS, status)
      // Update all aims each host at the version this computer is downloading, once its archive is published (ADR-0077).
      // Only a change of phase passes on, never a download's progress, so a page that did not answer is not asked again
      // on every tick.
      if (owlFeatures['update-all'] && status.phase.phase !== waitingPhase) {
        waitingPhase = status.phase.phase
        waitingAppVersion = waitingVersion(status.phase, waitingAppVersion)
        waitingHostVersion = waitingAppVersion === undefined ? undefined : updateHostReleaseVersion(waitingAppVersion, usageEnabled || releasesHeldProvider(heldProviders))
        hostUpdates.pending(waitingHostVersion)
      }
      newSottoVersion(status.phase)
    },
  })
  // Electron announces a restart for an update before it closes a window. On a Mac it then closes every window itself and
  // installs once they are all gone, so the main window, which hides to the tray when closed, has to let go or the update
  // never comes. electron-updater announces it on this same autoUpdater on Windows too (BaseUpdater.quitAndInstall), just
  // before it calls app.quit(). A Mac announces it a second time once the last window has closed, and again whenever the
  // last window next closes after a refusal; only a restart that is under way begins a quit, or a refused one would leave
  // Sotto unable to show a window.
  nativeAutoUpdater.on('before-quit-for-update', () => { if (updates.restarting()) windows.beginQuit() })

  const messageDelivery = new NativeMessageDelivery(windows)
  let currentTrayState: TrayState = { dictating: false, autoPaste: true }
  const dispatchDictation = (command: DictationCommand): void => {
    if (!dictationActive) return
    void messageDelivery.sendToMain(DICTATION_COMMAND, command).then((delivered) => {
      if (!delivered) {
        logOperational('native-main-send-failed')
      }
    })
  }
  const showWidget = (): void => {
    if (!dictationActive) return
    void windows.showWidget().catch(() => logOperational('native-widget-show-failed'))
  }
  const toggleDictation = (): void => {
    dispatchDictation({ type: 'toggle' })
    showWidget()
  }

  const e2eShortcuts = e2eConfiguration === null
    ? null
    : createE2EGlobalShortcuts(e2eConfiguration.scenario)
  // Off, the gate holds every dictation shortcut back from the OS and stops the key listener's helper.
  const dictationGate = createDictationGate(e2eShortcuts ?? globalShortcut, dictationActive)
  const hotkeys = new HotkeyManager(
    dictationGate.shortcuts,
    () => {
      // A hold in progress no longer owns the session the primary shortcut toggled.
      dictationShortcuts?.pressToggled()
      toggleDictation()
    },
    () => {
    hotkeys.cancelListening()
    dispatchDictation({ type: 'cancel' })
    },
    platform,
    logOperational,
  )
  // The widget's latest status: a hold shortcut starts dictation only when no session is under way.
  let widgetState: { status: WidgetSnapshot['status']; kept: boolean } = { status: 'idle', kept: false }
  // Sotto's own page must hold the keyboard: a site in the in-app browser or the cloud iPhone sits in the same
  // window, and record mode must never hear what is typed there.
  const mainWindowInFront = (): boolean => {
    const focused = BrowserWindow.getFocusedWindow()
    return focused !== null && focused.webContents === windows.getMainWebContents() && focused.isVisible()
  }
  const mainWindowFocused = (): boolean => mainWindowInFront() && BrowserWindow.getFocusedWindow()?.webContents.isFocused() === true
  // Extra and hold shortcuts are an Owl feature, and Linux binds shortcuts in the compositor.
  const dictationShortcuts = platform !== 'linux' && owlFeatures['dictation-hold-shortcuts']
    ? createDictationShortcutRouter({
        shortcuts: dictationGate.shortcuts,
        createListener: handlers => dictationGate.listener(createKeyListener({
          platform,
          // The Windows helper can take long to start cold.
          readyTimeoutMs: platform === 'win32' ? 30_000 : 5_000,
          // An E2E run never spawns the helper, so it never asks for Input Monitoring.
          spawnHelper: e2eConfiguration === null
            ? () => spawnKeyListenerHelper(platform, { resourcesPath: process.resourcesPath, appPath: app.getAppPath(), packaged: app.isPackaged, log: event => logOperational(event as DictationShortcutEvent) })
            : () => null,
          log: event => logOperational(event as DictationShortcutEvent),
          ...handlers,
        })),
        canStart: () => holdCanStart(widgetState),
        isFocused: mainWindowFocused,
        dispatch: dispatchDictation,
        showWidget,
        pushHeld: tokens => { windows.sendToMain(DICTATION_KEYS_HELD, tokens) },
        pushPermission: permission => { windows.sendToMain(KEY_LISTENER_PERMISSION_CHANGED, permission) },
        openInputMonitoring: () => e2eConfiguration === null
          ? createSystemSettingsOpener(platform, url => shell.openExternal(url))?.('input-monitoring')
          : undefined,
        log: logOperational,
        platform,
      })
    : null
  if (dictationShortcuts !== null) interruptOnLockAndSleep(powerMonitor, () => dictationShortcuts.interrupt())
  // Linux: while Settings records keys, Sotto's own Hyprland bindings start nothing. Hyprland keeps a bound key from the
  // page, so the recording is told whose it was instead.
  let compositorKeysSuspended = false
  // The latest recording's span, in the epoch nanoseconds bindings stamp their key events with. A binding's command can
  // arrive after the recording ends, since the launcher boots first, so a key pressed during it is still Sotto's.
  let recordingSpan: { from: bigint; to: bigint | null } | null = null
  const epochNanoseconds = (): bigint => BigInt(Date.now()) * 1_000_000n
  // Settings recording stands every dictation shortcut down; stable has only the hotkey to suspend.
  const shortcutLifecycle = createDictationShortcutLifecycle({
    suspend: suspended => {
      hotkeys.suspend(suspended)
      dictationShortcuts?.suspend(suspended)
      if (platform === 'linux' && suspended !== compositorKeysSuspended) {
        recordingSpan = suspended ? { from: epochNanoseconds(), to: null } : recordingSpan && { ...recordingSpan, to: epochNanoseconds() }
      }
      compositorKeysSuspended = platform === 'linux' && suspended
    },
    router: dictationShortcuts,
    isFocused: mainWindowFocused,
    windowFocused: mainWindowInFront,
  })
  // A lock or a sleep also ends a page recording's stand-down, not only the router's own recording.
  interruptOnLockAndSleep(powerMonitor, () => shortcutLifecycle.windowLostFocus())
  // Record mode sees keys typed in other apps, so it ends the moment the main window loses the focus.
  const watchMainWindowFocus = (window: BrowserWindow): void => {
    const lost = (): void => { if (window.webContents === windows.getMainWebContents()) shortcutLifecycle.windowLostFocus() }
    window.on('blur', lost)
    window.on('hide', lost)
    window.on('minimize', lost)
  }
  BrowserWindow.getAllWindows().forEach(watchMainWindowFocus)
  app.on('browser-window-created', (_event, window) => watchMainWindowFocus(window))

  const nativeTray = e2eConfiguration === null
    ? await createTrayResource({
        source: profile.trayIcon,
        executablePath: process.execPath,
        unpackagedIconPath,
        getFileIcon: (path, options) => app.getFileIcon(path, options),
        // The build emits this PNG under out/, which existing packaging includes on every platform.
        // macOS keeps its existing resource path and automatic @2x template lookup.
        resolveResourcePath: (relativePath) => platform === 'linux' ? linuxTrayIconPath : join(resourceRoot, relativePath),
        loadImageIcon: (path) => {
          const icon = nativeImage.createFromPath(path)
          // Keep the colour app icon small enough for the tray, with pixels for a 2x bar.
          return platform === 'linux' ? icon.resize({ width: 44, height: 44 }) : icon
        },
        markTemplate: (icon) => { if (platform === 'darwin') icon.setTemplateImage(true) },
        guid: profile.trayGuid,
        createTray: (icon, guid) => guid === null ? new Tray(icon) : new Tray(icon, guid),
        tooltip: buildName,
      })
    : { setContextMenu: () => undefined, destroy: () => undefined }
  // The menu bar owl (ADR-0114): on a Mac in an Owl build the tray's picture is swapped on a schedule. When its frames cannot
  // be read the one-tint template stays and the user loses only the animation.
  const menuBarOwl: MenuBarOwl | null = menuBarOwlWanted(platform, owlFeatures, e2eConfiguration !== null) && 'setImage' in nativeTray
    ? startMenuBarOwl(nativeTray, startupSettings, electronOwlEnvironment({ nativeImage, systemPreferences, powerMonitor }, resourceRoot, event => { if (event === 'owl-frames-unavailable' || event === 'owl-failed') logOperational(event) }))
    : null
  try {
  const trayAdapter: TrayAdapter = {
    setMenu(items): void {
      nativeTray.setContextMenu(Menu.buildFromTemplate(items.map(toMenuTemplate)))
    },
    destroy(): void {
      nativeTray.destroy()
    },
  }
  // Linux's keys are Hyprland bindings the Omarchy setup writes; it is built with the IPC, after this coordinator.
  let omarchySetup: OmarchySetup | null = null
  const settingsCoordinator = new NativeSettingsCoordinator({
    repository: settings,
    hotkeys,
    platform,
    ...(dictationShortcuts === null ? {} : { dictationShortcuts }),
    ...(platform === 'linux' ? { compositorKeys: {
      replace: async set => omarchySetup === null ? { ok: false as const, reason: 'unavailable' as const } : omarchySetup.replaceShortcuts(set),
    } } : {}),
    startup,
    defaults: platformDefaults,
    onAutoPasteChanged(enabled): void {
      currentTrayState = { ...currentTrayState, autoPaste: enabled }
      trayController.update(currentTrayState)
    },
    async onSettingsChanged(settings): Promise<void> {
      const grantDefaultChanged = settings.browserWithoutAsking !== workingCopySettings.browserWithoutAsking
      const babysittingChanged = settings.babysitPullRequests !== workingCopySettings.babysitPullRequests
      const workerRolesChanged = JSON.stringify(settings.workerRoles) !== JSON.stringify(workingCopySettings.workerRoles)
      workingCopySettings = settings
      menuBarOwl?.applySettings(settings)
      // A new interface language reaches the tray, the menu and both windows at once, with no restart (ADR-0123).
      if (await applyInterfaceLanguage(settings)) {
        trayController.update(currentTrayState)
        installApplicationMenu()
        windows.sendToMain(INTERFACE_LANGUAGE_CHANGED, interfaceLanguage.current())
        windows.sendToWidget(INTERFACE_LANGUAGE_CHANGED, interfaceLanguage.current())
      }
      // Each provider's own sub-agents follow the worker roles (#1042): Codex's role files are written again for the
      // threads' next loads. Only while that Owl feature is on does the runtime hold the table.
      if (workerRolesChanged && 'workerRoles' in localRuntime) localRuntime.workerRoles?.changed()
      worktreeCleanup?.settingsChanged()
      localRuntime.watcher?.settingsChanged()
      phoneAccess.settingsChanged()
      if (grantDefaultChanged) browserService?.settingChanged()
      if (babysittingChanged) void pullRequestTools.settingChanged().catch(() => undefined)
      agentHistoryEnabled = settings.historyEnabled
      const dictationNow = dictationOn(settings, owlFeatures['dictation-off'])
      if (dictationNow !== dictationActive) applyDictation(dictationNow)
      await cleanSettingsHistory(agentControl, async () => {
        showWidgetWhenIdle = settings.showWidgetWhenIdle
        widgetPresentation = widgetPresentationFor(settings)
        dockSettings = settings
        paintDock()
        if (!dictationActive) {
          windows.hideWidget()
        } else if (!dictationLifecycle.isIdle()) {
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
      }, [cleanRetiredHistory])
    },
  })
  // Loads the chosen model now that a choice can be saved; an install whose own model is already here keeps it.
  saveSpeechModelChoice = async (id) => { await settingsCoordinator.updateSettings({ speechModel: id }) }
  // Notifications (ADR-0117): the tracker reads each state the router publishes, which joins every host's threads, and the
  // notifier shows what it finds. A press brings the window forward, selects the thread and shows Threads. An end-to-end
  // run shows a stand-in, never the system's.
  const desktopNotifier = desktopNotificationsEnabled ? createDesktopNotifier({
    create: options => e2eConfiguration === null ? new Notification(options) : fakeNotification(options),
    isSupported: () => Notification.isSupported(),
    switches: async () => { const current = await settingsCoordinator.getSettings(); return { needsYou: current.notifyNeedsYou, finished: current.notifyFinished } },
    open: threadId => {
      void windows.showMain()
        .then(() => hostRouter.command({ type: 'select-thread', threadId }, desktopWindowClient()))
        .then(() => { windows.sendToMain(NOTIFICATION_OPENED, null) })
        .catch(() => logOperational('native-main-show-failed'))
    },
    log: logOperational,
  }) : null
  if (desktopNotifier !== null) {
    const alerts = new ThreadAlerts({
      shows: threadId => hostRouter.windowShows(threadId),
      // Watcher keeps a thread it watches going and settles it when done, so that thread's finish is not told (ADR-0117).
      ...(localRuntime.watcher ? { watched: (threadId: string) => {
        const key = parseHostEntityKey(threadId)
        return key !== null && localRuntime.watcher?.watches({ hostId: key.hostId, threadId: key.id }) === true
      } } : {}),
      emit: alert => { void desktopNotifier.notify(alert) },
    })
    const stopAlerts = hostRouter.subscribe(state => alerts.track(state))
    app.on('will-quit', () => { stopAlerts(); alerts.dispose(); desktopNotifier.dispose() })
  }
  if (dictationActive) void speechModelManager?.start()
  const trayController = new TrayController(trayAdapter, {
    ...(!app.isPackaged ? { showTurnRecords } : {}),
    toggleDictation,
    dictationOn: () => dictationActive,
    setAutoPaste(enabled): void {
      void settingsCoordinator
        .updateSettings({ autoPaste: enabled })
        .catch(() => logOperational('settings-update-failed'))
    },
    show(): void {
      void windows.showMain().catch(() => logOperational('native-main-show-failed'))
    },
    // Only where a check can answer, and only where the tray is the one menu: a Mac's app menu carries it instead.
    ...(updatesSupported && profile.applicationMenu === 'none' ? { checkForUpdates: requestUpdateCheck } : {}),
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
      menuBarOwl?.dispose()
      trayController.dispose()
    },
  }

  const dictationLifecycle = new NativeDictationLifecycle({
    // Off, nothing reaches the widget, so nothing shows or makes it; turning on re-seeds the resting sliver.
    delivery: { sendToWidget: (channel, payload, reveal) => dictationActive ? messageDelivery.sendToWidget(channel, payload, reveal) : Promise.resolve(true) },
    publishShellState: (state) => linuxDictationShell?.publish(state),
    getTrayState: () => currentTrayState,
    updateTray(state): void {
      currentTrayState = state
      trayController.update(state)
    },
    syncEscape: (state) => {
      widgetState = { status: state.status, kept: 'kept' in state && state.kept === true }
      syncEscapeForWidgetSnapshot(hotkeys, state)
    },
    showWidgetWhenIdle: () => showWidgetWhenIdle,
    presentation: () => widgetPresentation,
    log: logOperational,
  })
  handleRendererProcessGone = (kind) => {
    dictationLifecycle.rendererProcessGone(kind)
    // A crashed Settings can no longer end its recording, so the shortcuts come back now.
    if (kind === 'main') shortcutLifecycle.rendererGone()
  }
  // Set when dictation goes off mid-transcription: the model is let go once that dictation ends.
  let unloadWhenDone = false
  const publishWidgetState = async (state: WidgetSnapshot): Promise<void> => {
    await dictationLifecycle.publish(state)
    // A dictation being transcribed when dictation went off has finished; the model can go now.
    if (unloadWhenDone && state.status !== 'processing') {
      unloadWhenDone = false
      void speechModelManager?.unload()
    }
  }
  const publishIdleWidgetState = async (current: AppSettings): Promise<void> => {
    if (!dictationActive) return
    await dictationLifecycle.publish({
      status: 'idle',
      ...widgetPresentationFor(current),
      shortcut: current.hotkey,
      cancellable: false,
    })
  }

  const applyDictation = (on: boolean): void => {
    if (!on) {
      // A recording under way, or one still waiting for the microphone, ends unsaved, since no shortcut could stop
      // it now. A dictation already being transcribed finishes, and a kept one stays kept for when dictation is back on.
      if (widgetState.status === 'listening' || widgetState.status === 'requesting-permission') void messageDelivery.sendToMain(DICTATION_COMMAND, { type: 'cancel' })
      dictationShortcuts?.interrupt()
      hotkeys.cancelListening()
    }
    // The router lets go of its shortcuts and takes them back after the gate opens, so one another app took
    // meanwhile goes through its usual retries instead of counting as registered.
    if (on) dictationShortcuts?.suspend(true)
    dictationActive = on
    if (dictationGate.set(on).length > 0) logOperational('native-hotkey-registration-failed')
    if (on) dictationShortcuts?.suspend(false)
    // A hotkey another app took meanwhile is tried again, as at a start.
    if (on) hotkeys.replace(workingCopySettings.hotkey)
    trayController.update(currentTrayState)
    unloadWhenDone = false
    if (on) {
      void speechModelManager?.start()
    } else {
      windows.hideWidget()
      if (widgetState.status === 'processing') unloadWhenDone = true
      else void speechModelManager?.unload()
    }
  }

  const permissionAdapter = createPermissionAdapter()
  const microphoneAccess =
    e2eConfiguration === null && profile.requiresMediaAccessGate
      ? createMicrophoneAccessGate({
          status: () => systemPreferences.getMediaAccessStatus('microphone'),
          request: () => systemPreferences.askForMediaAccess('microphone'),
        })
      : null
  // Off, nothing in Sotto may open the microphone: every ask answers no without asking the user (ADR-0107).
  const microphoneAccessWhileOn = microphoneAccess === null ? null : {
    ...microphoneAccess,
    ensure: () => dictationActive ? microphoneAccess.ensure() : Promise.resolve(false),
    isGranted: () => dictationActive && microphoneAccess.isGranted(),
  }
  if (platform === 'linux') {
    linuxDictationShell = new LinuxDictationShell(
      e2eConfiguration?.userDataPath ?? process.env.XDG_RUNTIME_DIR,
      new ShellWidgetMonitor(
        platform, homedir(),
        present => {
          void windows.setWidgetSuppressed(present).catch(() => logOperational('native-widget-show-failed'))
          if (present === shellPillInUse) return
          shellPillInUse = present
          void settingsCoordinator.republish().catch(() => logOperational('shell-pill-refresh-failed'))
        },
      ),
      async (command, at) => {
        if (command.startsWith('place ')) {
          const edge = parseDictationEdge(command.slice(6))
          if (edge === null) return false
          widgetPlacement = { kind: 'edge', edge }
          await widgetPlacementStore.save({ edge })
          linuxDictationShell?.place(edge)
          await windows.setWidgetPlacement({ edge })
          return true
        }
        // Turned off, the user's own compositor keys start nothing.
        if (!dictationActive) return false
        const pressedWhileRecording = at !== undefined && recordingSpan !== null && at >= recordingSpan.from && (recordingSpan.to === null || at <= recordingSpan.to)
        if ((compositorKeysSuspended || pressedWhileRecording) && (command === 'start' || command === 'toggle')) {
          if (compositorKeysSuspended) windows.sendToMain(DICTATION_KEYS_TAKEN, command === 'toggle' ? 'press' : 'hold')
          return true
        }
        return messageDelivery.sendToMain(DICTATION_COMMAND, { type: command === 'discard' ? 'dismiss' : command })
      },
      () => windows.getWidgetPlacement().edge,
      logOperational,
    )
  }
  return new NativeRuntimeController({
    ...(linuxDictationShell === null ? {} : { dictationCommands: linuxDictationShell }),
    windows,
    hotkeys,
    ...(dictationShortcuts === null ? {} : { dictationShortcuts }),
    tray,
    startup,
    settings,
    publishIdleWidgetState,
    dictationOn: () => dictationActive,
    installPermissions: () =>
      installSessionPermissionPolicy(
        permissionAdapter,
        () =>
          windows
            .getTrustedRenderers()
            .filter((renderer) => renderer.role === 'main'),
        // Omitted where no OS microphone gate exists, which keeps the grant
        // synchronous exactly as it is today.
        microphoneAccessWhileOn === null ? undefined : () => microphoneAccessWhileOn.ensure(),
        microphoneAccessWhileOn === null ? undefined : () => microphoneAccessWhileOn.isGranted(),
      ),
    registerIpc: () => {
      const cleanupRequestDrafts = registerRequestDraftIpc(ipcMain, requestDrafts, () => windows.getTrustedRenderers())
      // A thread on a paired host is read on that host (ADR-0025, October 5 amendment). Copy path copies the host's own
      // path to this computer's clipboard, in the host's format; nothing on the host is opened or written.
      const copyHostPath = async <T extends { ok: true; value: { absolutePath: string } } | { ok: false }>(result: T): Promise<T> => { if (result.ok) await copyOutput(result.value.absolutePath); return result }
      const cleanupFiles = registerFilesIpc(ipcMain, files, () => windows.getTrustedRenderers(), {
        list: request => hostRouter.threadFiles(request), preview: request => hostRouter.threadFilePreview(request),
        copyPath: async request => copyHostPath(await hostRouter.threadFilePath(request)),
      }, owlFeatures['reveal-linked-files'])
      const cleanupSubagents = registerSubagentIpc(ipcMain, agentHost, () => windows.getTrustedRenderers(), change => windows.sendToMain(SUBAGENTS_CHANGED, change), hostRouter)
      const cleanupUsage = registerUsageIpc(ipcMain, { read: query => hostRouter.usageRead(query),
        refresh: query => hostRouter.usageRefresh(query), clear: query => hostRouter.usageClear(query) }, () => windows.getTrustedRenderers(), usageEnabled)
      // The delegating thread's cards read delegation's own record (#1029); stable built no service, so nothing is registered.
      const cleanupDelegations = registerDelegationIpc(ipcMain, delegationService, () => windows.getTrustedRenderers(), () => agentControl.hostId(),
        (channel, payload) => { windows.sendToMain(channel, payload) })
      const cleanupContinue = registerContinueIpc(ipcMain, continueService, () => windows.getTrustedRenderers())
      const cleanupNotifications = registerNotificationIpc(ipcMain, desktopNotifier, () => windows.getTrustedRenderers())
      // A recording profiles the main window that asked, through its own debugger (ADR-0098).
      const cleanupMainActivity = registerMainActivityIpc(ipcMain, mainActivity, () => windows.getTrustedRenderers(),
        event => { const sender = BrowserWindow.getAllWindows().find(window => window.webContents === event.sender)?.webContents; return sender ? windowProfiler(sender.debugger) : null })
      // OpenCode's sign-in (#1104): only while its Owl feature is on, so stable registers nothing.
      const cleanupOpenCodeSignIn = registerOpenCodeSignInIpc(ipcMain, heldProviders.has('opencode') ? undefined : localRuntime.opencodeSignIn, () => windows.getTrustedRenderers())
      const checkpointIntegration = connectCheckpoints({ historyEnabled: () => agentHistoryEnabled, files, directory: userDataPath, host: agentHost, control: agentControl, registry: threadRegistry,
        report: () => { logOperational('checkpoint-unavailable') } })
      agentHost.setMutationGuard(checkpointIntegration.canMutate)
      const gitChanges = new GitChangesService({ files, checkpoints: checkpointIntegration.checkpoints, canMutate: checkpointIntegration.canMutate,
        acted: threadId => { void agentHost.gitActionFinished(threadId).catch(() => undefined) },
        copyPath: copyOutput, reveal: path => shell.showItemInFolder(path), emit: event => { windows.sendToMain(GIT_CHANGES_EVENT, event) } })
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
      // A folder with a shell still running in it is not reclaimed under that shell.
      if (worktreeCleanup) {
        agentHost.setWorktreeInUse(threadId => terminalService.hasRunningTerminal(threadId))
        worktreeCleanup.start()
      }
      const cleanupTools = registerToolsIpc(ipcMain, {
        terminal: terminalService,
        onTerminalFocus: focused => {
          const main = BrowserWindow.getAllWindows().find(window => window.webContents === windows.getMainWebContents())?.webContents
          if (main) { if (focused) terminalFocus.add(main); else terminalFocus.delete(main) }
        },
        browser: browserService,
        gitChanges,
        hostedGitChanges: {
          list: request => hostRouter.gitChanges(request), review: request => hostRouter.gitReview(request),
          copyPath: async request => copyHostPath(await hostRouter.gitChangesPath(request)),
        },
      }, () => windows.getTrustedRenderers())
      repaintOmarchy = () => { void settingsCoordinator.republish().catch(() => logOperational('omarchy-theme-refresh-failed')) }
      omarchyTheme.start()
      omarchySetup = platform === 'linux' ? new OmarchySetup({
        home: homedir(), data: userDataPath,
        resources: omarchyResources!,
        version: appRunningVersion,
        settings: { get: () => settingsCoordinator.getSettings(), update: patch => settingsCoordinator.updateSettings(patch) },
        // Read from the store, not the coordinator's queue: a shortcut change holds that queue's turn only to save.
        shortcuts: async () => {
          const saved = await settings.get()
          return { press: [saved.hotkey, ...saved.pressShortcuts], hold: saved.holdShortcuts }
        },
        commitShortcuts: set => settingsCoordinator.commitCompositorShortcuts(set),
        holdShortcutsEnabled: owlFeatures['dictation-hold-shortcuts'],
        onChanged: state => windows.sendToMain(OMARCHY_SETUP_CHANGED, state),
      }) : null
      const cleanupOmarchySetup = registerOmarchySetupIpc(ipcMain, platform, omarchySetup, () => windows.getTrustedRenderers(), { follow: listener => {
        const focus = (_event: unknown, window: BrowserWindow): void => { if (window.webContents === windows.getMainWebContents()) listener() }
        app.on('browser-window-focus', focus)
        return () => { app.removeListener('browser-window-focus', focus) }
      }, notify: () => windows.sendToMain(OMARCHY_SETUP_FOCUS, null) })
      // No shell restart at startup. Files changed by hand are never refreshed.
      void omarchySetup?.refreshAtStart().catch(() => undefined)
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
      const cleanupHosts = registerHostsIpc(ipcMain, desktopHosts, () => windows.getTrustedRenderers(), state => windows.sendToMain(HOSTS_CHANGED, state), hostTailscale, { opencode: !heldProviders.has('opencode') })
      const cleanupPhones = registerPhonesIpc(ipcMain, phoneAccess, () => windows.getTrustedRenderers(), state => windows.sendToMain(PHONES_CHANGED, state))
      const cleanupAgents = registerAgentIpc(ipcMain, hostRouter, hostRouter, () => windows.getTrustedRenderers(), { encodeReceipt: agentStateBroadcaster.encodeReceipt, windowRead: agentStateBroadcaster.windowRead, workingCopyOptions: projectId => { const key = parseHostEntityKey(projectId); if (key && key.hostId !== agentControl.hostId()) throw new Error('Working-copy choices are on the host machine. Use the existing project folder or create its worktree there.'); return agentHost.workingCopyOptions(key?.id ?? projectId) } })
      // An E2E run never leaves the app for System Settings.
      const systemSettingsOpener = e2eConfiguration === null ? createSystemSettingsOpener(platform, url => shell.openExternal(url)) : null
      const desktopWatcher = createWatcherRoomDesktop({ watcherEnabled, streamingPublishCost: owlFeatures['streaming-publish-cost'], machinesEnabled: crossMachineEnabled,
        watcher: localRuntime?.watcher, send: state => windows.sendToMain(WATCHER_CHANGED, state) })
      const cleanup = registerIpc(ipcMain, {
        ...(desktopWatcher ? { watcher: desktopWatcher.bridge } : {}),
        ...(interfaceLanguageEnabled ? { interfaceLanguage } : {}),
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
        dictationShortcuts: {
          replace: change => settingsCoordinator.replaceDictationShortcuts(change),
          suspend: shortcutLifecycle.suspend,
          record: shortcutLifecycle.record,
          cancelRecord: () => dictationShortcuts?.cancelRecord(),
          permission: () => dictationShortcuts?.permission() ?? (platform === 'darwin' ? 'not-needed' : 'unsupported'),
          requestPermission: async () => dictationShortcuts === null
            ? (platform === 'darwin' ? 'not-needed' : 'unsupported')
            : dictationShortcuts.requestPermission(),
        },
        app: {
          show: () => windows.showMain(),
          hide: () => windows.hideMain(),
          minimize: () => windows.minimizeMain(),
          // A reload ends the main renderer's dictation session as a crash does,
          // so the widget returns to idle instead of offering an error, or a
          // kept recording, that no controller holds any more.
          reload: () => {
            dictationLifecycle.rendererProcessGone('main')
            // A reloaded Settings can no longer end its recording, so the shortcuts come back now.
            shortcutLifecycle.rendererGone()
            return windows.reloadMain()
          },
          toggleMaximize: () => windows.toggleMaximizeMain(),
          isMaximized: () => windows.isMainMaximized(),
          quit: () => app.quit(),
        },
        trustedSenders: () => windows.getTrustedRenderers(),
        openExternalLink: url => shell.openExternal(url),
        openQuestionPage: async input => {
          const opening = hostRouter.questionPageOpening(input)
          if (!opening) return { ok: false, reason: 'gone' }
          // Opening a page reviews the prototype it belongs to (ADR-0108); this computer's host hears it here, and a remote
          // host from its own page route.
          const opened = (result: QuestionPageOpenResult): QuestionPageOpenResult => { if (result.ok) hostRouter.questionPageOpened(input); return result }
          // Web links in threads chooses the browser (ADR-0108). Sotto's browser opens a file through the phone access
          // listener; a thread with no folder for that browser opens its page in the system browser, as its links do.
          const destination = questionPageDestination(opening, (await settingsCoordinator.getSettings()).webLinkDestination, phoneAccess.pagePort())
          if (destination.browser === 'sotto' && browserService) {
            const listing = await browserService.list({ threadId: input.threadId })
            if (listing.ok) {
              const shown = await browserService.openLink({ url: destination.url, destination: 'embedded', target: { threadId: input.threadId, workspaceId: listing.value.workspace.workspaceId } })
              if (shown.ok && shown.value.page) return opened({ ok: true, page: shown.value.page })
            }
          }
          // In the system browser a file opens as a file; a loopback page and a remote host's page open at their address.
          if (opening.kind === 'url') { await shell.openExternal(opening.url); return opened({ ok: true }) }
          // The file must still be the HTML file found when the question was asked, after links are followed: openPath runs
          // whatever it is handed, so a page since replaced by a link to a program is not opened.
          const real = await realpath(opening.file).catch(() => undefined)
          if (real !== opening.file || !/\.html?$/iu.test(real) || !await stat(real).then(info => info.isFile(), () => false)) return { ok: false, reason: 'gone' }
          return await shell.openPath(real) === '' ? opened({ ok: true }) : { ok: false, reason: 'unavailable' }
        },
        ...(systemSettingsOpener === null ? {} : { openSystemSettings: systemSettingsOpener }),
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
        imageClipboard,
        transcriptPolish: {
          polish: (text, asr) => transcriptPolish.polish(text, asr),
        },
        transcription: {
          transcribe: (request) => transcription.transcribe(request),
          cancel: (requestId) => transcription.cancel(requestId),
        },
        speechModel,
        openRouterKey: {
          // Verify key stays offline in E2E runs, like the cleanup pass.
          check: () => checkOpenRouterKey({
            getSettings: () => settings.forFormatting(),
            ...(e2eConfiguration === null ? {} : { fetchFn: () => Promise.reject(new Error('E2E_NETWORK_DISABLED')) }),
          }),
          ...(cleanupModelEnabled ? {
            models: () => listOpenRouterModels(e2eConfiguration === null ? {} : { fetchFn: () => Promise.reject(new Error('E2E_NETWORK_DISABLED')) }),
          } : {}),
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
        ...(microphoneAccessWhileOn === null ? {} : { microphoneAccess: microphoneAccessWhileOn }),
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
        checkpointIntegration.dispose()
        cleanupRequestDrafts()
        cleanupFiles()
        cleanupSubagents()
        cleanupUsage()
        cleanupDelegations()
        cleanupContinue()
        cleanupMainActivity()
        cleanupNotifications()
        cleanupOpenCodeSignIn()
        worktreeCleanup?.dispose()
        cleanupTools()
        browserService = undefined
        // The quit drain already awaited this service's own dispose (ADR-0047); this just drops its IPC handlers.
        void cleanupCloudIphone()
        cloudIphoneService = undefined
        void browserAgentServer.close()
        cleanupThemes()
        cleanupOmarchySetup()
        cleanupMemory()
        unsubscribeRecoveryNotices()
        // No renderer is left to receive them, so drop what is still being transcribed.
        transcription.dispose()
        speechModelManager?.dispose()
        updates.dispose()
        desktopWatcher?.dispose()
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
      ipcMain.handle(E2E_VISUAL_TOOL_CHANNEL, (event, payload: unknown) => {
        if (!isAuthorizedIpcSender(event, windows.getTrustedRenderers(), ['main'])) throw new Error('E2E_SENDER_REJECTED')
        const request = e2eVisualToolSchema.parse(payload)
        // The window names a thread by its host-qualified ID; the tool hears the Sotto thread, as a provider's call does.
        return visualTools.call(parseHostEntityKey(request.threadId)?.id ?? request.threadId, VISUALIZE_TOOL, request.arguments)
      })
      ipcMain.handle(E2E_DELEGATION_TOOL_CHANNEL, (event, payload: unknown) => {
        if (!isAuthorizedIpcSender(event, windows.getTrustedRenderers(), ['main'])) throw new Error('E2E_SENDER_REJECTED')
        const request = e2eDelegationToolSchema.parse(payload)
        if (!delegationTools) throw new Error('Delegation is off in this build.')
        // As a provider's call does, the tool hears the Sotto thread, never the window's host-qualified ID.
        return delegationTools.call(parseHostEntityKey(request.threadId)?.id ?? request.threadId, request.name, request.arguments)
      })
      ipcMain.handle(AGENT_E2E, (event, payload: unknown) => {
        if (!isTrustedMainE2ESender(event.sender, windows.getTrustedRenderers())) throw new Error('E2E_SENDER_REJECTED')
        const parsed = e2eAgentEventSchema.parse(payload)
        testAgentHost?.event(parsed)
      })
      const observedCertifiedDetails = new Map<string, readonly AgentActivity[]>()
      ipcMain.handle(E2E_SNAPSHOT_CHANNEL, (event) => {
        if (!isTrustedMainE2ESender(event.sender, windows.getTrustedRenderers())) {
          throw new Error('E2E_SENDER_REJECTED')
        }
        let certifiedDetail: { trackedThreads: number; ownedThreads: number; reusedRecords: number } | undefined
        if (nativeFixtureRoot && process.env['SOTTO_E2E_CERTIFIED_DETAIL_OBSERVATION'] === '1') {
          // The native test observes the real private tracker, never a renderer copy or a fixture
          // certificate. No production accessor or diagnostic channel is introduced.
          const tracked = (agentControl as unknown as { certifiedDetailRevisions: ReadonlyMap<string, { activities: readonly AgentActivity[] }> }).certifiedDetailRevisions
          let ownedThreads = 0, reusedRecords = 0
          for (const [threadId, detail] of tracked) {
            if (isImmutableActivities(detail.activities)) ownedThreads++
            const previous = new Set(observedCertifiedDetails.get(threadId))
            reusedRecords += detail.activities.filter(record => previous.has(record)).length
            observedCertifiedDetails.set(threadId, detail.activities)
          }
          for (const id of observedCertifiedDetails.keys()) if (!tracked.has(id)) observedCertifiedDetails.delete(id)
          certifiedDetail = { trackedThreads: tracked.size, ownedThreads, reusedRecords }
        }
        return { ...snapshotE2EState(
          e2eState,
          BrowserWindow.getAllWindows().some((candidate) => candidate.getTitle() === buildName && candidate.isVisible()),
        ), openedThreadFolder, openedExternalLink, ...(certifiedDetail ? { certifiedDetail } : {}) }
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
      menuBarOwl?.dispose()
      nativeTray.destroy()
    } catch {
      // Startup will report one finite failure even if native tray cleanup also fails.
    }
    throw new NativeTrayCreationError()
  }
}

protocol.registerSchemesAsPrivileged([VISUAL_SCHEME_PRIVILEGES])
enableWasmThreadSupport(app.commandLine)
disableDnsPrefetching(app.commandLine)
configurePasswordStore(platform, app.commandLine, process.env.XDG_CURRENT_DESKTOP)
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
