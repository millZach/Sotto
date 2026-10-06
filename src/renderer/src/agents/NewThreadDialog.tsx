import { parseHostEntityKey } from '../../../shared/clientIdentity'
import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ChevronRight, Folder, Laptop, Server, X } from 'lucide-react'
import { defaultNewThreadModelId, defaultThreadModelId, hostForThread, isSubscriptionReasoning, PROVIDER_LABELS, type AgentModel, type AgentProject, type AgentRuntimeMode, type AgentState } from '../../../shared/agents'
import { catalogEntry, chosenModelId, resolveModel } from '../../../shared/modelCatalog'
import type { AgentConnection } from './AgentContext'
import { Button } from '../components/Button'
import './newThread.css'
import { beginNewThread, projectWorkingCopy, WORKING_COPY_READ_ERROR, type ThreadCreationStart } from './newThread'
import { folderName, projectForFolder, useProjectChooser } from './ProjectChooser'
import { startingProviderMode, ThreadOptionFields, threadOptionsSummary } from './ThreadOptions'
import { HostBadge, hostIdOf, listedHosts } from './HostBadge'

export { folderKey } from './ProjectChooser'
export type { ThreadCreationStart } from './newThread'

/**
 * New thread. The pen on a project row and the empty Threads page's button already know their project and skip
 * this dialog, opening the thread at once through `beginNewThread` on the defaults from Settings → Agents, with
 * no further form to fill in (issue #347); the sidebar's top New thread button does the same once a project is
 * chosen here. The Agents room's own managed flow keeps its name, model, reasoning and permission form after the
 * project is chosen, unchanged from before #347: a managed thread is deliberately configured once before it
 * opens, rather than picked up from Settings like an instant one.
 */
