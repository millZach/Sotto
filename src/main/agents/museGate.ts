import { parsePublicProviderEntityId, providerIdOfLabel, type AgentCommand, type AgentHostSnapshot, type AgentModel } from '../../shared/agents'
import { resolveModel } from '../../shared/modelCatalog'
import { immutableModels, isImmutableModels } from './activitySnapshots'

const heldCatalogs = new WeakMap<AgentModel[], AgentModel[]>()
/** A stable catalog omits Muse and keeps certified ownership, so streaming snapshots can share it. */
export function modelsWithoutMuse(models: AgentModel[]): AgentModel[] {
  const hidden = (model: AgentModel): boolean => model.providerId === 'muse' || parsePublicProviderEntityId(model.id)?.provider === 'muse'
  if (!models.some(hidden)) return models
  if (!isImmutableModels(models)) return models.filter(model => !hidden(model))
  const held = heldCatalogs.get(models)
  if (held) return held
  const visible = immutableModels(models.filter(model => !hidden(model)))
  heldCatalogs.set(models, visible)
  return visible
}

/** Explicit provider choices and model/project ownership share the same gate at every desktop command boundary. */
export function commandUsesMuse(command: AgentCommand, snapshot?: AgentHostSnapshot): boolean {
  const museModel = (id: string | undefined): boolean => {
    if (!id) return false
    if (parsePublicProviderEntityId(id)?.provider === 'muse') return true
    if (snapshot?.models.some(model => {
      const scoped = parsePublicProviderEntityId(model.id)
      return scoped?.provider === 'muse' && scoped.kind === 'model' && scoped.value === id
    })) return true
    const model = snapshot ? resolveModel(snapshot.models, id) : undefined
    return model?.providerId === 'muse' || model !== undefined && providerIdOfLabel(model.provider) === 'muse'
  }
  if ('provider' in command && command.provider === 'muse') return true
  if ((command.type === 'queue-client-updates' || command.type === 'cancel-client-updates') && command.providers.includes('muse')) return true
  if ('modelId' in command && museModel(command.modelId)) return true
  if ('projectId' in command && (parsePublicProviderEntityId(command.projectId)?.provider === 'muse'
    || snapshot?.projects.some(project => {
      const scoped = parsePublicProviderEntityId(project.id)
      return project.id === command.projectId && project.providerId === 'muse'
        || scoped?.provider === 'muse' && scoped.kind === 'project' && scoped.value === command.projectId
    }))) return true
  return command.type === 'configure' && (command.patch.provider === 'muse'
    || command.patch.enabledProviders?.includes('muse') === true || command.patch.disconnectedProviders?.includes('muse') === true
    || museModel(command.patch.defaultModelId) || museModel(command.patch.newThreadModelId))
}
