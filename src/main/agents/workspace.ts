import { randomUUID } from 'node:crypto'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { agentHostSnapshotSchema, EMPTY_AGENT_HOST, isThreadProviderConnected, type AgentHostSnapshot, type AgentThread, type ProviderId } from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { AgentHost, AgentHostCommand, AgentHostResult } from './host'
import { validateThreadOptions } from './threadOptions'
import { resolveThreadWorkingDirectory } from '../../shared/threadWorkingDirectory'
import { existingWorkingDirectory, ThreadWorktrees } from './threadWorktrees'
import { mergeAgentActivities } from '../../shared/agentActivity'

const workspaceSchema = z.object({
  snapshot: agentHostSnapshotSchema,
  projectAliases: z.array(z.object({ providerProjectId: z.string(), projectId: z.string() })).default([]),
  creations: z.array(z.object({ threadId: z.string(), projectId: z.string(), commandId: z.string(), phase: z.enum(['unstarted', 'starting', 'retryable', 'started']) })),
})
type Workspace = z.infer<typeof workspaceSchema>

/** How long a burst of provider snapshots is gathered into one publish. The coordinator's own
 * broadcast window is the same 16 ms, so this costs a window rather than a visible delay. */
const PUBLISH_WINDOW_MS = 16
/** How long a provider-driven cache write waits for the state to settle. A user command never
 * waits this out: it writes through `flush()` and returns after its own write. */
const WRITE_WINDOW_MS = 250

/** Durable Sotto organization above the existing native identity/transport boundary.
 * Only an unstarted local thread can change provider. Native bindings are never rewritten. */
export class WorkspaceHost implements AgentHost {
  readonly concurrentProviders: boolean
  private state: Workspace = { snapshot: structuredClone(EMPTY_AGENT_HOST), creations: [], projectAliases: [] }
  private readonly store: AtomicJsonStore<Workspace>
  private loading: Promise<void> | undefined
  private ready = false
  private dirty = false
  private saving: Promise<void> | undefined
  private saveError: string | undefined
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  private publishTimer: ReturnType<typeof setTimeout> | undefined
  private publishPending = false
  private writeTimer: ReturnType<typeof setTimeout> | undefined
  private readonly lanes = new Map<string, Promise<unknown>>()
  /** In-flight working-copy setup per thread, so a send waits for it instead of starting a second one. */
  private readonly preparations = new Map<string, Promise<void>>()
  private readonly worktrees: ThreadWorktrees
  private checkpointHooks: { beforeTurn(threadId: string): Promise<void>; isBlocked(threadId: string): boolean | Promise<boolean> } | undefined

  setCheckpointHooks(hooks: { beforeTurn(threadId: string): Promise<void>; isBlocked(threadId: string): boolean | Promise<boolean> }): void { this.checkpointHooks = hooks }
  rollbackCapability(threadId: string) { return this.inner.rollbackCapability?.(threadId) ?? { supported: false, reason: 'This provider does not expose verified conversation rewind.' } }
  rollbackThread(threadId: string, removedUserMessages: number, expectedUserMessageIds: readonly string[]): Promise<AgentHostResult> {
    const pending = (this.lanes.get(threadId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (!this.inner.rollbackThread) throw new Error('Native conversation rewind is unavailable.')
      return this.inner.rollbackThread(threadId, removedUserMessages, expectedUserMessageIds)
    })
    this.lanes.set(threadId, pending)
    void pending.finally(() => { if (this.lanes.get(threadId) === pending) this.lanes.delete(threadId) }).catch(() => undefined)
    return pending
  }

  constructor(private readonly inner: AgentHost, private readonly directory: string, private readonly historyEnabled: () => boolean = () => true) {
    this.concurrentProviders = inner.concurrentProviders === true
    this.worktrees = new ThreadWorktrees(directory)
    this.store = new AtomicJsonStore(join(directory, 'workspace.json'), workspaceSchema.parse, () => this.state)
    inner.subscribe(snapshot => {
      if (!this.ready) return
      this.accept(snapshot)
      this.writeSoon()
      this.publishSoon()
    })
  }

