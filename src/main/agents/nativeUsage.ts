import { createHash } from 'node:crypto'
import { open, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { threadUsageSchema, usageTokensSchema, type ThreadUsage, type UsageTokens } from '../../shared/threadUsage'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { UsageReadPending, UsageVisitUnfinished } from './usageVisits'
import { estimateUsage, USAGE_RATE_VERSION } from './usageRates'
import type { UsageProviderId, UsageTokenObservation } from '../../shared/usageDashboard'

/** Facts supplied by the adapter, never inferred from a ledger's latest update. */
export interface NativeUsageContext {
  readonly phase: 'live' | 'replay'
  readonly at?: string | undefined
  readonly groupId?: string | undefined
  readonly groupStartedAt?: string | undefined
  readonly liveNewGroup?: boolean | undefined
}
const dated = (value: unknown): string | undefined => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined

const entrySchema = z.object({ tokens: usageTokensSchema, model: z.string(), usd: z.number().optional(), lowerBound: z.boolean().optional(), rate: z.string() })
const ledgerSchema = z.object({ view: threadUsageSchema, entries: z.record(z.string(), entrySchema),
  total: usageTokensSchema.optional(), model: z.string().optional(), seen: z.array(z.string()), latestId: z.string().optional(), incomplete: z.boolean().default(false), contextCompacted: z.boolean().optional() })
type Ledger = z.infer<typeof ledgerSchema>
/** One thread's ledger in a file of its own: the thread's ID, which the file's name only hashes, and its ledger. */
const threadLedgerSchema = z.object({ id: z.string(), ledger: ledgerSchema })
/** A file found among the threads' ledgers, which the store reads as null when it is not one. */
const foundLedgerSchema = threadLedgerSchema.nullable()
/**
 * A thread's ledger file as a report's read parses it: everything but its requests checked, which are checked a chunk a
 * task after (`checkedInTasks`), so a long thread's check never holds main longer than its file's JSON parse.
 */
const uncheckedLedgerSchema = z.object({ id: z.string(), ledger: ledgerSchema.extend({ entries: z.record(z.string(), z.unknown()) }) }).nullable()
const legacyLedgersSchema = z.record(z.string(), ledgerSchema)
/**
 * A thread's view in a file beside its ledger, which start reads instead of the ledger (#1937): the thread's ID, the rate
 * table it was priced with, and the size and modification time of the ledger file it was written with, which tell a view
 * the ledger has since moved past, as one an earlier build or a failed write left behind.
 */
const ledgerViewSchema = z.object({ id: z.string(), rateVersion: z.string(), ledgerSize: z.number(), ledgerModified: z.number(), view: threadUsageSchema })
/** A file found beside the threads' ledgers, which the store reads as null when it is not a view. */
const foundViewSchema = ledgerViewSchema.nullable()
const emptyLedger = (at: number): Ledger => ({ view: { rateVersions: [], partial: false, updatedAt: new Date(at).toISOString() }, entries: {}, seen: [], incomplete: false })
type LedgerEntry = Ledger['entries'][string]
const TOKEN_FIELDS = ['input', 'output', 'cached', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h'] as const

/**
 * What `summarize` reduces over a thread's requests, kept between calls (#555): everything up to its tail, in the ledger's
 * own order. The tail is the newest few requests, the one a streaming reply keeps reporting on among them. A thread reports
 * usage on nearly every frame of a reply, so its totals are the tail's requests added to these, in the very order a walk of
 * every request adds them: the same numbers to the last bit, without walking a long thread's thousands of requests.
 */
interface RunningTotals {
  usd: number
  priced: number
  /** Requests with no price yet, or only a lower bound. */
  partial: number
  /** The rate versions of priced requests, each once, in the order they first appear. */
  readonly rates: string[]
  readonly fields: Record<typeof TOKEN_FIELDS[number], { sum: number; count: number }>
  /** The newest requests' keys, in the ledger's order, last in it, and not in the sums above. */
  readonly tail: string[]
  /**
   * The request last changed that was already in the ledger, a streaming reply's. The tail never lets it go into the sums,
   * however many requests a replay adds after it, so its next report is still counted from the tail.
   */
  hot: string | undefined
  /** A change the tail cannot account for, as a request older than it changing: walk every request next time. */
  stale: boolean
}

/** The tail's length past which its oldest requests go into the sums, and the most it holds behind a streaming reply. */
const TAIL_KEPT = 32
const TAIL_MOST = 1_024

const noTotals = (): RunningTotals => ({ usd: 0, priced: 0, partial: 0, rates: [], tail: [], hot: undefined, stale: false,
  fields: Object.fromEntries(TOKEN_FIELDS.map(field => [field, { sum: 0, count: 0 }])) as RunningTotals['fields'] })

/** `totals`' sums alone, to add a tail to without changing them. */
const sumsOf = (totals: RunningTotals): RunningTotals => ({ ...totals, rates: [...totals.rates], tail: [],
  fields: Object.fromEntries(TOKEN_FIELDS.map(field => [field, { ...totals.fields[field] }])) as RunningTotals['fields'] })

/** Adds one request to `totals` as `summarize`'s walk would at its place. */
function addRequest(totals: RunningTotals, entry: LedgerEntry): void {
  if (entry.usd !== undefined) {
    totals.usd += entry.usd; totals.priced += 1
    if (!totals.rates.includes(entry.rate)) totals.rates.push(entry.rate)
  }
  if (entry.usd === undefined || entry.lowerBound === true) totals.partial += 1
  for (const field of TOKEN_FIELDS) {
    const value = entry.tokens[field]
    if (value !== undefined) { totals.fields[field].sum += value; totals.fields[field].count += 1 }
  }
}

/** A key JavaScript orders ahead of every other key of an object, so a new one is not the newest in the ledger's order. */
const ordersFirst = (key: string): boolean => /^(?:0|[1-9]\d{0,9})$/u.test(key) && Number(key) < 4_294_967_295
const SYNTHETIC = '<synthetic>'
const GROK_REPORTED_COST = 'grok-reported-cost'
const object = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
/** A token or time figure as a provider reported it: a non-negative safe integer, or undefined for anything else. */
export const tokenCount = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
function codexTokens(value: unknown): UsageTokens {
  const row = object(value)
  return { input: tokenCount(row.inputTokens), output: tokenCount(row.outputTokens), cached: tokenCount(row.cachedInputTokens), cacheWrite: tokenCount(row.cacheWriteInputTokens) }
}
export function claudeTokens(value: unknown): UsageTokens {
  const row = object(value); const input = tokenCount(row.input_tokens); const cached = tokenCount(row.cache_read_input_tokens); const write = tokenCount(row.cache_creation_input_tokens)
  const creation = object(row.cache_creation)
  return { input: input !== undefined && cached !== undefined && write !== undefined ? input + cached + write : undefined,
    output: tokenCount(row.output_tokens), cached, cacheWrite: write,
    cacheWrite5m: tokenCount(creation.ephemeral_5m_input_tokens), cacheWrite1h: tokenCount(creation.ephemeral_1h_input_tokens) }
}

/**
 * Claude's result frame keys its per-model figures by the model as the session selected it, which carries a
 * context suffix the assistant messages leave off: `claude-opus-5[1m]` against `claude-opus-5`. Matching only
 * the exact string loses the context window, and the thread then has nothing but a raw token count to show.
 * The suffix is the only difference allowed, so a row is never read off a different model.
 */
function claudeModelUsage(modelUsage: unknown, model: string): unknown {
  const rows = object(modelUsage)
  if (Object.hasOwn(rows, model)) return rows[model]
  const base = (name: string): string => name.replace(/\[[^\]]*\]$/u, '')
  const matches = Object.keys(rows).filter(key => base(key) === base(model))
  return matches.length === 1 ? rows[matches[0]!] : undefined
}

/**
 * The identity of one usage row as the store holds it. History read from a provider's own records reuses it, so a row
 * the ledger already counted learns its date instead of being counted again (ADR-0083).
 */
export function nativeUsageKey(provider: UsageProviderId, kind: 'row' | 'group', id: string, identity: string): string {
  return createHash('sha256').update(JSON.stringify(['sotto-usage', provider, kind, id, identity])).digest('hex')
}
/** A Codex request's ledger entry key: its turn and the thread's running totals once it was counted. */
export function codexEntryKey(turnId: unknown, total: UsageTokens): string {
  return createHash('sha256').update(JSON.stringify([turnId, total])).digest('hex')
}

/** A thread's ledger file's name: its ID hashed, so any ID makes a name every file system takes. */
const ledgerFileName = (id: string): string => `${createHash('sha256').update(id).digest('hex').slice(0, 40)}.json`
const LEDGER_FILE = /^[0-9a-f]{40}\.json$/u
/** The file beside a ledger file that holds its thread's view, named so nothing reading ledger files takes it for one. */
const viewFileName = (ledgerFile: string): string => ledgerFile.replace(/\.json$/u, '.view.json')
/** A thread's file as start reads it: its ledger whole, or its view alone, its requests left unread. */
type FoundThread = { id: string; ledger: Ledger } | { id: string; ledger?: undefined; view: ThreadUsage }
/**
 * The most threads' ledger files written at once. Moving an earlier build's one file across writes every thread's, and
 * opening hundreds of files together can run out of file handles, which would fail the very writes quitting waits for.
 */
const LEDGER_WRITES_AT_ONCE = 8
/** The most threads' views, and ledgers without one, read at once at start. */
const LEDGER_READS_AT_ONCE = 16
/** How long a thread's held reports wait before its ledger is read again after a failed read, doubling up to the most. */
const READ_RETRY_FIRST_MS = 500
const READ_RETRY_MOST_MS = 30_000
/** How many of a ledger's requests one task normalises, so a long thread's never holds main longer than its file's parse. */
const NORMALISED_AT_ONCE = 2_000
/**
 * How many of a thread's rows one visit hands Usage, which takes each row through its schema, before it lets main go on: on
 * forge a row costs about 6 microseconds there, and a flush of Usage's full buffer, which the rows can set off, about 5 ms.
 */
const VISITED_AT_ONCE = 500
/** A thread's visit under way: its requests in the order the visit began with, how far it got, and what it handed over. */
interface VisitUnderway { readonly ledger: Ledger; readonly keys: readonly string[]; next: number; readonly emitted: Set<string>; readonly identities: ReadonlySet<string> }
const nextTask = (): Promise<void> => new Promise(resolve => { setImmediate(resolve) })
/** What a context reading, from a provider or a compaction, sets in a thread's view. */
function contextReading(view: ThreadUsage, used: number | undefined, at: string): void { view.contextUsed = used; view.contextUpdatedAt = at }
/** What a turn's end, its duration and its model's context window, sets in a thread's view. */
function turnEnd(view: ThreadUsage, elapsed: unknown, contextWindow: unknown): void {
  view.elapsedMs = tokenCount(elapsed)
  view.contextWindow = tokenCount(contextWindow) || view.contextWindow
}
/** A thread's reports held until its requests are read, in the order they came, and the read under way or due again. */
interface HeldReports { readonly reports: (() => void)[]; reading: Promise<void> | undefined; failures: number; retry: ReturnType<typeof setTimeout> | undefined }
/** Which Claude frames count in a ledger: those that need its requests, and those that change nothing but must keep their order. */
function claudeCounts(frame: Record<string, unknown>): 'requests' | 'order' | undefined {
  if (frame.type === 'stream_event') {
    const type = object(frame.event).type
    return type === 'message_start' ? 'requests' : type === 'message_delta' || type === 'message_stop' ? 'order' : undefined
  }
  const message = object(frame.message)
  return frame.type === 'assistant' && typeof message.id === 'string' && message.usage && message.model !== SYNTHETIC ? 'requests' : undefined
}

/** `work` for each of `items`, at most `limit` at once, each outcome in its item's place. */
async function settledInTurn<Item>(items: readonly Item[], limit: number, work: (item: Item) => Promise<void>): Promise<PromiseSettledResult<void>[]> {
  const outcomes: PromiseSettledResult<void>[] = new Array<PromiseSettledResult<void>>(items.length)
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      try { await work(items[index]!); outcomes[index] = { status: 'fulfilled', value: undefined } }
      catch (reason) { outcomes[index] = { status: 'rejected', reason } }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return outcomes
}

/** What a system says when it does not sync a folder: Windows opens one but refuses to flush it, macOS may not support it. */
const FOLDER_SYNC_REFUSED = ['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EBADF']

/**
 * Makes a folder's own entries durable, as the files renamed into it, where the system allows it: one that does not, as
 * Windows does not, keeps its own order of renames and removals, and one that is not there has nothing to keep.
 */
async function syncFolder(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await open(path, 'r') }
  catch (error) { if (['ENOENT', ...FOLDER_SYNC_REFUSED].includes((error as NodeJS.ErrnoException).code ?? '')) return; throw error }
  try { await handle.sync() }
  catch (error) { if (!FOLDER_SYNC_REFUSED.includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
  finally { await handle.close() }
}

/** How often the ledger is written while a reply streams. A turn's end is written at once. */
export const USAGE_WRITE_INTERVAL_MS = 1000

/**
 * Accounting observation only: never changes delivery, native sessions, or billing settings.
 *
 * The ledger holds every request of every thread, each thread's in a file of its own in `{provider}-usage/` (#555): a
 * write writes the threads that changed, where the one file every thread shared was written whole, 2.4 to 12.7 MB
 * synced to disk once a second while a reply streamed. A reply reports usage on nearly every frame, so while it streams
 * a thread's ledger is written at most once every `USAGE_WRITE_INTERVAL_MS`, and at once when a turn ends (`elapsed`,
 * Grok's `turn_completed`) or a compaction is recorded. What a crash between two writes loses is that second's counts,
 * which the provider reports again when the thread is read.
 *
 * The one file earlier builds wrote, `{provider}-usage.json`, is read at start beside the threads' own files, which win
 * for their thread. Every ledger it held is then written to a file of its own, and only once all of them are is the
 * shared file removed.
 *
 * Start reads each thread's view alone, from a file beside its ledger written with it, and a thread's requests are read
 * from its ledger file the first time something needs them: a usage report, or Usage visiting the thread (#1937). Only
 * the threads working this run need their requests, and every thread's were 9 to 15 MB on the owner's computer. A ledger
 * whose view is missing, or was not written with the ledger as it is now, is read whole at start, as every ledger was.
 * A report on a thread whose requests are not read yet is held, with any after it, while they are read off the report's
 * task; then they are applied in the order they came, and `applied` hears of it. A read that fails is tried again.
 */
export class NativeUsage {
  /** The one ledger file of earlier builds, read at start and removed once every ledger it held has a file of its own. */
  private readonly legacyStore: AtomicJsonStore<Record<string, Ledger>>
  private readonly legacyPath: string
  /** Whether that file was there when the ledgers were last read, and has not been removed since. */
  private legacyPresent = false
  /** The threads the shared file held whose ledger has not reached a file of its own yet. */
  private readonly unmoved = new Set<string>()
  private readonly ledgerDirectory: string
  /** Each thread's ledger file, by thread ID, made when the thread is first read or written. */
  private readonly stores = new Map<string, AtomicJsonStore<{ id: string; ledger: Ledger }>>()
  /** The threads whose requests have been read this run, or made since. */
  private data: Record<string, Ledger> = {}
  /** The threads whose requests have not been read since start, each one's view as the file beside its ledger holds it. */
  private unread = new Map<string, ThreadUsage>()
  /** Each thread's view file, by thread ID, made when the view is first written. */
  private readonly viewStores = new Map<string, AtomicJsonStore<z.infer<typeof foundViewSchema>>>()
  /** Ledgers read whole at start for want of a view that matches them: each one's view is written, the ledger left as it is. */
  private readonly viewsDue = new Set<string>()
  private readonly streaming = new Map<string, string>()
  private writing: Promise<void> | undefined
  private readonly dirty = new Set<string>()
  /**
   * Each ledger's file as it was last written, already encoded, by the ledger object. Every change to a ledger goes
   * through `ledger()` or ends in `save()`, and each forgets it, so a thread written again whose ledger did not change is
   * not encoded again (#1451).
   */
  private serializedLedgers = new WeakMap<Ledger, Buffer>()
  private readonly failed = new Set<string>()
  /** Each ledger's running totals, made by the first `summarize` that walks it. */
  private readonly running = new WeakMap<Ledger, RunningTotals>()
  /** Each ledger's `seen` as a set, so telling a replayed report from a new one does not scan every key the thread saw. */
  private readonly seenKeys = new WeakMap<Ledger, Set<string>>()
  /** When the last write started, by the monotonic clock: a wall clock set back must not hold writes back. */
  private lastWriteAt = Number.NEGATIVE_INFINITY
  private timer: ReturnType<typeof setTimeout> | undefined
  /** A turn ended while a write was running: the next one goes as soon as it finishes. */
  private urgent = false
  private draining = 0
  private readonly usageListeners = new Set<(record: UsageTokenObservation) => void>()
  /** Numeric-only current projections. The stable ledger's format remains unchanged. */
  private readonly projections = new Map<string, Map<string, UsageTokenObservation>>()
  private readonly detailedGrokGroups = new Set<string>()
  private readonly ambiguousGrokGroups = new Set<string>()
  /** Each thread's reports held until its requests are read, by thread ID. */
  private readonly held = new Map<string, HeldReports>()
  /** When the report being applied came in, while a held one is applied, so it reads as of then. */
  private reportedAt: number | undefined
  /** Each thread's visit under way, by thread ID, which the next visit goes on with. */
  private readonly visiting = new Map<string, VisitUnderway>()
  /** Each thread's context reading as its compaction started, taken in the order of its reports (ADR-0095). */
  private readonly compactionReadings = new Map<string, string>()
  /** `applied`: told a thread's held reports were applied, so its owner shows the thread's usage as they left it. */
  constructor(directory: string, private readonly provider: 'codex' | 'claude' | 'grok', private readonly usageEnabled = false,
    private readonly applied?: (id: string) => void) {
    this.legacyPath = join(directory, `${provider}-usage.json`)
    this.legacyStore = AtomicJsonStore.compact(this.legacyPath, legacyLedgersSchema.parse, () => ({}))
    this.ledgerDirectory = join(directory, `${provider}-usage`)
  }
  private store(id: string): AtomicJsonStore<{ id: string; ledger: Ledger }> {
    let store = this.stores.get(id)
    if (!store) {
      store = AtomicJsonStore.compact(this.ledgerPath(id), threadLedgerSchema.parse, () => ({ id, ledger: emptyLedger(Date.now()) }))
      this.stores.set(id, store)
    }
    return store
  }
  private viewStore(id: string): AtomicJsonStore<z.infer<typeof foundViewSchema>> {
    let store = this.viewStores.get(id)
    if (!store) {
      store = AtomicJsonStore.compact(join(this.ledgerDirectory, viewFileName(ledgerFileName(id))), foundViewSchema.parse, () => null)
      this.viewStores.set(id, store)
    }
    return store
  }
  private ledgerPath(id: string): string { return join(this.ledgerDirectory, ledgerFileName(id)) }
  /**
   * Every thread's ledger as start reads it: the shared file of earlier builds, then each thread's own file over it. A
   * thread whose view matches its ledger is read as that view alone, its requests left unread; any other is read whole.
   */
  private async readLedgers(): Promise<{ whole: Record<string, Ledger>; unread: Map<string, ThreadUsage> }> {
    const whole: Record<string, Ledger> = {}
    const unread = new Map<string, ThreadUsage>()
    this.unmoved.clear()
    this.legacyPresent = await this.legacyStore.exists()
    if (this.legacyPresent) {
      for (const [id, ledger] of Object.entries(await this.legacyStore.read())) { whole[id] = ledger; this.unmoved.add(id) }
    }
    const names = await readdir(this.ledgerDirectory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
    const present = new Set(names)
    const ledgers = names.filter(name => LEDGER_FILE.test(name))
    const found = new Array<FoundThread | undefined>(ledgers.length)
    const outcomes = await settledInTurn(ledgers.map((_, index) => index), LEDGER_READS_AT_ONCE, async index => {
      found[index] = await this.readThread(ledgers[index]!, present.has(viewFileName(ledgers[index]!)))
    })
    const failure = outcomes.find(outcome => outcome.status === 'rejected')
    if (failure) throw failure.reason
    for (const thread of found) {
      if (!thread) continue
      this.unmoved.delete(thread.id)
      if (thread.ledger) whole[thread.id] = thread.ledger
      else { delete whole[thread.id]; unread.set(thread.id, thread.view) }
    }
    return { whole, unread }
  }
  /** One thread's file as start reads it: its view where that matches its ledger, and otherwise its ledger whole. */
  private async readThread(name: string, viewed: boolean): Promise<FoundThread | undefined> {
    const path = join(this.ledgerDirectory, name)
    if (viewed) {
      try {
        // A file unreadable as a view has been set aside as the store sets any aside; the ledger is read instead.
        const found = await AtomicJsonStore.compact(join(this.ledgerDirectory, viewFileName(name)), foundViewSchema.parse, () => null).read()
        // A view that may hold unpriced requests, made with another rate table, is read whole so they are priced, as start always did.
        if (found && ledgerFileName(found.id) === name && (found.rateVersion === USAGE_RATE_VERSION || !found.view.partial)) {
          const file = await stat(path).catch(() => undefined)
          if (file && file.size === found.ledgerSize && file.mtimeMs === found.ledgerModified) {
            // A successfully read archive is durable; an old process's failure flag is not.
            delete found.view.persistenceError
            return { id: found.id, view: found.view }
          }
        }
      } catch { /* A view that cannot be read, as one the system refuses, is no reason not to start: its ledger is read whole. */ }
    }
    const read = await AtomicJsonStore.compact(path, foundLedgerSchema.parse, () => null).read()
    // A file unreadable as a ledger has been set aside as the store sets any aside; its thread starts afresh.
    if (!read || ledgerFileName(read.id) !== name) return undefined
    return { id: read.id, ledger: read.ledger }
  }
  async load(): Promise<void> {
    await this.flushed()
    this.streaming.clear()
    // A reconnect must not replace newer, unsaved observations with the old archive.
    if (this.failed.size) return
    const read = await this.readLedgers()
    this.data = read.whole
    this.unread = read.unread
    this.viewsDue.clear()
    // A ledger only the shared file held is written to a file of its own, and the file goes once none is left only there.
    for (const id of this.unmoved) this.dirty.add(id)
    if (!this.unmoved.size) await this.removeLegacy()
    for (const [id, ledger] of Object.entries(this.data)) {
      if (this.normalized(ledger)) this.dirty.add(id)
      else this.viewsDue.add(id)
    }
    this.writePending(true)
  }
  /** What reading a ledger from its file does to it before anything counts in it; true when that changed it. */
  private normalized(ledger: Ledger): boolean {
    const failed = this.clearedFailure(ledger)
    const keys = Object.keys(ledger.entries)
    const repriced = this.repriced(ledger, keys)
    const before = JSON.stringify(ledger.view)
    if (repriced) this.advance(ledger)
    this.summarize(ledger)
    return failed || repriced || JSON.stringify(ledger.view) !== before
  }
  /**
   * `normalized`, a chunk of requests a task, for a ledger read while main goes on: a long thread's walk of every request is
   * then never one task longer than its file's parse. The running totals are walked in the ledger's order, as `summarize`
   * walks them, so they are the same numbers to the last bit.
   */
  private async normalizedInTasks(ledger: Ledger): Promise<boolean> {
    const failed = this.clearedFailure(ledger)
    const keys = Object.keys(ledger.entries)
    let repriced = false
    for (let start = 0; start < keys.length; start += NORMALISED_AT_ONCE) {
      if (start) await nextTask()
      repriced = this.repriced(ledger, keys.slice(start, start + NORMALISED_AT_ONCE)) || repriced
    }
    const counted = repriced ? Object.keys(ledger.entries) : keys
    const totals = noTotals()
    const split = Math.max(0, counted.length - 1)
    for (let start = 0; start < split; start += NORMALISED_AT_ONCE) {
      await nextTask()
      for (const key of counted.slice(start, Math.min(split, start + NORMALISED_AT_ONCE))) addRequest(totals, ledger.entries[key]!)
    }
    totals.tail.push(...counted.slice(split))
    this.running.set(ledger, totals)
    const before = JSON.stringify(ledger.view)
    if (repriced) this.advance(ledger)
    this.summarize(ledger)
    return failed || repriced || JSON.stringify(ledger.view) !== before
  }
  /** A ledger's requests checked against the ledger's schema, a chunk a task; undefined when one is not a request. */
  private async checkedInTasks(raw: Record<string, unknown>): Promise<Ledger['entries'] | undefined> {
    const keys = Object.keys(raw)
    const entries: Ledger['entries'] = {}
    for (let start = 0; start < keys.length; start += NORMALISED_AT_ONCE) {
      if (start) await nextTask()
      for (const key of keys.slice(start, start + NORMALISED_AT_ONCE)) {
        const entry = entrySchema.safeParse(raw[key])
        if (!entry.success) return undefined
        entries[key] = entry.data
      }
    }
    return entries
  }
  /** A successfully read archive is durable; an old process's failure flag is not. True when there was one. */
  private clearedFailure(ledger: Ledger): boolean {
    if (!ledger.view.persistenceError) return false
    delete ledger.view.persistenceError
    return true
  }
  /** Drops Claude's local notices among `keys` and prices what has a price now; true when that changed a request. */
  private repriced(ledger: Ledger, keys: readonly string[]): boolean {
    let changed = false
    for (const key of keys) {
      const entry = ledger.entries[key]!
      // Claude's own local notices carry no billed work.
      if (entry.model === SYNTHETIC) { delete ledger.entries[key]; changed = true; continue }
      // Usage recorded before its model had a price is priced once one exists; priced entries keep their rate.
      if (entry.usd !== undefined) continue
      const estimate = estimateUsage(this.provider, entry.model, entry.tokens)
      if (estimate) { ledger.entries[key] = { ...entry, usd: estimate.usd, ...(estimate.lowerBound ? { lowerBound: true } : {}), rate: USAGE_RATE_VERSION }; changed = true }
    }
    return changed
  }
  /** Moves the thread's revision on: one of its requests changed. */
  private advance(ledger: Ledger): void { ledger.view.revision = (ledger.view.revision ?? 0) + 1 }
  /** Now, or when the held report being applied came in. */
  private now(): number { return this.reportedAt ?? Date.now() }
  /** Shows a reading in an unread thread's view at once, while its requests are read and its report waits for them. */
  private preview(id: string, reading: (view: ThreadUsage) => void): void {
    const view = this.unread.get(id)
    if (view) reading(view)
  }
  /**
   * Holds a report on a thread whose requests have not been read since start (#1937), and reads them off the report's task:
   * true when it was held. Held reports are applied once the requests are read, in the order they came, so a request an
   * earlier run counted is among them and is not counted again, and none is lost to a read that failed. A report that needs
   * no request, `order`, is held only behind reports already held, so it keeps its place among them.
   */
  private deferred(id: string, report: () => void, need: 'requests' | 'order' = 'requests'): boolean {
    if (!this.held.has(id) && (need === 'order' || !this.unread.has(id))) return false
    const at = Date.now()
    this.readSoon(id).reports.push(() => { this.reportedAt = at; try { report() } finally { this.reportedAt = undefined } })
    return true
  }
  /** The thread's held reports, its requests' read started if it was not. */
  private readSoon(id: string): HeldReports {
    let held = this.held.get(id)
    if (!held) {
      held = { reports: [], reading: undefined, failures: 0, retry: undefined }
      this.held.set(id, held)
      void this.readHeld(id)
    }
    return held
  }
  /**
   * Reads a thread's requests with the store's own read, then, in a task of its own, makes of them what start made of every
   * ledger it read and applies the thread's held reports. Normalising a ledger walks every request, so it runs once for a
   * thread in a run, never in a report's task. A read that fails keeps the reports and is tried again after a short wait.
   */
  private readHeld(id: string): Promise<void> {
    const held = this.held.get(id)
    if (!held) return Promise.resolve()
    if (held.reading) return held.reading
    if (held.retry !== undefined) { clearTimeout(held.retry); held.retry = undefined }
    const reading = (async () => {
      const path = this.ledgerPath(id)
      let read: z.infer<typeof uncheckedLedgerSchema> = null
      try {
        if (!this.data[id] && this.unread.has(id)) read = await AtomicJsonStore.compact(path, uncheckedLedgerSchema.parse, () => null).read()
      } catch {
        held.failures += 1
        held.retry = setTimeout(() => { held.retry = undefined; void this.readHeld(id) }, Math.min(READ_RETRY_MOST_MS, READ_RETRY_FIRST_MS * 2 ** (held.failures - 1)))
        held.retry.unref?.()
        return
      }
      await nextTask()
      // A file that is not this thread's ledger was set aside by the store if unreadable: the thread starts afresh, as at start.
      if (!this.data[id] && this.unread.has(id) && read && read.id === id) {
        const entries = await this.checkedInTasks(read.ledger.entries)
        if (entries) {
          const ledger = read.ledger as unknown as Ledger
          ledger.entries = entries
          const changed = await this.normalizedInTasks(ledger)
          if (this.held.get(id) !== held || this.data[id] || !this.unread.has(id)) return
          this.data[id] = ledger
          if (changed) this.dirty.add(id)
        } else {
          // A request the ledger's schema refuses: the store's own read refuses the file too and sets it aside, as it sets
          // aside any file it cannot read as a ledger, and the thread starts afresh, as it would have at start.
          await AtomicJsonStore.compact(path, foundLedgerSchema.parse, () => null).read().catch(() => null)
        }
      }
      if (this.held.get(id) !== held) return
      this.unread.delete(id)
      this.applyHeld(id)
    })()
    held.reading = reading.finally(() => { held.reading = undefined })
    return held.reading
  }
  /** Applies a thread's held reports, now that its requests are read, in the order they came, and tells its owner. */
  private applyHeld(id: string): void {
    const held = this.held.get(id)
    if (!held) return
    this.held.delete(id)
    if (held.retry !== undefined) { clearTimeout(held.retry); held.retry = undefined }
    for (const report of held.reports) {
      try { report() } catch { /* Accounting never changes native delivery; one report cannot keep the next from counting. */ }
    }
    this.writePending()
    try { this.applied?.(id) } catch { /* As above. */ }
  }
  /** Drain the latest observations, retrying a prior failure once without spinning on a broken disk. */
  async flushed(): Promise<void> {
    this.draining += 1
    try {
      // Held reports first, each thread's read tried again now if the one under way fails, so quitting or a reconnect loses
      // or reorders none it can read.
      await Promise.all([...this.held.keys()].map(async id => {
        await this.readHeld(id)
        if (this.held.has(id)) await this.readHeld(id)
      }))
      this.writePending(true)
      while (this.writing) await this.writing
    } finally { this.draining -= 1 }
  }
  get(id: string): ThreadUsage | undefined { return this.data[id]?.view ?? this.unread.get(id) }
  subscribeUsage(listener: (record: UsageTokenObservation) => void): () => void {
    if (!this.usageEnabled) return () => undefined
    this.usageListeners.add(listener)
    return () => this.usageListeners.delete(listener)
  }
  private key(kind: 'row' | 'group', id: string, identity: string): string {
    return nativeUsageKey(this.provider, kind, id, identity)
  }
  private grokRecord(identity: string, model?: string): string {
    return JSON.stringify(model === undefined ? ['aggregate', identity] : ['model', identity, model])
  }
  private projected(id: string, key: string, model: string, tokens: UsageTokens, context?: NativeUsageContext, partial = false, group?: string): UsageTokenObservation {
    const groupId = context?.groupId ?? group
    return { providerId: this.provider, threadId: id, recordKey: this.key('row', id, key),
      ...(groupId ? { groupKey: this.key('group', id, groupId) } : {}), modelId: model || 'unknown', tokens: { ...tokens },
      ...(dated(context?.at) ? { at: dated(context?.at) } : {}),
      ...(dated(context?.groupStartedAt) ? { groupStartedAt: dated(context?.groupStartedAt) } : {}),
      phase: context?.phase ?? 'seed', partial: partial || tokens.input === undefined || tokens.output === undefined,
      ...(context?.phase === 'live' && context.liveNewGroup && groupId ? { liveNewGroup: true } : {}) }
  }
  private publishUsage(id: string, key: string, model: string, tokens: UsageTokens, context?: NativeUsageContext, partial = false, group?: string, ambiguous = false, removed = false, groupRecordsHash?: string): void {
    if (!this.usageEnabled || model === SYNTHETIC || !ambiguous && !removed && !Object.values(tokens).some(value => value !== undefined)) return
    const rows = this.projections.get(id) ?? new Map<string, UsageTokenObservation>(); this.projections.set(id, rows)
    const current = this.projected(id, key, model, tokens, context, partial, group)
    if (removed) current.removed = true
    if (removed && groupRecordsHash !== undefined) current.groupRecordsHash = groupRecordsHash
    const previous = rows.get(key)
    if (previous?.removed && !removed) return
    if (this.provider === 'grok' && !ambiguous && !removed && previous?.modelId === current.modelId) {
      for (const field of Object.keys(previous.tokens) as (keyof UsageTokens)[]) {
        const known = previous.tokens[field]
        if (known !== undefined && (current.tokens[field] === undefined || current.tokens[field]! < known)) current.tokens[field] = known
      }
    }
    if (previous?.at && (!current.at || previous.at < current.at)) current.at = previous.at
    if (previous?.groupStartedAt && (!current.groupStartedAt || previous.groupStartedAt < current.groupStartedAt)) current.groupStartedAt = previous.groupStartedAt
    if (!current.groupKey && previous?.groupKey) current.groupKey = previous.groupKey
    rows.set(key, current)
    for (const listener of this.usageListeners) {
      try { listener({ ...current, tokens: { ...current.tokens } }) } catch { /* Accounting never changes native delivery. */ }
    }
  }
  /**
   * Saved rows only; reading usage never starts native sessions. An unread thread's requests are read as a report's are,
   * once, in the background, and kept: Usage visits a thread at start only when its usage changed since Usage last read it,
   * a thread likely to report this run. Until they are read the visit throws `UsageReadPending`, and Usage visits again;
   * once a read has failed it throws as any unreadable thread does, and Usage reads the thread again with its next change.
   */
  visitUsage(id: string, visitor: (record: UsageTokenObservation) => void): void {
    if (!this.usageEnabled) return
    if (this.held.has(id) || (!this.data[id] && this.unread.has(id))) {
      const held = this.readSoon(id)
      if (held.failures && !held.reading) throw new Error('The thread\'s usage could not be read.')
      throw new UsageReadPending()
    }
    const ledger = this.data[id]
    if (!ledger) return
    // A long thread's rows are handed over a chunk a visit; the next visit goes on where this one stopped. A ledger read
    // again since, as a reconnect reads them, is visited from its start: Usage passes over a row it holds.
    let visit = this.visiting.get(id)
    if (visit?.ledger !== ledger) {
      visit = { ledger, keys: Object.keys(ledger.entries), next: 0, emitted: new Set(), identities: this.provider === 'grok' ? new Set(ledger.seen) : new Set() }
      this.visiting.set(id, visit)
    }
    const end = Math.min(visit.keys.length, visit.next + VISITED_AT_ONCE)
    for (let index = visit.next; index < end; index++) {
      const key = visit.keys[index]!, entry = ledger.entries[key]
      if (entry) this.visitRow(id, ledger, visit, key, entry, visitor)
    }
    visit.next = end
    if (end < visit.keys.length) throw new UsageVisitUnfinished()
    this.visiting.delete(id)
    for (const [key, row] of this.projections.get(id) ?? []) {
      if (visit.emitted.has(key)) continue
      const seed = { ...row, tokens: { ...row.tokens } }; delete seed.liveNewGroup
      visitor(seed)
    }
    // A ledger an earlier build kept has no revision, so Usage reads it at every start until it has one; now it was read.
    if (ledger.view.revision === undefined) {
      ledger.view.revision = 0
      this.serializedLedgers.delete(ledger); this.dirty.add(id); this.writePending()
    }
  }
  /** One of a thread's saved requests handed to Usage's visit as the row, or rows, it makes. */
  private visitRow(id: string, ledger: Ledger, visit: VisitUnderway, key: string, entry: LedgerEntry, visitor: (record: UsageTokenObservation) => void): void {
    const { emitted } = visit
    if (this.provider === 'grok') {
      const grokProjected = this.projections.get(id) ?? new Map<string, UsageTokenObservation>()
      const aggregate = visit.identities.has(key)
      // Legacy per-model entries are prompt identity + ':' + the exact saved model.
      const candidate = key.endsWith(`:${entry.model}`) ? key.slice(0, -entry.model.length - 1) : undefined
      const identity = aggregate ? key : candidate && visit.identities.has(candidate) ? candidate : undefined
      if (!identity) return
      const record = this.grokRecord(identity, aggregate ? undefined : entry.model)
      if (!aggregate) {
        this.detailedGrokGroups.add(JSON.stringify([id, identity]))
        const aggregateKey = this.grokRecord(identity)
        const retirement = grokProjected.get(aggregateKey)?.removed ? grokProjected.get(aggregateKey)!
          : { ...this.projected(id, aggregateKey, 'unknown', {}, undefined, true, identity), removed: true as const }
        grokProjected.set(aggregateKey, retirement); this.projections.set(id, grokProjected)
        if (!emitted.has(aggregateKey)) {
          const seed = { ...retirement, tokens: { ...retirement.tokens } }; delete seed.liveNewGroup
          visitor(seed); emitted.add(aggregateKey)
        }
      }
      if (emitted.has(record)) return
      const existing = grokProjected.get(record)
      const row = existing ?? this.projected(id, record, aggregate ? 'unknown' : entry.model, entry.tokens, undefined,
        ledger.incomplete || aggregate, identity)
      if (!aggregate && !existing) { grokProjected.set(record, row); this.projections.set(id, grokProjected) }
      emitted.add(record)
      const seed = { ...row, tokens: { ...row.tokens } }; delete seed.liveNewGroup
      visitor(seed)
      return
    }
    if (entry.model === SYNTHETIC) return
    const existing = this.projections.get(id)?.get(key)
    const row = existing ?? this.projected(id, key, entry.model, entry.tokens, undefined, ledger.incomplete,
      this.provider === 'claude' ? key : undefined)
    emitted.add(key)
    const seed = { ...row, tokens: { ...row.tokens } }; delete seed.liveNewGroup
    visitor(seed)
  }
  /**
   * Codex's compaction started: its end clears the context reading unless one came in while it ran (ADR-0095). The reading
   * it compares with is taken here, in the order of the thread's reports, so a report held while its requests are read
   * counts as before or after the compaction began as it came.
   */
  compactionStarted(id: string): void {
    if (this.deferred(id, () => this.compactionStarted(id), 'order')) return
    const view = this.get(id)
    this.compactionReadings.set(id, JSON.stringify([view?.contextUsed, view?.contextUpdatedAt]))
  }
  /** Codex's compaction ended: the context reading is cleared, with a new time, unless one came in since it began. */
  compactionEnded(id: string): void {
    if (this.deferred(id, () => this.compactionEnded(id), 'order')) return
    const view = this.get(id), started = this.compactionReadings.get(id)
    this.compactionReadings.delete(id)
    const readSince = started !== undefined && started !== JSON.stringify([view?.contextUsed, view?.contextUpdatedAt])
    if (view?.contextUsed !== undefined && !readSince) this.compacted(id, undefined, new Date(this.now()).toISOString())
  }
  compacted(id: string, used: unknown, updatedAt = new Date().toISOString()): void {
    if (this.deferred(id, () => this.compacted(id, used, updatedAt))) { this.preview(id, view => { contextReading(view, tokenCount(used), updatedAt) }); return }
    const ledger = this.ledger(id)
    const changed = ledger.view.contextUsed !== tokenCount(used) || ledger.view.contextUpdatedAt !== updatedAt || ledger.contextCompacted !== true
    contextReading(ledger.view, tokenCount(used), updatedAt)
    ledger.contextCompacted = true
    this.save(id, changed, true)
  }
  /** The thread's ledger, made if it has none. Every caller has held its report first if need be (`deferred`), so a thread's saved requests are never replaced. */
  private ledger(id: string): Ledger {
    const known = this.data[id]
    if (known) { this.serializedLedgers.delete(known); return known }
    return this.data[id] = emptyLedger(this.now())
  }
  /**
   * The thread's view of its requests: what they cost, at which rate versions, whether any is unpriced, and their tokens
   * added up. Every request's change goes through `record`, which keeps the running totals up to the tail; a ledger read
   * from disk, or one a request older than the tail changed in, is walked whole (#555).
   */
  private summarize(ledger: Ledger): void {
    let totals = this.running.get(ledger)
    if (totals === undefined || totals.stale) {
      // The tail starts at the request last changed when it is among the newest, so a streaming reply's next report needs no walk.
      const hot = totals?.hot
      totals = noTotals()
      const keys = Object.keys(ledger.entries)
      const at = hot === undefined ? -1 : keys.lastIndexOf(hot)
      const split = at >= 0 && keys.length - at <= TAIL_MOST ? at : Math.max(0, keys.length - 1)
      for (const key of keys.slice(0, split)) addRequest(totals, ledger.entries[key]!)
      totals.tail.push(...keys.slice(split))
      totals.hot = at >= 0 ? hot : undefined
      this.running.set(ledger, totals)
    }
    const sums = sumsOf(totals)
    for (const key of totals.tail) addRequest(sums, ledger.entries[key]!)
    ledger.view.estimatedUsd = sums.priced ? sums.usd : undefined
    ledger.view.rateVersions = sums.rates
    ledger.view.partial = ledger.incomplete || sums.partial > 0
    // Every recorded request, so the thread's tokens add up rather than showing only the latest request.
    const total: UsageTokens = {}
    for (const field of TOKEN_FIELDS) if (sums.fields[field].count) total[field] = sums.fields[field].sum
    ledger.view.total = Object.keys(total).length ? total : undefined
  }
  /**
   * Tells the running totals `key` is about to be written. A request in the tail changing needs nothing, and a new key the
   * ledger orders last joins it; the tail's oldest requests go into the sums once it grows past `TAIL_KEPT`, never the one
   * last changed. A request older than the tail changing, or a key JavaScript orders first, is walked whole next time.
   */
  private changingRequest(ledger: Ledger, key: string): void {
    const totals = this.running.get(ledger)
    if (totals === undefined) return
    const known = Object.hasOwn(ledger.entries, key)
    if (known) totals.hot = key
    if (totals.stale) return
    if (known) { if (!totals.tail.includes(key)) totals.stale = true; return }
    if (ordersFirst(key)) { totals.stale = true; return }
    totals.tail.push(key)
    while (totals.tail.length > TAIL_KEPT && totals.tail[0] !== totals.hot) addRequest(totals, ledger.entries[totals.tail.shift()!]!)
    // Behind a streaming reply a replay can add many: past the most the tail holds, the reply's next report walks once.
    if (totals.tail.length > TAIL_MOST) totals.stale = true
  }
  private seen(ledger: Ledger): Set<string> {
    let keys = this.seenKeys.get(ledger)
    if (keys === undefined) { keys = new Set(ledger.seen); this.seenKeys.set(ledger, keys) }
    return keys
  }
  private see(ledger: Ledger, key: string): void { ledger.seen.push(key); this.seen(ledger).add(key) }
  /** `now`: a turn ended, so this is written without waiting out the interval. */
  private save(id: string, changed = true, now = false): void {
    const ledger = this.data[id]
    if (ledger) this.serializedLedgers.delete(ledger)
    if (changed) {
      this.summarize(this.data[id]!)
      this.dirty.add(id)
    }
    // Even an unchanged observation can retry a failed archive write.
    this.writePending(now)
  }
  private writePending(now = false): void {
    if (!this.dirty.size && !this.failed.size && !this.viewsDue.size) return
    if (this.writing) { this.urgent ||= now; return }
    const wait = now || this.draining ? 0 : this.lastWriteAt + USAGE_WRITE_INTERVAL_MS - performance.now()
    if (wait > 0) {
      this.timer ??= setTimeout(() => { this.timer = undefined; this.writePending(true) }, wait)
      return
    }
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    // Deferred to the next microtask: a replay batch makes one write, and changes arriving during I/O share the
    // next one. The ledger is serialized as the write starts, so it is never copied whole to hold it still.
    this.writing = Promise.resolve().then(async () => {
      try {
        do {
          const ids = new Set([...this.failed, ...this.dirty])
          const viewsOnly = [...this.viewsDue].filter(id => !ids.has(id))
          this.dirty.clear()
          this.viewsDue.clear()
          this.urgent = false
          this.lastWriteAt = performance.now()
          // Each changed thread's ledger to its file and its view beside it, a few at a time; a failure is that thread's alone.
          const written = [...ids]
          const results = await settledInTurn([...written, ...viewsOnly], LEDGER_WRITES_AT_ONCE, async id => {
            if (ids.has(id)) return this.writeThread(id, this.serialized(id), this.viewText(id))
            // A view alone, for a ledger read whole at start. One that changed since this write began waits for the next,
            // which writes its ledger with it.
            if (!this.dirty.has(id) && this.data[id]) await this.writeThread(id, undefined, this.viewText(id))
          })
          for (const [index, id] of written.entries()) {
            if (results[index]!.status === 'fulfilled') {
              this.unmoved.delete(id)
              // An older successful snapshot cannot clear a newer failed/unsaved state.
              if (this.dirty.has(id)) continue
              this.failed.delete(id)
              delete this.data[id]!.view.persistenceError
            } else {
              this.failed.add(id)
              this.data[id]!.view.persistenceError = true
            }
          }
          await this.removeLegacy()
        } while ((this.dirty.size || this.viewsDue.size) && (this.urgent || this.draining > 0))
      } finally {
        this.writing = undefined
        // What arrived during the write waits out the rest of the interval, unless a turn ended meanwhile.
        if (this.dirty.size || this.viewsDue.size) this.writePending(this.urgent)
      }
    })
  }
  /**
   * Writes a thread's ledger, when given, then its view beside it, both encoded at the same moment. The view names the
   * ledger file it was written with, so one a failure here leaves behind no longer matches the ledger and the next start
   * reads the ledger whole: only the ledger's write can fail the thread's.
   */
  private async writeThread(id: string, ledger: Buffer | undefined, view: string): Promise<void> {
    if (ledger) await this.store(id).writeSerialized([ledger])
    try {
      const file = await stat(this.ledgerPath(id))
      await this.viewStore(id).writeSerialized(`{"id":${JSON.stringify(id)},"rateVersion":${JSON.stringify(USAGE_RATE_VERSION)},"ledgerSize":${file.size},"ledgerModified":${file.mtimeMs},"view":${view}}`)
    } catch { /* The ledger is saved; start reads it whole for want of its view. */ }
  }
  /** A thread's view, encoded for the file beside its ledger, without this process's failure flag, as its ledger is encoded. */
  private viewText(id: string): string {
    const view = this.data[id]!.view
    const flagged = view.persistenceError
    if (flagged) delete view.persistenceError
    try { return JSON.stringify(view) } finally { if (flagged) view.persistenceError = true }
  }
  /**
   * A thread's ledger file, encoded: a write failure is this process's to show, never saved. A ledger nothing changed since
   * it was last encoded is not encoded again; what is kept is never written into, only replaced.
   */
  private serialized(id: string): Buffer {
    const ledger = this.data[id]!
    let piece = this.serializedLedgers.get(ledger)
    if (piece !== undefined) return piece
    const flagged = ledger.view.persistenceError
    if (flagged) delete ledger.view.persistenceError
    try { piece = Buffer.from(`{"id":${JSON.stringify(id)},"ledger":${JSON.stringify(ledger)}}`) }
    finally { if (flagged) ledger.view.persistenceError = true }
    this.serializedLedgers.set(ledger, piece)
    return piece
  }
  /**
   * The shared file of earlier builds goes once every ledger it held has a file of its own, and those files' entries in
   * their folder are on disk, so a power cut cannot keep the removal and lose a file. A failure tries again later.
   */
  private async removeLegacy(): Promise<void> {
    if (!this.legacyPresent || this.unmoved.size) return
    try {
      await syncFolder(this.ledgerDirectory)
      await unlink(this.legacyPath); this.legacyPresent = false
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.legacyPresent = false }
  }
  private record(ledger: Ledger, key: string, model: string, tokens: UsageTokens, reported?: { readonly usd: number; readonly rate: string }): boolean {
    if (model === SYNTHETIC || !Object.values(tokens).some(value => value !== undefined)) return false
    const previous = ledger.entries[key]
    if (previous && previous.model === model && JSON.stringify(previous.tokens) === JSON.stringify(tokens)
      && (!reported || previous.usd === reported.usd && previous.rate === reported.rate)) return false
    this.changingRequest(ledger, key)
    this.advance(ledger)
    if (reported) { ledger.entries[key] = { tokens, model, usd: reported.usd, rate: reported.rate }; return true }
    const estimate = estimateUsage(this.provider, model, tokens)
    ledger.entries[key] = { tokens, model, usd: estimate?.usd, ...(estimate?.lowerBound ? { lowerBound: true } : {}), rate: USAGE_RATE_VERSION }
    return true
  }
  codex(id: string, model: string, value: unknown, context?: NativeUsageContext): void {
    const params = object(value); const usage = object(params.tokenUsage)
    if (!params.turnId || !usage.total || !usage.last) return
    const total = codexTokens(usage.total); const last = codexTokens(usage.last)
    if (!Object.values(last).some(value => value !== undefined)) return
    // Not shown in the view before the requests are read: only they say whether Codex counted the report before, which
    // then changes nothing. Its compaction compares readings in the order of the reports (`compactionStarted`).
    if (this.deferred(id, () => this.codex(id, model, value, context))) return
    const ledger = this.ledger(id)
    const key = codexEntryKey(params.turnId, total)
    if (this.seen(ledger).has(key)) {
      const entry = ledger.entries[key]
      if (entry) this.publishUsage(id, key, entry.model, entry.tokens, context, ledger.incomplete, String(params.turnId))
      this.writePending(); return
    }
    this.see(ledger, key)
    const previous = ledger.total
    let delta = last
    const reset = previous && (Object.keys(total) as (keyof UsageTokens)[]).some(field => total[field] !== undefined && previous[field] !== undefined && total[field]! < previous[field]!)
    if (reset) {
      // A lower cumulative snapshot can be a reset or unseen historical replay.
      // Its last request cannot safely be charged again. Keep the prior high-water
      // baseline so later unseen historical snapshots cannot charge that work again.
      delta = {}; ledger.incomplete = true
    } else if (previous && total.input !== undefined && total.output !== undefined && ledger.model === model && previous.input !== undefined && previous.output !== undefined
      && total.input >= previous.input && total.output >= previous.output
      && (total.cached === undefined || previous.cached === undefined || total.cached >= previous.cached)
      && (total.cacheWrite === undefined || previous.cacheWrite === undefined || total.cacheWrite >= previous.cacheWrite)) {
      delta = { input: total.input - previous.input, output: total.output - previous.output,
        cached: total.cached !== undefined && previous.cached !== undefined ? total.cached - previous.cached : undefined,
        cacheWrite: total.cacheWrite !== undefined && previous.cacheWrite !== undefined ? total.cacheWrite - previous.cacheWrite : undefined }
    } else if (previous || total.input !== last.input || total.output !== last.output) ledger.incomplete = true
    this.record(ledger, key, model, delta)
    if (ledger.entries[key]) this.publishUsage(id, key, model, delta, context, ledger.incomplete, String(params.turnId))
    if (!reset) { ledger.total = total; ledger.model = model }
    this.codexReading(ledger.view, model, last, usage)
    this.save(id)
  }
  /** What a Codex turn's usage report sets in a thread's view. */
  private codexReading(view: ThreadUsage, model: string, last: UsageTokens, usage: Record<string, unknown>): void {
    view.latest = last
    view.modelId = model
    view.contextUsed = tokenCount(object(usage.last).totalTokens)
    view.contextWindow = tokenCount(usage.modelContextWindow) || undefined
    view.updatedAt = new Date(this.now()).toISOString()
    view.contextUpdatedAt = view.updatedAt
  }
  claude(id: string, value: unknown, selectedModel?: string, context?: NativeUsageContext): void {
    const frame = object(value)
    // Native child usage is not projected as parent activity or silently double-billed.
    if (frame.parent_tool_use_id || frame.isSidechain === true) return
    // A streamed message's frames are held together, in order, while the thread's requests are read: its start names the
    // request its deltas count in, and its stop ends that.
    const counts = claudeCounts(frame)
    if (counts && this.deferred(id, () => this.claude(id, value, selectedModel, context), counts)) { this.preview(id, view => { this.claudeReading(view, frame, selectedModel) }); return }
    if (frame.type === 'stream_event') {
      const event = object(frame.event)
      if (event.type === 'message_start') {
        const message = object(event.message)
        if (typeof message.id === 'string') this.streaming.set(id, message.id)
        this.claude(id, { type: 'assistant', message, timestamp: frame.timestamp }, selectedModel, context); return
      }
      if (event.type === 'message_stop') this.streaming.delete(id)
      if (event.type === 'message_delta') {
        const ledger = this.data[id]; const key = this.streaming.get(id); const entry = key ? ledger?.entries[key] : undefined
        const output = tokenCount(object(event.usage).output_tokens)
        if (ledger && key && entry && output !== undefined && output >= (entry.tokens.output ?? 0)) {
          const tokens = { ...entry.tokens, output }
          const changed = this.record(ledger, key, entry.model, tokens)
          this.publishUsage(id, key, entry.model, tokens, context, ledger.incomplete, key)
          if (changed && ledger.latestId === key) ledger.view.latest = tokens
          this.save(id, changed)
        }
      }
      return
    }
    const message = object(frame.message)
    // Claude's own local notices carry no billed work or context.
    if (frame.type !== 'assistant' || typeof message.id !== 'string' || !message.usage || message.model === SYNTHETIC) return
    const ledger = this.ledger(id); const tokens = claudeTokens(message.usage)
    const previous = ledger.entries[message.id]
    // History and stream replay often contain an earlier snapshot of the same message.
    const merged = { ...tokens }
    for (const field of Object.keys(previous?.tokens ?? {}) as (keyof UsageTokens)[]) {
      const old = previous?.tokens[field]
      if (old !== undefined && (merged[field] === undefined || merged[field]! < old)) merged[field] = old
    }
    const changed = this.record(ledger, message.id, typeof message.model === 'string' ? message.model : '', merged)
    this.publishUsage(id, message.id, typeof message.model === 'string' ? message.model : '', merged,
      { phase: context?.phase ?? 'replay', ...context, at: dated(frame.timestamp) ?? context?.at }, ledger.incomplete, message.id)
    const before = JSON.stringify([ledger.view, ledger.latestId, ledger.contextCompacted])
    const isNew = !previous
    const older = typeof frame.timestamp === 'string' && Number.isFinite(Date.parse(frame.timestamp)) && Date.parse(frame.timestamp) < Math.max(Date.parse(ledger.view.updatedAt), Date.parse(ledger.view.contextUpdatedAt ?? ledger.view.updatedAt))
    if (ledger.latestId === message.id && !ledger.contextCompacted && !older || isNew && (!ledger.view.latest && !ledger.contextCompacted || !older)) {
      const nextModel = selectedModel ?? (typeof message.model === 'string' ? message.model : undefined)
      if (ledger.view.modelId !== nextModel) delete ledger.view.contextWindow
      const contextChanged = ledger.latestId !== message.id || ledger.view.contextUsed !== merged.input
      ledger.latestId = message.id; ledger.view.latest = merged; ledger.view.contextUsed = merged.input
      if (isNew || ledger.view.modelId === undefined) ledger.view.modelId = nextModel
      // A timestamp-less replay is not a new observation of the context's age.
      if (changed || before !== JSON.stringify([ledger.view, ledger.latestId, ledger.contextCompacted]) || typeof frame.timestamp === 'string') {
        ledger.view.updatedAt = typeof frame.timestamp === 'string' ? frame.timestamp : new Date(this.now()).toISOString()
      }
      if (contextChanged) ledger.view.contextUpdatedAt = ledger.view.updatedAt
      ledger.contextCompacted = false
    }
    this.save(id, changed || before !== JSON.stringify([ledger.view, ledger.latestId, ledger.contextCompacted]))
  }
  /**
   * What a Claude frame sets in an unread thread's view while its requests are read: a new message's reading, as `claude`
   * reads one newer than the view's, and a streamed message's growing output. One older than the view's, as history
   * replays carry, waits for the requests.
   */
  private claudeReading(view: ThreadUsage, frame: Record<string, unknown>, selectedModel: string | undefined): void {
    const event = object(frame.event)
    if (frame.type === 'stream_event' && event.type === 'message_delta') {
      const output = tokenCount(object(event.usage).output_tokens)
      if (view.latest && output !== undefined && output >= (view.latest.output ?? 0)) view.latest = { ...view.latest, output }
      return
    }
    const message = object(frame.type === 'stream_event' ? event.message : frame.message)
    if (!message.usage || typeof message.id !== 'string') return
    const older = typeof frame.timestamp === 'string' && Number.isFinite(Date.parse(frame.timestamp)) && Date.parse(frame.timestamp) < Math.max(Date.parse(view.updatedAt), Date.parse(view.contextUpdatedAt ?? view.updatedAt))
    if (older && view.latest) return
    const tokens = claudeTokens(message.usage)
    const nextModel = selectedModel ?? (typeof message.model === 'string' ? message.model : undefined)
    if (view.modelId !== nextModel) delete view.contextWindow
    view.latest = tokens; view.modelId = nextModel
    view.updatedAt = typeof frame.timestamp === 'string' ? frame.timestamp : new Date(this.now()).toISOString()
    contextReading(view, tokens.input, view.updatedAt)
  }
  elapsed(id: string, elapsed: unknown, contextWindow?: unknown): void {
    if (tokenCount(elapsed) === undefined && !tokenCount(contextWindow)) return
    if (this.deferred(id, () => this.elapsed(id, elapsed, contextWindow))) { this.preview(id, view => { turnEnd(view, elapsed, contextWindow) }); return }
    const ledger = this.ledger(id)
    const changed = ledger.view.elapsedMs !== tokenCount(elapsed) || ledger.view.contextWindow !== (tokenCount(contextWindow) || ledger.view.contextWindow)
    turnEnd(ledger.view, elapsed, contextWindow)
    // The turn's duration comes with its end, which is written at once.
    this.save(id, changed, true)
  }
  claudeResult(id: string, value: unknown): void {
    if (this.deferred(id, () => this.claudeResult(id, value))) {
      // The served model is the latest request's, which waits for the requests; the view's model names the same one.
      this.preview(id, view => {
        const frame = object(value)
        turnEnd(view, frame.duration_ms, view.modelId ? object(claudeModelUsage(frame.modelUsage, view.modelId)).contextWindow : undefined)
      })
      return
    }
    const frame = object(value); const ledger = this.data[id]
    const model = ledger?.latestId ? ledger.entries[ledger.latestId]?.model : undefined
    this.elapsed(id, frame.duration_ms, model ? object(claudeModelUsage(frame.modelUsage, model)).contextWindow : undefined)
  }
  /** What a Grok turn's end sets in a thread's view; `dated`, asked once it is set: whether the turn's time is the view's now. */
  private grokReading(view: ThreadUsage, selectedModel: string, params: Record<string, unknown>, dated: () => boolean): void {
    const usage = object(object(params.update).usage)
    const timestamp = tokenCount(object(params._meta).agentTimestampMs)
    if (view.latest && timestamp !== undefined && timestamp < Date.parse(view.updatedAt)) return
    view.latest = { input: tokenCount(usage.inputTokens), output: tokenCount(usage.outputTokens), cached: tokenCount(usage.cachedReadTokens), cacheWrite: tokenCount(usage.cacheCreationTokens) }
    view.modelId = selectedModel
    // Native turn usage aggregates model calls. It is not a current context size.
    view.contextUsed = undefined; view.contextWindow = undefined
    view.elapsedMs = tokenCount(usage.apiDurationMs); view.elapsedKind = 'api'
    if (timestamp !== undefined || dated()) view.updatedAt = new Date(timestamp ?? this.now()).toISOString()
  }
  grok(id: string, selectedModel: string, value: unknown, context?: NativeUsageContext): void {
    const params = object(value); const update = object(params.update); const usage = object(update.usage)
    if (update.sessionUpdate !== 'turn_completed' || !update.usage) return
    if (this.deferred(id, () => this.grok(id, selectedModel, value, context))) {
      // A turn Grok reports again carries the time it ended, older than the view's, so only a newer turn reads in the view.
      this.preview(id, view => { this.grokReading(view, selectedModel, params, () => true) })
      return
    }
    const meta = object(params._meta)
    const identity = typeof update.prompt_id === 'string' ? update.prompt_id
      : typeof meta.eventId === 'string' && tokenCount(meta.agentTimestampMs) !== undefined ? `${meta.eventId}:${meta.agentTimestampMs}` : undefined
    const tokens = (row: Record<string, unknown>): UsageTokens => ({ input: tokenCount(row.inputTokens), output: tokenCount(row.outputTokens), cached: tokenCount(row.cachedReadTokens), cacheWrite: tokenCount(row.cacheCreationTokens) })
    const ledger = this.ledger(id)
    if (identity && this.usageEnabled) {
      const models = Object.entries(object(usage.modelUsage)).sort(([a], [b]) => a.localeCompare(b))
      const rows = models.filter(([, row]) => Object.values(tokens(object(row))).some(value => value !== undefined))
      const at = tokenCount(meta.agentTimestampMs)
      const facts = { phase: context?.phase ?? 'replay', ...context,
        at: at !== undefined ? new Date(at).toISOString() : context?.at, groupId: identity } satisfies NativeUsageContext
      // Aggregate fallback and each exact model have independent identities. The aggregate retires
      // before exact rows arrive; a model's identity never depends on which model was observed first.
      // Reported aggregate cost remains exclusively in the old ledger.
      const detailedKey = JSON.stringify([id, identity])
      if (rows.length) {
        this.detailedGrokGroups.add(detailedKey)
        const groupRecordsHash = createHash('sha256').update(JSON.stringify(rows.map(([model]) =>
          this.key('row', id, this.grokRecord(identity, model))).sort())).digest('hex')
        this.publishUsage(id, this.grokRecord(identity), 'unknown', {}, facts, true, identity, false, true, groupRecordsHash)
        const aggregate = tokens(usage)
        // Cost-bearing legacy rows retain the whole turn, even when exact model projections were lost
        // on restart. A lower native aggregate is contradictory evidence, not a complete replacement.
        const legacyAggregate = ledger.entries[identity]?.tokens
        const aggregateRegresses = legacyAggregate !== undefined && (Object.keys(legacyAggregate) as (keyof UsageTokens)[]).some(field =>
          legacyAggregate[field] !== undefined && aggregate[field] !== undefined && aggregate[field]! < legacyAggregate[field]!)
        const priorRows = [...(this.projections.get(id) ?? [])].filter(([, row]) => !row.removed && row.modelId !== 'unknown' && row.groupKey === this.key('group', id, identity))
        const reportedModels = new Set(rows.map(([model]) => model))
        const missingKnownModel = priorRows.some(([, row]) => row.modelId !== 'unknown' && !reportedModels.has(row.modelId))
        const regresses = rows.some(([model, source]) => {
          const previous = this.projections.get(id)?.get(this.grokRecord(identity, model))?.tokens
          const reported = tokens(object(source))
          return previous !== undefined && (Object.keys(previous) as (keyof UsageTokens)[]).some(field =>
            previous[field] !== undefined && reported[field] !== undefined && reported[field]! < previous[field]!)
        })
        const incomplete = ledger.incomplete || (Object.keys(aggregate) as (keyof UsageTokens)[]).some(field => {
          if (aggregate[field] === undefined) return false
          const values = rows.map(([, row]) => tokens(object(row))[field])
          return values.some(value => value === undefined) || values.reduce<number>((sum, value) => sum + (value ?? 0), 0) !== aggregate[field]
        })
        if (missingKnownModel || regresses || aggregateRegresses || this.ambiguousGrokGroups.has(detailedKey) && incomplete) this.ambiguousGrokGroups.add(detailedKey)
        else this.ambiguousGrokGroups.delete(detailedKey)
        const ambiguous = this.ambiguousGrokGroups.has(detailedKey)
        if (ambiguous) for (const [key, row] of priorRows) this.publishUsage(id, key, row.modelId, {}, facts, true, identity, true)
        for (const [model, row] of rows) {
          this.publishUsage(id, this.grokRecord(identity, model),
            model, ambiguous ? {} : tokens(object(row)), facts, ambiguous || incomplete, identity, ambiguous)
        }
      } else if (this.detailedGrokGroups.has(detailedKey)) {
        // An aggregate without model evidence cannot replace any individual model's count.
        this.ambiguousGrokGroups.add(detailedKey)
        for (const [key, row] of this.projections.get(id) ?? []) {
          if (!row.removed && row.modelId !== 'unknown' && row.groupKey === this.key('group', id, identity)) this.publishUsage(id, key, row.modelId, {}, facts, true, identity, true)
        }
      } else if (!this.detailedGrokGroups.has(detailedKey)) {
        this.publishUsage(id, this.grokRecord(identity), 'unknown', tokens(usage), facts, true, identity)
      }
    }
    if (identity && this.seen(ledger).has(identity)) { this.writePending(); return }
    const before = JSON.stringify([ledger.view, ledger.incomplete])
    if (identity) {
      this.see(ledger, identity)
      const models = Object.entries(object(usage.modelUsage))
      const ticks = tokenCount(usage.costUsdTicks)
      // Grok reports what the turn cost (docs.x.ai cost tracking: 1 USD = 10^10 ticks). Its Build models have no published list price.
      if (ticks !== undefined) this.record(ledger, identity, models.length === 1 ? models[0]![0] : selectedModel, tokens(usage), { usd: ticks / 10_000_000_000, rate: GROK_REPORTED_COST })
      else if (models.length) for (const [model, row] of models) this.record(ledger, `${identity}:${model}`, model, tokens(object(row)))
      else this.record(ledger, identity, selectedModel, tokens(usage))
    } else ledger.incomplete = true
    this.grokReading(ledger.view, selectedModel, params, () => identity !== undefined || before !== JSON.stringify([ledger.view, ledger.incomplete]))
    // Grok reports usage once, at the turn's end, which is written at once.
    this.save(id, identity !== undefined || before !== JSON.stringify([ledger.view, ledger.incomplete]), true)
  }
}
