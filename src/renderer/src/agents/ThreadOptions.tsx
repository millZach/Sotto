import React, { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { t } from '@lingui/core/macro'
import { Check, ChevronDown, Lock, Shield } from 'lucide-react'
import { hostForThread, capabilitiesForThread, isThreadProviderConnected, PROVIDER_LABELS, PROVIDER_REJECTED_ACTION, PROVIDER_RESULT_UNCONFIRMED, THREAD_SETTINGS_UNRECONCILED, type AgentModel, type AgentRuntimeMode, type AgentState, type AgentThread } from '../../../shared/agents'
import { catalogEntry, chosenModelId, resolveModel } from '../../../shared/modelCatalog'
import type { AgentConnection } from './AgentContext'
import { moveListboxFocus } from './listboxKeys'
import { ModelPicker, type UnavailablePickerProvider } from './ModelPicker'
import { useOwnServersBridge } from './OwnModelServers'
import { localHostId } from '../features/onboarding/localAgents'
import { EffortPicker, effortLabel } from './EffortPicker'
import { OPTION_CHIP_NAMES } from './optionChipNames'
import { providerKey } from './threadFacts'
import { pendingSettingsStore, permissionPatch, settingValues, settingValuesFor, unconfirmedKinds, usePendingSettings, usesProviderModes, type SettingKind, type SettingsPatch } from './pendingSettings'
import { WatcherPermissionChip } from '../watcher/WatcherPermissionChip'
import { useWatcherRoom } from '../watcher/watcherRoom'
import { WatchOnSendToggle } from '../watcher/WatchControls'
import { watcherProviderOf, type WatcherProvider } from '../watcher/watcherProviders'
import { useSaveOrchestrating } from '../watcher/orchestratingRole'
import { useLingui as useInterfaceLanguage } from '../state/interfaceLanguageReact'
import './threadChips.css'

export const RUNTIME_LABELS: Record<AgentRuntimeMode, string> = {
  'approval-required': 'Ask for approval',
  'auto-accept-edits': 'Allow edits',
  auto: 'Auto',
  'full-access': 'Full access',
}
/**
 * What each of Cursor's three modes does, said as Cursor doing it (ADR-0128), in the interface language. Cursor has no
 * Allow edits: it edits inside the project without asking under every mode, so Ask for approval says so, and Auto says
 * where its judgement runs.
 */
export function cursorModeLine(mode: AgentRuntimeMode): string | undefined {
  switch (mode) {
    case 'approval-required': return t`Cursor asks before commands, web requests and tools. It edits files inside the project without asking.`
    case 'auto': return t`Cursor’s own auto-review decides what runs without asking. Its classifier runs on Cursor’s servers; what it holds back comes to you.`
    case 'full-access': return t`Cursor runs commands, web requests and tools and edits files without asking, in the project and outside it.`
    default: return undefined
  }
}
/**
 * What each of DeepSeek Harness's three modes does, said as the harness doing it (ADR-0138), in the interface
 * language. Its permissions are a sandbox boundary: Ask for approval denies a first attempt and the model asks to
 * retry it, and Allow edits also lets commands and network run inside the sandbox, so both say so.
 */
export function deepseekModeLine(mode: AgentRuntimeMode): string | undefined {
  switch (mode) {
    case 'approval-required': return t`DeepSeek Harness denies a first write or command and the model then asks you to allow the retry. A model that does not ask simply fails the write.`
    case 'auto-accept-edits': return t`DeepSeek Harness edits, runs commands and uses the network inside the workspace sandbox without asking. It asks before anything crosses that boundary.`
    case 'full-access': return t`DeepSeek Harness runs commands and edits files without asking, in the project and outside it.`
    default: return undefined
  }
}
/** Permissions' glyph, which stands for the value in a narrow composer. */
export const PERMISSIONS_ICON = <Shield size={14} aria-hidden="true" />
const capitalise = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1)

/** The choices used when creating a thread, visible while its optional controls are collapsed. */
export function threadOptionsSummary(model: AgentModel | undefined, effort: string | undefined, mode: AgentRuntimeMode | undefined, providerMode?: string): string {
  const reasoning = effort ?? model?.defaultReasoningEffort
  const own = model?.providerModes?.find(candidate => candidate.id === startingProviderMode(model, providerMode))
  const permissions = own ? own.name : mode ? RUNTIME_LABELS[mode] : 'Provider default'
  return [model?.name ?? 'Choose model', reasoning ? capitalise(reasoning) : null, permissions].filter(Boolean).join(' · ')
}

