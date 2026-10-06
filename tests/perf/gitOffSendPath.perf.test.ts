// @vitest-environment node
/**
 * How long a send waits on Git before the provider hears the prompt (issue #766), and how many Git processes it
 * starts in that time. Drives the real workspace host over a real repository, a real worktree and real Git; the
 * provider is the fake one, so the figures are Sotto's own work and Git's, not a provider round trip. Three cases:
 * a thread on its own ready worktree, a thread in the shared project folder, and a worktree thread whose
 * background Git status read is held in a `git fetch` that takes two seconds (scripted, so no network is used).
 * Timers and counts only: nothing about the prompt is recorded. It asserts no time, so it runs only under
 * `SOTTO_PERF_BENCH=1` (`tests/fixtures/perfBench.ts`):
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/gitOffSendPath.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { GitStatusReader, runGitStatusCommand, type RunGitCommand } from '../../src/main/agents/gitStatus'
import { runWorktreeGit as git } from '../../src/main/agents/threadWorktrees'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { workspaceFixture } from '../fixtures/workspaceFixture'

const counted = vi.hoisted(() => ({ git: 0 }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const spawn = ((command: string, ...rest: unknown[]) => {
    if (/(^|[\\/])git(\.exe)?$/iu.test(command)) counted.git += 1
    return (actual.spawn as (...args: unknown[]) => unknown)(command, ...rest)
  }) as typeof actual.spawn
  return { ...actual, spawn, default: { ...actual, spawn } }
})

const SENDS = 9
const SLOW_FETCH_MS = 2_000
const fixtures: Array<Awaited<ReturnType<typeof workspaceFixture>>> = []
afterAll(async () => { for (const f of fixtures.splice(0)) { await f.stop(); await f.remove() } })

async function repository() {
  const f = await workspaceFixture(); fixtures.push(f)
  const project = f.adapters.codex.state.projects[0]!.path
  const origin = join(f.root, 'origin.git'); await mkdir(origin)
  await git(origin, ['init', '--bare'])
  await git(project, ['init', '-b', 'main'])
  await writeFile(join(project, 'tracked.txt'), 'baseline')
  await git(project, ['add', '.'])
  await git(project, ['-c', 'user.name=Bench', '-c', 'user.email=bench@example.invalid', 'commit', '-m', 'Baseline'])
  await git(project, ['remote', 'add', 'origin', origin])
  await git(project, ['push', '-u', 'origin', 'main'])
  return f
}

/** One thread with its first send made, so its working copy is set up and every later send is the common case. */
async function thread(f: Awaited<ReturnType<typeof repository>>, workingCopy: 'shared' | 'independent') {
  const snapshot = await f.host.connect()
  const project = snapshot.projects.find(item => item.providerId === 'codex')!
  const model = snapshot.models.find(item => item.providerId === 'codex')!
  await f.host.execute({ type: 'create-thread', commandId: 'create-bench', threadId: 'bench', projectId: project.id, title: 'Bench', modelId: model.id, workingCopy })
  await send(f, 0)
}

async function idle(f: Awaited<ReturnType<typeof repository>>) {
  for (const session of f.adapters.codex.state.threads) session.status = 'idle'
  f.adapters.codex.emit()
  await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.find(item => item.id === 'bench')?.status).toBe('idle'))
}

/** Milliseconds from the send until the provider hears it, and the Git processes started in between. */
async function send(f: Awaited<ReturnType<typeof repository>>, index: number): Promise<{ ms: number; git: number }> {
  let heardAt = 0, gitAtHearing = 0
  const execute = f.adapters.codex.execute.bind(f.adapters.codex)
  const spy = vi.spyOn(f.adapters.codex, 'execute').mockImplementation(async command => {
    if (command.type === 'send') { heardAt = performance.now(); gitAtHearing = counted.git }
    return execute(command)
  })
  const before = counted.git
  const startedAt = performance.now()
  await f.host.execute({ type: 'send', commandId: `send-${index}`, threadId: 'bench', messageId: `message-${index}`, text: 'Benchmark prompt' })
  spy.mockRestore()
  return { ms: heardAt - startedAt, git: gitAtHearing - before }
}

function report(label: string, samples: Array<{ ms: number; git: number }>) {
  const times = samples.map(sample => sample.ms), processes = samples.map(sample => sample.git)
  console.log(`${label}: send to provider median ${round(median(times))} ms (min ${round(Math.min(...times))}, max ${round(Math.max(...times))}); Git processes before the provider heard it median ${median(processes)} (min ${Math.min(...processes)}, max ${Math.max(...processes)})`)
}

describe.skipIf(!PERF_BENCH)('Git on a send\'s path', () => {
  it.each(['independent', 'shared'] as const)('a thread on a ready %s working copy', async workingCopy => {
    const f = await repository()
    await thread(f, workingCopy)
    const samples: Array<{ ms: number; git: number }> = []
    for (let index = 1; index <= SENDS; index++) {
      await idle(f)
      // Let the inspection a send or a finished turn starts settle, so each sample is one send alone.
      await new Promise(resolve => setTimeout(resolve, 1_000))
      samples.push(await send(f, index))
    }
    report(`${workingCopy} working copy`, samples)
  }, 120_000)

  it('a worktree thread whose background status read is in a two-second fetch', async () => {
    const f = await repository()
    let fetching: (() => void) | undefined
    const run: RunGitCommand = async (cwd, command, args, options) => {
      if (command === 'git' && args[0] === 'fetch') {
        fetching?.()
        await new Promise(resolve => setTimeout(resolve, SLOW_FETCH_MS))
        return ''
      }
      // Nothing here asks GitHub; the branch's pull request lookup fails quietly, as it does signed out.
      if (command === 'gh') throw new Error('gh is not used in this benchmark.')
      return runGitStatusCommand(cwd, command, args, options)
    }
    f.host.setGitStatus(new GitStatusReader({ run, fetchIntervalMs: () => 30_000 }), { pollIntervalMs: () => 0 })
    await thread(f, 'independent')
    const samples: Array<{ ms: number; git: number }> = []
    for (let index = 1; index <= 5; index++) {
      await idle(f)
      await new Promise(resolve => setTimeout(resolve, 1_000))
      const fetchStarted = new Promise<void>(resolve => { fetching = resolve })
      // A Git action finishing elsewhere asks for a remote read, which fetches first.
      const read = f.host.gitActionFinished('bench')
      await fetchStarted
      samples.push(await send(f, index))
      await read
    }
    report('worktree behind a two-second fetch', samples)
  }, 120_000)
})