  initialize(): Promise<void> {
    this.loading ??= (async () => {
      // Native history is recoverable from the providers. Never create independent
      // private transcript backups, and remove this cache's abandoned write copies.
      const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      for (const name of names) if (/^workspace\.json\.(?:tmp|corrupt)-\d+-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(name)) {
        await unlink(join(this.directory, name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      }
      this.state = await this.store.peek()
      const snapshot = this.state.snapshot
      snapshot.connected = false
      snapshot.models.forEach(model => { model.ready = false })
      snapshot.providers?.forEach(provider => { provider.connection = 'disconnected'; delete provider.error })
      delete snapshot.error
      if (!this.historyEnabled()) for (const thread of snapshot.threads) { thread.messages = []; thread.requests = []; delete thread.activities }
      // Cached running activity is evidence of an unfinished observation, not a live process.
      for (const thread of snapshot.threads) for (const activity of thread.activities ?? []) if (activity.status === 'running') activity.status = 'unknown'
      await this.inner.initialize?.()
      // The cache below is what a provider's own transcript would otherwise be re-read to rebuild.
      // Handing it back before the first connection is what lets an adapter resume where it stopped.
      await this.inner.restoreThreadHistory?.(snapshot.threads.filter(thread => thread.messages.length)
        .map(thread => ({ threadId: thread.id, messages: thread.messages })))
      this.ready = true
      await this.privacyChanged()
    })().catch(error => { this.loading = undefined; throw error })
    return this.loading
  }

  async listThreadSkills(threadId: string, forceReload = false) {
    await this.initialize()
    const thread = this.state.snapshot.threads.find(thread => thread.id === threadId)
    if (!thread || !this.inner.listThreadSkills) throw new Error('Skills are unavailable for this thread.')
    const workingDirectory = await this.threadWorkingDirectory(threadId)
    const creation = this.state.creations.find(item => item.threadId === threadId)
    if (creation && (creation.phase === 'unstarted' || creation.phase === 'retryable')) {
      const project = this.state.snapshot.projects.find(project => project.id === thread.projectId)
      if (!project || !thread.providerId) throw new Error('This thread has no available working folder.')
      return this.inner.listThreadSkills(threadId, forceReload, { providerId: thread.providerId, workingDirectory })
    }
    return this.inner.listThreadSkills(threadId, forceReload)
  }
  workspaceSnapshot(): AgentHostSnapshot {
    const snapshot = structuredClone(this.state.snapshot)
    if (this.saveError) snapshot.error = this.saveError
    return snapshot
  }
  private publish(): void { for (const listener of this.listeners) listener(this.workspaceSnapshot()) }
  /**
   * A publish the providers asked for. The first of a burst goes out at once, so a reply appearing
   * still feels immediate, and everything inside the window behind it becomes one publish at its
   * end with the last state. No adapter can make the host copy the workspace per event.
   */
  private publishSoon(): void {
    if (this.publishTimer) { this.publishPending = true; return }
    this.publish()
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined
      if (this.publishPending) { this.publishPending = false; this.publishSoon() }
    }, PUBLISH_WINDOW_MS)
    this.publishTimer.unref?.()
  }
  /** A cache write the providers asked for: never more than one waiting, and the state it finds
   * when it runs is the one that is written. */
  private writeSoon(): void {
    if (this.writeTimer) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined
      void this.flush().catch(() => { this.saveError = 'Workspace history could not be saved. Restore access to local storage and refresh.'; this.publish() })
    }, WRITE_WINDOW_MS)
    this.writeTimer.unref?.()
  }
  private accept(snapshot: AgentHostSnapshot): void {
    const previous = this.state.snapshot
    const projects = new Map(previous.projects.map(project => [project.id, project]))
    for (const project of snapshot.projects) {
      // Hide only registrations introduced for our pending creation, never merge
      // pre-existing project scopes just because they happen to share a folder.
      if (!projects.has(project.id) && !this.state.projectAliases.some(alias => alias.providerProjectId === project.id)) {
        const creation = this.state.creations.find(item => item.phase === 'starting'
          && previous.threads.find(thread => thread.id === item.threadId)?.providerId === project.providerId
          && previous.projects.some(source => source.id === item.projectId && source.path === project.path && source.id !== project.id))
        if (creation) this.state.projectAliases.push({ providerProjectId: project.id, projectId: creation.projectId })
      }
      if (!this.state.projectAliases.some(alias => alias.providerProjectId === project.id)) projects.set(project.id, { ...project, workspaceSettledAt: projects.get(project.id)?.workspaceSettledAt ?? null })
    }
    const threads = new Map(previous.threads.map(thread => [thread.id, thread]))
    for (const thread of snapshot.threads) {
      const old = threads.get(thread.id)
      const creation = this.state.creations.find(item => item.threadId === thread.id)
      if (creation) creation.phase = 'started'
      // A new provider registration may have a different project ID. The original Sotto
      // project remains the workspace/memory scope for a thread created beneath it.
      threads.set(thread.id, { ...thread,
        // A name the user set by hand, or one Sotto wrote for this thread, outranks whatever the provider still calls it.
        ...(old?.titleSource === 'user' || old?.titleSource === 'generated' ? { title: old.title, titleSource: old.titleSource } : {}),
        ...(old?.worktree ? { worktree: old.worktree, workingDirectory: old.workingDirectory } : {}),
        messages: (thread.historyStatus === 'loading' || thread.historyStatus === 'error') && !thread.messages.length ? old?.messages ?? [] : thread.messages,
        ...(old?.activities || thread.activities ? { activities: old?.historyEpoch !== thread.historyEpoch ? thread.activities ?? [] : mergeAgentActivities(old?.activities, thread.activities) } : {}),
        projectId: creation?.projectId ?? old?.projectId ?? this.state.projectAliases.find(alias => alias.providerProjectId === thread.projectId)?.projectId ?? thread.projectId,
        workspaceSettledAt: old?.workspaceSettledAt ?? null, nativeSessionStarted: true })
    }
    const models = new Map(previous.models.map(model => [model.id, { ...model, ready: false }]))
    for (const model of snapshot.models) models.set(model.id, model)
    this.state.snapshot = { ...snapshot, models: [...models.values()], projects: [...projects.values()], threads: [...threads.values()] }
    this.dirty = true
  }
  private flush(): Promise<void> {
    // This write covers whatever a waiting one would have written, so it takes its place.
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = undefined }
    if (this.saving) return this.saving
    this.saving = Promise.resolve().then(async () => {
      try {
        while (this.dirty) {
          this.dirty = false
          const saved = structuredClone(this.state)
          if (!this.historyEnabled()) for (const thread of saved.snapshot.threads) {
            thread.messages = []
            thread.requests = []
            delete thread.activities
            if (thread.nativeSessionStarted) {
              thread.historyStatus = 'loading'
              delete thread.historyError
            }
          }
          try { await this.store.write(saved); this.saveError = undefined }
          catch (error) { this.dirty = true; throw error }
        }
      } finally { this.saving = undefined }
    })
    return this.saving
  }
  async privacyChanged(): Promise<void> { this.dirty = true; await this.flush() }
  async connect(provider?: ProviderId): Promise<AgentHostSnapshot> {
    await this.initialize(); this.accept(await this.inner.connect(provider)); await this.flush(); return this.workspaceSnapshot()
  }
  async snapshot(provider?: ProviderId): Promise<AgentHostSnapshot> {
    await this.initialize(); this.accept(await this.inner.snapshot(provider)); await this.flush(); return this.workspaceSnapshot()
  }
  async refreshThread(threadId: string): Promise<AgentHostSnapshot> {
    await this.initialize()
    const thread = this.thread(threadId)
    if (thread.nativeSessionStarted === false || !isThreadProviderConnected(this.state.snapshot, thread)) return this.workspaceSnapshot()
    const creation = this.state.creations.find(item => item.threadId === threadId)
    this.accept(await (creation && creation.phase !== 'started' ? this.inner.snapshot(thread.providerId)
      : this.inner.refreshThread?.(threadId) ?? this.inner.snapshot(thread.providerId)))
    await this.flush(); this.publish(); return this.workspaceSnapshot()
  }
  async setWorkspaceSettled(kind: 'project' | 'thread', id: string, settled: boolean): Promise<AgentHostSnapshot> {
    await this.initialize()
    const entity = (kind === 'project' ? this.state.snapshot.projects : this.state.snapshot.threads).find(item => item.id === id)
    if (!entity) throw new Error(`That ${kind} is unavailable.`)
    const previous = entity.workspaceSettledAt ?? null
    entity.workspaceSettledAt = settled ? previous ?? new Date().toISOString() : null
    this.dirty = true
    try { await this.flush() }
    catch (error) {
      const current = (kind === 'project' ? this.state.snapshot.projects : this.state.snapshot.threads).find(item => item.id === id)
      if (current) current.workspaceSettledAt = previous
      throw error
    }
    this.publish(); return this.workspaceSnapshot()
  }
  /**
   * The thread's new name, kept in Sotto's own workspace: the provider is never told, and its own
   * title stops overwriting this one. A blank name is the caller's to refuse before it gets here.
   */
  async renameThread(threadId: string, title: string, source: 'user' | 'generated' = 'user'): Promise<AgentHostSnapshot> {
    await this.initialize()
    const thread = this.thread(threadId)
    const previous = { title: thread.title, titleSource: thread.titleSource }
    thread.title = title
    thread.titleSource = source
    this.dirty = true
    try { await this.flush() }
    catch (error) { Object.assign(this.thread(threadId), previous); throw error }
    this.publish(); return this.workspaceSnapshot()
  }
  private thread(id: string): AgentThread {
    const thread = this.state.snapshot.threads.find(thread => thread.id === id)
    if (!thread) throw new Error('This thread is not known to Sotto. Refresh and select it again.')
    return thread
  }
  /** Starts working-copy setup, or returns the setup already running for this thread.
   * The checkout runs after `create-thread` has returned, so the pane appears at once; the
   * promise is also this thread's lane, so every later command queues behind it. */
  private startWorkingCopy(thread: AgentThread): Promise<void> {
    const existing = this.preparations.get(thread.id)
    if (existing) return existing
    const pending = this.prepareWorkingCopy(thread).catch(() => {
      this.saveError = 'Working-copy setup could not be saved. Restore local storage and retry setup.'
      this.publish()
    })
    this.preparations.set(thread.id, pending)
    this.lanes.set(thread.id, pending)
    void pending.finally(() => {
      if (this.preparations.get(thread.id) === pending) this.preparations.delete(thread.id)
      if (this.lanes.get(thread.id) === pending) this.lanes.delete(thread.id)
    }).catch(() => undefined)
    return pending
  }
  private async prepareWorkingCopy(thread: AgentThread): Promise<void> {
    if (!thread.worktree) return // Existing threads keep their native directory.
    // Native events can replace the thread object while Git is pending; always write the current one.
    const current = (): AgentThread => this.state.snapshot.threads.find(item => item.id === thread.id) ?? thread
    try {
      let metadata = current().worktree ?? thread.worktree
      if (!metadata.path) {
        const project = this.state.snapshot.projects.find(project => project.id === thread.projectId)
        if (!project) throw new Error('The original project is unavailable.')
        metadata = await this.worktrees.allocate(project.path, metadata.mode)
        current().worktree = metadata
        this.dirty = true
        await this.flush() // Allocation owns its exact path/branch before Git mutates anything.
      }
      metadata = await this.worktrees.ensure(metadata)
      const target = current()
      target.worktree = metadata
      target.workingDirectory = await this.worktrees.workingDirectory(metadata)
    } catch (error) {
      const target = current()
      target.worktree = { ...(target.worktree ?? thread.worktree), status: 'error', error: error instanceof Error ? error.message : 'Working-copy setup failed. Retry after restoring the folder and Git.' }
    }
    this.dirty = true; await this.flush(); this.publish()
  }
  async updateThreadWorktree(threadId: string, retry: boolean): Promise<AgentHostSnapshot> {
    const pending = (this.lanes.get(threadId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      await this.initialize()
      const thread = this.thread(threadId)
      if (retry && thread.nativeSessionStarted === false) await this.prepareWorkingCopy(thread)
      else if (thread.worktree) {
        // Native events can replace the thread object while Git is pending.
        let metadata = thread.worktree
        try { metadata = await this.worktrees.inspect(metadata) }
        catch (error) { metadata = { ...metadata, status: 'error', error: error instanceof Error ? error.message : 'The working folder is unavailable.' } }
        this.thread(threadId).worktree = metadata
        this.dirty = true; await this.flush(); this.publish()
      }
      return this.workspaceSnapshot()
    })
    this.lanes.set(threadId, pending)
    void pending.finally(() => { if (this.lanes.get(threadId) === pending) this.lanes.delete(threadId) }).catch(() => undefined)
    return pending
  }
  async threadWorkingDirectory(threadId: string): Promise<string> {
    await this.initialize()
    await this.preparations.get(threadId) // A folder question asked during setup waits for its answer.
    const thread = this.thread(threadId)
    if (thread.worktree?.status === 'ready' && thread.worktree.mode === 'independent') {
      const inspected = await this.worktrees.inspect(thread.worktree)
      // A branch switched inside the worktree is adopted, so the pane's label follows it (ADR-0014).
      if (inspected.branch !== thread.worktree.branch) {
        this.thread(threadId).worktree = inspected; this.dirty = true
        // The folder was just verified; a cache write that fails must not refuse the send.
        try { await this.flush() } catch { this.saveError = 'The branch name could not be saved. Restore local storage and refresh.' }
        this.publish()
      }
    }
    return existingWorkingDirectory(resolveThreadWorkingDirectory(thread, this.state.snapshot.projects.find(project => project.id === thread.projectId)))
  }
  execute(command: AgentHostCommand): Promise<AgentHostResult> {
    const key = 'threadId' in command ? command.threadId : command.projectId
    const pending = (this.lanes.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => this.executeOne(command))
    this.lanes.set(key, pending)
    void pending.finally(() => { if (this.lanes.get(key) === pending) this.lanes.delete(key) }).catch(() => undefined)
    return pending
  }
  private async executeOne(command: AgentHostCommand): Promise<AgentHostResult> {
    await this.initialize()
    if ('threadId' in command && command.type !== 'create-thread' && command.type !== 'interrupt' && await this.checkpointHooks?.isBlocked(command.threadId)) throw new Error('Wait for Git changes or resolve the interrupted checkpoint revert before changing this thread.')
    if ((command.type === 'send' || command.type === 'steer') && command.skills?.length) {
      const thread = this.thread(command.threadId)
      const capabilities = this.state.snapshot.providers?.find(provider => provider.id === thread.providerId)?.capabilities ?? this.state.snapshot.capabilities
      if (!capabilities.skills || !this.inner.listThreadSkills) throw new Error('Selected skills are unavailable or belong to another provider. Refresh this draft’s skill catalog.')
      const catalog = await this.listThreadSkills(command.threadId, true)
      if (catalog.status !== 'ready' || catalog.providerId !== thread.providerId || command.skills.some(selected => !catalog.skills.some(skill => skill.name === selected.name && skill.path === selected.path && skill.enabled !== false && skill.userInvocable !== false))) {
        throw new Error('Selected skills are unavailable or belong to another provider. Refresh this draft’s skill catalog.')
      }
    }
    if (command.type === 'create-project') {
      const result = await this.inner.execute(command)
      // The existing coordinator reconciles creation; a cache failure cannot change
      // an acknowledged/uncertain native result into a definitive rejection.
      try { this.accept(await this.inner.snapshot(command.provider)); await this.flush() }
      catch { this.saveError = 'Refresh to confirm the project and save workspace history.' }
      return result
    }
    if (command.type === 'create-thread') {
      if (this.state.snapshot.threads.some(thread => thread.id === command.threadId)) throw new Error('This thread already exists. Select it instead of creating it again.')
      if (!this.state.snapshot.projects.some(project => project.id === command.projectId)) throw new Error('Choose an available project.')
      validateThreadOptions(this.state.snapshot, command)
      const model = this.state.snapshot.models.find(model => model.id === command.modelId)!
      this.requireCreation(model.providerId)
      const thread: AgentThread = { id: command.threadId, projectId: command.projectId, title: command.title, modelId: command.modelId,
        titleSource: command.titleSource ?? 'default',
        ...(model.providerId ? { providerId: model.providerId } : {}),
        ...(command.reasoningEffort ?? model.defaultReasoningEffort ? { reasoningEffort: command.reasoningEffort ?? model.defaultReasoningEffort! } : {}),
        ...(command.runtimeMode ? { runtimeMode: command.runtimeMode } : {}),
        worktree: { mode: command.workingCopy ?? 'independent', status: 'pending' },
        status: 'idle', messages: [], requests: [], workspaceSettledAt: null, nativeSessionStarted: false }
      this.state.snapshot.threads.push(thread)
      this.state.creations.push({ threadId: thread.id, projectId: thread.projectId, commandId: randomUUID(), phase: 'unstarted' })
      this.dirty = true
      try { await this.flush() }
      catch (error) {
        this.state.snapshot.threads = this.state.snapshot.threads.filter(item => item.id !== thread.id)
        this.state.creations = this.state.creations.filter(item => item.threadId !== thread.id)
        throw error
      }
      this.publish()
      // The local thread is already durable, so creation is accepted here and the pane appears at once.
      // The checkout continues in the background and publishes its own pending/ready/error status;
      // setup failure is shown on the thread's working copy, never a silent success or a late rejection.
      void this.startWorkingCopy(thread).catch(() => undefined)
      return { accepted: true }
    }
    let thread = this.thread(command.threadId)
    const creation = this.state.creations.find(item => item.threadId === thread.id)
    if (command.type === 'configure-thread' && creation?.phase === 'unstarted') {
      validateThreadOptions(this.state.snapshot, command, thread.modelId)
      const model = this.state.snapshot.models.find(model => model.id === (command.modelId ?? thread.modelId))!
      this.requireCreation(model.providerId)
      const previous = structuredClone(thread)
      if (command.modelId !== undefined) {
        thread.modelId = model.id
        if (model.providerId) thread.providerId = model.providerId
        delete thread.reasoningEffort
        if (model.defaultReasoningEffort) thread.reasoningEffort = model.defaultReasoningEffort
        if (thread.runtimeMode && !model.runtimeModes?.includes(thread.runtimeMode)) delete thread.runtimeMode
      }
      if (command.reasoningEffort !== undefined) thread.reasoningEffort = command.reasoningEffort
      if (command.runtimeMode !== undefined) thread.runtimeMode = command.runtimeMode
      this.dirty = true
      try { await this.flush() }
      catch (error) { Object.keys(thread).forEach(key => { delete (thread as unknown as Record<string, unknown>)[key] }); Object.assign(thread, previous); throw error }
      this.publish(); return { accepted: true }
    }
    if (command.type === 'send' && creation && creation.phase !== 'started') {
      if (creation.phase === 'starting') {
        await this.refreshThread(thread.id)
        if (this.state.creations.find(item => item.threadId === thread.id)?.phase !== 'started') throw new Error('Native thread creation is not confirmed. Reconnect its original provider and refresh; Sotto will not create it twice. Your prompt has not been sent.')
      } else {
        // Waits for setup already running from creation; only an unstarted or failed one starts here.
        if (thread.worktree?.status !== 'ready') await this.startWorkingCopy(thread)
        thread = this.thread(command.threadId)
        const workingDirectory = await this.threadWorkingDirectory(thread.id)
        validateThreadOptions(this.state.snapshot, thread)
        this.requireCreation(thread.providerId)
        const priorPhase = creation.phase
        creation.phase = 'starting'; thread.nativeSessionStarted = true; this.dirty = true
        try { await this.flush() }
        catch (error) { creation.phase = priorPhase; thread.nativeSessionStarted = priorPhase !== 'unstarted'; throw error }
        this.publish()
        const project = this.state.snapshot.projects.find(project => project.id === thread.projectId)!
        // This creation intent is durable separately from AgentControl's prompt outbox.
        // A failure here precedes prompt dispatch; retry may observe but never replay creation.
        const rejected = async (): Promise<void> => {
          // A definitive rejection permits another attempt. Preserve any identity
          // already reserved by the registry; only an entirely unbound thread unlocks.
          const current = this.thread(thread.id)
          if (this.state.creations.find(item => item.threadId === thread.id)?.phase === 'started') return
          creation.phase = this.inner.providerForThread?.(thread.id) ? 'retryable' : 'unstarted'
          current.nativeSessionStarted = creation.phase !== 'unstarted'
          this.dirty = true; await this.flush(); this.publish()
        }
        let result: AgentHostResult
        try {
          result = await this.inner.execute({ type: 'create-thread', commandId: creation.commandId, threadId: thread.id,
            projectId: thread.projectId, project, title: thread.title, modelId: thread.modelId,
            workingDirectory,
            ...(thread.reasoningEffort ? { reasoningEffort: thread.reasoningEffort } : {}),
            ...(thread.runtimeMode ? { runtimeMode: thread.runtimeMode } : {}) })
        } catch (error) { await rejected(); throw error }
        if (!result.accepted && !result.uncertain) { await rejected(); throw new Error('The provider rejected thread creation. Check its connection and settings, then retry your prompt.') }
        this.accept(await this.inner.snapshot(thread.providerId)); await this.flush()
        if (!result.accepted || this.state.creations.find(item => item.threadId === thread.id)?.phase !== 'started') throw new Error('Native thread creation is not confirmed. Refresh its original provider; your prompt has not been sent.')
      }
      thread = this.thread(command.threadId)
    }
    if (thread.nativeSessionStarted === false) throw new Error('This thread has no native work yet.')
    if (command.type === 'configure-thread') {
      if (creation && creation.phase !== 'started') throw new Error('Native thread creation is not confirmed. Refresh or retry the first prompt with its original provider before changing settings.')
      const capabilities = this.state.snapshot.providers?.find(provider => provider.id === thread.providerId)?.capabilities ?? this.state.snapshot.capabilities
      if (!capabilities.configureThread) throw new Error('This provider does not support changing thread settings.')
      if (thread.status === 'running' || thread.requests.length) throw new Error('Wait for this thread to finish and answer its pending requests before changing settings.')
      validateThreadOptions(this.state.snapshot, command, thread.modelId)
      if (command.modelId && this.state.snapshot.models.find(model => model.id === command.modelId)?.providerId !== thread.providerId) throw new Error('Existing sessions cannot move between providers.')
    }
    // Native command uncertainty belongs to the existing outbox; do not add a failing
    // history read after dispatch that could turn unknown delivery into a rejection.
    // Never send into a deleted/failed working copy, even if the native client is still live.
    if (command.type === 'send' || command.type === 'steer') await this.threadWorkingDirectory(thread.id)
    if (command.type === 'send') await this.checkpointHooks?.beforeTurn(thread.id)
    return this.inner.execute(command)
  }
  private requireCreation(provider?: ProviderId): void {
    const status = this.state.snapshot.providers?.find(item => item.id === provider)
    if (!(status ? status.connection === 'connected' && status.capabilities.threads : this.state.snapshot.connected && this.state.snapshot.capabilities.threads)) throw new Error('Choose a ready provider that can create threads.')
  }
  createProjectId(provider: ProviderId): string { return this.inner.createProjectId?.(provider) ?? randomUUID() }
  resolveProjectId(id: string): string { return this.inner.resolveProjectId?.(id) ?? id }
  resolveModelId(id: string): string { return this.inner.resolveModelId?.(id) ?? id }
  providerForThread(id: string): ProviderId | undefined { return this.state.snapshot.threads.find(thread => thread.id === id)?.providerId ?? this.inner.providerForThread?.(id) }
  observeThreads(ids: readonly string[]): void { this.inner.observeThreads?.(ids.filter(id => this.state.snapshot.threads.find(thread => thread.id === id)?.nativeSessionStarted !== false)) }
  disconnect(provider?: ProviderId): void {
    this.inner.disconnect(provider)
    const snapshot = this.state.snapshot
    snapshot.providers?.filter(item => !provider || item.id === provider).forEach(item => { item.connection = 'disconnected' })
    snapshot.models.filter(model => !provider || model.providerId === provider).forEach(model => { model.ready = false })
    snapshot.connected = snapshot.providers?.some(item => item.connection === 'connected') ?? false
    this.dirty = true
    void this.flush().catch(() => { this.saveError = 'Workspace history could not be saved. Restore access to local storage and refresh.'; this.publish() })
    this.publish()
  }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
}
