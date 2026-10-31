import { createHash } from 'node:crypto'
import { open, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { threadUsageSchema, usageTokensSchema, type ThreadUsage, type UsageTokens } from '../../shared/threadUsage'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
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
const legacyLedgersSchema = z.record(z.string(), ledgerSchema)
const emptyLedger = (): Ledger => ({ view: { rateVersions: [], partial: false, updatedAt: new Date().toISOString() }, entries: {}, seen: [], incomplete: false })
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
/**
 * The most threads' ledger files written at once. Moving an earlier build's one file across writes every thread's, and
 * opening hundreds of files together can run out of file handles, which would fail the very writes quitting waits for.
 */
const LEDGER_WRITES_AT_ONCE = 8

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

/**
 * Makes a folder's own entries durable, as the files renamed into it, where the system allows it: Windows opens no folder
 * to sync, and one that is not there has nothing to keep.
 */
async function syncFolder(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await open(path, 'r') }
  catch (error) { if (['ENOENT', 'EISDIR', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return; throw error }
  try { await handle.sync() }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
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
  private data: Record<string, Ledger> = {}
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
  constructor(directory: string, private readonly provider: 'codex' | 'claude' | 'grok', private readonly usageEnabled = false) {
    this.legacyPath = join(directory, `${provider}-usage.json`)
    this.legacyStore = AtomicJsonStore.compact(this.legacyPath, legacyLedgersSchema.parse, () => ({}))
    this.ledgerDirectory = join(directory, `${provider}-usage`)
  }
  private store(id: string): AtomicJsonStore<{ id: string; ledger: Ledger }> {
    let store = this.stores.get(id)
    if (!store) {
      store = AtomicJsonStore.compact(join(this.ledgerDirectory, ledgerFileName(id)), threadLedgerSchema.parse, () => ({ id, ledger: emptyLedger() }))
      this.stores.set(id, store)
    }
    return store
  }
  /** Every thread's ledger: the shared file of earlier builds, then each thread's own file over it. */
  private async readLedgers(): Promise<Record<string, Ledger>> {
    const data: Record<string, Ledger> = {}
    this.unmoved.clear()
    this.legacyPresent = await this.legacyStore.exists()
    if (this.legacyPresent) {
      for (const [id, ledger] of Object.entries(await this.legacyStore.read())) { data[id] = ledger; this.unmoved.add(id) }
    }
    const names = await readdir(this.ledgerDirectory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
    for (const name of names.filter(name => /^[0-9a-f]{40}\.json$/u.test(name))) {
      const read = await AtomicJsonStore.compact(join(this.ledgerDirectory, name), foundLedgerSchema.parse, () => null).read()
      // A file unreadable as a ledger has been set aside as the store sets any aside; its thread starts afresh.
      if (!read || ledgerFileName(read.id) !== name) continue
      data[read.id] = read.ledger
      this.unmoved.delete(read.id)
    }
    return data
  }
  async load(): Promise<void> {
    await this.flushed()
    this.streaming.clear()
    // A reconnect must not replace newer, unsaved observations with the old archive.
    if (this.failed.size) return
    this.data = await this.readLedgers()
    // A ledger only the shared file held is written to a file of its own, and the file goes once none is left only there.
    for (const id of this.unmoved) this.dirty.add(id)
    if (!this.unmoved.size) await this.removeLegacy()
    for (const [id, ledger] of Object.entries(this.data)) {
      let changed = false
      // A successfully read archive is durable; an old process's failure flag is not.
      if (ledger.view.persistenceError) { delete ledger.view.persistenceError; changed = true }
      for (const [key, entry] of Object.entries(ledger.entries)) {
        // Claude's own local notices carry no billed work.
        if (entry.model === SYNTHETIC) { delete ledger.entries[key]; changed = true; continue }
        // Usage recorded before its model had a price is priced once one exists; priced entries keep their rate.
        if (entry.usd !== undefined) continue
        const estimate = estimateUsage(this.provider, entry.model, entry.tokens)
        if (estimate) { ledger.entries[key] = { ...entry, usd: estimate.usd, ...(estimate.lowerBound ? { lowerBound: true } : {}), rate: USAGE_RATE_VERSION }; changed = true }
      }
      const before = JSON.stringify(ledger.view)
      this.summarize(ledger)
      changed ||= JSON.stringify(ledger.view) !== before
      if (changed) this.dirty.add(id)
    }
    this.writePending(true)
  }
  /** Drain the latest observations, retrying a prior failure once without spinning on a broken disk. */
  async flushed(): Promise<void> {
    this.draining += 1
    try {
      this.writePending(true)
      while (this.writing) await this.writing
    } finally { this.draining -= 1 }
  }
  get(id: string): ThreadUsage | undefined { return this.data[id]?.view }
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
  /** Already-loaded rows only; reading usage never starts native sessions. */
  visitUsage(id: string, visitor: (record: UsageTokenObservation) => void): void {
    if (!this.usageEnabled) return
    const ledger = this.data[id]
    if (!ledger) return
    const projected = this.projections.get(id)
    const emitted = new Set<string>()
    if (this.provider === 'grok') {
      const grokProjected = projected ?? new Map<string, UsageTokenObservation>()
      const identities = new Set(ledger.seen)
      for (const [key, entry] of Object.entries(ledger.entries)) {
        const aggregate = identities.has(key)
        // Legacy per-model entries are prompt identity + ':' + the exact saved model.
        const candidate = key.endsWith(`:${entry.model}`) ? key.slice(0, -entry.model.length - 1) : undefined
        const identity = aggregate ? key : candidate && identities.has(candidate) ? candidate : undefined
        if (!identity) continue
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
        if (emitted.has(record)) continue
        const existing = grokProjected.get(record)
        const row = existing ?? this.projected(id, record, aggregate ? 'unknown' : entry.model, entry.tokens, undefined,
          ledger.incomplete || aggregate, identity)
        if (!aggregate && !existing) { grokProjected.set(record, row); this.projections.set(id, grokProjected) }
        emitted.add(record)
        const seed = { ...row, tokens: { ...row.tokens } }; delete seed.liveNewGroup
        visitor(seed)
      }
      for (const [key, row] of grokProjected) {
        if (emitted.has(key)) continue
        const seed = { ...row, tokens: { ...row.tokens } }; delete seed.liveNewGroup
        visitor(seed)
      }
      return
    }
    for (const [key, entry] of Object.entries(ledger.entries)) {
      if (entry.model === SYNTHETIC) continue
      const anchor = key
      const existing = projected?.get(anchor)
      const row = existing ?? this.projected(id, anchor, entry.model, entry.tokens, undefined, ledger.incomplete,
        this.provider === 'claude' ? key : undefined)
      emitted.add(anchor)
      const seed = { ...row, tokens: { ...row.tokens } }; delete seed.liveNewGroup
      visitor(seed)
    }
    for (const [key, row] of projected ?? []) {
      if (emitted.has(key)) continue
      const seed = { ...row, tokens: { ...row.tokens } }; delete seed.liveNewGroup
      visitor(seed)
    }
  }
  compacted(id: string, used: unknown, updatedAt = new Date().toISOString()): void {
    const ledger = this.ledger(id)
    const changed = ledger.view.contextUsed !== tokenCount(used) || ledger.view.contextUpdatedAt !== updatedAt || ledger.contextCompacted !== true
    ledger.view.contextUsed = tokenCount(used)
    ledger.view.contextUpdatedAt = updatedAt
    ledger.contextCompacted = true
    this.save(id, changed, true)
  }
  private ledger(id: string): Ledger {
    const known = this.data[id]
    if (known) { this.serializedLedgers.delete(known); return known }
    return this.data[id] = emptyLedger()
  }
  private summarize(ledger: Ledger): void {
    const entries = Object.values(ledger.entries)
    const priced = entries.filter(entry => entry.usd !== undefined)
    ledger.view.estimatedUsd = priced.length ? priced.reduce((sum, entry) => sum + entry.usd!, 0) : undefined
    ledger.view.rateVersions = [...new Set(priced.map(entry => entry.rate))]
    ledger.view.partial = ledger.incomplete || entries.some(entry => entry.usd === undefined || entry.lowerBound === true)
    // Every recorded request, so the thread's tokens add up rather than showing only the latest request.
    const total: UsageTokens = {}
    for (const field of ['input', 'output', 'cached', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h'] as const) {
      const reported = entries.filter(entry => entry.tokens[field] !== undefined)
      if (reported.length) total[field] = reported.reduce((sum, entry) => sum + entry.tokens[field]!, 0)
    }
    ledger.view.total = Object.keys(total).length ? total : undefined
  }
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
    if (!this.dirty.size && !this.failed.size) return
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
          this.dirty.clear()
          this.urgent = false
          this.lastWriteAt = performance.now()
          // Each changed thread's ledger to its file, a few at a time; a failure is that thread's alone.
          const written = [...ids]
          const results = await settledInTurn(written, LEDGER_WRITES_AT_ONCE, id => this.store(id).writeSerialized([this.serialized(id)]))
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
        } while (this.dirty.size && (this.urgent || this.draining > 0))
      } finally {
        this.writing = undefined
        // What arrived during the write waits out the rest of the interval, unless a turn ended meanwhile.
        if (this.dirty.size) this.writePending(this.urgent)
      }
    })
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
    const ledger = this.ledger(id)
    const key = codexEntryKey(params.turnId, total)
    if (ledger.seen.includes(key)) {
      const entry = ledger.entries[key]
      if (entry) this.publishUsage(id, key, entry.model, entry.tokens, context, ledger.incomplete, String(params.turnId))
      this.writePending(); return
    }
    ledger.seen.push(key)
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
    ledger.view.latest = last
    ledger.view.modelId = model
    ledger.view.contextUsed = tokenCount(object(usage.last).totalTokens)
    ledger.view.contextWindow = tokenCount(usage.modelContextWindow) || undefined
    ledger.view.updatedAt = new Date().toISOString()
    ledger.view.contextUpdatedAt = ledger.view.updatedAt
    this.save(id)
  }
  claude(id: string, value: unknown, selectedModel?: string, context?: NativeUsageContext): void {
    const frame = object(value)
    // Native child usage is not projected as parent activity or silently double-billed.
    if (frame.parent_tool_use_id || frame.isSidechain === true) return
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
        ledger.view.updatedAt = typeof frame.timestamp === 'string' ? frame.timestamp : new Date().toISOString()
      }
      if (contextChanged) ledger.view.contextUpdatedAt = ledger.view.updatedAt
      ledger.contextCompacted = false
    }
    this.save(id, changed || before !== JSON.stringify([ledger.view, ledger.latestId, ledger.contextCompacted]))
  }
  elapsed(id: string, elapsed: unknown, contextWindow?: unknown): void {
    if (tokenCount(elapsed) === undefined && !tokenCount(contextWindow)) return
    const ledger = this.ledger(id)
    const changed = ledger.view.elapsedMs !== tokenCount(elapsed) || ledger.view.contextWindow !== (tokenCount(contextWindow) || ledger.view.contextWindow)
    ledger.view.elapsedMs = tokenCount(elapsed)
    ledger.view.contextWindow = tokenCount(contextWindow) || ledger.view.contextWindow
    // The turn's duration comes with its end, which is written at once.
    this.save(id, changed, true)
  }
  claudeResult(id: string, value: unknown): void {
    const frame = object(value); const ledger = this.data[id]
    const model = ledger?.latestId ? ledger.entries[ledger.latestId]?.model : undefined
    this.elapsed(id, frame.duration_ms, model ? object(claudeModelUsage(frame.modelUsage, model)).contextWindow : undefined)
  }
  grok(id: string, selectedModel: string, value: unknown, context?: NativeUsageContext): void {
    const params = object(value); const update = object(params.update); const usage = object(update.usage)
    if (update.sessionUpdate !== 'turn_completed' || !update.usage) return
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
    if (identity && ledger.seen.includes(identity)) { this.writePending(); return }
    const before = JSON.stringify([ledger.view, ledger.incomplete])
    if (identity) {
      ledger.seen.push(identity)
      const models = Object.entries(object(usage.modelUsage))
      const ticks = tokenCount(usage.costUsdTicks)
      // Grok reports what the turn cost (docs.x.ai cost tracking: 1 USD = 10^10 ticks). Its Build models have no published list price.
      if (ticks !== undefined) this.record(ledger, identity, models.length === 1 ? models[0]![0] : selectedModel, tokens(usage), { usd: ticks / 10_000_000_000, rate: GROK_REPORTED_COST })
      else if (models.length) for (const [model, row] of models) this.record(ledger, `${identity}:${model}`, model, tokens(object(row)))
      else this.record(ledger, identity, selectedModel, tokens(usage))
    } else ledger.incomplete = true
    const timestamp = tokenCount(meta.agentTimestampMs)
    if (!ledger.view.latest || timestamp === undefined || timestamp >= Date.parse(ledger.view.updatedAt)) {
      ledger.view.latest = tokens(usage); ledger.view.modelId = selectedModel
      // Native turn usage aggregates model calls. It is not a current context size.
      ledger.view.contextUsed = undefined; ledger.view.contextWindow = undefined
      ledger.view.elapsedMs = tokenCount(usage.apiDurationMs); ledger.view.elapsedKind = 'api'
      if (identity || timestamp !== undefined || before !== JSON.stringify([ledger.view, ledger.incomplete])) {
        ledger.view.updatedAt = new Date(timestamp ?? Date.now()).toISOString()
      }
    }
    // Grok reports usage once, at the turn's end, which is written at once.
    this.save(id, identity !== undefined || before !== JSON.stringify([ledger.view, ledger.incomplete]), true)
  }
}
