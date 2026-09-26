import React, { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { hostForThread, capabilitiesForThread, isThreadProviderConnected, PROVIDER_LABELS, PROVIDER_REJECTED_ACTION, PROVIDER_RESULT_UNCONFIRMED, THREAD_SETTINGS_UNRECONCILED, type AgentModel, type AgentRuntimeMode, type AgentState, type AgentThread } from '../../../shared/agents'
import type { AgentConnection } from './AgentContext'
import { moveListboxFocus } from './listboxKeys'
import { ModelPicker } from './ModelPicker'
import { EffortPicker, effortLabel } from './EffortPicker'
import { OPTION_CHIP_NAMES } from './optionChipNames'
import { pendingSettingsStore, permissionPatch, settingValues, settingValuesFor, unconfirmedKinds, usePendingSettings, usesProviderModes, type SettingKind, type SettingsPatch } from './pendingSettings'
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
  const own = model?.providerModes?.find(candidate => candidate.id === startingProviderMode(model, providerMode))
  const permissions = own ? own.name : mode ? RUNTIME_LABELS[mode] : 'Provider default'
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
    // Unchosen reads as the first mode, which is what the thread starts on, so only an unoffered one leads.
    const lead = providerMode === undefined || own.some(mode => mode.id === providerMode) ? [] : [{ id: providerMode, label: providerMode, disabled: true }]
    return [...lead, ...own.map(mode => ({ id: mode.id, label: mode.name,
      ...(mode.description || mode.asks ? { description: [mode.description, mode.asks].filter(Boolean).join(' ') } : {}) }))]
  }
  const modes = model?.runtimeModes ?? []
  if (modes.length === 0) return []
  const lead = runtimeMode === undefined ? [{ id: '', label: 'Provider default', disabled: true }]
    : modes.includes(runtimeMode) ? [] : [{ id: runtimeMode, label: RUNTIME_LABELS[runtimeMode], disabled: true }]
  return [...lead, ...modes.map(mode => ({ id: mode, label: RUNTIME_LABELS[mode] }))]
}
/** The provider mode a thread is on, or the one it starts on when none has been chosen: the first offered. */
export const startingProviderMode = (model: AgentModel | undefined, providerMode: string | undefined): string | undefined =>
  providerMode ?? model?.providerModes?.[0]?.id

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
    {efforts.length > 0 && <label><span>Reasoning</span><select aria-label={OPTION_CHIP_NAMES.effort} title="Reasoning" value={reasoning} disabled={disabled || modelDisabled} onChange={event => onReasoning(event.target.value)}>
      {efforts.map(option => <option key={option.id} value={option.id} disabled={option.disabled}>{option.label}</option>)}
    </select></label>}
    {modes.length > 0 && <label><span>Permissions</span><select aria-label={OPTION_CHIP_NAMES.permissions} title="Permissions" value={(own ? startingProviderMode(model, providerMode) : runtimeMode) ?? ''} disabled={disabled}
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
  state = { ...state, host: hostForThread(state.host, thread) }
  if (thread.nativeSessionStarted === false) {
    const models = state.host.models.filter(model => model.id === thread.modelId || canCreateWith(state, model))
    return { models, locked: false }
  }
  return { models: state.host.models.filter(model => !thread.providerId || model.providerId === thread.providerId), locked: true }
}

/**
 * What a permission mode still lets the provider do, said as the provider doing it, for the caption beside the
 * chips while a change away from it waits to be confirmed. The difference decides what the provider does on its
 * next tool call, so the caption names the mode in force rather than the one coming.
 */
const IN_FORCE: Record<AgentRuntimeMode, string> = {
  'approval-required': 'asks for approval',
  'auto-accept-edits': 'makes edits without asking',
  auto: 'decides what to ask you about',
  'full-access': 'runs anything without asking',
}

/** The caption beside the chips while a permission change waits: what is still in force, in the provider's name. */
export function permissionInForceCaption(provider: string, inForce: { readonly runtimeMode?: AgentRuntimeMode | undefined; readonly providerModeName?: string | undefined }): string {
  if (inForce.providerModeName) return `${provider} stays on ${inForce.providerModeName} until it confirms.`
  if (inForce.runtimeMode) return `${provider} still ${IN_FORCE[inForce.runtimeMode]} until it confirms.`
  return `${provider} keeps its own default until it confirms.`
}

