import React, { useId, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import { ArrowLeftRight, BookOpen, FileSearch, Hammer, MousePointer2, Palette, RotateCcw, Users, Zap } from 'lucide-react'
import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg, plural, t } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { enabledThreadProviders, hostForThread, PROVIDER_LABELS, type AgentModel, type AgentModelSpeed, type AgentRuntimeMode, type AgentSpeed, type AgentState, type AgentThread, type ProviderId } from '../../../../shared/agents'
import { chosenModelId, resolveModel } from '../../../../shared/modelCatalog'
import { RUNTIME_MODE_ORDER } from '../../../../shared/newThreadDefaults'
import type { SottoPlatform } from '../../../../shared/platform'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { capRuntimeMode, defaultModel, fitEffort, fitRuntimeMode, fitSpeed, roleInForce, watcherProvidersInWords, withRoleRow, WORKER_ROLES,
  type RoleInForce, type WorkerRoleChoice, type WorkerRoleChoices, type WorkerRoleId } from '../../../../shared/workerRoles'
import { useOptionalAgents, type AgentConnection } from '../../agents/AgentContext'
import { shownWords, type LaterWords } from './laterWords'
import { EffortPicker, effortLabel } from '../../agents/EffortPicker'
import { ModelPicker } from '../../agents/ModelPicker'
import { newThreadDefaultsCatalog } from '../../agents/newThread'
import { pendingSettingsStore, settingValues, speedPatch, SPEED_STANDARD, usePendingSettings } from '../../agents/pendingSettings'
import { ProviderMark } from '../../agents/ProviderMark'
import { ChoiceChip, effortChoices, offeredSpeeds, RUNTIME_LABELS, speedChoices, speedName, watcherPermissionFixedReason } from '../../agents/ThreadOptions'
import { useOptionalApp } from '../../state/AppContext'
import { useHeldProviders } from '../../state/owlFeature'
import { WatcherOwl } from '../../watcher/WatcherOwl'
import { WatcherPermissionChip } from '../../watcher/WatcherPermissionChip'
import { useWatcherRoom } from '../../watcher/watcherRoom'
import { watcherProviderOf } from '../../watcher/watcherProviders'
import { firstMessage } from '../../watcher/watcherFirstMessage'
import './workerRoles.css'

type RoleIcon = ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: 'true' }>
const OwlIcon: RoleIcon = ({ size }) => <WatcherOwl size={size ?? 16} />
const ICONS: Record<WorkerRoleId, RoleIcon> = {
  orchestrating: OwlIcon, building: Hammer, ui: Palette, 'code-review': FileSearch, research: BookOpen, 'computer-use': MousePointer2,
}
/** Whether a provider is connected, set up but not connected now, or not set up on this computer at all. */
type ProviderState = 'connected' | 'off' | 'absent'
type Section = 'settings-agents' | 'settings-providers'
/** What a row shows: the user's choice when they made one, the default in force otherwise. */
interface Shown { readonly modelId: string; readonly model: AgentModel | undefined; readonly reasoningEffort: string | null; readonly speed: AgentSpeed | null; readonly runtimeMode: AgentRuntimeMode | undefined }
type RowStatus = 'chosen' | 'away' | 'moved' | 'default' | 'none'
/** A model, effort and speed, as Watcher runs on them and as Orchestrating saves them. */
interface WatcherChoice { readonly modelId: string; readonly reasoningEffort: string | null; readonly speed: AgentSpeed | null }
/** A row's change from a card: any of its settings, the rest kept. */
interface RowPatch { readonly modelId?: string; readonly reasoningEffort?: string | null; readonly speed?: AgentSpeed | null; readonly runtimeMode?: AgentRuntimeMode }
/** What a line under the heading says was done, and what Undo puts back: the saved rows, and Watcher as it was. */
interface Said { readonly text: LaterWords; readonly undo: WorkerRoleChoices; readonly watcher: WatcherChoice | null }
const WATCHER_NOT_STARTED = msg`Sotto could not start a new Watcher. Nothing was changed. Try again, or check the provider in Settings, under Providers.`

/** Provider names joined the way the interface language joins a list: "Codex and Claude Code". */
const list = (items: readonly string[]): string => new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(items)
/** Who starts on the next default while a row's first one is away: new workers, or for Orchestrating a new Watcher. */
type Starter = 'workers' | 'watcher'

function shownOf(read: RoleInForce, models: readonly AgentModel[]): Shown | undefined {
  if (read.choice) {
    const model = resolveModel(models, read.choice.modelId)
    return { modelId: read.choice.modelId, model, reasoningEffort: read.choice.reasoningEffort, speed: read.choice.speed ?? null,
      runtimeMode: read.choice.runtimeMode ?? fitRuntimeMode(read.role.permission, model) ?? read.role.permission ?? undefined }
  }
  return read.fallback ? { modelId: read.fallback.model.id, model: read.fallback.model, reasoningEffort: read.fallback.reasoningEffort, speed: read.fallback.speed, runtimeMode: read.fallback.runtimeMode } : undefined
}
/** The providers of the defaults ahead of the one in force that are set up but not connected: why a row moved. */
function awayBefore(read: RoleInForce, providerOf: (id: ProviderId) => ProviderState): ProviderId[] {
  const end = read.fallback === undefined || read.fallback.index < 0 ? read.role.defaults.length : read.fallback.index
  return [...new Set(read.role.defaults.slice(0, end).map(entry => entry.provider).filter(provider => providerOf(provider) === 'off'))]
}
function statusOf(read: RoleInForce, providerOf: (id: ProviderId) => ProviderState): RowStatus {
  if (read.choice) return read.choiceReady ? 'chosen' : 'away'
  if (!read.fallback) return 'none'
  return awayBefore(read, providerOf).length ? 'moved' : 'default'
}

