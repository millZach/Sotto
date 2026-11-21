import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Maximum single transport frame size (64 MiB — accommodates video parts and large attachments). */
export const MAX_ENGINE_FRAME_BYTES = 64 * 1024 * 1024
/** Default handshake timeout for the local engine child to connect and authenticate. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000

export interface SerializedEngineError {
  readonly name: string
  readonly message: string
  readonly code?: string | undefined
  readonly stack?: string | undefined
}

export type EngineWireMessage =
  | { readonly kind: 'hello'; readonly token: string }
  | { readonly kind: 'req'; readonly id: number; readonly method: string; readonly args: readonly unknown[] }
  | { readonly kind: 'res'; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly kind: 'res'; readonly id: number; readonly ok: false; readonly error: SerializedEngineError }
  | { readonly kind: 'push'; readonly event: string; readonly payload: unknown }

interface EncodedBinaryBox {
  readonly __sottoBin: 1
  readonly b64: string
}

function isEncodedBinaryBox(value: unknown): value is EncodedBinaryBox {
  return typeof value === 'object' && value !== null && (value as { __sottoBin?: unknown }).__sottoBin === 1 && typeof (value as { b64?: unknown }).b64 === 'string'
}

/** Encodes a top-level Uint8Array/Buffer for JSON transport without walking nested object trees. */
export function encodeRpcValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { __sottoBin: 1, b64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') } satisfies EncodedBinaryBox
  }
  return value
}

/** Decodes a top-level binary box back to Uint8Array. */
export function decodeRpcValue(value: unknown): unknown {
  if (isEncodedBinaryBox(value)) return new Uint8Array(Buffer.from(value.b64, 'base64'))
  return value
}

export function serializeEngineError(error: unknown): SerializedEngineError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return {
      name: error.name || 'Error',
      message: error.message,
      ...(typeof code === 'string' ? { code } : {}),
      ...(typeof error.stack === 'string' ? { stack: error.stack } : {}),
    }
  }
  return { name: 'Error', message: String(error) }
}

export function deserializeEngineError(serialized: SerializedEngineError): Error {
  const error = new Error(serialized.message)
  error.name = serialized.name || 'Error'
  if (serialized.code !== undefined) (error as { code?: string }).code = serialized.code
  if (serialized.stack !== undefined) error.stack = serialized.stack
  return error
}

/** Generates a per-launch random endpoint: named pipe on Windows, short Unix domain socket path on POSIX. */
export function createEngineEndpoint(prefix = 'sotto-engine', platform: NodeJS.Platform = process.platform): string {
  const suffix = `${process.pid}-${randomBytes(8).toString('hex')}`
  if (platform === 'win32') return `\\\\.\\pipe\\${prefix}-${suffix}`
  return join(tmpdir(), `${prefix}-${suffix}.sock`)
}

/** Generates a 256-bit random hex authentication token passed via environment to the engine process. */
export function generateEngineToken(): string {
  return randomBytes(32).toString('hex')
}

