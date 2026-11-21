import type { AgentState } from '../../../shared/agents'
import type { ThreadSwitchTiming, WholeReadCause } from '../../../shared/mainActivity'

/** A switch that has not painted in this long is let go: the window was hidden, or something else went wrong. */
export const THREAD_SWITCH_GIVE_UP_MS = 60_000

/** At most this many of the state's fields are named as having arrived new during one switch. */
const NEW_FIELDS_KEPT = 32

/** The presses a person makes to pick a thread, whose time stamps start a switch's clock. */
const PRESSES: ReadonlySet<string> = new Set(['click', 'auxclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup'])

export interface ThreadSwitchClockOptions {
  /** The window's clock, the one an event's `timeStamp` is on. */
  readonly now: () => number
  /** The next animation frame, whose callback runs just before it is laid out and painted. */
  readonly frame: (callback: () => void) => void
  /** The next task after it, the first moment the window runs again once that frame is painted. */
  readonly later: (callback: () => void) => void
  /** Whether `threadId`'s pane is on screen in a shown window, so the person could see the thread that painted. */
  readonly shown: (threadId: string) => boolean
  readonly report: (timing: ThreadSwitchTiming) => void
}

interface Switch {
  readonly threadId: string
  readonly pressedAt: number
  readonly handledAt: number
  readonly held: boolean
  readonly threads: number
  replyAt?: number
  historyAt?: number
  painting?: boolean
  commits: number
  shareMs: number
  newThreadRecords: number
  readonly newFields: Set<string>
  readonly wholeReads: Record<WholeReadCause, number>
}

/**
 * Times one thread switch at a time (#2733): from the press that selected a thread to main's answer drawn, the thread's
 * history held, and the first frame painted after the commit that drew the thread with it. A press for any other thread
 * before that frame, the one already shown included, lets the switch go, and so does a frame with no thread pane on
 * screen or one that shows another thread, so a switch the person left before it painted is never counted.
 */
export class ThreadSwitchClock {
  private current: Switch | null = null
  /** The thread the newest committed state shows. */
  private shownThreadId: string | null = null

  constructor(private readonly options: ThreadSwitchClockOptions) {}

  /** The window was asked to show `threadId`. `press` is the event being handled, when one is. */
  start(threadId: string, facts: { readonly held: boolean; readonly threads: number }, press?: Event): void {
    const handledAt = this.options.now()
    const pressedAt = press !== undefined && PRESSES.has(press.type) && press.timeStamp > 0 && press.timeStamp <= handledAt ? press.timeStamp : handledAt
    this.current = { threadId, pressedAt, handledAt, held: facts.held, threads: facts.threads, ...(facts.held ? { historyAt: handledAt } : {}),
      commits: 0, shareMs: 0, newThreadRecords: 0, newFields: new Set(),
      wholeReads: { broadcastParts: 0, broadcastThreads: 0, broadcastCatalog: 0, answerThreads: 0, answerCatalog: 0 } }
  }

  /** The person went back to the thread already shown: whatever switch was on its way is not one they waited for. */
  cancel(): void { this.current = null }

  /** The page decided it needed a whole read of the state, for `cause`. */
  wholeRead(cause: WholeReadCause): void { if (this.current) this.current.wholeReads[cause] += 1 }

  /** Whether a switch is being timed, so a commit measures its state sharing for it. */
  timing(): boolean { return this.current !== null }

  /**
   * A commit shared `next` against `previous` in `ms`. What the sharing has to walk is what arrived as a new object: the
   * thread records that are not the very records the window held, and the state's other fields, named by their keys.
   */
  shared(ms: number, previous: AgentState, next: AgentState): void {
    const current = this.current
    if (current === null) return
    current.commits += 1
    current.shareMs += ms
    const held = new Set<unknown>(previous.host.threads)
    for (const thread of next.host.threads) if (!held.has(thread)) current.newThreadRecords += 1
    const note = (key: string, before: unknown, after: unknown): void => {
      if (current.newFields.size < NEW_FIELDS_KEPT && typeof after === 'object' && after !== null && !Object.is(before, after)) current.newFields.add(key)
    }
    for (const key of Object.keys(next)) if (key !== 'host') note(key, (previous as Record<string, unknown>)[key], (next as Record<string, unknown>)[key])
    for (const key of Object.keys(next.host)) if (key !== 'threads') note(`host.${key}`, (previous.host as Record<string, unknown>)[key], (next.host as Record<string, unknown>)[key])
  }

  /** Main's answer to the selection of `threadId` is drawn. */
  replyDrawn(threadId: string): void {
    const current = this.live(threadId)
    if (current && current.replyAt === undefined) current.replyAt = this.options.now()
  }

  /** The window now holds `threadId`'s history. */
  historyHeld(threadId: string): void {
    const current = this.live(threadId)
    if (current && current.historyAt === undefined) current.historyAt = this.options.now()
  }

  /** A state was committed. Once it shows the switched-to thread with its history, the next painted frame ends the clock. */
  committed(state: AgentState): void {
    this.shownThreadId = state.activeThreadId
    const current = this.current
    if (current === null || current.painting === true || state.activeThreadId !== current.threadId || this.live(current.threadId) === null) return
    const thread = state.host.threads.find(item => item.id === current.threadId)
    if (thread === undefined || thread.historyStatus === 'loading' || current.historyAt === undefined) return
    // A history that could not be read shows its error, not the thread: there is nothing to count.
    if (thread.historyStatus === 'error') { this.current = null; return }
    current.painting = true
    const messages = thread.messages.length, activities = thread.activities?.length ?? 0, remote = thread.remoteHost === true
    this.options.frame(() => {
      const frameAt = this.options.now()
      this.options.later(() => {
        if (this.current !== current) return
        this.current = null
        if (this.shownThreadId !== current.threadId || !this.options.shown(current.threadId)) return
        const paintedAt = this.options.now()
        const since = (at: number | undefined): number => Math.max(0, Math.round((at ?? paintedAt) - current.pressedAt))
        this.options.report({
          inputMs: since(current.handledAt), replyMs: since(current.replyAt), historyMs: since(current.historyAt), frameMs: since(frameAt), paintedMs: since(paintedAt),
          held: current.held, remote, messages, activities, threads: current.threads,
          commits: current.commits, shareMs: Math.round(current.shareMs), newThreadRecords: current.newThreadRecords, newFields: [...current.newFields].sort(), wholeReads: { ...current.wholeReads },
        })
      })
    })
  }

  private live(threadId: string): Switch | null {
    const current = this.current
    if (current === null || current.threadId !== threadId) return null
    if (this.options.now() - current.pressedAt > THREAD_SWITCH_GIVE_UP_MS) { this.current = null; return null }
    return current
  }
}
