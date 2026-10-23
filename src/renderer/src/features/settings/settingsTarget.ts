import type { ProviderId } from '../../../../shared/agents'

/**
 * The provider Settings › Providers shows first on its next opening, for a link that leads to one provider's setting,
 * such as a thread's Turn off for idle compaction (ADR-0123). `navigate('settings', section, settings)` opens the page
 * and brings the setting into view; this only says which provider's page holds it. Read once, by the page that opens.
 */
let aimed: ProviderId | undefined

export function aimProviderSettings(provider: ProviderId): void { aimed = provider }

export function takeAimedProvider(): ProviderId | undefined {
  const provider = aimed
  aimed = undefined
  return provider
}

/** The idle compaction switch's name, which is how a link or Find a setting brings it into view. */
export const COMPACT_IDLE_SETTING = 'Compact idle threads'
