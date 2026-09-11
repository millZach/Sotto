import type { AgentThread } from './agents'

type ThreadLifecycle = Pick<AgentThread, 'settledAt' | 'settledOverride' | 'archivedAt'>

const hasTimestamp = (value: string | null | undefined): boolean =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))

/** Explicitly parked work. Idle/error and unknown metadata never imply settlement. */
export function isThreadSettled(thread: ThreadLifecycle): boolean {
  if (thread.settledOverride === 'active') return false
  return thread.settledOverride === 'settled' || hasTimestamp(thread.settledAt)
}

/** Excluded from attention/supervision: settled or archived, not merely idle. */
export function isThreadClosed(thread: ThreadLifecycle): boolean {
  return hasTimestamp(thread.archivedAt) || isThreadSettled(thread)
}
