// @vitest-environment node
/**
 * A shell push to a client that accepted `changed-thread-records` carries only the thread records that changed since
 * the last one (#996, ADR-0028's October 30 amendment). While anything on a host streamed, every push carried every
 * record: 233 KB a push in the data-transfer benchmark, for a change to one thread.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SocketFrames } from '../../src/host/socketFrames'
import type { AgentChangedThreadRecords, AgentState, AgentThread } from '../../src/shared/agents'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const raws: SocketFrames[] = []
afterEach(() => { for (const frames of raws.splice(0)) frames.close() })

/** A change to one thread on the host, which it pushes to every client as a shell. */
function change(): string {
  const workId = randomUUID()
  fixture.native.event({ type: 'background-work', threadId: 'workshop', text: '', status: 'idle',
    backgroundWork: [{ id: workId, label: 'Synthetic background work', type: 'command' }] })
  return workId
}
const carriesWork = (thread: AgentThread, workId: string): boolean => thread.backgroundWork?.some(work => work.id === workId) ?? false

interface ShellPush { state: AgentState; threads?: AgentChangedThreadRecords }

async function peer(accepts: string[]) {
  // The host lists its provider's threads once it has connected to it.
  await expect.poll(() => fixture.host.service.shell().host.threads.length).toBeGreaterThan(1)
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'iPhone')
  const raw = await rawPeer(fixture.host.descriptor!.port, fixture.host.pairing.signSession(paired.clientId))
  raws.push(raw.frames)
  const hello = await raw.call('hello', { op: 'hello', accepts }) as { result: { shell: AgentState } }
  const shells = () => raw.messages.filter(message => message.event === 'shell') as unknown as ShellPush[]
  /** The first shell push that carries this change, in whichever form the client was sent it. */
  const pushed = async (workId: string): Promise<ShellPush> => {
    const find = () => shells().find(push => [...push.state.host.threads, ...push.threads?.changed ?? []].some(thread => carriesWork(thread, workId)))
    await expect.poll(find).toBeDefined()
    return find()!
  }
  return { ...raw, hello: hello.result.shell, shells, pushed }
}

describe('changed thread records on shell pushes', () => {
  it('sends an accepting client only the records that changed, and every other client every record', async () => {
    const accepting = await peer(['changed-thread-records']), older = await peer([])

    // The first push lists every record beside a state whose own list is empty; hello's shell was whole.
    const listed = accepting.hello.host.threads.length
    await accepting.pushed(change())
    const first = accepting.shells()[0]!
    expect(first.state.host.threads).toEqual([])
    expect(first.threads).toMatchObject({ base: null })
    expect(first.threads!.changed).toHaveLength(listed)

    // A change to one thread carries that one record, measured from the push before.
    const workId = change()
    const second = await accepting.pushed(workId)
    const previous = accepting.shells()[accepting.shells().indexOf(second) - 1]!
    expect(second.state.host.threads).toEqual([])
    expect(second.threads!.base).toBe(previous.threads!.revision)
    expect(second.threads!.changed).toHaveLength(1)
    expect(carriesWork(second.threads!.changed[0]!, workId)).toBe(true)
    expect(second.threads).not.toHaveProperty('removed')
    expect(second.threads).not.toHaveProperty('order')

    // A client that did not accept the feature is sent exactly what v1 sends.
    const whole = await older.pushed(workId)
    expect(whole).not.toHaveProperty('threads')
    expect(whole.state.host.threads).toHaveLength(listed)
  })

  it('lists every record again in the push after the client reads the shell whole', async () => {
    const accepting = await peer(['changed-thread-records'])
    const listed = accepting.hello.host.threads.length
    await accepting.pushed(change())
    await accepting.call('read', { op: 'shell' })
    const read = accepting.messages.findIndex(message => message.id === 'read')
    await accepting.pushed(change())
    const after = accepting.messages.slice(read).find(message => message.event === 'shell') as unknown as ShellPush
    expect(after.threads).toMatchObject({ base: null })
    expect(after.threads!.changed).toHaveLength(listed)
  })
})

