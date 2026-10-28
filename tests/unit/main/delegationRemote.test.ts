// @vitest-environment node
// #1316 part 2 (Owl `cross-machine-work`): the desktop starts delegated threads on its paired hosts, each admitted there by
// that host's own delegation, and a thread on a host may name a third machine, or send a second brief, through the relay.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DelegationService, type DelegationCoordinator, type DelegationServiceOptions } from '../../../src/main/agents/delegation'
import { DesktopDelegationRelay, RELAY_TARGET_AWAY } from '../../../src/main/agents/delegationRelayDesktop'
import { HostDelegationRelay, RELAY_SEND_LATER, type RelayDesktop } from '../../../src/main/agents/delegationRelayHost'
import { HostRemoteCallers, remoteCallerKey, type RemoteDesktop } from '../../../src/main/agents/delegationRemoteHost'
import { DesktopRemoteDelegations, REMOTE_AWAY, REMOTE_LOST_START, type RemoteDelegationConnection } from '../../../src/main/agents/delegationRemoteDesktop'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentModel, type AgentThread } from '../../../src/shared/agents'
import type { DelegationNews } from '../../../src/shared/delegation'
import type { DelegationRelayAsk, DelegationRemoteAsk, RelayedReply } from '../../../src/shared/delegationRelay'
import { hostPushSchema, hostRequestSchema, HOST_DESKTOP_FEATURES, HOST_FEATURES } from '../../../src/shared/hostProtocol'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-remote-unit-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})
const folder = async () => { const root = await mkdtemp(join(tmpdir(), 'sotto-remote-unit-')); roots.push(root); return root }
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const FORGE = '11111111-1111-4111-8111-111111111111', DESKTOP = '22222222-2222-4222-8222-222222222222', MAC = '33333333-3333-4333-8333-333333333333'
const THERE = '44444444-4444-4444-8444-444444444444', RETRY = '55555555-5555-4555-8555-555555555555'
const macPlacement = { hostId: MAC, projectId: 'mac-project', receipt: { hostId: MAC, name: 'the Mac', awayFromDefault: false } }
const askOf = { levels: 0, rootUserMessageId: 'root-1', runtimeMode: 'auto' as const, input: { work: 'code-review', brief: 'Review it.' }, waitMs: 0 }

/** A paired host as the desktop's router holds it, answering each ask as `answer` says and pushing news when told. */
function host(answer: (ask: DelegationRemoteAsk) => unknown | Promise<unknown>) {
  const asked: DelegationRemoteAsk[] = []
  let listener: ((caller: string, news: DelegationNews, replies: readonly RelayedReply[]) => void) | undefined
  const connection: RemoteDelegationConnection = { hostId: MAC, kind: 'remote', service: { supportsDelegationRemote: true,
    delegationRemoteAsk: async ask => { asked.push(ask); return await answer(ask) },
    subscribeDelegationRemoteNews: given => { listener = given; return () => undefined } } }
  return { connection, asked, push: (caller: string, news: DelegationNews, replies: readonly RelayedReply[] = []) => listener!(caller, news, replies) }
}
function hosts(initial: RemoteDelegationConnection[]) {
  const connected = [...initial]
  let listener: ((connection: RemoteDelegationConnection) => void) | undefined
  return { connected, source: { subscribeConnected: (given: (connection: RemoteDelegationConnection) => void) => { listener = given; return () => undefined },
    remoteConnections: () => connected }, connect: (connection: RemoteDelegationConnection) => { connected.push(connection); listener!(connection) } }
}

