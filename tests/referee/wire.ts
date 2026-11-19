// A host under test, reached the way a phone or a desktop reaches one: started by a command line, paired over HTTP and
// spoken to over its socket, with every message in both directions kept in the order it crossed (docs/host-protocol.md).
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { deflateAccepted, SocketFrames } from '../../src/host/socketFrames'

/**
 * How to start a host: its command line with `{data}` and `{provider}` in place of the data folder and the provider whose
 * fake it runs. Any program that prints the shipped host's ready line (`{ ..., port, event: "ready" }` on stdout) once
 * it listens on loopback, writes `host-listener.json` with its admin bearer, and stops on SIGTERM can be named here.
 */
export type HostCommand = readonly string[]

/** One message that crossed, in the order it crossed. */
export type Crossing =
  | { readonly dir: 'out'; readonly frame: Record<string, unknown> }
  | { readonly dir: 'in'; readonly frame: Record<string, unknown> }

export interface RunningHost {
  readonly port: number
  readonly stderr: () => string
  stop(): Promise<void>
}

/** Starts a host and answers once it says it is ready. Its stderr is kept for a failure to print. */
export async function startHost(command: HostCommand, data: string, provider: string, deadlineMs = 60_000): Promise<RunningHost> {
  const [program, ...args] = command.map(part => part.replaceAll('{data}', data).replaceAll('{provider}', provider))
  if (!program) throw new Error('The host command is empty.')
  const child: ChildProcess = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-20_000) })
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`The host did not say it was ready within ${deadlineMs} ms.\n${stderr}`)) }, deadlineMs)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    void exited.then(() => { clearTimeout(timer); reject(new Error(`The host exited before it was ready.\n${stderr}`)) })
    createInterface({ input: child.stdout! }).on('line', line => {
      let ready: { event?: unknown; port?: unknown }
      try { ready = JSON.parse(line) as typeof ready } catch { return }
      if (ready.event === 'ready' && typeof ready.port === 'number') { clearTimeout(timer); resolve(ready.port) }
    })
  })
  return {
    port, stderr: () => stderr,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      const killed = setTimeout(() => child.kill('SIGKILL'), 20_000)
      await exited
      clearTimeout(killed)
    },
  }
}

/** One HTTP exchange with the host's loopback listener, kept as the referee compares it. */
export interface HttpExchange { readonly method: string; readonly path: string; readonly status: number; readonly body: unknown }

export async function http(port: number, method: 'GET' | 'POST', path: string, options: { bearer?: string; body?: unknown } = {}): Promise<HttpExchange> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { ...(options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {}), ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
  const text = await response.text()
  let body: unknown = text
  try { body = JSON.parse(text) as unknown } catch { /* Kept as text. */ }
  return { method, path, status: response.status, body }
}

/**
 * Pairs one client and opens its session the way the launch script and a phone do (docs/host-protocol.md, "HTTP"): a
 * pairing code from the admin route, the pairing, a session, and the remote-answer policy a person grants on the host.
 */
export async function pairClient(port: number, data: string, name: string): Promise<{ session: string; clientId: string; exchanges: HttpExchange[] }> {
  const listener = JSON.parse(await readFile(join(data, 'host-listener.json'), 'utf8')) as { adminToken?: unknown }
  if (typeof listener.adminToken !== 'string') throw new Error('The host wrote no admin bearer in host-listener.json.')
  const admin = listener.adminToken
  const exchanges: HttpExchange[] = []
  const step = async (method: 'GET' | 'POST', path: string, options: { bearer?: string; body?: unknown } = {}): Promise<Record<string, unknown>> => {
    const exchange = await http(port, method, path, options)
    exchanges.push(exchange)
    // Only the status and an error's code are said: a body can hold a token or a pairing code.
    if (exchange.status !== 200 || exchange.body === null || typeof exchange.body !== 'object') {
      const code = (exchange.body as { error?: { code?: unknown } } | null)?.error?.code
      throw new Error(`${method} ${path} answered ${exchange.status}${typeof code === 'string' ? ` (${code})` : ''}.`)
    }
    return exchange.body as Record<string, unknown>
  }
  await step('GET', '/v1/health')
  const { code } = await step('POST', '/v1/admin/pairing-code', { bearer: admin, body: {} })
  const paired = await step('POST', '/v1/pair', { body: { v: 1, code, name } })
  const opened = await step('POST', '/v1/session', { bearer: String(paired.token) })
  await step('POST', '/v1/admin/allow-answers', { bearer: admin, body: { clientId: paired.clientId } })
  return { session: String(opened.session), clientId: String(paired.clientId), exchanges }
}

/** The extension offer the desktop's client sends (`socketHostService.ts`), so compressed messages are read as it reads them. */
export const DESKTOP_DEFLATE_OFFER = 'permessage-deflate; client_no_context_takeover; server_no_context_takeover'

export interface Socket {
  /** Every message in both directions, in the order it crossed. */
  readonly crossings: Crossing[]
  /** What the host answered the extension offer with, or undefined. */
  readonly extensions: string | undefined
  send(frame: Record<string, unknown>): void
  /** Called after each message that arrives, so a waiting step reads it at once rather than on a timer. */
  onArrival(listener: () => void): () => void
  close(): void
}

/**
 * Opens the socket as a client of another codebase would, over `SocketFrames`, the codec the desktop's own client uses.
 * `tamper`, for the harness's own tests only, changes what arrives before anything reads it: the referee then sees a
 * host that sent exactly that.
 */
export async function openSocket(port: number, session: string, offer: string | undefined, tamper?: (frame: Record<string, unknown>, emit: (frame: Record<string, unknown>) => void) => void): Promise<Socket> {
  const key = randomBytes(16).toString('base64')
  const crossings: Crossing[] = []
  const listeners = new Set<() => void>()
  const arrive = (frame: Record<string, unknown>): void => { crossings.push({ dir: 'in', frame }); for (const listener of listeners) listener() }
  let extensions: string | undefined
  const frames = await new Promise<SocketFrames>((resolve, reject) => {
    const request = httpRequest(`http://127.0.0.1:${port}/v1/socket`, { headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key, ...(offer ? { 'Sec-WebSocket-Extensions': offer } : {}), Authorization: `Bearer ${session}` } })
    request.on('error', reject)
    request.on('response', response => reject(new Error(`The socket upgrade was answered ${response.statusCode}.`)))
    request.on('upgrade', (response, stream, head) => {
      // The accept key RFC 6455 section 4.2.2 names, which the desktop's own client checks before it reads anything.
      const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      if (response.headers['sec-websocket-accept'] !== expected) { stream.destroy(); reject(new Error('The host answered the socket upgrade with the wrong Sec-WebSocket-Accept.')); return }
      const answered = response.headers['sec-websocket-extensions']
      extensions = typeof answered === 'string' ? answered : undefined
      const socket = new SocketFrames(stream, true, text => {
        const frame = JSON.parse(text) as Record<string, unknown>
        if (tamper) tamper(frame, arrive); else arrive(frame)
      }, { deflate: offer !== undefined && deflateAccepted(answered) === true })
      socket.onClose(() => { for (const listener of listeners) listener() })
      socket.feed(head); resolve(socket)
    })
    request.end()
  })
  return {
    crossings, extensions,
    send: frame => { crossings.push({ dir: 'out', frame }); frames.send(frame) },
    onArrival: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    close: () => frames.close(),
  }
}
