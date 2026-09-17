import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Folder, FolderPlus, Search } from 'lucide-react'
import type { AgentProject, AgentState, ProviderId } from '../../../shared/agents'
import type { AgentConnection } from './AgentContext'

/** One key per folder on disk, so a project is never added twice under different spellings. */
export function folderKey(path: string): string {
  // Native Windows paths can arrive with either separator. POSIX paths retain case.
  const windows = /^[a-z]:[\\/]|^[\\/]{2}/i.test(path)
  const normalized = (windows ? path.replace(/\\/g, '/') : path).replace(/\/+$/, '')
  return windows ? normalized.toLowerCase() : normalized
}

/** The last segment of a folder path, for naming a project after it. */
export function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || 'Project'
}

/** A known project, or a folder from disk that is not a project yet. */
export type ProjectChoice = { readonly project: AgentProject; readonly folder?: undefined } | { readonly project?: undefined; readonly folder: string }

/**
 * The first step of New thread and New terminal: a folder from disk or one of the projects, searched and chosen by
 * keyboard. The search sits in the dialog's header and the list in its body, so both come back as nodes.
 */
export function useProjectChooser(state: AgentState, onChoose: (choice: ProjectChoice) => void): {
  readonly search: ReactNode; readonly choices: ReactNode; readonly focusSearch: () => void
} {
  const search = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const latestState = useRef(state)
  latestState.current = state
  const projects = state.host.projects.filter((item, index, entries) => entries.findIndex(other => folderKey(other.path) === folderKey(item.path)) === index)
    .filter(item => `${item.title} ${item.path}`.toLowerCase().includes(query.toLowerCase()))
  useEffect(() => { document.querySelector('.new-thread-dialog [data-highlighted]')?.scrollIntoView?.({ block: 'nearest' }) }, [highlight])
  const browse = async (): Promise<void> => {
    setError(null)
    try {
      const picker = window.sotto?.agents?.chooseProjectDirectory
      if (!picker) { setError('Folder browsing is unavailable. Reopen Sotto and try again.'); return }
      const path = await picker()
      if (!path) return
      const existing = latestState.current.host.projects.find(item => folderKey(item.path) === folderKey(path))
      onChoose(existing ? { project: existing } : { folder: path })
    } catch { setError('Could not open the folder browser. Try again.') }
  }
  const choose = (index: number): void => {
    if (index === 0) { void browse(); return }
    const choice = projects[index - 1]
    if (choice) { setError(null); onChoose({ project: choice }) }
  }
  return {
    focusSearch: () => search.current?.focus(),
    search: <><Search size={16} aria-hidden="true" /><input ref={search} type="search" aria-label="Search projects" placeholder="Search projects..." value={query}
      onChange={event => { setQuery(event.target.value); setHighlight(0) }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setHighlight(current => (current + (event.key === 'ArrowDown' ? 1 : projects.length)) % (projects.length + 1)) }
        if (event.key === 'Enter') { event.preventDefault(); choose(highlight) }
      }} /></>,
    choices: <div className="new-thread-dialog__choices">
      <h3>Sources</h3>
      <button className="new-thread-choice" type="button" data-highlighted={highlight === 0 || undefined} onMouseEnter={() => setHighlight(0)} onClick={() => void browse()}><FolderPlus size={19} /><span><strong>Local folder</strong><small>Browse a folder on disk</small></span><ChevronRight size={15} /></button>
      <h3>Projects</h3>
      {projects.map((item, index) => <button className="new-thread-choice" type="button" key={item.id} data-highlighted={highlight === index + 1 || undefined} onMouseEnter={() => setHighlight(index + 1)} onClick={() => choose(index + 1)}><Folder size={18} /><span><strong>{item.title}</strong><small>{item.path}</small></span><ChevronRight size={15} /></button>)}
      {!projects.length && <p className="new-thread-dialog__empty">{query ? 'No matching projects.' : 'Choose a folder to start your first project.'}</p>}
      {error && <p className="agent-error" role="alert">{error}</p>}
    </div>,
  }
}

/**
 * The project for a folder chosen in a New dialog, created when it does not exist yet. A missing acknowledgement is
 * not permission to add the folder again: `attempted` keeps the folders already sent, and a second try only checks.
 */
export async function projectForFolder({ folder, command, latest, attempted, providerId }: {
  readonly folder: string
  readonly command: AgentConnection['command']
  readonly latest: () => AgentState | null
  readonly attempted: Set<string>
  readonly providerId: ProviderId | undefined
}): Promise<{ readonly project: AgentProject; readonly error: null } | { readonly project: null; readonly error: string }> {
  const key = folderKey(folder)
  const attemptKey = `${providerId ?? ''}:${key}`
  const findProject = (snapshot: AgentState | null): AgentProject | null => snapshot?.host.projects.find(item => folderKey(item.path) === key) ?? null
  let project = findProject(latest())
  let acknowledgement: AgentState | null = null
  if (!project && !attempted.has(attemptKey)) {
    attempted.add(attemptKey)
    acknowledgement = await command({ type: 'create-project', title: folderName(folder), path: folder, useExisting: true, ...(providerId ? { provider: providerId } : {}) })
    project = findProject(acknowledgement) ?? findProject(latest())
  }
  if (!project) {
    const refreshed = await command({ type: 'refresh' })
    project = findProject(refreshed) ?? findProject(latest())
    if (!project) return { project: null, error: refreshed?.error ?? acknowledgement?.error ?? 'Still waiting for this folder’s project. Try again to check its status; the folder will not be added twice.' }
  }
  return { project, error: null }
}
