import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, ArrowUpRight, Laptop, ListPlus, MessageSquare, Quote, Server, Square, X } from 'lucide-react'
import { msg, t } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { NextPrompt } from '../../../shared/nextPrompt'
import { useOptionalApp } from '../state/AppContext'
import { chordClaimed, chordMatches } from './branchToolbar.logic'
import { claimedThreadChord, threadChordCap, threadChordLabel, threadChordPressed } from './threadShortcuts'
import { NextList, nextOptionId, nextRows, type NextRow } from './NextList'
import { DICTATING, ghostRest, nextPromptStore, useNextPrompt, withNextText } from './nextPrompts'
import { capabilitiesForThread, hostForThread, isThreadBusy, lastUserMessageIdOf, PROVIDER_LABELS, type AgentState } from '../../../shared/agents'
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
import { draftEffortScore } from './effortSuggestion'
import { attachmentRefusal } from './attachmentWords'
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
import { KeyedGlyph, plateSent, rowMoved, type PlateRole } from './composerPlate'
import { stopLabel, workingDelegatedThreads } from './delegationWords'
import { ContinueOptions, ContinueStrip } from './ContinueThread'
import { RestartStrip } from './RestartStopped'
import { EffortTrace } from './EffortTrace'
import { continueChoiceFor, continueModels, continueStore, unavailableProviders, useContinueChoice, useContinueEnabled, type ContinueChoice } from './continuations'
import { shownWords, type LaterWords } from './interfaceWords'
import './composer.css'
import './reviewComments.css'

type Command = AgentConnection['command']

export const THREAD_PROMPT_ID = 'thread-workspace-prompt'

const NO_QUOTES: readonly ReplyQuote[] = []

/** Under an answer: what waits on the composer goes with the next prompt instead. */
function heldNote(comments: boolean, quotes: boolean): string {
  return comments && quotes ? t`These comments and quotes go with your next prompt, not this answer.`
    : comments ? t`These comments go with your next prompt, not this answer.` : t`These quotes go with your next prompt, not this answer.`
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
  return row.thread.status === 'running' || row.thread.requests.length > 0 || localAdmissions || followupsFor(state, row.thread.id).length > 0
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
      : mode === 'queue' && queuedRevision(result, threadId, draft.draftId) ? null : result.error === null ? null : attachmentRefusal(result.error)
    store.resolve(threadId, draft.draftId, error)
    return result === null ? null : error === null
  } catch {
    store.resolve(threadId, draft.draftId, UNCONFIRMED_SUBMISSION[mode])
    return null
  }
}

/** Why the primary action is off, in one sentence; null when a prompt can go. */
function blockedReason(row: ThreadRow, state: AgentState, answering: boolean, inFlight: boolean): string | null {
  const provider = row.provider
  if (row.thread.archivedAt) return t`This thread is archived.`
  if (!row.connected) return row.reconnecting ? t`Its host is restarting after an update. Your draft stays here.` : t`Reconnect to send. Your draft stays here.`
  if (!capabilitiesForThread(state.host, row.thread).submit) return t`${provider} cannot take prompts from Sotto.`
  // The notice above the composer says why setup stopped and offers the one recovery; this only says when sending returns.
  // A pending checkout runs in the background after the thread opens; a prompt sent meanwhile waits for it.
  if (row.thread.worktree?.status === 'error') return t`Available once the working folder is ready.`
  if (!answering && inFlight) return t`Waiting for your last prompt to be confirmed.`
  return null
}

/**
 * The manual prompt (or answer) composer for one thread. Content is the thread's durable draft:
 * every edit is a new revision, Enter sends, Shift+Enter adds a line. The press empties the composer
 * and starts the next revision; what was sent is shown in the transcript, which says how it went and
 * offers it back if the provider refused it. While a turn runs, Enter queues; Steer now (Cmd/Ctrl+Enter) is the
 * separate, explicit way into the running turn, and Stop takes the send button's place until there is something to queue.
 * Each button says what it does and the key that does it (ADR-0153).
 */
