import { readdir, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { z } from 'zod'

import {
  historyEntrySchema,
  parseHistoryEntry,
  type HistoryEntry,
} from '../../shared/history'
import { AtomicJsonStore } from './atomicJsonStore'
import { retryWindowsFileOperation } from './windowsFileRetry'
import type { RecoveryNotice } from '../../shared/recoveryNotice'

const historySchema = z.array(historyEntrySchema)

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export interface HistoryRepositoryOptions {
  now?: () => number
  store?: AtomicJsonStore<HistoryEntry[]>
  onRecovery?: (notice: RecoveryNotice) => void
  log?: (event: 'history-temp-cleanup-failed') => void
}

export interface AddHistoryOptions {
  readonly enabled: boolean
  readonly retention: number | 'unlimited'
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

  constructor(
    private readonly filePath: string,
    private readonly options: HistoryRepositoryOptions = {},
  ) {
    this.store =
      options.store ??
      new AtomicJsonStore(
        filePath,
        (input) => historySchema.parse(input),
        () => [],
        options.now ?? Date.now,
        undefined,
        () => options.onRecovery?.({ code: 'HISTORY_RECOVERED' }),
      )
  }

  initialize(): Promise<void> {
    return this.enqueueMutation(() => this.removeSiblings(false))
  }

  async list(options: { readonly enabled: boolean } = { enabled: true }): Promise<HistoryEntry[]> {
    if (!options.enabled) return []
    await this.mutationTail
    return cloneEntries(await this.readSorted())
  }

  async add(entry: HistoryEntry, options: AddHistoryOptions): Promise<HistoryEntry[]> {
    const parsedEntry = parseHistoryEntry(entry)
    const { enabled, retention } = options

    return this.enqueueMutation(async () => {
      if (!enabled) {
        return []
      }

      const current = await this.readSorted()
      const withoutReplacement = current.filter((candidate) => candidate.id !== parsedEntry.id)
      const sorted = sortEntries([...withoutReplacement, parsedEntry])
      const retained = applyRetention(sorted, retention)
      await this.store.write(retained)
      return cloneEntries(retained)
    })
  }

  async search(
    query: string,
    options: { readonly enabled: boolean } = { enabled: true },
  ): Promise<HistoryEntry[]> {
    const entries = await this.list(options)
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
      if (await this.store.exists()) {
        await this.store.read()
        await this.store.write([])
      }

      await this.removeSiblings(true)
    })
  }

  async exists(): Promise<boolean> {
    await this.mutationTail
    return this.store.exists()
  }

  private async readSorted(): Promise<HistoryEntry[]> {
    return sortEntries(await this.store.read())
  }

  private async removeSiblings(includeRecovery: boolean): Promise<void> {
    const directory = dirname(this.filePath)
    const recoveryPrefix = `${basename(this.filePath)}.corrupt-`
    const temporaryPrefix = `${basename(this.filePath)}.tmp-`
    let siblingNames: string[]

    try {
      siblingNames = await retryWindowsFileOperation(() => readdir(directory))
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return
      }

      if (includeRecovery) throw error
      this.options.log?.('history-temp-cleanup-failed')
      return
    }

    await Promise.all(
      siblingNames
        .filter((name) => (name.startsWith(temporaryPrefix) && /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name.slice(temporaryPrefix.length)))
          || (includeRecovery && name.startsWith(recoveryPrefix)))
        .map(async (name) => {
          try {
            await retryWindowsFileOperation(() => unlink(join(directory, name)))
          } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) {
              if (includeRecovery) throw error
              this.options.log?.('history-temp-cleanup-failed')
            }
          }
        }),
    )
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
