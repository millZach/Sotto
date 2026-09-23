import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { cpus, platform, release, tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { setImmediate, setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '../..')
const moduleRoot = process.env.SOTTO_BENCH_MODULES ?? root
const require = createRequire(join(moduleRoot, 'package.json'))
const { build } = require('esbuild')
const revision = '11e60a67f5529a1eefad5be5bc5990ef069f5205'
const legacyProvider = process.env.SOTTO_PERF_LEGACY === '1'
const at = '2026-09-23T12:00:00.000Z'
const round = n => Math.round(n * 1000) / 1000
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const p95 = xs => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * .95)]

// Representative combinations, including the original usage-only 1/4/8 x 500 comparison.
const cases = [
  { id: 'usage-1-0', kind: 'usage', threads: 1, records: 0, observed: 1, cadence: 'burst', updates: 120 },
  { id: 'usage-1-500', kind: 'usage', threads: 1, records: 500, observed: 1, cadence: 'burst', updates: 120 },
  { id: 'usage-4-500', kind: 'usage', threads: 4, records: 500, observed: 1, cadence: 'burst', updates: 120 },
  { id: 'usage-8-500', kind: 'usage', threads: 8, records: 500, observed: 1, cadence: 'burst', updates: 120 },
  { id: 'command-8-500', kind: 'command', threads: 8, records: 500, observed: 1, cadence: 'burst', updates: 120 },
  { id: 'subagent-4-50', kind: 'subagent', threads: 4, records: 50, observed: 4, cadence: 'burst', updates: 120 },
  { id: 'message-4-50-total', kind: 'message', threads: 4, records: 50, observed: 3, cadence: 'total', updates: 40 },
  { id: 'mixed-8-50-per-thread', kind: 'mixed', threads: 8, records: 50, observed: 0, cadence: 'per-thread', updates: 40 },
  { id: 'usage-1-2000', kind: 'usage', threads: 1, records: 2000, observed: 1, cadence: 'burst', updates: 60 },
  { id: 'usage-1-50-idle-128', kind: 'usage', threads: 1, records: 50, idle: 128, observed: 0, cadence: 'burst', updates: 120 },
]
const updateOverride = process.env.SOTTO_PERF_UPDATES === undefined ? undefined : Number(process.env.SOTTO_PERF_UPDATES)
assert.ok(updateOverride === undefined || (Number.isInteger(updateOverride) && updateOverride >= 1 && updateOverride <= 10_000))
const configuredCases = cases.map(item => updateOverride === undefined ? item : { ...item, updates: updateOverride })

function record(index, kind) {
  return { id: `activity-${index}`, turnId: 'turn', sequence: index, kind, title: 'Synthetic work',
    status: 'completed', completedAt: at,
    ...(kind === 'command' ? { output: 'x'.repeat(4096) } : { agents: [{ id: `agent-${index}`,
      assignmentId: `assignment-${index}`, status: 'completed', observedAt: at }] }) }
}

