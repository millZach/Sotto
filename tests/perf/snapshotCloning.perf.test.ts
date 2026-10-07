// @vitest-environment node
/**
 * What one provider update costs main while Claude sessions are held open (issue #322): the adapter's
 * activity snapshot, the provider switch's two copies, the workspace's acceptance, and beside them the
 * public `view()` a command result carries and the coordinator's `shell()`. It runs the real Claude adapter
 * over the fake CLI with 1, 4 and 8 open threads, short and long histories, and a window showing one of them
 * or none, then publishes the same unchanged state repeatedly and times each stage. Then it times a thread
 * refresh and a settings result through the workspace, and counts what the switch hands it (#368). It counts
 * objects rather than reading them: nothing a thread said is printed. It asserts no time, so it runs only under
 * `SOTTO_PERF_BENCH=1` (`tests/fixtures/perfBench.ts`); the default suite runs only the check that the private
 * members it wraps still exist:
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/snapshotCloning.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { subscribeActivitySnapshots } from '../../src/main/agents/activitySnapshots'
import { cloneHostSnapshot } from '../../src/main/agents/cloneHostSnapshot'
import { ClaudeStreamJsonHost } from '../../src/main/agents/claude'
import { ProviderSnapshotPublisher } from '../../src/main/agents/providerSnapshotPublisher'
import { ConfiguredProviderHost } from '../../src/main/agents/providerSwitch'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import type { AgentHostSnapshot } from '../../src/shared/agents'
import { claudeFixture } from '../fixtures/claudeFixture'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { manualSendCoordinator } from '../fixtures/manualSendCoordinator'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

const EMITS = 60
/** Thread refreshes and settings results measured, each, after three to warm up. */
const READS = 20
const HISTORIES = { short: 20, long: 1000 } as const
/** A window showing the first thread in one pane, or a window showing no thread at all. */
const WINDOWS = { pane: 1, none: 0 } as const
const WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '

let exposedGc: (() => void) | undefined
/** A full collection, with the flag set only when a benchmark first asks, so a default suite run changes nothing. */
function collect(): void {
  if (!exposedGc) { setFlagsFromString('--expose-gc'); exposedGc = runInNewContext('gc') as () => void }
  exposedGc()
}

/** Objects and arrays a copy would visit, skipping frozen ones: a frozen activity tree is shared, never copied. */
function objects(value: unknown, seen = new Set<object>()): number {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value) || seen.has(value)) return 0
  seen.add(value)
  let count = 1
  for (const field of Object.values(value)) count += objects(field, seen)
  return count
}
function messageObjects(snapshot: AgentHostSnapshot): number {
  return snapshot.threads.reduce((sum, thread) => sum + objects(thread.messages), 0)
}

type Stage = 'emit' | 'switchAccept' | 'switchPublish' | 'workspaceAccept'
/** The copies a thread refresh or a settings result makes on its way to the workspace (#368). */
type ReadStage = 'view' | 'switchAccept' | 'switchPublish' | 'workspaceAccept' | 'switchCall' | 'provider'
/** Wraps an instance method so the time it spends is added to `stage` while `on` is set. */
function timed<S extends string>(target: object, method: string, stage: S, totals: Record<S, number>, on: () => boolean): void {
  const record = target as Record<string, (...args: unknown[]) => unknown>
  const original = record[method]!.bind(target)
  record[method] = (...args: unknown[]) => {
    if (!on()) return original(...args)
    const started = performance.now()
    try { return original(...args) } finally { totals[stage] += performance.now() - started }
  }
}

/** The same for an async method: the time until what it returns settles. */
function timedAsync<S extends string>(target: object, method: string, stage: S, totals: Record<S, number>, on: () => boolean): void {
  const record = target as Record<string, (...args: unknown[]) => Promise<unknown>>
  const original = record[method]!.bind(target)
  record[method] = async (...args: unknown[]) => {
    if (!on()) return original(...args)
    const started = performance.now()
    try { return await original(...args) } finally { totals[stage] += performance.now() - started }
  }
}

