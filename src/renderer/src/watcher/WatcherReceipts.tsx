import React, { createContext, useContext, useId, useMemo, type ReactNode } from 'react'
import { CheckCheck, Laptop, Play, Send, Server, Square, type LucideIcon } from 'lucide-react'
import type { AgentMessage, ProviderId } from '../../../shared/agents'
import type { WatcherOperation, WatcherThreadTarget } from '../../../shared/watcher'
import { isShownReply, type WatcherTakeover } from '../../../shared/watcherRoom'
import type { WorkerPlacementReceipt } from '../../../shared/workerMachine'
import { SottoMark } from '../components/SottoMark'
import { ProviderMark } from '../agents/ProviderMark'
import { clockLabel } from '../agents/threadFacts'
import { WatcherAsks, type WatcherAskPlacement } from './WatcherAsks'

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
  readonly receipts: ReadonlyMap<string, readonly WatcherOperation[]>
  readonly takeovers: ReadonlyMap<string, readonly WatcherTakeover[]>
  /**
   * The requests each message's wake-up said waited on the user, answered on their cards here (answering in Watcher's
   * conversation). What the cards answer with comes from `WatcherAskAnsweringContext`, which changes with every update.
   */
  readonly asks?: ReadonlyMap<string, readonly WatcherAskPlacement[]> | undefined
  /** Where each start was placed, by operation ID (#1032): only while Work across machines is on, and only this run's. */
  readonly placements?: ReadonlyMap<string, WorkerPlacementReceipt> | undefined
  readonly describe: (target: WatcherThreadTarget) => ConversationThread
  /** A press on a thread's name: beside Watcher, or with Shift in the Threads room, as everywhere in the room. */
  readonly press: (threadId: string) => Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'onKeyDown'>
}
export const WatcherConversationContext = createContext<WatcherConversation | null>(null)

/**
 * The replies that carry receipt cards, which the transcript keeps in view rather than fold with the turn's work. Null
 * outside Watcher's own pane.
 */
export function useRepliesKeptInView(): ReadonlySet<string> | null {
  const conversation = useContext(WatcherConversationContext)
  const receipts = conversation?.receipts, asks = conversation?.asks
  return useMemo(() => receipts === undefined ? null : new Set([...receipts.keys(), ...asks?.keys() ?? []]), [receipts, asks])
}

/**
 * Where each takeover line goes: after the last reply of the Watcher turn it happened in, the turn begun by the last of
 * the user's messages before it, or after that message while the turn has no reply. A line from before every message
 * there is follows the first.
 */
