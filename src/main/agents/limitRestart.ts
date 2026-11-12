import { join } from 'node:path'
import { z } from 'zod'
import { isThreadProviderConnected, type AgentHostSnapshot, type AgentThread, type ProviderId } from '../../shared/agents'
import {
  LIMIT_RESTART_GRACE_MS, LIMIT_RESTART_HORIZON_MS, LIMIT_RESTARTS_IN_A_ROW_MAX,
  type LimitRestartNews, type LimitStopReport, type ScheduledRestart,
} from '../../shared/limitRestart'
import { isThreadClosed, isThreadTurnRunning } from '../../shared/threadActivity'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { watcherBackgroundWorkCount } from './watcherWakeUp'

const RECORDS_MAX = 500
/** What a client is told of a restart's time: the reset the provider gave, or now if that had passed, since the restart
 * goes a grace later and every surface names the time the stop itself named. */
const shownAt = (at: string): string => new Date(Date.parse(at) - LIMIT_RESTART_GRACE_MS).toISOString()
/** How long Watcher waits to hear of watched threads restarted for work left after the last of them, so it hears them together. */
export const LIMIT_RESTART_REPORT_MS = 15_000
/** How long a restart that is due waits for its provider to connect before it looks again. */
export const LIMIT_RESTART_RETRY_MS = 60_000
/**
 * The longest one wait lasts before the wall clock is read again. A timer's wait does not count time the computer slept,
 * so a Mac asleep past a reset would otherwise restart late by however long it slept; this bounds that to a minute.
 */
