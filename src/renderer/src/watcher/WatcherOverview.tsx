import React, { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react'
import { AppWindow, ChevronRight, Search } from 'lucide-react'
import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg, plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { AgentState } from '../../../shared/agents'
import { WATCHER_GROUPS, watcherOverview, type WatcherGroup, type WatcherOverviewRow } from '../../../shared/watcherOverview'
import { ProviderMark } from '../agents/ProviderMark'
import { RowTime } from '../agents/ThreadSidebar'
import { rowStatus, type ThreadRow } from '../agents/threadFacts'
import { usePageOpener } from '../agents/requests/AgentRequestCard'
import { watchedByWatcher, WatchedBadge } from './WatcherOwl'
import { WatchListToggle } from './WatchControls'
import { useWatchActions } from './watcherRoom'

/** How each group reads: the ring and the status word's tone. Labels say what Sotto knows, not what an agent claims. */
export const TONES: Record<WatcherGroup, string> = {
  'Needs you': 'needs', 'Ready for review': 'ready', Working: 'working', Landing: 'landing', Quiet: 'quiet', Idle: 'idle',
}

const GROUP_NAMES: Record<WatcherGroup, MessageDescriptor> = {
  'Needs you': msg({ message: 'Needs you', comment: 'A group of threads in Watcher’s room: they wait on the user' }),
  'Ready for review': msg({ message: 'Ready for review', comment: 'A group of threads in Watcher’s room' }),
  Working: msg({ message: 'Working', comment: 'A group of threads in Watcher’s room, and a thread’s status' }),
  Landing: msg({ message: 'Landing', comment: 'A group of threads in Watcher’s room, and a thread’s status: its work is being merged' }),
  Quiet: msg({ message: 'Quiet', comment: 'A group of threads in Watcher’s room, and a thread’s status: nothing has happened for a while' }),
  Idle: msg({ message: 'Idle', comment: 'A group of threads in Watcher’s room, and a thread’s status' }),
}

/** A group's name in the interface language; the group itself is the shared value code compares. */
export const groupName = (group: WatcherGroup): string => i18n._(GROUP_NAMES[group])

/** A group's name and how many threads it holds, for a screen reader. */
export const groupLabel = (group: WatcherGroup, count: number): string => {
  const name = groupName(group)
  return plural(count, { one: `${name}, # thread`, other: `${name}, # threads` })
}

export interface OverviewEntry { readonly overview: WatcherOverviewRow; readonly facts: ThreadRow }
export interface OverviewGroup { readonly group: WatcherGroup; readonly entries: readonly OverviewEntry[] }

/**
 * What a thread in Needs you waits on: a question, a permission, the user after a failed turn, or a prototype to review
 * (ADR-0108). A request outranks a failure, and a failure a prototype, as the Overview's own rule reads them.
 */
export type WaitKind = 'question' | 'permission' | 'failed' | 'prototype'
export function waitKind({ facts }: OverviewEntry): WaitKind {
  const request = facts.request ?? facts.thread.requests[0]
  if (request !== undefined) return request.kind
  const failed = facts.thread.status === 'error' || facts.thread.lastTurn?.status === 'failed'
  return !failed && facts.thread.prototypeReady !== undefined ? 'prototype' : 'failed'
}

/** How a press on a thread in the room opens it: beside Watcher, at its request, or in the Threads room. */
export interface OpenHow {
  /** At its question or permission card, or its failed turn, rather than at its title. */
  readonly atRequest?: boolean
  /** In the Threads room with the thread selected, rather than beside Watcher (Shift with the press). */
  readonly inThreads?: boolean
  /** What was pressed, for focus to go back to when the thread closes. */
  readonly from?: HTMLElement | null
}
export type OpenThread = (threadId: string, how: OpenHow) => void

/** Opens on a plain press beside Watcher and with Shift in the Threads room; Shift+Enter does the same from the keyboard. */
export function threadPress(open: OpenThread, threadId: string, atRequest: boolean): {
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
} {
  return {
    onClick: event => open(threadId, { atRequest, inThreads: event.shiftKey, from: event.currentTarget }),
    onKeyDown: event => {
      if (event.key !== 'Enter' || !event.shiftKey) return
      event.preventDefault()
      open(threadId, { atRequest, inThreads: true, from: event.currentTarget })
    },
  }
}

/**
 * Watcher's Overview: every other thread across the connected hosts, grouped by what the user must do, in the decided
 * order (ADR-0073), latest activity first within a group. It is a projection of the threads' own state, never a queue
 * of its own, and the current Watcher is not in it. `facts` are the room's own rows for the same state and clock.
 */
export function useOverview(state: AgentState | null, facts: readonly ThreadRow[], now: number, exclude: string | null): readonly OverviewGroup[] {
  return useMemo(() => {
    if (state === null) return []
    const byId = new Map(facts.map(row => [row.thread.id, row] as const))
    const entries = watcherOverview(state, now).filter(row => row.thread.id !== exclude)
      .map(overview => ({ overview, facts: byId.get(overview.thread.id)! })).filter(entry => entry.facts !== undefined)
    const recent = (entry: OverviewEntry): number => Number.isFinite(entry.facts.activityAt) ? entry.facts.activityAt : -Infinity
    return WATCHER_GROUPS.map(group => ({ group, entries: entries.filter(entry => entry.overview.group === group).sort((a, b) => recent(b) - recent(a)) }))
      .filter(group => group.entries.length > 0)
  }, [facts, state, now, exclude])
}

/** The words beside a row's project: what the thread waits on, its pull request, or the sidebar's own status. */
export function statusWord({ overview, facts }: OverviewEntry): string {
  const thread = overview.thread
  switch (overview.group) {
    case 'Needs you': return facts.state === 'needs' ? facts.stateLabel : waitKind({ overview, facts }) === 'prototype' ? i18n._(msg`Prototype to review`) : i18n._(msg`Last turn failed`)
    case 'Ready for review': {
      const open = thread.pullRequests?.find(pr => pr.state === 'open') ?? (thread.worktree?.git?.pullRequest?.state === 'open' ? thread.worktree.git.pullRequest : undefined)
      const number = open?.number ?? 0
      return open ? i18n._(msg`PR #${number} open`) : i18n._(msg`Pull request open`)
    }
    case 'Working': return facts.stateLabel
    case 'Landing':
    case 'Quiet': return groupName(overview.group)
    default: return rowStatus(facts).text
  }
}

/** The name of a press that opens a thread at what it waits on. */
export function openAtRequestLabel(title: string, kind: WaitKind): string {
  switch (kind) {
    case 'failed': return i18n._(msg`Open ${title} at its failed turn`)
    case 'prototype': return i18n._(msg`Open ${title} to review its prototype`)
    case 'question': return i18n._(msg`Open ${title} to answer its question`)
    case 'permission': return i18n._(msg`Open ${title} to answer its permission`)
  }
}

/**
 * Open the prototype, for a thread whose prototype waits for review (ADR-0108, variant A): opens its first page through
 * main by the thread and the page's token, as the strip above its composer does, and says so in plain words when the page
 * could not open. Nothing without a waiting prototype.
 */
export function OpenPrototype({ thread }: { readonly thread: OverviewEntry['facts']['thread'] }): ReactNode {
  const { t } = useLingui()
  const { open, failure } = usePageOpener({ threadId: thread.id })
  const page = thread.prototypeReady?.pages[0]
  if (page === undefined) return null
  const name = page.name
  return <>
    <button type="button" className="watcher-answer tt-focusable" aria-label={t`Open the prototype, ${name}`} title={name} onClick={() => open(page)}><Trans>Open the prototype</Trans></button>
    {failure === null ? null : <span className="watcher-row__failure" role="status">{failure}</span>}
  </>
}

/**
 * One thread in the list: its ring, title and clock; its provider, Watcher's owl when it watches it, its project and
 * host, and where it stands; and, when it waits on the user, what it asks with Open to answer. A press on the row opens
 * the thread beside Watcher; with Shift, in the Threads room. The owl at its end watches it, or stops, and is the row's
 * last stop (Zach's pick on October 13, 2026, watch B).
 */
function OverviewRow({ entry, watched, current, liveClock, onOpen }: {
  readonly entry: OverviewEntry; readonly watched: boolean; readonly current: boolean; readonly liveClock: boolean; readonly onOpen: OpenThread
}): ReactNode {
  const { t } = useLingui()
  const { overview, facts } = entry
  const thread = overview.thread
  const title = thread.title
  const tone = TONES[overview.group]
  const word = statusWord(entry)
  const describedBy = useId()
  const unavailable = overview.available ? '' : ` · ${facts.reconnecting ? t`Reconnecting` : t`Disconnected`}`
  const where = [facts.project?.title, thread.hostLabel].filter(Boolean).join(' · ')
  const needs = overview.group === 'Needs you'
  const kind = needs ? waitKind(entry) : null
  const asks = needs ? facts.request?.text.split('\n').find(line => line.trim() !== '')?.trim() ?? (kind === 'failed' ? t`Its last turn failed.` : kind === 'prototype' ? '' : undefined) : undefined
  return <li className="watcher-row" data-group={tone} data-current={current || undefined} data-unavailable={overview.available ? undefined : true}>
    <span className="watcher-row__ring" data-tone={facts.thread.status === 'error' || facts.thread.lastTurn?.status === 'failed' ? 'failed' : tone} aria-hidden="true" />
    <button type="button" className="watcher-row__open tt-focusable" aria-label={t`Open ${title} beside Watcher`} aria-describedby={describedBy} title={thread.title}
      aria-current={current || undefined} {...threadPress(onOpen, thread.id, false)}><span className="watcher-row__title">{thread.title}</span></button>
    <RowTime row={facts} live={liveClock} />
    <span className="watcher-row__meta" aria-hidden="true">
      <span className="watcher-row__marks">
        <span className="thread-nav__mark" data-provider={facts.providerId} title={[facts.provider, facts.model?.name].filter(Boolean).join(' · ')}><ProviderMark provider={facts.providerId} name={facts.provider} /></span>
        {watched ? <WatchedBadge size={14} /> : null}
      </span>
      {where ? <span className="watcher-row__where">{where}</span> : null}
      <span className="watcher-row__status" data-tone={tone}>{kind === 'prototype' ? <AppWindow size={12} aria-hidden="true" /> : null}{word}{unavailable}</span>
    </span>
    <span id={describedBy} className="tt-visually-hidden">{[facts.provider, where, `${word}${unavailable}`, watched ? watchedByWatcher() : ''].filter(Boolean).join(', ')}</span>
    {asks !== undefined && kind !== null ? <div className="watcher-row__asks">
      {asks === '' ? null : <span>{asks}</span>}
      {kind === 'prototype' ? <OpenPrototype thread={thread} />
        : <button type="button" className="watcher-answer tt-focusable" aria-label={openAtRequestLabel(thread.title, kind)} {...threadPress(onOpen, thread.id, true)}>
          {kind === 'failed' ? t({ message: 'Open', context: 'Open a thread' }) : t`Open to answer`}</button>}
    </div> : null}
    <WatchListToggle threadId={thread.id} title={thread.title} />
  </li>
}

/**
 * A group: its name and count, then its rows. Settled and archived threads stay reachable, folded at the end of Idle;
 * while the filter holds text, the fold shows what it matches, as the Threads sidebar's Settled shelf does.
 */
function OverviewGroupList({ group, entries, watched, besideId, liveClock, searching, onOpen }: {
  readonly group: WatcherGroup; readonly entries: readonly OverviewEntry[]; readonly watched: ReadonlySet<string>; readonly besideId: string | null
  readonly liveClock: boolean; readonly searching: boolean; readonly onOpen: OpenThread
}): ReactNode {
  const { t } = useLingui()
  const settledId = useId()
  const headingId = useId()
  const [settledOpen, setSettledOpen] = useState(false)
  const settledShown = settledOpen || searching
  const settled = group === 'Idle' ? entries.filter(entry => entry.facts.settledBy !== null) : []
  const shown = group === 'Idle' ? entries.filter(entry => entry.facts.settledBy === null) : entries
  const settledCount = settled.length
  const row = (entry: OverviewEntry): ReactNode => <OverviewRow key={entry.overview.thread.id} entry={entry} watched={watched.has(entry.overview.thread.id)}
    current={entry.overview.thread.id === besideId} liveClock={liveClock} onOpen={onOpen} />
  return <section className="watcher-group" data-tone={TONES[group]} aria-labelledby={headingId}>
    <h3 className="watcher-group__label" id={headingId} aria-label={groupLabel(group, entries.length)}>
      <span>{groupName(group)}</span><span className="watcher-group__count" aria-hidden="true">{entries.length}</span>
    </h3>
    {shown.length ? <ul className="watcher-group__rows">{shown.map(row)}</ul> : null}
    {settled.length ? <>
      <button type="button" className="watcher-group__settled tt-focusable" aria-expanded={settledShown} aria-controls={settledId}
        aria-label={plural(settledCount, { one: 'Settled, # thread', other: 'Settled, # threads' })} onClick={() => setSettledOpen(value => !value)}>
        <ChevronRight size={13} aria-hidden="true" className="watcher-group__chevron" /><span>{t({ message: 'Settled', comment: 'The fold of finished threads at the end of Idle' })}</span><span className="watcher-group__count" aria-hidden="true">{settled.length}</span>
      </button>
      {settledShown ? <ul className="watcher-group__rows" id={settledId}>{settled.map(row)}</ul> : null}
    </> : null}
  </section>
}

/** How many threads the Overview lists, settled ones included: the count on All threads. */
export function overviewCount(groups: readonly OverviewGroup[]): number {
  return groups.reduce((count, group) => count + group.entries.length, 0)
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * The Overview as a light list over the room, opened by All threads in Watcher's header (Zach's pick on October 11,
 * 2026: the room has no sidebar, and the list is there when asked for). It opens with focus in its filter, keeps Tab
 * inside itself, and closes on Escape, which returns focus to what opened it, or on a press outside it, which leaves
 * focus where that press put it. A thread opened from it closes it, and closing that thread returns focus there too.
 */
export function WatcherOverviewList({ groups, watched, besideId, liveClock, anchor, opener, onOpen, onClose }: {
  readonly groups: readonly OverviewGroup[]
  readonly watched: ReadonlySet<string>
  readonly besideId: string | null
  readonly liveClock: boolean
  /** All threads, which the list drops from. */
  readonly anchor: RefObject<HTMLButtonElement | null>
  /** What opened the list (All threads, or the needs-you line's count), for focus to go back to. */
  readonly opener: RefObject<HTMLElement | null>
  readonly onOpen: OpenThread
  /** `refocus` is true when focus should go back to what opened the list. */
  readonly onClose: (refocus: boolean) => void
}): ReactNode {
  const { t } = useLingui()
  const [query, setQuery] = useState('')
  const watching = useWatchActions() !== null
  const panel = useRef<HTMLDivElement>(null)
  const filter = useRef<HTMLInputElement>(null)
  const [place, setPlace] = useState<{ readonly top: number; readonly left: number } | null>(null)
  useLayoutEffect(() => {
    const button = anchor.current
    const room = button?.closest('.watcher-room')
    if (!button || !room) return
    const measure = (): void => {
      const at = button.getBoundingClientRect(), frame = room.getBoundingClientRect()
      const width = Math.min(380, frame.width - 16)
      setPlace({ top: at.bottom - frame.top + 6, left: Math.max(8, Math.min(at.left - frame.left - 4, frame.width - width - 8)) })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(room)
    return () => observer?.disconnect()
  }, [anchor])
  // Once placed: until then it is measured unseen, and an unseen field cannot take focus.
  const placed = place !== null
  useLayoutEffect(() => { if (placed) filter.current?.focus() }, [placed])
  const typed = query.trim()
  const needle = typed.toLocaleLowerCase()
  const shown = needle === '' ? groups : groups.map(group => ({ group: group.group, entries: group.entries.filter(entry => entry.overview.thread.title.toLocaleLowerCase().includes(needle)) }))
    .filter(group => group.entries.length > 0)
  const open: OpenThread = (threadId, how) => { const from = opener.current; onClose(false); onOpen(threadId, { ...how, from }) }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onClose(true); return }
    if (event.key !== 'Tab') return
    const stops = [...panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []]
    if (stops.length === 0) return
    const index = stops.indexOf(document.activeElement as HTMLElement)
    const next = event.shiftKey ? (index <= 0 ? stops.length - 1 : index - 1) : (index === stops.length - 1 ? 0 : index + 1)
    event.preventDefault()
    stops[next]!.focus()
  }
  return <>
    <div className="watcher-list__scrim" onPointerDown={() => onClose(false)} aria-hidden="true" />
    <div ref={panel} className="watcher-list" role="dialog" aria-label={t`All threads`} onKeyDown={onKeyDown}
      style={place ? { top: place.top, left: place.left, maxHeight: `calc(100% - ${place.top}px - 62px)` } : { visibility: 'hidden' }}>
      <label className="watcher-list__filter">
        <Search size={14} aria-hidden="true" /><span className="tt-visually-hidden"><Trans>Filter threads</Trans></span>
        <input ref={filter} className="tt-focusable" type="search" value={query} placeholder={t`Filter threads`} autoComplete="off" onChange={event => setQuery(event.currentTarget.value)} />
      </label>
      <div className="watcher-list__scroll">
        {shown.map(({ group, entries }) => <OverviewGroupList key={group} group={group} entries={entries} watched={watched} besideId={besideId} liveClock={liveClock} searching={needle !== ''} onOpen={open} />)}
        {groups.length === 0 ? <p className="watcher-list__none"><Trans>No other threads yet. Threads you or Watcher start show here.</Trans></p>
          : shown.length === 0 ? <p className="watcher-list__none"><Trans>No thread matches “{typed}”.</Trans></p> : null}
      </div>
      <p className="watcher-list__foot">{watching ? <><Trans>The owl watches a thread until you press it again.</Trans>{' '}</> : null}<Trans>Shift-click opens a thread in Threads. <kbd>Esc</kbd> closes.</Trans></p>
    </div>
  </>
}
