import { readdir, realpath, stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { basename, join, relative } from 'node:path'
import type { UsageTokens } from '../../../shared/threadUsage'
import { USAGE_HISTORY_BATCH_MAX, type UsageHistoryCursor, type UsageTokenObservation } from '../../../shared/usageDashboard'
import { nativeUsageKey } from '../nativeUsage'
import { identity } from './files'
import { usageHistoryCursorKey, usageHistoryRecordKey, usageHistoryThreadId, yieldToEventLoop, type UsageHistorySink } from './sink'

/**
 * Antigravity's own conversation files on this computer (ADR-0083), read the way T3 Code reads them (the research note,
 * "Usage"). Each conversation is a SQLite file, `<session>.db`, whose `gen_metadata`, `steps` and
 * `trajectory_metadata_blob` rows hold protobuf metadata: per-generation token counts, retries, model IDs and instants.
 * The reader opens each file read-only, keeps the numbers, the instant and the served model's name, and drops the row.
 * Prompt text, titles and paths never leave it, and it logs nothing.
 *
 * Sotto's own `agy` keeps its conversations under Sotto's app data folder; the user's own `agy`, IDE and backups keep
 * theirs under `~/.gemini` and `~/.config/antigravity`. A generation copied into several files counts once.
 */
export interface AntigravityHistoryOptions {
  /** Sotto's own `agy` app data folder, `antigravityFolders(directory).appData`. */
  readonly own: string
  /** The user's home folder, for `agy`'s own folders. */
  readonly home: string
  /** Each native session Sotto owns, by `agy` session ID, to the adapter's own thread ID. */
  readonly owned: ReadonlyMap<string, string>
}

interface Root { readonly path: string; readonly label: string; readonly sotto: boolean }

/** Where conversations are read from: Sotto's own folder first, then the user's own, as T3 Code lists them. */
export function antigravityHistoryRoots(own: string, home: string): Root[] {
  return [
    { path: own, label: 'sotto', sotto: true },
    ...['antigravity', 'antigravity-cli', 'antigravity-ide', 'antigravity-backup'].map(name => ({ path: join(home, '.gemini', name), label: `gemini/${name}`, sotto: false })),
    { path: join(home, '.config', 'antigravity'), label: 'config/antigravity', sotto: false },
  ]
}

// ---- Protobuf, by hand: only varints and length-delimited fields are kept. ----

type FieldValue = number | Uint8Array
type Fields = Map<number, FieldValue[]>

/** One message's fields. A varint past 2^53 is kept as the largest safe number; nothing here counts that high. */
export function protobufFields(bytes: Uint8Array): Fields {
  let offset = 0
  const result: Fields = new Map()
  const varint = (): number => {
    let value = 0
    let scale = 1
    for (let shift = 0; shift < 70; shift += 7) {
      const byte = bytes[offset++]
      if (byte === undefined || (shift === 63 && byte > 1)) throw new Error('Invalid protobuf varint')
      value += (byte & 127) * scale
      scale *= 128
      if (byte < 128) return Math.min(value, Number.MAX_SAFE_INTEGER)
    }
    throw new Error('Invalid protobuf varint')
  }
  while (offset < bytes.length) {
    const tag = varint()
    const field = Math.floor(tag / 8)
    const wire = tag % 8
    if (field === 0) throw new Error('Invalid protobuf field')
    let value: FieldValue
    if (wire === 0) value = varint()
    else if (wire === 1 || wire === 2 || wire === 5) {
      const length = wire === 2 ? varint() : wire === 1 ? 8 : 4
      if (length > bytes.length - offset) throw new Error('Truncated protobuf field')
      value = bytes.subarray(offset, offset + length)
      offset += length
      if (wire !== 2) continue
    } else throw new Error('Unsupported protobuf wire type')
    const entries = result.get(field)
    if (entries) entries.push(value)
    else result.set(field, [value])
  }
  return result
}

const numberAt = (value: Fields, key: number): number => { const entry = value.get(key)?.[0]; return typeof entry === 'number' ? entry : 0 }
const bytesAt = (value: Fields, key: number): Uint8Array | undefined => { const entry = value.get(key)?.[0]; return entry instanceof Uint8Array ? entry : undefined }
const nested = (value: Fields, key: number): Fields => { const bytes = bytesAt(value, key); return bytes === undefined ? new Map() : protobufFields(bytes) }
const strictText = new TextDecoder('utf-8', { fatal: true })
/** A short string field, or empty: anything that is not short UTF-8 is not a name or an identity. */
const textAt = (value: Fields, key: number): string => {
  const bytes = bytesAt(value, key)
  if (bytes === undefined || bytes.length > 256) return ''
  try { return strictText.decode(bytes).trim() } catch { return '' }
}
const instant = (value: Fields): number | null => {
  const seconds = numberAt(value, 1)
  return seconds > 0 ? seconds * 1000 + Math.floor(numberAt(value, 2) / 1_000_000) : null
}

/**
 * Model IDs `agy` records without a name, as T3 Code maps them (cross-checked there against ccusage and
 * agent-cost-dashboard). Names learned from the files themselves come first.
 */
const MODEL_IDS: Readonly<Record<number, string>> = {
  246: 'gemini-2.5-pro', 312: 'gemini-2.5-flash', 313: 'gemini-2.5-flash-thinking', 329: 'gemini-2.5-flash-thinking', 330: 'gemini-2.5-flash-lite',
  281: 'claude-sonnet-4', 282: 'claude-sonnet-4', 290: 'claude-opus-4', 291: 'claude-opus-4', 333: 'claude-sonnet-4-5', 334: 'claude-sonnet-4-5',
  340: 'claude-haiku-4-5', 341: 'claude-haiku-4-5', 342: 'gpt-oss-120b-medium', 1026: 'claude-opus-4-6', 1035: 'claude-sonnet-4-6',
  1016: 'gemini-3.1-pro', 1036: 'gemini-3.1-pro', 1037: 'gemini-3.1-pro', 1018: 'gemini-3-flash-preview', 1084: 'gemini-3-flash-preview',
  1047: 'gemini-3-flash-preview', 1020: 'gemini-3.5-flash-medium', 1021: 'gemini-3.1-flash-image', 1050: 'gemini-3.1-flash-lite',
  1071: 'gemini-3.6-flash-high', 1072: 'gemini-3.6-flash-medium', 1073: 'gemini-3.6-flash-low', 1132: 'gemini-3.5-flash-high',
  1133: 'gemini-3.5-flash-high', 1187: 'gemini-3.5-flash-extra-low', 1196: 'gemini-3.6-flash', 1266: 'gemini-3.6-flash',
  1298: 'gemini-3.7-flash-high', 1299: 'gemini-3.7-flash-medium', 1300: 'gemini-3.7-flash-low', 1301: 'gemini-3.7-flash-tiered',
  1318: 'gemini-3.8-flash-high', 1319: 'gemini-3.8-flash-medium', 1320: 'gemini-3.8-flash-low', 1322: 'gemini-3.8-flash-tiered',
  1402: 'claude-opus-5-5', 1417: 'gemini-4-argon', 1418: 'gemini-4-argon', 1419: 'gemini-4-argon',
}

/** `Claude 4.5 Sonnet (Thinking)` to `claude-sonnet-4-5-thinking`, as T3 Code names them. */
function modelName(name: string): string {
  if (!name) return ''
  const normalized = name.toLowerCase().replace(/\s*\(([^)]*)\)\s*$/u, '-$1').replace(/\s+/gu, '-')
  return normalized.startsWith('claude-') ? normalized.replace(/^claude-(\d+(?:\.\d+)?)-(sonnet|opus|haiku)/u, 'claude-$2-$1').replaceAll('.', '-') : normalized
}
/**
 * Only a name shaped like a model is kept. T3 Code also keeps any other non-empty name; Sotto keeps none it cannot
 * tell from free text, so no stray field ever reaches Usage as a model.
 */
