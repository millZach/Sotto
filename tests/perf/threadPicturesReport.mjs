/**
 * Turns what `tests/e2e/thread-pictures-cost.spec.ts` saved into the tables of
 * `docs/perf/2026-11-04-thread-pictures-cost.md`, each number the median of its runs with the lowest and highest beside it.
 *
 *   node tests/perf/threadPicturesReport.mjs [root] [label-of-clean-pass]
 *   node tests/perf/threadPicturesReport.mjs --trace <trace.json> <renderer pid>
 */
import console from 'node:console'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

// The middle sample, or the mean of the middle two, as `tests/fixtures/perfBench.ts` reports one.
const median = values => { const sorted = [...values].sort((a, b) => a - b); const middle = sorted.length >> 1; return sorted.length === 0 ? 0 : sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 }
const spread = (values, places = 0) => {
  const kept = values.filter(value => typeof value === 'number' && Number.isFinite(value))
  if (!kept.length) return '-'
  const fix = value => value.toFixed(places)
  return kept.length === 1 ? fix(kept[0]) : `${fix(median(kept))} (${fix(Math.min(...kept))}-${fix(Math.max(...kept))})`
}
const table = (headers, rows) => [`| ${headers.join(' | ')} |`, `| ${headers.map((_, index) => index ? '---:' : '---').join(' | ')} |`, ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n')
const read = path => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
/** A pass's lines from a results root (`results-<pass>.jsonl`) or from a copy in docs/perf/data (`<pass>.jsonl`). */
const results = name => { const kept = join(root, `results-${name}.jsonl`); return read(existsSync(kept) ? kept : join(root, `${name}.jsonl`)) }
const byCase = lines => { const held = new Map(); for (const line of lines) held.set(line.case, [...held.get(line.case) ?? [], line]); return held }
const pick = (runs, path) => runs.map(run => path.split('.').reduce((value, key) => value?.[key], run))
const MiB = 1024 * 1024

const GROUPS = [
  ['Style', /^(UpdateLayoutTree|RecalculateStyles|ParseAuthorStyleSheet)$/u],
  ['Layout', /^(Layout|UpdateLayer|IntersectionObserverController::computeIntersections|ComputeIntersections)$/u],
  ['Paint and commit', /^(PrePaint|Paint|Layerize|Commit|UpdateLayerTree|CompositeLayers)$/u],
  ['Decoding on the window', /(Decode Image|Decode LazyPixelRef|ImageDecodeTask|Resize Image|Draw LazyPixelRef)/u],
  ['Garbage collection', /^(MajorGC|MinorGC|V8\.GC|BlinkGC|ThreadState::|CppGC|V8\.GCScavenger|V8\.GCCompactor)/u],
  ['Script', /^(FunctionCall|EvaluateScript|v8\.|V8\.|RunMicrotasks|FireAnimationFrame|TimerFire|EventDispatch|HitTest|v8::)/u],
]
const groupOf = name => GROUPS.find(([, pattern]) => pattern.test(name))?.[0] ?? 'Other'

/** Each task's time on the window's main thread by what it was itself doing, nested events taken out, and the window's other threads. */
export function splitTrace(path, rendererPid) {
  const { traceEvents } = JSON.parse(readFileSync(path, 'utf8'))
  const names = new Map()
  for (const event of traceEvents) if (event.ph === 'M' && event.name === 'thread_name') names.set(`${event.pid}:${event.tid}`, event.args.name)
  const main = [...names].find(([key, name]) => key.startsWith(`${rendererPid}:`) && name === 'CrRendererMain')?.[0]
  const browser = [...names].find(([, name]) => name === 'CrBrowserMain')?.[0]
  const self = {}, others = {}
  let browserBusy = 0
  const spans = traceEvents.filter(event => event.ph === 'X' && typeof event.dur === 'number').sort((a, b) => a.ts - b.ts || b.dur - a.dur)
  const stack = []
  for (const event of spans) {
    const key = `${event.pid}:${event.tid}`
    if (key === browser && (event.name === 'ThreadControllerImpl::RunTask' || event.name === 'RunTask')) browserBusy += event.dur
    if (key !== main) {
      if (event.pid === rendererPid && /(Decode|Raster|ImageDecodeTask)/u.test(event.name) && event.name !== 'Decode LazyPixelRef') others[event.name] = (others[event.name] ?? 0) + event.dur
      continue
    }
    while (stack.length && stack.at(-1).ts + stack.at(-1).dur <= event.ts) stack.pop()
    if (stack.length) self[stack.at(-1).name] -= event.dur
    self[event.name] = (self[event.name] ?? 0) + event.dur
    stack.push(event)
  }
  const groups = {}
  for (const [name, micros] of Object.entries(self)) groups[groupOf(name)] = (groups[groupOf(name)] ?? 0) + micros / 1000
  return { groups, others: Object.fromEntries(Object.entries(others).map(([name, micros]) => [name, micros / 1000])), browserBusyMs: browserBusy / 1000 }
}

if (process.argv[2] === '--trace') {
  console.log(JSON.stringify(splitTrace(process.argv[3], Number(process.argv[4])), null, 1))
  process.exit(0)
}

const root = process.argv[2] ?? join(homedir(), '.cache', 'sotto-thread-pictures')
const suffix = process.argv[3] ? `-${process.argv[3]}` : ''
const clean = byCase(results(`clean${suffix}`))
const counted = byCase(results(`counted${suffix}`))
const switches = runs => runs.flatMap(run => run.switchBack ?? [])

if (clean.size) {
  console.log('\n### Opening and switching back\n')
  console.log(table(['Case', 'Runs', 'Open: last reply drawn, ms', 'Open: near tiles hold pictures, ms', 'Tiles near', 'Back: last reply drawn, ms', 'Back: near tiles, ms', 'Main stalled while opening, ms', 'Longest main stall, ms'],
    [...clean].map(([id, runs]) => [id, runs.length, spread(pick(runs, 'open.openedMs')), spread(pick(runs, 'open.tilesMs')), median(pick(runs, 'open.nearTiles')),
      spread(switches(runs).map(item => item.openedMs)), spread(switches(runs).map(item => item.tilesMs)), spread(pick(runs, 'open.mainLoop.stalledMs')), spread(pick(runs, 'open.mainLoop.longestMs'))])))
  console.log('\n### Renderer memory (proportional, MiB)\n')
  console.log(table(['Case', 'Before opening', 'Peak opening', 'Settled after opening', 'Peak scrolling', 'Settled after scrolling', 'After a forced collection', 'Peak with updates', 'Main before', 'Main peak'],
    [...clean].map(([id, runs]) => [id, spread(pick(runs, 'baseline.rendererMiB')), spread(pick(runs, 'open.peak.renderer')), spread(pick(runs, 'settled.rendererMiB')), spread(pick(runs, 'scroll.peak.renderer')),
      spread(pick(runs, 'afterScroll.rendererMiB')), spread(pick(runs, 'afterGc.rendererMiB')), spread(pick(runs, 'updatesPeak.renderer')), spread(pick(runs, 'baseline.mainMiB')), spread(pick(runs, 'scroll.peak.main'))])))
  console.log('\n### Scrolling: up and back at 2,400 px/s\n')
  console.log(table(['Case', 'Trip, px', 'Frames', 'Longest frame, ms', 'Frames over 33 ms', 'Over 50 ms', 'Long tasks', 'Window busy, ms per second', 'Main stalled, ms', 'Longest main stall, ms', 'Jump to top until tiles hold, ms'],
    [...clean].map(([id, runs]) => [id, median(pick(runs, 'scroll.px')), spread(pick(runs, 'scroll.frames.frames')), spread(pick(runs, 'scroll.frames.longestFrameMs'), 1), spread(pick(runs, 'scroll.frames.over33')), spread(pick(runs, 'scroll.frames.over50')), spread(pick(runs, 'scroll.frames.longTasks')),
      spread(runs.map(run => run.scroll.work.taskMs / Math.max(run.scroll.px / 2400, 0.001))), spread(pick(runs, 'scroll.mainLoop.stalledMs')), spread(pick(runs, 'scroll.mainLoop.longestMs')), spread(pick(runs, 'jump.ms'))])))
  console.log('\n### One update while the thread works, ms beyond idle\n')
  const kinds = { steps: 'A step', chunks: 'A word chunk', pictureSteps: 'A step with a picture' }
  console.log(table(['Case', ...Object.values(kinds).flatMap(name => [`${name}: window`, `${name}: main`]), 'Longest frame in steps, ms'],
    [...clean].map(([id, runs]) => [id, ...Object.keys(kinds).flatMap(kind => [spread(pick(runs, `updates.${kind}.rendererMsPerUpdate`), 1), spread(pick(runs, `updates.${kind}.mainCpuMsPerUpdate`), 1)]), spread(pick(runs, 'updates.steps.longestFrameMs'), 1)])))
}

if (counted.size) {
  const line = (run, phase) => run[phase] ?? {}
  console.log('\n### What crossed to the window, and main\'s work (counted runs)\n')
  const phases = [['openCounts', 'Open'], ['switchCounts', 'Back x3'], ['scrollCounts', 'One trip'], ['jumpCounts', 'Jump'], ['updateCounts', 'Updates']]
  console.log(table(['Case', 'Phase', 'Tile reads', 'Picture bytes to window', 'Decodes on main', 'Main decoding, ms', 'Main resizing, ms', 'Main JPEG, ms', 'Whole picture read, bytes', 'Thread detail sends', 'Detail bytes', 'State sends', 'State bytes'],
    [...counted].flatMap(([id, runs]) => phases.map(([phase, name]) => {
      const lines = runs.map(run => line(run, phase))
      const get = path => pick(lines, path)
      return [id, name, spread(get('media.tile.calls')), spread(get('media.tile.bytes')), spread(get('decode.calls')), spread(get('decode.ms')), spread(get('resize.ms')), spread(get('jpeg.ms')), spread(get('decode.bytes')),
        spread(get('sends.sotto:agents:thread-detail.calls')), spread(get('sends.sotto:agents:thread-detail.bytes')), spread(get('sends.sotto:agents:state.calls')), spread(get('sends.sotto:agents:state.bytes'))]
    }))))
  console.log('\n### What holds the window\'s memory (Chromium memory dump, MiB)\n')
  const size = (dump, name) => (dump?.[name] ?? 0) / MiB
  const parts = [['cc/image_memory', 'Decoded pictures (cc/image_memory)'], ['discardable', 'Discardable'], ['shared_memory', 'Shared memory'], ['web_cache/Image_resources', 'Encoded pictures (web_cache)'], ['v8', 'V8'], ['partition_alloc', 'PartitionAlloc'], ['malloc', 'malloc'], ['blink_gc', 'Blink GC'], ['cc/tile_memory', 'Raster tiles']]
  console.log(table(['Case', 'When', 'Renderer', ...parts.map(([, name]) => name), 'Data URLs on tiles'],
    [...counted].flatMap(([id, runs]) => [['settledDump', 'settled', 'After opening', 'settledSources'], ['afterScrollDump', 'afterScroll', 'After one trip', 'afterScrollSources']].map(([dump, memory, name, sources]) =>
      [id, name, spread(pick(runs, `${memory}.rendererMiB`)), ...parts.map(([part]) => spread(runs.map(run => size(run[dump], part)), 1)), spread(runs.map(run => (run[sources]?.bytes ?? 0) / MiB), 1)]))))
  const trips = [...counted].filter(([, runs]) => runs[0].trips)
  if (trips.length) {
    console.log('\n### Further trips through the same thread\n')
    console.log(table(['Case', 'Trip', 'Renderer MiB', 'Main MiB', 'Decoded pictures MiB', 'Tile reads', 'Decodes on main', 'Longest frame, ms'],
      trips.flatMap(([id, runs]) => [0, 1, 2].map(index => [id, `After update trip ${index + 1}`, spread(runs.map(run => run.trips[index]?.rendererMiB)), spread(runs.map(run => run.trips[index]?.mainMiB)), spread(runs.map(run => size(run.trips[index]?.dump, 'cc/image_memory')), 1),
        spread(runs.map(run => run.trips[index]?.counts?.media?.tile?.calls)), spread(runs.map(run => run.trips[index]?.counts?.decode?.calls)), spread(runs.map(run => run.trips[index]?.frames?.longestFrameMs), 1)]))))
    console.log(`\nThirty seconds on: ${trips.map(([id, runs]) => `${id}: ${spread(runs.map(run => run.after30s?.rendererMiB))} MiB, decoded ${spread(runs.map(run => size(run.after30s?.dump, 'cc/image_memory')), 1)} MiB`).join('; ')}`)
    console.log(`\nTold the computer is short of memory: ${trips.map(([id, runs]) => `${id}: ${spread(runs.map(run => run.afterPressure?.rendererMiB))} MiB, decoded ${spread(runs.map(run => size(run.afterPressure?.dump, 'cc/image_memory')), 1)} MiB`).join('; ')}`)
  }
}

const sweep = results(`sweep${suffix}`)
if (sweep.length) {
  console.log('\n### An update by how many pictures the working turn holds (275 extra steps each)\n')
  const held = new Map()
  for (const line of sweep) held.set(line.tilesInTurn, [...held.get(line.tilesInTurn) ?? [], line])
  console.log(table(['Tiles in the working turn', 'Runs', 'A step: window, ms', 'A step: script, ms', 'A step: main, ms', 'A chunk: window, ms', 'A chunk: main, ms', 'Longest frame, ms'],
    [...held].map(([tiles, runs]) => [tiles, runs.length, spread(pick(runs, 'updates.steps.rendererMsPerUpdate'), 1), spread(pick(runs, 'updates.steps.scriptMsPerUpdate'), 1), spread(pick(runs, 'updates.steps.mainCpuMsPerUpdate'), 1), spread(pick(runs, 'updates.chunks.rendererMsPerUpdate'), 1), spread(pick(runs, 'updates.chunks.mainCpuMsPerUpdate'), 1), spread(pick(runs, 'updates.steps.longestFrameMs'), 1)])))
}

const undriven = results(`undriven${suffix}`)
if (undriven.length) {
  const threads = undriven.filter(line => line.arm === 'thread')
  // The thread arm adds 76 steps to the working turn and the sweep arm 275, so the two are never pooled.
  const name = line => `${line.arm}: ${line.tiles} pictures, ${line.tilesInTurn} of ${line.arm === 'sweep' ? 275 : 76} new steps with pictures, warning ${line.warning ? 'on' : 'silenced'}`
  const group = lines => { const held = new Map(); for (const line of lines) held.set(name(line), [...held.get(name(line)) ?? [], line]); return [...held] }
  console.log('\n### No debugger on the window: the thread\n')
  console.log(table(['Case', 'Runs', 'Open: reply drawn, ms', 'Open: tiles hold, ms', 'Back: tiles hold, ms', 'Window before, MiB', 'Settled, MiB', 'After a trip, MiB', 'Main after a trip, MiB', 'Trip: longest frame, ms', 'Frames over 33 ms', 'Trip CPU: main thread, ms', 'Trip CPU: all of main, ms', 'Trip CPU: window main thread, ms', 'Trip CPU: all of window, ms'],
    group(threads).map(([id, runs]) => [id, runs.length, spread(pick(runs, 'open.openedMs')), spread(pick(runs, 'open.tilesMs')), spread(pick(runs, 'back.tilesMs')), spread(pick(runs, 'baseline.renderer')), spread(pick(runs, 'settled.renderer')), spread(pick(runs, 'afterScroll.renderer')), spread(pick(runs, 'afterScroll.main')),
      spread(pick(runs, 'scroll.frames.longestFrameMs'), 1), spread(pick(runs, 'scroll.frames.over33')), spread(pick(runs, 'scroll.cpu.mainThread')), spread(pick(runs, 'scroll.cpu.main')), spread(pick(runs, 'scroll.cpu.windowThread')), spread(pick(runs, 'scroll.cpu.window'))])))
  console.log('\n### No debugger on the window: one update, CPU ms beyond idle\n')
  console.log(table(['Case', 'Runs', 'Step: window main thread', 'Step: all of window', 'Step: main thread', 'Step: all of main', 'Chunk: window main thread', 'Chunk: all of window', 'Chunk: main thread', 'Chunk: all of main', 'Longest frame in steps, ms'],
    group(undriven).map(([id, runs]) => [id, runs.length, spread(pick(runs, 'steps.windowThread'), 1), spread(pick(runs, 'steps.windowAll'), 1), spread(pick(runs, 'steps.mainThread'), 1), spread(pick(runs, 'steps.mainAll'), 1), spread(pick(runs, 'chunks.windowThread'), 1), spread(pick(runs, 'chunks.windowAll'), 1), spread(pick(runs, 'chunks.mainThread'), 1), spread(pick(runs, 'chunks.mainAll'), 1), spread(pick(runs, 'steps.longestFrameMs'), 1)])))
}

const tracesRoot = join(root, 'traces')
const tracedRuns = results(`trace${suffix}`)
if (existsSync(tracesRoot) && tracedRuns.length) {
  for (const phase of ['open', 'switch', 'scroll', 'updates']) {
    const rows = new Map()
    for (const run of tracedRuns) {
      const path = join(tracesRoot, `${run.case}-${run.run}`, `${phase}.json`)
      if (!existsSync(path)) continue
      const split = splitTrace(path, run.pids.renderer)
      rows.set(run.case, [...rows.get(run.case) ?? [], split])
    }
    if (!rows.size) continue
    const groups = [...GROUPS.map(([name]) => name), 'Other']
    console.log(`\n### Where the window's main thread went: ${phase} (traced runs, ms)\n`)
    console.log(table(['Case', ...groups, 'Decode and raster on other threads', 'Main process busy'],
      [...rows].map(([id, splits]) => [id, ...groups.map(name => spread(splits.map(split => split.groups[name] ?? 0))), spread(splits.map(split => Object.values(split.others).reduce((sum, value) => sum + value, 0))), spread(splits.map(split => split.browserBusyMs))])))
  }
}
