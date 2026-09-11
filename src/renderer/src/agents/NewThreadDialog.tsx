import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ChevronRight, Folder, FolderPlus, Search, X } from 'lucide-react'
import type { AgentProject, AgentRuntimeMode, AgentState } from '../../../shared/agents'
import type { AgentConnection } from './AgentContext'
import { Button } from '../components/Button'
import './newThread.css'
import { ThreadOptionFields } from './ThreadOptions'

function folderKey(path: string): string {
  // Native Windows paths can arrive with either separator. POSIX paths retain case.
  const windows = /^[a-z]:[\\/]|^[\\/]{2}/i.test(path)
  const normalized = (windows ? path.replace(/\\/g, '/') : path).replace(/\/+$/, '')
  return windows ? normalized.toLowerCase() : normalized
}

export function NewThreadDialog({ state, command, onClose, onCreated, managed = false }: {
  readonly state: AgentState
  readonly command: AgentConnection['command']
  readonly onClose: () => void
  readonly onCreated: () => void
  readonly managed?: boolean
}): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [project, setProject] = useState<AgentProject | null>(null)
  const [folder, setFolder] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [modelId, setModelId] = useState(() => state.host.models.find(model => model.id === state.configuration.defaultModelId && model.ready)?.id ?? state.host.models.find(model => model.ready)?.id ?? '')
  const [reasoningEffort, setReasoningEffort] = useState<string | undefined>()
  const [runtimeMode, setRuntimeMode] = useState<AgentRuntimeMode | undefined>()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latestState = useRef(state)
  latestState.current = state
  const creating = useRef(false)
  const completed = useRef(false)
  // A missing acknowledgement is not permission to issue another mutation.
  // Keep attempts even when the user goes back and chooses the same folder.
  const attemptedFolders = useRef(new Set<string>())
  const projects = state.host.projects.filter(item => `${item.title} ${item.path}`.toLowerCase().includes(query.toLowerCase()))
  const selectedFolder = project?.path ?? folder
  const connected = state.connection === 'connected'
  useEffect(() => {
    const previous = document.activeElement
    const element = dialog.current
    if (element?.showModal) element.showModal()
    else element?.setAttribute('open', '')
    search.current?.focus()
    return () => { element?.close?.(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  useEffect(() => { dialog.current?.querySelector('[data-highlighted]')?.scrollIntoView?.({ block: 'nearest' }) }, [highlight])
  useEffect(() => { if (!selectedFolder) search.current?.focus() }, [selectedFolder])
  const browse = async (): Promise<void> => {
    setError(null)
    try {
      const picker = window.sotto?.agents?.chooseProjectDirectory
      if (!picker) { setError('Folder browsing is unavailable. Reopen Sotto and try again.'); return }
      const path = await picker()
      if (!path) return
      const existing = latestState.current.host.projects.find(item => folderKey(item.path) === folderKey(path))
      if (existing) setProject(existing)
      else setFolder(path)
    } catch { setError('Could not open the folder browser. Try again.') }
  }
  const choose = (index: number): void => {
    if (index === 0) { void browse(); return }
    const choice = projects[index - 1]
    if (choice) { setProject(choice); setError(null) }
  }
  const create = async (): Promise<void> => {
    if (creating.current || completed.current || submitting || state.busy || !connected || !selectedFolder || !modelId) return
    creating.current = true
    setSubmitting(true)
    setError(null)
    try {
      let selectedProject = project
      if (!selectedProject && folder) {
        const key = folderKey(folder)
        const findProject = (snapshot: AgentState | null): AgentProject | null => snapshot?.host.projects.find(item => folderKey(item.path) === key) ?? null
        selectedProject = findProject(latestState.current)
        let acknowledgement: AgentState | null = null
        if (!selectedProject && !attemptedFolders.current.has(key)) {
          const name = folder.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || 'Project'
          attemptedFolders.current.add(key)
          acknowledgement = await command({ type: 'create-project', title: name, path: folder, useExisting: true })
          selectedProject = findProject(acknowledgement) ?? findProject(latestState.current)
        }
        if (!selectedProject) {
          const refreshed = await command({ type: 'refresh' })
          selectedProject = findProject(refreshed) ?? findProject(latestState.current)
          if (!selectedProject) {
            setError(refreshed?.error ?? acknowledgement?.error ?? 'Still waiting for this folder’s project. Try again to check its status; the folder will not be added twice.')
            return
          }
        }
        setProject(selectedProject)
      }
      if (!selectedProject) return
      const result = await command({ type: 'create-thread', projectId: selectedProject.id, title: title.trim() || 'New thread', modelId, managed,
        ...(reasoningEffort ? { reasoningEffort } : {}), ...(runtimeMode ? { runtimeMode } : {}) })
      if (!result || result.error) { setError(result?.error ?? 'Could not confirm thread creation. Your choices are retained.'); return }
      completed.current = true
      onCreated()
    } catch { setError('Could not confirm creation. Your choices are retained; try again to check the existing action.') }
    finally { creating.current = false; setSubmitting(false) }
  }
  return <dialog ref={dialog} className="new-thread-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!submitting) onClose() }}
    onClick={event => { if (event.target === event.currentTarget && !submitting) onClose() }}>
    <h2 id={titleId} className="tt-visually-hidden">New thread</h2>
    <header className="new-thread-dialog__search">
      <Button variant="ghost" iconOnly aria-label={selectedFolder ? 'Back to projects' : 'Close New thread'} disabled={submitting} onClick={() => { if (selectedFolder) { setProject(null); setFolder(null); setError(null) } else onClose() }}><ArrowLeft size={17} /></Button>
      {selectedFolder ? <span>New thread</span> : <><Search size={16} aria-hidden="true" /><input ref={search} type="search" aria-label="Search projects" placeholder="Search projects..." value={query}
        onChange={event => { setQuery(event.target.value); setHighlight(0) }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setHighlight(current => (current + (event.key === 'ArrowDown' ? 1 : projects.length)) % (projects.length + 1)) }
          if (event.key === 'Enter') { event.preventDefault(); choose(highlight) }
        }} /></>}
      <Button variant="ghost" iconOnly aria-label="Close new thread dialog" disabled={submitting} onClick={onClose}><X size={16} /></Button>
    </header>
    {selectedFolder ? <form className="new-thread-dialog__form" onSubmit={event => { event.preventDefault(); void create() }}>
      <div className="new-thread-dialog__folder"><Folder size={22} /><div><strong>{project?.title ?? selectedFolder.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1)}</strong><span>{selectedFolder}</span></div><Button variant="ghost" disabled={submitting} onClick={() => { setProject(null); setFolder(null) }}>Change</Button></div>
      <label>Thread name<input className="tt-input" placeholder="New thread" value={title} disabled={submitting} onChange={event => setTitle(event.target.value)} /></label>
      <ThreadOptionFields models={state.host.models} modelId={modelId} reasoningEffort={reasoningEffort} runtimeMode={runtimeMode}
        disabled={submitting} onModel={id => { setModelId(id); setReasoningEffort(undefined); setRuntimeMode(undefined) }} onReasoning={setReasoningEffort} onRuntime={setRuntimeMode} />
      {error && <p className="agent-error" role="alert">{error}</p>}
      {!connected && <p className="agent-muted">Connect your provider before creating a thread.</p>}
      <div className="new-thread-dialog__submit"><Button type="submit" disabled={submitting || state.busy || !connected || !modelId || !state.host.capabilities.threads}>{submitting ? 'Creating...' : 'Create thread'}<ChevronRight size={16} /></Button></div>
    </form> : <div className="new-thread-dialog__choices">
      <h3>Sources</h3>
      <button className="new-thread-choice" type="button" data-highlighted={highlight === 0 || undefined} onMouseEnter={() => setHighlight(0)} onClick={() => void browse()}><FolderPlus size={19} /><span><strong>Local folder</strong><small>Browse a folder on disk</small></span><ChevronRight size={15} /></button>
      <h3>Projects</h3>
      {projects.map((item, index) => <button className="new-thread-choice" type="button" key={item.id} data-highlighted={highlight === index + 1 || undefined} onMouseEnter={() => setHighlight(index + 1)} onClick={() => choose(index + 1)}><Folder size={18} /><span><strong>{item.title}</strong><small>{item.path}</small></span><ChevronRight size={15} /></button>)}
      {!projects.length && <p className="new-thread-dialog__empty">{query ? 'No matching projects.' : 'Choose a folder to start your first project.'}</p>}
      {error && <p className="agent-error" role="alert">{error}</p>}
    </div>}
    <footer className="new-thread-dialog__keys"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Select</span><span><kbd>Esc</kbd> Close</span></footer>
  </dialog>
}
