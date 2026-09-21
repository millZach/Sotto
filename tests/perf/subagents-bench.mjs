/** Local opt-in benchmark; runs the real HEAD and working-tree workspace in isolated processes. */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { cpus, platform, release, tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { setInterval, clearInterval } from 'node:timers'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '../..')
const round = value => Math.round(value * 1000) / 1000
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))]
const memory = () => { globalThis.gc?.(); return process.memoryUsage() }

async function measure(bundle, seedBundle, count, directory) {
  const { WorkspaceHost, FakeProviderHost } = require(bundle)
  const { SubagentStore } = require(seedBundle)
  let native = new FakeProviderHost()
  native.state.threads.push({ ...native.state.threads[0], id: 'session-third', title: 'Third' })
  const ids = native.state.threads.map(thread => thread.id)
  // Identical durable workspace organization, with all setup excluded from startup timing.
  let host = new WorkspaceHost(native, directory)
  await host.initialize(); await host.connect(); host.dispose(); native = new FakeProviderHost(native.state)
  const archive = new SubagentStore(join(directory, 'subagents.sqlite'))
  archive.open()
  const epoch = Date.now() - 60_000
  const saved = [[], [], []]
  for (let index = 0; index < count; index++) saved[index % 3].push({
    id: `saved-${index % 100}`, assignmentId: `assignment-${index}`, status: 'completed',
    title: 'Inspect synthetic code', prompt: `Task ${index}: ${'p'.repeat(1024)}`,
    message: `Result ${index}: ${'r'.repeat(2048)}`, observedAt: new Date(epoch).toISOString(),
  })
  saved.forEach((observations, index) => archive.ingest(ids[index], observations))
  for (let index = 0; index < 20; index++) archive.ingest(ids[index % 3], [{
    id: `active-${index}`, assignmentId: 'live-assignment', status: 'running',
    title: 'Review synthetic changes', observedAt: new Date(epoch).toISOString(), startedAt: new Date(epoch).toISOString(),
  }])
  archive.close()
  saved.length = 0
  const before = memory()
  host = new WorkspaceHost(native, directory)
  const start = performance.now()
  await host.initialize(); await host.connect()
  const startupMs = performance.now() - start
  const startupMemory = memory()
  // Twenty active agents distributed across the same three threads in both revisions.
  native.state.threads.forEach(thread => { thread.activities = [] })
  for (let index = 0; index < 20; index++) native.state.threads[index % 3].activities.push({
    id: `spawn-${index}`, turnId: 'live-turn', sequence: index, kind: 'subagent', title: 'Spawn', status: 'completed',
    agents: [{ id: `active-${index}`, assignmentId: 'live-assignment', title: 'Review synthetic changes',
      prompt: 'Check this synthetic task.', status: 'running', startedAt: new Date().toISOString(), observedAt: new Date().toISOString() }],
  })
  native.emit()
  let publishedBytes = 0
  let publications = 0
  const off = host.subscribe(snapshot => { publishedBytes += Buffer.byteLength(JSON.stringify(snapshot)); publications++ })
  let rosterPublications = 0
  const offRoster = host.subscribeSubagents?.(() => { rosterPublications++ })
  const durations = []
  const gaps = []
  let previous = performance.now()
  const timer = setInterval(() => { const now = performance.now(); gaps.push(now - previous); previous = now }, 5)
  const updatesStart = performance.now()
  try {
    for (let index = 0; index < 600; index++) {
      const agent = index % 20
      const row = native.state.threads[agent % 3].activities.find(row => row.id === `spawn-${agent}`)
      row.agents = [{ ...row.agents[0], observedAt: new Date(Date.now() + index).toISOString(), description: `Progress ${index}` }]
      const at = performance.now()
      native.emit()
      durations.push(performance.now() - at)
      await setImmediate()
    }
    gaps.push(performance.now() - previous)
  } finally { clearInterval(timer) }
  const updatesMs = performance.now() - updatesStart
  let pageMs = null
  if (host.subagentPage) {
    const at = performance.now()
    const page = await host.subagentPage({ threadId: ids[0] })
    pageMs = performance.now() - at
    assert.equal(page.rows.length, Math.min(50, Math.ceil(count / 3) + 7))
    assert.equal(host.workspaceSnapshot().threads.reduce((sum, thread) => sum + thread.subagentSummary.working, 0), 20)
    const results = await host.subagentAssignments({ threadId: ids[0], agentId: 'saved-0' })
    assert.ok(results.assignments[0].result.startsWith('Result '))
  }
  const after = memory()
  off(); offRoster?.()
  await host.flush(); host.dispose()
  const report = { startupMs, updatesMs, updateMedianMs: median(durations), updateP95Ms: percentile(durations, .95),
    updateMaxMs: Math.max(...durations), heartbeatMaxMs: Math.max(...gaps), pageMs,
    startupHeapDeltaMiB: (startupMemory.heapUsed - before.heapUsed) / 1048576,
    finalHeapMiB: after.heapUsed / 1048576, finalRssMiB: after.rss / 1048576,
    startupRssDeltaMiB: (startupMemory.rss - before.rss) / 1048576,
    retainedRssDeltaMiB: (after.rss - before.rss) / 1048576,
    retainedHeapDeltaMiB: (after.heapUsed - before.heapUsed) / 1048576, publications, rosterPublications, publishedBytes }
  if (process.env.SOTTO_PERF_ASSERT === '1') assert.ok(report.heartbeatMaxMs <= 250, `Main heartbeat ${report.heartbeatMaxMs} ms exceeds 250 ms: ${JSON.stringify(report)}`)
  return Object.fromEntries(Object.entries(report).map(([key, value]) => [key, value === null ? null : round(value)]))
}

