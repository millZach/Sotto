import type {
  RemoteAsrFailureReason,
  RemoteAsrHealth,
  RemoteTranscriptionRequest,
  RemoteTranscriptionResult,
} from '../../../shared/contracts'
import { encodeWavPcm16 } from '../../../shared/wav'
import { TRANSCRIPTION_SAMPLE_RATE } from './messages'
import type { TranscribeOptions, TranscriptionResult } from './client'

export type RemoteTranscriptionErrorCode =
  | 'REMOTE_UNAVAILABLE'
  | 'REMOTE_TIMEOUT'
  | 'REMOTE_FAILED'
  | 'CANCELLED'

const REMOTE_ERROR_MESSAGES: Readonly<Record<RemoteTranscriptionErrorCode, string>> =
  Object.freeze({
    REMOTE_UNAVAILABLE: 'Remote transcription is not configured.',
    REMOTE_TIMEOUT: 'The remote transcription server did not answer in time.',
    REMOTE_FAILED: 'Remote transcription failed.',
    CANCELLED: 'Transcription was cancelled.',
  })

export class RemoteTranscriptionError extends Error {
  readonly code: RemoteTranscriptionErrorCode

  constructor(code: RemoteTranscriptionErrorCode) {
    super(REMOTE_ERROR_MESSAGES[code])
    this.name = 'RemoteTranscriptionError'
    this.code = code
  }
}

/**
 * A measured round trip on the target hardware is ~50 ms for a 2 s clip and
 * ~230 ms for a 16 s one, so anything past this deadline is an outage rather
 * than a slow answer, and waiting longer only delays a local fallback that
 * would have finished by then anyway.
 */
export const REMOTE_TRANSCRIPTION_TIMEOUT_MS = 4_000

/**
 * The main process enforces the deadline on the socket; this renderer-side
 * watchdog only covers an IPC round trip that never settles at all, so it waits
 * a beat longer and lets the real timeout win when there is one.
 */
const WATCHDOG_GRACE_MS = 1_000

/**
 * The server reports no progress, so the widget gets the one honest edge there
 * is: the audio left this machine and the answer is outstanding. A middling
 * value reads as motion without claiming a percentage nobody measured.
 */
const REMOTE_PROGRESS = 0.5

export interface RemoteTranscriptionBridge {
  transcribeRemote(request: RemoteTranscriptionRequest): Promise<RemoteTranscriptionResult>
  cancelRemoteTranscription(requestId: string): Promise<unknown>
  checkRemoteAsr(): Promise<RemoteAsrHealth>
}

export interface RemoteTranscriptionClientOptions {
  readonly bridge: RemoteTranscriptionBridge
  readonly timeoutMs?: number
  readonly createRequestId?: () => string
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

interface PendingRequest {
  readonly sessionId: string
  readonly reject: (error: RemoteTranscriptionError) => void
  timer?: unknown
}

function createId(): string {
  return crypto.randomUUID()
}

const defaultSetTimer = (callback: () => void, delayMs: number): unknown =>
  globalThis.setTimeout(callback, delayMs)
const defaultClearTimer = (handle: unknown): void =>
  globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)

function failureCode(reason: RemoteAsrFailureReason): RemoteTranscriptionErrorCode {
  switch (reason) {
    case 'cancelled':
      return 'CANCELLED'
    case 'timeout':
      return 'REMOTE_TIMEOUT'
    case 'disabled':
    case 'unconfigured':
      return 'REMOTE_UNAVAILABLE'
    default:
      return 'REMOTE_FAILED'
  }
}

/**
 * Local transcription resolves 'auto' to English before returning and history
 * stores whatever comes back, so the remote path reports the same value rather
 * than leaking the literal 'auto' into saved entries.
 */
function reportedLanguage(requested: string): string {
  return requested === 'auto' ? 'en' : requested
}

/**
 * Sends one recorded segment to the configured OpenAI-compatible server and
 * shapes the answer like the local worker's. Any remote outcome that is not
 * usable text becomes a rejection, which is exactly what the fallback wrapper
 * around it needs in order to hand the same segment to the local model.
 */
export class RemoteTranscriptionClient {
  private readonly bridge: RemoteTranscriptionBridge
  private readonly timeoutMs: number
  private readonly createRequestId: () => string
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly pending = new Map<string, PendingRequest>()
  private disposed = false

  constructor(options: RemoteTranscriptionClientOptions) {
    this.bridge = options.bridge
    this.timeoutMs = options.timeoutMs ?? REMOTE_TRANSCRIPTION_TIMEOUT_MS
    this.createRequestId = options.createRequestId ?? createId
    this.setTimer = options.setTimer ?? defaultSetTimer
    this.clearTimer = options.clearTimer ?? defaultClearTimer
  }

  transcribe(options: TranscribeOptions): Promise<TranscriptionResult> {
    if (this.disposed) return Promise.reject(new RemoteTranscriptionError('REMOTE_UNAVAILABLE'))

    let wav: Uint8Array
    try {
      wav = encodeWavPcm16(options.audio, TRANSCRIPTION_SAMPLE_RATE)
    } catch {
      return Promise.reject(new RemoteTranscriptionError('REMOTE_FAILED'))
    }
    const requestId = this.createRequestId()

    return new Promise<TranscriptionResult>((resolve, reject) => {
      const pending: PendingRequest = { sessionId: options.sessionId, reject }
      pending.timer = this.setTimer(() => {
        if (!this.settle(requestId)) return
        this.requestServerCancel(requestId)
        reject(new RemoteTranscriptionError('REMOTE_TIMEOUT'))
      }, this.timeoutMs + WATCHDOG_GRACE_MS)
      this.pending.set(requestId, pending)

      void this.bridge
        .transcribeRemote({ requestId, wav: wav.buffer as ArrayBuffer, timeoutMs: this.timeoutMs })
        .then(
          (result) => {
            // A cancelled or timed-out request already rejected, and settling
            // returns false there; the late answer is simply dropped.
            if (!this.settle(requestId)) return
            if (result.ok) {
              resolve({ text: result.text, language: reportedLanguage(options.language) })
            } else {
              reject(new RemoteTranscriptionError(failureCode(result.reason)))
            }
          },
          (error: unknown) => {
            if (!this.settle(requestId)) return
            reject(
              error instanceof RemoteTranscriptionError
                ? error
                : new RemoteTranscriptionError('REMOTE_FAILED'),
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
      pending.reject(new RemoteTranscriptionError('CANCELLED'))
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [requestId, pending] of [...this.pending]) {
      this.settle(requestId)
      this.requestServerCancel(requestId)
      pending.reject(new RemoteTranscriptionError('CANCELLED'))
    }
  }

  /** Reachability probe; a rejected bridge call reads as unreachable. */
  async check(): Promise<boolean> {
    try {
      return (await this.bridge.checkRemoteAsr()).ok
    } catch {
      return false
    }
  }

  private reportProgress(options: TranscribeOptions): void {
    try {
      options.onProgress?.({ stage: 'transcribing', progress: REMOTE_PROGRESS })
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
      void Promise.resolve(this.bridge.cancelRemoteTranscription(requestId)).catch(
        () => undefined,
      )
    } catch {
      // Aborting the upload is best effort; the deadline releases it regardless.
    }
  }
}
