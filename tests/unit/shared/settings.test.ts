import { describe, expect, it } from 'vitest'

import { defaultHotkey } from '../../../src/shared/platform'
import {
  ACCENTS,
  APPEARANCES,
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  defaultSettings,
  parseSettings,
  settingsSchema,
  type AppSettings,
} from '../../../src/shared/settings'

const customSettings = {
  version: 1,
  theme: 'light',
  appearance: 'light',
  accent: 'violet',
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
  llmFormatting: true,
  llmApiKey: '',
  llmDictionary: 'Sotto\nMoonshine',
  llmQuality: 'high',
  llmTimeoutMs: 3_000,
  llmMinWords: 4,
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

  it('opens a settings file written before appearance existed in the dark teal Crossing look, whatever its widget theme', () => {
    for (const theme of ['system', 'light', 'dark'] as const) {
      const legacy = { ...customSettings, theme } as Record<string, unknown>
      delete legacy.appearance
      delete legacy.accent
      const parsed = parseSettings(legacy)
      expect(parsed.appearance).toBe('dark')
      expect(parsed.accent).toBe('teal')
      // The widget keeps the scheme it already had; appearance never rewrites it.
      expect(parsed.theme).toBe(theme)
      expect(parsed).toEqual({ ...customSettings, theme, appearance: 'dark', accent: 'teal' })
    }
  })

  it('keeps every valid appearance and accent choice and recovers an unusable one field by field', () => {
    for (const appearance of APPEARANCES) expect(parseSettings({ appearance }).appearance).toBe(appearance)
    for (const accent of ACCENTS) expect(parseSettings({ accent }).accent).toBe(accent)
    expect(ACCENTS).toEqual(['teal', 'blue', 'violet', 'rose', 'amber', 'green'])
    const recovered = parseSettings({ appearance: 'black', accent: 'chartreuse', autoPaste: false })
    expect(recovered.appearance).toBe('dark')
    expect(recovered.accent).toBe('teal')
    expect(recovered.autoPaste).toBe(false)
    expect(parseSettings({ appearance: 'light', accent: 42 })).toMatchObject({ appearance: 'light', accent: 'teal' })
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, appearance: 'sepia' }).success).toBe(false)
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, accent: 'TEAL' }).success).toBe(false)
  })

  it('defines the complete versioned defaults', () => {
    expect(SETTINGS_VERSION).toBe(1)
    expect(DEFAULT_SETTINGS).toEqual({
      version: 1,
      theme: 'system',
      appearance: 'dark',
      accent: 'teal',
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
      llmFormatting: false,
      llmApiKey: '',
      llmDictionary: '',
      llmQuality: 'low',
      llmTimeoutMs: 2_500,
      llmMinWords: 5,
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