const isConcreteModel = (model: string): boolean => /^(?:gemini-\d|claude-(?:sonnet|opus|haiku)-\d|gpt-)[a-z\d.-]{0,60}$/u.test(model)
  && !/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/u.test(model)

function rememberModel(models: Map<number, string | null>, id: number, model: string): void {
  const previous = models.get(id)
  models.set(id, previous === undefined || previous === model ? model : null)
}

interface Metadata { model: string; modelId: number; at: number | null; usages: Fields[] }

/** A generation's (`step` false) or a step's metadata: its model, instant, usage and each retry's usage. */
function metadata(bytes: Uint8Array, step: boolean): Metadata {
  const root = protobufFields(bytes)
  if (!step && bytesAt(root, 1) === undefined) throw new Error('Missing generation metadata')
  const data = step ? root : nested(root, 1)
  const model = step ? nested(data, 24) : data
  const usage = bytesAt(data, step ? 9 : 4)
  // Copied, so a kept usage does not hold the whole row alive.
  const primary = usage === undefined ? undefined : protobufFields(usage.slice())
  const usages = primary === undefined ? [] : [primary]
  for (const retry of data.get(step ? 28 : 17) ?? []) {
    if (!(retry instanceof Uint8Array)) throw new Error('Invalid retry metadata')
    const retryUsage = bytesAt(protobufFields(retry), 2)
    if (retryUsage !== undefined) usages.push(protobufFields(retryUsage.slice()))
  }
  const names = [textAt(model, step ? 12 : 19), textAt(model, step ? 8 : 21)].map(modelName)
  return {
    model: names.find(isConcreteModel) ?? '',
    modelId: numberAt(model, step ? 1 : 3) || (primary === undefined ? 0 : numberAt(primary, 1)),
    at: step ? (instant(nested(data, 8)) ?? instant(nested(data, 1))) : instant(nested(nested(data, 9), 4)),
    usages,
  }
}

