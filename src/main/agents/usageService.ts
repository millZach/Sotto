import { join } from 'node:path'
import type { AgentHostSnapshot } from '../../shared/agents'
import {
  usageLocalClearRequestSchema, usageLocalHostReadSchema, usageLocalQuerySchema, usageQuotaReadSchema,
  usageTokenObservationSchema, usagePromptSubmissionSchema, usagePromptIdentitySchema,
  isUsageProviderId, USAGE_LIMIT_PROVIDERS,
  type UsageLimitProviderId, type UsageLocalClearRequest, type UsageLocalClearResult, type UsageLocalHostRead, type UsageLocalQuery,
  type UsagePromptSubmission, type UsageQuotaRead, type UsageTokenObservation,
  type UsageMetadata, type UsagePromptIdentity, type UsageProviderId,
} from '../../shared/usageDashboard'
import type { AgentHost } from './host'
import { subscribeActivitySnapshots } from './activitySnapshots'
import { ThreadMap, type ActivityChangesSubscription, type AgentHostChanges } from './threadChanges'
import { unavailableProviderQuota } from './providerQuota'
import { USAGE_PENDING_RECONCILIATION_BATCH_MAX } from './usageStore'
import { UsageStoreOnMain, usageStoreClient, type Maybe, type UsageStoreClient } from './usageStoreClient'
import type { UsageFlushOutcome, UsageHistoryWrite, UsagePromptWrite, UsageRequestStore } from './usageStoreRequests'
import { UsageHistoryImporter, type UsageHistoryStore } from './usageHistory/importer'
import { UsageReadPending, UsageVisitUnfinished } from './usageVisits'

/** OpenCode reports no account limits, so it is never asked for any (ADR-0087). */
const LIMIT_PROVIDERS: readonly UsageLimitProviderId[] = USAGE_LIMIT_PROVIDERS
const BUFFER_MAX = 4_096
const FLUSH_MS = 1_000
const RETRY_MS = 5_000
const RECONCILE_MS = 5_000
/** How long a read waits for account limits before answering with the last ones it has; the read goes on behind it. */
const QUOTA_READ_WAIT_MS = 6_000
/**
 * The most threads whose usage one task reads, and how long a task goes on beginning another before it lets main do
 * something else. One task read every thread's usage when a provider connected, now each one's ledger file too (#1937):
 * 434 ms on forge for a folder the size of the owner's, 291 threads. There a thread of 190 requests takes about 1.2 ms, and
 * a flush of the store's full buffer, which a thread's rows can set off, about 6 ms more, so three threads leave room for
 * one in about 8 ms. A slower computer stops sooner, once 5 ms have passed.
 */
const VISITS_AT_ONCE = 3
const VISIT_TASK_MS = 5
/** How long a thread whose saved requests are still being read waits before Usage visits it again. */
const VISIT_PENDING_MS = 25
/** The providers whose thread usage is a ledger's view (`NativeUsage`), which changes whenever the ledger's rows do. */
const MARKED_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex', 'grok'])
type HostThread = AgentHostSnapshot['threads'][number]
/**
 * A thread's usage as its host shows it, to tell whether its saved rows changed since Usage last read them (#1937): its
 * revision, which every change to one of its requests moves on, a model corrected without a token changing among them,
 * with the time it was last reported, its rate versions, its totals and whether any of it is partial. Undefined for a
 * thread whose usage is not a ledger's view, or is one with no revision yet: such a thread is read at every start.
 */
function visitMark(thread: HostThread): string | undefined {
  if (!thread.providerId || !MARKED_PROVIDERS.has(thread.providerId)) return undefined
  const usage = thread.usage
  // A ledger an earlier build kept has no revision to tell a corrected request by: it is read, and given one then.
  if (usage && usage.revision === undefined) return undefined
  return JSON.stringify(usage ? [usage.revision, usage.updatedAt, usage.rateVersions, usage.total ?? null, usage.partial] : [null])
}

/** Numeric-only callbacks at the coordinator's durable intent and exact echo boundaries. */
export interface UsagePromptRecorder {
  /**
   * Keeps the prompt's original selection, handed to the store without waiting: on the usage store worker it is written
   * just after the send, and always ahead of the echo that accepts it (ADR-0078, October 27 amendment).
   */
  submitPrompt(submission: UsagePromptSubmission): void
  acceptPrompt(threadId: string, messageId: string): void
  discardPrompt(threadId: string, messageId: string): void
}

type Store = UsageRequestStore & { close(): void }

/** One flush handed to the store and not yet answered: what it carried, so what did not commit is buffered again. */
interface Flight {
  readonly tokens: readonly (readonly [string, UsageTokenObservation])[]
  readonly prompts: readonly (readonly [string, UsagePromptWrite])[]
  /** Threads whose saved rows were read, with their marks, written after the rows. */
  readonly visits: readonly (readonly [string, string])[]
  readonly seed: boolean
  landed?: Promise<void>
}

