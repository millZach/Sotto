import { setTimeout as delay } from 'node:timers/promises'

import {
  TRANSCRIPTION_MODEL,
  type TranscriptionFailureReason,
  type TranscriptionKeyCheck,
  type TranscriptionRequest,
  type TranscriptionResult,
} from '../../shared/contracts'
import { TRANSCRIPTION_SAMPLE_RATE } from '../../shared/audio'
import { parseDictionary } from '../../shared/dictionary'
import { pcm16WavDurationMs } from '../../shared/wav'
import type { AppSettings } from '../../shared/settings'

const TRANSCRIPTION_URL = 'https://openrouter.ai/api/v1/audio/transcriptions'
const KEY_URL = 'https://openrouter.ai/api/v1/key'

/**
 * Azure, the only provider behind the transcription model, turns requests away
 * in bursts that last about a second and says so with `Retry-After`. Each retry
 * waits at least as long as it asks, and longer each time, so a retry does not
 * land inside the same burst the way an immediate one would.
 */
const RATE_LIMIT_BACKOFF_MS = [1_000, 2_000, 4_000] as const
/** A provider asking for longer than this has a longer problem than a retry can wait out. */
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

/**
 * Who turned a rate-limited request away: the provider behind OpenRouter
 * (OpenRouter's `Provider returned 429`), or OpenRouter's own limit (its
 * `X-RateLimit-*` headers). Only this word is kept, never the answer itself.
 */
export type RateLimitSource = 'provider' | 'openrouter'

/**
 * One failed transcription request, as the transcription diagnostics record it:
 * why it failed and how long it was, never what was said, the audio or the key.
 */
export interface TranscriptionFailureDiagnostic {
  /** When the request started, in epoch milliseconds. */
  readonly at: number
  readonly reason: Exclude<TranscriptionFailureReason, 'cancelled'>
  /** The HTTP status of the last attempt, when that attempt got an answer at all. */
  readonly status?: number
  readonly attempts: number
  readonly audioMs: number
  readonly elapsedMs: number
  /** For a rate-limited failure, who turned the last attempt away, when the answer said. */
  readonly limitedBy?: RateLimitSource
  /** For a rate-limited failure, how long the last answer asked Sotto to wait. */
  readonly retryAfterMs?: number
}

/**
 * A request that was rate limited at least once and then transcribed, so the
 * diagnostics show the retries working as well as the failures they did not save.
 */
export interface TranscriptionRecoveryDiagnostic {
  readonly at: number
  readonly recovered: true
  /** How many attempts were turned away before one was accepted. */
  readonly rateLimited: number
  readonly attempts: number
  readonly audioMs: number
  readonly elapsedMs: number
  readonly limitedBy?: RateLimitSource
}

export interface OpenRouterTranscriptionServiceDependencies {
  readonly getSettings: () => Promise<AppSettings>
  readonly fetchFn?: typeof fetch
  /** Told about every failed request except one the user cancelled. */
  readonly onFailure?: (diagnostic: TranscriptionFailureDiagnostic) => void
  /** Told about every request that succeeded after being rate limited. */
  readonly onRecovered?: (diagnostic: TranscriptionRecoveryDiagnostic) => void
  readonly now?: () => number
  /** Waits between attempts; rejects when the signal aborts. */
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  /** A number in [0, 1) for retry jitter. */
  readonly random?: () => number
}

interface RequestTrace {
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

function statusReason(status: number): TranscriptionFailureReason {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 402) return 'billing'
  if (status === 429) return 'rate-limited'
  return 'http'
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

/** Main owns uploads and decrypted credentials; errors never include provider response bodies. */
export class OpenRouterTranscriptionService {
  private readonly fetchFn: typeof fetch
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private readonly random: () => number
  private readonly inFlight = new Map<string, AbortController>()

