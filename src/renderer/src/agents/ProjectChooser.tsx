import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Folder, FolderPlus, Search } from 'lucide-react'
import type { AgentProject, AgentState, ProviderId } from '../../../shared/agents'
import type { AgentConnection } from './AgentContext'
import { hostIdOf, listedHostName } from './HostBadge'
import { FolderBrowserDialog } from './FolderBrowserDialog'
import { folderKey, folderName, projectAtFolder, projectOnHost } from './projectFolders'
import { isCompositionKey } from './composerKeys'

export { folderKey, folderName } from './projectFolders'

/** A known project, or a folder from disk that is not a project yet; `isNew` when it was named with New folder and is not made yet. */
export type ProjectChoice = { readonly project: AgentProject; readonly folder?: undefined } | { readonly project?: undefined; readonly folder: string; readonly isNew?: true }

/**
 * The first step of New thread and New terminal: a folder from disk or one of the projects, searched and chosen by
 * keyboard. The search sits in the dialog's header and the list in its body, so both come back as nodes.
 */
export function useProjectChooser(state: AgentState, onChoose: (choice: ProjectChoice) => void, options: {
  /** Lists only this host's projects, as New thread does once a host is chosen, and browses this host's folders. */
  readonly hostId?: string | undefined
  readonly disabled?: boolean | undefined
} = {}): {
  readonly search: ReactNode; readonly choices: ReactNode; readonly focusSearch: () => void
} {
  const search = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const latestState = useRef(state)
  latestState.current = state
  const hostId = options.hostId
  // The same folder on two hosts is two projects, so a host is chosen before the folders are made unique.
  const projects = state.host.projects.filter(item => hostId === undefined || hostIdOf(item) === hostId)
    .filter((item, index, entries) => entries.findIndex(other => folderKey(other.path) === folderKey(item.path)) === index)
    .filter(item => `${item.title} ${item.path}`.toLowerCase().includes(query.toLowerCase()))
  useEffect(() => { document.querySelector('.new-thread-dialog [data-highlighted]')?.scrollIntoView?.({ block: 'nearest' }) }, [highlight])
  // The folders offered are the ones on the host the thread will run on, listed by that host.
  const browseHostId = hostId ?? state.hostId ?? ''
  const browseHost = state.connections?.find(host => host.hostId === browseHostId)
  const remote = browseHost?.kind === 'remote'
  const [browsing, setBrowsing] = useState(false)
  useEffect(() => { setHighlight(0); setError(null) }, [hostId])
  const browse = (): void => { if (options.disabled) return; setError(null); setBrowsing(true) }
  const chooseFolder = (path: string, isNew: boolean): void => {
    if (options.disabled) return
    setBrowsing(false)
    const existing = projectAtFolder(latestState.current.host.projects, browseHostId, path)
    onChoose(existing ? { project: existing } : { folder: path, ...(isNew ? { isNew: true as const } : {}) })
  }
  const choose = (index: number): void => {
    if (options.disabled) return
    if (index === 0) { browse(); return }
    const choice = projects[index - 1]
    if (choice) { setError(null); onChoose({ project: choice }) }
  }
  return {
    focusSearch: () => search.current?.focus(),
    search: <><Search size={16} aria-hidden="true" /><input ref={search} type="search" aria-label="Search projects" placeholder="Search projects..." value={query}
      onChange={event => { setQuery(event.target.value); setHighlight(0) }}
      onKeyDown={event => {
        if (isCompositionKey(event.nativeEvent)) return
        const count = projects.length + 1
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && count > 0) { event.preventDefault(); setHighlight(current => (current + (event.key === 'ArrowDown' ? 1 : count - 1)) % count) }
        if (event.key === 'Enter') { event.preventDefault(); choose(highlight) }
      }} /></>,
    choices: <div className="new-thread-dialog__choices">
      <h3>Sources</h3>
      <button className="new-thread-choice" type="button" data-highlighted={highlight === 0 || undefined} onMouseEnter={() => setHighlight(0)} onClick={browse}><FolderPlus size={19} /><span><strong>{remote && browseHost ? `Folder on ${listedHostName(browseHost)}` : 'Local folder'}</strong><small>{remote && browseHost ? `Browse folders on ${listedHostName(browseHost)}` : 'Browse a folder on disk'}</small></span><ChevronRight size={15} /></button>
      <h3>Projects</h3>
      {projects.map((item, index) => <button className="new-thread-choice" type="button" key={item.id} data-highlighted={highlight === index + 1 || undefined} onMouseEnter={() => setHighlight(index + 1)} onClick={() => choose(index + 1)}><Folder size={18} /><span><strong>{item.title}</strong><small>{item.path}</small></span><ChevronRight size={15} /></button>)}
      {!projects.length && <p className="new-thread-dialog__empty">{query ? 'No matching projects.' : remote ? 'No projects on this host yet.' : 'Choose a folder to start your first project.'}</p>}
      {error && <p className="agent-error" role="alert">{error}</p>}
      {browsing ? <FolderBrowserDialog state={state} hostId={browseHostId} heading="Choose a folder for the new thread"
        onUse={choice => chooseFolder(choice.path, choice.isNew === true)} onClose={() => setBrowsing(false)} /> : null}
    </div>,
  }
}

/**
 * The project for a folder chosen in a New dialog, created when it does not exist yet. A missing acknowledgement is
 * not permission to add the folder again: `attempted` keeps the folders already sent, and a second try only checks.
 * A folder named with New folder is sent to be made; any other is sent as existing, so one that has gone is refused.
 */
export async function projectForFolder({ folder, isNew = false, command, latest, attempted, providerId, hostId }: {
  readonly folder: string
  readonly isNew?: boolean
  readonly command: AgentConnection['command']
  readonly latest: () => AgentState | null
  readonly attempted: Set<string>
  readonly providerId: ProviderId | undefined
  /** The host the folder is on, so the same path on another host is not taken for it. */
  readonly hostId?: string | undefined
}): Promise<{ readonly project: AgentProject; readonly error: null } | { readonly project: null; readonly error: string }> {
  const key = folderKey(folder)
  const attemptKey = `${hostId ?? ''}:${providerId ?? ''}:${key}`
  const findProject = (snapshot: AgentState | null): AgentProject | null => snapshot?.host.projects.find(item => (hostId === undefined || projectOnHost(item, hostId)) && folderKey(item.path) === key) ?? null
  let project = findProject(latest())
  let acknowledgement: AgentState | null = null
  if (!project && !attempted.has(attemptKey)) {
    attempted.add(attemptKey)
    acknowledgement = await command({ type: 'create-project', title: folderName(folder), path: folder, ...(isNew ? {} : { useExisting: true }), ...(providerId ? { provider: providerId } : {}) })
    project = findProject(acknowledgement) ?? findProject(latest())
  }
  if (!project) {
    const refreshed = await command({ type: 'refresh' })
    project = findProject(refreshed) ?? findProject(latest())
    if (!project) return { project: null, error: refreshed?.error ?? acknowledgement?.error ?? 'Still waiting for this folder’s project. Try again to check its status; the folder will not be added twice.' }
  }
  return { project, error: null }
}
