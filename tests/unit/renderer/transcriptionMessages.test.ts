import { describe, expect, it } from 'vitest'

import {
  MAX_TRANSCRIPTION_SAMPLES,
  parseWorkerRequest,
  parseWorkerResponse,
} from '../../../src/renderer/src/transcription/messages'

describe('transcription worker messages', () => {
  it('accepts strict, session-bound requests and responses', () => {
    const audio = new Float32Array([0.1, -0.2])

    expect(
      parseWorkerRequest({
        type: 'transcribe',
        requestId: 'request-1',
        sessionId: 'session-1',
        audio,
        sampleRate: 16_000,
        preset: 'instant',
        language: 'auto',
        inferencePreference: 'wasm',
      }),
    ).toEqual(expect.objectContaining({ audio, sampleRate: 16_000 }))

    expect(
      parseWorkerResponse({
        type: 'result',
        requestId: 'request-1',
        sessionId: 'session-1',
        text: 'hello',
        language: 'en',
      }),
    ).toEqual({
      type: 'result',
      requestId: 'request-1',
      sessionId: 'session-1',
      text: 'hello',
      language: 'en',
    })
  })

  it.each([
    { type: 'result', text: 4 },
    { type: 'ready', requestId: 'r1', preset: 'instant', device: 'wasm', extra: true },
    { type: 'progress', requestId: 'r1', stage: 'loading-model', progress: Infinity },
    {
      type: 'error',
      requestId: 'r1',
      code: 'RAW_LIBRARY_ERROR',
      message: 'a raw path',
    },
  ])('rejects malformed or expansive worker output %#', (message) => {
    expect(() => parseWorkerResponse(message)).toThrow()
  })

  it('rejects extra request fields, a non-literal sample rate, and unsafe audio', () => {
    const base = {
      type: 'transcribe',
      requestId: 'r1',
      sessionId: 's1',
      audio: new Float32Array([0.1]),
      sampleRate: 16_000,
      preset: 'instant',
      language: 'auto',
      inferencePreference: 'wasm',
    }

    expect(() => parseWorkerRequest({ ...base, unexpected: true })).toThrow()
    expect(() => parseWorkerRequest({ ...base, sampleRate: 48_000 })).toThrow()
    expect(() => parseWorkerRequest({ ...base, audio: new Float32Array() })).toThrow()
    expect(() => parseWorkerRequest({ ...base, audio: new Float32Array([Number.NaN]) })).toThrow()
    expect(() =>
      parseWorkerRequest({ ...base, audio: new Float32Array(MAX_TRANSCRIPTION_SAMPLES + 1) }),
    ).toThrow()
  })

  it('validates every protocol variant with bounded identifiers and fields', () => {
    expect(
      parseWorkerRequest({
        type: 'load',
        requestId: 'r-load',
        preset: 'fast',
        inferencePreference: 'webgpu',
      }).type,
    ).toBe('load')
    expect(
      parseWorkerRequest({
        type: 'cancel',
        requestId: 'r-cancel',
        targetRequestId: 'r-transcribe',
        sessionId: 's1',
      }).type,
    ).toBe('cancel')
    expect(
      parseWorkerResponse({
        type: 'progress',
        requestId: 'r1',
        sessionId: 's1',
        stage: 'transcribing',
        progress: 0.5,
      }).type,
    ).toBe('progress')
    expect(
      parseWorkerResponse({
        type: 'error',
        requestId: 'r1',
        sessionId: 's1',
        code: 'CANCELLED',
        message: 'Transcription was cancelled.',
      }).type,
    ).toBe('error')
  })
})
