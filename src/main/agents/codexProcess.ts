import { stderrRateExceeded } from './stderrRate'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { z } from 'zod'

const OUTPUT_DRAIN_GRACE_MS = 300
// Legacy history and completed turns can echo multiple screenshot batches. Keep a
// separate history budget rather than limiting a frame to one submitted prompt.
const MAX_FRAME_BYTES = 128 * 1024 * 1024
const MAX_QUEUED_BYTES = MAX_FRAME_BYTES * 2

export const rpcSchema = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional(), error: z.unknown().optional() })
export type RpcFrame = z.infer<typeof rpcSchema>

/** Codex did not confirm an operation: it may or may not have happened. */
export class Uncertain extends Error {}

type Waiter = { resolve: () => void; reject: (error: Error) => void; apply: (value: unknown) => Promise<void> | void
  onRejected: (() => Promise<void> | void) | undefined; timer: ReturnType<typeof setTimeout> }
export type RpcApply = Waiter['apply']
export type RpcRejected = Waiter['onRejected']

export interface CodexProcessOptions {
  executable: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  requestTimeoutMs: number
  /**
   * Every process hands its frames to the one queue the adapter owns, so a response's `apply` and the
   * notifications around it are applied one at a time, in the order each process sent them.
   */
  enqueue(task: () => Promise<void>): Promise<void>
  /** A notification, or a request Codex makes of Sotto. Responses to Sotto's own requests are settled here. */
  onFrame(process: CodexProcess, frame: RpcFrame): Promise<void>
  /** The process stopped without Sotto ending it, or had to be ended because it could not be read. Called once. */
  onLost(process: CodexProcess): void
  /** How Codex's error for a request becomes the error `rpc` rejects with. */
  rejection(error: unknown): Error
}

let serials = 0

/**
 * One `codex app-server` over stdio: its JSON-RPC framing, the requests Sotto is waiting on, and its exit.
 * A thread's session runs in its own process, and provider-level work (models, account, skills, settings
 * reads) in another, so one ending is only that thread's failure. What a frame means stays with the adapter.
 */
export class CodexProcess {
  /** Unique among this run's processes; a request Codex makes is named by it, since each process numbers its own. */
  readonly serial = ++serials
  readonly closed: Promise<void>
  private readonly child: ChildProcessWithoutNullStreams
  /** What Sotto asked and is owed an answer to. A waiter outlives its deadline, so a late reply can still be applied. */
  private readonly waiters = new Map<string, Waiter>()
  private nextId = 0
  private ending = false
  private endIdle = false
  private lost = false