export function NewThreadDialog({ state, command, onClose, onCreated, onCreating, managed = false }: {
  readonly state: AgentState
  readonly command: AgentConnection['command']
  readonly onClose: () => void
  readonly onCreated: () => void
  /**
   * Present when the caller shows the thread itself: the dialog issues the command and hands the creation over
   * at once instead of waiting for it, and `onCreated` is not called. The managed form always awaits instead,
   * since it has choices left to submit.
   */
  readonly onCreating?: ((start: ThreadCreationStart) => void) | undefined
  readonly managed?: boolean
}): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const optionsSummary = useRef<HTMLElement>(null)
  const [optionsOpen, setOptionsOpen] = useState(false)
  // The managed form's own chosen project or folder; the instant flow never sets these; and its own fields.
  const [project, setProject] = useState<AgentProject | null>(null)
  const [folder, setFolder] = useState<string | null>(null)
  const [folderIsNew, setFolderIsNew] = useState(false)
  const [title, setTitle] = useState('')
  // With threads from more than one host listed, New thread starts by choosing the host; its projects follow.
  const hosts = listedHosts(state)
  const [hostId, setHostId] = useState<string | undefined>(() => hosts.length ? hostIdOf(project ?? undefined) ?? state.hostId ?? hosts[0]?.hostId : undefined)
  const chosenHost = hosts.find(item => item.hostId === (hostIdOf(project ?? undefined) ?? hostId ?? state.hostId))
  // A new folder becomes a project on the host chosen above, since it is added there rather than on any thread's host.
  const projectHost = hostForThread(state.host, { hostId: project?.hostId ?? parseHostEntityKey(project?.id ?? '')?.hostId ?? chosenHost?.hostId ?? state.hostId })
  const [modelId, setModelId] = useState(() => defaultNewThreadModelId(state.configuration, projectHost.models, state.reasoningAccounts))
  // Choices carried back from a refused creation are the user's own; the default must not move under them.
  const modelChosen = useRef(false)
  const [reasoningEffort, setReasoningEffort] = useState<string | undefined>(undefined)
  const [runtimeMode, setRuntimeMode] = useState<AgentRuntimeMode | undefined>(undefined)
  const [providerMode, setProviderMode] = useState<string | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const creationInFlight = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const latestState = useRef(state)
  latestState.current = state
  const completed = useRef(false)
  // A missing acknowledgement is not permission to issue another mutation.
  // Keep attempts even when the user goes back and chooses the same folder.
  const attemptedFolders = useRef(new Set<string>())
  const startThread = (project: AgentProject): void => {
    setError(null)
    setCreating(true)
    void beginNewThread(latestState.current, command, project, managed).then(start => {
      if ('error' in start) { creationInFlight.current = false; setCreating(false); setError(start.error); return }
      completed.current = true
      // A caller that shows the thread itself takes over from here; one that only awaits keeps the dialog
      // locked until the command answers, since it is what closes the dialog on success.
      if (onCreating) { onCreating(start); return }
      void start.created.then(creationError => {
        setCreating(false)
        if (creationError !== null) { completed.current = false; creationInFlight.current = false; setError(creationError) } else onCreated()
      })
    })
  }
  const chooser = useProjectChooser(state, choice => {
    if (creationInFlight.current || completed.current) return
    setError(null)
    if (managed) {
      if (choice.project) { setProject(choice.project); setFolder(null) } else { setProject(null); setFolder(choice.folder); setFolderIsNew(choice.isNew === true) }
      return
    }
    creationInFlight.current = true
    if (choice.project) { startThread(choice.project); return }
    const provider = isSubscriptionReasoning(state.configuration.reasoning) ? state.configuration.reasoning
      : resolveModel(projectHost.models, defaultNewThreadModelId(state.configuration, projectHost.models, state.reasoningAccounts))?.providerId
    setCreating(true)
    void (async () => {
      if (chosenHost && chosenHost.hostId !== latestState.current.hostId) await window.sotto?.hosts?.command({ type: 'select', hostId: chosenHost.hostId })
      const found = await projectForFolder({ folder: choice.folder, isNew: choice.isNew === true, command, latest: () => latestState.current, attempted: attemptedFolders.current, providerId: provider, hostId: chosenHost?.hostId })
      if (found.project === null) { creationInFlight.current = false; setCreating(false); setError(found.error); return }
      startThread(found.project)
    })()
  }, { hostId: chosenHost?.hostId, disabled: creating })
  const focusSearch = useRef(chooser.focusSearch)
  focusSearch.current = chooser.focusSearch
  const selectedFolder = managed ? (project?.path ?? folder) : null
  const inheritedProvider = isSubscriptionReasoning(state.configuration.reasoning) ? state.configuration.reasoning : null
  const inheritedModelId = defaultThreadModelId(state.configuration, projectHost.models, state.reasoningAccounts)
  const inheritedAccount = state.reasoningAccounts.find(account => account.provider === inheritedProvider)
  const inheritedModel = resolveModel(inheritedAccount?.models ?? [], state.configuration.reasoningModel || inheritedAccount?.defaultModelId)
  const selectedModel: AgentModel | undefined = resolveModel(projectHost.models, modelId)
    ?? (inheritedProvider && modelId === inheritedModelId ? {
      id: modelId, providerId: inheritedProvider, provider: PROVIDER_LABELS[inheritedProvider], ready: false,
      name: inheritedModel?.name || state.configuration.reasoningModel || (PROVIDER_LABELS[inheritedProvider] + ' default'),
    } : undefined)
  // The permission setting shown is the one sent, so an unchosen one is the first the provider offers.
  const startMode = startingProviderMode(selectedModel, providerMode)
  const modelChoices = selectedModel && !catalogEntry(projectHost.models, selectedModel.id) ? [...projectHost.models, selectedModel] : projectHost.models
  const selectedProvider = projectHost.providers?.find(provider => provider.id === selectedModel?.providerId)
  const canCreateThread = selectedProvider?.capabilities.threads ?? projectHost.capabilities.threads
  const connected = selectedModel?.ready === true && (selectedModel.providerId && projectHost.providers
    ? projectHost.providers.some(provider => provider.id === selectedModel.providerId && provider.connection === 'connected')
    : projectHost.connected)
  useEffect(() => {
    const previous = document.activeElement
    const element = dialog.current
    if (element?.showModal) element.showModal()
    else element?.setAttribute('open', '')
    focusSearch.current()
    return () => {
      element?.close?.()
      // A thread is on its way: the caller is opening it and taking focus with it.
      if (!completed.current && previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  // Providers connect one at a time; follow the default as models become ready until a model is picked here.
  useEffect(() => { if (managed && !modelChosen.current) setModelId(defaultNewThreadModelId(state.configuration, projectHost.models, state.reasoningAccounts)) }, [managed, state.configuration, projectHost.models, state.reasoningAccounts])
  const createManaged = async (): Promise<void> => {
    if (creationInFlight.current || completed.current || state.globalLaneBusy || !connected || !canCreateThread || !selectedFolder || !modelId) return
    creationInFlight.current = true
    setCreating(true)
    setError(null)
    try {
      let selectedProject = project
      if (!selectedProject && folder) {
        // A new folder becomes a project on the host chosen above: main adds it to the host selected for new work.
        if (chosenHost && chosenHost.hostId !== latestState.current.hostId) await window.sotto?.hosts?.command({ type: 'select', hostId: chosenHost.hostId })
        const found = await projectForFolder({ folder, isNew: folderIsNew, command, latest: () => latestState.current, attempted: attemptedFolders.current, providerId: selectedModel?.providerId ?? state.configuration.provider, hostId: chosenHost?.hostId })
        if (found.project === null) { setError(found.error); return }
        selectedProject = found.project
        setProject(selectedProject)
      }
      if (!selectedProject) return
      let workingCopy: 'independent' | 'shared'
      try { workingCopy = await projectWorkingCopy(latestState.current, selectedProject) }
      catch { setError(WORKING_COPY_READ_ERROR); return }
      const worktreeChoices = workingCopy === 'independent' ? { startFromOrigin: true } : {}
      const request = { type: 'create-thread', projectId: selectedProject.id, title: title.trim() || 'New thread', modelId, managed: true, workingCopy, ...worktreeChoices,
        titleSource: title.trim() ? 'user' : 'default',
        ...(reasoningEffort ? { reasoningEffort } : {}), ...(runtimeMode ? { runtimeMode } : {}), ...(startMode ? { providerMode: startMode } : {}) } as const
      const result = await command(request)
      if (!result || result.error) { setError(result?.error ?? 'Could not confirm creation. Your choices are retained; try again to check the existing action.'); return }
      completed.current = true
      onCreated()
    } finally { creationInFlight.current = false; setCreating(false) }
  }
  return <dialog ref={dialog} className={`new-thread-dialog${managed ? ' new-thread-dialog--thread' : ''}`} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!creating) onClose() }}
    onClick={event => { if (event.target === event.currentTarget && !creating) onClose() }}>
    <h2 id={titleId} className="tt-visually-hidden">New thread</h2>
    <header className="new-thread-dialog__search">
      {managed && selectedFolder
        ? <Button variant="ghost" iconOnly aria-label="Back to projects" disabled={creating} onClick={() => { setProject(null); setFolder(null); setError(null) }}><ArrowLeft size={17} /></Button>
        : null}
      {managed && selectedFolder ? <span>New thread</span> : chooser.search}
      <Button variant="ghost" iconOnly aria-label="Close new thread dialog" disabled={creating} onClick={onClose}><X size={16} /></Button>
    </header>
    {managed && selectedFolder ? <form className="new-thread-dialog__form" onSubmit={event => { event.preventDefault(); void createManaged() }}>
      <div className="new-thread-dialog__body">
      <div className="new-thread-dialog__folder"><Folder size={22} /><div><strong>{project?.title ?? folderName(selectedFolder)}{chosenHost ? <> <HostBadge host={chosenHost} /><span className="tt-visually-hidden"> on {chosenHost.name}</span></> : null}</strong><span title={selectedFolder}>{selectedFolder}</span></div><Button variant="ghost" disabled={creating} onClick={() => { setProject(null); setFolder(null) }}>Change</Button></div>
      <details className="new-thread-dialog__options" open={optionsOpen}
        onKeyDown={event => { if (event.key === 'Escape' && optionsOpen && (event.target as HTMLElement).closest('dialog') === dialog.current) { event.preventDefault(); event.stopPropagation(); setOptionsOpen(false); optionsSummary.current?.focus() } }}>
        <summary ref={optionsSummary} onClick={event => { event.preventDefault(); setOptionsOpen(open => !open) }}>Thread options <span>· {threadOptionsSummary(selectedModel, reasoningEffort, runtimeMode, providerMode)}</span></summary>
        <div className="new-thread-dialog__option-fields">
          <label>Thread name<input className="tt-input" placeholder="New thread" value={title} disabled={creating} onChange={event => setTitle(event.target.value)} /></label>
          <ThreadOptionFields models={modelChoices} modelId={modelId} reasoningEffort={reasoningEffort} runtimeMode={runtimeMode} providerMode={providerMode}
            disabled={creating} onModel={id => { modelChosen.current = true; setModelId(chosenModelId(projectHost.models, id, modelId, inheritedModelId)); setReasoningEffort(undefined); setRuntimeMode(undefined); setProviderMode(undefined) }}
            onReasoning={setReasoningEffort} onRuntime={setRuntimeMode} onProviderMode={setProviderMode} />
        </div>
      </details>
      {error && <p className="agent-error" role="alert">{error}</p>}
      {!connected && <p className="agent-muted" role="status">{selectedModel ? (selectedModel.providerId ? PROVIDER_LABELS[selectedModel.providerId] : selectedModel.provider) + ' is not ready with this model. Check Settings → Providers or choose another model in Thread options.' : 'Choose an available model in Thread options.'}</p>}
      </div>
      <div className="new-thread-dialog__submit"><span /><Button type="submit" disabled={creating || state.globalLaneBusy || !connected || !modelId || !canCreateThread}>{creating ? 'Creating...' : 'Create thread'}<ChevronRight size={16} /></Button></div>
    </form> : <>
      {hosts.length > 1 ? <div className="new-thread-hosts" role="group" aria-label="Host">
        {hosts.map(item => <button key={item.hostId} type="button" className="tt-focusable" aria-pressed={item.hostId === chosenHost?.hostId} onClick={() => setHostId(item.hostId)}>
          {item.kind === 'local' ? <Laptop size={15} aria-hidden="true" /> : <Server size={15} aria-hidden="true" />}{item.name}</button>)}
      </div> : null}
      {chooser.choices}
      {creating ? <p role="status" className="new-thread-dialog__empty">Opening the thread…</p> : null}
      {error && <p className="agent-error" role="alert">{error}</p>}
    </>}
    {!(managed && selectedFolder) ? <footer className="new-thread-dialog__keys"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Select</span><span><kbd>Esc</kbd> Close</span></footer> : null}
  </dialog>
}
