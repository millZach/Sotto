// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  registerIpc
} from '../../src/main/ipc/registerIpc'
import {
  MICROPHONE_ENSURE_ACCESS,
  TRANSCRIPTION_CANCEL,
  TRANSCRIPTION_CHECK_KEY,
  TRANSCRIPTION_TRANSCRIBE
} from '../../src/shared/channels'
import { createIpcHarness } from '../fixtures/ipcHarness'

describe('IPC validation and lifecycle', () => {
  it('forwards hosted transcription over dedicated channels and rejects oversized or malformed audio', async () => {
      const harness = createIpcHarness()
      harness.cleanup()
      const transcription = {
        transcribe: vi.fn(async () => ({ ok: true as const, text: 'hosted text' })),
        cancel: vi.fn(),
        checkKey: vi.fn(async () => ({ ok: true as const })),
      }
      registerIpc(harness.ipc, {
        settings: harness.settings,
        history: harness.history,
        startup: harness.startup,
        hotkeys: harness.hotkeys,
        app: harness.app,
        trustedSenders: () => [{ role: 'main', webContents: harness.trustedContents, url: harness.trustedUrl }],
        transcription,
      })

      const wav = new ArrayBuffer(1_024)
      await expect(harness.ipc.invoke(TRANSCRIPTION_TRANSCRIBE, { requestId: 'r1', wav, timeoutMs: 4_000 }))
        .resolves.toEqual({ ok: true, text: 'hosted text' })
      expect(transcription.transcribe).toHaveBeenCalledWith({ requestId: 'r1', wav, timeoutMs: 4_000 })

      await expect(harness.ipc.invoke(TRANSCRIPTION_CANCEL, 'r1')).resolves.toEqual({ ok: true })
      expect(transcription.cancel).toHaveBeenCalledWith('r1')
      await expect(harness.ipc.invokeArgs(TRANSCRIPTION_CHECK_KEY, [])).resolves.toEqual({ ok: true })
      await expect(harness.ipc.invokeArgs(MICROPHONE_ENSURE_ACCESS, [])).resolves.toBe(true)

      // A header-only buffer, an unbounded one, and a non-buffer payload are all
      // rejected before the service ever sees them.
      for (const wavPayload of [new ArrayBuffer(44), new ArrayBuffer(16_000 * 2 * 301), 'audio']) {
        await expect(
          harness.ipc.invoke(TRANSCRIPTION_TRANSCRIBE, { requestId: 'r2', wav: wavPayload, timeoutMs: 4_000 }),
        ).rejects.toMatchObject({ code: 'INVALID_IPC_PAYLOAD' })
      }
      await expect(harness.ipc.invoke(TRANSCRIPTION_TRANSCRIBE, { requestId: 'r2', wav, timeoutMs: 60_000 }))
        .rejects.toMatchObject({ code: 'INVALID_IPC_PAYLOAD' })
      await expect(harness.ipc.invoke(TRANSCRIPTION_CANCEL, '')).rejects.toMatchObject({
        code: 'INVALID_IPC_PAYLOAD',
      })
      expect(transcription.transcribe).toHaveBeenCalledOnce()
    })

  it('reports transcription as unconfigured when no service is wired', async () => {
      const harness = createIpcHarness()

      await expect(
        harness.ipc.invoke(TRANSCRIPTION_TRANSCRIBE, {
          requestId: 'r1',
          wav: new ArrayBuffer(1_024),
          timeoutMs: 4_000,
        }),
      ).resolves.toEqual({ ok: false, reason: 'unconfigured' })
      await expect(harness.ipc.invokeArgs(TRANSCRIPTION_CHECK_KEY, [])).resolves.toEqual({
        ok: false,
        reason: 'unconfigured',
      })
      await expect(harness.ipc.invoke(TRANSCRIPTION_CANCEL, 'r1')).resolves.toEqual({
        ok: false,
        reason: 'unavailable',
      })
      harness.cleanup()
    })
})
