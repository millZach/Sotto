import React, { useState, type ReactNode } from 'react'
import { ArrowUp } from 'lucide-react'
import { capabilitiesForThread, type AgentState } from '../../../shared/agents'
import { isThreadClosed } from '../../../shared/threadActivity'
import { Button } from '../components/Button'
import type { AgentConnection } from './AgentContext'
import { composerEnterIntent, readComposerKey } from './composerKeys'
import { ProviderMark } from './ProviderMark'
import { ScreenshotInput } from './ScreenshotInput'
import { deliveryFor, deliveryPending, hasDraftContent, submissionStatus, useSubmissions, useThreadComposer, type ThreadDraftStore } from './threadDraftStore'
import type { ThreadRow } from './threadFacts'
import { ThreadOptions } from './ThreadOptions'

type Command = AgentConnection['command']

export const THREAD_PROMPT_ID = 'thread-workspace-prompt'

/** A thread with a prompt still on its way cannot take another: a new send would only reconcile the earlier one. */
export function threadSendInFlight(state: AgentState, threadId: string, localUnresolved: boolean): boolean {
  return localUnresolved || state.deliveries?.some(item => item.threadId === threadId && deliveryPending(item.status)
    && !state.deliveredDrafts?.some(receipt => receipt.threadId === threadId && receipt.draftId === item.draftId)) === true
}

/** Send one revision of a thread's manual prompt. The pending message renders before the command leaves the renderer. */
export async function sendThreadRevision(store: ThreadDraftStore, row: ThreadRow, command: Command, submittedAt: number): Promise<void> {
  const threadId = row.thread.id
  const draft = store.submit(threadId, submittedAt)
  if (draft === null) return
  let attempted = false
  try {
    if (row.assignment?.mode === 'managed' && isThreadClosed(row.thread)) {
      const released = await command({ type: 'unassign', threadId })
      if (released === null || released.error !== null) { store.resolve(threadId, draft.draftId, released?.error ?? 'Could not release this thread from management.', true); return }
      if (store.draft(threadId).draftId !== draft.draftId) {
        store.resolve(threadId, draft.draftId, 'Your draft changed while stopping management. Send the newer draft when ready.', true)
        return
      }
    }
    attempted = true
    const result = await command({ type: 'manual-send', threadId, draftId: draft.draftId, text: draft.text, ...(draft.attachments.length ? { attachments: [...draft.attachments] } : {}) })
    store.resolve(threadId, draft.draftId, result === null ? 'Sotto could not confirm this send.' : result.error)
  } catch {
    store.resolve(threadId, draft.draftId, attempted ? 'Sotto could not confirm this send.' : 'Could not release this thread from management.', !attempted)
  }
}

/** Why the send button is off, in one sentence; null when a prompt can go. */
function blockedReason(row: ThreadRow, state: AgentState, answering: boolean, inFlight: boolean): string | null {
  if (row.thread.archivedAt) return 'This thread is archived.'
  if (row.request?.kind === 'permission') return 'Allow or deny the request above to continue.'
  if (!row.connected) return `${row.provider} is disconnected. Your draft is saved; reconnect to send.`
  if (!capabilitiesForThread(state.host, row.thread).submit) return `${row.provider} cannot take prompts from Sotto.`
  if (!answering && row.thread.status === 'running') return 'You can send after this turn finishes.'
  if (!answering && inFlight) return 'Waiting for your last prompt to be confirmed.'
  if (state.busy) return 'Sotto is finishing another action.'
  return null
}

/**
 * The manual prompt (or answer) composer for one thread. Content is the thread's durable draft:
 * every edit is a new revision, Enter sends, Shift+Enter adds a line, and an unsent or unconfirmed
 * prompt stays in the composer until the provider accepts that exact revision.
 */
