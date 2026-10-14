import { z } from 'zod'
import type { ProviderId } from './agents'
import { usageTokensSchema } from './threadUsage'

export const USAGE_READ = 'sotto:usage:read'
export const USAGE_REFRESH = 'sotto:usage:refresh'
export const USAGE_CLEAR = 'sotto:usage:clear'
export const USAGE_RENDERER_ARGUMENT = '--sotto-usage-enabled'

export const USAGE_MODEL_ROWS_MAX = 200
export const USAGE_DAILY_BUCKETS_MAX = 366
export const USAGE_HOURLY_CELLS_MAX = 168
export const USAGE_HOSTS_MAX = 100
export const USAGE_QUOTA_WINDOWS_MAX = 8
export const USAGE_CLIENT_ROWS_MAX = 64
export const USAGE_HISTORY_BATCH_MAX = 2_048

const providers = ['codex', 'claude', 'grok', 'devin'] as const satisfies readonly ProviderId[]
export const usageProviderIdSchema = z.enum(providers)
export type UsageProviderId = z.infer<typeof usageProviderIdSchema>
/** Numeric collection and native quotas are verified only for these providers. */
export function isUsageProviderId(value: unknown): value is UsageProviderId {
  return usageProviderIdSchema.safeParse(value).success
}

/** Where the work ran: a Sotto thread, or the same provider client used outside Sotto on this computer. */
export const USAGE_SOURCES = ['sotto', 'outside'] as const
export const usageSourceSchema = z.enum(USAGE_SOURCES)
export type UsageSource = z.infer<typeof usageSourceSchema>
/**
 * The app that sent the work, read from the provider's own local records (Codex's session originator,
 * Claude Code's session ownership). Sotto never guesses one from content.
 */
export const USAGE_CLIENTS = ['sotto', 'claude-code', 'codex-app', 'codex-cli', 'codex-exec', 'codex-ide', 't3-code', 'codex-in-claude-code', 'other'] as const
export const usageClientSchema = z.enum(USAGE_CLIENTS)
export type UsageClient = z.infer<typeof usageClientSchema>
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const identity = z.string().min(1).max(256).regex(/^[^\s\p{Cc}]+$/u)
const modelId = z.string().min(1).max(6_144).regex(/^[^\p{Cc}]+$/u)
const hash = z.string().regex(/^[a-f\d]{64}$/u)
const timestamp = z.string().datetime({ offset: true })
export const usageTimeZoneSchema = z.string().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z\d_+/-]*$/u).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false }
}, 'Expected an IANA time zone')
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value => {
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}, 'Expected a calendar date')

/** Whole current request row. Input already includes the cache read/write subsets. */
export const usageTokenObservationSchema = z.object({
  providerId: usageProviderIdSchema, threadId: identity, recordKey: hash, groupKey: hash.optional(),
  modelId, tokens: usageTokensSchema.strict(), at: timestamp.optional(), groupStartedAt: timestamp.optional(),
  phase: z.enum(['live', 'replay', 'seed']), partial: z.boolean(),
  /** Retire an ambiguous aggregate once exact model rows replace it; retain only its hash. */
  removed: z.literal(true).optional(),
  /** Full Grok breakdown membership, hashed from sorted exact row keys for replay reconciliation. */
  groupRecordsHash: hash.optional(),
  /** Adapter proof of a new native group beginning live, not an observation-time guess. */
  liveNewGroup: z.boolean().optional(),
  /** Absent means a Sotto thread through the Sotto client, as every observation before history import was. */
  source: usageSourceSchema.optional(), client: usageClientSchema.optional(),
  /** Work a sub-agent did for the session, counted in tokens and never as a prompt. */
  subAgent: z.boolean().optional(),
  /** Read from the provider's own local record by the history importer rather than observed by an adapter. */
  origin: z.enum(['adapter', 'history']).optional(),
}).strict().refine(value => (value.source ?? 'sotto') === 'sotto' ? (value.client ?? 'sotto') === 'sotto' : value.client !== undefined && value.client !== 'sotto', {
  message: 'Sotto work uses the Sotto client and work outside Sotto names its own client',
}).refine(value => value.origin !== 'history' || value.at !== undefined, {
  message: 'Imported history carries the instant its provider recorded',
}).refine(value => value.liveNewGroup !== true || (value.phase === 'live' && value.groupKey !== undefined), {
  message: 'Live new-group evidence requires a live observation and group key',
}).refine(value => value.groupRecordsHash === undefined || (value.providerId === 'grok' && value.removed === true && value.groupKey !== undefined), {
  message: 'Group membership evidence requires a retired Grok aggregate and group key',
}).refine(value => value.tokens.input === undefined || value.tokens.output === undefined || Number.isSafeInteger(value.tokens.input + value.tokens.output), {
  message: 'Combined input and output exceed the supported token range',
})
export type UsageTokenObservation = z.infer<typeof usageTokenObservationSchema>