/**
 * The private members the benchmark wraps or calls, by owner. Renaming one breaks the benchmark, which CI
 * never runs, so the test at the end of this file checks each still exists.
 */
const PRIVATE_MEMBERS = {
  claudeAdapter: ['emit', 'view'], claudeAdapterFields: ['publisher'], publisher: ['emit'],
  providerSwitch: ['accept', 'publish'], workspace: ['accept'],
} as const

async function measure(threads: number, history: keyof typeof HISTORIES, window: keyof typeof WINDOWS) {
  const f = await claudeFixture(undefined, 10_000)
  const registry = new ThreadRegistry(f.root)
  const sotto = new SottoThreadHost('claude', f.host, registry)
  const providers = new ConfiguredProviderHost({ hosts: { codex: new FakeProviderHost(), claude: sotto,
    grok: new FakeProviderHost(), devin: new FakeProviderHost() }, provider: () => 'claude' })
  const workspace = new WorkspaceHost(providers, f.root)
  try {
    await workspace.connect('claude')
    const model = workspace.workspaceSnapshot().models[0]!
    await workspace.execute({ type: 'create-project', commandId: 'project', projectId: 'project', title: 'Fixture', path: f.root, provider: 'claude' })
    const project = workspace.workspaceSnapshot().projects[0]!
    const ids = Array.from({ length: threads }, (_, index) => `thread-${index}`)
    for (const id of ids) {
      await workspace.execute({ type: 'create-thread', commandId: `create-${id}`, threadId: id, projectId: project.id, title: 'Fixture', modelId: model.id })
      await workspace.execute({ type: 'send', commandId: `send-${id}`, threadId: id, messageId: `message-${id}`, text: 'Fixture task' })
    }
    const control = await manualSendCoordinator(f.root, workspace)
    await control.start()
    // One pane views the first thread; every other thread, and every thread with no pane, is held only by its open CLI.
    await control.command({ type: 'observe-threads', threadIds: ids.slice(0, WINDOWS[window]) })
    const length = HISTORIES[history]
    await Promise.all(ids.map(id => f.action(registry.byThread(id)!.sessionId, { type: 'raw-burst', frames: Array.from({ length }, (_, index) => index % 2 === 0
      ? { type: 'user', uuid: `${id}-user-${index}`, message: { role: 'user', content: WORDS.repeat(2) } }
      : { type: 'assistant', uuid: `${id}-assistant-${index}`, message: { id: `${id}-reply-${index}`, content: [{ type: 'text', text: WORDS.repeat(8) }] } }) })))
    let latest: AgentHostSnapshot | undefined
    const off = subscribeActivitySnapshots(f.host, snapshot => { latest = snapshot }, { historyFromEvents: true })
    await expect.poll(() => control.shell().host.threads.map(thread => thread.summary?.messageCount), { timeout: 60_000 }).toEqual(ids.map(() => length + 1))
    ;(f.adapter as unknown as { emit(): void }).emit()
    const activityObjects = objects(latest)
    const activityMessageObjects = messageObjects(latest!)
    off()
    const adapterView = (f.adapter as unknown as { view(): AgentHostSnapshot }).view.bind(f.adapter)
    const viewed = adapterView()
    const viewObjects = objects(viewed)
    const viewMessageObjects = messageObjects(viewed)
    // The same snapshot with every thread's messages emptied: what `view()` would cost if it held no history.
    const bare = { ...viewed, threads: viewed.threads.map(thread => ({ ...thread, messages: [] })) }

    const totals: Record<Stage, number> = { emit: 0, switchAccept: 0, switchPublish: 0, workspaceAccept: 0 }
    let on = false
    const publisher = (f.adapter as unknown as { publisher: object }).publisher
    timed(publisher, 'emit', 'emit', totals, () => on)
    timed(providers, 'accept', 'switchAccept', totals, () => on)
    timed(providers, 'publish', 'switchPublish', totals, () => on)
    timed(workspace, 'accept', 'workspaceAccept', totals, () => on)
    const emit = (f.adapter as unknown as { emit(): void }).emit.bind(f.adapter)
    const samples: Record<Stage | 'adapter' | 'view' | 'viewWithoutMessages' | 'shell', number[]> = { emit: [], switchAccept: [], switchPublish: [], workspaceAccept: [], adapter: [], view: [], viewWithoutMessages: [], shell: [] }
    for (let run = 0; run < EMITS + 5; run++) {
      for (const stage of Object.keys(totals) as Stage[]) totals[stage] = 0
      on = true; emit(); on = false
      const view = performance.now(); adapterView(); const viewMs = performance.now() - view
      const without = performance.now(); cloneHostSnapshot(bare); const withoutMs = performance.now() - without
      const shell = performance.now(); control.shell(); const shelled = performance.now() - shell
      if (run < 5) continue
      for (const stage of Object.keys(totals) as Stage[]) samples[stage].push(totals[stage])
      // The switch's publish runs inside the adapter's emit and includes the workspace's acceptance.
      samples.adapter.push(totals.emit - totals.switchAccept - totals.switchPublish)
      samples.view.push(viewMs); samples.viewWithoutMessages.push(withoutMs); samples.shell.push(shelled)
    }
    const shellObjects = objects(control.shell())
    collect(); collect()
    const heap = process.memoryUsage().heapUsed
    const reads = await measureReads(f, registry.byThread(ids[0]!)!.sessionId, ids[0]!, sotto, providers, workspace)
    // After the reads too: what the provider switch's slot keeps from the last refresh or settings result.
    collect(); collect()
    const heapAfterReads = process.memoryUsage().heapUsed
    const result = { threads, history, window, messagesPerThread: length + 1,
      activityObjects, activityMessageObjects, viewObjects, viewMessageObjects, shellObjects,
      ms: Object.fromEntries(Object.entries(samples).map(([stage, values]) => [stage, round(median(values), 3)])),
      reads,
      heapMiB: round(heap / 1024 / 1024, 1), heapAfterReadsMiB: round(heapAfterReads / 1024 / 1024, 1) }
    control.dispose()
    return result
  } finally {
    workspace.disconnect(); await f.adapter.closed(); await workspace.privacyChanged(); workspace.dispose(); await registry.flush(); await f.cleanup()
  }
}

