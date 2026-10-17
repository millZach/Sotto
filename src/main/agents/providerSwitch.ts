import type { BrowserAgentTools } from './browserAgentServer'
import type { ScopedThreadTools } from './threadToolServer'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { cloneHostSnapshot } from './cloneHostSnapshot'
import { ActivitySubscribers, cloneActivitySnapshot, immutableModels, isImmutableModels, subscribeActivitySnapshots } from './activitySnapshots'
import { join, resolve } from 'node:path'
import { EMPTY_AGENT_HOST, PROVIDER_LABELS, parsePublicProviderEntityId, providerIdSchema, publicProviderEntityId, type AgentCapabilities, type AgentHostSnapshot, type AgentModel, type AgentProviderStatus, type ProviderId } from '../../shared/agents'
import { resolveModel } from '../../shared/modelCatalog'
import { ProviderUnavailable, providerProblemOf } from './providerProblem'
import { sameSnapshot } from './sameSnapshot'
import { isUsageProviderId, type UsageQuotaRead, type UsageTokenObservation } from '../../shared/usageDashboard'
import { mappedSink, type UsageHistorySink } from './usageHistory/sink'
import { unavailableProviderQuota } from './providerQuota'
import { confirmedSettingsSnapshot, type ActivitySubscriptionOptions, type AgentHost, type AgentHostCommand, type AgentHostResult, type AgentSkillScope, type RestoredThreadHistory, type ShortTextPrompt, type ThreadHistorySource, type ThreadHostEvent, type ThreadReadPurpose, type ThreadSessionDraft, type ThreadLaunchProfiles, type ThreadForkRequest, type WorkerRoleSource } from './host'

/** Public IDs are opaque to callers and reversible only at the provider boundary. */
export function providerEntityId(provider: ProviderId, kind: 'model' | 'project', value: string): string {
  return publicProviderEntityId(provider, kind, value)
}
function nativeEntityId(provider: ProviderId, kind: 'model' | 'project', value: string): string {
  const parsed = parsePublicProviderEntityId(value)
  if (parsed?.provider !== provider || parsed.kind !== kind) throw new Error(`Choose a ${kind} belonging to ${PROVIDER_LABELS[provider]}.`)
  return parsed.value
}
/** A skill selected for a provider that has none (Devin). Nothing is sent, and the draft keeps the prompt. */
export function providerTakesNoSkills(provider: ProviderId): Error {
  return new Error(`${PROVIDER_LABELS[provider]} does not take skills. Your prompt has not been sent; remove the skill from it and send it again.`)
}
function folderKey(path: string): string { const key = resolve(path); return process.platform === 'win32' ? key.toLowerCase() : key }
type Slot = { snapshot: AgentHostSnapshot; status: AgentProviderStatus; wanted: boolean; epoch: number; connecting?: Promise<void> | undefined;
  unsubscribeSnapshot?: (() => void) | undefined; unsubscribeEvents?: (() => void) | undefined; unsubscribeUsage?: (() => void) | undefined
  /** What this connection's activity subscription asked the provider: to leave its messages out, or not. */
  historyFromEvents?: boolean | undefined }

