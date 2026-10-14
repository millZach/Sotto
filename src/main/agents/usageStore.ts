import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from 'node:sqlite'
import { z } from 'zod'
import { canonicalModelId } from '../../shared/modelCatalog'
import {
  USAGE_CLIENT_ROWS_MAX, USAGE_DAILY_BUCKETS_MAX, USAGE_HISTORY_BATCH_MAX, USAGE_HOURLY_CELLS_MAX, USAGE_MODEL_ROWS_MAX, USAGE_TOKEN_FIELDS,
  usageClientSchema, usageHistoryCursorSchema, usageHistoryPromptSchema, usageHistoryStatusSchema,
  usageLocalClearRequestSchema, usageLocalQuerySchema, usageMetadataSchema,
  usagePromptIdentitySchema, usagePromptSubmissionSchema, usageProviderIdSchema, usageSourceSchema, usageTokenObservationSchema,
  type UsageActivityAggregate, type UsageClientAggregate, type UsageHistoryCursor, type UsageHistoryPrompt, type UsageHistoryStatus,
  type UsageLocalClearResult, type UsageLocalQuery, type UsageLocalRead,
  type UsageMetadata, type UsagePromptAcceptanceResult, type UsagePromptIdentity, type UsagePromptSubmission, type UsagePromptTotals,
  type UsageTokenField, type UsageTokenObservation, type UsageTokenTotals, type UsageWriteResult,
} from '../../shared/usageDashboard'

