import { setTimeout as delay } from 'node:timers/promises'

import type {
  TranscriptionFailureReason,
  TranscriptionRequest,
  TranscriptionResult,
} from '../../shared/contracts'
import { TRANSCRIPTION_SAMPLE_RATE } from '../../shared/audio'
import { cloudSpeechHints } from '../../shared/cloudSpeechModels'
import { parseDictionary } from '../../shared/dictionary'
import { pcm16WavDurationMs } from '../../shared/wav'
import type { AppSettings } from '../../shared/settings'

const TRANSCRIPTION_URL = 'https://openrouter.ai/api/v1/audio/transcriptions'

/**
 * A host behind OpenRouter can turn requests away in bursts that last about a second and say so with `Retry-After`
 * (ADR-0055). Each retry waits at least as long as it asks, and longer each time, so it does not land in the same burst.
 */
const RATE_LIMIT_BACKOFF_MS = [1_000, 2_000, 4_000] as const
/** A host asking for longer than this has a longer problem than a retry can wait out. */
const MAX_RETRY_AFTER_MS = 8_000
/** Spread so the parts of one dictation do not all come back in the same instant. */
const RETRY_JITTER_MS = 250
/** A server error or a dropped connection is retried once, quickly. */
const OTHER_RETRY_DELAY_MS = 300
/** A retry starts only when at least this much of the deadline is left after its wait. */
const MIN_ATTEMPT_BUDGET_MS = 1_500
/** After a rate limit the retry also uploads and transcribes a whole part, so it needs more. */
const RATE_LIMIT_ATTEMPT_BUDGET_MS = 3_000
/** Rate-limit answers are short JSON; anything longer is not read for its reason. */
const MAX_RATE_LIMIT_BODY = 16_384

/** Who turned a rate-limited request away: the host behind OpenRouter, or OpenRouter's own limit. Only this word is kept. */
export type RateLimitSource = 'provider' | 'openrouter'

/**
 * One failed request, as the transcription diagnostics record it: which model, why, how long the audio was and how long
 * it took. Never what was said, the audio, the dictionary or the key.
 */
export interface CloudTranscriptionFailureDiagnostic {
  readonly at: number
  readonly route: 'openrouter'
  readonly model: string
  readonly reason: Exclude<TranscriptionFailureReason, 'cancelled'>
  /** The HTTP status of the last attempt, when that attempt got an answer at all. */
  readonly status?: number
  readonly attempts: number
  readonly audioMs: number
  readonly elapsedMs: number
  readonly limitedBy?: RateLimitSource
  readonly retryAfterMs?: number
}

/** A request that was rate limited at least once and then transcribed, so the diagnostics show the retries working. */
export interface CloudTranscriptionRecoveryDiagnostic {
  readonly at: number
  readonly route: 'openrouter'
  readonly model: string
  readonly recovered: true
  readonly rateLimited: number
  readonly attempts: number
  readonly audioMs: number
  readonly elapsedMs: number
  readonly limitedBy?: RateLimitSource
}

/** Which model to send to and what Sotto knows about it, from the speech model list (ADR-0160). */
export interface CloudSpeechModelSource {
  /** The model to use when the user has not chosen one (`defaultCloudSpeechModel`), or null when the list cannot be read. */
  defaultModel(): Promise<string | null>
  /**
   * Whether the model has a host that keeps no audio, or null when the list cannot say. Unknown is sent to zero-retention
   * hosts only, so audio never reaches a host that keeps it because a list could not be read.
   */
  zeroRetention(id: string): Promise<boolean | null>
}

export interface CloudTranscriptionServiceDependencies {
  /** Settings with the OpenRouter key decrypted, as AI cleanup reads them. */
  readonly getSettings: () => Promise<AppSettings>
  readonly models: CloudSpeechModelSource
  readonly fetchFn?: typeof fetch
  readonly onFailure?: (diagnostic: CloudTranscriptionFailureDiagnostic) => void
  readonly onRecovered?: (diagnostic: CloudTranscriptionRecoveryDiagnostic) => void
  readonly now?: () => number
  /** Waits between attempts; rejects when the signal aborts. */
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  /** A number in [0, 1) for retry jitter. */
  readonly random?: () => number
}

