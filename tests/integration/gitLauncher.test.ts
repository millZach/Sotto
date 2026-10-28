// @vitest-environment node
/**
 * The Git launcher (`src/main/agents/gitLauncher.ts`) over real child processes, launched in this thread and on the
 * built worker: both report a process the same way, and a launch on the worker makes none on this thread. Then the two
 * callers over the worker, real Git included: the status reader's `runGitStatusCommand` and the worktree's
 * `runWorktreeGitProcess` keep their folders, environments, deadlines, output caps, process-tree stops and errors.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
/** Prints each line it is given back as `echo:<line>`, and exits with 4 once its input ends. */
const echo = node('let rest = ""; process.stdin.setEncoding("utf8").on("data", text => { const lines = (rest + text).split("\\n"); rest = lines.pop(); for (const line of lines) process.stdout.write("echo:" + line + "\\n") }).on("end", () => process.exit(4))')

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

  it('keeps an interactive launch\'s input open, writes it in order, answers a flushed write and reports its exit', async () => {
    resetMainThreadLaunches()
    const child = launcher(path()).launchInteractive(...echo, { cwd: process.cwd(), env: process.env })
    const exits: Array<number | null> = []
    child.once('exit', code => { exits.push(code) })
    const result = ended(child, 'utf8')
    child.stdin.write('one\n')
    await new Promise<void>((done, fail) => { child.stdin.write('two\n', error => error ? fail(error) : done()) })
    child.stdin.end()
    expect(await result).toMatchObject({ stdout: 'echo:one\necho:two\n', code: 4, errors: [] })
    expect(exits).toEqual([4])
    expect(mainThreadLaunches.count).toBe(offThread ? 0 : 1)
    // Input written once the process has gone fails, as a child's own input does.
    child.stdin.on('error', () => undefined)
    expect(await new Promise<Error | null | undefined>(done => { child.stdin.write('late\n', done) })).toBeInstanceOf(Error)
  })
})

describe('the launcher without its worker', () => {
  it('launches in this thread when there is no worker file', async () => {
    resetMainThreadLaunches()
    const [command, args] = node('process.stdout.write("here")')
    expect(await ended(launcher(join(await folder(), 'missing.cjs')).launch(command, args, { cwd: process.cwd(), env: process.env }))).toMatchObject({ stdout: 'here', code: 0 })
    expect(mainThreadLaunches.count).toBe(1)
  })

  it('refuses a launch with no folder instead of running it in Sotto\'s own folder', async () => {
    // Node runs a process given an empty folder in the parent's own folder: Git there would change a repository nobody chose.
    resetMainThreadLaunches()
    const refusal = 'Sotto did not start git because it was not given a folder to run in. Nothing was changed. Try again from a thread that has a project folder.'
    expect(() => launcher(null).launch('git', ['status'], { cwd: '', env: process.env })).toThrow(refusal)
    expect(() => launcher(worker.path).launch('git', ['status'], { cwd: '', env: process.env })).toThrow(refusal)
    expect(mainThreadLaunches.count).toBe(0)
    await expect(runGitStatusCommand('', 'git', ['rev-parse', '--show-toplevel'])).rejects.toThrow(refusal)
    await expect(runWorktreeGitProcess('', ['rev-parse', '--show-toplevel'])).rejects.toThrow(refusal)
  })

  it('starts a launch in this thread when the worker fails before starting it', async () => {
    const broken = join(await folder(), 'broken.cjs')
    await writeFile(broken, 'throw new Error("This worker does not start.")')
    resetMainThreadLaunches()
    const [command, args] = node('process.stdout.write("started anyway")')
    expect(await ended(launcher(broken).launch(command, args, { cwd: process.cwd(), env: process.env }))).toMatchObject({ stdout: 'started anyway', code: 0, errors: [] })
    expect(mainThreadLaunches.count).toBe(1)
  })

  it('passes a kill and closed output asked for before the worker failed on to the launch it starts here', async () => {
    const broken = join(await folder(), 'broken.cjs')
    await writeFile(broken, 'throw new Error("This worker does not start.")')
    const [command, args] = node('setTimeout(() => process.stdout.write("ran to the end"), 1000)')
    const child = launcher(broken).launch(command, args, { cwd: process.cwd(), env: process.env })
    const result = ended(child)
    child.kill()
    expect(await result).toMatchObject({ stdout: '', signal: 'SIGTERM' })
  })

  it('gives an interactive launch it starts here what was written to it before the worker failed', async () => {
    const broken = join(await folder(), 'broken.cjs')
    await writeFile(broken, 'throw new Error("This worker does not start.")')
    const child = launcher(broken).launchInteractive(...echo, { cwd: process.cwd(), env: process.env })
    const result = ended(child, 'utf8')
    const flushed = new Promise<Error | null | undefined>(done => { child.stdin.write('before\n', done) })
    child.stdin.end()
    expect(await result).toMatchObject({ stdout: 'echo:before\n', code: 4, errors: [] })
    expect(await flushed).toBeFalsy()
  })

  it('says a running launch stopped reporting when the worker closes, and launches in this thread after', async () => {
    const made = launcher(worker.path)
    const [command, args] = node('process.stdout.write("started"); setTimeout(() => {}, 2000)')
    const child = made.launch(command, args, { cwd: process.cwd(), env: process.env })
    const result = ended(child)
    await new Promise<void>(started => child.stdout.on('data', () => started()))
    await made.close()
    const stopped = await result
    expect(stopped.errors[0]?.message).toContain('because its process launcher closed')
    expect(stopped.code).toBeNull()
    resetMainThreadLaunches()
    expect(await ended(made.launch(...node('process.stdout.write("after")'), { cwd: process.cwd(), env: process.env }))).toMatchObject({ stdout: 'after' })
    expect(mainThreadLaunches.count).toBe(1)
  })
})

