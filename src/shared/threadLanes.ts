import type { AgentCommand } from './agents'

/**
 * The commands that name one thread and act only on it. Main runs each in that thread's own lane, so an
 * action on one thread never waits on an action on another, nor on the global lane. The window reads the
 * same set to send them straight to main rather than behind its own global chain, so the two agree by
 * construction.
 *
 * Everything else keeps the one global lane, including commands that carry a `threadId` but reach
 * past the thread they name:
 * - `assign`, `unassign`, `resume`, `pause` move assignment authority and hand the single composer
 *   draft to or from management, which supervision reads across every thread.
 * - `recover-draft` and `resume-draft` rebind that same single composer draft.
 * - `create-thread` has no existing thread to key a lane on, and it also takes the selection.
 * - `settle-project` and `restore-project` move every thread of a project at once.
 * The thread-scoped commands that never enter a lane at all are `LANELESS_THREAD_COMMAND_TYPES`, below.
 */
export const THREAD_SCOPED_COMMAND_TYPES: ReadonlySet<AgentCommand['type']> = new Set<AgentCommand['type']>([
  'manual-send', 'steer', 'steer-followup', 'answer', 'configure-thread-working-copy', 'configure-thread', 'compact-thread',
  'settle-thread', 'restore-thread', 'retry-thread-worktree', 'refresh-thread-worktree', 'open-thread-folder', 'restore-thread-branch',
  'reclaim-thread-worktree', 'load-earlier-messages',
])

/**
 * The commands that name one thread and never enter a lane at all: Stop, selection, the thread's saved
 * draft, its skills catalog and its follow-up queue edits. Main answers each one before it chooses a lane,
 * which is already the behaviour `THREAD_SCOPED_COMMAND_TYPES` gives the rest, so none of them waits on the
 * global lane or on another thread. The window reads this set beside that one and sends both straight to
 * main.
 */
export const LANELESS_THREAD_COMMAND_TYPES: ReadonlySet<AgentCommand['type']> = new Set<AgentCommand['type']>([
  'interrupt', 'select-thread', 'save-thread-draft', 'refresh-thread-skills',
  'queue-followup', 'edit-followup', 'remove-followup', 'reorder-followups', 'resume-followups',
])
