import { randomUUID } from 'node:crypto'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { TO_DOS_MAX, toDoAddSchema, toDoListSchema, type ToDo, type ToDoAddInput, type ToDoRequest } from '../../shared/toDos'

const FILE = 'to-dos.json'
const savedSchema = z.object({ items: toDoListSchema }).strict()
type Saved = z.infer<typeof savedSchema>

/** Why a press or an add changed nothing, in words the caller can act on. */
export class ToDoRefused extends Error {}

export interface ToDoStoreOptions {
  readonly directory: string
  /** Whether Keep local history is on: the words are saved only then, as Watcher's kept lines are (ADR-0188, decision 8). */
  readonly historyEnabled: () => boolean
  /** Tells a thread that waits on a to-do. It resolves for a thread that takes no news, such as a settled one, and rejects when the news could not be kept. */
  readonly told: (threadId: string, title: string, didNotWork: string | undefined) => Promise<void>
  /** A prototype waiting for review, as a to-do of its own kind (ADR-0188, decision 10). Never saved. */
  readonly madeItems?: () => readonly ToDo[]
  /** Its to-do was checked off: the mark is let go. */
  readonly madeItemChecked?: (id: string) => boolean
  /** The list was opened: what it made is new no longer. True when that changed anything. */
  readonly madeItemsSeen?: () => boolean
  readonly clock?: () => number
}

/**
 * One computer's to-dos (ADR-0188). A thread, Watcher or the user adds one; a check-off takes it off and tells a thread
 * that said it waits. It reads without copying, because a client's connection reads it on every change.
 */