if (process.argv[2] === '--sample') {
  const [, , , bundle, seedBundle, count, directory] = process.argv
  process.stdout.write(`${JSON.stringify(await measure(bundle, seedBundle, Number(count), directory))}\n`)
} else {
  const directory = mkdtempSync(join(tmpdir(), 'sotto-subagents-bench-'))
  try {
    const revision = execFileSync('git', ['rev-parse', process.env.SOTTO_PERF_BASE_REF ?? 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const samples = Number(process.env.SOTTO_PERF_SAMPLES ?? 5)
    assert.ok(Number.isInteger(samples) && samples > 0 && samples <= 30)
    const bundles = {}
    for (const mode of ['head', 'current']) {
      const outfile = join(directory, `${mode}.cjs`)
      await build({ stdin: { contents: "export { WorkspaceHost } from './src/main/agents/workspace'; export { FakeProviderHost } from './tests/fixtures/fakeProviderHost';", resolveDir: root, loader: 'ts' },
        bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
        plugins: mode === 'head' ? [{ name: 'tracked-head-source', setup(builder) {
          builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, args => {
            const path = relative(root, args.path).split(sep).join('/')
            if (!path.startsWith('src/')) return undefined
            return { contents: execFileSync('git', ['show', `${revision}:${path}`], { cwd: root, encoding: 'utf8' }), loader: path.endsWith('tsx') ? 'tsx' : path.endsWith('ts') ? 'ts' : 'js' }
          })
        } }] : [] })
      bundles[mode] = outfile
    }
    const seedBundle = join(directory, 'seed.cjs')
    await build({ entryPoints: [join(root, 'src/main/agents/subagentStore.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: seedBundle, logLevel: 'silent' })
    const results = []
    // Alternate order to reduce warm-filesystem and background-load bias.
    for (const assignments of [50, 5000]) for (let sample = 0; sample < samples; sample++) for (const mode of sample % 2 ? ['current', 'head'] : ['head', 'current']) {
      const sampleDirectory = join(directory, `${assignments}-${sample}-${mode}`)
      const result = JSON.parse(execFileSync(process.execPath, ['--expose-gc', script, '--sample', bundles[mode], seedBundle, String(assignments), sampleDirectory], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' }, timeout: 120_000 }))
      results.push({ mode, assignments, sample, ...result })
    }
    const summaries = []
    for (const assignments of [50, 5000]) for (const mode of ['head', 'current']) {
      const group = results.filter(result => result.assignments === assignments && result.mode === mode)
      summaries.push({ mode, assignments, median: Object.fromEntries(Object.keys(group[0]).filter(key => !['mode', 'assignments', 'sample'].includes(key)).map(key => [key, group[0][key] === null ? null : round(median(group.map(item => item[key])))])), worstHeartbeatMs: Math.max(...group.map(item => item.heartbeatMaxMs)) })
    }
    process.stdout.write(`${JSON.stringify({ revision, node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, logicalCpus: cpus().length, samples, summaries, results }, null, 2)}\n`)
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(directory.includes('sotto-subagents-bench-'))
    rmSync(directory, { recursive: true, force: true })
  }
}
