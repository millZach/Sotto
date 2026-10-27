import type { AgentHostSnapshot, AgentThread } from '../../shared/agents'

/**
 * When each pending request started waiting (ADR-0135). A request carries no moment of its own, and a thread's last
 * activity is not the same fact, so the coordinator stamps a request as it is first shown — in `decorate`, beside the
 * pages a question is decorated with — and the stamp then stands on the shown thread itself, shared by every read
 * of it. Answered, withdrawn and gone with their thread, requests are forgotten: one asked again under the same ID
 * is a new wait. The stamps live in memory alone, beside `FailuresSeen`'s: a restart restamps what it still holds,
 * understating a wait rather than inventing one, and clients that predate the field drop it unread.
 */
export class RequestWaits {
  /** Each thread's standing requests' stamps, as the ISO strings shown for them, by request ID. */
  private readonly stamps = new Map<string, Map<string, string>>()
  /** The threads in the latest whole list shown; until one is shown, a changed showing has nothing to read against. */
  private present: Set<string> | undefined

  constructor(private readonly now: () => number = Date.now) {}

  /** Told of each thread whose requests gained a stamp, so a caller listing by change relists it. */
  onMoved: ((threadId: string) => void) | undefined

  /**
   * The snapshot with each request's stamp on it. Without `gone` the snapshot is the whole list, and stamps for
   * threads and requests it no longer holds are forgotten; with it, only the threads it names are read, and the
   * gone are forgotten. A stamp a request already carries — this coordinator's own snapshot shown again, or one a
   * remote coordinator stamped — is kept and taken as the wait's start.
   */
  decorate(snapshot: AgentHostSnapshot, gone?: ReadonlySet<string>): AgentHostSnapshot {
    if (!gone) this.present = new Set(snapshot.threads.map(thread => thread.id))
    else {
      if (!this.present) throw new Error('A change of threads is read only after a whole list was.')
      for (const id of gone) { this.present.delete(id); this.stamps.delete(id) }
    }
    const present = this.present
    let changed = false
    const threads = snapshot.threads.map(thread => {
      present.add(thread.id)
      const stamped = this.stamp(thread)
      if (stamped !== thread) changed = true
      return stamped
    })
    if (!gone) for (const id of [...this.stamps.keys()]) if (!present.has(id)) this.stamps.delete(id)
    return changed ? { ...snapshot, threads } : snapshot
  }

  /** One thread with its requests stamped: the thread itself while every stamp already stands as given. */
  private stamp(thread: AgentThread): AgentThread {
    if (thread.requests.length === 0) { this.stamps.delete(thread.id); return thread }
    let mine = this.stamps.get(thread.id)
    // The steady state, read on every showing: every request already carries the stamp this record gave it.
    if (mine && mine.size === thread.requests.length
      && thread.requests.every(request => request.since !== undefined && mine!.get(request.id) === request.since)) return thread
    let moved = false
    const standing = new Set(thread.requests.map(request => request.id))
    for (const request of thread.requests) {
      if (!mine?.has(request.id)) {
        mine ??= new Map()
        mine.set(request.id, request.since !== undefined && Number.isFinite(Date.parse(request.since))
          ? request.since : new Date(this.now()).toISOString())
        moved = true
      }
    }
    for (const id of [...mine!.keys()]) if (!standing.has(id)) mine!.delete(id)
    this.stamps.set(thread.id, mine!)
    if (moved) this.onMoved?.(thread.id)
    let changed = false
    const requests = thread.requests.map(request => {
      const since = mine!.get(request.id)!
      if (request.since === since) return request
      changed = true
      return { ...request, since }
    })
    return changed ? { ...thread, requests } : thread
  }
}
