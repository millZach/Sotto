// @vitest-environment node
/**
 * The data-transfer benchmark (October 29, 2026): what main moves, serializes and writes per streamed chunk and per user
 * action at the owner's scale, measured on the pipeline `src/main/index.ts` wires (`ownerScalePipeline.ts`): bytes and
 * messages per second on each window channel, what crosses to the thread store's worker, each JSON file written, and the
 * calls and time of the store reads, flushes and saves that grow with history. With `SOTTO_AUDIT_SOCKET=1` and
 * `-t "host socket"`, the host's socket over the same main: what it sends a desktop and a phone per push, and what the
 * desktop's client of that host, its router and its window broadcast spend per push. It prints JSON and asserts nothing,
 * so it runs only under `SOTTO_PERF_BENCH=1` (`docs/perf/2026-10-29-data-transfer.md`).
 *
 *   SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/dataTransfer.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *
 * Switches: `SOTTO_AUDIT_TRACK=stable`; `SOTTO_AUDIT_LONG=0` for short threads (long ones hold 2,000 activity records of
 * about 3 KB and 550 messages, the size of forge's longest real threads); `SOTTO_AUDIT_WATCHER=<scale>`;
 * `SOTTO_AUDIT_PROFILE=<scenario,...>` writes a CPU profile of each named scenario to the temporary folder;
 * `SOTTO_AUDIT_STACKS=1` names where each post to the store worker over 1 MB was made.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Session } from 'node:inspector/promises'
import { writeFileSync } from 'node:fs'
import { serialize } from 'node:v8'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { immutableActivities } from '../../src/main/agents/activitySnapshots'
import { AgentStateBroadcaster } from '../../src/main/agents/agentStateBroadcast'
import { StoreWorker } from '../../src/main/agents/storeWorker'
import { ThreadStoreWriterOnWorker } from '../../src/main/agents/threadStoreWriter'
import { AtomicJsonStore } from '../../src/main/storage/atomicJsonStore'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { WatcherLaunchProfiles } from '../../src/main/agents/watcherLaunchProfiles'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { AgentControl } from '../../src/main/agents/control'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { AgentState } from '../../src/shared/agents'
import { ownerScalePipeline, type OwnerScalePipeline, type OwnerScaleTrack } from '../fixtures/ownerScalePipeline'
import { median } from '../fixtures/perfBench'

const BENCH = process.env.SOTTO_PERF_BENCH === '1'
/** `SOTTO_AUDIT_STRINGIFY_SITES=1`: where each counted `JSON.stringify` call was made, three frames deep. */
const STRINGIFY_SITES = process.env.SOTTO_AUDIT_STRINGIFY_SITES === '1'
const TRACK = (process.env.SOTTO_AUDIT_TRACK ?? 'owl') as OwnerScaleTrack
const WATCHER_SCALE = Number(process.env.SOTTO_AUDIT_WATCHER ?? '1')
const LONG = process.env.SOTTO_AUDIT_LONG !== '0'

interface Channel { messages: number; bytes: number; max: number; encodeMs: number }
interface Tally {
  channels: Record<string, Channel>
  files: Record<string, { writes: number; bytes: number }>
  stringify: { calls: number; chars: number; ms: number }
  clone: { calls: number; ms: number }
  threadsChangedPerBroadcast: number[]
  stateParts: Record<string, number>
  wireMs: number; wireIds: number; wireRecords: number
  bigPosts: Record<string, number>
  methods: Record<string, { calls: number; ms: number; size: number }>
  stringifySites: Record<string, number>
}
const fresh = (): Tally => ({ channels: {}, files: {}, stringify: { calls: 0, chars: 0, ms: 0 }, clone: { calls: 0, ms: 0 }, threadsChangedPerBroadcast: [], stateParts: {}, wireMs: 0, wireIds: 0, wireRecords: 0, bigPosts: {}, methods: {}, stringifySites: {} })
/** The fake clock fakes `performance`; time work on the machine's own clock. */
const realNow = (): number => Number(process.hrtime.bigint()) / 1e6
let tally = fresh()
let on = false
let hookMs = 0

function sized(value: unknown): { bytes: number; ms: number } {
  const started = realNow()
  let bytes: number
  try { bytes = serialize(value).byteLength } catch { bytes = -1 }
  const ms = realNow() - started
  hookMs += ms
  return { bytes, ms }
}
function channel(name: string, value: unknown): void {
  if (!on) return
  const { bytes, ms } = sized(value)
  const entry = tally.channels[name] ??= { messages: 0, bytes: 0, max: 0, encodeMs: 0 }
  entry.messages++; entry.bytes += bytes; entry.max = Math.max(entry.max, bytes); entry.encodeMs += ms
}

