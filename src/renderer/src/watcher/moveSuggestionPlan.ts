import type { AgentThread } from '../../../shared/agents'
import type { MachineEntry } from '../../../shared/machineLine'
import { isThreadTurnRunning } from '../../../shared/threadActivity'
import { THREAD_MOVE_THREADS_MAX } from '../../../shared/threadMoves'
import { isPutAway } from './MoveThreads'

/**
 * A move suggestion (#1309, Zach's picks of October 30, 2026): a machine on the machines line reads short on memory or
 * busy, and another reads fine with headroom for at least one more worker, so the line under it names one thread to move
 * there. It comes only from the readings the line already takes, when Watcher places work or the user opens a machine's
 * panel (pick 1 A), never a reading of its own. Nothing moves until the user presses Move.
 *
 * What it asks about is worked out from the machines alone, so a thread's update costs nothing here; which threads are
 * asked about is worked out once a reading, by `moveSuggestionCandidates`.
 */
export interface MoveSuggestionPlan {
  /** The machines short on memory or busy, in the line's order, with their problems, busy before short on memory. */
  readonly troubled: readonly MoveSuggestionSource[]
  /** The machine with room. */
  readonly to: MachineEntry
  /** Which reading this is: each troubled machine's, so the line says nothing more once this one was pressed. */
  readonly reading: string
}
export interface MoveSuggestionSource {
  readonly from: MachineEntry
  readonly problems: readonly LoadProblem[]
  /**
   * This machine's reading, toward the machine with room: what main is asked about once, and its answer kept by, so
   * another machine's reading, or Not now on another machine, never asks about this one again.
   */
  readonly reading: string
}

const PROBLEMS = ['busy', 'short'] as const
type LoadProblem = typeof PROBLEMS[number]
const loadProblems = (entry: MachineEntry): readonly LoadProblem[] => PROBLEMS.filter(problem => entry.problems.includes(problem))
const onMachine = (thread: AgentThread, entry: MachineEntry): boolean =>
  entry.thisComputer ? thread.remoteHost !== true : thread.remoteHost === true && thread.hostId === entry.hostId
const worked = (thread: AgentThread): number => {
  const at = thread.updatedAt === undefined ? Number.NaN : Date.parse(thread.updatedAt)
  return Number.isNaN(at) ? 0 : at
}

/**
 * The suggestion the line could make from this reading, or null. The machine with room is the one with the most headroom,
 * This computer first among equals; one with none, or whose headroom is unknown (a Mac, whose memory reads unknown), never
 * has room. A machine the user said Not now to is passed over until it reads fine again.
 */
export function moveSuggestionPlan(entries: readonly MachineEntry[], notNow: ReadonlySet<string>): MoveSuggestionPlan | null {
  const roomy = entries.filter(entry => entry.connected && entry.machine !== null && entry.problems.length === 0 && (entry.machine.headroom ?? 0) >= 1)
    .sort((a, b) => (b.machine!.headroom ?? 0) - (a.machine!.headroom ?? 0) || Number(b.thisComputer) - Number(a.thisComputer))
  const to = roomy[0]
  if (to === undefined) return null
  const troubled = entries.filter(entry => entry.connected && entry.machine !== null && loadProblems(entry).length > 0 && !notNow.has(entry.machine.hostId))
    .map(from => ({ from, problems: loadProblems(from), reading: `${from.machine!.hostId}:${from.machine!.load?.observedAt ?? ''}:${to.machine!.hostId}` }))
  if (troubled.length === 0) return null
  return { troubled, to, reading: troubled.map(source => source.reading).join(',') }
}

/**
 * Whether the window can see that a thread is not at a clean point: a turn running, a question or permission card,
 * uncommitted work as its host last read its folder, put away, delegated, or Watcher's own. Background work, sends on
 * their way and work uncommitted since that read are main's to say, in its preview, which a press asks again.
 */
export function plainlyHeld(thread: AgentThread): boolean {
  return isPutAway(thread) || thread.kind === 'watcher' || thread.kind === 'watcher-history' || thread.clientConnected === false
    || thread.delegatedBy !== undefined || isThreadTurnRunning(thread) || thread.requests.length > 0
    || thread.worktree?.dirty === true || thread.worktree?.git?.dirty === true
}

/**
 * A machine's threads that might move, most recently worked first, in the hundreds a preview takes at a time, so a hundred
 * that would not move never hide one that would. Worked out once a reading.
 */
export function moveSuggestionCandidates(threads: readonly AgentThread[], from: MachineEntry): readonly (readonly string[])[] {
  const ids = threads.filter(thread => onMachine(thread, from) && !plainlyHeld(thread)).sort((a, b) => worked(b) - worked(a)).map(thread => thread.id)
  const pages: string[][] = []
  for (let at = 0; at < ids.length; at += THREAD_MOVE_THREADS_MAX) pages.push(ids.slice(at, at + THREAD_MOVE_THREADS_MAX))
  return pages
}

/**
 * The machines the user said Not now to (pick 4 A), by host ID, kept while the window lives: one is offered again once a
 * reading shows it neither busy nor short on memory, and then reads short or busy once more.
 */
class NotNowStore {
  private hosts: ReadonlySet<string> = new Set()
  private readonly listeners = new Set<() => void>()
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  readonly get = (): ReadonlySet<string> => this.hosts
  add(hostId: string): void { this.set(new Set([...this.hosts, hostId])) }
  /** Forgets each machine a reading shows connected and neither busy nor short on memory. */
  settle(entries: readonly MachineEntry[]): void {
    // A machine whose load reads unknown has not read fine.
    const fine = entries.filter(entry => entry.connected && entry.machine !== null && loadProblems(entry).length === 0 && !entry.problems.includes('unknown')
      && this.hosts.has(entry.machine.hostId))
    if (fine.length === 0) return
    const left = new Set(this.hosts)
    for (const entry of fine) left.delete(entry.machine!.hostId)
    this.set(left)
  }
  /** For tests. */
  clear(): void { this.set(new Set()) }
  private set(hosts: ReadonlySet<string>): void { this.hosts = hosts; for (const listener of [...this.listeners]) listener() }
}
export const moveSuggestionNotNow = new NotNowStore()
