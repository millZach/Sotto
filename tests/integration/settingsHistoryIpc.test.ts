// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SettingsRepository } from '../../src/main/storage/settingsRepository'
import { describe, expect, it, vi } from 'vitest'
import {
  registerIpc
} from '../../src/main/ipc/registerIpc'
import { NativeSettingsCoordinator } from '../../src/main/settings/nativeSettingsCoordinator'
import {
  APP_HIDE,
  APP_MINIMIZE,
  APP_QUIT,
  APP_RELOAD,
  APP_SHOW,
  DICTATION_RECORD_GET,
  DICTATION_RECORDS_LIST,
  HISTORY_ADD,
  HISTORY_CLEAR,
  HISTORY_DELETE,
  HISTORY_LIST,
  HISTORY_SEARCH,
  HOTKEY_GET,
  HOTKEY_REPLACE,
  DICTATION_SHORTCUTS_REPLACE,
  DICTATION_SHORTCUTS_SUSPEND,
  DICTATION_KEYS_RECORD,
  DICTATION_KEYS_RECORD_CANCEL,
  KEY_LISTENER_PERMISSION_GET,
  KEY_LISTENER_PERMISSION_REQUEST,
  RECOVERY_NOTICE_LIST,
  SETTINGS_GET,
  SETTINGS_RESET,
  SETTINGS_UPDATE,
  STARTUP_GET,
  STARTUP_SET
} from '../../src/shared/channels'
import {
  DEFAULT_SETTINGS,
  type AppSettings
} from '../../src/shared/settings'
import { createIpcHarness } from '../fixtures/ipcHarness'
import { OMARCHY_THEME_ID } from '../../src/shared/themes/omarchy'

async function onPlatform(platform: NodeJS.Platform, run: () => Promise<void>): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
  try { await run() } finally { Object.defineProperty(process, 'platform', descriptor) }
}

function settingsMutationHarness(snapshot: AppSettings) {
  const harness = createIpcHarness()
  harness.cleanup()
  const repository = {
    get: vi.fn(async () => snapshot),
    update: vi.fn(async (patch: Partial<AppSettings>) => ({ ...snapshot, ...patch })),
    save: vi.fn(async () => snapshot),
    reset: vi.fn(async () => snapshot),
  }
  const changed = vi.fn()
  const coordinator = new NativeSettingsCoordinator({
    repository, hotkeys: harness.hotkeys, startup: harness.startup,
    onAutoPasteChanged: vi.fn(), onSettingsChanged: changed,
  })
  const dispose = registerIpc(harness.ipc, {
    settings: {
      get: () => coordinator.getSettings(),
      update: patch => coordinator.updateSettings(patch),
      reset: () => coordinator.resetSettings(),
    },
    history: harness.history, startup: harness.startup, hotkeys: harness.hotkeys, app: harness.app,
    trustedSenders: () => [{ role: 'main', webContents: harness.trustedContents, url: harness.trustedUrl }],
  })
  return { ...harness, repository, changed, coordinator, dispose }
}

