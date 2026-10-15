import { join } from 'node:path'
import type { AgentHostSnapshot } from '../../shared/agents'
import {
  usageLocalClearRequestSchema, usageLocalHostReadSchema, usageLocalQuerySchema, usageQuotaReadSchema,
  usageTokenObservationSchema, usagePromptSubmissionSchema, usagePromptIdentitySchema,
  isUsageProviderId,
  type UsageLocalClearRequest, type UsageLocalClearResult, type UsageLocalHostRead, type UsageLocalQuery,
  type UsagePromptSubmission, type UsageQuotaRead, type UsageTokenObservation,
  type UsagePromptIdentity, type UsageProviderId,
} from '../../shared/usageDashboard'
import type { AgentHost } from './host'
import { subscribeActivitySnapshots } from './activitySnapshots'
import { unavailableProviderQuota } from './providerQuota'
import { UsageStore, USAGE_PENDING_RECONCILIATION_BATCH_MAX } from './usageStore'
import { UsageHistoryImporter, type UsageHistoryStore } from './usageHistory/importer'

const PROVIDERS: readonly UsageProviderId[] = ['codex', 'claude', 'grok', 'devin']
const BUFFER_MAX = 4_096
const FLUSH_MS = 1_000
const RETRY_MS = 5_000
const RECONCILE_MS = 5_000
/** How long a read waits for account limits before answering with the last ones it has; the read goes on behind it. */
const QUOTA_READ_WAIT_MS = 6_000

/** Numeric-only callbacks at the coordinator's durable intent and exact echo boundaries. */
export interface UsagePromptRecorder {
  submitPrompt(submission: UsagePromptSubmission): void
  acceptPrompt(threadId: string, messageId: string): void
  discardPrompt(threadId: string, messageId: string): void
}

type Store = Pick<UsageStore, 'open' | 'close' | 'metadata' | 'observeTokens' | 'submitPrompt' | 'acceptSubmittedPrompt' |
  'discardSubmittedPrompt' | 'pendingPromptReconciliationEnd' | 'pendingPromptIdentities' | 'markLegacySeedCompleted' | 'query' | 'clear'>
  & Partial<Omit<UsageHistoryStore, 'metadata'>>
interface PromptWrite { submission?: UsagePromptSubmission; action?: 'accept' | 'discard' }

/** Created only by an owning host whose startup Usage answer is on. Never sends a provider prompt. */
export class UsageService implements UsagePromptRecorder {
  private readonly store: Store
  private readonly tokens = new Map<string, UsageTokenObservation>()
  private readonly prompts = new Map<string, PromptWrite>()
  private readonly quotas = new Map<UsageProviderId, UsageQuotaRead>()
  private readonly visited = new Set<string>()
  private readonly connected = new Set<UsageProviderId>()
  private readonly subscriptions: (() => void)[] = []
  private readonly refreshing = new Map<UsageProviderId, Promise<UsageQuotaRead>>()
  private readonly reading = new Map<UsageProviderId, Promise<UsageQuotaRead>>()
  private history: UsageHistoryImporter | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined
  private reconciliation: { after?: UsagePromptIdentity; through: UsagePromptIdentity } | undefined
  private reconciliationRequested = true
  private reconciling = false
  private started = false
  private receivedSnapshot = false
  private opened = false
  private failed = false
  private lost = false
  private seedPending = false
  private seedMarked = false
  private closed = false

  constructor(private readonly options: {
    directory: string; host: AgentHost; store?: Store
    /** Exact role/ID evidence from the owning host's event store; reads no words. */
    hasAcceptedPrompt?: (threadId: string, messageId: string) => boolean
    /** Preferred bounded recovery lookup: one host flush and event scan for the whole batch. */
    acceptedPromptIdentities?: (identities: readonly UsagePromptIdentity[]) => readonly UsagePromptIdentity[]
  }) { this.store = options.store ?? new UsageStore(join(options.directory, 'usage.sqlite')) }

  start(): void {
    if (this.started || this.closed) return
    if (!this.open()) this.schedule(RETRY_MS)
    if (this.options.host.subscribeUsage) {
      this.subscriptions.push(this.options.host.subscribeUsage(record => this.observeTokens(record)))
    }
    this.subscriptions.push(subscribeActivitySnapshots(this.options.host, snapshot => this.acceptSnapshot(snapshot)))
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
    if (!this.store.observeTokenBatch || !this.store.importPrompts || !this.store.historyCursor || !this.store.setHistoryCursors || !this.store.setHistoryStatus) return
    this.history = new UsageHistoryImporter({
      source: {
        ...(host.scanUsageHistory ? { scanUsageHistory: (sink, signal) => host.scanUsageHistory!(sink, signal) } : {}),
        ...(host.visitRecordedUserMessages ? { visitRecordedUserMessages: (visitor, before) => host.visitRecordedUserMessages!(visitor, before) } : {}),
      },
      store: () => {
        // Live rows waiting in the buffer go first, so a history row never lands under a row about to replace it.
        this.flush()
        return this.opened && !this.closed ? this.store as Store & UsageHistoryStore : undefined
      },
    })
    this.history.start()
  }

