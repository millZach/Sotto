import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import {
  USAGE_DAILY_BUCKETS_MAX, USAGE_HOURLY_CELLS_MAX, USAGE_MODEL_ROWS_MAX, USAGE_TOKEN_FIELDS,
  usageLocalClearRequestSchema, usageLocalQuerySchema, usageMetadataSchema,
  usagePromptIdentitySchema, usagePromptSubmissionSchema, usageProviderIdSchema, usageTokenObservationSchema,
  type UsageActivityAggregate, type UsageLocalClearResult, type UsageLocalQuery, type UsageLocalRead,
  type UsageMetadata, type UsagePromptAcceptanceResult, type UsagePromptIdentity, type UsagePromptSubmission, type UsagePromptTotals, type UsageTokenField, type UsageTokenObservation,
  type UsageTokenTotals, type UsageWriteResult,
} from '../../shared/usageDashboard'

type SqlRow = Record<string, SQLOutputValue>
interface CalendarParts { day: string; weekday: number; hour: number }
const CALENDAR_FORMATTERS_MAX = 8
const CALENDAR_INSTANTS_MAX = 512
const fields = ['input', 'output', 'cached', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h'] as const
const columns = ['input', 'output', 'cached', 'cache_write', 'cache_write_5m', 'cache_write_1h'] as const
const sqlFields: Record<UsageTokenField, string> = {
  input: 'input', output: 'output', cached: 'cached', cacheWrite: 'cache_write',
  cacheWrite5m: 'cache_write_5m', cacheWrite1h: 'cache_write_1h', total: 'token_total',
}

function safeCount(value: SQLOutputValue | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new RangeError('Usage count exceeds its supported range')
  return value
}
function nextCount(value: number): number { return safeCount(value + 1) }
function canonicalDate(value: string): string { return new Date(value).toISOString() }
function earliest(previous: SQLOutputValue | undefined, incoming: string | undefined): string | null {
  const before = typeof previous === 'string' ? previous : undefined
  const after = incoming === undefined ? undefined : canonicalDate(incoming)
  if (before === undefined) return after ?? null
  return after === undefined || before <= after ? before : after
}
function exclusion(kind: 'row' | 'group' | 'prompt', ...parts: string[]): string {
  const digest = createHash('sha256').update(`sotto-usage-${kind}:`)
  for (const part of parts) digest.update(`${part.length}:`).update(part)
  return digest.digest('hex')
}

/** Host-owned numeric history. It has no dependency on transcript retention or native ledgers. */
export class UsageStore {
  private db: DatabaseSync | undefined
  private readonly calendarFormatters = new Map<string, Intl.DateTimeFormat>()
  private readonly calendarInstants = new Map<string, CalendarParts>()

  constructor(private readonly path: string, private readonly now: () => string = () => new Date().toISOString()) {}

  open(): void {
    if (this.db !== undefined) return
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true })
    const db = new DatabaseSync(this.path, { timeout: 5_000 })
    try {
      db.exec(`
        PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS usage_meta (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), started_at TEXT NOT NULL,
          revision INTEGER NOT NULL, generation INTEGER NOT NULL, cleared_at TEXT, seed_completed INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS token_rows (
          provider TEXT NOT NULL, thread_id TEXT NOT NULL, record_key TEXT NOT NULL, group_key TEXT,
          model_id TEXT NOT NULL, at TEXT, group_started_at TEXT, day TEXT, partial INTEGER NOT NULL,
          input INTEGER, output INTEGER, cached INTEGER, cache_write INTEGER, cache_write_5m INTEGER, cache_write_1h INTEGER,
          PRIMARY KEY(provider, thread_id, record_key)
        );
        CREATE INDEX IF NOT EXISTS token_rows_date ON token_rows(day);
        CREATE INDEX IF NOT EXISTS token_rows_model ON token_rows(provider, model_id);
        CREATE INDEX IF NOT EXISTS token_rows_group ON token_rows(provider, thread_id, group_key);
        CREATE TABLE IF NOT EXISTS prompt_rows (
          thread_id TEXT NOT NULL, message_id TEXT NOT NULL, provider TEXT NOT NULL, model_id TEXT NOT NULL,
          at TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, input_kind TEXT NOT NULL,
          PRIMARY KEY(thread_id, message_id)
        );
        CREATE INDEX IF NOT EXISTS prompt_rows_date ON prompt_rows(day);
        CREATE INDEX IF NOT EXISTS prompt_rows_model ON prompt_rows(provider, model_id);
        CREATE TABLE IF NOT EXISTS pending_prompt_rows (
          thread_id TEXT NOT NULL, message_id TEXT NOT NULL, provider TEXT NOT NULL, model_id TEXT NOT NULL,
          at TEXT NOT NULL, kind TEXT NOT NULL, input_kind TEXT NOT NULL,
          PRIMARY KEY(thread_id, message_id)
        );
        CREATE TABLE IF NOT EXISTS exclusions (identity_hash TEXT PRIMARY KEY NOT NULL);
      `)
      const startedAt = canonicalDate(this.now())
      usageMetadataSchema.parse({ startedAt, revision: 0, generation: 0, legacySeedCompleted: false })
      db.prepare('INSERT OR IGNORE INTO usage_meta VALUES (1, ?, 0, 0, NULL, 0)').run(startedAt)
      db.function('usage_day', { deterministic: true }, (instant, timeZone) => this.calendar(instant, timeZone)?.day ?? null)
      db.function('usage_weekday', { deterministic: true }, (instant, timeZone) => this.calendar(instant, timeZone)?.weekday ?? null)
      db.function('usage_hour', { deterministic: true }, (instant, timeZone) => this.calendar(instant, timeZone)?.hour ?? null)
      this.db = db
    } catch (error) { db.close(); throw error }
  }

  close(): void {
    if (this.db === undefined) return
    this.db.close()
    this.db = undefined
    this.calendarFormatters.clear()
    this.calendarInstants.clear()
  }

  metadata(): UsageMetadata {
    const row = this.requireOpen().prepare('SELECT * FROM usage_meta WHERE singleton=1').get()
    if (row === undefined) throw new Error('Usage metadata is unavailable')
    return usageMetadataSchema.parse({
      startedAt: row.started_at, revision: row.revision, generation: row.generation,
      ...(row.cleared_at === null ? {} : { clearedAt: row.cleared_at }), legacySeedCompleted: row.seed_completed === 1,
    })
  }

  observeTokens(input: UsageTokenObservation): UsageWriteResult {
    const observation = usageTokenObservationSchema.parse(input)
    return this.transaction(db => {
      const metadata = this.metadata()
      const identity = [observation.providerId, observation.threadId, observation.recordKey]
      const rowHash = exclusion('row', ...identity)
      const groupHash = observation.groupKey === undefined ? undefined : exclusion('group', observation.providerId, observation.threadId, observation.groupKey)
      if (this.excluded(db, rowHash) || (groupHash !== undefined && this.excluded(db, groupHash))) return { status: 'suppressed', revision: metadata.revision }
      const previous = db.prepare('SELECT * FROM token_rows WHERE provider=? AND thread_id=? AND record_key=?').get(...identity)
      // The old accounting file is a one-time import, not newer native evidence. In particular,
      // Grok's aggregate cost row must not overwrite an exact model row after a restart.
      if (observation.phase === 'seed' && previous !== undefined) return { status: 'unchanged', revision: metadata.revision }
      if (observation.providerId === 'grok' && observation.partial
        && (observation.modelId === 'unknown' || observation.modelId === 'native:grok:model:unknown')
        && previous !== undefined && previous.model_id !== observation.modelId) {
        // A replay without model breakdown cannot turn one exact model row back into a whole-turn aggregate.
        const reportedTotal = observation.tokens.input !== undefined && observation.tokens.output !== undefined
          ? observation.tokens.input + observation.tokens.output : undefined
        const groupTotal = observation.groupKey === undefined
          ? typeof previous.input === 'number' && typeof previous.output === 'number' ? previous.input + previous.output : undefined
          : db.prepare('SELECT SUM(input+output) AS total FROM token_rows WHERE provider=? AND thread_id=? AND group_key=?')
            .get(observation.providerId, observation.threadId, observation.groupKey)?.total
        if (reportedTotal !== undefined && typeof groupTotal === 'number' && reportedTotal < groupTotal) {
          // Contradictory totals do not establish a lower bound. Wait for exact model evidence.
          const scope = observation.groupKey === undefined ? 'record_key' : 'group_key'
          db.prepare(`UPDATE token_rows SET partial=1,${columns.map(column => `${column}=NULL`).join(',')}
            WHERE provider=? AND thread_id=? AND ${scope}=?`).run(observation.providerId, observation.threadId, observation.groupKey ?? observation.recordKey)
          return { status: 'written', revision: this.bumpRevision(db, metadata.revision) }
        }
        if (previous.partial === 1) return { status: 'unchanged', revision: metadata.revision }
        db.prepare('UPDATE token_rows SET partial=1 WHERE provider=? AND thread_id=? AND record_key=?').run(...identity)
        return { status: 'written', revision: this.bumpRevision(db, metadata.revision) }
      }
      if (metadata.clearedAt !== undefined && previous === undefined) {
        const admittedGroup = observation.groupKey !== undefined && db.prepare('SELECT 1 FROM token_rows WHERE provider=? AND thread_id=? AND group_key=? LIMIT 1')
          .get(observation.providerId, observation.threadId, observation.groupKey) !== undefined
        const provedStart = observation.groupStartedAt !== undefined && canonicalDate(observation.groupStartedAt) > metadata.clearedAt
        if (!admittedGroup && !provedStart && observation.liveNewGroup !== true) return { status: 'suppressed', revision: metadata.revision }
      }
      const at = earliest(previous?.at, observation.at ?? observation.groupStartedAt)
      const groupStartedAt = earliest(previous?.group_started_at, observation.groupStartedAt)
      // Replays may learn an older genuine date; observation time never fills an undated row.
      const values: SQLInputValue[] = [
        observation.groupKey ?? (typeof previous?.group_key === 'string' ? previous.group_key : null),
        observation.modelId, at, groupStartedAt, at?.slice(0, 10) ?? null, observation.partial ? 1 : 0,
        ...fields.map(field => observation.tokens[field] ?? null),
      ]
      const storedColumns = ['group_key', 'model_id', 'at', 'group_started_at', 'day', 'partial', ...columns]
      if (previous !== undefined && storedColumns.every((column, index) => previous[column] === values[index])) {
        return { status: 'unchanged', revision: metadata.revision }
      }
      db.prepare(`INSERT INTO token_rows (provider,thread_id,record_key,${storedColumns.join(',')})
        VALUES (${[...identity, ...values].map(() => '?').join(',')})
        ON CONFLICT(provider,thread_id,record_key) DO UPDATE SET ${storedColumns.map(column => `${column}=excluded.${column}`).join(',')}`)
        .run(...identity, ...values)
      return { status: 'written', revision: this.bumpRevision(db, metadata.revision) }
    })
  }

  /** Retain the original selection and origin after durable intent, before executing the native send. */
  submitPrompt(input: UsagePromptSubmission): UsageWriteResult {
    const observation = usagePromptSubmissionSchema.parse(input)
    return this.transaction(db => {
      const metadata = this.metadata()
      if (this.excluded(db, exclusion('prompt', observation.threadId, observation.messageId))) return { status: 'suppressed', revision: metadata.revision }
      const previous = db.prepare('SELECT 1 FROM prompt_rows WHERE thread_id=? AND message_id=?').get(observation.threadId, observation.messageId)
      if (previous !== undefined) return { status: 'unchanged', revision: metadata.revision }
      const pending = db.prepare('SELECT 1 FROM pending_prompt_rows WHERE thread_id=? AND message_id=?').get(observation.threadId, observation.messageId)
      if (pending !== undefined) return { status: 'unchanged', revision: metadata.revision }
      const at = canonicalDate(observation.at)
      if (metadata.clearedAt !== undefined && at <= metadata.clearedAt) return { status: 'suppressed', revision: metadata.revision }
      db.prepare('INSERT INTO pending_prompt_rows (thread_id,message_id,provider,model_id,at,kind,input_kind) VALUES (?,?,?,?,?,?,?)')
        .run(observation.threadId, observation.messageId, observation.providerId, observation.modelId, at, observation.kind, observation.inputKind)
      return { status: 'written', revision: this.bumpRevision(db, metadata.revision) }
    })
  }

  /** Only an exact user-message echo may call this. Missing intent cannot reconstruct selection or origin. */
  acceptSubmittedPrompt(threadId: string, messageId: string): UsagePromptAcceptanceResult {
    usagePromptIdentitySchema.parse({ threadId, messageId })
    return this.transaction(db => {
      const metadata = this.metadata()
      if (this.excluded(db, exclusion('prompt', threadId, messageId))) return { status: 'suppressed', revision: metadata.revision }
      if (db.prepare('SELECT 1 FROM prompt_rows WHERE thread_id=? AND message_id=?').get(threadId, messageId) !== undefined) {
        return { status: 'unchanged', revision: metadata.revision }
      }
      const pending = db.prepare('SELECT * FROM pending_prompt_rows WHERE thread_id=? AND message_id=?').get(threadId, messageId)
      if (pending === undefined) return { status: 'missing', revision: metadata.revision }
      const observation = usagePromptSubmissionSchema.parse({
        providerId: pending.provider, threadId, messageId, modelId: pending.model_id, at: pending.at,
        kind: pending.kind, inputKind: pending.input_kind,
      })
      const at = canonicalDate(observation.at)
      db.prepare('INSERT INTO prompt_rows (thread_id,message_id,provider,model_id,at,day,kind,input_kind) VALUES (?,?,?,?,?,?,?,?)')
        .run(observation.threadId, observation.messageId, observation.providerId, observation.modelId, at, at.slice(0, 10), observation.kind, observation.inputKind)
      db.prepare('DELETE FROM pending_prompt_rows WHERE thread_id=? AND message_id=?').run(threadId, messageId)
      return { status: 'written', revision: this.bumpRevision(db, metadata.revision) }
    })
  }

  /** A definitive refusal can drop pending metadata. Uncertain native results must leave it intact. */
  discardSubmittedPrompt(threadId: string, messageId: string): UsageWriteResult {
    usagePromptIdentitySchema.parse({ threadId, messageId })
    return this.transaction(db => {
      const metadata = this.metadata()
      const pending = db.prepare('SELECT 1 FROM pending_prompt_rows WHERE thread_id=? AND message_id=?').get(threadId, messageId)
      if (pending === undefined) return { status: 'unchanged', revision: metadata.revision }
      db.prepare('DELETE FROM pending_prompt_rows WHERE thread_id=? AND message_id=?').run(threadId, messageId)
      return { status: 'written', revision: this.bumpRevision(db, metadata.revision) }
    })
  }

  /** Internal reconciliation visitor; callers never receive prompt contents or an unbounded archive array. */
  visitPendingPromptIdentities(visitor: (identity: UsagePromptIdentity) => void): void {
    for (const row of this.requireOpen().prepare('SELECT thread_id,message_id FROM pending_prompt_rows ORDER BY thread_id,message_id').iterate()) {
      visitor(usagePromptIdentitySchema.parse({ threadId: row.thread_id, messageId: row.message_id }))
    }
  }

  markLegacySeedCompleted(): UsageWriteResult {
    return this.transaction(db => {
      const metadata = this.metadata()
      if (metadata.legacySeedCompleted) return { status: 'unchanged', revision: metadata.revision }
      db.prepare('UPDATE usage_meta SET seed_completed=1 WHERE singleton=1').run()
      return { status: 'written', revision: this.bumpRevision(db, metadata.revision) }
    })
  }

  clear(expectedRevision: number): UsageLocalClearResult {
    usageLocalClearRequestSchema.parse({ expectedRevision })
    return this.transaction(db => {
      const metadata = this.metadata()
      if (metadata.revision !== expectedRevision) return { status: 'stale', metadata }
      const addExclusion = db.prepare('INSERT OR IGNORE INTO exclusions VALUES (?)')
      for (const row of db.prepare('SELECT provider,thread_id,record_key,group_key FROM token_rows').iterate()) {
        addExclusion.run(exclusion('row', String(row.provider), String(row.thread_id), String(row.record_key)))
        if (typeof row.group_key === 'string') addExclusion.run(exclusion('group', String(row.provider), String(row.thread_id), row.group_key))
      }
      for (const row of db.prepare('SELECT thread_id,message_id FROM prompt_rows').iterate()) {
        addExclusion.run(exclusion('prompt', String(row.thread_id), String(row.message_id)))
      }
      for (const row of db.prepare('SELECT thread_id,message_id FROM pending_prompt_rows').iterate()) {
        addExclusion.run(exclusion('prompt', String(row.thread_id), String(row.message_id)))
      }
      const clearedAt = canonicalDate(this.now())
      const next = usageMetadataSchema.parse({
        ...metadata, revision: nextCount(metadata.revision), generation: nextCount(metadata.generation),
        clearedAt: metadata.clearedAt !== undefined && metadata.clearedAt > clearedAt ? metadata.clearedAt : clearedAt,
      })
      db.exec('DELETE FROM token_rows; DELETE FROM prompt_rows; DELETE FROM pending_prompt_rows;')
      db.prepare('UPDATE usage_meta SET revision=?,generation=?,cleared_at=? WHERE singleton=1').run(next.revision, next.generation, next.clearedAt!)
      return { status: 'cleared', metadata: next }
    })
  }

  query(input: UsageLocalQuery = {}): UsageLocalRead {
    const query = usageLocalQuerySchema.parse(input)
    const timeZone = query.timeZone ?? 'UTC'
    const db = this.requireOpen()
    const filters = queryFilters(query)
    const source = `WITH records AS (
      SELECT provider,model_id,thread_id,at,1 AS is_token,partial,${columns.join(',')},
        CASE WHEN input IS NOT NULL AND output IS NOT NULL THEN input+output END AS token_total,
        NULL AS kind,NULL AS input_kind FROM token_rows
      UNION ALL
      SELECT provider,model_id,thread_id,at,0 AS is_token,0 AS partial,${columns.map(() => 'NULL').join(',')},NULL AS token_total,
        kind,input_kind FROM prompt_rows
    ), dated AS (
      SELECT *,usage_day(at,?) AS day FROM records
    ), activity AS (
      SELECT * FROM dated ${filters.sql}
    )`
    const parameters = [timeZone, ...filters.parameters]
    const totalRow = db.prepare(`${source} SELECT ${aggregateSql()} FROM activity`).get(...parameters)
    if (totalRow === undefined) throw new Error('Usage totals are unavailable')
    const providers = db.prepare(`${source} SELECT provider,${aggregateSql()} FROM activity GROUP BY provider ORDER BY provider`).all(...parameters)
      .map(row => ({ ...aggregate(row), providerId: usageProviderIdSchema.parse(row.provider) }))
    const modelRows = db.prepare(`${source} SELECT provider,model_id,${aggregateSql()} FROM activity GROUP BY provider,model_id
      ORDER BY (input_value+output_value) DESC,prompt_total DESC,provider,model_id LIMIT ?`).all(...parameters, USAGE_MODEL_ROWS_MAX)
    const modelCountRow = db.prepare(`${source} SELECT COUNT(*) AS count FROM (SELECT provider,model_id FROM activity GROUP BY provider,model_id)`).get(...parameters)
    const modelCount = safeCount(modelCountRow?.count)
    const range = db.prepare(`${source} SELECT MIN(day) AS first_day,MAX(day) AS last_day FROM activity`).get(...parameters)
    const from = query.from ?? (typeof range?.first_day === 'string' ? range.first_day : undefined)
    const to = query.to ?? (typeof range?.last_day === 'string' ? range.last_day : undefined)
    const span = from === undefined || to === undefined ? 0 : (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1
    const dailyCoverage = query.includeDaily === false ? 'not-requested' : span > USAGE_DAILY_BUCKETS_MAX ? 'omitted-range' : 'complete'
    const daily = dailyCoverage !== 'complete' ? [] : db.prepare(`${source} SELECT day,${aggregateSql()} FROM activity
      WHERE day IS NOT NULL GROUP BY day ORDER BY day LIMIT ?`).all(...parameters, USAGE_DAILY_BUCKETS_MAX)
      .map(row => ({ ...aggregate(row), day: String(row.day) }))
    const hourly = db.prepare(`${source} SELECT usage_weekday(at,?) AS weekday,usage_hour(at,?) AS hour,${promptAggregateSql()}
      FROM activity WHERE is_token=0 GROUP BY weekday,hour ORDER BY weekday,hour LIMIT ?`)
      .all(...parameters, timeZone, timeZone, USAGE_HOURLY_CELLS_MAX)
      .map(row => ({ weekday: safeCount(row.weekday), hour: safeCount(row.hour), prompts: promptTotals(row) }))
    return {
      metadata: this.metadata(), totals: aggregate(totalRow), providers, timeZone,
      models: modelRows.map(row => ({ ...aggregate(row), providerId: usageProviderIdSchema.parse(row.provider), modelId: String(row.model_id) })),
      modelCount, modelsTruncated: modelCount > USAGE_MODEL_ROWS_MAX, daily, dailyCoverage, hourly,
    }
  }

  private requireOpen(): DatabaseSync {
    if (this.db === undefined) throw new Error('Usage store is closed')
    return this.db
  }
  private calendar(instant: SQLOutputValue, timeZone: SQLOutputValue): CalendarParts | null {
    if (instant === null) return null
    if (typeof instant !== 'string' || typeof timeZone !== 'string') throw new Error('Usage calendar input is invalid')
    const key = `${timeZone}\0${instant}`
    const cached = this.calendarInstants.get(key)
    if (cached !== undefined) return cached
    let formatter = this.calendarFormatters.get(timeZone)
    if (formatter === undefined) {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone, calendar: 'iso8601', numberingSystem: 'latn', hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit',
      })
      cacheBounded(this.calendarFormatters, timeZone, formatter, CALENDAR_FORMATTERS_MAX)
    }
    const parts = formatter.formatToParts(new Date(instant))
    const part = (type: Intl.DateTimeFormatPartTypes): string => {
      const value = parts.find(value => value.type === type)?.value
      if (value === undefined) throw new Error('Usage calendar component is unavailable')
      return value
    }
    const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(part('weekday'))
    const hour = Number(part('hour'))
    if (weekday < 0 || !Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('Usage calendar component is invalid')
    const result = { day: `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`, weekday, hour }
    cacheBounded(this.calendarInstants, key, result, CALENDAR_INSTANTS_MAX)
    return result
  }
  private excluded(db: DatabaseSync, identityHash: string): boolean {
    return db.prepare('SELECT 1 FROM exclusions WHERE identity_hash=?').get(identityHash) !== undefined
  }
  private bumpRevision(db: DatabaseSync, revision: number): number {
    const next = nextCount(revision)
    db.prepare('UPDATE usage_meta SET revision=? WHERE singleton=1').run(next)
    return next
  }
  private transaction<T>(operation: (db: DatabaseSync) => T): T {
    const db = this.requireOpen()
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation(db)
      db.exec('COMMIT')
      return result
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
}

