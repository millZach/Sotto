import type { AgentCommand, AgentState, AgentThread, AgentThreadDetailUpdate, AgentThreadMediaPartRequest } from '../../shared/agents'
import type { NotificationOpening, ThreadAlert } from '../../shared/desktopNotifications'
import type { HostBrowserThreadRequest } from '../../shared/hostBrowser'
import type { OwlFeatureStates } from '../../shared/owlFeatures'
import type { OwnCleanupChoice } from '../../shared/ownServerCleanup'
import type { SottoPlatform } from '../../shared/platform'
import type { QuestionPageOpen } from '../../shared/questionPageOpen'
import type { RecoveryNotice } from '../../shared/recoveryNotice'
import type { AppSettings } from '../../shared/settings'
import type { ToolsResult } from '../../shared/tools'
import type { BrowserAgentTools } from '../agents/browserAgentServer'
import type { MainLoopReading } from '../../shared/mainActivity'
import type { ProfilerTarget } from '../performance/activityRecorder'
import type { AgentCredentials, CredentialSnapshot } from '../agents/credentials'
import type { ClientIdentity } from '../agents/hostService'
import type { ThreadVideoPart } from '../agents/threadMediaScheme'
import type { RoomBridge } from '../agents/watcherRoomDesktop'
import type { AgentVisual } from '../../shared/visuals'
import type { FilesBinding } from '../files/service'
import type { QuestionPageOpening } from '../hosts/desktopHostRouter'
import type { HostThreadFolders } from '../hosts/hostedTerminals'
import type { SshTerminalHost } from '../hosts/sshTerminal'
import type { OwnCleanupResolution } from '../llm/ownServerCleanup'
import type { PRODUCT_EVENT_FEATURES } from '../productEvents/schema'
import type { E2EConfiguration } from '../e2e/e2eBoundary'

export type ProductEventFeature = typeof PRODUCT_EVENT_FEATURES[number]

export type EngineIpcRole = 'main' | 'popup'

/** Incremental update to the shell's cached folder and title lookup tables (ADR-0210). */
export interface FilesBindingsDelta {
  readonly reset?: boolean
  readonly bindings?: Readonly<Record<string, FilesBinding | null>>
  readonly projectFolders?: Readonly<Record<string, string | null>>
  readonly threadTitles?: Readonly<Record<string, string | null>>
  readonly hostedFolders?: Readonly<Record<string, HostThreadFolders | null>>
  readonly terminalHosts?: Readonly<Record<string, SshTerminalHost | null>>
}

/**
 * The small, language-neutral reverse-RPC surface the desktop engine asks of the Electron shell (ADR-0210).
 * Every method maps to a real OS or Electron UI capability; nothing here leaks Electron types into `src/main/engine/`.
 */
export interface EngineShellBridge {
  openExternal(url: string): Promise<void>
  openPath(path: string): Promise<string>
  revealInFolder(path: string): void
  clipboardWrite(text: string): Promise<void>
  readonly credentials: Pick<AgentCredentials, 'available' | 'has' | 'get' | 'set' | 'sealed' | 'restoreSealed'> & {
    exportSnapshot?: () => CredentialSnapshot
    subscribe?: (listener: () => void) => () => void
  }
  readonly browserTools: BrowserAgentTools
  readonly endHostTerminals: (hostId: string) => Promise<void>
  sendToMain(channel: string, payload: unknown): boolean
  sendToPopup(channel: string, payload: unknown): void
  notify?(alert: ThreadAlert): void
  publishRecoveryNotice(notice: RecoveryNotice): void
  onFilesBindingsDelta(delta: FilesBindingsDelta): void
  onRestartHoldChanged?(reason: string | undefined): void
  relaunchApp(): void
  downloadsFolder(): string
  log(code: string): void
  readWritingSettings(): Promise<AppSettings>
  onE2EFileAction?(kind: 'open' | 'show', path: string): void
  onE2EExternalLink?(url: string): void
  onE2EThreadFolder?(path: string): void
  /** Optional shell thumbnail maker (`nativeImage`) for PNG/JPEG/GIF/WebP parity (ADR-0210). */
  mediaThumbnail?(dataUrl: string, scale: number): string | null | Promise<string | null>
  /** Optional shell photo redraw (`nativeImage`) so interlaced PNGs and large photos match in-process behavior. */
  redrawPhoto?(bytes: Buffer, kind: 'image/jpeg' | 'image/png'): Promise<{ readonly bytes: Buffer; readonly kind: 'image/jpeg' | 'image/png' } | null>
  /** Called in-process when `browserTools` receives a host-setup or other E2E hook. */
  onPopupObserved?(threadIds: readonly string[]): void
}

