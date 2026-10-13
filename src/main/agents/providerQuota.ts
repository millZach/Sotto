import { createHash } from 'node:crypto'
import {
  USAGE_QUOTA_WINDOWS_MAX, usageQuotaReadSchema,
  type UsageQuotaRead, type UsageQuotaWindow,
} from '../../shared/usageDashboard'

// Metadata normalization only. These functions never own native sign-in, send a turn or alter billing.
const MAX_PERCENT = 1_000_000
const MAX_DURATION_MINUTES = 5_256_000
const MAX_UNIX_SECONDS = 253_402_300_799
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const finite = (value: unknown, maximum: number): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum ? value : undefined
const duration = (value: unknown): number | undefined => {
  const result = finite(value, MAX_DURATION_MINUTES)
  return result !== undefined && result > 0 && Number.isSafeInteger(result) ? result : undefined
}
function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return undefined
  const at = Date.parse(value)
  if (!Number.isFinite(at) || at < 0 || at > MAX_UNIX_SECONDS * 1_000) return undefined
  const normalized = new Date(at).toISOString()
  // Date.parse normalizes impossible dates; a provider reset must describe an actual calendar day.
  const date = value.slice(0, 10)
  const day = new Date(`${date}T00:00:00.000Z`)
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === date ? normalized : undefined
}
function unixTimestamp(value: unknown): string | undefined {
  const seconds = finite(value, MAX_UNIX_SECONDS)
  return seconds !== undefined && Number.isSafeInteger(seconds) ? new Date(seconds * 1_000).toISOString() : undefined
}
function windowId(provider: string, identity: string, kind: string): string {
  return `${provider}-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}-${kind}`
}
function read(providerId: UsageQuotaRead['providerId'], windows: UsageQuotaWindow[], observedAt: string, refreshable: boolean): UsageQuotaRead {
  const at = timestamp(observedAt)
  return usageQuotaReadSchema.parse({ providerId, status: windows.length ? 'available' : 'unavailable', windows,
    ...(at ? { observedAt: at } : {}), refreshable, ...(!windows.length ? { reason: 'not-reported' } : {}) })
}
/** Caller-owned connection/read state. Reasons are fixed words, never native exception text. */
export function unavailableProviderQuota(providerId: UsageQuotaRead['providerId'], reason: NonNullable<UsageQuotaRead['reason']>,
  refreshable = false, observedAt?: string): UsageQuotaRead {
  const at = timestamp(observedAt)
  return usageQuotaReadSchema.parse({ providerId, status: reason === 'read-failed' ? 'error' : 'unavailable', windows: [],
    refreshable, reason, ...(at ? { observedAt: at } : {}) })
}

/** Read result or account/rateLimits/updated payload; never publish native bucket IDs, names or account details. */
export function parseCodexQuota(value: unknown, observedAt: string): UsageQuotaRead {
  const envelope = object(value)
  const payload = envelope?.method === 'account/rateLimits/updated' ? object(envelope.params)
    : object(envelope?.result) ?? envelope
  const multiple = object(payload?.rateLimitsByLimitId)
  const rows = multiple !== undefined ? Object.entries(multiple).slice(0, 64)
    : object(payload?.rateLimits) ? [['single', payload!.rateLimits] as const] : []
  const windows = new Map<string, UsageQuotaWindow>()
  const at = timestamp(observedAt)
  for (const [key, raw] of rows) {
    const bucket = object(raw)
    if (!bucket) continue
    const nativeId = typeof bucket.limitId === 'string' && bucket.limitId.trim() && bucket.limitId.length <= 512
      ? bucket.limitId.trim() : key.length <= 512 ? key : 'unknown'
    const label = nativeId === 'codex' ? 'Codex' : nativeId === 'codex_other' ? 'Other Codex limit' : 'Codex limit'
    for (const kind of ['primary', 'secondary'] as const) {
      if (windows.size === USAGE_QUOTA_WINDOWS_MAX) break
      const source = object(bucket[kind])
      if (!source) continue
      const usedPercent = finite(source.usedPercent, MAX_PERCENT)
      const durationMinutes = duration(source.windowDurationMins)
      const resetsAt = unixTimestamp(source.resetsAt)
      if (usedPercent === undefined && durationMinutes === undefined && resetsAt === undefined) continue
      const id = windowId('codex', nativeId, kind)
      if (windows.has(id)) continue
      windows.set(id, { id, label: `${label} ${kind} window`, kind,
        ...(usedPercent !== undefined ? { usedPercent } : {}), ...(durationMinutes ? { durationMinutes } : {}),
        ...(resetsAt ? { resetsAt } : {}), ...(at ? { observedAt: at } : {}) })
    }
  }
  // Prefer a usable multi-bucket view. An empty or malformed map need not discard a valid older single view.
  if (!windows.size && multiple !== undefined && object(payload?.rateLimits)) {
    return parseCodexQuota({ rateLimits: payload!.rateLimits }, observedAt)
  }
  return read('codex', [...windows.values()], observedAt, true)
}

