import type { AgentThread } from './agents'
import { isThreadTurnRunning } from './threadActivity'

/**
 * Working threads (CONTEXT.md): how many threads on this computer have a turn running, whoever started them. Above this
 * many, Sotto says the computer may slow down or use its battery faster (#1183). It is a warning only: nothing is refused
 * or held back, at any count.
 */
export const WORKING_THREADS_QUIET_MAX = 10
/** The warning's second sentence, the same on every computer, on battery or not. */
export const WORKING_THREADS_CAUTION = 'This computer may slow down or use its battery faster.'

type Counted = Pick<AgentThread, 'id' | 'status' | 'lastTurn' | 'kind' | 'remoteHost'>
type CountedOnMachine = Counted & Pick<AgentThread, 'hostId'>

/**
 * The working threads among `threads`: those on this computer with a turn running, the user's, Watcher's workers and
 * delegated threads alike. Watcher's own thread, an older Watcher's and a thread on another computer are not counted, and
 * terminals are not threads. `alsoWorking` counts one thread as working whatever its status says yet, for a start whose
 * first prompt is on its way. Reads the list in place, without copying it.
 */
export function countWorkingThreads(threads: readonly Counted[], alsoWorking?: string): number {
  let count = 0
  for (const thread of threads) {
    if (thread.remoteHost === true || thread.kind === 'watcher' || thread.kind === 'watcher-history') continue
    if (thread.id === alsoWorking || isThreadTurnRunning(thread)) count++
  }
  return count
}

/** The key `workingThreadsByMachine` counts this computer's threads under, beside each other machine's host ID. */
export const THIS_COMPUTER = 'this-computer'
const counts = (thread: Counted): boolean => thread.kind !== 'watcher' && thread.kind !== 'watcher-history'

/**
 * Working threads on each machine (#1032): the window's joined thread list counted once, this computer's threads under
 * `THIS_COMPUTER` and each other machine's under its host ID, so nothing reads a machine's list twice. Counted as
 * `countWorkingThreads` counts this computer's. A machine with none working is left out. Reads the list in place.
 */
export function workingThreadsByMachine(threads: readonly CountedOnMachine[]): ReadonlyMap<string, number> {
  const byMachine = new Map<string, number>()
  for (const thread of threads) {
    if (!counts(thread) || !isThreadTurnRunning(thread)) continue
    const machine = thread.remoteHost === true && thread.hostId ? thread.hostId : THIS_COMPUTER
    byMachine.set(machine, (byMachine.get(machine) ?? 0) + 1)
  }
  return byMachine
}

/**
 * The working threads in one machine's own list, as that machine's host gives it, so none of them is marked as another
 * computer's. `alsoWorking` names the starts whose first prompt is on its way, counted as `countWorkingThreads` counts one,
 * and each counted once more when the list does not hold it yet: a thread just started on another machine reaches this
 * computer later, and several starts may be accepted before it does. None is counted twice.
 */
export function countMachineWorkingThreads(threads: readonly Counted[], alsoWorking: ReadonlySet<string> = new Set()): number {
  let count = 0, seen = 0
  for (const thread of threads) {
    if (!counts(thread)) continue
    const starting = alsoWorking.has(thread.id)
    if (starting) seen++
    if (starting || isThreadTurnRunning(thread)) count++
  }
  return count + alsoWorking.size - seen
}

/**
 * The warning for another machine while more than ten threads are working on it, and nothing at ten or fewer. Battery is
 * this computer's to mention; another machine may only slow down.
 */
export function machineWorkingThreadsWarning(count: number, machine: string): string | undefined {
  if (count <= WORKING_THREADS_QUIET_MAX) return undefined
  const name = machine.trim() || 'that machine'
  return `${count} threads are working on ${name}. ${name.charAt(0).toUpperCase()}${name.slice(1)} may slow down.`
}

/** The warning's first sentence, which the sidebar sets in the stronger weight. */
export function workingThreadsLead(count: number): string {
  return `${count} threads are working.`
}

/** The whole warning while more than ten threads are working, and nothing at ten or fewer. */
export function workingThreadsWarning(count: number): string | undefined {
  return count > WORKING_THREADS_QUIET_MAX ? `${workingThreadsLead(count)} ${WORKING_THREADS_CAUTION}` : undefined
}
