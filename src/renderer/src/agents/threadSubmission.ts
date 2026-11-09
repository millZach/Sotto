import type { AgentConnection } from './AgentContext'
import type { ThreadRow } from './threadFacts'
import { queuedRevision, UNCONFIRMED_SUBMISSION, type SubmissionMode, type ThreadDraftStore } from './threadDraftStore'
import { attachmentRefusal } from './attachmentWords'

type Command = AgentConnection['command']

/**
 * Send, queue or steer one revision of a thread's manual prompt. The echo in the transcript (or the
 * queue row) renders before the command leaves the renderer, and the composer is already empty.
 * With `retryDraftId` the prompt is sent again from its own copy, under the revision it already has.
 * Resolves true when main took it, false when it was refused, and null when main's answer never came.
 */
export async function sendThreadRevision(store: ThreadDraftStore, row: ThreadRow, command: Command, submittedAt: number, mode: SubmissionMode = 'send', retryDraftId?: string,
  /** A step before the prompt goes, given its draft: Watcher's handover is told which draft carries it. A refusal keeps the prompt back. */
  beforeSend?: (draftId: string) => Promise<string | null>): Promise<boolean | null> {
  const threadId = row.thread.id
  const draft = retryDraftId === undefined ? store.submit(threadId, submittedAt, mode, 'main') : store.retry(threadId, retryDraftId, submittedAt)
  if (draft === null) return false
  try {
    const refused = beforeSend === undefined ? null : await beforeSend(draft.draftId)
    // Refused before it left the window: it is back in the composer, with why under it.
    if (refused !== null) { store.resolve(threadId, draft.draftId, refused, true); return false }
    const payload = {
      threadId, draftId: draft.draftId, text: draft.text,
      ...(draft.attachments.length ? { attachments: [...draft.attachments] } : {}),
      ...(draft.skills.length ? { skills: [...draft.skills] } : {}),
      ...(draft.files?.length ? { files: [...draft.files] } : {}),
    }
    const result = await command(mode === 'queue' ? { type: 'queue-followup', ...payload } : mode === 'steer' ? { type: 'steer', ...payload } : { type: 'manual-send', ...payload })
    // Exact queue ownership wins an unrelated shell error, even before its publication reaches the draft store.
    const error = result === null ? UNCONFIRMED_SUBMISSION[mode]
      : mode === 'queue' && queuedRevision(result, threadId, draft.draftId) ? null : result.error === null ? null : attachmentRefusal(result.error)
    store.resolve(threadId, draft.draftId, error)
    return result === null ? null : error === null
  } catch {
    store.resolve(threadId, draft.draftId, UNCONFIRMED_SUBMISSION[mode])
    return null
  }
}
