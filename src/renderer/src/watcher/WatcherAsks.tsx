import React, { createContext, useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, Laptop, Server } from 'lucide-react'
import { AGENT_THREAD_EXCERPT_MAX, type AgentRequest, type AgentState } from '../../../shared/agents'
import { isThreadClosed } from '../../../shared/threadActivity'
import type { WatcherThreadTarget } from '../../../shared/watcher'
import { watcherAskKey } from '../../../shared/watcherAsks'
import type { WatcherRoomState } from '../../../shared/watcherRoom'
import type { AgentConnection } from '../agents/AgentContext'
import { MessageContent } from '../agents/MessageContent'
import { ProviderMark } from '../agents/ProviderMark'
import type { ThreadRow } from '../agents/threadFacts'
import { AgentRequestCard } from '../agents/requests/AgentRequestCard'
import { messageLinks } from '../agents/requests/messageLinks'
import { answeredChoices, chosenWords, OWN_WORDS } from '../agents/requests/answeredChoices'
import { requestAnswerOwnerKey, requestAnswerStore } from '../agents/requests/requestAnswers'
import { threadRequestBlocked, threadRequestOwner, threadRequestSubmit } from '../agents/requests/threadRequests'
import type { ConversationThread } from './WatcherReceipts'

/** One request a wake-up said waited on the user, placed under the message of Watcher's conversation its card goes under. */
export type WatcherAskPlacement = NonNullable<WatcherRoomState['asks']>[number]

/**
 * What answering in Watcher's conversation needs from the room (ADR-0073): the window's state and command, the row
 * for a thread's owning-host address, opening a thread beside Watcher at its request, and reading one again.
 */
export interface WatcherAskAnswering {
  readonly state: AgentState
  readonly command: AgentConnection['command']
  /** The window's row for a thread by its owning host's address, local or on a paired host. */
  readonly rowFor: (target: WatcherThreadTarget) => ThreadRow | undefined
  /** Opens a thread beside Watcher at what it waits on; focus goes back to `from` when it closes. */
  readonly openAtRequest: (threadId: string, from: HTMLElement | null) => void
  /** A card's Check again: reads the thread from its provider without letting go of Watcher's own reads. */
  readonly check: (threadId: string) => Promise<boolean>
}

/** What the cards answer with, from Watcher's room; it changes with every update, so only the cards read it. */
export const WatcherAskAnsweringContext = createContext<WatcherAskAnswering | null>(null)

/**
 * Main's placements as the room last received them, the same array until one of them changes: the room is projected
 * again on every update, and an unchanged list should not redraw the conversation around it.
 */
export function useStablePlacements(placements: readonly WatcherAskPlacement[] | undefined): readonly WatcherAskPlacement[] | undefined {
  const kept = useRef<{ readonly key: string; readonly placements: readonly WatcherAskPlacement[] | undefined }>({ key: 'null', placements: undefined })
  const key = JSON.stringify(placements ?? null)
  if (kept.current.key !== key) kept.current = { key, placements }
  return kept.current.placements
}

/**
 * Each message's asks, oldest first, from main's placements. A request two wake-ups named, because it changed in
 * between, is placed only under the newer: an earlier reference shows nothing, so one request has one card.
 */
export function placeAsks(placements: readonly WatcherAskPlacement[] | undefined): ReadonlyMap<string, readonly WatcherAskPlacement[]> {
  const placed = new Map<string, WatcherAskPlacement[]>()
  if (!placements?.length) return placed
  const newest = new Map<string, number>()
  for (const [at, placement] of placements.entries()) newest.set(watcherAskKey(placement), at)
  for (const [at, placement] of placements.entries()) {
    if (newest.get(watcherAskKey(placement)) !== at) continue
    placed.set(placement.messageId, [...placed.get(placement.messageId) ?? [], placement])
  }
  return placed
}

/**
 * The receipt's words: what the user chose, when this window sent it; otherwise only that the thread no longer waits. A
 * title named from a first message can end in its own full stop, which goes, so the line reads as one sentence.
 */