describe('a desktop\'s delegation on a paired host, on the host', () => {
  it('admits it as its own delegation for the caller keyed by the asking desktop, and sends news only to that desktop', async () => {
    const callers = new HostRemoteCallers(await folder())
    await callers.load()
    const calls: { threadId: string; args: unknown; waitMs?: number | undefined }[] = []
    callers.useDelegation({ delegate: async (threadId, args, context) => { calls.push({ threadId, args, waitMs: context?.waitMs }); return { status: 'ok', delegation: { id: THERE, outcome: 'working' } } },
      read: async (threadId, args) => ({ status: 'ok', threadId, args }), cancel: async () => ({ status: 'ok' }), retriedDelegation: (_, key) => key === RETRY ? THERE : undefined, hasOpen: () => true })
    const key = remoteCallerKey('desktop-a', 'parent-1')
    expect(await callers.answer('desktop-a', { type: 'delegate', caller: 'parent-1', projectId: 'mac-project', ...askOf, input: { ...askOf.input, retry_key: RETRY } }))
      .toMatchObject({ status: 'ok', delegation: { id: THERE } })
    expect(calls).toEqual([{ threadId: key, args: { work: 'code-review', brief: 'Review it.', retry_key: RETRY }, waitMs: 2_000 }])
    expect(callers.caller(key)).toEqual({ id: key, projectId: 'mac-project', runtimeMode: 'auto', levels: 0, rootUserMessageId: 'root-1' })
    // A read after a lost answer finds what it made by the retry key it was asked under.
    expect(await callers.answer('desktop-a', { type: 'read', caller: 'parent-1', retryKey: RETRY })).toMatchObject({ threadId: key, args: { delegation: THERE } })
    // Another desktop naming the same caller is another caller, which this host never admitted.
    expect(await callers.answer('desktop-b', { type: 'cancel', caller: 'parent-1', delegation: THERE })).toMatchObject({ status: 'refused', code: 'UNKNOWN_DELEGATION' })
    const pushed: unknown[] = []
    const desktopA: RemoteDesktop = { clientId: 'desktop-a', push: (caller, news) => { pushed.push({ caller, news }); return true } }
    const news: DelegationNews = { source: 'delegation', items: [{ delegationId: THERE, threadId: 'child', outcome: 'answered' }] }
    await expect(callers.tell(key, news)).rejects.toThrow()
    callers.desktopConnected(desktopA)
    await callers.tell(key, news)
    expect(pushed).toEqual([{ caller: 'parent-1', news }])
    callers.desktopGone(desktopA)
    await expect(callers.tell(key, news)).rejects.toThrow()
    // Kept across a restart, so news after one still finds its caller.
    const again = new HostRemoteCallers(dirname(join(roots[0]!, 'x')))
    await again.load()
    expect(again.caller(key)?.projectId).toBe('mac-project')
  })

  it('never drops a caller while its own admission runs, however many older callers stay open (review)', async () => {
    const callers = new HostRemoteCallers(await folder())
    const seen: boolean[] = [], open = new Set<string>()
    // A caller has a delegation open once its own was admitted; the newest has none yet while it is admitted.
    callers.useDelegation({ delegate: async threadId => { seen.push(callers.caller(threadId) !== undefined); open.add(threadId); return { status: 'ok' } },
      read: async () => ({}), cancel: async () => ({}), retriedDelegation: () => undefined, hasOpen: key => open.has(key) })
    // A thousand older callers, every one with a delegation still open, then one more.
    for (let index = 0; index <= 1_000; index++) await callers.answer('desktop-a', { type: 'delegate', caller: `parent-${index}`, projectId: 'mac-project', ...askOf })
    expect(seen).toHaveLength(1_001)
    expect(seen.every(Boolean)).toBe(true)
  })
})

