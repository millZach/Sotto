import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { carriesCameraDetails } from '../main/agents/mediaThumbnail'
import type { PictureAnswer, PictureRequest } from './pictureCopy'

/** The worker file the build puts beside the host's index.js (`scripts/build-host.mjs`). */
export const BUILT_PICTURE_WORKER = join(__dirname, 'pictureWorker.js')
/** How long the worker stays after its last copy before it ends, and the memory its decoding held goes back to the system. */
export const PICTURE_WORKER_IDLE_MS = 30_000
/**
 * How long the worker may go without answering while a picture waits. Past it the worker is stopped, every waiting
 * picture is sent whole, and the next one asked for starts a worker afresh.
 */
export const PICTURE_WORKER_LIMIT_MS = 15_000
/** How many pictures may wait for the worker at once: one more is sent whole at once rather than queued behind them. */
export const PICTURES_WAITING_MAX = 8
/**
 * How many workers in a row may fail, or go without answering in time, before the host stops starting them and sends every
 * picture whole until it restarts. One answer clears the count.
 */
const FAILED_STARTS_MAX = 3

const KINDS = ['data:image/png;base64,', 'data:image/jpeg;base64,'] as const

/**
 * A headless host's maker of the copies phones ask for at a longest edge (`thread-media-edge`, ADR-0202), for
 * `ReducedPictures` as Electron's image tools are on the desktop. The decoding, scaling and encoding run in one worker
 * process (`pictureWorker.ts`), one picture at a time, never on the host's own thread, which only hands the worker the data
 * URL it already read and takes back the copy. A process rather than a worker thread, because decoding leaves Node's
 * allocator holding about 150 MB more of a process's memory than before it, which a thread's ending does not give back and
 * a process's does. The worker starts when a phone first asks and ends once idle. A picture is sent whole, with no copy,
 * when it is not a PNG or a JPEG, when it carries camera details (as the desktop's maker does), when the worker cannot be
 * had or does not answer in time, and when too many already wait.
 */
export class PictureMaker {
  private worker: ChildProcess | undefined
  private readonly waiting = new Map<number, (copy: string | null) => void>()
  private next = 1
  private timer: NodeJS.Timeout | undefined
  /** Whether the timer running is the deadline for an answer, not the idle wait. */
  private awaitingAnswer = false
  private closed = false
  private failedStarts = 0
  private copies = 0

  constructor(private readonly path: string = BUILT_PICTURE_WORKER, private readonly options: {
    readonly idleMs?: number; readonly limitMs?: number; readonly log?: (event: 'picture-worker-stopped' | 'picture-worker-unavailable') => void } = {}) {}

  /** Whether the worker file is there to start: where it is not, the host offers no copies and lists no `thread-media-edge`. */
  static available(path: string = BUILT_PICTURE_WORKER): boolean { return existsSync(path) }

  /** How many copies the worker has made, each answered from its own process: none is ever made in the host's. */
  get made(): number { return this.copies }
  /** Whether a worker is running now: from the first picture asked for until it has been idle a while. */
  get running(): boolean { return this.worker !== undefined }

  /** The copy of `dataUrl` at no more than `edge` on its longest side, or null to send the picture whole. */
  reduce(dataUrl: string, edge: number): Promise<string | null> {
    if (this.closed || this.failedStarts >= FAILED_STARTS_MAX || this.waiting.size >= PICTURES_WAITING_MAX
      || !KINDS.some(kind => dataUrl.startsWith(kind)) || carriesCameraDetails(dataUrl)) return Promise.resolve(null)
    const worker = this.started()
    if (!worker) return Promise.resolve(null)
    const id = this.next++
    return new Promise(resolve => {
      this.waiting.set(id, resolve)
      worker.send({ id, dataUrl, edge } satisfies PictureRequest, error => { if (error) this.lose(worker, true) })
      // A picture asked for while others wait keeps their deadline: only an answer starts the clock again.
      if (!this.awaitingAnswer) this.watch()
    })
  }

  /** Stops the worker; every picture still waiting is sent whole, and nothing more is made. */
  async close(): Promise<void> {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    await this.stop()
  }

  private started(): ChildProcess | undefined {
    if (this.worker) return this.worker
    if (!existsSync(this.path)) return undefined
    let worker: ChildProcess
    // The host's own Node runs it, with none of the host's flags, and nothing it might print is read or kept.
    try { worker = fork(this.path, [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }) } catch { this.failed(); return undefined }
    worker.on('message', (answer: PictureAnswer) => { this.answered(answer) })
    // A worker that goes before it is stopped, by failing to start or ending on its own, takes nothing with it: what waited
    // is sent whole. One the host stopped is already let go.
    worker.on('error', () => { this.lose(worker, true) })
    worker.on('exit', () => { this.lose(worker, true) })
    // It never keeps the host running on its own.
    worker.unref()
    worker.channel?.unref()
    this.worker = worker
    return worker
  }

  private answered(answer: PictureAnswer): void {
    const settle = this.waiting.get(answer.id)
    if (!settle) return
    this.waiting.delete(answer.id)
    this.failedStarts = 0
    // Counted only from a process other than the host's own.
    if (answer.copy !== null && answer.pid !== process.pid) this.copies++
    settle(answer.copy)
    this.watch()
  }

  /** While pictures wait, how long the worker has to answer; once none does, how long it stays. */
  private watch(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.awaitingAnswer = false
    if (this.closed || !this.worker) return
    // A worker that does not answer in time counts as one that failed, so one that hangs on every picture is not started forever.
    this.awaitingAnswer = this.waiting.size > 0
    this.timer = this.waiting.size
      ? setTimeout(() => { this.options.log?.('picture-worker-stopped'); void this.stop(true) }, this.options.limitMs ?? PICTURE_WORKER_LIMIT_MS)
      : setTimeout(() => { void this.stop() }, this.options.idleMs ?? PICTURE_WORKER_IDLE_MS)
    this.timer.unref()
  }

  /** Ends the worker, and waits for it to end: two seconds after asking, it is made to. */
  private async stop(failed = false): Promise<void> {
    const worker = this.worker
    if (!worker) return
    this.lose(worker, failed)
    // One that never started, or has already ended, has nothing to wait for.
    if (worker.pid === undefined || worker.exitCode !== null || worker.signalCode !== null) return
    const ended = new Promise<void>(done => { worker.once('exit', () => { done() }) })
    worker.kill()
    const forced = setTimeout(() => { worker.kill('SIGKILL') }, 2_000)
    forced.unref()
    await ended
    clearTimeout(forced)
  }

  /** `worker` is gone: whatever waited on it is sent whole. `failed` when it went on its own, before it was stopped. */
  private lose(worker: ChildProcess, failed: boolean): void {
    if (this.worker !== worker) return
    this.worker = undefined
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.awaitingAnswer = false
    if (failed) this.failed()
    for (const settle of this.waiting.values()) settle(null)
    this.waiting.clear()
  }

  private failed(): void {
    if (++this.failedStarts === FAILED_STARTS_MAX) this.options.log?.('picture-worker-unavailable')
  }
}
