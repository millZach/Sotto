import React, { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ChevronRight, Folder, X } from 'lucide-react'
import { PROVIDER_LABELS, defaultThreadModelId, isSubscriptionReasoning, type AgentModel, type AgentProject, type AgentState } from '../../../shared/agents'
import { TERMINAL_PERMISSIONS, TERMINAL_PERMISSION_LABELS, commandLine, nativeModelName, providerCommand, type TerminalPermission } from '../../../shared/terminalCommands'
import { terminalProviderSchema, type TerminalProvider, type TerminalLaunch, type TerminalWorkspaceBridge } from '../../../shared/terminalWorkspace'
import type { AgentConnection } from '../agents/AgentContext'
import { ModelPicker } from '../agents/ModelPicker'
import { folderName, projectForFolder, useProjectChooser } from '../agents/ProjectChooser'
import { providerKey } from '../agents/threadFacts'
import { WorkingCopyFieldset, type WorkingCopyChoice } from '../agents/WorkingCopyFieldset'
import { Button } from '../components/Button'
import type { TerminalWorkspaceStore } from './terminalWorkspaceStore'
import '../agents/newThread.css'
import './terminals.css'

/** What the Runs box shows for a launch: the provider's CLI with its flags, or the shell main says it opens. */
function launchCommandLine(launch: TerminalLaunch, shell: string | null): string {
  const argv = providerCommand({ provider: launch.provider, model: launch.modelId === null ? null : nativeModelName(launch.modelId), reasoning: launch.reasoning, permission: launch.permission })
  return argv.length ? commandLine(argv) : shell ?? 'your shell'
}

/** The provider a model belongs to, from its ID or, as the thread rows do, from its provider name. */
function providerOf(model: AgentModel): TerminalProvider | undefined {
  const parsed = terminalProviderSchema.safeParse(model.providerId ?? providerKey(model.provider))
  return parsed.success ? parsed.data : undefined
}

function providersOf(models: readonly AgentModel[]): TerminalProvider[] {
  const seen: TerminalProvider[] = []
  for (const model of models) {
    const id = providerOf(model)
    if (id && !seen.includes(id)) seen.push(id)
  }
  return seen
}

