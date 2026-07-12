import { describe, expect, it, vi } from 'vitest'

import {
  NativeManagedSettingMutationError,
  NativeSettingsCoordinator,
} from '../../../src/main/settings/nativeSettingsCoordinator'
import type { HotkeyChangeResult } from '../../../src/shared/contracts'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type SettingsPatch,
} from '../../../src/shared/settings'

function createHarness() {
  let persisted: AppSettings = { ...DEFAULT_SETTINGS }
  let activeHotkey: string | null = persisted.hotkey
  let startupEnabled = persisted.launchAtStartup
  const repository = {
    get: vi.fn(async () => ({ ...persisted })),
    update: vi.fn(async (patch: Partial<AppSettings>) => {
      persisted = { ...persisted, ...patch }
      return { ...persisted }
    }),
    save: vi.fn(async (settings: AppSettings) => {
      persisted = { ...settings }
      return { ...persisted }
    }),
    reset: vi.fn(async () => {
      persisted = { ...DEFAULT_SETTINGS }
      return { ...persisted }
    }),
  }
  const hotkeys = {
    current: vi.fn(() => activeHotkey),
    replace: vi.fn((accelerator: string): HotkeyChangeResult => {
      activeHotkey = accelerator.trim()
      return { ok: true as const }
    }),
  }
  const startup = {
    get: vi.fn(() => ({ enabled: startupEnabled })),
    set: vi.fn((enabled: boolean) => {
      startupEnabled = enabled
      return { enabled }
    }),
  }
  const autoPasteChanged = vi.fn()
  const coordinator = new NativeSettingsCoordinator({
    repository,
    hotkeys,
    startup,
    onAutoPasteChanged: autoPasteChanged,
  })
  return {
    autoPasteChanged,
    coordinator,
    hotkeys,
    repository,
    startup,
    get activeHotkey() {
      return activeHotkey
    },
    get persisted() {
      return persisted
    },
    get startupEnabled() {
      return startupEnabled
    },
  }
}