/**
 * The alert under the chips after a press the provider did not take, which puts the chip back and offers Try again.
 * A plain refusal is main's `PROVIDER_REJECTED_ACTION`, with nothing left to reconcile, so it can say nothing else
 * changed. Any other sentence is main's or the provider's own reason, shown as it is with nothing claimed beside it.
 * No answer at all leaves the chip on what the thread last reported, and Try again sends the choice once more.
 */
export function settingRefusalText(provider: string, wanted: string, inForce: string, error: string | null): string {
  if (error === null) return `Sotto did not get ${provider}'s answer about ${wanted}, so the chip shows what the thread last reported. Try again to send it once more.`
  if (error === PROVIDER_REJECTED_ACTION) return `${provider} did not switch to ${wanted}. The thread stays on ${inForce}; nothing else changed.`
  return `${provider} did not switch to ${wanted}. ${error}`
}

/**
 * The line under the chips when the provider never gave a result. Main keeps the change for the thread's next start
 * and the chip keeps showing it, so this says what happened and what comes next, and offers nothing to press: main
 * takes no other action on the thread until it knows. The provider's own account (a lost answer that stopped the
 * session, and what stopped with it) already names the provider and says what happened, so it is shown alone; main's
 * general one is put in plain words.
 */
export function unconfirmedSettingText(provider: string, wanted: string, error: string | null): string {
  if (error === null || error === PROVIDER_RESULT_UNCONFIRMED || error === THREAD_SETTINGS_UNRECONCILED) {
    return `${provider} has not confirmed ${wanted}. The thread starts on ${wanted} the next time it is used, and Sotto checks it then.`
  }
  return error
}

/**
 * A chip that opens a short list above itself for permissions. The chip reads the
 * current choice, or the setting's own name while the provider has not said. Arrow keys move through the
 * list; Escape, Tab or a pointer outside closes it, and Escape returns focus to the chip. A `pending` choice is
 * one the provider has not confirmed: the chip shows it with a dashed outline and a small dot, and is described by
 * the line that says what is still in force (`describedBy`), so the words are the ones on screen, said once.
 */
