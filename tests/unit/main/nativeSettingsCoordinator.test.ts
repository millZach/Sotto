// @vitest-environment node
import { cleanSettingsHistory } from '../../../src/main/settings/privacyCleanup'
import { describe, expect, it, vi } from 'vitest'

import {
  NativeManagedSettingMutationError,
  NativeSettingsCoordinator,
} from '../../../src/main/settings/nativeSettingsCoordinator'
import type { DictationShortcutsResult, HotkeyChangeResult } from '../../../src/shared/contracts'
import { platformProfile } from '../../../src/main/platformProfile'
import {
  DEFAULT_SETTINGS,
  defaultSettings,
  type AppSettings,
  type SettingsPatch,
} from '../../../src/shared/settings'
import { deferred } from '../../fixtures/deferred'
import { createDictationShortcutRouter, chordTokenSet } from '../../../src/main/hotkeys/dictationShortcutRouter'
import { HotkeyManager, type GlobalShortcutAdapter } from '../../../src/main/hotkeys/hotkeyManager'

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
  const settingsChanged = vi.fn()
  const coordinator = new NativeSettingsCoordinator({
    repository,
    hotkeys,
    startup,
    onAutoPasteChanged: autoPasteChanged,
    onSettingsChanged: settingsChanged,
  })
  return {
    autoPasteChanged,
    coordinator,
    hotkeys,
    repository,
    settingsChanged,
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

it('merges queued cleanup rule edits with the latest persisted settings', async () => {
  const harness = createHarness()
  await Promise.all([
    harness.coordinator.updateSettings({ worktreeCleanup: { onSettle: true } }),
    harness.coordinator.updateSettings({ worktreeCleanup: { merged: true } }),
    harness.coordinator.updateSettings({ worktreeCleanup: { afterDays: 14 } }),
  ])
  expect(harness.persisted.worktreeCleanup).toEqual({
    onSettle: true, merged: true, afterDays: 14, unchanged: false,
  })
})

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
    expect(harness.settingsChanged).toHaveBeenCalledWith(
      expect.objectContaining({ autoPaste: false, theme: 'dark' }),
    )
  })

  it('notifies only successful authoritative commits and contains notification failures', async () => {
    const harness = createHarness()
    harness.settingsChanged.mockRejectedValueOnce(new Error('renderer unavailable'))

    await expect(harness.coordinator.updateSettings({ theme: 'dark' })).resolves.toMatchObject({
      theme: 'dark',
    })
    expect(harness.settingsChanged).toHaveBeenCalledOnce()

    harness.settingsChanged.mockClear()
    harness.repository.update.mockRejectedValueOnce(new Error('private settings path'))
    await expect(harness.coordinator.updateSettings({ theme: 'light' })).rejects.toMatchObject({
      code: 'NATIVE_SETTINGS_TRANSACTION_FAILED',
    })
    expect(harness.settingsChanged).not.toHaveBeenCalled()
  })

  it('republishes projected state without writing settings or running native effects', async () => {
    const harness = createHarness()
    await harness.coordinator.republish()
    expect(harness.settingsChanged).toHaveBeenCalledExactlyOnceWith(harness.persisted)
    expect(harness.repository.update).not.toHaveBeenCalled()
    expect(harness.repository.save).not.toHaveBeenCalled()
    expect(harness.autoPasteChanged).not.toHaveBeenCalled()
    expect(harness.hotkeys.replace).not.toHaveBeenCalled()
    expect(harness.startup.set).not.toHaveBeenCalled()
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
    expect(harness.settingsChanged).not.toHaveBeenCalled()

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
    expect(harness.settingsChanged).toHaveBeenLastCalledWith(DEFAULT_SETTINGS)
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
    harness.settingsChanged.mockClear()

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
    expect(harness.settingsChanged).not.toHaveBeenCalled()
  })

  it('serializes concurrent native mutations in call order', async () => {
    const harness = createHarness()

    const { promise: firstWrite, resolve: releaseFirst } = deferred<void>()
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
    expect(harness.settingsChanged.mock.calls.some(([settings]) =>
      settings.hotkey === 'Alt+Space')).toBe(true)
    expect(harness.settingsChanged.mock.calls.some(([settings]) =>
      settings.launchAtStartup === true)).toBe(true)
  })
  it('resets to the injected platform defaults instead of the Windows row', async () => {
    const defaults = defaultSettings(platformProfile('darwin').defaultHotkey)
    let persisted: AppSettings = { ...defaults, hotkey: 'Control+Alt+M' }
    let activeHotkey = persisted.hotkey
    const coordinator = new NativeSettingsCoordinator({
      repository: {
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
          persisted = { ...defaults }
          return { ...persisted }
        }),
      },
      hotkeys: {
        current: vi.fn(() => activeHotkey),
        replace: vi.fn((accelerator: string): HotkeyChangeResult => {
          activeHotkey = accelerator.trim()
          return { ok: true as const }
        }),
      },
      startup: {
        get: vi.fn(() => ({ enabled: false })),
        set: vi.fn((enabled: boolean) => ({ enabled })),
      },
      onAutoPasteChanged: vi.fn(),
      onSettingsChanged: vi.fn(),
      defaults,
    })

    await expect(coordinator.resetSettings()).resolves.toEqual(defaults)
    expect(activeHotkey).toBe('Control+Shift+Space')
  })
})

