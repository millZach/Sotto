import React, { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, ListPlus, Square } from 'lucide-react'
import { capabilitiesForThread, type AgentState } from '../../../shared/agents'
import { isThreadClosed } from '../../../shared/threadActivity'
import { Button } from '../components/Button'
import type { AgentConnection } from './AgentContext'
import { composerEnterIntent, readComposerKey, skillMenuKeyAction } from './composerKeys'
import { insertSkill, retainSkillReferences, sameSkillReferences, skillLimitReached, skillSigils } from './composerSkills'
import { ProviderMark } from './ProviderMark'
import { requestMode } from './requests/requestAnswers'
import { ScreenshotInput } from './ScreenshotInput'
import { SkillPicker, skillOptionId, useSkillPicker } from './SkillPicker'
import { deliveryFor, deliveryPending, hasDraftContent, queueAdmissionOpen, queuedRevision, submissionStatus, UNCONFIRMED_SUBMISSION, useSubmissions, useThreadComposer, type SubmissionMode, type SubmissionStatus, type ThreadDraftStore } from './threadDraftStore'
import type { ThreadRow } from './threadFacts'
import { followupsFor, ThreadFollowups } from './ThreadFollowups'
import { ThreadOptions } from './ThreadOptions'
import './composer.css'

type Command = AgentConnection['command']

export const THREAD_PROMPT_ID = 'thread-workspace-prompt'

/**
 * A thread with a prompt still on its way cannot take another: a new send would only reconcile the earlier one.
 * With `besideQueue`, a follow-up the queue owns does not count, so a later revision can line up behind it.
 */
export function threadSendInFlight(state: AgentState, threadId: string, localUnresolved: boolean, besideQueue = false): boolean {
  return localUnresolved || state.deliveries?.some(item => item.threadId === threadId && deliveryPending(item.status)
    && !state.deliveredDrafts?.some(receipt => receipt.threadId === threadId && receipt.draftId === item.draftId)
    // Beside the queue, only an unconfirmed prompt holds: one main has admitted and is still delivering can have the queue behind it.
    && !(besideQueue && (queuedRevision(state, threadId, item.draftId) || deliveryOnItsWay(item.status)))) === true
}

/** Main admitted the prompt and is delivering it now. Nothing about it is unconfirmed yet; `uncertain` is. */
function deliveryOnItsWay(status: SubmissionStatus): boolean {
  return status === 'queued' || status === 'submitting'
}

/**
 * Whether the composer's next revision goes to the thread's follow-up queue: while a turn runs, and
 * behind anything already queued so the order the user typed is the order the provider receives.
 */
export function queuesByDefault(row: ThreadRow, state: AgentState, localAdmissions: boolean): boolean {
  return row.thread.status === 'running' || localAdmissions || followupsFor(state, row.thread.id).length > 0
}

/**
 * Send, queue or steer one revision of a thread's manual prompt. The pending message (or queue row)
 * renders before the command leaves the renderer.
 */
export async function sendThreadRevision(store: ThreadDraftStore, row: ThreadRow, command: Command, submittedAt: number, mode: SubmissionMode = 'send'): Promise<void> {
  const threadId = row.thread.id
  const draft = store.submit(threadId, submittedAt, mode)
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
    const payload = {
      threadId, draftId: draft.draftId, text: draft.text,
      ...(draft.attachments.length ? { attachments: [...draft.attachments] } : {}),
      ...(draft.skills.length ? { skills: [...draft.skills] } : {}),
    }
    const result = await command(mode === 'queue' ? { type: 'queue-followup', ...payload } : mode === 'steer' ? { type: 'steer', ...payload } : { type: 'manual-send', ...payload })
    store.resolve(threadId, draft.draftId, result === null ? UNCONFIRMED_SUBMISSION[mode] : result.error)
  } catch {
    store.resolve(threadId, draft.draftId, attempted ? UNCONFIRMED_SUBMISSION[mode] : 'Could not release this thread from management.', !attempted)
  }
}

const PERMISSION_INSTRUCTION = 'Allow or deny the request above to continue.'

/** Every pending permission offers no choice Sotto can send (`permissionChoices: []`): only the provider's app can answer. */
function permissionsOnlyInProvider(row: ThreadRow): boolean {
  const permissions = row.thread.requests.filter(request => request.kind === 'permission')
  return permissions.length > 0 && permissions.every(request => request.permissionChoices?.length === 0)
}

