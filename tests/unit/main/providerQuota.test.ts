// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  dropExpiredQuotaWindows, exhaustedQuotaReset, mergeClaudeQuota, mergeCodexQuota, parseClaudeQuota, parseClaudeUsage, parseCodexQuota, parseGrokQuota, parseMuseQuota,
  quotaDurationLabel, unavailableProviderQuota,
} from '../../../src/main/agents/providerQuota'
import { usageQuotaReadSchema } from '../../../src/shared/usageDashboard'
import recordedUsage from '../../fixtures/claudeUsageAnswer.json'

const observedAt = '2026-10-12T18:00:00.000Z'
const later = '2026-10-12T18:05:00.000Z'
const resetSeconds = Date.parse('2026-10-12T23:00:00.000Z') / 1_000
const codexBucket = (usedPercent: unknown = 0) => ({ limitId: 'codex',
  primary: { usedPercent, windowDurationMins: 300, resetsAt: resetSeconds }, secondary: null })
const claudeEvent = (rateLimitType: string, utilization?: unknown) => ({ type: 'rate_limit_event',
  rate_limit_info: { rateLimitType, status: 'allowed', resetsAt: resetSeconds, ...(utilization !== undefined ? { utilization } : {}) } })

describe('native Codex quota', () => {
  it('preserves fresh zero, actual duration and epoch seconds in the old single-bucket reply', () => {
    const result = parseCodexQuota({ rateLimits: codexBucket() }, observedAt)
    expect(result).toMatchObject({ providerId: 'codex', status: 'available', refreshable: true, observedAt,
      windows: [{ label: '5 hours', kind: 'primary', usedPercent: 0,
        durationMinutes: 300, resetsAt: '2026-10-12T23:00:00.000Z', observedAt }] })
    expect(result.windows).toHaveLength(1)
  })
  it('prefers a present multi-bucket view over the older single bucket and keeps two window kinds', () => {
    const result = parseCodexQuota({ rateLimits: codexBucket(99), rateLimitsByLimitId: {
      codex: { ...codexBucket(20), primary: { usedPercent: 20, windowDurationMins: 15, resetsAt: resetSeconds },
        secondary: { usedPercent: 30, windowDurationMins: 10_080, resetsAt: resetSeconds + 100 } },
      codex_other: { limitId: 'codex_other', primary: { usedPercent: 40, windowDurationMins: 60 } },
    } }, observedAt)
    expect(result.windows.map(window => [window.kind, window.usedPercent, window.durationMinutes]))
      .toEqual([['primary', 20, 15], ['secondary', 30, 10_080], ['primary', 40, 60]])
    expect(new Set(result.windows.map(window => window.id)).size).toBe(3)
  })
  it('accepts notification envelopes and falls back when a multi-bucket view is absent or null', () => {
    expect(parseCodexQuota({ method: 'account/rateLimits/updated', params: { rateLimitsByLimitId: null,
      rateLimits: codexBucket(12) } }, observedAt).windows[0]?.usedPercent).toBe(12)
    expect(parseCodexQuota({ result: { rateLimits: codexBucket(13) } }, observedAt).windows[0]?.usedPercent).toBe(13)
  })
  it('uses the default Codex identity when the legacy bucket omits its limit ID', () => {
    const explicit = parseCodexQuota({ rateLimits: codexBucket(10) }, observedAt)
    const implicit = parseCodexQuota({ rateLimits: { primary: codexBucket(0).primary } }, later)
    expect(implicit.windows[0]?.id).toBe(explicit.windows[0]?.id)
    expect(implicit.windows[0]?.label).toBe('5 hours')
    const merged = mergeCodexQuota(explicit, { rateLimits: { primary: codexBucket(0).primary } }, later)
    expect(merged.windows).toHaveLength(1)
    expect(merged.windows[0]).toMatchObject({ usedPercent: 0, observedAt: later })
  })
  it('replaces only a notification bucket while preserving other identities and their observation times', () => {
    const before = parseCodexQuota({ rateLimitsByLimitId: {
      codex: { ...codexBucket(20), secondary: { usedPercent: 30, windowDurationMins: 10_080, resetsAt: resetSeconds + 100 } },
      codex_other: { limitId: 'codex_other', primary: { usedPercent: 40, windowDurationMins: 60 } },
    } }, observedAt)
    const merged = mergeCodexQuota(before, { method: 'account/rateLimits/updated', params: {
      rateLimits: codexBucket(0),
    } }, later)
    expect(merged.windows).toHaveLength(2)
    expect(merged.windows.find(window => window.label === '5 hours')).toMatchObject({ usedPercent: 0, observedAt: later })
    expect(merged.windows.find(window => window.label === 'Other limit, 1 hour')).toEqual(before.windows[2])
    expect(merged.windows.some(window => window.kind === 'secondary')).toBe(false)
    expect(before.windows).toHaveLength(3)
    // A subsequent complete read may legitimately omit the other bucket.
    expect(parseCodexQuota({ rateLimits: codexBucket(0) }, later).windows).toHaveLength(1)
  })
  it('retains unrelated buckets when a reported bucket becomes unknown without inventing zero', () => {
    const before = parseCodexQuota({ rateLimitsByLimitId: {
      codex: codexBucket(20), codex_other: { limitId: 'codex_other', primary: { usedPercent: 40 } },
    } }, observedAt)
    const merged = mergeCodexQuota(before, { rateLimits: { primary: { resetsAt: resetSeconds }, secondary: null } }, later)
    expect(merged.windows).toHaveLength(2)
    // The report lost its length, so the window is named for what it is rather than for an old length.
    const changed = merged.windows.find(window => window.label === 'Limit')
    expect(changed).toMatchObject({ resetsAt: '2026-10-12T23:00:00.000Z', observedAt: later })
    expect(changed).not.toHaveProperty('usedPercent')
    expect(mergeCodexQuota(merged, { rateLimits: { primary: null, secondary: null } }, later).windows)
      .toEqual([before.windows[1]])
    expect(mergeCodexQuota(before, {}, later)).toBe(before)
  })
  it('does not let an older notification remove or regress a newer bucket', () => {
    const before = parseCodexQuota({ rateLimits: { ...codexBucket(20), secondary: { usedPercent: 30 } } }, later)
    const merged = mergeCodexQuota(before, { rateLimits: codexBucket(1) }, observedAt)
    expect(merged.windows).toEqual(before.windows)
    expect(merged.observedAt).toBe(later)
  })
  it('keeps a newly reported bucket inside the bounded projection when earlier buckets filled it', () => {
    const before = parseCodexQuota({ rateLimitsByLimitId: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
      `bucket-${index}`, { primary: { usedPercent: index } },
    ])) }, observedAt)
    const merged = mergeCodexQuota(before, { rateLimits: codexBucket(0) }, later)
    expect(merged.windows).toHaveLength(8)
    expect(merged.windows.find(window => window.label === '5 hours'))
      .toMatchObject({ usedPercent: 0, observedAt: later })
  })
  it('falls back to a valid single bucket when a present multi-bucket map has no usable windows', () => {
    expect(parseCodexQuota({ rateLimits: codexBucket(99), rateLimitsByLimitId: {} }, observedAt).windows[0]?.usedPercent).toBe(99)
    expect(parseCodexQuota({ rateLimits: codexBucket(98), rateLimitsByLimitId: {
      invalid: { primary: { usedPercent: Number.NaN, resetsAt: -1 } }, empty: { primary: {} },
    } }, observedAt).windows[0]?.usedPercent).toBe(98)
    expect(parseCodexQuota({ rateLimitsByLimitId: {} }, observedAt)).toMatchObject({ status: 'unavailable', reason: 'not-reported', windows: [] })
  })
  it('keeps missing percentage distinct from zero and preserves a bounded over-limit reading', () => {
    const missing = parseCodexQuota({ rateLimits: { primary: { resetsAt: resetSeconds } } }, observedAt)
    expect(missing.status).toBe('available')
    expect(missing.windows[0]).not.toHaveProperty('usedPercent')
    expect(parseCodexQuota({ rateLimits: codexBucket(120) }, observedAt).windows[0]?.usedPercent).toBe(120)
  })
  it('rejects invalid numbers and empty windows without breaking a usable neighbor', () => {
    const invalid = parseCodexQuota({ rateLimitsByLimitId: {
      invalid: { primary: { usedPercent: Number.POSITIVE_INFINITY, windowDurationMins: -1, resetsAt: -1 } },
      empty: { primary: {} },
      valid: { primary: { usedPercent: 0, windowDurationMins: 0.5, resetsAt: Number.NaN } },
    } }, observedAt)
    expect(invalid.windows).toHaveLength(1)
    expect(invalid.windows[0]).toMatchObject({ usedPercent: 0 })
    expect(invalid.windows[0]).not.toHaveProperty('durationMinutes')
    expect(invalid.windows[0]).not.toHaveProperty('resetsAt')
    expect(parseCodexQuota({ rateLimits: { primary: { usedPercent: 1_000_001, resetsAt: Number.MAX_SAFE_INTEGER,
      windowDurationMins: Number.MAX_SAFE_INTEGER } } }, observedAt).windows).toEqual([])
  })
  it('deduplicates native bucket identities and bounds a noisy multi-bucket result', () => {
    const duplicate = parseCodexQuota({ rateLimitsByLimitId: { a: codexBucket(1), b: codexBucket(1) } }, observedAt)
    expect(duplicate.windows).toHaveLength(1)
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`bucket-${index}`, { primary: { usedPercent: index } }]))
    expect(parseCodexQuota({ rateLimitsByLimitId: many }, observedAt).windows).toHaveLength(8)
  })
  it('uses controlled labels and opaque IDs and drops arbitrary native account details', () => {
    const secret = 'private-account@example.com'
    const result = parseCodexQuota({ rateLimitsByLimitId: { [secret]: { limitId: secret, limitName: '\u001b[31mBearer private-key',
      primary: { usedPercent: 1, nativeAccountId: secret }, credits: { balance: 100, secret }, planType: secret,
      account: { email: secret } } } }, observedAt)
    expect(result.windows[0]?.label).toBe('Other limit')
    expect(JSON.stringify(result)).not.toMatch(/private-account|private-key|credits|balance|planType|nativeAccount|email|Bearer/u)
    expect(usageQuotaReadSchema.safeParse(result).success).toBe(true)
  })
})