/** What failed flushes left unsaved, held until every flush behind them has been answered. */
interface Unsaved { tokens: (readonly [string, UsageTokenObservation])[]; prompts: (readonly [string, UsagePromptWrite])[]; visits: (readonly [string, string])[]; seed: boolean }

/** Created only by an owning host whose startup Usage answer is on. Never sends a provider prompt. */
export class UsageService implements UsagePromptRecorder {
  private readonly client: UsageStoreClient
  private readonly tokens = new Map<string, UsageTokenObservation>()
  private readonly prompts = new Map<string, UsagePromptWrite>()
  /** Flushes handed to the store and not yet answered, oldest first. The store answers them in this order. */
  private readonly flights: Flight[] = []
  private unsaved: Unsaved | undefined
  /** The next flush follows one that failed, so the store takes it again (`UsageFlush.retry`). */
  private retry = false
  private historyPasses = 0
  private readonly quotas = new Map<UsageLimitProviderId, UsageQuotaRead>()
  /** Where in the order refreshes began the newest refresh to answer for each provider began. */
  private readonly quotaStarted = new Map<UsageLimitProviderId, number>()
  private quotaStarts = 0
  private readonly visited = new Set<string>()
  /** Threads whose usage is to be read, by ID, read a few per task in the order they came. */
  private readonly visits = new Map<string, HostThread>()
  private visitTimer: ReturnType<typeof setImmediate> | undefined
  /** Reads and clears waiting for every queued thread to be read first. */
  private readonly visitWaiters: (() => void)[] = []
  /** Each thread's mark as its saved rows were last read, from the store, once it has answered; until then nothing is read. */
  private marks: Map<string, string> | undefined
  /** Marks of threads read since the last flush, written once the rows they gave are. */
  private readonly markWrites = new Map<string, string>()
  /** Records lost to a full buffer or a bad shape: a thread read while one is lost gets no mark, so it is read again. */
  private dropped = 0
  /** Threads passed over on their marks this run, with the mark: one whose usage moves on is queued again. */
  private readonly accepted = new Map<string, string>()
  /** Threads whose saved requests were still being read when Usage came to them, visited again shortly. */
  private readonly pendingVisits = new Map<string, HostThread>()
  private pendingTimer: ReturnType<typeof setTimeout> | undefined
  /** The thread whose rows are being visited a chunk a task, gone on with before any other, and what its visit began with. */
  private active: { readonly thread: HostThread; readonly mark: string | undefined; readonly dropped: number } | undefined
  /** Threads whose usage could not be read: each change reads them again, as every snapshot read every thread not yet read. */
  private readonly unread = new Set<string>()
  private readonly connected = new Set<UsageProviderId>()
  private readonly subscriptions: (() => void)[] = []
  private readonly refreshing = new Map<UsageLimitProviderId, Promise<UsageQuotaRead>>()
  /** Refreshes Usage made on its own, which may be answered from a recent reading, so Read again never joins one. */
  private readonly backgroundRefreshing = new Map<UsageLimitProviderId, Promise<UsageQuotaRead>>()
  private readonly reading = new Map<UsageLimitProviderId, Promise<UsageQuotaRead>>()
  private history: UsageHistoryImporter | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined
  private reconciliation: { after?: UsagePromptIdentity; through: UsagePromptIdentity } | undefined
  private reconciliationRequested = true
  private reconciling = false
  private started = false
  private receivedSnapshot = false
  private opened = false
  /** The store opening on the worker; every request asked meanwhile waits behind it there. */
  private opening: Promise<void> | undefined
  private failed = false
  private lost = false
  private seedPending = false
  private seedMarked = false
  private closed = false

  constructor(private readonly options: {
    directory: string; host: AgentHost; store?: Store
    /**
     * The built usage store worker (`usageStoreWorker.js`); null keeps the store on main. By default the one beside this
     * bundle where it is built, and on main where it is not, as under the test runner. A given `store` is on main.
     */
    worker?: string | null
    /** How the store is reached, for a test that answers requests later, as the worker does. Wins over `store` and `worker`. */
    client?: UsageStoreClient
    /** Exact role/ID evidence from the owning host's event store; reads no words. */
    hasAcceptedPrompt?: (threadId: string, messageId: string) => boolean
    /** Preferred bounded recovery lookup: one host flush and event scan for the whole batch. */
    acceptedPromptIdentities?: (identities: readonly UsagePromptIdentity[]) => readonly UsagePromptIdentity[]
    /** The clock a task of thread reads is timed by, in milliseconds, for a test; `performance.now` otherwise. */
    clock?: () => number
  }) {
    this.client = options.client ?? (options.store ? new UsageStoreOnMain(options.store) : usageStoreClient(join(options.directory, 'usage.sqlite'), options.worker))
  }

