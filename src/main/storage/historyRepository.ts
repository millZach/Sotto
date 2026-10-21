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
   * Removes stale temporary files and, while there is no records file, writes a record for every saved transcript so
   * stats do not start empty after an upgrade. Once the file is there it is never filled from transcripts again, and
   * after Clear history there are no transcripts to fill it from.
   */
  initialize(): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.removeSiblings(this.filePath, false)
      await this.removeSiblings(this.recordsPath, false)
      try {
        await this.backfillRecords()
      } catch {
        this.records = null
        this.options.log?.('dictation-records-backfill-failed')
      }
    })
  }

  /** Every saved transcript, newest first, whether or not Keep local history is on now. */
  async list(): Promise<HistoryEntry[]> {
    await this.mutationTail
    return cloneEntries(await this.readSorted())
  }

  /** Every dictation record, newest first. */
  listRecords(): Promise<DictationRecord[]> {
    return this.enqueueMutation(async () => [...(await this.loadRecords()).values()].sort(byNewest))
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

  /** Deletes everything about one dictation: its transcript and its record. False when neither was here. */
  delete(id: string): Promise<boolean> {
    return this.enqueueMutation(async () => {
      const current = await this.readSorted()
      const remaining = current.filter((entry) => entry.id !== id)
      const transcriptRemoved = remaining.length !== current.length
      if (transcriptRemoved) await this.store.write(remaining)

      const records = await this.loadRecords()
      if (!records.has(id)) return transcriptRemoved
      const kept = new Map(records)
      kept.delete(id)
      await this.rewriteRecords(kept)
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

  private async backfillRecords(): Promise<void> {
    if (await this.readRecordsFile() !== null) return
    const transcripts = await this.store.read()
    const records = new Map<string, DictationRecord>()
    for (const entry of [...transcripts].sort(byNewest).reverse()) records.set(entry.id, dictationRecordOf(entry))
    if (records.size > 0) await this.rewriteRecords(records)
    else this.records = records
  }

  private async loadRecords(): Promise<Map<string, DictationRecord>> {
    if (this.records !== null) return this.records
    this.records = await this.readRecordsFile() ?? new Map()
    return this.records
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
    this.records = records
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
