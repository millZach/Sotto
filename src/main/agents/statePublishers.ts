import type { AgentState, AgentThreadDetailUpdate } from '../../shared/agents'
import { isAgentThreadDetailDelta, mergeAgentThreadDetailUpdates } from '../../shared/agentThreadDetail'

/**
 * One broadcast per animation frame. Below what a person can see, so no state looks late, and
 * far fewer full copies of every thread's history than a streaming provider would otherwise force.
 */
export const AGENT_STATE_BROADCAST_INTERVAL_MS = 16

/**
 * A provider frame publishes the whole agent state, and Claude emits dozens of frames a
 * second, so the renderer and the widget each revalidate every thread's history that often.
 * 50ms caps that at 20 sends a second, plus one just ahead of each detail that brings a message's first
 * words (`beforeOpening` on the detail coalescer): still faster than the ~100ms a person reads as instant, and
 * the first state of a burst is never held back at all.
 */
export const AGENT_STATE_PUBLISH_INTERVAL_MS = 50
/** Schedules a deferred run and returns its cancel; injectable so tests own the clock. */
export type PublishScheduler = (run: () => void, ms: number) => () => void
export interface CoalescedAgentStatePublisher<State extends object = AgentState> {
  publish(state: State): void
  /** Deliver a held state now, for a caller that must not wait out the interval. */
  flush(): void
  dispose(): void
}
export const realPublishScheduler: PublishScheduler = (run, ms) => {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}
/**
 * Coalesces agent-state sends at the IPC boundary rather than inside AgentControl, so
 * in-process listeners (the checkpoint observer) still see every intermediate state and
 * command responses still carry the exact state their command produced.
 */
export function coalesceAgentStatePublishes<State extends object = AgentState>(send: (state: State) => void,
  options: { intervalMs?: number; schedule?: PublishScheduler } = {}): CoalescedAgentStatePublisher<State> {
  const intervalMs = options.intervalMs ?? AGENT_STATE_PUBLISH_INTERVAL_MS
  const schedule = options.schedule ?? realPublishScheduler
  let cancel: (() => void) | null = null
  let pending: State | null = null
  let disposed = false
  const sendNow = (state: State): void => {
    cancel?.()
    pending = null
    send(state)
    // Keep the window open after every send: a burst that continues must coalesce, and the
    // last state of one always reaches the renderer on this trailing run.
    cancel = schedule(() => { cancel = null; if (pending) sendNow(pending) }, intervalMs)
  }
  return {
    publish: state => {
      if (disposed) return
      // Only the newest state survives an open window, so no stale state follows a newer one.
      if (cancel) pending = state
      else sendNow(state)
    },
    flush: () => { if (!disposed && pending) sendNow(pending) },
    dispose: () => { disposed = true; cancel?.(); cancel = null; pending = null },
  }
}

export interface CoalescedThreadDetailPublisher {
  publish(update: AgentThreadDetailUpdate): void
  dispose(): void
}
/**
 * The same coalescing at the IPC boundary as the shell, but per thread: two threads streaming at once
 * must not hold each other's history back, and only the newest revision of each one reaches the window.
 *
 * A delta cannot simply be dropped the way a whole detail can — the window applies it to the revision it
 * holds — so a lane folds what is waiting into one update where it can (two appends to one message become
 * one) and keeps them in order where it cannot. Whole details still supersede everything before them.
 * A lane that goes quiet is dropped; the next update opens a fresh one.
 *
 * An opening change, an update that brings a message or an activity record this thread's lanes have not sent
 * yet, is not held either: it goes at once, with whatever was waiting ahead of it, and starts a fresh window. The
 * echo of a prompt often starts a window just before the reply's first words, and those words are what the person
 * is waiting to see. Later chunks of a message already sent coalesce as before. As in the workspace and the
 * adapters ahead of it, only one opening change may cut a lane's window short, and the window after a trailing
 * send that carried one held back lets none through, so a steady run of new messages costs one send a window.
 * What a thread's lanes have sent outlives a lane that went quiet, so a record from an earlier turn that changes
 * after a pause is not taken for a new one.
 * `beforeOpening` runs just before a send that carries an opening change: the desktop delivers the shell held in
 * its own window there, so the window receives the two together and paints them in one commit rather than two.
 */
