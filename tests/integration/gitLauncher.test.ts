// @vitest-environment node
/**
 * The Git launcher (`src/main/agents/gitLauncher.ts`) over real child processes, launched in this thread and on the
 * built worker: both report a process the same way, and a launch on the worker makes none on this thread. Then the two
 * callers over the worker, real Git included: the status reader's `runGitStatusCommand` and the worktree's
 * `runWorktreeGitProcess` keep their folders, environments, deadlines, output caps, process-tree stops and errors.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { GitLauncher, useGitLauncher, type LaunchedProcess } from '../../src/main/agents/gitLauncher'
import { GitUnavailableError, runGitStatusCommand, runWithGhStandIn } from '../../src/main/agents/gitStatus'
import { runWorktreeGitProcess } from '../../src/main/agents/threadWorktrees'
import { builtGitLauncherWorker } from '../fixtures/gitLauncherWorker'
import { ownedGitRepository } from '../fixtures/gitRepository'
import { mainThreadLaunches, resetMainThreadLaunches } from '../fixtures/mainThreadLaunches'

vi.mock('node:child_process', async importOriginal => (await import('../fixtures/mainThreadLaunches')).timingLaunches(await importOriginal()))

let worker: Awaited<ReturnType<typeof builtGitLauncherWorker>>
const roots: string[] = []
const launchers: GitLauncher[] = []
beforeAll(async () => { worker = await builtGitLauncherWorker() }, 60_000)
afterEach(async () => {
  for (const launcher of launchers.splice(0)) await launcher.close()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-launch-')) throw new Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
afterAll(async () => { await useGitLauncher(null); await worker?.dispose() })

async function folder(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'sotto-launch-')); roots.push(root); return root }
function launcher(path: string | null): GitLauncher { const made = new GitLauncher(path); launchers.push(made); return made }

interface Ended { readonly stdout: string; readonly stderr: string; readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly errors: Error[]; readonly pid: number | undefined }
function ended(child: LaunchedProcess, encoding?: BufferEncoding): Promise<Ended> {
  return new Promise(done => {
    const out: Array<Buffer | string> = [], err: Array<Buffer | string> = [], errors: Error[] = []
    if (encoding) { child.stdout.setEncoding(encoding); child.stderr.setEncoding(encoding) }
    child.stdout.on('data', chunk => out.push(chunk)); child.stderr.on('data', chunk => err.push(chunk))
    child.on('error', error => errors.push(error))
    child.on('close', (code, signal) => {
      const text = (chunks: Array<Buffer | string>) => chunks.map(chunk => typeof chunk === 'string' ? chunk : chunk.toString('utf8')).join('')
      done({ stdout: text(out), stderr: text(err), code, signal, errors, pid: child.pid })
    })
  })
}
const node = (script: string): [string, string[]] => [process.execPath, ['-e', script]]

describe.each([
  ['in this thread', (): string | null => null],
  ['on the worker', (): string | null => worker.path],
] as const)('a process launched %s', (where, path) => {
  const offThread = where === 'on the worker'

  it('runs in its folder with its environment and input, and reports what it printed and how it exited', async () => {
    const cwd = await folder()
    resetMainThreadLaunches()
    const [command, args] = node('let input = ""; process.stdin.on("data", d => input += d).on("end", () => { process.stdout.write(JSON.stringify({ cwd: process.cwd(), said: process.env.SOTTO_LAUNCH_FIXTURE, input })); process.stderr.write("to stderr"); process.exit(3) })')
    const child = launcher(path()).launch(command, args, { cwd, env: { ...process.env, SOTTO_LAUNCH_FIXTURE: 'kept' }, stdin: 'given on stdin' })
    const result = await ended(child)
    expect(JSON.parse(result.stdout)).toEqual({ cwd: await import('node:fs/promises').then(fs => fs.realpath(cwd)), said: 'kept', input: 'given on stdin' })
    expect(result).toMatchObject({ stderr: 'to stderr', code: 3, signal: null, errors: [] })
    expect(result.pid).toBeGreaterThan(0)
    expect(mainThreadLaunches.count).toBe(offThread ? 0 : 1)
  })

  it('leaves standard input unattached without input, and decodes a character split across two writes', async () => {
    const [command, args] = node('const bytes = Buffer.from("é"); process.stdout.write(bytes.subarray(0, 1)); setTimeout(() => { process.stdout.write(bytes.subarray(1)) }, 50)')
    const result = await ended(launcher(path()).launch(command, args, { cwd: process.cwd(), env: process.env }), 'utf8')
    expect(result.stdout).toBe('é')
    expect(result.code).toBe(0)
  })

  it('reports a command that is not there as ENOENT, then closes', async () => {
    const result = await ended(launcher(path()).launch('sotto-no-such-command', [], { cwd: process.cwd(), env: process.env }))
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({ code: 'ENOENT' })
    expect(result.pid).toBeUndefined()
  })

  it('stops a process it is told to kill', async () => {
    const [command, args] = node('process.stdout.write("started"); setInterval(() => {}, 1000)')
    const child = launcher(path()).launch(command, args, { cwd: process.cwd(), env: process.env })
    const result = ended(child)
    await new Promise<void>(started => child.stdout.on('data', () => started()))
    child.kill()
    expect(await result).toMatchObject({ signal: 'SIGTERM' })
  })

  it('closes once its output is let go of, though a process it started still holds the pipes', async () => {
    const root = await folder(), pidFile = join(root, 'grandchild.pid'), grandchild = join(root, 'grandchild.cjs')
    await writeFile(grandchild, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
    const [command, args] = node(`require('node:child_process').spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'inherit' }); setTimeout(() => process.exit(0), 200)`)
    const child = launcher(path()).launch(command, args, { cwd: root, env: process.env })
    const result = ended(child)
    try {
      await expect.poll(() => readFile(pidFile, 'utf8').catch(() => '')).not.toBe('')
      child.stdout.destroy(); child.stderr.destroy()
      expect(await result).toMatchObject({ code: 0 })
    } finally {
      const pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
      if (pid) try { process.kill(pid) } catch { /* Already gone. */ }
    }
  })
})