type SqlRow = Record<string, SQLOutputValue>
type WriteStatus = UsageWriteResult['status']
export const USAGE_PENDING_RECONCILIATION_BATCH_MAX = 128
/** The schema this file migrates every store to. 0 is the October 12 schema, which had no history columns. */
const SCHEMA_VERSION = 1
const ZONE_OFFSETS_MAX = 65_536
const MODEL_IDS_MAX = 4_096
const STATEMENTS_MAX = 256
const MINUTE = 60_000
/** Every zone offset and transition in use is a whole number of 15-minute steps, so one bucket has one offset. */
const BUCKET = 15 * MINUTE
/** Two transitions inside six hours do not occur; sampling this often finds each one. */
const SAMPLE = 6 * 60 * MINUTE
const DAY = 24 * 60 * MINUTE
const fields = ['input', 'output', 'cached', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h'] as const
const columns = ['input', 'output', 'cached', 'cache_write', 'cache_write_5m', 'cache_write_1h'] as const
/** Pre-aggregated columns: the six token fields and their sum, each with its known-row count. */
const valueColumns = [...columns, 'token_total'] as const
const sqlFields: Record<UsageTokenField, string> = {
  input: 'input', output: 'output', cached: 'cached', cacheWrite: 'cache_write',
  cacheWrite5m: 'cache_write_5m', cacheWrite1h: 'cache_write_1h', total: 'token_total',
}
const promptColumns = ['prompt_user', 'prompt_watcher', 'prompt_wake_up', 'prompt_total', 'prompt_steered'] as const
const bucketKey = ['provider', 'thread_id', 'model_id', 'source', 'client', 'sub_agent', 'bucket'] as const
/** History cursors name a file by a digest the reader chose, never by its path. */
const cursorKeySchema = z.string().min(1).max(256).regex(/^[^\s\p{Cc}/\\]+$/u)

/**
 * The UTC 15-minute bucket an instant falls in, as `YYYY-MM-DDTHH:MM`, or '' for an undated row. Plain SQL, so the
 * triggers that use it run on any connection, including one without this store's functions.
 */
function bucketSql(instant: string): string {
  const minute = `substr(${instant},15,2)`
  return `CASE WHEN ${instant} IS NULL THEN '' ELSE substr(${instant},1,14) || CASE WHEN ${minute}<'15' THEN '00'
    WHEN ${minute}<'30' THEN '15' WHEN ${minute}<'45' THEN '30' ELSE '45' END END`
}
function bucketValues(row: 'NEW' | 'OLD'): string[] {
  return [
    `${row}.provider`, `${row}.thread_id`, `${row}.model_id`, `${row}.source`, `${row}.client`, `${row}.sub_agent`, bucketSql(`${row}.at`),
    '1', `${row}.partial`,
    ...columns.flatMap(column => [`COALESCE(${row}.${column},0)`, `(${row}.${column} IS NOT NULL)`]),
    `COALESCE(${row}.input+${row}.output,0)`, `(${row}.input IS NOT NULL AND ${row}.output IS NOT NULL)`,
  ]
}
const bucketCounters = ['records', 'partial_records', ...valueColumns.flatMap(column => [`${column}_value`, `${column}_known`])]
function addBucketSql(): string {
  return `INSERT INTO token_buckets (${[...bucketKey, ...bucketCounters].join(',')}) VALUES (${bucketValues('NEW').join(',')})
    ON CONFLICT(${bucketKey.join(',')}) DO UPDATE SET ${bucketCounters.map(column => `${column}=${column}+excluded.${column}`).join(',')};`
}
function removeBucketSql(): string {
  const values = bucketValues('OLD')
  const match = bucketKey.map((column, index) => `${column}=${values[index]}`).join(' AND ')
  return `UPDATE token_buckets SET ${bucketCounters.map((column, index) => `${column}=${column}-${values[bucketKey.length + index]}`).join(',')} WHERE ${match};
    DELETE FROM token_buckets WHERE ${match} AND records=0;`
}
/** Keeps `token_buckets` an exact mirror of `token_rows` through every write path, Grok repairs and Clear included. */
function triggerSql(): string {
  return `
    CREATE TRIGGER IF NOT EXISTS token_rows_bucket_insert AFTER INSERT ON token_rows BEGIN ${addBucketSql()} END;
    CREATE TRIGGER IF NOT EXISTS token_rows_bucket_delete AFTER DELETE ON token_rows BEGIN ${removeBucketSql()} END;
    CREATE TRIGGER IF NOT EXISTS token_rows_bucket_update AFTER UPDATE ON token_rows BEGIN ${removeBucketSql()} ${addBucketSql()} END;`
}
const dropTriggersSql = 'DROP TRIGGER IF EXISTS token_rows_bucket_insert; DROP TRIGGER IF EXISTS token_rows_bucket_delete; DROP TRIGGER IF EXISTS token_rows_bucket_update;'

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
function bounded<T>(items: readonly T[], what: string): void {
  if (items.length > USAGE_HISTORY_BATCH_MAX) throw new RangeError(`${what} exceed one history batch`)
}
function combined(statuses: readonly WriteStatus[]): WriteStatus {
  return statuses.includes('written') ? 'written' : statuses.length === 0 || statuses.includes('unchanged') ? 'unchanged' : 'suppressed'
}

/** One stretch of a time zone's calendar with a single UTC offset, in minutes, from `start` onward. */
interface ZoneSegment { start: number; offset: number }

/** Host-owned numeric history. It has no dependency on transcript retention or native ledgers. */
export class UsageStore {
  private db: DatabaseSync | undefined
  private readonly formatters = new Map<string, Intl.DateTimeFormat>()
  private readonly offsets = new Map<string, number>()
  private readonly models = new Map<string, string>()
  private readonly statements = new Map<string, StatementSync>()
  private queryCache: { key: string; revision: number; result: UsageLocalRead } | undefined

  constructor(private readonly path: string, private readonly now: () => string = () => new Date().toISOString()) {}

  open(): void {
    if (this.db !== undefined) return
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true })
    const db = new DatabaseSync(this.path, { timeout: 5_000 })
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY;')
      db.exec('BEGIN IMMEDIATE')
      try {
        this.migrate(db)
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      db.exec(`
        CREATE TEMP TABLE IF NOT EXISTS usage_prompt_items (
          provider TEXT, model TEXT, thread_id TEXT, source TEXT, client TEXT, day TEXT, weekday INTEGER, hour INTEGER, kind TEXT, input_kind TEXT
        );
        CREATE TEMP TABLE IF NOT EXISTS usage_activity (
          provider TEXT, model TEXT, thread_id TEXT, source TEXT, client TEXT, sub_agent INTEGER, day TEXT,
          token_records INTEGER, partial_records INTEGER, ${valueColumns.map(column => `${column}_value INTEGER, ${column}_known INTEGER`).join(',')},
          ${promptColumns.map(column => `${column} INTEGER`).join(',')}
        );
      `)
      db.function('usage_model', { deterministic: true }, (provider, modelId) => this.model(provider, modelId))
      this.db = db
    } catch (error) { db.close(); throw error }
  }

  close(): void {
    if (this.db === undefined) return
    this.statements.clear()
    this.db.close()
    this.db = undefined
    this.formatters.clear()
    this.offsets.clear()
    this.models.clear()
    this.queryCache = undefined
  }

  metadata(): UsageMetadata {
    const row = this.statement('SELECT * FROM usage_meta WHERE singleton=1').get()
    if (row === undefined) throw new Error('Usage metadata is unavailable')
    const history = this.statement('SELECT * FROM usage_history WHERE singleton=1').get()
    return usageMetadataSchema.parse({
      startedAt: row.started_at, revision: row.revision, generation: row.generation,
      ...(row.cleared_at === null ? {} : { clearedAt: row.cleared_at }), legacySeedCompleted: row.seed_completed === 1,
      ...(history === undefined ? {} : { history: {
        status: history.status,
        ...(history.earliest_at === null ? {} : { earliestAt: history.earliest_at }),
        ...(history.scanned_at === null ? {} : { scannedAt: history.scanned_at }),
      } }),
    })
  }

  observeTokens(input: UsageTokenObservation): UsageWriteResult {
    const observation = usageTokenObservationSchema.parse(input)
    return this.transaction(() => {
      const metadata = this.metadata()
      return this.result(metadata.revision, [this.writeToken(observation, metadata.clearedAt)])
    })
  }

  /** One transaction and at most one revision for a whole history batch. Later rows see earlier rows of the same batch. */
  observeTokenBatch(inputs: readonly UsageTokenObservation[]): UsageWriteResult {
    bounded(inputs, 'Token observations')
    const observations = inputs.map(input => usageTokenObservationSchema.parse(input))
    return this.transaction(() => {
      const metadata = this.metadata()
      return this.result(metadata.revision, observations.map(observation => this.writeToken(observation, metadata.clearedAt)))
    })
  }

  /** Retain the original selection and origin after durable intent, before executing the native send. */
  submitPrompt(input: UsagePromptSubmission): UsageWriteResult {
    const observation = usagePromptSubmissionSchema.parse(input)
    return this.transaction(() => {
      const metadata = this.metadata()
      if (this.excluded(exclusion('prompt', observation.threadId, observation.messageId))) return { status: 'suppressed', revision: metadata.revision }
      const previous = this.statement('SELECT 1 FROM prompt_rows WHERE thread_id=? AND message_id=?').get(observation.threadId, observation.messageId)
      if (previous !== undefined) return { status: 'unchanged', revision: metadata.revision }
      const pending = this.statement('SELECT 1 FROM pending_prompt_rows WHERE thread_id=? AND message_id=?').get(observation.threadId, observation.messageId)
      if (pending !== undefined) return { status: 'unchanged', revision: metadata.revision }
      const at = canonicalDate(observation.at)
      if (metadata.clearedAt !== undefined && at <= metadata.clearedAt) return { status: 'suppressed', revision: metadata.revision }
      this.statement('INSERT INTO pending_prompt_rows (thread_id,message_id,provider,model_id,at,kind,input_kind) VALUES (?,?,?,?,?,?,?)')
        .run(observation.threadId, observation.messageId, observation.providerId, observation.modelId, at, observation.kind, observation.inputKind)
      return { status: 'written', revision: this.bumpRevision(metadata.revision) }
    })
  }

  /** Only an exact user-message echo may call this. Missing intent cannot reconstruct selection or origin. */
  acceptSubmittedPrompt(threadId: string, messageId: string): UsagePromptAcceptanceResult {
    usagePromptIdentitySchema.parse({ threadId, messageId })
    return this.transaction(() => {
      const metadata = this.metadata()
      if (this.excluded(exclusion('prompt', threadId, messageId))) return { status: 'suppressed', revision: metadata.revision }
      if (this.statement('SELECT 1 FROM prompt_rows WHERE thread_id=? AND message_id=?').get(threadId, messageId) !== undefined) {
        return { status: 'unchanged', revision: metadata.revision }
      }
      if (!this.promotePending(threadId, messageId)) return { status: 'missing', revision: metadata.revision }
      return { status: 'written', revision: this.bumpRevision(metadata.revision) }
    })
  }

  /**
   * Prompts read from a provider's own records or Sotto's thread store. The record proves the provider received each,
   * so none waits for an echo. Inserting is idempotent by Sotto identity; exclusions and Clear still hold.
   */
  importPrompts(inputs: readonly UsageHistoryPrompt[]): UsageWriteResult {
    bounded(inputs, 'History prompts')
    const prompts = inputs.map(input => usageHistoryPromptSchema.parse(input))
    return this.transaction(() => {
      const metadata = this.metadata()
      return this.result(metadata.revision, prompts.map((prompt): WriteStatus => {
        if (this.excluded(exclusion('prompt', prompt.threadId, prompt.messageId))) return 'suppressed'
        if (this.statement('SELECT 1 FROM prompt_rows WHERE thread_id=? AND message_id=?').get(prompt.threadId, prompt.messageId) !== undefined) return 'unchanged'
        // A recorded message is the same evidence an echo is; its saved intent keeps the original selection and origin.
        if (this.promotePending(prompt.threadId, prompt.messageId)) return 'written'
        const at = canonicalDate(prompt.at)
        if (metadata.clearedAt !== undefined && at <= metadata.clearedAt) return 'suppressed'
        this.statement(`INSERT INTO prompt_rows (thread_id,message_id,provider,model_id,at,day,kind,input_kind,source,client)
          VALUES (?,?,?,?,?,?,?,'send',?,?)`)
          .run(prompt.threadId, prompt.messageId, prompt.providerId, prompt.modelId, at, at.slice(0, 10), prompt.kind, prompt.source, prompt.client)
        return 'written'
      }))
    })
  }

  /** Where the importer stopped in one provider file. Cursors are not usage figures: they bump no revision and survive Clear. */
  historyCursor(key: string): UsageHistoryCursor | undefined {
    const row = this.statement('SELECT * FROM history_cursors WHERE key=?').get(cursorKeySchema.parse(key))
    if (row === undefined) return undefined
    return usageHistoryCursorSchema.parse({ size: row.size, mtimeMs: row.mtime_ms, offset: row.offset, ...(row.state === null ? {} : { state: row.state }) })
  }

  setHistoryCursors(entries: readonly { key: string; cursor: UsageHistoryCursor }[]): void {
    bounded(entries, 'History cursors')
    const parsed = entries.map(entry => ({ key: cursorKeySchema.parse(entry.key), cursor: usageHistoryCursorSchema.parse(entry.cursor) }))
    this.transaction(() => {
      const upsert = this.statement(`INSERT INTO history_cursors (key,size,mtime_ms,offset,state) VALUES (?,?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET size=excluded.size,mtime_ms=excluded.mtime_ms,offset=excluded.offset,state=excluded.state`)
      for (const { key, cursor } of parsed) upsert.run(key, cursor.size, cursor.mtimeMs, cursor.offset, cursor.state ?? null)
    })
  }

  /** Surfaces in `metadata().history`. A status is not a usage figure, so it bumps no revision. */
  setHistoryStatus(input: UsageHistoryStatus): void {
    const status = usageHistoryStatusSchema.parse(input)
    this.transaction(() => {
      this.statement(`INSERT INTO usage_history (singleton,status,earliest_at,scanned_at) VALUES (1,?,?,?)
        ON CONFLICT(singleton) DO UPDATE SET status=excluded.status,earliest_at=excluded.earliest_at,scanned_at=excluded.scanned_at`)
        .run(status.status, status.earliestAt === undefined ? null : canonicalDate(status.earliestAt),
          status.scannedAt === undefined ? null : canonicalDate(status.scannedAt))
    })
  }

  /** A definitive refusal can drop pending metadata. Uncertain native results must leave it intact. */
  discardSubmittedPrompt(threadId: string, messageId: string): UsageWriteResult {
    usagePromptIdentitySchema.parse({ threadId, messageId })
    return this.transaction(() => {
      const metadata = this.metadata()
      const pending = this.statement('SELECT 1 FROM pending_prompt_rows WHERE thread_id=? AND message_id=?').get(threadId, messageId)
      if (pending === undefined) return { status: 'unchanged', revision: metadata.revision }
      this.statement('DELETE FROM pending_prompt_rows WHERE thread_id=? AND message_id=?').run(threadId, messageId)
      return { status: 'written', revision: this.bumpRevision(metadata.revision) }
    })
  }

  /** Internal reconciliation visitor; callers never receive prompt contents or an unbounded archive array. */
  visitPendingPromptIdentities(visitor: (identity: UsagePromptIdentity) => void): void {
    for (const row of this.requireOpen().prepare('SELECT thread_id,message_id FROM pending_prompt_rows ORDER BY thread_id,message_id').iterate()) {
      visitor(usagePromptIdentitySchema.parse({ threadId: row.thread_id, messageId: row.message_id }))
    }
  }

  /** Freeze a recovery pass before reading bounded numeric identity batches. New intents wait for their exact echo. */
  pendingPromptReconciliationEnd(): UsagePromptIdentity | undefined {
    const row = this.statement('SELECT thread_id,message_id FROM pending_prompt_rows ORDER BY thread_id DESC,message_id DESC LIMIT 1').get()
    return row === undefined ? undefined : usagePromptIdentitySchema.parse({ threadId: row.thread_id, messageId: row.message_id })
  }

  pendingPromptIdentities(after: UsagePromptIdentity | undefined, through: UsagePromptIdentity): UsagePromptIdentity[] {
    usagePromptIdentitySchema.parse(through)
    if (after !== undefined) usagePromptIdentitySchema.parse(after)
    return this.statement(`SELECT thread_id,message_id FROM pending_prompt_rows
      WHERE (thread_id,message_id)<=(?,?) ${after === undefined ? '' : 'AND (thread_id,message_id)>(?,?)'}
      ORDER BY thread_id,message_id LIMIT ?`)
      .all(through.threadId, through.messageId, ...(after === undefined ? [] : [after.threadId, after.messageId]), USAGE_PENDING_RECONCILIATION_BATCH_MAX)
      .map(row => usagePromptIdentitySchema.parse({ threadId: row.thread_id, messageId: row.message_id }))
  }

  markLegacySeedCompleted(): UsageWriteResult {
    return this.transaction(() => {
      const metadata = this.metadata()
      if (metadata.legacySeedCompleted) return { status: 'unchanged', revision: metadata.revision }
      this.statement('UPDATE usage_meta SET seed_completed=1 WHERE singleton=1').run()
      return { status: 'written', revision: this.bumpRevision(metadata.revision) }
    })
  }

  clear(expectedRevision: number): UsageLocalClearResult {
    usageLocalClearRequestSchema.parse({ expectedRevision })
    return this.transaction(db => {
      const metadata = this.metadata()
      if (metadata.revision !== expectedRevision) return { status: 'stale', metadata }
      const addExclusion = this.statement('INSERT OR IGNORE INTO exclusions VALUES (?)')
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
      // Emptying both tables whole is exact and avoids one trigger per row; history cursors and status stay.
      db.exec(`${dropTriggersSql} DELETE FROM token_rows; DELETE FROM token_buckets; ${triggerSql()}
        DELETE FROM grok_conflict_floors; DELETE FROM prompt_rows; DELETE FROM pending_prompt_rows;`)
      this.statement('UPDATE usage_meta SET revision=?,generation=?,cleared_at=? WHERE singleton=1').run(next.revision, next.generation, next.clearedAt!)
      return { status: 'cleared', metadata: next }
    })
  }

  query(input: UsageLocalQuery = {}): UsageLocalRead {
    const query = usageLocalQuerySchema.parse(input)
    const timeZone = query.timeZone ?? 'UTC'
    const db = this.requireOpen()
    const metadata = this.metadata()
    const key = JSON.stringify(query)
    // History status changes without a revision, so a reused read still reports the current one.
    if (this.queryCache?.key === key && this.queryCache.revision === metadata.revision) return { ...structuredClone(this.queryCache.result), metadata }
    db.exec('BEGIN')
    try {
      const result = this.read(db, query, timeZone, metadata)
      db.exec('COMMIT')
      // Readers may own and mutate their response. Never expose the retained numeric cache.
      this.queryCache = { key, revision: metadata.revision, result: structuredClone(result) }
      return result
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }

  /**
   * Materialises the filtered activity once, then answers every aggregate from it. Token figures come from the
   * 15-minute buckets the triggers keep, so a query reads buckets rather than every request; prompts are few and
   * read whole, each attributed to the model that served it.
   */
  private read(db: DatabaseSync, query: UsageLocalQuery, timeZone: string, metadata: UsageMetadata): UsageLocalRead {
    const since = query.since === undefined ? undefined : canonicalDate(query.since)
    const zone = this.calendar(timeZone, this.range(query, since))
    this.statement('DELETE FROM usage_prompt_items').run()
    this.statement('DELETE FROM usage_activity').run()

    const shared = sharedFilters(query)
    const local = localDayFilter(query, 'local_day')
    const models = query.modelIds === undefined ? undefined : query.modelIds.length === 0 ? '0' : `model IN (${query.modelIds.map(() => '?').join(',')})`
    const modelParameters = query.modelIds ?? []

    // Prompts: the served model is the first main-chain token row in the same thread at or after the prompt and
    // before that thread's next prompt; failing that, the selection. Undated rows never serve.
    const prompts = utcDayFilter(query, 'p.day')
    const promptWhere = [...shared.sql('p.'), ...prompts.sql, ...(since === undefined ? [] : ['p.at>=?'])]
    db.prepare(`INSERT INTO usage_prompt_items
      SELECT provider,model,thread_id,source,client,local_day,weekday,hour,kind,input_kind FROM (
        SELECT p.provider,usage_model(p.provider,COALESCE((SELECT t.model_id FROM token_rows t
            WHERE t.provider=p.provider AND t.thread_id=p.thread_id AND t.sub_agent=0 AND t.at>=p.at AND (p.next_at IS NULL OR t.at<p.next_at)
            ORDER BY t.at LIMIT 1),p.model_id)) AS model,
          p.thread_id,p.source,p.client,${zone.day('p.at', 'instant')} AS local_day,
          (CAST(strftime('%w',p.at,${zone.modifier('p.at', 'instant')}) AS INTEGER)+6)%7 AS weekday,
          CAST(strftime('%H',p.at,${zone.modifier('p.at', 'instant')}) AS INTEGER) AS hour,p.kind,p.input_kind
        FROM (SELECT *,LEAD(at) OVER (PARTITION BY provider,thread_id ORDER BY at,message_id) AS next_at FROM prompt_rows) p
        ${where(promptWhere)}
      ) ${where([...local.sql, ...(models === undefined ? [] : [models])])}`)
      .run(...shared.parameters, ...prompts.parameters, ...(since === undefined ? [] : [since]), ...local.parameters, ...modelParameters)

    // Tokens: whole buckets, plus the exact rows of the one bucket a `since` instant splits.
    const sinceBucket = since === undefined ? undefined : bucketOf(since)
    const splitsBucket = since !== undefined && Date.parse(since) % BUCKET !== 0
    const buckets = utcDayFilter(query, 'bucket')
    const bucketWhere = [...shared.sql(''), ...buckets.sql, ...(since === undefined ? [] : [splitsBucket ? 'bucket>?' : 'bucket>=?'])]
    const fromBuckets = `SELECT provider,model_id,thread_id,source,client,sub_agent,${zone.day('bucket', 'bucket')} AS local_day,
        TOTAL(records) AS token_records,TOTAL(partial_records) AS partial_records,
        ${valueColumns.map(column => `TOTAL(${column}_value) AS ${column}_value,TOTAL(${column}_known) AS ${column}_known`).join(',')}
      FROM token_buckets ${where(bucketWhere)} GROUP BY 1,2,3,4,5,6,7`
    const fromRows = !splitsBucket ? '' : `UNION ALL SELECT provider,model_id,thread_id,source,client,sub_agent,${zone.day('at', 'instant')} AS local_day,
        COUNT(*),TOTAL(partial),${columns.map(column => `TOTAL(${column}),COUNT(${column})`).join(',')},
        TOTAL(CASE WHEN input IS NOT NULL AND output IS NOT NULL THEN input+output END),COUNT(CASE WHEN input IS NOT NULL AND output IS NOT NULL THEN 1 END)
      FROM token_rows ${where([...shared.sql(''), 'token_rows.day=?', 'at>=?', 'at<?'])} GROUP BY 1,2,3,4,5,6,7`
    const tokenParameters: SQLInputValue[] = [...shared.parameters, ...buckets.parameters, ...(sinceBucket === undefined ? [] : [sinceBucket])]
    const splitParameters: SQLInputValue[] = !splitsBucket ? [] : [...shared.parameters, since.slice(0, 10), since, new Date(Date.parse(`${sinceBucket}Z`) + BUCKET).toISOString()]
    db.prepare(`INSERT INTO usage_activity (provider,model,thread_id,source,client,sub_agent,day,token_records,partial_records,
        ${valueColumns.map(column => `${column}_value,${column}_known`).join(',')},${promptColumns.join(',')})
      SELECT provider,model,thread_id,source,client,sub_agent,local_day,token_records,partial_records,
        ${valueColumns.map(column => `${column}_value,${column}_known`).join(',')},${promptColumns.map(() => '0').join(',')}
      FROM (SELECT *,usage_model(provider,model_id) AS model FROM (${fromBuckets} ${fromRows}))
      ${where([...local.sql, ...(models === undefined ? [] : [models])])}`)
      .run(...tokenParameters, ...splitParameters, ...local.parameters, ...modelParameters)
    this.statement(`INSERT INTO usage_activity (provider,model,thread_id,source,client,sub_agent,day,token_records,partial_records,
        ${valueColumns.map(column => `${column}_value,${column}_known`).join(',')},${promptColumns.join(',')})
      SELECT provider,model,thread_id,source,client,0,day,0,0,${valueColumns.map(() => '0,0').join(',')},
        TOTAL(kind='user'),TOTAL(kind='watcher'),TOTAL(kind='wake-up'),COUNT(*),TOTAL(input_kind='steer')
      FROM usage_prompt_items GROUP BY provider,model,thread_id,source,client,day`).run()

    const totalRow = this.statement(`SELECT ${aggregateSql()} FROM usage_activity`).get()
    if (totalRow === undefined) throw new Error('Usage totals are unavailable')
    const providers = this.statement(`SELECT provider,${aggregateSql()} FROM usage_activity GROUP BY provider ORDER BY provider`).all()
      .map(row => ({ ...aggregate(row), providerId: usageProviderIdSchema.parse(row.provider) }))
    const modelRows = this.statement(`SELECT provider,model,${aggregateSql()} FROM usage_activity GROUP BY provider,model
      ORDER BY (input_value+output_value) DESC,prompt_total DESC,provider,model LIMIT ?`).all(USAGE_MODEL_ROWS_MAX)
    const modelCount = safeCount(this.statement('SELECT COUNT(*) AS count FROM (SELECT 1 FROM usage_activity GROUP BY provider,model)').get()?.count)
    const firstDay = typeof totalRow.first_day === 'string' ? totalRow.first_day : undefined
    const from = query.from ?? firstDay
    const to = query.to ?? (typeof totalRow.last_day === 'string' ? totalRow.last_day : undefined)
    const span = from === undefined || to === undefined ? 0 : (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY + 1
    const dailyCoverage = query.includeDaily === false ? 'not-requested' : span > USAGE_DAILY_BUCKETS_MAX ? 'omitted-range' : 'complete'
    const daily = dailyCoverage !== 'complete' ? [] : this.statement(`SELECT day,${aggregateSql()} FROM usage_activity
      WHERE day IS NOT NULL GROUP BY day ORDER BY day LIMIT ?`).all(USAGE_DAILY_BUCKETS_MAX)
      .map(row => ({ ...aggregate(row), day: String(row.day) }))
    const hourly = this.statement(`SELECT weekday,hour,TOTAL(kind='user') AS prompt_user,TOTAL(kind='watcher') AS prompt_watcher,
        TOTAL(kind='wake-up') AS prompt_wake_up,COUNT(*) AS prompt_total,TOTAL(input_kind='steer') AS prompt_steered
      FROM usage_prompt_items GROUP BY weekday,hour ORDER BY weekday,hour LIMIT ?`).all(USAGE_HOURLY_CELLS_MAX)
      .map(row => ({ weekday: safeCount(row.weekday), hour: safeCount(row.hour), prompts: promptTotals(row) }))
    const clients = this.statement(`SELECT source,client,sub_agent,${aggregateSql()} FROM usage_activity
      GROUP BY source,client,sub_agent ORDER BY source DESC,client,sub_agent LIMIT ?`).all(USAGE_CLIENT_ROWS_MAX)
      .map((row): UsageClientAggregate => ({ ...aggregate(row), source: usageSourceSchema.parse(row.source),
        clientId: usageClientSchema.parse(row.client), subAgent: row.sub_agent === 1 }))
    return {
      metadata, totals: aggregate(totalRow), providers, timeZone,
      models: modelRows.map(row => ({ ...aggregate(row), providerId: usageProviderIdSchema.parse(row.provider), modelId: String(row.model) })),
      modelCount, modelsTruncated: modelCount > USAGE_MODEL_ROWS_MAX, daily, dailyCoverage, hourly, clients,
    }
  }

  /** The UTC instants any row the query can reach lies between, so a calendar is built for that span alone. */
  private range(query: UsageLocalQuery, since: string | undefined): { lo: number; hi: number } {
    const days = [
      this.statement("SELECT substr(bucket,1,10) AS day FROM token_buckets WHERE bucket>'' ORDER BY bucket LIMIT 1").get()?.day,
      this.statement("SELECT substr(bucket,1,10) AS day FROM token_buckets WHERE bucket>'' ORDER BY bucket DESC LIMIT 1").get()?.day,
      this.statement('SELECT MIN(day) AS day FROM prompt_rows').get()?.day,
      this.statement('SELECT MAX(day) AS day FROM prompt_rows').get()?.day,
    ].filter((day): day is string => typeof day === 'string').map(day => Date.parse(`${day}T00:00:00Z`))
    if (days.length === 0) { const now = Date.parse(canonicalDate(this.now())); return { lo: now, hi: now } }
    let lo = Math.min(...days)
    let hi = Math.max(...days) + DAY
    // The UTC prefilter keeps one adjacent day on either side of a calendar range.
    if (query.from !== undefined) lo = Math.max(lo, Date.parse(`${query.from}T00:00:00Z`) - DAY)
    if (query.to !== undefined) hi = Math.min(hi, Date.parse(`${query.to}T00:00:00Z`) + 2 * DAY)
    if (since !== undefined) lo = Math.max(lo, Date.parse(since))
    return hi < lo ? { lo, hi: lo } : { lo, hi }
  }

  /**
   * SQL for a named zone's calendar over one span: the zone's UTC offsets there, found with one Intl call per
   * six-hour sample and a short search per transition, then plain date arithmetic per row. DST stays exact.
   */
  private calendar(timeZone: string, span: { lo: number; hi: number }) {
    const segments = timeZone === 'UTC' ? [{ start: -Infinity, offset: 0 }] : this.segments(timeZone, span.lo, span.hi)
    const modifier = (column: string, precision: 'bucket' | 'instant'): string => {
      const text = (segment: ZoneSegment): string => `'${segment.offset >= 0 ? '+' : ''}${segment.offset} minutes'`
      if (segments.length === 1) return text(segments[0]!)
      const branches = segments.slice(1).map((segment, index) => {
        const iso = new Date(segment.start).toISOString()
        return `WHEN ${column}<'${precision === 'bucket' ? iso.slice(0, 16) : iso}' THEN ${text(segments[index]!)}`
      })
      return `CASE ${branches.join(' ')} ELSE ${text(segments.at(-1)!)} END`
    }
    const day = (column: string, precision: 'bucket' | 'instant'): string => segments.length === 1 && segments[0]!.offset === 0
      ? `NULLIF(substr(${column},1,10),'')`
      : `date(NULLIF(${column},''),${modifier(column, precision)})`
    return { day, modifier }
  }

  private segments(timeZone: string, lo: number, hi: number): ZoneSegment[] {
    let sample = Math.floor(lo / SAMPLE) * SAMPLE
    const segments: ZoneSegment[] = [{ start: -Infinity, offset: this.offsetAt(timeZone, sample) }]
    for (; sample < hi; sample += SAMPLE) {
      const before = segments.at(-1)!.offset
      const after = this.offsetAt(timeZone, sample + SAMPLE)
      if (after === before) continue
      let low = sample / BUCKET
      let high = (sample + SAMPLE) / BUCKET
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2)
        if (this.offsetAt(timeZone, middle * BUCKET) === before) low = middle
        else high = middle
      }
      segments.push({ start: high * BUCKET, offset: this.offsetAt(timeZone, high * BUCKET) })
    }
    return segments
  }

  private offsetAt(timeZone: string, instant: number): number {
    const key = `${timeZone}\0${instant}`
    const cached = this.offsets.get(key)
    if (cached !== undefined) return cached
    let formatter = this.formatters.get(timeZone)
    if (formatter === undefined) {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone, calendar: 'iso8601', numberingSystem: 'latn', hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      })
      this.formatters.set(timeZone, formatter)
    }
    const parts = formatter.formatToParts(new Date(instant))
    const part = (type: Intl.DateTimeFormatPartTypes): number => {
      const value = Number(parts.find(value => value.type === type)?.value)
      if (!Number.isInteger(value)) throw new Error('Usage calendar component is unavailable')
      return value
    }
    const wall = new Date(0)
    wall.setUTCFullYear(part('year'), part('month') - 1, part('day'))
    wall.setUTCHours(part('hour'), part('minute'), 0, 0)
    const offset = Math.round((wall.getTime() - Math.floor(instant / MINUTE) * MINUTE) / MINUTE)
    cacheBounded(this.offsets, key, offset, ZONE_OFFSETS_MAX)
    return offset
  }

  private model(provider: SQLOutputValue, modelId: SQLOutputValue): string {
    if (typeof provider !== 'string' || typeof modelId !== 'string') throw new Error('Usage model input is invalid')
    const key = `${provider}\0${modelId}`
    const cached = this.models.get(key)
    if (cached !== undefined) return cached
    const canonical = canonicalModelId(provider, modelId)
    cacheBounded(this.models, key, canonical, MODEL_IDS_MAX)
    return canonical
  }

  /** The write rules for one token observation, without the revision: callers bump it once for a whole batch. */
  private writeToken(observation: UsageTokenObservation, clearedAt: string | undefined): WriteStatus {
    const identity = [observation.providerId, observation.threadId, observation.recordKey]
    const rowHash = exclusion('row', ...identity)
    const groupHash = observation.groupKey === undefined ? undefined : exclusion('group', observation.providerId, observation.threadId, observation.groupKey)
    if (groupHash !== undefined && this.excluded(groupHash)) return 'suppressed'
    const rowExcluded = this.excluded(rowHash)
    if (observation.removed === true) {
      const removed = this.statement('DELETE FROM token_rows WHERE provider=? AND thread_id=? AND record_key=?').run(...identity).changes > 0
      const floorRemoved = observation.providerId === 'grok' && this.statement('DELETE FROM grok_conflict_floors WHERE thread_id=? AND record_key=?')
        .run(observation.threadId, observation.recordKey).changes > 0
      // Retirement is permanent, but later full reports must still reconcile this group's
      // membership after a restart whose legacy cost ledger knows only its aggregate.
      const reconciled = observation.phase !== 'seed' && observation.groupRecordsHash !== undefined
        && this.reconcileGrokMembers(observation)
      if (rowExcluded && !removed && !floorRemoved && !reconciled) return 'suppressed'
      this.statement('INSERT OR IGNORE INTO exclusions VALUES (?)').run(rowHash)
      return 'written'
    }
    if (rowExcluded) {
      if (observation.phase !== 'seed' && unknownGrok(observation)) {
        const result = this.markGrokAmbiguous(observation)
        if (result !== undefined) return result
      }
      return 'suppressed'
    }
    const history = observation.origin === 'history'
    const previous = this.statement('SELECT * FROM token_rows WHERE provider=? AND thread_id=? AND record_key=?').get(...identity)
    // The old accounting file is a one-time import, not newer native evidence. In particular,
    // Grok's aggregate cost row must not overwrite an exact model row after a restart. Imported
    // history is a provider's own dated record, so it is read as a replay whatever its phase.
    if (observation.phase === 'seed' && !history && previous !== undefined) return 'unchanged'
    if (unknownGrok(observation)
      && previous !== undefined && previous.model_id !== observation.modelId) {
      return this.markGrokAmbiguous(observation) ?? 'unchanged'
    }
    if (clearedAt !== undefined && previous === undefined) {
      if (history) {
        // Old records still on disk after Clear stay out; only work recorded after it counts.
        if (canonicalDate(observation.at!) <= clearedAt) return 'suppressed'
      } else {
        const admittedGroup = observation.groupKey !== undefined && this.statement('SELECT 1 FROM token_rows WHERE provider=? AND thread_id=? AND group_key=? LIMIT 1')
          .get(observation.providerId, observation.threadId, observation.groupKey) !== undefined
        const provedStart = observation.groupStartedAt !== undefined && canonicalDate(observation.groupStartedAt) > clearedAt
        if (!admittedGroup && !provedStart && observation.liveNewGroup !== true) return 'suppressed'
      }
    }
    const regresses = observation.providerId === 'grok' && previous !== undefined && fields.some((field, index) =>
      typeof previous[columns[index]!] === 'number' && observation.tokens[field] !== undefined
      && observation.tokens[field]! < (previous[columns[index]!] as number))
    const floor = observation.providerId === 'grok' ? this.statement('SELECT * FROM grok_conflict_floors WHERE thread_id=? AND record_key=?')
      .get(observation.threadId, observation.recordKey) : undefined
    const belowFloor = floor !== undefined && fields.some((field, index) => typeof floor[columns[index]!] === 'number'
      && (observation.tokens[field] === undefined || observation.tokens[field]! < (floor[columns[index]!] as number)))
    if (regresses) this.invalidateGrokGroup(observation)
    const uncertain = regresses || belowFloor
    // A duplicate lower replay cannot certify the same contradiction after unknown vectors
    // replace it. Only a complete vector meeting its durable numeric floor repairs the row.
    const floorRepaired = !uncertain && floor !== undefined && this.statement('DELETE FROM grok_conflict_floors WHERE thread_id=? AND record_key=?')
      .run(observation.threadId, observation.recordKey).changes > 0
    const at = earliest(previous?.at, observation.at ?? observation.groupStartedAt)
    const groupStartedAt = earliest(previous?.group_started_at, observation.groupStartedAt)
    // An observation that does not say where its work ran keeps what an earlier one said.
    const source = observation.source ?? (typeof previous?.source === 'string' ? previous.source : 'sotto')
    const client = observation.source === undefined && typeof previous?.client === 'string' ? previous.client : observation.client ?? 'sotto'
    const subAgent = observation.subAgent === undefined ? (previous?.sub_agent === 1 ? 1 : 0) : observation.subAgent ? 1 : 0
    // Replays may learn an older genuine date; observation time never fills an undated row.
    const values: SQLInputValue[] = [
      observation.groupKey ?? (typeof previous?.group_key === 'string' ? previous.group_key : null),
      observation.modelId, at, groupStartedAt, at?.slice(0, 10) ?? null, observation.partial || uncertain ? 1 : 0,
      ...fields.map(field => uncertain ? null : observation.tokens[field] ?? null),
      source, client, subAgent,
    ]
    const storedColumns = ['group_key', 'model_id', 'at', 'group_started_at', 'day', 'partial', ...columns, 'source', 'client', 'sub_agent']
    if (previous !== undefined && storedColumns.every((column, index) => previous[column] === values[index])) {
      return floorRepaired ? 'written' : 'unchanged'
    }
    this.statement(`INSERT INTO token_rows (provider,thread_id,record_key,${storedColumns.join(',')})
      VALUES (${[...identity, ...values].map(() => '?').join(',')})
      ON CONFLICT(provider,thread_id,record_key) DO UPDATE SET ${storedColumns.map(column => `${column}=excluded.${column}`).join(',')}`)
      .run(...identity, ...values)
    return 'written'
  }

  /** Moves a pending intent into the counted prompts under its original selection and origin. */
  private promotePending(threadId: string, messageId: string): boolean {
    const pending = this.statement('SELECT * FROM pending_prompt_rows WHERE thread_id=? AND message_id=?').get(threadId, messageId)
    if (pending === undefined) return false
    const observation = usagePromptSubmissionSchema.parse({
      providerId: pending.provider, threadId, messageId, modelId: pending.model_id, at: pending.at,
      kind: pending.kind, inputKind: pending.input_kind,
    })
    const at = canonicalDate(observation.at)
    this.statement('INSERT INTO prompt_rows (thread_id,message_id,provider,model_id,at,day,kind,input_kind) VALUES (?,?,?,?,?,?,?,?)')
      .run(observation.threadId, observation.messageId, observation.providerId, observation.modelId, at, at.slice(0, 10), observation.kind, observation.inputKind)
    this.statement('DELETE FROM pending_prompt_rows WHERE thread_id=? AND message_id=?').run(threadId, messageId)
    return true
  }

  /** Missing breakdown cannot revive a retired aggregate or silently certify its old model vectors. */
  private markGrokAmbiguous(observation: UsageTokenObservation): WriteStatus | undefined {
    const scope = observation.groupKey === undefined ? 'record_key' : 'group_key'
    const parameters = [observation.providerId, observation.threadId, observation.groupKey ?? observation.recordKey]
    const existing = this.statement(`SELECT COUNT(*) AS rows,SUM(input+output) AS total FROM token_rows
      WHERE provider=? AND thread_id=? AND ${scope}=?`).get(...parameters)!
    if (existing.rows === 0) return undefined
    const reportedTotal = observation.tokens.input !== undefined && observation.tokens.output !== undefined
      ? observation.tokens.input + observation.tokens.output : undefined
    const contradictory = reportedTotal !== undefined && typeof existing.total === 'number' && reportedTotal < existing.total
    if (contradictory) return this.invalidateGrokGroup(observation) ? 'written' : 'unchanged'
    const changed = this.statement(`UPDATE token_rows SET partial=1 WHERE provider=? AND thread_id=? AND ${scope}=?
      AND partial<>1`).run(...parameters).changes
    return changed === 0 ? 'unchanged' : 'written'
  }

  private migrate(db: DatabaseSync): void {
    db.exec(`
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
      CREATE TABLE IF NOT EXISTS grok_conflict_floors (
        thread_id TEXT NOT NULL, record_key TEXT NOT NULL,
        input INTEGER, output INTEGER, cached INTEGER, cache_write INTEGER, cache_write_5m INTEGER, cache_write_1h INTEGER,
        PRIMARY KEY(thread_id, record_key)
      );
      CREATE TABLE IF NOT EXISTS prompt_rows (
        thread_id TEXT NOT NULL, message_id TEXT NOT NULL, provider TEXT NOT NULL, model_id TEXT NOT NULL,
        at TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, input_kind TEXT NOT NULL,
        PRIMARY KEY(thread_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS pending_prompt_rows (
        thread_id TEXT NOT NULL, message_id TEXT NOT NULL, provider TEXT NOT NULL, model_id TEXT NOT NULL,
        at TEXT NOT NULL, kind TEXT NOT NULL, input_kind TEXT NOT NULL,
        PRIMARY KEY(thread_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS exclusions (identity_hash TEXT PRIMARY KEY NOT NULL);
    `)
    // Columns added after the first schema. Each has a constant default, so adding one rewrites nothing and an
    // older build that names its columns can still open the store.
    const added: Record<string, readonly string[]> = {
      token_rows: ["source TEXT NOT NULL DEFAULT 'sotto'", "client TEXT NOT NULL DEFAULT 'sotto'", 'sub_agent INTEGER NOT NULL DEFAULT 0'],
      prompt_rows: ["source TEXT NOT NULL DEFAULT 'sotto'", "client TEXT NOT NULL DEFAULT 'sotto'"],
    }
    for (const [table, definitions] of Object.entries(added)) {
      const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)))
      for (const definition of definitions) {
        if (!present.has(definition.split(' ')[0]!)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
      }
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS token_rows_date ON token_rows(day);
      -- Every client's history makes hundreds of thousands of rows (ADR-0080), so each index covers only the rows its
      -- lookups reach: grouped rows for group checks, dated main-chain rows for the served-model join. Queries read
      -- token_buckets, so no index by model is kept. An older build that reopens the store recreates its own.
      DROP INDEX IF EXISTS token_rows_model;
      DROP INDEX IF EXISTS token_rows_group;
      DROP INDEX IF EXISTS token_rows_served;
      CREATE INDEX IF NOT EXISTS token_rows_grouped ON token_rows(provider, thread_id, group_key) WHERE group_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS token_rows_served_main ON token_rows(provider, thread_id, at) WHERE sub_agent=0 AND at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS prompt_rows_date ON prompt_rows(day);
      CREATE INDEX IF NOT EXISTS prompt_rows_model ON prompt_rows(provider, model_id);
      CREATE TABLE IF NOT EXISTS usage_history (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), status TEXT NOT NULL, earliest_at TEXT, scanned_at TEXT
      );
      CREATE TABLE IF NOT EXISTS history_cursors (
        key TEXT PRIMARY KEY NOT NULL, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, offset INTEGER NOT NULL, state TEXT
      );
      CREATE TABLE IF NOT EXISTS token_buckets (
        provider TEXT NOT NULL, thread_id TEXT NOT NULL, model_id TEXT NOT NULL, source TEXT NOT NULL, client TEXT NOT NULL,
        sub_agent INTEGER NOT NULL, bucket TEXT NOT NULL, records INTEGER NOT NULL, partial_records INTEGER NOT NULL,
        ${valueColumns.map(column => `${column}_value INTEGER NOT NULL, ${column}_known INTEGER NOT NULL`).join(',')},
        PRIMARY KEY(${bucketKey.join(',')})
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS token_buckets_time ON token_buckets(bucket);
      ${triggerSql()}
    `)
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
    if (version < SCHEMA_VERSION) {
      // Rebuild the mirror from whatever rows the store already holds; from here the triggers keep it.
      const values = bucketValues('NEW').map(value => value.replaceAll('NEW.', ''))
      db.exec(`DELETE FROM token_buckets;
        INSERT INTO token_buckets (${[...bucketKey, ...bucketCounters].join(',')})
        SELECT ${values.slice(0, bucketKey.length).join(',')},${values.slice(bucketKey.length).map(value => `SUM(${value})`).join(',')}
        FROM token_rows GROUP BY ${bucketKey.map((_, index) => index + 1).join(',')};
        PRAGMA user_version=${SCHEMA_VERSION};`)
    }
    const startedAt = canonicalDate(this.now())
    usageMetadataSchema.parse({ startedAt, revision: 0, generation: 0, legacySeedCompleted: false })
    db.prepare('INSERT OR IGNORE INTO usage_meta (singleton,started_at,revision,generation,cleared_at,seed_completed) VALUES (1,?,0,0,NULL,0)').run(startedAt)
  }

  private requireOpen(): DatabaseSync {
    if (this.db === undefined) throw new Error('Usage store is closed')
    return this.db
  }
  /** Prepared once per connection: a history import runs these for every record. */
  private statement(sql: string): StatementSync {
    const cached = this.statements.get(sql)
    if (cached !== undefined) return cached
    const statement = this.requireOpen().prepare(sql)
    cacheBounded(this.statements, sql, statement, STATEMENTS_MAX)
    return statement
  }
  private excluded(identityHash: string): boolean {
    return this.statement('SELECT 1 FROM exclusions WHERE identity_hash=?').get(identityHash) !== undefined
  }
  private reconcileGrokMembers(observation: UsageTokenObservation): boolean {
    const scope = [observation.providerId, observation.threadId, observation.groupKey!]
    // Hash in SQL order without materialising an unbounded group's rows.
    const digest = createHash('sha256').update('[')
    let count = 0
    for (const row of this.requireOpen().prepare('SELECT record_key FROM token_rows WHERE provider=? AND thread_id=? AND group_key=? ORDER BY record_key').iterate(...scope)) {
      if (count++) digest.update(',')
      digest.update(JSON.stringify(row.record_key))
    }
    if (!count || digest.update(']').digest('hex') === observation.groupRecordsHash) return false
    // An absent old model is contradictory evidence, not a proved lower bound. Current
    // exact rows can repair their fields; missing members stay unknown until reported again.
    return this.invalidateGrokGroup(observation)
  }
  private invalidateGrokGroup(observation: UsageTokenObservation): boolean {
    const scope = observation.groupKey === undefined ? 'record_key' : 'group_key'
    const parameters = [observation.providerId, observation.threadId, observation.groupKey ?? observation.recordKey]
    this.statement(`INSERT INTO grok_conflict_floors (thread_id,record_key,${columns.join(',')})
      SELECT thread_id,record_key,${columns.join(',')} FROM token_rows
      WHERE provider=? AND thread_id=? AND ${scope}=? AND (${columns.map(column => `${column} IS NOT NULL`).join(' OR ')})
      ON CONFLICT(thread_id,record_key) DO UPDATE SET ${columns.map(column => `${column}=CASE
        WHEN excluded.${column} IS NULL THEN grok_conflict_floors.${column}
        WHEN grok_conflict_floors.${column} IS NULL THEN excluded.${column}
        ELSE MAX(grok_conflict_floors.${column},excluded.${column}) END`).join(',')}`).run(...parameters)
    return this.statement(`UPDATE token_rows SET ${columns.map(column => `${column}=NULL`).join(',')},partial=1
      WHERE provider=? AND thread_id=? AND ${scope}=? AND (partial=0 OR ${columns.map(column => `${column} IS NOT NULL`).join(' OR ')})`)
      .run(...parameters).changes > 0
  }
  private result(revision: number, statuses: readonly WriteStatus[]): UsageWriteResult {
    const status = combined(statuses)
    return { status, revision: status === 'written' ? this.bumpRevision(revision) : revision }
  }
  private bumpRevision(revision: number): number {
    const next = nextCount(revision)
    this.statement('UPDATE usage_meta SET revision=? WHERE singleton=1').run(next)
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

function unknownGrok(observation: UsageTokenObservation): boolean {
  return observation.providerId === 'grok' && observation.partial
    && (observation.modelId === 'unknown' || observation.modelId === 'native:grok:model:unknown')
}

function where(conditions: readonly string[]): string {
  return conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
}

/** Provider and source filters, the same on every table. */
function sharedFilters(query: UsageLocalQuery) {
  const conditions: [string, readonly string[]][] = []
  for (const [column, values] of [['provider', query.providerIds], ['source', query.sources]] as const) {
    if (values !== undefined) conditions.push([column, values])
  }
  return {
    sql: (prefix: string) => conditions.map(([column, values]) => values.length === 0 ? '0' : `${prefix}${column} IN (${values.map(() => '?').join(',')})`),
    parameters: conditions.flatMap(([, values]) => values) as SQLInputValue[],
  }
}

/**
 * UTC date bounds that discard unrelated history before any calendar arithmetic. One adjacent UTC day on either
 * side covers every named-zone offset; the exact local-day filter still decides.
 */
function utcDayFilter(query: UsageLocalQuery, column: string): { sql: string[]; parameters: SQLInputValue[] } {
  const sql: string[] = []
  const parameters: SQLInputValue[] = []
  if (query.from !== undefined) { sql.push(`${column}>=?`); parameters.push(adjacentDay(query.from, -1)) }
  // A bucket is `YYYY-MM-DDTHH:MM`, so the day after the bound is its exclusive end.
  if (query.to !== undefined) { sql.push(`${column}<?`); parameters.push(adjacentDay(adjacentDay(query.to, 1), 1)) }
  return { sql, parameters }
}

function localDayFilter(query: UsageLocalQuery, column: string): { sql: string[]; parameters: SQLInputValue[] } {
  const sql: string[] = []
  const parameters: SQLInputValue[] = []
  if (query.from !== undefined) { sql.push(`${column}>=?`); parameters.push(query.from) }
  if (query.to !== undefined) { sql.push(`${column}<=?`); parameters.push(query.to) }
  return { sql, parameters }
}

function bucketOf(instant: string): string {
  const ms = Date.parse(instant)
  return new Date(Math.floor(ms / BUCKET) * BUCKET).toISOString().slice(0, 16)
}

function adjacentDay(day: string, direction: -1 | 1): string {
  const shifted = new Date(Date.parse(`${day}T00:00:00Z`) + direction * DAY).toISOString()
  return shifted.startsWith('-') ? '0000-01-01' : shifted.startsWith('+') ? '9999-12-31' : shifted.slice(0, 10)
}

function aggregateSql(): string {
  return [
    'COUNT(DISTINCT thread_id) AS active_threads', 'COUNT(DISTINCT day) AS active_days',
    'MIN(day) AS first_day', 'MAX(day) AS last_day',
    'TOTAL(token_records) AS token_records', 'TOTAL(partial_records) AS partial_records',
    'TOTAL(CASE WHEN day IS NULL THEN token_records ELSE 0 END) AS undated_records',
    ...valueColumns.map(column => `TOTAL(${column}_value) AS ${column}_value,TOTAL(${column}_known) AS ${column}_known`),
    ...promptColumns.map(column => `TOTAL(${column}) AS ${column}`),
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
    ...(typeof row.last_day === 'string' ? { lastDay: row.last_day } : {}),
    prompts: promptTotals(row),
  }
}
