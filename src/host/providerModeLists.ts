import type { AgentModel, AgentProviderMode } from '../shared/agents'
import type { HostWireModel } from '../shared/hostProtocol'

/**
 * A catalog for a client that accepted `provider-mode-lists` (ADR-0028, November 1 amendment): each distinct list of
 * provider modes goes once in `providerModeLists`, and a model that has one names it by its place there
 * (`providerModeList`) instead of carrying it. A provider gives every one of its models the same modes, so in practice
 * the table holds one list per provider. Devin's 846 models each carried the same 962-byte list: 814 KB of a 1 MB catalog
 * on the owner's laptop, sent to the iPhone on every connect.
 *
 * A model without modes is sent as it is, so a client never mistakes one for a model that names a list. Kept for the
 * catalog array it was made from, which a certified catalog hands over unchanged until it changes.
 */
export function shareProviderModes(models: readonly AgentModel[]): { models: HostWireModel[]; providerModeLists: AgentProviderMode[][] } {
  const kept = shared.get(models)
  if (kept) return kept
  const providerModeLists: AgentProviderMode[][] = []
  const places = new Map<string, number>()
  const listed = models.map((model): HostWireModel => {
    if (!model.providerModes) return model
    const key = JSON.stringify(model.providerModes)
    let place = places.get(key)
    if (place === undefined) { place = providerModeLists.length; places.set(key, place); providerModeLists.push(model.providerModes) }
    const wire: HostWireModel = { ...model, providerModeList: place }
    delete wire.providerModes
    return wire
  })
  const made = { models: listed, providerModeLists }
  shared.set(models, made)
  return made
}

const shared = new WeakMap<readonly AgentModel[], { models: HostWireModel[]; providerModeLists: AgentProviderMode[][] }>()
