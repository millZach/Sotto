import { join } from 'node:path'
import { z } from 'zod'
import type { AgentThread, ProviderId } from '../../shared/agents'
import { DYNAMIC_RECORD_MODELS_MAX, dynamicRecordRowSchema, type DynamicRecordRead, type DynamicRecordRow } from '../../shared/dynamicRecord'
import type { UsageTokens } from '../../shared/threadUsage'
import { AtomicJsonStore } from '../storage/atomicJsonStore'

const FILE = 'dynamic-record.json'
/**
 * The newest pieces whose ending is still watched: as many delegations as delegation itself keeps, since an older one's
 * outcome no longer reaches it. An older piece that ends later adds nothing more to its counts.
 */
export const DYNAMIC_RECORD_PIECES_MAX = 2_000

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/** A piece under watch: its worker's thread, the model its line counts on, and how much of it has been counted. */
const pieceSchema = z.object({ thread: z.string().min(1).max(512), model: z.string().min(1).max(512),
  finished: z.literal(true).optional(), moved: z.literal(true).optional(), tokens: count }).strict()
type Piece = z.infer<typeof pieceSchema>
const savedSchema = z.object({ version: z.literal(1), models: z.array(dynamicRecordRowSchema).max(DYNAMIC_RECORD_MODELS_MAX),
  pieces: z.array(pieceSchema).max(DYNAMIC_RECORD_PIECES_MAX) }).strict()
type Saved = z.infer<typeof savedSchema>
const empty = (): Saved => ({ version: 1, models: [], pieces: [] })

/** A saved record as it reads, one line and one piece at a time, so a damaged entry costs only itself. */
function parseSaved(input: unknown): Saved {
  const whole = savedSchema.safeParse(input)
  if (whole.success) return whole.data
  const saved = input !== null && typeof input === 'object' ? input as { models?: unknown; pieces?: unknown } : {}
  const keep = <T>(items: unknown, schema: z.ZodType<T>, max: number): T[] => Array.isArray(items)
    ? items.flatMap(item => { const read = schema.safeParse(item); return read.success ? [read.data] : [] }).slice(-max) : []
  const models = keep(saved.models, dynamicRecordRowSchema, DYNAMIC_RECORD_MODELS_MAX)
  // A piece whose line was lost goes with it, so its ending can never count against a line made again from nothing.
  const lines = new Set(models.map(row => row.model))
  return { version: 1, models, pieces: keep(saved.pieces, pieceSchema, DYNAMIC_RECORD_PIECES_MAX).filter(piece => lines.has(piece.model)) }
}

/** A worker's thread's tokens as its line counts them: input, which includes cached input, and output. */
export const dynamicRecordTokens = (total: UsageTokens | undefined): number => (total?.input ?? 0) + (total?.output ?? 0)

/** Each thread's tokens as its line counts them, read when the record is read, for the usage a turn reports after it ends. */
export type DynamicRecordThreadTokens = () => ReadonlyMap<string, number>
/** The tokens of every thread that reports any, by thread, for `DynamicRecordThreadTokens`. */
export const threadTokensOf = (threads: readonly Pick<AgentThread, 'id' | 'usage'>[]): ReadonlyMap<string, number> =>
  new Map(threads.flatMap(thread => thread.usage?.total ? [[thread.id, dynamicRecordTokens(thread.usage.total)] as const] : []))

/** A piece as an overseer starts it: the worker's thread and the model it chose. */
export interface DynamicRecordStart { readonly thread: string; readonly provider: ProviderId; readonly model: string; readonly name: string }

/**
 * **Its record** (ADR-0191 decision 9): what delegation tells it of an overseer's pieces, counted per model and saved
 * as numbers and model names alone, on Usage history's terms: kept whatever Keep local history says, and cleared only
 * by Clear its record, after which pieces from before it never count again. Nothing here runs on the update path: a
 * start, an outcome that moved, a replacement and a read each call it once. `threadTokens`, where this computer runs
 * threads, tops up a watched piece's tokens when the record is read, since a turn's usage can arrive after it ended.
 */
export class DynamicRecord {
  private saved: Saved = empty()
  private readonly store: AtomicJsonStore<Saved>
  private loading: Promise<void> | undefined

