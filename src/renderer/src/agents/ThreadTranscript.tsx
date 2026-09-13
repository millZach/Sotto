import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, MessageSquare } from 'lucide-react'
import type { AgentMessage, AgentState } from '../../../shared/agents'
import { Button } from '../components/Button'
import type { AgentConnection } from './AgentContext'
import { sendThreadRevision } from './ThreadComposer'
import { deliveryFor, deliveryPending, queuedRevision, submissionStatus, useSubmissions, useThreadComposer, type Submission, type SubmissionStatus, type ThreadDraftStore } from './threadDraftStore'
import { clockLabel, type ThreadRow } from './threadFacts'
import { MessageContent, AttachmentPreviews } from './MessageContent'
import { ActivityGroupView, LiveActivity } from './ThreadActivity'
import { liveTurnId, placeActivities, type ActivityGroup, type ActivityPlacement } from './threadActivityView'

type Command = AgentConnection['command']

export const TRANSCRIPT_PAGE = 80
/** Within this many pixels of the end, the reader is following the conversation. */
const FOLLOW_SLACK_PX = 48

const STATUS_LABELS: Record<SubmissionStatus, string> = {
  queued: 'Queued', submitting: 'Sending', accepted: 'Sent', failed: 'Not sent', uncertain: 'Unconfirmed',
}

interface ActivityContext {
  readonly liveTurn: string | null
  readonly running: boolean
  readonly connected: boolean
  readonly provider: string
  readonly onDisclosure: (element: HTMLElement) => void
}

function ActivityGroups({ groups, context }: { readonly groups: readonly ActivityGroup[] | undefined; readonly context: ActivityContext }): ReactNode {
  return groups?.map(group => <ActivityGroupView key={group.key} group={group} live={group.turnId === context.liveTurn} threadRunning={context.running}
    connected={context.connected} provider={context.provider} onDisclosure={context.onDisclosure} />) ?? null
}

/**
 * Rendered history with each activity group after the message it followed. Memoized on the message
 * array and placement so composer keystrokes and status ticks do not repaint it.
 */
const MessageList = memo(function MessageList({ messages, provider, running, placement, context }: {
  readonly messages: readonly AgentMessage[]; readonly provider: string; readonly running: boolean
  readonly placement: ActivityPlacement; readonly context: ActivityContext
}): ReactNode {
  return <>{messages.map(message => <React.Fragment key={message.id}>
    <article className="thread-message" data-role={message.role}>
      <header><span className="thread-message__who">{message.role === 'user' ? 'You' : message.role === 'assistant' ? provider : 'System'}</span><time dateTime={message.createdAt}>{clockLabel(Date.parse(message.createdAt))}</time></header>
      <MessageContent text={message.text} streaming={running && message.role === 'assistant' && message.id === messages.at(-1)?.id} />
      <AttachmentPreviews attachments={message.attachments ?? []} />
    </article>
    <ActivityGroups groups={placement.after.get(message.id)} context={context} />
  </React.Fragment>)}
  <ActivityGroups groups={placement.trailing} context={context} />
  </>
})

