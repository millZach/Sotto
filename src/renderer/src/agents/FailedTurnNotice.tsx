import React, { type ReactNode } from 'react'
import { CircleAlert } from 'lucide-react'
import type { AgentActivity } from '../../../shared/agentActivity'
import type { AgentThread } from '../../../shared/agents'
import { isThreadClosed } from '../../../shared/threadActivity'
import { isTurnRecord } from './threadActivityView'

/**
 * Why a thread's last turn failed, said once in its pane for as long as the thread stands failed (ADR-0092), whether or
 * not a client has seen it: opening it later still explains the Turn failed line. The reason is the failed turn's own,
 * the error its turn record carries, never the provider's latest error, which may belong to another thread.
 *
 * `transcript`: the failed turn's line in the transcript already says the reason, so nothing else repeats it and the
 * pane's error banner stays down when it would say the same. `notice`: the transcript has no reason to show, so the pane
 * says what it knows above the composer. Null when the thread is not failed, waits on a request, has a request notice of
 * its own, or its history has not arrived yet.
 */
export type FailedTurnExplanation =
  | { readonly kind: 'transcript'; readonly reason: string }
  | { readonly kind: 'notice'; readonly title: string; readonly body: string }

type Explained = Pick<AgentThread, 'status' | 'requests' | 'requestNotice' | 'historyStatus' | 'activities' | 'lastTurn' | 'settledAt' | 'settledOverride' | 'archivedAt'>

const NEXT = 'Nothing in the transcript was lost. Send a message to try again.'

/** The record of the thread's last turn: the one its provider names, otherwise the newest turn record. */
function lastTurnRecord(thread: Pick<AgentThread, 'activities' | 'lastTurn'>): AgentActivity | undefined {
  const turns = (thread.activities ?? []).filter(isTurnRecord)
  const anchor = thread.lastTurn?.messageId ?? thread.lastTurn?.id
  return (anchor === undefined ? undefined : turns.findLast(record => record.turnId === anchor)) ?? turns.at(-1)
}

export function failedTurnExplanation(thread: Explained, provider: string): FailedTurnExplanation | null {
  if (thread.status !== 'error' || thread.requests.length > 0 || isThreadClosed(thread)) return null
  // A request the provider sent that Sotto could not show says why in its own alert.
  if (thread.requestNotice) return null
  if (thread.historyStatus === 'loading') return null
  const turn = lastTurnRecord(thread)
  if (turn?.status === 'failed' && turn.error) return { kind: 'transcript', reason: turn.error }
  if (turn?.status === 'failed') return { kind: 'notice', title: 'The last turn failed.', body: NEXT }
  return { kind: 'notice', title: `${provider} reported an error on this thread.`, body: NEXT }
}

/** The notice above the composer when the transcript cannot say why the last turn failed. Quiet: it announces nothing. */
export function FailedTurnNotice({ explanation }: { readonly explanation: FailedTurnExplanation | null }): ReactNode {
  if (explanation?.kind !== 'notice') return null
  return <div className="thread-failed-notice">
    <CircleAlert className="thread-failed-notice__icon" size={15} aria-hidden="true" />
    <p><strong>{explanation.title}</strong> {explanation.body}</p>
  </div>
}
