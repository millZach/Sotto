// @vitest-environment node
/**
 * The coordinator's side of thread changes (ADR-0016, #925, step 5). The coordinator takes the workspace's thread changes
 * in: an ordinary change shows, tracks and lists again only the threads it names, and every other thread keeps the record
 * it was shown as. These hold that to the whole path it replaces: a coordinator that takes every publication in whole,
 * as every coordinator did before, over the same workspace, says what the one that takes in changes says, across long
 * seeded runs of mixed operations. Usage is held to its whole path the same way.
 *
 * What is compared after each operation is everything downstream of the coordinator, as JSON: its host snapshot, its
 * last broadcast and a fresh broadcast shell (what the window and the phone are sent), what a window holds of each thread
 * it looks at, the router's state for the window, and the shell a paired phone was last sent over the host socket. Three
 * things are normalized, and nothing else: each failure's name and each page's token, which each coordinator makes afresh
 * at random, are named in the order they first appear; and a window's held history is compared without its revision
 * numbers, since each coordinator is told of a command a moment apart and one may send a revision the other never needed
 * (every other field of the detail, such as `earlierAvailable`, is compared). Usage is compared by the threads whose usage
 * each read and by what each saved, read back as the Usage page reads it, without the time its store was made.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentRequest, type AgentState, type AgentThread, type AgentThreadDetail } from '../../../src/shared/agents'
import { applyAgentThreadDetailDelta, isAgentThreadDetailDelta } from '../../../src/shared/agentThreadDetail'
import type { HeldProviders } from '../../../src/shared/heldProviders'
import type { AgentControl } from '../../../src/main/agents/control'
import type { AgentHost } from '../../../src/main/agents/host'
import { LocalHostService } from '../../../src/main/agents/hostService'
import { PairedClients } from '../../../src/main/agents/pairing'
import { PROTOTYPE_HOLD_MAX_MS, PROTOTYPE_SEND_BACK_WINDOW_MS } from '../../../src/main/agents/prototypeQuestions'
import { PROTOTYPES_CLEARED_MAX, PROTOTYPES_MARKED_MAX } from '../../../src/main/agents/prototypeReady'
import { FINISHED_UNREAD_MAX } from '../../../src/main/agents/finishedUnread'
import { QUESTION_PAGE_LINGER_MS } from '../../../src/main/agents/questionPages'
import { ConfiguredProviderHost } from '../../../src/main/agents/providerSwitch'
import { SOTTO_REQUEST_PREFIX, type SottoThreadRequests } from '../../../src/main/agents/sottoRequests'
import { ThreadChangesDrift, type AgentHostChanges, type ThreadMap } from '../../../src/main/agents/threadChanges'
import { SottoThreadHost, ThreadRegistry } from '../../../src/main/agents/threads'
import { UsageService } from '../../../src/main/agents/usageService'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { startSocketServer } from '../../../src/host/socketServer'
import { DesktopHostRouter } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { createAgentControl, type TestControlOptions } from '../../fixtures/agentControlFixture'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import { rawPeer } from '../../fixtures/rawHostPeer'
import { StreamingAdapter } from '../../fixtures/streamingAdapter'
import { testCredentials } from '../../fixtures/testCredentials'

/** The projects every look-up of which projects are settled reads, which a change must make once, not once per thread. */
const projectVisits = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../../src/main/agents/finishedUnread', async importOriginal => {
  const original = await importOriginal<typeof import('../../../src/main/agents/finishedUnread')>()
  return { ...original, settledIn: (snapshot: Parameters<typeof original.settledIn>[0]) => { projectVisits.count += snapshot.projects.length; return original.settledIn(snapshot) } }
})

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close() })

const AT = '2026-10-25T12:00:00.000Z'
const thread = (id: string, fields: Partial<AgentThread> = {}): AgentThread => ({ id, projectId: 'project', title: `Thread ${id}`, modelId: 'fake:model',
  status: 'idle', messages: [], requests: [], ...fields })
const record = (id: string, sequence: number, status: AgentActivity['status'] = 'completed'): AgentActivity =>
  ({ id, turnId: 'turn', sequence, kind: 'tool', status, title: 'Tool', output: `Output ${id}` })
const quiet = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 60))
const MODEL = { id: 'fake:model', provider: 'Fake', name: 'Synthetic model', ready: true }
const OTHER_MODEL = { id: 'fake:other', provider: 'Fake', name: 'Other synthetic model', ready: true }

