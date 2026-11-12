import type { AgentHostSnapshot, AgentRequest } from '../../shared/agents'

/** Every request Sotto owns starts with this, so it can never be taken for a provider's. */
export const SOTTO_REQUEST_PREFIX = 'sotto:'

/**
 * Requests Sotto itself puts in a thread, answered there like a provider's (ADR-0035). The only one today is the
 * host setup thread's "Add forge as a host?". The coordinator merges them into their thread's requests and hands
 * the user's answer back here instead of to the provider; nothing else answers them.
 */
export interface SottoThreadRequests {
  /** The pending requests, by the Sotto thread they belong to. */
  requests(): ReadonlyMap<string, readonly AgentRequest[]>
  /** The user's answer. Throws when the request is no longer waiting. */
  answer(threadId: string, requestId: string, approved: boolean): void
  subscribe(listener: () => void): () => void
}

export const isSottoRequest = (requestId: string): boolean => requestId.startsWith(SOTTO_REQUEST_PREFIX)

/**
 * The snapshot with each thread's requests from Sotto in place of the ones it carried before: a provider's own are
 * kept as they are, and Sotto's follow them. Threads with nothing to change keep their own object.
 */
export function withSottoRequests(snapshot: AgentHostSnapshot, pending: ReadonlyMap<string, readonly AgentRequest[]>): AgentHostSnapshot {
  let changed = false
  const threads = snapshot.threads.map(thread => {
    const own = pending.get(thread.id) ?? []
    const carried = thread.requests.some(request => isSottoRequest(request.id))
    if (!own.length && !carried) return thread
    changed = true
    return { ...thread, requests: [...thread.requests.filter(request => !isSottoRequest(request.id)), ...structuredClone(own)] }
  })
  return changed ? { ...snapshot, threads } : snapshot
}

const NONE: ReadonlyMap<string, readonly AgentRequest[]> = new Map()

/**
 * Several sources of Sotto's own requests as one: host setup's and plugin changes' (ADR-0205). The coordinator reads
 * the requests on every publication, so what it is handed is built again only when a source hands over a different
 * map, and is the one empty map while nothing waits. An answer goes to the source whose request it names.
 */
export function combinedSottoRequests(sources: readonly SottoThreadRequests[]): SottoThreadRequests {
  let seen: readonly ReadonlyMap<string, readonly AgentRequest[]>[] = []
  let combined = NONE
  return {
    requests: () => {
      const maps = sources.map(source => source.requests())
      if (maps.length === seen.length && maps.every((map, index) => map === seen[index])) return combined
      seen = maps
      const waiting = maps.filter(map => map.size > 0)
      if (waiting.length === 0) combined = NONE
      else if (waiting.length === 1) combined = waiting[0]!
      else {
        const merged = new Map<string, readonly AgentRequest[]>()
        for (const map of waiting) for (const [threadId, requests] of map) merged.set(threadId, [...merged.get(threadId) ?? [], ...requests])
        combined = merged
      }
      return combined
    },
    answer: (threadId, requestId, approved) => {
      const owner = sources.find(source => source.requests().get(threadId)?.some(request => request.id === requestId))
      if (!owner) throw new Error('This request is no longer pending. Refresh the thread.')
      owner.answer(threadId, requestId, approved)
    },
    subscribe: listener => {
      const offs = sources.map(source => source.subscribe(listener))
      return () => { for (const off of offs) off() }
    },
  }
}
