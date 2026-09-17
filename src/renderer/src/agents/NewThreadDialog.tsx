import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ChevronRight, Folder, X } from 'lucide-react'
import { defaultThreadModelId, type AgentProject, type AgentRuntimeMode, type AgentState } from '../../../shared/agents'
import type { AgentConnection } from './AgentContext'
import { Button } from '../components/Button'
import './newThread.css'
import { folderName, projectForFolder, useProjectChooser } from './ProjectChooser'
import { ThreadOptionFields } from './ThreadOptions'
import { WorkingCopyFieldset, type WorkingCopyChoice } from './WorkingCopyFieldset'

export { folderKey } from './ProjectChooser'

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
  const nameInput = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const [project, setProject] = useState<AgentProject | null>(() => state.host.projects.find(item => item.id === initialProjectId) ?? null)
  const [folder, setFolder] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [modelId, setModelId] = useState(() => defaultThreadModelId(state.configuration, state.host.models))
  const modelChosen = useRef(false)
  const [reasoningEffort, setReasoningEffort] = useState<string | undefined>()
  const [runtimeMode, setRuntimeMode] = useState<AgentRuntimeMode | undefined>()
  // Chosen on purpose for every new thread; existing threads keep the folder they already use.
  const [workingCopy, setWorkingCopy] = useState<WorkingCopyChoice>('independent')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latestState = useRef(state)
  latestState.current = state
  const creating = useRef(false)
  const completed = useRef(false)
  // A missing acknowledgement is not permission to issue another mutation.
  // Keep attempts even when the user goes back and chooses the same folder.
  const attemptedFolders = useRef(new Set<string>())
  const chooser = useProjectChooser(state, choice => { setError(null); if (choice.project) setProject(choice.project); else setFolder(choice.folder) })
  const focusSearch = useRef(chooser.focusSearch)
  focusSearch.current = chooser.focusSearch
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
    focusSearch.current()
    return () => { element?.close?.(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  // Keyboard creation continues in the form once a folder is chosen.
  useEffect(() => { if (selectedFolder) nameInput.current?.focus(); else focusSearch.current() }, [selectedFolder])
  // Providers connect one at a time; follow the default as models become ready until a model is picked here.
  useEffect(() => { if (!modelChosen.current) setModelId(defaultThreadModelId(state.configuration, state.host.models)) }, [state.configuration, state.host.models])
  const create = async (): Promise<void> => {
    if (creating.current || completed.current || submitting || state.busy || !connected || !canCreateThread || !selectedFolder || !modelId) return
    creating.current = true
    setSubmitting(true)
    setError(null)
    try {
      let selectedProject = project
      if (!selectedProject && folder) {
        const found = await projectForFolder({ folder, command, latest: () => latestState.current, attempted: attemptedFolders.current, providerId: selectedModel?.providerId ?? state.configuration.provider })
        if (found.project === null) { setError(found.error); return }
        selectedProject = found.project
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
      {selectedFolder ? <span>New thread</span> : chooser.search}
      <Button variant="ghost" iconOnly aria-label="Close new thread dialog" disabled={submitting} onClick={onClose}><X size={16} /></Button>
    </header>
    {selectedFolder ? <form className="new-thread-dialog__form" onSubmit={event => { event.preventDefault(); void create() }}>
      <div className="new-thread-dialog__folder"><Folder size={22} /><div><strong>{project?.title ?? folderName(selectedFolder)}</strong><span>{selectedFolder}</span></div><Button variant="ghost" disabled={submitting} onClick={() => { setProject(null); setFolder(null) }}>Change</Button></div>
      <label>Thread name<input ref={nameInput} className="tt-input" placeholder="New thread" value={title} disabled={submitting} onChange={event => setTitle(event.target.value)} /></label>
      <WorkingCopyFieldset value={workingCopy} disabled={submitting} sharedHint="Edits the same files as other threads in this project." onChange={setWorkingCopy} />
      <ThreadOptionFields models={state.host.models} modelId={modelId} reasoningEffort={reasoningEffort} runtimeMode={runtimeMode}
        disabled={submitting} onModel={id => { modelChosen.current = true; setModelId(id); setReasoningEffort(undefined); setRuntimeMode(undefined) }} onReasoning={setReasoningEffort} onRuntime={setRuntimeMode} />
      {error && <p className="agent-error" role="alert">{error}</p>}
      {!connected && <p className="agent-muted">Connect {selectedModel?.provider ?? 'a provider'} in Settings → Providers before creating a thread.</p>}
      <div className="new-thread-dialog__submit"><Button type="submit" disabled={submitting || state.busy || !connected || !modelId || !canCreateThread}>{submitting ? 'Creating...' : 'Create thread'}<ChevronRight size={16} /></Button></div>
    </form> : chooser.choices}
    <footer className="new-thread-dialog__keys"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Select</span><span><kbd>Esc</kbd> Close</span></footer>
  </dialog>
}
