import type { AgentThread } from '../../shared/agents'
import { LIMIT_RESTART_GRACE_MS, LIMIT_RESTART_HORIZON_MS, type ScheduledRestart } from '../../shared/limitRestart'
import { isThreadTurnRunning } from '../../shared/threadActivity'
import { failedTurnReason } from '../../shared/threadFailures'
import { WATCHER_FAILING_RETRY_MS, WATCHER_HOLD_DETAIL_MAX, type WatcherHold } from '../../shared/watcherHold'

/** The part of Watcher's thread the hold reads. */
export type WatcherHoldThread = Pick<AgentThread, 'id' | 'providerId' | 'lastTurn' | 'activities' | 'status'>

/** One run of failed turns of Watcher's, from the first Sotto saw until a turn finishes. */
interface Failure {
  readonly threadId: string
  /** The newest failed turn's ID. */
  turnId: string
  kind: 'limited' | 'failing'
  provider: string
  readonly since: number
  /** When the limit resets, for a limited hold whose provider said. */
  resetsAt: number | undefined
  /** When what is held may go, for a failing hold or a limited one with no reset time. */
  nextTryAt: number | undefined
  lastTryAt: number | undefined
  tries: number
  detail: string | undefined
  /** How many reads have looked for the error, so a failure with none recorded stops asking after a few. */
  detailAsked: number
}
/** How many reads look for a failure's error before the band goes without Details. */
const DETAIL_READS_MAX = 5

/**
 * Whether Watcher's own provider is limited or failing, read from Watcher's thread (ADR-0144, November 5, 2026
 * amendment, #2234). A turn of Watcher's that stops at its usage limit holds news until the reset: the reset the limit
 * restart scheduled for Watcher's thread, which a restart of Sotto keeps, or the one its stop named. Any other failed turn
 * holds news for WATCHER_FAILING_RETRY_MS, then lets what waits go as one try; one that fails again holds again. A turn
 * that finishes ends the hold. A failed turn Watcher already rested on when Sotto started holds nothing unless a limit
 * restart is scheduled for it: Sotto's own close fails a running turn, and its resume note must not wait.
 *
 * It holds identities and times only, never the conversation's words. The error under Details is the failed turn's
 * error as its adapter worded it.
 */
export class WatcherHoldState {
  private failure: Failure | undefined
  /** Watcher's thread's newest turn, by thread, as the last read saw it: a failure is new only when its turn was not. */
  private lastSeen: { readonly threadId: string; readonly turn: string; readonly running: boolean } | undefined
  private reason: (() => string | undefined) | undefined

  /**
   * Reads Watcher's thread as it is now; true when the hold changed in a way the room shows. `scheduled` is the limit
   * restart standing for the thread, when one does; `reason` the failure record's reason, for a snapshot without activities.
   */
  read(thread: WatcherHoldThread | undefined, scheduled: ScheduledRestart | undefined, now: number, reason?: () => string | undefined): boolean {
    const before = this.failure && this.key(this.failure)
    this.reason = reason
    this.update(thread, scheduled, now)
    return (this.failure && this.key(this.failure)) !== before
  }

  /** The hold as the room shows it, with the held news counted by the caller; undefined while nothing holds Watcher. */
  shown(held: { readonly count: number; readonly pullRequests: number }): WatcherHold | undefined {
    const failure = this.failure
    if (!failure) return undefined
    const iso = (at: number | undefined) => at === undefined ? undefined : new Date(at).toISOString()
    const resetsAt = iso(failure.resetsAt), nextTryAt = iso(failure.nextTryAt), lastTryAt = iso(failure.lastTryAt)
    return { kind: failure.kind, provider: failure.provider, since: new Date(failure.since).toISOString(),
      ...resetsAt ? { resetsAt } : {}, ...nextTryAt ? { nextTryAt } : {}, ...lastTryAt ? { lastTryAt } : {},
      tries: failure.tries, held: held.count, pullRequests: held.pullRequests, ...failure.detail ? { detail: failure.detail } : {} }
  }

  /** Whether news and what is queued for Watcher wait now. */
  holds(now: number): boolean {
    const until = this.until()
    return until !== undefined && now < until
  }

  /** When the hold lets what waits go, while it holds; undefined otherwise. */
  until(): number | undefined {
    const failure = this.failure
    if (!failure) return undefined
    return failure.resetsAt !== undefined ? failure.resetsAt + LIMIT_RESTART_GRACE_MS : failure.nextTryAt
  }

