import type { OpenRouterModelList } from '../../shared/contracts'

const MODELS_URL = 'https://openrouter.ai/api/v1/models'
/** OpenRouter pages its list; more pages than this is a list no one scrolls. */
const MAX_PAGES = 10
const MAX_MODELS = 5_000
const ID = /^[\w.\-/:]{1,128}$/u

/** The next page, only on OpenRouter's own models list; anything else ends the read. */
function nextPage(next: unknown): string | null {
  if (typeof next !== 'string') return null
  try {
    const url = new URL(next, MODELS_URL)
    return url.origin === 'https://openrouter.ai' && url.pathname === '/api/v1/models' ? url.toString() : null
  } catch { return null }
}

export interface OpenRouterModelsDependencies {
  readonly fetchFn?: typeof fetch
}

/**
 * The cleanup model picker's list (ADR-0122): OpenRouter's text models, by slug and name. The list is public, so
 * no key is sent; only the request itself reaches openrouter.ai, the host AI cleanup already uses.
 */
export async function listOpenRouterModels(dependencies: OpenRouterModelsDependencies = {}): Promise<OpenRouterModelList> {
  const fetchFn = dependencies.fetchFn ?? globalThis.fetch.bind(globalThis)
  const signal = AbortSignal.timeout(10_000)
  const models = new Map<string, string>()
  let complete: boolean
  try {
    let url: string | null = MODELS_URL
    for (let page = 0; url !== null && page < MAX_PAGES; page += 1) {
      const response = await fetchFn(url, { method: 'GET', signal })
      if (!response.ok) return { ok: false, reason: 'http' }
      const body = await response.json() as { data?: unknown; links?: { next?: unknown } }
      if (!Array.isArray(body.data)) return { ok: false, reason: 'http' }
      for (const entry of body.data as unknown[]) {
        if (typeof entry !== 'object' || entry === null) continue
        const { id, name } = entry as { id?: unknown; name?: unknown }
        if (typeof id !== 'string' || !ID.test(id) || models.has(id) || models.size >= MAX_MODELS) continue
        models.set(id, typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : id)
      }
      url = nextPage(body.links?.next)
    }
    complete = url === null
  } catch (error: unknown) {
    const cause: unknown = signal.aborted ? signal.reason : error
    const timedOut = typeof cause === 'object' && cause !== null && 'name' in cause && cause.name === 'TimeoutError'
    return { ok: false, reason: timedOut ? 'timeout' : 'network' }
  }
  return {
    ok: true,
    complete,
    models: [...models].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name)),
  }
}
