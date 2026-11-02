// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetOldEvents, handleProductEvents, retryForwards, type ProductEventStatement, type ProductEventStore } from '../../../workers/product-events/src/worker'

const NOW = Date.parse('2026-11-02T20:00:00.000Z')
const HASH = 'c'.repeat(64)
const INSTALL = { appVersion: '0.1.43-owl.20261102.1', channel: 'stable', surface: 'desktop', platform: 'windows', arch: 'x64', $process_person_profile: false, $geoip_disable: true }
const SECRET = 'please fix the login page in /home/someone/project'
let nextUuid = 0
const event = (over: Record<string, unknown> = {}, properties: Record<string, unknown> = { pairedHosts: 1 }): Record<string, unknown> => ({
  uuid: `00000000-0000-4000-8000-${String(nextUuid++).padStart(12, '0')}`, event: 'app.started', distinct_id: HASH, timestamp: new Date(NOW - 1000).toISOString(), properties: { ...properties, ...INSTALL }, ...over,
})

describe('the product event Worker', () => {
  let database: DatabaseSync
  let store: ProductEventStore
  let waited: Promise<unknown>[]
  const context = { waitUntil: (promise: Promise<unknown>) => { waited.push(promise) } }
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    database.exec(readFileSync(join(process.cwd(), 'workers/product-events/schema.sql'), 'utf8'))
    waited = []
    // D1's statements over the same SQL, so the real schema and queries run.
    const statement = (query: string, values: (string | number)[] = []): ProductEventStatement => ({
      bind: (...next) => statement(query, next),
      run: async () => database.prepare(query).run(...values),
      all: async () => ({ results: database.prepare(query).all(...values) }),
    })
    store = { prepare: query => statement(query), batch: async statements => Promise.all(statements.map(each => each.all())) }
    vi.unstubAllGlobals()
  })
  const post = (body: unknown, env: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<Response> =>
    handleProductEvents(new Request('https://events.test/batch', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }), { EVENTS: store, ...env }, context, NOW)
  const rows = (): { uuid: string; event: string; body: string; received_at: string; forward_due: number }[] => database.prepare('SELECT * FROM product_events').all() as never

  it('keeps a good event as it rebuilt it, and only that', async () => {
    const sent = event()
    expect((await post({ batch: [sent] })).status).toBe(204)
    const [row] = rows()
    expect(row!.uuid).toBe(sent.uuid); expect(row!.event).toBe('app.started'); expect(row!.received_at).toBe(new Date(NOW).toISOString())
    expect(JSON.parse(row!.body)).toEqual(sent)
    expect(Object.keys(row!).sort()).toEqual(['body', 'event', 'forward_due', 'received_at', 'uuid'])
  })

  it('stores nothing from the request but the event: no address, no header', async () => {
    await post({ batch: [event()] }, {}, { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9', 'user-agent': 'Sotto/secret' })
    const said = JSON.stringify(rows())
    expect(said).not.toContain('203.0.113.9'); expect(said).not.toContain('Sotto/secret')
  })

  it.each([
    ['a prompt field', { prompt: SECRET }],
    ['a path field', { path: '/home/someone' }],
    ['a thread ID field', { threadId: 'abc' }],
    ['free text in a listed word', { pairedHosts: SECRET }],
    ['a nested object', { pairedHosts: { secret: SECRET } }],
  ])('drops an event carrying %s', async (_name, properties) => {
    expect((await post({ batch: [event({}, properties)] })).status).toBe(400)
    expect(rows()).toEqual([])
  })

  it.each([
    ['a path as a word', 'feature.used', { feature: '/home/someone' }],
    ['a sentence as a word', 'feature.used', { feature: SECRET }],
    ['a capital in a word', 'turn.completed', { provider: 'Claude', result: 'completed', durationMs: 1 }],
    ['text in a count', 'turn.completed', { provider: 'claude', durationMs: SECRET }],
    ['a raw account ID', 'install.owner_observed', { ownerSource: 'claude', ownerId: '2f1c7a64-90de-4c11-8a35-1b2c3d4e5f60' }],
    ['a repo name that looks like a word', 'feature.used', { feature: 'secret-repo-name' }],
    ['a file name that looks like a word', 'feature.used', { feature: 'private-client-report.pdf' }],
    ['a provider off the list', 'thread.started', { provider: 'secret-provider', permissionMode: 'auto', inWorktree: true, startedBy: 'user' }],
    ['a thread with no provider', 'thread.started', { permissionMode: 'auto', inWorktree: true, startedBy: 'user' }],
    ['a count past its limit', 'app.started', { pairedHosts: 10_001 }],
  ])('drops %s', async (_name, name, properties) => {
    expect((await post({ batch: [event({ event: name }, properties)] })).status).toBe(400)
    expect(rows()).toEqual([])
  })

  it.each([
    ['an unknown event', { event: 'dictation.finished' }],
    ['a field beside the event', { message: SECRET }],
    ['an unhashed distinct ID', { distinct_id: 'someone@example.com' }],
    ['a uuid that is not one', { uuid: SECRET }],
    ['a time that is not one', { timestamp: SECRET }],
    ['a date that does not exist', { timestamp: '2026-02-31T00:00:00.000Z' }],
    ['an hour that does not exist', { timestamp: '2026-11-02T24:00:00.000Z' }],
    ['words after a time', { timestamp: '2026-11-02T20:00:00.000Z and more' }],
    ['a name on Object itself', { event: 'constructor' }],
  ])('drops %s', async (_name, over) => {
    expect((await post({ batch: [event(over)] })).status).toBe(400)
    expect(rows()).toEqual([])
  })

  it('needs what every event says about its install', async () => {
    const withoutVersion: Record<string, unknown> = { pairedHosts: 1, ...INSTALL }
    delete withoutVersion.appVersion
    expect((await post({ batch: [event({ properties: withoutVersion })] })).status).toBe(400)
    expect((await post({ batch: [event({ properties: { pairedHosts: 1, ...INSTALL, appVersion: '/etc/passwd' } })] })).status).toBe(400)
  })

  it('keeps the good events of a batch and drops only the bad one', async () => {
    const good = event()
    expect((await post({ batch: [good, event({}, { prompt: SECRET })] })).status).toBe(204)
    expect(rows().map(row => row.uuid)).toEqual([good.uuid])
    expect(JSON.stringify(rows())).not.toContain('please fix')
  })

  it('keeps a good event with a model off its list, without the model', async () => {
    const turn = { provider: 'codex', permissionMode: 'auto', startedBy: 'user', result: 'completed', durationMs: 1 }
    expect((await post({ batch: [event({ event: 'turn.completed' }, { ...turn, model: 'private-finetune' })] })).status).toBe(204)
    expect(rows()[0]!.body).not.toContain('private-finetune')
    expect(JSON.parse(rows()[0]!.body).properties).toEqual({ ...turn, ...INSTALL })
  })

  it('keeps an event a host held for a long time, by the time it arrived', async () => {
    const held = event({ timestamp: new Date(NOW - 60 * 86_400_000).toISOString() })
    expect((await post({ batch: [held] })).status).toBe(204)
    expect(rows()[0]!.received_at).toBe(new Date(NOW).toISOString())
  })

  it('keeps one copy of a batch sent twice', async () => {
    const sent = event()
    await post({ batch: [sent] }); await post({ batch: [sent] })
    expect(rows()).toHaveLength(1)
  })

  it('refuses what is not a batch, so the sender drops it', async () => {
    for (const body of ['not json', {}, { batch: 'x' }, { batch: [] }, { batch: Array.from({ length: 21 }, () => event()) }]) expect((await post(body)).status, JSON.stringify(body).slice(0, 30)).toBe(400)
    expect((await post('x'.repeat(1_000_001))).status).toBe(413)
    expect((await post('é'.repeat(500_001))).status).toBe(413)
    expect((await post('{}', {}, { 'content-length': '2000000' })).status).toBe(413)
  })

  it('answers 429 over the limit, before reading or writing, and counts no address', async () => {
    const limit = vi.fn(async () => ({ success: false }))
    const response = await post({ batch: [event()] }, { REQUESTS: { limit } }, { 'cf-connecting-ip': '203.0.113.9' })
    expect(response.status).toBe(429); expect(rows()).toEqual([])
    expect(limit).toHaveBeenCalledWith({ key: 'all' })
    limit.mockResolvedValue({ success: true })
    expect((await post({ batch: [event()] }, { REQUESTS: { limit } })).status).toBe(204)
  })

  it('answers only POST /batch', async () => {
    expect((await handleProductEvents(new Request('https://events.test/'), { EVENTS: store }, context, NOW)).status).toBe(404)
    expect((await handleProductEvents(new Request('https://events.test/batch'), { EVENTS: store }, context, NOW)).status).toBe(405)
  })

  it('answers 503 when it cannot store, so the sender tries again, and forwards nothing', async () => {
    const posted = vi.fn(async () => new Response(null))
    vi.stubGlobal('fetch', posted)
    const failing = { prepare: store.prepare, batch: async () => { throw new Error('down') } } as ProductEventStore
    const response = await handleProductEvents(new Request('https://events.test/batch', { method: 'POST', body: JSON.stringify({ batch: [event()] }) }), { EVENTS: failing, POSTHOG_KEY: 'k' }, context, NOW)
    expect(response.status).toBe(503); expect(posted).not.toHaveBeenCalled()
  })

  it('sends nothing to PostHog without a key', async () => {
    const posted = vi.fn(async () => new Response(null))
    vi.stubGlobal('fetch', posted)
    await post({ batch: [event()] })
    expect(posted).not.toHaveBeenCalled(); expect(waited).toEqual([])
  })

  const withKey = { POSTHOG_KEY: 'phc_test', POSTHOG_HOST: 'https://ph.test/' }
  const stubPostHog = (ok = true): ReturnType<typeof vi.fn<typeof fetch>> => {
    const posted = vi.fn<typeof fetch>(async () => new Response(null, { status: ok ? 200 : 503 }))
    vi.stubGlobal('fetch', posted)
    return posted
  }
  const sentTo = (posted: ReturnType<typeof vi.fn<typeof fetch>>, call = 0): { api_key: string; batch: { uuid: string }[] } => JSON.parse(String(posted.mock.calls[call]?.[1]?.body)) as never

  it('with a key forwards only the rebuilt event, and marks it done', async () => {
    const posted = stubPostHog()
    const good = event()
    await post({ batch: [good, event({}, { prompt: SECRET })] }, withKey, { 'cf-connecting-ip': '203.0.113.9' })
    await Promise.all(waited)
    expect(posted.mock.calls[0]?.[0]).toBe('https://ph.test/batch/')
    expect(sentTo(posted)).toEqual({ api_key: 'phc_test', batch: [good] })
    const said = String(posted.mock.calls[0]?.[1]?.body)
    expect(said).not.toContain('203.0.113.9'); expect(said).not.toContain('please fix')
    expect(rows()[0]!.forward_due).toBe(0)
  })

  it('forwards a resent event once, including one repeated inside a batch', async () => {
    const posted = stubPostHog()
    const sent = event()
    await post({ batch: [sent, sent] }, withKey); await Promise.all(waited)
    expect(sentTo(posted).batch).toEqual([sent])
    waited = []
    expect((await post({ batch: [sent] }, withKey)).status).toBe(204); await Promise.all(waited)
    expect(posted).toHaveBeenCalledOnce()
    expect(rows()).toHaveLength(1)
  })

  it('answers 204 when PostHog fails, keeps the event due, and the sweep sends it once it can', async () => {
    let posted = stubPostHog(false)
    const sent = event()
    expect((await post({ batch: [sent] }, withKey)).status).toBe(204); await Promise.all(waited)
    expect(posted).toHaveBeenCalledOnce(); expect(rows()[0]!.forward_due).toBe(1)

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    waited = []
    expect((await post({ batch: [event()] }, withKey)).status).toBe(204)
    await expect(Promise.all(waited)).resolves.toBeDefined()
    expect(rows().every(row => row.forward_due === 1)).toBe(true)

    posted = stubPostHog()
    const env = { EVENTS: store, ...withKey }
    await retryForwards(env, NOW + 60_000)
    expect(posted).not.toHaveBeenCalled()
    await retryForwards(env, NOW + 6 * 60_000)
    expect(sentTo(posted).batch).toHaveLength(2)
    expect(rows().every(row => row.forward_due === 0)).toBe(true)
    await retryForwards(env, NOW + 7 * 60_000)
    expect(posted).toHaveBeenCalledOnce()
  })

  it('a failed retry leaves events due, and sends nothing without a key', async () => {
    stubPostHog(false)
    await post({ batch: [event()] }, withKey); await Promise.all(waited)
    await expect(retryForwards({ EVENTS: store, ...withKey }, NOW + 6 * 60_000)).rejects.toThrow()
    expect(rows()[0]!.forward_due).toBe(1)
    const posted = stubPostHog()
    await retryForwards({ EVENTS: store }, NOW + 6 * 60_000)
    expect(posted).not.toHaveBeenCalled()
  })

  it('never forwards what arrived before there was a key, once a key is set', async () => {
    const posted = stubPostHog()
    await post({ batch: [event()] })
    expect(rows()[0]!.forward_due).toBe(0)
    await retryForwards({ EVENTS: store, ...withKey }, NOW + 86_400_000)
    expect(posted).not.toHaveBeenCalled()
  })

  it('removes an event by the hourly sweep before it is 90 days old, and not sooner than 89', async () => {
    await post({ batch: [event()] })
    await forgetOldEvents(store, NOW + 88 * 86_400_000)
    expect(rows()).toHaveLength(1)
    // The hourly sweep that first finds it past 89 days runs long before it is 90 days old.
    await forgetOldEvents(store, NOW + 89 * 86_400_000 + 1)
    expect(rows()).toEqual([])
  })

  it('takes what the app sends, event by event', async () => {
    const samples: [string, Record<string, unknown>][] = [
      ['install.owner_observed', { ownerSource: 'openai', ownerId: HASH }],
      ['thread.started', { provider: 'claude', model: 'claude-opus-5-5', effort: 'high', permissionMode: 'approval-required', inWorktree: true, startedBy: 'user' }],
      ['turn.completed', { provider: 'codex', model: 'gpt-6-sol', effort: 'xhigh', speed: 'fast', permissionMode: 'full-access', startedBy: 'watcher', result: 'completed', durationMs: 48211, inputTokens: 1, cachedInputTokens: 2, outputTokens: 3, reasoningTokens: 4, childInputTokens: 0, childOutputTokens: 0 }],
      ['feature.used', { feature: '3d-model' }],
      ['app.started', { pairedHosts: 10_000 }],
    ]
    for (const [name, properties] of samples) {
      expect((await post({ batch: [event({ event: name }, properties)] })).status, name).toBe(204)
    }
    expect(rows()).toHaveLength(samples.length)
  })
})
