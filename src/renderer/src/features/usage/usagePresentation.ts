import { servedModelName } from '../../../../shared/modelCatalog'
import {
  USAGE_TOKEN_FIELDS,
  type UsageActivityAggregate, type UsageClient, type UsageClientAggregate, type UsageDashboardRead, type UsageDailyAggregate,
  type UsageFieldTotal, type UsageHostRead, type UsageHourlyAggregate, type UsageLocalRead, type UsageModelAggregate,
  type UsageProviderAggregate, type UsageProviderId, type UsageQuotaRead, type UsageQuotaWindow, type UsageSource,
  type UsageTokenTotals,
} from '../../../../shared/usageDashboard'

/* ---------- Names ---------- */

export const USAGE_PROVIDERS: readonly UsageProviderId[] = ['codex', 'claude', 'grok', 'devin']
export const PROVIDER_NAMES: Record<UsageProviderId, string> = { codex: 'Codex', claude: 'Claude Code', grok: 'Grok Build', devin: 'Devin' }
export const PROVIDER_ORDER = Object.keys(PROVIDER_NAMES) as UsageProviderId[]
/** What a provider's limits belong to, when its client does not name the plan. */
export const PROVIDER_ACCOUNTS: Record<UsageProviderId, string> = { codex: 'ChatGPT through Codex', claude: 'Claude Code subscription', grok: 'Grok subscription', devin: 'Devin account' }
/** The short name a sentence about the provider's own report uses. */
const PROVIDER_SHORT: Record<UsageProviderId, string> = { codex: 'Codex', claude: 'Claude', grok: 'Grok', devin: 'Devin' }
/** Providers whose own records Usage reads outside Sotto (ADR-0080). The others are counted in Sotto only. */
export const READ_OUTSIDE_SOTTO: ReadonlySet<UsageProviderId> = new Set(['codex', 'claude'])
/** Devin reports no token counts at all; its prompts still count. */
export const NO_TOKENS: ReadonlySet<UsageProviderId> = new Set(['devin'])

export const CLIENT_NAMES: Record<UsageClient, string> = {
  sotto: 'Sotto', 'claude-code': 'Claude Code', 'codex-app': 'Codex app', 'codex-cli': 'Codex CLI', 'codex-exec': 'codex exec',
  'codex-ide': 'Codex in VS Code', 't3-code': 'T3 Code', 'codex-in-claude-code': 'Codex plugin in Claude Code', other: 'Other apps',
}
/** The provider whose client each app outside Sotto drives, as its own records name it. */
export const CLIENT_PROVIDER: Partial<Record<UsageClient, UsageProviderId>> = {
  'claude-code': 'claude', 'codex-app': 'codex', 'codex-cli': 'codex', 'codex-exec': 'codex', 'codex-ide': 'codex', 't3-code': 'codex', 'codex-in-claude-code': 'codex',
}


/* ---------- Numbers ---------- */

const integers = new Intl.NumberFormat('en-US')
export const fmtInt = (value: number): string => integers.format(Math.round(value))
/** Tokens in B, M and K: one decimal below a hundred, whole from a hundred up, and every token below 10,000. */
export function fmtTok(value: number): string {
  if (value >= 1e11) return `${Math.round(value / 1e9)}B`
  if (value >= 999.5e6) return `${(value / 1e9).toFixed(1)}B`
  if (value >= 1e8) return `${Math.round(value / 1e6)}M`
  if (value >= 999.5e3) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e4) return `${Math.round(value / 1e3)}K`
  return fmtInt(value)
}
export const pct = (fraction: number): string => fraction > 0 && fraction < 0.005 ? 'under 1%' : `${Math.round(fraction * 100)}%`
export const share = (part: number, whole: number): string => whole > 0 ? pct(part / whole) : '0%'
/** A token field in words: a dash when nothing reported it, "≥" when some rows did not. */
export function fieldTokens(field: UsageFieldTotal): string {
  if (field.value === undefined) return '—'
  return `${field.partial ? '≥ ' : ''}${fmtTok(field.value)}`
}
export const fieldValue = (field: UsageFieldTotal): number => field.value ?? 0
export function formatField(field: UsageFieldTotal): string {
  if (field.value === undefined) return '—'
  return `${field.partial ? '≥ ' : ''}${fmtInt(field.value)}`
}