export function coalesceAgentThreadDetailPublishes(send: (update: AgentThreadDetailUpdate) => void,
  options: { intervalMs?: number; schedule?: PublishScheduler; beforeOpening?: () => void } = {}): CoalescedThreadDetailPublisher {
  const intervalMs = options.intervalMs ?? AGENT_STATE_PUBLISH_INTERVAL_MS
  const schedule = options.schedule ?? realPublishScheduler
  // `sending` holds back an update published while the lane is sending, such as the change a whole read
  // made inside `send` flushes first: sent at once it would reach later listeners ahead of the one being sent.
  // `closed` is a window no opening change may cut short; `held` says an opening change waits for its end.
  type Lane = { cancel: (() => void) | null; pending: AgentThreadDetailUpdate[]; sending?: boolean; opening?: boolean
    closed?: boolean; held?: boolean; sent: SentDetail }
  // What each thread's lanes have sent, kept for the threads most recently sent to.
  const sentByThread = new Map<string, SentDetail>()
  const sentFor = (threadId: string): SentDetail => {
    const sent = sentByThread.get(threadId) ?? new SentDetail()
    sentByThread.delete(threadId); sentByThread.set(threadId, sent)
    if (sentByThread.size > SENT_DETAIL_THREADS) sentByThread.delete(sentByThread.keys().next().value!)
    return sent
  }
  const freshLane = (threadId: string): Lane => ({ cancel: null, pending: [], sent: sentFor(threadId) })
  const lanes = new Map<string, Lane>()
  let disposed = false
  const flushLane = (threadId: string, closed: boolean): void => {
    const lane = lanes.get(threadId) ?? freshLane(threadId)
    lanes.set(threadId, lane)
    lane.cancel?.()
    lane.closed = closed
    lane.held = false
    lane.sending = true
    try {
      // An opening change that arrives while this lane is sending goes out in the same flush, after what was ahead of it.
      do {
        if (lane.opening) options.beforeOpening?.()
        lane.opening = false
        const queued = lane.pending
        lane.pending = []
        for (const update of queued) { lane.sent.note(update); send(update) }
      } while (lane.opening && !disposed)
    } finally { lane.sending = false }
    if (disposed) return
    lane.cancel = schedule(() => {
      lane.cancel = null
      if (lane.pending.length === 0) { lanes.delete(threadId); return }
      // An opening change held to the end still brings the shell ahead of it, and makes the next window a flood's.
      const held = lane.held === true
      lane.opening = held
      flushLane(threadId, held)
    }, intervalMs)
  }
  return {
    publish: update => {
      if (disposed) return
      const lane = lanes.get(update.threadId)
      if (lane?.cancel || lane?.sending) {
        const held = lane.pending.at(-1)
        const merged = held === undefined ? null : mergeAgentThreadDetailUpdates(held, update)
        if (merged === null) lane.pending.push(update)
        else lane.pending[lane.pending.length - 1] = merged
        if (lane.sent.opens(update)) {
          if (lane.sending) lane.opening = true
          else if (lane.closed) lane.held = true
          else { lane.opening = true; flushLane(update.threadId, true) }
        }
        return
      }
      const open = lane ?? freshLane(update.threadId)
      lanes.set(update.threadId, open)
      open.pending.push(update)
      open.opening = open.sent.opens(update)
      flushLane(update.threadId, false)
    },
    dispose: () => { disposed = true; for (const lane of lanes.values()) lane.cancel?.(); lanes.clear(); sentByThread.clear() },
  }
}
/** How many threads a detail coalescer remembers what it sent for. One past it may take a changed record for a new one. */
const SENT_DETAIL_THREADS = 64
/** The messages and activity records a thread's detail lanes have sent, by ID, which is what makes a later one new. */
class SentDetail {
  private readonly messages = new Set<string>()
  private readonly records = new Set<string>()
  /**
   * Whether an update is an opening change: a delta with a message or record this thread's lanes have not sent.
   * A whole detail never is. It supersedes what waits ahead of it and rides the window like any other, which
   * leaves the first record of a thread whose detail had no activity yet to wait for the window's end.
   */
  opens(update: AgentThreadDetailUpdate): boolean {
    if (!isAgentThreadDetailDelta(update)) return false
    return update.messageDeltas.some(item => 'message' in item && !this.messages.has(item.message.id))
      || update.activityDeltas.some(item => 'record' in item && !this.records.has(item.record.id))
  }
  note(update: AgentThreadDetailUpdate): void {
    if (isAgentThreadDetailDelta(update)) {
      for (const item of update.messageDeltas) this.messages.add('message' in item ? item.message.id : item.id)
      // A record removed and later brought back under its ID is new to the window again.
      for (const item of update.activityDeltas) {
        if ('removed' in item) this.records.delete(item.id)
        else this.records.add('record' in item ? item.record.id : item.id)
      }
      return
    }
    // A whole detail is everything the window now holds.
    this.messages.clear(); this.records.clear()
    for (const message of update.messages) this.messages.add(message.id)
    for (const record of update.activities ?? []) this.records.add(record.id)
  }
}
