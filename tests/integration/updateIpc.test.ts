// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  registerIpc
} from '../../src/main/ipc/registerIpc'
import {
  UPDATE_CHECK,
  UPDATE_DOWNLOAD,
  UPDATE_GET_STATUS,
  UPDATE_INSTALL
} from '../../src/shared/channels'
import { createIpcHarness } from '../fixtures/ipcHarness'

describe('IPC validation and lifecycle', () => {
  it('forwards every update operation and rejects a payload on any of them', async () => {
      const harness = createIpcHarness()
      harness.cleanup()
      const status = { currentVersion: '3.4.0', phase: { phase: 'available' as const, version: '3.5.0', problem: null }, checkedAt: 1_000 }
      const updates = {
        status: vi.fn(() => status),
        check: vi.fn(async () => status),
        download: vi.fn(async () => ({ ok: true as const })),
        install: vi.fn(() => ({ ok: true as const })),
      }
      registerIpc(harness.ipc, {
        settings: harness.settings,
        history: harness.history,
        startup: harness.startup,
        hotkeys: harness.hotkeys,
        app: harness.app,
        trustedSenders: () => [{ role: 'main', webContents: harness.trustedContents, url: harness.trustedUrl }],
        updates,
      })

      await expect(harness.ipc.invokeArgs(UPDATE_GET_STATUS, [])).resolves.toEqual(status)
      await expect(harness.ipc.invokeArgs(UPDATE_CHECK, [])).resolves.toEqual(status)
      await expect(harness.ipc.invokeArgs(UPDATE_DOWNLOAD, [])).resolves.toEqual({ ok: true })
      await expect(harness.ipc.invokeArgs(UPDATE_INSTALL, [])).resolves.toEqual({ ok: true })
      expect(updates.check).toHaveBeenCalledOnce()
      expect(updates.download).toHaveBeenCalledOnce()
      expect(updates.install).toHaveBeenCalledOnce()

      for (const channel of [UPDATE_GET_STATUS, UPDATE_CHECK, UPDATE_DOWNLOAD, UPDATE_INSTALL]) {
        await expect(harness.ipc.invokeArgs(channel, ['now'])).rejects.toMatchObject({
          code: 'INVALID_IPC_PAYLOAD',
        })
      }
    })

  it('reports updating as unavailable when no service is wired', async () => {
      const harness = createIpcHarness()

      for (const channel of [UPDATE_GET_STATUS, UPDATE_CHECK, UPDATE_DOWNLOAD, UPDATE_INSTALL]) {
        await expect(harness.ipc.invokeArgs(channel, [])).resolves.toEqual({
          ok: false,
          reason: 'unavailable',
        })
      }
      harness.cleanup()
    })
})