/** Original Sotto message metadata saved before native execution; exact echo supplies acceptance. */
export const usagePromptSubmissionSchema = z.object({
  providerId: usageProviderIdSchema, threadId: identity, messageId: identity, modelId, at: timestamp,
  kind: z.enum(['user', 'watcher', 'wake-up']), inputKind: z.enum(['send', 'steer']),
}).strict()
export type UsagePromptSubmission = z.infer<typeof usagePromptSubmissionSchema>
export const usagePromptIdentitySchema = z.object({ threadId: identity, messageId: identity }).strict()
export type UsagePromptIdentity = z.infer<typeof usagePromptIdentitySchema>

/**
 * A prompt read from a provider's own local records or from Sotto's thread store. It skips the
 * pending-then-echo path because the record already proves the provider received it.
 */
export const usageHistoryPromptSchema = z.object({
  providerId: usageProviderIdSchema, threadId: identity, messageId: identity, modelId, at: timestamp,
  kind: z.enum(['user', 'watcher', 'wake-up']), source: usageSourceSchema, client: usageClientSchema,
}).strict().refine(value => value.source === 'sotto' ? value.client === 'sotto' : value.client !== 'sotto', {
  message: 'Sotto work uses the Sotto client and work outside Sotto names its own client',
})
export type UsageHistoryPrompt = z.infer<typeof usageHistoryPromptSchema>
/** Where the importer stopped in one provider file. `state` is the reader's own numeric resume state, never text. */
export const usageHistoryCursorSchema = z.object({
  size: count, mtimeMs: count, offset: count, state: z.string().max(65_536).optional(),
}).strict()
export type UsageHistoryCursor = z.infer<typeof usageHistoryCursorSchema>
export const usageHistoryStatusSchema = z.object({
  status: z.enum(['scanning', 'complete', 'unavailable']), earliestAt: timestamp.optional(), scannedAt: timestamp.optional(),
}).strict()
export type UsageHistoryStatus = z.infer<typeof usageHistoryStatusSchema>

const localQueryShape = {
  from: day.optional(), to: day.optional(), timeZone: usageTimeZoneSchema.optional(),
  providerIds: z.array(usageProviderIdSchema).max(providers.length).optional(),
  /** Served models, by canonical ID. */
  modelIds: z.array(modelId).max(USAGE_MODEL_ROWS_MAX).optional(), includeDaily: z.boolean().optional(),
  sources: z.array(usageSourceSchema).max(USAGE_SOURCES.length).optional(),
  /** Exact lower bound, applied with any calendar range: the start of a subscription window. */
  since: timestamp.optional(),
}
const validRange = (value: { from?: string | undefined; to?: string | undefined }): boolean => value.from === undefined || value.to === undefined || value.from <= value.to
export const usageLocalQuerySchema = z.object(localQueryShape).strict().refine(validRange, 'Date range ends before it begins')
export type UsageLocalQuery = z.infer<typeof usageLocalQuerySchema>
/** Host IDs belong to the desktop router. A local authenticated host request omits them. */
export const usageQuerySchema = z.object({ ...localQueryShape, hostIds: z.array(identity).max(USAGE_HOSTS_MAX).optional() }).strict()
  .refine(validRange, 'Date range ends before it begins')
export type UsageQuery = z.infer<typeof usageQuerySchema>