it('retries failed thread privacy cleanup on the next unrelated Settings save', async () => {
  const harness = createHarness()
  const agentControl = { privacyChanged: vi.fn(async () => undefined).mockRejectedValueOnce(new Error('storage unavailable')) }
  harness.settingsChanged.mockImplementation(() => cleanSettingsHistory(agentControl))
  await harness.coordinator.updateSettings({ historyEnabled: false })
  expect(agentControl.privacyChanged).toHaveBeenCalledTimes(1)
  await harness.coordinator.updateSettings({ autoPaste: false })
  expect(harness.persisted.historyEnabled).toBe(false)
  expect(agentControl.privacyChanged).toHaveBeenCalledTimes(2)
})

it('keeps history off after retired-chat cleanup fails and retries both retired stores on the next Settings save', async () => {
  const harness = createHarness()
  const agentControl = { privacyChanged: vi.fn(async () => undefined) }
  const retiredChats = vi.fn(async () => undefined).mockRejectedValueOnce(new Error('chat storage unavailable'))
  const retiredAnswers = vi.fn(async () => undefined)
  const notify = vi.fn(async () => undefined)
  harness.settingsChanged.mockImplementation(() => cleanSettingsHistory(agentControl, notify, [retiredChats, retiredAnswers]))
  await harness.coordinator.updateSettings({ historyEnabled: false })
  expect(harness.persisted.historyEnabled).toBe(false)
  expect(retiredChats).toHaveBeenCalledOnce()
  expect(retiredAnswers).toHaveBeenCalledOnce()
  expect(notify).toHaveBeenCalledOnce()
  await harness.coordinator.updateSettings({ autoPaste: false })
  expect(harness.persisted.historyEnabled).toBe(false)
  expect(retiredChats).toHaveBeenCalledTimes(2)
  expect(retiredAnswers).toHaveBeenCalledTimes(2)
  expect(notify).toHaveBeenCalledTimes(2)
})

