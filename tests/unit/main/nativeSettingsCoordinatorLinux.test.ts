// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { NativeSettingsCoordinator } from '../../../src/main/settings/nativeSettingsCoordinator'
import { HotkeyManager } from '../../../src/main/hotkeys/hotkeyManager'
import type { DictationShortcutsResult } from '../../../src/shared/contracts'
import type { DictationShortcutSet } from '../../../src/shared/dictationShortcuts'
import { defaultHoldShortcuts, defaultHotkey } from '../../../src/shared/platform'
import { defaultSettings, type AppSettings } from '../../../src/shared/settings'

const linuxDefaults = defaultSettings(defaultHotkey('linux'), defaultHoldShortcuts('linux'))

/** Linux: the coordinator hands shortcut changes to Hyprland's keys, which save back through commitCompositorShortcuts. */
function linuxHarness(answer?: (set: DictationShortcutSet) => DictationShortcutsResult) {
  let persisted: AppSettings = { ...linuxDefaults, soundCues: false }
  const repository = {
    get: vi.fn(async () => ({ ...persisted })),
    update: vi.fn(async (patch: Partial<AppSettings>) => { persisted = { ...persisted, ...patch }; return { ...persisted } }),
    save: vi.fn(async (settings: AppSettings) => { persisted = { ...settings }; return { ...persisted } }),
    reset: vi.fn(async () => { persisted = { ...linuxDefaults }; return { ...persisted } }),
  }
  const hotkeys = new HotkeyManager({ register: vi.fn(() => true), unregister: vi.fn() }, vi.fn(), vi.fn(), 'linux')
  hotkeys.replace(persisted.hotkey)
  const changed = vi.fn()
  const coordinator: NativeSettingsCoordinator = new NativeSettingsCoordinator({
    repository, hotkeys, platform: 'linux', defaults: linuxDefaults,
    startup: { get: () => ({ enabled: false }), set: enabled => ({ enabled }) },
    onAutoPasteChanged: vi.fn(), onSettingsChanged: changed,
    compositorKeys: {
      // As the Omarchy setup does: write the keys, then save them through the coordinator.
      replace: vi.fn(async (set: DictationShortcutSet) => {
        const result = answer?.(set) ?? { ok: true as const }
        if (result.ok) await coordinator.commitCompositorShortcuts(set)
        return result
      }),
    },
  })
  return { coordinator, repository, hotkeys, changed, get persisted() { return persisted } }
}

describe('Linux dictation shortcuts in the settings coordinator', () => {
  it('saves a stable press shortcut after Hyprland takes it, keeping the hold shortcuts', async () => {
    const h = linuxHarness()
    expect(await h.coordinator.replaceHotkey('Super+Alt+D')).toEqual({ ok: true })
    expect(h.persisted).toMatchObject({ hotkey: 'Super+Alt+D', pressShortcuts: [], holdShortcuts: ['F9'] })
    expect(h.hotkeys.current()).toBe('Super+Alt+D')
    expect(h.changed).toHaveBeenCalledWith(expect.objectContaining({ hotkey: 'Super+Alt+D' }))
  })

  it('passes Hyprland’s refusal through with its words and saves nothing', async () => {
    const h = linuxHarness(() => ({ ok: false, reason: 'conflict', chord: 'Super+Q', message: 'Hyprland already uses Super+Q for “Close window”. Pick other keys.' }))
    expect(await h.coordinator.replaceHotkey('Super+Q')).toEqual({ ok: false, reason: 'conflict', message: 'Hyprland already uses Super+Q for “Close window”. Pick other keys.' })
    expect(await h.coordinator.replaceDictationShortcuts({ press: ['Super+Q'], hold: ['F9'] })).toMatchObject({ ok: false, reason: 'conflict', chord: 'Super+Q' })
    expect(h.repository.update).not.toHaveBeenCalled()
    expect(h.persisted.hotkey).toBe('Super+CommandOrControl+X')
  })

  it('saves every Owl shortcut at once through Hyprland', async () => {
    const h = linuxHarness()
    expect(await h.coordinator.replaceDictationShortcuts({ press: ['Super+Alt+D', 'Super+Alt+E'], hold: ['F10'] })).toEqual({ ok: true })
    expect(h.persisted).toMatchObject({ hotkey: 'Super+Alt+D', pressShortcuts: ['Super+Alt+E'], holdShortcuts: ['F10'] })
  })

  it('refuses an empty set before Hyprland is asked', async () => {
    const h = linuxHarness()
    expect(await h.coordinator.replaceDictationShortcuts({ press: [], hold: [] })).toEqual({ ok: false, reason: 'invalid' })
  })

  it('keeps Linux’s keys through a settings reset, since they live in Hyprland', async () => {
    const h = linuxHarness()
    await h.coordinator.replaceDictationShortcuts({ press: ['Super+Alt+D'], hold: ['F10'] })
    const reset = await h.coordinator.resetSettings()
    expect(reset).toMatchObject({ hotkey: 'Super+Alt+D', holdShortcuts: ['F10'], soundCues: linuxDefaults.soundCues })
    expect(h.hotkeys.current()).toBe('Super+Alt+D')
  })
})
