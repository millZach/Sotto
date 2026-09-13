import React, { useState, type ReactNode } from 'react'
import { Archive, ArchiveRestore, ChevronRight, Folder, FolderPlus, Search, SquarePen, X } from 'lucide-react'
import type { AgentState } from '../../../shared/agents'
import { Button } from '../components/Button'
import type { AgentConnection } from './AgentContext'
import { folderKey } from './NewThreadDialog'
import { ProviderMark } from './ProviderMark'
import type { ProjectFolder, ThreadRow, WorkspaceOrganization } from './threadFacts'

type Command = AgentConnection['command']
type Section = 'open' | 'settled'

/** Open a folder from disk as a Sotto project, or open the project that already has it. */
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

export function useAddProject(state: AgentState, command: Command): { readonly add: () => Promise<void>; readonly adding: boolean; readonly error: string | null; readonly clearError: () => void } {
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const add = async (): Promise<void> => {
    if (adding) return
    setError(null)
    const picker = window.sotto?.agents?.chooseProjectDirectory
    if (!picker) { setError('Folder browsing is unavailable. Reopen Sotto and try again.'); return }
    setAdding(true)
    try {
      const path = await picker()
      if (!path) return
      const existing = state.host.projects.find(project => folderKey(project.path) === folderKey(path))
      if (existing) { await command({ type: 'select-project', projectId: existing.id }); return }
      const provider = state.host.models.find(model => model.id === state.configuration.defaultModelId)?.providerId
      const title = path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || 'Project'
      const result = await command({ type: 'create-project', title, path, useExisting: true, ...(provider ? { provider } : {}) })
      if (result === null || result.error !== null) setError(result?.error ?? 'Could not confirm the new project. Choose the folder again to check; it will not be added twice.')
    } catch { setError('Could not open the folder browser. Try again.') }
    finally { setAdding(false) }
  }
  return { add, adding, error, clearError: () => setError(null) }
}

function Indicators({ working, needs }: { readonly working: number; readonly needs: number }): ReactNode {
  if (!working && !needs) return null
  return <span className="thread-nav__indicators">
    {needs ? <span data-state="needs" title={`${needs} waiting on you`}><i aria-hidden="true" /><span className="tt-visually-hidden">{needs} waiting on you</span></span> : null}
    {working ? <span data-state="working" title={`${working} working`}><i aria-hidden="true" /><span className="tt-visually-hidden">{working} working</span></span> : null}
  </span>
}

function ThreadNavRow({ row, current, busy, onOpen, command }: {
  readonly row: ThreadRow; readonly current: boolean; readonly busy: boolean; readonly onOpen: (threadId: string) => void; readonly command: Command
}): ReactNode {
  const title = row.thread.title
  const status = row.settledBy === 'provider' ? row.stateLabel : row.state === 'done' && row.settledBy !== null ? 'Settled' : row.stateLabel
  return <li className="thread-nav__row" data-current={current || undefined}>
    <button type="button" className="thread-nav__item tt-focusable" aria-label={title} aria-current={current ? 'page' : undefined} onClick={() => onOpen(row.thread.id)}>
      <span className="thread-nav__mark" data-provider={row.providerId ?? 'other'} title={row.provider}><ProviderMark provider={row.providerId} name={row.provider} /></span>
      <span className="thread-nav__title">{title}</span>
      <time className="thread-nav__time" title={Number.isFinite(row.activityAt) ? new Date(row.activityAt).toLocaleString() : 'Last activity unavailable'} dateTime={Number.isFinite(row.activityAt) ? new Date(row.activityAt).toISOString() : undefined}>{row.when}</time>
      <span className="thread-nav__status" data-state={row.state}><i aria-hidden="true" /><span className="tt-visually-hidden">{row.provider}, </span>{status}{row.connected ? '' : ' · Disconnected'}</span>
    </button>
    <span className="thread-nav__row-actions">
      {row.settledBy === null
        ? <button type="button" className="thread-nav__action tt-focusable" aria-label={`Settle ${title}`} title="Settle thread" disabled={busy} onClick={() => void command({ type: 'settle-thread', threadId: row.thread.id })}><Archive size={16} aria-hidden="true" /></button>
        : row.settledBy === 'thread'
          ? <button type="button" className="thread-nav__action tt-focusable" aria-label={`Restore ${title}`} title="Restore thread" disabled={busy} onClick={() => void command({ type: 'restore-thread', threadId: row.thread.id })}><ArchiveRestore size={16} aria-hidden="true" /></button>
          : null}
    </span>
  </li>
}

