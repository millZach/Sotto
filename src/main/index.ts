import { DevinAcpHost } from './agents/devin'
import { PersonalChatService } from './agents/personalChats'
import { ChatPromptService } from './agents/chatPrompts'
import { registerChatPromptIpc } from './agents/chatPromptIpc'
import { connectCheckpoints } from './tools/checkpointIntegration'
import { RequestDraftService, personalRequestDraftState } from './agents/requestDrafts'
import { registerRequestDraftIpc } from './agents/requestDraftIpc'
import { isThreadProviderConnected } from '../shared/agents'
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
import { ShortTextWriter } from './llm/shortTextWriter'
import { threadTitleWriter } from './llm/threadTitle'
import { threadBranchWriter } from './llm/threadBranch'
import { pullRequestTextWriter } from './llm/pullRequestText'
import { commitMessageWriter } from './llm/commitMessage'
import { OpenRouterTranscriptionService } from './asr/openRouterTranscriptionService'
import { createElectronUpdaterAdapter } from './updates/electronUpdaterAdapter'
import { UpdateService } from './updates/updateService'
import { platformProfile, type WidgetAlwaysOnTopLevel } from './platformProfile'
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
import { enableWasmThreadSupport } from './security'
import {
  loadVerifiedRuntimeSource,
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
import { E2E_SNAPSHOT_CHANNEL, E2E_TRIGGER_SHORTCUT_CHANNEL, E2E_BROWSER_AGENT_CHANNEL, e2eBrowserAgentSchema, e2eAgentEventSchema } from '../shared/e2e'
import { AGENT_STATE, AGENT_E2E, AGENT_THREAD_DETAIL } from '../shared/agents'
import { AgentCredentials } from './agents/credentials'
import { SecureSettings } from './agents/secureSettings'
import { CodexAppServerHost } from './agents/codex'
import { ClaudeStreamJsonHost } from './agents/claude'
import { GrokAcpHost } from './agents/grok'
import { ConfiguredProviderHost } from './agents/providerSwitch'
import { WorkspaceHost } from './agents/workspace'
import { registerSubagentIpc } from './agents/subagentIpc'
import { SUBAGENTS_CHANGED } from '../shared/subagents'
import { SottoThreadHost, ThreadRegistry } from './agents/threads'
import { AgentControl, coalesceAgentStatePublishes, coalesceAgentThreadDetailPublishes } from './agents/control'
import { TurnRecorder } from './agents/turns'
import { ConfiguredAgentReasoner } from './agents/reasoning'
import { ClaudeSubscriptionClient } from './agents/subscriptionClaude'
import { GrokSubscriptionClient } from './agents/subscriptionGrok'
import { CodexSubscriptionClient } from './agents/subscriptionCodex'
import { AgentMembershipClient } from './agents/membership'
import { registerAgentIpc } from './agents/ipc'
import { LocalHostService, type HostService } from './agents/hostService'
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
import { TERMINAL_EVENT } from '../shared/terminal'
import { TERMINALS_EVENT } from '../shared/terminalWorkspace'
import { TerminalWorkspaceService } from './terminals/service'
import { registerTerminalWorkspaceIpc } from './terminals/ipc'
import { TERMINAL_WORKTREE_HOME, ThreadWorktrees, runWorktreeGit } from './agents/threadWorktrees'
import { WorktreeCleanup, githubPullRequestMerged } from './agents/worktreeCleanup'
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

const memoryProbeMode = process.env.SOTTO_MEMORY_PROBE === '1'
const e2eConfiguration = resolveE2EConfiguration(app.isPackaged, process.env)
if (memoryProbeMode) {
  const directory = process.env.SOTTO_MEMORY_PROBE_USER_DATA
  if (!directory || !isAbsolute(directory)) {
    console.error('[Sotto] memory-store-probe-profile-invalid')
    app.exit(1)
    throw new Error('Memory probe requires an absolute isolated user-data directory')
  }
  app.setPath('userData', directory)
} else if (e2eConfiguration === null) {
  delete process.env.SOTTO_E2E
  delete process.env.SOTTO_E2E_SCENARIO
  delete process.env.SOTTO_E2E_USER_DATA
  migrateLegacyUserData(app.getPath('userData'))
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
  | 'checkpoint-unavailable'
  | 'worktree-cleanup-reclaimed'
  | 'worktree-cleanup-skipped'

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
    event: 'close' | 'closed' | 'moved' | 'maximize' | 'unmaximize',
    listener: (event: { preventDefault(): void }) => void,
  ): void {
    if (event === 'close') {
      const wrapped = (nativeEvent: { preventDefault(): void }): void => listener(nativeEvent)
      this.window.on('close', wrapped)
      this.windowListenerCleanups.set(listener, () => this.window.removeListener('close', wrapped))
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
    _event: 'close' | 'closed' | 'moved' | 'maximize' | 'unmaximize',
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
  const userDataPath = app.getPath('userData')
  const memoryStore = openRuntimeMemory(join(userDataPath, 'memory.sqlite'), logOperational)
  const memoryProfile = memoryStore === undefined ? undefined : new MemoryProfile(memoryStore)
  const authority = memoryStore === undefined ? undefined : new PolicyStore(memoryStore)
  app.on('will-quit', () => memoryStore?.close())
  const naturalSpeechModels = new NaturalSpeechModels(join(userDataPath, 'models'))
  const resourceRoot = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources')
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
  )
  const credentials = new AgentCredentials(userDataPath, safeStorage)
  await credentials.load()
  const grokSpeech = new GrokSpeechService({ credentials, ...(e2eConfiguration === null ? {} : { fetchFn: e2eGrokSpeechFetch }) })
  const kokoroSpeech = new KokoroSpeechService({ credentials, ...(e2eConfiguration === null ? {} : { fetchFn: e2eKokoroSpeechFetch }) })
  const settings = new SecureSettings(plainSettings, credentials)
  await settings.migrate().catch(() => logOperational('secure-key-migration-unavailable'))
  const startupSettings = await settings.get()
  let agentHistoryEnabled = startupSettings.historyEnabled
  let workingCopySettings = startupSettings
  // Two beta gates the renderer hides surfaces behind; main keeps their promise. With the voice coordinator
  // off no thread stays managed across a start, and with memory off no turn retrieves preferences.
  let agentVoiceCoordinatorEnabled = startupSettings.voiceCoordinatorEnabled
  const agentMemoryEnabled = startupSettings.memoryEnabled
  // Sotto's own short writing: thread titles, commit message drafts and pull request drafts.
  // E2E runs never reach the network, so every title there resolves to the stand-in name.
  const shortTextWriter = new ShortTextWriter({
    getSettings: () => settings.forFormatting(),
    onFailure: failure => { console.error(`[Sotto] writing-model-failed ${failure.purpose} ${failure.reason}`) },
    ...(e2eConfiguration === null ? {} : { fetchFn: () => Promise.reject(new Error('E2E_NETWORK_DISABLED')) }),
  })
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
  })
  // This explicit development-only path drives the real adapter through a scripted ACP child.
  const devinFixtureRoot = e2eConfiguration !== null && !app.isPackaged ? process.env['SOTTO_E2E_DEVIN_ROOT'] : undefined
  const devinFixtureExecutable = process.env['SOTTO_E2E_DEVIN_EXECUTABLE']
  if (devinFixtureRoot && (!isAbsolute(devinFixtureRoot) || !devinFixtureExecutable || !isAbsolute(devinFixtureExecutable))) {
    throw new Error('The Devin test fixture requires absolute paths.')
  }
  const testAgentHost = e2eConfiguration === null || devinFixtureRoot ? null : new E2EAgentHost(e2eConfiguration.scenario)
  // Static design fixtures include deliberately unavailable folders. Interactive E2E
  // journeys need real, profile-owned folders and exercise the production cwd checks.
  if (testAgentHost !== null && process.env['SOTTO_DESIGN_CAPTURE'] !== '1') {
    await testAgentHost.initializeWorkingFolders(join(userDataPath, 'agent-workspaces'))
  }
  const threadRegistry = testAgentHost === null ? new ThreadRegistry(userDataPath) : null
  const agentHost = new WorkspaceHost(testAgentHost ?? new ConfiguredProviderHost({
    directory: userDataPath,
    hosts: {
      codex: new SottoThreadHost('codex', devinFixtureRoot ? new E2EAgentHost() : new CodexAppServerHost({ userDataPath }), threadRegistry!),
      claude: new SottoThreadHost('claude', devinFixtureRoot ? new E2EAgentHost() : new ClaudeStreamJsonHost({ userDataPath }), threadRegistry!),
      grok: new SottoThreadHost('grok', devinFixtureRoot ? new E2EAgentHost() : new GrokAcpHost(userDataPath), threadRegistry!),
      devin: new SottoThreadHost('devin', new DevinAcpHost(userDataPath, devinFixtureRoot ? {
        executable: devinFixtureExecutable!, args: [join(__dirname, '../../tests/fixtures/fakeDevinAgent.mjs'), devinFixtureRoot],
        nativeConfigDirectory: join(devinFixtureRoot, 'native-config'), pollIntervalMs: 50,
      } : {}), threadRegistry!),
    },
    provider: () => agentControl.configuration().provider,
    enabledProviders: () => { const configuration = agentControl.configuration(); return configuration.enabledProviders ?? [configuration.provider] },
    threadProvider: threadId => threadRegistry?.byThread(threadId)?.provider,
  }), userDataPath, () => agentHistoryEnabled)
  let browserService: BrowserService | undefined
  const browserAgentServer = createBrowserAgentServer(() => browserService)
  agentHost.useBrowserTools(browserAgentServer)
  agentHost.setWorkingCopyDefaults(projectId => workingCopySettings.projectThreadWorkingCopyDefaults[projectId] ?? workingCopySettings.threadWorkingCopyDefault)
  agentHost.setBranchNameWriter(threadBranchWriter(shortTextWriter, () => settings.forFormatting()))
  // Reclaims worktrees only under the rules the user turned on (ADR-0019); every rule starts off.
  const worktreeCleanup = new WorktreeCleanup({
    host: agentHost, rules: () => workingCopySettings.worktreeCleanup,
    ...(e2eConfiguration === null ? { pullRequestMerged: githubPullRequestMerged } : {}),
    log: code => { logOperational(code) },
  })
  const turns = new TurnRecorder({
    directory: userDataPath,
    historyEnabled: () => agentHistoryEnabled,
    resolveSession: id => {
      const binding = threadRegistry?.byThread(id)
      return binding ? { provider: binding.provider, sessionId: binding.sessionId } : undefined
    },
  })
  const membership = new AgentMembershipClient({
    configuration: () => agentControl.configuration(),
    credentials, directory: userDataPath, openExternal: url => shell.openExternal(url),
  })
  let openedThreadFolder: string | null = null
  const agentControl: AgentControl = new AgentControl({
    openThreadFolder: async path => {
      if (e2eConfiguration !== null) { openedThreadFolder = path; return }
      const error = await shell.openPath(path); if (error) throw new Error(error)
    },
    directory: userDataPath, host: agentHost, credentials, membership,
    ...(authority === undefined ? {} : { authority }),
    ...(memoryProfile === undefined || !agentMemoryEnabled ? {} : { preferences: memoryProfile }),
    historyEnabled: () => agentHistoryEnabled, coordinatorEnabled: () => agentVoiceCoordinatorEnabled,
    writeThreadTitle: threadTitleWriter(shortTextWriter, () => settings.forFormatting()),
    logFailure: (code, detail) => { console.error(`[Sotto] ${code} ${detail}`) },
    bindRequestDraftDecision: (target, decisionId, answers) => requestDrafts.bindDecision(target, decisionId, answers),
    turns,
    reasoner: e2eConfiguration === null ? new ConfiguredAgentReasoner(() => agentControl.configuration(), credentials, {
      claude: new ClaudeSubscriptionClient(join(userDataPath, 'reasoning', 'claude')),
      codex: new CodexSubscriptionClient(join(userDataPath, 'reasoning', 'codex')),
      grok: new GrokSubscriptionClient(join(userDataPath, 'reasoning', 'grok')),
    }) : e2eAgentReasoner,
  })
  await agentControl.start()
  // The host's own boundary: what a client may use, and nothing else (ADR-0016). Today the only client
  // is this app's window over IPC, so the only transport is the preload bridge.
  const hostService: HostService = new LocalHostService({ control: agentControl, events: agentHost })
  const testPersonalChatHosts = e2eConfiguration ? {
    codex: new E2EPersonalChatHost(userDataPath), claude: new E2EPersonalChatHost(userDataPath, 'claude'), grok: new E2EPersonalChatHost(userDataPath, 'grok'),
  } : undefined
  const personalChats = new PersonalChatService({ userDataPath, bindRequestDraftDecision: (target, decisionId, answers) => requestDrafts.bindDecision(target, decisionId, answers), configuration: () => agentControl.configuration(),
    ...(memoryProfile && agentMemoryEnabled ? { preferences: memoryProfile } : {}), historyEnabled: () => agentHistoryEnabled,
    ...(testPersonalChatHosts ? { hosts: testPersonalChatHosts } : {}) })
  await personalChats.start()
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
    const state = agentControl.shell(), thread = state.host.threads.find(item => item.id === owner.ownerId
      && requestDraftProvider(state.host, item, state.configuration.provider) === owner.providerId)
    const recovery = agentControl.requestAnswerRecovery(owner.ownerId, owner.providerId)
    return thread ? { connected: isThreadProviderConnected(state.host, thread), ready: thread.historyStatus !== 'loading' && thread.historyStatus !== 'error',
      requests: thread.requests, ...recovery } : recovery.completed.length ? { connected: false, ready: false, requests: [], ...recovery } : undefined
  }, async owner => {
    if (owner.kind === 'personal') await personalChats.refresh(owner.ownerId)
    else await agentControl.refreshRequestDraft(owner.ownerId)
  })
  await requestDrafts.start()
  await requestDrafts.reconcile().catch(() => undefined)
  const reconcileRequestDrafts = (): void => { void requestDrafts.reconcile().catch(() => undefined) }
  const unsubscribePersonalChats = personalChats.subscribe(state => { reconcileRequestDrafts(); windows.sendToMain(PERSONAL_CHAT_STATE, state) })
  app.on('will-quit', () => { unsubscribePersonalChats(); void personalChats.close() })
  // The shell reaches both windows; the widget draws a thread's state, never its history, so it needs
  // nothing more. Only the threads the main window has declared viewed receive their messages.
  const agentStatePublisher = coalesceAgentStatePublishes(state => {
    reconcileRequestDrafts()
    personalChats.configurationChanged()
    windows.sendToMain(AGENT_STATE, state)
    windows.sendToWidget(AGENT_STATE, state)
    if (state.configuration.enabled) void windows.showWidget().catch(() => undefined)
  })
  const agentDetailPublisher = coalesceAgentThreadDetailPublishes(detail => windows.sendToMain(AGENT_THREAD_DETAIL, detail))
  const unsubscribeAgents = agentControl.subscribe(state => agentStatePublisher.publish(state))
  const unsubscribeAgentDetail = agentControl.subscribeThreadDetail(detail => agentDetailPublisher.publish(detail))
  // Quitting drops the held state with its timer: the windows it would reach are going away.
  app.on('will-quit', () => { unsubscribeAgents(); unsubscribeAgentDetail(); agentStatePublisher.dispose(); agentDetailPublisher.dispose(); agentControl.dispose(); agentHost.dispose() })
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
  const runtimeSource = e2eConfiguration === null
    ? await loadVerifiedRuntimeSource(join(resourceRoot, 'runtime'))
    : null
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
    clipboard: e2eState === null ? clipboard : createE2EClipboard(e2eState),
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
      workingCopySettings = settings
      worktreeCleanup.settingsChanged()
      agentHistoryEnabled = settings.historyEnabled
      agentVoiceCoordinatorEnabled = settings.voiceCoordinatorEnabled
      await agentControl.privacyChanged()
      await personalChats.privacyChanged()
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
      const cleanupChatPrompts = registerChatPromptIpc(ipcMain, chatPrompts, () => windows.getTrustedRenderers(), text => clipboard.writeText(text))
      const cleanupRequestDrafts = registerRequestDraftIpc(ipcMain, requestDrafts, () => windows.getTrustedRenderers())
      const files = new FilesService({
        resolveBinding: threadId => agentControl.filesBinding(threadId),
        copyPath: path => clipboard.writeText(path),
        reveal: path => shell.showItemInFolder(path),
      })
      const cleanupFiles = registerFilesIpc(ipcMain, files, () => windows.getTrustedRenderers())
      const cleanupSubagents = registerSubagentIpc(ipcMain, agentHost, () => windows.getTrustedRenderers(), change => windows.sendToMain(SUBAGENTS_CHANGED, change))
      const checkpointIntegration = connectCheckpoints({ files, directory: userDataPath, host: agentHost, control: agentControl, registry: threadRegistry,
        git: () => gitChanges, report: () => { logOperational('checkpoint-unavailable') } })
      const gitChanges = new GitChangesService({ files, checkpoints: checkpointIntegration.checkpoints, canMutate: checkpointIntegration.canMutate,
        draftPullRequestText: pullRequestTextWriter(shortTextWriter, () => settings.forFormatting()),
        writeCommitMessage: commitMessageWriter(shortTextWriter, () => settings.forFormatting()),
        copyPath: path => clipboard.writeText(path), reveal: path => shell.showItemInFolder(path), emit: event => { windows.sendToMain(GIT_CHANGES_EVENT, event) } })
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
      })
      const terminalService = new TerminalService({ files, directory: userDataPath, emit: event => { windows.sendToMain(TERMINAL_EVENT, event) } })
      // A folder with a shell still running in it is not reclaimed under that shell.
      agentHost.setWorktreeInUse(threadId => terminalService.hasRunningTerminal(threadId))
      worktreeCleanup.start()
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
      const cleanupAgents = registerAgentIpc(ipcMain, agentControl, hostService, () => windows.getTrustedRenderers(), platform, e2eConfiguration === null ? naturalSpeechModels : {
        status: async () => ({ ready: true, completedBytes: 1, totalBytes: 1 }),
        download: async () => ({ ready: true, completedBytes: 1, totalBytes: 1 }),
      }, grokSpeech, kokoroSpeech, projectId => agentHost.workingCopyOptions(projectId))
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
        cleanupPersonalChats()
        cleanupChatPrompts()
        checkpointIntegration.dispose()
        cleanupRequestDrafts()
        cleanupFiles()
        cleanupSubagents()
        cleanupTerminals()
        worktreeCleanup.dispose()
        cleanupTools()
        browserService = undefined
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
        ), openedThreadFolder }
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

if (memoryProbeMode) {
  // Wait for the verifier to attach stdout/exit listeners before running. This
  // handshake avoids racing Playwright's main-process debugger attachment.
  const timeout = setTimeout(() => app.exit(1), 60_000)
  void app.whenReady().then(() => {
    app.once('before-quit', (event) => {
      event.preventDefault()
      clearTimeout(timeout)
      try {
        const evidence = probeMemoryStore(join(app.getPath('userData'), 'memory.sqlite'))
        process.stdout.write(`${JSON.stringify(evidence)}\n`, () => app.exit(0))
      } catch (error) {
        console.error('[Sotto] memory-store-probe-failed', error)
        app.exit(1)
      }
    })
  })
} else {
  void bootstrapSotto({ app, initialize: createRuntime, log: logOperational }).catch(() => {
    logOperational('bootstrap-terminal-failed')
    app.quit()
  })
}
