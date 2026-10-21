import { EMPTY_AGENT_HOST, PROVIDER_LABELS, parsePublicProviderEntityId, providerIdOfLabel, type AgentCommand, type AgentHostSnapshot,
  type AgentModel, type AgentProject, type AgentThread, type ProviderId } from '../../shared/agents'
import { heldProviderRefusal, inHeldOrder, type HeldProviderNames, type HeldProviders } from '../../shared/heldProviders'
import { resolveModel } from '../../shared/modelCatalog'
import type { WatcherRefusal } from '../../shared/watcher'
import type { WatcherHostControl, WatcherHostRead } from '../../shared/watcherHost'
import { immutableModels, isImmutableModels } from './activitySnapshots'
import type { AgentHost, AgentHostResult } from './host'

/**
 * One gate for every provider held to Owl (ADR-0072, ADR-0079). Each question takes the run's held set, read once at
 * start, and answers with the held provider it touches, so a refusal names that provider; undefined means none is held.
 */

/** A held provider's thread, dormant on this run, as a boundary remembers it after its shell has gone: its project and provider. */
export interface DormantProviderThread { readonly projectId: string; readonly provider: ProviderId }
export type DormantProviderThreads = ReadonlyMap<string, DormantProviderThread>

const heldOf = (provider: string | undefined, held: HeldProviders): ProviderId | undefined =>
  provider !== undefined && held.has(provider as ProviderId) ? provider as ProviderId : undefined
const heldOfLabel = (label: string, held: HeldProviders): ProviderId | undefined => heldOf(providerIdOfLabel(label), held)
/**
 * Each public ID's provider, read once. The workspace asks every thread's model ID on every publish, and the catalog's
 * model IDs too; parsing each again was about a second of a busy minute (October 19, 2026). IDs are few, the models and
 * projects a run names, and the cache starts again past its bound.
 */
const scopedProviders = new Map<string, ProviderId | null>()
const SCOPED_PROVIDERS_MAX = 10_000
function scopedProvider(id: string): ProviderId | undefined {
  let provider = scopedProviders.get(id)
  if (provider === undefined) {
    if (scopedProviders.size >= SCOPED_PROVIDERS_MAX) scopedProviders.clear()
    provider = parsePublicProviderEntityId(id)?.provider ?? null
    scopedProviders.set(id, provider)
  }
  return provider ?? undefined
}
const heldOfScoped = (id: string | undefined, held: HeldProviders): ProviderId | undefined =>
  id && held.size ? heldOf(scopedProvider(id), held) : undefined

/** A catalog entry's held provider, by its own provider, its scoped identity or its label. */
export function heldProviderOfModel(model: AgentModel, held: HeldProviders): ProviderId | undefined {
  return heldOf(model.providerId, held) ?? heldOfScoped(model.id, held) ?? heldOfLabel(model.provider, held)
}
export function heldProviderOfProject(project: Pick<AgentProject, 'id' | 'providerId'>, held: HeldProviders): ProviderId | undefined {
  return heldOf(project.providerId, held) ?? heldOfScoped(project.id, held)
}

/** Keyed by the catalog and then by the held set itself, which a run makes once at start and never changes. */
const heldCatalogs = new WeakMap<AgentModel[], WeakMap<HeldProviders, AgentModel[]>>()
/** A stable catalog omits held providers and keeps certified ownership, so streaming snapshots can share it. */
export function modelsWithoutHeld(models: AgentModel[], held: HeldProviders): AgentModel[] {
  const hidden = (model: AgentModel): boolean => heldProviderOfModel(model, held) !== undefined
  if (!held.size) return models
  // Asked before anything is read from the catalog: it is the same catalog on nearly every publish.
  const cached = isImmutableModels(models) ? heldCatalogs.get(models)?.get(held) : undefined
  if (cached) return cached
  if (!models.some(hidden)) {
    if (isImmutableModels(models)) { const byHeld = heldCatalogs.get(models) ?? new WeakMap<HeldProviders, AgentModel[]>(); byHeld.set(held, models); heldCatalogs.set(models, byHeld) }
    return models
  }
  if (!isImmutableModels(models)) return models.filter(model => !hidden(model))
  const visible = immutableModels(models.filter(model => !hidden(model)))
  const byHeld = heldCatalogs.get(models) ?? new WeakMap<HeldProviders, AgentModel[]>()
  byHeld.set(held, visible); heldCatalogs.set(models, byHeld)
  return visible
}

/** A snapshot's catalog without held providers' models, projects and provider rows. Threads are each boundary's own. */
export function catalogWithoutHeld(snapshot: AgentHostSnapshot, held: HeldProviders): Pick<AgentHostSnapshot, 'models' | 'projects' | 'providers'> {
  return { models: modelsWithoutHeld(snapshot.models, held),
    projects: snapshot.projects.filter(project => heldProviderOfProject(project, held) === undefined),
    ...(snapshot.providers ? { providers: snapshot.providers.filter(provider => !held.has(provider.id)) } : {}) }
}

