// @vitest-environment node
/**
 * A shell push byte for byte the last one a client was pushed, with no events to bring, is not written again (ADR-0025,
 * October 18 amendment). On the forge host each thread open sent two to four shells of about 130 KB, some the same.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { SocketFrames } from '../../src/host/socketFrames'
import { startSocketServer } from '../../src/host/socketServer'
import type { HostService } from '../../src/main/agents/hostService'
import type { AgentState } from '../../src/shared/agents'
import type { StoredThreadEvent } from '../../src/shared/threadEvents'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const listeners: Awaited<ReturnType<typeof startSocketServer>>[] = []
const raws: SocketFrames[] = []
afterEach(async () => {
  for (const frames of raws.splice(0)) frames.close()
  for (const listener of listeners.splice(0)) await listener.close()
})

/**
 * The fixture's host, with the test deciding when it publishes, what it publishes and which extra events its log holds.
 * `reads` counts shell reads: a publish reads the shell once, as it sends, so a read means the publish has been handled.
 */
async function controlledHost() {
  let publish: (state: AgentState) => void = () => undefined
  const extra: StoredThreadEvent[] = []
  const counters = { reads: 0 }
  const real = fixture.host.service
  const service: HostService = {
    shell: () => { counters.reads++; return real.shell() }, state: () => real.state(), threadDetail: id => real.threadDetail(id),
    command: (command, identity) => real.command(command, identity),
    events: (afterSeq, threadId, limit) => [...real.events(afterSeq, threadId, limit), ...extra.filter(row => row.seq > afterSeq && (!threadId || row.threadId === threadId))].slice(0, limit),
    subscribe: listener => { publish = listener; return () => undefined },
  }
  const listener = await startSocketServer({ service, pairing: fixture.host.pairing })
  listeners.push(listener)
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Sotto desktop')
  const peer = await rawPeer(listener.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
  raws.push(peer.frames)
  const shells = () => peer.messages.filter(message => message.event === 'shell') as { state: AgentState; eventPage: { events: StoredThreadEvent[]; latestSeq: number } }[]
  /** Publishes the host's shell and waits until the listener has handled it. */
  const published = async (): Promise<void> => {
    const before = counters.reads
    publish(real.shell())
    await expect.poll(() => counters.reads).toBeGreaterThan(before)
  }
  return { peer, shells, published, extra, real }
}

describe('a shell the client already has', () => {
  it('is not pushed again, and a changed one is', async () => {
    const { peer, shells, published, real } = await controlledHost()
    await peer.call('hello', { op: 'hello' })
    // The first push after hello goes whatever it repeats: hello's own shell is an answer, not a push.
    await published()
    await expect.poll(() => shells().length).toBe(1)
    await published()
    await published()
    // Configuring the host directly changes the shell without an answer reaching this client.
    await real.command({ type: 'configure', patch: { enabled: !real.shell().configuration.enabled } }, { clientId: 'test', user: '', transport: 'socket' })
    await published()
    await expect.poll(() => shells().length).toBe(2)
    expect(shells()[1]!.state.configuration.enabled).toBe(real.shell().configuration.enabled)
    expect(shells()[0]!.state.configuration.enabled).not.toBe(shells()[1]!.state.configuration.enabled)
    expect(peer.frames.isClosed).toBe(false)
  })

  it('is pushed again when it brings events, and its cursor moves past them only once', async () => {
    const { peer, shells, published, extra, real } = await controlledHost()
    // A client that reads the event stream says where it is in it; this one starts from the beginning.
    await peer.call('hello', { op: 'hello', afterSeq: 0 })
    await published()
    await expect.poll(() => shells().length).toBe(1)
    const threadId = real.shell().host.threads[0]!.id, seq = shells()[0]!.eventPage.latestSeq + 1
    extra.push({ seq, threadId, event: { kind: 'messages-reset', at: '2026-10-18T00:00:00.000Z' } })
    await published()
    await expect.poll(() => shells().length).toBe(2)
    expect(shells()[1]!.eventPage.events.map(row => row.seq)).toEqual([seq])
    // The same shell with nothing after the cursor is not sent; a later event is, alone.
    await published()
    extra.push({ seq: seq + 1, threadId, event: { kind: 'messages-reset', at: '2026-10-18T00:00:01.000Z' } })
    await published()
    await expect.poll(() => shells().length).toBe(3)
    expect(shells()[2]!.eventPage.events.map(row => row.seq)).toEqual([seq + 1])
  })

  it('is pushed again after an answer that carried a shell', async () => {
    const { peer, shells, published } = await controlledHost()
    await peer.call('hello', { op: 'hello' })
    await published()
    await expect.poll(() => shells().length).toBe(1)
    await published()
    // A shell read answers with a shell, which the client takes as its picture; the next push goes even though it repeats.
    await peer.call('read', { op: 'shell' })
    await published()
    await expect.poll(() => shells().length).toBe(2)
    expect(shells()[1]!.state).toEqual(shells()[0]!.state)
  })
})
