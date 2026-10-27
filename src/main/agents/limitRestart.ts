import { join } from 'node:path'
import { z } from 'zod'
import { isThreadProviderConnected, type AgentHostSnapshot, type AgentThread, type ProviderId } from '../../shared/agents'
import {
  LIMIT_RESTART_GRACE_MS, LIMIT_RESTART_HORIZON_MS, LIMIT_RESTARTS_IN_A_ROW_MAX,
  type LimitRestartNews, type LimitStopReport, type ScheduledRestart,
} from '../../shared/limitRestart'
import { isThreadClosed, isThreadTurnRunning } from '../../shared/threadActivity'
import { AtomicJsonStore } from '../storage/atomicJsonStore'

const RECORDS_MAX = 500
/** What a client is told of a restart's time: the reset the provider gave, or now if that had passed, since the restart
 * goes a grace later and every surface names the time the stop itself named. */
const shownAt = (at: string): string => new Date(Date.parse(at) - LIMIT_RESTART_GRACE_MS).toISOString()
/** How long a restart that is due waits for its provider to connect before it looks again. */
export const LIMIT_RESTART_RETRY_MS = 60_000
/** The longest a timer can be set for; a reset further off is looked at again then. */
const TIMER_MAX_MS = 2_147_000_000

const recordSchema = z.object({
  threadId: z.string().min(1).max(512),
  provider: z.string().min(1).max(64),
  /** When the turn stopped at the limit, or when the first stop of its provider found it working in the background. */
  stoppedAt: z.iso.datetime(),
  /** When Sotto restarts it: the reset, plus the grace. Absent when the provider did not say, or said beyond the horizon. */
  at: z.iso.datetime().optional(),
  /** How many restarts in a row it has had: 0 until its first, and back to none once a turn of its own finishes. */
  restarts: z.number().int().min(0).max(LIMIT_RESTARTS_IN_A_ROW_MAX),
  /** Its restart note is in its queue: kept only to count the restarts in a row, and never published. */
  sent: z.literal(true).optional(),
}).strict()
const fileSchema = z.object({ version: z.literal(1), threads: z.array(recordSchema).max(RECORDS_MAX) }).strict()
type LimitRecord = z.infer<typeof recordSchema>
type LimitFile = z.infer<typeof fileSchema>

/** What the restart reads of the coordinator, by thread ID and without copying its state. */
export interface LimitRestartControl {
  /** The host's snapshot as the coordinator holds it, read only: its connection, providers and threads. */
  host(): AgentHostSnapshot
  thread(threadId: string): AgentThread | undefined
  /** Hands a thread its restart note, ahead of its own follow-ups; rejects when the thread takes nothing. */
  deliverWakeUp(threadId: string, news: LimitRestartNews, options: { readonly tool: boolean }): Promise<void>
}

export interface LimitRestartOptions {
  readonly directory: string
  readonly control: LimitRestartControl
  /** The setting, read at each stop and at each reset: off, nothing is scheduled and nothing is sent. */
  readonly enabled: () => boolean
  /** Watcher's own thread on this host, when it has one: its restart goes first. */
  readonly watcherThreadId?: () => string | undefined
  /** Which threads were restarted when one provider's limit reset, Watcher's first, for Watcher to hear. */
  readonly restarted?: (provider: ProviderId, threadIds: readonly string[]) => void
  /** Whether the thread has Sotto's pull request tools, for babysitting news its note may be folded with. */
  readonly tool?: (threadId: string) => boolean
  /** A gated thread keeps its saved record unchanged until the owning feature is available again. */
  readonly preservesDormantThread?: (threadId: string) => boolean
  readonly now?: () => number
  readonly schedule?: (callback: () => void, delay: number) => () => void
}

/**
 * Restarting threads a usage limit stopped (ADR-0144). The coordinator hands it each thread a change showed again: a turn
 * that ended at a usage limit (`lastTurn.limitStop`) is recorded, in `limit-restarts.json`, with when its provider said the
 * limit resets, and so is every thread of that provider whose background work was running when the first of them stopped.
 * One timer waits for the soonest reset. Then each thread still waiting, Watcher's first, is handed one note from Sotto as
 * a wake-up, and Watcher hears which. A thread that works again, or whose own turn finishes, needs no restart; one stopped
 * again by the limit after its restart is restarted again, at most three times in a row. It keeps thread IDs and times only.
 */