/** Why the primary action is off, in one sentence; null when a prompt can go. */
function blockedReason(row: ThreadRow, state: AgentState, answering: boolean, inFlight: boolean): string | null {
  if (row.thread.archivedAt) return 'This thread is archived.'
  const permission = row.request?.kind === 'permission' || row.thread.requests.some(request => request.kind === 'permission')
  if (permission && permissionsOnlyInProvider(row)) return `Sending returns once the request above is answered in ${row.provider}’s app.`
  if (permission) return PERMISSION_INSTRUCTION
  // Choices shown in the transcript are answered there; only a plain question takes its answer from the composer.
  const inline = row.thread.requests.find(request => requestMode(request) !== 'legacy-text')
  if (inline && !answering) return inline.kind === 'permission' ? 'Answer the request above to continue.' : 'Answer the question above to continue.'
  if (!row.connected) return 'Reconnect to send. Your draft stays here.'
  if (!capabilitiesForThread(state.host, row.thread).submit) return `${row.provider} cannot take prompts from Sotto.`
  // The notice above the composer says why setup stopped and offers the one recovery; this only says when sending returns.
  if (row.thread.worktree?.status === 'pending' || row.thread.worktree?.status === 'error') return 'Available once the working folder is ready.'
  if (!answering && inFlight) return 'Waiting for your last prompt to be confirmed.'
  return null
}

/**
 * The manual prompt (or answer) composer for one thread. Content is the thread's durable draft:
 * every edit is a new revision, Enter sends, Shift+Enter adds a line, and an unsent or unconfirmed
 * prompt stays in the composer until the provider (or the thread's queue) owns that exact revision.
 * While a turn runs, Enter queues; Steer now is the separate, explicit way into the running turn, and Stop
 * takes the send button's place until there is something to queue.
 */
