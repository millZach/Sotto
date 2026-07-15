import { z } from 'zod'

import type { DictationState, WidgetSnapshot } from './dictation'
import type { HistoryEntry } from './history'
import type { AppSettings, ModelPreset, SettingsPatch } from './settings'

export type Unsubscribe = () => void

const boundedSessionId = z.string().min(1).max(128)
const modelPresetSchema = z.enum(['fast', 'balanced', 'accurate'])

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
      code: z.string().min(1).max(128),
      message: z.string().min(1).max(1_000),
      ...widgetMetadataSchema,
    })
    .strict(),
])

export const modelStatusSchema = z
  .object({
    preset: modelPresetSchema,
    state: z.enum(['bundled', 'missing', 'downloading', 'ready', 'error']),
    progress: z.number().finite().min(0).max(1).optional(),
  })
  .strict()

export const MODEL_DOWNLOAD_PRIVACY_NOTICE = 'Downloading an optional model contacts Hugging Face, which receives ordinary network metadata such as your IP address and request time. Audio and transcripts are not sent.' as const

const approvedDisclosureModels = {
  fast: { repository: 'Xenova/whisper-tiny', revision: '5332fcc35e32a33b86612b9a57a89be7906102b1', bundled: false },
  balanced: { repository: 'Xenova/whisper-base', revision: '64da57285918e20ea79ea5c88eed7197933abaa8', bundled: true },
  accurate: { repository: 'Xenova/whisper-small', revision: '2d67713f236afa48a18992566e7647f6ca848e13', bundled: false },
} as const

export const modelDisclosureSchema = z
  .object({
    preset: modelPresetSchema,
    repository: z.string().min(1).max(128),
    sourceProvider: z.literal('Hugging Face'),
    sourceHost: z.literal('huggingface.co'),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    totalBytes: z.number().int().positive().safe(),
    license: z.literal('Apache-2.0'),
    bundled: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = approvedDisclosureModels[value.preset]
    if (value.repository !== expected.repository || value.revision !== expected.revision || value.bundled !== expected.bundled) {
      context.addIssue({ code: 'custom', message: 'Model disclosure does not match the approved catalog' })
    }
  })
  .transform((value) => Object.freeze(value))

export const modelDisclosureCatalogSchema = z
  .object({
    models: z.array(modelDisclosureSchema).length(3),
    optionalDownloadNotice: z.literal(MODEL_DOWNLOAD_PRIVACY_NOTICE),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.models.map((model) => model.preset).join() !== 'fast,balanced,accurate') {
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

export interface TalkTypeBridge {
  getSettings(): Promise<AppSettings>
  updateSettings(patch: SettingsPatch): Promise<AppSettings>
  resetSettings(): Promise<AppSettings>

  listHistory(): Promise<HistoryEntry[]>
  addHistory(entry: HistoryEntry): Promise<HistoryEntry[]>
  searchHistory(query: string): Promise<HistoryEntry[]>
  deleteHistory(id: string): Promise<boolean>
  clearHistory(): Promise<void>

  getHotkey(): Promise<string | null>
  replaceHotkey(accelerator: string): Promise<HotkeyChangeResult>

  requestDictation(command: DictationCommand): Promise<CommandResult>
  onDictationCommand(listener: (command: DictationCommand) => void): Unsubscribe

  publishWidgetState(state: DictationState): Promise<CommandResult>
  onWidgetState(listener: (state: DictationState) => void): Unsubscribe

  getModelStatus(preset: ModelPreset): Promise<ModelStatus | UnavailableResult>
  listModelDisclosures(): Promise<ModelDisclosureCatalog | UnavailableResult>
  installModel(request: ModelInstallRequest): Promise<CommandResult>
  removeModel(preset: ModelPreset): Promise<CommandResult>
  onModelStatus(listener: (status: ModelStatus) => void): Unsubscribe

  deliverOutput(text: string): Promise<OutputResult>

  getStartup(): Promise<StartupState>
  setStartup(enabled: boolean): Promise<StartupState>

  showApp(): Promise<void>
  hideApp(): Promise<void>
  minimizeApp(): Promise<void>
  quitApp(): Promise<void>
}

declare global {
  interface Window {
    talktype: TalkTypeBridge
  }
}
