import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { copyFile, open, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { fileRelativePathSchema } from '../../shared/files'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { retryWindowsFileOperation } from '../storage/windowsFileRetry'

const fileSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), mode: z.number() }).strict()
export const snapshotSchema = z.object({ files: z.record(fileRelativePathSchema, fileSchema), index: z.string(), head: z.string() }).strict()
export const recordSchema = z.object({ id: z.string().uuid(), threadId: z.string(), workspaceId: z.string(), cwd: z.string(), checkout: z.string().optional(), providerId: z.string(), bindingId: z.string(), createdAt: z.string().datetime(),
  beforeUsers: z.array(z.string()), afterUsers: z.array(z.string()).optional(), before: snapshotSchema, after: snapshotSchema.optional(),
  status: z.enum(['capturing', 'ready', 'reverting', 'uncertain', 'reverted', 'unavailable']), reason: z.string().optional(),
}).strict()
export type CheckpointRecord = z.infer<typeof recordSchema>
export type Snapshot = z.infer<typeof snapshotSchema>

/** `generation` names this write of the file; journal lines written against another one are already in it, or stale. */
const STORAGE_VERSION = 1
const storageSchema = z.object({ version: z.literal(STORAGE_VERSION), generation: z.string().uuid().optional(), records: z.array(recordSchema) }).strict()
const journalLineSchema = z.object({ generation: z.string().uuid(), record: z.unknown() }).strict()
/** The journal is folded into `checkpoints.json` once it outgrows the file, and never before this much. */
const JOURNAL_FOLD_BYTES = 64 * 1024
/** The file's bytes around its records. */
const ENVELOPE_BYTES = Buffer.byteLength(`${JSON.stringify({ version: STORAGE_VERSION, generation: randomUUID(), records: [] }, null, 2)}\n`)
/** A record's bytes inside the stored array, where each is indented four spaces and followed by a separator. */
const recordBytes = (record: CheckpointRecord): number => Buffer.byteLength(JSON.stringify(record, null, 2).split('\n').map(line => `    ${line}`).join('\n')) + 2

/** Recover complete objects even when a later JSON record was cut short. */
function readableRecords(text: string): unknown[] {
  const records: unknown[] = [], starts: number[] = []
  let quoted = false, escaped = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue }
    if (char === '"') { quoted = true; continue }
    if (char === '{') starts.push(i)
    if (char === '}' && starts.length) {
      const start = starts.pop()!
      try {
        const record = recordSchema.safeParse(JSON.parse(text.slice(start, i + 1)))
        if (record.success) records.push(record.data)
      } catch { /* Keep scanning other complete records, even inside an unclosed object. */ }
    }
  }
  return records
}

/**
 * `checkpoints.json` and the journal beside it. A send's records are appended to the journal and synced; every
 * other save rewrites the file under a new generation, which retires the journal. The store knows each record's
 * size in the file so a caller can bound the whole without serializing it.
 */
export class CheckpointStore {
  readonly path: string
  readonly journal: string
  private readonly file: AtomicJsonStore<z.infer<typeof storageSchema>>
  /** The generation the file was last written with; journal lines carry it. */
  private generation: string | undefined
  /** The journal's bytes as this generation's appends left them. Anything past them is stale. */
  private appended = 0
  private fileBytes = 0
  private readonly sizes = new Map<string, number>()

  constructor(directory: string, private readonly report?: (event: string) => void) {
    this.path = join(directory, 'checkpoints.json')
    this.journal = join(directory, 'checkpoints.journal')
    this.file = new AtomicJsonStore(this.path, storageSchema.parse, () => ({ version: STORAGE_VERSION, records: [] }))
  }

  /** The journal's bytes since the file was last written. */
  get journalBytes(): number { return this.appended }

  /**
   * Every saved record, the journal's folded in. A damaged file or journal line is backed up as
   * `checkpoints.json.corrupt-<id>`, named by `setAside`, and the readable records are kept and written back.
   */
  async load(): Promise<{ records: CheckpointRecord[]; setAside?: string }> {
    try { return await this.read() }
    catch (error) {
      if (error instanceof Error && error.message.startsWith('Checkpoint storage at ')) throw error
      throw new Error(`Checkpoint storage at ${this.path} could not be read. No checkpoints were discarded. Restore access to the file and try again.`, { cause: error })
    }
  }

