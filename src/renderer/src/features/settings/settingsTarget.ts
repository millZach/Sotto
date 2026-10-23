import type { ProviderId } from '../../../../shared/agents'

/**
 * The provider Settings › Providers shows, for a link or a Find a setting result that leads to one provider's setting,
 * such as idle compaction's switch on Claude Code's page (ADR-0123). `navigate('settings', section, settings)` or Find
 * opens the page and brings the setting into view; this only says which provider's page holds it. The page takes an aim
 * made before it opened when it opens, and one made while it is open at once.
 */
let aimed: ProviderId | undefined
const listeners = new Set<(provider: ProviderId) => void>()

export function aimProviderSettings(provider: ProviderId): void {
  if (listeners.size) { for (const listener of listeners) listener(provider) } else aimed = provider
}

export function takeAimedProvider(): ProviderId | undefined {
  const provider = aimed
  aimed = undefined
  return provider
}

/** The Providers page, while it is open, hears each aim as it is made. */
export function onProviderAimed(listener: (provider: ProviderId) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The idle compaction switch's name, which is how a link or Find a setting brings it into view. */
export const COMPACT_IDLE_SETTING = 'Compact idle threads'
