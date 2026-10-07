import type { AgentCommand, AgentState, AgentThread } from '../../../shared/agents'

type Command = (command: AgentCommand) => Promise<AgentState | null>
type TypedThread = Pick<AgentThread, 'id' | 'providerSessionOpen' | 'archivedAt' | 'status'>

/**
 * Early start (#769): the first keystroke in a thread's composer asks main to start the thread's provider session, so
 * the send that follows does not wait for it. A window asks once per thread, and again only after it has seen that
 * session open: one the reaper stopped, or that ended, is asked for the next time the user types, and one already open
 * is never asked for. Keyed by the window's draft store, which lives as long as its connection to main.
 */
const asked = new WeakMap<object, Set<string>>()

function askedIn(owner: object): Set<string> {
  let threads = asked.get(owner)
  if (!threads) { threads = new Set(); asked.set(owner, threads) }
  return threads
}

/** The user typed in this thread's composer. Asks main to start its provider session, at most once until it is open. */
export function startOnTyping(owner: object, command: Command, thread: TypedThread, connected: boolean): void {
  const threads = askedIn(owner)
  if (thread.providerSessionOpen) { threads.delete(thread.id); return }
  if (threads.has(thread.id) || !connected || thread.archivedAt || thread.status === 'running') return
  threads.add(thread.id)
  // Nothing to say either way: a session that cannot start now is started, and its failure told, by the send.
  void command({ type: 'start-thread-session', threadId: thread.id }).catch(() => undefined)
}

/** The thread's provider session was seen open, so the next time it is stopped, typing asks again. */
export function sessionSeenOpen(owner: object, threadId: string): void {
  asked.get(owner)?.delete(threadId)
}
