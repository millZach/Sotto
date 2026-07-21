import { MODEL_CATALOG } from '../../../shared/modelCatalog'
import {
  parseWorkerRequest,
  type ErrorResponse,
  type LoadRequest,
  type ProgressResponse,
  type TranscribeRequest,
  type WorkerErrorCode,
  type WorkerResponse,
} from './messages'

export type InferenceDevice = 'webgpu' | 'wasm'

export interface SpeechRecognitionOutput {
  readonly text: string
  readonly language?: string
}

export interface SpeechRecognitionPipeline {
  (
    audio: Float32Array,
    options?: Readonly<{ task: 'transcribe'; language?: string }>,
  ): Promise<SpeechRecognitionOutput | string>
  dispose?: () => Promise<void> | void
}

export interface PipelineOptions {
  readonly dtype: 'q8'
  readonly device: InferenceDevice
  readonly local_files_only: true
  readonly session_options: Readonly<{ graphOptimizationLevel: 'basic' }>
  readonly progress_callback: (event: unknown) => void
}

export type PipelineFactory = (
  task: 'automatic-speech-recognition',
  repository: string,
  options: PipelineOptions,
) => Promise<SpeechRecognitionPipeline>

export interface TranscriptionRuntimeOptions {
  readonly createPipeline: PipelineFactory
  readonly postMessage: (message: WorkerResponse) => void
  readonly probeWebGpu: () => Promise<boolean>
}

export interface TranscriptionRuntime {
  handleMessage(message: unknown): Promise<void>
}

const ERROR_MESSAGES: Readonly<Record<WorkerErrorCode, string>> = Object.freeze({
  MODEL_MISSING: 'The selected local speech model is unavailable.',
  WEBGPU_FAILED: 'WebGPU transcription is unavailable.',
  OUT_OF_MEMORY: 'Not enough memory is available for transcription.',
  CANCELLED: 'Transcription was cancelled.',
  TRANSCRIPTION_FAILED: 'Local transcription failed.',
})

class RuntimeFailure extends Error {
  readonly code: WorkerErrorCode

  constructor(code: WorkerErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'RuntimeFailure'
    this.code = code
  }
}

function isOutOfMemory(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /out[ -]?of[ -]?memory|allocation failed|memory limit/i.test(error.message)
}

function normalizedProgress(event: unknown): number | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const progressEvent = event as { progress_total?: unknown; progress?: unknown }
  const value =
    typeof progressEvent.progress_total === 'number'
      ? progressEvent.progress_total
      : progressEvent.progress
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(100, Math.max(0, value)) / 100
}

function normalizedOutput(
  output: SpeechRecognitionOutput | string,
  requestedLanguage: string,
  englishOnly: boolean,
): SpeechRecognitionOutput {
  const text = typeof output === 'string' ? output : output.text
  if (typeof text !== 'string' || text.length > 200_000) {
    throw new Error('Invalid inference output')
  }

  // Transformers.js 4.2.0 defaults Whisper to English when language is
  // omitted, and Moonshine models only transcribe English.
  const language = englishOnly || requestedLanguage === 'auto' ? 'en' : requestedLanguage
  return { text, language }
}

function errorResponse(
  requestId: string,
  code: WorkerErrorCode,
  sessionId?: string,
): ErrorResponse {
  return {
    type: 'error',
    requestId,
    ...(sessionId === undefined ? {} : { sessionId }),
    code,
    message: ERROR_MESSAGES[code],
  }
}