interface RequestTrace {
  model: string
  attempts: number
  status?: number
  rateLimited: number
  limitedBy?: RateLimitSource
  retryAfterMs?: number
}

interface RateLimitAnswer {
  readonly source?: RateLimitSource
  readonly retryAfterMs?: number
}

function statusReason(status: number): Exclude<TranscriptionFailureReason, 'cancelled'> {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 402) return 'billing'
  if (status === 429) return 'rate-limited'
  if (status === 404) return 'model-unavailable'
  return 'failed'
}

function networkReason(error: unknown, signal: AbortSignal): 'timeout' | 'network' {
  const cause: unknown = signal.aborted ? signal.reason : error
  // DOMException and AbortSignal reasons may come from a different runtime realm.
  return typeof cause === 'object' && cause !== null && 'name' in cause && cause.name === 'TimeoutError'
    ? 'timeout'
    : 'network'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** `Retry-After` as seconds or an HTTP date, in milliseconds from now. */
function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const seconds = Number(value)
  const milliseconds = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - now
  return Number.isFinite(milliseconds) ? Math.max(0, Math.round(milliseconds)) : undefined
}

/** Reads who turned a request away and how long it asked for; keeps nothing else from the answer. */
async function readRateLimitAnswer(response: Response): Promise<RateLimitAnswer> {
  let retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), Date.now())
  let source: RateLimitSource | undefined = response.headers.has('x-ratelimit-limit') ? 'openrouter' : undefined
  try {
    const text = await response.text()
    const error: unknown = text.length <= MAX_RATE_LIMIT_BODY ? (JSON.parse(text) as { error?: unknown }).error : undefined
    if (isRecord(error)) {
      const metadata = isRecord(error.metadata) ? error.metadata : {}
      if (typeof metadata.provider_name === 'string' || (typeof error.message === 'string' && error.message.startsWith('Provider returned'))) {
        source = 'provider'
      }
      if (retryAfterMs === undefined && typeof metadata.retry_after_seconds === 'number' && Number.isFinite(metadata.retry_after_seconds)) {
        retryAfterMs = Math.max(0, Math.round(metadata.retry_after_seconds * 1_000))
      }
    }
  } catch {
    // An unreadable answer leaves the headers to say what they can.
  }
  return { ...(source === undefined ? {} : { source }), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
}

const defaultSleep = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  await delay(milliseconds, undefined, { signal })
}

/**
 * Transcribes dictation segments with the OpenRouter speech model the user picked (ADR-0160), with the key AI cleanup
 * uses. Each segment is its own request, sent as soon as it is cut, so a long dictation's parts travel together. A
 * model with a host that keeps no audio is only sent to that host. The dictionary goes as the spelling hints the model
 * takes: MAI-Transcribe-2's Azure phrase list, nothing to a model Sotto measured as taking none, and `keyterms` to one
 * it has not measured, which is asked again without them if it refuses and not offered them again until Sotto restarts. Main holds the key;
 * nothing the provider answers reaches a log or the renderer beyond the text.
 */
export class CloudTranscriptionService {
  private readonly fetchFn: typeof fetch
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private readonly random: () => number
  private readonly now: () => number
  private readonly inFlight = new Map<string, AbortController>()
  private readonly noKeyterms = new Set<string>()

