import React, { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, Check, ChevronRight, Copy, MessageSquare } from 'lucide-react'
import type { AgentActivity } from '../../../shared/agentActivity'
import { isThreadBusy, type AgentFollowup, type AgentMessage, type AgentState } from '../../../shared/agents'
import { Button } from '../components/Button'
import { useAgents, type AgentConnection } from './AgentContext'
import { sendThreadRevision } from './ThreadComposer'
import { followupsFor } from './ThreadFollowups'
import { deliveryFor, deliveryPending, hasDraftContent, queuedRevision, submissionStatus, useSubmissions, useThreadComposer, type Submission, type SubmissionStatus, type ThreadDraftStore } from './threadDraftStore'
import { clockLabel, type ThreadRow } from './threadFacts'
import { useShared } from './stateSharing'
import { MessageContent, AttachmentPreviews } from './MessageContent'
import { renderedPlainText, useTransientFlag, writeClipboard } from './richActions'
import { LinkMenu, type LinkMenuItem } from '../tools/webLinks'
import { ActivityGroupView, CompactionLine, LiveActivity, TurnChangedFiles } from './ThreadActivity'
import { compactionOf, liveTurnId, nestActivities, placeActivities, splitTurns, turnChanges, workHeadline, type ActivityGroup, type ActivityPlacement, type TranscriptTurn, type TurnChange } from './threadActivityView'

type Command = AgentConnection['command']

export const TRANSCRIPT_PAGE = 80
/** Within this many pixels of the end, the reader is following the conversation. */
const FOLLOW_SLACK_PX = 48

const STATUS_LABELS: Record<SubmissionStatus, string> = {
  queued: 'Queued', submitting: 'Sending', accepted: 'Sent', failed: 'Not sent', uncertain: 'Unconfirmed',
}

export interface ActivityContext {
  readonly liveTurn: string | null
  readonly running: boolean
  readonly connected: boolean
  readonly provider: string
  readonly onDisclosure: (element: HTMLElement) => void
}

function ActivityGroups({ groups, context, outcome }: {
  readonly groups: readonly ActivityGroup[] | undefined; readonly context: ActivityContext; readonly outcome?: AgentActivity['status'] | undefined
}): ReactNode {
  return groups?.map(group => {
    const compaction = compactionOf(group)
    return compaction
      ? <CompactionLine key={group.key} record={compaction} />
      : <ActivityGroupView key={group.key} group={group} live={group.turnId === context.liveTurn} threadRunning={context.running}
        connected={context.connected} provider={context.provider} onDisclosure={context.onDisclosure} outcome={outcome} />
  }) ?? null
}

/**
 * A finished turn's work, folded to one line above its final reply: the replies written on the way and every
 * activity group, in the order they happened. The turn's own error stays in view.
 */
function TurnWork({ headline, error, changes, onDisclosure, children }: {
  readonly headline: string; readonly error?: string | undefined; readonly changes: readonly TurnChange[]
  readonly onDisclosure: (element: HTMLElement) => void; readonly children: ReactNode
}): ReactNode {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  return <section className="thread-work" data-expanded={open || undefined} aria-label={headline}>
    <button type="button" className="thread-work__summary tt-focusable" aria-expanded={open} aria-controls={open ? bodyId : undefined}
      onClick={event => { onDisclosure(event.currentTarget); setOpen(value => !value) }}>
      <span className="thread-work__headline">{headline}</span>
      <ChevronRight className="thread-activity__chevron" size={14} aria-hidden="true" />
    </button>
    <TurnChangedFiles changes={changes} onDisclosure={onDisclosure} />
    {error ? <p className="thread-activity__error thread-activity__error--turn">{error}</p> : null}
    {open ? <div id={bodyId} className="thread-work__body">{children}</div> : null}
  </section>
}

/** Inside a folded turn the turn line already says how it ended, so its groups carry only their counts, and the boundaries it crossed are drawn outside the fold. */
const folded = (groups: readonly ActivityGroup[] | undefined): ActivityGroup[] =>
  (groups ?? []).filter(group => group.records.length > 0 && !compactionOf(group))
    .map(group => group.turn ? { key: group.key, turnId: group.turnId, anchorMessageId: group.anchorMessageId, records: group.records } : group)

