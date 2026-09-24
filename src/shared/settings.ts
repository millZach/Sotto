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
/**
 * The effort colourway: the colour a thread's effort control turns at a model's highest level, in the
 * composer and in Settings. `ember` and `accent` derive from theme roles; the rest are fixed palettes (ADR-0019).
 */
export type EffortColor = 'ember' | 'cyberpunk' | 'rainbow' | 'aurora' | 'plasma' | 'accent'
export const EFFORT_COLORS = ['ember', 'cyberpunk', 'rainbow', 'aurora', 'plasma', 'accent'] as const satisfies readonly EffortColor[]
export const EFFORT_COLOR_LABELS: Record<EffortColor, string> = { ember: 'Ember', cyberpunk: 'Cyberpunk', rainbow: 'Rainbow', aurora: 'Aurora', plasma: 'Plasma', accent: 'Theme accent' }
export type HistoryRetention = 25 | 100 | 500 | 'unlimited'
export type LlmQuality = 'low' | 'medium' | 'value' | 'high'

/**
 * The rules under which Sotto reclaims a thread's worktree on its own (ADR-0019), the same four
 * T3 Code offers. `afterDays` counts idle days since the thread's last activity; `null` is never.
 * `unchanged` means the folder's commits are all in the repository's default branch already;
 * `merged` means GitHub reports the branch's pull request merged; `onSettle` reclaims when the
 * thread is settled. Each applies only to a clean folder with nothing in it but installed dependencies.
 */
export interface WorktreeCleanupRules {
  afterDays: WorktreeCleanupDays
  merged: boolean
  onSettle: boolean
  unchanged: boolean
}
export type WorktreeCleanupDays = null | 7 | 14 | 30 | 90
export const WORKTREE_CLEANUP_DAYS = [7, 14, 30, 90] as const satisfies readonly Exclude<WorktreeCleanupDays, null>[]
export const worktreeCleanupRulesSchema = z.object({
  afterDays: z.union([z.null(), z.literal(7), z.literal(14), z.literal(30), z.literal(90)]),
  merged: z.boolean(), onSettle: z.boolean(), unchanged: z.boolean(),
}) satisfies z.ZodType<WorktreeCleanupRules>
export const DEFAULT_WORKTREE_CLEANUP: WorktreeCleanupRules = { afterDays: null, merged: false, onSettle: false, unchanged: false }

/** Seconds between background fetches of a project's origin remote, while the window is in front. Zero turns the fetch off. */
export type GitFetchIntervalSeconds = 0 | 15 | 30 | 60 | 300
export const GIT_FETCH_INTERVAL_SECONDS = [0, 15, 30, 60, 300] as const satisfies readonly GitFetchIntervalSeconds[]

/** How GitHub merges a pull request, in `gh pr merge`'s own terms. */
export type GitMergeMethod = 'merge' | 'squash' | 'rebase'
export const GIT_MERGE_METHODS = ['merge', 'squash', 'rebase'] as const satisfies readonly GitMergeMethod[]
export const GIT_MERGE_METHOD_LABELS: Record<GitMergeMethod, string> = { merge: 'Merge', squash: 'Squash and merge', rebase: 'Rebase and merge' }
/** The merge method a pull request's merge starts on; `last` reuses the one chosen last on this computer, as T3 Code does. */
export type DefaultMergeMethod = 'last' | GitMergeMethod
export const DEFAULT_MERGE_METHODS = ['last', ...GIT_MERGE_METHODS] as const satisfies readonly DefaultMergeMethod[]
/** How Changes lays out a file's diff: one column, or before and after side by side. */
export type DiffLayout = 'stacked' | 'split'
/** Whether each file in Changes starts open or folded to its header. */
export type DiffFileState = 'expanded' | 'collapsed'
/**
 * The style commit messages and pull request text are written in: the repository's own (its recent
 * subjects and its `AGENTS.md`), Conventional Commits, or the user's own instructions, T3 Code's three.
 */
export type GitWritingStyle = 'repository' | 'conventional' | 'custom'
export const GIT_WRITING_STYLES = ['repository', 'conventional', 'custom'] as const satisfies readonly GitWritingStyle[]
export const GIT_WRITING_INSTRUCTIONS_MAX_CHARACTERS = 2_000

/** The merge method a merge starts on: the chosen default, or the one used last when the default is Last selected. */
export function initialMergeMethod(settings: Pick<AppSettings, 'defaultMergeMethod' | 'lastMergeMethod'>): GitMergeMethod {
  return settings.defaultMergeMethod === 'last' ? settings.lastMergeMethod : settings.defaultMergeMethod
}

/**
 * What to save when the user merges with `method`: it is remembered only while the default is Last
 * selected, and only when it differs from the one already remembered. Null when there is nothing to save.
 */
