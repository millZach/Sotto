import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { ArrowUp, Laptop, ListPlus, MessageSquare, Quote, Server, Square, X } from 'lucide-react'
import { capabilitiesForThread, hostForThread, isThreadBusy, PROVIDER_LABELS, type AgentState } from '../../../shared/agents'
import { continueProviderRefusal, continueThreadRefusal, type ContinueStart } from '../../../shared/continueThread'
import { resolveModel } from '../../../shared/modelCatalog'
import { isThreadArchived, isThreadClosed } from '../../../shared/threadActivity'
import { Button } from '../components/Button'
import type { AgentConnection } from './AgentContext'
import { composerEnterIntent, isCompositionKey, readComposerKey, runComposerMenuKey } from './composerKeys'
import { browseFolder, fileLimitReached, insertFile, retainFileReferences, sameFileReferences, type FileEntry } from './composerFiles'
import { composerFilesBridge, FilePicker, fileOptionId, useFilePicker } from './FilePicker'
import { insertSkill, sameSkillReferences, skillLimitReached, skillSigils } from './composerSkills'
import { ProviderMark } from './ProviderMark'
import { requestMode } from './requests/requestAnswers'
import { answeredChoices, OWN_WORDS } from './requests/answeredChoices'
import { useWatcherEnabled } from '../state/watcherFeature'
import { composeReviewMessage, reviewCommentStore, reviewLabel, useReviewComments, type ReviewCommentStore } from './reviewComments'
import { composeQuotedMessage, replyQuoteLabel, replyQuoteStore, useReplyQuotes, type ReplyQuote, type ReplyQuoteStore } from './replyQuotes'
import { useOwlFeature } from '../state/owlFeature'
import { ScreenshotInput } from './ScreenshotInput'
import { SkillPicker, skillOptionId, useSkillPicker } from './SkillPicker'
import { deliveryFor, deliveryPending, hasDraftContent, queueAdmissionOpen, queuedRevision, submissionStatus, UNCONFIRMED_SUBMISSION, useScreenshotReadPort, useScreenshotReads, useSubmissions, useThreadComposer, type ComposerDraft, type ThreadComposerSnapshot, type SubmissionMode, type SubmissionStatus, type ThreadDraftStore } from './threadDraftStore'
import type { ThreadRow } from './threadFacts'
import { followupsFor, ThreadFollowups } from './ThreadFollowups'
import { ThreadOptions, watcherPermissionFixedReason } from './ThreadOptions'
import { WatcherPermissionChip } from '../watcher/WatcherPermissionChip'
import { useThreadStarts } from './ThreadStart'
import { useWatcherSendGate } from '../watcher/WatcherHandover'
import { WatcherNewButton } from '../watcher/WatcherNew'
import { useWatchActions } from '../watcher/watcherRoom'
import { watchAfterSend } from '../watcher/watchOnSend'
import { listedHosts } from './HostBadge'
import { BranchToolbar } from './BranchToolbar'
import { sessionSeenOpen, startOnTyping } from './earlyStart'
import { PromptEditor, promptSelection, setPromptSelection, type PromptEditorElement } from './PromptEditor'
import { promptDocText } from './promptDocument'
import { toolbarApplies } from './branchToolbar.logic'
import { useDelegationsEnabled } from './delegations'
import { stopLabel, workingDelegatedThreads } from './delegationWords'
import { ContinueOptions, ContinueStrip } from './ContinueThread'
import { continueChoiceFor, continueModels, continueStore, unavailableProviders, useContinueChoice, useContinueEnabled, type ContinueChoice } from './continuations'
import './composer.css'
import './reviewComments.css'

type Command = AgentConnection['command']

export const THREAD_PROMPT_ID = 'thread-workspace-prompt'

const NO_QUOTES: readonly ReplyQuote[] = []

/** Under an answer: what waits on the composer goes with the next prompt instead. */
function heldNote(comments: boolean, quotes: boolean): string {
  return `${comments && quotes ? 'These comments and quotes go' : comments ? 'These comments go' : 'These quotes go'} with your next prompt, not this answer.`
}

/**
 * A thread with a prompt still on its way cannot take another: a new send would only reconcile the earlier one.
 * With `besideQueue`, a follow-up the queue owns does not count, so a later revision can line up behind it.
 */