/**
 * Watcher's permission mode said as a fact, where its room's bridge offers no way to change it: an older stand-in, or
 * a build whose main does not take the choice yet. Where it does, `WatcherPermissionChip` stands here instead.
 */
export function WatcherPermission({ mode = 'approval-required' }: { readonly mode?: AgentRuntimeMode | undefined }): ReactNode {
  return <span className="thread-options__pinned" title="This Sotto cannot change what Watcher may do without asking.">
    <Lock size={13} aria-hidden="true" /><span className="tt-visually-hidden">Watcher’s permissions: </span>{RUNTIME_LABELS[mode]}</span>
}

export interface ChoiceOption {
  readonly id: string; readonly label: string; readonly description?: string; readonly disabled?: boolean
  /** The description is a message of Sotto's in the interface language, which runs right to left where that language does. */
  readonly translated?: boolean
}

/** The effort levels a model offers, led by the current one as unchoosable when the model does not offer it. */
export function effortChoices(model: AgentModel | undefined, reasoning: string): ChoiceOption[] {
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
export function modeChoices(model: AgentModel | undefined, runtimeMode: AgentRuntimeMode | undefined, providerMode: string | undefined): ChoiceOption[] {
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
  return [...lead, ...modes.map(mode => {
    const line = model?.providerId === 'cursor' ? cursorModeLine(mode) : model?.providerId === 'deepseek' ? deepseekModeLine(mode) : undefined
    return { id: mode, label: RUNTIME_LABELS[mode], ...(line ? { description: line, translated: true } : {}) }
  })]
}
/** The provider mode a thread is on, or the one it starts on when none has been chosen: the first offered. */
export const startingProviderMode = (model: AgentModel | undefined, providerMode: string | undefined): string | undefined =>
  providerMode ?? model?.providerModes?.[0]?.id

/** The three controls laid out in full, as New thread shows them. */
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
  // Cursor's permission lines are messages, so a change of interface language draws this again.
  useInterfaceLanguage()
  const model = resolveModel(models, modelId)
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
 * start is unknown) the thread stays with its own provider. `sameProvider` keeps it there from the start:
 * Watcher's provider is chosen when it is created, and changing it is another Watcher (ADR-0073).
 */
