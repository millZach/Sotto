import { randomUUID } from 'node:crypto'
import type { AgentState, AgentThread } from '../../shared/agents'
import { ALERT_DELEGATION_SETTLE_MS, ALERT_SETTLE_MS, type ThreadAlert } from '../../shared/desktopNotifications'
import { isThreadTurnRunning } from '../../shared/threadActivity'
import { settledIn } from '../agents/finishedUnread'
import { watcherBackgroundWorkCount } from '../agents/watcherWakeUp'

/** What the tracker is told and tells (ADR-0114). */
export interface ThreadAlertsOptions {
  readonly shows: (threadId: string) => boolean
  /** Watcher keeps this thread going: it never alerts as finished. Absent where Watcher is off. */
  readonly watched?: (threadId: string) => boolean
  readonly emit: (alert: ThreadAlert) => void
  readonly timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
}

type AlertState = Pick<AgentState, 'host' | 'followups' | 'deliveries'>
type Timers = NonNullable<ThreadAlertsOptions['timers']>

interface ThreadRecord {
  /** The publication that last carried the thread. */
  seen: number
  /** This mark's epoch was alerted, or was there when the thread was first seen. */
  alerted: boolean
  timer?: unknown
  /** The thread as last published while a finish was due, for the alert's words. */
  thread?: AgentThread | undefined
}

/** The delegations of one publication (ADR-0081), built only when some thread has `delegatedBy`. */
interface Delegations {
  readonly byId: Map<string, AgentThread>
  readonly children: Map<string, AgentThread[]>
  /** Threads that delegated to some thread here, settled or not: one may still be owed its answer as a hidden turn. */
  readonly delegating: Set<string>
}

/** The iPhone's bound: request keys that have left are dropped once there are more than this. */
const SEEN_REQUESTS_MAX = 1_000
const ROOT_HOPS = 3

const defaultTimers: Timers = {
  set(fn, ms) {
    const handle = setTimeout(fn, ms) as { unref?: () => void }
    handle.unref?.()
    return handle
  },
  clear(handle) { clearTimeout(handle as Parameters<typeof clearTimeout>[0]) },
}

/**
 * The user's "completely finished" says no: a turn, background work, sub-agents or monitoring still running, a compaction,
 * a babysat pull request (decision 3), a request waiting on the user, or a send still on its way.
 */
const holds = (thread: AgentThread, queued: ReadonlySet<string> | undefined): boolean =>
  isThreadTurnRunning(thread) || watcherBackgroundWorkCount(thread) > 0 || thread.compaction?.status === 'running'
  || (thread.babysitting?.length ?? 0) > 0 || thread.requests.length > 0 || queued?.has(thread.id) === true

/** The top-level thread a delegated thread works for: the thread itself when it has none or the chain leaves the state. */
function root(thread: AgentThread, delegations: Delegations | undefined): AgentThread {
  let top = thread
  for (let hop = 0; delegations && hop < ROOT_HOPS && top.delegatedBy !== undefined; hop++) {
    const parent = delegations.byId.get(top.delegatedBy)
    if (!parent || parent === thread) break
    top = parent
  }
  return top
}

function alertOf(kind: ThreadAlert['kind'], thread: AgentThread, title: string, id: string, request?: ThreadAlert['request']): ThreadAlert {
  const computer = thread.remoteHost === true ? thread.hostLabel : undefined
  return {
    kind, threadId: thread.id, title, id,
    ...(thread.providerId === undefined ? {} : { providerId: thread.providerId }),
    ...(request === undefined ? {} : { request }),
    ...(computer ? { computer } : {}),
  }
}

/**
 * Decides when a thread's desktop notification is due (ADR-0114), from each state the router publishes. Needs you is the
 * iPhone's rule (ADR-0051): once per request ID, never for the thread the window shows. Finished follows the host's
 * Finished unread mark (ADR-0046), held while anything the thread started still runs, waits or is queued, and told once
 * per mark after `ALERT_SETTLE_MS` of quiet. A thread first seen is a baseline: what it already has is not news.
 */
