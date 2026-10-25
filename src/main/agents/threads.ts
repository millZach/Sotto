import type { BrowserAgentTools } from './browserAgentServer'
import type { ScopedThreadTools } from './threadToolServer'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentHostSnapshot, AgentThread, ProviderId } from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { ActivitySubscriptionOptions, AgentHost, AgentHostCommand, AgentHostResult, AgentSkillScope, RestoredThreadHistory, ShortTextPrompt, ThreadHistorySource, ThreadHostEvent, ThreadReadPurpose, ThreadSessionDraft, ThreadLaunchProfiles, ThreadForkRequest, WorkerRoleSource } from './host'
import { asActivityPublication, ownBuiltRecord, subscribeActivitySnapshots } from './activitySnapshots'
import { ThreadChangesPublisher, ThreadMap, threadChangesBetween, type ActivityChangesListener, type ActivityChangesSubscription, type AgentHostChanges,
  type ThreadChangeSet } from './threadChanges'
import type { UsageQuotaRead, UsageTokenObservation } from '../../shared/usageDashboard'
import { isUsageHistoryThreadId, mappedSink, type UsageHistorySink } from './usageHistory/sink'

const bindingSchema = z.object({
  threadId: z.string().min(1), provider: z.string().min(1), sessionId: z.string().min(1),
  projectId: z.string().min(1), createdAt: z.string().datetime(),
})
export type ThreadBinding = z.infer<typeof bindingSchema>
const registrySchema = z.object({ bindings: z.array(bindingSchema) })

function sessionKey(provider: string, sessionId: string): string { return JSON.stringify([provider, sessionId]) }

/** Local identity authority. Load before discovery; flush before persisting references to new IDs. */
export class ThreadRegistry {
  private readonly store: AtomicJsonStore<z.infer<typeof registrySchema>>
  private readonly threads = new Map<string, ThreadBinding>()
  private readonly sessions = new Map<string, ThreadBinding>()
  private loading: Promise<void> | undefined
  private pending: Promise<void> | undefined
  private dirty = false
  private ready = false

  constructor(directory: string) {
    this.store = new AtomicJsonStore(join(directory, 'threads.json'), registrySchema.parse, () => ({ bindings: [] }))
  }

  /** True once the durable bindings are in memory; events arriving earlier must not mint IDs. */
  get loaded(): boolean { return this.ready }

  load(): Promise<void> {
    this.loading ??= (async () => {
      const { bindings } = await this.store.read()
      // Duplicate rows are dropped, first wins; refusing the file would re-mint every thread.
      for (const binding of bindings) {
        if (!this.threads.has(binding.threadId) && !this.sessions.has(sessionKey(binding.provider, binding.sessionId))) this.put(binding)
      }
      this.ready = true
    })().catch(error => { this.loading = undefined; throw error })
    return this.loading
  }

  bySession(provider: string, sessionId: string): ThreadBinding | undefined {
    const binding = this.sessions.get(sessionKey(provider, sessionId))
    return binding ? { ...binding } : undefined
  }
  byThread(threadId: string): ThreadBinding | undefined {
    const binding = this.threads.get(threadId)
    return binding ? { ...binding } : undefined
  }
  all(): ThreadBinding[] { return [...this.threads.values()].map(binding => ({ ...binding })) }

  bind(provider: string, sessionId: string, projectId: string): ThreadBinding {
    const existing = this.bySession(provider, sessionId)
    return this.reserve(existing?.threadId ?? randomUUID(), provider, sessionId, projectId)
  }

  reserve(threadId: string, provider: string, sessionId: string, projectId: string): ThreadBinding {
    const existing = this.byThread(threadId)
    const session = this.bySession(provider, sessionId)
    if ((existing && (existing.provider !== provider || existing.sessionId !== sessionId)) ||
      (session && session.threadId !== threadId)) throw new Error('This thread already belongs to another provider session. Refresh and select it again.')
    if (existing?.projectId === projectId) return existing
    // No validation here: this runs inside provider event listeners, which must not throw.
    const binding: ThreadBinding = { threadId, provider, sessionId, projectId, createdAt: existing?.createdAt ?? new Date().toISOString() }
    this.put(binding)
    this.dirty = true
    this.scheduleWrite()
    return { ...binding }
  }

