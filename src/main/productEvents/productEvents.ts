import { randomUUID } from 'node:crypto'
import type { ProductEventPermission } from '../../shared/hostProtocol'
import type { ProductEventsOffBy } from '../../shared/productEvents'
import { deleteInstallId, ensureInstallId, productEventHomes, readProductEventOwners, type ProductEventOwner } from './identity'
import { parseProductEvent, parseProductEventInstall, productEventArch, productEventPlatform, type ProductEventInstall, type ProductEventName, type ProductEventProperties } from './schema'

/**
 * Product events on their way out (ADR-0179). `record` runs on a thread's turn or a user's press, so it checks the event
 * against its schema, pushes it and returns; nothing else happens on that path. A timer sends one batch at a time, armed
 * only while something waits, so an idle Sotto does no work for this. Failing to send costs a retry later and is never seen.
 * Delivery's limits follow T3 Code's AnalyticsService (MIT, see THIRD_PARTY_NOTICES.md).
 */

/**
 * `off` drops what waits and leaves no install ID. `waiting` is a question not yet answered: the desktop keeps nothing
 * before the notice is answered, and a host holds events in memory until a desktop tells it. `on` sends.
 */
export type { ProductEventPermission }

const SEND_EVERY_MS = 30_000
const BATCH_SIZE = 20
const MAX_WAITING_EVENTS = 1_000
const FEATURE_USED_EVERY_MS = 24 * 60 * 60 * 1000
const SEND_TIMEOUT_MS = 10_000
const RETRY_BASE_MS = 2_000
const RETRY_MAX_MS = 5 * 60_000
/** A batch that has failed for this long is dropped, so one stuck batch is not sent for days. */
const GIVE_UP_AFTER_MS = 30 * 60_000
/** These statuses refuse the batch itself; sending it again cannot help. */
const REFUSED_STATUSES = new Set([400, 401, 403, 413, 422])

/** The variable that turned product events off, if one did. The environment's answer outranks the switch. */
export function productEventsOffBy(environment: NodeJS.ProcessEnv): ProductEventsOffBy | null {
  const off = (value: string | undefined): boolean => /^(false|0|off|no)$/i.test(value?.trim() ?? '')
  if (off(environment.SOTTO_TELEMETRY_ENABLED)) return 'SOTTO_TELEMETRY_ENABLED'
  const doNotTrack = environment.DO_NOT_TRACK?.trim()
  return doNotTrack !== undefined && doNotTrack !== '' && !off(doNotTrack) ? 'DO_NOT_TRACK' : null
}

/** `SOTTO_TELEMETRY_ENABLED=false` or `DO_NOT_TRACK=1` turns product events off. */
export function productEventsOffByEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return productEventsOffBy(environment) !== null
}

/** Where a released build's events go: the Worker in `workers/product-events/`. The notice ships in the same release. */
export const PRODUCT_EVENTS_ENDPOINT = 'https://events.saysotto.com'

/** The endpoint, or null for none. The environment can name another for a test run, over HTTPS or to this computer only. */
export function productEventsEndpoint(environment: NodeJS.ProcessEnv, builtIn: string | null = null): string | null {
  const named = environment.SOTTO_PRODUCT_EVENTS_ENDPOINT?.trim()
  if (!named) return builtIn
  try {
    const url = new URL(named)
    const local = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost')
    return url.protocol === 'https:' || local ? url.href.replace(/\/+$/, '') : null
  } catch { return null }
}

interface WaitingEvent {
  readonly uuid: string
  readonly event: ProductEventName
  readonly properties: Record<string, unknown>
  readonly timestamp: string
}

export type ProductEventsLogEvent = 'product-events-event-refused' | 'product-events-batch-dropped'

