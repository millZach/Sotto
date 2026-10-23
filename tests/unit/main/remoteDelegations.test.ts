// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import type { DelegatedView, DelegationsRead } from '../../../src/shared/delegation'
import { KEPT_DELEGATION_READS, RemoteDelegationReads, type RemoteDelegationHost } from '../../../src/main/hosts/remoteDelegations'

/**
 * A remote host's own threads' delegations as the window reads them (#1310): read on that host, keyed by it, kept while it
 * is away and shown then as Sotto last read them, and read afresh once it connects again.
 */
const HOST = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const key = (id: string, hostId = HOST): string => hostEntityKey(hostId, id)

function view(thread: string, patch: Partial<DelegatedView> = {}): DelegatedView {
  return { id: crypto.randomUUID(), thread, action: 'start', work: 'code-review', rootUserMessageId: 'root', anchorMessageId: 'root', briefMessageId: `${thread}-brief`,
    outcome: 'working', told: false, createdAt: '2026-10-23T14:00:00.000Z', waiting: false, ...patch }
}

function fixture(options: { supports?: boolean } = {}) {
  const answers = new Map<string, DelegationsRead>()
  const service = {
    supportsDelegationViews: options.supports ?? true,
    delegationViews: vi.fn(async (threadId: string): Promise<DelegationsRead> => {
      const answer = answers.get(threadId)
      if (!answer) throw new Error('unreadable')
      return answer
    }),
    delegationBrief: vi.fn(async (threadId: string) => ({ threadId, text: `Brief for ${threadId}` })),
  }
  let connection: RemoteDelegationHost | undefined = { hostId: HOST, service }
  let connected = true
  let clock = Date.parse('2026-10-23T14:06:00.000Z')
  const reads = new RemoteDelegationReads({ connection: hostId => hostId === HOST ? connection : undefined, connected: () => connected }, () => new Date(clock))
  const told: string[][] = []
  reads.subscribe(threadIds => told.push([...threadIds]))
  return { reads, service, answers, told,
    set connected(value: boolean) { connected = value },
    set connection(value: RemoteDelegationHost | undefined) { connection = value },
    tick: (ms: number) => { clock += ms } }
}