/**
 * Rendered history, turn by turn. A finished turn shows the user's message and its final reply, with everything in
 * between folded under one "Worked for" line above the reply. The running turn shows its messages and activity as
 * they arrive. Memoized on the message array and placement so composer keystrokes and status ticks do not repaint it.
 *
 * An assistant message with no text yet (a provider call that so far holds only tool use) draws no header.
 * With `streamText` off, the reply being written is held back until something follows it: activity after it,
 * a later message, or the end of the turn. Activity itself always appears as it runs.
 */
const drawn = (message: AgentMessage): boolean => message.role === 'user' || message.text.length > 0 || Boolean(message.attachments?.length)

/**
 * The per-message copy control (#128): one quiet mark pinned to the message's top-right corner,
 * revealed while the message is hovered or holds focus. A press copies the message's source
 * Markdown; right-click, Shift+F10 or the ContextMenu key offers plain text instead.
 */
function MessageCopy({ message, article }: { readonly message: AgentMessage; readonly article: React.RefObject<HTMLElement | null> }): ReactNode {
  const [feedback, showFeedback] = useTransientFlag()
  const [menuAt, setMenuAt] = useState<{ readonly x: number; readonly y: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const reply = message.role === 'assistant'
  const name = reply ? 'Copy reply as Markdown' : 'Copy message as Markdown'
  const copied = feedback !== null && feedback !== 'Copy failed'
  const copy = (format: 'markdown' | 'plain'): void => {
    const rendered = article.current?.querySelector('.rich-message')
    const text = format === 'markdown' || !rendered ? message.text : renderedPlainText(rendered)
    void writeClipboard(text).then(
      () => showFeedback(format === 'markdown' ? `Copied ${reply ? 'reply' : 'message'} as Markdown` : 'Copied as plain text'),
      () => showFeedback('Copy failed'))
  }
  const openMenu = (point: { readonly x: number; readonly y: number } | null): void => {
    const rect = button.current?.getBoundingClientRect()
    setMenuAt(point ?? { x: rect?.left ?? 0, y: (rect?.bottom ?? 0) + 4 })
  }
  const menuItems: LinkMenuItem[] = [
    { id: 'markdown', label: 'Copy as Markdown', run: () => copy('markdown') },
    { id: 'plain', label: 'Copy as plain text', run: () => copy('plain') },
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
      {feedback ? <span className="thread-message__copy-label">{copied ? 'Copied' : feedback}</span> : null}
    </button>
    <span className="tt-visually-hidden" role="status" aria-live="polite">{feedback}</span>
    {menuAt ? <LinkMenu at={menuAt} label="Copy options" items={menuItems} returnFocus={button.current} onClose={() => setMenuAt(null)} /> : null}
  </>
}

/**
 * One message in the transcript. Memoised on the message itself: the state the window receives shares the
 * structure of the one before it, so a message the update did not touch is the same object and is not redrawn
 * while the agent streams into the message below it. `threadId` is how a submitted attachment finds its preview.
 */
const MessageArticle = memo(function MessageArticle({ message, provider, writing, streamText, threadId }: {
  readonly message: AgentMessage; readonly provider: string; readonly writing: boolean; readonly streamText: boolean
  readonly threadId: string | undefined
}): ReactNode {
  const article = useRef<HTMLElement>(null)
  return <article className="thread-message" data-role={message.role} ref={article}>
    <header><span className="thread-message__who">{message.role === 'user' ? 'You' : message.role === 'assistant' ? provider : 'System'}</span><time dateTime={message.createdAt}>{clockLabel(Date.parse(message.createdAt))}</time>
      {!writing && message.text.length > 0 && (message.role === 'user' || message.role === 'assistant') ? <MessageCopy message={message} article={article} /> : null}</header>
    {writing && !streamText
      ? <p className="thread-message__writing" role="status">Writing a reply…</p>
      : <MessageContent text={message.text} streaming={writing} />}
    <AttachmentPreviews attachments={message.attachments ?? []} origin={threadId === undefined ? undefined : { threadId, messageId: message.id }} />
  </article>
})

/**
 * One turn: the user's message, the work it caused and its reply. Memoised, so a chunk arriving in the turn
 * being written leaves every earlier turn in the transcript untouched. `last` is what the running turn needs
 * to know about its place; everything else it reads is shared across updates.
 */
const TurnView = memo(function TurnView({ turn, provider, running, last, writing, placement, context, streamText, threadId }: {
  readonly turn: TranscriptTurn; readonly provider: string; readonly running: boolean; readonly last: boolean
  readonly writing: string | undefined
  readonly placement: ActivityPlacement; readonly context: ActivityContext; readonly streamText: boolean
  readonly threadId: string | undefined
}): ReactNode {
  const article = (message: AgentMessage): ReactNode => drawn(message)
    && <MessageArticle message={message} provider={provider} writing={message.id === writing} streamText={streamText} threadId={threadId} />
  const plain = (message: AgentMessage): ReactNode => <React.Fragment key={message.id}>
    {article(message)}
    <ActivityGroups groups={placement.after.get(message.id)} context={context} />
  </React.Fragment>
  const everything = turn.user ? [turn.user, ...turn.replies] : [...turn.replies]
  // The running turn keeps its live layout, and a page that starts mid-turn has no start to fold from;
  // a finished turn folds under its last written reply.
  const final = !turn.user || running && last ? undefined : turn.replies.findLast(message => message.role === 'assistant' && drawn(message))
  const groups = everything.flatMap(message => placement.after.get(message.id) ?? [])
  // A compaction is where the conversation lost its history, so it stays in view instead of folding with the work.
  const boundaries = groups.filter(group => compactionOf(group))
  const work = final ? turn.replies.filter(message => message !== final && drawn(message)) : []
  // A turn whose only record is how it ended has nothing to fold; its group states the outcome itself.
  if (!final || (!work.length && !groups.some(group => group.records.length && !compactionOf(group)))) return <>{everything.map(plain)}</>
  const lifecycle = groups.find(group => group.turn)?.turn
  const moments = [...turn.replies.map(message => message.createdAt), ...groups.flatMap(group => group.records.map(record => record.completedAt ?? record.startedAt))]
  return <>
    {turn.user ? article(turn.user) : null}
    <TurnWork headline={workHeadline(lifecycle, context.running, turn.user?.createdAt, moments)} error={lifecycle?.error}
      changes={turnChanges(groups)} onDisclosure={context.onDisclosure}>
      {everything.filter(message => message !== final).map(message => <React.Fragment key={message.id}>
        {message === turn.user ? null : article(message)}
        <ActivityGroups groups={folded(placement.after.get(message.id))} context={context} outcome={lifecycle?.status} />
      </React.Fragment>)}
      <ActivityGroups groups={folded(placement.after.get(final.id))} context={context} outcome={lifecycle?.status} />
    </TurnWork>
    <ActivityGroups groups={boundaries} context={context} />
    {article(final)}
  </>
})

export const MessageList = memo(function MessageList({ messages, provider, running, placement, context, streamText = true, threadId }: {
  readonly messages: readonly AgentMessage[]; readonly provider: string; readonly running: boolean
  readonly placement: ActivityPlacement; readonly context: ActivityContext; readonly streamText?: boolean
  /** The thread these messages belong to, which is how a submitted attachment finds its preview. */
  readonly threadId?: string
}): ReactNode {
  const last = messages.findLast(drawn)
  const writing = running && last?.role === 'assistant' && !placement.after.get(last.id)?.length ? last.id : undefined
  // Turns are re-split on every arrival but hold the same messages; sharing their structure lets the
  // memoised turns below compare equal.
  const turns = useShared(useMemo(() => splitTurns(messages), [messages]))
  return <>{turns.map((turn, index) => <TurnView key={turn.key} turn={turn} provider={provider} running={running}
    last={index === turns.length - 1} writing={writing} placement={placement} context={context} streamText={streamText} threadId={threadId} />)}
  <ActivityGroups groups={placement.trailing} context={context} />
  </>
})

/**
 * A message the user sent from this window, drawn where it will sit in the conversation from the press
 * onwards. A direct send says how the delivery went and offers the prompt back when it was refused;
 * a queued one is an echo alone, because the queue below the composer holds its controls.
 */
function PendingMessage({ draftId, submission, status, row, state, command, store }: {
  readonly draftId: string; readonly submission?: Submission; readonly status: SubmissionStatus; readonly row: ThreadRow
  readonly state: AgentState; readonly command: Command; readonly store: ThreadDraftStore
}): ReactNode {
  const { draft } = useThreadComposer(store, row.thread.id)
  const queued = submission?.mode === 'queue'
  const restored = submission?.restoredAs !== undefined && draft.draftId === submission.restoredAs
  const provider = state.host.providers && row.providerId ? { provider: row.providerId } : {}
  // The provider's history can show the exact message before Sotto has its confirmation.
  // Repeating the text would read as a second send, so only the delivery state stays here.
  const messageId = deliveryFor(state, row.thread.id, draftId)?.messageId
  const inHistory = messageId !== undefined && row.thread.messages.some(message => message.id === messageId)
  if (submission !== undefined && inHistory && (status === 'queued' || status === 'submitting')) return null
  const label = <span className="thread-message__status" role="status" data-status={status}><i aria-hidden="true" />{queued && status === 'queued' ? 'Queued' : STATUS_LABELS[status]}</span>
  const unresolved = status === 'uncertain' || submission === undefined && deliveryPending(status)
  // A queued prompt is told by the queue, which is also where it is edited, moved or removed.
  // Only the header's Reconnect acts on a disconnected provider; Check again needs a connection.
  const detail = queued ? null
    : status === 'failed' ? `${submission?.error ?? 'The provider did not take this prompt.'}${submission === undefined ? '' : restored ? ' It is back in the composer.' : hasDraftContent(draft) ? ' Restoring it replaces the draft in the composer.' : ''}`
      : unresolved ? `Sotto will not send ${submission === undefined && !inHistory ? 'your last prompt' : 'it'} twice.${row.connected ? '' : ' Reconnect to check it.'}`
        : null
  const delivery = detail === null ? null : <div className="thread-message__delivery">
    <span>{detail}</span>
    <div className="thread-message__delivery-actions">
      {status === 'failed' && submission !== undefined ? <Button variant="secondary" disabled={!row.connected || isThreadBusy(state, row.thread.id)}
        onClick={() => void sendThreadRevision(store, row, command, performance.now(), submission.mode, draftId)}>Retry</Button> : null}
      {status === 'failed' && submission !== undefined && !restored ? <Button variant="secondary" onClick={() => store.restore(row.thread.id, draftId)}>Restore prompt</Button> : null}
      {/* Checking again refreshes the provider, which is global-lane work. */}
      {unresolved && row.connected ? <Button variant="secondary" disabled={state.globalLaneBusy} onClick={() => void command({ type: 'refresh', ...provider })}>Check again</Button> : null}
      {status === 'failed' ? <Button variant="ghost" onClick={() => store.dismiss(row.thread.id, draftId)}>Dismiss</Button> : null}
    </div>
  </div>
  // With no prompt text to show (already in the history, or recovered after a restart),
  // the state is a compact line under the conversation rather than an empty second bubble.
  if (inHistory || submission === undefined) {
    return <div className="thread-delivery" role="group" aria-label="Pending message" data-status={status} data-in-history={inHistory || undefined}>{label}{delivery}</div>
  }
  return <article className="thread-message thread-message--pending" data-role="user" data-status={status} aria-label={queued ? 'Queued message' : 'Pending message'}>
    <header><span className="thread-message__who">You</span>{label}</header>
    <MessageContent text={submission.text} /><AttachmentPreviews attachments={submission.attachments} />
    {delivery}
  </article>
}

/** Follow-up statuses in the transcript's own words, each with the state it is already coloured by there. */
const QUEUED_ECHO: Record<AgentFollowup['status'], { readonly label: string; readonly status: SubmissionStatus }> = {
  queued: { label: 'Queued', status: 'queued' }, dispatching: { label: 'Sending', status: 'submitting' },
  uncertain: { label: 'Unconfirmed', status: 'uncertain' }, failed: { label: 'Not sent', status: 'failed' },
  paused: { label: 'Paused', status: 'uncertain' },
}

/**
 * A message the thread's queue holds, in the place it will take in the conversation. It repeats what the
 * user wrote and nothing else: the queue under the composer is where it is edited, moved or removed.
 */
function QueuedMessage({ item }: { readonly item: AgentFollowup }): ReactNode {
  const echo = QUEUED_ECHO[item.status]
  return <article className="thread-message thread-message--pending" data-role="user" data-status={echo.status} aria-label="Queued message">
    <header><span className="thread-message__who">You</span>
      <span className="thread-message__status" data-status={echo.status}><i aria-hidden="true" />{echo.label}</span></header>
    <MessageContent text={item.text} /><AttachmentPreviews attachments={item.attachments} />
  </article>
}

/** The floating Jump to latest button's band at the bottom of the transcript: its offset, height and a little air. */
const JUMP_BAND_PX = 60

export function reachesJumpBand(scroller: HTMLElement): boolean {
  const view = scroller.getBoundingClientRect()
  return [...scroller.querySelectorAll('.agent-request')].some(card => {
    const box = card.getBoundingClientRect()
    return box.bottom > view.bottom - JUMP_BAND_PX && box.top < view.bottom
  })
}

/**
 * The selected thread's history. It follows new content only while the reader is at the end;
 * reading older messages keeps its place and offers Jump to latest. Showing earlier messages keeps
 * the message under the reader where it was.
 */
export function ThreadTranscript({ row, state, command, store, followSignal, children }: {
  readonly row: ThreadRow
  readonly state: AgentState
  readonly command: Command
  readonly store: ThreadDraftStore
  /** Changes when the user sends from this window: the transcript returns to the newest message. */
  readonly followSignal: number
  /** The inline request, rendered after the newest message. */
  readonly children?: ReactNode
}): ReactNode {
  const thread = row.thread
  const streamText = useAgents().responseStreaming !== 'complete'
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const anchor = useRef<{ readonly height: number; readonly top: number } | null>(null)
  const followed = useRef(followSignal)
  const seen = useRef<string | undefined>(undefined)
  const firstRendered = useRef<{ readonly threadId: string; readonly messageId: string } | null>(null)
  const [limit, setLimit] = useState(TRANSCRIPT_PAGE)
  const [away, setAway] = useState(false)
  const [unseen, setUnseen] = useState(false)
  const [requestUnderJump, setRequestUnderJump] = useState(false)
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
  // What the queue holds is echoed here in dispatch order, until the provider's own history carries it.
  const queuedEchoes = followupsFor(state, thread.id).filter(item => item.messageId === undefined || !thread.messages.some(message => message.id === item.messageId))
  // Sending starts the working line on the press; the provider's own running turn takes it over when it arrives.
  const sendingSince = pending.find(item => item.item.mode !== 'queue' && (item.status === 'queued' || item.status === 'submitting'))?.item.startedAt
  // A direct send belongs to the turn starting now; one bound for the queue lines up after it.
  const sending = pending.filter(item => item.item.mode !== 'queue')
  const admissions = pending.filter(item => item.item.mode === 'queue')
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
  const placement = useShared(useMemo(() => placeActivities(thread.messages, messages, thread.activities, thread.historyStatus === 'loading'),
    [thread.messages, messages, thread.activities, thread.historyStatus]))
  const liveTurn = liveTurnId(thread)
  const pendingKey = [...pending.map(item => `${item.item.draftId}:${item.status}`), ...queuedEchoes.map(item => `${item.id}:${item.status}`),
    ...recovery.map(item => `${item.draftId}:${item.status}`)].join(',')

  useLayoutEffect(() => {
    firstRendered.current = messages[0] ? { threadId: thread.id, messageId: messages[0].id } : null
  }, [messages, thread.id])

  const toEnd = useCallback((): void => {
    const element = scroller.current
    if (element === null) return
    element.scrollTop = element.scrollHeight
    following.current = true
    setAway(false)
    setUnseen(false)
  }, [])

  // A different thread opens at its newest message with a fresh page.
  useLayoutEffect(() => {
    anchor.current = null
    seen.current = undefined
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
    if (followed.current !== followSignal) { followed.current = followSignal; toEnd(); return }
    const arrived = seen.current !== lastMessageId
    seen.current = lastMessageId
    if (following.current) element.scrollTop = element.scrollHeight
    else if (arrived) setUnseen(true)
  }, [lastMessageId, pendingKey, hidden, followSignal, thread.historyStatus, toEnd])

  // Late layout (wrapped text, images, rich blocks) keeps a following reader at the end.
  useEffect(() => {
    const element = content.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (following.current && anchor.current === null && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
      if (scroller.current) setRequestUnderJump(reachesJumpBand(scroller.current))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const onScroll = (): void => {
    const element = scroller.current
    if (element === null) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    following.current = distance <= FOLLOW_SLACK_PX
    const isAway = distance > Math.max(FOLLOW_SLACK_PX, element.clientHeight / 2)
    if (isAway !== away) setAway(isAway)
    if (following.current && unseen) setUnseen(false)
    setRequestUnderJump(reachesJumpBand(element))
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
  const activity = useMemo<ActivityContext>(() => ({ liveTurn, running: thread.status === 'running', connected: row.connected, provider: row.provider, onDisclosure }),
    [liveTurn, thread.status, row.connected, row.provider, onDisclosure])
  const showsActivity = placement.trailing.length > 0 || liveTurn !== null
  const lastGroup = placement.trailing.at(-1) ?? (lastMessageId === undefined ? undefined : placement.after.get(lastMessageId)?.at(-1))

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

  const empty = !thread.messages.length && !pending.length && !queuedEchoes.length && !recovery.length && !showsActivity
  return <div className="thread-transcript">
    <div className="thread-workspace__transcript" ref={scroller} onScroll={onScroll} tabIndex={0} role="log" aria-live="off"
      aria-label="Thread transcript" aria-busy={thread.historyStatus === 'loading'}>
      <div className="thread-transcript__content" ref={content}>
        {thread.historyStatus === 'loading' && <div className="thread-history-status" role="status">Loading messages…</div>}
        {thread.historyStatus === 'error' && <div className="thread-history-status" role="alert"><span>{thread.historyError || 'Could not load this thread’s messages.'}</span><Button variant="ghost" disabled={state.globalLaneBusy || !row.connected} onClick={() => void command({ type: 'refresh' })}>Retry loading messages</Button></div>}
        {hidden > 0
          ? <div className="thread-transcript__earlier"><Button variant="ghost" onClick={showEarlier}>Show earlier messages ({hidden})</Button></div>
          /* Everything the window holds is on screen, and the thread store still has older messages. */
          : thread.earlierAvailable
            ? <div className="thread-transcript__earlier"><Button variant="ghost" onClick={loadEarlier}>Show earlier messages</Button></div>
            : null}
        {thread.messages.length || showsActivity ? <MessageList messages={messages} provider={row.provider} running={thread.status === 'running'} placement={placement} context={activity} streamText={streamText} threadId={thread.id} />
          : thread.historyStatus === 'loading' ? <div className="thread-history-skeleton" aria-hidden="true"><i /><i /><i /></div>
            : thread.historyStatus === 'error' || !empty ? null
              : <div className="thread-workspace__empty"><MessageSquare size={26} strokeWidth={1.3} aria-hidden="true" /><h3>{thread.compaction?.status === 'running' ? 'Compacting the context.' : thread.status === 'running' ? 'The agent is working.' : 'What is next for this thread?'}</h3><p>{thread.status === 'running' ? 'New messages will appear here.' : 'Write a prompt below to continue.'}</p></div>}
        {/* A prompt on its way sits where it will be read, and the working line under it counts from the press. */}
        {sending.map(({ item, status }) => <PendingMessage key={item.draftId} draftId={item.draftId} submission={item} status={status} row={row} state={state} command={command} store={store} />)}
        <LiveActivity thread={thread} connected={row.connected} adjacentRecordId={lastGroup ? nestActivities(lastGroup.records).at(-1)?.record.id : undefined} sendingSince={sendingSince} />
        {queuedEchoes.map(item => <QueuedMessage key={item.id} item={item} />)}
        {admissions.map(({ item, status }) => <PendingMessage key={item.draftId} draftId={item.draftId} submission={item} status={status} row={row} state={state} command={command} store={store} />)}
        {recovery.map(item => <PendingMessage key={item.draftId} draftId={item.draftId} status={item.status} row={row} state={state} command={command} store={store} />)}
        {children}
      </div>
    </div>
    {/* A request's choices and text are never covered: while a card reaches the button's band, the button steps aside. */}
    {(away || unseen) && !requestUnderJump ? <button type="button" className="thread-transcript__jump tt-focusable" data-unseen={unseen || undefined} onClick={toEnd}>
      <ArrowDown size={16} aria-hidden="true" />{unseen ? 'New messages' : 'Jump to latest'}
    </button> : null}
  </div>
}
