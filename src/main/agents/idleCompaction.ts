import { capabilitiesForThread, type AgentHostSnapshot, type AgentThread } from '../../shared/agents'
import { compactionPending } from '../../shared/compaction'
import { isThreadClosed, isThreadTurnRunning, isWorkspaceThreadSettled } from '../../shared/threadActivity'

/** Idle this long, a large Claude thread is compacted while its one-hour prompt cache is still warm (ADR-0123). */
export const IDLE_COMPACTION_AFTER_MS = 54 * 60_000
/** Past this the cache has likely gone, so compacting would re-read the whole conversation it was meant to save. */
export const IDLE_COMPACTION_UNTIL_MS = 59 * 60_000
/** Smaller contexts cost less to re-read than a compaction and its summary do. */
export const IDLE_COMPACTION_MIN_CONTEXT = 100_000
const SWEEP_EVERY_MS = 30_000
/** Compactions under way at once, so a run of threads that went quiet together starts their CLIs a few at a time. */
const AT_ONCE = 2
/** A compaction no result has settled in this long gives its place up, so an unconfirmed one cannot hold it for good. */
const SETTLE_WITHIN_MS = 10 * 60_000

export interface IdleCompactionOptions {
  /** The coordinator: read for its threads, and asked to compact one as Sotto's own command. */
  readonly control: {
    /** Read without a copy: a sweep runs every thirty seconds over every thread. */
    hostView(): Readonly<AgentHostSnapshot>
    hasUserDraft(threadId: string): boolean
    hasPendingThreadWork(threadId: string): boolean
    compactIdleThread(threadId: string, guard: () => void): Promise<void>
  }
  /** The setting, read at every sweep, so turning it off stops the next compaction without a restart. */
  readonly enabled: () => boolean
  readonly now?: () => number
}

/**
 * Whether a thread is due for idle compaction now: a Claude project thread that can compact, holds at least
 * {@link IDLE_COMPACTION_MIN_CONTEXT} tokens of context, and last used it between 54 and 59 minutes ago, with nothing
 * running, waiting on the user or queued. Settled, archived and Watcher's own threads are left alone.
 */
export function idleCompactionDue(host: Readonly<AgentHostSnapshot>, thread: Readonly<AgentThread>, now: number): boolean {
  if (thread.providerId !== 'claude' || (thread.kind ?? 'project') !== 'project') return false
  if (!capabilitiesForThread(host as AgentHostSnapshot, thread as AgentThread).compact || thread.manualCompactionSupported === false || thread.nativeSessionStarted === false) return false
  if (isThreadClosed(thread) || isWorkspaceThreadSettled(thread, host.projects.find(project => project.id === thread.projectId))) return false
  if (isThreadTurnRunning(thread) || thread.status !== 'idle' || thread.requests.length || compactionPending(thread.compaction)) return false
  if (thread.backgroundWork?.length || thread.monitoring?.length) return false
  const usage = thread.usage
  if (!usage || (usage.contextUsed ?? 0) < IDLE_COMPACTION_MIN_CONTEXT) return false
  // A context measured on another model says nothing reliable about this one's cache.
  if (usage.modelId !== undefined && usage.modelId !== thread.modelId) return false
  const idle = now - Date.parse(usage.contextUpdatedAt ?? '')
  return idle >= IDLE_COMPACTION_AFTER_MS && idle < IDLE_COMPACTION_UNTIL_MS
}

/**
 * Idle compaction (ADR-0123). Claude keeps a thread's prompt cache for an hour after its last request; the first
 * message after that re-sends the whole conversation at twice the input price. While the setting is on, each sweep
 * compacts a due thread once per quiet stretch, through the same native compaction the user's Compact context runs,
 * so the next message re-reads a short summary instead. It saves nothing: a thread that has moved on, or a missed
 * window, is simply not due.
 */
export class IdleCompaction {
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | undefined
  /** The context time each thread was last compacted for, so one quiet stretch is compacted at most once. */
  private readonly tried = new Map<string, string>()
  /**
   * Compactions this sweep started, from the command until the thread shows its result. Claude accepts `/compact` long
   * before it finishes, so the command returning does not free the place: the thread's own compaction record does.
   */
  private readonly running = new Map<string, { readonly since: number; accepted: boolean; seenRunning: boolean }>()
  private stopped = false

  constructor(private readonly options: IdleCompactionOptions) {
    this.now = options.now ?? Date.now
  }

  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => this.sweep(), SWEEP_EVERY_MS)
    this.timer.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** One look at every thread. Returns the threads it started compacting, for tests. */
  sweep(): string[] {
    if (this.stopped || !this.options.enabled()) return []
    const started: string[] = []
    const threads = this.options.control.hostView().threads
    const live = new Set(threads.map(thread => thread.id))
    for (const id of this.tried.keys()) if (!live.has(id)) this.tried.delete(id)
    this.settle(threads)
    for (const thread of threads) {
      if (this.running.size >= AT_ONCE) break
      if (this.running.has(thread.id) || !this.due(thread.id)) continue
      const stretch = thread.usage!.contextUpdatedAt!
      if (this.tried.get(thread.id) === stretch) continue
      this.tried.set(thread.id, stretch)
      const run = { since: this.now(), accepted: false, seenRunning: false }
      this.running.set(thread.id, run)
      started.push(thread.id)
      // Asked again as the command dispatches: the user may have typed, settled or started a turn since this sweep. Not
      // the queue, which by then holds this compaction itself; a send of the user's admitted later waits behind it.
      const guard = (): void => {
        if (this.stopped || !this.options.enabled()) throw new Error('Idle compaction is off.')
        if (!this.due(thread.id, false) || this.options.control.hostView().threads.find(item => item.id === thread.id)?.usage?.contextUpdatedAt !== stretch) {
          throw new Error('This thread is no longer idle.')
        }
      }
      // A refusal or failure is the thread's own news, shown on it; this quiet stretch is not tried again.
      void this.options.control.compactIdleThread(thread.id, guard)
        .then(() => { run.accepted = true }, () => { if (this.running.get(thread.id) === run) this.running.delete(thread.id) })
    }
    return started
  }

  /**
   * Frees the place of each compaction the thread shows finished, or that has had its time. The context time it finished
   * on is the compaction's own, not a new quiet stretch: only the next turn starts one.
   */
  private settle(threads: readonly Readonly<AgentThread>[]): void {
    for (const [id, run] of this.running) {
      if (!run.accepted) continue
      const thread = threads.find(item => item.id === id)
      const pending = compactionPending(thread?.compaction)
      if (pending) run.seenRunning = true
      if ((pending || !run.seenRunning) && this.now() - run.since < SETTLE_WITHIN_MS) continue
      this.running.delete(id)
      const after = thread?.usage?.contextUpdatedAt
      if (after) this.tried.set(id, after)
    }
  }

  private due(threadId: string, queue = true): boolean {
    const host = this.options.control.hostView()
    const thread = host.threads.find(item => item.id === threadId)
    return thread !== undefined && idleCompactionDue(host, thread, this.now())
      && !this.options.control.hasUserDraft(threadId) && !(queue && this.options.control.hasPendingThreadWork(threadId))
  }
}
