import { z } from 'zod'

import type { WidgetSnapshot } from './dictation'
import type { HistoryEntry } from './history'
import type { AppSettings, ModelPreset, SettingsPatch } from './settings'
import type { TalkTypeE2EBridge } from './e2e'
import type { RecoveryNotice } from './recoveryNotice'

export type Unsubscribe = () => void

const boundedSessionId = z.string().min(1).max(128)
const modelPresetSchema = z.enum(['fast', 'balanced', 'accurate', 'instant'])
const widgetErrorCodeSchema = z.enum([
  'MIC_PERMISSION_DENIED',
  'MIC_DEVICE_NOT_FOUND',
  'MIC_START_FAILED',
  'RECORDING_FAILED',
  'NO_SPEECH',
  'TRANSCRIPTION_FAILED',
  'OUTPUT_UNAVAILABLE',
  'OUTPUT_FAILED',
  'HISTORY_FAILED',
  'SETTINGS_UNAVAILABLE',
])

export const dictationCommandSchema = z
  .object({ type: z.enum(['toggle', 'start', 'stop', 'cancel']) })
  .strict()

export const dictationStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('idle') }).strict(),
  z
    .object({ status: z.literal('requesting-permission'), sessionId: boundedSessionId })
    .strict(),
  z
    .object({
      status: z.literal('listening'),
      sessionId: boundedSessionId,
      startedAt: z.number().finite().nonnegative(),
      level: z.number().finite().min(0).max(1),
    })
    .strict(),
  z
    .object({
      status: z.literal('processing'),
      sessionId: boundedSessionId,
      startedAt: z.number().finite().nonnegative(),
    })
    .strict(),
  z
    .object({
      status: z.literal('success'),
      sessionId: boundedSessionId,
      text: z.string().max(200_000),
      output: z.enum(['pasted', 'copied']),
    })
    .strict(),
  z.object({ status: z.literal('cancelled'), sessionId: boundedSessionId }).strict(),
  z
    .object({
      status: z.literal('error'),
      sessionId: boundedSessionId.optional(),
      code: z.string().min(1).max(128),
      message: z.string().min(1).max(1_000),
    })
    .strict(),
])

const widgetMetadataSchema = {
  theme: z.enum(['system', 'light', 'dark']),
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
      ...widgetMetadataSchema,
    })
    .strict(),
])

/** Main-owned epoch attached to every widget visibility-bound renderer report. */
export const widgetVisibilityGenerationSchema = z.number().int().nonnegative().safe()

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

/** One renderer-local phase before it is bound to a visibility generation. */
export const widgetDragPhaseSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('start') }).strict(),
  z.object({ phase: z.literal('move') }).strict(),
  z.object({ phase: z.literal('end') }).strict(),
])
export type WidgetDragPhase = z.infer<typeof widgetDragPhaseSchema>

