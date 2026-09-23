import React, { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, ListPlus, Square } from 'lucide-react'
import { capabilitiesForThread, isThreadBusy, type AgentState } from '../../../shared/agents'
import { isThreadClosed } from '../../../shared/threadActivity'
import { Button } from '../components/Button'
import type { AgentConnection } from './AgentContext'
import { composerEnterIntent, readComposerKey, runComposerMenuKey } from './composerKeys'
import { browseFolder, fileLimitReached, insertFile, retainFileReferences, sameFileReferences, type FileEntry } from './composerFiles'
import { composerFilesBridge, FilePicker, fileOptionId, useFilePicker } from './FilePicker'
import { insertSkill, retainSkillReferences, sameSkillReferences, skillLimitReached, skillSigils } from './composerSkills'
import { ProviderMark } from './ProviderMark'
import { requestMode } from './requests/requestAnswers'
import { ScreenshotInput } from './ScreenshotInput'
import { SkillPicker, skillOptionId, useSkillPicker } from './SkillPicker'
import { deliveryFor, deliveryPending, hasDraftContent, queueAdmissionOpen, queuedRevision, submissionStatus, UNCONFIRMED_SUBMISSION, useSubmissions, useThreadComposer, type SubmissionMode, type SubmissionStatus, type ThreadDraftStore } from './threadDraftStore'
import type { ThreadRow } from './threadFacts'
import { followupsFor, ThreadFollowups } from './ThreadFollowups'
import { ThreadOptions } from './ThreadOptions'
import { BranchToolbar } from './BranchToolbar'
import './composer.css'

type Command = AgentConnection['command']

export const THREAD_PROMPT_ID = 'thread-workspace-prompt'

/**
 * A thread with a prompt still on its way cannot take another: a new send would only reconcile the earlier one.
 * With `besideQueue`, a follow-up the queue owns does not count, so a later revision can line up behind it.
 */
