import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { MESHY_FORMATS, MESHY_TASK_ID, MESHY_TRIANGLES_MAX, MESHY_TRIANGLES_MIN, MESHY_WORDS_MAX } from './api'

/**
 * What became of a 3D model. `making` while Meshy works on it, at the `shape`, the `texture` or fetching the `files`;
 * `done` with its files in the thread's folder; `failed` when Meshy or the folder would not have it; `lost` when Meshy
 * no longer has it, or Sotto cannot tell what became of it, and nothing more will be charged.
 */
export const MODEL_STATES = ['making', 'done', 'failed', 'lost'] as const
export const MODEL_STAGES = ['shape', 'texture', 'files'] as const
/**
 * Why a 3D model was not made, in one word: Meshy `refused` the key, the account had `no-credits`, Meshy `rejected`
 * the words or the photo, Meshy `failed` making it, a file was `too-large`, the `folder` would not take the files,
 * or the Meshy account that asked is gone (`no-account`). A `lost` 3D model says `expired` when its three days passed,
 * `stopped` when Sotto stopped before it knew whether Meshy took it, and `unreachable` when Meshy gave no answer Sotto
 * could read as it was asked; those last two keep their credits counted, since Meshy may have taken them.
 */
export const MODEL_FAILURES = ['refused', 'no-credits', 'rejected', 'failed', 'too-large', 'folder', 'unreachable', 'no-account', 'expired', 'stopped'] as const

/** How long Meshy keeps what its API made below Enterprise, and so how long Sotto keeps trying to fetch it. */
export const MODEL_KEPT_MS = 3 * 24 * 60 * 60_000
/** The newest records kept. A record is small; this only stops the file growing without end. */
export const MODEL_RECORDS_KEPT = 2_000

const at = z.string().datetime()
const fileName = z.string().min(1).max(200)
const taskId = z.string().regex(MESHY_TASK_ID)
/**
 * Meshy's own task IDs, which nothing outside this folder reads, and the task being asked for while Meshy has not yet
 * answered: one Sotto stopped during may have been taken and charged, so it is never asked for again.
 */
const jobSchema = z.object({ preview: taskId, refine: taskId, photo: taskId, asking: z.enum(['preview', 'refine', 'photo']) }).partial()
const recordSchema = z.object({
  id: z.string().min(1).max(100),
  threadId: z.string().min(1).max(500),
  accountId: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  /** The words sent, kept only while Keep local history is on; or the photo's file name, never the photo. */
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('words'), words: z.string().max(MESHY_WORDS_MAX).optional() }),
    z.object({ kind: z.literal('photo'), fileName }),
  ]),
  /** The thread's working folder, and the real folder inside it the files go into. */
  root: z.string().min(1),
  folder: z.string().min(1),
  formats: z.array(z.enum(MESHY_FORMATS)).min(1),
  triangles: z.number().int().min(MESHY_TRIANGLES_MIN).max(MESHY_TRIANGLES_MAX).optional(),
  state: z.enum(MODEL_STATES),
  stage: z.enum(MODEL_STAGES).optional(),
  /** What it cost, from Meshy's price table when each task was asked for, less any Meshy refunded. */
  credits: z.number().int().nonnegative(),
  askedAt: at,
  endedAt: at.optional(),
  /** The files' names in `folder`, the still picture first when there is one. */
  files: z.array(fileName),
  still: fileName.optional(),
  failure: z.enum(MODEL_FAILURES).optional(),
  job: jobSchema,
})
const fileSchema = z.object({ version: z.literal(1), models: z.array(z.unknown()) })

/** A 3D model's record as this folder keeps it, with Meshy's task IDs. */
export type ModelRecord = z.infer<typeof recordSchema>
export type MeshyJob = ModelRecord['job']
/** A 3D model as the rest of Sotto sees it: the record without Meshy's task IDs. */
export type ThreeDModel = Omit<ModelRecord, 'job'>

/** The record without Meshy's task IDs, for anything outside this folder. */
export function modelOf(record: ModelRecord): ThreeDModel {
  const model: Partial<ModelRecord> = { ...record }
  delete model.job
  return model as ThreeDModel
}

/**
 * The record of 3D models (ADR-0141): one small file in Sotto's data folder, newest first. Forgetting a thread
 * removes its records; the files they name are the user's and stay where they are.
 *
 * The words sent follow Keep local history: with it off no record holds them, in memory or in the file, and turning
 * it off takes out those already kept. The rest of a record stays whichever way it is set. It holds nothing the
 * thread's folder does not already show (the files' names, the photo's name), and it is what lets a 3D model still
 * being made when Sotto quits be fetched when Sotto starts, rather than paid for and never seen, and what the month's
 * credits are counted from.
 *
 * Every change runs whole, one after another, as the plugin use record's do.
 */
