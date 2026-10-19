import { z } from 'zod'

import { MAX_TRANSCRIPTION_SAMPLES } from './audio'
import { WIDGET_ERROR_CODES, type WidgetSnapshot } from './dictation'
import type { HistoryEntry } from './history'
import type { AppSettings, SettingsPatch } from './settings'
import type { SottoE2EBridge } from './e2e'
import type { RecoveryNotice } from './recoveryNotice'
import type { SpeechModelStatus } from './speechModel'
import type { SottoPlatform } from './platform'
import { widgetPaletteSchema } from './themeBranding'

export type Unsubscribe = () => void

const boundedSessionId = z.string().min(1).max(128)
const widgetErrorCodeSchema = z.enum(WIDGET_ERROR_CODES)

export const dictationCommandSchema = z
  .object({ type: z.enum(['toggle', 'start', 'stop', 'cancel', 'retry', 'dismiss']) })
  .strict()

const widgetMetadataSchema = {
  theme: z.enum(['system', 'light', 'dark']),
  palette: widgetPaletteSchema,
  reducedMotion: z.enum(['system', 'on']),
  shortcut: z.string().min(1).max(128),
  cancellable: z.boolean(),
} as const

export const widgetSnapshotSchema: z.ZodType<WidgetSnapshot> = z.discriminatedUnion('status', [
  z.object({ status: z.literal('idle'), ...widgetMetadataSchema }).strict(),
  z
    .object({
      status: z.literal('requesting-permission'),
      sessionId: boundedSessionId,
      ...widgetMetadataSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('listening'),
      sessionId: boundedSessionId,
      startedAt: z.number().finite().nonnegative(),
      level: z.number().finite().min(0).max(1),
      ...widgetMetadataSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('processing'),
      sessionId: boundedSessionId,
      startedAt: z.number().finite().nonnegative(),
      stage: z.enum([
        'preparing-audio',
        'loading-model',
        'transcribing',
        'delivering-output',
      ]),
      progress: z.number().finite().min(0).max(1),
      ...widgetMetadataSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('success'),
      sessionId: boundedSessionId,
      output: z.enum(['pasted', 'copied']),
      ...widgetMetadataSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('cancelled'),
      sessionId: boundedSessionId,
      ...widgetMetadataSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('error'),
      sessionId: boundedSessionId.optional(),
      code: widgetErrorCodeSchema,
      captureStarted: z.boolean().optional(),
      kept: z.boolean().optional(),
      retried: z.boolean().optional(),
      ...widgetMetadataSchema,
    })
    .strict(),
])

/** Main-owned epoch attached to every widget visibility-bound renderer report. */
const widgetVisibilityGenerationSchema = z.number().int().nonnegative().safe()

/** One main-to-renderer widget visibility transition. */
export const widgetVisibilitySchema = z
  .object({
    visible: z.boolean(),
    generation: widgetVisibilityGenerationSchema,
  })
  .strict()
export type WidgetVisibilityPayload = z.infer<typeof widgetVisibilitySchema>

/** Native widget visual states with distinct presentation footprints. */
export const widgetPresentationSchema = z.enum([
  'idle-resting',
  'idle-hovered',
  'active',
])
export type WidgetPresentation = z.infer<typeof widgetPresentationSchema>

/** One generation-bound renderer presentation report. */
export const widgetPresentationPayloadSchema = z
  .object({
    presentation: widgetPresentationSchema,
    generation: widgetVisibilityGenerationSchema,
  })
  .strict()
export type WidgetPresentationPayload = z.infer<typeof widgetPresentationPayloadSchema>

/** Renderer-generated identity for one drag gesture within a visibility generation. */
const widgetDragGestureIdSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export type WidgetDragGestureId = z.infer<typeof widgetDragGestureIdSchema>

/** One renderer-local phase before it is bound to a visibility generation. */
export const widgetDragPhaseSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('start'), gestureId: widgetDragGestureIdSchema }).strict(),
  z.object({ phase: z.literal('move'), gestureId: widgetDragGestureIdSchema }).strict(),
  z.object({ phase: z.literal('end'), gestureId: widgetDragGestureIdSchema }).strict(),
])
export type WidgetDragPhase = z.infer<typeof widgetDragPhaseSchema>

