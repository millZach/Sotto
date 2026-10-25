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
  { id: 'watcher', name: 'Watcher', owlSince: '2026-10-10', owner: 'docs/adr/0073-watcher-coordinates-threads-with-its-providers-own-tools.md', sentToStable: true },
  { id: 'muse', name: 'Muse provider', owlSince: '2026-10-12', owner: 'docs/adr/0079-muse-is-a-thread-provider.md', sentToStable: true },
  { id: 'usage', name: 'Usage', owlSince: '2026-10-12', owner: 'docs/adr/0078-usage-keeps-numeric-history-on-its-own-host.md', sentToStable: true },
  { id: 'resume-after-restart', name: 'Resume threads after a restart', owlSince: '2026-10-12', owner: 'docs/adr/0076-threads-resume-after-sotto-restarts.md', sentToStable: true },
  { id: 'update-all', name: 'Update all', owlSince: '2026-10-12', owner: 'docs/adr/0077-update-all-updates-sotto-its-clients-and-hosts-together.md', sentToStable: true },
  { id: 'streaming-publish-cost', name: 'Cheaper publish windows while streaming', owlSince: '2026-10-13', owner: 'docs/adr/0016-sotto-owned-history-on-an-event-store.md', sentToStable: true },
  { id: 'thread-delegation', name: 'Delegation between threads', owlSince: '2026-10-15', owner: 'docs/adr/0081-a-thread-may-delegate-work-to-threads-it-starts.md', sentToStable: true },
  { id: 'worker-roles', name: 'Worker roles', owlSince: '2026-10-16', owner: 'docs/adr/0091-worker-roles-say-what-each-kind-of-work-starts-on.md', sentToStable: true },
  { id: 'continue-on-provider', name: 'Continue a thread on another provider', owlSince: '2026-10-16', owner: 'docs/adr/0089-a-thread-continues-on-another-provider-as-a-new-linked-thread.md', sentToStable: true },
  { id: 'continue-agent-thread', name: 'Continue an agent as its own thread, and Fork from here', owlSince: '2026-10-16', owner: 'docs/adr/0090-an-agent-or-a-reply-can-start-a-thread-of-its-own.md', sentToStable: true },
  { id: 'opencode', name: 'OpenCode provider', owlSince: '2026-10-16', owner: 'docs/adr/0087-opencode-is-a-thread-provider.md', sentToStable: true },
  { id: 'dictation-hold-shortcuts', name: 'Hold shortcuts, Fn and extra dictation shortcuts', owlSince: '2026-10-19', owner: 'docs/adr/0097-dictation-shortcuts-listen-for-held-keys.md', sentToStable: true },
  { id: 'main-freeze', name: 'Notice when main freezes, and Record a minute', owlSince: '2026-10-20', owner: 'docs/adr/0098-main-records-a-minute-of-itself-on-this-computer.md', sentToStable: true },
  { id: 'iphone-pull-request-view', name: 'Pull requests on the iPhone', owlSince: '2026-10-21', owner: 'docs/adr/0102-the-iphone-reads-a-threads-pull-request-in-a-sheet.md', sentToStable: true },
  { id: 'iphone-agents-view', name: 'Agents on the iPhone', owlSince: '2026-10-21', owner: 'docs/adr/0103-the-iphone-lists-a-threads-agents.md', sentToStable: true },
  { id: 'dictation-off', name: 'Turn dictation off', owlSince: '2026-10-22', owner: 'docs/adr/0107-dictation-can-be-turned-off.md', sentToStable: true },
  { id: 'message-scrubber', name: 'Message scrubber', owlSince: '2026-10-22', owner: 'docs/adr/0109-a-column-of-ticks-reaches-every-message-the-user-sent.md', sentToStable: true },
  { id: 'menu-bar-owl', name: 'The menu bar owl', owlSince: '2026-10-22', owner: 'docs/adr/0114-the-menu-bar-owl-is-alive.md', sentToStable: true },
  { id: 'desktop-notifications', name: 'Notifications when a thread has finished or needs you', owlSince: '2026-10-22', owner: 'docs/adr/0117-the-desktop-notifies-when-a-thread-has-finished-everything-or-needs-you.md', sentToStable: true },
  { id: 'recent-projects', name: 'Recent projects on a new thread', owlSince: '2026-10-23', owner: 'docs/adr/0121-a-new-thread-can-move-to-a-recent-project.md', sentToStable: false },
  { id: 'creature-toggle', name: 'Show the creature', owlSince: '2026-10-23', owner: 'docs/adr/0116-the-creature-above-the-composer-is-a-choice.md', sentToStable: false },
  { id: 'night-falls', name: 'Night falls between Dictate or Threads and Watcher', owlSince: '2026-10-23', owner: 'docs/adr/0119-night-falls-moves-the-window-between-threads-and-watchers-room.md', sentToStable: false },
  { id: 'reveal-linked-files', name: 'Show linked files in Finder or File Explorer', owlSince: '2026-10-23', owner: 'docs/adr/0120-a-file-link-in-a-reply-shows-the-file-in-its-folder.md', sentToStable: false },
  { id: 'cursor', name: 'Cursor provider', owlSince: '2026-10-23', owner: 'docs/adr/0128-cursor-is-a-thread-provider.md', sentToStable: false },
  { id: 'cleanup-model', name: 'Choose the AI cleanup model and mode', owlSince: '2026-10-23', owner: 'docs/adr/0122-the-cleanup-model-can-be-chosen-on-owl.md', sentToStable: false },
  { id: 'interface-language', name: 'Interface language', owlSince: '2026-10-23', owner: 'docs/adr/0123-sottos-interface-speaks-the-computers-language.md', sentToStable: false },
  { id: 'own-model-servers', name: 'Your own model servers', owlSince: '2026-10-23', owner: 'docs/adr/0124-your-own-model-server-is-a-model-source.md', sentToStable: false },
  { id: 'composer-shrink', name: 'Slim composer while reading back', owlSince: '2026-10-23', owner: 'docs/adr/0125-the-composer-slims-while-the-user-reads-back.md', sentToStable: false },
  { id: 'attach-any-file', name: 'Attach any file', owlSince: '2026-10-24', owner: 'docs/adr/0131-any-file-can-be-attached.md', sentToStable: false },
  { id: 'reply-quote', name: 'Quote a reply in the prompt', owlSince: '2026-10-24', owner: 'docs/adr/0129-words-from-a-reply-can-be-quoted-in-the-next-prompt.md', sentToStable: false },
  { id: 'next-prompt', name: 'Next prompt suggestions', owlSince: '2026-10-24', owner: 'docs/adr/0132-a-finished-turn-suggests-the-next-prompt.md', sentToStable: false },
  { id: 'cross-machine-work', name: 'Work across machines', owlSince: '2026-10-22', owner: 'docs/adr/0082-work-moves-between-a-desktops-machines-over-its-own-ssh-link.md', sentToStable: false },
  { id: 'folder-peek', name: 'Peek inside a closed folder', owlSince: '2026-10-24', owner: 'docs/plans/collapsed-folder-peek.md', sentToStable: false },
  { id: 'run-command', name: 'Run a command from a reply', owlSince: '2026-10-25', owner: 'docs/adr/0136-a-command-in-a-reply-runs-in-the-terminal-drawer.md', sentToStable: false },
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