export function createTranscriptionRuntime(
  options: TranscriptionRuntimeOptions,
): TranscriptionRuntime {
  interface ActivePipeline {
    readonly key: string
    readonly pipeline: Promise<SpeechRecognitionPipeline>
  }

  let activePipeline: ActivePipeline | undefined
  const warmedPipelines = new WeakSet<SpeechRecognitionPipeline>()
  const cancelledRequests = new Set<string>()
  const requestMetadata = new Map<
    string,
    { readonly type: 'load' } | { readonly type: 'transcribe'; readonly sessionId: string }
  >()
  let queue = Promise.resolve()

  const isCancelled = (requestId: string): boolean => cancelledRequests.has(requestId)

  const reportProgress = (
    request: LoadRequest | TranscribeRequest,
    stage: ProgressResponse['stage'],
    progress: number,
  ): void => {
    if (isCancelled(request.requestId)) return
    options.postMessage({
      type: 'progress',
      requestId: request.requestId,
      ...('sessionId' in request ? { sessionId: request.sessionId } : {}),
      stage,
      progress,
    })
  }

  const loadPipeline = async (
    request: LoadRequest | TranscribeRequest,
    device: InferenceDevice,
  ): Promise<SpeechRecognitionPipeline> => {
    const catalogEntry = MODEL_CATALOG[request.preset]
    const cacheKey = `${request.preset}:${device}`
    if (activePipeline?.key === cacheKey) return activePipeline.pipeline

    const previous = activePipeline
    activePipeline = undefined
    if (previous !== undefined) {
      try {
        const previousPipeline = await previous.pipeline
        await previousPipeline.dispose?.()
      } catch {
        // Disposal and failed prior initialization never expose raw library errors.
      }
    }

    const pendingPipeline = options.createPipeline(
      'automatic-speech-recognition',
      catalogEntry.repository,
      {
        dtype: catalogEntry.dtype,
        device,
        local_files_only: true,
        // ORT 1.26's QDQ transpose optimization rejects the pinned q8 Whisper graphs,
        // so rewrites are capped at 'basic' instead of the extended/layout levels.
        session_options: { graphOptimizationLevel: 'basic' },
        progress_callback: (event) => {
          const progress = normalizedProgress(event)
          if (progress !== undefined) reportProgress(request, 'loading-model', progress)
        },
      },
    )
    activePipeline = { key: cacheKey, pipeline: pendingPipeline }
    try {
      return await pendingPipeline
    } catch (error) {
      if (activePipeline?.pipeline === pendingPipeline) activePipeline = undefined
      throw error
    }
  }

  const invalidatePipeline = async (failedPipeline: SpeechRecognitionPipeline): Promise<void> => {
    const candidate = activePipeline
    if (candidate === undefined) return

    let candidatePipeline: SpeechRecognitionPipeline
    try {
      candidatePipeline = await candidate.pipeline
    } catch {
      return
    }
    if (activePipeline !== candidate || candidatePipeline !== failedPipeline) return

    activePipeline = undefined
    try {
      await failedPipeline.dispose?.()
    } catch {
      // Backend cleanup is best-effort and never exposes library errors.
    }
  }

  // One second of silence: enough to trigger backend graph initialization so
  // the first real dictation runs at steady-state speed.
  const WARM_UP_SAMPLES = 16_000

  const warmUpPipeline = async (
    pipeline: SpeechRecognitionPipeline,
    family: 'whisper' | 'moonshine',
  ): Promise<void> => {
    if (warmedPipelines.has(pipeline)) return
    warmedPipelines.add(pipeline)
    try {
      if (family === 'moonshine') await pipeline(new Float32Array(WARM_UP_SAMPLES))
      else await pipeline(new Float32Array(WARM_UP_SAMPLES), { task: 'transcribe' })
    } catch {
      // Warm-up is best effort; the load still succeeded.
    }
  }

  const loadForPreference = async (
    request: LoadRequest,
  ): Promise<{ pipeline: SpeechRecognitionPipeline; device: InferenceDevice }> => {
    if (request.inferencePreference === 'webgpu') {
      if (!(await options.probeWebGpu())) throw new RuntimeFailure('WEBGPU_FAILED')
      try {
        return { pipeline: await loadPipeline(request, 'webgpu'), device: 'webgpu' }
      } catch (error) {
        if (isOutOfMemory(error)) throw new RuntimeFailure('OUT_OF_MEMORY')
        throw new RuntimeFailure('WEBGPU_FAILED')
      }
    }

    // 'auto' resolves to WASM: the packaged runtime ships no ORT jsep build,
    // and measured q8 WebGPU inference is slower than WASM on integrated GPUs
    // (docs/perf/2026-07-20-dictation-latency.md).
    try {
      return { pipeline: await loadPipeline(request, 'wasm'), device: 'wasm' }
    } catch (error) {
      if (isOutOfMemory(error)) throw new RuntimeFailure('OUT_OF_MEMORY')
      throw new RuntimeFailure('MODEL_MISSING')
    }
  }

  const runOnDevice = async (
    request: TranscribeRequest,
    device: InferenceDevice,
  ): Promise<SpeechRecognitionOutput> => {
    let pipeline: SpeechRecognitionPipeline
    try {
      pipeline = await loadPipeline(request, device)
    } catch (error) {
      if (isOutOfMemory(error)) {
        throw new RuntimeFailure('OUT_OF_MEMORY')
      }
      if (device === 'wasm') {
        throw new RuntimeFailure('MODEL_MISSING')
      }
      throw error
    }
    if (isCancelled(request.requestId)) throw new RuntimeFailure('CANCELLED')

    reportProgress(request, 'transcribing', 0)
    const family = MODEL_CATALOG[request.preset].family
    // Moonshine generation takes no task/language options.
    const inferenceOptions =
      family === 'moonshine'
        ? undefined
        : request.language === 'auto'
          ? ({ task: 'transcribe' } as const)
          : ({ task: 'transcribe', language: request.language } as const)
    let output: SpeechRecognitionOutput
    try {
      const raw =
        inferenceOptions === undefined
          ? await pipeline(request.audio)
          : await pipeline(request.audio, inferenceOptions)
      output = normalizedOutput(raw, request.language, family === 'moonshine')
    } catch (error) {
      await invalidatePipeline(pipeline)
      throw error
    }
    if (isCancelled(request.requestId)) throw new RuntimeFailure('CANCELLED')
    reportProgress(request, 'transcribing', 1)
    return output
  }

  const transcribeForPreference = async (
    request: TranscribeRequest,
  ): Promise<SpeechRecognitionOutput> => {
    if (request.inferencePreference === 'webgpu') {
      if (!(await options.probeWebGpu())) {
        throw new RuntimeFailure('WEBGPU_FAILED')
      }
      try {
        return await runOnDevice(request, 'webgpu')
      } catch (error) {
        if (isCancelled(request.requestId)) throw new RuntimeFailure('CANCELLED')
        if (
          (error instanceof RuntimeFailure && error.code === 'OUT_OF_MEMORY') ||
          isOutOfMemory(error)
        ) {
          throw new RuntimeFailure('OUT_OF_MEMORY')
        }
        throw new RuntimeFailure('WEBGPU_FAILED')
      }
    }

    // 'auto' resolves to WASM — see loadForPreference.
    try {
      return await runOnDevice(request, 'wasm')
    } catch (error) {
      if (isCancelled(request.requestId)) throw new RuntimeFailure('CANCELLED')
      if (error instanceof RuntimeFailure) throw error
      if (isOutOfMemory(error)) throw new RuntimeFailure('OUT_OF_MEMORY')
      throw new RuntimeFailure('TRANSCRIPTION_FAILED')
    }
  }

  const processRequest = async (request: LoadRequest | TranscribeRequest): Promise<void> => {
    if (isCancelled(request.requestId)) {
      cancelledRequests.delete(request.requestId)
      requestMetadata.delete(request.requestId)
      return
    }
    try {
      if (request.type === 'load') {
        const loaded = await loadForPreference(request)
        await warmUpPipeline(loaded.pipeline, MODEL_CATALOG[request.preset].family)
        if (!isCancelled(request.requestId)) {
          options.postMessage({
            type: 'ready',
            requestId: request.requestId,
            preset: request.preset,
            device: loaded.device,
          })
        }
        return
      }

      const output = await transcribeForPreference(request)
      if (!isCancelled(request.requestId)) {
        options.postMessage({
          type: 'result',
          requestId: request.requestId,
          sessionId: request.sessionId,
          text: output.text,
          language: output.language ?? (request.language === 'auto' ? 'en' : request.language),
        })
      }
    } catch (error) {
      if (isCancelled(request.requestId)) return
      if (error instanceof RuntimeFailure) {
        options.postMessage(
          errorResponse(
            request.requestId,
            error.code,
            request.type === 'transcribe' ? request.sessionId : undefined,
          ),
        )
        return
      }
      options.postMessage(
        errorResponse(
          request.requestId,
          request.type === 'load' ? 'MODEL_MISSING' : 'TRANSCRIPTION_FAILED',
          request.type === 'transcribe' ? request.sessionId : undefined,
        ),
      )
    } finally {
      cancelledRequests.delete(request.requestId)
      requestMetadata.delete(request.requestId)
    }
  }

  return {
    handleMessage(message: unknown): Promise<void> {
      let request
      try {
        request = parseWorkerRequest(message)
      } catch {
        return Promise.resolve()
      }

      if (request.type === 'cancel') {
        const target = requestMetadata.get(request.targetRequestId)
        if (
          target?.type === 'transcribe' &&
          target.sessionId === request.sessionId
        ) {
          cancelledRequests.add(request.targetRequestId)
        }
        return Promise.resolve()
      }

      if (requestMetadata.has(request.requestId)) return Promise.resolve()
      requestMetadata.set(
        request.requestId,
        request.type === 'load'
          ? { type: 'load' }
          : { type: 'transcribe', sessionId: request.sessionId },
      )

      const work = queue.then(() => processRequest(request))
      queue = work.catch(() => undefined)
      return work
    },
  }
}
