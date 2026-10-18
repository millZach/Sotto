import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { constants as zlib, deflateRaw, deflateRawSync, inflateRawSync } from 'node:zlib'
import { HOST_MAX_FRAME_BYTES } from '../shared/hostProtocol'

/**
 * RFC 7692 `permessage-deflate` with neither side keeping a compression context between messages, so a connection
 * holds no zlib state. The desktop's client offers it and the host's listener accepts it for desktops only (ADR-0025,
 * October 18 amendment).
 */
export const DEFLATE_OFFER = 'permessage-deflate; client_no_context_takeover; server_no_context_takeover'
export const DEFLATE_RESPONSE = 'permessage-deflate; server_no_context_takeover; client_no_context_takeover'
/** A text message shorter than this goes uncompressed, which the extension allows for any message. */
export const DEFLATE_MIN_BYTES = 1024
/** A message up to this size is compressed at once; a larger one on zlib's thread pool, so the host's loop is not held. */
export const DEFLATE_SYNC_MAX_BYTES = 64 * 1024
/** Level 6, zlib's default: on a slow link the bytes cost more than the off-loop compression time (docs/perf/2026-10-18-remote-thread-open-bytes.md). */
export const DEFLATE_LEVEL = 6
const DEFLATE_OPTIONS = { level: DEFLATE_LEVEL, finishFlush: zlib.Z_SYNC_FLUSH }
const DEFLATE_TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff])

type ExtensionOffer = { name: string; params: Map<string, string | true>; duplicate: boolean }
/** Reads a `Sec-WebSocket-Extensions` header: comma-separated extensions, each with `;`-separated parameters. */
function extensions(header: string | readonly string[] | undefined): ExtensionOffer[] {
  const text = Array.isArray(header) ? header.join(',') : typeof header === 'string' ? header : ''
  return text.split(',').map(part => part.trim()).filter(Boolean).map(part => {
    const [name = '', ...rest] = part.split(';').map(item => item.trim())
    const params = new Map<string, string | true>()
    let duplicate = false
    for (const item of rest) {
      if (!item) continue
      const equals = item.indexOf('=')
      const key = (equals < 0 ? item : item.slice(0, equals)).trim().toLowerCase()
      const value = equals < 0 ? true : item.slice(equals + 1).trim().replace(/^"(.*)"$/, '$1')
      if (params.has(key)) duplicate = true
      params.set(key, value)
    }
    return { name: name.toLowerCase(), params, duplicate }
  })
}
const windowBits = (value: string | true): boolean => value !== true && /^(8|9|1[0-5])$/.test(value)

/**
 * Whether a client's upgrade request offers `permessage-deflate` in a form the listener can answer with
 * `DEFLATE_RESPONSE`: any offer whose parameters ask for nothing beyond no context takeover and the full window.
 */
export function deflateOffered(header: string | readonly string[] | undefined): boolean {
  return extensions(header).some(offer => offer.name === 'permessage-deflate' && !offer.duplicate && [...offer.params].every(([key, value]) =>
    key === 'server_no_context_takeover' || key === 'client_no_context_takeover' ? value === true
      : key === 'client_max_window_bits' ? value === true || windowBits(value)
        : key === 'server_max_window_bits' ? value === '15' : false))
}

/**
 * What the client makes of the listener's answer to `DEFLATE_OFFER`: true when it accepted, false when it answered
 * without the header, as a host from before the extension does, and `'invalid'` for an answer the client never offered,
 * which fails the connection (RFC 7692 section 5).
 */
export function deflateAccepted(header: string | readonly string[] | undefined): boolean | 'invalid' {
  const answered = extensions(header)
  if (answered.length === 0) return false
  const [answer] = answered
  if (answered.length > 1 || answer!.name !== 'permessage-deflate' || answer!.duplicate || answer!.params.get('server_no_context_takeover') !== true) return 'invalid'
  for (const [key, value] of answer!.params) {
    if (key === 'server_no_context_takeover' || key === 'client_no_context_takeover') { if (value !== true) return 'invalid' }
    else if (key !== 'server_max_window_bits' || !windowBits(value)) return 'invalid'
  }
  return true
}