export function receiptWords(named: string, words: string | null | undefined): string {
  const title = named.replace(/\.+$/u, '')
  if (words === undefined) return `${title} no longer waits on you.`
  if (words === null) return `You answered ${title}.`
  if (words === OWN_WORDS) return `You answered ${title} ${OWN_WORDS}.`
  return `You answered ${title}: ${words}.`
}

const KIND_WORD = { question: 'question', permission: 'permission' } as const

/**
 * The asks under one message of Watcher's conversation (Zach's pick on October 19, 2026, variant B): for each request a
 * wake-up said waited on the user, the thread's own live card while it waits, and once it no longer does, one line in its
 * place. Drawn from the thread's live requests alone, so an answer given anywhere (here, in the thread, on the phone)
 * takes the card away in every place at once.
 */
export function WatcherAsks({ asks, describe, press }: {
  readonly asks: readonly WatcherAskPlacement[]
  readonly describe: (target: WatcherThreadTarget) => ConversationThread
  readonly press: (threadId: string) => Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'onKeyDown'>
}): ReactNode {
  const answering = useContext(WatcherAskAnsweringContext)
  if (answering === null) return null
  return <div className="watcher-asks">
    {asks.map(ask => <WatcherAskEntry key={`${ask.wakeUpMessageId}:${watcherAskKey(ask)}`} ask={ask} facts={describe(ask.target)} answering={answering} press={press} />)}
  </div>
}

function WatcherAskEntry({ ask, facts, answering, press }: {
  readonly ask: WatcherAskPlacement; readonly facts: ConversationThread; readonly answering: WatcherAskAnswering
  readonly press: (threadId: string) => Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'onKeyDown'>
}): ReactNode {
  const row = answering.rowFor(ask.target)
  const request = row === undefined || isThreadClosed(row.thread) ? undefined : row.thread.requests.find(item => item.id === ask.requestCardId)
  const title = row?.thread.title ?? facts.title ?? 'A thread'
  // Read whatever happens below, so the line follows an answer whose reply came after its request had already left.
  const sent = useSyncExternalStore(answeredChoices.subscribe, () => row === undefined ? undefined : answeredChoices.sent(row.thread.id, ask.requestCardId))
  if (row !== undefined && request !== undefined) return <WatcherAskCard row={row} request={request} facts={facts} answering={answering} press={press} />
  // A thread the window does not hold right now, such as one on a host still joining, has nothing to show or open: the
  // needs-you line still names it while it waits.
  if (row === undefined) return null
  return <p className="watcher-ask-receipt" data-ask-request={ask.requestCardId}>
    <span className="watcher-ask-receipt__words">{receiptWords(title, sent)}</span>
    <button type="button" className="watcher-ask__open tt-focusable" aria-label={`Open ${title} beside Watcher`} title={`Open ${title} beside Watcher`}
      {...press(row.thread.id)}>Open</button>
  </p>
}

/**
 * The card for one waiting request: whose it is, its provider and computer, the thread's last reply folded under
 * Show what it said, then the thread's own request card. The card is the user's own control: it sends the ordinary
 * answer for the watched thread's request, as that thread's pane does, and shares that pane's answer in the window, so a
 * press in either shows as sending in both.
 */