async function sample(bundle, config, directory, compatibilityBundle) {
  const { WorkspaceHost, FakeProviderHost, cloneHostSnapshot, ThreadStore, agentActivitySchema,
    threadUsageSchema, immutableActivities, isImmutableActivities, cloneActivitySnapshot } = require(bundle)
  class SyntheticProvider extends FakeProviderHost {
    listeners = new Set()
    activityListeners = new Set()
    eventListeners = new Set()
    constructor() {
      super()
      if (immutableActivities) this.subscribeActivitySnapshots = fn => {
        this.activityListeners.add(fn)
        return () => this.activityListeners.delete(fn)
      }
    }
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
    subscribeEvents(fn) { this.eventListeners.add(fn); return () => this.eventListeners.delete(fn) }
    append(threadId, messageId, appendText) {
      for (const fn of this.eventListeners) fn({ threadId, event: { kind: 'message-text-appended',
        at, messageId, appendText } })
    }
    add(threadId, message) {
      for (const fn of this.eventListeners) fn({ threadId, event: { kind: 'message-added', at, message } })
    }
    emit() {
      if (immutableActivities) for (const thread of this.state.threads) if (thread.activities && !isImmutableActivities(thread.activities)) {
        thread.activities = immutableActivities(thread.activities)
      }
      for (const fn of this.listeners) fn(cloneHostSnapshot(this.state))
      for (const fn of this.activityListeners) fn(cloneActivitySnapshot(this.state))
    }
    async snapshot() { return cloneHostSnapshot(this.state) }
  }
  const provider = new SyntheticProvider()
  const template = provider.state.threads[0]
  const active = Array.from({ length: config.threads }, (_, i) => ({ ...template, id: `synthetic-${i}`,
    title: `Synthetic thread ${i}`, status: 'running', messages: [], requests: [],
    activities: Array.from({ length: config.records }, (_, j) => record(j, config.kind === 'subagent' ? 'subagent' : 'command')) }))
  const idle = Array.from({ length: config.idle ?? 0 }, (_, i) => ({ ...template, id: `idle-${i}`,
    title: 'Idle synthetic thread', status: 'idle', messages: [], requests: [] }))
  if (config.kind === 'mixed') for (let index = 3; index < active.length; index += 4) {
    const row = active[index].activities.at(-2)
    active[index].activities[active[index].activities.length - 2] = { ...row, kind: 'subagent',
      status: 'running', completedAt: undefined,
      agents: [{ id: 'nested-agent', parentId: 'parent-agent', assignmentId: 'nested-assignment',
        status: 'running', observedAt: at }] }
  }
  provider.state.threads = [...active, ...idle]
  for (const thread of active) for (const row of thread.activities) agentActivitySchema.parse(row)
  const messages = config.kind === 'message' || config.kind === 'mixed'
  if (messages) for (const thread of active) thread.messages = [
    { id: 'prompt', role: 'user', text: 'Synthetic prompt', createdAt: at },
    { id: 'reply', role: 'assistant', text: 'Synthetic reply', createdAt: at }]
  if (config.kind === 'command' || config.kind === 'subagent') {
    const last = active[0].activities.at(-1)
    last.status = 'running'; delete last.completedAt
  }
  const host = new WorkspaceHost(provider, directory)
  const startupAt = performance.now()
  await host.initialize(); await host.connect()
  const startupMs = performance.now() - startupAt
  if (messages) for (const thread of active) for (const message of thread.messages) provider.add(thread.id, message)
  host.observeThreads(active.slice(0, config.observed).map(thread => thread.id))
  let publishes = 0
  const off = (host.subscribeActivitySnapshots ?? host.subscribe).call(host, () => { publishes++ })
  for (let i = 0; i < 20; i++) { provider.emit(); await setImmediate() }
  await host.flush()
  globalThis.gc?.()
  const before = process.memoryUsage()
  const startCpu = process.cpuUsage()
  const start = performance.now()
  const durations = []
  const interval = config.cadence === 'total' ? 25 : config.cadence === 'per-thread' ? 25 / config.threads : 0
  for (let i = 0; i < config.updates; i++) {
    if (interval) { const wait = start + i * interval - performance.now(); if (wait > 0) await setTimeout(wait) }
    const thread = config.kind === 'mixed' ? active[i % active.length] : active[0]
    if (config.kind === 'usage') {
      thread.usage = { latest: { input: i + 1, output: i + 1 }, rateVersions: [], partial: false, updatedAt: at }
      threadUsageSchema.parse(thread.usage)
    } else if (config.kind === 'command') thread.activities = [
      ...thread.activities.slice(0, -1), { ...thread.activities.at(-1), output: thread.activities.at(-1).output + `/${i}` }]
    else if (config.kind === 'subagent') {
      const row = thread.activities.at(-1)
      thread.activities = [...thread.activities.slice(0, -1), { ...row, agents: [{
        ...row.agents[0], status: 'running', description: `Progress ${i}` }] }]
    }
    else if (config.kind === 'message') {
      const appendText = `/${i}`
      thread.messages[1].text += appendText
      provider.append(thread.id, 'reply', appendText)
    }
    else {
      if (i % 4 === 0) {
        const appendText = `/${i}`
        thread.messages[1].text += appendText
        provider.append(thread.id, 'reply', appendText)
      }
      else if (i % 4 === 1) thread.usage = { latest: { input: i, output: i }, rateVersions: [], partial: false, updatedAt: at }
      else if (i % 4 === 2) thread.activities = [
        ...thread.activities.slice(0, -1), { ...thread.activities.at(-1), output: thread.activities.at(-1).output + `/${i}` }]
      else { const row = thread.activities.at(-2); thread.activities = [...thread.activities.slice(0, -2), { ...row,
        kind: 'subagent', agents: [{
        id: 'nested-agent', parentId: 'parent-agent', assignmentId: 'nested-assignment',
        status: 'running', description: `Progress ${i}`, observedAt: at }] }, thread.activities.at(-1)] }
    }
    const updateStart = performance.now()
    provider.emit(); await setImmediate()
    durations.push(performance.now() - updateStart)
  }
  if (config.kind === 'command' || config.kind === 'subagent') {
    const last = active[0].activities.at(-1)
    active[0].activities = [...active[0].activities.slice(0, -1), { ...last,
      status: 'completed', completedAt: at,
      ...(config.kind === 'subagent' ? { agents: [{ ...last.agents[0], status: 'completed' }] } : {}) }]
    provider.emit(); await setImmediate()
  }
  // Include the final required durable flush in the measured update workload.
  await host.flush()
  const elapsedMs = performance.now() - start
  const cpu = process.cpuUsage(startCpu)
  globalThis.gc?.()
  const after = process.memoryUsage()
  const snapshot = host.workspaceSnapshot()
  const visible = snapshot.threads.find(thread => thread.id === active[0].id)
  assert.ok(visible)
  assert.equal(snapshot.threads.length, active.length + idle.length)
  assert.ok(publishes > 0)
  // The public snapshot remains caller-writable and isolated from later reads.
  if (visible.activities?.length) {
    const original = visible.activities[0].title
    visible.activities[0].title = 'Edited by snapshot reader'
    assert.equal(host.workspaceSnapshot().threads.find(thread => thread.id === active[0].id).activities[0].title, original)
    visible.activities[0].title = original
  }
  off(); host.dispose()
  const store = new ThreadStore(join(directory, 'threads.sqlite'))
  store.open()
  const durable = store.readActivities(active[0].id)
  const durableAll = active.map(thread => store.readActivities(thread.id))
  const events = store.eventsAfter(0)
  assert.equal(visible.activities?.length, active[0].activities.length)
  assert.equal(durable.length, active[0].activities.length)
  if (config.kind === 'usage') assert.deepEqual(visible.usage, active[0].usage)
  if (config.kind === 'command') {
    assert.equal(visible.activities.at(-1).output, active[0].activities.at(-1).output)
    assert.equal(durable.at(-1).output, active[0].activities.at(-1).output)
    assert.equal(durable.at(-1).status, 'completed')
  }
  if (config.kind === 'subagent') {
    assert.equal(visible.activities.at(-1).agents[0].description, `Progress ${config.updates - 1}`)
    assert.equal(durable.at(-1).agents[0].status, 'completed')
  }
  if (messages) {
    for (const thread of active) assert.deepEqual(store.readMessages(thread.id, {}).messages.map(row => row.text),
      thread.messages.map(row => row.text))
    assert.equal(events.filter(row => row.event.kind === 'message-added').length, active.length * 2)
    assert.equal(events.filter(row => row.event.kind === 'message-text-appended').length,
      config.kind === 'message' ? config.updates : Math.ceil(config.updates / 4))
    assert.equal(visible.messages.length, config.observed ? 2 : 0)
    if (config.observed) assert.equal(visible.messages[1].text, active[0].messages[1].text)
  }
  if (config.kind === 'mixed') for (let index = 0; index < active.length; index++) {
    const thread = snapshot.threads.find(row => row.id === active[index].id)
    assert.ok(thread)
    if (index % 4 === 1) assert.deepEqual(thread.usage, active[index].usage)
    if (index % 4 === 2) assert.equal(durableAll[index].at(-1).output, active[index].activities.at(-1).output)
    if (index % 4 === 3) assert.deepEqual({ kind: durableAll[index].at(-2).kind,
      id: durableAll[index].at(-2).agents[0].id,
      assignmentId: durableAll[index].at(-2).agents[0].assignmentId,
      status: durableAll[index].at(-2).agents[0].status },
    { kind: 'subagent', id: 'nested-agent', assignmentId: 'nested-assignment', status: 'running' })
  }
  const state = { ids: snapshot.threads.map(thread => thread.id),
    activities: active.map(thread => snapshot.threads.find(row => row.id === thread.id).activities),
    usage: active.map(thread => snapshot.threads.find(row => row.id === thread.id).usage), durableAll,
    messages: active.map(thread => store.readMessages(thread.id, {}).messages),
    events: events.map(row => ({ threadId: row.threadId,
      event: Object.fromEntries(Object.entries(row.event).filter(([key]) => key !== 'at')) }))
      // SQLite may interleave independent threads differently when a display flush fires.
      // Preserve and compare the order within each thread.
      .sort((a, b) => a.threadId.localeCompare(b.threadId)) }
  const fingerprint = Object.fromEntries(Object.entries(state).map(([key, value]) => [key,
    createHash('sha256').update(JSON.stringify(value)).digest('hex')]))
  store.close()
  const restarted = new WorkspaceHost(new SyntheticProvider(), directory)
  const restartAt = performance.now()
  await restarted.initialize()
  const archiveStartupMs = performance.now() - restartAt
  for (const thread of active) assert.equal(restarted.activities(thread.id)?.length, thread.activities.length)
  restarted.dispose()
  if (compatibilityBundle) {
    const baselineStore = new (require(compatibilityBundle).ThreadStore)(join(directory, 'threads.sqlite'))
    baselineStore.open()
    const currentStore = new ThreadStore(join(directory, 'threads.sqlite'))
    currentStore.open()
    const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    for (const thread of active) {
      // Startup intentionally makes interrupted running work unknown, and saves that recovery.
      assert.equal(digest(baselineStore.readActivities(thread.id)), digest(currentStore.readActivities(thread.id)), 'Baseline must reopen candidate activity after recovery')
      assert.equal(digest(baselineStore.readMessages(thread.id, {}).messages), digest(currentStore.readMessages(thread.id, {}).messages), 'Baseline must reopen candidate messages')
    }
    currentStore.close(); baselineStore.close()
  }
  return { fingerprint, eventTrace: state.events, updates: config.updates, publishes,
    startupMs: round(startupMs), archiveStartupMs: round(archiveStartupMs), heapMiB: round(after.heapUsed / 1048576), elapsedMs: round(elapsedMs),
    cpuMs: round((cpu.user + cpu.system) / 1000), cpuMsPerUpdate: round((cpu.user + cpu.system) / 1000 / config.updates),
    updateP95Ms: round(p95(durations)), heapDeltaMiB: round((after.heapUsed - before.heapUsed) / 1048576),
    rssDeltaMiB: round((after.rss - before.rss) / 1048576), rssMiB: round(after.rss / 1048576),
    eventCount: events.length, activityCount: durable.length }
}

