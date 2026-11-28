import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { HttpBudgets } from '../../host/httpBudgets'
import { WEBHOOK_BODY_BYTES_MAX, WEBHOOK_CLOCK_SKEW_SECONDS, WEBHOOK_DELIVERY_PATTERN, WEBHOOK_HEADERS } from '../../shared/scheduledTasks'

/**
 * The webhook listener (ADR-0218): `127.0.0.1` only, started while scheduled tasks are on and a task has its webhook
 * turned on. A program on this computer, or one the user carries here over their own tailnet, posts a JSON object to
 * a task's path, signed with that task's secret. Each request names a delivery ID and the time it was signed: the
 * signature covers both and the body, a time more than five minutes from this computer's is refused, and a delivery ID
 * the task has seen starts nothing again. Bodies are capped at 64 KB, requests are counted a minute per task and in
 * all, and a request from a web page (one with an Origin) is refused. A body is data for the run; it never chooses a
 * task, a step or a command, and nothing of it is logged.
 */

export interface WebhookDelivery {
  readonly status: 200 | 202 | 404 | 409
  readonly run?: string
  readonly duplicate?: true
  readonly error?: string
}
export interface WebhookHandler {
  /** The task's secret while its webhook may start a run, or undefined: no such task, its webhook off, or tasks off. */
  secretFor(taskId: string): string | undefined
  /** A verified delivery. */
  deliver(taskId: string, delivery: string, body: Readonly<Record<string, unknown>>): Promise<WebhookDelivery>
}

export const WEBHOOK_TASK_LIMIT = 30
export const WEBHOOK_ALL_LIMIT = 120
const PATH = /^\/v1\/scheduled-tasks\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/runs$/iu
const SIGNATURE = /^sha256=([0-9a-f]{64})$/iu

/** The signature a sender puts in `X-Sotto-Signature`: HMAC-SHA256 of `<timestamp>.<delivery>.<body>` with the task's secret. */
export function webhookSignature(secret: string, timestamp: string, delivery: string, body: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${delivery}.`).update(body).digest('hex')}`
}

function answer(response: ServerResponse, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): void {
  if (response.headersSent) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  response.end(JSON.stringify(body))
}

/** Reads a body to its end, or undefined once it passes the cap. */
function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0, over = false
    request.on('data', (chunk: Buffer) => {
      if (over) return
      size += chunk.length
      if (size > WEBHOOK_BODY_BYTES_MAX) { over = true; chunks.length = 0; resolve(undefined); return }
      chunks.push(chunk)
    })
    request.on('end', () => { if (!over) resolve(Buffer.concat(chunks)) })
    request.on('error', reject)
  })
}

export class WebhookListener {
  private server: Server | undefined
  private starting: Promise<void> | undefined
  private port: number | undefined
  private readonly budgets: HttpBudgets

  constructor(private readonly options: {
    readonly handler: WebhookHandler
    /** The port served last time, tried first. */
    readonly preferredPort?: number | undefined
    readonly now?: () => number
  }) {
    this.budgets = new HttpBudgets(() => this.now())
  }

  private now(): number { return (this.options.now ?? Date.now)() }

  get listening(): boolean { return this.server !== undefined }
  /** Where it listens, such as `http://127.0.0.1:47123`. */
  get address(): string | undefined { return this.port === undefined ? undefined : `http://127.0.0.1:${this.port}` }
  get boundPort(): number | undefined { return this.port }

  start(): Promise<void> {
    if (this.starting) return this.starting
    if (this.server) return Promise.resolve()
    this.starting = this.bind().finally(() => { this.starting = undefined })
    return this.starting
  }

  private async bind(): Promise<void> {
    const server = createServer((request, response) => { void this.handle(request, response).catch(() => answer(response, 500, { error: 'The run could not be started.' })) })
    server.headersTimeout = 10_000; server.requestTimeout = 15_000
    const listen = (port: number): Promise<void> => new Promise((resolve, reject) => {
      const failed = (error: Error): void => { server.off('listening', listening); reject(error) }
      const listening = (): void => { server.off('error', failed); resolve() }
      server.once('error', failed); server.once('listening', listening)
      server.listen(port, '127.0.0.1')
    })
    const preferred = this.options.preferredPort
    try { await listen(preferred ?? 0) } catch (error) { if (preferred === undefined) throw error; await listen(0) }
    this.server = server
    this.port = (server.address() as AddressInfo).port
  }

  async close(): Promise<void> {
    await this.starting?.catch(() => undefined)
    const server = this.server
    this.server = undefined; this.port = undefined
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const match = PATH.exec((request.url ?? '').split('?')[0]!)
    if (request.method !== 'POST' || !match) { request.resume(); return answer(response, 404, { error: 'Not found.' }) }
    // A web page in a browser on this computer can reach loopback; a webhook sender never sends an Origin.
    if (request.headers.origin !== undefined) { request.resume(); return answer(response, 403, { error: 'Requests from web pages are refused.' }) }
    const taskId = match[1]!.toLowerCase()
    const refundTask = this.budgets.spend(`task:${taskId}`, WEBHOOK_TASK_LIMIT)
    if (!refundTask) { request.resume(); return answer(response, 429, { error: 'Too many requests. Try again in a minute.' }, { 'retry-after': '60' }) }
    if (!this.budgets.spend('all', WEBHOOK_ALL_LIMIT)) { refundTask(); request.resume(); return answer(response, 429, { error: 'Too many requests. Try again in a minute.' }, { 'retry-after': '60' }) }
    if (Number(request.headers['content-length'] ?? 0) > WEBHOOK_BODY_BYTES_MAX) { request.resume(); return answer(response, 413, { error: 'The body is longer than 64 KB.' }) }
    const body = await readBody(request)
    if (body === undefined) return answer(response, 413, { error: 'The body is longer than 64 KB.' })
    const header = (name: string): string | undefined => { const value = request.headers[name]; return typeof value === 'string' ? value : undefined }
    const timestamp = header(WEBHOOK_HEADERS.timestamp), delivery = header(WEBHOOK_HEADERS.delivery), signature = SIGNATURE.exec(header(WEBHOOK_HEADERS.signature) ?? '')?.[1]
    if (!timestamp || !/^\d{1,12}$/u.test(timestamp) || !delivery || !WEBHOOK_DELIVERY_PATTERN.test(delivery) || !signature) {
      return answer(response, 401, { error: 'Sign the request: X-Sotto-Timestamp, X-Sotto-Delivery and X-Sotto-Signature are required.' })
    }
    const secret = this.options.handler.secretFor(taskId)
    if (!secret) return answer(response, 404, { error: 'Not found.' })
    if (Math.abs(this.now() / 1000 - Number(timestamp)) > WEBHOOK_CLOCK_SKEW_SECONDS) return answer(response, 401, { error: 'The timestamp is more than five minutes from this computer\'s clock.' })
    const expected = Buffer.from(webhookSignature(secret, timestamp, delivery, body).slice('sha256='.length), 'hex')
    const given = Buffer.from(signature, 'hex')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return answer(response, 401, { error: 'The signature does not match.' })
    let payload: unknown = {}
    if (body.length > 0) {
      try { payload = JSON.parse(body.toString('utf8')) } catch { return answer(response, 400, { error: 'The body is not JSON.' }) }
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return answer(response, 400, { error: 'The body must be a JSON object.' })
    const result = await this.options.handler.deliver(taskId, delivery, payload as Record<string, unknown>)
    answer(response, result.status, { ...result.run ? { run: result.run } : {}, ...result.duplicate ? { duplicate: true } : {}, ...result.error ? { error: result.error } : {} })
  }
}
