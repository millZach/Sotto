import type { AgentProject, AgentThread } from './agents'

/** Project settlement is inherited until new work reopens the folder and preserves it on older threads. */
export function isWorkspaceThreadSettled(thread: Pick<AgentThread, 'workspaceSettledAt'>, project?: Pick<AgentProject, 'workspaceSettledAt'>): boolean {
  return hasTimestamp(thread.workspaceSettledAt) || hasTimestamp(project?.workspaceSettledAt)
}

type ThreadLifecycle = Pick<AgentThread, 'settledAt' | 'settledOverride' | 'archivedAt'>

const hasTimestamp = (value: string | null | undefined): boolean =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))

/** Explicitly parked work. Idle/error and unknown metadata never imply settlement. */
export function isThreadSettled(thread: ThreadLifecycle): boolean {
  if (thread.settledOverride === 'active') return false
  return thread.settledOverride === 'settled' || hasTimestamp(thread.settledAt)
}

/** Archived work: kept for its history only. A settled thread is not archived. */
export function isThreadArchived(thread: Pick<AgentThread, 'archivedAt'>): boolean {
  return hasTimestamp(thread.archivedAt)
}

/** Excluded from attention/supervision: settled or archived, not merely idle. */
export function isThreadClosed(thread: ThreadLifecycle): boolean {
  return hasTimestamp(thread.archivedAt) || isThreadSettled(thread)
}
