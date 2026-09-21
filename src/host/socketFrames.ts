import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { HOST_MAX_FRAME_BYTES } from '../shared/hostProtocol'

/** The RFC 6455 framing boundary, shared by the Node client and listener. No protocol bodies are logged. */
export class SocketFrames {
  private buffer: Buffer = Buffer.alloc(0)
  private fragments: Buffer[] = []
  private fragmentedBytes = 0
  private ended = false
  private readonly closedListeners = new Set<() => void>()
  constructor(private readonly stream: Duplex, private readonly client: boolean, private readonly message: (text: string) => void) {
    stream.on('data', (data: Buffer) => this.receive(data))
    stream.on('error', () => this.close())
    stream.on('close', () => this.closed())
    stream.on('end', () => this.close())
  }
  feed(data: Buffer): void { if (data.length) this.receive(data) }
  onClose(listener: () => void): () => void { this.closedListeners.add(listener); return () => this.closedListeners.delete(listener) }
  send(value: unknown): boolean { return this.write(1, Buffer.from(JSON.stringify(value))) }
  close(): void { if (!this.ended) { this.stream.destroy(); this.closed() } }
  private closed(): void {
    if (this.ended) return
    this.ended = true
    this.buffer = Buffer.alloc(0); this.fragments = []
    for (const listener of this.closedListeners) listener()
    this.closedListeners.clear()
  }
  private write(opcode: number, data: Buffer): boolean {
    if (this.ended) return false
    if (data.length > HOST_MAX_FRAME_BYTES || this.stream.writableLength + data.length > HOST_MAX_FRAME_BYTES * 2) { this.close(); return false }
    const extended = data.length < 126 ? 0 : data.length <= 65535 ? 2 : 8
    const header = Buffer.alloc(2 + extended + (this.client ? 4 : 0))
    header[0] = 0x80 | opcode
    header[1] = (this.client ? 0x80 : 0) | (extended === 0 ? data.length : extended === 2 ? 126 : 127)
    if (extended === 2) header.writeUInt16BE(data.length, 2)
    if (extended === 8) header.writeBigUInt64BE(BigInt(data.length), 2)
    if (this.client) {
      const mask = randomBytes(4); mask.copy(header, 2 + extended)
      data = Buffer.from(data)
      for (let index = 0; index < data.length; index++) data[index] = data[index]! ^ mask[index % 4]!
    }
    this.stream.write(Buffer.concat([header, data]))
    return true
  }
  private receive(data: Buffer): void {
    if (this.ended) return
    if (this.buffer.length + data.length > HOST_MAX_FRAME_BYTES + 14) { this.close(); return }
    this.buffer = Buffer.concat([this.buffer, data])
    while (this.buffer.length >= 2 && !this.ended) {
      const first = this.buffer[0]!, second = this.buffer[1]!, opcode = first & 15
      const final = (first & 128) !== 0, masked = (second & 128) !== 0
      if ((first & 112) !== 0 || masked === this.client || ![0, 1, 8, 9, 10].includes(opcode)) { this.close(); return }
      let size = second & 127, offset = 2
      if (size === 126) { if (this.buffer.length < 4) return; size = this.buffer.readUInt16BE(2); offset = 4 }
      else if (size === 127) {
        if (this.buffer.length < 10) return
        const big = this.buffer.readBigUInt64BE(2)
        if (big > BigInt(HOST_MAX_FRAME_BYTES)) { this.close(); return }
        size = Number(big); offset = 10
      }
      if (size > HOST_MAX_FRAME_BYTES || (opcode >= 8 && (!final || size > 125))) { this.close(); return }
      const maskOffset = offset
      if (masked) offset += 4
      if (this.buffer.length < offset + size) return
      const payload = Buffer.from(this.buffer.subarray(offset, offset + size))
      if (masked) for (let index = 0; index < size; index++) payload[index] = payload[index]! ^ this.buffer[maskOffset + index % 4]!
      this.buffer = this.buffer.subarray(offset + size)
      if (opcode === 8) { this.write(8, payload); this.close(); return }
      if (opcode === 9) { this.write(10, payload); continue }
      if (opcode === 10) continue
      if ((opcode === 0 && this.fragments.length === 0) || (opcode === 1 && this.fragments.length > 0)) { this.close(); return }
      this.fragmentedBytes += payload.length
      if (this.fragmentedBytes > HOST_MAX_FRAME_BYTES) { this.close(); return }
      this.fragments.push(payload)
      if (final) {
        let text: string
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(this.fragments)) } catch { this.close(); return }
        this.fragments = []; this.fragmentedBytes = 0
        this.message(text)
      }
    }
  }
}
