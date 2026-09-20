import { z } from 'zod'

import { MAX_TRANSCRIPTION_SAMPLES } from './audio'
import type { WidgetSnapshot } from './dictation'
import type { HistoryEntry } from './history'
import type { AppSettings, SettingsPatch } from './settings'
import type { SottoE2EBridge } from './e2e'
import type { RecoveryNotice } from './recoveryNotice'
import type { SottoPlatform } from './platform'
import { widgetPaletteSchema } from './themeBranding'

export type Unsubscribe = () => void

const boundedSessionId = z.string().min(1).max(128)
const widgetErrorCodeSchema = z.enum([
  'MIC_PERMISSION_DENIED',
  'MIC_DEVICE_NOT_FOUND',
  'MIC_START_FAILED',
  'RECORDING_FAILED',
  'NO_SPEECH',
  'TRANSCRIPTION_FAILED',
  'TRANSCRIPTION_UNCONFIGURED',
  'TRANSCRIPTION_UNAUTHORIZED',
  'TRANSCRIPTION_OFFLINE',
  'OUTPUT_UNAVAILABLE',
  'OUTPUT_FAILED',
  'HISTORY_FAILED',
  'SETTINGS_UNAVAILABLE',
])

export const dictationCommandSchema = z
  .object({ type: z.enum(['toggle', 'start', 'stop', 'cancel']) })
  .strict()

const widgetMetadataSchema = {
  theme: z.enum(['system', 'light', 'dark']),
  palette: widgetPaletteSchema,
  reducedMotion: z.enum(['system', 'on']),
  shortcut: z.string().min(1).max(128),
  cancellable: z.boolean(),
  // Absent where the publisher predates the beta's voice gate, which reads as off.
  voiceCoordinator: z.boolean().optional(),
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
  'pill-controls',
  'threads-expanded',
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

export const TRANSCRIPTION_MODEL = 'microsoft/mai-transcribe-2' as const
export const TRANSCRIPTION_PRIVACY_NOTICE = 'The audio you dictate is uploaded to OpenRouter and transcribed by Microsoft. Your dictionary words are sent with it as spelling hints, and text comes back. Nothing is transcribed on this computer.' as const

/** The recorder's own ceiling as PCM16 bytes, plus the WAV header. */
const MAX_TRANSCRIPTION_AUDIO_BYTES = MAX_TRANSCRIPTION_SAMPLES * 2 + 44

export function transcriptionTimeoutMs(audioSeconds: number): number {
  return Math.min(30_000, Math.max(8_000, 8_000 + 300 * audioSeconds))
}

export const transcriptionRequestSchema = z.object({
  requestId: z.string().min(1).max(128),
  wav: z.custom<ArrayBuffer>((value) => value instanceof ArrayBuffer && value.byteLength > 44 && value.byteLength <= MAX_TRANSCRIPTION_AUDIO_BYTES),
  timeoutMs: z.number().int().min(250).max(30_000),
}).strict()

export const transcriptionFailureReasonSchema = z.enum([
  'unconfigured', 'unauthorized', 'billing', 'rate-limited', 'timeout', 'http', 'network', 'cancelled', 'malformed',
])

export const transcriptionResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), text: z.string().max(200_000) }).strict(),
  z.object({ ok: z.literal(false), reason: transcriptionFailureReasonSchema }).strict(),
])

export const transcriptionKeyCheckSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(['unconfigured', 'unauthorized', 'http', 'network', 'timeout']) }).strict(),
])

export type TranscriptionFailureReason = z.infer<typeof transcriptionFailureReasonSchema>
export type TranscriptionRequest = z.infer<typeof transcriptionRequestSchema>
export type TranscriptionResult = z.infer<typeof transcriptionResultSchema>
export type TranscriptionKeyCheck = z.infer<typeof transcriptionKeyCheckSchema>

export const UPDATE_CHECK_PRIVACY_NOTICE = 'Asks GitHub whether a newer Sotto has been released. GitHub sees an ordinary web request from this computer — your IP address, the time, and the version you are running. No audio, transcripts, settings, or identifiers are sent, and turning this off stops the request entirely.' as const

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
    .object({ phase: z.literal('available'), version: updateVersionSchema, problem: updateProblemSchema.nullable() })
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

export type DictationCommand = Readonly<{
  type: 'toggle' | 'start' | 'stop' | 'cancel'
}>

export interface StartupState {
  readonly enabled: boolean
}

export type OutputOutcome = 'pasted' | 'copied' | 'empty'
export type OutputResult = OutputOutcome | UnavailableResult
export type OutputDeliveryRequest = z.infer<typeof outputDeliveryRequestSchema>

export interface SottoBridge {
  readonly chatPrompts?: import('./chatPrompts').ChatPromptBridge
  readonly requestDrafts?: import('./requestDrafts').RequestDraftBridge
  readonly personalChats?: import('./personalChats').PersonalChatBridge
  readonly terminal?: import('./terminal').TerminalBridge
  readonly terminals?: import('./terminalWorkspace').TerminalWorkspaceBridge
  readonly browser?: import('./browser').BrowserBridge
  readonly themes?: import('./themes/bridge').ThemesBridge
  readonly gitChanges?: import('./gitChanges').GitChangesBridge
  readonly files?: import('./files').FilesBridge
  readonly memory?: import('./memory').MemoryBridge
  readonly agents?: import('./agents').AgentBridge
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

  requestDictation(command: DictationCommand): Promise<CommandResult>
  onDictationCommand(listener: (command: DictationCommand) => void): Unsubscribe

  publishWidgetState(state: WidgetSnapshot): Promise<CommandResult>

  deliverOutput(request: OutputDeliveryRequest): Promise<OutputResult>

  polishTranscript(request: TranscriptPolishRequest): Promise<TranscriptPolishResult>

  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>
  cancelTranscription(requestId: string): Promise<CommandResult>
  checkTranscriptionKey(): Promise<TranscriptionKeyCheck>

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
  hideApp(): Promise<void>
  minimizeApp(): Promise<void>
  reloadApp(): Promise<void>
  toggleMaximizeApp(): Promise<void>
  getWindowMaximized(): Promise<boolean>
  onWindowMaximized(listener: (maximized: boolean) => void): () => void
  quitApp(): Promise<void>
}

/** Least-privilege surface exposed only inside the non-focusing widget renderer. */
export interface SottoWidgetBridge {
  readonly agents?: import('./agents').AgentBridge
  readonly platform: SottoPlatform

  onWidgetState(listener: (state: WidgetSnapshot) => void): Unsubscribe
  onWidgetVisibilityChange(listener: (visibility: WidgetVisibilityPayload) => void): Unsubscribe
  requestToggle(): Promise<CommandResult>
  requestStop(): Promise<CommandResult>
  requestCancel(): Promise<CommandResult>
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
