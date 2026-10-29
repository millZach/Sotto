import { createHash } from 'node:crypto'
import { open, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { watcherOperationSchema, watcherPromptTurnSchema, watcherRequestSchema, type WatcherOperation, type WatcherPromptTurn,
  type WatcherRecord, type WatcherRequest } from '../../shared/watcher'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { retryWindowsFileOperation } from '../storage/windowsFileRetry'

/**
 * Watcher's archive (#1759, ADR-0073 amendment of October 28, 2026): the closed work Watcher's live record no longer keeps.
 * The live record keeps every request that is not closed, every closed request something still names, and the newest
 * `WATCHER_LIVE_CLOSED_REQUESTS` closed ones with their operations and prompt turns. Older closed work moves here, to a
 * file beside `agents.json`, written only when work is archived, and read back only when a Watcher conversation is shown
 * back to the messages it belongs to, so every receipt card, takeover line and user message there shows as it did.
 */
export const WATCHER_LIVE_CLOSED_REQUESTS = 200
/** Work is archived this many requests at a time, so the record is rewritten for it once per this many closed requests. */
export const WATCHER_ARCHIVE_BATCH = 50
/** The archive's batches, one JSON line each. */
export const WATCHER_ARCHIVE_FILE = 'watcher-archive.jsonl'
/** Where each batch is in the archive file and the times it spans, so a read reads only the batches it needs. */
export const WATCHER_ARCHIVE_INDEX = 'watcher-archive.json'
/**
 * How far a request's own times may sit from its message's: the request is made as its message is admitted, so a batch
 * whose newest time is this much older than a conversation's oldest message held holds nothing that message's page shows.
 */
const RECALL_SLACK_MS = 60 * 60 * 1_000

/** What one batch, or one read back, holds: closed requests, their operations and the prompt turns those name. */
export interface WatcherArchived {
  readonly requests: readonly WatcherRequest[]
  readonly operations: readonly WatcherOperation[]
  readonly promptTurns: readonly WatcherPromptTurn[]
}
export const NOTHING_ARCHIVED: WatcherArchived = Object.freeze({ requests: Object.freeze([]), operations: Object.freeze([]), promptTurns: Object.freeze([]) })

const time = z.string().datetime()
const batchSchema = z.object({ version: z.literal(1), from: time, through: time, requests: z.array(watcherRequestSchema),
  operations: z.array(watcherOperationSchema), promptTurns: z.array(watcherPromptTurnSchema) }).strict()
type Batch = z.infer<typeof batchSchema>
/**
 * The compact index of one batch (#1759): where it is in the file, the times it spans, and the identities a lookup by ID
 * needs without reading it: its requests, each with the version archived (`watcherWorkVersion`); each operation with its request, retry key and prompt turn, the thread it
 * counts a prompt against (a start or send not refunded) or null, and the message it put in its thread or null; and the
 * threads Watcher started. About 40 bytes a request and 260 an operation.
 */
const indexEntrySchema = z.object({ offset: z.number().int().nonnegative(), length: z.number().int().positive(), from: time, through: time,
  requests: z.array(z.tuple([z.string(), z.string()])), operations: z.array(z.tuple([z.string(), z.string(), z.string(), z.string().nullable(), z.string().nullable(), z.string().nullable()])),
  started: z.array(z.tuple([z.string(), z.string()])) }).strict()
const indexSchema = z.object({ version: z.literal(1), batches: z.array(indexEntrySchema) }).strict()
type ArchiveIndex = z.infer<typeof indexSchema>
type IndexEntry = z.infer<typeof indexEntrySchema>
const emptyIndex = (): ArchiveIndex => ({ version: 1, batches: [] })

/** A thread's key in the archive's index and lookups. */
export const archivedTargetKey = (target: { readonly hostId: string; readonly threadId: string }): string => `${target.hostId}\n${target.threadId}`
const targetKey = archivedTargetKey
const closed = (request: Readonly<WatcherRequest>): boolean => request.state !== 'active'
/** An operation whose delivery Sotto has not settled yet: it and its request stay in the live record until it has. */
const unsettled = (operation: Readonly<WatcherOperation>): boolean => operation.creationUncertain === true
  || operation.deliveryState === 'queued' || operation.deliveryState === 'dispatching' || operation.deliveryState === 'uncertain'

/** How many closed requests the record holds: the quick check for whether archiving could be due. */
export function closedWatcherRequests(record: Readonly<WatcherRecord>): number {
  let count = 0
  for (const request of record.requests) if (closed(request)) count++
  return count
}

/**
 * The closed requests that may leave the live record now, oldest first: every closed request older than the newest
 * `WATCHER_LIVE_CLOSED_REQUESTS`, unless something still names it or its work.
 *
 * Kept in the record whatever their age:
 * - a request a paired desktop made here (`remoteOrigin`): that desktop may still read any of its operations exactly, and
 *   a read this host cannot answer fences the operation as never recorded;
 * - a request a reservation names, or a local takeover's boundary (`localTakeovers[].lastRequestId`), whose order fences
 *   the requests before it;
 * - for each thread the user took over, the newest request that records it: a takeover with no local record, or on a
 *   paired thread, fences later requests by that participation alone;
 * - a request with an instruction still queued for Watcher (a user follow-up with no message yet);
 * - a request whose stopped participation holds its thread's queue for the user's review (`preserveUserQueue`);
 * - a request with an operation whose delivery is unsettled, that a reservation or an exact read's fence names, or that
 *   `retains` keeps (Watcher's own in-memory work on it: a dispatch in flight, a check holding its place, an outcome still
 *   being observed).
 */
export function archivableWatcherRequests(record: Readonly<WatcherRecord>, retains: (operation: Readonly<WatcherOperation>) => boolean = () => false): string[] {
  const keep = new Set<string>()
  for (const reservation of record.reservations) keep.add(reservation.requestId)
  for (const takeover of record.localTakeovers ?? []) if (takeover.lastRequestId !== null) keep.add(takeover.lastRequestId)
  const fenced = new Set((record.remoteAbsences ?? []).map(item => item.operationId))
  const reserved = new Set(record.reservations.map(item => item.operationId))
  for (const operation of record.operations) {
    if (unsettled(operation) || fenced.has(operation.id) || reserved.has(operation.id) || retains(operation)) keep.add(operation.requestId)
  }
  const takenOver = new Set<string>()
  for (let index = record.requests.length - 1; index >= 0; index--) {
    const request = record.requests[index]!
    for (const participant of request.participants) {
      if (participant.state !== 'taken-over') continue
      const target = targetKey(participant.target)
      if (!takenOver.has(target)) { takenOver.add(target); keep.add(request.id) }
    }
  }
  const archivable: string[] = []
  let newer = 0
  for (let index = record.requests.length - 1; index >= 0; index--) {
    const request = record.requests[index]!
    if (!closed(request)) continue
    if (newer < WATCHER_LIVE_CLOSED_REQUESTS) { newer++; continue }
    if (request.remoteOrigin || keep.has(request.id) || request.userFollowups?.some(item => item.messageId === undefined)) continue
    // A thread whose automation was stopped holds its own queue for the user's review until the user clears it; the
    // request that records the stop is the hold, so it stays.
    if (request.participants.some(participant => participant.state === 'participating'
      && (participant.automationStopped === true || request.state === 'stopped' && participant.startedBy === 'watcher'))) continue
    archivable.push(request.id)
  }
  return archivable.reverse()
}

/** The batch archiving `ids` writes: those requests, their operations and the prompt turns the operations name. */
export function watcherArchiveBatch(record: Readonly<WatcherRecord>, ids: readonly string[]): WatcherArchived {
  const wanted = new Set(ids)
  const requests = record.requests.filter(request => wanted.has(request.id))
  const operations = record.operations.filter(operation => wanted.has(operation.requestId))
  const turns = new Set(operations.flatMap(operation => operation.promptTurnId ? [operation.promptTurnId] : []))
  const promptTurns = (record.promptTurns ?? []).filter(turn => turns.has(turn.id))
  return { requests, operations, promptTurns }
}

/** Takes `ids` out of a record being changed: the requests and their operations. Prompt turns are left to their own pruning. */
export function removeArchivedWork(record: WatcherRecord, ids: ReadonlySet<string>): void {
  record.requests = record.requests.filter(request => !ids.has(request.id))
  record.operations = record.operations.filter(operation => !ids.has(operation.requestId))
}

/** The earliest and latest times a batch's work names, for the index. */
function span(batch: WatcherArchived): { from: string; through: string } {
  let from = Number.POSITIVE_INFINITY, through = Number.NEGATIVE_INFINITY
  const see = (value: string | null | undefined): void => {
    if (!value) return
    const at = Date.parse(value)
    if (at < from) from = at
    if (at > through) through = at
  }
  for (const request of batch.requests) {
    see(request.createdAt); see(request.closedAt)
    for (const participant of request.participants) see(participant.takeover?.at)
  }
  for (const operation of batch.operations) { see(operation.createdAt); see(operation.updatedAt); see(operation.outcomeAt) }
  for (const turn of batch.promptTurns) see(turn.createdAt)
  if (!Number.isFinite(from)) from = through = 0
  return { from: new Date(from).toISOString(), through: new Date(through).toISOString() }
}

/** A Watcher conversation's messages as main holds them now: their IDs, and the oldest one's time. */
export interface WatcherHeldMessages {
  readonly threadId: string
  readonly ids: ReadonlySet<string>
  readonly from: string
}

/**
 * What of `batches` a conversation's held messages show: the requests rooted in or continued by one of them or taken over
 * after the oldest, the prompt turns one of them began, and those turns' operations.
 */
function placedOn(batches: readonly WatcherArchived[], held: WatcherHeldMessages): WatcherArchived {
  const since = Date.parse(held.from)
  const requests: WatcherRequest[] = [], promptTurns: WatcherPromptTurn[] = [], operations: WatcherOperation[] = []
  const turns = new Set<string>(), seen = new Set<string>()
  // Newest first, so a request archived again in a later batch is shown as that batch holds it.
  for (const batch of [...batches].reverse()) {
    for (const request of batch.requests) {
      if (request.watcher.threadId !== held.threadId || seen.has(request.id)) continue
      if (held.ids.has(request.rootUserMessageId) || request.userFollowups?.some(item => item.messageId !== undefined && held.ids.has(item.messageId))
        || request.participants.some(participant => participant.takeover && Date.parse(participant.takeover.at) >= since)) { requests.push(request); seen.add(request.id) }
    }
    for (const turn of batch.promptTurns) {
      if (turn.watcher.threadId === held.threadId && turn.rootUserMessageId !== undefined && held.ids.has(turn.rootUserMessageId) && !turns.has(turn.id)) {
        turns.add(turn.id); promptTurns.push(turn)
      }
    }
  }
  const operationIds = new Set<string>()
  for (const batch of [...batches].reverse()) for (const operation of batch.operations) {
    if (operation.promptTurnId !== undefined && turns.has(operation.promptTurnId) && !operationIds.has(operation.id)) { operationIds.add(operation.id); operations.push(operation) }
  }
  return requests.length || operations.length || promptTurns.length ? { requests, operations, promptTurns } : NOTHING_ARCHIVED
}

/**
 * Which version of a request and its work this is: a digest of the request and its operations as they stand. A request
 * that changed after a batch archived it, as by a takeover recorded while that batch was written, has another version, so
 * it is archived again before the record lets go of it.
 */
export function watcherWorkVersion(request: Readonly<WatcherRequest>, operations: readonly Readonly<WatcherOperation>[]): string {
  return createHash('sha256').update(JSON.stringify([request, operations.filter(operation => operation.requestId === request.id)])).digest('hex')
}
/** Each request's operations, in order, read once for the whole batch. */
function operationsByRequest(operations: readonly WatcherOperation[]): Map<string, WatcherOperation[]> {
  const by = new Map<string, WatcherOperation[]>()
  for (const operation of operations) { const list = by.get(operation.requestId); if (list) list.push(operation); else by.set(operation.requestId, [operation]) }
  return by
}

/** The identities `indexEntrySchema` keeps for a batch. */
function identities(batch: WatcherArchived): Pick<IndexEntry, 'requests' | 'operations' | 'started'> {
  const owned = operationsByRequest(batch.operations as WatcherOperation[])
  const started = new Map<string, [string, string]>()
  for (const operation of batch.operations) if (operation.action === 'start') started.set(targetKey(operation.target), [operation.target.hostId, operation.target.threadId])
  for (const request of batch.requests) for (const participant of request.participants) {
    if (participant.startedBy === 'watcher') started.set(targetKey(participant.target), [participant.target.hostId, participant.target.threadId])
  }
  return { requests: batch.requests.map(request => [request.id, watcherWorkVersion(request, owned.get(request.id) ?? [])] as [string, string]),
    operations: batch.operations.map(operation => [operation.id, operation.requestId, operation.retryKey, operation.promptTurnId ?? null,
      (operation.action === 'start' || operation.action === 'send') && !operation.promptRefunded ? targetKey(operation.target) : null,
      operation.messageId !== undefined ? `${targetKey(operation.target)}\n${operation.messageId}` : null] as [string, string, string, string | null, string | null, string | null]),
    started: [...started.values()] }
}

/** A batch of archived work whose work the archive could not read: a lookup by ID refuses rather than call it absent. */
export class WatcherArchiveUnreadable extends Error {
  constructor() { super('Watcher’s archive could not be read.') }
}

/** Writes all of `bytes` at the end of `file`, however many writes it takes. */
async function writeAll(file: { write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }> }, bytes: Uint8Array): Promise<void> {
  for (let done = 0; done < bytes.byteLength;) {
    const { bytesWritten } = await file.write(bytes, done, bytes.byteLength - done)
    if (!(bytesWritten > 0)) throw new Error('Watcher’s archive could not be written.')
    done += bytesWritten
  }
}

