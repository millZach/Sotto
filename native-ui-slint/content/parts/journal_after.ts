import { appendFile, open, rename, stat, truncate } from 'node:fs/promises'
import { join } from 'node:path'

export interface ShelfEntry {
  id: string
  title: string
  updatedAt: number
  size: number
}

export interface ShelfOptions {
  folder: string
  maxEntries: number
  /** Fold the journal into the snapshot after this many appended lines. */
  compactAfter: number
}

type JournalLine =
  | { op: 'put'; entry: ShelfEntry }
  | { op: 'remove'; id: string }
  | { op: 'clear' }

const SHELF_FILE = 'shelf.json'
const JOURNAL_FILE = 'shelf.journal'

export class Shelf {
  private entries = new Map<string, ShelfEntry>()
  private pending: JournalLine[] = []
  private journalLines = 0

  constructor(private readonly options: ShelfOptions) {}

  async load(): Promise<void> {
    await this.loadSnapshot()
    await this.replayJournal()
  }

  private async loadSnapshot(): Promise<void> {
    const path = join(this.options.folder, SHELF_FILE)
    const handle = await open(path, 'r')
    try {
      const text = await handle.readFile({ encoding: 'utf8' })
      const list = JSON.parse(text) as ShelfEntry[]
      for (const entry of list) {
        this.entries.set(entry.id, entry)
      }
    } finally {
      await handle.close()
    }
  }

  private async replayJournal(): Promise<void> {
    const path = join(this.options.folder, JOURNAL_FILE)
    let text = ''
    try {
      text = await (await open(path, 'r')).readFile({ encoding: 'utf8' })
    } catch {
      return
    }
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue
      let line: JournalLine
      try {
        line = JSON.parse(raw) as JournalLine
      } catch {
        // A torn last line from a crash mid-append: everything before it stands.
        break
      }
      this.apply(line)
      this.journalLines += 1
    }
  }

  private apply(line: JournalLine): void {
    switch (line.op) {
      case 'put':
        this.entries.set(line.entry.id, line.entry)
        break
      case 'remove':
        this.entries.delete(line.id)
        break
      case 'clear':
        this.entries.clear()
        break
    }
  }

  get(id: string): ShelfEntry | undefined {
    return this.entries.get(id)
  }

  put(entry: ShelfEntry): void {
    this.record({ op: 'put', entry })
    if (this.entries.size > this.options.maxEntries) {
      this.evictOldest()
    }
  }

  remove(id: string): boolean {
    if (!this.entries.has(id)) {
      return false
    }
    this.record({ op: 'remove', id })
    return true
  }

  private record(line: JournalLine): void {
    this.apply(line)
    this.pending.push(line)
  }

  private evictOldest(): void {
    let oldest: ShelfEntry | undefined
    for (const entry of this.entries.values()) {
      if (!oldest || entry.updatedAt < oldest.updatedAt) {
        oldest = entry
      }
    }
    if (oldest) {
      this.record({ op: 'remove', id: oldest.id })
    }
  }

  async save(): Promise<void> {
    if (this.pending.length === 0) {
      return
    }
    const lines = this.pending.map((line) => JSON.stringify(line)).join('\n') + '\n'
    this.pending = []
    await appendFile(join(this.options.folder, JOURNAL_FILE), lines)
    this.journalLines += lines.split('\n').length - 1
    if (this.journalLines >= this.options.compactAfter) {
      await this.compact()
    }
  }

  private async compact(): Promise<void> {
    const path = join(this.options.folder, SHELF_FILE)
    const temp = `${path}.tmp`
    const list = [...this.entries.values()]
    const handle = await open(temp, 'w')
    try {
      await handle.writeFile(JSON.stringify(list, null, 2))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
    await truncate(join(this.options.folder, JOURNAL_FILE), 0)
    this.journalLines = 0
  }

  async sizeOnDisk(): Promise<number> {
    const snapshot = await stat(join(this.options.folder, SHELF_FILE))
    const journal = await stat(join(this.options.folder, JOURNAL_FILE)).catch(() => ({ size: 0 }))
    return snapshot.size + journal.size
  }

  list(): ShelfEntry[] {
    return [...this.entries.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  count(): number {
    return this.entries.size
  }

  clear(): void {
    this.record({ op: 'clear' })
  }
}
