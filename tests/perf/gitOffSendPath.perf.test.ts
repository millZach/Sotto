// @vitest-environment node
/**
 * How long a send waits on Git before the provider hears the prompt (issue #766), and how many Git processes it
 * starts in that time. Drives the real workspace host over a real repository, a real worktree and real Git; the
 * provider is the fake one, so the figures are Sotto's own work and Git's, not a provider round trip. Three cases:
 * a thread on its own ready worktree, a thread in the shared project folder, and a worktree thread whose refresh
 * (the one a draft starts) has left its remote status read in a `git fetch` that takes two seconds (scripted, so no
 * network is used). Timers and counts only: nothing about the prompt is recorded. It asserts no time, so it runs
 * only under `SOTTO_PERF_BENCH=1` (`tests/fixtures/perfBench.ts`):
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/gitOffSendPath.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { afterAll, describe, it, vi } from 'vitest'
import { GitStatusReader, runGitStatusCommand, type RunGitCommand } from '../../src/main/agents/gitStatus'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { idle, repositoryWithOrigin, sendAndCount, startedThread, type SendGitFixture } from '../fixtures/sendGit'

vi.mock('node:child_process', async importOriginal => (await import('../fixtures/gitSpawnCounter')).countingGit(await importOriginal()))

const SENDS = 9
const SLOW_FETCH_MS = 2_000
/** Past the reader's own fifteen seconds of a fetch being fresh, so each refresh's read fetches again. */
const FETCH_STALE_MS = 60_000
const fixtures: SendGitFixture[] = []
afterAll(async () => { for (const f of fixtures.splice(0)) { await f.stop(); await f.remove() } })

async function repository(): Promise<SendGitFixture> {
  const f = await repositoryWithOrigin(); fixtures.push(f)
  return f
}

function report(label: string, samples: Array<{ ms: number; git: number }>) {
  const times = samples.map(sample => sample.ms), processes = samples.map(sample => sample.git)
  console.log(`${label}: send to provider median ${round(median(times))} ms (min ${round(Math.min(...times))}, max ${round(Math.max(...times))}); Git processes before the provider heard it median ${median(processes)} (min ${Math.min(...processes)}, max ${Math.max(...processes)})`)
}

describe.skipIf(!PERF_BENCH)('Git on a send\'s path', () => {
  it.each(['independent', 'shared'] as const)('a thread on a ready %s working copy', async workingCopy => {
    const f = await repository()
    await startedThread(f, 'bench', workingCopy)
    const samples: Array<{ ms: number; git: number }> = []
    for (let index = 1; index <= SENDS; index++) {
      await idle(f, 'bench')
      // A refresh waits in the status lane behind the inspection the last send owes, so each sample is one send alone.
      await f.host.updateThreadWorktree('bench', false)
      samples.push(await sendAndCount(f, 'bench', index))
    }
    report(`${workingCopy} working copy`, samples)
  }, 120_000)

  it('a worktree thread whose refresh left its remote status read in a two-second fetch', async () => {
    const f = await repository()
    await startedThread(f, 'bench', 'independent')
    let fetching: (() => void) | undefined
    let clock = 0
    const run: RunGitCommand = async (cwd, command, args, options) => {
      // Each status read begins with this lookup, and begins a minute after the last on the reader's clock.
      if (command === 'git' && args.includes('--git-common-dir')) clock += FETCH_STALE_MS
      if (command === 'git' && args[0] === 'fetch') {
        fetching?.()
        await new Promise(resolve => setTimeout(resolve, SLOW_FETCH_MS))
        return ''
      }
      // Nothing here asks GitHub; the branch's pull request lookup fails quietly, as it does signed out.
      if (command === 'gh') throw new Error('gh is not used in this benchmark.')
      return runGitStatusCommand(cwd, command, args, options)
    }
    f.host.setGitStatus(new GitStatusReader({ run, fetchIntervalMs: () => 30_000, now: () => Date.now() + clock }), { pollIntervalMs: () => 0 })
    const samples: Array<{ ms: number; git: number }> = []
    for (let index = 1; index <= 5; index++) {
      await idle(f, 'bench')
      const fetchStarted = new Promise<void>(resolve => { fetching = resolve })
      // The refresh a draft starts, which reads the remote and so fetches. It is not awaited before the send: on
      // origin/main a refresh answered only once its fetch had, and the send is pressed while the fetch runs.
      const refreshed = f.host.updateThreadWorktree('bench', false)
      await fetchStarted
      samples.push(await sendAndCount(f, 'bench', index))
      await refreshed
    }
    report('worktree behind a two-second fetch', samples)
  }, 120_000)
})