/**
 * One archived batch: on disk at its index entry, or held in memory while Keep local history is off. `thisRun` marks a
 * batch this run wrote, which turning history off keeps in memory rather than lets go of, as the conversation's own words.
 */
type Slot = { readonly entry: IndexEntry; readonly held?: Batch; readonly thisRun?: true }
/** How the archive opens its file: `node:fs/promises`' `open`, or a stand-in in a test. */
export type WatcherArchiveOpen = (path: string, flags: string) => Promise<{
  write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  sync(): Promise<void>; close(): Promise<void> }>

/**
 * The archive on disk while Keep local history is on, and in memory for this run while it is off, as Watcher's
 * conversations themselves are kept (CONTEXT.md, **Watcher's archive**). Turning history off removes the file; turning it
 * back on writes what this run archived. Reads and writes go one at a time.
 *
 * Its compact index is read once, at start, and kept in memory, so a lookup by ID (a retry of archived work, an archived
 * operation's read) knows which batch to read without reading any; nothing on the update path reads the archive.
 */
export class WatcherArchive {
  private readonly index: AtomicJsonStore<ArchiveIndex>
  private slots: Slot[] = []
  private requestSlot = new Map<string, Slot>()
  private operationSlot = new Map<string, Slot>()
  private retries = new Map<string, string>()
  private retryKeys = new Map<string, string[]>()
  private turnSlots = new Map<string, Slot[]>()
  /** Each batch's place in the order it was archived, given as it is added, so a read orders only the batches it reads. */
  private ordinals = new Map<Slot, number>()
  private nextOrdinal = 0
  /** The newest version archived of each request (`watcherWorkVersion`). */
  private versions = new Map<string, string>()
  /** Each archived operation's message in its thread, as `host\nthread\nmessage`. */
  private messages = new Set<string>()
  /** Each prompt turn's archived operations that count a prompt, with the thread each counts against. */
  private turnPromptsOf = new Map<string, [string, string][]>()
  /** Moves whenever the archive holds different batches, so a reader can tell its read back is out of date. */
  private changes = 0
  private startedTargets = new Set<string>()
  /** The newest time any batch names, kept as batches are added, so a look on a read path costs the same however many there are. */
  private latest: string | undefined
  private tail: Promise<unknown>
  private loaded = false
  constructor(private readonly directory: string, private readonly historyEnabled: () => boolean,
    private readonly openFile: WatcherArchiveOpen = (path, flags) => open(path, flags)) {
    this.index = new AtomicJsonStore(join(directory, WATCHER_ARCHIVE_INDEX), input => indexSchema.parse(input), emptyIndex)
    this.tail = this.load().catch(() => undefined)
  }
  private turn<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(work)
    this.tail = next
    return next
  }
  private async load(): Promise<void> {
    this.forget()
    if (this.historyEnabled()) for (const entry of (await this.index.read()).batches) this.add({ entry })
    else await this.removeSaved()
    this.loaded = true
  }
  private forget(): void {
    this.slots = []; this.requestSlot = new Map(); this.operationSlot = new Map(); this.retries = new Map(); this.retryKeys = new Map()
    this.turnSlots = new Map(); this.startedTargets = new Set(); this.latest = undefined; this.turnPromptsOf = new Map(); this.messages = new Set(); this.versions = new Map(); this.ordinals = new Map(); this.changes++
  }
  /** Which batches the archive holds, as a number that moves whenever they change. */
  get revision(): number { return this.changes }
  private add(slot: Slot): void {
    this.slots.push(slot)
    this.ordinals.set(slot, this.nextOrdinal++)
    this.changes++
    const { entry } = slot
    if (this.latest === undefined || entry.through > this.latest) this.latest = entry.through
    for (const [id, version] of entry.requests) { this.requestSlot.set(id, slot); this.versions.set(id, version) }
    for (const [id, requestId, retryKey, turnId, counts, message] of entry.operations) {
      if (message !== null) this.messages.add(message)
      if (turnId !== null && counts !== null) {
        const prompts = this.turnPromptsOf.get(turnId)
        if (!prompts) this.turnPromptsOf.set(turnId, [[id, counts]]); else if (!prompts.some(([other]) => other === id)) prompts.push([id, counts])
      }
      this.operationSlot.set(id, slot)
      this.retries.set(`${requestId}\n${retryKey}`, id)
      const same = this.retryKeys.get(retryKey)
      if (same) same.push(id); else this.retryKeys.set(retryKey, [id])
      if (turnId !== null) { const slots = this.turnSlots.get(turnId); if (!slots) this.turnSlots.set(turnId, [slot]); else if (!slots.includes(slot)) slots.push(slot) }
    }
    for (const [hostId, threadId] of entry.started) this.startedTargets.add(`${hostId}\n${threadId}`)
  }
  /** Settles once whatever was asked of the archive before it has settled. */
  settled(): Promise<void> { return this.tail.then(() => undefined, () => undefined) }
  /** Settles once the index is read, so the lookups below answer for everything archived. */
  ready(): Promise<void> { return this.loaded ? Promise.resolve() : this.turn(async () => { if (!this.loaded) await this.load() }) }
  /** Whether this request was archived. */
  hasRequest(id: string): boolean { return this.requestSlot.has(id) }
  /** Whether this operation was archived. */
  hasOperation(id: string): boolean { return this.operationSlot.has(id) }
  /** The archived operation a request's retry key names, as `requestId:retryKey` names one operation in the record. */
  retryOperation(requestId: string, retryKey: string): string | undefined { return this.retries.get(`${requestId}\n${retryKey}`) }
  /** Every archived operation made with this retry key, whatever its request. */
  retryKeyOperations(retryKey: string): readonly string[] { return this.retryKeys.get(retryKey) ?? [] }
  /**
   * Whether an archived start or send put this message in this thread: it is Watcher's, never the user's. A look-up, so
   * the pass that asks of a watched thread's head on every update costs the same however much is archived.
   */
  sentMessage(target: { readonly hostId: string; readonly threadId: string }, messageId: string): boolean { return this.messages.has(`${targetKey(target)}\n${messageId}`) }
  /** The archived operations of a prompt turn that count a prompt, each with the thread key it counts against. */
  turnPrompts(turnId: string): readonly (readonly [string, string])[] { return this.turnPromptsOf.get(turnId) ?? [] }
  /** Whether Watcher started this thread, by an archived start or an archived participation it started. */
  started(hostId: string, threadId: string): boolean { return this.startedTargets.has(`${hostId}\n${threadId}`) }
  /** The newest time any archived work names, or undefined while nothing is archived (or the index is not read yet). */
  through(): string | undefined { return this.latest }
  /** Whether a conversation whose oldest held message is from `from` may show archived work. */
  reaches(from: string): boolean {
    const through = this.through()
    return through !== undefined && Date.parse(from) <= Date.parse(through) + RECALL_SLACK_MS
  }
  /** Adds a batch, before the live record lets go of it: a record saved without work never names work not yet archived. */
  append(work: WatcherArchived): Promise<void> {
    return this.turn(async () => {
      if (!this.loaded) await this.load()
      const batch: Batch = { version: 1, ...span(work), requests: [...work.requests], operations: [...work.operations], promptTurns: [...work.promptTurns] }
      if (!this.historyEnabled()) { this.add({ entry: { offset: 0, length: 1, from: batch.from, through: batch.through, ...identities(batch) }, held: batch }); return }
      await this.writeBatches([batch])
    })
  }
  private async writeBatches(batches: readonly Batch[]): Promise<void> {
    const path = join(this.directory, WATCHER_ARCHIVE_FILE)
    let offset = await stat(path).then(file => file.size, (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    })
    const added: IndexEntry[] = []
    const file = await retryWindowsFileOperation(() => this.openFile(path, 'a'))
    try {
      for (const batch of batches) {
        const bytes = Buffer.from(`${JSON.stringify(batch)}\n`, 'utf8')
        await writeAll(file, bytes)
        added.push({ offset, length: bytes.byteLength - 1, from: batch.from, through: batch.through, ...identities(batch) })
        offset += bytes.byteLength
      }
      await file.sync()
    } finally { await file.close() }
    const entries = [...this.slots.flatMap(slot => slot.held ? [] : [slot.entry]), ...added]
    await this.index.write({ version: 1, batches: entries })
    // Only now that the batches are on disk and indexed does anything held in memory for them go. Archiving adds its
    // batch alone; writing what history-off held replaces those, which only turning history back on does.
    const written = new Set(batches)
    if (this.slots.some(slot => slot.held && written.has(slot.held))) {
      const kept = this.slots.filter(slot => !slot.held || !written.has(slot.held))
      this.forget(); for (const slot of kept) this.add(slot)
    }
    for (const entry of added) this.add({ entry, thisRun: true })
  }
  /** The batches in `slots`, from the file or memory. A batch that cannot be read is left out; the others still come. */
  private async readSlots(slots: readonly Slot[], strict = false): Promise<Batch[]> {
    // In the order they were archived, so a request archived again comes after its older version.
    const ordered = [...slots].sort((one, other) => (this.ordinals.get(one) ?? 0) - (this.ordinals.get(other) ?? 0))
    const read = new Map<Slot, Batch>()
    for (const slot of ordered) if (slot.held) read.set(slot, slot.held)
    const wanted = ordered.filter(slot => !slot.held)
    const inOrder = (): Batch[] => ordered.flatMap(slot => { const batch = read.get(slot); return batch ? [batch] : [] })
    if (!wanted.length) return inOrder()
    const file = await retryWindowsFileOperation(() => this.openFile(join(this.directory, WATCHER_ARCHIVE_FILE), 'r')).catch(() => undefined)
    if (!file) { if (strict) throw new WatcherArchiveUnreadable(); return inOrder() }
    try {
      for (const slot of wanted) {
        const { entry } = slot
        try {
          const bytes = Buffer.alloc(entry.length)
          const { bytesRead } = await file.read(bytes, 0, entry.length, entry.offset)
          if (bytesRead !== entry.length) throw new WatcherArchiveUnreadable()
          read.set(slot, batchSchema.parse(JSON.parse(bytes.toString('utf8'))))
        } catch (error) {
          // A damaged batch is left out of what a conversation shows; a lookup by ID refuses rather than call it absent.
          if (strict) throw error instanceof WatcherArchiveUnreadable ? error : new WatcherArchiveUnreadable()
        }
      }
    } finally { await file.close() }
    return inOrder()
  }
  /** The archived work a conversation's held messages show, reading only the batches as new as its oldest held message. */
  recall(held: WatcherHeldMessages): Promise<WatcherArchived> {
    return this.turn(async () => {
      if (!this.loaded) await this.load()
      const since = Date.parse(held.from) - RECALL_SLACK_MS
      return placedOn(await this.readSlots(this.slots.filter(slot => Date.parse(slot.entry.through) >= since)), held)
    })
  }
  /**
   * Archived work by ID, for a lookup that did not find it in the live record (#1759): every batch holding one of these
   * requests or operations, and the batches holding the rest of their operations' prompt turns, so prompts are counted as
   * they were. Read only for the IDs asked for, never on the update path.
   */
  read(ids: { readonly requests?: readonly string[]; readonly operations?: readonly string[] }): Promise<WatcherArchived> {
    return this.turn(async () => {
      if (!this.loaded) await this.load()
      const slots = new Set<Slot>()
      for (const id of ids.requests ?? []) { const slot = this.requestSlot.get(id); if (slot) slots.add(slot) }
      for (const id of ids.operations ?? []) { const slot = this.operationSlot.get(id); if (slot) slots.add(slot) }
      for (const slot of [...slots]) for (const [, , , turnId] of slot.entry.operations) if (turnId !== null) for (const other of this.turnSlots.get(turnId) ?? []) slots.add(other)
      if (!slots.size) return NOTHING_ARCHIVED
      const batches = await this.readSlots([...slots], true)
      // A batch archived again after a crash between its write and the record's save holds the same work twice: once each.
      const once = <T extends { readonly id: string }>(items: readonly T[]): T[] => [...new Map(items.map(item => [item.id, item] as const)).values()]
      return { requests: once(batches.flatMap(batch => batch.requests)), operations: once(batches.flatMap(batch => batch.operations)),
        promptTurns: once(batches.flatMap(batch => batch.promptTurns)) }
    })
  }
  /** Keep local history changed: off removes the saved archive, on saves what this run archived while it was off. */
  privacyChanged(): Promise<void> {
    return this.turn(async () => {
      if (!this.historyEnabled()) {
        // What this run archived stays, in memory, as this run's conversation does; what earlier runs saved goes.
        const mine = await this.readSlots(this.slots.filter(slot => !slot.held && slot.thisRun), true)
        const held = this.slots.filter(slot => slot.held)
        await this.removeSaved()
        this.forget()
        for (const slot of held) this.add(slot)
        for (const batch of mine) this.add({ entry: { offset: 0, length: 1, from: batch.from, through: batch.through, ...identities(batch) }, held: batch })
        this.loaded = true
        return
      }
      if (!this.loaded) await this.load()
      const held = this.slots.flatMap(slot => slot.held ? [slot.held] : [])
      if (held.length) await this.writeBatches(held)
    })
  }
  /** Whether the archive holds this request, on disk or in memory: what may leave the live record. */
  holds(id: string, version?: string): boolean { return this.requestSlot.has(id) && (version === undefined || this.versions.get(id) === version) }
  /** The archive, its index and anything the index's store left beside it. */
  private async removeSaved(): Promise<void> {
    const names = await readdir(this.directory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]
      throw error
    })
    await Promise.all(names.filter(name => name === WATCHER_ARCHIVE_FILE || name === WATCHER_ARCHIVE_INDEX || name.startsWith(`${WATCHER_ARCHIVE_INDEX}.`))
      .map(name => retryWindowsFileOperation(() => unlink(join(this.directory, name))).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })))
  }
}

