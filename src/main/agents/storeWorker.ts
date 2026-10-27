import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads'
import type { AgentActivity } from '../../shared/agentActivity'
import { SAVE_SYNCHRONOUS } from '../storage/sqliteDurability'
import { isImmutableActivity } from './activitySnapshots'
import type { ActivityListEntry, ThreadStoreWrite, ThreadStoreWriteOutcome } from './threadStoreWriter'

/**
 * Main's side of the store worker (#1457, ADR-0016's October 26 amendment): the worker thread (`threadStoreWorker.ts`)
 * that makes every write to `threads.sqlite` and runs its log's checkpoints, so no save and no checkpoint holds main.
 *
 * Main posts each write with an identity that counts up, and the worker applies them in that order and answers each with
 * what committed. Where the worker cannot be had (no built file beside this module, as under the test runner, or one
 * that failed to start), the store writes on main as it did before. A worker that goes without being stopped hands back
 * every write it had not answered, in order, saying whether it had begun it, so the store can finish them on main.
 */
export const BUILT_STORE_WORKER = join(__dirname, 'threadStoreWorker.js')
/** How long after its last checkpoint the worker runs a PASSIVE one, which takes no lock a read waits for. */
export const CHECKPOINT_INTERVAL_MS = 500
/**
 * 16 MB of 4 KB pages: four times SQLite's own threshold. Past it the worker also runs a RESTART, which puts the whole log
 * in the file so the next write starts it over. With the worker the only writer, nothing else takes the write lock it
 * asks for; it waits only for main's reads to leave the old log, which takes a moment.
 */
export const RESTART_PAGES = 4_096
/** How long a RESTART waits for main's reads to move off the log before trying again. */
export const RESTART_WAIT_MS = 10
/** When a RESTART still found a read on the log, how soon the worker tries again: passive checkpoint, then RESTART. */
export const RESTART_RETRY_MS = 2
/** How long the worker's writes wait for a lock, as main's did. */
export const WRITE_BUSY_TIMEOUT_MS = 5_000
/** How long closing waits for the worker to answer every write posted before it goes on without the rest. */
const DRAIN_LIMIT_MS = 60_000
/** How long a stop waits for the worker to close its connection. */
const STOP_LIMIT_MS = 10_000

/**
 * The slots of the control array main and the worker share; `threadStoreWorker.ts` keeps its own copy, since it must not
 * import main's modules. STATE says whether a passive checkpoint (RUNNING) or a RESTART (RESTARTING) runs. LIFE goes
 * STARTING, then OPEN once the worker opened its connection, then STOPPED once it has closed it or never will; STOPPING
 * asks an open worker to close. APPLYING is the identity of the newest write the worker has begun, and DONE of the newest
 * it has answered; a read on main compares them with what it posted (`started`). RESTARTS and RESTARTS_BUSY count the
 * RESTARTs that put the whole log in the file and those that found a read on it, for a test or a measurement.
 */
export const CONTROL = { STATE: 0, LIFE: 1, RESTARTS: 2, RESTARTS_BUSY: 3, APPLYING: 4, DONE: 5, SLOTS: 6 } as const
export const CHECKPOINT = { IDLE: 0, RUNNING: 1, RESTARTING: 3 } as const
export const LIFE = { STARTING: 0, STOPPING: 1, STOPPED: 2, OPEN: 3 } as const

export interface StoreWorkerTiming {
  readonly intervalMs?: number
  readonly restartPages?: number
  readonly restartWaitMs?: number
  readonly restartRetryMs?: number
  readonly busyTimeoutMs?: number
}

/** The built worker and, for a test or a measurement, its timing. */
export interface StoreWorkerOptions { readonly path: string; readonly timing?: StoreWorkerTiming }

export interface StoreWorkerData {
  readonly path: string
  readonly control: SharedArrayBuffer
  readonly port: MessagePort
  readonly intervalMs: number
  readonly restartPages: number
  readonly restartWaitMs: number
  readonly restartRetryMs: number
  readonly busyTimeoutMs: number
  readonly synchronous: string
}

