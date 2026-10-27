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
  private readonly entries: { readonly id: string; readonly start: () => void }[] = []

  /** `machine` is the machine's name as the words for the model give it, such as "This computer". */
  constructor(readonly machine: string) {}

  /**
   * Adds a check at the end of the queue. Answers `running` when nothing is ahead of it, so its owner starts it now;
   * otherwise `waiting`, and `start` is called once every check ahead of it has left. Joining twice changes nothing.
   */
  join(id: string, start: () => void): 'running' | 'waiting' {
    if (!this.entries.some(entry => entry.id === id)) this.entries.push({ id, start })
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
    const next = at === 0 ? this.entries[0] : undefined
    if (next) queueMicrotask(() => { if (this.entries[0] === next) next.start() })
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
}

/**
 * Whether a check still holds its machine's place while its outcome is `background`: its turn ended with work, such as a
 * test suite, still running (Zach, October 27, 2026). It holds until that work
 * is seen to end or the outcome is released after its thread sits idle (#1263).
 */
export const CHECK_HOLDS_THROUGH_BACKGROUND = true

/** How a delegating thread takes a waiting check out of the queue, as its waiting words end. */
export const DELEGATION_CHECK_STOP = 'cancel_delegation takes it out of the queue.'
/** How a Watcher start that waits as a check here leaves the queue (#1312): stop_thread on its target, or the user's Stop (Zach, October 27). */
export const WATCHER_CHECK_STOP = "Its thread is made when its turn comes. stop_thread on its target, or the user's Stop, takes it out of the queue."
/** The same for a check waiting in a paired host's queue, which only the user's Stop takes out for now. */
export const WATCHER_CHECK_STOP_AWAY = "Its thread is made when its turn comes. The user's Stop takes it out of the queue."
/** What a waiting check's result says of its place, for the model that asked for it. English: never shown on screen. */
export function checkWaitingWords(machine: string, ahead: number, stop: string = DELEGATION_CHECK_STOP): string {
  return `Waiting for ${machine}'s ${ahead === 1 ? 'check' : 'checks'} to finish. ${ahead} ahead. One check runs at a time on a machine, so its outcome stays working until it has run. ${stop}`
}