/* ---------- Combining computers ---------- */

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

const laterDay = (a: string | undefined, b: string | undefined): string | undefined => a === undefined ? b : b === undefined ? a : a > b ? a : b

export function sumActivity(rows: UsageActivityAggregate[]): UsageActivityAggregate {
  const tokens = Object.fromEntries(USAGE_TOKEN_FIELDS.map(field => [field, sumFields(rows.map(row => row.tokens[field]))])) as UsageTokenTotals
  const lastDay = rows.reduce<string | undefined>((latest, row) => laterDay(latest, row.lastDay), undefined)
  return {
    tokens,
    prompts: {
      user: add(rows.map(row => row.prompts.user)), watcher: add(rows.map(row => row.prompts.watcher)),
      wakeUp: add(rows.map(row => row.prompts.wakeUp)), total: add(rows.map(row => row.prompts.total)),
      steered: add(rows.map(row => row.prompts.steered)),
    },
    tokenRecords: add(rows.map(row => row.tokenRecords)), partialTokenRecords: add(rows.map(row => row.partialTokenRecords)),
    undatedTokenRecords: add(rows.map(row => row.undatedTokenRecords)), activeThreads: add(rows.map(row => row.activeThreads)),
    activeDays: add(rows.map(row => row.activeDays)),
    ...(lastDay === undefined ? {} : { lastDay }),
  }
}

const emptyField = (): UsageFieldTotal => ({ knownRows: 0, rows: 0, partial: false })
export function emptyActivity(): UsageActivityAggregate {
  return { tokens: Object.fromEntries(USAGE_TOKEN_FIELDS.map(field => [field, emptyField()])) as UsageTokenTotals,
    prompts: { user: 0, watcher: 0, wakeUp: 0, total: 0, steered: 0 }, tokenRecords: 0, partialTokenRecords: 0, undatedTokenRecords: 0, activeThreads: 0, activeDays: 0 }
}
export const isEmptyActivity = (row: UsageActivityAggregate): boolean => row.prompts.total === 0 && row.tokenRecords === 0

function grouped<T>(rows: T[], key: (row: T) => string): T[][] {
  const groups = new Map<string, T[]>()
  for (const row of rows) { const id = key(row); const group = groups.get(id) ?? []; group.push(row); groups.set(id, group) }
  return [...groups.values()]
}

/** A host from before history import: it counts only its Sotto threads and splits nothing by place. */
export const predatesHistory = (activity: UsageLocalRead): boolean => activity.clients === undefined

/**
 * A host from before history import counts only its Sotto threads and ignores the place filter, so its figures are
 * all "In Sotto" (one Sotto row, subagents folded in) and nothing outside Sotto.
 */
export function scopeHost(host: UsageHostRead, sources: readonly UsageSource[] | undefined): UsageHostRead {
  const activity = host.activity
  if (activity === undefined || !predatesHistory(activity)) return host
  if (sources !== undefined && !sources.includes('sotto')) {
    return { ...host, activity: { ...activity, totals: emptyActivity(), providers: [], models: [], modelCount: 0, daily: [], hourly: [] } }
  }
  return host
}

