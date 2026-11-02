import type { AgentState, AgentThread } from '../../../shared/agents'
import { delegatedThreadsBelow } from '../../../shared/delegation'
import { workspaceOptions } from './branchToolbar.logic'
import { recentProjects } from './threadGreeting.logic'

/**
 * The parts of another thread's record that move while it streams: its messages, its activity, its summary's preview and
 * times, its usage. A thread pane reads none of these for a thread that is neither its own nor related to it, with two
 * exceptions the comparison below keeps exact: orders that follow other threads' activity, the branch toolbar's working
 * copies and a new thread's greeting's recent projects.
 */
const PROGRESS: ReadonlySet<string> = new Set<keyof AgentThread>(['messages', 'summary', 'updatedAt', 'activities', 'usage'])

/** Every key of either object holds the same value in both, but the keys `skipped` passes over. */
function sameKeys(previous: object, next: object, skipped: (key: string) => boolean): boolean {
  const before = previous as Record<string, unknown>, after = next as Record<string, unknown>
  for (const key in after) if (!skipped(key) && !Object.is(before[key], after[key])) return false
  for (const key in before) if (!skipped(key) && !(key in after)) return false
  return true
}

/** Two records of one thread differ only in what moves while it streams. */
const onlyProgress = (previous: AgentThread, next: AgentThread): boolean => sameKeys(previous, next, key => PROGRESS.has(key))

/** `PaneWorldOptions.ownStreaming`'s test of the thread itself: moved only in what moves while it streams, and still with a message or still without. */
export const sameWhileStreaming = (previous: AgentThread, next: AgentThread): boolean =>
  previous === next || onlyProgress(previous, next) && (previous.messages.length > 0) === (next.messages.length > 0)

/**
 * The threads whose records a pane reads more of than their titles and statuses: the threads delegation, a swarm, a
 * continuation or a start links to this one, in either direction. A change to any of them redraws the pane.
 */
export function relatedThreadIds(threads: readonly AgentThread[], threadId: string): ReadonlySet<string> {
  const own = threads.find(thread => thread.id === threadId)
  const related = new Set<string>([threadId, ...delegatedThreadsBelow(threads, threadId)])
  const byId = new Map(threads.map(thread => [thread.id, thread] as const))
  for (let parent = own?.delegatedBy; parent !== undefined && !related.has(parent); parent = byId.get(parent)?.delegatedBy) related.add(parent)
  if (own?.continuedFrom) related.add(own.continuedFrom.threadId)
  for (const link of own?.continuedIn ?? []) related.add(link.threadId)
  if (own?.startedFrom) related.add(own.startedFrom.threadId)
  if (own?.swarm !== undefined) related.add(own.swarm.leadThreadId)
  for (const thread of threads) {
    if (own?.swarm !== undefined && thread.swarm?.id === own.swarm.id) related.add(thread.id)
    if (thread.swarm?.leadThreadId === threadId) related.add(thread.id)
    if (thread.continuedFrom?.threadId === threadId || thread.startedFrom?.threadId === threadId) related.add(thread.id)
  }
  return related
}

/** The branch toolbar's working-copy choices as they read, newest first: they follow the activity of the project's threads. */
const workingCopies = (state: AgentState, thread: AgentThread): string =>
  JSON.stringify(workspaceOptions(thread, state.host.threads).map(option => [option.id, option.label, option.name]))

/** The recent projects a new thread's greeting offers, newest first: they follow every thread's time and summary. */
const greetingProjects = (state: AgentState, thread: AgentThread): string => recentProjects(state, thread).map(project => project.id).join('\n')

export interface PaneWorldOptions {
  /**
   * For a part that reads nothing of its own thread's streaming but whether it has a message yet, as the branch toolbar
   * reads only that to lock the working copy: the thread may also have moved in what moves while it streams, so long as it
   * still has a message or still has none.
   */
  readonly ownStreaming?: boolean
}

/**
 * Whether a thread's pane would draw the same from `next` as it drew from `previous` (#993). Everything in the state but
 * the thread list must be the same, the list must hold the same threads in the same order, and the pane's own thread and
 * every thread related to it must be unchanged. Another thread may have moved only in what moves while it streams, and
 * only so far as it leaves the orders that follow activity as they were. A pane whose thread did not change is then
 * left as it was when another thread streams, where it was drawn again for every word.
 *
 * Any doubt answers false: a pane drawn again needlessly costs time, one left as it was wrongly would show something old.
 */
export function samePaneWorld(previous: AgentState, next: AgentState, threadId: string, options: PaneWorldOptions = {}): boolean {
  if (previous === next) return true
  if (!sameKeys(previous, next, key => key === 'host') || !sameKeys(previous.host, next.host, key => key === 'threads')) return false
  const before = previous.host.threads, after = next.host.threads
  if (before === after) return true
  if (before.length !== after.length) return false
  const changed: number[] = []
  for (let index = 0; index < after.length; index++) {
    const was = before[index]!, is = after[index]!
    if (was === is) continue
    if (was.id !== is.id || !onlyProgress(was, is)) return false
    if (is.id === threadId) {
      if (!options.ownStreaming || !sameWhileStreaming(was, is)) return false
      continue
    }
    changed.push(index)
  }
  if (changed.length === 0) return true
  const related = relatedThreadIds(after, threadId)
  if (changed.some(index => related.has(after[index]!.id))) return false
  const own = after.find(thread => thread.id === threadId)
  if (own === undefined) return false
  // Each order is worked out again only when a change could move it: most streamed words change neither a thread's time
  // nor its summary, nor touch the pane's own project.
  const timed = changed.some(index => before[index]!.updatedAt !== after[index]!.updatedAt || before[index]!.summary !== after[index]!.summary)
  if (timed && greetingProjects(previous, own) !== greetingProjects(next, own)) return false
  const inProject = changed.some(index => after[index]!.projectId === own.projectId)
  return !inProject || workingCopies(previous, own) === workingCopies(next, own)
}