  submitPrompt(input: UsagePromptSubmission): void {
    if (this.closed) return
    const parsed = usagePromptSubmissionSchema.safeParse(input)
    if (!parsed.success) { this.lost = true; return }
    const key = promptKey(parsed.data.threadId, parsed.data.messageId)
    const previous = this.prompts.get(key)
    if (previous?.submission === undefined) this.put(this.prompts, key, { ...previous, submission: parsed.data })
    // Original selection must reach disk before native execute. Failure costs usage alone.
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
    this.flush()
    this.history?.poke()
    // Limits and activity are read together: a slow provider never holds the history back.
    const quotas = this.readQuotas(query.providerIds, false)
    let activity: UsageLocalHostRead['activity']
    try {
      if (!this.opened) throw new Error('Usage store is unavailable')
      activity = this.store.query(query)
    } catch {
      this.failed = true
      this.schedule(RETRY_MS)
      return { status: 'error', quotas: await quotas, persistence: 'failed' }
    }
    return usageLocalHostReadSchema.parse({ status: 'ready', activity, quotas: await quotas,
      persistence: this.failed || this.lost ? 'failed' : 'saved' })
  }

  async refresh(providerIds?: readonly UsageProviderId[]): Promise<UsageLocalHostRead> {
    const quotas = await this.readQuotas(providerIds, true)
    return { status: 'ready', quotas, persistence: this.failed || this.lost ? 'failed' : 'saved' }
  }

  async clear(input: UsageLocalClearRequest): Promise<UsageLocalClearResult> {
    const request = usageLocalClearRequestSchema.parse(input)
    this.flush()
    if (!this.opened || this.failed || this.tokens.size || this.prompts.size) throw new Error('Usage could not be saved')
    // The revision includes every flushed row. A changed revision requires another user confirmation.
    const result = this.store.clear(request.expectedRevision)
    if (result.status === 'cleared') this.lost = false
    if (result.status === 'cleared') {
      this.reconciliation = undefined
      clearTimeout(this.reconcileTimer); this.reconcileTimer = undefined
    }
    return result
  }

  /** Flushes numeric retries only. It has no path back to provider execution. */
  flush(): void {
    if (this.closed) return
    clearTimeout(this.timer); this.timer = undefined
    if (!this.open()) { this.schedule(RETRY_MS); return }
    try {
      for (const [key, record] of this.tokens) { this.store.observeTokens(record); this.tokens.delete(key) }
      for (const [key, write] of this.prompts) {
        if (write.submission) this.store.submitPrompt(write.submission)
        if (write.action === 'accept') this.store.acceptSubmittedPrompt(...parsePromptKey(key))
        else if (write.action === 'discard') this.store.discardSubmittedPrompt(...parsePromptKey(key))
        this.prompts.delete(key)
      }
      if (this.seedPending) { this.store.markLegacySeedCompleted(); this.seedPending = false; this.seedMarked = true }
      this.failed = false
    } catch { this.failed = true; this.schedule(RETRY_MS) }
    if (this.started && this.reconciliationRequested) this.reconcilePending()
  }

  close(): void {
    if (this.closed) return
    for (const unsubscribe of this.subscriptions.splice(0)) { try { unsubscribe() } catch { /* Collection is optional. */ } }
    this.history?.close(); this.history = undefined
    this.flush()
    this.closed = true
    clearTimeout(this.timer); this.timer = undefined
    clearTimeout(this.reconcileTimer); this.reconcileTimer = undefined
    try { this.store.close() } catch { /* Usage never holds provider shutdown open. */ }
    this.opened = false
  }

  private open(): boolean {
    if (this.opened) return true
    if (this.closed) return false
    try { this.store.open(); this.opened = true; this.seedMarked = this.store.metadata().legacySeedCompleted; return true }
    catch { this.failed = true; return false }
  }

