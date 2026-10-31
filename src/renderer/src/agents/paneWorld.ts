import type { AgentState, AgentThread } from '../../../shared/agents'
import { delegatedThreadsBelow } from '../../../shared/delegation'
import { workspaceOptions, workspaceOptionId } from './branchToolbar.logic'

/**
 * The parts of another thread's record that move while it streams: its messages, its activity, its summary's preview and
 * times, its usage. A thread pane reads none of these for a thread that is neither its own nor related to it, with one
 * exception the comparison below keeps exact: the branch toolbar orders the project's other threads by how recently each
 * was active.
 */
const PROGRESS: ReadonlySet<string> = new Set<keyof AgentThread>(['messages', 'summary', 'updatedAt', 'activities', 'usage'])

/** Every key of either object, `except` aside, holds the same value in both. */
function sameExcept(previous: object, next: object, except: string): boolean {
  const before = previous as Record<string, unknown>, after = next as Record<string, unknown>
  for (const key in after) if (key !== except && !Object.is(before[key], after[key])) return false
  for (const key in before) if (key !== except && !(key in after)) return false
  return true
}

/** Two records of one thread differ only in what moves while it streams. */
function onlyProgress(previous: AgentThread, next: AgentThread): boolean {
  const before = previous as Record<string, unknown>, after = next as Record<string, unknown>
  for (const key in after) if (!PROGRESS.has(key) && !Object.is(before[key], after[key])) return false
  for (const key in before) if (!PROGRESS.has(key) && !(key in after)) return false
  return true
}

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

/** The branch toolbar's working-copy choices for a thread, in their order: the one place a pane orders other threads by activity. */
function workspaceOrder(thread: AgentThread, threads: readonly AgentThread[]): string {
  return workspaceOptions(thread, threads).map(option => workspaceOptionId(option.choice)).join('\n')
}

/**
 * Whether a thread's pane would draw the same from `next` as it drew from `previous` (#993). Everything in the state but
 * the thread list must be the same, the list must hold the same threads in the same order, and the pane's own thread and
 * every thread related to it must be unchanged. Another thread may have moved only in what moves while it streams, and
 * only so far as it leaves the branch toolbar's order of working copies alone. A pane whose thread did not change is then
 * left as it was when another thread streams, where it was drawn again for every word.
 *
 * Any doubt answers false: a pane drawn again needlessly costs time, one left as it was wrongly would show something old.
 */
export function samePaneWorld(previous: AgentState, next: AgentState, threadId: string): boolean {
  if (previous === next) return true
  if (!sameExcept(previous, next, 'host') || !sameExcept(previous.host, next.host, 'threads')) return false
  const before = previous.host.threads, after = next.host.threads
  if (before === after) return true
  if (before.length !== after.length) return false
  const changed: string[] = []
  for (let index = 0; index < after.length; index++) {
    const was = before[index]!, is = after[index]!
    if (was === is) continue
    if (was.id !== is.id || is.id === threadId || !onlyProgress(was, is)) return false
    changed.push(is.id)
  }
  if (changed.length === 0) return true
  const related = relatedThreadIds(after, threadId)
  if (changed.some(id => related.has(id))) return false
  const own = after.find(thread => thread.id === threadId)
  if (own === undefined) return false
  const projectChanged = changed.some(id => after.find(thread => thread.id === id)?.projectId === own.projectId)
  return !projectChanged || workspaceOrder(own, before) === workspaceOrder(own, after)
}
