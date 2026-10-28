import {
  USAGE_HISTORY_BATCH_MAX, usageHistoryPromptSchema, usageTokenObservationSchema,
  type UsageHistoryCursor, type UsageHistoryPrompt, type UsageHistoryStatus, type UsageMetadata, type UsageTokenObservation,
} from '../../../shared/usageDashboard'
import { yieldToEventLoop, type UsageHistoryScan, type UsageHistorySink, type UsageRecordedUserMessage } from './sink'

/**
 * The store calls the importer makes (ADR-0083). Batches are written in one transaction each. On the usage store worker
 * (October 27 amendment) a write is handed over and answered later, as a promise that fails with it; on main it is
 * answered in the call.
 */
export interface UsageHistoryStore {
  metadata(): UsageMetadata | Promise<UsageMetadata>
  /** Every file's cursor, read once as a pass begins. */
  historyCursors(): readonly { key: string; cursor: UsageHistoryCursor }[] | Promise<readonly { key: string; cursor: UsageHistoryCursor }[]>
  observeTokenBatch(observations: UsageTokenObservation[]): unknown
  importPrompts(prompts: UsageHistoryPrompt[]): unknown
  setHistoryCursors(entries: { key: string; cursor: UsageHistoryCursor }[]): unknown
  setHistoryStatus(status: UsageHistoryStatus): unknown
  /**
   * Resolves once at most `ahead` of the writes handed over are unanswered; a store on main never has any. With `ahead`
   * 0 it rejects when any row or cursor write of the pass failed, so a pass that ends on a failed write is not complete.
   */
  settled?(ahead: number): Promise<void> | void
}

/** What the importer asks of the owning host: its providers' records and Sotto's own stored user messages. */
export interface UsageHistorySource {
  scanUsageHistory?: UsageHistoryScan
  /** Answers false when the thread store could not be read yet, so the import is tried again on a later pass. */
  visitRecordedUserMessages?(visitor: (message: UsageRecordedUserMessage) => void, before?: string): boolean | Promise<boolean>
}

/** First pass after start: late enough that startup and the first snapshot go first. */
export const USAGE_HISTORY_START_DELAY_MS = 5_000
/** A pass after that reads only what the clients added. */
export const USAGE_HISTORY_INTERVAL_MS = 5 * 60_000
/** A read of the Usage page starts a pass at most this often. */
export const USAGE_HISTORY_READ_GAP_MS = 30_000
/**
 * How many of a pass's batches may be on their way to the usage store worker at once. A first import reads hundreds of
 * thousands of rows; the reader waits here rather than hand the worker all of them at once.
 */
const HISTORY_WRITES_AHEAD = 4
/** Sotto's own stored prompts are imported once: the cursor key that says so. */
const SOTTO_PROMPTS_CURSOR = 'sotto:prompts'

/**
 * The history importer the Usage service runs on the owning host, behind the Usage Owl gate (ADR-0072). It never
 * blocks a send, a read or startup: each pass runs in the background, yields between batches and resumes from each
 * file's cursor. It logs nothing.
 */
export class UsageHistoryImporter {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private controller: AbortController | undefined
  private lastStarted = Number.NEGATIVE_INFINITY
  private earliest: string | undefined
  private closed = false

  constructor(private readonly options: {
    source: UsageHistorySource
    store: () => UsageHistoryStore | undefined
    now?: () => number
  }) {}

  start(): void {
    if (this.closed) return
    this.schedule(USAGE_HISTORY_START_DELAY_MS)
  }

  /** The Usage page read: start a pass in the background unless one ran a moment ago. */
  poke(): void {
    if (this.closed || this.running) return
    if (this.now() - this.lastStarted < USAGE_HISTORY_READ_GAP_MS) return
    void this.run()
  }

  /** One pass. A pass already running is the pass. */
  run(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.running ??= this.pass().finally(() => {
      this.running = undefined; this.controller = undefined
      this.schedule(USAGE_HISTORY_INTERVAL_MS)
    })
    return this.running
  }

  close(): void {
    this.closed = true
    clearTimeout(this.timer); this.timer = undefined
    this.controller?.abort()
  }

  private now(): number { return (this.options.now ?? Date.now)() }