  constructor(private readonly dependencies: CloudTranscriptionServiceDependencies) {
    this.fetchFn = dependencies.fetchFn ?? globalThis.fetch.bind(globalThis)
    this.sleep = dependencies.sleep ?? defaultSleep
    this.random = dependencies.random ?? Math.random
    this.now = dependencies.now ?? Date.now
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const startedAt = this.now()
    const trace: RequestTrace = { model: '', attempts: 0, rateLimited: 0 }
    const result = await this.request(request, trace)
    const audioMs = pcm16WavDurationMs(request.wav.byteLength, TRANSCRIPTION_SAMPLE_RATE)
    const limitedBy = trace.limitedBy === undefined ? {} : { limitedBy: trace.limitedBy }
    try {
      if (!result.ok && result.reason !== 'cancelled') {
        this.dependencies.onFailure?.({
          at: startedAt,
          route: 'openrouter',
          model: trace.model,
          reason: result.reason,
          ...(trace.status === undefined ? {} : { status: trace.status }),
          attempts: trace.attempts,
          audioMs,
          elapsedMs: Math.max(0, this.now() - startedAt),
          ...(result.reason === 'rate-limited' ? limitedBy : {}),
          ...(result.reason === 'rate-limited' && trace.retryAfterMs !== undefined ? { retryAfterMs: trace.retryAfterMs } : {}),
        })
      } else if (result.ok && trace.rateLimited > 0) {
        this.dependencies.onRecovered?.({
          at: startedAt,
          route: 'openrouter',
          model: trace.model,
          recovered: true,
          rateLimited: trace.rateLimited,
          attempts: trace.attempts,
          audioMs,
          elapsedMs: Math.max(0, this.now() - startedAt),
          ...limitedBy,
        })
      }
    } catch {
      // A diagnostic that cannot be written never changes what the user is told.
    }
    return result
  }

