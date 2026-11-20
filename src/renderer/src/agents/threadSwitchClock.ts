import type { AgentState } from '../../../shared/agents'
import { parseHostEntityKey } from '../../../shared/clientIdentity'
import type { ThreadSwitchTiming } from '../../../shared/mainActivity'

/** A switch that has not painted in this long is let go: the window was hidden, or something else went wrong. */
export const THREAD_SWITCH_GIVE_UP_MS = 60_000

/** The presses a person makes to pick a thread, whose time stamps start a switch's clock. */
const PRESSES: ReadonlySet<string> = new Set(['click', 'auxclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup'])

export interface ThreadSwitchClockOptions {
  /** The window's clock, the one an event's `timeStamp` is on. */
  readonly now: () => number
  /** The next animation frame, and a task after it: the frame painted. */
  readonly frame: (callback: () => void) => void
  readonly later: (callback: () => void) => void
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
}

/**
 * Times one thread switch at a time (#2733): from the press that selected a thread to main's answer drawn, the thread's
 * history held, and the first frame painted after the commit that drew the thread with it. A press for another thread
 * before that frame starts the clock again, so a switch the user left before it painted is not counted.
 */
export class ThreadSwitchClock {
  private current: Switch | null = null

  constructor(private readonly options: ThreadSwitchClockOptions) {}

  /** The window was asked to show `threadId`. `press` is the event being handled, when one is. */
  start(threadId: string, facts: { readonly held: boolean; readonly threads: number }, press?: Event): void {
    const handledAt = this.options.now()
    const pressedAt = press !== undefined && PRESSES.has(press.type) && press.timeStamp > 0 && press.timeStamp <= handledAt ? press.timeStamp : handledAt
    this.current = { threadId, pressedAt, handledAt, held: facts.held, threads: facts.threads, ...(facts.held ? { historyAt: handledAt } : {}) }
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
    const current = this.current
    if (current === null || current.painting === true || state.activeThreadId !== current.threadId || this.live(current.threadId) === null) return
    const thread = state.host.threads.find(item => item.id === current.threadId)
    if (thread === undefined || thread.historyStatus === 'loading' || current.historyAt === undefined) return
    current.painting = true
    const messages = thread.messages.length, activities = thread.activities?.length ?? 0
    // A thread keyed by a host other than this computer's own is on another computer.
    const host = parseHostEntityKey(thread.id)?.hostId
    const local = state.connections?.find(connection => connection.kind === 'local')?.hostId ?? state.hostId ?? state.host.hostId
    const remote = host !== undefined && host !== local
    this.options.frame(() => this.options.later(() => {
      if (this.current !== current) return
      this.current = null
      const since = (at: number | undefined): number => Math.max(0, Math.round((at ?? paintedAt) - current.pressedAt))
      const paintedAt = this.options.now()
      this.options.report({
        inputMs: since(current.handledAt), replyMs: since(current.replyAt), historyMs: since(current.historyAt), paintedMs: since(paintedAt),
        held: current.held, remote, messages, activities, threads: current.threads,
      })
    }))
  }

  private live(threadId: string): Switch | null {
    const current = this.current
    if (current === null || current.threadId !== threadId) return null
    if (this.options.now() - current.pressedAt > THREAD_SWITCH_GIVE_UP_MS) { this.current = null; return null }
    return current
  }
}
