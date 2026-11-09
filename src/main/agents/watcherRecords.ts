import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { AgentThread } from '../../shared/agents'
import { clonePlainData, freezePlainData } from './cloneHostSnapshot'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { WatcherMessageDisplay } from './watcherMessageDisplay'
import { NOTHING_ARCHIVED, removeArchivedWork, WATCHER_ARCHIVE_BATCH, WatcherArchive, watcherArchiveBatch, watcherWorkVersion, type WatcherArchived } from './watcherArchive'
import { WATCHER_RECORD_FILE } from './watcherRecordFile'
import { watcherRecordSchema, emptyWatcherRecord, type WatcherRecord, type WatcherRequest } from '../../shared/watcher'

const targetKey = (target: { readonly hostId: string; readonly threadId: string }): string => JSON.stringify([target.hostId, target.threadId])

/**
 * The most reservations the saved record holds. A build from before #1183 reads the Watcher record with at most eight, the
 * most its Threads in flight limit allowed, and a record it cannot read in `agents.json` costs it the whole file: drafts,
 * outbox and configuration go with it. So Sotto still writes no more than eight, whatever is in flight now, and rebuilds
 * the rest when it reads the record again (`rebuildReservations`). They only count Watcher's starts still working; none
 * holds anything back. Since the record has a file of its own (`WATCHER_RECORD_FILE`), such a build reads none of it.
 */
export const WATCHER_SAVED_RESERVATIONS_MAX = 8

/**
 * The Watcher record as its saved file holds it: the live record itself while it has eight reservations or fewer, so
 * nothing is copied, and otherwise a shallow copy with eight, those whose delivery is still unresolved first.
 */
export function watcherRecordForDisk(record: WatcherRecord): WatcherRecord {
  if (record.reservations.length <= WATCHER_SAVED_RESERVATIONS_MAX) return record
  const unresolved = new Set<string>()
  for (const operation of record.operations) {
    if (operation.creationUncertain || operation.deliveryState === 'queued' || operation.deliveryState === 'dispatching' || operation.deliveryState === 'uncertain') unresolved.add(targetKey(operation.target))
  }
  const first = record.reservations.filter(item => unresolved.has(targetKey(item.target)))
  const rest = record.reservations.filter(item => !unresolved.has(targetKey(item.target)))
  return { ...record, reservations: [...first, ...rest].slice(0, WATCHER_SAVED_RESERVATIONS_MAX) }
}

/**
 * Puts back the reservations `watcherRecordForDisk` left off: one for each thread a start of an active request's
 * participating thread still names, unless it failed. It runs on every recovery, not only on a record saved at the cap:
 * the threads Sotto observes before Watcher recovers can already have pruned one that was. Says whether it put any back,
 * for the caller to prune what its threads no longer need, as it does after every snapshot.
 */
export function rebuildReservations(record: WatcherRecord): boolean {
  const before = record.reservations.length
  const reserved = new Set(record.reservations.map(item => targetKey(item.target)))
  const requests = new Map(record.requests.map(request => [request.id, request]))
  for (const operation of record.operations) {
    if (operation.action !== 'start' || operation.deliveryState === 'failed' || reserved.has(targetKey(operation.target))) continue
    const request = requests.get(operation.requestId)
    const participant = request?.state === 'active' ? request.participants.find(item => targetKey(item.target) === targetKey(operation.target)) : undefined
    if (participant?.state !== 'participating') continue
    record.reservations.push({ target: operation.target, requestId: operation.requestId, operationId: operation.id, generation: participant.generation, reason: 'creation' })
    reserved.add(targetKey(operation.target))
  }
  return record.reservations.length > before
}

/** Older stores carry no Watcher record. Migration never adopts a thread by its title or legacy assignment. */
export function migrateWatcherRecord(input: unknown): WatcherRecord {
  return input === undefined ? emptyWatcherRecord() : watcherRecordSchema.parse(input)
}

/**
 * Prompt turns kept beyond those in use, so a retried send still finds the turn it opened. A message sent again only after
 * this many newer turns, whose own turn Watcher never acted in, opens a second budget; nothing was spent from the first.
 */
export const WATCHER_PROMPT_TURNS_KEPT = 50

/**
 * Drops the prompt turns nothing reads any more. Prompts are counted against the turn an operation names, the newest
 * turn of each Watcher is the one its next prompt counts against, and a recent turn stops a resent message opening a
 * second budget; every other turn only grew the record, which main copies on every update. Turns stay in order.
 */
