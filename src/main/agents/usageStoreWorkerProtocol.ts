/**
 * What main and the usage store worker say to each other (ADR-0083, October 27 amendment): the slots of the control
 * array they share and the messages on their port. `usageStoreClient.ts` is main's side and `usageStoreWorker.ts` the
 * worker's; both read their protocol here, and nothing here runs.
 */
import type { MessagePort } from 'node:worker_threads'
import type { UsageStoreRequest } from './usageStoreRequests'

/**
 * LIFE goes OPEN while the worker takes requests and STOPPED once it has closed its connection or ended. DONE counts
 * the requests it has answered, so a main that cannot wait for a task, as when quitting, can wait on it instead.
 */
export const USAGE_WORKER_CONTROL = { LIFE: 0, DONE: 1, SLOTS: 2 } as const
export const USAGE_WORKER_LIFE = { OPEN: 0, STOPPED: 1 } as const

/** The writer makes every write; the reader answers the page's reads on a connection that only reads. */
export type UsageWorkerRole = 'write' | 'read'

export interface UsageWorkerData {
  readonly path: string
  readonly role: UsageWorkerRole
  readonly control: SharedArrayBuffer
  readonly port: MessagePort
}

export type UsageWorkerMessage =
  | { readonly kind: 'request'; readonly id: number; readonly request: UsageStoreRequest }
  | { readonly kind: 'stop' }

/** A request's answer, or what the store threw, by name and message alone. */
export type UsageWorkerAnswer =
  | { readonly id: number; readonly value: unknown }
  | { readonly id: number; readonly error: { readonly name: string; readonly message: string } }
