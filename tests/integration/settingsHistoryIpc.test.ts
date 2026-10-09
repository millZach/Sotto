// @vitest-environment node
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
  HISTORY_ADD,
  HISTORY_CLEAR,
  HISTORY_DELETE,
  HISTORY_LIST,
  HISTORY_SEARCH,
  HOTKEY_GET,
  HOTKEY_REPLACE,
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

describe('IPC validation and lifecycle', () => {
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

  it('does not ask storage to read history when the authoritative setting disables it', async () => {
      const harness = createIpcHarness()
      harness.settings.get.mockResolvedValue({ ...DEFAULT_SETTINGS, historyEnabled: false })

      await expect(harness.ipc.invokeArgs(HISTORY_LIST, [])).resolves.toEqual([])

      expect(harness.history.list).toHaveBeenCalledWith({ enabled: false })
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
      delete fullPatch['launchAtStartup']
      // A headless host's own setting: its administrative route writes it, and nothing on a desktop sets it (ADR-0053).
      delete fullPatch['tailnetConnections']
      await ipc.invoke(SETTINGS_UPDATE, fullPatch)
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
        { autoSettleMergedThreads: true }, { proactivePanels: true },
      ]
      // One control saves one field, so each must survive the allow-list on its own or its toggle snaps back.
      for (const patch of choices) {
        await expect(ipc.invoke(SETTINGS_UPDATE, patch)).resolves.toMatchObject(patch)
        expect(settings.update).toHaveBeenLastCalledWith(patch)
      }
      for (const patch of [{ defaultMergeMethod: 'fast-forward' }, { lastMergeMethod: 'last' }, { diffLayout: 'unified' }, { diffFileState: 'open' }, { gitWritingStyle: 'haiku' }, { gitWritingInstructions: 'x'.repeat(2_001) }, { proactivePanels: 'yes' }]) {
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
})
