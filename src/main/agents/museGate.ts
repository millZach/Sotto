import { parsePublicProviderEntityId, type AgentModel } from '../../shared/agents'
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
