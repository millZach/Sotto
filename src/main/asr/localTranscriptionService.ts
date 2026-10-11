import type {
  TranscriptionFailureReason,
  TranscriptionRequest,
  TranscriptionResult,
} from '../../shared/contracts'
import { TRANSCRIPTION_SAMPLE_RATE } from '../../shared/audio'
import { decodeWavPcm16, pcm16WavDurationMs } from '../../shared/wav'
import type { SpeechEngine } from './speechEngine'

/**
 * One segment that was not transcribed, as `transcription-diagnostics.jsonl` records it: why, how
 * long the audio was and how long it took. Never what was said, the audio or anything about it.
 */
export interface TranscriptionFailureDiagnostic {
  readonly at: number
  readonly reason: Exclude<TranscriptionFailureReason, 'cancelled'>
  readonly audioMs: number
  readonly elapsedMs: number
}

export interface LocalTranscriptionServiceDependencies {
  /** The running engine, or null while the speech model is not ready. */
  readonly engine: () => SpeechEngine | null
  /** Told about every segment that failed, except one the user cancelled. */
  readonly onFailure?: (diagnostic: TranscriptionFailureDiagnostic) => void
  readonly now?: () => number
}

/**
 * Transcribes dictation segments on this computer (ADR-0071). Segments are decoded one at a time,
 * in the order they arrive, so a long dictation's parts never compete for the same cores. The
 * native decode cannot be interrupted; a cancelled segment's text is dropped when it comes back.
 */
export class LocalTranscriptionService {
  private readonly now: () => number
  private readonly inFlight = new Set<string>()
  private readonly cancelled = new Set<string>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly dependencies: LocalTranscriptionServiceDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const startedAt = this.now()
    const audioMs = pcm16WavDurationMs(request.wav.byteLength, TRANSCRIPTION_SAMPLE_RATE)
    const fail = (reason: Exclude<TranscriptionFailureReason, 'cancelled'>): TranscriptionResult => {
      try {
        this.dependencies.onFailure?.({ at: startedAt, reason, audioMs, elapsedMs: this.now() - startedAt })
      } catch {
        // Diagnostics never change the result.
      }
      return { ok: false, reason }
    }

    const samples = decodeWavPcm16(request.wav, TRANSCRIPTION_SAMPLE_RATE)
    if (samples === null) return fail('malformed')
    if (this.dependencies.engine() === null) return fail('model-not-ready')

    this.inFlight.add(request.requestId)
    const turn = this.queue.then(async (): Promise<TranscriptionResult> => {
      if (this.cancelled.has(request.requestId)) return { ok: false, reason: 'cancelled' }
      const engine = this.dependencies.engine()
      if (engine === null) return fail('model-not-ready')
      try {
        const text = await engine.transcribe(samples)
        if (this.cancelled.has(request.requestId)) return { ok: false, reason: 'cancelled' }
        return { ok: true, text }
      } catch {
        if (this.cancelled.has(request.requestId)) return { ok: false, reason: 'cancelled' }
        return fail('failed')
      }
    })
    this.queue = turn.catch(() => undefined)
    try {
      return await turn
    } finally {
      this.inFlight.delete(request.requestId)
      this.cancelled.delete(request.requestId)
    }
  }

  cancel(requestId: string): void {
    if (this.inFlight.has(requestId)) this.cancelled.add(requestId)
  }

  dispose(): void {
    for (const requestId of this.inFlight) this.cancelled.add(requestId)
  }
}