describe('IPC validation and lifecycle', () => {
  it.each(['win32', 'darwin', 'linux'] as const)('%s rejects the runtime palette before any write or notification', async (platform) => {
    await onPlatform(platform, async () => {
      const snapshot = { ...DEFAULT_SETTINGS, ...(platform === 'linux' ? { omarchyTheme: null } : {}) }
      const { ipc, repository, changed, coordinator, dispose } = settingsMutationHarness(snapshot)
      try {
        await expect(ipc.invoke(SETTINGS_UPDATE, { omarchyTheme: null })).rejects.toThrow('Invalid IPC payload')
        expect(repository.update).not.toHaveBeenCalled()
        expect(repository.save).not.toHaveBeenCalled()
        expect(repository.reset).not.toHaveBeenCalled()
        expect(changed).not.toHaveBeenCalled()
        expect(await coordinator.getSettings()).toEqual(snapshot)
      } finally { dispose() }
    })
  })

  it.each(['win32', 'darwin', 'linux'] as const)('%s rejects the shell pill state before any write or notification', async (platform) => {
    await onPlatform(platform, async () => {
      const snapshot = { ...DEFAULT_SETTINGS, ...(platform === 'linux' ? { shellPillInUse: true } : {}) }
      const { ipc, repository, changed, coordinator, dispose } = settingsMutationHarness(snapshot)
      try {
        await expect(ipc.invoke(SETTINGS_UPDATE, { shellPillInUse: false })).rejects.toThrow('Invalid IPC payload')
        expect(repository.update).not.toHaveBeenCalled()
        expect(repository.save).not.toHaveBeenCalled()
        expect(repository.reset).not.toHaveBeenCalled()
        expect(changed).not.toHaveBeenCalled()
        expect(await coordinator.getSettings()).toEqual(snapshot)
      } finally { dispose() }
    })
  })

  it.each([
    ['win32', 'lightTheme'], ['win32', 'darkTheme'],
    ['darwin', 'lightTheme'], ['darwin', 'darkTheme'],
  ] as const)('%s rejects a reserved %s just like an unknown ID', async (platform, half) => {
    await onPlatform(platform, async () => {
      const snapshot = { ...DEFAULT_SETTINGS, lightTheme: 'graphite', darkTheme: 'graphite' }
      const { ipc, repository, changed, coordinator, dispose } = settingsMutationHarness(snapshot)
      try {
        for (const id of [OMARCHY_THEME_ID, '__unknown']) {
          await expect(ipc.invoke(SETTINGS_UPDATE, { [half]: id, appearance: 'light' })).rejects.toThrow('Invalid IPC payload')
          expect(repository.get).not.toHaveBeenCalled()
          expect(repository.update).not.toHaveBeenCalled()
          expect(repository.save).not.toHaveBeenCalled()
          expect(repository.reset).not.toHaveBeenCalled()
          expect(changed).not.toHaveBeenCalled()
        }
        expect(await coordinator.getSettings()).toEqual(snapshot)
      } finally { dispose() }
    })
  })

  it.each(['lightTheme', 'darkTheme'] as const)('Linux accepts a waiting %s over IPC', async (half) => {
    await onPlatform('linux', async () => {
      const snapshot = { ...DEFAULT_SETTINGS, omarchyTheme: null }
      const { ipc, repository, changed, dispose } = settingsMutationHarness(snapshot)
      try {
        const updated = await ipc.invoke(SETTINGS_UPDATE, { [half]: OMARCHY_THEME_ID })
        expect(updated).toEqual({ ...snapshot, [half]: OMARCHY_THEME_ID })
        expect(repository.update).toHaveBeenCalledExactlyOnceWith({ [half]: OMARCHY_THEME_ID })
        expect(changed).toHaveBeenCalledExactlyOnceWith(updated)
        expect(repository.save).not.toHaveBeenCalled()
        expect(repository.reset).not.toHaveBeenCalled()
      } finally { dispose() }
    })
  })

  it('registers current settings, history, shortcut, startup, and app handlers', () => {
      const { ipc } = createIpcHarness()

      expect([...ipc.handlers.keys()].sort()).toEqual(
        expect.arrayContaining(
          [
            SETTINGS_GET,
            SETTINGS_UPDATE,
            SETTINGS_RESET,
            HISTORY_LIST,
            HISTORY_ADD,
            HISTORY_SEARCH,
            HISTORY_DELETE,
            HISTORY_CLEAR,
            HOTKEY_GET,
            HOTKEY_REPLACE,
            STARTUP_GET,
            STARTUP_SET,
            APP_SHOW,
            APP_HIDE,
            APP_MINIMIZE,
            APP_RELOAD,
            APP_QUIT,
            RECOVERY_NOTICE_LIST,
          ].sort(),
        ),
      )
    })

  it('returns typed retained recovery notices to the trusted main renderer', async () => {
      const harness = createIpcHarness()
      harness.cleanup()
      const list = vi.fn(() => [
        { code: 'SETTINGS_RECOVERED' as const },
        { code: 'HISTORY_RECOVERED' as const },
      ])
      registerIpc(harness.ipc, {
        settings: harness.settings,
        history: harness.history,
        startup: harness.startup,
        hotkeys: harness.hotkeys,
        app: harness.app,
        trustedSenders: () => [
          { role: 'main', webContents: harness.trustedContents, url: harness.trustedUrl },
        ],
        recoveryNotices: { list },
      })

      await expect(harness.ipc.invokeArgs(RECOVERY_NOTICE_LIST, [])).resolves.toEqual([
        { code: 'SETTINGS_RECOVERED' },
        { code: 'HISTORY_RECOVERED' },
      ])
      expect(list).toHaveBeenCalledOnce()
    })

  it('lists transcripts kept from before history was turned off, as after a restart with it off', async () => {
      const harness = createIpcHarness()
      harness.settings.get.mockResolvedValue({ ...DEFAULT_SETTINGS, historyEnabled: false })
      const kept = { id: 'kept', text: 'older words', createdAt: 1, durationMs: 2, language: 'en', modelPreset: 'parakeet' as const }
      harness.history.list.mockResolvedValue([kept] as never)

      await expect(harness.ipc.invokeArgs(HISTORY_LIST, [])).resolves.toEqual([kept])

      // With history off the file is only read, so a corrupt one is not recovered.
      expect(harness.history.list).toHaveBeenCalledWith({ enabled: false })
    })

  it('answers the dictation records from storage', async () => {
      const harness = createIpcHarness()
      const record = { id: 'one', createdAt: 1, durationMs: 2, words: 3, app: 'Outlook' }
      harness.history.listRecords.mockResolvedValue([record] as never)

      await expect(harness.ipc.invokeArgs(DICTATION_RECORDS_LIST, [])).resolves.toEqual([record])
      await expect(harness.ipc.invokeArgs(DICTATION_RECORDS_LIST, ['extra'])).rejects.toThrow('Invalid IPC payload')
      expect(harness.history.listRecords).toHaveBeenCalledOnce()

      harness.history.getRecord.mockResolvedValue(record as never)
      await expect(harness.ipc.invoke(DICTATION_RECORD_GET, 'one')).resolves.toEqual(record)
      await expect(harness.ipc.invoke(DICTATION_RECORD_GET, '')).rejects.toThrow('Invalid IPC payload')
      expect(harness.history.getRecord).toHaveBeenCalledWith('one')
    })

  it('allows deleting retained history when recording history is disabled', async () => {
      const harness = createIpcHarness()
      harness.settings.get.mockResolvedValue({ ...DEFAULT_SETTINGS, historyEnabled: false })
      harness.history.delete.mockResolvedValue(true)

      await expect(harness.ipc.invoke(HISTORY_DELETE, 'retained')).resolves.toBe(true)

      expect(harness.history.delete).toHaveBeenCalledWith('retained')
    })

  it('validates a settings patch before persistence and strips no fields silently', async () => {
    const { ipc, settings } = createIpcHarness()

    await expect(ipc.invoke(SETTINGS_UPDATE, { theme: 'dark', autoPaste: false })).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      theme: 'dark',
      autoPaste: false,
    })
    expect(settings.update).toHaveBeenCalledWith({ theme: 'dark', autoPaste: false })

    // Every patchable settings field must survive the allow-list transform:
    // a field missing from the IPC key list would be dropped silently and its
    // Settings control would snap back on save.
    const fullPatch: Record<string, unknown> = { ...DEFAULT_SETTINGS }
    delete fullPatch['hotkey']
    // Dictation shortcuts change only through their own transactional channel.
    delete fullPatch['pressShortcuts']
    delete fullPatch['holdShortcuts']
    delete fullPatch['launchAtStartup']
    // A headless host's own setting: its administrative route writes it, and nothing on a desktop sets it (ADR-0053).
    delete fullPatch['tailnetConnections']
    // Chosen through its own channel, which loads the model too (ADR-0094).
    delete fullPatch['speechModel']
    await ipc.invoke(SETTINGS_UPDATE, fullPatch)
    expect(settings.update).toHaveBeenLastCalledWith(fullPatch)
    await expect(ipc.invoke(SETTINGS_UPDATE, { voiceCoordinatorEnabled: true, microphoneId: 'rejected-microphone' })).rejects.toThrow('Invalid IPC payload')
    expect(settings.update).toHaveBeenLastCalledWith(fullPatch)

    await expect(ipc.invoke(SETTINGS_UPDATE, { theme: 'ultraviolet' })).rejects.toThrow(
      'Invalid IPC payload',
    )
    // The OpenRouter writing model is gone (ADR-0026): nothing may set it, so nothing can bring it back.
    await expect(ipc.invoke(SETTINGS_UPDATE, { writingModel: 'anthropic/claude-haiku-4.5' })).rejects.toThrow(
      'Invalid IPC payload',
    )
    await expect(
      ipc.invoke(SETTINGS_UPDATE, { theme: 'dark', injectedChannel: 'app:quit' }),
    ).rejects.toThrow('Invalid IPC payload')
    expect(settings.update).toHaveBeenCalledTimes(2)
  })

  it('persists an explicit Sotto browser preference through settings IPC', async () => {
      const { ipc, settings } = createIpcHarness()
      await expect(ipc.invoke(SETTINGS_UPDATE, { webLinkDestination: 'embedded' })).resolves.toMatchObject({
        webLinkDestination: 'embedded',
      })
      expect(settings.update).toHaveBeenCalledExactlyOnceWith({ webLinkDestination: 'embedded' })
    })

  it('accepts and ignores the retired glass and frost settings in a patch (ADR-0084)', async () => {
      const { ipc, settings } = createIpcHarness()
      const updated = await ipc.invoke(SETTINGS_UPDATE, {
        autoPaste: false,
        glassOpacity: 80,
        frostedWindow: true,
        frostSeeThrough: 40,
      })
      expect(updated).toMatchObject({ autoPaste: false })
      expect(updated).not.toHaveProperty('glassOpacity')
      expect(updated).not.toHaveProperty('frostedWindow')
      expect(updated).not.toHaveProperty('frostSeeThrough')
      expect(settings.update).toHaveBeenCalledExactlyOnceWith({ autoPaste: false })
    })

  it('persists turning browser previews off through settings IPC', async () => {
      const { ipc, settings } = createIpcHarness()
      await expect(ipc.invoke(SETTINGS_UPDATE, { showBrowserPreviews: false })).resolves.toMatchObject({ showBrowserPreviews: false })
      expect(settings.update).toHaveBeenCalledExactlyOnceWith({ showBrowserPreviews: false })
    })

  it('persists turning the browser grant off through settings IPC (ADR-0029)', async () => {
      const { ipc, settings } = createIpcHarness()
      await expect(ipc.invoke(SETTINGS_UPDATE, { browserWithoutAsking: false })).resolves.toMatchObject({ browserWithoutAsking: false })
      expect(settings.update).toHaveBeenCalledExactlyOnceWith({ browserWithoutAsking: false })
    })

  it('persists turning visuals in threads off through settings IPC (ADR-0056)', async () => {
      const { ipc, settings } = createIpcHarness()
      await expect(ipc.invoke(SETTINGS_UPDATE, { visualsInThreads: false })).resolves.toMatchObject({ visualsInThreads: false })
      expect(settings.update).toHaveBeenCalledExactlyOnceWith({ visualsInThreads: false })
    })

  it('persists turning agents babysitting pull requests off through settings IPC (ADR-0061)', async () => {
      const { ipc, settings } = createIpcHarness()
      await expect(ipc.invoke(SETTINGS_UPDATE, { babysitPullRequests: false })).resolves.toMatchObject({ babysitPullRequests: false })
      expect(settings.update).toHaveBeenCalledExactlyOnceWith({ babysitPullRequests: false })
    })

  it('persists turning next prompt suggestions off through settings IPC (ADR-0132)', async () => {
      const { ipc, settings } = createIpcHarness()
      await expect(ipc.invoke(SETTINGS_UPDATE, { nextPromptSuggestions: false })).resolves.toMatchObject({ nextPromptSuggestions: false })
      expect(settings.update).toHaveBeenCalledExactlyOnceWith({ nextPromptSuggestions: false })
    })

  it('persists turning Watcher’s Settle finished threads off through settings IPC', async () => {
      const { ipc, settings } = createIpcHarness()
      await expect(ipc.invoke(SETTINGS_UPDATE, { watcherSettlesFinishedThreads: false })).resolves.toMatchObject({ watcherSettlesFinishedThreads: false })
      expect(settings.update).toHaveBeenCalledExactlyOnceWith({ watcherSettlesFinishedThreads: false })
    })

  it('persists where new workers start through settings IPC, and refuses a value that names no machine (#1032)', async () => {
      const { ipc, settings } = createIpcHarness()
      const forge = '6b8f1c2d-3e4a-4b5c-8d6e-7f8091a2b3c4'
      await expect(ipc.invoke(SETTINGS_UPDATE, { newWorkerMachine: forge })).resolves.toMatchObject({ newWorkerMachine: forge })
      expect(settings.update).toHaveBeenCalledExactlyOnceWith({ newWorkerMachine: forge })
      await expect(ipc.invoke(SETTINGS_UPDATE, { newWorkerMachine: 'watcher' })).resolves.toMatchObject({ newWorkerMachine: 'watcher' })
      await expect(ipc.invoke(SETTINGS_UPDATE, { newWorkerMachine: 'forge' })).rejects.toThrow('Invalid IPC payload')
      expect(settings.update).toHaveBeenCalledTimes(2)
    })

  it('persists where Watcher compacts through the allow-list, and refuses a point off the slider', async () => {
    const { ipc, settings } = createIpcHarness()
    await expect(ipc.invoke(SETTINGS_UPDATE, { watcherCompactAtTokens: 600_000 })).resolves.toMatchObject({ watcherCompactAtTokens: 600_000 })
    expect(settings.update).toHaveBeenCalledExactlyOnceWith({ watcherCompactAtTokens: 600_000 })
    await expect(ipc.invoke(SETTINGS_UPDATE, { watcherCompactAtTokens: 150_000 })).rejects.toThrow('Invalid IPC payload')
    await expect(ipc.invoke(SETTINGS_UPDATE, { watcherCompactAtTokens: 425_000 })).rejects.toThrow('Invalid IPC payload')
    expect(settings.update).toHaveBeenCalledOnce()
  })

  it('persists the night falls look through the allow-list, and refuses a look Sotto does not have (ADR-0119)', async () => {
    const { ipc, settings } = createIpcHarness()
    await expect(ipc.invoke(SETTINGS_UPDATE, { roomTransitionLook: 'stars' })).resolves.toMatchObject({ roomTransitionLook: 'stars' })
    expect(settings.update).toHaveBeenCalledExactlyOnceWith({ roomTransitionLook: 'stars' })
    await expect(ipc.invoke(SETTINGS_UPDATE, { roomTransitionLook: 'wing' })).rejects.toThrow('Invalid IPC payload')
    expect(settings.update).toHaveBeenCalledOnce()
  })

  it('persists the typing speed the Dictate room counts time saved against, and refuses one out of bounds (#1293)', async () => {
    const { ipc, settings } = createIpcHarness()
    await expect(ipc.invoke(SETTINGS_UPDATE, { typingSpeedWpm: 65 })).resolves.toMatchObject({ typingSpeedWpm: 65 })
    expect(settings.update).toHaveBeenCalledExactlyOnceWith({ typingSpeedWpm: 65 })
    for (const typingSpeedWpm of [9, 151, 40.5]) {
      await expect(ipc.invoke(SETTINGS_UPDATE, { typingSpeedWpm })).rejects.toThrow('Invalid IPC payload')
    }
    expect(settings.update).toHaveBeenCalledOnce()
  })

  it('refuses the removed Threads in flight limit, which is no longer on the allow-list (#1183)', async () => {
    const { ipc, settings } = createIpcHarness()
    await expect(ipc.invoke(SETTINGS_UPDATE, { watcherInFlightLimit: 7 })).rejects.toThrow('Invalid IPC payload')
    expect(settings.update).not.toHaveBeenCalled()
  })

  it('saves worker roles through the allow-list, reads them back, and refuses a row it cannot read (#1041)', async () => {
    const { ipc, settings } = createIpcHarness()
    const root = await mkdtemp(join(tmpdir(), 'sotto-worker-roles-setting-'))
    try {
      const path = join(root, 'settings.json')
      const repository = new SettingsRepository(path)
      settings.update.mockImplementation(patch => repository.update(patch))
      settings.get.mockImplementation(() => repository.get())
      const workerRoles = { building: { modelId: 'native:claude:model:sonnet', reasoningEffort: 'xhigh', runtimeMode: 'auto-accept-edits' as const },
        orchestrating: { modelId: 'native:codex:model:gpt-6.1-sol', reasoningEffort: null } }
      await expect(ipc.invoke(SETTINGS_UPDATE, { workerRoles })).resolves.toMatchObject({ workerRoles })
      expect(settings.update).toHaveBeenCalledExactlyOnceWith({ workerRoles })
      await expect(ipc.invokeArgs(SETTINGS_GET, [])).resolves.toMatchObject({ workerRoles })
      await expect(new SettingsRepository(path).get()).resolves.toMatchObject({ workerRoles })
      for (const bad of [{ painting: { modelId: 'x', reasoningEffort: null } }, { ui: { modelId: '', reasoningEffort: null } }, { ui: { modelId: 'x', reasoningEffort: null, runtimeMode: 'yolo' } }, 'all']) {
        await expect(ipc.invoke(SETTINGS_UPDATE, { workerRoles: bad })).rejects.toThrow('Invalid IPC payload')
      }
      await expect(ipc.invoke(SETTINGS_UPDATE, { workerRoles: {} })).resolves.toMatchObject({ workerRoles: {} })
      expect(settings.update).toHaveBeenCalledTimes(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists phone access and the name phones show through the settings allow-list (ADR-0033)', async () => {
      const { ipc, settings } = createIpcHarness()
      await expect(ipc.invoke(SETTINGS_UPDATE, { phoneAccess: true })).resolves.toMatchObject({ phoneAccess: true })
      expect(settings.update).toHaveBeenLastCalledWith({ phoneAccess: true })
      await expect(ipc.invoke(SETTINGS_UPDATE, { phoneAccessName: 'Studio' })).resolves.toMatchObject({ phoneAccessName: 'Studio' })
      expect(settings.update).toHaveBeenLastCalledWith({ phoneAccessName: 'Studio' })
    })

  it('persists and clears working-copy defaults through the settings allow-list', async () => {
      const { ipc, settings } = createIpcHarness()
      const patch = { threadWorkingCopyDefault: 'independent', projectThreadWorkingCopyDefaults: { project: 'shared' } }
      await expect(ipc.invoke(SETTINGS_UPDATE, patch)).resolves.toMatchObject(patch)
      expect(settings.update).toHaveBeenLastCalledWith(patch)
      await ipc.invoke(SETTINGS_UPDATE, { projectThreadWorkingCopyDefaults: {} })
      expect(settings.update).toHaveBeenLastCalledWith({ projectThreadWorkingCopyDefaults: {} })
    })

  it('persists every Git and diff setting through the allow-list, one at a time, and refuses a value none of them takes', async () => {
      const { ipc, settings } = createIpcHarness()
      const choices = [
        { gitAutoPull: true }, { defaultMergeMethod: 'squash' }, { lastMergeMethod: 'rebase' },
        { diffLayout: 'split' }, { diffHideWhitespace: false }, { diffFileState: 'expanded' },
        { gitWritingStyle: 'custom' }, { gitWritingInstructions: 'Subjects in the past tense.' }, { followPullRequestTemplates: false },
        { autoSettleMergedThreads: true }, { proactivePanels: true }, { clearSettledThreadsAfterDays: 90 }, { clearSettledThreadsAfterDays: null },
      ]
      // One control saves one field, so each must survive the allow-list on its own or its toggle snaps back.
      for (const patch of choices) {
        await expect(ipc.invoke(SETTINGS_UPDATE, patch)).resolves.toMatchObject(patch)
        expect(settings.update).toHaveBeenLastCalledWith(patch)
      }
      for (const patch of [{ defaultMergeMethod: 'fast-forward' }, { lastMergeMethod: 'last' }, { diffLayout: 'unified' }, { diffFileState: 'open' }, { gitWritingStyle: 'haiku' }, { gitWritingInstructions: 'x'.repeat(2_001) }, { proactivePanels: 'yes' }, { clearSettledThreadsAfterDays: 7 }]) {
        await expect(ipc.invoke(SETTINGS_UPDATE, patch)).rejects.toThrow('Invalid IPC payload')
      }
      expect(settings.update).toHaveBeenCalledTimes(choices.length)
    })

  it.each([
      ['hotkey', { hotkey: 'Alt+Space' }],
      ['startup', { launchAtStartup: true }],
      // A headless host's own setting (ADR-0053): refused here rather than dropped, so nothing snaps back unseen.
      ['tailnet connections', { tailnetConnections: true }],
    ] as const)('rejects native-managed or host-only %s in a generic settings payload', async (_name, patch) => {
      const { ipc, settings } = createIpcHarness()

      await expect(ipc.invoke(SETTINGS_UPDATE, patch)).rejects.toMatchObject({
        code: 'INVALID_IPC_PAYLOAD',
      })
      expect(settings.update).not.toHaveBeenCalled()
    })

  it('routes named hotkey and startup IPC through atomic native persistence', async () => {
      const harness = createIpcHarness()
      harness.cleanup()
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
      const nativeHotkeys = {
        current: vi.fn(() => activeHotkey),
        replace: vi.fn((accelerator: string) => {
          activeHotkey = accelerator
          return { ok: true as const }
        }),
      }
      const nativeStartup = {
        get: vi.fn(() => ({ enabled: startupEnabled })),
        set: vi.fn((enabled: boolean) => {
          startupEnabled = enabled
          return { enabled }
        }),
      }
      const coordinator = new NativeSettingsCoordinator({
        repository,
        hotkeys: nativeHotkeys,
        startup: nativeStartup,
        onAutoPasteChanged: vi.fn(),
        onSettingsChanged: vi.fn(),
      })
      registerIpc(harness.ipc, {
        settings: {
          get: () => coordinator.getSettings(),
          update: (patch) => coordinator.updateSettings(patch),
          reset: () => coordinator.resetSettings(),
        },
        history: harness.history,
        startup: {
          get: () => coordinator.getStartup(),
          set: (enabled) => coordinator.setStartup(enabled),
        },
        hotkeys: {
          current: () => coordinator.getHotkey(),
          replace: (accelerator) => coordinator.replaceHotkey(accelerator),
        },
        app: harness.app,
        trustedSenders: () => [
          {
            role: 'main',
            webContents: harness.trustedContents,
            url: harness.trustedUrl,
          },
        ],
      })

      await expect(harness.ipc.invoke(HOTKEY_REPLACE, 'Alt+Space')).resolves.toEqual({
        ok: true,
      })
      await expect(harness.ipc.invoke(STARTUP_SET, true)).resolves.toEqual({ enabled: true })
      expect(activeHotkey).toBe('Alt+Space')
      expect(startupEnabled).toBe(true)
      expect(persisted).toMatchObject({ hotkey: 'Alt+Space', launchAtStartup: true })
    })

  it('validates history and primitive payloads before calling repositories or services', async () => {
      const { history, hotkeys, ipc, startup } = createIpcHarness()

      await expect(ipc.invoke(HISTORY_SEARCH, 42)).rejects.toThrow('Invalid IPC payload')
      await expect(ipc.invoke(HISTORY_DELETE, '')).rejects.toThrow('Invalid IPC payload')
      await expect(ipc.invoke(STARTUP_SET, 'yes')).rejects.toThrow('Invalid IPC payload')
      await expect(ipc.invoke(HOTKEY_REPLACE, 'Escape')).rejects.toThrow('Invalid IPC payload')

      expect(history.search).not.toHaveBeenCalled()
      expect(history.delete).not.toHaveBeenCalled()
      expect(startup.set).not.toHaveBeenCalled()
      expect(hotkeys.replace).not.toHaveBeenCalled()
    })

  it('rejects missing or extra arguments instead of silently ignoring them', async () => {
      const { ipc, settings } = createIpcHarness()

      await expect(ipc.invokeArgs(SETTINGS_GET, [undefined])).rejects.toThrow(
        'Invalid IPC payload',
      )
      await expect(ipc.invokeArgs(SETTINGS_UPDATE, [])).rejects.toThrow('Invalid IPC payload')
      await expect(
        ipc.invokeArgs(SETTINGS_UPDATE, [{ theme: 'dark' }, { injected: true }]),
      ).rejects.toThrow('Invalid IPC payload')
      expect(settings.get).not.toHaveBeenCalled()
      expect(settings.update).not.toHaveBeenCalled()
    })

  it('uses settings privacy and retention when adding validated history', async () => {
      const { history, ipc, settings } = createIpcHarness()
      settings.get.mockResolvedValueOnce({
        ...DEFAULT_SETTINGS,
        historyEnabled: false,
        historyRetention: 25,
      })
      const entry = {
        id: 'entry-1',
        text: 'local words',
        createdAt: 1,
        durationMs: 2,
        language: 'en',
        modelPreset: 'balanced' as const,
      }

      await ipc.invoke(HISTORY_ADD, entry)

      expect(history.add).toHaveBeenCalledWith(entry, { enabled: false, retention: 25 })
    })

  it('refuses a finished dictation that names its own delivered app', async () => {
      const { history, ipc } = createIpcHarness()
      const entry = { id: 'entry-1', text: 'local words', createdAt: 1, durationMs: 2, language: 'en', modelPreset: 'parakeet' as const, app: 'Outlook' }

      await expect(ipc.invoke(HISTORY_ADD, entry)).rejects.toThrow('Invalid IPC payload')

      expect(history.add).not.toHaveBeenCalled()
    })
})