export interface ProductEventsOptions {
  readonly endpoint: string | null
  readonly install: ProductEventInstall
  readonly dataDirectory: string
  readonly environment: NodeJS.ProcessEnv
  /** A host holds events while it waits for a desktop's answer; the desktop keeps nothing before its notice is answered. */
  readonly holdWhileWaiting: boolean
  readonly homes: { readonly claudeFile: string; readonly codexHome: string }
  /** Stable event names only: never a field, an ID or a status. */
  readonly log?: (event: ProductEventsLogEvent) => void
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly random?: () => number
  readonly sendEveryMs?: number
  readonly readOwners?: (homes: ProductEventsOptions['homes']) => Promise<readonly ProductEventOwner[]>
}

export class ProductEvents {
  private permission: ProductEventPermission = 'waiting'
  private readonly install: ProductEventInstall | null
  private readonly dark: boolean
  /** Everything not yet sent, oldest first. An event leaves only once its batch went or was given up on. */
  private waiting: WaitingEvent[] = []
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private flushing = false
  private sending: AbortController | null = null
  /** Bumped whenever sending stops, so an ID, a read or a send started before that cannot act after it. */
  private generation = 0
  private distinctId: string | null = null
  private ownersRead = false
  private failures = 0
  private firstFailureAt = 0
  private retryAt = 0
  private removingId: Promise<void> = Promise.resolve()
  private readonly featuresAt = new Map<string, number>()
  private readonly fetcher: typeof fetch
  private readonly now: () => number
  private readonly random: () => number

  constructor(private readonly options: ProductEventsOptions) {
    this.install = parseProductEventInstall(options.install)
    this.dark = options.endpoint === null || this.install === null || productEventsOffByEnvironment(options.environment)
    this.fetcher = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    // The environment turned off means off from the first moment, including an ID left by an earlier run.
    if (productEventsOffByEnvironment(options.environment)) this.removingId = deleteInstallId(options.dataDirectory)
  }

  /** The current answer. Safe to call as often as settings change: only a real change does anything. */
  setPermission(permission: ProductEventPermission): void {
    if (this.dark && permission !== 'off') return
    const previous = this.permission
    if (permission === previous) return
    this.permission = permission
    if (permission === 'on') { this.arm(); return }
    // A host whose desktop has gone keeps what it holds and its ID (`productEventsHostFollower` turns it off first when a desktop asks again).
    // Off, or the desktop's own notice asking again, keeps neither.
    if (permission === 'waiting' && (this.options.holdWhileWaiting || previous === 'off')) this.stopSending()
    else this.forget()
  }

  private keeping(): boolean {
    return !this.dark && !this.stopped && this.permission !== 'off' && (this.permission !== 'waiting' || this.options.holdWhileWaiting)
  }

  /** One event, checked against its schema. It never throws and does no I/O. */
  record<E extends ProductEventName>(event: E, properties: ProductEventProperties<E>): void {
    if (!this.keeping()) return
    try {
      const allowed = parseProductEvent(event, properties)
      if (!allowed) { this.options.log?.('product-events-event-refused'); return }
      this.waiting.push({ uuid: randomUUID(), event, properties: allowed as Record<string, unknown>, timestamp: new Date(this.now()).toISOString() })
      if (this.waiting.length > MAX_WAITING_EVENTS) this.waiting.shift()
      if (this.permission === 'on') this.arm()
    } catch { /* A product event never gets in a thread's way. */ }
  }

  /**
   * That a feature was used, at most once a day per feature while Sotto runs, and once more after a start: whether this
   * install used it, rather than how often. The number of Watcher, delegated, Council and swarm threads is in
   * `thread.started`. It does no I/O, so a call site that runs often costs a look-up, and that is why a start forgets.
   */
  featureUsed(feature: ProductEventProperties<'feature.used'>['feature']): void {
    if (!this.keeping()) return
    const at = this.now(), last = this.featuresAt.get(feature)
    if (last !== undefined && at - last < FEATURE_USED_EVERY_MS) return
    this.featuresAt.set(feature, at)
    this.record('feature.used', { feature })
  }

