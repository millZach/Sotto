import { open, rename, stat } from 'node:fs/promises'
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
}

const SHELF_FILE = 'shelf.json'

export class Shelf {
  private entries = new Map<string, ShelfEntry>()
  private dirty = false

  constructor(private readonly options: ShelfOptions) {}

  async load(): Promise<void> {
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

  get(id: string): ShelfEntry | undefined {
    return this.entries.get(id)
  }

  put(entry: ShelfEntry): void {
    this.entries.set(entry.id, entry)
    this.dirty = true
    if (this.entries.size > this.options.maxEntries) {
      this.evictOldest()
    }
  }

  remove(id: string): boolean {
    const removed = this.entries.delete(id)
    if (removed) {
      this.dirty = true
    }
    return removed
  }

  private evictOldest(): void {
    let oldest: ShelfEntry | undefined
    for (const entry of this.entries.values()) {
      if (!oldest || entry.updatedAt < oldest.updatedAt) {
        oldest = entry
      }
    }
    if (oldest) {
      this.entries.delete(oldest.id)
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) {
      return
    }
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
    this.dirty = false
  }

  async sizeOnDisk(): Promise<number> {
    const path = join(this.options.folder, SHELF_FILE)
    const info = await stat(path)
    return info.size
  }

  list(): ShelfEntry[] {
    return [...this.entries.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  count(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
    this.dirty = true
  }
}
