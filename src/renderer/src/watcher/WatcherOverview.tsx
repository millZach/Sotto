import React, { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react'
import { CheckCheck, ChevronRight, Search } from 'lucide-react'
import type { AgentState } from '../../../shared/agents'
import type { WatcherReadMarkKind } from '../../../shared/watcher'
import { WATCHER_GROUPS, watcherOverview, type WatcherGroup, type WatcherOverviewRow } from '../../../shared/watcherOverview'
import { ProviderMark } from '../agents/ProviderMark'
import { RowTime } from '../agents/ThreadSidebar'
import { rowStatus, type ThreadRow } from '../agents/threadFacts'
import { WATCHED_BY_WATCHER, WatchedBadge } from './WatcherOwl'
import { WatchListToggle } from './WatchControls'
import { useWatchActions, type WatcherReadMarkView, type WatcherReadNews } from './watcherRoom'

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`
const NO_MARKS: ReadonlyMap<string, WatcherReadMarkView> = new Map()

/** What a read mark says is new, in the words its row's description and its dot's title use. */
export const READ_MARK_NEWS: Record<WatcherReadMarkKind, string> = {
  finished: 'a finished turn', question: 'a question', permission: 'a permission to answer', failed: 'a failed turn',
}

/** How each group reads: the ring and the status word's tone. Labels say what Sotto knows, not what an agent claims. */
export const TONES: Record<WatcherGroup, string> = {
  'Needs you': 'needs', 'Ready for review': 'ready', Working: 'working', Landing: 'landing', Quiet: 'quiet', Idle: 'idle',
}

export interface OverviewEntry { readonly overview: WatcherOverviewRow; readonly facts: ThreadRow }
export interface OverviewGroup { readonly group: WatcherGroup; readonly entries: readonly OverviewEntry[] }

/** What a thread in Needs you waits on: a question, a permission, or the user after a failed turn. */
export type WaitKind = 'question' | 'permission' | 'failed'
export function waitKind({ facts }: OverviewEntry): WaitKind {
  const request = facts.request ?? facts.thread.requests[0]
  return request?.kind === 'permission' ? 'permission' : request?.kind === 'question' ? 'question' : 'failed'
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
    case 'Needs you': return facts.state === 'needs' ? facts.stateLabel : 'Last turn failed'
    case 'Ready for review': {
      const open = thread.pullRequests?.find(pr => pr.state === 'open') ?? (thread.worktree?.git?.pullRequest?.state === 'open' ? thread.worktree.git.pullRequest : undefined)
      return open ? `PR #${open.number} open` : 'Pull request open'
    }
    case 'Working': return facts.stateLabel
    case 'Landing': return 'Landing'
    case 'Quiet': return 'Quiet'
    default: return rowStatus(facts).text
  }
}

/** The name of a press that opens a thread at what it waits on. */
export function openAtRequestLabel(title: string, kind: WaitKind): string {
  return kind === 'failed' ? `Open ${title} at its failed turn` : `Open ${title} to answer its ${kind}`
}

/**
 * One thread in the list: its ring, title and clock; its provider, Watcher's owl when it watches it, its project and
 * host, and where it stands; and, when it waits on the user, what it asks with Open to answer. A press on the row opens
 * the thread beside Watcher; with Shift, in the Threads room. The owl at its end watches it, or stops, and is the row's
 * last stop (Zach's pick on October 13, 2026, watch B).
 */
