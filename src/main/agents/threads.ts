import type { BrowserAgentTools } from './browserAgentServer'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentHostSnapshot } from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { AgentHost, AgentHostCommand, AgentHostResult, AgentSkillScope, RestoredThreadHistory, ShortTextPrompt, ThreadHistorySource, ThreadHostEvent } from './host'
import { subscribeActivitySnapshots } from './activitySnapshots'

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

/** Sotto-owned thread IDs around a provider adapter; provider session IDs never cross this boundary. */
export class SottoThreadHost implements AgentHost {
  /** Undefined until something says what it is looking at; a connection never invents a watched set. */
  private observed: readonly string[] | undefined

  /** Thread events cross this boundary the way snapshots do: under Sotto's own thread ID (ADR-0002).
   * Absent when the adapter inside publishes none, so the host above knows to read its arrays instead. */
  readonly subscribeEvents?: (listener: (event: ThreadHostEvent) => void) => () => void

  constructor(private readonly provider: string, private readonly inner: AgentHost,
    private readonly registry: ThreadRegistry) {
    const events = inner.subscribeEvents?.bind(inner)
    if (events) this.subscribeEvents = listener => events(({ threadId, event }) => {
      if (!this.registry.loaded) return
      const binding = this.registry.bySession(this.provider, threadId)
      if (binding) listener({ threadId: binding.threadId, event })
    })
  }

  useBrowserTools(tools: BrowserAgentTools): void {
    const thread = (sessionId: string): string => {
      const binding = this.registry.bySession(this.provider, sessionId)
      if (!binding) throw new Error('This thread is not known to Sotto. Refresh and select it again.')
      return binding.threadId
    }
    this.inner.useBrowserTools?.({ definitions: tools.definitions,
      call: (id, name, args) => tools.call(thread(id), name, args),
      mcpServer: id => tools.mcpServer(thread(id)),
    })
  }
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
  async refreshThread(threadId: string): Promise<AgentHostSnapshot> {
    await this.registry.load()
    const binding = this.registry.byThread(threadId)
    if (!binding || binding.provider !== this.provider) throw new Error('This thread is not known to Sotto. Refresh and select it again.')
    return this.read(() => this.inner.refreshThread?.(binding.sessionId) ?? this.inner.snapshot())
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
  subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void): () => void {
    return subscribeActivitySnapshots(this.inner, snapshot => {
      if (this.registry.loaded) listener(this.mapSnapshot(snapshot))
    })
  }

  /** The store answers about Sotto's thread; the adapter inside asks about its own session. */
  useThreadHistory(source: ThreadHistorySource): void {
    this.inner.useThreadHistory?.({
      messageIdentities: sessionId => {
        const binding = this.registry.bySession(this.provider, sessionId)
        return binding ? source.messageIdentities(binding.threadId) : []
      },
      ...(source.activity ? { activity: (sessionId: string, activityId: string, historyEpoch?: string) => {
        const binding = this.registry.bySession(this.provider, sessionId)
        return binding ? source.activity?.(binding.threadId, activityId, historyEpoch) : undefined
      } } : {}),
      ...(source.activities ? { activities: (sessionId: string, historyEpoch?: string) => {
        const binding = this.registry.bySession(this.provider, sessionId)
        return binding ? source.activities?.(binding.threadId, historyEpoch) : undefined
      } } : {}),
    })
  }

  async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    await this.registry.load()
    let translated = command
    if (command.type === 'create-thread') {
      const existing = this.registry.byThread(command.threadId)
      const binding = this.registry.reserve(command.threadId, this.provider,
        existing?.sessionId ?? randomUUID(), command.projectId)
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
    const result = await this.inner.execute(translated)
    await this.registry.flush()
    return result
  }

  observeThreads(threadIds: readonly string[]): void {
    this.observed = [...threadIds]
    this.inner.observeThreads?.(threadIds.flatMap(threadId => {
      const binding = this.registry.byThread(threadId)
      return binding?.provider === this.provider ? [binding.sessionId] : []
    }))
  }

  disconnect(): void { this.inner.disconnect() }
}