  start(): void {
    if (this.started || this.closed) return
    if (!this.open()) this.schedule(RETRY_MS)
    if (this.options.host.subscribeUsage) {
      this.subscriptions.push(this.options.host.subscribeUsage(record => this.observeTokens(record)))
    }
    const host = this.options.host
    if (host.subscribeActivityChanges) {
      // The host's thread changes (#925): a change reads only the threads it names, and those not yet read that could not be.
      const map = new ThreadMap({ verify: false })
      const subscription: ActivityChangesSubscription = host.subscribeActivityChanges(changes => this.acceptChanges(map, subscription, changes))
      this.subscriptions.push(subscription)
    } else this.subscriptions.push(subscribeActivitySnapshots(host, snapshot => this.acceptSnapshot(snapshot)))
    if (this.options.host.subscribeEvents) {
      this.subscriptions.push(this.options.host.subscribeEvents(({ threadId, event }) => {
        if ((event.kind === 'message-added' || event.kind === 'message-replaced') && event.message.role === 'user') {
          this.acceptPrompt(threadId, event.message.id)
        }
      }))
    }
    this.started = true
    this.reconcilePending()
    this.startHistory()
  }

  /** The owning host's provider records and Sotto's own stored prompts, read in the background (ADR-0083). */
  private startHistory(): void {
    const host = this.options.host
    if (!host.scanUsageHistory && !host.visitRecordedUserMessages) return
    if (!this.client.takesHistory) return
    this.history = new UsageHistoryImporter({
      source: {
        ...(host.scanUsageHistory ? { scanUsageHistory: (sink, signal) => host.scanUsageHistory!(sink, signal) } : {}),
        ...(host.visitRecordedUserMessages ? { visitRecordedUserMessages: (visitor, before) => host.visitRecordedUserMessages!(visitor, before) } : {}),
      },
      store: () => {
        // Live rows waiting in the buffer go first, so a history row never lands under a row about to replace it.
        this.flush()
        return this.opened && !this.closed ? this.historyStore() : undefined
      },
    })
    this.history.start()
  }

  /**
   * One history pass's way to the store. Its writes carry the pass, so once one of them fails the store refuses the
   * pass's later rows and cursors untried, wherever it answers them; `settled` lets the reader wait for the writer.
   */
  private historyStore(): UsageHistoryStore {
    const pass = ++this.historyPasses
    let unanswered = 0
    /** A row or cursor write of this pass failed: known before anyone waiting for the pass to settle is let go. */
    let failed = false
    const waiting: { ahead: number; resolve: () => void; reject: (error: Error) => void }[] = []
    const settledFailure = (): Error => new Error('Usage history could not be saved')
    const write = (history: UsageHistoryWrite): Maybe<null> => {
      const answer = this.client.request({ kind: 'history', pass, write: history })
      if (!(answer instanceof Promise)) return answer
      unanswered += 1
      return answer.then(value => value, (error: unknown) => {
        if (history.kind !== 'status') failed = true
        throw error
      }).finally(() => {
        unanswered -= 1
        for (const wait of waiting.filter(item => unanswered <= item.ahead)) {
          waiting.splice(waiting.indexOf(wait), 1)
          if (wait.ahead === 0 && failed) wait.reject(settledFailure()); else wait.resolve()
        }
      })
    }
    return {
      metadata: () => this.client.request({ kind: 'metadata' }),
      historyCursors: () => this.client.request({ kind: 'history-cursors' }),
      observeTokenBatch: batch => write({ kind: 'tokens', batch }),
      importPrompts: batch => write({ kind: 'prompts', batch }),
      setHistoryCursors: entries => write({ kind: 'cursors', entries }),
      setHistoryStatus: status => write({ kind: 'status', status }),
      settled: ahead => {
        if (unanswered > ahead) return new Promise<void>((resolve, reject) => { waiting.push({ ahead, resolve, reject }) })
        return ahead === 0 && failed ? Promise.reject(settledFailure()) : undefined
      },
    }
  }

  submitPrompt(input: UsagePromptSubmission): void {
    if (this.closed) return
    const parsed = usagePromptSubmissionSchema.safeParse(input)
    if (!parsed.success) { this.lost = true; return }
    const key = promptKey(parsed.data.threadId, parsed.data.messageId)
    const previous = this.prompts.get(key)
    if (previous?.submission === undefined) this.put(this.prompts, key, { ...previous, submission: parsed.data })
    // The original selection is flushed at once, ahead of the echo that accepts it. On main it is written before the
    // provider hears the prompt; on the worker just after, and a crash between the two can only count this prompt under
    // the wrong model (ADR-0078, October 27 amendment). Failure costs usage alone.
    this.flush()
  }

