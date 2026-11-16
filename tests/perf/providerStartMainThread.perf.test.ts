// @vitest-environment node
/**
 * How long starting a thread's Claude Code or Codex holds the thread that asks for it (#2550). On Windows a process
 * launch is CreateProcess, synchronous on the calling thread, and in Electron that thread is the window's. The first
 * start of an executable Windows has let go of is slow: the owner's laptop recorded main stopped for 1.6 to 2.7 s inside
 * `spawn` under `new ClaudeProtocol` five times on November 16, 2026, with Claude Code's 372 MB executable unchanged
 * since November 13 (`docs/perf/2026-11-16-provider-start-off-main.md`).
 *
 * The default run asserts the counts: started through the provider launcher's worker, a Claude Code start and a Codex
 * start each answer `initialize` and make no launch on this thread, where started in this thread each makes one. A
 * chain of `setImmediate` measures how long the event loop could not turn (Windows' timer granularity rounds
 * `monitorEventLoopDelay` to about 16 ms).
 *
 * The benchmark starts a cold executable each time: a fresh copy of one, which Windows has never started, so each start
 * pays what a start after Windows let go of the file pays. The copy is of this Node, or of the file
 * `SOTTO_PROVIDER_START_EXECUTABLE` names (Claude Code's own `claude.exe`, for one), run with `--version`:
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/providerStartMainThread.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *
 * The stopwatch (the longest the event loop is held with starts on the worker) is asserted only under SOTTO_PERF_ASSERT=1.
 */
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { useProviderLauncher } from '../../src/main/agents/git/gitLauncher'
import { ClaudeProtocol } from '../../src/main/agents/providers/claude/claudeProtocol'
import { CodexProcess } from '../../src/main/agents/providers/codex/codexProcess'
import { ClaudeSubscriptionClient } from '../../src/main/agents/subscriptionClaude'
import { writeWithCodexExec } from '../../src/main/agents/subscriptionCodex'
import { builtGitLauncherWorker } from '../fixtures/gitLauncherWorker'
import { mainThreadLaunches, resetMainThreadLaunches } from '../fixtures/mainThreadLaunches'
import { PERF_BENCH, round } from '../fixtures/perfBench'
import { expectWithinBudget } from '../fixtures/perfBudget'

vi.mock('node:child_process', async importOriginal => (await import('../fixtures/mainThreadLaunches')).timingLaunches(await importOriginal()))

/** Answers Claude Code's `initialize` control request and Codex's `initialize` call, then waits for its input to close. */
const PROVIDER = `
const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { commands: [] } } }) + '\\n');
  else if (frame.method === 'initialize') process.stdout.write(JSON.stringify({ id: frame.id, result: { userAgent: 'fake' } }) + '\\n');
});
`
const COLD_STARTS = 5

let root: string
let script: string
let worker: Awaited<ReturnType<typeof builtGitLauncherWorker>>
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sotto-provider-start-'))
  script = join(root, 'provider.cjs')
  await writeFile(script, PROVIDER)
  worker = await builtGitLauncherWorker()
}, 60_000)
afterAll(async () => {
  await useProviderLauncher(null)
  await worker?.dispose()
  if (root && dirname(resolve(root)) === resolve(tmpdir()) && root.includes('sotto-provider-start-')) await rm(root, { recursive: true, force: true, maxRetries: 3 })
})

/** The event loop's turns while it runs: the longest gap between two. */
function stallMeter(): { stop(): number } {
  let last = performance.now(), longest = 0, running = true
  const turn = (): void => {
    const now = performance.now()
    longest = Math.max(longest, now - last); last = now
    if (running) setImmediate(turn)
  }
  setImmediate(turn)
  return { stop: () => { running = false; return longest } }
}

/** One Claude Code start: `initialize` answered, then let go. */
async function startClaude(executable = process.execPath): Promise<void> {
  const protocol = new ClaudeProtocol(executable, [script], root, process.env, 30_000, () => undefined, () => undefined)
  const initialized = await protocol.control({ subtype: 'initialize' })
  expect(initialized).toEqual({ commands: [] })
  protocol.stop(); await protocol.closed
}

/** One Codex app-server start: `initialize` answered, then let go. */
async function startCodex(): Promise<void> {
  let answer: unknown
  const server = new CodexProcess({ executable: process.execPath, args: [script], cwd: root, env: process.env, requestTimeoutMs: 30_000,
    enqueue: task => task(), onFrame: async () => undefined, onLost: () => undefined, rejection: error => new Error(String(error)) })
  await server.rpc('initialize', {}, result => { answer = result })
  expect(answer).toEqual({ userAgent: 'fake' })
  server.end(); await server.closed
}