export class ThreadAlerts {
  private readonly records = new Map<string, ThreadRecord>()
  /** Requests seen, as `threadId/requestId`, so one that leaves and comes back never alerts twice. */
  private readonly seenRequests = new Set<string>()
  private readonly timers: Timers
  private publication = 0
  private finished = 0
  /** Makes finished ids unique across runs too, so the system never merges two (ADR-0051). */
  private readonly run = randomUUID().slice(0, 8)
  private disposed = false

  constructor(private readonly options: ThreadAlertsOptions) { this.timers = options.timers ?? defaultTimers }

  /** Reads one published state. */
  track(state: AlertState): void {
    if (this.disposed) return
    const publication = ++this.publication
    const threads = state.host.threads
    const settled = settledIn(state.host)
    let asks: { thread: AgentThread; requestId: string; permission: boolean }[] | undefined
    let due: { thread: AgentThread; record: ThreadRecord }[] | undefined
    let delegated = false
    for (const thread of threads) {
      // A settled delegated thread counts too: its delegating thread may still be owed its answer.
      if (thread.delegatedBy !== undefined) delegated = true
      let record = this.records.get(thread.id)
      // Settled is quiet (#1279): it alerts nothing, and it is seen afresh if it ever comes back.
      if (settled(thread)) { if (record) this.forget(thread.id, record); continue }
      const first = record === undefined
      if (!record) this.records.set(thread.id, record = { seen: publication, alerted: false })
      record.seen = publication
      const connected = thread.clientConnected !== false

      let requestId: string | undefined
      let permission = false
      for (const request of thread.requests) {
        const key = `${thread.id}/${request.id}`
        if (this.seenRequests.has(key)) continue
        this.seenRequests.add(key)
        if (first) continue
        requestId ??= request.id
        if (request.kind === 'permission') permission = true
      }
      if (requestId !== undefined && connected && thread.kind !== 'watcher-history') (asks ??= []).push({ thread, requestId, permission })

      if (thread.finishedUnread !== true) { record.alerted = false; this.cancel(record) }
      // A disconnect earns nothing, and a mark that was there across it is not replayed when it comes back.
      else if (first || !connected) { record.alerted = true; this.cancel(record) }
      else if (!record.alerted) (due ??= []).push({ thread, record })
    }
    for (const [id, record] of this.records) if (record.seen !== publication) this.forget(id, record)
    if (this.seenRequests.size > SEEN_REQUESTS_MAX) this.pruneRequests(threads)

    const delegations = delegated && (asks || due) ? this.delegations(threads, settled) : undefined
    for (const ask of asks ?? []) {
      try {
        if (this.options.shows(ask.thread.id)) continue
        // A delegated thread's request is named by its top-level thread, and opens its own pane (ADR-0081).
        this.options.emit(alertOf('needs-you', ask.thread, root(ask.thread, delegations).title,
          `${ask.thread.id}/request/${ask.requestId}`, ask.permission ? 'permission' : 'question'))
      } catch { /* one failing alert never stops the others */ }
    }
    if (!due) return
    const queued = queuedSends(state)
    for (const { thread, record } of due) {
      try {
        if (!this.finishes(thread, delegations, queued)) { this.cancel(record); continue }
        record.thread = thread
        if (record.timer !== undefined) continue
        // A delegated thread's answer reaches it as a hidden wake-up no publication shows, which can take longer (ADR-0081).
        const settle = delegations?.delegating.has(thread.id) ? ALERT_DELEGATION_SETTLE_MS : ALERT_SETTLE_MS
        record.timer = this.timers.set(() => this.fire(thread.id, record), settle)
      } catch { this.cancel(record) }
    }
  }

  /** Cancels every timer; later publications are ignored. */
  dispose(): void {
    this.disposed = true
    for (const record of this.records.values()) this.cancel(record)
    this.records.clear()
  }