  acceptPrompt(threadId: string, messageId: string): void {
    if (this.closed) return
    if (!usagePromptIdentitySchema.safeParse({ threadId, messageId }).success) return
    const key = promptKey(threadId, messageId)
    this.put(this.prompts, key, { ...this.prompts.get(key), action: 'accept' })
    this.flush()
  }

  discardPrompt(threadId: string, messageId: string): void {
    if (this.closed) return
    if (!usagePromptIdentitySchema.safeParse({ threadId, messageId }).success) return
    const key = promptKey(threadId, messageId)
    if (this.prompts.get(key)?.action === 'accept') { this.flush(); return }
    this.put(this.prompts, key, { ...this.prompts.get(key), action: 'discard' })
    this.flush()
  }

  async read(input: UsageLocalQuery = {}): Promise<UsageLocalHostRead> {
    const query = usageLocalQuerySchema.parse(input)
    // Every thread queued to be read before the read is read, and everything buffered is written before the store reads.
    const queued = this.visitsRead()
    if (queued) await queued
    const flushed = this.flushing()
    this.history?.poke()
    // Limits and activity are read together: a slow provider never holds the history back.
    const quotas = this.readQuotas(query.providerIds, false)
    let activity: UsageLocalHostRead['activity']
    try {
      await flushed
      if (!this.opened) throw new Error('Usage store is unavailable')
      activity = await this.client.request({ kind: 'query', query })
    } catch {
      this.failed = true
      this.schedule(RETRY_MS)
      return { status: 'error', quotas: await quotas, persistence: 'failed' }
    }
    return usageLocalHostReadSchema.parse({ status: 'ready', activity, quotas: await quotas,
      persistence: this.failed || this.lost || this.unread.size ? 'failed' : 'saved' })
  }

  /** `background` is a refresh Usage made on its own when it opened; Read again leaves it out and always reads afresh. */
  async refresh(providerIds?: readonly UsageProviderId[], background = false): Promise<UsageLocalHostRead> {
    const quotas = await this.readQuotas(providerIds, true, background)
    return { status: 'ready', quotas, persistence: this.failed || this.lost || this.unread.size ? 'failed' : 'saved' }
  }

  async clear(input: UsageLocalClearRequest): Promise<UsageLocalClearResult> {
    const request = usageLocalClearRequestSchema.parse(input)
    const queued = this.visitsRead()
    if (queued) await queued
    await this.flushing()
    // Everything buffered before Clear was pressed is written, or Clear is refused. What arrives after it is written
    // after the clear, as the store always ordered them.
    // A thread whose rows could not be read is not saved either: Clear waits until it is (#1937).
    if (!this.opened || this.failed || this.unsaved || this.unread.size) throw new Error('Usage could not be saved')
    // The revision includes every flushed row. A changed revision requires another user confirmation.
    const result = await this.client.request({ kind: 'clear', expectedRevision: request.expectedRevision })
    if (result.status === 'cleared') this.lost = false
    if (result.status === 'cleared') {
      this.reconciliation = undefined
      clearTimeout(this.reconcileTimer); this.reconcileTimer = undefined
    }
    return result
  }

  /** Flushes numeric retries only. It has no path back to provider execution. */
  flush(): void { void this.flushing() }

  /**
   * Hands everything buffered to the store as one flush, behind any still unanswered. Answers undefined once that is
   * answered, as on main, and otherwise with when it will be; never rejects.
   */
  private flushing(): Promise<void> | undefined {
    if (this.closed) return undefined
    clearTimeout(this.timer); this.timer = undefined
    if (!this.open()) { this.schedule(RETRY_MS); return undefined }
    // A flush that failed is still being answered, with those behind it: the retry follows once they all are.
    if (this.unsaved) return this.flights.at(-1)?.landed
    // The legacy seed is marked only with no thread left to read, whose rows it would otherwise go without.
    const seed = this.seedPending && !this.visitsOutstanding()
    if (!this.tokens.size && !this.prompts.size && !this.markWrites.size && !seed) {
      const last = this.flights.at(-1)?.landed ?? this.opening
      if (last) return last
      // Nothing to write and nothing unanswered: as a flush that wrote nothing always did.
      this.failed = false
      if (this.started && this.reconciliationRequested) this.reconcilePending()
      return undefined
    }
    const flight: Flight = { tokens: [...this.tokens], prompts: [...this.prompts], visits: [...this.markWrites], seed }
    this.tokens.clear(); this.prompts.clear(); this.markWrites.clear()
    if (seed) this.seedPending = false
    const retry = this.retry
    this.retry = false
    this.flights.push(flight)
    const failed: UsageFlushOutcome = { tokens: 0, prompts: 0, seed: false, failed: true }
    let answer: Maybe<UsageFlushOutcome>
    try {
      answer = this.client.request({ kind: 'flush', flush: { retry, seed: flight.seed, tokens: flight.tokens.map(([, record]) => record),
        ...(flight.visits.length ? { visits: flight.visits.map(([threadId, mark]) => ({ threadId, mark })) } : {}),
        prompts: flight.prompts.map(([key, write]) => { const [threadId, messageId] = parsePromptKey(key); return { threadId, messageId, write } }) } })
    } catch { answer = failed }
    if (!(answer instanceof Promise)) { this.landed(flight, answer); return undefined }
    flight.landed = answer.then(outcome => { this.landed(flight, outcome) }, () => { this.landed(flight, failed) })
    return flight.landed
  }

