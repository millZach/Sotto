import type { InferencePreference, ModelPreset } from '../../../shared/settings'
import {
  TRANSCRIPTION_SAMPLE_RATE,
  parseWorkerRequest,
  parseWorkerResponse,
  type ProgressResponse,
  type ReadyResponse,
  type ResultResponse,
  type WorkerErrorCode,
  type WorkerRequest,
} from './messages'

export type TranscriptionClientErrorCode =
  | WorkerErrorCode
  | 'WORKER_TERMINATED'
  | 'MALFORMED_RESPONSE'
  | 'SESSION_MISMATCH'

const CLIENT_ERROR_MESSAGES: Readonly<Record<TranscriptionClientErrorCode, string>> =
  Object.freeze({
    MODEL_MISSING: 'The selected local speech model is unavailable.',
    WEBGPU_FAILED: 'WebGPU transcription is unavailable.',
    OUT_OF_MEMORY: 'Not enough memory is available for transcription.',
    CANCELLED: 'Transcription was cancelled.',
    TRANSCRIPTION_FAILED: 'Local transcription failed.',
    WORKER_TERMINATED: 'The local transcription worker stopped.',
    MALFORMED_RESPONSE: 'The local transcription worker returned an invalid response.',
    SESSION_MISMATCH: 'The local transcription response did not match this session.',
  })

export class TranscriptionError extends Error {
  readonly code: TranscriptionClientErrorCode

  constructor(code: TranscriptionClientErrorCode) {
    super(CLIENT_ERROR_MESSAGES[code])
    this.name = 'TranscriptionError'
    this.code = code
  }
}

export interface WorkerLike {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void
  addEventListener(type: string, listener: (event: MessageEvent | Event) => void): void
  removeEventListener(type: string, listener: (event: MessageEvent | Event) => void): void
  terminate(): void
}

export interface TranscriptionProgress {
  readonly stage: ProgressResponse['stage']
  readonly progress: number
}

export interface LoadOptions {
  readonly preset: ModelPreset
  readonly inferencePreference: InferencePreference
  readonly onProgress?: (progress: TranscriptionProgress) => void
}

export interface TranscribeOptions extends LoadOptions {
  readonly sessionId: string
  readonly audio: Float32Array
  readonly language: string
}

export interface TranscriptionResult {
  readonly text: string
  readonly language: string
}

interface AutoRetry {
  readonly preset: ModelPreset
  readonly sessionId?: string
  readonly language?: string
  audio?: Float32Array
}

interface PendingRequest {
  readonly kind: 'ready' | 'result'
  readonly sessionId?: string
  readonly resolve: (response: ReadyResponse | ResultResponse) => void
  readonly reject: (error: TranscriptionError) => void
  readonly onProgress?: (progress: TranscriptionProgress) => void
  autoRetry?: AutoRetry
}

interface WorkerBinding {
  readonly worker: WorkerLike
  readonly generation: number
  readonly onMessage: (event: MessageEvent | Event) => void
  readonly onFailure: (event: MessageEvent | Event) => void
}

export interface TranscriptionClientOptions {
  readonly workerFactory?: () => WorkerLike
  readonly createRequestId?: () => string
}

declare const Worker: new (
  url: URL,
  options: { type: 'module' },
) => WorkerLike

function createProductionWorker(): WorkerLike {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
}

function createId(): string {
  return crypto.randomUUID()
}

function transferableAudio(audio: Float32Array): Float32Array {
  const usesWholeArrayBuffer =
    audio.buffer instanceof ArrayBuffer &&
    audio.byteOffset === 0 &&
    audio.byteLength === audio.buffer.byteLength

  return usesWholeArrayBuffer ? audio : new Float32Array(audio)
}

export class TranscriptionClient {
  private readonly workerFactory: () => WorkerLike
  private readonly createRequestId: () => string
  private readonly pending = new Map<string, PendingRequest>()
  private binding: WorkerBinding
  private nextGeneration = 1
  private disposed = false

  constructor(options: TranscriptionClientOptions = {}) {
    this.workerFactory = options.workerFactory ?? createProductionWorker
    this.createRequestId = options.createRequestId ?? createId
    this.binding = this.bindWorker(this.workerFactory())
  }