function threadSendInFlight(state: AgentState, threadId: string, localUnresolved: boolean, besideQueue = false): boolean {
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
function queuesByDefault(row: ThreadRow, state: AgentState, localAdmissions: boolean): boolean {
  return row.thread.status === 'running' || localAdmissions || followupsFor(state, row.thread.id).length > 0
}

/**
 * Send, queue or steer one revision of a thread's manual prompt. The echo in the transcript (or the
 * queue row) renders before the command leaves the renderer, and the composer is already empty.
 * With `retryDraftId` the prompt is sent again from its own copy, under the revision it already has.
 */
export async function sendThreadRevision(store: ThreadDraftStore, row: ThreadRow, command: Command, submittedAt: number, mode: SubmissionMode = 'send', retryDraftId?: string): Promise<void> {
  const threadId = row.thread.id
  const draft = retryDraftId === undefined ? store.submit(threadId, submittedAt, mode) : store.retry(threadId, retryDraftId, submittedAt)
  if (draft === null) return
  let attempted = false
  try {
    if (row.assignment?.mode === 'managed' && isThreadClosed(row.thread)) {
      const released = await command({ type: 'unassign', threadId })
      if (released === null || released.error !== null) { store.resolve(threadId, draft.draftId, released?.error ?? 'Could not release this thread from management.', true); return }
    }
    attempted = true
    const payload = {
      threadId, draftId: draft.draftId, text: draft.text,
      ...(draft.attachments.length ? { attachments: [...draft.attachments] } : {}),
      ...(draft.skills.length ? { skills: [...draft.skills] } : {}),
      ...(draft.files?.length ? { files: [...draft.files] } : {}),
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
  // A pending checkout runs in the background after the thread opens; a prompt sent meanwhile waits for it.
  if (row.thread.worktree?.status === 'error') return 'Available once the working folder is ready.'
  if (!answering && inFlight) return 'Waiting for your last prompt to be confirmed.'
  return null
}

/**
 * The manual prompt (or answer) composer for one thread. Content is the thread's durable draft:
 * every edit is a new revision, Enter sends, Shift+Enter adds a line. The press empties the composer
 * and starts the next revision; what was sent is shown in the transcript, which says how it went and
 * offers it back if the provider refused it. While a turn runs, Enter queues; Steer now is the separate,
 * explicit way into the running turn, and Stop takes the send button's place until there is something to queue.
 */
export function ThreadComposer({ row, state, command, store, onSend, composerId = THREAD_PROMPT_ID, handingOff = false, ornament, focused = true, onExplainedError }: {
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
  /** Live observation drawn on the top edge without changing composer interaction. */
  readonly ornament?: ReactNode
  /** Whether this pane has the user's attention; the branch toolbar's shortcuts answer only for the one that does. */
  readonly focused?: boolean
  /** The branch toolbar's refusal, so the pane can leave its own error line out for it. */
  readonly onExplainedError?: ((error: string | null) => void) | undefined
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
  const reason = (handingOff ? 'Handing this draft to Sotto…' : null) ?? blockedReason(row, state, answering, queueing ? queueBlocked : sendInFlight) ?? (staleAnswer ? 'This answer’s question is no longer pending.' : null)
  const editable = !row.thread.archivedAt && !permission
  const working = row.thread.status === 'running' && !isThreadClosed(row.thread)
  const placeholder = row.thread.archivedAt ? 'This thread is archived.' : permission ? permissionsOnlyInProvider(row) ? 'Waiting on the request above.' : PERMISSION_INSTRUCTION : answering ? 'Write your answer…' : working ? (row.thread.compaction?.status === 'running' ? 'Compacting the context. Write a follow-up to queue it.' : `${row.provider} is working. Write a follow-up to queue it.`) : 'What would you like to do next?'
  const content = hasDraftContent(draft)
  const canSend = reason === null && content && !readingImages && !answerState.sending
  const running = row.thread.status === 'running' && !answering
  // Steering is a direct delivery: it waits for any prompt still on its way, the queue's included.
  const canSteer = running && capabilities.steer === true && canSend && !sendInFlight
  const canStop = working && capabilities.interrupt === true && row.connected && !isThreadBusy(state, threadId)
  const picker = useSkillPicker({ threadId, state, command, enabled: editable && !answering && capabilities.skills === true, text: draft.text })
  const sigils = skillSigils(picker.catalog?.providerId ?? row.providerId)
  // `@` browses the thread's working copy. A thread still waiting for its folder has nothing to list.
  const files = useFilePicker({ threadId, bridge: composerFilesBridge(), text: draft.text,
    enabled: editable && !answering && row.thread.worktree?.status !== 'pending' && row.thread.worktree?.status !== 'error' })
  const menuOpen = picker.open || files.open
  // A composer with neither menu leaves Enter and the combobox attributes exactly as they were.
  const menus = (capabilities.skills === true || files.enabled) && !answering
  const listId = `${composerId}-skills`
  const fileListId = `${composerId}-files`
  const statusId = `${composerId}-status`

  useLayoutEffect(() => {
    const caret = caretAfterInsert.current
    if (caret === null || textarea.current === null || textarea.current.value !== draft.text) return
    caretAfterInsert.current = null
    textarea.current.setSelectionRange(caret, caret)
    picker.track(textarea.current)
    files.track(textarea.current)
  })

  const edit = (patch: Parameters<ThreadDraftStore['edit']>[1]): void => {
    store.edit(threadId, question ? { ...patch, requestId: question.requestId! } : patch)
    if (answerState.error) setAnswerState({ sending: false, error: null })
  }
  const editText = (text: string): void => {
    // A deleted `$name` or `@path` takes its selection with it before the revision is saved or sent.
    const skills = retainSkillReferences(text, draft.skills, sigils)
    const mentioned = retainFileReferences(text, draft.files)
    edit({ text, ...(sameSkillReferences(skills, draft.skills) ? {} : { skills }), ...(sameFileReferences(mentioned, draft.files) ? {} : { files: mentioned }) })
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
      // The composer emptied on the press, so a refused answer comes back to it unless something newer is written.
      const failed = (error: string): void => {
        const restored = store.restoreDraft(threadId, answer, true) !== null
        setAnswerState({ sending: false, error: `${error}${restored ? ' It is back in the composer.' : ' Your newer draft is in the composer.'}` })
      }
      void command({ type: 'answer', threadId, requestId: question.requestId, answer: answer.text })
        .then(result => { if (result === null) failed('Sotto could not confirm this answer.'); else if (result.error !== null) failed(result.error); else setAnswerState({ sending: false, error: null }) },
          () => failed('Sotto could not confirm this answer.'))
      return
    }
    onSend()
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
  /** A folder keeps the picker browsing; a file is mentioned where the `@` token was written. */
  const selectFile = (index: number): void => {
    const entry = files.options[index]
    if (entry === undefined || files.trigger === null) return
    // At the cap the picker says so and the choice does nothing, rather than dropping it silently.
    if (entry.kind !== 'directory' && fileLimitReached(draft.files, entry.path)) return
    const next = entry.kind === 'directory'
      ? { ...browseFolder(draft.text, files.trigger, entry.path), files: draft.files }
      : insertFile(draft.text, files.trigger, entry.path, draft.files)
    caretAfterInsert.current = next.caret
    edit({ text: next.text, files: next.files })
    textarea.current?.focus()
  }

  const status = saveError !== null && save === 'unsaved'
    ? <span className="thread-prompt__status" data-tone="warning" role="alert">Draft not saved. <button type="button" className="thread-prompt__link tt-focusable" onClick={() => store.flush(threadId, true)}>Save again</button></span>
    : answerState.error ? <span className="thread-prompt__status" data-tone="warning" role="alert">{answerState.error}</span>
      : answerState.sending ? <span className="thread-prompt__status" role="status">Sending answer…</span>
        // A blocked composer states only why, and not again when its empty prompt already says it. Saving,
        // queueing and a working agent get no caption, and how a sent prompt went is told where it is shown.
        : reason !== null ? reason === placeholder ? null : <span className="thread-prompt__status">{reason}</span> : null
  const primaryLabel = answering ? 'Send answer' : queueing ? 'Queue prompt' : 'Send prompt'

  return <>
    <ThreadFollowups row={row} state={state} command={command} store={store}
      onRetryAdmission={draftId => { void sendThreadRevision(store, row, command, performance.now(), 'queue', draftId) }} />
    <form className="thread-prompt" data-ornament={Boolean(ornament) || undefined} data-thread-id={threadId} data-answering={answering || undefined} data-running={working || undefined} data-picker={menuOpen || undefined}
      onSubmit={event => { event.preventDefault(); send(performance.now()) }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { picker.leave(); files.leave() } }}>
      {ornament}
      {staleAnswer ? <div className="thread-prompt__notice" role="status"><span>This answer was for a question that is no longer pending.</span>
        <Button variant="secondary" onClick={() => store.edit(threadId, { text: '', attachments: [], skills: [], files: [], requestId: null })}>Discard answer</Button></div> : null}
      <SkillPicker model={picker} listId={listId} provider={row.provider} selected={draft.skills} onSelect={skill => selectSkill(picker.options.indexOf(skill))} />
      <FilePicker model={files} listId={fileListId} selected={draft.files} onSelect={(entry: FileEntry) => selectFile(files.options.indexOf(entry))} />
      <label className="tt-visually-hidden" htmlFor={composerId}>{answering ? 'Your answer' : 'Prompt'}</label>
      <ScreenshotInput key={threadId} attachments={[...draft.attachments]} disabled={!editable} supported={row.model?.supportsImages === true && !answering && !permission}
        onReadingChange={setReadingImages} onChange={attachments => edit({ attachments })}>
        <textarea ref={textarea} id={composerId} rows={3} value={draft.text} disabled={!editable} spellCheck
          aria-describedby={statusId}
          aria-autocomplete={menus ? 'list' : undefined}
          aria-controls={picker.open && picker.options.length ? listId : files.open && files.options.length ? fileListId : undefined}
          aria-expanded={menus ? menuOpen : undefined}
          aria-activedescendant={picker.open && picker.activeIndex !== null ? skillOptionId(listId, picker.activeIndex)
            : files.open && files.activeIndex !== null ? fileOptionId(fileListId, files.activeIndex) : undefined}
          placeholder={placeholder}
          onChange={event => { editText(event.target.value); picker.track(event.target); files.track(event.target) }}
          onSelect={event => { picker.track(event.currentTarget); files.track(event.currentTarget) }}
          onKeyDown={event => {
            // Without the skills list, an open menu is still told by aria-expanded.
            const key = readComposerKey(event, menus ? menuOpen && (picker.activeIndex !== null || files.activeIndex !== null) : undefined)
            // Only one of the two can be open, since a token starts with one sigil; both answer keys alike.
            if (runComposerMenuKey(event, key, { open: picker.open, optionCount: picker.options.length, activeIndex: picker.activeIndex, move: picker.move, close: picker.close, select: selectSkill })) return
            if (runComposerMenuKey(event, key, { open: files.open, optionCount: files.options.length, activeIndex: files.activeIndex, move: files.move, close: files.close, select: selectFile })) return
            if (composerEnterIntent(key) !== 'send') return
            // Enter never inserts a stray newline, even when sending is blocked.
            event.preventDefault()
            send(performance.now())
          }} />
      </ScreenshotInput>
      <div className="thread-prompt__footer">
        <div className="thread-prompt__meta" id={statusId}>
          {row.thread.nativeSessionStarted === false || capabilities.configureThread
            ? <ThreadOptions key={threadId} thread={row.thread} state={state} command={command} turnNote={false}
              {...(editable && !answering && !permission ? { draftText: draft.text, onDraftText: (text: string) => { caretAfterInsert.current = text.length; editText(text); textarea.current?.focus() } } : {})} />
            : <span className="thread-prompt__model"><ProviderMark provider={row.providerId} name={row.provider} />{row.model?.name ?? row.provider}<small>{answering ? 'Answer this question' : 'Manual prompt'}</small></span>}
          {status}
        </div>
        <div className="thread-prompt__actions">
          {running && capabilities.steer === true
            ? <Button variant="secondary" className="thread-prompt__steer" disabled={!canSteer} title={canSteer ? 'Add this to the running turn now' : reason ?? undefined} onClick={() => send(performance.now(), 'steer')}>Steer now</Button>
            : null}
          {working ? <Button iconOnly className="thread-prompt__stop" data-beside={content || undefined} aria-label="Stop agent" title="Stop agent" disabled={!canStop} onClick={() => void command({ type: 'interrupt', threadId })}><Square size={11} fill="currentColor" aria-hidden="true" /></Button> : null}
          {/* With nothing to send, Stop holds the send button's place; typed text brings the send back to the end, so Enter's button is never Stop. */}
          {/* One disc: an arrow sends, a list-plus queues. The full name stays in the label and title, so Queue prompt is never called Send. */}
          {!working || content ? <Button iconOnly className="thread-prompt__send" aria-label={primaryLabel} title={reason ?? primaryLabel} disabled={!canSend} type="submit">
            {queueing ? <ListPlus size={15} aria-hidden="true" /> : <ArrowUp size={15} strokeWidth={2.25} aria-hidden="true" />}</Button> : null}
        </div>
      </div>
      {/* T3's branch toolbar: where the thread runs and works, its pull request and its branch, for a Git repository (ADR-0027). */}
      <BranchToolbar row={row} state={state} command={command} focused={focused} onExplainedError={onExplainedError} />
    </form>
  </>
}
