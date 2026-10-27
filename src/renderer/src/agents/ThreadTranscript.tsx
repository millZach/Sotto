import React, { memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMark } from '../components/marks'
import { createPortal, flushSync } from 'react-dom'
import { ArrowDown, Check, ChevronRight, Copy, GitFork, MessageSquare } from 'lucide-react'
import type { MessageDescriptor } from '@lingui/core'
import { msg, ph, plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { AgentActivity } from '../../../shared/agentActivity'
import { hostForThread, isThreadBusy, isVisualMessage, type AgentMessage, type AgentState, type ThreadContinuedIn } from '../../../shared/agents'
import { Button } from '../components/Button'
import { useAgents, type AgentConnection } from './AgentContext'
import { sendThreadRevision } from './ThreadComposer'
import { useWatchActions } from '../watcher/watcherRoom'
import { watchAfterSend } from '../watcher/watchOnSend'
import { followupsFor } from './ThreadFollowups'
import { deliveryFor, deliveryPending, hasDraftContent, queuedRevision, submissionStatus, useSubmissions, useThreadComposer, type Submission, type SubmissionStatus, type ThreadDraftStore } from './threadDraftStore'
import { clockLabel, type ThreadRow } from './threadFacts'
import { useShared } from './stateSharing'
import { foldedTurns, setStepsOpen, useStepsOpen } from './stepsOpen'
import { MessageContent, AttachmentPreviews } from './MessageContent'
import { renderedPlainText, useTransientFlag, writeClipboard } from './richActions'
import { LinkMenu, type LinkMenuItem } from '../tools/webLinks'
import { ActivityGroupView, CompactionLine, foldOnEscape, LiveActivity, TurnChangedFiles } from './ThreadActivity'
import { OwnServerTurnContext, TurnFailureReason, useOwnServerTurns } from './OwnServerTurn'
import { ActivityBodyContext, type ActivityBodyHost } from './activityBodies'
import { threadHostName } from './HostBadge'
import { isDrawableVisual, VisualCard } from './VisualCard'
import { MOST_LIFTED, questionsIn } from './liftedQuestions'
import { isWakeUpMessage, wakeUpMarkdown } from './babysitting'
import { SottoMark } from '../components/SottoMark'
import { isResumeNoteText } from '../../../shared/restartResume'
import { useOwlFeature } from '../state/owlFeature'
import { useInterfaceLanguageState } from '../state/interfaceLanguage'
import { WatcherOwl } from '../watcher/WatcherOwl'
import { WatcherOwnChangeFor } from '../watcher/WatcherOwnChange'
import { useRepliesKeptInView, WatcherAfterMessage } from '../watcher/WatcherReceipts'
import { HandoverFromContext, HandoverMessage } from '../watcher/WatcherHandover'
import { ContinuedFromNote, ContinuedInNotes } from './ContinueThread'
import { ContinueLinksContext, continuedInByTurn, useContinueEnabled, type ContinueLinks } from './continuations'
import { StartHandoverCard, ThreadStartContext, ThreadStartNote, threadStartView, useThreadStartView, useThreadStarts } from './ThreadStart'
import { ReplyQuoteButton } from './ReplyQuoteButton'
import { ForkCard, ForkContext, ForkPress, useForkOptions, type ForkOptions } from './ForkFromHere'
import { isThreadClosed, threadOrnamentAllowed } from '../../../shared/threadActivity'
import type { AgentBackgroundWork } from '../../../shared/agentMonitoring'
import { ThreadGreeting } from './ThreadGreeting'
import type { DelegationView } from '../../../shared/delegation'
import { DelegatedWork, DelegatedWorkSummary, DelegationWorldProvider, delegationsByTurn, StillWorking, stillWorkingAgents, UnfoldedWork, useDelegationWorld } from './DelegatedWork'
import { useDelegations, useDelegationsEnabled } from './delegations'
import { MessageScrubber } from './MessageScrubber'
import { keepReadingPlace, MessageRows, MessageRowsContext, readingPlace, scrolledSince, scrollsTranscript, type ReadingPlace } from './readingPlace'
import { readsBack, typesIntoComposer } from './slimComposer'
import { aboveWindow, joinedMarks, scrubberMarks, storedMarks, SCRUBBER_FEWEST, type ScrubberMark } from './messageScrubberMarks'
import { useSlidMarks, useStoredPrompts } from './useStoredPrompts'
import { shownWords, type LaterWords } from './interfaceWords'
import { shownCount } from '../state/interfaceNumbers'
import { compactionOf, isStep, liveTurnId, newsWorkLabel, placeActivities, splitTurns, stepsLabel, turnChanges, workHeadline, type ActivityGroup, type ActivityPlacement, type TranscriptTurn, type TurnChange } from './threadActivityView'

type Command = AgentConnection['command']
/** No message is left behind while no fork card is open. */
const NOTHING_AFTER: ReadonlySet<string> = new Set()

export const TRANSCRIPT_PAGE = 80
/** Within this many pixels of the end, the reader is following the conversation. */
const FOLLOW_SLACK_PX = 48

const STATUS_LABELS: Record<SubmissionStatus, MessageDescriptor> = {
  queued: msg({ message: 'Queued', comment: 'A sent message\'s delivery status.' }),
  submitting: msg({ message: 'Sending', comment: 'A sent message\'s delivery status.' }),
  accepted: msg({ message: 'Sent', comment: 'A sent message\'s delivery status.' }),
  failed: msg({ message: 'Not sent', comment: 'A sent message\'s delivery status.' }),
  uncertain: msg({ message: 'Unconfirmed', comment: 'A sent message\'s delivery status: Sotto does not know whether the provider took it.' }),
}

export interface ActivityContext {
  readonly liveTurn: string | null
  readonly running: boolean
  readonly connected: boolean
  readonly provider: string
  readonly onDisclosure: (element: HTMLElement) => void
  /** Brings an earlier message into view and focus for Show where it asked; the reader stops following the end. */
  readonly onSeek?: ((message: HTMLElement) => void) | undefined
}

function ActivityGroups({ groups, context, outcome }: {
  readonly groups: readonly ActivityGroup[] | undefined; readonly context: ActivityContext; readonly outcome?: AgentActivity['status'] | undefined
}): ReactNode {
  return groups?.map(group => {
    const compaction = compactionOf(group)
    // The running turn's steps fold under its working line at the end of the transcript; only its boundaries stay here.
    return compaction
      ? <CompactionLine key={group.key} record={compaction} />
      : group.turnId === context.liveTurn ? null
      : <ActivityGroupView key={group.key} group={group} live={false} threadRunning={context.running}
        connected={context.connected} provider={context.provider} onDisclosure={context.onDisclosure} outcome={outcome} />
  }) ?? null
}

/** A folded reply that asked something, and the questions it asked. */
interface LiftedReply { readonly message: AgentMessage; readonly questions: readonly string[] }

/** How long a reply reached by Show where it asked stays marked. */
const SOUGHT_MS = 1_600

/** Each marked reply's own clearing, so a second press while it is marked keeps the mark for the full time again. */
const soughtTimers = new WeakMap<HTMLElement, number>()
const seekWithoutTranscript = (message: HTMLElement): void => {
  message.scrollIntoView?.({ block: 'center' })
  message.focus({ preventScroll: true })
}
/** Marks a message the reader was taken to, for a moment, so the eye finds where it landed. */
function markSought(message: HTMLElement): void {
  message.dataset.sought = ''
  window.clearTimeout(soughtTimers.get(message))
  soughtTimers.set(message, window.setTimeout(() => { delete message.dataset.sought; soughtTimers.delete(message) }, SOUGHT_MS))
}
/** The room left above a message the scrubber lands on, so its header is not against the transcript's top. */
const LANDING_GAP_PX = 16
/** Frames spent putting a landed message back at the top while the messages around it are laid out for real. */
const LANDING_FRAMES = 3

/** A lifted question's words, with the code it quoted between backticks drawn as code. */
function QuestionWords({ text }: { readonly text: string }): ReactNode {
  return text.split(/`([^`]+)`/u).map((part, index) => index % 2 ? <code key={index}>{part}</code> : part)
}

/**
 * A finished turn's work, folded to one line above its final reply: the replies written on the way and every
 * activity group, in the order they happened. The turn's own error stays in view, and so does every question a
 * folded reply asked, quoted under the line with a way back to the reply that asked it (#1019).
 */
function TurnWork({ headline, steps, delegated, open, setOpen, turn, failed, changes, onDisclosure, onSeek, lifted, who, children }: {
  readonly headline: string; readonly turn?: AgentActivity | undefined; readonly changes: readonly TurnChange[]
  /** How many steps the fold holds, after the headline ("Worked for 2m 04s · 12 steps"). */
  readonly steps: number
  /** The turn's delegated work in a few words, after the headline, so a closed fold still says what it holds. */
  readonly delegated?: ReactNode
  /**
   * Whether the fold is open, held by the turn, which keeps what still works under its reply only while the fold is closed.
   * `setOpen` holds this fold only; a press also sets how every fold not yet pressed starts.
   */
  readonly open: boolean; readonly setOpen: (open: boolean) => void
  /** The turn failed: its line is where a press that opens the thread at its failed turn lands. */
  readonly failed: boolean
  readonly onDisclosure: (element: HTMLElement) => void; readonly onSeek?: ((message: HTMLElement) => void) | undefined
  readonly lifted: readonly LiftedReply[]; readonly who: string; readonly children: ReactNode
}): ReactNode {
  const { t } = useLingui()
  const body = useRef<HTMLDivElement>(null)
  const bodyId = useId()
  const liftedId = useId()
  // The fold opens before the reply is looked for, because a closed fold does not draw its replies.
  const seek = (messageId: string): void => {
    flushSync(() => setOpen(true))
    const message = [...body.current?.querySelectorAll<HTMLElement>('.thread-message[data-message-id]') ?? []].find(element => element.dataset.messageId === messageId)
    if (!message) return
    message.tabIndex = -1
    markSought(message)
    ;(onSeek ?? seekWithoutTranscript)(message)
  }
  return <>
    <section className="thread-work" data-expanded={open || undefined} data-turn-outcome={failed ? 'failed' : undefined} aria-labelledby={`${bodyId}-headline`}
      onKeyDown={foldOnEscape(open, summary => { onDisclosure(summary); setOpen(false) })}>
      <button type="button" className="thread-work__summary tt-focusable" aria-expanded={open} aria-controls={open ? bodyId : undefined}
        onClick={event => { onDisclosure(event.currentTarget); setOpen(!open); setStepsOpen(!open) }}>
        <span id={`${bodyId}-headline`} className="thread-work__headline">{headline}{steps ? ` · ${stepsLabel(steps)}` : null}{delegated}</span>
        <ChevronRight className="thread-activity__chevron" size={14} aria-hidden="true" />
      </button>
      <TurnChangedFiles changes={changes} onDisclosure={onDisclosure} />
      <TurnFailureReason turn={turn} />
      {open ? <div id={bodyId} ref={body} className="thread-work__body">{children}</div> : null}
    </section>
    {lifted.map(({ message, questions }) => {
      const time = clockLabel(Date.parse(message.createdAt))
      const more = questions.length - MOST_LIFTED
      return <section key={message.id} className="thread-lifted" aria-labelledby={`${liftedId}-${message.id}`}>
        <p className="thread-lifted__who" id={`${liftedId}-${message.id}`}><Trans comment="{who} is the provider or Watcher; the time follows.">{who} asked while working · <time dateTime={message.createdAt}>{time}</time></Trans></p>
        <blockquote className="thread-lifted__questions">{questions.slice(0, MOST_LIFTED).map(question => <p key={question}><QuestionWords text={question} /></p>)}</blockquote>
        {more > 0 ? <p className="thread-lifted__more tt-paragraph">{plural(more, { one: 'One more question in that reply.', other: '# more questions in that reply.' })}</p> : null}
        <button type="button" className="thread-lifted__where tt-focusable" aria-label={t`Show where it asked, at ${time}`} onClick={() => seek(message.id)}>{t`Show where it asked`}</button>
      </section>
    })}
  </>
}

/** Replies are shared across updates, so a reply's questions are found once. */
const liftedQuestions = new WeakMap<AgentMessage, readonly string[]>()
function asked(message: AgentMessage): readonly string[] {
  let questions = liftedQuestions.get(message)
  if (!questions) liftedQuestions.set(message, questions = questionsIn(message.text))
  return questions
}

/** Inside a folded turn the turn line already says how it ended, so its groups carry only their counts, and the boundaries it crossed are drawn outside the fold. */
const folded = (groups: readonly ActivityGroup[] | undefined): ActivityGroup[] =>
  (groups ?? []).filter(group => group.records.length > 0 && !compactionOf(group))
    .map(group => group.turn ? { key: group.key, turnId: group.turnId, anchorMessageId: group.anchorMessageId, records: group.records } : group)

/**
 * Rendered history, turn by turn. A finished turn shows the user's message and its final reply, with everything in
 * between folded under one "Worked for" line above the reply, and the questions the folded replies asked quoted under
 * that line. The running turn shows its messages and activity as
 * they arrive. Memoized on the message array and placement so composer keystrokes and status ticks do not repaint it.
 *
 * An assistant message with no text yet (a provider call that so far holds only tool use) draws no header.
 * With `streamText` off, the reply being written is held back until something follows it: activity after it,
 * a later message, or the end of the turn. Activity itself always appears as it runs.
 */
const drawn = (message: AgentMessage): boolean => message.role === 'user' || message.text.length > 0 || Boolean(message.attachments?.length)

/**
 * The per-message copy control (#128): one quiet mark pinned to the message's bottom-left corner,
 * revealed while the message is hovered or holds focus. A press copies the message's source
 * Markdown; right-click, Shift+F10 or the ContextMenu key offers plain text instead.
 */
function MessageCopy({ message, article }: { readonly message: AgentMessage; readonly article: React.RefObject<HTMLElement | null> }): ReactNode {
  // The flag holds what happened, and the words for it are read when shown, in the interface language.
  const [outcome, showOutcome] = useTransientFlag()
  const [menuAt, setMenuAt] = useState<{ readonly x: number; readonly y: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const { t } = useLingui()
  const reply = message.role === 'assistant'
  const name = reply ? t`Copy reply as Markdown` : t`Copy message as Markdown`
  const copied = outcome !== null && outcome !== 'failed'
  const feedback = outcome === null ? null : outcome === 'failed' ? t`Copy failed` : outcome === 'plain' ? t`Copied as plain text`
    : reply ? t`Copied reply as Markdown` : t`Copied message as Markdown`
  const copy = (format: 'markdown' | 'plain'): void => {
    const rendered = article.current?.querySelector('.rich-message')
    const text = format === 'markdown' || !rendered ? message.text : renderedPlainText(rendered)
    void writeClipboard(text).then(
      () => showOutcome(format),
      () => showOutcome('failed'))
  }
  const openMenu = (point: { readonly x: number; readonly y: number } | null): void => {
    const rect = button.current?.getBoundingClientRect()
    setMenuAt(point ?? { x: rect?.left ?? 0, y: (rect?.bottom ?? 0) + 4 })
  }
  const menuItems: LinkMenuItem[] = [
    { id: 'markdown', label: t`Copy as Markdown`, run: () => copy('markdown') },
    { id: 'plain', label: t`Copy as plain text`, run: () => copy('plain') },
  ]
  return <>
    <button type="button" ref={button} className="thread-message__copy tt-focusable" aria-label={name} title={name}
      aria-haspopup="menu" aria-expanded={menuAt ? true : undefined} data-copied={copied || undefined}
      onClick={() => copy('markdown')}
      onContextMenu={event => {
        event.preventDefault()
        // A keyboard-invoked context menu reports no pointer position, so it opens beside the control.
        openMenu(event.clientX === 0 && event.clientY === 0 ? null : { x: event.clientX, y: event.clientY })
      }}
      onKeyDown={event => {
        if (!(event.key === 'F10' && event.shiftKey) && event.key !== 'ContextMenu') return
        event.preventDefault()
        openMenu(null)
      }}>
      {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
      {feedback ? <span className="thread-message__copy-label">{copied ? t`Copied` : feedback}</span> : null}
    </button>
    <span className="tt-visually-hidden" role="status" aria-live="polite">{feedback}</span>
    {menuAt ? <LinkMenu at={menuAt} label={t`Copy options`} items={menuItems} returnFocus={button.current} onClose={() => setMenuAt(null)} /> : null}
  </>
}

/**
 * Who sent a wake-up: Sotto, with its mark, and what it is. A wake-up that opens with the resume note is a resume
 * (ADR-0076); the text is read only once the host's own record has made the message Sotto's.
 */
function WakeUpWho({ text }: { readonly text: string }): ReactNode {
  const { t } = useLingui()
  const resumed = useOwlFeature('resume-after-restart') && isResumeNoteText(text)
  return <><span className="thread-message__who"><SottoMark className="thread-message__mark" />Sotto</span><span className="thread-message__tag">{resumed
    ? t({ message: 'Resumed', comment: 'The tag on a message Sotto sent to resume a thread after a restart.' })
    : t({ message: 'Wake-up', comment: 'The tag on a message Sotto sent to wake a thread.' })}</span></>
}

/**
 * One message in the transcript. Memoised on the message itself: the state the window receives shares the
 * structure of the one before it, so a message the update did not touch is the same object and is not redrawn
 * while the agent streams into the message below it. `threadId` is how a submitted attachment finds its preview.
 */
const MessageArticle = memo(function MessageArticle({ message, provider, writing, streamText, threadId, speaker, delegatedBy, forkable, work, workGroups, activity }: {
  readonly message: AgentMessage; readonly provider: string; readonly writing: boolean; readonly streamText: boolean
  readonly threadId: string | undefined
  /** Watcher's conversation names its replies Watcher, with the owl, whatever provider it runs on. */
  readonly speaker?: 'watcher' | undefined
  /** A brief the delegating thread sent: that thread's name, shown in the user's place (ADR-0081). */
  readonly delegatedBy?: string | undefined
  /** A finished turn's newest written reply, which offers Fork from here where the transcript does (#1028, E5b). */
  readonly forkable?: boolean | undefined
  /**
   * The work of the turn this reply opens, folded into its header: Watcher's reply to news. Its groups come shared from
   * the placement, and the rest is plain values, so the memo still holds while other turns change.
   */
  readonly work?: string | undefined
  readonly workGroups?: readonly ActivityGroup[] | undefined
  readonly activity?: ActivityContext | undefined
}): ReactNode {
  const { t } = useLingui()
  const article = useRef<HTMLElement>(null)
  // The transcript finds this message's row by its ID, without searching the page (#1452).
  const rows = useContext(MessageRowsContext)
  const placeRow = useCallback((element: HTMLElement | null): (() => void) | undefined => {
    article.current = element
    return element !== null && rows !== null ? rows.add(message.id, element) : undefined
  }, [rows, message.id])
  const workButton = useRef<HTMLButtonElement>(null)
  const [pressedOpen, setWorkOpen] = useState<boolean | null>(null)
  const stepsOpen = useStepsOpen()
  const workOpen = pressedOpen ?? stepsOpen
  const workId = useId()
  const foldWork = (event: React.KeyboardEvent): void => {
    if (!workOpen || event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing || !workButton.current) return
    event.preventDefault()
    workButton.current.focus()
    activity?.onDisclosure(workButton.current)
    setWorkOpen(false)
  }
  const lifecycle = workGroups?.find(group => group.turn)?.turn
  // A wake-up babysitting sent is Sotto's, told by the host's mark and never by its text, and shows every word the
  // provider received, as it received it (ADR-0061 decision 8).
  const wakeUp = isWakeUpMessage(message)
  const markdown = useMemo(() => wakeUp ? wakeUpMarkdown(message.text) : message.text, [wakeUp, message.text])
  // A brief the delegating thread sent here is that thread's, never the user's (ADR-0081).
  const brief = delegatedBy !== undefined && message.role === 'user' && !wakeUp
  // The handover Watcher's first message carried goes ahead of the user's words, as Sotto's (ADR-0073), and so does the one
  // a thread that began from another started with (#1028).
  const started = useThreadStartView()
  // Fork from here (#1028, E5b): offered on a finished turn's reply; what follows the open one is not carried.
  const fork = useForkOptions()
  const forkHere = forkable === true && fork !== null && !writing
  const forkedAt = started !== null && started !== 'off' && started.start.from === 'turn' && started.start.route === 'fork' && started.start.messageId === message.id
  return <>{message.handover && message.role === 'user' ? started === 'off' ? null : started ? <StartHandoverCard view={started} handover={message.handover} createdAt={message.createdAt} />
    : <HandoverMessage handover={message.handover} createdAt={message.createdAt} /> : null}
  <article className="thread-message" data-role={message.role} data-from={wakeUp ? 'sotto' : brief ? 'delegation' : undefined} data-message-id={message.id} ref={placeRow}
    data-not-carried={fork?.after.has(message.id) || undefined} data-turn-outcome={work && lifecycle?.status === 'failed' ? 'failed' : undefined} onKeyDown={work ? foldWork : undefined}>
    <header>{wakeUp ? <WakeUpWho text={message.text} />
      : brief ? <><span className="thread-message__who"><GitFork size={13} aria-hidden="true" />{delegatedBy}</span><span>{t({ message: 'delegated', comment: 'Follows the name of the thread that sent this brief: that thread delegated it.' })}</span></>
      : <span className="thread-message__who">{message.role === 'user' ? t({ message: 'You', comment: 'Who wrote a message: the user.' }) : message.role === 'assistant' ? speaker === 'watcher' ? <><WatcherOwl size={13} />Watcher</> : provider : t({ message: 'System', comment: 'Who wrote a message: the system.' })}</span>}
      <time dateTime={message.createdAt}>{clockLabel(Date.parse(message.createdAt))}</time>
      {work ? <button type="button" ref={workButton} className="thread-message__work tt-focusable" aria-expanded={workOpen} aria-controls={workOpen ? workId : undefined}
        onClick={event => { activity?.onDisclosure(event.currentTarget); setWorkOpen(!workOpen); setStepsOpen(!workOpen) }}>
        {work}<ChevronRight className="thread-activity__chevron" size={13} aria-hidden="true" />
      </button> : null}</header>
    {work ? <TurnFailureReason turn={lifecycle} /> : null}
    {work && workOpen && activity ? <div id={workId} className="thread-message__work-body">
      <ActivityGroups groups={folded(workGroups)} context={activity} outcome={lifecycle?.status} /></div> : null}
    {writing && !streamText
      ? <p className="thread-message__writing tt-paragraph" role="status">{t`Writing a reply…`}</p>
      : <MessageContent text={markdown} streaming={writing} commands={message.role === 'assistant'} />}
    <AttachmentPreviews attachments={message.attachments ?? []} origin={threadId === undefined ? undefined : { threadId, messageId: message.id }} />
    {speaker === 'watcher' && message.role === 'assistant' && !writing ? <WatcherOwnChangeFor message={message} /> : null}
    {!writing && message.text.length > 0 && (message.role === 'user' || message.role === 'assistant') ? <MessageCopy message={message} article={article} /> : null}
    {forkHere ? <ForkPress messageId={message.id} at={message.createdAt} /> : null}
  </article>
  {speaker === 'watcher' ? <WatcherAfterMessage message={message} /> : null}
  {forkHere ? <ForkCard messageId={message.id} at={message.createdAt} /> : null}
  {forkedAt ? <ThreadStartNote view={started} /> : null}</>
})

/**
 * One turn: the user's message, the work it caused and its reply. Memoised, so a chunk arriving in the turn
 * being written leaves every earlier turn in the transcript untouched. `last` is what the running turn needs
 * to know about its place; everything else it reads is shared across updates.
 */
const TurnView = memo(function TurnView({ turn, provider, running, last, writing, placement, context, streamText, threadId, speaker, delegations, backgroundWork, briefs, continuedIn }: {
  readonly turn: TranscriptTurn; readonly provider: string; readonly last: boolean
  /** The thread is working on the newest turn drawn, so that turn, when `last`, keeps the live layout. */
  readonly running: boolean
  readonly writing: string | undefined
  readonly speaker?: 'watcher' | undefined
  readonly placement: ActivityPlacement; readonly context: ActivityContext; readonly streamText: boolean
  readonly threadId: string | undefined
  /** The delegations this turn's message rooted (ADR-0081), as rows in its Worked for fold, or under its reply when nothing folds. */
  readonly delegations?: readonly DelegationView[] | undefined
  /** The provider's agents still running after this turn's reply: given only to the newest turn, once it has finished. */
  readonly backgroundWork?: readonly AgentBackgroundWork[] | undefined
  readonly briefs?: DelegatedBriefs | undefined
  /** The threads that continue this one, made while this turn was the newest (ADR-0089), as notes under it. */
  readonly continuedIn?: readonly ThreadContinuedIn[] | undefined
}): ReactNode {
  // Its work lines are worded by helpers, so it draws again when the interface language changes.
  useInterfaceLanguageState()
  // The turn holds its fold's state: what still works after the reply stands under it only while the fold is closed. Until
  // pressed, the fold starts as the user last left any turn's steps.
  const [pressedOpen, setWorkOpen] = useState<boolean | null>(null)
  const stepsOpen = useStepsOpen()
  // A fork carries finished turns, so only a finished turn's newest written reply offers one (#1028, E5b).
  const forkableId = running && last ? undefined : turn.replies.findLast(message => message.role === 'assistant' && !isVisualMessage(message) && !isWakeUpMessage(message) && drawn(message))?.id
  // A visual an agent drew is its card; one this window cannot draw is its text, which says what it showed (ADR-0056).
  const article = (message: AgentMessage, work?: { readonly label: string; readonly groups: readonly ActivityGroup[] }): ReactNode => isDrawableVisual(message)
    ? <VisualCard visual={message.visual} threadId={threadId} />
    : drawn(message) && <MessageArticle message={message} provider={provider} writing={message.id === writing} streamText={streamText} threadId={threadId} speaker={speaker}
      delegatedBy={briefs?.ids.has(message.id) ? briefs.from : undefined} forkable={message.id === forkableId}
      {...work ? { work: work.label, workGroups: work.groups, activity: context } : {}} />
  const plain = (message: AgentMessage): ReactNode => <React.Fragment key={message.id}>
    {article(message)}
    <ActivityGroups groups={placement.after.get(message.id)} context={context} />
  </React.Fragment>
  const everything = turn.user ? [turn.user, ...turn.replies] : [...turn.replies]
  // A visual is Sotto's drawing, not a reply, so it is never the final reply and never folds: it stays in view where it
  // was drawn, before or after the final reply (ADR-0056). One pass sorts the replies into the two.
  const written: AgentMessage[] = []
  const visuals: { readonly message: AgentMessage; readonly at: number }[] = []
  for (const [at, message] of turn.replies.entries()) {
    if (isVisualMessage(message)) visuals.push({ message, at })
    else written.push(message)
  }
  // An unshown turn's work, which happened before the reply that opens the turn. In Watcher's pane a news turn's work
  // shows only folded into its reply, so a finished one with no written reply to carry it shows none (variant b).
  const shownOpening = turn.unshown ? placement.unshown.get(turn.replies[0]!.id) : undefined
  const opening = speaker === 'watcher' && !(running && last) ? withoutFinishedNews(shownOpening, context.liveTurn) : shownOpening
  // The running turn keeps its live layout, and a page that starts mid-turn has no start to fold from;
  // a finished turn folds under its last written reply.
  const final = !turn.user && !turn.unshown || running && last ? undefined : written.findLast(message => message.role === 'assistant' && drawn(message))
  // In Watcher's own pane, a reply that carries receipt cards stays in view where it was written, as a visual does: its
  // cards say what Watcher did in that turn, and a closed fold would hide them.
  const kept = useRepliesKeptInView()
  if (final !== undefined && kept !== null) for (const [at, message] of turn.replies.entries()) {
    if (message !== final && kept.has(message.id) && !isVisualMessage(message)) visuals.push({ message, at })
  }
  visuals.sort((a, b) => a.at - b.at)
  const replyGroups = everything.flatMap(message => placement.after.get(message.id) ?? [])
  // Shared across updates, so the reply that carries a news turn's work keeps its memo while other turns change.
  const groups = useShared(!replyGroups.length && shownOpening ? shownOpening : [...shownOpening ?? [], ...replyGroups])
  // A compaction is where the conversation lost its history, so it stays in view instead of folding with the work.
  const boundaries = groups.filter(group => compactionOf(group))
  const continued = continuedIn?.length ? <ContinuedInNotes links={continuedIn} /> : null
  // Watcher's reply to news (Zach's pick on October 19, 2026, variant b of docs/prototypes/watcher-news-turns-prototype.html):
  // Watcher's conversation leaves out only Sotto's news wake-ups (watcherWakeUpsAsShown), so its unshown turns are news
  // turns. Each has no line of its own: its work folds into the header of the first reply it wrote, and every reply stays.
  if (speaker === 'watcher' && turn.unshown && final) {
    const lifecycle = groups.find(group => group.turn)?.turn
    const records = groups.flatMap(group => group.records)
    const head = written.find(message => message.role === 'assistant' && drawn(message))
    const replyWork = head && records.some(record => record.kind !== 'compaction') ? {
      label: newsWorkLabel(lifecycle, context.running, lifecycle?.startedAt ?? records.map(record => record.startedAt).filter(Boolean).sort()[0],
        [...turn.replies.map(message => message.createdAt), ...records.map(record => record.completedAt ?? record.startedAt)]),
      groups,
    } : undefined
    return <>
      <ActivityGroups groups={replyWork ? boundaries : groups} context={context} />
      {turn.replies.map(message => <React.Fragment key={message.id}>{article(message, message === head ? replyWork : undefined)}</React.Fragment>)}
      <DelegatedWork views={delegations} />
      {continued}
    </>
  }
  const work = final ? written.filter(message => message !== final && drawn(message) && !visuals.some(visual => visual.message === message)) : []
  // A turn whose only record is how it ended has nothing to fold; its group states the outcome itself.
  if (!final || (!work.length && !groups.some(group => group.records.length && !compactionOf(group)))) return <>
    <ActivityGroups groups={opening} context={context} />{everything.map(plain)}<UnfoldedWork views={delegations} work={final ? backgroundWork : undefined} />{continued}</>
  const finalAt = turn.replies.indexOf(final)
  const unfolded = new Set(visuals.map(visual => visual.message))
  const shown = (from: number, to: number): ReactNode => visuals.filter(visual => visual.at > from && visual.at < to)
    .map(({ message }) => <React.Fragment key={message.id}>{article(message)}</React.Fragment>)
  const lifecycle = groups.find(group => group.turn)?.turn
  // A turn whose working line was folded with Escape stays folded once it ends.
  const workOpen = pressedOpen ?? (lifecycle !== undefined && foldedTurns.has(lifecycle.turnId) ? false : stepsOpen)
  const moments = [...turn.replies.map(message => message.createdAt), ...groups.flatMap(group => group.records.map(record => record.completedAt ?? record.startedAt))]
  // A question a folded reply asked would fold away with it, so it is quoted under the fold (#1019).
  const lifted = work.flatMap(message => message.role === 'assistant' && !isWakeUpMessage(message) && asked(message).length ? [{ message, questions: asked(message) }] : [])
  return <>
    {turn.user ? article(turn.user) : null}
    <TurnWork headline={workHeadline(lifecycle, context.running, turn.user?.createdAt, moments)} steps={groups.reduce((count, group) => count + group.records.filter(isStep).length, 0)} delegated={<DelegatedWorkSummary views={delegations} />} open={workOpen} setOpen={setWorkOpen} turn={lifecycle} failed={lifecycle?.status === 'failed'}
      changes={turnChanges(groups)} onDisclosure={context.onDisclosure} onSeek={context.onSeek} lifted={lifted} who={speaker === 'watcher' ? 'Watcher' : provider}>
      <ActivityGroups groups={folded(opening)} context={context} outcome={lifecycle?.status} />
      {everything.filter(message => message !== final).map(message => <React.Fragment key={message.id}>
        {message === turn.user || unfolded.has(message) ? null : article(message)}
        <ActivityGroups groups={folded(placement.after.get(message.id))} context={context} outcome={lifecycle?.status} />
      </React.Fragment>)}
      <ActivityGroups groups={folded(placement.after.get(final.id))} context={context} outcome={lifecycle?.status} />
      <DelegatedWork views={delegations} />
    </TurnWork>
    {shown(-1, finalAt)}
    <ActivityGroups groups={boundaries} context={context} />
    {article(final)}
    {workOpen ? null : <StillWorking views={delegations} work={backgroundWork} />}
    {shown(finalAt, Number.POSITIVE_INFINITY)}
    {continued}
  </>
})

/**
 * Watcher's news turns' work without the turns that finished, the same array when none did: what is left says a turn
 * failed, stopped or is still going. A turn with no lifecycle record has finished once nothing in it runs and it is not
 * the live turn. Compactions stay, as boundaries do everywhere.
 */
function withoutFinishedNews(groups: readonly ActivityGroup[] | undefined, liveTurn: string | null): readonly ActivityGroup[] | undefined {
  if (!groups?.length) return groups
  const going = new Set<string>()
  for (const group of groups) {
    const status = group.turn?.status
    if (group.turnId === liveTurn || status !== undefined && status !== 'completed' || group.records.some(record => record.status === 'running')) going.add(group.turnId)
  }
  const shown = groups.filter(group => going.has(group.turnId) || compactionOf(group))
  return shown.length === groups.length ? groups : shown
}

/** The briefs a delegating thread sent to this thread, by their message IDs, and that thread's name (ADR-0081). */
export interface DelegatedBriefs { readonly ids: ReadonlySet<string>; readonly from: string }

export const MessageList = memo(function MessageList({ messages, provider, running, sending = false, placement, context, streamText = true, threadId, speaker, delegations, backgroundWork, briefs, continuedIn }: {
  readonly messages: readonly AgentMessage[]; readonly provider: string; readonly running: boolean
  /** A prompt the user sent is drawn below these messages until the history carries it, so the newest reply here is not the one being written. */
  readonly sending?: boolean
  readonly placement: ActivityPlacement; readonly context: ActivityContext; readonly streamText?: boolean
  /** The thread these messages belong to, which is how a submitted attachment finds its preview. */
  readonly threadId?: string
  /** Who the replies are from when it is not the provider: Watcher's own conversation. */
  readonly speaker?: 'watcher' | undefined
  /** Delegated work by the user's message each answers; under '' those whose message is not shown (ADR-0081). */
  readonly delegations?: ReadonlyMap<string, readonly DelegationView[]> | undefined
  /** The provider's own agents still running in the background, which the newest turn shows under its reply once it has finished. */
  readonly backgroundWork?: readonly AgentBackgroundWork[] | undefined
  /** In a delegated thread, the briefs that are the delegating thread's words rather than the user's. */
  readonly briefs?: DelegatedBriefs | undefined
  /** Links to the threads that continue this one, by the user message that began the turn each follows (ADR-0089). */
  readonly continuedIn?: ReadonlyMap<string, readonly ThreadContinuedIn[]> | undefined
}): ReactNode {
  // Turns are re-split on every arrival but hold the same messages; sharing their structure lets the
  // memoised turns below compare equal.
  const turns = useShared(useMemo(() => splitTurns(messages, placement.unshown), [messages, placement.unshown]))
  // The newest turn drawn is the one being worked on while the thread runs, except in Watcher's conversation when that turn
  // ended and another turn's lifecycle runs: Watcher is then working on news, whose wake-up the conversation leaves out
  // (`watcherWakeUpsAsShown`), so the news turn has nothing drawn until its first reply. Drawn as the running turn, the
  // finished one would open while the news turn runs and fold again when it ends (#1452). Without that evidence on both
  // sides, the newest turn is the running one, as in every other thread.
  const live = running && !(speaker === 'watcher' && placement.newestTurnEnded === true)
  // The provider's agents stand under the reply beside delegated work, so they keep to delegation's Owl switch.
  const agents = useOwlFeature('thread-delegation') && !live ? backgroundWork : undefined
  // Only the newest turn's reply is being written: a turn that has drawn nothing yet, such as one opened by an empty reply,
  // leaves the reply above it finished. A visual after the reply means the reply is no longer being written.
  const newest = turns.at(-1)
  const last = newest === undefined ? undefined : [...newest.user ? [newest.user] : [], ...newest.replies].findLast(drawn)
  const writing = live && !sending && last?.role === 'assistant' && !isVisualMessage(last) && !placement.after.get(last.id)?.length ? last.id : undefined
  // A Watcher news turn that wrote no reply shows nothing once it has finished (variant b); one that failed or stopped still says so.
  const unshown = (groups: readonly ActivityGroup[] | undefined): readonly ActivityGroup[] | undefined => speaker === 'watcher' ? withoutFinishedNews(groups, context.liveTurn) : groups
  return <><ActivityGroups groups={unshown(placement.leading)} context={context} />
  {turns.map((turn, index) => <React.Fragment key={turn.key}>
    <ActivityGroups groups={unshown(placement.before.get((turn.user ?? turn.replies[0])!.id))} context={context} />
    <TurnView turn={turn} provider={provider} running={live}
      last={index === turns.length - 1} writing={writing} placement={placement} context={context} streamText={streamText} threadId={threadId} speaker={speaker}
      delegations={turn.user ? delegations?.get(turn.user.id) : undefined} backgroundWork={index === turns.length - 1 ? agents : undefined} briefs={briefs} continuedIn={turn.user ? continuedIn?.get(turn.user.id) : undefined} />
  </React.Fragment>)}
  <ActivityGroups groups={unshown(placement.trailing)} context={context} />
  <DelegatedWork views={delegations?.get('')} />
  </>
})

const UNCONFIRMED_SET_ASIDE = msg`Sotto could not confirm that the prompt was set aside. Your next message is kept. Check again before continuing.`

/**
 * A message the user sent from this window, drawn where it will sit in the conversation from the press
 * onwards. It says how the delivery went and offers the prompt back when it was refused. A prompt bound for
 * the queue is not drawn here: the queue above the composer holds it, with its controls, until it is sent.
 */

function PendingMessage({ draftId, submission, status, row, state, command, store }: {
  readonly draftId: string; readonly submission?: Submission; readonly status: SubmissionStatus; readonly row: ThreadRow
  readonly state: AgentState; readonly command: Command; readonly store: ThreadDraftStore
}): ReactNode {
  const { t } = useLingui()
  const { draft } = useThreadComposer(store, row.thread.id)
  const watchActions = useWatchActions()
  const [settingAside, setSettingAside] = useState(false)
  const [recoveryError, setRecoveryError] = useState<LaterWords | null>(null)
  const restored = submission?.restoredAs !== undefined && draft.draftId === submission.restoredAs
  const provider = state.host.providers && row.providerId ? { provider: row.providerId } : {}
  // The provider's history can show the exact message before Sotto has its confirmation.
  // Repeating the text would read as a second send, so only the delivery state stays here.
  const receipt = deliveryFor(state, row.thread.id, draftId)
  const setAside = receipt?.setAside === true && status !== 'accepted'
  const local = !row.thread.remoteHost
  const messageId = receipt?.messageId
  const inHistory = messageId !== undefined && row.thread.messages.some(message => message.id === messageId)
  if (submission !== undefined && inHistory && (status === 'queued' || status === 'submitting')) return null
  const label = <span className="thread-message__status" role="status" data-status={status}><i aria-hidden="true" />{setAside ? t`Set aside · Unconfirmed` : t(STATUS_LABELS[status])}</span>
  const unresolved = !setAside && (status === 'uncertain' || submission === undefined && deliveryPending(status))
  const continueWithNewMessage = async (button: HTMLButtonElement): Promise<void> => {
    if (settingAside) return
    const composer = button.closest('.thread-workspace')?.querySelector<HTMLElement>('[role="textbox"]')
    setSettingAside(true); setRecoveryError(null)
    try {
      const result = await command({ type: 'set-aside-send', threadId: row.thread.id, draftId })
      const delivery = result && deliveryFor(result, row.thread.id, draftId)
      if (!delivery?.setAside && delivery?.status !== 'accepted') {
        setRecoveryError(result?.error ?? UNCONFIRMED_SET_ASIDE)
      } else composer?.focus()
    } catch {
      setRecoveryError(UNCONFIRMED_SET_ASIDE)
    } finally { setSettingAside(false) }
  }
  // Only the header's Reconnect acts on a disconnected provider; Check again needs a connection.
  const refusal = submission?.error ?? t`The provider did not take this prompt.`
  const lastPrompt = submission === undefined && !inHistory
  const detail = setAside ? t`Its delivery is still unknown. Sotto has not sent it again.`
    : status === 'failed' ? submission === undefined ? refusal
      : restored ? t({ message: `${refusal} It is back in the composer.`, comment: '{refusal} is why the prompt was not sent.' })
        : hasDraftContent(draft) ? t({ message: `${refusal} Restoring it replaces the draft in the composer.`, comment: '{refusal} is why the prompt was not sent.' }) : refusal
      : unresolved ? row.connected
        ? lastPrompt ? t`Sotto will not send your last prompt twice.` : t`Sotto will not send it twice.`
        : lastPrompt ? t`Sotto will not send your last prompt twice. Reconnect to check it.` : t`Sotto will not send it twice. Reconnect to check it.`
        : null
  // Before the send receipt supplies its refusal, the pane announces the shell's error.
  const announcesFailure = status === 'failed' && (state.error === null || submission?.error != null)
  const delivery = detail === null ? null : <div className="thread-message__delivery">
    <span role={announcesFailure ? 'alert' : undefined}>{detail}</span>
    <div className="thread-message__delivery-actions">
      {status === 'failed' && submission !== undefined ? <Button variant="secondary" disabled={!row.connected || isThreadBusy(state, row.thread.id)}
        onClick={() => void sendThreadRevision(store, row, command, performance.now(), submission.mode, draftId)
          // A first send retried still carries the Watch pressed on its composer.
          .then(sent => watchAfterSend(row.thread.id, sent, submission.mode, row.thread.nativeSessionStarted === false, watchActions))}>{t`Retry`}</Button> : null}
      {status === 'failed' && submission !== undefined && !restored ? <Button variant="secondary" onClick={() => store.restore(row.thread.id, draftId)}>{t`Restore prompt`}</Button> : null}
      {/* Checking again refreshes the provider, which is global-lane work. */}
      {unresolved && row.connected ? <Button variant="secondary" disabled={state.globalLaneBusy || settingAside} onClick={() => void command({ type: 'refresh', ...provider })}>{t`Check again`}</Button> : null}
      {status === 'uncertain' && !setAside && local && row.connected ? <Button variant="secondary" disabled={settingAside || isThreadBusy(state, row.thread.id)}
        aria-busy={settingAside || undefined} onClick={event => void continueWithNewMessage(event.currentTarget)}>{t`Continue with a new message`}</Button> : null}
      {status === 'failed' ? <Button variant="ghost" onClick={() => store.dismiss(row.thread.id, draftId)}>{t`Dismiss`}</Button> : null}
    </div>
    {status === 'uncertain' && !setAside && local ? <span>{t`The provider may have received it. Continuing sets it aside without resending it.`}</span> : null}
    {recoveryError && !setAside && status !== 'accepted' ? <span role="alert">{shownWords(recoveryError)}</span> : null}
  </div>
  // With no prompt text to show (already in the history, or recovered after a restart),
  // the state is a compact line under the conversation rather than an empty second bubble.
  if (inHistory || submission === undefined) {
    return <div className="thread-delivery" role="group" aria-label={t`Pending message`} data-status={status} data-in-history={inHistory || undefined}>{label}{delivery}</div>
  }
  return <article className="thread-message thread-message--pending" data-role="user" data-status={status} aria-label={t`Pending message`}>
    <header><span className="thread-message__who">{t({ message: 'You', comment: 'Who wrote a message: the user.' })}</span>{label}</header>
    <MessageContent text={submission.text} /><AttachmentPreviews attachments={submission.attachments} />
    {delivery}
  </article>
}

/** The floating Jump to latest button's band at the bottom of the transcript: its offset, height and a little air. */
const JUMP_BAND_PX = 60

/** Whether a request card reaches the button's band, which rides above a floating composer by the composer's height. */
export function reachesJumpBand(scroller: HTMLElement): boolean {
  const view = scroller.getBoundingClientRect()
  // The transcript's scroll padding is the floating composer's height, and nothing while the composer stacks. A slim
  // composer (ADR-0125) keeps that padding, and the button rides above what shows of it instead.
  const pane = scroller.closest<HTMLElement>('.thread-pane')
  const shown = pane?.hasAttribute('data-slim') ? parseFloat(getComputedStyle(pane).getPropertyValue('--thread-compose-shown')) : Number.NaN
  const bottom = view.bottom - (Number.isFinite(shown) ? shown : parseFloat(getComputedStyle(scroller).scrollPaddingBottom) || 0)
  return [...scroller.querySelectorAll('.agent-request')].some(card => {
    const box = card.getBoundingClientRect()
    return box.bottom > bottom - JUMP_BAND_PX && box.top < bottom
  })
}

/**
 * The selected thread's history. It follows new content only while the reader is at the end;
 * reading older messages keeps its place and offers Jump to latest. Showing earlier messages keeps
 * the message under the reader where it was.
 */
export function ThreadTranscript({ row, state, command, store, followSignal, children, watcher = false, greetingSlot, emptyNote, onReadingBack, onTypeAhead, onQuoted }: {
  readonly row: ThreadRow
  /** Where a new thread's greeting goes, directly above the composer. Without one, the thread keeps the plain empty line. */
  readonly greetingSlot?: HTMLElement | null
  /** Watcher's own conversation: its replies are Watcher's. */
  readonly watcher?: boolean
  /** What an empty conversation at rest says in place of the plain empty line, as a new Watcher's does (New Watcher). */
  readonly emptyNote?: ReactNode
  readonly state: AgentState
  readonly command: Command
  readonly store: ThreadDraftStore
  /** Changes when the user sends from this window: the transcript returns to the newest message. */
  readonly followSignal: number
  /** The inline request, rendered after the newest message. */
  readonly children?: ReactNode
  /**
   * Told when the reader goes more than READING_BACK_PX above the end, or comes back, for the slim composer (ADR-0125).
   * Only a crossing is told, never a scroll, and leaving says the reader is back.
   */
  readonly onReadingBack?: ((reading: boolean) => void) | undefined
  /** A printable key pressed in the transcript: the pane puts focus in the composer, which takes the key. */
  readonly onTypeAhead?: (() => void) | undefined
  /** Words from a reply went onto the composer as a quote (ADR-0129): the pane puts focus in the composer. */
  readonly onQuoted?: (() => void) | undefined
}): ReactNode {
  const { t } = useLingui()
  const thread = row.thread
  const quoting = useOwlFeature('reply-quote')
  const streamText = useAgents().responseStreaming !== 'complete'
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  /** Where the scroll stood when last heard or set to the end, so a reader moving up from the end is told apart from the end moving away. */
  const lastTop = useRef(0)
  const anchor = useRef<{ readonly height: number; readonly top: number } | null>(null)
  const followed = useRef(followSignal)
  const seen = useRef<string | undefined>(undefined)
  const firstRendered = useRef<{ readonly threadId: string; readonly messageId: string } | null>(null)
  const [limit, setLimit] = useState(TRANSCRIPT_PAGE)
  const [away, setAway] = useState(false)
  const [unseen, setUnseen] = useState(false)
  const [requestUnderJump, setRequestUnderJump] = useState(false)
  // Whether the reader is far enough above the end for the composer to slim, kept off React's state: the pane hears of a
  // crossing and nothing here draws again for it.
  const readingBack = useRef(false)
  const onReadingBackRef = useRef(onReadingBack)
  onReadingBackRef.current = onReadingBack
  const noteReading = useCallback((element: HTMLElement): void => {
    const reading = readsBack(element)
    if (reading === readingBack.current) return
    readingBack.current = reading
    onReadingBackRef.current?.(reading)
  }, [])
  useEffect(() => () => { if (readingBack.current) { readingBack.current = false; onReadingBackRef.current?.(false) } }, [])
  // A press on the scrubber that needs an earlier page drawn first: where it goes, and whether focus goes with it.
  const landing = useRef<{ readonly messageId: string; readonly focus: boolean } | null>(null)
  const [landingSeq, setLandingSeq] = useState(0)
  /** A press on a prompt only the thread's store holds, waiting for the window to widen back to it. */
  const far = useRef<{ readonly threadId: string; readonly messageId: string; readonly focus: boolean } | null>(null)
  const submissions = useSubmissions(store)
  const pending = submissions.filter(item => item.threadId === thread.id)
    .map(item => ({ item, ...submissionStatus(item, state) })).filter(item => item.visible)
  // Durable metadata survives a renderer restart; it carries no prompt content.
  // Recover it independently of the current draft and without inventing a message.
  const recovery = (state.deliveries ?? []).filter(item => item.threadId === thread.id && deliveryPending(item.status)
    // Queue-owned revisions have one status in the queue until native history contains the message.
    && !queuedRevision(state, thread.id, item.draftId) && !submissions.some(local => local.threadId === thread.id && local.draftId === item.draftId && local.mode === 'queue')
    && !pending.some(local => local.item.draftId === item.draftId)
    && !state.deliveredDrafts?.some(receipt => receipt.threadId === thread.id && receipt.draftId === item.draftId))
  // What the queue holds, and a send on its way into it, is told by the queue above the composer alone. It joins the
  // conversation when the provider's own history carries it, so a queued message is never drawn twice.
  const queueHolds = followupsFor(state, thread.id).length > 0 || pending.some(item => item.item.mode === 'queue')
  // Sending starts the working line on the press; the provider's own running turn takes it over when it arrives.
  const sendingSince = pending.find(item => item.item.mode !== 'queue' && (item.status === 'queued' || item.status === 'submitting'))?.item.startedAt
  // A direct send belongs to the turn starting now.
  const sending = pending.filter(item => item.item.mode !== 'queue')
  const sameThread = firstRendered.current?.threadId === thread.id
  const retainedStart = sameThread ? thread.messages.findIndex(message => message.id === firstRendered.current?.messageId) : -1
  // While reading earlier history, retain the first rendered message. A sliding
  // last-N slice would otherwise remove a row above the reader on every arrival.
  const start = !following.current && retainedStart >= 0 ? retainedStart : Math.max(0, thread.messages.length - (sameThread ? limit : TRANSCRIPT_PAGE))
  const messages = useMemo(() => thread.messages.slice(start), [thread.messages, start])
  const hidden = thread.messages.length - messages.length
  const lastMessageId = thread.messages.at(-1)?.id
  // Placement is rebuilt whenever a message arrives, but the groups it holds are mostly the ones already on
  // screen; sharing their structure keeps the memoised activity views from redrawing the whole history.
  const placement = useShared(useMemo(() => placeActivities(thread.messages, messages, thread.activities, thread.historyStatus === 'loading', thread.earlierAvailable === true),
    [thread.messages, messages, thread.activities, thread.historyStatus, thread.earlierAvailable]))
  const liveTurn = liveTurnId(thread)
  // Delegation (ADR-0081; Owl only): this thread's own delegations, read once as its pane opens and again when main
  // names it. What it delegated are rows of delegated work in the turn each call was made in; the briefs it was sent are the words of
  // the thread that delegated to it, not the user's.
  const delegationsOn = useDelegationsEnabled()
  const delegations = useDelegations(delegationsOn && !watcher ? thread.id : undefined)
  const delegatedWork = useShared(useMemo(() => delegationsByTurn(delegations.made, messages), [delegations.made, messages]))
  const delegationWorld = useDelegationWorld(state, command, undefined, { thread, lastReadAt: delegations.lastReadAt })
  // The provider's own agents still running in the background, which stand under the last reply when the composer's
  // ornament may show them too. A command waits rather than works, so it stays the ornament's alone.
  const ornamentAllowed = threadOrnamentAllowed(thread, row.connected)
  const backgroundAgents = useShared(useMemo(() => stillWorkingAgents(thread.backgroundWork, ornamentAllowed), [ornamentAllowed, thread.backgroundWork]))
  const delegatingTitle = thread.delegatedBy === undefined ? undefined : state.host.threads.find(item => item.id === thread.delegatedBy)?.title ?? t`The thread that delegated`
  const briefs = useMemo<DelegatedBriefs | undefined>(() => {
    const ids = new Set(delegations.received.map(view => view.briefMessageId))
    return ids.size && delegatingTitle !== undefined ? { ids, from: delegatingTitle } : undefined
  }, [delegations.received, delegatingTitle])
  // The message scrubber (ADR-0109; Owl only): a tick for each message the user sent, in the window or only in the
  // thread's store above it.
  const scrubberOn = useOwlFeature('message-scrubber')
  const windowMarks = useMemo(() => scrubberOn ? scrubberMarks(thread.messages, briefs?.ids) : [], [scrubberOn, thread.messages, briefs])
  const windowIds = useMemo(() => windowMarks.map(mark => mark.messageId), [windowMarks])
  const stored = useStoredPrompts(thread.id, thread.messages[0]?.id, windowIds, thread.earlierAvailable === true, thread.historyEpoch, thread.summary?.messageCount, scrubberOn)
  const slidMarks = useSlidMarks(`${thread.id}\n${thread.historyEpoch ?? ''}`, windowMarks)
  const aboveMarks = useMemo(() => aboveWindow(storedMarks(stored.prompts, briefs?.ids), slidMarks), [stored.prompts, briefs, slidMarks])
  const joined = useMemo(() => joinedMarks(aboveMarks, windowMarks), [aboveMarks, windowMarks])
  // While the thread's messages load again, as they do when the pane comes back to it, and while the store is read again
  // for a window that moved, the ticks it had stand.
  const lastMarks = useRef<{ readonly threadId: string; readonly marks: readonly ScrubberMark[] } | null>(null)
  const marksHeld = (thread.historyStatus === 'loading' || stored.reading) && lastMarks.current?.threadId === thread.id && lastMarks.current.marks.length > joined.length
  const marks = marksHeld ? lastMarks.current!.marks : joined
  if (!marksHeld) lastMarks.current = { threadId: thread.id, marks: joined }
  // A thread that began from another (#1028; Owl only) says where it began, and shows the handover it starts from.
  // Its view changes only when where it began does, so the messages that read it are not redrawn on every update.
  const startsOn = useThreadStarts()
  const startKey = startsOn && !watcher && thread.startedFrom ? JSON.stringify(thread.startedFrom) : undefined
  const startSource = startKey === undefined ? undefined : state.host.threads.find(item => item.id === thread.startedFrom!.threadId)
  const sourceTitle = startSource?.title, sourceProvider = startSource?.providerId
  const startView = useMemo(() => startKey === undefined ? null : threadStartView({ id: thread.id, startedFrom: JSON.parse(startKey) as NonNullable<typeof thread.startedFrom>, providerId: thread.providerId },
    sourceTitle === undefined ? undefined : { title: sourceTitle, providerId: sourceProvider }, command, window.sotto?.agents?.startHandover),
  [startKey, thread.id, thread.providerId, sourceTitle, sourceProvider, command])
  const startHandoverWaiting = startView?.start.route === 'handover' && startView.start.handover !== undefined && startView.start.handover.sent === undefined
  // A fork's note goes under the last reply it copied, where its own conversation begins, or at the head while that
  // reply is not among the messages shown.
  const startNoteAtHead = startView !== null && (startView.start.from === 'agent' || !messages.some(message => message.id === startView.start.messageId))
  // Fork from here (#1028, E5b; Owl only): one reply's card open at a time, and what follows it marked as not carried.
  // While none is open the options keep their identity, so a streaming update redraws no reply for them.
  const [forkAt, setForkAt] = useState<string | null>(null)
  useEffect(() => { setForkAt(null) }, [thread.id])
  const forkMessages = forkAt === null ? null : messages
  const forkAfter = useMemo<ReadonlySet<string>>(() => {
    const index = forkAt === null || forkMessages === null ? -1 : forkMessages.findIndex(message => message.id === forkAt)
    return index < 0 ? NOTHING_AFTER : new Set(forkMessages!.slice(index + 1).map(message => message.id))
  }, [forkAt, forkMessages])
  const forkModels = startsOn && !watcher ? hostForThread(state.host, thread).models : undefined
  const forkRepository = thread.worktree?.git?.isRepository === true, forkBranch = thread.worktree?.git?.branch ?? null
  const forkBusy = thread.status === 'running'
  const forkOptions = useMemo<ForkOptions | null>(() => forkModels === undefined || thread.providerId === undefined || thread.kind === 'watcher' || thread.kind === 'watcher-history' ? null : {
    threadId: thread.id, threadTitle: thread.title, provider: thread.providerId, projectId: thread.projectId, remote: thread.remoteHost === true,
    where: thread.remoteHost ? thread.hostLabel ?? t`The host` : t`This computer`, models: forkModels, modelId: thread.modelId, command,
    ...(forkRepository ? { sourceBranch: { currentBranch: forkBranch } } : {}),
    workingCopyOptions: thread.remoteHost ? undefined : window.sotto?.agents?.workingCopyOptions,
    openAt: forkAt, open: setForkAt, after: forkAfter, busy: forkBusy },
  [forkModels, thread.id, thread.title, thread.providerId, thread.projectId, thread.remoteHost, thread.hostLabel, thread.modelId, thread.kind, command, forkRepository, forkBranch, forkAt, forkAfter, forkBusy, t])
  // Continuing on another provider (ADR-0089; Owl only): where this thread came from, where it went, and its handover's source.
  const continueOn = useContinueEnabled() && !watcher
  const continuedIn = useShared(useMemo(() => continueOn ? continuedInByTurn(thread.continuedIn, messages) : undefined, [continueOn, thread.continuedIn, messages]))
  const threads = state.host.threads
  const continueLinks = useMemo<ContinueLinks>(() => ({ threads, open: threadId => { void command({ type: 'select-thread', threadId }) } }), [threads, command])
  const handoverSource = continueOn && thread.continuedFrom ? threads.find(item => item.id === thread.continuedFrom!.threadId)?.title ?? t`a thread that is no longer listed` : undefined
  const handoverFrom = useMemo(() => handoverSource === undefined ? null : { title: handoverSource }, [handoverSource])
  const pendingKey = [...sending.map(item => `${item.item.draftId}:${item.status}`),
    ...recovery.map(item => `${item.draftId}:${item.status}`)].join(',')

  // A reader who is not following the end stays where they are reading, whatever an update folds, opens or resizes above
  // them (#1452). The window's own scroll anchoring holds an element only while it lives, and a turn that changes between
  // its running and finished layouts draws its messages again as new elements, so the transcript holds the place itself, by
  // message. The place is read when the reader scrolls and again after each update has put it back; an update that leaves
  // the transcript too short to put it back holds it for the next. Show earlier, Load earlier and the scrubber's landing put
  // the reader somewhere on purpose, and a scroll the transcript did not make is where the reader now is.
  const reading = useRef<ReadingPlace | null>(null)
  const [rows] = useState(() => new MessageRows())
  useLayoutEffect(() => {
    const element = scroller.current
    const place = reading.current
    if (element === null || place === null) return
    if (place.threadId !== thread.id || following.current) { reading.current = null; return }
    if (anchor.current !== null || landing.current !== null) return
    // Scrolled since the place was read or put back, by the reader before their scroll was heard or by the window's own
    // anchoring: that is where they read now, held or not.
    reading.current = scrolledSince(element, place) ? readingPlace(element, rows, thread.id) : keepReadingPlace(element, rows, place)
  })

  useLayoutEffect(() => {
    firstRendered.current = messages[0] ? { threadId: thread.id, messageId: messages[0].id } : null
  }, [messages, thread.id])

  const toEnd = useCallback((): void => {
    const element = scroller.current
    if (element === null) return
    // Jump to latest, a send or another thread is somewhere else to be, so a pressed prompt still loading is not.
    far.current = null
    element.scrollTop = element.scrollHeight
    lastTop.current = element.scrollTop
    following.current = true
    setAway(false)
    setUnseen(false)
    noteReading(element)
  }, [noteReading])

  // A different thread opens at its newest message with a fresh page.
  useLayoutEffect(() => {
    anchor.current = null
    seen.current = undefined
    landing.current = null
    setLimit(TRANSCRIPT_PAGE)
    toEnd()
  }, [thread.id, toEnd])

  useLayoutEffect(() => {
    const element = scroller.current
    if (element === null) return
    if (anchor.current !== null) {
      element.scrollTop = anchor.current.top + (element.scrollHeight - anchor.current.height)
      anchor.current = null
      return
    }
    // A send from the end follows it there; a send from above the end leaves the reader where they are, and what it adds
    // lights Jump to latest like any other arrival.
    if (followed.current !== followSignal) { followed.current = followSignal; if (following.current) { toEnd(); return } }
    const arrived = seen.current !== lastMessageId
    seen.current = lastMessageId
    if (following.current) { element.scrollTop = element.scrollHeight; lastTop.current = element.scrollTop }
    else if (arrived) setUnseen(true)
  }, [lastMessageId, pendingKey, hidden, followSignal, thread.historyStatus, toEnd])

  // Late layout (wrapped text, images, rich blocks) keeps a following reader at the end.
  useEffect(() => {
    const element = content.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (following.current && anchor.current === null && scroller.current) { scroller.current.scrollTop = scroller.current.scrollHeight; lastTop.current = scroller.current.scrollTop }
      if (scroller.current) { setRequestUnderJump(reachesJumpBand(scroller.current)); noteReading(scroller.current) }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [noteReading])

  const onScroll = (): void => {
    const element = scroller.current
    if (element === null) return
    // The window's own scroll after an update cut the transcript short, at the end it was cut to: the place stays held for
    // the update that brings the room back, and a reader who did not scroll is not following the end they were pulled to.
    const held = reading.current
    if (held?.held === true && held.threadId === thread.id && Math.abs(element.scrollTop - held.top) < 1) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    // Any move up that is not the end being cut short lets go of the end, however near it: a reply being written grows the
    // end faster than a reader scrolls out of the slack, and following would pull them back down with every word.
    const movedUp = element.scrollTop < lastTop.current - 1 && distance > 1
    lastTop.current = element.scrollTop
    following.current = !movedUp && distance <= FOLLOW_SLACK_PX
    const isAway = distance > Math.max(FOLLOW_SLACK_PX, element.clientHeight / 2)
    if (isAway !== away) setAway(isAway)
    if (following.current && unseen) setUnseen(false)
    setRequestUnderJump(reachesJumpBand(element))
    // The reader's own scroll, or the window's anchoring, says where they read now; the transcript's own does not.
    const place = reading.current
    if (following.current) reading.current = null
    else if (place === null || place.threadId !== thread.id || Math.abs(element.scrollTop - place.top) >= 1) reading.current = readingPlace(element, rows, thread.id)
    noteReading(element)
  }
  /** The reader's own wheel, touch, press or scrolling key takes the scroll back from a held place, even where it cannot move. */
  const onReaderInput = (event: React.SyntheticEvent): void => {
    // A reader who moves on while a pressed prompt loads is not taken there when it arrives.
    if (far.current !== null && (event.type !== 'keydown' || scrollsTranscript(event as React.KeyboardEvent))) far.current = null
    if (reading.current?.held !== true || event.type === 'keydown' && !scrollsTranscript(event as React.KeyboardEvent)) return
    reading.current = null
    onScroll()
  }
  // A key pressed in the transcript is the reader scrolling, a printable key the start of a message the composer takes
  // (ADR-0125), or neither. The two never share a key: Space scrolls and is never typing, and no printable key scrolls.
  const onTranscriptKey = (event: React.KeyboardEvent): void => {
    onReaderInput(event)
    if (onTypeAhead !== undefined && typesIntoComposer(event.nativeEvent)) onTypeAhead()
  }

  // Opening or closing activity keeps the control under the pointer: the end-follow would otherwise pull it away.
  const onDisclosure = useCallback((control: HTMLElement): void => {
    const element = scroller.current
    if (element === null) return
    const before = control.getBoundingClientRect().top
    following.current = false
    requestAnimationFrame(() => {
      const current = scroller.current
      if (current === null || !control.isConnected) return
      current.scrollTop += control.getBoundingClientRect().top - before
      following.current = current.scrollHeight - current.scrollTop - current.clientHeight <= FOLLOW_SLACK_PX
    })
  }, [])
  // Show where it asked takes the reader up to an earlier reply, so the end-follow lets go before the fold grows.
  const onSeek = useCallback((message: HTMLElement): void => {
    following.current = false
    seekWithoutTranscript(message)
  }, [])
  /** Puts a drawn message at the top of the transcript and marks it. Messages laid out late around it can move it, so it
   * is put back for a few frames. */
  const land = useCallback((messageId: string, focus: boolean): void => {
    const element = scroller.current
    const message = [...content.current?.querySelectorAll<HTMLElement>('.thread-message[data-message-id]') ?? []].find(item => item.dataset.messageId === messageId)
    if (element === null || message === undefined) return
    following.current = false
    const place = (): void => { element.scrollTop += message.getBoundingClientRect().top - element.getBoundingClientRect().top - LANDING_GAP_PX }
    place()
    let frames = LANDING_FRAMES
    const again = (): void => { if (!message.isConnected || frames-- <= 0) return; place(); requestAnimationFrame(again) }
    requestAnimationFrame(again)
    markSought(message)
    if (focus) { message.tabIndex = -1; message.focus({ preventScroll: true }) }
  }, [])
  /**
   * The scrubber's press: a message above the first one drawn widens the window to it first, then lands there. One only
   * the thread's store holds has the window loaded back to it first; until it arrives the reader stays where they are.
   */
  const jumpTo = useCallback((messageId: string, focus: boolean): void => {
    const index = thread.messages.findIndex(message => message.id === messageId)
    if (index < 0) {
      far.current = { threadId: thread.id, messageId, focus }
      void command({ type: 'load-earlier-messages', threadId: thread.id, throughMessageId: messageId })
      return
    }
    far.current = null
    following.current = false
    if (index >= start) { land(messageId, focus); return }
    anchor.current = null
    firstRendered.current = { threadId: thread.id, messageId }
    landing.current = { messageId, focus }
    setLimit(current => Math.max(current, thread.messages.length - index))
    setLandingSeq(current => current + 1)
  }, [thread.messages, thread.id, start, land, command])
  // Once the wider window is drawn, the press lands where it asked to go.
  useLayoutEffect(() => {
    const target = landing.current
    if (target === null) return
    landing.current = null
    land(target.messageId, target.focus)
  }, [landingSeq, messages, land])
  // The window has widened back to a prompt pressed while only the store held it: the press lands now. It comes
  // after the landing above, which would otherwise take the press before the wider window is drawn.
  useLayoutEffect(() => {
    const target = far.current
    if (target === null) return
    if (target.threadId !== thread.id) { far.current = null; return }
    if (thread.messages.some(message => message.id === target.messageId)) jumpTo(target.messageId, target.focus)
  }, [thread.messages, thread.id, jumpTo])
  const ownServerTurns = useOwnServerTurns(row, state, command, store)
  const activity = useMemo<ActivityContext>(() => ({ liveTurn, running: thread.status === 'running', connected: row.connected, provider: row.provider, onDisclosure, onSeek }),
    [liveTurn, thread.status, row.connected, row.provider, onDisclosure, onSeek])
  // A remote thread's rows read a body its host kept back from that host, by the name the window shows (ADR-0025, October
  // 18 amendment). This computer's threads have no such body, and their rows are given nothing.
  const bodyHostName = thread.remoteHost === true ? threadHostName(state, thread) : undefined
  const bodyHostConnected = thread.remoteHost === true && (state.connections?.find(item => item.hostId === thread.hostId)?.connected ?? thread.clientConnected !== false)
  const bodyHost = useMemo<ActivityBodyHost | null>(() => bodyHostName === undefined ? null : { threadId: thread.id, hostName: bodyHostName, connected: bodyHostConnected },
    [thread.id, bodyHostName, bodyHostConnected])
  const showsActivity = placement.trailing.length > 0 || liveTurn !== null

  const showEarlier = (): void => {
    const element = scroller.current
    if (element !== null) anchor.current = { height: element.scrollHeight, top: element.scrollTop }
    following.current = false
    const first = thread.messages[Math.max(0, start - TRANSCRIPT_PAGE)]
    firstRendered.current = first ? { threadId: thread.id, messageId: first.id } : null
    setLimit(current => current + TRANSCRIPT_PAGE)
  }

  /** Widens the history window from the store. What arrives goes above the reader, so the scroll anchor is
   * kept and the retained first row is let go: the rows that arrive are the ones the press asked to see. */
  const loadEarlier = (): void => {
    const element = scroller.current
    if (element !== null) anchor.current = { height: element.scrollHeight, top: element.scrollTop }
    following.current = false
    firstRendered.current = null
    void command({ type: 'load-earlier-messages', threadId: thread.id })
  }

  const empty = !thread.messages.length && !sending.length && !recovery.length && !showsActivity
  // A thread nothing has been sent to greets above its composer instead. Watcher's own conversation, a working,
  // failed, compacting, settled or archived thread, one with a request or older history to show, and one whose summary
  // counts messages not drawn yet keep the line in the transcript.
  const greets = empty && !queueHolds && greetingSlot !== undefined && !watcher && startView === null && thread.historyStatus !== 'loading' && thread.historyStatus !== 'error'
    && thread.status === 'idle' && !isThreadClosed(thread) && (thread.summary?.messageCount ?? 0) === 0
    && thread.compaction?.status !== 'running' && thread.requests.length === 0 && !thread.earlierAvailable
  useMark('greeting', greets && greetingSlot != null)
  return <div className="thread-transcript">
    {marks.length >= SCRUBBER_FEWEST ? <MessageScrubber marks={marks} scroller={scroller} content={content} moreAbove={hidden > 0 || thread.earlierAvailable === true || marksHeld}
      who={watcher ? 'Watcher' : row.provider} running={thread.status === 'running'} requests={thread.requests} onJump={jumpTo} onReaderWheel={onReaderInput} /> : null}
    <div className="thread-workspace__transcript" ref={scroller} onScroll={onScroll} onWheel={onReaderInput} onTouchStart={onReaderInput}
      onPointerDown={onReaderInput} onKeyDown={onTranscriptKey} tabIndex={0} role="log" aria-live="off"
      aria-label={t`Thread transcript`} aria-busy={thread.historyStatus === 'loading'}>
      <div className="thread-transcript__content" ref={content}><OwnServerTurnContext.Provider value={ownServerTurns}>
        {thread.historyStatus === 'loading' && <div className="thread-history-status" role="status">{t`Loading messages…`}</div>}
        {thread.historyStatus === 'error' && <div className="thread-history-status" role="alert"><span>{thread.historyError || t`Could not load this thread’s messages.`}</span><Button variant="ghost" disabled={state.globalLaneBusy || !row.connected} onClick={() => void command({ type: 'refresh' })}>{t`Retry loading messages`}</Button></div>}
        {hidden > 0
          ? <div className="thread-transcript__earlier"><Button variant="ghost" onClick={showEarlier}><Trans>Show earlier messages ({ph({ hidden: shownCount(hidden) })})</Trans></Button></div>
          /* Everything the window holds is on screen, and the thread store still has older messages. */
          : thread.earlierAvailable
            ? <div className="thread-transcript__earlier"><Button variant="ghost" onClick={loadEarlier}>{t`Show earlier messages`}</Button></div>
            : null}
        {/* Where this thread continues from, above its first message (ADR-0089; Owl only). */}
        {hidden === 0 && !thread.earlierAvailable ? <ContinuedFromNote thread={thread} state={state} command={command} /> : null}
        {startView && startNoteAtHead ? <ThreadStartNote view={startView} /> : null}
        {startView && startHandoverWaiting ? <StartHandoverCard key={thread.id} view={startView} createdAt={startView.start.at} /> : null}
        {thread.messages.length || showsActivity ? <ActivityBodyContext.Provider value={bodyHost}><ThreadStartContext.Provider value={startView ?? (thread.startedFrom && !watcher ? 'off' : null)}><ForkContext.Provider value={forkOptions}><DelegationWorldProvider world={delegationWorld}><ContinueLinksContext.Provider value={continueLinks}><HandoverFromContext.Provider value={handoverFrom}>
          <MessageRowsContext.Provider value={rows}><MessageList messages={messages} provider={row.provider} running={thread.status === 'running'} sending={sending.some(item => item.status === 'queued' || item.status === 'submitting' || item.status === 'accepted')} placement={placement} context={activity} streamText={streamText} threadId={thread.id} speaker={watcher ? 'watcher' : undefined}
          delegations={delegatedWork.size ? delegatedWork : undefined} backgroundWork={backgroundAgents} briefs={briefs} continuedIn={continuedIn?.size ? continuedIn : undefined} /></MessageRowsContext.Provider>
        </HandoverFromContext.Provider></ContinueLinksContext.Provider></DelegationWorldProvider></ForkContext.Provider></ThreadStartContext.Provider></ActivityBodyContext.Provider>
          : thread.historyStatus === 'loading' ? <div className="thread-history-skeleton" aria-hidden="true"><i /><i /><i /></div>
            : thread.historyStatus === 'error' || !empty || greets || startView ? null
              : emptyNote != null && thread.status !== 'running' && thread.compaction?.status !== 'running' ? emptyNote
              : <div className="thread-workspace__empty"><MessageSquare size={26} strokeWidth={1.3} aria-hidden="true" /><h3>{thread.compaction?.status === 'running' ? t`Compacting the context.` : thread.status === 'running' ? t`The agent is working.` : t`What is next for this thread?`}</h3><p className="tt-paragraph">{thread.status === 'running' ? t`New messages will appear here.` : t`Write a prompt below to continue.`}</p></div>}
        {/* A prompt on its way sits where it will be read, and the working line under it counts from the press. */}
        {sending.map(({ item, status }) => <PendingMessage key={item.draftId} draftId={item.draftId} submission={item} status={status} row={row} state={state} command={command} store={store} />)}
        {/* Its opened steps read cut bodies whole from their host, as the rows above do. */}
        <ActivityBodyContext.Provider value={bodyHost}>
          <LiveActivity thread={thread} connected={row.connected} provider={row.provider} onDisclosure={onDisclosure} sendingSince={sendingSince} />
        </ActivityBodyContext.Provider>
        {recovery.map(item => <PendingMessage key={item.draftId} draftId={item.draftId} status={item.status} row={row} state={state} command={command} store={store} />)}
        {children}
      </OwnServerTurnContext.Provider></div>
    </div>
    {greets && greetingSlot ? createPortal(<ThreadGreeting row={row} state={state} />, greetingSlot) : null}
    {/* A request's choices and text are never covered: while a card reaches the button's band, the button steps aside. */}
    {/* Add to prompt over words selected in a reply (ADR-0129; Owl only). */}
    {quoting ? <ReplyQuoteButton threadId={thread.id} scroller={scroller} onAdded={onQuoted} /> : null}
    {(away || unseen) && !requestUnderJump ? <button type="button" className="thread-transcript__jump tt-focusable" data-unseen={unseen || undefined} onClick={toEnd}>
      <ArrowDown size={16} aria-hidden="true" />{unseen ? t`New messages` : t`Jump to latest`}
    </button> : null}
  </div>
}