/** The provider's state: one project, or with `projectEach` one project for each thread, all in the same folder. */
function providerState(root: string, sessions: readonly string[], projectEach = false): AgentHostSnapshot {
  const projectOf = (id: string): string => projectEach ? `project-${id}` : 'project'
  return { ...structuredClone(EMPTY_AGENT_HOST), name: 'Synthetic', version: '1', connected: true,
    capabilities: { ...EMPTY_AGENT_HOST.capabilities, projects: true, threads: true, submit: true, observe: true },
    projects: (projectEach ? sessions : ['project']).map(id => ({ id: projectEach ? projectOf(id) : 'project', title: `Synthetic ${id}`, path: join(root, 'project') })),
    models: [{ ...MODEL }],
    threads: sessions.map(id => thread(id, { projectId: projectOf(id) })) }
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
  /** The coordinator's prototype question timers, which the test runs when their time comes. */
  readonly timers: { run: () => void; due: number; done: boolean }[]
  readonly usage: UsageService
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
 * folder, its own host service and router for the window, a phone paired over its own host socket, and its own usage:
 * the first's reads the workspace's thread changes, the second's its activity snapshots. Each usage reads usage through
 * `visitUsage`, which fails for the sessions in `failingUsage`.
 */
async function stack(control: TestControlOptions = {}, threads = 6, projectEach = false, reconnects = true) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-coordinator-changes-'))
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }))
  await mkdir(join(root, 'project'), { recursive: true })
  // Two prototype pages the agents' replies and questions name.
  await writeFile(join(root, 'project', 'mock.html'), '<!doctype html><title>Mock</title>')
  await writeFile(join(root, 'project', 'other.html'), '<!doctype html><title>Other</title>')
  const registry = new ThreadRegistry(join(root, 'registry'))
  await registry.load()
  cleanup.push(async () => { await registry.flush().catch(() => undefined) })
  const sessions = Array.from({ length: threads }, (_, index) => `s${index + 1}`)
  const adapter = new StreamingAdapter(providerState(root, sessions, projectEach))
  const native = new ConfiguredProviderHost({ directory: join(root, 'switch'), provider: () => 'claude', enabledProviders: () => ['claude'], threadProvider: id => registry.byThread(id)?.provider,
    hosts: { claude: new SottoThreadHost('claude', adapter, registry), codex: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost(),
      muse: new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)), opencode: new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)), cursor: new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)), deepseek: new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)) } })
  await mkdir(join(root, 'workspace'), { recursive: true })
  const workspace = new WorkspaceHost(native, join(root, 'workspace'), () => true, 600_000)
  cleanup.push(async () => { workspace.disconnect(); await workspace.privacyChanged().catch(() => undefined); workspace.dispose() })
  await workspace.initialize()
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  const failingUsage = new Set<string>()
  const made: Downstream[] = []
  for (const name of ['changed', 'whole'] as const) {
    const directory = join(root, name)
    await mkdir(directory, { recursive: true })
    const timers: Downstream['timers'] = []
    const coordinator = createAgentControl({ directory, host: workspace, credentials, ...control,
      prototypeQuestionTimer: (run, ms) => { const timer = { run, due: Date.now() + ms, done: false }; timers.push(timer); return () => { timer.done = true } } })
    if (name === 'whole') (coordinator as unknown as { acceptsWhole: boolean }).acceptsWhole = true
    // Sotto's note to a thread about its prototype question is taken by the provider, as one that goes through is.
    vi.spyOn(coordinator as unknown as { sendPrototypeQuestionBack(): Promise<boolean> }, 'sendPrototypeQuestionBack').mockResolvedValue(true)
    // Each coordinator retries a disconnected provider it counts as enabled (codex, the default) on a real five-second timer,
    // and the retry connects the provider both share. A long run outlasts it on a loaded runner: the first timer's retry
    // connects codex and names it enabled, and the second finds it connected and names nothing, so the two differ by when a
    // timer fired, not by how they take changes in (#1597). Reconnecting is not what the long runs compare, so there neither
    // retries.
    if (!reconnects) vi.spyOn(coordinator as unknown as { scheduleProviderReconnects(): void }, 'scheduleProviderReconnects').mockImplementation(() => undefined)
    const requests = sottoRequests()
    coordinator.useSottoRequests(requests.requests)
    await coordinator.start()
    cleanup.push(() => coordinator.dispose())
    // Usage over the workspace, reading through a `visitUsage` that fails for `failingUsage`; the second sees no thread changes.
    const usageHost = new Proxy(workspace, { get(target, key) {
      if (key === 'visitUsage') return (threadId: string, visitor: (record: unknown) => void) => {
        if (failingUsage.has(registry.byThread(threadId)?.sessionId ?? '')) throw new Error('The usage could not be read.')
        // One record of the thread's usage, the same for both, so what each usage saved can be compared.
        visitor({ providerId: 'claude', threadId, recordKey: createHash('sha256').update(threadId).digest('hex'), modelId: MODEL.id,
          tokens: { input: 10, output: 5 }, at: AT, phase: 'replay', partial: false })
      }
      if (key === 'subscribeActivityChanges' && name === 'whole') return undefined
      const value = Reflect.get(target, key, target) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    } }) as unknown as AgentHost
    const usage = new UsageService({ directory: join(directory, 'usage'), host: usageHost })
    usage.start()
    cleanup.push(() => usage.close())
    const service = new LocalHostService({ control: coordinator })
    const router = new DesktopHostRouter(() => emptyDesktopState(coordinator.hostId()), { watcherEnabled: control.watcherEnabled ?? true, ...(control.heldProviders ? { heldProviders: control.heldProviders } : {}) })
    cleanup.push(() => router.dispose())
    router.add({ hostId: coordinator.hostId()!, name: 'This computer', kind: 'local', service, detail: id => coordinator.threadDetail(id),
      preview: request => coordinator.attachmentPreview(request), subscribeDetail: listener => coordinator.subscribeThreadDetail(listener) })
    // Both phones are paired with the same client ID, so what each is sent can be compared.
    let ids = 0
    const pairing = new PairedClients(join(directory, 'pairing'), { createId: () => `00000000-0000-4000-8000-${(++ids).toString(16).padStart(12, '0')}` })
    await pairing.load()
    const server = await startSocketServer({ service, pairing })
    cleanup.push(() => server.close())
    const paired = await pairing.redeem(pairing.issuePairingCode().code, 'Phone')
    const peer = await rawPeer(server.descriptor.port, pairing.signSession(paired.clientId))
    cleanup.push(() => peer.frames.close())
    await peer.call('hello', { op: 'hello' })
    const seen: Downstream = { control: coordinator, requests, router, timers, usage, broadcast: undefined, window: undefined, details: new Map(),
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
  const at = (session: string) => adapter.state.threads.find(item => item.id === session)!
  /** Marks the sessions, as the adapter's own paths do, and publishes. */
  const publish = (...marked: string[]): void => { for (const session of marked) adapter.mark(session); adapter.publish(false) }
  const settle = async (): Promise<void> => { await quiet(); await workspace.flush(); await quiet() }
  /** The workspace takes a thread out of its state, as a discarded start does, and publishes. */
  const removeInWorkspace = (session: string): void => {
    const inside = workspace as unknown as { removeThread(id: string): void; publish(): void }
    inside.removeThread(sotto(session)); inside.publish()
  }
  return { root, registry, adapter, workspace, changed, whole, sessions, sotto, at, publish, settle, failingUsage, removeInWorkspace }
}
type Stack = Awaited<ReturnType<typeof stack>>

/**
 * The JSON of `value` with each failure's name and each page's token, which each coordinator makes afresh at random,
 * named in the order it first appears: the same failures and pages, named the same way, read the same.
 */
function text(value: unknown): string {
  const names = new Map<string, string>()
  const name = (kind: string, id: string): string => {
    const key = `${kind}:${id}`
    if (!names.has(key)) names.set(key, `${kind}-${names.size}`)
    return names.get(key)!
  }
  return JSON.stringify(value ?? null)
    .replace(/"failureId":"([^"]+)"/gu, (_whole, id: string) => `"failureId":"${name('failure', id)}"`)
    .replace(/"token":"([^"]+)"/gu, (_whole, id: string) => `"token":"${name('token', id)}"`)
}

/** Where two texts first differ, with a little of each around it. */
function where(changed: string, whole: string): string {
  let at = 0
  while (at < changed.length && changed[at] === whole[at]) at++
  return `at ${at}: changes path ...${changed.slice(Math.max(0, at - 120), at + 200)}... whole path ...${whole.slice(Math.max(0, at - 120), at + 200)}...`
}

/** Every way the two coordinators' downstream differs now, named. */
/**
 * What a coordinator keeps for its threads' prototypes and pages: prototype questions' records, the prototype-ready mark's
 * kept replies and cleared sources in their order and its asked replies, and each page search, with how many pages it
 * found and whether it lingers. Thread IDs are the workspace's, so the same for both.
 */
