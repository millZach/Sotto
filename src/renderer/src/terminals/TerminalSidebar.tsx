import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Columns2, RotateCcw, SquareTerminal, X } from 'lucide-react'
import type { AgentState } from '../../../shared/agents'
import type { AgentConnection } from '../agents/AgentContext'
import { SidebarFrame, type SidebarMode } from '../agents/SidebarFrame'
import { THREAD_DRAG_TYPE } from '../agents/splitLayout'
import { elapsedLabel } from '../agents/threadFacts'
import { SIDEBAR_STATE, isOpenTerminal, terminalStateLabel, type TerminalFolder, type TerminalOrganization, type TerminalRow, type TerminalRowState } from './terminalFacts'

type Section = 'open' | 'closed'
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

/** The states a row spells out instead of showing its clock: a terminal that stopped is one that wants you. */
const ATTENTION: ReadonlySet<TerminalRowState> = new Set<TerminalRowState>(['exited'])

/** What the workspace offers a row: a place beside the focused terminal, and the terminal's own actions. */
export interface TerminalPaneActions {
  readonly currentId: string | null
  readonly openIds: readonly string[]
  readonly onOpenBeside: (id: string) => void
  readonly onDragTerminal: (id: string | null) => void
  readonly onCloseTerminal: (id: string) => void
  readonly onReopenTerminal: (id: string) => void
  /** The last line a terminal printed, shown while it waits. */
  readonly lastLineOf: (id: string) => string
}

/** The row's clock: how long the terminal has been open, counting while the sidebar shows. */
function RowTime({ row, live }: { readonly row: TerminalRow; readonly live: boolean }): ReactNode {
  const ref = useRef<HTMLTimeElement>(null)
  const since = live && isOpenTerminal(row.terminal) ? row.terminal.openedAt : Number.NaN
  useEffect(() => {
    if (!Number.isFinite(since)) return
    const tick = (): void => { if (ref.current) ref.current.textContent = elapsedLabel(since, Date.now()) }
    const timer = window.setInterval(tick, 30_000)
    return () => window.clearInterval(timer)
  }, [since])
  const at = new Date(row.terminal.openedAt)
  return <time ref={ref} className="thread-nav__time" title={`Opened ${at.toLocaleString()}`} dateTime={at.toISOString()}>{row.since}</time>
}

function TerminalNavRow({ row, state, current, open, busy, liveClock, onOpen, panes }: {
  readonly row: TerminalRow; readonly state: TerminalRowState; readonly current: boolean; readonly open: boolean; readonly busy: boolean
  readonly liveClock: boolean; readonly onOpen: (id: string) => void; readonly panes: TerminalPaneActions
}): ReactNode {
  const { terminal } = row
  const title = terminal.title
  const closed = !isOpenTerminal(terminal)
  const besideAvailable = panes.currentId !== null && !current && !closed
  const status = terminalStateLabel(terminal, state, panes.lastLineOf(terminal.id))
  const statusId = useId()
  return <li className="thread-nav__row" data-current={current || undefined} data-open={open && !current ? true : undefined}>
    <button type="button" className="thread-nav__item tt-focusable" aria-label={title} aria-describedby={statusId} aria-current={current ? 'page' : undefined} draggable={!closed} disabled={closed}
      aria-keyshortcuts={besideAvailable ? 'Control+Enter' : undefined}
      onClick={event => { if (besideAvailable && (event.ctrlKey || event.metaKey)) panes.onOpenBeside(terminal.id); else onOpen(terminal.id) }}
      onKeyDown={event => { if (besideAvailable && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); panes.onOpenBeside(terminal.id) } }}
      onDragStart={event => { event.dataTransfer.setData(THREAD_DRAG_TYPE, terminal.id); event.dataTransfer.effectAllowed = 'move'; panes.onDragTerminal(terminal.id) }}
      onDragEnd={() => panes.onDragTerminal(null)}>
      <span className="thread-nav__ring" data-state={SIDEBAR_STATE[state]} aria-hidden="true" />
      <span className="thread-nav__title">{title}</span>
      {/* A terminal that stopped on its own says so where the clock was; while it runs, the clock is the useful fact. */}
      {ATTENTION.has(state)
        ? <span className="thread-nav__needs" aria-hidden="true">{status}</span>
        : <RowTime row={row} live={liveClock} />}
      <span id={statusId} className="thread-nav__status tt-visually-hidden" data-state={SIDEBAR_STATE[state]} title={terminal.command}><span className="tt-visually-hidden">{row.provider}, </span>{status}</span>
    </button>
    <span className="thread-nav__row-actions">
      {besideAvailable && !open ? <button type="button" className="thread-nav__action tt-focusable" aria-label={`Open ${title} beside`} title="Open beside" onClick={() => panes.onOpenBeside(terminal.id)}><Columns2 size={16} aria-hidden="true" /></button> : null}
      {closed
        ? <button type="button" className="thread-nav__action tt-focusable" aria-label={`Reopen ${title}`} title="Reopen terminal" disabled={busy} onClick={() => panes.onReopenTerminal(terminal.id)}><RotateCcw size={16} aria-hidden="true" /></button>
        : <button type="button" className="thread-nav__action tt-focusable" aria-label={`Close ${title}`} title="Close terminal" disabled={busy} onClick={() => panes.onCloseTerminal(terminal.id)}><X size={16} aria-hidden="true" /></button>}
    </span>
  </li>
}