export function placeTakeovers(messages: readonly AgentMessage[], takeovers: readonly WatcherTakeover[]): ReadonlyMap<string, readonly WatcherTakeover[]> {
  const placed = new Map<string, WatcherTakeover[]>()
  if (messages.length === 0) return placed
  for (const line of takeovers) {
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

const LEADS: Record<WatcherOperation['action'], { readonly done: string; readonly going: string; readonly failed: string; readonly icon: LucideIcon }> = {
  start: { done: 'Started', going: 'Starting', failed: 'Could not start', icon: Play },
  send: { done: 'Sent to', going: 'Sending to', failed: 'Could not send to', icon: Send },
  stop: { done: 'Stopped', going: 'Stopping', failed: 'Could not stop', icon: Square },
  settle: { done: 'Settled', going: 'Settling', failed: 'Could not settle', icon: CheckCheck },
}

/** The card's first words: what Watcher did, or is doing, or could not do, from its receipt alone. */
export function receiptLead(operation: Pick<WatcherOperation, 'action' | 'deliveryState'>): string {
  const lead = LEADS[operation.action]
  return operation.deliveryState === 'failed' ? lead.failed : operation.deliveryState === 'queued' || operation.deliveryState === 'dispatching' ? lead.going : lead.done
}

/**
 * Why a start went where it did, under its card (#1032): Sotto's own sentence when it placed the start itself, or that it
 * is not on the machine new workers start on, named (Zach, October 23, 2026); Watcher says why in its reply. Nothing when it went where it was meant to.
 */
export function placementLine(placement: WorkerPlacementReceipt | undefined): string | null {
  if (placement === undefined) return null
  if (placement.note !== undefined) return placement.note
  if (!placement.awayFromDefault) return null
  return placement.defaultName ? `Not your default, ${placement.defaultName}. Watcher says why in its reply.` : 'Not your default machine. Watcher says why in its reply.'
}

/**
 * One receipt card (Zach's pick on October 16, 2026, cards A): what Watcher did and to which thread, whose name opens it
 * beside Watcher; where that thread stands now; then its provider, its computer and its project. The name is a link only
 * here, from the receipt's own target, never found in anyone's words.
 */
function ReceiptCard({ operation, conversation }: { readonly operation: WatcherOperation; readonly conversation: WatcherConversation }): ReactNode {
  const facts = conversation.describe(operation.target)
  const metaId = useId()
  const statusId = useId()
  const Icon = LEADS[operation.action].icon
  const lead = receiptLead(operation)
  const title = facts.title ?? (operation.action === 'start' ? 'a new thread' : 'a thread no longer here')
  const unconfirmed = operation.deliveryState === 'uncertain'
  const placed = operation.action === 'start' ? placementLine(conversation.placements?.get(operation.id)) : null
  return <li className="receipt-card" data-receipt-id={operation.id} data-delivery={operation.deliveryState}>
    <div className="receipt-card__top">
      <Icon size={15} aria-hidden="true" className="receipt-card__glyph" />
      <span className="receipt-card__lead">{lead}</span>
      {facts.threadId === null ? <span className="receipt-card__name">{title}</span>
        : <button type="button" className="receipt-link tt-focusable" aria-label={`Open ${title} beside Watcher`} aria-describedby={facts.status === null ? metaId : `${statusId} ${metaId}`} title={title}
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
      {unconfirmed ? <span className="receipt-card__unconfirmed">Not confirmed yet</span> : null}
    </p>
    {placed !== null ? <p className="receipt-card__placement">{placed}</p> : null}
  </li>
}

/** The receipt cards under one message of Watcher's conversation, one per action, in the order Watcher took them. */
function WatcherReceipts({ operations, conversation }: { readonly operations: readonly WatcherOperation[]; readonly conversation: WatcherConversation }): ReactNode {
  return <ul className="watcher-receipts" aria-label="What Watcher did">
    {operations.map(operation => <ReceiptCard key={operation.id} operation={operation} conversation={conversation} />)}
  </ul>
}

/**
 * The takeover line (Zach's pick on October 16, 2026): Sotto's own quiet words in Watcher's conversation when the user
 * sent in a thread Watcher was driving, with the thread's name opening it beside Watcher, and when.
 */
function TakeoverLine({ line, conversation }: { readonly line: WatcherTakeover; readonly conversation: WatcherConversation }): ReactNode {
  const facts = conversation.describe(line.target)
  const title = facts.title ?? 'a thread no longer here'
  return <div className="sotto-line" data-takeover={`${line.target.hostId}:${line.target.threadId}`}>
    <span className="sotto-line__mark" role="img" aria-label="Sotto"><SottoMark className="sotto-line__glyph" /></span>
    <p>You took over {facts.threadId === null ? <span className="receipt-card__name">{title}</span>
      : <button type="button" className="receipt-link tt-focusable" aria-label={`Open ${title} beside Watcher`} title={title}
        {...conversation.press(facts.threadId)}>{title}</button>}. Watcher stopped sending to it.</p>
    <time dateTime={line.at}>{clockLabel(Date.parse(line.at))}</time>
  </div>
}

/**
 * What follows a message in Watcher's own pane: its receipt cards, then the cards of the requests its wake-up said wait
 * on the user, then any takeover line. Nothing anywhere else.
 */
export function WatcherAfterMessage({ message }: { readonly message: AgentMessage }): ReactNode {
  const conversation = useContext(WatcherConversationContext)
  if (conversation === null) return null
  const operations = conversation.receipts.get(message.id)
  const lines = conversation.takeovers.get(message.id)
  const asks = conversation.asks?.get(message.id)
  if (operations === undefined && lines === undefined && asks === undefined) return null
  return <>
    {operations?.length ? <WatcherReceipts operations={operations} conversation={conversation} /> : null}
    {asks?.length ? <WatcherAsks asks={asks} describe={conversation.describe} press={conversation.press} /> : null}
    {lines?.map(line => <TakeoverLine key={`${line.target.hostId}:${line.target.threadId}:${line.at}`} line={line} conversation={conversation} />)}
  </>
}