export function ThreadComposer({ row, state, command, store, onSend }: {
  readonly row: ThreadRow
  readonly state: AgentState
  readonly command: Command
  readonly store: ThreadDraftStore
  /** The user sent from this composer; the transcript follows to the newest message. */
  readonly onSend: () => void
}): ReactNode {
  const threadId = row.thread.id
  const { draft, save, saveError } = useThreadComposer(store, threadId)
  const submissions = useSubmissions(store)
  const [readingImages, setReadingImages] = useState(false)
  const [answerState, setAnswerState] = useState<{ readonly sending: boolean; readonly error: string | null }>({ sending: false, error: null })
  const question = row.request?.kind === 'question' && row.request.requestId ? row.request : undefined
  const permission = row.request?.kind === 'permission'
  const staleAnswer = draft.requestId !== null && draft.requestId !== question?.requestId
  const answering = question !== undefined
  const localUnresolved = submissions.some(item => item.threadId === threadId && deliveryPending(submissionStatus(item, state).status))
  const inFlight = threadSendInFlight(state, threadId, localUnresolved)
  const reason = blockedReason(row, state, answering, inFlight) ?? (staleAnswer ? 'This answer’s question is no longer pending.' : null)
  const editable = !row.thread.archivedAt && !permission
  const content = hasDraftContent(draft)
  const submission = submissions.find(item => item.threadId === threadId && item.draftId === draft.draftId)
  const delivery = submission === undefined ? deliveryFor(state, threadId, draft.draftId) : undefined
  const canSend = reason === null && content && !readingImages && !answerState.sending

  const edit = (patch: Parameters<ThreadDraftStore['edit']>[1]): void => {
    store.edit(threadId, question ? { ...patch, requestId: question.requestId! } : patch)
    if (answerState.error) setAnswerState({ sending: false, error: null })
  }
  const send = (submittedAt: number): void => {
    if (!canSend) return
    if (question?.requestId) {
      if (draft.requestId !== question.requestId) store.edit(threadId, { requestId: question.requestId })
      const answer = store.submit(threadId, submittedAt)
      if (answer === null) return
      store.dismiss(threadId, answer.draftId)
      setAnswerState({ sending: true, error: null })
      void command({ type: 'answer', threadId, requestId: question.requestId, answer: answer.text })
        .then(result => setAnswerState({ sending: false, error: result === null ? 'Sotto could not confirm this answer. It is still in the composer.' : result.error }),
          () => setAnswerState({ sending: false, error: 'Sotto could not confirm this answer. It is still in the composer.' }))
      return
    }
    onSend()
    void sendThreadRevision(store, row, command, submittedAt)
  }

  const status = saveError !== null && save === 'unsaved'
    ? <span className="thread-prompt__status" data-tone="warning" role="alert">Draft not saved. <button type="button" className="thread-prompt__link tt-focusable" onClick={() => store.flush(threadId, true)}>Save again</button></span>
    : answerState.error ? <span className="thread-prompt__status" data-tone="warning" role="alert">{answerState.error}</span>
      : answerState.sending ? <span className="thread-prompt__status" role="status">Sending answer…</span>
        : delivery?.status === 'failed' ? <span className="thread-prompt__status" data-tone="warning">Your last send of this prompt did not go through. Send it again when ready.</span>
          : delivery?.status === 'uncertain' ? <span className="thread-prompt__status" data-tone="warning">The provider has not confirmed this prompt. It will not be sent twice.</span>
            : delivery?.status === 'queued' || delivery?.status === 'submitting' ? <span className="thread-prompt__status" role="status">Sending…</span>
              : reason !== null && (content || !row.connected) ? <span className="thread-prompt__status">{reason}</span>
                : <span className="thread-prompt__status thread-prompt__hint">{content ? (save === 'saving' ? 'Saving draft…' : 'Draft saved') : answering ? 'Enter to send your answer' : 'Enter to send · Shift+Enter for a new line'}</span>

  return <form className="thread-prompt" data-answering={answering || undefined} onSubmit={event => { event.preventDefault(); send(performance.now()) }}>
    {staleAnswer ? <div className="thread-prompt__notice" role="status"><span>This answer was for a question that is no longer pending.</span>
      <Button variant="secondary" onClick={() => store.edit(threadId, { text: '', attachments: [], requestId: null })}>Discard answer</Button></div> : null}
    <label className="tt-visually-hidden" htmlFor={THREAD_PROMPT_ID}>{answering ? 'Your answer' : 'Prompt'}</label>
    <ScreenshotInput key={threadId} attachments={[...draft.attachments]} disabled={!editable} supported={row.model?.supportsImages === true && !answering && !permission}
      onReadingChange={setReadingImages} onChange={attachments => edit({ attachments })}>
      <textarea id={THREAD_PROMPT_ID} rows={3} value={draft.text} disabled={!editable} spellCheck
        aria-describedby={`${THREAD_PROMPT_ID}-status`}
        placeholder={row.thread.archivedAt ? 'This thread is archived.' : permission ? 'Allow or deny the request above to continue.' : answering ? 'Write your answer…' : 'What would you like to do next?'}
        onChange={event => edit({ text: event.target.value })}
        onKeyDown={event => {
          const intent = composerEnterIntent(readComposerKey(event))
          if (intent !== 'send') return
          // Enter never inserts a stray newline, even when sending is blocked.
          event.preventDefault()
          send(performance.now())
        }} />
    </ScreenshotInput>
    <div className="thread-prompt__footer">
      <div className="thread-prompt__meta" id={`${THREAD_PROMPT_ID}-status`}>
        {row.thread.nativeSessionStarted === false || capabilitiesForThread(state.host, row.thread).configureThread
          ? <ThreadOptions key={threadId} thread={row.thread} state={state} command={command} />
          : <span className="thread-prompt__model"><ProviderMark provider={row.providerId} name={row.provider} />{row.model?.name ?? row.provider}<small>{answering ? 'Answer this question' : 'Manual prompt'}</small></span>}
        {status}
      </div>
      <Button iconOnly aria-label={answering ? 'Send answer' : 'Send prompt'} title={reason ?? (answering ? 'Send answer' : 'Send prompt')} disabled={!canSend} type="submit"><ArrowUp size={18} /></Button>
    </div>
  </form>
}