describe('passive Claude quota events', () => {
  it('converts fractions and preserves zero without claiming idle refresh', () => {
    expect(parseClaudeQuota(claudeEvent('five_hour', 0.375), observedAt)).toMatchObject({ refreshable: false,
      windows: [{ id: 'claude-five-hour', usedPercent: 37.5, durationMinutes: 300, status: 'allowed' }] })
    expect(parseClaudeQuota(claudeEvent('five_hour', 0), observedAt).windows[0]?.usedPercent).toBe(0)
    expect(parseClaudeQuota(claudeEvent('five_hour'), observedAt).windows[0]).not.toHaveProperty('usedPercent')
  })
  it('keeps a rejected status even when the native event omitted numeric fields', () => {
    const result = parseClaudeQuota({ type: 'rate_limit_event', rate_limit_info: {
      rateLimitType: 'seven_day_opus', status: 'rejected' } }, observedAt)
    expect(result).toMatchObject({ status: 'available', windows: [{ id: 'claude-seven-day-opus', kind: 'model',
      label: 'Opus, week', durationMinutes: 10_080, status: 'limited' }] })
    expect(result.windows[0]).not.toHaveProperty('usedPercent')
    expect(result.windows[0]).not.toHaveProperty('modelId')
  })
  it('merges independent windows without refreshing their original observation times', () => {
    const before = parseClaudeQuota(claudeEvent('five_hour', 0.2), observedAt)
    const next = parseClaudeQuota(claudeEvent('seven_day', 0.5), later)
    const merged = mergeClaudeQuota(before, next)
    expect(merged.windows.map(window => [window.id, window.usedPercent, window.observedAt]))
      .toEqual([['claude-five-hour', 20, observedAt], ['claude-seven-day', 50, later]])
    expect(merged.observedAt).toBe(later)
    expect(before.windows).toHaveLength(1)
  })
  it('replaces the reported window and refuses to regress it with an older event', () => {
    const before = parseClaudeQuota(claudeEvent('five_hour', 0.2), observedAt)
    const next = parseClaudeQuota(claudeEvent('five_hour', 0.7), later)
    const merged = mergeClaudeQuota(before, next)
    expect(merged.windows).toHaveLength(1)
    expect(merged.windows[0]?.usedPercent).toBe(70)
    expect(mergeClaudeQuota(merged, before).windows[0]?.usedPercent).toBe(70)
    expect(mergeClaudeQuota(merged, before).observedAt).toBe(later)
  })
  it('retains unexpired utilization and reset through status-only events without refreshing their age', () => {
    for (const utilization of [0, 0.2]) {
      const before = parseClaudeQuota(claudeEvent('five_hour', utilization), observedAt)
      const next = parseClaudeQuota({ type: 'rate_limit_event', rate_limit_info: {
        rateLimitType: 'five_hour', status: 'allowed_warning',
      } }, later)
      const merged = mergeClaudeQuota(before, next)
      expect(merged.windows[0]).toMatchObject({ usedPercent: utilization * 100, status: 'warning',
        resetsAt: '2026-10-12T23:00:00.000Z', observedAt })
      expect(merged.observedAt).toBe(later)
    }
  })
  it('keeps status ordering separate from retained numeric age through delayed events and unavailable reads', () => {
    const before = parseClaudeQuota(claudeEvent('five_hour', 0.82), observedAt)
    const warning = mergeClaudeQuota(before, parseClaudeQuota({ type: 'rate_limit_event', rate_limit_info: {
      rateLimitType: 'five_hour', status: 'allowed_warning',
    } }, later))
    const stale = mergeClaudeQuota(warning, unavailableProviderQuota('claude', 'refresh-unavailable', false, later))
    const delayedAt = '2026-10-12T18:03:00.000Z'
    for (const update of [
      { rateLimitType: 'five_hour', status: 'allowed' },
      { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.1, resetsAt: resetSeconds + 300 },
    ]) {
      const merged = mergeClaudeQuota(stale, parseClaudeQuota({ type: 'rate_limit_event', rate_limit_info: update }, delayedAt))
      expect(merged.windows[0]).toMatchObject({ status: 'warning', usedPercent: 82,
        resetsAt: '2026-10-12T23:00:00.000Z', observedAt })
      expect(merged.observedAt).toBe(later)
      expect(usageQuotaReadSchema.safeParse(merged).success).toBe(true)
      expect(Object.keys(merged.windows[0]!)).not.toContain('eventAt')
    }
    // A separate window's event is not older than an existing observation of that window.
    const independent = mergeClaudeQuota(warning, parseClaudeQuota(claudeEvent('seven_day', 0.1), delayedAt))
    expect(independent.windows.find(window => window.id === 'claude-seven-day'))
      .toMatchObject({ usedPercent: 10, observedAt: delayedAt })
    expect(independent.windows.find(window => window.id === 'claude-five-hour'))
      .toMatchObject({ status: 'warning', usedPercent: 82, observedAt })
    const newestAt = '2026-10-12T18:06:00.000Z'
    const newest = mergeClaudeQuota(independent, parseClaudeQuota(claudeEvent('five_hour', 0.5), newestAt))
    expect(newest.windows.find(window => window.id === 'claude-five-hour'))
      .toMatchObject({ status: 'allowed', usedPercent: 50, observedAt: newestAt })
    expect(newest.windows.find(window => window.id === 'claude-seven-day')?.observedAt).toBe(delayedAt)
  })
  it('drops expired numeric evidence on a status-only event, including exactly at the reset', () => {
    const before = parseClaudeQuota(claudeEvent('five_hour', 0.2), observedAt)
    for (const at of ['2026-10-12T23:00:00.000Z', '2026-10-12T23:01:00.000Z']) {
      const merged = mergeClaudeQuota(before, parseClaudeQuota({ type: 'rate_limit_event', rate_limit_info: {
        rateLimitType: 'five_hour', status: 'allowed',
      } }, at))
      expect(merged.windows[0]).toMatchObject({ status: 'allowed', observedAt: at })
      expect(merged.windows[0]).not.toHaveProperty('usedPercent')
      expect(merged.windows[0]).not.toHaveProperty('resetsAt')
    }
  })
  it('supersedes prior utilization when a different reset identifies a new window', () => {
    const before = parseClaudeQuota(claudeEvent('five_hour', 0.2), observedAt)
    const rollover = { type: 'rate_limit_event', rate_limit_info: {
      rateLimitType: 'five_hour', status: 'allowed', resetsAt: resetSeconds + 300,
    } }
    const unknown = mergeClaudeQuota(before, parseClaudeQuota(rollover, later))
    expect(unknown.windows[0]).toMatchObject({ resetsAt: '2026-10-12T23:05:00.000Z', observedAt: later })
    expect(unknown.windows[0]).not.toHaveProperty('usedPercent')
    const zero = mergeClaudeQuota(before, parseClaudeQuota({ ...rollover,
      rate_limit_info: { ...rollover.rate_limit_info, utilization: 0 },
    }, later))
    expect(zero.windows[0]).toMatchObject({ usedPercent: 0, resetsAt: '2026-10-12T23:05:00.000Z', observedAt: later })
  })
  it('does not attach undated utilization to a later status event without a known unexpired reset', () => {
    const before = parseClaudeQuota({ type: 'rate_limit_event', rate_limit_info: {
      rateLimitType: 'five_hour', utilization: 0.2,
    } }, observedAt)
    const merged = mergeClaudeQuota(before, parseClaudeQuota({ type: 'rate_limit_event', rate_limit_info: {
      rateLimitType: 'five_hour', status: 'allowed',
    } }, later))
    expect(merged.windows[0]).not.toHaveProperty('usedPercent')
  })
  it('keeps prior figures as stale evidence after an unavailable read', () => {
    const before = parseClaudeQuota(claudeEvent('five_hour', 0.2), observedAt)
    const merged = mergeClaudeQuota(before, unavailableProviderQuota('claude', 'refresh-unavailable', false, later))
    expect(merged).toMatchObject({ status: 'unavailable', reason: 'refresh-unavailable', observedAt,
      windows: [{ usedPercent: 20, observedAt }] })
  })
  it('normalizes optional extra-usage status without financial or failure-text scraping', () => {
    const result = parseClaudeQuota({ type: 'rate_limit_event', rate_limit_info: {
      rateLimitType: 'seven_day_sonnet', utilization: 0.4, status: 'allowed_warning',
      overageStatus: 'rejected', overageResetsAt: resetSeconds,
      account: { email: 'private@example.com' }, raw: { prompt: 'private prompt' } } }, observedAt)
    expect(result.windows.map(window => [window.id, window.label, window.status])).toEqual([
      ['claude-seven-day-sonnet', 'Sonnet, week', 'warning'], ['claude-overage', 'Extra usage', 'limited'],
    ])
    expect(result.windows[1]).not.toHaveProperty('usedPercent')
    expect(JSON.stringify(result)).not.toMatch(/secret|private|account|prompt|raw|overageDisabledReason/u)
  })
  it('drops extra usage that is turned off, even when its status is rejected, and never repeats the reason', () => {
    const result = parseClaudeQuota({ type: 'rate_limit_event', rate_limit_info: {
      rateLimitType: 'seven_day_sonnet', utilization: 0.4, status: 'allowed_warning',
      overageStatus: 'rejected', overageResetsAt: resetSeconds, overageDisabledReason: 'secret-key' } }, observedAt)
    expect(result.windows.map(window => window.id)).toEqual(['claude-seven-day-sonnet'])
    expect(JSON.stringify(result)).not.toMatch(/secret|overageDisabledReason/u)
    for (const reason of ['overage_not_provisioned', 'org_level_disabled', 'member_level_disabled', 'unknown']) {
      expect(parseClaudeQuota({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', status: 'allowed',
        overageStatus: 'rejected', overageDisabledReason: reason } }, observedAt).windows.map(window => window.id)).toEqual(['claude-five-hour'])
    }
  })
  it('ignores unknown types and non-events, rejects invalid utilization, and retains over-limit fractions', () => {
    expect(parseClaudeQuota(claudeEvent('__proto__', 0.5), observedAt).windows).toEqual([])
    expect(parseClaudeQuota({ type: 'result', rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.5 } }, observedAt).windows).toEqual([])
    expect(parseClaudeQuota(claudeEvent('five_hour', -0.1), observedAt).windows[0]).not.toHaveProperty('usedPercent')
    expect(parseClaudeQuota(claudeEvent('five_hour', Number.NaN), observedAt).windows[0]).not.toHaveProperty('usedPercent')
    expect(parseClaudeQuota(claudeEvent('five_hour', 1.1), observedAt).windows[0]?.usedPercent).toBeCloseTo(110)
  })
})

