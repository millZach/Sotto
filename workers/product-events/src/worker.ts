import { isPublicModelId } from '../../../src/main/agents/usageRates'
import { parseProductEvent, parseProductEventInstall, PRODUCT_EVENT_SCHEMAS, type ProductEventName } from '../../../src/main/productEvents/schema'

/**
 * Sotto's product event endpoint (ADR-0179). It checks each event against the app's own schema, keeps the rebuilt copy for
 * 90 days and forwards it to PostHog once it has a key. It reads no request header but the body's length, stores no IP
 * address, and logs nothing. Anyone can post here, so nothing that fails the schema is kept or passed on, and requests are
 * limited per Cloudflare location rather than per address, which it does not read.
 */

export interface ProductEventStore {
  prepare(query: string): ProductEventStatement
  batch(statements: ProductEventStatement[]): Promise<readonly { readonly results?: readonly unknown[] }[]>
}
export interface ProductEventStatement {
  bind(...values: (string | number)[]): ProductEventStatement
  run(): Promise<unknown>
  all(): Promise<{ readonly results?: readonly unknown[] }>
}
export interface ProductEventsEnv {
  readonly EVENTS: ProductEventStore
  /** Set as a secret only when the notice ships. Without it, nothing goes to PostHog. */
  readonly POSTHOG_KEY?: string
  readonly POSTHOG_HOST?: string
  /** Cloudflare's rate limiter. Its key is constant, so the count is per location and no address is read. */
  readonly REQUESTS?: { limit(options: { key: string }): Promise<{ success: boolean }> }
}
interface WaitUntil { waitUntil(promise: Promise<unknown>): void }

const MAX_BODY_BYTES = 1_000_000
/** The sender's own batch size, so a batch cannot cost more writes than a real one. */
const MAX_BATCH_EVENTS = 20
/** Removed by an hourly sweep, so a row is gone before it is 90 days old. */
const REMOVE_AFTER_DAYS = 89
const DAY_MS = 24 * 60 * 60 * 1000
/** Younger rows may still be on their first try, which runs just after the answer. */
const RETRY_FORWARD_AFTER_MS = 5 * 60 * 1000
const RETRY_FORWARD_ROWS = 500
/** Enough for any backlog PostHog would have left, while each try's timeout keeps the hour's sweep from waiting long. */
const RETRY_FORWARD_ROUNDS = 10
const FORWARD_TIMEOUT_MS = 10_000
const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

interface CheckedEvent {
  readonly uuid: string
  readonly event: string
  readonly distinct_id: string
  readonly timestamp: string
  readonly properties: Record<string, unknown>
}

/**
 * The event rebuilt from the app's own schema, or null if it holds anything else. A model this Worker's list does not
 * have yet loses only that field, because a release can name a new public model before this Worker is deployed again.
 */
export function checkEvent(value: unknown): CheckedEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { uuid, event, distinct_id: distinctId, timestamp, properties, ...beside } = value as Record<string, unknown>
  if (Object.keys(beside).length > 0) return null
  if (typeof uuid !== 'string' || !UUID.test(uuid) || typeof distinctId !== 'string' || !HASH.test(distinctId)) return null
  if (typeof event !== 'string' || !Object.hasOwn(PRODUCT_EVENT_SCHEMAS, event)) return null
  if (typeof timestamp !== 'string' || !TIMESTAMP.test(timestamp)) return null
  const at = Date.parse(timestamp)
  // A date that does not exist, such as February 31, parses as another day; it is refused rather than moved.
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 19) !== timestamp.slice(0, 19)) return null
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return null
  // These two are set again below, whatever an event says.
  const { appVersion, channel, surface, platform, arch, ...own } = properties as Record<string, unknown>
  delete own.$process_person_profile
  delete own.$geoip_disable
  const install = parseProductEventInstall({ appVersion, channel, surface, platform, arch })
  if (!install) return null
  if ('model' in own && (typeof own.model !== 'string' || !isPublicModelId(own.model))) delete own.model
  const allowed = parseProductEvent(event as ProductEventName, own)
  if (!allowed) return null
  return { uuid, event, distinct_id: distinctId, timestamp: new Date(at).toISOString(), properties: { ...allowed, ...install, $process_person_profile: false, $geoip_disable: true } }
}