  /**
   * A flush answered. What did not commit, and everything in the flushes behind it, which the store refuses untried, is
   * held until the last of them is answered, then buffered again ahead of what arrived since, for the retry.
   */
  private landed(flight: Flight, outcome: UsageFlushOutcome): void {
    this.flights.splice(this.flights.indexOf(flight), 1)
    if (outcome.seed) this.seedMarked = true
    if (outcome.visits !== undefined) for (const [threadId, mark] of flight.visits) this.marks?.set(threadId, mark)
    if (outcome.failed || outcome.skipped) {
      this.failed = true
      const unsaved = this.unsaved ??= { tokens: [], prompts: [], visits: [], seed: false }
      unsaved.tokens.push(...flight.tokens.slice(outcome.tokens))
      unsaved.prompts.push(...flight.prompts.slice(outcome.prompts))
      if (outcome.visits === undefined) unsaved.visits.push(...flight.visits)
      unsaved.seed ||= flight.seed && !outcome.seed
    } else if (!this.unsaved) this.failed = false
    if (this.flights.length) return
    if (this.unsaved) this.rebuffer(this.unsaved)
    if (this.started && this.reconciliationRequested) this.reconcilePending()
  }

  /** Puts what failed back in the buffer in the order it was first buffered, with what arrived since laid over it. */
  private rebuffer(unsaved: Unsaved): void {
    this.unsaved = undefined
    const tokens = new Map(unsaved.tokens)
    for (const [key, record] of this.tokens) tokens.set(key, record)
    // One prompt can be in several failed flushes, its submission in one and its echo in the next: each is laid over
    // the one before, in order, so neither the selection nor the acceptance is lost.
    const prompts = new Map<string, UsagePromptWrite>()
    for (const [key, write] of [...unsaved.prompts, ...this.prompts]) prompts.set(key, laterPromptWrite(prompts.get(key), write))
    this.tokens.clear(); for (const [key, record] of tokens) this.tokens.set(key, record)
    this.prompts.clear(); for (const [key, write] of prompts) this.prompts.set(key, write)
    const visits = new Map(unsaved.visits)
    for (const [threadId, mark] of this.markWrites) visits.set(threadId, mark)
    this.markWrites.clear(); for (const [threadId, mark] of visits) this.markWrites.set(threadId, mark)
    this.seedPending ||= unsaved.seed
    this.retry = true
    if (this.closed) return
    clearTimeout(this.timer); this.timer = undefined
    this.schedule(RETRY_MS)
  }

  close(): void {
    if (this.closed) return
    for (const unsubscribe of this.subscriptions.splice(0)) { try { unsubscribe() } catch { /* Collection is optional. */ } }
    this.history?.close(); this.history = undefined
    this.flush()
    this.closed = true
    clearTimeout(this.timer); this.timer = undefined
    clearTimeout(this.reconcileTimer); this.reconcileTimer = undefined
    clearImmediate(this.visitTimer); this.visitTimer = undefined
    clearTimeout(this.pendingTimer); this.pendingTimer = undefined
    this.visits.clear(); this.pendingVisits.clear(); this.active = undefined
    for (const resolve of this.visitWaiters.splice(0)) resolve()
    // On the worker this waits, a bounded while, for every write asked for to commit.
    try { this.client.close() } catch { /* Usage never holds provider shutdown open. */ }
    this.opened = false
  }

  /** Whether the store is open, or opening on the worker, where every request asked meanwhile waits behind the opening. */
  private open(): boolean {
    if (this.opened || this.opening) return true
    if (this.closed) return false
    let answer: Maybe<UsageMetadata>
    try { answer = this.client.request({ kind: 'open' }) } catch { this.failed = true; this.markless(); return false }
    if (!(answer instanceof Promise)) { this.opened = true; this.seedMarked = answer.legacySeedCompleted; this.readMarks(); return true }
    this.opening = answer.then(metadata => {
      this.opening = undefined
      if (this.closed) return
      this.opened = true; this.seedMarked = metadata.legacySeedCompleted
      this.readMarks()
      if (this.started) this.reconcilePending()
    }, () => {
      this.opening = undefined
      this.failed = true
      this.markless()
      this.schedule(RETRY_MS)
    })
    return true
  }