export class LimitRestart {
  private readonly store: AtomicJsonStore<LimitFile>
  private readonly records = new Map<string, LimitRecord>()
  /** Each record's restart as threads carry it, made once per record, so a thread is published with the same object. */
  private readonly shown = new Map<string, ScheduledRestart>()
  /** Each thread's last turn as the last read saw it: a stop is news only when it is a turn that was not there before. */
  private readonly turns = new Map<string, string>()
  private readonly delivering = new Set<string>()
  private readonly now: () => number
  private readonly schedule: NonNullable<LimitRestartOptions['schedule']>
  private cancelTimer: (() => void) | undefined
  private firing: Promise<void> | undefined
  private closed = false
  private saved = '[]'
  private writing: Promise<void> | undefined
  /** Told of each thread whose published restart moved, so a caller listing threads by what changed lists it again. */
  onMoved: ((threadId: string) => void) | undefined
  /** Told when a change came from the timer or a command rather than from a read, so the caller publishes it. */
  onChanged: (() => void) | undefined

  constructor(private readonly options: LimitRestartOptions) {
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? ((callback, delay) => { const timer = setTimeout(callback, delay); timer.unref?.(); return () => clearTimeout(timer) })
    this.store = new AtomicJsonStore(join(options.directory, 'limit-restarts.json'), input => fileSchema.parse(input), () => ({ version: 1, threads: [] }))
  }

  /** Reads what was scheduled before Sotto last closed, and sets the timer for it. */
  async start(): Promise<void> {
    const file = await this.store.read().catch(() => ({ version: 1 as const, threads: [] }))
    this.saved = JSON.stringify(file.threads)
    for (const record of file.threads) this.set(record)
    this.arm()
  }

  close(): Promise<void> {
    this.closed = true
    this.cancelTimer?.(); this.cancelTimer = undefined
    return this.writing ?? Promise.resolve()
  }

  /** Whether a restart note waiting in a queue may still go: the setting is on. */
  due(): boolean { return !this.closed && this.options.enabled() }

  /**
   * Reads the threads a change showed again, each as the snapshot shows it now, and the threads it no longer shows. Only
   * what a read can change is looked at here; every other thread is as the last read left it.
   */
  track(snapshot: Pick<AgentHostSnapshot, 'connected'>, threads: Iterable<AgentThread>, gone?: Iterable<string>): void {
    if (this.closed) return
    let changed = false
    for (const id of gone ?? []) {
      this.turns.delete(id)
      // A thread gone from a connected host was deleted: nothing will restart it.
      if (snapshot.connected && this.records.has(id) && !this.dormant(id) && !this.delivering.has(id)) { this.drop(id); changed = true }
    }
    for (const thread of threads) changed = this.read(thread) || changed
    if (changed) { this.save(); this.arm() }
  }

  /** Reads every thread the snapshot lists, and drops what is recorded for a thread a connected host no longer has. */
  trackAll(snapshot: Pick<AgentHostSnapshot, 'connected' | 'threads'>): void {
    if (this.closed) return
    let changed = false
    for (const thread of snapshot.threads) changed = this.read(thread) || changed
    if (snapshot.connected) for (const id of [...this.records.keys()]) {
      if (this.dormant(id) || this.delivering.has(id) || this.options.control.thread(id)) continue
      this.drop(id); changed = true
    }
    if (changed) { this.save(); this.arm() }
  }

  /** The thread as clients read it: with its scheduled restart while one stands, without one otherwise. */
  publish<T extends Pick<AgentThread, 'id' | 'scheduledRestart'>>(thread: T): T {
    const shown = this.shown.get(thread.id)
    if (shown) return thread.scheduledRestart === shown ? thread : { ...thread, scheduledRestart: shown }
    if (thread.scheduledRestart === undefined) return thread
    const { scheduledRestart: _restart, ...rest } = thread
    void _restart
    return rest as T
  }

  /** The user's Don't restart: the thread's restart goes, and it waits for them. True when one stood. */
  cancel(threadId: string): boolean {
    const record = this.records.get(threadId)
    if (!record || record.sent) return false
    this.drop(threadId)
    this.save(); this.arm()
    return true
  }

  /** The restart that stands for a thread, as clients read it. */
  scheduled(threadId: string): ScheduledRestart | undefined { return this.shown.get(threadId) }

