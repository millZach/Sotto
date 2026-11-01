import { z } from 'zod'
import { WATCHER_GET, WATCHER_OPEN, WATCHER_PREPARE_STOP_ALL, WATCHER_STOP_ALL, WATCHER_SET_PERMISSION, WATCHER_WATCH_THREAD, WATCHER_UNWATCH_THREAD,
  WATCHER_READ_HANDOVER, WATCHER_CONTINUE_HANDOVER, WATCHER_DISMISS_HANDOVER, WATCHER_START_NEW, WATCHER_READ_MACHINES, watcherContinueHandoverRequestSchema,
  watcherOpenRequestSchema, watcherStopAllRequestSchema, watcherSetPermissionRequestSchema, watcherWatchThreadRequestSchema, type WatcherBridge } from '../../shared/watcherRoom'
import { externalLinkSchema } from '../../shared/externalLinks'
import { questionPageOpenSchema, type QuestionPageOpen, type QuestionPageOpenResult } from '../../shared/questionPageOpen'
import { systemSettingsPaneSchema, type SystemSettingsPane } from '../../shared/systemSettings'

import {
  APP_HIDE,
  APP_MINIMIZE,
  APP_RELOAD,
  APP_TOGGLE_MAXIMIZE,
  APP_MAXIMIZED,
  APP_QUIT,
  APP_SHOW,
  EXTERNAL_LINK_OPEN,
  QUESTION_PAGE_OPEN,
  SYSTEM_SETTINGS_OPEN,
  DICTATION_REQUEST,
  DICTATION_RECORD_GET,
  DICTATION_RECORDS_LIST,
  HISTORY_ADD,
  HISTORY_CLEAR,
  HISTORY_DELETE,
  HISTORY_LIST,
  HISTORY_SEARCH,
  HOTKEY_GET,
  HOTKEY_REPLACE,
  DICTATION_SHORTCUTS_REPLACE,
  DICTATION_SHORTCUTS_SUSPEND,
  DICTATION_KEYS_RECORD,
  DICTATION_KEYS_RECORD_CANCEL,
  KEY_LISTENER_PERMISSION_GET,
  KEY_LISTENER_PERMISSION_REQUEST,
  OUTPUT_COPY_IMAGE,
  OUTPUT_DELIVER,
  RECOVERY_NOTICE_LIST,
  PASTE_PERMISSION_NOTICE_DISMISS,
  TRANSCRIPTION_CANCEL,
  SPEECH_MODEL_GET_STATUS,
  SPEECH_MODEL_CHOOSE,
  SPEECH_MODEL_DOWNLOAD,
  SPEECH_MODEL_LIST,
  OPENROUTER_CHECK_KEY,
  OPENROUTER_LIST_MODELS,
  OPENROUTER_LIST_SPEECH_MODELS,
  TRANSCRIPTION_TRANSCRIBE,
  MICROPHONE_ENSURE_ACCESS,
  TRANSCRIPT_POLISH,
  SETTINGS_GET,
  SETTINGS_RESET,
  SETTINGS_UPDATE,
  STARTUP_GET,
  STARTUP_SET,
  UPDATE_CHECK,
  UPDATE_DOWNLOAD,
  UPDATE_GET_STATUS,
  UPDATE_INSTALL,
  WIDGET_DRAG,
  WIDGET_PRESENTATION,
  WIDGET_PUBLISH,
} from '../../shared/channels'
import {
  dictationCommandSchema,
  outputDeliveryRequestSchema,
  outputImageRequestSchema,
  transcriptionRequestSchema,
  transcriptPolishRequestSchema,
  widgetDragSchema,
  widgetPresentationPayloadSchema,
  widgetSnapshotSchema,
  type CommandResult,
  type DictationCommand,
  type DictationShortcutsChange,
  type DictationShortcutsResult,
  type HotkeyChangeResult,
  type KeyListenerPermission,
  type KeyRecordResult,
  type OutputOutcome,
  type OutputDeliveryRequest,
  type OutputResult,
  type OpenRouterKeyCheck,
  type OpenRouterModelList,
  type CloudSpeechModelList,
  type TranscriptionRequest,
  type TranscriptionResult,
  type StartupState,
  type TranscriptPolishAsrContext,
  type UpdateStatus,
  type TranscriptPolishResult,
  type WidgetDragPayload,
  type WidgetPresentationPayload,
} from '../../shared/contracts'
import { speechModelIdSchema, type SpeechModelOption, type SpeechModelStatus } from '../../shared/speechModel'
import { finishedDictationSchema, type HistoryEntry } from '../../shared/history'
import type { DictationRecord } from '../../shared/dictationRecord'
import {
  settingsSchema,
  worktreeCleanupRulesSchema,
  type AppSettings,
  type SettingsPatch,
} from '../../shared/settings'
import type { RendererRole } from '../security'
import { pastePermissionNoticeCodeSchema, type PastePermissionNoticeCode, type RecoveryNotice } from '../../shared/recoveryNotice'
import { OMARCHY_THEME_ID } from '../../shared/themes/omarchy'
import { INTERFACE_LANGUAGE_GET } from '../../shared/interfaceLanguageBridge'
import type { InterfaceLanguageState } from '../../shared/interfaceLanguages'

