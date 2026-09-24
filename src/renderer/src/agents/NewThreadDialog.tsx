import { hostEntityKey, parseHostEntityKey } from '../../../shared/clientIdentity'
import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ChevronRight, Folder, X } from 'lucide-react'
import { hostForThread, defaultThreadModelId, isSubscriptionReasoning, PROVIDER_LABELS, type AgentModel, type AgentProject, type AgentRuntimeMode, type AgentState, type AgentThread } from '../../../shared/agents'
import type { AgentConnection } from './AgentContext'
import { Button } from '../components/Button'
import { draftThread, UNCONFIRMED_CREATION } from './draftThreads'
import './newThread.css'
import { folderName, projectForFolder, useProjectChooser } from './ProjectChooser'
import { startingProviderMode, ThreadOptionFields, threadOptionsSummary } from './ThreadOptions'
import type { WorkingCopyChoice } from './WorkingCopyFieldset'

export { folderKey } from './ProjectChooser'

/** Everything the user chose here, so a refused creation can reopen the dialog exactly as it was. */
export interface NewThreadChoices {
  readonly projectId: string
  readonly title: string
  readonly modelId: string
  readonly workingCopy: WorkingCopyChoice
  readonly baseBranch?: string | undefined
  readonly startFromOrigin?: boolean | undefined
  readonly existingWorktreePath?: string | undefined
  readonly reasoningEffort?: string | undefined
  readonly runtimeMode?: AgentRuntimeMode | undefined
  readonly providerMode?: string | undefined
}

/** A creation on its way, handed over the moment it is issued so the thread can be shown without waiting. */
export interface ThreadCreationStart {
  /** The local record for the ID this window minted, to show until main's state carries the thread. */
  readonly thread: AgentThread
  readonly choices: NewThreadChoices
  /** Resolves null once main has the thread, or with the reason main refused it. Never rejects. */
  readonly created: Promise<string | null>
}