export function mergeMethodChosenPatch(settings: Pick<AppSettings, 'defaultMergeMethod' | 'lastMergeMethod'>, method: GitMergeMethod): SettingsPatch | null {
  return settings.defaultMergeMethod === 'last' && settings.lastMergeMethod !== method ? { lastMergeMethod: method } : null
}

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
  /** The colour the effort control turns at a model's highest level. */
  effortColor: EffortColor
  /** Themes the user created, duplicated or imported, already canonical. */
  customThemes: ThemeDefinition[]
  webLinkDestination: 'external' | 'embedded'
  /** `live` draws assistant text as it streams; `complete` shows each reply once it is finished. Activity is always live. */
  responseStreaming: 'live' | 'complete'
  /** Whether a browser task introduces itself in the corner of the Threads page. Off hides only the preview; the work and Tools > Browser carry on. */
  showBrowserPreviews: boolean
  /** Applies only to new threads; existing provider sessions keep their working folder. */
  threadWorkingCopyDefault: 'shared' | 'independent'
  /** Explicit project overrides; an absent key inherits the global default. */
  projectThreadWorkingCopyDefaults: Record<string, 'shared' | 'independent'>
  /**
   * When Sotto may reclaim a thread's worktree on its own (ADR-0019). Every rule
   * is off by default, and none of them ever removes uncommitted work.
   */
  worktreeCleanup: WorktreeCleanupRules
  /**
   * How often the host fetches a project's origin remote so a thread's branch knows whether it is
   * ahead or behind, the way T3 Code does. Only while the window is in front; zero turns it off.
   */
  gitFetchIntervalSeconds: GitFetchIntervalSeconds
  /**
   * Off by default. On, the host fast-forwards a thread's folder when it is on the default branch, clean,
   * and behind with nothing of its own ahead, each time it reads the remote status (T3 Code's rule).
   */
  gitAutoPull: boolean
  /** The merge method a pull request's merge starts on; `last` reuses `lastMergeMethod`. */
  defaultMergeMethod: DefaultMergeMethod
  /** The merge method chosen last, kept while `defaultMergeMethod` is `last`. */
  lastMergeMethod: GitMergeMethod
  /** How Changes lays out a diff until the user changes it there. */
  diffLayout: DiffLayout
  /** Whether Changes hides whitespace-only edits until the user changes it there. */
  diffHideWhitespace: boolean
  /** Whether each file in Changes starts expanded or collapsed. */
  diffFileState: DiffFileState
  /** The style commit messages and pull request text are written in (ADR-0026's side calls). */
  gitWritingStyle: GitWritingStyle
  /** The user's own instructions for that writing, used while the style is `custom`. */
  gitWritingInstructions: string
  /** Whether pull request text fills in the repository's pull request template when it has one. */
  followPullRequestTemplates: boolean
  /**
   * Off by default. On, a thread whose branch's pull request GitHub reports merged is settled, checked on
   * the worktree cleanup's hourly schedule. Settling removes no folder unless a cleanup rule says so.
   */
  autoSettleMergedThreads: boolean
  /** Off by default. On, Changes opens on its own after a turn that changed at least 3 files or 50 lines. */
  proactivePanels: boolean
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
  /**
   * Off stops thread-title and temporary-worktree-branch naming requests. Sotto's short writing is a
   * side call to the thread's own provider (ADR-0026); the OpenRouter writing model and its
   * `writingModel` setting are gone, and a settings file that still carries the key parses and drops it.
   */
  threadTitles: boolean
  /** Off stops every pull request draft; the form opens with the fields it would have had anyway. */
  pullRequestText: boolean
  /** Off stops every generated commit message; a commit whose dialog message was left empty takes the stand-in subject. */
  commitMessages: boolean
  streamingAsr: boolean
  autoUpdateCheck: boolean
  /**
   * Whether the agent runtime runs on this computer at all. Read once at
   * startup; off starts no local host after the next restart. Remote hosts
   * still work, dictation is unaffected and no saved data is removed.
   */
  localHostEnabled: boolean
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
  effortColor: z.enum(EFFORT_COLORS),
  customThemes: customThemesSchema as z.ZodType<ThemeDefinition[]>,
  webLinkDestination: z.enum(['external', 'embedded']),
  responseStreaming: z.enum(['live', 'complete']),
  showBrowserPreviews: z.boolean(),
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
  threadTitles: z.boolean(),
  threadWorkingCopyDefault: z.enum(['shared', 'independent']),
  projectThreadWorkingCopyDefaults: z.record(z.string().min(1).max(256), z.enum(['shared', 'independent'])),
  worktreeCleanup: worktreeCleanupRulesSchema,
  gitFetchIntervalSeconds: z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(60), z.literal(300)]),
  gitAutoPull: z.boolean(),
  defaultMergeMethod: z.enum(DEFAULT_MERGE_METHODS),
  lastMergeMethod: z.enum(GIT_MERGE_METHODS),
  diffLayout: z.enum(['stacked', 'split']),
  diffHideWhitespace: z.boolean(),
  diffFileState: z.enum(['expanded', 'collapsed']),
  gitWritingStyle: z.enum(GIT_WRITING_STYLES),
  gitWritingInstructions: z.string().max(GIT_WRITING_INSTRUCTIONS_MAX_CHARACTERS),
  followPullRequestTemplates: z.boolean(),
  autoSettleMergedThreads: z.boolean(),
  proactivePanels: z.boolean(),
  pullRequestText: z.boolean(),
  commitMessages: z.boolean(),
  streamingAsr: z.boolean(),
  autoUpdateCheck: z.boolean(),
  localHostEnabled: z.boolean(),
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
  // Ember is the warning role's gold: the colour the effort control turned before it became a choice.
  effortColor: 'ember',
  customThemes: [],
  webLinkDestination: 'external',
  responseStreaming: 'live',
  showBrowserPreviews: true,
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
  // On by default: the thread's own provider names it, on the account the thread
  // already uses, and a provider that writes nothing (Devin) keeps the stand-in.
  threadTitles: true,
  threadWorkingCopyDefault: 'shared',
  projectThreadWorkingCopyDefaults: {},
  // Off, every rule: a folder is removed only when the user asks or has said in advance that Sotto may.
  worktreeCleanup: DEFAULT_WORKTREE_CLEANUP,
  // T3's default. The fetch contacts only the project's own origin, with prompts off, and only while the window is in front.
  gitFetchIntervalSeconds: 30,
  // Off: a pull changes the user's folder, so it happens on their word until they say otherwise.
  gitAutoPull: false,
  // T3's defaults: the method chosen last, starting from a plain merge.
  defaultMergeMethod: 'last',
  lastMergeMethod: 'merge',
  // T3's diff defaults: stacked, whitespace-only edits hidden, files collapsed to their headers.
  diffLayout: 'stacked',
  diffHideWhitespace: true,
  diffFileState: 'collapsed',
  gitWritingStyle: 'repository',
  gitWritingInstructions: '',
  followPullRequestTemplates: true,
  // Off: nothing moves in the sidebar on its own until the user asks for it.
  autoSettleMergedThreads: false,
  // Off: nothing opens on its own until the user asks for it (ADR-0027).
  proactivePanels: false,
  pullRequestText: true,
  // On by default: when a thread's provider writes nothing, the Git action commits
  // under the stand-in subject "Update project files" rather than waiting.
  commitMessages: true,
  streamingAsr: true,
  // On by default: an install that never opens Settings still learns about a
  // fix. The check asks GitHub for a version number and sends nothing else,
  // and turning it off stops the request entirely.
  autoUpdateCheck: true,
  // On by default: this computer is still the host until the owner pairs a
  // remote one and chooses to run clients only.
  localHostEnabled: true,
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
    effortColor: parseField(persisted, 'effortColor', defaults),
    customThemes,
    webLinkDestination: parseField(persisted, 'webLinkDestination', defaults),
    responseStreaming: parseField(persisted, 'responseStreaming', defaults),
    showBrowserPreviews: parseField(persisted, 'showBrowserPreviews', defaults),
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
    threadTitles: parseField(persisted, 'threadTitles', defaults),
    threadWorkingCopyDefault: parseField(persisted, 'threadWorkingCopyDefault', defaults),
    projectThreadWorkingCopyDefaults: parseField(persisted, 'projectThreadWorkingCopyDefaults', defaults),
    worktreeCleanup: parseField(persisted, 'worktreeCleanup', defaults),
    gitFetchIntervalSeconds: parseField(persisted, 'gitFetchIntervalSeconds', defaults),
    gitAutoPull: parseField(persisted, 'gitAutoPull', defaults),
    defaultMergeMethod: parseField(persisted, 'defaultMergeMethod', defaults),
    lastMergeMethod: parseField(persisted, 'lastMergeMethod', defaults),
    diffLayout: parseField(persisted, 'diffLayout', defaults),
    diffHideWhitespace: parseField(persisted, 'diffHideWhitespace', defaults),
    diffFileState: parseField(persisted, 'diffFileState', defaults),
    gitWritingStyle: parseField(persisted, 'gitWritingStyle', defaults),
    gitWritingInstructions: parseField(persisted, 'gitWritingInstructions', defaults),
    followPullRequestTemplates: parseField(persisted, 'followPullRequestTemplates', defaults),
    autoSettleMergedThreads: parseField(persisted, 'autoSettleMergedThreads', defaults),
    proactivePanels: parseField(persisted, 'proactivePanels', defaults),
    pullRequestText: parseField(persisted, 'pullRequestText', defaults),
    commitMessages: parseField(persisted, 'commitMessages', defaults),
    streamingAsr: parseField(persisted, 'streamingAsr', defaults),
    autoUpdateCheck: parseField(persisted, 'autoUpdateCheck', defaults),
    localHostEnabled: parseField(persisted, 'localHostEnabled', defaults),
    voiceCoordinatorEnabled: parseField(persisted, 'voiceCoordinatorEnabled', defaults),
    memoryEnabled: parseField(persisted, 'memoryEnabled', defaults),
  }
}