  constructor(private readonly options: CodexProcessOptions) {
    const child = spawn(options.executable, [...options.args], { cwd: options.cwd, env: options.env, windowsHide: true, shell: false, stdio: 'pipe' })
    this.child = child
    let buffer: string[] = []; let bufferedBytes = 0; let queuedBytes = 0
    this.closed = new Promise<void>(resolve => child.once('close', () => { this.fail(); resolve() }))
    // Let final output drain, then release handles a descendant may still hold.
    child.once('exit', () => {
      const timer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy() }, OUTPUT_DRAIN_GRACE_MS)
      timer.unref(); child.once('close', () => clearTimeout(timer))
    })
    child.on('error', () => this.abort())
    child.stdin.on('error', () => this.abort())
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.lost) return
      let start = 0
      while (start < chunk.length) {
        const newline = chunk.indexOf('\n', start)
        const part = chunk.slice(start, newline < 0 ? undefined : newline)
        buffer.push(part); bufferedBytes += Buffer.byteLength(part)
        if (bufferedBytes > MAX_FRAME_BYTES) { this.abort(); return }
        if (newline < 0) break
        // Count each chunk once; repeatedly measuring an accumulating base64 frame is quadratic.
        const line = buffer.join(''); const bytes = bufferedBytes
        buffer = []; bufferedBytes = 0; start = newline + 1
        if (!line.trim()) continue
        queuedBytes += bytes
        if (queuedBytes > MAX_QUEUED_BYTES) { this.abort(); return }
        void options.enqueue(async () => {
          try { if (!this.lost) await this.frame(rpcSchema.parse(JSON.parse(line))) }
          finally { queuedBytes -= bytes }
        }).catch(() => this.abort())
      }
    })
    const stderrExceeded = stderrRateExceeded()
    child.stderr.on('data', (chunk: Buffer) => { if (stderrExceeded(chunk.length)) this.abort() })
  }

  /** Whether an answer to something Sotto asked is still owed, a late one included: a late answer is still applied. */
  get owed(): boolean { return this.waiters.size > 0 }

  /** Whether requests can still be written to it. */
  get alive(): boolean { return !this.lost && !this.ending && !this.endIdle && !this.child.stdin.destroyed }

  private async frame(frame: RpcFrame): Promise<void> {
    if (!frame.method && frame.id !== undefined) {
      const key = JSON.stringify(frame.id); const waiter = this.waiters.get(key)
      if (!waiter) return
      clearTimeout(waiter.timer); this.waiters.delete(key)
      try {
        if (frame.error !== undefined) { await waiter.onRejected?.(); waiter.reject(this.options.rejection(frame.error)) }
        else { await waiter.apply(frame.result); waiter.resolve() }
      } catch { waiter.reject(new Uncertain('Codex response could not be applied.')); this.abort() }
      if (this.endIdle && !this.waiters.size) this.end()
      return
    }
    await this.options.onFrame(this, frame)
  }

  write(value: unknown): void {
    if (!this.alive) throw new Uncertain('Codex connection closed before acknowledgement.')
    this.child.stdin.write(JSON.stringify(value) + '\n')
  }

  rpc(method: string, params: unknown, apply: RpcApply = () => undefined, onRejected?: RpcRejected): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId; const key = JSON.stringify(id)
      // Keep the callback after timeout: late thread/start responses still establish durable aliases.
      const timer = setTimeout(() => reject(new Uncertain('Codex did not acknowledge the operation in time.')), this.options.requestTimeoutMs)
      this.waiters.set(key, { resolve, reject, apply, onRejected, timer })
      try { this.write({ id, method, params }) } catch (error) { clearTimeout(timer); this.waiters.delete(key); reject(error) }
    })
  }

  /** Answer a request this process made, and settle once the answer has left for it. */
  answer(id: string | number, result: unknown): Promise<void> {
    if (!this.alive) return Promise.reject(new Uncertain('Codex disconnected before receiving the answer.'))
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Uncertain('Codex answer delivery is uncertain.')), this.options.requestTimeoutMs)
      this.child.stdin.write(JSON.stringify({ id, result }) + '\n', error => {
        clearTimeout(timer)
        if (error) reject(new Uncertain('Codex answer delivery is uncertain.')); else resolve()
      })
    })
  }

  /**
   * Let it go: close its input, so anything already written still reaches it, and force it if it is still running
   * after `graceMs`. Disconnecting allows a moment; an idle thread's app-server is given longer to finish writing.
   */
  end(graceMs = 100): void {
    if (this.ending) return
    this.ending = true
    this.rejectWaiters()
    try { this.child.stdin.end() } catch { /* Already closed. */ }
    const timer = setTimeout(() => this.child.kill('SIGKILL'), graceMs)
    timer.unref(); void this.closed.then(() => clearTimeout(timer))
  }

  /**
   * Let it go once nothing Sotto asked of it is still waiting, or when the request deadline passes. What it was
   * asked meanwhile still gets its answer; nothing new is sent to a process being let go.
   */
  endWhenIdle(): void {
    if (this.ending) return
    if (!this.waiters.size) { this.end(); return }
    this.endIdle = true
    const timer = setTimeout(() => this.end(), this.options.requestTimeoutMs)
    timer.unref(); void this.closed.then(() => clearTimeout(timer))
  }

  /** It cannot be read or written any more: stop it now, and say it was lost unless Sotto was already ending it. */
  abort(): void {
    this.child.kill('SIGKILL')
    this.fail()
  }

  private fail(): void {
    if (this.lost) return
    this.lost = true
    this.rejectWaiters()
    if (!this.ending) this.options.onLost(this)
  }

  private rejectWaiters(): void {
    for (const waiter of this.waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Uncertain('Codex disconnected before acknowledgement.')) }
    this.waiters.clear()
  }
}