  /** Each thread's mark as Usage last read its rows, asked once the store is open; the queued threads are read after it. */
  private readMarks(): void {
    if (this.marks !== undefined) return
    next(() => this.client.request({ kind: 'visit-marks' }), rows => {
      this.marks ??= new Map(rows.map(row => [row.threadId, row.mark]))
      this.visitQueued()
    }, () => { this.markless() })
  }

  /** With no marks to be had, every queued thread is read, as every start read them before marks. */
  private markless(): void {
    if (this.marks !== undefined) return
    this.marks = new Map()
    this.visitQueued()
  }

  private observeTokens(input: UsageTokenObservation): void {
    if (this.closed) return
    const parsed = usageTokenObservationSchema.safeParse(input)
    if (!parsed.success) { this.lost = true; this.dropped += 1; return }
    const record = parsed.data
    if (this.tokens.size >= BUFFER_MAX) this.flush()
    this.put(this.tokens, JSON.stringify([record.providerId, record.threadId, record.recordKey]), record)
    this.schedule(FLUSH_MS)
  }

  private acceptSnapshot(snapshot: AgentHostSnapshot): void {
    const firstSnapshot = !this.receivedSnapshot
    this.receivedSnapshot = true
    const previouslyConnected = new Set(this.connected)
    this.connected.clear()
    for (const provider of snapshot.providers ?? []) if (provider.connection === 'connected' && isUsageProviderId(provider.id)) this.connected.add(provider.id)
    if (!snapshot.providers && snapshot.connected) {
      for (const thread of snapshot.threads) if (isUsageProviderId(thread.providerId)) this.connected.add(thread.providerId)
      for (const model of snapshot.models) if (isUsageProviderId(model.providerId)) this.connected.add(model.providerId)
    }
    for (const thread of snapshot.threads) this.queueVisit(thread)
    // A thread whose read failed and that has gone since is no longer waited for.
    if (this.unread.size) { const present = new Set(snapshot.threads.map(thread => thread.id)); for (const id of this.unread) if (!present.has(id)) this.unread.delete(id) }
    if (this.started && (firstSnapshot || [...this.connected].some(provider => !previouslyConnected.has(provider)))) {
      this.reconciliationRequested = true
      this.reconcilePending()
    }
    this.visitQueued()
  }

  /**
   * One publication of the host's thread changes. A whole one, one carrying the rest of the snapshot, and one from a host
   * that names no providers are read whole, as every snapshot was: they can change which providers are connected, and so
   * which threads are read. Any other reads only the threads it upserted and those whose read failed, which is what reading
   * every thread again would have read.
   */
  private acceptChanges(map: ThreadMap, subscription: ActivityChangesSubscription, changes: AgentHostChanges): void {
    const applied = map.apply(changes)
    if (applied === 'resync') { subscription.resync(); return }
    if (applied === 'stale') return
    if (changes.whole || changes.rest !== undefined || !map.rest?.providers || !this.receivedSnapshot) {
      this.acceptSnapshot({ ...map.rest!, threads: map.threads() } as AgentHostSnapshot)
      return
    }
    for (const thread of changes.upserts) this.queueVisit(thread)
    for (const id of [...this.unread]) { const thread = map.get(id); if (thread) this.queueVisit(thread); else this.unread.delete(id) }
    this.visitQueued()
  }

  /** Queues a thread whose usage is not read yet; the queue is read a few threads per task (`visitBatch`). */
  private queueVisit(thread: HostThread): void {
    if (!this.options.host.visitUsage || this.visited.has(thread.id)) return
    const accepted = this.accepted.get(thread.id)
    if (accepted !== undefined && accepted === visitMark(thread)) return
    this.visits.set(thread.id, thread)
  }

  /**
   * Reads the queued threads in the tasks to come, or, once none is queued, marks the legacy seed for the next flush: never
   * with a thread still unread, whose rows the seed would then go without.
   */
  private visitQueued(): void {
    if (this.closed) return
    if (this.visits.size || this.active) {
      // The marks say which threads changed since their rows were last read; until the store answers, none is read.
      if (this.marks !== undefined) this.visitTimer ??= setImmediate(() => this.visitBatch())
      return
    }
    if (this.pendingVisits.size) return
    if (this.connected.size && !this.seedMarked) { this.seedPending = true; this.schedule(FLUSH_MS) }
    for (const resolve of this.visitWaiters.splice(0)) resolve()
  }