function threadModelChoices(state: AgentState, thread: AgentThread, sameProvider = false): { readonly models: AgentModel[]; readonly locked: boolean } {
  state = { ...state, host: hostForThread(state.host, thread) }
  if (thread.nativeSessionStarted === false) {
    const own = catalogEntry(state.host.models, thread.modelId)
    const provider = thread.providerId ?? (own ? own.providerId ?? providerKey(own.provider) : undefined)
    const models = state.host.models.filter(model => model === own || canCreateWith(state, model))
      .filter(model => !sameProvider || provider === undefined || (model.providerId ?? providerKey(model.provider)) === provider)
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
export function unconfirmedSettingText(provider: string, wanted: string, error: string | null, inForce?: string): string {
  if (error === null || error === PROVIDER_RESULT_UNCONFIRMED || error === THREAD_SETTINGS_UNRECONCILED) {
    // A model or effort with no result holds nothing back, so a turn can run on the one before it meanwhile (#1192).
    if (inForce !== undefined && inForce !== wanted) return `${provider} has not confirmed ${wanted}. Until it does, a turn can still run on ${inForce}.`
    return `${provider} has not confirmed ${wanted}. The thread starts on ${wanted} the next time it is used, and Sotto checks it then.`
  }
  return error
}

/**
 * A chip that opens a short list above itself for permissions. The chip reads the
 * current choice, or the setting's own name while the provider has not said. Arrow keys move through the
 * list; Escape, Tab or a pointer outside closes it, and Escape returns focus to the chip. A `pending` choice is
 * one the provider has not confirmed: the chip shows it with a dashed outline and a small dot, and is described by
 * the line that says what is still in force (`describedBy`), so the words are the ones on screen, said once. A `foot`
 * is a line under the list that holds in every choice; it sits outside the listbox, so it is read, never chosen.
 */
export function ChoiceChip({ label, placeholder, value, options, disabled, pending, describedBy, onChange, foot, fixedReason, flip = false, icon }: {
  readonly label: string; readonly placeholder: string; readonly value: string; readonly options: readonly ChoiceOption[]
  readonly disabled: boolean; readonly pending: boolean; readonly describedBy?: string | undefined; readonly onChange: (id: string) => void
  readonly foot?: string | undefined
  /** Why the chip cannot be pressed now, on its tooltip while it is disabled. */
  readonly fixedReason?: string | undefined
  /**
   * Opens below the chip when there is no room above it inside the area that scrolls it, as on a Settings page where the
   * chip can sit near the top. The composer's chips never need it: they sit at the bottom of their pane.
   */
  readonly flip?: boolean
  /**
   * A glyph that stands for the value where the composer is narrow (permissions' shield). The value's words stay in the
   * chip for assistive technology, hidden only from the eye, so the chip still says what it is set to.
   */
  readonly icon?: ReactNode
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [below, setBelow] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const listId = useId()
  useLayoutEffect(() => {
    if (!open || !flip) { setBelow(false); return }
    const menu = panel.current ?? list.current, chip = trigger.current
    if (!menu || !chip) return
    let top = 0
    for (let parent = chip.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll)/u.test(getComputedStyle(parent).overflowY)) { top = parent.getBoundingClientRect().top; break }
    }
    setBelow(chip.getBoundingClientRect().top - menu.offsetHeight - 6 < top + 8)
  }, [open, flip])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!list.current?.contains(target) && !panel.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss, true)
    const selected = list.current?.querySelector<HTMLButtonElement>('button[aria-selected="true"]:not(:disabled)')
    ;(selected ?? list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus()
    return () => { document.removeEventListener('pointerdown', dismiss, true) }
  }, [open])
  const current = options.find(option => option.id === value && !option.disabled)
  const shown = current?.label ?? (value ? capitalise(value) : placeholder)
  // A chip that can show its glyph alone says its value in its tooltip too, so the shield can be read by pointing at it.
  const title = disabled && fixedReason ? `${icon ? `${label}: ${shown}` : label}. ${fixedReason}` : icon ? `${label}: ${shown}` : label
  const choose = (id: string): void => { onChange(id); setOpen(false); trigger.current?.focus() }
  const listbox = <div ref={list} id={listId} role="listbox" aria-label={label} className={foot ? 'thread-chip-menu__options' : 'thread-chip-menu__list'} data-below={!foot && below ? 'true' : undefined} onKeyDown={event => moveListboxFocus(event, list.current)}>
    {options.map(option => <button type="button" role="option" key={option.id} aria-selected={option.id === value} disabled={option.disabled} onClick={() => choose(option.id)}>
      <span>{option.label}{option.description ? <small className={option.translated ? 'tt-paragraph' : undefined}>{option.description}</small> : null}</span>{option.id === value && <Check size={14} aria-hidden="true" />}</button>)}
  </div>
  return <div className="thread-chip-menu"
    onKeyDown={event => {
      if (!open || event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus()
    }}
    onBlur={event => { if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false) }}>
    <button ref={trigger} type="button" className="thread-chip tt-focusable" role="combobox" aria-label={label} title={title} aria-haspopup="listbox" aria-expanded={open}
      aria-controls={open ? listId : undefined} aria-describedby={pending ? describedBy : undefined} data-pending={pending ? 'true' : undefined}
      disabled={disabled} onClick={() => setOpen(value => !value)}>
      {pending ? <i className="thread-chip__pending" aria-hidden="true" /> : null}
      {icon ? <span className="thread-chip__icon" aria-hidden="true">{icon}</span> : null}
      <span className="thread-chip__value">{shown}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    {!open ? null : foot ? <div ref={panel} className="thread-chip-menu__list thread-chip-menu__list--foot" data-below={below ? 'true' : undefined}>{listbox}<p className="thread-chip-menu__foot">{foot}</p></div> : listbox}
  </div>
}

/**
 * Continuing this started thread on another provider (ADR-0089): the models a new thread may start on, the providers that
 * cannot take one now, why the thread itself cannot be continued now if it cannot, and what picking one does.
 */
export interface ThreadContinueOffer {
  readonly models: readonly AgentModel[]
  readonly unavailable: readonly UnavailablePickerProvider[]
  readonly refusal: string | null
  readonly onContinue: (modelId: string) => void
}

const providerNameOf = (thread: AgentThread): string | undefined => thread.providerId ? PROVIDER_LABELS[thread.providerId] : undefined

