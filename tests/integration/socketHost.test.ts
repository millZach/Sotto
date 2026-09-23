// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { SocketFrames } from '../../src/host/socketFrames'
import { startSocketServer } from '../../src/host/socketServer'
import { PairedClients, SESSION_LIFETIME_MS } from '../../src/main/agents/pairing'
import { desktopWindowClient, type HostService } from '../../src/main/agents/hostService'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'

let root: string
let host: Awaited<ReturnType<typeof startHeadlessHost>>
let clients: SocketHostService[]
let url: string
let native: E2EAgentHost
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sotto-socket-'))
  native = new E2EAgentHost()
  host = await startHeadlessHost({ dataDirectory: root, port: 0, providers: { codex: native, claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }, reasoner: e2eAgentReasoner })
  url = 'http://127.0.0.1:' + host.descriptor!.port; clients = []
})
afterEach(async () => { await Promise.all(clients.map(client => client.close())); await host?.close(); if (root && dirname(root) === tmpdir() && root.includes('sotto-socket-')) await rm(root, { recursive: true, force: true }) })
async function pair(name = 'Socket test') {
  const result = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, name)
  const client = new SocketHostService({ url, token: result.token, expectedHostId: result.hostId }); clients.push(client)
  await client.connect(); return { client, result }
}
describe('authenticated host socket', () => {
  it('exposes only loopback health before pairing and rejects unsigned operations', async () => {
    expect(await (await fetch(url + '/v1/health')).json()).toMatchObject({ v: 1, hostId: host.service.shell().hostId, port: host.descriptor!.port })
    expect((await fetch(url + '/v1/session', { method: 'POST' })).status).toBe(401)
    expect((await fetch(url + '/v1/admin/pairing-code', { method: 'POST' })).status).toBe(401)
    const client = new SocketHostService({ url, token: 'bad' }); clients.push(client)
    await expect(client.connect()).rejects.toMatchObject({ code: 'unauthenticated' })
    expect((await fetch(url + '/v1/health', { headers: { Origin: 'https://untrusted.example' } })).status).toBe(401)
  })
  it('pairs once, negotiates a shell and revokes a live session immediately', async () => {
    const { client, result } = await pair()
    expect(client.shell().hostId).toBe(result.hostId)
    expect((await client.connect()).capabilities.mayAnswer).toBe(false)
    await client.revokePairing()
    expect(host.pairing.verifyToken(result.token)).toBeUndefined()
    await expect(client.connect()).rejects.toMatchObject({ code: 'unauthenticated' })
  })
  it('deduplicates commands by authenticated client and refuses a changed payload', async () => {
    const { client } = await pair()
    const commandId = randomUUID()
    const command = { type: 'configure', patch: { enabled: false } } as const
    await client.command(command, undefined, commandId)
    expect(await client.receipt(commandId)).toEqual({ status: 'completed' })
    await client.command(command, undefined, commandId)
    await expect(client.command({ type: 'configure', patch: { enabled: true } }, undefined, commandId)).rejects.toMatchObject({ code: 'invalid_request' })
    expect(host.service.shell().configuration.enabled).toBe(false)
    const other = await pair('Other')
    expect(await other.client.receipt(commandId)).toEqual({ status: 'unknown' })
  })
  it('refuses grant-equivalent permission changes and host-local administration without authority', async () => {
    const { client } = await pair()
    await expect(client.command({ type: 'configure-thread', threadId: 'missing', runtimeMode: 'full-access' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(client.command({ type: 'create-thread', projectId: 'project', title: 'Bypass', modelId: 'fixture-model', runtimeMode: 'full-access' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(client.command({ type: 'configure', patch: { membershipEndpoint: 'https://untrusted.example' } })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(client.command({ type: 'credential', slot: 'reasoning', value: 'not-a-real-key' })).rejects.toMatchObject({ code: 'forbidden' })
    // Devin's Bypass permissions stops Sotto asking at all, and discarding uncommitted work answers a confirmation.
    await expect(client.command({ type: 'create-thread', projectId: 'project', title: 'Bypass', modelId: 'fixture-model', providerMode: 'bypass' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(client.command({ type: 'configure-thread', threadId: 'missing', providerMode: 'bypass' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(client.command({ type: 'reclaim-thread-worktree', threadId: 'missing', withUncommittedChanges: true })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(client.command({ type: 'restore-thread-branch', threadId: 'missing', withUncommittedChanges: true })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(client.command({ type: 'update-client', provider: 'codex' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(client.command({ type: 'open-thread-folder', threadId: 'missing' })).rejects.toMatchObject({ code: 'forbidden' })
    // Asking first grants nothing, so it reaches the host like any ordinary change.
    await expect(client.command({ type: 'configure-thread', threadId: 'missing', runtimeMode: 'approval-required' })).resolves.toBeDefined()
    // Without the discard, leaving a clean folder is ordinary work and reaches the host.
    await expect(client.command({ type: 'reclaim-thread-worktree', threadId: 'missing', withUncommittedChanges: false })).resolves.toBeDefined()
  })
  it('accepts an explicitly authorized answer and refuses the same device after policy revocation', async () => {
    const { client, result } = await pair()
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    const descriptor = JSON.parse(await readFile(join(root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    const policy = async (action: string) => {
      const response = await fetch(url + '/v1/admin/' + action, { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: result.clientId }) })
      expect(response.status).toBe(200)
    }
    await policy('allow-answers')
    expect((await client.connect()).capabilities.mayAnswer).toBe(true)
    native.event({ type: 'permission', threadId: 'workshop', requestId: 'permission-one', text: 'Build?' })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
    expect((await client.command({ type: 'answer', threadId, requestId: 'permission-one', answer: '', approved: true })).error).toBeNull()
    expect(host.service.events(0, threadId)).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ kind: 'answer-given', attribution: expect.objectContaining({ clientId: result.clientId, transport: 'socket' }) }) }))
    await policy('deny-answers')
    native.event({ type: 'permission', threadId: 'workshop', requestId: 'permission-two', text: 'Again?' })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.some(request => request.id === 'permission-two')).toBe(true)
    await expect(client.command({ type: 'answer', threadId, requestId: 'permission-two', answer: '', approved: true })).rejects.toMatchObject({ code: 'forbidden' })
    expect(host.service.shell().host.threads.find(thread => thread.id === threadId)?.requests).toContainEqual(expect.objectContaining({ id: 'permission-two' }))
  })
  it('refuses a second listener before it can open or overwrite the running host stores', async () => {
    await expect(startHeadlessHost({ dataDirectory: root, port: 0 })).rejects.toThrow(`Another host (process ${process.pid}) is still running`)
    expect((await fetch(url + '/v1/health')).status).toBe(200)
  })
  it('does not turn caller-supplied IPC identity into permission authority', async () => {
    const { client } = await pair()
    await expect(client.command({ type: 'answer', threadId: 'missing', requestId: 'missing', answer: '', approved: true }, { clientId: 'desktop-window', user: 'owner', transport: 'ipc' })).rejects.toMatchObject({ code: 'forbidden' })
  })
})


describe('socket client isolation and reconnect', () => {
  it('resyncs after a dropped connection without sending the old command again', async () => {
    const { client } = await pair()
    const id = randomUUID()
    await client.command({ type: 'configure', patch: { enabled: false } }, undefined, id)
    await client.close()
    await host.service.command({ type: 'configure', patch: { enabled: true } }, desktopWindowClient())
    await client.connect()
    expect(client.shell().configuration.enabled).toBe(true)
    expect(await client.receipt(id)).toEqual({ status: 'completed' })
  })
  it('keeps each client selection and observation independent after another client disconnects', async () => {
    const first = await pair('First'), second = await pair('Second')
    await first.client.command({ type: 'configure', patch: { enabledProviders: ['codex'], provider: 'codex' } })
    await first.client.command({ type: 'connect', provider: 'codex' })
    const threads = first.client.shell().host.threads
    expect(threads.length).toBeGreaterThanOrEqual(2)
    const firstId = threads[0]!.id, secondId = threads[1]!.id
    await first.client.command({ type: 'select-thread', threadId: firstId })
    await second.client.command({ type: 'select-thread', threadId: secondId })
    await first.client.observe([firstId]); await second.client.observe([secondId])
    const firstDetails: string[] = [], secondDetails: string[] = []
    first.client.subscribeThreadDetail(detail => firstDetails.push(detail.threadId))
    second.client.subscribeThreadDetail(detail => secondDetails.push(detail.threadId))
    // A thread's history reaches only the clients observing it, when it changes.
    await first.client.command({ type: 'manual-send', threadId: firstId, draftId: randomUUID(), text: 'Synthetic first prompt' })
    await expect.poll(() => firstDetails).toContain(firstId)
    await second.client.command({ type: 'manual-send', threadId: secondId, draftId: randomUUID(), text: 'Synthetic second prompt' })
    await expect.poll(() => secondDetails).toContain(secondId)
    expect(firstDetails).not.toContain(secondId); expect(secondDetails).not.toContain(firstId)
    expect((await first.client.readShell()).activeThreadId).toBe(firstId)
    expect((await second.client.readShell()).activeThreadId).toBe(secondId)
    await first.client.close()
    secondDetails.length = 0
    await second.client.command({ type: 'manual-send', threadId: secondId, draftId: randomUUID(), text: 'Synthetic prompt, still observed' })
    await expect.poll(() => secondDetails).toContain(secondId)
  })
  it('rechecks session expiry on every operation, even on an already opened socket', async () => {
    let now = Date.now()
    const pairing = new PairedClients(join(root, 'expiry'), { now: () => now }); await pairing.load()
    const paired = await pairing.redeem(pairing.issuePairingCode().code, 'Expiring')
    const server = await startSocketServer({ service: host.service, pairing })
    const session = pairing.signSession(paired.clientId)
    const key = randomBytes(16).toString('base64')
    let resolveMessage: (value: unknown) => void = () => undefined
    const reply = new Promise<unknown>(resolve => { resolveMessage = resolve })
    const frames = await new Promise<SocketFrames>((resolve, reject) => {
      const request = httpRequest('http://127.0.0.1:' + server.descriptor.port + '/v1/socket', { headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key, Authorization: 'Bearer ' + session } })
      request.on('error', reject)
      request.on('upgrade', (response, stream, head) => {
        expect(response.headers['sec-websocket-accept']).toBe(createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'))
        // A shell push can arrive before the reply while the session is still valid; only the reply is the assertion.
        const socket = new SocketFrames(stream, true, text => { const value = JSON.parse(text) as object; if (!('event' in value)) resolveMessage(value) })
        socket.onClose(() => resolveMessage({ closed: true })); socket.feed(head); resolve(socket)
      }); request.end()
    })
    try {
      now += SESSION_LIFETIME_MS + 1
      frames.send({ v: 1, id: 'expired', session, op: 'shell' })
      const refused = await reply
      if (refused && typeof refused === 'object' && 'closed' in refused) expect(refused).toEqual({ closed: true })
      else expect(refused).toMatchObject({ v: 1, id: 'expired', ok: false, error: { code: 'unauthenticated' } })
    } finally { frames.close(); await server.close() }
  })
})


it('drains a pushed catch-up page even when the host never publishes another shell', async () => {
  let rows: import('../../src/shared/threadEvents').StoredThreadEvent[] = []
  let publish = (): void => undefined
  const service: HostService = {
    shell: () => host.service.shell(), state: () => host.service.state(), threadDetail: id => host.service.threadDetail(id),
    command: (command, identity) => host.service.command(command, identity),
    events: (afterSeq, threadId, limit) => rows.filter(row => row.seq > afterSeq && (!threadId || row.threadId === threadId)).slice(0, limit),
    subscribe: listener => { publish = () => listener(host.service.shell()); return () => undefined },
  }
  const server = await startSocketServer({ service, pairing: host.pairing })
  const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Catch-up')
  const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); clients.push(client)
  try {
    await client.connect()
    rows = Array.from({ length: 300 }, (_, index) => ({ seq: index + 1, threadId: 'synthetic', event: { kind: 'messages-reset', at: new Date().toISOString() } }))
    publish()
    await expect.poll(() => client.events(0).length).toBe(300)
  } finally { await client.close(); await server.close() }
})

it('keeps a client’s place in the event stream when a shell and its events are too large for one push', async () => {
  let rows: import('../../src/shared/threadEvents').StoredThreadEvent[] = []
  let large = false, publish = (): void => undefined
  // About 11 MB of messages in the shell and 6.4 MB of events: each fits a frame, together they do not.
  const messages = Array.from({ length: 110 }, (_, index) => ({ id: 'm' + index, role: 'assistant' as const, text: 'x'.repeat(100_000), createdAt: new Date().toISOString() }))
  const service: HostService = {
    shell: () => { const state = host.service.shell(); return large ? { ...state, host: { ...state.host, threads: state.host.threads.map((thread, index) => index === 0 ? { ...thread, messages } : thread) } } : state },
    state: () => host.service.state(), threadDetail: id => host.service.threadDetail(id),
    command: (command, identity) => host.service.command(command, identity),
    events: (afterSeq, threadId, limit) => rows.filter(row => row.seq > afterSeq && (!threadId || row.threadId === threadId)).slice(0, limit),
    subscribe: listener => { publish = () => listener(host.service.shell()); return () => undefined },
  }
  await host.service.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } }, desktopWindowClient())
  await host.service.command({ type: 'connect', provider: 'codex' }, desktopWindowClient())
  expect(host.service.shell().host.threads.length).toBeGreaterThan(0)
  const server = await startSocketServer({ service, pairing: host.pairing })
  const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Large shell')
  const pushErrors: string[] = []
  const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token, onPushError: message => pushErrors.push(message) }); clients.push(client)
  try {
    await client.connect()
    rows = Array.from({ length: 256 }, (_, index) => ({ seq: index + 1, threadId: 'synthetic', event: { kind: 'message-text-appended', at: new Date().toISOString(), messageId: 'm', appendText: 'y'.repeat(25_000) } }))
    large = true
    publish()
    // The shell goes without its events and says there are more, and the client reads them itself.
    await expect.poll(() => client.events(0).length, { timeout: 10_000 }).toBe(256)
    expect(pushErrors).toEqual([])
  } finally { await client.close(); await server.close() }
})

it('frees a permission mode by what it allows, not by being listed first', async () => {
  // Devin lists only the modes its CLI reports. Without Accept edits there is no Ask first, and Smart,
  // which lets Devin edit unasked, comes first; it still needs the answer policy.
  const model = { id: 'devin-smart-first', provider: 'Devin', name: 'Devin', ready: true, providerModes: [
    { id: 'smart', name: 'Smart', allows: 'edits' as const }, { id: 'plan', name: 'Plan', allows: 'nothing' as const }] }
  const commands: string[] = []
  const service: HostService = {
    shell: () => { const state = host.service.shell(); return { ...state, host: { ...state.host, models: [...state.host.models, model] } } },
    state: () => host.service.state(), threadDetail: id => host.service.threadDetail(id),
    command: (command, identity) => { if (command.type === 'create-thread') commands.push(command.providerMode ?? ''); return host.service.command(command, identity) },
    events: (afterSeq, threadId, limit) => host.service.events(afterSeq, threadId, limit), subscribe: listener => host.service.subscribe(listener),
  }
  const server = await startSocketServer({ service, pairing: host.pairing })
  const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Modes')
  const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); clients.push(client)
  try {
    await client.connect()
    await expect(client.command({ type: 'create-thread', projectId: 'project', title: 'Smart', modelId: model.id, providerMode: 'smart' })).rejects.toMatchObject({ code: 'forbidden' })
    // Plan allows nothing, so it reaches the host; whether the host can make the thread is its own answer.
    await client.command({ type: 'create-thread', projectId: 'project', title: 'Plan', modelId: model.id, providerMode: 'plan' }).catch(() => undefined)
    expect(commands).toEqual(['plan'])
  } finally { await client.close(); await server.close() }
})

it('keeps no receipts for selections and drops settled ones, so a long-running host is never falsely busy', async () => {
  let now = 1_000_000
  const release: (() => void)[] = []
  const service: HostService = {
    shell: () => host.service.shell(), state: () => host.service.state(), threadDetail: id => host.service.threadDetail(id),
    // An interrupt here stays pending until the test lets it go, standing in for work that is still running.
    command: async (command, identity) => { if (command.type === 'interrupt') await new Promise<void>(resolve => release.push(resolve)); return host.service.command(command, identity) },
    events: (afterSeq, threadId, limit) => host.service.events(afterSeq, threadId, limit), subscribe: listener => host.service.subscribe(listener),
  }
  const server = await startSocketServer({ service, pairing: host.pairing, receipts: { lifetimeMs: 1000, limit: 2, now: () => now } })
  const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Receipts')
  const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); clients.push(client)
  try {
    await client.connect()
    // More selections than the cap holds, and none of them counts against it.
    for (let index = 0; index < 3; index++) { await client.command({ type: 'select-project', projectId: 'project' }); await client.command({ type: 'observe-threads', threadIds: [] }) }
    const first = randomUUID(), second = randomUUID(), third = randomUUID()
    await client.command({ type: 'configure', patch: { enabled: false } }, undefined, first)
    await client.command({ type: 'configure', patch: { enabled: true } }, undefined, second)
    // Full of settled receipts: the oldest makes room rather than refusing.
    await client.command({ type: 'configure', patch: { enabled: false } }, undefined, third)
    expect(await client.receipt(first)).toEqual({ status: 'unknown' })
    expect(await client.receipt(third)).toEqual({ status: 'completed' })
    now += 2000
    const pending = [client.command({ type: 'interrupt', threadId: 'missing' }), client.command({ type: 'interrupt', threadId: 'missing' })]
    await expect.poll(() => release.length).toBe(2)
    expect(await client.receipt(second)).toEqual({ status: 'unknown' })
    // Only work that is really still pending fills the host.
    await expect(client.command({ type: 'configure', patch: { enabled: true } })).rejects.toMatchObject({ code: 'busy' })
    for (const resolve of release) resolve()
    await Promise.allSettled(pending)
  } finally { await client.close(); await server.close() }
})

it('coalesces a burst of shell changes and answers a thread or an event page too large for a frame with an error naming it', async () => {
  let publish = (): void => undefined
  const huge = { threadId: 'huge', revision: 1, messages: [{ id: 'm', role: 'assistant' as const, text: 'x'.repeat(17 * 1024 * 1024), createdAt: new Date().toISOString() }] }
  let fits = false
  const service: HostService = {
    shell: () => host.service.shell(), state: () => host.service.state(),
    threadDetail: id => id === 'huge' ? (fits ? { ...huge, revision: 2, messages: [] } : huge) : host.service.threadDetail(id),
    command: (command, identity) => host.service.command(command, identity),
    events: (afterSeq, threadId, limit) => threadId === 'huge'
      ? [{ seq: afterSeq + 1, threadId, event: { kind: 'message-text-appended' as const, at: new Date().toISOString(), messageId: 'm', appendText: 'x'.repeat(17 * 1024 * 1024) } }]
      : host.service.events(afterSeq, threadId, limit),
    subscribe: listener => { publish = () => listener(host.service.shell()); return () => undefined },
  }
  const server = await startSocketServer({ service, pairing: host.pairing })
  const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Bursts')
  const pushErrors: (string | null)[] = []
  let connected = true
  const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token, onPushError: message => pushErrors.push(message),
    onPushErrorCleared: () => pushErrors.push(null), onConnectionChange: value => { connected = value } }); clients.push(client)
  try {
    await client.connect()
    let shells = 0
    client.subscribe(() => { shells++ })
    for (let index = 0; index < 50; index++) publish()
    await expect.poll(() => shells).toBeGreaterThan(0)
    await new Promise(resolve => setTimeout(resolve, 200))
    // One leading push and one trailing push carry the whole burst.
    expect(shells).toBeLessThanOrEqual(2)
    await client.observe(['huge'])
    await expect.poll(() => pushErrors).toEqual([expect.stringContaining('too large to send to this device')])
    await expect(client.readThreadDetail('huge')).rejects.toMatchObject({ code: 'too_large', message: expect.stringContaining('A thread on this host') })
    // An event page is part of the thread list's stream, not one thread's detail, and its error says so.
    await expect(client.readEvents(0, 'huge')).rejects.toMatchObject({ code: 'too_large', message: expect.stringContaining('The thread list') })
    expect(connected).toBe(true)
    // Shell pushes carry on meanwhile and do not clear a thread's error; that thread arriving does.
    publish(); await new Promise(resolve => setTimeout(resolve, 200))
    expect(pushErrors.at(-1)).not.toBeNull()
    fits = true
    await client.readThreadDetail('huge')
    expect(pushErrors.at(-1)).toBeNull()
  } finally { await client.close(); await server.close() }
})
