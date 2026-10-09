// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import { type HostService } from '../../src/main/agents/hostService'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { HOST_BUSY, HOST_EVENT_PAGE_SIZE } from '../../src/shared/hostProtocol'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()

const { pair } = fixture

describe('request budgets', () => {
  it('counts no health request, so a loop on it never blocks a session', async () => {
    const { client, result } = await pair()
    for (let index = 0; index < 150; index++) expect((await fetch(fixture.url + '/v1/health')).status).toBe(200)
    await expect(client.connect()).resolves.toMatchObject({ hostId: result.hostId })
  })
  it('keeps a session budget per paired client and says the host is busy past it, not that the device needs pairing', async () => {
    const first = await pair('First'), second = await pair('Second')
    const session = (token: string) => fetch(fixture.url + '/v1/session', { method: 'POST', headers: { Authorization: 'Bearer ' + token } })
    // A loop on a token the host does not know spends nobody's budget.
    for (let index = 0; index < 150; index++) expect((await session('not-a-paired-token')).status).toBe(401)
    let response = await session(first.result.token)
    for (let index = 0; response.status === 200 && index < 200; index++) response = await session(first.result.token)
    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({ error: { code: 'busy', message: HOST_BUSY } })
    await expect(first.client.connect()).rejects.toMatchObject({ code: 'busy', message: HOST_BUSY, pairingRequired: false })
    await expect(second.client.connect()).resolves.toMatchObject({ clientId: second.result.clientId })
  })
  it('keeps failed pairing budgets separate and checks them before redemption', async () => {
    const { client } = await pair()
    const redeem = (code: string, address: string) => fetch(fixture.url + '/v1/pair', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': address },
      body: JSON.stringify({ v: 1, code, name: 'Phone' }),
    })
    const checked = vi.spyOn(fixture.host.pairing, 'redeem')
    for (let index = 0; index < 10; index++) expect((await redeem('WRONG' + index, '100.64.0.1')).status).toBe(401)
    const code = fixture.host.pairing.issuePairingCode().code
    expect((await redeem(code, '100.64.0.1')).status).toBe(429)
    expect(checked).toHaveBeenCalledTimes(10)
    expect((await redeem(code, '100.64.0.2')).status).toBe(200)
    expect(checked).toHaveBeenCalledTimes(11)
    await expect(client.connect()).resolves.toBeDefined()
  })
  it('evicts the oldest pairing budget and expires entries after a minute', async () => {
    const redeem = (address: string) => fetch(fixture.url + '/v1/pair', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': address },
      body: JSON.stringify({ v: 1, code: 'WRONG', name: 'Phone' }),
    })
    for (let index = 0; index < 10; index++) expect((await redeem('100.64.0.1')).status).toBe(401)
    expect((await redeem('100.64.0.1')).status).toBe(429)
    for (let index = 2; index <= 1025; index++) {
      expect((await redeem('100.64.' + Math.floor(index / 256) + '.' + index % 256)).status).toBe(401)
    }
    expect((await redeem('100.64.0.1')).status).toBe(401)
    for (let index = 0; index < 9; index++) await redeem('100.64.0.1')
    expect((await redeem('100.64.0.1')).status).toBe(429)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 60_001)
    try { expect((await redeem('100.64.0.1')).status).toBe(401) } finally { clock.mockRestore() }
  })
  it('uses the local pairing budget for a forwarded address that is not one IP', async () => {
    const redeem = (address: string) => fetch(fixture.url + '/v1/pair', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': address },
      body: JSON.stringify({ v: 1, code: 'WRONG', name: 'Phone' }),
    })
    for (let index = 0; index < 10; index++) expect((await redeem('100.64.0.1, 100.64.0.2')).status).toBe(401)
    expect((await redeem('not-an-address')).status).toBe(429)
    await expect(SocketHostService.pair(fixture.url, fixture.host.pairing.issuePairingCode().code, 'Phone')).rejects.toMatchObject({ code: 'busy' })
  })
  it('does not spend the failed pairing budget on successful redemptions', async () => {
    for (let index = 0; index < 12; index++) await expect(SocketHostService.pair(fixture.url, fixture.host.pairing.issuePairingCode().code, 'Phone')).resolves.toBeDefined()
  })
  it('paces a client paging through a long log instead of closing it at the per-second cutoff', async () => {
    // The hello carries the first page and 101 event pages follow: one more than a peer may send of anything
    // else in a second. The clock is held still so every page lands in the same second however fast the
    // runner is; the cutoff would close this peer, and pacing instead holds the last page for a second.
    const pages = 101, last = HOST_EVENT_PAGE_SIZE * pages + 1
    const rows = Array.from({ length: last }, (_, index) => ({ seq: index + 1, threadId: 'synthetic', event: { kind: 'messages-reset' as const, at: new Date().toISOString() } }))
    let reads = 0
    const service: HostService = {
      shell: () => fixture.host.service.shell(), state: () => fixture.host.service.state(), threadDetail: id => fixture.host.service.threadDetail(id),
      command: (command, identity) => fixture.host.service.command(command, identity),
      events: (afterSeq, threadId, limit) => { reads++; return rows.filter(row => row.seq > afterSeq && (!threadId || row.threadId === threadId)).slice(0, limit) },
      subscribe: () => () => undefined,
    }
    const server = await startSocketServer({ service, pairing: fixture.host.pairing })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Long log')
    let drops = 0
    const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token, onConnectionChange: value => { if (!value) drops++ } }); fixture.clients.push(client)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const started = performance.now()
      await client.connect()
      // The hello and every page were read in the same held second, and the page past the budget waited for the next.
      expect(reads).toBe(1 + pages)
      expect(performance.now() - started).toBeGreaterThanOrEqual(900)
      expect(client.events(last - 1).map(row => row.seq)).toEqual([last])
      expect(drops).toBe(0)
      await expect(client.readShell()).resolves.toBeDefined()
    } finally { vi.useRealTimers(); await client.close(); await server.close() }
  })

  it.each([undefined, 0])('advances hello and event pages before later shell pushes (start: %s)', async afterSeq => {
    const rows = Array.from({ length: 2 }, (_, index) => ({ seq: index + 1, threadId: 'synthetic',
      event: { kind: 'messages-reset' as const, at: new Date().toISOString() } }))
    let publish = () => {}
    const service: HostService = {
      shell: () => fixture.host.service.shell(), state: () => fixture.host.service.state(), threadDetail: id => fixture.host.service.threadDetail(id),
      command: (command, identity) => fixture.host.service.command(command, identity),
      events: (cursor, threadId, limit) => rows.filter(row => row.seq > cursor && (!threadId || row.threadId === threadId)).slice(0, limit),
      subscribe: listener => { publish = () => listener(service.shell()); return () => {} },
    }
    const server = await startSocketServer({ service, pairing: fixture.host.pairing })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Cursor test')
    const peer = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    try {
      const hello = await peer.call('hello', { op: 'hello', ...(afterSeq === undefined ? {} : { afterSeq }) })
      expect(hello).toMatchObject({ ok: true, result: { events: afterSeq === undefined ? [] : rows } })
      publish()
      await expect.poll(() => peer.messages.find(item => item.event === 'shell')).toMatchObject({ eventPage: { events: [] } })
      peer.messages.length = 0
      rows.push({ seq: 3, threadId: 'synthetic', event: { kind: 'messages-reset', at: new Date().toISOString() } })
      expect(await peer.call('events', { op: 'events', afterSeq: 2 })).toMatchObject({ ok: true, result: { events: [rows[2]], latestSeq: 3 } })
      publish()
      await expect.poll(() => peer.messages.find(item => item.event === 'shell')).toMatchObject({ eventPage: { events: [], latestSeq: 3 } })
      peer.messages.length = 0
      rows.push({ seq: 4, threadId: 'synthetic', event: { kind: 'messages-reset', at: new Date().toISOString() } })
      publish()
      await expect.poll(() => peer.messages.find(item => item.event === 'shell')).toMatchObject({ eventPage: { events: [rows[3]], latestSeq: 4 } })
    } finally { peer.frames.close(); await server.close() }
  })

  it('preserves the shell cursor while reading older and thread-filtered history', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({ seq: index + 1, threadId: index === 4 ? 'other' : 'synthetic',
      event: { kind: 'messages-reset' as const, at: new Date().toISOString() } }))
    let publish = () => {}
    const service: HostService = {
      shell: () => fixture.host.service.shell(), state: () => fixture.host.service.state(), threadDetail: id => fixture.host.service.threadDetail(id),
      command: (command, identity) => fixture.host.service.command(command, identity),
      events: (cursor, threadId, limit) => rows.filter(row => row.seq > cursor && (!threadId || row.threadId === threadId)).slice(0, Math.min(limit ?? 1, 1)),
      subscribe: listener => { publish = () => listener(service.shell()); return () => {} },
    }
    const server = await startSocketServer({ service, pairing: fixture.host.pairing })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'History test')
    const peer = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    try {
      await peer.call('hello', { op: 'hello', afterSeq: 2 })
      expect(await peer.call('older', { op: 'events', afterSeq: 0 })).toMatchObject({ result: { latestSeq: 1 } })
      publish()
      await expect.poll(() => peer.messages.find(item => item.event === 'shell')).toMatchObject({ eventPage: { events: [rows[3]], latestSeq: 4 } })
      peer.messages.length = 0
      expect(await peer.call('thread', { op: 'events', afterSeq: 4, threadId: 'other' })).toMatchObject({ result: { latestSeq: 5 } })
      publish()
      await expect.poll(() => peer.messages.find(item => item.event === 'shell')).toMatchObject({ eventPage: { events: [rows[4]], latestSeq: 5 } })
    } finally { peer.frames.close(); await server.close() }
  })

  it('waits for hello before reading events for a shell push', async () => {
    let publish = () => {}
    const reads = vi.fn(() => [])
    const service: HostService = {
      shell: () => fixture.host.service.shell(), state: () => fixture.host.service.state(), threadDetail: id => fixture.host.service.threadDetail(id),
      command: (command, identity) => fixture.host.service.command(command, identity), events: reads,
      subscribe: listener => { publish = () => listener(service.shell()); return () => {} },
    }
    const server = await startSocketServer({ service, pairing: fixture.host.pairing })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Opening connection')
    const peer = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      publish()
      await vi.advanceTimersByTimeAsync(50)
      expect(reads).not.toHaveBeenCalled()
      vi.useRealTimers()
      await peer.call('hello', { op: 'hello', afterSeq: 0 })
      expect(reads).toHaveBeenCalledWith(0, undefined, HOST_EVENT_PAGE_SIZE + 1)
      publish()
      await expect.poll(() => peer.messages.find(item => item.event === 'shell')).toMatchObject({ eventPage: { latestSeq: 0, events: [] } })
    } finally { vi.useRealTimers(); peer.frames.close(); await server.close() }
  })
})
