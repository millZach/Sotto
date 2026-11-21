// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { antigravityFolders } from '../../../src/main/agents/antigravityFolders'
import { ANTIGRAVITY_QUOTA_HOSTS, ANTIGRAVITY_TOKEN_HOST, AntigravityQuotaReader } from '../../../src/main/agents/antigravityQuota'
import { antigravityUsageHooks } from '../../../src/main/agents/antigravityUsage'
import { parseAntigravityModels, parseAntigravityQuota } from '../../../src/main/agents/providerQuota'
import { usageQuotaReadSchema, usageReadBeforeAntigravity, type UsageLocalHostRead } from '../../../src/shared/usageDashboard'

const NOW = Date.parse('2026-11-20T12:00:00.000Z')
const observedAt = new Date(NOW).toISOString()
const hours = (n: number): string => new Date(NOW + n * 3_600_000).toISOString()
const summary = {
  groups: [
    { displayName: 'Gemini Models', buckets: [
      { bucketId: 'gemini-default-5h', window: '5h', remainingFraction: 0.75, resetTime: hours(2), description: 'used' },
      { bucketId: 'gemini-default-weekly', window: 'weekly', remainingFraction: 0.4, resetTime: hours(72) },
      { bucketId: 'gemini-old', window: '5h', remainingFraction: 0.1, disabled: true },
    ] },
    { displayName: 'Third party', buckets: [
      // Untouched: a full window away, so the reset is not a reset.
      { bucketId: '3p-shared-5h', window: '5h', remainingFraction: 1, resetTime: hours(5) },
      { bucketId: '3p-shared-weekly', window: 'weekly', remainingFraction: 0, resetTime: hours(100) },
    ] },
  ],
}