/** Constant-time token verification; never leaks token length or contents. */
export function verifyEngineToken(expected: string, received: unknown): boolean {
  if (typeof received !== 'string' || expected.length === 0) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(received, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Length-prefixed binary frame encoder: 4-byte unsigned big-endian length + UTF-8 JSON payload. */
export function encodeEngineFrame(message: EngineWireMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  if (body.byteLength > MAX_ENGINE_FRAME_BYTES) throw new Error('ENGINE_FRAME_TOO_LARGE')
  const frame = Buffer.allocUnsafe(4 + body.byteLength)
  frame.writeUInt32BE(body.byteLength, 0)
  body.copy(frame, 4)
  return frame
}

/** Incremental parser for length-prefixed JSON frames over any stream. */
export class EngineFrameDecoder {
  private chunks: Buffer[] = []
  private buffered = 0

  push(chunk: Buffer, onMessage: (message: EngineWireMessage) => void): void {
    if (chunk.byteLength === 0) return
    this.chunks.push(chunk)
    this.buffered += chunk.byteLength

    while (this.buffered >= 4) {
      const length = this.peekLength()
      if (length > MAX_ENGINE_FRAME_BYTES) {
        this.chunks = []
        this.buffered = 0
        throw new Error('ENGINE_FRAME_TOO_LARGE')
      }
      if (this.buffered < 4 + length) return
      const payload = this.consume(4 + length).subarray(4)
      const parsed = JSON.parse(payload.toString('utf8')) as EngineWireMessage
      onMessage(parsed)
    }
  }

  private peekLength(): number {
    if (this.chunks[0]!.byteLength >= 4) return this.chunks[0]!.readUInt32BE(0)
    const header = Buffer.allocUnsafe(4)
    let copied = 0
    for (const chunk of this.chunks) {
      const need = Math.min(4 - copied, chunk.byteLength)
      chunk.copy(header, copied, 0, need)
      copied += need
      if (copied === 4) break
    }
    return header.readUInt32BE(0)
  }

  private consume(count: number): Buffer {
    const first = this.chunks[0]!
    if (first.byteLength === count) {
      this.chunks.shift()
      this.buffered -= count
      return first
    }
    if (first.byteLength > count) {
      const slice = first.subarray(0, count)
      this.chunks[0] = first.subarray(count)
      this.buffered -= count
      return slice
    }
    const out = Buffer.allocUnsafe(count)
    let offset = 0
    while (offset < count) {
      const head = this.chunks[0]!
      const take = Math.min(count - offset, head.byteLength)
      head.copy(out, offset, 0, take)
      offset += take
      if (take === head.byteLength) this.chunks.shift()
      else this.chunks[0] = head.subarray(take)
    }
    this.buffered -= count
    return out
  }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer?: ReturnType<typeof setTimeout> | undefined
}

export type EngineRequestHandler = (method: string, args: readonly unknown[]) => unknown | Promise<unknown>
export type EnginePushHandler = (event: string, payload: unknown) => void

/**
 * Full-duplex, language-neutral RPC & push connection over a local OS stream (ADR-0210).
 * Neither payloads nor error details are ever logged here.
 */
export class EngineRpcConnection {
  private readonly decoder: EngineFrameDecoder
  private readonly pending = new Map<number, PendingRequest>()
  private readonly closeListeners = new Set<(error?: Error) => void>()
  private requestHandler: EngineRequestHandler = method => { throw new Error(`ENGINE_METHOD_UNHANDLED: ${method}`) }
  private pushHandler: EnginePushHandler = () => undefined
  private nextId = 1
  private closed = false

  constructor(private readonly socket: Socket, initialDecoder?: EngineFrameDecoder, initialMessages: readonly EngineWireMessage[] = []) {
    this.decoder = initialDecoder ?? new EngineFrameDecoder()
    socket.setNoDelay(true)
    socket.on('data', chunk => {
      try {
        this.decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), message => { this.dispatch(message) })
      } catch (error) {
        this.failAndClose(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.on('error', error => { this.failAndClose(error) })
    socket.on('close', () => { this.failAndClose() })
    if (initialMessages.length > 0) {
      queueMicrotask(() => {
        for (const message of initialMessages) {
          if (this.closed) break
          this.dispatch(message)
        }
      })
    }
  }

  get isClosed(): boolean { return this.closed }

  onRequest(handler: EngineRequestHandler): void { this.requestHandler = handler }
  onPush(handler: EnginePushHandler): void { this.pushHandler = handler }
  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  /** One-way push; skips binary scanning so hot streaming frames serialize directly. */
  sendPush(event: string, payload: unknown): void {
    if (this.closed || this.socket.destroyed) return
    try {
      this.socket.write(encodeEngineFrame({ kind: 'push', event, payload }))
    } catch {
      // Closed or oversized push is dropped; socket error/close handles lifecycle.
    }
  }

  request<T = unknown>(method: string, args: readonly unknown[] = [], timeoutMs?: number): Promise<T> {
    if (this.closed || this.socket.destroyed) {
      return Promise.reject(new Error('Sotto\'s background engine is unavailable. Restart Sotto to continue.'))
    }
    const id = this.nextId++
    const encodedArgs = args.length === 0 ? args : args.map(encodeRpcValue)
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs !== undefined ? setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new Error(`ENGINE_REQUEST_TIMEOUT: ${method}`))
      }, timeoutMs) : undefined
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      try {
        this.socket.write(encodeEngineFrame({ kind: 'req', id, method, args: encodedArgs }))
      } catch (error) {
        if (timer) clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  close(): void {
    if (this.closed) return
    this.failAndClose()
  }

  private dispatch(message: EngineWireMessage): void {
    if (message.kind === 'push') {
      this.pushHandler(message.event, message.payload)
      return
    }
    if (message.kind === 'res') {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (entry.timer) clearTimeout(entry.timer)
      if (message.ok) entry.resolve(decodeRpcValue(message.value))
      else entry.reject(deserializeEngineError(message.error))
      return
    }
    if (message.kind === 'req') {
      const decodedArgs = message.args.length === 0 ? message.args : message.args.map(decodeRpcValue)
      Promise.resolve()
        .then(() => this.requestHandler(message.method, decodedArgs))
        .then(value => {
          if (this.closed || this.socket.destroyed) return
          this.socket.write(encodeEngineFrame({ kind: 'res', id: message.id, ok: true, value: encodeRpcValue(value) }))
        })
        .catch(error => {
          if (this.closed || this.socket.destroyed) return
          this.socket.write(encodeEngineFrame({ kind: 'res', id: message.id, ok: false, error: serializeEngineError(error) }))
        })
    }
  }

  private failAndClose(error?: Error): void {
    if (this.closed) return
    this.closed = true
    if (!this.socket.destroyed) this.socket.destroy()
    const rejection = error ?? new Error('Sotto\'s background engine stopped. Restart Sotto to continue.')
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(rejection)
    }
    this.pending.clear()
    for (const listener of this.closeListeners) listener(error)
    this.closeListeners.clear()
  }
}

export interface EngineServerHandle {
  readonly endpoint: string
  waitForClient(timeoutMs?: number): Promise<EngineRpcConnection>
  close(): Promise<void>
}

/**
 * Opens a single-client authenticated OS IPC server for the local engine child (ADR-0210).
 * Rejects any peer that does not present the exact per-launch token in its very first frame.
 */
export async function listenEngineServer(endpoint: string, token: string): Promise<EngineServerHandle> {
  const isPosix = process.platform !== 'win32'
  let accepted = false
  let waitResolve: ((connection: EngineRpcConnection) => void) | undefined
  let waitReject: ((error: Error) => void) | undefined
  let waitingTimer: ReturnType<typeof setTimeout> | undefined
  let acceptedConnection: EngineRpcConnection | undefined
  let serverClosed = false

  const server: Server = createServer(socket => {
    if (accepted || serverClosed) {
      socket.destroy()
      return
    }
    const decoder = new EngineFrameDecoder()
    let authenticated = false
    const trailing: EngineWireMessage[] = []
    const onData = (chunk: Buffer): void => {
      try {
        decoder.push(chunk, message => {
          if (authenticated) {
            trailing.push(message)
            return
          }
          if (message.kind !== 'hello' || !verifyEngineToken(token, message.token)) {
            socket.destroy()
            return
          }
          authenticated = true
          accepted = true
        })
        if (authenticated && !acceptedConnection) {
          socket.removeListener('data', onData)
          if (waitingTimer) { clearTimeout(waitingTimer); waitingTimer = undefined }
          const connection = new EngineRpcConnection(socket, decoder, trailing)
          acceptedConnection = connection
          server.close()
          if (waitResolve) {
            const resolve = waitResolve
            waitResolve = undefined
            waitReject = undefined
            resolve(connection)
          }
        }
      } catch {
        socket.destroy()
      }
    }
    socket.on('data', onData)
    socket.on('error', () => { socket.destroy() })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  if (isPosix) await chmod(endpoint, 0o600).catch(() => undefined)

  const cleanupEndpoint = async (): Promise<void> => {
    if (isPosix) await unlink(endpoint).catch(() => undefined)
  }

  return {
    endpoint,
    waitForClient(timeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS): Promise<EngineRpcConnection> {
      if (acceptedConnection) return Promise.resolve(acceptedConnection)
      if (serverClosed) return Promise.reject(new Error('ENGINE_SERVER_CLOSED'))
      return new Promise((resolve, reject) => {
        waitResolve = resolve
        waitReject = reject
        waitingTimer = setTimeout(() => {
          waitResolve = undefined
          waitReject = undefined
          reject(new Error('ENGINE_HANDSHAKE_TIMEOUT'))
        }, timeoutMs)
      })
    },
    async close(): Promise<void> {
      if (serverClosed) return
      serverClosed = true
      if (waitingTimer) { clearTimeout(waitingTimer); waitingTimer = undefined }
      if (waitReject) {
        const reject = waitReject
        waitResolve = undefined
        waitReject = undefined
        reject(new Error('ENGINE_SERVER_CLOSED'))
      }
      acceptedConnection?.close()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
      await cleanupEndpoint()
    },
  }
}

/** Connects the engine child to the shell's IPC server and sends the authentication hello frame. */
export async function connectEngineClient(endpoint: string, token: string): Promise<EngineRpcConnection> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const client = createConnection(endpoint)
    client.once('error', reject)
    client.once('connect', () => {
      client.removeListener('error', reject)
      resolve(client)
    })
  })
  socket.write(encodeEngineFrame({ kind: 'hello', token }))
  return new EngineRpcConnection(socket)
}