describe('dictation shortcut IPC', () => {
  function shortcutsHarness(withService: boolean) {
    const harness = createIpcHarness()
    harness.cleanup()
    const service = {
      replace: vi.fn(async () => ({ ok: true as const })),
      suspend: vi.fn(),
      record: vi.fn(async () => ({ kind: 'recorded' as const, chord: 'Fn' })),
      cancelRecord: vi.fn(),
      permission: vi.fn(() => 'granted' as const),
      requestPermission: vi.fn(async () => 'denied' as const),
    }
    registerIpc(harness.ipc, {
      settings: harness.settings, history: harness.history, startup: harness.startup, hotkeys: harness.hotkeys, app: harness.app,
      ...(withService ? { dictationShortcuts: service } : {}),
      trustedSenders: () => [{ role: 'main', webContents: harness.trustedContents, url: harness.trustedUrl }],
    })
    return { ipc: harness.ipc, service }
  }

  it('forwards valid payloads to the service', async () => {
    const { ipc, service } = shortcutsHarness(true)
    await expect(ipc.invoke(DICTATION_SHORTCUTS_REPLACE, { press: ['Alt+Space', 'Fn'], hold: ['Fn+Shift'] })).resolves.toEqual({ ok: true })
    expect(service.replace).toHaveBeenCalledWith({ press: ['Alt+Space', 'Fn'], hold: ['Fn+Shift'] })
    await expect(ipc.invoke(DICTATION_SHORTCUTS_SUSPEND, true)).resolves.toEqual({ ok: true })
    expect(service.suspend).toHaveBeenCalledWith(true)
    await expect(ipc.invoke(DICTATION_KEYS_RECORD)).resolves.toEqual({ kind: 'recorded', chord: 'Fn' })
    await expect(ipc.invoke(DICTATION_KEYS_RECORD_CANCEL)).resolves.toEqual({ ok: true })
    expect(service.cancelRecord).toHaveBeenCalledOnce()
    await expect(ipc.invoke(KEY_LISTENER_PERMISSION_GET)).resolves.toBe('granted')
    await expect(ipc.invoke(KEY_LISTENER_PERMISSION_REQUEST)).resolves.toBe('denied')
  })

  it('rejects malformed payloads before calling the service', async () => {
    const { ipc, service } = shortcutsHarness(true)
    for (const payload of [
      { press: [], hold: [] },
      { press: ['Alt+Space'], hold: ['Fn', 'Fn', 'Fn', 'Fn', 'Fn'] },
      { press: ['Alt+Space', 'B', 'C', 'D', 'E'], hold: [] },
      { press: [''], hold: [] },
      { press: ['x'.repeat(65)], hold: [] },
      { press: ['Alt+Space'] },
      { press: ['Alt+Space'], hold: [], extra: true },
      'Alt+Space',
    ]) {
      await expect(ipc.invoke(DICTATION_SHORTCUTS_REPLACE, payload)).rejects.toThrow('Invalid IPC payload')
    }
    await expect(ipc.invoke(DICTATION_SHORTCUTS_SUSPEND, 'yes')).rejects.toThrow('Invalid IPC payload')
    await expect(ipc.invoke(DICTATION_SHORTCUTS_SUSPEND)).rejects.toThrow('Invalid IPC payload')
    await expect(ipc.invoke(DICTATION_KEYS_RECORD, true)).rejects.toThrow('Invalid IPC payload')
    await expect(ipc.invoke(DICTATION_KEYS_RECORD_CANCEL, 1)).rejects.toThrow('Invalid IPC payload')
    await expect(ipc.invoke(KEY_LISTENER_PERMISSION_GET, 'x')).rejects.toThrow('Invalid IPC payload')
    await expect(ipc.invoke(KEY_LISTENER_PERMISSION_REQUEST, 'x')).rejects.toThrow('Invalid IPC payload')
    expect(service.replace).not.toHaveBeenCalled()
    expect(service.suspend).not.toHaveBeenCalled()
    expect(service.record).not.toHaveBeenCalled()
    expect(service.cancelRecord).not.toHaveBeenCalled()
    expect(service.permission).not.toHaveBeenCalled()
    expect(service.requestPermission).not.toHaveBeenCalled()
  })

  it('answers unavailable without a service', async () => {
    const { ipc } = shortcutsHarness(false)
    await expect(ipc.invoke(DICTATION_SHORTCUTS_REPLACE, { press: ['Alt+Space'], hold: [] })).resolves.toEqual({ ok: false, reason: 'unavailable' })
    await expect(ipc.invoke(DICTATION_SHORTCUTS_SUSPEND, false)).resolves.toEqual({ ok: false, reason: 'unavailable' })
    await expect(ipc.invoke(DICTATION_KEYS_RECORD)).resolves.toEqual({ kind: 'unavailable' })
    await expect(ipc.invoke(DICTATION_KEYS_RECORD_CANCEL)).resolves.toEqual({ ok: false, reason: 'unavailable' })
    await expect(ipc.invoke(KEY_LISTENER_PERMISSION_GET)).resolves.toBe('unsupported')
    await expect(ipc.invoke(KEY_LISTENER_PERMISSION_REQUEST)).resolves.toBe('unsupported')
  })
})
