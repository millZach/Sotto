import { describe, expect, it } from 'vitest'
import { providerIdSchema } from '../../../src/shared/agents'
import {
  USAGE_MODEL_ROWS_MAX, usageHostReadSchema, usageHourlyAggregateSchema, usageLocalHostReadSchema, usageLocalQuerySchema, usagePromptSubmissionSchema,
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
    expect(usageProviderIdSchema.options).toEqual(providerIdSchema.options)
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