describe('Antigravity quota answers', () => {
  it('reads Gemini and the shared Claude and GPT allowance, each over 5 hours and a week, with no native names', () => {
    const read = parseAntigravityQuota([{ value: summary, requestedAt: NOW }], observedAt)
    expect(usageQuotaReadSchema.safeParse(read).success).toBe(true)
    expect(read.windows.map(window => [window.label, window.kind, window.durationMinutes, window.usedPercent, window.resetsAt])).toEqual([
      ['Gemini, 5 hours', 'primary', 300, 25, hours(2)],
      ['Gemini, week', 'weekly', 10_080, 60, hours(72)],
      ['Claude & GPT (shared), 5 hours', 'primary', 300, 0, undefined],
      ['Claude & GPT (shared), week', 'weekly', 10_080, 100, hours(100)],
    ])
    expect(JSON.stringify(read)).not.toMatch(/gemini-default|3p-shared|Third party|Gemini Models/u)
  })

  it('keeps the first host reading of a bucket both hosts report', () => {
    const other = { buckets: [{ bucketId: 'gemini-default-5h', window: '5h', remainingFraction: 0.2, resetTime: hours(1) }] }
    const read = parseAntigravityQuota([{ value: summary, requestedAt: NOW }, { value: other, requestedAt: NOW }], observedAt)
    expect(read.windows.filter(window => window.label === 'Gemini, 5 hours')).toEqual([expect.objectContaining({ usedPercent: 25 })])
  })

  it('folds model quotas by family to the most used, with no length for a plain quota', () => {
    const read = parseAntigravityModels([{ models: {
      'gemini-3-pro': { modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: { remainingFraction: 0.5 } },
      'gemini-3-flash': { quotaInfo: { remainingFraction: 0.2, resetTime: hours(3) }, weeklyQuotaInfo: { remainingFraction: 0.9 } },
      'claude-opus-5-5': { quotaInfo: { remainingFraction: 1 } },
      'mystery': { quotaInfo: { remainingFraction: 0 } },
    } }], observedAt)
    expect(read.windows.map(window => [window.label, window.usedPercent, window.durationMinutes])).toEqual([
      ['Gemini', 80, undefined], ['Gemini, week', expect.closeTo(10, 6), 10_080], ['Claude', 0, undefined],
    ])
  })
})

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-antigravity-quota-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})
async function appData(): Promise<{ directory: string; appData: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-antigravity-quota-')); roots.push(directory)
  const folder = antigravityFolders(directory).appData
  await mkdir(folder, { recursive: true })
  return { directory, appData: folder }
}
interface Call { url: string; init: RequestInit }
function stub(answer: (url: string, init: RequestInit) => unknown) {
  const calls: Call[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    const body = answer(url, init ?? {})
    return body === undefined ? new Response('no', { status: 500 }) : new Response(JSON.stringify(body), { status: 200 })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}
const ACCESS = 'ya29.access-token-secret'
const cliToken = (expiry: string): string => JSON.stringify({ token: { access_token: ACCESS, refresh_token: 'never-sent', expiry } })

describe('Antigravity limits reader', () => {
  it('asks both Cloud Code hosts with agy\'s saved sign-in and returns only windows', async () => {
    const { appData: folder } = await appData()
    await writeFile(join(folder, 'antigravity-oauth-token'), cliToken(hours(1)))
    const { fetch, calls } = stub(url => url.endsWith(':retrieveUserQuotaSummary') ? summary : undefined)
    const read = await new AntigravityQuotaReader({ appData: folder, fetch, now: () => NOW, platform: 'win32', arch: 'x64' }).read()
    expect(read).toMatchObject({ providerId: 'antigravity', status: 'available', refreshable: true })
    expect(read.windows).toHaveLength(4)
    expect(calls.map(call => call.url).sort()).toEqual(ANTIGRAVITY_QUOTA_HOSTS.map(host => `${host}/v1internal:retrieveUserQuotaSummary`).sort())
    for (const { init } of calls) {
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual', body: '{}' })
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${ACCESS}`)
      expect((init.headers as Record<string, string>)['user-agent']).toContain('os_type=win32; arch=x64')
    }
    expect(JSON.stringify(read)).not.toContain(ACCESS)
  })

  it('falls back to model quotas when the summary has no windows', async () => {
    const { appData: folder } = await appData()
    await writeFile(join(folder, 'antigravity-oauth-token'), cliToken(hours(1)))
    const { fetch, calls } = stub(url => url.endsWith(':retrieveUserQuotaSummary') ? { groups: [] }
      : { models: { 'gemini-3-pro': { quotaInfo: { remainingFraction: 0.5 } } } })
    const read = await new AntigravityQuotaReader({ appData: folder, fetch, now: () => NOW }).read()
    expect(read.windows).toEqual([expect.objectContaining({ label: 'Gemini', usedPercent: 50 })])
    expect(calls.filter(call => call.url.endsWith(':fetchAvailableModels'))).toHaveLength(2)
  })

  it('says why there is nothing to read: no sign-in, an expired one, or hosts that failed', async () => {
    const { appData: folder } = await appData()
    const { fetch, calls } = stub(() => undefined)
    const reader = new AntigravityQuotaReader({ appData: folder, fetch, now: () => NOW })
    expect(await reader.read()).toMatchObject({ status: 'unavailable', reason: 'not-connected' })
    await writeFile(join(folder, 'antigravity-oauth-token'), cliToken(hours(-1)))
    expect(await reader.read()).toMatchObject({ status: 'unavailable', reason: 'refresh-unavailable' })
    expect(calls).toHaveLength(0)
    await writeFile(join(folder, 'antigravity-oauth-token'), cliToken(hours(1)))
    expect(await reader.read()).toMatchObject({ status: 'error', reason: 'read-failed' })
  })

  it('renews an older agy\'s token at Google\'s token host once, and sends its project', async () => {
    const { appData: folder } = await appData()
    await writeFile(join(folder, 'acp_token.json'), JSON.stringify({ client_id: 'client', client_secret: 'secret', refresh_token: 'refresh', project_id: 'project-1' }))
    const { fetch, calls } = stub(url => url === ANTIGRAVITY_TOKEN_HOST ? { access_token: 'renewed', expires_in: 3600 } : summary)
    let now = NOW
    const reader = new AntigravityQuotaReader({ appData: folder, fetch, now: () => now })
    expect((await reader.read()).windows).toHaveLength(4)
    now += 60_000
    await reader.read()
    const renewals = calls.filter(call => call.url === ANTIGRAVITY_TOKEN_HOST)
    expect(renewals).toHaveLength(1)
    expect(String(renewals[0]!.init.body)).toBe('client_id=client&client_secret=secret&refresh_token=refresh&grant_type=refresh_token')
    const asks = calls.filter(call => call.url !== ANTIGRAVITY_TOKEN_HOST)
    expect(asks).toHaveLength(4)
    for (const { init } of asks) { expect(init.body).toBe('{"project":"project-1"}'); expect((init.headers as Record<string, string>).authorization).toBe('Bearer renewed') }
    expect(new Set(calls.map(call => new URL(call.url).host))).toEqual(new Set(['oauth2.googleapis.com', 'daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com']))
  })

  it('answers a background read from a reading of the last few minutes, and the hooks read only Antigravity', async () => {
    const { directory, appData: folder } = await appData()
    await writeFile(join(folder, 'antigravity-oauth-token'), cliToken(hours(1)))
    const { fetch, calls } = stub(() => summary)
    const hooks = antigravityUsageHooks({ directory, owned: () => new Map(), home: directory, quota: new AntigravityQuotaReader({ appData: folder, fetch, now: () => NOW }) })
    await hooks.readProviderQuota('antigravity', true)
    await hooks.readProviderQuota('antigravity', true, true)
    expect(calls).toHaveLength(2)
    await hooks.readProviderQuota('antigravity', true)
    expect(calls).toHaveLength(4)
    hooks.clearQuota()
    await hooks.readProviderQuota('antigravity', true, true)
    expect(calls).toHaveLength(6)
  })
})

describe('Usage for a peer from before Antigravity', () => {
  it('sends no quota, provider, model or client row naming Antigravity', () => {
    const quota = parseAntigravityQuota([{ value: summary, requestedAt: NOW }], observedAt)
    const row = { tokens: {}, prompts: 0, threads: 0 }
    const read = { status: 'ready', quotas: [quota, { ...quota, providerId: 'codex' }], activity: {
      providers: [{ providerId: 'antigravity', ...row }, { providerId: 'codex', ...row }], models: [{ providerId: 'antigravity', modelId: 'x', ...row }],
      clients: [{ clientId: 'antigravity', source: 'outside', providerIds: ['antigravity'] }, { clientId: 'sotto', source: 'sotto', providerIds: ['antigravity', 'codex'] }],
    } } as unknown as UsageLocalHostRead
    const older = usageReadBeforeAntigravity(read)
    expect(older.quotas.map(q => q.providerId)).toEqual(['codex'])
    expect(JSON.stringify(older.activity)).not.toContain('antigravity')
  })
})
