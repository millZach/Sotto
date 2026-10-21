import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { z } from 'zod'

import {
  historyEntrySchema,
  parseHistoryEntry,
  type HistoryEntry,
} from '../../shared/history'
import { countWords, dictationRecordSchema, type DictationRecord } from '../../shared/dictationRecord'
import { AtomicJsonStore } from './atomicJsonStore'
import { retryWindowsFileOperation } from './windowsFileRetry'
import type { RecoveryNotice } from '../../shared/recoveryNotice'

const historySchema = z.array(historyEntrySchema)

/** The dictation records' file name beside `history.json` (ADR-0100). */
export const DICTATION_RECORDS_FILE = 'dictation-records.jsonl'

/** Stable event names; the only trace history storage leaves in the log. */
export type HistoryLogEvent =
  | 'history-temp-cleanup-failed'
  | 'dictation-record-not-saved'
  | 'dictation-records-backfill-failed'
  | 'dictation-records-lines-skipped'

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export interface HistoryRepositoryOptions {
  now?: () => number
  store?: AtomicJsonStore<HistoryEntry[]>
  /** Where the dictation records live; `dictation-records.jsonl` beside the history file when unset. */
  recordsPath?: string
  onRecovery?: (notice: RecoveryNotice) => void
  log?: (event: HistoryLogEvent) => void
}

export interface AddHistoryOptions {
  /** Keep local history: whether the transcript's text is saved. The dictation record is kept either way. */
  readonly enabled: boolean
  readonly retention: number | 'unlimited'
}

function cloneEntries(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return entries.map((entry) => ({ ...entry }))
}

function byNewest(left: { createdAt: number; id: string }, right: { createdAt: number; id: string }): number {
  const timestampOrder = right.createdAt - left.createdAt
  if (timestampOrder !== 0) return timestampOrder
  if (left.id < right.id) return -1
  if (left.id > right.id) return 1
  return 0
}