  private schedule(delay: number): void {
    if (this.closed) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = undefined; void this.run() }, delay)
    this.timer.unref?.()
  }

  private async pass(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined
    const store = this.options.store()
    // A store not open yet, as while the usage store worker opens it, starts no pass, so the next read can start one.
    if (!store) return
    this.lastStarted = this.now()
    const { source } = this.options
    if (!source.scanUsageHistory && !source.visitRecordedUserMessages) {
      quietly(() => store.setHistoryStatus({ status: 'unavailable' }))
      return
    }
    const controller = new AbortController()
    this.controller = controller
    let metadata: UsageMetadata
    try { metadata = await store.metadata() } catch { return }
    this.earliest = earliestOf(this.earliest, metadata.history?.earliestAt)
    // Status is advisory; the rows are what count.
    const status = (value: UsageHistoryStatus['status']): void => quietly(() => store.setHistoryStatus({ status: value, ...(this.earliest ? { earliestAt: this.earliest } : {}),
      ...(value === 'complete' ? { scannedAt: new Date(this.now()).toISOString() } : metadata.history?.scannedAt ? { scannedAt: metadata.history.scannedAt } : {}) }))
    status('scanning')
    let failed = false
    const fail = (): void => { failed = true; controller.abort() }
    const cursors = new Map<string, UsageHistoryCursor>()
    try { for (const { key, cursor } of await store.historyCursors()) cursors.set(key, cursor) } catch { fail() }
    const sink: UsageHistorySink = {
      tokens: batch => {
        const valid: UsageTokenObservation[] = []
        for (const record of batch) {
          const parsed = usageTokenObservationSchema.safeParse(record)
          if (parsed.success && parsed.data.origin === 'history') { valid.push(parsed.data); this.earliest = earliestOf(this.earliest, parsed.data.at) }
        }
        for (let i = 0; i < valid.length; i += USAGE_HISTORY_BATCH_MAX) this.write(() => store.observeTokenBatch(valid.slice(i, i + USAGE_HISTORY_BATCH_MAX)), controller, fail)
      },
      prompts: batch => {
        const valid: UsageHistoryPrompt[] = []
        for (const record of batch) {
          const parsed = usageHistoryPromptSchema.safeParse(record)
          if (parsed.success) { valid.push(parsed.data); this.earliest = earliestOf(this.earliest, parsed.data.at) }
        }
        for (let i = 0; i < valid.length; i += USAGE_HISTORY_BATCH_MAX) this.write(() => store.importPrompts(valid.slice(i, i + USAGE_HISTORY_BATCH_MAX)), controller, fail)
      },
      cursor: key => cursors.get(key),
      // A cursor is saved only after its rows went in; after a failed write nothing moves on. On the worker, a write
      // that fails after this one was handed over refuses it there.
      setCursors: entries => {
        if (failed || controller.signal.aborted) return
        for (const entry of entries) cursors.set(entry.key, entry.cursor)
        this.write(() => store.setHistoryCursors([...entries]), controller, fail)
      },
      settled: () => store.settled?.(HISTORY_WRITES_AHEAD),
    }
    try {
      if (!controller.signal.aborted && source.scanUsageHistory) await source.scanUsageHistory(sink, controller.signal)
      if (!controller.signal.aborted && source.visitRecordedUserMessages) await this.importSottoPrompts(source, sink, metadata.startedAt)
    } catch { failed = true }
    // How the pass ended is known once every write it handed over is answered.
    try { await store.settled?.(0) } catch { failed = true }
    if (this.closed) return
    status(failed || controller.signal.aborted ? 'unavailable' : 'complete')
  }

  /** Sotto's stored user messages from before Usage began, once: later prompts arrive through their sends. */
  private async importSottoPrompts(source: UsageHistorySource, sink: UsageHistorySink, startedAt: string): Promise<void> {
    if (sink.cursor(SOTTO_PROMPTS_CURSOR)) return
    const prompts: UsageHistoryPrompt[] = []
    const read = await source.visitRecordedUserMessages!(message => {
      prompts.push({ providerId: message.providerId, threadId: message.threadId, messageId: message.messageId, modelId: message.modelId || 'unknown',
        at: message.at, kind: message.wakeUp ? 'wake-up' : 'user', source: 'sotto', client: 'sotto' })
    }, startedAt)
    if (!read) return
    for (let index = 0; index < prompts.length; index += USAGE_HISTORY_BATCH_MAX) {
      sink.prompts(prompts.slice(index, index + USAGE_HISTORY_BATCH_MAX))
      await sink.settled?.()
      await yieldToEventLoop()
    }
    sink.setCursors([{ key: SOTTO_PROMPTS_CURSOR, cursor: { size: 0, mtimeMs: 0, offset: prompts.length } }])
  }

  /** A write that fails, in the call or later on the worker, stops the pass. */
  private write(action: () => unknown, controller: AbortController, failed: () => void): void {
    if (controller.signal.aborted) return
    let answer: unknown
    try { answer = action() } catch { failed(); return }
    if (answer instanceof Promise) answer.catch(failed)
  }
}

/** A call whose failure, in the call or later, changes nothing. */
function quietly(action: () => unknown): void {
  let answer: unknown
  try { answer = action() } catch { return }
  if (answer instanceof Promise) answer.catch(() => undefined)
}

function earliestOf(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Date.parse(b) < Date.parse(a) ? b : a
}