function WatcherAskCard({ row, request, facts, answering, press }: {
  readonly row: ThreadRow; readonly request: AgentRequest; readonly facts: ConversationThread; readonly answering: WatcherAskAnswering
  readonly press: (threadId: string) => Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'onKeyDown'>
}): ReactNode {
  const { state, command } = answering
  const thread = row.thread
  const owner = threadRequestOwner(row, state)
  const ownerKey = requestAnswerOwnerKey(thread.id, request, owner)
  const entry = useSyncExternalStore(requestAnswerStore.subscribe, () => requestAnswerStore.get(ownerKey, request.id))
  // What is being chosen is kept while the request is still here to name it, so the line that replaces the card can say
  // it once main takes the answer. Only a send seen leaving this window counts: a delivery state restored after a
  // reload says nothing of who answered. Whether main took it is noted by whichever card sent it, when main replies.
  useEffect(() => {
    if (entry.phase === 'sending') answeredChoices.note(thread.id, request.id, chosenWords(request, entry), false)
  }, [entry, request, thread.id])
  const kind = KIND_WORD[request.kind]
  const computer = facts.computer ?? (thread.remoteHost ? thread.hostLabel ?? 'Paired computer' : 'This computer')
  const remote = facts.remote || thread.remoteHost === true
  return <section className="watcher-ask" tabIndex={-1} aria-label={`${kind === 'permission' ? 'Permission request' : 'Question'} from ${thread.title}`}
    data-ask-thread={thread.id} data-ask-request={request.id} data-kind={request.kind}>
    <div className="watcher-ask__top">
      <span className="watcher-row__ring" data-tone="needs" aria-hidden="true" />
      <strong className="watcher-ask__title" title={thread.title}>{thread.title}</strong>
      <span className="watcher-ask__meta">
        <span className="watcher-ask__provider">
          {row.providerId === undefined ? null : <span className="thread-nav__mark" data-provider={row.providerId} aria-hidden="true"><ProviderMark provider={row.providerId} name={row.provider} /></span>}
          {row.provider}</span>
        <span className="watcher-ask__machine" data-kind={remote ? 'remote' : 'local'}>
          {remote ? <Server size={12} aria-hidden="true" /> : <Laptop size={12} aria-hidden="true" />}{computer}</span>
        <span className="watcher-ask__kind" aria-hidden="true">{kind}</span>
      </span>
      <button type="button" className="watcher-ask__open tt-focusable" aria-label={`Open ${thread.title} beside Watcher`} title={`Open ${thread.title} beside Watcher`}
        {...press(thread.id)}>Open</button>
    </div>
    <WhatItSaid row={row} />
    <AgentRequestCard ownerId={thread.id} ownerTitle={thread.title} request={request} blocked={threadRequestBlocked(row, state)} draftOwner={owner}
      messageLinks={request.kind === 'question' ? messageLinks(thread.messages) : []}
      onWriteAnswer={() => answering.openAtRequest(thread.id, document.activeElement instanceof HTMLElement ? document.activeElement : null)}
      onSubmit={threadRequestSubmit(command, thread, request, true)}
      onCheck={() => answering.check(thread.id)} />
  </section>
}

/**
 * The thread's last reply before it asked, folded: what the pane holds of its history when it holds it, else the
 * excerpt its row keeps, which says so when it was cut short. Escape folds it again and puts focus back on its toggle,
 * whose name says whose reply it unfolds, since several cards may wait at once. Nothing when there is no reply.
 */
function WhatItSaid({ row }: { readonly row: ThreadRow }): ReactNode {
  const [open, setOpen] = useState(false)
  const toggle = useRef<HTMLButtonElement>(null)
  const bodyId = useId()
  const thread = row.thread
  const held = thread.messages.findLast(message => message.role === 'assistant' && message.text.trim() !== '' && message.visual === undefined)?.text
  const text = held ?? thread.summary?.lastAssistant?.text
  if (text === undefined || text.trim() === '') return null
  const shortened = held === undefined && text.length >= AGENT_THREAD_EXCERPT_MAX
  return <div className="watcher-ask__said" onKeyDown={event => {
    if (!open || event.key !== 'Escape' || event.nativeEvent.isComposing) return
    event.preventDefault(); event.stopPropagation(); setOpen(false); toggle.current?.focus()
  }}>
    <button ref={toggle} type="button" className="watcher-ask__toggle tt-focusable" aria-expanded={open} aria-controls={open ? bodyId : undefined}
      aria-label={`${open ? 'Hide' : 'Show'} what it said, ${thread.title}`} onClick={() => setOpen(value => !value)}>
      {open ? 'Hide what it said' : 'Show what it said'}{open ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
    </button>
    {open ? <div id={bodyId} className="watcher-ask__said-body" role="group" aria-label={`What ${thread.title} said last`}><MessageContent text={text} />
      {shortened ? <p className="watcher-ask__said-cut">Shortened here. Open the thread for the rest.</p> : null}</div> : null}
  </div>
}