/**
 * One thread's activity list as it crosses to the worker. A list sent before is sent as what changed since (`base`): the
 * order of its identities and the records that are not the same frozen record as last time. The worker keeps the list it
 * last committed for each thread and rebuilds the rest from it, so a save of a thread holding two thousand records copies
 * the few that changed rather than all of them. A worker that no longer holds `base` fails the entry, and the next save
 * sends the list whole.
 */
export type WireActivityEntry = { readonly threadId: string; readonly epoch?: string | undefined; readonly version: number } & (
  | { readonly whole: readonly AgentActivity[] }
  | { readonly base: number; readonly same: true }
  | { readonly base: number; readonly ids: readonly string[]; readonly changed: readonly AgentActivity[] })

/** A write as it crosses to the worker: activity lists as changes, and Keep local history's dormant threads named. */
export type WireWrite =
  | Exclude<ThreadStoreWrite, { kind: 'activities' } | { kind: 'activity-list' } | { kind: 'history-off' }>
  | { readonly kind: 'activities'; readonly entries: readonly WireActivityEntry[] }
  | { readonly kind: 'activity-list'; readonly flushed?: boolean | undefined; readonly entry: WireActivityEntry }
  | (Extract<ThreadStoreWrite, { kind: 'history-off' }> & { readonly preserved: readonly string[] })

export type WorkerRequest = { readonly kind: 'write'; readonly id: number; readonly write: WireWrite } | { readonly kind: 'stop' }

/** The worker's answer to one write. `memory` says it took the file's words out and closed it for Keep local history. */
export interface WorkerAnswer {
  readonly id: number
  readonly failed: readonly string[]
  readonly error?: { readonly name: string; readonly message: string } | undefined
  readonly removed?: number | undefined
  readonly memory?: true | undefined
}

/** What became of a posted write: the worker's outcome, or the worker went before answering it. */
export type StoreWorkerResult =
  | { readonly outcome: ThreadStoreWriteOutcome & { readonly memory?: true | undefined } }
  | { readonly lost: true; readonly started: boolean }

interface Pending { readonly id: number; readonly write: ThreadStoreWrite; readonly settle: (result: StoreWorkerResult) => void }

/** A write the worker went without answering, handed back in the order posted; `started` says whether it had begun it. */
export interface UnansweredWrite { readonly write: ThreadStoreWrite; readonly started: boolean; readonly settle: (result: StoreWorkerResult) => void }

/** The list last sent for one thread, so the next can go as what changed. */
interface SentList { readonly version: number; readonly list: readonly AgentActivity[]; readonly records: ReadonlyMap<string, AgentActivity> }

export class StoreWorker {
  private readonly pending = new Map<number, Pending>()
  private readonly sent = new Map<string, SentList>()
  private nextId = 1
  private nextVersion = 1
  private gone = false
  private stopping = false
  private constructor(private readonly worker: Worker, private readonly port: MessagePort, private readonly control: Int32Array,
    private readonly lost: (unanswered: readonly UnansweredWrite[]) => void) {
    port.on('message', (answer: WorkerAnswer) => { this.answered(answer) })
    port.unref()
  }

