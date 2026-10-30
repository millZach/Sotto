import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads'
import type { AgentActivity } from '../../shared/agentActivity'
import { SAVE_SYNCHRONOUS } from '../storage/sqliteDurability'
import { isImmutableActivities, isImmutableActivity, ownBuiltActivity } from './activitySnapshots'
import type { ActivityListEntry, ActivityReadBack, ThreadStoreWrite, ThreadStoreWriteOutcome } from './threadStoreWriter'
import { CONTROL, LIFE, type StoreWorkerData, type WireActivityEntry, type WireWrite, type WorkerAnswer, type WorkerMessage, type WorkerReadAnswer, type WorkerRequest } from './storeWorkerProtocol'

export { CHECKPOINT, CONTROL, LIFE } from './storeWorkerProtocol'
export type { StoreWorkerData, WireActivityEntry, WireWrite, WorkerAnswer, WorkerMessage, WorkerReadAnswer, WorkerRequest } from './storeWorkerProtocol'

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
/**
 * How long closing waits, from when it begins, for every write posted to be answered: the awaits before the store closes,
 * the drain and the worker's stop share it. What is not answered by then is reported as not saved.
 */
export const CLOSE_LIMIT_MS = 60_000
/** How long a stop waits for the worker to close its connection. */
const STOP_LIMIT_MS = 10_000


export interface StoreWorkerTiming {
  readonly intervalMs?: number
  readonly restartPages?: number
  readonly restartWaitMs?: number
  readonly restartRetryMs?: number
  readonly busyTimeoutMs?: number
}

/** The built worker and, for a test or a measurement, its timing. */
export interface StoreWorkerOptions { readonly path: string; readonly timing?: StoreWorkerTiming }

/** What became of a posted write: the worker's outcome, or the worker went before answering it. */
export type StoreWorkerResult =
  | { readonly outcome: ThreadStoreWriteOutcome & { readonly memory?: true | undefined } }
  | { readonly lost: true; readonly started: boolean }

interface Pending { readonly id: number; readonly write: ThreadStoreWrite; readonly settle: (result: StoreWorkerResult) => void }

/** A write the worker went without answering, handed back in the order posted; `started` says whether it had begun it. */
export interface UnansweredWrite { readonly write: ThreadStoreWrite; readonly started: boolean; readonly settle: (result: StoreWorkerResult) => void }

/** The list last sent for one thread, or read back from the worker, so the next can go as what changed. */
interface SentList { readonly version: number; readonly list: readonly AgentActivity[]; readonly records: ReadonlyMap<string, AgentActivity> }

