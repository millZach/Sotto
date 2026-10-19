import React, { type ReactNode } from 'react'
import { CircleAlert } from 'lucide-react'
import type { AgentThread, ProviderId } from '../../../shared/agents'
import { isThreadClosed } from '../../../shared/threadActivity'
import { failedTurnReason, THREAD_RESUME_FAILURES } from '../../../shared/threadFailures'

/**
 * Why a thread's last turn failed, said once in its pane for as long as the thread stands failed (ADR-0092), whether or
 * not a client has seen it: opening it later still explains the Turn failed line. The reason is the failed turn's own,
 * the error its turn record carries, never the provider's latest error, which may belong to another thread.
 *
 * `transcript`: the failed turn's line in the transcript already says the reason. `notice`: the transcript has no reason
 * to show, so the pane says what it knows above the composer: the reason the host published with the failure, or, for a
 * thread that could not be resumed, the provider's own words for that, otherwise only that it failed. Either way the
 * pane's error banner stands down when it is about a thread failing (`isThreadFailureText`), so the reason is said once.
 * Null when the thread is not failed, waits on a request, has a request notice of its own, or its history has not
 * arrived yet.
 */
export type FailedTurnExplanation =
  | { readonly kind: 'transcript'; readonly reason: string }
  | { readonly kind: 'notice'; readonly title: string; readonly body: string }

type Explained = Pick<AgentThread, 'status' | 'requests' | 'requestNotice' | 'historyStatus' | 'activities' | 'lastTurn' | 'failureReason'
  | 'settledAt' | 'settledOverride' | 'archivedAt'>

const NEXT = 'Nothing in the transcript was lost. Send a message to try again.'

/**
 * `providerId` and `banner` let a thread that could not be resumed, which records no turn, give the provider's own words
 * for that as its reason: the banner is the only place they are.
 */
export function failedTurnExplanation(thread: Explained, provider: string, providerId?: ProviderId | undefined, banner?: string | null): FailedTurnExplanation | null {
  if (thread.status !== 'error' || thread.requests.length > 0 || isThreadClosed(thread)) return null
  // A request the provider sent that Sotto could not show says why in its own alert.
  if (thread.requestNotice) return null
  if (thread.historyStatus === 'loading') return null
  const reason = failedTurnReason(thread)
  if (reason !== undefined) return { kind: 'transcript', reason }
  const turnFailed = thread.lastTurn?.status === 'failed' || (thread.activities ?? []).findLast(record => record.kind === 'turn')?.status === 'failed'
  const title = turnFailed ? 'The last turn failed.' : `${provider} reported an error on this thread.`
  if (thread.failureReason) return { kind: 'notice', title, body: `${thread.failureReason} Nothing in the transcript was lost.` }
  if (!turnFailed && banner && providerId !== undefined && THREAD_RESUME_FAILURES[providerId]?.includes(banner)) {
    return { kind: 'notice', title, body: `${banner} Nothing in the transcript was lost.` }
  }
  return { kind: 'notice', title, body: NEXT }
}

/** The notice above the composer when the transcript cannot say why the last turn failed. Quiet: it announces nothing. */
export function FailedTurnNotice({ explanation }: { readonly explanation: FailedTurnExplanation | null }): ReactNode {
  if (explanation?.kind !== 'notice') return null
  return <div className="thread-failed-notice">
    <CircleAlert className="thread-failed-notice__icon" size={15} aria-hidden="true" />
    <p><strong>{explanation.title}</strong> {explanation.body}</p>
  </div>
}