/** Stores what is new and answers with those events alone, since a retry's second copy was already forwarded or is due. */
async function keep(env: ProductEventsEnv, events: readonly CheckedEvent[], now: number): Promise<CheckedEvent[]> {
  const insert = env.EVENTS.prepare('INSERT INTO product_events (uuid, received_at, event, body, forward_due) VALUES (?, ?, ?, ?, ?) ON CONFLICT (uuid) DO NOTHING RETURNING uuid')
  const receivedAt = new Date(now).toISOString()
  // A row kept before there was a key is never due, so setting the key sends nothing from before it.
  const due = env.POSTHOG_KEY ? 1 : 0
  const results = await env.EVENTS.batch(events.map(event => insert.bind(event.uuid, receivedAt, event.event, JSON.stringify(event), due)))
  const kept = new Set(results.flatMap(result => (result.results ?? []) as readonly { readonly uuid: string }[]).map(row => row.uuid))
  // Taking each ID off the set as it is used also drops an event repeated inside one batch.
  return events.filter(event => kept.delete(event.uuid))
}

/**
 * Sends events to PostHog and marks them done. It throws when PostHog does not take them, and they stay due. If the marking
 * fails after PostHog took them, they go again with the same uuids, which PostHog uses to drop the copy.
 */
async function forward(env: ProductEventsEnv, events: readonly CheckedEvent[]): Promise<void> {
  if (events.length === 0) return
  const host = (env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST).replace(/\/+$/, '')
  const response = await fetch(`${host}/batch/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: env.POSTHOG_KEY, batch: events }), signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS) })
  await response.body?.cancel()
  if (!response.ok) throw new Error('not taken')
  const done = env.EVENTS.prepare('UPDATE product_events SET forward_due = 0 WHERE uuid = ?')
  await env.EVENTS.batch(events.map(event => done.bind(event.uuid)))
}

/** Tries again what PostHog did not take, oldest first, until none is due or PostHog stops taking them. Without a key nothing goes. */
export async function retryForwards(env: ProductEventsEnv, now: number = Date.now()): Promise<void> {
  if (!env.POSTHOG_KEY) return
  const before = new Date(now - RETRY_FORWARD_AFTER_MS).toISOString()
  const select = env.EVENTS.prepare('SELECT body FROM product_events WHERE forward_due = 1 AND received_at < ? ORDER BY received_at LIMIT ?').bind(before, RETRY_FORWARD_ROWS)
  for (let round = 0; round < RETRY_FORWARD_ROUNDS; round += 1) {
    const rows = ((await select.all()).results ?? []) as readonly { readonly body: string }[]
    if (rows.length === 0) return
    await forward(env, rows.map(row => JSON.parse(row.body) as CheckedEvent))
  }
}

const answer = (status: number): Response => new Response(null, { status })

export async function handleProductEvents(request: Request, env: ProductEventsEnv, context: WaitUntil, now: number = Date.now()): Promise<Response> {
  if (new URL(request.url).pathname !== '/batch') return answer(404)
  if (request.method !== 'POST') return answer(405)
  // Over the limit answers 429, which the sender tries again later. Nothing has been read or written.
  if (env.REQUESTS && !(await env.REQUESTS.limit({ key: 'all' })).success) return answer(429)
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return answer(413)
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return answer(413)
  let batch: unknown
  try { batch = (JSON.parse(text) as { batch?: unknown }).batch } catch { return answer(400) }
  if (!Array.isArray(batch) || batch.length === 0 || batch.length > MAX_BATCH_EVENTS) return answer(400)
  const events = batch.flatMap(value => checkEvent(value) ?? [])
  if (events.length === 0) return answer(400)
  // Failing to store answers 503, so the sender keeps the batch and tries again; each event's uuid stops a second copy.
  let kept: CheckedEvent[]
  try { kept = await keep(env, events, now) } catch { return answer(503) }
  if (env.POSTHOG_KEY) context.waitUntil(forward(env, kept).catch(() => undefined))
  return answer(204)
}

/** Keeps the copy to its 90 days. Cloudflare's own D1 backups hold what this removes for a while longer (ADR-0179). */
export async function forgetOldEvents(store: ProductEventStore, now: number = Date.now()): Promise<void> {
  await store.prepare('DELETE FROM product_events WHERE received_at < ?').bind(new Date(now - REMOVE_AFTER_DAYS * DAY_MS).toISOString()).run()
}

/** The hour's work. A row a failing PostHog never took is still removed on time: retention does not wait on PostHog. */
export async function runHourlyWork(env: ProductEventsEnv, now: number = Date.now()): Promise<void> {
  await retryForwards(env, now).catch(() => undefined)
  await forgetOldEvents(env.EVENTS, now)
}

export default {
  fetch: (request: Request, env: ProductEventsEnv, context: WaitUntil): Promise<Response> => handleProductEvents(request, env, context),
  scheduled: (_controller: unknown, env: ProductEventsEnv, context: WaitUntil): void => {
    context.waitUntil(runHourlyWork(env))
  },
}