export class ModelRecords {
  private readonly path: string
  private records: ModelRecord[] | undefined
  /** Whether the file may still hold words, so turning Keep local history off knows to write it again. */
  private wordsInFile = false
  private queue: Promise<unknown> = Promise.resolve()
  constructor(directory: string, private readonly options: { readonly historyEnabled: () => boolean }) {
    this.path = join(directory, '3d-models.json')
  }

  /** Every 3D model, newest first. */
  list(): Promise<readonly ThreeDModel[]> {
    return this.inTurn(async () => (await this.load()).map(modelOf))
  }

  /** One 3D model's record, with Meshy's task IDs, for this folder's own use. */
  record(id: string): Promise<ModelRecord | undefined> {
    return this.inTurn(async () => (await this.load()).find(record => record.id === id))
  }

  /** The records still being made, oldest first: what is picked up on start. */
  unfinished(): Promise<readonly ModelRecord[]> {
    return this.inTurn(async () => (await this.load()).filter(record => record.state === 'making').reverse())
  }

  /** Keeps a new record. Rejects when it cannot be written, and then nothing should be sent to Meshy. */
  add(record: ModelRecord): Promise<ModelRecord> {
    return this.inTurn(async () => {
      const kept = this.private(recordSchema.parse(record))
      const records = await this.load()
      await this.write([kept, ...records.filter(other => other.id !== kept.id)].slice(0, MODEL_RECORDS_KEPT))
      return kept
    })
  }

  /** Changes one record. Undefined when it is gone, as when its thread was forgotten while it was being made. */
  update(id: string, change: (record: ModelRecord) => ModelRecord): Promise<ModelRecord | undefined> {
    return this.inTurn(async () => {
      const records = await this.load()
      const index = records.findIndex(record => record.id === id)
      if (index < 0) return undefined
      const next = this.private(recordSchema.parse(change(records[index]!)))
      await this.write(records.map((record, other) => other === index ? next : record))
      return next
    })
  }

  /** Removes forgotten threads' records, all of them in one change. The files stay. */
  forgetThreads(threadIds: readonly string[]): Promise<void> {
    const gone = new Set(threadIds)
    return this.inTurn(async () => {
      const records = await this.load()
      const kept = records.filter(record => !gone.has(record.threadId))
      if (kept.length !== records.length) await this.write(kept)
    })
  }

  /** Keep local history changed: with it off, the words kept with each record are taken out of memory and the file. */
  privacyChanged(): Promise<void> {
    return this.inTurn(async () => {
      if (this.options.historyEnabled()) return
      // Memory first, so the words are gone from what Sotto holds even when the file cannot be written.
      const records = (await this.load()).map(record => this.private(record))
      this.records = records
      if (this.wordsInFile) await this.write(records)
    })
  }

  /** A record as it may be kept now: without its words while Keep local history is off. */
  private private(record: ModelRecord): ModelRecord {
    if (this.options.historyEnabled() || record.source.kind !== 'words' || record.source.words === undefined) return record
    return { ...record, source: { kind: 'words' } }
  }

  private inTurn<Result>(change: () => Promise<Result>): Promise<Result> {
    const run = this.queue.catch(() => undefined).then(change)
    this.queue = run
    return run
  }

  private async load(): Promise<ModelRecord[]> {
    if (this.records) return this.records
    let text: string
    try { text = await readFile(this.path, 'utf8') } catch (error) {
      // No file yet: no records. One that is there and could not be read now, as while something else holds it, fails
      // this change and is read again by the next, so it is never written over with nothing.
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') { this.records = []; return this.records }
      throw error
    }
    let records: ModelRecord[] = []
    let parsed: ReturnType<typeof fileSchema.safeParse> | undefined
    try { parsed = fileSchema.safeParse(JSON.parse(text)) } catch { parsed = undefined }
    // A file that does not parse starts over, and may still hold words, so it counts as holding them. A record this
    // version cannot read is left out rather than failing the rest, and counts the same way. And words a failed
    // clearing left in the file are not read while Keep local history is off.
    if (!parsed?.success) this.wordsInFile = true
    else records = parsed.data.models.flatMap(entry => {
      const record = recordSchema.safeParse(entry)
      if (!record.success || holdsWords(record.data)) this.wordsInFile = true
      return record.success ? [this.private(record.data)] : []
    })
    this.records = records
    return records
  }

  /** Writes the record whole and only then takes it as kept, so a failed write leaves what was kept as it was. */
  private async write(records: ModelRecord[]): Promise<void> {
    const next = `${this.path}.next`
    await mkdir(dirname(this.path), { recursive: true })
    try {
      await writeFile(next, JSON.stringify({ version: 1, models: records }), { mode: 0o600 })
      await rename(next, this.path)
    } catch (error) {
      await rm(next, { force: true })
      throw error
    }
    this.records = records
    this.wordsInFile = records.some(holdsWords)
  }
}

function holdsWords(record: ModelRecord): boolean { return record.source.kind === 'words' && record.source.words !== undefined }