function records(seen: Downstream) {
  const inside = seen.control as unknown as { prototypeQuestions: { records: Map<string, unknown> }
    prototypeReady: { kept: Map<string, unknown>; cleared: Map<string, unknown>; asked: Map<string, string> }
    questionPages: { entries: Map<string, { pages?: unknown[]; goneAt?: number }> } }
  return { questions: [...inside.prototypeQuestions.records.keys()].sort(), kept: [...inside.prototypeReady.kept.keys()], cleared: [...inside.prototypeReady.cleared.keys()],
    asked: [...inside.prototypeReady.asked].sort(), pages: [...inside.questionPages.entries].map(([key, entry]) => [key, entry.pages?.length ?? null, entry.goneAt !== undefined]).sort() }
}

async function differences({ changed, whole }: Stack): Promise<string[]> {
  const held = (seen: Downstream, targets: readonly string[]) => targets.map(id => {
    const detail = seen.details.get(id)
    if (!detail) return undefined
    const { revision: _revision, ...rest } = detail as AgentThreadDetail & { baseRevision?: number }
    void _revision
    return rest
  })
  const usage = (seen: Downstream) => [...(seen.usage as unknown as { visited: Set<string> }).visited].sort()
  // What each usage saved: its records written now, and read back as the Usage page reads them.
  // Each store says when it was made, which is its own; everything else it says is compared.
  const saved = async (seen: Downstream) => {
    (seen.usage as unknown as { flush(): void }).flush()
    const activity = (await seen.usage.read({})).activity
    return activity && { ...activity, metadata: { ...activity.metadata, startedAt: undefined } }
  }
  const [changedUsage, wholeUsage] = [await saved(changed), await saved(whole)]
  const pageBookkeeping = (seen: Downstream) => (seen.control as unknown as { questionPages: { entries: Map<string, { goneAt?: number }>; lingering: Set<string> } }).questionPages
  const lingeringPages = (seen: Downstream) => [...pageBookkeeping(seen).lingering].sort()
  const gonePages = (seen: Downstream) => [...pageBookkeeping(seen).entries].filter(([, entry]) => entry.goneAt !== undefined).map(([key]) => key).sort()
  const targets = changed.targets()
  const aspects: [string, unknown, unknown][] = [
    ['the coordinator\'s host snapshot', changed.control.watcherSnapshot(), whole.control.watcherSnapshot()],
    ['the coordinator\'s last broadcast', changed.broadcast, whole.broadcast],
    ['the coordinator\'s broadcast shell', changed.control.broadcastShell(), whole.control.broadcastShell()],
    ['the window\'s state from the router', changed.window, whole.window],
    ['the threads a window looks at', targets, whole.targets()],
    ['each shown thread\'s history', held(changed, targets), held(whole, targets)],
    ['the phone\'s shell over the host socket', changed.phone()?.state, whole.phone()?.state],
    ['the threads whose usage was read', usage(changed), usage(whole)],
    ['the usage records saved', changedUsage, wholeUsage],
    ['the prototype and page records', records(changed), records(whole)],
    ['the question pages lingering', lingeringPages(changed), lingeringPages(whole)],
    ['the question pages gone', gonePages(changed), gonePages(whole)],
  ]
  return aspects.flatMap(([aspect, left, right]) => { const a = text(left), b = text(right); return a === b ? [] : [`${aspect} ${where(a, b)}`] })
}

/** The two coordinators agree once both have taken in what the operation set off. */
async function agree(made: Stack, step: string): Promise<void> {
  await made.settle()
  await expect.poll(() => differences(made), { timeout: 10_000, message: `after ${step}` }).toEqual([])
}

/**
 * Fills a coordinator's kept prototype marks to their limit with marks of threads that are long gone, newest last, as a
 * coordinator that has kept marks for many threads holds them: the next mark a thread takes lets the oldest kept go.
 */
function fillKept(seen: Downstream, prefix: string): void {
  const ready = (seen.control as unknown as { prototypeReady: { kept: Map<string, unknown>; restore(saved: readonly never[], began: undefined, marked: readonly { threadId: string; messageId: string; createdAt: string }[]): void } }).prototypeReady
  const room = PROTOTYPES_MARKED_MAX - ready.kept.size
  if (room > 0) ready.restore([], undefined, Array.from({ length: room }, (_, index) => ({ threadId: `${prefix}-${index}`, messageId: `${prefix}-reply-${index}`, createdAt: AT })))
}

/** The threads a coordinator keeps a prototype mark for, oldest first. */
const keptOf = (seen: Downstream): string[] => [...(seen.control as unknown as { prototypeReady: { kept: Map<string, unknown> } }).prototypeReady.kept.keys()]
/** Whether a coordinator's broadcast shows a thread's prototype mark. */
const markedIn = (seen: Downstream, threadId: string): boolean => seen.control.broadcastShell().host.threads.find(item => item.id === threadId)?.prototypeReady !== undefined

/**
 * Each session replies naming a page, all in one publication, dated now, and both coordinators find the pages and mark
 * the threads. A mark is taken as each search ends, in the order the searches began, which is display order.
 */
async function markWithPages(made: Stack, sessions: readonly string[]): Promise<void> {
  for (const session of sessions) made.adapter.log.add(session, { id: `page-of-${session}`, role: 'assistant', text: 'The mock-up is ready: mock.html', createdAt: new Date().toISOString() })
  made.publish(...sessions)
  await agree(made, `${sessions.length} threads replying with a page`)
  await expect.poll(() => sessions.every(session => markedIn(made.changed, made.sotto(session))), { timeout: 20_000 }).toBe(true)
  await agree(made, `${sessions.length} threads marked`)
}

/** Moves the clock on by `ms` and runs every prototype question timer that is due, on both coordinators. */
async function passTime(made: Stack, ms: number): Promise<void> {
  vi.setSystemTime(Date.now() + ms)
  for (const seen of [made.changed, made.whole]) {
    for (const timer of seen.timers.splice(0)) {
      if (timer.done) continue
      if (timer.due <= Date.now()) { timer.done = true; timer.run() } else seen.timers.push(timer)
    }
  }
}

/** mulberry32: whole 32-bit integers throughout, so every operation family is reachable. */
function prng(seed: number): (below: number) => number {
  return below => {
    seed = (seed + 0x6d2b79f5) | 0
    let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) % below
  }
}