  /** Watcher's thread, while a hold stands for it. */
  threadId(): string | undefined { return this.failure?.threadId }

  /**
   * Try now: what is held goes at once. Only a failing hold, or a limited one with no reset time, can be tried; a limit
   * with a reset waits for it. True when the hold changed.
   */
  tryNow(now: number): boolean {
    const failure = this.failure
    if (!failure || failure.resetsAt !== undefined || failure.nextTryAt === undefined || failure.nextTryAt <= now) return false
    failure.nextTryAt = now
    return true
  }

  /** The failed turn's error: from its record when the thread carries it, else from the failure record. */
  private detail(thread: WatcherHoldThread): string | undefined {
    return failedTurnDetail(thread) ?? this.reason?.()?.trim().slice(0, WATCHER_HOLD_DETAIL_MAX) ?? undefined
  }

  private key(failure: Failure): string {
    return JSON.stringify([failure.threadId, failure.turnId, failure.kind, failure.provider, failure.resetsAt, failure.nextTryAt, failure.tries, failure.detail])
  }

  private update(thread: WatcherHoldThread | undefined, scheduled: ScheduledRestart | undefined, now: number): void {
    if (!thread) { this.failure = undefined; this.lastSeen = undefined; return }
    const turn = thread.lastTurn, key = turn ? `${turn.status} ${turn.id}` : ''
    const seen = this.lastSeen?.threadId === thread.id ? this.lastSeen : undefined
    const working = isThreadTurnRunning(thread) || turn?.status === 'running'
    this.lastSeen = { threadId: thread.id, turn: key, running: working }
    if (this.failure && this.failure.threadId !== thread.id) this.failure = undefined
    // A limit whose reset has come holds nothing more: its restart goes, and Watcher reads what was held.
    if (this.failure?.resetsAt !== undefined && this.failure.resetsAt + LIMIT_RESTART_GRACE_MS <= now) this.failure = undefined
    // A turn running is a try under way, or the user's: the hold stands until it ends, and goes if it finishes.
    if (working) return
    if (turn?.status !== 'failed') { this.failure = undefined; return }
    const at = scheduled?.at ?? turn.limitStop?.resetsAt
    const parsed = at === undefined ? Number.NaN : Date.parse(at)
    // A limit whose reset has come holds nothing: the reset came, and its restart goes.
    if (Number.isFinite(parsed) && parsed + LIMIT_RESTART_GRACE_MS <= now) { this.failure = undefined; return }
    // A reset further away than the horizon is not believed, as the limit restart does not believe it: tried every few minutes.
    const reset = Number.isFinite(parsed) && parsed - now <= LIMIT_RESTART_HORIZON_MS ? parsed : undefined
    const limited = turn.limitStop !== undefined || scheduled !== undefined
    const provider = scheduled?.provider ?? thread.providerId ?? 'unknown'
    const current = this.failure
    if (current?.turnId === turn.id) {
      // The same failure: a limit restart scheduled since may name the reset.
      if (current.resetsAt === undefined && reset !== undefined) { current.kind = 'limited'; current.resetsAt = reset; current.nextTryAt = undefined }
      if (current.detail === undefined && current.detailAsked < DETAIL_READS_MAX) { current.detailAsked++; current.detail = this.detail(thread) }
      return
    }
    // A failure Watcher rested on when this run first read its turns is the last run's, which Sotto's own close may have
    // made: only a limit holds for it, scheduled or named on its stop. A failure is new when this run saw Watcher working,
    // or another turn there.
    if (!current && !limited && (seen === undefined || !seen.running && (seen.turn === '' || seen.turn === key))) return
    this.failure = { threadId: thread.id, turnId: turn.id, kind: limited ? 'limited' : 'failing', provider,
      since: current?.since ?? now, resetsAt: reset, nextTryAt: reset === undefined ? now + WATCHER_FAILING_RETRY_MS : undefined,
      lastTryAt: current ? now : undefined, tries: current ? current.tries + 1 : 0, detail: this.detail(thread), detailAsked: 1 }
  }
}

/** The failed turn's error, as its adapter worded it, cut to what Details carries. */
function failedTurnDetail(thread: Pick<WatcherHoldThread, 'activities' | 'lastTurn'>): string | undefined {
  return failedTurnReason(thread)?.trim().slice(0, WATCHER_HOLD_DETAIL_MAX) || undefined
}
