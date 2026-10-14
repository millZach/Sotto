import { describe, expect, it } from 'vitest'
import {
  fmtTok, formatField, limitsMissing, longDay, pct, presentUsage, providerLimits, rangeBounds, rangeLabel, readAge, relativeDay, resetLong, resetShort, scopeHost, sentFrom,
  nounFor, sumFields, tokenParts, usagePlaces, windowView,
} from '../../../src/renderer/src/features/usage/usagePresentation'
import { servedModelName } from '../../../src/shared/modelCatalog'
import { USAGE_NOW, USAGE_ZONE, dashboard, forgeHost, localHost, oldForgeHost } from '../../fixtures/renderer/usageReads'

const now = USAGE_NOW.getTime()

describe('Usage numbers in words', () => {
  it('writes tokens in B, M and K and small shares as under 1%', () => {
    expect([999, 3_600, 12_400, 999_400, 999_600, 12_340_000, 123_400_000, 1_234_000_000, 57_189_988_615, 123_456_000_000].map(fmtTok))
      .toEqual(['999', '3,600', '12K', '999K', '1.0M', '12.3M', '123M', '1.2B', '57.2B', '123B'])
    expect([0, 0.004, 0.005, 0.794].map(pct)).toEqual(['0%', 'under 1%', '1%', '79%'])
    expect([0, 1, 2].map(count => `${count} ${nounFor(count, 'prompt')}`)).toEqual(['0 prompts', '1 prompt', '2 prompts'])
  })
  it('keeps a known zero and marks a lower bound when another computer left a field out', () => {
    const combined = sumFields([{ value: 0, knownRows: 1, rows: 1, partial: false }, { knownRows: 0, rows: 2, partial: true }])
    expect(combined).toEqual({ value: 0, knownRows: 1, rows: 3, partial: true })
    expect(formatField(combined)).toBe('≥ 0')
    expect(formatField({ knownRows: 0, rows: 0, partial: false })).toBe('—')
  })
  it('joins one model reported by an older host and an updated host into one row', () => {
    // An older host names models by their public ID; an updated host by the canonical served ID.
    const updated = localHost(); const older = oldForgeHost()
    older.activity = { ...older.activity!, models: [{ ...older.activity!.models[0]!, providerId: 'claude', modelId: 'native:claude:model:claude-opus-5-5' }] }
    const rows = presentUsage(dashboard(updated, older)).models.filter(row => row.providerId === 'claude' && row.modelId === 'claude-opus-5-5')
    expect(rows).toHaveLength(1)
    expect(presentUsage(dashboard(updated, older)).models.some(row => row.modelId.startsWith('native:'))).toBe(false)
  })

  it('keeps the incomplete tokens of a place as a lower bound, and uncached input unknown while cache writes are', () => {
    const places = usagePlaces([{ ...localHost().activity!.clients![0]!, tokens: { ...localHost().activity!.clients![0]!.tokens, total: { value: 500, knownRows: 1, rows: 2, partial: true } } }])
    expect(places[0]!.tokenField).toMatchObject({ value: 500, partial: true })
    const parts = tokenParts({ ...localHost().activity!.totals.tokens, cacheWrite: { knownRows: 0, rows: 4, partial: true } })
    expect(parts.uncached.known).toBe(false)
    expect(tokenParts(localHost().activity!.totals.tokens).uncached).toMatchObject({ known: true, value: 41_000_000 - 36_000_000 - 900_000 })
  })
  it('names every served model in words the same way on every computer, never as an ID', () => {
    // A client catalog names some Claude models with "Claude" and some without, and differs between versions, so Usage
    // names a row from its served model alone.
    expect(servedModelName('claude', 'claude-sonnet-5-5')).toBe('Claude Sonnet 5.5')
    expect(servedModelName('claude', 'claude-opus-5')).toBe('Claude Opus 5')
    expect(servedModelName('claude', 'claude-haiku-4-5')).toBe('Claude Haiku 4.5')
    expect(servedModelName('codex', 'gpt-6.1-sol')).toBe('GPT-6.1 Sol')
    expect(servedModelName('codex', 'codex-auto-review')).toBe('Codex auto review')
    expect(servedModelName('claude', 'unknown')).toBe('Model not reported')
  })
  it('writes dates and resets in plain words in the chosen time zone', () => {
    expect(longDay('2026-10-14', '2026-10-14')).toBe('Wednesday, October 14, so far')
    expect(relativeDay('2026-10-13', '2026-10-14')).toBe('Yesterday')
    expect(relativeDay('2026-10-09', '2026-10-14')).toBe('Oct 9')
    expect(rangeLabel('2026-09-15', '2026-10-14', undefined)).toBe('Sep 15 – Oct 14')
    expect(rangeLabel(undefined, undefined, '2026-04-21')).toBe('Since Apr 21')
    expect(rangeLabel(undefined, undefined, undefined)).toBe('All time')
    expect(resetLong(Date.parse('2026-10-14T20:00:00Z'), now, USAGE_ZONE)).toBe('today 1:00 PM, in 2 h 20 min')
    expect(resetLong(Date.parse('2026-10-20T04:58:00Z'), now, USAGE_ZONE)).toBe('Monday, Oct 19, 9:58 PM, in 5 days')
    expect(resetLong(Date.parse('2026-10-15T09:00:00Z'), now, USAGE_ZONE)).toBe('Thursday, Oct 15, 2:00 AM, in 15 h 20 min')
    expect(resetShort(Date.parse('2026-10-14T20:00:00Z'), now, USAGE_ZONE)).toBe('1:00 PM')
    expect(resetShort(Date.parse('2026-10-16T20:00:00Z'), now, USAGE_ZONE)).toBe('Fri')
    expect(resetShort(Date.parse('2026-10-21T13:00:00Z'), now, USAGE_ZONE)).toBe('Oct 21')
    expect([0, 0.5, 4, 90, 60 * 30].map(minutes => readAge(now - minutes * 60_000, now))).toEqual(['Read just now', 'Read just now', 'Read 4 min ago', 'Read 1 h ago', 'Read 1 day ago'])
  })
  it('counts calendar days across midnight and daylight saving', () => {
    expect(rangeBounds(7, new Date('2026-10-12T01:00:00Z'), USAGE_ZONE)).toEqual({ from: '2026-10-05', to: '2026-10-11' })
    expect(rangeBounds(7, new Date('2026-03-09T06:00:00Z'), USAGE_ZONE)).toEqual({ from: '2026-03-02', to: '2026-03-08' })
  })
})

