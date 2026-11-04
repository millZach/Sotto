import { createHash } from 'node:crypto'
import type { PrototypeReady } from '../../shared/agents'
import { TO_DOS_MADE_MAX, type ToDo } from '../../shared/toDos'

/** What a client shows until it puts its own words on it: a prototype's to-do is Sotto's, not a thread's. */
export const PROTOTYPE_TO_DO_TITLE = 'Review the prototype'

/**
 * A prototype waiting for review as a to-do of its own kind (ADR-0188, decision 10): made from each thread's Prototype ready
 * mark (ADR-0108) and never saved, so the mark stays the one record of it. It is worked out when a list is read, and only
 * after a mark changed, never on an update. What has been seen lasts until a restart.
 */
export class PrototypeToDos {
  private items: readonly ToDo[] = []
  private stale = false
  private scheduled = false
  private readonly seen = new Set<string>()
  private readonly addedAt = new Map<string, string>()
  private readonly tokens = new Map<string, string>()
  constructor(private readonly marks: () => ReadonlyMap<string, PrototypeReady>, private readonly opened: (token: string) => void,
    private readonly changed: () => void, private readonly clock: () => number = Date.now) {}
  /** A mark changed, on the update path: noted, and the list is told once, after the update. */
  markChanged(): void {
    this.stale = true
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => { this.scheduled = false; this.changed() })
  }
  /** Keeps its identity until a mark or what was seen changes, which is how the list knows nothing changed. */
  view(): readonly ToDo[] {
    if (!this.stale) return this.items
    this.stale = false
    const items: ToDo[] = [], addedAt = new Map<string, string>()
    this.tokens.clear()
    for (const [threadId, mark] of this.marks()) {
      const id = `prototype-${createHash('sha256').update(`${threadId}\n${mark.source}`).digest('hex').slice(0, 40)}`
      const at = this.addedAt.get(id) ?? new Date(this.clock()).toISOString()
      addedAt.set(id, at)
      this.tokens.set(id, mark.pages[0]!.token)
      items.push({ id, title: PROTOTYPE_TO_DO_TITLE, threadId, by: 'prototype', waits: false, seen: this.seen.has(id), addedAt: at })
    }
    this.addedAt.clear()
    for (const [id, at] of addedAt) this.addedAt.set(id, at)
    for (const id of this.seen) if (!addedAt.has(id)) this.seen.delete(id)
    this.items = items.slice(-TO_DOS_MADE_MAX)
    return this.items
  }
  /** Checked off: reviewed, as opening one of its pages is, so its mark clears on every client. */
  checked(id: string): boolean {
    this.view()
    const token = this.tokens.get(id)
    if (token === undefined) return false
    this.opened(token)
    return true
  }
  /** The list was opened. True when something was new. */
  allSeen(): boolean {
    const fresh = this.view().filter(item => !item.seen)
    if (!fresh.length) return false
    for (const item of fresh) this.seen.add(item.id)
    this.stale = true
    return true
  }
}
