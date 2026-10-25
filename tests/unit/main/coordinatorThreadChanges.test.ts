// @vitest-environment node
/**
 * The coordinator's side of thread changes (ADR-0016, #925, step 5). The coordinator takes the workspace's thread changes
 * in: an ordinary change shows, tracks and lists again only the threads it names, and every other thread keeps the record
 * it was shown as. These hold that to the whole path it replaces: a coordinator that takes every publication in whole,
 * as every coordinator did before, over the same workspace, says byte for byte what the one that takes in changes says,
 * across a long seeded run of mixed operations. What is compared after each operation is everything downstream of the
 * coordinator: its host snapshot, its broadcast to the window and the phone, each thread's detail, the router's state for
 * the window, and the shell a paired phone is sent over the host socket.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentRequest, type AgentState, type AgentThread, type AgentThreadDetail } from '../../../src/shared/agents'
import { applyAgentThreadDetailDelta, isAgentThreadDetailDelta } from '../../../src/shared/agentThreadDetail'
import type { HeldProviders } from '../../../src/shared/heldProviders'
import type { AgentControl } from '../../../src/main/agents/control'
import { LocalHostService } from '../../../src/main/agents/hostService'
import { PairedClients } from '../../../src/main/agents/pairing'
import { ConfiguredProviderHost } from '../../../src/main/agents/providerSwitch'
import { SOTTO_REQUEST_PREFIX, type SottoThreadRequests } from '../../../src/main/agents/sottoRequests'
import { ThreadChangesDrift, type ThreadMap } from '../../../src/main/agents/threadChanges'
import { SottoThreadHost, ThreadRegistry } from '../../../src/main/agents/threads'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { startSocketServer } from '../../../src/host/socketServer'
import { DesktopHostRouter } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { createAgentControl, type TestControlOptions } from '../../fixtures/agentControlFixture'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import { rawPeer } from '../../fixtures/rawHostPeer'
import { StreamingAdapter } from '../../fixtures/streamingAdapter'
import { testCredentials } from '../../fixtures/testCredentials'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close() })

const AT = '2026-10-25T12:00:00.000Z'
const thread = (id: string, fields: Partial<AgentThread> = {}): AgentThread => ({ id, projectId: 'project', title: `Thread ${id}`, modelId: 'fake:model',
  status: 'idle', messages: [], requests: [], ...fields })
const record = (id: string, sequence: number, status: AgentActivity['status'] = 'completed'): AgentActivity =>
  ({ id, turnId: 'turn', sequence, kind: 'tool', status, title: 'Tool', output: `Output ${id}` })
const quiet = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 60))

function providerState(root: string, sessions: readonly string[]): AgentHostSnapshot {
  return { ...structuredClone(EMPTY_AGENT_HOST), name: 'Synthetic', version: '1', connected: true,
    capabilities: { ...EMPTY_AGENT_HOST.capabilities, projects: true, threads: true, submit: true, observe: true },
    projects: [{ id: 'project', title: 'Synthetic project', path: join(root, 'project') }],
    models: [{ id: 'fake:model', provider: 'Fake', name: 'Synthetic model', ready: true }],
    threads: sessions.map(id => thread(id)) }
}

/** Sotto's own requests, as the host setup thread's are, set and cleared by the test. */
function sottoRequests() {
  const pending = new Map<string, readonly AgentRequest[]>()
  const listeners = new Set<() => void>()
  const requests: SottoThreadRequests = {
    requests: () => pending,
    answer: () => undefined,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  return { requests, pending,
    toggle(threadId: string): void {
      if (pending.has(threadId)) pending.delete(threadId)
      else pending.set(threadId, [{ id: `${SOTTO_REQUEST_PREFIX}add-host`, kind: 'permission', text: 'Add forge as a host?', options: [] } as unknown as AgentRequest])
      for (const listener of listeners) listener()
    } }
}

/** What one coordinator hands on downstream, as each subscriber last received it. */
interface Downstream {
  readonly control: AgentControl
  readonly requests: ReturnType<typeof sottoRequests>
  readonly router: DesktopHostRouter
  broadcast: AgentState | undefined
  window: AgentState | undefined
  /** Each thread's history as a window holds it, from the whole details and deltas it was sent. */
  readonly details: Map<string, AgentThreadDetail>
  readonly targets: () => string[]
  readonly phone: () => Record<string, unknown> | undefined
}

/**
 * The adapter, the identity wrapper, the provider switch and one workspace, as main wires them, with two coordinators
 * over the workspace: the first takes its thread changes in, the second every publication whole. Each has its own
 * folder, its own host service and router for the window, and a phone paired over its own host socket.
 */
async function stack(control: TestControlOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-coordinator-changes-'))
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }))
  await mkdir(join(root, 'project'), { recursive: true })
  const registry = new ThreadRegistry(join(root, 'registry'))
  await registry.load()
  cleanup.push(async () => { await registry.flush().catch(() => undefined) })
  const sessions = ['s1', 's2', 's3', 's4', 's5', 's6']
  const adapter = new StreamingAdapter(providerState(root, sessions))
  const native = new ConfiguredProviderHost({ directory: join(root, 'switch'), provider: () => 'claude', enabledProviders: () => ['claude'], threadProvider: id => registry.byThread(id)?.provider,
    hosts: { claude: new SottoThreadHost('claude', adapter, registry), codex: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost(),
      muse: new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)), opencode: new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)), cursor: new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)) } })
  await mkdir(join(root, 'workspace'), { recursive: true })
  const workspace = new WorkspaceHost(native, join(root, 'workspace'), () => true, 600_000)
  cleanup.push(async () => { workspace.disconnect(); await workspace.privacyChanged().catch(() => undefined); workspace.dispose() })
  await workspace.initialize()
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  const made: Downstream[] = []
  for (const name of ['changed', 'whole'] as const) {
    const directory = join(root, name)
    await mkdir(directory, { recursive: true })
    const coordinator = createAgentControl({ directory, host: workspace, credentials, ...control })
    if (name === 'whole') (coordinator as unknown as { acceptsWhole: boolean }).acceptsWhole = true
    const requests = sottoRequests()
    coordinator.useSottoRequests(requests.requests)
    await coordinator.start()
    cleanup.push(() => coordinator.dispose())
    const service = new LocalHostService({ control: coordinator })
    const router = new DesktopHostRouter(() => emptyDesktopState(coordinator.hostId()), { watcherEnabled: control.watcherEnabled ?? true, ...(control.heldProviders ? { heldProviders: control.heldProviders } : {}) })
    cleanup.push(() => router.dispose())
    router.add({ hostId: coordinator.hostId()!, name: 'This computer', kind: 'local', service, detail: id => coordinator.threadDetail(id),
      preview: request => coordinator.attachmentPreview(request), subscribeDetail: listener => coordinator.subscribeThreadDetail(listener) })
    // Both phones are paired with the same client ID, so what each is sent can be compared byte for byte.
    let ids = 0
    const pairing = new PairedClients(join(directory, 'pairing'), { createId: () => `00000000-0000-4000-8000-${(++ids).toString(16).padStart(12, '0')}` })
    await pairing.load()
    const server = await startSocketServer({ service, pairing })
    cleanup.push(() => server.close())
    const paired = await pairing.redeem(pairing.issuePairingCode().code, 'Phone')
    const peer = await rawPeer(server.descriptor.port, pairing.signSession(paired.clientId))
    cleanup.push(() => peer.frames.close())
    await peer.call('hello', { op: 'hello' })
    const seen: Downstream = { control: coordinator, requests, router, broadcast: undefined, window: undefined, details: new Map(),
      targets: () => (coordinator as unknown as { detailTargets(): string[] }).detailTargets(),
      phone: () => peer.messages.filter(message => message.event === 'shell').at(-1) as Record<string, unknown> | undefined }
    coordinator.subscribe(state => { seen.broadcast = state })
    router.subscribe(state => { seen.window = state })
    coordinator.subscribeThreadDetail(update => {
      if (!isAgentThreadDetailDelta(update)) { seen.details.set(update.threadId, update); return }
      const held = seen.details.get(update.threadId)
      const next = held && applyAgentThreadDetailDelta(held, update)
      if (next) seen.details.set(update.threadId, next); else seen.details.delete(update.threadId)
    })
    made.push(seen)
  }
  const [changed, whole] = made as [Downstream, Downstream]
  const sotto = (session: string): string => registry.bySession('claude', session)!.threadId
  return { root, registry, adapter, workspace, changed, whole, sessions, sotto }
}

