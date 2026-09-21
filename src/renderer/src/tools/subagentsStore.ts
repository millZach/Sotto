import { useCallback, useSyncExternalStore } from 'react'
import { EMPTY_SUBAGENT_SUMMARY, SUBAGENT_PAGE_SIZE, type SubagentChange, type SubagentRow, type SubagentSummary, type SubagentsBridge } from '../../../shared/subagents'

export interface ThreadSubagents {
  readonly rows: readonly SubagentRow[]
  readonly revision: number
  readonly summary: SubagentSummary
  readonly before?: number | undefined
  readonly loading: boolean
  readonly error: string | null
}
const EMPTY: ThreadSubagents = { rows: [], revision: -1, summary: EMPTY_SUBAGENT_SUMMARY, loading: false, error: null }

/** Current rows only. Full tasks and results belong to the open detail, never this cache or agent state. */
export class SubagentsStore {
  private readonly threads = new Map<string, ThreadSubagents>()
  private readonly capacities = new Map<string, number>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private bridge: SubagentsBridge | undefined
  private unsubscribe: (() => void) | undefined
  private generation = 0
  private active: string | null = null

  thread = (id: string): ThreadSubagents => this.threads.get(id) ?? EMPTY
  subscribe(id: string, listener: () => void): () => void {
    const listeners = this.listeners.get(id) ?? new Set<() => void>()
    this.listeners.set(id, listeners)
    listeners.add(listener)
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id) }
  }

  activate(bridge: SubagentsBridge | undefined, threadId: string): void {
    this.deactivate()
    if (this.bridge !== bridge) { this.unsubscribe?.(); this.unsubscribe = undefined; this.threads.clear() }
    this.bridge = bridge
    this.active = threadId
    this.capacities.set(threadId, SUBAGENT_PAGE_SIZE)
    // A return reloads the newest page; old metadata cannot grow with every thread ever visited.
    if (this.threads.size >= 16 && !this.threads.has(threadId)) {
      const oldest = this.threads.keys().next().value
      if (oldest !== undefined) { this.threads.delete(oldest); this.capacities.delete(oldest) }
    }
    this.unsubscribe ??= bridge?.onChanged(change => this.changed(change))
    void this.page(threadId)
  }

  deactivate(): void { this.active = null; this.generation++ }

  dispose(): void { this.deactivate(); this.unsubscribe?.(); this.unsubscribe = undefined; this.threads.clear() }

  async page(threadId: string, older = false): Promise<void> {
    const current = this.thread(threadId)
    if (older && (current.loading || current.before === undefined)) return
    const generation = this.generation
    if (older) this.capacities.set(threadId, current.rows.length + SUBAGENT_PAGE_SIZE)
    this.publish(threadId, { ...current, loading: true, error: null })
    try {
      if (!this.bridge) throw new Error('unavailable')
      const page = await this.bridge.page({ threadId, ...(older ? { before: current.before } : {}) })
      if (generation !== this.generation) return
      const latest = this.thread(threadId)
      const existing = new Map(latest.rows.map(row => [row.id, row]))
      const held = new Map((older || latest.revision > page.revision ? latest.rows : []).map(row => [row.id, row]))
      for (const row of page.rows) {
        const previous = held.get(row.id) ?? existing.get(row.id)
        held.set(row.id, previous && previous.revision >= row.revision ? previous : row)
      }
      const ordered = [...held.values()].sort((a, b) => a.sequence - b.sequence)
      const capacity = this.capacities.get(threadId) ?? SUBAGENT_PAGE_SIZE
      const kept = ordered.slice(-capacity)
      this.publish(threadId, { rows: kept, revision: Math.max(page.revision, latest.revision),
        summary: latest.revision > page.revision ? latest.summary : page.summary, before: ordered.length > capacity ? kept[0]?.sequence : page.before, loading: false, error: null })
    } catch {
      if (generation === this.generation) this.publish(threadId, { ...this.thread(threadId), loading: false, error: 'Could not load agents. Saved work is unchanged. Try again.' })
    }
  }

  private changed(change: SubagentChange): void {
    if (change.reset) {
      this.threads.delete(change.threadId)
      for (const listener of this.listeners.get(change.threadId) ?? []) listener()
      if (this.active === change.threadId) { this.generation++; void this.page(change.threadId) }
      return
    }
    if (change.threadId !== this.active) return
    const current = this.thread(change.threadId)
    if (change.revision <= current.revision) return
    const rows = new Map(current.rows.map(row => [row.id, row]))
    for (const row of change.rows) {
      const previous = rows.get(row.id)
      if (!previous || previous.revision < row.revision) rows.set(row.id, row)
    }
    const ordered = [...rows.values()].sort((a, b) => a.sequence - b.sequence)
    const capacity = this.capacities.get(change.threadId) ?? SUBAGENT_PAGE_SIZE
    const kept = ordered.slice(-capacity)
    this.publish(change.threadId, { ...current, rows: kept, before: ordered.length > capacity ? kept[0]?.sequence : current.before, revision: change.revision, summary: change.summary })
  }

  private publish(threadId: string, value: ThreadSubagents): void {
    this.threads.set(threadId, value)
    for (const listener of this.listeners.get(threadId) ?? []) listener()
  }
}

export function useThreadSubagents(store: SubagentsStore, id: string): ThreadSubagents {
  return useSyncExternalStore(useCallback(listener => store.subscribe(id, listener), [store, id]), useCallback(() => store.thread(id), [store, id]))
}
