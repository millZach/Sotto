// @vitest-environment node
import { Duplex } from 'node:stream'
import { constants as zlibConstants, deflateRawSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { DEFLATE_MIN_BYTES, DEFLATE_OFFER, DEFLATE_RESPONSE, DEFLATE_SYNC_MAX_BYTES, deflateAccepted, deflateOffered, SocketFrames } from '../../../src/host/socketFrames'
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
  const extended = payload.length < 126 ? 0 : payload.length <= 65535 ? 2 : 8
  const header = Buffer.alloc(2 + extended)
  header[0] = (final ? 128 : 0) | opcode
  header[1] = 128 | (extended === 0 ? payload.length : extended === 2 ? 126 : 127)
  if (extended === 2) header.writeUInt16BE(payload.length, 2)
  if (extended === 8) header.writeBigUInt64BE(BigInt(payload.length), 2)
  return Buffer.concat([header, mask, encoded])
}
describe('bounded WebSocket framing', () => {
  it('assembles a large frame only when all its chunks have arrived', () => {
    const h = harness(), text = 'a'.repeat(14 * 1024 * 1024), frame = masked(Buffer.from(text))
    const concat = vi.spyOn(Buffer, 'concat')
    try {
      for (let offset = 0; offset < frame.length; offset += 64 * 1024) {
        h.frames.feed(frame.subarray(offset, offset + 64 * 1024))
        if (offset + 64 * 1024 < frame.length) {
          expect(h.messages).toEqual([])
          expect(concat).not.toHaveBeenCalled()
        }
      }
      expect(h.messages).toEqual([text])
      const copiedBytes = concat.mock.calls.reduce((total, [chunks]) => total + chunks.reduce((size, chunk) => size + chunk.length, 0), 0)
      expect(copiedBytes).toBeLessThanOrEqual(frame.length * 2)
      expect(h.stream.destroyed).toBe(false)
    } finally { concat.mockRestore(); h.frames.close() }
  })
  it.each([0, 125, 126, 65535, 65536])('reads a split header and leaves the following frame queued for a %i-byte payload', size => {
    const h = harness(), text = 'a'.repeat(size), frame = masked(Buffer.from(text)), next = masked(Buffer.from('next'))
    for (let offset = 0; offset < Math.min(14, frame.length); offset++) h.frames.feed(frame.subarray(offset, offset + 1))
    h.frames.feed(Buffer.concat([frame.subarray(Math.min(14, frame.length)), next.subarray(0, 3)]))
    expect(h.messages).toEqual([text])
    h.frames.feed(next.subarray(3))
    expect(h.messages).toEqual([text, 'next'])
    expect(h.stream.destroyed).toBe(false)
    h.frames.close()
  })
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
  it.each([false, true])('applies the cap to each frame when following bytes share a receive (partial: %s)', partial => {
    const h = harness(), text = 'a'.repeat(HOST_MAX_FRAME_BYTES), frame = masked(Buffer.from(text))
    const next = masked(Buffer.from('next frame'))
    h.frames.feed(frame.subarray(0, 14))
    h.frames.feed(Buffer.concat([frame.subarray(14), partial ? next.subarray(0, 5) : next]))
    expect(h.stream.destroyed).toBe(false)
    expect(h.messages).toEqual(partial ? [text] : [text, 'next frame'])
    if (partial) h.frames.feed(next.subarray(5))
    expect(h.messages).toEqual([text, 'next frame'])
    h.frames.close()
  })
  it('still caps the whole fragmented message across individually legal frames', () => {
    const h = harness()
    h.frames.feed(masked(Buffer.alloc(HOST_MAX_FRAME_BYTES, 97), 1, false))
    expect(h.stream.destroyed).toBe(false)
    h.frames.feed(masked(Buffer.from('a'), 0))
    expect(h.stream.destroyed).toBe(true)
    expect(h.messages).toEqual([])
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
  it('closes a silent listener peer that accepts client liveness', () => {
    vi.useFakeTimers()
    const h = harness()
    try {
      h.frames.setClientLiveness(true)
      h.frames.startHeartbeat()
      vi.advanceTimersByTime(50_000)
      expect(h.writes).toEqual([])
      expect(h.stream.destroyed).toBe(false)
      vi.advanceTimersByTime(25_000)
      expect(h.stream.destroyed).toBe(true)
    } finally { h.frames.close(); vi.useRealTimers() }
  })
  it('keeps an idle older client connected beyond 75 seconds when it answers host pings', () => {
    vi.useFakeTimers()
    const h = harness()
    try {
      h.frames.startHeartbeat()
      for (let round = 0; round < 5; round++) {
        vi.advanceTimersByTime(25_000)
        const ping = h.writes.at(-1)!
        expect(ping[0]).toBe(137)
        h.frames.feed(masked(ping.subarray(2), 10))
      }
      expect(h.stream.destroyed).toBe(false)
      expect(h.messages).toEqual([])
    } finally { h.frames.close(); vi.useRealTimers() }
  })
  it('closes an older peer only after two missed rounds without other traffic', () => {
    vi.useFakeTimers()
    const h = harness()
    try {
      h.frames.startHeartbeat()
      vi.advanceTimersByTime(25_000)
      h.frames.feed(masked(Buffer.from('still here')))
      vi.advanceTimersByTime(25_000)
      expect(h.stream.destroyed).toBe(false)
      vi.advanceTimersByTime(25_000)
      expect(h.stream.destroyed).toBe(false)
      vi.advanceTimersByTime(25_000)
      expect(h.stream.destroyed).toBe(true)
    } finally { h.frames.close(); vi.useRealTimers() }
  })
  it('counts partial message bytes and incoming pings as listener liveness', () => {
    vi.useFakeTimers()
    const h = harness()
    try {
      h.frames.setClientLiveness(true)
      h.frames.startHeartbeat()
      vi.advanceTimersByTime(50_000)
      const large = masked(Buffer.alloc(4 * 1024 * 1024, 97))
      h.frames.feed(large.subarray(0, 1000))
      vi.advanceTimersByTime(50_000)
      expect(h.stream.destroyed).toBe(false)
      h.frames.feed(large.subarray(1000))
      h.frames.feed(masked(Buffer.from('ping'), 9))
      expect(h.writes.at(-1)![0]).toBe(138)
      vi.advanceTimersByTime(50_000)
      expect(h.stream.destroyed).toBe(false)
    } finally { h.frames.close(); vi.useRealTimers() }
  })
  it('keeps a large outgoing frame alive past the deadline until output drains', () => {
    vi.useFakeTimers()
    const stream = new Duplex({ read() {}, write() {} })
    const frames = new SocketFrames(stream, false, () => {})
    try {
      frames.startHeartbeat()
      frames.sendText('a'.repeat(4 * 1024 * 1024))
      vi.advanceTimersByTime(100_000)
      expect(stream.writableLength).toBeGreaterThan(0)
      expect(stream.destroyed).toBe(false)
    } finally { frames.close(); vi.useRealTimers() }
  })
  it.each([false, true])('survives a late pong after tunnel output has drained (desktop upload: %s)', client => {
    vi.useFakeTimers()
    const h = harness(client), peer = harness(!client)
    try {
      h.frames.startHeartbeat()
      h.frames.send(client ? { op: 'stage-attachment', image: { data: 'a'.repeat(4 * 1024 * 1024) } } : { event: 'detail', detail: 'a'.repeat(4 * 1024 * 1024) })
      expect(h.stream.writableLength).toBe(0)
      vi.advanceTimersByTime(25_000)
      const ping = h.writes.at(-1)!
      vi.advanceTimersByTime(25_000)
      expect(h.stream.destroyed).toBe(false)
      vi.advanceTimersByTime(10_000)
      peer.frames.feed(ping)
      h.frames.feed(peer.writes.at(-1)!)
      vi.advanceTimersByTime(15_000)
      expect(h.stream.destroyed).toBe(false)
    } finally { h.frames.close(); peer.frames.close(); vi.useRealTimers() }
  })
  it.each([false, true])('does not count drained application writes since the ping as silence (client: %s)', client => {
    vi.useFakeTimers()
    const h = harness(client)
    try {
      h.frames.startHeartbeat()
      vi.advanceTimersByTime(25_000)
      h.frames.sendText('a'.repeat(4 * 1024 * 1024))
      expect(h.stream.writableLength).toBe(0)
      vi.advanceTimersByTime(50_000)
      expect(h.stream.destroyed).toBe(false)
      vi.advanceTimersByTime(25_000)
      expect(h.stream.destroyed).toBe(true)
    } finally { h.frames.close(); vi.useRealTimers() }
  })
  it.each([false, true])('closes a truly silent peer after two rounds at 75 seconds (client: %s)', client => {
    vi.useFakeTimers()
    const h = harness(client)
    try {
      h.frames.startHeartbeat()
      vi.advanceTimersByTime(74_999)
      expect(h.stream.destroyed).toBe(false)
      vi.advanceTimersByTime(1)
      expect(h.stream.destroyed).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally { h.frames.close(); vi.useRealTimers() }
  })
  it.each([false, true])('counts partial frames across multiple ping rounds (client: %s)', client => {
    vi.useFakeTimers()
    const h = harness(client), peer = harness(!client)
    try {
      h.frames.startHeartbeat()
      peer.frames.sendText('a'.repeat(4 * 1024 * 1024))
      const frame = peer.writes[0]!
      for (let offset = 0; offset < 4000; offset += 1000) {
        vi.advanceTimersByTime(30_000)
        h.frames.feed(frame.subarray(offset, offset + 1000))
        expect(h.messages).toEqual([])
        expect(h.stream.destroyed).toBe(false)
      }
      vi.advanceTimersByTime(50_000)
      expect(h.stream.destroyed).toBe(false)
      h.frames.feed(frame.subarray(4000))
      expect(h.messages).toEqual(['a'.repeat(4 * 1024 * 1024)])
    } finally { h.frames.close(); peer.frames.close(); vi.useRealTimers() }
  })
  it('clears a client pending pong on any received bytes but closes a silent client peer', () => {
    vi.useFakeTimers()
    const h = harness(true)
    try {
      h.frames.startHeartbeat()
      vi.advanceTimersByTime(25_000)
      expect(h.writes[0]![0]).toBe(137)
      h.frames.feed(Buffer.from([129]))
      vi.advanceTimersByTime(25_000)
      expect(h.stream.destroyed).toBe(false)
      vi.advanceTimersByTime(25_000)
      expect(h.stream.destroyed).toBe(false)
      vi.advanceTimersByTime(25_000)
      expect(h.stream.destroyed).toBe(true)
    } finally { h.frames.close(); vi.useRealTimers() }
  })
  it('waits for drain before continuing a detail batch and releases a wait on close', async () => {
    const h = harness()
    Object.defineProperty(h.stream, 'writableNeedDrain', { value: true, configurable: true })
    const drained = vi.fn()
    const waiting = h.frames.drained().then(drained)
    await Promise.resolve()
    expect(drained).not.toHaveBeenCalled()
    h.stream.emit('drain')
    await waiting
    expect(drained).toHaveBeenCalledOnce()
    const closing = h.frames.drained()
    h.frames.close()
    await closing
    expect(h.stream.listenerCount('drain')).toBe(0)
  })
  it('reports a backlog while a write past the high-water mark is unread, and none once it drains or closes', async () => {
    let finish: (() => void) | undefined
    const stream = new Duplex({ read() {}, write(_chunk, _encoding, callback) { finish = callback } })
    const frames = new SocketFrames(stream, false, () => {})
    expect(frames.backlogged).toBe(false)
    frames.sendText('small')
    expect(frames.backlogged).toBe(false)
    finish!()
    frames.sendText('a'.repeat(stream.writableHighWaterMark))
    expect(frames.backlogged).toBe(true)
    const drained = frames.drained()
    finish!()
    await drained
    expect(frames.backlogged).toBe(false)
    frames.sendText('a'.repeat(stream.writableHighWaterMark))
    expect(frames.backlogged).toBe(true)
    frames.close()
    expect(frames.backlogged).toBe(false)
  })
  it('closes a slow consumer before accumulating unbounded writes', () => {
    const h = harness()
    Object.defineProperty(h.stream, 'writableLength', { value: HOST_MAX_FRAME_BYTES * 2 })
    expect(h.frames.send({ text: 'bounded' })).toBe(false)
    expect(h.stream.destroyed).toBe(true)
  })
  it('flushes the Close echo before ending even when its write is still pending', async () => {
    const writes: Buffer[] = [], messages: string[] = []
    let finishWrite: (() => void) | undefined
    const stream = new Duplex({ read() {}, write(chunk, _encoding, callback) { writes.push(Buffer.from(chunk)); finishWrite = callback } })
    const frames = new SocketFrames(stream, false, text => messages.push(text)), closed = vi.fn()
    frames.onClose(closed)
    const payload = Buffer.from([3, 232])
    frames.feed(Buffer.concat([masked(payload, 8), masked(Buffer.from('ignored'))]))
    expect(writes).toEqual([Buffer.from([136, 2, 3, 232])])
    expect(stream.writableEnded).toBe(true)
    expect(stream.writableFinished).toBe(false)
    expect(stream.destroyed).toBe(false)
    expect(closed).toHaveBeenCalledTimes(1)
    expect(frames.sendText('after close')).toBe(false)
    frames.feed(masked(Buffer.from('also ignored')))
    stream.emit('end')
    expect(stream.destroyed).toBe(false)
    const finished = new Promise<void>(resolve => stream.once('finish', resolve))
    finishWrite!()
    await finished
    expect(stream.writableFinished).toBe(true)
    stream.destroy()
    expect(messages).toEqual([])
    expect(closed).toHaveBeenCalledTimes(1)
  })
})

/** One frame as a peer would write it, with RSV1 when `compressed`; masked as a client's is unless `unmasked`. */
function frameOf(payload: Buffer, { opcode = 1, final = true, compressed = false, unmasked = false } = {}): Buffer {
  const extended = payload.length < 126 ? 0 : payload.length <= 65535 ? 2 : 8
  const header = Buffer.alloc(2 + extended)
  header[0] = (final ? 128 : 0) | (compressed ? 64 : 0) | opcode
  header[1] = (unmasked ? 0 : 128) | (extended === 0 ? payload.length : extended === 2 ? 126 : 127)
  if (extended === 2) header.writeUInt16BE(payload.length, 2)
  if (extended === 8) header.writeBigUInt64BE(BigInt(payload.length), 2)
  if (unmasked) return Buffer.concat([header, payload])
  const mask = Buffer.from([1, 2, 3, 4]), encoded = Buffer.from(payload)
  for (let i = 0; i < encoded.length; i++) encoded[i] = encoded[i]! ^ mask[i % 4]!
  return Buffer.concat([header, mask, encoded])
}
/** A message compressed the way RFC 7692 has it sent: sync-flushed raw deflate without its four-byte tail. */
const deflated = (text: string | Buffer): Buffer => {
  const out = deflateRawSync(typeof text === 'string' ? Buffer.from(text) : text, { finishFlush: zlibConstants.Z_SYNC_FLUSH })
  return out.subarray(0, out.length - 4)
}
function deflating(client = false, deflate = true) {
  const writes: Buffer[] = [], messages: string[] = []
  const stream = new Duplex({ read() {}, write(chunk, _encoding, callback) { writes.push(Buffer.from(chunk)); callback() } })
  const frames = new SocketFrames(stream, client, text => messages.push(text), { deflate })
  return { frames, stream, writes, messages }
}
/** Text that compresses the way thread history does: the same few words and keys over and over. */
const history = (bytes: number): string => {
  const words = ['thread', 'detail', 'output', 'activity', 'socket', 'host', 'src/main/agents', '"status":"completed"', '\n']
  let value = '', seed = 7
  while (value.length < bytes) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; value += words[seed % words.length] + ' ' }
  return value.slice(0, bytes)
}

describe('permessage-deflate', () => {
  it.each([[2 * 1024, 'at once'], [DEFLATE_SYNC_MAX_BYTES + 1, 'off the loop'], [4 * 1024 * 1024, 'off the loop']])('round-trips a %i-byte message compressed %s in both directions', async size => {
    const client = deflating(true), server = deflating(false), text = history(size)
    server.frames.sendText(text); await server.frames.drained()
    expect(server.writes).toHaveLength(1)
    expect(server.writes[0]![0]! & 0x40).toBe(0x40)
    expect(server.writes[0]!.length).toBeLessThan(size / 2)
    client.frames.feed(server.writes[0]!)
    expect(client.messages).toEqual([text])
    client.frames.sendText(text); await client.frames.drained()
    expect(client.writes[0]![0]! & 0x40).toBe(0x40)
    server.frames.feed(client.writes[0]!)
    expect(server.messages).toEqual([text])
    expect(client.stream.destroyed || server.stream.destroyed).toBe(false)
    client.frames.close(); server.frames.close()
  })

  it('sends a message under the threshold uncompressed, which a deflate peer reads as it is', () => {
    const client = deflating(true), server = deflating(false), text = history(DEFLATE_MIN_BYTES - 1)
    server.frames.sendText(text)
    expect(server.writes[0]![0]).toBe(129)
    client.frames.feed(server.writes[0]!)
    expect(client.messages).toEqual([text])
    client.frames.close(); server.frames.close()
  })

  it('keeps send order while a large message is still compressing, and counts it as backlog until it is written', async () => {
    const client = deflating(true), server = deflating(false), large = history(2 * 1024 * 1024), medium = history(4 * 1024)
    server.frames.sendText(large)
    server.frames.sendText(medium)
    server.frames.sendText('small')
    expect(server.writes).toEqual([])
    expect(server.frames.backlogged).toBe(true)
    await server.frames.drained()
    expect(server.frames.backlogged).toBe(false)
    expect(server.writes).toHaveLength(3)
    client.frames.feed(Buffer.concat(server.writes))
    expect(client.messages).toEqual([large, medium, 'small'])
    client.frames.close(); server.frames.close()
  })

  it('answers a ping at once while a message is compressing, and never compresses a control frame', async () => {
    const server = deflating(false)
    server.frames.sendText(history(1024 * 1024))
    server.frames.feed(frameOf(Buffer.from('ping'), { opcode: 9 }))
    expect(server.writes).toHaveLength(1)
    expect(server.writes[0]![0]).toBe(138)
    await server.frames.drained()
    expect(server.writes[1]![0]).toBe(0xc1)
    server.frames.close()
  })

  it('reads a compressed message fragmented across frames, RSV1 on the first only', () => {
    const server = deflating(false), text = history(200_000), packed = deflated(text), cut = Math.floor(packed.length / 3)
    server.frames.feed(frameOf(packed.subarray(0, cut), { final: false, compressed: true }))
    server.frames.feed(frameOf(Buffer.from('ping'), { opcode: 9 }))
    server.frames.feed(frameOf(packed.subarray(cut, 2 * cut), { opcode: 0, final: false }))
    server.frames.feed(frameOf(packed.subarray(2 * cut), { opcode: 0 }))
    expect(server.messages).toEqual([text])
    expect(server.stream.destroyed).toBe(false)
    server.frames.close()
  })

  const rsv2 = (): Buffer => { const frame = frameOf(Buffer.from('{}')); frame[0] = frame[0]! | 32; return frame }
  it.each([
    ['a compressed frame on a connection that did not negotiate', false, frameOf(deflated('{"hello":true}'), { compressed: true })],
    ['RSV1 on a continuation frame', true, Buffer.concat([frameOf(Buffer.from('{"a":'), { final: false }), frameOf(deflated('1}'), { opcode: 0, compressed: true })])],
    ['RSV1 on a ping', true, frameOf(Buffer.from('ping'), { opcode: 9, compressed: true })],
    ['RSV2', true, rsv2()],
    ['a compressed payload that is not deflate', true, frameOf(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]), { compressed: true })],
  ])('closes the connection on %s', (_name, deflate, bytes) => {
    const server = deflating(false, deflate)
    server.frames.feed(bytes)
    expect(server.stream.destroyed).toBe(true)
    expect(server.messages).toEqual([])
    expect(server.writes).toEqual([])
  })

  it('never writes RSV1 to a peer that did not negotiate, however large the message', () => {
    const plain = deflating(false, false)
    plain.frames.sendText(history(1024 * 1024))
    expect(plain.writes[0]![0]).toBe(129)
    plain.frames.close()
  })

  it('closes on a message that inflates past the frame cap, without delivering any of it', () => {
    const client = deflating(true), bomb = deflated(Buffer.alloc(HOST_MAX_FRAME_BYTES + 1, 97))
    expect(bomb.length).toBeLessThan(64 * 1024)
    client.frames.feed(frameOf(bomb, { compressed: true, unmasked: true }))
    expect(client.stream.destroyed).toBe(true)
    expect(client.messages).toEqual([])
    const exact = deflating(true), whole = 'a'.repeat(HOST_MAX_FRAME_BYTES)
    exact.frames.feed(frameOf(deflated(whole), { compressed: true, unmasked: true }))
    expect(exact.messages).toEqual([whole])
    expect(exact.stream.destroyed).toBe(false)
    exact.frames.close()
  })

  it('applies the unread-output cap to the size of messages still compressing', () => {
    const server = deflating(false), whole = history(HOST_MAX_FRAME_BYTES)
    expect(server.frames.sendText(whole)).toBe(true)
    expect(server.frames.sendText(whole)).toBe(true)
    expect(server.frames.sendText(history(2 * 1024))).toBe(false)
    expect(server.stream.destroyed).toBe(true)
  })

  it('writes nothing compressed after close and releases a wait on the queue', async () => {
    const server = deflating(false)
    server.frames.sendText(history(1024 * 1024))
    const waiting = server.frames.drained()
    server.frames.close()
    await waiting
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(server.writes).toEqual([])
  })

  it('negotiates only what both sides can keep to', () => {
    expect(deflateOffered(DEFLATE_OFFER)).toBe(true)
    expect(deflateOffered('permessage-deflate')).toBe(true)
    expect(deflateOffered('permessage-deflate; client_max_window_bits')).toBe(true)
    expect(deflateOffered(['x-webkit-deflate-frame', 'permessage-deflate; client_max_window_bits=10'])).toBe(true)
    expect(deflateOffered('permessage-deflate; server_max_window_bits=10, permessage-deflate')).toBe(true)
    expect(deflateOffered('permessage-deflate; server_max_window_bits=10')).toBe(false)
    expect(deflateOffered('permessage-deflate; client_no_context_takeover; client_no_context_takeover')).toBe(false)
    expect(deflateOffered('permessage-deflate; unknown')).toBe(false)
    expect(deflateOffered(undefined)).toBe(false)
    expect(deflateOffered('')).toBe(false)
    expect(deflateAccepted(DEFLATE_RESPONSE)).toBe(true)
    expect(deflateAccepted('permessage-deflate; server_no_context_takeover')).toBe(true)
    expect(deflateAccepted(undefined)).toBe(false)
    expect(deflateAccepted('permessage-deflate')).toBe('invalid')
    expect(deflateAccepted('permessage-deflate; server_no_context_takeover; client_max_window_bits=10')).toBe('invalid')
    expect(deflateAccepted('x-other')).toBe('invalid')
    expect(deflateAccepted(DEFLATE_RESPONSE + ', ' + DEFLATE_RESPONSE)).toBe('invalid')
  })
})