export const LIMIT_RESTART_CHECK_MS = 60_000

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
  /** A watched thread whose last turn stopped with work left, restarted at once rather than at a reset (#2234). */
  cause: z.literal('work-left').optional(),
  /**
   * The thread's last turn when it was recorded: the turn the limit stopped, or the turn a thread working in the background
   * rested on. A later turn is someone's send, even one first read after Sotto starts again. Absent from older records.
   */
  turnId: z.string().min(1).max(512).optional(),
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
  /**
   * Which threads were restarted when one provider's limit reset, Watcher's first, for Watcher to hear; and, with `cause`,
   * which watched threads were restarted for work left (#2234), told together a little after the last of them.
   */
  readonly restarted?: (provider: ProviderId, threadIds: readonly string[], cause?: 'work-left') => void
  /**
   * Watcher's watched threads on this host (#2234): one whose last turn stopped with work left is restarted once this run
   * first reads that turn, and when Watcher's own limit resets. Absent while Watcher is off: nothing is recovered.
   */
  readonly watched?: () => Iterable<string> | undefined
  /** Whether a thread waits on something that goes by itself or on the user: its follow-up queue holds anything, or the
   * resume note of ADR-0076 is on its way to it. Such a thread is not restarted for work left. */
  readonly waiting?: (threadId: string) => boolean
  /** Whether the thread has Sotto's pull request tools, for babysitting news its note may be folded with. */
  readonly tool?: (threadId: string) => boolean
  /** A gated thread keeps its saved record unchanged until the owning feature is available again. */
  readonly preservesDormantThread?: (threadId: string) => boolean
  readonly now?: () => number
  readonly schedule?: (callback: () => void, delay: number) => () => void
  /** The longest one wait lasts before the clock is read again; `LIMIT_RESTART_CHECK_MS` unless a test sets it. */
  readonly checkEveryMs?: number
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
  /** Threads whose first turn this run has read, for the work-left check after a start (#2234). */
  private readonly startRead = new Set<string>()
  /** Watched threads restarted for work left and not yet told to Watcher, by provider, and the timer that tells them. */
  private readonly unreported = new Map<string, string[]>()
  private cancelReport: (() => void) | undefined
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
    this.cancelReport?.(); this.cancelReport = undefined
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
    const watched = this.watchedOnce()
    for (const id of gone ?? []) {
      this.turns.delete(id)
      // A thread gone from a connected host was deleted: nothing will restart it.
      if (snapshot.connected && this.records.has(id) && !this.dormant(id) && !this.delivering.has(id)) { this.drop(id); changed = true }
    }
    for (const thread of threads) changed = this.read(thread, watched) || changed
    if (changed) { this.save(); this.arm() }
  }

  /** Reads every thread the snapshot lists, and drops what is recorded for a thread a connected host no longer has. */
  trackAll(snapshot: Pick<AgentHostSnapshot, 'connected' | 'threads'>): void {
    if (this.closed) return
    let changed = false
    const watched = this.watchedOnce()
    for (const thread of snapshot.threads) changed = this.read(thread, watched) || changed
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

  /**
   * The watched set, asked at most once for a read of many threads, and only when a thread there needs it. Undefined
   * while it cannot be known yet, as before this computer's host ID is back.
   */
  private watchedOnce(): () => ReadonlySet<string> | undefined {
    let watched: ReadonlySet<string> | undefined, asked = false
    return () => {
      if (!asked) { asked = true; const ids = this.options.watched?.(); watched = ids === undefined ? undefined : new Set(ids) }
      return watched
    }
  }

  /** One thread read against the last read of it; true when its record changed. */
  private read(thread: AgentThread, watched?: () => ReadonlySet<string> | undefined): boolean {
    if (this.dormant(thread.id)) return false
    // The first turn this run reads of a watched thread: one that stopped with work left is restarted now (#2234). It is
    // decided once the watched set is known and the thread's provider is connected, and only once.
    if (this.options.watched && thread.lastTurn && !this.startRead.has(thread.id) && (!thread.historyStatus || thread.historyStatus === 'ready')) {
      const set = thread.lastTurn.status === 'failed' ? watched?.() : undefined
      if (thread.lastTurn.status !== 'failed') this.startRead.add(thread.id)
      else if (set !== undefined && isThreadProviderConnected(this.options.control.host(), thread)) {
        this.startRead.add(thread.id)
        if (set.has(thread.id) && this.workLeft(thread)) {
          this.turns.set(thread.id, `${thread.lastTurn.status} ${thread.lastTurn.id}`)
          return this.recover(thread)
        }
      }
    }
    // An earlier Watcher conversation is read only: it cannot receive a restart or the user's next send.
    if (thread.kind === 'watcher-history') {
      if (!this.records.has(thread.id)) return false
      this.drop(thread.id)
      return true
    }
    const turn = thread.lastTurn, key = turn ? `${turn.status} ${turn.id}` : ''
    const before = this.turns.get(thread.id)
    this.turns.set(thread.id, key)
    // Settled or archived threads cannot restart, even when this update also reports a new limit stop.
    if (isThreadClosed(thread)) {
      // A send in flight needs its record until its result is saved and the restart reported.
      if (!this.records.has(thread.id) || this.delivering.has(thread.id)) return false
      this.drop(thread.id)
      return true
    }
    // A thread first seen is where it was: a stop it already shows was recorded then, or was not this run's to record.
    if (turn?.status === 'failed' && turn.limitStop && thread.providerId && before !== undefined && before !== key) {
      return this.stopped(thread, { provider: thread.providerId, ...(turn.limitStop.resetsAt ? { resetsAt: turn.limitStop.resetsAt } : {}) })
    }
    // A turn of a provider finished after its limit stopped threads it gave no reset for: the limit has reset, so they
    // wait for the user's next message with nothing saying Sotto can't restart them (November 9, 2026).
    const finished = turn?.status === 'completed' && !isThreadTurnRunning(thread) && before !== undefined && before !== key
    const unsaid = finished && thread.providerId ? this.dropUnsaid(thread.providerId, thread.id) : false
    const record = this.records.get(thread.id)
    if (!record || this.delivering.has(thread.id)) return unsaid
    // Before its restart, a turn other than the one recorded is someone's send, even one first read after a start. A thread
    // read with no turn at all, as Claude Code's are before their history loads, says nothing either way.
    if (!record.sent && turn !== undefined && (record.turnId !== undefined ? turn.id !== record.turnId
      // A record from an older build names no turn: one with no reset, first read with a turn that is not a limit's stop, is
      // the card that outlived its reason, so it goes too (November 9, 2026).
      : record.at === undefined && !before && !(turn.status === 'failed' && turn.limitStop))) { this.drop(thread.id); return true }
    // A turn of the thread's own finished: it carried on, and its restarts in a row start again from none.
    if (finished) { this.drop(thread.id); return true }
    // Before its restart, a turn running is someone else's: the user, Watcher or the provider carried it on.
    if (!record.sent && isThreadTurnRunning(thread)) { this.drop(thread.id); return true }
    // Before its restart, any other turn since the stop was someone's send, even one first seen already ended: the
    // thread is theirs now. A limit stop of that turn was recorded above, in this record's place.
    if (!record.sent && turn !== undefined && before !== undefined && before !== key) { this.drop(thread.id); return true }
    return unsaid
  }

  /** Drops every thread of a provider waiting on a limit that gave no reset, but one; true when any went. */
  private dropUnsaid(provider: string, except: string): boolean {
    let dropped = false
    // Deleting the entry being visited leaves a Map's iteration on course, so nothing is copied.
    for (const record of this.records.values()) {
      if (record.provider !== provider || record.threadId === except || record.at !== undefined || record.sent || record.cause !== undefined) continue
      if (this.dormant(record.threadId) || this.delivering.has(record.threadId)) continue
      this.drop(record.threadId); dropped = true
    }
    return dropped
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
    // The first stop of a provider's limit: its threads still working in the background were stopped by it too. A run a
    // thread detached is not the provider's work, and a limit stop does not end it (#2476).
    const first = ![...this.records.values()].some(record => record.provider === report.provider && !record.sent && record.cause === undefined)
    this.drop(thread.id)
    this.set({ threadId: thread.id, provider: report.provider, stoppedAt, ...(at ? { at } : {}), restarts, ...thread.lastTurn ? { turnId: thread.lastTurn.id } : {} })
    if (first) {
      for (const other of this.options.control.host().threads) {
        if (other.id === thread.id || other.providerId !== report.provider || this.records.has(other.id) || this.dormant(other.id)) continue
        if (other.kind === 'watcher-history' || !other.backgroundWork?.some(work => work.type !== 'detached-run') || isThreadTurnRunning(other) || isThreadClosed(other)) continue
        this.set({ threadId: other.id, provider: report.provider, stoppedAt, ...(at ? { at } : {}), restarts: 0, ...other.lastTurn ? { turnId: other.lastTurn.id } : {} })
      }
    }
    return true
  }

  /**
   * Whether a watched thread stopped with work left (ADR-0144, November 5, 2026 amendment): its last turn ended with an
   * error before it finished, nothing runs in it, not even background work, nothing waits on the user, not even a
   * prototype for review, nothing goes by itself, and its provider is
   * connected. A turn the user stopped finished as they chose. A turn a usage limit stopped is the limit restart's, until
   * its reset has passed; a limit that named no reset waits for the user, as decision 3 says. Watcher's own thread is the
   * hold's (#2234), and Watcher hears its other news when the hold ends.
   */
  private workLeft(thread: AgentThread): boolean {
    const turn = thread.lastTurn
    if (turn?.status !== 'failed' || thread.kind === 'watcher-history' || thread.id === this.options.watcherThreadId?.()) return false
    // A card or a prototype waiting for review waits on the user; background work, monitoring or a subagent still runs in it.
    if (isThreadClosed(thread) || isThreadTurnRunning(thread) || thread.requests.length > 0 || thread.prototypeReady !== undefined || this.dormant(thread.id)) return false
    if (watcherBackgroundWorkCount(thread) > 0) return false
    if (thread.historyStatus !== undefined && thread.historyStatus !== 'ready') return false
    if (turn.limitStop && (turn.limitStop.resetsAt === undefined || Date.parse(turn.limitStop.resetsAt) + LIMIT_RESTART_GRACE_MS > this.now())) return false
    if (this.options.waiting?.(thread.id) === true) return false
    const record = this.records.get(thread.id)
    // Already scheduled, or its note is on its way; one sent counts toward three in a row.
    if (record && !record.sent || this.delivering.has(thread.id)) return false
    if (record?.sent && record.restarts >= LIMIT_RESTARTS_IN_A_ROW_MAX) return false
    return isThreadProviderConnected(this.options.control.host(), thread)
  }

  /** Records a watched thread with work left for a restart now; true when the record changed. */
  private recover(thread: AgentThread): boolean {
    if (!this.options.enabled() || !thread.providerId) return false
    const previous = this.records.get(thread.id), restarts = previous?.sent ? previous.restarts : 0
    const now = new Date(this.now()).toISOString()
    this.drop(thread.id)
    this.set({ threadId: thread.id, provider: thread.providerId, stoppedAt: now, at: now, restarts, cause: 'work-left' })
    return true
  }

  /**
   * Watcher's own limit reset (#2234): every watched thread whose last turn stopped with work left while Watcher could not
   * hear it is restarted too, so Watcher comes back to its threads going again.
   */
  private recoverWatched(): boolean {
    let changed = false
    for (const id of this.options.watched?.() ?? []) {
      const thread = this.options.control.thread(id)
      if (thread && this.workLeft(thread)) changed = this.recover(thread) || changed
    }
    return changed
  }

  /** Tells Watcher of the watched threads restarted for work left together, a little after the last of them. */
  private report(provider: string, threadIds: readonly string[]): void {
    this.unreported.set(provider, [...this.unreported.get(provider) ?? [], ...threadIds])
    this.cancelReport?.()
    this.cancelReport = this.schedule(() => {
      this.cancelReport = undefined
      const told = [...this.unreported]
      this.unreported.clear()
      if (this.closed) return
      for (const [provider, ids] of told) this.options.restarted?.(provider as ProviderId, ids, 'work-left')
    }, LIMIT_RESTART_REPORT_MS)
  }

  private set(record: LimitRecord): void {
    this.records.delete(record.threadId)
    this.records.set(record.threadId, record)
    // A restart for work left goes at once, so no surface says it is scheduled (#2234).
    if (record.sent || record.cause === 'work-left') { if (this.shown.delete(record.threadId)) this.onMoved?.(record.threadId) }
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
    const wait = delay ?? Math.min(Math.max(0, soonest - this.now()), this.options.checkEveryMs ?? LIMIT_RESTART_CHECK_MS)
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
    let waiting = false, watcherBack = false
    const watcher = this.options.watcherThreadId?.()
    for (const provider of [...new Set(due.map(record => record.provider))]) {
      const host = this.options.control.host()
      // A host that lists no providers is connected as a whole, as `isThreadProviderConnected` reads it.
      if (!host.connected || host.providers && !host.providers.some(item => item.id === provider && item.connection === 'connected')) { waiting = true; continue }
      const ordered = due.filter(record => record.provider === provider)
        .sort((left, right) => Number(right.threadId === watcher) - Number(left.threadId === watcher) || Date.parse(left.stoppedAt) - Date.parse(right.stoppedAt))
      const restarted: string[] = [], recovered: string[] = []
      for (const record of ordered) {
        if (this.closed || this.records.get(record.threadId) !== record) continue
        const thread = this.options.control.thread(record.threadId)
        if (!thread || isThreadClosed(thread) || isThreadTurnRunning(thread)) { this.drop(record.threadId); continue }
        if (!isThreadProviderConnected(this.options.control.host(), thread)) { waiting = true; continue }
        const news: LimitRestartNews = { source: 'limit-restart', provider, since: record.stoppedAt, restarts: record.restarts + 1, ...record.cause ? { cause: record.cause } : {} }
        this.delivering.add(record.threadId)
        try {
          await this.options.control.deliverWakeUp(record.threadId, news, { tool: this.options.tool?.(record.threadId) ?? false })
          if (this.records.get(record.threadId) === record) {
            this.set({ threadId: record.threadId, provider, stoppedAt: record.stoppedAt, restarts: news.restarts, sent: true, ...record.cause ? { cause: record.cause } : {} })
            // Saved at once: a start that read it unsent would queue the note a second time.
            this.save()
            if (record.cause === 'work-left') recovered.push(record.threadId)
            else { restarted.push(record.threadId); if (record.threadId === watcher) watcherBack = true }
          }
        } catch {
          // Nothing was queued: the thread went, was settled or works again. Either way nothing restarts it now.
          if (this.records.get(record.threadId) === record) this.drop(record.threadId)
        } finally { this.delivering.delete(record.threadId) }
      }
      if (restarted.length) this.options.restarted?.(provider as ProviderId, restarted)
      if (recovered.length) this.report(provider, recovered)
    }
    // Watcher's own limit reset: the watched threads that stopped with work left while it could not hear go again too (#2234).
    if (watcherBack && !this.closed) this.recoverWatched()
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
