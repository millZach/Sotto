import type { AgentModel } from '../shared/agents'
import { baseModelId } from '../shared/modelCatalog'

/**
 * A catalog for a client that accepted `usable-models` (ADR-0028, November 1 amendment, part 2): every model its provider
 * reports ready, and a model that is not only while something still names it, such as a thread's model or Watcher's. The
 * desktop keeps every model a provider has ever listed, marked not ready once the provider stops listing it, so an old
 * thread's model still resolves; the iPhone offers only ready models, so the rest is weight it throws away. On the owner's
 * laptop, Devin, no longer connected, had left 846 models in the catalog: 204 KB of every phone's hello.
 *
 * Kept for the catalog array it was made from and the models named, so an unchanged catalog stays one array and its
 * revision stays put, for each phone even when phones name different models (`usableVariant`). A name the catalog does
 * not list, such as `opus[1m]`, keeps the entry it resolves to (`catalogEntry`).
 */
export function usableModels(models: AgentModel[], named: Iterable<string | undefined>): AgentModel[] {
  let entry = made.get(models)
  if (!entry) made.set(models, entry = { listed: new Set(models.map(model => model.id)), unready: new Set(models.flatMap(model => model.ready ? [] : [model.id])), cut: new Map() })
  if (!entry.unready.size) return models
  const kept = new Set<string>()
  for (const name of named) {
    const id = !name || entry.listed.has(name) ? name : baseModelId(name)
    if (id && entry.unready.has(id)) kept.add(id)
  }
  const key = [...kept].sort().join('\n')
  let usable = entry.cut.get(key)
  if (!usable) {
    // One cut for each set of models named, which is one for each phone at most; a catalog that changes starts afresh.
    if (entry.cut.size >= CUTS_KEPT) entry.cut.clear()
    entry.cut.set(key, usable = models.filter(model => model.ready || kept.has(model.id)))
    variants.set(usable, key)
  }
  return usable
}

/**
 * Which cut of its catalog `models` is, by the not-ready models it keeps; undefined for a catalog that was not cut. Two
 * phones that name different models are sent different cuts, so each cut counts its own revisions: on one counter, every
 * publish moved the revision from one phone's cut to the other's and sent each its whole catalog again.
 */
export function usableVariant(models: readonly AgentModel[]): string | undefined {
  return variants.get(models)
}

const CUTS_KEPT = 16
const made = new WeakMap<AgentModel[], { listed: ReadonlySet<string>; unready: ReadonlySet<string>; cut: Map<string, AgentModel[]> }>()
const variants = new WeakMap<readonly AgentModel[], string>()
