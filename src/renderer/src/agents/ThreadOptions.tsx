import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { capabilitiesForThread, isThreadBusy, isThreadProviderConnected, PROVIDER_LABELS, type AgentModel, type AgentRuntimeMode, type AgentState, type AgentThread } from '../../../shared/agents'
import type { AgentConnection } from './AgentContext'
import { moveListboxFocus } from './listboxKeys'
import { ModelPicker } from './ModelPicker'
import { EffortPicker } from './EffortPicker'
import './threadChips.css'

const RUNTIME_LABELS: Record<AgentRuntimeMode, string> = {
  'approval-required': 'Ask for approval',
  'auto-accept-edits': 'Allow edits',
  auto: 'Auto',
  'full-access': 'Full access',
}
const capitalise = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1)

/** The choices used when creating a thread, visible while its optional controls are collapsed. */
export function threadOptionsSummary(model: AgentModel | undefined, effort: string | undefined, mode: AgentRuntimeMode | undefined, providerMode?: string): string {
  const reasoning = effort ?? model?.defaultReasoningEffort
  const own = model?.providerModes?.find(candidate => candidate.id === providerMode)
  const permissions = own ? own.name : model?.providerModes?.length ? 'Provider default' : mode ? RUNTIME_LABELS[mode] : 'Provider default'
  return [model?.name ?? 'Choose model', reasoning ? capitalise(reasoning) : null, permissions].filter(Boolean).join(' · ')
}

interface ChoiceOption { readonly id: string; readonly label: string; readonly description?: string; readonly disabled?: boolean }

/** The effort levels a model offers, led by the current one as unchoosable when the model does not offer it. */
function effortChoices(model: AgentModel | undefined, reasoning: string): ChoiceOption[] {
  const efforts = model?.reasoningEfforts ?? []
  if (efforts.length === 0) return []
  const lead = efforts.includes(reasoning) ? [] : [{ id: reasoning, label: reasoning ? capitalise(reasoning) : 'Provider default', disabled: true }]
  return [...lead, ...efforts.map(effort => ({ id: effort, label: capitalise(effort) }))]
}

/**
 * The permission modes a model offers, led by "Provider default" or an unoffered current mode as
 * unchoosable. A provider whose modes are its own (Devin) answers with those instead of Sotto's four, and
 * each carries what Sotto will still ask about under it, so a mode named for what the provider stops
 * asking cannot be read as Sotto stopping too.
 */
function modeChoices(model: AgentModel | undefined, runtimeMode: AgentRuntimeMode | undefined, providerMode: string | undefined): ChoiceOption[] {
  const own = model?.providerModes ?? []
  if (own.length > 0) {
    const lead = providerMode === undefined ? [{ id: '', label: 'Provider default', disabled: true }]
      : own.some(mode => mode.id === providerMode) ? [] : [{ id: providerMode, label: providerMode, disabled: true }]
    return [...lead, ...own.map(mode => ({ id: mode.id, label: mode.name,
      ...(mode.description || mode.asks ? { description: [mode.description, mode.asks].filter(Boolean).join(' ') } : {}) }))]
  }
  const modes = model?.runtimeModes ?? []
  if (modes.length === 0) return []
  const lead = runtimeMode === undefined ? [{ id: '', label: 'Provider default', disabled: true }]
    : modes.includes(runtimeMode) ? [] : [{ id: runtimeMode, label: RUNTIME_LABELS[runtimeMode], disabled: true }]
  return [...lead, ...modes.map(mode => ({ id: mode, label: RUNTIME_LABELS[mode] }))]
}
/** Whether this model's permission list is the provider's own vocabulary rather than Sotto's four. */
const usesProviderModes = (model: AgentModel | undefined): boolean => (model?.providerModes?.length ?? 0) > 0