const noPayloadSchema = z.undefined()
const settingKeys = [
  'version',
  'theme',
  'appearance',
  'lightTheme',
  'darkTheme',
  'appearanceContrast',
  'effortColor',
  'menuBarOwlBody',
  'menuBarOwlEyes',
  'watcherScene',
  'composerStyle',
  'creature',
  'showCreature',
  'interfaceLanguage',
  'customThemes',
  'reducedMotion',
  'clickEffect',
  'roomTransition',
  'roomTransitionSpeed',
  'roomTransitionLook',
  'terminalFontSize',
  'threadShortcuts',
  'microphoneId',
  'maxRecordingSeconds',
  'soundCues',
  'typingSpeedWpm',
  'formatWhitespace',
  'autoCopy',
  'autoPaste',
  'pasteDelayMs',
  'successDisplayMs',
  'startMinimized',
  'showWidgetWhenIdle',
  'dictationEnabled',
  'cloudTranscription',
  'cloudSpeechModel',
  'notifyNeedsYou',
  'notifyFinished',
  'historyEnabled',
  'historyRetention',
  'onboardingComplete',
  'microphoneSkipped',
  'llmFormatting',
  'llmApiKey',
  'llmDictionary',
  'llmTimeoutMs',
  'llmMinWords',
  'llmModel',
  'llmMode',
  'llmOwnModel',
  'threadTitles',
  'nextPromptSuggestions',
  'threadTips',
  'threadWorkingCopyDefault',
  'projectThreadWorkingCopyDefaults',
  'worktreeCleanup',
  'gitFetchIntervalSeconds',
  'gitAutoPull',
  'keepMainCurrent',
  'projectKeepMainCurrent',
  'defaultMergeMethod',
  'lastMergeMethod',
  'diffLayout',
  'diffHideWhitespace',
  'diffFileState',
  'gitWritingStyle',
  'gitWritingInstructions',
  'followPullRequestTemplates',
  'autoSettleMergedThreads',
  'clearSettledThreadsAfterDays',
  'proactivePanels',
  'commitMessages',
  'pullRequestText',
  'autoUpdateCheck',
  'mainFreezeNotice',
  'webLinkDestination',
  'responseStreaming',
  'localHostEnabled',
  'phoneAccess',
  'phoneAccessName',
  'showBrowserPreviews',
  'browserWithoutAsking',
  'visualsInThreads',
  'babysitPullRequests',
  'resumeThreadsAfterRestart',
  'restartStoppedThreads',
  'workerRoles',
  'workerCeiling',
  'workerMachineCeilings',
  'watcherSettlesFinishedThreads',
  'newWorkerMachine',
  'watcherCompactAtTokens',
  'compactIdleThreads',
  'memoryEnabled',
  'cloudIphoneMonthlyMinutes',
  'cloudIphoneIdleMinutes',
] as const satisfies readonly (keyof SettingsPatch)[]

const looseSettingsPatchSchema = settingsSchema
  // `tailnetConnections` is a headless host's own, written by its administrative route; nothing on a desktop sets it,
  // so a payload naming it is refused rather than dropped (ADR-0053).
  // The speech model is chosen through SPEECH_MODEL_CHOOSE, which also loads it; a plain save would
  // change the setting without the model following, so a payload naming it is refused (ADR-0094).
  .omit({ hotkey: true, pressShortcuts: true, holdShortcuts: true, launchAtStartup: true, tailnetConnections: true, omarchyTheme: true, shellPillInUse: true, speechModel: true })
  .partial()
  // The retired accent is still accepted from older callers and never copied
  // into the patch below (ADR-0011). The retired glass and frost settings are
  // accepted and ignored the same way, since the window is always solid (ADR-0084).
  .extend({
    accent: z.string().max(32).optional(),
    glassOpacity: z.number().optional(),
    frostedWindow: z.boolean().optional(),
    frostSeeThrough: z.number().optional(),
    worktreeCleanup: worktreeCleanupRulesSchema.partial().optional(),
  })
  .strict()
  .superRefine((patch, context) => {
    if (Object.values(patch).some((value) => value === undefined)) {
      context.addIssue({ code: 'custom', message: 'Undefined settings fields are not allowed' })
    }
    if (process.platform !== 'linux') {
      for (const key of ['lightTheme', 'darkTheme'] as const) {
        if (patch[key] === OMARCHY_THEME_ID) {
          context.addIssue({ code: 'custom', path: [key], message: 'Unknown theme selection' })
        }
      }
    }
  })

