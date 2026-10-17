import { z } from 'zod'
import { OpenCodeUncertain } from './opencodeServer'

/**
 * OpenCode answered with an error of its own. `tag` is the error's stable name (`SessionNotFoundError`,
 * `ConflictError`), which the adapter branches on; the message a user reads is always Sotto's, never OpenCode's.
 */
export class OpenCodeRejected extends Error {
  constructor(readonly status: number, readonly tag: string | undefined) { super('OpenCode refused the request.') }
}
/** OpenCode answered with a body Sotto cannot read: the client is ahead of or behind what Sotto checked. */
export class OpenCodeUnreadable extends OpenCodeUncertain {}

const errorSchema = z.looseObject({ _tag: z.string().optional() })
/** One event as OpenCode's stream carries it: a `data:` frame holding this envelope. */
export const opencodeEventSchema = z.looseObject({
  id: z.string().optional(), type: z.string().min(1), created: z.number().optional(), data: z.unknown().optional(),
})
export type OpenCodeEvent = z.infer<typeof opencodeEventSchema>

/** How long a stream may be silent: OpenCode writes a heartbeat every 15 seconds. */
const STREAM_SILENCE_MS = 45_000
/** A runaway guard on one event, sized like the other transports' frame caps. */
const MAX_EVENT_BYTES = 64 * 1024 * 1024
/** "Location plugins did not finish activating": a folder's first request can wait several seconds for this. */
const UNAVAILABLE_RETRY_MS = 30_000

export interface OpenCodeRequest {
  readonly query?: Readonly<Record<string, string | undefined>>
  readonly body?: unknown
  readonly timeoutMs?: number
}

/**
 * OpenCode 2's HTTP API on one server, over Node's own `fetch` (ADR-0087): HTTP Basic as the user `opencode` with the
 * server's password, JSON both ways, and the event stream read as server-sent events. A request that times out is
 * uncertain and never repeated here; only a 503 is retried, which OpenCode answers before it has admitted anything.
 * Every request, and every wait between retries, ends when `closed` aborts: the thread's server is being stopped.
 * Nothing it sends or answers is logged.
 */
export class OpenCodeClient {
  private readonly authorization: string
  constructor(readonly url: string, password: string, private readonly timeoutMs: number, private readonly closed?: AbortSignal) {
    this.authorization = `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`
  }

