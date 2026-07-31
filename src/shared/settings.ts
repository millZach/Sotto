import { z } from 'zod'

import { DEFAULT_HOTKEY } from './constants'

export type Theme = 'system' | 'light' | 'dark'
export type ReducedMotion = 'system' | 'on'
/**
 * 'instant' is the bundled default ("Standard" in the UI); 'fast' is the
 * downloadable multilingual Whisper option ("Multi-lingual"). Legacy stored
 * values ('balanced', 'accurate') fail schema parsing and fall back to the
 * default, which migrates old installs automatically.
 */
export type ModelPreset = 'fast' | 'instant'
/** Inference always runs on CPU/WASM; the WebGPU/auto options were removed. */
export type InferencePreference = 'wasm'
export type HistoryRetention = 25 | 100 | 500 | 'unlimited'
export type LlmQuality = 'low' | 'medium' | 'high'

export const SETTINGS_VERSION = 1 as const

type MaxRecordingSeconds = 30 | 60 | 120 | 300

export interface AppSettings {
  version: typeof SETTINGS_VERSION
  theme: Theme
  reducedMotion: ReducedMotion
  microphoneId: string | null
  hotkey: string
  maxRecordingSeconds: MaxRecordingSeconds
  soundCues: boolean
  modelPreset: ModelPreset
  language: string
  inferencePreference: InferencePreference
  formatWhitespace: boolean
  autoCopy: true
  autoPaste: boolean
  pasteDelayMs: number
  successDisplayMs: number
  launchAtStartup: boolean
  startMinimized: boolean
  showWidgetWhenIdle: boolean
  historyEnabled: boolean
  historyRetention: HistoryRetention
  onboardingComplete: boolean
  llmFormatting: boolean
  llmApiKey: string
  llmDictionary: string
  llmQuality: LlmQuality
  llmTimeoutMs: number
  llmMinWords: number
  streamingAsr: boolean
}

export type SettingsPatch = Partial<
  Omit<AppSettings, 'hotkey' | 'launchAtStartup'>
>

const fieldSchemas = {
  version: z.literal(SETTINGS_VERSION),
  theme: z.enum(['system', 'light', 'dark']),
  reducedMotion: z.enum(['system', 'on']),
  microphoneId: z.string().min(1).nullable(),
  hotkey: z.string().min(1),
  maxRecordingSeconds: z.union([z.literal(30), z.literal(60), z.literal(120), z.literal(300)]),
  soundCues: z.boolean(),
  modelPreset: z.enum(['fast', 'instant']),
  language: z.string().min(1),
  inferencePreference: z.literal('wasm'),
  formatWhitespace: z.boolean(),
  autoCopy: z.literal(true),
  autoPaste: z.boolean(),
  pasteDelayMs: z.number().int().min(50).max(1_000),
  successDisplayMs: z.number().int().min(500).max(5_000),
  launchAtStartup: z.boolean(),
  startMinimized: z.boolean(),
  showWidgetWhenIdle: z.boolean(),
  historyEnabled: z.boolean(),
  historyRetention: z.union([
    z.literal(25),
    z.literal(100),
    z.literal(500),
    z.literal('unlimited'),
  ]),
  onboardingComplete: z.boolean(),
  llmFormatting: z.boolean(),
  llmApiKey: z.string().max(256),
  llmDictionary: z.string().max(4_000),
  llmQuality: z.enum(['low', 'medium', 'high']),
  llmTimeoutMs: z.number().int().min(500).max(10_000),
  llmMinWords: z.number().int().min(0).max(50),
  streamingAsr: z.boolean(),
} satisfies { [Key in keyof AppSettings]: z.ZodType<AppSettings[Key]> }

export const settingsSchema = z.object(fieldSchemas)

export const DEFAULT_SETTINGS: AppSettings = {
  version: SETTINGS_VERSION,
  theme: 'system',
  reducedMotion: 'system',
  microphoneId: null,
  hotkey: DEFAULT_HOTKEY,
  maxRecordingSeconds: 60,
  soundCues: true,
  modelPreset: 'instant',
  language: 'auto',
  inferencePreference: 'wasm',
  formatWhitespace: true,
  autoCopy: true,
  autoPaste: true,
  pasteDelayMs: 150,
  successDisplayMs: 1_400,
  launchAtStartup: false,
  startMinimized: false,
  showWidgetWhenIdle: true,
  historyEnabled: true,
  historyRetention: 100,
  onboardingComplete: false,
  llmFormatting: false,
  llmApiKey: '',
  llmDictionary: '',
  llmQuality: 'low',
  llmTimeoutMs: 2_500,
  llmMinWords: 5,
  streamingAsr: true,
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

function parseField<Key extends keyof AppSettings>(
  input: Record<string, unknown>,
  key: Key,
): AppSettings[Key] {
  const result = fieldSchemas[key].safeParse(input[key])
  return result.success ? (result.data as AppSettings[Key]) : DEFAULT_SETTINGS[key]
}

export function parseSettings(input: unknown): AppSettings {
  const persisted = isRecord(input) ? input : {}

  return {
    version: parseField(persisted, 'version'),
    theme: parseField(persisted, 'theme'),
    reducedMotion: parseField(persisted, 'reducedMotion'),
    microphoneId: parseField(persisted, 'microphoneId'),
    hotkey: parseField(persisted, 'hotkey'),
    maxRecordingSeconds: parseField(persisted, 'maxRecordingSeconds'),
    soundCues: parseField(persisted, 'soundCues'),
    modelPreset: parseField(persisted, 'modelPreset'),
    language: parseField(persisted, 'language'),
    inferencePreference: parseField(persisted, 'inferencePreference'),
    formatWhitespace: parseField(persisted, 'formatWhitespace'),
    autoCopy: parseField(persisted, 'autoCopy'),
    autoPaste: parseField(persisted, 'autoPaste'),
    pasteDelayMs: parseField(persisted, 'pasteDelayMs'),
    successDisplayMs: parseField(persisted, 'successDisplayMs'),
    launchAtStartup: parseField(persisted, 'launchAtStartup'),
    startMinimized: parseField(persisted, 'startMinimized'),
    showWidgetWhenIdle: parseField(persisted, 'showWidgetWhenIdle'),
    historyEnabled: parseField(persisted, 'historyEnabled'),
    historyRetention: parseField(persisted, 'historyRetention'),
    onboardingComplete: parseField(persisted, 'onboardingComplete'),
    llmFormatting: parseField(persisted, 'llmFormatting'),
    llmApiKey: parseField(persisted, 'llmApiKey'),
    llmDictionary: parseField(persisted, 'llmDictionary'),
    llmQuality: parseField(persisted, 'llmQuality'),
    llmTimeoutMs: parseField(persisted, 'llmTimeoutMs'),
    llmMinWords: parseField(persisted, 'llmMinWords'),
    streamingAsr: parseField(persisted, 'streamingAsr'),
  }
}
