import { z } from 'zod'
import { clearSettledThreadsAfterDaysSchema, type ClearSettledThreadsAfterDays } from './threadClear'
import { OMARCHY_THEME_ID, omarchyThemeSchema, type OmarchyTheme } from './themes/omarchy'

import { DEFAULT_HOTKEY } from './constants'
import { INTERFACE_LANGUAGE_SETTINGS, type InterfaceLanguageSetting } from './interfaceLanguages'
import { DEFAULT_MENU_BAR_OWL_BODY, DEFAULT_MENU_BAR_OWL_EYES, MENU_BAR_OWL_BODIES, MENU_BAR_OWL_EYES, type MenuBarOwlBody, type MenuBarOwlEyes } from './menuBarOwl'
import { DEFAULT_WATCHER_SCENE, WATCHER_SCENES, type WatcherScene } from './watcherScene'
import { COMPOSER_STYLES, DEFAULT_COMPOSER_STYLE, type ComposerStyle } from './composerStyle'
import { parseWorkerRoleChoices, workerRoleChoicesSchema, type WorkerRoleChoices } from './workerRoles'
import { DEFAULT_WORKER_CEILING, DEFAULT_WORKER_MACHINE, workerCeilingSchema, workerMachineCeilingsSchema, workerMachineSettingSchema,
  type WorkerMachineCeilings, type WorkerMachineSetting } from './workerMachine'
import { parseThreadShortcutChoices, threadShortcutChoicesSchema, type ThreadShortcutChoices } from './threadShortcuts'
import { ownCleanupChoiceSchema, type OwnCleanupChoice } from './ownServerCleanup'
import {
  APPEARANCE_CONTRAST,
  DEFAULT_THEME_ID,
  customThemesSchema,
  isThemeId,
  parseSavedThemeLibrary,
  savedThemeHalfId,
  type ThemeDefinition,
} from './themes/library'

/** The floating widget's scheme; it follows the system and the main window never reads it. */
export type Theme = 'system' | 'light' | 'dark'
/** The main window's appearance mode. `system` follows the operating system scheme live. */
export type Appearance = 'system' | 'light' | 'dark'
export const APPEARANCES = ['system', 'light', 'dark'] as const satisfies readonly Appearance[]
export type ReducedMotion = 'system' | 'on'
/** Night falls' two looks (ADR-0119, decision 6): the shipped band, or a line of stars. */
export type RoomTransitionLook = 'band' | 'stars'
export const ROOM_TRANSITION_LOOKS = ['band', 'stars'] as const satisfies readonly RoomTransitionLook[]
/**
 * Compact Watcher at, in tokens: the slider's ends, its step and where it starts. Watcher's conversation is compacted at
 * its next rest once it passes this point (#1189). 400K was Zach's first pick; he asked for the slider in October 2026.
 */
export const WATCHER_COMPACT_AT = { min: 200_000, max: 1_000_000, step: 50_000, default: 400_000 } as const
/**
 * The effort colourway: the colour a thread's effort control turns at a model's highest level, in the
 * composer and in Settings. `ember` and `accent` derive from theme roles; the rest are fixed palettes (ADR-0019).
 */
export type EffortColor = 'ember' | 'cyberpunk' | 'rainbow' | 'aurora' | 'plasma' | 'accent'
export const EFFORT_COLORS = ['ember', 'cyberpunk', 'rainbow', 'aurora', 'plasma', 'accent'] as const satisfies readonly EffortColor[]
export const EFFORT_COLOR_LABELS: Record<EffortColor, string> = { ember: 'Ember', cyberpunk: 'Cyberpunk', rainbow: 'Rainbow', aurora: 'Aurora', plasma: 'Plasma', accent: 'Theme accent' }
/**
 * The little pixel character that stands above a thread's composer while it watches, works or waits: Sotto's own, or
 * Claude bot. It is the same character in every pose, and a choice about how Sotto looks, never about what it claims.
 */
/** Lardo is an Owl feature (`lardo-creature`): a build that holds him neither offers nor shows him, and keeps a saved `lardo` whole. */
export type Creature = 'sotto' | 'claude' | 'lardo'
export const CREATURES = ['sotto', 'claude', 'lardo'] as const satisfies readonly Creature[]
export const CREATURE_LABELS: Record<Creature, string> = { sotto: 'Sotto', claude: 'Claude bot', lardo: 'Lardo' }
export type HistoryRetention = 25 | 100 | 500 | 'unlimited'

/**
 * The rules under which Sotto reclaims a thread's worktree on its own (ADR-0041), the same four
 * T3 Code offers. `afterDays` counts idle days since the thread's last activity; `null` is never.
 * `unchanged` means the folder's commits are all in the repository's default branch already;
 * `merged` means GitHub reports the branch's pull request merged; `onSettle` reclaims when the
 * thread is settled. Each applies only to a clean folder with nothing in it but installed dependencies.
 */
export type LlmMode = 'default' | 'nitro' | 'floor'
export const LLM_MODES = ['default', 'nitro', 'floor'] as const satisfies readonly LlmMode[]

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