  load(options: LoadOptions): Promise<ReadyResponse> {
    if (this.disposed) return Promise.reject(new TranscriptionError('WORKER_TERMINATED'))

    const request = parseWorkerRequest({
      type: 'load',
      requestId: this.createRequestId(),
      preset: options.preset,
      inferencePreference: options.inferencePreference,
    })

    const result = this.createPending(request.requestId, {
      kind: 'ready',
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      ...(options.inferencePreference === 'auto'
        ? { autoRetry: { preset: options.preset } }
        : {}),
    })
    this.dispatch(request)
    return result as Promise<ReadyResponse>
  }

  transcribe(options: TranscribeOptions): Promise<TranscriptionResult> {
    if (this.disposed) return Promise.reject(new TranscriptionError('WORKER_TERMINATED'))

    const audio = transferableAudio(options.audio)
    const request = parseWorkerRequest({
      type: 'transcribe',
      requestId: this.createRequestId(),
      sessionId: options.sessionId,
      audio,
      sampleRate: TRANSCRIPTION_SAMPLE_RATE,
      preset: options.preset,
      language: options.language,
      inferencePreference: options.inferencePreference,
    })
    const autoRetry =
      options.inferencePreference === 'auto'
        ? {
            preset: options.preset,
            sessionId: options.sessionId,
            language: options.language,
            audio: new Float32Array(audio),
          }
        : undefined

    const response = this.createPending(request.requestId, {
      kind: 'result',
      sessionId: options.sessionId,
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      ...(autoRetry === undefined ? {} : { autoRetry }),
    })
    this.dispatch(request, [audio.buffer as ArrayBuffer])
    return response.then((workerResponse) => {
      if (workerResponse.type !== 'result') throw new TranscriptionError('MALFORMED_RESPONSE')
      return { text: workerResponse.text, language: workerResponse.language }
    })
  }

  cancel(sessionId: string): void {
    if (this.disposed) return

    for (const [targetRequestId, pending] of [...this.pending]) {
      if (pending.kind !== 'result' || pending.sessionId !== sessionId) continue

      this.pending.delete(targetRequestId)
      this.releaseRetryAudio(pending)
      pending.reject(new TranscriptionError('CANCELLED'))
      const request = parseWorkerRequest({
        type: 'cancel',
        requestId: this.createRequestId(),
        targetRequestId,
        sessionId,
      })
      this.dispatch(request)
    }
  }

  dispose(): void {
    this.terminate()
  }