if (process.argv[2] === '--sample') {
  const [, , , bundle, id, directory, compatibilityBundle] = process.argv
  const config = configuredCases.find(item => item.id === id)
  assert.ok(config)
  process.stdout.write(`${JSON.stringify(await sample(bundle, config, directory, compatibilityBundle))}\n`)
} else {
  const only = process.argv[2]
  assert.ok(only === undefined || only === '--baseline-only' || only === '--candidate-only')
  const selectedCases = process.env.SOTTO_PERF_CASE
    ? configuredCases.filter(item => item.id === process.env.SOTTO_PERF_CASE) : configuredCases
  assert.ok(selectedCases.length > 0)
  const samples = Number(process.env.SOTTO_PERF_SAMPLES ?? 5)
  assert.ok(Number.isInteger(samples) && samples >= 5 && samples <= 30)
  const directory = mkdtempSync(join(tmpdir(), 'sotto-multi-thread-cpu-'))
  try {
    assert.equal(execFileSync('git', ['rev-parse', revision], { cwd: root, encoding: 'utf8' }).trim(), revision)
    const modes = only === '--baseline-only' ? ['baseline'] : only === '--candidate-only' ? ['candidate'] : ['baseline', 'candidate']
    const bundles = {}
    for (const mode of modes) {
      const outfile = join(directory, `${mode}.cjs`)
      await build({ stdin: { contents: [
        "export { WorkspaceHost } from './src/main/agents/workspace';",
        "export { ThreadStore } from './src/main/agents/threadStore';",
        "export { FakeProviderHost } from './tests/fixtures/fakeProviderHost';",
        "export { cloneHostSnapshot } from './src/main/agents/cloneHostSnapshot';",
        "export { agentActivitySchema } from './src/shared/agentActivity';",
        "export { threadUsageSchema } from './src/shared/threadUsage';",
        ...(mode === 'candidate' && !legacyProvider ? ["export { immutableActivities, isImmutableActivities, cloneActivitySnapshot } from './src/main/agents/activitySnapshots';"] : []),
      ].join('\n'), resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile,
      nodePaths: [join(moduleRoot, 'node_modules')], logLevel: 'silent',
      plugins: mode === 'baseline' ? [{ name: 'fixed-source-revision', setup(builder) {
        builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, args => {
          const path = relative(root, args.path).split(sep).join('/')
          if (!path.startsWith('src/') && path !== 'tests/fixtures/fakeProviderHost.ts') return undefined
          return { contents: execFileSync('git', ['show', `${revision}:${path}`], { cwd: root, encoding: 'utf8' }),
            loader: path.endsWith('tsx') ? 'tsx' : path.endsWith('ts') ? 'ts' : 'js' }
        })
      } }] : [] })
      bundles[mode] = outfile
    }
    const results = []
    for (const config of selectedCases) for (let index = 0; index < samples; index++) {
      for (const mode of index % 2 ? [...modes].reverse() : modes) {
        const result = JSON.parse(execFileSync(process.execPath,
          ['--expose-gc', script, '--sample', bundles[mode], config.id, join(directory, `${config.id}-${index}-${mode}`),
            ...(mode === 'candidate' && bundles.baseline ? [bundles.baseline] : [])],
          { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' }, timeout: 120_000,
            maxBuffer: 20 * 1048576 }))
        results.push({ case: config.id, mode, sample: index, ...result })
      }
    }
    for (const config of selectedCases) for (const key of Object.keys(results[0].fingerprint)) {
      if (key === 'events') {
        const pair = results.filter(row => row.case === config.id)
        assert.deepEqual(pair[0].eventTrace, pair[1].eventTrace)
      }
      assert.equal(new Set(results.filter(row => row.case === config.id).map(row => row.fingerprint[key])).size,
        1, `Snapshot or durable ${key} differs: ${config.id}`)
    }
    const summaries = selectedCases.flatMap(config => modes.map(mode => {
      const group = results.filter(row => row.case === config.id && row.mode === mode)
      return { case: config.id, mode, medianCpuMsPerUpdate: round(median(group.map(row => row.cpuMsPerUpdate))),
        medianP95Ms: round(median(group.map(row => row.updateP95Ms))),
        medianStartupMs: round(median(group.map(row => row.startupMs))),
        medianArchiveStartupMs: round(median(group.map(row => row.archiveStartupMs))),
        medianHeapMiB: round(median(group.map(row => row.heapMiB))),
        medianRssMiB: round(median(group.map(row => row.rssMiB))),
        medianHeapDeltaMiB: round(median(group.map(row => row.heapDeltaMiB))),
        medianRssDeltaMiB: round(median(group.map(row => row.rssDeltaMiB))) }
    }))
    process.stdout.write(`${JSON.stringify({ revision, legacyProvider,
      scope: 'Synthetic provider clone to WorkspaceHost and durable ThreadStore; excludes native providers, coordinator, IPC and renderer.',
      node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, logicalCpus: cpus().length,
      samples, cases: selectedCases, summaries, results }, null, 2)}\n`)
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(directory.includes('sotto-multi-thread-cpu-'))
    rmSync(directory, { recursive: true, force: true })
  }
}
