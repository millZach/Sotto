import { z } from 'zod'

import {
  historyEntrySchema,
  parseHistoryEntry,
  type HistoryEntry,
} from '../../shared/history'
import { AtomicJsonStore } from './atomicJsonStore'

const historySchema = z.array(historyEntrySchema)

export interface HistoryRepositoryOptions {
  now?: () => number
  store?: AtomicJsonStore<HistoryEntry[]>
}

export interface AddHistoryOptions {
  enabled: boolean
  retention: number | 'unlimited'
}

function cloneEntries(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return entries.map((entry) => ({ ...entry }))
}

function sortEntries(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return cloneEntries(entries).sort((left, right) => {
    const timestampOrder = right.createdAt - left.createdAt
    if (timestampOrder !== 0) {
      return timestampOrder
    }

    if (left.id < right.id) {
      return -1
    }
    if (left.id > right.id) {
      return 1
    }
    return 0
  })
}

function applyRetention(
  entries: readonly HistoryEntry[],
  retention: number | 'unlimited',
): HistoryEntry[] {
  if (retention === 'unlimited') {
    return cloneEntries(entries)
  }
  if (!Number.isFinite(retention)) {
    throw new TypeError('History retention must be finite or unlimited')
  }

  return cloneEntries(entries).slice(0, Math.max(0, Math.trunc(retention)))
}

export class HistoryRepository {
  private readonly store: AtomicJsonStore<HistoryEntry[]>
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(filePath: string, options: HistoryRepositoryOptions = {}) {
    this.store =
      options.store ??
      new AtomicJsonStore(
        filePath,
        (input) => historySchema.parse(input),
        () => [],
        options.now ?? Date.now,
      )
  }

  async list(): Promise<HistoryEntry[]> {
    await this.mutationTail
    return cloneEntries(await this.readSorted())
  }

  add(entry: HistoryEntry, options: AddHistoryOptions): Promise<HistoryEntry[]> {
    return this.enqueueMutation(async () => {
      const parsedEntry = parseHistoryEntry(entry)
      const current = await this.readSorted()

      if (!options.enabled) {
        return cloneEntries(current)
      }

      const withoutReplacement = current.filter((candidate) => candidate.id !== parsedEntry.id)
      const sorted = sortEntries([...withoutReplacement, parsedEntry])
      const retained = applyRetention(sorted, options.retention)
      await this.store.write(retained)
      return cloneEntries(retained)
    })
  }

  async search(query: string): Promise<HistoryEntry[]> {
    const entries = await this.list()
    const normalizedQuery = query.trim().toLowerCase()

    if (normalizedQuery.length === 0) {
      return entries
    }

    return cloneEntries(
      entries.filter((entry) => entry.text.toLowerCase().includes(normalizedQuery)),
    )
  }

  delete(id: string): Promise<boolean> {
    return this.enqueueMutation(async () => {
      const current = await this.readSorted()
      const remaining = current.filter((entry) => entry.id !== id)

      if (remaining.length === current.length) {
        return false
      }

      await this.store.write(remaining)
      return true
    })
  }

  clear(): Promise<void> {
    return this.enqueueMutation(async () => {
      if (!(await this.store.exists())) {
        return
      }

      await this.store.read()
      await this.store.write([])
    })
  }

  async exists(): Promise<boolean> {
    await this.mutationTail
    return this.store.exists()
  }

  private async readSorted(): Promise<HistoryEntry[]> {
    return sortEntries(await this.store.read())
  }

  private enqueueMutation<Result>(mutation: () => Promise<Result>): Promise<Result> {
    const operation = this.mutationTail.then(mutation)
    this.mutationTail = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }
}
