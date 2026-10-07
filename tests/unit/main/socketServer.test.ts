// @vitest-environment node
import { createHash } from 'node:crypto'
import { Duplex } from 'node:stream'
import { request as httpRequest, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PairedClients } from '../../../src/main/agents/pairing'
import type { HostService } from '../../../src/main/agents/hostService'

const captured = vi.hoisted(() => ({ server: undefined as Server | undefined }))
vi.mock('node:http', async importOriginal => {
  const original = await importOriginal<typeof import('node:http')>()
  return { ...original, createServer: (...args: Parameters<typeof original.createServer>) => {
    captured.server = original.createServer(...args)
    return captured.server
  } }
})
import { SocketFrames } from '../../../src/host/socketFrames'
import { phonesOff, startSocketServer } from '../../../src/host/socketServer'
import { CommandReceipts } from '../../../src/host/commandReceipts'
import type { AgentCommand } from '../../../src/shared/agents'
import { rawPeer } from '../../fixtures/rawHostPeer'

let directory: string | undefined
let listener: Awaited<ReturnType<typeof startSocketServer>> | undefined
const others: Awaited<ReturnType<typeof startSocketServer>>[] = []
const raws: SocketFrames[] = []
afterEach(async () => {
  for (const frames of raws.splice(0)) frames.close()
  for (const other of others.splice(0)) await other.close()
  await listener?.close(); if (directory) await rm(directory, { recursive: true, force: true })
})
it('closes refused streams cleanly and handles listener errors after startup', async () => {
  directory = await mkdtemp(join(tmpdir(), 'sotto-listener-'))
  const pairing = new PairedClients(directory); await pairing.load()
  const service = { shell: () => ({ hostId: 'host' }), subscribe: () => () => {} } as unknown as HostService
  listener = await startSocketServer({ service, pairing })
  const stream = new Duplex({ read() {}, write(_chunk, _encoding, done) { done() } })
  captured.server!.emit('upgrade', { headers: {}, url: '/v1/socket' }, stream, Buffer.alloc(0))
  expect(() => stream.emit('error', new Error('Connection closed'))).not.toThrow()
  expect(stream.destroyed).toBe(true)
  expect(() => captured.server!.emit('error', new Error('Listener error'))).not.toThrow()
})

it('answers a full listener with a temporary capacity refusal and releases idle peers', async () => {
  directory = await mkdtemp(join(tmpdir(), 'sotto-listener-'))
  const pairing = new PairedClients(directory); await pairing.load()
  const paired = await pairing.redeem(pairing.issuePairingCode().code, 'Phone')
  const session = pairing.signSession(paired.clientId)
  const service = { shell: () => ({ hostId: 'host' }), subscribe: () => () => {}, command: async () => ({}) } as unknown as HostService
  listener = await startSocketServer({ service, pairing })
  const headers = { authorization: 'Bearer ' + session, 'sec-websocket-version': '13', 'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAA==' }
  vi.useFakeTimers()
  try {
    const streams = Array.from({ length: 33 }, () => {
      const writes: string[] = []
      const stream = new Duplex({ read() {}, write(chunk, _encoding, done) { writes.push(String(chunk)); done() } })
      captured.server!.emit('upgrade', { headers, url: '/v1/socket' }, stream, Buffer.alloc(0))
      return { stream, writes }
    })
    expect(listener.peers()).toBe(32)
    expect(streams[32]!.writes[0]).toContain('503 Service Unavailable')
    vi.advanceTimersByTime(75_000)
    expect(listener.peers()).toBe(0)
    for (const { stream } of streams) stream.destroy()
  } finally { vi.useRealTimers() }
})

