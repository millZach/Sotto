// @vitest-environment node
/**
 * Kept parts on a host's shell pushes (`kept-parts`, #2393, ADR-0028's November 10 amendment): to a client that accepted
 * it beside `changed-thread-records`, a push whose thread records are measured from the last push written to it leaves
 * out each part that holds what that push held, and names it. On forge's host every part but the thread records went
 * whole in every push, about 200 KB to a desktop and 73 KB to a phone for a few kilobytes of news.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { SocketFrames } from '../../src/host/socketFrames'
import { startSocketServer } from '../../src/host/socketServer'
import type { HostService } from '../../src/main/agents/hostService'
import type { AgentChangedThreadRecords, AgentState, AgentThread } from '../../src/shared/agents'
import { withKeptPartsPutBack, type HeldParts } from '../../src/shared/keptParts'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const listeners: Awaited<ReturnType<typeof startSocketServer>>[] = []
const raws: SocketFrames[] = []
afterEach(async () => {
  for (const frames of raws.splice(0)) frames.close()
  for (const listener of listeners.splice(0)) await listener.close()
})

type State = Record<string, unknown> & { kept?: string[]; host: Record<string, unknown> & { kept?: string[]; threads: AgentThread[] } }
interface ShellPush { state: State; threads?: AgentChangedThreadRecords }
const KEEPS = ['changed-thread-records', 'kept-parts']

/**
 * The fixture's host behind a listener of the test's own, which publishes only when the test says (`published`), with
 * `reads` counting the listener's reads of the shell: a publish reads it once as it sends, so a read means it was handled.
 */