  /** At quit: one last batch that nothing waits for. */
  stop(): void {
    if (this.stopped) return
    this.disarm()
    if (this.permission === 'on' && this.distinctId && this.waiting.length > 0 && this.failures === 0) void this.send(this.nextBatch()).catch(() => undefined)
    this.stopped = true
  }

  /** Whether this build can send at all: it has an endpoint and its environment has not turned product events off. */
  get canSend(): boolean { return !this.dark }

  /** What is waiting to go. */
  get waitingCount(): number { return this.waiting.length }

  /** Sends one batch if one is due. The timer calls it; tests can too. */
  async flush(): Promise<void> {
    if (this.dark || this.stopped || this.permission !== 'on' || this.flushing) return
    if (this.now() < this.retryAt) return
    this.flushing = true
    try { await this.sendDue(this.generation) } finally { this.flushing = false }
  }

  private async sendDue(generation: number): Promise<void> {
    if (this.distinctId === null) {
      await this.removingId
      if (!this.isOn(generation)) return
      const made = await ensureInstallId(this.options.dataDirectory)
      if (generation !== this.generation) { if (made && this.permission !== 'on') this.removingId = this.removingId.then(() => deleteInstallId(this.options.dataDirectory)); return }
      this.distinctId = made
      if (made === null) return
    }
    if (!this.ownersRead && !await this.observeOwners(generation)) return
    const batch = this.nextBatch()
    if (batch.length === 0) return
    const outcome = await this.send(batch)
    if (!this.isOn(generation)) return
    if (outcome === 'sent') { this.leave(batch); this.failures = 0; this.firstFailureAt = 0; this.retryAt = 0; return }
    const now = this.now()
    if (this.firstFailureAt === 0) this.firstFailureAt = now
    this.failures += 1
    const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.failures - 1))
    this.retryAt = now + Math.round(ceiling / 2 + (ceiling / 2) * this.random())
    if (outcome === 'refused' || now - this.firstFailureAt >= GIVE_UP_AFTER_MS) {
      this.options.log?.('product-events-batch-dropped')
      this.leave(batch)
      this.firstFailureAt = 0
    }
  }

  private isOn(generation: number): boolean { return generation === this.generation && this.permission === 'on' && !this.stopped }

  /** Nothing more goes until the answer is on again. A send in flight is aborted; its events stay and keep their IDs. */
  private stopSending(): void {
    this.generation += 1
    this.disarm()
    this.sending?.abort()
    this.sending = null
  }

  /** Off, or asking again: nothing waits, no ID stays, and no read or send started before this can finish after it. */
  private forget(): void {
    this.stopSending()
    this.waiting = []
    this.featuresAt.clear()
    this.failures = 0; this.firstFailureAt = 0; this.retryAt = 0
    this.distinctId = null
    this.ownersRead = false
    this.removingId = this.removingId.then(() => deleteInstallId(this.options.dataDirectory))
  }

  /** Each account once per run of this process. A file that cannot be read leaves that account out until the next start. */
  private async observeOwners(generation: number): Promise<boolean> {
    const read = this.options.readOwners ?? readProductEventOwners
    const owners = await read(this.options.homes).catch(() => [] as readonly ProductEventOwner[])
    if (!this.isOn(generation)) return false
    this.ownersRead = true
    for (const owner of owners) this.record('install.owner_observed', owner)
    return true
  }

  private nextBatch(): WaitingEvent[] { return this.waiting.slice(0, BATCH_SIZE) }

  /** A batch that went or was given up on leaves the queue, whichever of its events a full queue has not already pushed out. */
  private leave(batch: readonly WaitingEvent[]): void {
    const gone = new Set(batch.map(event => event.uuid))
    this.waiting = this.waiting.filter(event => !gone.has(event.uuid))
  }

  private async send(batch: readonly WaitingEvent[]): Promise<'sent' | 'failed' | 'refused'> {
    const endpoint = this.options.endpoint
    const distinctId = this.distinctId
    if (endpoint === null || distinctId === null) return 'failed'
    const controller = new AbortController()
    this.sending = controller
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)
    timeout.unref?.()
    try {
      const body = JSON.stringify({ batch: batch.map(event => ({
        uuid: event.uuid, event: event.event, distinct_id: distinctId, timestamp: event.timestamp,
        properties: { ...event.properties, ...this.install, $process_person_profile: false, $geoip_disable: true },
      })) })
      const response = await this.fetcher(`${endpoint}/batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: controller.signal })
      void response.body?.cancel().catch(() => undefined)
      if (response.ok) return 'sent'
      return REFUSED_STATUSES.has(response.status) ? 'refused' : 'failed'
    } catch { return 'failed' } finally {
      clearTimeout(timeout)
      if (this.sending === controller) this.sending = null
    }
  }

  private arm(): void {
    if (this.timer || this.stopped || this.dark) return
    if (this.waiting.length === 0 && this.ownersRead) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush().catch(() => undefined).finally(() => { if (this.permission === 'on') this.arm() })
    }, this.options.sendEveryMs ?? SEND_EVERY_MS)
    this.timer.unref?.()
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

/** The answer the desktop's two settings give. Sending waits for a press on the notice (ADR-0179). */
export function productEventsPermission(settings: { readonly productEventsEnabled: boolean; readonly productEventsNoticeAnswered: boolean }, environment: NodeJS.ProcessEnv = process.env): ProductEventPermission {
  // A desktop off by its environment says off to its hosts too, not only to itself.
  if (productEventsOffByEnvironment(environment)) return 'off'
  return !settings.productEventsEnabled ? 'off' : settings.productEventsNoticeAnswered ? 'on' : 'waiting'
}

/** What a host does with what its connected desktops answered (ADR-0179): any off wins, then any on, otherwise it waits. */
export function productEventsFromDesktops(answers: readonly ProductEventPermission[]): ProductEventPermission {
  return answers.includes('off') ? 'off' : answers.includes('on') ? 'on' : 'waiting'
}

/**
 * How a host follows its desktops' answers (ADR-0179). No desktop connected keeps what it holds and its ID. A connected desktop
 * still asking, once this host was on, is that desktop's Reset settings, so neither stays. An ID made after one was deleted has
 * had no start said for it, so the next on says it.
 */
export function productEventsHostFollower(events: Pick<ProductEvents, 'setPermission' | 'record'>): (answers: readonly ProductEventPermission[]) => void {
  let current: ProductEventPermission = 'waiting'
  let startHeld = true
  return answers => {
    const next = productEventsFromDesktops(answers)
    if (next === current) return
    if (next === 'off' || (current === 'on' && next === 'waiting' && answers.length > 0)) { events.setPermission('off'); startHeld = false }
    events.setPermission(next)
    if (next === 'on') {
      if (!startHeld) events.record('app.started', { pairedHosts: 0 })
      startHeld = true
    }
    current = next
  }
}

/** The sender for this process. Only a released build has the endpoint, so a development or test build sends nothing unless its environment names one. */
export function createProductEvents(options: Pick<ProductEventsOptions, 'dataDirectory' | 'holdWhileWaiting' | 'log'> & {
  readonly version: string; readonly channel: ProductEventInstall['channel']; readonly surface: ProductEventInstall['surface']
  readonly released: boolean
  readonly environment?: NodeJS.ProcessEnv
}): ProductEvents {
  const environment = options.environment ?? process.env
  return new ProductEvents({
    endpoint: productEventsEndpoint(environment, options.released ? PRODUCT_EVENTS_ENDPOINT : null), dataDirectory: options.dataDirectory, holdWhileWaiting: options.holdWhileWaiting, environment,
    homes: productEventHomes(environment), ...options.log ? { log: options.log } : {},
    install: { appVersion: options.version, channel: options.channel, surface: options.surface, platform: productEventPlatform(process.platform), arch: productEventArch(process.arch) },
  })
}