function OverviewRow({ entry, watched, current, mark, liveClock, onOpen }: {
  readonly entry: OverviewEntry; readonly watched: boolean; readonly current: boolean; readonly liveClock: boolean; readonly onOpen: OpenThread
  /** What the thread's unseen news is, when it has a read mark (Zach's pick on October 16, 2026, dot A). */
  readonly mark: WatcherReadMarkKind | undefined
}): ReactNode {
  const { overview, facts } = entry
  const thread = overview.thread
  const tone = TONES[overview.group]
  const word = statusWord(entry)
  const describedBy = useId()
  const unavailable = overview.available ? '' : facts.reconnecting ? ' · Reconnecting' : ' · Disconnected'
  const where = [facts.project?.title, thread.hostLabel].filter(Boolean).join(' · ')
  const needs = overview.group === 'Needs you'
  const kind = needs ? waitKind(entry) : null
  const asks = needs ? facts.request?.text.split('\n').find(line => line.trim() !== '')?.trim() ?? (kind === 'failed' ? 'Its last turn failed.' : undefined) : undefined
  return <li className="watcher-row" data-group={tone} data-current={current || undefined} data-unavailable={overview.available ? undefined : true} data-unread={mark === undefined ? undefined : mark}>
    <span className="watcher-row__ring" data-tone={facts.thread.status === 'error' || facts.thread.lastTurn?.status === 'failed' ? 'failed' : tone} aria-hidden="true" />
    <button type="button" className="watcher-row__open tt-focusable" aria-label={`Open ${thread.title} beside Watcher`} aria-describedby={describedBy} title={thread.title}
      aria-current={current || undefined} {...threadPress(onOpen, thread.id, false)}>
      {mark === undefined ? null : <span className="watcher-row__dot" aria-hidden="true" title={`New since you looked: ${READ_MARK_NEWS[mark]}`} />}
      <span className="watcher-row__title">{thread.title}</span></button>
    <RowTime row={facts} live={liveClock} />
    <span className="watcher-row__meta" aria-hidden="true">
      <span className="watcher-row__marks">
        <span className="thread-nav__mark" data-provider={facts.providerId} title={[facts.provider, facts.model?.name].filter(Boolean).join(' · ')}><ProviderMark provider={facts.providerId} name={facts.provider} /></span>
        {watched ? <WatchedBadge size={14} /> : null}
      </span>
      {where ? <span className="watcher-row__where">{where}</span> : null}
      <span className="watcher-row__status" data-tone={tone}>{word}{unavailable}</span>
    </span>
    <span id={describedBy} className="tt-visually-hidden">{[mark === undefined ? '' : `New: ${READ_MARK_NEWS[mark]}`, facts.provider, where, `${word}${unavailable}`, watched ? WATCHED_BY_WATCHER : ''].filter(Boolean).join(', ')}</span>
    {asks !== undefined && kind !== null ? <div className="watcher-row__asks">
      <span>{asks}</span>
      <button type="button" className="watcher-answer tt-focusable" aria-label={openAtRequestLabel(thread.title, kind)} {...threadPress(onOpen, thread.id, true)}>
        {kind === 'failed' ? 'Open' : 'Open to answer'}</button>
    </div> : null}
    <WatchListToggle threadId={thread.id} title={thread.title} />
  </li>
}

/**
 * A group: its name and count, then its rows. Settled and archived threads stay reachable, folded at the end of Idle;
 * while the filter holds text, the fold shows what it matches, as the Threads sidebar's Settled shelf does.
 */