describe('Claude get_usage answers', () => {
  const answerAt = '2099-10-14T18:00:00.000Z'
  const answer = (limits: Record<string, unknown>) => ({ rate_limits_available: true, rate_limits: limits })
  it('reads the documented windows as 0 to 100 percentages and drops every other key', () => {
    const result = parseClaudeUsage(recordedUsage, answerAt)
    expect(result).toMatchObject({ providerId: 'claude', status: 'available', refreshable: true, observedAt: answerAt })
    expect(result.windows.map(window => [window.id, window.label, window.kind, window.usedPercent, window.durationMinutes, window.resetsAt]))
      .toEqual([
        ['claude-five-hour', '5 hours', 'primary', 41, 300, '2099-10-14T20:00:00.000Z'],
        ['claude-seven-day', 'Week', 'weekly', 6, 10_080, '2099-10-21T13:00:00.000Z'],
        [expect.stringMatching(/^claude-[a-f\d]{24}-model$/u), 'Fable, week', 'model', 0, 10_080, '2099-10-21T13:00:00.000Z'],
      ])
    // Extra usage is turned off; the codename window, the OAuth apps window, the plan and every cost figure are gone.
    expect(JSON.stringify(result)).not.toMatch(/tangerine|blossom|otter|spend|cost|max|subscription|session|12\.5|1234|5000|24\.68|77|USD|Extra/u)
    expect(result.windows.some(window => window.usedPercent === 13)).toBe(false)
    expect(usageQuotaReadSchema.safeParse(result).success).toBe(true)
  })
  it('accepts the whole control_response frame and shows extra usage only when it is turned on', () => {
    const frame = { type: 'control_response', response: { subtype: 'success', request_id: 'r', response: answer({
      five_hour: { utilization: 12.5, resets_at: '2099-10-14T20:00:00Z' },
      extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 30, utilization: 30, currency: 'USD' } }) } }
    const result = parseClaudeUsage(frame, answerAt)
    expect(result.windows.map(window => [window.id, window.label, window.usedPercent])).toEqual([
      ['claude-five-hour', '5 hours', 12.5], ['claude-overage', 'Extra usage', 30]])
    expect(result.windows[1]).not.toHaveProperty('resetsAt')
    expect(JSON.stringify(result)).not.toMatch(/USD|credits|monthly/u)
  })
  it('keeps over-limit and zero figures, drops null and passed windows, and refuses plans without limits', () => {
    const result = parseClaudeUsage(answer({ five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 104, resets_at: '2099-10-21T13:00:00Z' },
      seven_day_opus: { utilization: 50, resets_at: '2099-10-14T17:00:00Z' }, seven_day_sonnet: { utilization: -1, resets_at: 'soon' } }), answerAt)
    expect(result.windows.map(window => [window.id, window.usedPercent])).toEqual([['claude-five-hour', 0], ['claude-seven-day', 104]])
    expect(result.windows[0]).not.toHaveProperty('resetsAt')
    expect(parseClaudeUsage({ rate_limits_available: false, rate_limits: { five_hour: { utilization: 5 } } }, answerAt))
      .toMatchObject({ status: 'unavailable', reason: 'not-reported', refreshable: true, windows: [] })
    expect(parseClaudeUsage(null, answerAt)).toMatchObject({ status: 'unavailable', windows: [] })
  })
  it('names model windows only from plain model names, folds Opus and Sonnet into their own windows and bounds the list', () => {
    const scoped = [{ display_name: 'Opus', utilization: 9, resets_at: null }, { display_name: 'Bearer\u001b[31m secret', utilization: 1, resets_at: null },
      ...Array.from({ length: 20 }, (_, index) => ({ display_name: `Model${index}`, utilization: index, resets_at: null }))]
    const result = parseClaudeUsage(answer({ five_hour: { utilization: 1, resets_at: null }, model_scoped: scoped,
      extra_usage: { is_enabled: true, utilization: 2 } }), answerAt)
    expect(result.windows).toHaveLength(8)
    expect(result.windows.map(window => window.label).slice(0, 3)).toEqual(['5 hours', 'Opus, week', 'Model, week'])
    expect(result.windows.find(window => window.label === 'Opus, week')?.id).toBe('claude-seven-day-opus')
    expect(result.windows.at(-1)?.label).toBe('Extra usage')
    expect(JSON.stringify(result)).not.toMatch(/Bearer|secret/u)
    const both = parseClaudeUsage(answer({ seven_day_opus: { utilization: 3, resets_at: null }, model_scoped: [{ display_name: 'opus', utilization: 9, resets_at: null }] }), answerAt)
    expect(both.windows.map(window => [window.id, window.usedPercent])).toEqual([['claude-seven-day-opus', 3]])
  })
})