describe('a launch the worker started, when the worker goes', () => {
  // A process stopped after the worker that started it died stays defunct on Linux until Sotto exits, since no loop is
  // left to collect it. It runs nothing and holds no lock, so it counts as stopped.
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0) } catch { return false }
    try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return true }
  }
  async function sleeper(made: GitLauncher): Promise<{ child: LaunchedProcess; result: Promise<Ended>; pid: number }> {
    const child = made.launch(...node('process.stdout.write(String(process.pid)); setTimeout(() => {}, 30_000)'), { cwd: process.cwd(), env: process.env })
    const result = ended(child)
    const pid = await new Promise<number>(started => child.stdout.on('data', chunk => started(Number(String(chunk)))))
    expect(alive(pid)).toBe(true)
    return { child, result, pid }
  }

  it('is stopped before it reports closing when the launcher closes', async () => {
    const made = launcher(worker.path)
    const { result, pid } = await sleeper(made)
    await made.close()
    expect((await result).errors[0]?.message).toContain('Sotto stopped')
    await vi.waitFor(() => expect(alive(pid)).toBe(false))
  })

  it('is never started a second time when the worker fails right after starting it', async () => {
    // A worker that starts the launch, waits until it has written its mark, says it started, and fails at once: Node can
    // deliver the failure before that message.
    const root = await folder(), failing = join(root, 'failing.cjs'), marks = join(root, 'starts.txt')
    await writeFile(failing, [
      "const { parentPort } = require('node:worker_threads')",
      "const { spawn } = require('node:child_process')",
      "parentPort.on('message', request => {",
      "  if (request.type !== 'launch') return",
      "  const child = spawn(request.command, request.args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })",
      "  child.stdout.once('data', () => {",
      "    parentPort.postMessage({ type: 'spawned', id: request.id, pid: child.pid })",
      "    throw new Error('Synthetic worker failure after starting a launch')",
      '  })',
      '})',
    ].join('\n'))
    const made = launcher(failing)
    const child = made.launch(...node(`require('node:fs').appendFileSync(${JSON.stringify(marks)}, 'x'); process.stdout.write('ready'); setTimeout(() => {}, 30_000)`), { cwd: process.cwd(), env: process.env })
    const result = ended(child)
    expect((await result).errors.some(error => error.message.includes('Sotto stopped'))).toBe(true)
    // Long enough for a second start, had there been one, to have written its mark.
    await new Promise(resolve => setTimeout(resolve, 1_500))
    expect(await readFile(marks, 'utf8').catch(() => '')).toBe('x')
    await vi.waitFor(() => expect(alive(child.pid!)).toBe(false))
  })

  it('is stopped from this thread before it reports closing when the worker dies', async () => {
    const made = launcher(worker.path)
    const { result, pid } = await sleeper(made)
    // The worker ends on its own, as a crash would, rather than through close().
    await (made as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate()
    expect((await result).errors[0]?.message).toContain('Sotto stopped')
    await vi.waitFor(() => expect(alive(pid)).toBe(false))
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

  it('carries the test harness\'s Git guard, so a test cannot change a repository outside the temporary folder through it', async () => {
    resetMainThreadLaunches()
    // A dry run: a guard that failed to travel would still change nothing.
    await expect(runGitStatusCommand(process.cwd(), 'git', ['commit', '--dry-run', '--allow-empty', '-m', 'Refused'])).rejects.toThrow(/^The test harness refused `git commit` on .*: a test may change only repositories under the temporary folder/u)
    await expect(runWorktreeGitProcess(process.cwd(), ['add', '--dry-run', '.'])).rejects.toThrow(/^The test harness refused `git add`/u)
    expect(mainThreadLaunches.count).toBe(0)
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

  it('stops a Git whose deadline came before the worker had started it', async () => {
    // A worker that takes its time to start: the launch waits for it, and the deadline passes first.
    const slow = join(await folder(), 'slow.cjs')
    await writeFile(slow, `setTimeout(() => require(${JSON.stringify(worker.path)}), 1_000)`)
    await useGitLauncher(slow)
    try {
      const outcome = runWorktreeGitProcess('.', ['status'], { executable: process.execPath, prefix: ['-e', 'setInterval(() => {}, 1000)', '--'], timeout: 50 })
      await expect(outcome).rejects.toMatchObject({ timedOut: true, message: 'Git took too long.' })
    } finally { await useGitLauncher(worker.path) }
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