  private put(binding: ThreadBinding): void {
    this.threads.set(binding.threadId, binding)
    this.sessions.set(sessionKey(binding.provider, binding.sessionId), binding)
  }

  private scheduleWrite(): Promise<void> {
    if (this.pending) return this.pending
    // A microtask batches synchronous discoveries; changes during a write get a subsequent write.
    this.pending = Promise.resolve().then(async () => {
      try {
        await this.load()
        while (this.dirty) {
          this.dirty = false
          try { await this.store.write({ bindings: this.all() }) }
          catch (error) { this.dirty = true; throw error }
        }
      } finally { this.pending = undefined }
    })
    // Events cannot await persistence. Keep failed writes dirty so the next async path retries.
    void this.pending.catch(() => undefined)
    return this.pending
  }

  async flush(): Promise<void> {
    while (this.pending || this.dirty) await (this.pending ?? this.scheduleWrite())
  }
}

/**
 * One form of the wrapper's thread changes (with history from events or without): the adapter's changes as this wrapper
 * received them, and what it handed on for each of the adapter's records.
 */
interface WrappedChanges {
  readonly publisher: ThreadChangesPublisher
  /** The adapter's records by its own session IDs, as its publications built them. */
  readonly incoming: ThreadMap
  /** The adapter's publications applied to `incoming` and not yet handed on: the next build reads and clears them. */
  readonly pending: AgentHostChanges[]
  /** Per provider session: the adapter's record last handed on, and the record under Sotto's ID it became. */
  outputs: Map<string, { readonly input: AgentThread; readonly output: AgentThread }>
  subscription: ActivityChangesSubscription | undefined
  /** Set once nothing here subscribes to the form, so a publication the adapter was already delivering is dropped. */
  stopped: boolean
}

/** Sotto-owned thread IDs around a provider adapter; provider session IDs never cross this boundary. */
export class SottoThreadHost implements AgentHost {
  private launchProfiles: ThreadLaunchProfiles | undefined
  useLaunchProfiles(profiles: ThreadLaunchProfiles): void {
    this.launchProfiles = profiles
    this.inner.useLaunchProfiles?.({ profileFor: async sessionId => {
      await this.registry.load()
      const threadId = this.threadFor(sessionId)
      return threadId ? profiles.profileFor(threadId) : undefined
    } })
  }
  profileRefusalHandler(threadId: string) {
    const binding = this.registry.byThread(threadId)
    const sessionId = binding?.provider === this.provider ? binding.sessionId : this.unbound.get(threadId)
    return sessionId ? this.inner.profileRefusalHandler?.(sessionId) : undefined
  }
  /** Undefined until something says what it is looking at; a connection never invents a watched set. */
  private observed: readonly string[] | undefined
  /** Per Sotto thread with no binding yet: the session ID an early start used, which its first send then reserves. */
  private readonly unbound = new Map<string, string>()

  /** Thread events cross this boundary the way snapshots do: under Sotto's own thread ID (ADR-0002).
   * Absent when the adapter inside publishes none, so the host above knows to read its arrays instead. */
  readonly subscribeEvents?: (listener: (event: ThreadHostEvent) => void) => () => void
  readonly subscribeUsage?: (listener: (record: UsageTokenObservation) => void) => () => void
  readonly visitUsage?: (threadId: string, visitor: (record: UsageTokenObservation) => void) => void
  readonly readProviderQuota?: (providerId: ProviderId, refresh: boolean, background?: boolean) => Promise<UsageQuotaRead>
  readonly scanUsageHistory?: (sink: UsageHistorySink, signal: AbortSignal) => Promise<void>
  /**
   * The adapter's thread changes under Sotto's thread IDs (ADR-0016, #925), beside its activity snapshots. Absent when
   * the adapter inside publishes none, so the host above knows to work them out from the snapshots instead.
   */
  readonly subscribeActivityChanges?: (listener: ActivityChangesListener, options?: ActivitySubscriptionOptions) => ActivityChangesSubscription
  private readonly changeForms = new Map<boolean, WrappedChanges>()

