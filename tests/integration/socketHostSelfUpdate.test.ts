// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PairedClients } from '../../src/main/agents/pairing'
import type { HostService } from '../../src/main/agents/hostService'
import { startSocketServer } from '../../src/host/socketServer'
import type { HostUpdateContext, HostUpdateRequest } from '../../src/host/selfUpdate'
import type { SocketFrames } from '../../src/host/socketFrames'
import type { HostUpdateAnswer } from '../../src/shared/hostSelfUpdate'
import { rawPeer } from '../fixtures/rawHostPeer'

/**
 * Who a host that updates itself offers it to (ADR-0087): a desktop the launch script recorded, whose remote-answer policy
 * lets it answer, on either listener. A phone, a desktop the host does not know as one, and a desktop without the grant are
 * offered nothing and refused, and only a client whose hello accepts the feature is sent its steps.
 */
let directory: string | undefined
const listeners: Awaited<ReturnType<typeof startSocketServer>>[] = []
const raws: SocketFrames[] = []
afterEach(async () => {
  for (const frames of raws.splice(0)) frames.close()
  for (const listener of listeners.splice(0)) await listener.close()
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})
const service = { shell: () => ({ hostId: 'host', host: { threads: [], models: [] }, queue: [] }), subscribe: () => () => {}, events: () => [],
  command: async () => ({}) } as unknown as HostService

async function setUp(options: { tailnet?: boolean; hostUpdate?: boolean } = {}) {
  directory = await mkdtemp(join(tmpdir(), 'sotto-self-update-socket-'))
  const pairing = new PairedClients(directory); await pairing.load()
  const pair = (name: string) => pairing.redeem(pairing.issuePairingCode().code, name)
  const desktop = await pair('Sotto desktop'), ungranted = await pair('Sotto laptop'), unrecorded = await pair('Another desktop'), phone = await pair('Zach’s iPhone')
  const desktops = new Set([desktop.clientId, ungranted.clientId])
  const granted = new Set([desktop.clientId, unrecorded.clientId, phone.clientId])
  const asked: { request: HostUpdateRequest; context: HostUpdateContext }[] = [], delivered: number[] = []
  let reply: (request: HostUpdateRequest, context: HostUpdateContext) => Promise<HostUpdateAnswer> = async () => ({ type: 'update-outcome', running: '1.2.3', restart: { state: 'none' } })
  const record = { refresh: async () => undefined, has: (id: string) => desktops.has(id) }
  const listener = await startSocketServer({ service, pairing, watcherDesktops: record, mayAnswer: client => granted.has(client.clientId),
    ...(options.hostUpdate === false ? {} : { hostUpdate: { run: (request, context) => { asked.push({ request, context }); return reply(request, context) }, delivered: async () => { delivered.push(asked.length) } } }),
    ...(options.tailnet ? { admin: false, tailnet: { desktops: record, phonesAdmitted: () => true } } : {}) })
  listeners.push(listener)
  const connect = async (clientId: string) => {
    const session = pairing.signSession(clientId), peer = await rawPeer(listener.descriptor.port, session)
    raws.push(peer.frames)
    return { ...peer, session }
  }
  return { listener, desktop, ungranted, unrecorded, phone, granted, asked, delivered, connect, setReply: (next: typeof reply) => { reply = next } }
}
const featuresOf = (message: Record<string, unknown>): string[] => (message.result as { features: string[] }).features