function PendingMessage({ draftId, submission, status, row, state, command, store }: {
  readonly draftId: string; readonly submission?: Submission; readonly status: SubmissionStatus; readonly row: ThreadRow
  readonly state: AgentState; readonly command: Command; readonly store: ThreadDraftStore
}): ReactNode {
  const { draft } = useThreadComposer(store, row.thread.id)
  const holdsRevision = draft.draftId === draftId
  const provider = state.host.providers && row.providerId ? { provider: row.providerId } : {}
  // The provider's history can show the exact message before Sotto has its confirmation.
  // Repeating the text would read as a second send, so only the delivery state stays here.
  const messageId = deliveryFor(state, row.thread.id, draftId)?.messageId
  const inHistory = messageId !== undefined && row.thread.messages.some(message => message.id === messageId)
  if (submission !== undefined && inHistory && (status === 'queued' || status === 'submitting')) return null
  const label = <span className="thread-message__status" role="status" data-status={status}><i aria-hidden="true" />{STATUS_LABELS[status]}</span>
  const unresolved = status === 'uncertain' || submission === undefined && deliveryPending(status)
  // Only the header's Reconnect acts on a disconnected provider; Check again needs a connection.
  const detail = status === 'failed' ? `${submission?.error ?? 'The provider did not take this prompt.'}${holdsRevision ? '' : ' Your newer draft is in the composer.'}`
    : unresolved ? `Sotto will not send ${submission === undefined && !inHistory ? 'your last prompt' : 'it'} twice.${row.connected ? '' : ' Reconnect to check it.'}`
      : null
  const delivery = detail === null ? null : <div className="thread-message__delivery">
    <span>{detail}</span>
    <div className="thread-message__delivery-actions">
      {status === 'failed' && holdsRevision ? <Button variant="secondary" disabled={!row.connected || state.busy} onClick={() => void sendThreadRevision(store, row, command, performance.now())}>Retry</Button> : null}
      {unresolved && row.connected ? <Button variant="secondary" disabled={state.busy} onClick={() => void command({ type: 'refresh', ...provider })}>Check again</Button> : null}
      {status === 'failed' ? <Button variant="ghost" onClick={() => store.dismiss(row.thread.id, draftId)}>Dismiss</Button> : null}
    </div>
  </div>
  // With no prompt text to show (already in the history, or recovered after a restart),
  // the state is a compact line under the conversation rather than an empty second bubble.
  if (inHistory || submission === undefined) {
    return <div className="thread-delivery" role="group" aria-label="Pending message" data-status={status} data-in-history={inHistory || undefined}>{label}{delivery}</div>
  }
  return <article className="thread-message thread-message--pending" data-role="user" data-status={status} aria-label="Pending message">
    <header><span className="thread-message__who">You</span>{label}</header>
    <MessageContent text={submission.text} /><AttachmentPreviews attachments={submission.attachments} />
    {delivery}
  </article>
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
  const sameThread = firstRendered.current?.threadId === thread.id
  const retainedStart = sameThread ? thread.messages.findIndex(message => message.id === firstRendered.current?.messageId) : -1
  // While reading earlier history, retain the first rendered message. A sliding
  // last-N slice would otherwise remove a row above the reader on every arrival.
  const start = !following.current && retainedStart >= 0 ? retainedStart : Math.max(0, thread.messages.length - (sameThread ? limit : TRANSCRIPT_PAGE))
  const messages = useMemo(() => thread.messages.slice(start), [thread.messages, start])
  const hidden = thread.messages.length - messages.length
  const lastMessageId = thread.messages.at(-1)?.id
  const placement = useMemo(() => placeActivities(thread.messages, messages, thread.activities, thread.historyStatus === 'loading'),
    [thread.messages, messages, thread.activities, thread.historyStatus])
  const liveTurn = liveTurnId(thread)
  const pendingKey = [...pending.map(item => `${item.item.draftId}:${item.status}`), ...recovery.map(item => `${item.draftId}:${item.status}`)].join(',')

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

  const empty = !thread.messages.length && !pending.length && !recovery.length && !showsActivity
  return <div className="thread-transcript">
    <div className="thread-workspace__transcript" ref={scroller} onScroll={onScroll} tabIndex={0} role="log" aria-live="off"
      aria-label="Thread transcript" aria-busy={thread.historyStatus === 'loading'}>
      <div className="thread-transcript__content" ref={content}>
        {thread.historyStatus === 'loading' && <div className="thread-history-status" role="status">Loading messages…</div>}
        {thread.historyStatus === 'error' && <div className="thread-history-status" role="alert"><span>{thread.historyError || 'Could not load this thread’s messages.'}</span><Button variant="ghost" disabled={state.busy || !row.connected} onClick={() => void command({ type: 'refresh' })}>Retry loading messages</Button></div>}
        {hidden > 0 && <div className="thread-transcript__earlier"><Button variant="ghost" onClick={showEarlier}>Show earlier messages ({hidden})</Button></div>}
        {thread.messages.length || showsActivity ? <MessageList messages={messages} provider={row.provider} running={thread.status === 'running'} placement={placement} context={activity} />
          : thread.historyStatus === 'loading' ? <div className="thread-history-skeleton" aria-hidden="true"><i /><i /><i /></div>
            : thread.historyStatus === 'error' || !empty ? null
              : <div className="thread-workspace__empty"><MessageSquare size={26} strokeWidth={1.3} aria-hidden="true" /><h3>{thread.status === 'running' ? 'The agent is working.' : 'What is next for this thread?'}</h3><p>{thread.status === 'running' ? 'New messages will appear here.' : 'Write a prompt below to continue.'}</p></div>}
        <LiveActivity thread={thread} connected={row.connected} adjacentRecordId={lastGroup?.records.at(-1)?.id} />
        {pending.map(({ item, status }) => <PendingMessage key={item.draftId} draftId={item.draftId} submission={item} status={status} row={row} state={state} command={command} store={store} />)}
        {recovery.map(item => <PendingMessage key={item.draftId} draftId={item.draftId} status={item.status} row={row} state={state} command={command} store={store} />)}
        {children}
      </div>
    </div>
    {away || unseen ? <button type="button" className="thread-transcript__jump tt-focusable" data-unseen={unseen || undefined} onClick={toEnd}>
      <ArrowDown size={16} aria-hidden="true" />{unseen ? 'New messages' : 'Jump to latest'}
    </button> : null}
  </div>
}
