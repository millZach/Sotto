import { parsePublicProviderEntityId, providerIdOfLabel, publicProviderEntityId, type AgentModel, type ProviderId } from '../../../../shared/agents'
import { resolveModel } from '../../../../shared/modelCatalog'
import {
  USAGE_TOKEN_FIELDS,
  type UsageActivityAggregate, type UsageDashboardRead, type UsageDailyAggregate,
  type UsageFieldTotal, type UsageHourlyAggregate, type UsageModelAggregate, type UsageProviderAggregate,
  type UsageTokenTotals, type UsageProviderId,
} from '../../../../shared/usageDashboard'

export const PROVIDER_NAMES: Record<UsageProviderId, string> = { codex: 'Codex', claude: 'Claude Code', grok: 'Grok Build', devin: 'Devin' }
const counts = new Intl.NumberFormat(undefined)
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
export const formatCount = (value: number): string => counts.format(value)
export const formatCompact = (value: number): string => value < 10_000 ? counts.format(value) : compact.format(value)
export function usageModelName(modelId: string, providerId: ProviderId, catalog: readonly AgentModel[]): string {
  const models = catalog.filter(model => (model.providerId ?? parsePublicProviderEntityId(model.id)?.provider ?? providerIdOfLabel(model.provider)) === providerId)
  const parsed = parsePublicProviderEntityId(modelId)
  const native = parsed?.kind === 'model' ? parsed.value : modelId
  const named = resolveModel(models, modelId) ?? resolveModel(models, publicProviderEntityId(providerId, 'model', native)) ?? resolveModel(models, native)
  if (named !== undefined) return named.name
  return native.replace(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/iu, (_, family: string, major: string, minor: string) => `${family[0]!.toUpperCase()}${family.slice(1)} ${major}.${minor}`)
    .replace(/^gpt-/iu, 'GPT-').replace(/^grok-/iu, 'Grok ')
}
export function formatField(field: UsageFieldTotal, short = false): string {
  if (field.value === undefined) return '—'
  return `${field.partial ? '≥ ' : ''}${short ? formatCompact(field.value) : formatCount(field.value)}`
}
const add = (values: number[]): number => Math.min(Number.MAX_SAFE_INTEGER, values.reduce((sum, value) => sum + value, 0))

export function sumFields(fields: UsageFieldTotal[]): UsageFieldTotal {
  const reported = fields.filter(field => field.value !== undefined)
  const value = reported.reduce((sum, field) => sum + field.value!, 0)
  const overflow = !Number.isSafeInteger(value)
  return {
    ...(reported.length > 0 && !overflow ? { value } : {}),
    knownRows: add(fields.map(field => field.knownRows)), rows: add(fields.map(field => field.rows)),
    partial: overflow || fields.some(field => field.partial || (field.rows > 0 && field.value === undefined)),
  }
}

/** Only host totals are combined: provider/model active-thread counts can overlap. */
export function sumActivity(rows: UsageActivityAggregate[]): UsageActivityAggregate {
  const tokens = Object.fromEntries(USAGE_TOKEN_FIELDS.map(field => [field, sumFields(rows.map(row => row.tokens[field]))])) as UsageTokenTotals
  return {
    tokens,
    prompts: {
      user: add(rows.map(row => row.prompts.user)), watcher: add(rows.map(row => row.prompts.watcher)),
      wakeUp: add(rows.map(row => row.prompts.wakeUp)), total: add(rows.map(row => row.prompts.total)),
      steered: add(rows.map(row => row.prompts.steered)),
    },
    tokenRecords: add(rows.map(row => row.tokenRecords)), partialTokenRecords: add(rows.map(row => row.partialTokenRecords)),
    undatedTokenRecords: add(rows.map(row => row.undatedTokenRecords)), activeThreads: add(rows.map(row => row.activeThreads)),
    // Daily aggregation below supplies the union of days across hosts.
    activeDays: add(rows.map(row => row.activeDays)),
  }
}

function grouped<T>(rows: T[], key: (row: T) => string): T[][] {
  const groups = new Map<string, T[]>()
  for (const row of rows) { const id = key(row); const group = groups.get(id) ?? []; group.push(row); groups.set(id, group) }
  return [...groups.values()]
}

export function presentUsage(read: UsageDashboardRead) {
  const activity = read.hosts.flatMap(host => host.activity === undefined ? [] : [host.activity])
  const daily: UsageDailyAggregate[] = grouped(activity.flatMap(row => row.daily), row => row.day)
    .map(rows => ({ ...sumActivity(rows), day: rows[0]!.day })).sort((a, b) => a.day.localeCompare(b.day))
  const providers: UsageProviderAggregate[] = grouped(activity.flatMap(row => row.providers), row => row.providerId)
    .map(rows => ({ ...sumActivity(rows), providerId: rows[0]!.providerId }))
  const models: UsageModelAggregate[] = grouped(activity.flatMap(row => row.models), row => JSON.stringify([row.providerId, row.modelId]))
    .map(rows => ({ ...sumActivity(rows), providerId: rows[0]!.providerId, modelId: rows[0]!.modelId }))
    .sort((a, b) => b.prompts.user - a.prompts.user || (b.tokens.total.value ?? -1) - (a.tokens.total.value ?? -1) || a.modelId.localeCompare(b.modelId))
  const hourly: UsageHourlyAggregate[] = grouped(activity.flatMap(row => row.hourly), row => `${row.weekday}:${row.hour}`)
    .map(rows => ({ weekday: rows[0]!.weekday, hour: rows[0]!.hour, prompts: {
      user: add(rows.map(row => row.prompts.user)), watcher: add(rows.map(row => row.prompts.watcher)),
      wakeUp: add(rows.map(row => row.prompts.wakeUp)), total: add(rows.map(row => row.prompts.total)), steered: add(rows.map(row => row.prompts.steered)),
    } }))
  const totals = sumActivity(activity.map(row => row.totals))
  const dailyComplete = activity.every(row => row.dailyCoverage === 'complete')
  if (dailyComplete) totals.activeDays = daily.filter(row => row.prompts.total > 0 || row.tokenRecords > 0).length
  const busiest = hourly.filter(row => row.prompts.user > 0).sort((a, b) => b.prompts.user - a.prompts.user || a.weekday - b.weekday || a.hour - b.hour)[0]
  const cacheShare = totals.tokens.cached.value !== undefined && totals.tokens.input.value !== undefined
    && !totals.tokens.cached.partial && !totals.tokens.input.partial && totals.tokens.input.value > 0
    ? totals.tokens.cached.value / totals.tokens.input.value : undefined
  return { totals, daily, dailyComplete, providers, models, hourly, busiest, cacheShare, modelsTruncated: activity.some(row => row.modelsTruncated) }
}

export function calendarDay(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const part = (kind: Intl.DateTimeFormatPartTypes): string => parts.find(item => item.type === kind)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function rangeBounds(days: number, now: Date, timeZone: string): { from: string; to: string } {
  const to = calendarDay(now, timeZone)
  const start = new Date(`${to}T12:00:00Z`)
  start.setUTCDate(start.getUTCDate() - days + 1)
  return { from: start.toISOString().slice(0, 10), to }
}
