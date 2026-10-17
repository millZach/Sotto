import type { AgentModel } from '../../../shared/agents'
import type { WatcherOpenRequest } from '../../../shared/watcherRoom'
import { providerKey } from '../agents/threadFacts'

export type WatcherProvider = WatcherOpenRequest['provider']
const WATCHER_PROVIDERS: ReadonlySet<string> = new Set<WatcherProvider>(['codex', 'claude', 'grok', 'muse'])

/**
 * Devin cannot host Watcher's tools, so only Codex, Claude Code, Grok Build and Muse models are offered for it. A Muse
 * model is listed only while Muse itself is (its Owl gate); a Muse too old to take Sotto's tools refuses in words when
 * Watcher starts (ADR-0079).
 */
export function watcherProviderOf(model: AgentModel): WatcherProvider | null {
  const provider = model.providerId ?? providerKey(model.provider)
  return WATCHER_PROVIDERS.has(provider) ? provider as WatcherProvider : null
}