export class StoreWorker {
  private readonly pending = new Map<number, Pending>()
  /** Stored threads' activity being read back, each heard once: its records, that they could not be read, or lost. */
  private readonly reads = new Map<number, { readonly settle: (result: ActivityReadBack) => void; readonly records: AgentActivity[]; readonly threadId: string; readonly version: number }>()
  private nextRead = 1
  private readonly sent = new Map<string, SentList>()
  /**
   * The read whose list becomes each thread's last sent once it arrives whole (#1645). The worker keeps the list it read
   * under the read's version; a write posted after the read that changes what the worker keeps for the thread lets the read
   * go, so main never sends changes to a list the worker has replaced.
   */
  private readonly bases = new Map<string, number>()
  private nextId = 1
  private nextVersion = 1
  private gone = false
  private stopping = false
  private constructor(private readonly worker: Worker, private readonly port: MessagePort, private readonly control: Int32Array,
    private readonly lost: (unanswered: readonly UnansweredWrite[]) => void) {
    port.on('message', (message: WorkerMessage) => { this.heard(message) })
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

  /**
   * Reads a stored thread's activity back on the worker, behind every write posted before it; `settle` hears once what
   * came back. The list comes in pieces (`READ_PIECE_RECORDS`), each asked for from a task of its own once the one before
   * it is in, so no one receive holds main long. The records are frozen and owned here as they arrive, so main holds them as
   * it holds a list it read itself. A worker that goes or stops first answers it lost, and the caller reads on main.
   */
  read(threadId: string, settle: (result: ActivityReadBack) => void): void {
    if (this.gone || this.stopping) { settle({ lost: true }); return }
    const read = this.nextRead++
    const version = this.nextVersion++
    this.reads.set(read, { settle, records: [], threadId, version })
    this.bases.set(threadId, read)
    this.port.ref()
    this.port.postMessage({ kind: 'read-activities', read, threadId, version } satisfies WorkerRequest)
  }

  /** Whether the worker has begun this write, so what it commits may already show to main's reads. */
  started(id: number): boolean { return Atomics.load(this.control, CONTROL.APPLYING) >= id }

  /** Whether the worker still takes writes. */
  get live(): boolean { return !this.gone && !this.stopping }

  /**
   * Waits until every write posted has been answered, receiving each answer here rather than on the event loop: for
   * shutdown, which cannot wait for a task. Answers whether it finished; a worker that never answers is left for `stop`.
   */
  drain(limitMs = CLOSE_LIMIT_MS): boolean {
    const deadline = performance.now() + limitMs
    while (this.pending.size) {
      const received = receiveMessageOnPort(this.port)
      if (received) { this.heard(received.message as WorkerMessage); continue }
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
   * unanswered are not waited for; `drain` first for those. It waits for the worker at most `limitMs`.
   */
  stop(limitMs = STOP_LIMIT_MS): void {
    if (this.stopping) return
    this.stopping = true
    if (!this.gone && Atomics.compareExchange(this.control, CONTROL.LIFE, LIFE.STARTING, LIFE.STOPPED) !== LIFE.STARTING) {
      if (Atomics.compareExchange(this.control, CONTROL.LIFE, LIFE.OPEN, LIFE.STOPPING) === LIFE.OPEN) {
        this.port.postMessage({ kind: 'stop' } satisfies WorkerRequest)
        const deadline = performance.now() + Math.min(limitMs, STOP_LIMIT_MS)
        while (Atomics.load(this.control, CONTROL.LIFE) !== LIFE.STOPPED && performance.now() < deadline) Atomics.wait(this.control, CONTROL.LIFE, LIFE.STOPPING, 100)
      }
    }
    this.gone = true
    this.pending.clear()
    this.port.close()
    this.readsLost()
    void this.worker.terminate().catch(() => undefined)
  }

  /** Lets the worker go at once, as if it had failed: what a test does to see the store finish its writes on main. */
  async terminate(): Promise<void> { await this.worker.terminate() }

  private heard(message: WorkerMessage): void {
    if ('read' in message) this.readAnswered(message)
    else this.answered(message)
  }

  private readAnswered(answer: WorkerReadAnswer): void {
    const read = this.reads.get(answer.read)
    if (!read) return
    if (answer.activities !== undefined) {
      // Frozen where they arrived: nobody else holds these copies.
      for (const activity of answer.activities) read.records.push(ownBuiltActivity(activity))
      if (answer.more) {
        // Asked for after this task, so the next piece is received in a task of its own, with the window's work between.
        setImmediate(() => { if (this.reads.get(answer.read) === read && !this.gone && !this.stopping) this.port.postMessage({ kind: 'read-more', read: answer.read } satisfies WorkerRequest) })
        return
      }
    }
    this.reads.delete(answer.read)
    this.unrefIfIdle()
    if (this.bases.get(read.threadId) === answer.read) {
      this.bases.delete(read.threadId)
      // The records main holds now are the worker's, copied: the next save sends the ones that changed (`list`).
      if (answer.activities !== undefined) this.sent.set(read.threadId, { version: read.version, list: read.records, records: new Map(read.records.map(record => [record.id, record])) })
    }
    read.settle(answer.activities === undefined ? { unreadable: true } : { activities: read.records })
  }

  /** Every read not yet answered is heard as lost, so its caller reads on main. */
  private readsLost(): void {
    const reads = [...this.reads.values()]
    this.reads.clear()
    for (const { settle } of reads) settle({ lost: true })
  }

  /** Lets the port go once nothing waits for an answer, so an idle worker keeps nothing alive. */
  private unrefIfIdle(): void {
    if (!this.pending.size && !this.reads.size && !this.gone) this.port.unref()
  }

  private answered(answer: WorkerAnswer): void {
    const pending = this.pending.get(answer.id)
    if (!pending) return
    this.pending.delete(answer.id)
    this.unrefIfIdle()
    const failed = new Set(answer.failed)
    // A list that did not commit is sent whole next time, so the worker never rebuilds from one it lacks.
    for (const threadId of failed) { this.sent.delete(threadId); this.bases.delete(threadId) }
    if (answer.error !== undefined && failed.size === 0) { this.sent.clear(); this.bases.clear() }
    const error = answer.error === undefined ? undefined : Object.assign(new Error(answer.error.message), { name: answer.error.name })
    pending.settle({ outcome: { failed, ...(error === undefined ? {} : { error }), ...(answer.removed === undefined ? {} : { removed: answer.removed }), ...(answer.memory ? { memory: true } : {}) } })
  }

  /** The worker went without being stopped: what it answered before going is heard, and the rest goes back in order. */
  private lose(): void {
    if (this.stopping && this.pending.size === 0) { this.gone = true; this.readsLost(); return }
    if (this.gone && this.pending.size === 0) { this.readsLost(); return }
    for (;;) {
      const received = this.gone ? undefined : receiveMessageOnPort(this.port)
      if (!received) break
      this.heard(received.message as WorkerMessage)
    }
    // An answer just heard may have stopped it, as Keep local history turning off does.
    if (this.stopping) { this.gone = true; this.readsLost(); return }
    const wasGone = this.gone
    this.gone = true
    const applying = Atomics.load(this.control, CONTROL.APPLYING)
    const unanswered = [...this.pending.values()].sort((a, b) => a.id - b.id)
    this.pending.clear()
    this.sent.clear()
    this.bases.clear()
    if (!wasGone) {
      try { this.port.close() } catch { /* Already closed. */ }
      void this.worker.terminate().catch(() => undefined)
      if (!this.stopping) console.warn('thread-store-worker-lost')
    }
    this.lost(unanswered.map(({ id, write, settle }) => ({ write, started: id <= applying, settle })))
    // Heard once the writes are handed back; the caller waits for main to finish them, then reads behind them there.
    this.readsLost()
  }

  /** The write as it crosses: activity lists as what changed since the last sent. */
  private wire(write: ThreadStoreWrite, preserved: () => readonly string[]): WireWrite {
    switch (write.kind) {
      case 'activities': return { kind: 'activities', entries: write.entries.map(entry => this.list(entry)) }
      case 'activity-list': return { kind: 'activity-list', flushed: write.flushed, entry: this.list(write) }
      case 'history-off': this.sent.clear(); this.bases.clear(); return { ...write, preserved: preserved() }
      case 'history-on': this.sent.clear(); this.bases.clear(); return write
      case 'activities-released': this.sent.delete(write.threadId); this.bases.delete(write.threadId); return write
      case 'forget': for (const threadId of write.threadIds) { this.sent.delete(threadId); this.bases.delete(threadId) } return write
      default: return write
    }
  }

  private list(entry: ActivityListEntry): WireActivityEntry {
    const { threadId, activities, epoch } = entry
    const version = this.nextVersion++
    // The worker replaces what it holds for the thread with this list, so a read on its way is not a base any more.
    this.bases.delete(threadId)
    const last = this.sent.get(threadId)
    // Only a certified list, frozen and owned whole, is known to be unchanged by being the same list: an array that is not
    // may have had records replaced, removed or reordered where it is, so it is read again each time.
    const same = last?.list === activities && isImmutableActivities(activities)
    const records = same ? last.records : new Map(activities.map(activity => [activity.id, activity]))
    this.sent.set(threadId, { version, list: activities, records })
    if (!last) return { threadId, epoch, version, whole: activities }
    if (same) return { threadId, epoch, version, base: last.version, same: true }
    // A record that is not frozen may have been edited where it is, so only a frozen one the same as last time is left out.
    const changed = activities.filter(activity => !isImmutableActivity(activity) || last.records.get(activity.id) !== activity)
    return { threadId, epoch, version, base: last.version, ids: activities.map(activity => activity.id), changed }
  }
}
