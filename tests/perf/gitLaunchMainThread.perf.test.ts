// @vitest-environment node
/**
 * How long Git status reads and worktree inspections hold the thread that asks for them. On Windows a process launch
 * is CreateProcess, synchronous on the calling thread, and in Electron that thread is the window's: a profile of the
 * installed app with threads running counted about 200 launches in 40 s holding main for 3.1 s, one for 2.2 s
 * (`docs/perf/2026-10-19-git-launch-off-main.md`). Each round here is four threads' worth at once, over a real
 * repository with an origin, a branch ahead of `main` and an uncommitted change: a status read each (the reader's
 * `read`) and an inspection each (`ThreadWorktrees.inspect` of a shared folder). It runs the rounds twice: launched in
 * this thread, as before, and through the launcher's worker. It counts the launches made on this thread, and how long
 * they held it, and how long the event loop could not turn: a chain of `setImmediate` measures each gap between
 * turns, which Windows' timer granularity does not round as `monitorEventLoopDelay` does.
 *
 * The counts are asserted on every run: with the worker, no launch is made on this thread and the status read is the
 * same. The stopwatch only under SOTTO_PERF_ASSERT=1; the figures, over eight rounds, print with:
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/gitLaunchMainThread.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { useGitLauncher } from '../../src/main/agents/gitLauncher'
import { GitStatusReader } from '../../src/main/agents/gitStatus'
import { ThreadWorktrees } from '../../src/main/agents/threadWorktrees'
import type { AgentWorktree } from '../../src/shared/agents'
import type { GitStatus } from '../../src/shared/gitStatus'
import { builtGitLauncherWorker } from '../fixtures/gitLauncherWorker'
import { ownedGitRepository } from '../fixtures/gitRepository'
import { mainThreadLaunches, resetMainThreadLaunches } from '../fixtures/mainThreadLaunches'
import { PERF_BENCH, round } from '../fixtures/perfBench'
import { expectWithinBudget } from '../fixtures/perfBudget'

vi.mock('node:child_process', async importOriginal => (await import('../fixtures/mainThreadLaunches')).timingLaunches(await importOriginal()))

/** Two rounds prove the counts in the default run; the benchmark's eight give the figures. */
const ROUNDS = PERF_BENCH ? 8 : 2
const THREADS = 4

let repository: Awaited<ReturnType<typeof ownedGitRepository>>
let worker: Awaited<ReturnType<typeof builtGitLauncherWorker>>
beforeAll(async () => {
  repository = await ownedGitRepository({ remote: true })
  repository.git('push', '-q', '-u', 'origin', 'main')
  repository.git('switch', '-q', '-c', 'feat/launch')
  await writeFile(join(repository.repo, 'ahead.txt'), 'ahead\n')
  repository.git('add', 'ahead.txt'); repository.git('commit', '-q', '-m', 'Ahead of main')
  await writeFile(join(repository.repo, 'tracked.txt'), 'changed\n')
  worker = await builtGitLauncherWorker()
}, 60_000)
afterAll(async () => { await useGitLauncher(null); await worker?.dispose(); await repository?.dispose() })

interface Run { readonly launches: number; readonly heldMs: number; readonly longestLaunchMs: number; readonly longestStallMs: number; readonly stalledMs: number; readonly wallMs: number; readonly status: GitStatus }

/** The event loop's turns while it runs: the longest gap between two, and the sum of the gaps over 2 ms. */
function stallMeter(): { stop(): { longestMs: number; stalledMs: number } } {
  let last = performance.now(), longestMs = 0, stalledMs = 0, running = true
  const turn = (): void => {
    const now = performance.now(), gap = now - last
    last = now; longestMs = Math.max(longestMs, gap); if (gap > 2) stalledMs += gap
    if (running) setImmediate(turn)
  }
  setImmediate(turn)
  return { stop: () => { running = false; return { longestMs, stalledMs } } }
}

async function rounds(): Promise<Run> {
  const reader = new GitStatusReader({ fetchIntervalMs: () => 0 })
  const worktrees = new ThreadWorktrees(join(repository.root, 'state'))
  const record: AgentWorktree = { mode: 'shared', status: 'ready', path: repository.repo, repositoryRoot: repository.repo }
  // One round first, outside the figures, so neither mode pays for starting the worker or a cold Git.
  await reader.read(repository.repo, { remote: false, fresh: true })
  resetMainThreadLaunches()
  const meter = stallMeter()
  const started = performance.now()
  let status: GitStatus | undefined
  for (let index = 0; index < ROUNDS; index++) {
    const reads = await Promise.all(Array.from({ length: THREADS }, () => reader.read(repository.repo, { remote: false, fresh: true })))
    await Promise.all(Array.from({ length: THREADS }, () => worktrees.inspect(record)))
    status = reads[0]
  }
  const wallMs = performance.now() - started
  const stalls = meter.stop()
  return { launches: mainThreadLaunches.count, heldMs: mainThreadLaunches.heldMs, longestLaunchMs: mainThreadLaunches.longestMs,
    longestStallMs: stalls.longestMs, stalledMs: stalls.stalledMs, wallMs, status: status! }
}

function report(label: string, run: Run): void {
  console.log(`${label}: ${run.launches} launches on this thread holding it ${round(run.heldMs)} ms (longest ${round(run.longestLaunchMs)} ms); `
    + `event loop held at most ${round(run.longestStallMs)} ms at a time, ${round(run.stalledMs)} ms in all; ${ROUNDS} rounds of ${THREADS} threads in ${round(run.wallMs)} ms`)
}

const withoutReadAt = (status: GitStatus): Omit<GitStatus, 'readAt'> => { const copy: Partial<GitStatus> = { ...status }; delete copy.readAt; return copy as Omit<GitStatus, 'readAt'> }

describe('Git launches and the thread that asks for them', () => {
  it('launches every status read and inspection off this thread through the worker, with the same answer', async () => {
    await useGitLauncher(null)
    const before = await rounds()
    await useGitLauncher(worker.path)
    const after = await rounds()
    report('Launched in this thread', before)
    report('Launched on the worker', after)
    // Each round is four reads of six commands (the default branch is kept from the first) and four inspections of three.
    expect(before.launches).toBe(ROUNDS * THREADS * (6 + 3))
    expect(after.launches).toBe(0)
    expect(withoutReadAt(after.status)).toEqual(withoutReadAt(before.status))
    expect(after.status).toMatchObject({ branch: 'feat/launch', dirty: true, aheadOfDefault: 1, isDefaultBranch: false })
    expectWithinBudget(after.longestStallMs, 10, 'the longest the event loop was held with launches on the worker')
  }, 120_000)
})