export function prunePromptTurns(record: WatcherRecord): void {
  const turns = record.promptTurns
  if (!turns || turns.length <= WATCHER_PROMPT_TURNS_KEPT) return
  const counted = new Set(record.operations.flatMap(operation => operation.promptTurnId ? [operation.promptTurnId] : []))
  const newest = new Set<string>(), watchers = new Set<string>()
  for (let index = turns.length - 1; index >= 0; index--) {
    const watcher = JSON.stringify([turns[index]!.watcher.hostId, turns[index]!.watcher.threadId])
    if (!watchers.has(watcher)) { watchers.add(watcher); newest.add(turns[index]!.id) }
  }
  const recent = turns.length - WATCHER_PROMPT_TURNS_KEPT
  record.promptTurns = turns.filter((turn, index) => index >= recent || counted.has(turn.id) || newest.has(turn.id))
}

/** Older workspace records are ordinary projects; explicit special kinds must survive validation. */
export function migrateWorkspaceThreadKinds(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const snapshot = input as Record<string, unknown>
  if (!Array.isArray(snapshot.threads)) return input
  return { ...snapshot, threads: snapshot.threads.map((thread: unknown) => {
    if (!thread || typeof thread !== 'object' || Array.isArray(thread)) return thread
    const record = thread as Record<string, unknown>
    return record.kind === undefined ? { ...record, kind: 'project' } : record
  }) }
}

const savedWatcherFileSchema = z.object({ watcher: z.unknown().optional() })
/** A mutable copy and the immutable record it was copied from. */
export interface WatcherDraft { readonly from: Readonly<WatcherRecord>; readonly record: WatcherRecord }

/** Owns Watcher's saved record, archive views and file-write identity; Control orders the combined save. */
export class WatcherRecords {
  private watcher: WatcherRecord = emptyWatcherRecord()
  /**
   * Whether the record may hold prompt turns nothing reads, as one loaded from a file saved before they were let go of
   * can. Every change lets go of them, so only loading sets this.
   */
  private watcherUnpruned = false
  readonly display: WatcherMessageDisplay | undefined
  /** Watcher's archive (#1759): the closed work the live record let go of. Only where Watcher runs. */
  readonly archive: WatcherArchive | undefined
  /**
   * The archived work each Watcher conversation shows back to the oldest message main holds for it, read when that
   * conversation was shown that far back (#1759), by thread: the oldest held message it was read for, and the work.
   */
  private readonly watcherRecalls = new Map<string, { readonly from: string; readonly revision: number; readonly work: WatcherArchived }>()
  /** The threads a recall is under way for. */
  private readonly watcherRecalling = new Set<string>()
  /** Every recalled conversation's work together, made again only when a recall changes. */
  private watcherRecalled: WatcherArchived = NOTHING_ARCHIVED
  /** The requests Watcher's conversations are shown through: the live record's, after the recalled ones when there are any. */
  private watcherShown: { from: WatcherRecord['requests']; recalled: WatcherArchived; requests: readonly WatcherRequest[] } | undefined
  private readonly store: AtomicJsonStore<{ watcher: WatcherRecord }>
  private queuedWatcherWrite: { record: WatcherRecord; text: string; written: Promise<void> } | undefined
  own: WatcherRecord | undefined

  constructor(private readonly options: { directory: string; enabled: boolean; historyEnabled: () => boolean;
    disposed: () => boolean; persist: () => Promise<void>; reshow: () => void }) {
    this.display = options.enabled ? new WatcherMessageDisplay() : undefined
    this.archive = options.enabled ? new WatcherArchive(options.directory, options.historyEnabled) : undefined
    this.store = AtomicJsonStore.compact(join(options.directory, WATCHER_RECORD_FILE),
      input => ({ watcher: migrateWatcherRecord(savedWatcherFileSchema.parse(input).watcher) }), () => ({ watcher: emptyWatcherRecord() }))
  }

  async readOwn(): Promise<void> {
    if (await this.store.exists()) this.own = (await this.store.read()).watcher
  }

  restore(legacy: WatcherRecord): void {
    this.watcher = this.own ?? legacy
    freezePlainData(this.watcher)
    if (this.own) this.queuedWatcherWrite = { record: this.forDisk(), text: this.watcherFileText(this.forDisk()), written: Promise.resolve() }
    this.watcherUnpruned = this.options.enabled && (this.watcher.promptTurns?.length ?? 0) > WATCHER_PROMPT_TURNS_KEPT
    this.display?.update(this.requestsShown())
  }

