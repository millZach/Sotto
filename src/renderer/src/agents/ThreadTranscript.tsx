import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, Image, MessageSquare } from 'lucide-react'
import type { AgentMessage, AgentState } from '../../../shared/agents'
import { Button } from '../components/Button'
import type { AgentConnection } from './AgentContext'
import { sendThreadRevision } from './ThreadComposer'
import { submissionStatus, useSubmissions, useThreadComposer, type Submission, type SubmissionStatus, type ThreadDraftStore } from './threadDraftStore'
import { clockLabel, type ThreadRow } from './threadFacts'

type Command = AgentConnection['command']

export const TRANSCRIPT_PAGE = 80
/** Within this many pixels of the end, the reader is following the conversation. */
const FOLLOW_SLACK_PX = 48

const STATUS_LABELS: Record<SubmissionStatus, string> = {
  queued: 'Queued', submitting: 'Sending', accepted: 'Sent', failed: 'Not sent', uncertain: 'Unconfirmed',
}

// Rich lane swap point: `MessageContent`/`AttachmentPreviews` from './MessageContent' replace these two.
function MessageBody({ text }: { readonly text: string }): ReactNode {
  return <p className="thread-message__text">{text}</p>
}
function MessageAttachments({ attachments }: { readonly attachments: readonly { readonly id: string; readonly name: string }[] }): ReactNode {
  if (!attachments.length) return null
  return <div className="thread-message__attachments" aria-label="Message screenshots">{attachments.map(attachment => <span key={attachment.id}><Image size={14} aria-hidden="true" />{attachment.name}</span>)}</div>
}

/** Rendered history. Memoized on the message array so composer keystrokes and status ticks do not repaint it. */
const MessageList = memo(function MessageList({ messages, provider }: { readonly messages: readonly AgentMessage[]; readonly provider: string }): ReactNode {
  return <>{messages.map(message => <article className="thread-message" key={message.id} data-role={message.role}>
    <header><span className="thread-message__who">{message.role === 'user' ? 'You' : message.role === 'assistant' ? provider : 'System'}</span><time dateTime={message.createdAt}>{clockLabel(Date.parse(message.createdAt))}</time></header>
    <MessageBody text={message.text} />
    <MessageAttachments attachments={message.attachments ?? []} />
  </article>)}</>
})

function PendingMessage({ submission, status, row, state, command, store }: {
  readonly submission: Submission; readonly status: SubmissionStatus; readonly row: ThreadRow
  readonly state: AgentState; readonly command: Command; readonly store: ThreadDraftStore
}): ReactNode {
  const { draft } = useThreadComposer(store, submission.threadId)
  const holdsRevision = draft.draftId === submission.draftId
  const provider = state.host.providers && row.providerId ? { provider: row.providerId } : {}
  const detail = status === 'failed' ? (submission.error ?? 'The provider did not take this prompt.')
    : status === 'uncertain' ? 'The provider has not confirmed this prompt. Sotto will not send it twice.'
      : null
  return <article className="thread-message thread-message--pending" data-role="user" data-status={status} aria-label="Pending message">
    <header><span className="thread-message__who">You</span><span className="thread-message__status" role="status" data-status={status}><i aria-hidden="true" />{STATUS_LABELS[status]}</span></header>
    <MessageBody text={submission.text} />
    <MessageAttachments attachments={submission.attachments} />
    {detail !== null ? <div className="thread-message__delivery">
      <span>{detail}{status === 'failed' && !holdsRevision ? ' Your newer draft is in the composer.' : ''}</span>
      <div className="thread-message__delivery-actions">
        {status === 'failed' && holdsRevision ? <Button variant="secondary" disabled={!row.connected || state.busy} onClick={() => void sendThreadRevision(store, row, command, performance.now())}>Retry</Button> : null}
        {status === 'uncertain' ? row.connected
          ? <Button variant="secondary" disabled={state.busy} onClick={() => void command({ type: 'refresh', ...provider })}>Check again</Button>
          : <Button variant="secondary" disabled={state.connection === 'connecting'} onClick={() => void command({ type: 'connect', ...provider })}>Reconnect</Button> : null}
        {status === 'failed' ? <Button variant="ghost" onClick={() => store.dismiss(submission.threadId, submission.draftId)}>Dismiss</Button> : null}
      </div>
    </div> : null}
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
  const [limit, setLimit] = useState(TRANSCRIPT_PAGE)
  const [away, setAway] = useState(false)
  const [unseen, setUnseen] = useState(false)
  const submissions = useSubmissions(store)
  const pending = submissions.filter(item => item.threadId === thread.id)
    .map(item => ({ item, ...submissionStatus(item, state) })).filter(item => item.visible)
  const messages = thread.messages.length > limit ? thread.messages.slice(-limit) : thread.messages
  const hidden = thread.messages.length - messages.length
  const lastMessageId = thread.messages.at(-1)?.id
  const pendingKey = pending.map(item => `${item.item.draftId}:${item.status}`).join(',')

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

  const showEarlier = (): void => {
    const element = scroller.current
    if (element !== null) anchor.current = { height: element.scrollHeight, top: element.scrollTop }
    following.current = false
    setLimit(current => current + TRANSCRIPT_PAGE)
  }

  const empty = !thread.messages.length && !pending.length
  return <div className="thread-transcript">
    <div className="thread-workspace__transcript" ref={scroller} onScroll={onScroll} tabIndex={0} role="log" aria-live="off"
      aria-label="Thread transcript" aria-busy={thread.historyStatus === 'loading'}>
      <div className="thread-transcript__content" ref={content}>
        {thread.historyStatus === 'loading' && <div className="thread-history-status" role="status">Loading messages…</div>}
        {thread.historyStatus === 'error' && <div className="thread-history-status" role="alert"><span>{thread.historyError || 'Could not load this thread’s messages.'}</span><Button variant="ghost" disabled={state.busy || !row.connected} onClick={() => void command({ type: 'refresh' })}>Retry loading messages</Button></div>}
        {hidden > 0 && <div className="thread-transcript__earlier"><Button variant="ghost" onClick={showEarlier}>Show earlier messages ({hidden})</Button></div>}
        {thread.messages.length ? <MessageList messages={messages} provider={row.provider} />
          : thread.historyStatus === 'loading' ? <div className="thread-history-skeleton" aria-hidden="true"><i /><i /><i /></div>
            : thread.historyStatus === 'error' || !empty ? null
              : <div className="thread-workspace__empty"><MessageSquare size={26} strokeWidth={1.3} aria-hidden="true" /><h3>{thread.status === 'running' ? 'The agent is working.' : 'What is next for this thread?'}</h3><p>{thread.status === 'running' ? 'New messages will appear here.' : 'Write a prompt below to continue.'}</p></div>}
        {pending.map(({ item, status }) => <PendingMessage key={item.draftId} submission={item} status={status} row={row} state={state} command={command} store={store} />)}
        {children}
      </div>
    </div>
    {away || unseen ? <button type="button" className="thread-transcript__jump tt-focusable" data-unseen={unseen || undefined} onClick={toEnd}>
      <ArrowDown size={16} aria-hidden="true" />{unseen ? 'New messages' : 'Jump to latest'}
    </button> : null}
  </div>
}