/**
 * Whether a prompt on this thread is on its way to the provider, which a settings change would have to wait behind. One
 * the user set aside is not: Sotto never sends it again, whatever became of it (#1156).
 */
export const promptOnItsWay = (state: AgentState, threadId: string): boolean =>
  state.deliveries?.some(delivery => delivery.threadId === threadId && !delivery.setAside
    && (delivery.status === 'queued' || delivery.status === 'submitting' || delivery.status === 'uncertain')) === true

/** Why Watcher's permissions are fixed now, as a thread's are while it works: main refuses a change until then. */
export function watcherPermissionFixedReason(state: AgentState, thread: AgentThread): string | undefined {
  return thread.status === 'running' || thread.requests.length > 0 || promptOnItsWay(state, thread.id)
    ? 'Fixed while Watcher works. It can change once Watcher finishes and nothing waits on you.' : undefined
}

/**
 * The composer's option controls: three chips saying what this thread is set to, the model with its
 * provider's mark, the reasoning effort and what the thread may do without asking. Effort opens its
 * card; the other chips open lists. A press shows at once and the chips stay live while it is saved
 * (`pendingSettings.ts`). A permission change the provider has not confirmed is marked on its chip, and a
 * caption beside the chips says what is still in force. A refusal puts the chip back and says so under the chips,
 * with Try again; a result the provider never gave keeps the choice on the chip and says what comes next. Those
 * lines go in `noticeSlot` when the composer gives one, a row of its own under the chips and the send button, so
 * they never move the row; otherwise under the chips. Focus stays on the chip a choice was made from. Before the first
 * send, Watch follows the permissions where Watcher is on (`WatchOnSendToggle`). New thread shows the same three
 * controls laid out in full.
 */