/**
 * A thread refresh and a settings result for the first thread, each through the workspace as the coordinator
 * asks for them (#368): the objects in what the provider switch hands the workspace, the time of each copy on
 * the way, and the whole call. The first thread's turn is finished first, since settings wait for an idle thread.
 */
async function measureReads(f: Awaited<ReturnType<typeof claudeFixture>>, sessionId: string, threadId: string, sotto: SottoThreadHost, providers: ConfiguredProviderHost, workspace: WorkspaceHost) {
  await f.action(sessionId, { type: 'complete', text: 'Fixture reply' })
  await expect.poll(() => workspace.workspaceSnapshot().threads.find(thread => thread.id === threadId)?.status, { timeout: 60_000 }).toBe('idle')
  const totals: Record<ReadStage, number> = { view: 0, switchAccept: 0, switchPublish: 0, workspaceAccept: 0, switchCall: 0, provider: 0 }
  let on = false
  timed(f.adapter, 'view', 'view', totals, () => on)
  timed(providers, 'accept', 'switchAccept', totals, () => on)
  timed(providers, 'publish', 'switchPublish', totals, () => on)
  timed(workspace, 'accept', 'workspaceAccept', totals, () => on)
  // The switch's own share of a call is its whole call less the provider's: accepting, publishing and the copy it returns.
  for (const method of ['refreshThread', 'execute']) {
    timedAsync(sotto, method, 'provider', totals, () => on)
    timedAsync(providers, method, 'switchCall', totals, () => on)
  }
  // What the switch hands the workspace: a refresh's snapshot, or a settings result's.
  let handed: AgentHostSnapshot | undefined
  const refresh = providers.refreshThread.bind(providers)
  providers.refreshThread = async (...args) => (handed = await refresh(...args))
  const execute = providers.execute.bind(providers)
  providers.execute = async command => { const result = await execute(command); handed = result.snapshot; return result }
  const measured = { refresh: { handed: [] as number[], messages: [] as number[], ms: [] as number[], stages: [] as Record<ReadStage, number>[] },
    settings: { handed: [] as number[], messages: [] as number[], ms: [] as number[], stages: [] as Record<ReadStage, number>[] } }
  for (let run = 0; run < READS + 3; run++) {
    for (const kind of ['refresh', 'settings'] as const) {
      for (const stage of Object.keys(totals) as ReadStage[]) totals[stage] = 0
      handed = undefined
      on = true
      const started = performance.now()
      if (kind === 'refresh') await workspace.refreshThread(threadId)
      else {
        const result = await workspace.execute({ type: 'configure-thread', commandId: `mode-${run}`, threadId, runtimeMode: run % 2 === 0 ? 'full-access' : 'auto-accept-edits' })
        if (!result.accepted || !result.snapshot) throw new Error('The fixture did not confirm the settings change.')
      }
      const ms = performance.now() - started
      on = false
      if (run < 3) continue
      measured[kind].handed.push(objects(handed)); measured[kind].messages.push(handed ? messageObjects(handed) : 0)
      measured[kind].ms.push(ms); measured[kind].stages.push({ ...totals })
    }
  }
  return Object.fromEntries(Object.entries(measured).map(([kind, values]) => [kind, {
    handedObjects: median(values.handed), handedMessageObjects: median(values.messages), totalMs: round(median(values.ms), 3),
    ms: { ...Object.fromEntries((['view', 'switchAccept', 'switchPublish', 'workspaceAccept'] as const).map(stage => [stage, round(median(values.stages.map(sample => sample[stage])), 3)])),
      switchOwn: round(median(values.stages.map(sample => sample.switchCall - sample.provider)), 3) } }]))
}