describe('NativeSettingsCoordinator dictation shortcuts', () => {
  function withRouter(apply: (set: { press: readonly string[]; hold: readonly string[] }, mode: 'strict' | 'lenient') => DictationShortcutsResult = () => ({ ok: true })) {
    const harness = createHarness()
    const router = { apply: vi.fn(apply), suspend: vi.fn() }
    const coordinator = new NativeSettingsCoordinator({
      repository: harness.repository,
      hotkeys: harness.hotkeys,
      startup: harness.startup,
      onAutoPasteChanged: vi.fn(),
      onSettingsChanged: harness.settingsChanged,
      dictationShortcuts: router,
    })
    return { harness, router, coordinator }
  }

  it('is unavailable without a router', async () => {
    const harness = createHarness()
    await expect(harness.coordinator.replaceDictationShortcuts({ press: ['Alt+Space'], hold: [] }))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(harness.repository.update).not.toHaveBeenCalled()
  })

  it('replaces the hotkey, applies the router, saves, then notifies, in that order', async () => {
    const { harness, router, coordinator } = withRouter()
    await expect(coordinator.replaceDictationShortcuts({ press: ['Alt+Space', 'Fn+Shift'], hold: ['Fn'] }))
      .resolves.toEqual({ ok: true })
    const order = [
      harness.hotkeys.replace.mock.invocationCallOrder[0]!,
      router.apply.mock.invocationCallOrder[0]!,
      harness.repository.update.mock.invocationCallOrder[0]!,
      harness.settingsChanged.mock.invocationCallOrder[0]!,
    ]
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(router.apply).toHaveBeenCalledWith({ press: ['Alt+Space', 'Fn+Shift'], hold: ['Fn'] }, 'strict')
    expect(harness.persisted).toMatchObject({ hotkey: 'Alt+Space', pressShortcuts: ['Fn+Shift'], holdShortcuts: ['Fn'] })
  })

  it('leaves an unchanged hotkey alone, even a legacy one', async () => {
    const { harness, coordinator } = withRouter()
    await harness.repository.save({ ...harness.persisted, hotkey: 'Shift+Ctrl+Insert' })
    await expect(coordinator.replaceDictationShortcuts({ press: ['Shift+Ctrl+Insert'], hold: ['Fn'] }))
      .resolves.toEqual({ ok: true })
    expect(harness.hotkeys.replace).not.toHaveBeenCalled()
  })

  it.each([
    [{ press: [], hold: [] }],
    [{ press: ['Alt+Space'], hold: ['Fn', 'Fn+Shift', 'Alt+Shift', 'Shift+Control', 'Fn+Alt'] }],
    [{ press: ['Alt+Space', 'A+'.repeat(40)], hold: [] }],
  ])('refuses a malformed set before any effect', async (change) => {
    const { harness, router, coordinator } = withRouter()
    await expect(coordinator.replaceDictationShortcuts(change)).resolves.toEqual({ ok: false, reason: 'invalid' })
    expect(harness.hotkeys.replace).not.toHaveBeenCalled()
    expect(router.apply).not.toHaveBeenCalled()
  })

  it('refuses a new main shortcut that needs the listener', async () => {
    const { harness, router, coordinator } = withRouter()
    await expect(coordinator.replaceDictationShortcuts({ press: ['Fn+Space'], hold: [] }))
      .resolves.toEqual({ ok: false, reason: 'invalid', chord: 'Fn+Space' })
    expect(harness.hotkeys.replace).not.toHaveBeenCalled()
    expect(router.apply).not.toHaveBeenCalled()
  })

  it('restores the hotkey when the router refuses and saves nothing', async () => {
    const { harness, coordinator } = withRouter(() => ({ ok: false, reason: 'conflict', chord: 'Alt+Shift+D' }))
    const before = harness.activeHotkey
    await expect(coordinator.replaceDictationShortcuts({ press: ['Alt+Space', 'Alt+Shift+D'], hold: [] }))
      .resolves.toEqual({ ok: false, reason: 'conflict', chord: 'Alt+Shift+D' })
    expect(harness.activeHotkey).toBe(before)
    expect(harness.repository.update).not.toHaveBeenCalled()
  })

  it('reports a hotkey conflict with its chord and never applies the router', async () => {
    const { harness, router, coordinator } = withRouter()
    harness.hotkeys.replace.mockReturnValueOnce({ ok: false, reason: 'conflict' })
    await expect(coordinator.replaceDictationShortcuts({ press: ['Alt+Space'], hold: [] }))
      .resolves.toEqual({ ok: false, reason: 'conflict', chord: 'Alt+Space' })
    expect(router.apply).not.toHaveBeenCalled()
  })

  it('rolls back in reverse when saving fails', async () => {
    const { harness, router, coordinator } = withRouter()
    const before = { ...harness.persisted }
    harness.repository.update.mockRejectedValueOnce(new Error('disk full'))
    await expect(coordinator.replaceDictationShortcuts({ press: ['Alt+Space', 'Alt+Shift+D'], hold: ['Fn'] }))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(router.apply).toHaveBeenLastCalledWith({ press: [before.hotkey, ...before.pressShortcuts], hold: before.holdShortcuts }, 'lenient')
    expect(harness.activeHotkey).toBe(before.hotkey)
    expect(harness.persisted).toEqual(before)
    expect(harness.settingsChanged).not.toHaveBeenCalled()
  })

  it('re-applies the router with the reset settings', async () => {
    const { router, coordinator } = withRouter()
    await coordinator.resetSettings()
    expect(router.apply).toHaveBeenCalledWith({ press: [DEFAULT_SETTINGS.hotkey], hold: DEFAULT_SETTINGS.holdShortcuts }, 'lenient')
  })
})