  private observeTokens(input: UsageTokenObservation): void {
    if (this.closed) return
    const parsed = usageTokenObservationSchema.safeParse(input)
    if (!parsed.success) { this.lost = true; return }
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
    if (this.options.host.visitUsage) {
      for (const thread of snapshot.threads) {
        if (this.visited.has(thread.id) || (thread.providerId && (!isUsageProviderId(thread.providerId) || !this.connected.has(thread.providerId)))) continue
        try {
          this.options.host.visitUsage(thread.id, record => this.observeTokens(record))
          this.visited.add(thread.id)
        } catch { this.failed = true }
      }
    }
    if (this.started && (firstSnapshot || [...this.connected].some(provider => !previouslyConnected.has(provider)))) {
      this.reconciliationRequested = true
      this.reconcilePending()
    }
    if (this.connected.size && !this.seedMarked) { this.seedPending = true; this.schedule(FLUSH_MS) }
  }

  private reconcilePending(): void {
    if (!this.opened || (!this.options.acceptedPromptIdentities && !this.options.hasAcceptedPrompt) || this.closed || this.reconciling) return
    this.reconciling = true
    try {
      if (this.reconciliationRequested) {
        const through = this.store.pendingPromptReconciliationEnd()
        this.reconciliation = through === undefined ? undefined : { through }
        this.reconciliationRequested = false
      }
      const pass = this.reconciliation
      if (pass === undefined) return
      const identities = this.store.pendingPromptIdentities(pass.after, pass.through)
      const accepted = new Set((identities.length === 0 ? [] : this.options.acceptedPromptIdentities
        ? this.options.acceptedPromptIdentities(identities)
        : identities.filter(identity => this.options.hasAcceptedPrompt!(identity.threadId, identity.messageId)))
        .map(identity => promptKey(identity.threadId, identity.messageId)))
      for (const identity of identities) {
        if (accepted.has(promptKey(identity.threadId, identity.messageId))) this.acceptPrompt(identity.threadId, identity.messageId)
        pass.after = identity
      }
      const last = identities.at(-1)
      if (identities.length < USAGE_PENDING_RECONCILIATION_BATCH_MAX
        || (last?.threadId === pass.through.threadId && last.messageId === pass.through.messageId)) this.reconciliation = undefined
    } catch { this.failed = true; this.schedule(RETRY_MS) }
    finally { this.reconciling = false }
    if ((this.reconciliation !== undefined || this.reconciliationRequested) && this.reconcileTimer === undefined) {
      this.reconcileTimer = setTimeout(() => { this.reconcileTimer = undefined; this.reconcilePending() }, RECONCILE_MS)
      this.reconcileTimer.unref?.()
    }
  }

  private async readQuotas(providerIds: readonly UsageProviderId[] | undefined, refresh: boolean): Promise<UsageQuotaRead[]> {
    const selected = PROVIDERS.filter(provider => providerIds === undefined || providerIds.includes(provider))
    return Promise.all(selected.map(async providerId => {
      if (!this.connected.has(providerId)) return unavailableProviderQuota(providerId, 'not-connected')
      if (!this.options.host.readProviderQuota) return unavailableProviderQuota(providerId, 'unsupported')
      const read = async (): Promise<UsageQuotaRead> => {
        try {
          const quota = usageQuotaReadSchema.parse(await this.options.host.readProviderQuota!(providerId, refresh))
          if (quota.providerId !== providerId) throw new Error('Usage provider does not match')
          this.quotas.set(providerId, quota)
          return quota
        } catch {
          const previous = this.quotas.get(providerId)
          return { ...(previous ?? unavailableProviderQuota(providerId, 'read-failed')), status: 'error', reason: 'read-failed' }
        }
      }
      const inFlight = refresh ? this.refreshing : this.reading
      const existing = inFlight.get(providerId)
      if (existing) return refresh ? existing : this.waitForQuota(providerId, existing)
      const pending = read().finally(() => { inFlight.delete(providerId) })
      inFlight.set(providerId, pending)
      return refresh ? pending : this.waitForQuota(providerId, pending)
    }))
  }

  /** A read answers with the last limits it has once a provider is slow; the reading still lands in the cache. */
  private async waitForQuota(providerId: UsageProviderId, pending: Promise<UsageQuotaRead>): Promise<UsageQuotaRead> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), QUOTA_READ_WAIT_MS); timer.unref?.() })
    try { return await Promise.race([pending, late]) ?? this.quotas.get(providerId) ?? unavailableProviderQuota(providerId, 'not-read') }
    finally { clearTimeout(timer) }
  }

  private put<T>(buffer: Map<string, T>, key: string, value: T): void {
    if (!buffer.has(key) && buffer.size >= BUFFER_MAX) { this.lost = true; return }
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
