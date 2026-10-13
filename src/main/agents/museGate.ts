import { parsePublicProviderEntityId, providerIdOfLabel, type AgentCommand, type AgentHostSnapshot, type AgentModel, type AgentThread } from '../../shared/agents'
import { resolveModel } from '../../shared/modelCatalog'
import type { WatcherRefusal } from '../../shared/watcher'
import type { WatcherHostControl, WatcherHostRead } from '../../shared/watcherHost'
import { immutableModels, isImmutableModels } from './activitySnapshots'

const heldCatalogs = new WeakMap<AgentModel[], AgentModel[]>()
/** A stable catalog omits Muse and keeps certified ownership, so streaming snapshots can share it. */
export function modelsWithoutMuse(models: AgentModel[]): AgentModel[] {
  const hidden = (model: AgentModel): boolean => model.providerId === 'muse' || parsePublicProviderEntityId(model.id)?.provider === 'muse'
    || providerIdOfLabel(model.provider) === 'muse'
  if (!models.some(hidden)) return models
  if (!isImmutableModels(models)) return models.filter(model => !hidden(model))
  const held = heldCatalogs.get(models)
  if (held) return held
  const visible = immutableModels(models.filter(model => !hidden(model)))
  heldCatalogs.set(models, visible)
  return visible
}

function modelUsesMuse(id: string | undefined, snapshot?: AgentHostSnapshot): boolean {
  if (!id) return false
  if (parsePublicProviderEntityId(id)?.provider === 'muse') return true
  if (snapshot?.models.some(model => {
    const scoped = parsePublicProviderEntityId(model.id)
    return scoped?.provider === 'muse' && scoped.kind === 'model' && scoped.value === id
  })) return true
  const model = snapshot ? resolveModel(snapshot.models, id) : undefined
  return model?.providerId === 'muse' || model !== undefined && providerIdOfLabel(model.provider) === 'muse'
}
function projectUsesMuse(id: string | undefined, snapshot?: AgentHostSnapshot): boolean {
  return id !== undefined && (parsePublicProviderEntityId(id)?.provider === 'muse' || snapshot?.projects.some(project => {
    const scoped = parsePublicProviderEntityId(project.id)
    return project.id === id && project.providerId === 'muse'
      || scoped?.provider === 'muse' && scoped.kind === 'project' && scoped.value === id
  }) === true)
}

/** Explicit provider choices and model/project ownership share the same gate at every desktop command boundary. */
export function commandUsesMuse(command: AgentCommand, snapshot?: AgentHostSnapshot): boolean {
  if ('provider' in command && command.provider === 'muse') return true
  if ((command.type === 'queue-client-updates' || command.type === 'cancel-client-updates') && command.providers.includes('muse')) return true
  if ('modelId' in command && modelUsesMuse(command.modelId, snapshot)) return true
  if ('projectId' in command && projectUsesMuse(command.projectId, snapshot)) return true
  return command.type === 'configure' && (command.patch.provider === 'muse'
    || command.patch.enabledProviders?.includes('muse') === true || command.patch.disconnectedProviders?.includes('muse') === true
    || modelUsesMuse(command.patch.defaultModelId, snapshot) || modelUsesMuse(command.patch.newThreadModelId, snapshot))
}

/** A wildcard version check reads every connected client; ask the raw target before sending it. */
export function clientUpdateEnumerationUsesMuse(command: AgentCommand, snapshot?: AgentHostSnapshot): boolean {
  if (command.type !== 'check-client-updates') return false
  if (!snapshot) return true
  // Legacy snapshots omit providers; the coordinator's check then iterates an empty list.
  return snapshot.providers?.some(provider => provider.id === 'muse' && provider.connection === 'connected') === true
}

export function threadUsesMuse(thread: AgentThread, snapshot: AgentHostSnapshot): boolean {
  return thread.providerId === 'muse' || !thread.providerId && modelUsesMuse(thread.modelId, snapshot)
}

/** Refuse unsafe remote pages before the wire: the owning host's rows, counts and cursors stay one response. */
export function watcherRequestUsesMuse(request: WatcherHostRead | WatcherHostControl, snapshot?: AgentHostSnapshot,
  knownMuseThreads: ReadonlyMap<string, string> = new Map()): boolean {
  const call = request.call
  if (!call || call.name === 'read_operation') return false
  const threads = new Map(knownMuseThreads)
  for (const thread of snapshot?.threads ?? []) {
    if (snapshot && threadUsesMuse(thread, snapshot)) threads.set(thread.id, thread.projectId)
  }
  if ('target' in call.input) return (!snapshot?.hostId || call.input.target.hostId === snapshot.hostId) && threads.has(call.input.target.threadId)
  if ('modelId' in call.input && modelUsesMuse(call.input.modelId, snapshot)) return true
  if ('project' in call.input && call.input.project && projectUsesMuse(call.input.project.projectId, snapshot)) return true
  if (call.name === 'list_projects') return snapshot?.projects.some(project => projectUsesMuse(project.id, snapshot)) === true
    || snapshot?.models.some(model => modelUsesMuse(model.id, snapshot)) === true
  if (call.name !== 'list_threads') return false
  const project = call.input.project
  if (!project) return threads.size > 0
  const projects = snapshot?.projects ?? []
  // An exact catalog identity wins. Only an unqualified alias may resolve to the catalog's qualified identity.
  const scope = projects.some(item => item.id === project.projectId) || parsePublicProviderEntityId(project.projectId)
    ? [project.projectId] : projects.filter(item => {
      const scoped = parsePublicProviderEntityId(item.id)
      return scoped?.kind === 'project' && scoped.value === project.projectId
    }).map(item => item.id)
  const ids = new Set(scope.length ? scope : [project.projectId])
  return [...threads.values()].some(id => ids.has(id))
}

export function museWatcherRefusal(): WatcherRefusal {
  return { status: 'refused', code: 'PROVIDER_UNAVAILABLE', retryable: false,
    message: 'Muse is available in Sotto Owl. Open an Owl build to continue. Nothing was sent.' }
}