export function heldProviderOfModelId(id: string | undefined, held: HeldProviders, snapshot?: AgentHostSnapshot): ProviderId | undefined {
  if (!id || !held.size) return undefined
  const scoped = heldOfScoped(id, held)
  if (scoped) return scoped
  for (const model of snapshot?.models ?? []) {
    const entity = parsePublicProviderEntityId(model.id)
    if (entity && entity.kind === 'model' && entity.value === id && held.has(entity.provider)) return entity.provider
  }
  const model = snapshot ? resolveModel(snapshot.models, id) : undefined
  return model ? heldOf(model.providerId, held) ?? heldOfLabel(model.provider, held) : undefined
}
export function heldProviderOfProjectId(id: string | undefined, held: HeldProviders, snapshot?: AgentHostSnapshot): ProviderId | undefined {
  if (id === undefined || !held.size) return undefined
  const scoped = heldOfScoped(id, held)
  if (scoped) return scoped
  for (const project of snapshot?.projects ?? []) {
    if (project.id === id && heldOf(project.providerId, held)) return project.providerId as ProviderId
    const entity = parsePublicProviderEntityId(project.id)
    if (entity && entity.kind === 'project' && entity.value === id && held.has(entity.provider)) return entity.provider
  }
  return undefined
}

/**
 * The held provider a command chooses outright: its provider, a configuration that selects, enables or defaults to it, or a
 * client update for it. This is the coordinator's own check, which has no host catalog to resolve an unscoped model by.
 */
export function heldProviderChosenBy(command: AgentCommand, held: HeldProviders): ProviderId | undefined {
  if (!held.size) return undefined
  if ('provider' in command) { const provider = heldOf(command.provider, held); if (provider) return provider }
  if (command.type === 'configure') {
    const provider = heldOf(command.patch.provider, held) ?? command.patch.enabledProviders?.find(item => held.has(item))
      ?? heldOfScoped(command.patch.defaultModelId ?? '', held) ?? heldOfScoped(command.patch.newThreadModelId ?? '', held)
    if (provider) return provider
  }
  if (command.type === 'queue-client-updates' || command.type === 'cancel-client-updates') return command.providers.find(item => held.has(item))
  return undefined
}

/** Explicit provider choices and model/project ownership share the same gate at every desktop command boundary. */
export function heldProviderOfCommand(command: AgentCommand, held: HeldProviders, snapshot?: AgentHostSnapshot): ProviderId | undefined {
  const chosen = heldProviderChosenBy(command, held)
  if (chosen || !held.size) return chosen
  if ('modelId' in command) { const provider = heldProviderOfModelId(command.modelId, held, snapshot); if (provider) return provider }
  if ('projectId' in command) { const provider = heldProviderOfProjectId(command.projectId, held, snapshot); if (provider) return provider }
  if (command.type !== 'configure') return undefined
  return command.patch.disconnectedProviders?.find(item => held.has(item))
    ?? heldProviderOfModelId(command.patch.defaultModelId, held, snapshot) ?? heldProviderOfModelId(command.patch.newThreadModelId, held, snapshot)
}

/** A wildcard version check reads every connected client; ask the raw target before sending it. */
export function heldProviderOfClientUpdateEnumeration(command: AgentCommand, held: HeldProviders, snapshot?: AgentHostSnapshot): ProviderId | undefined {
  if (command.type !== 'check-client-updates' || !held.size) return undefined
  if (!snapshot) return held.values().next().value
  // Legacy snapshots omit providers; the coordinator's check then iterates an empty list.
  return snapshot.providers?.find(provider => held.has(provider.id) && provider.connection === 'connected')?.id
}

/** What every host boundary refuses a command with: the held provider it chooses, owns or would enumerate. */
export function heldProviderRefusedBy(command: AgentCommand, held: HeldProviders, snapshot?: AgentHostSnapshot): ProviderId | undefined {
  return heldProviderOfCommand(command, held, snapshot) ?? heldProviderOfClientUpdateEnumeration(command, held, snapshot)
}

/** A thread's held provider: its own provider, or, for a thread that names none, its model's. */
export function heldProviderOfThread(thread: AgentThread, snapshot: AgentHostSnapshot, held: HeldProviders): ProviderId | undefined {
  if (!held.size) return undefined
  return thread.providerId ? heldOf(thread.providerId, held) : heldProviderOfModelId(thread.modelId, held, snapshot)
}

