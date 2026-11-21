// @vitest-environment node
/**
 * What the window's structural sharing walks while threads stream and the user switches threads, part by part (#2733). On
 * November 20, 2026 the owner's window spent 4.4 s a minute in it, up to 688 ms in one commit, while a benchmark sharing a
 * copy of their workspace took 38 ms with every one of its 1,070 thread records new. So what costs is what main sends new.
 *
 * This builds main as `src/main/index.ts` wires it at the owner's thread count (`ownerScalePipeline`), and hands the window
 * what main really sends: each broadcast, and each command's answer through `registerAgentIpc`, through the real preload
 * and the page's reassembly. Three threads stream; the user picks another thread, and the window says which panes it shows.
 * Then, on the real clock, the states the page received are shared one after another as the window shares them, and the
 * time is reported for each part of the state, beside how many thread records arrived as objects the window did not hold.
 *
 *   Set SOTTO_PERF_BENCH=1. Optionally SOTTO_PERF_THREADS=<the window's thread count>, 1,070 by default.
 *   npx vitest run tests/perf/threadSwitchSharing.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deserialize, serialize } from 'node:v8'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PERF_BENCH, round } from '../fixtures/perfBench'
import { OWNER_SCALE } from '../fixtures/ownerScale'
import { ownerScalePipeline } from '../fixtures/ownerScalePipeline'
import { ipcRegistry } from '../fixtures/ipcHarness'
import { registerAgentIpc } from '../../src/main/agents/ipc'
import { createSottoBridge } from '../../src/preload'
import { wrapAgentBridge } from '../../src/renderer/src/agents/agentStateCatalogs'
import { createStateSharing } from '../../src/renderer/src/agents/stateSharing'
import { readFile } from 'node:fs/promises'
import { AgentStateBroadcaster } from '../../src/main/agents/agentStateBroadcast'
import { perfDataDirectory } from '../fixtures/perfWorkspace'
import { stateAround } from './support/transcriptState'
import { AGENT_COMMAND, AGENT_GET, AGENT_STATE, agentShell, type AgentHostSnapshot, type AgentState, type AgentStateBroadcast } from '../../src/shared/agents'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'D:/fixture' },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}))

const turn = globalThis.setImmediate
const fileWorkInFlight = (): boolean => process.getActiveResourcesInfo().some(name => /^(FSReq|FileHandle|CloseReq)/u.test(name))
async function settled(): Promise<void> {
  for (let quiet = 0; quiet < 3;) { await new Promise<void>(resolve => { turn(resolve) }); quiet = fileWorkInFlight() ? 0 : quiet + 1 }
}
async function pass(ms: number): Promise<void> { for (let elapsed = 0; elapsed < ms; elapsed += 5) { await vi.advanceTimersByTimeAsync(5); await settled() } }
async function until<T>(work: Promise<T>): Promise<T> {
  let done = false
  void work.then(() => { done = true }, () => { done = true })
  await settled()
  while (!done) { await vi.advanceTimersByTimeAsync(5); await settled() }
  return work
}
/** What crosses the bridge: structured clone, as Electron's IPC copies a message. */
const wire = <T>(value: T): T => deserialize(serialize(value)) as T

const roots: string[] = []
beforeAll(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }) })
afterAll(async () => { vi.useRealTimers(); for (const root of roots) await rm(root, { recursive: true, force: true }) })

const CHUNKS = 12
const THREADS = Number(process.env.SOTTO_PERF_THREADS ?? 1_070)
/** How long a whole read takes to be answered while main and the window are busy: about ten times Node's 85 ms for the trip. */
const WHOLE_READ_MS = Number(process.env.SOTTO_PERF_WHOLE_READ_MS ?? 500)