/**
 * Settings, under Watcher: worker roles (#1041), the prototype's variant C as Zach picked it on October 14, 2026. A card
 * per kind of work, each choosing a model, an effort and a permission with the New thread dialog's field-style controls,
 * and listing its defaults in order. Orchestrating is Watcher itself, a wide card beside a drawing of Watcher's composer
 * chips: the same choice shown in two places. A row counts as the user's choice once any of its settings changes, and a
 * provider coming or going never overwrites it; Reset puts the defaults back.
 */
export function WorkerRolesSettings({ settings, platform, onUpdateSettings, onOpenSection }: {
  readonly settings: AppSettings
  readonly platform: SottoPlatform
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
  readonly onOpenSection: (id: Section) => void
}): ReactNode {
  const agents = useOptionalAgents()
  if (!agents?.state) return <p className="worker-roles__lead tt-paragraph"><Trans>Preparing worker roles…</Trans></p>
  return <Roles state={agents.state} command={agents.command} settings={settings} platform={platform} onUpdateSettings={onUpdateSettings} onOpenSection={onOpenSection} />
}

function Roles({ state, command, settings, platform, onUpdateSettings, onOpenSection }: {
  readonly state: AgentState; readonly command: AgentConnection['command']; readonly settings: AppSettings; readonly platform: SottoPlatform
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>; readonly onOpenSection: (id: Section) => void
}): ReactNode {
  const { t } = useLingui()
  const headingId = useId()
  // This computer's catalog: the roles, like the new-thread defaults, are this computer's own (ADR-0074).
  const catalog = useMemo(() => newThreadDefaultsCatalog(state), [state])
  const choices = settings.workerRoles
  const [said, setSaid] = useState<Said | null>(null)
  const room = useWatcherRoom()
  const watcher: AgentThread | undefined = room?.currentThreadId ? state.host.threads.find(thread => thread.id === room.currentThreadId) : undefined
  const [watcherRefusal, setWatcherRefusal] = useState<LaterWords | null>(null)
  const watcherDrawn = watcher ? settingValues(state, watcher) : null
  // What the running Watcher is on now, as its thread reports it.
  const watcherNow: WatcherChoice | null = watcherDrawn ? { modelId: watcherDrawn.model, reasoningEffort: watcherDrawn.effort || null,
    speed: watcherDrawn.fast === SPEED_STANDARD ? null : watcherDrawn.fast as AgentSpeed } : null
  /**
   * Orchestrating is Watcher's own model, effort and speed, so a change to it changes the running Watcher the way its
   * composer's chips do: on its provider, a settings change Watcher's provider confirms; on another, a new Watcher, which
   * offers the last one's handover (ADR-0073). Before Watcher exists, the first message's own pick gives way to the role.
   */
  const applyToWatcher = async (next: WatcherChoice): Promise<void> => {
    setWatcherRefusal(null)
    if (!watcher) { if (firstMessage.get().phase === 'writing') firstMessage.update({ modelId: '', effort: null }); return }
    const picked = resolveModel(catalog, next.modelId)
    const provider = picked ? watcherProviderOf(picked) : null
    if (provider !== null && provider !== watcher.providerId) {
      if (!room?.open) return
      const speed = fitSpeed(next.speed, picked)
      try { setWatcherRefusal(room.settle(await room.open({ provider, modelId: next.modelId, ...(next.reasoningEffort ? { reasoningEffort: next.reasoningEffort } : {}), ...(speed ? { speed } : {}) }))) }
      catch { setWatcherRefusal(WATCHER_NOT_STARTED) }
      return
    }
    const now = settingValues(state, watcher)
    // A model on Watcher's provider takes the effort in the same change, so Reset brings back the role's effort too.
    if (next.modelId !== now.model) pendingSettingsStore.press(watcher.id, 'model', next.modelId, { modelId: next.modelId, ...(next.reasoningEffort ? { reasoningEffort: next.reasoningEffort } : {}) }, command, now, now.model)
    else if (next.reasoningEffort && next.reasoningEffort !== now.effort) pendingSettingsStore.press(watcher.id, 'effort', next.reasoningEffort, { reasoningEffort: next.reasoningEffort }, command, now, now.effort)
    // The speed is its own press, after the model's, and only where the model offers it: a provider refuses one it does not.
    const speed = next.speed ?? SPEED_STANDARD
    if (speed !== now.fast && fitSpeed(next.speed, picked) === next.speed) pendingSettingsStore.press(watcher.id, 'fast', speed, speedPatch(speed, picked), command, now, now.fast)
  }
  const local = state.connections?.find(connection => connection.kind === 'local')?.hostId
  const host = local === undefined ? state.host : hostForThread(state.host, { hostId: local })
  // Set up: turned on, or turned off by the user since (it is still installed and signed in), or trying to connect.
  const setUp = new Set([...enabledThreadProviders(state.configuration), ...state.configuration.disconnectedProviders ?? []])
  const providerOf = (id: ProviderId): ProviderState => host.providers?.find(provider => provider.id === id)?.connection === 'connected'
    || catalog.some(model => model.providerId === id && model.ready) ? 'connected'
    : setUp.has(id) || host.providers?.some(provider => provider.id === id && provider.connection !== 'disconnected') ? 'off' : 'absent'
  const ceiling = state.configuration.newThreadRuntimeMode ?? 'approval-required'
  const reads = WORKER_ROLES.map(role => roleInForce(role.id, choices, catalog))
  const save = (next: WorkerRoleChoices, words?: LaterWords): void => {
    setSaid(words === undefined ? null : { text: words, undo: choices, watcher: watcherNow })
    void onUpdateSettings({ workerRoles: next })
  }
  const setRow = (read: RoleInForce, patch: RowPatch): void => {
    const shown = shownOf(read, catalog)
    if (!shown) return
    const modelId = patch.modelId ?? shown.modelId
    const model = resolveModel(catalog, modelId)
    const reasoningEffort = patch.reasoningEffort !== undefined ? patch.reasoningEffort : patch.modelId ? fitEffort(shown.reasoningEffort, model) : shown.reasoningEffort
    const runtimeMode = patch.runtimeMode ?? (patch.modelId ? fitRuntimeMode(shown.runtimeMode ?? read.role.permission, model) ?? shown.runtimeMode : shown.runtimeMode)
    // A speed stays through a change of model, as a thread's does; on a model without it the role starts at Standard (ADR-0091).
    const wantedSpeed = patch.speed !== undefined ? patch.speed : shown.speed
    const speed = read.role.id === 'orchestrating' && watcher && model?.providerId !== watcher.providerId ? fitSpeed(wantedSpeed, model) : wantedSpeed
    const row: WorkerRoleChoice = { modelId, reasoningEffort, ...(speed ? { speed } : {}), ...(read.role.id === 'orchestrating' || runtimeMode === undefined ? {} : { runtimeMode }) }
    save(withRoleRow(choices, read.role.id, row, catalog))
    if (read.role.id === 'orchestrating') void applyToWatcher({ modelId, reasoningEffort, speed })
  }
  const reset = (read: RoleInForce): void => {
    const next: WorkerRoleChoices = { ...choices }
    delete next[read.role.id]
    const fallback = read.fallback
    const roleName = read.role.name
    const modelName = fallback?.model.name ?? ''
    const effort = fallback?.reasoningEffort ? effortLabel(fallback.reasoningEffort) : ''
    save(next, !fallback ? msg`${roleName} is back on its defaults.`
      : effort ? msg`${roleName} is back on its default, ${modelName} at ${effort}.` : msg`${roleName} is back on its default, ${modelName}.`)
    if (read.role.id === 'orchestrating' && fallback) void applyToWatcher({ modelId: fallback.model.id, reasoningEffort: fallback.reasoningEffort, speed: fallback.speed })
  }
  const orchestratingDefault = reads[0]?.fallback
  // A running Watcher off Orchestrating's default is the user's choice, whether it was made here or in its composer.
  const watcherChosen = watcherNow !== null && (!orchestratingDefault || watcherNow.modelId !== orchestratingDefault.model.id
    || watcherNow.reasoningEffort !== orchestratingDefault.reasoningEffort || watcherNow.speed !== orchestratingDefault.speed)
  const chosen = reads.filter(read => read.choice !== undefined || read.role.id === 'orchestrating' && watcherChosen).length
  const resetAll = (): void => {
    save({}, msg`${plural(chosen, { one: 'The role you chose is back on its default.', other: 'The # roles you chose are back on their defaults.' })}`)
    if (orchestratingDefault && (watcherChosen || !watcher)) void applyToWatcher({ modelId: orchestratingDefault.model.id, reasoningEffort: orchestratingDefault.reasoningEffort, speed: orchestratingDefault.speed })
  }
  const undo = (was: Said): void => {
    setSaid(null)
    void onUpdateSettings({ workerRoles: was.undo })
    // Watcher goes back to what it ran on before; a change it already has sends nothing.
    const saved = was.undo.orchestrating
    const before = was.watcher ?? (saved ? { modelId: saved.modelId, reasoningEffort: saved.reasoningEffort, speed: saved.speed ?? null } : null)
    if (before) void applyToWatcher(before)
  }
  const anyConnected = catalog.some(model => model.ready)
  const away = [...new Set(reads.flatMap(read => statusOf(read, providerOf) === 'moved' ? awayBefore(read, providerOf)
    : statusOf(read, providerOf) === 'away' && read.choice ? [resolveModel(catalog, read.choice.modelId)?.providerId].filter((id): id is ProviderId => id !== undefined && providerOf(id) === 'off') : []))]
  const movedCount = reads.filter(read => ['moved', 'away'].includes(statusOf(read, providerOf))).length
  const [orchestrating, ...workers] = reads
  const awayCount = away.length
  const providers = list(away.map(id => PROVIDER_LABELS[id]))
  return <section className="worker-roles" data-setting="worker-roles" aria-labelledby={headingId}>
    <div className="worker-roles__head">
      <h3 id={headingId}><Users size={16} strokeWidth={1.7} aria-hidden="true" /><Trans>Worker roles</Trans></h3>
      <button type="button" className="worker-roles__reset-all tt-focusable" disabled={chosen === 0}
        aria-label={chosen === 0 ? t`Reset all roles to their defaults. Every role is on its defaults`
          : plural(chosen, { one: 'Reset all roles to their defaults. # role is your choice', other: 'Reset all roles to their defaults. # roles are your choice' })}
        onClick={resetAll}>
        <RotateCcw size={14} aria-hidden="true" /><Trans>Reset all to defaults</Trans></button>
    </div>
    <p className="worker-roles__lead tt-paragraph"><Trans>Each kind of work starts on its own model, effort and permissions. Watcher names the role when it starts a worker, and a thread names it when it delegates. Defaults come from the providers you have connected; a choice you make here stays until you reset it.</Trans></p>
    {said ? <p className="worker-roles__said tt-paragraph" role="status"><span>{shownWords(said.text)}</span>
      <button type="button" className="tt-focusable" onClick={() => undo(said)}><Trans>Undo</Trans></button></p> : null}
    {!anyConnected ? <div className="worker-roles__empty">
      <p className="tt-paragraph"><Trans>No provider is connected, so no role has a model yet. Connect Codex, Claude Code, Grok Build or Muse, and each role takes its first default from what you connect. Nothing you chose is lost.</Trans></p>
      <button type="button" className="worker-roles__open tt-focusable" onClick={() => onOpenSection('settings-providers')}><Trans>Open Providers</Trans></button>
    </div> : <>
      {awayCount ? <p className="worker-roles__summary tt-paragraph">{plural(awayCount, {
        one: `${providers} is not connected, so ${plural(movedCount, { one: '# role starts new work on its next default', other: '# roles start new work on their next default' })} until it connects. Nothing you chose has changed.`,
        other: `${providers} are not connected, so ${plural(movedCount, { one: '# role starts new work on its next default', other: '# roles start new work on their next default' })} until they connect. Nothing you chose has changed.`,
      })}</p> : null}
      <div className="worker-roles__grid">
        {orchestrating ? <OrchestratingCard read={orchestrating} state={state} watcher={watcher} chosen={watcherChosen} refusal={watcherRefusal} catalog={catalog} providerOf={providerOf}
          onRow={patch => setRow(orchestrating, patch)} onReset={() => reset(orchestrating)} /> : null}
        {workers.map(read => <RoleCard key={read.role.id} read={read} catalog={catalog} providerOf={providerOf} ceiling={ceiling} platform={platform}
          onRow={patch => setRow(read, patch)} onReset={() => reset(read)} onOpenAgents={() => onOpenSection('settings-agents')} />)}
      </div>
    </>}
  </section>
}