/**
 * The JSON of `value` with each failure's name, which each coordinator makes afresh with a random ID, given in the order
 * it first appears: the same failures, named the same way, read the same.
 */
function text(value: unknown): string {
  const names = new Map<string, string>()
  return JSON.stringify(value ?? null).replace(/"failureId":"([^"]+)"/gu, (_whole, id: string) => {
    if (!names.has(id)) names.set(id, `failure-${names.size}`)
    return `"failureId":"${names.get(id)}"`
  })
}

/** The seeded run, with every operation family once in a fixed order first and then a seeded mix of them. */
async function equivalenceRun(control: TestControlOptions, seed: number) {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) })
  const { adapter, workspace, changed, whole, sessions, sotto } = await stack(control)
  const both = [changed, whole]
  // The changes path takes most publications in as changes; the whole path never subscribes to them.
  const taken = vi.spyOn(changed.control as unknown as { acceptChanges(map: ThreadMap, changes: unknown): void }, 'acceptChanges')
  const patched = vi.spyOn(changed.control as unknown as { patchHostThreads(...args: unknown[]): unknown }, 'patchHostThreads')
  const takenWhole = vi.spyOn(whole.control as unknown as { acceptChanges(map: ThreadMap, changes: unknown): void }, 'acceptChanges')
  const settle = async (): Promise<void> => { await quiet(); await workspace.flush(); await quiet() }
  let compared = 0
  const same = async (step: string): Promise<void> => {
    await settle()
    compared++
    expect(text(changed.control.watcherSnapshot()), `the coordinator's host snapshot after ${step}`).toBe(text(whole.control.watcherSnapshot()))
    expect(text(changed.broadcast), `the coordinator's last broadcast after ${step}`).toBe(text(whole.broadcast))
    expect(text(changed.control.broadcastShell()), `the coordinator's broadcast shell after ${step}`).toBe(text(whole.control.broadcastShell()))
    expect(text(changed.window), `the window's state from the router after ${step}`).toBe(text(whole.window))
    // What a window holds of each thread it looks at, without the revisions: each coordinator is told of a command a moment
    // apart, so one may send a revision the other never needed, but what the window holds is the same.
    const targets = changed.targets()
    expect(targets, `the threads a window looks at after ${step}`).toEqual(whole.targets())
    const held = (seen: Downstream) => targets.map(id => { const detail = seen.details.get(id); return detail && { messages: detail.messages, activities: detail.activities } })
    expect(text(held(changed)), `each shown thread's history after ${step}`).toBe(text(held(whole)))
    await expect.poll(() => text(changed.phone()?.state), { message: `the phone's shell over the host socket after ${step}` }).toBe(text(whole.phone()?.state))
  }
  const at = (session: string) => adapter.state.threads.find(item => item.id === session)!
  const publish = async (...marked: string[]): Promise<void> => { for (const session of marked) adapter.mark(session); adapter.publish(false) }
  for (const each of both) await each.control.command({ type: 'connect' })
  await publish('s1')
  await same('connecting')
  // mulberry32: whole 32-bit integers throughout, so every operation family is reachable.
  const next = (below: number): number => {
    seed = (seed + 0x6d2b79f5) | 0
    let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) % below
  }
  let made = 0
  const messages = new Map<string, string>()
  const families: readonly ((session: string, round: number) => Promise<void>)[] = [
    async (session) => { at(session).status = at(session).status === 'running' ? 'idle' : 'running'; await publish(session); await same(`turning ${session} ${at(session).status}`) },
    async (session, round) => { const id = `m-${round}`; messages.set(session, id); adapter.log.add(session, { id, role: round % 2 ? 'assistant' : 'user', text: `Message ${round}`, createdAt: AT }); await publish(); await same(`a message in ${session}`) },
    async (session, round) => { const list = at(session).activities ?? []; at(session).activities = [...list, record(`r-${round}`, list.length, round % 3 ? 'completed' : 'running')]; await publish(session); await same(`a record in ${session}`) },
    async (session, round) => { at(session).title = `Provider ${round}`; await publish(session); await same(`the provider renaming ${session}`) },
    async (session, round) => { await workspace.renameThread(sotto(session), `User ${round}`); await same(`the user renaming ${session}`) },
    async (session, round) => { await workspace.setWorkspaceSettled('thread', sotto(session), round % 2 === 0); await same(`settling ${session}`) },
    async (session) => { at(session).status = at(session).status === 'error' ? 'idle' : 'error'; await publish(session); await same(`${session} failing or resting`) },
    async () => { const shown = sessions.filter(() => next(2) === 0).map(sotto); for (const each of both) each.control.showThreads(shown); await same('a client showing other threads') },
    async () => {
      // Each coordinator names its own failures; the user dismisses all of them on each.
      for (const each of both) {
        const failures = each.control.broadcastShell().host.threads.flatMap(item => item.failureId && !item.failureSeen ? [{ threadId: item.id, failure: item.failureId }] : [])
        await each.control.command({ type: 'dismiss-failures', failures })
      }
      await same('Dismiss all')
    },
    async (session) => { adapter.state.threads.splice(adapter.state.threads.indexOf(at(session)), 1); sessions.splice(sessions.indexOf(session), 1); await publish(session); await same(`the provider dropping ${session}`) },
    async () => { const id = `n${made++}`; adapter.state.threads.push(thread(id)); sessions.push(id); await publish(id); await same(`the provider starting ${id}`) },
    async (session, round) => { at(session).requests = at(session).requests.length ? [] : [{ id: `q-${round}`, kind: 'question', text: 'Which?', options: [] } as unknown as AgentRequest]; await publish(session); await same(`a question in ${session}`) },
    async (session) => { at(session).archivedAt = at(session).archivedAt ? undefined : AT; await publish(session); await same(`archiving ${session}`) },
    async (session) => { for (const each of both) each.requests.toggle(sotto(session)); await same(`a request of Sotto's own in ${session}`) },
    async (session, round) => {
      const id = messages.get(session)
      if (id) adapter.log.appendText(session, id, ` more ${round}`)
      else { messages.set(session, `m-${round}`); adapter.log.add(session, { id: `m-${round}`, role: 'assistant', text: `Streamed ${round}`, createdAt: AT }) }
      await publish(); await same(`a streamed reply in ${session}`)
    },
    async (session) => { for (const each of both) await each.control.command({ type: 'select-thread', threadId: sotto(session) }); await same(`selecting ${session}`) },
  ]
  const ran = new Map<number, number>()
  const order = [...families.keys(), ...Array.from({ length: 110 }, () => next(families.length))]
  for (const [round, family] of order.entries()) {
    // A thread is dropped only while more than three remain.
    if (family === 9 && sessions.length <= 3) continue
    const session = sessions[next(sessions.length)]!
    await families[family]!(session, round)
    ran.set(family, (ran.get(family) ?? 0) + 1)
  }
  expect([...ran.keys()].sort((left, right) => left - right), 'every operation family ran').toEqual([...families.keys()])
  expect(compared).toBeGreaterThan(80)
  expect(taken.mock.calls.length).toBeGreaterThan(40)
  // Most changes are taken in as changes, not in whole.
  expect(patched.mock.calls.length).toBeGreaterThan(20)
  expect(takenWhole).not.toHaveBeenCalled()
}