describe('the window’s structural sharing at the owner’s scale', () => {
  it.skipIf(!PERF_BENCH)('reports what sharing each state the window receives walks, part by part', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-switch-sharing-')); roots.push(root)
    const registry = ipcRegistry({ mainUrl: 'file:///main.html' })
    let deliver: ((event: unknown, payload: unknown) => void) | null = null
    const p = await until(ownerScalePipeline(root, { threads: THREADS / OWNER_SCALE.threads, history: 1 }, 3, 'owl',
      { window: (payload: AgentStateBroadcast) => { deliver?.({}, wire(payload)) } }))
    const unregister = registerAgentIpc(registry.ipc, p.router, p.router, () => [registry.main],
      { encodeReceipt: p.broadcaster.encodeReceipt, encodeChangedThreadRecordsReceipt: p.broadcaster.encodeChangedThreadRecordsReceipt, windowRead: p.broadcaster.windowRead,
        // As `src/main/index.ts` wires it, where main has it.
        ...('readWhole' in p.broadcaster ? { readWhole: (p.broadcaster as { readWhole: (state: AgentState) => AgentState }).readWhole } : {}) })
    const renderer = {
      invoke: async (channel: string, ...args: unknown[]) => wire(await registry.invoke(channel, args)),
      on: (channel: string, listener: (event: unknown, payload: unknown) => void) => { if (channel === AGENT_STATE) deliver = listener },
      removeListener: () => undefined,
    }
    const page = wrapAgentBridge(createSottoBridge(renderer, 'win32').agents!)
    const received: { kind: 'read' | 'broadcast' | 'select-thread' | 'observe-threads'; state: AgentState }[] = []
    try {
      page.onState(state => { received.push({ kind: 'broadcast', state }) })
      received.push({ kind: 'read', state: await until(page.get()) })
      await pass(1_000)
      const threads = received[0]!.state.host.threads
      const target = threads.find(thread => thread.id !== p.openThread && !p.streamSessions.includes(thread.id) && thread.kind !== 'watcher')!
      const stream = async (chunks: number): Promise<void> => {
        for (let chunk = 0; chunk < chunks; chunk++) {
          for (const session of p.streamSessions) p.adapter.log.appendText(session, 'reply', ` word${chunk}`)
          p.adapter.publish(true)
          await pass(250)
        }
      }
      const at = new Date().toISOString()
      for (const session of p.streamSessions) {
        p.adapter.log.add(session, { id: 'reply', role: 'assistant', text: 'First', createdAt: at })
        p.adapter.state.threads.find(item => item.id === session)!.status = 'running'; p.adapter.mark(session)
      }
      p.adapter.publish(true)
      await stream(CHUNKS)
      // The user picks a thread in the sidebar; its pane opens and the window says which panes it shows.
      received.push({ kind: 'select-thread', state: await until(page.command({ type: 'select-thread', threadId: target.id })) })
      received.push({ kind: 'observe-threads', state: await until(page.command({ type: 'observe-threads', threadIds: [target.id] })) })
      await stream(CHUNKS)
    } finally { unregister(); await until(p.stop()) }
    vi.useRealTimers()
    const report = shareReport(received)
    console.info(`thread switch sharing: ${JSON.stringify(report)}`)
    expect(received.length).toBeGreaterThan(2)
  }, 1_200_000)

  it.skipIf(!PERF_BENCH)('counts the whole reads one missed broadcast sets off while the window is slow to take a whole state in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
    const root = await mkdtemp(join(tmpdir(), 'sotto-switch-cascade-')); roots.push(root)
    const registry = ipcRegistry({ mainUrl: 'file:///main.html' })
    let deliver: ((event: unknown, payload: unknown) => void) | null = null
    let dropNext = false, everyRecord = 0, measuring = false
    const p = await until(ownerScalePipeline(root, { threads: THREADS / OWNER_SCALE.threads, history: 1 }, 3, 'owl',
      { window: (payload: AgentStateBroadcast) => {
        if (dropNext) { dropNext = false; return }
        if (measuring && (payload.host.threads as { base?: unknown } | undefined)?.base === null) everyRecord++
        deliver?.({}, wire(payload))
      } }))
    // `readWhole` where main has it: the complete list after a whole read marks the records it repeats (#2733). Without it,
    // main as it was.
    const broadcaster = p.broadcaster as typeof p.broadcaster & { readWhole?: (state: AgentState) => AgentState }
    const unregister = registerAgentIpc(registry.ipc, p.router, p.router, () => [registry.main],
      { encodeReceipt: broadcaster.encodeReceipt, encodeChangedThreadRecordsReceipt: broadcaster.encodeChangedThreadRecordsReceipt, windowRead: broadcaster.windowRead,
        ...(broadcaster.readWhole ? { readWhole: broadcaster.readWhole } : {}) })
    let wholeReads = 0
    const renderer = {
      invoke: async (channel: string, ...args: unknown[]) => {
        // A whole read takes this long to reach main and be answered while main and the window are busy. Broadcasts keep
        // landing meanwhile. This assumes the answer, once main has made it, reaches the page before what main sends after
        // it: the order the window most often sees, though Electron does not promise it. The page holds the other order too
        // (`tests/unit/renderer/wholeReadRepeats.test.ts`); this measures what the usual one costs.
        if (channel === AGENT_GET) { wholeReads++; await new Promise(resolve => { setTimeout(resolve, WHOLE_READ_MS) }) }
        return wire(await registry.invoke(channel, args))
      },
      on: (channel: string, listener: (event: unknown, payload: unknown) => void) => { if (channel === AGENT_STATE) deliver = listener },
      removeListener: () => undefined,
    }
    const page = wrapAgentBridge(createSottoBridge(renderer, 'win32').agents!)
    const received: { kind: string; state: AgentState }[] = []
    try {
      page.onState(state => { if (measuring) received.push({ kind: 'broadcast', state }) })
      received.push({ kind: 'read', state: await until(page.get()) })
      await pass(1_000)
      const threads = p.router.shell().host.threads
      const others = threads.filter(thread => thread.id !== p.openThread && !p.streamSessions.includes(thread.id) && thread.kind !== 'watcher').slice(0, 4)
      const at = new Date().toISOString()
      for (const session of p.streamSessions) {
        p.adapter.log.add(session, { id: 'reply', role: 'assistant', text: 'First', createdAt: at })
        p.adapter.state.threads.find(item => item.id === session)!.status = 'running'; p.adapter.mark(session)
      }
      p.adapter.publish(true)
      await pass(1_000)
      wholeReads = 0
      measuring = true
      dropNext = true
      // A minute of three threads streaming four times a second, the window saying which panes it shows every second and the
      // user switching thread every five, as on November 20.
      for (let second = 0; second < 60; second++) {
        for (let quarter = 0; quarter < 4; quarter++) {
          for (const session of p.streamSessions) p.adapter.log.appendText(session, 'reply', ` word${second}.${quarter}`)
          p.adapter.publish(true)
          await pass(250)
        }
        const target = others[Math.floor(second / 5) % others.length]!
        if (second % 5 === 0) void page.command({ type: 'select-thread', threadId: target.id }).then(state => { received.push({ kind: 'select-thread', state }) })
        void page.command({ type: 'observe-threads', threadIds: [target.id] }).then(state => { received.push({ kind: 'observe-threads', state }) })
      }
      await pass(3_000)
    } finally { unregister(); await until(p.stop()) }
    vi.useRealTimers()
    const shared = shareReport(received) as { byKind: Record<string, { states: number; msPerState: number; newThreadRecordsPerState: number }> }
    const newRecords = Object.values(shared.byKind).reduce((sum, row) => sum + row.states * row.newThreadRecordsPerState, 0)
    const ms = Object.values(shared.byKind).reduce((sum, row) => sum + row.states * row.msPerState, 0)
    console.info(`thread switch whole reads: ${JSON.stringify({ threads: THREADS, wholeReadMs: WHOLE_READ_MS, wholeReadsInAMinute: wholeReads,
      broadcastsListingEveryRecord: everyRecord, newThreadRecordsInTheMinute: Math.round(newRecords), sharingMsInTheMinute: round(ms, 1), slowestStates: (shared as { slowestStates?: unknown }).slowestStates, byKind: shared.byKind })}`)
    expect(wholeReads).toBeGreaterThan(0)
  }, 1_200_000)

  it.skipIf(!PERF_BENCH || !process.env.SOTTO_PERF_DATA)('reports the same with the owner’s own thread records and catalogs, sent as main sends them', async () => {
    vi.useRealTimers()
    const directory = await perfDataDirectory()
    expect(directory).not.toBeNull()
    // A parse error can quote the file it failed on, and this one holds what the owner's threads said: it is reported
    // without it.
    let workspace: { snapshot: AgentHostSnapshot }
    try { workspace = JSON.parse(await readFile(join(directory!, 'workspace.json'), 'utf8')) as { snapshot: AgentHostSnapshot } }
    catch { throw new Error('The selected folder’s workspace.json could not be read as JSON.') }
    const host = workspace.snapshot
    const broadcaster = new AgentStateBroadcaster()
    let deliver: ((event: unknown, payload: unknown) => void) | null = null
    let answer: unknown = null
    const renderer = {
      invoke: async (channel: string) => { if (channel !== AGENT_COMMAND) throw new Error(`No ${channel} in this benchmark.`); return wire(answer) },
      on: (channel: string, listener: (event: unknown, payload: unknown) => void) => { if (channel === AGENT_STATE) deliver = listener },
      removeListener: () => undefined,
    }
    const page = wrapAgentBridge(createSottoBridge(renderer, 'win32').agents!)
    const received: { kind: 'read' | 'broadcast' | 'select-thread' | 'observe-threads'; state: AgentState }[] = []
    page.onState(state => { received.push({ kind: received.length === 0 ? 'read' : 'broadcast', state }) })
    // As the desktop's router hands the window every state: scoped to this desktop's hosts, this computer's among them.
    let state = { ...agentShell(stateAround(host, host.threads[0]!.id)), clientScoped: true,
      connections: [{ hostId: host.hostId!, kind: 'local', name: 'This computer', connected: true }] } as unknown as AgentState
    const send = (next: AgentState): void => { state = next; broadcaster.send(next, payload => { deliver?.({}, wire(payload)); return true }) }
    send(state)
    // Three threads stream: each broadcast carries their records changed, every other record the very one main sent before.
    const streaming = (tick: number): AgentState => ({ ...state, host: { ...state.host,
      threads: state.host.threads.map((thread, index) => index < 3 ? { ...thread, status: 'running' as const, updatedAt: new Date(Date.UTC(2026, 10, 20, 18, 0, tick)).toISOString() } : thread) } })
    for (let tick = 1; tick <= CHUNKS; tick++) send(streaming(tick))
    const target = host.threads[10]!
    const selected = { ...state, activeThreadId: target.id, activeProjectId: target.projectId }
    broadcaster.replyBuilt(selected)
    answer = broadcaster.encodeChangedThreadRecordsReceipt(selected)
    received.push({ kind: 'select-thread', state: await page.command({ type: 'select-thread', threadId: target.id }) })
    send(selected)
    for (let tick = CHUNKS + 1; tick <= 2 * CHUNKS; tick++) send(streaming(tick))
    const report = shareReport(received)
    console.info(`thread switch sharing, owner's records: ${JSON.stringify({ models: host.models.length, ...report })}`)
    expect(received.length).toBeGreaterThan(2)
  }, 1_200_000)
})