/** The notes a row carries: why it moved, why a choice is waiting, and what the new-thread default holds back. */
function rowNotes(read: RoleInForce, status: RowStatus, catalog: readonly AgentModel[], providerOf: (id: ProviderId) => ProviderState, who: Starter): string[] {
  const notes: string[] = []
  const start = read.start
  const startName = start?.model.name ?? ''
  if (status === 'moved') {
    const first = read.role.defaults[0]
    const firstName = first ? defaultModel(first, catalog)?.name ?? first.name : ''
    const off = awayBefore(read, providerOf).map(id => PROVIDER_LABELS[id])
    const offCount = off.length
    const providers = list(off)
    notes.push(who === 'workers'
      ? plural(offCount, {
        one: `${firstName} is on ${providers}, which is not connected. Until it connects, workers start on ${startName}, the next default.`,
        other: `${firstName} is on ${providers}, which are not connected. Until they connect, workers start on ${startName}, the next default.`,
      })
      : plural(offCount, {
        one: `${firstName} is on ${providers}, which is not connected. Until it connects, a new Watcher starts on ${startName}, the next default.`,
        other: `${firstName} is on ${providers}, which are not connected. Until they connect, a new Watcher starts on ${startName}, the next default.`,
      }))
  }
  if (status === 'away' && read.choice) {
    const model = resolveModel(catalog, read.choice.modelId)
    const name = model?.name ?? read.choice.modelId
    const provider = model?.providerId ? PROVIDER_LABELS[model.providerId] : null
    notes.push(!start
      ? provider !== null
        ? t`Your choice, ${name}, stays. ${provider} is not connected, and no other connected provider can do this work.`
        : t`Your choice, ${name}, stays. That model is not available, and no other connected provider can do this work.`
      : who === 'workers'
        ? provider !== null
          ? t`Your choice, ${name}, stays. ${provider} is not connected, so until it is, workers start on ${startName}, the next default.`
          : t`Your choice, ${name}, stays. That model is not available, so until it is, workers start on ${startName}, the next default.`
        : provider !== null
          ? t`Your choice, ${name}, stays. ${provider} is not connected, so until it is, a new Watcher starts on ${startName}, the next default.`
          : t`Your choice, ${name}, stays. That model is not available, so until it is, a new Watcher starts on ${startName}, the next default.`)
  }
  return notes
}

