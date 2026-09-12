import type {
  TranscriptionFailureReason,
  TranscriptionRequest,
  TranscriptionResult as BridgeTranscriptionResult,
} from '../../../shared/contracts'
import { encodeWavPcm16 } from '../../../shared/wav'
import { TRANSCRIPTION_SAMPLE_RATE } from '../../../shared/audio'
import { transcriptionTimeoutMs } from '../../../shared/contracts'
import type { DictationTranscriber } from '../features/dictation/dictationController'

/**
 * Stands in for a window that was built without a transcription bridge. It
 * fails the way a missing key does, because from where the user sits that is
 * the same thing: nothing is set up to reach OpenRouter.
 */
export function createUnconfiguredTranscriber() {
  return {
    async load() {},
    async transcribe(): Promise<never> { throw new TranscriptionError('unconfigured') },
    cancel() {},
    dispose() {},
  } satisfies DictationTranscriber
}
export interface TranscriptionProgress {
  readonly stage: 'loading-model' | 'transcribing'
  readonly progress: number
}
export interface LoadOptions {
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
export class TranscriptionError extends Error {
  constructor(readonly reason: TranscriptionFailureReason) {
    super('Transcription failed.')
    this.name = 'TranscriptionError'
  }
}

// This watchdog also bounds an IPC round trip that never settles.
const WATCHDOG_GRACE_MS = 1_000

/**
 * OpenRouter reports no progress, so the widget gets the one honest edge there
 * is: the audio left this machine and the answer is outstanding. A middling
 * value reads as motion without claiming a percentage nobody measured.
 */
const TRANSCRIPTION_PROGRESS = 0.5

export interface TranscriptionBridge {
  transcribe(request: TranscriptionRequest): Promise<BridgeTranscriptionResult>
  cancelTranscription(requestId: string): Promise<unknown>
}

export interface OpenRouterTranscriberOptions {
  readonly bridge: TranscriptionBridge
  readonly createRequestId?: () => string
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

interface PendingRequest {
  readonly sessionId: string
  readonly reject: (error: TranscriptionError) => void
  timer?: unknown
}

function createId(): string {
  return crypto.randomUUID()
}

const defaultSetTimer = (callback: () => void, delayMs: number): unknown =>
  globalThis.setTimeout(callback, delayMs)
const defaultClearTimer = (handle: unknown): void =>
  globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)

export class OpenRouterTranscriber implements DictationTranscriber {
  private readonly bridge: TranscriptionBridge
  private readonly createRequestId: () => string
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly pending = new Map<string, PendingRequest>()
  private disposed = false

  constructor(options: OpenRouterTranscriberOptions) {
    this.bridge = options.bridge
    this.createRequestId = options.createRequestId ?? createId
    this.setTimer = options.setTimer ?? defaultSetTimer
    this.clearTimer = options.clearTimer ?? defaultClearTimer
  }

  load(): Promise<void> { return Promise.resolve() }

  transcribe(options: TranscribeOptions): Promise<TranscriptionResult> {
    // A disposed transcriber is a teardown, not a missing key: say so honestly.
    if (this.disposed) return Promise.reject(new TranscriptionError('cancelled'))

    let wav: Uint8Array
    try {
      wav = encodeWavPcm16(options.audio, TRANSCRIPTION_SAMPLE_RATE)
    } catch {
      return Promise.reject(new TranscriptionError('malformed'))
    }
    const requestId = this.createRequestId()
    const timeoutMs = Math.ceil(transcriptionTimeoutMs(options.audio.length / TRANSCRIPTION_SAMPLE_RATE))

    return new Promise<TranscriptionResult>((resolve, reject) => {
      const pending: PendingRequest = { sessionId: options.sessionId, reject }
      pending.timer = this.setTimer(() => {
        if (!this.settle(requestId)) return
        this.requestServerCancel(requestId)
        reject(new TranscriptionError('timeout'))
      }, timeoutMs + WATCHDOG_GRACE_MS)
      this.pending.set(requestId, pending)

      void Promise.resolve()
        .then(() => {
          if (!this.pending.has(requestId)) return { ok: false as const, reason: 'cancelled' as const }
          return this.bridge.transcribe({ requestId, wav: wav.buffer as ArrayBuffer, timeoutMs })
        })
        .then(
          (result) => {
            // A cancelled or timed-out request already rejected, and settling
            // returns false there; the late answer is simply dropped.
            if (!this.settle(requestId)) return
            if (result.ok) {
              resolve({ text: result.text, language: options.language })
            } else {
              reject(new TranscriptionError(result.reason))
            }
          },
          (error: unknown) => {
            if (!this.settle(requestId)) return
            reject(
              error instanceof TranscriptionError
                ? error
                : new TranscriptionError('malformed'),
            )
          },
        )

      this.reportProgress(options)
    })
  }

  cancel(sessionId: string): void {
    for (const [requestId, pending] of [...this.pending]) {
      if (pending.sessionId !== sessionId) continue
      this.settle(requestId)
      this.requestServerCancel(requestId)
      pending.reject(new TranscriptionError('cancelled'))
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [requestId, pending] of [...this.pending]) {
      this.settle(requestId)
      this.requestServerCancel(requestId)
      pending.reject(new TranscriptionError('cancelled'))
    }
  }

  private reportProgress(options: TranscribeOptions): void {
    try {
      options.onProgress?.({ stage: 'transcribing', progress: TRANSCRIPTION_PROGRESS })
    } catch {
      // Observer failures cannot disrupt an outstanding upload.
    }
  }

  /** Claims a pending request; false when it already settled. */
  private settle(requestId: string): boolean {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return false
    this.pending.delete(requestId)
    if (pending.timer !== undefined) {
      try {
        this.clearTimer(pending.timer)
      } catch {
        // The settled request is already unreachable from the timer callback.
      }
    }
    return true
  }

  private requestServerCancel(requestId: string): void {
    try {
      void Promise.resolve(this.bridge.cancelTranscription(requestId)).catch(
        () => undefined,
      )
    } catch {
      // Aborting the upload is best effort; the deadline releases it regardless.
    }
  }
}
