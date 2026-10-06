import type { AgentThread } from '../../shared/agents'
import type { AgentActivity } from '../../shared/agentActivity'

/**
 * The moments a send passes on its way from Send to the first streamed output, in the order they happen. Each
 * layer marks its own: the coordinator `dispatched` as it hands the prompt to its host, the workspace `prepared`
 * as it hands it to the provider stack, the adapter `written` as it writes the prompt to its client and
 * `acknowledged` when the client confirms it, and the coordinator `firstOutput` when the reply's first text,
 * thinking or tool activity reaches it.
 */
export type SendStageMark = 'dispatched' | 'prepared' | 'written' | 'acknowledged' | 'firstOutput'

/**
 * What a turn record keeps of a send: how long each step between Send and the first output took, in whole
 * milliseconds, and nothing else. A step this send did not take, or that nobody timed, is null.
 *
 * - `admissionMs`: the coordinator's own work before its host: saving the draft, waiting for the thread's lane, the
 *   outbox write, and for a spoken send working out what was said.
 * - `readBeforeSendMs`: the coordinator's read of the thread immediately before the send.
 * - `preparationMs`: the workspace: the folder check, the branch record and the checkpoint, and starting the native
 *   session on a first send.
 * - `adapterMs`: the adapter's own work before it writes the prompt to its client.
 * - `acknowledgementMs`: from the prompt written to the client confirming it.
 * - `firstOutputMs`: from the step before it, normally the acknowledgement, to the reply's first text, thinking or
 *   tool activity.
 */
export const SEND_STAGE_FIELDS = ['admissionMs', 'readBeforeSendMs', 'preparationMs', 'adapterMs', 'acknowledgementMs', 'firstOutputMs'] as const
export type SendStageField = typeof SEND_STAGE_FIELDS[number]
export type SendStageTimings = Record<SendStageField, number | null>

/** How long a send's turn record waits for its first output before it is written without one. */
export const FIRST_OUTPUT_LIMIT_MS = 120_000

/**
 * One send's stopwatch, carried by its turn and lent to the layers below by command ID. Marks are monotonic times
 * (`performance.now()`) and the first mark of each name wins. It holds no text, path or identity.
 */
export class SendStageClock {
  private readonly marks = new Map<SendStageMark, number>()
  private readMs: number | undefined
  private watching = true
  private waiting: { promise: Promise<void>; resolve: () => void; timer: ReturnType<typeof setTimeout> } | undefined
  private readonly closedListeners = new Set<() => void>()

  /** `receivedAt` is when the coordinator received the send; without it the record has no admission time. */
  constructor(private readonly receivedAt?: number, private readonly now: () => number = () => performance.now()) {}

  mark(name: SendStageMark): void {
    if (this.marks.has(name) || (name === 'firstOutput' && !this.watching)) return
    this.marks.set(name, this.now())
    if (name === 'firstOutput') this.close()
  }
  has(name: SendStageMark): boolean { return this.marks.has(name) }
  /** Add a read the coordinator made before the send. */
  addRead(ms: number): void { this.readMs = (this.readMs ?? 0) + Math.max(0, ms) }

  /**
   * True while a record should wait for the first output: the client confirmed the prompt, the reply has shown
   * nothing yet, and nobody has stopped watching for it. A host that confirms nothing is never waited for.
   */
  awaitsFirstOutput(): boolean { return this.watching && this.marks.has('acknowledged') && !this.marks.has('firstOutput') }

  /** Resolves once the first output is marked or watching stops, and at the latest `limitMs` from now. */
  untilFirstOutput(limitMs = FIRST_OUTPUT_LIMIT_MS): Promise<void> {
    if (!this.awaitsFirstOutput()) { this.close(); return Promise.resolve() }
    if (!this.waiting) {
      let resolve!: () => void
      const promise = new Promise<void>(done => { resolve = done })
      const timer = setTimeout(() => this.close(), limitMs)
      timer.unref?.()
      this.waiting = { promise, resolve, timer }
    }
    return this.waiting.promise
  }

  /** Stop watching for the first output. What was marked stays; a later output is not marked. */
  close(): void {
    if (!this.watching) return
    this.watching = false
    if (this.waiting) { clearTimeout(this.waiting.timer); this.waiting.resolve() }
    for (const listener of this.closedListeners) listener()
    this.closedListeners.clear()
  }
  onClosed(listener: () => void): void {
    if (this.watching) this.closedListeners.add(listener)
    else listener()
  }