// The window's detail publisher and Watcher's room publisher send to a callback the fixture passes in; wrap both.
vi.mock('../../src/main/agents/control', async original => {
  const actual = await original<typeof import('../../src/main/agents/control')>()
  return { ...actual, coalesceAgentThreadDetailPublishes: ((send, options) => actual.coalesceAgentThreadDetailPublishes(update => { channel('window detail', update); send(update) }, options)) as typeof actual.coalesceAgentThreadDetailPublishes }
})
vi.mock('../../src/main/agents/watcherRoomDesktop', async original => {
  const actual = await original<typeof import('../../src/main/agents/watcherRoomDesktop')>()
  return { ...actual, createWatcherRoomDesktop: ((options: Parameters<typeof actual.createWatcherRoomDesktop>[0]) => actual.createWatcherRoomDesktop({ ...options, send: payload => { channel('window watcher room', payload); return options.send(payload) } })) as typeof actual.createWatcherRoomDesktop }
})

const nativeSend = AgentStateBroadcaster.prototype.send
const nativeWrite = (AtomicJsonStore.prototype as unknown as { writeImmediately(serialized: unknown): Promise<void> }).writeImmediately
const nativePost = ThreadStoreWriterOnWorker.prototype.post
const nativeStringify = JSON.stringify
const nativeClone = globalThis.structuredClone
let depth = 0
const handle = StoreWorker.prototype as unknown as { wire(this: unknown, write: unknown, preserved: () => readonly string[]): unknown; list(this: unknown, entry: unknown): unknown }
const wire = handle.wire
const wireContext: { sent: Map<string, unknown>; nextVersion: number; list(entry: unknown): unknown } = { sent: new Map(), nextVersion: 1, list(entry) { return handle.list.call(this, entry) } }