/** The three controls laid out in full, as New thread and New terminal show them. */
export function ThreadOptionFields({ models, modelId, reasoningEffort, runtimeMode, providerMode, onModel, onReasoning, onRuntime, onProviderMode, disabled = false, modelDisabled = false }: {
  readonly models: AgentModel[]
  readonly modelId: string
  readonly reasoningEffort?: string | undefined
  readonly runtimeMode?: AgentRuntimeMode | undefined
  readonly providerMode?: string | undefined
  readonly onModel: (id: string) => void
  readonly onReasoning: (effort: string) => void
  readonly onRuntime: (mode: AgentRuntimeMode) => void
  /** Only for a provider that names its own modes; the owner saves it in place of `runtimeMode`. */
  readonly onProviderMode?: ((mode: string) => void) | undefined
  readonly disabled?: boolean
  /** Model and reasoning stay visible but fixed; permissions remain editable. */
  readonly modelDisabled?: boolean
}): ReactNode {
  const model = models.find(item => item.id === modelId)
  const reasoning = reasoningEffort ?? model?.defaultReasoningEffort ?? ''
  const efforts = effortChoices(model, reasoning)
  const own = usesProviderModes(model)
  const modes = modeChoices(model, runtimeMode, providerMode)
  return <div className="thread-options">
    <div className="thread-options__model"><span>Model</span><ModelPicker models={models} modelId={modelId} disabled={disabled || modelDisabled} onChange={onModel} /></div>
    {efforts.length > 0 && <label><span>Reasoning</span><select aria-label="Thread reasoning" title="Reasoning" value={reasoning} disabled={disabled || modelDisabled} onChange={event => onReasoning(event.target.value)}>
      {efforts.map(option => <option key={option.id} value={option.id} disabled={option.disabled}>{option.label}</option>)}
    </select></label>}
    {modes.length > 0 && <label><span>Permissions</span><select aria-label="Thread permissions" title="Permissions" value={(own ? providerMode : runtimeMode) ?? ''} disabled={disabled}
      onChange={event => own ? onProviderMode?.(event.target.value) : onRuntime(event.target.value as AgentRuntimeMode)}>
      {modes.map(option => <option key={option.id} value={option.id} disabled={option.disabled} title={option.description}>{option.label}</option>)}
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

/**
 * A chip that opens a short list above itself for permissions. The chip reads the
 * current choice, or the setting's own name while the provider has not said. Arrow keys move through the
 * list; Escape, Tab or a pointer outside closes it, and Escape returns focus to the chip.
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
  return <div className="thread-chip-menu"
    onKeyDown={event => {
      if (!open || event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus()
    }}
    onBlur={event => { if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false) }}>
    <button ref={trigger} type="button" className="thread-chip tt-focusable" role="combobox" aria-label={label} title={label} aria-haspopup="listbox" aria-expanded={open}
      aria-controls={open ? listId : undefined} disabled={disabled} onClick={() => setOpen(value => !value)}>
      <span>{current?.label ?? (value ? capitalise(value) : placeholder)}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    {open ? <div ref={list} id={listId} role="listbox" aria-label={label} className="thread-chip-menu__list" onKeyDown={event => moveListboxFocus(event, list.current)}>
      {options.map(option => <button type="button" role="option" key={option.id} aria-selected={option.id === value} disabled={option.disabled} onClick={() => choose(option.id)}>
        <span>{option.label}{option.description ? <small>{option.description}</small> : null}</span>{option.id === value && <Check size={14} aria-hidden="true" />}</button>)}
    </div> : null}
  </div>
}

/**
 * The composer's option controls: three chips saying what this thread is set to, the model with its
 * provider's mark, the reasoning effort and what the thread may do without asking. Effort opens its
 * card; the other chips open lists. While a change is being confirmed the chips are fixed; afterwards,
 * focus returns to a closed chip unless the user has moved on. New thread and New terminal show the same three
 * controls laid out in full.
 */
export function ThreadOptions({ thread, state, command, turnNote = true, draftText, onDraftText }: {
  readonly thread: AgentThread; readonly state: AgentState; readonly command: AgentConnection['command']
  /** Explain options locked by a running turn; off where the composer already says it cannot send. */
  readonly turnNote?: boolean
  /** Present only beside an editable prompt; Ultrathink changes its visible text before sending. */
  readonly draftText?: string
  readonly onDraftText?: (text: string) => void
}): ReactNode {
  const [saving, setSaving] = useState<'effort' | 'other' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refocus = useRef<HTMLButtonElement | null>(null)
  const { models, locked } = threadModelChoices(state, thread)
  const fixed = isThreadBusy(state, thread.id) || Boolean(thread.archivedAt) || (locked && (!isThreadProviderConnected(state.host, thread) || thread.status === 'running' || thread.requests.length > 0))
  const disabled = saving !== null || fixed
  /**
   * Effort alone stays live through its own save. It shows the level you pressed rather than the one the
   * provider has confirmed, and a control that shows a level it will not let you change reads as stuck; the
   * card sends where you land instead. So it is fixed by what a provider actually refuses — a turn under way,
   * an unanswered request, an archived thread, a provider that is gone — and by a model or permissions save,
   * which is the other settings change a provider will not take beside this one. It does not read the
   * coordinator's busy mark: that mark covers this very save, and it outlives the save's own reply, so the
   * chip went dead for a moment each time it was used and dropped the focus Escape had just handed back.
   */
  const effortDisabled = saving === 'other' || Boolean(thread.archivedAt) || thread.status === 'running'
    || thread.requests.length > 0 || (locked && !isThreadProviderConnected(state.host, thread))
  const save = async (patch: { modelId?: string; reasoningEffort?: string; runtimeMode?: AgentRuntimeMode; providerMode?: string }, lane: 'effort' | 'other' = 'other'): Promise<boolean> => {
    // The choice was made inside a chip's list; a chip fixed while saving has focus put back afterwards.
    refocus.current = lane === 'effort' ? null
      : (document.activeElement as Element | null)?.closest('.thread-chip-menu, .model-picker')?.querySelector<HTMLButtonElement>('.thread-chip') ?? null
    setSaving(lane); setError(null)
    try {
      const result = await command({ type: 'configure-thread', threadId: thread.id, ...patch })
      if (!result || result.error) { setError(result?.error ?? 'Could not confirm this change. Try again.'); return false }
      return true
    } catch {
      setError('Could not confirm this change. Try again.')
      return false
    } finally { setSaving(null) }
  }
  useEffect(() => {
    if (saving !== null || refocus.current === null) return
    const chip = refocus.current
    refocus.current = null
    if (chip.isConnected && (document.activeElement === null || document.activeElement === document.body)) chip.focus()
  }, [saving])
  const capabilities = capabilitiesForThread(state.host, thread)
  if (locked && !capabilities.configureThread) return null
  const modelDisabled = locked && capabilities.configureThreadModel === false
  const model = models.find(item => item.id === thread.modelId)
  const reasoning = thread.reasoningEffort ?? model?.defaultReasoningEffort ?? ''
  const efforts = effortChoices(model, reasoning)
  const ownModes = usesProviderModes(model)
  const modes = modeChoices(model, thread.runtimeMode, thread.providerMode)
  const providers = new Set(models.map(item => item.provider)).size
  const providerName = thread.providerId ? PROVIDER_LABELS[thread.providerId] : model?.provider
  const claude = (thread.providerId ?? model?.providerId) === 'claude' || /^claude(?: code)?$/iu.test(model?.provider ?? '')
  const hasUltrathink = /\bultrathink\b/iu.test(draftText ?? '')
  const addUltrathink = claude && draftText !== undefined && onDraftText ? (): void => {
    if (!hasUltrathink) onDraftText(draftText ? `${draftText}${/\s$/u.test(draftText) ? '' : '\n\n'}ultrathink` : 'ultrathink')
  } : undefined
  const note = locked ? (providerName ? `This thread stays with ${providerName}.` : undefined) : providers > 1 ? 'Any provider until your first message.' : undefined
  return <div className="thread-options-bar" data-provider-locked={locked}>
    <div className="thread-options thread-options--chips">
      <ModelPicker models={models} modelId={thread.modelId} disabled={disabled || modelDisabled} onChange={modelId => void save({ modelId })} note={note} />
      {efforts.length > 0 && <EffortPicker key={`${thread.modelId}:${model?.reasoningEfforts?.join(',') ?? ''}`} value={reasoning} options={efforts}
        disabled={effortDisabled || modelDisabled} onChange={reasoningEffort => save({ reasoningEffort }, 'effort')}
        defaultValue={model?.defaultReasoningEffort} modelName={model?.name}
        hasUltrathink={hasUltrathink} {...(addUltrathink ? { onUltrathink: addUltrathink } : {})} />}
      {modes.length > 0 && <ChoiceChip label="Thread permissions" placeholder="Permissions" value={(ownModes ? thread.providerMode : thread.runtimeMode) ?? ''} options={modes} disabled={disabled}
        onChange={mode => void save(ownModes ? { providerMode: mode } : { runtimeMode: mode as AgentRuntimeMode })} />}
    </div>
    {saving ? <small role="status">Saving...</small> : locked && thread.status === 'running' && turnNote ? <small>Available after this turn finishes.</small> : null}
    {error && <p className="agent-error" role="alert">{error}</p>}
  </div>
}