  /** A copy of the Watcher record to change. It is plain schema data, so its containers are copied and its strings kept. */
  copy(): WatcherRecord { return clonePlainData(this.watcher) }
  /**
   * The Watcher record itself, for a caller that only reads it. Every change replaces the record rather than editing it
   * (mutateWatcher, start), so what this hands out never changes under its holder. Watcher's observe pass reads the
   * record per thread on every update; copying it each time cost main more than the rest of the pass.
   */
  view(): Readonly<WatcherRecord> { return this.watcher }
  /**
   * The archived work Watcher's conversations show back to the oldest message main holds for them (#1759): nothing until
   * a conversation is shown that far back. Never copied, and the same object until a recall changes it.
   */
  recalledWork(): WatcherArchived { return this.watcherRecalled }
  /** The requests Watcher's conversations are shown through: the recalled ones, oldest, then the live record's. */
  requestsShown(): readonly WatcherRequest[] {
    const recalled = this.watcherRecalled
    if (recalled.requests.length === 0) return this.watcher.requests
    const shown = this.watcherShown
    if (shown?.from === this.watcher.requests && shown.recalled === recalled) return shown.requests
    const live = new Set(this.watcher.requests.map(request => request.id))
    const requests = [...recalled.requests.filter(request => !live.has(request.id)), ...this.watcher.requests]
    this.watcherShown = { from: this.watcher.requests, recalled, requests }
    return requests
  }
  /**
   * Archives the closed work `ids` names (#1759): writes it to Watcher's archive first, then lets the live record go of
   * what `stillArchivable` still allows, so a record saved without some work never names work the archive does not hold.
   * A request something came to name while the archive was written stays in the record, and in the archive too; a read
   * back prefers the record's. Says how many requests left the record.
   */
  async archiveWork(ids: readonly string[], stillArchivable: () => readonly string[]): Promise<number> {
    const archive = this.archive
    if (!archive || this.options.enabled !== true || ids.length === 0) return 0
    await archive.ready()
    // A batch at a time, so a read back reads no more than the batches its messages reach. Work the archive already holds,
    // as after a crash between its write and the record's save, is not written again.
    // A request is held only as it stands now (`watcherWorkVersion`): one that changed since it was archived goes again.
    const version = (record: Readonly<WatcherRecord>): ((id: string) => string | undefined) => {
      const requests = new Map(record.requests.map(request => [request.id, request] as const)), owned = new Map<string, WatcherRecord['operations']>()
      for (const operation of record.operations) { const list = owned.get(operation.requestId); if (list) list.push(operation); else owned.set(operation.requestId, [operation]) }
      return id => { const request = requests.get(id); return request && watcherWorkVersion(request, owned.get(id) ?? []) }
    }
    const now = version(this.watcher)
    const fresh = ids.filter(id => !archive.holds(id, now(id)))
    // A paired desktop's requests go in batches of their own, which stay saved whatever Keep local history says (#1759).
    const desktops = new Set(this.watcher.requests.flatMap(request => request.remoteOrigin ? [request.id] : []))
    for (const group of [fresh.filter(id => !desktops.has(id)), fresh.filter(id => desktops.has(id))]) {
      for (let at = 0; at < group.length; at += WATCHER_ARCHIVE_BATCH) await archive.append(watcherArchiveBatch(this.watcher, group.slice(at, at + WATCHER_ARCHIVE_BATCH)))
    }
    // Only work the archive holds, as the record holds it now, leaves the record: Keep local history may have changed
    // between the batches, and a request may have changed while they were written.
    const current = version(this.watcher), allowed = new Set(stillArchivable())
    const leaving = new Set(ids.filter(id => allowed.has(id) && archive.holds(id, current(id))))
    if (leaving.size === 0 || this.options.disposed()) return 0
    await this.update(record => removeArchivedWork(record, leaving))
    return leaving.size
  }
  /** Settles once whatever was asked of Watcher's archive has settled. */
  settled(): Promise<void> { return this.archive?.settled() ?? Promise.resolve() }
  /**
   * Whether a Watcher conversation held this far back shows archived work it has not been read for, or holds less than it
   * was read for: a recall then starts, and the conversation is shown again when it ends. A look at the oldest held message
   * and the archive's newest time, so the read that asks costs the same however long the conversation is.
   */
  recallDue(thread: AgentThread): void {
    const archive = this.archive, oldest = thread.messages[0]
    if (!archive || this.watcherRecalling.has(thread.id)) return
    const recalled = this.watcherRecalls.get(thread.id)
    if (!oldest) { if (recalled) void this.recall(thread, true); return }
    // Read again when the conversation holds another oldest message, or the archive took another batch since.
    if (recalled?.from === oldest.id && recalled.revision === archive.revision || !recalled && !archive.reaches(oldest.createdAt)) return
    void this.recall(thread, true)
  }
  /**
   * Reads back the archived work a Watcher conversation shows from the oldest message main holds for it, bounded by
   * those messages (#1759), and keeps it while the conversation is held that far back. `reshow` shows Watcher's
   * conversations again once it is read; a caller about to show them itself passes false.
   */
  async recall(thread: AgentThread, reshow: boolean): Promise<void> {
    const archive = this.archive, oldest = thread.messages[0]
    if (!archive) return
    const previous = this.watcherRecalls.get(thread.id)?.work ?? NOTHING_ARCHIVED, revision = archive.revision
    let work: WatcherArchived = NOTHING_ARCHIVED
    if (oldest && archive.reaches(oldest.createdAt)) {
      this.watcherRecalling.add(thread.id)
      try { work = await archive.recall({ threadId: thread.id, ids: new Set(thread.messages.map(message => message.id)), from: oldest.createdAt }) }
      catch { work = NOTHING_ARCHIVED }
      finally { this.watcherRecalling.delete(thread.id) }
      if (this.options.disposed()) return
    }
    if (oldest) this.watcherRecalls.set(thread.id, { from: oldest.id, revision, work })
    else this.watcherRecalls.delete(thread.id)
    if (previous === work) return
    const all = [...this.watcherRecalls.values()].map(item => item.work).filter(item => item !== NOTHING_ARCHIVED)
    this.watcherRecalled = all.length === 0 ? NOTHING_ARCHIVED : all.length === 1 ? all[0]! : {
      requests: all.flatMap(item => item.requests), operations: all.flatMap(item => item.operations), promptTurns: all.flatMap(item => item.promptTurns) }
    this.display?.update(this.requestsShown())
    if (reshow) this.options.reshow()
  }
  /**
   * A copy of the record to change over several steps before handing it to `mutateWatcher`, for a caller that must read
   * its own earlier steps on the way, as Watcher's observe pass does after a takeover. One copy serves the whole change.
   */
  draft(): WatcherDraft { return { from: this.watcher, record: this.copy() } }
  /** Whether a change with nothing new would still change the record, by letting go of prompt turns nothing reads. */
  needsPruning(): boolean { return this.watcherUnpruned }
  update(update: (record: WatcherRecord) => void): Promise<void> {
    if (this.options.enabled !== true) throw new Error('Watcher is available in Sotto Owl.')
    this.mutate(update)
    return this.options.persist()
  }
  /** Changes the record. A draft (`watcherDraft`) is changed in place of a fresh copy, and only while it is of this record. */
  mutate(update: (record: WatcherRecord) => void, draft?: WatcherDraft): void {
    if (draft && draft.from !== this.watcher) throw new Error('The Watcher record changed while a change to it was being made.')
    const next = (draft ?? this.draft()).record; update(next)
    // Stable keeps Watcher's record whole (ADR-0072); only Owl, where Watcher runs, lets go of the turns nothing reads.
    if (this.options.enabled === true) prunePromptTurns(next)
    // Watcher's observe pass offers an update on every streamed chunk, and most change nothing. Checking the record again
    // costs more than copying it, and both grow with every prompt and wake-up Watcher has had, so an unchanged record stays.
    if (isDeepStrictEqual(next, this.watcher)) { this.watcherUnpruned = false; return }
    this.watcher = watcherRecordSchema.parse(next)
    // The parse made every container afresh, so freezing it reaches nothing the caller still holds.
    freezePlainData(this.watcher)
    this.watcherUnpruned = false
    this.display?.update(this.requestsShown())
  }
  /**
   * `watcherRecordForDisk` of the live record, worked out once per record. The record is frozen and only ever replaced,
   * so the same record always gives the same view, and the view's text is kept with it like any replaced section.
   */
  private watcherOnDisk: { from: WatcherRecord; record: WatcherRecord } | undefined
  forDisk(): WatcherRecord {
    if (this.watcherOnDisk?.from !== this.watcher) this.watcherOnDisk = { from: this.watcher, record: watcherRecordForDisk(this.watcher) }
    return this.watcherOnDisk.record
  }
  /** Serialized text by immutable record identity. */
  private readonly replacedSectionText = new WeakMap<object, string>()
  /**
   * Writes Watcher's record to its own file unless it is the record of the newest write made, and gives the landing of the
   * write that carries it. The record is frozen and only ever replaced, so a save that left it as it was writes nothing.
   */
  write(record: WatcherRecord): Promise<void> {
    const queued = this.queuedWatcherWrite
    if (queued?.record === record) return queued.written
    const text = this.watcherFileText(record)
    if (queued?.text === text) { this.queuedWatcherWrite = { ...queued, record }; return queued.written }
    const written = this.store.writeSerialized(text)
    this.queuedWatcherWrite = { record, text, written }
    // The disk still holds an older record, so the next save writes whatever it has. The write is known by its landing:
    // a record that serializes to the same text takes the entry over, and its failure is this write's.
    written.catch(() => { if (this.queuedWatcherWrite?.written === written) this.queuedWatcherWrite = undefined })
    return written
  }
  /** Watcher's file as text, from the record's text kept with it as each replaced section's is. */
  private watcherFileText(record: WatcherRecord): string {
    let text = this.replacedSectionText.get(record)
    if (text === undefined) { text = JSON.stringify(record); this.replacedSectionText.set(record, text) }
    return `{"watcher":${text}}`
  }
}
