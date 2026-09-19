import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { join, resolve } from 'node:path'
import { EMPTY_AGENT_HOST, PROVIDER_LABELS, providerIdSchema, publicProviderEntityId, type AgentCapabilities, type AgentHostSnapshot, type AgentProviderStatus, type ProviderId } from '../../shared/agents'
import type { AgentHost, AgentHostCommand, AgentHostResult, AgentSkillScope, RestoredThreadHistory } from './host'

/** Public IDs are opaque to callers and reversible only at the provider boundary. */
export function providerEntityId(provider: ProviderId, kind: 'model' | 'project', value: string): string {
  return publicProviderEntityId(provider, kind, value)
}
function nativeEntityId(provider: ProviderId, kind: 'model' | 'project', value: string): string {
  const prefix = `native:${provider}:${kind}:`
  if (!value.startsWith(prefix)) throw new Error(`Choose a ${kind} belonging to ${PROVIDER_LABELS[provider]}.`)
  return decodeURIComponent(value.slice(prefix.length))
}
function folderKey(path: string): string { const key = resolve(path); return process.platform === 'win32' ? key.toLowerCase() : key }
type Slot = { snapshot: AgentHostSnapshot; status: AgentProviderStatus; wanted: boolean; epoch: number; connecting?: Promise<void> | undefined }

