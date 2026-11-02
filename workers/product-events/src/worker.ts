import { isPublicModelId } from '../../../src/main/agents/usageRates'
import { parseProductEvent, parseProductEventInstall, PRODUCT_EVENT_SCHEMAS, type ProductEventName } from '../../../src/main/productEvents/schema'

/**
 * Sotto's product event endpoint (ADR-0179). It checks each event against the app's own schema, keeps the rebuilt copy for
 * 90 days and forwards it to PostHog once it has a key. It reads no request header but the body's length, stores no IP
 * address, and logs nothing. Anyone can post here, so nothing that fails the schema is kept or passed on.
 */

export interface ProductEventStore {
  prepare(query: string): ProductEventStatement
  batch(statements: ProductEventStatement[]): Promise<unknown>
}
export interface ProductEventStatement {
  bind(...values: (string | number)[]): ProductEventStatement
  run(): Promise<unknown>
}
export interface ProductEventsEnv {
  readonly EVENTS: ProductEventStore
  /** Set as a secret only when the notice ships. Without it, nothing goes to PostHog. */
  readonly POSTHOG_KEY?: string
  readonly POSTHOG_HOST?: string
}
interface WaitUntil { waitUntil(promise: Promise<unknown>): void }

const MAX_BODY_BYTES = 1_000_000
const MAX_BATCH_EVENTS = 100
/** Removed by a daily sweep, so at this age a row is at most 90 days old when it goes. */
const REMOVE_AFTER_DAYS = 89
const DAY_MS = 24 * 60 * 60 * 1000
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
  if (!Number.isFinite(at)) return null
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

async function keep(store: ProductEventStore, events: readonly CheckedEvent[], now: number): Promise<void> {
  const insert = store.prepare('INSERT OR IGNORE INTO product_events (uuid, received_at, event, body) VALUES (?, ?, ?, ?)')
  const receivedAt = new Date(now).toISOString()
  await store.batch(events.map(event => insert.bind(event.uuid, receivedAt, event.event, JSON.stringify(event))))
}

async function forward(env: ProductEventsEnv, events: readonly CheckedEvent[]): Promise<void> {
  const host = (env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST).replace(/\/+$/, '')
  const response = await fetch(`${host}/batch/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: env.POSTHOG_KEY, batch: events }) })
  await response.body?.cancel()
}

const answer = (status: number): Response => new Response(null, { status })

export async function handleProductEvents(request: Request, env: ProductEventsEnv, context: WaitUntil, now: number = Date.now()): Promise<Response> {
  if (new URL(request.url).pathname !== '/batch') return answer(404)
  if (request.method !== 'POST') return answer(405)
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return answer(413)
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return answer(413)
  let batch: unknown
  try { batch = (JSON.parse(text) as { batch?: unknown }).batch } catch { return answer(400) }
  if (!Array.isArray(batch) || batch.length === 0 || batch.length > MAX_BATCH_EVENTS) return answer(400)
  const events = batch.flatMap(value => checkEvent(value) ?? [])
  if (events.length === 0) return answer(400)
  // Failing to store answers 503, so the sender keeps the batch and tries again; each event's uuid stops a second copy.
  try { await keep(env.EVENTS, events, now) } catch { return answer(503) }
  if (env.POSTHOG_KEY) context.waitUntil(forward(env, events).catch(() => undefined))
  return answer(204)
}

/** Keeps the copy to its 90 days. Cloudflare's own D1 backups hold what this removes for a while longer (ADR-0179). */
export async function forgetOldEvents(store: ProductEventStore, now: number = Date.now()): Promise<void> {
  await store.prepare('DELETE FROM product_events WHERE received_at < ?').bind(new Date(now - REMOVE_AFTER_DAYS * DAY_MS).toISOString()).run()
}

export default {
  fetch: (request: Request, env: ProductEventsEnv, context: WaitUntil): Promise<Response> => handleProductEvents(request, env, context),
  scheduled: (_controller: unknown, env: ProductEventsEnv, context: WaitUntil): void => { context.waitUntil(forgetOldEvents(env.EVENTS)) },
}
