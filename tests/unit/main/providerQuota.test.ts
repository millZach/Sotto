// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  mergeClaudeQuota, parseClaudeQuota, parseCodexQuota, parseGrokQuota, unavailableProviderQuota,
} from '../../../src/main/agents/providerQuota'
import { usageQuotaReadSchema } from '../../../src/shared/usageDashboard'

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
      windows: [{ label: 'Codex primary window', kind: 'primary', usedPercent: 0,
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
    expect(result.windows[0]?.label).toBe('Codex limit primary window')
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
      label: 'Claude Opus weekly limit', durationMinutes: 10_080, status: 'limited' }] })
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
  it('keeps prior figures as stale evidence after an unavailable read', () => {
    const before = parseClaudeQuota(claudeEvent('five_hour', 0.2), observedAt)
    const merged = mergeClaudeQuota(before, unavailableProviderQuota('claude', 'refresh-unavailable', false, later))
    expect(merged).toMatchObject({ status: 'unavailable', reason: 'refresh-unavailable', observedAt,
      windows: [{ usedPercent: 20, observedAt }] })
  })
  it('normalizes optional extra-usage status without financial or failure-text scraping', () => {
    const result = parseClaudeQuota({ type: 'rate_limit_event', rate_limit_info: {
      rateLimitType: 'seven_day_sonnet', utilization: 0.4, status: 'allowed_warning',
      overageStatus: 'rejected', overageResetsAt: resetSeconds, overageDisabledReason: 'secret-key',
      account: { email: 'private@example.com' }, raw: { prompt: 'private prompt' } } }, observedAt)
    expect(result.windows.map(window => [window.id, window.status])).toEqual([
      ['claude-seven-day-sonnet', 'warning'], ['claude-overage', 'limited'],
    ])
    expect(result.windows[1]).not.toHaveProperty('usedPercent')
    expect(JSON.stringify(result)).not.toMatch(/secret|private|account|prompt|raw|overageDisabledReason/u)
  })
  it('ignores unknown types and non-events, rejects invalid utilization, and retains over-limit fractions', () => {
    expect(parseClaudeQuota(claudeEvent('__proto__', 0.5), observedAt).windows).toEqual([])
    expect(parseClaudeQuota({ type: 'result', rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.5 } }, observedAt).windows).toEqual([])
    expect(parseClaudeQuota(claudeEvent('five_hour', -0.1), observedAt).windows[0]).not.toHaveProperty('usedPercent')
    expect(parseClaudeQuota(claudeEvent('five_hour', Number.NaN), observedAt).windows[0]).not.toHaveProperty('usedPercent')
    expect(parseClaudeQuota(claudeEvent('five_hour', 1.1), observedAt).windows[0]?.usedPercent).toBeCloseTo(110)
  })
})

describe('native Grok billing metadata', () => {
  const period = { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-10-12T00:00:00Z', end: '2026-10-19T00:00:00Z' }
  it('preserves the live-tested missing percentage while retaining a real weekly reset', () => {
    const result = parseGrokQuota({ config: { currentPeriod: period, onDemandUsed: { val: 123 },
      prepaidBalance: { val: 456 }, isUnifiedBillingUser: true } }, observedAt)
    expect(result).toMatchObject({ providerId: 'grok', status: 'available', refreshable: true, windows: [{
      id: 'grok-weekly', label: 'Grok weekly allowance', kind: 'weekly', durationMinutes: 10_080,
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
      id: 'grok-monthly', label: 'Grok monthly allowance', usedPercent: 25, resetsAt: '2026-11-01T00:00:00.000Z',
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
    expect(result.windows[0]).toMatchObject({ label: 'Grok allowance', kind: 'other', usedPercent: 1 })
    expect(result.windows[0]).not.toHaveProperty('resetsAt')
    expect(JSON.stringify(result)).not.toMatch(/Bearer|secret|private|config|account|subscription/u)
    expect(usageQuotaReadSchema.safeParse(result).success).toBe(true)
  })
  it('retains actual monthly duration and a reset for unknown future enum spellings without guessing a period', () => {
    const monthly = parseGrokQuota({ config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY',
      start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' } } }, observedAt)
    expect(monthly.windows[0]).toMatchObject({ id: 'grok-monthly', label: 'Grok monthly allowance', durationMinutes: 44_640 })
    const unknown = parseGrokQuota({ config: { currentPeriod: { type: 'FUTURE_PERIOD_WEEKLY', end: period.end } } }, observedAt)
    expect(unknown.windows[0]).toMatchObject({ id: 'grok-allowance', label: 'Grok allowance', kind: 'other', resetsAt: '2026-10-19T00:00:00.000Z' })
    expect(unknown.windows[0]).not.toHaveProperty('durationMinutes')
  })
})

describe('quota read states and boundaries', () => {
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