function Tag({ status }: { readonly status: RowStatus }): ReactNode {
  const { t } = useLingui()
  if (status === 'chosen') return <span className="worker-role__tag">{t`Your choice`}</span>
  if (status === 'away') return <span className="worker-role__tag worker-role__tag--moved">{t`Your choice, not available`}</span>
  if (status === 'moved') return <span className="worker-role__tag worker-role__tag--moved">{t`Next default`}</span>
  if (status === 'default') return <span className="worker-role__tag worker-role__tag--quiet">{t({ message: 'Default', comment: 'A worker role is on its default model' })}</span>
  return null
}

/** The role's defaults in order, each marked In use, If you reset, Not connected or Not set up. */
function Defaults({ read, catalog, providerOf }: { readonly read: RoleInForce; readonly catalog: readonly AgentModel[]; readonly providerOf: (id: ProviderId) => ProviderState }): ReactNode {
  const { t } = useLingui()
  const headId = useId()
  const inForce = read.fallback?.index ?? -2
  const inUse = read.choice ? t`If you reset` : t`In use`
  const modelAndEffort = (modelName: string, effort: string | null | undefined): string => {
    if (!effort) return modelName
    const level = effortLabel(effort)
    return t({ message: `${modelName}, ${level}`, comment: 'A model and its reasoning effort, as a list of defaults shows them' })
  }
  return <div className="worker-role__defaults">
    <p className="worker-role__defaults-head" id={headId}><span>{t`Defaults, in order`}</span><span>{read.choice ? t`The first one connected is used if you reset` : t`The first one connected is used`}</span></p>
    <ol aria-labelledby={headId}>
      {read.role.defaults.map((entry, index) => {
        const model = defaultModel(entry, catalog)
        const provider = providerOf(entry.provider)
        const effort = model ? fitEffort(entry.effort, model) : entry.effort
        const mark = index === inForce ? inUse
          : provider === 'absent' ? t`Not set up` : provider === 'off' ? t`Not connected` : !model?.ready ? t`Not available` : ''
        return <li key={`${entry.provider}:${entry.name}`} data-use={index === inForce && !read.choice} data-off={provider !== 'connected' || !model?.ready}>
          <ProviderMark provider={entry.provider} name={PROVIDER_LABELS[entry.provider]} size={13} />
          <span>{modelAndEffort(model?.name ?? entry.name, effort)}</span><span>{mark}</span>
        </li>
      })}
      {read.fallback && read.fallback.index < 0 ? <li data-use={!read.choice} data-off={false}>
        <ProviderMark provider={read.fallback.model.providerId} name={read.fallback.model.provider} size={13} />
        <span>{modelAndEffort(read.fallback.model.name, read.fallback.reasoningEffort)}</span>
        <span>{inUse}</span>
      </li> : null}
    </ol>
  </div>
}

