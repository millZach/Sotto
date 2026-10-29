import React, { createContext, useContext, useId, useMemo, type ReactNode } from 'react'
import { CheckCheck, Laptop, Play, Send, Server, Square, type LucideIcon } from 'lucide-react'
import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { AgentMessage, ProviderId } from '../../../shared/agents'
import type { WatcherOperation, WatcherThreadTarget } from '../../../shared/watcher'
import { isShownReply, type WatcherTakeover } from '../../../shared/watcherRoom'
import type { ThreadMoveCard } from '../../../shared/threadMoves'
import type { WorkerPlacementReceipt } from '../../../shared/workerMachine'
import { SottoMark } from '../components/SottoMark'
import { ProviderMark } from '../agents/ProviderMark'
import { clockLabel } from '../agents/threadFacts'
import { WatcherAsks, type WatcherAskPlacement } from './WatcherAsks'
import { WatcherMoveCards } from './MoveThreads'
import type { ByMessage, ByOperation } from './watcherConversationWork'
import { t } from '@lingui/core/macro'

/** A thread as a receipt card or a takeover line names it: what the window knows of it now. */
export interface ConversationThread {
  /** This window's ID for the thread, or null when the window does not list it, and its name is then not a link. */
  readonly threadId: string | null
  /** Its title, or null when nothing names it: a start that never made its thread. */
  readonly title: string | null
  readonly providerId: ProviderId | undefined
  readonly provider: string | undefined
  /** "This computer", or the paired host's name. */
  readonly computer: string | undefined
  readonly remote: boolean
  readonly project: string | undefined
  /** Where it stands now, as All threads words it, and that word's tone and ring; null when unknown. */
  readonly status: string | null
  readonly tone: string
  readonly ring: string
}

/**
 * What Watcher's own pane adds to its conversation (ADR-0073): the receipt cards under each reply, by the message they
 * go under, the takeover lines after the message they follow, and the cards of the requests its wake-ups said waited on
 * the user, by the message they go under. Only Watcher's pane provides it.
 */
export interface WatcherConversation {
  readonly receipts: ByMessage<WatcherOperation>
  readonly takeovers: ByMessage<WatcherTakeover>
  /**
   * The requests each message's wake-up said waited on the user, answered on their cards here (answering in Watcher's
   * conversation). What the cards answer with comes from `WatcherAskAnsweringContext`, which changes with every update.
   */
  readonly asks?: ReadonlyMap<string, readonly WatcherAskPlacement[]> | undefined
  /**
   * The moves Sotto ran for the user (#1178), after the turn each was confirmed in: only while Work across machines is on.
   */
  readonly moves?: ReadonlyMap<string, readonly ThreadMoveCard[]> | undefined
  /** Where each start was placed, by operation ID (#1032): only while Work across machines is on, and only this run's. */
  readonly placements?: ByOperation<WorkerPlacementReceipt> | undefined
  readonly describe: (target: WatcherThreadTarget) => ConversationThread
  /** A press on a thread's name: beside Watcher, or with Shift in the Threads room, as everywhere in the room. */
  readonly press: (threadId: string) => Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'onKeyDown'>
}
export const WatcherConversationContext = createContext<WatcherConversation | null>(null)

/**
 * The replies that carry receipt cards, which the transcript keeps in view rather than fold with the turn's work. Null
 * outside Watcher's own pane.
 */
export function useRepliesKeptInView(): Pick<ReadonlySet<string>, 'has'> | null {
  const conversation = useContext(WatcherConversationContext)
  const receipts = conversation?.receipts, asks = conversation?.asks
  // A look-up rather than a set of every reply: a conversation shown far back holds the read back's cards too (#1759).
  return useMemo(() => receipts === undefined ? null : { has: (id: string) => receipts.has(id) || asks?.has(id) === true }, [receipts, asks])
}

/**
 * Where each takeover line goes: after the last reply of the Watcher turn it happened in, the turn begun by the last of
 * the user's messages before it, or after that message while the turn has no reply. A line from before every message
 * there is follows the first.
 */