/** Calls, real milliseconds and a size of what each counted method returned or read, by name. */
const COUNTED: [object, string, string, ((result: unknown, args: unknown[]) => number)?][] = [
  [ThreadStore.prototype, 'readMessages', 'store.readMessages', result => (result as { messages?: { text: string }[] }).messages?.reduce((n, m) => n + m.text.length, 0) ?? 0],
  [ThreadStore.prototype, 'summaryMessages', 'store.summaryMessages', result => Object.values(result as Record<string, { text?: string } | undefined>).reduce((n, m) => n + (m?.text?.length ?? 0), 0)],
  [ThreadStore.prototype, 'readActivities', 'store.readActivities', result => (result as unknown[]).length],
  [WatcherLaunchProfiles.prototype, 'readIdentity', 'watcherProfiles.readIdentity'],
  [WorkspaceHost.prototype, 'flush', 'workspace.flush'],
  [WorkspaceHost.prototype, 'watcherRead', 'workspace.watcherRead'],
  [WorkspaceHost.prototype, 'trackSubagents', 'workspace.trackSubagents'],
  [WorkspaceHost.prototype, 'applyEvents', 'workspace.applyEvents'],
  [AgentControl.prototype, 'persist', 'control.persist'],
  [AgentControl.prototype, 'mutateWatcher', 'control.mutateWatcher'],
]
const nativeMethods = new Map<string, (...args: unknown[]) => unknown>()
function count(name: string, ms: number, size: number): void {
  if (!on) return
  const entry = tally.methods[name] ??= { calls: 0, ms: 0, size: 0 }
  entry.calls++; entry.ms += ms; entry.size += size
}
function install(): void {
  for (const [target, method, name, size] of COUNTED) {
    const native = (target as Record<string, (...args: unknown[]) => unknown>)[method]
    if (typeof native !== 'function') throw new Error(`No ${name} to count`)
    nativeMethods.set(name, native)
    ;(target as Record<string, unknown>)[method] = function (this: unknown, ...args: unknown[]) {
      const started = realNow()
      const result = native.apply(this, args)
      if (result instanceof Promise) return result.then(value => { count(name, realNow() - started, size ? size(value, args) : 0); return value })
      count(name, realNow() - started, size ? size(result, args) : 0)
      return result
    }
  }
  AgentStateBroadcaster.prototype.send = function (this: AgentStateBroadcaster, state, deliver) {
    return nativeSend.call(this, state, payload => {
      if (on) {
        channel('window state', payload)
        tally.threadsChangedPerBroadcast.push(payload.host.threads.changed.length)
        const { host, ...rest } = payload
        const { threads, models, ...hostRest } = host as typeof host & { models: unknown }
        for (const [key, value] of Object.entries({ threads, models, ...Object.fromEntries(Object.entries(hostRest).map(([k, v]) => [`host.${k}`, v])), ...rest }))
          tally.stateParts[key] = (tally.stateParts[key] ?? 0) + sized(value).bytes
      }
      return deliver(payload)
    })
  }
  ;(AtomicJsonStore.prototype as unknown as { writeImmediately(serialized: unknown): Promise<void> }).writeImmediately = function (this: { filePath: string }, serialized: unknown) {
    if (on) {
      const name = basename(this.filePath)
      const bytes = typeof serialized === 'string' ? Buffer.byteLength(serialized) : (serialized as Uint8Array[]).reduce((n, chunk) => n + chunk.byteLength, 0)
      const entry = tally.files[name] ??= { writes: 0, bytes: 0 }
      entry.writes++; entry.bytes += bytes
    }
    return nativeWrite.call(this, serialized)
  }
  // What crosses to the store worker is the wire the worker's handle makes of each write: a list it was sent before goes as
  // the records that changed since, plus every ID. Built here with the handle's own `wire`, against one memory of what was
  // sent kept across scenarios, as the worker's handle keeps it.
  ThreadStoreWriterOnWorker.prototype.post = function (this: ThreadStoreWriterOnWorker, write, confirm) {
    const started = realNow()
    const wired = wire.call(wireContext, write, () => [])
    const wireMs = realNow() - started
    if (on) {
      channel('store worker wire', wired)
      if (process.env.SOTTO_AUDIT_STACKS === '1') {
        const bytes = serialize(wired).byteLength
        if (bytes > 1_000_000) {
          const where = (new Error().stack ?? '').split('\n').filter(line => line.includes('/src/')).slice(0, 8).map(line => line.trim().replace(/.*\/src\//u, 'src/')).join(' <- ')
          tally.bigPosts[where] = (tally.bigPosts[where] ?? 0) + bytes
        }
      }
      tally.wireMs += wireMs
      const entries = (wired as { entries?: unknown[] }).entries ?? ((wired as { entry?: unknown }).entry ? [(wired as { entry: unknown }).entry] : [])
      for (const entry of entries as { ids?: unknown[]; changed?: unknown[]; whole?: unknown[] }[]) { tally.wireIds += entry.ids?.length ?? 0; tally.wireRecords += (entry.changed?.length ?? 0) + (entry.whole?.length ?? 0) }
    }
    hookMs += wireMs
    return nativePost.call(this, write, confirm)
  }
  JSON.stringify = function (...args: Parameters<typeof JSON.stringify>) {
    if (!on || depth > 0) return nativeStringify(...args)
    depth++
    const started = realNow()
    try {
      const text = nativeStringify(...args)
      tally.stringify.calls++; tally.stringify.chars += text?.length ?? 0; tally.stringify.ms += realNow() - started
      if (STRINGIFY_SITES) {
        const where = (new Error().stack ?? '').split('\n').filter(line => line.includes('/src/')).slice(0, 3).map(line => line.trim().replace(/.*\/src\//u, 'src/').replace(/\)$/u, '')).join(' <- ')
        tally.stringifySites[where] = (tally.stringifySites[where] ?? 0) + 1
      }
      return text
    } finally { depth-- }
  } as typeof JSON.stringify
  globalThis.structuredClone = function <T>(value: T, options?: StructuredSerializeOptions): T {
    if (!on) return nativeClone(value, options)
    const started = realNow()
    try { return nativeClone(value, options) } finally { tally.clone.calls++; tally.clone.ms += realNow() - started }
  }
}
function uninstall(): void {
  for (const [target, method, name] of COUNTED) (target as Record<string, unknown>)[method] = nativeMethods.get(name)
  AgentStateBroadcaster.prototype.send = nativeSend
  ;(AtomicJsonStore.prototype as unknown as { writeImmediately: typeof nativeWrite }).writeImmediately = nativeWrite
  ThreadStoreWriterOnWorker.prototype.post = nativePost
  JSON.stringify = nativeStringify
  globalThis.structuredClone = nativeClone
}

// The fake clock, stepped as ownerScaleWorkBudget steps it, waiting for file work between steps.
const STEP_MS = 5
const turn = globalThis.setImmediate
const fileWorkInFlight = (): boolean => process.getActiveResourcesInfo().some(name => /^(FSReq|FileHandle|CloseReq)/u.test(name))
async function filesSettled(): Promise<void> {
  for (let quiet = 0; quiet < 3;) {
    await new Promise<void>(resolve => { turn(resolve) })
    quiet = fileWorkInFlight() ? 0 : quiet + 1
  }
}
async function step(ms = STEP_MS): Promise<void> { await vi.advanceTimersByTimeAsync(ms); await filesSettled() }
async function pass(ms: number): Promise<void> { for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) await step() }
async function until<T>(work: Promise<T>): Promise<T> {
  let done = false
  void work.then(() => { done = true }, () => { done = true })
  await filesSettled()
  for (let elapsed = 0; !done; elapsed += STEP_MS) { if (elapsed > 120_000) throw new Error('not done'); await step() }
  return work
}

interface Result {
  simulatedMs: number; cpuMs: number; harnessMs: number
  channels: Record<string, Channel & { perSecond: number }>
  files: Tally['files']; stringify: Tally['stringify']; clone: Tally['clone']
  threadsChangedPerBroadcast: { mean: number; max: number }
  statePartsBytesPerBroadcast: Record<string, number>
  wire: { ms: number; ids: number; records: number }
  bigPosts: Record<string, number>
  methods: Tally['methods']
  stringifySites?: Record<string, number>
}
const PROFILE = new Set((process.env.SOTTO_AUDIT_PROFILE ?? '').split(',').filter(Boolean))
async function scenario(work: () => Promise<void>, settleMs = 1_000, name = ''): Promise<Result> {
  const session = PROFILE.has(name) ? new Session() : undefined
  if (session) { session.connect(); await session.post('Profiler.enable'); await session.post('Profiler.setSamplingInterval', { interval: 200 }); await session.post('Profiler.start') }
  try { return await measured(work, settleMs) } finally {
    if (session) { const { profile } = await session.post('Profiler.stop'); writeFileSync(join(tmpdir(), `sotto-transfer-${name.replace(/\W+/gu, '-')}.cpuprofile`), nativeStringify(profile)); session.disconnect() }
  }
}
async function measured(work: () => Promise<void>, settleMs: number): Promise<Result> {
  tally = fresh(); hookMs = 0
  const clock = Date.now()
  const cpu = process.cpuUsage()
  on = true
  try { await work(); await pass(settleMs) } finally { on = false }
  const used = process.cpuUsage(cpu)
  const simulatedMs = Date.now() - clock
  const broadcasts = tally.channels['window state']?.messages ?? 0
  const round = (n: number) => Math.round(n * 100) / 100
  return {
    simulatedMs, cpuMs: round((used.user + used.system) / 1000 - hookMs), harnessMs: round(hookMs),
    channels: Object.fromEntries(Object.entries(tally.channels).map(([name, c]) => [name, { ...c, encodeMs: round(c.encodeMs), perSecond: round(c.messages / (simulatedMs / 1000)) }])),
    files: tally.files, stringify: { ...tally.stringify, ms: round(tally.stringify.ms) }, clone: { ...tally.clone, ms: round(tally.clone.ms) },
    threadsChangedPerBroadcast: { mean: round(tally.threadsChangedPerBroadcast.reduce((a, b) => a + b, 0) / Math.max(1, tally.threadsChangedPerBroadcast.length)), max: Math.max(0, ...tally.threadsChangedPerBroadcast) },
    wire: { ms: round(tally.wireMs), ids: tally.wireIds, records: tally.wireRecords }, bigPosts: tally.bigPosts, ...STRINGIFY_SITES ? { stringifySites: Object.fromEntries(Object.entries(tally.stringifySites).sort((a, b) => b[1] - a[1]).slice(0, 12)) } : {}, methods: Object.fromEntries(Object.entries(tally.methods).map(([k, v]) => [k, { ...v, ms: round(v.ms) }])),
    statePartsBytesPerBroadcast: Object.fromEntries(Object.entries(tally.stateParts).map(([key, bytes]) => [key, Math.round(bytes / Math.max(1, broadcasts))]).sort((a, b) => (b[1] as number) - (a[1] as number))),
  }
}

function activities(prefix: string, count: number): AgentActivity[] {
  return Array.from({ length: count }, (_, position): AgentActivity => ({ id: `${prefix}-a${position}`, turnId: `${prefix}-t${Math.floor(position / 4)}`,
    sequence: position, kind: 'command', status: 'completed', title: `Synthetic command ${position}`, output: `${prefix}:${position}:`.padEnd(3_000, `${position} lorem ipsum dolor sit amet `) }))
}

/**
 * Long, real-looking histories: 275 turns of messages and 2,000 activity records of about 3 KB on each of `sessions`, as the
 * longest threads on forge hold, and the records alone on each of `recordsOnly`.
 */
async function lengthen(p: OwnerScalePipeline, sessions: readonly string[], recordsOnly: readonly string[] = []): Promise<void> {
  const at = new Date().toISOString()
  for (const session of sessions) for (let turnIndex = 0; turnIndex < 275; turnIndex++) {
    p.adapter.log.add(session, { id: `${session}-u${turnIndex}`, role: 'user', text: `Synthetic question ${turnIndex} `.repeat(8), createdAt: at })
    p.adapter.log.add(session, { id: `${session}-r${turnIndex}`, role: 'assistant', text: `Synthetic answer paragraph ${turnIndex}. `.repeat(40), createdAt: at })
  }
  for (const session of [...sessions, ...recordsOnly]) {
    p.adapter.state.threads.find(item => item.id === session)!.activities = activities(session, 2_000)
    p.adapter.mark(session)
  }
  p.adapter.publish(false)
  await pass(1_000)
}

/** An idle thread of this computer that no window observes and Watcher does not watch. */
const BACKGROUND = 'idle-20'
const roots: string[] = []
const results: Record<string, unknown> = {}
let pipeline: OwnerScalePipeline | undefined

beforeAll(() => { install(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }) })
afterAll(async () => {
  vi.useRealTimers(); uninstall()
  for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
})

it.skipIf(!BENCH)('measures what main moves per chunk and per action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-transfer-audit-')); roots.push(root)
  pipeline = await until(ownerScalePipeline(root, { threads: 1, history: 1, watcher: WATCHER_SCALE }, 3, TRACK))
  const p = pipeline
  await pass(1_000)
  if (LONG) await lengthen(p, p.streamSessions, [BACKGROUND])
  // The window's whole read of state on load (AGENT_GET), and the coordinator's whole shell.
  const whole = p.router.shell() as AgentState
  results.wholeStateBytes = serialize(whole).byteLength
  results.wholeStateJsonBytes = Buffer.byteLength(nativeStringify(whole))
  results.wholeStateThreads = whole.host.threads.length
  results.idle = await scenario(async () => { await pass(10_000) }, 0, 'idle')
  // A1: a command's reply to the window, as the preload takes it (zod) and the page shares it, and A7: the startup shell
  // the page caches every 2 s. Timed on the machine's clock, median of 15.
  {
    const { agentCommandReceiptSchema } = await import('../../src/shared/agents')
    const { createStateSharing } = await import('../../src/renderer/src/agents/stateSharing')
    const { cacheableShell } = await import('../../src/renderer/src/agents/shellCache')
    const { desktopWindowClient } = await import('../../src/main/agents/hostService')
    const encoder = new AgentStateBroadcaster()
    const replies: unknown[] = []
    for (let index = 0; index < 16; index++) {
      const result = await until(p.router.command({ type: 'save-thread-draft', composer: 'manual', threadId: p.openThread, draftId: `00000000-0000-4000-a000-${index.toString(16).padStart(12, '0')}`, text: `Synthetic draft ${index}`, attachments: [], requestId: null }, desktopWindowClient()))
      replies.push(encoder.encodeReceipt(result as AgentState))
    }
    const timed = (work: (index: number) => unknown) => { const samples: number[] = []; for (let index = 1; index < replies.length; index++) { const started = realNow(); work(index); samples.push(realNow() - started) } return Math.round(median(samples) * 100) / 100 }
    const decoded = replies.map(reply => structuredClone(reply))
    const sharing = createStateSharing()
    sharing(undefined, decoded[0])
    results.commandReply = { bytes: serialize(replies[0]).byteLength, threads: (replies[0] as AgentState).host.threads.length,
      zodParseMs: timed(index => agentCommandReceiptSchema.parse(decoded[index])), structuredCloneMs: timed(index => structuredClone(replies[index])),
      shareMs: timed(index => sharing(decoded[index - 1], decoded[index])) }
    const cached = cacheableShell(whole)
    const started = realNow(), text = nativeStringify(cached)
    results.shellCache = { chars: text.length, stringifyMs: Math.round((realNow() - started) * 100) / 100 }
  }
  for (const streams of [1, 3]) {
    const sessions = p.streamSessions.slice(0, streams)
    const at = new Date().toISOString()
    for (const session of sessions) {
      const thread = p.adapter.state.threads.find(item => item.id === session)!
      p.adapter.log.add(session, { id: `prompt-${streams}`, role: 'user', text: 'Synthetic prompt', createdAt: at }); thread.status = 'running'; p.adapter.mark(session)
      p.adapter.log.add(session, { id: `reply-${streams}`, role: 'assistant', text: 'First', createdAt: at })
    }
    p.adapter.publish(true)
    await pass(1_000)
    // About twenty chunks a second for three seconds, as a provider streams.
    results[`${streams} streaming`] = await scenario(async () => {
      for (let chunk = 0; chunk < 60; chunk++) {
        for (const session of sessions) p.adapter.log.appendText(session, `reply-${streams}`, ` word${chunk} and some more text`)
        p.adapter.publish(true)
        await pass(50)
      }
    }, 1_000, `${streams} streaming`)
    for (const session of sessions) { p.adapter.state.threads.find(item => item.id === session)!.status = 'idle'; p.adapter.mark(session) }
    p.adapter.publish(false)
    await pass(1_000)
  }
  // A6: a command's output streaming into the running record of a watched thread, 60 chunks of 400 characters.
  {
    const session = p.streamSessions[0]!
    const thread = p.adapter.state.threads.find(item => item.id === session)!
    thread.status = 'running'
    let output = ''
    const runningRecord = (): AgentActivity => ({ id: `${session}-running`, turnId: `${session}-t-run`, sequence: 100_000, kind: 'command', status: 'running', title: 'Synthetic build', output })
    thread.activities = immutableActivities([...thread.activities ?? [], runningRecord()])
    p.adapter.mark(session); p.adapter.publish(true); await pass(1_000)
    results['command output streaming'] = await scenario(async () => {
      for (let chunk = 0; chunk < 60; chunk++) {
        output += `line ${chunk} of the synthetic build log `.padEnd(400, '.')
        thread.activities = immutableActivities([...thread.activities!.slice(0, -1), runningRecord()])
        p.adapter.mark(session); p.adapter.publish(true); await pass(50)
      }
    }, 1_000, 'command output streaming')
    thread.status = 'idle'; p.adapter.mark(session); p.adapter.publish(false); await pass(1_000)
  }
  for (const [name, action] of Object.entries(p.actions)) results[name] = await scenario(() => until(action()), 1_000, name)
  // Typing an answer saves it at every pause: the next save, after the first, is what each pause costs.
  results['saveAnswerDraft again'] = await scenario(() => until(p.actions.saveAnswerDraft()), 1_000, 'saveAnswerDraft again')
  // Two turns of a thread nobody is looking at, a second apart, each adding one activity record (C1).
  results['background turns'] = await scenario(async () => {
    const thread = p.adapter.state.threads.find(item => item.id === BACKGROUND)!
    for (let turnIndex = 0; turnIndex < 2; turnIndex++) {
      thread.status = 'running'
      p.adapter.log.add(BACKGROUND, { id: `bg-u${turnIndex}`, role: 'user', text: 'Synthetic background prompt', createdAt: new Date().toISOString() })
      p.adapter.mark(BACKGROUND); p.adapter.publish(true); await pass(200)
      thread.activities = immutableActivities([...thread.activities ?? [], ...activities(`${BACKGROUND}-turn${turnIndex}`, 1)])
      p.adapter.mark(BACKGROUND); p.adapter.publish(true); await pass(200)
      thread.status = 'idle'; p.adapter.mark(BACKGROUND); p.adapter.publish(false); await pass(1_000)
    }
  }, 1_000, 'background turns')
  console.log(`DATA-TRANSFER ${nativeStringify({ track: TRACK, watcherScale: WATCHER_SCALE, long: LONG, counts: p.counts, ...results }, null, 1)}`)
  await until(p.stop())
  vi.clearAllTimers()
  expect(results.idle).toBeDefined()
}, 900_000)