/** One generation-bound renderer-reported phase of a widget drag gesture. */
export const widgetDragSchema = z.discriminatedUnion('phase', [
  z
    .object({
      phase: z.literal('start'),
      generation: widgetVisibilityGenerationSchema,
      gestureId: widgetDragGestureIdSchema,
    })
    .strict(),
  z
    .object({
      phase: z.literal('move'),
      generation: widgetVisibilityGenerationSchema,
      gestureId: widgetDragGestureIdSchema,
    })
    .strict(),
  z
    .object({
      phase: z.literal('end'),
      generation: widgetVisibilityGenerationSchema,
      gestureId: widgetDragGestureIdSchema,
    })
    .strict(),
])
export type WidgetDragPayload = z.infer<typeof widgetDragSchema>

export const outputDeliveryRequestSchema = z
  .object({
    text: z.string().max(200_000),
    autoPaste: z.boolean(),
    pasteDelayMs: z.number().int().min(50).max(1_000),
  })
  .strict()

/** The longest PNG data URL Copy image sends to main. */
export const MAX_OUTPUT_IMAGE_DATA_URL = 64_000_000
/** A PNG the window drew, for the clipboard. The window converts every image to PNG first, so main reads one format. */
export const outputImageRequestSchema = z
  .object({
    dataUrl: z.string().startsWith('data:image/png;base64,').max(MAX_OUTPUT_IMAGE_DATA_URL),
  })
  .strict()

export const transcriptPolishAsrContextSchema = z
  .object({
    /** Word count of each streaming ASR segment, in emit order. */
    segmentWords: z.array(z.number().int().min(0).max(100_000)).max(500),
    /**
     * Audio RMS of each segment, aligned with segmentWords. Discriminates a
     * silent microphone (low RMS, empty text is correct) from ASR losing real
     * speech (speech-level RMS, empty text is a transcription failure).
     */
    segmentRms: z.array(z.number().finite().min(0).max(10)).max(500).optional(),
    /** Full recording duration in milliseconds. */
    durationMs: z.number().finite().min(0),
  })
  .strict()

export const transcriptPolishRequestSchema = z
  .object({
    text: z.string().min(1).max(200_000),
    /** Optional word-count-only ASR metadata for loss diagnostics. */
    asr: transcriptPolishAsrContextSchema.optional(),
  })
  .strict()

export const transcriptPolishResultSchema = z
  .object({
    text: z.string().max(200_000),
    applied: z.boolean(),
  })
  .strict()

export type TranscriptPolishAsrContext = z.infer<typeof transcriptPolishAsrContextSchema>
export type TranscriptPolishRequest = z.infer<typeof transcriptPolishRequestSchema>
export type TranscriptPolishResult = z.infer<typeof transcriptPolishResultSchema>

export const TRANSCRIPTION_PRIVACY_NOTICE = 'Your audio never leaves this computer. Only AI cleanup, when on, sends the text to OpenRouter.' as const

/** The recorder's own ceiling as PCM16 bytes, plus the WAV header. */
const MAX_TRANSCRIPTION_AUDIO_BYTES = MAX_TRANSCRIPTION_SAMPLES * 2 + 44

/**
 * How long the renderer waits for one segment before giving up on it. The speech model takes well
 * under a second for a 15-second segment on a laptop; the 15-second floor is for a slow machine or
 * a busy one, and a deadline that is never reached costs nothing.
 */
export function transcriptionTimeoutMs(audioSeconds: number): number {
  return Math.min(30_000, Math.max(15_000, 8_000 + 300 * audioSeconds))
}

export const transcriptionRequestSchema = z.object({
  requestId: z.string().min(1).max(128),
  wav: z.custom<ArrayBuffer>((value) => value instanceof ArrayBuffer && value.byteLength > 44 && value.byteLength <= MAX_TRANSCRIPTION_AUDIO_BYTES),
  timeoutMs: z.number().int().min(250).max(30_000),
}).strict()

/**
 * Why a segment was not transcribed: the speech model is not downloaded or running yet
 * (`model-not-ready`), it ran and failed (`failed`), it took longer than the deadline (`timeout`),
 * the dictation was cancelled, or the audio was not a WAV the recorder makes (`malformed`).
 */
export const transcriptionFailureReasonSchema = z.enum([
  'model-not-ready', 'failed', 'timeout', 'cancelled', 'malformed',
])

