import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { CLOUD_BUTTONS, CLOUD_KEYS } from '../../../shared/cloudIphone'

/** A simulator build, once run.cloud has accepted it. */
export interface CloudStartedSession { id: string; viewerUrl: string; device: string }
/**
 * Sotto's own interaction vocabulary (ADR-0047): `x`/`y`/`toX`/`toY` are 0..1 fractions of the screen, and `key`/
 * `button` use Sotto's `CLOUD_KEYS`/`CLOUD_BUTTONS` names. Only `RunCloudClient` knows run.cloud's own flat wire
 * shape and its key and button names; nothing outside this file does.
 */
export type CloudInteraction =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'swipe'; x: number; y: number; toX: number; toY: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; key: (typeof CLOUD_KEYS)[number] }
  | { kind: 'button'; button: (typeof CLOUD_BUTTONS)[number] }
export interface CloudAccessibilityNode {
  role?: string | null; label?: string | null; value?: string | null; identifier?: string | null
  bounds: { x: number; y: number; width: number; height: number } | null
  states?: Record<string, unknown>
  children?: CloudAccessibilityNode[]
}
export interface CloudAccessibilitySnapshot { screen: { width: number; height: number }; roots: CloudAccessibilityNode[] }

/**
 * run.cloud sits behind this one adapter (ADR-0047): every route it answers lives here, in Node's own
 * `fetch`, so the rest of Sotto addresses a cloud iPhone by its Sotto session, never by run.cloud's IDs.
 * Every failure becomes a plain `Error` that never repeats the key, a viewer URL or a raw response body.
 */
export interface CloudDeviceProvider {
  /** Throws a plain error when the key is not one run.cloud accepts. */
  checkKey(): Promise<void>
  /** Uploads a simulator build and returns run.cloud's asset ID. */
  upload(filePath: string): Promise<string>
  deleteAsset(assetId: string): Promise<void>
  start(options: { assetId: string; displayName: string; tags?: Record<string, string> }): Promise<CloudStartedSession>
  get(id: string): Promise<{ status: string }>
  release(id: string): Promise<void>
  interact(id: string, action: CloudInteraction): Promise<void>
  openUrl(id: string, url: string): Promise<void>
  screenshot(id: string): Promise<Buffer>
  accessibility(id: string): Promise<CloudAccessibilitySnapshot>
  keepAlive(id: string): Promise<void>
}

class RunCloudHttpError extends Error { constructor(message: string, readonly status: number) { super(message) } }

/** run.cloud's own key names for Sotto's keys and buttons; this mapping never leaves the adapter. */
const KEY_MAP: Record<(typeof CLOUD_KEYS)[number], string> = { Enter: 'enter', Backspace: 'backspace', Tab: 'tab', Escape: 'escape', ArrowUp: 'arrowUp', ArrowDown: 'arrowDown', ArrowLeft: 'arrowLeft', ArrowRight: 'arrowRight' }
const BUTTON_MAP: Record<(typeof CLOUD_BUTTONS)[number], string> = { home: 'home', appSwitcher: 'appSwitcher', lock: 'power', volumeUp: 'volumeUp', volumeDown: 'volumeDown' }
function flattenInteraction(action: CloudInteraction): Record<string, unknown> {
  if (action.kind === 'tap') return { action: 'tap', x: action.x, y: action.y }
  if (action.kind === 'swipe') return { action: 'swipe', from: { x: action.x, y: action.y }, to: { x: action.toX, y: action.toY } }
  if (action.kind === 'type') return { action: 'typeText', text: action.text }
  if (action.kind === 'key') return { action: 'pressKey', key: KEY_MAP[action.key] }
  return { action: 'pressButton', button: BUTTON_MAP[action.button] }
}