export interface UsageSummary {
  readonly totals: UsageActivityAggregate
  readonly daily: UsageDailyAggregate[]
  readonly dailyComplete: boolean
  readonly providers: UsageProviderAggregate[]
  readonly models: UsageModelAggregate[]
  readonly clients: UsageClientAggregate[]
  /** Ready computers whose host predates history import and so has no place split. */
  readonly withoutPlaces: string[]
  readonly hourly: UsageHourlyAggregate[]
  readonly busiest: UsageHourlyAggregate | undefined
  readonly cacheShare: number | undefined
  readonly modelsTruncated: boolean
  readonly lastDay: string | undefined
  readonly sottoTokens: number
  readonly sottoPrompts: number
  readonly subAgentTokens: number
}

export function presentUsage(read: UsageDashboardRead): UsageSummary {
  const hosts = read.hosts.filter(host => host.status === 'ready' && host.activity !== undefined)
  const activity = hosts.map(host => host.activity!)
  const daily: UsageDailyAggregate[] = grouped(activity.flatMap(row => row.daily), row => row.day)
    .map(rows => ({ ...sumActivity(rows), day: rows[0]!.day })).sort((a, b) => a.day.localeCompare(b.day))
  const providers: UsageProviderAggregate[] = grouped(activity.flatMap(row => row.providers), row => row.providerId)
    .map(rows => ({ ...sumActivity(rows), providerId: rows[0]!.providerId }))
    .sort((a, b) => USAGE_PROVIDERS.indexOf(a.providerId) - USAGE_PROVIDERS.indexOf(b.providerId))
  const models: UsageModelAggregate[] = grouped(activity.flatMap(row => row.models), row => JSON.stringify([row.providerId, row.modelId]))
    .map(rows => ({ ...sumActivity(rows), providerId: rows[0]!.providerId, modelId: rows[0]!.modelId }))
    .sort((a, b) => b.prompts.total - a.prompts.total || fieldValue(b.tokens.total) - fieldValue(a.tokens.total) || a.modelId.localeCompare(b.modelId))
  // A host without a place split counts only Sotto threads; it reads as one Sotto row.
  const clientRows = activity.flatMap(row => row.clients ?? (isEmptyActivity(row.totals) ? [] : [{ ...row.totals, source: 'sotto' as const, clientId: 'sotto' as const, subAgent: false }]))
  const clients: UsageClientAggregate[] = grouped(clientRows, row => `${row.source}:${row.clientId}:${row.subAgent}`)
    .map(rows => ({ ...sumActivity(rows), source: rows[0]!.source, clientId: rows[0]!.clientId, subAgent: rows[0]!.subAgent,
      ...(rows.some(row => row.providerIds !== undefined) ? { providerIds: PROVIDER_ORDER.filter(id => rows.some(row => row.providerIds?.includes(id))) } : {}) }))
  const hourly: UsageHourlyAggregate[] = grouped(activity.flatMap(row => row.hourly), row => `${row.weekday}:${row.hour}`)
    .map(rows => ({ weekday: rows[0]!.weekday, hour: rows[0]!.hour, prompts: {
      user: add(rows.map(row => row.prompts.user)), watcher: add(rows.map(row => row.prompts.watcher)),
      wakeUp: add(rows.map(row => row.prompts.wakeUp)), total: add(rows.map(row => row.prompts.total)), steered: add(rows.map(row => row.prompts.steered)),
    } }))
  const totals = sumActivity(activity.map(row => row.totals))
  const dailyComplete = activity.every(row => row.dailyCoverage === 'complete')
  if (dailyComplete) totals.activeDays = daily.filter(row => !isEmptyActivity(row)).length
  const busiest = hourly.filter(row => row.prompts.user > 0).sort((a, b) => b.prompts.user - a.prompts.user || a.weekday - b.weekday || a.hour - b.hour)[0]
  const cacheShare = totals.tokens.cached.value !== undefined && totals.tokens.input.value !== undefined
    && !totals.tokens.cached.partial && totals.tokens.input.value > 0
    ? totals.tokens.cached.value / totals.tokens.input.value : undefined
  const sotto = clients.filter(row => row.source === 'sotto')
  return {
    totals, daily, dailyComplete, providers, models, clients, hourly, busiest, cacheShare,
    withoutPlaces: hosts.filter(host => predatesHistory(host.activity!) && !isEmptyActivity(host.activity!.totals)).map(host => host.hostId),
    modelsTruncated: activity.some(row => row.modelsTruncated),
    lastDay: laterDay(totals.lastDay, daily.filter(row => !isEmptyActivity(row)).at(-1)?.day),
    sottoTokens: add(sotto.map(row => fieldValue(row.tokens.total))),
    sottoPrompts: add(sotto.map(row => row.prompts.total)),
    subAgentTokens: add(clients.filter(row => row.subAgent).map(row => fieldValue(row.tokens.total))),
  }
}