describe('a delegation on a paired host, on the desktop', () => {
  it('starts it there, names it by its own ID and the thread by the host\'s key, and tells the thread what moved', async () => {
    const mac = host(ask => ask.type === 'delegate' ? { status: 'ok', delegation: { id: THERE, thread: 'child-mac', outcome: 'working' }, warning: 'Busy there.' }
      : { status: 'ok', delegation: { id: THERE, thread: 'child-mac', outcome: 'answered', reply: { from: 'delegated-thread', thread: 'child-mac', messageId: 'r1', text: 'Done.', truncated: false } } })
    const remote = new DesktopRemoteDelegations(await folder(), { machineName: () => 'the Mac' })
    await remote.load()
    const told: { callerId: string; news: DelegationNews; replies: readonly RelayedReply[] }[] = []
    remote.useDelivery(async (callerId, news, replies) => { told.push({ callerId, news, replies }) })
    remote.useHosts(hosts([mac.connection]).source)
    const answer = await remote.start('parent-1', 'code-review', macPlacement, askOf)
    const id = (answer.delegation as { id: string }).id
    expect(answer).toMatchObject({ status: 'ok', delegation: { thread: `host:${MAC}:child-mac` }, placement: { hostId: MAC, name: 'the Mac' }, warning: 'Busy there.' })
    expect(id).not.toBe(THERE)
    // The host is asked under this computer's own retry key, and answers at once: the call waits here, not there.
    expect(mac.asked[0]).toMatchObject({ type: 'delegate', caller: 'parent-1', projectId: 'mac-project', waitMs: 0, input: { retry_key: id, wait_seconds: 0 } })
    expect(remote.holds('parent-1', id)).toBe(true)
    expect(remote.holdsThread('parent-1', `host:${MAC}:child-mac`)).toBe(true)
    expect(remote.holdsThread('parent-2', `host:${MAC}:child-mac`)).toBe(false)
    mac.push('parent-1', { source: 'delegation', items: [{ delegationId: THERE, threadId: 'child-mac', outcome: 'answered' }] },
      [{ delegationId: THERE, messageId: 'r1', text: 'Done.', truncated: false }])
    await expect.poll(() => told.length).toBe(1)
    expect(told[0]).toEqual({ callerId: 'parent-1', news: { source: 'delegation', items: [{ delegationId: id, threadId: `host:${MAC}:child-mac`, outcome: 'answered' }] },
      replies: [{ delegationId: id, messageId: 'r1', text: 'Done.', truncated: false }] })
    expect(remote.detail(id)).toEqual({ reply: { messageId: 'r1', text: 'Done.', truncated: false } })
    expect(await remote.read('parent-1', id)).toMatchObject({ delegation: { id, outcome: 'answered', reply: { thread: `host:${MAC}:child-mac`, text: 'Done.' } } })
    expect(remote.list('parent-1')).toEqual([expect.objectContaining({ id, outcome: 'answered', machine: 'the Mac', action: 'start' })])
  })

  it('waits for the outcome on the host\'s news, never on an open request, and reads it exactly once it moves', async () => {
    let outcome = 'working'
    const mac = host(ask => ({ status: 'ok', delegation: { id: THERE, thread: 'child-mac', outcome: ask.type === 'read' ? outcome : 'working' } }))
    const remote = new DesktopRemoteDelegations(await folder(), { machineName: () => 'the Mac' })
    remote.useDelivery(async () => undefined)
    remote.useHosts(hosts([mac.connection]).source)
    const waiting = remote.start('parent-1', 'code-review', macPlacement, { ...askOf, waitMs: 60_000 })
    await expect.poll(() => mac.asked.length).toBe(1)
    outcome = 'failed'
    mac.push('parent-1', { source: 'delegation', items: [{ delegationId: THERE, threadId: 'child-mac', outcome: 'failed' }] })
    expect(await waiting).toMatchObject({ status: 'ok', delegation: { outcome: 'failed' }, placement: { name: 'the Mac' } })
    expect(mac.asked.map(ask => ask.type)).toEqual(['delegate', 'read'])
  })

  it('counts a start whose answer was lost, sends nothing again, and reads it exactly when the host is back', async () => {
    let lose = true
    const mac = host(() => { if (lose) throw new Error('The socket closed.'); return { status: 'ok', delegation: { id: THERE, thread: 'child-mac', outcome: 'answered' } } })
    const root = await folder()
    const remote = new DesktopRemoteDelegations(root, { machineName: () => 'the Mac' })
    const told: DelegationNews[] = []
    remote.useDelivery(async (_, news) => { told.push(news) })
    const router = hosts([mac.connection])
    remote.useHosts(router.source)
    const lost = await remote.start('parent-1', 'code-review', macPlacement, askOf)
    const id = (lost.delegation as { id: string }).id
    expect(lost).toMatchObject({ status: 'ok', delegation: { outcome: 'unknown', note: REMOTE_LOST_START('the Mac') } })
    expect(mac.asked).toHaveLength(1)
    // A restart keeps it; the host connects again and it is read by the retry key it was asked under.
    const again = new DesktopRemoteDelegations(root, { machineName: () => 'the Mac' })
    await again.load()
    again.useDelivery(async (_, news) => { told.push(news) })
    lose = false
    const back = hosts([])
    again.useHosts(back.source)
    back.connect(mac.connection)
    await expect.poll(() => told.length).toBe(1)
    expect(mac.asked[1]).toEqual({ type: 'read', caller: 'parent-1', retryKey: id })
    expect(told[0]!.items).toEqual([{ delegationId: id, threadId: `host:${MAC}:child-mac`, outcome: 'answered' }])
    // Nothing was asked to start again.
    expect(mac.asked.filter(ask => ask.type === 'delegate')).toHaveLength(1)
  })

  it('reads a lost start again when news names a delegation it never learned, without asking for it again (review)', async () => {
    let phase: 'lost' | 'admitting' | 'started' = 'lost'
    const mac = host(ask => {
      if (ask.type === 'delegate') throw new Error('The socket closed.')
      return phase === 'admitting' ? { status: 'refused', code: 'UNKNOWN_DELEGATION', message: 'None.' }
        : { status: 'ok', delegation: { id: THERE, thread: 'child-mac', outcome: 'answered' } }
    })
    const remote = new DesktopRemoteDelegations(await folder(), { machineName: () => 'the Mac' })
    const told: DelegationNews[] = []
    remote.useDelivery(async (_, news) => { told.push(news) })
    const router = hosts([])
    remote.useHosts(router.source)
    router.connected.push(mac.connection)
    const lost = await remote.start('parent-1', 'code-review', macPlacement, askOf)
    const id = (lost.delegation as { id: string }).id
    // The Mac reconnects while it is still admitting the start: the read by retry key finds nothing yet.
    phase = 'admitting'
    router.connected.length = 0
    router.connect(mac.connection)
    await expect.poll(() => mac.asked.filter(ask => ask.type === 'read').length).toBe(1)
    await flush()
    expect(told).toEqual([])
    // The start lands after all, and its news names the Mac's own ID, which this computer never learned.
    phase = 'started'
    mac.push('parent-1', { source: 'delegation', items: [{ delegationId: THERE, threadId: 'child-mac', outcome: 'answered' }] })
    await expect.poll(() => told.length).toBe(1)
    expect(told[0]!.items).toEqual([{ delegationId: id, threadId: `host:${MAC}:child-mac`, outcome: 'answered' }])
    expect(mac.asked.filter(ask => ask.type === 'delegate')).toHaveLength(1)
  })

  it('refuses while the host is away, starts nothing, and reads what it last read', async () => {
    const remote = new DesktopRemoteDelegations(await folder(), { machineName: () => 'the Mac' })
    remote.useHosts(hosts([]).source)
    await expect(remote.start('parent-1', 'code-review', macPlacement, askOf)).rejects.toThrow()
    expect(remote.list('parent-1')).toEqual([])
  })

  it('sends a second brief to the thread on its host, and refuses one while that host is away', async () => {
    const mac = host(ask => ({ status: 'ok', delegation: { id: ask.type === 'delegate' && 'thread' in ask.input ? RETRY : THERE, thread: 'child-mac', outcome: 'working' } }))
    const remote = new DesktopRemoteDelegations(await folder(), { machineName: () => 'the Mac' })
    remote.useDelivery(async () => undefined)
    const router = hosts([mac.connection])
    remote.useHosts(router.source)
    await remote.start('parent-1', 'code-review', macPlacement, askOf)
    const sent = await remote.send('parent-1', 'code-review', `host:${MAC}:child-mac`, askOf)
    expect(mac.asked[1]).toMatchObject({ type: 'delegate', projectId: 'mac-project', input: { thread: 'child-mac' } })
    expect(sent).toMatchObject({ status: 'ok', delegation: { thread: `host:${MAC}:child-mac` } })
    expect(remote.list('parent-1').map(item => item.action)).toEqual(['start', 'send'])
    router.connected.length = 0
    expect(await remote.send('parent-1', 'code-review', `host:${MAC}:child-mac`, askOf)).toMatchObject({ status: 'refused', message: expect.stringContaining('The Mac isn\'t connected to This computer') })
  })
})

