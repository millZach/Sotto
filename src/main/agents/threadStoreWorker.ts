/**
 * The store worker (#1457, ADR-0016's October 26 amendment): the one connection that writes `threads.sqlite`. Main posts
 * every write through `storeWorker.ts`, and this applies them in the order posted, in the transactions the store has
 * always used, and answers each with what committed. It also runs the log's checkpoints, which with no other writer never
 * wait for a save. It is built as a file of its own beside the bundle that starts it, with what it imports inside it.
 */
import type { MessagePort } from 'node:worker_threads'
import { workerData } from 'node:worker_threads'
import type { AgentActivity } from '../../shared/agentActivity'
import { immutableActivities, ownBuiltActivity } from './activitySnapshots'
import type { StoreWorkerData, WireActivityEntry, WireWrite, WorkerAnswer, WorkerRequest } from './storeWorker'
import { ThreadStore } from './threadStore'
import { applyWrite, writeThreads, type ActivityListEntry, type ThreadStoreWrite, type ThreadStoreWriteOutcome } from './threadStoreWriter'

// The control values `storeWorker.ts` describes, kept here so this file reads none of main's state.
const STATE = 0, LIFE = 1, RESTARTS = 2, RESTARTS_BUSY = 3, APPLYING = 4, DONE = 5
const IDLE = 0, RUNNING = 1, RESTARTING = 3
const STARTING = 0, STOPPED = 2, OPEN = 3

const data = workerData as StoreWorkerData
const control = new Int32Array(data.control)
const port: MessagePort = data.port

function finish(): void {
  Atomics.store(control, LIFE, STOPPED)
  Atomics.notify(control, LIFE)
}

/** A worker that dies says so, so a main waiting for it stops waiting. */
process.on('exit', finish)

/** The dormant threads Keep local history turning off leaves as they are, named by main with the write. */
let preserved: ReadonlySet<string> = new Set()
const store = new ThreadStore(data.path, threadId => preserved.has(threadId), null)

/** The list last committed for each thread, as sent: what the next list, sent as what changed, is rebuilt from. */
const lists = new Map<string, { readonly version: number; readonly activities: readonly AgentActivity[] }>()

class StaleList extends Error {
  constructor() { super('Thread activity was sent as changes to a list the store worker does not hold'); this.name = 'StaleList' }
}

/** One list as main sent it, rebuilt whole. Each record is frozen here, so a save of the same record later is known by identity. */
function rebuilt(entry: WireActivityEntry): ActivityListEntry {
  let activities: readonly AgentActivity[]
  if ('whole' in entry) activities = immutableActivities(entry.whole.map(ownBuiltActivity))
  else {
    const last = lists.get(entry.threadId)
    if (!last || last.version !== entry.base) throw new StaleList()
    if ('same' in entry) activities = last.activities
    else {
      const held = new Map(last.activities.map(activity => [activity.id, activity]))
      for (const activity of entry.changed) held.set(activity.id, ownBuiltActivity(activity))
      activities = immutableActivities(entry.ids.map(id => {
        const activity = held.get(id)
        if (!activity) throw new StaleList()
        return activity
      }))
    }
  }
  return { threadId: entry.threadId, activities, epoch: entry.epoch }
}

/** Rebuilds what changes could be, and fails the rest as a list the worker could not save. */
function activityWrite(entries: readonly WireActivityEntry[], write: (entries: readonly ActivityListEntry[]) => ThreadStoreWriteOutcome): ThreadStoreWriteOutcome {
  const whole: ActivityListEntry[] = []
  const stale = new Set<string>()
  for (const entry of entries) {
    try { whole.push(rebuilt(entry)) } catch { stale.add(entry.threadId); lists.delete(entry.threadId) }
  }
  const outcome = whole.length ? write(whole) : { failed: new Set<string>() }
  const failed = new Set([...outcome.failed, ...stale])
  for (const entry of entries) {
    const list = whole.find(item => item.threadId === entry.threadId)
    if (list && !failed.has(entry.threadId)) lists.set(entry.threadId, { version: entry.version, activities: list.activities })
    else lists.delete(entry.threadId)
  }
  if (stale.size === 0) return { ...outcome, failed }
  return { failed, error: outcome.error ?? new StaleList() }
}

/**
 * Keep local history turned off, the worker's half: each thread's activity identities are kept so a replay cannot bring
 * the records back, then the file's words are taken out, waiting for the disk, and the log cleared. The worker then
 * closes the file, and main carries on in memory.
 */
