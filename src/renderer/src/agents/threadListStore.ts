import { useCallback, useSyncExternalStore } from 'react'

const NONE: readonly never[] = []

/**
 * Items waiting on each thread's composer for its next prompt, held in this window's memory only: review comments and
 * reply quotes. A prompt carries at most `max` of them; they come off when removed or sent.
 */
export class ThreadListStore<T extends { readonly id: string }> {
  private readonly threads = new Map<string, readonly T[]>()
  private readonly listeners = new Set<() => void>()
  constructor(private readonly max: number) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  list(threadId: string): readonly T[] { return this.threads.get(threadId) ?? NONE }

  /** Whether the thread's next prompt can carry another. */
  full(threadId: string): boolean { return this.list(threadId).length >= this.max }

  remove(threadId: string, id: string): void { this.without(threadId, [id]) }

  /** Take these off the composer: their prompt has gone, and they went with it. */
  sent(threadId: string, ids: readonly string[]): void { this.without(threadId, ids) }

  /** Adds one at the end, unless the prompt is full. */
  protected append(threadId: string, item: T): T | null {
    if (this.full(threadId)) return null
    this.threads.set(threadId, [...this.list(threadId), item])
    this.emit()
    return item
  }

  protected emit(): void { for (const listener of [...this.listeners]) listener() }

  private without(threadId: string, ids: readonly string[]): void {
    const current = this.list(threadId)
    const next = current.filter(item => !ids.includes(item.id))
    if (next.length === current.length) return
    if (next.length === 0) this.threads.delete(threadId)
    else this.threads.set(threadId, next)
    this.emit()
  }
}

export function useThreadList<T extends { readonly id: string }>(store: ThreadListStore<T>, threadId: string | null): readonly T[] {
  const read = useCallback(() => threadId === null ? NONE : store.list(threadId), [store, threadId])
  return useSyncExternalStore(store.subscribe, read)
}
