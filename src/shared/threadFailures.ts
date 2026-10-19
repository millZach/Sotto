import type { AgentThread } from './agents'
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
