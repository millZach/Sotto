// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { defaultHoldShortcuts, defaultHotkey } from '../../../src/shared/platform'
import { createVividThemeColors } from '../../../src/shared/themes/engine'
import { parseThemeFile } from '../../../src/shared/themes/library'
import { MENU_BAR_OWL_BODIES, MENU_BAR_OWL_EYES } from '../../../src/shared/menuBarOwl'
import {
  dictationOn,
  APPEARANCES,
  CREATURES,
  DEFAULT_SETTINGS,
  EFFORT_COLORS,
  GIT_WRITING_INSTRUCTIONS_MAX_CHARACTERS,
  SETTINGS_VERSION,
  defaultSettings,
  initialMergeMethod,
  mergeMethodChosenPatch,
  parseSettings,
  settingsSchema,
  type AppSettings,
} from '../../../src/shared/settings'

const aurora = parseThemeFile({ version: 1, name: 'Aurora', appearance: 'dark', colors: createVividThemeColors('dark', '#101820', '#e0a040') })

const customSettings = {
  version: 1,
  theme: 'light',
  appearance: 'light',
  lightTheme: 'tropic',
  darkTheme: aurora.id,
  appearanceContrast: 135,
  effortColor: 'aurora',
  menuBarOwlBody: 'ink',
  menuBarOwlEyes: 'amber',
  creature: 'claude',
  showCreature: false,
  customThemes: [aurora],
  webLinkDestination: 'embedded',
  responseStreaming: 'complete',
  showBrowserPreviews: false,
  browserWithoutAsking: false,
  visualsInThreads: false,
  babysitPullRequests: false,
  resumeThreadsAfterRestart: false,
  workerRoles: { building: { modelId: 'native:claude:model:sonnet', reasoningEffort: 'xhigh', runtimeMode: 'auto-accept-edits' } },
  watcherSettlesFinishedThreads: false,
  compactIdleThreads: false,
  reducedMotion: 'on',
  roomTransition: false,
  roomTransitionSpeed: 1.5,
  microphoneId: 'microphone-1',
  terminalFontSize: 17,
  hotkey: 'Alt+D',
  pressShortcuts: ['Alt+Shift+D'],
  holdShortcuts: ['Fn', 'Control+Alt'],
  maxRecordingSeconds: 300,
  soundCues: false,
  typingSpeedWpm: 55,
  speechModel: null,
  formatWhitespace: false,
  autoCopy: true,
  autoPaste: false,
  pasteDelayMs: 50,
  successDisplayMs: 5_000,
  launchAtStartup: true,
  startMinimized: true,
  showWidgetWhenIdle: false,
  dictationEnabled: true,
  notifyNeedsYou: false,
  notifyFinished: false,
  historyEnabled: false,
  historyRetention: 'unlimited',
  onboardingComplete: true,
  microphoneSkipped: true,
  llmFormatting: true,
  llmApiKey: '',
  llmDictionary: 'Sotto\nMoonshine',
  llmTimeoutMs: 3_000,
  llmMinWords: 4,
  llmModel: 'google/gemini-3.1-flash-lite',
  llmMode: 'nitro',
  threadTitles: false,
  threadWorkingCopyDefault: 'independent',
  projectThreadWorkingCopyDefaults: { workshop: 'shared' },
  worktreeCleanup: { afterDays: 30, merged: true, onSettle: false, unchanged: true },
  gitFetchIntervalSeconds: 60,
  gitAutoPull: true,
  defaultMergeMethod: 'rebase',
  lastMergeMethod: 'squash',
  diffLayout: 'split',
  diffHideWhitespace: false,
  diffFileState: 'expanded',
  gitWritingStyle: 'custom',
  gitWritingInstructions: 'Subjects in the past tense.',
  followPullRequestTemplates: false,
  autoSettleMergedThreads: true,
  proactivePanels: true,
  pullRequestText: false,
  commitMessages: false,
  autoUpdateCheck: false,
  mainFreezeNotice: false,
  localHostEnabled: false,
  phoneAccess: true,
  phoneAccessName: 'Studio',
  tailnetConnections: true,
  memoryEnabled: true,
  cloudIphoneMonthlyMinutes: 1_000,
  cloudIphoneIdleMinutes: 10,
} satisfies AppSettings

