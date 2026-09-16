import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Archive, ArchiveRestore, ChevronRight, Columns2, Folder, SquarePen } from 'lucide-react'
import type { AgentState, AgentThread } from '../../../shared/agents'
import type { AgentConnection } from './AgentContext'
import { ProviderMark } from './ProviderMark'
import { SidebarFrame, type SidebarMode } from './SidebarFrame'
import { workingLabel, type ProjectFolder, type ThreadRow, type WorkspaceOrganization } from './threadFacts'
import { THREAD_DRAG_TYPE } from './splitLayout'

export { useAddProject } from './addProject'

type Command = AgentConnection['command']
type Section = 'open' | 'settled'

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

function Indicators({ working, needs }: { readonly working: number; readonly needs: number }): ReactNode {
  if (!working && !needs) return null
  return <span className="thread-nav__indicators">
    {needs ? <span data-state="needs" title={`${needs} waiting on you`}><i aria-hidden="true" /><span className="tt-visually-hidden">{needs} waiting on you</span></span> : null}
    {working ? <span data-state="working" title={`${working} working`}><i aria-hidden="true" /><span className="tt-visually-hidden">{working} working</span></span> : null}
  </span>
}

/**
 * A row's clock. A working row counts up once a second and writes its own text, the way the transcript's
 * clock does, so one running thread never re-renders the sidebar every second.
 */
function RowTime({ row, live }: { readonly row: ThreadRow; readonly live: boolean }): ReactNode {
  const ref = useRef<HTMLTimeElement>(null)
  const since = live && row.state === 'working' ? row.workingSince : Number.NaN
  useEffect(() => {
    if (!Number.isFinite(since)) return
    const tick = (): void => { if (ref.current) ref.current.textContent = workingLabel(since, Date.now()) }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [since])
  const at = Number.isFinite(row.activityAt) ? new Date(row.activityAt) : null
  return <time ref={ref} className="thread-nav__time" title={at === null ? 'Last activity unavailable' : at.toLocaleString()} dateTime={at?.toISOString()}>{row.when}</time>
}

/**
 * Threads that finished while you were looking somewhere else. It is about what you have seen, not about the
 * thread itself, so it stays here: opening the thread clears it and a restart forgets it.
 */
function useFinishedUnseen(threads: readonly AgentThread[], onScreen: readonly string[]): ReadonlySet<string> {
  const [unseen, setUnseen] = useState<ReadonlySet<string>>(() => new Set())
  const working = useRef<ReadonlySet<string>>(new Set())
  // A thread ID is opaque, so the key joins on a character one cannot contain.
  const onScreenKey = [...onScreen].sort().join('\n')
  const seen = useMemo(() => new Set(onScreenKey === '' ? [] : onScreenKey.split('\n')), [onScreenKey])
  useEffect(() => {
    const live = new Set(threads.filter(thread => thread.status === 'running').map(thread => thread.id))
    const stopped = [...working.current].filter(id => !live.has(id))
    working.current = live
    // The mark lasts only while the thread is still finished, still known, and still out of sight.
    const finished = (id: string): boolean => !seen.has(id) && threads.some(thread => thread.id === id && thread.status === 'idle')
    setUnseen(current => {
      const next = new Set([...current, ...stopped].filter(finished))
      return next.size === current.size && [...next].every(id => current.has(id)) ? current : next
    })
  }, [threads, seen])
  return unseen
}

/** What the workspace offers a sidebar row beyond opening it: a place beside the focused thread. */
export interface PaneActions {
  /** The focused pane's thread; a row can open beside it. */
  readonly currentThreadId: string | null
  /** Threads open in the workspace, the focused one included. */
  readonly openThreadIds: readonly string[]
  readonly onOpenBeside: (threadId: string) => void
  /** A row started (thread ID) or finished (null) being dragged toward the workspace. */
  readonly onDragThread: (threadId: string | null) => void
}

function ThreadNavRow({ row, current, open, busy, unseen, liveClock, onOpen, command, panes }: {
  readonly row: ThreadRow; readonly current: boolean; readonly open: boolean; readonly busy: boolean; readonly onOpen: (threadId: string) => void; readonly command: Command
  /** The thread finished while you were elsewhere and you have not opened it since. */
  readonly unseen: boolean
  readonly liveClock: boolean
  readonly panes: PaneActions
}): ReactNode {
  const title = row.thread.title
  const label = row.settledBy === 'provider' ? row.stateLabel : row.state === 'done' && row.settledBy !== null ? 'Settled' : row.stateLabel
  const finished = unseen && label === 'Done'
  const status = finished ? 'Just finished' : label
  const besideAvailable = panes.currentThreadId !== null && !current
  return <li className="thread-nav__row" data-current={current || undefined} data-open={open && !current ? true : undefined}>
    <button type="button" className="thread-nav__item tt-focusable" aria-label={title} aria-current={current ? 'page' : undefined} draggable
      aria-keyshortcuts={besideAvailable ? 'Control+Enter' : undefined}
      onClick={event => { if (besideAvailable && (event.ctrlKey || event.metaKey)) panes.onOpenBeside(row.thread.id); else onOpen(row.thread.id) }}
      onKeyDown={event => { if (besideAvailable && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); panes.onOpenBeside(row.thread.id) } }}
      onDragStart={event => { event.dataTransfer.setData(THREAD_DRAG_TYPE, row.thread.id); event.dataTransfer.effectAllowed = 'move'; panes.onDragThread(row.thread.id) }}
      onDragEnd={() => panes.onDragThread(null)}>
      <span className="thread-nav__mark" data-provider={row.providerId ?? 'other'} title={row.provider}><ProviderMark provider={row.providerId} name={row.provider} /></span>
      <span className="thread-nav__title">{title}</span>
      <RowTime row={row} live={liveClock} />
      <span className="thread-nav__status" data-state={row.state} data-waiting={row.waitingFor ?? undefined} data-unseen={finished || undefined} data-disconnected={row.connected ? undefined : true}><i aria-hidden="true" /><span className="tt-visually-hidden">{row.provider}, </span>{status}{row.connected ? '' : ' · Disconnected'}</span>
    </button>
    <span className="thread-nav__row-actions">
      {besideAvailable && !open ? <button type="button" className="thread-nav__action tt-focusable" aria-label={`Open ${title} beside`} title="Open beside" onClick={() => panes.onOpenBeside(row.thread.id)}><Columns2 size={16} aria-hidden="true" /></button> : null}
      {row.settledBy === null
        ? <button type="button" className="thread-nav__action tt-focusable" aria-label={`Settle ${title}`} title="Settle thread" disabled={busy} onClick={() => void command({ type: 'settle-thread', threadId: row.thread.id })}><Archive size={16} aria-hidden="true" /></button>
        : row.settledBy === 'thread'
          ? <button type="button" className="thread-nav__action tt-focusable" aria-label={`Restore ${title}`} title="Restore thread" disabled={busy} onClick={() => void command({ type: 'restore-thread', threadId: row.thread.id })}><ArchiveRestore size={16} aria-hidden="true" /></button>
          : null}
    </span>
  </li>
}