export function ThreadComposer({ row, state, command, store, onSend, composerId = THREAD_PROMPT_ID, ornament, focused = true, onExplainedError, reviewComments = reviewCommentStore, replyQuotes = replyQuoteStore, watcher = false, toolbarSlot, children }: {
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
  /** Words quoted from the agent's replies that go with this thread's next prompt (ADR-0129); the window's own unless a test passes one. */
  readonly replyQuotes?: ReplyQuoteStore
  /** Watcher's own composer: its permissions are Watcher's own choice, and it offers no skills or branch toolbar (ADR-0073). */
  readonly watcher?: boolean
  /** The quiet composer's existing branch controls live beside the folder in the pane header. */
  readonly toolbarSlot?: HTMLElement | null
  /** The pane's metadata follows the composer and knows which composer is drawn. */
  readonly children?: (quiet: boolean) => ReactNode
}): ReactNode {
  const { t } = useLingui()
  const threadId = row.thread.id
  // An answer written here is kept for Watcher's line about its request, never its words, and only where Watcher is on.
  const watcherOn = useWatcherEnabled()
  const watchActions = useWatchActions()
  const quietComposer = useOwlFeature('quiet-composer')
  const { draft, save, saveError, answerState, hasContent, effortScore } = useComposerControls(store, threadId, quietComposer)
  const comments = useReviewComments(reviewComments, threadId)
  // Reply quotes are an Owl feature: stable shows no chip and sends none (ADR-0129).
  const quoting = useOwlFeature('reply-quote')
  const heldQuotes = useReplyQuotes(replyQuotes, threadId)
  const quotes = quoting ? heldQuotes : NO_QUOTES
  const submissions = useSubmissions(store)
  // Screenshots still being read for this draft hold Send, even ones pasted before the user left the thread and came back.
  const readingImages = useScreenshotReads(store, threadId).pending > 0
  // The row under the footer where the option chips say what happened to a refused or unconfirmed change.
  const [settingsNotices, setSettingsNotices] = useState<HTMLDivElement | null>(null)
  const [toolbarNotices, setToolbarNotices] = useState<HTMLDivElement | null>(null)
  // The quiet pill draws the permissions shield at its start, after attach (ADR-0161).
  const [shieldSlot, setShieldSlot] = useState<HTMLDivElement | null>(null)
  const field = useRef<PromptEditorElement>(null)
  const caretAfterInsert = useRef<number | null>(null)
  const pendingRequest = row.request?.requestId === undefined ? undefined : row.thread.requests.find(request => request.id === row.request!.requestId)
  const question = row.request?.kind === 'question' && row.request.requestId && (pendingRequest === undefined || requestMode(pendingRequest) === 'legacy-text') ? row.request : undefined
  const staleAnswer = draft.requestId !== null && draft.requestId !== question?.requestId
  const answering = question !== undefined
  const cardWaits = row.thread.requests.length > 0 && !answering
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
  const continueTargetWords: LaterWords = continueModel?.providerId ? PROVIDER_LABELS[continueModel.providerId] : continueModel?.provider
    ?? msg({ message: 'the other provider', comment: 'Stands in for a provider name in "Continue on {continueTarget}" and the like, when the model names none.' })
  const continueTarget = shownWords(continueTargetWords)
  // Enter behind a prompt on its way queues instead of being refused, so the order typed is the order sent.
  const queueing = continuing === undefined && !answering && (queuesByDefault(row, state, localAdmissions) || sendInFlight && !queueBlocked)
  // While Watcher's handover is offered, a send is the choice to continue with it (ADR-0073).
  const gate = useWatcherSendGate()
  const handover = watcher && gate !== null && !answering && !queueing ? gate : null
  // Continuing asks nothing of this thread's own provider: only that the thread is at rest and the other provider can start one.
  const provider = row.provider
  const continueReason = continuing === undefined ? null : continueThreadRefusal(row.thread)
    ?? (continuing.sending ? t`Starting the ${continueTarget} thread…` : null)
    ?? (draft.skills.length > 0 ? t`Skills are ${provider}’s own. Remove them to continue on ${continueTarget}.` : null)
    ?? (continueModel?.providerId ? continueProviderRefusal(continueHost, continueModel.providerId) : t`Choose a model to continue on.`)
  const reason = continuing !== undefined ? continueReason
    : blockedReason(row, state, answering, queueing ? queueBlocked : sendInFlight) ?? (staleAnswer ? t`This answer’s question is no longer pending.` : null)
  const editable = !row.thread.archivedAt
  const working = row.thread.status === 'running' && !isThreadClosed(row.thread)
  // A thread that began from another asks what its agent should do next, before anything of the user's is in it (#1028).
  const started = useThreadStarts() && row.thread.startedFrom !== undefined && !row.thread.lastUserMessageId && (row.thread.summary?.lastUser === undefined)
  const agent = watcher ? 'Watcher' : provider
  const placeholder = continuing !== undefined ? t`What should ${continueTarget} do next? It goes after the handover.` : row.thread.archivedAt ? t`This thread is archived.` : cardWaits ? t`Queued until you answer the card` : answering ? t`Write your answer…` : working ? (row.thread.compaction?.status === 'running' ? t`Compacting the context. Write a follow-up to queue it.` : t`${agent} is working. Write a follow-up to queue it.`) : watcher ? t`Ask about your threads, or say what to start or send` : started ? t`What should ${provider} do next?` : t`What would you like to do next?`
  // Review comments and reply quotes ride with the next prompt, not with an answer to a question.
  const carried = answering ? [] : comments
  const carriedQuotes = answering ? NO_QUOTES : quotes
  const content = hasContent || carried.length > 0 || carriedQuotes.length > 0
  const canSend = reason === null && content && !readingImages && !answerState.sending
  const running = row.thread.status === 'running' && !answering
  // Steering is a direct delivery: it waits for any prompt still on its way, the queue's included.
  const canSteer = running && !cardWaits && capabilities.steer === true && canSend && !sendInFlight
  const canStop = working && capabilities.interrupt === true && row.connected && !isThreadBusy(state, threadId)
  // The row's motion (ADR-0153): which button is the plate, remembered with its thread so opening another moves nothing.
  const actionsRow = useRef<HTMLDivElement>(null)
  const rowRole: PlateRole = working ? content ? 'queue' : 'stop' : 'send'
  const lastRow = useRef({ threadId, role: rowRole }), aside = useRef({ width: 0 })
  useLayoutEffect(() => {
    const last = lastRow.current
    if (last.threadId === threadId && last.role !== rowRole) rowMoved(actionsRow.current, last.role, rowRole, aside.current)
    lastRow.current = { threadId, role: rowRole }
  }, [threadId, rowRole])
  // Stop names the delegated threads below this one that a press also stops (ADR-0081 decision 6).
  const delegationsOn = useDelegationsEnabled()
  // Counted once per state, not on every keystroke the composer redraws for.
  const threads = state.host.threads
  const workingBelow = useMemo(() => delegationsOn && working ? workingDelegatedThreads(threads, threadId) : 0, [delegationsOn, working, threads, threadId])
  const stopName = stopLabel(workingBelow)
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
    if (text.trim() === '') { continueStore.update(threadId, { error: msg({ message: `Write what ${{ continueTarget: continueTargetWords }} should do next. It goes with the handover.` }) }); return }
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
      continueStore.update(threadId, { sending: false, error: msg({ message: `Sotto could not confirm whether the ${{ continueTarget: continueTargetWords }} thread started. Your message is kept here. If it started, it is in the sidebar; continuing again sends nothing twice.` }) })
      return
    }
    if (result.status === 'refused') { continueStore.update(threadId, { sending: false, error: result.message }); return }
    continueStore.set(threadId, undefined)
    // Only the words that went are cleared: anything written while main started the thread stays.
    const now = store.draft(threadId)
    if (now.text === written.text && now.attachments === written.attachments && now.files === written.files) store.edit(threadId, { text: '', attachments: [], skills: [], files: [] })
    sentCarried()
    void command({ type: 'select-thread', threadId: result.threadId })
  }
  /** `written`: the text was put in the draft by this press (a Next answer), so the draft read at render is not yet it. */
  const send = (submittedAt: number, mode: SubmissionMode = queueing ? 'queue' : 'send', written = false, fromKeyboard = false): void => {
    if (mode === 'steer' ? !canSteer : !(canSend || written && reason === null && !readingImages && !answerState.sending)) return
    if (continuing !== undefined) { if (mode === 'send') void continueSend(continuing); return }
    if (mode !== 'steer') plateSent(actionsRow.current, fromKeyboard)
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
        store.setAnswerState(threadId, { sending: false, error: restored
          ? t({ message: `${error} It is back in the composer.`, comment: '{error} says why the answer was not sent; "It" is the answer.' })
          : t({ message: `${error} Your newer draft is in the composer.`, comment: '{error} says why the answer was not sent.' }) })
      }
      void command({ type: 'answer', threadId, requestId: question.requestId, answer: answer.text })
        .then(result => {
          if (result === null) failed(t`Sotto could not confirm this answer.`)
          else if (result.error !== null) failed(result.error)
          else {
            store.setAnswerState(threadId, { sending: false, error: null })
            if (watcherOn) answeredChoices.note(threadId, question.requestId, OWN_WORDS, true)
          }
        },
          () => failed(t`Sotto could not confirm this answer.`))
      return
    }
    writeCarried()
    onSend()
    // What was suggested next is over once main takes this (ADR-0132); a refused send keeps it.
    const sentAfter = lastUserMessageIdOf(row.thread) ?? ''
    // Watch pressed on a new thread's composer puts it under a standing watch once main has taken its first send.
    const first = row.thread.nativeSessionStarted === false
    void sendThreadRevision(store, row, command, submittedAt, mode, undefined, handover !== null && mode === 'send' ? handover.prepare : undefined)
      .then(sent => { if (sent === true) nextPromptStore.sent(threadId, sentAfter); return watchAfterSend(threadId, sent, mode, first, watchActions) })
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
    ? <span className="thread-prompt__status" data-tone="warning" role="alert"><Trans>Draft not saved. <button type="button" className="thread-prompt__link tt-focusable" onClick={() => store.flush(threadId, true)}>Save again</button></Trans></span>
    : answerState.error ? <span className="thread-prompt__status" data-tone="warning" role="alert">{answerState.error}</span>
      : answerState.sending ? <span className="thread-prompt__status" role="status"><Trans>Sending answer…</Trans></span>
        // A blocked composer states only why, and not again when its empty prompt already says it. Saving,
        // queueing and a working agent get no caption, and how a sent prompt went is told where it is shown.
        : reason !== null ? reason === placeholder ? null : <span className="thread-prompt__status">{reason}</span> : null
  const primaryLabel = answering ? t`Send answer` : queueing ? t`Queue prompt` : t`Send prompt`
  // "Continue in a new thread on" in the model chip, for a started thread on this computer (ADR-0089; Owl only).
  const continueOffer = continueEnabled && !watcher && continuing === undefined && row.thread.nativeSessionStarted !== false && row.thread.remoteHost !== true
    && !isThreadArchived(row.thread) && row.thread.kind !== 'watcher' && row.thread.kind !== 'watcher-history' ? {
      models: continueModels(state, row.thread), unavailable: unavailableProviders(state, row.thread), refusal: continueThreadRefusal(row.thread),
      onContinue: (modelId: string) => { continueStore.set(threadId, continueChoiceFor(state, row.thread, modelId, continueStore.get(threadId))); field.current?.focus() },
    } : undefined
  // The branch toolbar says Run on for a thread in a Git repository, so the chip speaks only where the toolbar does not.
  const threadHost = toolbarApplies(row.thread) ? undefined : listedHosts(state).find(item => item.hostId === row.thread.hostId)
  const hostName = threadHost === undefined || threadHost.kind === 'local' ? undefined : threadHost.name
  const hostTitle = hostName === undefined ? t`This thread runs on this computer. New thread chooses the host for new work.` : t`This thread runs on ${hostName}. New thread chooses the host for new work.`
  const hostLabel = hostName === undefined ? t`Runs on this computer` : t`Runs on ${hostName}`
  const fieldLabel = answering ? t`Your answer` : watcher ? t`Watcher message` : t`Prompt`

  // The next prompt (ADR-0132; Owl only): offered while the thread is at rest and the user's to write to, for the turn
  // that just ended, and gone the moment anything is sent, queued or asked.
  const app = useOptionalApp()
  const nextOn = useOwlFeature('next-prompt') && app?.settings?.nextPromptSuggestions !== false
  const nextEntry = useNextPrompt(nextOn ? threadId : null)
  const nextAnchor = lastUserMessageIdOf(row.thread) ?? ''
  const next: NextPrompt | null = nextEntry?.prompt && nextEntry.afterUserMessageId === nextAnchor && !working && !answering
    && row.thread.requests.length === 0 && editable && continuing === undefined && handover === null && row.connected && !sendInFlight && !localAdmissions
    && followupsFor(state, threadId).length === 0 && !isThreadClosed(row.thread) ? nextEntry.prompt : null
  const dictating = DICTATING.has(app?.dictation?.status ?? 'idle')
  // Tab, Up and the digits answer only where the dictation hotkey does not already mean them.
  const hotkey = app?.settings?.hotkey, platform = app?.platform ?? 'win32'
  const nextKeysFree = { tab: chordClaimed('tab', hotkey, platform), up: chordClaimed('up', hotkey, platform),
    digit: (digit: string) => chordClaimed(digit, hotkey, platform) }
  // Stop's chord (Settings › Keyboard, ADR-0133): this pane's Stop button from the keyboard, only where Stop itself could be pressed.
  const stopChord = claimedThreadChord(app?.settings, 'stop-turn', platform)
  useEffect(() => {
    if (watcher || !focused || !canStop || stopChord === null) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (!threadChordPressed(event, stopChord, platform)) return
      event.preventDefault()
      void command({ type: 'interrupt', threadId })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [watcher, focused, canStop, stopChord, platform, command, threadId])
  // Steer now's chord: Cmd+Enter on a Mac, Ctrl+Enter elsewhere, unless one of dictation's shortcuts already means those keys.
  const steerChord = [hotkey, ...(app?.settings?.pressShortcuts ?? []), ...(app?.settings?.holdShortcuts ?? [])]
    .every(accelerator => chordClaimed('mod+enter', accelerator, platform)) ? 'mod+enter' : null
  const enterCap = threadChordCap('enter', platform)
  const stopKeys = !watcher && stopChord ? stopChord : null
  // The quiet composer (ADR-0161, Owl): one pill. Answers, continuations and Watcher's handover keep the full footer,
  // since each has a primary action of its own that the pill's disc does not draw.
  const quiet = quietComposer && !answering && continuing === undefined && handover === null
  /** In the quiet pill, the permissions shield goes to the pill's start; elsewhere it stays where it is drawn. */
  const inSlot = (node: ReactNode): ReactNode => quiet && shieldSlot ? createPortal(node, shieldSlot) : node
  // The pill's disc turns into Steer while Steer's modifier is held, so it always shows what the key pressed will do.
  const [steerHeld, setSteerHeld] = useState(false)
  useEffect(() => {
    if (!quiet) return
    const read = (event: globalThis.KeyboardEvent): void => setSteerHeld(platform === 'darwin' ? event.metaKey : event.ctrlKey)
    const release = (): void => setSteerHeld(false)
    window.addEventListener('keydown', read); window.addEventListener('keyup', read); window.addEventListener('blur', release)
    return () => { window.removeEventListener('keydown', read); window.removeEventListener('keyup', read); window.removeEventListener('blur', release); setSteerHeld(false) }
  }, [quiet, platform])
  const stopTitle = stopKeys ? `${stopName} ${threadChordLabel(stopKeys, platform).suffix}` : stopName
  const interrupt = (): void => { void command({ type: 'interrupt', threadId }) }
  // Queue's glyph follows what Enter does, as the disc's name does, so a provider that sends during a turn shows Send.
  const discFace = working && content && canSteer && steerHeld ? 'steer' : queueing ? 'queue' : 'send'
  // Kept with the thread it was opened on, so moving to another thread finds it closed and at its first row.
  const [nextListState, setNextListState] = useState<{ readonly threadId: string; readonly index: number } | null>(null)
  const nextList = next !== null && nextListState?.threadId === threadId ? nextListState : null
  const setNextList = (value: { readonly index: number } | null): void => { setNextListState(value === null ? null : { ...value, threadId }) }
  const nextOpen = nextList !== null
  // Escape in the prompt puts the ghost away for this turn, so Tab moves focus as it always does.
  const [ghostDismissed, setGhostDismissed] = useState<string | null>(null)
  const ghostAway = ghostDismissed === `${threadId}\n${nextAnchor}`
  const nextListId = `${composerId}-next`
  /** A row chosen: an answer sends at once into an empty prompt, anything else is written into the prompt for the user to send. */
  const chooseNext = (choice: NextRow): void => {
    setNextList(null)
    const current = store.draft(threadId)
    if (choice.kind === 'answer' && !hasDraftContent(current)) {
      edit({ text: choice.text })
      send(performance.now(), undefined, true)
      return
    }
    const text = withNextText(current.text, choice.text)
    caretAfterInsert.current = text.length
    edit({ text })
    field.current?.focus()
  }
  /** The next prompt's keys, offered after the skills and files lists have had theirs. True when one was taken. */
  const nextKey = (event: KeyboardEvent<HTMLElement>, ghostShown: boolean): boolean => {
    if (next === null || isCompositionKey({ isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode }) || event.altKey || event.ctrlKey || event.metaKey) return false
    const rows = nextRows(next)
    const take = (choice: NextRow | undefined): boolean => {
      if (choice === undefined) return false
      event.preventDefault()
      chooseNext(choice)
      return true
    }
    if (nextOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setNextList({ ...nextList, index: (nextList.index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length })
        return true
      }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setNextList(null); return true }
      if (event.key === 'Enter' && !event.shiftKey) return take(rows[nextList.index])
      if (/^[1-4]$/u.test(event.key) && !event.shiftKey && nextKeysFree.digit(event.key)) return take(rows.find(item => item.kind === 'suggestion' && item.key === event.key))
      if (event.key === 'Tab' && !event.shiftKey && nextKeysFree.tab) return take(rows.find(item => item.kind === 'ghost'))
      return false
    }
    if (event.key === 'Escape' && ghostShown) { event.preventDefault(); event.stopPropagation(); setGhostDismissed(`${threadId}\n${nextAnchor}`); return true }
    if (event.key === 'Tab' && !event.shiftKey && ghostShown && nextKeysFree.tab) return take(rows.find(item => item.kind === 'ghost'))
    if (event.key === 'ArrowUp' && !event.shiftKey && !hasContent && nextKeysFree.up) { event.preventDefault(); setNextList({ index: 0 }); return true }
    return false
  }
  const toolbar = watcher ? null : <BranchToolbar row={row} state={state} command={command} focused={focused} onExplainedError={onExplainedError}
    header={quiet} noticeSlot={quiet ? toolbarNotices : undefined} />
  const metadata = useMemo(() => children?.(quiet), [children, quiet])

  return <>
    <ThreadFollowups row={row} state={state} command={command} store={store}
      onRetryAdmission={draftId => { void sendThreadRevision(store, row, command, performance.now(), 'queue', draftId) }} />
    {/* When Sotto restarts what a limit stopped (ADR-0144; Owl only), before the prompt; a begun continuation takes its place, and Watcher's own pane has the band. */}
    {continuing === undefined && !watcher ? <RestartStrip thread={row.thread} command={command} composerId={composerId} /> : null}
    {continuing !== undefined ? <ContinueStrip thread={row.thread} state={state} choice={continuing} composerId={composerId} /> : null}
    <form className="thread-prompt" data-quiet={quiet || undefined} data-ornament={Boolean(ornament) || undefined} data-thread-id={threadId} data-answering={answering || undefined} data-running={working || undefined} data-picker={menuOpen || undefined}
      onSubmit={event => { event.preventDefault(); send(performance.now()) }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { leavePickers.current(); setNextList(null) } }}>
      <EffortTrace />
      {ornament}
      {next !== null && nextList !== null ? <NextList prompt={next} listId={nextListId} activeIndex={nextList.index} sends={!hasContent}
        onHighlight={index => setNextList({ ...nextList, index })} onChoose={chooseNext} /> : null}
      {staleAnswer ? <div className="thread-prompt__notice" role="status"><span><Trans>This answer was for a question that is no longer pending.</Trans></span>
        <Button variant="secondary" onClick={() => store.edit(threadId, { text: '', attachments: [], skills: [], files: [], requestId: null })}><Trans>Discard answer</Trans></Button></div> : null}
      {/* Before the prompt in the Tab order, as the shield is before it on the line. */}
      {quiet ? <div ref={setShieldSlot} className="thread-prompt__lead" /> : null}
      <ThreadComposerEditor key={threadId} row={row} state={state} command={command} store={store} composerId={composerId}
        editable={editable} answering={answering} placeholder={placeholder} supported={row.model?.supportsImages === true && !answering} attachable={!answering} watcher={watcher}
        field={field} caretAfterInsert={caretAfterInsert} leavePickers={leavePickers} onMenuChange={setMenuOpen}
        next={next} nextOpen={nextOpen} nextListId={nextListId} nextActiveId={nextOpen ? nextOptionId(nextListId, nextList.index) : undefined}
        dictating={dictating || ghostAway} nextKey={nextKey}
        fieldLabel={fieldLabel} edit={edit}
        onSend={event => send(performance.now(), canSteer && steerChord !== null && event !== undefined && chordMatches(event, steerChord, platform) ? 'steer' : undefined, false, true)}>
        {comments.length > 0 ? <ul className="review-chips" aria-label={t`Review comments`}>
          {comments.map(comment => {
            const label = reviewLabel(comment)
            return <li key={comment.id} className="review-chip" title={comment.text}>
              <MessageSquare size={13} aria-hidden="true" className="review-chip__icon" />
              <span className="review-chip__label">{label}</span><span className="tt-visually-hidden">: {comment.text}</span>
              <button type="button" className="review-chip__remove tt-focusable" aria-label={t`Remove comment on ${label}`} title={t`Remove comment`}
                onClick={event => removeChip(event.currentTarget, () => reviewComments.remove(threadId, comment.id))}><X size={13} aria-hidden="true" /></button>
            </li>
          })}
        </ul> : null}
        {quotes.length > 0 ? <ul className="review-chips" aria-label={t`Quotes from replies`}>
          {quotes.map(quote => {
            const label = replyQuoteLabel(quote.text)
            return <li key={quote.id} className="review-chip" title={quote.text}>
            <Quote size={13} aria-hidden="true" className="review-chip__icon" />
            <span className="review-chip__label">{label}</span><span className="tt-visually-hidden">: {quote.text}</span>
            <button type="button" className="review-chip__remove tt-focusable" aria-label={t`Remove quote ${label}`} title={t`Remove quote`}
              onClick={event => removeChip(event.currentTarget, () => replyQuotes.remove(threadId, quote.id))}><X size={13} aria-hidden="true" /></button>
          </li>
          })}
        </ul> : null}
        {answering && (comments.length > 0 || quotes.length > 0) ? <p className="review-chips__note tt-paragraph">{heldNote(comments.length > 0, quotes.length > 0)}</p> : null}
        <label className="tt-visually-hidden" htmlFor={composerId} onClick={() => field.current?.focus()}>{fieldLabel}</label>
      </ThreadComposerEditor>
      <div className="thread-prompt__footer">
        <div className="thread-prompt__meta" id={statusId}>
          {/* Every composer belongs to a thread that already exists on its host, so the host is shown here, not chosen.
              Watcher's full composer has New Watcher in that place; the quiet pill keeps it beside Send. */}
          {watcher && !quiet ? <WatcherNewButton state={state} thread={row.thread} noticeSlot={settingsNotices} />
            : !quiet && threadHost ? <span className="thread-host-chip" title={hostTitle}>
            {threadHost.kind === 'local' ? <Laptop size={14} aria-hidden="true" /> : <Server size={14} aria-hidden="true" />}{hostLabel}</span> : null}
          {continuing !== undefined ? <ContinueOptions thread={row.thread} state={state} choice={continuing} />
            : row.thread.nativeSessionStarted === false || capabilities.configureThread || continueOffer !== undefined
            ? <ThreadOptions key={threadId} thread={row.thread} state={state} command={command} turnNote={false} noticeSlot={settingsNotices} watcher={watcher} continueOffer={continueOffer}
              quiet={quiet ? { effortScore, shieldSlot } : undefined}
              {...(editable && !answering ? { getDraftText: () => store.draft(threadId).text, onDraftText: (text: string) => { caretAfterInsert.current = text.length; edit({ text }); field.current?.focus() } } : {})} />
            : <><span className="thread-prompt__model"><ProviderMark provider={row.providerId} name={row.provider} />{row.model?.name ?? row.provider}<small>{answering ? t`Answer this question` : t`Manual prompt`}</small></span>
              {watcher ? inSlot(<WatcherPermissionChip model={row.model} provider={row.provider} inForce={row.thread.runtimeMode} noticeSlot={settingsNotices}
                disabled={watcherPermissionFixedReason(state, row.thread) !== undefined} fixedReason={watcherPermissionFixedReason(state, row.thread)} />) : null}</>}
          {status}
        </div>
        <div ref={actionsRow} className="thread-prompt__actions">
          {quiet ? <>
            {watcher ? <WatcherNewButton state={state} thread={row.thread} noticeSlot={settingsNotices} /> : null}
            {working ? <Button variant="ghost" className="thread-prompt__stop" data-beside aria-label={stopName} aria-keyshortcuts={stopKeys ? threadChordLabel(stopKeys, platform).keys : undefined}
              title={stopTitle} disabled={!canStop} onClick={interrupt}><Square size={10} fill="currentColor" aria-hidden="true" /></Button> : null}
            {/* One disc: Send, Queue while a turn runs, Steer while Steer's modifier is held. Its glyph says which. */}
            {discFace === 'steer'
              ? <Button className="thread-prompt__send thread-prompt__disc" data-face="steer" aria-label={t`Steer now`} aria-keyshortcuts={steerChord ? threadChordLabel(steerChord, platform).keys : undefined}
                title={t`Send this now, without waiting for the turn to end` + (steerChord ? ` ${threadChordLabel(steerChord, platform).suffix}` : '')} onClick={() => send(performance.now(), 'steer')}>
                <ArrowUpRight size={16} strokeWidth={2.4} aria-hidden="true" /></Button>
              : <Button className="thread-prompt__send thread-prompt__disc" data-face={discFace} aria-label={primaryLabel} aria-keyshortcuts="Enter" title={reason ?? primaryLabel} disabled={!canSend} type="submit">
                {discFace === 'queue' ? <ListPlus size={16} strokeWidth={2.4} aria-hidden="true" /> : <ArrowUp size={16} strokeWidth={2.4} aria-hidden="true" />}</Button>}
          </> : <>
          {running && capabilities.steer === true && content
            ? <Button variant="ghost" className="thread-prompt__steer" aria-label={t`Steer now`} aria-keyshortcuts={steerChord ? threadChordLabel(steerChord, platform).keys : undefined}
              disabled={!canSteer} title={canSteer ? t`Send this now, without waiting for the turn to end` + (steerChord ? ` ${threadChordLabel(steerChord, platform).suffix}` : '') : reason ?? (sendInFlight ? t`An earlier send is still on its way; Steer waits for it` : readingImages ? t`Wait for the attachment to be read` : answerState.sending ? t`Wait for the answer to be sent` : undefined)}
              onClick={() => send(performance.now(), 'steer')}><KeyedGlyph role="steer" keyCap={steerChord ? threadChordCap(steerChord, platform) : null} /></Button>
            : null}
          {/* While a turn runs, Stop carries its trace: the control that ends the turn is the sign that it is running. */}
          {working ? <Button variant="ghost" className="thread-prompt__stop" data-beside={content || undefined} aria-label={stopName} aria-keyshortcuts={stopKeys ? threadChordLabel(stopKeys, platform).keys : undefined} title={stopKeys ? `${stopName} ${threadChordLabel(stopKeys, platform).suffix}` : stopName} disabled={!canStop} onClick={() => void command({ type: 'interrupt', threadId })}>
            <KeyedGlyph role="stop" keyCap={stopKeys ? threadChordCap(stopKeys, platform) : null} /><span className="thread-prompt__trace" aria-hidden="true"><i /></span></Button> : null}
          {/* With nothing to send, Stop holds the send button's place; typed text brings the send back to the end, so Enter's button is never Stop. */}
          {/* The filled button is always what Enter does. Its full name stays in the label and title, so Queue prompt is never called Send. */}
          {continuing !== undefined
            // A narrow pane shows Continue alone; the name keeps the provider, and the strip above says it too.
            ? <Button className="thread-prompt__send" data-wide aria-label={t`Continue on ${continueTarget}`} aria-keyshortcuts="Enter" title={reason ?? t`Start a new ${continueTarget} thread with a handover of this one and your message`} disabled={!canSend} type="submit">
              <Trans>Continue<span className="thread-prompt__send-target"> on {continueTarget}</span></Trans><kbd className="thread-prompt__key" aria-hidden="true">{enterCap}</kbd></Button>
            : handover !== null && !working
            ? <Button className="thread-prompt__send" data-wide aria-label={handover.label} aria-keyshortcuts="Enter" title={reason ?? handover.label} disabled={!canSend} type="submit">
              <KeyedLabel word={t`Continue`} keyCap={enterCap} /></Button>
            : !working || content ? <Button className="thread-prompt__send" aria-label={primaryLabel} aria-keyshortcuts="Enter" title={reason ?? primaryLabel} disabled={!canSend} type="submit">
              <KeyedGlyph role={queueing ? 'queue' : 'send'} keyCap={enterCap} /></Button> : null}
          </>}
        </div>
      </div>
      <div ref={setSettingsNotices} className="thread-options-notices" />
    </form>
    {/* One toolbar owns its menus and shortcuts; the full composer keeps its original row. */}
    {quiet ? toolbarSlot ? createPortal(toolbar, toolbarSlot) : null : toolbar}
    {quiet && !watcher ? <div ref={setToolbarNotices} className="branch-toolbar-notices" /> : null}
    {metadata}
  </>
}

