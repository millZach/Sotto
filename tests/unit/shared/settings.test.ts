import { describe, expect, it } from 'vitest'

import { defaultHotkey } from '../../../src/shared/platform'
import { createVividThemeColors } from '../../../src/shared/themes/engine'
import { parseThemeFile } from '../../../src/shared/themes/library'
import {
  APPEARANCES,
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  defaultSettings,
  parseSettings,
  settingsSchema,
  type AppSettings,
} from '../../../src/shared/settings'

const aurora = parseThemeFile({ version: 1, name: 'Aurora', appearance: 'dark', colors: createVividThemeColors('dark', '#101820', '#e0a040') })

const customSettings = {
  version: 1,
  theme: 'light',
  appearance: 'light',
  lightTheme: 'ember',
  darkTheme: aurora.id,
  appearanceContrast: 135,
  glassOpacity: 60,
  customThemes: [aurora],
  webLinkDestination: 'embedded',
  responseStreaming: 'complete',
  reducedMotion: 'on',
  microphoneId: 'microphone-1',
  hotkey: 'Alt+D',
  maxRecordingSeconds: 300,
  soundCues: false,
  language: 'fr',
  formatWhitespace: false,
  autoCopy: true,
  autoPaste: false,
  pasteDelayMs: 50,
  successDisplayMs: 5_000,
  launchAtStartup: true,
  startMinimized: true,
  showWidgetWhenIdle: false,
  historyEnabled: false,
  historyRetention: 'unlimited',
  onboardingComplete: true,
  microphoneSkipped: true,
  llmFormatting: true,
  llmApiKey: '',
  llmDictionary: 'Sotto\nMoonshine',
  llmQuality: 'high',
  llmTimeoutMs: 3_000,
  llmMinWords: 4,
  writingModel: 'anthropic/claude-haiku-4.5',
  threadTitles: false,
  pullRequestText: false,
  streamingAsr: false,
  autoUpdateCheck: false,
} satisfies AppSettings

