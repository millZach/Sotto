import type { AgentModel } from '../../../shared/agents'
import type { WatcherOpenRequest } from '../../../shared/watcherRoom'
import { providerKey } from '../agents/threadFacts'

export type WatcherProvider = WatcherOpenRequest['provider']
const WATCHER_PROVIDERS: ReadonlySet<string> = new Set<WatcherProvider>(['codex', 'claude', 'grok'])

/** Devin and Muse cannot host Watcher's tools, so only Codex, Claude Code and Grok Build models are offered for it. */
export function watcherProviderOf(model: AgentModel): WatcherProvider | null {
  const provider = model.providerId ?? providerKey(model.provider)
  return WATCHER_PROVIDERS.has(provider) ? provider as WatcherProvider : null
}