function threadSendInFlight(state: AgentState, threadId: string, localUnresolved: boolean, besideQueue = false): boolean {
  return localUnresolved || state.deliveries?.some(item => item.threadId === threadId && !item.setAside && deliveryPending(item.status)
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
      : mode === 'queue' && queuedRevision(result, threadId, draft.draftId) ? null : result.error
    store.resolve(threadId, draft.draftId, error)
    return result === null ? null : error === null
  } catch {
    store.resolve(threadId, draft.draftId, UNCONFIRMED_SUBMISSION[mode])
    return null
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
  if (!row.connected) return row.reconnecting ? 'Its host is restarting after an update. Your draft stays here.' : 'Reconnect to send. Your draft stays here.'
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
export function ThreadComposer({ row, state, command, store, onSend, composerId = THREAD_PROMPT_ID, ornament, focused = true, onExplainedError, reviewComments = reviewCommentStore, replyQuotes = replyQuoteStore, watcher = false }: {
  readonly row: ThreadRow
  readonly state: AgentState
  readonly command: Command
  readonly store: ThreadDraftStore
  /** The user sent from this composer; the transcript follows to the newest message. */
  readonly onSend: () => void
  /** Unique per visible composer; the prompt, status and skills list IDs derive from it. */
  readonly composerId?: string
  /** Live observation drawn on the top edge without changing composer interaction. */
  readonly ornament?: ReactNode
  /** Whether this pane has the user's attention; the branch toolbar's shortcuts answer only for the one that does. */
  readonly focused?: boolean
  /** The branch toolbar's refusal, so the pane can leave its own error line out for it. */
  readonly onExplainedError?: ((error: string | null) => void) | undefined
  /** Review comments written in Changes that go with this thread's next prompt; the window's own unless a test passes one. */
  readonly reviewComments?: ReviewCommentStore
  /** Words quoted from the agent's replies that go with this thread's next prompt (ADR-0127); the window's own unless a test passes one. */
  readonly replyQuotes?: ReplyQuoteStore
  /** Watcher's own composer: its permissions are Watcher's own choice, and it offers no skills or branch toolbar (ADR-0073). */
  readonly watcher?: boolean
}): ReactNode {
  const threadId = row.thread.id
  // An answer written here is kept for Watcher's line about its request, never its words, and only where Watcher is on.
  const watcherOn = useWatcherEnabled()
  const watchActions = useWatchActions()
  const { draft, save, saveError, answerState, hasContent } = useComposerControls(store, threadId)
  const comments = useReviewComments(reviewComments, threadId)
  // Reply quotes are an Owl feature: stable shows no chip and sends none (ADR-0127).
  const quoting = useOwlFeature('reply-quote')
  const heldQuotes = useReplyQuotes(replyQuotes, threadId)
  const quotes = quoting ? heldQuotes : NO_QUOTES
  const submissions = useSubmissions(store)
  // Screenshots still being read for this draft hold Send, even ones pasted before the user left the thread and came back.
  const readingImages = useScreenshotReads(store, threadId).pending > 0
  // The row under the footer where the option chips say what happened to a refused or unconfirmed change.
  const [settingsNotices, setSettingsNotices] = useState<HTMLDivElement | null>(null)
  const field = useRef<PromptEditorElement>(null)
  const caretAfterInsert = useRef<number | null>(null)
  const pendingRequest = row.request?.requestId === undefined ? undefined : row.thread.requests.find(request => request.id === row.request!.requestId)
  const question = row.request?.kind === 'question' && row.request.requestId && (pendingRequest === undefined || requestMode(pendingRequest) === 'legacy-text') ? row.request : undefined
  const permission = row.request?.kind === 'permission' || row.thread.requests.some(request => request.kind === 'permission')
  const staleAnswer = draft.requestId !== null && draft.requestId !== question?.requestId
  const answering = question !== undefined
  const capabilities = capabilitiesForThread(state.host, row.thread)
  const direct = submissions.filter(item => item.threadId === threadId && item.mode !== 'queue'
    && !deliveryFor(state, threadId, item.draftId)?.setAside).map(item => submissionStatus(item, state).status)
  const localUnresolved = direct.some(deliveryPending)
  // Before main has published its admission, and once a delivery is uncertain, even the queue waits.
  const localUnconfirmed = submissions.some(item => item.threadId === threadId && item.mode !== 'queue'
    && !deliveryFor(state, threadId, item.draftId)?.setAside && deliveryPending(submissionStatus(item, state).status)
    && !deliveryOnItsWay(deliveryFor(state, threadId, item.draftId)?.status ?? 'uncertain'))
  const localAdmissions = submissions.some(item => item.threadId === threadId && queueAdmissionOpen(item, state) && !(item.resolved && item.error !== null))
  const sendInFlight = threadSendInFlight(state, threadId, localUnresolved)
  // A follow-up already on its way belongs to the queue, and a later revision can line up behind it; so can
  // one behind a direct send main is still delivering. A direct send or steer still unconfirmed holds
  // everything: retyped, it could reach the provider twice.
  const queueBlocked = threadSendInFlight(state, threadId, localUnconfirmed, true)
  // A continuation begun here (ADR-0089): the composer writes the new thread's first message, which goes after the handover.
  const continueEnabled = useContinueEnabled()
  const begun = useContinueChoice(threadId)
  const continuing = begun !== undefined && !watcher && !answering ? begun : undefined
  const continueHost = hostForThread(state.host, row.thread)
  const continueModel = continuing === undefined ? undefined : resolveModel(continueHost.models, continuing.modelId)
  const continueTarget = continueModel?.providerId ? PROVIDER_LABELS[continueModel.providerId] : continueModel?.provider ?? 'the other provider'
  // Enter behind a prompt on its way queues instead of being refused, so the order typed is the order sent.
  const queueing = continuing === undefined && !answering && (queuesByDefault(row, state, localAdmissions) || sendInFlight && !queueBlocked)
  // While Watcher's handover is offered, a send is the choice to continue with it (ADR-0073).
  const gate = useWatcherSendGate()
  const handover = watcher && gate !== null && !answering && !queueing ? gate : null
  // Continuing asks nothing of this thread's own provider: only that the thread is at rest and the other provider can start one.
  const continueReason = continuing === undefined ? null : continueThreadRefusal(row.thread)
    ?? (continuing.sending ? `Starting the ${continueTarget} thread…` : null)
    ?? (draft.skills.length > 0 ? `Skills are ${row.provider}’s own. Remove them to continue on ${continueTarget}.` : null)
    ?? (continueModel?.providerId ? continueProviderRefusal(continueHost, continueModel.providerId) : 'Choose a model to continue on.')
  const reason = continuing !== undefined ? continueReason
    : blockedReason(row, state, answering, queueing ? queueBlocked : sendInFlight) ?? (staleAnswer ? 'This answer’s question is no longer pending.' : null)
  const editable = !row.thread.archivedAt && !permission
  const working = row.thread.status === 'running' && !isThreadClosed(row.thread)
  // A thread that began from another asks what its agent should do next, before anything of the user's is in it (#1028).
  const started = useThreadStarts() && row.thread.startedFrom !== undefined && !row.thread.lastUserMessageId && (row.thread.summary?.lastUser === undefined)
  const placeholder = continuing !== undefined ? `What should ${continueTarget} do next? It goes after the handover.` : row.thread.archivedAt ? 'This thread is archived.' : permission ? permissionsOnlyInProvider(row) ? 'Waiting on the request above.' : PERMISSION_INSTRUCTION : answering ? 'Write your answer…' : working ? (row.thread.compaction?.status === 'running' ? 'Compacting the context. Write a follow-up to queue it.' : `${watcher ? 'Watcher' : row.provider} is working. Write a follow-up to queue it.`) : watcher ? 'Ask about your threads, or say what to start or send' : started ? `What should ${row.provider} do next?` : 'What would you like to do next?'
  // Review comments and reply quotes ride with the next prompt, not with an answer to a question.
  const carried = answering ? [] : comments
  const carriedQuotes = answering ? NO_QUOTES : quotes
  const content = hasContent || carried.length > 0 || carriedQuotes.length > 0
  const canSend = reason === null && content && !readingImages && !answerState.sending
  const running = row.thread.status === 'running' && !answering
  // Steering is a direct delivery: it waits for any prompt still on its way, the queue's included.
  const canSteer = running && capabilities.steer === true && canSend && !sendInFlight
  const canStop = working && capabilities.interrupt === true && row.connected && !isThreadBusy(state, threadId)
  // Stop names the delegated threads below this one that a press also stops (ADR-0081 decision 6).
  const delegationsOn = useDelegationsEnabled()
  // Counted once per state, not on every keystroke the composer redraws for.
  const threads = state.host.threads
  const stopName = useMemo(() => stopLabel(delegationsOn && working ? workingDelegatedThreads(threads, threadId) : 0), [delegationsOn, working, threads, threadId])
  const [menuOpen, setMenuOpen] = useState(false)
  const leavePickers = useRef<() => void>(() => undefined)
  const statusId = `${composerId}-status`
  // Seen open, the session is asked for again the next time it is stopped and the user types (#769).
  const sessionOpen = row.thread.providerSessionOpen === true
  useEffect(() => { if (sessionOpen) sessionSeenOpen(store, threadId) }, [sessionOpen, store, threadId])

  const edit = (patch: Parameters<ThreadDraftStore['edit']>[1]): void => {
    store.edit(threadId, question ? { ...patch, requestId: question.requestId! } : patch)
  }

  /**
   * Writes what rides with the prompt into its own text, quotes first, then the user's message, then the review
   * comments, so every provider reads the same message, the transcript shows what was sent, and a refused prompt
   * comes back to the composer with them written out.
   */
  const withCarried = (text: string): string => carried.length === 0 && carriedQuotes.length === 0 ? text
    : composeReviewMessage(composeQuotedMessage(text, carriedQuotes), carried)
  const writeCarried = (): void => {
    const draftText = store.draft(threadId).text, text = withCarried(draftText)
    if (text !== draftText) store.edit(threadId, { text })
  }
  /** What rode with the prompt has gone with it, so its chips come off. */
  const sentCarried = (): void => {
    if (carried.length > 0) reviewComments.sent(threadId, carried.map(comment => comment.id))
    if (carriedQuotes.length > 0) replyQuotes.sent(threadId, carriedQuotes.map(quote => quote.id))
  }

  /**
   * Sends the continuation: main makes the new thread and sends it the handover with this draft's words as one message.
   * Refused, the draft stays here with why in the strip; sent, the draft empties and the new thread opens.
   */
  const continueSend = async (choice: ContinueChoice): Promise<void> => {
    const bridge = window.sotto?.continueThread
    if (bridge === undefined) return
    // What rides with it goes into the request, not the draft, until the new thread has started: a refusal leaves the
    // draft and the chips as they were, so continuing again carries each once.
    const written = store.draft(threadId)
    const text = withCarried(written.text)
    if (text.trim() === '') { continueStore.update(threadId, { error: `Write what ${continueTarget} should do next. It goes with the handover.` }); return }
    continueStore.update(threadId, { sending: true, error: null })
    let result: ContinueStart
    try {
      result = await bridge.start({ threadId, newThreadId: choice.newThreadId, modelId: choice.modelId,
        ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}), ...(choice.runtimeMode ? { runtimeMode: choice.runtimeMode } : {}),
        ...(choice.providerMode ? { providerMode: choice.providerMode } : {}), workingCopy: choice.workingCopy, draftId: crypto.randomUUID(), text,
        ...(written.attachments.length ? { attachments: [...written.attachments] } : {}), ...(written.files?.length ? { files: [...written.files] } : {}) })
    } catch {
      // Main's answer was lost, so whether the new thread started is unknown. A retry names the same new thread, which main
      // refuses once it has started, so nothing is sent twice.
      result = { status: 'refused', message: `Sotto could not confirm whether the ${continueTarget} thread started. Your message is kept here. If it started, it is in the sidebar; continuing again sends nothing twice.` }
    }
    if (result.status === 'refused') { continueStore.update(threadId, { sending: false, error: result.message }); return }
    continueStore.set(threadId, undefined)
    // Only the words that went are cleared: anything written while main started the thread stays.
    const now = store.draft(threadId)
    if (now.text === written.text && now.attachments === written.attachments && now.files === written.files) store.edit(threadId, { text: '', attachments: [], skills: [], files: [] })
    sentCarried()
    void command({ type: 'select-thread', threadId: result.threadId })
  }
  const send = (submittedAt: number, mode: SubmissionMode = queueing ? 'queue' : 'send'): void => {
    if (mode === 'steer' ? !canSteer : !canSend) return
    if (continuing !== undefined) { if (mode === 'send') void continueSend(continuing); return }
    // Sent from a button, which the emptied draft is about to disable: the next prompt starts where the last was written.
    const input = field.current
    if (input !== null && document.activeElement !== input && input.closest('form')?.contains(document.activeElement)) input.focus()
    if (question?.requestId) {
      if (draft.requestId !== question.requestId) store.edit(threadId, { requestId: question.requestId })
      // Main keeps no draft for an answer, so this window saves the revision it answers with.
      const answer = store.submit(threadId, submittedAt, 'send', 'window')
      if (answer === null) return
      store.dismiss(threadId, answer.draftId)
      store.setAnswerState(threadId, { sending: true, error: null })
      // The composer emptied on the press, so a refused answer comes back to it unless something newer is written.
      const failed = (error: string): void => {
        const restored = store.restoreDraft(threadId, answer, true) !== null
        store.setAnswerState(threadId, { sending: false, error: `${error}${restored ? ' It is back in the composer.' : ' Your newer draft is in the composer.'}` })
      }
      void command({ type: 'answer', threadId, requestId: question.requestId, answer: answer.text })
        .then(result => {
          if (result === null) failed('Sotto could not confirm this answer.')
          else if (result.error !== null) failed(result.error)
          else {
            store.setAnswerState(threadId, { sending: false, error: null })
            if (watcherOn) answeredChoices.note(threadId, question.requestId, OWN_WORDS, true)
          }
        },
          () => failed('Sotto could not confirm this answer.'))
      return
    }
    writeCarried()
    onSend()
    // Watch pressed on a new thread's composer puts it under a standing watch once main has taken its first send.
    const first = row.thread.nativeSessionStarted === false
    void sendThreadRevision(store, row, command, submittedAt, mode, undefined, handover !== null && mode === 'send' ? handover.prepare : undefined)
      .then(sent => watchAfterSend(threadId, sent, mode, first, watchActions))
    sentCarried()
  }
  /** A removed chip hands focus to the next one, or back to the prompt after the last. */
  const removeChip = (button: HTMLElement, remove: () => void): void => {
    // Quotes and comments are two rows of chips; focus moves through both, as one.
    const buttons = [...(button.closest('form')?.querySelectorAll<HTMLElement>('.review-chip__remove') ?? [])]
    const next = buttons[buttons.indexOf(button) + 1] ?? buttons[buttons.indexOf(button) - 1]
    remove()
    if (next) next.focus(); else field.current?.focus()
  }

  const status = saveError !== null && save === 'unsaved'
    ? <span className="thread-prompt__status" data-tone="warning" role="alert">Draft not saved. <button type="button" className="thread-prompt__link tt-focusable" onClick={() => store.flush(threadId, true)}>Save again</button></span>
    : answerState.error ? <span className="thread-prompt__status" data-tone="warning" role="alert">{answerState.error}</span>
      : answerState.sending ? <span className="thread-prompt__status" role="status">Sending answer…</span>
        // A blocked composer states only why, and not again when its empty prompt already says it. Saving,
        // queueing and a working agent get no caption, and how a sent prompt went is told where it is shown.
        : reason !== null ? reason === placeholder ? null : <span className="thread-prompt__status">{reason}</span> : null
  const primaryLabel = answering ? 'Send answer' : queueing ? 'Queue prompt' : 'Send prompt'
  // "Continue in a new thread on" in the model chip, for a started thread on this computer (ADR-0089; Owl only).
  const continueOffer = continueEnabled && !watcher && continuing === undefined && row.thread.nativeSessionStarted !== false && row.thread.remoteHost !== true
    && !isThreadArchived(row.thread) && row.thread.kind !== 'watcher' && row.thread.kind !== 'watcher-history' ? {
      models: continueModels(state, row.thread), unavailable: unavailableProviders(state, row.thread), refusal: continueThreadRefusal(row.thread),
      onContinue: (modelId: string) => { continueStore.set(threadId, continueChoiceFor(state, row.thread, modelId, continueStore.get(threadId))); field.current?.focus() },
    } : undefined
  // The branch toolbar says Run on for a thread in a Git repository, so the chip speaks only where the toolbar does not.
  const threadHost = toolbarApplies(row.thread) ? undefined : listedHosts(state).find(item => item.hostId === row.thread.hostId)

  return <>
    <ThreadFollowups row={row} state={state} command={command} store={store}
      onRetryAdmission={draftId => { void sendThreadRevision(store, row, command, performance.now(), 'queue', draftId) }} />
    {continuing !== undefined ? <ContinueStrip thread={row.thread} state={state} choice={continuing} composerId={composerId} /> : null}
    <form className="thread-prompt" data-ornament={Boolean(ornament) || undefined} data-thread-id={threadId} data-answering={answering || undefined} data-running={working || undefined} data-picker={menuOpen || undefined}
      onSubmit={event => { event.preventDefault(); send(performance.now()) }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { leavePickers.current() } }}>
      {ornament}
      {staleAnswer ? <div className="thread-prompt__notice" role="status"><span>This answer was for a question that is no longer pending.</span>
        <Button variant="secondary" onClick={() => store.edit(threadId, { text: '', attachments: [], skills: [], files: [], requestId: null })}>Discard answer</Button></div> : null}
      <ThreadComposerEditor key={threadId} row={row} state={state} command={command} store={store} composerId={composerId}
        editable={editable} answering={answering} placeholder={placeholder} supported={row.model?.supportsImages === true && !answering && !permission} watcher={watcher}
        field={field} caretAfterInsert={caretAfterInsert} leavePickers={leavePickers} onMenuChange={setMenuOpen}
        edit={edit} onSend={() => send(performance.now())}>
        {comments.length > 0 ? <ul className="review-chips" aria-label="Review comments">
          {comments.map(comment => {
            const label = reviewLabel(comment)
            return <li key={comment.id} className="review-chip" title={comment.text}>
              <MessageSquare size={13} aria-hidden="true" className="review-chip__icon" />
              <span className="review-chip__label">{label}</span><span className="tt-visually-hidden">: {comment.text}</span>
              <button type="button" className="review-chip__remove tt-focusable" aria-label={`Remove comment on ${label}`} title="Remove comment"
                onClick={event => removeChip(event.currentTarget, () => reviewComments.remove(threadId, comment.id))}><X size={13} aria-hidden="true" /></button>
            </li>
          })}
        </ul> : null}
        {quotes.length > 0 ? <ul className="review-chips" aria-label="Quotes from replies">
          {quotes.map(quote => {
            const label = replyQuoteLabel(quote.text)
            return <li key={quote.id} className="review-chip" title={quote.text}>
            <Quote size={13} aria-hidden="true" className="review-chip__icon" />
            <span className="review-chip__label">{label}</span><span className="tt-visually-hidden">: {quote.text}</span>
            <button type="button" className="review-chip__remove tt-focusable" aria-label={`Remove quote ${label}`} title="Remove quote"
              onClick={event => removeChip(event.currentTarget, () => replyQuotes.remove(threadId, quote.id))}><X size={13} aria-hidden="true" /></button>
          </li>
          })}
        </ul> : null}
        {answering && (comments.length > 0 || quotes.length > 0) ? <p className="review-chips__note">{heldNote(comments.length > 0, quotes.length > 0)}</p> : null}
        <label className="tt-visually-hidden" htmlFor={composerId} onClick={() => field.current?.focus()}>{answering ? 'Your answer' : watcher ? 'Watcher message' : 'Prompt'}</label>
      </ThreadComposerEditor>
      <div className="thread-prompt__footer">
        <div className="thread-prompt__meta" id={statusId}>
          {/* Every composer belongs to a thread that already exists on its host, so the host is shown here, not chosen.
              Watcher always runs on this computer, so its composer has New Watcher in that place instead. */}
          {watcher ? <WatcherNewButton state={state} thread={row.thread} noticeSlot={settingsNotices} />
            : threadHost ? <span className="thread-host-chip" title={`This thread runs on ${threadHost.kind === 'local' ? 'this computer' : threadHost.name}. New thread chooses the host for new work.`}>
            {threadHost.kind === 'local' ? <Laptop size={14} aria-hidden="true" /> : <Server size={14} aria-hidden="true" />}Runs on {threadHost.kind === 'local' ? 'this computer' : threadHost.name}</span> : null}
          {continuing !== undefined ? <ContinueOptions thread={row.thread} state={state} choice={continuing} />
            : row.thread.nativeSessionStarted === false || capabilities.configureThread || continueOffer !== undefined
            ? <ThreadOptions key={threadId} thread={row.thread} state={state} command={command} turnNote={false} noticeSlot={settingsNotices} watcher={watcher} continueOffer={continueOffer}
              {...(editable && !answering && !permission ? { getDraftText: () => store.draft(threadId).text, onDraftText: (text: string) => { caretAfterInsert.current = text.length; edit({ text }); field.current?.focus() } } : {})} />
            : <><span className="thread-prompt__model"><ProviderMark provider={row.providerId} name={row.provider} />{row.model?.name ?? row.provider}<small>{answering ? 'Answer this question' : 'Manual prompt'}</small></span>
              {watcher ? <WatcherPermissionChip model={row.model} provider={row.provider} inForce={row.thread.runtimeMode} noticeSlot={settingsNotices}
                disabled={watcherPermissionFixedReason(state, row.thread) !== undefined} fixedReason={watcherPermissionFixedReason(state, row.thread)} /> : null}</>}
          {status}
        </div>
        <div className="thread-prompt__actions">
          {running && capabilities.steer === true
            ? <Button variant="ghost" className="thread-prompt__steer" disabled={!canSteer} title={canSteer ? 'Send this now, without waiting for the turn to end' : reason ?? undefined} onClick={() => send(performance.now(), 'steer')}>Steer now</Button>
            : null}
          {working ? <Button iconOnly className="thread-prompt__stop" data-beside={content || undefined} aria-label={stopName} title={stopName} disabled={!canStop} onClick={() => void command({ type: 'interrupt', threadId })}><Square size={11} fill="currentColor" aria-hidden="true" /></Button> : null}
          {/* With nothing to send, Stop holds the send button's place; typed text brings the send back to the end, so Enter's button is never Stop. */}
          {/* One disc: an arrow sends, a list-plus queues. The full name stays in the label and title, so Queue prompt is never called Send. */}
          {continuing !== undefined
            // A narrow pane shows Continue alone; the name keeps the provider, and the strip above says it too.
            ? <Button className="thread-prompt__send" data-wide aria-label={`Continue on ${continueTarget}`} title={reason ?? `Start a new ${continueTarget} thread with a handover of this one and your message`} disabled={!canSend} type="submit">
              Continue<span className="thread-prompt__send-target"> on {continueTarget}</span><ArrowUp size={15} strokeWidth={2.25} aria-hidden="true" /></Button>
            : handover !== null && !working
            ? <Button className="thread-prompt__send" data-wide aria-label={handover.label} title={reason ?? handover.label} disabled={!canSend} type="submit">
              Continue<ArrowUp size={15} strokeWidth={2.25} aria-hidden="true" /></Button>
            : !working || content ? <Button iconOnly className="thread-prompt__send" aria-label={primaryLabel} title={reason ?? primaryLabel} disabled={!canSend} type="submit">
              {queueing ? <ListPlus size={15} aria-hidden="true" /> : <ArrowUp size={15} strokeWidth={2.25} aria-hidden="true" />}</Button> : null}
        </div>
      </div>
      <div ref={setSettingsNotices} className="thread-options-notices" />
    </form>
    {/* T3's branch toolbar: where the thread runs and works, its pull request and its branch, for a Git repository (ADR-0027).
        Its own row of buttons under the card, not a strip inside it (#325). */}
    {watcher ? null : <BranchToolbar row={row} state={state} command={command} focused={focused} onExplainedError={onExplainedError} />}
  </>
}

