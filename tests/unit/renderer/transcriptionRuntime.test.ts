import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  createTranscriptionRuntime,
  type PipelineFactory,
  type SpeechRecognitionPipeline,
} from '../../../src/renderer/src/transcription/runtime'

function transcribeRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'transcribe',
    requestId: 'request-1',
    sessionId: 'session-1',
    audio: new Float32Array([0.1, -0.2]),
    sampleRate: 16_000,
    preset: 'balanced',
    language: 'auto',
    inferencePreference: 'wasm',
    ...overrides,
  }
}

function deferred<Value>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('local transcription worker runtime', () => {
  it('loads the immutable q8 repository, normalizes progress, and passes raw 16 kHz audio', async () => {
    const responses: unknown[] = []
    let progressCallback: ((event: unknown) => void) | undefined
    const recognize = vi.fn(async () => ({ text: 'hello', language: 'en' }))
    const createPipeline = vi.fn(async (_task, _repository, options) => {
      progressCallback = options.progress_callback
      progressCallback?.({
        status: 'progress',
        file: 'private-path',
        progress_total: 50,
        progress: 99,
      })
      return recognize
    }) as PipelineFactory
    const runtime = createTranscriptionRuntime({
      createPipeline,
      postMessage: (message) => responses.push(message),
      probeWebGpu: async () => false,
    })
    const audio = new Float32Array([0.1, -0.2])

    await runtime.handleMessage(transcribeRequest({ audio }))

    expect(createPipeline).toHaveBeenCalledWith(
      'automatic-speech-recognition',
      'Xenova/whisper-base',
      expect.objectContaining({
        dtype: 'q8',
        device: 'wasm',
        local_files_only: true,
        session_options: { graphOptimizationLevel: 'basic' },
      }),
    )
    expect(recognize).toHaveBeenCalledWith(audio, { task: 'transcribe' })
    expect(responses).toContainEqual({
      type: 'progress',
      requestId: 'request-1',
      sessionId: 'session-1',
      stage: 'loading-model',
      progress: 0.5,
    })
    expect(JSON.stringify(responses)).not.toContain('private-path')
    expect(responses.at(-1)).toEqual({
      type: 'result',
      requestId: 'request-1',
      sessionId: 'session-1',
      text: 'hello',
      language: 'en',
    })
  })

  it.each([
    ['fast', 'Xenova/whisper-tiny'],
    ['balanced', 'Xenova/whisper-base'],
    ['accurate', 'Xenova/whisper-small'],
  ] as const)('maps %s only to its pinned local catalog repository', async (preset, repository) => {
    const createPipeline = vi.fn(async () => vi.fn(async () => ({ text: 'ok' }))) as PipelineFactory
    const runtime = createTranscriptionRuntime({
      createPipeline,
      postMessage: vi.fn(),
      probeWebGpu: async () => false,
    })

    await runtime.handleMessage(transcribeRequest({ preset }))

    expect(createPipeline).toHaveBeenCalledWith(
      'automatic-speech-recognition',
      repository,
      expect.objectContaining({ dtype: 'q8', device: 'wasm' }),
    )
  })

  it('passes an explicit language but omits language for auto detection', async () => {
    const recognize = vi.fn(async () => ({ text: 'bonjour', language: 'fr' }))
    const responses: unknown[] = []
    const runtime = createTranscriptionRuntime({
      createPipeline: vi.fn(async () => recognize) as PipelineFactory,
      postMessage: (message) => responses.push(message),
      probeWebGpu: async () => false,
    })

    await runtime.handleMessage(transcribeRequest({ requestId: 'r-auto' }))
    await runtime.handleMessage(
      transcribeRequest({ requestId: 'r-fr', sessionId: 's-fr', language: 'fr' }),
    )

    expect(recognize).toHaveBeenNthCalledWith(1, expect.any(Float32Array), {
      task: 'transcribe',
    })
    expect(recognize).toHaveBeenNthCalledWith(2, expect.any(Float32Array), {
      task: 'transcribe',
      language: 'fr',
    })
    expect(responses).toContainEqual(
      expect.objectContaining({ requestId: 'r-auto', language: 'en' }),
    )
    expect(responses).toContainEqual(
      expect.objectContaining({ requestId: 'r-fr', language: 'fr' }),
    )
  })

  it('reports WebGPU failure for client retry in a fresh worker context', async () => {
    const responses: unknown[] = []
    const wasmPipeline = vi.fn(async () => ({ text: 'must not run here' }))
    const createPipelineMock = vi.fn<PipelineFactory>(async (_task, _repository, options) => {
      if (options.device === 'webgpu') throw new Error('GPU adapter failed at a private path')
      return wasmPipeline
    })
    const createPipeline = createPipelineMock
    const runtime = createTranscriptionRuntime({
      createPipeline,
      postMessage: (message) => responses.push(message),
      probeWebGpu: async () => true,
    })

    await runtime.handleMessage(transcribeRequest({ inferencePreference: 'webgpu' }))

    expect(createPipeline).toHaveBeenCalledTimes(1)
    expect(createPipeline).toHaveBeenCalledWith(
      'automatic-speech-recognition',
      'Xenova/whisper-base',
      expect.objectContaining({ device: 'webgpu', local_files_only: true }),
    )
    expect(wasmPipeline).not.toHaveBeenCalled()
    expect(responses.at(-1)).toEqual({
      type: 'error',
      requestId: 'request-1',
      sessionId: 'session-1',
      code: 'WEBGPU_FAILED',
      message: 'WebGPU transcription is unavailable.',
    })
    expect(JSON.stringify(responses)).not.toContain('private path')
  })

  it('uses WASM directly for auto even when a WebGPU adapter is present', async () => {
    // The packaged runtime cannot initialize ORT WebGPU (no jsep build), and
    // measured WebGPU inference is slower than WASM on integrated GPUs, so
    // 'auto' must not pay a doomed WebGPU load + worker restart.
    const createPipelineMock = vi.fn<PipelineFactory>(async () =>
      vi.fn(async () => ({ text: 'wasm result' })),
    )
    const responses: unknown[] = []
    const probeWebGpu = vi.fn(async () => true)
    const runtime = createTranscriptionRuntime({
      createPipeline: createPipelineMock,
      postMessage: (message) => responses.push(message),
      probeWebGpu,
    })

    await runtime.handleMessage(transcribeRequest({ inferencePreference: 'auto' }))
    await runtime.handleMessage({
      type: 'load',
      requestId: 'load-auto',
      preset: 'balanced',
      inferencePreference: 'auto',
    })

    expect(createPipelineMock).toHaveBeenCalledTimes(1)
    expect(createPipelineMock.mock.calls[0]?.[2].device).toBe('wasm')
    expect(responses).toContainEqual(
      expect.objectContaining({ type: 'result', requestId: 'request-1', text: 'wasm result' }),
    )
    expect(responses).toContainEqual(
      expect.objectContaining({ type: 'ready', requestId: 'load-auto', device: 'wasm' }),
    )
  })

  it('uses WASM directly for auto without navigator.gpu and rejects explicit WebGPU safely', async () => {
    const createPipelineMock = vi.fn<PipelineFactory>(async () =>
      vi.fn(async () => ({ text: 'wasm' })),
    )
    const createPipeline = createPipelineMock
    const responses: unknown[] = []
    const runtime = createTranscriptionRuntime({
      createPipeline,
      postMessage: (message) => responses.push(message),
      probeWebGpu: async () => false,
    })

    await runtime.handleMessage(transcribeRequest({ requestId: 'auto', inferencePreference: 'auto' }))
    await runtime.handleMessage(
      transcribeRequest({ requestId: 'gpu', sessionId: 'gpu-session', inferencePreference: 'webgpu' }),
    )

    expect(createPipeline).toHaveBeenCalledTimes(1)
    expect(createPipelineMock.mock.calls[0]?.[2].device).toBe('wasm')
    expect(responses.at(-1)).toEqual({
      type: 'error',
      requestId: 'gpu',
      sessionId: 'gpu-session',
      code: 'WEBGPU_FAILED',
      message: 'WebGPU transcription is unavailable.',
    })
  })

  it('normalizes model-load, memory, and inference failures without raw details', async () => {
    const responses: unknown[] = []
    const missingRuntime = createTranscriptionRuntime({
      createPipeline: vi.fn(async () => {
        throw new Error('404 C:\\Users\\person\\secret-model')
      }) as PipelineFactory,
      postMessage: (message) => responses.push(message),
      probeWebGpu: async () => false,
    })
    await missingRuntime.handleMessage({
      type: 'load',
      requestId: 'load',
      preset: 'balanced',
      inferencePreference: 'wasm',
    })

    const memoryRuntime = createTranscriptionRuntime({
      createPipeline: vi.fn(async () => {
        return vi.fn(async () => {
          throw new Error('out of memory while reading secret audio')
        })
      }) as PipelineFactory,
      postMessage: (message) => responses.push(message),
      probeWebGpu: async () => false,
    })
    await memoryRuntime.handleMessage(transcribeRequest({ requestId: 'memory' }))

    const inferenceRuntime = createTranscriptionRuntime({
      createPipeline: vi.fn(async () => {
        return vi.fn(async () => {
          throw new Error('decoder exploded with transcript text')
        })
      }) as PipelineFactory,
      postMessage: (message) => responses.push(message),
      probeWebGpu: async () => false,
    })
    await inferenceRuntime.handleMessage(transcribeRequest({ requestId: 'inference' }))

    expect(responses).toContainEqual({
      type: 'error',
      requestId: 'load',
      code: 'MODEL_MISSING',
      message: 'The selected local speech model is unavailable.',
    })
    expect(responses).toContainEqual(
      expect.objectContaining({ requestId: 'memory', code: 'OUT_OF_MEMORY' }),
    )
    expect(responses).toContainEqual(
      expect.objectContaining({ requestId: 'inference', code: 'TRANSCRIPTION_FAILED' }),
    )
    expect(JSON.stringify(responses)).not.toMatch(/secret|C:\\|decoder exploded/i)
  })

  it('classifies a missing model during transcription without exposing its path', async () => {
    const responses: unknown[] = []
    const runtime = createTranscriptionRuntime({
      createPipeline: vi.fn(async () => {
        throw new Error('ENOENT D:\\private\\model.onnx')
      }) as PipelineFactory,
      postMessage: (message) => responses.push(message),
      probeWebGpu: async () => false,
    })

    await runtime.handleMessage(transcribeRequest())

    expect(responses.at(-1)).toEqual({
      type: 'error',
      requestId: 'request-1',
      sessionId: 'session-1',
      code: 'MODEL_MISSING',
      message: 'The selected local speech model is unavailable.',
    })
    expect(JSON.stringify(responses)).not.toContain('private')
  })

  it('cancels queued work before it starts', async () => {
    const firstResult = deferred<{ text: string }>()
    const recognize = vi
      .fn<SpeechRecognitionPipeline>()
      .mockImplementationOnce(() => firstResult.promise)
      .mockResolvedValue({ text: 'queued result' })
    const responses: unknown[] = []
    const runtime = createTranscriptionRuntime({
      createPipeline: vi.fn(async () => recognize) as PipelineFactory,
      postMessage: (message) => responses.push(message),
      probeWebGpu: async () => false,
    })

    const first = runtime.handleMessage(transcribeRequest({ requestId: 'first', sessionId: 's-first' }))
    const queued = runtime.handleMessage(transcribeRequest({ requestId: 'second', sessionId: 's-second' }))
    await Promise.resolve()
    await runtime.handleMessage({
      type: 'cancel',
      requestId: 'cancel-second',
      targetRequestId: 'second',
      sessionId: 's-second',
    })
    firstResult.resolve({ text: 'first result' })
    await Promise.all([first, queued])

    expect(recognize).toHaveBeenCalledOnce()
    expect(responses).not.toContainEqual(expect.objectContaining({ requestId: 'second' }))
  })

  it('ignores a queued cancellation whose session does not own the target request', async () => {
    const firstResult = deferred<{ text: string }>()
    const recognize = vi
      .fn<SpeechRecognitionPipeline>()
      .mockImplementationOnce(() => firstResult.promise)
      .mockResolvedValue({ text: 'owned by session two' })
    const responses: unknown[] = []
    const runtime = createTranscriptionRuntime({
      createPipeline: vi.fn(async () => recognize) as PipelineFactory,
      postMessage: (message) => responses.push(message),
      probeWebGpu: async () => false,
    })

    const first = runtime.handleMessage(
      transcribeRequest({ requestId: 'first', sessionId: 'session-one' }),
    )
    const queued = runtime.handleMessage(
      transcribeRequest({ requestId: 'second', sessionId: 'session-two' }),
    )
    await Promise.resolve()
    await runtime.handleMessage({
      type: 'cancel',
      requestId: 'cancel-second',
      targetRequestId: 'second',
      sessionId: 'wrong-session',
    })
    firstResult.resolve({ text: 'first result' })
    await Promise.all([first, queued])

    expect(recognize).toHaveBeenCalledTimes(2)
    expect(responses).toContainEqual(
      expect.objectContaining({
        type: 'result',
        requestId: 'second',
        sessionId: 'session-two',
      }),
    )
  })

  it('suppresses progress and results when cancellation arrives during inference', async () => {
    const inference = deferred<{ text: string }>()
    const responses: unknown[] = []
    const runtime = createTranscriptionRuntime({
      createPipeline: vi.fn(async () => vi.fn(() => inference.promise)) as PipelineFactory,
      postMessage: (message) => responses.push(message),
      probeWebGpu: async () => false,
    })

    const work = runtime.handleMessage(transcribeRequest())
    await vi.waitFor(() => {
      expect(responses).toContainEqual(
        expect.objectContaining({ type: 'progress', stage: 'transcribing', progress: 0 }),
      )
    })
    await runtime.handleMessage({
      type: 'cancel',
      requestId: 'cancel',
      targetRequestId: 'request-1',
      sessionId: 'session-1',
    })
    inference.resolve({ text: 'must not publish' })
    await work

    expect(responses).not.toContainEqual(expect.objectContaining({ type: 'result' }))
    expect(responses.at(-1)).not.toEqual(
      expect.objectContaining({ type: 'progress', progress: 1 }),
    )
  })

  it('ignores mismatched active cancellation and cancellation targeting a load request', async () => {
    const activeInference = deferred<{ text: string }>()
    const loadPipeline = deferred<SpeechRecognitionPipeline>()
    const activePipeline = vi.fn(() => activeInference.promise)
    const readyPipeline = vi.fn(async () => ({ text: 'unused' }))
    const createPipeline = vi
      .fn<PipelineFactory>()
      .mockResolvedValueOnce(activePipeline)
      .mockImplementationOnce(() => loadPipeline.promise)
    const responses: unknown[] = []
    const runtime = createTranscriptionRuntime({
      createPipeline,
      postMessage: (message) => responses.push(message),
      probeWebGpu: async () => false,
    })

    const active = runtime.handleMessage(
      transcribeRequest({ requestId: 'active', sessionId: 'owner-session' }),
    )
    await vi.waitFor(() => {
      expect(activePipeline).toHaveBeenCalledOnce()
    })
    await runtime.handleMessage({
      type: 'cancel',
      requestId: 'wrong-cancel',
      targetRequestId: 'active',
      sessionId: 'intruder-session',
    })
    activeInference.resolve({ text: 'owner result' })
    await active

    const load = runtime.handleMessage({
      type: 'load',
      requestId: 'load-request',
      preset: 'accurate',
      inferencePreference: 'wasm',
    })
    await vi.waitFor(() => {
      expect(createPipeline).toHaveBeenCalledTimes(2)
    })
    await runtime.handleMessage({
      type: 'cancel',
      requestId: 'cancel-load',
      targetRequestId: 'load-request',
      sessionId: 'any-session',
    })
    loadPipeline.resolve(readyPipeline)
    await load

    expect(responses).toContainEqual(
      expect.objectContaining({ type: 'result', requestId: 'active' }),
    )
    expect(responses).toContainEqual(
      expect.objectContaining({ type: 'ready', requestId: 'load-request' }),
    )
  })

  it('forgets completed ownership metadata so a late cancel cannot affect later work', async () => {
    const recognize = vi.fn(async () => ({ text: 'complete' }))
    const responses: unknown[] = []
    const runtime = createTranscriptionRuntime({
      createPipeline: vi.fn(async () => recognize) as PipelineFactory,
      postMessage: (message) => responses.push(message),
      probeWebGpu: async () => false,
    })

    await runtime.handleMessage(
      transcribeRequest({ requestId: 'reused-id', sessionId: 'owner-session' }),
    )
    await runtime.handleMessage({
      type: 'cancel',
      requestId: 'late-cancel',
      targetRequestId: 'reused-id',
      sessionId: 'owner-session',
    })
    await runtime.handleMessage(
      transcribeRequest({ requestId: 'reused-id', sessionId: 'owner-session' }),
    )

    expect(recognize).toHaveBeenCalledTimes(2)
    expect(
      responses.filter(
        (response) =>
          typeof response === 'object' &&
          response !== null &&
          'type' in response &&
          response.type === 'result',
      ),
    ).toHaveLength(2)
  })

  it('reuses a loaded pipeline without concurrent duplicate initialization', async () => {
    const pipelineResult = deferred<SpeechRecognitionPipeline>()
    const createPipeline = vi.fn(() => pipelineResult.promise) as PipelineFactory
    const runtime = createTranscriptionRuntime({
      createPipeline,
      postMessage: vi.fn(),
      probeWebGpu: async () => false,
    })

    const first = runtime.handleMessage({
      type: 'load',
      requestId: 'load-1',
      preset: 'balanced',
      inferencePreference: 'wasm',
    })
    const second = runtime.handleMessage({
      type: 'load',
      requestId: 'load-2',
      preset: 'balanced',
      inferencePreference: 'wasm',
    })
    pipelineResult.resolve(vi.fn(async () => ({ text: 'unused' })))
    await Promise.all([first, second])

    expect(createPipeline).toHaveBeenCalledOnce()
  })

  it('keeps only one active model/device pipeline and disposes it before switching', async () => {
    const disposeFast = vi.fn(async () => undefined)
    const fastPipeline = Object.assign(vi.fn(async () => ({ text: 'fast' })), {
      dispose: disposeFast,
    })
    const balancedPipeline = vi.fn(async () => ({ text: 'balanced' }))
    const createPipeline = vi
      .fn<PipelineFactory>()
      .mockResolvedValueOnce(fastPipeline)
      .mockResolvedValueOnce(balancedPipeline)
    const runtime = createTranscriptionRuntime({
      createPipeline,
      postMessage: vi.fn(),
      probeWebGpu: async () => false,
    })

    await runtime.handleMessage({
      type: 'load',
      requestId: 'fast',
      preset: 'fast',
      inferencePreference: 'wasm',
    })
    await runtime.handleMessage({
      type: 'load',
      requestId: 'balanced',
      preset: 'balanced',
      inferencePreference: 'wasm',
    })

    expect(disposeFast).toHaveBeenCalledOnce()
    expect(createPipeline).toHaveBeenCalledTimes(2)
  })

  it('does not retain a failed pipeline initialization', async () => {
    const createPipeline = vi
      .fn<PipelineFactory>()
      .mockRejectedValueOnce(new Error('missing local model'))
      .mockResolvedValueOnce(vi.fn(async () => ({ text: 'ready' })))
    const responses: unknown[] = []
    const runtime = createTranscriptionRuntime({
      createPipeline,
      postMessage: (message) => responses.push(message),
      probeWebGpu: async () => false,
    })
    const request = {
      type: 'load',
      requestId: 'first',
      preset: 'balanced',
      inferencePreference: 'wasm',
    }

    await runtime.handleMessage(request)
    await runtime.handleMessage({ ...request, requestId: 'second' })

    expect(createPipeline).toHaveBeenCalledTimes(2)
    expect(responses.at(-1)).toEqual(
      expect.objectContaining({ type: 'ready', requestId: 'second' }),
    )
  })

  it('disposes an OOM-failed WASM pipeline so the same key reloads cleanly', async () => {
    const disposeFailed = vi.fn(async () => undefined)
    const failedPipeline = Object.assign(
      vi.fn(async () => {
        throw new Error('out of memory in backend')
      }),
      { dispose: disposeFailed },
    )
    const replacementPipeline = vi.fn(async () => ({ text: 'recovered' }))
    const createPipeline = vi
      .fn<PipelineFactory>()
      .mockResolvedValueOnce(failedPipeline)
      .mockResolvedValueOnce(replacementPipeline)
    const responses: unknown[] = []
    const runtime = createTranscriptionRuntime({
      createPipeline,
      postMessage: (message) => responses.push(message),
      probeWebGpu: async () => false,
    })

    await runtime.handleMessage(transcribeRequest({ requestId: 'oom' }))
    await runtime.handleMessage(transcribeRequest({ requestId: 'retry' }))

    expect(disposeFailed).toHaveBeenCalledOnce()
    expect(createPipeline).toHaveBeenCalledTimes(2)
    expect(responses).toContainEqual(
      expect.objectContaining({ requestId: 'oom', code: 'OUT_OF_MEMORY' }),
    )
    expect(responses.at(-1)).toEqual(
      expect.objectContaining({ type: 'result', requestId: 'retry', text: 'recovered' }),
    )
  })

  it('disposes an explicit WebGPU backend failure before same-key retry', async () => {
    const disposeFailed = vi.fn(async () => undefined)
    const failedPipeline = Object.assign(
      vi.fn(async () => {
        throw new Error('GPU execution provider failed')
      }),
      { dispose: disposeFailed },
    )
    const replacementPipeline = vi.fn(async () => ({ text: 'gpu recovered' }))
    const createPipeline = vi
      .fn<PipelineFactory>()
      .mockResolvedValueOnce(failedPipeline)
      .mockResolvedValueOnce(replacementPipeline)
    const responses: unknown[] = []
    const runtime = createTranscriptionRuntime({
      createPipeline,
      postMessage: (message) => responses.push(message),
      probeWebGpu: async () => true,
    })

    await runtime.handleMessage(
      transcribeRequest({ requestId: 'gpu-failure', inferencePreference: 'webgpu' }),
    )
    await runtime.handleMessage(
      transcribeRequest({ requestId: 'gpu-retry', inferencePreference: 'webgpu' }),
    )

    expect(disposeFailed).toHaveBeenCalledOnce()
    expect(createPipeline).toHaveBeenCalledTimes(2)
    expect(responses).toContainEqual(
      expect.objectContaining({ requestId: 'gpu-failure', code: 'WEBGPU_FAILED' }),
    )
    expect(responses.at(-1)).toEqual(
      expect.objectContaining({ type: 'result', requestId: 'gpu-retry' }),
    )
  })

  it('makes worker startup execute the shared production environment configurator', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/transcription/worker.ts'),
      'utf8',
    )

    expect(source).toContain(
      'configureLocalInferenceEnvironment(env, navigator.hardwareConcurrency)',
    )
    expect(source).not.toContain('env.allowRemoteModels =')
    expect(source).not.toContain('env.localModelPath =')
  })
})
