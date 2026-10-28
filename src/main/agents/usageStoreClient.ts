import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads'
import {
  answerUsageRequest, takesHistory, usageRequestState,
  type UsageRequestStore, type UsageStoreAnswers, type UsageStoreRequest,
} from './usageStoreRequests'
import { UsageStore } from './usageStore'
import {
  USAGE_WORKER_CONTROL, USAGE_WORKER_LIFE,
  type UsageWorkerAnswer, type UsageWorkerData, type UsageWorkerMessage, type UsageWorkerRole,
} from './usageStoreWorkerProtocol'

/** A store answer: at once where the store is on main, later where it is on the worker. */
export type Maybe<T> = T | Promise<T>

/**
 * How Usage reaches its store (ADR-0083, October 27 amendment). Every read and write of `usage.sqlite` is a request: on
 * the usage store worker where it is built, so none of them holds main, and in place on main where it is not, as under
 * the test runner, answering inside the call as the store always did.
 */
export interface UsageStoreClient {
  request<K extends UsageStoreRequest['kind']>(request: Extract<UsageStoreRequest, { kind: K }>): Maybe<UsageStoreAnswers[K]>
  /** Whether the store takes history imports: every store the app opens does. */
  readonly takesHistory: boolean
  /** Waits, at most `CLOSE_LIMIT_MS`, for every write asked for, then closes the store. */
  close(): void
}

/** The built worker beside main's bundle, or the headless host's. */
export const BUILT_USAGE_STORE_WORKER = join(__dirname, 'usageStoreWorker.js')
/**
 * How long closing waits for the writes already asked for. Usage never holds quitting open for long: what is not
 * written by then costs usage figures alone.
 */
export const CLOSE_LIMIT_MS = 5_000

/** The usage store worker where it is built, otherwise the store on main. `worker: null` keeps it on main. */
export function usageStoreClient(path: string, worker: string | null = BUILT_USAGE_STORE_WORKER): UsageStoreClient {
  if (worker !== null && existsSync(worker)) return new UsageStoreOnWorkers(path, worker)
  return new UsageStoreOnMain(new UsageStore(path))
}

/** The store on main: each request answered inside the call. Where there is no built worker, as under the test runner. */
export class UsageStoreOnMain implements UsageStoreClient {
  private readonly state = usageRequestState()
  readonly takesHistory: boolean
  constructor(private readonly store: UsageRequestStore & { close(): void }) { this.takesHistory = takesHistory(store) }
  request<K extends UsageStoreRequest['kind']>(request: Extract<UsageStoreRequest, { kind: K }>): UsageStoreAnswers[K] {
    return answerUsageRequest(this.store, request, this.state)
  }
  close(): void { this.store.close() }
}

/**
 * The usage store worker: two worker threads on one built file, each with its own connection to `usage.sqlite`. The
 * writer makes every write and the small reads that must see them, in the order asked. The reader answers the page's
 * reads, which can take a second on a large history, on a connection that only reads, so a prompt's selection never
 * waits behind one. Each starts when first asked; one that goes is started again for the next request.
 */
export class UsageStoreOnWorkers implements UsageStoreClient {
  readonly takesHistory = true
  private writer: UsageWorkerThread | undefined
  private reader: UsageWorkerThread | undefined
  private closed = false
  constructor(private readonly path: string, private readonly worker: string) {}

  request<K extends UsageStoreRequest['kind']>(request: Extract<UsageStoreRequest, { kind: K }>): Promise<UsageStoreAnswers[K]> {
    if (this.closed) return Promise.reject(new Error('Usage store is closed'))
    const role: UsageWorkerRole = request.kind === 'query' ? 'read' : 'write'
    let thread = role === 'read' ? this.reader : this.writer
    if (!thread?.live) {
      try { thread = UsageWorkerThread.start(this.path, this.worker, role) } catch (error) {
        console.warn('usage-store-worker-unavailable')
        return Promise.reject(error instanceof Error ? error : new Error('Usage store worker is unavailable'))
      }
      if (role === 'read') this.reader = thread
      else this.writer = thread
    }
    return thread.request(request) as Promise<UsageStoreAnswers[K]>
  }

  /** The reader is let go at once; the writer gets what is left of `CLOSE_LIMIT_MS` to finish what was asked, then closes. */
  close(): void {
    if (this.closed) return
    this.closed = true
    const deadline = performance.now() + CLOSE_LIMIT_MS
    this.reader?.stop(0)
    if (this.writer) {
      if (!this.writer.drain(deadline - performance.now())) console.warn('usage-store-close-timed-out')
      this.writer.stop(Math.max(0, deadline - performance.now()))
    }
  }
}

interface Waiting { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }

