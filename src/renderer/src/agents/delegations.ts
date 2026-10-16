import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { AgentThread } from '../../../shared/agents'
import type { DelegationsBridge, DelegationView } from '../../../shared/delegation'
import { useOwlFeature } from '../state/owlFeature'

/** What the window holds of one thread's delegations: the ones it made and the briefs it was sent, oldest first. */
export interface ThreadDelegations {
  readonly made: readonly DelegationView[]
  readonly received: readonly DelegationView[]
}
const NONE: ThreadDelegations = { made: [], received: [] }

interface Entry {
  delegations: ThreadDelegations
  readonly listeners: Set<() => void>
  /** A read is on its way; `again` asks for one more once it lands, because main named the thread since. */
  reading: boolean
  again: boolean
  /** The window has asked main for this thread since a pane began showing it. */
  asked: boolean
}

/**
 * The window's copy of the delegations of each thread a pane shows (#1029). It asks main once when a pane opens on a
 * thread, and again only when main names the thread as changed; never on a publish, and never for a thread no pane
 * shows. Main answers from its own record without reading the snapshot. What it holds goes when the last pane showing
 * the thread closes.
 */
export class DelegationStore {
  private readonly entries = new Map<string, Entry>()
  private stopChanges: (() => void) | undefined

  constructor(private readonly bridge: () => DelegationsBridge | undefined) {}

  readonly subscribe = (threadId: string, listener: () => void): (() => void) => {
    const entry = this.entries.get(threadId) ?? { delegations: NONE, listeners: new Set<() => void>(), reading: false, again: false, asked: false }
    this.entries.set(threadId, entry)
    entry.listeners.add(listener)
    this.listen()
    return () => {
      entry.listeners.delete(listener)
      if (entry.listeners.size || this.entries.get(threadId) !== entry) return
      this.entries.delete(threadId)
      if (!this.entries.size) { this.stopChanges?.(); this.stopChanges = undefined }
    }
  }
  delegations(threadId: string): ThreadDelegations { return this.entries.get(threadId)?.delegations ?? NONE }
  /** Asks main once for a shown thread; later reads come only from main naming it as changed. */
  want(threadId: string): void {
    const entry = this.entries.get(threadId)
    if (!entry || entry.asked) return
    entry.asked = true
    this.read(threadId, entry)
  }

  private listen(): void {
    const bridge = this.bridge()
    if (this.stopChanges || !bridge) return
    this.stopChanges = bridge.onChanged(change => {
      for (const threadId of change.threadIds) {
        const entry = this.entries.get(threadId)
        if (!entry?.listeners.size) continue
        entry.asked = true
        this.read(threadId, entry)
      }
    })
  }
  private read(threadId: string, entry: Entry): void {
    const bridge = this.bridge()
    if (!bridge) return
    if (entry.reading) { entry.again = true; return }
    entry.reading = true
    void bridge.read({ threadId }).then(answer => {
      if (this.entries.get(threadId) !== entry) return
      entry.delegations = { made: answer.delegations, received: answer.received }
      for (const listener of [...entry.listeners]) listener()
    }, () => undefined).finally(() => {
      entry.reading = false
      if (entry.again && this.entries.get(threadId) === entry) { entry.again = false; this.read(threadId, entry) }
    })
  }
}

const windowStore = new DelegationStore(() => typeof window === 'undefined' ? undefined : window.sotto?.delegations)

/** Whether the window shows delegation: the Owl list turns it on and main offered the bridge. */
export function useDelegationsEnabled(): boolean {
  return useOwlFeature('thread-delegation') && typeof window !== 'undefined' && window.sotto?.delegations !== undefined
}

/**
 * What `threadId` delegated and was sent, as main last answered, while the window shows delegation; nothing for no
 * thread. `store` is the window's, or a test's.
 */
export function useDelegations(threadId: string | undefined, store: DelegationStore = windowStore): ThreadDelegations {
  const enabled = useDelegationsEnabled()
  const id = enabled ? threadId : undefined
  const subscribe = useCallback((listener: () => void) => id === undefined ? () => undefined : store.subscribe(id, listener), [id, store])
  const delegations = useSyncExternalStore(subscribe, () => id === undefined ? NONE : store.delegations(id), () => NONE)
  useEffect(() => { if (id !== undefined) store.want(id) }, [id, store])
  return delegations
}

/** The newest brief a delegated thread was sent, read with the thread's own delegations; none for a thread no thread started. */
export function useNewestBrief(thread: Pick<AgentThread, 'id' | 'delegatedBy'>): DelegationView | undefined {
  return useDelegations(thread.delegatedBy === undefined ? undefined : thread.id).received.at(-1)
}