export function ThreadComposer({ row, state, command, store, onSend, composerId = THREAD_PROMPT_ID, handingOff = false }: {
  readonly row: ThreadRow
  readonly state: AgentState
  readonly command: Command
  readonly store: ThreadDraftStore
  /** The user sent from this composer; the transcript follows to the newest message. */
  readonly onSend: () => void
  /** Unique per visible composer; the textarea, status and skills list IDs derive from it. */
  readonly composerId?: string
  /** Manage or Resume is carrying this draft to Sotto; sending it meanwhile would race the handoff. Typing stays open. */
  readonly handingOff?: boolean
}): ReactNode {
  const threadId = row.thread.id
  const { draft, save, saveError } = useThreadComposer(store, threadId)
  const submissions = useSubmissions(store)
  const [readingImages, setReadingImages] = useState(false)
  const [answerState, setAnswerState] = useState<{ readonly sending: boolean; readonly error: string | null }>({ sending: false, error: null })
  const textarea = useRef<HTMLTextAreaElement>(null)
  const caretAfterInsert = useRef<number | null>(null)
  const pendingRequest = row.request?.requestId === undefined ? undefined : row.thread.requests.find(request => request.id === row.request!.requestId)
  const question = row.request?.kind === 'question' && row.request.requestId && (pendingRequest === undefined || requestMode(pendingRequest) === 'legacy-text') ? row.request : undefined
  const permission = row.request?.kind === 'permission' || row.thread.requests.some(request => request.kind === 'permission')
  const staleAnswer = draft.requestId !== null && draft.requestId !== question?.requestId
  const answering = question !== undefined
  const capabilities = capabilitiesForThread(state.host, row.thread)
  const direct = submissions.filter(item => item.threadId === threadId && item.mode !== 'queue').map(item => submissionStatus(item, state).status)
  const localUnresolved = direct.some(deliveryPending)
  // Before main has published its admission, and once a delivery is uncertain, even the queue waits.
  const localUnconfirmed = submissions.some(item => item.threadId === threadId && item.mode !== 'queue' && deliveryPending(submissionStatus(item, state).status)
    && !deliveryOnItsWay(deliveryFor(state, threadId, item.draftId)?.status ?? 'uncertain'))
  const localAdmissions = submissions.some(item => item.threadId === threadId && queueAdmissionOpen(item, state) && !(item.resolved && item.error !== null))
  const sendInFlight = threadSendInFlight(state, threadId, localUnresolved)
  // A follow-up already on its way belongs to the queue, and a later revision can line up behind it; so can
  // one behind a direct send main is still delivering. A direct send or steer still unconfirmed holds
  // everything: retyped, it could reach the provider twice.
  const queueBlocked = threadSendInFlight(state, threadId, localUnconfirmed, true)
  // Enter behind a prompt on its way queues instead of being refused, so the order typed is the order sent.
  const queueing = !answering && (queuesByDefault(row, state, localAdmissions) || sendInFlight && !queueBlocked)
  const submission = submissions.find(item => item.threadId === threadId && item.draftId === draft.draftId)
  const delivery = submission === undefined ? deliveryFor(state, threadId, draft.draftId) : undefined
  const admitting = submission?.mode === 'queue' && !submission.resolved
  const reason = (handingOff ? 'Handing this draft to Sotto…' : null) ?? blockedReason(row, state, answering, queueing ? queueBlocked : sendInFlight) ?? (staleAnswer ? 'This answer’s question is no longer pending.' : null)
  const editable = !row.thread.archivedAt && !permission
  const working = row.thread.status === 'running' && !isThreadClosed(row.thread)
  const placeholder = row.thread.archivedAt ? 'This thread is archived.' : permission ? permissionsOnlyInProvider(row) ? 'Waiting on the request above.' : PERMISSION_INSTRUCTION : answering ? 'Write your answer…' : working ? `${row.provider} is working. Write a follow-up to queue it.` : 'What would you like to do next?'
  const content = hasDraftContent(draft)
  const canSend = reason === null && content && !readingImages && !answerState.sending && !admitting
  const running = row.thread.status === 'running' && !answering
  // Steering is a direct delivery: it waits for any prompt still on its way, the queue's included.
  const canSteer = running && capabilities.steer === true && canSend && !sendInFlight
  const canStop = working && capabilities.interrupt === true && row.connected && !state.busy
  const picker = useSkillPicker({ threadId, state, command, enabled: editable && !answering && capabilities.skills === true, text: draft.text })
  const sigils = skillSigils(picker.catalog?.providerId ?? row.providerId)
  const listId = `${composerId}-skills`
  const statusId = `${composerId}-status`

  useLayoutEffect(() => {
    const caret = caretAfterInsert.current
    if (caret === null || textarea.current === null || textarea.current.value !== draft.text) return
    caretAfterInsert.current = null
    textarea.current.setSelectionRange(caret, caret)
    picker.track(textarea.current)
  })

  const edit = (patch: Parameters<ThreadDraftStore['edit']>[1]): void => {
    store.edit(threadId, question ? { ...patch, requestId: question.requestId! } : patch)
    if (answerState.error) setAnswerState({ sending: false, error: null })
  }
  const editText = (text: string): void => {
    // A deleted `$name` takes its selected skill with it before the revision is saved or sent.
    const skills = retainSkillReferences(text, draft.skills, sigils)
    edit(sameSkillReferences(skills, draft.skills) ? { text } : { text, skills })
  }
  const send = (submittedAt: number, mode: SubmissionMode = queueing ? 'queue' : 'send'): void => {
    if (mode === 'steer' ? !canSteer : !canSend) return
    // Sent from a button, which the emptied draft is about to disable: the next prompt starts where the last was written.
    const field = textarea.current
    if (field !== null && document.activeElement !== field && field.form?.contains(document.activeElement)) field.focus()
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
    // A queued revision stays out of the transcript, so only a delivery moves the reader to the end.
    if (mode !== 'queue') onSend()
    void sendThreadRevision(store, row, command, submittedAt, mode)
  }
  const selectSkill = (index: number): void => {
    const skill = picker.options[index]
    if (skill === undefined || picker.trigger === null || skillLimitReached(draft.skills, skill, picker.catalog?.maxSkillsPerMessage)) return
    const next = insertSkill(draft.text, picker.trigger, skill, draft.skills, sigils)
    caretAfterInsert.current = next.caret
    edit({ text: next.text, skills: next.skills })
    textarea.current?.focus()
  }

  const status = saveError !== null && save === 'unsaved'
    ? <span className="thread-prompt__status" data-tone="warning" role="alert">Draft not saved. <button type="button" className="thread-prompt__link tt-focusable" onClick={() => store.flush(threadId, true)}>Save again</button></span>
    : answerState.error ? <span className="thread-prompt__status" data-tone="warning" role="alert">{answerState.error}</span>
      : answerState.sending ? <span className="thread-prompt__status" role="status">Sending answer…</span>
        // A blocked composer states only why, and not again when its empty prompt already says it; the transcript explains an unconfirmed prompt.
        : reason !== null ? reason === placeholder ? null : <span className="thread-prompt__status">{reason}</span>
          // Saving, queueing and a working agent get no caption: the placeholder and buttons already show them.
          : delivery?.status === 'failed' ? <span className="thread-prompt__status" data-tone="warning">Your last send of this prompt did not go through. Send it again when ready.</span> : null
  const primaryLabel = answering ? 'Send answer' : queueing ? 'Queue prompt' : 'Send prompt'

  return <>
    <ThreadFollowups row={row} state={state} command={command} store={store} onRetryAdmission={() => send(performance.now(), 'queue')} />
    <form className="thread-prompt" data-thread-id={threadId} data-answering={answering || undefined} data-running={working || undefined} data-picker={picker.open || undefined}
      onSubmit={event => { event.preventDefault(); send(performance.now()) }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) picker.leave() }}>
      {staleAnswer ? <div className="thread-prompt__notice" role="status"><span>This answer was for a question that is no longer pending.</span>
        <Button variant="secondary" onClick={() => store.edit(threadId, { text: '', attachments: [], skills: [], requestId: null })}>Discard answer</Button></div> : null}
      <SkillPicker model={picker} listId={listId} provider={row.provider} selected={draft.skills} onSelect={skill => selectSkill(picker.options.indexOf(skill))} />
      <label className="tt-visually-hidden" htmlFor={composerId}>{answering ? 'Your answer' : 'Prompt'}</label>
      <ScreenshotInput key={threadId} attachments={[...draft.attachments]} disabled={!editable} supported={row.model?.supportsImages === true && !answering && !permission}
        onReadingChange={setReadingImages} onChange={attachments => edit({ attachments })}>
        <textarea ref={textarea} id={composerId} rows={3} value={draft.text} disabled={!editable} spellCheck
          aria-describedby={statusId}
          aria-autocomplete={capabilities.skills === true && !answering ? 'list' : undefined}
          aria-controls={picker.open && picker.options.length ? listId : undefined}
          aria-expanded={capabilities.skills === true && !answering ? picker.open : undefined}
          aria-activedescendant={picker.open && picker.activeIndex !== null ? skillOptionId(listId, picker.activeIndex) : undefined}
          placeholder={placeholder}
          onChange={event => { editText(event.target.value); picker.track(event.target) }}
          onSelect={event => picker.track(event.currentTarget)}
          onKeyDown={event => {
            // Without the skills list, an open menu is still told by aria-expanded.
            const key = readComposerKey(event, capabilities.skills === true && !answering ? picker.open && picker.activeIndex !== null : undefined)
            if (picker.open) {
              const action = skillMenuKeyAction({ ...key, ctrlKey: event.ctrlKey, metaKey: event.metaKey }, { optionCount: picker.options.length, highlighted: picker.activeIndex !== null })
              if (action !== 'none') {
                event.preventDefault()
                if (action === 'next') picker.move(1)
                else if (action === 'previous') picker.move(-1)
                else if (action === 'close') picker.close()
                else selectSkill(picker.activeIndex ?? 0)
                return
              }
            }
            if (composerEnterIntent(key) !== 'send') return
            // Enter never inserts a stray newline, even when sending is blocked.
            event.preventDefault()
            send(performance.now())
          }} />
      </ScreenshotInput>
      <div className="thread-prompt__footer">
        <div className="thread-prompt__meta" id={statusId}>
          {row.thread.nativeSessionStarted === false || capabilities.configureThread
            ? <ThreadOptions key={threadId} thread={row.thread} state={state} command={command} turnNote={false} />
            : <span className="thread-prompt__model"><ProviderMark provider={row.providerId} name={row.provider} />{row.model?.name ?? row.provider}<small>{answering ? 'Answer this question' : 'Manual prompt'}</small></span>}
          {status}
        </div>
        <div className="thread-prompt__actions">
          {running && capabilities.steer === true
            ? <Button variant="secondary" className="thread-prompt__steer" disabled={!canSteer} title={canSteer ? 'Add this to the running turn now' : reason ?? undefined} onClick={() => send(performance.now(), 'steer')}>Steer now</Button>
            : null}
          {working ? <Button iconOnly className="thread-prompt__stop" data-beside={content || undefined} aria-label="Stop agent" title="Stop agent" disabled={!canStop} onClick={() => void command({ type: 'interrupt', threadId })}><Square size={13} fill="currentColor" aria-hidden="true" /></Button> : null}
          {/* With nothing to send, Stop holds the send button's place; typed text brings the send back to the end, so Enter's button is never Stop. */}
          {!working || content ? <Button iconOnly aria-label={primaryLabel} title={reason ?? primaryLabel} disabled={!canSend} type="submit">{queueing ? <ListPlus size={18} /> : <ArrowUp size={18} />}</Button> : null}
        </div>
      </div>
    </form>
  </>
}