interface ComposerControls {
  readonly draft: Omit<ComposerDraft, 'text' | 'draftId'>
  readonly save: ThreadComposerSnapshot['save']
  readonly saveError: string | null
  readonly answerState: ThreadComposerSnapshot['answer']
  readonly hasContent: boolean
  readonly hasUltrathink: boolean
}

/** Text edits repaint the editor; the surrounding controls observe only the facts they display. */
function useComposerControls(store: ThreadDraftStore, threadId: string): ComposerControls {
  const read = useMemo(() => {
    let previous: ComposerControls | undefined
    return (): ComposerControls => {
      const { draft, save, saveError, answer: answerState } = store.snapshot(threadId)
      const hasContent = hasDraftContent(draft)
      const hasUltrathink = /\bultrathink\b/iu.test(draft.text)
      if (previous && previous.save === save && previous.saveError === saveError
        && previous.answerState === answerState
        && previous.hasContent === hasContent && previous.hasUltrathink === hasUltrathink
        && previous.draft.attachments === draft.attachments && previous.draft.skills === draft.skills
        && previous.draft.files === draft.files && previous.draft.requestId === draft.requestId) return previous
      return previous = { draft, save, saveError, answerState, hasContent, hasUltrathink }
    }
  }, [store, threadId])
  return useSyncExternalStore(store.subscribe, read)
}