function FolderView({ folder, section, panes, stateOf, expanded, liveClock, onToggle, onOpen, onNewTerminal, busy }: {
  readonly folder: TerminalFolder; readonly section: Section; readonly panes: TerminalPaneActions; readonly stateOf: (id: string) => TerminalRowState
  readonly expanded: boolean; readonly liveClock: boolean; readonly onToggle: () => void; readonly onOpen: (id: string) => void
  readonly onNewTerminal: (projectId: string) => void; readonly busy: boolean
}): ReactNode {
  const listId = `terminal-folder-${section}-${folder.id}`
  return <div className="thread-folder" data-section={section}>
    <div className="thread-folder__head">
      {/* As in the Threads sidebar, the count moves into the toggle's name now that the row no longer draws it. */}
      <button type="button" className="thread-folder__toggle tt-focusable" aria-expanded={expanded} aria-controls={listId} onClick={onToggle}
        aria-label={`${folder.title} ${plural(folder.rows.length, 'terminal')}`} title={folder.project?.path}>
        <ChevronRight size={12} aria-hidden="true" className="thread-folder__chevron" />
        <span className="thread-folder__title">{folder.title}</span>
        {!expanded && folder.running ? <span className="thread-nav__indicators"><span data-state="working" title={`${folder.running} running`}><i aria-hidden="true" /><span className="tt-visually-hidden">{folder.running} running</span></span></span> : null}
      </button>
      {folder.project !== undefined && section === 'open' ? <span className="thread-folder__actions">
        <button type="button" className="thread-nav__action tt-focusable" aria-label={`New terminal in ${folder.title}`} title="New terminal here" onClick={() => onNewTerminal(folder.id)}><SquareTerminal size={16} aria-hidden="true" /></button>
      </span> : null}
    </div>
    {expanded ? <ul className="thread-folder__rows" id={listId}>
      {folder.rows.map(row => <TerminalNavRow key={row.terminal.id} row={row} state={stateOf(row.terminal.id)} current={panes.currentId === row.terminal.id} open={panes.openIds.includes(row.terminal.id)}
        busy={busy} liveClock={liveClock} onOpen={onOpen} panes={panes} />)}
      {!folder.rows.length ? <li className="thread-nav__empty">No open terminals.</li> : null}
    </ul> : null}
  </div>
}

/** The Terminal sidebar: the Threads sidebar's frame, with terminals under their projects and the Closed shelf. */
export function TerminalSidebar({ state, command, organization, query, stateOf, liveClock = true, busy, mode, onMode, onQuery, onOpen, onNewTerminal, ...panes }: TerminalPaneActions & {
  readonly state: AgentState
  readonly command: AgentConnection['command']
  readonly organization: TerminalOrganization
  readonly query: string
  readonly stateOf: (id: string) => TerminalRowState
  readonly liveClock?: boolean | undefined
  readonly busy: boolean
  readonly mode: SidebarMode
  readonly onMode: (mode: SidebarMode) => void
  readonly onQuery: (query: string) => void
  readonly onOpen: (id: string) => void
  readonly onNewTerminal: (projectId?: string) => void
}): ReactNode {
  const [closedOpen, setClosedOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const searching = query.trim() !== ''
  const toggle = (key: string): void => setCollapsed(previous => {
    const next = new Set(previous)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const folderView = (section: Section) => (folder: TerminalFolder): ReactNode => {
    const key = `${section}:${folder.id}`
    return <FolderView key={key} folder={folder} section={section} panes={panes} stateOf={stateOf} liveClock={liveClock}
      expanded={searching || !collapsed.has(key)} onToggle={() => toggle(key)} onOpen={onOpen} onNewTerminal={onNewTerminal} busy={busy} />
  }
  const { open, closed } = organization
  const closedCount = closed.reduce((count, folder) => count + folder.rows.length, 0)
  const closedShown = closedOpen || searching
  return <SidebarFrame state={state} command={command} mode={mode} onMode={onMode} label="Terminal sidebar" query={query} searchPlaceholder="Search terminals" onQuery={onQuery}
    onNew={() => onNewTerminal()} newLabel="New terminal" NewIcon={SquareTerminal}>
      <section aria-label="Projects">
        {open.map(folderView('open'))}
        {!open.length ? <p className="thread-nav__empty">{searching ? 'No matching open terminals.' : state.host.projects.length ? 'No terminals open.' : 'Add a project folder to start.'}</p> : null}
      </section>
      <section aria-label="Closed" className="thread-nav__shelf">
        <button className="thread-nav__settled tt-focusable" type="button" aria-expanded={closedShown} onClick={() => setClosedOpen(!closedOpen)} aria-label={`Closed ${plural(closedCount, 'terminal')}`}>
          <ChevronRight size={13} aria-hidden="true" className="thread-folder__chevron" />
          <span>Closed</span>
        </button>
        {closedShown ? <div>{closed.map(folderView('closed'))}{!closed.length ? <p className="thread-nav__empty">No closed terminals this session.</p> : null}</div> : null}
      </section>
      {searching && !organization.matching ? <p className="thread-nav__empty">Nothing matches "{query}".</p> : null}
  </SidebarFrame>
}