  constructor(private readonly provider: string, private readonly inner: AgentHost,
    private readonly registry: ThreadRegistry) {
    if (inner.subscribeActivityChanges) this.subscribeActivityChanges = (listener, options) => this.watchChanges(listener, options)
    const events = inner.subscribeEvents?.bind(inner)
    if (events) this.subscribeEvents = listener => events(({ threadId, event }) => {
      if (!this.registry.loaded) return
      const binding = this.registry.bySession(this.provider, threadId)
      if (binding) listener({ threadId: binding.threadId, event })
    })
    if (inner.subscribeUsage) this.subscribeUsage = listener => {
      let off: (() => void) | undefined, cancelled = false
      const install = (): void => {
        if (cancelled) return
        off = inner.subscribeUsage!(record => {
          const binding = this.registry.bySession(this.provider, record.threadId)
          if (binding) listener({ ...record, threadId: binding.threadId })
        })
      }
      if (this.registry.loaded) install()
      else void this.registry.load().then(install).catch(() => undefined)
      return () => { cancelled = true; off?.() }
    }
    if (inner.visitUsage) this.visitUsage = (threadId, visitor) => {
      if (!this.registry.loaded) return
      const binding = this.registry.byThread(threadId)
      if (binding?.provider === this.provider) inner.visitUsage!(binding.sessionId, record => visitor({ ...record, threadId }))
    }
    if (inner.readProviderQuota) this.readProviderQuota = (providerId, refresh, background) => inner.readProviderQuota!(providerId, refresh, background)
    if (inner.scanUsageHistory) this.scanUsageHistory = async (sink, signal) => {
      await this.registry.load()
      // Owned sessions come up under their Sotto thread; one with no binding has no thread to count under.
      // A session Sotto does not own already carries its namespaced identity and passes through.
      const translate = <T extends { threadId: string }>(record: T): T | undefined => {
        if (isUsageHistoryThreadId(record.threadId)) return record
        const binding = this.registry.bySession(this.provider, record.threadId)
        return binding ? { ...record, threadId: binding.threadId } : undefined
      }
      await inner.scanUsageHistory!(mappedSink(sink, { token: translate, prompt: translate }), signal)
    }
  }

