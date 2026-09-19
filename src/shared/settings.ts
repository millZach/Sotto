import { z } from 'zod'

import { DEFAULT_HOTKEY } from './constants'
import {
  APPEARANCE_CONTRAST,
  DEFAULT_THEME_ID,
  GLASS_OPACITY,
  customThemesSchema,
  isThemeId,
  parseCustomThemes,
  resolveThemeHalfId,
  type ThemeDefinition,
} from './themes/library'

/** The floating widget's scheme; it follows the system and the main window never reads it. */
export type Theme = 'system' | 'light' | 'dark'
/** The main window's appearance mode. `system` follows the operating system scheme live. */
export type Appearance = 'system' | 'light' | 'dark'
export const APPEARANCES = ['system', 'light', 'dark'] as const satisfies readonly Appearance[]
export type ReducedMotion = 'system' | 'on'
export type HistoryRetention = 25 | 100 | 500 | 'unlimited'
export type LlmQuality = 'low' | 'medium' | 'value' | 'high'

/**
 * The models offered for Sotto's short writing jobs: thread titles, commit
 * message drafts and pull request drafts. They are the same cheap, fast
 * OpenRouter models the cleanup tiers use, named here so the choice is one
 * setting rather than one per job.
 */
export const WRITING_MODELS = [
  { id: 'google/gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite — fastest' },
  { id: 'inception/mercury-2', label: 'Mercury 2' },
  { id: 'amazon/nova-2-lite-v1', label: 'Nova 2 Lite' },
  { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5 — best writing' },
] as const
export type WritingModelId = (typeof WRITING_MODELS)[number]['id']
export const WRITING_MODEL_IDS = WRITING_MODELS.map(model => model.id) as unknown as [WritingModelId, ...WritingModelId[]]

export const SETTINGS_VERSION = 1 as const

/**
 * What a renderer receives in place of a saved API key. The key itself stays in
 * the operating system credential store, so every surface that shows the field
 * has to recognize this stand-in rather than treat it as a key the user typed.
 */
export const STORED_CREDENTIAL_PLACEHOLDER = 'Saved in your operating system credential store'

type MaxRecordingSeconds = 30 | 60 | 120 | 300

export interface AppSettings {
  version: typeof SETTINGS_VERSION
  /** Feeds the widget snapshot only; the main window's look is `appearance` and its themes. */
  theme: Theme
  appearance: Appearance
  /** The theme that paints the main window when it resolves to light. */
  lightTheme: string
  /** The theme that paints the main window when it resolves to dark. */
  darkTheme: string
  /** Foreground and border strength, 50-200 percent of the theme's own. */
  appearanceContrast: number
  /** How solid dialogs, menus and floating panels are, 40-100 percent. */
  glassOpacity: number
  /** Themes the user created, duplicated or imported, already canonical. */
  customThemes: ThemeDefinition[]
  webLinkDestination: 'external' | 'embedded'
  /** `live` draws assistant text as it streams; `complete` shows each reply once it is finished. Activity is always live. */
  responseStreaming: 'live' | 'complete'
  /** Applies only to new threads; existing provider sessions keep their working folder. */
  threadWorkingCopyDefault: 'shared' | 'independent'
  /** Explicit project overrides; an absent key inherits the global default. */
  projectThreadWorkingCopyDefaults: Record<string, 'shared' | 'independent'>
  reducedMotion: ReducedMotion
  microphoneId: string | null
  hotkey: string
  maxRecordingSeconds: MaxRecordingSeconds
  soundCues: boolean
  language: string
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
  /**
   * Set when setup was finished without a working microphone. The dictation
   * surfaces say so instead of failing, and the microphone test in Settings
   * clears it. Older settings files have no such field and load as `false`.
   */
  microphoneSkipped: boolean
  llmFormatting: boolean
  /** OpenRouter key shared by transcription and AI cleanup; stored in the formatting credential slot. */
  llmApiKey: string
  llmDictionary: string
  llmQuality: LlmQuality
  llmTimeoutMs: number
  llmMinWords: number
  /** The OpenRouter model that writes Sotto's short text, starting with thread titles. */
  writingModel: WritingModelId
  /** Off stops thread-title and temporary-worktree-branch naming requests. */
  threadTitles: boolean
  /** Off stops every pull request draft; the form opens with the fields it would have had anyway. */
  pullRequestText: boolean
  /** Off stops every commit-message draft; the commit form opens empty. */
  commitMessages: boolean
  streamingAsr: boolean
  autoUpdateCheck: boolean
  /**
   * The voice coordinator (the wake phrase, the Agents room, spoken hints, the
   * widget's voice controls and assignment) is hidden for the beta. Off keeps
   * every one of those surfaces out of the window; dictation is unaffected.
   */
  voiceCoordinatorEnabled: boolean
  /**
   * Whether memory (the Memory page, the questionnaire that greets the Agents
   * room and the preferences retrieved for a turn) is shown at all. Off for
   * the beta; the store and its code stay in place.
   */
  memoryEnabled: boolean
}

export type SettingsPatch = Partial<
  Omit<AppSettings, 'hotkey' | 'launchAtStartup'>
> & {
  /**
   * @deprecated The accent was replaced by themes (ADR-0011). A patch that
   * still carries it is accepted and the value ignored, so an older caller
   * cannot fail a whole save over it.
   */
  accent?: string
}

const fieldSchemas = {
  version: z.literal(SETTINGS_VERSION),
  theme: z.enum(['system', 'light', 'dark']),
  appearance: z.enum(APPEARANCES),
  lightTheme: z.string().refine(isThemeId),
  darkTheme: z.string().refine(isThemeId),
  appearanceContrast: z.number().int().min(APPEARANCE_CONTRAST.min).max(APPEARANCE_CONTRAST.max).refine(value => value % APPEARANCE_CONTRAST.step === 0),
  glassOpacity: z.number().int().min(GLASS_OPACITY.min).max(GLASS_OPACITY.max).refine(value => value % GLASS_OPACITY.step === 0),
  customThemes: customThemesSchema as z.ZodType<ThemeDefinition[]>,
  webLinkDestination: z.enum(['external', 'embedded']),
  responseStreaming: z.enum(['live', 'complete']),
  reducedMotion: z.enum(['system', 'on']),
  microphoneId: z.string().min(1).nullable(),
  hotkey: z.string().min(1),
  maxRecordingSeconds: z.union([z.literal(30), z.literal(60), z.literal(120), z.literal(300)]),
  soundCues: z.boolean(),
  language: z.string().min(1),
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
  microphoneSkipped: z.boolean(),
  llmFormatting: z.boolean(),
  llmApiKey: z.string().max(256),
  llmDictionary: z.string().max(4_000),
  llmQuality: z.enum(['low', 'medium', 'value', 'high']),
  llmTimeoutMs: z.number().int().min(500).max(10_000),
  llmMinWords: z.number().int().min(0).max(50),
  writingModel: z.enum(WRITING_MODEL_IDS),
  threadTitles: z.boolean(),
  threadWorkingCopyDefault: z.enum(['shared', 'independent']),
  projectThreadWorkingCopyDefaults: z.record(z.string().min(1).max(256), z.enum(['shared', 'independent'])),
  pullRequestText: z.boolean(),
  commitMessages: z.boolean(),
  streamingAsr: z.boolean(),
  autoUpdateCheck: z.boolean(),
  voiceCoordinatorEnabled: z.boolean(),
  memoryEnabled: z.boolean(),
} satisfies { [Key in keyof AppSettings]: z.ZodType<AppSettings[Key]> }

export const settingsSchema = z.object(fieldSchemas)

export const DEFAULT_SETTINGS: AppSettings = {
  version: SETTINGS_VERSION,
  theme: 'system',
  // Dark is the mode every install had before appearance became a choice, so
  // an upgraded settings file keeps its mode (ADR-0009). The palette is a theme
  // per half; both start on Tide and the old accent is dropped (ADR-0011).
  appearance: 'dark',
  lightTheme: DEFAULT_THEME_ID,
  darkTheme: DEFAULT_THEME_ID,
  appearanceContrast: APPEARANCE_CONTRAST.default,
  glassOpacity: GLASS_OPACITY.default,
  customThemes: [],
  webLinkDestination: 'external',
  responseStreaming: 'live',
  reducedMotion: 'system',
  microphoneId: null,
  hotkey: DEFAULT_HOTKEY,
  maxRecordingSeconds: 60,
  soundCues: true,
  language: 'auto',
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
  microphoneSkipped: false,
  llmFormatting: false,
  llmApiKey: '',
  llmDictionary: '',
  llmQuality: 'low',
  llmTimeoutMs: 2_500,
  llmMinWords: 5,
  writingModel: 'google/gemini-3.1-flash-lite',
  // On by default, but nothing is ever requested without an OpenRouter key, so
  // an install that never configures one keeps its stand-in names offline.
  threadTitles: true,
  threadWorkingCopyDefault: 'shared',
  projectThreadWorkingCopyDefaults: {},
  pullRequestText: true,
  // On by default for the same reason: with no OpenRouter key nothing is ever
  // requested, and the commit form simply opens empty.
  commitMessages: true,
  streamingAsr: true,
  // On by default: an install that never opens Settings still learns about a
  // fix. The check asks GitHub for a version number and sends nothing else,
  // and turning it off stops the request entirely.
  autoUpdateCheck: true,
  // Off for the beta: the voice coordinator is not ready to ship, so nothing
  // voice-shaped is shown until it is turned on here.
  voiceCoordinatorEnabled: false,
  // Off for the beta: memory does not ship in the first one.
  memoryEnabled: false,
}

/**
 * The defaults for one platform. Only the hotkey differs today, and the caller
 * supplies it from the platform profile so this module stays platform-free.
 */
export function defaultSettings(defaultHotkey: string): AppSettings {
  return { ...DEFAULT_SETTINGS, hotkey: defaultHotkey }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

function parseField<Key extends keyof AppSettings>(
  input: Record<string, unknown>,
  key: Key,
  defaults: AppSettings,
): AppSettings[Key] {
  const result = fieldSchemas[key].safeParse(input[key])
  return result.success ? (result.data as AppSettings[Key]) : defaults[key]
}

export function parseSettings(input: unknown, defaults: AppSettings = DEFAULT_SETTINGS): AppSettings {
  const persisted = isRecord(input) ? input : {}
  // The library is read leniently, one theme at a time, so a single damaged
  // entry never costs the user the rest of their themes. A half naming a theme
  // that is gone, or that cannot paint that half, lands on the default.
  const customThemes = Array.isArray(persisted.customThemes)
    ? parseCustomThemes(persisted.customThemes)
    : [...defaults.customThemes]
  const half = (key: 'lightTheme' | 'darkTheme'): string =>
    resolveThemeHalfId(parseField(persisted, key, defaults), key === 'lightTheme' ? 'light' : 'dark', customThemes)

  return {
    version: parseField(persisted, 'version', defaults),
    theme: parseField(persisted, 'theme', defaults),
    appearance: parseField(persisted, 'appearance', defaults),
    lightTheme: half('lightTheme'),
    darkTheme: half('darkTheme'),
    appearanceContrast: parseField(persisted, 'appearanceContrast', defaults),
    glassOpacity: parseField(persisted, 'glassOpacity', defaults),
    customThemes,
    webLinkDestination: parseField(persisted, 'webLinkDestination', defaults),
    responseStreaming: parseField(persisted, 'responseStreaming', defaults),
    reducedMotion: parseField(persisted, 'reducedMotion', defaults),
    microphoneId: parseField(persisted, 'microphoneId', defaults),
    hotkey: parseField(persisted, 'hotkey', defaults),
    maxRecordingSeconds: parseField(persisted, 'maxRecordingSeconds', defaults),
    soundCues: parseField(persisted, 'soundCues', defaults),
    language: parseField(persisted, 'language', defaults),
    formatWhitespace: parseField(persisted, 'formatWhitespace', defaults),
    autoCopy: parseField(persisted, 'autoCopy', defaults),
    autoPaste: parseField(persisted, 'autoPaste', defaults),
    pasteDelayMs: parseField(persisted, 'pasteDelayMs', defaults),
    successDisplayMs: parseField(persisted, 'successDisplayMs', defaults),
    launchAtStartup: parseField(persisted, 'launchAtStartup', defaults),
    startMinimized: parseField(persisted, 'startMinimized', defaults),
    showWidgetWhenIdle: parseField(persisted, 'showWidgetWhenIdle', defaults),
    historyEnabled: parseField(persisted, 'historyEnabled', defaults),
    historyRetention: parseField(persisted, 'historyRetention', defaults),
    onboardingComplete: parseField(persisted, 'onboardingComplete', defaults),
    microphoneSkipped: parseField(persisted, 'microphoneSkipped', defaults),
    llmFormatting: parseField(persisted, 'llmFormatting', defaults),
    llmApiKey: parseField(persisted, 'llmApiKey', defaults),
    llmDictionary: parseField(persisted, 'llmDictionary', defaults),
    llmQuality: parseField(persisted, 'llmQuality', defaults),
    llmTimeoutMs: parseField(persisted, 'llmTimeoutMs', defaults),
    llmMinWords: parseField(persisted, 'llmMinWords', defaults),
    writingModel: parseField(persisted, 'writingModel', defaults),
    threadTitles: parseField(persisted, 'threadTitles', defaults),
    threadWorkingCopyDefault: parseField(persisted, 'threadWorkingCopyDefault', defaults),
    projectThreadWorkingCopyDefaults: parseField(persisted, 'projectThreadWorkingCopyDefaults', defaults),
    pullRequestText: parseField(persisted, 'pullRequestText', defaults),
    commitMessages: parseField(persisted, 'commitMessages', defaults),
    streamingAsr: parseField(persisted, 'streamingAsr', defaults),
    autoUpdateCheck: parseField(persisted, 'autoUpdateCheck', defaults),
    voiceCoordinatorEnabled: parseField(persisted, 'voiceCoordinatorEnabled', defaults),
    memoryEnabled: parseField(persisted, 'memoryEnabled', defaults),
  }
}