describe('the coordinator taking in changes and taking in everything', () => {
  it('hands on the same as the whole path across a long run of mixed operations, on Owl', async () => {
    await equivalenceRun({ watcherEnabled: true }, 925)
  }, 120_000)

  it('hands on the same as the whole path with providers held and threads that begin from others, as on stable', async () => {
    await equivalenceRun({ watcherEnabled: false, threadStartsEnabled: true, heldProviders: new Set(['muse', 'opencode', 'cursor']) as HeldProviders }, 1334)
  }, 120_000)
})

describe('the coordinator\'s thread changes', () => {
  it('shows, tracks and lists again only the thread a change names', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) })
    const { adapter, changed } = await stack()
    await changed.control.command({ type: 'connect' })
    adapter.publish(false); await quiet()
    const shown = vi.spyOn(changed.control as unknown as { shownSnapshot(snapshot: AgentHostSnapshot, gone?: Set<string>): AgentHostSnapshot }, 'shownSnapshot')
    const before = changed.control.watcherSnapshot().threads
    adapter.state.threads.find(item => item.id === 's2')!.status = 'running'; adapter.mark('s2'); adapter.publish(false); await quiet()
    const partial = shown.mock.calls.filter(([, gone]) => gone !== undefined)
    expect(partial.length).toBeGreaterThan(0)
    expect(partial.every(([snapshot]) => snapshot.threads.length === 1)).toBe(true)
    const after = changed.control.watcherSnapshot().threads
    // Every other thread is the very record it was shown as.
    expect(after.filter((item, index) => item !== before[index]).map(item => item.title)).toEqual(['Thread s2'])
  })

  it('takes the first change after anything else set the host snapshot in whole', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) })
    const { adapter, changed } = await stack()
    await changed.control.command({ type: 'connect' })
    adapter.publish(false); await quiet()
    const whole = vi.spyOn(changed.control as unknown as { acceptSnapshot(snapshot: AgentHostSnapshot, fromChanges?: boolean): void }, 'acceptSnapshot')
    // A read the coordinator makes for a command is taken whole and may say what the publication has not.
    const inside = changed.control as unknown as { acceptSnapshot(snapshot: AgentHostSnapshot): void; state: { host: AgentHostSnapshot } }
    inside.acceptSnapshot({ ...inside.state.host })
    whole.mockClear()
    adapter.state.threads.find(item => item.id === 's3')!.status = 'running'; adapter.mark('s3'); adapter.publish(false); await quiet()
    expect(whole.mock.calls.some(([, fromChanges]) => fromChanges === true)).toBe(true)
  })

  it('finds, verifying, a thread shown from something that moved without anything naming it', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) })
    const { adapter, changed, sotto } = await stack()
    await changed.control.command({ type: 'connect' })
    adapter.publish(false); await quiet()
    const inside = changed.control as unknown as { incoming: ThreadMap; verifyChanges(map: ThreadMap): void }
    expect(() => inside.verifyChanges(inside.incoming)).not.toThrow()
    // A request of Sotto's own put in without telling the coordinator, which every path that changes them does.
    changed.requests.pending.set(sotto('s4'), [{ id: `${SOTTO_REQUEST_PREFIX}silent`, kind: 'permission', text: 'Unannounced', options: [] } as unknown as AgentRequest])
    expect(() => inside.verifyChanges(inside.incoming)).toThrow(ThreadChangesDrift)
  })
})