describe('records an answer lists whole (reply-thread-records)', () => {
  const accepts = ['changed-thread-records', 'reply-thread-records']

  it('measures the first push from the records hello listed, rather than listing every record again', async () => {
    const seeded = await peer(accepts)
    const revision = (seeded.hello as unknown as { threadRecordsRevision?: number }).threadRecordsRevision
    expect(revision).toEqual(expect.any(Number))
    const workId = change()
    const carrying = await seeded.pushed(workId)
    // The first push is measured from hello's records, and no push lists every record again.
    expect(seeded.shells()[0]!.threads!.base).toBe(revision)
    for (const push of seeded.shells()) { expect(push.threads!.base).not.toBeNull(); expect(push.state.host.threads).toEqual([]) }
    expect(carrying.threads!.changed).toHaveLength(1)
    expect(carriesWork(carrying.threads!.changed[0]!, workId)).toBe(true)
  })

  it('measures the push after a shell read from the records that read listed', async () => {
    const seeded = await peer(accepts)
    await seeded.pushed(change())
    await seeded.call('read', { op: 'shell' })
    const answer = seeded.messages.find(message => message.id === 'read') as { result: { threadRecordsRevision?: number; host: { threads: AgentThread[] } } }
    expect(answer.result.threadRecordsRevision).toEqual(expect.any(Number))
    expect(answer.result.host.threads.length).toBeGreaterThan(1)
    const workId = change()
    const after = await seeded.pushed(workId)
    expect(after.threads!.base).toBe(answer.result.threadRecordsRevision)
    expect(after.threads!.changed).toHaveLength(1)
  })

  it('names no revision to a client that did not accept it, nor to one without changed records', async () => {
    for (const asked of [['changed-thread-records'], ['reply-thread-records']]) {
      const client = await peer(asked)
      expect(client.hello).not.toHaveProperty('threadRecordsRevision')
      await client.call('read', { op: 'shell' })
      expect((client.messages.find(message => message.id === 'read') as { result: object }).result).not.toHaveProperty('threadRecordsRevision')
    }
  })
})

describe('the desktop’s client of a paired host', () => {
  async function desktop() {
    const { client } = await fixture.pair('Desktop')
    const transport = client as unknown as { receive(text: string): void }
    const receive = transport.receive.bind(client), wire: Record<string, unknown>[] = []
    transport.receive = text => { wire.push(JSON.parse(text) as Record<string, unknown>); receive(text) }
    const heard: AgentState[] = []
    const off = client.subscribe(state => { heard.push(state) })
    const reached = async (workId: string): Promise<AgentState> => {
      const find = () => heard.find(state => state.host.threads.some(thread => carriesWork(thread, workId)))
      await expect.poll(find).toBeDefined()
      return find()!
    }
    return { client, wire, heard, off, reached, receive: transport.receive }
  }

  it('accepts the feature, and shows every record, keeping each one that did not change', async () => {
    const { client, wire, off, reached } = await desktop()
    try {
      const first = await reached(change())
      const workId = change()
      const second = await reached(workId)
      // Its pushes carried changed records, never the whole list.
      const pushes = wire.filter(frame => frame.event === 'shell') as unknown as ShellPush[]
      expect(pushes.length).toBeGreaterThan(0)
      for (const push of pushes) { expect(push.state.host.threads).toEqual([]); expect(push.threads).toBeDefined() }
      // What it shows is the host's list whole, and each record that did not change is the one it already held.
      expect(second.host.threads).toEqual((await client.readShell()).host.threads)
      const changed = second.host.threads.find(thread => carriesWork(thread, workId))!
      for (const thread of second.host.threads) {
        if (thread !== changed) expect(thread).toBe(first.host.threads.find(held => held.id === thread.id))
      }
    } finally { off() }
  })

  it('reads the shell whole when a push is measured from records it does not hold, and shows nothing of that push', async () => {
    const { client, wire, heard, off, reached, receive } = await desktop()
    try {
      await reached(change())
      const shells = vi.spyOn(client, 'readShell')
      const pushed = wire.filter(frame => frame.event === 'shell').at(-1) as unknown as ShellPush
      const before = heard.length
      receive(JSON.stringify({ ...pushed, threads: { ...pushed.threads!, revision: 1_000_000, base: 999_999 } }))
      expect(shells).toHaveBeenCalledTimes(1)
      await expect.poll(() => heard.length).toBeGreaterThan(before)
      // What it showed next is the whole shell it read, never the push it could not put back.
      expect(heard.slice(before).every(state => state.host.threads.length > 0)).toBe(true)
      // The host lists every record in its next push, and the client shows the host's list.
      const workId = change()
      const after = await reached(workId)
      const last = wire.filter(frame => frame.event === 'shell').at(-1) as unknown as ShellPush
      expect(last.threads).toMatchObject({ base: null })
      expect(after.host.threads).toEqual((await client.readShell()).host.threads)
    } finally { off() }
  })
})