function FolderView({ folder, section, panes, activeProjectId, expanded, unseen, liveClock, onToggle, onOpen, onNewThread, command, busy }: {
  readonly folder: ProjectFolder; readonly section: Section; readonly panes: PaneActions; readonly activeProjectId: string | null
  readonly expanded: boolean; readonly onToggle: () => void; readonly onOpen: (threadId: string) => void
  readonly unseen: ReadonlySet<string>; readonly liveClock: boolean
  readonly onNewThread: (projectId: string) => void; readonly command: Command; readonly busy: boolean
}): ReactNode {
  const listId = `thread-folder-${section}-${folder.id}`
  const project = folder.project
  return <div className="thread-folder" data-section={section} data-active={activeProjectId === folder.id || undefined}>
    <div className="thread-folder__head">
      <button type="button" className="thread-folder__toggle tt-focusable" aria-expanded={expanded} aria-controls={listId} onClick={onToggle} title={project?.path}>
        <ChevronRight size={14} aria-hidden="true" className="thread-folder__chevron" /><Folder size={16} aria-hidden="true" />
        <span className="thread-folder__title">{folder.title}</span>
        {!expanded ? <Indicators working={folder.working} needs={folder.needs} /> : null}
        <span className="thread-folder__count" aria-label={`${folder.rows.length} ${folder.rows.length === 1 ? 'thread' : 'threads'}`}>{folder.rows.length}</span>
      </button>
      {project !== undefined ? <span className="thread-folder__actions">
        {section === 'open' ? <button type="button" className="thread-nav__action tt-focusable" aria-label={`New thread in ${folder.title}`} title="New thread here" onClick={() => onNewThread(folder.id)}><SquarePen size={16} aria-hidden="true" /></button> : null}
        {folder.settled
          ? <button type="button" className="thread-nav__action tt-focusable" aria-label={`Restore project ${folder.title}`} title="Restore project" disabled={busy} onClick={() => void command({ type: 'restore-project', projectId: folder.id })}><ArchiveRestore size={16} aria-hidden="true" /></button>
          : section === 'open' ? <button type="button" className="thread-nav__action tt-focusable" aria-label={`Settle project ${folder.title}`} title="Settle project" disabled={busy} onClick={() => void command({ type: 'settle-project', projectId: folder.id })}><Archive size={16} aria-hidden="true" /></button> : null}
      </span> : null}
    </div>
    {expanded ? <ul className="thread-folder__rows" id={listId}>
      {folder.rows.map(row => <ThreadNavRow key={row.thread.id} row={row} current={panes.currentThreadId === row.thread.id} open={panes.openThreadIds.includes(row.thread.id)} busy={busy}
        unseen={unseen.has(row.thread.id)} liveClock={liveClock} onOpen={onOpen} command={command} panes={panes} />)}
      {!folder.rows.length ? <li className="thread-nav__empty">{section === 'open' ? 'No open threads.' : 'No threads yet.'}</li> : null}
    </ul> : null}
  </div>
}