  /**
   * Starts the worker for the database at `path`, or answers undefined where it cannot be had. `lost` hears once, in the
   * order posted, every write the worker had not answered when it went without being stopped.
   */
  static start(path: string, worker: string | StoreWorkerOptions | null, lost: (unanswered: readonly UnansweredWrite[]) => void): StoreWorker | undefined {
    const options = typeof worker === 'string' ? { path: worker } : worker
    if (options === null || !existsSync(options.path)) return undefined
    const timing = options.timing ?? {}
    const control = new Int32Array(new SharedArrayBuffer(CONTROL.SLOTS * Int32Array.BYTES_PER_ELEMENT))
    const { port1, port2 } = new MessageChannel()
    const workerData: StoreWorkerData = { path, control: control.buffer as SharedArrayBuffer, port: port2,
      intervalMs: timing.intervalMs ?? CHECKPOINT_INTERVAL_MS, restartPages: timing.restartPages ?? RESTART_PAGES,
      restartWaitMs: timing.restartWaitMs ?? RESTART_WAIT_MS, restartRetryMs: timing.restartRetryMs ?? RESTART_RETRY_MS,
      busyTimeoutMs: timing.busyTimeoutMs ?? WRITE_BUSY_TIMEOUT_MS, synchronous: SAVE_SYNCHRONOUS }
    let thread: Worker
    try { thread = new Worker(options.path, { workerData, transferList: [port2], stdout: false, stderr: false }) } catch {
      port1.close()
      console.warn('thread-store-worker-unavailable')
      return undefined
    }
    const handle = new StoreWorker(thread, port1, control, lost)
    const gone = (): void => { handle.lose() }
    thread.on('error', gone)
    thread.on('exit', gone)
    thread.unref()
    return handle
  }

  /** Posts a write; `settle` hears once what became of it. */
  post(write: ThreadStoreWrite, settle: (result: StoreWorkerResult) => void, preserved: () => readonly string[] = () => []): number {
    const id = this.nextId++
    const pending = { id, write, settle }
    this.pending.set(id, pending)
    if (this.gone) { this.lose(); return id }
    // Kept from being collected with nothing else to do while a write is unanswered, so its confirmation arrives.
    this.port.ref()
    this.port.postMessage({ kind: 'write', id, write: this.wire(write, preserved) } satisfies WorkerRequest)
    return id
  }

  /** Whether the worker has begun this write, so what it commits may already show to main's reads. */
  started(id: number): boolean { return Atomics.load(this.control, CONTROL.APPLYING) >= id }

  /** Whether the worker still takes writes. */
  get live(): boolean { return !this.gone && !this.stopping }

  /**
   * Waits until every write posted has been answered, receiving each answer here rather than on the event loop: for
   * shutdown, which cannot wait for a task. Answers whether it finished; a worker that never answers is left for `stop`.
   */
  drain(limitMs = DRAIN_LIMIT_MS): boolean {
    const deadline = performance.now() + limitMs
    while (this.pending.size) {
      const received = receiveMessageOnPort(this.port)
      if (received) { this.answered(received.message as WorkerAnswer); continue }
      if (this.gone || Atomics.load(this.control, CONTROL.LIFE) === LIFE.STOPPED) { this.lose(); return true }
      if (performance.now() >= deadline) return false
      Atomics.wait(this.control, CONTROL.DONE, Atomics.load(this.control, CONTROL.DONE), 50)
    }
    return true
  }

  /** The RESTARTs so far that put the whole log in the file, and those that found a read on it. */
  restarts(): { readonly done: number; readonly busy: number } {
    return { done: Atomics.load(this.control, CONTROL.RESTARTS), busy: Atomics.load(this.control, CONTROL.RESTARTS_BUSY) }
  }

  /** The control array, for a test that waits on the worker's checkpoints. */
  get controlArray(): Int32Array { return this.control }

  /**
   * Stops the worker, its connection closed before this returns, so main's close is the file's last. Writes still
   * unanswered are not waited for; `drain` first for those.
   */
  stop(): void {
    if (this.stopping) return
    this.stopping = true
    if (!this.gone && Atomics.compareExchange(this.control, CONTROL.LIFE, LIFE.STARTING, LIFE.STOPPED) !== LIFE.STARTING) {
      if (Atomics.compareExchange(this.control, CONTROL.LIFE, LIFE.OPEN, LIFE.STOPPING) === LIFE.OPEN) {
        this.port.postMessage({ kind: 'stop' } satisfies WorkerRequest)
        const deadline = performance.now() + STOP_LIMIT_MS
        while (Atomics.load(this.control, CONTROL.LIFE) !== LIFE.STOPPED && performance.now() < deadline) Atomics.wait(this.control, CONTROL.LIFE, LIFE.STOPPING, 100)
      }
    }
    this.gone = true
    this.pending.clear()
    this.port.close()
    void this.worker.terminate().catch(() => undefined)
  }