  useBrowserTools(tools: BrowserAgentTools): void {
    const thread = (sessionId: string): string => {
      const threadId = this.threadFor(sessionId)
      if (!threadId) throw new Error('This thread is not known to Sotto. Refresh and select it again.')
      return threadId
    }
    this.inner.useBrowserTools?.({ definitions: tools.definitions,
      call: (id, name, args) => tools.call(thread(id), name, args),
      mcpServer: id => tools.mcpServer(thread(id)),
    })
  }
  /**
   * A native session asks for Sotto's scoped tools by its own ID; each server answers for its Sotto thread alone,
   * bound or held by an early start until its first send.
   */
  useThreadTools(tools: readonly ScopedThreadTools[]): void {
    this.inner.useThreadTools?.(tools.map(entry => ({ name: entry.name, definitions: entry.definitions,
      ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }),
      mcpServer: async (id: string) => {
        const threadId = this.threadFor(id)
        return threadId ? entry.mcpServer(threadId) : undefined
      },
    })))
  }
  /** The role table names no thread or session, so it passes through as it is. */
  useWorkerRoles(roles: WorkerRoleSource): void { this.inner.useWorkerRoles?.(roles) }
  async connect(): Promise<AgentHostSnapshot> {
    await this.registry.load()
    if (this.observed) this.observeThreads(this.observed)
    return this.read(() => this.inner.connect())
  }

  async snapshot(): Promise<AgentHostSnapshot> {
    await this.registry.load()
    return this.read(() => this.inner.snapshot())
  }

  async listThreadSkills(threadId: string, forceReload = false, scope?: AgentSkillScope) {
    await this.registry.load()
    await this.launchProfiles?.profileFor(threadId)
    const binding = this.registry.byThread(threadId)
    if (binding && binding.provider !== this.provider || !binding && scope?.providerId !== this.provider) throw new Error('This thread is not known to this provider.')
    if (!this.inner.listThreadSkills) throw new Error('This provider does not expose skills.')
    const catalog = await this.inner.listThreadSkills(binding?.sessionId ?? threadId, forceReload, binding ? undefined : scope)
    return { ...catalog, threadId }
  }
  rollbackCapability(threadId: string) {
    const binding = this.registry.byThread(threadId)
    return binding?.provider === this.provider && this.inner.rollbackCapability
      ? this.inner.rollbackCapability(binding.sessionId) : { supported: false, reason: 'This native provider has no verified conversation rewind for this thread.' }
  }
  async rollbackThread(threadId: string, removedUserMessages: number, expectedUserMessageIds: readonly string[]): Promise<AgentHostResult> {
    await this.registry.load()
    const binding = this.registry.byThread(threadId)
    if (!binding || binding.provider !== this.provider || !this.inner.rollbackThread) throw new Error('Native conversation rewind is unavailable for this thread.')
    return this.inner.rollbackThread(binding.sessionId, removedUserMessages, expectedUserMessageIds)
  }
  /**
   * A cleared thread is forgotten by the adapter under its own session ID (ADR-0126). The binding stays: it holds IDs
   * alone, and a provider that reports the session again is then read under the same Sotto thread ID, which the
   * workspace's cleared list refuses, rather than under a new one that would bring the thread back.
   */
  async forgetThread(threadId: string): Promise<void> {
    if (!this.inner.forgetThread) return
    await this.registry.load()
    const binding = this.registry.byThread(threadId)
    if (!binding || binding.provider !== this.provider) return
    await this.inner.forgetThread(binding.sessionId)
  }
  /**
   * A fork names its source by Sotto thread ID (#1028). Both threads reach the adapter by its own session IDs: the new
   * thread's is reserved and saved before the adapter asks the provider, as creation's is, so the copy is bound to it.
   */
  async forkThread(request: ThreadForkRequest): Promise<AgentHostResult> {
    await this.registry.load()
    const source = this.registry.byThread(request.source.threadId)
    if (!source || source.provider !== this.provider || !this.inner.forkThread) throw new Error('This thread is not known to Sotto. Refresh and select it again.')
    const existing = this.registry.byThread(request.threadId)
    const binding = this.registry.reserve(request.threadId, this.provider, existing?.sessionId ?? randomUUID(), source.projectId)
    await this.registry.flush()
    const result = await this.inner.forkThread({ ...request, threadId: binding.sessionId, source: { ...request.source, threadId: source.sessionId } })
    await this.registry.flush().catch(() => { console.warn('registry-flush-deferred') })
    return result
  }
  /** Cached history reaches the adapter under the provider's own session ID, the way every read does. */
  async restoreThreadHistory(threads: readonly RestoredThreadHistory[]): Promise<void> {
    if (!this.inner.restoreThreadHistory) return
    await this.registry.load()
    const mine = threads.flatMap(thread => {
      const binding = this.registry.byThread(thread.threadId)
      return binding?.provider === this.provider ? [{ ...thread, threadId: binding.sessionId }] : []
    })
    if (mine.length) await this.inner.restoreThreadHistory(mine)
  }
  async refreshThread(threadId: string, purpose?: ThreadReadPurpose): Promise<AgentHostSnapshot> {
    await this.registry.load()
    const binding = this.registry.byThread(threadId)
    if (!binding || binding.provider !== this.provider) throw new Error('This thread is not known to Sotto. Refresh and select it again.')
    // The read after an accepted send is answered from what the adapter holds, and the caller reads whole when the
    // echo is not in it (#765). In the app the workspace above answers it first; this is where a stack without one
    // does, so that it reads the thread whole once at most, as it did before.
    if (purpose?.afterSend) return this.read(() => this.inner.snapshot())
    return this.read(() => this.inner.refreshThread?.(binding.sessionId, purpose) ?? this.inner.snapshot())
  }

  /** The adapter is asked about its own session; a thread bound to another provider is none of its business. */
  async writeShortText(threadId: string, prompt: ShortTextPrompt, signal?: AbortSignal): Promise<string | null> {
    if (!this.inner.writeShortText) return null
    await this.registry.load()
    const binding = this.registry.byThread(threadId)
    if (!binding || binding.provider !== this.provider) return null
    return this.inner.writeShortText(binding.sessionId, prompt, signal)
  }

  /** Bindings for newly discovered threads reach disk before the coordinator can persist a reference to them. */
  private async read(source: () => Promise<AgentHostSnapshot>): Promise<AgentHostSnapshot> {
    const snapshot = this.mapSnapshot(await source())
    // A failed write stays dirty and is retried by the next async path; reading state must not fail on it.
    await this.registry.flush().catch(() => undefined)
    return snapshot
  }

  private mapSnapshot(snapshot: AgentHostSnapshot): AgentHostSnapshot {
    return { ...snapshot, threads: snapshot.threads.map(thread => ({ ...thread,
      id: this.registry.bind(this.provider, thread.id, thread.projectId).threadId,
    })) }
  }

  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void {
    // An event before the durable bindings are loaded would mint IDs the disk then contradicts.
    // Nothing is lost: connect and snapshot deliver the same state once loaded.
    return this.inner.subscribe(snapshot => { if (this.registry.loaded) listener(this.mapSnapshot(snapshot)) })
  }
  subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void {
    return subscribeActivitySnapshots(this.inner, snapshot => {
      if (this.registry.loaded) listener(asActivityPublication(this.mapSnapshot(snapshot), snapshot))
    }, options)
  }

  /**
   * The adapter's thread changes, with each record under its Sotto thread ID, bound as `mapSnapshot` binds it, and each
   * removal and placement naming Sotto's IDs. Each form is subscribed to the adapter once, while something here
   * subscribes to it. An adapter record handed on before comes out as the same record, so a publication that re-names an
   * unchanged thread carries nothing for it. As with the snapshots, nothing is handed on before the durable bindings are
   * loaded, and the first publication after they are is whole.
   */
  private watchChanges(listener: ActivityChangesListener, options?: ActivitySubscriptionOptions): ActivityChangesSubscription {
    const historyFromEvents = options?.historyFromEvents === true
    let form = this.changeForms.get(historyFromEvents)
    if (!form) {
      const created: WrappedChanges = { publisher: new ThreadChangesPublisher(), incoming: new ThreadMap({ verify: false }), pending: [], outputs: new Map(), subscription: undefined, stopped: false }
      this.changeForms.set(historyFromEvents, created)
      created.subscription = this.inner.subscribeActivityChanges!(changes => this.receive(created, changes), { historyFromEvents })
      form = created
    }
    const watched = form
    const subscription = watched.publisher.subscribe(listener, { historyFromEvents })
    const off = (() => {
      subscription()
      if (watched.publisher.size || this.changeForms.get(historyFromEvents) !== watched) return
      this.changeForms.delete(historyFromEvents)
      watched.stopped = true
      watched.subscription?.()
    }) as ActivityChangesSubscription
    off.resync = () => subscription.resync()
    return off
  }

  private receive(form: WrappedChanges, changes: AgentHostChanges): void {
    if (form.stopped) return
    const applied = form.incoming.apply(changes)
    if (applied === 'resync') { form.subscription?.resync(); return }
    // Before the bindings load, an adapter thread has no Sotto ID to go under. Its record waits in `incoming`, and the
    // first publication once they load is whole, since nothing was published to the form before it.
    if (applied === 'stale' || !this.registry.loaded) return
    form.pending.push(changes)
    form.publisher.publishChanges((_historyFromEvents, published) => this.wrappedChanges(form, published))
  }

  /**
   * What this form hands on, built when its publisher builds it rather than when it was asked for: a publication asked for
   * while another is being delivered builds afterwards, and then carries every adapter publication received by then.
   */
  private wrappedChanges(form: WrappedChanges, published: ThreadMap | undefined): ThreadChangeSet {
    const pending = form.pending.splice(0)
    if (!published || pending.some(changes => changes.whole)) {
      const outputs = new Map<string, { input: AgentThread; output: AgentThread }>()
      const upserts = form.incoming.threads().map(record => this.wrapped(form, record, outputs))
      form.outputs = outputs
      return { whole: true, upserts, removals: [], rest: form.incoming.rest! }
    }
    // One adapter publication translates exactly. Several, received while one of this wrapper's was being delivered, are
    // worked out from the whole view instead, which costs a comparison per thread and happens about never.
    if (pending.length > 1) return this.wrappedBetween(form, published)
    const [changes] = pending
    if (!changes) return { upserts: [], removals: [] }
    const removals: string[] = []
    for (const sessionId of changes.removals) {
      const held = form.outputs.get(sessionId)
      if (!held) continue
      form.outputs.delete(sessionId)
      removals.push(held.output.id)
    }
    const upserts = changes.upserts.map(record => this.wrapped(form, record))
    let placements: { id: string; beforeId: string | null }[] | undefined
    if (changes.placements?.length) {
      placements = []
      for (const placement of changes.placements) {
        const id = form.outputs.get(placement.id)?.output.id
        const beforeId = placement.beforeId === null ? null : form.outputs.get(placement.beforeId)?.output.id
        if (id === undefined || beforeId === undefined) return this.wrappedBetween(form, published)
        placements.push({ id, beforeId })
      }
    }
    return { upserts, removals, ...(placements ? { placements } : {}), ...(changes.rest ? { rest: changes.rest } : {}) }
  }

  private wrappedBetween(form: WrappedChanges, published: ThreadMap): ThreadChangeSet {
    const outputs = new Map<string, { input: AgentThread; output: AgentThread }>()
    const threads = form.incoming.threads().map(record => this.wrapped(form, record, outputs))
    form.outputs = outputs
    return threadChangesBetween(published, { ...form.incoming.rest!, threads })
  }

  /** An adapter record under its Sotto thread ID: the record handed on for it before when it has not changed since. */
  private wrapped(form: WrappedChanges, record: AgentThread, into = form.outputs): AgentThread {
    const held = form.outputs.get(record.id)
    if (held?.input === record) { into.set(record.id, held); return held.output }
    const output = ownBuiltRecord({ ...record, id: this.registry.bind(this.provider, record.id, record.projectId).threadId })
    into.set(record.id, { input: record, output })
    return output
  }

  /** The store answers about Sotto's thread; the adapter inside asks about its own session. */
  useThreadHistory(source: ThreadHistorySource): void {
    this.inner.useThreadHistory?.({
      messageIdentities: sessionId => {
        const binding = this.registry.bySession(this.provider, sessionId)
        return binding ? source.messageIdentities(binding.threadId) : []
      },
      ...(source.message ? { message: (sessionId: string, messageId: string) => {
        const binding = this.registry.bySession(this.provider, sessionId)
        return binding ? source.message?.(binding.threadId, messageId) : undefined
      } } : {}),
      ...(source.activity ? { activity: (sessionId: string, activityId: string, historyEpoch?: string) => {
        const binding = this.registry.bySession(this.provider, sessionId)
        return binding ? source.activity?.(binding.threadId, activityId, historyEpoch) : undefined
      } } : {}),
      ...(source.activities ? { activities: (sessionId: string, historyEpoch?: string) => {
        const binding = this.registry.bySession(this.provider, sessionId)
        return binding ? source.activities?.(binding.threadId, historyEpoch) : undefined
      } } : {}),
      ...(source.hasActivities ? { hasActivities: (sessionId: string, historyEpoch?: string) => {
        const binding = this.registry.bySession(this.provider, sessionId)
        return binding ? source.hasActivities?.(binding.threadId, historyEpoch) === true : false
      } } : {}),
      ...(source.flushEvents ? { flushEvents: (sessionId: string) => {
        const binding = this.registry.bySession(this.provider, sessionId)
        return binding ? source.flushEvents?.(binding.threadId) === true : true
      } } : {}),
    })
  }

  async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    return this.executeGuarded(command)
  }
  executeFromWatcher(command: AgentHostCommand, guard: () => void): Promise<AgentHostResult> {
    return this.executeGuarded(command, guard)
  }
  private async executeGuarded(command: AgentHostCommand, guard?: () => void): Promise<AgentHostResult> {
    await this.registry.load()
    guard?.()
    let translated = command
    if (command.type === 'create-thread') {
      const existing = this.registry.byThread(command.threadId)
      const binding = this.registry.reserve(command.threadId, this.provider,
        existing?.sessionId ?? this.unbound.get(command.threadId) ?? randomUUID(), command.projectId)
      this.unbound.delete(command.threadId)
      translated = { ...command, threadId: binding.sessionId }
    } else if ('threadId' in command) {
      const binding = this.registry.byThread(command.threadId)
      if (!binding || binding.provider !== this.provider) {
        throw new Error('This thread is not known to Sotto. Refresh and select it again.')
      }
      translated = { ...command, threadId: binding.sessionId }
    }
    // Persist creation identity before dispatch, including when the provider loses its acknowledgment.
    await this.registry.flush()
    guard?.()
    const result = await (guard && this.inner.executeFromWatcher ? this.inner.executeFromWatcher(translated, guard) : this.inner.execute(translated))
    // A settings change's snapshot crosses this boundary the way every snapshot does: under Sotto's thread IDs.
    const mapped = result.snapshot ? { ...result, snapshot: this.mapSnapshot(result.snapshot) } : result
    await this.registry.flush().catch(() => { console.warn('registry-flush-deferred') })
    return mapped
  }

  /**
   * Early start (#769), under the provider's own session ID. A thread with no binding yet (its first send has not
   * created it) is given the session ID that send will reserve, held in memory only: nothing is bound or saved
   * until the send, so a draft that is never sent leaves nothing on disk. The adapter lets every early start go at
   * disconnect, and the IDs held for them go with it.
   */
  async startThreadSession(threadId: string, draft?: ThreadSessionDraft): Promise<void> {
    if (!this.inner.startThreadSession) return
    await this.registry.load()
    const binding = this.registry.byThread(threadId)
    if (binding) { if (binding.provider === this.provider) await this.inner.startThreadSession(binding.sessionId); return }
    if (!draft) return
    let sessionId = this.unbound.get(threadId)
    if (!sessionId) { sessionId = randomUUID(); this.unbound.set(threadId, sessionId) }
    await this.inner.startThreadSession(sessionId, draft)
  }
  /** The Sotto thread a provider session belongs to: its binding, or the early start that holds it until its first send. */
  private threadFor(sessionId: string): string | undefined {
    const bound = this.registry.bySession(this.provider, sessionId)?.threadId
    if (bound) return bound
    for (const [threadId, id] of this.unbound) if (id === sessionId) return threadId
    return undefined
  }
  observeThreads(threadIds: readonly string[]): void {
    this.observed = [...threadIds]
    this.inner.observeThreads?.(threadIds.flatMap(threadId => {
      const binding = this.registry.byThread(threadId)
      return binding?.provider === this.provider ? [binding.sessionId] : []
    }))
  }

  disconnect(): void { this.unbound.clear(); this.inner.disconnect() }

  async clientUpdated(): Promise<void> { await this.inner.clientUpdated?.(this.provider as ProviderId) }
}
