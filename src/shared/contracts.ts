import type { DictationState } from './dictation'
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

export const modelStatusSchema = z
  .object({
    preset: modelPresetSchema,
    state: z.enum(['bundled', 'missing', 'downloading', 'ready', 'error']),
    progress: z.number().finite().min(0).max(1).optional(),
  })
  .strict()

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
import { z } from 'zod'
