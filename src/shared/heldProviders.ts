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

/** What a refused command says. Muse's words are "Muse is available in Sotto Owl. Open an Owl build to continue. Nothing was sent." */
export function heldProviderRefusal(provider: ProviderId): string {
  return `${PROVIDER_LABELS[provider]} is available in Sotto Owl. Open an Owl build to continue. Nothing was sent.`
}