/** The side calls a thread's title and drafts go through (ADR-0026): Claude Code's version read, and a Codex write. */
async function sideCalls(): Promise<void> {
  await new ClaudeSubscriptionClient(root, { prefixArgs: [script] }).version(process.execPath)
  await writeWithCodexExec({ executable: process.execPath, prefixArgs: [script], codexHome: root, instruction: 'Name it.', material: 'A thread.',
    model: 'gpt-test', workingDirectory: root, timeoutMs: 30_000 }).catch(() => undefined)
}

/** A start of `executable` run with `--version`, to its close. */
async function startVersion(executable: string): Promise<void> {
  const protocol = new ClaudeProtocol(executable, ['--version'], root, process.env, 30_000, () => undefined, () => undefined)
  await protocol.closed
}

async function measured(start: () => Promise<void>): Promise<{ launches: number; longestStallMs: number }> {
  resetMainThreadLaunches()
  const meter = stallMeter()
  await start()
  return { launches: mainThreadLaunches.count, longestStallMs: meter.stop() }
}

describe('a thread provider start and the thread that asks for it', () => {
  it('starts Claude Code and Codex, and their side calls, on the provider launcher\'s worker, with no launch on this thread', async () => {
    await useProviderLauncher(null)
    const claudeHere = await measured(() => startClaude())
    const codexHere = await measured(startCodex)
    const sideHere = await measured(sideCalls)
    await useProviderLauncher(worker.path)
    // One start first, outside the counts, so the worker's own start is not counted against the starts it makes.
    await startClaude()
    const claudeOff = await measured(() => startClaude())
    const codexOff = await measured(startCodex)
    const sideOff = await measured(sideCalls)
    expect(claudeHere.launches).toBe(1)
    expect(codexHere.launches).toBe(1)
    expect(sideHere.launches).toBe(2)
    expect(claudeOff.launches).toBe(0)
    expect(codexOff.launches).toBe(0)
    expect(sideOff.launches).toBe(0)
  }, 60_000)

  it.skipIf(!PERF_BENCH)('holds the event loop for a cold executable\'s start only when started in this thread', async () => {
    const source = process.env.SOTTO_PROVIDER_START_EXECUTABLE || process.execPath
    const extension = process.platform === 'win32' ? '.exe' : ''
    let copies = 0
    const cold = async (): Promise<string> => { const copy = join(root, `cold-${++copies}${extension}`); await copyFile(source, copy); return copy }
    const run = async (label: string, workerPath: string | null): Promise<number[]> => {
      await useProviderLauncher(workerPath)
      await startVersion(source)
      const stalls: number[] = []
      for (let index = 0; index < COLD_STARTS; index++) {
        const copy = await cold()
        stalls.push((await measured(() => startVersion(copy))).longestStallMs)
      }
      console.log(`${label}: longest event-loop stall per cold start ${stalls.map(stall => round(stall)).join(' / ')} ms`)
      return stalls
    }
    console.log(`Cold starts of a fresh copy of ${source}`)
    await run('Started in this thread', null)
    const off = await run('Started on the provider launcher\'s worker', worker.path)
    expectWithinBudget(Math.max(...off), 50, 'the longest the event loop was held by a cold provider start on the worker')
  }, 300_000)

  it.skipIf(!PERF_BENCH)('costs this thread about the same to read a streaming provider through the worker', async () => {
    // Codex's app-server printing 64 MB of notifications in 16 KB lines, read to the last one: this thread's busy time
    // and the wall time, started in this thread and through the worker that relays each chunk.
    const LINES = 4096, streamer = join(root, 'stream.cjs')
    await writeFile(streamer, `const line = JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'x'.repeat(16_000) } }) + '\\n';
let left = ${LINES}; const more = () => { while (left > 0) { left--; if (!process.stdout.write(line)) { process.stdout.once('drain', more); return } } };
process.stdin.once('data', more); process.stdin.resume();`)
    const read = async (): Promise<{ busyMs: number; wallMs: number }> => {
      let seen = 0, done!: () => void
      const all = new Promise<void>(resolve => { done = resolve })
      const server = new CodexProcess({ executable: process.execPath, args: [streamer], cwd: root, env: process.env, requestTimeoutMs: 30_000,
        enqueue: task => task(), onFrame: async () => { if (++seen === LINES) done() }, onLost: () => undefined, rejection: error => new Error(String(error)) })
      await new Promise(resolve => setTimeout(resolve, 200))
      const before = performance.eventLoopUtilization(), started = performance.now()
      server.write({ method: 'go' })
      await all
      const wallMs = performance.now() - started, used = performance.eventLoopUtilization(before)
      server.end(); await server.closed
      return { busyMs: used.active, wallMs }
    }
    for (const [label, workerPath] of [['Read in this thread', null], ['Read through the worker', worker.path]] as const) {
      await useProviderLauncher(workerPath)
      await read()
      const runs = [await read(), await read(), await read()]
      console.log(`${label}: this thread busy ${runs.map(run => round(run.busyMs)).join(' / ')} ms, wall ${runs.map(run => round(run.wallMs)).join(' / ')} ms for 64 MB`)
    }
  }, 300_000)
})
