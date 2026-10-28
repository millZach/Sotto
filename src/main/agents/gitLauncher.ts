import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { Worker } from 'node:worker_threads'
import type { Writable } from 'node:stream'
import type { LaunchError, LauncherEvent, LauncherRequest } from './gitLauncherWorker'

/**
 * Starts the Git and gh processes Sotto runs for itself (status reads, worktree Git, Git actions), and the Grok process
 * Usage starts to read Grok's limits, on a worker thread rather than on the thread that asks. On Windows a launch is CreateProcess, synchronous on the calling thread, and
 * in Electron main that thread is the browser UI thread: about 200 launches in 40 s of threads running held main for
 * 3.1 s, one of them for 2.2 s (`docs/perf/2026-10-19-git-launch-off-main.md`). macOS and Linux launch off main too,
 * and nothing else about a process changes on any of them.
 *
 * What a launch hands back is the part of a `ChildProcess` the callers use: its pid once it has one, its two output
 * streams, `error` and `close`, and `kill`; an interactive launch adds its standard input, kept open, and `exit`. Where
 * the worker cannot be had (no built worker file beside this one, as
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
  /** Once it has started and has a pid; never for one that could not start. */
  once(event: 'spawn', listener: () => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  kill(signal?: NodeJS.Signals): boolean
}
/** An interactive launch's standard input: written in the order asked, then ended, as a child's own `stdin` is. */
export interface LaunchedInput {
  readonly destroyed: boolean
  /** `callback` is called once the text is flushed to the process, or with the error that stopped it. */
  write(data: string, callback?: (error?: Error | null) => void): boolean
  end(): void
  on(event: 'error', listener: (error: Error) => void): this
}
/** A process whose standard input stays open (`launchInteractive`), which also reports when it exits. */
export interface InteractiveProcess extends LaunchedProcess {
  readonly stdin: LaunchedInput
  once(event: 'spawn', listener: () => void): this
  /** `exit` is the process ending; `close` follows once its output has closed too. */
  once(event: 'exit' | 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
}

/** The worker file the build puts beside this module's bundle (`electron.vite.config.ts`, `scripts/build-host.mjs`). */
const BUILT_WORKER = join(__dirname, 'gitLauncherWorker.js')

/**
 * Stops a process the worker started, and what it started, from this thread: the worker's own loop is gone or going,
 * so it can no longer. Windows stops the tree as the callers' own stop does; elsewhere a detached launch leads its group.
 */
function stopFromHere(pid: number, detached: boolean): Promise<void> {
  if (process.platform === 'win32') return new Promise(done => { execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => done()) })
  try { process.kill(detached ? -pid : pid, 'SIGKILL') } catch { /* It has already gone. */ }
  return Promise.resolve()
}

