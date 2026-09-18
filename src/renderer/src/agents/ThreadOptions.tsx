import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { capabilitiesForThread, isThreadBusy, isThreadProviderConnected, type AgentModel, type AgentRuntimeMode, type AgentState, type AgentThread } from '../../../shared/agents'
import type { AgentConnection } from './AgentContext'
import { ModelPicker } from './ModelPicker'

const RUNTIME_LABELS: Record<AgentRuntimeMode, string> = {
  'approval-required': 'Ask for approval',
  'auto-accept-edits': 'Allow edits',
  auto: 'Auto',
  'full-access': 'Full access',
}
export function ThreadOptionFields({ models, modelId, reasoningEffort, runtimeMode, onModel, onReasoning, onRuntime, disabled = false, modelDisabled = false }: {
  readonly models: AgentModel[]
  readonly modelId: string
  readonly reasoningEffort?: string | undefined
  readonly runtimeMode?: AgentRuntimeMode | undefined
  readonly onModel: (id: string) => void
  readonly onReasoning: (effort: string) => void
  readonly onRuntime: (mode: AgentRuntimeMode) => void
  readonly disabled?: boolean
  /** Model and reasoning stay visible but fixed; permissions remain editable. */
  readonly modelDisabled?: boolean
}): ReactNode {
  const model = models.find(item => item.id === modelId)
  const reasoning = reasoningEffort ?? model?.defaultReasoningEffort ?? ''
  return <div className="thread-options">
    <div className="thread-options__model"><span>Model</span><ModelPicker models={models} modelId={modelId} disabled={disabled || modelDisabled} onChange={onModel} /></div>
    {!!model?.reasoningEfforts?.length && <label><span>Reasoning</span><select aria-label="Thread reasoning" title="Reasoning" value={reasoning} disabled={disabled || modelDisabled} onChange={event => onReasoning(event.target.value)}>
      {!model.reasoningEfforts.includes(reasoning) && <option value={reasoning} disabled>{reasoning || 'Provider default'}</option>}
      {model.reasoningEfforts.map(effort => <option key={effort} value={effort}>{effort.charAt(0).toUpperCase() + effort.slice(1)}</option>)}
    </select></label>}
    {!!model?.runtimeModes?.length && <label><span>Permissions</span><select aria-label="Thread permissions" title="Permissions" value={runtimeMode ?? ''} disabled={disabled} onChange={event => onRuntime(event.target.value as AgentRuntimeMode)}>
      {!runtimeMode && <option value="" disabled>Provider default</option>}
      {runtimeMode && !model.runtimeModes.includes(runtimeMode) && <option value={runtimeMode} disabled>{RUNTIME_LABELS[runtimeMode]}</option>}
      {model.runtimeModes.map(mode => <option key={mode} value={mode}>{RUNTIME_LABELS[mode]}</option>)}
    </select></label>}
  </div>
}

/** Whether a provider can create threads now; hosts without per-provider status answer for themselves. */
function canCreateWith(state: AgentState, model: AgentModel): boolean {
  const status = state.host.providers?.find(provider => provider.id === model.providerId)
  return model.ready && (status ? status.connection === 'connected' && status.capabilities.threads : state.host.connected && state.host.capabilities.threads)
}

/**
 * The models a thread may use. Before its first send (`nativeSessionStarted === false`) any ready model
 * from a connected provider that can create threads is a choice; once a native session exists (or its
 * start is unknown) the thread stays with its own provider.
 */
function threadModelChoices(state: AgentState, thread: AgentThread): { readonly models: AgentModel[]; readonly locked: boolean } {
  if (thread.nativeSessionStarted === false) {
    const models = state.host.models.filter(model => model.id === thread.modelId || canCreateWith(state, model))
    return { models, locked: false }
  }
  return { models: state.host.models.filter(model => !thread.providerId || model.providerId === thread.providerId), locked: true }
}

