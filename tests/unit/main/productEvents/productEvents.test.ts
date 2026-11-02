// @vitest-environment node
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRODUCT_EVENTS_INSTALL_FILE } from '../../../../src/main/productEvents/identity'
import { productEventsEndpoint, productEventsOffByEnvironment, productEventsPermission, ProductEvents, type ProductEventsOptions } from '../../../../src/main/productEvents/productEvents'

const OWNER = 'b'.repeat(64)
const INSTALL = { appVersion: '0.1.43', channel: 'stable', surface: 'desktop', platform: 'linux', arch: 'x64' } as const
type Batch = { batch: { uuid: string; event: string; distinct_id: string; timestamp: string; properties: Record<string, unknown> }[] }

describe('ProductEvents', () => {
  let directory: string
  let bodies: Batch[]
  let clock: number
  let answer: () => Promise<Response>
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sotto-product-events-'))
    bodies = []; clock = 1_000_000; answer = async () => new Response('ok', { status: 200 })
  })
  afterEach(async () => { vi.useRealTimers(); await rm(directory, { recursive: true, force: true }) })
  const idFile = (): string => join(directory, PRODUCT_EVENTS_INSTALL_FILE)
  const hasId = async (): Promise<boolean> => stat(idFile()).then(() => true, () => false)
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body)) as Batch); return answer() })
  const make = (over: Partial<ProductEventsOptions> = {}): ProductEvents => {
    fetcher.mockClear()
    return new ProductEvents({ endpoint: 'https://events.test', install: INSTALL, dataDirectory: directory, environment: {}, holdWhileWaiting: false,
      homes: { claudeFile: join(directory, 'none'), codexHome: join(directory, 'none') }, fetch: fetcher as unknown as typeof fetch, now: () => clock, random: () => 0, readOwners: async () => [], ...over })
  }
  const started = { pairedHosts: 2 }

  it('does nothing at all without an endpoint', async () => {
    const events = make({ endpoint: null })
    events.setPermission('on'); events.record('app.started', started); await events.flush()
    expect(fetcher).not.toHaveBeenCalled(); expect(await hasId()).toBe(false); expect(events.waitingCount).toBe(0)
  })

  it.each([[{ SOTTO_TELEMETRY_ENABLED: 'false' }], [{ SOTTO_TELEMETRY_ENABLED: '0' }], [{ DO_NOT_TRACK: '1' }]])('does nothing under %j, and removes an ID from an earlier run', async (environment) => {
    await writeFile(idFile(), '11111111-1111-4111-8111-111111111111')
    const events = make({ environment })
    events.setPermission('on'); events.record('app.started', started); await events.flush()
    await vi.waitFor(async () => expect(await hasId()).toBe(false))
    expect(fetcher).not.toHaveBeenCalled(); expect(events.waitingCount).toBe(0)
  })

  it('reads the environment switch the way people write it', () => {
    expect(productEventsOffByEnvironment({})).toBe(false)
    expect(productEventsOffByEnvironment({ SOTTO_TELEMETRY_ENABLED: 'true' })).toBe(false)
    expect(productEventsOffByEnvironment({ SOTTO_TELEMETRY_ENABLED: 'FALSE' })).toBe(true)
    expect(productEventsOffByEnvironment({ DO_NOT_TRACK: '0' })).toBe(false)
    expect(productEventsOffByEnvironment({ DO_NOT_TRACK: '' })).toBe(false)
    expect(productEventsOffByEnvironment({ DO_NOT_TRACK: 'true' })).toBe(true)
  })

  it('keeps nothing and makes no ID before the notice is answered', async () => {
    const events = make()
    events.record('app.started', started); await events.flush()
    expect(events.waitingCount).toBe(0); expect(fetcher).not.toHaveBeenCalled(); expect(await hasId()).toBe(false)
    expect(productEventsPermission({ productEventsEnabled: true, productEventsNoticeAnswered: false })).toBe('waiting')
    expect(productEventsPermission({ productEventsEnabled: true, productEventsNoticeAnswered: true })).toBe('on')
    expect(productEventsPermission({ productEventsEnabled: false, productEventsNoticeAnswered: true })).toBe('off')
  })

  it('sends exactly the event, the install and the hashed ID once answered', async () => {
    const events = make()
    events.setPermission('on'); events.record('app.started', started); await events.flush()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://events.test/batch')
    const [sent] = bodies[0]!.batch
    expect(Object.keys(bodies[0]!)).toEqual(['batch'])
    expect(Object.keys(sent!).sort()).toEqual(['distinct_id', 'event', 'properties', 'timestamp', 'uuid'])
    expect(sent!.event).toBe('app.started')
    expect(sent!.properties).toEqual({ pairedHosts: 2, ...INSTALL, $process_person_profile: false, $geoip_disable: true })
    expect(sent!.distinct_id).toMatch(/^[0-9a-f]{64}$/)
    expect(sent!.distinct_id).not.toBe((await readFile(idFile(), 'utf8')).trim())
    expect(events.waitingCount).toBe(0)
  })

  it('never sends a forbidden field a caller passes', async () => {
    const log = vi.fn()
    const events = make({ log })
    events.setPermission('on')
    events.record('app.started', { pairedHosts: 1, prompt: 'please fix the login page' } as never)
    events.record('feature.used', { feature: 'council', threadId: 'a-thread' } as never)
    events.record('turn.completed', { provider: 'claude', model: 'my-own-server-model', permissionMode: 'auto', startedBy: 'user', result: 'completed', durationMs: 1 })
    events.record('feature.used', { feature: 'council' })
    await events.flush()
    const said = JSON.stringify(bodies)
    expect(bodies.flatMap(body => body.batch).map(event => event.event)).toEqual(['feature.used'])
    for (const word of ['please fix', 'a-thread', 'my-own-server-model']) expect(said).not.toContain(word)
    expect(log.mock.calls).toEqual([['product-events-event-refused'], ['product-events-event-refused'], ['product-events-event-refused']])
  })

  it('sends one batch of 20 at a time and reports each account once', async () => {
    const readOwners = vi.fn(async () => [{ ownerSource: 'claude' as const, ownerId: OWNER }])
    const events = make({ readOwners })
    events.setPermission('on')
    for (let index = 0; index < 45; index += 1) events.record('feature.used', { feature: 'files' })
    await events.flush()
    expect(bodies.map(body => body.batch.length)).toEqual([20])
    await events.flush(); await events.flush()
    expect(bodies.map(body => body.batch.length)).toEqual([20, 20, 6])
    events.record('feature.used', { feature: 'files' }); await events.flush()
    expect(readOwners).toHaveBeenCalledOnce()
    expect(bodies.flatMap(body => body.batch).filter(event => event.event === 'install.owner_observed')).toHaveLength(1)
  })

  it('turning off drops what waits, deletes the ID and sends nothing more', async () => {
    const events = make()
    events.setPermission('on'); events.record('app.started', started); await events.flush()
    expect(await hasId()).toBe(true)
    events.record('feature.used', { feature: 'files' }); expect(events.waitingCount).toBe(1)
    fetcher.mockClear()
    events.setPermission('off')
    expect(events.waitingCount).toBe(0)
    await vi.waitFor(async () => expect(await hasId()).toBe(false))
    events.record('feature.used', { feature: 'files' }); await events.flush()
    expect(events.waitingCount).toBe(0); expect(fetcher).not.toHaveBeenCalled(); expect(await hasId()).toBe(false)
  })

  it('turning off aborts a send in flight and does not bring the batch back', async () => {
    let signal: AbortSignal | undefined
    const stuck = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => { signal = init?.signal ?? undefined; signal?.addEventListener('abort', () => reject(new Error('aborted'))) }))
    const events = make({ fetch: stuck as unknown as typeof fetch })
    events.setPermission('on'); events.record('app.started', started)
    const flushing = events.flush()
    await vi.waitFor(() => expect(stuck).toHaveBeenCalled())
    events.setPermission('off')
    await flushing
    expect(signal?.aborted).toBe(true); expect(events.waitingCount).toBe(0)
    await vi.waitFor(async () => expect(await hasId()).toBe(false))
  })

  it('turning off while the ID is being made leaves no ID', async () => {
    const events = make()
    events.setPermission('on'); events.record('app.started', started)
    const flushing = events.flush()
    events.setPermission('off')
    await flushing
    await vi.waitFor(async () => expect(await hasId()).toBe(false))
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('a host holds events in memory without an ID until a desktop says on', async () => {
    const events = make({ holdWhileWaiting: true })
    events.record('app.started', started); await events.flush()
    expect(events.waitingCount).toBe(1); expect(fetcher).not.toHaveBeenCalled(); expect(await hasId()).toBe(false)
    events.setPermission('on'); await events.flush()
    expect(bodies[0]!.batch[0]!.event).toBe('app.started')
  })

  it('a host drops what it held when a desktop says off', async () => {
    const events = make({ holdWhileWaiting: true })
    events.record('app.started', started)
    events.setPermission('off')
    expect(events.waitingCount).toBe(0)
    events.setPermission('waiting'); events.setPermission('on'); await events.flush()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('holds at most 1,000 events, the newest', async () => {
    const events = make({ holdWhileWaiting: true })
    for (let index = 0; index < 1_005; index += 1) events.record('app.started', { pairedHosts: index })
    expect(events.waitingCount).toBe(1_000)
    events.setPermission('on'); await events.flush()
    expect(bodies[0]!.batch[0]!.properties.pairedHosts).toBe(5)
  })

  it('counts the batch being retried in the 1,000, and pushes its oldest events out first', async () => {
    answer = async () => { throw new TypeError('fetch failed') }
    const events = make()
    events.setPermission('on')
    for (let index = 0; index < 20; index += 1) events.record('app.started', { pairedHosts: index })
    await events.flush()
    expect(events.waitingCount).toBe(20)
    for (let index = 20; index < 1_020; index += 1) events.record('app.started', { pairedHosts: index })
    expect(events.waitingCount).toBe(1_000)
    answer = async () => new Response('ok', { status: 200 })
    clock += 2_000
    await events.flush()
    expect(bodies.at(-1)!.batch[0]!.properties.pairedHosts).toBe(20)
    expect(events.waitingCount).toBe(980)
  })

  it('reset of the notice stops a send, drops what waits and deletes the ID', async () => {
    let signal: AbortSignal | undefined
    const stuck = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => { signal = init?.signal ?? undefined; signal?.addEventListener('abort', () => reject(new Error('aborted'))) }))
    const events = make({ fetch: stuck as unknown as typeof fetch })
    events.setPermission('on'); events.record('app.started', started)
    const flushing = events.flush()
    await vi.waitFor(() => expect(stuck).toHaveBeenCalled())
    events.setPermission('waiting')
    await flushing
    expect(signal?.aborted).toBe(true); expect(events.waitingCount).toBe(0)
    await vi.waitFor(async () => expect(await hasId()).toBe(false))
  })

  it('a host whose desktop goes stops sending, keeps its events and ID, and sends the same event when told on', async () => {
    let signal: AbortSignal | undefined
    let release: ((response: Response) => void) | undefined
    const stuck = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => { release = resolve; signal = init?.signal ?? undefined; signal?.addEventListener('abort', () => reject(new Error('aborted'))) }))
    const events = make({ holdWhileWaiting: true, fetch: stuck as unknown as typeof fetch })
    events.setPermission('on'); events.record('app.started', started)
    const flushing = events.flush()
    await vi.waitFor(() => expect(stuck).toHaveBeenCalled())
    const first = JSON.parse(String(stuck.mock.calls[0]?.[1]?.body)) as Batch
    events.setPermission('waiting')
    await flushing
    expect(signal?.aborted).toBe(true); expect(events.waitingCount).toBe(1); expect(await hasId()).toBe(true)
    events.setPermission('on')
    const again = events.flush()
    await vi.waitFor(() => expect(stuck).toHaveBeenCalledTimes(2))
    expect((JSON.parse(String(stuck.mock.calls[1]?.[1]?.body)) as Batch).batch[0]!.uuid).toBe(first.batch[0]!.uuid)
    release?.(new Response('ok', { status: 200 }))
    await again
    expect(events.waitingCount).toBe(0)
  })

  it('never reads an account or makes an ID once off, even mid-flush', async () => {
    const readOwners = vi.fn(async () => [])
    const events = make({ readOwners })
    events.setPermission('on'); events.record('app.started', started)
    const flushing = events.flush()
    events.setPermission('off')
    await flushing
    expect(readOwners).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
    await vi.waitFor(async () => expect(await hasId()).toBe(false))
  })

  it('fails silently offline, backs off and sends the same batch again', async () => {
    answer = async () => { throw new TypeError('fetch failed') }
    const events = make()
    events.setPermission('on'); events.record('app.started', started)
    await expect(events.flush()).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(1); expect(events.waitingCount).toBe(1)
    await events.flush()
    expect(fetcher).toHaveBeenCalledTimes(1)
    const uuid = bodies[0]!.batch[0]!.uuid
    answer = async () => new Response('ok', { status: 200 })
    clock += 2_000
    await events.flush()
    expect(fetcher).toHaveBeenCalledTimes(2); expect(bodies[1]!.batch[0]!.uuid).toBe(uuid); expect(events.waitingCount).toBe(0)
  })

  it('drops a refused batch at once and a failing one after 30 minutes', async () => {
    const log = vi.fn()
    answer = async () => new Response('no', { status: 400 })
    const refused = make({ log })
    refused.setPermission('on'); refused.record('app.started', started); await refused.flush()
    expect(refused.waitingCount).toBe(0); expect(log).toHaveBeenCalledWith('product-events-batch-dropped')

    log.mockClear()
    answer = async () => new Response('down', { status: 503 })
    const failing = make({ log })
    failing.setPermission('on'); failing.record('app.started', started); await failing.flush()
    expect(failing.waitingCount).toBe(1)
    clock += 29 * 60_000; await failing.flush(); expect(failing.waitingCount).toBe(1); expect(log).not.toHaveBeenCalled()
    clock += 6 * 60_000; await failing.flush(); expect(failing.waitingCount).toBe(0); expect(log).toHaveBeenCalledWith('product-events-batch-dropped')
  })

  it('arms no timer while idle or off, and a timer only while something waits', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const waiting = make()
    expect(vi.getTimerCount()).toBe(0)
    waiting.record('app.started', started)
    expect(vi.getTimerCount()).toBe(0)
    waiting.setPermission('off')
    waiting.record('app.started', started)
    expect(vi.getTimerCount()).toBe(0)
    const on = make()
    on.setPermission('on')
    expect(vi.getTimerCount()).toBe(1)
    on.setPermission('off')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops without waiting and records nothing after', async () => {
    const events = make()
    events.setPermission('on'); events.record('app.started', started); await events.flush()
    events.record('feature.used', { feature: 'files' })
    events.stop()
    await vi.waitFor(() => expect(bodies.flatMap(body => body.batch).some(event => event.event === 'feature.used')).toBe(true))
    const left = events.waitingCount
    events.record('feature.used', { feature: 'files' })
    expect(events.waitingCount).toBe(left)
  })

  it('takes an endpoint from the environment only over HTTPS or to this computer', () => {
    expect(productEventsEndpoint({})).toBeNull()
    expect(productEventsEndpoint({}, 'https://built.in')).toBe('https://built.in')
    expect(productEventsEndpoint({ SOTTO_PRODUCT_EVENTS_ENDPOINT: 'https://events.test/' })).toBe('https://events.test')
    expect(productEventsEndpoint({ SOTTO_PRODUCT_EVENTS_ENDPOINT: 'http://127.0.0.1:8787' })).toBe('http://127.0.0.1:8787')
    expect(productEventsEndpoint({ SOTTO_PRODUCT_EVENTS_ENDPOINT: 'http://events.test' })).toBeNull()
    expect(productEventsEndpoint({ SOTTO_PRODUCT_EVENTS_ENDPOINT: 'not a url' })).toBeNull()
  })
})
