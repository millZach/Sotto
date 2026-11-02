import type { AgentModel } from '../shared/agents'

/**
 * A catalog for a client that accepted `usable-models` (ADR-0028, November 1 amendment, part 2): every model its provider
 * reports ready, and a model that is not only while something still names it, such as a thread's model or Watcher's. The
 * desktop keeps every model a provider has ever listed, marked not ready once the provider stops listing it, so an old
 * thread's model still resolves; the iPhone offers only ready models, so the rest is weight it throws away. On the owner's
 * laptop, Devin, no longer connected, had left 846 models in the catalog: 204 KB of every phone's hello.
 *
 * Kept for the catalog array it was made from and the models named, so an unchanged catalog stays one array and its
 * revision stays put.
 */
export function usableModels(models: AgentModel[], named: Iterable<string | undefined>): AgentModel[] {
  let entry = made.get(models)
  if (!entry) made.set(models, entry = { unready: new Set(models.flatMap(model => model.ready ? [] : [model.id])), key: '', usable: models })
  if (!entry.unready.size) return models
  const kept = new Set<string>()
  for (const id of named) if (id && entry.unready.has(id)) kept.add(id)
  const key = [...kept].sort().join('\n')
  if (entry.usable === models || entry.key !== key) { entry.key = key; entry.usable = models.filter(model => model.ready || kept.has(model.id)) }
  return entry.usable
}

const made = new WeakMap<AgentModel[], { unready: ReadonlySet<string>; key: string; usable: AgentModel[] }>()