  /**
   * One task's share of the queue: at most `VISITS_AT_ONCE` threads, read or checked, and none begun once `VISIT_TASK_MS`
   * have passed. A thread of a connected provider whose mark is the one its rows were last read at is passed over unread:
   * nothing in them changed since. It is queued again should its usage move on this run.
   */
  private visitBatch(): void {
    this.visitTimer = undefined
    if (this.closed) return
    const clock = this.options.clock ?? (() => performance.now())
    const started = clock()
    let taken = 0
    for (;;) {
      // A thread whose rows are half visited goes first, a chunk a task.
      if (this.active) this.visit(this.active.thread, this.active.mark, this.active.dropped)
      else {
        const next = this.visits.entries().next()
        if (next.done) break
        const [id, thread] = next.value
        this.visits.delete(id)
        const mark = visitMark(thread)
        if (this.connectedFor(thread) && mark !== undefined && this.marks?.get(id) === mark) { this.accepted.set(id, mark); this.unread.delete(id) }
        else this.visit(thread, mark)
      }
      // A chunk of a long thread's rows is a task's worth on its own.
      if (this.active || ++taken >= VISITS_AT_ONCE || clock() - started >= VISIT_TASK_MS) break
    }
    this.visitQueued()
  }

  /** Whether any thread is queued, being read, mid-visit, or could not be read: the legacy seed waits for them all. */
  private visitsOutstanding(): boolean {
    return this.visits.size > 0 || this.pendingVisits.size > 0 || this.active !== undefined || this.unread.size > 0
  }

  /** Whether the thread's provider is one Usage reads and is connected; a thread naming none is its host's own. */
  private connectedFor(thread: HostThread): boolean {
    return !thread.providerId || isUsageProviderId(thread.providerId) && this.connected.has(thread.providerId)
  }