interface Totals { uncached: number; cached: number; cacheWrite: number; output: number }
interface Candidate {
  session: string
  sotto: boolean
  at: number
  model: string
  modelId: number
  /** 4 named in its own row, 3 learned from another row, 2 from the table above, 1 or 0 unknown. */
  modelQuality: number
  /** 2 its own instant, 1 the conversation's, 0 the file's. */
  timeQuality: number
  totals: Totals
  /** `agy`'s own request identities, which match across copies of a conversation. */
  keys: string[]
  fallbackKey: string
}

/** Generation rows can hold megabytes of context: they are read one at a time, steps a page at a time. */
const GENERATION_PAGE_ROWS = 1
const STEP_PAGE_ROWS = 64

/** One conversation file's candidates, or undefined when it is not a conversation. Yields between pages. */
async function readDatabase(path: string, session: string, sotto: boolean, fileTime: number, models: Map<number, string | null>, signal: AbortSignal): Promise<Candidate[] | undefined> {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 100')
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name))
    // Not a conversation, as `agy`'s own conversation_summaries.db index is not.
    if (!tables.has('gen_metadata') && !tables.has('steps')) return undefined
    db.exec('BEGIN')
    try {
      const read = async (table: 'gen_metadata' | 'steps', pageRows: number, step: boolean): Promise<{ idx: number; entry: Metadata }[]> => {
        if (!tables.has(table)) return []
        const query = db.prepare(`SELECT rowid AS row_id, idx, ${step ? 'metadata' : 'data'} AS data FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`)
        const entries: { idx: number; entry: Metadata }[] = []
        let after = -1
        for (;;) {
          if (signal.aborted) throw new Error('Stopped')
          const rows = query.all(after, pageRows)
          for (const row of rows) {
            if (step && row.data === null) continue
            if (typeof row.idx !== 'number' || !(row.data instanceof Uint8Array)) throw new Error('Invalid conversation row')
            entries.push({ idx: row.idx, entry: metadata(row.data, step) })
          }
          if (rows.length < pageRows) break
          after = Number(rows[rows.length - 1]!.row_id)
          await yieldToEventLoop()
        }
        return entries.sort((a, b) => a.idx - b.idx)
      }
      const generations = await read('gen_metadata', GENERATION_PAGE_ROWS, false)
      let conversationAt: number | null = null
      if (tables.has('trajectory_metadata_blob')) {
        for (const row of db.prepare('SELECT data FROM trajectory_metadata_blob').all()) {
          if (row.data instanceof Uint8Array) conversationAt ??= instant(nested(protobufFields(row.data), 2))
        }
      }
      const steps = await read('steps', STEP_PAGE_ROWS, true)
      for (const { entry } of [...generations, ...steps]) if (entry.modelId > 0 && isConcreteModel(entry.model)) rememberModel(models, entry.modelId, entry.model)
      return candidates(session, sotto, generations, steps, conversationAt, fileTime)
    } finally { db.exec('COMMIT') }
  } finally { db.close() }
}