export const usageFieldTotalSchema = z.object({
  /** Absent when no row reports the field. Known zero remains zero. */
  value: count.optional(), knownRows: count, rows: count, partial: z.boolean(),
}).strict()
export type UsageFieldTotal = z.infer<typeof usageFieldTotalSchema>
export const USAGE_TOKEN_FIELDS = ['input', 'output', 'cached', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'total'] as const
export type UsageTokenField = typeof USAGE_TOKEN_FIELDS[number]
export const usageTokenTotalsSchema = z.object({
  input: usageFieldTotalSchema, output: usageFieldTotalSchema, cached: usageFieldTotalSchema,
  cacheWrite: usageFieldTotalSchema, cacheWrite5m: usageFieldTotalSchema, cacheWrite1h: usageFieldTotalSchema,
  total: usageFieldTotalSchema,
}).strict()
export type UsageTokenTotals = z.infer<typeof usageTokenTotalsSchema>
export const usagePromptTotalsSchema = z.object({ user: count, watcher: count, wakeUp: count, total: count, steered: count }).strict()
export type UsagePromptTotals = z.infer<typeof usagePromptTotalsSchema>
export const usageActivityAggregateSchema = z.object({
  tokens: usageTokenTotalsSchema, prompts: usagePromptTotalsSchema,
  /** Threads in Sotto, sessions outside it: each distinct place the work ran. */
  tokenRecords: count, partialTokenRecords: count, undatedTokenRecords: count, activeThreads: count, activeDays: count,
  /** The latest calendar day with activity, in the query's time zone. */
  lastDay: day.optional(),
}).strict()
export type UsageActivityAggregate = z.infer<typeof usageActivityAggregateSchema>
export const usageMetadataSchema = z.object({
  startedAt: timestamp, revision: count, generation: count, clearedAt: timestamp.optional(), legacySeedCompleted: z.boolean(),
  /** Absent from hosts that predate history import. */
  history: usageHistoryStatusSchema.optional(),
}).strict()
export type UsageMetadata = z.infer<typeof usageMetadataSchema>
export const usageWriteResultSchema = z.object({ status: z.enum(['written', 'unchanged', 'suppressed']), revision: count }).strict()
export type UsageWriteResult = z.infer<typeof usageWriteResultSchema>
export const usagePromptAcceptanceResultSchema = z.object({ status: z.enum(['written', 'unchanged', 'suppressed', 'missing']), revision: count }).strict()
export type UsagePromptAcceptanceResult = z.infer<typeof usagePromptAcceptanceResultSchema>

export const usageProviderAggregateSchema = usageActivityAggregateSchema.extend({ providerId: usageProviderIdSchema }).strict()
export type UsageProviderAggregate = z.infer<typeof usageProviderAggregateSchema>
/**
 * One row per served model, by canonical ID. A prompt counts under the model that served it: the first
 * token report after it in the same thread or session, else its selection at send.
 */
export const usageModelAggregateSchema = usageProviderAggregateSchema.extend({ modelId }).strict()
export type UsageModelAggregate = z.infer<typeof usageModelAggregateSchema>
/** Activity grouped by where it ran and the app that sent it. Sub-agent work has its own row. */
export const usageClientAggregateSchema = usageActivityAggregateSchema.extend({
  source: usageSourceSchema, clientId: usageClientSchema, subAgent: z.boolean(),
  /** The providers whose work the row holds. */
  providerIds: z.array(usageProviderIdSchema).max(providers.length).optional(),
}).strict()
export type UsageClientAggregate = z.infer<typeof usageClientAggregateSchema>
export const usageDailyAggregateSchema = usageActivityAggregateSchema.extend({ day }).strict()
export type UsageDailyAggregate = z.infer<typeof usageDailyAggregateSchema>
/** Monday is 0 and Sunday is 6. Repeated fall-back hours share one cell. */
export const usageHourlyAggregateSchema = z.object({
  weekday: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23), prompts: usagePromptTotalsSchema,
}).strict()
export type UsageHourlyAggregate = z.infer<typeof usageHourlyAggregateSchema>
export const usageLocalReadSchema = z.object({
  metadata: usageMetadataSchema, totals: usageActivityAggregateSchema, timeZone: usageTimeZoneSchema,
  providers: z.array(usageProviderAggregateSchema).max(providers.length),
  models: z.array(usageModelAggregateSchema).max(USAGE_MODEL_ROWS_MAX), modelCount: count, modelsTruncated: z.boolean(),
  daily: z.array(usageDailyAggregateSchema).max(USAGE_DAILY_BUCKETS_MAX),
  dailyCoverage: z.enum(['complete', 'omitted-range', 'not-requested']),
  hourly: z.array(usageHourlyAggregateSchema).max(USAGE_HOURLY_CELLS_MAX),
  /** Absent from hosts that predate history import. */
  clients: z.array(usageClientAggregateSchema).max(USAGE_CLIENT_ROWS_MAX).optional(),
}).strict()
export type UsageLocalRead = z.infer<typeof usageLocalReadSchema>

/** Native account allowance, never inferred from the activity ledger or summed across hosts. */
export const usageQuotaWindowSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-zA-Z\d_-]+$/u), label: z.string().min(1).max(60).regex(/^[^\p{Cc}]+$/u),
  kind: z.enum(['primary', 'secondary', 'weekly', 'model', 'other']),
  usedPercent: z.number().finite().min(0).max(1_000_000).optional(), resetsAt: timestamp.optional(),
  durationMinutes: count.positive().optional(), modelId: modelId.optional(),
  status: z.enum(['allowed', 'warning', 'limited']).optional(), observedAt: timestamp.optional(),
}).strict()
export type UsageQuotaWindow = z.infer<typeof usageQuotaWindowSchema>
/**
 * A window's length in words, as a label ("5 hours", "Week") and as the noun a sentence uses ("5-hour window").
 * Main names windows with it and the page draws them with it, so the two never disagree.
 */
