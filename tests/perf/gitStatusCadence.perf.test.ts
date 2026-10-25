// @vitest-environment node
/**
 * How many Git processes the workspace starts while threads work, and what for. Three threads share the project's
 * folder, a real repository with an origin, the way new threads do by default (ADR-0014), and each finishes a tool
 * call about every quarter second for eight seconds, on a beat of its own: each finished call asks for the trailing re-read of its thread's folder
 * (an inspection and a status read) the host makes after work that may have moved HEAD. The real reader and the real
 * refresh delay; the provider is the fake one. Counts only, nothing about a prompt or a command. The counts follow the
 * clock, so it asserts nothing and runs only under `SOTTO_PERF_BENCH=1` (`tests/fixtures/perfBench.ts`):
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/gitStatusCadence.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { afterAll, describe, it, vi } from 'vitest'
import { GitStatusReader } from '../../src/main/agents/gitStatus'
import { ThreadWorktrees } from '../../src/main/agents/threadWorktrees'
import type { AgentActivity } from '../../src/shared/agentActivity'
import { gitSpawns } from '../fixtures/gitSpawnCounter'
import { PERF_BENCH } from '../fixtures/perfBench'
import { idle, repositoryWithOrigin, startedThread, type SendGitFixture } from '../fixtures/sendGit'

vi.mock('node:child_process', async importOriginal => (await import('../fixtures/gitSpawnCounter')).countingGit(await importOriginal()))

const THREADS = ['first', 'second', 'third']
const SECONDS = 8
/** A tool call finished about every quarter second in each thread, on beats that do not line up. */
const BEATS_MS = [230, 290, 370]
const fixtures: SendGitFixture[] = []
afterAll(async () => { for (const f of fixtures.splice(0)) { await f.stop(); await f.remove() } })

describe.skipIf(!PERF_BENCH)('Git while threads work (count benchmark; requires SOTTO_PERF_BENCH=1)', () => {
  it('counts the Git processes, status reads and inspections of three working threads in one folder', async () => {
    // The host's own refresh delay, not the fixture's usual one, which never refreshes inside a test.
    const f = await repositoryWithOrigin({ worktreeRefreshDelayMs: 1_500 }); fixtures.push(f)
    for (const id of THREADS) { await startedThread(f, id, 'shared'); await idle(f, id) }
    const reader = new GitStatusReader({ fetchIntervalMs: () => 30_000 })
    f.host.setGitStatus(reader, { pollIntervalMs: () => 30_000 })
    // Every inspection of a shared folder reads it through inspectSharedFolder, whether a record's own or a round's.
    const reads = vi.spyOn(reader, 'read'), inspections = vi.spyOn(ThreadWorktrees.prototype, 'inspectSharedFolder')
    const sessions = f.adapters.codex.state.threads.slice(-THREADS.length)
    for (const session of sessions) { session.status = 'running'; session.activities = [] }
    f.adapters.codex.emit()
    // Past the refresh delay, so the rounds the threads' first sends asked for are over before the count begins.
    await new Promise(resolve => setTimeout(resolve, 2_000))
    const before = { git: gitSpawns.count, reads: reads.mock.calls.length, inspections: inspections.mock.calls.length }
    // Each thread on a beat of its own, as working threads are: none waits for another's tool calls.
    let sequence = 0
    const started = performance.now()
    await Promise.all(sessions.map(async (session, index) => {
      while (performance.now() - started < SECONDS * 1_000) {
        const id = `tool-${++sequence}`
        const finished: AgentActivity = { id, turnId: 'turn', sequence, kind: 'tool', status: 'completed', title: 'Read a file' }
        session.activities = [...session.activities ?? [], finished]
        f.adapters.codex.emit()
        await new Promise(resolve => setTimeout(resolve, BEATS_MS[index]))
      }
    }))
    const counted = { git: gitSpawns.count - before.git, reads: reads.mock.calls.length - before.reads, inspections: inspections.mock.calls.length - before.inspections }
    console.log(`${THREADS.length} threads in one folder for ${SECONDS} s: ${counted.git} Git processes (${(counted.git / SECONDS).toFixed(1)} a second), `
      + `${counted.reads} status reads, ${counted.inspections} inspections`)
    for (const session of sessions) session.status = 'idle'
    f.adapters.codex.emit()
  }, 60_000)
})
