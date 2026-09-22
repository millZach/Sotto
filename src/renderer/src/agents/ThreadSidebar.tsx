import React, { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Archive, ArchiveRestore, ChevronRight, Columns2, Folder, FolderGit2, GitBranch, Pencil, Sparkles, SquarePen } from 'lucide-react'
import { isThreadBusy, type AgentState } from '../../../shared/agents'
import { isThreadArchived } from '../../../shared/threadActivity'
import { ThreadNameField } from './ThreadName'
import { describeWorkingCopy, useSettleThread } from './ThreadWorkingCopy'
import type { AgentConnection } from './AgentContext'
import { showThreads, useFinishedUnseen } from './finishedThreads'
import { ProjectSettleAction, SidebarFrame, type SidebarMode } from './SidebarFrame'
import { workingLabel, type ProjectFolder, type ThreadRow, type WorkspaceOrganization } from './threadFacts'
import { THREAD_DRAG_TYPE } from './splitLayout'

export { useAddProject } from './addProject'

type Command = AgentConnection['command']
type Section = 'open' | 'settled'

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

function Indicators({ working, needs, id }: { readonly working: number; readonly needs: number; readonly id?: string }): ReactNode {
  if (!working && !needs) return null
  return <span id={id} className="thread-nav__indicators">
    {needs ? <span data-state="needs" title={`${needs} waiting on you`}><i aria-hidden="true" /><span className="tt-visually-hidden">{needs} waiting on you</span></span> : null}
    {working ? <span data-state="working" title={`${working} working`}><i aria-hidden="true" /><span className="tt-visually-hidden">{working} working</span></span> : null}
  </span>
}

/**
 * A row's clock. A working row counts up once a second and writes its own text, the way the transcript's
 * clock does, so one running thread never re-renders the sidebar every second.
 */
