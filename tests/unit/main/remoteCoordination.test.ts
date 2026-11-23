// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import type { CoordinationExchangeView, CoordinationRead } from '../../../src/shared/threadCoordination'
import { KEPT_COORDINATION_READS, RemoteCoordinationReads, type RemoteCoordinationHost } from '../../../src/main/hosts/remoteCoordination'

const HOST = '11111111-1111-4111-8111-111111111111'
const DESKTOP = '22222222-2222-4222-8222-222222222222'
const OTHER = '33333333-3333-4333-8333-333333333333'
const key = (id: string, hostId = HOST): string => hostEntityKey(hostId, id)

function view(patch: Partial<CoordinationExchangeView> = {}): CoordinationExchangeView {
  return {
    id: randomUUID(),
    direction: 'sent',
    peerThreadId: 'peer-1',
    peerTitle: 'API refactor',
    peerProvider: 'codex',
    messageId: randomUUID(),
    delivery: 'started',
    deliveryState: 'accepted',
    outcome: 'answered',
    hopCount: 1,
    hopMax: 6,
    expectReply: true,
    hasReply: true,
    createdAt: '2026-11-23T10:00:00.000Z',
    updatedAt: '2026-11-23T10:01:00.000Z',
    ...patch,
  }
}

function fixture(options: { supports?: boolean } = {}) {
  const answers = new Map<string, CoordinationRead>()
  const replies = new Map<string, { text: string; truncated: boolean }>()
  const service = {
    supportsCoordinationViews: options.supports ?? true,
    coordinationViews: vi.fn(async (threadId: string): Promise<CoordinationRead> => {
      const answer = answers.get(threadId)
      if (!answer) throw new Error('unreadable')
      return answer
    }),
    coordinationReply: vi.fn(async (threadId: string, exchangeId: string) => {
      const found = replies.get(`${threadId}:${exchangeId}`)
      return found ? { exchangeId, ...found } : null
    }),
  }
  let connection: RemoteCoordinationHost | undefined = { hostId: HOST, service }
  let connected = true
  const reads = new RemoteCoordinationReads({
    connection: hostId => hostId === HOST ? connection : undefined,
    connected: () => connected,
  })
  const told: string[][] = []
  reads.subscribe(threadIds => told.push([...threadIds]))
  return {
    reads,
    service,
    answers,
    replies,
    told,
    set connected(value: boolean) { connected = value },
    set connection(value: RemoteCoordinationHost | undefined) { connection = value },
  }
}

describe('remote host parent-thread coordination views (ADR-0216, Slice 3)', () => {
  it('qualifies same-host peers by hostId and cross-machine peers by peerHostId', async () => {
    const f = fixture()
    const sameHost = view({ direction: 'sent', peerThreadId: 'local-peer' })
    const crossHost = view({ direction: 'received', peerThreadId: 'desktop-peer', peerHostId: DESKTOP, peerMachine: 'This computer' })
    f.answers.set('parent', { threadId: 'parent', sent: [sameHost], received: [crossHost] })

    const read = await f.reads.views(key('parent'))
    expect(f.service.coordinationViews).toHaveBeenCalledWith('parent')
    expect(read.threadId).toBe(key('parent'))
    expect(read.sent[0]?.peerThreadId).toBe(key('local-peer', HOST))
    expect(read.received[0]?.peerThreadId).toBe(key('desktop-peer', DESKTOP))
    expect(read.received[0]?.peerMachine).toBe('This computer')
  })

  it('returns empty views and null reply cleanly when the host does not support coordination views', async () => {
    const f = fixture({ supports: false })
    expect(await f.reads.views(key('parent'))).toEqual({ threadId: key('parent'), sent: [], received: [] })
    expect(f.service.coordinationViews).not.toHaveBeenCalled()
    expect(await f.reads.reply(key('parent'), randomUUID())).toBeNull()
    expect(f.service.coordinationReply).not.toHaveBeenCalled()
  })

  it('keeps last read while disconnected, returns null reply offline, and re-notifies on reconnect or removal', async () => {
    const f = fixture()
    const exchange = view({ peerThreadId: 'peer-1' })
    f.answers.set('parent', { threadId: 'parent', sent: [exchange], received: [] })
    f.replies.set(`parent:${exchange.id}`, { text: 'Done on forge.', truncated: false })

    const first = await f.reads.views(key('parent'))
    expect(first.sent).toHaveLength(1)
    expect(await f.reads.reply(key('parent'), exchange.id)).toEqual({ exchangeId: exchange.id, text: 'Done on forge.', truncated: false })

    f.connected = false
    f.reads.heard(HOST, { connected: false })
    expect(f.told).toEqual([[key('parent')]])
    expect((await f.reads.views(key('parent'))).sent).toHaveLength(1)
    expect(await f.reads.views(key('never-read'))).toEqual({ threadId: key('never-read'), sent: [], received: [] })
    expect(await f.reads.reply(key('parent'), exchange.id)).toBeNull()

    f.connected = true
    f.reads.taken(HOST)
    expect(f.told.at(-1)).toEqual([key('parent'), key('never-read')])

    f.reads.removed(HOST)
    expect(f.told.at(-1)).toEqual([key('parent'), key('never-read')])
    f.connected = false
    expect((await f.reads.views(key('parent'))).sent).toEqual([])
  })

  it('forwards coordination-changed thread IDs host-qualified and drops stale answers from replaced connections', async () => {
    const f = fixture()
    f.reads.heard(HOST, { threadIds: ['a', 'b'] })
    expect(f.told).toEqual([[key('a'), key('b')]])

    let release: (answer: CoordinationRead) => void = () => undefined
    f.service.coordinationViews.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = f.reads.views(key('parent'))
    f.connection = { hostId: HOST, service: { ...f.service } }
    release({ threadId: 'parent', sent: [view()], received: [] })
    expect((await pending).sent).toEqual([])
  })

  it('bounds cached reads to KEPT_COORDINATION_READS and handles unknown hosts cleanly', async () => {
    const f = fixture()
    for (let i = 0; i <= KEPT_COORDINATION_READS; i++) {
      f.answers.set(`t-${i}`, { threadId: `t-${i}`, sent: [view()], received: [] })
      await f.reads.views(key(`t-${i}`))
    }
    f.connected = false
    f.reads.lostHost(HOST)
    expect(f.told.at(-1)).toHaveLength(KEPT_COORDINATION_READS)
    expect(f.told.at(-1)).not.toContain(key('t-0'))
    expect((await f.reads.views(key('parent', OTHER))).sent).toEqual([])
    expect((await f.reads.views('unqualified')).sent).toEqual([])
  })
})
