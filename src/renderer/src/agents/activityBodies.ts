import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react'
import type { AgentActivity } from '../../../shared/agentActivity'
import { agentActivitySignature } from '../../../shared/agentThreadDetail'

/**
 * Cut bodies on the desktop (ADR-0025, October 18 amendment). A remote thread's records come with their long bodies cut;
 * a row that opens asks the thread's host for its record whole, and the answer is kept here, outside the thread's
 * detail, so the next delta, which replaces the record by its ID, does not wipe it. An answer is kept under the record's
 * signature as it was when it was asked for: a record that changed shows its new cut, and is asked for again when its
 * row is open. Answers stay for the session, bounded below, so a row opened again shows its body at once.
 */

/** What the transcript knows of a remote thread's host, for its rows' cut bodies. Null for this computer's threads. */
export interface ActivityBodyHost {
  /** The thread as the window keys it, host included. */
  readonly threadId: string
  /** The host's name as the window shows it. */
  readonly hostName: string
  readonly connected: boolean
}
export const ActivityBodyContext = createContext<ActivityBodyHost | null>(null)
export const useActivityBodyHost = (): ActivityBodyHost | null => useContext(ActivityBodyContext)

type Fetch = (request: { readonly threadId: string; readonly activityId: string }) => Promise<AgentActivity | null>
type Entry = { readonly status: 'loading' } | { readonly status: 'loaded'; readonly record: AgentActivity; readonly bytes: number } | { readonly status: 'failed' }

const MAX_ENTRIES = 400
/** About what 50 long command outputs take, so a session of reading never holds more than a few thread details' worth. */
const MAX_BYTES = 12 * 1024 * 1024

export class ActivityBodyCache {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private bytes = 0
  constructor(private readonly fetcher: () => Fetch | undefined, private readonly limits = { entries: MAX_ENTRIES, bytes: MAX_BYTES }) {}
  static key(threadId: string, record: AgentActivity): string { return `${threadId}\u0000${record.id}\u0000${agentActivitySignature(record)}` }
  get(key: string): Entry | undefined { return this.entries.get(key) }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  /** Asks the host for a record whole, unless it is here or on its way. A failed ask is made again only by `retry`. */
  request(threadId: string, record: AgentActivity): void {
    const key = ActivityBodyCache.key(threadId, record)
    if (this.entries.has(key)) { this.touch(key); return }
    this.start(key, threadId, record.id)
  }
  retry(threadId: string, record: AgentActivity): void {
    const key = ActivityBodyCache.key(threadId, record)
    if (this.entries.get(key)?.status === 'failed') this.start(key, threadId, record.id)
  }
  /** For tests: forgets every answer. */
  clear(): void { this.entries.clear(); this.bytes = 0; this.notify() }
  private start(key: string, threadId: string, activityId: string): void {
    const fetch = this.fetcher()
    // A record that changed leaves its earlier answers behind: they are for a body it no longer has.
    const prefix = key.slice(0, key.lastIndexOf('\u0000') + 1)
    for (const [other, entry] of this.entries) if (other !== key && other.startsWith(prefix)) this.drop(other, entry)
    if (!fetch) { this.set(key, { status: 'failed' }); return }
    this.set(key, { status: 'loading' })
    void fetch({ threadId, activityId }).then(record => {
      if (this.entries.get(key)?.status !== 'loading') return
      // A record the thread no longer has, or one still cut, is not a body to show.
      if (!record || record.id !== activityId || record.cut !== undefined) { this.set(key, { status: 'failed' }); return }
      this.set(key, { status: 'loaded', record, bytes: JSON.stringify(record).length })
      this.evict()
    }, () => { if (this.entries.get(key)?.status === 'loading') this.set(key, { status: 'failed' }) })
  }
  private set(key: string, entry: Entry): void {
    const previous = this.entries.get(key)
    if (previous) this.drop(key, previous, false)
    this.entries.set(key, entry)
    if (entry.status === 'loaded') this.bytes += entry.bytes
    this.notify()
  }
  private drop(key: string, entry: Entry, notify = true): void {
    this.entries.delete(key)
    if (entry.status === 'loaded') this.bytes -= entry.bytes
    if (notify) this.notify()
  }
  /** Map order is the order of use: a body read again moves to the end. */
  private touch(key: string): void {
    const entry = this.entries.get(key)
    if (entry?.status !== 'loaded') return
    this.entries.delete(key); this.entries.set(key, entry)
  }
  private evict(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.limits.entries && this.bytes <= this.limits.bytes) break
      // The newest answer stays even alone over the budget: its row is the one open.
      if (entry.status !== 'loaded' || key === [...this.entries.keys()].at(-1)) continue
      this.drop(key, entry, false)
    }
    this.notify()
  }
  private notify(): void { for (const listener of this.listeners) listener() }
}