/** A button's word and the key that does the same, the key cap drawn as a key. A narrow pane shows the key alone (ADR-0153). */
function KeyedLabel({ word, keyCap }: { readonly word: string; readonly keyCap: string | null }): ReactNode {
  return <><span className="thread-prompt__word">{word}</span>{keyCap ? <kbd className="thread-prompt__key" aria-hidden="true">{keyCap}</kbd> : null}</>
}

interface ComposerControls {
  readonly draft: Omit<ComposerDraft, 'text' | 'draftId'>
  readonly save: ThreadComposerSnapshot['save']
  readonly saveError: string | null
  readonly answerState: ThreadComposerSnapshot['answer']
  readonly hasContent: boolean
  readonly hasUltrathink: boolean
  /** How much thought the draft seems to ask for (`effortSuggestion.ts`), read only by the quiet composer. */
  readonly effortScore: number
}

/** Text edits repaint the editor; the surrounding controls observe only the facts they display. */
function useComposerControls(store: ThreadDraftStore, threadId: string, scoreEffort: boolean): ComposerControls {
  const read = useMemo(() => {
    let previous: ComposerControls | undefined
    return (): ComposerControls => {
      const { draft, save, saveError, answer: answerState } = store.snapshot(threadId)
      const hasContent = hasDraftContent(draft)
      const hasUltrathink = /\bultrathink\b/iu.test(draft.text)
      // Read only where the quiet composer is on, so no other composer repaints as the score moves.
      const effortScore = scoreEffort ? draftEffortScore(draft.text) : 0
      if (previous && previous.save === save && previous.saveError === saveError
        && previous.answerState === answerState
        && previous.hasContent === hasContent && previous.hasUltrathink === hasUltrathink && previous.effortScore === effortScore
        && previous.draft.attachments === draft.attachments && previous.draft.skills === draft.skills
        && previous.draft.files === draft.files && previous.draft.requestId === draft.requestId) return previous
      return previous = { draft, save, saveError, answerState, hasContent, hasUltrathink, effortScore }
    }
  }, [store, threadId, scoreEffort])
  return useSyncExternalStore(store.subscribe, read)
}

