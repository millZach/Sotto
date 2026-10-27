// @vitest-environment node
// The desktop relay (#1316, Owl `cross-machine-work`): a thread on a host delegates to This computer through the desktop.
// The host's side asks and keeps its record; the desktop's side places and admits the start as one of its own.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostDelegationRelay, RelayUnanswered, type RelayDesktop } from '../../../src/main/agents/delegationRelayHost'
import { DesktopDelegationRelay, RELAY_THIS_COMPUTER_ONLY, type RelayHostConnection } from '../../../src/main/agents/delegationRelayDesktop'
import { hostDelegationMachines, RELAYED_HOST } from '../../../src/main/agents/hostDelegation'
import { delegationToolDefinitions } from '../../../src/main/agents/delegationTools'
import type { HostFactsSource } from '../../../src/main/agents/hostFacts'
import { DELEGATION_RELAY_RECORDS_MAX, relayAwayWords, type DelegationRelayAsk } from '../../../src/shared/delegationRelay'
import { hostRequestSchema, hostPushSchema, HOST_DESKTOP_FEATURES, HOST_FEATURES } from '../../../src/shared/hostProtocol'
import type { DelegationNews } from '../../../src/shared/delegation'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== tmpdir() || !root.includes('sotto-relay-unit-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})
const folder = async () => { const root = await mkdtemp(join(tmpdir(), 'sotto-relay-unit-')); roots.push(root); return root }
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const HOST = '11111111-1111-4111-8111-111111111111', DESKTOP = '22222222-2222-4222-8222-222222222222', MAC = '33333333-3333-4333-8333-333333333333'
const DELEGATION = '44444444-4444-4444-8444-444444444444'

/** A desktop that answers each ask as `answer` says, or holds it until the test answers by hand. */
function desktop(relay: HostDelegationRelay, answer?: (ask: DelegationRelayAsk) => unknown) {
  const asked: { askId: string; ask: DelegationRelayAsk }[] = []
  const handle: RelayDesktop = { clientId: 'desktop-a', push: (askId, ask) => {
    asked.push({ askId, ask })
    if (answer) queueMicrotask(() => relay.answered(handle, askId, answer(ask)))
    return true
  } }
  return { handle, asked }
}
const startAsk = { levels: 0, rootUserMessageId: 'root-1', runtimeMode: 'auto' as const, projectId: 'project-a', machine: DESKTOP, input: { work: 'code-review', brief: 'Review it.' }, waitMs: 1_000 }

describe('the host side of the relay', () => {
  it('refuses by name while no desktop relays, and keeps nothing', async () => {
    const relay = new HostDelegationRelay(await folder(), { here: () => 'forge' })
    await relay.load()
    expect(relay.reachable()).toBe(false)
    expect(relay.awayWords()).toBe('This computer isn\'t connected to forge, so nothing was started there. Start it on forge instead, or try again when this computer is back.')
    await expect(relay.start('thread-a', 'code-review', startAsk)).rejects.toBeInstanceOf(RelayUnanswered)
    expect(relay.list('thread-a')).toEqual([])
  })

  it('starts through the desktop, keeps the delegation under the desktop\'s ID, and reads and tells it from there', async () => {
    const root = await folder(), relay = new HostDelegationRelay(root, { here: () => 'forge' })
    await relay.load()
    let outcome = 'working'
    const { handle, asked } = desktop(relay, ask => ask.type === 'start'
      ? { status: 'ok', delegation: { id: DELEGATION, thread: 'child-1', outcome: 'working' }, placement: { hostId: DESKTOP, name: 'This computer', awayFromDefault: false } }
      : { status: 'ok', delegation: { id: DELEGATION, thread: 'child-1', outcome } })
    const told: { threadId: string; news: DelegationNews }[] = []
    relay.useDelivery(async (threadId, news) => { told.push({ threadId, news }) })
    relay.desktopConnected(handle)
    const answer = await relay.start('thread-a', 'code-review', startAsk)
    expect(answer).toMatchObject({ status: 'ok', delegation: { id: DELEGATION } })
    expect(asked[0]!.ask).toMatchObject({ type: 'start', threadId: 'thread-a', machine: DESKTOP })
    expect(relay.holds('thread-a', DELEGATION)).toBe(true)
    expect(relay.holds('thread-b', DELEGATION)).toBe(false)
    expect(relay.holdsThread('thread-a', 'child-1')).toBe(true)
    expect(relay.list('thread-a')).toEqual([expect.objectContaining({ id: DELEGATION, thread: 'child-1', outcome: 'working', machine: 'This computer' })])
    // The desktop's news of an answer reaches the thread once, as its wake-up.
    await relay.news('thread-a', { source: 'delegation', items: [{ delegationId: DELEGATION, threadId: 'child-1', outcome: 'answered' }] },
      [{ delegationId: DELEGATION, messageId: 'reply-1', text: 'Synthetic finding', truncated: false }])
    await relay.news('thread-a', { source: 'delegation', items: [{ delegationId: DELEGATION, threadId: 'child-1', outcome: 'answered' }] })
    // The reply waits, in memory only, for the wake-up to be worded (ADR-0105 decision 6).
    expect(relay.detail(DELEGATION)).toEqual({ reply: { messageId: 'reply-1', text: 'Synthetic finding', truncated: false } })
    expect(told).toEqual([{ threadId: 'thread-a', news: { source: 'delegation', items: [{ delegationId: DELEGATION, threadId: 'child-1', outcome: 'answered' }] } }])
    // News naming a delegation another thread made is not this thread's.
    await expect(relay.news('thread-b', { source: 'delegation', items: [{ delegationId: DELEGATION, threadId: 'child-1', outcome: 'failed' }] })).rejects.toThrow()
    expect(told).toHaveLength(1)
    outcome = 'answered'
    expect(await relay.read('thread-a', DELEGATION)).toMatchObject({ status: 'ok', delegation: { id: DELEGATION, outcome: 'answered' } })
    // Kept across a restart.
    const again = new HostDelegationRelay(root); await again.load()
    expect(again.list('thread-a')).toEqual([expect.objectContaining({ id: DELEGATION, outcome: 'answered' })])
  })

  it('reads a lost answer as unknown, sends nothing again, and reads it exactly once the desktop is back', async () => {
    const relay = new HostDelegationRelay(await folder(), { here: () => 'forge' })
    await relay.load()
    const told: DelegationNews[] = []
    relay.useDelivery(async (_threadId, news) => { told.push(news) })
    const lost = desktop(relay)
    relay.desktopConnected(lost.handle)
    const starting = relay.start('thread-a', 'code-review', startAsk)
    await expect.poll(() => lost.asked.length).toBe(1)
    // The socket closes before the desktop answers.
    relay.desktopGone(lost.handle)
    const answer = await starting
    const relayId = (answer.delegation as { id: string }).id
    expect(answer).toMatchObject({ status: 'ok', delegation: { outcome: 'unknown', note: expect.stringContaining('Nothing will be sent again') } })
    // While away, a read says it is the last outcome read, and asks nothing.
    expect(await relay.read('thread-a', relayId)).toMatchObject({ status: 'ok', delegation: { id: relayId, outcome: 'unknown', note: expect.stringContaining('last read') } })
    // Back: the open delegation is read by its relay ID, exactly once, and the thread hears what it was.
    const back = desktop(relay, ask => ask.type === 'read' && ask.relayId === relayId ? { status: 'ok', delegation: { id: DELEGATION, thread: 'child-1', outcome: 'answered' } } : { status: 'refused', code: 'UNKNOWN_DELEGATION', message: 'x' })
    relay.desktopConnected(back.handle)
    await relay.reconcile()
    expect(back.asked.map(item => item.ask.type)).toEqual(['read'])
    expect(back.asked.filter(item => item.ask.type === 'start')).toHaveLength(0)
    expect(told).toEqual([{ source: 'delegation', items: [{ delegationId: relayId, threadId: 'child-1', outcome: 'answered' }] }])
    // The thread knows it by the ID it was told first; the desktop's own reaches it too.
    expect(relay.holds('thread-a', relayId) && relay.holds('thread-a', DELEGATION)).toBe(true)
  })

  it('leaves unknown what the desktop cannot prove after a drop', async () => {
    const relay = new HostDelegationRelay(await folder(), { here: () => 'forge' })
    await relay.load()
    const first = desktop(relay, () => ({ status: 'ok', delegation: { id: DELEGATION, thread: 'child-1', outcome: 'working' } }))
    relay.desktopConnected(first.handle)
    await relay.start('thread-a', 'code-review', startAsk)
    relay.desktopGone(first.handle)
    const told: DelegationNews[] = []
    relay.useDelivery(async (_threadId, news) => { told.push(news) })
    relay.desktopConnected(desktop(relay, () => ({ status: 'refused', code: 'UNKNOWN_DELEGATION', message: 'not held' })).handle)
    await relay.reconcile()
    expect(relay.list('thread-a')[0]).toMatchObject({ outcome: 'unknown' })
    expect(told).toEqual([{ source: 'delegation', items: [{ delegationId: DELEGATION, threadId: 'child-1', outcome: 'unknown' }] }])
  })

  it('holds news that comes before its start\'s answer until the start is known, and never takes news it did not deliver', async () => {
    const relay = new HostDelegationRelay(await folder(), { here: () => 'forge' })
    await relay.load()
    const told: DelegationNews[] = []
    relay.useDelivery(async (_threadId, news) => { told.push(news) })
    const slow = desktop(relay)
    relay.desktopConnected(slow.handle)
    const starting = relay.start('thread-a', 'code-review', startAsk)
    await expect.poll(() => slow.asked.length).toBe(1)
    // The outcome's news overtakes the start's answer.
    const news = relay.news('thread-a', { source: 'delegation', items: [{ delegationId: DELEGATION, threadId: 'child-1', outcome: 'answered' }] })
    relay.answered(slow.handle, slow.asked[0]!.askId, { status: 'ok', delegation: { id: DELEGATION, thread: 'child-1', outcome: 'working' } })
    await starting; await news
    expect(told).toEqual([{ source: 'delegation', items: [{ delegationId: DELEGATION, threadId: 'child-1', outcome: 'answered' }] }])
    // News of a delegation this host never made is refused, so the desktop does not count it as told.
    await expect(relay.news('thread-a', { source: 'delegation', items: [{ delegationId: '99999999-9999-4999-8999-999999999999', threadId: 'x', outcome: 'answered' }] })).rejects.toThrow()
    // And news this host cannot deliver is refused too.
    relay.useDelivery(async () => { throw new Error('busy') })
    await expect(relay.news('thread-a', { source: 'delegation', items: [{ delegationId: DELEGATION, threadId: 'child-1', outcome: 'failed' }] })).rejects.toThrow()
  })

  it('never forgets an open relayed delegation to keep its record small, only settled ones', async () => {
    const relay = new HostDelegationRelay(await folder(), { here: () => 'forge' })
    await relay.load()
    let made = 0
    const { handle } = desktop(relay, () => ({ status: 'ok', delegation: { id: `00000000-0000-4000-8000-${String(++made).padStart(12, '0')}`, thread: `child-${made}`, outcome: made === 1 ? 'working' : 'answered' } }))
    relay.desktopConnected(handle)
    for (let index = 0; index < DELEGATION_RELAY_RECORDS_MAX + 5; index++) await relay.start('thread-a', 'code-review', startAsk)
    expect(relay.holds('thread-a', '00000000-0000-4000-8000-000000000001')).toBe(true)
    expect(relay.holds('thread-a', '00000000-0000-4000-8000-000000000002')).toBe(false)
  })

  it('says Stop could not reach a delegation while the desktop is away', async () => {
    const relay = new HostDelegationRelay(await folder(), { here: () => 'forge' })
    await relay.load()
    const first = desktop(relay, () => ({ status: 'ok', delegation: { id: DELEGATION, thread: 'child-1', outcome: 'working' } }))
    relay.desktopConnected(first.handle)
    await relay.start('thread-a', 'code-review', startAsk)
    relay.desktopGone(first.handle)
    expect(await relay.cancel('thread-a', DELEGATION)).toMatchObject({ status: 'refused', message: expect.stringContaining('This computer isn\'t connected to forge, so Sotto could not stop this delegation there.') })
  })
})

describe('where a thread on a host may delegate with the relay', () => {
  const facts = { read: async () => ({ observedAt: new Date().toISOString(), os: { family: 'linux', name: null, version: null },
    architecture: null, totalMemoryBytes: null, freeMemoryBytes: null, logicalCpuCount: null }) } as unknown as HostFactsSource
  const project = { hostId: HOST, projectId: 'project-a' }
  const relayOf = (reachable: boolean, listed?: unknown[]) => ({ reachable: () => reachable, awayWords: () => relayAwayWords('forge'),
    machines: async () => reachable ? { status: 'ok', machines: listed ?? [] } : undefined })

  it('sends another machine or system to the desktop while it relays, and refuses by name while it is away', async () => {
    const on = hostDelegationMachines(() => HOST, facts, () => [], relayOf(true))
    expect(await on.place({ machine: DESKTOP }, project, 'this-computer')).toMatchObject({ hostId: DESKTOP })
    expect(await on.place({ os: 'windows' }, project, 'this-computer')).toMatchObject({ hostId: RELAYED_HOST })
    // This machine and its own system still start here.
    expect(await on.place({ os: 'linux' }, project, 'this-computer')).toMatchObject({ hostId: HOST })
    expect(await on.place({ machine: HOST, os: 'macos' }, project, 'this-computer')).toMatchObject({ status: 'refused' })
    const off = hostDelegationMachines(() => HOST, facts, () => [], relayOf(false))
    expect(await off.place({ machine: DESKTOP }, project, 'this-computer')).toEqual({ status: 'refused', code: 'HOST_DISCONNECTED', retryable: true,
      message: 'This computer isn\'t connected to forge, so nothing was started there. Start it on forge instead, or try again when this computer is back.' })
  })

  it('lists the desktop\'s machines beside this one, this one once', async () => {
    const on = hostDelegationMachines(() => HOST, facts, () => [], relayOf(true, [{ hostId: DESKTOP, name: 'This computer', thisComputer: true }, { hostId: HOST, name: 'forge' }]))
    const list = await on.list() as { machines: { hostId: string; name: string; thisComputer: boolean }[] }
    expect(list.machines.map(machine => [machine.hostId, machine.name, machine.thisComputer])).toEqual([[HOST, 'This machine', true], [DESKTOP, 'This computer', false]])
    const away = await hostDelegationMachines(() => HOST, facts, () => [], relayOf(false)).list() as { machines: unknown[]; note: string }
    expect(away.machines).toHaveLength(1)
    expect(away.note).toContain('This computer isn\'t connected to forge')
  })

  it('tells a thread on the host it may start on This computer only with the relay', () => {
    const without = delegationToolDefinitions(true, true, 'this-machine').find(tool => tool.name === 'delegate')!
    const relayed = delegationToolDefinitions(true, true, 'this-machine', true).find(tool => tool.name === 'delegate')!
    expect(without.description).not.toContain('This computer')
    expect(relayed.description).toContain('Sotto asks This computer')
    expect(relayed.inputSchema).toEqual(without.inputSchema)
  })
})

describe('the desktop side of the relay', () => {
  const placement = (hostId: string, projectId = 'local-project') => ({
    machines: async () => ({ status: 'ok', machines: [{ hostId: DESKTOP, name: 'This computer' }] }),
    placement: async () => ({ hostId, projectId, receipt: { hostId, name: hostId === MAC ? 'the Mac' : hostId === HOST ? 'forge' : 'This computer', awayFromDefault: false } }),
    machineName: (id: string) => id === HOST ? 'forge' : undefined,
  })
  const ask = (extra: Partial<Extract<DelegationRelayAsk, { type: 'start' }>> = {}): DelegationRelayAsk => ({ type: 'start', relayId: '55555555-5555-4555-8555-555555555555', threadId: 'thread-a', ...startAsk, ...extra })

  it('admits a start on This computer as its own delegation, for the asking thread by its host\'s key', async () => {
    const relay = new DesktopDelegationRelay(await folder(), { placement: placement(DESKTOP), localHostId: () => DESKTOP })
    await relay.load()
    const threads: { id: string; delegatedBy?: string }[] = [{ id: 'thread-a' }]
    relay.useHosts({ subscribeConnected: () => () => undefined, remoteConnections: () => [{ hostId: HOST, kind: 'remote', service: { shell: () => ({ host: { threads } }) } }] })
    const calls: { threadId: string; args: unknown; waitMs?: number | undefined }[] = []
    relay.useDelegation({ delegate: async (threadId, args, context) => { calls.push({ threadId, args, waitMs: context?.waitMs }); return { status: 'ok', delegation: { id: DELEGATION, outcome: 'working' } } },
      read: async () => ({ status: 'ok', delegation: { id: DELEGATION, outcome: 'answered' } }), cancel: async () => ({ status: 'ok' }), retriedDelegation: () => undefined, isOpen: () => true, hasOpen: () => true })
    const answer = await relay.answer(HOST, ask())
    expect(answer).toMatchObject({ status: 'ok', placement: { hostId: DESKTOP, name: 'This computer' } })
    const key = `host:${HOST}:thread-a`
    expect(calls).toEqual([{ threadId: key, args: { work: 'code-review', brief: 'Review it.', retry_key: '55555555-5555-4555-8555-555555555555' }, waitMs: 3_000 }])
    expect(relay.caller(key)).toEqual({ id: key, projectId: 'local-project', runtimeMode: 'auto', levels: 0, rootUserMessageId: 'root-1' })
    // Its depth is what this computer can prove from its own read of the host, never less than the host says (#1316 review).
    threads.splice(0, 1, { id: 'thread-a', delegatedBy: 'parent-of-a' }, { id: 'parent-of-a' })
    await relay.answer(HOST, ask())
    expect(relay.caller(key)?.levels).toBe(1)
    // A chain it cannot follow to the top counts as the deepest a delegating thread may be.
    threads.splice(1, 1)
    await relay.answer(HOST, ask())
    expect(relay.caller(key)?.levels).toBe(1)
    threads.length = 0
    await relay.answer(HOST, ask())
    expect(relay.caller(key)?.levels).toBe(1)
    threads.push({ id: 'thread-a' })
    // A read by the host's relay ID finds what it made; one it never recorded cannot be proved.
    expect(await relay.answer(HOST, { type: 'read', threadId: 'thread-a', relayId: '55555555-5555-4555-8555-555555555555' })).toMatchObject({ delegation: { outcome: 'answered' } })
    expect(await relay.answer(HOST, { type: 'read', threadId: 'thread-a', relayId: '66666666-6666-4666-8666-666666666666' })).toMatchObject({ status: 'refused', code: 'UNKNOWN_DELEGATION' })
    // Another host asking for the same thread ID is another thread, which this computer never admitted.
    expect(await relay.answer(MAC, { type: 'cancel', threadId: 'thread-a', delegation: DELEGATION })).toMatchObject({ status: 'refused', code: 'UNKNOWN_DELEGATION' })
  })

  it('finds what a start made while it is still waiting, and after a restart, by the retry key it was admitted under', async () => {
    const root = await folder()
    const admitted = new Map<string, string>()
    const reads: unknown[] = []
    const delegation = { delegate: (threadId: string, args: unknown) => { admitted.set(`${threadId}\n${(args as { retry_key: string }).retry_key}`, DELEGATION); return new Promise<unknown>(() => undefined) },
      read: async (_threadId: string, args: unknown) => { reads.push(args); return { status: 'ok', delegation: { id: DELEGATION, outcome: 'working' } } }, cancel: async () => ({}),
      retriedDelegation: (callerId: string, retryKey: string) => admitted.get(`${callerId}\n${retryKey}`), isOpen: () => true, hasOpen: () => true }
    const relay = new DesktopDelegationRelay(root, { placement: placement(DESKTOP), localHostId: () => DESKTOP })
    relay.useDelegation(delegation)
    // The start waits for its outcome; its answer never goes.
    void relay.answer(HOST, ask())
    await expect.poll(() => admitted.size).toBe(1)
    const relayId = '55555555-5555-4555-8555-555555555555'
    expect(await relay.answer(HOST, { type: 'read', threadId: 'thread-a', relayId })).toMatchObject({ delegation: { id: DELEGATION } })
    // This computer restarts in the middle of that wait: the ask and its retry key were saved before it.
    const again = new DesktopDelegationRelay(root, { placement: placement(DESKTOP), localHostId: () => DESKTOP })
    await again.load(); again.useDelegation(delegation)
    expect(await again.answer(HOST, { type: 'read', threadId: 'thread-a', relayId })).toMatchObject({ delegation: { id: DELEGATION } })
    expect(reads).toEqual([{ delegation: DELEGATION }, { delegation: DELEGATION }])
  })

  it('refuses a start placed back on the asking machine or on a third machine, and starts nothing', async () => {
    const started: unknown[] = []
    const delegation = { delegate: async (...args: unknown[]) => { started.push(args); return {} }, read: async () => ({}), cancel: async () => ({}), retriedDelegation: () => undefined, isOpen: () => true, hasOpen: () => true }
    const home = new DesktopDelegationRelay(await folder(), { placement: placement(HOST), localHostId: () => DESKTOP }); home.useDelegation(delegation)
    expect(await home.answer(HOST, ask())).toMatchObject({ status: 'refused', code: 'MACHINE_UNAVAILABLE', message: expect.stringContaining('That is forge, where this thread runs') })
    const third = new DesktopDelegationRelay(await folder(), { placement: placement(MAC), localHostId: () => DESKTOP }); third.useDelegation(delegation)
    expect(await third.answer(HOST, ask({ machine: MAC }))).toEqual({ status: 'refused', code: 'MACHINE_UNAVAILABLE', message: RELAY_THIS_COMPUTER_ONLY('the Mac', 'forge') })
    expect(started).toEqual([])
  })

  it('answers each ask a relaying host pushes, and sends news back to the asking host', async () => {
    const relay = new DesktopDelegationRelay(await folder(), { placement: placement(DESKTOP), localHostId: () => DESKTOP })
    relay.useDelegation({ delegate: async () => ({ status: 'ok', delegation: { id: DELEGATION, outcome: 'working' } }), read: async () => ({}), cancel: async () => ({}), retriedDelegation: () => undefined, isOpen: () => true, hasOpen: () => true })
    let push: ((askId: string, ask: DelegationRelayAsk) => void) | undefined
    const answers: unknown[] = [], news: unknown[] = []
    const connection: RelayHostConnection = { hostId: HOST, kind: 'remote', service: { supportsDelegationRelay: true,
      subscribeDelegationRelay: listener => { push = listener; return () => undefined },
      answerDelegationRelay: async (askId, answer) => { answers.push({ askId, answer }) },
      delegationRelayNews: async (threadId, items, replies) => { news.push({ threadId, items, ...replies?.length ? { replies } : {} }) } } }
    relay.useHosts({ subscribeConnected: () => () => undefined, remoteConnections: () => [connection] })
    push!('77777777-7777-4777-8777-777777777777', { type: 'machines' })
    await flush(); await flush()
    expect(answers).toEqual([{ askId: '77777777-7777-4777-8777-777777777777', answer: { status: 'ok', machines: [{ hostId: DESKTOP, name: 'This computer' }] } }])
    const items: DelegationNews = { source: 'delegation', items: [{ delegationId: DELEGATION, threadId: 'child-1', outcome: 'answered' }] }
    const replies = [{ delegationId: DELEGATION, messageId: 'reply-1', text: 'Synthetic finding', truncated: false }]
    await relay.tell(`host:${HOST}:thread-a`, items, replies)
    expect(news).toEqual([{ threadId: 'thread-a', items, replies }])
    await expect(relay.tell(`host:${MAC}:thread-a`, items)).rejects.toThrow()
  })
})

describe('the relay on the wire', () => {
  it('is a desktop-only feature with its own asks, answers and news', () => {
    expect(HOST_FEATURES).toContain('delegation-relay')
    expect(HOST_DESKTOP_FEATURES).toContain('delegation-relay')
    const base = { v: 1, id: 'request', session: 'session' }
    expect(hostRequestSchema.safeParse({ ...base, op: 'delegation-relay-answer', askId: DELEGATION, result: { status: 'ok' } }).success).toBe(true)
    expect(hostRequestSchema.safeParse({ ...base, op: 'delegation-relay-news', threadId: 'thread-a', news: { source: 'delegation', items: [{ delegationId: DELEGATION, threadId: 'child-1', outcome: 'answered' }] } }).success).toBe(true)
    expect(hostPushSchema.safeParse({ v: 1, event: 'delegation-relay-ask', askId: DELEGATION, ask: { type: 'machines' } }).success).toBe(true)
    // A start can name no branch to start from, and carries the asking thread's levels within delegation's own limit.
    expect(hostPushSchema.safeParse({ v: 1, event: 'delegation-relay-ask', askId: DELEGATION, ask: { type: 'start', relayId: DELEGATION, threadId: 't', ...startAsk, levels: 2 } }).success).toBe(false)
  })
})
