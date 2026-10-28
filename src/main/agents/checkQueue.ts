import { CHECK_QUEUE_TITLE_MAX, CHECK_QUEUE_VIEW_MAX, type CheckQueueEntry } from '../../shared/checkQueue'

/** Who asked for a check, and what names it while its thread is not made: what the window shows of it (#1312, fourth part). */
export type CheckInfo = Omit<CheckQueueEntry, 'id'>

/**
 * A machine's checks, one at a time (#1312, Zach, October 21 and 23, 2026): the check running on it now and the ones
 * waiting behind it, in the order they were asked for, whoever asked. One queue per machine, held by the Sotto running
 * there, in memory only: a restart empties it, and a check that was waiting is never started after one. An Owl feature
 * (`cross-machine-work`, ADR-0072): main makes a queue only while that is on.
 *
 * The queue decides nothing about a check's outcome. Its owner says when a check joins, and when it no longer holds its
 * place: it ended, was stopped, or never started. The first check in the queue is the one running.
 */
export class CheckQueue {
  private readonly entries: { readonly id: string; readonly start: () => void; info: CheckInfo | undefined }[] = []
  /** The queue as the window shows it, taken when it is first asked for after a change and kept until the next one. */
  private shown: readonly CheckQueueEntry[] | undefined
  private readonly listeners = new Set<() => void>()
  private telling = false
  /** Ends the running check's turn once it has held it for CHECK_TURN_CEILING_MS. */
  private ceiling: ReturnType<typeof setTimeout> | undefined

  /**
   * `machine` is the machine's name as the words for the model give it, such as "This computer", or how to read it when
   * the words are written, as a host's name its desktop sends it may change (#1316).
   */
  constructor(private readonly name: string | (() => string)) {}
  /** The machine's name in the words for the model, read now. */
  get machine(): string { return typeof this.name === 'string' ? this.name : this.name() }

  /**
   * Adds a check at the end of the queue. Answers `running` when nothing is ahead of it, so its owner starts it now;
   * otherwise `waiting`, and `start` is called once every check ahead of it has left. Joining twice changes nothing.
   */
  join(id: string, start: () => void, info?: CheckInfo): 'running' | 'waiting' {
    if (!this.entries.some(entry => entry.id === id)) { this.entries.push({ id, start, info }); this.changed() }
    if (this.entries.length === 1) this.watchTurn()
    return this.entries[0]!.id === id ? 'running' : 'waiting'
  }
  /**
   * Takes a check out of the queue: it ended, was stopped, or never started. When it was running, the next one starts,
   * after the caller's own work is done.
   */
  leave(id: string): void {
    const at = this.entries.findIndex(entry => entry.id === id)
    if (at === -1) return
    this.entries.splice(at, 1)
    this.changed()
    if (at !== 0) return
    this.watchTurn()
    const next = this.entries[0]
    if (next) queueMicrotask(() => { if (this.entries[0] === next) next.start() })
  }
  /**
   * Starts the running check's ceiling (CHECK_TURN_CEILING_MS), so one whose outcome never leaves `working`, as a hung
   * provider's would, gives the machine back to the checks behind it. Its thread runs on; it only stops holding the queue.
   */
  private watchTurn(): void {
    clearTimeout(this.ceiling); this.ceiling = undefined
    const running = this.entries[0]
    if (!running) return
    this.ceiling = setTimeout(() => { if (this.entries[0] === running) this.leave(running.id) }, CHECK_TURN_CEILING_MS)
    this.ceiling.unref?.()
  }
  /** How many checks are ahead of this one, the running one included; undefined when it is not in the queue. */
  ahead(id: string): number | undefined {
    const at = this.entries.findIndex(entry => entry.id === id)
    return at === -1 ? undefined : at
  }
  /** Whether this check is the one running. */
  running(id: string): boolean { return this.entries[0]?.id === id }
  /** The checks in the queue, the running one first. */
  ids(): readonly string[] { return this.entries.map(entry => entry.id) }

  /** Adds to what the window shows of a check, such as its thread once admission has named it. Changes nothing for a check not here. */
  describe(id: string, info: CheckInfo): void {
    const entry = this.entries.find(item => item.id === id)
    if (!entry) return
    const next: CheckInfo = { ...entry.info, ...info }
    const before = entry.info
    if (before && (Object.keys(next) as (keyof CheckInfo)[]).every(key => before[key] === next[key])) return
    entry.info = next
    this.changed()
  }
  /**
   * The queue as the window shows it, the running check first: whose each is, its thread once named, and what names it
   * until then. Taken only after the queue changed, never on the update path, and the same array until it changes again.
   */
  view(): readonly CheckQueueEntry[] {
    this.shown ??= Object.freeze(this.entries.slice(0, CHECK_QUEUE_VIEW_MAX).map(entry => Object.freeze({ id: entry.id, ...shownInfo(entry.info) })))
    return this.shown
  }
  /** Hears the queue change, once for all the changes made in one turn of the event loop. Returns the way to stop. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private changed(): void {
    this.shown = undefined
    if (this.telling || !this.listeners.size) return
    this.telling = true
    queueMicrotask(() => {
      this.telling = false
      for (const listener of [...this.listeners]) { try { listener() } catch { /* A listener's failure is its own. */ } }
    })
  }
}

/** What the window is sent of a check: only the fields its owner gave, the name cut to fit. */
function shownInfo(info: CheckInfo | undefined): CheckInfo {
  if (!info) return {}
  const title = info.title?.trim().slice(0, CHECK_QUEUE_TITLE_MAX)
  return { ...info.whose ? { whose: info.whose } : {}, ...info.thread ? { thread: info.thread } : {}, ...info.by ? { by: info.by } : {},
    ...title ? { title } : {}, ...info.work ? { work: info.work } : {}, ...info.provider ? { provider: info.provider } : {} }
}

/**
 * Whether a check still holds its machine's place while its outcome is `background`: its turn ended with work, such as a
 * test suite, still running (Zach, October 27, 2026). It holds until that work
 * is seen to end or the outcome is released after its thread sits idle (#1263).
 */
export const CHECK_HOLDS_THROUGH_BACKGROUND = true

/**
 * The longest one check holds its machine's place, from when its turn came, however its outcome reads: a check whose turn
 * never ends, such as one on a hung provider, would otherwise keep every check behind it waiting, Watcher's and delegated
 * alike. Generous, since the checks it bounds are whole test suites. Its value is not settled (PR #1647).
 */
export const CHECK_TURN_CEILING_MS = 2 * 60 * 60 * 1000

/** How a delegating thread takes a waiting check out of the queue, as its waiting words end. */
export const DELEGATION_CHECK_STOP = 'cancel_delegation takes it out of the queue.'
/** How a Watcher start that waits as a check here leaves the queue (#1312): stop_thread on its target, or the user's Stop (Zach, October 27). */
export const WATCHER_CHECK_STOP = "Its thread is made when its turn comes. stop_thread on its target, or the user's Stop, takes it out of the queue."
/** The same for a check waiting in the queue of a paired host that does not list `watcher-check-stop` (#1637), which only the user's Stop takes out. */
export const WATCHER_CHECK_STOP_AWAY = "Its thread is made when its turn comes. The user's Stop takes it out of the queue."
/** What a waiting check's result says of its place, for the model that asked for it. English: never shown on screen. */
export function checkWaitingWords(machine: string, ahead: number, stop: string = DELEGATION_CHECK_STOP): string {
  return `Waiting for ${machine}'s ${ahead === 1 ? 'check' : 'checks'} to finish. ${ahead} ahead. One check runs at a time on a machine, so its outcome stays working until it has run. ${stop}`
}