/** Independent native connections; durable Sotto thread identity selects the transport, never reasoning settings. */
export class ConfiguredProviderHost implements AgentHost {
  readonly concurrentProviders = true
  private legacyProjectProvider: ProviderId | undefined
  private identityLoad: Promise<void> | undefined
  private readonly registrations = new Set<string>()
  private readonly registrationStore: AtomicJsonStore<string[]> | undefined
  private registrationLoad: Promise<void> | undefined
  private observed: readonly string[] = []
  private readonly slots = new Map<ProviderId, Slot>()
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
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
      options.hosts[id].subscribe(snapshot => {
        const slot = this.slots.get(id)!
        if (!slot.wanted) return
        this.accept(id, snapshot)
        this.publish()
      })
    }
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
    slot.snapshot = snapshot.connected ? structuredClone(snapshot) : { ...slot.snapshot, ...snapshot,
      threads: snapshot.threads.length ? snapshot.threads : slot.snapshot.threads,
      projects: snapshot.projects.length ? snapshot.projects : slot.snapshot.projects,
      models: snapshot.models.length ? snapshot.models : slot.snapshot.models }
    slot.status = { id, name: PROVIDER_LABELS[id], version: snapshot.version || slot.status.version,
      capabilities: snapshot.connected ? snapshot.capabilities : slot.status.capabilities,
      connection: snapshot.connected ? 'connected' : snapshot.error ? 'error' : slot.connecting ? 'connecting' : 'disconnected',
      ...(snapshot.error ? { error: snapshot.error } : {}) }
  }
  private failed(id: ProviderId, error: unknown): void {
    const slot = this.slots.get(id)!
    slot.status = { ...slot.status, connection: 'error', error: error instanceof Error ? error.message : 'Provider connection failed.' }
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
    for (const [provider, slot] of this.slots) {
      result.models.push(...slot.snapshot.models.map(model => ({ ...model, providerId: provider,
        id: providerEntityId(provider, 'model', model.id), ready: model.ready && slot.status.connection === 'connected' })))
      result.projects.push(...slot.snapshot.projects.map(project => ({ ...project, providerId: provider, id: this.projectId(provider, project.id) })))
      result.threads.push(...slot.snapshot.threads.map(thread => ({ ...thread, providerId: provider,
        projectId: this.projectId(provider, thread.projectId), modelId: thread.modelId ? providerEntityId(provider, 'model', thread.modelId) : '',
        ...(thread.usage ? { usage: { ...thread.usage, modelId: thread.usage.modelId ? providerEntityId(provider, 'model', thread.usage.modelId) : undefined } } : {}) })))
    }
    if (!result.connected) {
      const error = providers.find(provider => provider.error)?.error
      if (error) result.error = error
    }
    return result
  }
  private publish(): void { const snapshot = this.aggregate(); for (const listener of this.listeners) listener(snapshot) }
  async connect(provider?: ProviderId): Promise<AgentHostSnapshot> {
    const requested = (provider ? [provider] : this.options.enabledProviders?.() ?? [this.options.provider()]).map(id => ({ id, epoch: this.slots.get(id)!.epoch }))
    await this.initialize()
    await Promise.all(requested.filter(({ id, epoch }) => this.slots.get(id)!.epoch === epoch).map(({ id }) => this.connectOne(id)))
    return this.aggregate()
  }
  private async connectOne(id: ProviderId): Promise<void> {
    const slot = this.slots.get(id)!
    if (slot.connecting) return slot.connecting
    if (slot.status.connection === 'connected') return
    slot.wanted = true; const epoch = ++slot.epoch
    slot.status = { ...slot.status, connection: 'connecting' }; delete slot.status.error
    this.publish()
    this.options.hosts[id].observeThreads?.(this.observed)
    const pending = (async () => {
      try {
        const snapshot = await this.options.hosts[id].connect()
        if (slot.epoch !== epoch) { if (!slot.wanted) this.options.hosts[id].disconnect(); return }
        this.accept(id, snapshot)
        if (!snapshot.connected) this.failed(id, new Error(snapshot.error || `${PROVIDER_LABELS[id]} did not confirm the connection.`))
      } catch (error) { if (slot.epoch === epoch) this.failed(id, error) }
      finally { if (slot.epoch === epoch) { slot.connecting = undefined; this.publish() } }
    })()
    slot.connecting = pending
    return pending
  }
  async snapshot(provider?: ProviderId): Promise<AgentHostSnapshot> {
    await Promise.all((provider ? [provider] : providerIdSchema.options).map(async id => {
      const slot = this.slots.get(id)!
      if (!slot.wanted || slot.status.connection !== 'connected') return
      const epoch = slot.epoch
      try { const snapshot = await this.options.hosts[id].snapshot(); if (slot.epoch === epoch) this.accept(id, snapshot) }
      catch (error) { if (slot.epoch === epoch) this.failed(id, error) }
    }))
    this.publish(); return this.aggregate()
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
  async refreshThread(threadId: string): Promise<AgentHostSnapshot> {
    const id = this.owner(threadId); this.requireConnected(id)
    const slot = this.slots.get(id)!; const epoch = slot.epoch; const host = this.options.hosts[id]
    const snapshot = await (host.refreshThread?.(threadId) ?? host.snapshot())
    if (slot.epoch !== epoch) throw new Error('This thread provider disconnected while reading the thread.')
    this.accept(id, snapshot); this.publish(); return this.aggregate()
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
    if (command.type === 'send' && command.skills?.length && this.owner(command.threadId) !== 'codex') throw new Error('Selected Codex skills cannot be sent to another provider. Review this draft.')
    if (command.type === 'create-project') {
      const id = command.provider ?? this.options.provider(); this.requireConnected(id)
      if (!this.slots.get(id)!.status.capabilities.projects) throw new Error('This provider does not support creating projects.')
      const nativeId = id === this.legacyProjectProvider ? command.projectId : nativeEntityId(id, 'project', command.projectId)
      return this.options.hosts[id].execute({ ...command, projectId: nativeId })
    }
    if (command.type === 'create-thread') {
      const model = this.aggregate().models.find(model => model.id === this.resolveModelId(command.modelId))
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
          await this.registrationStore?.write([...this.registrations])
          let result: AgentHostResult
          try { result = await this.options.hosts[id].execute({ type: 'create-project', commandId: `${command.commandId}:project`, projectId, title: project.title, path: project.path }) }
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
      return this.options.hosts[id].execute({ ...command, projectId: target.id, modelId: nativeEntityId(id, 'model', model.id) })
    }
    const id = this.owner(command.threadId); this.requireConnected(id)
    const capabilities = this.slots.get(id)!.status.capabilities
    const needed = command.type === 'send' ? 'submit' : command.type === 'interrupt' ? 'interrupt' : command.type === 'compact-thread' ? 'compact' : command.type === 'configure-thread' ? 'configureThread' : undefined
    if (needed && !capabilities[needed]) throw new Error('This provider does not support that thread action.')
    if (command.type === 'configure-thread' && command.modelId !== undefined) {
      return this.options.hosts[id].execute({ ...command, modelId: nativeEntityId(id, 'model', command.modelId) })
    }
    return this.options.hosts[id].execute(command)
  }
  observeThreads(ids: readonly string[]): void {
    this.observed = [...ids]
    // SottoThreadHost independently maps only the bindings belonging to its adapter.
    for (const [id, slot] of this.slots) if (slot.wanted) this.options.hosts[id].observeThreads?.(ids)
  }
  disconnect(provider?: ProviderId): void {
    for (const id of provider ? [provider] : providerIdSchema.options) {
      const slot = this.slots.get(id)!; slot.wanted = false; ++slot.epoch; slot.connecting = undefined
      this.options.hosts[id].disconnect(); slot.snapshot.connected = false
      slot.status = { ...slot.status, connection: 'disconnected' }; delete slot.status.error
    }
    this.publish()
  }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener)
  }
}
