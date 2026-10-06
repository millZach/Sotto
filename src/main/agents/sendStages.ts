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
 * milliseconds, and nothing else. A step this send did not take, or a layer that marks nothing, is null.
 */
export interface SendStageTimings {
  /** The coordinator's own work before its host: saving the draft, waiting for the thread's lane, the outbox write. */
  admissionMs: number | null
  /** The coordinator's read of the thread immediately before the send. */
  readBeforeSendMs: number | null
  /** The workspace: the folder check, the branch record and the checkpoint, and starting the native session on a first send. */
  preparationMs: number | null
  /** The adapter's own work before it writes the prompt to its client. */
  adapterMs: number | null
  /** From the prompt written to the client confirming it. */
  acknowledgementMs: number | null
  /** From the step before it, normally the acknowledgement, to the reply's first text, thinking or tool activity. */
  firstOutputMs: number | null
}
export const SEND_STAGE_FIELDS = ['admissionMs', 'readBeforeSendMs', 'preparationMs', 'adapterMs', 'acknowledgementMs', 'firstOutputMs'] as const satisfies readonly (keyof SendStageTimings)[]
export const NO_SEND_STAGES: SendStageTimings = Object.freeze({ admissionMs: null, readBeforeSendMs: null, preparationMs: null, adapterMs: null,
  acknowledgementMs: null, firstOutputMs: null })

/** How long a send's turn record waits for its first output before it is written without one. */
export const FIRST_OUTPUT_LIMIT_MS = 120_000

/**
 * One send's stopwatch, carried by its turn and handed down with the host command. Marks are monotonic times
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
  firstOutput(limitMs = FIRST_OUTPUT_LIMIT_MS): Promise<void> {
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
    const span = (from: number | undefined, to: number | undefined): number | null =>
      from === undefined || to === undefined ? null : Math.max(0, Math.round(to - from))
    const dispatched = at('dispatched')
    const read = this.readMs
    return {
      admissionMs: this.receivedAt === undefined || dispatched === undefined ? null : Math.max(0, Math.round(dispatched - this.receivedAt - (read ?? 0))),
      readBeforeSendMs: read === undefined ? null : Math.round(read),
      preparationMs: span(dispatched, at('prepared')),
      adapterMs: span(at('prepared'), at('written')),
      acknowledgementMs: span(at('written'), at('acknowledged')),
      firstOutputMs: span(at('acknowledged') ?? at('written') ?? at('prepared') ?? dispatched, at('firstOutput')),
    }
  }
}

/**
 * The clocks lent to the layers below the coordinator, by the send's command ID, which every layer passes on
 * unchanged. A clock is lent for the length of one host call and nothing below the coordinator holds it, so a
 * command stays plain data that any layer may copy.
 */
const lent = new Map<string, SendStageClock>()

/** Lend `clock` to the layers that handle command `commandId`. Call the returned function when the host call ends. */
export function lendSendStages(commandId: string, clock: SendStageClock): () => void {
  lent.set(commandId, clock)
  return () => { if (lent.get(commandId) === clock) lent.delete(commandId) }
}

/** Mark a step of the send with this command ID, when the coordinator is timing it. Otherwise nothing happens. */
export function markSendStage(commandId: string, mark: SendStageMark): void { lent.get(commandId)?.mark(mark) }

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