/** The Threads sidebar: project folders of open work, then the Settled shelf. */
export function ThreadSidebar({ state, command, organization, query, liveClock = true, mode = 'threads', onMode = () => {}, onQuery, onOpen, onNewThread, ...panes }: PaneActions & {
  readonly state: AgentState
  readonly command: Command
  readonly organization: WorkspaceOrganization
  readonly query: string
  /** Which mode the sidebar's switch shows as current, and where the other one leads. */
  readonly mode?: SidebarMode
  readonly onMode?: (mode: SidebarMode) => void
  /** False where the page holds its clock still (a capture run); working rows then keep the time they were given. */
  readonly liveClock?: boolean | undefined
  readonly onQuery: (query: string) => void
  readonly onOpen: (threadId: string) => void
  readonly onNewThread: (projectId?: string) => void
}): ReactNode {
  const [settledOpen, setSettledOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const onScreen = panes.currentThreadId === null ? panes.openThreadIds : [...panes.openThreadIds, panes.currentThreadId]
  const unseen = useFinishedUnseen(state.host.threads, onScreen)
  const searching = query.trim() !== ''
  const toggle = (key: string): void => setCollapsed(previous => {
    const next = new Set(previous)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const folderView = (section: Section) => (folder: ProjectFolder): ReactNode => {
    const key = `${section}:${folder.id}`
    return <FolderView key={key} folder={folder} section={section} panes={panes} activeProjectId={state.activeProjectId} unseen={unseen} liveClock={liveClock}
      expanded={searching || !collapsed.has(key)} onToggle={() => toggle(key)} onOpen={onOpen} onNewThread={onNewThread} command={command} busy={state.busy} />
  }
  const { open, settled } = organization
  const settledThreads = settled.reduce((count, folder) => count + folder.rows.length, 0)
  const settledWorking = settled.reduce((count, folder) => count + folder.working, 0)
  const settledNeeds = settled.reduce((count, folder) => count + folder.needs, 0)
  const settledShown = settledOpen || searching
  return <SidebarFrame state={state} command={command} mode={mode} onMode={onMode} label="Thread sidebar" query={query} searchPlaceholder="Search threads" onQuery={onQuery}
    onNew={() => onNewThread()} newLabel="New thread" NewIcon={SquarePen}>
      <section aria-label="Projects">
        <h2 className="thread-nav__label">Projects <span title={plural(open.length, 'project')}>{open.length} <span className="tt-visually-hidden">{open.length === 1 ? 'project' : 'projects'}</span></span></h2>
        {open.map(folderView('open'))}
        {!open.length ? <p className="thread-nav__empty">{searching ? 'No matching open threads.' : state.host.projects.length ? 'All caught up.' : 'Add a project folder to start.'}</p> : null}
      </section>
      <section aria-label="Settled" className="thread-nav__shelf">
        <button className="thread-nav__settled tt-focusable" type="button" aria-expanded={settledShown} onClick={() => setSettledOpen(!settledOpen)}
          aria-label={[`Settled ${plural(settledThreads, 'thread')}`, settledNeeds ? `${settledNeeds} waiting on you` : '', settledWorking ? `${settledWorking} working` : ''].filter(Boolean).join(', ')}>
          <ChevronRight size={14} aria-hidden="true" className="thread-folder__chevron" />
          <span>Settled</span>
          {!settledShown ? <Indicators working={settledWorking} needs={settledNeeds} /> : null}
          <small title={plural(settledThreads, 'thread')}>{settledThreads}</small>
        </button>
        {settledShown ? <div>{settled.map(folderView('settled'))}{!settled.length ? <p className="thread-nav__empty">No settled threads.</p> : null}</div> : null}
      </section>
      {searching && !organization.matching ? <p className="thread-nav__empty">Nothing matches "{query}".</p> : null}
  </SidebarFrame>
}
