// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  registerIpc
} from '../../src/main/ipc/registerIpc'
import {
  MICROPHONE_ENSURE_ACCESS,
  TRANSCRIPTION_CANCEL,
  OPENROUTER_CHECK_KEY,
  SPEECH_MODEL_CHOOSE,
  SPEECH_MODEL_DOWNLOAD,
  SPEECH_MODEL_GET_STATUS,
  SPEECH_MODEL_LIST,
  TRANSCRIPTION_TRANSCRIBE
} from '../../src/shared/channels'
import { createIpcHarness } from '../fixtures/ipcHarness'

describe('IPC validation and lifecycle', () => {
  it('forwards transcription, the speech model and the key check over dedicated channels and rejects oversized or malformed audio', async () => {
      const harness = createIpcHarness()
      harness.cleanup()
      const transcription = {
        transcribe: vi.fn(async () => ({ ok: true as const, text: 'local text' })),
        cancel: vi.fn(),
      }
      const speechModel = {
        status: vi.fn(() => ({ state: 'downloading' as const, receivedBytes: 1_000, totalBytes: 2_000 })),
        download: vi.fn(),
        list: vi.fn(async () => [{ id: 'parakeet-tdt-0.6b-v3-int8', name: 'Parakeet v3', maker: 'NVIDIA', languages: '25 European languages', source: 'sotto' as const, installed: false, bytes: 670_478_772 }]),
        choose: vi.fn(async (id: string) => id === 'parakeet-tdt-0.6b-v3-int8'),
      }
      const openRouterKey = { check: vi.fn(async () => ({ ok: true as const })) }
      registerIpc(harness.ipc, {
        settings: harness.settings,
        history: harness.history,
        startup: harness.startup,
        hotkeys: harness.hotkeys,
        app: harness.app,
        trustedSenders: () => [{ role: 'main', webContents: harness.trustedContents, url: harness.trustedUrl }],
        transcription,
        speechModel,
        openRouterKey,
      })

      const wav = new ArrayBuffer(1_024)
      await expect(harness.ipc.invoke(TRANSCRIPTION_TRANSCRIBE, { requestId: 'r1', wav, timeoutMs: 4_000 }))
        .resolves.toEqual({ ok: true, text: 'local text' })
      expect(transcription.transcribe).toHaveBeenCalledWith({ requestId: 'r1', wav, timeoutMs: 4_000 })

      await expect(harness.ipc.invoke(TRANSCRIPTION_CANCEL, 'r1')).resolves.toEqual({ ok: true })
      expect(transcription.cancel).toHaveBeenCalledWith('r1')
      await expect(harness.ipc.invokeArgs(OPENROUTER_CHECK_KEY, [])).resolves.toEqual({ ok: true })
      expect(openRouterKey.check).toHaveBeenCalledOnce()
      await expect(harness.ipc.invokeArgs(SPEECH_MODEL_GET_STATUS, [])).resolves.toEqual({
        state: 'downloading',
        receivedBytes: 1_000,
        totalBytes: 2_000,
      })
      await expect(harness.ipc.invokeArgs(SPEECH_MODEL_DOWNLOAD, [])).resolves.toEqual({ ok: true })
      expect(speechModel.download).toHaveBeenCalledOnce()
      await expect(harness.ipc.invokeArgs(SPEECH_MODEL_LIST, [])).resolves.toMatchObject([{ id: 'parakeet-tdt-0.6b-v3-int8', installed: false }])
      await expect(harness.ipc.invoke(SPEECH_MODEL_CHOOSE, 'parakeet-tdt-0.6b-v3-int8')).resolves.toEqual({ ok: true })
      await expect(harness.ipc.invoke(SPEECH_MODEL_CHOOSE, 'fluidaudio:elsewhere')).resolves.toEqual({ ok: false, reason: 'unavailable' })
      await expect(harness.ipc.invoke(SPEECH_MODEL_CHOOSE, '')).rejects.toMatchObject({ code: 'INVALID_IPC_PAYLOAD' })
      expect(speechModel.choose).toHaveBeenCalledTimes(2)
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

  it('reports the speech model as not ready when no service is wired', async () => {
      const harness = createIpcHarness()

      await expect(
        harness.ipc.invoke(TRANSCRIPTION_TRANSCRIBE, {
          requestId: 'r1',
          wav: new ArrayBuffer(1_024),
          timeoutMs: 4_000,
        }),
      ).resolves.toEqual({ ok: false, reason: 'model-not-ready' })
      await expect(harness.ipc.invokeArgs(SPEECH_MODEL_GET_STATUS, [])).resolves.toEqual({ state: 'missing' })
      await expect(harness.ipc.invokeArgs(SPEECH_MODEL_DOWNLOAD, [])).resolves.toEqual({
        ok: false,
        reason: 'unavailable',
      })
      await expect(harness.ipc.invokeArgs(SPEECH_MODEL_LIST, [])).resolves.toEqual([])
      await expect(harness.ipc.invoke(SPEECH_MODEL_CHOOSE, 'parakeet-tdt-0.6b-v3-int8')).resolves.toEqual({ ok: false, reason: 'unavailable' })
      await expect(harness.ipc.invokeArgs(OPENROUTER_CHECK_KEY, [])).resolves.toEqual({
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
