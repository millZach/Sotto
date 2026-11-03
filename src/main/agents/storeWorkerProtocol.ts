/**
 * What main and the store worker say to each other (#1457): the slots of the control array they share and the messages
 * on their port. `storeWorker.ts` is main's side and `threadStoreWorker.ts` the worker's; both read their protocol here,
 * and nothing here runs.
 */
import type { MessagePort } from 'node:worker_threads'
import type { AgentActivity } from '../../shared/agentActivity'
import type { ThreadStoreWrite } from './threadStoreWriter'

/**
 * The slots of the control array main and the worker share, and their values. STATE says whether a passive checkpoint
 * (RUNNING) or a RESTART (RESTARTING) runs. LIFE goes STARTING, then OPEN once the worker opened its connection, then
 * STOPPED once it has closed it or never will; STOPPING asks an open worker to close. APPLYING is the identity of the newest write the worker has begun, and DONE of the newest
 * it has answered; a read on main compares them with what it posted (`started`). RESTARTS and RESTARTS_BUSY count the
 * RESTARTs that put the whole log in the file and those that found a read on it, for a test or a measurement.
 */
export const CONTROL = { STATE: 0, LIFE: 1, RESTARTS: 2, RESTARTS_BUSY: 3, APPLYING: 4, DONE: 5, SLOTS: 6 } as const
export const CHECKPOINT = { IDLE: 0, RUNNING: 1, RESTARTING: 3 } as const
export const LIFE = { STARTING: 0, STOPPING: 1, STOPPED: 2, OPEN: 3 } as const

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

/**
 * A stored thread's activity read back (step 3 of docs/plans/store-worker.md): the worker reads it behind every write posted
 * before it, parses each row and checks it against the schema, and answers with its first piece; main asks for each piece
 * after that (`read-more`). Reads count apart from writes. The worker keeps the list it read as the thread's list at
 * `version`, so the thread's next save can be sent as what changed since it (#1645).
 */
export type WorkerRequest =
  | { readonly kind: 'write'; readonly id: number; readonly write: WireWrite }
  | { readonly kind: 'read-activities'; readonly read: number; readonly threadId: string; readonly version: number }
  | { readonly kind: 'read-more'; readonly read: number }
  | { readonly kind: 'stop' }

/**
 * How many records one piece of a read back carries. Receiving a list is a structured-clone read on main, and freezing it
 * walks every record. Measured on October 26, 2026 (`docs/perf/2026-10-26-store-worker-reads.md`), 2,000 records of about
 * 11 MB held main 14 ms at the median and 50 ms at worst in one piece, a frame or more, where a piece of 500 held it about
 * 2 ms. Main asks for each next piece from a task of its own, so the window paints between them.
 */
export const READ_PIECE_RECORDS = 500

/** The worker's answer to one write. `memory` says it took the file's words out and closed it for Keep local history. */
export interface WorkerAnswer {
  readonly id: number
  readonly failed: readonly string[]
  readonly error?: { readonly name: string; readonly message: string } | undefined
  readonly removed?: number | undefined
  readonly memory?: true | undefined
}

/**
 * The worker's answer to a read: the next piece of the thread's records in the order stored, `more` while pieces are left,
 * or no records when it could not read them.
 */
export interface WorkerReadAnswer {
  readonly read: number
  readonly activities?: readonly AgentActivity[] | undefined
  readonly more?: true | undefined
}

/** Whatever the worker posts main: a write's answer or a read's. */
export type WorkerMessage = WorkerAnswer | WorkerReadAnswer
