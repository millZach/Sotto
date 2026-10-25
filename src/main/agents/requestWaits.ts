import type { AgentHostSnapshot, AgentThread } from '../../shared/agents'

/**
 * When each pending request started waiting (ADR-0135). A request carries no moment of its own, and a thread's last
 * activity is not the same fact, so the coordinator stamps a request when it first shows it and keeps the stamp while
 * the request stands. Answered, withdrawn and gone with their thread, requests are forgotten: one asked again under
 * the same ID is a new wait. The stamps live in memory alone, beside `FailuresSeen`'s: a restart restamps what it
 * still holds, understating a wait rather than inventing one, and clients that predate the field drop it unread.
 */
export class RequestWaits {
  /** Each standing request's stamp, in milliseconds since the epoch, by thread and request ID. */
  private readonly stamps = new Map<string, number>()
  /** The threads in the latest list read; until one is read, a change read has nothing to read against. */
  private present: Set<string> | undefined

  constructor(private readonly now: () => number = Date.now) {}

  /** Told of each thread whose published requests may have gained a stamp, so a caller listing by change relists it. */
  onMoved: ((threadId: string) => void) | undefined

  private static key(threadId: string, requestId: string): string { return `${threadId}\0${requestId}` }

  /** Reads one snapshot of the threads. */
  track(snapshot: AgentHostSnapshot): void {
    this.present = new Set(snapshot.threads.map(thread => thread.id))
    for (const thread of snapshot.threads) this.read(thread)
    for (const key of [...this.stamps.keys()]) {
      if (!this.present.has(key.slice(0, key.indexOf('\0')))) this.stamps.delete(key)
    }
  }

  /** Reads only the threads a change named, as `track` of the whole list would leave them; a whole read must come first. */
  trackChanged(snapshot: AgentHostSnapshot, threads: readonly AgentThread[], gone: Iterable<string>): void {
    void snapshot
    const present = this.present
    if (!present) throw new Error('A change of threads is read only after a whole list was.')
    for (const id of gone) {
      present.delete(id)
      for (const key of [...this.stamps.keys()]) if (key.startsWith(`${id}\0`)) this.stamps.delete(key)
    }
    for (const thread of threads) { present.add(thread.id); this.read(thread) }
  }

  /** Stamps the requests this thread newly shows and forgets the ones it no longer does. */
  private read(thread: AgentThread): void {
    let moved = false
    const standing = new Set(thread.requests.map(request => request.id))
    for (const request of thread.requests) {
      const key = RequestWaits.key(thread.id, request.id)
      if (!this.stamps.has(key)) { this.stamps.set(key, this.now()); moved = true }
    }
    for (const key of [...this.stamps.keys()]) {
      const split = key.indexOf('\0')
      if (key.slice(0, split) === thread.id && !standing.has(key.slice(split + 1))) this.stamps.delete(key)
    }
    if (moved) this.onMoved?.(thread.id)
  }

  /** The thread as clients read it: each request with the stamp this record gave it, and no stamp it did not. */
  publish<T extends Pick<AgentThread, 'id' | 'requests'>>(thread: T): T {
    if (thread.requests.length === 0) return thread
    let changed = false
    const requests = thread.requests.map(request => {
      const at = this.stamps.get(RequestWaits.key(thread.id, request.id))
      const since = at === undefined ? undefined : new Date(at).toISOString()
      if (request.since === since) return request
      changed = true
      const { since: _since, ...rest } = request
      void _since
      return since === undefined ? rest : { ...rest, since }
    })
    return changed ? { ...thread, requests } : thread
  }
}