/** A URL, a run.cloud bearer-like token, or a long base64/hex run, so none ever reaches a user-facing message. */
const URL_PATTERN = /https?:\/\/\S+/gu
const TOKEN_PATTERN = /rc_[A-Za-z0-9_-]+/gu
const CREDENTIAL_RUN_PATTERN = /\b[A-Za-z0-9+/_-]{20,}\b/gu
const MAX_MESSAGE_LENGTH = 300
/** run.cloud's own wording never reaches the user verbatim (AGENTS.md: no error codes, nothing private logged). */
function sanitize(message: string): string {
  const scrubbed = message.replace(URL_PATTERN, 'an address').replace(TOKEN_PATTERN, 'a credential').replace(CREDENTIAL_RUN_PATTERN, 'a credential')
  return scrubbed.length > MAX_MESSAGE_LENGTH ? `${scrubbed.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : scrubbed
}

function md5(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5')
    createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk: Buffer) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
  })
}

function errorDetail(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const row = body as Record<string, unknown>
  const inner = row.error
  if (typeof inner === 'object' && inner !== null && typeof (inner as Record<string, unknown>).message === 'string') return (inner as Record<string, unknown>).message as string
  if (typeof inner === 'string') return inner
  if (typeof row.detail === 'string') return row.detail
  if (typeof row.message === 'string') return row.message
  return undefined
}

/** `fetch` against run.cloud's one documented host, with a bearer key main alone holds. */
export class RunCloudClient implements CloudDeviceProvider {
  private readonly baseUrl: string
  constructor(private readonly key: string, options?: { baseUrl?: string }) {
    this.baseUrl = options?.baseUrl ?? process.env.SOTTO_RUN_CLOUD_API_URL ?? 'https://api.run.cloud'
  }
  /**
   * A path on run.cloud's API, or an absolute URL it handed back (an upload's finalize address) only when that URL
   * is on the same origin: the bearer key goes to run.cloud's API and nowhere else.
   */
  private url(path: string): string {
    if (!/^https?:\/\//u.test(path)) return `${this.baseUrl}${path}`
    if (new URL(path).origin !== new URL(this.baseUrl).origin) throw new Error('run.cloud pointed the upload somewhere else. Nothing was sent there.')
    return path
  }
  private async raw(path: string, init: RequestInit = {}, auth = true): Promise<Response> {
    let response: Response
    const target = this.url(path)
    try {
      response = await fetch(target, { ...init, headers: { ...(auth ? { Authorization: `Bearer ${this.key}` } : {}), ...(init.headers as Record<string, string> | undefined) } })
    } catch { throw new Error('Could not reach run.cloud. Check your connection and try again.') }
    if (!response.ok) {
      if (response.status === 503) throw new RunCloudHttpError('run.cloud has no simulator free right now. Nothing was charged. Try again.', 503)
      let message = 'run.cloud could not complete that request.'
      try { const detail = errorDetail(await response.clone().json()); if (detail) message = sanitize(detail) } catch { /* not a JSON body */ }
      throw new RunCloudHttpError(message, response.status)
    }
    return response
  }
  private async call<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
    const response = await this.raw(path, init, auth)
    try { return await response.json() as T }
    catch { throw new Error('run.cloud sent an answer Sotto could not read.') }
  }
  async checkKey(): Promise<void> { await this.call('/run-cloud/account') }
  private async putAsset(url: string, headers: Record<string, string>, filePath: string): Promise<void> {
    let response: Response
    // A Node Readable is an async iterable of Buffer, a valid streaming body; the DOM-oriented BodyInit and
    // RequestInit typings used elsewhere in this compilation do not say so, hence the two casts.
    const init: RequestInit & { duplex: 'half' } = { method: 'PUT', headers, body: createReadStream(filePath) as unknown as BodyInit, duplex: 'half' }
    try { response = await fetch(url, init) }
    catch { throw new Error('Could not upload the build to run.cloud. Check your connection and try again.') }
    if (!response.ok) throw new Error('run.cloud rejected the build upload. Nothing was charged for simulator time.')
  }
  private async uploadMultipart(filePath: string): Promise<string> {
    const data = await readFile(filePath)
    const form = new FormData()
    form.append('name', basename(filePath))
    form.append('file', new Blob([data]), basename(filePath))
    const created = await this.call<{ asset?: { id: string }; id?: string }>('/run-cloud/assets', { method: 'POST', body: form })
    const id = created.asset?.id ?? created.id
    if (!id) throw new Error('run.cloud did not confirm the build upload.')
    return id
  }
  async upload(filePath: string): Promise<string> {
    const stats = await stat(filePath)
    const checksum = await md5(filePath)
    const payload = { filename: basename(filePath), contentType: 'application/octet-stream', byteSize: stats.size, uploadBatchId: randomUUID(), uploadRunId: randomUUID(), checksum: { algorithm: 'md5', value: checksum } }
    let created: { reused?: boolean; asset?: { id: string }; upload?: { url: string; headers: Record<string, string>; finalizeUrl: string } }
    try { created = await this.call('/run-cloud/assets/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) }
    catch (error) {
      if (error instanceof RunCloudHttpError && error.status === 404) return this.uploadMultipart(filePath)
      throw error
    }
    if (created.reused || !created.upload) {
      if (!created.asset?.id) throw new Error('run.cloud did not confirm the build upload.')
      return created.asset.id
    }
    await this.putAsset(created.upload.url, created.upload.headers, filePath)
    const startedAt = Date.now()
    // Finalize failing here, or answering without an asset ID, leaves nothing for Sotto to delete by: the upload
    // may be sitting in run.cloud's own dashboard, and the message says so rather than claiming it is clean.
    let finalized: { asset?: { id: string } }
    try { finalized = await this.call<{ asset?: { id: string } }>(created.upload.finalizeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checksum: payload.checksum, startedAt, durationMs: Date.now() - startedAt, retries: 0 }) }) }
    catch (error) { throw new Error(`run.cloud could not confirm the build upload. It may remain in your run.cloud dashboard. ${(error as Error).message}`, { cause: error }) }
    if (!finalized.asset?.id) throw new Error('run.cloud did not confirm the build upload. It may remain in your run.cloud dashboard.')
    return finalized.asset.id
  }
  async deleteAsset(assetId: string): Promise<void> { await this.call(`/run-cloud/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' }) }
  async start(options: { assetId: string; displayName: string; tags?: Record<string, string> }): Promise<CloudStartedSession> {
    const body = { model: 'iphone', displayName: options.displayName, ...(options.tags ? { tags: options.tags } : {}), installAssets: [options.assetId], inactivityTimeout: 'none', hardTimeout: '1h' }
    const created = await this.call<{ id?: string; url?: string; device?: string; osVersion?: string }>('/run-cloud/ios', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) })
    if (created.id && !created.url) {
      // An ID without a usable address is ambiguous, not a device: release it rather than leave it running unseen.
      await this.release(created.id).catch(() => undefined)
      throw new Error('run.cloud started a simulator but did not return its address. Sotto released it; nothing should be left running.')
    }
    if (!created.id || !created.url) throw new Error('run.cloud did not start the simulator. Nothing was charged for simulator time.')
    const device = [created.device, created.osVersion ? `iOS ${created.osVersion}` : undefined].filter(Boolean).join(' · ') || 'iPhone simulator'
    return { id: created.id, viewerUrl: created.url, device }
  }
  async get(id: string): Promise<{ status: string }> {
    const got = await this.call<{ status?: string }>(`/run-cloud/ios/${encodeURIComponent(id)}`)
    return { status: got.status ?? 'unknown' }
  }
  async release(id: string): Promise<void> { await this.call(`/run-cloud/ios/${encodeURIComponent(id)}`, { method: 'DELETE' }) }
  async interact(id: string, action: CloudInteraction): Promise<void> {
    const result = await this.call<{ ok?: boolean; error?: { message?: string } }>(`/run-cloud/ios/${encodeURIComponent(id)}/interactions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), ...flattenInteraction(action) }) })
    if (result.ok === false) throw new Error(sanitize(result.error?.message ?? 'run.cloud could not complete that action.'))
  }
  async openUrl(id: string, url: string): Promise<void> {
    await this.call(`/run-cloud/ios/${encodeURIComponent(id)}/open-url`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
  }
  async screenshot(id: string): Promise<Buffer> {
    const response = await this.raw(`/run-cloud/ios/${encodeURIComponent(id)}/screenshot`)
    return Buffer.from(await response.arrayBuffer())
  }
  async accessibility(id: string): Promise<CloudAccessibilitySnapshot> {
    const body = await this.call<{ screen?: { width: number; height: number }; roots?: CloudAccessibilityNode[] }>(`/run-cloud/ios/${encodeURIComponent(id)}/accessibility`)
    if (!body.screen) throw new Error('run.cloud did not report the simulator’s screen size.')
    return { screen: { width: body.screen.width, height: body.screen.height }, roots: body.roots ?? [] }
  }
  async keepAlive(id: string): Promise<void> {
    await this.call(`/run-cloud/ios/${encodeURIComponent(id)}/activity`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
  }
}
