// @vitest-environment node
// #1316 part 3 (Owl `cross-machine-work`): Stop on a thread stops what it delegated on other machines too, through the asks
// its delegation already makes there, and a stop it asked for is not news to it. A machine it cannot reach is named.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DelegationService, type DelegationControlHooks, type DelegationCoordinator, type DelegationServiceOptions } from '../../../src/main/agents/delegation'
import { HostDelegationRelay, type RelayDesktop } from '../../../src/main/agents/delegationRelayHost'
import { DesktopRemoteDelegations, type RemoteDelegationConnection } from '../../../src/main/agents/delegationRemoteDesktop'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'
import type { DelegationNews } from '../../../src/shared/delegation'
import type { DelegationRelayAsk, DelegationRemoteAsk, RelayedReply } from '../../../src/shared/delegationRelay'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-stops-unit-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})
const folder = async () => { const root = await mkdtemp(join(tmpdir(), 'sotto-stops-unit-')); roots.push(root); return root }
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const DESKTOP = '22222222-2222-4222-8222-222222222222', MAC = '33333333-3333-4333-8333-333333333333'
const FIRST = '44444444-4444-4444-8444-444444444444', SECOND = '55555555-5555-4555-8555-555555555555', THIRD = '66666666-6666-4666-8666-666666666666'

describe('a host thread\'s Stop through the relay', () => {
  function desktop(relay: HostDelegationRelay, answer: (ask: DelegationRelayAsk) => unknown) {
    const asked: DelegationRelayAsk[] = []
    const handle: RelayDesktop = { clientId: 'desktop-a', push: (askId, ask) => { asked.push(ask); queueMicrotask(() => relay.answered(handle, askId, answer(ask))); return true } }
    return { handle, asked }
  }
  const startAsk = { levels: 0, rootUserMessageId: 'root-1', runtimeMode: 'auto' as const, projectId: 'project-a', machine: DESKTOP, input: { work: 'code-review', brief: 'Review it.' }, waitMs: 0 }

  it('cancels each open delegated thread once on the desktop, and is not told of the stop it asked for', async () => {
    const relay = new HostDelegationRelay(await folder(), { here: () => 'forge' })
    await relay.load()
    const ids = [FIRST, SECOND, THIRD], threads = ['child-1', 'child-1', 'child-2']
    let started = 0
    const { handle, asked } = desktop(relay, ask => ask.type === 'cancel' ? { status: 'ok', delegation: { id: ask.delegation, outcome: 'working' } }
      : { status: 'ok', delegation: { id: ids[started], thread: threads[started++], outcome: started === 3 ? 'answered' : 'working' }, placement: { hostId: DESKTOP, name: 'This computer' } })
    const told: DelegationNews[] = []
    relay.useDelivery(async (_threadId, news) => { told.push(news) })
    relay.desktopConnected(handle)
    for (let index = 0; index < 3; index++) await relay.start('thread-a', 'code-review', startAsk)
    // child-1 has two open delegations, a start and a second brief; child-2 answered already.
    expect(await relay.stopFor('thread-a')).toEqual([])
    expect(asked.filter(ask => ask.type === 'cancel')).toEqual([{ type: 'cancel', threadId: 'thread-a', delegation: SECOND }])
    // Its stop lands: no wake-up for it.
    await relay.news('thread-a', { source: 'delegation', items: [{ delegationId: FIRST, threadId: 'child-1', outcome: 'stopped' }, { delegationId: SECOND, threadId: 'child-1', outcome: 'stopped' }] })
    expect(told).toEqual([])
    // Another thread's delegations are not this one's.
    expect(await relay.stopFor('thread-b')).toEqual([])
  })

  it('names the machine it could not reach while no desktop relays, and stops nothing there', async () => {
    const relay = new HostDelegationRelay(await folder(), { here: () => 'forge' })
    await relay.load()
    const { handle, asked } = desktop(relay, () => ({ status: 'ok', delegation: { id: FIRST, thread: 'child-1', outcome: 'working' }, placement: { hostId: MAC, name: 'the Mac' } }))
    relay.desktopConnected(handle)
    await relay.start('thread-a', 'code-review', startAsk)
    relay.desktopGone(handle)
    expect(await relay.stopFor('thread-a')).toEqual(['the Mac'])
    expect(asked.some(ask => ask.type === 'cancel')).toBe(false)
  })
})

