import { describe, expect, it, vi } from 'vitest'

import {
  REMOTE_TRANSCRIPTION_TIMEOUT_MS,
  RemoteTranscriptionClient,
  RemoteTranscriptionError,
  type RemoteTranscriptionBridge,
} from '../../../src/renderer/src/transcription/remoteClient'
import { WAV_HEADER_BYTES } from '../../../src/shared/wav'
import type { RemoteTranscriptionResult } from '../../../src/shared/contracts'
import type { TranscribeOptions } from '../../../src/renderer/src/transcription/client'

const audio = Float32Array.from([0.2, -0.2, 0.4, -0.4])

function transcribeOptions(overrides: Partial<TranscribeOptions> = {}): TranscribeOptions {
  return {
    sessionId: 'session-1',
    audio,
    preset: 'instant',
    language: 'en',
    inferencePreference: 'wasm',
    ...overrides,
  }
}

function createClient(options: {
  transcribeRemote?: RemoteTranscriptionBridge['transcribeRemote']
  checkRemoteAsr?: RemoteTranscriptionBridge['checkRemoteAsr']
} = {}) {
  const bridge = {
    transcribeRemote: vi.fn(
      options.transcribeRemote ??
        (async (): Promise<RemoteTranscriptionResult> => ({ ok: true, text: 'remote text' })),
    ),
    cancelRemoteTranscription: vi.fn(async () => ({ ok: true as const })),
    checkRemoteAsr: vi.fn(options.checkRemoteAsr ?? (async () => ({ ok: true as const }))),
  }
  let requestCount = 0
  const client = new RemoteTranscriptionClient({
    bridge,
    createRequestId: () => `request-${++requestCount}`,
  })
  return { bridge, client }
}

describe('RemoteTranscriptionClient', () => {
  it('uploads the segment as a wav and shapes the answer like the local worker', async () => {
    const { bridge, client } = createClient()

    await expect(client.transcribe(transcribeOptions())).resolves.toEqual({
      text: 'remote text',
      language: 'en',
    })

    expect(bridge.transcribeRemote).toHaveBeenCalledOnce()
    const request = bridge.transcribeRemote.mock.calls[0]?.[0]
    expect(request?.requestId).toBe('request-1')
    expect(request?.timeoutMs).toBe(REMOTE_TRANSCRIPTION_TIMEOUT_MS)
    expect(request?.wav.byteLength).toBe(WAV_HEADER_BYTES + audio.length * 2)
  })

  it('resolves an automatic language the way the local worker does', async () => {
    const { client } = createClient()
    await expect(client.transcribe(transcribeOptions({ language: 'auto' }))).resolves.toEqual({
      text: 'remote text',
      language: 'en',
    })
  })

  it('returns an empty transcript rather than treating silence as a failure', async () => {
    const { client } = createClient({ transcribeRemote: async () => ({ ok: true, text: '' }) })
    await expect(client.transcribe(transcribeOptions())).resolves.toEqual({
      text: '',
      language: 'en',
    })
  })

  it('reports one transcribing edge so the widget does not look dead', async () => {
    const { client } = createClient()
    const onProgress = vi.fn()

    await client.transcribe(transcribeOptions({ onProgress }))

    expect(onProgress).toHaveBeenCalledWith({ stage: 'transcribing', progress: 0.5 })
  })

  it('survives a progress observer that throws', async () => {
    const { client } = createClient()
    const onProgress = vi.fn(() => {
      throw new Error('observer failed')
    })

    await expect(client.transcribe(transcribeOptions({ onProgress }))).resolves.toMatchObject({
      text: 'remote text',
    })
  })

  it.each([
    ['timeout', 'REMOTE_TIMEOUT'],
    ['cancelled', 'CANCELLED'],
    ['disabled', 'REMOTE_UNAVAILABLE'],
    ['unconfigured', 'REMOTE_UNAVAILABLE'],
    ['http', 'REMOTE_FAILED'],
    ['network', 'REMOTE_FAILED'],
    ['malformed', 'REMOTE_FAILED'],
  ] as const)('maps the %s outcome to %s', async (reason, code) => {
    const { client } = createClient({ transcribeRemote: async () => ({ ok: false, reason }) })

    await expect(client.transcribe(transcribeOptions())).rejects.toMatchObject({
      name: 'RemoteTranscriptionError',
      code,
    })
  })

  it('rejects when the bridge itself fails', async () => {
    const { client } = createClient({
      transcribeRemote: async () => {
        throw new Error('IPC_FAILED')
      },
    })

    await expect(client.transcribe(transcribeOptions())).rejects.toMatchObject({
      code: 'REMOTE_FAILED',
    })
  })

  it('cancels only the requests belonging to the cancelled session', async () => {
    const { bridge, client } = createClient({
      transcribeRemote: () => new Promise<RemoteTranscriptionResult>(() => undefined),
    })

    const cancelled = client.transcribe(transcribeOptions({ sessionId: 'session-1' }))
    const other = client.transcribe(transcribeOptions({ sessionId: 'session-2' }))
    const settled = vi.fn()
    void other.then(settled, settled)

    client.cancel('session-1')

    await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(bridge.cancelRemoteTranscription).toHaveBeenCalledExactlyOnceWith('request-1')
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
  })

  it('ignores a late answer for a request that was already cancelled', async () => {
    let answer!: (result: RemoteTranscriptionResult) => void
    const { client } = createClient({
      transcribeRemote: () =>
        new Promise<RemoteTranscriptionResult>((resolve) => {
          answer = resolve
        }),
    })

    const pending = client.transcribe(transcribeOptions())
    client.cancel('session-1')
    answer({ ok: true, text: 'too late' })

    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('gives up when the bridge round trip never settles', async () => {
    vi.useFakeTimers()
    try {
      const bridge = {
        transcribeRemote: vi.fn(() => new Promise<RemoteTranscriptionResult>(() => undefined)),
        cancelRemoteTranscription: vi.fn(async () => ({ ok: true as const })),
        checkRemoteAsr: vi.fn(async () => ({ ok: true as const })),
      }
      const client = new RemoteTranscriptionClient({
        bridge,
        timeoutMs: 1_000,
        createRequestId: () => 'request-1',
      })

      const pending = client.transcribe(transcribeOptions())
      const rejected = expect(pending).rejects.toMatchObject({ code: 'REMOTE_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(2_100)
      await rejected

      expect(bridge.cancelRemoteTranscription).toHaveBeenCalledWith('request-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects every outstanding request on dispose and refuses new ones', async () => {
    const { client } = createClient({
      transcribeRemote: () => new Promise<RemoteTranscriptionResult>(() => undefined),
    })

    const pending = client.transcribe(transcribeOptions())
    client.dispose()
    client.dispose()

    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(client.transcribe(transcribeOptions())).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
  })

  it('reads a failed health probe as unreachable', async () => {
    const healthy = createClient()
    await expect(healthy.client.check()).resolves.toBe(true)

    const unhealthy = createClient({ checkRemoteAsr: async () => ({ ok: false, reason: 'timeout' }) })
    await expect(unhealthy.client.check()).resolves.toBe(false)

    const broken = createClient({
      checkRemoteAsr: async () => {
        throw new Error('IPC_FAILED')
      },
    })
    await expect(broken.client.check()).resolves.toBe(false)
  })

  it('carries the error code on a typed error class', async () => {
    const { client } = createClient({
      transcribeRemote: async () => ({ ok: false, reason: 'timeout' }),
    })

    await expect(client.transcribe(transcribeOptions())).rejects.toBeInstanceOf(
      RemoteTranscriptionError,
    )
  })
})
