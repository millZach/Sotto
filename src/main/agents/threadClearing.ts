import type { AgentProject, AgentThread } from '../../shared/agents'
import { delegatedThreadsBelow } from '../../shared/delegation'
import { isWorkspaceThreadSettled } from '../../shared/threadActivity'
import type { ThreadClearKeptReason } from '../../shared/threadClear'

/** What the coordinator knows of one thread beside its record, for the clearing check (ADR-0140 decision 3). */
export interface ThreadClearFacts {
  readonly threads: readonly AgentThread[]
  /** The threads that delegated to another, read once for a whole list (`threadDelegators`). */
  readonly delegators: ReadonlySet<string>
  readonly projects: readonly AgentProject[]
  /** The thread is hidden from this run: held to Owl, Watcher's own, or kept outside the release gate. */
  readonly hidden: (threadId: string) => boolean
  /** Something is queued or on its way for the thread, or an action of its has an unknown result. */
  readonly pending: (threadId: string) => boolean
  /** Watcher is watching the thread. */
  readonly watched: (threadId: string) => boolean
}

/** Work the thread is doing now: a turn, a compaction, background work, monitoring or working sub-agents. */
function working(thread: AgentThread): boolean {
  return thread.status === 'running' || thread.lastTurn?.status === 'running' || thread.compaction?.status === 'running'
    || Boolean(thread.backgroundWork?.length || thread.monitoring?.length || thread.subagentSummary?.working)
    || thread.gitAction?.status === 'running'
}
/** A pull request of the thread's that is still open: one it linked, or its branch's own. */
function openPullRequest(thread: AgentThread): boolean {
  return thread.pullRequests?.some(pullRequest => pullRequest.state === 'open') === true || thread.worktree?.git?.pullRequest?.state === 'open'
}

/** The threads that delegated work to another (ADR-0081). */
export function threadDelegators(threads: readonly Pick<AgentThread, 'delegatedBy'>[]): Set<string> {
  return new Set(threads.flatMap(thread => thread.delegatedBy === undefined ? [] : [thread.delegatedBy]))
}
/**
 * Why the coordinator keeps a thread back from clearing, or null (ADR-0140 decision 3): hidden, not settled, working,
 * waiting on the user, something queued or unknown, an open pull request of its own or of a thread it delegated to, a
 * delegated thread not at rest, babysat, or watched. The worktree's own reasons are the workspace's, read from the folder.
 */
export function threadClearHold(thread: AgentThread | undefined, facts: ThreadClearFacts): ThreadClearKeptReason | null {
  if (!thread || thread.kind === 'watcher' || thread.kind === 'watcher-history' || facts.hidden(thread.id)) return 'hidden'
  if (!isWorkspaceThreadSettled(thread, facts.projects.find(project => project.id === thread.projectId))) return 'not-settled'
  // A question or a permission holds its turn running, so it is named first: what the thread needs is you.
  if (thread.requests.length) return 'waiting-on-you'
  if (working(thread)) return 'working'
  if (facts.pending(thread.id) || thread.compaction?.status === 'uncertain') return 'queued'
  const below = facts.delegators.has(thread.id) ? delegatedThreadsBelow(facts.threads, thread.id).flatMap(id => facts.threads.find(item => item.id === id) ?? []) : []
  if (openPullRequest(thread) || below.some(openPullRequest)) return 'pull-request'
  if (below.some(item => working(item) || item.requests.length > 0 || facts.pending(item.id) || item.compaction?.status === 'uncertain')) return 'delegated-working'
  if (thread.babysitting?.length) return 'babysitting'
  if (facts.watched(thread.id)) return 'watched'
  return null
}