it.each([false, true])('negotiates client liveness from hello (opted in: %s)', async optedIn => {
  directory = await mkdtemp(join(tmpdir(), 'sotto-listener-'))
  const pairing = new PairedClients(directory); await pairing.load()
  const paired = await pairing.redeem(pairing.issuePairingCode().code, 'Phone')
  const session = pairing.signSession(paired.clientId)
  const service = { shell: () => ({ hostId: 'host' }), subscribe: () => () => {}, events: () => [] } as unknown as HostService
  listener = await startSocketServer({ service, pairing })
  const writes: Buffer[] = []
  const stream = new Duplex({ read() {}, write(chunk, _encoding, done) { writes.push(Buffer.from(chunk)); done() } })
  const headers = { authorization: 'Bearer ' + session, 'sec-websocket-version': '13', 'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAA==' }
  vi.useFakeTimers()
  const clientWrites: Buffer[] = []
  const clientStream = new Duplex({ read() {}, write(chunk, _encoding, done) { clientWrites.push(Buffer.from(chunk)); done() } })
  const client = new SocketFrames(clientStream, true, () => {})
  try {
    captured.server!.emit('upgrade', { headers, url: '/v1/socket' }, stream, Buffer.alloc(0))
    client.send({ v: 1, id: 'hello', session, op: 'hello', ...(optedIn ? { accepts: ['client-liveness'] } : {}) })
    stream.emit('data', clientWrites.shift()!)
    await Promise.resolve()
    for (let round = 0; round < 4; round++) {
      vi.advanceTimersByTime(25_000)
      if (!optedIn) {
        const ping = writes.at(-1)!
        expect(ping[0]).toBe(137)
        client.feed(ping)
        stream.emit('data', clientWrites.shift()!)
      }
    }
    expect(stream.destroyed).toBe(optedIn)
  } finally { client.close(); stream.destroy(); vi.useRealTimers() }
})

/** A host service with no threads that records every command it runs and who it ran it for. */
function recordingService() {
  const commands: { command: AgentCommand; clientId: string }[] = []
  const shell = () => ({ hostId: 'host', host: { threads: [], models: [] }, queue: [] })
  const service = { shell, subscribe: () => () => {}, events: () => [],
    command: async (command: AgentCommand, client: { clientId: string }) => { commands.push({ command, clientId: client.clientId }); return shell() } } as unknown as HostService
  return { service, commands }
}
async function pairedClient(name: string) {
  directory ??= await mkdtemp(join(tmpdir(), 'sotto-listener-'))
  const pairing = new PairedClients(directory); await pairing.load()
  const paired = await pairing.redeem(pairing.issuePairingCode().code, name)
  return { pairing, paired }
}
/** What the listener answers a socket upgrade with, when it refuses one. */
function upgradeStatus(port: number, session: string): Promise<number | 'upgraded'> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`http://127.0.0.1:${port}/v1/socket`, { headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'AAAAAAAAAAAAAAAAAAAAAA==', Authorization: 'Bearer ' + session } })
    request.on('error', reject)
    request.on('response', response => { response.resume(); resolve(response.statusCode ?? 0) })
    request.on('upgrade', (_response, stream) => { stream.destroy(); resolve('upgraded') })
    request.end()
  })
}
async function connected(port: number, session: string) {
  const peer = await rawPeer(port, session)
  raws.push(peer.frames)
  return peer
}

it('answers a command retried on a host’s other listener from the receipt the first one kept, instead of running it twice', async () => {
  const { pairing, paired } = await pairedClient('Sotto desktop')
  const { service, commands } = recordingService()
  const receipts = new CommandReceipts()
  listener = await startSocketServer({ service, pairing, receipts })
  const tailnet = await startSocketServer({ service, pairing, receipts, observationKey: 'tailnet-observations' }); others.push(tailnet)
  const session = pairing.signSession(paired.clientId)
  const overSsh = await connected(listener.descriptor.port, session)
  expect(await overSsh.call('hello-1', { op: 'hello' })).toMatchObject({ ok: true })
  expect(await overSsh.call('command-1', { op: 'command', command: { type: 'interrupt', threadId: 'thread' } })).toMatchObject({ ok: true })

  // The desktop moved to its tailnet connection before it read the acknowledgement, and sends the command again.
  const overTailnet = await connected(tailnet.descriptor.port, session)
  await overTailnet.call('hello-2', { op: 'hello' })
  expect(await overTailnet.call('receipt-1', { op: 'receipt', commandId: 'command-1' })).toMatchObject({ ok: true, result: { status: 'completed' } })
  expect(await overTailnet.call('command-1', { op: 'command', command: { type: 'interrupt', threadId: 'thread' } })).toMatchObject({ ok: true })
  expect(commands.filter(item => item.command.type === 'interrupt')).toHaveLength(1)
})

