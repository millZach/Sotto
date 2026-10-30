import type { AgentThread } from '../../../shared/agents'
import type { MachineEntry } from '../../../shared/machineLine'
import { isThreadTurnRunning } from '../../../shared/threadActivity'
import { isPutAway } from './MoveThreads'

/**
 * A move suggestion (#1309, Zach's picks of October 30, 2026): a machine on the machines line reads short on memory or
 * busy, and another reads fine with headroom for at least one more worker, so the line under it names one thread to move
 * there. It comes only from the readings the line already takes, when Watcher places work or the user opens a machine's
 * panel (pick 1 A), never a reading of its own. Nothing moves until the user presses Move.
 */
export interface MoveSuggestionPlan {
  /** The machine short on memory or busy. */
  readonly from: MachineEntry
  /** Its problems the line names, busy before short on memory. */
  readonly problems: readonly ('busy' | 'short')[]
  /** The machine with room. */
  readonly to: MachineEntry
  /**
   * The threads on `from` that might move, most recently worked first: the ones a preview is asked about. Which of them
   * can move now is main's to say, by the same checks as Move threads.
   */
  readonly candidates: readonly string[]
  /** Which reading this is, so a new reading asks again and the same one does not. */
  readonly reading: string
}

/** How many threads a suggestion asks main about: the most recently worked, enough to find one at a clean point. */
export const MOVE_SUGGESTION_CANDIDATES_MAX = 10

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
 * The suggestion the line would make now, or null. The machine with room is the one with the most headroom, This computer
 * first among equals; one with none, or whose headroom is unknown (a Mac, whose memory reads unknown), never has room.
 * A machine the user said Not now to is passed over until it reads fine again.
 */
export function moveSuggestionPlan(entries: readonly MachineEntry[], threads: readonly AgentThread[], notNow: ReadonlySet<string>): MoveSuggestionPlan | null {
  const roomy = entries.filter(entry => entry.connected && entry.machine !== null && entry.problems.length === 0 && (entry.machine.headroom ?? 0) >= 1)
    .sort((a, b) => (b.machine!.headroom ?? 0) - (a.machine!.headroom ?? 0) || Number(b.thisComputer) - Number(a.thisComputer))
  const to = roomy[0]
  if (to === undefined) return null
  for (const from of entries) {
    const problems = loadProblems(from)
    if (!from.connected || from.machine === null || problems.length === 0 || notNow.has(from.machine.hostId)) continue
    const candidates = threads.filter(thread => onMachine(thread, from) && !isPutAway(thread) && thread.kind !== 'watcher' && thread.kind !== 'watcher-history'
      && thread.clientConnected !== false && thread.delegatedBy === undefined && !isThreadTurnRunning(thread))
      .sort((a, b) => worked(b) - worked(a)).slice(0, MOVE_SUGGESTION_CANDIDATES_MAX).map(thread => thread.id)
    if (candidates.length === 0) continue
    const reading = `${from.machine.hostId}:${from.machine.load?.observedAt ?? ''}:${to.machine!.hostId}`
    return { from, problems, to, candidates, reading }
  }
  return null
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
