/**
 * The usage store worker (ADR-0083, October 27 amendment): a worker thread with its own connection to `usage.sqlite`,
 * answering in the order asked what Usage asks of its store (`usageStoreRequests.ts`). Main starts it twice from this
 * one file: the writer, the only connection that writes, which opens and migrates the file; and the reader, which
 * answers the page's reads on a connection that only reads. It is built as a file of its own beside the bundle that
 * starts it, with what it imports inside it.
 */
import type { MessagePort } from 'node:worker_threads'
import { workerData } from 'node:worker_threads'
import { UsageStore } from './usageStore'
import { answerUsageRequest, usageRequestState } from './usageStoreRequests'
import { USAGE_WORKER_CONTROL, USAGE_WORKER_LIFE, type UsageWorkerAnswer, type UsageWorkerData, type UsageWorkerMessage } from './usageStoreWorkerProtocol'

const data = workerData as UsageWorkerData
const control = new Int32Array(data.control)
const port: MessagePort = data.port
const store = new UsageStore(data.path)
const state = usageRequestState()

function finish(): void {
  Atomics.store(control, USAGE_WORKER_CONTROL.LIFE, USAGE_WORKER_LIFE.STOPPED)
  Atomics.notify(control, USAGE_WORKER_CONTROL.LIFE)
}

/** A worker that ends says so, so a main waiting for it stops waiting. */
process.on('exit', finish)

port.on('message', (message: UsageWorkerMessage) => {
  if (message.kind === 'stop') {
    try { store.close() } finally { port.close(); finish() }
    return
  }
  // Answered strictly in the order asked: a later write never lands under an earlier one.
  let reply: UsageWorkerAnswer
  try {
    // Opened at the first request, and again after a failed open: the writer creates and migrates the file first. A
    // failure to open fails the request as a failed write would, so what is queued behind it is refused the same way.
    reply = { id: message.id, value: answerUsageRequest(store, message.request, state, () => { store.open(data.role === 'read' ? { reader: true } : {}) }) }
  } catch (error) {
    reply = { id: message.id, error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: 'Usage store failed' } }
  }
  port.postMessage(reply)
  Atomics.add(control, USAGE_WORKER_CONTROL.DONE, 1)
  Atomics.notify(control, USAGE_WORKER_CONTROL.DONE)
})