function RowTime({ row, live, id }: { readonly row: ThreadRow; readonly live: boolean; readonly id?: string }): ReactNode {
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
  return <time ref={ref} id={id} className="thread-nav__time" title={at === null ? 'Last activity unavailable' : at.toLocaleString()} dateTime={at?.toISOString()}>{row.when}</time>
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

/**
 * One thread in the sidebar. Memoised: with the state and the rows derived from it structurally shared, a
 * row whose thread the update did not touch keeps every prop it had and does not re-render. Its props stay
 * cheap to compare — no object or array is built for it here.
 */
const ThreadNavRow = memo(function ThreadNavRow({ row, current, open, busy, unseen, liveClock, onOpen, command, panes }: {
  readonly row: ThreadRow; readonly current: boolean; readonly open: boolean; readonly onOpen: (threadId: string) => void; readonly command: Command
  /** This thread's own lane is running a command. Another thread's work leaves this row's actions live. */
  readonly busy: boolean
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
  const [renaming, setRenaming] = useState(false)
  const { settle, dialog: settleDialog } = useSettleThread(command)
  // The button's name is the title alone; the state sentence is its description, or the label would swallow it.
  const statusId = useId()
  const timeId = useId()
  const detailsId = useId()
  const archived = isThreadArchived(row.thread)
  const copy = describeWorkingCopy(row.thread, row.project)
  const WorkingCopyIcon = copy.status === 'pending' || copy.status === 'error' ? FolderGit2 : copy.branch || copy.repositoryRoot ? GitBranch : Folder
  const branch = copy.status === 'ready' ? copy.branch : undefined
  const copyLabel = copy.status === 'error' ? 'Worktree not ready' : copy.status === 'pending' ? (copy.mode === 'independent' ? 'New worktree pending' : 'Project folder pending') : copy.mode === 'independent' ? 'Worktree' : copy.mode === 'shared' ? 'Project folder' : copy.label
  const branchName = branch ?? (copy.status === 'ready' && copy.repositoryRoot ? 'Detached HEAD' : copyLabel)
  const copyDetails = [...new Set([row.thread.hostLabel, row.model?.name, branchName, copyLabel].filter(Boolean))].join(', ')
  if (renaming) return <li className="thread-nav__row" data-current={current || undefined} data-open={open && !current ? true : undefined}>
    <span className="thread-nav__item thread-nav__item--renaming">
      <ThreadNameField title={title} label={`Rename ${title}`} className="thread-nav__rename tt-focusable"
        onRename={next => void command({ type: 'rename-thread', threadId: row.thread.id, title: next })} onDone={() => setRenaming(false)} />
    </span>
  </li>
  return <li className="thread-nav__row thread-nav__row--details" data-current={current || undefined} data-open={open && !current ? true : undefined}>
    <button type="button" className="thread-nav__item tt-focusable" aria-label={title} title={title} aria-describedby={[statusId, timeId, detailsId].join(' ')} aria-current={current ? 'page' : undefined} draggable
      aria-keyshortcuts={besideAvailable ? 'Control+Enter' : undefined}
      onClick={event => { if (besideAvailable && (event.ctrlKey || event.metaKey)) panes.onOpenBeside(row.thread.id); else onOpen(row.thread.id) }}
      onKeyDown={event => { if (besideAvailable && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); panes.onOpenBeside(row.thread.id) } }}
      onDragStart={event => { event.dataTransfer.setData(THREAD_DRAG_TYPE, row.thread.id); event.dataTransfer.effectAllowed = 'move'; panes.onDragThread(row.thread.id) }}
      onDragEnd={() => panes.onDragThread(null)}>
      <span className="thread-nav__ring" data-state={row.state} data-waiting={row.waitingFor ?? undefined} data-unseen={finished || undefined} data-disconnected={row.connected ? undefined : true} aria-hidden="true" />
      <span className="thread-nav__title">{title}</span>
      <RowTime row={row} live={liveClock} id={timeId} />
      <span id={detailsId} className="tt-visually-hidden">{copyDetails}</span>
      <span className="thread-nav__metadata">
        <span className="thread-nav__provider" title={[row.provider, row.model?.name].filter(Boolean).join(' · ')}>{row.provider}<span className="thread-nav__model">{row.model ? ` · ${row.model.name}` : ''}</span></span>
        <span id={statusId} className="thread-nav__status" data-state={row.state} data-waiting={row.waitingFor ?? undefined} data-unseen={finished || undefined} data-disconnected={row.connected ? undefined : true} title={status + (row.connected ? '' : ' · Disconnected')}><span className="tt-visually-hidden">{row.provider}, </span>{status}{row.connected ? '' : ' · Disconnected'}</span>
      </span>
      <span className="thread-nav__branch" data-working-copy-state={copy.status} title={branchName !== copyLabel ? `${branchName} · ${copyLabel}` : copyLabel}>
        <WorkingCopyIcon size={12} aria-hidden="true" />{row.thread.hostLabel ? <span>{row.thread.hostLabel} · </span> : null}
        <span className="thread-nav__branch-name">{branchName}</span>{branchName !== copyLabel ? <span className="thread-nav__copy-kind"> · {copyLabel}</span> : null}
      </span>
    </button>
    <span className="thread-nav__row-actions">
      {besideAvailable && !open ? <button type="button" className="thread-nav__action tt-focusable" aria-label={`Open ${title} beside`} title="Open beside" onClick={() => panes.onOpenBeside(row.thread.id)}><Columns2 size={16} aria-hidden="true" /></button> : null}
      {!archived ? <button type="button" className="thread-nav__action tt-focusable" aria-label={`Rename ${title}`} title="Rename thread" onClick={() => setRenaming(true)}><Pencil size={16} aria-hidden="true" /></button> : null}
      {/* A name the user typed is never written over, so this thread's own name is the one offered for rewriting. */}
      {!archived && row.thread.titleSource !== 'user'
        ? <button type="button" className="thread-nav__action tt-focusable" aria-label={`Regenerate title for ${title}`} title="Regenerate title" disabled={busy} onClick={() => void command({ type: 'regenerate-thread-title', threadId: row.thread.id })}><Sparkles size={16} aria-hidden="true" /></button>
        : null}
      {row.settledBy === null
        ? <button type="button" className="thread-nav__action tt-focusable" aria-label={`Settle ${title}`} title="Settle thread" disabled={busy} onClick={() => void settle(row.thread, row.project)}><Archive size={16} aria-hidden="true" /></button>
        : row.settledBy === 'thread'
          ? <button type="button" className="thread-nav__action tt-focusable" aria-label={`Restore ${title}`} title="Restore thread" disabled={busy} onClick={() => void command({ type: 'restore-thread', threadId: row.thread.id })}><ArchiveRestore size={16} aria-hidden="true" /></button>
          : null}
    </span>
    {settleDialog}
  </li>
})

/** A folder's key in the sidebar's collapsed set; a project can appear in both sections. */
const folderKey = (section: Section, folderId: string): string => `${section}:${folderId}`

/** One project folder and its rows. Memoised for the same reason a row is: its folder is shared across updates. */
const FolderView = memo(function FolderView({ folder, section, panes, activeProjectId, expanded, unseen, liveClock, onToggle, onOpen, onNewThread, command, globalLaneBusy, busyThreadIds }: {
  readonly folder: ProjectFolder; readonly section: Section; readonly panes: PaneActions; readonly activeProjectId: string | null
  readonly expanded: boolean; readonly onToggle: (key: string) => void; readonly onOpen: (threadId: string) => void
  readonly unseen: ReadonlySet<string>; readonly liveClock: boolean
  readonly onNewThread: (projectId: string) => void; readonly command: Command
  /** Settling or restoring a whole project moves every thread of it at once, so it waits on the global lane. */
  readonly globalLaneBusy: boolean
  /** The threads whose own lane is running; each row reads only its own entry. */
  readonly busyThreadIds: readonly string[] | undefined
}): ReactNode {
  const listId = `thread-folder-${section}-${folder.id}`
  const indicatorsId = `${listId}-indicators`
  const project = folder.project
  return <div className="thread-folder" data-section={section} data-active={activeProjectId === folder.id || undefined}>
    <div className="thread-folder__head">
      {/* The toggle includes the visible count in its accessible name, with the project title first. */}
      <button type="button" className="thread-folder__toggle tt-focusable" aria-expanded={expanded} aria-controls={listId} onClick={() => onToggle(folderKey(section, folder.id))}
        aria-label={`${folder.title} ${plural(folder.rows.length, 'thread')}`} aria-describedby={!expanded && (folder.working || folder.needs) ? indicatorsId : undefined} title={project?.path}>
        <ChevronRight size={12} aria-hidden="true" className="thread-folder__chevron" />
        <Folder size={14} aria-hidden="true" /><span className="thread-folder__title">{folder.title}</span><span className="thread-folder__count" aria-hidden="true">{folder.rows.length}</span>
        {!expanded ? <Indicators id={indicatorsId} working={folder.working} needs={folder.needs} /> : null}
      </button>
      {project !== undefined ? <span className="thread-folder__actions">
        {section === 'open' ? <button type="button" className="thread-nav__action tt-focusable" aria-label={`New thread in ${folder.title}`} title="New thread here" onClick={() => onNewThread(folder.id)}><SquarePen size={16} aria-hidden="true" /></button> : null}
        {folder.settled || section === 'open' ? <ProjectSettleAction projectId={folder.id} title={folder.title} settled={folder.settled} disabled={globalLaneBusy} command={command} /> : null}
      </span> : null}
    </div>
    {expanded ? <ul className="thread-folder__rows" id={listId}>
      {folder.rows.map(row => <ThreadNavRow key={row.thread.id} row={row} current={panes.currentThreadId === row.thread.id} open={panes.openThreadIds.includes(row.thread.id)} busy={isThreadBusy({ busyThreadIds }, row.thread.id)}
        unseen={unseen.has(row.thread.id)} liveClock={liveClock} onOpen={onOpen} command={command} panes={panes} />)}
      {!folder.rows.length ? <li className="thread-nav__empty">{section === 'open' ? 'No open threads.' : 'No threads yet.'}</li> : null}
    </ul> : null}
  </div>
})

/** The Threads sidebar: project folders of open work, then the Settled shelf. */
export function ThreadSidebar({ state, command, organization, query, liveClock = true, mode = 'threads', onMode = () => {}, onQuery, onOpen, onNewThread,
  currentThreadId, openThreadIds, onOpenBeside, onDragThread, title }: PaneActions & {
  readonly state: AgentState
  readonly command: Command
  readonly organization: WorkspaceOrganization
  readonly query: string
  /** The hidden page heading the frame carries; `null` beside a page that has its own. */
  readonly title?: string | null
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
  // One object for the whole list, rebuilt only when a pane action actually changes: every row compares it.
  const panes = useMemo<PaneActions>(() => ({ currentThreadId, openThreadIds, onOpenBeside, onDragThread }),
    [currentThreadId, openThreadIds, onOpenBeside, onDragThread])
  // Opaque client keys can contain any separator; the list boundary is encoded explicitly.
  const onScreenKey = JSON.stringify(currentThreadId === null ? openThreadIds : [...openThreadIds, currentThreadId])
  useEffect(() => { showThreads(JSON.parse(onScreenKey) as string[]); return () => showThreads([]) }, [onScreenKey])
  const unseen = useFinishedUnseen()
  const searching = query.trim() !== ''
  const toggle = useCallback((key: string): void => setCollapsed(previous => {
    const next = new Set(previous)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  }), [])
  const folderView = (section: Section) => (folder: ProjectFolder): ReactNode => {
    const key = folderKey(section, folder.id)
    return <FolderView key={key} folder={folder} section={section} panes={panes} activeProjectId={state.activeProjectId} unseen={unseen} liveClock={liveClock}
      expanded={searching || !collapsed.has(key)} onToggle={toggle} onOpen={onOpen} onNewThread={onNewThread} command={command} globalLaneBusy={state.globalLaneBusy} busyThreadIds={state.busyThreadIds} />
  }
  const { open, settled } = organization
  const settledThreads = settled.reduce((count, folder) => count + folder.rows.length, 0)
  const settledWorking = settled.reduce((count, folder) => count + folder.working, 0)
  const settledNeeds = settled.reduce((count, folder) => count + folder.needs, 0)
  const settledShown = settledOpen || searching
  return <SidebarFrame state={state} command={command} mode={mode} onMode={onMode} label="Thread sidebar" query={query} searchPlaceholder="Search threads" onQuery={onQuery}
    onNew={() => onNewThread()} newLabel="New thread" NewIcon={SquarePen} title={title}
    collapsedContent={<nav aria-label="Threads">{[...open.flatMap(folder => folder.rows), ...settled.flatMap(folder => folder.rows).filter(row => row.thread.id === currentThreadId)].map(row => <button key={row.thread.id} type="button" className="thread-nav__rail-thread tt-focusable" aria-label={row.thread.title} title={`${row.thread.title} · ${row.stateLabel}`} aria-current={currentThreadId === row.thread.id ? 'page' : undefined} onClick={() => onOpen(row.thread.id)}>
      <span aria-hidden="true">{row.thread.title.slice(0, 1)}</span><span className="thread-nav__ring" data-state={row.state} data-waiting={row.waitingFor ?? undefined} data-disconnected={row.connected ? undefined : true} aria-hidden="true" />
    </button>)}</nav>}>
      <section aria-label="Projects">
        {open.map(folderView('open'))}
        {!open.length ? <p className="thread-nav__empty">{searching ? 'No matching open threads.' : state.host.projects.length ? 'All caught up.' : 'Add a project folder to start.'}</p> : null}
      </section>
      <section aria-label="Settled" className="thread-nav__shelf">
        <button className="thread-nav__settled tt-focusable" type="button" aria-expanded={settledShown} onClick={() => setSettledOpen(!settledOpen)}
          aria-label={[`Settled ${plural(settledThreads, 'thread')}`, settledNeeds ? `${settledNeeds} waiting on you` : '', settledWorking ? `${settledWorking} working` : ''].filter(Boolean).join(', ')}>
          <ChevronRight size={13} aria-hidden="true" className="thread-folder__chevron" />
          <span>Settled</span>
          {!settledShown ? <Indicators working={settledWorking} needs={settledNeeds} /> : null}
        </button>
        {settledShown ? <div>{settled.map(folderView('settled'))}{!settled.length ? <p className="thread-nav__empty">No settled threads.</p> : null}</div> : null}
      </section>
      {searching && !organization.matching ? <p className="thread-nav__empty">Nothing matches "{query}".</p> : null}
  </SidebarFrame>
}
