import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { Worker } from 'node:worker_threads'
import type { LaunchError, LauncherEvent, LauncherRequest } from './gitLauncherWorker'

/**
 * Starts the Git and gh processes Sotto runs for itself (status reads, worktree Git, Git actions) on a worker thread
 * rather than on the thread that asks. On Windows a launch is CreateProcess, synchronous on the calling thread, and
 * in Electron main that thread is the browser UI thread: about 200 launches in 40 s of threads running held main for
 * 3.1 s, one of them for 2.2 s (`docs/perf/2026-10-19-git-launch-off-main.md`). macOS and Linux launch off main too,
 * and nothing else about a process changes on any of them.
 *
 * What a launch hands back is the part of a `ChildProcess` the callers use: its pid once it has one, its two output
 * streams, `error` and `close`, and `kill`. Where the worker cannot be had (no built worker file beside this one, as
 * under the test runner, or a worker that failed to start), a launch is the in-thread `spawn` it always was.
 */
export interface LaunchOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  /** Written to standard input, which is then closed; absent, standard input is not attached. */
  readonly stdin?: string
  /** Its own process group, as `spawn`'s `detached`, so the whole group can be stopped together. */
  readonly detached?: boolean
}
export interface LaunchedOutput {
  setEncoding(encoding: BufferEncoding): this
  on(event: 'data', listener: (chunk: Buffer | string) => void): this
  destroy(): void
}
export interface LaunchedProcess {
  /** The process's id once it has started; undefined before, or when it never did. */
  readonly pid?: number | undefined
  readonly stdout: LaunchedOutput
  readonly stderr: LaunchedOutput
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  kill(signal?: NodeJS.Signals): boolean
}

/** The worker file the build puts beside this module's bundle (`electron.vite.config.ts`, `scripts/build-host.mjs`). */
const BUILT_WORKER = join(__dirname, 'gitLauncherWorker.js')

/** Both output streams are piped, so neither is null. */
function inThread(command: string, args: readonly string[], options: LaunchOptions): ChildProcess & LaunchedProcess {
  const child = spawn(command, [...args], {
    cwd: options.cwd, env: options.env, windowsHide: true, shell: false, detached: options.detached ?? false,
    stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })
  if (options.stdin !== undefined && child.stdin) { child.stdin.on('error', () => undefined); child.stdin.end(options.stdin) }
  return child as ChildProcess & LaunchedProcess
}

function errorFrom(error: LaunchError): Error {
  const { message, ...fields } = error
  return Object.assign(new Error(message), fields)
}

/** One of a launched process's output streams, fed by the worker's messages in the order they were printed. */
class Output extends EventEmitter implements LaunchedOutput {
  private decoder: StringDecoder | undefined
  private destroyed = false
  constructor(private readonly onDestroy: () => void) { super() }
  setEncoding(encoding: BufferEncoding): this { this.decoder = new StringDecoder(encoding); return this }
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.onDestroy()
  }
  push(chunk: Uint8Array): void {
    if (this.destroyed) return
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    this.emit('data', this.decoder ? this.decoder.write(bytes) : bytes)
  }
  end(): void {
    if (this.destroyed || !this.decoder) return
    const rest = this.decoder.end()
    if (rest) this.emit('data', rest)
  }
}

/** A process launched on the worker thread, or, when the worker went before it started it, in this thread instead. */
class OffThreadProcess extends EventEmitter implements LaunchedProcess {
  pid: number | undefined
  readonly stdout: Output
  readonly stderr: Output
  /** Whether the worker said it started, after which it is the worker's to finish. */
  started = false
  /** Set once it has closed, or been handed to an in-thread child. */
  private settled = false
  private adopted: ChildProcess | undefined
  constructor(readonly id: number, private readonly send: (request: LauncherRequest) => void) {
    super()
    this.stdout = new Output(() => this.adopted ? this.adopted.stdout?.destroy() : this.send({ type: 'destroy', id, stream: 'stdout' }))
    this.stderr = new Output(() => this.adopted ? this.adopted.stderr?.destroy() : this.send({ type: 'destroy', id, stream: 'stderr' }))
  }
  kill(signal?: NodeJS.Signals): boolean {
    if (this.adopted) return this.adopted.kill(signal)
    if (this.settled) return false
    this.send({ type: 'kill', id: this.id, ...(signal ? { signal } : {}) })
    return true
  }
  receive(event: LauncherEvent): void {
    if (this.settled) return
    switch (event.type) {
      case 'spawned': this.started = true; this.pid = event.pid; return
      case 'stdout': this.stdout.push(event.chunk); return
      case 'stderr': this.stderr.push(event.chunk); return
      case 'error': this.emit('error', errorFrom(event.error)); return
      case 'close': this.close(event.code, event.signal)
    }
  }
  close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.settled) return
    this.settled = true
    this.stdout.end(); this.stderr.end()
    this.emit('close', code, signal)
  }
  /** The worker went before it started this one: it is started here instead, and reports as that child does. */
  adopt(child: ChildProcess): void {
    this.settled = true
    this.adopted = child
    this.pid = child.pid
    child.stdout?.on('data', (chunk: Buffer) => this.stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.stderr.push(chunk))
    child.on('error', error => this.emit('error', error))
    child.on('close', (code, signal) => { this.stdout.end(); this.stderr.end(); this.emit('close', code, signal) })
  }
}