/** The small, immediate typing path, including the menus that follow its caret. */
function ThreadComposerEditor({ row, state, command, store, composerId, editable, answering, placeholder, supported, watcher,
  field, caretAfterInsert, leavePickers, onMenuChange, edit, onSend, children }: {
  readonly row: ThreadRow
  readonly state: AgentState
  readonly command: Command
  readonly store: ThreadDraftStore
  readonly composerId: string
  readonly editable: boolean
  readonly answering: boolean
  readonly placeholder: string
  readonly supported: boolean
  /** Watcher's composer offers no native skills. */
  readonly watcher: boolean
  readonly field: RefObject<PromptEditorElement | null>
  readonly caretAfterInsert: RefObject<number | null>
  readonly leavePickers: RefObject<() => void>
  readonly onMenuChange: (open: boolean) => void
  readonly edit: (patch: Parameters<ThreadDraftStore['edit']>[1]) => void
  readonly onSend: () => void
  readonly children: ReactNode
}): ReactNode {
  const threadId = row.thread.id
  const { draft } = useThreadComposer(store, threadId)
  const screenshotReads = useScreenshotReadPort(store, threadId, row.model?.supportsImages === true)
  const capabilities = capabilitiesForThread(state.host, row.thread)
  const skills = capabilities.skills === true && !watcher
  const picker = useSkillPicker({ threadId, state, command, enabled: editable && !answering && skills, text: draft.text })
  // Restored selections still explain themselves before the user opens a picker.
  useEffect(() => { if (draft.skills.length && skills && picker.catalog === undefined) picker.refresh(false) }, [draft.skills.length, skills, picker.catalog, picker.refresh])
  const sigils = skillSigils(picker.catalog?.providerId ?? row.providerId)
  // `@` browses the thread's working copy. A thread still waiting for its folder has nothing to list.
  const files = useFilePicker({ threadId, bridge: composerFilesBridge(), text: draft.text,
    enabled: editable && !answering && row.thread.worktree?.status !== 'pending' && row.thread.worktree?.status !== 'error' })
  const menuOpen = picker.open || files.open
  // A composer with neither menu leaves Enter and the combobox attributes exactly as they were.
  const menus = (skills || files.enabled) && !answering
  const listId = `${composerId}-skills`
  const fileListId = `${composerId}-files`
  const statusId = `${composerId}-status`

  useLayoutEffect(() => {
    const caret = caretAfterInsert.current
    if (caret === null || field.current === null || promptDocText(field.current.editor.getJSON()) !== draft.text) return
    caretAfterInsert.current = null
    setPromptSelection(field.current, caret)
    picker.track(promptSelection(field.current.editor))
    files.track(promptSelection(field.current.editor))
  })

  useLayoutEffect(() => { onMenuChange(menuOpen) }, [menuOpen, onMenuChange])
  useLayoutEffect(() => {
    leavePickers.current = () => { picker.leave(); files.leave() }
    return () => { leavePickers.current = () => undefined }
  })
  const editText = (text: string, pills: readonly ComposerDraft['skills'][number][]): void => {
    // Pills own the skill references, including undo; plain tokens never retain a removed pill's selection.
    const skills = [...pills]
    const mentioned = retainFileReferences(text, draft.files)
    edit({ text, ...(sameSkillReferences(skills, draft.skills) ? {} : { skills }), ...(sameFileReferences(mentioned, draft.files) ? {} : { files: mentioned }) })
  }
  const selectSkill = (index: number): void => {
    const skill = picker.options[index]
    if (skill === undefined || picker.trigger === null || skillLimitReached(draft.skills, skill, picker.catalog?.maxSkillsPerMessage)) return
    const next = insertSkill(draft.text, picker.trigger, skill, draft.skills, sigils)
    caretAfterInsert.current = next.caret
    edit({ text: next.text, skills: next.skills })
    field.current?.focus()
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
    field.current?.focus()
  }
  return <>
    <SkillPicker model={picker} listId={listId} provider={row.provider} selected={draft.skills} onSelect={skill => selectSkill(picker.options.indexOf(skill))} />
    <FilePicker model={files} listId={fileListId} selected={draft.files} onSelect={(entry: FileEntry) => selectFile(files.options.indexOf(entry))} />
    {children}
    {/* Screenshots still being staged when the user moves to another thread join this thread's draft as it is then. */}
    <ScreenshotInput key={threadId} target={threadId} attachments={draft.attachments} disabled={!editable} supported={supported}
      reads={screenshotReads} onChange={attachments => edit({ attachments })}>
      <PromptEditor fieldRef={field} caretAfterInsert={caretAfterInsert} id={composerId} text={draft.text} skills={draft.skills} sigils={sigils} catalog={picker.catalog}
        label={answering ? 'Your answer' : watcher ? 'Watcher message' : 'Prompt'} editable={editable}
        aria-describedby={statusId}
        aria-autocomplete={menus ? 'list' : undefined}
        aria-controls={picker.open && picker.options.length ? listId : files.open && files.options.length ? fileListId : undefined}
        aria-expanded={menus ? menuOpen : undefined}
        aria-activedescendant={picker.open && picker.activeIndex !== null ? skillOptionId(listId, picker.activeIndex)
          : files.open && files.activeIndex !== null ? fileOptionId(fileListId, files.activeIndex) : undefined}
        placeholder={placeholder}
        onChange={(text, pills) => {
          if (!editable) return
          editText(text, pills)
          // The first keystroke starts the thread's provider session, so Send does not wait for it (#769).
          startOnTyping(store, command, row.thread, row.connected)
        }}
        onSelection={selection => { picker.track(selection); files.track(selection) }}
        onKeyDown={event => {
          // Without the skills list, an open menu is still told by aria-expanded.
          const key = readComposerKey(event, menus ? menuOpen && (picker.activeIndex !== null || files.activeIndex !== null) : undefined)
          // Only one of the two can be open, since a token starts with one sigil; both answer keys alike.
          if (runComposerMenuKey(event, key, { open: picker.open, optionCount: picker.options.length, activeIndex: picker.activeIndex, move: picker.move, close: picker.close, select: selectSkill })) return
          if (runComposerMenuKey(event, key, { open: files.open, optionCount: files.options.length, activeIndex: files.activeIndex, move: files.move, close: files.close, select: selectFile })) return
          if (key.key === 'Enter' && key.menuOpen && !isCompositionKey(key) && !key.shiftKey && !key.altKey) { event.preventDefault(); return }
          if (composerEnterIntent(key) !== 'send') return
          // Enter never inserts a stray newline, even when sending is blocked.
          event.preventDefault()
          onSend()
        }} />
    </ScreenshotInput>
  </>
}