export function NewThreadDialog({ state, command, onClose, onCreated, onCreating, managed = false, initialProjectId, initialChoices, initialError }: {
  readonly state: AgentState
  readonly command: AgentConnection['command']
  readonly onClose: () => void
  readonly onCreated: () => void
  /**
   * Present when the caller shows the thread itself: the dialog mints the ID, issues the command and hands
   * the creation over at once instead of waiting for it, and `onCreated` is not called.
   */
  readonly onCreating?: ((start: ThreadCreationStart) => void) | undefined
  readonly managed?: boolean
  /** Opens straight to the thread form for this project, as "New thread here" does. */
  readonly initialProjectId?: string | undefined
  /** Reopening after a refusal: the same choices, and the reason shown above the button. */
  readonly initialChoices?: NewThreadChoices | undefined
  readonly initialError?: string | undefined
}): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const optionsSummary = useRef<HTMLElement>(null)
  const [optionsOpen, setOptionsOpen] = useState(initialChoices !== undefined)
  const titleId = useId()
  const [project, setProject] = useState<AgentProject | null>(() => state.host.projects.find(item => item.id === (initialChoices?.projectId ?? initialProjectId)) ?? null)
  const [folder, setFolder] = useState<string | null>(null)
  const projectHost = hostForThread(state.host, { hostId: project?.hostId ?? parseHostEntityKey(project?.id ?? '')?.hostId ?? state.hostId })
  const localHostId = state.connections ? state.connections.find(host => host.kind === 'local')?.hostId : state.hostId
  const defaultKey = (id: string): string => { const key = parseHostEntityKey(id); return key && key.hostId === localHostId ? key.id : id }
  const [title, setTitle] = useState(initialChoices?.title ?? '')
  const [modelId, setModelId] = useState(() => initialChoices?.modelId ?? defaultThreadModelId(state.configuration, projectHost.models, state.reasoningAccounts))
  // Choices carried back from a refused creation are the user's own; the default must not move under them.
  const modelChosen = useRef(initialChoices !== undefined)
  const [reasoningEffort, setReasoningEffort] = useState<string | undefined>(initialChoices?.reasoningEffort)
  const [runtimeMode, setRuntimeMode] = useState<AgentRuntimeMode | undefined>(initialChoices?.runtimeMode)
  const [providerMode, setProviderMode] = useState<string | undefined>(initialChoices?.providerMode)
  // The working copy starts from the global or project default; the branch toolbar under the composer changes
  // it before the first send (ADR-0027). Choices carried back from a refused creation are kept as they were.
  const [workingCopy, setWorkingCopy] = useState<WorkingCopyChoice>(initialChoices?.workingCopy ?? 'shared')
  const workingCopyChosen = useRef(initialChoices !== undefined)
  const [defaults, setDefaults] = useState<{ global: WorkingCopyChoice; projects: Record<string, WorkingCopyChoice> }>({ global: 'shared', projects: {} })
  const [loadingDefaults, setLoadingDefaults] = useState(Boolean(window.sotto?.getSettings))
  const [defaultsError, setDefaultsError] = useState<string | null>(null)
  const [defaultsRead, setDefaultsRead] = useState(0)
  useEffect(() => {
    let current = true
    setDefaultsError(null)
    if (window.sotto?.getSettings) void window.sotto.getSettings().then(settings => {
      if (current) setDefaults({ global: settings.threadWorkingCopyDefault, projects: settings.projectThreadWorkingCopyDefaults })
    }, () => { if (current) setDefaultsError('Could not read your working-copy defaults. Retry before creating this thread.') }).finally(() => { if (current) setLoadingDefaults(false) })
    return () => { current = false }
  }, [defaultsRead])
  useEffect(() => {
    if (!workingCopyChosen.current) setWorkingCopy((project && defaults.projects[defaultKey(project.id)]) || defaults.global)
  }, [project, defaults])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(initialError ?? null)
  const latestState = useRef(state)
  latestState.current = state
  const creating = useRef(false)
  const completed = useRef(false)
  // A missing acknowledgement is not permission to issue another mutation.
  // Keep attempts even when the user goes back and chooses the same folder.
  const attemptedFolders = useRef(new Set<string>())
  const chooser = useProjectChooser(state, choice => {
    setError(null); workingCopyChosen.current = false
    setWorkingCopy((choice.project && defaults.projects[defaultKey(choice.project.id)]) || defaults.global)
    if (choice.project) setProject(choice.project); else setFolder(choice.folder)
  })
  const focusSearch = useRef(chooser.focusSearch)
  focusSearch.current = chooser.focusSearch
  const selectedFolder = project?.path ?? folder
  const inheritedProvider = isSubscriptionReasoning(state.configuration.reasoning) ? state.configuration.reasoning : null
  const inheritedModelId = defaultThreadModelId(state.configuration, projectHost.models, state.reasoningAccounts)
  const inheritedAccount = state.reasoningAccounts.find(account => account.provider === inheritedProvider)
  const inheritedModel = inheritedAccount?.models.find(model => model.id === (state.configuration.reasoningModel || inheritedAccount.defaultModelId))
  const selectedModel: AgentModel | undefined = projectHost.models.find(model => model.id === modelId)
    ?? (inheritedProvider && modelId === inheritedModelId ? {
      id: modelId, providerId: inheritedProvider, provider: PROVIDER_LABELS[inheritedProvider], ready: false,
      name: inheritedModel?.name || state.configuration.reasoningModel || (PROVIDER_LABELS[inheritedProvider] + ' default'),
    } : undefined)
  // The permission setting shown is the one sent, so an unchosen one is the first the provider offers.
  const startMode = startingProviderMode(selectedModel, providerMode)
  const modelChoices = selectedModel && !projectHost.models.some(model => model.id === selectedModel.id) ? [...projectHost.models, selectedModel] : projectHost.models
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
    return () => { element?.close?.(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  // Keyboard creation continues in the form once a folder is chosen.
  useEffect(() => {
    if (selectedFolder) {
      if (!dialog.current?.querySelector('.new-thread-dialog__body')?.contains(document.activeElement)) {
        dialog.current?.querySelector<HTMLElement>('.new-thread-dialog__options > summary')?.focus()
      }
    }
    else focusSearch.current()
  }, [selectedFolder, loadingDefaults])
  // Providers connect one at a time; follow the default as models become ready until a model is picked here.
  useEffect(() => { if (!modelChosen.current) setModelId(defaultThreadModelId(state.configuration, projectHost.models, state.reasoningAccounts)) }, [state.configuration, projectHost.models, state.reasoningAccounts])
  const create = async (): Promise<void> => {
    if (creating.current || completed.current || defaultsError || loadingDefaults || submitting || state.globalLaneBusy || !connected || !canCreateThread || !selectedFolder || !modelId) return
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
      const chosenCopy = workingCopyChosen.current ? workingCopy : defaults.projects[defaultKey(selectedProject.id)] ?? defaults.global
      const worktreeChoices = chosenCopy === 'independent' ? { ...(initialChoices?.baseBranch ? { baseBranch: initialChoices.baseBranch } : {}), startFromOrigin: initialChoices?.startFromOrigin ?? true, ...(initialChoices?.existingWorktreePath ? { existingWorktreePath: initialChoices.existingWorktreePath } : {}) } : {}
      const choices: NewThreadChoices = { projectId: selectedProject.id, title: title.trim() || 'New thread', modelId, workingCopy: chosenCopy, ...worktreeChoices,
        ...(reasoningEffort ? { reasoningEffort } : {}), ...(runtimeMode ? { runtimeMode } : {}), ...(startMode ? { providerMode: startMode } : {}) }
      // A name the user typed is theirs from the start; Sotto's stand-in name is not.
      const request = { type: 'create-thread', projectId: choices.projectId, title: choices.title, modelId, managed, workingCopy: chosenCopy, ...worktreeChoices,
        titleSource: title.trim() ? 'user' : 'default',
        ...(reasoningEffort ? { reasoningEffort } : {}), ...(runtimeMode ? { runtimeMode } : {}), ...(startMode ? { providerMode: startMode } : {}) } as const
      if (onCreating) {
        // The window shows the thread under this ID at once; main adopts the same ID when it catches up.
        const threadId = hostEntityKey(selectedProject.hostId ?? parseHostEntityKey(selectedProject.id)?.hostId ?? state.hostId, crypto.randomUUID())
        const thread = draftThread({ id: threadId, projectId: choices.projectId, title: choices.title, modelId, workingCopy: chosenCopy, ...worktreeChoices,
          ...(selectedModel?.providerId ? { providerId: selectedModel.providerId } : {}),
          reasoningEffort: reasoningEffort ?? selectedModel?.defaultReasoningEffort, runtimeMode, providerMode: startMode })
        const created = command({ ...request, threadId })
          .then(result => result === null ? UNCONFIRMED_CREATION : result.error, () => UNCONFIRMED_CREATION)
        completed.current = true
        onCreating({ thread, choices, created })
        return
      }
      const result = await command(request)
      if (!result || result.error) { setError(result?.error ?? UNCONFIRMED_CREATION); return }
      completed.current = true
      onCreated()
    } catch { setError('Could not confirm creation. Your choices are retained; try again to check the existing action.') }
    finally { creating.current = false; setSubmitting(false) }
  }
  return <dialog ref={dialog} className="new-thread-dialog new-thread-dialog--thread" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!submitting) onClose() }}
    onClick={event => { if (event.target === event.currentTarget && !submitting) onClose() }}>
    <h2 id={titleId} className="tt-visually-hidden">New thread</h2>
    <header className="new-thread-dialog__search">
      <Button variant="ghost" iconOnly aria-label={selectedFolder ? 'Back to projects' : 'Close New thread'} disabled={submitting} onClick={() => { if (selectedFolder) { setProject(null); setFolder(null); setError(null) } else onClose() }}><ArrowLeft size={17} /></Button>
      {selectedFolder ? <span>New thread</span> : chooser.search}
      <Button variant="ghost" iconOnly aria-label="Close new thread dialog" disabled={submitting} onClick={onClose}><X size={16} /></Button>
    </header>
    {selectedFolder ? <form className="new-thread-dialog__form" onSubmit={event => { event.preventDefault(); void create() }}>
      <div className="new-thread-dialog__body">
      <div className="new-thread-dialog__folder"><Folder size={22} /><div><strong>{project?.title ?? folderName(selectedFolder)}</strong><span title={selectedFolder}>{selectedFolder}</span></div><Button variant="ghost" disabled={submitting} onClick={() => { setProject(null); setFolder(null) }}>Change</Button></div>
      <details className="new-thread-dialog__options" open={optionsOpen}
        onKeyDown={event => { if (event.key === 'Escape' && optionsOpen && (event.target as HTMLElement).closest('dialog') === dialog.current) { event.preventDefault(); event.stopPropagation(); setOptionsOpen(false); optionsSummary.current?.focus() } }}>
        <summary ref={optionsSummary} onClick={event => { event.preventDefault(); setOptionsOpen(open => !open) }}>Thread options <span>· {threadOptionsSummary(selectedModel, reasoningEffort, runtimeMode, providerMode)}</span></summary>
        <div className="new-thread-dialog__option-fields">
          <label>Thread name<input className="tt-input" placeholder="New thread" value={title} disabled={submitting} onChange={event => setTitle(event.target.value)} /></label>
          <ThreadOptionFields models={modelChoices} modelId={modelId} reasoningEffort={reasoningEffort} runtimeMode={runtimeMode} providerMode={providerMode}
            disabled={submitting} onModel={id => { modelChosen.current = true; setModelId(id); setReasoningEffort(undefined); setRuntimeMode(undefined); setProviderMode(undefined) }}
            onReasoning={setReasoningEffort} onRuntime={setRuntimeMode} onProviderMode={setProviderMode} />
        </div>
      </details>
      {defaultsError ? <div><p className="agent-error" role="alert">{defaultsError}</p><Button variant="secondary" disabled={loadingDefaults} onClick={() => { setLoadingDefaults(true); setDefaultsRead(value => value + 1) }}>Retry defaults</Button></div> : null}
      {error && <p className="agent-error" role="alert">{error}</p>}
      {!connected && <p className="agent-muted" role="status">{selectedModel ? (selectedModel.providerId ? PROVIDER_LABELS[selectedModel.providerId] : selectedModel.provider) + ' is not ready with this model. Check Settings → Providers or choose another model in Thread options.' : 'Choose an available model in Thread options.'}</p>}
      </div>
      <div className="new-thread-dialog__submit"><span>{loadingDefaults ? null : workingCopy === 'independent' ? 'Starts in a new worktree, made on first send. Change it under the composer.' : 'Starts in the project folder. Change it under the composer.'}</span><Button type="submit" disabled={submitting || defaultsError !== null || loadingDefaults || state.globalLaneBusy || !connected || !modelId || !canCreateThread}>{submitting ? 'Creating...' : 'Create thread'}<ChevronRight size={16} /></Button></div>
    </form> : chooser.choices}
    {!selectedFolder ? <footer className="new-thread-dialog__keys"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Select</span><span><kbd>Esc</kbd> Close</span></footer> : null}
  </dialog>
}