  /** Settles until the restart under way, if any, has handed over its notes; for tests and for closing. */
  async settled(): Promise<void> { await this.firing }

  private dormant(threadId: string): boolean { return this.options.preservesDormantThread?.(threadId) === true }

  /** One thread read against the last read of it; true when its record changed. */
  private read(thread: AgentThread): boolean {
    if (this.dormant(thread.id)) return false
    const turn = thread.lastTurn, key = turn ? `${turn.status} ${turn.id}` : ''
    const before = this.turns.get(thread.id)
    this.turns.set(thread.id, key)
    // A thread first seen is where it was: a stop it already shows was recorded then, or was not this run's to record.
    if (turn?.status === 'failed' && turn.limitStop && thread.providerId && before !== undefined && before !== key) {
      return this.stopped(thread, { provider: thread.providerId, ...(turn.limitStop.resetsAt ? { resetsAt: turn.limitStop.resetsAt } : {}) })
    }
    const record = this.records.get(thread.id)
    if (!record || this.delivering.has(thread.id)) return false
    // Archived or closed by its provider: nothing restarts it.
    if (isThreadClosed(thread)) { this.drop(thread.id); return true }
    // A turn of the thread's own finished: it carried on, and its restarts in a row start again from none.
    if (turn?.status === 'completed' && !isThreadTurnRunning(thread) && before !== undefined && before !== key) { this.drop(thread.id); return true }
    // Before its restart, a turn running is someone else's: the user, Watcher or the provider carried it on.
    if (!record.sent && isThreadTurnRunning(thread)) { this.drop(thread.id); return true }
    // Before its restart, any other turn since the stop was someone's send, even one first seen already ended: the
    // thread is theirs now. A limit stop of that turn was recorded above, in this record's place.
    if (!record.sent && turn !== undefined && before !== undefined && before !== key) { this.drop(thread.id); return true }
    return false
  }

  /** A turn that stopped at its provider's usage limit; true when the record changed. */
  private stopped(thread: AgentThread, report: LimitStopReport): boolean {
    const previous = this.records.get(thread.id)
    if (!this.options.enabled()) return previous ? (this.drop(thread.id), true) : false
    const restarts = previous?.sent ? previous.restarts : 0
    // A thread stopped again after its last restart in a row waits for the user.
    if (restarts >= LIMIT_RESTARTS_IN_A_ROW_MAX) return previous ? (this.drop(thread.id), true) : false
    const now = this.now(), stoppedAt = new Date(now).toISOString()
    const reset = report.resetsAt === undefined ? Number.NaN : Date.parse(report.resetsAt)
    const due = Math.max(reset, now) + LIMIT_RESTART_GRACE_MS
    const at = Number.isFinite(reset) && due - now <= LIMIT_RESTART_HORIZON_MS ? new Date(due).toISOString() : undefined
    // The first stop of a provider's limit: its threads still working in the background were stopped by it too.
    const first = ![...this.records.values()].some(record => record.provider === report.provider && !record.sent)
    this.drop(thread.id)
    this.set({ threadId: thread.id, provider: report.provider, stoppedAt, ...(at ? { at } : {}), restarts })
    if (first) {
      for (const other of this.options.control.host().threads) {
        if (other.id === thread.id || other.providerId !== report.provider || this.records.has(other.id) || this.dormant(other.id)) continue
        if (!(other.backgroundWork?.length) || isThreadTurnRunning(other) || isThreadClosed(other)) continue
        this.set({ threadId: other.id, provider: report.provider, stoppedAt, ...(at ? { at } : {}), restarts: 0 })
      }
    }
    return true
  }

  private set(record: LimitRecord): void {
    this.records.delete(record.threadId)
    this.records.set(record.threadId, record)
    if (record.sent) { if (this.shown.delete(record.threadId)) this.onMoved?.(record.threadId) }
    else {
      this.shown.set(record.threadId, Object.freeze({ provider: record.provider, stoppedAt: record.stoppedAt, ...(record.at ? { at: shownAt(record.at) } : {}) }))
      this.onMoved?.(record.threadId)
    }
  }

  private drop(threadId: string): void {
    this.records.delete(threadId)
    if (this.shown.delete(threadId)) this.onMoved?.(threadId)
  }