export const transcriptionResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), text: z.string().max(200_000) }).strict(),
  z.object({ ok: z.literal(false), reason: transcriptionFailureReasonSchema }).strict(),
])

/** Whether OpenRouter accepts the saved key, for AI cleanup (Verify key in Settings → Cleanup). */
export const openRouterKeyCheckSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(['unconfigured', 'unauthorized', 'http', 'network', 'timeout']) }).strict(),
])

export type TranscriptionFailureReason = z.infer<typeof transcriptionFailureReasonSchema>
export type TranscriptionRequest = z.infer<typeof transcriptionRequestSchema>
export type TranscriptionResult = z.infer<typeof transcriptionResultSchema>
export type OpenRouterKeyCheck = z.infer<typeof openRouterKeyCheckSchema>

export const UPDATE_CHECK_PRIVACY_NOTICE = 'Asks GitHub whether a newer Sotto is out. GitHub sees your IP address, your version and a random ID for this install.' as const

const updateVersionSchema = z.string().min(1).max(64)
/** One sentence from the updater, already trimmed to something a tooltip can hold. */
const updateProblemSchema = z.string().min(1).max(240)

/**
 * One observable step of the update lifecycle. `unsupported` is the honest
 * answer for a development run, an E2E run, and the macOS build, none of which
 * ship an update feed. `failed` is a check that could not be completed; a
 * download or install that fails keeps its phase and carries the failure as
 * `problem`, so the offer (or the installer already on disk) is never lost and
 * the same control simply offers to try again.
 */
export const updatePhaseSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('idle') }).strict(),
  z.object({ phase: z.literal('checking') }).strict(),
  z.object({ phase: z.literal('up-to-date') }).strict(),
  z
    .object({ phase: z.literal('available'), version: updateVersionSchema, problem: updateProblemSchema.nullable(), failedStep: z.enum(['check', 'download']).optional() })
    .strict(),
  z
    .object({
      phase: z.literal('downloading'),
      version: updateVersionSchema,
      percent: z.number().int().min(0).max(100),
    })
    .strict(),
  z
    .object({ phase: z.literal('downloaded'), version: updateVersionSchema, problem: updateProblemSchema.nullable() })
    .strict(),
  z.object({ phase: z.literal('failed'), problem: updateProblemSchema.nullable() }).strict(),
  z.object({ phase: z.literal('unsupported') }).strict(),
])

export const updateStatusSchema = z
  .object({
    currentVersion: updateVersionSchema,
    /** Main supplies this even when updating is unsupported. Older fixtures may omit it. */
    releaseTrack: z.enum(['stable', 'owl']).optional(),
    /** Main's immutable startup answers. Older fixtures may omit them. */
    owlFeatures: z.record(z.string(), z.boolean()).optional(),
    /** Compatibility alias for owlFeatures.watcher, wrapping the Owl feature list. */
    watcherEnabled: z.boolean().optional(),
    phase: updatePhaseSchema,
    /** When the last check started, as epoch milliseconds; null before the first. */
    checkedAt: z.number().int().nonnegative().nullable(),
  })
  .strict()

export type UpdatePhase = z.infer<typeof updatePhaseSchema>
export type UpdateStatus = z.infer<typeof updateStatusSchema>

export type UnavailableResult = Readonly<{ ok: false; reason: 'unavailable' }>
export type CommandResult = Readonly<{ ok: true }> | UnavailableResult

export type HotkeyChangeResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: 'conflict' | 'invalid' | 'unavailable' }>

/** Every dictation shortcut at once; `press[0]` is `settings.hotkey`. */
export type DictationShortcutsChange = Readonly<{ press: readonly string[]; hold: readonly string[] }>

/** A refused change names the chord that failed when one did; the previous shortcuts stay in force. */
export type DictationShortcutsResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: 'conflict' | 'invalid' | 'unavailable'; chord?: string | undefined }>

/** `unsupported-key`: a key outside the shortcut table was pressed, so no chord was taken. */
export type KeyRecordResult =
  | Readonly<{ kind: 'recorded'; chord: string }>
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{ kind: 'unsupported-key' }>
  | Readonly<{ kind: 'unavailable' }>

/** The key listener's standing: macOS Input Monitoring granted or denied; `not-needed` while nothing needs it or where no grant exists (Windows); `unsupported` where the listener cannot run. */
export type KeyListenerPermission = 'granted' | 'denied' | 'not-needed' | 'unsupported'