  /** Wait before retrying, unless the server is being stopped; the timer never keeps Sotto running. */
  private retryAfter(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const closed = this.closed
      if (closed?.aborted) { reject(new OpenCodeUncertain('The OpenCode server was stopped.')); return }
      const stop = (): void => { clearTimeout(timer); reject(new OpenCodeUncertain('The OpenCode server was stopped.')) }
      const timer = setTimeout(() => { closed?.removeEventListener('abort', stop); resolve() }, ms)
      timer.unref()
      closed?.addEventListener('abort', stop, { once: true })
    })
  }

  async request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, options: OpenCodeRequest = {}): Promise<unknown> {
    const query = Object.entries(options.query ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined)
    const target = `${this.url}${path}${query.length ? `?${new URLSearchParams(query).toString()}` : ''}`
    const giveUp = Date.now() + UNAVAILABLE_RETRY_MS
    for (let attempt = 0; ; attempt++) {
      if (this.closed?.aborted) throw new OpenCodeUncertain('The OpenCode server was stopped.')
      const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs)
      let response: Response
      try {
        response = await fetch(target, {
          method, redirect: 'error', signal: this.closed ? AbortSignal.any([timeout, this.closed]) : timeout,
          headers: { authorization: this.authorization, accept: 'application/json', ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}) },
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        })
      } catch { throw new OpenCodeUncertain('OpenCode did not answer in time.') }
      if (response.ok) {
        if (response.status === 204) { await response.body?.cancel().catch(() => undefined); return undefined }
        try { return await response.json() } catch { throw new OpenCodeUnreadable('OpenCode sent a reply Sotto cannot read.') }
      }
      let tag: string | undefined
      try { tag = errorSchema.parse(await response.json())._tag } catch { /* An error without a readable body still has its status. */ }
      if (response.status === 503 && Date.now() < giveUp) { await this.retryAfter(Math.min(250 * (attempt + 1), 1_000)); continue }
      throw new OpenCodeRejected(response.status, tag)
    }
  }

  /**
   * Follow the server's event stream until it ends or `signal` aborts. `connected` resolves on the first frame, which
   * OpenCode sends as soon as the stream is open, so nothing asked after it can be missed. A stream silent past its
   * heartbeat, or one that ends, settles `ended` with an error; an abort settles it without one.
   */
  events(onEvent: (event: OpenCodeEvent) => void, signal: AbortSignal): { connected: Promise<void>; ended: Promise<Error | undefined> } {
    let connect!: () => void, refuse!: (error: Error) => void
    const connected = new Promise<void>((resolve, reject) => { connect = resolve; refuse = reject })
    void connected.catch(() => undefined)
    const ended = (async (): Promise<Error | undefined> => {
      const silence = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const quiet = (): void => { clearTimeout(timer); timer = setTimeout(() => silence.abort(), STREAM_SILENCE_MS) }
      try {
        quiet()
        const response = await fetch(`${this.url}/api/event`, {
          redirect: 'error', signal: AbortSignal.any([signal, silence.signal]),
          headers: { authorization: this.authorization, accept: 'text/event-stream' },
        })
        if (!response.ok || !response.body) { await response.body?.cancel().catch(() => undefined); throw new OpenCodeRejected(response.status, undefined) }
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        // A line still arriving is kept in its pieces and joined once its newline comes, so a long one is never rescanned.
        const partial: string[] = []
        let partialLength = 0, data: string[] = [], dataLength = 0
        const line = (read: string): void => {
          const text = read.endsWith('\r') ? read.slice(0, -1) : read
          if (text === '') {
            if (!data.length) return
            const frame = data.join('\n'); data = []; dataLength = 0
            const event = opencodeEventSchema.safeParse(JSON.parse(frame))
            if (!event.success) throw new OpenCodeUnreadable('OpenCode sent an event Sotto cannot read.')
            connect()
            onEvent(event.data)
          } else if (text.startsWith('data:')) {
            const payload = text.slice(text.startsWith('data: ') ? 6 : 5)
            dataLength += payload.length
            if (dataLength > MAX_EVENT_BYTES) throw new OpenCodeUnreadable('OpenCode sent an event too large to read.')
            data.push(payload)
          }
          // Comments (`: heartbeat`), `event:` and `id:` lines carry nothing Sotto reads.
        }
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          quiet()
          let start = 0
          for (let end = value.indexOf('\n'); end >= 0; end = value.indexOf('\n', start)) {
            const piece = value.slice(start, end)
            start = end + 1
            if (!partial.length) { line(piece); continue }
            partial.push(piece)
            const whole = partial.join(''); partial.length = 0; partialLength = 0
            line(whole)
          }
          if (start < value.length) {
            partialLength += value.length - start
            if (partialLength > MAX_EVENT_BYTES) throw new OpenCodeUnreadable('OpenCode sent an event too large to read.')
            partial.push(start === 0 ? value : value.slice(start))
          }
        }
        throw new OpenCodeUncertain('OpenCode closed its event stream.')
      } catch (error) {
        if (signal.aborted) { refuse(new OpenCodeUncertain('The event stream was closed.')); return undefined }
        const lost = error instanceof OpenCodeUncertain ? error : new OpenCodeUncertain('OpenCode stopped answering on its event stream.')
        refuse(lost)
        return lost
      } finally { clearTimeout(timer) }
    })()
    return { connected, ended }
  }
}

/** A location query as OpenCode reads it, deep-object style. */
export function locationQuery(directory: string): Record<string, string> { return { 'location[directory]': directory } }