/** The seeded run, with every operation family once in a fixed order first and then a seeded mix of them. */
async function equivalenceRun(control: TestControlOptions, seed: number, rounds = 110) {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) })
  const made = await stack(control, 6, false, false)
  const { adapter, workspace, changed, whole, sessions, sotto, at, publish, failingUsage } = made
  const both = [changed, whole]
  // The changes path takes most publications in as changes; the whole path never subscribes to them.
  const taken = vi.spyOn(changed.control as unknown as { acceptChanges(map: ThreadMap, changes: unknown): void }, 'acceptChanges')
  const patched = vi.spyOn(changed.control as unknown as { patchHostThreads(...args: unknown[]): unknown }, 'patchHostThreads')
  const takenWhole = vi.spyOn(whole.control as unknown as { acceptChanges(map: ThreadMap, changes: unknown): void }, 'acceptChanges')
  let compared = 0
  const same = async (step: string): Promise<void> => { compared++; await agree(made, step) }
  for (const each of both) await each.control.command({ type: 'connect' })
  publish('s1')
  await same('connecting')
  const next = prng(seed)
  let madeThreads = 0, question = 0
  const messages = new Map<string, string>()
  const say = (session: string, id: string, role: 'user' | 'assistant', words: string): void => { adapter.log.add(session, { id, role, text: words, createdAt: new Date().toISOString() }) }
  const families: readonly ((session: string, round: number) => Promise<void>)[] = [
    async (session) => { at(session).status = at(session).status === 'running' ? 'idle' : 'running'; publish(session); await same(`turning ${session} ${at(session).status}`) },
    async (session, round) => { const id = `m-${round}`; messages.set(session, id); say(session, id, round % 2 ? 'assistant' : 'user', `Message ${round}`); publish(); await same(`a message in ${session}`) },
    async (session, round) => { const list = at(session).activities ?? []; at(session).activities = [...list, record(`r-${round}`, list.length, round % 3 ? 'completed' : 'running')]; publish(session); await same(`a record in ${session}`) },
    async (session, round) => { at(session).title = `Provider ${round}`; publish(session); await same(`the provider renaming ${session}`) },
    async (session, round) => { await workspace.renameThread(sotto(session), `User ${round}`); await same(`the user renaming ${session}`) },
    async (session, round) => { await workspace.setWorkspaceSettled('thread', sotto(session), round % 2 === 0); await same(`settling ${session}`) },
    async (session) => { at(session).status = at(session).status === 'error' ? 'idle' : 'error'; publish(session); await same(`${session} failing or resting`) },
    async () => { const shown = sessions.filter(() => next(2) === 0).map(sotto); for (const each of both) each.control.showThreads(shown); await same('a client showing other threads') },
    async () => {
      // Each coordinator names its own failures; the user dismisses all of them on each.
      for (const each of both) {
        const failures = each.control.broadcastShell().host.threads.flatMap(item => item.failureId && !item.failureSeen ? [{ threadId: item.id, failure: item.failureId }] : [])
        await each.control.command({ type: 'dismiss-failures', failures })
      }
      await same('Dismiss all')
    },
    async (session) => { adapter.state.threads.splice(adapter.state.threads.indexOf(at(session)), 1); sessions.splice(sessions.indexOf(session), 1); publish(session); await same(`the provider dropping ${session}`) },
    async () => { const id = `n${madeThreads++}`; adapter.state.threads.push(thread(id)); sessions.push(id); publish(id); await same(`the provider starting ${id}`) },
    async (session, round) => { at(session).requests = at(session).requests.length ? [] : [{ id: `q-${round}`, kind: 'question', text: 'Which?', options: [] } as unknown as AgentRequest]; publish(session); await same(`a question in ${session}`) },
    async (session) => { at(session).archivedAt = at(session).archivedAt ? undefined : AT; publish(session); await same(`archiving ${session}`) },
    async (session) => { for (const each of both) each.requests.toggle(sotto(session)); await same(`a request of Sotto's own in ${session}`) },
    async (session, round) => {
      const id = messages.get(session)
      if (id) adapter.log.appendText(session, id, ` more ${round}`)
      else { messages.set(session, `m-${round}`); say(session, `m-${round}`, 'assistant', `Streamed ${round}`) }
      publish(); await same(`a streamed reply in ${session}`)
    },
    async (session) => { for (const each of both) await each.control.command({ type: 'select-thread', threadId: sotto(session) }); await same(`selecting ${session}`) },
    // A finished turn's reply naming a prototype page, which earns the thread its prototype-ready mark once it is found.
    async (session, round) => { at(session).status = 'idle'; say(session, `page-${round}`, 'assistant', `The mock-up is ready: ${round % 2 ? 'mock.html' : 'other.html'}`); publish(session); await same(`a reply in ${session} naming a page`) },
    // A question about a prototype: held while its pages are looked for, shown with them, or sent back without one.
    async (session, round) => {
      const page = round % 3 === 0 ? ' Open mock.html to see it.' : ''
      at(session).requests = [{ id: `prototype-${question++}`, kind: 'question', text: `Does this prototype look right?${page}`, options: [] } as unknown as AgentRequest]
      publish(session); await same(`a prototype question in ${session}`)
    },
    // A prototype question's deadlines pass: the hold, the provider's word on the note, and the minute after it.
    async (_session, round) => { await passTime(made, round % 2 ? PROTOTYPE_HOLD_MAX_MS : PROTOTYPE_SEND_BACK_WINDOW_MS); publish(); await same('a prototype deadline passing') },
    // The user opens one of a marked thread's pages, which reviews its prototype.
    async () => {
      for (const each of both) {
        const marked = each.control.broadcastShell().host.threads.find(item => item.prototypeReady?.pages.length)
        if (marked) each.control.questionPageOpened(marked.prototypeReady!.pages[0]!.token)
      }
      await same('a prototype page opened')
    },
    // The provider's catalog changing, which is a change to the rest of the snapshot.
    async () => { adapter.state.models = adapter.state.models.length > 1 ? [{ ...MODEL }] : [{ ...MODEL }, { ...OTHER_MODEL }]; publish(); await same('the provider\'s catalog changing') },
    // A thread's model changing at the provider.
    async (session) => { at(session).modelId = at(session).modelId === OTHER_MODEL.id ? MODEL.id : OTHER_MODEL.id; publish(session); await same(`${session}'s model changing`) },
    // Kept prototype marks filled to their limit with marks of threads long gone, so the next mark a thread takes lets the
    // oldest go, and a thread that keeps its mark through a reply lets a chain of others go in turn.
    async () => { const prefix = `fill-${madeThreads++}`; for (const each of both) fillKept(each, prefix); publish(); await same('the kept marks filled to their limit') },
    // Two threads archived or unarchived in one change: unarchived, each takes its mark back and lets another's go.
    async () => {
      const [first, second] = [sessions[next(sessions.length)]!, sessions[next(sessions.length)]!]
      for (const session of new Set([first, second])) at(session).archivedAt = at(session).archivedAt ? undefined : AT
      publish(first, second); await same(`archiving or unarchiving ${first} and ${second} in one change`)
    },
    // Pages linger past their time, and one publication changes a thread and brings back an archived one, whose page lingered.
    async (session, round) => {
      await passTime(made, QUESTION_PAGE_LINGER_MS + 1_000)
      const archived = sessions.find(each => at(each).archivedAt)
      if (archived) at(archived).archivedAt = undefined
      at(session).title = `Lingered ${round}`
      publish(session, ...(archived ? [archived] : [])); await same(`pages lingering past their time, ${session} changing${archived ? ` and ${archived} coming back` : ''}`)
    },
    // A thread whose usage cannot be read yet, read again with a later publication once it can.
    async () => {
      if (failingUsage.size) { failingUsage.clear(); publish(); await same('usage readable again'); return }
      const id = `u${madeThreads++}`
      failingUsage.add(id); adapter.state.threads.push(thread(id)); sessions.push(id); publish(id); await same(`a thread starting whose usage cannot be read: ${id}`)
    },
  ]
  const ran = new Map<number, number>()
  const order = [...families.keys(), ...Array.from({ length: rounds }, () => next(families.length))]
  for (const [round, family] of order.entries()) {
    // A thread is dropped only while more than three remain.
    if (family === 9 && sessions.length <= 3) continue
    const session = sessions[next(sessions.length)]!
    await families[family]!(session, round)
    ran.set(family, (ran.get(family) ?? 0) + 1)
  }
  expect([...ran.keys()].sort((left, right) => left - right), 'every operation family ran').toEqual([...families.keys()])
  expect(compared).toBeGreaterThan(rounds * 0.8)
  expect(taken.mock.calls.length).toBeGreaterThan(rounds / 3)
  // Most changes are taken in as changes, not in whole.
  expect(patched.mock.calls.length).toBeGreaterThan(rounds / 6)
  expect(takenWhole).not.toHaveBeenCalled()
  return made
}