  constructor(directory: string, private readonly threadTokens?: DynamicRecordThreadTokens) {
    this.store = new AtomicJsonStore(join(directory, FILE), parseSaved, empty)
  }

  /** Reads the saved record once; every later call answers with the same read. */
  load(): Promise<void> { return this.loading ??= this.store.read().then(saved => { this.saved = saved }, () => undefined) }

  /** Whether a worker's thread is a piece whose ending is still counted. */
  watches(thread: string): boolean { return this.piece(thread) !== undefined }

  /** An overseer gave a piece to a model. A thread already counted is not counted twice. */
  started(start: DynamicRecordStart): void {
    if (this.piece(start.thread)) return
    const row = this.row(start)
    row.pieces++
    this.saved.pieces.push({ thread: start.thread, model: start.model, tokens: 0 })
    if (this.saved.pieces.length > DYNAMIC_RECORD_PIECES_MAX) this.saved.pieces.splice(0, this.saved.pieces.length - DYNAMIC_RECORD_PIECES_MAX)
    this.changed()
  }

  /**
   * A delegation to a piece's thread reached an outcome. `answered` counts it finished, once; the tokens its thread has
   * used since it was last counted join its line either way.
   */
  ended(thread: string, answered: boolean, tokens: number): void {
    const piece = this.piece(thread), row = piece && this.saved.models.find(item => item.model === piece.model)
    if (!piece || !row) return
    let counted = false
    if (answered && !piece.finished) { piece.finished = true; row.finished++; counted = true }
    if (this.addTokens(piece, row, tokens)) counted = true
    if (counted) this.changed()
  }

  /** An overseer gave the piece on this thread to `model`, naming it in `replaces`: moved, if that is another model. */
  moved(thread: string, model: string): void {
    const piece = this.piece(thread), row = piece && this.saved.models.find(item => item.model === piece.model)
    if (!piece || !row || piece.moved || piece.model === model) return
    piece.moved = true
    row.moved++
    this.changed()
  }

  /** One model's line, for an overseer reading what it may choose. */
  line(model: string): DynamicRecordRow | undefined { return this.saved.models.find(item => item.model === model) }

  /** Every line, the most pieces first, with the tokens watched pieces' threads have used since they were last counted. */
  read(): DynamicRecordRead {
    const tokens = this.threadTokens?.()
    if (tokens) {
      let counted = false
      for (const piece of this.saved.pieces) {
        const row = this.saved.models.find(item => item.model === piece.model), now = tokens.get(piece.thread)
        if (row && now !== undefined && this.addTokens(piece, row, now)) counted = true
      }
      if (counted) this.changed()
    }
    return { models: [...this.saved.models].sort((a, b) => b.pieces - a.pieces || a.name.localeCompare(b.name)).map(row => ({ ...row })) }
  }

  /** Clear its record: every line and every piece under watch, so nothing from before counts again. */
  async clear(): Promise<void> {
    this.saved = empty()
    await this.store.write(this.saved)
  }

  private piece(thread: string): Piece | undefined { return this.saved.pieces.find(item => item.thread === thread) }

  /** The model's line, made the first time it is given a piece. Past the most lines one record holds, the line with the fewest pieces goes. */
  private row(start: DynamicRecordStart): DynamicRecordRow {
    const found = this.saved.models.find(item => item.model === start.model)
    if (found) return found
    if (this.saved.models.length >= DYNAMIC_RECORD_MODELS_MAX) {
      const fewest = this.saved.models.reduce((least, item) => item.pieces < least.pieces ? item : least)
      this.saved.models = this.saved.models.filter(item => item !== fewest)
    }
    const row: DynamicRecordRow = { provider: start.provider, model: start.model, name: start.name, pieces: 0, finished: 0, moved: 0, tokens: 0 }
    this.saved.models.push(row)
    return row
  }

  /** Adds what a piece's thread has used since it was last counted. Whether anything was added. */
  private addTokens(piece: Piece, row: DynamicRecordRow, tokens: number): boolean {
    if (tokens <= piece.tokens) return false
    row.tokens += tokens - piece.tokens
    piece.tokens = tokens
    return true
  }

  /**
   * Saves the record, one write shared by a burst of changes. A save that fails is tried again by the next change, and
   * the counts in memory stand meanwhile.
   */
  private changed(): void { void this.store.writeLatest(() => this.saved).catch(() => undefined) }
}

