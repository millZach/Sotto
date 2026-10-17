import type { ReleaseTrack } from './releaseTrack'

export interface OwlFeature {
  readonly id: string
  readonly name: string
  readonly owlSince: string
  readonly owner: string
  readonly sentToStable: boolean
}

/** Zach marks a feature here; sending it to stable changes only sentToStable (ADR-0072). */
export const OWL_FEATURES = [
  { id: 'watcher', name: 'Watcher', owlSince: '2026-10-10', owner: 'docs/adr/0073-watcher-coordinates-threads-with-its-providers-own-tools.md', sentToStable: false },
  { id: 'muse', name: 'Muse provider', owlSince: '2026-10-12', owner: 'docs/adr/0079-muse-is-a-thread-provider.md', sentToStable: false },
  { id: 'usage', name: 'Usage', owlSince: '2026-10-12', owner: 'docs/adr/0078-usage-keeps-numeric-history-on-its-own-host.md', sentToStable: false },
  { id: 'resume-after-restart', name: 'Resume threads after a restart', owlSince: '2026-10-12', owner: 'docs/adr/0076-threads-resume-after-sotto-restarts.md', sentToStable: false },
  { id: 'update-all', name: 'Update all', owlSince: '2026-10-12', owner: 'docs/adr/0077-update-all-updates-sotto-its-clients-and-hosts-together.md', sentToStable: false },
  { id: 'streaming-publish-cost', name: 'Cheaper publish windows while streaming', owlSince: '2026-10-13', owner: 'docs/adr/0016-sotto-owned-history-on-an-event-store.md', sentToStable: false },
  { id: 'thread-delegation', name: 'Delegation between threads', owlSince: '2026-10-15', owner: 'docs/adr/0081-a-thread-may-delegate-work-to-threads-it-starts.md', sentToStable: false },
  { id: 'continue-on-provider', name: 'Continue a thread on another provider', owlSince: '2026-10-16', owner: 'docs/adr/0089-a-thread-continues-on-another-provider-as-a-new-linked-thread.md', sentToStable: false },
] as const satisfies readonly OwlFeature[]

export type OwlFeatureId = typeof OWL_FEATURES[number]['id']
export type OwlFeatureStates = Readonly<Record<OwlFeatureId, boolean>>

/** Unknown features stay off. The optional list lets tests exercise graduation without changing Watcher. */
export function isOwlFeatureEnabled(id: string, track: ReleaseTrack, features: readonly OwlFeature[] = OWL_FEATURES): boolean {
  const feature = features.find(entry => entry.id === id)
  return feature !== undefined && (track === 'owl' || feature.sentToStable)
}

export function owlFeaturesForTrack(track: ReleaseTrack): OwlFeatureStates {
  return Object.freeze(Object.fromEntries(OWL_FEATURES.map(feature => [feature.id, isOwlFeatureEnabled(feature.id, track)])) as Record<OwlFeatureId, boolean>)
}