export const activityBodies = new ActivityBodyCache(() => window.sotto?.agents?.activityBody)

/**
 * Where a row's cut body stands. `whole`: nothing of it is on the host, so the row draws as it always has. `loaded`: the
 * whole record is here. `loading`, `failed` and `disconnected`: the row shows the part it was sent.
 */
export type ActivityBodyState = 'whole' | 'loading' | 'loaded' | 'failed' | 'disconnected'
export interface ActivityBodyView {
  /** The record to draw: whole once it is here, else the one the host sent. */
  readonly record: AgentActivity
  /** The record as the host sent it, whose `cut` says which bodies were cut. */
  readonly sent: AgentActivity
  readonly state: ActivityBodyState
  readonly hostName: string
  readonly retry: () => void
}

const view = (record: AgentActivity, host: ActivityBodyHost | null, entry: Entry | undefined, cache: ActivityBodyCache): ActivityBodyView => {
  if (!host || record.cut === undefined) return { record, sent: record, state: 'whole', hostName: host?.hostName ?? '', retry: () => undefined }
  const state: ActivityBodyState = entry?.status === 'loaded' ? 'loaded' : !host.connected ? 'disconnected' : entry?.status === 'failed' ? 'failed' : 'loading'
  return { record: entry?.status === 'loaded' ? entry.record : record, sent: record, state, hostName: host.hostName,
    retry: () => cache.retry(host.threadId, record) }
}

/**
 * Each record's body as an open row shows it, asked for only while `open` and its host is connected. A row still open
 * when its host comes back asks again by itself. Several records (an Edit row's and a turn's changed files) share one
 * answer, because they share the cache.
 */
export function useActivityBodies(records: readonly AgentActivity[], open: boolean, cache: ActivityBodyCache = activityBodies): readonly ActivityBodyView[] {
  const host = useActivityBodyHost()
  const cut = host ? records.filter(record => record.cut !== undefined) : []
  const keys = host ? cut.map(record => ActivityBodyCache.key(host.threadId, record)) : []
  const snapshot = () => keys.map(key => cache.get(key)?.status ?? '').join('|')
  const states = useSyncExternalStore(cache.subscribe, snapshot, snapshot)
  const connected = host?.connected ?? false
  const was = useRef(connected)
  const joined = keys.join('\u0001')
  useEffect(() => {
    const back = connected && !was.current
    was.current = connected
    if (!host || !open || !connected) return
    for (const record of cut) {
      if (back) cache.retry(host.threadId, record)
      cache.request(host.threadId, record)
    }
    // `joined` stands for the records' keys and `states` for their answers, so the records themselves are not listed.
  }, [joined, open, connected, states])
  return records.map(record => view(record, host, host && record.cut !== undefined ? cache.get(ActivityBodyCache.key(host.threadId, record)) : undefined, cache))
}

export function useActivityBody(record: AgentActivity, open: boolean, cache?: ActivityBodyCache): ActivityBodyView {
  return useActivityBodies([record], open, cache)[0]!
}