export interface DesktopEngineOptions {
  readonly userDataPath: string
  readonly appRunningVersion: string
  readonly appVersion: string
  readonly isPackaged: boolean
  readonly platform: SottoPlatform
  readonly owlFeatures: OwlFeatureStates
  readonly startupSettings: AppSettings
  readonly phoneCompression: boolean
  readonly desktopNotificationsEnabled: boolean
  readonly e2eConfiguration: E2EConfiguration | null
  readonly claudeHistoryModulePath?: string | undefined
  readonly pictureWorkerPath?: string | undefined
  readonly env: Readonly<Record<string, string | undefined>>
  readonly interfaceLanguage?: {
    readonly enabled: boolean
    readonly systemLanguages: readonly string[]
    readonly override?: string | undefined
  } | undefined
}

export interface EngineMetadata {
  readonly localHostId: string | undefined
  readonly hasOwnServers: boolean
  readonly hasOwnServerCleanup: boolean
  readonly hasCouncil: boolean
  readonly hasWatcher: boolean
  readonly keepMainCurrentEnabled: boolean
}

export interface EngineWindowFocus {
  readonly focused: boolean
  readonly showing: boolean
  readonly blurredAt: number
}

export interface EngineTurnRecordsInfo {
  readonly path: string
  readonly recentCount: number
}

export interface EngineCertifiedDetailStats {
  readonly trackedThreads: number
  readonly ownedThreads: number
  readonly reusedRecords: number
}

export type GitChangesMethod =
  | 'list'
  | 'review'
  | 'copyPath'
  | 'reveal'
  | 'watch'
  | 'checkpoints'
  | 'inspectCheckpoint'
  | 'revertCheckpoint'
  | 'recoverCheckpoint'

export type HostedGitChangesMethod = 'list' | 'review' | 'copyPath'

/**
 * The Electron-free desktop engine boundary (ADR-0210).
 * In Phase 1 this runs in-process behind `createDesktopEngine`; in Phase 2 the same surface runs over `EngineTransport`.
 */
export interface DesktopEngine {
  readonly metadata: EngineMetadata
  /** Registered engine IPC channels relayed verbatim by the shell's `ipcMain` listener. */
  channels(): readonly string[]
  invokeIpc(channel: string, role: EngineIpcRole, args: readonly unknown[]): Promise<unknown>
  /** Watcher IPC bridge for `registerIpc` (kept separate because `registerIpc` owns Watcher channels). */
  readonly watcherBridge?: RoomBridge | undefined

  setWindowFocus(state: EngineWindowFocus): void
  setPopupShown(shown: boolean): void
  setPopupObserved(threadIds: readonly string[]): void
  setRunningTerminals(threadIds: readonly string[]): void
  acquireTerminalStart(workingDirectory: string): Promise<string>
  releaseTerminalStart(leaseId: string): void

  onSettingsChanged(settings: AppSettings, previous: AppSettings): Promise<void>
  cleanSettingsHistory(afterClean: () => Promise<void>): Promise<void>
  onInterfaceLanguageChanged(settings: AppSettings): Promise<void>
  onAppUpdatePhaseChanged(waitingHostVersion: string | undefined): void
  checkClientsAfresh(): void
  restartHold(): string | undefined
  featureUsed(feature: ProductEventFeature): void

  readVisual(threadId: string, visualId: string): Promise<AgentVisual | undefined>
  threadMediaPart(part: AgentThreadMediaPartRequest): Promise<ThreadVideoPart | null>
  resolveOwnCleanupServer(choice: OwnCleanupChoice): Promise<OwnCleanupResolution>
  questionPageOpening(input: QuestionPageOpen): QuestionPageOpening | null | Promise<QuestionPageOpening | null>
  questionPageOpened(input: QuestionPageOpen): void | Promise<void>
  phoneAccessPagePort(): number | null | Promise<number | null>
  openNotificationThread(threadId: string): Promise<NotificationOpening>
  popupCommand(command: AgentCommand, client: ClientIdentity): Promise<AgentState>
  gitChangesCall(method: GitChangesMethod, payload: unknown): Promise<unknown>
  hostedGitChangesCall(method: HostedGitChangesMethod, payload: unknown): Promise<ToolsResult<unknown>>
  hostedBrowserCall(request: HostBrowserThreadRequest): Promise<ToolsResult<unknown>>
  hostedBrowserAddress(hostId: string): string | undefined | Promise<string | undefined>
  turnRecordsInfo(): Promise<EngineTurnRecordsInfo>

  // E2E-only hooks (inert in packaged builds).
  e2eAgentEvent(payload: unknown): void | Promise<void>
  e2eCertifiedDetailObservation(): EngineCertifiedDetailStats | undefined | Promise<EngineCertifiedDetailStats | undefined>

  // Out-of-process engine performance telemetry (ADR-0098, ADR-0210).
  engineProfiler?(): ProfilerTarget
  engineLoopReading?(): Promise<Omit<MainLoopReading, 'frozen'> | null>
  /** Resets incremental window broadcast tracking after a missed main-window push. */
  resetWindowBroadcast?(): void

  prepareForShutdown(): void
  disposeIpc(): void
  close(): Promise<void>
}

export type PopupFeedPush =
  | { readonly kind: 'thread'; readonly thread: AgentThread }
  | { readonly kind: 'detail'; readonly detail: AgentThreadDetailUpdate }
