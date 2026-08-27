import type { LoadOptions, TranscribeOptions, TranscriptionResult } from './client'
import { RemoteTranscriptionError } from './remoteClient'

/** The transcriber surface the dictation controller consumes. */
export interface ComposableTranscriber {
  transcribe(options: TranscribeOptions): Promise<TranscriptionResult>
  load?(options: LoadOptions): Promise<unknown>
  cancel(sessionId: string): void
  dispose(): void
}

export interface RemoteCapableTranscriber extends ComposableTranscriber {
  /** True when the server answered its health probe. */
  check(): Promise<boolean>
}

/**
 * How long one remote failure suppresses further attempts. Without it, a server
 * that is simply off would make every segment of a long dictation wait out the
 * remote deadline before the local model even starts. It is short enough that a
 * server coming back is picked up within the same sitting.
 */
export const REMOTE_ASR_COOLDOWN_MS = 30_000

export interface FallbackTranscriberOptions {
  readonly local: ComposableTranscriber
  readonly remote: RemoteCapableTranscriber
  readonly isRemoteEnabled: () => boolean
  readonly cooldownMs?: number
  readonly now?: () => number
}

/**
 * Runs each segment through the remote server and quietly falls back to the
 * local model on any failure. The local model is always the one that gets
 * warmed, because it is the path that must work when nothing else does; a
 * server outage costs one deadline per cooldown window and nothing else.
 */
export class FallbackTranscriber {
  private readonly cooldownMs: number
  private readonly now: () => number
  private retryRemoteAt = 0
  /**
   * The controller runs one session at a time, so remembering the most recent
   * cancelled id is enough to keep a cancelled remote request from starting a
   * local transcription nobody is waiting for.
   */
  private cancelledSessionId: string | null = null

  constructor(private readonly options: FallbackTranscriberOptions) {
    this.cooldownMs = options.cooldownMs ?? REMOTE_ASR_COOLDOWN_MS
    this.now = options.now ?? Date.now
  }

  /**
   * Warms the local model and, when remote is on, probes the server in
   * parallel so the first real segment does not pay the failure deadline.
   */
  async load(options: LoadOptions): Promise<unknown> {
    const local = Promise.resolve(this.options.local.load?.(options))
    // Observed now so a local load that fails while the probe is outstanding
    // does not surface as an unhandled rejection; callers still see it.
    void local.catch(() => undefined)
    if (this.options.isRemoteEnabled()) {
      const healthy = await this.options.remote.check().catch(() => false)
      if (healthy) this.retryRemoteAt = 0
      else this.openCooldown()
    }
    return local
  }

  async transcribe(options: TranscribeOptions): Promise<TranscriptionResult> {
    if (!this.shouldTryRemote()) return this.options.local.transcribe(options)

    try {
      const result = await this.options.remote.transcribe(options)
      this.retryRemoteAt = 0
      return result
    } catch (error: unknown) {
      if (this.isCancellation(error, options.sessionId)) throw error
      this.openCooldown()
      return this.options.local.transcribe(options)
    }
  }

  cancel(sessionId: string): void {
    this.cancelledSessionId = sessionId
    try {
      this.options.remote.cancel(sessionId)
    } catch {
      // Both transcribers own their own cleanup; neither can block the other.
    }
    this.options.local.cancel(sessionId)
  }

  dispose(): void {
    try {
      this.options.remote.dispose()
    } catch {
      // Disposal of the fallback path must still run.
    }
    this.options.local.dispose()
  }

  private shouldTryRemote(): boolean {
    return this.options.isRemoteEnabled() && this.now() >= this.retryRemoteAt
  }

  private openCooldown(): void {
    this.retryRemoteAt = this.now() + this.cooldownMs
  }

  /** A cancelled segment must not silently restart on the local model. */
  private isCancellation(error: unknown, sessionId: string): boolean {
    return (
      this.cancelledSessionId === sessionId ||
      (error instanceof RemoteTranscriptionError && error.code === 'CANCELLED')
    )
  }
}