function sortEntries(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return cloneEntries(entries).sort(byNewest)
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

/** The numbers a transcript stands for: what a dictation record keeps of it. */
export function dictationRecordOf(entry: HistoryEntry): DictationRecord {
  return Object.freeze({
    id: entry.id,
    createdAt: entry.createdAt,
    durationMs: entry.durationMs,
    words: countWords(entry.text),
    ...(entry.app === undefined ? {} : { app: entry.app }),
  })
}

const TEMPORARY_SUFFIX = /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Dictation history on this computer: transcripts in `history.json`, and a dictation record for every finished
 * dictation in `dictation-records.jsonl` (ADR-0100). Keep local history decides only whether a transcript's text is
 * saved; retention trims transcripts and never records. Deleting a transcript deletes its record, and Clear history
 * deletes every transcript and the records file.
 *
 * Records are appended one line at a time, so saving a dictation costs the same however many came before; deleting one
 * rewrites the file. Main holds the records it read, so listing them reads nothing from disk.
 */
export class HistoryRepository {
  private readonly store: AtomicJsonStore<HistoryEntry[]>
  private readonly recordsPath: string
  private mutationTail: Promise<void> = Promise.resolve()
  /** The records as the file holds them, newest last, once read. */
  private records: Map<string, DictationRecord> | null = null
  /** False when the file read ends partway through a line, so the next record starts on a line of its own. */
  private recordsEndInNewline = true

  constructor(
    private readonly filePath: string,
    private readonly options: HistoryRepositoryOptions = {},
  ) {
    this.recordsPath = options.recordsPath ?? join(dirname(filePath), DICTATION_RECORDS_FILE)
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

  /**
   * Removes stale temporary files and reads the records, filling them from the saved transcripts when there is no
   * records file yet (see `loadRecords`), so stats do not start empty after an upgrade.
   */
  initialize(): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.removeSiblings(this.filePath, false)
      await this.removeSiblings(this.recordsPath, false)
      try {
        await this.loadRecords()
      } catch {
        this.options.log?.('dictation-records-backfill-failed')
      }
    })
  }

  /**
   * Every saved transcript, newest first, whether or not Keep local history is on now. While it is off
   * (`enabled: false`) the file is only read: a corrupt one is not recovered, backed up or reported.
   */
  async list(options: { readonly enabled: boolean } = { enabled: true }): Promise<HistoryEntry[]> {
    await this.mutationTail
    return options.enabled ? cloneEntries(await this.readSorted()) : sortEntries(await this.store.peek())
  }

  /** Every dictation record, newest first. */
  listRecords(): Promise<DictationRecord[]> {
    return this.enqueueMutation(async () => [...(await this.loadRecords()).values()].sort(byNewest))
  }

  /** One dictation's record, or null when it has none. */
  getRecord(id: string): Promise<DictationRecord | null> {
    return this.enqueueMutation(async () => (await this.loadRecords()).get(id) ?? null)
  }

  /**
   * Keeps the dictation's record, and its transcript only while Keep local history is on. Answers the saved
   * transcripts, which with history off are the ones kept from before it was turned off. A record that cannot be saved
   * is logged and does not fail the transcript.
   */
  async add(entry: HistoryEntry, options: AddHistoryOptions): Promise<HistoryEntry[]> {
    const parsedEntry = parseHistoryEntry(entry)
    const { enabled, retention } = options

    return this.enqueueMutation(async () => {
      try {
        await this.appendRecord(dictationRecordOf(parsedEntry))
      } catch {
        this.options.log?.('dictation-record-not-saved')
      }

      // With history off the transcripts are only read, never recovered or rewritten: a corrupt file stays as it is.
      if (!enabled) return sortEntries(await this.store.peek())

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

  /**
   * Deletes everything about one dictation: its record, then its transcript. False when neither was here. The record
   * goes first, so if deleting the transcript fails, the transcript is still listed and deleting it again finishes.
   */
  delete(id: string): Promise<boolean> {
    return this.enqueueMutation(async () => {
      const records = await this.loadRecords()
      const recordRemoved = records.has(id)
      if (recordRemoved) {
        const kept = new Map(records)
        kept.delete(id)
        await this.rewriteRecords(kept)
      }

      const current = await this.readSorted()
      const remaining = current.filter((entry) => entry.id !== id)
      if (remaining.length === current.length) return recordRemoved
      await this.store.write(remaining)
      return true
    })
  }

  /** Deletes every transcript and every dictation record, with their backups and temporary files. */
  clear(): Promise<void> {
    return this.enqueueMutation(async () => {
      if (await this.store.exists()) {
        await this.store.read()
        await this.store.write([])
      }
      await retryWindowsFileOperation(() => unlink(this.recordsPath)).catch((error: unknown) => {
        if (!hasErrorCode(error, 'ENOENT')) throw error
      })
      this.records = new Map()
      this.recordsEndInNewline = true

      await this.removeSiblings(this.filePath, true)
      await this.removeSiblings(this.recordsPath, true)
    })
  }

  async exists(): Promise<boolean> {
    await this.mutationTail
    return this.store.exists()
  }

  private async readSorted(): Promise<HistoryEntry[]> {
    return sortEntries(await this.store.read())
  }

  /**
   * The records, read once. With no records file yet, they are filled from the saved transcripts first: on the first
   * start after an upgrade, or on a later read when that start could not write them, so a record appended in the
   * meantime never shuts the saved transcripts out. Once the file is there it is never filled again, and after Clear
   * history there are no transcripts to fill it from. Transcripts are only read here, never recovered.
   */
  private async loadRecords(): Promise<Map<string, DictationRecord>> {
    if (this.records !== null) return this.records
    const read = await this.readRecordsFile()
    if (read !== null) {
      this.records = read
      return read
    }
    const records = new Map<string, DictationRecord>()
    for (const entry of [...await this.store.peek()].sort(byNewest).reverse()) records.set(entry.id, dictationRecordOf(entry))
    if (records.size > 0) await this.rewriteRecords(records)
    else this.records = records
    return records
  }

  /** The records file's records, a later line for the same id winning; null when there is no file. */
  private async readRecordsFile(): Promise<Map<string, DictationRecord> | null> {
    let text: string
    try {
      text = await readFile(this.recordsPath, 'utf8')
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return null
      throw error
    }
    const records = new Map<string, DictationRecord>()
    let skipped = false
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        const record = dictationRecordSchema.parse(JSON.parse(line))
        records.delete(record.id)
        records.set(record.id, Object.freeze(record))
      } catch {
        // A line cut short by a crash, or edited by hand, costs only that dictation's numbers.
        skipped = true
      }
    }
    if (skipped) this.options.log?.('dictation-records-lines-skipped')
    this.recordsEndInNewline = text.length === 0 || text.endsWith('\n')
    return records
  }

  private async appendRecord(record: DictationRecord): Promise<void> {
    const records = await this.loadRecords()
    await mkdir(dirname(this.recordsPath), { recursive: true })
    const line = `${this.recordsEndInNewline ? '' : '\n'}${JSON.stringify(record)}\n`
    await appendFile(this.recordsPath, line, { encoding: 'utf8', mode: 0o600 })
    this.recordsEndInNewline = true
    records.delete(record.id)
    records.set(record.id, record)
  }

  private async rewriteRecords(records: Map<string, DictationRecord>): Promise<void> {
    const temporaryPath = `${this.recordsPath}.tmp-${process.pid}-${randomUUID()}`
    const text = [...records.values()].map(record => `${JSON.stringify(record)}\n`).join('')
    await mkdir(dirname(this.recordsPath), { recursive: true })
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      try {
        await handle.writeFile(text, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await retryWindowsFileOperation(() => rename(temporaryPath, this.recordsPath))
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
    this.recordsEndInNewline = true
    this.records = records
  }

  private async removeSiblings(filePath: string, includeRecovery: boolean): Promise<void> {
    const directory = dirname(filePath)
    const recoveryPrefix = `${basename(filePath)}.corrupt-`
    const temporaryPrefix = `${basename(filePath)}.tmp-`
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
        .filter((name) => (name.startsWith(temporaryPrefix) && TEMPORARY_SUFFIX.test(name.slice(temporaryPrefix.length)))
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