for (const tailnet of [false, true]) {
  it(`offers it on the ${tailnet ? 'tailnet' : 'SSH'} listener only to a recorded desktop that may answer, and refuses everyone else`, async () => {
    const { listener, desktop, ungranted, unrecorded, phone, asked, delivered, connect } = await setUp({ tailnet })
    // Health lists what the listener offers.
    expect(listener.descriptor.features).toContain('host-update')
    expect(((await (await fetch(`http://127.0.0.1:${listener.descriptor.port}/v1/health`)).json()) as { features: string[] }).features).toContain('host-update')
    const owner = await connect(desktop.clientId)
    expect(featuresOf(await owner.call('hello', { op: 'hello', accepts: ['host-update'] }))).toContain('host-update')
    expect(await owner.call('outcome', { op: 'host-update', action: 'outcome' })).toMatchObject({ ok: true, result: { type: 'update-outcome', running: '1.2.3' } })
    expect(asked.map(item => item.request)).toEqual([{ action: 'outcome', version: undefined, file: undefined, sha256: undefined }])
    // Only the answer of a restart that went ahead is waited on; this one is not.
    expect(delivered).toEqual([])
    for (const [who, client] of [['a desktop without the grant', ungranted], ['a desktop the host does not know as one', unrecorded], ['a phone', phone]] as const) {
      const peer = await connect(client.clientId)
      expect(featuresOf(await peer.call('hello', { op: 'hello', accepts: ['host-update'] })), who).not.toContain('host-update')
      expect(await peer.call('fetch', { op: 'host-update', action: 'fetch', version: '1.2.4' }), who).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
    expect(asked).toHaveLength(1)
  })
}

it('takes the feature away at once when the desktop’s grant is revoked, and refuses a request before hello', async () => {
  const { desktop, granted, asked, connect } = await setUp()
  const peer = await connect(desktop.clientId)
  expect(await peer.call('early', { op: 'host-update', action: 'outcome' })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  expect(featuresOf(await peer.call('hello', { op: 'hello', accepts: ['host-update'] }))).toContain('host-update')
  granted.delete(desktop.clientId)
  expect(await peer.call('denied', { op: 'host-update', action: 'outcome' })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(asked).toEqual([])
})

it('tells the host once the answer of a restart that went ahead is on its way, and for no other answer', async () => {
  const { desktop, delivered, connect, setReply } = await setUp()
  const peer = await connect(desktop.clientId)
  await peer.call('hello', { op: 'hello', accepts: ['host-update'] })
  setReply(async request => request.action === 'restart' ? { type: 'update-restarting', version: '1.2.4' } : { type: 'update-cancelled', cancelled: false })
  expect(await peer.call('cancel', { op: 'host-update', action: 'cancel' })).toMatchObject({ ok: true })
  expect(delivered).toEqual([])
  expect(await peer.call('restart', { op: 'host-update', action: 'restart', version: '1.2.4' })).toMatchObject({ ok: true, result: { type: 'update-restarting' } })
  await expect.poll(() => delivered).toEqual([2])
})

it('is not offered by a host that cannot update itself', async () => {
  const { listener, desktop, connect } = await setUp({ hostUpdate: false })
  expect(listener.descriptor.features).not.toContain('host-update')
  const peer = await connect(desktop.clientId)
  expect(featuresOf(await peer.call('hello', { op: 'hello', accepts: ['host-update'] }))).not.toContain('host-update')
  expect(await peer.call('fetch', { op: 'host-update', action: 'fetch', version: '1.2.4' })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
})

it('sends the steps only to a client that accepts them, and tells the update when that client has gone', async () => {
  const { desktop, asked, connect, setReply } = await setUp()
  let release!: () => void
  const held = new Promise<void>(done => { release = done })
  setReply(async (_request, context) => { context.onStep('download'); context.onStep('check'); await held; return { type: 'update-cancelled', cancelled: true } })
  const steps = (peer: { messages: Record<string, unknown>[] }): unknown[] => peer.messages.filter(message => message.event === 'host-update-step').map(message => message.step)
  const accepting = await connect(desktop.clientId)
  await accepting.call('hello', { op: 'hello', accepts: ['host-update'] })
  const silent = await connect(desktop.clientId)
  await silent.call('hello', { op: 'hello' })
  const quiet = silent.call('fetch-silent', { op: 'host-update', action: 'fetch', version: '1.2.4' })
  await expect.poll(() => asked.length).toBe(1)
  // Sent without waiting for its answer, which never comes: its socket closes first.
  accepting.frames.send({ v: 1, id: 'fetch-accepting', session: accepting.session, op: 'host-update', action: 'fetch', version: '1.2.4' })
  await expect.poll(() => steps(accepting)).toEqual(['download', 'check'])
  expect(steps(silent)).toEqual([])
  const context = asked[1]!.context
  expect(context.gone.aborted).toBe(false)
  accepting.frames.close()
  await expect.poll(() => context.gone.aborted).toBe(true)
  expect(asked[0]!.context.gone.aborted).toBe(false)
  release()
  expect(await quiet).toMatchObject({ ok: true, result: { type: 'update-cancelled', cancelled: true } })
})