function FolderView({ folder, section, activeThreadId, activeProjectId, expanded, onToggle, onOpen, onNewThread, command, busy }: {
  readonly folder: ProjectFolder; readonly section: Section; readonly activeThreadId: string | null; readonly activeProjectId: string | null
  readonly expanded: boolean; readonly onToggle: () => void; readonly onOpen: (threadId: string) => void
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
      {folder.rows.map(row => <ThreadNavRow key={row.thread.id} row={row} current={activeThreadId === row.thread.id} busy={busy} onOpen={onOpen} command={command} />)}
      {!folder.rows.length ? <li className="thread-nav__empty">{section === 'open' ? 'No open threads.' : 'No threads yet.'}</li> : null}
    </ul> : null}
  </div>
}

/** The Threads sidebar: project folders of open work, then the Settled shelf. */
export function ThreadSidebar({ state, command, organization, query, onQuery, onOpen, onNewThread }: {
  readonly state: AgentState
  readonly command: Command
  readonly organization: WorkspaceOrganization
  readonly query: string
  readonly onQuery: (query: string) => void
  readonly onOpen: (threadId: string) => void
  readonly onNewThread: (projectId?: string) => void
}): ReactNode {
  const [settledOpen, setSettledOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const addProject = useAddProject(state, command)
  const searching = query.trim() !== ''
  const toggle = (key: string): void => setCollapsed(previous => {
    const next = new Set(previous)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const folderView = (section: Section) => (folder: ProjectFolder): ReactNode => {
    const key = `${section}:${folder.id}`
    return <FolderView key={key} folder={folder} section={section} activeThreadId={state.activeThreadId} activeProjectId={state.activeProjectId}
      expanded={searching || !collapsed.has(key)} onToggle={() => toggle(key)} onOpen={onOpen} onNewThread={onNewThread} command={command} busy={state.busy} />
  }
  const { open, settled } = organization
  const settledThreads = settled.reduce((count, folder) => count + folder.rows.length, 0)
  const settledWorking = settled.reduce((count, folder) => count + folder.working, 0)
  const settledNeeds = settled.reduce((count, folder) => count + folder.needs, 0)
  const settledShown = settledOpen || searching
  return <aside className="thread-nav" aria-label="Thread sidebar">
    <header className="thread-nav__head"><h1>Threads</h1>
      <span className="thread-nav__head-actions">
        <Button variant="ghost" iconOnly aria-label="Add project" title="Add project" disabled={addProject.adding} onClick={() => void addProject.add()}><FolderPlus size={18} /></Button>
        <Button variant="ghost" iconOnly aria-label="New thread" title="New thread" onClick={() => onNewThread()}><SquarePen size={18} /></Button>
      </span>
    </header>
    {addProject.error ? <p className="thread-nav__error" role="alert">{addProject.error}<button type="button" className="thread-nav__action tt-focusable" aria-label="Dismiss" onClick={addProject.clearError}><X size={14} aria-hidden="true" /></button></p> : null}
    <label className="threads-search"><span className="tt-visually-hidden">Search threads</span><Search size={16} aria-hidden="true" />
      <input className="tt-input tt-focusable" type="search" value={query} placeholder="Search threads" onChange={event => onQuery(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); onQuery('') } }} />
      {query ? <button type="button" className="threads-search__clear tt-focusable" aria-label="Clear search" title="Clear search" onClick={() => onQuery('')}><X size={14} /></button> : null}
    </label>
    <div className="thread-nav__scroll">
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
    </div>
  </aside>
}
