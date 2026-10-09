import React, { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Archive, ArchiveRestore, ChevronRight, Columns2, Folder, FolderGit2, GitBranch, Pencil, Sparkles, SquarePen } from 'lucide-react'
import { isThreadBusy, providerWritesShortText, type AgentState } from '../../../shared/agents'
import { isThreadArchived } from '../../../shared/threadActivity'
import { ProviderMark } from './ProviderMark'
import { ThreadNameField } from './ThreadName'
import { describeWorkingCopy, useSettleThread } from './ThreadWorkingCopy'
import type { AgentConnection } from './AgentContext'
import { ProjectSettleAction, SidebarFrame, type SidebarMode } from './SidebarFrame'
import { rowStatus, workingLabel, type ProjectFolder, type ThreadRow, type WorkspaceOrganization } from './threadFacts'
import { THREAD_DRAG_TYPE } from './splitLayout'
import { HostBadge, hostIdOf, listedHosts, type ListedHost } from './HostBadge'

export { useAddProject } from './addProject'

type Command = AgentConnection['command']
type Section = 'open' | 'settled'

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`
/** What follows a row's status while its provider is out of reach: Reconnecting while its host restarts for an update. */
const disconnectedLabel = (row: ThreadRow): string => row.connected ? '' : row.reconnecting ? ' · Reconnecting' : ' · Disconnected'

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
const ThreadNavRow = memo(function ThreadNavRow({ row, current, open, busy, liveClock, onOpen, command, panes, settle }: {
  readonly row: ThreadRow; readonly current: boolean; readonly open: boolean; readonly onOpen: (threadId: string) => void; readonly command: Command
  /** This thread's own lane is running a command. Another thread's work leaves this row's actions live. */
  readonly busy: boolean
  readonly liveClock: boolean
  readonly panes: PaneActions
  readonly settle: ReturnType<typeof useSettleThread>['settle']
}): ReactNode {
  const title = row.thread.title
  // Just finished (ADR-0046) and Babysitting #74 (ADR-0061) both stand where the row would say Done.
  const { text: status, finished, babysitting } = rowStatus(row)
  const besideAvailable = panes.currentThreadId !== null && !current
  const [renaming, setRenaming] = useState(false)
  const renameButton = useRef<HTMLButtonElement>(null)
  const restoreRenameFocus = useRef(false)
  useLayoutEffect(() => {
    if (!renaming && restoreRenameFocus.current) { restoreRenameFocus.current = false; renameButton.current?.focus() }
  }, [renaming])
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
        onRename={next => void command({ type: 'rename-thread', threadId: row.thread.id, title: next })} onDone={restore => { restoreRenameFocus.current = restore; setRenaming(false) }} />
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
        {/* The mark stands for the provider's name; the status below says the name for a screen reader, and hovering says it here. */}
        <span className="thread-nav__provider" title={[row.provider, row.model?.name].filter(Boolean).join(' · ')}>
          <span className="thread-nav__mark" data-provider={row.providerId}><ProviderMark provider={row.providerId} name={row.provider} /></span>
          <span className="thread-nav__model">{row.model?.name ?? ''}</span>
        </span>
        <span id={statusId} className="thread-nav__status" data-state={row.state} data-waiting={row.waitingFor ?? undefined} data-unseen={finished || undefined} data-babysitting={babysitting || undefined} data-disconnected={row.connected ? undefined : true} title={status + disconnectedLabel(row)}><span className="tt-visually-hidden">{row.provider}, </span>{status}{disconnectedLabel(row)}</span>
      </span>
      <span className="thread-nav__branch" data-working-copy-state={copy.status} title={branchName !== copyLabel ? `${branchName} · ${copyLabel}` : copyLabel}>
        <WorkingCopyIcon size={12} aria-hidden="true" />{row.thread.hostLabel ? <span>{row.thread.hostLabel} · </span> : null}
        <span className="thread-nav__branch-name">{branchName}</span>{branchName !== copyLabel ? <span className="thread-nav__copy-kind"> · {copyLabel}</span> : null}
      </span>
    </button>
    <span className="thread-nav__row-actions">
      {besideAvailable && !open ? <button type="button" className="thread-nav__action tt-focusable" aria-label={`Open ${title} beside`} title="Open beside" onClick={() => panes.onOpenBeside(row.thread.id)}><Columns2 size={16} aria-hidden="true" /></button> : null}
      {!archived ? <button ref={renameButton} type="button" className="thread-nav__action tt-focusable" aria-label={`Rename ${title}`} title="Rename thread" onClick={() => setRenaming(true)}><Pencil size={16} aria-hidden="true" /></button> : null}
      {/* A name the user typed is never written over, so this thread's own name is the one offered for rewriting. */}
      {!archived && row.thread.titleSource !== 'user' && providerWritesShortText(row.thread.providerId)
        ? <button type="button" className="thread-nav__action tt-focusable" aria-label={`Regenerate title for ${title}`} title="Regenerate title" disabled={busy} onClick={() => void command({ type: 'regenerate-thread-title', threadId: row.thread.id })}><Sparkles size={16} aria-hidden="true" /></button>
        : null}
      {row.settledBy === null
        ? <button type="button" className="thread-nav__action tt-focusable" aria-label={`Settle ${title}`} title="Settle thread" disabled={busy} onClick={() => void settle(row.thread, row.project)}><Archive size={16} aria-hidden="true" /></button>
        : row.settledBy === 'thread'
          ? <button type="button" className="thread-nav__action tt-focusable" aria-label={`Restore ${title}`} title="Restore thread" disabled={busy} onClick={() => void command({ type: 'restore-thread', threadId: row.thread.id })}><ArchiveRestore size={16} aria-hidden="true" /></button>
          : null}
    </span>
  </li>
})

/** A folder's key in the sidebar's toggled set; a project can appear in both sections. */
export const folderKey = (section: Section, folderId: string): string => `${section}:${folderId}`

/**
 * The folders the user toggled. Every folder starts closed when Sotto starts; what the user opens stays open while
 * the window lives, across pages that remount the sidebar, which is why it is kept in session storage. The e2e
 * harness starts them open, as it holds the clock still, so its journeys and design captures reach the rows.
 */
export const FOLDER_TOGGLES_KEY = 'sotto.threadWorkspace.folderToggles'
const toggleListeners = new Set<() => void>()
/** The last value this window saved, and whether storage refused it; once refused, the window reads its own copy. */
let togglesFallback = '[]'
let togglesUnsaved = false
function readToggles(): string {
  if (togglesUnsaved) return togglesFallback
  try { return sessionStorage.getItem(FOLDER_TOGGLES_KEY) ?? '[]' } catch { return togglesFallback }
}
function parseToggles(stored: string): Set<string> {
  try {
    const value: unknown = JSON.parse(stored)
    return new Set(Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : [])
  } catch { return new Set() }
}
function useFolderToggles(): readonly [(key: string) => boolean, (key: string) => void] {
  const subscribe = useCallback((listener: () => void) => { toggleListeners.add(listener); return () => { toggleListeners.delete(listener) } }, [])
  const stored = useSyncExternalStore(subscribe, readToggles, () => '[]')
  const isOpen = useMemo(() => {
    const toggled = parseToggles(stored)
    const startOpen = window.sottoE2E !== undefined
    return (key: string): boolean => startOpen !== toggled.has(key)
  }, [stored])
  const toggle = useCallback((key: string): void => {
    const next = parseToggles(readToggles())
    if (next.has(key)) next.delete(key); else next.add(key)
    togglesFallback = JSON.stringify([...next])
    try { sessionStorage.setItem(FOLDER_TOGGLES_KEY, togglesFallback); togglesUnsaved = false } catch { togglesUnsaved = true }
    for (const listener of [...toggleListeners]) listener()
  }, [])
  return [isOpen, toggle]
}

/** One project folder and its rows. Memoised for the same reason a row is: its folder is shared across updates. */
const FolderView = memo(function FolderView({ folder, section, panes, activeProjectId, expanded, liveClock, onToggle, onOpen, onNewThread, command, settle, globalLaneBusy, busyThreadIds, host, newThreadShortcut }: {
  readonly folder: ProjectFolder; readonly section: Section; readonly panes: PaneActions; readonly activeProjectId: string | null
  /** The host the project is on, once a remote host is connected; its badge tells same-named projects apart. */
  readonly host?: ListedHost | undefined
  readonly expanded: boolean; readonly onToggle: (key: string) => void; readonly onOpen: (threadId: string) => void
  readonly liveClock: boolean
  readonly onNewThread: (projectId: string) => void; readonly command: Command
  readonly settle: ReturnType<typeof useSettleThread>['settle']
  /** Settling or restoring a whole project moves every thread of it at once, so it waits on the global lane. */
  readonly globalLaneBusy: boolean
  /** The threads whose own lane is running; each row reads only its own entry. */
  readonly busyThreadIds: readonly string[] | undefined
  readonly newThreadShortcut?: { readonly suffix: string; readonly keys: string } | undefined
}): ReactNode {
  const listId = `thread-folder-${section}-${folder.id}`
  const indicatorsId = `${listId}-indicators`
  const project = folder.project
  // The chord opens a thread in the focused pane's project, so only this project's pen answers to it while one of its threads is focused.
  const chordAppliesHere = panes.currentThreadId !== null && folder.rows.some(row => row.thread.id === panes.currentThreadId)
  return <div className="thread-folder" data-section={section} data-active={activeProjectId === folder.id || undefined}>
    <div className="thread-folder__head">
      {/* The toggle includes the visible count in its accessible name, with the project title first. */}
      <button type="button" className="thread-folder__toggle tt-focusable" aria-expanded={expanded} aria-controls={listId} onClick={() => onToggle(folderKey(section, folder.id))}
        aria-label={`${folder.title}${host ? ` on ${host.name}` : ''} ${plural(folder.rows.length, 'thread')}`} aria-describedby={!expanded && (folder.working || folder.needs) ? indicatorsId : undefined} title={project?.path}>
        <ChevronRight size={12} aria-hidden="true" className="thread-folder__chevron" />
        <Folder size={14} aria-hidden="true" /><span className="thread-folder__title">{folder.title}</span>{host ? <HostBadge host={host} /> : null}<span className="thread-folder__count" aria-hidden="true">{folder.rows.length}</span>
        {!expanded ? <Indicators id={indicatorsId} working={folder.working} needs={folder.needs} /> : null}
      </button>
      {project !== undefined ? <span className="thread-folder__actions">
        {section === 'open' ? <button type="button" className="thread-nav__action tt-focusable" aria-label={`New thread in ${folder.title}`}
          title={newThreadShortcut ? `New thread here ${newThreadShortcut.suffix}` : 'New thread here'}
          aria-keyshortcuts={chordAppliesHere ? newThreadShortcut?.keys : undefined}
          onClick={() => onNewThread(folder.id)}><SquarePen size={16} aria-hidden="true" /></button> : null}
        {folder.settled || section === 'open' ? <ProjectSettleAction projectId={folder.id} title={folder.title} settled={folder.settled} disabled={globalLaneBusy} command={command} /> : null}
      </span> : null}
    </div>
    {expanded ? <ul className="thread-folder__rows" id={listId}>
      {folder.rows.map(row => <ThreadNavRow key={row.thread.id} row={row} current={panes.currentThreadId === row.thread.id} open={panes.openThreadIds.includes(row.thread.id)} busy={isThreadBusy({ busyThreadIds }, row.thread.id)}
        liveClock={liveClock} onOpen={onOpen} command={command} panes={panes} settle={settle} />)}
      {!folder.rows.length ? <li className="thread-nav__empty">{section === 'open' ? 'No open threads.' : 'No threads yet.'}</li> : null}
    </ul> : null}
  </div>
})

/** The Threads sidebar: project folders of open work, then the Settled shelf. */
export function ThreadSidebar({ state, command, organization, query, liveClock = true, mode = 'threads', onMode = () => {}, onQuery, onOpen, onNewThread,
  currentThreadId, openThreadIds, onOpenBeside, onDragThread, title, newThreadError, onDismissNewThreadError, newThreadShortcut }: PaneActions & {
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
  /** A pen, the empty page's button or the chooser refused a creation; shown where Add project shows its own. */
  readonly newThreadError?: string | null | undefined
  readonly onDismissNewThreadError?: (() => void) | undefined
  readonly newThreadShortcut?: { readonly suffix: string; readonly keys: string } | undefined
}): ReactNode {
  const [settledOpen, setSettledOpen] = useState(false)
  const settledButton = useRef<HTMLButtonElement>(null)
  const { settle, dialog: settleDialog } = useSettleThread(command, settledButton)
  const [isFolderOpen, toggle] = useFolderToggles()
  // One object for the whole list, rebuilt only when a pane action actually changes: every row compares it.
  const panes = useMemo<PaneActions>(() => ({ currentThreadId, openThreadIds, onOpenBeside, onDragThread }),
    [currentThreadId, openThreadIds, onOpenBeside, onDragThread])
  const searching = query.trim() !== ''
  const connections = state.connections
  const hosts = useMemo(() => listedHosts({ connections }), [connections])
  const folderView = (section: Section) => (folder: ProjectFolder): ReactNode => {
    const key = folderKey(section, folder.id)
    const hostId = hosts.length ? hostIdOf(folder.project) ?? hostIdOf({ id: folder.id }) ?? folder.rows[0]?.thread.hostId : undefined
    return <FolderView key={key} folder={folder} section={section} panes={panes} activeProjectId={state.activeProjectId} liveClock={liveClock}
      host={hosts.find(item => item.hostId === hostId)} newThreadShortcut={newThreadShortcut}
      expanded={searching || isFolderOpen(key)} onToggle={toggle} onOpen={onOpen} onNewThread={onNewThread} command={command} settle={settle} globalLaneBusy={state.globalLaneBusy} busyThreadIds={state.busyThreadIds} />
  }
  const { open, settled } = organization
  const settledThreads = settled.reduce((count, folder) => count + folder.rows.length, 0)
  const settledWorking = settled.reduce((count, folder) => count + folder.working, 0)
  const settledNeeds = settled.reduce((count, folder) => count + folder.needs, 0)
  const settledShown = settledOpen || searching
  // The chord opens the chooser (what the top button does) only while no thread is focused; a focused thread
  // answers it from its own project's pen instead, so the top button's aria-keyshortcuts stands down then.
  const topShortcut = newThreadShortcut ? { title: `New thread ${newThreadShortcut.suffix}`, keys: currentThreadId === null ? newThreadShortcut.keys : undefined } : undefined
  return <SidebarFrame state={state} command={command} mode={mode} onMode={onMode} label="Thread sidebar" query={query} searchPlaceholder="Search threads" onQuery={onQuery}
    onNew={() => onNewThread()} newLabel="New thread" NewIcon={SquarePen} newShortcut={topShortcut} title={title}
    extraError={newThreadError} onDismissExtraError={onDismissNewThreadError}
    collapsedContent={<nav aria-label="Threads">{[...open.flatMap(folder => folder.rows), ...settled.flatMap(folder => folder.rows).filter(row => row.thread.id === currentThreadId)].map(row => <button key={row.thread.id} type="button" className="thread-nav__rail-thread tt-focusable" aria-label={row.thread.title} title={`${row.thread.title} · ${rowStatus(row).text}`} aria-current={currentThreadId === row.thread.id ? 'page' : undefined} onClick={() => onOpen(row.thread.id)}>
      <span aria-hidden="true">{row.thread.title.slice(0, 1)}</span><span className="thread-nav__ring" data-state={row.state} data-waiting={row.waitingFor ?? undefined} data-disconnected={row.connected ? undefined : true} aria-hidden="true" />
    </button>)}</nav>}>
      <section aria-label="Projects">
        {open.map(folderView('open'))}
        {!open.length ? <p className="thread-nav__empty">{searching ? 'No matching open threads.' : state.host.projects.length ? 'All caught up.' : 'Add a project folder to start.'}</p> : null}
      </section>
      <section aria-label="Settled" className="thread-nav__shelf">
        <button ref={settledButton} className="thread-nav__settled tt-focusable" type="button" aria-expanded={settledShown} onClick={() => setSettledOpen(!settledOpen)}
          aria-label={[`Settled ${plural(settledThreads, 'thread')}`, settledNeeds ? `${settledNeeds} waiting on you` : '', settledWorking ? `${settledWorking} working` : ''].filter(Boolean).join(', ')}>
          <ChevronRight size={13} aria-hidden="true" className="thread-folder__chevron" />
          <span>Settled</span>
          {!settledShown ? <Indicators working={settledWorking} needs={settledNeeds} /> : null}
        </button>
        {settledShown ? <div>{settled.map(folderView('settled'))}{!settled.length ? <p className="thread-nav__empty">No settled threads.</p> : null}</div> : null}
      </section>
      {searching && !organization.matching ? <p className="thread-nav__empty">Nothing matches "{query}".</p> : null}
      {settleDialog}
  </SidebarFrame>
}
