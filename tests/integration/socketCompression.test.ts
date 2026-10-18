// @vitest-environment node
/**
 * `permessage-deflate` on the host socket (ADR-0025, October 18 amendment): a desktop that offers it is sent its messages
 * compressed, and nobody else is, whatever they offer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFLATE_OFFER, SocketFrames } from '../../src/host/socketFrames'
import { startSocketServer } from '../../src/host/socketServer'
import type { HostService } from '../../src/main/agents/hostService'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import type { AgentThreadDetail, AgentThreadDetailUpdate } from '../../src/shared/agents'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const listeners: Awaited<ReturnType<typeof startSocketServer>>[] = []
const raws: SocketFrames[] = []
afterEach(async () => {
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

    // A desktop the launch script recorded after the listener last read the record is found by reading it again.
    const recorded = await peer(port, late.session, DEFLATE_OFFER)
    expect(recorded.frames.deflate).toBe(true)
    expect(reads).toBeGreaterThan(0)
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
})
