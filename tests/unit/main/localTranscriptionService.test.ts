// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { LocalTranscriptionService, type TranscriptionFailureDiagnostic } from '../../../src/main/asr/localTranscriptionService'
import type { SpeechEngine } from '../../../src/main/asr/speechEngine'
import { encodeWavPcm16 } from '../../../src/shared/wav'
import { deferred } from '../../fixtures/deferred'

const wav = (seconds = 1): ArrayBuffer => encodeWavPcm16(new Float32Array(16_000 * seconds).fill(0.25), 16_000).buffer as ArrayBuffer
const request = (requestId: string, audio = wav()) => ({ requestId, wav: audio, timeoutMs: 15_000 })

function setup(engine: SpeechEngine | null) {
  const failures: TranscriptionFailureDiagnostic[] = []
  let current = engine
  const service = new LocalTranscriptionService({ engine: () => current, onFailure: (diagnostic) => failures.push(diagnostic), now: () => 1_000 })
  return { service, failures, setEngine: (next: SpeechEngine | null) => { current = next } }
}

describe('LocalTranscriptionService', () => {
  it('hands the engine the segment as float samples and returns its words', async () => {
    const transcribe = vi.fn(async (samples: Float32Array) => `heard ${samples.length} samples`)
    const { service, failures } = setup({ transcribe })
    expect(await service.transcribe(request('one'))).toEqual({ ok: true, text: 'heard 16000 samples' })
    expect(transcribe.mock.calls[0]?.[0][0]).toBeCloseTo(0.25, 3)
    expect(failures).toEqual([])
  })

  it('says the model is not ready while there is no engine, and records why without the audio', async () => {
    const { service, failures } = setup(null)
    expect(await service.transcribe(request('one', wav(2)))).toEqual({ ok: false, reason: 'model-not-ready' })
    expect(failures).toEqual([{ at: 1_000, reason: 'model-not-ready', audioMs: 2_000, elapsedMs: 0 }])
  })

  it('refuses audio that is not a WAV the recorder makes', async () => {
    const transcribe = vi.fn(async () => 'never')
    const { service, failures } = setup({ transcribe })
    const stereo = wav()
    new DataView(stereo).setUint16(22, 2, true)
    expect(await service.transcribe(request('one', stereo))).toEqual({ ok: false, reason: 'malformed' })
    expect(transcribe).not.toHaveBeenCalled()
    expect(failures.map((failure) => failure.reason)).toEqual(['malformed'])
  })

  it('reports an engine error as a failed segment', async () => {
    const { service, failures } = setup({ transcribe: async () => { throw new Error('decode failed') } })
    expect(await service.transcribe(request('one'))).toEqual({ ok: false, reason: 'failed' })
    expect(failures.map((failure) => failure.reason)).toEqual(['failed'])
  })

  it('decodes one segment at a time, in the order they arrive', async () => {
    const first = deferred<string>()
    const order: string[] = []
    const transcribe = vi.fn(async (samples: Float32Array) => {
      order.push(`start ${samples.length}`)
      const text = samples.length === 16_000 ? await first.promise : 'second'
      order.push(`end ${samples.length}`)
      return text
    })
    const { service } = setup({ transcribe })
    const one = service.transcribe(request('one', wav(1)))
    const two = service.transcribe(request('two', wav(2)))
    await Promise.resolve()
    first.resolve('first')
    expect(await one).toEqual({ ok: true, text: 'first' })
    expect(await two).toEqual({ ok: true, text: 'second' })
    expect(order).toEqual(['start 16000', 'end 16000', 'start 32000', 'end 32000'])
  })

  it('drops the text of a segment cancelled while it was being transcribed, and records nothing', async () => {
    const held = deferred<string>()
    const { service, failures } = setup({ transcribe: () => held.promise })
    const result = service.transcribe(request('one'))
    service.cancel('one')
    held.resolve('too late')
    expect(await result).toEqual({ ok: false, reason: 'cancelled' })
    expect(failures).toEqual([])
  })

  it('treats an engine error after a cancel as the cancel, and records nothing', async () => {
    const held = deferred<string>()
    const transcribe = vi.fn(() => held.promise)
    const { service, failures } = setup({ transcribe })
    const result = service.transcribe(request('one'))
    // Cancel while the engine is decoding, so its rejection is what comes back.
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce())
    service.cancel('one')
    held.reject(new Error('decode interrupted'))
    expect(await result).toEqual({ ok: false, reason: 'cancelled' })
    expect(failures).toEqual([])
  })

  it('ignores a cancel for a segment that already finished', async () => {
    const { service } = setup({ transcribe: async () => 'done' })
    expect(await service.transcribe(request('one'))).toEqual({ ok: true, text: 'done' })
    service.cancel('one')
    expect(await service.transcribe(request('one'))).toEqual({ ok: true, text: 'done' })
  })

  it('answers model-not-ready for a queued segment when the engine goes away first', async () => {
    const held = deferred<string>()
    const transcribe = vi.fn(() => held.promise)
    const { service, setEngine } = setup({ transcribe })
    const one = service.transcribe(request('one'))
    const two = service.transcribe(request('two'))
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce())
    setEngine(null)
    held.resolve('first')
    expect(await one).toEqual({ ok: true, text: 'first' })
    expect(await two).toEqual({ ok: false, reason: 'model-not-ready' })
  })
})