function candidates(session: string, sotto: boolean, generations: readonly { idx: number; entry: Metadata }[], steps: readonly { idx: number; entry: Metadata }[],
  conversationAt: number | null, fileTime: number): Candidate[] {
  const found: Candidate[] = []
  const generationAt = new Map(generations.map(({ idx, entry }) => [idx, entry]))
  for (const [source, entries] of [['step', steps], ['generation', generations]] as const) {
    for (const [index, { idx, entry }] of entries.entries()) {
      for (const [usageIndex, usage] of entry.usages.entries()) {
        const modelId = numberAt(usage, 1) || entry.modelId
        const generation = source === 'step' ? generationAt.get(idx) : undefined
        // A retry can run on another model than its generation or step.
        const matches = (other: Metadata): boolean => modelId === 0 || other.modelId === modelId
        const model = matches(entry) && entry.model ? entry.model : generation && matches(generation) ? generation.model : ''
        const output = Math.max(numberAt(usage, 3), numberAt(usage, 9) + numberAt(usage, 10))
        const totals = { uncached: numberAt(usage, 2), cached: numberAt(usage, 5), cacheWrite: numberAt(usage, 4), output }
        if (totals.uncached + totals.cached + totals.cacheWrite + output === 0) continue
        const keys = ([11, 12, 7] as const).flatMap(key => { const id = textAt(usage, key); return identity(id) ? [`${key}:${id}`] : [] })
        found.push({ session, sotto, at: entry.at ?? conversationAt ?? fileTime, model, modelId, modelQuality: isConcreteModel(model) ? 4 : 0,
          timeQuality: entry.at !== null ? 2 : conversationAt !== null ? 1 : 0, totals, keys, fallbackKey: `${session}:${source}:${index}:${usageIndex}` })
      }
    }
  }
  return found
}

/** Copies of one request, by any identity they share, become one row holding the largest of each count. */
class Groups {
  private readonly parent: number[] = []
  private readonly rows: Candidate[] = []
  private readonly byKey = new Map<string, number>()
  add(candidate: Candidate): void {
    const index = this.rows.length
    this.rows.push(candidate); this.parent.push(index)
    for (const key of candidate.keys) {
      const existing = this.byKey.get(key)
      if (existing !== undefined) this.merge(existing, index)
      else this.byKey.set(key, index)
    }
  }
  private find(index: number): number {
    while (this.parent[index] !== index) { this.parent[index] = this.parent[this.parent[index]!]!; index = this.parent[index]! }
    return index
  }
  private merge(left: number, right: number): void {
    const a = this.find(left), b = this.find(right)
    if (a === b) return
    const first = Math.min(a, b), second = Math.max(a, b)
    const target = this.rows[first]!, source = this.rows[second]!
    if (source.modelQuality > target.modelQuality) { target.model = source.model; target.modelQuality = source.modelQuality }
    if (source.timeQuality > target.timeQuality || (source.timeQuality === target.timeQuality && source.at < target.at)) { target.at = source.at; target.timeQuality = source.timeQuality }
    for (const field of ['uncached', 'cached', 'cacheWrite', 'output'] as const) target.totals[field] = Math.max(target.totals[field], source.totals[field])
    target.keys = [...new Set([...target.keys, ...source.keys])]
    this.parent[second] = first
  }
  *roots(): Generator<Candidate> { for (let i = 0; i < this.rows.length; i++) if (this.parent[i] === i) yield this.rows[i]! }
}

interface Found { readonly path: string; readonly key: string; readonly root: Root }

async function conversationFiles(roots: readonly Root[], signal: AbortSignal): Promise<Found[]> {
  const found: Found[] = []
  const seen = new Set<string>()
  const walk = async (directory: string, root: Root, depth: number): Promise<void> => {
    if (signal.aborted || depth > 8) return
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of entries) {
      const path = join(directory, entry.name)
      // Links are neither followed nor read: a linked folder could lead anywhere on the computer.
      if (entry.isDirectory()) await walk(path, root, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.db')) {
        let canonical = path
        try { canonical = await realpath(path) } catch { /* Read it under the name it was found by. */ }
        if (seen.has(canonical)) continue
        seen.add(canonical)
        found.push({ path, root, key: usageHistoryCursorKey('antigravity', `${root.label}/${relative(root.path, path)}`) })
      }
    }
  }
  const isFolder = async (path: string): Promise<boolean> => { try { return (await stat(path)).isDirectory() } catch { return false } }
  for (const root of roots) {
    if (!(await isFolder(root.path))) continue
    // Where a root keeps a `conversations` folder, as `agy`'s app data does, only that is read, as T3 Code reads it.
    const conversations = join(root.path, 'conversations')
    await walk((await isFolder(conversations)) ? conversations : root.path, root, 0)
  }
  return found
}

/** A file and its write-ahead log by size and times: the log holds new rows, and a changed time catches a restored file. */
async function fingerprint(path: string): Promise<{ cursor: UsageHistoryCursor; mtimeMs: number } | undefined> {
  let file
  try { file = await stat(path) } catch { return undefined }
  let wal = '-'
  try { const log = await stat(`${path}-wal`); wal = `${log.size}:${Math.floor(log.mtimeMs)}:${Math.floor(log.ctimeMs)}` } catch { /* No log. */ }
  return { mtimeMs: file.mtimeMs, cursor: { size: file.size, mtimeMs: Math.floor(file.mtimeMs), offset: 0, state: `${Math.floor(file.ctimeMs)}/${wal}` } }
}
const sameCursor = (a: UsageHistoryCursor | undefined, b: UsageHistoryCursor): boolean => a !== undefined && a.size === b.size && a.mtimeMs === b.mtimeMs && a.state === b.state