describe('a remote host\'s delegation reads', () => {
  it('reads a thread on its own host and keys every thread it names by that host', async () => {
    const f = fixture()
    f.answers.set('parent', { threadId: 'parent', delegations: [view('child'), { id: crypto.randomUUID(), action: 'start', work: 'building', outcome: 'refused', refusal: 'MACHINE_UNAVAILABLE', createdAt: '2026-10-23T14:01:00.000Z' }],
      received: [view('parent', { action: 'send' })] })
    const read = await f.reads.views(key('parent'))
    expect(f.service.delegationViews).toHaveBeenCalledWith('parent')
    expect(read.threadId).toBe(key('parent'))
    expect(read.delegations.map(item => item.thread)).toEqual([key('child'), undefined])
    expect(read.received[0]!.thread).toBe(key('parent'))
    expect(read.lastRead).toBeUndefined()
    expect(read.unread).toBeUndefined()
  })

  it('says a host that does not offer it is older, and reads nothing there', async () => {
    const f = fixture({ supports: false })
    expect(await f.reads.views(key('parent'))).toEqual({ threadId: key('parent'), delegations: [], received: [], unread: 'older-host' })
    expect(f.service.delegationViews).not.toHaveBeenCalled()
    expect(await f.reads.brief(key('parent'))).toBeNull()
  })

  it('keeps the last read while the host is away, as of when it was lost, and reads afresh once it connects again', async () => {
    const f = fixture()
    f.answers.set('parent', { threadId: 'parent', delegations: [view('child')], received: [] })
    await f.reads.views(key('parent'))
    f.tick(60_000)
    f.connected = false
    f.reads.lostHost(HOST)
    // The window is told to read what it holds of that host again, and is given what Sotto last read there.
    expect(f.told).toEqual([[key('parent')]])
    const away = await f.reads.views(key('parent'))
    expect(away.delegations[0]).toMatchObject({ thread: key('child'), outcome: 'working' })
    expect(away.lastRead).toBe('2026-10-23T14:07:00.000Z')
    expect(f.service.delegationViews).toHaveBeenCalledTimes(1)
    // A second word of the same loss changes nothing.
    f.reads.lostHost(HOST)
    expect(f.told).toHaveLength(1)
    // A thread never read there has nothing to show.
    expect(await f.reads.views(key('other'))).toEqual({ threadId: key('other'), delegations: [], received: [], unread: 'not-connected' })
    // The brief is read only from a connected host.
    expect(await f.reads.brief(key('child'))).toBeNull()
    // Reconnected: told again, and what the host's own record says now is what shows, unknown included.
    f.connected = true
    f.answers.set('parent', { threadId: 'parent', delegations: [view('child', { outcome: 'unknown', unknownWhy: 'restarted' })], received: [] })
    f.reads.taken(HOST)
    expect(f.told).toEqual([[key('parent')], [key('parent')]])
    const back = await f.reads.views(key('parent'))
    expect(back.lastRead).toBeUndefined()
    expect(back.delegations[0]).toMatchObject({ outcome: 'unknown', unknownWhy: 'restarted' })
    expect(await f.reads.brief(key('child'))).toEqual({ threadId: key('child'), text: 'Brief for child' })
  })

  it('names the threads a host says changed, by the window\'s keys, and hears its connection closing', () => {
    const f = fixture()
    f.reads.heard(HOST, { threadIds: ['parent', 'child'] })
    expect(f.told).toEqual([[key('parent'), key('child')]])
    f.reads.heard(HOST, { connected: false })
    // Nothing of it was kept, so there is nothing to read again.
    expect(f.told).toHaveLength(1)
  })

  it('falls back to the last read when a read fails, and forgets a host that is removed', async () => {
    const f = fixture()
    f.answers.set('parent', { threadId: 'parent', delegations: [view('child')], received: [] })
    await f.reads.views(key('parent'))
    f.answers.delete('parent')
    const failed = await f.reads.views(key('parent'))
    expect(failed.delegations).toHaveLength(1)
    expect(failed.lastRead).toBeDefined()
    f.reads.removed(HOST)
    expect(f.told.at(-1)).toEqual([key('parent')])
    f.connected = false
    expect((await f.reads.views(key('parent'))).unread).toBe('not-connected')
  })

  it('drops an answer from a connection replaced while it was read', async () => {
    const f = fixture()
    let release: (answer: DelegationsRead) => void = () => undefined
    f.service.delegationViews.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = f.reads.views(key('parent'))
    f.connection = { hostId: HOST, service: { ...f.service } }
    release({ threadId: 'parent', delegations: [view('child')], received: [] })
    expect((await pending).delegations).toEqual([])
  })

  it('keeps a bounded number of reads, oldest read first out, and keys only its own host', async () => {
    const f = fixture()
    for (let index = 0; index <= KEPT_DELEGATION_READS; index++) {
      f.answers.set(`thread-${index}`, { threadId: `thread-${index}`, delegations: [view(`child-${index}`)], received: [] })
      await f.reads.views(key(`thread-${index}`))
    }
    f.connected = false
    f.reads.lostHost(HOST)
    expect(f.told.at(-1)).toHaveLength(KEPT_DELEGATION_READS)
    expect(f.told.at(-1)).not.toContain(key('thread-0'))
    expect((await f.reads.views(key('thread-0'))).unread).toBe('not-connected')
    // A key on a host the router does not hold, and one that is no key at all, read nothing.
    expect((await f.reads.views(key('parent', OTHER))).unread).toBe('not-connected')
    expect((await f.reads.views('parent')).unread).toBe('not-connected')
  })
})