function ChoiceChip({ label, placeholder, value, options, disabled, pending, describedBy, onChange }: {
  readonly label: string; readonly placeholder: string; readonly value: string; readonly options: readonly ChoiceOption[]
  readonly disabled: boolean; readonly pending: boolean; readonly describedBy?: string | undefined; readonly onChange: (id: string) => void
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
      aria-controls={open ? listId : undefined} aria-describedby={pending ? describedBy : undefined} data-pending={pending ? 'true' : undefined}
      disabled={disabled} onClick={() => setOpen(value => !value)}>
      {pending ? <i className="thread-chip__pending" aria-hidden="true" /> : null}
      <span>{current?.label ?? (value ? capitalise(value) : placeholder)}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    {open ? <div ref={list} id={listId} role="listbox" aria-label={label} className="thread-chip-menu__list" onKeyDown={event => moveListboxFocus(event, list.current)}>
      {options.map(option => <button type="button" role="option" key={option.id} aria-selected={option.id === value} disabled={option.disabled} onClick={() => choose(option.id)}>
        <span>{option.label}{option.description ? <small>{option.description}</small> : null}</span>{option.id === value && <Check size={14} aria-hidden="true" />}</button>)}
    </div> : null}
  </div>
}

/** Whether a prompt on this thread is on its way to the provider, which a settings change would have to wait behind. */
const sending = (state: AgentState, threadId: string): boolean =>
  state.deliveries?.some(delivery => delivery.threadId === threadId && (delivery.status === 'queued' || delivery.status === 'submitting' || delivery.status === 'uncertain')) === true

/**
 * The composer's option controls: three chips saying what this thread is set to, the model with its
 * provider's mark, the reasoning effort and what the thread may do without asking. Effort opens its
 * card; the other chips open lists. A press shows at once and the chips stay live while it is saved
 * (`pendingSettings.ts`). A permission change the provider has not confirmed is marked on its chip, and a
 * caption beside the chips says what is still in force. A refusal puts the chip back and says so under the chips,
 * with Try again; a result the provider never gave keeps the choice on the chip and says what comes next. Those
 * lines go in `noticeSlot` when the composer gives one, a row of its own under the chips and the send button, so
 * they never move the row; otherwise under the chips. Focus stays on the chip a choice was made from. New thread
 * and New terminal show the same three controls laid out in full.
 */
export function ThreadOptions({ thread, state, command, turnNote = true, getDraftText, onDraftText, noticeSlot }: {
  readonly thread: AgentThread; readonly state: AgentState; readonly command: AgentConnection['command']
  /** Explain options locked by a running turn; off where the composer already says it cannot send. */
  readonly turnNote?: boolean
  /** Present only beside an editable prompt; Ultrathink changes its visible text before sending. */
  readonly getDraftText?: () => string
  readonly onDraftText?: (text: string) => void
  /** Where the composer wants the lines about a refused or unconfirmed change, under its whole footer row. */
  readonly noticeSlot?: HTMLElement | null | undefined
}): ReactNode {
  const settings = usePendingSettings(thread.id)
  const bar = useRef<HTMLDivElement>(null)
  const refocus = useRef<HTMLButtonElement | null>(null)
  const captionId = useId()
  const unconfirmedId = useId()
  const { models, locked } = threadModelChoices(state, thread)
  /** What the window has drawn from main's published state: the confirmed values a press is measured against. */
  const drawn = settingValues(state, thread)
  const unconfirmed = unconfirmedKinds(state, thread.id)
  /**
   * The chips are fixed by what a provider actually refuses: a turn under way, an unanswered request, an archived
   * thread, a provider that is gone, and a prompt still on its way, which a change would run behind once its turn has
   * started. Also while main keeps a change with no result, since it takes no other action on the thread until it
   * knows. They do not read the coordinator's busy mark, which covers the very save a press starts and outlives its
   * reply: a save in flight fixes nothing, and main's thread lane runs the saves and any prompt in order.
   */
  const fixed = Boolean(thread.archivedAt) || thread.status === 'running' || thread.requests.length > 0 || sending(state, thread.id) || unconfirmed.size > 0
    || (locked && !isThreadProviderConnected(state.host, thread))
  const unconfirmedKey = [...unconfirmed].join(',')
  useLayoutEffect(() => { pendingSettingsStore.observe(thread.id, drawn, unconfirmed) }, [thread.id, drawn.model, drawn.effort, drawn.permissions, unconfirmedKey])
  const threads = state.host.threads
  useEffect(() => { pendingSettingsStore.prune(new Set(threads.map(item => item.id))) }, [threads])
  useEffect(() => () => { pendingSettingsStore.forget(thread.id) }, [thread.id])
  const saving = Object.values(settings.pending).some(item => item?.awaiting === 'provider')
  useEffect(() => {
    // A chip keeps focus through its own save; this puts it back when something took focus to the page meanwhile.
    if (saving || refocus.current === null) return
    const chip = refocus.current
    refocus.current = null
    if (chip.isConnected && !chip.disabled && (document.activeElement === null || document.activeElement === document.body)) chip.focus()
  }, [saving])
  const press = (kind: SettingKind, value: string, patch: SettingsPatch, showing: string = drawn[kind]): void => {
    // The effort card keeps its own focus while it saves; a list or menu hands it back to its chip.
    refocus.current = kind === 'effort' ? null
      : (document.activeElement as Element | null)?.closest('.thread-chip-menu, .model-picker')?.querySelector<HTMLButtonElement>('.thread-chip') ?? null
    pendingSettingsStore.press(thread.id, kind, value, patch, command, drawn, showing)
  }
  const capabilities = capabilitiesForThread(state.host, thread)
  if (locked && !capabilities.configureThread) return null
  const modelDisabled = locked && capabilities.configureThreadModel === false
  // The model shown is the one pressed; effort and permissions are read for it, as they will be once it lands.
  const confirmedModel = models.find(item => item.id === thread.modelId)
  const modelId = settings.pending.model?.value ?? thread.modelId
  const model = models.find(item => item.id === modelId)
  // What each chip shows with nothing pressed: the drawn values, except that a model change starts on the new
  // model's default effort, so that is what the effort chip shows meanwhile.
  const unpressed = modelId === thread.modelId ? drawn
    : settingValuesFor({ modelId, ...(thread.runtimeMode ? { runtimeMode: thread.runtimeMode } : {}), ...(thread.providerMode ? { providerMode: thread.providerMode } : {}) }, model)
  const reasoning = settings.pending.effort?.value ?? unpressed.effort
  const permission = settings.pending.permissions?.value ?? unpressed.permissions
  const efforts = effortChoices(model, reasoning)
  const modes = modeChoices(model, thread.runtimeMode, thread.providerMode)
  const providers = new Set(models.map(item => item.provider)).size
  const providerName = thread.providerId ? PROVIDER_LABELS[thread.providerId] : model?.provider
  const provider = providerName ?? 'The provider'
  const claude = (thread.providerId ?? model?.providerId) === 'claude' || /^claude(?: code)?$/iu.test(model?.provider ?? '')
  const hasUltrathink = /\bultrathink\b/iu.test(getDraftText?.() ?? '')
  const addUltrathink = claude && getDraftText && onDraftText ? (): void => {
    const draftText = getDraftText()
    if (!/\bultrathink\b/iu.test(draftText)) onDraftText(draftText ? `${draftText}${/\s$/u.test(draftText) ? '' : '\n\n'}ultrathink` : 'ultrathink')
  } : undefined
  const note = locked ? (providerName ? `This thread stays with ${providerName}.` : undefined) : providers > 1 ? 'Any provider until your first message.' : undefined
  /** A setting's value in words: a model's name, an effort level, a permission mode in its own provider's terms. */
  const valueName = (kind: SettingKind, value: string, owner: AgentModel | undefined): string => kind === 'model' ? models.find(item => item.id === value)?.name ?? value
    : kind === 'effort' ? (value ? `${effortLabel(value)} effort` : "the model's default effort")
      : owner?.providerModes?.find(mode => mode.id === value)?.name ?? (value ? RUNTIME_LABELS[value as AgentRuntimeMode] ?? value : "the provider's default")
  // Marked from the press until the window draws the provider's answer, not merely until its reply (#306), and
  // while a save is in flight even when the press is back on the value in force: that save may still land first.
  const pendingPermission = settings.pending.permissions ?? null
  const permissionUnconfirmed = pendingPermission?.awaiting === 'unconfirmed'
  const caption = pendingPermission === null || permissionUnconfirmed ? '' : permissionInForceCaption(provider, usesProviderModes(confirmedModel)
    ? { providerModeName: valueName('permissions', drawn.permissions, confirmedModel) } : { runtimeMode: (drawn.permissions || undefined) as AgentRuntimeMode | undefined })
  const retry = (kind: SettingKind): void => {
    if (pendingSettingsStore.retry(thread.id, kind, command, drawn)) bar.current?.querySelector<HTMLButtonElement>(`[aria-label="${OPTION_CHIP_NAMES[kind]}"]`)?.focus()
  }
  const kinds: readonly SettingKind[] = ['model', 'effort', 'permissions']
  const notices = <>
    {kinds.map(kind => {
      const pending = settings.pending[kind]
      if (pending?.awaiting !== 'unconfirmed') return null
      return <p key={`unconfirmed-${kind}`} id={kind === 'permissions' ? unconfirmedId : undefined} className="thread-options__notice" role="alert">
        <span>{unconfirmedSettingText(provider, valueName(kind, pending.value, model), pending.error)}</span></p>
    })}
    {kinds.map(kind => {
      const refusal = settings.refusals[kind]
      if (!refusal) return null
      return <p key={`refused-${kind}`} className="thread-options__notice" role="alert">
        <span>{settingRefusalText(provider, valueName(kind, refusal.wanted, model), valueName(kind, drawn[kind], confirmedModel), refusal.error)}</span>
        <button type="button" className="tt-focusable" disabled={fixed} onClick={() => retry(kind)}>Try again</button></p>
    })}
  </>
  return <div ref={bar} className="thread-options-bar" data-provider-locked={locked}>
    <div className="thread-options thread-options--chips">
      <ModelPicker models={models} modelId={modelId} disabled={fixed || modelDisabled} onChange={id => press('model', id, { modelId: id })} note={note} />
      {efforts.length > 0 && <EffortPicker key={`${modelId}:${model?.reasoningEfforts?.join(',') ?? ''}`} value={reasoning} options={efforts}
        disabled={fixed || modelDisabled} onChange={reasoningEffort => press('effort', reasoningEffort, { reasoningEffort }, unpressed.effort)}
        defaultValue={model?.defaultReasoningEffort} modelName={model?.name}
        hasUltrathink={hasUltrathink} {...(addUltrathink ? { onUltrathink: addUltrathink } : {})} />}
      {modes.length > 0 && <ChoiceChip label={OPTION_CHIP_NAMES.permissions} placeholder="Permissions" value={permission} options={modes} disabled={fixed}
        pending={pendingPermission !== null} describedBy={permissionUnconfirmed ? unconfirmedId : captionId}
        onChange={mode => press('permissions', mode, permissionPatch(model, mode), unpressed.permissions)} />}
    </div>
    {/* Always present, so assistive technology hears the caption when it arrives. */}
    <span id={captionId} className="thread-options__caption" role="status">{caption}</span>
    {locked && thread.status === 'running' && turnNote ? <small>Available after this turn finishes.</small> : null}
    {noticeSlot ? createPortal(notices, noticeSlot) : notices}
  </div>
}