describe('the coordinator taking in changes and taking in everything', () => {
  it('hands on the same as the whole path across a long run of mixed operations, on Owl', async () => {
    await equivalenceRun({ watcherEnabled: true }, 925)
  }, 180_000)

  it('hands on the same as the whole path with providers held and threads that begin from others, as on stable', async () => {
    await equivalenceRun({ watcherEnabled: false, threadStartsEnabled: true, heldProviders: new Set(['muse', 'opencode', 'cursor']) as HeldProviders }, 1334)
  }, 180_000)
})

describe('the coordinator at its limits', () => {
  /**
   * Codex's case (#925 review): in display order B, C, D, with the kept marks full and C's kept the oldest, a change takes
   * B's and D's marks back. B's lets C's kept reply go, and C, read again, takes its mark back and lets the next oldest go,
   * before D does, as the whole path reads them. Which of C and D the kept marks let go first, once later marks fill them
   * again, follows that order.
   */
  it('reads a thread another\'s mark let go at its place among the threads a change names', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) })
    const made = await stack({ watcherEnabled: true })
    const { changed, whole, sotto, at, publish } = made
    for (const each of [changed, whole]) await each.control.command({ type: 'connect' })
    const [b, c, d] = ['s2', 's3', 's4']
    // B and D are marked and archived, which lets their kept go while their pages stay found; C keeps its mark.
    await markWithPages(made, [b, d])
    at(b).archivedAt = AT; at(d).archivedAt = AT; publish(b, d)
    await agree(made, 'B and D archived')
    await markWithPages(made, [c])
    for (const each of [changed, whole]) fillKept(each, 'old')
    at(b).archivedAt = undefined; at(d).archivedAt = undefined; publish(b, d)
    await agree(made, 'B and D unarchived in one change')
    expect(keptOf(changed).slice(-3)).toEqual([sotto(b), sotto(c), sotto(d)])
    expect(keptOf(changed)).toEqual(keptOf(whole))
    // Each replies again naming no page, so each keeps its mark through its kept reply alone, and loses it once let go.
    for (const session of [b, c, d]) made.adapter.log.add(session, { id: `plain-${session}`, role: 'assistant', text: 'Nothing else to show.', createdAt: new Date().toISOString() })
    publish(b, c, d)
    await agree(made, 'B, C and D replying again')
    expect(keptOf(changed).slice(-3)).toEqual([sotto(b), sotto(c), sotto(d)])
    // Later marks fill the kept marks again, past B's and C's, so D's alone stays.
    for (const each of [changed, whole]) {
      const ready = (each.control as unknown as { prototypeReady: { restore(saved: readonly never[], began: undefined, marked: readonly { threadId: string; messageId: string; createdAt: string }[]): void } }).prototypeReady
      ready.restore([], undefined, Array.from({ length: PROTOTYPES_MARKED_MAX - 1 }, (_, index) => ({ threadId: `later-${index}`, messageId: `later-reply-${index}`, createdAt: AT })))
    }
    made.adapter.log.add('s5', { id: 'unrelated', role: 'user', text: 'Unrelated', createdAt: AT }); publish()
    await agree(made, 'later marks filling the kept marks')
    expect([b, c, d].map(session => markedIn(changed, sotto(session)))).toEqual([false, false, true])
  }, 120_000)

  /**
   * #1535: a thread whose kept reply another thread's mark lets go is read again at its place in the same pass, but the
   * pages read in (a) still had that reply kept. The next change has to name it, as the whole path examines every thread
   * there, or its old page never starts lingering and its token keeps being served.
   */
  it('examines the page of a thread whose kept reply a mark let go on the next change', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) })
    const made = await stack({ watcherEnabled: true }, 6, false, false)
    const { changed, whole, sotto, at, publish } = made
    for (const each of [changed, whole]) await each.control.command({ type: 'connect' })
    const [n, c] = ['s2', 's5']
    // N and C are marked; N is archived, which lets its kept reply go while its page stays found.
    await markWithPages(made, [n])
    await markWithPages(made, [c])
    at(n).archivedAt = AT; publish(n)
    await agree(made, 'N archived')
    // C keeps its page through its kept reply alone once it replies naming no page.
    made.adapter.log.add(c, { id: 'plain-c', role: 'assistant', text: 'Nothing else to show.', createdAt: new Date().toISOString() }); publish(c)
    await agree(made, 'C replying again')
    // The kept marks are filled past C, so C's is the oldest.
    for (const each of [changed, whole]) fillKept(each, 'old')
    expect(keptOf(changed)[0]).toBe(sotto(c))
    // C and N are named in one change: (a) reads C with its kept reply still kept, then N's mark lets it go.
    at(c).title = 'Thread C again'; at(n).archivedAt = undefined
    publish(c, n)
    await expect.poll(() => [keptOf(changed).includes(sotto(c)), keptOf(whole).includes(sotto(c))], { timeout: 10_000 }).toEqual([false, false])
    // The whole path reads C without its kept reply here; the changes path has to name C again on the next change.
    made.adapter.log.add('s1', { id: 'unrelated', role: 'user', text: 'Unrelated', createdAt: AT }); publish()
    await quiet()
    expect(await differences(made)).toEqual([])
  }, 120_000)

  /**
   * Codex's case (#925 review): N comes before 65 threads whose kept marks are the oldest, in display order, the first 64
   * kept through their newest reply and the 65th through an older one. N taking its mark back lets the first go; read
   * again, each takes its mark back and lets the next go, until the 65th, which cannot, loses its mark. The chain is read
   * to its end, however long, as the whole path reads it.
   */
  it('follows marks letting each other go to the end of the chain, however long', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) })
    const made = await stack({ watcherEnabled: true }, 68)
    const { changed, whole, sotto, at, publish, sessions } = made
    for (const each of [changed, whole]) await each.control.command({ type: 'connect' })
    const n = 's1', chain = sessions.slice(1, 66), last = chain.at(-1)!
    await markWithPages(made, [n])
    at(n).archivedAt = AT; publish(n)
    await agree(made, 'N archived')
    await markWithPages(made, chain)
    expect(keptOf(changed).slice(0, chain.length)).toEqual(chain.map(sotto))
    made.adapter.log.add(last, { id: 'plain', role: 'assistant', text: 'Nothing else to show.', createdAt: new Date().toISOString() }); publish(last)
    await agree(made, 'the last of the chain replying again')
    for (const each of [changed, whole]) fillKept(each, 'old')
    expect(markedIn(changed, sotto(last))).toBe(true)
    // The whole path clears the 65th's mark in the pass that takes N's change in, so the changes path must too, rather
    // than with a later change.
    const inside = changed.control as unknown as { acceptChanges(map: ThreadMap, changes: AgentHostChanges): void }
    const accept = inside.acceptChanges.bind(changed.control)
    let inPass: boolean | undefined
    inside.acceptChanges = (map, changes) => {
      accept(map, changes)
      if (changes.upserts.some(record => record.id === sotto(n))) inPass ??= changed.control.watcherSnapshot().threads.find(item => item.id === sotto(last))?.prototypeReady !== undefined
    }
    at(n).archivedAt = undefined; publish(n)
    await agree(made, 'N unarchived')
    expect(inPass, 'the 65th thread still marked once the change that let its kept reply go was taken in').toBe(false)
    expect(markedIn(changed, sotto(last))).toBe(false)
    expect(chain.slice(0, -1).every(session => markedIn(changed, sotto(session)))).toBe(true)
    expect(keptOf(changed)).toEqual(keptOf(whole))
  }, 180_000)

  /**
   * Codex's case (#925 review): with more running threads than Just finished keeps marks for, two finish in one change
   * that names them out of display order, and then the rest finish. Which marks the limit drops follows the order the
   * finishes are read in, so the changes path reads them in display order, as the whole path does.
   */
  it('reads threads that finish in one change in display order, so the Just finished limit drops the same marks', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) })
    const made = await stack({ watcherEnabled: true }, FINISHED_UNREAD_MAX + 1)
    const { adapter, changed, whole, sessions, at, publish } = made
    for (const each of [changed, whole]) await each.control.command({ type: 'connect' })
    for (const session of sessions) at(session).status = 'running'
    publish(...sessions)
    await agree(made, 'every thread running')
    const received = vi.spyOn(changed.control as unknown as { acceptChanges(map: ThreadMap, changes: AgentHostChanges): void }, 'acceptChanges')
    // B and A finish together, named B first.
    at('s2').status = 'idle'; at('s1').status = 'idle'
    adapter.mark('s2'); adapter.mark('s1'); adapter.publish(false)
    await agree(made, 's2 and s1 finishing together')
    const titles = received.mock.calls.flatMap(([, changes]) => changes.upserts.map(item => item.title))
    expect(titles.indexOf('Thread s2'), 'the change names s2 before s1').toBeLessThan(titles.indexOf('Thread s1'))
    for (const session of sessions.slice(2)) at(session).status = 'idle'
    publish(...sessions.slice(2))
    await agree(made, 'every other thread finishing')
    const marked = changed.control.broadcastShell().host.threads.filter(item => item.finishedUnread).length
    expect(marked).toBe(FINISHED_UNREAD_MAX)
  }, 120_000)

  /**
   * Codex's case (#925 review): kept prototype marks are full, and thread A keeps its mark through an older reply, its
   * newest naming no page. Thread B, whose page still lingers, is unarchived and takes a mark back, which lets A's kept
   * reply go. The whole path clears A's mark when it reads A after that, in the same pass when A comes after B and in the
   * next when it comes before, and the changes path must too, though no change names A.
   */
  it.each([['before', 's1', 's2'], ['after', 's5', 's2']] as const)('clears a mark whose kept reply another thread\'s mark let go, with that thread %s it', async (_order, a, b) => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) })
    const made = await stack({ watcherEnabled: true }, 6, false, false)
    const { adapter, changed, whole, sotto, at, publish } = made
    for (const each of [changed, whole]) await each.control.command({ type: 'connect' })
    // Dated now: a coordinator marks only replies written after its marks began, when it was made.
    const reply = (session: string, id: string, words: string): void => { adapter.log.add(session, { id, role: 'assistant', text: words, createdAt: new Date().toISOString() }); publish(session) }
    reply(a, 'a-page', 'The mock-up is ready: mock.html')
    reply(b, 'b-page', 'The other mock-up is ready: other.html')
    await agree(made, 'both threads marked')
    expect(changed.control.broadcastShell().host.threads.find(item => item.id === sotto(a))?.prototypeReady).toBeDefined()
    at(b).archivedAt = AT; publish(b)
    reply(a, 'a-plain', 'Nothing else to show.')
    await agree(made, `${b} archived and ${a} replying again`)
    // Every other kept mark, newer than A's, fills the kept marks up to their limit.
    const others = Array.from({ length: PROTOTYPES_MARKED_MAX - 1 }, (_, index) => ({ threadId: `gone-${index}`, messageId: `gone-reply-${index}`, createdAt: AT }))
    for (const each of [changed, whole]) (each.control as unknown as { prototypeReady: { restore(saved: readonly never[], began: undefined, marked: typeof others): void } }).prototypeReady.restore([], undefined, others)
    at(b).archivedAt = undefined; publish(b)
    await agree(made, `${b} unarchived, taking its mark back`)
    // Another thread's change, which names neither.
    adapter.log.add('s3', { id: 'unrelated', role: 'user', text: 'Unrelated', createdAt: AT }); publish()
    await agree(made, 'an unrelated change')
    expect(changed.control.broadcastShell().host.threads.find(item => item.id === sotto(a))?.prototypeReady).toBeUndefined()
  }, 120_000)

  it('brings back a mark whose cleared source the cleared sources let go, though no change names it', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) })
    const made = await stack({ watcherEnabled: true })
    const { adapter, changed, whole, sotto, publish } = made
    for (const each of [changed, whole]) await each.control.command({ type: 'connect' })
    adapter.log.add('s4', { id: 'page', role: 'assistant', text: 'The mock-up is ready: mock.html', createdAt: new Date().toISOString() }); publish('s4')
    await agree(made, 's4 marked')
    for (const each of [changed, whole]) {
      const marked = each.control.broadcastShell().host.threads.find(item => item.id === sotto('s4'))!
      each.control.questionPageOpened(marked.prototypeReady!.pages[0]!.token)
    }
    await agree(made, 's4\'s page opened')
    expect(changed.control.broadcastShell().host.threads.find(item => item.id === sotto('s4'))?.prototypeReady).toBeUndefined()
    // Opening a page takes the coordinator's own snapshot again, so the change after it is taken whole; this one is not.
    adapter.log.add('s2', { id: 'between', role: 'user', text: 'Between', createdAt: AT }); publish()
    await agree(made, 'a change taken in as one')
    // Newer cleared sources fill the list past its limit, which lets s4's go.
    for (const each of [changed, whole]) {
      const ready = (each.control as unknown as { prototypeReady: { add(threadId: string, source: string): boolean } }).prototypeReady
      for (let index = 0; index < PROTOTYPES_CLEARED_MAX; index++) ready.add(`gone-${index}`, `reply:gone-${index}`)
    }
    adapter.log.add('s1', { id: 'unrelated', role: 'user', text: 'Unrelated', createdAt: AT }); publish()
    await agree(made, 'an unrelated change')
    expect(changed.control.broadcastShell().host.threads.find(item => item.id === sotto('s4'))?.prototypeReady).toBeDefined()
  }, 120_000)
})