/** The bounds of Settings, Dictation, Typing speed, in words per minute. */
export const TYPING_SPEED_MIN_WPM = 10
export const TYPING_SPEED_MAX_WPM = 150

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
  /** The colour the effort control turns at a model's highest level. */
  effortColor: EffortColor
  /** The colour of the menu bar owl's body on a Mac running an Owl build (ADR-0114); kept whole where the feature is off. */
  menuBarOwlBody: MenuBarOwlBody
  /** The colour its eyes glow. */
  menuBarOwlEyes: MenuBarOwlEyes
  /** The place Watcher's night scene is set in (ADR-0149); kept whole where Watcher is off. */
  watcherScene: WatcherScene
  /** How the thread and Watcher composers are drawn (ADR-0166): Zach's two rows unless Drake's pill is chosen. */
  composerStyle: ComposerStyle
  /** Which character stands above the composer; Sotto's own unless Claude bot is chosen. */
  creature: Creature
  /** Off hides the creature and its readout above every composer; the sidebar still says what a thread is doing. */
  showCreature: boolean
  /**
   * The interface language (ADR-0123): `system` follows the computer's language, a code chooses one. Read only while its
   * Owl feature is on; elsewhere Sotto is English and the choice is kept for when the feature returns.
   */
  interfaceLanguage: InterfaceLanguageSetting
  /** Themes the user created, duplicated or imported, already canonical. */
  customThemes: ThemeDefinition[]
  /** Linux-only, read-only palette supplied by main. Never saved or patched. */
  omarchyTheme?: OmarchyTheme | null | undefined
  webLinkDestination: 'external' | 'embedded'
  /** `live` draws assistant text as it streams; `complete` shows each reply once it is finished. Activity is always live. */
  responseStreaming: 'live' | 'complete'
  /** Whether a browser task introduces itself in the corner of the Threads page. Off hides only the preview; the work and Tools > Browser carry on. */
  showBrowserPreviews: boolean
  /** On by default (ADR-0029): a thread opens, navigates, clicks and types in Sotto's browser without asking, until Stop or this turns off. */
  browserWithoutAsking: boolean
  /** On by default (ADR-0056): an agent in a project thread may draw a visual in that thread. Off, new launches get no visual tool and calls are refused; visuals already drawn stay. */
  visualsInThreads: boolean
  /**
   * On by default (ADR-0061 decision 12): an agent in a Claude Code, Codex or Grok Build project thread on this computer
   * may babysit its pull requests with Sotto's tool. Off, new launches get no tool, calls are refused, and what agents
   * started ends at once; what the user started from the Pull request surface stays.
   */
  babysitPullRequests: boolean
  /**
   * On by default, an Owl feature (ADR-0076): a thread working when Sotto closed, for an update, a quit, a crash or a
   * restart of the computer, is sent a resume note when Sotto opens again. Asked once at start.
   */
  resumeThreadsAfterRestart: boolean
  /** Restart stopped threads (ADR-0144, an Owl feature): a thread a usage limit or Sotto closing stopped while it worked
   * carries on when the limit resets or Sotto opens again. Read in place of `resumeThreadsAfterRestart` while the feature is on. */
  restartStoppedThreads: boolean
  /**
   * Worker roles (#1041, an Owl feature): the rows the user chose under Settings, Watcher, by role. A role left out follows
   * its defaults over the providers connected now (`workerRoles.ts`), so nothing here changes when a provider comes or goes.
   */
  workerRoles: WorkerRoleChoices
  /** Concurrent worker starts per machine while worker-swarms is on; saved whole on stable. */
  workerCeiling: number
  workerMachineCeilings: WorkerMachineCeilings
  /**
   * Settle without asking, under Settings, Watcher: on by default, part of Watcher's Owl feature. Watcher decides when a
   * thread it watches is finished; on, it settles that thread without asking, and off, it asks the user on a card first.
   * The key keeps its first name, from when Sotto settled finished threads by its own rule (October 29, 2026). Read live.
   */
  watcherSettlesFinishedThreads: boolean
  /**
   * Where new workers start (#1032), under Settings, Watcher, part of the Owl feature `cross-machine-work`: This computer
   * by default, Watcher's own choice, or a connected machine by its saved host ID. A start that names a machine or a
   * system overrides it for that start. Read when a start or a delegation is placed.
   */
  newWorkerMachine: WorkerMachineSetting
  /**
   * Compact Watcher at, under Settings, Watcher: the size in tokens past which Watcher's conversation is compacted at its
   * next rest, 200K to 1M on a 50K step ({@link WATCHER_COMPACT_AT}). Part of Watcher's Owl feature. Read at every look.
   */
  watcherCompactAtTokens: number
  /**
   * On by default (ADR-0127): a Claude thread with a large context, quiet for 54 minutes, is compacted while its prompt
   * cache is still warm, so the next message re-reads a summary instead of the whole conversation. Read at every sweep.
   */
  compactIdleThreads: boolean
  /** Applies only to new threads; existing provider sessions keep their working folder. */
  threadWorkingCopyDefault: 'shared' | 'independent'
  /** Explicit project overrides; an absent key inherits the global default. */
  projectThreadWorkingCopyDefaults: Record<string, 'shared' | 'independent'>
  /**
   * When Sotto may reclaim a thread's worktree on its own (ADR-0041). Every rule
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
  /**
   * Keep main up to date (ADR-0142, an Owl feature): every 15 minutes and after a pull request merges, the host
   * fast-forwards each project's checkout to its remote's default branch when that branch is checked out and nothing
   * of the user's is in the way. On by default where the feature is on.
   */
  keepMainCurrent: boolean
  /** Explicit project overrides of Keep main up to date, by the same key as the working-copy defaults; an absent key follows it. */
  projectKeepMainCurrent: Record<string, 'on' | 'off'>
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
  /**
   * 30 days by default; null is Never. A number of days, and this computer's settled threads quiet longer than that are
   * cleared on their own at start, every hour and when it changes, beside the worktree cleanup (ADR-0140). Saved on every
   * track; only Owl acts on it until the feature goes to stable.
   */
  clearSettledThreadsAfterDays: ClearSettledThreadsAfterDays
  /** Off by default. On, Changes opens on its own after a turn that changed at least 3 files or 50 lines. */
  proactivePanels: boolean
  reducedMotion: ReducedMotion
  /** On by default. A press anywhere in the main window sends waves of 0s and 1s in the accent through the room behind it. Read only while its Owl feature is on, and never with motion reduced. */
  clickEffect: boolean
  /** On by default. Moving between Dictate or Threads and Watcher's room plays the night falls transition; off, the window swaps in one frame. */
  roomTransition: boolean
  /** How fast that transition plays: 0.5 is half speed, 2 is twice as fast. */
  roomTransitionSpeed: number
  /** How that transition looks: `band`, a band of flickering text characters, or `stars`, a line of stars with a faint trail (ADR-0119, decision 6). */
  roomTransitionLook: RoomTransitionLook
  microphoneId: string | null
  hotkey: string
  /** Further press shortcuts beyond `hotkey`; used only while the Owl feature `dictation-hold-shortcuts` is on. */
  pressShortcuts: string[]
  /** Shortcuts held to talk; used only while the Owl feature `dictation-hold-shortcuts` is on, and kept whole while it is off. */
  holdShortcuts: string[]
  /**
   * The keyboard shortcuts for working in threads the user changed under Settings › Keyboard (ADR-0133), by
   * shortcut. A row left out follows its default (`threadShortcuts.ts`); a row set to null has no shortcut.
   * Read live, so a change in Settings reaches every button and listener at once.
   */
  threadShortcuts: ThreadShortcutChoices
  /** Text size in every terminal, in pixels; changed from the focused terminal's zoom chords. */
  terminalFontSize: number
  /**
   * Dictation is always cut at pauses and transcribed on this computer, by a model that works out
   * the language itself (ADR-0071), so the `language` and `streamingAsr` settings are gone; a
   * settings file that still carries either parses and drops it.
   */
  maxRecordingSeconds: MaxRecordingSeconds
  soundCues: boolean
  /** How fast the user types, in words per minute: the Dictate room counts time saved against it. */
  typingSpeedWpm: number
  /**
   * The model that transcribes dictation, by its picker id, or null until the user chooses one.
   * Nothing downloads before then. Main writes it when the user chooses on the picker or in setup.
   */
  speechModel: string | null
  formatWhitespace: boolean
  autoCopy: true
  autoPaste: boolean
  pasteDelayMs: number
  successDisplayMs: number
  launchAtStartup: boolean
  startMinimized: boolean
  showWidgetWhenIdle: boolean
  /** Off when the user dictates with another app: no hotkey, speech model, widget or Dictate room (Owl, ADR-0107). */
  dictationEnabled: boolean
  /**
   * On, an OpenRouter speech model transcribes dictation instead of this computer's, with the OpenRouter key AI cleanup
   * uses, and the speech model here is unloaded. An Owl feature (ADR-0160): stable ignores it and keeps it.
   */
  cloudTranscription: boolean
  /** The OpenRouter speech model cloud transcription uses, by its slug, or null for the first in Sotto's ranking. */
  cloudSpeechModel: string | null
  /** A notification when a thread asks a question or for permission and the window is not showing it (Owl, macOS, ADR-0117). */
  notifyNeedsYou: boolean
  /** A notification when a thread has wrapped up: finished everything, nothing left running or waiting (Owl, macOS, ADR-0117). */
  notifyFinished: boolean
  /** Linux-only, read-only, supplied by main: the shell pill has taken the floating widget's place. Never saved or patched. */
  shellPillInUse?: boolean | undefined
  historyEnabled: boolean
  historyRetention: HistoryRetention
  onboardingComplete: boolean
  /**
   * Set when setup was finished without a working microphone. The dictation
   * surfaces say so instead of failing, and the microphone test in Settings
   * clears it. Older settings files have no such field and load as `false`.
   */
  microphoneSkipped: boolean
  /**
   * AI cleanup on or off. One model does every cleanup (ADR-0069); the `llmQuality` tier
   * picker is gone, and a settings file that still carries the key parses and drops it.
   */
  llmFormatting: boolean
  /** OpenRouter key shared by transcription and AI cleanup; stored in the formatting credential slot. */
  llmApiKey: string
  llmDictionary: string
  llmTimeoutMs: number
  llmMinWords: number
  /**
   * The OpenRouter model that cleans up dictation, by its slug, or null for Sotto's own choice
   * (ADR-0069's Claude Haiku 5.5). An Owl feature (ADR-0122): stable ignores it and keeps it.
   */
  llmModel: string | null
  /** How OpenRouter picks a host for the cleanup model: its own way, the fastest host (`:nitro`) or the cheapest (`:floor`). */
  llmMode: LlmMode
  /**
   * A model on one of the user's own model servers that cleans up dictation instead of `llmModel`, by the server's and the
   * model's saved IDs, or null. An Owl feature (ADR-0136): with it off the choice is kept and ignored.
   */
  llmOwnModel: OwnCleanupChoice | null
  /**
   * Off stops thread-title and temporary-worktree-branch naming requests. Sotto's short writing is a
   * side call to the thread's own provider (ADR-0026); the OpenRouter writing model and its
   * `writingModel` setting are gone, and a settings file that still carries the key parses and drops it.
   */
  threadTitles: boolean
  /**
   * After each turn that ends with an answer, ask the thread's own provider for a next prompt (ADR-0132): one short side
   * call per turn. Read only while the `next-prompt` Owl feature is on; off, nothing is asked.
   */
  nextPromptSuggestions: boolean
  /** One tip under a working thread's working line and Watcher's (ADR-0159; Owl only). */
  threadTips: boolean
  /** Off stops every pull request draft; the form opens with the fields it would have had anyway. */
  pullRequestText: boolean
  /** Off stops every generated commit message; a commit whose dialog message was left empty takes the stand-in subject. */
  commitMessages: boolean
  autoUpdateCheck: boolean
  /**
   * The notice beside the window controls while Sotto's main process is frozen (#1233, ADR-0098). Part of the
   * `main-freeze` Owl feature: stable never shows it, whatever this says. Off hides only the notice; Settings >
   * Performance keeps the numbers and Record a minute.
   */
  mainFreezeNotice: boolean
  /**
   * Whether the agent runtime runs on this computer at all. Read once at
   * startup; off starts no local host after the next restart. Remote hosts
   * still work, dictation is unaffected and no saved data is removed.
   */
  localHostEnabled: boolean
  /**
   * Phone access (ADR-0033): paired phones reach this computer's threads over the owner's tailnet.
   * Applies at once; off closes the listener and removes Sotto's Tailscale Serve setting. Needs the
   * local host.
   */
  phoneAccess: boolean
  /** This computer's name as phones show it. Empty uses the Tailscale machine name, or the computer's own. */
  phoneAccessName: string
  /**
   * Host-local, read only by a headless host (ADR-0053): Tailscale Serve carries the host's tailnet listener for paired
   * desktops' tailnet connections while this or `phoneAccess` is on. The host's administrative route sets it; nothing on
   * a desktop does, so it is not on the settings allow-list.
   */
  tailnetConnections: boolean
  /**
   * Whether memory (the Memory page, the questionnaire that greets the Agents
   * room and the preferences retrieved for a turn) is shown at all. Off for
   * the beta; the store and its code stay in place.
   */
  memoryEnabled: boolean
  /** The cloud iPhone's (ADR-0047) monthly minute cap, about run.cloud's free $15 at its default. */
  cloudIphoneMonthlyMinutes: number
  /** Minutes of neither an agent action nor the user's input before a cloud iPhone session ends (ADR-0047). */
  cloudIphoneIdleMinutes: number
}