export type DictationCommand = Readonly<{
  /** `cancel` stops work in progress; `dismiss` clears an error and a kept recording; `retry` sends it again. */
  type: 'toggle' | 'start' | 'stop' | 'cancel' | 'retry' | 'dismiss'
}>

export interface StartupState {
  readonly enabled: boolean
  /** Linux only: sign-in startup is available in packaged builds. */
  readonly supported?: boolean | undefined
  /** macOS only: the login item is on but waits for the user to allow it in System Settings > General > Login Items. */
  readonly approvalRequired?: boolean | undefined
}

export type OutputOutcome = 'pasted' | 'copied' | 'clipboard-unavailable' | 'empty'
export type OutputResult = OutputOutcome | UnavailableResult
export type OutputDeliveryRequest = z.infer<typeof outputDeliveryRequestSchema>
export type OutputImageRequest = z.infer<typeof outputImageRequestSchema>

export interface SottoBridge {
  readonly usage?: import('./usageDashboard').UsageBridge
  /** Delegation between threads (ADR-0081), present only while the Owl list turns it on. */
  readonly delegations?: import('./delegation').DelegationsBridge
  /** Continuing a thread on another provider (ADR-0089), present only while the Owl list turns it on. */
  readonly continueThread?: import('./continueThread').ContinueBridge
  /** Signing Sotto's OpenCode in to model sources (#1104), present only while OpenCode's Owl feature is on. */
  readonly opencode?: import('./opencodeSignIn').OpenCodeSignInBridge

  readonly omarchySetup?: import('./omarchySetup').OmarchySetupBridge
  readonly watcher?: import('./watcherRoom').WatcherBridge
  readonly hosts?: import('./hosts').HostsBridge
  readonly phones?: import('./phones').PhonesBridge
  readonly requestDrafts?: import('./requestDrafts').RequestDraftBridge
  readonly terminal?: import('./terminal').TerminalBridge
  readonly terminals?: import('./terminalWorkspace').TerminalWorkspaceBridge
  readonly browser?: import('./browser').BrowserBridge
  readonly cloudIphone?: import('./cloudIphone').CloudIphoneBridge
  readonly themes?: import('./themes/bridge').ThemesBridge
  readonly gitChanges?: import('./gitChanges').GitChangesBridge
  readonly subagents?: import('./subagents').SubagentsBridge
  readonly files?: import('./files').FilesBridge
  readonly visuals?: import('./visualPages').VisualPagesBridge
  readonly memory?: import('./memory').MemoryBridge
  readonly agents?: import('./agents').AgentWireBridge
  readonly platform: SottoPlatform

  listRecoveryNotices(): Promise<readonly RecoveryNotice[]>
  onRecoveryNotice(listener: (notice: RecoveryNotice) => void): Unsubscribe

  getSettings(): Promise<AppSettings>
  updateSettings(patch: SettingsPatch): Promise<AppSettings>
  resetSettings(): Promise<AppSettings>
  onSettingsChanged(listener: (settings: AppSettings) => void): Unsubscribe

  listHistory(): Promise<HistoryEntry[]>
  addHistory(entry: HistoryEntry): Promise<HistoryEntry[]>
  searchHistory(query: string): Promise<HistoryEntry[]>
  deleteHistory(id: string): Promise<boolean>
  clearHistory(): Promise<void>

  getHotkey(): Promise<string | null>
  replaceHotkey(accelerator: string): Promise<HotkeyChangeResult>
  /** Owl feature `dictation-hold-shortcuts`: replaces every dictation shortcut at once. */
  replaceDictationShortcuts?(change: DictationShortcutsChange): Promise<DictationShortcutsResult>
  /** While Settings records a shortcut, every dictation shortcut stands down so the keys reach the recorder; main resumes them after 60 s regardless. */
  suspendDictationShortcuts?(suspended: boolean): Promise<CommandResult>
  /** Windows and macOS with the Owl feature on: records one chord through the key listener, Fn and the Win key included. */
  recordDictationKeys?(): Promise<KeyRecordResult>
  cancelDictationKeyRecord?(): Promise<CommandResult>
  /** The keys held during a recording, as chord tokens. */
  onDictationKeysHeld?(listener: (tokens: readonly string[]) => void): Unsubscribe
  getKeyListenerPermission?(): Promise<KeyListenerPermission>
  /** Asks macOS for Input Monitoring and opens its pane in System Settings. */
  requestKeyListenerPermission?(): Promise<KeyListenerPermission>
  onKeyListenerPermission?(listener: (permission: KeyListenerPermission) => void): Unsubscribe

