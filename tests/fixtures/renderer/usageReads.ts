// Invented Usage reads for the renderer tests and the Usage capture page: numbers only, no real figures.
import { USAGE_TOKEN_FIELDS, type UsageActivityAggregate, type UsageBridge, type UsageClientAggregate, type UsageDailyAggregate, type UsageDashboardRead, type UsageFieldTotal, type UsageHostRead, type UsageLocalRead, type UsageModelAggregate, type UsageProviderAggregate, type UsageProviderId, type UsageQuery, type UsageQuotaRead, type UsageTokenTotals } from '../../../src/shared/usageDashboard'
import { sumActivity } from '../../../src/renderer/src/features/usage/usagePresentation'

/** 10:40 AM on Wednesday, October 14, 2026 in Los Angeles. */
export const USAGE_NOW = new Date('2026-10-14T17:40:00Z')
export const USAGE_ZONE = 'America/Los_Angeles'
const at = (minutesAgo: number): string => new Date(USAGE_NOW.getTime() - minutesAgo * 60_000).toISOString()

export const field = (value?: number, partial = false): UsageFieldTotal => value === undefined ? { knownRows: 0, rows: 1, partial } : { value, knownRows: 1, rows: 1, partial }
export function tokens(input?: number, output?: number, cached?: number, write?: number): UsageTokenTotals {
  const none = Object.fromEntries(USAGE_TOKEN_FIELDS.map(name => [name, { knownRows: 0, rows: 0, partial: false }])) as UsageTokenTotals
  if (input === undefined && output === undefined) return none
  return { ...none, input: field(input), output: field(output), cached: field(cached), cacheWrite: field(write), total: field(input === undefined || output === undefined ? undefined : input + output) }
}
export function activityRow(user: number, wakeUp: number, watcher: number, totals: UsageTokenTotals, extra: Partial<UsageActivityAggregate> = {}): UsageActivityAggregate {
  return { tokens: totals, prompts: { user, watcher, wakeUp, total: user + watcher + wakeUp, steered: 0 }, tokenRecords: totals.total.value === undefined ? 0 : 10, partialTokenRecords: 0, undatedTokenRecords: 0, activeThreads: 4, activeDays: 3, ...extra }
}
const client = (source: 'sotto' | 'outside', clientId: UsageClientAggregate['clientId'], subAgent: boolean, row: UsageActivityAggregate): UsageClientAggregate => ({ ...row, source, clientId, subAgent })