describe('the launcher without its worker', () => {
  it('launches in this thread when there is no worker file', async () => {
    resetMainThreadLaunches()
    const [command, args] = node('process.stdout.write("here")')
    expect(await ended(launcher(join(await folder(), 'missing.cjs')).launch(command, args, { cwd: process.cwd(), env: process.env }))).toMatchObject({ stdout: 'here', code: 0 })
    expect(mainThreadLaunches.count).toBe(1)
  })

  it('starts a launch in this thread when the worker fails before starting it', async () => {
    const broken = join(await folder(), 'broken.cjs')
    await writeFile(broken, 'throw new Error("This worker does not start.")')
    resetMainThreadLaunches()
    const [command, args] = node('process.stdout.write("started anyway")')
    expect(await ended(launcher(broken).launch(command, args, { cwd: process.cwd(), env: process.env }))).toMatchObject({ stdout: 'started anyway', code: 0, errors: [] })
    expect(mainThreadLaunches.count).toBe(1)
  })

  it('says a running launch stopped reporting when the worker closes, and launches in this thread after', async () => {
    const made = launcher(worker.path)
    const [command, args] = node('process.stdout.write("started"); setTimeout(() => {}, 2000)')
    const child = made.launch(command, args, { cwd: process.cwd(), env: process.env })
    const result = ended(child)
    await new Promise<void>(started => child.stdout.on('data', () => started()))
    await made.close()
    const stopped = await result
    expect(stopped.errors[0]?.message).toContain('stopped reporting')
    expect(stopped.code).toBeNull()
    resetMainThreadLaunches()
    expect(await ended(made.launch(...node('process.stdout.write("after")'), { cwd: process.cwd(), env: process.env }))).toMatchObject({ stdout: 'after' })
    expect(mainThreadLaunches.count).toBe(1)
  })
})

