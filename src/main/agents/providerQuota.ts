import { createHash } from 'node:crypto'
import type { ProviderId } from '../../shared/agents'
import {
  USAGE_QUOTA_WINDOWS_MAX, isUsageProviderId, usageQuotaReadSchema, usageWindowLength,
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
/** True when a window's reset has passed at `at`; a window with no reset, or no reference time, has not. */
function expired(window: Pick<UsageQuotaWindow, 'resetsAt'>, at: string | undefined): boolean {
  return !!window.resetsAt && !!at && Date.parse(window.resetsAt) <= Date.parse(at)
}
function windowId(provider: string, identity: string, kind: string): string {
  return `${provider}-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}-${kind}`
}

/**
 * What a window is called on the Usage page: its length ("5 hours", "Week", "Month"), never a native window name.
 * Undefined when the length is unknown, so the caller can say what kind of limit it is instead.
 */
export function quotaDurationLabel(minutes: number | undefined): string | undefined {
  return usageWindowLength(minutes)?.label
}

function codexPayload(value: unknown): Record<string, unknown> | undefined {
  const envelope = object(value)
  return envelope?.method === 'account/rateLimits/updated' ? object(envelope.params)
    : object(envelope?.result) ?? envelope
}
function codexRows(payload: Record<string, unknown> | undefined): Array<readonly [string, unknown]> {
  const multiple = object(payload?.rateLimitsByLimitId)
  return multiple !== undefined ? Object.entries(multiple).slice(0, 64)
    : object(payload?.rateLimits) ? [['codex', payload!.rateLimits]] : []
}
function codexIdentity(key: string, bucket: Record<string, unknown>): string {
  return typeof bucket.limitId === 'string' && bucket.limitId.trim() && bucket.limitId.length <= 512
    ? bucket.limitId.trim() : key.length <= 512 ? key : 'unknown'
}
/** Codex's own bucket is named by its length alone; any other bucket says it is another limit. */
function codexLabel(nativeId: string, kind: 'primary' | 'secondary', durationMinutes: number | undefined): string {
  const span = quotaDurationLabel(durationMinutes)
  if (nativeId === 'codex') return span ?? (kind === 'primary' ? 'Limit' : 'Second limit')
  return span ? `Other limit, ${span.toLocaleLowerCase('en-US')}` : kind === 'primary' ? 'Other limit' : 'Other second limit'
}
function read(providerId: UsageQuotaRead['providerId'], windows: UsageQuotaWindow[], observedAt: string, refreshable: boolean): UsageQuotaRead {
  const at = timestamp(observedAt)
  return usageQuotaReadSchema.parse({ providerId, status: windows.length ? 'available' : 'unavailable', windows,
    ...(at ? { observedAt: at } : {}), refreshable, ...(!windows.length ? { reason: 'not-reported' } : {}) })
}
/** Caller-owned connection/read state. Reasons are fixed words, never native exception text. */
export function unavailableProviderQuota(providerId: ProviderId, reason: NonNullable<UsageQuotaRead['reason']>,
  refreshable = false, observedAt?: string): UsageQuotaRead {
  if (!isUsageProviderId(providerId)) throw new Error('Usage is not available for this provider.')
  const at = timestamp(observedAt)
  return usageQuotaReadSchema.parse({ providerId, status: reason === 'read-failed' ? 'error' : 'unavailable', windows: [],
    refreshable, reason, ...(at ? { observedAt: at } : {}) })
}

/** Read result or account/rateLimits/updated payload; never publish native bucket IDs, names or account details. */
export function parseCodexQuota(value: unknown, observedAt: string): UsageQuotaRead {
  const payload = codexPayload(value)
  const multiple = object(payload?.rateLimitsByLimitId)
  const windows = new Map<string, UsageQuotaWindow>()
  const at = timestamp(observedAt)
  for (const [key, raw] of codexRows(payload)) {
    const bucket = object(raw)
    if (!bucket) continue
    const nativeId = codexIdentity(key, bucket)
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
      windows.set(id, { id, label: codexLabel(nativeId, kind, durationMinutes), kind,
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

/** A notification replaces its reported buckets; a full account/rateLimits/read remains a separate snapshot. */
export function mergeCodexQuota(previous: UsageQuotaRead | undefined, value: unknown, observedAt: string): UsageQuotaRead {
  const update = parseCodexQuota(value, observedAt)
  if (previous?.providerId !== 'codex') return update
  const payload = codexPayload(value)
  // Match the parser's legacy fallback when a malformed map accompanies a usable single bucket.
  const rows = update.windows.length && object(payload?.rateLimitsByLimitId) &&
    !parseCodexQuota({ rateLimitsByLimitId: payload?.rateLimitsByLimitId }, observedAt).windows.length
    ? codexRows({ rateLimits: payload?.rateLimits }) : codexRows(payload)
  const replaced = new Set<string>()
  for (const [key, raw] of rows) {
    const bucket = object(raw)
    if (!bucket) continue
    const nativeId = codexIdentity(key, bucket)
    for (const kind of ['primary', 'secondary']) replaced.add(windowId('codex', nativeId, kind))
  }
  if (!replaced.size) return previous
  const windows = new Map(previous.windows.map(window => [window.id, window]))
  const olderThan = (window: UsageQuotaWindow | undefined): boolean => {
    const oldAt = window?.observedAt ?? (window ? previous.observedAt : undefined)
    return !!oldAt && (!update.observedAt || Date.parse(update.observedAt) < Date.parse(oldAt))
  }
  for (const id of replaced) if (!olderThan(windows.get(id))) windows.delete(id)
  for (const window of update.windows) {
    if (!olderThan(windows.get(window.id))) windows.set(window.id, window)
  }
  const at = previous.observedAt && (!update.observedAt || Date.parse(previous.observedAt) > Date.parse(update.observedAt))
    ? previous.observedAt : update.observedAt
  const combined = [...windows.values()]
  const reported = new Set(update.windows.map(window => window.id))
  const bounded = combined.length <= USAGE_QUOTA_WINDOWS_MAX ? combined : [
    ...combined.filter(window => reported.has(window.id)), ...combined.filter(window => !reported.has(window.id)),
  ].slice(0, USAGE_QUOTA_WINDOWS_MAX)
  return read('codex', bounded, at ?? '', true)
}

type ClaudeWindowShape = Pick<UsageQuotaWindow, 'id' | 'label' | 'kind' | 'durationMinutes'>
const claudeWindows: Record<string, ClaudeWindowShape> = {
  five_hour: { id: 'claude-five-hour', label: '5 hours', kind: 'primary', durationMinutes: 300 },
  seven_day: { id: 'claude-seven-day', label: 'Week', kind: 'weekly', durationMinutes: 10_080 },
  seven_day_opus: { id: 'claude-seven-day-opus', label: 'Opus, week', kind: 'model', durationMinutes: 10_080 },
  seven_day_sonnet: { id: 'claude-seven-day-sonnet', label: 'Sonnet, week', kind: 'model', durationMinutes: 10_080 },
  seven_day_overage_included: { id: 'claude-seven-day-overage-included', label: 'Week, with extra usage', kind: 'weekly', durationMinutes: 10_080 },
  overage: { id: 'claude-overage', label: 'Extra usage', kind: 'other' },
}
const CLAUDE_OVERAGE = claudeWindows.overage!
/** Disabled reasons that mean extra usage is set up but cannot be used right now, rather than turned off. */
const CLAUDE_OVERAGE_BLOCKED = new Set(['out_of_credits', 'org_level_disabled_until'])
/** The windows a `get_usage` answer speaks for. A window it leaves out is not there now. */
const CLAUDE_SNAPSHOT_IDS = new Set(['claude-five-hour', 'claude-seven-day', 'claude-seven-day-opus', 'claude-seven-day-sonnet', CLAUDE_OVERAGE.id])
const CLAUDE_MODEL_ID = /^claude-[a-f\d]{24}-model$/u
const coveredBySnapshot = (id: string): boolean => CLAUDE_SNAPSHOT_IDS.has(id) || CLAUDE_MODEL_ID.test(id)
// Numeric observation age can predate a status-only event. Keep ordering private to the adapter cache;
// it is neither a new quota field nor saved account metadata, and expires with each discarded read.
const claudeQuotaEventTimes = new WeakMap<UsageQuotaRead, ReadonlyMap<string, string>>()
/** Windows an event said are not shown now (extra usage turned off or not in use); a merge removes them. */
const claudeQuotaCleared = new WeakMap<UsageQuotaRead, ReadonlySet<string>>()
/** Reads parsed from a passive event. A passive event never changes whether Claude can be read on demand. */
const claudePassiveReads = new WeakSet<UsageQuotaRead>()
/** Reads parsed from a `get_usage` answer: the whole account at one instant, not one changed window. */
const claudeUsageSnapshots = new WeakSet<UsageQuotaRead>()
function claudeStatus(value: unknown): UsageQuotaWindow['status'] {
  return value === 'allowed' ? 'allowed' : value === 'allowed_warning' ? 'warning' : value === 'rejected' ? 'limited' : undefined
}
/**
 * A passive event, not a guarantee that an idle account can be refreshed. Extra usage appears only while it
 * matters: near or at its limit, in use, or set up but blocked. Turned off, it is removed rather than shown.
 */
export function parseClaudeQuota(value: unknown, observedAt: string): UsageQuotaRead {
  const frame = object(value)
  const info = frame?.type === 'rate_limit_event' ? object(frame.rate_limit_info) : undefined
  const known = typeof info?.rateLimitType === 'string' && Object.hasOwn(claudeWindows, info.rateLimitType)
    ? claudeWindows[info.rateLimitType] : undefined
  const windows = new Map<string, UsageQuotaWindow>()
  const cleared = new Set<string>()
  const at = timestamp(observedAt)
  if (known && info) {
    const fraction = finite(info.utilization, MAX_PERCENT / 100)
    const usedPercent = fraction === undefined ? undefined : fraction * 100
    const resetsAt = unixTimestamp(info.resetsAt)
    const status = claudeStatus(info.status)
    if ((usedPercent !== undefined || resetsAt !== undefined || status !== undefined) && !expired({ resetsAt }, at)) {
      windows.set(known.id, { ...known, ...(usedPercent !== undefined ? { usedPercent } : {}),
        ...(resetsAt ? { resetsAt } : {}), ...(status ? { status } : {}), ...(at ? { observedAt: at } : {}) })
    }
  }
  if (info) {
    const disabled = typeof info.overageDisabledReason === 'string' ? info.overageDisabledReason : undefined
    const inUse = info.isUsingOverage === true || info.overageInUse === true
    const reported = known?.id === CLAUDE_OVERAGE.id || info.overageStatus !== undefined || info.overageResetsAt !== undefined
      || disabled !== undefined || typeof info.isUsingOverage === 'boolean' || typeof info.overageInUse === 'boolean'
    const existing = windows.get(CLAUDE_OVERAGE.id)
    const blocked = disabled !== undefined && CLAUDE_OVERAGE_BLOCKED.has(disabled)
    const status = blocked ? 'limited' : existing?.status ?? claudeStatus(info.overageStatus)
    const resetsAt = existing?.resetsAt ?? unixTimestamp(info.overageResetsAt)
    const shown = (disabled === undefined || blocked) && (inUse || status === 'warning' || status === 'limited')
    if (shown && !expired({ resetsAt }, at)) {
      windows.set(CLAUDE_OVERAGE.id, { ...CLAUDE_OVERAGE, ...existing, ...(status ? { status } : {}),
        ...(resetsAt ? { resetsAt } : {}), ...(at ? { observedAt: at } : {}) })
    } else if (reported) {
      windows.delete(CLAUDE_OVERAGE.id)
      cleared.add(CLAUDE_OVERAGE.id)
    }
  }
  const result = read('claude', [...windows.values()], observedAt, false)
  claudePassiveReads.add(result)
  if (cleared.size) claudeQuotaCleared.set(result, cleared)
  return result
}

/** Server labels such as "Opus" or "Fable"; anything else is called a model rather than repeated. */
const CLAUDE_MODEL_NAME = /^[A-Za-z][A-Za-z\d.-]*(?: [A-Za-z\d.-]+){0,3}$/u
/**
 * A `get_usage` control answer (the body, or the whole control_response frame). Its percentages are 0 to 100,
 * unlike the passive event's fraction. Only the documented windows are read: subscription type, session cost
 * and every other key in the answer are dropped, as are windows whose reset has already passed.
 */
export function parseClaudeUsage(value: unknown, observedAt: string): UsageQuotaRead {
  const envelope = object(value)
  const body = envelope?.type === 'control_response' ? object(object(envelope.response)?.response) : envelope
  const limits = body?.rate_limits_available === false ? undefined : object(body?.rate_limits)
  const at = timestamp(observedAt)
  const window = (shape: ClaudeWindowShape, raw: unknown): UsageQuotaWindow | undefined => {
    const row = object(raw)
    if (!row) return undefined
    const usedPercent = finite(row.utilization, MAX_PERCENT)
    const resetsAt = timestamp(row.resets_at)
    if (usedPercent === undefined && resetsAt === undefined) return undefined
    if (expired({ resetsAt }, at)) return undefined
    return { ...shape, ...(usedPercent !== undefined ? { usedPercent } : {}), ...(resetsAt ? { resetsAt } : {}),
      ...(at ? { observedAt: at } : {}) }
  }
  const fixed: UsageQuotaWindow[] = []
  const models: UsageQuotaWindow[] = []
  const extra: UsageQuotaWindow[] = []
  if (limits) {
    for (const key of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']) {
      const result = window(claudeWindows[key]!, limits[key])
      if (result) fixed.push(result)
    }
    const seen = new Set(fixed.map(row => row.id))
    const scoped = Array.isArray(limits.model_scoped) ? limits.model_scoped.slice(0, 64) : []
    scoped.forEach((raw, index) => {
      const row = object(raw)
      const named = typeof row?.display_name === 'string' ? row.display_name.trim() : ''
      const name = named.length <= 40 && CLAUDE_MODEL_NAME.test(named) ? named : undefined
      const lower = name?.toLocaleLowerCase('en-US')
      // A model the account also reports as its own weekly window is that window, not a second one.
      const shape: ClaudeWindowShape = lower === 'opus' ? claudeWindows.seven_day_opus!
        : lower === 'sonnet' ? claudeWindows.seven_day_sonnet!
          : { id: windowId('claude', name ? `model:${lower}` : `model#${index}`, 'model'), label: `${name ?? 'Model'}, week`, kind: 'model', durationMinutes: 10_080 }
      if (seen.has(shape.id)) return
      const result = window(shape, raw)
      if (result) { seen.add(shape.id); models.push(result) }
    })
    const extraUsage = object(limits.extra_usage)
    if (extraUsage?.is_enabled === true) {
      const result = window(CLAUDE_OVERAGE, { utilization: extraUsage.utilization })
      if (result) extra.push(result)
    }
  }
  const room = USAGE_QUOTA_WINDOWS_MAX - fixed.length - extra.length
  const result = read('claude', [...fixed, ...models.slice(0, Math.max(0, room)), ...extra], observedAt, true)
  claudeUsageSnapshots.add(result)
  return result
}

/**
 * Merge a passive event or a `get_usage` answer into the adapter's reading.
 *
 * A passive event merges only the windows it reported. Missing fields can retain unexpired evidence from the
 * same reset; rollover or an expired window cannot acquire old utilization. Retained figures keep their
 * original age. Older events cannot regress a window; unrelated windows and unavailable reads keep their own
 * times. A `get_usage` answer replaces every window it speaks for unless that window was seen later, and keeps
 * the rest. Windows whose reset has passed are dropped rather than carried.
 */
export function mergeClaudeQuota(previous: UsageQuotaRead | undefined, update: UsageQuotaRead): UsageQuotaRead {
  if (update.providerId !== 'claude' || previous?.providerId !== 'claude') return update
  const passive = claudePassiveReads.has(update)
  const refreshable = passive ? previous.refreshable : update.refreshable
  const eventTimes = new Map(claudeQuotaEventTimes.get(previous))
  for (const window of previous.windows) {
    const at = window.observedAt ?? previous.observedAt
    if (!eventTimes.has(window.id) && at) eventTimes.set(window.id, at)
  }
  const observedAt = previous.observedAt && (!update.observedAt || Date.parse(previous.observedAt) > Date.parse(update.observedAt)) ? previous.observedAt : update.observedAt
  // An unavailable read keeps the figures as stale evidence under its own status; a merged event or answer
  // is available exactly when a window is left.
  const finish = (base: UsageQuotaRead, windows: Iterable<UsageQuotaWindow>, keepStatus = false): UsageQuotaRead => {
    const live = [...windows].filter(window => !expired(window, observedAt)).slice(0, USAGE_QUOTA_WINDOWS_MAX)
    const rest: Partial<UsageQuotaRead> = { ...base }
    delete rest.reason; delete rest.observedAt
    const state = keepStatus ? { status: base.status, ...(base.reason ? { reason: base.reason } : {}) }
      : live.length ? { status: 'available' } : { status: 'unavailable', reason: 'not-reported' }
    // A read that saw nothing does not make the figures it keeps any newer.
    const at = keepStatus ? previous.observedAt : observedAt
    const result = usageQuotaReadSchema.parse({ ...rest, ...state, refreshable, windows: live, ...(at ? { observedAt: at } : {}) })
    claudeQuotaEventTimes.set(result, eventTimes)
    return result
  }
  // A passive event or a get_usage answer with nothing to show can still remove a window, such as extra usage
  // turned off; only a read that failed keeps the old figures as stale evidence.
  if (update.status !== 'available' && !passive && !claudeUsageSnapshots.has(update)) return finish(update, previous.windows, true)
  const newer = (id: string, at: string | undefined): boolean => {
    const eventAt = eventTimes.get(id)
    return !!eventAt && (!at || Date.parse(at) < Date.parse(eventAt))
  }
  if (claudeUsageSnapshots.has(update)) {
    const at = update.observedAt
    const windows = new Map<string, UsageQuotaWindow>()
    for (const window of previous.windows) {
      if (!coveredBySnapshot(window.id) || newer(window.id, at)) windows.set(window.id, window)
    }
    for (const window of update.windows) if (!windows.has(window.id)) windows.set(window.id, window)
    // Remember the answer's instant for what it removed too, so an older event cannot bring a window back.
    if (at) for (const id of new Set([...CLAUDE_SNAPSHOT_IDS, ...update.windows.map(window => window.id)])) if (!newer(id, at)) eventTimes.set(id, at)
    return finish(update, windows.values())
  }
  const windows = new Map(previous.windows.map(window => [window.id, { ...window }]))
  const nextAt = (id: string): string | undefined => claudeQuotaEventTimes.get(update)?.get(id) ?? update.windows.find(window => window.id === id)?.observedAt ?? update.observedAt
  for (const id of claudeQuotaCleared.get(update) ?? []) {
    const at = nextAt(id)
    if (newer(id, at)) continue
    windows.delete(id)
    if (at) eventTimes.set(id, at)
  }
  for (const window of update.windows) {
    const old = windows.get(window.id)
    const numericAt = old?.observedAt ?? previous.observedAt
    const at = nextAt(window.id)
    if (newer(window.id, at)) continue
    const sameReset = window.resetsAt === undefined || window.resetsAt === old?.resetsAt
    const unexpired = old?.resetsAt && at && Date.parse(old.resetsAt) > Date.parse(at)
    const retained = old && sameReset && unexpired ? old : undefined
    const merged = { ...retained, ...window }
    if (retained?.usedPercent !== undefined && window.usedPercent === undefined && numericAt) merged.observedAt = numericAt
    else if (retained?.resetsAt && window.usedPercent === undefined && window.resetsAt === undefined && numericAt) merged.observedAt = numericAt
    windows.set(window.id, merged)
    if (at) eventTimes.set(window.id, at)
  }
  return finish(update, windows.values())
}

/**
 * The reading as it stands at `now`: windows whose reset has passed are dropped, never shown with their old
 * figure. A reading left with no window says nothing is reported until the provider reports again.
 */
export function dropExpiredQuotaWindows(quota: UsageQuotaRead, now: string): UsageQuotaRead {
  const at = timestamp(now)
  if (!at) return quota
  const windows = quota.windows.filter(window => !expired(window, at))
  if (windows.length === quota.windows.length) return quota
  const result = usageQuotaReadSchema.parse({ ...quota, windows,
    ...(quota.status === 'available' && !windows.length ? { status: 'unavailable', reason: 'not-reported' } : {}) })
  const times = claudeQuotaEventTimes.get(quota)
  if (times) claudeQuotaEventTimes.set(result, times)
  return result
}

/** Only legacy Cent objects establish the same USD-cent dimension; arbitrary amount objects do not. */
function legacyCents(value: unknown): number | undefined {
  const row = object(value)
  if (!row || Object.keys(row).some(key => key !== 'val')) return undefined
  const amount = Object.hasOwn(row, 'val') ? finite(row.val, Number.MAX_SAFE_INTEGER) : 0
  return amount !== undefined && Number.isSafeInteger(amount) ? amount : undefined
}
/**
 * Native _x.ai/billing result. A missing percentage can still carry a real reset; never infer zero. Unified
 * billing accounts get a weekly reset and no percentage, which stays a reset with no figure.
 */
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
  // A named period keeps its name even when its actual dates run a little long or short.
  const label = weekly ? 'Week' : monthly || legacy ? 'Month' : quotaDurationLabel(durationMinutes) ?? 'Allowance'
  const window: UsageQuotaWindow = { id: weekly ? 'grok-weekly' : monthly || legacy ? 'grok-monthly' : 'grok-allowance',
    label, kind,
    ...(usedPercent !== undefined ? { usedPercent } : {}), ...(resetsAt ? { resetsAt } : {}),
    ...(durationMinutes ? { durationMinutes } : {}), ...(at ? { observedAt: at } : {}) }
  return read('grok', [window], observedAt, true)
}
