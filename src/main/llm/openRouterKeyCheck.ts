import type { OpenRouterKeyCheck } from '../../shared/contracts'
import type { AppSettings } from '../../shared/settings'

const KEY_URL = 'https://openrouter.ai/api/v1/key'

export interface OpenRouterKeyCheckDependencies {
  readonly getSettings: () => Promise<AppSettings>
  readonly fetchFn?: typeof fetch
}

function networkReason(error: unknown, signal: AbortSignal): 'timeout' | 'network' {
  const cause: unknown = signal.aborted ? signal.reason : error
  // DOMException and AbortSignal reasons may come from a different runtime realm.
  return typeof cause === 'object' && cause !== null && 'name' in cause && cause.name === 'TimeoutError'
    ? 'timeout'
    : 'network'
}

/**
 * Verify key: asks OpenRouter's key endpoint whether the saved key is accepted. The key now serves
 * AI cleanup only (ADR-0071); nothing but the key itself is sent, and only the verdict comes back.
 */
export async function checkOpenRouterKey(dependencies: OpenRouterKeyCheckDependencies): Promise<OpenRouterKeyCheck> {
  let settings: AppSettings
  try { settings = await dependencies.getSettings() }
  catch { return { ok: false, reason: 'unconfigured' } }
  if (!settings.llmApiKey.trim()) return { ok: false, reason: 'unconfigured' }
  const fetchFn = dependencies.fetchFn ?? globalThis.fetch.bind(globalThis)
  const signal = AbortSignal.timeout(5_000)
  try {
    const response = await fetchFn(KEY_URL, {
      method: 'GET', headers: { Authorization: `Bearer ${settings.llmApiKey}` }, signal,
    })
    if (signal.aborted) return { ok: false, reason: networkReason(signal.reason, signal) }
    if (response.status === 200) return { ok: true }
    return { ok: false, reason: response.status === 401 || response.status === 403 ? 'unauthorized' : 'http' }
  } catch (error: unknown) {
    return { ok: false, reason: networkReason(error, signal) }
  }
}