describe('Git through the worker', () => {
  beforeAll(async () => { await useGitLauncher(worker.path) })
  afterAll(async () => { await useGitLauncher(null) })

  it('reads a real repository, and rejects with what Git said when it fails', async () => {
    const repository = await ownedGitRepository()
    try {
      resetMainThreadLaunches()
      expect((await runGitStatusCommand(repository.repo, 'git', ['branch', '--show-current'])).trim()).toBe('main')
      await expect(runGitStatusCommand(repository.repo, 'git', ['rev-parse', '--verify', 'refs/heads/no-such-branch'])).rejects.toMatchObject({ code: 128, message: expect.stringContaining('fatal') })
      expect((await runWorktreeGitProcess(repository.repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('main')
      expect(mainThreadLaunches.count).toBe(0)
    } finally { await repository.dispose() }
  })

  it('keeps the status environment, streams lines, takes input, and says when a command is not there', async () => {
    const script = join(await folder(), 'gh.cjs')
    await writeFile(script, 'let input = ""; process.stdin.on("data", d => input += d).on("end", () => { console.log(JSON.stringify({ prompt: process.env.GH_PROMPT_DISABLED, locale: process.env.LC_ALL, dir: process.env.GIT_DIR ?? null, input })); console.error("second line") })')
    const lines: string[] = []
    const previous = process.env.GIT_DIR
    process.env.GIT_DIR = '/elsewhere'
    try {
      const said = await runWithGhStandIn({ executable: process.execPath, args: [script] })(process.cwd(), 'gh', [], { stdin: 'piped', onLine: line => lines.push(line) })
      expect(JSON.parse(said)).toEqual({ prompt: '1', locale: 'C', dir: null, input: 'piped' })
      expect(lines).toEqual([said.trim(), 'second line'])
    } finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous }
    await expect(runWithGhStandIn({ executable: 'sotto-no-such-gh', args: [] })(process.cwd(), 'gh', [])).rejects.toBeInstanceOf(GitUnavailableError)
  })

  it('gives up on a status command at its deadline', async () => {
    const [command, args] = node('setInterval(() => {}, 1000)')
    await expect(runWithGhStandIn({ executable: command, args })(process.cwd(), 'gh', [], { timeoutMs: 200 })).rejects.toMatchObject({ code: 'ETIMEDOUT' })
  })

  it('runs worktree Git without optional locks, caps its output, and says when Git is not there', async () => {
    expect(await runWorktreeGitProcess('.', ['status'], { executable: process.execPath, prefix: ['-e', 'process.stdout.write(process.env.GIT_OPTIONAL_LOCKS ?? "unset")', '--'] })).toBe('0')
    await expect(runWorktreeGitProcess('.', ['status'], { executable: process.execPath, prefix: ['-e', 'process.stdout.write("x".repeat(2_100_000)); setInterval(() => {}, 1000)', '--'] }))
      .rejects.toMatchObject({ message: 'Git returned too much output. Nothing was removed.' })
    await expect(runWorktreeGitProcess('.', [], { executable: 'sotto-no-such-git-executable' })).rejects.toMatchObject({ timedOut: false, message: expect.stringContaining('Git is unavailable') })
  })

  it('stops a timed-out Git and the process it started before answering', async () => {
    const root = await folder(), pidFile = join(root, 'child.pid'), child = join(root, 'child.cjs'), launcherScript = join(root, 'git.cjs')
    await writeFile(child, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
    await writeFile(launcherScript, `require('node:child_process').spawn(process.execPath, [${JSON.stringify(child)}], { stdio: 'ignore', detached: process.platform === 'win32' }); setInterval(() => {}, 1000)`)
    const outcome = runWorktreeGitProcess(root, ['status'], { executable: process.execPath, prefix: [launcherScript], timeout: 1_500 }).catch(error => error as Error)
    let pid = 0
    try {
      await expect.poll(() => readFile(pidFile, 'utf8').catch(() => ''), { timeout: 10_000 }).not.toBe('')
      pid = Number(await readFile(pidFile, 'utf8'))
      expect(await outcome).toMatchObject({ timedOut: true, message: 'Git took too long.' })
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      if (pid) try {
        process.kill(pid, 0)
        if (process.platform === 'win32') await new Promise<void>(done => spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('close', () => done()))
        else process.kill(pid, 'SIGKILL')
      } catch { /* Already gone. */ }
    }
  })
})