describe('NativeSettingsCoordinator', () => {
  it.each(['hotkey', 'launchAtStartup'] as const)(
    'rejects generic mutation of native-managed %s',
    async (key) => {
      const harness = createHarness()

      await expect(
        harness.coordinator.updateSettings({
          [key]: key === 'hotkey' ? 'Alt+Space' : true,
        } as unknown as SettingsPatch),
      ).rejects.toBeInstanceOf(NativeManagedSettingMutationError)

      expect(harness.repository.update).not.toHaveBeenCalled()
      expect(harness.hotkeys.replace).not.toHaveBeenCalled()
      expect(harness.startup.set).not.toHaveBeenCalled()
    },
  )

  it('persists auto-paste and refreshes tray state through the same operation', async () => {
    const harness = createHarness()

    await expect(
      harness.coordinator.updateSettings({ autoPaste: false, theme: 'dark' }),
    ).resolves.toMatchObject({ autoPaste: false, theme: 'dark' })

    expect(harness.autoPasteChanged).toHaveBeenCalledWith(false)
    expect(harness.persisted).toMatchObject({ autoPaste: false, theme: 'dark' })
  })

  it('registers a hotkey before persisting it and rolls native state back on write failure', async () => {
    const harness = createHarness()
    harness.repository.update.mockRejectedValueOnce(new Error('secret settings path'))

    await expect(harness.coordinator.replaceHotkey(' Alt+Space ')).rejects.toMatchObject({
      code: 'NATIVE_SETTINGS_TRANSACTION_FAILED',
    })

    expect(harness.hotkeys.replace.mock.calls.map(([value]) => value)).toStrictEqual([
      'Alt+Space',
      DEFAULT_SETTINGS.hotkey,
    ])
    expect(harness.activeHotkey).toBe(DEFAULT_SETTINGS.hotkey)
    expect(harness.persisted.hotkey).toBe(DEFAULT_SETTINGS.hotkey)

    await expect(harness.coordinator.replaceHotkey('Ctrl+Shift+M')).resolves.toEqual({
      ok: true,
    })
    expect(harness.persisted.hotkey).toBe('Ctrl+Shift+M')
  })

  it('does not persist a hotkey that native registration rejects', async () => {
    const harness = createHarness()
    harness.hotkeys.replace.mockReturnValueOnce({ ok: false, reason: 'conflict' })

    await expect(harness.coordinator.replaceHotkey('Alt+Space')).resolves.toEqual({
      ok: false,
      reason: 'conflict',
    })

    expect(harness.repository.update).not.toHaveBeenCalled()
    expect(harness.persisted.hotkey).toBe(DEFAULT_SETTINGS.hotkey)
  })

  it('fails closed when hotkey registration reports success without changing native state', async () => {
    const harness = createHarness()
    harness.hotkeys.replace.mockReturnValueOnce({ ok: true })

    await expect(harness.coordinator.replaceHotkey('Alt+Space')).rejects.toMatchObject({
      code: 'NATIVE_SETTINGS_TRANSACTION_FAILED',
    })

    expect(harness.repository.update).not.toHaveBeenCalled()
    expect(harness.hotkeys.replace).toHaveBeenLastCalledWith(DEFAULT_SETTINGS.hotkey)
    expect(harness.persisted.hotkey).toBe(DEFAULT_SETTINGS.hotkey)
  })

  it('rolls startup state back when persistence fails and keeps the queue usable', async () => {
    const harness = createHarness()
    harness.repository.update.mockRejectedValueOnce(new Error('secret settings path'))

    await expect(harness.coordinator.setStartup(true)).rejects.toMatchObject({
      code: 'NATIVE_SETTINGS_TRANSACTION_FAILED',
    })

    expect(harness.startup.set.mock.calls.map(([enabled]) => enabled)).toStrictEqual([
      true,
      false,
    ])
    expect(harness.startupEnabled).toBe(false)
    expect(harness.persisted.launchAtStartup).toBe(false)

    await expect(harness.coordinator.updateSettings({ theme: 'light' })).resolves.toMatchObject({
      theme: 'light',
    })
  })

  it('rejects an unverified startup change without persisting it', async () => {
    const harness = createHarness()
    harness.startup.set.mockReturnValueOnce({ enabled: false })

    await expect(harness.coordinator.setStartup(true)).rejects.toMatchObject({
      code: 'NATIVE_SETTINGS_TRANSACTION_FAILED',
    })

    expect(harness.repository.update).not.toHaveBeenCalled()
    expect(harness.persisted.launchAtStartup).toBe(false)
  })

  it('resets persisted and native-managed state together', async () => {
    const harness = createHarness()
    await harness.coordinator.replaceHotkey('Alt+Space')
    await harness.coordinator.setStartup(true)
    await harness.coordinator.updateSettings({ autoPaste: false, theme: 'dark' })
    harness.hotkeys.replace.mockClear()
    harness.startup.set.mockClear()
    harness.autoPasteChanged.mockClear()

    await expect(harness.coordinator.resetSettings()).resolves.toStrictEqual(DEFAULT_SETTINGS)

    expect(harness.hotkeys.replace).toHaveBeenCalledWith(DEFAULT_SETTINGS.hotkey)
    expect(harness.startup.set).toHaveBeenCalledWith(DEFAULT_SETTINGS.launchAtStartup)
    expect(harness.autoPasteChanged).toHaveBeenCalledWith(DEFAULT_SETTINGS.autoPaste)
    expect(harness.persisted).toStrictEqual(DEFAULT_SETTINGS)
  })

  it('rolls every native reset step back when reset persistence fails', async () => {
    const harness = createHarness()
    await harness.coordinator.replaceHotkey('Alt+Space')
    await harness.coordinator.setStartup(true)
    await harness.coordinator.updateSettings({ autoPaste: false })
    harness.repository.reset.mockRejectedValueOnce(new Error('secret settings path'))
    harness.hotkeys.replace.mockClear()
    harness.startup.set.mockClear()
    harness.autoPasteChanged.mockClear()

    await expect(harness.coordinator.resetSettings()).rejects.toMatchObject({
      code: 'NATIVE_SETTINGS_TRANSACTION_FAILED',
    })

    expect(harness.activeHotkey).toBe('Alt+Space')
    expect(harness.startupEnabled).toBe(true)
    expect(harness.persisted).toMatchObject({
      hotkey: 'Alt+Space',
      launchAtStartup: true,
      autoPaste: false,
    })
    expect(harness.autoPasteChanged).toHaveBeenLastCalledWith(false)
  })

  it('serializes concurrent native mutations in call order', async () => {
    const harness = createHarness()
    let releaseFirst!: () => void
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    harness.repository.update.mockImplementationOnce(async (patch) => {
      await firstWrite
      return { ...harness.persisted, ...patch }
    })

    const hotkey = harness.coordinator.replaceHotkey('Alt+Space')
    const startup = harness.coordinator.setStartup(true)
    await vi.waitFor(() => {
      expect(harness.hotkeys.replace).toHaveBeenCalledWith('Alt+Space')
    })
    expect(harness.startup.set).not.toHaveBeenCalled()

    releaseFirst()
    await hotkey
    await startup
    expect(harness.startup.set).toHaveBeenCalledWith(true)
  })
})