  /** Visits again, shortly, the threads whose saved requests were still being read. */
  private visitPendingSoon(): void {
    if (this.pendingTimer !== undefined || this.closed) return
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = undefined
      for (const [id, thread] of this.pendingVisits) if (!this.visits.has(id)) this.visits.set(id, thread)
      this.pendingVisits.clear()
      this.visitQueued()
    }, VISIT_PENDING_MS)
    this.pendingTimer.unref?.()
  }

  /** Once no thread is left queued to be read: at once when none is. */
  private visitsRead(): Promise<void> | undefined {
    if (this.closed || !this.visits.size && !this.pendingVisits.size && !this.active) return undefined
    return new Promise(resolve => { this.visitWaiters.push(resolve) })
  }

  /**
   * Reads a thread's usage once its provider is connected; a read that fails is tried again with the next publication.
   * A read that lost none of its rows leaves the thread's mark to be written after them.
   */
  private visit(thread: HostThread, mark?: string, dropped = this.dropped): void {
    this.active = undefined
    if (!this.options.host.visitUsage) return
    if (this.visited.has(thread.id) || !this.connectedFor(thread)) return
    try {
      this.options.host.visitUsage(thread.id, record => this.observeTokens(record))
      this.visited.add(thread.id)
      this.unread.delete(thread.id)
      this.accepted.delete(thread.id)
    } catch (error) {
      // More rows to come: gone on with in the next task. Reads, Clear and the seed wait for it.
      if (error instanceof UsageVisitUnfinished) { this.active = { thread, mark, dropped }; return }
      // Being read for a report: visited once that read lands, rather than read twice. Reads and Clear wait for it.
      if (error instanceof UsageReadPending) { this.pendingVisits.set(thread.id, thread); this.visitPendingSoon(); return }
      // Not read: read again with the next publication; until then Usage says it could not save, and Clear waits.
      this.failed = true; this.unread.add(thread.id); return
    }
    if (mark !== undefined && this.dropped === dropped) { this.markWrites.set(thread.id, mark); this.schedule(FLUSH_MS) }
  }

  private reconcilePending(): void {
    if (!this.opened || (!this.options.acceptedPromptIdentities && !this.options.hasAcceptedPrompt) || this.closed || this.reconciling) return
    this.reconciling = true
    const finish = (): void => {
      this.reconciling = false
      if (this.closed) return
      if ((this.reconciliation !== undefined || this.reconciliationRequested) && this.reconcileTimer === undefined) {
        this.reconcileTimer = setTimeout(() => { this.reconcileTimer = undefined; this.reconcilePending() }, RECONCILE_MS)
        this.reconcileTimer.unref?.()
      }
    }
    const fail = (): void => { this.failed = true; this.schedule(RETRY_MS); finish() }
    const batch = (): void => {
      const pass = this.reconciliation
      if (pass === undefined) { finish(); return }
      next(() => this.client.request({ kind: 'pending-identities', after: pass.after, through: pass.through }), identities => {
        try {
          const accepted = new Set((identities.length === 0 ? [] : this.options.acceptedPromptIdentities
            ? this.options.acceptedPromptIdentities(identities)
            : identities.filter(identity => this.options.hasAcceptedPrompt!(identity.threadId, identity.messageId)))
            .map(identity => promptKey(identity.threadId, identity.messageId)))
          for (const identity of identities) {
            if (accepted.has(promptKey(identity.threadId, identity.messageId))) this.acceptPrompt(identity.threadId, identity.messageId)
            pass.after = identity
          }
          const last = identities.at(-1)
          if (this.reconciliation === pass && (identities.length < USAGE_PENDING_RECONCILIATION_BATCH_MAX
            || (last?.threadId === pass.through.threadId && last.messageId === pass.through.messageId))) this.reconciliation = undefined
        } catch { fail(); return }
        finish()
      }, fail)
    }
    if (!this.reconciliationRequested) { batch(); return }
    next(() => this.client.request({ kind: 'pending-end' }), through => {
      this.reconciliation = through === undefined ? undefined : { through }
      this.reconciliationRequested = false
      batch()
    }, fail)
  }

  private async readQuotas(providerIds: readonly UsageProviderId[] | undefined, refresh: boolean, background = false): Promise<UsageQuotaRead[]> {
    const selected = LIMIT_PROVIDERS.filter(provider => providerIds === undefined || providerIds.includes(provider))
    return Promise.all(selected.map(async providerId => {
      if (!this.connected.has(providerId)) return unavailableProviderQuota(providerId, 'not-connected')
      if (!this.options.host.readProviderQuota) return unavailableProviderQuota(providerId, 'unsupported')
      const read = async (): Promise<UsageQuotaRead> => {
        // A refresh that began after this one and has already answered is newer news, and stands over this one (#1456).
        // A read of the last reading takes no place in that order: it answers at once with whatever the provider holds.
        const start = refresh ? ++this.quotaStarts : 0
        const newer = (): UsageQuotaRead | undefined => refresh && (this.quotaStarted.get(providerId) ?? 0) > start ? this.quotas.get(providerId) : undefined
        try {
          const host = this.options.host
          const quota = usageQuotaReadSchema.parse(await (background ? host.readProviderQuota!(providerId, true, true) : host.readProviderQuota!(providerId, refresh)))
          if (quota.providerId !== providerId) throw new Error('Usage provider does not match')
          const standing = newer()
          if (standing) return standing
          this.quotas.set(providerId, quota)
          if (refresh) this.quotaStarted.set(providerId, start)
          return quota
        } catch {
          const standing = newer()
          if (standing) return standing
          const previous = this.quotas.get(providerId)
          return { ...(previous ?? unavailableProviderQuota(providerId, 'read-failed')), status: 'error', reason: 'read-failed' }
        }
      }
      const inFlight = !refresh ? this.reading : background ? this.backgroundRefreshing : this.refreshing
      const existing = (background ? this.refreshing.get(providerId) : undefined) ?? inFlight.get(providerId)
      if (existing) return refresh ? existing : this.waitForQuota(providerId, existing)
      const pending = read().finally(() => { inFlight.delete(providerId) })
      inFlight.set(providerId, pending)
      return refresh ? pending : this.waitForQuota(providerId, pending)
    }))
  }

  /** A read answers with the last limits it has once a provider is slow; the reading still lands in the cache. */
  private async waitForQuota(providerId: UsageLimitProviderId, pending: Promise<UsageQuotaRead>): Promise<UsageQuotaRead> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), QUOTA_READ_WAIT_MS); timer.unref?.() })
    try { return await Promise.race([pending, late]) ?? this.quotas.get(providerId) ?? unavailableProviderQuota(providerId, 'not-read') }
    finally { clearTimeout(timer) }
  }

  private put<T>(buffer: Map<string, T>, key: string, value: T): void {
    if (!buffer.has(key) && buffer.size >= BUFFER_MAX) { this.lost = true; this.dropped += 1; return }
    buffer.set(key, value)
  }

  private schedule(delay: number): void {
    if (this.timer || this.closed) return
    this.timer = setTimeout(() => { this.timer = undefined; this.flush() }, delay)
    this.timer.unref?.()
  }
}

function promptKey(threadId: string, messageId: string): string { return JSON.stringify([threadId, messageId]) }
function parsePromptKey(key: string): [string, string] { return JSON.parse(key) as [string, string] }

/**
 * A prompt's writes that failed, with what arrived for it since laid over them, as if both had stayed buffered: the
 * first selection stands, and an accepted echo is never undone by a later refusal.
 */
function laterPromptWrite(earlier: UsagePromptWrite | undefined, later: UsagePromptWrite): UsagePromptWrite {
  if (earlier === undefined) return later
  const submission = earlier.submission ?? later.submission
  const action = earlier.action === 'accept' ? 'accept' : later.action ?? earlier.action
  return { ...(submission ? { submission } : {}), ...(action ? { action } : {}) }
}

/** Runs `then` with the answer, at once where the store answered in the call; `failed` with what it threw or rejected. */
function next<T>(ask: () => Maybe<T>, then: (value: T) => void, failed: () => void): void {
  let answer: Maybe<T>
  try { answer = ask() } catch { failed(); return }
  if (answer instanceof Promise) answer.then(then, failed)
  else then(answer)
}