it('keeps each listener’s observed threads under its own key, so one listener never replaces what the other observes', async () => {
  const { pairing, paired } = await pairedClient('Sotto desktop')
  const { service, commands } = recordingService()
  listener = await startSocketServer({ service, pairing })
  const tailnet = await startSocketServer({ service, pairing, observationKey: 'tailnet-observations' }); others.push(tailnet)
  const session = pairing.signSession(paired.clientId)
  const overSsh = await connected(listener.descriptor.port, session)
  const overTailnet = await connected(tailnet.descriptor.port, session)
  await overSsh.call('observe-a', { op: 'observe', threadIds: ['a'] })
  await overTailnet.call('observe-b', { op: 'observe', threadIds: ['b'] })
  const observed = commands.filter(item => item.command.type === 'observe-threads')
  expect(observed.map(item => [item.clientId, (item.command as Extract<AgentCommand, { type: 'observe-threads' }>).threadIds])).toEqual([['socket-observations', ['a']], ['tailnet-observations', ['b']]])
})

it('clears the threads its peers observed when it stops, so the host keeps nothing shown with nobody watching', async () => {
  const { pairing, paired } = await pairedClient('Zach’s iPhone')
  const { service, commands } = recordingService()
  const tailnet = await startSocketServer({ service, pairing, observationKey: 'tailnet-observations' })
  listener = tailnet
  const phone = await connected(tailnet.descriptor.port, pairing.signSession(paired.clientId))
  await phone.call('observe', { op: 'observe', threadIds: ['a'] })
  await tailnet.close()
  listener = undefined
  const observed = commands.filter(item => item.command.type === 'observe-threads' && item.clientId === 'tailnet-observations')
  expect(observed.map(item => (item.command as Extract<AgentCommand, { type: 'observe-threads' }>).threadIds)).toEqual([['a'], []])
})