export type SettingsPatch = Partial<
  Omit<AppSettings, 'hotkey' | 'pressShortcuts' | 'holdShortcuts' | 'launchAtStartup' | 'worktreeCleanup' | 'omarchyTheme' | 'shellPillInUse'>
> & {
  /** Merge only the supplied cleanup rules with the latest saved settings. */
  worktreeCleanup?: Partial<WorktreeCleanupRules>
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
  lightTheme: z.string().refine(value => isThemeId(value) || value === OMARCHY_THEME_ID),
  darkTheme: z.string().refine(value => isThemeId(value) || value === OMARCHY_THEME_ID),
  appearanceContrast: z.number().int().min(APPEARANCE_CONTRAST.min).max(APPEARANCE_CONTRAST.max).refine(value => value % APPEARANCE_CONTRAST.step === 0),
  effortColor: z.enum(EFFORT_COLORS),
  menuBarOwlBody: z.enum(MENU_BAR_OWL_BODIES),
  menuBarOwlEyes: z.enum(MENU_BAR_OWL_EYES),
  watcherScene: z.enum(WATCHER_SCENES),
  composerStyle: z.enum(COMPOSER_STYLES),
  creature: z.enum(CREATURES),
  showCreature: z.boolean(),
  interfaceLanguage: z.enum(INTERFACE_LANGUAGE_SETTINGS),
  omarchyTheme: omarchyThemeSchema.nullable().optional(),
  customThemes: customThemesSchema as z.ZodType<ThemeDefinition[]>,
  webLinkDestination: z.enum(['external', 'embedded']),
  responseStreaming: z.enum(['live', 'complete']),
  showBrowserPreviews: z.boolean(),
  browserWithoutAsking: z.boolean(),
  visualsInThreads: z.boolean(),
  babysitPullRequests: z.boolean(),
  resumeThreadsAfterRestart: z.boolean(),
  restartStoppedThreads: z.boolean(),
  workerRoles: workerRoleChoicesSchema,
  workerCeiling: workerCeilingSchema,
  workerMachineCeilings: workerMachineCeilingsSchema,
  watcherSettlesFinishedThreads: z.boolean(),
  newWorkerMachine: workerMachineSettingSchema,
  watcherCompactAtTokens: z.number().int().min(WATCHER_COMPACT_AT.min).max(WATCHER_COMPACT_AT.max).multipleOf(WATCHER_COMPACT_AT.step),
  compactIdleThreads: z.boolean(),
  reducedMotion: z.enum(['system', 'on']),
  clickEffect: z.boolean(),
  roomTransition: z.boolean(),
  roomTransitionSpeed: z.number().min(0.5).max(2),
  roomTransitionLook: z.enum(ROOM_TRANSITION_LOOKS),
  microphoneId: z.string().min(1).nullable(),
  hotkey: z.string().min(1),
  pressShortcuts: z.array(z.string().min(1).max(64)).max(3),
  holdShortcuts: z.array(z.string().min(1).max(64)).max(4),
  threadShortcuts: threadShortcutChoicesSchema,
  terminalFontSize: z.number().int().min(8).max(32),
  maxRecordingSeconds: z.union([z.literal(30), z.literal(60), z.literal(120), z.literal(300)]),
  soundCues: z.boolean(),
  typingSpeedWpm: z.number().int().min(TYPING_SPEED_MIN_WPM).max(TYPING_SPEED_MAX_WPM),
  speechModel: z.string().min(1).max(128).nullable(),
  formatWhitespace: z.boolean(),
  autoCopy: z.literal(true),
  autoPaste: z.boolean(),
  pasteDelayMs: z.number().int().min(50).max(1_000),
  successDisplayMs: z.number().int().min(500).max(5_000),
  launchAtStartup: z.boolean(),
  startMinimized: z.boolean(),
  showWidgetWhenIdle: z.boolean(),
  dictationEnabled: z.boolean(),
  cloudTranscription: z.boolean(),
  cloudSpeechModel: z.string().regex(/^[\w.\-/:~]{1,128}$/u).nullable(),
  notifyNeedsYou: z.boolean(),
  notifyFinished: z.boolean(),
  shellPillInUse: z.boolean().optional(),
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
  llmTimeoutMs: z.number().int().min(500).max(10_000),
  llmMinWords: z.number().int().min(0).max(50),
  llmModel: z.string().regex(/^[\w.\-/:]{1,128}$/u).nullable(),
  llmMode: z.enum(LLM_MODES),
  llmOwnModel: ownCleanupChoiceSchema.nullable(),
  threadTitles: z.boolean(),
  nextPromptSuggestions: z.boolean(),
  threadTips: z.boolean(),
  threadWorkingCopyDefault: z.enum(['shared', 'independent']),
  projectThreadWorkingCopyDefaults: z.record(z.string().min(1).max(256), z.enum(['shared', 'independent'])),
  worktreeCleanup: worktreeCleanupRulesSchema,
  gitFetchIntervalSeconds: z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(60), z.literal(300)]),
  gitAutoPull: z.boolean(),
  keepMainCurrent: z.boolean(),
  projectKeepMainCurrent: z.record(z.string().min(1).max(256), z.enum(['on', 'off'])),
  defaultMergeMethod: z.enum(DEFAULT_MERGE_METHODS),
  lastMergeMethod: z.enum(GIT_MERGE_METHODS),
  diffLayout: z.enum(['stacked', 'split']),
  diffHideWhitespace: z.boolean(),
  diffFileState: z.enum(['expanded', 'collapsed']),
  gitWritingStyle: z.enum(GIT_WRITING_STYLES),
  gitWritingInstructions: z.string().max(GIT_WRITING_INSTRUCTIONS_MAX_CHARACTERS),
  followPullRequestTemplates: z.boolean(),
  autoSettleMergedThreads: z.boolean(),
  clearSettledThreadsAfterDays: clearSettledThreadsAfterDaysSchema,
  proactivePanels: z.boolean(),
  pullRequestText: z.boolean(),
  commitMessages: z.boolean(),
  autoUpdateCheck: z.boolean(),
  mainFreezeNotice: z.boolean(),
  localHostEnabled: z.boolean(),
  phoneAccess: z.boolean(),
  phoneAccessName: z.string().trim().max(63),
  tailnetConnections: z.boolean(),
  memoryEnabled: z.boolean(),
  cloudIphoneMonthlyMinutes: z.number().int().min(10).max(100_000),
  cloudIphoneIdleMinutes: z.number().int().min(1).max(60),
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
  // Ember is the warning role's gold: the colour the effort control turned before it became a choice.
  effortColor: 'ember',
  menuBarOwlBody: DEFAULT_MENU_BAR_OWL_BODY,
  menuBarOwlEyes: DEFAULT_MENU_BAR_OWL_EYES,
  watcherScene: DEFAULT_WATCHER_SCENE,
  composerStyle: DEFAULT_COMPOSER_STYLE,
  creature: 'sotto',
  showCreature: true,
  interfaceLanguage: 'system',
  customThemes: [],
  webLinkDestination: 'external',
  responseStreaming: 'live',
  showBrowserPreviews: true,
  browserWithoutAsking: true,
  visualsInThreads: true,
  babysitPullRequests: true,
  resumeThreadsAfterRestart: true,
  restartStoppedThreads: true,
  workerRoles: {},
  workerCeiling: DEFAULT_WORKER_CEILING,
  workerMachineCeilings: {},
  watcherSettlesFinishedThreads: true,
  newWorkerMachine: DEFAULT_WORKER_MACHINE,
  watcherCompactAtTokens: WATCHER_COMPACT_AT.default,
  compactIdleThreads: true,
  reducedMotion: 'system',
  clickEffect: true,
  roomTransition: true,
  roomTransitionSpeed: 1,
  roomTransitionLook: 'band',
  microphoneId: null,
  hotkey: DEFAULT_HOTKEY,
  pressShortcuts: [],
  holdShortcuts: [],
  // Nothing chosen: every thread shortcut follows its default until the user changes one in Settings › Keyboard.
  threadShortcuts: {},
  terminalFontSize: 13,
  maxRecordingSeconds: 60,
  soundCues: true,
  typingSpeedWpm: 40,
  speechModel: null,
  formatWhitespace: true,
  autoCopy: true,
  autoPaste: true,
  pasteDelayMs: 150,
  successDisplayMs: 1_400,
  launchAtStartup: false,
  startMinimized: false,
  showWidgetWhenIdle: true,
  dictationEnabled: true,
  cloudTranscription: false,
  cloudSpeechModel: null,
  notifyNeedsYou: true,
  notifyFinished: true,
  historyEnabled: true,
  historyRetention: 100,
  onboardingComplete: false,
  microphoneSkipped: false,
  llmFormatting: false,
  llmApiKey: '',
  llmDictionary: '',
  llmTimeoutMs: 2_500,
  llmMinWords: 5,
  llmModel: null,
  llmMode: 'default',
  llmOwnModel: null,
  // On by default: the thread's own provider names it, on the account the thread
  // already uses, and a provider that writes nothing (Devin) keeps the stand-in.
  threadTitles: true,
  nextPromptSuggestions: true,
  threadTips: true,
  threadWorkingCopyDefault: 'shared',
  projectThreadWorkingCopyDefaults: {},
  // Off, every rule: a folder is removed only when the user asks or has said in advance that Sotto may.
  worktreeCleanup: DEFAULT_WORKTREE_CLEANUP,
  // T3's default. The fetch contacts only the project's own origin, with prompts off, and only while the window is in front.
  gitFetchIntervalSeconds: 30,
  // Off: a pull changes the user's folder, so it happens on their word until they say otherwise.
  gitAutoPull: false,
  // On: a fast-forward of a checkout on its default branch with nothing of the user's in the way loses nothing (ADR-0142).
  keepMainCurrent: true,
  projectKeepMainCurrent: {},
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
  // 30 days, Zach's pick on October 25, 2026 (ADR-0140); Never stays a choice.
  clearSettledThreadsAfterDays: 30,
  // Off: nothing opens on its own until the user asks for it (ADR-0027).
  proactivePanels: false,
  pullRequestText: true,
  // On by default: when a thread's provider writes nothing, the Git action commits
  // under the stand-in subject "Update project files" rather than waiting.
  commitMessages: true,
  // On by default: an install that never opens Settings still learns about a
  // fix. The check asks GitHub for a version number and sends nothing else,
  // and turning it off stops the request entirely.
  autoUpdateCheck: true,
  // On by default: a freeze is worth hearing about until the owner says otherwise.
  mainFreezeNotice: true,
  // On by default: this computer is still the host until the owner pairs a
  // remote one and chooses to run clients only.
  localHostEnabled: true,
  // Off by default: nothing listens beyond this computer until the owner turns it on (ADR-0033).
  phoneAccess: false,
  phoneAccessName: '',
  // Off until a desktop turns it on over SSH, at Add host or in Edit connection (ADR-0053).
  tailnetConnections: false,
  // Off for the beta: memory does not ship in the first one.
  memoryEnabled: false,
  // About run.cloud's free $15 a month at its $0.02-a-minute price (ADR-0047).
  cloudIphoneMonthlyMinutes: 750,
  cloudIphoneIdleMinutes: 5,
}