/** How the composer's pill reads: the model, its reasoning effort and what the thread may do without asking. */
function optionSummary(models: AgentModel[], thread: AgentThread): string {
  const model = models.find(item => item.id === thread.modelId)
  const reasoning = thread.reasoningEffort ?? model?.defaultReasoningEffort ?? ''
  return [model?.name ?? thread.modelId, reasoning && reasoning.charAt(0).toUpperCase() + reasoning.slice(1),
    thread.runtimeMode ? RUNTIME_LABELS[thread.runtimeMode] : ''].filter(Boolean).join(' · ')
}

/**
 * The composer's one option control: a pill saying what this thread is set to, which opens the model,
 * reasoning and permission controls themselves. Escape or a pointer outside closes it and returns focus
 * to the pill. New thread and New terminal show the same three controls laid out in full.
 */
export function ThreadOptions({ thread, state, command, turnNote = true }: {
  readonly thread: AgentThread; readonly state: AgentState; readonly command: AgentConnection['command']
  /** Explain options locked by a running turn; off where the composer already says it cannot send. */
  readonly turnNote?: boolean
}): ReactNode {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const { models, locked } = threadModelChoices(state, thread)
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Node
      // The model picker opens its own dialog above this popover, and a choice there must not close it underneath.
      if (!popover.current?.contains(target) && !trigger.current?.contains(target) && !(target as Element)?.closest?.('.model-picker__dialog')) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss, true)
    return () => { document.removeEventListener('pointerdown', dismiss, true) }
  }, [open])
  const disabled = saving || isThreadBusy(state, thread.id) || Boolean(thread.archivedAt) || (locked && (!isThreadProviderConnected(state.host, thread) || thread.status === 'running' || thread.requests.length > 0))
  const save = async (patch: { modelId?: string; reasoningEffort?: string; runtimeMode?: AgentRuntimeMode }): Promise<void> => {
    setSaving(true); setError(null)
    try {
      const result = await command({ type: 'configure-thread', threadId: thread.id, ...patch })
      if (!result || result.error) setError(result?.error ?? 'Could not confirm this change. Try again.')
    } finally { setSaving(false) }
  }
  const capabilities = capabilitiesForThread(state.host, thread)
  if (locked && !capabilities.configureThread) return null
  return <div className="thread-options-bar" data-provider-locked={locked}
    onKeyDown={event => {
      // Escape closes the open popover from its trigger or from inside it; inside the model picker it closes the picker alone.
      if (!open || event.key !== 'Escape' || (event.target as Element).closest('.model-picker__dialog') !== null) return
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus()
    }}>
    <button ref={trigger} type="button" className="thread-options__pill tt-focusable" aria-label="Thread options" aria-haspopup="dialog" aria-expanded={open}
      onClick={() => setOpen(value => !value)}>{optionSummary(models, thread)}<ChevronDown size={14} aria-hidden="true" /></button>
    {open ? <div ref={popover} className="thread-options__popover" role="dialog" aria-label="Thread options">
      <ThreadOptionFields models={models} modelId={thread.modelId} reasoningEffort={thread.reasoningEffort} runtimeMode={thread.runtimeMode}
        disabled={disabled} modelDisabled={locked && capabilities.configureThreadModel === false} onModel={modelId => void save({ modelId })} onReasoning={reasoningEffort => void save({ reasoningEffort })} onRuntime={runtimeMode => void save({ runtimeMode })} />
      {saving ? <small role="status">Saving...</small>
        : locked && thread.status === 'running' && turnNote ? <small>Available after this turn finishes.</small>
          : !locked && new Set(models.map(model => model.provider)).size > 1 ? <small className="thread-options__lock">Any provider until your first message.</small> : null}
    </div> : null}
    {/* A refused change is told whether or not the popover is still open: closing it must not take the news away. */}
    {error && <p className="agent-error" role="alert">{error}</p>}
  </div>
}