  /** Lets the worker go at once, as if it had failed: what a test does to see the store finish its writes on main. */
  async terminate(): Promise<void> { await this.worker.terminate() }

  private answered(answer: WorkerAnswer): void {
    const pending = this.pending.get(answer.id)
    if (!pending) return
    this.pending.delete(answer.id)
    if (!this.pending.size && !this.gone) this.port.unref()
    const failed = new Set(answer.failed)
    // A list that did not commit is sent whole next time, so the worker never rebuilds from one it lacks.
    for (const threadId of failed) this.sent.delete(threadId)
    if (answer.error !== undefined && failed.size === 0) this.sent.clear()
    const error = answer.error === undefined ? undefined : Object.assign(new Error(answer.error.message), { name: answer.error.name })
    pending.settle({ outcome: { failed, ...(error === undefined ? {} : { error }), ...(answer.removed === undefined ? {} : { removed: answer.removed }), ...(answer.memory ? { memory: true } : {}) } })
  }

  /** The worker went without being stopped: what it answered before going is heard, and the rest goes back in order. */
  private lose(): void {
    if (this.stopping && this.pending.size === 0) { this.gone = true; return }
    if (this.gone && this.pending.size === 0) return
    for (;;) {
      const received = this.gone ? undefined : receiveMessageOnPort(this.port)
      if (!received) break
      this.answered(received.message as WorkerAnswer)
    }
    // An answer just heard may have stopped it, as Keep local history turning off does.
    if (this.stopping) { this.gone = true; return }
    const wasGone = this.gone
    this.gone = true
    const applying = Atomics.load(this.control, CONTROL.APPLYING)
    const unanswered = [...this.pending.values()].sort((a, b) => a.id - b.id)
    this.pending.clear()
    this.sent.clear()
    if (!wasGone) {
      try { this.port.close() } catch { /* Already closed. */ }
      void this.worker.terminate().catch(() => undefined)
      if (!this.stopping) console.warn('thread-store-worker-lost')
    }
    this.lost(unanswered.map(({ id, write, settle }) => ({ write, started: id <= applying, settle })))
  }

  /** The write as it crosses: activity lists as what changed since the last sent. */
  private wire(write: ThreadStoreWrite, preserved: () => readonly string[]): WireWrite {
    switch (write.kind) {
      case 'activities': return { kind: 'activities', entries: write.entries.map(entry => this.list(entry)) }
      case 'activity-list': return { kind: 'activity-list', flushed: write.flushed, entry: this.list(write) }
      case 'history-off': this.sent.clear(); return { ...write, preserved: preserved() }
      case 'history-on': this.sent.clear(); return write
      case 'activities-released': this.sent.delete(write.threadId); return write
      case 'forget': for (const threadId of write.threadIds) this.sent.delete(threadId); return write
      default: return write
    }
  }

  private list(entry: ActivityListEntry): WireActivityEntry {
    const { threadId, activities, epoch } = entry
    const version = this.nextVersion++
    const last = this.sent.get(threadId)
    const records = last?.list === activities ? last.records : new Map(activities.map(activity => [activity.id, activity]))
    this.sent.set(threadId, { version, list: activities, records })
    if (!last) return { threadId, epoch, version, whole: activities }
    if (last.list === activities && activities.every(isImmutableActivity)) return { threadId, epoch, version, base: last.version, same: true }
    // A record that is not frozen may have been edited where it is, so only a frozen one the same as last time is left out.
    const changed = activities.filter(activity => !isImmutableActivity(activity) || last.records.get(activity.id) !== activity)
    return { threadId, epoch, version, base: last.version, ids: activities.map(activity => activity.id), changed }
  }
}