export function ThreadOptions({ thread, state, command, turnNote = true, getDraftText, onDraftText, noticeSlot, watcher = false, continueOffer }: {
  readonly thread: AgentThread; readonly state: AgentState; readonly command: AgentConnection['command']
  /** Explain options locked by a running turn; off where the composer already says it cannot send. */
  readonly turnNote?: boolean
  /** Present only beside an editable prompt; Ultrathink changes its visible text before sending. */
  readonly getDraftText?: () => string
  readonly onDraftText?: (text: string) => void
  /** Where the composer wants the lines about a refused or unconfirmed change, under its whole footer row. */
  readonly noticeSlot?: HTMLElement | null | undefined
  /**
   * Watcher's own options (ADR-0073): its permissions are Watcher's own choice, made through its room rather than as a
   * thread setting, and it keeps its provider, offering only that provider's models.
   */
  readonly watcher?: boolean
  /** Another provider's models, under "Continue in a new thread on", for a started thread that may continue elsewhere. */
  readonly continueOffer?: ThreadContinueOffer | undefined
}): ReactNode {
  // Cursor's permission lines are messages, so a change of interface language draws this again.
  useInterfaceLanguage()
  const settings = usePendingSettings(thread.id)
  // Your own model servers run with this computer's OpenCode, so the model menu offers to add one only for a thread here,
  // and never for Watcher (ADR-0124, phase 1).
  const ownServersBridge = useOwnServersBridge()
  const ownServers = !watcher && (!thread.hostId || thread.hostId === localHostId(state)) ? ownServersBridge : undefined
  const bar = useRef<HTMLDivElement>(null)
  const refocus = useRef<HTMLButtonElement | null>(null)
  const captionId = useId()
  const unconfirmedId = useId(), unconfirmedModelId = useId(), unconfirmedEffortId = useId()
  const { models: own, locked } = threadModelChoices(state, thread, watcher)
  // Watcher keeps its provider; another provider's model is a new Watcher, which main makes and which offers the last
  // one's handover (ADR-0073). Only where the room can open one.
  const room = useWatcherRoom()
  // Watcher's model and effort are the Orchestrating role (#1041): a press here saves it for the next Watcher too.
  const saveOrchestrating = useSaveOrchestrating()
  const orchestrating = watcher ? saveOrchestrating : null
  const open = watcher ? room?.open ?? null : null
  const settle = room?.settle
  const others = open === null ? [] : state.host.models.filter(model => model.ready && canCreateWith(state, model)
    && watcherProviderOf(model) !== null && watcherProviderOf(model) !== thread.providerId)
  // A started thread keeps its provider; another provider's model is a new thread that continues this one (ADR-0089).
  const continuing = !watcher && locked && continueOffer !== undefined ? continueOffer : undefined
  const continuations = continuing?.refusal === null ? continuing.models : []
  const continueUnavailable: readonly UnavailablePickerProvider[] = continuing === undefined ? []
    : continuing.refusal === null ? continuing.unavailable
      : [...new Map([...continuing.models.map(model => [model.provider, model.providerId] as const), ...continuing.unavailable.map(item => [item.name, item.providerId] as const)])]
        .map(([name, providerId]) => ({ name, providerId, reason: continuing.refusal! }))
  const models = others.length > 0 ? [...own, ...others] : continuations.length > 0 ? [...own, ...continuations] : own
  const [replacing, setReplacing] = useState<{ readonly provider: WatcherProvider; readonly refusal: string | null } | null>(null)
  const replace = async (provider: WatcherProvider, modelId: string): Promise<void> => {
    if (open === null || settle === undefined) return
    setReplacing({ provider, refusal: null })
    try {
      const refusal = settle(await open({ provider, modelId }))
      setReplacing(refusal === null ? null : { provider, refusal })
    } catch { setReplacing({ provider, refusal: 'Sotto could not start a new Watcher. Nothing was changed. Try again, or check the provider in Settings, under Providers.' }) }
  }
  /** What the window has drawn from main's published state: the confirmed values a press is measured against. */
  const drawn = settingValues(state, thread)
  const unconfirmed = unconfirmedKinds(state, thread.id)
  /**
   * The chips are fixed by what a provider actually refuses: a turn under way, an unanswered request, an archived
   * thread, a provider that is gone, and a prompt still on its way, which a change would run behind once its turn has
   * started. Also while main keeps a permission change with no result, since it takes no other action on the thread
   * until it knows; a model or effort change with no result holds nothing back, so another choice can replace it
   * (#1192), and its chip keeps its mark until the provider reports it. They do not read the coordinator's busy mark, which covers the very save a press starts and outlives its
   * reply: a save in flight fixes nothing, and main's thread lane runs the saves and any prompt in order.
   */
  const fixed = Boolean(thread.archivedAt) || thread.status === 'running' || thread.requests.length > 0 || promptOnItsWay(state, thread.id) || unconfirmed.has('permissions')
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
  const continueOn = continuing === undefined ? undefined : { providers: new Set([...continuations.map(model => model.provider), ...continueUnavailable.map(item => item.name)]),
    heading: (name: string) => `Continue in a new thread on ${name}`,
    note: 'Picking one starts a new thread there with a handover of this one. This thread stays as it is.' }
  // Continuing needs the thread at rest, not its own provider: a thread whose provider went away can still continue elsewhere.
  const continueFixed = Boolean(thread.archivedAt) || thread.status === 'running' || thread.requests.length > 0 || promptOnItsWay(state, thread.id)
  const pickerFixed = continuations.length > 0 ? continueFixed : fixed
  // Where the thread's own model cannot change in place, its chip lists that model and the providers it may continue on.
  const continueOnly = (current: readonly AgentModel[]): AgentModel[] => [...current.filter(model => model.id === catalogEntry(current, thread.modelId)?.id), ...continuations]
  if (locked && !capabilities.configureThread) {
    if (watcher) return <WatcherPermissionChip model={resolveModel(models, thread.modelId)} provider={thread.providerId ? PROVIDER_LABELS[thread.providerId] : 'The provider'}
      inForce={thread.runtimeMode} noticeSlot={noticeSlot} disabled={fixed} fixedReason={watcherPermissionFixedReason(state, thread)} />
    if (continuing === undefined) return null
    return <div className="thread-options-bar" data-provider-locked>
      <div className="thread-options thread-options--chips">
        <ModelPicker models={continueOnly(own)} modelId={thread.modelId} disabled={continueFixed} unavailable={continueUnavailable} continueOn={continueOn}
          note={providerNameOf(thread) ? `This thread stays with ${providerNameOf(thread)}.` : undefined}
          onChange={pressed => { if (continuations.some(model => model.id === pressed)) continuing.onContinue(pressed) }} />
      </div>
    </div>
  }
  const modelDisabled = locked && capabilities.configureThreadModel === false
  // The model shown is the one pressed; effort and permissions are read for it, as they will be once it lands.
  const confirmedModel = resolveModel(models, thread.modelId)
  const modelId = settings.pending.model?.value ?? thread.modelId
  const model = resolveModel(models, modelId)
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
  const note = others.length > 0 ? 'Another provider’s model starts a new Watcher. This conversation stays in Watcher history, and you can send its handover with your first message.'
    : locked ? (providerName ? `This thread stays with ${providerName}.` : undefined) : providers > 1 ? 'Any provider until your first message.' : undefined
  /** A setting's value in words: a model's name, an effort level, a permission mode in its own provider's terms. */
  const valueName = (kind: SettingKind, value: string, owner: AgentModel | undefined): string => kind === 'model' ? resolveModel(models, value)?.name ?? value
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
    {replacing?.refusal ? <p className="thread-options__notice" role="alert"><span>{replacing.refusal}</span></p> : null}
    {kinds.map(kind => {
      const pending = settings.pending[kind]
      if (pending?.awaiting !== 'unconfirmed') return null
      return <p key={`unconfirmed-${kind}`} id={kind === 'permissions' ? unconfirmedId : kind === 'model' ? unconfirmedModelId : unconfirmedEffortId} className="thread-options__notice" role="alert">
        <span>{unconfirmedSettingText(provider, valueName(kind, pending.value, model), pending.error, kind === 'permissions' ? undefined : valueName(kind, drawn[kind], confirmedModel))}</span></p>
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
      <ModelPicker models={modelDisabled && continuations.length > 0 ? continueOnly(models) : models} modelId={modelId}
        disabled={pickerFixed || modelDisabled && continuations.length === 0 || replacing !== null && replacing.refusal === null} note={note}
        pending={settings.pending.model?.awaiting === 'unconfirmed'} describedBy={unconfirmedModelId} ownServers={ownServers}
        unavailable={continueUnavailable} continueOn={continueOn} onChange={pressed => {
        if (continuing && continuations.some(model => model.id === pressed)) { continuing.onContinue(pressed); return }
        const picked = others.find(model => model.id === pressed)
        const provider = picked === undefined ? null : watcherProviderOf(picked)
        if (picked !== undefined && provider !== null) {
          orchestrating?.(picked.id, picked.defaultReasoningEffort ?? null, state.host.models)
          void replace(provider, picked.id); return
        }
        const id = chosenModelId(models, pressed, modelId, thread.modelId); press('model', id, { modelId: id })
        orchestrating?.(id, resolveModel(models, id)?.defaultReasoningEffort ?? null, state.host.models)
      }} />
      {efforts.length > 0 && <EffortPicker key={`${modelId}:${model?.reasoningEfforts?.join(',') ?? ''}`} value={reasoning} options={efforts}
        disabled={fixed || modelDisabled} pending={settings.pending.effort?.awaiting === 'unconfirmed'} describedBy={unconfirmedEffortId} onChange={reasoningEffort => {
          press('effort', reasoningEffort, { reasoningEffort }, unpressed.effort)
          orchestrating?.(modelId, reasoningEffort, state.host.models)
        }}
        defaultValue={model?.defaultReasoningEffort} modelName={model?.name}
        hasUltrathink={hasUltrathink} {...(addUltrathink ? { onUltrathink: addUltrathink } : {})} />}
      {watcher
        ? <WatcherPermissionChip model={model} provider={provider} inForce={thread.runtimeMode} noticeSlot={noticeSlot}
          disabled={fixed} fixedReason={watcherPermissionFixedReason(state, thread)} />
        : modes.length > 0 && <ChoiceChip label={OPTION_CHIP_NAMES.permissions} placeholder="Provider default" value={permission} options={modes} disabled={fixed} icon={PERMISSIONS_ICON}
        pending={pendingPermission !== null} describedBy={permissionUnconfirmed ? unconfirmedId : captionId}
        onChange={mode => press('permissions', mode, permissionPatch(model, mode), unpressed.permissions)} />}
      {/* Before the first send, Watch puts the new thread under a standing watch once it is sent (Watcher only). */}
      {!watcher && thread.nativeSessionStarted === false ? <WatchOnSendToggle threadId={thread.id} /> : null}
    </div>
    {/* Always present, so assistive technology hears the caption when it arrives. */}
    <span id={captionId} className="thread-options__caption" role="status">{replacing !== null && replacing.refusal === null ? `Starting a new Watcher on ${PROVIDER_LABELS[replacing.provider]}…` : caption}</span>
    {locked && thread.status === 'running' && turnNote ? <small>Available after this turn finishes.</small> : null}
    {noticeSlot ? createPortal(notices, noticeSlot) : notices}
  </div>
}
