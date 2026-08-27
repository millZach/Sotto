import { describe, expect, it } from 'vitest'

import { defaultHotkey } from '../../../src/shared/platform'
import {
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
  reducedMotion: 'on',
  microphoneId: 'microphone-1',
  hotkey: 'Alt+D',
  maxRecordingSeconds: 300,
  soundCues: false,
  modelPreset: 'fast',
  language: 'fr',
  inferencePreference: 'wasm',
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
  llmApiKey: 'sk-or-v1-test',
  llmDictionary: 'Sotto\nMoonshine',
  llmQuality: 'high',
  llmTimeoutMs: 3_000,
  llmMinWords: 4,
  streamingAsr: false,
  remoteAsr: true,
  remoteAsrUrl: 'http://forge.local:5092',
} satisfies AppSettings

describe('settings', () => {
  it('defines the complete versioned defaults', () => {
    expect(SETTINGS_VERSION).toBe(1)
    expect(DEFAULT_SETTINGS).toEqual({
      version: 1,
      theme: 'system',
      reducedMotion: 'system',
      microphoneId: null,
      hotkey: 'CommandOrControl+Shift+Space',
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
      remoteAsr: false,
      remoteAsrUrl: '',
    })
  })

  it('keeps remote transcription off for installs saved before it existed', () => {
    const legacy = { ...customSettings } as Record<string, unknown>
    delete legacy.remoteAsr
    delete legacy.remoteAsrUrl

    const parsed = parseSettings(legacy)
    expect(parsed.remoteAsr).toBe(false)
    expect(parsed.remoteAsrUrl).toBe('')
    expect(parsed.language).toBe('fr')
  })

  it('falls back to the defaults for an unusable remote server address', () => {
    expect(parseSettings({ ...customSettings, remoteAsrUrl: 'x'.repeat(513) }).remoteAsrUrl).toBe('')
    expect(parseSettings({ ...customSettings, remoteAsr: 'yes' }).remoteAsr).toBe(false)
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
    expect(parseSettings({ llmQuality: 'ultra' }).llmQuality).toBe('low')
    expect(parseSettings({ streamingAsr: false }).streamingAsr).toBe(false)
  })

  it('accepts the surviving presets and migrates removed or unknown presets to instant', () => {
    expect(parseSettings({ modelPreset: 'instant' }).modelPreset).toBe('instant')
    expect(parseSettings({ modelPreset: 'fast' }).modelPreset).toBe('fast')
    expect(parseSettings({ modelPreset: 'balanced' }).modelPreset).toBe('instant')
    expect(parseSettings({ modelPreset: 'accurate' }).modelPreset).toBe('instant')
    expect(parseSettings({ modelPreset: 'turbo' }).modelPreset).toBe('instant')
  })

  it('migrates legacy inference preferences to wasm', () => {
    expect(parseSettings({ inferencePreference: 'wasm' }).inferencePreference).toBe('wasm')
    expect(parseSettings({ inferencePreference: 'auto' }).inferencePreference).toBe('wasm')
    expect(parseSettings({ inferencePreference: 'webgpu' }).inferencePreference).toBe('wasm')
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
