import type { Readable, Writable } from 'node:stream'

/**
 * The Chrome DevTools Protocol over `--remote-debugging-pipe` (ADR-0198): the browser reads commands from its
 * fourth file descriptor and writes answers and events to its fifth, each message JSON ended by a NUL. Only the
 * Sotto that started the browser holds these pipes, so nothing else on the host can drive it. Nothing here logs:
 * messages carry page addresses, text and pictures.
 */
export type DevToolsEventListener = (method: string, params: Record<string, unknown>, sessionId: string | undefined) => void

/** One message may be at most this large: a full-page PNG capture, base64, with room to spare. */
export const DEVTOOLS_MESSAGE_LIMIT = 64 * 1024 * 1024

/** A command the browser answered with an error, in the protocol's own words. */
export class DevToolsError extends Error {
  constructor(readonly method: string, readonly code: number | undefined, message: string) { super(message) }
}

interface Pending { readonly method: string; resolve(value: unknown): void; reject(error: Error): void }

export class DevToolsPipe {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<DevToolsEventListener>()
  private readonly closeListeners = new Set<() => void>()
  private chunks: Buffer[] = []
  private buffered = 0
  private ended = false

  constructor(private readonly toBrowser: Writable, fromBrowser: Readable) {
    fromBrowser.on('data', (chunk: Buffer) => this.receive(chunk))
    fromBrowser.on('end', () => this.close())
    fromBrowser.on('close', () => this.close())
    fromBrowser.on('error', () => this.close())
    toBrowser.on('error', () => this.close())
  }

  get closed(): boolean { return this.ended }

  /** One command, to the browser itself or, with `sessionId`, to one page's session. */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (this.ended) return Promise.reject(new DevToolsError(method, undefined, 'The browser has closed.'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject })
      const message = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
      this.toBrowser.write(message + '\0', error => {
        if (!error) return
        this.pending.delete(id)
        reject(new DevToolsError(method, undefined, 'The browser has closed.'))
      })
    })
  }

  on(listener: DevToolsEventListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  onClose(listener: () => void): () => void {
    if (this.ended) { listener(); return () => undefined }
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  /** Ends the connection: every command still waiting fails, and nothing more is read. */
  close(): void {
    if (this.ended) return
    this.ended = true
    this.chunks = []; this.buffered = 0
    for (const pending of this.pending.values()) pending.reject(new DevToolsError(pending.method, undefined, 'The browser has closed.'))
    this.pending.clear()
    this.listeners.clear()
    for (const listener of [...this.closeListeners]) listener()
    this.closeListeners.clear()
    if (!this.toBrowser.destroyed) this.toBrowser.end()
  }

  private receive(chunk: Buffer): void {
    if (this.ended) return
    let start = 0
    for (let end = chunk.indexOf(0, start); end !== -1; end = chunk.indexOf(0, start)) {
      this.chunks.push(chunk.subarray(start, end))
      const message = Buffer.concat(this.chunks)
      this.chunks = []; this.buffered = 0
      start = end + 1
      this.dispatch(message)
      if (this.ended) return
    }
    if (start < chunk.length) {
      this.buffered += chunk.length - start
      if (this.buffered > DEVTOOLS_MESSAGE_LIMIT) { this.close(); return }
      this.chunks.push(chunk.subarray(start))
    }
  }

  private dispatch(raw: Buffer): void {
    let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown }; sessionId?: unknown }
    try { message = JSON.parse(raw.toString('utf8')) as typeof message } catch { this.close(); return }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new DevToolsError(pending.method, typeof message.error.code === 'number' ? message.error.code : undefined, typeof message.error.message === 'string' ? message.error.message : 'The browser refused the command.'))
      else pending.resolve(message.result ?? {})
      return
    }
    if (typeof message.method !== 'string') return
    const params = message.params && typeof message.params === 'object' ? message.params as Record<string, unknown> : {}
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined
    for (const listener of [...this.listeners]) listener(message.method, params, sessionId)
  }
}
