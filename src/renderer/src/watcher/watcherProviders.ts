import { useLingui } from '@lingui/react/macro'

import type { AgentModel } from '../../../shared/agents'
import type { WatcherOpenRequest } from '../../../shared/watcherRoom'
import { providerProfile } from '../../../shared/providerProfile'
import { providerKey } from '../agents/threadFacts'
import { useOwlFeature } from '../state/owlFeature'

export type WatcherProvider = WatcherOpenRequest['provider']

/**
 * Devin cannot host Watcher's tools, so only Codex, Claude Code, Grok Build and Muse models are offered for it. A Muse
 * model is listed only while Muse itself is (its Owl gate); a Muse too old to take Sotto's tools refuses in words when
 * Watcher starts (ADR-0079).
 */
export function watcherProviderOf(model: AgentModel): WatcherProvider | null {
  const provider = model.providerId ?? providerKey(model.provider)
  return providerProfile(provider)?.runsWatcher === true ? provider as WatcherProvider : null
}

/** The providers Watcher runs on, in words, for Watcher's room and Help alike; Muse is named only where its own gate shows it (ADR-0072). */
export function useWatcherProviderWords(): string {
  const { t } = useLingui()
  return useOwlFeature('muse') ? t`Codex, Claude Code, Grok Build or Muse` : t`Codex, Claude Code or Grok Build`
}