export function usageWindowLength(minutes: number | undefined): { label: string; noun: string } | undefined {
  if (minutes === undefined || !Number.isSafeInteger(minutes) || minutes <= 0) return undefined
  const plural = (n: number, one: string, many: string): string => n === 1 ? one : many
  // A calendar month runs 28 to 31 days, so four weeks is a month too.
  if (minutes >= 40_320 && minutes <= 44_640 && minutes % 1_440 === 0) return { label: 'Month', noun: 'monthly window' }
  if (minutes % 10_080 === 0) { const n = minutes / 10_080; return { label: plural(n, 'Week', `${n} weeks`), noun: plural(n, 'weekly window', `${n}-week window`) } }
  if (minutes % 1_440 === 0) { const n = minutes / 1_440; return { label: plural(n, 'Day', `${n} days`), noun: plural(n, 'daily window', `${n}-day window`) } }
  if (minutes % 60 === 0) { const n = minutes / 60; return { label: plural(n, '1 hour', `${n} hours`), noun: `${n}-hour window` } }
  return { label: plural(minutes, '1 minute', `${minutes} minutes`), noun: `${minutes}-minute window` }
}
export const usageQuotaReadSchema = z.object({
  providerId: usageProviderIdSchema, status: z.enum(['available', 'unavailable', 'error']),
  windows: z.array(usageQuotaWindowSchema).max(USAGE_QUOTA_WINDOWS_MAX), observedAt: timestamp.optional(), refreshable: z.boolean(),
  reason: z.enum(['unsupported', 'not-connected', 'not-read', 'not-reported', 'refresh-unavailable', 'read-failed']).optional(),
}).strict()
export type UsageQuotaRead = z.infer<typeof usageQuotaReadSchema>
export const usageRefreshQuerySchema = z.object({
  hostIds: z.array(identity).max(USAGE_HOSTS_MAX).optional(), providerIds: z.array(usageProviderIdSchema).max(providers.length).optional(),
}).strict()
export type UsageRefreshQuery = z.infer<typeof usageRefreshQuerySchema>
export const usageLocalHostReadSchema = z.object({
  status: z.enum(['ready', 'error']), activity: usageLocalReadSchema.optional(),
  quotas: z.array(usageQuotaReadSchema).max(providers.length), persistence: z.enum(['saved', 'failed']).optional(),
}).strict()
export type UsageLocalHostRead = z.infer<typeof usageLocalHostReadSchema>
export const usageHostReadSchema = usageLocalHostReadSchema.extend({
  hostId: identity, status: z.enum(['ready', 'unsupported', 'offline', 'error']),
}).strict()
export type UsageHostRead = z.infer<typeof usageHostReadSchema>
export const usageDashboardReadSchema = z.object({ hosts: z.array(usageHostReadSchema).max(USAGE_HOSTS_MAX) }).strict()
export type UsageDashboardRead = z.infer<typeof usageDashboardReadSchema>

export const usageLocalClearRequestSchema = z.object({ expectedRevision: count }).strict()
export type UsageLocalClearRequest = z.infer<typeof usageLocalClearRequestSchema>
export const usageLocalClearResultSchema = z.object({ status: z.enum(['cleared', 'stale']), metadata: usageMetadataSchema }).strict()
export type UsageLocalClearResult = z.infer<typeof usageLocalClearResultSchema>
export const usageClearQuerySchema = z.object({
  hosts: z.array(z.object({ hostId: identity, expectedRevision: count }).strict()).min(1).max(USAGE_HOSTS_MAX),
}).strict()
export type UsageClearQuery = z.infer<typeof usageClearQuerySchema>
export const usageClearResultSchema = z.object({
  hostId: identity, status: z.enum(['cleared', 'stale', 'unsupported', 'offline', 'error']), metadata: usageMetadataSchema.optional(),
}).strict()
export type UsageClearResult = z.infer<typeof usageClearResultSchema>

/** Numeric activity and native account limits stay outside the thread broadcast. */
export interface UsageBridge {
  read(query: UsageQuery): Promise<UsageDashboardRead>
  refresh(query: UsageRefreshQuery): Promise<UsageDashboardRead>
  clear(query: UsageClearQuery): Promise<UsageClearResult[]>
}
