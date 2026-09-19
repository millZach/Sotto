import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { capabilitiesForThread, isThreadBusy, isThreadProviderConnected, type AgentModel, type AgentRuntimeMode, type AgentState, type AgentThread } from '../../../shared/agents'
import type { AgentConnection } from './AgentContext'
import { ModelPicker } from './ModelPicker'

const RUNTIME_LABELS: Record<AgentRuntimeMode, string> = {
  'approval-required': 'Ask for approval',
  'auto-accept-edits': 'Allow edits',
  auto: 'Auto',
  'full-access': 'Full access',
}
const capitalise = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1)

/** The three controls laid out in full, as New thread and New terminal show them. */
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
      {model.reasoningEfforts.map(effort => <option key={effort} value={effort}>{capitalise(effort)}</option>)}
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

interface ChoiceOption { readonly id: string; readonly label: string; readonly disabled?: boolean }

/**
 * A chip that opens a short list above itself: the reasoning effort or the permissions. The chip reads the
 * current choice, or the setting's own name while the provider has not said. Arrow keys move through the
 * list; Escape or a pointer outside closes it and returns focus to the chip.
 */
function ChoiceChip({ label, placeholder, value, options, disabled, onChange }: {
  readonly label: string; readonly placeholder: string; readonly value: string; readonly options: readonly ChoiceOption[]
  readonly disabled: boolean; readonly onChange: (id: string) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!list.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss, true)
    const selected = list.current?.querySelector<HTMLButtonElement>('button[aria-selected="true"]:not(:disabled)')
    ;(selected ?? list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus()
    return () => { document.removeEventListener('pointerdown', dismiss, true) }
  }, [open])
  const current = options.find(option => option.id === value && !option.disabled)
  const choose = (id: string): void => { onChange(id); setOpen(false); trigger.current?.focus() }
  return <div className="thread-chip-menu" onKeyDown={event => {
    if (!open || event.key !== 'Escape') return
    event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus()
  }}>
    <button ref={trigger} type="button" className="thread-chip tt-focusable" role="combobox" aria-label={label} title={label} aria-haspopup="listbox" aria-expanded={open}
      aria-controls={open ? listId : undefined} disabled={disabled} onClick={() => setOpen(value => !value)}>
      <span>{current?.label ?? (value ? capitalise(value) : placeholder)}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    {open ? <div ref={list} id={listId} role="listbox" aria-label={label} className="thread-chip-menu__list" onKeyDown={event => {
      const items = [...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1
      if (next >= 0) { event.preventDefault(); items[next]?.focus() }
    }}>
      {options.map(option => <button type="button" role="option" key={option.id} aria-selected={option.id === value} disabled={option.disabled} onClick={() => choose(option.id)}>
        <span>{option.label}</span>{option.id === value && <Check size={14} aria-hidden="true" />}</button>)}
    </div> : null}
  </div>
}

/**
 * The composer's option controls: three chips saying what this thread is set to, the model with its
 * provider's mark, the reasoning effort and what the thread may do without asking. Each opens its own
 * list. New thread and New terminal show the same three controls laid out in full.
 */
export function ThreadOptions({ thread, state, command, turnNote = true }: {
  readonly thread: AgentThread; readonly state: AgentState; readonly command: AgentConnection['command']
  /** Explain options locked by a running turn; off where the composer already says it cannot send. */
  readonly turnNote?: boolean
}): ReactNode {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { models, locked } = threadModelChoices(state, thread)
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
  const modelDisabled = locked && capabilities.configureThreadModel === false
  const model = models.find(item => item.id === thread.modelId)
  const reasoning = thread.reasoningEffort ?? model?.defaultReasoningEffort ?? ''
  const efforts = model?.reasoningEfforts ?? []
  const modes = model?.runtimeModes ?? []
  const runtimeMode = thread.runtimeMode
  const providers = new Set(models.map(item => item.provider)).size
  return <div className="thread-options-bar" data-provider-locked={locked}>
    <div className="thread-options thread-options--chips">
      <ModelPicker models={models} modelId={thread.modelId} disabled={disabled || modelDisabled} onChange={modelId => void save({ modelId })}
        note={!locked && providers > 1 ? 'Any provider until your first message.' : undefined} />
      {efforts.length > 0 && <ChoiceChip label="Thread reasoning" placeholder="Effort" value={reasoning} disabled={disabled || modelDisabled} onChange={reasoningEffort => void save({ reasoningEffort })}
        options={[...(efforts.includes(reasoning) ? [] : [{ id: reasoning, label: reasoning ? capitalise(reasoning) : 'Provider default', disabled: true }]), ...efforts.map(effort => ({ id: effort, label: capitalise(effort) }))]} />}
      {modes.length > 0 && <ChoiceChip label="Thread permissions" placeholder="Permissions" value={runtimeMode ?? ''} disabled={disabled} onChange={mode => void save({ runtimeMode: mode as AgentRuntimeMode })}
        options={[...(runtimeMode === undefined ? [{ id: '', label: 'Provider default', disabled: true }] : modes.includes(runtimeMode) ? [] : [{ id: runtimeMode, label: RUNTIME_LABELS[runtimeMode], disabled: true }]), ...modes.map(mode => ({ id: mode, label: RUNTIME_LABELS[mode] }))]} />}
    </div>
    {saving ? <small role="status">Saving...</small> : locked && thread.status === 'running' && turnNote ? <small>Available after this turn finishes.</small> : null}
    {error && <p className="agent-error" role="alert">{error}</p>}
  </div>
}