describe('settings', () => {
  it('drops retired transcription settings while preserving valid settings', () => {
    const legacy = { ...customSettings, modelPreset: 'fast', inferencePreference: 'wasm', remoteAsr: true, remoteAsrUrl: 'http://retired.invalid' }
    expect(parseSettings(legacy)).toEqual(customSettings)
    expect(settingsSchema.parse(legacy)).toEqual(customSettings)
    for (const field of ['modelPreset', 'inferencePreference', 'remoteAsr', 'remoteAsrUrl']) {
      expect(parseSettings(legacy)).not.toHaveProperty(field)
    }
  })

  it('tolerates persisted theme values and defaults an unknown value', () => {
    for (const theme of ['system', 'light', 'dark'] as const) {
      expect(() => parseSettings({ theme })).not.toThrow()
      expect(parseSettings({ theme }).theme).toBe(theme)
    }
    expect(parseSettings({ theme: 'ultraviolet' }).theme).toBe('system')
  })

  it('opens a settings file written before appearance existed in dark Tide, whatever its widget theme', () => {
    for (const theme of ['system', 'light', 'dark'] as const) {
      const legacy = { ...customSettings, theme } as Record<string, unknown>
      for (const key of ['appearance', 'lightTheme', 'darkTheme', 'appearanceContrast', 'glassOpacity', 'customThemes']) delete legacy[key]
      const parsed = parseSettings(legacy)
      // The widget keeps the scheme it already had; appearance never rewrites it.
      expect(parsed).toEqual({ ...customSettings, theme, appearance: 'dark', lightTheme: 'ocean', darkTheme: 'ocean', appearanceContrast: 100, glassOpacity: 80, customThemes: [] })
    }
  })

  it('migrates a settings file from the accent era: the mode stays, the accent is dropped, both halves start on Tide', () => {
    for (const accent of ['teal', 'blue', 'violet', 'rose', 'amber', 'green', 'chartreuse']) {
      const older = { ...customSettings, appearance: 'system', accent } as Record<string, unknown>
      for (const key of ['lightTheme', 'darkTheme', 'appearanceContrast', 'glassOpacity', 'customThemes']) delete older[key]
      const parsed = parseSettings(older)
      expect(parsed).not.toHaveProperty('accent')
      expect(parsed).toMatchObject({ appearance: 'system', lightTheme: 'ocean', darkTheme: 'ocean', appearanceContrast: 100, glassOpacity: 80, customThemes: [] })
      expect(settingsSchema.parse({ ...parsed, accent })).toEqual(parsed)
    }
  })

  it('keeps a selection saved under the built-in ids from before the rename', () => {
    const saved = parseSettings({ ...customSettings, lightTheme: 'grove', darkTheme: 'iris' })
    expect([saved.lightTheme, saved.darkTheme]).toEqual(['grove', 'iris'])
    expect(parseSettings({ ...customSettings, lightTheme: 't3-code', darkTheme: 't3-code' })).toMatchObject({ lightTheme: 't3-code', darkTheme: 't3-code' })
    expect(parseSettings({ ...customSettings, lightTheme: 't3-chat', darkTheme: 'ember' })).toMatchObject({ lightTheme: 't3-chat', darkTheme: 'ember' })
  })

  it('keeps every valid appearance and theme choice and recovers an unusable one field by field', () => {
    for (const appearance of APPEARANCES) expect(parseSettings({ appearance }).appearance).toBe(appearance)
    const recovered = parseSettings({ appearance: 'black', lightTheme: 'Not An Id', darkTheme: 42, appearanceContrast: 133, glassOpacity: 20, autoPaste: false })
    expect(recovered).toMatchObject({ appearance: 'dark', lightTheme: 'ocean', darkTheme: 'ocean', appearanceContrast: 100, glassOpacity: 80, autoPaste: false })
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, appearance: 'sepia' }).success).toBe(false)
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, appearanceContrast: 201 }).success).toBe(false)
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, glassOpacity: 82 }).success).toBe(false)
    for (const contrast of [50, 100, 200]) expect(parseSettings({ appearanceContrast: contrast }).appearanceContrast).toBe(contrast)
    for (const glass of [40, 80, 100]) expect(parseSettings({ glassOpacity: glass }).glassOpacity).toBe(glass)
  })

  it('chooses each half independently and falls back when its theme is gone or cannot paint that half', () => {
    const lightOnly = parseThemeFile({ version: 1, name: 'Paper', appearance: 'light', colors: { canvas: '#fffdf8' } })
    expect(parseSettings({ lightTheme: 't3-chat', darkTheme: 'grove' })).toMatchObject({ lightTheme: 't3-chat', darkTheme: 'grove' })
    expect(parseSettings({ lightTheme: lightOnly.id, darkTheme: lightOnly.id, customThemes: [lightOnly] })).toMatchObject({ lightTheme: lightOnly.id, darkTheme: 'ocean' })
    // A custom theme that was removed from the library no longer owns a half.
    expect(parseSettings({ darkTheme: aurora.id, customThemes: [] })).toMatchObject({ darkTheme: 'ocean' })
  })

  it('keeps valid custom themes one by one and never lets a hostile colour through', () => {
    const hostile = { ...aurora, id: 'hostile', label: 'Hostile', colors: { ...aurora.colors, canvas: 'red;background:url(https://example.com/x)' } }
    const reserved = { ...aurora, id: 'ocean' }
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
      webLinkDestination: 'external',
      responseStreaming: 'live',
      version: 1,
      theme: 'system',
      appearance: 'dark',
      lightTheme: 'ocean',
      darkTheme: 'ocean',
      appearanceContrast: 100,
      glassOpacity: 80,
      customThemes: [],
      reducedMotion: 'system',
      microphoneId: null,
      hotkey: 'CommandOrControl+Shift+Space',
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
      threadTitles: true,
      pullRequestText: true,
      streamingAsr: true,
      autoUpdateCheck: true,
    })
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



  it('builds per-platform defaults that differ only in the hotkey', () => {
    expect(defaultSettings(defaultHotkey('win32'))).toEqual(DEFAULT_SETTINGS)
    expect(defaultSettings(defaultHotkey('darwin'))).toEqual({
      ...DEFAULT_SETTINGS,
      hotkey: 'Control+Shift+Space',
    })
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
    expect(parseSettings({ llmQuality: 'high' }).llmQuality).toBe('high')
    expect(parseSettings({ llmQuality: 'value' }).llmQuality).toBe('value')
    expect(parseSettings({ llmQuality: 'ultra' }).llmQuality).toBe('low')
    expect(parseSettings({ streamingAsr: false }).streamingAsr).toBe(false)
  })





  it('defaults the widget idle visibility on and recovers invalid values to on', () => {
    expect(parseSettings({}).showWidgetWhenIdle).toBe(true)
    expect(parseSettings({ showWidgetWhenIdle: false }).showWidgetWhenIdle).toBe(false)
    expect(parseSettings({ showWidgetWhenIdle: 'sometimes' }).showWidgetWhenIdle).toBe(true)
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

  it('requires a non-empty language and a literal true autoCopy value', () => {
    expect(parseSettings({ language: '' }).language).toBe(DEFAULT_SETTINGS.language)
    expect(parseSettings({ language: 'es' }).language).toBe('es')
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
