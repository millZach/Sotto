// @vitest-environment node
/**
 * What Keep main up to date costs main when it moves a checkout many threads work in (ADR-0142). After a fast-forward
 * the host has every thread in that folder read its Git status again, so its branch stops saying it is behind. On the
 * owner's laptop on November 12, 2026, 392 threads worked in the project's folder, 391 of them settled, and each read the
 * folder for itself: main was blocked for 1.1 to 1.6 s about two minutes after each of three merges.
 *
 * The folder is a real repository with an origin, the reader is the real one and the provider is the fake one. The Git
 * processes started and the writes of the workspace are counted for a few threads and for several times as many: one
 * folder is one read however many threads work in it, so neither count may grow with the threads. Counts only.
 *
 * `SOTTO_PERF_CHECKOUT_THREADS` sets the larger count, and prints how long main was blocked, for a measurement:
 *
 *   SOTTO_PERF_CHECKOUT_THREADS=120 npx vitest run tests/perf/mainCheckoutMoved.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, expect, it, vi } from 'vitest'
import { GitStatusReader } from '../../src/main/agents/git/gitStatus'
import { gitSpawns } from '../fixtures/gitSpawnCounter'
import { repositoryWithOrigin, startedThread, type SendGitFixture } from '../fixtures/sendGit'

vi.mock('node:child_process', async importOriginal => (await import('../fixtures/gitSpawnCounter')).countingGit(await importOriginal()))

const FEW = 3
const MANY = Number(process.env.SOTTO_PERF_CHECKOUT_THREADS ?? 12)
const fixtures: SendGitFixture[] = []
afterAll(async () => { for (const f of fixtures.splice(0)) { await f.stop(); await f.remove() } })
const run = promisify(execFile)
const git = async (cwd: string, ...args: string[]): Promise<string> => (await run('git', ['-c', 'user.name=Sotto', '-c', 'user.email=sotto@example.invalid', '-c', 'commit.gpgSign=false', ...args], { cwd, windowsHide: true })).stdout

/** The longest stretch the thread could not run a timer, as main's own monitor measures a freeze. */
class Blocked {
  private last = performance.now()
  private readonly timer = setInterval(() => this.sample(), 5)
  longest = 0; total = 0
  private sample(): void { const now = performance.now(), late = now - this.last - 5; this.last = now; if (late > 2) { this.total += late; if (late > this.longest) this.longest = late } }
  reset(): void { this.sample(); this.longest = 0; this.total = 0 }
  stop(): void { clearInterval(this.timer) }
}

/** `threads` threads in the project's folder, the folder moved forward under them, and what the re-read cost. */
async function moved(threads: number): Promise<{ git: number; saves: number; behindAfter: number[]; blockedMs: number; longestMs: number; tookMs: number }> {
  const f = await repositoryWithOrigin(); fixtures.push(f)
  const reader = new GitStatusReader({ fetchIntervalMs: () => 600_000 })
  f.host.setGitStatus(reader, { pollIntervalMs: () => 0 })
  const ids = Array.from({ length: threads }, (_, index) => `thread-${index}`)
  for (const id of ids) await startedThread(f, id, 'shared')
  const host = f.host as unknown as { projectCheckoutMoved(folder: string): Promise<void>; flush(): Promise<void> }
  // Another clone pushes a commit, and the folder fetches it: every thread there is one commit behind.
  const other = await mkdtemp(join(f.root, 'other-'))
  await git(f.root, 'clone', '-q', join(f.root, 'origin.git'), other)
  await writeFile(join(other, 'merged.txt'), 'merged\n')
  await git(other, 'add', '.'); await git(other, 'commit', '-qm', 'Merged elsewhere'); await git(other, 'push', '-q', 'origin', 'HEAD:main')
  await git(f.project, 'fetch', '-q', 'origin')
  reader.invalidate(f.project)
  await host.projectCheckoutMoved(f.project)
  const behind = (): number[] => ids.map(id => f.host.workspaceSnapshot().threads.find(thread => thread.id === id)?.worktree?.git?.behind ?? -1)
  expect(behind()).toEqual(ids.map(() => 1))
  // Keep main up to date fast-forwards the folder, tells the reader and the host, and every thread reads it again.
  await git(f.project, 'merge', '-q', '--ff-only', 'origin/main')
  reader.invalidate(f.project)
  const saves = vi.spyOn(host, 'flush')
  const blocked = new Blocked()
  await new Promise(resolve => setTimeout(resolve, 50))
  blocked.reset()
  const before = gitSpawns.count, started = performance.now()
  await host.projectCheckoutMoved(f.project)
  const tookMs = performance.now() - started
  await new Promise(resolve => setTimeout(resolve, 20))
  blocked.stop()
  const result = { git: gitSpawns.count - before, saves: saves.mock.calls.length, behindAfter: behind(), blockedMs: Math.round(blocked.total), longestMs: Math.round(blocked.longest), tookMs: Math.round(tookMs) }
  saves.mockRestore()
  return result
}

it('reads a moved checkout once, however many threads work in it', async () => {
  const few = await moved(FEW), many = await moved(MANY)
  if (process.env.SOTTO_PERF_CHECKOUT_THREADS) console.log(`CHECKOUT-MOVED ${JSON.stringify({ [FEW]: few, [MANY]: { ...many, behindAfter: undefined } })}`)
  // Every thread's branch stops saying it is behind.
  expect(few.behindAfter).toEqual(Array.from({ length: FEW }, () => 0))
  expect(many.behindAfter).toEqual(Array.from({ length: MANY }, () => 0))
  expect(many.git, `Git processes for ${MANY} threads in one folder, against ${few.git} for ${FEW}`).toBeLessThanOrEqual(few.git)
  expect(many.saves, `Saves of the workspace for ${MANY} threads in one folder, against ${few.saves} for ${FEW}`).toBeLessThanOrEqual(few.saves)
}, 600_000)