export function placeTakeovers(messages: readonly AgentMessage[], takeovers: readonly WatcherTakeover[]): ReadonlyMap<string, readonly WatcherTakeover[]> {
  return placeAfterTurns(messages, takeovers)
}
/** Places anything of Sotto's own that happened at a time, `at`, after the turn it happened in, as takeover lines are. */
export function placeAfterTurns<Item extends { readonly at: string }>(messages: readonly AgentMessage[], items: readonly Item[]): ReadonlyMap<string, readonly Item[]> {
  const placed = new Map<string, Item[]>()
  if (messages.length === 0) return placed
  for (const line of items) {
    const at = Date.parse(line.at)
    const user = messages.findLastIndex(message => message.role === 'user' && Date.parse(message.createdAt) <= at)
    let anchor = messages[Math.max(0, user)]!.id
    if (user >= 0) for (let index = user + 1; index < messages.length && messages[index]!.role !== 'user'; index++) {
      if (isShownReply(messages[index]!)) anchor = messages[index]!.id
    }
    placed.set(anchor, [...placed.get(anchor) ?? [], line])
  }
  return placed
}

// Each lead comes before the thread's name on a receipt card, in its own place: "Sent to", then the name.
const LEADS: Record<WatcherOperation['action'], { readonly done: MessageDescriptor; readonly going: MessageDescriptor; readonly failed: MessageDescriptor; readonly icon: LucideIcon }> = {
  start: { done: msg({ message: 'Started', comment: 'Before a thread’s name on a receipt card' }), going: msg({ message: 'Starting', comment: 'Before a thread’s name on a receipt card' }), failed: msg({ message: 'Could not start', comment: 'Before a thread’s name on a receipt card' }), icon: Play },
  send: { done: msg({ message: 'Sent to', comment: 'Before a thread’s name on a receipt card' }), going: msg({ message: 'Sending to', comment: 'Before a thread’s name on a receipt card' }), failed: msg({ message: 'Could not send to', comment: 'Before a thread’s name on a receipt card' }), icon: Send },
  stop: { done: msg({ message: 'Stopped', comment: 'Before a thread’s name on a receipt card' }), going: msg({ message: 'Stopping', comment: 'Before a thread’s name on a receipt card' }), failed: msg({ message: 'Could not stop', comment: 'Before a thread’s name on a receipt card' }), icon: Square },
  settle: { done: msg({ message: 'Settled', comment: 'Before a thread’s name on a receipt card' }), going: msg({ message: 'Settling', comment: 'Before a thread’s name on a receipt card' }), failed: msg({ message: 'Could not settle', comment: 'Before a thread’s name on a receipt card' }), icon: CheckCheck },
}

/** The card's first words: what Watcher did, or is doing, or could not do, from its receipt alone. */
export function receiptLead(operation: Pick<WatcherOperation, 'action' | 'deliveryState'>): string {
  const lead = LEADS[operation.action]
  return i18n._(operation.deliveryState === 'failed' ? lead.failed : operation.deliveryState === 'queued' || operation.deliveryState === 'dispatching' ? lead.going : lead.done)
}

/**
 * Why a start went where it did, under its card (#1032): Sotto's own sentence when it placed the start itself, or that it
 * is not on the machine new workers start on, named (Zach, October 23, 2026); Watcher says why in its reply. Nothing when it went where it was meant to.
 */
export function placementLine(placement: WorkerPlacementReceipt | undefined): string | null {
  if (placement === undefined) return null
  // Sotto's own note is written where the start is placed and goes to Watcher as well, so it stays in English (ADR-0123).
  if (placement.note !== undefined) return placement.note
  if (!placement.awayFromDefault) return null
  const name = placement.defaultName
  return name ? t`Not your default, ${name}. Watcher says why in its reply.` : t`Not your default machine. Watcher says why in its reply.`
}

/**
 * One receipt card (Zach's pick on October 16, 2026, cards A): what Watcher did and to which thread, whose name opens it
 * beside Watcher; where that thread stands now; then its provider, its computer and its project. The name is a link only
 * here, from the receipt's own target, never found in anyone's words.
 */
