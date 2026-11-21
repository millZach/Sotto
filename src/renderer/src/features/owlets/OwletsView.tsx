import React, { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { Pencil, Plus } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import type { AgentState } from '../../../../shared/agents'
import { owletFolderLabel } from '../../../../shared/owlets'
import { Button } from '../../components/Button'
import { Marked } from '../../components/marks'
import { PageWindowControls } from '../../components/WindowControls'
import { claimRoomFocus } from '../../components/pageShortcuts'
import { useAgents } from '../../agents/AgentContext'
import { useClock } from '../../agents/paneGrid'
import { SidebarFrame } from '../../agents/SidebarFrame'
import { RowTime } from '../../agents/ThreadSidebar'
import { ThreadPane } from '../../agents/ThreadPane'
import { useShared } from '../../agents/stateSharing'
import { threadDescriber, useWordsRevision, type ThreadRow } from '../../agents/threadFacts'
import { useContinueEnabled } from '../../agents/continuations'
import { OwletMark } from './OwletMark'
import { OwletSetup, owletHomeName } from './OwletSetup'
import './owlets.css'

/** The owlet's composer; the Threads page's is `thread-prompt`. */
export const OWLET_PROMPT_ID = 'owlet-prompt'
const OWLET_PANE_ID = 'owlet-pane'

/** The owlet the page shows, kept for as long as the window lasts, so coming back to the page finds it again. */
let shownOwlet: string | null = null

/** Newest first, as Recent is on the Threads page; one that never ran sorts by its name after those that have. */
export function owletOrder(rows: readonly ThreadRow[]): ThreadRow[] {
  return [...rows].sort((a, b) => {
    const at = Number.isFinite(a.activityAt) ? a.activityAt : -Infinity, bt = Number.isFinite(b.activityAt) ? b.activityAt : -Infinity
    return bt - at || a.thread.title.localeCompare(b.thread.title)
  })
}

/** Whether an owlet has news nobody has seen: a finish while no window showed it, or a failure not looked at yet. */
const unread = (row: ThreadRow): boolean => row.thread.finishedUnread === true || row.state === 'needs' && !row.attention

/**
 * The Owlets page (ADR-0211), an Owl feature: every owlet in one sidebar, the ones waiting on you first under Needs you,
 * and the chosen owlet's one thread beside it, as on the Threads page. Zach picked the sidebar look's R2 rows: the owlet's
 * mark (`OwletMark`), its name with its role, and under them its home computer and what it last did.
 */
export function OwletsView({ now: fixedNow }: { readonly now?: number | undefined }): ReactNode {
  const { t } = useLingui()
  const agents = useAgents()
  const state = agents.state
  const command = agents.command
  const now = useClock(fixedNow)
  const continued = useContinueEnabled()
  const words = useWordsRevision()
  const [describeRows] = useState(threadDescriber)
  const rows = useShared(useMemo(() => state === null ? [] : describeRows(state, now, { continued }), [state, now, continued, words]))
  const owlets = useMemo(() => rows.filter(row => row.thread.owlet !== undefined), [rows])
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(() => shownOwlet)
  const [setup, setSetup] = useState<{ readonly threadId: string | null } | null>(null)
  const ordered = useMemo(() => owletOrder(owlets), [owlets])
  const selected = ordered.find(row => row.thread.id === selectedId) ?? null
  const select = (threadId: string | null): void => { shownOwlet = threadId; setSelectedId(threadId) }

  // The owlet on screen is read and counted as seen, which is what clears its unread mark; leaving the page lets it go.
  const observed = selected?.thread.id ?? null
  useEffect(() => { void command({ type: 'observe-threads', threadIds: observed === null ? [] : [observed] }) }, [command, observed])
  useEffect(() => () => { void command({ type: 'observe-threads', threadIds: [] }) }, [command])
  // A switch press hands focus to the lit tile; arriving any other way, focus goes to the owlet's composer when one is open.
  useLayoutEffect(() => {
    if (claimRoomFocus('owlets')) return
    if (document.activeElement === null || document.activeElement === document.body) document.getElementById(OWLET_PROMPT_ID)?.focus()
  }, [])

  if (state === null) return <div className="threads-view threads-view--bare">
    <p className="tt-paragraph" role="status">{agents.error ?? t`Preparing agent controls…`}</p>
    <PageWindowControls />
  </div>

  const found = query.trim() === '' ? ordered : ordered.filter(row => owletMatches(row, state, query))
  const needs = found.filter(row => row.attention)
  const rest = found.filter(row => !row.attention)
  const open = (threadId: string): void => { select(threadId); requestAnimationFrame(() => document.getElementById(OWLET_PROMPT_ID)?.focus()) }
  const editing = setup?.threadId ? owlets.find(row => row.thread.id === setup.threadId) : undefined
  return <Marked>{marks => <div className="management-view threads-view owlets-view" data-room-backdrop="" {...marks}>
    <SidebarFrame state={state} command={command} label={t`Owlets`} title="Owlets" query={query} searchPlaceholder={t`Search owlets`} onQuery={setQuery}
      onNew={() => setSetup({ threadId: null })} newLabel={t`New owlet`} NewIcon={Plus} projectActions={false}>
      <nav className="owlets-list" aria-label={t`Owlets`}>
        {needs.length ? <section className="owlets-list__group" aria-labelledby="owlets-needs">
          <h2 id="owlets-needs" className="owlets-list__heading" data-tone="needs"><Trans>Needs you</Trans> <span className="owlets-list__count">{needs.length}</span></h2>
          <ul>{needs.map(row => <OwletRow key={row.thread.id} row={row} state={state} current={row.thread.id === selected?.thread.id} live={fixedNow === undefined} onOpen={open} />)}</ul>
        </section> : null}
        {rest.length ? <ul>{rest.map(row => <OwletRow key={row.thread.id} row={row} state={state} current={row.thread.id === selected?.thread.id} live={fixedNow === undefined} onOpen={open} />)}</ul> : null}
        {found.length === 0 ? <p className="thread-nav__empty tt-paragraph">{owlets.length ? t`No owlet matches.` : t`No owlets yet. Make one with New owlet.`}</p> : null}
      </nav>
    </SidebarFrame>
    <section className="thread-workspace" data-room-backdrop="" data-region="room" aria-label={t`Owlet`}>
      <div className="thread-workspace__body" data-room-backdrop="" data-panes={selected ? true : undefined}>
        {selected ? <OwletPane row={selected} state={state} command={command} store={agents.threadDrafts} error={state.error ?? agents.error} now={fixedNow}
          onEdit={() => setSetup({ threadId: selected.thread.id })} />
          : <OwletsEmpty count={owlets.length} onNew={() => setSetup({ threadId: null })} />}
      </div>
    </section>
    {setup ? <OwletSetup state={state} command={command} owlet={editing} onClose={() => setSetup(null)}
      onMade={threadId => { setSetup(null); open(threadId) }} /> : null}
    <PageWindowControls />
  </div>}</Marked>
}

/** Search finds an owlet by its name, its role or its home computer's name. */
function owletMatches(row: ThreadRow, state: AgentState, query: string): boolean {
  const words = query.trim().toLocaleLowerCase()
  const owlet = row.thread.owlet!
  return [owlet.name, owlet.role, owletHomeName(state, row.thread.hostId)].some(text => text.toLocaleLowerCase().includes(words))
}

/** One R2 row: the mark, the name with the role beside it, and under them the home computer and what it last did. */
function OwletRow({ row, state, current, live, onOpen }: { readonly row: ThreadRow; readonly state: AgentState; readonly current: boolean; readonly live: boolean; readonly onOpen: (threadId: string) => void }): ReactNode {
  const { t } = useLingui()
  const owlet = row.thread.owlet!
  const home = owletHomeName(state, row.thread.hostId)
  const news = unread(row)
  const last = row.attention ? row.stateLabel : row.thread.nativeSessionStarted === false ? t`Not run yet` : row.sentence
  const describedBy = `owlet-row-${row.thread.id}`
  return <li className="thread-nav__row owlets-row" data-current={current || undefined}>
    <button type="button" className="owlets-row__item tt-focusable" aria-current={current ? 'page' : undefined} aria-describedby={describedBy} onClick={() => onOpen(row.thread.id)}>
      <span className="owlets-row__mark" aria-hidden="true"><OwletMark threadId={row.thread.id} /></span>
      <span className="owlets-row__top">
        <span className="owlets-row__name">{owlet.name}</span>
        {owlet.role ? <span className="owlets-row__role">{owlet.role}</span> : null}
      </span>
      <span className="owlets-row__end">
        {news ? <span className="owlets-row__unread" role="img" aria-label={t`Unread`} title={t`Unread`}><svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" focusable="false"><circle cx="4" cy="4" r="4" fill="currentColor" /></svg></span> : null}
        {row.attention ? <span className="thread-nav__needs">{row.stateLabel}</span> : <RowTime row={row} live={live} />}
      </span>
      <span className="owlets-row__last" id={describedBy}>{home} · {last}</span>
    </button>
  </li>
}

/** The chosen owlet's thread, with its role, home computer and folder above the conversation, and Edit owlet in its header. */
function OwletPane({ row, state, command, store, error, now, onEdit }: {
  readonly row: ThreadRow; readonly state: AgentState; readonly command: ReturnType<typeof useAgents>['command']
  readonly store: ReturnType<typeof useAgents>['threadDrafts']; readonly error: string | null; readonly now: number | undefined; readonly onEdit: () => void
}): ReactNode {
  const { t } = useLingui()
  const owlet = row.thread.owlet!
  const name = owlet.name
  const folder = owletFolderLabel(row.project?.title ?? name)
  return <section id={OWLET_PANE_ID} className="thread-pane owlet-pane" data-region="pane" data-thread-id={row.thread.id} data-focused="" data-under-controls="" role="region" aria-label={name}>
    <ThreadPane row={row} state={state} command={command} store={store} focused promptId={OWLET_PROMPT_ID} error={error} now={now}
      actions={<button type="button" className="pane-action tt-focusable" aria-label={t`Edit ${name}`} title={t`Edit owlet`} onClick={onEdit}><Pencil size={16} aria-hidden="true" /></button>}
      notice={<p className="owlet-pane__facts tt-paragraph">
        {owlet.role ? <span>{owlet.role}</span> : null}
        <span>{t({ message: `On ${owletHomeName(state, row.thread.hostId, true)}`, comment: 'An owlet\'s home computer, such as "On forge" or "On this computer".' })}</span>
        <span className="owlet-pane__folder">{folder}</span>
      </p>} />
  </section>
}

function OwletsEmpty({ count, onNew }: { readonly count: number; readonly onNew: () => void }): ReactNode {
  return <div className="owlets-empty">
    {count === 0 ? <>
      <h2><Trans>Owlets</Trans></h2>
      <p className="tt-paragraph"><Trans>An owlet is a helper you name and give a role. It keeps one thread in a folder of its own on one computer, with the same tools and cards as any thread. It runs when you talk to it.</Trans></p>
      <Button variant="primary" onClick={onNew}><Trans>New owlet</Trans></Button>
    </> : <p className="tt-paragraph"><Trans>Choose an owlet to open its thread.</Trans></p>}
  </div>
}