describe('Usage across computers', () => {
  it('joins each served model into one row across computers', () => {
    const summary = presentUsage(dashboard(localHost(), forgeHost()))
    const sol = summary.models.filter(row => row.modelId === 'gpt-6.1-sol')
    expect(sol).toHaveLength(1)
    expect(sol[0]!.prompts.total).toBe(70)
    expect(summary.totals.prompts.total).toBe(220)
    expect(summary.daily.find(row => row.day === '2026-10-13')!.prompts.total).toBe(80)
  })
  it('splits the work by place and by the app that sent it', () => {
    const summary = presentUsage(dashboard())
    expect(summary.sottoTokens).toBe(30_000_000)
    expect(summary.subAgentTokens).toBe(22_000_000)
    expect(usagePlaces(summary.clients).map(place => [place.name, place.prompts, place.tokens, place.subAgentTokens, place.provider ?? null])).toEqual([
      ["Sotto's subagents", 0, 20_000_000, 20_000_000, null],
      ['Sotto threads', 130, 10_000_000, 0, null],
      ['Claude Code', 40, 8_000_000, 2_000_000, 'claude'],
      ['codex exec', 30, 4_000_000, 0, 'codex'],
    ])
    expect(sentFrom(summary.clients)).toEqual([{ clientId: 'sotto', prompts: 130 }, { clientId: 'claude-code', prompts: 40 }, { clientId: 'codex-exec', prompts: 30 }])
  })
  it("reads a host from before history as Sotto threads only, and as nothing outside Sotto", () => {
    const old = oldForgeHost()
    const summary = presentUsage(dashboard(localHost(), old))
    expect(summary.withoutPlaces).toEqual(['forge'])
    expect(summary.sottoTokens).toBe(36_000_000)
    expect(scopeHost(old, ['outside']).activity!.totals.prompts.total).toBe(0)
    expect(scopeHost(old, ['sotto']).activity!.totals.prompts.total).toBe(30)
    expect(scopeHost(localHost(), ['outside']).activity!.totals.prompts.total).toBe(200)
  })
})