/** Both output streams are piped, so neither is null; an interactive launch's input is piped and left open. */
function inThread(command: string, args: readonly string[], options: LaunchOptions, interactive = false): ChildProcess & InteractiveProcess {
  const child = spawn(command, [...args], {
    cwd: options.cwd, env: options.env, windowsHide: true, shell: false, detached: options.detached ?? false,
    stdio: [options.stdin === undefined && !interactive ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })
  if (!interactive && options.stdin !== undefined && child.stdin) { child.stdin.on('error', () => undefined); child.stdin.end(options.stdin) }
  return child as ChildProcess & InteractiveProcess
}

function errorFrom(error: LaunchError): Error {
  const { message, ...fields } = error
  return Object.assign(new Error(message), fields)
}

/** One of a launched process's output streams, fed by the worker's messages in the order they were printed. */
class Output extends EventEmitter implements LaunchedOutput {
  private decoder: StringDecoder | undefined
  destroyed = false
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

/**
 * An interactive launch's standard input, written through the worker. What is written before the worker says it started
 * the process is kept, so a process started in this thread instead (`adopt`) is given all of it, in order. It applies no
 * backpressure: `write` always answers true and never waits on `drain`, so it suits a few small requests (Grok's limits
 * probe) and not a stream; a caller that writes much would want a bounded queue paced by the flush answers first.
 */
class Input extends EventEmitter implements LaunchedInput {
  private gone = false
  private ended = false
  private serial = 0
  private readonly answers = new Map<number, (error?: Error | null) => void>()
  private unstarted: Array<{ readonly data: string; readonly callback?: ((error?: Error | null) => void) | undefined } | 'end'> | undefined = []
  private adopted: Writable | undefined
  constructor(private readonly id: number, private readonly send: (request: LauncherRequest) => void) { super() }
  get destroyed(): boolean { return this.adopted ? this.adopted.destroyed : this.gone }
  write(data: string, callback?: (error?: Error | null) => void): boolean {
    if (this.adopted) return this.adopted.write(data, callback)
    if (this.gone || this.ended) {
      const error = new Error('The process is no longer taking input.')
      queueMicrotask(() => { callback?.(error); this.fail(error) })
      return false
    }
    this.unstarted?.push({ data, callback })
    const serial = callback ? ++this.serial : undefined
    if (callback && serial !== undefined) this.answers.set(serial, callback)
    this.send({ type: 'write', id: this.id, data, ...(serial !== undefined ? { serial } : {}) })
    return true
  }
  end(): void {
    if (this.adopted) { this.adopted.end(); return }
    if (this.gone || this.ended) return
    this.ended = true
    this.unstarted?.push('end')
    this.send({ type: 'end', id: this.id })
  }
  /** The worker started the process, so what was written is the worker's to deliver. */
  started(): void { this.unstarted = undefined }
  written(serial: number, error: LaunchError | undefined): void {
    const answer = this.answers.get(serial)
    this.answers.delete(serial)
    answer?.(error ? errorFrom(error) : null)
  }
  fail(error: Error): void {
    this.gone = true
    if (this.listenerCount('error')) this.emit('error', error)
  }
  /** The process closed: a write still unanswered never reached it. */
  closed(): void {
    this.gone = true
    for (const answer of this.answers.values()) answer(new Error('The process closed before it took this input.'))
    this.answers.clear()
  }
  /** The worker went before it started the process, which started here instead: it is given what was written. */
  adopt(stdin: Writable): void {
    this.adopted = stdin
    stdin.on('error', error => this.fail(error))
    for (const item of this.unstarted ?? []) if (item === 'end') stdin.end(); else stdin.write(item.data, item.callback)
    this.unstarted = undefined
    this.answers.clear()
  }
}

/** A process launched on the worker thread, or, when the worker went before it started it, in this thread instead. */
class OffThreadProcess extends EventEmitter implements LaunchedProcess {
  pid: number | undefined
  readonly stdout: Output
  readonly stderr: Output
  /** Only an interactive launch has one. */
  readonly stdin: Input | undefined
  /** Whether the worker said it started, after which it is the worker's to finish. */
  started = false
  /** Set once it has closed, or been handed to an in-thread child. */
  private settled = false
  private adopted: ChildProcess | undefined
  /** A kill asked for before it was handed to an in-thread child, which that child then gets. */
  private killedWith: NodeJS.Signals | 'default' | undefined
  constructor(readonly id: number, private readonly send: (request: LauncherRequest) => void, interactive = false) {
    super()
    this.stdout = new Output(() => this.adopted ? this.adopted.stdout?.destroy() : this.send({ type: 'destroy', id, stream: 'stdout' }))
    this.stderr = new Output(() => this.adopted ? this.adopted.stderr?.destroy() : this.send({ type: 'destroy', id, stream: 'stderr' }))
    this.stdin = interactive ? new Input(id, send) : undefined
  }
  kill(signal?: NodeJS.Signals): boolean {
    if (this.adopted) return this.adopted.kill(signal)
    if (this.settled) return false
    this.killedWith ??= signal ?? 'default'
    this.send({ type: 'kill', id: this.id, ...(signal ? { signal } : {}) })
    return true
  }
  receive(event: LauncherEvent): void {
    if (this.settled) return
    switch (event.type) {
      case 'spawned': this.started = true; this.stdin?.started(); this.pid = event.pid; if (event.pid !== undefined) this.emit('spawn'); return
      case 'stdout': this.stdout.push(event.chunk); return
      case 'stderr': this.stderr.push(event.chunk); return
      case 'error': this.emit('error', errorFrom(event.error)); return
      case 'exit': this.emit('exit', event.code, event.signal); return
      case 'written': this.stdin?.written(event.serial, event.error); return
      case 'stdin-error': this.stdin?.fail(errorFrom(event.error)); return
      case 'close': this.close(event.code, event.signal)
    }
  }
  close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.settled) return
    this.settled = true
    this.stdout.end(); this.stderr.end(); this.stdin?.closed()
    this.emit('close', code, signal)
  }
  /**
   * The worker went before it started this one: it is started here instead, and reports as that child does. A kill or
   * a closed output asked for before is passed on to it.
   */
  adopt(child: ChildProcess): void {
    this.settled = true
    this.adopted = child
    this.pid = child.pid
    child.stdout?.on('data', (chunk: Buffer) => this.stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.stderr.push(chunk))
    if (this.stdin && child.stdin) this.stdin.adopt(child.stdin)
    child.on('error', error => this.emit('error', error))
    child.on('exit', (code, signal) => this.emit('exit', code, signal))
    child.on('close', (code, signal) => { this.stdout.end(); this.stderr.end(); this.stdin?.closed(); this.emit('close', code, signal) })
    if (this.stdout.destroyed) child.stdout?.destroy()
    if (this.stderr.destroyed) child.stderr?.destroy()
    if (this.killedWith !== undefined) child.kill(this.killedWith === 'default' ? undefined : this.killedWith)
    if (child.pid !== undefined) queueMicrotask(() => this.emit('spawn'))
  }
}