/** This computer: Sotto threads, their subagents, Claude Code itself and codex exec runs over the last week. */
export function localActivity(revision = 7): UsageLocalRead {
  const totals = activityRow(190, 10, 0, tokens(41_000_000, 1_000_000, 36_000_000, 900_000), { lastDay: '2026-10-14', activeThreads: 12 })
  return {
    metadata: { startedAt: '2026-04-21T00:00:00Z', revision, generation: 0, legacySeedCompleted: true, history: { status: 'complete', earliestAt: '2026-04-21T00:00:00Z', scannedAt: at(5) } },
    totals, timeZone: USAGE_ZONE,
    providers: [
      { ...activityRow(140, 10, 0, tokens(29_400_000, 600_000, 27_000_000, 900_000)), providerId: 'claude' },
      { ...activityRow(50, 0, 0, tokens(11_600_000, 400_000, 9_000_000)), providerId: 'codex' },
    ],
    models: [
      { ...activityRow(130, 10, 0, tokens(27_500_000, 500_000, 26_000_000, 800_000), { lastDay: '2026-10-14', activeThreads: 9 }), providerId: 'claude', modelId: 'claude-opus-5-5' },
      { ...activityRow(50, 0, 0, { ...tokens(11_600_000, 400_000, 9_000_000), cacheWrite: { knownRows: 0, rows: 4, partial: false } }, { lastDay: '2026-10-13' }), providerId: 'codex', modelId: 'gpt-6.1-sol' },
      { ...activityRow(10, 0, 0, tokens()), providerId: 'claude', modelId: 'unknown' },
      { ...activityRow(0, 0, 0, tokens(1_900_000, 100_000, 1_000_000, 100_000), { lastDay: '2026-10-09' }), providerId: 'claude', modelId: 'claude-haiku-4-5' },
    ],
    modelCount: 4, modelsTruncated: false,
    daily: [
      { ...activityRow(75, 5, 0, tokens(15_000_000, 400_000, 13_000_000, 300_000)), day: '2026-10-09' },
      { ...activityRow(55, 5, 0, tokens(12_000_000, 300_000, 10_000_000, 300_000)), day: '2026-10-13' },
      { ...activityRow(60, 0, 0, tokens(14_000_000, 300_000, 13_000_000, 300_000)), day: '2026-10-14' },
    ],
    dailyCoverage: 'complete',
    hourly: [{ weekday: 2, hour: 10, prompts: { user: 50, watcher: 0, wakeUp: 0, total: 50, steered: 0 } }, { weekday: 0, hour: 9, prompts: { user: 20, watcher: 0, wakeUp: 2, total: 22, steered: 0 } }],
    clients: [
      client('sotto', 'sotto', false, activityRow(120, 10, 0, tokens(9_500_000, 500_000, 8_000_000, 400_000))),
      client('sotto', 'sotto', true, activityRow(0, 0, 0, tokens(19_800_000, 200_000, 18_000_000, 300_000))),
      client('outside', 'claude-code', false, activityRow(40, 0, 0, tokens(5_900_000, 100_000, 5_000_000, 200_000))),
      client('outside', 'claude-code', true, activityRow(0, 0, 0, tokens(1_950_000, 50_000, 1_500_000))),
      client('outside', 'codex-exec', false, activityRow(30, 0, 0, tokens(3_850_000, 150_000, 3_500_000))),
    ],
  }
}

export function localQuotas(): UsageQuotaRead[] {
  return [
    { providerId: 'codex', status: 'available', refreshable: true, observedAt: at(0), windows: [{ id: 'weekly', kind: 'weekly', label: 'Weekly', usedPercent: 45, resetsAt: '2026-10-20T04:58:00Z', durationMinutes: 10_080 }] },
    { providerId: 'claude', status: 'available', refreshable: true, observedAt: at(0), windows: [
      { id: 'five-hour', kind: 'primary', label: 'Current session', usedPercent: 45, resetsAt: '2026-10-14T20:00:00Z', durationMinutes: 300 },
      { id: 'seven-day', kind: 'weekly', label: 'Current week', usedPercent: 6, resetsAt: '2026-10-21T13:00:00Z', durationMinutes: 10_080 },
    ] },
    { providerId: 'grok', status: 'available', refreshable: true, observedAt: at(0), windows: [{ id: 'weekly', kind: 'weekly', label: 'Weekly', resetsAt: '2026-10-14T20:12:00Z', durationMinutes: 10_080 }] },
    { providerId: 'devin', status: 'unavailable', refreshable: false, reason: 'unsupported', windows: [] },
  ]
}

export const localHost = (): UsageHostRead => ({ hostId: 'laptop', status: 'ready', activity: localActivity(), quotas: localQuotas(), persistence: 'saved' })

/** forge on the new Owl host: a little Codex work and its own Codex reading, four minutes old. */
export function forgeHost(): UsageHostRead {
  const totals = activityRow(20, 0, 0, tokens(2_900_000, 100_000, 2_500_000))
  return { hostId: 'forge', status: 'ready', persistence: 'saved', activity: {
    metadata: { startedAt: '2026-09-01T00:00:00Z', revision: 3, generation: 0, legacySeedCompleted: true, history: { status: 'complete' } },
    totals, timeZone: USAGE_ZONE, providers: [{ ...totals, providerId: 'codex' }], models: [{ ...totals, providerId: 'codex', modelId: 'gpt-6.1-sol' }], modelCount: 1, modelsTruncated: false,
    daily: [{ ...totals, day: '2026-10-13' }], dailyCoverage: 'complete', hourly: [],
    clients: [client('sotto', 'sotto', false, activityRow(20, 0, 0, tokens(2_900_000, 100_000, 2_500_000)))],
  }, quotas: [
    { providerId: 'codex', status: 'available', refreshable: true, observedAt: at(4), windows: [{ id: 'weekly', kind: 'weekly', label: 'Weekly', usedPercent: 44, resetsAt: '2026-10-20T04:58:00Z', durationMinutes: 10_080 }] },
    { providerId: 'devin', status: 'unavailable', refreshable: false, reason: 'unsupported', windows: [] },
  ] }
}

