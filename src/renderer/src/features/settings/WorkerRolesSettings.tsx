import React, { useId, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import { ArrowLeftRight, BookOpen, FileSearch, Hammer, MousePointer2, Palette, RotateCcw } from 'lucide-react'
import { enabledThreadProviders, hostForThread, PROVIDER_LABELS, type AgentModel, type AgentRuntimeMode, type AgentState, type AgentThread, type ProviderId } from '../../../../shared/agents'
import { resolveModel } from '../../../../shared/modelCatalog'
import { RUNTIME_MODE_ORDER } from '../../../../shared/newThreadDefaults'
import type { SottoPlatform } from '../../../../shared/platform'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { capRuntimeMode, defaultModel, fitEffort, fitRuntimeMode, isRoleDefault, roleInForce, WORKER_ROLES,
  type RoleInForce, type WorkerRoleChoice, type WorkerRoleChoices, type WorkerRoleId } from '../../../../shared/workerRoles'
import { useOptionalAgents, type AgentConnection } from '../../agents/AgentContext'
import { EffortPicker, effortLabel } from '../../agents/EffortPicker'
import { ModelPicker } from '../../agents/ModelPicker'
import { newThreadDefaultsCatalog } from '../../agents/newThread'
import { pendingSettingsStore, settingValues, usePendingSettings } from '../../agents/pendingSettings'
import { ProviderMark } from '../../agents/ProviderMark'
import { ChoiceChip, effortChoices, RUNTIME_LABELS, watcherPermissionFixedReason } from '../../agents/ThreadOptions'
import { useOptionalApp } from '../../state/AppContext'
import { WatcherOwl } from '../../watcher/WatcherOwl'
import { WatcherPermissionChip } from '../../watcher/WatcherPermissionChip'
import { useWatcherRoom } from '../../watcher/watcherRoom'
import { watcherProviderOf } from '../../watcher/watcherProviders'
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
interface Shown { readonly modelId: string; readonly model: AgentModel | undefined; readonly reasoningEffort: string | null; readonly runtimeMode: AgentRuntimeMode | undefined }
type RowStatus = 'chosen' | 'away' | 'moved' | 'default' | 'none'

const possessive = (name: string): string => `${name}’s`
const list = (items: readonly string[]): string => new Intl.ListFormat('en', { type: 'conjunction' }).format(items)
const quoted = (mode: AgentRuntimeMode): string => `“${RUNTIME_LABELS[mode]}”`

function shownOf(read: RoleInForce, models: readonly AgentModel[]): Shown | undefined {
  if (read.choice) {
    const model = resolveModel(models, read.choice.modelId)
    return { modelId: read.choice.modelId, model, reasoningEffort: read.choice.reasoningEffort,
      runtimeMode: read.choice.runtimeMode ?? fitRuntimeMode(read.role.permission, model) ?? read.role.permission ?? undefined }
  }
  return read.fallback ? { modelId: read.fallback.model.id, model: read.fallback.model, reasoningEffort: read.fallback.reasoningEffort, runtimeMode: read.fallback.runtimeMode } : undefined
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
  if (!agents?.state) return <p className="worker-roles__lead">Preparing worker roles…</p>
  return <Roles state={agents.state} command={agents.command} settings={settings} platform={platform} onUpdateSettings={onUpdateSettings} onOpenSection={onOpenSection} />
}

function Roles({ state, command, settings, platform, onUpdateSettings, onOpenSection }: {
  readonly state: AgentState; readonly command: AgentConnection['command']; readonly settings: AppSettings; readonly platform: SottoPlatform
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>; readonly onOpenSection: (id: Section) => void
}): ReactNode {
  const headingId = useId()
  // This computer's catalog: the roles, like the new-thread defaults, are this computer's own (ADR-0074).
  const catalog = useMemo(() => newThreadDefaultsCatalog(state), [state])
  const watcherModels = useMemo(() => catalog.filter(model => watcherProviderOf(model) !== null), [catalog])
  const choices = settings.workerRoles
  const [said, setSaid] = useState<{ readonly text: string; readonly undo: WorkerRoleChoices } | null>(null)
  const local = state.connections?.find(connection => connection.kind === 'local')?.hostId
  const host = local === undefined ? state.host : hostForThread(state.host, { hostId: local })
  // Set up: turned on, or turned off by the user since (it is still installed and signed in), or trying to connect.
  const setUp = new Set([...enabledThreadProviders(state.configuration), ...state.configuration.disconnectedProviders ?? []])
  const providerOf = (id: ProviderId): ProviderState => host.providers?.find(provider => provider.id === id)?.connection === 'connected'
    || catalog.some(model => model.providerId === id && model.ready) ? 'connected'
    : setUp.has(id) || host.providers?.some(provider => provider.id === id && provider.connection !== 'disconnected') ? 'off' : 'absent'
  const ceiling = state.configuration.newThreadRuntimeMode ?? 'approval-required'
  const reads = WORKER_ROLES.map(role => roleInForce(role.id, choices, catalog))
  const save = (next: WorkerRoleChoices, words?: string): void => {
    setSaid(words === undefined ? null : { text: words, undo: choices })
    void onUpdateSettings({ workerRoles: next })
  }
  const setRow = (read: RoleInForce, patch: { readonly modelId?: string; readonly reasoningEffort?: string | null; readonly runtimeMode?: AgentRuntimeMode }): void => {
    const shown = shownOf(read, catalog)
    if (!shown) return
    const modelId = patch.modelId ?? shown.modelId
    const model = resolveModel(catalog, modelId)
    const reasoningEffort = patch.reasoningEffort !== undefined ? patch.reasoningEffort : patch.modelId ? fitEffort(shown.reasoningEffort, model) : shown.reasoningEffort
    const runtimeMode = patch.runtimeMode ?? (patch.modelId ? fitRuntimeMode(shown.runtimeMode ?? read.role.permission, model) ?? shown.runtimeMode : shown.runtimeMode)
    const row: WorkerRoleChoice = read.role.id === 'orchestrating' || runtimeMode === undefined ? { modelId, reasoningEffort } : { modelId, reasoningEffort, runtimeMode }
    const next: WorkerRoleChoices = { ...choices }
    if (isRoleDefault(read.role.id, row, catalog)) delete next[read.role.id]
    else next[read.role.id] = row
    save(next)
  }
  const reset = (read: RoleInForce): void => {
    const next: WorkerRoleChoices = { ...choices }
    delete next[read.role.id]
    const fallback = read.fallback
    save(next, fallback ? `${read.role.name} is back on its default, ${fallback.model.name}${fallback.reasoningEffort ? ` at ${effortLabel(fallback.reasoningEffort)}` : ''}.` : `${read.role.name} is back on its defaults.`)
  }
  const chosen = reads.filter(read => read.choice !== undefined).length
  const anyConnected = catalog.some(model => model.ready)
  const away = [...new Set(reads.flatMap(read => statusOf(read, providerOf) === 'moved' ? awayBefore(read, providerOf)
    : statusOf(read, providerOf) === 'away' && read.choice ? [resolveModel(catalog, read.choice.modelId)?.providerId].filter((id): id is ProviderId => id !== undefined && providerOf(id) === 'off') : []))]
  const movedCount = reads.filter(read => ['moved', 'away'].includes(statusOf(read, providerOf))).length
  const [orchestrating, ...workers] = reads
  return <section className="worker-roles" aria-labelledby={headingId}>
    <div className="worker-roles__head">
      <h3 id={headingId}>Worker roles</h3>
      <button type="button" className="worker-roles__reset-all tt-focusable" disabled={chosen === 0}
        aria-label={chosen === 0 ? 'Reset all roles to their defaults. Every role is on its defaults' : `Reset all roles to their defaults. ${chosen} ${chosen === 1 ? 'role is' : 'roles are'} your choice`}
        onClick={() => save({}, chosen === 1 ? 'The role you chose is back on its default.' : `The ${chosen} roles you chose are back on their defaults.`)}>
        <RotateCcw size={14} aria-hidden="true" />Reset all to defaults</button>
    </div>
    <p className="worker-roles__lead">Each kind of work starts on its own model, effort and permissions. Watcher names the role when it starts a worker, and a thread names it when it delegates. Defaults come from the providers you have connected; a choice you make here stays until you reset it.</p>
    {said ? <p className="worker-roles__said" role="status"><span>{said.text}</span>
      <button type="button" className="tt-focusable" onClick={() => { setSaid(null); void onUpdateSettings({ workerRoles: said.undo }) }}>Undo</button></p> : null}
    {!anyConnected ? <div className="worker-roles__empty">
      <p>No provider is connected, so no role has a model yet. Connect Codex, Claude Code, Grok Build or Muse, and each role takes its first default from what you connect. Nothing you chose is lost.</p>
      <button type="button" className="worker-roles__open tt-focusable" onClick={() => onOpenSection('settings-providers')}>Open Providers</button>
    </div> : <>
      {away.length ? <p className="worker-roles__summary">{list(away.map(id => PROVIDER_LABELS[id]))} {away.length === 1 ? 'is' : 'are'} not connected, so {movedCount} {movedCount === 1 ? 'role starts' : 'roles start'} new work on {movedCount === 1 ? 'its' : 'their'} next default until {away.length === 1 ? 'it connects' : 'they connect'}. Nothing you chose has changed.</p> : null}
      <div className="worker-roles__grid">
        {orchestrating ? <OrchestratingCard read={orchestrating} state={state} command={command} catalog={catalog} models={watcherModels} providerOf={providerOf}
          onRow={patch => setRow(orchestrating, patch)} onReset={() => reset(orchestrating)} /> : null}
        {workers.map(read => <RoleCard key={read.role.id} read={read} catalog={catalog} providerOf={providerOf} ceiling={ceiling} platform={platform}
          onRow={patch => setRow(read, patch)} onReset={() => reset(read)} onOpenAgents={() => onOpenSection('settings-agents')} />)}
      </div>
    </>}
  </section>
}

/** The notes a row carries: why it moved, why a choice is waiting, and what the new-thread default holds back. */
function rowNotes(read: RoleInForce, status: RowStatus, catalog: readonly AgentModel[], providerOf: (id: ProviderId) => ProviderState, who: string): string[] {
  const notes: string[] = []
  const start = read.start
  const startName = start?.model.name ?? ''
  if (status === 'moved') {
    const first = read.role.defaults[0]
    const firstName = first ? defaultModel(first, catalog)?.name ?? first.name : ''
    const off = awayBefore(read, providerOf).map(id => PROVIDER_LABELS[id])
    notes.push(`${firstName} is on ${list(off)}, which ${off.length === 1 ? 'is' : 'are'} not connected. Until ${off.length === 1 ? 'it connects' : 'they connect'}, ${who} on ${startName}, the next default.`)
  }
  if (status === 'away' && read.choice) {
    const model = resolveModel(catalog, read.choice.modelId)
    const name = model?.name ?? read.choice.modelId
    const why = model?.providerId ? `${PROVIDER_LABELS[model.providerId]} is not connected` : 'that model is not available'
    notes.push(start ? `Your choice, ${name}, stays. ${why[0]!.toUpperCase()}${why.slice(1)}, so until it is, ${who} on ${startName}, the next default.`
      : `Your choice, ${name}, stays. ${why[0]!.toUpperCase()}${why.slice(1)}, and no other connected provider can do this work.`)
  }
  return notes
}

function Tag({ status }: { readonly status: RowStatus }): ReactNode {
  if (status === 'chosen') return <span className="worker-role__tag">Your choice</span>
  if (status === 'away') return <span className="worker-role__tag worker-role__tag--moved">Your choice, not available</span>
  if (status === 'moved') return <span className="worker-role__tag worker-role__tag--moved">Next default</span>
  if (status === 'default') return <span className="worker-role__tag worker-role__tag--quiet">Default</span>
  return null
}

/** The role's defaults in order, each marked In use, If you reset, Not connected or Not set up. */
function Defaults({ read, catalog, providerOf }: { readonly read: RoleInForce; readonly catalog: readonly AgentModel[]; readonly providerOf: (id: ProviderId) => ProviderState }): ReactNode {
  const headId = useId()
  const inForce = read.fallback?.index ?? -2
  return <div className="worker-role__defaults">
    <p className="worker-role__defaults-head" id={headId}><span>Defaults, in order</span><span>{read.choice ? 'The first one connected is used if you reset' : 'The first one connected is used'}</span></p>
    <ol aria-labelledby={headId}>
      {read.role.defaults.map((entry, index) => {
        const model = defaultModel(entry, catalog)
        const provider = providerOf(entry.provider)
        const effort = model ? fitEffort(entry.effort, model) : entry.effort
        const mark = index === inForce ? read.choice ? 'If you reset' : 'In use'
          : provider === 'absent' ? 'Not set up' : provider === 'off' ? 'Not connected' : !model?.ready ? 'Not available' : ''
        return <li key={`${entry.provider}:${entry.name}`} data-use={index === inForce && !read.choice} data-off={provider !== 'connected' || !model?.ready}>
          <ProviderMark provider={entry.provider} name={PROVIDER_LABELS[entry.provider]} size={13} />
          <span>{model?.name ?? entry.name}{effort ? `, ${effortLabel(effort)}` : ''}</span><span>{mark}</span>
        </li>
      })}
      {read.fallback && read.fallback.index < 0 ? <li data-use={!read.choice} data-off={false}>
        <ProviderMark provider={read.fallback.model.providerId} name={read.fallback.model.provider} size={13} />
        <span>{read.fallback.model.name}{read.fallback.reasoningEffort ? `, ${effortLabel(read.fallback.reasoningEffort)}` : ''}</span>
        <span>{read.choice ? 'If you reset' : 'In use'}</span>
      </li> : null}
    </ol>
  </div>
}

/** One worker role: a model, an effort and a permission, the notes that hold, and its defaults in order. */
function RoleCard({ read, catalog, providerOf, ceiling, platform, onRow, onReset, onOpenAgents }: {
  readonly read: RoleInForce; readonly catalog: readonly AgentModel[]; readonly providerOf: (id: ProviderId) => ProviderState
  readonly ceiling: AgentRuntimeMode; readonly platform: SottoPlatform
  readonly onRow: (patch: { readonly modelId?: string; readonly reasoningEffort?: string | null; readonly runtimeMode?: AgentRuntimeMode }) => void
  readonly onReset: () => void; readonly onOpenAgents: () => void
}): ReactNode {
  const headId = useId()
  const role = read.role
  const Icon = ICONS[role.id]
  const status = statusOf(read, providerOf)
  const shown = shownOf(read, catalog)
  const model = shown?.model
  const efforts = model ? effortChoices(model, shown?.reasoningEffort ?? model.defaultReasoningEffort ?? '') : []
  const offered = model?.runtimeModes ?? []
  const own = (model?.providerModes?.length ?? 0) > 0
  const providerName = model?.providerId ? PROVIDER_LABELS[model.providerId] : model?.provider ?? 'This provider'
  const permission = shown?.runtimeMode
  const notes = rowNotes(read, status, catalog, providerOf, 'workers start')
  // What new workers start on, after the new-thread default caps it (ADR-0073, ADR-0081).
  const startMode = read.start?.runtimeMode
  const held = startMode !== undefined && RUNTIME_MODE_ORDER.indexOf(startMode) > RUNTIME_MODE_ORDER.indexOf(ceiling) ? capRuntimeMode(startMode, ceiling) : undefined
  const wanted = read.choice?.runtimeMode ?? role.permission
  const fit = read.start && wanted && !own && read.start.runtimeMode !== undefined && read.start.runtimeMode !== wanted && !(read.start.model.runtimeModes ?? []).includes(wanted)
    ? `${read.start.model.providerId ? PROVIDER_LABELS[read.start.model.providerId] : read.start.model.provider} has no ${quoted(wanted)}, so its workers start on ${quoted(read.start.runtimeMode)}.` : null
  const computerUse = role.id === 'computer-use' && platform === 'win32' && read.start?.model.providerId === 'codex' && (held ?? startMode) !== 'full-access'
  const name = model?.name ?? shown?.modelId ?? ''
  return <article className="worker-role" data-chosen={read.choice !== undefined} aria-labelledby={headId}>
    <header className="worker-role__head"><Icon size={15} strokeWidth={1.8} aria-hidden="true" /><h4 id={headId}>{role.name}</h4><Tag status={status} /></header>
    <p className="worker-role__what">{role.what}</p>
    {shown ? <div className="worker-role__fields">
      <div className="worker-role__field worker-role__field--full" data-away={status === 'away' || undefined}><span aria-hidden="true">Model</span>
        <ModelPicker models={[...catalog]} modelId={shown.modelId} disabled={false} label={`Choose ${possessive(role.name)} model. Now ${name}${status === 'away' ? ', not available' : ''}`}
          note={read.fallback ? `${read.fallback.model.name}${read.fallback.reasoningEffort ? ` at ${effortLabel(read.fallback.reasoningEffort)}` : ''} is ${possessive(role.name)} default.` : undefined}
          onChange={id => onRow({ modelId: id })} /></div>
      <div className="worker-role__field"><span aria-hidden="true">Effort</span>
        {efforts.length > 0 && model ? <EffortPicker key={shown.modelId} value={shown.reasoningEffort ?? model.defaultReasoningEffort ?? ''} options={efforts} disabled={false}
          label={`Choose ${possessive(role.name)} reasoning effort. Now ${shown.reasoningEffort ? effortLabel(shown.reasoningEffort) : 'the model’s default'}`}
          defaultValue={model.defaultReasoningEffort} modelName={model.name} onChange={value => onRow({ reasoningEffort: value })} />
          : <span className="worker-role__none">{name} has none</span>}
      </div>
      <div className="worker-role__field"><span aria-hidden="true">Permissions</span>
        {own || !permission ? <span className="worker-role__none">{own ? `${providerName}’s own` : 'None offered'}</span>
          : <ChoiceChip label={`Choose what ${role.name} workers may do without asking. Now ${RUNTIME_LABELS[permission]}`} placeholder={RUNTIME_LABELS[permission]} value={permission}
            options={RUNTIME_MODE_ORDER.map(mode => ({ id: mode, label: RUNTIME_LABELS[mode], description: offered.includes(mode) ? MODE_LINES[mode] : `${providerName} doesn’t offer it.`, disabled: !offered.includes(mode) }))}
            disabled={false} pending={false} flip foot={`A worker never starts wider than your new-thread default, ${quoted(ceiling)}, and a delegated thread never wider than the thread that delegates.`}
            onChange={mode => onRow({ runtimeMode: mode as AgentRuntimeMode })} />}
      </div>
    </div> : <p className="worker-role__none">No connected provider can do this work.</p>}
    {notes.map(note => <p key={note} className="worker-role__note" data-kind="moved">{note}</p>)}
    {fit ? <p className="worker-role__note">{fit}</p> : null}
    {held ? <p className="worker-role__note">Workers never start wider than your new-thread default, so these start on {quoted(held)}. <button type="button" className="worker-role__link tt-focusable" onClick={onOpenAgents}>Change it in Agents</button></p> : null}
    {computerUse ? <p className="worker-role__note">On Windows, Codex’s Computer Use can be stopped by its own sandbox below Full access. If it is, nothing is changed and the worker says so.</p> : null}
    <Defaults read={read} catalog={catalog} providerOf={providerOf} />
    {read.choice ? <footer className="worker-role__foot"><button type="button" className="worker-role__link tt-focusable" onClick={onReset}
      aria-label={read.fallback ? `Reset ${role.name} to its default, ${read.fallback.model.name}${read.fallback.reasoningEffort ? ` at ${effortLabel(read.fallback.reasoningEffort)}` : ''}${read.fallback.runtimeMode ? ` with ${RUNTIME_LABELS[read.fallback.runtimeMode]}` : ''}` : `Reset ${role.name} to its defaults`}>Reset to default</button></footer> : null}
  </article>
}

const MODE_LINES: Record<AgentRuntimeMode, string> = {
  'approval-required': 'Asks you before it edits a file or runs a command that changes something.',
  'auto-accept-edits': 'Edits files without asking. Asks before a command that changes something.',
  auto: 'The provider decides what to ask you about.',
  'full-access': 'Edits files and runs any command without asking, anywhere on the machine it runs on.',
}

/**
 * Orchestrating: Watcher itself. Its model and effort are Watcher's own, the ones its composer's chips show: while a
 * Watcher runs, a change here changes it the way those chips do (another provider's model starts a new Watcher, which
 * offers the last one's handover, ADR-0073), and either place saves the role for the next Watcher. Its permissions are
 * Watcher's own mode, chosen in either place too, and Reset leaves them as they are.
 */
function OrchestratingCard({ read, state, command, catalog, models, providerOf, onRow, onReset }: {
  readonly read: RoleInForce; readonly state: AgentState; readonly command: AgentConnection['command']
  readonly catalog: readonly AgentModel[]; readonly models: readonly AgentModel[]; readonly providerOf: (id: ProviderId) => ProviderState
  readonly onRow: (patch: { readonly modelId?: string; readonly reasoningEffort?: string | null }) => void; readonly onReset: () => void
}): ReactNode {
  const headId = useId()
  const room = useWatcherRoom()
  const app = useOptionalApp()
  const watcher: AgentThread | undefined = room?.currentThreadId ? state.host.threads.find(thread => thread.id === room.currentThreadId) : undefined
  const pending = usePendingSettings(watcher?.id ?? '')
  const [refusal, setRefusal] = useState<string | null>(null)
  const role = read.role
  // While Watcher runs, the card shows what it is on; before it exists, what it will start on.
  const drawn = watcher ? settingValues(state, watcher) : null
  const liveId = watcher ? pending.pending.model?.value ?? watcher.modelId : null
  const liveModel = liveId ? resolveModel(models, liveId) ?? resolveModel(catalog, liveId) : undefined
  const liveEffort = watcher ? pending.pending.effort?.value ?? drawn?.effort ?? liveModel?.defaultReasoningEffort ?? null : null
  const shown = watcher && liveId ? { modelId: liveId, model: liveModel, reasoningEffort: liveEffort || null } : shownOf(read, catalog)
  const model = shown?.model
  const fallback = read.fallback
  const differs = watcher ? !fallback || shown?.modelId !== fallback.model.id || (shown?.reasoningEffort ?? null) !== fallback.reasoningEffort : read.choice !== undefined
  const status: RowStatus = watcher ? differs ? 'chosen' : 'default' : statusOf(read, providerOf)
  const fixedReason = watcher ? watcherPermissionFixedReason(state, watcher) : undefined
  const efforts = model ? effortChoices(model, shown?.reasoningEffort ?? model.defaultReasoningEffort ?? '') : []
  const providerName = model?.providerId ? PROVIDER_LABELS[model.providerId] : model?.provider ?? 'The provider'
  const notes = watcher ? [] : rowNotes(read, status, catalog, providerOf, 'a new Watcher starts')
  const apply = async (modelId: string, reasoningEffort: string | null): Promise<void> => {
    setRefusal(null)
    if (!watcher) return
    const picked = resolveModel(models, modelId)
    const provider = picked ? watcherProviderOf(picked) : null
    if (provider !== null && provider !== watcher.providerId) {
      if (!room?.open) return
      try { setRefusal(room.settle(await room.open({ provider, modelId, ...(reasoningEffort ? { reasoningEffort } : {}) }))) }
      catch { setRefusal('Sotto could not start a new Watcher. Nothing was changed. Try again, or check the provider in Settings, under Providers.') }
      return
    }
    const now = settingValues(state, watcher)
    if (modelId !== now.model) pendingSettingsStore.press(watcher.id, 'model', modelId, { modelId }, command, now, now.model)
    else if (reasoningEffort && reasoningEffort !== now.effort) pendingSettingsStore.press(watcher.id, 'effort', reasoningEffort, { reasoningEffort }, command, now, now.effort)
  }
  const choose = (modelId: string | undefined, reasoningEffort: string | null | undefined): void => {
    const nextModel = modelId ?? shown?.modelId
    if (!nextModel) return
    const effort = reasoningEffort !== undefined ? reasoningEffort : modelId ? resolveModel(catalog, modelId)?.defaultReasoningEffort ?? null : shown?.reasoningEffort ?? null
    onRow({ modelId: nextModel, reasoningEffort: effort })
    void apply(nextModel, effort)
  }
  const name = model?.name ?? shown?.modelId ?? ''
  const mirrorMode = room?.state?.runtimeMode ?? room?.state?.currentOptions?.runtimeMode ?? 'approval-required'
  return <article className="worker-role worker-role--wide" data-chosen={status === 'chosen' || status === 'away'} aria-labelledby={headId}>
    <div className="worker-role__main">
      <header className="worker-role__head"><WatcherOwl size={15} /><h4 id={headId}>{role.name}</h4><Tag status={status} /></header>
      <p className="worker-role__what">{role.what}</p>
      {shown ? <div className="worker-role__fields">
        <div className="worker-role__field worker-role__field--full" data-away={status === 'away' || undefined}><span aria-hidden="true">Model</span>
          <ModelPicker models={[...models]} modelId={shown.modelId} disabled={fixedReason !== undefined} label={`Choose Watcher’s model. Now ${name}`}
            note={watcher ? 'Watcher’s model: the same choice as the model chip under its composer. Another provider’s model starts a new Watcher, and this conversation stays in Watcher history.'
              : 'Watcher’s model: the same choice as the model chip under its composer. Watcher runs on Codex, Claude Code or Grok Build.'}
            onChange={id => choose(id, undefined)} /></div>
        <div className="worker-role__field"><span aria-hidden="true">Effort</span>
          {efforts.length > 0 && model ? <EffortPicker key={shown.modelId} value={shown.reasoningEffort ?? model.defaultReasoningEffort ?? ''} options={efforts} disabled={fixedReason !== undefined}
            label={`Choose Watcher’s reasoning effort. Now ${shown.reasoningEffort ? effortLabel(shown.reasoningEffort) : 'the model’s default'}`}
            defaultValue={model.defaultReasoningEffort} modelName={model.name} onChange={value => choose(undefined, value)} />
            : <span className="worker-role__none">{name} has none</span>}
        </div>
        <div className="worker-role__field"><span aria-hidden="true">Permissions, Watcher’s own</span>
          <WatcherPermissionChip model={model} provider={providerName} inForce={watcher?.runtimeMode} disabled={fixedReason !== undefined} fixedReason={fixedReason} flip /></div>
      </div> : <p className="worker-role__none">Watcher runs on Codex, Claude Code or Grok Build. Connect one to choose its model.</p>}
      {fixedReason ? <p className="worker-role__note">{fixedReason}</p> : null}
      {refusal ? <p className="worker-role__note" role="alert">{refusal}</p> : null}
      {notes.map(note => <p key={note} className="worker-role__note" data-kind="moved">{note}</p>)}
      <Defaults read={read} catalog={catalog} providerOf={providerOf} />
      {differs ? <footer className="worker-role__foot"><button type="button" className="worker-role__link tt-focusable" disabled={fixedReason !== undefined}
        aria-label={fallback ? `Reset Orchestrating to its default, ${fallback.model.name}${fallback.reasoningEffort ? ` at ${effortLabel(fallback.reasoningEffort)}` : ''}. Watcher’s permissions stay as they are` : 'Reset Orchestrating to its defaults'}
        onClick={() => { onReset(); if (fallback) void apply(fallback.model.id, fallback.reasoningEffort) }}>Reset to default</button></footer> : null}
    </div>
    <div className="worker-role__mirror">
      <div className="worker-role__composer" aria-hidden="true">
        <span>Ask about your threads, or say what to start or send</span>
        <span className="worker-role__chips">
          {model ? <span className="worker-role__chip"><ProviderMark provider={model.providerId} name={model.provider} size={13} /><span>{model.name}</span></span> : <span className="worker-role__chip"><span>No model</span></span>}
          {shown?.reasoningEffort ? <span className="worker-role__chip"><span>{effortLabel(shown.reasoningEffort)}</span></span> : null}
          <span className="worker-role__chip"><span>{RUNTIME_LABELS[mirrorMode]}</span></span>
        </span>
      </div>
      <p className="worker-role__caption"><ArrowLeftRight size={14} aria-hidden="true" /><span>Watcher’s composer shows these three. A change in either place changes both.{' '}
        {app ? <button type="button" className="worker-role__link tt-focusable" onClick={() => app.actions.navigate('watcher')}>Show Watcher’s room</button> : null}</span></p>
    </div>
  </article>
}
