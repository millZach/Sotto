import { z } from 'zod'

/**
 * Sotto's thread providers, one ID each. Every list of providers derives from this one: a schema's cap is its length,
 * and a list that must name every provider says so with `everyProvider`, so a new ID is added here and nowhere else
 * before the type checker names what still needs it. It lives apart from `agents.ts` so the schemas `agents.ts`
 * imports can use it too.
 */
export const providerIdSchema = z.enum(['codex', 'claude', 'grok', 'devin', 'muse'])
export type ProviderId = z.infer<typeof providerIdSchema>

type MissingProvider<T extends readonly ProviderId[]> = Exclude<ProviderId, T[number]>

/**
 * A list that must name every provider, in an order its caller chooses. A provider left out is a type error that
 * names it, so a new provider cannot be forgotten in one; a provider named twice throws when the list is made.
 */
export function everyProvider<const T extends readonly ProviderId[]>(
  list: T & ([MissingProvider<T>] extends [never] ? unknown : { readonly missingProvider: MissingProvider<T> }),
): T {
  const repeated = list.find((id, index) => list.indexOf(id) !== index)
  if (repeated !== undefined) throw new Error(`${repeated} is listed twice in a list of every provider.`)
  return list
}