  /**
   * The user's "completely finished": a finish of its own, not a stopped or failed turn, and nothing it started still running,
   * waiting on the user or queued to send. A delegated thread whose delegating thread is here, Watcher's own threads and a
   * thread Watcher keeps going never alert as finished: the finish that counts is the one above them.
   */
  private finishes(thread: AgentThread, delegations: Delegations | undefined, queued: ReadonlySet<string> | undefined): boolean {
    if (thread.kind === 'watcher' || thread.kind === 'watcher-history') return false
    if (thread.delegatedBy !== undefined && delegations?.byId.has(thread.delegatedBy)) return false
    if (thread.status === 'error' || thread.lastTurn?.status === 'failed' || thread.lastTurn?.status === 'interrupted') return false
    if (holds(thread, queued) || (delegations && descendantHolds(thread.id, delegations, queued))) return false
    return this.options.watched?.(thread.id) !== true
  }

  /** The settle delay ran out with the finish still due: every publication since rechecked it, so only the window can say no. */
  private fire(threadId: string, record: ThreadRecord): void {
    if (this.disposed || this.records.get(threadId) !== record || record.timer === undefined) return
    record.timer = undefined
    const thread = record.thread
    if (record.alerted || !thread) return
    try {
      if (this.options.watched?.(threadId) === true || this.options.shows(threadId)) return
      record.alerted = true
      this.options.emit(alertOf('finished', thread, thread.title, `${threadId}/finished/${this.run}-${++this.finished}`))
    } catch { /* a failing sink never breaks the tracker */ }
  }

  private cancel(record: ThreadRecord): void {
    if (record.timer !== undefined) this.timers.clear(record.timer)
    record.timer = undefined
    record.thread = undefined
  }

  private forget(threadId: string, record: ThreadRecord): void {
    this.cancel(record)
    this.records.delete(threadId)
  }

  private delegations(threads: readonly AgentThread[], settled: (thread: AgentThread) => boolean): Delegations {
    const byId = new Map<string, AgentThread>()
    const children = new Map<string, AgentThread[]>()
    const delegating = new Set<string>()
    for (const thread of threads) {
      byId.set(thread.id, thread)
      if (thread.delegatedBy === undefined) continue
      delegating.add(thread.delegatedBy)
      // A settled delegated thread holds nothing.
      if (settled(thread)) continue
      const siblings = children.get(thread.delegatedBy)
      if (siblings) siblings.push(thread)
      else children.set(thread.delegatedBy, [thread])
    }
    return { byId, children, delegating }
  }

  private pruneRequests(threads: readonly AgentThread[]): void {
    const present = new Set<string>()
    for (const thread of threads) for (const request of thread.requests) present.add(`${thread.id}/${request.id}`)
    for (const key of this.seenRequests) if (!present.has(key)) this.seenRequests.delete(key)
  }
}

/** Some thread down the thread's delegation chain (ADR-0081) holds as the thread itself would. Cycle safe. */
function descendantHolds(threadId: string, delegations: Delegations, queued: ReadonlySet<string> | undefined): boolean {
  if (!delegations.children.has(threadId)) return false
  const visited = new Set([threadId])
  const pending = [threadId]
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    for (const child of delegations.children.get(id) ?? []) {
      if (visited.has(child.id)) continue
      if (holds(child, queued)) return true
      visited.add(child.id)
      pending.push(child.id)
    }
  }
  return false
}

/** Threads with a send still on its way: queued or dispatching follow-ups (a wake-up too) and queued or submitting deliveries. */
function queuedSends(state: AlertState): ReadonlySet<string> | undefined {
  let queued: Set<string> | undefined
  for (const followup of state.followups ?? []) if (followup.status === 'queued' || followup.status === 'dispatching') (queued ??= new Set()).add(followup.threadId)
  for (const delivery of state.deliveries ?? []) if (delivery.status === 'queued' || delivery.status === 'submitting') (queued ??= new Set()).add(delivery.threadId)
  return queued
}