function copyDefinedSetting<Key extends (typeof settingKeys)[number]>(
  target: SettingsPatch,
  source: z.infer<typeof looseSettingsPatchSchema>,
  key: Key,
): void {
  const value = source[key]
  if (value !== undefined) {
    Reflect.set(target, key, value)
  }
}

const settingsPatchSchema = looseSettingsPatchSchema.transform((patch): SettingsPatch => {
  const exactPatch: SettingsPatch = {}
  for (const key of settingKeys) {
    copyDefinedSetting(exactPatch, patch, key)
  }
  return exactPatch
})
const historyIdSchema = z.string().min(1).max(256)
const historyQuerySchema = z.string().max(1_000)
const hotkeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((accelerator) => accelerator.toLowerCase() !== 'escape')
// Mirrors the preload's schema for the same channel.
const dictationShortcutsChangeSchema = z.object({
  press: z.array(z.string().min(1).max(64)).min(1).max(4),
  hold: z.array(z.string().min(1).max(64)).max(4),
}).strict()
const UNAVAILABLE = Object.freeze({ ok: false as const, reason: 'unavailable' as const })
const OK = Object.freeze({ ok: true as const })
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface IpcWebContentsLike {
  readonly mainFrame: IpcFrameLike
  getURL(): string
  isDestroyed(): boolean
}

export interface IpcFrameLike {
  readonly parent: unknown | null
  readonly url: string
}

export interface IpcInvocationEvent {
  readonly sender: IpcWebContentsLike
  readonly senderFrame: IpcFrameLike | null
}

export interface TrustedIpcSender {
  readonly role: RendererRole
  readonly webContents: IpcWebContentsLike
  readonly url: string
}

export interface IpcMainAdapter {
  handle(
    channel: string,
    listener: (event: IpcInvocationEvent, ...args: unknown[]) => unknown,
  ): void
  removeHandler(channel: string): void
}

export interface SettingsIpcService {
  get(): Promise<AppSettings>
  update(patch: SettingsPatch): Promise<AppSettings>
  reset(): Promise<AppSettings>
}

export interface HistoryIpcService {
  /** Every saved transcript, including those kept from before Keep local history was turned off; only read while it is off. */
  list(options: { readonly enabled: boolean }): Promise<HistoryEntry[]>
  /** Keeps a finished dictation's record, and its transcript while `enabled` (ADR-0100). */
  add(
    entry: HistoryEntry,
    options: { readonly enabled: boolean; readonly retention: number | 'unlimited' },
  ): Promise<HistoryEntry[]>
  search(query: string, options: { readonly enabled: boolean }): Promise<HistoryEntry[]>
  /** Deletes a dictation's transcript and its record. */
  delete(id: string): Promise<boolean>
  clear(): Promise<void>
  listRecords(): Promise<DictationRecord[]>
  getRecord(id: string): Promise<DictationRecord | null>
}

export interface StartupIpcService {
  get(): StartupState | Promise<StartupState>
  set(enabled: boolean): StartupState | Promise<StartupState>
}

export interface HotkeyIpcService {
  current(): string | null | Promise<string | null>
  replace(accelerator: string): HotkeyChangeResult | Promise<HotkeyChangeResult>
}

/** Every dictation shortcut beyond the single hotkey; suspend also covers the hotkey, so stable supplies it too. */
export interface DictationShortcutsIpcService {
  replace(change: DictationShortcutsChange): Promise<DictationShortcutsResult>
  suspend(suspended: boolean): void
  record(): Promise<KeyRecordResult>
  cancelRecord(): void
  permission(): KeyListenerPermission
  requestPermission(): Promise<KeyListenerPermission>
}

export interface AppIpcService {
  show(): void | Promise<void>
  hide(): void | Promise<void>
  minimize(): void | Promise<void>
  reload(): void | Promise<void>
  toggleMaximize(): void | Promise<void>
  isMaximized(): boolean
  quit(): void | Promise<void>
}

export interface DictationIpcService {
  request(command: DictationCommand): void | Promise<void>
  publishWidgetState(state: z.infer<typeof widgetSnapshotSchema>): void | Promise<void>
}