describe('Usage limits', () => {
  it('names windows by their length and says how much of their time is left', () => {
    const week = windowView({ id: 'weekly', kind: 'weekly', label: 'Weekly', usedPercent: 45, resetsAt: '2026-10-20T04:58:00Z', durationMinutes: 10_080 }, 'codex', now)
    expect([week.label, week.noun, week.left, Math.round(week.timeLeft!)]).toEqual(['Week', 'weekly window', 55, 78])
    expect(windowView({ id: 'session', kind: 'primary', label: 'Current session', usedPercent: 10, durationMinutes: 300 }, 'claude', now).label).toBe('5 hours')
    expect(windowView({ id: 'opus', kind: 'model', label: 'Opus week', durationMinutes: 10_080, modelId: 'claude-opus-5-5' }, 'claude', now).label).toBe('Week for Claude Opus 5.5')
    // A host's own qualified name says more than the length alone, and an older host's "Weekly" reads as its length.
    expect(windowView({ id: 'sonnet', kind: 'model', label: 'Sonnet, week', durationMinutes: 10_080 }, 'claude', now).label).toBe('Sonnet, week')
    expect(windowView({ id: 'extra', kind: 'weekly', label: 'Week, with extra usage', durationMinutes: 10_080 }, 'claude', now).label).toBe('Week, with extra usage')
    expect(windowView({ id: 'weekly', kind: 'weekly', label: 'Weekly' }, 'grok', now).label).toBe('Week')
  })
  it('shows the freshest reading for each provider with the others beside it, never added', () => {
    const forge = forgeHost()
    forge.quotas[0]!.observedAt = new Date(now + 60_000).toISOString()
    const limits = providerLimits(dashboard(localHost(), forge), now)
    expect(limits.map(item => item.providerId)).toEqual(['codex', 'claude', 'grok', 'devin'])
    const codex = limits[0]!
    expect(codex.primary.hostId).toBe('forge')
    expect(codex.primary.tightest!.left).toBe(56)
    expect(codex.others.map(item => [item.hostId, item.tightest!.left])).toEqual([['laptop', 55]])
  })
  it('drops a window whose reset has passed', () => {
    const host = localHost()
    host.quotas[1]!.windows[0]!.resetsAt = '2026-10-14T16:00:00Z'
    const claude = providerLimits(dashboard(host), now).find(item => item.providerId === 'claude')!
    expect(claude.primary.windows.map(window => window.label)).toEqual(['Week'])
    expect(claude.primary.expired).toBe(1)
    expect(claude.primary.tightest!.left).toBe(94)
  })
  it('says why limits are missing with this computer in lower case mid-sentence', () => {
    const host = localHost()
    host.quotas[2] = { providerId: 'grok', status: 'unavailable', refreshable: false, reason: 'not-connected', windows: [] }
    const grok = providerLimits(dashboard(host), now).find(item => item.providerId === 'grok')!
    const name = (hostId: string): string => hostId === 'laptop' ? 'This computer' : hostId
    expect(limitsMissing(grok, name, now, USAGE_ZONE)).toBe("Grok Build isn't connected on this computer.")
    expect(limitsMissing({ ...grok, primary: { ...grok.primary, hostId: 'forge' } }, name, now, USAGE_ZONE)).toBe("Grok Build isn't connected on forge.")
  })
})