/**
 * The defaults for one platform. Only the shortcuts differ today, and the caller
 * supplies them from the platform profile so this module stays platform-free.
 */
export function defaultSettings(defaultHotkey: string, defaultHoldShortcuts: readonly string[] = []): AppSettings {
  return { ...DEFAULT_SETTINGS, hotkey: defaultHotkey, holdShortcuts: [...defaultHoldShortcuts] }
}

/** Entry by entry, so one damaged shortcut costs only itself; a damaged list holds nothing rather than a default. */
function parseShortcutList(input: unknown, max: number): string[] {
  if (!Array.isArray(input)) return []
  const entries = input.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0 && entry.length <= 64)
  return [...new Set(entries)].slice(0, max)
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

/** `allowOmarchy` is passed only on Linux, where it also reads shortcuts saved before Sotto wrote Linux's keys (ADR-0097). */
export function parseSettings(input: unknown, defaults: AppSettings = DEFAULT_SETTINGS, allowOmarchy = false): AppSettings {
  const persisted = isRecord(input) ? input : {}
  // Before the recorder, Linux's keys were always the Hyprland bindings F9 and Super+Ctrl+X, whatever `hotkey` said:
  // Wayland never let Sotto register it. A Linux profile saved before `holdShortcuts` existed takes those keys, and so
  // does one an unreleased build of the recorder saved with the old, unused default and nothing held: Linux's rows
  // can't produce that pair, since only Owl removes the hold and Linux has no Owl build.
  const untouchedLinux = Array.isArray(persisted.holdShortcuts) && persisted.holdShortcuts.length === 0 &&
    persisted.hotkey === 'CommandOrControl+Shift+Space' && (persisted.pressShortcuts === undefined || Array.isArray(persisted.pressShortcuts) && persisted.pressShortcuts.length === 0)
  const linuxBeforeRecorder = allowOmarchy && (persisted.holdShortcuts === undefined || untouchedLinux)
  // The library is read leniently, one theme at a time, so a single damaged
  // entry never costs the user the rest of their themes. A half naming a theme
  // that is gone, or that cannot paint that half, lands on the default.
  // A theme of the user's own whose id a built-in has since taken is kept under a new id, and its halves follow it.
  const library = Array.isArray(persisted.customThemes)
    ? parseSavedThemeLibrary(persisted.customThemes)
    : { themes: [...defaults.customThemes], moved: new Map<string, string>() }
  const customThemes = library.themes
  const half = (key: 'lightTheme' | 'darkTheme'): string => {
    const saved = parseField(persisted, key, defaults)
    const id = library.moved.get(saved) ?? saved
    // Glass is kept whatever this build offers, so a stable run never rewrites an Owl install's choice (ADR-0150).
    return allowOmarchy && id === OMARCHY_THEME_ID ? id : savedThemeHalfId(id, key === 'lightTheme' ? 'light' : 'dark', customThemes)
  }

  // Only the keys named here are read. One a version of Sotto no longer has, such as `watcherInFlightLimit`, the Threads
  // in flight limit removed in #1183, is left behind here and gone from the file at the next save.
  return {
    version: parseField(persisted, 'version', defaults),
    theme: parseField(persisted, 'theme', defaults),
    appearance: parseField(persisted, 'appearance', defaults),
    lightTheme: half('lightTheme'),
    darkTheme: half('darkTheme'),
    appearanceContrast: parseField(persisted, 'appearanceContrast', defaults),
    effortColor: parseField(persisted, 'effortColor', defaults),
    menuBarOwlBody: parseField(persisted, 'menuBarOwlBody', defaults),
    menuBarOwlEyes: parseField(persisted, 'menuBarOwlEyes', defaults),
    watcherScene: parseField(persisted, 'watcherScene', defaults),
    composerStyle: parseField(persisted, 'composerStyle', defaults),
    creature: parseField(persisted, 'creature', defaults),
    showCreature: parseField(persisted, 'showCreature', defaults),
    interfaceLanguage: parseField(persisted, 'interfaceLanguage', defaults),
    customThemes,
    webLinkDestination: parseField(persisted, 'webLinkDestination', defaults),
    responseStreaming: parseField(persisted, 'responseStreaming', defaults),
    showBrowserPreviews: parseField(persisted, 'showBrowserPreviews', defaults),
    browserWithoutAsking: parseField(persisted, 'browserWithoutAsking', defaults),
    visualsInThreads: parseField(persisted, 'visualsInThreads', defaults),
    babysitPullRequests: parseField(persisted, 'babysitPullRequests', defaults),
    resumeThreadsAfterRestart: parseField(persisted, 'resumeThreadsAfterRestart', defaults),
    restartStoppedThreads: parseField(persisted, 'restartStoppedThreads', defaults),
    // Row by row, so one damaged row costs only that row.
    workerRoles: persisted.workerRoles === undefined ? { ...defaults.workerRoles } : parseWorkerRoleChoices(persisted.workerRoles),
    workerCeiling: parseField(persisted, 'workerCeiling', defaults),
    workerMachineCeilings: parseField(persisted, 'workerMachineCeilings', defaults),
    watcherSettlesFinishedThreads: parseField(persisted, 'watcherSettlesFinishedThreads', defaults),
    newWorkerMachine: parseField(persisted, 'newWorkerMachine', defaults),
    watcherCompactAtTokens: parseField(persisted, 'watcherCompactAtTokens', defaults),
    compactIdleThreads: parseField(persisted, 'compactIdleThreads', defaults),
    reducedMotion: parseField(persisted, 'reducedMotion', defaults),
    clickEffect: parseField(persisted, 'clickEffect', defaults),
    roomTransition: parseField(persisted, 'roomTransition', defaults),
    roomTransitionSpeed: parseField(persisted, 'roomTransitionSpeed', defaults),
    roomTransitionLook: parseField(persisted, 'roomTransitionLook', defaults),
    microphoneId: parseField(persisted, 'microphoneId', defaults),
    hotkey: linuxBeforeRecorder ? defaults.hotkey : parseField(persisted, 'hotkey', defaults),
    pressShortcuts: linuxBeforeRecorder ? [] : parseShortcutList(persisted.pressShortcuts, 3),
    // The hold default is for new installs only: an existing profile without the field, or with a damaged one, holds nothing.
    // Linux is the exception above: its existing profiles already held F9.
    holdShortcuts: linuxBeforeRecorder || persisted.holdShortcuts === undefined && Object.keys(persisted).length === 0
      ? [...defaults.holdShortcuts]
      : parseShortcutList(persisted.holdShortcuts, 4),
    // Row by row, so one damaged shortcut falls back to its own default and no other.
    threadShortcuts: persisted.threadShortcuts === undefined ? { ...defaults.threadShortcuts } : parseThreadShortcutChoices(persisted.threadShortcuts),
    terminalFontSize: parseField(persisted, 'terminalFontSize', defaults),
    maxRecordingSeconds: parseField(persisted, 'maxRecordingSeconds', defaults),
    soundCues: parseField(persisted, 'soundCues', defaults),
    typingSpeedWpm: parseField(persisted, 'typingSpeedWpm', defaults),
    speechModel: parseField(persisted, 'speechModel', defaults),
    formatWhitespace: parseField(persisted, 'formatWhitespace', defaults),
    autoCopy: parseField(persisted, 'autoCopy', defaults),
    autoPaste: parseField(persisted, 'autoPaste', defaults),
    pasteDelayMs: parseField(persisted, 'pasteDelayMs', defaults),
    successDisplayMs: parseField(persisted, 'successDisplayMs', defaults),
    launchAtStartup: parseField(persisted, 'launchAtStartup', defaults),
    startMinimized: parseField(persisted, 'startMinimized', defaults),
    showWidgetWhenIdle: parseField(persisted, 'showWidgetWhenIdle', defaults),
    dictationEnabled: parseField(persisted, 'dictationEnabled', defaults),
    cloudTranscription: parseField(persisted, 'cloudTranscription', defaults),
    cloudSpeechModel: parseField(persisted, 'cloudSpeechModel', defaults),
    notifyNeedsYou: parseField(persisted, 'notifyNeedsYou', defaults),
    notifyFinished: parseField(persisted, 'notifyFinished', defaults),
    historyEnabled: parseField(persisted, 'historyEnabled', defaults),
    historyRetention: parseField(persisted, 'historyRetention', defaults),
    onboardingComplete: parseField(persisted, 'onboardingComplete', defaults),
    microphoneSkipped: parseField(persisted, 'microphoneSkipped', defaults),
    llmFormatting: parseField(persisted, 'llmFormatting', defaults),
    llmApiKey: parseField(persisted, 'llmApiKey', defaults),
    llmDictionary: parseField(persisted, 'llmDictionary', defaults),
    llmTimeoutMs: parseField(persisted, 'llmTimeoutMs', defaults),
    llmMinWords: parseField(persisted, 'llmMinWords', defaults),
    llmModel: parseField(persisted, 'llmModel', defaults),
    llmMode: parseField(persisted, 'llmMode', defaults),
    llmOwnModel: parseField(persisted, 'llmOwnModel', defaults),
    threadTitles: parseField(persisted, 'threadTitles', defaults),
    nextPromptSuggestions: parseField(persisted, 'nextPromptSuggestions', defaults),
    threadTips: parseField(persisted, 'threadTips', defaults),
    threadWorkingCopyDefault: parseField(persisted, 'threadWorkingCopyDefault', defaults),
    projectThreadWorkingCopyDefaults: parseField(persisted, 'projectThreadWorkingCopyDefaults', defaults),
    worktreeCleanup: parseField(persisted, 'worktreeCleanup', defaults),
    gitFetchIntervalSeconds: parseField(persisted, 'gitFetchIntervalSeconds', defaults),
    gitAutoPull: parseField(persisted, 'gitAutoPull', defaults),
    keepMainCurrent: parseField(persisted, 'keepMainCurrent', defaults),
    projectKeepMainCurrent: parseField(persisted, 'projectKeepMainCurrent', defaults),
    defaultMergeMethod: parseField(persisted, 'defaultMergeMethod', defaults),
    lastMergeMethod: parseField(persisted, 'lastMergeMethod', defaults),
    diffLayout: parseField(persisted, 'diffLayout', defaults),
    diffHideWhitespace: parseField(persisted, 'diffHideWhitespace', defaults),
    diffFileState: parseField(persisted, 'diffFileState', defaults),
    gitWritingStyle: parseField(persisted, 'gitWritingStyle', defaults),
    gitWritingInstructions: parseField(persisted, 'gitWritingInstructions', defaults),
    followPullRequestTemplates: parseField(persisted, 'followPullRequestTemplates', defaults),
    autoSettleMergedThreads: parseField(persisted, 'autoSettleMergedThreads', defaults),
    clearSettledThreadsAfterDays: parseField(persisted, 'clearSettledThreadsAfterDays', defaults),
    proactivePanels: parseField(persisted, 'proactivePanels', defaults),
    pullRequestText: parseField(persisted, 'pullRequestText', defaults),
    commitMessages: parseField(persisted, 'commitMessages', defaults),
    autoUpdateCheck: parseField(persisted, 'autoUpdateCheck', defaults),
    mainFreezeNotice: parseField(persisted, 'mainFreezeNotice', defaults),
    localHostEnabled: parseField(persisted, 'localHostEnabled', defaults),
    phoneAccess: parseField(persisted, 'phoneAccess', defaults),
    phoneAccessName: parseField(persisted, 'phoneAccessName', defaults),
    tailnetConnections: parseField(persisted, 'tailnetConnections', defaults),
    memoryEnabled: parseField(persisted, 'memoryEnabled', defaults),
    cloudIphoneMonthlyMinutes: parseField(persisted, 'cloudIphoneMonthlyMinutes', defaults),
    cloudIphoneIdleMinutes: parseField(persisted, 'cloudIphoneIdleMinutes', defaults),
  }
}

/** Whether an OpenRouter speech model transcribes dictation: only with the Owl feature on and the setting on (ADR-0160). */
export function cloudTranscriptionOn(settings: Pick<AppSettings, 'cloudTranscription'>, owlFeatureOn: boolean): boolean {
  return owlFeatureOn && settings.cloudTranscription
}

/** Whether Sotto dictates: the setting counts only while its Owl feature is on, so stable always dictates (ADR-0107). */
export function dictationOn(settings: Pick<AppSettings, 'dictationEnabled'>, owlFeatureOn: boolean): boolean {
  return !owlFeatureOn || settings.dictationEnabled
}