describe('the coordinator taking a change in phases', () => {
  /**
   * A change naming many threads across as many projects looks up which projects are settled once, not once per thread
   * (#925 review): read for each thread, the look-up made a change of N threads cost N squared.
   */
  it('looks up which projects are settled once for a change, however many threads and projects it names', async () => {
    const visits = async (count: number): Promise<number> => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) })
      const made = await stack({ watcherEnabled: true }, count, true)
      for (const each of [made.changed, made.whole]) await each.control.command({ type: 'connect' })
      made.publish()
      await agree(made, `${count} threads in ${count} projects`)
      const inside = made.changed.control as unknown as { acceptChanges(map: ThreadMap, changes: AgentHostChanges): void; acceptChangesInPlace(...args: unknown[]): void }
      const inPlace = vi.spyOn(inside, 'acceptChangesInPlace')
      const accept = inside.acceptChanges.bind(made.changed.control)
      let counted = 0
      inside.acceptChanges = (map, changes) => {
        const before = projectVisits.count
        accept(map, changes)
        if (changes.upserts.length >= count) counted += projectVisits.count - before
      }
      for (const session of made.sessions) made.at(session).title = `Renamed ${session}`
      made.publish(...made.sessions)
      await agree(made, 'every thread renamed in one change')
      expect(inPlace).toHaveBeenCalled()
      for (const close of cleanup.splice(0).reverse()) await close()
      return counted
    }
    const hundred = await visits(100), twoHundred = await visits(200)
    expect(hundred).toBeGreaterThan(0)
    expect(twoHundred, `project visits: ${hundred} for 100 threads, ${twoHundred} for 200`).toBeLessThanOrEqual(hundred * 2.2)
  }, 240_000)

  /**
   * Codex's case (#925 review): B is archived with its page lingering, the hour passes, and one change names A, before
   * B, and brings B back. The whole path reads B's pages before it lets go of any page past its time, so B's lingering page
   * is B's again; reading A first must not let it go before B is read.
   */
  it('keeps a lingering page a change brings back, though another thread the change names comes first', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) })
    const made = await stack({ watcherEnabled: true })
    const { changed, whole, sotto, at, publish } = made
    for (const each of [changed, whole]) await each.control.command({ type: 'connect' })
    const [a, b] = ['s1', 's2']
    await markWithPages(made, [b])
    const token = changed.control.broadcastShell().host.threads.find(item => item.id === sotto(b))!.prototypeReady!.pages[0]!.token
    at(b).archivedAt = AT; publish(b)
    await agree(made, 'B archived')
    await passTime(made, QUESTION_PAGE_LINGER_MS + 1_000)
    const inside = changed.control as unknown as { acceptChanges(map: ThreadMap, changes: AgentHostChanges): void }
    const accept = inside.acceptChanges.bind(changed.control)
    let inPass: boolean | undefined
    inside.acceptChanges = (map, changes) => {
      accept(map, changes)
      if (changes.upserts.some(record => record.id === sotto(b))) inPass ??= markedIn(changed, sotto(b))
    }
    at(a).title = 'A changed'; at(b).archivedAt = undefined; publish(a, b)
    await agree(made, 'A changing and B coming back in one change')
    expect(inPass, 'B marked once the change that brought it back was taken in').toBe(true)
    expect(changed.control.questionPage(token), 'B\'s page still opens').toBeDefined()
    expect(markedIn(changed, sotto(b))).toBe(true)
  }, 120_000)

  /** A change that only removes threads lets go of what was kept for them, with thread starts off (#925 review). */
  it('lets go of what it kept for a thread a change removes, though the change names no other', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) })
    const made = await stack({ watcherEnabled: true })
    const { changed, whole, sotto, at, publish } = made
    for (const each of [changed, whole]) await each.control.command({ type: 'connect' })
    const r = 's3'
    made.adapter.log.add(r, { id: 'before-question', role: 'assistant', text: 'Before the question.', createdAt: new Date().toISOString() })
    at(r).requests = [{ id: 'removed-question', kind: 'question', text: 'Which way?', options: [] } as unknown as AgentRequest]
    publish(r)
    await agree(made, 'a question in the thread to be removed')
    const before = records(changed)
    expect(before.questions).toContain(sotto(r))
    expect(before.asked.map(([id]) => id)).toContain(sotto(r))
    const inPlace = vi.spyOn(changed.control as unknown as { acceptChangesInPlace(...args: unknown[]): void }, 'acceptChangesInPlace')
    // Read once the removal is taken in: a later whole pass, such as the one the question's search sets off when it looks
    // again, would let go of the thread's records whatever this pass did.
    const inside = changed.control as unknown as { acceptChanges(map: ThreadMap, changes: AgentHostChanges): void }
    const accept = inside.acceptChanges.bind(changed.control)
    let after: ReturnType<typeof records> | undefined
    inside.acceptChanges = (map, changes) => {
      accept(map, changes)
      if (changes.removals.includes(sotto(r)) && !changes.upserts.length) after ??= records(changed)
    }
    made.removeInWorkspace(r)
    await agree(made, 'the thread removed')
    expect(inPlace).toHaveBeenCalled()
    expect(after, 'a change that only removes the thread').toBeDefined()
    expect(after!.questions).not.toContain(sotto(r))
    expect(after!.asked.map(([id]) => id)).not.toContain(sotto(r))
  }, 120_000)
})