it('offers a phone on a listener that tells desktops apart everything but the desktop-only features, and refuses it a sign-in', async () => {
  const { pairing, paired } = await pairedClient('Zach’s iPhone')
  const desktop = await pairing.redeem(pairing.issuePairingCode().code, 'Sotto desktop')
  const { service } = recordingService()
  const desktops = new Set([desktop.clientId])
  listener = await startSocketServer({ service, pairing, clientUpdates: true, tailnet: { desktops: { refresh: async () => undefined, has: id => desktops.has(id) }, phonesAdmitted: () => true },
    signIns: { start: async () => { throw new Error('A phone never reaches this.') }, read: () => null, code: async () => null, cancel: () => undefined } as never,
    about: () => ({ tailnetAddress: 'https://forge.tail5728ca.ts.net:8443', startedBy: 'launch-script' }), phoneAccess: () => ({ status: 'on', phones: 1 }) })
  const health = await (await fetch(`http://127.0.0.1:${listener.descriptor.port}/v1/health`)).json() as { features: string[] }
  expect(health.features).toEqual(expect.arrayContaining(['provider-sign-in', 'client-updates']))
  expect(health).toMatchObject({ tailnetAddress: 'https://forge.tail5728ca.ts.net:8443', startedBy: 'launch-script' })

  const phone = await connected(listener.descriptor.port, pairing.signSession(paired.clientId))
  const hello = (await phone.call('hello', { op: 'hello', accepts: ['client-updates'] })).result as { features: string[]; phoneAccess?: unknown; tailnetAddress?: string }
  expect(hello.features).not.toContain('provider-sign-in')
  expect(hello.features).not.toContain('client-updates')
  expect(hello.phoneAccess).toBeUndefined()
  expect(hello.tailnetAddress).toBe('https://forge.tail5728ca.ts.net:8443')
  expect(await phone.call('sign-in', { op: 'sign-in-start', provider: 'codex' })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  expect(await phone.call('updates', { op: 'command', command: { type: 'queue-client-updates', providers: ['codex'] } })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(await phone.call('cancel-updates', { op: 'command', command: { type: 'cancel-client-updates', providers: ['codex'] } })).toMatchObject({ ok: false, error: { code: 'forbidden' } })

  const computer = await connected(listener.descriptor.port, pairing.signSession(desktop.clientId))
  const desktopHello = (await computer.call('hello', { op: 'hello' })).result as { features: string[]; phoneAccess?: unknown }
  expect(desktopHello.features).toEqual(expect.arrayContaining(['provider-sign-in', 'client-updates']))
  expect(desktopHello.phoneAccess).toEqual({ status: 'on', phones: 1 })
})

it('opens nothing for a phone while phones are not admitted, closes one already connected, and keeps the desktop', async () => {
  const { pairing, paired } = await pairedClient('Zach’s iPhone')
  const desktop = await pairing.redeem(pairing.issuePairingCode().code, 'Sotto desktop')
  const { service } = recordingService()
  let phonesOn = true
  // Phone access turning off while a phone's hello reads the record: the hello is refused as the session would be.
  let offAtNextRead = false
  listener = await startSocketServer({ service, pairing, name: () => 'forge', tailnet: {
    desktops: { refresh: async () => { if (offAtNextRead) { phonesOn = false; offAtNextRead = false } }, has: id => id === desktop.clientId },
    phonesAdmitted: () => phonesOn } })
  const url = `http://127.0.0.1:${listener.descriptor.port}`
  const phone = await connected(listener.descriptor.port, pairing.signSession(paired.clientId))
  const computer = await connected(listener.descriptor.port, pairing.signSession(desktop.clientId))
  expect(listener.peers()).toBe(2)

  offAtNextRead = true
  expect(await phone.call('hello', { op: 'hello' })).toMatchObject({ ok: false, error: { code: 'forbidden', message: phonesOff('forge') } })
  listener.dropRevoked()
  await vi.waitFor(() => expect(phone.frames.isClosed).toBe(true))
  expect(computer.frames.isClosed).toBe(false)
  expect(listener.peers()).toBe(1)

  const session = await fetch(`${url}/v1/session`, { method: 'POST', headers: { Authorization: `Bearer ${(await pairing.redeem(pairing.issuePairingCode().code, 'Another phone')).token}` } })
  expect(session.status).toBe(403)
  expect(await session.json()).toEqual({ v: 1, error: { code: 'forbidden', message: phonesOff('forge') } })
  const pair = await fetch(`${url}/v1/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, code: pairing.issuePairingCode().code, name: 'Phone' }) })
  expect(pair.status).toBe(403)
  expect(await upgradeStatus(listener.descriptor.port, pairing.signSession(paired.clientId))).toBe(403)
  expect((await fetch(`${url}/v1/session`, { method: 'POST', headers: { Authorization: `Bearer ${desktop.token}` } })).status).toBe(200)
})

it('pushes late exact acceptance once only to an authenticated client that watched and opted in', async () => {
  const { pairing, paired } = await pairedClient('New desktop')
  const another = await pairing.redeem(pairing.issuePairingCode().code, 'Other desktop')
  const { service } = recordingService()
  let publish: () => void = () => undefined
  const completed: { requestId: string; questionsDigest: string; decisionId: string }[] = []
  Object.assign(service, {
    subscribe: (listener: (state: ReturnType<typeof service.shell>) => void) => { publish = () => listener(service.shell()); return () => undefined },
    requestAnswerRecovery: () => ({ uncertainRequestIds: [], completed }),
  })
  listener = await startSocketServer({ service, pairing })
  const desktop = await connected(listener.descriptor.port, pairing.signSession(paired.clientId))
  const older = await connected(listener.descriptor.port, pairing.signSession(paired.clientId))
  const other = await connected(listener.descriptor.port, pairing.signSession(another.clientId))
  await desktop.call('hello-new', { op: 'hello', accepts: ['answer-receipts'] })
  await older.call('hello-old', { op: 'hello' })
  await other.call('hello-other', { op: 'hello', accepts: ['answer-receipts'] })
  const target = { threadId: 'thread', providerId: 'claude', requestId: 'question', questionsDigest: 'a'.repeat(64) }
  for (const peer of [desktop, older, other]) expect(await peer.call('read-receipt', { op: 'receipt', commandId: 'decision', answer: target })).toMatchObject({ result: { status: 'unknown' } })
  publish()
  // Read a shell as a transport barrier; unrelated publications send no acceptance.
  await desktop.call('barrier-before', { op: 'shell' })
  expect(desktop.messages.filter(message => message.event === 'answer-receipt')).toEqual([])
  completed.push({ requestId: target.requestId, questionsDigest: target.questionsDigest,
    decisionId: 'socket-answer:' + createHash('sha256').update(JSON.stringify([paired.clientId, 'decision'])).digest('hex') })
  publish(); publish()
  await desktop.call('barrier-after', { op: 'shell' })
  expect(desktop.messages.filter(message => message.event === 'answer-receipt')).toEqual([{ v: 1, event: 'answer-receipt', acceptedAnswer: { ...target, decisionId: 'decision' } }])
  expect(older.messages.filter(message => message.event === 'answer-receipt')).toEqual([])
  expect(other.messages.filter(message => message.event === 'answer-receipt')).toEqual([])
})

it('runs an explicit answer Check only with current authority and returns the freshly read shell', async () => {
  const { pairing, paired } = await pairedClient('Desktop')
  const { service } = recordingService()
  let allowed = false
  const check = vi.fn(async () => undefined)
  Object.assign(service, { checkRequestAnswer: check })
  listener = await startSocketServer({ service, pairing, mayAnswer: () => allowed })
  const desktop = await connected(listener.descriptor.port, pairing.signSession(paired.clientId))
  const hello = await desktop.call('hello', { op: 'hello' })
  expect(hello).toMatchObject({ result: { features: expect.arrayContaining(['answer-check']) } })
  const answer = { threadId: 'thread', providerId: 'grok', requestId: 'question', questionsDigest: 'a'.repeat(64) }
  expect(await desktop.call('denied', { op: 'check-answer', answer })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(check).not.toHaveBeenCalled()
  allowed = true
  expect(await desktop.call('checked', { op: 'check-answer', answer })).toMatchObject({ ok: true, result: { hostId: 'host' } })
  expect(check).toHaveBeenCalledWith(answer, expect.objectContaining({ clientId: paired.clientId, transport: 'socket' }))
  allowed = false
  expect(await desktop.call('revoked', { op: 'check-answer', answer })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(check).toHaveBeenCalledTimes(1)
})

it.each([false, true])('offers atomic Send only when the service implements it and keeps legacy Send (supported: %s)', async supported => {
  const { pairing, paired } = await pairedClient('Desktop')
  const { service, commands } = recordingService()
  Object.assign(service, { supportsAtomicSend: supported, shell: () => ({ hostId: 'host', host: { threads: [
    { id: 'thread', projectId: 'project', requests: [] }], models: [] }, queue: [], draft: '', composing: false }) })
  listener = await startSocketServer({ service, pairing })
  expect(listener.descriptor.features.includes('atomic-send')).toBe(supported)
  const desktop = await connected(listener.descriptor.port, pairing.signSession(paired.clientId))
  const hello = await desktop.call('hello', { op: 'hello' })
  expect((hello.result as { features: string[] }).features.includes('atomic-send')).toBe(supported)
  await desktop.call('select', { op: 'command', command: { type: 'select-thread', threadId: 'thread' } })
  const command = { type: 'send', draft: { threadId: 'thread', text: 'Prompt', attachments: [] } }
  expect(await desktop.call('atomic', { op: 'command', command })).toMatchObject(supported ? { ok: true } : { ok: false, error: { code: 'invalid_request' } })
  expect(commands.filter(item => item.command.type === 'send')).toEqual(supported ? [{ command, clientId: paired.clientId }] : [])
  expect(await desktop.call('legacy', { op: 'command', command: { type: 'send' } })).toMatchObject({ ok: true })
  const save = { type: 'compose', threadId: 'thread', text: 'A targeted edit', attachments: [] }
  expect(await desktop.call('targeted-save', { op: 'command', command: save })).toMatchObject(supported ? { ok: true } : { ok: false, error: { code: 'invalid_request' } })
  expect(commands.filter(item => item.command.type === 'compose')).toEqual(supported ? [{ command: save, clientId: paired.clientId }] : [])
  expect(await desktop.call('legacy-save', { op: 'command', command: { type: 'compose', text: 'Legacy draft' } })).toMatchObject({ ok: true })
})

it.each(['live', 'uncertain', 'retry-ready'].flatMap(delivery => ['send', 'compose'].map(type => ({ delivery, type }))))('takes targeted $type authority from the selected native $delivery question before any saved draft exists and refuses selection drift', async ({ delivery, type }) => {
  const { pairing, paired } = await pairedClient('Desktop')
  const { service, commands } = recordingService()
  let allowed = false
  Object.assign(service, { supportsAtomicSend: true, shell: () => ({ hostId: 'host', host: { threads: [
    { id: 'thread', projectId: 'project', requests: [{ id: 'native-question', kind: 'question', text: 'Choose', options: [],
      ...(delivery === 'uncertain' ? { delivery: 'uncertain' } : delivery === 'retry-ready' ? { answerRetryReady: true } : {}) }] },
    { id: 'other', projectId: 'project', requests: [] }], models: [] }, queue: [], draft: '', composing: false, threadDrafts: [] }) })
  listener = await startSocketServer({ service, pairing, mayAnswer: () => allowed })
  const desktop = await connected(listener.descriptor.port, pairing.signSession(paired.clientId))
  await desktop.call('hello', { op: 'hello' })
  const draft = { threadId: 'thread', text: 'Blue', attachments: [] }
  const command = type === 'send' ? { type, draft } : { type, ...draft }
  expect(await desktop.call('unselected', { op: 'command', command })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  await desktop.call('select', { op: 'command', command: { type: 'select-thread', threadId: 'thread' } })
  expect(await desktop.call('denied', { op: 'command', command })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(commands).toEqual([])
  allowed = true
  expect(await desktop.call('allowed', { op: 'command', command })).toMatchObject({ ok: true })
  expect(commands).toEqual([{ command, clientId: paired.clientId }])
  allowed = false
  expect(await desktop.call('revoked', { op: 'command', command })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  await desktop.call('switch', { op: 'command', command: { type: 'select-thread', threadId: 'other' } })
  allowed = true
  expect(await desktop.call('drifted', { op: 'command', command })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(commands).toHaveLength(1)
})

it('returns a targeted Compose refusal as its own outcome when the shared shell has another error', async () => {
  const { pairing, paired } = await pairedClient('Desktop')
  const { service } = recordingService()
  const state = { hostId: 'host', host: { threads: [{ id: 'thread', projectId: 'project', requests: [] }], models: [] },
    queue: [], draft: '', composing: false, error: 'A different command changed the shared error.' }
  Object.assign(service, { supportsAtomicSend: true, shell: () => state,
    command: async () => ({ ...state, error: 'The draft could not be saved. Your earlier draft is kept.' }) })
  listener = await startSocketServer({ service, pairing })
  const desktop = await connected(listener.descriptor.port, pairing.signSession(paired.clientId))
  await desktop.call('hello', { op: 'hello' })
  await desktop.call('select', { op: 'command', command: { type: 'select-thread', threadId: 'thread' } })
  expect(await desktop.call('save', { op: 'command', command: { type: 'compose', threadId: 'thread', text: 'Edit' } }))
    .toMatchObject({ ok: true, result: { error: 'The draft could not be saved. Your earlier draft is kept.' } })
  expect(service.shell().error).toBe('A different command changed the shared error.')
})

it.each(['saved-plain', 'saved-question', 'active-plain', 'active-question'] as const)('keeps targeted Compose answer authority bound to the exact %s draft', async binding => {
  const { pairing, paired } = await pairedClient('Desktop')
  const { service, commands } = recordingService()
  const saved = binding.startsWith('saved')
  const plain = binding.endsWith('plain')
  const state = { hostId: 'host', host: { threads: [{ id: 'thread', projectId: 'project', requests: [
    { id: 'native-question', kind: 'question', text: 'Question', options: [] }] }], models: [] }, queue: [], draft: 'Active draft',
    composing: true, draftThreadId: 'thread', draftRequestId: saved ? plain ? 'native-question' : null : plain ? null : 'native-question',
    threadDrafts: saved ? [{ threadId: 'thread', requestId: plain ? null : 'native-question', text: 'Retained draft', attachments: [] }] : [] }
  Object.assign(service, { supportsAtomicSend: true, shell: () => state })
  listener = await startSocketServer({ service, pairing, mayAnswer: () => false })
  const desktop = await connected(listener.descriptor.port, pairing.signSession(paired.clientId))
  await desktop.call('hello', { op: 'hello' })
  await desktop.call('select', { op: 'command', command: { type: 'select-thread', threadId: 'thread' } })
  const command = { type: 'compose', threadId: 'thread', text: 'A new edit' }
  expect(await desktop.call('targeted', { op: 'command', command })).toMatchObject(plain ? { ok: true } : { ok: false, error: { code: 'forbidden' } })
  expect(commands).toEqual(plain ? [{ command, clientId: paired.clientId }] : [])
  // Only the exact targeted save keeps its binding; legacy Compose and Send retain their native-question gate.
  expect(await desktop.call('legacy', { op: 'command', command: { type: 'compose', text: 'Legacy edit' } })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(await desktop.call('send', { op: 'command', command: { type: 'send', draft: { threadId: 'thread', text: 'Prompt' } } })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
})
