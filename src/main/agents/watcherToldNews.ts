import { join } from 'node:path'
import { z } from 'zod'
import { watcherEventSchema, type WatcherEvent } from '../../shared/watcherNews'
import { AtomicJsonStore } from '../storage/atomicJsonStore'

const FILE = 'watcher-told.json'
/** Far more than three messages per thread every ten minutes can leave waiting while Watcher rests or works. */
const KEPT_MAX = 200
const fileSchema = z.object({ version: z.literal(1), events: z.array(watcherEventSchema).max(KEPT_MAX) }).strict()
type File = z.infer<typeof fileSchema>
const empty = (): File => ({ version: 1, events: [] })

/**
 * Each thread's message for Watcher that Watcher has not been told (ADR-0073, November 2, 2026). Other news is observed
 * afresh after a restart. This cannot be: nothing else holds the words, and the thread was told they got through, so they
 * are saved before it is told. Follows Keep local history, as Watcher's state does: with it off they stay in memory.
 */
export class WatcherToldNews {
  private readonly store: AtomicJsonStore<File>
  private events: WatcherEvent[] = []
  private tail: Promise<unknown> = Promise.resolve()
  constructor(directory: string, private readonly historyEnabled: () => boolean) {
    this.store = new AtomicJsonStore(join(directory, FILE), input => fileSchema.parse(input), empty)
  }
  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(work)
    this.tail = next
    return next
  }
  /** What was saved and not told. A file that cannot be read gives none: it holds nothing else that matters. */
  load(): Promise<readonly WatcherEvent[]> {
    return this.inTurn(async () => {
      this.events = this.historyEnabled() ? (await this.store.read().catch(empty)).events : []
      return this.events
    })
  }
  private save(): Promise<void> {
    return this.historyEnabled() ? this.store.write({ version: 1, events: this.events }) : Promise.resolve()
  }
  add(event: WatcherEvent): Promise<void> {
    return this.inTurn(async () => {
      this.events = [...this.events, event].slice(-KEPT_MAX)
      await this.save()
    })
  }
  /** Told, or sent in a way that is never sent twice. */
  forget(ids: ReadonlySet<string>): Promise<void> {
    return this.inTurn(async () => {
      if (!this.events.some(event => ids.has(event.id))) return
      this.events = this.events.filter(event => !ids.has(event.id))
      await this.save()
    })
  }
}
