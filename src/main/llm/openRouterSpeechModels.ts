import type { CloudSpeechModelList } from '../../shared/contracts'
import { rankCloudSpeechModels, type ListedSpeechModel } from '../../shared/cloudSpeechModels'

const SPEECH_MODELS_URL = 'https://openrouter.ai/api/v1/models?output_modalities=transcription'
const ZDR_ENDPOINTS_URL = 'https://openrouter.ai/api/v1/endpoints/zdr'
const MAX_MODELS = 500
const ID = /^[\w.\-/:~]{1,128}$/u
/** A list read this recently is used again rather than read anew, so each dictation does not ask OpenRouter for it. */
const FRESH_MS = 10 * 60_000

export interface OpenRouterSpeechModelsDependencies {
  readonly fetchFn?: typeof fetch
  readonly now?: () => number
}

function failure(error: unknown, signal: AbortSignal): CloudSpeechModelList {
  const cause: unknown = signal.aborted ? signal.reason : error
  const timedOut = typeof cause === 'object' && cause !== null && 'name' in cause && cause.name === 'TimeoutError'
  return { ok: false, reason: timedOut ? 'timeout' : 'network' }
}

/**
 * OpenRouter's speech models for cloud transcription (ADR-0160): the models whose output is a transcription, and which
 * of them has a host that keeps no audio. Both lists are public, so no key is sent; only the requests reach
 * openrouter.ai, the host AI cleanup already uses. The list is kept for ten minutes, and a failed read keeps the last
 * good one, so a dictation never waits on it twice.
 */
export class OpenRouterSpeechModels {
  private readonly fetchFn: typeof fetch
  private readonly now: () => number
  private last: { readonly at: number; readonly list: Extract<CloudSpeechModelList, { ok: true }> } | null = null
  private reading: Promise<CloudSpeechModelList> | null = null

  constructor(dependencies: OpenRouterSpeechModelsDependencies = {}) {
    this.fetchFn = dependencies.fetchFn ?? globalThis.fetch.bind(globalThis)
    this.now = dependencies.now ?? Date.now
  }

  /** The ranked list; `fresh` reads it again even when the kept one is recent, as Settings does when it opens. */
  list(fresh = false): Promise<CloudSpeechModelList> {
    if (!fresh && this.last !== null && this.now() - this.last.at < FRESH_MS) return Promise.resolve(this.last.list)
    this.reading ??= this.read().finally(() => { this.reading = null })
    return this.reading
  }

  /**
   * Whether the model has a host that keeps no audio, from the last list read: null while no list has been read, or for
   * a model the list does not name, so the caller can keep to zero retention when it cannot tell.
   */
  zeroRetention(id: string): boolean | null {
    return this.last?.list.models.find((model) => model.id === id)?.zdr ?? null
  }

  /** The first model in the ranking, or null before a list has been read. */
  best(): string | null {
    return this.last?.list.models[0]?.id ?? null
  }

  private async read(): Promise<CloudSpeechModelList> {
    const signal = AbortSignal.timeout(10_000)
    try {
      const [models, zdr] = await Promise.all([
        this.fetchFn(SPEECH_MODELS_URL, { method: 'GET', signal }),
        this.fetchFn(ZDR_ENDPOINTS_URL, { method: 'GET', signal }),
      ])
      if (!models.ok || !zdr.ok) return this.last?.list ?? { ok: false, reason: 'http' }
      const modelBody = await models.json() as { data?: unknown }
      const zdrBody = await zdr.json() as { data?: unknown }
      if (!Array.isArray(modelBody.data) || !Array.isArray(zdrBody.data)) return this.last?.list ?? { ok: false, reason: 'http' }
      const zeroRetention = new Set<string>()
      for (const endpoint of zdrBody.data as unknown[]) {
        const id = typeof endpoint === 'object' && endpoint !== null ? (endpoint as { model_id?: unknown }).model_id : undefined
        if (typeof id === 'string') zeroRetention.add(id)
      }
      const listed = new Map<string, ListedSpeechModel>()
      for (const entry of modelBody.data as unknown[]) {
        if (typeof entry !== 'object' || entry === null || listed.size >= MAX_MODELS) continue
        const { id, name, architecture, pricing } = entry as { id?: unknown; name?: unknown; architecture?: { output_modalities?: unknown }; pricing?: { prompt?: unknown } }
        if (typeof id !== 'string' || !ID.test(id) || listed.has(id)) continue
        const outputs = architecture?.output_modalities
        if (!Array.isArray(outputs) || !outputs.includes('transcription')) continue
        const price = typeof pricing?.prompt === 'string' ? Number(pricing.prompt) : NaN
        listed.set(id, {
          id,
          name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : id,
          promptPrice: Number.isFinite(price) && price >= 0 ? price : null,
          zdr: zeroRetention.has(id),
        })
      }
      const list = { ok: true as const, models: rankCloudSpeechModels([...listed.values()]) }
      this.last = { at: this.now(), list }
      return list
    } catch (error: unknown) {
      return this.last?.list ?? failure(error, signal)
    }
  }
}
