import { PROVIDER_LABELS, type ProviderId } from './agents'
import type { OwlFeatureId } from './owlFeatures'

/** A thread provider held to Owl: stable shows and starts none of it until its Owl feature is sent to stable (ADR-0072). */
export interface HeldProviderEntry {
  readonly provider: ProviderId
  readonly feature: OwlFeatureId
}

/** Which providers an Owl feature holds. A provider held to Owl is one entry here; every gate reads this table. */
export const HELD_PROVIDER_ENTRIES = [
  { provider: 'muse', feature: 'muse' },
  { provider: 'opencode', feature: 'opencode' },
  { provider: 'cursor', feature: 'cursor' },
  { provider: 'deepseek', feature: 'deepseek' },
] as const satisfies readonly HeldProviderEntry[]

/** The providers held on this run: a fact read once at start, like the Owl answers it comes from. */
export type HeldProviders = ReadonlySet<ProviderId>

/** Providers whose Owl feature is off on this run. A missing answer holds its provider: the gate fails closed. */
export function heldProvidersOf(features: Partial<Readonly<Record<OwlFeatureId, boolean>>>,
  entries: readonly HeldProviderEntry[] = HELD_PROVIDER_ENTRIES): HeldProviders {
  return new Set(entries.filter(entry => features[entry.feature] !== true).map(entry => entry.provider))
}

/** Whether any table provider runs on this run, which needs Owl's matching host. */
export function releasesHeldProvider(held: HeldProviders, entries: readonly HeldProviderEntry[] = HELD_PROVIDER_ENTRIES): boolean {
  return entries.some(entry => !held.has(entry.provider))
}

/**
 * Options built before the held set existed name Muse's answer alone; `heldProviders` wins when both are given, and
 * neither holds every table provider.
 */
export function heldProvidersOption(options: { readonly heldProviders?: HeldProviders; readonly museEnabled?: boolean }): HeldProviders {
  return options.heldProviders ?? heldProvidersOf({ muse: options.museEnabled === true })
}

/** The provider a refusal names when a dormant thread's own provider is no longer known. */
export function firstHeldProvider(held: HeldProviders): ProviderId {
  return held.values().next().value ?? HELD_PROVIDER_ENTRIES[0].provider
}

/**
 * Providers in the held table's order, those the table does not name after them as given, so a sentence naming several
 * reads the same whatever order their threads were seen in.
 */
export function inHeldOrder(providers: readonly ProviderId[], entries: readonly HeldProviderEntry[] = HELD_PROVIDER_ENTRIES): ProviderId[] {
  const rank = (id: ProviderId): number => { const at = entries.findIndex(entry => entry.provider === id); return at < 0 ? entries.length : at }
  return [...new Set(providers)].map((id, index) => ({ id, index })).sort((a, b) => rank(a.id) - rank(b.id) || a.index - b.index).map(({ id }) => id)
}

/** One held provider a refusal names, or several when the refused request touched more than one. */
export type HeldProviderNames = ProviderId | readonly ProviderId[]

/**
 * What a refused command says. Muse's words are "Muse is available in Sotto Owl. Open an Owl build to continue. Nothing was
 * sent." Several held providers are named together: "Muse and OpenCode are available in Sotto Owl. ..."
 */
export function heldProviderRefusal(provider: HeldProviderNames): string {
  const labels = inHeldOrder(typeof provider === 'string' ? [provider] : provider).map(id => PROVIDER_LABELS[id])
  const named = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)} are` : `${labels[0] ?? ''} is`
  return `${named} available in Sotto Owl. Open an Owl build to continue. Nothing was sent.`
}
