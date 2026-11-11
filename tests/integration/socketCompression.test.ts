// @vitest-environment node
/**
 * `permessage-deflate` on the host socket (ADR-0025, October 18 amendment): a desktop that offers it is sent its messages
 * compressed, and nobody else is, whatever they offer, unless the listener's phone compression switch is on (the November
 * 10 amendment, #2394), and then a phone that offers it is sent its messages as a desktop is.
 */
import { connect, createServer, type AddressInfo, type Server } from 'node:net'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFLATE_OFFER, DEFLATE_RESPONSE, DEFLATE_SYNC_MAX_BYTES, deflateAccepted, SocketFrames } from '../../src/host/socketFrames'
import { startSocketServer } from '../../src/host/socketServer'
import type { HostService } from '../../src/main/agents/hostService'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import type { AgentThreadDetail, AgentThreadDetailUpdate } from '../../src/shared/agents'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const listeners: Awaited<ReturnType<typeof startSocketServer>>[] = []
const raws: SocketFrames[] = []
const relays: Server[] = []
afterEach(async () => {
  for (const relay of relays.splice(0)) relay.close()
  for (const frames of raws.splice(0)) frames.close()
  for (const listener of listeners.splice(0)) await listener.close()
  vi.restoreAllMocks()
})

type Inflating = { inflate: (payload: Buffer) => Buffer }
/** Counts the compressed messages each connection's frames inflated. */
const inflations = () => vi.spyOn(SocketFrames.prototype as unknown as Inflating, 'inflate')
const framesOf = (client: SocketHostService): SocketFrames => (client as unknown as { frames: SocketFrames }).frames

/** A long history shaped like command output: a few hundred kilobytes of repeated lines per message. */
const longThread = (): AgentThreadDetail => ({ threadId: 'long', revision: 1, messages: Array.from({ length: 12 }, (_, index) => ({
  id: 'message-' + index, role: 'assistant' as const, createdAt: '2026-10-18T00:00:00.000Z',
  text: Array.from({ length: 4000 }, (_, line) => `src/main/agents/socketHostService.ts:${line} ok ${index}`).join('\n') })) })

async function listen(options: Partial<Parameters<typeof startSocketServer>[0]> & { service?: HostService } = {}) {
  const listener = await startSocketServer({ service: fixture.host.service, pairing: fixture.host.pairing, ...options })
  listeners.push(listener)
  return listener
}
async function session(name: string, port?: number) {
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, name)
  return { paired, session: fixture.host.pairing.signSession(paired.clientId), url: port === undefined ? fixture.url : 'http://127.0.0.1:' + port }
}
async function peer(port: number, token: string, offer?: string) {
  const connected = await rawPeer(port, token, offer ? { offer } : {})
  raws.push(connected.frames)
  return connected
}

/** The offer the iPhone's `URLSessionWebSocketTask` makes by itself, as forge's tailnet listener saw it (#2394). */
const IPHONE_OFFER = 'permessage-deflate'
/** The host's service with one long thread to read: `long`, the rest as the fixture host has it. */
const serviceWithLongThread = (detail: AgentThreadDetail): HostService => ({
  shell: () => fixture.host.service.shell(), state: () => fixture.host.service.state(),
  events: (afterSeq, threadId, limit) => fixture.host.service.events(afterSeq, threadId, limit), subscribe: listener => fixture.host.service.subscribe(listener),
  threadDetail: id => id === 'long' ? structuredClone(detail) : fixture.host.service.threadDetail(id),
  command: (command, identity) => fixture.host.service.command(command, identity),
  subscribeThreadDetail: () => () => undefined,
})
/** A listener shaped like a headless host's tailnet listener, where no client is recorded as a desktop, so every peer is a phone. */
const phoneListener = (service: HostService, compressPhones: boolean) => listen({ service, admin: false, ...(compressPhones ? { compressPhones } : {}),
  tailnet: { phonesAdmitted: () => true, desktops: { has: () => false, refresh: async () => undefined } } })