/** One worker role: a model, an effort and a permission, the notes that hold, and its defaults in order. */
function RoleCard({ read, catalog, providerOf, ceiling, platform, onRow, onReset, onOpenAgents }: {
  readonly read: RoleInForce; readonly catalog: readonly AgentModel[]; readonly providerOf: (id: ProviderId) => ProviderState
  readonly ceiling: AgentRuntimeMode; readonly platform: SottoPlatform
  readonly onRow: (patch: RowPatch) => void
  readonly onReset: () => void; readonly onOpenAgents: () => void
}): ReactNode {
  const { t, i18n } = useLingui()
  const headId = useId()
  const role = read.role
  const roleName = role.name
  const Icon = ICONS[role.id]
  const status = statusOf(read, providerOf)
  const shown = shownOf(read, catalog)
  const model = shown?.model
  const efforts = model ? effortChoices(model, shown?.reasoningEffort ?? model.defaultReasoningEffort ?? '') : []
  const offered = model?.runtimeModes ?? []
  const speeds = offeredSpeeds(model, model?.providerId)
  const own = (model?.providerModes?.length ?? 0) > 0
  const providerName = model?.providerId ? PROVIDER_LABELS[model.providerId] : model?.provider ?? t`This provider`
  const permission = shown?.runtimeMode
  const notes = rowNotes(read, status, catalog, providerOf, 'workers')
  // What new workers start on, after the new-thread default caps it (ADR-0073, ADR-0081).
  const startMode = read.start?.runtimeMode
  const held = startMode !== undefined && RUNTIME_MODE_ORDER.indexOf(startMode) > RUNTIME_MODE_ORDER.indexOf(ceiling) ? capRuntimeMode(startMode, ceiling) : undefined
  const wanted = read.choice?.runtimeMode ?? role.permission
  const startProvider = read.start ? read.start.model.providerId ? PROVIDER_LABELS[read.start.model.providerId] : read.start.model.provider : ''
  const wantedMode = wanted ? RUNTIME_LABELS[wanted] : ''
  const startModeName = read.start?.runtimeMode ? RUNTIME_LABELS[read.start.runtimeMode] : ''
  const fit = read.start && wanted && !own && read.start.runtimeMode !== undefined && read.start.runtimeMode !== wanted && !(read.start.model.runtimeModes ?? []).includes(wanted)
    ? t`${startProvider} has no “${wantedMode}”, so its workers start on “${startModeName}”.` : null
  const computerUse = role.id === 'computer-use' && platform === 'win32' && read.start?.model.providerId === 'codex' && (held ?? startMode) !== 'full-access'
  const name = model?.name ?? shown?.modelId ?? ''
  const ceilingName = RUNTIME_LABELS[ceiling]
  const heldName = held ? RUNTIME_LABELS[held] : ''
  const defaultModelName = read.fallback?.model.name ?? ''
  const defaultEffort = read.fallback?.reasoningEffort ? effortLabel(read.fallback.reasoningEffort) : ''
  const defaultMode = read.fallback?.runtimeMode ? RUNTIME_LABELS[read.fallback.runtimeMode] : ''
  const effortNow = shown?.reasoningEffort ? effortLabel(shown.reasoningEffort) : ''
  const permissionName = permission ? RUNTIME_LABELS[permission] : ''
  return <article className="worker-role" data-chosen={read.choice !== undefined} aria-labelledby={headId}>
    <header className="worker-role__head"><Icon size={15} strokeWidth={1.8} aria-hidden="true" /><h4 id={headId}>{role.name}</h4><Tag status={status} /></header>
    <p className="worker-role__what tt-paragraph">{role.what}</p>
    {shown ? <div className="worker-role__fields">
      <div className="worker-role__field worker-role__field--full" data-away={status === 'away' || undefined}><span aria-hidden="true">{t({ message: 'Model', comment: 'A worker role field: the model it runs on' })}</span>
        <ModelPicker models={[...catalog]} modelId={shown.modelId} disabled={false} label={status === 'away' ? t`Choose ${roleName}’s model. Now ${name}, not available` : t`Choose ${roleName}’s model. Now ${name}`}
          note={!read.fallback ? undefined : defaultEffort ? t`${defaultModelName} at ${defaultEffort} is ${roleName}’s default.` : t`${defaultModelName} is ${roleName}’s default.`}
          onChange={id => onRow({ modelId: chosenModelId(catalog, id, shown.modelId) })} /></div>
      <div className="worker-role__field"><span aria-hidden="true">{t({ message: 'Effort', comment: 'A worker role field: the model\'s reasoning effort' })}</span>
        {efforts.length > 0 && model ? <EffortPicker key={shown.modelId} value={shown.reasoningEffort ?? model.defaultReasoningEffort ?? ''} options={efforts} disabled={false}
          label={effortNow ? t`Choose ${roleName}’s reasoning effort. Now ${effortNow}` : t`Choose ${roleName}’s reasoning effort. Now the model’s default`}
          defaultValue={model.defaultReasoningEffort} modelName={model.name} onChange={value => onRow({ reasoningEffort: value })} />
          : <span className="worker-role__none">{t({ message: `${name} has none`, comment: 'The model offers no reasoning effort levels' })}</span>}
      </div>
      <SpeedField speeds={speeds} provider={model?.providerId} speed={shown.speed} label={(speedNow: string) => t`Choose ${roleName}’s speed. Now ${speedNow}`}
        disabled={false} onChange={speed => onRow({ speed })} />
      <div className="worker-role__field"><span aria-hidden="true">{t({ message: 'Permissions', comment: 'A worker role field: what its workers may do without asking' })}</span>
        {own || !permission ? <span className="worker-role__none">{own ? t`${providerName}’s own` : t`None offered`}</span>
          : <ChoiceChip label={t`Choose what ${roleName} workers may do without asking. Now ${permissionName}`} placeholder={RUNTIME_LABELS[permission]} value={permission}
            options={RUNTIME_MODE_ORDER.map(mode => ({ id: mode, label: RUNTIME_LABELS[mode], description: offered.includes(mode) ? i18n._(MODE_LINES[mode]) : t`${providerName} doesn’t offer it.`, disabled: !offered.includes(mode) }))}
            disabled={false} pending={false} flip foot={t`A worker never starts wider than your new-thread default, “${ceilingName}”, and a delegated thread never wider than the thread that delegates.`}
            onChange={mode => onRow({ runtimeMode: mode as AgentRuntimeMode })} />}
      </div>
    </div> : <p className="worker-role__none tt-paragraph"><Trans>No connected provider can do this work.</Trans></p>}
    {notes.map(note => <p key={note} className="worker-role__note tt-paragraph" data-kind="moved">{note}</p>)}
    {fit ? <p className="worker-role__note tt-paragraph">{fit}</p> : null}
    {held ? <p className="worker-role__note tt-paragraph"><Trans>Workers never start wider than your new-thread default, so these start on “{heldName}”. <button type="button" className="worker-role__link tt-focusable" onClick={onOpenAgents}>Change it in Threads</button></Trans></p> : null}
    {computerUse ? <p className="worker-role__note tt-paragraph"><Trans>On Windows, Codex’s Computer Use can be stopped by its own sandbox below Full access. If it is, nothing is changed and the worker says so.</Trans></p> : null}
    <Defaults read={read} catalog={catalog} providerOf={providerOf} />
    {read.choice ? <footer className="worker-role__foot"><button type="button" className="worker-role__link tt-focusable" onClick={onReset}
      aria-label={!read.fallback ? t`Reset ${roleName} to its defaults`
        : defaultEffort && defaultMode ? t`Reset ${roleName} to its default, ${defaultModelName} at ${defaultEffort} with ${defaultMode}`
        : defaultEffort ? t`Reset ${roleName} to its default, ${defaultModelName} at ${defaultEffort}`
        : defaultMode ? t`Reset ${roleName} to its default, ${defaultModelName} with ${defaultMode}`
        : t`Reset ${roleName} to its default, ${defaultModelName}`}><Trans>Reset to default</Trans></button></footer> : null}
  </article>
}