  private async read(): Promise<{ records: CheckpointRecord[]; setAside?: string }> {
    const text = await readFile(this.path, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
    if (text === undefined) return { records: [] }
    let candidates: unknown[], damaged = false, generation: string | undefined
    try {
      const value: unknown = JSON.parse(text)
      if (Array.isArray(value)) candidates = value
      else {
        const parsed = storageSchema.safeParse(value)
        if (parsed.success) { candidates = parsed.data.records; generation = parsed.data.generation }
        else {
          damaged = true; candidates = typeof value === 'object' && value !== null && 'records' in value && Array.isArray(value.records) ? value.records : []
          if (typeof value === 'object' && value !== null && 'generation' in value && typeof value.generation === 'string') generation = value.generation
        }
      }
    } catch {
      damaged = true
      candidates = readableRecords(text)
    }
    const records: CheckpointRecord[] = [], ids = new Set<string>()
    for (const candidate of candidates) {
      const parsed = recordSchema.safeParse(candidate)
      if (parsed.success && !ids.has(parsed.data.id)) { records.push(parsed.data); ids.add(parsed.data.id) }
      else damaged = true
    }
    // Sends since the file was last written are in the journal, newest last.
    const journal = await this.readJournal(generation)
    for (const record of journal.records) {
      const at = records.findIndex(item => item.id === record.id)
      if (at < 0) records.push(record); else records[at] = record
    }
    if (damaged) {
      const backup = this.backupPath()
      try { await copyFile(this.path, backup, constants.COPYFILE_EXCL) }
      catch { throw new Error(`Checkpoint storage at ${this.path} could not be repaired. No checkpoints were discarded. Restore access and try again; the backup could not be saved at ${backup}.`) }
      // Without the file's generation the journal cannot be matched to it, so it is kept beside the backup.
      if (journal.text && generation === undefined) await this.setAsideJournal(journal.text)
      try { await this.write(records) }
      catch { throw new Error(`Checkpoint storage at ${this.path} could not be repaired. The original file is backed up at ${backup}. Restore access to local storage and try again.`) }
      return { records, setAside: backup }
    }
    if (journal.text) {
      const backup = journal.damaged ? await this.setAsideJournal(journal.text) : undefined
      try { await this.write(records) }
      catch { throw new Error(`Checkpoint storage at ${this.path} could not be updated from ${this.journal}. No checkpoints were discarded. Restore access to local storage and try again.`) }
      return { records, ...(backup ? { setAside: backup } : {}) }
    }
    this.generation = generation
    return { records }
  }

  /** Read the journal's complete lines written against `generation`. A line cut short at the end is an append that never finished, before its send went. */
  private async readJournal(generation: string | undefined): Promise<{ text: string; records: CheckpointRecord[]; damaged: boolean }> {
    const text = await readFile(this.journal, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error })
    const records: CheckpointRecord[] = [], lines = text.split('\n')
    let damaged = false
    lines.pop()
    for (const line of lines) {
      if (!line) continue
      let entry: z.infer<typeof journalLineSchema>
      try { const parsed = journalLineSchema.safeParse(JSON.parse(line)); if (!parsed.success) { damaged = true; continue } entry = parsed.data }
      catch { damaged = true; continue }
      if (entry.generation !== generation) continue
      const record = recordSchema.safeParse(entry.record)
      if (record.success) records.push(record.data); else damaged = true
    }
    return { text, records, damaged }
  }

  private backupPath(): string { return `${this.path}.corrupt-${randomUUID()}` }

  /** Keep a journal that cannot be folded whole beside the file, as a damaged file is kept. */
  private async setAsideJournal(text: string): Promise<string> {
    const backup = this.backupPath()
    try { await writeFile(backup, text, { flag: 'wx', mode: 0o600 }) }
    catch { throw new Error(`Checkpoint storage at ${this.journal} could not be repaired. No checkpoints were discarded. Restore access and try again; the backup could not be saved at ${backup}.`) }
    return backup
  }

  /**
   * The file's size holding `records`, from each record's own. A record in `changed` is measured again, and the
   * others keep the size last measured; with no `changed`, as before a whole write, every record is measured,
   * since any may have changed in place.
   */
  measure(records: readonly CheckpointRecord[], changed?: readonly CheckpointRecord[]): number {
    if (changed) for (const record of changed) this.sizes.set(record.id, recordBytes(record))
    // A non-empty array also opens and closes its own lines.
    let bytes = ENVELOPE_BYTES + (records.length ? 2 : 0)
    for (const record of records) {
      const size = (changed ? this.sizes.get(record.id) : undefined) ?? recordBytes(record)
      this.sizes.set(record.id, size); bytes += size
    }
    return bytes
  }

  /** A record's bytes in the file as last measured. */
  sizeOf(id: string): number { return this.sizes.get(id) ?? 0 }

  /** Forget the sizes of records no longer kept. */
  retain(ids: ReadonlySet<string>): void { for (const id of this.sizes.keys()) if (!ids.has(id)) this.sizes.delete(id) }

  /** Whether the next save has to rewrite the file: there is none of this format yet, or the journal has outgrown it. */
  mustRewrite(): boolean { return !this.generation || this.appended > Math.max(JOURNAL_FOLD_BYTES, this.fileBytes) }

  /** Write every record to the file under a new generation, which retires the journal's lines. `bytes` is its size from `measure`. */
  async write(records: readonly CheckpointRecord[], bytes?: number): Promise<void> {
    const generation = randomUUID()
    await this.file.write({ version: STORAGE_VERSION, generation, records: [...records] })
    this.generation = generation
    this.appended = 0
    this.fileBytes = bytes ?? this.measure(records)
    await retryWindowsFileOperation(() => unlink(this.journal)).catch(error => {
      // A journal left behind holds only an older generation's lines, which are ignored and cut off by the next append.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.report?.('checkpoint-cleanup-failed')
    })
  }

  /**
   * Add `records` to the journal and wait until they are on disk. Anything past this generation's earlier appends
   * (a write that failed part-way, or a journal that could not be removed) is cut off first, so a line never lands
   * on a torn one. An append that cannot be completed rewrites the file with `all` instead, which retires the journal.
   */
  async append(records: readonly CheckpointRecord[], all: readonly CheckpointRecord[], bytes?: number): Promise<void> {
    if (!this.generation) return this.write(all, bytes)
    const data = Buffer.from(records.map(record => `${JSON.stringify({ generation: this.generation, record })}\n`).join(''))
    try {
      await retryWindowsFileOperation(async () => {
        const handle = await open(this.journal, constants.O_WRONLY | constants.O_CREAT, 0o600)
        try {
          const size = (await handle.stat()).size
          if (size < this.appended) throw new Error('The checkpoint journal lost lines it was given.')
          if (size > this.appended) await handle.truncate(this.appended)
          for (let written = 0; written < data.length;) written += (await handle.write(data, written, data.length - written, this.appended + written)).bytesWritten
          await handle.sync()
        } finally { await handle.close() }
      })
    } catch {
      await this.write(all, bytes)
      return
    }
    this.appended += data.length
  }
}