type WireFrame = { fin: boolean; rsv1: boolean; opcode: number; size: number }
/**
 * The frames a listener writes to a raw peer, read off its stream beside the peer's own reader: each frame's FIN and RSV1
 * bits, opcode and payload size. The listener writes nothing before the peer's hello, so nothing is missed.
 */
function wireFrames(stream: Duplex): WireFrame[] {
  const seen: WireFrame[] = []
  let buffer: Buffer = Buffer.alloc(0)
  stream.on('data', (chunk: Buffer) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    for (;;) {
      if (buffer.length < 2) return
      let size = buffer[1]! & 127, offset = 2
      if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4 }
      else if (size === 127) { if (buffer.length < 10) return; size = Number(buffer.readBigUInt64BE(2)); offset = 10 }
      if (buffer.length < offset + size) return
      seen.push({ fin: (buffer[0]! & 0x80) !== 0, rsv1: (buffer[0]! & 0x40) !== 0, opcode: buffer[0]! & 15, size })
      buffer = buffer.subarray(offset + size)
    }
  })
  return seen
}

describe('compressed host socket messages', () => {
  it('compresses what a desktop is sent, a long thread among it, and the desktop reads it as sent', async () => {
    const detail = longThread()
    let emit: (update: AgentThreadDetailUpdate) => void = () => undefined
    const service: HostService = {
      shell: () => fixture.host.service.shell(), state: () => fixture.host.service.state(),
      events: (afterSeq, threadId, limit) => fixture.host.service.events(afterSeq, threadId, limit), subscribe: listener => fixture.host.service.subscribe(listener),
      threadDetail: id => id === 'long' ? structuredClone(detail) : fixture.host.service.threadDetail(id),
      command: (command, identity) => {
        if (command.type === 'observe-threads' && command.threadIds.includes('long')) emit(structuredClone(detail))
        return fixture.host.service.command(command, identity)
      },
      subscribeThreadDetail: listener => { emit = listener; return () => undefined },
    }
    const listener = await listen({ service })
    const { paired } = await session('Sotto desktop')
    const inflated = inflations()
    const client = new SocketHostService({ url: 'http://127.0.0.1:' + listener.descriptor.port, token: paired.token }); fixture.clients.push(client)
    await client.connect()
    const frames = framesOf(client)
    expect(frames.deflate).toBe(true)
    const updates: AgentThreadDetailUpdate[] = []
    client.subscribeThreadDetail(update => updates.push(update))
    const before = inflated.mock.contexts.filter(context => context === frames).length
    expect(before).toBeGreaterThan(0)
    await client.observe(['long'])
    await expect.poll(() => updates.some(update => 'messages' in update && update.threadId === 'long')).toBe(true)
    const received = updates.find(update => 'messages' in update && update.threadId === 'long') as AgentThreadDetail
    expect(received.messages).toEqual(detail.messages)
    expect(inflated.mock.contexts.filter(context => context === frames).length).toBeGreaterThan(before)
    // What was inflated is what the host wrote: the compressed payload is a fraction of the history it carried.
    const largest = Math.max(...inflated.mock.calls.map(([payload]) => payload.length))
    expect(largest).toBeLessThan(Buffer.byteLength(JSON.stringify(detail)) / 4)
  })

  it('answers a peer that offers nothing without the extension, and sends it nothing compressed', async () => {
    const listener = await listen()
    const { session: token } = await session('Plain peer')
    const plain = await peer(listener.descriptor.port, token)
    expect(plain.extensions).toBeUndefined()
    expect(plain.frames.deflate).toBe(false)
    // A frame with RSV1 on this connection would close it; the hello and its shell, over a kilobyte, arrive instead.
    const hello = await plain.call('hello', { op: 'hello' })
    expect(hello).toMatchObject({ ok: true })
    expect(Buffer.byteLength(JSON.stringify(hello))).toBeGreaterThan(1024)
    expect(plain.frames.isClosed).toBe(false)
  })

  it('accepts the offer of a desktop on a listener that tells desktops apart, and refuses a phone that offers it', async () => {
    const desktop = await session('Sotto desktop'), phone = await session('Zach’s iPhone'), late = await session('Late desktop')
    const desktops = new Set([desktop.paired.clientId])
    let reads = 0
    const listener = await listen({ admin: false, tailnet: { phonesAdmitted: () => true,
      desktops: { has: id => desktops.has(id), refresh: async () => { reads++; desktops.add(late.paired.clientId); return desktops } } } })
    const port = listener.descriptor.port
    const computer = await peer(port, desktop.session, DEFLATE_OFFER)
    expect(computer.extensions).toBe('permessage-deflate; server_no_context_takeover; client_no_context_takeover')
    expect(computer.frames.deflate).toBe(true)
    expect(await computer.call('hello', { op: 'hello' })).toMatchObject({ ok: true })

    // An Android phone's OkHttp offers the extension by default; a phone is left uncompressed all the same.
    const handset = await peer(port, phone.session, 'permessage-deflate; client_max_window_bits')
    expect(handset.extensions).toBeUndefined()
    expect(handset.frames.deflate).toBe(false)
    expect(await handset.call('hello', { op: 'hello' })).toMatchObject({ ok: true })
    expect(handset.frames.isClosed).toBe(false)
    // So is an iPhone, whose URLSession offers the extension bare, while the phone compression switch is off.
    const iphone = await peer(port, phone.session, IPHONE_OFFER)
    expect(iphone.extensions).toBeUndefined()
    expect(iphone.frames.deflate).toBe(false)
    expect(await iphone.call('hello', { op: 'hello' })).toMatchObject({ ok: true })
    expect(iphone.frames.isClosed).toBe(false)

    // A desktop the launch script recorded after the listener last read the record is found by reading it again.
    const recorded = await peer(port, late.session, DEFLATE_OFFER)
    expect(recorded.frames.deflate).toBe(true)
    expect(reads).toBeGreaterThan(0)
  })

  it('connects uncompressed when the answer to its offer is one it never made', async () => {
    const listener = await listen()
    const { paired } = await session('Sotto desktop')
    // A proxy in the way that drops a parameter from the host's answer leaves compression the desktop cannot use.
    const upgrades: boolean[] = []
    const relay = createServer(inbound => {
      const outbound = connect(listener.descriptor.port, '127.0.0.1')
      inbound.once('data', (first: Buffer) => { upgrades.push(first.toString('latin1').includes('Sec-WebSocket-Extensions')); outbound.write(first); inbound.pipe(outbound) })
      let head = true
      outbound.on('data', (chunk: Buffer) => {
        inbound.write(head ? Buffer.from(chunk.toString('latin1').replace('permessage-deflate; server_no_context_takeover; ', 'permessage-deflate; '), 'latin1') : chunk)
        head = false
      })
      inbound.on('close', () => outbound.destroy()); outbound.on('close', () => inbound.destroy())
      inbound.on('error', () => undefined); outbound.on('error', () => undefined)
    })
    relays.push(relay)
    await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve))
    const client = new SocketHostService({ url: 'http://127.0.0.1:' + (relay.address() as AddressInfo).port, token: paired.token }); fixture.clients.push(client)
    await client.connect()
    expect(framesOf(client).deflate).toBe(false)
    expect(client.shell().host.hostId).toBe(fixture.host.service.shell().host.hostId)
    // The health check and session go first; then one upgrade offering compression, and one offering none.
    expect(upgrades.slice(-2)).toEqual([true, false])
  })

  it('compresses nothing on the desktop’s own phone listener, and a desktop client there reads its messages uncompressed', async () => {
    const listener = await listen({ admin: false })
    const phone = await session('Zach’s iPhone', listener.descriptor.port)
    const handset = await peer(listener.descriptor.port, phone.session, DEFLATE_OFFER)
    expect(handset.extensions).toBeUndefined()
    expect(handset.frames.deflate).toBe(false)
    // The desktop's client offers the extension to every host; one that answers without it, as an older host does, still serves it.
    const client = new SocketHostService({ url: phone.url, token: phone.paired.token }); fixture.clients.push(client)
    await client.connect()
    expect(framesOf(client).deflate).toBe(false)
    expect(client.shell().host.hostId).toBe(fixture.host.service.shell().host.hostId)
  })

  it('answers an iPhone’s bare offer with phone compression on, and the phone reads compressed messages, one over 64 KiB among them', async () => {
    const detail = longThread()
    const listener = await phoneListener(serviceWithLongThread(detail), true)
    const phone = await session('Zach’s iPhone')
    const iphone = await peer(listener.descriptor.port, phone.session, IPHONE_OFFER)
    // The desktop's answer, which is a valid one to an offer that asked for neither parameter (RFC 7692 section 7.1.1):
    // a server may add `server_no_context_takeover` unasked, and a client must support `client_no_context_takeover`.
    expect(iphone.extensions).toBe(DEFLATE_RESPONSE)
    expect(deflateAccepted(iphone.extensions)).toBe(true)
    expect(iphone.frames.deflate).toBe(true)
    const wire = wireFrames(iphone.stream)
    const inflated = inflations()
    const hello = await iphone.call('hello', { op: 'hello' })
    expect(hello).toMatchObject({ ok: true })
    expect(Buffer.byteLength(JSON.stringify(hello))).toBeGreaterThan(1024)
    // A thread read whole, too large to compress on the loop: it is compressed on the thread pool and arrives as sent.
    const read = await iphone.call('long', { op: 'detail', threadId: 'long' })
    expect((read.result as unknown as AgentThreadDetail).messages).toEqual(detail.messages)
    const detailBytes = Buffer.byteLength(JSON.stringify(read))
    expect(detailBytes).toBeGreaterThan(DEFLATE_SYNC_MAX_BYTES)
    // Every message went as one frame, never in fragments, the hello and the thread with RSV1, and no frame on the wire
    // came near the thread's own size.
    expect(wire.length).toBeGreaterThanOrEqual(2)
    expect(wire.every(frame => frame.fin && frame.opcode !== 0)).toBe(true)
    expect(wire.filter(frame => frame.rsv1).length).toBeGreaterThanOrEqual(2)
    expect(Math.max(...wire.map(frame => frame.size))).toBeLessThan(detailBytes / 4)
    expect(inflated.mock.contexts.filter(context => context === iphone.frames).length).toBeGreaterThanOrEqual(2)
    expect(iphone.frames.isClosed).toBe(false)
  })

  it('sends a phone that offers nothing no compressed frame, with phone compression on or off', async () => {
    const detail = longThread()
    for (const compressPhones of [false, true]) {
      const listener = await phoneListener(serviceWithLongThread(detail), compressPhones)
      const phone = await session(compressPhones ? 'Phone on a compressing listener' : 'Phone on a plain listener')
      const plain = await peer(listener.descriptor.port, phone.session)
      expect(plain.extensions).toBeUndefined()
      expect(plain.frames.deflate).toBe(false)
      const wire = wireFrames(plain.stream)
      expect(await plain.call('hello', { op: 'hello' })).toMatchObject({ ok: true })
      const read = await plain.call('long', { op: 'detail', threadId: 'long' })
      expect((read.result as unknown as AgentThreadDetail).messages).toEqual(detail.messages)
      expect(wire.some(frame => frame.rsv1)).toBe(false)
      expect(Math.max(...wire.map(frame => frame.size))).toBeGreaterThan(DEFLATE_SYNC_MAX_BYTES)
      expect(plain.frames.isClosed).toBe(false)
    }
  })
})