/**
 * A role's speed (ADR-0091): Standard and the speeds its model offers, each with what it costs as its tooltip, beside
 * Effort. A model with none says so. A saved speed the model does not offer stays saved and shows Standard, which is what
 * the role starts on there.
 */
function SpeedField({ speeds, provider, speed, label, disabled, onChange }: {
  readonly speeds: readonly AgentModelSpeed[]; readonly provider: string | undefined; readonly speed: AgentSpeed | null
  readonly label: (speedNow: string) => string; readonly disabled: boolean; readonly onChange: (speed: AgentSpeed | null) => void
}): ReactNode {
  const { t } = useLingui()
  const value = speed !== null && speeds.some(item => item.id === speed) ? speed : SPEED_STANDARD
  return <div className="worker-role__field"><span aria-hidden="true">{t({ message: 'Speed', comment: 'A worker role field: how fast its model answers, and at what price' })}</span>
    {speeds.length > 0 ? <ChoiceChip label={label(speedName(value, speeds))} placeholder={speedName(SPEED_STANDARD, speeds)} value={value} options={speedChoices(speeds, provider)}
      disabled={disabled} pending={false} flip onChange={id => onChange(id === SPEED_STANDARD ? null : id as AgentSpeed)} />
      : <span className="worker-role__none">{t({ message: 'Standard only', comment: 'The model offers no faster speed' })}</span>}
  </div>
}

