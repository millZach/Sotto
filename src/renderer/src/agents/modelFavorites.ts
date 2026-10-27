import { useSyncExternalStore } from 'react'
import { z } from 'zod'
import type { AgentModel } from '../../../shared/agents'
import { providerIdSchema } from '../../../shared/providerIds'

/**
 * The models the user starred in the model menu, across every provider and model source, in the order they were starred
 * (ADR-0147). Each keeps what the menu needs to show it while its provider is away: its name, provider and source.
 */
export const MODEL_FAVORITES_KEY = 'sotto.threads.modelFavorites'
const favoriteSchema = z.object({ id: z.string(), name: z.string(), provider: z.string(), providerId: providerIdSchema.optional(), source: z.string().optional() })
export type ModelFavorite = z.infer<typeof favoriteSchema>

/** The same model wherever it is listed: its provider and the provider's own id, which already names an OpenCode model's source. */
export const favoriteKey = (model: Pick<AgentModel, 'id' | 'provider' | 'providerId'>): string => `${model.providerId ?? model.provider}\u0000${model.id}`

const listeners = new Set<() => void>()
const none: readonly ModelFavorite[] = []
/** The last stored text and what it read as, so every read between changes is the same list. */
let parsed: { readonly raw: string | null; readonly favorites: readonly ModelFavorite[] } = { raw: null, favorites: none }
/** What the user last chose when storage refused to keep it. */
let unsaved: readonly ModelFavorite[] | null = null

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  window.addEventListener('storage', listener)
  return () => { listeners.delete(listener); window.removeEventListener('storage', listener) }
}
function read(): readonly ModelFavorite[] {
  if (unsaved) return unsaved
  let raw: string | null
  try { raw = localStorage.getItem(MODEL_FAVORITES_KEY) } catch { return none }
  if (raw !== parsed.raw) {
    let favorites: readonly ModelFavorite[] = none
    // One entry that no longer reads, such as a provider Sotto has dropped, costs only itself.
    try { const stored: unknown = JSON.parse(raw ?? '[]'); if (Array.isArray(stored)) favorites = stored.flatMap(item => favoriteSchema.safeParse(item).data ?? []) } catch { /* Unreadable text keeps no favorites. */ }
    parsed = { raw, favorites }
  }
  return parsed.favorites
}

export function useModelFavorites(): readonly ModelFavorite[] {
  return useSyncExternalStore(subscribe, read, () => none)
}

/** Stars the model, or unstars it where it is starred. */
export function toggleModelFavorite(model: AgentModel | ModelFavorite): void {
  const key = favoriteKey(model)
  const current = read()
  const next = current.some(favorite => favoriteKey(favorite) === key) ? current.filter(favorite => favoriteKey(favorite) !== key)
    : [...current, { id: model.id, name: model.name, provider: model.provider, ...(model.providerId ? { providerId: model.providerId } : {}), ...(model.source ? { source: model.source } : {}) }]
  try { localStorage.setItem(MODEL_FAVORITES_KEY, JSON.stringify(next)); unsaved = null } catch { unsaved = next }
  for (const listener of listeners) listener()
}