  private async request(request: TranscriptionRequest, trace: RequestTrace): Promise<TranscriptionResult> {
    // Register before reading settings so even overlapping credential reads obey newest-wins.
    this.cancel(request.requestId)
    const controller = new AbortController()
    this.inFlight.set(request.requestId, controller)
    const deadline = Date.now() + request.timeoutMs
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(request.timeoutMs)])
    try {
      let settings: AppSettings
      try {
        settings = await this.dependencies.getSettings()
      } catch {
        return { ok: false, reason: controller.signal.aborted ? 'cancelled' : 'no-key' }
      }
      if (controller.signal.aborted) return { ok: false, reason: 'cancelled' }
      if (!settings.llmApiKey.trim()) return { ok: false, reason: 'no-key' }
      const model = settings.cloudSpeechModel ?? await this.dependencies.models.defaultModel().catch(() => null)
      if (controller.signal.aborted) return { ok: false, reason: 'cancelled' }
      if (model === null) return { ok: false, reason: 'network' }
      trace.model = model
      const keyterms = parseDictionary(settings.llmDictionary, { maxEntries: 200, maxLength: 100 })
      const audio = { data: Buffer.from(request.wav).toString('base64'), format: 'wav' }
      const zeroRetention = await this.dependencies.models.zeroRetention(model).catch(() => null) !== false
      if (controller.signal.aborted) return { ok: false, reason: 'cancelled' }
      // MAI-Transcribe-2 takes the dictionary as Azure's phrase list; a model Sotto has not measured is offered
      // `keyterms`, and asked again without them if it refuses.
      const hints = keyterms.length === 0 ? null : cloudSpeechHints(model)
      const phraseList = hints === 'azure-phrase-list' ? { options: { azure: { phraseList: { phrases: keyterms } } } } : {}
      const provider = zeroRetention || hints === 'azure-phrase-list' ? { provider: { ...(zeroRetention ? { zdr: true } : {}), ...phraseList } } : {}
      const body = (withKeyterms: boolean): string => JSON.stringify({
        model,
        input_audio: audio,
        ...provider,
        ...(withKeyterms ? { keyterms } : {}),
      })
      let hinted = hints === 'keyterms' && !this.noKeyterms.has(model)

      // Running out of time while waiting out a rate limit is still the rate limit, not a lost connection.
      const timedOut = (): TranscriptionResult => ({ ok: false, reason: trace.rateLimited > 0 ? 'rate-limited' : 'timeout' })
      let otherRetries = 0
      for (;;) {
        if (controller.signal.aborted) return { ok: false, reason: 'cancelled' }
        if (signal.aborted) return timedOut()
        let reason: Exclude<TranscriptionFailureReason, 'cancelled'>
        let wait: number | null = null
        trace.attempts += 1
        delete trace.status
        try {
          const response = await this.fetchFn(TRANSCRIPTION_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${settings.llmApiKey}`, 'Content-Type': 'application/json' },
            body: body(hinted),
            signal,
          })
          if (controller.signal.aborted) return { ok: false, reason: 'cancelled' }
          if (signal.aborted) return timedOut()
          trace.status = response.status
          if (response.status === 400 && hinted) {
            // The model does not take spelling hints: ask again without them, at once, and stop offering them.
            await response.body?.cancel().catch(() => undefined)
            this.noKeyterms.add(model)
            hinted = false
            continue
          }
          if (response.status === 429) {
            reason = 'rate-limited'
            const answer = await readRateLimitAnswer(response)
            if (controller.signal.aborted) return { ok: false, reason: 'cancelled' }
            trace.rateLimited += 1
            if (answer.source !== undefined) trace.limitedBy = answer.source
            if (answer.retryAfterMs === undefined) delete trace.retryAfterMs
            else trace.retryAfterMs = answer.retryAfterMs
            const backoff = RATE_LIMIT_BACKOFF_MS[trace.rateLimited - 1]
            if (backoff !== undefined && (answer.retryAfterMs ?? 0) <= MAX_RETRY_AFTER_MS) {
              wait = Math.max(backoff, answer.retryAfterMs ?? 0) + Math.floor(this.random() * RETRY_JITTER_MS)
            }
          } else if (!response.ok) {
            await response.body?.cancel().catch(() => undefined)
            reason = statusReason(response.status)
            if (response.status >= 500 && otherRetries === 0) wait = OTHER_RETRY_DELAY_MS
          } else {
            let payload: unknown
            try {
              payload = await response.json()
            } catch (error: unknown) {
              if (controller.signal.aborted) return { ok: false, reason: 'cancelled' }
              return { ok: false, reason: networkReason(error, signal) === 'timeout' ? 'timeout' : 'malformed' }
            }
            if (controller.signal.aborted) return { ok: false, reason: 'cancelled' }
            if (signal.aborted) return { ok: false, reason: 'timeout' }
            const text = isRecord(payload) ? payload.text : undefined
            return typeof text === 'string' && text.length <= 200_000
              ? { ok: true, text: text.trim() }
              : { ok: false, reason: 'malformed' }
          }
        } catch (error: unknown) {
          if (controller.signal.aborted) return { ok: false, reason: 'cancelled' }
          reason = networkReason(error, signal)
          if (reason === 'timeout') return timedOut()
          if (otherRetries === 0) wait = OTHER_RETRY_DELAY_MS
        }
        // Retry only while the original deadline leaves a useful request budget after the wait.
        const budget = reason === 'rate-limited' ? RATE_LIMIT_ATTEMPT_BUDGET_MS : MIN_ATTEMPT_BUDGET_MS
        if (wait === null || deadline - Date.now() - wait < budget) {
          return { ok: false, reason }
        }
        if (reason !== 'rate-limited') otherRetries += 1
        try {
          await this.sleep(wait, signal)
        } catch (error: unknown) {
          if (controller.signal.aborted) return { ok: false, reason: 'cancelled' }
          return networkReason(error, signal) === 'timeout' ? timedOut() : { ok: false, reason: 'network' }
        }
      }
    } finally {
      if (this.inFlight.get(request.requestId) === controller) this.inFlight.delete(request.requestId)
    }
  }

  cancel(requestId: string): void {
    const controller = this.inFlight.get(requestId)
    if (controller === undefined) return
    this.inFlight.delete(requestId)
    controller.abort()
  }

  dispose(): void {
    for (const requestId of [...this.inFlight.keys()]) this.cancel(requestId)
  }
}