const MODE_LINES: Record<AgentRuntimeMode, MessageDescriptor> = {
  'approval-required': msg`Asks you before it edits a file or runs a command that changes something.`,
  'auto-accept-edits': msg`Edits files without asking. Asks before a command that changes something.`,
  auto: msg`The provider decides what to ask you about.`,
  'full-access': msg`Edits files and runs any command without asking, anywhere on the machine it runs on.`,
}

/**
 * Orchestrating: Watcher itself. Its model and effort are Watcher's own, the ones its composer's chips show: while a
 * Watcher runs, a change here changes it the way those chips do (another provider's model starts a new Watcher, which
 * offers the last one's handover, ADR-0073), and either place saves the role for the next Watcher. Its permissions are
 * Watcher's own mode, chosen in either place too, and Reset leaves them as they are.
 */
function OrchestratingCard({ read, state, watcher, chosen, refusal, catalog, providerOf, onRow, onReset }: {
  readonly read: RoleInForce; readonly state: AgentState
  /** The running Watcher's thread, once there is one. */
  readonly watcher: AgentThread | undefined
  /** The running Watcher is off Orchestrating's default. */
  readonly chosen: boolean
  /** Why the last change could not start a new Watcher: main's words, or Sotto's own when it could not ask. */
  readonly refusal: LaterWords | null
  readonly catalog: readonly AgentModel[]; readonly providerOf: (id: ProviderId) => ProviderState
  readonly onRow: (patch: RowPatch) => void; readonly onReset: () => void
}): ReactNode {
  const { t } = useLingui()
  const headId = useId()
  const room = useWatcherRoom()
  const app = useOptionalApp()
  const pending = usePendingSettings(watcher?.id ?? '')
  // A provider held to Owl on this run is not named (ADR-0072): the card asks the held set, as Settings, Providers does.
  const held = useHeldProviders()
  const watcherProviders = watcherProvidersInWords(held)
  const role = read.role
  // While Watcher runs, the card shows what it is on; before it exists, what it will start on.
  const drawn = watcher ? settingValues(state, watcher) : null
  const liveId = watcher ? pending.pending.model?.value ?? watcher.modelId : null
  const liveModel = liveId ? resolveModel(catalog, liveId) : undefined
  const liveEffort = watcher ? pending.pending.effort?.value ?? drawn?.effort ?? liveModel?.defaultReasoningEffort ?? null : null
  const liveSpeed = pending.pending.fast?.value ?? drawn?.fast ?? SPEED_STANDARD
  const shown = watcher && liveId ? { modelId: liveId, model: liveModel, reasoningEffort: liveEffort || null, speed: liveSpeed === SPEED_STANDARD ? null : liveSpeed as AgentSpeed }
    : shownOf(read, catalog)
  const model = shown?.model
  const fallback = read.fallback
  const differs = watcher ? chosen : read.choice !== undefined
  const status: RowStatus = watcher ? differs ? 'chosen' : 'default' : statusOf(read, providerOf)
  const fixedReason = watcher ? watcherPermissionFixedReason(state, watcher) : undefined
  const efforts = model ? effortChoices(model, shown?.reasoningEffort ?? model.defaultReasoningEffort ?? '') : []
  const speeds = offeredSpeeds(model, model?.providerId)
  const speedNow = speeds.some(speed => speed.id === shown?.speed) ? shown?.speed ?? SPEED_STANDARD : SPEED_STANDARD
  const providerName = model?.providerId ? PROVIDER_LABELS[model.providerId] : model?.provider ?? t`The provider`
  const notes = watcher ? [] : rowNotes(read, status, catalog, providerOf, 'watcher')
  // The speed Watcher is on goes with every change, so a change made here never drops one made in its composer.
  const choose = (modelId: string | undefined, reasoningEffort: string | null | undefined, speed: AgentSpeed | null = shown?.speed ?? null): void => {
    const nextModel = modelId ?? shown?.modelId
    if (!nextModel) return
    const effort = reasoningEffort !== undefined ? reasoningEffort : modelId ? resolveModel(catalog, modelId)?.defaultReasoningEffort ?? null : shown?.reasoningEffort ?? null
    onRow({ modelId: nextModel, reasoningEffort: effort, speed })
  }
  const name = model?.name ?? shown?.modelId ?? ''
  const effortNow = shown?.reasoningEffort ? effortLabel(shown.reasoningEffort) : ''
  const defaultModelName = fallback?.model.name ?? ''
  const defaultEffort = fallback?.reasoningEffort ? effortLabel(fallback.reasoningEffort) : ''
  const mirrorMode = room?.state?.runtimeMode ?? room?.state?.currentOptions?.runtimeMode ?? 'approval-required'
  // Every provider's models are offered; a provider Watcher does not run on keeps its tile, saying why, as the
  // composer's picker says why a provider cannot take a choice now.
  const watcherModels = catalog.filter(item => watcherProviderOf(item) !== null)
  const refused = [...new Map(catalog.filter(item => watcherProviderOf(item) === null).map(item => {
    const provider = item.providerId ? PROVIDER_LABELS[item.providerId] : item.provider
    return [item.provider, { name: item.provider, providerId: item.providerId, reason: t`Watcher can’t run on ${provider} yet.` }]
  })).values()]
  return <article className="worker-role worker-role--wide" data-chosen={status === 'chosen' || status === 'away'} aria-labelledby={headId}>
    <div className="worker-role__main">
      <header className="worker-role__head"><WatcherOwl size={15} /><h4 id={headId}>{role.name}</h4><Tag status={status} /></header>
      <p className="worker-role__what tt-paragraph">{role.what}</p>
      {shown ? <div className="worker-role__fields">
        <div className="worker-role__field worker-role__field--full" data-away={status === 'away' || undefined}><span aria-hidden="true">{t({ message: 'Model', comment: 'A worker role field: the model it runs on' })}</span>
          <ModelPicker models={watcherModels} modelId={shown.modelId} disabled={fixedReason !== undefined} label={t`Choose Watcher’s model. Now ${name}`} unavailable={refused}
            note={watcher ? t`Watcher’s model: the same choice as the model chip under its composer. Another provider’s model starts a new Watcher, and this conversation stays in Watcher history.`
              : t`Watcher’s model: the same choice as the model chip under its composer. Watcher runs on ${watcherProviders}.`}
            onChange={id => choose(chosenModelId(catalog, id, shown.modelId), undefined)} /></div>
        <div className="worker-role__field"><span aria-hidden="true">{t({ message: 'Effort', comment: 'A worker role field: the model\'s reasoning effort' })}</span>
          {efforts.length > 0 && model ? <EffortPicker key={shown.modelId} value={shown.reasoningEffort ?? model.defaultReasoningEffort ?? ''} options={efforts} disabled={fixedReason !== undefined}
            label={effortNow ? t`Choose Watcher’s reasoning effort. Now ${effortNow}` : t`Choose Watcher’s reasoning effort. Now the model’s default`}
            defaultValue={model.defaultReasoningEffort} modelName={model.name} onChange={value => choose(undefined, value)} />
            : <span className="worker-role__none">{t({ message: `${name} has none`, comment: 'The model offers no reasoning effort levels' })}</span>}
        </div>
        <SpeedField speeds={speeds} provider={model?.providerId} speed={shown.speed} label={(speedNow: string) => t`Choose Watcher’s speed. Now ${speedNow}`}
          disabled={fixedReason !== undefined} onChange={speed => choose(undefined, undefined, speed)} />
        <div className="worker-role__field"><span aria-hidden="true">{t`Permissions, Watcher’s own`}</span>
          <WatcherPermissionChip model={model} provider={providerName} inForce={watcher?.runtimeMode} disabled={fixedReason !== undefined} fixedReason={fixedReason} flip /></div>
      </div> : <p className="worker-role__none tt-paragraph"><Trans>Watcher runs on {watcherProviders}. Connect one to choose its model.</Trans></p>}
      {fixedReason ? <p className="worker-role__note tt-paragraph">{fixedReason}</p> : null}
      {refusal ? <p className="worker-role__note tt-paragraph" role="alert">{shownWords(refusal)}</p> : null}
      {notes.map(note => <p key={note} className="worker-role__note tt-paragraph" data-kind="moved">{note}</p>)}
      <Defaults read={read} catalog={catalog} providerOf={providerOf} />
      {differs ? <footer className="worker-role__foot"><button type="button" className="worker-role__link tt-focusable" disabled={fixedReason !== undefined}
        aria-label={!fallback ? t`Reset Orchestrating to its defaults`
          : defaultEffort ? t`Reset Orchestrating to its default, ${defaultModelName} at ${defaultEffort}. Watcher’s permissions stay as they are`
          : t`Reset Orchestrating to its default, ${defaultModelName}. Watcher’s permissions stay as they are`}
        onClick={onReset}><Trans>Reset to default</Trans></button></footer> : null}
    </div>
    <div className="worker-role__mirror">
      <div className="worker-role__composer" aria-hidden="true">
        <span><Trans>Ask about your threads, or say what to start or send</Trans></span>
        <span className="worker-role__chips">
          {model ? <span className="worker-role__chip"><ProviderMark provider={model.providerId} name={model.provider} size={13} /><span>{model.name}</span></span> : <span className="worker-role__chip"><span><Trans>No model</Trans></span></span>}
          {shown?.reasoningEffort ? <span className="worker-role__chip"><span>{effortLabel(shown.reasoningEffort)}</span></span> : null}
          {speeds.length > 0 ? <span className="worker-role__chip worker-role__chip--speed" data-speed={speedNow}>
            <Zap size={13} fill={speedNow === SPEED_STANDARD ? 'none' : 'currentColor'} />{speedNow === 'ultrafast' ? <small>2</small> : null}</span> : null}
          <span className="worker-role__chip"><span>{RUNTIME_LABELS[mirrorMode]}</span></span>
        </span>
      </div>
      <p className="worker-role__caption tt-paragraph"><ArrowLeftRight size={14} aria-hidden="true" /><span><Trans>Watcher’s composer shows the same choices. A change in either place changes both.</Trans>{' '}
        {app ? <button type="button" className="worker-role__link tt-focusable" onClick={() => app.actions.navigate('watcher')}><Trans>Show Watcher’s room</Trans></button> : null}</span></p>
    </div>
  </article>
}