  constructor(private readonly dependencies: OpenRouterTranscriptionServiceDependencies) {
    this.fetchFn = dependencies.fetchFn ?? globalThis.fetch.bind(globalThis)
    this.sleep = dependencies.sleep ?? defaultSleep
    this.random = dependencies.random ?? Math.random
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const now = this.dependencies.now ?? Date.now
    const startedAt = now()
    const trace: RequestTrace = { attempts: 0, rateLimited: 0 }
    const result = await this.request(request, trace)
    const audioMs = pcm16WavDurationMs(request.wav.byteLength, TRANSCRIPTION_SAMPLE_RATE)
    const limitedBy = trace.limitedBy === undefined ? {} : { limitedBy: trace.limitedBy }
    try {
      if (!result.ok && result.reason !== 'cancelled') {
        this.dependencies.onFailure?.({
          at: startedAt,
          reason: result.reason,
          ...(trace.status === undefined ? {} : { status: trace.status }),
          attempts: trace.attempts,
          audioMs,
          elapsedMs: Math.max(0, now() - startedAt),
          ...(result.reason === 'rate-limited' ? limitedBy : {}),
          ...(result.reason === 'rate-limited' && trace.retryAfterMs !== undefined ? { retryAfterMs: trace.retryAfterMs } : {}),
        })
      } else if (result.ok && trace.rateLimited > 0) {
        this.dependencies.onRecovered?.({
          at: startedAt,
          recovered: true,
          rateLimited: trace.rateLimited,
          attempts: trace.attempts,
          audioMs,
          elapsedMs: Math.max(0, now() - startedAt),
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
        return { ok: false, reason: controller.signal.aborted ? 'cancelled' : 'unconfigured' }
      }
      if (controller.signal.aborted) return { ok: false, reason: 'cancelled' }
      if (!settings.llmApiKey.trim()) return { ok: false, reason: 'unconfigured' }
      const phrases = parseDictionary(settings.llmDictionary, { maxEntries: 200, maxLength: 100 })
      const body = JSON.stringify({
        model: TRANSCRIPTION_MODEL,
        input_audio: { data: Buffer.from(request.wav).toString('base64'), format: 'wav' },
        ...(settings.language === 'auto' ? {} : { language: settings.language }),
        ...(phrases.length === 0 ? {} : { provider: { options: { azure: { phraseList: { phrases } } } } }),
      })

      // Running out of time while waiting out a rate limit is still the rate limit,
      // not a lost connection, so it is reported as one.
      const timedOut = (): TranscriptionResult => ({ ok: false, reason: trace.rateLimited > 0 ? 'rate-limited' : 'timeout' })
      let otherRetries = 0
      for (;;) {
        if (controller.signal.aborted) return { ok: false, reason: 'cancelled' }
        if (signal.aborted) return timedOut()
        let reason: TranscriptionFailureReason
        let wait: number | null = null
        trace.attempts += 1
        delete trace.status
        try {
          const response = await this.fetchFn(TRANSCRIPTION_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${settings.llmApiKey}`, 'Content-Type': 'application/json' },
            body,
            signal,
          })
          if (controller.signal.aborted) return { ok: false, reason: 'cancelled' }
          if (signal.aborted) return timedOut()
          trace.status = response.status
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
            const text = typeof payload === 'object' && payload !== null ? (payload as { text?: unknown }).text : undefined
            return typeof text === 'string' && text.length <= 200_000
              ? { ok: true, text: text.trim() }
              : { ok: false, reason: 'malformed' }
          }
        } catch (error: unknown) {
          if (controller.signal.aborted) return { ok: false, reason: 'cancelled' }
          reason = networkReason(error, signal)
          if (reason === 'timeout') return timedOut()
          if (reason === 'network' && otherRetries === 0) wait = OTHER_RETRY_DELAY_MS
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

  async checkKey(): Promise<TranscriptionKeyCheck> {
    let settings: AppSettings
    try { settings = await this.dependencies.getSettings() }
    catch { return { ok: false, reason: 'unconfigured' } }
    if (!settings.llmApiKey.trim()) return { ok: false, reason: 'unconfigured' }
    const signal = AbortSignal.timeout(5_000)
    try {
      const response = await this.fetchFn(KEY_URL, {
        method: 'GET', headers: { Authorization: `Bearer ${settings.llmApiKey}` }, signal,
      })
      if (signal.aborted) return { ok: false, reason: networkReason(signal.reason, signal) }
      if (response.status === 200) return { ok: true }
      return { ok: false, reason: response.status === 401 || response.status === 403 ? 'unauthorized' : 'http' }
    } catch (error: unknown) {
      return { ok: false, reason: networkReason(error, signal) }
    }
  }

  dispose(): void {
    for (const requestId of [...this.inFlight.keys()]) this.cancel(requestId)
  }
}