  private createPending(
    requestId: string,
    metadata: Omit<PendingRequest, 'resolve' | 'reject'>,
  ): Promise<ReadyResponse | ResultResponse> {
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { ...metadata, resolve, reject })
    })
  }

  private bindWorker(worker: WorkerLike): WorkerBinding {
    const generation = this.nextGeneration++
    const onMessage = (event: MessageEvent | Event): void => {
      if (this.binding?.generation !== generation || this.binding.worker !== worker) return
      if (!(event instanceof MessageEvent)) {
        this.terminate()
        return
      }
      this.handleResponse(event.data)
    }
    const onFailure = (event: MessageEvent | Event): void => {
      if (this.binding?.generation !== generation || this.binding.worker !== worker) return
      event.preventDefault()
      this.terminate()
    }
    const binding = { worker, generation, onMessage, onFailure }
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onFailure)
    worker.addEventListener('messageerror', onFailure)
    return binding
  }

  private unbindWorker(binding: WorkerBinding): void {
    binding.worker.removeEventListener('message', binding.onMessage)
    binding.worker.removeEventListener('error', binding.onFailure)
    binding.worker.removeEventListener('messageerror', binding.onFailure)
  }

  private handleResponse(input: unknown): void {
    let response
    try {
      response = parseWorkerResponse(input)
    } catch {
      const requestId = this.extractRequestId(input)
      if (requestId !== undefined && this.pending.has(requestId)) {
        this.rejectPending(requestId, 'MALFORMED_RESPONSE')
      } else {
        this.rejectAll('MALFORMED_RESPONSE')
      }
      return
    }

    const pending = this.pending.get(response.requestId)
    if (pending === undefined) return

    const responseSessionId = 'sessionId' in response ? response.sessionId : undefined
    if (pending.sessionId !== responseSessionId) {
      this.rejectPending(response.requestId, 'SESSION_MISMATCH')
      return
    }

    if (response.type === 'progress') {
      try {
        pending.onProgress?.({ stage: response.stage, progress: response.progress })
      } catch {
        // Observer failures cannot disrupt worker request correlation.
      }
      return
    }

    if (response.type === 'error') {
      if (response.code === 'WEBGPU_FAILED' && pending.autoRetry !== undefined) {
        this.retryInFreshWorker(response.requestId, pending)
        return
      }
      this.pending.delete(response.requestId)
      this.releaseRetryAudio(pending)
      pending.reject(new TranscriptionError(response.code))
      return
    }

    if (response.type !== pending.kind) {
      this.rejectPending(response.requestId, 'MALFORMED_RESPONSE')
      return
    }

    this.pending.delete(response.requestId)
    this.releaseRetryAudio(pending)
    pending.resolve(response)
  }

  private retryInFreshWorker(requestId: string, pending: PendingRequest): void {
    const retry = pending.autoRetry
    if (retry === undefined) return

    this.pending.delete(requestId)
    delete pending.autoRetry

    const previousBinding = this.binding
    this.unbindWorker(previousBinding)
    previousBinding.worker.terminate()
    for (const [otherId] of [...this.pending]) this.rejectPending(otherId, 'WORKER_TERMINATED')

    try {
      this.binding = this.bindWorker(this.workerFactory())
    } catch {
      this.disposed = true
      this.releaseRetryAudio(pending, retry)
      pending.reject(new TranscriptionError('WORKER_TERMINATED'))
      return
    }

    const retryRequestId = this.createRequestId()
    let request: WorkerRequest
    let transfer: ArrayBuffer[] | undefined
    if (pending.kind === 'ready') {
      request = parseWorkerRequest({
        type: 'load',
        requestId: retryRequestId,
        preset: retry.preset,
        inferencePreference: 'wasm',
      })
    } else {
      const audio = retry.audio
      if (audio === undefined || retry.sessionId === undefined || retry.language === undefined) {
        this.releaseRetryAudio(pending, retry)
        pending.reject(new TranscriptionError('WORKER_TERMINATED'))
        return
      }
      request = parseWorkerRequest({
        type: 'transcribe',
        requestId: retryRequestId,
        sessionId: retry.sessionId,
        audio,
        sampleRate: TRANSCRIPTION_SAMPLE_RATE,
        preset: retry.preset,
        language: retry.language,
        inferencePreference: 'wasm',
      })
      transfer = [audio.buffer as ArrayBuffer]
      delete retry.audio
    }

    this.pending.set(retryRequestId, pending)
    this.dispatch(request, transfer)
  }

  private extractRequestId(input: unknown): string | undefined {
    if (typeof input !== 'object' || input === null || !('requestId' in input)) return undefined
    const requestId = (input as { requestId?: unknown }).requestId
    return typeof requestId === 'string' && requestId.length <= 128 ? requestId : undefined
  }

  private dispatch(request: WorkerRequest, transfer?: ArrayBuffer[]): void {
    try {
      if (transfer === undefined) this.binding.worker.postMessage(request)
      else this.binding.worker.postMessage(request, transfer)
    } catch {
      this.terminate()
    }
  }

  private rejectPending(requestId: string, code: TranscriptionClientErrorCode): void {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return
    this.pending.delete(requestId)
    this.releaseRetryAudio(pending)
    pending.reject(new TranscriptionError(code))
  }

  private rejectAll(code: TranscriptionClientErrorCode): void {
    const requests = [...this.pending.values()]
    this.pending.clear()
    for (const pending of requests) {
      this.releaseRetryAudio(pending)
      pending.reject(new TranscriptionError(code))
    }
  }

  private releaseRetryAudio(pending: PendingRequest, retry = pending.autoRetry): void {
    if (retry !== undefined) delete retry.audio
    delete pending.autoRetry
  }

  private terminate(): void {
    if (this.disposed) return
    this.disposed = true
    this.unbindWorker(this.binding)
    this.binding.worker.terminate()
    this.rejectAll('WORKER_TERMINATED')
  }
}