function ReceiptCard({ operation, conversation }: { readonly operation: WatcherOperation; readonly conversation: WatcherConversation }): ReactNode {
  const { t } = useLingui()
  const facts = conversation.describe(operation.target)
  const metaId = useId()
  const statusId = useId()
  const Icon = LEADS[operation.action].icon
  const lead = receiptLead(operation)
  const title = facts.title ?? (operation.action === 'start' ? t`a new thread` : t`a thread no longer here`)
  const unconfirmed = operation.deliveryState === 'uncertain'
  const placed = operation.action === 'start' ? placementLine(conversation.placements?.get(operation.id)) : null
  return <li className="receipt-card" data-receipt-id={operation.id} data-delivery={operation.deliveryState}>
    <div className="receipt-card__top">
      <Icon size={15} aria-hidden="true" className="receipt-card__glyph" />
      <span className="receipt-card__lead">{lead}</span>
      {facts.threadId === null ? <span className="receipt-card__name">{title}</span>
        : <button type="button" className="receipt-link tt-focusable" aria-label={t`Open ${title} beside Watcher`} aria-describedby={facts.status === null ? metaId : `${statusId} ${metaId}`} title={title}
          {...conversation.press(facts.threadId)}>{title}</button>}
      {facts.status === null ? null : <span className="receipt-outcome" id={statusId} data-tone={facts.tone}>
        <span className="watcher-row__ring" data-tone={facts.ring} aria-hidden="true" /><span className="receipt-outcome__word">{facts.status}</span>
      </span>}
    </div>
    <p className="receipt-card__meta" id={metaId}>
      {facts.provider === undefined ? null : <span className="receipt-card__provider">
        {facts.providerId === undefined ? null : <span className="thread-nav__mark" data-provider={facts.providerId} aria-hidden="true"><ProviderMark provider={facts.providerId} name={facts.provider} /></span>}
        {facts.provider}</span>}
      {facts.computer === undefined ? null : <span className="receipt-card__machine" data-kind={facts.remote ? 'remote' : 'local'}>
        {facts.remote ? <Server size={12} aria-hidden="true" /> : <Laptop size={12} aria-hidden="true" />}{facts.computer}</span>}
      {facts.project === undefined ? null : <span className="receipt-card__project">{facts.project}</span>}
      {unconfirmed ? <span className="receipt-card__unconfirmed"><Trans>Not confirmed yet</Trans></span> : null}
    </p>
    {placed !== null ? <p className="receipt-card__placement tt-paragraph">{placed}</p> : null}
  </li>
}

/** The receipt cards under one message of Watcher's conversation, one per action, in the order Watcher took them. */
function WatcherReceipts({ operations, conversation }: { readonly operations: readonly WatcherOperation[]; readonly conversation: WatcherConversation }): ReactNode {
  const { t } = useLingui()
  return <ul className="watcher-receipts" aria-label={t`What Watcher did`}>
    {operations.map(operation => <ReceiptCard key={operation.id} operation={operation} conversation={conversation} />)}
  </ul>
}

/**
 * The takeover line (Zach's pick on October 16, 2026): Sotto's own quiet words in Watcher's conversation when the user
 * sent in a thread Watcher was driving, with the thread's name opening it beside Watcher, and when.
 */
function TakeoverLine({ line, conversation }: { readonly line: WatcherTakeover; readonly conversation: WatcherConversation }): ReactNode {
  const { t } = useLingui()
  const facts = conversation.describe(line.target)
  const title = facts.title ?? t`a thread no longer here`
  const thread = facts.threadId === null ? <span className="receipt-card__name">{title}</span>
    : <button type="button" className="receipt-link tt-focusable" aria-label={t`Open ${title} beside Watcher`} title={title}
      {...conversation.press(facts.threadId)}>{title}</button>
  return <div className="sotto-line" data-takeover={`${line.target.hostId}:${line.target.threadId}`}>
    <span className="sotto-line__mark" role="img" aria-label="Sotto"><SottoMark className="sotto-line__glyph" /></span>
    <p className="tt-paragraph"><Trans>You took over {thread}. Watcher stopped sending to it.</Trans></p>
    <time dateTime={line.at}>{clockLabel(Date.parse(line.at))}</time>
  </div>
}

/**
 * What follows a message in Watcher's own pane: its receipt cards, then the cards of the requests its wake-up said wait
 * on the user, then any takeover line, then the moves confirmed in its turn. Nothing anywhere else.
 */
export function WatcherAfterMessage({ message }: { readonly message: AgentMessage }): ReactNode {
  const conversation = useContext(WatcherConversationContext)
  if (conversation === null) return null
  const operations = conversation.receipts.get(message.id)
  const lines = conversation.takeovers.get(message.id)
  const asks = conversation.asks?.get(message.id)
  const moves = conversation.moves?.get(message.id)
  if (operations === undefined && lines === undefined && asks === undefined && moves === undefined) return null
  return <>
    {operations?.length ? <WatcherReceipts operations={operations} conversation={conversation} /> : null}
    {asks?.length ? <WatcherAsks asks={asks} describe={conversation.describe} press={conversation.press} /> : null}
    {lines?.map(line => <TakeoverLine key={`${line.target.hostId}:${line.target.threadId}:${line.at}`} line={line} conversation={conversation} />)}
    {moves?.length ? <WatcherMoveCards cards={moves} threads={conversation} /> : null}
  </>
}