/** Independent native connections; durable Sotto thread identity selects the transport, never reasoning settings. */
export class ConfiguredProviderHost implements AgentHost {
  useLaunchProfiles(profiles: ThreadLaunchProfiles): void {
    for (const id of providerIdSchema.options) this.options.hosts[id].useLaunchProfiles?.(profiles)
  }
  profileRefusalHandler(threadId: string) {
    // Each SottoThreadHost stops only its bound or early-start runtime. Include early starts
    // whose provider is not yet in the durable registry; one broken cleanup must not block another.
    const handlers = Object.values(this.options.hosts).flatMap(host => {
      const handler = host.profileRefusalHandler?.(threadId)
      return handler ? [handler] : []
    })
    return async (reason: string): Promise<void> => { await Promise.allSettled(handlers.map(async handler => handler(reason))) }
  }
  readonly concurrentProviders = true
  private legacyProjectProvider: ProviderId | undefined
  private identityLoad: Promise<void> | undefined
  private readonly registrations = new Set<string>()
  private readonly registrationStore: AtomicJsonStore<string[]> | undefined
  private registrationLoad: Promise<void> | undefined
  /** Undefined until something says what it is looking at; a connection never invents a watched set. */
  private observed: readonly string[] | undefined
  private readonly slots = new Map<ProviderId, Slot>()
  /** Each provider's models as last named, and the catalog last published from them. */
  private readonly namedModels = new Map<ProviderId, { source: AgentModel[]; connected: boolean; models: AgentModel[] }>()
  private aggregateModels: { parts: AgentModel[][]; models: AgentModel[] } | undefined
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  /** Each activity subscriber, and whether it keeps history from the providers' events. */
  private readonly activityListeners = new ActivitySubscribers()
  private readonly eventListeners = new Set<(event: ThreadHostEvent) => void>()
  private readonly usageListeners = new Set<(record: UsageTokenObservation) => void>()
  /** Thread events from whichever provider owns the thread. Absent when no provider publishes any. */
  readonly subscribeEvents?: (listener: (event: ThreadHostEvent) => void) => () => void
  readonly subscribeUsage?: (listener: (record: UsageTokenObservation) => void) => () => void
  readonly visitUsage?: (threadId: string, visitor: (record: UsageTokenObservation) => void) => void
  readonly readProviderQuota?: (providerId: ProviderId, refresh: boolean) => Promise<UsageQuotaRead>
  readonly scanUsageHistory?: (sink: UsageHistorySink, signal: AbortSignal) => Promise<void>
  constructor(private readonly options: {
    hosts: Record<ProviderId, AgentHost>; provider: () => ProviderId
    directory?: string
    enabledProviders?: () => readonly ProviderId[]
    threadProvider?: (threadId: string) => string | undefined
  }) {
    if (options.directory) this.registrationStore = new AtomicJsonStore(join(options.directory, 'provider-project-registrations.json'), value => z.array(z.string()).parse(value), () => [])
    for (const id of providerIdSchema.options) {
      this.slots.set(id, { snapshot: structuredClone(EMPTY_AGENT_HOST), wanted: false, epoch: 0,
        status: { id, name: PROVIDER_LABELS[id], version: '', connection: 'disconnected', capabilities: structuredClone(EMPTY_AGENT_HOST.capabilities) } })
    }
    if (providerIdSchema.options.some(id => options.hosts[id].subscribeEvents)) {
      this.subscribeEvents = listener => { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener) }
    }
    if (providerIdSchema.options.some(id => isUsageProviderId(id) && options.hosts[id].subscribeUsage)) {
      this.subscribeUsage = listener => {
        this.usageListeners.add(listener)
        return () => this.usageListeners.delete(listener)
      }
    }
    if (providerIdSchema.options.some(id => isUsageProviderId(id) && options.hosts[id].visitUsage)) this.visitUsage = (threadId, visitor) => {
      for (const id of providerIdSchema.options) if (isUsageProviderId(id)) options.hosts[id].visitUsage?.(threadId, record => visitor({ ...record, providerId: id,
        modelId: providerEntityId(id, 'model', record.modelId) }))
    }
    // Each provider reads its own local records in turn, connected or not: reading them starts no session.
    if (providerIdSchema.options.some(id => isUsageProviderId(id) && options.hosts[id].scanUsageHistory)) this.scanUsageHistory = async (sink, signal) => {
      for (const id of providerIdSchema.options) {
        const host = options.hosts[id]
        if (signal.aborted) return
        if (!isUsageProviderId(id) || !host.scanUsageHistory) continue
        const project = <T extends { providerId: string; modelId: string }>(record: T): T => ({ ...record, providerId: id, modelId: providerEntityId(id, 'model', record.modelId) })
        try { await host.scanUsageHistory(mappedSink(sink, { token: project, prompt: project }), signal) }
        catch { /* One provider's unreadable records leave the others' to read. */ }
      }
    }
    if (providerIdSchema.options.some(id => options.hosts[id].readProviderQuota)) this.readProviderQuota = async (providerId, refresh) => {
      if (!isUsageProviderId(providerId)) throw new Error('Usage is not available for this provider.')
      const slot = this.slots.get(providerId), epoch = slot?.epoch
      if (slot?.status.connection !== 'connected') return unavailableProviderQuota(providerId, 'not-connected')
      const quota = await options.hosts[providerId].readProviderQuota?.(providerId, refresh)
        ?? unavailableProviderQuota(providerId, 'unsupported')
      if (slot.epoch !== epoch || slot.status.connection !== 'connected') return unavailableProviderQuota(providerId, 'not-connected')
      return { ...quota, windows: quota.windows.map(window => ({ ...window,
        ...(window.modelId ? { modelId: providerEntityId(providerId, 'model', window.modelId) } : {}) })) }
    }
  }
  /** Each provider asks the store about the threads it owns; a thread it does not own answers nothing. */
  useBrowserTools(tools: BrowserAgentTools): void {
    for (const id of providerIdSchema.options) this.options.hosts[id].useBrowserTools?.(tools)
  }
  useThreadTools(tools: readonly ScopedThreadTools[]): void {
    for (const id of providerIdSchema.options) this.options.hosts[id].useThreadTools?.(tools)
  }
  useWorkerRoles(roles: WorkerRoleSource): void {
    for (const id of providerIdSchema.options) this.options.hosts[id].useWorkerRoles?.(roles)
  }
  useThreadHistory(source: ThreadHistorySource): void {
    for (const id of providerIdSchema.options) this.options.hosts[id].useThreadHistory?.(source)
  }
  /** Capture the restored legacy project scope before UI configuration can change the default. */
  initialize(): Promise<void> {
    this.identityLoad ??= (async () => {
      if (!this.options.directory) { this.legacyProjectProvider = this.options.provider(); return }
      const schema = z.object({ legacyProjectProvider: providerIdSchema })
      const store = new AtomicJsonStore(join(this.options.directory, 'provider-project-identity.json'), schema.parse,
        () => ({ legacyProjectProvider: this.options.provider() }))
      const identity = await readFile(join(this.options.directory, 'provider-project-identity.json'), 'utf8')
        .then(contents => schema.parse(JSON.parse(contents)))
        .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return { legacyProjectProvider: this.options.provider() }; throw error })
      await store.write(identity)
      this.legacyProjectProvider = identity.legacyProjectProvider
    })().catch(error => { this.identityLoad = undefined; throw error })
    return this.identityLoad
  }
  private projectId(provider: ProviderId, id: string): string {
    return provider === this.legacyProjectProvider ? id : providerEntityId(provider, 'project', id)
  }
  createProjectId(provider: ProviderId): string { return this.projectId(provider, randomUUID()) }
  private accept(id: ProviderId, snapshot: AgentHostSnapshot): void {
    const slot = this.slots.get(id)!
    // A transport disappearing must not discard the identities and recovery material it already supplied.
    const owned = cloneActivitySnapshot(snapshot)
    slot.snapshot = snapshot.connected ? owned : { ...slot.snapshot, ...owned,
      threads: owned.threads.length ? owned.threads : slot.snapshot.threads,
      projects: owned.projects.length ? owned.projects : slot.snapshot.projects,
      models: owned.models.length ? owned.models : slot.snapshot.models }
    slot.status = { id, name: PROVIDER_LABELS[id], version: snapshot.version || slot.status.version,
      capabilities: owned.connected ? owned.capabilities : slot.status.capabilities,
      connection: snapshot.connected ? 'connected' : snapshot.error ? 'error' : slot.connecting ? 'connecting' : 'disconnected',
      ...(snapshot.verifiedVersion ? { verifiedVersion: snapshot.verifiedVersion } : {}),
      ...(snapshot.error ? { error: snapshot.error } : {}),
      // What the Hosts page's tile decides on (ADR-0037): why it is not connected, or what it is signed in with.
      ...(!snapshot.connected && snapshot.error && snapshot.problem ? { problem: snapshot.problem } : {}),
      ...(!snapshot.connected && snapshot.error && snapshot.problem === 'too-old' && snapshot.requiredVersion ? { requiredVersion: snapshot.requiredVersion } : {}),
      ...(snapshot.connected && snapshot.account ? { account: snapshot.account } : {}) }
  }
  private failed(id: ProviderId, error: unknown): void {
    const slot = this.slots.get(id)!
    const named = providerProblemOf(error)
    const status = { ...slot.status }; delete status.account; delete status.problem; delete status.requiredVersion
    slot.status = { ...status, connection: 'error', error: error instanceof Error ? error.message : 'Provider connection failed.',
      ...(named ? { problem: named.problem } : {}), ...(named?.version ? { version: named.version } : {}),
      ...(named?.problem === 'too-old' && named.requiredVersion ? { requiredVersion: named.requiredVersion } : {}) }
    slot.snapshot.connected = false
  }
  private aggregate(): AgentHostSnapshot {
    const providers = [...this.slots.values()].map(slot => structuredClone(slot.status))
    const capabilities = { ...EMPTY_AGENT_HOST.capabilities }
    for (const provider of providers.filter(provider => provider.connection === 'connected')) {
      for (const key of Object.keys(provider.capabilities) as (keyof AgentCapabilities)[]) if (provider.capabilities[key]) capabilities[key] = true
    }
    const connected = providers.filter(provider => provider.connection === 'connected')
    const result: AgentHostSnapshot = { connected: connected.length > 0, name: connected.length === 1 ? connected[0]!.name : 'Native providers', version: '', capabilities, providers,
      models: [], projects: [], threads: [] }
    const parts: AgentModel[][] = []
    for (const [provider, slot] of this.slots) {
      parts.push(this.slotModels(provider, slot))
      result.projects.push(...slot.snapshot.projects.map(project => ({ ...project, providerId: provider, id: this.projectId(provider, project.id) })))
      result.threads.push(...slot.snapshot.threads.map(thread => ({ ...thread, providerId: provider,
        projectId: this.projectId(provider, thread.projectId), modelId: thread.modelId ? providerEntityId(provider, 'model', thread.modelId) : '',
        ...(thread.usage ? { usage: { ...thread.usage, modelId: thread.usage.modelId ? providerEntityId(provider, 'model', thread.usage.modelId) : undefined } } : {}) })))
    }
    // One catalog for every publish until a provider's own catalog or connection changes, so the layers to the window
    // share it rather than copy it (#917).
    // A host whose adapter does not certify its catalog hands over a new one each time; freezing that would only add work.
    const held = this.aggregateModels
    const certified = [...this.slots.values()].every(slot => !slot.snapshot.models.length || isImmutableModels(slot.snapshot.models))
    result.models = held && held.parts.length === parts.length && held.parts.every((part, index) => part === parts[index]) ? held.models
      : certified ? immutableModels(parts.flat()) : parts.flat()
    this.aggregateModels = { parts, models: result.models }
    if (!result.connected) {
      const error = providers.find(provider => provider.error)?.error
      if (error) result.error = error
    }
    return result
  }
  /** A provider's models as the switch names them, rebuilt only when its catalog or its connection changes. */
  private slotModels(provider: ProviderId, slot: { snapshot: AgentHostSnapshot; status: AgentProviderStatus }): AgentModel[] {
    const connected = slot.status.connection === 'connected'
    const held = this.namedModels.get(provider)
    if (held && held.source === slot.snapshot.models && held.connected === connected) return held.models
    const models = slot.snapshot.models.map(model => ({ ...model, providerId: provider,
      id: providerEntityId(provider, 'model', model.id), ready: model.ready && connected }))
    this.namedModels.set(provider, { source: slot.snapshot.models, connected, models })
    return models
  }
  private publish(): void {
    if (!this.listeners.size && !this.activityListeners.size) return
    const snapshot = this.aggregate()
    for (const listener of this.listeners) listener(cloneHostSnapshot(snapshot))
    this.activityListeners.publish(() => snapshot)
  }
  async connect(provider?: ProviderId): Promise<AgentHostSnapshot> {
    const requested = (provider ? [provider] : this.options.enabledProviders?.() ?? [this.options.provider()]).map(id => ({ id, epoch: this.slots.get(id)!.epoch }))
    await this.initialize()
    await Promise.all(requested.filter(({ id, epoch }) => this.slots.get(id)!.epoch === epoch).map(({ id }) => this.connectOne(id)))
    return cloneHostSnapshot(this.aggregate())
  }
  private async connectOne(id: ProviderId): Promise<void> {
    const slot = this.slots.get(id)!
    if (slot.connecting) return slot.connecting
    if (slot.status.connection === 'connected') return
    slot.wanted = true; const epoch = ++slot.epoch
    slot.unsubscribeSnapshot?.(); slot.unsubscribeEvents?.(); slot.unsubscribeUsage?.()
    slot.status = { ...slot.status, connection: 'connecting' }; delete slot.status.error; delete slot.status.problem; delete slot.status.requiredVersion
    this.watchActivity(id, slot, epoch)
    // A thread belongs to one provider. Its events keep that provider's connection epoch.
    slot.unsubscribeEvents = this.options.hosts[id].subscribeEvents?.(event => {
      if (!slot.wanted || slot.epoch !== epoch) return
      for (const listener of this.eventListeners) listener(event)
    })
    slot.unsubscribeUsage = isUsageProviderId(id) ? this.options.hosts[id].subscribeUsage?.(record => {
      if (!slot.wanted || slot.epoch !== epoch) return
      const projected = { ...record, providerId: id, modelId: providerEntityId(id, 'model', record.modelId) }
      for (const listener of this.usageListeners) listener(projected)
    }) : undefined
    this.publish()
    if (this.observed) this.options.hosts[id].observeThreads?.(this.observed)
    const pending = (async () => {
      try {
        const snapshot = await this.options.hosts[id].connect()
        if (slot.epoch !== epoch) { if (!slot.wanted) this.options.hosts[id].disconnect(); return }
        this.accept(id, snapshot)
        // A refusal an adapter returns (Claude Code's and Devin's) keeps the reason it named, as a thrown one does.
        if (!snapshot.connected) {
          const message = snapshot.error || `${PROVIDER_LABELS[id]} did not confirm the connection.`
          this.failed(id, snapshot.problem ? new ProviderUnavailable(snapshot.problem, message, snapshot.version || undefined, snapshot.requiredVersion) : new Error(message))
        }
      } catch (error) { if (slot.epoch === epoch) this.failed(id, error) }
      finally { if (slot.epoch === epoch) { slot.connecting = undefined; this.publish() } }
    })()
    slot.connecting = pending
    return pending
  }
  /** One provider's activity for this connection, asking it to leave its messages out only when nothing here reads them. */
  private watchActivity(id: ProviderId, slot: Slot, epoch: number): void {
    const historyFromEvents = this.historyFromEvents(id)
    slot.unsubscribeSnapshot?.()
    slot.historyFromEvents = historyFromEvents
    slot.unsubscribeSnapshot = subscribeActivitySnapshots(this.options.hosts[id], snapshot => {
      if (!slot.wanted || slot.epoch !== epoch) return
      this.accept(id, snapshot)
      this.publish()
    }, { historyFromEvents })
  }
  /**
   * A subscriber came or went, so whether anything here reads a provider's messages may have changed. Each
   * connected provider whose subscription asked otherwise is subscribed again. When messages are wanted
   * again, what those providers last published carries none, so each is read afresh.
   */
  private reconsider(): void {
    let reread = false
    for (const [id, slot] of this.slots) {
      if (!slot.wanted || !slot.unsubscribeSnapshot) continue
      const historyFromEvents = this.historyFromEvents(id)
      if (slot.historyFromEvents === historyFromEvents) continue
      this.watchActivity(id, slot, slot.epoch)
      if (!historyFromEvents) reread = true
    }
    if (reread) void this.snapshot().catch(() => undefined)
  }
  async snapshot(provider?: ProviderId): Promise<AgentHostSnapshot> {
    await Promise.all((provider ? [provider] : providerIdSchema.options).map(async id => {
      const slot = this.slots.get(id)!
      if (!slot.wanted || slot.status.connection !== 'connected') return
      const epoch = slot.epoch
      try { const snapshot = await this.options.hosts[id].snapshot(); if (slot.epoch === epoch) this.accept(id, snapshot) }
      catch (error) { if (slot.epoch === epoch) this.failed(id, error) }
    }))
    this.publish(); return cloneHostSnapshot(this.aggregate())
  }
  private owner(threadId: string): ProviderId {
    const durable = this.options.threadProvider?.(threadId)
    if (durable) {
      const parsed = providerIdSchema.safeParse(durable)
      if (!parsed.success) throw new Error('This thread belongs to a retired provider. Its session cannot be moved to another provider.')
      return parsed.data
    }
    const candidates = [...this.slots].filter(([, slot]) => slot.snapshot.threads.some(thread => thread.id === threadId)).map(([id]) => id)
    if (candidates.length !== 1) throw new Error('This thread is not known to Sotto. Refresh and select it again.')
    return candidates[0]!
  }
  private requireConnected(id: ProviderId): void {
    if (this.slots.get(id)!.status.connection !== 'connected') throw new Error(`Reconnect ${PROVIDER_LABELS[id]} before sending. Your draft is saved.`)
  }
  async listThreadSkills(threadId: string, forceReload = false, scope?: AgentSkillScope) {
    const id = this.providerForThread(threadId) ?? scope?.providerId
    if (!id) throw new Error('This thread is not known to Sotto.')
    this.requireConnected(id)
    const host = this.options.hosts[id]; const epoch = this.slots.get(id)!.epoch
    if (!host.listThreadSkills || !this.slots.get(id)!.status.capabilities.skills) throw new Error('This provider does not expose skills.')
    const catalog = await host.listThreadSkills(threadId, forceReload, scope)
    if (epoch !== this.slots.get(id)!.epoch) throw new Error('The thread provider changed while loading skills.')
    return catalog
  }
  /** Every provider sees the whole offer and keeps the threads it owns; no binding is needed here. */
  async restoreThreadHistory(threads: readonly RestoredThreadHistory[]): Promise<void> {
    await Promise.all(providerIdSchema.options.map(id => this.options.hosts[id].restoreThreadHistory?.(threads)))
  }
  async refreshThread(threadId: string, purpose?: ThreadReadPurpose): Promise<AgentHostSnapshot> {
    const id = this.owner(threadId); this.requireConnected(id)
    const slot = this.slots.get(id)!; const epoch = slot.epoch; const host = this.options.hosts[id]
    // A caller that keeps history from events is handed no messages only when this connection's own subscription
    // asked the same: what the read puts in the slot is what every subscriber is published next (#368).
    const read = purpose?.historyFromEvents && !slot.historyFromEvents ? { ...purpose, historyFromEvents: false } : purpose
    const snapshot = await (host.refreshThread?.(threadId, read) ?? host.snapshot())
    if (slot.epoch !== epoch) throw new Error('This thread provider disconnected while reading the thread.')
    const whole = await this.whole(id, read?.historyFromEvents === true)
    if (slot.epoch !== epoch) throw new Error('This thread provider disconnected while reading the thread.')
    const before = { snapshot: slot.snapshot, status: slot.status }
    this.accept(id, whole ?? snapshot)
    // A read before a send that changed nothing publishes nothing (#765): every send makes one.
    if (!read?.beforeSend || !sameSnapshot(before.snapshot, slot.snapshot) || !sameSnapshot(before.status, slot.status)) this.publish()
    return cloneHostSnapshot(this.aggregate())
  }
  rollbackCapability(threadId: string) {
    const provider = this.providerForThread(threadId)
    return provider ? this.options.hosts[provider].rollbackCapability?.(threadId) ?? { supported: false, reason: `${PROVIDER_LABELS[provider]} does not expose verified conversation rewind.` }
      : { supported: false, reason: 'The original provider binding is unavailable.' }
  }
  async rollbackThread(threadId: string, removedUserMessages: number, expectedUserMessageIds: readonly string[]): Promise<AgentHostResult> {
    const provider = this.owner(threadId); this.requireConnected(provider)
    const host = this.options.hosts[provider]
    if (!host.rollbackThread) throw new Error('This provider does not support conversation rewind.')
    return host.rollbackThread(threadId, removedUserMessages, expectedUserMessageIds)
  }
  /**
   * A fork is its source's provider's own copy (#1028), so it goes to the provider that owns the source thread, on one of
   * that provider's models; no other provider is asked in its place.
   */
  async forkThread(request: ThreadForkRequest): Promise<AgentHostResult> {
    const provider = this.owner(request.source.threadId); this.requireConnected(provider)
    const host = this.options.hosts[provider]
    if (!host.forkThread) throw new Error(`${PROVIDER_LABELS[provider]} has no fork of its own, so nothing was made.`)
    const model = resolveModel(this.aggregate().models, this.resolveModelId(request.modelId))
    if (!model?.ready || model.providerId !== provider) throw new Error(`Choose a ready ${PROVIDER_LABELS[provider]} model: a fork stays with its source’s provider. Nothing was made.`)
    return host.forkThread({ ...request, modelId: nativeEntityId(provider, 'model', model.id) })
  }
  /**
   * The thread's own provider writes or nothing does (ADR-0026). A client that is not connected is not
   * started for a side call, and no other provider is asked in its place.
   */
  async writeShortText(threadId: string, prompt: ShortTextPrompt, signal?: AbortSignal): Promise<string | null> {
    const id = this.providerForThread(threadId)
    if (!id || this.slots.get(id)!.status.connection !== 'connected') return null
    return await this.options.hosts[id].writeShortText?.(threadId, prompt, signal) ?? null
  }
  providerForThread(threadId: string): ProviderId | undefined {
    try { return this.owner(threadId) } catch { return undefined }
  }
  resolveProjectId(id: string): string { return id }
  resolveModelId(id: string): string { return this.resolveEntityId(id, 'model') }
  private resolveEntityId(id: string, kind: 'project' | 'model'): string {
    if (!id || id.startsWith('native:')) return id
    return providerEntityId(this.options.provider(), kind, id)
  }
  async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    return this.executeGuarded(command)
  }
  executeFromWatcher(command: AgentHostCommand, guard: () => void): Promise<AgentHostResult> { return this.executeGuarded(command, guard) }
  private async executeGuarded(command: AgentHostCommand, guard?: () => void): Promise<AgentHostResult> {
    const dispatch = (id: ProviderId, value: AgentHostCommand) => {
      guard?.()
      const host = this.options.hosts[id]
      return guard && host.executeFromWatcher ? host.executeFromWatcher(value, guard) : host.execute(value)
    }
    if (command.type === 'create-project') {
      const id = command.provider ?? this.options.provider(); this.requireConnected(id)
      if (!this.slots.get(id)!.status.capabilities.projects) throw new Error('This provider does not support creating projects.')
      const nativeId = id === this.legacyProjectProvider ? command.projectId : nativeEntityId(id, 'project', command.projectId)
      return dispatch(id, { ...command, projectId: nativeId })
    }
    if (command.type === 'create-thread') {
      const model = resolveModel(this.aggregate().models, this.resolveModelId(command.modelId))
      if (!model?.providerId || !model.ready) throw new Error('Choose an available model and provider.')
      const id = model.providerId; this.requireConnected(id)
      if (!this.slots.get(id)!.status.capabilities.threads) throw new Error('This provider cannot create threads.')
      const project = this.aggregate().projects.find(project => project.id === this.resolveProjectId(command.projectId))
        ?? (command.project?.id === command.projectId ? command.project : undefined)
      if (!project) throw new Error('Choose an available project.')
      const slot = this.slots.get(id)!; const epoch = slot.epoch
      let target = slot.snapshot.projects.find(candidate => folderKey(candidate.path) === folderKey(project.path))
      const projectId = createHash('sha256').update(JSON.stringify([id, folderKey(project.path)])).digest('hex')
      this.registrationLoad ??= (async () => {
        const saved = this.options.directory ? await readFile(join(this.options.directory, 'provider-project-registrations.json'), 'utf8')
          .then(contents => z.array(z.string()).parse(JSON.parse(contents)))
          .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error }) : []
        for (const key of saved) this.registrations.add(key)
      })().catch(error => { this.registrationLoad = undefined; throw error })
      await this.registrationLoad
      const key = JSON.stringify([id, projectId])
      if (!target) {
        if (!slot.status.capabilities.projects) throw new Error('This provider cannot use a new project folder.')
        if (this.registrations.has(key)) {
          const snapshot = await this.options.hosts[id].snapshot()
          if (slot.epoch !== epoch) throw new Error('The provider disconnected while checking this project.')
          this.accept(id, snapshot)
          target = slot.snapshot.projects.find(candidate => candidate.id === projectId || folderKey(candidate.path) === folderKey(project.path))
          if (!target) throw new Error('The provider has not confirmed the earlier project registration. Refresh its connection before retrying; it will not be registered twice.')
        } else {
          this.registrations.add(key)
          try { await this.registrationStore?.write([...this.registrations]) }
          catch (error) { this.registrations.delete(key); throw error }
          let result: AgentHostResult
          try { result = await dispatch(id, { type: 'create-project', commandId: `${command.commandId}:project`, projectId, title: project.title, path: project.path }) }
          catch (error) { this.registrations.delete(key); await this.registrationStore?.write([...this.registrations]); throw error }
          if (!result.accepted && !result.uncertain) {
            this.registrations.delete(key); await this.registrationStore?.write([...this.registrations])
            throw new Error('The provider rejected this project registration.')
          }
          const snapshot = await this.options.hosts[id].snapshot()
          if (slot.epoch !== epoch) throw new Error('The provider disconnected while registering this project.')
          this.accept(id, snapshot)
          target = slot.snapshot.projects.find(candidate => candidate.id === projectId || folderKey(candidate.path) === folderKey(project.path))
          // The thread itself has never been dispatched. Preserve only the registration intent for recovery.
          if (!target) throw new Error('The provider has not confirmed this project registration. Refresh its connection before retrying; your thread has not been created.')
        }
      }
      if (this.registrations.delete(key)) await this.registrationStore?.write([...this.registrations])
      this.requireConnected(id)
      return dispatch(id, { ...command, projectId: target.id, modelId: nativeEntityId(id, 'model', model.id) })
    }
    const id = this.owner(command.threadId); this.requireConnected(id)
    const capabilities = this.slots.get(id)!.status.capabilities
    const needed = command.type === 'send' ? 'submit' : command.type === 'interrupt' ? 'interrupt' : command.type === 'compact-thread' ? 'compact' : command.type === 'configure-thread' ? 'configureThread' : undefined
    if (needed && !capabilities[needed]) throw new Error('This provider does not support that thread action.')
    if ((command.type === 'send' || command.type === 'steer') && command.skills?.length && !capabilities.skills) throw providerTakesNoSkills(id)
    if (command.type !== 'configure-thread') return dispatch(id, command)
    const slot = this.slots.get(id)!; const epoch = slot.epoch
    // As for a thread refresh: no messages only when this connection's subscription asked for none either (#368).
    const settings = command.historyFromEvents && !slot.historyFromEvents ? { ...command, historyFromEvents: false } : command
    const [result, snapshot] = confirmedSettingsSnapshot(await dispatch(id, settings.modelId !== undefined ? { ...settings, modelId: nativeEntityId(id, 'model', settings.modelId) } : settings))
    // The provider's snapshot of a confirmed change becomes the whole view, as a read of the thread would.
    // One from a connection that has since changed is dropped.
    if (!snapshot || slot.epoch !== epoch) return result
    // The change is made, so a failed read here costs only the snapshot: the coordinator reads the thread instead.
    const whole = await this.whole(id, settings.historyFromEvents === true).catch(() => null)
    if (whole === null || slot.epoch !== epoch) return result
    this.accept(id, whole ?? snapshot)
    return { ...result, snapshot: cloneHostSnapshot(this.aggregate()) }
  }
  /**
   * A read or settings result that left its messages out, because this connection's subscription asked for none
   * when it went out, is about to become the provider's slot. If a subscriber that reads messages came while it
   * was on the way, the slot must not lose them, so the provider is read whole and that is taken in instead
   * (#368). Undefined when the result can be taken in as it is.
   */
  private async whole(id: ProviderId, withoutMessages: boolean): Promise<AgentHostSnapshot | undefined> {
    if (!withoutMessages || this.slots.get(id)!.historyFromEvents) return undefined
    return this.options.hosts[id].snapshot()
  }
  /** Early start (#769): the thread's own provider, or for a draft the provider its model belongs to, if connected. */
  async startThreadSession(threadId: string, draft?: ThreadSessionDraft): Promise<void> {
    if (!draft) {
      const id = this.providerForThread(threadId)
      if (!id || this.slots.get(id)!.status.connection !== 'connected') return
      return this.options.hosts[id].startThreadSession?.(threadId)
    }
    const model = resolveModel(this.aggregate().models, this.resolveModelId(draft.modelId))
    if (!model?.providerId || !model.ready || this.slots.get(model.providerId)!.status.connection !== 'connected') return
    return this.options.hosts[model.providerId].startThreadSession?.(threadId, { ...draft, modelId: nativeEntityId(model.providerId, 'model', model.id) })
  }
  observeThreads(ids: readonly string[]): void {
    this.observed = [...ids]
    // SottoThreadHost independently maps only the bindings belonging to its adapter.
    for (const [id, slot] of this.slots) if (slot.wanted) this.options.hosts[id].observeThreads?.(ids)
  }
  disconnect(provider?: ProviderId): void {
    for (const id of provider ? [provider] : providerIdSchema.options) {
      const slot = this.slots.get(id)!; slot.wanted = false; ++slot.epoch; slot.connecting = undefined
      slot.unsubscribeSnapshot?.(); slot.unsubscribeEvents?.(); slot.unsubscribeUsage?.()
      slot.unsubscribeSnapshot = undefined; slot.unsubscribeEvents = undefined; slot.unsubscribeUsage = undefined
      this.options.hosts[id].disconnect(); slot.snapshot.connected = false
      slot.status = { ...slot.status, connection: 'disconnected' }; delete slot.status.error; delete slot.status.problem; delete slot.status.requiredVersion; delete slot.status.account
    }
    this.publish()
  }
  /** Handed to the provider's own host whatever its slot holds: an adapter that is not connected does nothing. */
  async clientUpdated(provider: ProviderId): Promise<void> {
    await this.options.hosts[provider].clientUpdated?.(provider)
  }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void {
    this.listeners.add(listener); this.reconsider()
    return () => { this.listeners.delete(listener); this.reconsider() }
  }
  subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void {
    const off = this.activityListeners.add(listener, options); this.reconsider()
    return () => { off(); this.reconsider() }
  }
  /** A provider's own messages are left out of what it publishes here only when it publishes events, every
   * subscriber keeps history from the events this switch forwards, and none reads the ordinary subscription. */
  private historyFromEvents(id: ProviderId): boolean {
    return this.listeners.size === 0 && this.activityListeners.everyAsked() && typeof this.options.hosts[id].subscribeEvents === 'function'
  }
}