/** One bar on Where you work: Sotto threads, Sotto's subagents, then each app outside Sotto with its own subagents folded in. */
export interface UsagePlace {
  readonly key: string
  readonly name: string
  readonly inSotto: boolean
  readonly subAgent: boolean
  readonly prompts: number
  readonly wakeUps: number
  readonly tokens: number
  readonly subAgentTokens: number
  readonly provider: UsageProviderId | undefined
  /** Every provider whose work the place holds, when the host says. */
  readonly providers: readonly UsageProviderId[]
}
export function usagePlaces(clients: readonly UsageClientAggregate[]): UsagePlace[] {
  const places = new Map<string, { key: string; name: string; inSotto: boolean; subAgent: boolean; prompts: number; wakeUps: number; tokens: number; subAgentTokens: number; provider: UsageProviderId | undefined; providers: UsageProviderId[] }>()
  for (const row of clients) {
    const inSotto = row.source === 'sotto'
    const key = inSotto ? (row.subAgent ? 'sotto-sub' : 'sotto') : row.clientId
    const place = places.get(key) ?? { key, name: inSotto ? (row.subAgent ? "Sotto's subagents" : 'Sotto threads') : CLIENT_NAMES[row.clientId],
      inSotto, subAgent: inSotto && row.subAgent, prompts: 0, wakeUps: 0, tokens: 0, subAgentTokens: 0, provider: inSotto ? undefined : CLIENT_PROVIDER[row.clientId], providers: [] as UsageProviderId[] }
    for (const provider of row.providerIds ?? []) if (!place.providers.includes(provider)) place.providers.push(provider)
    const tokens = fieldValue(row.tokens.total)
    if (!row.subAgent) { place.prompts += row.prompts.total; place.wakeUps += row.prompts.wakeUp }
    place.tokens += tokens
    if (row.subAgent) place.subAgentTokens += tokens
    places.set(key, place)
  }
  return [...places.values()].filter(place => place.tokens > 0 || place.prompts > 0).sort((a, b) => b.tokens - a.tokens || b.prompts - a.prompts)
}

/** Prompts by the app that sent them. Subagents send none. */
export function sentFrom(clients: readonly UsageClientAggregate[]): Array<{ clientId: UsageClient; prompts: number }> {
  const totals = new Map<UsageClient, number>()
  for (const row of clients) if (!row.subAgent && row.prompts.total > 0) totals.set(row.clientId, (totals.get(row.clientId) ?? 0) + row.prompts.total)
  return [...totals.entries()].map(([clientId, prompts]) => ({ clientId, prompts })).sort((a, b) => b.prompts - a.prompts)
}

/* ---------- Dates, in the query's time zone ---------- */

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/** Monday first, the way hourly rows count weekdays. */
export const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
export const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
export const WEEKDAYS_PLURAL = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays']