/** A text message waiting its turn on the wire: `payload` is set once its compression, if any, has finished. */
interface Outgoing { size: number; payload?: Buffer; compressed?: boolean }

/** The RFC 6455 framing boundary, shared by the Node client and listener. No protocol bodies are logged. */
export class SocketFrames {
  private chunks: Buffer[] = []
  private bufferedBytes = 0
  private fragments: Buffer[] = []
  private fragmentedBytes = 0
  private fragmentCompressed = false
  private ended = false
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private awaitingPong: Buffer | undefined
  private silentRounds = 0
  private wroteSincePing = false
  private lastProgress = Date.now()
  private clientLiveness = false
  /**
   * Text messages after one still being compressed off the loop, in the order they were sent, so the wire keeps that
   * order. `queuedBytes` is their uncompressed size, counted against the unread-output cap as if already written.
   */
  private queue: Outgoing[] = []
  private queuedBytes = 0
  private readonly flushedListeners = new Set<() => void>()
  get isClosed(): boolean { return this.ended }
  /** Whether this connection negotiated `permessage-deflate`. */
  readonly deflate: boolean
  private readonly closedListeners = new Set<() => void>()
  constructor(private readonly stream: Duplex, private readonly client: boolean, private readonly message: (text: string) => void, options: { deflate?: boolean } = {}) {
    this.deflate = options.deflate === true
    stream.on('data', (data: Buffer) => this.receive(data))
    stream.on('error', () => this.close())
    stream.on('close', () => this.closed())
    stream.on('end', () => this.close())
  }
  /** Only peers opting in through hello take responsibility for their own pings. */
  setClientLiveness(enabled: boolean): void { this.clientLiveness = enabled; this.awaitingPong = undefined; this.silentRounds = 0 }
  startHeartbeat(): void {
    if (this.heartbeat || this.ended) return
    this.heartbeat = setInterval(() => {
      if (this.stream.writableLength > 0 || this.queue.length > 0) { this.silentRounds = 0; return }
      if (!this.client && this.clientLiveness) {
        if (Date.now() - this.lastProgress >= 75_000) this.close()
        return
      }
      // A tunnel can drain Node's buffer while still delivering our frames to the peer.
      // Our own keep-alive pings must not count as progress for a dead connection.
      if (this.awaitingPong && !this.wroteSincePing) this.silentRounds++
      else this.silentRounds = 0
      if (this.silentRounds >= 2) { this.close(); return }
      this.wroteSincePing = false
      this.awaitingPong = randomBytes(8)
      this.write(9, this.awaitingPong)
    }, 25_000)
    this.heartbeat.unref()
  }
  feed(data: Buffer): void { if (data.length) this.receive(data) }
  onClose(listener: () => void): () => void { this.closedListeners.add(listener); return () => this.closedListeners.delete(listener) }
  /**
   * True while a message is still being compressed, or the stream holds at least its high-water mark of output the
   * peer has not read yet: what is written now only queues behind it. False once both clear or the stream closes.
   */
  get backlogged(): boolean { return !this.ended && (this.queue.length > 0 || this.stream.writableNeedDrain) }
  /** Waits for queued and buffered output to drain before the next detail in a batch is materialised. */
  drained(): Promise<void> {
    if (!this.backlogged) return Promise.resolve()
    if (this.queue.length > 0) {
      return new Promise<void>(resolve => {
        const done = (): void => { this.flushedListeners.delete(done); this.closedListeners.delete(done); resolve() }
        this.flushedListeners.add(done); this.closedListeners.add(done)
      }).then(() => this.drained())
    }
    return new Promise(resolve => {
      const done = (): void => { this.stream.removeListener('drain', done); this.closedListeners.delete(done); resolve() }
      this.stream.once('drain', done); this.closedListeners.add(done)
    })
  }
  send(value: unknown): boolean { return this.sendText(JSON.stringify(value)) }
  /**
   * Sends one text message, compressed when the connection negotiated it and the message is large enough to gain.
   * The frame cap and the unread-output cap both apply to the message's own size, compressed or not.
   */
  sendText(text: string): boolean {
    if (this.ended) return false
    const data = Buffer.from(text)
    if (data.length > HOST_MAX_FRAME_BYTES || this.stream.writableLength + this.queuedBytes + data.length > HOST_MAX_FRAME_BYTES * 2) { this.close(); return false }
    if (!this.deflate || data.length < DEFLATE_MIN_BYTES) return this.ordered(data, false)
    if (this.queue.length === 0 && data.length <= DEFLATE_SYNC_MAX_BYTES) {
      const packed = compressed(deflateRawSync(data, DEFLATE_OPTIONS), data)
      return this.frame(1, packed ?? data, packed !== undefined)
    }
    const entry: Outgoing = { size: data.length }
    this.queue.push(entry); this.queuedBytes += data.length
    deflateRaw(data, DEFLATE_OPTIONS, (error, result) => {
      const packed = error ? undefined : compressed(result, data)
      entry.payload = packed ?? data; entry.compressed = packed !== undefined
      this.flush()
    })
    return true
  }
  close(): void { if (!this.ended) { this.stream.destroy(); this.closed() } }
  private closed(): void {
    if (this.ended) return
    this.ended = true
    clearInterval(this.heartbeat); this.heartbeat = undefined; this.awaitingPong = undefined
    this.chunks = []; this.bufferedBytes = 0; this.fragments = []; this.fragmentCompressed = false
    this.queue = []; this.queuedBytes = 0; this.flushedListeners.clear()
    for (const listener of this.closedListeners) listener()
    this.closedListeners.clear()
  }
  /** A text message goes now unless a message sent before it is still being compressed, and then after it. */
  private ordered(payload: Buffer, compressed: boolean): boolean {
    if (this.queue.length === 0) return this.frame(1, payload, compressed)
    this.queue.push({ size: payload.length, payload, compressed }); this.queuedBytes += payload.length
    return true
  }
  /** Writes every message at the head of the queue that is ready, in order, and wakes a drain waiting on the queue. */
  private flush(): void {
    while (!this.ended && this.queue[0]?.payload) {
      const entry = this.queue.shift()!
      this.queuedBytes -= entry.size
      this.frame(1, entry.payload!, entry.compressed === true)
    }
    if (this.queue.length === 0) { const waiting = [...this.flushedListeners]; this.flushedListeners.clear(); for (const listener of waiting) listener() }
  }
  /** Control frames are never compressed and may go between whole messages, so they skip the queue. */
  private write(opcode: number, data: Buffer): boolean { return this.frame(opcode, data, false) }
  private frame(opcode: number, data: Buffer, compressed: boolean): boolean {
    if (this.ended) return false
    if (data.length > HOST_MAX_FRAME_BYTES || this.stream.writableLength + data.length > HOST_MAX_FRAME_BYTES * 2) { this.close(); return false }
    const extended = data.length < 126 ? 0 : data.length <= 65535 ? 2 : 8
    const header = Buffer.alloc(2 + extended + (this.client ? 4 : 0))
    header[0] = 0x80 | (compressed ? 0x40 : 0) | opcode
    header[1] = (this.client ? 0x80 : 0) | (extended === 0 ? data.length : extended === 2 ? 126 : 127)
    if (extended === 2) header.writeUInt16BE(data.length, 2)
    if (extended === 8) header.writeBigUInt64BE(BigInt(data.length), 2)
    if (this.client) {
      const mask = randomBytes(4); mask.copy(header, 2 + extended)
      data = Buffer.from(data)
      for (let index = 0; index < data.length; index++) data[index] = data[index]! ^ mask[index % 4]!
    }
    this.stream.write(Buffer.concat([header, data]))
    if (opcode !== 9) { this.wroteSincePing = true; this.lastProgress = Date.now() }
    return true
  }
  private receive(data: Buffer): void {
    if (this.ended) return
    if (data.length) { this.lastProgress = Date.now(); this.awaitingPong = undefined; this.silentRounds = 0; this.chunks.push(data); this.bufferedBytes += data.length }
    while (this.bufferedBytes >= 2 && !this.ended) {
      const header = this.header()
      const first = header[0]!, second = header[1]!, opcode = first & 15
      const final = (first & 128) !== 0, masked = (second & 128) !== 0, compressed = (first & 64) !== 0
      // RSV1 marks a compressed message's first frame, only on a connection that negotiated it; RSV2 and RSV3 mean nothing here.
      if ((first & 48) !== 0 || (compressed && (!this.deflate || opcode !== 1)) || masked === this.client || ![0, 1, 8, 9, 10].includes(opcode)) { this.close(); return }
      let size = second & 127, offset = 2
      if (size === 126) { if (this.bufferedBytes < 4) return; size = header.readUInt16BE(2); offset = 4 }
      else if (size === 127) {
        if (this.bufferedBytes < 10) return
        const big = header.readBigUInt64BE(2)
        if (big > BigInt(HOST_MAX_FRAME_BYTES)) { this.close(); return }
        size = Number(big); offset = 10
      }
      if (size > HOST_MAX_FRAME_BYTES || (opcode >= 8 && (!final || size > 125))) { this.close(); return }
      const maskOffset = offset
      if (masked) offset += 4
      if (this.bufferedBytes < offset + size) return
      const frame = this.take(offset + size)
      const payload = Buffer.from(frame.subarray(offset))
      if (masked) for (let index = 0; index < size; index++) payload[index] = payload[index]! ^ header[maskOffset + index % 4]!
      if (opcode === 8) { if (this.write(8, payload)) { this.stream.end(); this.closed() } return }
      if (opcode === 9) { this.write(10, payload); continue }
      if (opcode === 10) { if (this.awaitingPong?.equals(payload)) this.awaitingPong = undefined; continue }
      if ((opcode === 0 && this.fragments.length === 0) || (opcode === 1 && this.fragments.length > 0)) { this.close(); return }
      if (opcode === 1) this.fragmentCompressed = compressed
      this.fragmentedBytes += payload.length
      if (this.fragmentedBytes > HOST_MAX_FRAME_BYTES) { this.close(); return }
      this.fragments.push(payload)
      if (final) {
        let bytes = this.fragments.length === 1 ? this.fragments[0]! : Buffer.concat(this.fragments)
        if (this.fragmentCompressed) {
          // A message that inflates past the frame cap closes the connection, as one sent that large would.
          try { bytes = this.inflate(bytes) } catch { this.close(); return }
        }
        let text: string
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { this.close(); return }
        this.fragments = []; this.fragmentedBytes = 0; this.fragmentCompressed = false
        this.message(text)
      }
    }
  }
  /** One compressed message's payload, inflated to at most the frame cap. Inflating is fast enough to stay on the loop. */
  private inflate(payload: Buffer): Buffer {
    return inflateRawSync(Buffer.concat([payload, DEFLATE_TAIL]), { maxOutputLength: HOST_MAX_FRAME_BYTES, finishFlush: zlib.Z_SYNC_FLUSH })
  }
  /** Inspect at most the fourteen header bytes without copying an incomplete frame's body. */
  private header(): Buffer {
    const size = Math.min(this.bufferedBytes, 14)
    if (this.chunks[0]!.length >= size) return this.chunks[0]!.subarray(0, size)
    const header = Buffer.alloc(size)
    let copied = 0
    for (const chunk of this.chunks) {
      copied += chunk.copy(header, copied, 0, Math.min(chunk.length, size - copied))
      if (copied === size) break
    }
    return header
  }
  /** Remove one complete frame, joining its chunks once and leaving the next frame queued. */
  private take(size: number): Buffer {
    const parts: Buffer[] = []
    let remaining = size, consumed = 0
    while (remaining > 0) {
      const chunk = this.chunks[consumed]!, count = Math.min(chunk.length, remaining)
      parts.push(chunk.subarray(0, count))
      remaining -= count
      if (count === chunk.length) consumed++
      else this.chunks[consumed] = chunk.subarray(count)
    }
    this.chunks.splice(0, consumed)
    this.bufferedBytes -= size
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, size)
  }
}

/**
 * A sync-flushed deflate of `data` with its empty-block tail removed (RFC 7692 section 7.2.1), or undefined when it
 * would not be smaller, in which case the message goes as it is.
 */
function compressed(deflated: Buffer, data: Buffer): Buffer | undefined {
  if (deflated.length < 4 || !deflated.subarray(-4).equals(DEFLATE_TAIL) || deflated.length - 4 >= data.length) return undefined
  return deflated.subarray(0, deflated.length - 4)
}