describe('the desktop\'s delegation reaching a paired host', () => {
  const model = { id: 'model', name: 'Model', providerId: 'codex', ready: true, reasoningEfforts: [], runtimeModes: ['approval-required', 'auto', 'full-access'] } as unknown as AgentModel
  async function service(options: Partial<DelegationServiceOptions>) {
    const root = await folder()
    const thread = { id: 'parent', projectId: 'project', providerId: 'codex', title: 'p', modelId: 'model', status: 'idle', runtimeMode: 'full-access',
      messages: [{ id: 'parent-ask', role: 'user', text: 'Do it.' }], requests: [] } as unknown as AgentThread
    const snapshot: AgentHostSnapshot = { ...EMPTY_AGENT_HOST, connected: true, models: [model], projects: [{ id: 'project', title: 'Project', path: join(root, 'project') }] as never, threads: [thread] }
    const created: unknown[] = []
    const control: DelegationCoordinator = { hostId: () => DESKTOP, watcherSnapshot: () => snapshot, configuration: () => ({ newThreadRuntimeMode: 'auto' }),
      useDelegation: () => () => undefined, commandFromDelegation: async command => { created.push(command); return { host: snapshot } as never },
      hasPendingThreadWork: () => false, hasUserDraft: () => false, refreshDelegationObservation: () => undefined, deliverWakeUp: async () => undefined }
    const delegation = new DelegationService({ directory: root, control, host: { setDelegatedBy: async () => undefined, threadMessage: () => undefined }, historyEnabled: () => true,
      machines: { list: async () => ({}), name: () => 'the Mac', setting: () => 'this-computer', place: async ask => ask.machine === MAC ? macPlacement
        : { status: 'refused', code: 'HOST_DISCONNECTED', message: 'The Mac is not connected.', retryable: true } }, ...options })
    await delegation.recover()
    return { delegation, created }
  }
  const remoteOf = (answer: Record<string, unknown>) => {
    const calls: { kind: string; callerId: string; ask: unknown }[] = []
    const remote = { start: async (callerId: string, _work: string, _placement: unknown, ask: unknown) => { calls.push({ kind: 'start', callerId, ask }); return answer },
      send: async (callerId: string, _work: string, thread: string, ask: unknown) => { calls.push({ kind: 'send', callerId, ask: { thread, ask } }); return answer },
      holds: () => false, holdsThread: (_: string, thread: string) => thread === `host:${MAC}:child-mac`, read: async () => ({}), cancel: async () => ({}), list: () => [],
      useDelivery: () => undefined, detail: () => undefined, retried: () => undefined, isOpen: () => false, hasOpen: () => false } as unknown as NonNullable<DelegationServiceOptions['remote']>
    return { remote, calls }
  }
  const start = { work: 'code-review', brief: 'Review it.', provider: 'codex', model: 'model', permission: 'auto', wait_seconds: 0 }

  it('starts on the machine it names through that machine\'s host, held to this computer\'s new-thread default, creating nothing here', async () => {
    const r = remoteOf({ status: 'ok', delegation: { id: THERE, outcome: 'working' } })
    const f = await service({ remote: r.remote })
    expect(await f.delegation.delegate('parent', { ...start, machine: MAC, retry_key: RETRY })).toMatchObject({ status: 'ok' })
    expect(r.calls).toEqual([{ kind: 'start', callerId: 'parent', ask: expect.objectContaining({ levels: 0, rootUserMessageId: 'parent-ask', runtimeMode: 'auto', retryKey: RETRY,
      input: expect.not.objectContaining({ machine: MAC, retry_key: RETRY }) }) }])
    expect(f.created).toEqual([])
    // A branch to start from on another machine comes later, and is refused before anything is asked.
    expect(await f.delegation.delegate('parent', { ...start, machine: MAC, from_my_branch: true })).toMatchObject({ status: 'refused', code: 'BRANCH_UNAVAILABLE' })
    // A second brief to the thread there goes to its host.
    await f.delegation.delegate('parent', { work: 'code-review', brief: 'Again.', thread: `host:${MAC}:child-mac` })
    expect(r.calls[1]).toMatchObject({ kind: 'send', callerId: 'parent', ask: { thread: `host:${MAC}:child-mac` } })
  })

  it('records the host\'s refusal as its own, and a host that went away by name', async () => {
    const r = remoteOf({ status: 'refused', code: 'PROMPT_LIMIT', message: 'Four briefs there. Nothing was sent.' })
    const f = await service({ remote: r.remote })
    expect(await f.delegation.delegate('parent', { ...start, machine: MAC })).toMatchObject({ status: 'refused', code: 'PROMPT_LIMIT', delegation: expect.any(String) })
    const away = remoteOf({})
    away.remote.start = async () => { const { RelayUnanswered } = await import('../../../src/main/agents/delegationRelayHost'); throw new RelayUnanswered('away') }
    const g = await service({ remote: away.remote })
    expect(await g.delegation.delegate('parent', { ...start, machine: MAC })).toMatchObject({ status: 'refused', code: 'MACHINE_UNAVAILABLE', message: REMOTE_AWAY('the Mac') })
  })

  it('reads a retried start on a paired host from that host, and never starts it here or there again (review)', async () => {
    const mac = host(() => ({ status: 'ok', delegation: { id: THERE, thread: 'child-mac', outcome: 'working' } }))
    const remote = new DesktopRemoteDelegations(await folder(), { machineName: () => 'the Mac' })
    remote.useDelivery(async () => undefined)
    remote.useHosts(hosts([mac.connection]).source)
    const f = await service({ remote })
    const first = await f.delegation.delegate('parent', { ...start, machine: MAC, retry_key: RETRY }) as { delegation: { id: string } }
    const again = await f.delegation.delegate('parent', { ...start, machine: MAC, retry_key: RETRY }) as { delegation: { id: string } }
    expect(again.delegation.id).toBe(first.delegation.id)
    expect(mac.asked.map(ask => ask.type)).toEqual(['delegate', 'read'])
    expect(f.created).toEqual([])
  })
})