type OutputIpcOptions = Pick<OutputDeliveryRequest, 'autoPaste' | 'pasteDelayMs'> & {
  readonly restoreWidget?: boolean
}

export interface OutputIpcService {
  deliver(text: string, options: OutputIpcOptions): OutputOutcome | Promise<OutputOutcome>
  /** Delivers a dictation and reads the delivered app: the name of the app that had focus, or null when it could not be read. */
  deliverDictation?(
    text: string,
    options: OutputIpcOptions,
  ): Promise<{ readonly outcome: OutputOutcome; readonly app: string | null }>
}

/** How many delivered apps main holds for dictations whose history has not arrived yet. One is in flight at a time. */
const DELIVERED_APPS_HELD = 8

export interface TranscriptPolishIpcService {
  polish(
    text: string,
    asr?: TranscriptPolishAsrContext,
  ): TranscriptPolishResult | Promise<TranscriptPolishResult>
}

export interface TranscriptionIpcService {
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>
  cancel(requestId: string): void
}

/** The speech model dictation uses: where it stands, a retry, the models on offer and the choice between them. */
export interface SpeechModelIpcService {
  status(): SpeechModelStatus
  download(): void
  list(): Promise<SpeechModelOption[]>
  choose(id: string): Promise<boolean>
}

export interface OpenRouterKeyIpcService {
  check(): Promise<OpenRouterKeyCheck>
  /** Absent while the cleanup model Owl feature is off (ADR-0122). */
  models?: () => Promise<OpenRouterModelList>
  /** OpenRouter's speech models, best first; absent while the cloud dictation Owl feature is off (ADR-0160). */
  speechModels?: () => Promise<CloudSpeechModelList>
}

export interface UpdateIpcService {
  status(): UpdateStatus | Promise<UpdateStatus>
  check(): Promise<UpdateStatus>
  download(): Promise<CommandResult>
  install(): CommandResult | Promise<CommandResult>
}

export interface RecoveryNoticeIpcService {
  list(): readonly RecoveryNotice[] | Promise<readonly RecoveryNotice[]>
  dismissPastePermission?(code: PastePermissionNoticeCode): void
}

export interface RegisterIpcDependencies {
  /** Supplied only when the immutable Watcher release gate is on. Never served over socket IPC. */
  readonly watcher?: Required<Omit<WatcherBridge, 'onChanged' | 'readMachines'>> & Pick<WatcherBridge, 'readMachines'>
  readonly settings: SettingsIpcService
  readonly history: HistoryIpcService
  readonly startup: StartupIpcService
  readonly hotkeys: HotkeyIpcService
  readonly dictationShortcuts?: DictationShortcutsIpcService
  readonly app: AppIpcService
  readonly trustedSenders: () => readonly TrustedIpcSender[]
  readonly openExternalLink?: (url: string) => Promise<void>
  /** Opens one of a question's pages on this computer (ADR-0085). */
  readonly openQuestionPage?: (input: QuestionPageOpen) => Promise<QuestionPageOpenResult>
  /** Present only on macOS, where a permission lives in a System Settings pane. */
  readonly openSystemSettings?: (pane: SystemSettingsPane) => Promise<void>
  readonly dictation?: DictationIpcService
  readonly output?: OutputIpcService
  /** Writes a PNG to the clipboard; throws when the clipboard refuses it. */
  readonly imageClipboard?: { writePng(png: Buffer): void | Promise<void> }
  readonly transcriptPolish?: TranscriptPolishIpcService
  readonly transcription?: TranscriptionIpcService
  readonly speechModel?: SpeechModelIpcService
  readonly openRouterKey?: OpenRouterKeyIpcService
  readonly updates?: UpdateIpcService
  readonly recoveryNotices?: RecoveryNoticeIpcService
  readonly widget?: WidgetIpcService
  readonly microphoneAccess?: { ensure(): Promise<boolean> }
  /** Supplied only while the `interface-language` Owl feature is on (ADR-0123); both windows ask it as they start. */
  readonly interfaceLanguage?: { current(): InterfaceLanguageState }
}

export interface WidgetIpcService {
  setPresentation(payload: WidgetPresentationPayload): void
  reportDrag(payload: WidgetDragPayload): void
}

class InvalidIpcPayloadError extends Error {
  readonly code = 'INVALID_IPC_PAYLOAD'

  constructor() {
    super('Invalid IPC payload')
    this.name = 'InvalidIpcPayloadError'
  }
}

class UnauthorizedIpcSenderError extends Error {
  readonly code = 'UNAUTHORIZED_IPC_SENDER'

  constructor() {
    super('Unauthorized IPC sender')
    this.name = 'UnauthorizedIpcSenderError'
  }
}

