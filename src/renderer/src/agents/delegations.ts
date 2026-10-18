import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { AgentThread } from '../../../shared/agents'
import type { DelegatedView, DelegationsBridge, DelegationView } from '../../../shared/delegation'
import { useOwlFeature } from '../state/owlFeature'

/** What the window holds of one thread's delegations: the ones it made and the briefs it was sent, oldest first. */
export interface ThreadDelegations {
  readonly made: readonly DelegationView[]
  readonly received: readonly DelegatedView[]
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

const NO_THREADS: ReadonlyMap<string, ThreadDelegations> = new Map()

/**
 * What each of `threadIds` delegated, as main last answered, while the window shows delegation: one subscription for a
 * roster's worth of delegating threads (Tools › Agents lists a thread's delegated threads and theirs, ADR-0081). Each is
 * read once and again only when main names it, as `useDelegations` reads one. A thread main has not answered for yet has
 * no entry. The map keeps its identity until an answer changes.
 */
export function useDelegationsOf(threadIds: readonly string[], store: DelegationStore = windowStore): ReadonlyMap<string, ThreadDelegations> {
  const enabled = useDelegationsEnabled()
  const key = enabled ? JSON.stringify(threadIds) : '[]'
  const ids = useMemo(() => JSON.parse(key) as string[], [key])
  const held = useRef<{ readonly ids: readonly string[]; readonly list: readonly ThreadDelegations[]; readonly map: ReadonlyMap<string, ThreadDelegations> } | null>(null)
  const subscribe = useCallback((listener: () => void) => {
    const stops = ids.map(id => store.subscribe(id, listener))
    return () => { for (const stop of stops) stop() }
  }, [ids, store])
  const snapshot = useCallback((): ReadonlyMap<string, ThreadDelegations> => {
    if (!ids.length) return NO_THREADS
    const list = ids.map(id => store.delegations(id))
    const last = held.current
    if (last !== null && last.ids === ids && last.list.every((delegations, index) => delegations === list[index])) return last.map
    // A thread main has not answered for yet has no entry, so nothing is drawn from a read that has not landed.
    const map = new Map(ids.flatMap((id, index) => list[index] === NONE ? [] : [[id, list[index]!] as const]))
    held.current = { ids, list, map }
    return map
  }, [ids, store])
  const delegations = useSyncExternalStore(subscribe, snapshot, () => NO_THREADS)
  useEffect(() => { for (const id of ids) store.want(id) }, [ids, store])
  return delegations
}

/**
 * The whole of the newest brief `threadId` was sent, read from main only while `wanted` (a roster row's details are open):
 * the window's own copy of a thread holds its messages only while a pane shows it, and its summary only an excerpt of
 * the newest user message, which a later message of the user's replaces. Never a reply. `newest` names the newest
 * brief's delegation, so a brief sent while the details are open is read again rather than leaving the earlier one
 * shown. Undefined until it is read, and when Sotto no longer holds it.
 */
export function useFullBrief(threadId: string, newest: string | undefined, wanted: boolean): string | undefined {
  const enabled = useDelegationsEnabled()
  const [brief, setBrief] = useState<{ readonly threadId: string; readonly newest: string | undefined; readonly text: string } | undefined>(undefined)
  useEffect(() => {
    const bridge = typeof window === 'undefined' ? undefined : window.sotto?.delegations
    if (!enabled || !wanted || !bridge) return
    let current = true
    void bridge.brief({ threadId }).then(answer => { if (current && answer) setBrief({ threadId, newest, text: answer.text }) }, () => undefined)
    return () => { current = false }
  }, [enabled, wanted, threadId, newest])
  return brief?.threadId === threadId && brief.newest === newest ? brief.text : undefined
}

/** The newest brief a delegated thread was sent, read with the thread's own delegations; none for a thread no thread started. */
export function useNewestBrief(thread: Pick<AgentThread, 'id' | 'delegatedBy'>): DelegatedView | undefined {
  return useDelegations(thread.delegatedBy === undefined ? undefined : thread.id).received.at(-1)
}
