import type { AgentThread } from '../../shared/agents'
import { failureUnseen } from '../../shared/threadFailures'

/** Host-owned snoozes (ADR-0175). Clients read one answer; requests wake the whole delegation permanently. */
export class ThreadSnoozes {
  private readonly until = new Map<string, string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(readonly enabled: boolean, private readonly moved: (id: string) => void, private readonly expired: () => void) {}

  restore(saved: Readonly<Record<string, string>>): void {
    for (const [id, until] of Object.entries(saved)) this.until.set(id, until)
    if (this.enabled) this.schedule()
  }
  saved(): Record<string, string> { return Object.fromEntries(this.until) }
  set(id: string, until: string | null): void {
    if (until === null) this.until.delete(id); else this.until.set(id, until)
    this.moved(id)
    this.schedule()
  }
  /** Only changed threads and their ancestors are read; a provider frame never scans the user's history. */
  track(threads: readonly AgentThread[], find: (id: string) => AgentThread | undefined, settled: (thread: AgentThread) => boolean, visible: (thread: AgentThread) => AgentThread): boolean {
    if (!this.enabled || !this.until.size) return false
    let changed = false
    for (const thread of threads) {
      const needs = thread.requests.length > 0 || !settled(thread) && failureUnseen(visible(thread))
      if (!needs) continue
      let current: AgentThread | undefined = thread
      const seen = new Set<string>()
      while (current && !seen.has(current.id)) {
        seen.add(current.id)
        if (this.until.delete(current.id)) { this.moved(current.id); changed = true }
        if (!needs || settled(current)) break
        current = current.delegatedBy ? find(current.delegatedBy) : undefined
      }
    }
    if (changed) this.schedule()
    return changed
  }
  /** Null advertises support without an active snooze; omission keeps older hosts and stable unchanged. */
  publish<T extends AgentThread>(thread: T): T {
    if (!this.enabled) return thread
    const snoozedUntil = this.until.get(thread.id) ?? null
    return thread.snoozedUntil === snoozedUntil ? thread : { ...thread, snoozedUntil }
  }
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.enabled || !this.until.size) return
    const now = Date.now()
    const next = Math.min(...[...this.until.values()].map(Date.parse))
    this.timer = setTimeout(() => {
      let changed = false
      for (const [id, until] of this.until) if (Date.parse(until) <= Date.now()) {
        this.until.delete(id); this.moved(id); changed = true
      }
      this.schedule()
      if (changed) this.expired()
    }, Math.max(0, Math.min(next - now, 2_147_483_647)))
    this.timer.unref?.()
  }
  dispose(): void { if (this.timer) clearTimeout(this.timer) }
}
