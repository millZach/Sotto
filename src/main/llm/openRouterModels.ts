import type { OpenRouterModelList } from '../../shared/contracts'
import { isOpenRouterPreset } from '../../shared/openRouterModel'
import { networkReason } from './networkReason'

const MODELS_URL = 'https://openrouter.ai/api/v1/models'
const PRESETS_URL = 'https://openrouter.ai/api/v1/presets'
/** OpenRouter pages its list; more pages than this is a list no one scrolls. */
const MAX_PAGES = 10
const MAX_MODELS = 5_000
const ID = /^[\w.\-/:]{1,128}$/u

/** Fixed diagnostics only: upstream errors and response bodies may contain keys or account details. */
export type OpenRouterModelsEvent = `openrouter-${'models' | 'presets'}-${'http' | 'invalid-response' | 'network' | 'timeout'}` | 'openrouter-presets-key-unreadable'

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
  readonly getApiKey?: () => Promise<string>
  readonly log?: (event: OpenRouterModelsEvent) => void
}

/**
 * The cleanup model picker's list (ADR-0122), with the user's active presets first. The public catalog gets no
 * key. Keys that cannot list presets can still use a pasted reference; a failed preset read leaves the catalog.
 */
export async function listOpenRouterModels(dependencies: OpenRouterModelsDependencies = {}): Promise<OpenRouterModelList> {
  const fetchFn = dependencies.fetchFn ?? globalThis.fetch.bind(globalThis)
  const signal = AbortSignal.timeout(10_000)
  const [catalog, presets] = await Promise.all([
    listPublicModels(fetchFn, signal, dependencies.log),
    dependencies.getApiKey ? listPresets(fetchFn, signal, dependencies.getApiKey, dependencies.log).catch((error: unknown) => {
      dependencies.log?.(`openrouter-presets-${error instanceof SyntaxError ? 'invalid-response' : networkReason(error, signal)}`)
      return []
    }) : [],
  ])
  if (!catalog.ok && presets.length === 0) return catalog
  const models = [...presets, ...(catalog.ok ? catalog.models : [])]
  return { ok: true, complete: catalog.ok && catalog.complete && models.length <= MAX_MODELS, models: models.slice(0, MAX_MODELS) }
}

async function listPresets(fetchFn: typeof fetch, signal: AbortSignal, getApiKey: () => Promise<string>, log?: OpenRouterModelsDependencies['log']): Promise<{ id: string; name: string }[]> {
  let apiKey: string
  try { apiKey = await getApiKey() } catch {
    log?.('openrouter-presets-key-unreadable')
    return []
  }
  if (!apiKey) return []
  const presets = new Map<string, string>()
  for (let page = 0, offset = 0; page < MAX_PAGES; page += 1) {
    const response = await fetchFn(`${PRESETS_URL}?limit=100&offset=${offset}`, {
      method: 'GET', headers: { Authorization: `Bearer ${apiKey}` }, redirect: 'error', signal,
    })
    if (!response.ok) { log?.('openrouter-presets-http'); break }
    const body = await response.json() as { data?: unknown; total_count?: unknown }
    if (!Array.isArray(body.data)) { log?.('openrouter-presets-invalid-response'); break }
    for (const entry of body.data as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue
      const { slug, name, status } = entry as { slug?: unknown; name?: unknown; status?: unknown }
      if (typeof slug !== 'string' || status !== 'active') continue
      const id = `@preset/${slug}`
      if (!isOpenRouterPreset(id) || presets.has(id) || presets.size >= MAX_MODELS) continue
      presets.set(id, typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : slug)
    }
    offset += body.data.length
    if (body.data.length === 0 || typeof body.total_count !== 'number' || offset >= body.total_count) break
  }
  return [...presets].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name))
}

async function listPublicModels(fetchFn: typeof fetch, signal: AbortSignal, log?: OpenRouterModelsDependencies['log']): Promise<OpenRouterModelList> {
  const models = new Map<string, string>()
  let complete: boolean
  try {
    let url: string | null = MODELS_URL
    for (let page = 0; url !== null && page < MAX_PAGES; page += 1) {
      const response = await fetchFn(url, { method: 'GET', signal })
      if (!response.ok) { log?.('openrouter-models-http'); return { ok: false, reason: 'http' } }
      const body = await response.json() as { data?: unknown; links?: { next?: unknown } }
      if (!Array.isArray(body.data)) { log?.('openrouter-models-invalid-response'); return { ok: false, reason: 'http' } }
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
    const reason = networkReason(error, signal)
    log?.(`openrouter-models-${error instanceof SyntaxError ? 'invalid-response' : reason}`)
    return { ok: false, reason }
  }
  return {
    ok: true,
    complete,
    models: [...models].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name)),
  }
}
