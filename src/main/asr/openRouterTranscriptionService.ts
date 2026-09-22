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
}

export interface OpenRouterTranscriptionServiceDependencies {
  readonly getSettings: () => Promise<AppSettings>
  readonly fetchFn?: typeof fetch
  /** Told about every failed request except one the user cancelled. */
  readonly onFailure?: (diagnostic: TranscriptionFailureDiagnostic) => void
  readonly now?: () => number
}

interface RequestTrace {
  attempts: number
  status?: number
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

/** Main owns uploads and decrypted credentials; errors never include provider response bodies. */
export class OpenRouterTranscriptionService {
  private readonly fetchFn: typeof fetch
  private readonly inFlight = new Map<string, AbortController>()

  constructor(private readonly dependencies: OpenRouterTranscriptionServiceDependencies) {
    this.fetchFn = dependencies.fetchFn ?? globalThis.fetch.bind(globalThis)
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const now = this.dependencies.now ?? Date.now
    const startedAt = now()
    const trace: RequestTrace = { attempts: 0 }
    const result = await this.request(request, trace)
    if (!result.ok && result.reason !== 'cancelled') {
      try {
        this.dependencies.onFailure?.({
          at: startedAt,
          reason: result.reason,
          ...(trace.status === undefined ? {} : { status: trace.status }),
          attempts: trace.attempts,
          audioMs: pcm16WavDurationMs(request.wav.byteLength, TRANSCRIPTION_SAMPLE_RATE),
          elapsedMs: Math.max(0, now() - startedAt),
        })
      } catch {
        // A diagnostic that cannot be written never changes what the user is told.
      }
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

      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (controller.signal.aborted) return { ok: false, reason: 'cancelled' }
        if (signal.aborted) return { ok: false, reason: 'timeout' }
        let reason: TranscriptionFailureReason
        let retryable = false
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
          if (signal.aborted) return { ok: false, reason: 'timeout' }
          trace.status = response.status
          if (!response.ok) {
            reason = statusReason(response.status)
            retryable = response.status === 429 || response.status >= 500
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
          retryable = reason === 'network'
        }
        // Retry only while the original deadline leaves a useful request budget.
        if (attempt !== 0 || !retryable || deadline - Date.now() < 1_500) {
          return { ok: false, reason }
        }
        try {
          await delay(300, undefined, { signal })
        } catch (error: unknown) {
          return { ok: false, reason: controller.signal.aborted ? 'cancelled' : networkReason(error, signal) }
        }
      }
      return { ok: false, reason: 'network' }
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
