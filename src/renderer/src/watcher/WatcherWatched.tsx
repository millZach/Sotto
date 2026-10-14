import React, { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import type { AgentState } from '../../../shared/agents'
import type { WatcherThreadTarget } from '../../../shared/watcher'
import { WATCHER_GROUPS, type WatcherGroup } from '../../../shared/watcherOverview'
import type { WatcherRoomState } from '../../../shared/watcherRoom'
import { ProviderMark } from '../agents/ProviderMark'
import { clockLabel } from '../agents/threadFacts'
import { openAtRequestLabel, statusWord, threadPress, TONES, waitKind, type OpenThread, type OverviewEntry, type OverviewGroup } from './WatcherOverview'
import { hasStandingWatch, threadForTarget, useWatchActions, watchedRows, type WatcherRoom } from './watcherRoom'
import { WATCHED_BY_WATCHER, WatchedBadge, WatcherOwl } from './WatcherOwl'

type WatchedRow = WatcherRoomState['watchedThreads'][number]
const same = (a: WatcherThreadTarget, b: WatcherThreadTarget): boolean => a.hostId === b.hostId && a.threadId === b.threadId
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

/** How many threads Watcher watches: the count on the Watched tab. */
export function watchedCount(room: WatcherRoom | null): number {
  return room?.state == null ? 0 : watchedRows(room.state).length
}

/** One watched thread as the view draws it: the room's row, and the window's own facts when the window lists it. */
interface WatchedCard {
  readonly row: WatchedRow
  readonly threadId: string | null
  readonly entry: OverviewEntry | undefined
  readonly group: WatcherGroup
}

const VERB: Record<WatcherRoomState['receipts'][number]['action'], string> = { start: 'started it', send: 'sent to it', stop: 'stopped it', settle: 'settled it' }

/**
 * What Watcher last did with a watched thread, from Sotto's own records and never from anyone's words: waiting while
 * the user's own turn runs, its latest action and how it went, or how long it has watched with nothing sent.
 */
export function watchedDoing(row: WatchedRow, room: WatcherRoomState): string | null {
  if (row.paused === true) return 'You sent here yourself. Watcher waits until that turn ends.'
  const last = room.receipts.filter(receipt => same(receipt.target, row.target)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]
  if (last !== undefined) {
    const at = clockLabel(Date.parse(last.updatedAt))
    switch (last.deliveryState) {
      case 'accepted': return `Watcher ${last.action === 'send' ? 'last sent to it' : VERB[last.action]} at ${at}.`
      case 'failed': return `Watcher’s last try at ${at} did not reach it.`
      case 'uncertain': return `Watcher’s last try at ${at} is not confirmed.`
      default: return 'Watcher is sending to it now.'
    }
  }
  const watch = room.standingWatches?.find(item => same(item.target, row.target))
  return watch === undefined ? null : `Watching since ${clockLabel(Date.parse(watch.createdAt))}. Nothing sent yet.`
}

/**
 * The line over the cards. A thread under a standing watch stays watched until the user stops it; one watched only for
 * a Watcher request stops when the user sends there, so the line promises only what holds for each.
 */
export function watchedLead(count: number, standing: number): string {
  if (count === 0) return 'Watcher watches no threads yet. Press the owl on a thread, here in All threads or on Threads, and Watcher keeps it going until you stop it.'
  const keeps = count === 1 ? 'Watcher keeps this thread going on its own and brings you its questions and permissions.'
    : `Watcher keeps these ${count} threads going on its own and brings you their questions and permissions.`
  if (standing === count) return `${keeps} ${count === 1 ? 'It stays' : 'Each stays'} watched until you stop it.`
  if (standing === 0) return `${keeps} ${count === 1 ? 'It is' : 'They are'} watched for a request: if you send to ${count === 1 ? 'it' : 'one'} yourself, Watcher stops sending to it.`
  return `${keeps} A thread you watch stays watched until you stop it. One watched for a request stops when you send to it yourself.`
}

/** A watched thread this window does not list (its host is out of reach): its status as the room last saw it. */
function unlistedStatus(row: WatchedRow): string {
  if (!row.connected || row.status === 'unavailable') return 'Can’t reach it'
  return row.status === 'running' ? 'Working' : row.status === 'error' ? 'Last turn failed' : 'Idle'
}

function Card({ card, room, onOpen, onStopping }: { readonly card: WatchedCard; readonly room: WatcherRoomState; readonly onOpen: OpenThread
  /** Stop watching was pressed on this card, which goes with it. */
  readonly onStopping: (control: HTMLElement) => void }): ReactNode {
  const actions = useWatchActions()
  const describedBy = useId()
  const { row, threadId, entry, group } = card
  const title = entry?.overview.thread.title ?? row.title
  const tone = TONES[group]
  const word = entry === undefined ? unlistedStatus(row) : statusWord(entry)
  const where = entry === undefined ? '' : [entry.facts.project?.title, entry.overview.thread.hostLabel].filter(Boolean).join(' · ')
  const kind = entry !== undefined && group === 'Needs you' ? waitKind(entry) : null
  const doing = watchedDoing(row, room)
  const failed = entry?.facts.thread.status === 'error' || entry?.facts.thread.lastTurn?.status === 'failed'
  return <li className="watched-card" data-tone={tone} data-unlisted={threadId === null || undefined}>
    <span className="watcher-row__ring" data-tone={failed ? 'failed' : tone} aria-hidden="true" />
    {threadId === null ? <span className="watched-card__title">{title}</span>
      : <button type="button" className="watched-card__title watched-card__open tt-focusable" aria-label={`Open ${title} beside Watcher`} aria-describedby={describedBy} title={title}
        {...threadPress(onOpen, threadId, false)}><span>{title}</span></button>}
    <span className="watched-card__actions">
      {kind !== null && threadId !== null ? <button type="button" className="watcher-answer tt-focusable" aria-label={openAtRequestLabel(title, kind)} {...threadPress(onOpen, threadId, true)}>
        {kind === 'failed' ? 'Open' : 'Open to answer'}</button> : null}
      {actions === null ? null : <button type="button" className="watched-card__stop tt-focusable" aria-label={`Stop watching ${title}`}
        onClick={event => { onStopping(event.currentTarget); void actions.set(row.target, title, false) }}>Stop watching</button>}
    </span>
    <span className="watched-card__meta" aria-hidden="true">
      {entry === undefined ? <WatchedBadge size={13} /> : <span className="watcher-row__marks">
        <span className="thread-nav__mark" data-provider={entry.facts.providerId}><ProviderMark provider={entry.facts.providerId} name={entry.facts.provider} /></span>
        <WatchedBadge size={13} /><span className="watched-card__provider">{entry.facts.provider}</span>
      </span>}
      {where ? <span className="watched-card__where">{where}</span> : null}
      <span className="watcher-row__status" data-tone={tone}>{word}</span>
    </span>
    {doing === null ? null : <p className="watched-card__doing">{doing}</p>}
    <span id={describedBy} className="tt-visually-hidden">{[entry?.facts.provider, where, word, WATCHED_BY_WATCHER, doing].filter(Boolean).join(', ')}</span>
  </li>
}

/**
 * The threads Watcher watches, in place of its conversation when Watched is chosen (Zach's pick on October 13, 2026,
 * watch B, after the phone's Watched tab): a card for each, grouped by what the user must do as the Overview groups
 * them, with what Watcher last did, Open to answer where one waits, and Stop watching. Watch a thread opens All threads,
 * where the owl on a row watches it. A watched thread this window does not list still has its card, so it can be stopped.
 */
export function WatcherWatchedView({ room, state, groups, labelledBy, id, onOpen, onShowAll }: {
  readonly room: WatcherRoom
  readonly state: AgentState
  readonly groups: readonly OverviewGroup[]
  /** The Watched tab, which names this panel. */
  readonly labelledBy: string
  readonly id: string
  readonly onOpen: OpenThread
  /** Opens All threads; `from` is what was pressed, for focus to come back to. */
  readonly onShowAll: (from: HTMLElement) => void
}): ReactNode {
  const actions = useWatchActions()
  const projection = room.state
  const entries = new Map(groups.flatMap(group => group.entries).map(entry => [entry.overview.thread.id, entry] as const))
  const cards: WatchedCard[] = projection === null ? [] : watchedRows(projection).map(row => {
    const threadId = threadForTarget(state, row.target)?.id ?? null
    const entry = threadId === null ? undefined : entries.get(threadId)
    return { row, threadId: entry === undefined ? null : threadId, entry, group: entry?.overview.group ?? 'Idle' }
  })
  const lead = projection === null ? watchedLead(0, 0) : watchedLead(cards.length, cards.filter(card => hasStandingWatch(projection, card.row.target)).length)
  // Stop watching takes its card away with the button. The keyboard goes on to the next card's Stop watching, or the
  // one before it, then Watch a thread, then the panel itself, unless it went somewhere else meanwhile.
  const panel = useRef<HTMLDivElement>(null)
  const stopping = useRef<{ readonly control: HTMLElement; readonly next: HTMLElement | null } | null>(null)
  const cardKeys = cards.map(card => `${card.row.target.hostId}:${card.row.target.threadId}`).join('|')
  useLayoutEffect(() => {
    const press = stopping.current
    if (press === null || press.control.isConnected) return
    stopping.current = null
    const active = document.activeElement
    if (active !== null && active !== document.body) return
    const next = press.next?.isConnected ? press.next : panel.current?.querySelector<HTMLElement>('.watched-card__stop, .watcher-watched__add') ?? panel.current
    next?.focus()
  }, [cardKeys])
  const onStopping = (control: HTMLElement): void => {
    const stops = [...panel.current?.querySelectorAll<HTMLElement>('.watched-card__stop') ?? []]
    const at = stops.indexOf(control)
    stopping.current = { control, next: stops[at + 1] ?? stops[at - 1] ?? null }
  }
  return <div ref={panel} id={id} className="thread-workspace__transcript watcher-watched" role="tabpanel" aria-labelledby={labelledBy} tabIndex={0}>
    <div className="watcher-watched__lead">
      <p>{lead}</p>
      {actions === null ? null : <button type="button" className="watcher-watched__add tt-focusable" aria-haspopup="dialog" onClick={event => onShowAll(event.currentTarget)}>
        <WatcherOwl size={14} />Watch a thread</button>}
    </div>
    {projection === null ? null : WATCHER_GROUPS.map(group => {
      const shown = cards.filter(card => card.group === group)
      if (shown.length === 0) return null
      return <section key={group} className="watcher-watched__group" data-tone={TONES[group]} aria-label={`${group}, ${plural(shown.length, 'thread')}`}>
        <h3 className="watcher-watched__label" aria-hidden="true"><span>{group}</span><span className="watcher-group__count">{shown.length}</span></h3>
        <ul className="watcher-watched__cards">{shown.map(card => <Card key={`${card.row.target.hostId}:${card.row.target.threadId}`} card={card} room={projection} onOpen={onOpen} onStopping={onStopping} />)}</ul>
      </section>
    })}
  </div>
}
