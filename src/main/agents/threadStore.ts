import { existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'

import { summarizeThread, type AgentMessage, type AgentThreadSummary } from '../../shared/agents'
import { agentActivitySchema, MAX_AGENT_ACTIVITIES, type AgentActivity } from '../../shared/agentActivity'
import { sameMessageContent, threadEventSchema, type StoredThreadEvent, type ThreadEvent } from '../../shared/threadEvents'
import { isImmutableActivities, isImmutableActivity, ownBuiltActivity } from './activitySnapshots'
import { clonePlainData } from './cloneHostSnapshot'
import { agentVisualSchema, type AgentVisual } from '../../shared/visuals'
import { clipText, promptReplyText, THREAD_PROMPT_REPLY_HEAD, THREAD_PROMPT_REPLY_TAIL, THREAD_PROMPT_TEXT, THREAD_PROMPTS_MOST, type AgentThreadPrompt } from '../../shared/threadPrompts'
import { watcherOwnChangeSchema, watcherObservedChangesSchema } from '../../shared/watcherChanges'
import { watcherAsksSchema, type WatcherAsk } from '../../shared/watcherAsks'
import { visitUserMessageInstants, type StoredUserMessageInstant } from './usageHistory/sottoPrompts'
import { flushedCommits, SAVE_SYNCHRONOUS } from '../storage/sqliteDurability'
import { AUTOMATIC_CHECKPOINT, BUILT_CHECKPOINT_WORKER, NO_AUTOMATIC_CHECKPOINT, WalCheckpointer } from '../storage/walCheckpointer'

/** The first window a pane is given, and what each later request adds, both counted in turns. */
export const FIRST_WINDOW_TURNS = 10
export const LATER_WINDOW_TURNS = 20
export const RECORDED_USER_MESSAGES_MAX = 128
export interface RecordedUserMessageIdentity { readonly threadId: string; readonly messageId: string }

/**
 * The projection's shape. A change here means the `messages` table is rebuilt from `events` on the next
 * open, so nothing about a thread's history depends on a projection written by an older run.
 */
const PROJECTION_VERSION = 2

const migrations = [{
  version: 1,
  sql: `
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX events_thread ON events(thread_id, seq);
    CREATE TABLE messages (
      thread_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      message_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      command_id TEXT,
      attachments TEXT,
      PRIMARY KEY (thread_id, position)
    );
    CREATE INDEX messages_thread_message ON messages(thread_id, message_id);
    CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
  `,
}, {
  version: 2,
  sql: `
    CREATE TABLE activities (
      thread_id TEXT NOT NULL,
      activity_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (thread_id, activity_id)
    );
    CREATE INDEX activities_thread_position ON activities(thread_id, position);
    CREATE TABLE activity_epochs (thread_id TEXT PRIMARY KEY NOT NULL, epoch TEXT);
    CREATE TABLE activity_redactions (identity_hash TEXT PRIMARY KEY NOT NULL);
  `,
}, {
  version: 3,
  sql: `
    CREATE INDEX events_thread_resets ON events(thread_id, seq) WHERE kind = 'messages-reset';
    ALTER TABLE activity_epochs ADD COLUMN message_reset_seq INTEGER;
  `,
}, {
  // Visuals an agent drew (ADR-0056). Not thread events: a messages-reset rebuilds the projection from the provider's
  // own history, which knows nothing of them. Each is anchored to the newest message, and the newest user message, the
  // projection held when the call arrived. The sequence keeps their order through a VACUUM.
  version: 4,
  sql: `
    CREATE TABLE visuals (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      visual_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      anchor_message_id TEXT,
      anchor_user_message_id TEXT,
      payload TEXT NOT NULL,
      UNIQUE (thread_id, visual_id)
    );
    CREATE INDEX visuals_thread ON visuals(thread_id, seq);
  `,
}, {
  // The messages babysitting sent a thread as wake-ups (ADR-0061 decision 8), by ID alone. Not thread events, for the
  // reason visuals are not: a messages-reset rebuilds the projection from the provider's history, which knows nothing
  // of which prompts were Sotto's. The thread's record names only the newest; this keeps every one.
  version: 5,
  sql: `
    CREATE TABLE wake_ups (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      PRIMARY KEY (thread_id, message_id)
    );
  `,
}, {
  // A Watcher reply keeps its observed file changes after the bounded activity window has moved on.
  version: 6,
  sql: `ALTER TABLE messages ADD COLUMN watcher_own_change TEXT;
    ALTER TABLE messages ADD COLUMN watcher_observed_changes TEXT;`,
}, {
  // An observed reply keeps its Sotto turn anchor when native history corrects its timestamp.
  version: 7,
  sql: 'ALTER TABLE messages ADD COLUMN turn_message_id TEXT;',
}, {
  // The requests a Watcher wake-up's news said waited on the user, kept with the wake-up as identities alone, so its
  // conversation shows their cards under it after a messages-reset and a restart (ADR-0073). Null for every other wake-up.
  version: 8,
  sql: 'ALTER TABLE wake_ups ADD COLUMN watcher_asks TEXT;',
}, {
  // A wake-up that carried only delegation news, which no window or phone shows (ADR-0081, October 19, 2026): the mark
  // alone, never its words, so it stays hidden however many come after and through a messages-reset. Null for every other.
  version: 9,
  sql: 'ALTER TABLE wake_ups ADD COLUMN hidden INTEGER;',
}]

/** One visual as the store keeps it: the visual, when it arrived, and where in the thread it was drawn. */
export interface StoredVisual {
  readonly visual: AgentVisual
  readonly createdAt: string
  /** The newest message the projection held when the call arrived; null when it held none. */
  readonly anchorMessageId: string | null
  /** The newest user message then: the turn the visual belongs to. */
  readonly anchorUserMessageId: string | null
}

/** A stored record, and the frozen record it was last taken from or matched, when it was one. */
interface StoredActivityRecord { position: number; activity: AgentActivity; input?: AgentActivity }

interface ActivityState {
  known: boolean
  epoch: string | undefined
  resetSequence: number | undefined
  records: Map<string, StoredActivityRecord>
  input?: { activities: readonly AgentActivity[]; redactionRevision: number } | undefined
}

/** What one thread's activity list changes in the store: worked out before the transaction, written inside it. */
interface ActivitySyncPlan {
  threadId: string
  epoch: string | undefined
  resetSequence: number
  reset: boolean
  previousKnown: boolean
  previousResetSequence: number | undefined
  next: ActivityState
  changed: { position: number; activity: AgentActivity }[]
  moved: { id: string; position: number }[]
  removed: string[]
  immutable: boolean
  activities: readonly AgentActivity[]
}

/** What is known of a thread's stored activity without its records: its marker and how many records it holds (#918). */
interface ActivityMeta {
  known: boolean
  epoch: string | undefined
  resetSequence: number | undefined
  count: number
}

function activityIdentityHash(threadId: string, activityId: string): string {
  return createHash('sha256').update(`${threadId.length}:`).update(threadId).update(activityId).digest('hex')
}

/** One window of a thread's history, newest first in the store's own order (oldest to newest here). */
export interface ThreadMessageWindow {
  readonly messages: AgentMessage[]
  /** True when the thread holds messages older than this window's first one. */
  readonly earlierAvailable: boolean
  /** The projection positions this window covers, or -1 when it is empty. */
  readonly firstPosition: number
  readonly lastPosition: number
}

export interface ThreadWindowOptions {
  /** Whole turns, newest first: a user message and the assistant messages after it. */
  readonly turns?: number
  /** A plain message count, when turns are not what the caller is counting. */
  readonly limit?: number
  /** Read the window that ends just before this position, for a caller walking backwards. */
  readonly beforePosition?: number
}

const EMPTY_WINDOW: ThreadMessageWindow = { messages: [], earlierAvailable: false, firstPosition: -1, lastPosition: -1 }

function messageOf(row: Record<string, SQLOutputValue>): AgentMessage {
  const attachments = row.attachments === null || row.attachments === undefined ? undefined : JSON.parse(String(row.attachments)) as AgentMessage['attachments']
  const ownChange = row.watcher_own_change === null || row.watcher_own_change === undefined ? undefined
    : watcherOwnChangeSchema.safeParse(JSON.parse(String(row.watcher_own_change)))
  const observedChanges = row.watcher_observed_changes === null || row.watcher_observed_changes === undefined ? undefined
    : watcherObservedChangesSchema.safeParse(JSON.parse(String(row.watcher_observed_changes)))
  return {
    id: String(row.message_id), role: String(row.role) as AgentMessage['role'],
    text: String(row.text), createdAt: String(row.created_at),
    ...(row.command_id === null || row.command_id === undefined ? {} : { commandId: String(row.command_id) }),
    ...(row.turn_message_id === null || row.turn_message_id === undefined ? {} : { turnMessageId: String(row.turn_message_id) }),
    ...(attachments === undefined || attachments.length === 0 ? {} : { attachments }),
    ...(ownChange?.success ? { watcherOwnChange: ownChange.data } : {}),
    ...(observedChanges?.success ? { watcherObservedChanges: observedChanges.data } : {}),
  }
}

/**
 * A thread's own history: an append-only log of what happened to it, and the message projection the
 * window reads. `workspace.json` keeps organization; everything a thread said lives here.
 *
 * Every call is synchronous, because `node:sqlite` is. Callers keep them off a per-event path: a
 * publish appends the differences it found in one transaction rather than one statement per message.
 */
export class ThreadStore {
  private db: DatabaseSync | undefined
  private memory = false
  /** Prepared once per connection; a statement is bound to its database, so `close` clears the map. */
  private readonly statements = new Map<string, StatementSync>()
  /** Independent successful values: providers may mutate their records after a publish. */
  private readonly activityStates = new Map<string, ActivityState>()
  /** Markers and counts for threads whose records are not held in `activityStates`. */
  private readonly activityMetas = new Map<string, ActivityMeta>()
  private readonly activityRedactions = new Set<string>()
  private redactionRevision = 0
  private readonly redactionChecks = new Map<string, Map<string, boolean>>()
  /** While history is off, this connection writes identity hashes alone, never activity text. */
  private durableRedactions: ThreadStore | undefined
  /** Each thread's visuals as last read or written, so a window read per publish costs no query. */
  private readonly visualCache = new Map<string, readonly StoredVisual[]>()
  /** Each thread's wake-up message IDs as last read or written, for the same reason. */
  private readonly wakeUpCache = new Map<string, ReadonlySet<string>>()
  /** Each thread's Watcher wake-up asks, by wake-up message ID, as last read or written. */
  private readonly wakeUpAskCache = new Map<string, ReadonlyMap<string, readonly WatcherAsk[]>>()
  private readonly hiddenWakeUpCache = new Map<string, ReadonlySet<string>>()
  /** Checkpoints the durable file's log off main, so no save runs one (#1451); absent, SQLite checkpoints in the save. */
  private checkpointer: WalCheckpointer | undefined

  /**
   * The main runtime supplies a path under `app.getPath('userData')`. `checkpointWorker` is the built checkpoint worker,
   * or null to leave checkpoints to SQLite, as where no worker file sits beside this module (the test runner).
   */
  constructor(private readonly path: string, private readonly preserveThread?: (threadId: string) => boolean,
    private readonly checkpointWorker: string | null = BUILT_CHECKPOINT_WORKER) {}

  /** Opens the database. `ephemeral` keeps this run's history in memory, for Keep local history off. */
  open(options: { ephemeral?: boolean } = {}): void {
    if (this.db !== undefined) return
    const ephemeral = options.ephemeral === true
    let redactions: string[] = []
    // Keep local history was turned off while Sotto was not running: the words an earlier run kept come out first.
    if (ephemeral && existsSync(this.path)) {
      this.open(); this.redactAll(); redactions = [...this.activityRedactions]; this.close()
    }
    if (!ephemeral) mkdirSync(dirname(this.path), { recursive: true })
    const db = new DatabaseSync(ephemeral ? ':memory:' : this.path, { timeout: 5_000 })
    try {
      prepareThreadDatabase(db)
      if (readMeta(db, 'projectionVersion') !== String(PROJECTION_VERSION)) {
        rebuildProjection(db)
        writeMeta(db, 'projectionVersion', String(PROJECTION_VERSION))
      }
      this.db = db
      this.memory = ephemeral
      for (const row of this.statement('SELECT identity_hash FROM activity_redactions').all()) {
        this.activityRedactions.add(String(row.identity_hash))
      }
      for (const hash of redactions) this.activityRedactions.add(hash)
      if (!ephemeral) this.startCheckpointer(db)
    } catch (error) {
      this.statements.clear()
      this.activityRedactions.clear()
      this.db = undefined
      this.memory = false
      db.close()
      throw error
    }
  }

  /**
   * Hands the log's checkpoints to a worker and turns SQLite's own off on this connection. A worker that goes without
   * being stopped hands them back.
   */
  private startCheckpointer(db: DatabaseSync): void {
    const checkpointer = WalCheckpointer.start(this.path, this.checkpointWorker, () => {
      if (this.checkpointer !== checkpointer) return
      this.checkpointer = undefined
      if (this.db === db) try { db.exec(AUTOMATIC_CHECKPOINT) } catch { /* The connection is going; nothing waits on its log. */ }
    })
    if (checkpointer === undefined) return
    try { db.exec(NO_AUTOMATIC_CHECKPOINT) } catch (error) { checkpointer.stop(); throw error }
    this.checkpointer = checkpointer
  }

  /** Main's own checkpoint, with no checkpoint of the worker's in flight to make it find the log busy. */
  private scrub(db: DatabaseSync): void {
    if (this.checkpointer) this.checkpointer.aside(() => scrub(db))
    else scrub(db)
  }

  /** True while this run's history is being kept in memory rather than on disk. */
  get ephemeral(): boolean { return this.memory }

  /**
   * Keep local history was turned off. What is on disk is redacted first, then this run continues in
   * memory so the state on screen stays right while nothing said reaches the file again.
   */
  becomeEphemeral(): void {
    if (this.memory) return
    if (this.db !== undefined) { this.redactAll(); this.close() }
    else {
      // Nothing is open, but a file from an earlier run may still hold text.
      this.open()
      this.redactAll()
      this.close()
    }
    this.open({ ephemeral: true })
  }

  /** Keep local history was turned back on. What was not kept is gone; the file takes over from here. */
  becomeDurable(): void {
    if (!this.memory) return
    this.close()
    this.open()
  }

  close(): void {
    this.durableRedactions?.close()
    this.durableRedactions = undefined
    this.statements.clear()
    this.activityStates.clear()
    this.activityMetas.clear()
    this.activityRedactions.clear()
    this.redactionChecks.clear()
    this.visualCache.clear()
    this.wakeUpCache.clear()
    this.wakeUpAskCache.clear()
    this.hiddenWakeUpCache.clear()
    // The worker's connection closes first, so main's close is the file's last and checkpoints the log as it always did.
    this.checkpointer?.stop()
    this.checkpointer = undefined
    this.db?.close()
    this.db = undefined
    this.memory = false
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (statement === undefined) {
      statement = this.requireOpen().prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }


  private activityIdentityHashes(threadId?: string): string[] {
    const rows = threadId === undefined
      ? this.statement('SELECT thread_id, activity_id FROM activities').all()
      : this.statement('SELECT thread_id, activity_id FROM activities WHERE thread_id = ?').all(threadId)
    return rows.map(row => activityIdentityHash(String(row.thread_id), String(row.activity_id)))
  }

  private rememberActivityRedactions(hashes: readonly string[]): void {
    const added = hashes.filter(hash => !this.activityRedactions.has(hash))
    if (added.length === 0) return
    this.requireOpen()
    if (this.memory) {
      // Persist before accepting the activity in memory. Quitting while history is off must
      // not make a later provider replay eligible for retention.
      if (this.durableRedactions === undefined) {
        // It writes a few identity hashes, each waiting for the disk: SQLite's own checkpoints are enough for it.
        const durable = new ThreadStore(this.path, undefined, null)
        durable.open()
        this.durableRedactions = durable
      }
      this.durableRedactions.rememberActivityRedactions(added)
    } else {
      const db = this.requireOpen()
      // A redaction a power cut undid would let a provider replay bring the record back.
      flushedCommits(db, () => {
        db.exec('BEGIN IMMEDIATE')
        try {
          for (const hash of added) this.statement('INSERT OR IGNORE INTO activity_redactions (identity_hash) VALUES (?)').run(hash)
          db.exec('COMMIT')
        } catch (error) { db.exec('ROLLBACK'); throw error }
      })
    }
    for (const hash of added) this.activityRedactions.add(hash)
    this.redactionRevision++
    this.redactionChecks.clear()
  }

  /** Suppresses later replay of unsaved records without reading or persisting their payloads. */
  redactActivityIdentities(threadId: string, activityIds: readonly string[]): void {
    this.requireOpen()
    this.rememberActivityRedactions(activityIds.map(id => activityIdentityHash(threadId, id)))
  }

  private activityWasRedacted(threadId: string, activityId: string): boolean {
    if (this.memory || this.activityRedactions.size === 0) return false
    let checks = this.redactionChecks.get(threadId)
    if (checks === undefined) { checks = new Map(); this.redactionChecks.set(threadId, checks) }
    let redacted = checks.get(activityId)
    if (redacted === undefined) {
      redacted = this.activityRedactions.has(activityIdentityHash(threadId, activityId))
      checks.set(activityId, redacted)
    }
    return redacted
  }

  private activityState(threadId: string): ActivityState {
    let state = this.activityStates.get(threadId)
    if (state === undefined) {
      const epochRow = this.statement('SELECT epoch, message_reset_seq FROM activity_epochs WHERE thread_id = ?').get(threadId)
      const epoch = epochRow?.epoch
      const rows = this.statement('SELECT activity_id, position, payload FROM activities WHERE thread_id = ? ORDER BY position').all(threadId)
      const records: ActivityState['records'] = new Map()
      for (const row of rows) {
        const activity = ownBuiltActivity(storedActivity(row))
        records.set(activity.id, { position: Number(row.position), activity })
      }
      state = { known: epochRow !== undefined, epoch: epoch === undefined || epoch === null ? undefined : String(epoch), resetSequence: epochRow?.message_reset_seq === null || epochRow?.message_reset_seq === undefined ? undefined : Number(epochRow.message_reset_seq), records }
      this.activityStates.set(threadId, state)
      this.activityMetas.delete(threadId)
    }
    return state
  }

  /**
   * A thread's activity marker and record count. Read from the records this store holds for the thread, or else from one
   * marker row and a count, so asking about every thread at start reads no record (#918).
   */
  private activityMeta(threadId: string): ActivityMeta {
    const state = this.activityStates.get(threadId)
    if (state !== undefined) return { known: state.known, epoch: state.epoch, resetSequence: state.resetSequence, count: state.records.size }
    let meta = this.activityMetas.get(threadId)
    if (meta === undefined) {
      const epochRow = this.statement('SELECT epoch, message_reset_seq FROM activity_epochs WHERE thread_id = ?').get(threadId)
      const countRow = this.statement('SELECT COUNT(*) AS count FROM activities WHERE thread_id = ?').get(threadId)
      meta = { known: epochRow !== undefined,
        epoch: epochRow?.epoch === undefined || epochRow.epoch === null ? undefined : String(epochRow.epoch),
        resetSequence: epochRow?.message_reset_seq === null || epochRow?.message_reset_seq === undefined ? undefined : Number(epochRow.message_reset_seq),
        count: Number(countRow?.count ?? 0) }
      this.activityMetas.set(threadId, meta)
    }
    return meta
  }

  /**
   * Whether the records here have been read whole once since subagent task words moved to the agent roster, so none of
   * them still carries words the roster lacks (#918). Until then a start reads every record, as each start used to.
   */
  subagentWordsMoved(): boolean {
    return readMeta(this.requireOpen(), 'subagentWordsMoved') === '1'
  }

  markSubagentWordsMoved(): void {
    writeMeta(this.requireOpen(), 'subagentWordsMoved', '1')
  }

  /** Usage's history import (ADR-0083): each user message's identity, instant and wake-up mark. Reads no text. */
  visitUserMessageInstants(visitor: (message: StoredUserMessageInstant) => void, before?: string): void {
    visitUserMessageInstants(this.requireOpen(), visitor, before)
  }

  /** True once an authoritative list has been stored, even when that list is empty. */
  hasActivities(threadId: string): boolean {
    return this.activityMeta(threadId).known
  }

  /** How many records the stored list holds, read without them. */
  activityCount(threadId: string): number {
    return this.activityMeta(threadId).count
  }

  /**
   * Lets the records go while keeping what is known of them. The next read or save loads them again; a thread nobody
   * looks at then costs its marker and count, not every record (#918).
   */
  releaseActivities(threadId: string): void {
    const state = this.activityStates.get(threadId)
    if (state === undefined) return
    this.activityMetas.set(threadId, { known: state.known, epoch: state.epoch, resetSequence: state.resetSequence, count: state.records.size })
    this.activityStates.delete(threadId)
  }

  /** Latest committed message reset; a present unversioned reset differs from no reset at all. */
  readMessageEpoch(threadId: string): { epoch: string | undefined; sequence: number } | undefined {
    const row = this.statement("SELECT seq, payload FROM events WHERE thread_id = ? AND kind = 'messages-reset' ORDER BY seq DESC LIMIT 1").get(threadId)
    if (!row) return undefined
    const event = threadEventSchema.parse(JSON.parse(String(row.payload)))
    if (event.kind !== 'messages-reset') throw new Error('Stored message reset does not match its event')
    return { epoch: event.historyEpoch, sequence: Number(row.seq) }
  }
  /** Reset sequence committed beside activity; undefined identifies a pre-marker activity snapshot. */
  readActivityResetSequence(threadId: string): number | undefined {
    return this.activityMeta(threadId).resetSequence
  }
  /** The epoch committed with the list; hasActivities distinguishes unknown from unversioned. */
  readActivityEpoch(threadId: string): string | undefined {
    return this.activityMeta(threadId).epoch
  }

  /**
   * A caller owns its returned records, including nested plan steps and file changes. With `keep: false` a read of records
   * this store does not hold leaves them unheld, for a caller that only looks (#918). With `shared` the caller gets the held
   * records themselves, frozen and owned (`ownBuiltActivity`), read from the disk the first time: for a caller that keeps
   * records as they are and replaces rather than edits them, as the workspace does with every list it holds. They are
   * shared rather than copied, and a later save of the same records knows them by identity.
   *
   * Every held record was checked against the schema when it came off the disk or was saved, so a read hands out a copy
   * of it rather than checking it again: checking each of two thousand records twice was a quarter of the longest freezes
   * main had (#1333). The copy keeps the caller's records apart from the held ones; it shares the strings, so it costs a
   * few milliseconds where the second check cost tens. The copy is for Watcher, an adapter's restore and the start; the
   * workspace reads `shared` and copies nothing.
   */
  readActivities(threadId: string, options: { keep?: boolean; shared?: boolean } = {}): AgentActivity[] {
    const held = this.activityStates.get(threadId)
    if (held === undefined && options.keep === false && options.shared !== true) {
      return this.statement('SELECT activity_id, payload FROM activities WHERE thread_id = ? ORDER BY position').all(threadId).map(storedActivity)
    }
    const records = Array.from((held ?? this.activityState(threadId)).records.values(), ({ activity }) => activity)
    return options.shared === true ? records : clonePlainData(records)
  }

  /** The identities of a thread's stored records, read without the records. */
  activityIds(threadId: string): string[] {
    const held = this.activityStates.get(threadId)
    if (held !== undefined) return [...held.records.keys()]
    return this.statement('SELECT activity_id FROM activities WHERE thread_id = ? ORDER BY position').all(threadId).map(row => String(row.activity_id))
  }

  /** Persists the bounded authoritative list, encoding only records whose values changed. */
  syncActivities(threadId: string, activities: readonly AgentActivity[], epoch?: string): void {
    this.syncActivitiesMany([{ threadId, activities, epoch }])
  }

  /**
   * Several threads' lists in one transaction, so a save with several busy threads pays one disk flush rather than one
   * per thread. A savepoint per thread keeps one thread's failure from undoing the others: they commit, and the first
   * failure is thrown after them. A thread whose write failed keeps its earlier state, so the next save retries it.
   */
  syncActivitiesMany(entries: readonly { threadId: string; activities: readonly AgentActivity[]; epoch?: string | undefined }[]): void {
    const db = this.requireOpen()
    let failure: unknown
    const plans: ActivitySyncPlan[] = []
    for (const entry of entries) {
      try {
        const plan = this.planActivitySync(entry.threadId, entry.activities, entry.epoch)
        if (plan) plans.push(plan)
      } catch (error) { failure ??= error }
    }
    if (plans.length) {
      const written: ActivitySyncPlan[] = []
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const plan of plans) {
          db.exec('SAVEPOINT activity_sync')
          try {
            this.writeActivityPlan(plan)
            db.exec('RELEASE SAVEPOINT activity_sync')
            written.push(plan)
          } catch (error) {
            db.exec('ROLLBACK TO SAVEPOINT activity_sync')
            db.exec('RELEASE SAVEPOINT activity_sync')
            failure ??= error
          }
        }
        db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* The commit's own failure is the one to report. */ }
        throw error
      }
      // Only a committed revision can suppress the next save. A failed transaction keeps its retry.
      for (const plan of written) {
        if (plan.immutable) plan.next.input = { activities: plan.activities, redactionRevision: this.redactionRevision }
        this.activityStates.set(plan.threadId, plan.next)
        this.activityMetas.delete(plan.threadId)
      }
    }
    if (failure !== undefined) throw failure
  }

  /** What one thread's list changes in the store, worked out without writing; undefined when nothing does. */
  private planActivitySync(threadId: string, activities: readonly AgentActivity[], epoch: string | undefined): ActivitySyncPlan | undefined {
    if (activities.length > MAX_AGENT_ACTIVITIES) throw new Error('Too many thread activities')
    const previous = this.activityState(threadId)
    const resetSequence = this.readMessageEpoch(threadId)?.sequence ?? 0
    const reset = previous.epoch !== epoch || (previous.resetSequence !== undefined && previous.resetSequence !== resetSequence)
    const immutable = isImmutableActivities(activities)
    if (immutable && previous.known && !reset && previous.resetSequence === resetSequence
      && previous.input?.activities === activities && previous.input.redactionRevision === this.redactionRevision) return undefined
    const next: ActivityState = { known: true, epoch, resetSequence, records: new Map() }
    const changed: { position: number; activity: AgentActivity }[] = []
    const moved: { id: string; position: number }[] = []
    const seen = new Set<string>()
    const kept: { activity: AgentActivity; prior: StoredActivityRecord | undefined; same: boolean; input: AgentActivity | undefined }[] = []
    for (const activity of activities) {
      if (seen.has(activity.id)) throw new Error('Duplicate thread activity identity')
      seen.add(activity.id)
      if (this.activityWasRedacted(threadId, activity.id)) continue
      const prior = reset ? undefined : previous.records.get(activity.id)
      // A frozen record is only ever replaced, never edited: the same one as last time is unchanged without comparing.
      // Comparing every record of a busy thread on every save was most of the save's time.
      const input = isImmutableActivity(activity) ? activity : undefined
      kept.push({ activity, prior, input, same: prior !== undefined && ((input !== undefined && prior.input === input) || isDeepStrictEqual(prior.activity, activity)) })
    }
    // Positions only order the records. A list that drops from its front and adds at its end, as a thread at the record
    // limit does with every new record, keeps the positions it has, and new records go after them; renumbering every
    // record of such a thread on each save rewrote two thousand rows at a time.
    let last = -1, appended = false, stable = !reset
    for (const { prior } of kept) {
      if (!stable) break
      if (prior === undefined) appended = true
      else if (appended || prior.position <= last) stable = false
      else last = prior.position
    }
    let nextFree = stable ? Math.max(-1, ...[...previous.records.values()].map(record => record.position)) + 1 : 0
    for (const [index, { activity, prior, input, same }] of kept.entries()) {
      const position = stable ? prior?.position ?? nextFree++ : index
      if (same) {
        next.records.set(activity.id, { position, activity: prior!.activity, ...(input ? { input } : {}) })
        if (prior!.position !== position) moved.push({ id: activity.id, position })
      } else {
        const record = { position, activity: ownBuiltActivity(agentActivitySchema.parse(activity)), ...(input ? { input } : {}) }
        next.records.set(activity.id, record)
        changed.push(record)
      }
    }
    const removed = [...previous.records.keys()].filter(id => !next.records.has(id))
    if (previous.known && previous.resetSequence === resetSequence && !reset && changed.length === 0 && moved.length === 0 && removed.length === 0) {
      // Keep what the records were compared from, so the next save of the same records skips the comparison too.
      for (const [id, record] of next.records) { const held = previous.records.get(id); if (held && record.input) held.input = record.input }
      previous.input = immutable ? { activities, redactionRevision: this.redactionRevision } : undefined
      return undefined
    }
    if (this.memory) this.redactActivityIdentities(threadId, changed.map(({ activity }) => activity.id))
    return { threadId, epoch, resetSequence, reset, previousKnown: previous.known, previousResetSequence: previous.resetSequence, next, changed, moved, removed, immutable, activities }
  }

  /** One thread's planned changes, inside the caller's transaction. */
  private writeActivityPlan(plan: ActivitySyncPlan): void {
    const { threadId, epoch, resetSequence, reset } = plan
    if (reset) {
      this.statement('DELETE FROM activities WHERE thread_id = ?').run(threadId)
    } else {
      for (const id of plan.removed) this.statement('DELETE FROM activities WHERE thread_id = ? AND activity_id = ?').run(threadId, id)
    }
    if (!plan.previousKnown || reset || plan.previousResetSequence !== resetSequence) {
      this.statement('INSERT INTO activity_epochs (thread_id, epoch, message_reset_seq) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET epoch = excluded.epoch, message_reset_seq = excluded.message_reset_seq').run(threadId, epoch ?? null, resetSequence)
    }
    for (const { position, activity } of plan.changed) {
      this.statement('INSERT INTO activities (thread_id, activity_id, position, payload) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id, activity_id) DO UPDATE SET position = excluded.position, payload = excluded.payload')
        .run(threadId, activity.id, position, JSON.stringify(activity))
    }
    for (const { id, position } of plan.moved) this.statement('UPDATE activities SET position = ? WHERE thread_id = ? AND activity_id = ?').run(position, threadId, id)
  }

  /** Writes one event and applies it to the projection in a single transaction. */
  append(threadId: string, event: ThreadEvent): number {
    return this.appendMany(threadId, [event])
  }

  /** The same for a run of events, so a publish costs one transaction. Returns the last sequence written. */
  /** A reset waits for the disk: whatever it took out, a rewind's turns among them, a power cut must not bring back. */
  appendMany(threadId: string, events: readonly ThreadEvent[]): number {
    return resets(events) ? flushedCommits(this.requireOpen(), () => this.appendManyNow(threadId, events)) : this.appendManyNow(threadId, events)
  }
  private appendManyNow(threadId: string, events: readonly ThreadEvent[]): number {
    const db = this.requireOpen()
    if (events.length === 0) return this.latestSeq()
    db.exec('BEGIN IMMEDIATE')
    try {
      const seq = this.insertEvents(db, threadId, events)
      db.exec('COMMIT')
      return seq
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Every thread's waiting events in one transaction, so a publish window with several streaming
   * threads pays one fsync rather than one per thread (#991). A savepoint per thread keeps the rule
   * appendMany gave one batch: a thread whose batch fails rolls back alone and is named in `failed`,
   * while the others commit. A failure of the commit itself throws, with nothing written.
   */
  /** A window that carries a reset commits waiting for the disk, as `appendMany` does. */
  appendBatches(batches: ReadonlyMap<string, readonly ThreadEvent[]>): { failed: Set<string> } {
    return [...batches.values()].some(resets) ? flushedCommits(this.requireOpen(), () => this.appendBatchesNow(batches)) : this.appendBatchesNow(batches)
  }
  private appendBatchesNow(batches: ReadonlyMap<string, readonly ThreadEvent[]>): { failed: Set<string> } {
    const db = this.requireOpen()
    const due = [...batches].filter(([, events]) => events.length > 0)
    const failed = new Set<string>()
    if (due.length === 0) return { failed }
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const [threadId, events] of due) {
        db.exec('SAVEPOINT thread_batch')
        try {
          this.insertEvents(db, threadId, events)
          db.exec('RELEASE SAVEPOINT thread_batch')
        } catch {
          try {
            db.exec('ROLLBACK TO SAVEPOINT thread_batch')
            db.exec('RELEASE SAVEPOINT thread_batch')
          } catch (error) {
            db.exec('ROLLBACK')
            throw error
          }
          failed.add(threadId)
        }
      }
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* The commit's own failure is the one to report. */ }
      throw error
    }
    return { failed }
  }

  /** One thread's events into the log and the projection, inside the caller's transaction. */
  private insertEvents(db: DatabaseSync, threadId: string, events: readonly ThreadEvent[]): number {
    let seq = 0
    for (const event of events) {
      const parsed = threadEventSchema.parse(event)
      this.statement('INSERT INTO events (thread_id, kind, at, payload) VALUES (?, ?, ?, ?)')
        .run(threadId, parsed.kind, parsed.at, JSON.stringify(parsed))
      seq = Number(this.statement('SELECT last_insert_rowid() AS seq').get()!.seq)
      applyEvent(db, threadId, parsed, sql => this.statement(sql))
    }
    return seq
  }

  /**
   * The newest window of a thread's messages. With `turns`, the window starts at a user message so a
   * reader never opens halfway through an exchange; with neither `turns` nor `limit`, it is the
   * whole history, which is what a one-time read at start asks for.
   */
  readMessages(threadId: string, options: ThreadWindowOptions = {}): ThreadMessageWindow {
    const bound = options.beforePosition
    const clause = bound === undefined ? '' : ' AND position < ?'
    const parameters = bound === undefined ? [threadId] : [threadId, bound]
    const last = this.statement(`SELECT MAX(position) AS last FROM messages WHERE thread_id = ?${clause}`).get(...parameters)?.last
    if (last === null || last === undefined) return EMPTY_WINDOW
    const lastPosition = Number(last)
    let firstPosition = 0
    if (options.turns !== undefined) {
      const starts = this.statement(`SELECT position FROM messages WHERE thread_id = ? AND role = 'user'${clause} ORDER BY position DESC LIMIT ?`)
        .all(...parameters, options.turns).map(row => Number(row.position))
      firstPosition = starts.length < options.turns ? 0 : starts.at(-1)!
    } else if (options.limit !== undefined) {
      firstPosition = Math.max(0, lastPosition - options.limit + 1)
    }
    const rows = this.statement('SELECT * FROM messages WHERE thread_id = ? AND position BETWEEN ? AND ? ORDER BY position')
      .all(threadId, firstPosition, lastPosition)
    return { messages: rows.map(messageOf), earlierAvailable: firstPosition > 0, firstPosition, lastPosition }
  }

  /** Forward positions for automation; this never moves a pane's backwards history window. */
  readForwardMessages(threadId: string, afterPosition: number | undefined, limit: number): { messages: { message: AgentMessage; position: number }[]; earlierAvailable: boolean; hasMore: boolean } {
    const count = Math.max(1, Math.min(50, limit))
    const newest = afterPosition === undefined
    const rows = newest
      ? this.statement('SELECT * FROM messages WHERE thread_id = ? ORDER BY position DESC LIMIT ?').all(threadId, count + 1).reverse()
      : this.statement('SELECT * FROM messages WHERE thread_id = ? AND position > ? ORDER BY position LIMIT ?').all(threadId, afterPosition, count + 1)
    const hasMore = !newest && rows.length > count
    const page = newest ? rows.slice(-count) : rows.slice(0, count)
    return { messages: page.map(row => ({ message: messageOf(row), position: Number(row.position) })),
      earlierAvailable: (page[0] ? Number(page[0].position) : 0) > 0, hasMore }
  }

  /** Every message this thread holds, by ID and role, oldest first: what an adapter needs to recognise
   * a message the store already has without reading the words back out of it. */
  messageIdentities(threadId: string): { id: string; role: 'user' | 'assistant'; turnMessageId?: string }[] {
    return this.statement('SELECT message_id, role, turn_message_id FROM messages WHERE thread_id = ? ORDER BY position')
      .all(threadId).map(row => ({ id: String(row.message_id), role: String(row.role) as 'user' | 'assistant',
        ...(row.turn_message_id === null ? {} : { turnMessageId: String(row.turn_message_id) }) }))
  }

  /** One indexed message; identity repairs never read the whole transcript. */
  message(threadId: string, messageId: string): AgentMessage | undefined {
    const row = this.statement('SELECT * FROM messages WHERE thread_id = ? AND message_id = ?').get(threadId, messageId)
    return row === undefined ? undefined : messageOf(row)
  }

  /**
   * The messages the user sent before this one, oldest first, each with its turn's last reply with words: what the message
   * scrubber marks above a pane's window (ADR-0109). Only the start of each message and the start and end of each reply
   * are read. A message the store does not hold has nothing before it.
   */
  promptsBefore(threadId: string, messageId: string, skip: ReadonlySet<string>): AgentThreadPrompt[] {
    const before = this.statement('SELECT position FROM messages WHERE thread_id = ? AND message_id = ? LIMIT 1').get(threadId, messageId)?.position
    if (before === null || before === undefined) return []
    // Only the newest prompts an answer carries are read, so a longer history costs no more.
    const from = this.statement(`SELECT position FROM messages WHERE thread_id = ? AND role = 'user' AND position < ? ORDER BY position DESC LIMIT 1 OFFSET ${THREAD_PROMPTS_MOST - 1}`).get(threadId, before)?.position ?? 0
    const whole = THREAD_PROMPT_REPLY_HEAD + THREAD_PROMPT_REPLY_TAIL
    const rows = this.statement(`SELECT role, message_id, created_at, attachments, substr(text, 1, CASE WHEN role = 'user' THEN ${THREAD_PROMPT_TEXT} ELSE ${whole} END) AS head,
      CASE WHEN role = 'assistant' AND length(text) > ${whole} THEN substr(text, -${THREAD_PROMPT_REPLY_TAIL * 2}) END AS tail
      FROM messages WHERE thread_id = ? AND position >= ? AND position < ? AND (role = 'user' OR trim(text, char(32, 9, 10, 11, 12, 13)) <> '') ORDER BY position`).all(threadId, from, before)
    const prompts: { -readonly [K in keyof AgentThreadPrompt]: AgentThreadPrompt[K] }[] = []
    let current: typeof prompts[number] | undefined
    for (const row of rows) {
      const id = String(row.message_id)
      if (row.role === 'user') {
        // A wake-up is Sotto's and starts a turn of its own, so what answers it is no prompt's reply.
        if (skip.has(id)) { current = undefined; continue }
        const attached = row.attachments === null || row.attachments === undefined ? 0 : (JSON.parse(String(row.attachments)) as unknown[]).length
        current = { id, createdAt: String(row.created_at), text: clipText(String(row.head), THREAD_PROMPT_TEXT), ...(attached > 0 ? { attachments: Math.min(attached, 1000) } : {}) }
        prompts.push(current)
      } else if (current) {
        const tail = row.tail === null || row.tail === undefined ? null : String(row.tail)
        // A reply of space alone is no reply with words, whatever kind of space the store's own trim leaves.
        if (tail !== null || String(row.head).trim().length > 0) current.reply = { id, text: promptReplyText(String(row.head), tail) }
      }
    }
    return prompts
  }

  /** How many turns run from this message to the newest, counting its own, or undefined when the store does not hold it. */
  turnsFrom(threadId: string, messageId: string): number | undefined {
    const at = this.statement('SELECT position FROM messages WHERE thread_id = ? AND message_id = ? LIMIT 1').get(threadId, messageId)?.position
    if (at === null || at === undefined) return undefined
    return Number(this.statement(`SELECT COUNT(*) AS turns FROM messages WHERE thread_id = ? AND role = 'user' AND position >= ?`).get(threadId, at)!.turns)
  }

  /** Whether the thread holds this message: one indexed lookup, never a read of the thread. */
  hasMessage(threadId: string, messageId: string): boolean {
    return this.statement('SELECT 1 AS found FROM messages WHERE thread_id = ? AND message_id = ? LIMIT 1').get(threadId, messageId) !== undefined
  }

  /** Exact user-message evidence, including an event whose words were removed or rewound. */
  hasRecordedUserMessage(threadId: string, messageId: string): boolean {
    return this.statement(`SELECT 1 FROM events WHERE thread_id = ? AND kind IN ('message-added', 'message-replaced')
      AND json_extract(payload, '$.message.id') = ? AND json_extract(payload, '$.message.role') = 'user' LIMIT 1`)
      .get(threadId, messageId) !== undefined
  }

  /** One text-free event scan for a bounded recovery batch, including redacted and rewound messages. */
  recordedUserMessages(identities: readonly RecordedUserMessageIdentity[]): RecordedUserMessageIdentity[] {
    if (identities.length > RECORDED_USER_MESSAGES_MAX) throw new RangeError('Too many message identities')
    if (identities.length === 0) return []
    return this.statement(`WITH requested(thread_id,message_id) AS (VALUES ${identities.map(() => '(?,?)').join(',')})
      SELECT DISTINCT thread_id,json_extract(payload,'$.message.id') AS message_id FROM events
      WHERE thread_id IN (SELECT thread_id FROM requested) AND kind IN ('message-added','message-replaced')
        AND json_extract(payload,'$.message.role')='user'
        AND (thread_id,json_extract(payload,'$.message.id')) IN (SELECT thread_id,message_id FROM requested)
      ORDER BY thread_id,message_id`)
      .all(...identities.flatMap(identity => [identity.threadId, identity.messageId]))
      .map(row => ({ threadId: String(row.thread_id), messageId: String(row.message_id) }))
  }

  messageCount(threadId: string): number {
    return Number(this.statement('SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?').get(threadId)!.count)
  }

  /** The sidebar's facts about a thread, taken from the projection rather than from its history. */
  summary(threadId: string): AgentThreadSummary {
    const count = this.messageCount(threadId)
    const newest = (role: 'user' | 'assistant'): AgentMessage | undefined => {
      const row = this.statement('SELECT * FROM messages WHERE thread_id = ? AND role = ? ORDER BY position DESC LIMIT 1').get(threadId, role)
      return row === undefined ? undefined : messageOf(row)
    }
    const user = newest('user')
    const assistant = newest('assistant')
    const summary = summarizeThread({ messages: [...(user ? [user] : []), ...(assistant ? [assistant] : [])] })
    return { ...summary, messageCount: count }
  }

  /** Everything after `seq`, in the order it was written. */
  eventsAfter(seq: number, threadId?: string, limit = -1, excludedThreadIds: readonly string[] = []): StoredThreadEvent[] {
    // Visibility belongs before LIMIT so hidden history cannot exhaust a client's catch-up page.
    const exclusion = excludedThreadIds.length ? ' AND thread_id NOT IN (SELECT value FROM json_each(?))' : ''
    const excluded = excludedThreadIds.length ? [JSON.stringify(excludedThreadIds)] : []
    const rows = threadId === undefined
      ? this.statement(`SELECT seq, thread_id, payload FROM events WHERE seq > ?${exclusion} ORDER BY seq LIMIT ?`).all(seq, ...excluded, limit)
      : this.statement(`SELECT seq, thread_id, payload FROM events WHERE seq > ? AND thread_id = ?${exclusion} ORDER BY seq LIMIT ?`).all(seq, threadId, ...excluded, limit)
    return rows.map(row => ({ seq: Number(row.seq), threadId: String(row.thread_id), event: JSON.parse(String(row.payload)) as ThreadEvent }))
  }

  latestSeq(): number {
    const row = this.statement('SELECT MAX(seq) AS seq FROM events').get()
    return row?.seq === null || row?.seq === undefined ? 0 : Number(row.seq)
  }

  /** Drops one thread's projection and takes the words out of its log, leaving only that it happened. */
  forget(threadId: string): void {
    flushedCommits(this.requireOpen(), () => this.forgetFlushed(threadId))
  }

  private forgetFlushed(threadId: string): void {
    const db = this.requireOpen()
    const hashes = this.activityIdentityHashes(threadId)
    db.exec('BEGIN IMMEDIATE')
    try {
      this.statement('DELETE FROM messages WHERE thread_id = ?').run(threadId)
      for (const hash of hashes) this.statement('INSERT OR IGNORE INTO activity_redactions (identity_hash) VALUES (?)').run(hash)
      this.statement('DELETE FROM activities WHERE thread_id = ?').run(threadId)
      this.statement('DELETE FROM activity_epochs WHERE thread_id = ?').run(threadId)
      this.statement('DELETE FROM visuals WHERE thread_id = ?').run(threadId)
      this.statement('DELETE FROM wake_ups WHERE thread_id = ?').run(threadId)
      redactEvents(db, threadId)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    this.activityStates.delete(threadId)
    this.activityMetas.delete(threadId)
    this.visualCache.delete(threadId)
    this.wakeUpCache.delete(threadId)
    this.wakeUpAskCache.delete(threadId)
    this.hiddenWakeUpCache.delete(threadId)
    for (const hash of hashes) this.activityRedactions.add(hash)
    this.redactionRevision++
    this.redactionChecks.clear()
    this.scrub(db)
  }

  /** The same for every thread: what Keep local history turning off asks of the file. */
  redactAll(): void {
    flushedCommits(this.requireOpen(), () => this.redactAllFlushed())
  }

  private redactAllFlushed(): void {
    const db = this.requireOpen()
    // A release gate can keep dormant threads outside this runtime's privacy ownership.
    const threadIds = this.preserveThread ? this.statement('SELECT thread_id FROM events UNION SELECT thread_id FROM messages UNION SELECT thread_id FROM activities UNION SELECT thread_id FROM activity_epochs UNION SELECT thread_id FROM visuals').all().map(row => String(row.thread_id)) : undefined
    const selected = threadIds?.some(id => this.preserveThread!(id)) ? threadIds.filter(id => !this.preserveThread!(id)) : undefined
    const hashes = selected ? selected.flatMap(id => this.activityIdentityHashes(id)) : this.activityIdentityHashes()
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const hash of hashes) this.statement('INSERT OR IGNORE INTO activity_redactions (identity_hash) VALUES (?)').run(hash)
      if (selected) {
        for (const id of selected) {
          for (const table of ['messages', 'activities', 'activity_epochs', 'visuals']) this.statement('DELETE FROM ' + table + ' WHERE thread_id = ?').run(id)
          redactEvents(db, id)
        }
      } else {
        db.exec('DELETE FROM messages; DELETE FROM activities; DELETE FROM activity_epochs; DELETE FROM visuals;')
        redactEvents(db)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    this.activityStates.clear()
    this.activityMetas.clear()
    this.visualCache.clear()
    for (const hash of hashes) this.activityRedactions.add(hash)
    this.redactionRevision++
    this.redactionChecks.clear()
    this.scrub(db)
  }

  /** The newest message the projection holds, and the newest user message: where a visual arriving now is drawn. */
  newestMessages(threadId: string): { messageId: string | null; userMessageId: string | null } {
    const newest = this.statement('SELECT message_id FROM messages WHERE thread_id = ? ORDER BY position DESC LIMIT 1').get(threadId)
    const user = this.statement("SELECT message_id FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY position DESC LIMIT 1").get(threadId)
    return { messageId: newest === undefined ? null : String(newest.message_id), userMessageId: user === undefined ? null : String(user.message_id) }
  }

  /** A thread's visuals, oldest first. A row this version cannot read is left out rather than refusing the rest. */
  readVisuals(threadId: string): readonly StoredVisual[] {
    const held = this.visualCache.get(threadId)
    if (held) return held
    const visuals: StoredVisual[] = []
    for (const row of this.statement('SELECT visual_id, created_at, anchor_message_id, anchor_user_message_id, payload FROM visuals WHERE thread_id = ? ORDER BY seq').all(threadId)) {
      let payload: unknown
      try { payload = JSON.parse(String(row.payload)) } catch { continue }
      const visual = agentVisualSchema.safeParse(payload)
      if (!visual.success || visual.data.id !== String(row.visual_id)) continue
      visuals.push({ visual: visual.data, createdAt: String(row.created_at),
        anchorMessageId: row.anchor_message_id === null || row.anchor_message_id === undefined ? null : String(row.anchor_message_id),
        anchorUserMessageId: row.anchor_user_message_id === null || row.anchor_user_message_id === undefined ? null : String(row.anchor_user_message_id) })
    }
    this.visualCache.set(threadId, visuals)
    return visuals
  }

  /** The IDs of every message babysitting sent this thread as a wake-up. */
  wakeUps(threadId: string): ReadonlySet<string> {
    const held = this.wakeUpCache.get(threadId)
    if (held) return held
    const ids = new Set(this.statement('SELECT message_id FROM wake_ups WHERE thread_id = ?').all(threadId).map(row => String(row.message_id)))
    this.wakeUpCache.set(threadId, ids)
    return ids
  }

  /**
   * The requests each of this thread's Watcher wake-ups said waited on the user, by the wake-up's message ID
   * (ADR-0073). Identities alone; a row this build cannot read is left out.
   */
  wakeUpAsks(threadId: string): ReadonlyMap<string, readonly WatcherAsk[]> {
    const held = this.wakeUpAskCache.get(threadId)
    if (held) return held
    const asks = new Map<string, readonly WatcherAsk[]>()
    for (const row of this.statement('SELECT message_id, watcher_asks FROM wake_ups WHERE thread_id = ? AND watcher_asks IS NOT NULL').all(threadId)) {
      let parsed: ReturnType<typeof watcherAsksSchema.safeParse> | undefined
      try { parsed = watcherAsksSchema.safeParse(JSON.parse(String(row.watcher_asks))) } catch { /* Unreadable: left out. */ }
      if (parsed?.success && parsed.data.length) asks.set(String(row.message_id), parsed.data)
    }
    this.wakeUpAskCache.set(threadId, asks)
    return asks
  }

  /** The IDs of this thread's wake-ups that carried only delegation news, which no window or phone shows (ADR-0081). */
  hiddenWakeUps(threadId: string): ReadonlySet<string> {
    const held = this.hiddenWakeUpCache.get(threadId)
    if (held) return held
    const ids = new Set(this.statement('SELECT message_id FROM wake_ups WHERE thread_id = ? AND hidden = 1').all(threadId).map(row => String(row.message_id)))
    this.hiddenWakeUpCache.set(threadId, ids)
    return ids
  }
  /** Marks these of a thread's wake-ups as ones no one is shown, keeping each as a wake-up too. Throws when the store refuses them. */
  private markHidden(threadId: string, messageIds: readonly string[]): void {
    const before = this.hiddenWakeUps(threadId)
    const added = [...new Set(messageIds)].filter(id => !before.has(id))
    if (!added.length) return
    for (const id of added) this.statement('INSERT INTO wake_ups (thread_id, message_id, hidden) VALUES (?, ?, 1) ON CONFLICT (thread_id, message_id) DO UPDATE SET hidden = 1').run(threadId, id)
    this.hiddenWakeUpCache.set(threadId, new Set([...before, ...added]))
    const wakeUps = this.wakeUps(threadId)
    if (added.some(id => !wakeUps.has(id))) this.wakeUpCache.set(threadId, new Set([...wakeUps, ...added]))
  }

  /**
   * Keeps a wake-up's message ID with its thread, and, for a Watcher wake-up, the requests its news said waited on the
   * user; `hidden` marks one that carried only delegation news. Throws when the store refuses it.
   */
  addWakeUp(threadId: string, messageId: string, asks?: readonly WatcherAsk[], hidden = false): void {
    if (hidden) this.markHidden(threadId, [messageId])
    const before = this.wakeUps(threadId)
    const beforeAsks = asks?.length ? this.wakeUpAsks(threadId) : undefined
    if (before.has(messageId) && (beforeAsks === undefined || beforeAsks.has(messageId))) return
    if (beforeAsks === undefined) this.statement('INSERT OR IGNORE INTO wake_ups (thread_id, message_id) VALUES (?, ?)').run(threadId, messageId)
    else this.statement('INSERT INTO wake_ups (thread_id, message_id, watcher_asks) VALUES (?, ?, ?) ON CONFLICT (thread_id, message_id) DO UPDATE SET watcher_asks = excluded.watcher_asks')
      .run(threadId, messageId, JSON.stringify(asks))
    this.wakeUpCache.set(threadId, new Set([...before, messageId]))
    if (beforeAsks !== undefined) this.wakeUpAskCache.set(threadId, new Map([...beforeAsks, [messageId, [...asks!]]]))
  }

  /**
   * Keeps every one of these wake-up message IDs with its thread, with the asks of those that have them, in one
   * transaction. Throws when the store refuses them.
   */
  addWakeUps(threadId: string, messageIds: readonly string[], asks?: ReadonlyMap<string, readonly WatcherAsk[]>, hidden: readonly string[] = []): void {
    if (hidden.length) this.markHidden(threadId, hidden)
    const before = this.wakeUps(threadId)
    const beforeAsks = asks?.size ? this.wakeUpAsks(threadId) : new Map<string, readonly WatcherAsk[]>()
    const added = [...new Set(messageIds)].filter(id => !before.has(id) || asks?.has(id) && !beforeAsks.has(id))
    if (!added.length) return
    const db = this.requireOpen()
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of added) {
        const kept = asks?.get(id)
        if (kept?.length) this.statement('INSERT INTO wake_ups (thread_id, message_id, watcher_asks) VALUES (?, ?, ?) ON CONFLICT (thread_id, message_id) DO UPDATE SET watcher_asks = excluded.watcher_asks')
          .run(threadId, id, JSON.stringify(kept))
        else this.statement('INSERT OR IGNORE INTO wake_ups (thread_id, message_id) VALUES (?, ?)').run(threadId, id)
      }
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    this.wakeUpCache.set(threadId, new Set([...before, ...added]))
    if (asks?.size) this.wakeUpAskCache.set(threadId, new Map([...beforeAsks, ...added.flatMap(id => asks.get(id)?.length ? [[id, asks.get(id)!] as const] : [])]))
  }

  /** Keeps one visual with its thread. Throws when the store refuses it, so nothing is shown that was not kept. */
  addVisual(threadId: string, stored: StoredVisual): void {
    const visual = agentVisualSchema.parse(stored.visual)
    const before = this.readVisuals(threadId)
    this.statement('INSERT INTO visuals (thread_id, visual_id, created_at, anchor_message_id, anchor_user_message_id, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run(threadId, visual.id, stored.createdAt, stored.anchorMessageId, stored.anchorUserMessageId, JSON.stringify(visual))
    this.visualCache.set(threadId, [...before, { ...stored, visual }])
  }

  /** Removes the visuals drawn in these turns, named by their user messages: a confirmed rewind took the turns back. */
  deleteVisualsForTurns(threadId: string, userMessageIds: readonly string[]): number {
    const doomed = new Set(userMessageIds)
    const before = this.readVisuals(threadId)
    const removed = before.filter(stored => stored.anchorUserMessageId !== null && doomed.has(stored.anchorUserMessageId))
    if (removed.length === 0) return 0
    const db = this.requireOpen()
    flushedCommits(db, () => {
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const stored of removed) this.statement('DELETE FROM visuals WHERE thread_id = ? AND visual_id = ?').run(threadId, stored.visual.id)
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
    })
    this.visualCache.set(threadId, before.filter(stored => !removed.includes(stored)))
    return removed.length
  }

  /**
   * This thread's history is now exactly these messages: a rewind the provider confirmed, or the
   * one-time move of a thread out of `workspace.json`. One transaction, so a failure leaves the
   * thread as it was. Its reset waits for the disk (`appendMany`), so a power cut cannot bring back what it replaced.
   */
  replaceThreadMessages(threadId: string, messages: readonly AgentMessage[], historyEpoch?: string): void {
    const at = new Date().toISOString()
    this.appendMany(threadId, [
      { kind: 'messages-reset', at, ...(historyEpoch === undefined ? {} : { historyEpoch }) },
      ...messages.map(message => ({ kind: 'message-added' as const, at: message.createdAt || at, message })),
    ])
  }

  /** Runs `work` with its commits waiting for the disk (`flushedCommits`), for a caller outside the store. */
  flushed<T>(work: () => T): T { return flushedCommits(this.requireOpen(), work) }

  /** Rebuilds every projection from the log; the log is the record, the projection only reads faster. */
  rebuild(): void { rebuildProjection(this.requireOpen()) }

  private requireOpen(): DatabaseSync {
    if (this.db === undefined) throw new Error('Thread store is not open')
    return this.db
  }
}

function applyEvent(db: DatabaseSync, threadId: string, event: ThreadEvent,
  prepare: (sql: string) => StatementSync = sql => db.prepare(sql)): void {
  switch (event.kind) {
    case 'message-added': {
      const row = prepare('SELECT MAX(position) AS last FROM messages WHERE thread_id = ?').get(threadId)
      const position = row?.last === null || row?.last === undefined ? 0 : Number(row.last) + 1
      const { message } = event
      prepare('INSERT INTO messages (thread_id, position, message_id, role, text, created_at, command_id, attachments, watcher_own_change, watcher_observed_changes, turn_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(threadId, position, message.id, message.role, message.text, message.createdAt,
          message.commandId ?? null, message.attachments === undefined ? null : JSON.stringify(message.attachments),
          message.watcherOwnChange === undefined ? null : JSON.stringify(message.watcherOwnChange),
          message.watcherObservedChanges === undefined ? null : JSON.stringify(message.watcherObservedChanges), message.turnMessageId ?? null)
      return
    }
    case 'message-text-appended':
      prepare('UPDATE messages SET text = text || ? WHERE thread_id = ? AND message_id = ?')
        .run(event.appendText, threadId, event.messageId)
      return
    case 'message-replaced': {
      const { message } = event
      // Native history has no Sotto mark. An omitted field must not erase history-owned observation.
      prepare('UPDATE messages SET role = ?, text = ?, created_at = ?, command_id = ?, attachments = ?, watcher_own_change = COALESCE(?, watcher_own_change), watcher_observed_changes = COALESCE(?, watcher_observed_changes), turn_message_id = COALESCE(turn_message_id, ?) WHERE thread_id = ? AND message_id = ?')
        .run(message.role, message.text, message.createdAt, message.commandId ?? null,
          message.attachments === undefined ? null : JSON.stringify(message.attachments),
          message.watcherOwnChange === undefined ? null : JSON.stringify(message.watcherOwnChange),
          message.watcherObservedChanges === undefined ? null : JSON.stringify(message.watcherObservedChanges), message.turnMessageId ?? null, threadId, message.id)
      return
    }
    case 'message-aliased': {
      const read = (id: string) => prepare('SELECT * FROM messages WHERE thread_id = ? AND message_id = ?').get(threadId, id)
      const duplicate = read(event.messageId), canonical = read(event.canonicalId)
      if (event.messageId !== event.canonicalId && duplicate && canonical && sameMessageContent(messageOf(duplicate), messageOf(canonical))) {
        prepare('DELETE FROM messages WHERE thread_id = ? AND message_id = ?').run(threadId, event.messageId)
      }
      return
    }
    case 'messages-reset':
      prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId)
      return
    case 'answer-given':
      return
  }
}

