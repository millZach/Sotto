// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  registerIpc
} from '../../src/main/ipc/registerIpc'
import {
  HISTORY_LIST,
  SETTINGS_GET,
  SETTINGS_RESET,
  SETTINGS_UPDATE
} from '../../src/shared/channels'
import {
  DEFAULT_SETTINGS
} from '../../src/shared/settings'
import { createIpcHarness } from '../fixtures/ipcHarness'

describe('IPC validation and lifecycle', () => {
  it('removes owned handlers during idempotent cleanup', () => {
      const { cleanup, ipc } = createIpcHarness()

      cleanup()
      cleanup()

      expect(ipc.handlers.size).toBe(0)
      expect(new Set(ipc.removed).size).toBe(ipc.removed.length)
    })

  it('isolates per-channel cleanup failures and retains failed ownership safely', () => {
      const harness = createIpcHarness()
      const ownedChannels = [...harness.ipc.handlers.keys()]
      const failedChannels = new Set<string>([SETTINGS_GET, HISTORY_LIST])
      for (const channel of failedChannels) {
        harness.ipc.removeFailures.add(channel)
      }
      let cleanupError: unknown

      try {
        harness.cleanup()
      } catch (error) {
        cleanupError = error
      }

      expect(cleanupError).toMatchObject({ code: 'IPC_CLEANUP_FAILED' })
      expect(JSON.stringify(cleanupError)).not.toContain('secret')
      expect(harness.ipc.removed).toStrictEqual(ownedChannels)
      for (const channel of ownedChannels) {
        expect(harness.ipc.handlers.has(channel)).toBe(failedChannels.has(channel))
      }

      const attemptsAfterCleanup = [...harness.ipc.removed]
      expect(() =>
        registerIpc(harness.ipc, {
          settings: harness.settings,
          history: harness.history,
          startup: harness.startup,
          hotkeys: harness.hotkeys,
          app: harness.app,
          trustedSenders: () => [
            {
              role: 'main',
              webContents: harness.trustedContents,
              url: harness.trustedUrl,
            },
          ],
        }),
      ).toThrowError(expect.objectContaining({ code: 'IPC_REGISTRATION_ACTIVE' }))
      expect(harness.ipc.removed).toStrictEqual(attemptsAfterCleanup)

      expect(() => harness.cleanup()).not.toThrow()
      expect(harness.ipc.removed).toStrictEqual(attemptsAfterCleanup)
    })

  it('rejects overlapping registration without touching the active handlers', async () => {
      const harness = createIpcHarness()
      const activeSettingsHandler = harness.ipc.handlers.get(SETTINGS_GET)
      const removedBefore = [...harness.ipc.removed]
      let registrationError: unknown

      try {
        registerIpc(harness.ipc, {
          settings: harness.settings,
          history: harness.history,
          startup: harness.startup,
          hotkeys: harness.hotkeys,
          app: harness.app,
          trustedSenders: () => [
            {
              role: 'main',
              webContents: harness.trustedContents,
              url: harness.trustedUrl,
            },
          ],
        })
      } catch (error) {
        registrationError = error
      }

      expect(registrationError).toMatchObject({ code: 'IPC_REGISTRATION_ACTIVE' })
      expect(harness.ipc.handlers.get(SETTINGS_GET)).toBe(activeSettingsHandler)
      expect(harness.ipc.removed).toStrictEqual(removedBefore)
      await expect(harness.ipc.invoke(SETTINGS_GET)).resolves.toStrictEqual(DEFAULT_SETTINGS)
    })

  it('rolls back partial registration without removing an externally owned handler', () => {
      const harness = createIpcHarness()
      harness.cleanup()
      const externalHandler = vi.fn()
      harness.ipc.handlers.set(HISTORY_LIST, externalHandler)

      expect(() =>
        registerIpc(harness.ipc, {
          settings: harness.settings,
          history: harness.history,
          startup: harness.startup,
          hotkeys: harness.hotkeys,
          app: harness.app,
          trustedSenders: () => [
            {
              role: 'main',
              webContents: harness.trustedContents,
              url: harness.trustedUrl,
            },
          ],
        }),
      ).toThrow(`handler already exists: ${HISTORY_LIST}`)

      expect([...harness.ipc.handlers.entries()]).toStrictEqual([
        [HISTORY_LIST, externalHandler],
      ])
    })

  it('preserves registration failure when rollback cleanup also fails', () => {
      const harness = createIpcHarness()
      harness.cleanup()
      harness.ipc.removed.splice(0)
      const externalHandler = vi.fn()
      harness.ipc.handlers.set(HISTORY_LIST, externalHandler)
      harness.ipc.removeFailures.add(SETTINGS_GET)
      let registrationError: unknown

      try {
        registerIpc(harness.ipc, {
          settings: harness.settings,
          history: harness.history,
          startup: harness.startup,
          hotkeys: harness.hotkeys,
          app: harness.app,
          trustedSenders: () => [
            {
              role: 'main',
              webContents: harness.trustedContents,
              url: harness.trustedUrl,
            },
          ],
        })
      } catch (error) {
        registrationError = error
      }

      expect(registrationError).toMatchObject({
        message: `handler already exists: ${HISTORY_LIST}`,
      })
      expect(JSON.stringify(registrationError)).not.toContain('secret remove failure')
      expect(harness.ipc.handlers.get(HISTORY_LIST)).toBe(externalHandler)
      expect(harness.ipc.removed).toEqual(
        expect.arrayContaining([SETTINGS_GET, SETTINGS_UPDATE, SETTINGS_RESET]),
      )

      const attemptsAfterRollback = [...harness.ipc.removed]
      expect(() =>
        registerIpc(harness.ipc, {
          settings: harness.settings,
          history: harness.history,
          startup: harness.startup,
          hotkeys: harness.hotkeys,
          app: harness.app,
          trustedSenders: () => [],
        }),
      ).toThrowError(expect.objectContaining({ code: 'IPC_REGISTRATION_ACTIVE' }))
      expect(harness.ipc.removed).toStrictEqual(attemptsAfterRollback)
    })
})
