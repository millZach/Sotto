import { describe, expect, it } from 'vitest'
import { providerIdSchema } from '../../../src/shared/agents'
import {
  USAGE_CLIENT_ROWS_MAX, USAGE_CLIENTS, USAGE_LIMIT_PROVIDERS, USAGE_MODEL_ROWS_MAX, usageClientSchema, usageHistoryCursorSchema, usageHistoryPromptSchema, usageHistoryStatusSchema,
  usageHostReadSchema, usageHourlyAggregateSchema, usageLocalHostReadSchema, usageLocalQuerySchema, usageLocalReadSchema, usagePromptSubmissionSchema,
  usageProviderIdSchema, usageQuerySchema, usageQuotaReadSchema, usageTimeZoneSchema, usageTokenObservationSchema,
} from '../../../src/shared/usageDashboard'

const observation = {
  providerId: 'claude', threadId: 'sotto-thread', modelId: 'claude-sonnet', recordKey: 'a'.repeat(64),
  tokens: { input: 0, cached: 0 }, phase: 'seed', partial: true,
}

describe('usage dashboard boundaries', () => {
  it('accepts known zeros and keeps missing fields unknown without loading provider runtime code', () => {
    const parsed = usageTokenObservationSchema.parse(observation)
    expect(parsed.tokens).toEqual({ input: 0, cached: 0 })
    // Muse and OpenCode are counted in Sotto threads (October 21, 2026); OpenCode reports no account limits.
    expect(usageProviderIdSchema.options).toEqual(['codex', 'claude', 'grok', 'devin', 'muse', 'opencode'])
    expect(usageProviderIdSchema.options.every(id => providerIdSchema.options.includes(id))).toBe(true)
    for (const providerId of ['muse', 'opencode'] as const) {
      expect(usageTokenObservationSchema.safeParse({ ...observation, providerId }).success).toBe(true)
      expect(usageQuerySchema.safeParse({ providerIds: [providerId] }).success).toBe(true)
      expect(usagePromptSubmissionSchema.safeParse({ providerId, threadId: 'sotto-thread', messageId: 'message',
        modelId: `${providerId}-model`, at: '2026-10-12T12:00:00.000Z', kind: 'user', inputKind: 'send' }).success).toBe(true)
    }
    expect(USAGE_LIMIT_PROVIDERS).toEqual(['codex', 'claude', 'grok', 'devin', 'muse'])
    expect(usageQuotaReadSchema.safeParse({ providerId: 'muse', status: 'unavailable', windows: [], refreshable: false, reason: 'not-reported' }).success).toBe(true)
    expect(usageQuotaReadSchema.safeParse({ providerId: 'opencode', status: 'unavailable', windows: [], refreshable: false, reason: 'unsupported' }).success).toBe(false)
  })

  it.each([
    { text: 'private prompt' }, { title: 'private title' }, { nativeId: 'native-session' },
    { recordKey: 'raw-native-turn-id' }, { tokens: { input: -1 } },
    { tokens: { output: 1.5 } }, { tokens: { cached: Number.MAX_SAFE_INTEGER + 1 } },
    { tokens: { input: Number.MAX_SAFE_INTEGER, output: 1 } },
    { tokens: { input: 1, text: 'private reply' } }, { modelId: 'model\nprivate log' },
    { providerId: 'unknown' }, { at: 'today' }, { liveNewGroup: true },
  ])('rejects private payloads and invalid numeric/identity fields: %j', patch => {
    expect(usageTokenObservationSchema.safeParse({ ...observation, ...patch }).success).toBe(false)
  })

  it('separates the host-scoped query from the authenticated local request', () => {
    expect(usageQuerySchema.parse({ hostIds: ['computer-1'], from: '2026-10-01', to: '2026-10-12' }).hostIds).toEqual(['computer-1'])
    expect(usageLocalQuerySchema.safeParse({ hostIds: ['computer-1'] }).success).toBe(false)
    expect(usageLocalQuerySchema.safeParse({ from: '2026-02-30' }).success).toBe(false)
    expect(usageLocalQuerySchema.safeParse({ from: '2026-10-12', to: '2026-10-01' }).success).toBe(false)
    expect(usageLocalQuerySchema.safeParse({ modelIds: Array.from({ length: USAGE_MODEL_ROWS_MAX + 1 }, (_, index) => `model-${index}`) }).success).toBe(false)
  })

  it('validates requested IANA calendars and the qualified model ID bound', () => {
    expect(usageLocalQuerySchema.safeParse({ timeZone: 'America/Los_Angeles' }).success).toBe(true)
    expect(usageQuerySchema.safeParse({ hostIds: ['computer-1'], timeZone: 'Asia/Kolkata' }).success).toBe(true)
    expect(usageTimeZoneSchema.safeParse('UTC').success).toBe(true)
    expect(usageTimeZoneSchema.safeParse('America/Not_A_City').success).toBe(false)
    expect(usageTimeZoneSchema.safeParse('+08:00').success).toBe(false)
    const qualifiedModel = `codex:${'m'.repeat(6_138)}`
    expect(usageTokenObservationSchema.safeParse({ ...observation, modelId: qualifiedModel }).success).toBe(true)
    expect(usagePromptSubmissionSchema.safeParse({ providerId: 'codex', threadId: 'thread', messageId: 'message', modelId: qualifiedModel, at: '2026-10-12T00:00:00Z', kind: 'user', inputKind: 'send' }).success).toBe(true)
    expect(usageLocalQuerySchema.safeParse({ modelIds: [qualifiedModel] }).success).toBe(true)
    expect(usageTokenObservationSchema.safeParse({ ...observation, modelId: `${qualifiedModel}x` }).success).toBe(false)
  })

  it('keeps local/wire reads host-free and validates Monday-based hourly cells', () => {
    expect(usageLocalHostReadSchema.parse({ status: 'ready', quotas: [], persistence: 'saved' })).toEqual({ status: 'ready', quotas: [], persistence: 'saved' })
    expect(usageLocalHostReadSchema.safeParse({ hostId: 'computer-1', status: 'ready', quotas: [] }).success).toBe(false)
    expect(usageLocalHostReadSchema.safeParse({ status: 'offline', quotas: [] }).success).toBe(false)
    expect(usageHostReadSchema.safeParse({ hostId: 'computer-1', status: 'offline', quotas: [] }).success).toBe(true)
    const prompts = { user: 0, watcher: 0, wakeUp: 0, total: 0, steered: 0 }
    expect(usageHourlyAggregateSchema.safeParse({ weekday: 0, hour: 0, prompts }).success).toBe(true)
    expect(usageHourlyAggregateSchema.safeParse({ weekday: 7, hour: 0, prompts }).success).toBe(false)
    expect(usageHourlyAggregateSchema.safeParse({ weekday: 6, hour: 24, prompts }).success).toBe(false)
  })

  it('accepts exact prompt identities without prompt words or attachment digests', () => {
    const prompt = { providerId: 'codex', threadId: 'thread-1', messageId: 'message-1', modelId: 'gpt-5', at: '2026-10-12T00:00:00.000Z', kind: 'user', inputKind: 'steer' }
    expect(usagePromptSubmissionSchema.safeParse(prompt).success).toBe(true)
    expect(usagePromptSubmissionSchema.safeParse({ ...prompt, promptDigest: 'a'.repeat(64) }).success).toBe(false)
  })

  it('keeps where work ran and the app that sent it consistent on every token observation', () => {
    expect(usageTokenObservationSchema.safeParse(observation).success).toBe(true)
    expect(usageTokenObservationSchema.safeParse({ ...observation, source: 'sotto', client: 'sotto', subAgent: true, origin: 'adapter' }).success).toBe(true)
    expect(usageTokenObservationSchema.safeParse({ ...observation, source: 'outside', client: 'codex-exec' }).success).toBe(true)
    // Sotto work is the Sotto client; work outside Sotto names its own client.
    expect(usageTokenObservationSchema.safeParse({ ...observation, client: 'claude-code' }).success).toBe(false)
    expect(usageTokenObservationSchema.safeParse({ ...observation, source: 'outside' }).success).toBe(false)
    expect(usageTokenObservationSchema.safeParse({ ...observation, source: 'outside', client: 'sotto' }).success).toBe(false)
    expect(usageTokenObservationSchema.safeParse({ ...observation, source: 'outside', client: 'codex-unknown' }).success).toBe(false)
    // Imported history always carries the instant its provider recorded.
    expect(usageTokenObservationSchema.safeParse({ ...observation, origin: 'history' }).success).toBe(false)
    expect(usageTokenObservationSchema.safeParse({ ...observation, origin: 'history', at: '2026-10-12T00:00:00Z' }).success).toBe(true)
    expect(usageClientSchema.options).toEqual(USAGE_CLIENTS)
  })

  it('accepts imported prompts, cursors and history status as numbers and identities alone', () => {
    const prompt = { providerId: 'codex', threadId: 'session-hash', messageId: 'turn-1', modelId: 'gpt-6-astra', at: '2026-10-12T00:00:00.000Z',
      kind: 'user', source: 'outside', client: 'codex-exec' }
    expect(usageHistoryPromptSchema.safeParse(prompt).success).toBe(true)
    expect(usageHistoryPromptSchema.safeParse({ ...prompt, client: 'sotto' }).success).toBe(false)
    expect(usageHistoryPromptSchema.safeParse({ ...prompt, source: 'sotto' }).success).toBe(false)
    expect(usageHistoryPromptSchema.safeParse({ ...prompt, source: 'sotto', client: 'sotto' }).success).toBe(true)
    expect(usageHistoryPromptSchema.safeParse({ ...prompt, text: 'private prompt' }).success).toBe(false)
    expect(usageHistoryPromptSchema.safeParse({ ...prompt, inputKind: 'steer' }).success).toBe(false)
    expect(usageHistoryCursorSchema.safeParse({ size: 10, mtimeMs: 20, offset: 10 }).success).toBe(true)
    expect(usageHistoryCursorSchema.safeParse({ size: 10, mtimeMs: 20, offset: -1 }).success).toBe(false)
    expect(usageHistoryCursorSchema.safeParse({ size: 10, mtimeMs: 20, offset: 1, path: 'C:\\x' }).success).toBe(false)
    expect(usageHistoryCursorSchema.safeParse({ size: 1, mtimeMs: 1, offset: 1, state: 'x'.repeat(65_537) }).success).toBe(false)
    expect(usageHistoryStatusSchema.safeParse({ status: 'complete', earliestAt: '2026-04-21T00:00:00Z' }).success).toBe(true)
    expect(usageHistoryStatusSchema.safeParse({ status: 'finished' }).success).toBe(false)
  })

  it('bounds the new query filters and keeps every new read field optional for older hosts', () => {
    expect(usageLocalQuerySchema.safeParse({ sources: ['sotto', 'outside'], since: '2026-10-12T05:00:00-07:00' }).success).toBe(true)
    expect(usageLocalQuerySchema.safeParse({ sources: ['sotto', 'outside', 'sotto'] }).success).toBe(false)
    expect(usageLocalQuerySchema.safeParse({ sources: ['remote'] }).success).toBe(false)
    expect(usageLocalQuerySchema.safeParse({ since: '2026-10-12' }).success).toBe(false)
    expect(usageQuerySchema.safeParse({ hostIds: ['computer-1'], sources: ['outside'], since: '2026-10-12T00:00:00Z' }).success).toBe(true)
    const prompts = { user: 0, watcher: 0, wakeUp: 0, total: 0, steered: 0 }
    const field = { knownRows: 0, rows: 0, partial: false }
    const empty = { tokens: Object.fromEntries(['input', 'output', 'cached', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'total'].map(name => [name, field])),
      prompts, tokenRecords: 0, partialTokenRecords: 0, undatedTokenRecords: 0, activeThreads: 0, activeDays: 0 }
    const read = { metadata: { startedAt: '2026-10-12T00:00:00.000Z', revision: 0, generation: 0, legacySeedCompleted: false },
      totals: empty, timeZone: 'UTC', providers: [], models: [], modelCount: 0, modelsTruncated: false, daily: [], dailyCoverage: 'complete', hourly: [] }
    expect(usageLocalReadSchema.safeParse(read).success).toBe(true)
    expect(usageLocalReadSchema.safeParse({ ...read, totals: { ...empty, lastDay: '2026-10-12' },
      clients: [{ ...empty, source: 'outside', clientId: 'claude-code', subAgent: true }],
      metadata: { ...read.metadata, history: { status: 'scanning' } } }).success).toBe(true)
    expect(usageLocalReadSchema.safeParse({ ...read, clients: Array.from({ length: USAGE_CLIENT_ROWS_MAX + 1 }, () => ({ ...empty, source: 'sotto', clientId: 'sotto', subAgent: false })) }).success).toBe(false)
    expect(usageLocalReadSchema.safeParse({ ...read, totals: { ...empty, lastDay: '2026-02-30' } }).success).toBe(false)
  })

  it('preserves native unknown percentage, known zero and over-limit allowance independently of tokens', () => {
    const quota = usageQuotaReadSchema.parse({
      providerId: 'grok', status: 'available', observedAt: '2026-10-12T00:00:00.000Z', refreshable: true,
      windows: [
        { id: 'session', label: 'Session', kind: 'primary', resetsAt: '2026-10-12T05:00:00.000Z' },
        { id: 'week', label: 'Week', kind: 'weekly', usedPercent: 0 },
        { id: 'overage', label: 'Other', kind: 'other', usedPercent: 112 },
      ],
    })
    expect(quota.windows.map(window => window.usedPercent)).toEqual([undefined, 0, 112])
    expect(usageQuotaReadSchema.safeParse({ ...quota, email: 'private@example.com' }).success).toBe(false)
    expect(usageQuotaReadSchema.safeParse({ ...quota, windows: [...quota.windows, ...quota.windows, ...quota.windows] }).success).toBe(false)
  })
})