  requestDictation(command: DictationCommand): Promise<CommandResult>
  onDictationCommand(listener: (command: DictationCommand) => void): Unsubscribe

  publishWidgetState(state: WidgetSnapshot): Promise<CommandResult>

  deliverOutput(request: OutputDeliveryRequest): Promise<OutputResult>
  /** Puts an image on the clipboard; `unavailable` when it could not be read or written. */
  copyImage?(request: OutputImageRequest): Promise<CommandResult>

  polishTranscript(request: TranscriptPolishRequest): Promise<TranscriptPolishResult>

  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>
  cancelTranscription(requestId: string): Promise<CommandResult>
  getSpeechModelStatus(): Promise<SpeechModelStatus>
  /** Starts the speech model download, or retries one that failed; progress arrives through onSpeechModelStatus. */
  downloadSpeechModel(): Promise<CommandResult>
  onSpeechModelStatus(listener: (status: SpeechModelStatus) => void): Unsubscribe
  checkOpenRouterKey(): Promise<OpenRouterKeyCheck>
  /** Asks the operating system for the microphone before Chromium captures. */
  ensureMicrophoneAccess(): Promise<boolean>

  getUpdateStatus(): Promise<UpdateStatus | UnavailableResult>
  checkForUpdates(): Promise<UpdateStatus | UnavailableResult>
  downloadUpdate(): Promise<CommandResult>
  installUpdate(): Promise<CommandResult>
  onUpdateStatus(listener: (status: UpdateStatus) => void): Unsubscribe
  /** The application menu's "Check for Updates…": the window runs the same check its own control would. */
  onUpdateCheckRequested(listener: () => void): Unsubscribe

  getStartup(): Promise<StartupState>
  setStartup(enabled: boolean): Promise<StartupState>

  showApp(): Promise<void>
  /** Opens a validated web/mail link after explicit activation in the main renderer. */
  openExternalLink?(url: string): Promise<CommandResult>
  /** Opens one of a question's pages on this computer, named by its request and token (ADR-0085). */
  openQuestionPage?(input: import('./questionPageOpen').QuestionPageOpen): Promise<import('./questionPageOpen').QuestionPageOpenResult>
  /** Opens a macOS Privacy & Security pane after explicit activation; refused as unavailable elsewhere. */
  openSystemSettings?(pane: import('./systemSettings').SystemSettingsPane): Promise<CommandResult>
  hideApp(): Promise<void>
  minimizeApp(): Promise<void>
  reloadApp(): Promise<void>
  toggleMaximizeApp(): Promise<void>
  getWindowMaximized(): Promise<boolean>
  onWindowMaximized(listener: (maximized: boolean) => void): () => void
  onWindowHidden(listener: () => void): () => void
  quitApp(): Promise<void>
}

/** Least-privilege surface exposed only inside the non-focusing widget renderer. */
export interface SottoWidgetBridge {
  readonly platform: SottoPlatform

  onWidgetState(listener: (state: WidgetSnapshot) => void): Unsubscribe
  onWidgetVisibilityChange(listener: (visibility: WidgetVisibilityPayload) => void): Unsubscribe
  requestToggle(): Promise<CommandResult>
  requestStop(): Promise<CommandResult>
  requestCancel(): Promise<CommandResult>
  requestRetry(): Promise<CommandResult>
  requestDismiss(): Promise<CommandResult>
  setPresentation(payload: WidgetPresentationPayload): Promise<CommandResult>
  reportDrag(payload: WidgetDragPayload): Promise<CommandResult>
}

declare global {
  interface Window {
    sotto?: SottoBridge
    sottoWidget?: SottoWidgetBridge
    /** Present only when the non-packaged main process admits SOTTO_E2E. */
    sottoE2E?: SottoE2EBridge
    /**
     * Immutable second gate for visual tests. It is recognized only in a renderer compiled
     * with the exact test-only environment value SOTTO_VISUAL_PREVIEW=1.
     */
    readonly __SOTTO_VISUAL_PREVIEW__?: true
  }
}