/**
 * The host socket over the same owner-scale main: a desktop and an iPhone paired with it, each saying hello as its client
 * does and observing the threads that stream, while one and then three threads stream. Counts what each peer is sent:
 * frames by event and their bytes before compression, and for the desktop, which negotiates permessage-deflate, the bytes
 * at deflate level 6 as well.
 */
it.skipIf(!BENCH || process.env.SOTTO_AUDIT_SOCKET !== '1')('measures what the host socket sends a desktop and a phone per push', async () => {
  const { LocalHostService } = await import('../../src/main/agents/hostService')
  const { PairedClients } = await import('../../src/main/agents/pairing')
  const { startSocketServer } = await import('../../src/host/socketServer')
  const { rawPeer } = await import('../fixtures/rawHostPeer')
  const { deflateRawSync } = await import('node:zlib')
  const root = await mkdtemp(join(tmpdir(), 'sotto-transfer-socket-')); roots.push(root)
  const p = await until(ownerScalePipeline(root, { threads: 1, history: 1, watcher: WATCHER_SCALE }, 3, TRACK))
  await pass(1_000)
  if (LONG) await lengthen(p, p.streamSessions)
  const service = new LocalHostService({ control: p.control, events: p.workspace, ...(p.watcher ? { watcher: p.watcher } : {}) })
  const pairing = new PairedClients(root)
  await until(pairing.load())
  const sessions: string[] = []
  for (const name of ['Desktop', 'iPhone']) {
    const paired = await until(pairing.redeem(pairing.issuePairingCode().code, name))
    sessions.push(pairing.signSession(paired.clientId))
  }
  const server = await until(startSocketServer({ service, pairing, port: 0 }))
  // Phones on a listener of their own, as the desktop's phone listener runs (admin: false): its peers are phones.
  const phoneServer = await until(startSocketServer({ service, pairing, port: 0, admin: false, observationKey: 'phones' }))
  const hostId = p.control.hostId()!
  // Real socket I/O between steps of the fake clock.
  const io = async (turns = 20): Promise<void> => { for (let index = 0; index < turns; index++) await new Promise<void>(resolve => { turn(resolve) }) }
  const desktop = await rawPeer(server.descriptor.port, sessions[0]!, { offer: 'permessage-deflate; client_no_context_takeover; server_no_context_takeover' })
  const phone = await rawPeer(phoneServer.descriptor.port, sessions[1]!)
  const ask = async (peer: Awaited<ReturnType<typeof rawPeer>>, id: string, operation: Record<string, unknown>): Promise<void> => {
    peer.frames.send({ v: 1, id, session: peer === desktop ? sessions[0] : sessions[1], ...operation })
    for (let waited = 0; !peer.messages.some(message => message.id === id); waited++) { if (waited > 4_000) throw new Error(`no answer to ${id}`); await step(); await io(2) }
  }
  const desktopAccepts = ['client-liveness', 'detail-delta', 'message-aliases', 'client-updates', 'client-update-not-listed', 'answer-receipts', 'usage-history', 'usage-muse-opencode', 'model-catalog-revision', 'host-update', 'activity-bodies', 'provider-opencode', 'provider-cursor', 'watcher-reads']
  await ask(desktop, 'hello', { op: 'hello', afterSeq: 9_007_199_254_740_991, accepts: desktopAccepts })
  await ask(phone, 'hello', { op: 'hello', afterSeq: 9_007_199_254_740_991, accepts: ['detail-delta', 'client-liveness', 'activity-summaries', 'model-catalog-revision', 'provider-opencode', 'provider-cursor'] })
  const helloBytes = { desktop: Buffer.byteLength(nativeStringify(desktop.messages.find(message => message.id === 'hello'))), phone: Buffer.byteLength(nativeStringify(phone.messages.find(message => message.id === 'hello'))) }
  const streamIds = p.streamSessions.map(session => p.control.shell().host.threads.find(thread => thread.title === `Synthetic thread ${session}`)?.id).filter((id): id is string => id !== undefined)
  // The desktop's own client of this host, as main runs it for a paired host: its work per push is profiled below.
  const { SocketHostService } = await import('../../src/main/agents/socketHostService')
  const forge = await until(pairing.redeem(pairing.issuePairingCode().code, 'Main desktop'))
  const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: forge.token })
  let clientPushes = 0
  const offClient = client.subscribe(() => { clientPushes++ })
  {
    let done = false
    void client.connect().then(() => { done = true }, error => { done = true; console.log('client connect failed', String(error)) })
    for (let waited = 0; !done; waited++) { if (waited > 4_000) throw new Error('client did not connect'); await step(); await io(2) }
    let observed = false
    void client.observe(streamIds).then(() => { observed = true }, () => { observed = true })
    for (let waited = 0; !observed; waited++) { if (waited > 4_000) throw new Error('client did not observe'); await step(); await io(2) }
  }
  // The desktop's router and window broadcast over that client, as a desktop paired with this host runs them.
  const { DesktopHostRouter } = await import('../../src/main/hosts/desktopHostRouter')
  const { emptyDesktopState } = await import('../../src/main/hosts/inactiveLocalHost')
  const { coalesceAgentStatePublishes } = await import('../../src/main/agents/control')
  const desktopRouter = new DesktopHostRouter(() => emptyDesktopState('11111111-2222-4333-8444-555555555555'), { watcherEnabled: TRACK === 'owl', heldProviders: new Set(), streamingPublishCost: TRACK === 'owl' })
  desktopRouter.add({ hostId, name: 'forge', kind: 'remote', service: client as never, detail: () => null, preview: () => ({ ok: false }) as never, observe: async () => undefined } as never)
  const desktopBroadcaster = new AgentStateBroadcaster()
  let desktopBroadcastBytes = 0, desktopBroadcasts = 0
  const desktopPublisher = coalesceAgentStatePublishes(next => { desktopBroadcaster.send(next, payload => { desktopBroadcasts++; desktopBroadcastBytes += serialize(payload).byteLength; return true }) })
  const offDesktop = desktopRouter.subscribe(next => desktopPublisher.publish(next))
  const opened: Record<string, number> = {}
  for (const [name, peer] of [['desktop', desktop], ['phone', phone]] as const) {
    const before = peer.messages.length
    await ask(peer, `observe-${name}`, { op: 'observe', threadIds: streamIds })
    await pass(500); await io()
    opened[name] = peer.messages.slice(before).reduce((n, message) => n + Buffer.byteLength(nativeStringify(message)), 0)
  }
  const report: Record<string, unknown> = { helloBytes, openBytes: opened, streamThreads: streamIds.length }
  const tallyPeer = (messages: Record<string, unknown>[], deflate: boolean) => {
    const byEvent: Record<string, { frames: number; bytes: number; deflated: number; max: number }> = {}
    for (const message of messages) {
      const text = nativeStringify(message)
      const name = String(message.event ?? (message.id !== undefined ? 'reply' : 'other'))
      const entry = byEvent[name] ??= { frames: 0, bytes: 0, deflated: 0, max: 0 }
      entry.frames++; entry.bytes += Buffer.byteLength(text); entry.max = Math.max(entry.max, Buffer.byteLength(text))
      if (deflate) entry.deflated += deflateRawSync(text, { level: 6 }).byteLength
    }
    return byEvent
  }
  for (const streams of [1, 3]) {
    const sessionsStreaming = p.streamSessions.slice(0, streams)
    const at = new Date().toISOString()
    for (const session of sessionsStreaming) {
      const thread = p.adapter.state.threads.find(item => item.id === session)!
      p.adapter.log.add(session, { id: `prompt-${streams}`, role: 'user', text: 'Synthetic prompt', createdAt: at }); thread.status = 'running'; p.adapter.mark(session)
      p.adapter.log.add(session, { id: `reply-${streams}`, role: 'assistant', text: 'First', createdAt: at })
    }
    p.adapter.publish(true)
    await pass(1_000); await io()
    const marks = { desktop: desktop.messages.length, phone: phone.messages.length }
    clientPushes = 0; desktopBroadcasts = 0; desktopBroadcastBytes = 0
    const profiler = PROFILE.has(`socket ${streams}`) ? new Session() : undefined
    if (profiler) { profiler.connect(); await profiler.post('Profiler.enable'); await profiler.post('Profiler.setSamplingInterval', { interval: 200 }); await profiler.post('Profiler.start') }
    const cpu = process.cpuUsage()
    for (let chunk = 0; chunk < 60; chunk++) {
      for (const session of sessionsStreaming) p.adapter.log.appendText(session, `reply-${streams}`, ` word${chunk} and some more text`)
      p.adapter.publish(true)
      for (let elapsed = 0; elapsed < 50; elapsed += STEP_MS) { await step(); await io(2) }
    }
    await pass(1_000); await io()
    const used = process.cpuUsage(cpu)
    if (profiler) { const { profile } = await profiler.post('Profiler.stop'); writeFileSync(join(tmpdir(), `sotto-transfer-socket-${streams}.cpuprofile`), nativeStringify(profile)); profiler.disconnect() }
    report[`${streams} streaming`] = { seconds: 4, processCpuMs: Math.round((used.user + used.system) / 1000), clientPushes, desktopWindow: { broadcasts: desktopBroadcasts, bytes: desktopBroadcastBytes },
      desktop: tallyPeer(desktop.messages.slice(marks.desktop), true), phone: tallyPeer(phone.messages.slice(marks.phone), false) }
    for (const session of sessionsStreaming) { p.adapter.state.threads.find(item => item.id === session)!.status = 'idle'; p.adapter.mark(session) }
    p.adapter.publish(false)
    await pass(1_000); await io()
  }
  // A send on the open thread, as a phone makes it: what each peer is sent for it.
  const marks = { desktop: desktop.messages.length, phone: phone.messages.length }
  try { await until(p.actions.send()) } catch (error) { report.sendError = String(error) }
  await pass(1_000); await io()
  report.send = { desktop: tallyPeer(desktop.messages.slice(marks.desktop), true), phone: tallyPeer(phone.messages.slice(marks.phone), false) }
  console.log(`DATA-TRANSFER-SOCKET ${nativeStringify({ track: TRACK, long: LONG, hostId, ...report }, null, 1)}`)
  offDesktop(); desktopPublisher.dispose(); desktopRouter.dispose(); offClient(); client.close?.()
  desktop.frames.close(); phone.frames.close()
  await until(server.close()); await until(phoneServer.close()); await until(p.stop()); vi.clearAllTimers()
}, 900_000)