/** forge before its host update: Sotto threads only, no place split, no history status. */
export function oldForgeHost(): UsageHostRead {
  const totals = activityRow(30, 0, 0, tokens(5_800_000, 200_000, 5_000_000))
  return { hostId: 'forge', status: 'ready', persistence: 'saved', activity: {
    metadata: { startedAt: '2026-09-01T00:00:00Z', revision: 3, generation: 0, legacySeedCompleted: true },
    totals, timeZone: USAGE_ZONE, providers: [{ ...totals, providerId: 'claude' }], models: [{ ...totals, providerId: 'claude', modelId: 'claude-opus-5-5' }], modelCount: 1, modelsTruncated: false,
    daily: [{ ...totals, day: '2026-10-12' }], dailyCoverage: 'complete', hourly: [],
  }, quotas: [] }
}

export const dashboard = (...hosts: UsageHostRead[]): UsageDashboardRead => ({ hosts: hosts.length === 0 ? [localHost()] : hosts })

/** What this computer did since a window began: a smaller slice of the same work. */
export function sinceActivity(): UsageLocalRead {
  const base = localActivity()
  return { ...base, totals: activityRow(12, 0, 0, tokens(2_900_000, 100_000, 2_500_000)), clients: [client('sotto', 'sotto', false, activityRow(8, 0, 0, tokens(1_950_000, 50_000, 1_500_000)))], daily: [], hourly: [], models: [], providers: [] }
}

/** A bridge that answers each computer on its own, as the router does, and a `since` or `modelIds` read with its slice. */
export function fixtureBridge(read: UsageDashboardRead): UsageBridge & { readonly reads: UsageQuery[] } {
  const reads: UsageQuery[] = []
  const pick = (query: { hostIds?: string[] | undefined }): UsageHostRead[] => query.hostIds === undefined ? read.hosts : read.hosts.filter(host => query.hostIds!.includes(host.hostId))
  return {
    reads,
    read: async query => {
      reads.push(query)
      const hosts = pick(query)
      if (query.since !== undefined) return { hosts: hosts.map(host => host.activity === undefined ? host : { ...host, activity: sinceActivity() }) }
      if (query.modelIds !== undefined) {
        return { hosts: hosts.map(host => host.activity === undefined ? host : { ...host, activity: { ...host.activity, daily: host.activity.daily.map(row => ({ ...row, prompts: { ...row.prompts, total: Math.round(row.prompts.total / 2) } })) } }) }
      }
      return { hosts }
    },
    refresh: async query => ({ hosts: pick(query) }),
    clear: async query => query.hosts.map(host => ({ hostId: host.hostId, status: 'cleared' as const })),
  }
}