/**
 * The worker and the launches it is running. It is started on the first launch, holds the process open only while a
 * launch runs, as a child process itself would, and is given up for in-thread launches if it fails: a launch it had
 * not started yet starts in this thread, and one it had started reports that it stopped.
 */
export class GitLauncher {
  private worker: Worker | null | undefined
  private readonly running = new Map<number, { readonly process: OffThreadProcess; readonly command: string; readonly args: readonly string[]; readonly options: LaunchOptions; readonly interactive: boolean }>()
  private next = 1
  /** The worker `close` is stopping, which settles its own launches, so its exit settles nothing more. */
  private closing: Worker | undefined
  /** While closing: what to call when the worker reports a launch exited, so it is collected before the worker goes. */
  private readonly exited = new Map<number, () => void>()
  /** `workerPath` null launches in this thread, always. */
  constructor(private readonly workerPath: string | null) {}

  launch(command: string, args: readonly string[], options: LaunchOptions): LaunchedProcess {
    return this.start(command, args, options, false)
  }

  /**
   * Starts a process whose standard input stays open for the caller to write to and end, as a `spawn` with every stream
   * piped does.
   */
  launchInteractive(command: string, args: readonly string[], options: Pick<LaunchOptions, 'cwd' | 'env'>): InteractiveProcess {
    return this.start(command, args, { cwd: options.cwd, env: options.env }, true) as InteractiveProcess
  }

  private start(command: string, args: readonly string[], options: LaunchOptions, interactive: boolean): LaunchedProcess {
    // Node starts a process given an empty folder in Sotto's own folder, where Git would read or change a repository
    // nobody chose. Refused where it is asked, so the caller's promise rejects.
    if (!options.cwd) throw new Error(`Sotto did not start ${command} because it was not given a folder to run in. Nothing was changed. Try again from a thread that has a project folder.`)
    const worker = this.ensureWorker()
    if (!worker) return inThread(command, args, options, interactive)
    const id = this.next++
    const launched = new OffThreadProcess(id, request => { try { worker.postMessage(request) } catch { /* The worker has gone; its exit settles this launch. */ } }, interactive)
    if (!this.running.size) worker.ref()
    this.running.set(id, { process: launched, command, args, options, interactive })
    launched.on('close', () => {
      if (this.running.get(id)?.process !== launched) return
      this.running.delete(id)
      if (!this.running.size && this.worker === worker) worker.unref()
    })
    worker.postMessage({ type: 'launch', id, command, args: [...args], cwd: options.cwd, env: { ...options.env }, stdin: interactive ? null : options.stdin ?? null, detached: options.detached ?? false, ...(interactive ? { interactive } : {}) } satisfies LauncherRequest)
    return launched
  }