it('still finds the private members the snapshot cloning benchmark times', () => {
  for (const member of PRIVATE_MEMBERS.claudeAdapter) expect(typeof (ClaudeStreamJsonHost.prototype as unknown as Record<string, unknown>)[member]).toBe('function')
  for (const member of PRIVATE_MEMBERS.providerSwitch) expect(typeof (ConfiguredProviderHost.prototype as unknown as Record<string, unknown>)[member]).toBe('function')
  for (const member of PRIVATE_MEMBERS.workspace) expect(typeof (WorkspaceHost.prototype as unknown as Record<string, unknown>)[member]).toBe('function')
  const publisher = new ProviderSnapshotPublisher(() => undefined, () => 0) as unknown as Record<string, unknown>
  for (const member of PRIVATE_MEMBERS.publisher) expect(typeof publisher[member]).toBe('function')
  // The adapter's publisher is an instance field. Constructing an adapter reads, writes and starts nothing.
  const adapter = new ClaudeStreamJsonHost({ userDataPath: join(tmpdir(), 'sotto-snapshot-cloning-members') }) as unknown as Record<string, unknown>
  for (const member of PRIVATE_MEMBERS.claudeAdapterFields) expect(adapter[member]).toBeInstanceOf(ProviderSnapshotPublisher)
})

describe.skipIf(!PERF_BENCH)('snapshot cloning with held threads', () => {
  for (const window of ['pane', 'none'] as const) for (const history of ['short', 'long'] as const) for (const threads of [1, 4, 8]) {
    it(`${threads} held thread(s), ${history} histories, ${window === 'pane' ? 'one pane' : 'no pane'}`, async () => {
      const result = await measure(threads, history, window)
      console.log(`snapshot cloning: ${JSON.stringify(result)}`)
    }, 180_000)
  }
})
