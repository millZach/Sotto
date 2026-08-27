import type {
  RemoteAsrFailureReason,
  RemoteAsrHealth,
  RemoteTranscriptionRequest,
  RemoteTranscriptionResult,
} from '../../shared/contracts'
import type { AppSettings } from '../../shared/settings'

/**
 * OpenAI-compatible transcription servers require the multipart `model` field
 * but a self-hosted single-model server serves whatever weights it loaded
 * regardless of the value. The canonical OpenAI name is the one every such
 * server accepts, so it stays a constant instead of another setting to get
 * wrong.
 */
export const REMOTE_ASR_MODEL = 'whisper-1'

const TRANSCRIPTION_PATH = '/v1/audio/transcriptions'
const HEALTH_PATH = '/health'

/**
 * A reachable server answers `/health` in single-digit milliseconds on a LAN or
 * tailnet. This deadline only decides how long the settings test button and the
 * prewarm probe wait before calling the server absent.
 */
export const REMOTE_ASR_HEALTH_TIMEOUT_MS = 2_000

export interface RemoteAsrServiceDependencies {
  readonly getSettings: () => AppSettings | Promise<AppSettings>
  readonly fetchFn?: typeof fetch
}

/**
 * Normalizes whatever the user typed into a base URL. A bare `host:port` is the
 * shape people reach for, so a missing scheme means http; a pasted
 * `.../v1/audio/transcriptions` or `.../v1` collapses back to the root so both
 * endpoints resolve. Returns null for anything that is not a credential-free
 * http(s) address.
 */
export function resolveRemoteAsrBase(rawUrl: string): URL | null {
  const trimmed = rawUrl.trim()
  if (trimmed.length === 0) return null

  let url: URL
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username.length > 0 || url.password.length > 0) return null
  if (url.hostname.length === 0) return null

  const root = url.pathname
    .replace(/\/+$/u, '')
    .replace(new RegExp(`${TRANSCRIPTION_PATH}$`, 'u'), '')
    .replace(/\/v1$/u, '')
  return new URL(`${url.origin}${root}`)
}

function endpoint(base: URL, path: string): string {
  return `${base.origin}${base.pathname.replace(/\/+$/u, '')}${path}`
}

function extractText(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const text = (payload as { text?: unknown }).text
  return typeof text === 'string' ? text : null
}

function classifyNetworkFailure(error: unknown): RemoteAsrFailureReason {
  const name = error instanceof Error ? error.name : ''
  return name === 'TimeoutError' ? 'timeout' : 'network'
}

/**
 * Owns every remote-transcription HTTP call. It lives in main because the
 * renderer CSP grants no cross-origin `connect-src`, and weakening that to let
 * a renderer reach a LAN host would widen the attack surface of the whole app
 * for one optional feature. Like the LLM polish pass, no failure here is fatal:
 * every path resolves to a value the caller can fall back from.
 */
export class RemoteAsrService {
  private readonly fetchFn: typeof fetch
  private readonly inFlight = new Map<string, AbortController>()

  constructor(private readonly dependencies: RemoteAsrServiceDependencies) {
    this.fetchFn = dependencies.fetchFn ?? globalThis.fetch.bind(globalThis)
  }

  async transcribe(request: RemoteTranscriptionRequest): Promise<RemoteTranscriptionResult> {
    let settings: AppSettings
    try {
      settings = await this.dependencies.getSettings()
    } catch {
      return { ok: false, reason: 'disabled' }
    }
    if (!settings.remoteAsr) return { ok: false, reason: 'disabled' }

    const base = resolveRemoteAsrBase(settings.remoteAsrUrl)
    if (base === null) return { ok: false, reason: 'unconfigured' }

    // A second request under a live id would orphan the first controller, so
    // the newest one always wins and the previous attempt is abandoned.
    this.cancel(request.requestId)
    const controller = new AbortController()
    this.inFlight.set(request.requestId, controller)

    try {
      const form = new FormData()
      form.append('file', new Blob([request.wav], { type: 'audio/wav' }), 'segment.wav')
      form.append('model', REMOTE_ASR_MODEL)

      const response = await this.fetchFn(endpoint(base, TRANSCRIPTION_PATH), {
        method: 'POST',
        body: form,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(request.timeoutMs)]),
      })
      if (!response.ok) return { ok: false, reason: 'http' }

      let payload: unknown
      try {
        payload = await response.json()
      } catch (error: unknown) {
        // A body that is not JSON is a misbehaving server, not a dead network;
        // only an abort part-way through the body says otherwise.
        if (controller.signal.aborted) return { ok: false, reason: 'cancelled' }
        const name = error instanceof Error ? error.name : ''
        return { ok: false, reason: name === 'TimeoutError' ? 'timeout' : 'malformed' }
      }
      const text = extractText(payload)
      return text === null ? { ok: false, reason: 'malformed' } : { ok: true, text }
    } catch (error: unknown) {
      if (controller.signal.aborted) return { ok: false, reason: 'cancelled' }
      return { ok: false, reason: classifyNetworkFailure(error) }
    } finally {
      if (this.inFlight.get(request.requestId) === controller) {
        this.inFlight.delete(request.requestId)
      }
    }
  }

  /** Best effort: an already-settled or unknown request id is a no-op. */
  cancel(requestId: string): void {
    const controller = this.inFlight.get(requestId)
    if (controller === undefined) return
    this.inFlight.delete(requestId)
    try {
      controller.abort()
    } catch {
      // The request either already settled or will settle on its own deadline.
    }
  }

  /**
   * Reachability probe for the settings test button and the prewarm pass. It
   * deliberately ignores the enable toggle so the address can be verified
   * before it is switched on.
   */
  async check(): Promise<RemoteAsrHealth> {
    let settings: AppSettings
    try {
      settings = await this.dependencies.getSettings()
    } catch {
      return { ok: false, reason: 'unconfigured' }
    }

    const base = resolveRemoteAsrBase(settings.remoteAsrUrl)
    if (base === null) return { ok: false, reason: 'unconfigured' }

    try {
      const response = await this.fetchFn(endpoint(base, HEALTH_PATH), {
        method: 'GET',
        signal: AbortSignal.timeout(REMOTE_ASR_HEALTH_TIMEOUT_MS),
      })
      return response.ok ? { ok: true } : { ok: false, reason: 'http' }
    } catch (error: unknown) {
      return { ok: false, reason: classifyNetworkFailure(error) }
    }
  }

  /** Abandons every in-flight upload; used when the app is tearing down. */
  dispose(): void {
    for (const requestId of [...this.inFlight.keys()]) this.cancel(requestId)
  }
}
