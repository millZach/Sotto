/**
 * The busy-host question (ADR-0040), shared by a host update and a start at boot change (ADR-0054): both restart a host,
 * and both ask first when a thread there is working. Each keeps its own entries; these are the parts that must answer
 * alike.
 */

/** What the question needs of the threads: which of a host's are working, and the interrupt the composer's Stop sends. */
export interface BusyHostThreads {
  working(hostId: string): readonly string[]
  interrupt(threadId: string): Promise<void>
  subscribe(listener: () => void): () => void
}

/** Where a question stands: asked and not answered, or answered with Wait until they finish. */
export type BusyPhase = 'confirm' | 'waiting'

/** Wait until they finish: waits while a thread is working, and goes ahead at once when none is. */
export function whenIdle(working: number): 'waiting' | 'begin' {
  return working > 0 ? 'waiting' : 'begin'
}

/**
 * Stop N threads now: stops each working thread on the host the way its Stop does. A turn that has already ended refuses
 * its Stop; the restart ends whatever is left either way.
 */
export async function stopWorkingThreads(threads: BusyHostThreads, hostId: string): Promise<void> {
  await Promise.all(threads.working(hostId).map(threadId => threads.interrupt(threadId).catch(() => undefined)))
}

/**
 * Whether a question, or a wait, goes ahead now that the threads have moved: the user has already pressed, so once none
 * is working there is nothing left to ask about.
 */
export function idleNow(phase: string, working: number): boolean {
  return (phase === 'confirm' || phase === 'waiting') && working === 0
}
