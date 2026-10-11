import React, { useId, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import type { AgentState } from '../../../shared/agents'
import { WATCHER_GROUPS, watcherOverview, type WatcherGroup, type WatcherOverviewRow } from '../../../shared/watcherOverview'
import { ProviderMark } from '../agents/ProviderMark'
import { RowTime } from '../agents/ThreadSidebar'
import { useShared } from '../agents/stateSharing'
import { describeThreads, rowStatus, type ThreadRow } from '../agents/threadFacts'
import { WatchedBadge } from './WatcherOwl'

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

/** How each group reads: the ring and the status word's tone. Labels say what Sotto knows, not what an agent claims. */
const TONES: Record<WatcherGroup, string> = {
  'Needs you': 'needs', 'Ready for review': 'ready', Working: 'working', Landing: 'landing', Quiet: 'quiet', Idle: 'idle',
}

interface OverviewEntry { readonly overview: WatcherOverviewRow; readonly facts: ThreadRow }

/** The words beside a row's project: what the thread waits on, its pull request, or the sidebar's own status. */
function statusWord({ overview, facts }: OverviewEntry): string {
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

/**
 * One thread in the Overview: its ring, title and clock; its provider, Watcher's owl when it watches it, its
 * project and host, and where it stands; and, when it waits on the user, what it asks. A row only reports: the
 * thread is answered and worked in its own pane.
 */
function OverviewRow({ entry, watched, liveClock }: { readonly entry: OverviewEntry; readonly watched: boolean; readonly liveClock: boolean }): ReactNode {
  const { overview, facts } = entry
  const thread = overview.thread
  const tone = TONES[overview.group]
  const word = statusWord(entry)
  const unavailable = overview.available ? '' : facts.reconnecting ? ' · Reconnecting' : ' · Disconnected'
  const where = [facts.project?.title, thread.hostLabel].filter(Boolean).join(' · ')
  const asks = overview.group === 'Needs you' ? facts.request?.text.split('\n').find(line => line.trim() !== '')?.trim() : undefined
  return <li className="watcher-row" data-group={tone} data-unavailable={overview.available ? undefined : true}>
    <span className="watcher-row__ring" data-tone={facts.thread.status === 'error' || facts.thread.lastTurn?.status === 'failed' ? 'failed' : tone} aria-hidden="true" />
    <span className="watcher-row__title" title={thread.title}>{thread.title}</span>
    <RowTime row={facts} live={liveClock} />
    <span className="watcher-row__meta">
      <span className="watcher-row__marks">
        <span className="thread-nav__mark" data-provider={facts.providerId} title={[facts.provider, facts.model?.name].filter(Boolean).join(' · ')}><ProviderMark provider={facts.providerId} name={facts.provider} /></span>
        {watched ? <WatchedBadge size={14} /> : null}
      </span>
      <span className="tt-visually-hidden">{facts.provider}, </span>
      {where ? <span className="watcher-row__where">{where}</span> : null}
      <span className="watcher-row__status" data-tone={tone}>{word}{unavailable}</span>
    </span>
    {asks ? <p className="watcher-row__asks">{asks}</p> : null}
  </li>
}

/** A group's heading toggles its rows; the count is part of its name, so a screen reader hears both. */
function OverviewGroup({ group, entries, watched, liveClock }: {
  readonly group: WatcherGroup; readonly entries: readonly OverviewEntry[]; readonly watched: ReadonlySet<string>; readonly liveClock: boolean
}): ReactNode {
  const listId = useId()
  const settledId = useId()
  const [open, setOpen] = useState(true)
  const [settledOpen, setSettledOpen] = useState(false)
  // Settled and archived threads stay reachable at the end of Idle, folded away until asked for.
  const settled = group === 'Idle' ? entries.filter(entry => entry.facts.settledBy !== null) : []
  const shown = group === 'Idle' ? entries.filter(entry => entry.facts.settledBy === null) : entries
  const tone = TONES[group]
  return <section className="watcher-group" data-tone={tone}>
    <h3 className="watcher-group__heading">
      <button type="button" className="watcher-group__toggle tt-focusable" aria-expanded={open} aria-controls={listId} aria-label={`${group}, ${plural(entries.length, 'thread')}`}
        onClick={() => setOpen(value => !value)}>
        <ChevronRight size={13} aria-hidden="true" className="watcher-group__chevron" />
        <span>{group}</span><span className="watcher-group__count" aria-hidden="true">{entries.length}</span>
      </button>
    </h3>
    {open ? <div id={listId}>
      {shown.length ? <ul className="watcher-group__rows">
        {shown.map(entry => <OverviewRow key={entry.overview.thread.id} entry={entry} watched={watched.has(entry.overview.thread.id)} liveClock={liveClock} />)}
      </ul> : null}
      {settled.length ? <>
        <button type="button" className="watcher-group__settled tt-focusable" aria-expanded={settledOpen} aria-controls={settledId}
          aria-label={`Settled, ${plural(settled.length, 'thread')}`} onClick={() => setSettledOpen(value => !value)}>
          <ChevronRight size={13} aria-hidden="true" className="watcher-group__chevron" /><span>Settled</span><span className="watcher-group__count" aria-hidden="true">{settled.length}</span>
        </button>
        {settledOpen ? <ul className="watcher-group__rows" id={settledId}>
          {settled.map(entry => <OverviewRow key={entry.overview.thread.id} entry={entry} watched={watched.has(entry.overview.thread.id)} liveClock={liveClock} />)}
        </ul> : null}
      </> : null}
    </div> : null}
  </section>
}

/**
 * Watcher's Overview: every other thread across the connected hosts, grouped by what the user must do, in the
 * decided order (ADR-0073). It is a projection of the threads' own state, never a queue of its own; Watcher's
 * own conversations are not in it.
 */
export function WatcherOverview({ state, now, liveClock, watched, exclude }: {
  readonly state: AgentState
  readonly now: number
  /** False where the page holds its clock still (a capture run). */
  readonly liveClock: boolean
  readonly watched: ReadonlySet<string>
  /** The current Watcher's thread, which the Overview leaves out whatever kind main gave it. */
  readonly exclude: string | null
}): ReactNode {
  const facts = useShared(useMemo(() => describeThreads(state, now), [state, now]))
  const groups = useMemo(() => {
    const byId = new Map(facts.map(row => [row.thread.id, row] as const))
    const entries = watcherOverview(state, now).filter(row => row.thread.id !== exclude)
      .map(overview => ({ overview, facts: byId.get(overview.thread.id)! })).filter(entry => entry.facts !== undefined)
    // Within a group the latest activity comes first; a thread whose activity is unknown goes last.
    const recent = (entry: OverviewEntry): number => Number.isFinite(entry.facts.activityAt) ? entry.facts.activityAt : -Infinity
    return WATCHER_GROUPS.map(group => ({ group, entries: entries.filter(entry => entry.overview.group === group).sort((a, b) => recent(b) - recent(a)) }))
      .filter(group => group.entries.length > 0)
  }, [facts, state, now, exclude])
  const total = groups.reduce((count, group) => count + group.entries.length, 0)
  return <section className="watcher-overview" aria-labelledby="watcher-overview-heading">
    <div className="watcher-overview__head">
      <h2 id="watcher-overview-heading" className="watcher-overview__heading">Overview</h2>
      <span className="watcher-overview__total">{plural(total, 'thread')}</span>
    </div>
    {groups.map(({ group, entries }) => <OverviewGroup key={group} group={group} entries={entries} watched={watched} liveClock={liveClock} />)}
    {total === 0 ? <p className="thread-nav__empty">No other threads yet. Threads you or Watcher start show here.</p> : null}
  </section>
}
