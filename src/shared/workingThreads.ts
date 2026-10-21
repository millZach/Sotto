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

/** The warning's first sentence, which the sidebar sets in the stronger weight. */
export function workingThreadsLead(count: number): string {
  return `${count} threads are working.`
}

/** The whole warning while more than ten threads are working, and nothing at ten or fewer. */
export function workingThreadsWarning(count: number): string | undefined {
  return count > WORKING_THREADS_QUIET_MAX ? `${workingThreadsLead(count)} ${WORKING_THREADS_CAUTION}` : undefined
}
