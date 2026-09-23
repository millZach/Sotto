import { existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'

import { summarizeThread, type AgentMessage, type AgentThreadSummary } from '../../shared/agents'
import { agentActivitySchema, MAX_AGENT_ACTIVITIES, type AgentActivity } from '../../shared/agentActivity'
import { threadEventSchema, type StoredThreadEvent, type ThreadEvent } from '../../shared/threadEvents'

/** The first window a pane is given, and what each later request adds, both counted in turns. */
export const FIRST_WINDOW_TURNS = 10
export const LATER_WINDOW_TURNS = 20

/**
 * The projection's shape. A change here means the `messages` table is rebuilt from `events` on the next
 * open, so nothing about a thread's history depends on a projection written by an older run.
 */
const PROJECTION_VERSION = 1

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
}]

interface ActivityState {
  known: boolean
  epoch: string | undefined
  resetSequence: number | undefined
  records: Map<string, { position: number; activity: AgentActivity }>
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
  return {
    id: String(row.message_id), role: String(row.role) as AgentMessage['role'],
    text: String(row.text), createdAt: String(row.created_at),
    ...(row.command_id === null || row.command_id === undefined ? {} : { commandId: String(row.command_id) }),
    ...(attachments === undefined || attachments.length === 0 ? {} : { attachments }),
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
  private readonly activityRedactions = new Set<string>()
  private readonly redactionChecks = new Map<string, Map<string, boolean>>()
  /** While history is off, this connection writes identity hashes alone, never activity text. */
  private durableRedactions: ThreadStore | undefined

  /** The main runtime supplies a path under `app.getPath('userData')`. */
  constructor(private readonly path: string) {}

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
    } catch (error) {
      this.statements.clear()
      this.activityRedactions.clear()
      this.db = undefined
      this.memory = false
      db.close()
      throw error
    }
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
    this.activityRedactions.clear()
    this.redactionChecks.clear()
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
        const durable = new ThreadStore(this.path)
        durable.open()
        this.durableRedactions = durable
      }
      this.durableRedactions.rememberActivityRedactions(added)
    } else {
      const db = this.requireOpen()
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const hash of added) this.statement('INSERT OR IGNORE INTO activity_redactions (identity_hash) VALUES (?)').run(hash)
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
    }
    for (const hash of added) this.activityRedactions.add(hash)
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
        const activity = agentActivitySchema.parse(JSON.parse(String(row.payload)))
        if (activity.id !== row.activity_id) throw new Error('Stored activity identity does not match its record')
        records.set(activity.id, { position: Number(row.position), activity })
      }
      state = { known: epochRow !== undefined, epoch: epoch === undefined || epoch === null ? undefined : String(epoch), resetSequence: epochRow?.message_reset_seq === null || epochRow?.message_reset_seq === undefined ? undefined : Number(epochRow.message_reset_seq), records }
      this.activityStates.set(threadId, state)
    }
    return state
  }

  /** True once an authoritative list has been stored, even when that list is empty. */
  hasActivities(threadId: string): boolean {
    return this.activityState(threadId).known
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
    return this.activityState(threadId).resetSequence
  }
  /** The epoch committed with the list; hasActivities distinguishes unknown from unversioned. */
  readActivityEpoch(threadId: string): string | undefined {
    return this.activityState(threadId).epoch
  }

  /** A caller owns its returned records, including nested plan steps and file changes. */
  readActivities(threadId: string): AgentActivity[] {
    return [...this.activityState(threadId).records.values()].map(({ activity }) => agentActivitySchema.parse(activity))
  }

  /** Persists the bounded authoritative list, encoding only records whose values changed. */
  syncActivities(threadId: string, activities: readonly AgentActivity[], epoch?: string): void {
    const db = this.requireOpen()
    if (activities.length > MAX_AGENT_ACTIVITIES) throw new Error('Too many thread activities')
    const previous = this.activityState(threadId)
    const resetSequence = this.readMessageEpoch(threadId)?.sequence ?? 0
    const reset = previous.epoch !== epoch || (previous.resetSequence !== undefined && previous.resetSequence !== resetSequence)
    const next: ActivityState = { known: true, epoch, resetSequence, records: new Map() }
    const changed: { position: number; activity: AgentActivity }[] = []
    const moved: { id: string; position: number }[] = []
    const seen = new Set<string>()
    for (const activity of activities) {
      if (seen.has(activity.id)) throw new Error('Duplicate thread activity identity')
      seen.add(activity.id)
      if (this.activityWasRedacted(threadId, activity.id)) continue
      const position = next.records.size
      const prior = reset ? undefined : previous.records.get(activity.id)
      if (prior !== undefined && isDeepStrictEqual(prior.activity, activity)) {
        next.records.set(activity.id, { position, activity: prior.activity })
        if (prior.position !== position) moved.push({ id: activity.id, position })
      } else {
        const record = { position, activity: agentActivitySchema.parse(activity) }
        next.records.set(activity.id, record)
        changed.push(record)
      }
    }
    const removed = [...previous.records.keys()].filter(id => !next.records.has(id))
    if (previous.known && previous.resetSequence === resetSequence && !reset && changed.length === 0 && moved.length === 0 && removed.length === 0) return
    if (this.memory) this.redactActivityIdentities(threadId, changed.map(({ activity }) => activity.id))
    db.exec('BEGIN IMMEDIATE')
    try {
      if (reset) {
        this.statement('DELETE FROM activities WHERE thread_id = ?').run(threadId)
      } else {
        for (const id of removed) this.statement('DELETE FROM activities WHERE thread_id = ? AND activity_id = ?').run(threadId, id)
      }
      if (!previous.known || reset || previous.resetSequence !== resetSequence) {
        this.statement('INSERT INTO activity_epochs (thread_id, epoch, message_reset_seq) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET epoch = excluded.epoch, message_reset_seq = excluded.message_reset_seq').run(threadId, epoch ?? null, resetSequence)
      }
      for (const { position, activity } of changed) {
        this.statement('INSERT INTO activities (thread_id, activity_id, position, payload) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id, activity_id) DO UPDATE SET position = excluded.position, payload = excluded.payload')
          .run(threadId, activity.id, position, JSON.stringify(activity))
      }
      for (const { id, position } of moved) this.statement('UPDATE activities SET position = ? WHERE thread_id = ? AND activity_id = ?').run(position, threadId, id)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    this.activityStates.set(threadId, next)
  }

  /** Writes one event and applies it to the projection in a single transaction. */
  append(threadId: string, event: ThreadEvent): number {
    return this.appendMany(threadId, [event])
  }

  /** The same for a run of events, so a publish costs one transaction. Returns the last sequence written. */
  appendMany(threadId: string, events: readonly ThreadEvent[]): number {
    const db = this.requireOpen()
    if (events.length === 0) return this.latestSeq()
    let seq = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const event of events) {
        const parsed = threadEventSchema.parse(event)
        this.statement('INSERT INTO events (thread_id, kind, at, payload) VALUES (?, ?, ?, ?)')
          .run(threadId, parsed.kind, parsed.at, JSON.stringify(parsed))
        seq = Number(this.statement('SELECT last_insert_rowid() AS seq').get()!.seq)
        applyEvent(db, threadId, parsed, sql => this.statement(sql))
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
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

  /** Every message this thread holds, by ID and role, oldest first: what an adapter needs to recognise
   * a message the store already has without reading the words back out of it. */
  messageIdentities(threadId: string): { id: string; role: 'user' | 'assistant' }[] {
    return this.statement('SELECT message_id, role FROM messages WHERE thread_id = ? ORDER BY position')
      .all(threadId).map(row => ({ id: String(row.message_id), role: String(row.role) as 'user' | 'assistant' }))
  }

  /** Whether the thread holds this message: one indexed lookup, never a read of the thread. */
  hasMessage(threadId: string, messageId: string): boolean {
    return this.statement('SELECT 1 AS found FROM messages WHERE thread_id = ? AND message_id = ? LIMIT 1').get(threadId, messageId) !== undefined
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
  eventsAfter(seq: number, threadId?: string): StoredThreadEvent[] {
    const rows = threadId === undefined
      ? this.statement('SELECT seq, thread_id, payload FROM events WHERE seq > ? ORDER BY seq').all(seq)
      : this.statement('SELECT seq, thread_id, payload FROM events WHERE seq > ? AND thread_id = ? ORDER BY seq').all(seq, threadId)
    return rows.map(row => ({ seq: Number(row.seq), threadId: String(row.thread_id), event: JSON.parse(String(row.payload)) as ThreadEvent }))
  }

  latestSeq(): number {
    const row = this.statement('SELECT MAX(seq) AS seq FROM events').get()
    return row?.seq === null || row?.seq === undefined ? 0 : Number(row.seq)
  }

  /** Drops one thread's projection and takes the words out of its log, leaving only that it happened. */
  forget(threadId: string): void {
    const db = this.requireOpen()
    const hashes = this.activityIdentityHashes(threadId)
    db.exec('BEGIN IMMEDIATE')
    try {
      this.statement('DELETE FROM messages WHERE thread_id = ?').run(threadId)
      for (const hash of hashes) this.statement('INSERT OR IGNORE INTO activity_redactions (identity_hash) VALUES (?)').run(hash)
      this.statement('DELETE FROM activities WHERE thread_id = ?').run(threadId)
      this.statement('DELETE FROM activity_epochs WHERE thread_id = ?').run(threadId)
      redactEvents(db, threadId)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    this.activityStates.delete(threadId)
    for (const hash of hashes) this.activityRedactions.add(hash)
    this.redactionChecks.clear()
    scrub(db)
  }

  /** The same for every thread: what Keep local history turning off asks of the file. */
  redactAll(): void {
    const db = this.requireOpen()
    const hashes = this.activityIdentityHashes()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DELETE FROM messages')
      for (const hash of hashes) this.statement('INSERT OR IGNORE INTO activity_redactions (identity_hash) VALUES (?)').run(hash)
      db.exec('DELETE FROM activities')
      db.exec('DELETE FROM activity_epochs')
      redactEvents(db)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    this.activityStates.clear()
    for (const hash of hashes) this.activityRedactions.add(hash)
    this.redactionChecks.clear()
    scrub(db)
  }

  /**
   * This thread's history is now exactly these messages: a rewind the provider confirmed, or the
   * one-time move of a thread out of `workspace.json`. One transaction, so a failure leaves the
   * thread as it was.
   */
  replaceThreadMessages(threadId: string, messages: readonly AgentMessage[], historyEpoch?: string): void {
    const at = new Date().toISOString()
    this.appendMany(threadId, [
      { kind: 'messages-reset', at, ...(historyEpoch === undefined ? {} : { historyEpoch }) },
      ...messages.map(message => ({ kind: 'message-added' as const, at: message.createdAt || at, message })),
    ])
  }

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
      prepare('INSERT INTO messages (thread_id, position, message_id, role, text, created_at, command_id, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(threadId, position, message.id, message.role, message.text, message.createdAt,
          message.commandId ?? null, message.attachments === undefined ? null : JSON.stringify(message.attachments))
      return
    }
    case 'message-text-appended':
      prepare('UPDATE messages SET text = text || ? WHERE thread_id = ? AND message_id = ?')
        .run(event.appendText, threadId, event.messageId)
      return
    case 'message-replaced': {
      const { message } = event
      prepare('UPDATE messages SET role = ?, text = ?, created_at = ?, command_id = ?, attachments = ? WHERE thread_id = ? AND message_id = ?')
        .run(message.role, message.text, message.createdAt, message.commandId ?? null,
          message.attachments === undefined ? null : JSON.stringify(message.attachments), threadId, message.id)
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
      return JSON.stringify({ ...event, answer: '' })
    default:
      return undefined
  }
}

/**
 * Redaction is not finished while the words are still in a freed page or in the write-ahead log. The
 * checkpoint folds the log into the file and the vacuum rewrites it, so what was taken out is gone.
 */
function scrub(db: DatabaseSync): void {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
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

function readMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row === undefined ? undefined : String(row.value)
}

function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

/** The memory store's pattern: each pending migration in its own transaction, checked inside it. */
export function prepareThreadDatabase(db: DatabaseSync): void {
  // Provider cursors are saved independently: history cannot rely on replay after a lost commit.
  // `secure_delete` overwrites a deleted row rather than leaving its text in a freed page.
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;')
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