describe('NativeSettingsCoordinator dictation shortcuts with real registrations', () => {
  // Electron refuses an accelerator that is already registered, even by the same app, in any spelling.
  function createStack(saved: Partial<AppSettings>, initiallyTaken: readonly string[] = []) {
    let taken = initiallyTaken
    const active = new Map<string, () => void>()
    const key = (accelerator: string) => chordTokenSet(accelerator, 'darwin')
    const adapter: GlobalShortcutAdapter = {
      register: (accelerator, callback) => {
        if (active.has(key(accelerator)) || taken.includes(accelerator)) return false
        active.set(key(accelerator), callback)
        return true
      },
      unregister: (accelerator) => { active.delete(key(accelerator)) },
      isRegistered: (accelerator) => active.has(key(accelerator)),
    }
    let persisted: AppSettings = { ...DEFAULT_SETTINGS, holdShortcuts: [], ...saved }
    const repository = {
      get: vi.fn(async () => ({ ...persisted })),
      update: vi.fn(async (patch: Partial<AppSettings>) => (persisted = { ...persisted, ...patch })),
      save: vi.fn(async (settings: AppSettings) => (persisted = { ...settings })),
      reset: vi.fn(async () => (persisted = { ...DEFAULT_SETTINGS, holdShortcuts: [] })),
    }
    const primaryToggle = vi.fn()
    const extraToggle = vi.fn()
    const hotkeys = new HotkeyManager(adapter, primaryToggle, vi.fn(), 'darwin')
    expect(hotkeys.replace(persisted.hotkey)).toEqual({ ok: true })
    const router = createDictationShortcutRouter({
      shortcuts: adapter,
      createListener: () => ({ watch: vi.fn(), record: vi.fn(), request: vi.fn(), running: () => false, ready: () => false, permission: () => 'unknown' as const, dispose: vi.fn() }),
      isIdle: () => true,
      dispatch: extraToggle,
      showWidget: vi.fn(),
      pushHeld: vi.fn(),
      pushPermission: vi.fn(),
      openInputMonitoring: vi.fn(),
      log: vi.fn(),
      platform: 'darwin',
    })
    router.apply({ press: [persisted.hotkey, ...persisted.pressShortcuts], hold: persisted.holdShortcuts }, 'lenient')
    const coordinator = new NativeSettingsCoordinator({
      repository,
      hotkeys,
      startup: { get: () => ({ enabled: false }), set: (enabled: boolean) => ({ enabled }) },
      onAutoPasteChanged: vi.fn(),
      onSettingsChanged: vi.fn(),
      dictationShortcuts: router,
      defaults: { ...DEFAULT_SETTINGS, holdShortcuts: [] },
      platform: 'darwin',
    })
    return {
      coordinator, hotkeys, repository, primaryToggle, extraToggle,
      take: (accelerators: readonly string[]) => { taken = accelerators },
      live: () => [...active.keys()].sort(),
      fire: (accelerator: string) => active.get(key(accelerator))?.(),
      get persisted() { return persisted },
    }
  }
  const P = 'Control+Shift+Space'
  const X = 'Alt+Shift+D'

  it('promotes an extra to the main shortcut', async () => {
    const stack = createStack({ hotkey: P, pressShortcuts: [X] })
    await expect(stack.coordinator.replaceDictationShortcuts({ press: [X], hold: [] })).resolves.toEqual({ ok: true })
    expect(stack.hotkeys.current()).toBe(X)
    expect(stack.live()).toEqual([chordTokenSet(X, 'darwin')])
    stack.fire(X)
    expect(stack.primaryToggle).toHaveBeenCalledOnce()
    expect(stack.persisted).toMatchObject({ hotkey: X, pressShortcuts: [] })
  })

  it('swaps the main shortcut with an extra', async () => {
    const stack = createStack({ hotkey: P, pressShortcuts: [X] })
    await expect(stack.coordinator.replaceDictationShortcuts({ press: [X, P], hold: [] })).resolves.toEqual({ ok: true })
    expect(stack.hotkeys.current()).toBe(X)
    stack.fire(X)
    stack.fire(P)
    expect(stack.primaryToggle).toHaveBeenCalledOnce()
    expect(stack.extraToggle).toHaveBeenCalledWith({ type: 'toggle' })
  })

  it('rolls a swap back exactly when saving fails', async () => {
    const stack = createStack({ hotkey: P, pressShortcuts: [X] })
    stack.repository.update.mockRejectedValueOnce(new Error('disk full'))
    await expect(stack.coordinator.replaceDictationShortcuts({ press: [X, P], hold: [] }))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(stack.hotkeys.current()).toBe(P)
    expect(stack.live()).toEqual([P, X].map((chord) => chordTokenSet(chord, 'darwin')).sort())
    stack.fire(P)
    expect(stack.primaryToggle).toHaveBeenCalledOnce()
    stack.fire(X)
    expect(stack.extraToggle).toHaveBeenCalledOnce()
    expect(stack.persisted).toMatchObject({ hotkey: P, pressShortcuts: [X] })
  })

  it.each([
    ['the new primary', ['Alt+Shift+K', P]],
    ['a new extra', [X, P, 'Alt+Shift+K']],
  ])('keeps the old set exactly when the system refuses %s', async (_name, press) => {
    const stack = createStack({ hotkey: P, pressShortcuts: [X] }, ['Alt+Shift+K'])
    await expect(stack.coordinator.replaceDictationShortcuts({ press, hold: [] }))
      .resolves.toEqual({ ok: false, reason: 'conflict', chord: 'Alt+Shift+K' })
    expect(stack.hotkeys.current()).toBe(P)
    expect(stack.live()).toEqual([P, X].map((chord) => chordTokenSet(chord, 'darwin')).sort())
    stack.fire(P)
    stack.fire(X)
    expect(stack.primaryToggle).toHaveBeenCalledOnce()
    expect(stack.extraToggle).toHaveBeenCalledOnce()
    expect(stack.repository.update).not.toHaveBeenCalled()
  })

  it('never forgets the primary when its own restore is refused, and retries it', async () => {
    vi.useFakeTimers()
    try {
      const stack = createStack({ hotkey: P, pressShortcuts: [] })
      // Another app takes the old primary while it is released.
      stack.take(['Alt+Shift+K', P])
      await expect(stack.coordinator.replaceDictationShortcuts({ press: ['Alt+Shift+K'], hold: [] }))
        .resolves.toEqual({ ok: false, reason: 'conflict', chord: 'Alt+Shift+K' })
      expect(stack.persisted.hotkey).toBe(P)
      expect(stack.hotkeys.current()).toBeNull()
      stack.take([])
      vi.advanceTimersByTime(5_000)
      expect(stack.hotkeys.current()).toBe(P)
      expect(stack.live()).toEqual([chordTokenSet(P, 'darwin')])
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets when an extra equals the default hotkey', async () => {
    const stack = createStack({ hotkey: X, pressShortcuts: [DEFAULT_SETTINGS.hotkey] })
    await expect(stack.coordinator.resetSettings()).resolves.toMatchObject({ hotkey: DEFAULT_SETTINGS.hotkey })
    expect(stack.hotkeys.current()).toBe(DEFAULT_SETTINGS.hotkey)
    expect(stack.live()).toEqual([chordTokenSet(DEFAULT_SETTINGS.hotkey, 'darwin')])
  })

  it('re-registers a legacy-spelled primary recorded again in canonical order', async () => {
    const stack = createStack({ hotkey: 'Shift+Control+Insert' })
    await expect(stack.coordinator.replaceDictationShortcuts({ press: ['Control+Shift+Insert'], hold: [] }))
      .resolves.toEqual({ ok: true })
    expect(stack.hotkeys.current()).toBe('Control+Shift+Insert')
    expect(stack.live()).toEqual([chordTokenSet('Control+Shift+Insert', 'darwin')])
    expect(stack.persisted.hotkey).toBe('Control+Shift+Insert')
  })
})
