import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ChevronRight, Folder, FolderGit2, FolderPlus, Search, X } from 'lucide-react'
import type { AgentProject, AgentRuntimeMode, AgentState } from '../../../shared/agents'
import type { AgentConnection } from './AgentContext'
import { Button } from '../components/Button'
import './newThread.css'
import { ThreadOptionFields } from './ThreadOptions'

type WorkingCopyChoice = 'independent' | 'shared'
const WORKING_COPY_CHOICES: ReadonlyArray<{ readonly value: WorkingCopyChoice; readonly label: string; readonly hint: string; readonly Icon: typeof Folder }> = [
  { value: 'independent', label: 'New worktree', hint: 'Its own Git branch and folder. Folders without Git are used as they are.', Icon: FolderGit2 },
  { value: 'shared', label: 'Project folder', hint: 'Works in the project folder alongside its other threads.', Icon: Folder },
]

/** One key per folder on disk, so a project is never added twice under different spellings. */
export function folderKey(path: string): string {
  // Native Windows paths can arrive with either separator. POSIX paths retain case.
  const windows = /^[a-z]:[\\/]|^[\\/]{2}/i.test(path)
  const normalized = (windows ? path.replace(/\\/g, '/') : path).replace(/\/+$/, '')
  return windows ? normalized.toLowerCase() : normalized
}

export function NewThreadDialog({ state, command, onClose, onCreated, managed = false, initialProjectId }: {
  readonly state: AgentState
  readonly command: AgentConnection['command']
  readonly onClose: () => void
  readonly onCreated: () => void
  readonly managed?: boolean
  /** Opens straight to the thread form for this project, as "New thread here" does. */
  readonly initialProjectId?: string | undefined
}): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [project, setProject] = useState<AgentProject | null>(() => state.host.projects.find(item => item.id === initialProjectId) ?? null)
  const [folder, setFolder] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [modelId, setModelId] = useState(() => state.host.models.find(model => model.id === state.configuration.defaultModelId && model.ready)?.id ?? state.host.models.find(model => model.ready)?.id ?? '')
  const [reasoningEffort, setReasoningEffort] = useState<string | undefined>()
  const [runtimeMode, setRuntimeMode] = useState<AgentRuntimeMode | undefined>()
  // Chosen on purpose for every new thread; existing threads keep the folder they already use.
  const [workingCopy, setWorkingCopy] = useState<WorkingCopyChoice>('independent')
  const workingCopyHint = useId()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latestState = useRef(state)
  latestState.current = state
  const creating = useRef(false)
  const completed = useRef(false)
  // A missing acknowledgement is not permission to issue another mutation.
  // Keep attempts even when the user goes back and chooses the same folder.
  const attemptedFolders = useRef(new Set<string>())
  const projects = state.host.projects.filter((item, index, entries) => entries.findIndex(other => folderKey(other.path) === folderKey(item.path)) === index)
    .filter(item => `${item.title} ${item.path}`.toLowerCase().includes(query.toLowerCase()))
  const selectedFolder = project?.path ?? folder
  const selectedModel = state.host.models.find(model => model.id === modelId)
  const selectedProvider = state.host.providers?.find(provider => provider.id === selectedModel?.providerId)
  const canCreateThread = selectedProvider?.capabilities.threads ?? state.host.capabilities.threads
  const connected = selectedModel?.ready === true && (selectedModel.providerId && state.host.providers
    ? state.host.providers.some(provider => provider.id === selectedModel.providerId && provider.connection === 'connected')
    : state.connection === 'connected')
  useEffect(() => {
    const previous = document.activeElement
    const element = dialog.current
    if (element?.showModal) element.showModal()
    else element?.setAttribute('open', '')
    search.current?.focus()
    return () => { element?.close?.(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  useEffect(() => { dialog.current?.querySelector('[data-highlighted]')?.scrollIntoView?.({ block: 'nearest' }) }, [highlight])
  // Keyboard creation continues in the form once a folder is chosen.
  useEffect(() => { (selectedFolder ? nameInput : search).current?.focus() }, [selectedFolder])
  useEffect(() => { if (!modelId) setModelId(state.host.models.find(model => model.ready)?.id ?? '') }, [modelId, state.host.models])
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
    if (creating.current || completed.current || submitting || state.busy || !connected || !canCreateThread || !selectedFolder || !modelId) return
    creating.current = true
    setSubmitting(true)
    setError(null)
    try {
      let selectedProject = project
      if (!selectedProject && folder) {
        const key = folderKey(folder)
        const attemptKey = `${selectedModel?.providerId ?? state.configuration.provider}:${key}`
        const findProject = (snapshot: AgentState | null): AgentProject | null => snapshot?.host.projects.find(item => folderKey(item.path) === key) ?? null
        selectedProject = findProject(latestState.current)
        let acknowledgement: AgentState | null = null
        if (!selectedProject && !attemptedFolders.current.has(attemptKey)) {
          const name = folder.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || 'Project'
          attemptedFolders.current.add(attemptKey)
          acknowledgement = await command({ type: 'create-project', title: name, path: folder, useExisting: true, ...(selectedModel?.providerId ? { provider: selectedModel.providerId } : {}) })
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
      const result = await command({ type: 'create-thread', projectId: selectedProject.id, title: title.trim() || 'New thread', modelId, managed, workingCopy,
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
      <label>Thread name<input ref={nameInput} className="tt-input" placeholder="New thread" value={title} disabled={submitting} onChange={event => setTitle(event.target.value)} /></label>
      <fieldset className="new-thread-working-copy" disabled={submitting} aria-describedby={workingCopyHint}>
        <legend>Working copy</legend>
        <div className="new-thread-working-copy__choices">
          {WORKING_COPY_CHOICES.map(choice => <label key={choice.value} className="new-thread-working-copy__choice">
            <input type="radio" name="working-copy" value={choice.value} checked={workingCopy === choice.value} onChange={() => setWorkingCopy(choice.value)} />
            <choice.Icon size={16} aria-hidden="true" /><span>{choice.label}</span>
          </label>)}
        </div>
        <p id={workingCopyHint}>{WORKING_COPY_CHOICES.find(choice => choice.value === workingCopy)!.hint}</p>
      </fieldset>
      <ThreadOptionFields models={state.host.models} modelId={modelId} reasoningEffort={reasoningEffort} runtimeMode={runtimeMode}
        disabled={submitting} onModel={id => { setModelId(id); setReasoningEffort(undefined); setRuntimeMode(undefined) }} onReasoning={setReasoningEffort} onRuntime={setRuntimeMode} />
      {error && <p className="agent-error" role="alert">{error}</p>}
      {!connected && <p className="agent-muted">Connect {selectedModel?.provider ?? 'a provider'} in Settings → Providers before creating a thread.</p>}
      <div className="new-thread-dialog__submit"><Button type="submit" disabled={submitting || state.busy || !connected || !modelId || !canCreateThread}>{submitting ? 'Creating...' : 'Create thread'}<ChevronRight size={16} /></Button></div>
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