/** What is left of a message event once its words are taken out: that it happened, and to which message. */
function redactedPayload(payload: string): string | undefined {
  let event: ThreadEvent
  try { event = JSON.parse(payload) as ThreadEvent } catch { return undefined }
  switch (event.kind) {
    case 'message-added':
    case 'message-replaced':
      return JSON.stringify({ kind: event.kind, at: event.at, redacted: true,
        message: { id: event.message.id, role: event.message.role, createdAt: event.message.createdAt, text: '' } })
    case 'message-text-appended':
      return JSON.stringify({ kind: event.kind, at: event.at, redacted: true, messageId: event.messageId, appendText: '' })
    case 'answer-given':
      // Option IDs can be the provider's labels, so they are words too.
      return JSON.stringify({ ...event, questionOptionIds: undefined, answer: '' })
    default:
      return undefined
  }
}

/**
 * Redaction is not finished while the words are still in a freed page or in the write-ahead log. The
 * checkpoint folds the log into the file and the vacuum rewrites it, so what was taken out is gone.
 */
function scrub(db: DatabaseSync): void {
  // A checkpoint that found the log busy folded none of it: the redaction has not finished, and is retried as a failure.
  if (Number(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy ?? 0) !== 0) throw new Error('The history log could not be cleared')
  db.exec('VACUUM')
}

