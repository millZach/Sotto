import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'

import { summarizeThread, type AgentMessage, type AgentThreadSummary } from '../../shared/agents'
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
}]

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

  /** The main runtime supplies a path under `app.getPath('userData')`. */
  constructor(private readonly path: string) {}

  /** Opens the database. `ephemeral` keeps this run's history in memory, for Keep local history off. */
  open(options: { ephemeral?: boolean } = {}): void {
    if (this.db !== undefined) return
    const ephemeral = options.ephemeral === true
    if (!ephemeral) mkdirSync(dirname(this.path), { recursive: true })
    const db = new DatabaseSync(ephemeral ? ':memory:' : this.path, { timeout: 5_000 })
    try {
      migrate(db)
      if (readMeta(db, 'projectionVersion') !== String(PROJECTION_VERSION)) {
        rebuildProjection(db)
        writeMeta(db, 'projectionVersion', String(PROJECTION_VERSION))
      }
      this.db = db
      this.memory = ephemeral
    } catch (error) {
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
    this.db?.close()
    this.db = undefined
    this.memory = false
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
        db.prepare('INSERT INTO events (thread_id, kind, at, payload) VALUES (?, ?, ?, ?)')
          .run(threadId, parsed.kind, parsed.at, JSON.stringify(parsed))
        seq = Number(db.prepare('SELECT last_insert_rowid() AS seq').get()!.seq)
        applyEvent(db, threadId, parsed)
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
    const db = this.requireOpen()
    const bound = options.beforePosition
    const clause = bound === undefined ? '' : ' AND position < ?'
    const parameters = bound === undefined ? [threadId] : [threadId, bound]
    const last = db.prepare(`SELECT MAX(position) AS last FROM messages WHERE thread_id = ?${clause}`).get(...parameters)?.last
    if (last === null || last === undefined) return EMPTY_WINDOW
    const lastPosition = Number(last)
    let firstPosition = 0
    if (options.turns !== undefined) {
      const starts = db.prepare(`SELECT position FROM messages WHERE thread_id = ? AND role = 'user'${clause} ORDER BY position DESC LIMIT ?`)
        .all(...parameters, options.turns).map(row => Number(row.position))
      firstPosition = starts.length < options.turns ? 0 : starts.at(-1)!
    } else if (options.limit !== undefined) {
      firstPosition = Math.max(0, lastPosition - options.limit + 1)
    }
    const rows = db.prepare('SELECT * FROM messages WHERE thread_id = ? AND position BETWEEN ? AND ? ORDER BY position')
      .all(threadId, firstPosition, lastPosition)
    return { messages: rows.map(messageOf), earlierAvailable: firstPosition > 0, firstPosition, lastPosition }
  }

  /** Every message this thread holds, by ID and role, oldest first: what an adapter needs to recognise
   * a message the store already has without reading the words back out of it. */
  messageIdentities(threadId: string): { id: string; role: 'user' | 'assistant' }[] {
    return this.requireOpen().prepare('SELECT message_id, role FROM messages WHERE thread_id = ? ORDER BY position')
      .all(threadId).map(row => ({ id: String(row.message_id), role: String(row.role) as 'user' | 'assistant' }))
  }

  messageCount(threadId: string): number {
    return Number(this.requireOpen().prepare('SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?').get(threadId)!.count)
  }

  /** The sidebar's facts about a thread, taken from the projection rather than from its history. */
  summary(threadId: string): AgentThreadSummary {
    const db = this.requireOpen()
    const count = this.messageCount(threadId)
    const newest = (role: 'user' | 'assistant'): AgentMessage | undefined => {
      const row = db.prepare('SELECT * FROM messages WHERE thread_id = ? AND role = ? ORDER BY position DESC LIMIT 1').get(threadId, role)
      return row === undefined ? undefined : messageOf(row)
    }
    const user = newest('user')
    const assistant = newest('assistant')
    const summary = summarizeThread({ messages: [...(user ? [user] : []), ...(assistant ? [assistant] : [])] })
    return { ...summary, messageCount: count }
  }

  /** Everything after `seq`, in the order it was written. */
  eventsAfter(seq: number, threadId?: string): StoredThreadEvent[] {
    const db = this.requireOpen()
    const rows = threadId === undefined
      ? db.prepare('SELECT seq, thread_id, payload FROM events WHERE seq > ? ORDER BY seq').all(seq)
      : db.prepare('SELECT seq, thread_id, payload FROM events WHERE seq > ? AND thread_id = ? ORDER BY seq').all(seq, threadId)
    return rows.map(row => ({ seq: Number(row.seq), threadId: String(row.thread_id), event: JSON.parse(String(row.payload)) as ThreadEvent }))
  }

  latestSeq(): number {
    const row = this.requireOpen().prepare('SELECT MAX(seq) AS seq FROM events').get()
    return row?.seq === null || row?.seq === undefined ? 0 : Number(row.seq)
  }

  /** Drops one thread's projection and takes the words out of its log, leaving only that it happened. */
  forget(threadId: string): void {
    const db = this.requireOpen()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId)
      redactEvents(db, threadId)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    scrub(db)
  }

  /** The same for every thread: what Keep local history turning off asks of the file. */
  redactAll(): void {
    const db = this.requireOpen()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DELETE FROM messages')
      redactEvents(db)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
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

function applyEvent(db: DatabaseSync, threadId: string, event: ThreadEvent): void {
  switch (event.kind) {
    case 'message-added': {
      const row = db.prepare('SELECT MAX(position) AS last FROM messages WHERE thread_id = ?').get(threadId)
      const position = row?.last === null || row?.last === undefined ? 0 : Number(row.last) + 1
      const { message } = event
      db.prepare('INSERT INTO messages (thread_id, position, message_id, role, text, created_at, command_id, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(threadId, position, message.id, message.role, message.text, message.createdAt,
          message.commandId ?? null, message.attachments === undefined ? null : JSON.stringify(message.attachments))
      return
    }
    case 'message-text-appended':
      db.prepare('UPDATE messages SET text = text || ? WHERE thread_id = ? AND message_id = ?')
        .run(event.appendText, threadId, event.messageId)
      return
    case 'message-replaced': {
      const { message } = event
      db.prepare('UPDATE messages SET role = ?, text = ?, created_at = ?, command_id = ?, attachments = ? WHERE thread_id = ? AND message_id = ?')
        .run(message.role, message.text, message.createdAt, message.commandId ?? null,
          message.attachments === undefined ? null : JSON.stringify(message.attachments), threadId, message.id)
      return
    }
    case 'messages-reset':
      db.prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId)
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
function migrate(db: DatabaseSync): void {
  // `secure_delete` overwrites a deleted row rather than leaving its text in a freed page.
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;')
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
