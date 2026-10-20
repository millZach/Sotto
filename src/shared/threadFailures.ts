import type { AgentActivity } from './agentActivity'
import type { AgentThread, ProviderId } from './agents'
import { isThreadClosed } from './threadActivity'

/**
 * What a failed thread is, for the host's record of failures seen, the sidebar and the Agents roster alike (ADR-0092):
 * one rule, written once.
 */

type Failed = Pick<AgentThread, 'status' | 'requests' | 'settledAt' | 'archivedAt' | 'settledOverride'>

/**
 * A thread whose last turn failed and that asks the user nothing. One that waits on a permission or a question is the
 * user's to answer (ADR-0004), so it is never one of these, and a closed thread needs nothing.
 */
export function failedWithoutRequest(thread: Failed): boolean {
  return thread.status === 'error' && thread.requests.length === 0 && !isThreadClosed(thread)
}

/** A failed thread that no client has shown since it failed and that Dismiss all has not named: it says Needs attention. */
export function failureUnseen(thread: Failed & Pick<AgentThread, 'failureSeen'>): boolean {
  return failedWithoutRequest(thread) && thread.failureSeen !== true
}

/** The record of the thread's last turn: the one its provider names, otherwise the newest turn record. */
export function lastTurnRecord(thread: Pick<AgentThread, 'activities' | 'lastTurn'>): AgentActivity | undefined {
  const turns = (thread.activities ?? []).filter(record => record.kind === 'turn')
  const anchor = thread.lastTurn?.messageId ?? thread.lastTurn?.id
  return (anchor === undefined ? undefined : turns.findLast(record => record.turnId === anchor)) ?? turns.at(-1)
}

/** The reason the thread's last turn failed, as its turn record says, or undefined when it says none. */
export function failedTurnReason(thread: Pick<AgentThread, 'activities' | 'lastTurn'>): string | undefined {
  const turn = lastTurnRecord(thread)
  return turn?.status === 'failed' && turn.error ? turn.error : undefined
}

/**
 * The words a provider puts in its own error when one of its threads could not be resumed or opened, which no turn
 * records. Each adapter reads its wording from here, so a pane can tell this kind of error from one about the provider's
 * own health (disconnected, signed out, client missing), which it always shows. A provider that gives its own reason
 * instead, as Devin can, is not listed.
 */
export const CLAUDE_RESUME_FAILED = 'A Claude thread could not resume. Check the native client.'
export const CLAUDE_RESUME_FAILED_SESSION = 'A Claude thread could not resume. Check its native session before sending again.'
export const DEVIN_OPEN_FAILED = 'A Devin session could not be opened. Your thread is kept. Check the native client and reconnect.'
export const THREAD_RESUME_FAILURES: Readonly<Partial<Record<ProviderId, readonly string[]>>> = {
  claude: [CLAUDE_RESUME_FAILED, CLAUDE_RESUME_FAILED_SESSION],
  devin: [DEVIN_OPEN_FAILED],
}

/**
 * Whether a provider's error is about a thread failing rather than about the provider itself: some thread's recorded
 * failed-turn reason, or a provider's wording for a thread it could not resume.
 */
export function isThreadFailureText(text: string, threads: readonly Pick<AgentThread, 'failureReason'>[]): boolean {
  return threads.some(thread => thread.failureReason === text) || Object.values(THREAD_RESUME_FAILURES).some(list => list?.includes(text))
}