/** The small, immediate typing path, including the menus that follow its caret. */
function ThreadComposerEditor({ row, state, command, store, composerId, editable, answering, placeholder, supported, attachable, watcher,
  field, caretAfterInsert, leavePickers, onMenuChange, fieldLabel, next = null, nextOpen = false, nextListId, nextActiveId, dictating = false, nextKey, edit, onSend, children }: {
  readonly row: ThreadRow
  readonly state: AgentState
  readonly command: Command
  readonly store: ThreadDraftStore
  readonly composerId: string
  readonly editable: boolean
  readonly answering: boolean
  readonly placeholder: string
  readonly supported: boolean
  /** Whether the draft takes attachments at all, whatever the model reads: once any file can be attached (ADR-0131). */
  readonly attachable: boolean
  /** Watcher's composer offers no native skills. */
  readonly watcher: boolean
  readonly field: RefObject<PromptEditorElement | null>
  readonly caretAfterInsert: RefObject<number | null>
  readonly leavePickers: RefObject<() => void>
  readonly onMenuChange: (open: boolean) => void
  /** The prompt's accessible name: "Your answer", "Watcher message" or "Prompt", in the interface language. */
  readonly fieldLabel: string
  /** The next prompt on offer (ADR-0132), its list's state and its keys; absent, the composer is as it was. */
  readonly next?: NextPrompt | null
  readonly nextOpen?: boolean
  readonly nextListId?: string
  readonly nextActiveId?: string | undefined
  readonly dictating?: boolean
  readonly nextKey?: (event: KeyboardEvent<HTMLElement>, ghostShown: boolean) => boolean
  readonly edit: (patch: Parameters<ThreadDraftStore['edit']>[1]) => void
  /** The keydown that sent, when a key did, so the composer can tell Enter from Steer now's chord. */
  readonly onSend: (event?: KeyboardEvent<HTMLElement>) => void
  readonly children: ReactNode
}): ReactNode {
  const { t } = useLingui()
  const threadId = row.thread.id
  const { draft } = useThreadComposer(store, threadId)
  const ghostText = next?.ghost ?? ''
  const anyFile = useOwlFeature('attach-any-file')
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
  // The ghost steps aside while dictation writes, while a list is open and once the text has left the next prompt behind.
  const ghost = next !== null && !dictating && !nextOpen && !menuOpen ? ghostRest(next.ghost, draft.text) : null
  const ghostId = `${composerId}-ghost`

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
    {ghost !== null && next !== null ? <span className="tt-visually-hidden" id={ghostId}>{t({ message: `Suggested next prompt: ${ghostText}. Press Tab to take it, or Up for more.`, comment: '{ghostText} is the suggested prompt.' })}</span> : null}
    {/* Screenshots still being staged when the user moves to another thread join this thread's draft as it is then. */}
    <ScreenshotInput key={threadId} target={threadId} attachments={draft.attachments} disabled={!editable} supported={anyFile ? attachable : supported}
      imagesSupported={row.model?.supportsImages === true}
      reads={screenshotReads} onChange={attachments => edit({ attachments })}>
      <PromptEditor fieldRef={field} caretAfterInsert={caretAfterInsert} id={composerId} text={draft.text} skills={draft.skills} sigils={sigils} catalog={picker.catalog}
        label={fieldLabel} editable={editable} ghost={ghost}
        aria-describedby={ghost !== null ? `${statusId} ${ghostId}` : statusId}
        aria-autocomplete={menus || next !== null ? 'list' : undefined}
        aria-controls={picker.open && picker.options.length ? listId : files.open && files.options.length ? fileListId : nextOpen ? nextListId : undefined}
        aria-expanded={menus || next !== null ? menuOpen || nextOpen : undefined}
        aria-activedescendant={picker.open && picker.activeIndex !== null ? skillOptionId(listId, picker.activeIndex)
          : files.open && files.activeIndex !== null ? fileOptionId(fileListId, files.activeIndex) : nextOpen ? nextActiveId : undefined}
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
          if (!menuOpen && nextKey?.(event, ghost !== null)) return
          if (key.key === 'Enter' && key.menuOpen && !isCompositionKey(key) && !key.shiftKey && !key.altKey) { event.preventDefault(); return }
          if (composerEnterIntent(key) !== 'send') return
          // Enter never inserts a stray newline, even when sending is blocked.
          event.preventDefault()
          onSend(event)
        }} />
    </ScreenshotInput>
  </>
}