export function calendarDay(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const part = (kind: Intl.DateTimeFormatPartTypes): string => parts.find(item => item.type === kind)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}
export function addDays(day: string, count: number): string {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + count)
  return date.toISOString().slice(0, 10)
}
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 864e5)
export function rangeBounds(days: number, now: Date, timeZone: string): { from: string; to: string } {
  const to = calendarDay(now, timeZone)
  return { from: addDays(to, 1 - days), to }
}
/** Monday is 0, as the hourly rows have it. */
export const weekdayOf = (day: string): number => (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7
const dayParts = (day: string): { month: number; date: number } => ({ month: Number(day.slice(5, 7)) - 1, date: Number(day.slice(8, 10)) })
/** "Sep 15". */
export function shortDay(day: string): string { const { month, date } = dayParts(day); return `${MONTHS[month]} ${date}` }
/** "Wednesday, October 14", with ", so far" for today. */
export function longDay(day: string, today: string): string {
  const { month, date } = dayParts(day)
  return `${WEEKDAYS_LONG[weekdayOf(day)]}, ${MONTHS_LONG[month]} ${date}${day === today ? ', so far' : ''}`
}
/** "Today", "Yesterday" or "Oct 9". */
export function relativeDay(day: string, today: string): string {
  if (day === today) return 'Today'
  if (day === addDays(today, -1)) return 'Yesterday'
  return shortDay(day)
}
export function rangeLabel(from: string | undefined, to: string | undefined, firstDay: string | undefined): string {
  if (from === undefined && to === undefined) return firstDay === undefined ? 'All time' : `Since ${shortDay(firstDay)}`
  if (from !== undefined && to !== undefined) return from === to ? shortDay(from) : `${shortDay(from)} – ${shortDay(to)}`
  return from !== undefined ? `Since ${shortDay(from)}` : `Through ${shortDay(to!)}`
}
export function hourLabel(hour: number): string { const h = hour % 24; return h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM` }

interface Zoned { readonly day: string; readonly weekday: number; readonly hour: number; readonly minute: number }
function zoned(at: number, timeZone: string): Zoned {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(at))
  const part = (kind: Intl.DateTimeFormatPartTypes): number => Number(parts.find(item => item.type === kind)?.value ?? 0)
  const day = calendarDay(new Date(at), timeZone)
  return { day, weekday: weekdayOf(day), hour: part('hour') % 24, minute: part('minute') }
}
export function clockTime(at: number, timeZone: string): string {
  const { hour, minute } = zoned(at, timeZone)
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`
}
export function spanText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 6e4))
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`
}
/** A reset in a few words: the time today, the weekday within the week, else the date. */
export function resetShort(at: number, now: number, timeZone: string): string {
  const target = zoned(at, timeZone), today = calendarDay(new Date(now), timeZone)
  if (target.day === today) return clockTime(at, timeZone)
  return daysBetween(today, target.day) < 6 ? WEEKDAYS_SHORT[target.weekday]! : shortDay(target.day)
}
/** "today 1:00 PM, in 2 h 20 min" or "Monday, Oct 19, 9:58 PM, in 5 days". */
export function resetLong(at: number, now: number, timeZone: string): string {
  const target = zoned(at, timeZone), today = calendarDay(new Date(now), timeZone), ms = at - now
  if (target.day === today) return `today ${clockTime(at, timeZone)}, in ${spanText(ms)}`
  const away = ms < 864e5 ? spanText(ms) : (() => { const days = Math.round(ms / 864e5); return `${days} day${days === 1 ? '' : 's'}` })()
  return `${WEEKDAYS_LONG[target.weekday]}, ${shortDay(target.day)}, ${clockTime(at, timeZone)}, in ${away}`
}
export function readAge(at: number | undefined, now: number): string {
  if (at === undefined) return 'Not read yet'
  const minutes = Math.max(0, Math.floor((now - at) / 6e4))
  if (minutes < 1) return 'Read just now'
  if (minutes < 60) return `Read ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Read ${hours} h ago`
  const days = Math.floor(hours / 24)
  return `Read ${days} day${days === 1 ? '' : 's'} ago`
}

/* ---------- Subscription limits ---------- */

export const LOW_LEFT = 20
const STALE_MS = 10 * 6e4

export interface UsageWindowView {
  readonly id: string
  /** Named by its length: "5 hours", "Week". */
  readonly label: string
  /** "5-hour window", for sentences. */
  readonly noun: string
  readonly durationMinutes: number | undefined
  readonly left: number | undefined
  readonly usedPercent: number | undefined
  readonly resetsAt: number | undefined
  /** Share of the window's time still to run, when its length and reset are both known. */
  readonly timeLeft: number | undefined
  readonly startedAt: number | undefined
}
function windowName(window: UsageQuotaWindow, providerId: UsageProviderId): { label: string; noun: string } {
  const minutes = window.durationMinutes
  let label: string, noun: string
  if (minutes !== undefined && minutes % 10_080 === 0) { const n = minutes / 10_080; label = n === 1 ? 'Week' : `${n} weeks`; noun = n === 1 ? 'weekly window' : `${n}-week window` }
  else if (minutes !== undefined && minutes % 1_440 === 0) { const n = minutes / 1_440; label = n === 1 ? 'Day' : `${n} days`; noun = n === 1 ? 'daily window' : `${n}-day window` }
  else if (minutes !== undefined && minutes % 60 === 0) { const n = minutes / 60; label = `${n} hour${n === 1 ? '' : 's'}`; noun = `${n}-hour window` }
  else if (minutes !== undefined) { label = `${minutes} minutes`; noun = `${minutes}-minute window` }
  else if (window.kind === 'weekly') { label = 'Week'; noun = 'weekly window' }
  else { label = window.label; noun = `${window.label.toLowerCase()} window` }
  // A host that already qualifies its window ("Opus, week", "Week, with extra usage", "Other limit, week") says more than its length.
  if (window.modelId === undefined && (window.kind === 'model' || window.kind === 'other' || window.label.includes(','))) {
    return { label: window.label, noun: `${window.label.charAt(0).toLowerCase()}${window.label.slice(1)} window` }
  }
  if (window.modelId !== undefined) {
    const model = servedModelName(providerId, window.modelId)
    label = `${label} for ${model}`; noun = `${noun} for ${model}`
  }
  return { label, noun }
}
export function windowView(window: UsageQuotaWindow, providerId: UsageProviderId, now: number): UsageWindowView {
  const resetsAt = window.resetsAt === undefined ? undefined : Date.parse(window.resetsAt)
  const span = window.durationMinutes === undefined ? undefined : window.durationMinutes * 6e4
  return {
    id: window.id, ...windowName(window, providerId), durationMinutes: window.durationMinutes,
    left: window.usedPercent === undefined ? undefined : Math.max(0, Math.min(100, Math.round(100 - window.usedPercent))),
    usedPercent: window.usedPercent, resetsAt,
    timeLeft: resetsAt === undefined || span === undefined ? undefined : Math.max(0, Math.min(100, (resetsAt - now) / span * 100)),
    startedAt: resetsAt === undefined || span === undefined ? undefined : resetsAt - span,
  }
}
export const windowExpired = (window: UsageQuotaWindow, now: number): boolean => window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now

export interface UsageReading {
  readonly hostId: string
  readonly quota: UsageQuotaRead
  /** Current windows only: a window whose reset has passed is no longer what the account holds. */
  readonly windows: UsageWindowView[]
  readonly expired: number
  readonly observedAt: number | undefined
  readonly tightest: UsageWindowView | undefined
  readonly longest: UsageWindowView | undefined
  readonly shortest: UsageWindowView | undefined
  readonly stale: boolean
}
export interface UsageProviderLimits {
  readonly providerId: UsageProviderId
  /** The freshest reading with a current window, else the most telling one. */
  readonly primary: UsageReading
  /** Other computers' readings with a known percentage, shown beside the primary and never added to it. */
  readonly others: UsageReading[]
  readonly readings: UsageReading[]
}
function reading(hostId: string, quota: UsageQuotaRead, now: number): UsageReading {
  const current = quota.windows.filter(window => !windowExpired(window, now)).map(window => windowView(window, quota.providerId, now))
  const known = current.filter(window => window.left !== undefined)
  const observed = quota.observedAt === undefined ? undefined : Date.parse(quota.observedAt)
  const pick = (list: UsageWindowView[], better: (a: UsageWindowView, b: UsageWindowView) => boolean): UsageWindowView | undefined => list.reduce<UsageWindowView | undefined>((best, item) => best === undefined || better(item, best) ? item : best, undefined)
  return {
    hostId, quota, windows: current, expired: quota.windows.length - current.length,
    observedAt: Number.isFinite(observed) ? observed : undefined,
    tightest: pick(known, (a, b) => a.left! < b.left!),
    longest: pick(current, (a, b) => (a.durationMinutes ?? 0) > (b.durationMinutes ?? 0)),
    shortest: pick(current, (a, b) => (a.durationMinutes ?? Infinity) < (b.durationMinutes ?? Infinity)),
    stale: observed !== undefined && Number.isFinite(observed) && now - observed > STALE_MS,
  }
}
export function providerLimits(read: UsageDashboardRead, now: number): UsageProviderLimits[] {
  const readings = read.hosts.flatMap(host => host.quotas.map(quota => reading(host.hostId, quota, now)))
  const rank = (item: UsageReading): number => item.windows.length > 0 && item.quota.status === 'available' ? 0 : item.quota.status === 'available' ? 1 : item.quota.status === 'error' ? 2 : 3
  return USAGE_PROVIDERS.flatMap(providerId => {
    const own = readings.filter(item => item.quota.providerId === providerId)
      .sort((a, b) => rank(a) - rank(b) || (b.observedAt ?? 0) - (a.observedAt ?? 0))
    if (own.length === 0) return []
    const [primary, ...rest] = own
    return [{ providerId, primary: primary!, others: rest.filter(item => item.tightest !== undefined), readings: own }]
  })
}
/** Why a provider has no current window to show, in words. */
export function limitsMissing(limits: UsageProviderLimits, hostName: (hostId: string) => string, now: number, timeZone: string): string {
  const { primary, providerId } = limits
  const name = PROVIDER_NAMES[providerId]
  const quota = primary.quota
  if (quota.reason === 'unsupported' || providerId === 'devin') return `Sotto can't read ${name}'s limits yet.${providerId === 'devin' ? ' Devin shows them in its own usage settings.' : ''}`
  if (quota.status === 'available' && primary.expired > 0) {
    const last = Math.max(...quota.windows.map(window => window.resetsAt === undefined ? 0 : Date.parse(window.resetsAt)))
    const when = calendarDay(new Date(last), timeZone) === calendarDay(new Date(now), timeZone) ? `at ${clockTime(last, timeZone)}` : `on ${shortDay(calendarDay(new Date(last), timeZone))}`
    return `The window ${hostName(primary.hostId) === 'This computer' ? 'this computer' : hostName(primary.hostId)} last read ended ${when}. Read again for the new one.`
  }
  if (quota.status === 'error' || quota.reason === 'read-failed') return `${name}'s limits couldn't be read on ${hostName(primary.hostId)}. Nothing was changed. Read again to try once more.`
  switch (quota.reason) {
    case 'not-connected': return `${name} isn't connected on ${hostName(primary.hostId)}.`
    case 'not-read': return `${name}'s limits haven't been read on ${hostName(primary.hostId)} yet.`
    case 'refresh-unavailable': return `${name} hasn't reported its limits on ${hostName(primary.hostId)} yet.`
    default: return `${name} didn't report any limits.`
  }
}
export const unknownUseNote = (providerId: UsageProviderId): string => `${PROVIDER_SHORT[providerId]} reports when this resets, not how much is used.`