function OverviewGroupList({ group, entries, watched, marks, besideId, liveClock, searching, onOpen }: {
  readonly group: WatcherGroup; readonly entries: readonly OverviewEntry[]; readonly watched: ReadonlySet<string>; readonly besideId: string | null
  readonly marks: ReadonlyMap<string, WatcherReadMarkView>
  readonly liveClock: boolean; readonly searching: boolean; readonly onOpen: OpenThread
}): ReactNode {
  const settledId = useId()
  const headingId = useId()
  const [settledOpen, setSettledOpen] = useState(false)
  const settledShown = settledOpen || searching
  const settled = group === 'Idle' ? entries.filter(entry => entry.facts.settledBy !== null) : []
  const shown = group === 'Idle' ? entries.filter(entry => entry.facts.settledBy === null) : entries
  const row = (entry: OverviewEntry): ReactNode => <OverviewRow key={entry.overview.thread.id} entry={entry} watched={watched.has(entry.overview.thread.id)}
    current={entry.overview.thread.id === besideId} liveClock={liveClock} onOpen={onOpen}
    mark={entry.overview.thread.id === besideId ? undefined : marks.get(entry.overview.thread.id)?.kind} />
  return <section className="watcher-group" data-tone={TONES[group]} aria-labelledby={headingId}>
    <h3 className="watcher-group__label" id={headingId} aria-label={`${group}, ${plural(entries.length, 'thread')}`}>
      <span>{group}</span><span className="watcher-group__count" aria-hidden="true">{entries.length}</span>
    </h3>
    {shown.length ? <ul className="watcher-group__rows">{shown.map(row)}</ul> : null}
    {settled.length ? <>
      <button type="button" className="watcher-group__settled tt-focusable" aria-expanded={settledShown} aria-controls={settledId}
        aria-label={`Settled, ${plural(settled.length, 'thread')}`} onClick={() => setSettledOpen(value => !value)}>
        <ChevronRight size={13} aria-hidden="true" className="watcher-group__chevron" /><span>Settled</span><span className="watcher-group__count" aria-hidden="true">{settled.length}</span>
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
export function WatcherOverviewList({ groups, watched, marks = NO_MARKS, onMarkRead = null, besideId, liveClock, anchor, opener, onOpen, onClose }: {
  readonly groups: readonly OverviewGroup[]
  readonly watched: ReadonlySet<string>
  /** Read marks by thread ID: the dot before a row's name, and the count of what is new over the list. */
  readonly marks?: ReadonlyMap<string, WatcherReadMarkView> | undefined
  /** Mark all read; hands back main's refusal in its words, or null. Null where the bridge cannot. */
  readonly onMarkRead?: ((reads: readonly WatcherReadNews[]) => Promise<string | null>) | null
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
  // What is new: every listed thread with a read mark, except the one open beside Watcher, which is being read. Mark all
  // read takes this news, as shown, and no news that came after.
  const unread = groups.flatMap(group => group.entries).flatMap(entry => {
    const mark = entry.overview.thread.id === besideId ? undefined : marks.get(entry.overview.thread.id)
    return mark === undefined ? [] : [{ target: mark.target, newsId: mark.newsId }]
  })
  const [markError, setMarkError] = useState<string | null>(null)
  const markAllRead = async (): Promise<void> => {
    if (onMarkRead === null || unread.length === 0) return
    // The button goes with the marks, so focus waits in the filter, where the list opened.
    filter.current?.focus()
    setMarkError(await onMarkRead(unread))
  }
  const needle = query.trim().toLocaleLowerCase()
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
    <div ref={panel} className="watcher-list" role="dialog" aria-label="All threads" onKeyDown={onKeyDown}
      style={place ? { top: place.top, left: place.left, maxHeight: `calc(100% - ${place.top}px - 62px)` } : { visibility: 'hidden' }}>
      <label className="watcher-list__filter">
        <Search size={14} aria-hidden="true" /><span className="tt-visually-hidden">Filter threads</span>
        <input ref={filter} className="tt-focusable" type="search" value={query} placeholder="Filter threads" autoComplete="off" onChange={event => setQuery(event.currentTarget.value)} />
      </label>
      {unread.length ? <div className="watcher-list__news">
        <span className="watcher-list__news-count"><span className="watcher-row__dot" aria-hidden="true" />{unread.length} new</span>
        {onMarkRead === null ? null : <button type="button" className="watcher-list__mark-read tt-focusable" aria-label={`Mark all read, ${plural(unread.length, 'thread')}`}
          onClick={() => void markAllRead()}><CheckCheck size={14} aria-hidden="true" />Mark all read</button>}
      </div> : null}
      {markError === null ? null : <p className="watcher-list__error" role="alert">{markError}</p>}
      <div className="watcher-list__scroll">
        {shown.map(({ group, entries }) => <OverviewGroupList key={group} group={group} entries={entries} watched={watched} marks={marks} besideId={besideId} liveClock={liveClock} searching={needle !== ''} onOpen={open} />)}
        {groups.length === 0 ? <p className="watcher-list__none">No other threads yet. Threads you or Watcher start show here.</p>
          : shown.length === 0 ? <p className="watcher-list__none">No thread matches “{query.trim()}”.</p> : null}
      </div>
      <p className="watcher-list__foot">{watching ? 'The owl watches a thread until you press it again. ' : null}Shift-click opens a thread in Threads. <kbd>Esc</kbd> closes.</p>
    </div>
  </>
}
