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
  { id: 'worker-roles', name: 'Worker roles', owlSince: '2026-10-16', owner: 'docs/adr/0091-worker-roles-say-what-each-kind-of-work-starts-on.md', sentToStable: false },
  { id: 'continue-on-provider', name: 'Continue a thread on another provider', owlSince: '2026-10-16', owner: 'docs/adr/0089-a-thread-continues-on-another-provider-as-a-new-linked-thread.md', sentToStable: false },
  { id: 'continue-agent-thread', name: 'Continue an agent as its own thread, and Fork from here', owlSince: '2026-10-16', owner: 'docs/adr/0090-an-agent-or-a-reply-can-start-a-thread-of-its-own.md', sentToStable: false },
  { id: 'opencode', name: 'OpenCode provider', owlSince: '2026-10-16', owner: 'docs/adr/0087-opencode-is-a-thread-provider.md', sentToStable: false },
  { id: 'dictation-hold-shortcuts', name: 'Hold shortcuts, Fn and extra dictation shortcuts', owlSince: '2026-10-19', owner: 'docs/adr/0097-dictation-shortcuts-listen-for-held-keys.md', sentToStable: false },
  { id: 'main-freeze', name: 'Notice when main freezes, and Record a minute', owlSince: '2026-10-20', owner: 'docs/adr/0098-main-records-a-minute-of-itself-on-this-computer.md', sentToStable: false },
  { id: 'iphone-pull-request-view', name: 'Pull requests on the iPhone', owlSince: '2026-10-21', owner: 'docs/adr/0102-the-iphone-reads-a-threads-pull-request-in-a-sheet.md', sentToStable: false },
  { id: 'iphone-agents-view', name: 'Agents on the iPhone', owlSince: '2026-10-21', owner: 'docs/adr/0103-the-iphone-lists-a-threads-agents.md', sentToStable: false },
  { id: 'dictation-off', name: 'Turn dictation off', owlSince: '2026-10-22', owner: 'docs/adr/0107-dictation-can-be-turned-off.md', sentToStable: false },
  { id: 'message-scrubber', name: 'Message scrubber', owlSince: '2026-10-22', owner: 'docs/adr/0109-a-column-of-ticks-reaches-every-message-the-user-sent.md', sentToStable: false },
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