class IpcRegistrationActiveError extends Error {
  readonly code = 'IPC_REGISTRATION_ACTIVE'

  constructor() {
    super('IPC registration is already active')
    this.name = 'IpcRegistrationActiveError'
  }
}

class IpcCleanupError extends Error {
  readonly code = 'IPC_CLEANUP_FAILED'

  constructor() {
    super('IPC cleanup failed')
    this.name = 'IpcCleanupError'
  }
}

const handlerOwners = new WeakMap<IpcMainAdapter, Map<string, symbol>>()

function parsePayload<Output>(schema: z.ZodType<Output>, payload: unknown): Output {
  const result = schema.safeParse(payload)
  if (!result.success) {
    throw new InvalidIpcPayloadError()
  }
  return result.data
}

export function isAuthorizedIpcSender(
  event: IpcInvocationEvent,
  trustedSenders: readonly TrustedIpcSender[],
  allowedRoles: readonly RendererRole[],
): boolean {
  return findAuthorizedIpcSenderRole(event, trustedSenders, allowedRoles) !== null
}

function findAuthorizedIpcSenderRole(
  event: IpcInvocationEvent,
  trustedSenders: readonly TrustedIpcSender[],
  allowedRoles: readonly RendererRole[],
): RendererRole | null {
  try {
    if (event.senderFrame === null || event.senderFrame.parent !== null) {
      return null
    }
    if (event.sender.isDestroyed()) {
      return null
    }

    const trusted = trustedSenders.find(
      (trusted) =>
        allowedRoles.includes(trusted.role) &&
        trusted.webContents === event.sender &&
        event.senderFrame === event.sender.mainFrame &&
        trusted.url === event.sender.getURL() &&
        trusted.url === event.senderFrame?.url,
    )
    return trusted?.role ?? null
  } catch {
    return null
  }
}

