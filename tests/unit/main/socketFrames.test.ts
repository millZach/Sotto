// @vitest-environment node
import { Duplex } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
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