describe('merging Claude readings', () => {
  const at = (minute: number) => `2026-10-12T18:${String(minute).padStart(2, '0')}:00.000Z`
  const usage = (limits: Record<string, unknown>, minute: number) => parseClaudeUsage({ rate_limits_available: true, rate_limits: limits }, at(minute))
  const event = (info: Record<string, unknown>, minute: number) => parseClaudeQuota({ type: 'rate_limit_event', rate_limit_info: info }, at(minute))
  const reset = '2026-10-12T23:00:00.000Z'
  it('lets a get_usage answer replace older passive windows it speaks for and keep the ones it does not', () => {
    let quota = event({ rateLimitType: 'seven_day_opus', status: 'rejected', overageStatus: 'rejected', resetsAt: resetSeconds }, 1)
    quota = mergeClaudeQuota(quota, event({ rateLimitType: 'seven_day_overage_included', status: 'allowed_warning', utilization: 0.9, resetsAt: resetSeconds }, 2))
    expect(quota.windows.map(window => window.id)).toEqual(['claude-seven-day-opus', 'claude-overage', 'claude-seven-day-overage-included'])
    expect(quota.windows.find(window => window.id === 'claude-seven-day-overage-included'))
      .toMatchObject({ label: 'Week, with extra usage', kind: 'weekly', usedPercent: 90 })
    const merged = mergeClaudeQuota(quota, usage({ five_hour: { utilization: 40, resets_at: reset }, extra_usage: { is_enabled: false } }, 3))
    expect(merged.windows.map(window => [window.id, window.usedPercent])).toEqual([['claude-seven-day-overage-included', 90], ['claude-five-hour', 40]])
    expect(merged).toMatchObject({ status: 'available', refreshable: true, observedAt: at(3) })
  })
  it('lets an answer with no windows to show remove extra usage that is now turned off', () => {
    const using = usage({ extra_usage: { is_enabled: true, utilization: 30 } }, 1)
    expect(using.windows.map(window => window.id)).toEqual(['claude-overage'])
    const off = mergeClaudeQuota(using, usage({ extra_usage: { is_enabled: false } }, 2))
    expect(off).toMatchObject({ status: 'unavailable', reason: 'not-reported', windows: [] })
    // A read that failed is not an answer: it keeps the figures it had as stale evidence.
    expect(mergeClaudeQuota(using, unavailableProviderQuota('claude', 'refresh-unavailable', true, at(3))).windows.map(window => window.id)).toEqual(['claude-overage'])
  })
  it('keeps a passive window seen after the answer, and an older event cannot bring back what the answer removed', () => {
    const newer = event({ rateLimitType: 'five_hour', status: 'allowed_warning', utilization: 0.7, resetsAt: resetSeconds }, 5)
    const merged = mergeClaudeQuota(newer, usage({ five_hour: { utilization: 40, resets_at: reset } }, 4))
    expect(merged.windows[0]).toMatchObject({ usedPercent: 70, status: 'warning', observedAt: at(5) })
    const answered = mergeClaudeQuota(event({ rateLimitType: 'five_hour', status: 'allowed', resetsAt: resetSeconds }, 1),
      usage({ seven_day: { utilization: 5, resets_at: reset } }, 4))
    expect(answered.windows.map(window => window.id)).toEqual(['claude-seven-day'])
    const late = mergeClaudeQuota(answered, event({ rateLimitType: 'five_hour', status: 'allowed', utilization: 0.1, resetsAt: resetSeconds }, 2))
    expect(late.windows.map(window => window.id)).toEqual(['claude-seven-day'])
  })
  it('keeps the answer figure through a later status-only event, and a passive event never changes whether Claude can be read', () => {
    const answered = mergeClaudeQuota(unavailableProviderQuota('claude', 'not-read', true), usage({ five_hour: { utilization: 40, resets_at: reset } }, 1))
    const merged = mergeClaudeQuota(answered, event({ rateLimitType: 'five_hour', status: 'allowed', resetsAt: resetSeconds }, 2))
    expect(merged).toMatchObject({ refreshable: true, status: 'available', windows: [{ usedPercent: 40, status: 'allowed', observedAt: at(1) }] })
    expect(mergeClaudeQuota(merged, unavailableProviderQuota('claude', 'refresh-unavailable', false, at(3)))).toMatchObject({
      refreshable: false, status: 'unavailable', reason: 'refresh-unavailable', windows: [{ usedPercent: 40 }] })
  })
  it('shows extra usage only near or at its limit, in use, or blocked, and removes it when a later event says otherwise', () => {
    expect(event({ rateLimitType: 'five_hour', status: 'allowed', overageStatus: 'allowed' }, 1).windows.map(window => window.id)).toEqual(['claude-five-hour'])
    expect(event({ rateLimitType: 'five_hour', status: 'allowed', overageStatus: 'allowed', isUsingOverage: true }, 1).windows.map(window => [window.id, window.status]))
      .toEqual([['claude-five-hour', 'allowed'], ['claude-overage', 'allowed']])
    expect(event({ rateLimitType: 'overage', status: 'allowed_warning', resetsAt: resetSeconds }, 1).windows)
      .toMatchObject([{ id: 'claude-overage', label: 'Extra usage', status: 'warning' }])
    expect(event({ rateLimitType: 'five_hour', status: 'rejected', overageStatus: 'rejected', overageDisabledReason: 'out_of_credits' }, 1).windows.map(window => [window.id, window.status]))
      .toEqual([['claude-five-hour', 'limited'], ['claude-overage', 'limited']])
    const shown = event({ rateLimitType: 'five_hour', status: 'allowed', overageStatus: 'allowed_warning', utilization: 0.2, resetsAt: resetSeconds }, 1)
    expect(shown.windows.map(window => window.id)).toEqual(['claude-five-hour', 'claude-overage'])
    const off = mergeClaudeQuota(shown, event({ overageStatus: 'rejected', overageDisabledReason: 'member_level_disabled' }, 2))
    expect(off).toMatchObject({ status: 'available', windows: [{ id: 'claude-five-hour', usedPercent: 20 }] })
    expect(off.windows).toHaveLength(1)
    // An older event cannot bring it back.
    expect(mergeClaudeQuota(off, shown).windows.map(window => window.id)).toEqual(['claude-five-hour'])
    // Clearing the only window leaves nothing reported rather than an available reading with nothing in it.
    const alone = event({ rateLimitType: 'overage', status: 'rejected' }, 1)
    expect(mergeClaudeQuota(alone, event({ overageStatus: 'allowed', isUsingOverage: false }, 2)))
      .toMatchObject({ status: 'unavailable', reason: 'not-reported', windows: [] })
  })
  it('drops windows whose reset has passed instead of carrying them', () => {
    expect(parseClaudeQuota(claudeEvent('five_hour', 0.5), '2026-10-12T23:00:00.000Z').windows).toEqual([])
    const before = parseClaudeQuota(claudeEvent('seven_day', 0.5), observedAt)
    const after = mergeClaudeQuota(before, parseClaudeQuota({ type: 'rate_limit_event', rate_limit_info: {
      rateLimitType: 'five_hour', status: 'allowed', resetsAt: resetSeconds + 3_600 } }, '2026-10-12T23:30:00.000Z'))
    expect(after.windows.map(window => window.id)).toEqual(['claude-five-hour'])
    const kept = parseClaudeUsage({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 40, resets_at: reset },
      seven_day: { utilization: 5, resets_at: '2026-10-19T13:00:00.000Z' } } }, observedAt)
    expect(dropExpiredQuotaWindows(kept, later)).toBe(kept)
    expect(dropExpiredQuotaWindows(kept, reset).windows.map(window => window.id)).toEqual(['claude-seven-day'])
    expect(dropExpiredQuotaWindows(kept, '2026-10-20T00:00:00.000Z'))
      .toMatchObject({ status: 'unavailable', reason: 'not-reported', windows: [], refreshable: true })
  })
})