const claudeWindows: Record<string, Pick<UsageQuotaWindow, 'id' | 'label' | 'kind' | 'durationMinutes'>> = {
  five_hour: { id: 'claude-five-hour', label: 'Claude five-hour limit', kind: 'primary', durationMinutes: 300 },
  seven_day: { id: 'claude-seven-day', label: 'Claude weekly limit', kind: 'weekly', durationMinutes: 10_080 },
  seven_day_opus: { id: 'claude-seven-day-opus', label: 'Claude Opus weekly limit', kind: 'model', durationMinutes: 10_080 },
  seven_day_sonnet: { id: 'claude-seven-day-sonnet', label: 'Claude Sonnet weekly limit', kind: 'model', durationMinutes: 10_080 },
  overage: { id: 'claude-overage', label: 'Claude extra usage limit', kind: 'other' },
}
function claudeStatus(value: unknown): UsageQuotaWindow['status'] {
  return value === 'allowed' ? 'allowed' : value === 'allowed_warning' ? 'warning' : value === 'rejected' ? 'limited' : undefined
}
/** A passive event, not a guarantee that an idle account can be refreshed. */
export function parseClaudeQuota(value: unknown, observedAt: string): UsageQuotaRead {
  const frame = object(value)
  const info = frame?.type === 'rate_limit_event' ? object(frame.rate_limit_info) : undefined
  const known = typeof info?.rateLimitType === 'string' && Object.hasOwn(claudeWindows, info.rateLimitType)
    ? claudeWindows[info.rateLimitType] : undefined
  const windows = new Map<string, UsageQuotaWindow>()
  const at = timestamp(observedAt)
  if (known && info) {
    const fraction = finite(info.utilization, MAX_PERCENT / 100)
    const usedPercent = fraction === undefined ? undefined : fraction * 100
    const resetsAt = unixTimestamp(info.resetsAt)
    const status = claudeStatus(info.status)
    if (usedPercent !== undefined || resetsAt !== undefined || status !== undefined) {
      windows.set(known.id, { ...known, ...(usedPercent !== undefined ? { usedPercent } : {}),
        ...(resetsAt ? { resetsAt } : {}), ...(status ? { status } : {}), ...(at ? { observedAt: at } : {}) })
    }
  }
  const overageStatus = claudeStatus(info?.overageStatus)
  const overageReset = unixTimestamp(info?.overageResetsAt)
  if (overageStatus !== undefined || overageReset !== undefined) {
    const knownOverage = claudeWindows.overage!
    const existing = windows.get(knownOverage.id)
    windows.set(knownOverage.id, { ...knownOverage,
      ...(overageStatus ? { status: overageStatus } : {}), ...(overageReset ? { resetsAt: overageReset } : {}),
      ...(at ? { observedAt: at } : {}), ...existing })
  }
  return read('claude', [...windows.values()], observedAt, false)
}

/**
 * Replace only windows the event reported. Older events cannot regress a known window; unrelated windows
 * keep their own observed-at time. A failed/unreported read preserves figures as stale evidence, not fresh data.
 */