describe('the coordinator\'s thread changes', () => {
  it('shows, tracks and lists again only the thread a change names', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) })
    const { adapter, changed } = await stack()
    await changed.control.command({ type: 'connect' })
    adapter.publish(false); await quiet()
    const shown = vi.spyOn(changed.control as unknown as { shownBeforePages(snapshot: AgentHostSnapshot, gone?: Set<string>): AgentHostSnapshot }, 'shownBeforePages')
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

  it('reads the clock once for a change and its check in verifying mode, so a deadline passing between them is no drift', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) })
    const made = await stack()
    const { changed, sotto, at, publish } = made
    await changed.control.command({ type: 'connect' })
    publish(); await made.settle()
    // A question about a prototype with no page: held while its pages are looked for, until its deadline.
    at('s2').requests = [{ id: 'held', kind: 'question', text: 'Does this prototype look right?', options: [] } as unknown as AgentRequest]
    publish('s2'); await made.settle()
    const inside = changed.control as unknown as { verifyingChanges: boolean; verifyChanges(map: ThreadMap): void
      prototypeQuestions: { records: Map<string, { questions: Map<string, { state: string; since: number }> }> } }
    const held = inside.prototypeQuestions.records.get(sotto('s2'))!.questions.get('held')!
    expect(held.state).toBe('held')
    inside.verifyingChanges = true
    const drift: unknown[] = []
    const verify = inside.verifyChanges.bind(changed.control)
    // The deadline passes after the change is taken in and before it is checked.
    let checked = 0
    inside.verifyChanges = map => { checked++; vi.setSystemTime(held.since + PROTOTYPE_HOLD_MAX_MS + 1); try { verify(map) } catch (error) { drift.push(error) } }
    vi.setSystemTime(held.since + PROTOTYPE_HOLD_MAX_MS - 1)
    at('s2').title = 'Renamed'; publish('s2')
    await quiet()
    expect(checked).toBeGreaterThan(0)
    expect(drift).toEqual([])
  })

  /**
   * The check in verifying mode shows every thread again, which can let a kept mark go and name a thread to be shown again.
   * It must change nothing (#925 review): it puts the prototype records back, names nothing, and leaves out only threads
   * that were named before it began. Here a kept mark is taken away and another added behind the coordinator's back, so a
   * whole pass would follow a chain of marks letting each other go to the 65th thread, which the coordinator still shows.
   */
  it('checks a change against a whole pass that puts the records back and names nothing, when they changed behind its back', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) })
    const made = await stack({ watcherEnabled: true }, 67)
    const { changed, whole, sotto, publish, sessions } = made
    for (const each of [changed, whole]) await each.control.command({ type: 'connect' })
    const chain = sessions.slice(1, 66), last = chain.at(-1)!
    await markWithPages(made, chain)
    made.adapter.log.add(last, { id: 'plain', role: 'assistant', text: 'Nothing else to show.', createdAt: new Date().toISOString() }); publish(last)
    await agree(made, 'the last of the chain replying again')
    fillKept(changed, 'old')
    const inside = changed.control as unknown as { incoming: ThreadMap; reshow: Set<string>; verifyChanges(map: ThreadMap): void
      prototypeReady: { kept: Map<string, { messageId: string; createdAt: string }> } }
    expect(() => inside.verifyChanges(inside.incoming)).not.toThrow()
    const kept = inside.prototypeReady.kept
    kept.delete(sotto(chain[0]!)); kept.set('behind-its-back', { messageId: 'behind-reply', createdAt: AT })
    const before = { kept: [...kept.keys()], reshow: [...inside.reshow] }
    expect(() => inside.verifyChanges(inside.incoming)).toThrow(ThreadChangesDrift)
    expect({ kept: [...kept.keys()], reshow: [...inside.reshow] }).toEqual(before)
  }, 180_000)

  /**
   * The walk cut short: once it has read 64 threads a prototype mark let go, it hears of no more, so the 65th thread of a
   * chain keeps the mark the whole path takes away. The check in verifying mode must find that, since nothing named the
   * 65th thread before it began.
   */
  it('finds, verifying, a chain of marks letting each other go that the walk cut short', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) })
    const made = await stack({ watcherEnabled: true }, 68)
    const { changed, whole, at, publish, sessions } = made
    for (const each of [changed, whole]) await each.control.command({ type: 'connect' })
    const n = 's1', chain = sessions.slice(1, 66), last = chain.at(-1)!
    await markWithPages(made, [n])
    at(n).archivedAt = AT; publish(n)
    await agree(made, 'N archived')
    await markWithPages(made, chain)
    made.adapter.log.add(last, { id: 'plain', role: 'assistant', text: 'Nothing else to show.', createdAt: new Date().toISOString() }); publish(last)
    await agree(made, 'the last of the chain replying again')
    for (const each of [changed, whole]) fillKept(each, 'old')
    const inside = changed.control as unknown as { verifyingChanges: boolean; verifyChanges(map: ThreadMap): void
      prototypeReady: { onEvicted: ((threadId: string, by: string) => void) | undefined } }
    inside.verifyingChanges = true
    const drift: unknown[] = []
    const verify = inside.verifyChanges.bind(changed.control)
    inside.verifyChanges = map => { try { verify(map) } catch (error) { drift.push(error) } }
    const told = inside.prototypeReady.onEvicted!
    let heard = 0
    inside.prototypeReady.onEvicted = (threadId, by) => { if (++heard <= 64) told(threadId, by) }
    at(n).archivedAt = undefined; publish(n)
    await quiet()
    expect(heard).toBeGreaterThan(64)
    expect(drift.length, 'the check found the 65th thread still marked').toBeGreaterThan(0)
    expect(drift[0]).toBeInstanceOf(ThreadChangesDrift)
  }, 180_000)

  it('takes the first change after anything else replaced its thread list in whole, though the host snapshot is the same', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) })
    const { adapter, changed } = await stack()
    await changed.control.command({ type: 'connect' })
    adapter.publish(false); await quiet()
    const whole = vi.spyOn(changed.control as unknown as { acceptSnapshot(snapshot: AgentHostSnapshot, fromChanges?: boolean): void }, 'acceptSnapshot')
    // A list put in the coordinator's own host snapshot, with a record nobody published.
    const host = changed.control.watcherSnapshot()
    host.threads = host.threads.map((item, index) => index === 0 ? { ...item, title: 'Made up' } : item)
    adapter.state.threads.find(item => item.id === 's3')!.status = 'running'; adapter.mark('s3'); adapter.publish(false); await quiet()
    expect(whole.mock.calls.some(([, fromChanges]) => fromChanges === true)).toBe(true)
    expect(changed.control.watcherSnapshot().threads.some(item => item.title === 'Made up')).toBe(false)
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