  /**
   * Stops the worker. A launch still running is stopped first and reports that it stopped; the worker is then given a
   * moment to see each exit, so its loop collects them rather than leaving them defunct. For tests and shutdown.
   */
  async close(): Promise<void> {
    const worker = this.worker
    this.worker = null
    if (!worker) return
    this.closing = worker
    const running = [...this.running.values()]
    const exits = running.map(({ process }) => new Promise<void>(done => this.exited.set(process.id, done)))
    // One the worker has not started yet is stopped as it starts: the worker takes a kill for a launch it has queued.
    for (const { process } of running) if (!process.started) process.kill('SIGKILL')
    await this.abandon(false)
    let waited: NodeJS.Timeout | undefined
    await Promise.race([Promise.all(exits), new Promise<void>(done => { waited = setTimeout(done, 2_000) })])
    clearTimeout(waited)
    this.exited.clear()
    await worker.terminate()
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
    worker.on('message', (event: LauncherEvent) => {
      if (event.type === 'close') this.exited.get(event.id)?.()
      this.running.get(event.id)?.process.receive(event)
    })
    // An error only stops new launches going to this worker. What it had running is settled at exit: Node delivers the
    // worker's queued messages before 'exit' but not necessarily before 'error', so a launch it already started could
    // otherwise still look unstarted here and be started again in this thread.
    worker.on('error', () => { if (this.worker === worker) this.worker = null })
    worker.on('exit', () => {
      if (this.worker === worker) this.worker = null
      if (this.closing !== worker) void this.abandon(true)
    })
    return this.worker = worker
  }

  /**
   * The worker is gone or going: a launch it never started starts here when `relaunch` allows. Any other is stopped, if
   * the worker had started it, and then reports that it stopped, so a caller never sees a close while its Git still runs.
   */
  private abandon(relaunch: boolean): Promise<void> {
    const running = [...this.running.values()]
    this.running.clear()
    const stopping: Promise<void>[] = []
    for (const { process, command, args, options, interactive } of running) {
      if (relaunch && !process.started) {
        try { process.adopt(inThread(command, args, options, interactive)); continue } catch (error) {
          process.emit('error', error instanceof Error ? error : new Error(String(error)))
        }
      } else process.emit('error', new Error(`Sotto stopped ${command} because its process launcher closed. Nothing it changed was undone; check the folder, then try again.`))
      const pid = process.started ? process.pid : undefined
      stopping.push((pid === undefined ? Promise.resolve() : stopFromHere(pid, options.detached ?? false)).then(() => process.close(null, null)))
    }
    return Promise.all(stopping).then(() => undefined)
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
/** Starts a process with its standard input left open through the shared launcher (`GitLauncher.launchInteractive`). */
export function launchInteractiveProcess(command: string, args: readonly string[], options: Pick<LaunchOptions, 'cwd' | 'env'>): InteractiveProcess {
  return gitLauncher().launchInteractive(command, args, options)
}
/**
 * Runs a process to its end in Sotto's own folder and environment, its output unread: resolves when it exits with 0,
 * rejects when it could not start or exited otherwise. Without the worker it is the `execFile` it always was.
 */
export function runToExit(command: string, args: readonly string[]): Promise<void> {
  return gitLauncher().run(command, args)
}
/**
 * Stops a process and everything it started, and settles only once that is seen gone: `taskkill /T` on Windows, where
 * a child such as git-remote-https outlives git; elsewhere the process group a `detached` launch leads. Rejects when the
 * group outlives its kill.
 */
export async function stopProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') { await runToExit('taskkill', ['/pid', String(pid), '/T', '/F']); return }
  const gone = (signal: NodeJS.Signals | 0): boolean => {
    try { process.kill(-pid, signal); return false } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error }
  }
  if (gone('SIGKILL')) return
  // kill only sends the signal: wait until the whole group is gone.
  const until = Date.now() + 5_000
  while (!gone(0)) {
    if (Date.now() > until) throw new Error('The process group outlived its kill.')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