/** A saved thread record's held provider, from its provider or its scoped model alone: the workspace's own records. */
export function heldProviderOfThreadRecord(thread: Pick<AgentThread, 'providerId' | 'modelId'>, held: HeldProviders): ProviderId | undefined {
  if (!held.size) return undefined
  return heldOf(thread.providerId, held) ?? heldOfScoped(thread.modelId, held)
}

/** Remembers a shell's dormant threads of held providers, which stay dormant when a later shell omits them. */
export function rememberDormantProviderThreads(into: Map<string, DormantProviderThread>, snapshot: AgentHostSnapshot, held: HeldProviders): Map<string, DormantProviderThread> {
  if (!held.size) return into
  for (const thread of snapshot.threads) {
    const provider = heldProviderOfThread(thread, snapshot, held)
    if (!provider) continue
    // An unchanged thread keeps its entry: this runs on every published state.
    const known = into.get(thread.id)
    if (known?.provider !== provider || known.projectId !== thread.projectId) into.set(thread.id, { projectId: thread.projectId, provider })
  }
  return into
}

/**
 * Refuse unsafe remote pages before the wire: the owning host's rows, counts and cursors stay one response. A list of every
 * thread names each held provider with a dormant thread in it, so the refusal says every provider Owl would show there.
 */
export function heldProviderOfWatcherRequest(request: WatcherHostRead | WatcherHostControl, held: HeldProviders, snapshot?: AgentHostSnapshot,
  knownDormantThreads: DormantProviderThreads = new Map()): HeldProviderNames | undefined {
  const call = request.call
  if (!held.size || !call || call.name === 'read_operation') return undefined
  const threads = new Map(knownDormantThreads)
  if (snapshot) rememberDormantProviderThreads(threads, snapshot, held)
  if ('target' in call.input) {
    return !snapshot?.hostId || call.input.target.hostId === snapshot.hostId ? threads.get(call.input.target.threadId)?.provider : undefined
  }
  if ('modelId' in call.input) { const provider = heldProviderOfModelId(call.input.modelId, held, snapshot); if (provider) return provider }
  if ('project' in call.input && call.input.project) {
    const provider = heldProviderOfProjectId(call.input.project.projectId, held, snapshot); if (provider) return provider
  }
  if (call.name === 'list_projects') {
    for (const project of snapshot?.projects ?? []) { const provider = heldProviderOfProjectId(project.id, held, snapshot); if (provider) return provider }
    for (const model of snapshot?.models ?? []) { const provider = heldProviderOfModelId(model.id, held, snapshot); if (provider) return provider }
    return undefined
  }
  if (call.name !== 'list_threads') return undefined
  const project = call.input.project
  if (!project) {
    const providers = inHeldOrder([...threads.values()].map(thread => thread.provider))
    return providers.length > 1 ? providers : providers[0]
  }
  const projects = snapshot?.projects ?? []
  // An exact catalog identity wins. Only an unqualified alias may resolve to the catalog's qualified identity.
  const scope = projects.some(item => item.id === project.projectId) || parsePublicProviderEntityId(project.projectId)
    ? [project.projectId] : projects.filter(item => {
      const scoped = parsePublicProviderEntityId(item.id)
      return scoped?.kind === 'project' && scoped.value === project.projectId
    }).map(item => item.id)
  const ids = new Set(scope.length ? scope : [project.projectId])
  return [...threads.values()].find(thread => ids.has(thread.projectId))?.provider
}

/** What Watcher hears for a held provider's thread, in that provider's name. */
export function heldWatcherRefusal(provider: HeldProviderNames): WatcherRefusal {
  return { status: 'refused', code: 'PROVIDER_UNAVAILABLE', retryable: false, message: heldProviderRefusal(provider) }
}

/**
 * A held provider's adapter while its Owl feature is off (ADR-0072, ADR-0079): nothing is shown or started, and the real
 * adapter's saved records stay on disk untouched for a return to Owl. The provider keeps its place in the switch so a
 * thread bound to it is refused in its own name rather than taken for another provider's.
 */
export class HeldProviderHost implements AgentHost {
  private readonly snapshotValue: AgentHostSnapshot
  constructor(private readonly provider: ProviderId) {
    this.snapshotValue = { ...structuredClone(EMPTY_AGENT_HOST), name: PROVIDER_LABELS[provider] }
  }
  async connect(): Promise<AgentHostSnapshot> { throw new Error(`${PROVIDER_LABELS[this.provider]} is available in Sotto Owl; it is not in this build.`) }
  async snapshot(): Promise<AgentHostSnapshot> { return structuredClone(this.snapshotValue) }
  async execute(): Promise<AgentHostResult> { throw new Error(`${PROVIDER_LABELS[this.provider]} is available in Sotto Owl.`) }
  subscribe(): () => void { return () => undefined }
  disconnect(): void { /* Nothing was started. */ }
}