const MAX_INSTANT = 253_402_300_799_000
const dated = (at: number): string | undefined => Number.isFinite(at) && at > 0 && at <= MAX_INSTANT ? new Date(at).toISOString() : undefined
/** A name that fits Usage's model rows, or Antigravity's own number for it. */
const shownModel = (candidate: Candidate): string => candidate.model || (candidate.modelId > 0 ? `antigravity-model-${candidate.modelId}` : 'antigravity-unknown')

function observation(candidate: Candidate, owned: ReadonlyMap<string, string>): UsageTokenObservation | undefined {
  const at = dated(candidate.at)
  if (at === undefined) return undefined
  const { uncached, cached, cacheWrite, output } = candidate.totals
  const input = uncached + cached + cacheWrite
  if (!Number.isSafeInteger(input + output)) return undefined
  const tokens: UsageTokens = { input, output, cached, cacheWrite }
  const native = candidate.keys[0] ?? candidate.fallbackKey
  const thread = owned.get(candidate.session)
  if (thread !== undefined) {
    return { providerId: 'antigravity', threadId: thread, recordKey: nativeUsageKey('antigravity', 'row', thread, native), modelId: shownModel(candidate),
      tokens, at, phase: 'replay', partial: false, origin: 'history' }
  }
  const threadId = usageHistoryThreadId('antigravity', candidate.session)
  // A request `agy` named is the same row in every file; one it did not is its own conversation's.
  const recordKey = usageHistoryRecordKey('antigravity', candidate.keys[0] === undefined ? threadId : 'antigravity', native)
  return { providerId: 'antigravity', threadId, recordKey, modelId: shownModel(candidate), tokens, at, phase: 'replay', partial: false, origin: 'history',
    ...candidate.sotto ? {} : { source: 'outside' as const, client: 'antigravity' as const } }
}

/**
 * One pass over every Antigravity conversation file whose size or times changed since the last. A changed file is read
 * whole and its rows handed over again; each row is keyed, so a row read twice counts once. A file that cannot be read
 * keeps its old cursor and is tried on the next pass.
 */
export async function scanAntigravityHistory(options: AntigravityHistoryOptions, sink: UsageHistorySink, signal: AbortSignal): Promise<void> {
  const files = await conversationFiles(antigravityHistoryRoots(options.own, options.home), signal)
  const models = new Map<number, string | null>()
  const read: Candidate[] = []
  const cursors: { key: string; cursor: UsageHistoryCursor }[] = []
  for (const file of files) {
    if (signal.aborted) return
    const print = await fingerprint(file.path)
    if (print === undefined || sameCursor(sink.cursor(file.key), print.cursor)) continue
    const session = basename(file.path, '.db')
    if (!identity(session)) { cursors.push({ key: file.key, cursor: print.cursor }); continue }
    try {
      const found = await readDatabase(file.path, session, file.root.sotto, print.mtimeMs, models, signal)
      if (found) read.push(...found)
      cursors.push({ key: file.key, cursor: print.cursor })
    } catch { /* Unreadable or busy: its old cursor stays, so the next pass tries it again. */ }
    await yieldToEventLoop()
  }
  if (signal.aborted) return
  const groups = new Groups()
  for (const candidate of read) {
    if (candidate.modelQuality < 4) {
      const learned = models.get(candidate.modelId)
      const known = learned === null ? undefined : MODEL_IDS[candidate.modelId]
      if (learned) { candidate.model = learned; candidate.modelQuality = 3 }
      else if (known) { candidate.model = known; candidate.modelQuality = 2 }
    }
    groups.add(candidate)
  }
  const batch: UsageTokenObservation[] = []
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    sink.tokens(batch.splice(0))
    await sink.settled?.()
    await yieldToEventLoop()
  }
  for (const candidate of groups.roots()) {
    const row = observation(candidate, options.owned)
    if (row) batch.push(row)
    if (batch.length === USAGE_HISTORY_BATCH_MAX) await flush()
    if (signal.aborted) return
  }
  await flush()
  if (signal.aborted) return
  for (let index = 0; index < cursors.length; index += USAGE_HISTORY_BATCH_MAX) sink.setCursors(cursors.slice(index, index + USAGE_HISTORY_BATCH_MAX))
  await sink.settled?.()
}
