// @vitest-environment node
import { Duplex } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { SocketFrames } from '../../../src/host/socketFrames'
import { HOST_MAX_FRAME_BYTES } from '../../../src/shared/hostProtocol'
function harness(client = false) {
  const writes: Buffer[] = [], messages: string[] = []
  const stream = new Duplex({ read() {}, write(chunk, _encoding, callback) { writes.push(Buffer.from(chunk)); callback() } })
  const frames = new SocketFrames(stream, client, text => messages.push(text))
  return { frames, stream, writes, messages }
}
function masked(payload: Buffer, opcode = 1, final = true): Buffer {
  const mask = Buffer.from([1, 2, 3, 4])
  const encoded = Buffer.from(payload)
  for (let i = 0; i < encoded.length; i++) encoded[i] = encoded[i]! ^ mask[i % 4]!
  return Buffer.concat([Buffer.from([(final ? 128 : 0) | opcode, 128 | payload.length]), mask, encoded])
}
describe('bounded WebSocket framing', () => {
  it('accepts fragmented masked text, replies to ping, and rejects an unmasked client', () => {
    const h = harness()
    h.frames.feed(masked(Buffer.from('{"hello":'), 1, false))
    h.frames.feed(masked(Buffer.from('ping'), 9))
    h.frames.feed(masked(Buffer.from('true}'), 0))
    expect(h.messages).toEqual(['{"hello":true}'])
    expect(h.writes[0]![0]).toBe(138)
    h.frames.feed(Buffer.from([129, 2, 123, 125]))
    expect(h.stream.destroyed).toBe(true)
  })
  it('rejects an oversized declared frame before allocating its body', () => {
    const h = harness(), header = Buffer.alloc(14)
    header[0] = 129; header[1] = 255; header.writeBigUInt64BE(BigInt(HOST_MAX_FRAME_BYTES + 1), 2)
    h.frames.feed(header)
    expect(h.stream.destroyed).toBe(true); expect(h.messages).toEqual([])
  })
  it('rejects malformed UTF8 and unexpected continuation frames', () => {
    const invalid = harness(); invalid.frames.feed(masked(Buffer.from([0xff])))
    expect(invalid.stream.destroyed).toBe(true)
    const continuation = harness(); continuation.frames.feed(masked(Buffer.from('text'), 0))
    expect(continuation.stream.destroyed).toBe(true)
  })
  it('masks client output and accepts unmasked server output', () => {
    const client = harness(true), server = harness()
    client.frames.send({ hello: true }); server.frames.feed(client.writes[0]!)
    expect(server.messages).toEqual(['{"hello":true}'])
    server.frames.send({ ok: true }); client.frames.feed(server.writes[0]!)
    expect(client.messages).toEqual(['{"ok":true}'])
    client.frames.close(); server.frames.close()
  })
  it('closes a slow consumer before accumulating unbounded writes', () => {
    const h = harness()
    Object.defineProperty(h.stream, 'writableLength', { value: HOST_MAX_FRAME_BYTES * 2 })
    expect(h.frames.send({ text: 'bounded' })).toBe(false)
    expect(h.stream.destroyed).toBe(true)
  })
})