  durations(): SendStageTimings {
    const at = (name: SendStageMark): number | undefined => this.marks.get(name)
    const between = (from: number | undefined, to: number | undefined): number | null =>
      from === undefined || to === undefined ? null : Math.max(0, Math.round(to - from))
    const dispatched = at('dispatched')
    const read = this.readMs
    return {
      admissionMs: this.receivedAt === undefined || dispatched === undefined ? null : Math.max(0, Math.round(dispatched - this.receivedAt - (read ?? 0))),
      readBeforeSendMs: read === undefined ? null : Math.round(read),
      preparationMs: between(dispatched, at('prepared')),
      adapterMs: between(at('prepared'), at('written')),
      acknowledgementMs: between(at('written'), at('acknowledged')),
      firstOutputMs: between(at('acknowledged') ?? at('written') ?? at('prepared') ?? dispatched, at('firstOutput')),
    }
  }
}

/**
 * The clocks lent to the layers below the coordinator, by the send's command ID, which every layer passes on
 * unchanged. A clock is lent for the length of one host call and nothing below the coordinator holds it, so a
 * command stays plain data that any layer may copy.
 */
const lentClocks = new Map<string, SendStageClock>()

/** Lend `clock` to the layers that handle command `commandId`. Call the returned function when the host call ends. */
export function lendSendStages(commandId: string, clock: SendStageClock): () => void {
  lentClocks.set(commandId, clock)
  return () => { if (lentClocks.get(commandId) === clock) lentClocks.delete(commandId) }
}

/**
 * Mark a step of the send with this command ID, when the coordinator is timing it. Otherwise nothing happens. It
 * never throws: the adapters call it on the path that confirms a prompt, where a throw would turn a delivered
 * prompt into a failed one.
 */
export function markSendStage(commandId: string, mark: SendStageMark): void {
  try { lentClocks.get(commandId)?.mark(mark) } catch { /* Timing must never change what a send does. */ }
}

/** Activity that counts as the reply showing itself. A turn starting or a status line does not. */
const OUTPUT_ACTIVITY = new Set<AgentActivity['kind']>(['reasoning', 'tool', 'command', 'file-change', 'plan', 'subagent'])

/** What a thread already showed when a send went out, so its reply's first output can be told from what was there. */
export interface FirstOutputBaseline { readonly messageIds: ReadonlySet<string>; readonly activityIds: ReadonlySet<string> }

export function firstOutputBaseline(thread: Pick<AgentThread, 'messages' | 'activities'> | undefined): FirstOutputBaseline {
  return { messageIds: new Set(thread?.messages.map(message => message.id) ?? []), activityIds: new Set(thread?.activities?.map(activity => activity.id) ?? []) }
}

/** True when the thread shows reply text or reply activity it did not show at `baseline`. */
export function showsFirstOutput(thread: Pick<AgentThread, 'messages' | 'activities'>, baseline: FirstOutputBaseline): boolean {
  for (let index = thread.messages.length - 1; index >= 0; index--) {
    const message = thread.messages[index]!
    if (baseline.messageIds.has(message.id)) break
    if (message.role === 'assistant' && message.text.trim()) return true
  }
  return thread.activities?.some(activity => OUTPUT_ACTIVITY.has(activity.kind) && !baseline.activityIds.has(activity.id)) ?? false
}

type WatchedThread = Pick<AgentThread, 'id' | 'messages' | 'activities' | 'status' | 'lastTurn'>

/**
 * The sends whose reply's first output the coordinator is watching for, one per thread, each with what its thread
 * showed when the send went out. The coordinator hands it every snapshot it accepts.
 */
export class FirstOutputWatches {
  private readonly watches = new Map<string, { clock: SendStageClock; baseline: FirstOutputBaseline; sawRunning: boolean }>()

  /** Watch `thread`, as it is now, for the first output of the reply to the send `clock` times. A newer send replaces an older one. */
  watch(threadId: string, clock: SendStageClock, thread: Pick<AgentThread, 'messages' | 'activities'> | undefined): void {
    const watch = { clock, baseline: firstOutputBaseline(thread), sawRunning: false }
    this.watches.get(threadId)?.clock.close()
    this.watches.set(threadId, watch)
    clock.onClosed(() => { if (this.watches.get(threadId) === watch) this.watches.delete(threadId) })
  }

  /** Mark the first output of each watched reply these threads show, and stop watching a reply whose turn ended without one. */
  observe(threads: readonly WatchedThread[]): void {
    if (!this.watches.size) return
    for (const [threadId, watch] of [...this.watches]) {
      const thread = threads.find(item => item.id === threadId)
      if (!thread) continue
      if (showsFirstOutput(thread, watch.baseline)) { watch.clock.mark('firstOutput'); continue }
      const running = thread.status === 'running' || thread.lastTurn?.status === 'running'
      watch.sawRunning ||= running
      // The reply's turn ended having shown nothing, so there is no first output to wait for.
      if (watch.sawRunning && !running && watch.clock.has('acknowledged')) watch.clock.close()
    }
  }

  /** Stop watching every reply; their records are written now, without a first output. */
  closeAll(): void { for (const { clock } of [...this.watches.values()]) clock.close() }
}