function queryFilters(query: UsageLocalQuery): { sql: string; parameters: SQLInputValue[] } {
  const conditions: string[] = []
  const parameters: SQLInputValue[] = []
  for (const [column, values] of [['provider', query.providerIds], ['model_id', query.modelIds]] as const) {
    if (values === undefined) continue
    conditions.push(values.length === 0 ? '0' : `${column} IN (${values.map(() => '?').join(',')})`)
    parameters.push(...values)
  }
  if (query.from !== undefined) { conditions.push('day>=?'); parameters.push(query.from) }
  if (query.to !== undefined) { conditions.push('day<=?'); parameters.push(query.to) }
  return { sql: conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`, parameters }
}

function aggregateSql(): string {
  return [
    'COUNT(DISTINCT thread_id) AS active_threads', 'COUNT(DISTINCT day) AS active_days',
    'COALESCE(SUM(is_token),0) AS token_records', 'COALESCE(SUM(partial),0) AS partial_records',
    'COALESCE(SUM(CASE WHEN is_token=1 AND day IS NULL THEN 1 ELSE 0 END),0) AS undated_records',
    ...USAGE_TOKEN_FIELDS.flatMap(field => {
      const column = sqlFields[field]
      return [`TOTAL(${column}) AS ${column}_value`, `COUNT(${column}) AS ${column}_known`]
    }),
    promptAggregateSql(),
  ].join(',')
}

function promptAggregateSql(): string {
  return [
    "COALESCE(SUM(CASE WHEN kind='user' THEN 1 ELSE 0 END),0) AS prompt_user",
    "COALESCE(SUM(CASE WHEN kind='watcher' THEN 1 ELSE 0 END),0) AS prompt_watcher",
    "COALESCE(SUM(CASE WHEN kind='wake-up' THEN 1 ELSE 0 END),0) AS prompt_wake_up",
    'COALESCE(SUM(1-is_token),0) AS prompt_total',
    "COALESCE(SUM(CASE WHEN input_kind='steer' THEN 1 ELSE 0 END),0) AS prompt_steered",
  ].join(',')
}

function promptTotals(row: SqlRow): UsagePromptTotals {
  return {
    user: safeCount(row.prompt_user), watcher: safeCount(row.prompt_watcher), wakeUp: safeCount(row.prompt_wake_up),
    total: safeCount(row.prompt_total), steered: safeCount(row.prompt_steered),
  }
}

function cacheBounded<T>(cache: Map<string, T>, key: string, value: T, maximum: number): void {
  cache.set(key, value)
  if (cache.size <= maximum) return
  const oldest = cache.keys().next().value
  if (oldest !== undefined) cache.delete(oldest)
}

function aggregate(row: SqlRow): UsageActivityAggregate {
  const tokenRecords = safeCount(row.token_records)
  const partialTokenRecords = safeCount(row.partial_records)
  const tokens = Object.fromEntries(USAGE_TOKEN_FIELDS.map(field => {
    const column = sqlFields[field]
    const knownRows = safeCount(row[`${column}_known`])
    return [field, {
      ...(knownRows === 0 ? {} : { value: safeCount(row[`${column}_value`]) }),
      knownRows, rows: tokenRecords, partial: knownRows < tokenRecords || partialTokenRecords > 0,
    }]
  })) as UsageTokenTotals
  return {
    tokens, tokenRecords, partialTokenRecords, undatedTokenRecords: safeCount(row.undated_records),
    activeThreads: safeCount(row.active_threads), activeDays: safeCount(row.active_days),
    prompts: promptTotals(row),
  }
}
