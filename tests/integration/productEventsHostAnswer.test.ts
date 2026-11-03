// @vitest-environment node
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { PRODUCT_EVENTS_INSTALL_FILE } from '../../src/main/productEvents/identity'
import { ProductEvents, productEventsFromDesktops, type ProductEventPermission } from '../../src/main/productEvents/productEvents'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()

describe('a host follows its desktops’ answers for product events (ADR-0179)', () => {
  let directory: string
  let sent: { batch: { event: string }[] }[]
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sotto-product-events-host-')); sent = [] })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
  const hasId = (): Promise<boolean> => stat(join(directory, PRODUCT_EVENTS_INSTALL_FILE)).then(() => true, () => false)

  /** A host's sender behind a real listener, joined the way `src/host/index.ts` joins them. */
  async function hostWithSender(tailnetDesktops?: (clientId: string) => boolean) {
    const events = new ProductEvents({ endpoint: 'https://events.test', dataDirectory: directory, environment: {}, holdWhileWaiting: true,
      install: { appVersion: '0.1.43', channel: 'stable', surface: 'host', platform: 'linux', arch: 'x64' }, homes: { claudeFile: join(directory, 'none'), codexHome: join(directory, 'none') },
      readOwners: async () => [], fetch: (async (_url: unknown, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body)) as typeof sent[number]); return new Response('ok') }) as unknown as typeof fetch })
    let answers = (): ProductEventPermission[] => []
    const server = await startSocketServer({ service: fixture.host.service, pairing: fixture.host.pairing, watcherDesktops: { refresh: async () => undefined, has: () => true },
      // Only the tailnet listener tells a phone from a desktop; everyone on the loopback one came over SSH as a desktop.
      ...tailnetDesktops ? { tailnet: { phonesAdmitted: () => true, desktops: { refresh: async () => undefined, has: tailnetDesktops } } } : {},
      onProductEventAnswer: () => events.setPermission(productEventsFromDesktops(answers())) })
    answers = () => server.productEventAnswers()
    return { events, server }
  }
  async function desktop(port: number, answer: ProductEventPermission): Promise<{ client: SocketHostService; say(next: ProductEventPermission): void }> {
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Laptop')
    let current = answer
    const client = new SocketHostService({ url: 'http://127.0.0.1:' + port, token: paired.token, productEventAnswer: () => current }); fixture.clients.push(client)
    await client.connect()
    return { client, say: next => { current = next; client.tellProductEventAnswer() } }
  }
  const events = (): string[] => sent.flatMap(body => body.batch.map(event => event.event))

  it('holds events in memory with no ID until a desktop says on, then sends what it held', async () => {
    const { events: sender, server } = await hostWithSender()
    sender.record('app.started', { pairedHosts: 0 }); await sender.flush()
    expect(sent).toEqual([]); expect(sender.waitingCount).toBe(1); expect(await hasId()).toBe(false)

    const laptop = await desktop(server.descriptor.port, 'waiting')
    await expect.poll(() => server.productEventAnswers()).toEqual(['waiting'])
    await sender.flush()
    expect(sent).toEqual([]); expect(sender.waitingCount).toBe(1); expect(await hasId()).toBe(false)

    laptop.say('on')
    await expect.poll(() => server.productEventAnswers()).toEqual(['on'])
    await sender.flush()
    expect(events()).toEqual(['app.started']); expect(await hasId()).toBe(true)
  })

  it('drops what it held and deletes its ID when any connected desktop says off, and that desktop leaving lifts it', async () => {
    const { events: sender, server } = await hostWithSender()
    await desktop(server.descriptor.port, 'on')
    await expect.poll(() => server.productEventAnswers()).toEqual(['on'])
    sender.record('app.started', { pairedHosts: 0 }); await sender.flush()
    expect(await hasId()).toBe(true)
    sender.record('feature.used', { feature: 'files' })

    const second = await desktop(server.descriptor.port, 'off')
    await expect.poll(() => sender.waitingCount).toBe(0)
    await expect.poll(hasId).toBe(false)
    sender.record('feature.used', { feature: 'files' }); await sender.flush()
    expect(sender.waitingCount).toBe(0); expect(events()).toEqual(['app.started'])

    await second.client.close()
    await expect.poll(() => server.productEventAnswers()).toEqual(['on'])
    sender.record('feature.used', { feature: 'council' }); await sender.flush()
    expect(events()).toEqual(['app.started', 'feature.used'])
  })

  it('stops sending and holds again when the last desktop leaves, sending nothing until one comes back', async () => {
    const { events: sender, server } = await hostWithSender()
    const laptop = await desktop(server.descriptor.port, 'on')
    await expect.poll(() => server.productEventAnswers()).toEqual(['on'])
    await laptop.client.close()
    await expect.poll(() => server.productEventAnswers()).toEqual([])
    sender.record('app.started', { pairedHosts: 0 }); await sender.flush()
    expect(sent).toEqual([]); expect(sender.waitingCount).toBe(1)
    await desktop(server.descriptor.port, 'off')
    await expect.poll(() => sender.waitingCount).toBe(0)
    expect(sent).toEqual([])
  })

  it('takes a desktop’s change of mind while it stays connected', async () => {
    const { events: sender, server } = await hostWithSender()
    const laptop = await desktop(server.descriptor.port, 'on')
    await expect.poll(() => server.productEventAnswers()).toEqual(['on'])
    laptop.say('off')
    await expect.poll(() => server.productEventAnswers()).toEqual(['off'])
    sender.record('app.started', { pairedHosts: 0 }); await sender.flush()
    expect(sent).toEqual([]); expect(sender.waitingCount).toBe(0)
  })

  it('a desktop\u2019s off is told again when a telling fails, and goes out as the latest answer', async () => {
    const { server } = await hostWithSender()
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Laptop')
    let current: ProductEventPermission = 'on'
    const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token, productEventAnswer: () => current, productEventAnswerRetryMs: 5 }); fixture.clients.push(client)
    await client.connect()
    await expect.poll(() => server.productEventAnswers()).toEqual(['on'])
    // The connection's request queue is full, as it can be: the first telling of off is refused before it goes.
    const internals = client as unknown as { call(operation: { op: string }): Promise<unknown> }
    const realCall = internals.call.bind(client)
    let refused = 0
    internals.call = operation => operation.op === 'product-events-answer' && refused++ < 2 ? Promise.reject(new Error('busy')) : realCall(operation)
    current = 'off'; client.tellProductEventAnswer()
    await expect.poll(() => server.productEventAnswers()).toEqual(['off'])
    expect(refused).toBeGreaterThanOrEqual(3)
  })

  it('a change during a telling is told as soon as that one ends', async () => {
    const { server } = await hostWithSender()
    const laptop = await desktop(server.descriptor.port, 'waiting')
    await expect.poll(() => server.productEventAnswers()).toEqual(['waiting'])
    laptop.say('on'); laptop.say('off')
    await expect.poll(() => server.productEventAnswers()).toEqual(['off'])
  })

  it('a second hello that no longer takes part takes the answer back, and the host stops sending', async () => {
    const { events: sender, server } = await hostWithSender()
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Laptop')
    const peer = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    await peer.call('hello', { op: 'hello', accepts: ['product-events'] })
    await peer.call('answer', { op: 'product-events-answer', permission: 'on' })
    await expect.poll(() => server.productEventAnswers()).toEqual(['on'])
    await peer.call('hello-again', { op: 'hello', accepts: [] })
    expect(server.productEventAnswers()).toEqual([])
    sender.record('app.started', { pairedHosts: 0 }); await sender.flush()
    expect(sent).toEqual([]); expect(sender.waitingCount).toBe(1)
    peer.frames.close()
  })

  it('stops counting a revoked desktop at once, whichever listener revoked it', async () => {
    const { server } = await hostWithSender()
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Laptop')
    const peer = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    await peer.call('hello', { op: 'hello', accepts: ['product-events'] })
    await peer.call('answer', { op: 'product-events-answer', permission: 'on' })
    await expect.poll(() => server.productEventAnswers()).toEqual(['on'])
    await fixture.host.pairing.revoke(paired.clientId)
    expect(server.productEventAnswers()).toEqual([])
    peer.frames.close()
  })

  it('a host that joins the router, or replaces itself there, is told the answer as it stands by then', async () => {
    const { server } = await hostWithSender()
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Laptop')
    let current: ProductEventPermission = 'on'
    const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token, productEventAnswer: () => current }); fixture.clients.push(client)
    const hello = await client.connect()
    await expect.poll(() => server.productEventAnswers()).toEqual(['on'])
    // The setting changed during setup, before the router could reach this connection.
    current = 'off'
    const router = new DesktopHostRouter(emptyDesktopState)
    const connection = { hostId: hello.hostId, name: 'forge', kind: 'remote', service: client, detail: (id: string) => client.readThreadDetail(id), preview: () => null } as const
    router.add(connection)
    await expect.poll(() => server.productEventAnswers()).toEqual(['off'])
    current = 'on'; router.tellProductEventAnswer()
    await expect.poll(() => server.productEventAnswers()).toEqual(['on'])
    current = 'off'; router.replace(connection)
    await expect.poll(() => server.productEventAnswers()).toEqual(['off'])
  })

  it('gives a phone no say: it is not offered the feature, and its answer is refused', async () => {
    const { server } = await hostWithSender(() => false)
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'iPhone')
    const phone = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    const hello = await phone.call('hello', { op: 'hello', accepts: ['product-events'] }) as { result?: { features?: string[] } }
    expect(hello.result?.features).not.toContain('product-events')
    const answer = await phone.call('answer', { op: 'product-events-answer', permission: 'on' }) as { ok: boolean }
    expect(answer.ok).toBe(false)
    expect(server.productEventAnswers()).toEqual([])
    phone.frames.close()
  })

  it('a desktop that does not take part has no say, and a host with no sender does not list it', async () => {
    const { server } = await hostWithSender()
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Older desktop')
    const older = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); fixture.clients.push(older)
    await older.connect()
    older.tellProductEventAnswer()
    expect(server.productEventAnswers()).toEqual([])

    const plain = await startSocketServer({ service: fixture.host.service, pairing: fixture.host.pairing, watcherDesktops: { refresh: async () => undefined, has: () => true } })
    const second = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop')
    const peer = await rawPeer(plain.descriptor.port, fixture.host.pairing.signSession(second.clientId))
    const hello = await peer.call('hello', { op: 'hello', accepts: ['product-events'] }) as { result?: { features?: string[] } }
    expect(hello.result?.features).not.toContain('product-events')
    peer.frames.close()
    await plain.stopServing()
  })
})

describe('a headless host', () => {
  it('lists product events for a desktop', async () => {
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Laptop')
    const peer = await rawPeer(fixture.host.descriptor!.port, fixture.host.pairing.signSession(paired.clientId))
    const hello = await peer.call('hello', { op: 'hello', accepts: ['product-events'] }) as { result?: { features?: string[] } }
    expect(hello.result?.features).toContain('product-events')
    peer.frames.close()
  })
})