/**
 * The worker and the launches it is running. It is started on the first launch, holds the process open only while a
 * launch runs, as a child process itself would, and is given up for in-thread launches if it fails: a launch it had
 * not started yet starts in this thread, and one it had started reports that it stopped.
 */
export class GitLauncher {
  private worker: Worker | null | undefined
  private readonly running = new Map<number, { readonly process: OffThreadProcess; readonly command: string; readonly args: readonly string[]; readonly options: LaunchOptions }>()
  private next = 1
  /** `workerPath` null launches in this thread, always. */
  constructor(private readonly workerPath: string | null) {}

  launch(command: string, args: readonly string[], options: LaunchOptions): LaunchedProcess {
    const worker = this.ensureWorker()
    if (!worker) return inThread(command, args, options)
    const id = this.next++
    const launched = new OffThreadProcess(id, request => { try { worker.postMessage(request) } catch { /* The worker has gone; its exit settles this launch. */ } })
    if (!this.running.size) worker.ref()
    this.running.set(id, { process: launched, command, args, options })
    launched.on('close', () => {
      if (this.running.get(id)?.process !== launched) return
      this.running.delete(id)
      if (!this.running.size && this.worker === worker) worker.unref()
    })
    worker.postMessage({ type: 'launch', id, command, args: [...args], cwd: options.cwd, env: { ...options.env }, stdin: options.stdin ?? null, detached: options.detached ?? false } satisfies LauncherRequest)
    return launched
  }

  /** Stops the worker; a launch still running reports that it stopped. For tests and shutdown. */
  async close(): Promise<void> {
    const worker = this.worker
    this.worker = null
    if (worker) { this.abandon(false); await worker.terminate() }
  }

  /** `runToExit` on this launcher. */
  run(command: string, args: readonly string[]): Promise<void> {
    return new Promise((done, fail) => {
      if (!this.ensureWorker()) { execFile(command, [...args], { windowsHide: true }, error => error ? fail(error) : done()); return }
      let failure: Error | undefined
      const child = this.launch(command, args, { cwd: process.cwd(), env: process.env })
      child.stdout.on('data', () => undefined); child.stderr.on('data', () => undefined)
      child.on('error', error => { failure ??= error })
      child.on('close', code => failure ? fail(failure) : code === 0 ? done() : fail(Object.assign(new Error(`${command} exited with ${code ?? 'a signal'}.`), { code })))
    })
  }

  private ensureWorker(): Worker | null {
    if (this.worker !== undefined) return this.worker
    if (this.workerPath === null || !existsSync(this.workerPath)) return this.worker = null
    let worker: Worker
    try { worker = new Worker(this.workerPath, { stdout: false, stderr: false }) } catch { return this.worker = null }
    worker.unref()
    worker.on('message', (event: LauncherEvent) => this.running.get(event.id)?.process.receive(event))
    const failed = (): void => {
      if (this.worker !== worker) return
      this.worker = null
      this.abandon(true)
    }
    worker.on('error', failed)
    worker.on('exit', failed)
    return this.worker = worker
  }

  /** The worker is gone: a launch it never started starts here when `relaunch` allows; any other reports that it stopped. */
  private abandon(relaunch: boolean): void {
    const running = [...this.running.values()]
    this.running.clear()
    for (const { process, command, args, options } of running) {
      if (relaunch && !process.started) {
        try { process.adopt(inThread(command, args, options)); continue } catch (error) {
          process.emit('error', error instanceof Error ? error : new Error(String(error)))
        }
      } else process.emit('error', new Error(`${command} stopped reporting: Sotto's process launcher closed. Nothing it changed was undone.`))
      process.close(null, null)
    }
  }
}

let shared: GitLauncher | undefined
/** The launcher every Git and gh launch of Sotto's own goes through. */
export function gitLauncher(): GitLauncher { return shared ??= new GitLauncher(BUILT_WORKER) }
/** Points the shared launcher at a worker file, or at none (null), for tests; the previous one is closed. */
export async function useGitLauncher(workerPath: string | null): Promise<GitLauncher> {
  const previous = shared
  shared = new GitLauncher(workerPath)
  await previous?.close()
  return shared
}
/** Starts a process through the shared launcher. */
export function launchProcess(command: string, args: readonly string[], options: LaunchOptions): LaunchedProcess {
  return gitLauncher().launch(command, args, options)
}
/**
 * Runs a process to its end in Sotto's own folder and environment, its output unread: resolves when it exits with 0,
 * rejects when it could not start or exited otherwise. Without the worker it is the `execFile` it always was.
 */
export function runToExit(command: string, args: readonly string[]): Promise<void> {
  return gitLauncher().run(command, args)
}