describe('window labels by length', () => {
  it('names a window by its length, never by a native window name', () => {
    expect([300, 60, 15, 1, 1_440, 4_320, 10_080, 40_320, 43_200, 44_640, 50_000, 90].map(quotaDurationLabel)).toEqual([
      '5 hours', '1 hour', '15 minutes', '1 minute', 'Day', '3 days', 'Week', 'Month', 'Month', 'Month', '50000 minutes', '90 minutes'])
    expect([undefined, 0, -5, 1.5].map(quotaDurationLabel)).toEqual([undefined, undefined, undefined, undefined])
  })
  it('labels Codex windows by their reported length, and other buckets as other limits', () => {
    const result = parseCodexQuota({ rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: { usedPercent: 1, windowDurationMins: 300 }, secondary: { usedPercent: 2, windowDurationMins: 10_080 } },
      monthly: { primary: { usedPercent: 3, windowDurationMins: 43_200 }, secondary: { usedPercent: 4 } },
    } }, observedAt)
    expect(result.windows.map(window => window.label)).toEqual(['5 hours', 'Week', 'Other limit, month', 'Other second limit'])
    expect(JSON.stringify(result)).not.toMatch(/primary window|secondary window|Codex/u)
  })
  it('labels Claude and Grok windows by length or model', () => {
    expect(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'].map(type => parseClaudeQuota(claudeEvent(type, 0.1), observedAt).windows[0]?.label))
      .toEqual(['5 hours', 'Week', 'Opus, week', 'Sonnet, week'])
    const grok = parseGrokQuota({ config: { currentPeriod: { type: 'FUTURE_PERIOD', start: '2026-10-12T00:00:00Z', end: '2026-10-13T00:00:00Z' } } }, observedAt)
    expect(grok.windows[0]).toMatchObject({ id: 'grok-allowance', label: 'Day', durationMinutes: 1_440 })
  })
})