describe('settings', () => {
  it('counts time saved against 40 words a minute for older profiles, keeps a chosen typing speed, and refuses one out of bounds', () => {
    expect(parseSettings({}).typingSpeedWpm).toBe(40)
    expect(parseSettings({ typingSpeedWpm: 72 }).typingSpeedWpm).toBe(72)
    for (const unusable of [9, 151, 40.5, '60']) expect(parseSettings({ typingSpeedWpm: unusable }).typingSpeedWpm).toBe(40)
    expect(settingsSchema.shape.typingSpeedWpm.safeParse(150).success).toBe(true)
    expect(settingsSchema.shape.typingSpeedWpm.safeParse(10).success).toBe(true)
  })
  it('defaults older profiles to the shared checkout and retains explicit global and project choices', () => {
    expect(parseSettings({})).toMatchObject({ threadWorkingCopyDefault: 'shared', projectThreadWorkingCopyDefaults: {} })
    expect(parseSettings({ threadWorkingCopyDefault: 'independent', projectThreadWorkingCopyDefaults: { project: 'shared' } }))
      .toMatchObject({ threadWorkingCopyDefault: 'independent', projectThreadWorkingCopyDefaults: { project: 'shared' } })
    expect(parseSettings({ threadWorkingCopyDefault: 'unknown', projectThreadWorkingCopyDefaults: { project: 'unknown' } }))
      .toMatchObject({ threadWorkingCopyDefault: 'shared', projectThreadWorkingCopyDefaults: {} })
  })
  it('shows browser previews for older profiles, keeps them off once turned off, and recovers an unusable value', () => {
    expect(parseSettings({}).showBrowserPreviews).toBe(true)
    expect(parseSettings({ showBrowserPreviews: false }).showBrowserPreviews).toBe(false)
    expect(parseSettings({ showBrowserPreviews: 'no' }).showBrowserPreviews).toBe(true)
  })
  it('lets agents use the browser without asking for older profiles, keeps it off once turned off, and recovers an unusable value (ADR-0029)', () => {
    expect(parseSettings({}).browserWithoutAsking).toBe(true)
    expect(parseSettings({ browserWithoutAsking: false }).browserWithoutAsking).toBe(false)
    expect(parseSettings({ browserWithoutAsking: 'no' }).browserWithoutAsking).toBe(true)
  })
  it('lets agents draw visuals for older profiles, keeps it off once turned off, and recovers an unusable value (ADR-0056)', () => {
    expect(parseSettings({}).visualsInThreads).toBe(true)
    expect(parseSettings({ visualsInThreads: false }).visualsInThreads).toBe(false)
    expect(parseSettings({ visualsInThreads: 'no' }).visualsInThreads).toBe(true)
  })
  it('lets agents babysit pull requests for older profiles, keeps it off once turned off, and recovers an unusable value (ADR-0061)', () => {
    expect(parseSettings({}).babysitPullRequests).toBe(true)
    expect(parseSettings({ babysitPullRequests: false }).babysitPullRequests).toBe(false)
    expect(parseSettings({ babysitPullRequests: 'no' }).babysitPullRequests).toBe(true)
  })
  it('resumes threads after a restart for older profiles, keeps it off once turned off, and recovers an unusable value (ADR-0076)', () => {
    expect(parseSettings({}).resumeThreadsAfterRestart).toBe(true)
    expect(parseSettings({ resumeThreadsAfterRestart: false }).resumeThreadsAfterRestart).toBe(false)
    expect(parseSettings({ resumeThreadsAfterRestart: 'no' }).resumeThreadsAfterRestart).toBe(true)
  })
  it('compacts idle threads for older profiles, keeps it off once turned off, and recovers an unusable value (ADR-0123)', () => {
    expect(parseSettings({}).compactIdleThreads).toBe(true)
    expect(parseSettings({ compactIdleThreads: false }).compactIdleThreads).toBe(false)
    expect(parseSettings({ compactIdleThreads: 'no' }).compactIdleThreads).toBe(true)
  })
  it('reads a saved Threads in flight limit as nothing, since Sotto no longer has one (#1183)', () => {
    const parsed = parseSettings({ ...DEFAULT_SETTINGS, watcherInFlightLimit: 6 })
    expect(parsed).toEqual(DEFAULT_SETTINGS)
    expect('watcherInFlightLimit' in parsed).toBe(false)
    expect('watcherInFlightLimit' in settingsSchema.shape).toBe(false)
  })
  it('starts every worktree cleanup rule off and recovers an unusable rule set to the defaults', () => {
    expect(parseSettings({}).worktreeCleanup).toEqual({ afterDays: null, merged: false, onSettle: false, unchanged: false })
    expect(parseSettings({ worktreeCleanup: { afterDays: 14, merged: false, onSettle: true, unchanged: false } }).worktreeCleanup).toEqual({ afterDays: 14, merged: false, onSettle: true, unchanged: false })
    expect(parseSettings({ worktreeCleanup: { afterDays: 3, merged: false, onSettle: true, unchanged: false } }).worktreeCleanup).toEqual({ afterDays: null, merged: false, onSettle: false, unchanged: false })
    expect(parseSettings({}).gitFetchIntervalSeconds).toBe(30)
    expect(parseSettings({ gitFetchIntervalSeconds: 0 }).gitFetchIntervalSeconds).toBe(0)
    expect(parseSettings({ gitFetchIntervalSeconds: 7 }).gitFetchIntervalSeconds).toBe(30)
  })
  it('starts the Git and diff settings where T3 Code does, with everything that acts on its own off', () => {
    expect(parseSettings({})).toMatchObject({
      gitAutoPull: false, defaultMergeMethod: 'last', lastMergeMethod: 'merge',
      diffLayout: 'stacked', diffHideWhitespace: true, diffFileState: 'collapsed',
      gitWritingStyle: 'repository', gitWritingInstructions: '', followPullRequestTemplates: true,
      autoSettleMergedThreads: false, proactivePanels: false,
    })
  })
  it('keeps every Git and diff choice and recovers each unusable one to its default alone', () => {
    const chosen = {
      gitAutoPull: true, defaultMergeMethod: 'squash', lastMergeMethod: 'rebase',
      diffLayout: 'split', diffHideWhitespace: false, diffFileState: 'expanded',
      gitWritingStyle: 'conventional', gitWritingInstructions: 'Keep it short.', followPullRequestTemplates: false,
      autoSettleMergedThreads: true, proactivePanels: true,
    } as const
    expect(parseSettings(chosen)).toMatchObject(chosen)
    const unusable = {
      gitAutoPull: 'yes', defaultMergeMethod: 'fast-forward', lastMergeMethod: 'last',
      diffLayout: 'unified', diffHideWhitespace: 1, diffFileState: 'open',
      gitWritingStyle: 'haiku', gitWritingInstructions: 'x'.repeat(GIT_WRITING_INSTRUCTIONS_MAX_CHARACTERS + 1), followPullRequestTemplates: 'no',
      autoSettleMergedThreads: null, proactivePanels: 'sometimes',
    }
    expect(parseSettings({ ...unusable, gitFetchIntervalSeconds: 60 })).toMatchObject({ ...DEFAULT_SETTINGS, gitFetchIntervalSeconds: 60 })
  })
  it('starts a merge on the chosen method, or the one used last, and remembers a choice only under Last selected', () => {
    expect(initialMergeMethod({ defaultMergeMethod: 'last', lastMergeMethod: 'squash' })).toBe('squash')
    expect(initialMergeMethod({ defaultMergeMethod: 'rebase', lastMergeMethod: 'squash' })).toBe('rebase')
    expect(mergeMethodChosenPatch({ defaultMergeMethod: 'last', lastMergeMethod: 'merge' }, 'squash')).toEqual({ lastMergeMethod: 'squash' })
    expect(mergeMethodChosenPatch({ defaultMergeMethod: 'last', lastMergeMethod: 'squash' }, 'squash')).toBeNull()
    expect(mergeMethodChosenPatch({ defaultMergeMethod: 'merge', lastMergeMethod: 'merge' }, 'squash')).toBeNull()
  })
  it('drops retired transcription settings while preserving valid settings', () => {
    // The speech model detects the language and every dictation is segmented (ADR-0071), so
    // language and streamingAsr went with the earlier local and hosted settings.
    const legacy = {
      ...customSettings, modelPreset: 'fast', inferencePreference: 'wasm', remoteAsr: true, remoteAsrUrl: 'http://retired.invalid',
      language: 'fr', streamingAsr: false,
    }
    expect(parseSettings(legacy)).toEqual(customSettings)
    expect(settingsSchema.parse(legacy)).toEqual(customSettings)
    for (const field of ['modelPreset', 'inferencePreference', 'remoteAsr', 'remoteAsrUrl', 'language', 'streamingAsr']) {
      expect(parseSettings(legacy)).not.toHaveProperty(field)
    }
  })

  it('drops the retired writing model and keeps every other choice, whichever model was saved', () => {
    // Short writing moved to each thread's own provider (ADR-0026); an older settings file still names a model.
    for (const writingModel of ['google/gemini-3.1-flash-lite', 'anthropic/claude-haiku-4.5', 'no-longer-offered']) {
      const legacy = { ...customSettings, writingModel }
      expect(parseSettings(legacy)).toEqual(customSettings)
      expect(parseSettings(legacy)).not.toHaveProperty('writingModel')
    }
    expect(DEFAULT_SETTINGS).not.toHaveProperty('writingModel')
  })

  it('drops the retired cleanup quality tier and keeps every other choice, whichever tier was saved', () => {
    // One model does every cleanup (ADR-0069); an older settings file still names a tier.
    for (const llmQuality of ['low', 'medium', 'value', 'high', 'ultra']) {
      const legacy = { ...customSettings, llmQuality }
      expect(parseSettings(legacy)).toEqual(customSettings)
      expect(parseSettings(legacy)).not.toHaveProperty('llmQuality')
    }
    expect(DEFAULT_SETTINGS).not.toHaveProperty('llmQuality')
  })

  it('tolerates persisted theme values and defaults an unknown value', () => {
    for (const theme of ['system', 'light', 'dark'] as const) {
      expect(() => parseSettings({ theme })).not.toThrow()
      expect(parseSettings({ theme }).theme).toBe(theme)
    }
    expect(parseSettings({ theme: 'ultraviolet' }).theme).toBe('system')
  })

  it('opens a settings file saved with the retired glass and window transparency choices and drops them (ADR-0084)', () => {
    const older = { ...customSettings, glassOpacity: 60, frostedWindow: true, frostSeeThrough: 55 }
    const parsed = parseSettings(older)
    expect(parsed).toEqual(parseSettings(customSettings))
    for (const key of ['glassOpacity', 'frostedWindow', 'frostSeeThrough']) expect(parsed).not.toHaveProperty(key)
    expect(settingsSchema.parse({ ...parsed, glassOpacity: 60, frostedWindow: true, frostSeeThrough: 55 })).toEqual(parsed)
  })

  it('opens a settings file written before appearance existed in dark Sotto, whatever its widget theme', () => {
    for (const theme of ['system', 'light', 'dark'] as const) {
      const legacy = { ...customSettings, theme } as Record<string, unknown>
      for (const key of ['appearance', 'lightTheme', 'darkTheme', 'appearanceContrast', 'effortColor', 'creature', 'showCreature', 'customThemes']) delete legacy[key]
      const parsed = parseSettings(legacy)
      // The widget keeps the scheme it already had; appearance never rewrites it.
      expect(parsed).toEqual({ ...customSettings, theme, appearance: 'dark', lightTheme: 't3-code', darkTheme: 't3-code', appearanceContrast: 100, effortColor: 'ember', creature: 'sotto', showCreature: true, customThemes: [] })
    }
  })

  it('migrates a settings file from the accent era: the mode stays, the accent is dropped, both halves start on Sotto', () => {
    for (const accent of ['teal', 'blue', 'violet', 'rose', 'amber', 'green', 'chartreuse']) {
      const older = { ...customSettings, appearance: 'system', accent } as Record<string, unknown>
      for (const key of ['lightTheme', 'darkTheme', 'appearanceContrast', 'customThemes']) delete older[key]
      const parsed = parseSettings(older)
      expect(parsed).not.toHaveProperty('accent')
      expect(parsed).toMatchObject({ appearance: 'system', lightTheme: 't3-code', darkTheme: 't3-code', appearanceContrast: 100, customThemes: [] })
      expect(settingsSchema.parse({ ...parsed, accent })).toEqual(parsed)
    }
  })

  it('sends a half saved on a retired T3 built-in back to Sotto and keeps a half on one of Sotto’s own', () => {
    for (const retired of ['t3-chat', 'grove', 'ocean', 'ember', 'iris']) {
      const saved = parseSettings({ ...customSettings, lightTheme: retired, darkTheme: retired })
      expect([saved.lightTheme, saved.darkTheme], retired).toEqual(['t3-code', 't3-code'])
    }
    expect(parseSettings({ ...customSettings, lightTheme: 't3-code', darkTheme: 't3-code' })).toMatchObject({ lightTheme: 't3-code', darkTheme: 't3-code' })
    expect(parseSettings({ ...customSettings, lightTheme: 'hush', darkTheme: 'tropic' })).toMatchObject({ lightTheme: 'hush', darkTheme: 'tropic' })
  })

  it('keeps every valid appearance and theme choice and recovers an unusable one field by field', () => {
    for (const appearance of APPEARANCES) expect(parseSettings({ appearance }).appearance).toBe(appearance)
    const recovered = parseSettings({ appearance: 'black', lightTheme: 'Not An Id', darkTheme: 42, appearanceContrast: 133, autoPaste: false })
    expect(recovered).toMatchObject({ appearance: 'dark', lightTheme: 't3-code', darkTheme: 't3-code', appearanceContrast: 100, autoPaste: false })
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, appearance: 'sepia' }).success).toBe(false)
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, appearanceContrast: 201 }).success).toBe(false)
    for (const contrast of [50, 100, 200]) expect(parseSettings({ appearanceContrast: contrast }).appearanceContrast).toBe(contrast)
  })

  it('keeps every effort colourway and recovers an unknown one as Ember', () => {
    for (const effortColor of EFFORT_COLORS) expect(parseSettings({ effortColor }).effortColor).toBe(effortColor)
    expect(parseSettings({ effortColor: 'neon' }).effortColor).toBe('ember')
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, effortColor: 'neon' }).success).toBe(false)
  })

  it('keeps every menu bar owl body and eye colour and recovers an unknown one as the shipped default', () => {
    for (const menuBarOwlBody of MENU_BAR_OWL_BODIES) expect(parseSettings({ menuBarOwlBody }).menuBarOwlBody).toBe(menuBarOwlBody)
    for (const menuBarOwlEyes of MENU_BAR_OWL_EYES) expect(parseSettings({ menuBarOwlEyes }).menuBarOwlEyes).toBe(menuBarOwlEyes)
    expect(parseSettings({ menuBarOwlBody: 'chrome', menuBarOwlEyes: 'pink' })).toMatchObject({ menuBarOwlBody: 'slate', menuBarOwlEyes: 'teal' })
    expect(parseSettings({})).toMatchObject({ menuBarOwlBody: 'slate', menuBarOwlEyes: 'teal' })
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, menuBarOwlBody: 'chrome' }).success).toBe(false)
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, menuBarOwlEyes: 'pink' }).success).toBe(false)
  })

  it('keeps either creature and recovers an unknown one as Sotto\'s own', () => {
    expect(DEFAULT_SETTINGS.creature).toBe('sotto')
    for (const creature of CREATURES) expect(parseSettings({ creature }).creature).toBe(creature)
    expect(parseSettings({ creature: 'dragon' }).creature).toBe('sotto')
    expect(parseSettings({}).creature).toBe('sotto')
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, creature: 'dragon' }).success).toBe(false)
  })

  it('chooses each half independently and falls back when its theme is gone or cannot paint that half', () => {
    const lightOnly = parseThemeFile({ version: 1, name: 'Paper', appearance: 'light', colors: { canvas: '#fffdf8' } })
    expect(parseSettings({ lightTheme: 'hush', darkTheme: 'linen' })).toMatchObject({ lightTheme: 'hush', darkTheme: 'linen' })
    expect(parseSettings({ lightTheme: lightOnly.id, darkTheme: lightOnly.id, customThemes: [lightOnly] })).toMatchObject({ lightTheme: lightOnly.id, darkTheme: 't3-code' })
    // A custom theme that was removed from the library no longer owns a half.
    expect(parseSettings({ darkTheme: aurora.id, customThemes: [] })).toMatchObject({ darkTheme: 't3-code' })
  })

  it('keeps valid custom themes one by one and never lets a hostile colour through', () => {
    const hostile = { ...aurora, id: 'hostile', label: 'Hostile', colors: { ...aurora.colors, canvas: 'red;background:url(https://example.com/x)' } }
    const reserved = { ...aurora, id: 'nocturne' }
    const parsed = parseSettings({ customThemes: [aurora, hostile, reserved, 'junk', { ...aurora }], darkTheme: aurora.id })
    // The damaged role is repaired from the theme's defaults; the reserved id, junk and duplicate are dropped.
    expect(parsed.customThemes.map(theme => theme.id)).toEqual([aurora.id, 'hostile'])
    expect(parsed.customThemes[1]!.colors.canvas).toMatch(/^oklch\(/u)
    expect(parsed.darkTheme).toBe(aurora.id)
    expect(JSON.stringify(parsed)).not.toContain('url(')
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, customThemes: [hostile] }).success).toBe(false)
    expect(parseSettings({ customThemes: 'nope' }).customThemes).toEqual([])
  })

  it('defines the complete versioned defaults', () => {
    expect(SETTINGS_VERSION).toBe(1)
    expect(DEFAULT_SETTINGS).toEqual({
      workerRoles: {},
      watcherSettlesFinishedThreads: true,
      terminalFontSize: 13,
      memoryEnabled: false,
      webLinkDestination: 'external',
      responseStreaming: 'live',
      showBrowserPreviews: true,
      browserWithoutAsking: true,
      visualsInThreads: true,
      babysitPullRequests: true,
      resumeThreadsAfterRestart: true,
      compactIdleThreads: true,
      version: 1,
      theme: 'system',
      appearance: 'dark',
      lightTheme: 't3-code',
      darkTheme: 't3-code',
      appearanceContrast: 100,
      effortColor: 'ember',
      menuBarOwlBody: 'slate',
      menuBarOwlEyes: 'teal',
      creature: 'sotto',
      showCreature: true,
      customThemes: [],
      reducedMotion: 'system',
      roomTransition: true,
      roomTransitionSpeed: 1,
      microphoneId: null,
      hotkey: 'CommandOrControl+Shift+Space',
      pressShortcuts: [],
      holdShortcuts: [],
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
      threadTitles: true,
      threadWorkingCopyDefault: 'shared',
      projectThreadWorkingCopyDefaults: {},
      worktreeCleanup: { afterDays: null, merged: false, onSettle: false, unchanged: false },
      gitFetchIntervalSeconds: 30,
      gitAutoPull: false,
      defaultMergeMethod: 'last',
      lastMergeMethod: 'merge',
      diffLayout: 'stacked',
      diffHideWhitespace: true,
      diffFileState: 'collapsed',
      gitWritingStyle: 'repository',
      gitWritingInstructions: '',
      followPullRequestTemplates: true,
      autoSettleMergedThreads: false,
      proactivePanels: false,
      pullRequestText: true,
      commitMessages: true,
      autoUpdateCheck: true,
      mainFreezeNotice: true,
      localHostEnabled: true,
      phoneAccess: false,
      phoneAccessName: '',
      tailnetConnections: false,
      cloudIphoneMonthlyMinutes: 750,
      cloudIphoneIdleMinutes: 5,
    })
  })

  it('keeps phone access off for installs saved before it existed, and refuses a name longer than a DNS label', () => {
    const legacy = { ...customSettings } as Record<string, unknown>
    delete legacy.phoneAccess
    delete legacy.phoneAccessName
    expect(parseSettings(legacy)).toMatchObject({ phoneAccess: false, phoneAccessName: '' })
    expect(parseSettings({ ...customSettings, phoneAccessName: 'x'.repeat(64) }).phoneAccessName).toBe('')
    expect(parseSettings({ ...customSettings, phoneAccessName: '  Studio Mac  ' }).phoneAccessName).toBe('Studio Mac')
  })

  it('keeps a host saved before tailnet connections existed off them until a desktop turns them on (ADR-0053)', () => {
    const legacy = { ...customSettings } as Record<string, unknown>
    delete legacy.tailnetConnections
    expect(parseSettings(legacy).tailnetConnections).toBe(false)
    expect(parseSettings(customSettings).tailnetConnections).toBe(true)
    expect(parseSettings({ ...customSettings, tailnetConnections: 'yes' }).tailnetConnections).toBe(false)
  })



  it('leaves the update check on for installs saved before it existed', () => {
    const legacy = { ...customSettings } as Record<string, unknown>
    delete legacy.autoUpdateCheck

    const parsed = parseSettings(legacy)
    expect(parsed.autoUpdateCheck).toBe(true)
  })

  it('keeps an explicit update-check choice and recovers an unusable one', () => {
    expect(parseSettings({ autoUpdateCheck: false }).autoUpdateCheck).toBe(false)
    expect(parseSettings({ autoUpdateCheck: 'sometimes' }).autoUpdateCheck).toBe(true)
  })



  it('builds per-platform defaults that differ only in the shortcuts', () => {
    expect(defaultSettings(defaultHotkey('win32'))).toEqual(DEFAULT_SETTINGS)
    expect(defaultSettings(defaultHotkey('darwin'), defaultHoldShortcuts('darwin'))).toEqual({
      ...DEFAULT_SETTINGS,
      hotkey: 'Control+Shift+Space',
      holdShortcuts: ['Fn'],
    })
    expect(defaultSettings(defaultHotkey('win32'), defaultHoldShortcuts('win32')).holdShortcuts).toEqual(['CommandOrControl+Super'])
    expect(defaultHoldShortcuts('linux')).toEqual(['F9'])
  })

  it('keeps saved hold and extra press shortcuts whole and drops damaged entries', () => {
    const macDefaults = defaultSettings('Control+Shift+Space', ['Fn'])
    const saved = parseSettings({ pressShortcuts: ['Alt+Shift+D'], holdShortcuts: ['Fn', 'Control+Alt'] }, macDefaults)
    expect(saved.pressShortcuts).toEqual(['Alt+Shift+D'])
    expect(saved.holdShortcuts).toEqual(['Fn', 'Control+Alt'])
    const damaged = parseSettings({ pressShortcuts: 'Alt+D', holdShortcuts: ['', 'Fn', 'Fn', 7] }, macDefaults)
    expect(damaged.pressShortcuts).toEqual([])
    expect(damaged.holdShortcuts).toEqual(['Fn'])
    expect(parseSettings({ holdShortcuts: 'Fn' }, macDefaults).holdShortcuts).toEqual([])
  })

  it('gives the hold default to new installs only', () => {
    const macDefaults = defaultSettings('Control+Shift+Space', ['Fn'])
    expect(parseSettings({}, macDefaults).holdShortcuts).toEqual(['Fn'])
    expect(parseSettings(undefined, macDefaults).holdShortcuts).toEqual(['Fn'])
    expect(parseSettings({ hotkey: 'Alt+D', theme: 'dark' }, macDefaults).holdShortcuts).toEqual([])
  })

  it('reads a Linux profile from before the recorder as the keys its Hyprland bindings always had', () => {
    const linuxDefaults = defaultSettings(defaultHotkey('linux'), defaultHoldShortcuts('linux'))
    // Wayland never registered `hotkey`, so whatever it said, F9 and Super+Ctrl+X were the keys.
    const before = parseSettings({ hotkey: 'CommandOrControl+Shift+Space', pressShortcuts: ['Alt+D'], theme: 'dark' }, linuxDefaults, true)
    expect(before).toMatchObject({ hotkey: 'Super+CommandOrControl+X', pressShortcuts: [], holdShortcuts: ['F9'], theme: 'dark' })
    expect(parseSettings({}, linuxDefaults, true)).toMatchObject({ hotkey: 'Super+CommandOrControl+X', holdShortcuts: ['F9'] })
    // An unreleased recorder build saved the old unused default with nothing held; Linux's rows can't make that pair.
    expect(parseSettings({ hotkey: 'CommandOrControl+Shift+Space', pressShortcuts: [], holdShortcuts: [] }, linuxDefaults, true)).toMatchObject({ hotkey: 'Super+CommandOrControl+X', holdShortcuts: ['F9'] })
    // Once saved by this version, the Linux shortcuts are the user's, an empty hold row included.
    const chosen = parseSettings({ hotkey: 'Super+Alt+D', pressShortcuts: ['Super+Alt+E'], holdShortcuts: [] }, linuxDefaults, true)
    expect(chosen).toMatchObject({ hotkey: 'Super+Alt+D', pressShortcuts: ['Super+Alt+E'], holdShortcuts: [] })
    // Windows and macOS read the same profile as before.
    expect(parseSettings({ hotkey: 'Alt+Shift+D', theme: 'dark' }, DEFAULT_SETTINGS)).toMatchObject({ hotkey: 'Alt+Shift+D', holdShortcuts: [] })
  })

  it('drops the retired widget style key from persisted settings', () => {
    const parsed = parseSettings({ widgetStyle: 'orb' })
    expect(parsed).not.toHaveProperty('widgetStyle')
    expect(parsed).toEqual(DEFAULT_SETTINGS)
  })

  it('defaults the AI formatting pass off and recovers invalid values', () => {
    expect(parseSettings({}).llmFormatting).toBe(false)
    expect(parseSettings({ llmFormatting: 'yes' }).llmFormatting).toBe(false)
    expect(parseSettings({ llmTimeoutMs: 100 }).llmTimeoutMs).toBe(2_500)
  })





  it('defaults the widget idle visibility on and recovers invalid values to on', () => {
    expect(parseSettings({}).showWidgetWhenIdle).toBe(true)
    expect(parseSettings({ showWidgetWhenIdle: false }).showWidgetWhenIdle).toBe(false)
    expect(parseSettings({ showWidgetWhenIdle: 'sometimes' }).showWidgetWhenIdle).toBe(true)
    expect(parseSettings({}).dictationEnabled).toBe(true)
    expect(parseSettings({ dictationEnabled: false }).dictationEnabled).toBe(false)
    expect(parseSettings({ dictationEnabled: 'no' }).dictationEnabled).toBe(true)
  })

  it('reads the two notification switches on by default and keeps a saved off, recovering anything else (ADR-0117)', () => {
    expect(parseSettings({}).notifyNeedsYou).toBe(true)
    expect(parseSettings({}).notifyFinished).toBe(true)
    expect(parseSettings({ notifyNeedsYou: false, notifyFinished: false })).toMatchObject({ notifyNeedsYou: false, notifyFinished: false })
    expect(parseSettings({ notifyNeedsYou: 'no', notifyFinished: 0 })).toMatchObject({ notifyNeedsYou: true, notifyFinished: true })
  })

  it('counts dictation off only while its Owl feature is on', () => {
    expect(dictationOn({ dictationEnabled: false }, false)).toBe(true)
    expect(dictationOn({ dictationEnabled: false }, true)).toBe(false)
    expect(dictationOn({ dictationEnabled: true }, true)).toBe(true)
  })

  it('recovers invalid fields without discarding valid fields', () => {
    const parsed = parseSettings({ theme: 'dark', pasteDelayMs: -4, autoPaste: false })

    expect(parsed.theme).toBe('dark')
    expect(parsed.pasteDelayMs).toBe(DEFAULT_SETTINGS.pasteDelayMs)
    expect(parsed.autoPaste).toBe(false)
  })

  it('accepts every valid field and discards unknown fields', () => {
    const parsed = parseSettings({ ...customSettings, cloudProvider: 'not-supported' })

    expect(parsed).toEqual(customSettings)
    expect(parsed).not.toHaveProperty('cloudProvider')
    expect(settingsSchema.parse({ ...customSettings, extra: true })).toEqual(customSettings)
  })

  it.each([null, undefined, 42, 'settings', true, [], () => undefined])(
    'returns defaults for non-record input %#',
    (input) => {
      expect(parseSettings(input)).toEqual(DEFAULT_SETTINGS)
    },
  )

  it.each([30, 60, 120, 300] as const)(
    'accepts the supported %i-second recording limit',
    (maxRecordingSeconds) => {
      expect(parseSettings({ maxRecordingSeconds }).maxRecordingSeconds).toBe(maxRecordingSeconds)
    },
  )

  it.each([29, 31, 301])('recovers the unsupported %i-second recording limit', (value) => {
    expect(parseSettings({ maxRecordingSeconds: value }).maxRecordingSeconds).toBe(
      DEFAULT_SETTINGS.maxRecordingSeconds,
    )
  })

  it('accepts inclusive timing boundaries', () => {
    expect(parseSettings({ pasteDelayMs: 50 }).pasteDelayMs).toBe(50)
    expect(parseSettings({ pasteDelayMs: 1_000 }).pasteDelayMs).toBe(1_000)
    expect(parseSettings({ successDisplayMs: 500 }).successDisplayMs).toBe(500)
    expect(parseSettings({ successDisplayMs: 5_000 }).successDisplayMs).toBe(5_000)
  })

  it.each([
    ['pasteDelayMs', 49],
    ['pasteDelayMs', 1_001],
    ['pasteDelayMs', 150.5],
    ['successDisplayMs', 499],
    ['successDisplayMs', 5_001],
    ['successDisplayMs', 1_400.5],
  ] as const)('recovers an invalid %s value of %s', (field, value) => {
    expect(parseSettings({ [field]: value })[field]).toBe(DEFAULT_SETTINGS[field])
  })

  it.each([25, 100, 500, 'unlimited'] as const)(
    'accepts the supported history retention value %s',
    (historyRetention) => {
      expect(parseSettings({ historyRetention }).historyRetention).toBe(historyRetention)
    },
  )

  it('requires a literal true autoCopy value', () => {
    expect(parseSettings({ autoCopy: false }).autoCopy).toBe(true)
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, autoCopy: false }).success).toBe(false)
  })

  it('returns a fresh value isolated from defaults and other parses', () => {
    const first = parseSettings({ theme: 'dark' })
    const second = parseSettings({ theme: 'dark' })

    expect(first).not.toBe(second)
    first.theme = 'light'
    expect(second.theme).toBe('dark')
    expect(DEFAULT_SETTINGS.theme).toBe('system')
  })
})

describe('night falls settings', () => {
  it('defaults to on at speed 1 and keeps a saved choice', () => {
    expect(DEFAULT_SETTINGS.roomTransition).toBe(true)
    expect(DEFAULT_SETTINGS.roomTransitionSpeed).toBe(1)
    const parsed = parseSettings({ ...DEFAULT_SETTINGS, roomTransition: false, roomTransitionSpeed: 0.5 })
    expect(parsed.roomTransition).toBe(false)
    expect(parsed.roomTransitionSpeed).toBe(0.5)
  })

  it('falls back to the default for a speed outside the dial', () => {
    expect(parseSettings({ ...DEFAULT_SETTINGS, roomTransitionSpeed: 3 }).roomTransitionSpeed).toBe(1)
    expect(parseSettings({ ...DEFAULT_SETTINGS, roomTransitionSpeed: 'fast' }).roomTransitionSpeed).toBe(1)
    expect(parseSettings({ ...DEFAULT_SETTINGS, roomTransition: 'yes' }).roomTransition).toBe(true)
  })
})