/** One worker thread and the requests it has not answered yet. */
class UsageWorkerThread {
  private readonly pending = new Map<number, Waiting>()
  private nextId = 1
  private gone = false
  private stopping = false

  private constructor(private readonly worker: Worker, private readonly port: MessagePort, private readonly control: Int32Array) {
    port.on('message', (message: UsageWorkerAnswer) => { this.heard(message) })
    port.unref()
  }

  static start(path: string, file: string, role: UsageWorkerRole): UsageWorkerThread {
    const control = new Int32Array(new SharedArrayBuffer(USAGE_WORKER_CONTROL.SLOTS * Int32Array.BYTES_PER_ELEMENT))
    const { port1, port2 } = new MessageChannel()
    const workerData: UsageWorkerData = { path, role, control: control.buffer as SharedArrayBuffer, port: port2 }
    let worker: Worker
    try { worker = new Worker(file, { workerData, transferList: [port2], stdout: false, stderr: false }) } catch (error) {
      port1.close()
      throw error
    }
    const thread = new UsageWorkerThread(worker, port1, control)
    worker.on('error', () => { thread.lose() })
    worker.on('exit', () => { thread.lose() })
    worker.unref()
    return thread
  }

  get live(): boolean { return !this.gone && !this.stopping }

  request(request: UsageStoreRequest): Promise<unknown> {
    if (!this.live) return Promise.reject(new Error('Usage store worker stopped'))
    const id = this.nextId++
    // Kept from being collected with nothing else to do while a request is unanswered, so its answer arrives.
    this.port.ref()
    const answered = new Promise<unknown>((resolve, reject) => { this.pending.set(id, { resolve, reject }) })
    this.port.postMessage({ kind: 'request', id, request } satisfies UsageWorkerMessage)
    return answered
  }

  /**
   * Waits, receiving each answer here rather than on the event loop, until every request asked has been answered: for
   * quitting, which cannot wait for a task. Answers whether it finished in time.
   */
  drain(limitMs: number): boolean {
    const deadline = performance.now() + Math.max(0, limitMs)
    while (this.pending.size) {
      const received = receiveMessageOnPort(this.port)
      if (received) { this.heard(received.message as UsageWorkerAnswer); continue }
      if (this.gone || Atomics.load(this.control, USAGE_WORKER_CONTROL.LIFE) === USAGE_WORKER_LIFE.STOPPED) { this.lose(); return true }
      if (performance.now() >= deadline) return false
      Atomics.wait(this.control, USAGE_WORKER_CONTROL.DONE, Atomics.load(this.control, USAGE_WORKER_CONTROL.DONE), 50)
    }
    return true
  }

  /** Asks the worker to close its connection and waits for it at most `limitMs`; what it had not answered fails. */
  stop(limitMs: number): void {
    if (this.stopping || this.gone) return
    this.stopping = true
    if (Atomics.load(this.control, USAGE_WORKER_CONTROL.LIFE) !== USAGE_WORKER_LIFE.STOPPED) {
      this.port.postMessage({ kind: 'stop' } satisfies UsageWorkerMessage)
      const deadline = performance.now() + limitMs
      while (Atomics.load(this.control, USAGE_WORKER_CONTROL.LIFE) !== USAGE_WORKER_LIFE.STOPPED && performance.now() < deadline) {
        Atomics.wait(this.control, USAGE_WORKER_CONTROL.LIFE, Atomics.load(this.control, USAGE_WORKER_CONTROL.LIFE), Math.min(50, Math.max(1, deadline - performance.now())))
      }
    }
    this.end(new Error('Usage store worker stopped'))
  }

  private heard(answer: UsageWorkerAnswer): void {
    const waiting = this.pending.get(answer.id)
    if (!waiting) return
    this.pending.delete(answer.id)
    if (!this.pending.size && this.live) this.port.unref()
    if ('error' in answer) waiting.reject(Object.assign(new Error(answer.error.message), { name: answer.error.name }))
    else waiting.resolve(answer.value)
  }

  /** The worker went without being asked to stop: what it answered first is heard, and the rest fails. */
  private lose(): void {
    if (this.gone) return
    if (!this.stopping) console.warn('usage-store-worker-lost')
    this.end(new Error('Usage store worker stopped'))
  }

  private end(error: Error): void {
    if (this.gone) return
    for (;;) {
      let received
      try { received = receiveMessageOnPort(this.port) } catch { break }
      if (!received) break
      this.heard(received.message as UsageWorkerAnswer)
    }
    this.gone = true
    const unanswered = [...this.pending.values()]
    this.pending.clear()
    try { this.port.close() } catch { /* Already closed. */ }
    void this.worker.terminate().catch(() => undefined)
    for (const waiting of unanswered) waiting.reject(error)
  }
}