describe('native Grok billing metadata', () => {
  const period = { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-10-12T00:00:00Z', end: '2026-10-19T00:00:00Z' }
  it('preserves the live-tested missing percentage while retaining a real weekly reset', () => {
    const result = parseGrokQuota({ config: { currentPeriod: period, onDemandUsed: { val: 123 },
      prepaidBalance: { val: 456 }, isUnifiedBillingUser: true } }, observedAt)
    expect(result).toMatchObject({ providerId: 'grok', status: 'available', refreshable: true, windows: [{
      id: 'grok-weekly', label: 'Week', kind: 'weekly', durationMinutes: 10_080,
      resetsAt: '2026-10-19T00:00:00.000Z' }] })
    expect(result.windows[0]).not.toHaveProperty('usedPercent')
    expect(JSON.stringify(result)).not.toMatch(/onDemand|prepaid|Unified|123|456/u)
  })
  it('distinguishes present zero from absent and accepts an RPC result envelope', () => {
    expect(parseGrokQuota({ result: { config: { creditUsagePercent: 0, currentPeriod: period } } }, observedAt).windows[0]?.usedPercent).toBe(0)
    expect(parseGrokQuota({ config: { creditUsagePercent: 120, currentPeriod: period } }, observedAt).windows[0]?.usedPercent).toBe(120)
  })
  it('makes null or empty config unavailable without inventing a balance-derived allowance', () => {
    expect(parseGrokQuota({ config: null }, observedAt)).toMatchObject({ status: 'unavailable', reason: 'not-reported', windows: [] })
    expect(parseGrokQuota({ config: { onDemandUsed: {}, prepaidBalance: {} } }, observedAt).windows).toEqual([])
  })
  it('uses only verified legacy monthly Cent shapes and proto3 omitted zero', () => {
    const legacy = { monthlyLimit: { val: 2_000 }, used: { val: 500 }, billingPeriodEnd: '2026-11-01T00:00:00Z' }
    expect(parseGrokQuota({ config: legacy }, observedAt).windows[0]).toMatchObject({
      id: 'grok-monthly', label: 'Month', usedPercent: 25, resetsAt: '2026-11-01T00:00:00.000Z',
    })
    expect(parseGrokQuota({ config: { ...legacy, used: {} } }, observedAt).windows[0]?.usedPercent).toBe(0)
    expect(parseGrokQuota({ config: { ...legacy, monthlyLimit: {} } }, observedAt).windows[0]).not.toHaveProperty('usedPercent')
  })
  it('refuses mismatched periods, arbitrary money shapes and invalid declared percentage', () => {
    const base = { currentPeriod: period, monthlyLimit: { val: 2_000 }, used: { val: 500 } }
    expect(parseGrokQuota({ config: base }, observedAt).windows[0]).not.toHaveProperty('usedPercent')
    for (const amounts of [{ monthlyLimit: { amount: 100 }, used: { amount: 10 } },
      { monthlyLimit: { val: 100 }, used: { val: -10 } }, { monthlyLimit: { val: 100 }, used: { val: 0.5 } },
      { monthlyLimit: { val: 100 }, used: { currency: 'EUR' } }]) {
      expect(parseGrokQuota({ config: { ...amounts, billingPeriodEnd: '2026-11-01T00:00:00Z' } }, observedAt).windows[0])
        .not.toHaveProperty('usedPercent')
    }
    expect(parseGrokQuota({ config: { creditUsagePercent: Number.NaN, monthlyLimit: { val: 100 }, used: {} } }, observedAt).windows).toEqual([])
  })
  it('does not expose arbitrary period labels, rejects invalid dates and never returns native config', () => {
    const result = parseGrokQuota({ config: { creditUsagePercent: 1, currentPeriod: {
      type: 'Bearer secret-key', end: '2026-02-30T00:00:00Z' }, accountId: 'private-account',
      subscriptionTier: 'private-plan' } }, observedAt)
    expect(result.windows[0]).toMatchObject({ label: 'Allowance', kind: 'other', usedPercent: 1 })
    expect(result.windows[0]).not.toHaveProperty('resetsAt')
    expect(JSON.stringify(result)).not.toMatch(/Bearer|secret|private|config|account|subscription/u)
    expect(usageQuotaReadSchema.safeParse(result).success).toBe(true)
  })
  it('retains actual monthly duration and a reset for unknown future enum spellings without guessing a period', () => {
    const monthly = parseGrokQuota({ config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY',
      start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' } } }, observedAt)
    expect(monthly.windows[0]).toMatchObject({ id: 'grok-monthly', label: 'Month', durationMinutes: 44_640 })
    const unknown = parseGrokQuota({ config: { currentPeriod: { type: 'FUTURE_PERIOD_WEEKLY', end: period.end } } }, observedAt)
    expect(unknown.windows[0]).toMatchObject({ id: 'grok-allowance', label: 'Allowance', kind: 'other', resetsAt: '2026-10-19T00:00:00.000Z' })
    expect(unknown.windows[0]).not.toHaveProperty('durationMinutes')
  })
})

describe('quota read states and boundaries', () => {
  it('refuses a provider that reports no limits before building a quota result', () => {
    expect(() => unavailableProviderQuota('opencode', 'unsupported')).toThrow('Usage reads no limits for this provider.')
    expect(unavailableProviderQuota('muse', 'not-reported')).toMatchObject({ providerId: 'muse', status: 'unavailable', reason: 'not-reported' })
  })
  it('keeps unsupported, disconnected, refresh-unavailable and read-failed distinct from fresh zero', () => {
    expect(unavailableProviderQuota('devin', 'unsupported')).toMatchObject({ status: 'unavailable', reason: 'unsupported', windows: [], refreshable: false })
    expect(unavailableProviderQuota('grok', 'not-connected')).toMatchObject({ status: 'unavailable', reason: 'not-connected' })
    expect(unavailableProviderQuota('claude', 'refresh-unavailable')).toMatchObject({ status: 'unavailable', reason: 'refresh-unavailable' })
    expect(unavailableProviderQuota('codex', 'read-failed', true, observedAt)).toMatchObject({ status: 'error', reason: 'read-failed', refreshable: true, observedAt })
  })
  it('normalizes timezone offsets but never carries invalid observation strings into the public schema', () => {
    expect(parseCodexQuota({ rateLimits: codexBucket() }, '2026-10-12T11:00:00-07:00').observedAt).toBe(observedAt)
    expect(parseCodexQuota({ rateLimits: codexBucket() }, 'secret-key')).not.toHaveProperty('observedAt')
    expect(parseGrokQuota({ config: { currentPeriod: { end: '2026-10-12T11:00:00-07:00' } } }, observedAt).windows[0]?.resetsAt).toBe(observedAt)
  })
})

describe('Muse quota from MSP usage/read', () => {
  // The shape Muse Code 1.4.9 answered after one turn on October 21, 2026, with invented numbers and tier.
  const observedMs = Date.parse(observedAt)
  const answer = (patch: Record<string, unknown> = {}) => ({ usage: { observedAtMs: observedMs, tier: '1234567890',
    weekly: { resetsAtMs: observedMs + 3 * 86_400_000, usedPercent: 47 }, window: { resetsAtMs: observedMs + 3_600_000, usedPercent: 0, windowDurationMins: 300 }, ...patch } })
  it('maps the 5-hour window to primary and the weekly block to weekly, keeping a fresh zero and dropping the tier', () => {
    const result = parseMuseQuota(answer())!
    expect(usageQuotaReadSchema.parse(result)).toEqual(result)
    expect(result).toMatchObject({ providerId: 'muse', status: 'available', observedAt, refreshable: true, windows: [
      { id: 'muse-window', kind: 'primary', label: '5 hours', usedPercent: 0, durationMinutes: 300, resetsAt: '2026-10-12T19:00:00.000Z', observedAt },
      { id: 'muse-weekly', kind: 'weekly', label: 'Week', usedPercent: 47, durationMinutes: 10_080, resetsAt: '2026-10-15T18:00:00.000Z', observedAt },
    ] })
    expect(JSON.stringify(result)).not.toContain('1234567890')
    // usage/changed carries the same object as its params.
    expect(parseMuseQuota(answer().usage)).toEqual(result)
  })
  it('reads nothing observed, and anything it cannot read, as no reading', () => {
    expect(parseMuseQuota({})).toBeUndefined()
    expect(parseMuseQuota(null)).toBeUndefined()
    expect(parseMuseQuota({ usage: 'full' })).toBeUndefined()
    expect(parseMuseQuota({ usage: { observedAtMs: 'yesterday', window: { usedPercent: 3 } } })).toBeUndefined()
    // A block it cannot read is left out; the other stands.
    expect(parseMuseQuota(answer({ weekly: { usedPercent: -4, resetsAtMs: 'soon' } }))!.windows.map(window => window.id)).toEqual(['muse-window'])
    expect(parseMuseQuota(answer({ weekly: null, window: null }))).toMatchObject({ providerId: 'muse', status: 'unavailable', reason: 'not-reported', windows: [] })
  })
  it('keeps use past the allowance and leaves out a window that had already reset when Muse saw it', () => {
    const result = parseMuseQuota(answer({ window: { resetsAtMs: observedMs - 1, usedPercent: 100, windowDurationMins: 300 }, weekly: { resetsAtMs: observedMs + 1, usedPercent: 140 } }))!
    expect(result.windows).toMatchObject([{ id: 'muse-weekly', usedPercent: 140 }])
  })
})

describe('the reset of a used-up limit (ADR-0144)', () => {
  const read = (windows: object[]) => usageQuotaReadSchema.parse({ providerId: 'codex', status: 'available', windows, refreshable: true })
  const now = Date.parse(observedAt)
  it('is the latest reset among the windows at 100% or limited, still ahead', () => {
    expect(exhaustedQuotaReset(read([
      { id: 'a', label: '5 hours', kind: 'primary', usedPercent: 100, resetsAt: '2026-10-12T20:00:00.000Z' },
      { id: 'b', label: 'Week', kind: 'weekly', status: 'limited', resetsAt: '2026-10-14T00:00:00.000Z' },
      { id: 'c', label: 'Other', kind: 'other', usedPercent: 99, resetsAt: '2026-10-20T00:00:00.000Z' },
    ]), now)).toBe('2026-10-14T00:00:00.000Z')
  })
  it('is unknown when nothing is used up, a used-up window says no reset, or its reset has passed', () => {
    expect(exhaustedQuotaReset(read([{ id: 'a', label: '5 hours', kind: 'primary', usedPercent: 40, resetsAt: '2026-10-12T20:00:00.000Z' }]), now)).toBeUndefined()
    expect(exhaustedQuotaReset(read([{ id: 'a', label: '5 hours', kind: 'primary', usedPercent: 100 }]), now)).toBeUndefined()
    expect(exhaustedQuotaReset(read([{ id: 'a', label: '5 hours', kind: 'primary', usedPercent: 100, resetsAt: '2026-10-12T17:00:00.000Z' }]), now)).toBeUndefined()
    expect(exhaustedQuotaReset(undefined, now)).toBeUndefined()
  })
})
