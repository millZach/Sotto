import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenRouterTranscriber, TranscriptionError, type TranscribeOptions, type TranscriptionBridge } from '../../../src/renderer/src/transcription/openRouterTranscriber'
import { transcriptionTimeoutMs, type TranscriptionFailureReason } from '../../../src/shared/contracts'
import { TRANSCRIPTION_SAMPLE_RATE } from '../../../src/shared/audio'
import { encodeWavPcm16 } from '../../../src/shared/wav'

function options(seconds = 2): TranscribeOptions {
  return { sessionId: 'session', audio: new Float32Array(Math.round(seconds * TRANSCRIPTION_SAMPLE_RATE)).fill(0.25), language: 'auto' }
}
function harness(overrides: Partial<TranscriptionBridge> = {}) {
  const bridge: TranscriptionBridge = {
    transcribe: vi.fn(async () => ({ ok: true as const, text: 'Sotto' })),
    cancelTranscription: vi.fn(async () => undefined),
    ...overrides,
  }
  const client = new OpenRouterTranscriber({ bridge, createRequestId: () => 'request' })
  return { client, bridge }
}
afterEach(() => vi.useRealTimers())

describe('OpenRouterTranscriber', () => {
  it.each([2, 4.4, 0.0000625, 100])('encodes WAV and uses a bounded integer timeout for %s seconds', async (seconds) => {
    const { client, bridge } = harness()
    const request = options(seconds)
    await expect(client.load()).resolves.toBeUndefined()
    await expect(client.transcribe(request)).resolves.toEqual({ text: 'Sotto', language: 'auto' })
    expect(bridge.transcribe).toHaveBeenCalledWith({
      requestId: 'request', wav: encodeWavPcm16(request.audio, TRANSCRIPTION_SAMPLE_RATE).buffer,
      timeoutMs: Math.ceil(transcriptionTimeoutMs(request.audio.length / TRANSCRIPTION_SAMPLE_RATE)),
    })
    client.dispose()
  })

  it.each<TranscriptionFailureReason>(['unconfigured', 'unauthorized', 'billing', 'rate-limited', 'timeout', 'http', 'network', 'cancelled', 'malformed'])('retains the %s failure reason', async (reason) => {
    const { client } = harness({ transcribe: vi.fn(async () => ({ ok: false as const, reason })) })
    await expect(client.transcribe(options())).rejects.toMatchObject({ name: 'TranscriptionError', reason })
    client.dispose()
  })

  it('cancels a session and ignores its late reply', async () => {
    let resolve!: (result: { ok: true; text: string }) => void
    const response = new Promise<{ ok: true; text: string }>((done) => { resolve = done })
    const { client, bridge } = harness({ transcribe: vi.fn(() => response) })
    const pending = client.transcribe(options())
    const rejection = expect(pending).rejects.toMatchObject({ reason: 'cancelled' })
    await Promise.resolve()
    client.cancel('session')
    await rejection
    expect(bridge.cancelTranscription).toHaveBeenCalledWith('request')
    resolve({ ok: true, text: 'late' })
    await Promise.resolve()
    client.dispose()
  })

  it('does not send an upload cancelled before the bridge is called', async () => {
    const { client, bridge } = harness()
    const pending = client.transcribe(options())
    const rejection = expect(pending).rejects.toMatchObject({ reason: 'cancelled' })
    client.cancel('session')
    await rejection
    expect(bridge.transcribe).not.toHaveBeenCalled()
    client.dispose()
  })

  it('bounds stalled IPC and requests cancellation', async () => {
    vi.useFakeTimers()
    const { client, bridge } = harness({ transcribe: vi.fn(() => new Promise<never>(() => undefined)) })
    const pending = client.transcribe(options())
    const rejection = expect(pending).rejects.toMatchObject({ reason: 'timeout' })
    await vi.advanceTimersByTimeAsync(9_600)
    await rejection
    expect(bridge.cancelTranscription).toHaveBeenCalledWith('request')
    client.dispose()
  })

  it('settles synchronous bridge errors without leaking pending timers', async () => {
    vi.useFakeTimers()
    const { client, bridge } = harness({ transcribe() { throw new Error('IPC unavailable') } })
    await expect(client.transcribe(options())).rejects.toBeInstanceOf(TranscriptionError)
    expect(vi.getTimerCount()).toBe(0)
    client.dispose()
    expect(bridge.cancelTranscription).not.toHaveBeenCalled()
  })
})