export class ToDoStore {
  private items: readonly ToDo[] = []
  private readonly store: AtomicJsonStore<Saved>
  private readonly listeners = new Set<() => void>()
  private tail: Promise<unknown> = Promise.resolve()
  private unread = false
  /** What a to-do's thread has heard, while saving its check-off has not succeeded yet. Held here, since the save is what failed. */
  private readonly toldOf = new Map<string, { readonly didNotWork: string | undefined }>()
  private readonly clock: () => number
  private shown: { items: readonly ToDo[]; made: readonly ToDo[]; view: readonly ToDo[] } | undefined
  constructor(private readonly options: ToDoStoreOptions) {
    this.clock = options.clock ?? Date.now
    this.store = new AtomicJsonStore(join(options.directory, FILE), input => savedSchema.parse(input), () => ({ items: [] }))
    void this.inTurn(async () => {
      if (options.historyEnabled()) { this.items = (await this.store.read()).items; this.changed() } else await this.removeSaved()
    }).catch(() => { this.unread = true })
  }
  /** The saved list could not be read yet, so what `view` shows is no sign of what is saved. The next press reads it again. */
  get notRead(): boolean { return this.unread }
  /** Every to-do this computer holds, the oldest first, with the prototypes waiting for review after them. */
  view(): readonly ToDo[] {
    const made = this.options.madeItems?.() ?? NONE, shown = this.shown
    if (shown && shown.items === this.items && shown.made === made) return shown.view
    const view = made.length ? [...this.items, ...made] : this.items
    this.shown = { items: this.items, made, view }
    return view
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  /** The open to-do with these words from this source, if there is one: adding it again would change nothing. */
  open(title: string, by: 'thread' | 'watcher', threadId?: string): ToDo | undefined { return this.items.find(item => item.title === title && item.threadId === threadId && item.by === by) }
  /** Something a client sees changed from outside the list, such as a prototype's mark. */
  madeItemsChanged(): void { this.changed() }
  /** Adds one for a thread or Watcher. Words the same source has open change nothing, so a retry is safe. */
  add(input: ToDoAddInput, by: 'thread' | 'watcher', threadId?: string): Promise<ToDo> {
    const parsed = toDoAddSchema.parse(input)
    return this.change(items => {
      const open = items.find(item => item.title === parsed.title && item.threadId === threadId && item.by === by)
      if (open) return { items, result: open }
      const item: ToDo = { id: randomUUID(), title: parsed.title, ...parsed.why ? { why: parsed.why } : {}, ...parsed.link ? { link: parsed.link } : {},
        ...parsed.steps ? { steps: parsed.steps } : {}, ...threadId ? { threadId } : {}, by, waits: threadId !== undefined && parsed.waits, seen: false, addedAt: new Date(this.clock()).toISOString() }
      return { items: [...items, item], result: item }
    })
  }
  /** A press on this computer's list, from any client. */
  request(request: ToDoRequest): Promise<void> {
    if (request.kind === 'add') {
      return this.change(items => {
        // The user's own is not new to them, so it does not light the badge.
        const item: ToDo = { id: randomUUID(), title: request.title, by: 'user', waits: false, seen: true, addedAt: new Date(this.clock()).toISOString() }
        return { items: [...items, item], result: undefined }
      })
    }
    if (request.kind === 'seen') {
      if (this.options.madeItemsSeen?.()) this.changed()
      return this.change(items => ({ items: items.some(item => !item.seen) ? items.map(item => item.seen ? item : { ...item, seen: true }) : items, result: undefined }))
    }
    return this.check(request.id, request.didNotWork)
  }
  private async check(id: string, didNotWork: string | undefined): Promise<void> {
    if (this.options.madeItems?.().some(item => item.id === id)) {
      this.options.madeItemChecked?.(id)
      this.changed()
      return
    }
    await this.inTurn(async () => {
      await this.ensureRead()
      const item = this.items.find(entry => entry.id === id)
      // A second press finds nothing, and tells nobody twice.
      if (!item) return
      // Told first: news that cannot be saved or sent leaves the item standing, and the press says so. A save that fails
      // after that leaves it standing too, and the next press retries the save without saying the same thing twice. Words
      // the user has only now written are new, so they still go.
      const heard = this.toldOf.get(item.id)
      if (item.waits && item.threadId && (!heard || (didNotWork !== undefined && didNotWork !== heard.didNotWork))) {
        await this.options.told(item.threadId, item.title, didNotWork)
        this.toldOf.set(item.id, { didNotWork })
      }
      await this.write(this.items.filter(entry => entry !== item))
      this.toldOf.delete(item.id)
    })
  }
  /** Keep local history changed: turned off, nothing stays on disk; turned on, what is held now is saved. */
  privacyChanged(): Promise<void> {
    return this.inTurn(async () => {
      if (this.options.historyEnabled()) await this.store.write({ items: [...this.items] })
      else await this.removeSaved()
    })
  }
  private async ensureRead(): Promise<void> {
    if (!this.unread) return
    if (this.options.historyEnabled()) this.items = (await this.store.read()).items
    this.unread = false
  }
  private async write(items: readonly ToDo[]): Promise<void> {
    if (this.options.historyEnabled()) await this.store.write({ items: [...items] })
    else await this.removeSaved()
    this.items = items
    this.changed()
  }
  private change<T>(work: (items: readonly ToDo[]) => { items: readonly ToDo[]; result: T }): Promise<T> {
    return this.inTurn(async () => {
      await this.ensureRead()
      const { items, result } = work(this.items)
      if (items === this.items) return result
      if (items.length > TO_DOS_MAX) throw new ToDoRefused(`The to-do list already holds ${TO_DOS_MAX} items. Nothing was added. Ask the user to check some off.`)
      await this.write(items)
      return result
    })
  }
  private changed(): void {
    for (const listener of [...this.listeners]) { try { listener() } catch { /* A listener's failure is its own. */ } }
  }
  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(work)
    this.tail = next
    return next
  }
  private async removeSaved(): Promise<void> {
    const names = await readdir(this.options.directory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]
      throw error
    })
    await Promise.all(names.filter(name => name === FILE || name.startsWith(`${FILE}.`)).map(name => unlink(join(this.options.directory, name)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })))
  }
  /** Waits for what was asked so far to finish, for closing. */
  async drain(): Promise<void> { await this.tail.catch(() => undefined) }
}
const NONE: readonly ToDo[] = []