/** One generation-bound renderer-reported phase of a widget drag gesture. */
export const widgetDragSchema = z.discriminatedUnion('phase', [
  z
    .object({
      phase: z.literal('start'),
      generation: widgetVisibilityGenerationSchema,
    })
    .strict(),
  z
    .object({
      phase: z.literal('move'),
      generation: widgetVisibilityGenerationSchema,
    })
    .strict(),
  z
    .object({
      phase: z.literal('end'),
      generation: widgetVisibilityGenerationSchema,
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

export const modelStatusSchema = z
  .object({
    preset: modelPresetSchema,
    state: z.enum(['bundled', 'missing', 'downloading', 'ready', 'error']),
    progress: z.number().finite().min(0).max(1).optional(),
  })
  .strict()

export const MODEL_DOWNLOAD_PRIVACY_NOTICE = 'Downloading an optional model contacts Hugging Face, which receives ordinary network metadata such as your IP address and request time. Audio and transcripts are not sent.' as const

const approvedDisclosureModels = {
  fast: { repository: 'Xenova/whisper-tiny', revision: '5332fcc35e32a33b86612b9a57a89be7906102b1', license: 'Apache-2.0', bundled: false },
  balanced: { repository: 'Xenova/whisper-base', revision: '64da57285918e20ea79ea5c88eed7197933abaa8', license: 'Apache-2.0', bundled: true },
  accurate: { repository: 'Xenova/whisper-small', revision: '2d67713f236afa48a18992566e7647f6ca848e13', license: 'Apache-2.0', bundled: false },
  instant: { repository: 'onnx-community/moonshine-base-ONNX', revision: 'b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad', license: 'MIT', bundled: false },
} as const

export const modelDisclosureSchema = z
  .object({
    preset: modelPresetSchema,
    repository: z.string().min(1).max(128),
    sourceProvider: z.literal('Hugging Face'),
    sourceHost: z.literal('huggingface.co'),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    totalBytes: z.number().int().positive().safe(),
    license: z.enum(['Apache-2.0', 'MIT']),
    bundled: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = approvedDisclosureModels[value.preset]
    if (value.repository !== expected.repository || value.revision !== expected.revision || value.license !== expected.license || value.bundled !== expected.bundled) {
      context.addIssue({ code: 'custom', message: 'Model disclosure does not match the approved catalog' })
    }
  })
  .transform((value) => Object.freeze(value))

export const modelDisclosureCatalogSchema = z
  .object({
    models: z.array(modelDisclosureSchema).length(4),
    optionalDownloadNotice: z.literal(MODEL_DOWNLOAD_PRIVACY_NOTICE),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.models.map((model) => model.preset).join() !== 'fast,balanced,accurate,instant') {
      context.addIssue({ code: 'custom', message: 'Model disclosure order is invalid' })
    }
  })
  .transform((value) => Object.freeze({
    models: Object.freeze(value.models),
    optionalDownloadNotice: value.optionalDownloadNotice,
  }))

export type ModelDisclosure = z.infer<typeof modelDisclosureSchema>
export type ModelDisclosureCatalog = z.infer<typeof modelDisclosureCatalogSchema>

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

export interface ModelStatus {
  readonly preset: ModelPreset
  readonly state: 'bundled' | 'missing' | 'downloading' | 'ready' | 'error'
  readonly progress?: number | undefined
}

export interface ModelInstallRequest {
  readonly preset: ModelPreset
  readonly consent: boolean
}

export type OutputOutcome = 'pasted' | 'copied' | 'empty'
export type OutputResult = OutputOutcome | UnavailableResult
export type OutputDeliveryRequest = z.infer<typeof outputDeliveryRequestSchema>

export interface TalkTypeBridge {
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

  getModelStatus(preset: ModelPreset): Promise<ModelStatus | UnavailableResult>
  listModelDisclosures(): Promise<ModelDisclosureCatalog | UnavailableResult>
  installModel(request: ModelInstallRequest): Promise<CommandResult>
  removeModel(preset: ModelPreset): Promise<CommandResult>
  onModelStatus(listener: (status: ModelStatus) => void): Unsubscribe

  deliverOutput(request: OutputDeliveryRequest): Promise<OutputResult>

  getStartup(): Promise<StartupState>
  setStartup(enabled: boolean): Promise<StartupState>

  showApp(): Promise<void>
  hideApp(): Promise<void>
  minimizeApp(): Promise<void>
  quitApp(): Promise<void>
}

/** Least-privilege surface exposed only inside the non-focusing widget renderer. */
export interface TalkTypeWidgetBridge {
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
    talktype?: TalkTypeBridge
    talktypeWidget?: TalkTypeWidgetBridge
    /** Present only when the non-packaged main process admits TALKTYPE_E2E. */
    talktypeE2E?: TalkTypeE2EBridge
    /**
     * Immutable second gate for visual tests. It is recognized only in a renderer compiled
     * with the exact test-only environment value TALKTYPE_VISUAL_PREVIEW=1.
     */
    readonly __TALKTYPE_VISUAL_PREVIEW__?: true
  }
}