/** The states shared one after another, as the window's session shares each state it commits, part by part on the real clock. */
function shareReport(received: readonly { kind: string; state: AgentState }[]): Record<string, unknown> {
    const share = createStateSharing()
    const parts = new Map<string, { ms: number; walks: number }>()
    const byKind = new Map<string, { states: number; ms: number; newThreadRecords: number }>()
    // The commits after the first, slowest first: where a state taken in anew costs.
    const slowest: { kind: string; ms: number; newThreadRecords: number }[] = []
    let previous = received[0]!.state
    let shared: AgentState = share(undefined, previous)
    // A record the sharing has met before is found by identity and costs nothing; one it never met is walked whole.
    const met = new WeakSet<object>(previous.host.threads)
    for (const { kind, state } of received.slice(1)) {
      const newRecords = state.host.threads.filter(thread => !met.has(thread)).length
      for (const thread of state.host.threads) met.add(thread)
      let total = 0
      const next: Record<string, unknown> = {}
      const time = (name: string, before: unknown, after: unknown): unknown => {
        const started = performance.now()
        const value = share(before, after)
        const ms = performance.now() - started
        total += ms
        if (!Object.is(before, after)) { const part = parts.get(name) ?? { ms: 0, walks: 0 }; part.ms += ms; part.walks += 1; parts.set(name, part) }
        return value
      }
      for (const key of Object.keys(state)) {
        if (key !== 'host') { next[key] = time(key, (shared as unknown as Record<string, unknown>)[key], (state as unknown as Record<string, unknown>)[key]); continue }
        const host: Record<string, unknown> = {}
        for (const hostKey of Object.keys(state.host)) host[hostKey] = time(`host.${hostKey}`, (shared.host as unknown as Record<string, unknown>)[hostKey], (state.host as unknown as Record<string, unknown>)[hostKey])
        next.host = host
      }
      shared = next as unknown as AgentState
      previous = state
      slowest.push({ kind, ms: total, newThreadRecords: newRecords })
      const row = byKind.get(kind) ?? { states: 0, ms: 0, newThreadRecords: 0 }
      row.states += 1; row.ms += total; row.newThreadRecords += newRecords
      byKind.set(kind, row)
    }
    void previous
    return {
      threads: received[0]!.state.host.threads.length, states: received.length,
      slowestStates: slowest.sort((a, b) => b.ms - a.ms).slice(0, 3).map(row => ({ kind: row.kind, ms: round(row.ms, 1), newThreadRecords: row.newThreadRecords })),
      byKind: Object.fromEntries([...byKind].map(([kind, row]) => [kind, { states: row.states, msPerState: round(row.ms / row.states, 2), newThreadRecordsPerState: round(row.newThreadRecords / row.states, 1) }])),
      parts: Object.fromEntries([...parts].sort((a, b) => b[1].ms - a[1].ms).slice(0, 15).map(([name, part]) => [name, { ms: round(part.ms, 1), walks: part.walks }])),
    }
}