  /** One timer, for the soonest restart due; none while nothing is scheduled. */
  private arm(delay?: number): void {
    this.cancelTimer?.(); this.cancelTimer = undefined
    if (this.closed) return
    let soonest = Number.POSITIVE_INFINITY
    for (const record of this.records.values()) {
      if (record.sent || record.at === undefined || this.dormant(record.threadId)) continue
      soonest = Math.min(soonest, Date.parse(record.at))
    }
    if (!Number.isFinite(soonest)) return
    const wait = delay ?? Math.min(Math.max(0, soonest - this.now()), TIMER_MAX_MS)
    this.cancelTimer = this.schedule(() => { this.cancelTimer = undefined; this.fire() }, wait)
  }

  private fire(): void {
    if (this.closed || this.firing) return
    this.firing = this.restartDue().finally(() => { this.firing = undefined; this.save(); if (!this.cancelTimer) this.arm() })
  }

  /** Restarts every thread whose reset has come, one provider at a time, Watcher's first and the rest in the order they stopped. */
  private async restartDue(): Promise<void> {
    const now = this.now()
    const due = [...this.records.values()].filter(record => !record.sent && record.at !== undefined && Date.parse(record.at) <= now && !this.dormant(record.threadId))
    if (!due.length) return
    if (!this.options.enabled()) {
      // The setting went off: nothing scheduled is sent, and the threads wait for the user.
      for (const record of due) this.drop(record.threadId)
      this.onChanged?.()
      return
    }
    let waiting = false
    const watcher = this.options.watcherThreadId?.()
    for (const provider of [...new Set(due.map(record => record.provider))]) {
      const host = this.options.control.host()
      // A host that lists no providers is connected as a whole, as `isThreadProviderConnected` reads it.
      if (!host.connected || host.providers && !host.providers.some(item => item.id === provider && item.connection === 'connected')) { waiting = true; continue }
      const ordered = due.filter(record => record.provider === provider)
        .sort((left, right) => Number(right.threadId === watcher) - Number(left.threadId === watcher) || Date.parse(left.stoppedAt) - Date.parse(right.stoppedAt))
      const restarted: string[] = []
      for (const record of ordered) {
        if (this.closed || this.records.get(record.threadId) !== record) continue
        const thread = this.options.control.thread(record.threadId)
        if (!thread || isThreadClosed(thread) || isThreadTurnRunning(thread)) { this.drop(record.threadId); continue }
        if (!isThreadProviderConnected(this.options.control.host(), thread)) { waiting = true; continue }
        const news: LimitRestartNews = { source: 'limit-restart', provider, since: record.stoppedAt, restarts: record.restarts + 1 }
        this.delivering.add(record.threadId)
        try {
          await this.options.control.deliverWakeUp(record.threadId, news, { tool: this.options.tool?.(record.threadId) ?? false })
          if (this.records.get(record.threadId) === record) {
            this.set({ threadId: record.threadId, provider, stoppedAt: record.stoppedAt, restarts: news.restarts, sent: true })
            // Saved at once: a start that read it unsent would queue the note a second time.
            this.save()
            restarted.push(record.threadId)
          }
        } catch {
          // Nothing was queued: the thread went, was settled or works again. Either way nothing restarts it now.
          if (this.records.get(record.threadId) === record) this.drop(record.threadId)
        } finally { this.delivering.delete(record.threadId) }
      }
      if (restarted.length) this.options.restarted?.(provider as ProviderId, restarted)
    }
    this.onChanged?.()
    if (waiting && !this.closed) this.arm(LIMIT_RESTART_RETRY_MS)
  }

  /** Dormant records keep their places in the bound; the newest ordinary records fill what remains. */
  private savedRecords(): LimitRecord[] {
    const records = [...this.records.values()]
    const dormant = new Set(records.filter(record => this.dormant(record.threadId)))
    const room = RECORDS_MAX - dormant.size
    const ordinary = room > 0 ? records.filter(record => !dormant.has(record)).slice(-room) : []
    const kept = new Set([...dormant, ...ordinary])
    return records.filter(record => kept.has(record))
  }

  private save(): void {
    const threads = this.savedRecords()
    const next = JSON.stringify(threads)
    if (next === this.saved) return
    this.saved = next
    // A write that fails is tried again at the next change.
    this.writing = this.store.writeLatest(() => ({ version: 1, threads: this.savedRecords() })).catch(() => { this.saved = '' })
  }
}