function redactEvents(db: DatabaseSync, threadId?: string): void {
  const rows = threadId === undefined
    ? db.prepare('SELECT seq, payload FROM events').all()
    : db.prepare('SELECT seq, payload FROM events WHERE thread_id = ?').all(threadId)
  const update = db.prepare('UPDATE events SET payload = ? WHERE seq = ?')
  for (const row of rows) {
    const payload = redactedPayload(String(row.payload))
    if (payload !== undefined) update.run(payload, Number(row.seq))
  }
}

function rebuildProjection(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('DELETE FROM messages')
    for (const row of db.prepare('SELECT thread_id, payload FROM events ORDER BY seq').all()) {
      let event: ThreadEvent
      try { event = JSON.parse(String(row.payload)) as ThreadEvent } catch { continue }
      // Words that were taken out stay out: a redacted event is history's shape, not a message to draw.
      if ('redacted' in event && event.redacted) continue
      applyEvent(db, String(row.thread_id), event)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** One activity row as a record, checked against the identity it was stored under. */
function storedActivity(row: Record<string, unknown>): AgentActivity {
  const activity = agentActivitySchema.parse(JSON.parse(String(row.payload)))
  if (activity.id !== row.activity_id) throw new Error('Stored activity identity does not match its record')
  return activity
}

function readMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row === undefined ? undefined : String(row.value)
}

function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

/** Whether a batch resets a thread's messages, which takes out what came before. */
function resets(events: readonly ThreadEvent[]): boolean { return events.some(event => event.kind === 'messages-reset') }

/** The memory store's pattern: each pending migration in its own transaction, checked inside it. */
export function prepareThreadDatabase(db: DatabaseSync): void {
  // A save does not wait for the disk (`SAVE_SYNCHRONOUS`); what the user takes out does (`flushedCommits`).
  // `secure_delete` overwrites a deleted row rather than leaving its text in a freed page.
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=${SAVE_SYNCHRONOUS}; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;`)
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)')
  for (const migration of migrations) {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(migration.version)) {
        db.exec(migration.sql)
        db.prepare('INSERT INTO schema_migrations(version, appliedAt) VALUES (?, ?)').run(migration.version, new Date().toISOString())
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