export function NewTerminalDialog({ state, command, store, bridge, shell, onClose, onCreated, initialProjectId }: {
  readonly state: AgentState
  readonly command: AgentConnection['command']
  readonly store: TerminalWorkspaceStore
  readonly bridge: TerminalWorkspaceBridge | undefined
  /** The shell a terminal without a provider opens, as main names it. */
  readonly shell: string | null
  readonly onClose: () => void
  readonly onCreated: (id: string) => void
  /** Opens straight to the form for this project, as "New terminal here" does. */
  readonly initialProjectId?: string | undefined
}): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const [project, setProject] = useState<AgentProject | null>(() => state.host.projects.find(item => item.id === initialProjectId) ?? null)
  const [folder, setFolder] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  // A terminal usually wants the project itself; a worktree is a deliberate choice, and takes a moment to check out.
  const [workingCopy, setWorkingCopy] = useState<WorkingCopyChoice>('shared')
  const catalogProviders = useMemo(() => providersOf(state.host.models), [state.host.models])
  const inheritedModelId = defaultThreadModelId(state.configuration, state.host.models, state.reasoningAccounts)
  const defaultModel = state.host.models.find(model => model.id === inheritedModelId)
  const nativeAgent = isSubscriptionReasoning(state.configuration.reasoning) ? state.configuration.reasoning : null
  const defaultProvider = nativeAgent ?? (defaultModel ? providerOf(defaultModel) : undefined) ?? catalogProviders[0] ?? null
  const defaultModelId = nativeAgent || (defaultModel && providerOf(defaultModel) === defaultProvider) ? inheritedModelId
    : state.host.models.find(model => providerOf(model) === defaultProvider)?.id ?? ''
  const [provider, setProvider] = useState<TerminalProvider | null>(defaultProvider)
  const [modelId, setModelId] = useState(defaultModelId)
  const choiceMade = useRef(false)
  const providers = [...new Set([...catalogProviders, ...(provider ? [provider] : [])])]
  const catalogModels = state.host.models.filter(model => providerOf(model) === provider)
  const accountModel = state.reasoningAccounts.find(account => account.provider === provider)?.models.find(model => model.id === nativeModelName(modelId))
  const model: AgentModel | undefined = catalogModels.find(item => item.id === modelId) ?? (provider && modelId ? {
    id: modelId, name: accountModel?.name ?? nativeModelName(modelId) ?? PROVIDER_LABELS[provider],
    providerId: provider, provider: PROVIDER_LABELS[provider], ready: false,
  } : undefined)
  const models = model && !catalogModels.some(item => item.id === model.id) ? [...catalogModels, model] : catalogModels
  const [reasoning, setReasoning] = useState<string | undefined>()
  const [permission, setPermission] = useState<TerminalPermission>('ask')
  useEffect(() => {
    if (choiceMade.current) return
    setProvider(defaultProvider)
    setModelId(defaultModelId)
    // A late model default must not erase choices made for this provider.
    if (provider !== defaultProvider) {
      setReasoning(undefined)
      setPermission('ask')
    }
  }, [defaultProvider, defaultModelId, provider])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latestState = useRef(state)
  latestState.current = state
  const creating = useRef(false)
  const attemptedFolders = useRef(new Set<string>())
  const chooser = useProjectChooser(state, choice => { setError(null); if (choice.project) setProject(choice.project); else setFolder(choice.folder) })
  const focusSearch = useRef(chooser.focusSearch)
  focusSearch.current = chooser.focusSearch
  const selectedFolder = project?.path ?? folder
  useEffect(() => {
    const previous = document.activeElement
    const element = dialog.current
    if (element?.showModal) element.showModal()
    else element?.setAttribute('open', '')
    focusSearch.current()
    return () => { element?.close?.(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  useEffect(() => { if (selectedFolder) nameInput.current?.focus(); else focusSearch.current() }, [selectedFolder])
  // A provider change moves the model to that provider's default; the reasoning and permissions start over with it.
  const chooseProvider = (next: TerminalProvider | null): void => {
    choiceMade.current = true
    setProvider(next)
    const candidates = state.host.models.filter(item => providerOf(item) === next)
    setModelId(defaultProvider === next ? defaultModelId : candidates[0]?.id ?? '')
    setReasoning(undefined)
    setPermission('ask')
  }
  const effort = reasoning !== undefined && (!model?.reasoningEfforts || model.reasoningEfforts.includes(reasoning))
    ? reasoning : model?.defaultReasoningEffort ?? null
  const launch: TerminalLaunch = provider === null ? { provider: null, modelId: null, reasoning: null, permission: null }
    : { provider, modelId: model?.id ?? null, reasoning: effort, permission }
  const runs = launchCommandLine(launch, shell)
  const name = title.trim()

  const create = async (): Promise<void> => {
    if (creating.current || submitting || !selectedFolder || !name) return
    creating.current = true
    setSubmitting(true)
    setError(null)
    try {
      let selectedProject = project
      if (!selectedProject && folder) {
        const found = await projectForFolder({ folder, command, latest: () => latestState.current, attempted: attemptedFolders.current, providerId: provider ?? undefined })
        if (found.project === null) { setError(found.error); return }
        selectedProject = found.project
        setProject(selectedProject)
      }
      if (!selectedProject) return
      const result = await store.open(bridge, { projectId: selectedProject.id, title: name, workingCopy, launch })
      if ('error' in result) { setError(result.error); return }
      onCreated(result.id)
    } finally { creating.current = false; setSubmitting(false) }
  }

  return <dialog ref={dialog} className="new-thread-dialog new-terminal-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!submitting) onClose() }}
    onClick={event => { if (event.target === event.currentTarget && !submitting) onClose() }}>
    <h2 id={titleId} className="tt-visually-hidden">New terminal</h2>
    <header className="new-thread-dialog__search">
      <Button variant="ghost" iconOnly aria-label={selectedFolder ? 'Back to projects' : 'Close New terminal'} disabled={submitting} onClick={() => { if (selectedFolder) { setProject(null); setFolder(null); setError(null) } else onClose() }}><ArrowLeft size={17} /></Button>
      {selectedFolder ? <span>New terminal</span> : chooser.search}
      <Button variant="ghost" iconOnly aria-label="Close new terminal dialog" disabled={submitting} onClick={onClose}><X size={16} /></Button>
    </header>
    {selectedFolder ? <form className="new-thread-dialog__form" onSubmit={event => { event.preventDefault(); void create() }}>
      <div className="new-thread-dialog__folder"><Folder size={22} /><div><strong>{project?.title ?? folderName(selectedFolder)}</strong><span>{selectedFolder}</span></div><Button variant="ghost" disabled={submitting} onClick={() => { setProject(null); setFolder(null) }}>Change</Button></div>
      <label>Terminal name<input ref={nameInput} className="tt-input" placeholder="Build watcher" value={title} required disabled={submitting} onChange={event => setTitle(event.target.value)} /></label>
      <WorkingCopyFieldset value={workingCopy} disabled={submitting} sharedHint="Runs in the same files as the project's threads." onChange={setWorkingCopy} />
      <div className="thread-options new-terminal-dialog__options">
        <label><span>Provider</span><select aria-label="Terminal provider" title="Provider" value={provider ?? ''} disabled={submitting} onChange={event => chooseProvider(event.target.value === '' ? null : event.target.value as TerminalProvider)}>
          <option value="">None, just a shell</option>
          {providers.map(id => <option key={id} value={id}>{PROVIDER_LABELS[id]}</option>)}
        </select></label>
        {provider !== null && models.length ? <div className="thread-options__model"><span>Model</span><ModelPicker models={models} modelId={modelId} disabled={submitting} onChange={id => { choiceMade.current = true; setModelId(id); setReasoning(undefined) }} /></div> : null}
        {provider !== null && !!model?.reasoningEfforts?.length ? <label><span>Reasoning</span><select aria-label="Terminal reasoning" title="Reasoning" value={effort ?? ''} disabled={submitting} onChange={event => setReasoning(event.target.value)}>
          {effort !== null && !model.reasoningEfforts.includes(effort) ? <option value={effort} disabled>{effort}</option> : null}
          {model.reasoningEfforts.map(item => <option key={item} value={item}>{item.charAt(0).toUpperCase() + item.slice(1)}</option>)}
        </select></label> : null}
        {provider !== null ? <label><span>Permissions</span><select aria-label="Terminal permissions" title="Permissions" value={permission} disabled={submitting} onChange={event => setPermission(event.target.value as TerminalPermission)}>
          {TERMINAL_PERMISSIONS.map(item => <option key={item} value={item}>{TERMINAL_PERMISSION_LABELS[item]}</option>)}
        </select></label> : null}
      </div>
      <div className="new-terminal-runs" aria-live="polite"><small id={`${titleId}-runs`}>Runs</small><code aria-labelledby={`${titleId}-runs`}>{runs}</code></div>
      {error && <p className="agent-error" role="alert">{error}</p>}
      {!bridge ? <p className="agent-muted">Terminal is not available in this window.</p> : null}
      <div className="new-thread-dialog__submit"><Button type="submit" disabled={submitting || !bridge || !name}>{submitting ? 'Opening...' : 'Open terminal'}<ChevronRight size={16} /></Button></div>
    </form> : chooser.choices}
    <footer className="new-thread-dialog__keys"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Select</span><span><kbd>Esc</kbd> Close</span></footer>
  </dialog>
}
