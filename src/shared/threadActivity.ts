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

/**
 * Whether the pane may show what a thread's provider still runs: its watches and background work, above the composer and
 * under the last reply. Only from a connected thread that is open, not in error and asking nothing of the user.
 */
export function threadOrnamentAllowed(thread: ThreadLifecycle & Pick<AgentThread, 'status' | 'requests'>, connected: boolean): boolean {
  return connected && !isThreadClosed(thread) && thread.status !== 'error' && thread.requests.length === 0
}

/**
 * A thread opened and never sent to: on its default title, at rest, with nothing in its transcript, open, and not a
 * delegated thread, which lives under the thread that delegated to it. The desktop's sidebar and the iPhone list it only
 * while their composer holds something for it, and the host removes one no client holds (ADR-0155).
 */
export function isUnsentThread(thread: AgentThread, project?: Pick<AgentProject, 'workspaceSettledAt'>): boolean {
  return thread.titleSource === 'default' && thread.status === 'idle' && thread.delegatedBy === undefined
    && !isThreadClosed(thread) && !isWorkspaceThreadSettled(thread, project)
    && (thread.summary?.messageCount ?? thread.messages.length) === 0
}

/** A turn under way. Native idle can come before the turn's completion, so a last turn still reported running counts. */
export function isThreadTurnRunning(thread: Pick<AgentThread, 'status' | 'lastTurn'>): boolean {
  return thread.status === 'running' || thread.lastTurn?.status === 'running'
}

/**
 * Watcher answering one of Sotto's own wake-ups, its news among them: a turn under way on Watcher's thread whose message
 * is one the host recorded as a wake-up. The user's message never joins such a turn; it waits and goes as its own (#1188).
 */
export function isWatcherWakeUpTurn(thread: Pick<AgentThread, 'kind' | 'status' | 'lastTurn' | 'messages' | 'lastUserMessageId' | 'summary' | 'wakeUpMessageIds'>): boolean {
  if (thread.kind !== 'watcher' || !isThreadTurnRunning(thread) || !thread.wakeUpMessageIds?.length) return false
  const head = thread.lastTurn?.status === 'running' && thread.lastTurn.messageId
    || (thread.lastUserMessageId ?? thread.messages.findLast(message => message.role === 'user')?.id ?? thread.summary?.lastUser?.id)
  return head !== undefined && thread.wakeUpMessageIds.includes(head)
}