export function mergeClaudeQuota(previous: UsageQuotaRead | undefined, update: UsageQuotaRead): UsageQuotaRead {
  if (update.providerId !== 'claude' || previous?.providerId !== 'claude') return update
  if (update.status !== 'available') return usageQuotaReadSchema.parse({ ...update, windows: previous.windows, observedAt: previous.observedAt })
  const windows = new Map(previous.windows.map(window => [window.id, { ...window }]))
  for (const window of update.windows) {
    const old = windows.get(window.id)
    const oldAt = old?.observedAt ?? previous.observedAt
    const nextAt = window.observedAt ?? update.observedAt
    if (oldAt && (!nextAt || Date.parse(nextAt) < Date.parse(oldAt))) continue
    windows.set(window.id, { ...window })
  }
  const observedAt = previous.observedAt && (!update.observedAt || Date.parse(previous.observedAt) > Date.parse(update.observedAt)) ? previous.observedAt : update.observedAt
  return usageQuotaReadSchema.parse({ ...update, windows: [...windows.values()].slice(0, USAGE_QUOTA_WINDOWS_MAX), observedAt })
}

/** Only legacy Cent objects establish the same USD-cent dimension; arbitrary amount objects do not. */
function legacyCents(value: unknown): number | undefined {
  const row = object(value)
  if (!row || Object.keys(row).some(key => key !== 'val')) return undefined
  const amount = Object.hasOwn(row, 'val') ? finite(row.val, Number.MAX_SAFE_INTEGER) : 0
  return amount !== undefined && Number.isSafeInteger(amount) ? amount : undefined
}
/** Native _x.ai/billing result. A missing percentage can still carry a real reset; never infer zero. */
export function parseGrokQuota(value: unknown, observedAt: string): UsageQuotaRead {
  const envelope = object(value)
  const payload = object(envelope?.result) ?? envelope
  const config = object(payload?.config)
  if (!config) return read('grok', [], observedAt, true)
  const period = object(config.currentPeriod)
  // billing.rs documents this proto enum name; unrecognized strings keep a generic label and real reset.
  const weekly = period?.type === 'USAGE_PERIOD_TYPE_WEEKLY'
  const monthly = period?.type === 'USAGE_PERIOD_TYPE_MONTHLY'
  let usedPercent = finite(config.creditUsagePercent, MAX_PERCENT)
  // Deprecated monthly amounts cannot describe a newer weekly or unknown period.
  if (usedPercent === undefined && period === undefined && config.creditUsagePercent === undefined) {
    const limit = legacyCents(config.monthlyLimit)
    const used = legacyCents(config.used)
    if (limit !== undefined && limit > 0 && used !== undefined) usedPercent = finite(used / limit * 100, MAX_PERCENT)
  }
  const resetsAt = timestamp(period?.end) ?? (period === undefined ? timestamp(config.billingPeriodEnd) : undefined)
  const startsAt = timestamp(period?.start)
  const actualDuration = startsAt && resetsAt ? duration((Date.parse(resetsAt) - Date.parse(startsAt)) / 60_000) : undefined
  const durationMinutes = actualDuration ?? (weekly ? 10_080 : undefined)
  if (usedPercent === undefined && resetsAt === undefined && durationMinutes === undefined) return read('grok', [], observedAt, true)
  const legacy = period === undefined && (config.monthlyLimit !== undefined || config.billingPeriodEnd !== undefined)
  const kind = weekly ? 'weekly' : 'other'
  const at = timestamp(observedAt)
  const window: UsageQuotaWindow = { id: weekly ? 'grok-weekly' : monthly || legacy ? 'grok-monthly' : 'grok-allowance',
    label: weekly ? 'Grok weekly allowance' : monthly || legacy ? 'Grok monthly allowance' : 'Grok allowance', kind,
    ...(usedPercent !== undefined ? { usedPercent } : {}), ...(resetsAt ? { resetsAt } : {}),
    ...(durationMinutes ? { durationMinutes } : {}), ...(at ? { observedAt: at } : {}) }
  return read('grok', [window], observedAt, true)
}