describe('a desktop thread\'s Stop on its paired hosts', () => {
  function host(outcome: () => string) {
    const asked: DelegationRemoteAsk[] = []
    let listener: ((caller: string, news: DelegationNews, replies: readonly RelayedReply[]) => void) | undefined
    let made = 0
    const connection: RemoteDelegationConnection = { hostId: MAC, kind: 'remote', service: { supportsDelegationRemote: true,
      delegationRemoteAsk: async ask => {
        asked.push(ask)
        return ask.type === 'delegate' ? { status: 'ok', delegation: { id: [FIRST, SECOND, THIRD][made++], thread: `child-${made}`, outcome: 'working' } }
          : { status: 'ok', delegation: { id: 'delegation' in ask ? ask.delegation : FIRST, outcome: outcome() } }
      },
      subscribeDelegationRemoteNews: given => { listener = given; return () => undefined } } }
    return { connection, asked, push: (caller: string, news: DelegationNews) => listener!(caller, news, []) }
  }
  const placement = { hostId: MAC, projectId: 'mac-project', receipt: { hostId: MAC, name: 'the Mac', awayFromDefault: false } }
  const ask = { levels: 0, rootUserMessageId: 'root-1', runtimeMode: 'auto' as const, input: { work: 'code-review', brief: 'Review it.' }, waitMs: 0 }

  it('cancels each open one on its host, is not told of the stop it asked for, and names a host that is away', async () => {
    const mac = host(() => 'working')
    const connected = [mac.connection]
    const remote = new DesktopRemoteDelegations(await folder(), { machineName: () => 'the Mac' })
    await remote.load()
    const told: DelegationNews[] = []
    remote.useDelivery(async (_callerId, news) => { told.push(news) })
    remote.useHosts({ subscribeConnected: () => () => undefined, remoteConnections: () => connected })
    await remote.start('parent', 'code-review', placement, ask)
    await remote.start('parent', 'research', placement, ask)
    await remote.start('other', 'research', placement, ask)
    expect(await remote.stopFor('parent')).toEqual([])
    expect(mac.asked.filter(item => item.type === 'cancel').map(item => 'delegation' in item ? item.delegation : undefined).sort()).toEqual([FIRST, SECOND])
    mac.push('parent', { source: 'delegation', items: [{ delegationId: FIRST, threadId: 'child-1', outcome: 'stopped' }] })
    await flush(); await flush()
    expect(told).toEqual([])
    // While the Mac is away, nothing is asked there, and Stop names it.
    connected.splice(0)
    const before = mac.asked.length
    expect(await remote.stopFor('other')).toEqual(['the Mac'])
    expect(mac.asked.length).toBe(before)
  })
})

describe('Stop on a delegating thread', () => {
  it('stops what it and the threads below it delegated on other machines, through the relay and the paired hosts', async () => {
    const root = await folder()
    const parent = { id: 'parent', projectId: 'project', providerId: 'codex', title: 'p', modelId: 'model', status: 'running', messages: [], requests: [] } as unknown as AgentThread
    const snapshot: AgentHostSnapshot = { ...EMPTY_AGENT_HOST, connected: true, threads: [parent] }
    let hooks: DelegationControlHooks | undefined
    const control: DelegationCoordinator = { hostId: () => DESKTOP, watcherSnapshot: () => snapshot, configuration: () => ({}),
      useDelegation: given => { hooks = given; return () => undefined }, commandFromDelegation: async () => ({ host: snapshot }) as never,
      hasPendingThreadWork: () => false, hasUserDraft: () => false, refreshDelegationObservation: () => undefined, deliverWakeUp: async () => undefined }
    const stopped: string[] = []
    const elsewhere = { stopFor: async (threadId: string) => { stopped.push(threadId); return [] }, useDelivery: () => undefined, holds: () => false, holdsThread: () => false, list: () => [], hasOpen: () => false, isOpen: () => false }
    const delegation = new DelegationService({ directory: root, control, host: { setDelegatedBy: async () => undefined, threadMessage: () => undefined }, historyEnabled: () => true,
      relay: elsewhere as unknown as NonNullable<DelegationServiceOptions['relay']>, remote: elsewhere as unknown as NonNullable<DelegationServiceOptions['remote']> })
    await delegation.recover()
    hooks!.userCommand({ type: 'interrupt', threadId: 'parent' }, 'parent', false)
    await expect.poll(() => stopped).toEqual(['parent', 'parent'])
    // A send is not a Stop.
    hooks!.userCommand({ type: 'manual-send', threadId: 'parent', draftId: FIRST, text: 'More.' } as never, 'parent', false)
    await flush()
    expect(stopped).toHaveLength(2)
    delegation.close()
  })
})