describe('the relay to a third machine', () => {
  const placement = (to: { hostId: string; projectId: string; receipt: { hostId: string; name: string; awayFromDefault: boolean } } | 'away') => ({
    machines: async () => ({}), machineName: (id: string) => id === FORGE ? 'forge' : id === MAC ? 'the Mac' : undefined,
    placement: async () => to === 'away' ? { status: 'refused' as const, code: 'HOST_DISCONNECTED' as const, message: 'The Mac is not connected.', retryable: true } : to,
  })
  const ask = (extra: Record<string, unknown> = {}): DelegationRelayAsk => ({ type: 'start', relayId: RETRY, threadId: 'thread-a', levels: 0, rootUserMessageId: 'root-1',
    runtimeMode: 'auto', projectId: 'forge-project', machine: MAC, input: { work: 'code-review', brief: 'Review it.' }, waitMs: 1_000, ...extra } as DelegationRelayAsk)

  it('starts on a paired host where the desktop placed it, and names a machine it is not connected to', async () => {
    const calls: unknown[] = []
    const delegation = { delegate: async (threadId: string, args: unknown, context?: unknown) => { calls.push({ threadId, args, context }); return { status: 'ok', delegation: { id: THERE, outcome: 'working' } } },
      read: async () => ({}), cancel: async () => ({}), retriedDelegation: () => undefined, isOpen: () => true, hasOpen: () => true }
    const relay = new DesktopDelegationRelay(await folder(), { placement: placement(macPlacement), localHostId: () => DESKTOP, elsewhere: true })
    relay.useDelegation(delegation)
    expect(await relay.answer(FORGE, ask())).toMatchObject({ status: 'ok' })
    expect(calls).toEqual([{ threadId: `host:${FORGE}:thread-a`, args: { work: 'code-review', brief: 'Review it.', retry_key: RETRY }, context: { waitMs: 3_000, placement: macPlacement } }])
    const away = new DesktopDelegationRelay(await folder(), { placement: placement('away'), localHostId: () => DESKTOP, elsewhere: true })
    away.useDelegation(delegation)
    expect(await away.answer(FORGE, ask())).toEqual({ status: 'refused', code: 'MACHINE_UNAVAILABLE', message: RELAY_TARGET_AWAY('the Mac', 'forge') })
    expect(calls).toHaveLength(1)
  })

  it('carries a second brief as the caller\'s own, charged on this computer, with no placement', async () => {
    const calls: unknown[] = []
    const delegation = { delegate: async (threadId: string, args: unknown, context?: unknown) => { calls.push({ threadId, args, context }); return { status: 'ok', delegation: { id: THERE, outcome: 'working' } } },
      read: async () => ({}), cancel: async () => ({}), retriedDelegation: () => undefined, isOpen: () => true, hasOpen: () => true }
    const relay = new DesktopDelegationRelay(await folder(), { placement: placement(macPlacement), localHostId: () => DESKTOP, elsewhere: true })
    relay.useDelegation(delegation)
    await relay.answer(FORGE, { type: 'send', relayId: RETRY, threadId: 'thread-a', levels: 0, rootUserMessageId: 'root-2', runtimeMode: 'auto', projectId: 'forge-project',
      input: { work: 'code-review', brief: 'Again.', thread: `host:${MAC}:child-mac` }, waitMs: 1_000 })
    expect(calls).toEqual([{ threadId: `host:${FORGE}:thread-a`, args: { work: 'code-review', brief: 'Again.', thread: `host:${MAC}:child-mac`, retry_key: RETRY }, context: { waitMs: 3_000 } }])
    expect(relay.caller(`host:${FORGE}:thread-a`)?.rootUserMessageId).toBe('root-2')
  })

  it('pushes a second brief only to a desktop that takes them, and says so to one that does not', async () => {
    const relay = new HostDelegationRelay(await folder(), { here: () => 'forge' })
    await relay.load()
    const asked: DelegationRelayAsk[] = []
    const old: RelayDesktop = { clientId: 'old', push: () => true }
    relay.desktopConnected(old)
    const sendAsk = { levels: 0, rootUserMessageId: 'root-2', runtimeMode: 'auto' as const, projectId: 'forge-project', input: { work: 'code-review', brief: 'Again.' }, waitMs: 1_000 }
    expect(await relay.send('thread-a', 'code-review', 'child-1', sendAsk)).toEqual({ status: 'refused', code: 'UNKNOWN_THREAD', message: RELAY_SEND_LATER })
    relay.desktopGone(old)
    const handle: RelayDesktop = { clientId: 'new', sends: true, push: (askId, given) => { asked.push(given); queueMicrotask(() => relay.answered(handle, askId,
      { status: 'ok', delegation: { id: THERE, thread: 'child-1', outcome: 'working' } })); return true } }
    relay.desktopConnected(handle)
    await flush()
    expect(await relay.send('thread-a', 'code-review', 'child-1', sendAsk)).toMatchObject({ status: 'ok' })
    expect(asked.at(-1)).toMatchObject({ type: 'send', threadId: 'thread-a', input: { thread: 'child-1' } })
    expect(relay.list('thread-a')).toEqual([expect.objectContaining({ id: THERE, action: 'send', thread: 'child-1' })])
  })
})