/** One model's prompts on each of the last seven days, October 8 to 14, and its tokens per prompt (none for Devin). */
const SPLIT_MODELS: ReadonlyArray<readonly [UsageProviderId, string, readonly number[], number | undefined]> = [
  ['claude', 'claude-opus-5-5', [10, 12, 8, 0, 9, 11, 6], 200_000],
  ['codex', 'gpt-6.1-sol', [5, 6, 4, 0, 5, 7, 3], 150_000],
  ['claude', 'claude-sonnet-5-5', [3, 4, 2, 0, 3, 2, 1], 100_000],
  ['grok', 'grok-code-2', [2, 0, 1, 0, 2, 1, 1], 80_000],
  ['codex', 'gpt-6-mini', [1, 1, 1, 0, 1, 1, 0], 40_000],
  ['claude', 'claude-haiku-4-5', [0, 1, 0, 0, 1, 0, 1], 3_000_000],
  ['devin', 'swe-1', [1, 0, 0, 0, 0, 1, 0], undefined],
]
const SPLIT_DAYS = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']
/** A day on which one model's records left its tokens out: all of them, or some, so its figure is a lower bound. */
export interface TokenGap { readonly modelId: string; readonly day: string; readonly kind: 'unreported' | 'partial' }
function splitDaily(rows: typeof SPLIT_MODELS, gaps: readonly TokenGap[] = []): UsageDailyAggregate[] {
  return SPLIT_DAYS.map((day, index) => ({ ...sumActivity(rows.map(([, modelId, prompts, perPrompt]) => {
    const count = prompts[index]!
    const gap = gaps.find(item => item.modelId === modelId && item.day === day)?.kind
    if (perPrompt === undefined || count === 0 || gap === undefined) return activityRow(count, 0, 0, perPrompt === undefined ? tokens() : tokens(count * perPrompt, count * perPrompt / 100))
    if (gap === 'unreported') return activityRow(count, 0, 0, { ...tokens(), input: field(), output: field(), cached: field(), cacheWrite: field(), total: field() }, { tokenRecords: 1 })
    // Two records, one of them without its counts: what was reported is a lower bound.
    const some = (value: number): UsageFieldTotal => ({ value, knownRows: 1, rows: 2, partial: true })
    return activityRow(count, 0, 0, { ...tokens(), input: some(count * perPrompt), output: some(count * perPrompt / 100), total: some(count * perPrompt * 1.01) }, { tokenRecords: 2, partialTokenRecords: 1 })
  })), day }))
}

/** This computer with seven models across four providers, so the Per day chart can be split by provider and by model. */
export function splitHost(gaps: readonly TokenGap[] = []): UsageHostRead {
  const daily = splitDaily(SPLIT_MODELS, gaps)
  const totals = sumActivity(daily)
  const models: UsageModelAggregate[] = SPLIT_MODELS.map(row => ({ ...sumActivity(splitDaily([row], gaps)), providerId: row[0], modelId: row[1] }))
  const providers: UsageProviderAggregate[] = [...new Set(SPLIT_MODELS.map(row => row[0]))].map(providerId => ({ ...sumActivity(splitDaily(SPLIT_MODELS.filter(row => row[0] === providerId), gaps)), providerId }))
  return { hostId: 'laptop', status: 'ready', persistence: 'saved', quotas: [], activity: {
    metadata: { startedAt: '2026-04-21T00:00:00Z', revision: 9, generation: 0, legacySeedCompleted: true, history: { status: 'complete' } },
    totals, timeZone: USAGE_ZONE, providers, models, modelCount: models.length, modelsTruncated: false, daily, dailyCoverage: 'complete', hourly: [],
    clients: [client('sotto', 'sotto', false, totals)],
  } }
}

/**
 * A bridge for `splitHost`: a read filtered by provider or model answers with only those models' days. `filtered`
 * runs before each filtered answer, so a test can hold or fail it.
 */
export function splitBridge(filtered: (query: UsageQuery) => Promise<void> = async () => undefined, gaps: readonly TokenGap[] = []): UsageBridge & { readonly reads: UsageQuery[] } {
  const reads: UsageQuery[] = []
  return {
    reads,
    read: async query => {
      reads.push(query)
      const host = splitHost(gaps)
      if (query.providerIds === undefined && query.modelIds === undefined) return { hosts: [host] }
      await filtered(query)
      const rows = SPLIT_MODELS.filter(([providerId, modelId]) => (query.providerIds?.includes(providerId) ?? true)
        && (query.modelIds === undefined || query.modelIds.some(id => id === modelId || id.endsWith(`:model:${modelId}`))))
      return { hosts: [{ ...host, activity: { ...host.activity!, daily: splitDaily(rows, gaps) } }] }
    },
    refresh: async () => ({ hosts: [splitHost(gaps)] }),
    clear: async query => query.hosts.map(item => ({ hostId: item.hostId, status: 'cleared' as const })),
  }
}