async function controlledHost() {
  let publish: (state: AgentState) => void = () => undefined
  const counters = { reads: 0 }
  const real = fixture.host.service
  await expect.poll(() => real.shell().host.threads.length).toBeGreaterThan(1)
  const service: HostService = {
    shell: () => { counters.reads++; return real.shell() }, state: () => real.state(), threadDetail: id => real.threadDetail(id),
    command: (command, identity) => real.command(command, identity), events: (afterSeq, threadId, limit) => real.events(afterSeq, threadId, limit),
    subscribe: listener => { publish = listener; return () => undefined },
  }
  const listener = await startSocketServer({ service, pairing: fixture.host.pairing })
  listeners.push(listener)
  const peer = async (accepts: string[]) => {
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Sotto desktop')
    const raw = await rawPeer(listener.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    raws.push(raw.frames)
    const hello = await raw.call('hello', { op: 'hello', accepts }) as { result: { shell: State } }
    const shells = () => raw.messages.filter(message => message.event === 'shell') as unknown as ShellPush[]
    return { ...raw, hello: hello.result.shell, shells }
  }
  /** Publishes the host's shell and waits until the listener has handled it. */
  const published = async (): Promise<void> => {
    const before = counters.reads
    publish(real.shell())
    await expect.poll(() => counters.reads).toBeGreaterThan(before)
  }
  /** Turns the host's switch over, which changes one part of the shell, `configuration`, and no thread record. */
  const configure = async (): Promise<void> => {
    await real.command({ type: 'configure', patch: { enabled: !real.shell().configuration.enabled } }, { clientId: 'test', user: '', transport: 'socket' })
  }
  return { peer, published, configure, real }
}

/** Each push of `shells` put back whole, in order, as a client that accepted the feature puts them back. */
function putBack(shells: readonly ShellPush[]): State[] {
  let held: HeldParts | null = null
  return shells.map(push => {
    const whole = withKeptPartsPutBack<State>(push.state, push.threads?.base, held)
    if (whole === undefined) throw new Error('A push kept parts the client could not put back')
    held = push.threads ? { revision: push.threads.revision, top: whole, host: whole.host } : null
    return whole
  })
}

describe('kept parts on shell pushes', () => {
  it('leaves out each part that holds what the last push held, and the client puts back the shell a client without them is sent', async () => {
    const { peer, published, configure } = await controlledHost()
    const keeping = await peer(KEEPS), whole = await peer(['changed-thread-records'])
    await published()
    await expect.poll(() => keeping.shells().length).toBe(1)
    await expect.poll(() => whole.shells().length).toBe(1)
    // The first push lists every record, so it is measured from nothing and keeps nothing.
    const [first] = keeping.shells()
    expect(first!.threads!.base).toBeNull()
    expect(first!.state).not.toHaveProperty('kept')
    expect(first!.state.host).not.toHaveProperty('kept')

    await configure(); await published()
    await expect.poll(() => keeping.shells().length).toBe(2)
    await expect.poll(() => whole.shells().length).toBe(2)
    const second = keeping.shells()[1]!
    expect(second.threads!.base).toBe(first!.threads!.revision)
    // Only the part that changed goes, with what always goes: the threads, which go as changed records, and the catalog.
    expect(second.state).toHaveProperty('configuration')
    expect(second.state.kept).toEqual(expect.arrayContaining(['deliveries', 'credentials', 'hostId']))
    expect(second.state.kept).not.toContain('configuration')
    expect(second.state.host.kept).toEqual(expect.arrayContaining(['name', 'projects', 'providers', 'capabilities']))
    expect(second.state.host.kept).not.toEqual(expect.arrayContaining(['threads']))
    expect(second.state.host.kept).not.toEqual(expect.arrayContaining(['models']))
    for (const name of second.state.kept!) expect(second.state).not.toHaveProperty(name)
    expect(second.state.host.threads).toEqual([])
    expect(second.state.host).toHaveProperty('models')
    // Put back, each push is the state the other client was sent whole, field for field.
    const restored = putBack(keeping.shells())
    expect(restored[1]).toEqual(whole.shells()[1]!.state)
    expect(JSON.stringify(second).length).toBeLessThan(JSON.stringify(whole.shells()[1]).length)
  })

  it('keeps nothing in the push after a shell read, and keeps parts again in the one after that', async () => {
    const { peer, published, configure } = await controlledHost()
    const keeping = await peer(KEEPS)
    await published(); await configure(); await published()
    await expect.poll(() => keeping.shells().length).toBe(2)
    expect(keeping.shells()[1]!.state.kept?.length).toBeGreaterThan(0)
    // A shell read is how a client starts again: the push after it lists every record and every part.
    await keeping.call('read', { op: 'shell' })
    await configure(); await published()
    await expect.poll(() => keeping.shells().length).toBe(3)
    const afterRead = keeping.shells()[2]!
    expect(afterRead.threads!.base).toBeNull()
    expect(afterRead.state).not.toHaveProperty('kept')
    expect(afterRead.state.host).not.toHaveProperty('kept')
    expect(afterRead.state.host).toHaveProperty('projects')
    await configure(); await published()
    await expect.poll(() => keeping.shells().length).toBe(4)
    expect(keeping.shells()[3]!.state.kept?.length).toBeGreaterThan(0)
    expect(putBack(keeping.shells().slice(2)).at(-1)!.host.projects).toEqual(afterRead.state.host.projects)
  })

  it('still sends no push that repeats the last, and keeps the parts of the last push written', async () => {
    const { peer, published, configure } = await controlledHost()
    const keeping = await peer(KEEPS)
    await published(); await configure(); await published()
    await expect.poll(() => keeping.shells().length).toBe(2)
    // The repeat check reads the whole state, as before: nothing changed, so nothing is written.
    await published(); await published()
    expect(keeping.shells()).toHaveLength(2)
    await configure(); await published()
    await expect.poll(() => keeping.shells().length).toBe(3)
    const third = keeping.shells()[2]!
    expect(third.threads!.base).toBe(keeping.shells()[1]!.threads!.revision)
    expect(third.state).toHaveProperty('configuration')
    expect(third.state.kept).not.toContain('configuration')
  })

  it('answers a hello, a shell read and a command with every part, and measures no push from them', async () => {
    const { peer, published, configure, real } = await controlledHost()
    // With `reply-thread-records`, the first push is measured from the records hello listed, which hold no parts.
    const keeping = await peer([...KEEPS, 'reply-thread-records'])
    const answers = [keeping.hello]
    answers.push(((await keeping.call('read', { op: 'shell' })) as { result: State }).result)
    answers.push(((await keeping.call('command', { op: 'command', command: { type: 'select-project', projectId: real.shell().host.threads[0]!.projectId } })) as { result: State }).result)
    for (const answer of answers) {
      expect(answer).not.toHaveProperty('kept')
      expect(answer.host).not.toHaveProperty('kept')
      expect(answer).toHaveProperty('configuration')
      expect(answer.host).toHaveProperty('projects')
    }
    await configure(); await published()
    await expect.poll(() => keeping.shells().length).toBe(1)
    const first = keeping.shells()[0]!
    expect(first.threads!.base).not.toBeNull()
    expect(first.state).not.toHaveProperty('kept')
    await configure(); await published()
    await expect.poll(() => keeping.shells().length).toBe(2)
    expect(keeping.shells()[1]!.state.kept?.length).toBeGreaterThan(0)
  })

  it('sends every part to a client that did not accept it, and to one that accepted it without changed thread records', async () => {
    const { peer, published, configure } = await controlledHost()
    const clients = [await peer(['changed-thread-records']), await peer(['kept-parts']), await peer([])]
    for (let push = 0; push < 3; push++) { await configure(); await published() }
    for (const client of clients) {
      await expect.poll(() => client.shells().length).toBe(3)
      for (const shell of client.shells()) {
        expect(shell.state).not.toHaveProperty('kept')
        expect(shell.state.host).not.toHaveProperty('kept')
        expect(shell.state).toHaveProperty('deliveries')
        expect(shell.state.host).toHaveProperty('projects')
      }
    }
  })
})

describe('the desktop’s client of a paired host', () => {
  /** A change to one thread on the host, which it pushes to every client as a shell. */
  function change(): string {
    const workId = randomUUID()
    fixture.native.event({ type: 'background-work', threadId: 'workshop', text: '', status: 'idle',
      backgroundWork: [{ id: workId, label: 'Synthetic background work', type: 'command' }] })
    return workId
  }
  const carriesWork = (thread: AgentThread, workId: string): boolean => thread.backgroundWork?.some(work => work.id === workId) ?? false
  async function desktop() {
    await expect.poll(() => fixture.host.service.shell().host.threads.length).toBeGreaterThan(1)
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
    const pushes = () => wire.filter(frame => frame.event === 'shell') as unknown as ShellPush[]
    return { client, wire, heard, off, reached, receive: transport.receive, pushes }
  }
  /** The parts of a shell the host's own read gives too, for comparing what the client shows: all but the threads and this client's own. */
  const parts = (state: AgentState): Record<string, unknown> => {
    const top: Record<string, unknown> = { ...state }, host: Record<string, unknown> = { ...state.host }
    delete top.activeThreadId; delete top.activeProjectId; delete host.threads
    return { ...top, host }
  }

  it('accepts the feature, and shows the whole shell from pushes that keep its parts', async () => {
    const { client, off, reached, pushes } = await desktop()
    try {
      await reached(change())
      const shown = await reached(change())
      // Its pushes after the first left out the parts that did not change, and named them.
      expect(pushes().some(push => (push.state.kept?.length ?? 0) > 0 && (push.state.host.kept?.length ?? 0) > 0)).toBe(true)
      // What it shows is the host's shell whole.
      const read = await client.readShell()
      expect(parts(shown)).toEqual(parts(read))
    } finally { off() }
  })

  it('reads the shell whole when a push keeps a part it does not hold, and shows nothing of that push', async () => {
    const { client, heard, off, reached, receive, pushes } = await desktop()
    try {
      await reached(change())
      await reached(change())
      const shells = vi.spyOn(client, 'readShell')
      const last = pushes().at(-1)!
      const before = heard.length
      // Measured from the push it applied last, but naming a part that push did not have.
      const unheld = { ...last, state: { ...last.state, kept: [...last.state.kept ?? [], 'syntheticMissingPart'] }, threads: { ...last.threads!, revision: last.threads!.revision + 1_000, base: last.threads!.revision, changed: [] } }
      receive(JSON.stringify(unheld))
      expect(shells).toHaveBeenCalledTimes(1)
      // And one measured from a push it never applied.
      receive(JSON.stringify({ ...unheld, state: { ...last.state, kept: ['deliveries'] }, threads: { ...unheld.threads, base: 999_999 } }))
      expect(shells).toHaveBeenCalledTimes(2)
      await expect.poll(() => heard.length).toBeGreaterThan(before)
      // What it showed next is the whole shell it read, never a push it could not put back.
      for (const state of heard.slice(before)) { expect(state.host.threads.length).toBeGreaterThan(0); expect(state.host.projects.length).toBeGreaterThan(0) }
      // After the read the host keeps nothing in a push, and the client goes on showing its shell whole.
      const injected = pushes().length
      const after = await reached(change())
      expect(pushes().slice(injected).some(push => push.threads?.base === null && !('kept' in push.state))).toBe(true)
      expect(parts(after)).toEqual(parts(await client.readShell()))
    } finally { off() }
  })
})