describe('on the wire', () => {
  it('is a pair of desktop-only features with their own ask and news', () => {
    for (const feature of ['delegation-relay-send', 'delegation-remote'] as const) {
      expect(HOST_FEATURES).toContain(feature)
      expect(HOST_DESKTOP_FEATURES).toContain(feature)
    }
    const base = { v: 1, id: 'request', session: 'session' }
    expect(hostRequestSchema.safeParse({ ...base, op: 'delegation-remote-ask', ask: { type: 'read', caller: 'parent-1', delegation: THERE } }).success).toBe(true)
    // The desktop's word on depth stays within delegation's own limit, and an ask names no machine or branch of its own.
    expect(hostRequestSchema.safeParse({ ...base, op: 'delegation-remote-ask', ask: { type: 'delegate', caller: 'p', projectId: 'x', ...askOf, levels: 2 } }).success).toBe(false)
    expect(hostRequestSchema.safeParse({ ...base, op: 'delegation-remote-ask', ask: { type: 'delegate', caller: 'p', projectId: 'x', ...askOf, machine: MAC } }).success).toBe(false)
    expect(hostPushSchema.safeParse({ v: 1, event: 'delegation-remote-news', caller: 'parent-1', news: { source: 'delegation', items: [{ delegationId: THERE, threadId: 'c', outcome: 'answered' }] } }).success).toBe(true)
    expect(hostPushSchema.safeParse({ v: 1, event: 'delegation-relay-ask', askId: THERE, ask: { type: 'send', relayId: THERE, threadId: 't', levels: 0, rootUserMessageId: 'r', runtimeMode: 'auto',
      projectId: 'p', input: { thread: 'c' }, waitMs: 0 } }).success).toBe(true)
  })
})