export function registerIpc(
  ipcMain: IpcMainAdapter,
  dependencies: RegisterIpcDependencies,
): () => void {
  const activeOwnership = handlerOwners.get(ipcMain)
  if (activeOwnership !== undefined && activeOwnership.size > 0) {
    throw new IpcRegistrationActiveError()
  }
  const owner = Symbol('sotto-ipc-owner')
  const ownership = activeOwnership ?? new Map<string, symbol>()
  handlerOwners.set(ipcMain, ownership)
  const ownedChannels: string[] = []
  /** Delivered apps by dictation id, from a dictation's delivery until its history arrives. */
  const deliveredApps = new Map<string, string>()

  const register = <Input, Result>(
    channel: string,
    schema: z.ZodType<Input>,
    argumentCount: 0 | 1,
    operation: (input: Input, role: RendererRole) => Result | Promise<Result>,
    allowedRoles: readonly RendererRole[] = ['main'],
  ): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      const role = findAuthorizedIpcSenderRole(
        event,
        dependencies.trustedSenders(),
        allowedRoles,
      )
      if (role === null) {
        throw new UnauthorizedIpcSenderError()
      }
      if (args.length !== argumentCount) {
        throw new InvalidIpcPayloadError()
      }
      const input = parsePayload(schema, argumentCount === 0 ? undefined : args[0])
      return operation(input, role)
    })
    ownership.set(channel, owner)
    ownedChannels.push(channel)
  }

  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) {
      return
    }
    cleaned = true
    let cleanupFailed = false
    for (const channel of ownedChannels) {
      if (ownership.get(channel) === owner) {
        try {
          ipcMain.removeHandler(channel)
          ownership.delete(channel)
        } catch {
          cleanupFailed = true
        }
      }
    }
    if (ownership.size === 0) {
      handlerOwners.delete(ipcMain)
    }
    if (cleanupFailed) {
      throw new IpcCleanupError()
    }
  }

  try {
    if (dependencies.watcher) {
      const watcher = dependencies.watcher
      register(WATCHER_GET, noPayloadSchema, 0, () => watcher.get())
      register(WATCHER_OPEN, watcherOpenRequestSchema, 1, request => watcher.open(request))
      register(WATCHER_PREPARE_STOP_ALL, noPayloadSchema, 0, () => watcher.prepareStopAll())
      register(WATCHER_STOP_ALL, watcherStopAllRequestSchema, 1, request => watcher.stopAll(request))
      register(WATCHER_SET_PERMISSION, watcherSetPermissionRequestSchema, 1, request => watcher.setPermission(request))
      register(WATCHER_WATCH_THREAD, watcherWatchThreadRequestSchema, 1, request => watcher.watchThread(request))
      register(WATCHER_UNWATCH_THREAD, watcherWatchThreadRequestSchema, 1, request => watcher.unwatchThread(request))
      register(WATCHER_READ_HANDOVER, noPayloadSchema, 0, () => watcher.readHandover())
      register(WATCHER_CONTINUE_HANDOVER, watcherContinueHandoverRequestSchema, 1, request => watcher.continueWithHandover(request))
      register(WATCHER_DISMISS_HANDOVER, noPayloadSchema, 0, () => watcher.dismissHandover())
      register(WATCHER_START_NEW, noPayloadSchema, 0, () => watcher.startNew())
      // Only while Work across machines is on (#1032): Stable registers no machines read.
      const readMachines = watcher.readMachines
      if (readMachines) register(WATCHER_READ_MACHINES, noPayloadSchema, 0, () => readMachines.call(watcher))
    }
    register(RECOVERY_NOTICE_LIST, noPayloadSchema, 0, () =>
      dependencies.recoveryNotices?.list() ?? [],
    )
    register(PASTE_PERMISSION_NOTICE_DISMISS, pastePermissionNoticeCodeSchema, 1, code => {
      dependencies.recoveryNotices?.dismissPastePermission?.(code)
      return { ok: true as const }
    })
    register(SETTINGS_GET, noPayloadSchema, 0, () => dependencies.settings.get())
    register(SETTINGS_UPDATE, settingsPatchSchema, 1, (patch) =>
      dependencies.settings.update(patch),
    )
    register(SETTINGS_RESET, noPayloadSchema, 0, () => dependencies.settings.reset())
    if (dependencies.interfaceLanguage) {
      const interfaceLanguage = dependencies.interfaceLanguage
      register(INTERFACE_LANGUAGE_GET, noPayloadSchema, 0, () => interfaceLanguage.current(), ['main', 'widget'])
    }

    // Transcripts saved before Keep local history was turned off stay listed, and can be copied and deleted, while it is off.
    register(HISTORY_LIST, noPayloadSchema, 0, async () => {
      const settings = await dependencies.settings.get()
      return dependencies.history.list({ enabled: settings.historyEnabled })
    })
    // Every finished dictation keeps its record; Keep local history decides only whether its text is saved (ADR-0100).
    register(HISTORY_ADD, finishedDictationSchema, 1, async (entry) => {
      const settings = await dependencies.settings.get()
      const app = deliveredApps.get(entry.id)
      deliveredApps.delete(entry.id)
      return dependencies.history.add(app === undefined ? entry : { ...entry, app }, {
        enabled: settings.historyEnabled,
        retention: settings.historyRetention,
      })
    })
    register(HISTORY_SEARCH, historyQuerySchema, 1, async (query) => {
      const settings = await dependencies.settings.get()
      return dependencies.history.search(query, { enabled: settings.historyEnabled })
    })
    register(HISTORY_DELETE, historyIdSchema, 1, (id) => dependencies.history.delete(id))
    register(HISTORY_CLEAR, noPayloadSchema, 0, () => dependencies.history.clear())
    register(DICTATION_RECORDS_LIST, noPayloadSchema, 0, () => dependencies.history.listRecords())
    // One record, so the window takes in a new dictation without reading every record again.
    register(DICTATION_RECORD_GET, historyIdSchema, 1, (id) => dependencies.history.getRecord(id))

    register(HOTKEY_GET, noPayloadSchema, 0, () => dependencies.hotkeys.current())
    register(HOTKEY_REPLACE, hotkeySchema, 1, (accelerator) =>
      dependencies.hotkeys.replace(accelerator),
    )
    const shortcuts = dependencies.dictationShortcuts
    register(DICTATION_SHORTCUTS_REPLACE, dictationShortcutsChangeSchema, 1, async (change): Promise<DictationShortcutsResult> =>
      shortcuts === undefined ? UNAVAILABLE : shortcuts.replace(change))
    register(DICTATION_SHORTCUTS_SUSPEND, z.boolean(), 1, async (suspended): Promise<CommandResult> => {
      if (shortcuts === undefined) return UNAVAILABLE
      shortcuts.suspend(suspended)
      return OK
    })
    register(DICTATION_KEYS_RECORD, noPayloadSchema, 0, async (): Promise<KeyRecordResult> =>
      shortcuts === undefined ? { kind: 'unavailable' } : shortcuts.record())
    register(DICTATION_KEYS_RECORD_CANCEL, noPayloadSchema, 0, async (): Promise<CommandResult> => {
      if (shortcuts === undefined) return UNAVAILABLE
      shortcuts.cancelRecord()
      return OK
    })
    register(KEY_LISTENER_PERMISSION_GET, noPayloadSchema, 0, async (): Promise<KeyListenerPermission> =>
      shortcuts === undefined ? 'unsupported' : shortcuts.permission())
    register(KEY_LISTENER_PERMISSION_REQUEST, noPayloadSchema, 0, async (): Promise<KeyListenerPermission> =>
      shortcuts === undefined ? 'unsupported' : shortcuts.requestPermission())

    register(UPDATE_GET_STATUS, noPayloadSchema, 0, async () => {
      if (dependencies.updates === undefined) return UNAVAILABLE
      return dependencies.updates.status()
    })
    register(UPDATE_CHECK, noPayloadSchema, 0, async () => {
      if (dependencies.updates === undefined) return UNAVAILABLE
      return dependencies.updates.check()
    })
    register(UPDATE_DOWNLOAD, noPayloadSchema, 0, async (): Promise<CommandResult> => {
      if (dependencies.updates === undefined) return UNAVAILABLE
      return dependencies.updates.download()
    })
    register(UPDATE_INSTALL, noPayloadSchema, 0, async (): Promise<CommandResult> => {
      if (dependencies.updates === undefined) return UNAVAILABLE
      return dependencies.updates.install()
    })

    register(STARTUP_GET, noPayloadSchema, 0, () => dependencies.startup.get())
    register(STARTUP_SET, z.boolean(), 1, (enabled) =>
      dependencies.startup.set(enabled),
    )

    register(APP_SHOW, noPayloadSchema, 0, () => dependencies.app.show())
    register(EXTERNAL_LINK_OPEN, externalLinkSchema, 1, async url => {
      if (!dependencies.openExternalLink) return UNAVAILABLE
      try { await dependencies.openExternalLink(url); return OK } catch { return UNAVAILABLE }
    })
    register(QUESTION_PAGE_OPEN, questionPageOpenSchema, 1, async input => {
      if (!dependencies.openQuestionPage) return UNAVAILABLE
      try { return await dependencies.openQuestionPage(input) } catch { return UNAVAILABLE }
    })
    register(SYSTEM_SETTINGS_OPEN, systemSettingsPaneSchema, 1, async pane => {
      if (!dependencies.openSystemSettings) return UNAVAILABLE
      try { await dependencies.openSystemSettings(pane); return OK } catch { return UNAVAILABLE }
    })
    register(APP_HIDE, noPayloadSchema, 0, () => dependencies.app.hide())
    register(APP_RELOAD, noPayloadSchema, 0, () => dependencies.app.reload())
    register(APP_MINIMIZE, noPayloadSchema, 0, () => dependencies.app.minimize())
    register(APP_TOGGLE_MAXIMIZE, noPayloadSchema, 0, () => dependencies.app.toggleMaximize())
    register(APP_MAXIMIZED, noPayloadSchema, 0, () => dependencies.app.isMaximized())
    register(APP_QUIT, noPayloadSchema, 0, () => dependencies.app.quit())

    register(
      DICTATION_REQUEST,
      dictationCommandSchema,
      1,
      async (command, role): Promise<CommandResult> => {
        // The widget may toggle (click-to-dictate), stop, cancel, and retry or
        // dismiss a kept recording; only the explicit 'start' command stays a
        // main-renderer privilege.
        if (role === 'widget' && command.type === 'start') {
          throw new UnauthorizedIpcSenderError()
        }
        if (dependencies.dictation === undefined) {
          return UNAVAILABLE
        }
        await dependencies.dictation.request(command)
        return OK
      },
      ['main', 'widget'],
    )
    register(
      WIDGET_PRESENTATION,
      widgetPresentationPayloadSchema,
      1,
      async (payload): Promise<CommandResult> => {
        if (dependencies.widget === undefined) {
          return UNAVAILABLE
        }
        dependencies.widget.setPresentation(payload)
        return OK
      },
      ['widget'],
    )
    register(
      WIDGET_DRAG,
      widgetDragSchema,
      1,
      async (payload): Promise<CommandResult> => {
        if (dependencies.widget === undefined) {
          return UNAVAILABLE
        }
        dependencies.widget.reportDrag(payload)
        return OK
      },
      ['widget'],
    )
    register(
      WIDGET_PUBLISH,
      widgetSnapshotSchema,
      1,
      async (state): Promise<CommandResult> => {
        if (dependencies.dictation === undefined) {
          return UNAVAILABLE
        }
        await dependencies.dictation.publishWidgetState(state)
        return OK
      },
    )

    register(
      TRANSCRIPT_POLISH,
      transcriptPolishRequestSchema,
      1,
      async (request): Promise<TranscriptPolishResult> => {
        if (dependencies.transcriptPolish === undefined) {
          return { text: request.text, applied: false }
        }
        return dependencies.transcriptPolish.polish(request.text, request.asr)
      },
    )

    register(
      TRANSCRIPTION_TRANSCRIBE,
      transcriptionRequestSchema,
      1,
      async (request): Promise<TranscriptionResult> => {
        if (dependencies.transcription === undefined) return { ok: false, reason: 'model-not-ready' }
        return dependencies.transcription.transcribe(request)
      },
    )
    register(
      TRANSCRIPTION_CANCEL,
      z.string().min(1).max(128),
      1,
      async (requestId): Promise<CommandResult> => {
        if (dependencies.transcription === undefined) return UNAVAILABLE
        dependencies.transcription.cancel(requestId)
        return OK
      },
    )
    register(SPEECH_MODEL_GET_STATUS, noPayloadSchema, 0, async (): Promise<SpeechModelStatus> => {
      if (dependencies.speechModel === undefined) return { state: 'missing' }
      return dependencies.speechModel.status()
    })
    register(SPEECH_MODEL_DOWNLOAD, noPayloadSchema, 0, async (): Promise<CommandResult> => {
      if (dependencies.speechModel === undefined) return UNAVAILABLE
      dependencies.speechModel.download()
      return OK
    })
    register(SPEECH_MODEL_LIST, noPayloadSchema, 0, async (): Promise<SpeechModelOption[]> => {
      if (dependencies.speechModel === undefined) return []
      return dependencies.speechModel.list()
    })
    register(SPEECH_MODEL_CHOOSE, speechModelIdSchema, 1, async (id): Promise<CommandResult> => {
      if (dependencies.speechModel === undefined) return UNAVAILABLE
      return (await dependencies.speechModel.choose(id)) ? OK : UNAVAILABLE
    })
    register(OPENROUTER_CHECK_KEY, noPayloadSchema, 0, async (): Promise<OpenRouterKeyCheck> => {
      if (dependencies.openRouterKey === undefined) return { ok: false, reason: 'unconfigured' }
      return dependencies.openRouterKey.check()
    })
    register(OPENROUTER_LIST_MODELS, noPayloadSchema, 0, async (): Promise<OpenRouterModelList> => {
      const models = dependencies.openRouterKey?.models
      return models === undefined ? { ok: false, reason: 'http' } : models()
    })
    register(OPENROUTER_LIST_SPEECH_MODELS, noPayloadSchema, 0, async (): Promise<CloudSpeechModelList> => {
      const speechModels = dependencies.openRouterKey?.speechModels
      return speechModels === undefined ? { ok: false, reason: 'http' } : speechModels()
    })
    register(MICROPHONE_ENSURE_ACCESS, noPayloadSchema, 0, async (): Promise<boolean> => {
      if (dependencies.microphoneAccess === undefined) return true
      return dependencies.microphoneAccess.ensure()
    })
    register(OUTPUT_DELIVER, outputDeliveryRequestSchema, 1, async (request): Promise<OutputResult> => {
      if (dependencies.output === undefined) {
        return UNAVAILABLE
      }
      const settings = await dependencies.settings.get()
      const options = {
        autoPaste: request.autoPaste && settings.autoPaste,
        pasteDelayMs: Math.min(
          1_000,
          Math.max(50, request.pasteDelayMs, settings.pasteDelayMs),
        ),
        restoreWidget: settings.showWidgetWhenIdle,
      }
      const { dictationId } = request
      if (dictationId === undefined || dependencies.output.deliverDictation === undefined) {
        return dependencies.output.deliver(request.text, options)
      }
      // The delivered app waits here for the dictation's history, which follows its delivery.
      const delivered = await dependencies.output.deliverDictation(request.text, options)
      if (delivered.app !== null) {
        deliveredApps.delete(dictationId)
        deliveredApps.set(dictationId, delivered.app)
        for (const stale of deliveredApps.keys()) {
          if (deliveredApps.size <= DELIVERED_APPS_HELD) break
          deliveredApps.delete(stale)
        }
      }
      return delivered.outcome
    })
    register(OUTPUT_COPY_IMAGE, outputImageRequestSchema, 1, async (request): Promise<CommandResult> => {
      if (dependencies.imageClipboard === undefined) return UNAVAILABLE
      const png = Buffer.from(request.dataUrl.slice(request.dataUrl.indexOf(',') + 1), 'base64')
      if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return UNAVAILABLE
      try {
        await dependencies.imageClipboard.writePng(png)
        return OK
      } catch {
        return UNAVAILABLE
      }
    })
  } catch (registrationError) {
    try {
      cleanup()
    } catch {
      // Registration failure remains the primary diagnostic.
    }
    throw registrationError
  }

  return cleanup
}
