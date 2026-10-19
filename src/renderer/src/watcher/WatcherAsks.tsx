import React, { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, Laptop, Server } from 'lucide-react'
import type { AgentRequest, AgentState } from '../../../shared/agents'
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
import { EMPTY_SELECTION, requestAnswerOwnerKey, requestAnswerStore, requestMode, textOnly, type RequestAnswer, type RequestEntry } from '../agents/requests/requestAnswers'
import { threadRequestBlocked, threadRequestOwner } from '../agents/requests/threadRequests'
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

/** The words a receipt uses for an answer written in the user's own words, which Sotto never repeats. */
export const OWN_WORDS = 'in your own words'
const plainLabel = (label: string): string => label.replace(/\s*\(recommended\)\s*$/iu, '')

/**
 * What the user chose on a request's card, in the card's own words: the permission choice, or the option labels, or
 * that they wrote their own answer. Never their text. Null when the card offered nothing it could name, such as a plain
 * question answered in the composer.
 */
export function chosenWords(request: AgentRequest, entry: Pick<RequestEntry, 'choice' | 'selections'>): string | null {
  const mode = requestMode(request)
  if (mode === 'permission') {
    if (entry.choice === null) return null
    const choices = request.permissionChoices
    if (choices) return choices.find(choice => choice.id === entry.choice)?.label ?? null
    return entry.choice === 'allow' ? 'Allow' : entry.choice === 'deny' ? 'Deny' : null
  }
  if (mode === 'legacy-options') {
    const picked = entry.selections[request.id]?.optionIds[0] ?? entry.choice
    const option = request.options.find(item => item.id === picked)
    return option === undefined ? null : plainLabel(option.label)
  }
  if (mode !== 'structured') return null
  const labels: string[] = []
  let own = false
  for (const question of request.questions ?? []) {
    const selection = entry.selections[question.id]
    if (selection === undefined) continue
    for (const id of selection.optionIds) {
      const option = question.options.find(item => item.id === id)
      if (option !== undefined) labels.push(plainLabel(option.label))
    }
    if ((selection.other || textOnly(question)) && selection.text.trim() !== '') own = true
  }
  if (labels.length === 0) return own ? OWN_WORDS : null
  return own ? `${labels.join(', ')}, and ${OWN_WORDS}` : labels.join(', ')
}

/** The same words for an answer as it is sent: what the card's choice or selections were, read back from the answer itself. */
export function answerWords(request: AgentRequest, answer: RequestAnswer): string | null {
  const mode = requestMode(request)
  if (mode === 'permission') return chosenWords(request, { choice: answer.permissionChoice ?? (answer.approved === true ? 'allow' : answer.approved === false ? 'deny' : null), selections: {} })
  if (mode === 'legacy-options') return chosenWords(request, { choice: answer.answer, selections: {} })
  const selections = Object.fromEntries(Object.entries(answer.questionAnswers ?? {}).map(([id, given]) =>
    [id, { ...EMPTY_SELECTION, optionIds: given.optionIds, other: (given.text ?? '').trim() !== '', text: given.text ?? '' }]))
  return chosenWords(request, { choice: null, selections })
}

const ANSWERED_KEPT = 200
/**
 * What this window sent for each request it answered, by thread and request, in the card's own words, and whether
 * main took the answer. Held in memory for this window's life alone; nothing is saved. A request answered anywhere
 * else, or before a restart, is not here, and its receipt then says only that it no longer waits.
 */
class AnsweredChoices {
  private readonly entries = new Map<string, { readonly words: string | null; readonly sent: boolean }>()
  private readonly listeners = new Set<() => void>()
  private static key(threadId: string, requestId: string): string { return JSON.stringify([threadId, requestId]) }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  note(threadId: string, requestId: string, words: string | null, sent: boolean): void {
    const key = AnsweredChoices.key(threadId, requestId)
    const before = this.entries.get(key)
    const next = { words: words ?? before?.words ?? null, sent: sent || before?.sent === true }
    if (before !== undefined && before.words === next.words && before.sent === next.sent) return
    this.entries.delete(key)
    this.entries.set(key, next)
    while (this.entries.size > ANSWERED_KEPT) this.entries.delete(this.entries.keys().next().value!)
    for (const listener of [...this.listeners]) listener()
  }
  /** The words of an answer main took from this window; null when this window did not send one. */
  sent(threadId: string, requestId: string): string | null | undefined {
    const entry = this.entries.get(AnsweredChoices.key(threadId, requestId))
    return entry?.sent ? entry.words : undefined
  }
  clear(): void { this.entries.clear() }
}
export const answeredChoices = new AnsweredChoices()

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
export function WatcherAsks({ asks, describe, answering, press }: {
  readonly asks: readonly WatcherAskPlacement[]
  readonly describe: (target: WatcherThreadTarget) => ConversationThread
  readonly answering: WatcherAskAnswering
  readonly press: (threadId: string) => Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'onKeyDown'>
}): ReactNode {
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
  return <p className="watcher-ask-receipt" data-ask-request={ask.requestCardId}>
    <span className="watcher-ask-receipt__words">{row === undefined
      ? `Sotto cannot see ${title} right now, so it cannot say whether it still waits on you.`
      : receiptWords(title, sent)}</span>
    {row === undefined ? null : <button type="button" className="watcher-ask__open tt-focusable" aria-label={`Open ${title} beside Watcher`} title={`Open ${title} beside Watcher`}
      {...press(row.thread.id)}>Open</button>}
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
  // What was chosen is kept while the request is still here to name it, so the line that replaces the card can say it.
  useEffect(() => {
    if (entry.phase === 'sending' || entry.phase === 'sent') answeredChoices.note(thread.id, request.id, chosenWords(request, entry), entry.phase === 'sent')
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
      onSubmit={answer => command({ type: 'answer', threadId: thread.id, requestId: request.id, ...answer }).then(result => {
        // Main took it: the line that replaces the card can say what was chosen, even when the request left first.
        if (result !== null && result.error === null) answeredChoices.note(thread.id, request.id, answerWords(request, answer), true)
        return result === null ? null : { error: result.error }
      })}
      onCheck={() => answering.check(thread.id)} />
  </section>
}

/**
 * The thread's last reply before it asked, folded: what the pane holds of its history when it holds it, else the
 * excerpt its row keeps. Escape folds it again and puts focus back on its toggle. Nothing when there is no reply.
 */
function WhatItSaid({ row }: { readonly row: ThreadRow }): ReactNode {
  const [open, setOpen] = useState(false)
  const toggle = useRef<HTMLButtonElement>(null)
  const bodyId = useId()
  const thread = row.thread
  const text = thread.messages.findLast(message => message.role === 'assistant' && message.text.trim() !== '' && message.visual === undefined)?.text
    ?? thread.summary?.lastAssistant?.text
  if (text === undefined || text.trim() === '') return null
  return <div className="watcher-ask__said" onKeyDown={event => {
    if (!open || event.key !== 'Escape' || event.nativeEvent.isComposing) return
    event.preventDefault(); event.stopPropagation(); setOpen(false); toggle.current?.focus()
  }}>
    <button ref={toggle} type="button" className="watcher-ask__toggle tt-focusable" aria-expanded={open} aria-controls={open ? bodyId : undefined}
      onClick={() => setOpen(value => !value)}>
      {open ? 'Hide what it said' : 'Show what it said'}{open ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
    </button>
    {open ? <div id={bodyId} className="watcher-ask__said-body" role="group" aria-label={`What ${thread.title} said last`}><MessageContent text={text} /></div> : null}
  </div>
}