function historyOff(write: Extract<WireWrite, { kind: 'history-off' }>): ThreadStoreWriteOutcome & { memory?: true } {
  preserved = new Set(write.preserved)
  let error: unknown
  try {
    for (const thread of write.threads) store.redactActivityIdentities(thread.threadId, thread.activityIds ?? store.activityIds(thread.threadId))
  } catch (failure) { error = failure }
  try { store.redactAll() } catch (failure) {
    // The file still holds words: the worker keeps writing it, and Keep local history's maintenance asks again.
    return { failed: new Set(writeThreads(write)), error: failure }
  } finally { preserved = new Set() }
  lists.clear()
  store.close()
  return error === undefined ? { failed: new Set(), memory: true } : { failed: new Set(writeThreads(write)), error, memory: true }
}

function apply(write: WireWrite): ThreadStoreWriteOutcome & { memory?: true } {
  switch (write.kind) {
    case 'activities': return activityWrite(write.entries, entries => applyWrite(store, { kind: 'activities', entries }))
    case 'activity-list': return activityWrite([write.entry], ([entry]) => applyWrite(store, { kind: 'activity-list', flushed: write.flushed, ...entry! }))
    case 'history-off': return historyOff(write)
    case 'activities-released': lists.delete(write.threadId); return applyWrite(store, write)
    case 'forget': for (const threadId of write.threadIds) lists.delete(threadId); return applyWrite(store, write)
    default: return applyWrite(store, write as ThreadStoreWrite)
  }
}

function answer(id: number, outcome: ThreadStoreWriteOutcome & { memory?: true }): WorkerAnswer {
  const error = outcome.error === undefined ? undefined
    : outcome.error instanceof Error ? { name: outcome.error.name, message: outcome.error.message } : { name: 'Error', message: 'Thread history could not be saved' }
  return { id, failed: [...outcome.failed], ...(error ? { error } : {}), ...(outcome.removed === undefined ? {} : { removed: outcome.removed }), ...(outcome.memory ? { memory: true } : {}) }
}

// Main stopped it before it started: it never opens the file.
if (Atomics.compareExchange(control, LIFE, STARTING, OPEN) === STARTING) {
  try {
    store.open({ onMain: true, busyTimeoutMs: data.busyTimeoutMs })
    // The worker checkpoints the log itself, between its writes.
    store.connection().exec(`PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=${data.synchronous}`)
  } catch (error) {
    finish()
    throw error
  }
  const db = store.connection()
  const passive = db.prepare('PRAGMA wal_checkpoint(PASSIVE)')
  const restart = db.prepare('PRAGMA wal_checkpoint(RESTART)')
  const waitFor = (ms: number): void => { db.exec(`PRAGMA busy_timeout=${ms}`) }
  /**
   * A RESTART waits for every read on the log to move to the file. Main's reads are short, so it waits up to
   * `restartWaitMs` for them, then the writes go on and it tries again soon.
   */
  const restartOnce = (): boolean => {
    waitFor(data.restartWaitMs)
    try { return Number(restart.get()?.busy ?? 0) === 0 } finally { waitFor(data.busyTimeoutMs) }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let open = true
  const pass = (): void => {
    if (!open || Atomics.load(control, LIFE) !== OPEN) return
    let next = data.intervalMs
    Atomics.store(control, STATE, RUNNING)
    try {
      const done = passive.get()
      if (Number(done?.log ?? 0) >= data.restartPages) {
        Atomics.store(control, STATE, RESTARTING)
        if (restartOnce()) Atomics.add(control, RESTARTS, 1)
        else {
          Atomics.add(control, RESTARTS_BUSY, 1)
          next = data.restartRetryMs
        }
      }
    } catch {
      // A checkpoint that failed, as on a disk that went away, ends the worker; main then writes and checkpoints as SQLite does.
      Atomics.store(control, STATE, IDLE)
      try { store.close() } catch { /* The worker is ending either way. */ }
      process.exit(1)
    }
    Atomics.store(control, STATE, IDLE)
    Atomics.notify(control, STATE)
    timer = setTimeout(pass, next)
  }
  const stop = (): void => {
    open = false
    clearTimeout(timer)
    try { store.close() } finally { port.close(); finish() }
  }
  port.on('message', (request: WorkerRequest) => {
    if (request.kind === 'stop') { stop(); return }
    if (!open) return
    Atomics.store(control, APPLYING, request.id)
    let outcome: ThreadStoreWriteOutcome & { memory?: true }
    try { outcome = apply(request.write) } catch (error) { outcome = { failed: new Set(writeThreads(request.write as ThreadStoreWrite)), error } }
    port.postMessage(answer(request.id, outcome))
    Atomics.store(control, DONE, request.id)
    Atomics.notify(control, DONE)
    // Keep local history turned off: the file is closed, and main writes what follows in memory.
    if (outcome.memory) {
      open = false
      clearTimeout(timer)
      port.close()
      finish()
    }
  })
  timer = setTimeout(pass, data.intervalMs)
}
