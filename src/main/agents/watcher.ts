import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { capabilitiesForThread, isThreadProviderConnected, lastUserMessageIdOf,
  type AgentCommand, type AgentHostSnapshot, type AgentModel, type AgentThread } from '../../shared/agents'
import { resolveModel } from '../../shared/modelCatalog'
import { nearestReasoningEffort, RUNTIME_MODE_ORDER, resolveNewThreadPermission } from '../../shared/newThreadDefaults'
import { isThreadClosed, isWorkspaceThreadSettled } from '../../shared/threadActivity'
import { watcherOverview, type WatcherObservation } from '../../shared/watcherOverview'
import { WATCHER_PARTICIPATION_HISTORY_MAX, WATCHER_PROMPTS_PER_THREAD, WATCHER_READ_BYTES_MAX, watcherToolSchemas,
  type WatcherIdentity, type WatcherOperation, type WatcherRecord, type WatcherRefusal, type WatcherThreadTarget,
  type WatcherToolInput, type WatcherToolName } from '../../shared/watcher'
import { watcherOpenRequestSchema, WATCHER_STOP_ALL_PREVIEW_LIMIT, type WatcherOpenRequest, type WatcherRoomResult, type WatcherRoomState,
  type WatcherPrepareStopAllResult, type WatcherStopAllResult } from '../../shared/watcherRoom'
import type { AgentHostCommand } from './host'
import type { AgentControl } from './control'
import type { WorkspaceHost } from './workspace'
import { WatcherWakeUp, watcherProgressFingerprint } from './watcherWakeUp'
import type { WatcherEvent } from '../../shared/watcherNews'
import type { CheckpointObservation, PullRequestObservation } from './watcherEvidence'
import type { WatcherCommand, WatcherCommandOrigin, WatcherControlHooks } from './watcherCommands'
import { watcherDisplayPrompt } from './watcherMessageDisplay'
import { watcherHostControlSchema, watcherHostReadSchema, type WatcherHostControl, type WatcherHostRead, type WatcherHostProjection, type WatcherRemoteHosts } from '../../shared/watcherHost'

const now = () => new Date().toISOString()
const key = (target: WatcherThreadTarget) => JSON.stringify([target.hostId, target.threadId])
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const watcherGuidancePrefix = (requestId: string, hostId: string): string =>
  `[Sotto Watcher request: ${requestId}. Local host: ${hostId}. Use this requestId for sotto_threads mutations. Known project IDs: `
export const WATCHER_GUIDANCE_SUFFIX = '. Call list_projects for choices.]'
export function watcherRefusal(code: WatcherRefusal['code'], message: string, retryable = false): WatcherRefusal {
  return { status: 'refused', code, message, retryable }
}
class Refusal extends Error {
  constructor(readonly result: WatcherRefusal) { super(result.message) }
}
function refuse(code: WatcherRefusal['code'], message: string, retryable = false): never { throw new Refusal({ ...watcherRefusal(code, message, retryable), ...(code === 'CURSOR_EXPIRED' ? { restartCursor: 'restart' } : {}) }) }

/** One main-owned admission transaction; provider work always runs after this lane is released. */
export class WatcherService implements WatcherControlHooks {
  readonly wakes: WatcherWakeUp
  private tail: Promise<unknown> = Promise.resolve()
  private opening: Promise<WatcherRoomResult> | undefined
  private recoveryNotice: string | null = null
  private readonly listeners = new Set<(state: WatcherRoomState) => void>()
  private readonly active = new Map<string, Promise<unknown>>()
  private invocations = 0
  private changing = false
  private readonly dispatchRefusals = new Map<string, Refusal>()
  private readonly nativeHeads = new Map<string, string | null>()
  private readonly confirmations = new Map<string, { targets: WatcherThreadTarget[]; signature: string; expires: number; phoneClientId: string | undefined }>()
  private readonly pages = new Map<string, { kind: string; rows: unknown[]; expires: number; workingCopies?: { revision: string; baseRefs: { choiceId: string; name: string }[] } }>()
  private readonly copyChoices = new Map<string, { projectId: string; path?: string; branch?: string; revision: string; snapshotId: string }>()
  private closed = false
  private remote: WatcherRemoteHosts | undefined
  private remoteOff: (() => void) | undefined
  private readonly remoteProgress = new Map<string, { hostId: string; fingerprint: string }>()
  private readonly remoteGuards = new Map<string, () => void>()
  private readonly unsubscribe: () => void
  constructor(private readonly options: { directory: string; control: AgentControl; host: WorkspaceHost;
    limit: () => number; historyEnabled: () => boolean; workerHost?: boolean; revoke?: (id: string) => void }) {
    this.wakes = new WatcherWakeUp({ snapshot: () => this.snapshot(), record: () => this.record(),
      progress: target => this.remoteProgress.get(key(target))?.fingerprint,
      restoredEvents: () => options.control.restoredWatcherEvents(),
      canDeliver: target => options.control.canDeliverWatcherNews(target),
      deliver: news => options.control.deliverWakeUp(news.watcher.threadId, news, { tool: false }),
      prune: () => options.control.pruneWatcherWakeUps(), remember: ids => options.control.updateWatcher(record => { record.wakeEventIds = [...new Set([...record.wakeEventIds ?? [], ...ids])].slice(-1_000) }),
      changed: () => this.publish(), failed: () => { this.recoveryNotice = 'Watcher news could not be saved. Reconnect or refresh its threads to retry. Nothing was approved.' } })
    const unhook = options.control.useWatcher(this), unsubscribe = options.control.subscribe(() => this.publish())
    this.unsubscribe = () => { unhook(); unsubscribe() }
  }
  private record(): WatcherRecord { return this.options.control.watcherRecord() }
  private hostId(): string { const id = this.options.control.hostId(); if (!id) refuse('HOST_DISCONNECTED', 'This computer is not ready. Reconnect its provider.', true); return id }
  private target(threadId: string): WatcherThreadTarget { return { hostId: this.hostId(), threadId } }
  phoneSnapshot(): AgentHostSnapshot { return this.snapshot() }
  private owningSnapshot(hostId: string): AgentHostSnapshot | undefined {
    return hostId === this.hostId() ? this.options.control.watcherSnapshot() : this.remote?.snapshot(hostId)
  }
  private snapshot() {
    const local = this.options.control.watcherSnapshot(), others = this.remote?.hosts().flatMap(host => this.owningSnapshot(host.hostId) ?? []) ?? []
    return { ...local, connected: local.connected || others.some(host => host.connected),
      clientHosts: [local, ...others].map(host => ({ hostId: host.hostId ?? this.hostId(), connected: host.connected, models: host.models, capabilities: host.capabilities, providers: host.providers })),
      threads: [local, ...others].flatMap(host => host.threads.map(thread => ({ ...thread, clientConnected: host.connected && isThreadProviderConnected(host, thread) }))),
      projects: [...local.projects, ...others.flatMap(host => host.projects.map(project => ({ ...project, hostId: host.hostId })))] }
  }
  useRemoteHosts(remote: WatcherRemoteHosts): void {
    this.remoteOff?.(); this.remote = remote
    this.remoteOff = remote.subscribe((hostId, force = true) => this.scheduleRemote(hostId, force))
    void this.reconcileRemote().catch(() => undefined)
  }
  private thread(target: WatcherThreadTarget): AgentThread {
    const snapshot = this.owningSnapshot(target.hostId)
    if (!snapshot) refuse('HOST_DISCONNECTED', 'That host is disconnected. Reconnect it before continuing.', true)
    const thread = snapshot.threads.find(item => item.id === target.threadId)
    if (!thread) refuse('UNKNOWN_TARGET', 'That thread is unavailable. Read the thread list again.')
    return thread
  }
  private checkCaller(threadId: string): void {
    if (this.closed || this.options.workerHost || this.record().current?.target.threadId !== threadId || this.record().current?.target.hostId !== this.hostId()
      || this.options.control.watcherSnapshot().threads.some(item => item.id === threadId && item.kind !== 'watcher')) refuse('NOT_CURRENT_WATCHER', 'Only the current Watcher can use these tools. Open Watcher to continue.')
  }
  isCurrent(threadId: string): boolean {
    try { this.checkCaller(threadId); return true } catch { return false }
  }
  subscribe(listener: (state: WatcherRoomState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private publish(): void { if (!this.closed) { if (!this.options.workerHost) this.wakes.observe(); this.options.control.refreshWatcherObservation(); for (const listener of this.listeners) listener(this.state()) } }
  watchedThreadIds(): string[] {
    return [...new Set([...this.wakes.watchedThreadIds(this.hostId()).filter(id => this.options.control.watcherSnapshot().threads.some(thread => thread.id === id)),
      ...this.record().requests.filter(request => request.remoteOrigin && request.state === 'active').flatMap(request => request.participants.filter(item => item.target.hostId === this.hostId() && item.state === 'participating' && !item.automationStopped).map(item => item.target.threadId))])]
  }
  wakeDue(event: WatcherEvent): boolean { return this.wakes.due(event) }
  wakeReady(): boolean { return this.wakes.ready() }
  pullRequestObserved(read: PullRequestObservation): void { this.wakes.pullRequest(read) }
  restoreCheckpoint(read: CheckpointObservation): void { this.wakes.restoreCheckpoint(read) }
  checkpointObserved(read: CheckpointObservation): void { this.wakes.checkpoint(read) }
  private transaction<T>(work: () => Promise<T>): Promise<T> {
    const task = this.tail.catch(() => undefined).then(work); this.tail = task; return task
  }
  private reservedProject(path: string): boolean {
    const normalized = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
    return [join(this.options.directory, 'watcher', 'workspace'), join(this.options.directory, 'host-setup')].some(folder => normalized(path) === normalized(folder))
  }
  private protectedThread(thread: AgentThread): boolean {
    return Boolean(thread.kind && thread.kind !== 'project' || this.owningSnapshot(thread.hostId ?? this.hostId())?.projects.some(project => project.id === thread.projectId && this.reservedProject(project.path)))
  }
  private protect(thread: AgentThread): void {
    if (this.protectedThread(thread)) refuse('RESERVED_THREAD', 'This thread has a special job and cannot be directed by Watcher.')
    if (isThreadClosed(thread)) refuse('TARGET_CHANGED', 'This thread is closed. Open another thread.')
  }
  private connected(thread: AgentThread): boolean {
    const snapshot = this.owningSnapshot(thread.hostId ?? this.hostId())
    return Boolean(snapshot && isThreadProviderConnected(snapshot, thread) && thread.clientConnected !== false)
  }
  private pending(thread: AgentThread): void { if (thread.requests.length) refuse('PENDING_USER_REQUEST', 'This thread needs your answer. Open its own request card. Nothing was sent.') }
  private permission(model: AgentModel | undefined, explicit?: WatcherToolInput<'start_thread'>['permission'], pairedCeiling?: WatcherHostControl['ceiling']) {
    const configured = this.options.control.configuration().newThreadRuntimeMode ?? 'approval-required'
    const desired = pairedCeiling && RUNTIME_MODE_ORDER.indexOf(pairedCeiling) < RUNTIME_MODE_ORDER.indexOf(configured) ? pairedCeiling : configured
    const ceiling = resolveNewThreadPermission(model, desired)
    if (ceiling.providerMode !== undefined) {
      const mode = model?.providerModes?.find(item => item.id === ceiling.providerMode)
      if (mode?.allows !== 'nothing' || explicit && (explicit.kind !== 'provider' || explicit.choiceId !== ceiling.providerMode)) {
        refuse('PERMISSION_NOT_COMPARABLE', 'This provider’s permission profile cannot be compared safely. Choose a provider with an asking mode.')
      }
      return { kind: 'provider' as const, choiceId: ceiling.providerMode }
    }
    if (!ceiling.runtimeMode) refuse('PERMISSION_NOT_COMPARABLE', 'This model has no comparable permission mode. Choose another model.')
    if (explicit?.kind === 'provider') refuse('PERMISSION_NOT_COMPARABLE', 'This permission choice cannot be compared with the new-thread default.')
    const mode = explicit?.mode ?? ceiling.runtimeMode
    if (!model?.runtimeModes?.includes(mode)) refuse('PERMISSION_NOT_COMPARABLE', 'This model does not offer that permission mode.')
    if (RUNTIME_MODE_ORDER.indexOf(mode) > RUNTIME_MODE_ORDER.indexOf(ceiling.runtimeMode)) refuse('PERMISSION_TOO_WIDE', 'Watcher cannot give a thread more permission than your new-thread default.')
    return { kind: 'runtime' as const, mode }
  }
  private checkPermission(thread: AgentThread): void {
    const model = resolveModel(this.owningSnapshot(thread.hostId ?? this.hostId())?.models ?? [], thread.modelId)
    const permission = thread.providerMode ? { kind: 'provider' as const, choiceId: thread.providerMode }
      : { kind: 'runtime' as const, mode: thread.runtimeMode ?? 'approval-required' as const }
    this.permission(model, permission)
  }
  private checkRemoteCeiling(requestId: string, mode: string | undefined): void {
    const ceiling = this.record().requests.find(request => request.id === requestId)?.remoteOrigin?.ceiling
    // permission/checkPermission already admits only a provider profile whose allows is nothing.
    if (ceiling && RUNTIME_MODE_ORDER.indexOf((mode ?? 'approval-required') as typeof ceiling) > RUNTIME_MODE_ORDER.indexOf(ceiling)) refuse('PERMISSION_TOO_WIDE', 'The worker exceeds the master’s new-thread permission default. Nothing was sent.')
  }
  private checkSettlement(thread: AgentThread): void {
    this.pending(thread)
    if (thread.status === 'running') refuse('THREAD_BUSY', 'Wait for this thread to finish before settling it.')
    if (thread.backgroundWork?.length || thread.monitoring?.length) refuse('BACKGROUND_WORK_RUNNING', 'This thread still has background work. Stop it explicitly before settling.')
  }
  private inFlight(record = this.record()): number { return new Set(record.reservations.map(item => key(item.target))).size }
  private limits(operation: WatcherOperation) {
    const record = this.record()
    return { inFlight: this.inFlight(record), inFlightLimit: this.options.limit(), promptCount: record.requests.find(item => item.id === operation.requestId)
      ?.participants.find(item => key(item.target) === key(operation.target))?.promptCount ?? 0, promptLimit: WATCHER_PROMPTS_PER_THREAD }
  }
  private receipt(operation: WatcherOperation) {
    return { operationId: operation.id, target: operation.target, requestId: operation.requestId, deliveryState: operation.deliveryState,
      receiptId: operation.receiptId, cardId: operation.cardId, ...(operation.draftId ? { draftId: operation.draftId } : {}),
      ...(operation.messageId ? { messageId: operation.messageId } : {}), ...(operation.itemId ? { itemId: operation.itemId } : {}) }
  }
  private operationState(target: WatcherThreadTarget) {
    let thread: AgentThread | undefined
    try { thread = this.thread(target) } catch { /* Unavailable is distinct from stopped. */ }
    return { status: thread?.status ?? 'unavailable' as const, stopped: thread?.status === 'idle' && !thread.requests.length,
      settled: Boolean(thread && isWorkspaceThreadSettled(thread, this.owningSnapshot(target.hostId)?.projects.find(item => item.id === thread!.projectId))),
      backgroundWorkCount: (thread?.backgroundWork?.length ?? 0) + (thread?.monitoring?.length ?? 0), observedAt: thread ? now() : null,
      freshness: thread && this.connected(thread) ? 'fresh' as const : 'stale' as const }
  }
  state(): WatcherRoomState {
    const record = this.record()
    const current = this.options.control.watcherSnapshot().threads.find(item => item.id === record.current?.target.threadId)
    const targets = new Map(record.requests.flatMap(request => request.participants.map(item => [key(item.target), item.target] as const)))
    return { current: record.current, currentOptions: current ? { modelId: current.modelId, reasoningEffort: current.reasoningEffort ?? null,
      status: current.status, connected: this.connected(current) } : null, history: record.history, requests: record.requests,
      watchedThreads: [...targets.values()].map(target => {
        const thread = this.owningSnapshot(target.hostId)?.threads.find(item => item.id === target.threadId)
        return { target, title: thread?.title ?? 'Unavailable thread', status: thread?.status ?? 'unavailable', connected: Boolean(thread && this.connected(thread)),
          settled: Boolean(thread && isWorkspaceThreadSettled(thread, this.owningSnapshot(target.hostId)?.projects.find(item => item.id === thread.projectId))),
          backgroundWorkCount: (thread?.backgroundWork?.length ?? 0) + (thread?.monitoring?.length ?? 0),
          evidence: this.wakes.evidence.read(target, Boolean(thread && this.connected(thread))),
          ...(thread && this.wakes.observations.get(JSON.stringify([thread.hostId ?? null, thread.id])) ? { observation: this.roomObservation(this.wakes.observations.get(JSON.stringify([thread.hostId ?? null, thread.id]))!) } : {}),
          waitsOn: thread?.requests.map(request => ({ id: request.id, kind: request.kind, openTarget: target })) ?? [],
          participation: record.requests.flatMap(request => request.participants.filter(item => key(item.target) === key(target))) }
      }), inFlight: this.inFlight(record), inFlightLimit: this.options.limit(), receipts: record.operations,
      news: this.wakes.news(), recoveryNotice: this.recoveryNotice, observedAt: now() }
  }
  private roomObservation(observation: WatcherObservation) { const { landing: _landing, ...result } = observation; void _landing; return result }
  get(): WatcherRoomResult { return { status: 'ok', state: this.state() } }

  async recover(): Promise<void> {
    try {
      const record = this.record()
      if (record.creation && !this.options.workerHost) await this.finishCreation(record.creation.identity, record.creation.modelId ? { provider: record.creation.identity.provider, modelId: record.creation.modelId, ...(record.creation.reasoningEffort ? { reasoningEffort: record.creation.reasoningEffort } : {}) } : undefined)
      const current = this.record().current
      if (current && !this.options.workerHost && (this.thread(current.target).kind !== 'watcher' || this.thread(current.target).providerId !== current.provider)) {
        refuse('NOT_CURRENT_WATCHER', 'Watcher’s saved thread does not match its identity. Nothing was started. Restore its saved records before continuing.')
      }
      await this.options.control.updateWatcher(next => {
        for (const operation of next.operations) {
          if (operation.deliveryState === 'dispatching') operation.deliveryState = 'uncertain'
          if (!this.options.historyEnabled() && operation.deliveryState === 'queued') {
            operation.deliveryState = 'failed'; operation.refusalCode = 'HISTORY_UNAVAILABLE'
          }
        }
      })
      this.observe(this.options.control.watcherSnapshot(), new Set())
    } catch { this.recoveryNotice = 'Watcher could not be recovered safely. Nothing was started. Restore its saved records and reopen Watcher.' }
    if (!this.options.workerHost) this.wakes.start()
    this.publish()
  }
  open(input: WatcherOpenRequest): Promise<WatcherRoomResult> {
    if (this.opening) return this.opening
    this.opening = this.openOne(input).finally(() => { this.opening = undefined })
    return this.opening
  }
  private async openOne(input: WatcherOpenRequest): Promise<WatcherRoomResult> {
    try {
      if (this.options.workerHost) refuse('HOST_FEATURE_UNAVAILABLE', 'Open Watcher on the desktop that coordinates this host.')
      const parsed = watcherOpenRequestSchema.safeParse(input)
      if (!parsed.success) refuse('INVALID_INPUT', 'Choose a supported Watcher provider, model and effort.')
      input = parsed.data
      if (this.closed) refuse('NOT_CURRENT_WATCHER', this.recoveryNotice ?? 'Watcher is stopping. Reopen Sotto.')
      const model = resolveModel(this.options.control.watcherSnapshot().models, input.modelId)
      if (!model?.ready || model.providerId !== input.provider) refuse('PROVIDER_UNAVAILABLE', 'Connect the chosen provider and choose one of its ready models.', true)
      if (input.reasoningEffort && !model.reasoningEfforts?.includes(input.reasoningEffort)) refuse('INVALID_INPUT', 'Choose an effort this model offers.')
      const record = this.record(), previous = record.current
      if (record.creation) {
        if (record.creation.identity.provider !== input.provider || record.creation.modelId !== input.modelId
          || record.creation.reasoningEffort !== input.reasoningEffort) refuse('TARGET_CHANGED', 'Watcher creation is pending with another choice. Reopen that choice before changing it.')
        await this.finishCreation(record.creation.identity, input)
        this.recoveryNotice = null; return this.get()
      }
      if (previous) {
        const thread = this.thread(previous.target)
        if (thread.kind !== 'watcher' || thread.providerId !== previous.provider || thread.projectId !== previous.projectId) refuse('NOT_CURRENT_WATCHER', 'The saved Watcher identity does not match its thread. Nothing was changed.')
        if (previous.provider === input.provider && thread.modelId === input.modelId
          && (!input.reasoningEffort || thread.reasoningEffort === input.reasoningEffort)) return this.get()
        if (thread.status === 'running' || thread.requests.length || this.invocations || this.active.size || previous.provider !== input.provider && this.inFlight(record) > 0 || this.options.control.hasPendingThreadWork(thread.id)
          || record.operations.some(operation => ['queued', 'dispatching', 'uncertain'].includes(operation.deliveryState))) {
          refuse('THREAD_BUSY', 'Wait for Watcher and its pending deliveries before changing its provider, model or effort.', true)
        }
        this.changing = true
        if (previous.provider === input.provider) {
          if (thread.modelId !== input.modelId || input.reasoningEffort && thread.reasoningEffort !== input.reasoningEffort) {
            const result = await this.options.control.commandForWatcherRoom({ type: 'configure-thread', threadId: thread.id,
              modelId: input.modelId, ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}) })
            if (result.error) refuse('PROVIDER_UNAVAILABLE', 'Watcher’s model or effort could not be changed. Check its provider and reopen Watcher.', true)
          }
          return this.get()
        }
      }
      const folder = join(this.options.directory, 'watcher', 'workspace')
      await mkdir(folder, { recursive: true })
      let project = this.options.control.watcherSnapshot().projects.find(item => resolve(item.path) === resolve(folder) && item.providerId === input.provider)
      if (!project) {
        const created = await this.options.control.commandForWatcherRoom({ type: 'create-project', provider: input.provider, title: 'Watcher', path: folder, useExisting: true })
        project = this.options.control.watcherSnapshot().projects.find(item => resolve(item.path) === resolve(folder) && (!item.providerId || item.providerId === input.provider))
        if (!project || created.error) refuse('PROVIDER_UNAVAILABLE', 'Watcher’s working folder could not be opened. Check its provider and try again.', true)
      }
      const identity: WatcherIdentity = { target: this.target(randomUUID()), projectId: project.id, provider: input.provider,
        creationOperationId: randomUUID(), createdAt: now() }
      await this.options.control.updateWatcher(next => {
        next.creation = { identity, modelId: input.modelId, ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}), phase: 'intent', replaces: previous?.target ?? null }
        // The old native conversation keeps its binding. New profile admission follows the durable reference.
        if (previous) next.history.push(previous)
        next.current = identity
        next.creation.replaces = null
      })
      if (previous) { this.options.revoke?.(previous.target.threadId); await this.options.host.setWatcherKind(previous.target.threadId, 'watcher-history') }
      await this.finishCreation(identity, input)
      this.publish(); return this.get()
    } catch (error) { return error instanceof Refusal ? error.result : watcherRefusal('PROVIDER_UNAVAILABLE', 'Watcher could not be opened. Nothing was sent. Check its provider and reopen Watcher.', true) }
    finally { this.changing = false }
  }
  private async finishCreation(identity: WatcherIdentity, input?: WatcherOpenRequest): Promise<void> {
    let thread = this.options.control.watcherSnapshot().threads.find(item => item.id === identity.target.threadId)
    if (!thread) {
      const model = input ? resolveModel(this.options.control.watcherSnapshot().models, input.modelId)
        : this.options.control.watcherSnapshot().models.find(item => item.providerId === identity.provider && item.ready)
      // A creation intent with no thread has no saved model choice. Refuse recovery instead of picking another model.
      if (!input || !model) refuse('PROVIDER_UNAVAILABLE', 'Watcher creation stopped before its model was saved. Reopen Watcher with the same choice.')
      const result = await this.options.control.commandForWatcherRoom({ type: 'create-thread', threadId: identity.target.threadId,
        projectId: identity.projectId, title: 'Watcher', modelId: model.id, runtimeMode: 'approval-required', workingCopy: 'shared',
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}) })
      if (result.error) refuse('PROVIDER_UNAVAILABLE', 'Watcher’s thread could not be created. Check its provider and reopen Watcher.', true)
      thread = result.host.threads.find(item => item.id === identity.target.threadId)
    }
    if (!thread || thread.kind !== 'watcher' || thread.providerId !== identity.provider || thread.projectId !== identity.projectId) {
      refuse('NOT_CURRENT_WATCHER', 'Watcher’s saved identity conflicts with its thread. Nothing was started.')
    }
    await this.options.control.updateWatcher(next => { if (next.creation?.identity.target.threadId === identity.target.threadId) next.creation = null })
  }

  guardPhoneSend(threadId: string): void {
    this.checkCaller(threadId)
    if (this.changing) refuse('THREAD_BUSY', 'Wait for Watcher’s provider change before sending an instruction.', true)
  }
  userCommand(command: AgentCommand, threadId: string | undefined, answersQuestion: boolean): void {
    if (!threadId || answersQuestion) return
    if (threadId === this.record().current?.target.threadId && this.changing) refuse('THREAD_BUSY', 'Wait for Watcher’s provider change before sending an instruction.', true)
    if (threadId === this.record().current?.target.threadId && command.type === 'queue-followup' && command.draftId) {
      const latest = this.record().requests.findLast(item => item.watcher.threadId === threadId)
      if (!latest) refuse('REQUEST_NOT_ACTIVE', 'Send an instruction to Watcher before queuing a continuation.')
      if ((latest.userFollowups?.length ?? 0) >= 1_000) refuse('REQUEST_NOT_ACTIVE', 'This request has too many queued continuations. Send a new instruction instead.')
      this.options.control.mutateWatcher(record => {
        const request = record.requests.findLast(item => item.watcher.threadId === threadId)
        if (request && (request.userFollowups?.length ?? 0) < 1_000) {
          request.userFollowups ??= []
          if (!request.userFollowups.some(item => item.draftId === command.draftId)) request.userFollowups.push({ draftId: command.draftId! })
        }
      })
    }
    const reason = ['send', 'manual-send', 'queue-followup', 'steer', 'steer-followup'].includes(command.type) ? 'user-send'
      : command.type === 'interrupt' ? 'user-stop' : command.type === 'settle-thread' ? 'user-settle'
      : ['configure-thread', 'configure-thread-working-copy', 'edit-followup', 'remove-followup', 'resume-followups', 'reorder-followups', 'compact-thread', 'git-switch-branch', 'git-checkout-pull-request', 'git-pull', 'git-pull-request-action', 'git-action'].includes(command.type) ? 'user-reconfigure' : undefined
    if (reason) this.takeover(threadId, reason)
    if (command.type === 'interrupt' && this.record().current?.target.threadId === threadId) {
      const stopped = new Set(this.record().requests.filter(item => item.state === 'active').map(item => item.id))
      const operations = new Set(this.record().operations.filter(item => stopped.has(item.requestId)).map(item => item.id))
      this.options.control.mutateWatcher(record => {
        for (const request of record.requests) if (stopped.has(request.id)) { request.state = 'stopped'; request.closedAt = now() }
        for (const operation of record.operations) if (operations.has(operation.id) && operation.deliveryState === 'queued') { operation.deliveryState = 'failed'; operation.refusalCode = 'REQUEST_NOT_ACTIVE' }
      })
      void this.reconcileRemote().catch(() => { this.recoveryNotice = 'The host has not confirmed this stopped request. Its pending slots remain held.'; this.publish() })
      void this.options.control.cancelWatcherQueue(operations).catch(() => { this.recoveryNotice = 'A stopped request has a queued message that could not be removed. It is fenced and will not be sent.'; this.publish() })
    }
  }
  private takeover(threadId: string, reason: 'user-send' | 'native-user-send' | 'user-stop' | 'user-settle' | 'user-reconfigure'): void {
    const target = this.target(threadId)
    const owned = this.record().requests.some(request => request.participants.some(item => key(item.target) === key(target) && item.state === 'participating'))
    if (!owned) return
    const operations = new Set<string>()
    this.options.control.mutateWatcher(record => {
      for (const request of record.requests) for (const participant of request.participants) if (key(participant.target) === key(target) && participant.state === 'participating') {
        participant.state = 'taken-over'; participant.generation++; participant.takeover = { reason, at: now() }
        for (const operation of record.operations.filter(item => item.requestId === request.id && key(item.target) === key(target))) {
          operations.add(operation.id)
          if (operation.deliveryState === 'queued') { operation.deliveryState = 'failed'; operation.refusalCode = 'THREAD_TAKEN_OVER'; operation.updatedAt = now() }
        }
      }
      record.reservations = record.reservations.filter(item => key(item.target) !== key(target)
        || record.operations.some(operation => key(operation.target) === key(item.target) && ['dispatching', 'uncertain'].includes(operation.deliveryState)))
    })
    void this.options.control.cancelWatcherQueue(operations).catch(() => { this.recoveryNotice = 'A taken-over thread’s queued Watcher message could not be removed. It is fenced and will not be sent.'; this.publish() })
  }
  preserveUserQueue(threadId: string): boolean {
    return this.record().requests.some(request => request.participants.some(participant => participant.target.hostId === this.hostId() && participant.target.threadId === threadId
      && participant.state === 'participating' && (participant.automationStopped || request.state === 'stopped' && participant.startedBy === 'watcher')))
  }
  beforeDispatch(command: AgentHostCommand, _draftId: string | undefined, origin?: WatcherCommandOrigin): AgentHostCommand {
    if (origin?.phoneOrigin && command.type === 'send') this.guardPhoneSend(command.threadId)
    if (origin?.operationId) {
      this.options.control.mutateWatcher(record => {
        const operation = record.operations.find(item => item.id === origin.operationId)!
        operation.commandId = command.commandId
        if ('messageId' in command) operation.messageId = command.messageId
        operation.deliveryState = 'dispatching'; operation.updatedAt = now()
      })
      return command
    }
    if (command.type !== 'send' || command.wakeUp || command.threadId !== this.record().current?.target.threadId) return command
    const record = this.record()
    let request = record.requests.find(item => item.rootUserMessageId === command.messageId
      || _draftId && item.userFollowups?.some(followup => followup.draftId === _draftId))
    if (!request) {
      request = { id: randomUUID(), watcher: this.target(command.threadId), rootUserMessageId: command.messageId,
        state: 'active', createdAt: now(), closedAt: null, participants: [], ...(origin?.phoneOrigin ? { phoneOrigin: origin.phoneOrigin } : {}) }
      const created = request
      this.options.control.mutateWatcher(next => { next.requests.push(created) })
    }
    const projects = this.options.control.watcherSnapshot().projects.filter(item => item.id !== record.current?.projectId)
    const text = `${command.text}\n\n${watcherGuidancePrefix(request.id, this.hostId())}${projects.slice(0, 100).map(item => item.id).join(', ')}${WATCHER_GUIDANCE_SUFFIX}`
    const displayPrompt = watcherDisplayPrompt(command.text, text)
    const followup = request.userFollowups?.find(item => item.draftId === _draftId)
    this.options.control.mutateWatcher(next => {
      const saved = next.requests.find(item => item.id === request!.id)!
      if (followup) {
        const delivered = saved.userFollowups!.find(item => item.draftId === _draftId)!
        const sameMessage = delivered.messageId === command.messageId
        delivered.messageId = command.messageId
        if (!sameMessage || delivered.displayPrompt === undefined) delivered.displayPrompt = displayPrompt
      } else if (saved.rootUserMessageId === command.messageId && saved.displayPrompt === undefined) saved.displayPrompt = displayPrompt
    })
    return { ...command, text }
  }
  observe(snapshot: AgentHostSnapshot, knownUserMessages: ReadonlySet<string>): void {
    const record = this.record()
    for (const thread of snapshot.threads) {
      const head = lastUserMessageIdOf(thread), previous = this.nativeHeads.get(thread.id)
      this.nativeHeads.set(thread.id, head)
      const participants = record.requests.flatMap(request => request.participants).filter(item => item.target.hostId === this.hostId() && item.target.threadId === thread.id && item.state === 'participating')
      const machineHead = record.operations.some(item => item.target.hostId === this.hostId() && item.target.threadId === thread.id && item.messageId === head)
      if (head && !machineHead && participants.some(participant => {
        const durableHead = record.operations.findLast(item => item.target.hostId === this.hostId() && item.target.threadId === thread.id && item.messageId)?.messageId
        const baseline = participant.lastUserMessageId !== undefined ? participant.lastUserMessageId : previous ?? durableHead
        return baseline !== undefined && head !== baseline && (participant.lastUserMessageId !== undefined || durableHead !== undefined || !knownUserMessages.has(head))
      })) this.takeover(thread.id, 'native-user-send')
      if (participants.length && this.connected(thread)) this.options.control.mutateWatcher(next => {
        for (const request of next.requests) for (const participant of request.participants) if (participant.target.hostId === this.hostId() && participant.target.threadId === thread.id && participant.state === 'participating') participant.lastUserMessageId = head
      })
    }
    this.options.control.mutateWatcher(next => {
      for (const operation of next.operations.filter(item => item.target.hostId === this.hostId())) {
        const thread = snapshot.threads.find(item => item.id === operation.target.threadId)
        const delivery = this.options.control.shell().deliveries?.find(item => item.draftId === operation.draftId && item.threadId === operation.target.threadId)
        if (operation.action === 'stop' && operation.deliveryState === 'uncertain' && operation.commandId && !this.active.has(operation.id)
          && !this.options.control.watcherCommandOutstanding(operation.commandId) && thread && this.connected(thread) && thread.status === 'idle') operation.deliveryState = 'accepted'
        if (operation.creationUncertain && thread && this.connected(thread) && this.options.host.watcherCreationPhase(thread.id) !== 'starting') {
          operation.deliveryState = 'failed'; operation.refusalCode = 'PROVIDER_UNAVAILABLE'; delete operation.creationUncertain
          this.refundPrompt(next, operation, 'PROVIDER_UNAVAILABLE')
        }
        if (delivery?.status === 'accepted' || operation.messageId && thread?.messages.some(item => item.role === 'user' && item.id === operation.messageId)) operation.deliveryState = 'accepted'
        else if (delivery?.status === 'uncertain' && !this.active.has(operation.id)) operation.deliveryState = 'uncertain'
        else if (this.options.control.shell().followups?.some(item => item.draftId === operation.draftId && item.status === 'failed')) {
          const refusal = this.dispatchRefusals.get(operation.id)?.result.code
          this.recordOutcome(next, operation, 'failed', refusal ?? operation.refusalCode ?? 'PROVIDER_UNAVAILABLE')
          this.dispatchRefusals.delete(operation.id)
        }
      }
      next.reservations = next.reservations.filter(reservation => {
        if (reservation.target.hostId !== this.hostId()) return true
        const request = next.requests.find(item => item.id === reservation.requestId)
        const participant = request?.participants.find(item => key(item.target) === key(reservation.target))
        const thread = snapshot.threads.find(item => item.id === reservation.target.threadId)
        const operations = next.operations.filter(item => key(item.target) === key(reservation.target))
        if (operations.some(item => ['dispatching', 'uncertain'].includes(item.deliveryState))) return true
        if (participant?.state !== 'participating') return false
        if (operations.some(item => item.deliveryState === 'queued')) return true
        if (!thread && operations.every(item => item.deliveryState === 'failed')) return false
        if (!thread || !isThreadProviderConnected(snapshot, thread) || thread.clientConnected === false) return true
        return thread.status === 'running' || thread.lastTurn?.status === 'running' || Boolean(thread.requests.length || thread.backgroundWork?.length || thread.monitoring?.length)
      })
      for (const request of next.requests) if (request.state === 'active' && !request.participants.length && !next.operations.some(item => item.requestId === request.id)) {
        const master = request.watcher.hostId === this.hostId() ? snapshot.threads.find(item => item.id === request.watcher.threadId) : undefined
        const head = master && lastUserMessageIdOf(master)
        if (master?.lastTurn && (head === request.rootUserMessageId || request.userFollowups?.some(item => item.messageId === head))
          && master.lastTurn.status !== 'running' && master.status !== 'running' && !this.options.control.hasPendingThreadWork(master.id)) { request.state = 'closed'; request.closedAt = now() }
      }
      for (const request of next.requests) if (request.state === 'active' && request.participants.length
        && request.participants.every(item => {
          if (item.state !== 'participating') return true
          const owner = item.target.hostId === this.hostId() ? snapshot : this.owningSnapshot(item.target.hostId)
          const thread = owner?.threads.find(thread => thread.id === item.target.threadId)
          return Boolean(owner?.connected && thread && this.connected(thread)
            && isWorkspaceThreadSettled(thread, owner.projects.find(project => project.id === thread.projectId)))
        })
        && (request.watcher.hostId !== this.hostId() || !this.options.control.hasPendingThreadWork(request.watcher.threadId))
        && !next.operations.some(item => item.requestId === request.id && ['queued', 'dispatching', 'uncertain'].includes(item.deliveryState))) {
        request.state = 'closed'; request.closedAt = now()
      }
    })
    this.pruneRemoteGuards()
  }
  private confirmedWorkerStop(operation: WatcherOperation, request: WatcherRecord['requests'][number]): boolean {
    return operation.action === 'stop' && operation.confirmedStop === true && request.participants.some(item => key(item.target) === key(operation.target)
      && item.startedBy === 'watcher' && item.state === 'participating')
  }
  private pruneRemoteGuards(): void {
    const live = new Set(this.record().operations.filter(item => this.active.has(item.id) || ['queued', 'dispatching', 'uncertain'].includes(item.deliveryState)).map(item => item.id))
    for (const id of this.remoteGuards.keys()) if (!live.has(id)) this.remoteGuards.delete(id)
  }
  guardOperation(operationId: string): void {
    try { this.checkOperation(operationId) } catch (error) {
      if (error instanceof Refusal) this.dispatchRefusals.set(operationId, error)
      throw error
    }
  }
  private checkOperation(operationId: string): void {
    if (this.closed) refuse('NOT_CURRENT_WATCHER', 'Watcher is stopping. Nothing was sent.')
    const record = this.record(), operation = record.operations.find(item => item.id === operationId)
    if (!operation) refuse('UNKNOWN_OPERATION', 'This operation is unavailable.')
    const request = record.requests.find(item => item.id === operation.requestId)!
    if (request.remoteOrigin) {
      const guard = this.remoteGuards.get(operation.id)
      if (!guard) refuse('HOST_DISCONNECTED', 'The master connection is unavailable. Reconcile this operation before continuing.')
      guard()
    } else if (!record.current || key(record.current.target) !== key(request.watcher)) refuse('NOT_CURRENT_WATCHER', 'This operation no longer belongs to the current Watcher.')
    if (operation.deliveryState === 'failed') refuse(operation.refusalCode ?? 'REQUEST_NOT_ACTIVE', 'This operation was cancelled before dispatch. Nothing was sent.')
    if (request.state !== 'active' && !this.confirmedWorkerStop(operation, request)) refuse('REQUEST_NOT_ACTIVE', 'This Watcher request has stopped. Nothing was sent.')
    const participant = request.participants.find(item => key(item.target) === key(operation.target))
    if (participant?.state === 'relinquished' && (operation.action === 'start' || operation.action === 'send')) refuse('REQUEST_NOT_ACTIVE', 'Watcher settled this participation. Nothing was sent.')
    if (!participant || participant.state !== 'participating' || participant.generation !== operation.generation) refuse('THREAD_TAKEN_OVER', 'You took over this thread. Watcher stopped sending to it.')
    if (participant.automationStopped && (operation.action === 'start' || operation.action === 'send')) refuse('REQUEST_NOT_ACTIVE', 'Watcher stopped this participation. It will not send another prompt for this request.')
    if (operation.action === 'start' && !this.options.control.watcherSnapshot().threads.some(item => item.id === operation.target.threadId)) return
    const thread = this.thread(operation.target); this.protect(thread)
    if (!this.connected(thread)) refuse('HOST_DISCONNECTED', 'This thread is disconnected. Nothing was sent. Reconnect its provider.', true)
    if (operation.action === 'start' || operation.action === 'send') {
      this.pending(thread); this.checkPermission(thread)
      this.checkRemoteCeiling(request.id, thread.runtimeMode)
      if (operation.expectedLastUserMessageId && operation.expectedLastUserMessageId !== lastUserMessageIdOf(thread)) refuse('TARGET_CHANGED', 'This thread received another instruction. Read it before sending.')
      if (operation.delivery === 'steer' && (thread.status !== 'running' || operation.expectedTurnId !== thread.lastTurn?.id)) refuse('TURN_CHANGED', 'The running turn changed. Nothing was steered.')
      if (operation.delivery !== 'queue' && operation.delivery !== 'steer' && thread.status === 'running') refuse('THREAD_BUSY', 'This thread is working. Choose queue explicitly.', true)
    }
    if (operation.action === 'settle') {
      this.checkSettlement(thread)
      if (record.operations.some(item => item.id !== operation.id && key(item.target) === key(operation.target) && ['queued', 'dispatching', 'uncertain'].includes(item.deliveryState))) refuse('DELIVERY_UNCERTAIN', 'This thread still has an outstanding delivery. Reconcile it before settling.')
    }
  }

  async invoke(threadId: string, name: WatcherToolName, args: unknown): Promise<unknown> {
    this.invocations++
    try {
      this.checkCaller(threadId)
      if (this.changing) refuse('THREAD_BUSY', 'Wait for Watcher’s provider change before using its tools.', true)
      const parsed = watcherToolSchemas[name].input.safeParse(args)
      if (!parsed.success) refuse('INVALID_INPUT', 'This call has invalid or oversized arguments. Use the offered tool schema.')
      const input = parsed.data as { hostId?: string; target?: WatcherThreadTarget; project?: { hostId: string } }
      const hostId = input.hostId ?? input.target?.hostId ?? input.project?.hostId
      if (hostId && hostId !== this.hostId() && ['list_threads', 'list_projects', 'list_working_copies', 'read_thread'].includes(name)) {
        this.requireRemote(hostId, false)
        return await this.remote!.read(hostId, { master: this.record().current!, call: { name, input: parsed.data } } as WatcherHostRead)
      }
      if (name === 'list_threads' || name === 'list_projects' || name === 'list_working_copies' || name === 'read_thread' || name === 'read_operation') {
        const call = watcherHostReadSchema.shape.call.unwrap().parse({ name, input: parsed.data })
        let operation: WatcherOperation | undefined
        if (call.name === 'read_operation') {
          operation = this.record().operations.find(item => item.id === call.input.operationId)
          if (!operation || !this.record().requests.some(item => item.id === operation!.requestId && key(item.watcher) === key(this.target(threadId)))) refuse('UNKNOWN_OPERATION', 'That operation does not belong to this Watcher request.')
          if (operation.target.hostId !== this.hostId()) {
            this.requireRemote(operation.target.hostId, false)
            const result = watcherToolSchemas.read_operation.output.parse(await this.remote!.read(operation.target.hostId,
              { master: this.record().current!, call: { name: 'read_operation', input: { operationId: operation.id } } }))
            if (result.status === 'refused') return result
            if (result.receipt.operationId !== operation.id || key(result.receipt.target) !== key(operation.target) || result.receipt.requestId !== operation.requestId) refuse('INVALID_INPUT', 'The owning host returned another receipt. Nothing was sent.')
            const { operationId: _operationId, ...receipt } = result.receipt; void _operationId
            const id = operation.id
            await this.options.control.updateWatcher(record => { Object.assign(record.operations.find(item => item.id === id)!, receipt) })
            await this.reconcileRemote(operation.target.hostId)
          }
          operation = this.record().operations.find(item => item.id === operation!.id)!
        }
        return await this.dispatchRead(call, operation)
      }
      return await this.mutate(threadId, name, parsed.data as WatcherToolInput<'start_thread'> | WatcherToolInput<'send_to_thread'> | WatcherToolInput<'stop_thread'>)
    } catch (error) { return error instanceof Refusal ? error.result : watcherRefusal('PROVIDER_UNAVAILABLE', 'This Watcher call could not be completed. Check the operation receipt before trying again.', true) }
    finally { this.invocations-- }
  }
  private async mutate(threadId: string, name: WatcherToolName, input: WatcherToolInput<'start_thread'> | WatcherToolInput<'send_to_thread'> | WatcherToolInput<'stop_thread'>, imported?: WatcherOperation): Promise<unknown> {
    const admitted = await this.transaction(async () => {
      if (imported && this.record().remoteAbsences?.some(item => item.operationId === imported.id)) refuse('OPERATION_NOT_RECORDED', 'An exact read fenced this unrecorded operation. Nothing was sent.')
      if (imported && this.closed) refuse('NOT_CURRENT_WATCHER', 'Watcher is stopping. Nothing was sent. Reopen Sotto.')
      if (!imported) this.checkCaller(threadId)
      const record = this.record(), request = record.requests.find(item => item.id === input.requestId)
      if (!request || request.watcher.threadId !== threadId || !imported && request.watcher.hostId !== this.hostId()) refuse('REQUEST_NOT_ACTIVE', 'This request is not active. Only a user Send to Watcher can start a request.')
      const inputDigest = digest([name, input])
      const existing = record.operations.find(item => item.requestId === input.requestId && item.retryKey === input.retryKey)
      if (existing) {
        if ((imported ? existing.digest : existing.inputDigest ?? existing.digest) !== inputDigest) refuse('RETRY_KEY_CONFLICT', 'This retry key already belongs to a different call. Use the original receipt.')
        return { operation: existing, retry: true }
      }
      if (request.state !== 'active' && !(imported && this.confirmedWorkerStop(imported, request))) {
        const stoppedTarget = 'target' in input ? input.target : undefined
        if (stoppedTarget && record.requests.some(item => item.participants.some(participant => key(participant.target) === key(stoppedTarget) && participant.state === 'taken-over'))) refuse('THREAD_TAKEN_OVER', 'You took over this thread. Watcher stopped sending to it.')
        refuse('REQUEST_NOT_ACTIVE', 'This request is not active. Only a user Send to Watcher can start a request.')
      }
      const start = name === 'start_thread', send = name === 'send_to_thread'
      const owner = start ? (input as WatcherToolInput<'start_thread'>).project.hostId : (input as WatcherToolInput<'send_to_thread'>).target.hostId
      const remote = owner !== this.hostId()
      if (remote) this.requireRemote(owner, true)
      const target = imported?.target ?? (start ? { hostId: owner, threadId: randomUUID() } : (input as WatcherToolInput<'send_to_thread'>).target)
      if (start && this.options.control.watcherSnapshot().threads.some(item => item.id === target.threadId) && target.hostId === this.hostId()) refuse('TARGET_CHANGED', 'That thread identity already exists. Nothing was started.')
      const thread = start ? undefined : this.thread(target)
      if (thread) { this.protect(thread); if (!this.connected(thread)) refuse('HOST_DISCONNECTED', 'This thread is disconnected. Reconnect it before sending.', true) }
      if (record.requests.some(item => item.participants.some(participant => key(participant.target) === key(target) && participant.state === 'taken-over'))) refuse('THREAD_TAKEN_OVER', 'You took over this thread. Watcher stopped sending to it.')
      if (start) {
        const create = input as WatcherToolInput<'start_thread'>
        const snapshot = this.owningSnapshot(owner)!
        const project = snapshot.projects.find(item => item.id === create.project.projectId)
        if (!project) refuse('UNKNOWN_TARGET', 'That project is unavailable. Read the project list again.')
        if (this.reservedProject(project.path)) refuse('RESERVED_THREAD', 'This project has a special job and is not a worker project.')
        const model = resolveModel(snapshot.models, create.modelId)
        if (!model?.ready) refuse('PROVIDER_UNAVAILABLE', 'Choose a ready worker model. Sotto will not switch accounts.')
        if (create.reasoningEffort && !model.reasoningEfforts?.includes(create.reasoningEffort)) refuse('INVALID_INPUT', 'Choose an effort this worker model offers.')
        const permission = this.permission(model, create.permission, request.remoteOrigin?.ceiling
          ?? (remote ? this.remote?.hosts().find(host => host.hostId === owner)?.permissionCeiling : undefined))
        if (!imported) {
          const configuration = this.options.control.configuration()
          const reference = resolveModel(this.options.control.watcherSnapshot().models, configuration.newThreadModelId)?.reasoningEfforts ?? model.reasoningEfforts ?? []
          const effort = create.reasoningEffort ?? (configuration.newThreadReasoningEffort
            ? nearestReasoningEffort(configuration.newThreadReasoningEffort, reference, model.reasoningEfforts ?? []) : undefined)
          input = watcherToolSchemas.start_thread.input.parse({ ...create, ...(effort !== undefined ? { reasoningEffort: effort } : {}), permission })
        }
        this.checkRemoteCeiling(request.id, permission.kind === 'runtime' ? permission.mode : undefined)
        this.prunePages()
        if (!remote && (create.workingCopy.kind === 'existing-worktree' && !this.copyChoices.get(create.workingCopy.choiceId)?.path
          || create.baseRefChoiceId && !this.copyChoices.get(create.baseRefChoiceId)?.branch)) refuse('WORKING_COPY_CHANGED', 'Read the working-copy choices again before starting this thread.')
      }
      const previous = request.participants.find(item => key(item.target) === key(target))
      if (send && previous?.state === 'relinquished') refuse('REQUEST_NOT_ACTIVE', 'Watcher settled this participation. It will not send another prompt for this request.')
      if (send && previous?.automationStopped) refuse('REQUEST_NOT_ACTIVE', 'Watcher stopped this participation. It will not send another prompt for this request.')
      if (thread && (send || name === 'settle_thread')) this.pending(thread)
      if (thread && send) {
        this.checkPermission(thread)
        this.checkRemoteCeiling(request.id, thread.runtimeMode)
        const sent = input as WatcherToolInput<'send_to_thread'>
        if (sent.expectedLastUserMessageId && sent.expectedLastUserMessageId !== lastUserMessageIdOf(thread)) refuse('TARGET_CHANGED', 'This thread received another instruction. Read it before sending.')
        if (sent.delivery === 'now' && (thread.status === 'running' || !remote && this.options.control.hasPendingThreadWork(thread.id))) refuse('THREAD_BUSY', 'This thread is working or has a queued prompt. Choose queue explicitly.')
        if (sent.delivery === 'steer' && (!capabilitiesForThread(this.owningSnapshot(owner)!, thread).steer || !sent.expectedTurnId || sent.expectedTurnId !== thread.lastTurn?.id || thread.status !== 'running')) refuse('STEER_UNAVAILABLE', 'Steer needs a supported, confirmed running turn. Read the thread and its turn first.')
      }
      if (thread && name === 'settle_thread') {
        this.checkSettlement(thread)
        if (!remote && this.options.control.hasPendingThreadWork(thread.id)) refuse('DELIVERY_UNCERTAIN', 'Reconcile this thread’s pending delivery before settling.')
      }
      if (start || send) {
        if (!imported && (this.inFlight(record) > this.options.limit() || !record.reservations.some(item => key(item.target) === key(target)) && this.inFlight(record) >= this.options.limit())) refuse('IN_FLIGHT_LIMIT', 'Watcher’s threads in flight limit is reached. Wait for a thread to finish.', true)
        if ((previous?.promptCount ?? 0) >= WATCHER_PROMPTS_PER_THREAD) refuse('PROMPT_LIMIT', 'This thread has received four prompts for this Watcher request. The limit cannot be renewed by a retry.')
      }
      const time = now(), id = randomUUID()
      const operation: WatcherOperation = imported ?? { id, requestId: request.id, retryKey: input.retryKey, digest: digest([name, input]),
        ...(start ? { inputDigest } : {}),
        action: start ? 'start' : send ? 'send' : name === 'stop_thread' ? 'stop' : 'settle', target,
        generation: previous?.generation ?? 0, anchorMessageId: request.rootUserMessageId, deliveryState: 'queued', createdAt: time, updatedAt: time, receiptId: randomUUID(), cardId: randomUUID(),
        ...(start || send ? { draftId: randomUUID(), messageId: randomUUID(), delivery: start ? 'now' : (input as WatcherToolInput<'send_to_thread'>).delivery } : {}),
        ...(start ? { creationReceiptId: randomUUID(), firstPromptReceiptId: randomUUID() } : {}),
        ...(send && (input as WatcherToolInput<'send_to_thread'>).expectedTurnId ? { expectedTurnId: (input as WatcherToolInput<'send_to_thread'>).expectedTurnId } : {}),
        ...(send && (input as WatcherToolInput<'send_to_thread'>).expectedLastUserMessageId ? { expectedLastUserMessageId: (input as WatcherToolInput<'send_to_thread'>).expectedLastUserMessageId } : {}) }
      if (imported && (imported.generation !== (previous?.generation ?? 0) || record.operations.some(item => item.id === imported.id
        || ['receiptId', 'cardId', 'draftId', 'messageId', 'creationReceiptId', 'firstPromptReceiptId'].some(field => {
          const name = field as 'receiptId' | 'cardId' | 'draftId' | 'messageId' | 'creationReceiptId' | 'firstPromptReceiptId'
          return imported[name] && imported[name] === item[name]
        })))) refuse('TARGET_CHANGED', 'This operation identity or ownership generation changed. Nothing was sent.')
      await this.options.control.updateWatcher(next => {
        const owned = next.requests.find(item => item.id === request.id)!
        if (remote && !owned.pairedPermissionCeiling) owned.pairedPermissionCeiling = this.options.control.configuration().newThreadRuntimeMode ?? 'approval-required'
        let participant = owned.participants.find(item => key(item.target) === key(target))
        if (!participant) { participant = { requestId: request.id, target, startedBy: start || next.requests.some(item => item.participants.some(worker => key(worker.target) === key(target) && worker.startedBy === 'watcher')) ? 'watcher' : 'user', generation: 0, state: 'participating', promptCount: 0, lastUserMessageId: thread ? lastUserMessageIdOf(thread) : null }; owned.participants.push(participant) }
        if (start || send) participant.promptCount++
        next.operations.push(operation)
        if ((start || send) && !next.reservations.some(item => key(item.target) === key(target))) next.reservations.push({ target, requestId: request.id, operationId: operation.id, generation: participant.generation, reason: start ? 'creation' : operation.delivery === 'queue' ? 'queued' : 'dispatching' })
      })
      return { operation, retry: false }
    })
    if (admitted.retry) { const active = this.active.get(admitted.operation.id); if (active) return await active; return this.operationResult(name, admitted.operation, input) }
    const running = admitted.operation.target.hostId !== this.hostId() ? this.executeRemote(name, admitted.operation, input) : this.executeOperation(name, admitted.operation, input)
    this.active.set(admitted.operation.id, running)
    try { return await running } finally { this.active.delete(admitted.operation.id); this.dispatchRefusals.delete(admitted.operation.id); this.pruneRemoteGuards(); if (admitted.operation.target.hostId !== this.hostId() && this.record().operations.find(item => item.id === admitted.operation.id)?.deliveryState === 'uncertain') this.scheduleRemote(admitted.operation.target.hostId, true); this.publish() }
  }
  private async executeOperation(name: WatcherToolName, operation: WatcherOperation, input: WatcherToolInput<'start_thread'> | WatcherToolInput<'send_to_thread'> | WatcherToolInput<'stop_thread'>): Promise<unknown> {
    let dispatchRefusal: Refusal | undefined
    const origin: WatcherCommandOrigin = { operationId: operation.id, guard: () => {
      try { this.guardOperation(operation.id) } catch (error) { if (error instanceof Refusal) dispatchRefusal = error; throw error }
    } }
    try {
      let command: WatcherCommand
      if (name === 'start_thread') {
        const create = input as WatcherToolInput<'start_thread'>
        const choices = await this.resolveCopies(create)
        const pairedCeiling = this.record().requests.find(item => item.id === operation.requestId)?.remoteOrigin?.ceiling
        const permission = this.permission(resolveModel(this.options.control.watcherSnapshot().models, create.modelId), create.permission, pairedCeiling)
        const createOrigin: WatcherCommandOrigin = { operationId: operation.id, guard: () => {
          origin.guard()
          this.permission(resolveModel(this.options.control.watcherSnapshot().models, create.modelId), permission, pairedCeiling)
          this.checkRemoteCeiling(operation.requestId, permission.kind === 'runtime' ? permission.mode : undefined)
        } }
        const created = await this.options.control.commandFromWatcher({ type: 'create-thread', threadId: operation.target.threadId,
          projectId: create.project.projectId, title: create.title, titleSource: 'user', modelId: create.modelId,
          ...(create.reasoningEffort ? { reasoningEffort: create.reasoningEffort } : {}),
          ...(permission.kind === 'runtime' ? { runtimeMode: permission.mode } : { providerMode: permission.choiceId }), ...choices }, createOrigin)
        if (created.error) throw new Error('creation-failed')
        origin.guard()
        command = { type: 'manual-send', threadId: operation.target.threadId, draftId: operation.draftId!, text: create.firstPrompt }
      } else if (name === 'send_to_thread') {
        const sent = input as WatcherToolInput<'send_to_thread'>
        command = { type: sent.delivery === 'now' ? 'manual-send' : sent.delivery === 'queue' ? 'queue-followup' : 'steer',
          threadId: operation.target.threadId, draftId: operation.draftId!, text: sent.text }
      } else command = { type: name === 'stop_thread' ? 'interrupt' : 'settle-thread', threadId: operation.target.threadId }
      if (operation.action === 'stop') {
        await this.options.control.updateWatcher(record => {
          for (const request of record.requests) for (const participant of request.participants) if (key(participant.target) === key(operation.target) && participant.state === 'participating') {
            participant.generation++; participant.automationStopped = true
          }
          const participant = record.requests.find(item => item.id === operation.requestId)!.participants.find(item => key(item.target) === key(operation.target))!
          record.operations.find(item => item.id === operation.id)!.generation = participant.generation
          for (const pending of record.operations) if (pending.id !== operation.id && key(pending.target) === key(operation.target)
            && pending.deliveryState === 'queued') { pending.deliveryState = 'failed'; pending.refusalCode = 'REQUEST_NOT_ACTIVE' }
        })
        await this.options.control.cancelWatcherQueue(new Set(this.record().operations.filter(item => key(item.target) === key(operation.target) && item.action !== 'stop').map(item => item.id)))
      }
      const result = await this.options.control.commandFromWatcher(command, origin)
      const guardedRefusal = dispatchRefusal ?? this.dispatchRefusals.get(operation.id)
      if (result.error && guardedRefusal) throw guardedRefusal
      const delivery = result.deliveries?.find(item => item.draftId === operation.draftId && item.threadId === operation.target.threadId)
      await this.options.control.updateWatcher(record => {
        const saved = record.operations.find(item => item.id === operation.id)!
        const queue = result.followups?.find(item => item.draftId === operation.draftId && item.threadId === operation.target.threadId)
        const state = delivery?.status === 'accepted' ? 'accepted'
          : delivery?.status === 'uncertain' || delivery?.status === 'submitting' ? 'uncertain' : queue ? 'queued' : result.error ? 'failed' : 'accepted'
        this.recordOutcome(record, saved, state)
        if (queue) saved.itemId = queue.id
      })
    } catch (error) {
      await this.options.control.updateWatcher(record => {
        const saved = record.operations.find(item => item.id === operation.id)!
        this.recordOutcome(record, saved, saved.deliveryState === 'uncertain' ? 'uncertain' : 'failed', error instanceof Refusal ? error.result.code : 'PROVIDER_UNAVAILABLE')
      })
    }
    this.observe(this.options.control.watcherSnapshot(), new Set())
    return this.operationResult(name, this.record().operations.find(item => item.id === operation.id)!, input)
  }
  private recordOutcome(record: WatcherRecord, operation: WatcherOperation, state: WatcherOperation['deliveryState'], code?: WatcherRefusal['code']): void {
    const wasFailed = operation.deliveryState === 'failed'
    const creationUncertain = operation.action === 'start' && this.options.host.watcherCreationPhase(operation.target.threadId) === 'starting'
    const unresolved = creationUncertain || this.options.control.watcherCommandOutstanding(operation.commandId)
    if (operation.deliveryState !== 'accepted') operation.deliveryState = state === 'failed' && unresolved ? 'uncertain' : state
    if (creationUncertain) operation.creationUncertain = true
    if (creationUncertain || code !== undefined && operation.deliveryState === 'uncertain') operation.refusalCode = 'DELIVERY_UNCERTAIN'
    else if (operation.deliveryState === 'failed') {
      operation.refusalCode = code ?? 'PROVIDER_UNAVAILABLE'
      if (!wasFailed) this.refundPrompt(record, operation, operation.refusalCode)
    }
    if (operation.action === 'settle' && operation.deliveryState === 'accepted') record.requests.find(item => item.id === operation.requestId)!.participants.find(item => key(item.target) === key(operation.target))!.state = 'relinquished'
    operation.updatedAt = now()
  }
  private refundPrompt(record: WatcherRecord, operation: WatcherOperation, code: WatcherRefusal['code']): void {
    if ((operation.action !== 'start' && operation.action !== 'send') || ['THREAD_TAKEN_OVER', 'REQUEST_NOT_ACTIVE', 'NOT_CURRENT_WATCHER'].includes(code)) return
    const participant = record.requests.find(item => item.id === operation.requestId)!.participants.find(item => key(item.target) === key(operation.target))!
    participant.promptCount = Math.max(0, participant.promptCount - 1)
  }
  private operationResult(name: WatcherToolName, operation: WatcherOperation, input: WatcherToolInput<'start_thread'> | WatcherToolInput<'send_to_thread'> | WatcherToolInput<'stop_thread'>): unknown {
    const base = { receipt: this.receipt(operation), limits: this.limits(operation) }
    if (operation.refusalCode) return { ...watcherRefusal(operation.refusalCode, operation.refusalCode === 'THREAD_TAKEN_OVER'
      ? 'You took over this thread. Watcher stopped sending to it.' : 'The operation could not be completed. Read its receipt before trying again.'), receipt: base.receipt }
    if (name === 'start_thread') {
      const create = input as WatcherToolInput<'start_thread'>
      const thread = this.owningSnapshot(operation.target.hostId)?.threads.find(item => item.id === operation.target.threadId)
      if (!thread) return { ...watcherRefusal('DELIVERY_UNCERTAIN', 'The creation is recorded, but its thread is unavailable. This retry started nothing. Reconcile the original receipt.', true), receipt: base.receipt }
      return { status: 'ok', ...base, target: operation.target, creationReceiptId: operation.creationReceiptId!, firstPromptReceiptId: operation.firstPromptReceiptId!,
        effectiveChoices: { modelId: thread.modelId, reasoningEffort: thread.reasoningEffort ?? null,
          permission: thread.providerMode ? { kind: 'provider', choiceId: thread.providerMode } : { kind: 'runtime', mode: thread.runtimeMode ?? 'approval-required' },
          workingCopy: create.workingCopy, ...(create.baseRefChoiceId ? { baseRefChoiceId: create.baseRefChoiceId } : {}) } }
    }
    if (name === 'send_to_thread') return { status: 'ok', ...base, delivery: operation.delivery }
    return { status: 'ok', ...base, state: this.operationState(operation.target), ...(name === 'stop_thread' ? { stopRequested: true } : {}) }
  }

  private requireRemote(hostId: string, mutation: boolean): void {
    const host = this.remote?.hosts().find(item => item.hostId === hostId)
    if (!host?.connected) refuse('HOST_DISCONNECTED', 'That host is disconnected. Its pending slots remain held. Reconnect it to continue.', true)
    if (!host.reads || mutation && !host.control) refuse('HOST_FEATURE_UNAVAILABLE', 'Update this host before Watcher directs its threads. Nothing was sent.')
  }
  private async executeRemote(name: WatcherToolName, operation: WatcherOperation, input: WatcherToolInput<'start_thread'> | WatcherToolInput<'send_to_thread'> | WatcherToolInput<'stop_thread'>, confirmedStop?: () => void): Promise<unknown> {
    const request = this.record().requests.find(item => item.id === operation.requestId)!
    const guard = () => {
      this.checkCaller(request.watcher.threadId); this.requireRemote(operation.target.hostId, true)
      if (confirmedStop) confirmedStop()
      else if (this.record().requests.find(item => item.id === operation.requestId)?.state !== 'active') refuse('REQUEST_NOT_ACTIVE', 'This Watcher request has stopped. Nothing was sent.')
    }
    try {
      guard()
      await this.options.control.updateWatcher(record => { record.operations.find(item => item.id === operation.id)!.deliveryState = 'dispatching' })
      guard()
      const result = await this.remote!.control(operation.target.hostId, { master: this.record().current!,
        request: { id: request.id, watcher: request.watcher, rootUserMessageId: request.rootUserMessageId, createdAt: request.createdAt },
        ceiling: request.pairedPermissionCeiling ?? this.options.control.configuration().newThreadRuntimeMode ?? 'approval-required', operation,
        call: { name, input } } as WatcherHostControl)
      const parsed = watcherToolSchemas[name].output.parse(result)
      const receipt = 'receipt' in parsed ? parsed.receipt : undefined
      if (parsed.status === 'refused' && !receipt) await this.options.control.updateWatcher(record => {
        this.recordRemoteRefusal(record, operation.id, parsed.code)
      })
      else {
        // Control may already have reached the host; an unverified reply cannot prove that it failed.
        if (!receipt || receipt.operationId !== operation.id || receipt.requestId !== operation.requestId
          || key(receipt.target) !== key(operation.target)) throw new Error('The host returned another operation receipt. Nothing was reconciled.')
        await this.options.control.updateWatcher(record => this.copyRemoteReceipt(record, record.operations.find(item => item.id === operation.id)!,
          { ...receipt, ...(parsed.status === 'refused' && receipt.deliveryState === 'failed' ? { refusalCode: parsed.code } : {}), updatedAt: now() }))
        await this.reconcileRemote(operation.target.hostId).catch(() => {
          this.recoveryNotice = 'The host confirmed the operation, but its latest state could not be read. Reconnect to refresh it.'
        })
      }
      return parsed.status === 'ok' ? { ...parsed, limits: this.limits(this.record().operations.find(item => item.id === operation.id)!) } : parsed
    } catch (error) {
      if (error instanceof Refusal) {
        await this.options.control.updateWatcher(record => this.recordRemoteRefusal(record, operation.id, error.result.code))
        return { ...error.result, receipt: this.receipt(this.record().operations.find(item => item.id === operation.id)!) }
      }
      await this.options.control.updateWatcher(record => { const saved = record.operations.find(item => item.id === operation.id)!;
        if (saved.deliveryState !== 'accepted' && saved.deliveryState !== 'failed') saved.deliveryState = 'uncertain' })
      return { ...watcherRefusal('DELIVERY_UNCERTAIN', 'The host did not confirm this operation. Its slot remains held. Reconnect and read the original receipt.', true), receipt: this.receipt(this.record().operations.find(item => item.id === operation.id)!) }
    }
  }
  private recordRemoteRefusal(record: WatcherRecord, operationId: string, code: WatcherRefusal['code']): void {
    const saved = record.operations.find(item => item.id === operationId)!, wasFailed = saved.deliveryState === 'failed'
    saved.deliveryState = 'failed'; saved.refusalCode = code; saved.updatedAt = now()
    if (!wasFailed) this.refundPrompt(record, saved, code)
    if (saved.action === 'start') {
      const participant = record.requests.find(item => item.id === saved.requestId)?.participants.find(item => key(item.target) === key(saved.target))
      if (participant) participant.state = 'relinquished'
    }
    record.reservations = record.reservations.filter(item => item.operationId !== operationId)
  }
  private copyRemoteReceipt(record: WatcherRecord, own: WatcherOperation, receipt: Pick<WatcherOperation, 'deliveryState' | 'refusalCode' | 'commandId' | 'itemId' | 'updatedAt' | 'creationUncertain'>): void {
    // A read started before the control reply can arrive afterward. Definitive outcomes cannot become pending again.
    if ((own.deliveryState === 'accepted' || own.deliveryState === 'failed') && receipt.deliveryState !== own.deliveryState) return
    const wasFailed = own.deliveryState === 'failed'
    if (own.deliveryState !== 'accepted') own.deliveryState = receipt.deliveryState
    if (own.deliveryState === 'accepted') delete own.refusalCode
    else if (receipt.refusalCode) own.refusalCode = receipt.refusalCode
    if (receipt.commandId) own.commandId = receipt.commandId
    if (receipt.itemId) own.itemId = receipt.itemId
    if (receipt.creationUncertain) own.creationUncertain = true
    else delete own.creationUncertain
    own.updatedAt = receipt.updatedAt
    if (!wasFailed && own.deliveryState === 'failed') this.refundPrompt(record, own, own.refusalCode ?? 'PROVIDER_UNAVAILABLE')
  }
  private readonly remotePending = new Map<string, boolean>()
  private readonly remoteFailures = new Map<string, { count: number; until: number }>()
  private remoteTimer: ReturnType<typeof setTimeout> | undefined
  private remoteFlushing = false
  private scheduleRemote(hostId?: string, force = true): void {
    if (this.closed || !this.remote) return
    for (const id of hostId ? [hostId] : this.remote.hosts().map(host => host.hostId)) {
      if (force) this.remoteFailures.delete(id)
      this.remotePending.set(id, force || this.remotePending.get(id) === true)
    }
    this.armRemote()
  }
  private retryRemote(hostId: string): void {
    if (this.closed) return
    const count = (this.remoteFailures.get(hostId)?.count ?? 0) + 1
    this.remoteFailures.set(hostId, { count, until: Date.now() + Math.min(30_000, 1_000 * 2 ** Math.min(count - 1, 5)) })
    this.remotePending.set(hostId, true); this.armRemote()
  }
  private armRemote(): void {
    if (this.closed || this.remoteTimer || this.remoteFlushing || !this.remotePending.size) return
    const time = Date.now(), due = Math.min(...[...this.remotePending.keys()].map(id => Math.max(time + 250, this.remoteFailures.get(id)?.until ?? 0)))
    this.remoteTimer = setTimeout(() => {
      this.remoteTimer = undefined; this.remoteFlushing = true
      void (async () => {
        for (const [id, force] of [...this.remotePending]) {
          if ((this.remoteFailures.get(id)?.until ?? 0) > Date.now()) continue
          this.remotePending.delete(id)
          await this.reconcileRemote(id, force)
        }
      })().catch(() => { this.recoveryNotice = 'A paired host could not be reconciled. Its pending slots remain held.' })
        .finally(() => { this.remoteFlushing = false; this.armRemote() })
    }, Math.max(0, due - time))
    this.remoteTimer.unref?.()
  }
  private reconciling: Promise<void> | undefined
  private reconcileAgain = false
  private reconcileForce = false
  private reconcileRemote(hostId?: string, force = true): Promise<void> {
    if (this.reconciling) { this.reconcileAgain = true; this.reconcileForce ||= force; return this.reconciling }
    this.reconciling = (async () => {
      do { this.reconcileAgain = false; const refresh = force || this.reconcileForce; this.reconcileForce = false; await this.reconcileRemoteNow(hostId, refresh); hostId = undefined; force = false } while (this.reconcileAgain && !this.closed)
    })().finally(() => { this.reconciling = undefined })
    return this.reconciling
  }
  private async reconcileRemoteNow(hostId?: string, force = true): Promise<void> {
    const master = this.record().current
    if (!master || !this.remote || this.closed) return
    for (const host of this.remote.hosts().filter(item => item.reads && item.connected && (!hostId || item.hostId === hostId))) {
      const owned = this.record().requests.filter(request => key(request.watcher) === key(master.target))
      if (!owned.some(request => request.participants.some(item => item.target.hostId === host.hostId)
        || this.record().operations.some(item => item.requestId === request.id && item.target.hostId === host.hostId))) continue
      let receiptFailed = false
      try {
        const stoppedRequests = this.record().requests.filter(request => request.state === 'stopped' && key(request.watcher) === key(master.target)
          && (request.participants.some(item => item.target.hostId === host.hostId) || this.record().operations.some(item => item.requestId === request.id && item.target.hostId === host.hostId)))
          .slice(-1_000).map(request => ({ request: { id: request.id, watcher: request.watcher, rootUserMessageId: request.rootUserMessageId, createdAt: request.createdAt },
            ceiling: request.pairedPermissionCeiling ?? this.options.control.configuration().newThreadRuntimeMode ?? 'approval-required' as const }))
        const cached = !force ? this.remote.projection?.(host.hostId, master) : undefined
        const projection = cached ?? await this.remote.read(host.hostId, { master, ...(stoppedRequests.length ? { stoppedRequests } : {}) }) as WatcherHostProjection
        if (this.closed || JSON.stringify(this.record().current) !== JSON.stringify(master)) return
        if (projection.hostId !== host.hostId || JSON.stringify(projection.master) !== JSON.stringify(master)) throw new Error('wrong-watcher-host')
        const exact = new Map<string, Extract<ReturnType<typeof watcherToolSchemas.read_operation.output.parse>, { status: 'ok' }>['receipt'] | null>()
        const projected = new Set(projection.operations.map(item => item.id))
        for (const operation of this.record().operations.filter(item => item.target.hostId === host.hostId
          && ['dispatching', 'uncertain'].includes(item.deliveryState) && !this.active.has(item.id) && !projected.has(item.id))) {
          try {
            const result = watcherToolSchemas.read_operation.output.parse(await this.remote.read(host.hostId, { master, call: { name: 'read_operation', input: { operationId: operation.id } } }))
            if (result.status === 'refused' && result.code === 'OPERATION_NOT_RECORDED') exact.set(operation.id, null)
            else if (result.status === 'ok' && result.receipt.operationId === operation.id && result.receipt.requestId === operation.requestId
              && key(result.receipt.target) === key(operation.target)) exact.set(operation.id, result.receipt)
          } catch { receiptFailed = true; this.recoveryNotice = 'An exact host receipt could not be read. Its pending slot remains held.' }
        }
        if (this.closed || JSON.stringify(this.record().current) !== JSON.stringify(master)) return
        const apply = (record: WatcherRecord) => {
          for (const [id, receipt] of exact) {
            const own = record.operations.find(item => item.id === id)!
            if (this.active.has(id) || !['dispatching', 'uncertain'].includes(own.deliveryState)) continue
            if (receipt) this.copyRemoteReceipt(record, own, { ...receipt, updatedAt: now() })
            else this.recordRemoteRefusal(record, id, 'OPERATION_NOT_RECORDED')
          }
          for (const remoteRequest of projection.requests) {
            const request = record.requests.find(item => item.id === remoteRequest.id && key(item.watcher) === key(master.target))
            if (!request || key(remoteRequest.watcher) !== key(master.target)
              || remoteRequest.rootUserMessageId !== request.rootUserMessageId || remoteRequest.createdAt !== request.createdAt) continue
            for (const participant of remoteRequest.participants) {
              if (participant.target.hostId !== host.hostId) continue
              const own = request.participants.find(item => key(item.target) === key(participant.target))
              if (!own) continue
              // The master owns prompt counts; only an exact failed receipt can refund one.
              if (participant.generation < own.generation || own.state !== 'participating') continue
              own.generation = participant.generation; own.state = participant.state
              if (participant.automationStopped) own.automationStopped = true
              if (participant.takeover) own.takeover = participant.takeover
              if (participant.lastUserMessageId !== undefined) own.lastUserMessageId = participant.lastUserMessageId
            }
          }
          for (const receipt of projection.operations) {
            if (receipt.target.hostId !== host.hostId) continue
            const own = record.operations.find(item => item.id === receipt.id && item.requestId === receipt.requestId
              && item.digest === receipt.digest && key(item.target) === key(receipt.target))
            if (!own) continue
            this.copyRemoteReceipt(record, own, receipt)
          }
          record.reservations = record.reservations.filter(reservation => {
            if (reservation.target.hostId !== host.hostId) return true
            const operations = record.operations.filter(item => key(item.target) === key(reservation.target))
            if (operations.some(item => ['queued', 'dispatching', 'uncertain'].includes(item.deliveryState))) return true
            const thread = this.owningSnapshot(host.hostId)?.threads.find(item => item.id === reservation.target.threadId)
            if (!thread) return !operations.every(item => item.deliveryState === 'failed')
            if (!this.connected(thread)) return true
            return thread.status === 'running' || thread.lastTurn?.status === 'running' || Boolean(thread.requests.length || thread.backgroundWork?.length || thread.monitoring?.length)
          })
        }
        const before = this.record(), next = structuredClone(before); apply(next)
        if (digest(before) !== digest(next)) await this.options.control.updateWatcher(apply)
        for (const [target, progress] of this.remoteProgress) if (progress.hostId === host.hostId) this.remoteProgress.delete(target)
        const targets = new Set(projection.requests.flatMap(request => request.participants.map(item => key(item.target))))
        for (const progress of projection.progress ?? []) if (progress.target.hostId === host.hostId && targets.has(key(progress.target))) {
          this.remoteProgress.set(key(progress.target), { hostId: host.hostId, fingerprint: progress.fingerprint })
        }
        while (this.remoteProgress.size > 1_000) this.remoteProgress.delete(this.remoteProgress.keys().next().value!)
        this.wakes.pairedEvidence(host.hostId, projection.evidence)
        if (receiptFailed) this.retryRemote(host.hostId)
        else this.remoteFailures.delete(host.hostId)
      } catch {
        this.retryRemote(host.hostId)
        this.recoveryNotice = 'A paired host could not be reconciled. Its pending slots remain held. Other hosts continue to refresh.'
      }
    }
    const beforeObservation = digest(this.record())
    this.observe(this.options.control.watcherSnapshot(), new Set())
    if (beforeObservation !== digest(this.record())) await this.options.control.updateWatcher(() => undefined)
    this.publish()
  }
  /** The socket supplies the authenticated client and live guard; neither can be submitted as an argument. */
  async admitRemote(raw: WatcherHostControl, clientId: string, guard: () => void): Promise<unknown> {
    try {
      if (this.closed) refuse('NOT_CURRENT_WATCHER', 'Watcher is stopping. Nothing was sent. Reopen Sotto.')
      const packet = watcherHostControlSchema.parse(raw), { operation, request, master, call } = packet
      guard()
      if (master.target.hostId === this.hostId() || key(master.target) !== key(request.watcher)
        || operation.target.hostId !== this.hostId() || operation.requestId !== request.id || call.input.requestId !== request.id || operation.retryKey !== call.input.retryKey
        || operation.digest !== digest([call.name, call.input]) || operation.deliveryState !== 'queued'
        || operation.commandId || operation.itemId || operation.refusalCode || operation.creationUncertain
        || (['start', 'send'].includes(operation.action) ? !operation.draftId || !operation.messageId : operation.draftId || operation.messageId)
        || (operation.action === 'start' ? !operation.creationReceiptId || !operation.firstPromptReceiptId : operation.creationReceiptId || operation.firstPromptReceiptId)
        || operation.anchorMessageId !== request.rootUserMessageId
        || operation.action !== ({ start_thread: 'start', send_to_thread: 'send', stop_thread: 'stop', settle_thread: 'settle' } as const)[call.name]
        || ('target' in call.input && key(call.input.target) !== key(operation.target))
        || ('project' in call.input && call.input.project.hostId !== this.hostId())
        || operation.delivery !== (call.name === 'start_thread' ? 'now' : call.name === 'send_to_thread' ? call.input.delivery : undefined)
        || operation.expectedTurnId !== ('expectedTurnId' in call.input ? call.input.expectedTurnId : undefined)
        || operation.expectedLastUserMessageId !== ('expectedLastUserMessageId' in call.input ? call.input.expectedLastUserMessageId : undefined)) refuse('INVALID_INPUT', 'The machine operation does not match its request and target. Nothing was sent.')
      await this.transaction(async () => {
        if (this.record().remoteAbsences?.some(item => item.operationId === operation.id)) refuse('OPERATION_NOT_RECORDED', 'An exact read fenced this unrecorded operation. Nothing was sent.')
        const existing = this.record().requests.find(item => item.id === request.id)
        if (existing && (key(existing.watcher) !== key(master.target) || existing.rootUserMessageId !== request.rootUserMessageId
          || existing.createdAt !== request.createdAt || existing.remoteOrigin?.clientId !== clientId
          || JSON.stringify(existing.remoteOrigin.master) !== JSON.stringify(master)
          || existing.remoteOrigin.creationOperationId !== master.creationOperationId || existing.remoteOrigin.ceiling !== packet.ceiling)) refuse('RETRY_KEY_CONFLICT', 'This request identity belongs to another origin. Nothing was sent.')
        const retry = this.record().operations.find(item => item.requestId === request.id && item.retryKey === operation.retryKey)
        if (retry && (retry.id !== operation.id || retry.digest !== operation.digest || retry.confirmedStop !== operation.confirmedStop || key(retry.target) !== key(operation.target))) refuse('RETRY_KEY_CONFLICT', 'This operation identity changed. Read the original receipt.')
        if (!existing) await this.options.control.updateWatcher(record => { record.requests.push({ ...request, state: 'active', closedAt: null,
          participants: [], remoteOrigin: { clientId, master, creationOperationId: master.creationOperationId, ceiling: packet.ceiling } }) })
        if (!retry || this.remoteGuards.has(operation.id) && ['queued', 'dispatching', 'uncertain'].includes(retry.deliveryState)) this.remoteGuards.set(operation.id, guard)
      })
      return await this.mutate(master.target.threadId, call.name, call.input, operation)
    } catch (error) { return error instanceof Refusal ? error.result : watcherRefusal('INVALID_INPUT', 'This machine request could not be admitted. Nothing was sent.') }
  }
  remoteProjection(master: WatcherIdentity, clientId: string): WatcherHostProjection {
    const record = this.record(), owned = record.requests.filter(item => key(item.watcher) === key(master.target)
      && item.remoteOrigin?.clientId === clientId && item.remoteOrigin.creationOperationId === master.creationOperationId)
    const ids = new Set(owned.map(item => item.id)), all = record.operations.filter(item => ids.has(item.requestId))
    const pending = all.filter(item => ['queued', 'dispatching', 'uncertain'].includes(item.deliveryState))
    const recentCount = Math.max(0, 1_000 - pending.length)
    const operations = [...(recentCount ? all.filter(item => !pending.includes(item)).slice(-recentCount) : []), ...pending].slice(-1_000)
    const required = new Set(operations.map(item => item.requestId)), requests = owned.filter(item => required.has(item.id)).slice(-1_000)
    const evidence = requests.flatMap(request => request.participants.flatMap(item => this.wakes.evidence.read(item.target, true))).slice(-1_000)
    const targets = new Set(requests.flatMap(request => request.participants.map(item => key(item.target))))
    const progress = this.options.control.watcherSnapshot().threads.filter(thread => targets.has(key(this.target(thread.id))))
      .map(thread => ({ target: this.target(thread.id), fingerprint: watcherProgressFingerprint(thread) })).slice(-1_000)
    return { hostId: this.hostId(), master, requests, operations, evidence, progress,
      revision: digest([requests, operations, evidence, progress]), observedAt: now() }
  }
  private async stopRemoteRequests(master: WatcherIdentity, stops: NonNullable<WatcherHostRead['stoppedRequests']>, clientId: string, guard?: () => void): Promise<void> {
    const operations = new Set<string>()
    await this.transaction(async () => {
      guard?.()
      if (master.target.hostId === this.hostId()) refuse('INVALID_INPUT', 'A remote request must belong to its master computer.')
      const record = this.record()
      for (const { request, ceiling } of stops) {
        const existing = record.requests.find(item => item.id === request.id)
        if (key(request.watcher) !== key(master.target) || existing && (existing.remoteOrigin?.clientId !== clientId
          || JSON.stringify(existing.remoteOrigin.master) !== JSON.stringify(master) || existing.remoteOrigin.ceiling !== ceiling
          || existing.rootUserMessageId !== request.rootUserMessageId || existing.createdAt !== request.createdAt)) refuse('RETRY_KEY_CONFLICT', 'That stopped request belongs to another origin.')
      }
      const stoppedIds = new Set(stops.map(item => item.request.id))
      for (const operation of record.operations) if (stoppedIds.has(operation.requestId) && !operation.confirmedStop) operations.add(operation.id)
      const changed = stops.some(item => !record.requests.some(request => request.id === item.request.id && request.state !== 'active'))
        || record.operations.some(item => operations.has(item.id) && item.deliveryState === 'queued')
      if (changed) await this.options.control.updateWatcher(next => {
        for (const { request, ceiling } of stops) {
          let existing = next.requests.find(item => item.id === request.id)
          if (!existing) { existing = { ...request, state: 'stopped', closedAt: now(), participants: [], remoteOrigin: { clientId, master, creationOperationId: master.creationOperationId, ceiling } }; next.requests.push(existing) }
          if (existing.state === 'active') { existing.state = 'stopped'; existing.closedAt = now() }
          for (const operation of next.operations.filter(item => item.requestId === request.id && !item.confirmedStop)) {
            operations.add(operation.id)
            if (operation.deliveryState === 'queued') this.recordOutcome(next, operation, 'failed', 'REQUEST_NOT_ACTIVE')
          }
        }
      })
      guard?.()
    })
    if (this.options.control.hasWatcherQueue(operations)) await this.options.control.cancelWatcherQueue(operations)
  }
  async readRemote(raw: WatcherHostRead, clientId: string, guard?: () => void): Promise<unknown> {
    try {
      if (this.closed) refuse('NOT_CURRENT_WATCHER', 'Watcher is stopping. Reopen Sotto before reading its threads.')
      const { master, call, stoppedRequests } = watcherHostReadSchema.parse(raw)
      guard?.()
      if (stoppedRequests?.length) await this.stopRemoteRequests(master, stoppedRequests, clientId, guard)
      if (guard) for (const operation of this.record().operations) {
        const request = this.record().requests.find(item => item.id === operation.requestId)
        if (this.remoteGuards.has(operation.id) && request?.remoteOrigin?.clientId === clientId
          && key(request.watcher) === key(master.target) && request.remoteOrigin.creationOperationId === master.creationOperationId
          && ['queued', 'dispatching', 'uncertain'].includes(operation.deliveryState)) this.remoteGuards.set(operation.id, guard)
      }
      this.pruneRemoteGuards()
      if (!call) return this.remoteProjection(master, clientId)
      let operation: WatcherOperation | undefined
      if (call.name === 'read_operation') {
        operation = await this.transaction(async () => {
          guard?.()
          const record = this.record(), operation = record.operations.find(item => item.id === call.input.operationId)
          const request = record.requests.find(item => item.id === operation?.requestId && key(item.watcher) === key(master.target)
            && item.remoteOrigin?.clientId === clientId && item.remoteOrigin.creationOperationId === master.creationOperationId)
          if (operation && !request) refuse('UNKNOWN_OPERATION', 'That operation does not belong to this desktop.')
          if (operation) return operation
          if (!record.remoteAbsences?.some(item => item.operationId === call.input.operationId)) {
            if ((record.remoteAbsences?.length ?? 0) >= 1_000) refuse('DELIVERY_UNCERTAIN', 'This host cannot retain another absence fence. The pending slot remains held.')
            await this.options.control.updateWatcher(next => { (next.remoteAbsences ??= []).push({ operationId: call.input.operationId, master, clientId, observedAt: now() }) })
          }
          guard?.()
          return undefined
        })
        if (!operation) refuse('OPERATION_NOT_RECORDED', 'That operation was not recorded. Its identity is fenced against later admission.')
      }
      return await this.dispatchRead(call, operation)
    } catch (error) { return error instanceof Refusal ? error.result : watcherRefusal('INVALID_INPUT', 'This Watcher read could not be completed.') }
  }

  /** Entry points validate caller or paired receipt ownership before reaching this shared read path. */
  private async dispatchRead(call: NonNullable<WatcherHostRead['call']>, operation?: WatcherOperation): Promise<unknown> {
    if (call.name === 'read_operation') {
      if (!operation) refuse('UNKNOWN_OPERATION', 'That operation is unavailable.')
      return { status: 'ok', receipt: this.receipt(operation), limits: this.limits(operation), action: operation.action, state: this.operationState(operation.target) }
    }
    if (call.name === 'list_threads') return this.listThreads(call.input)
    if (call.name === 'list_projects') return this.listProjects(call.input)
    if (call.name === 'list_working_copies') return await this.listWorkingCopies(call.input)
    return await this.readThread(call.input)
  }

  private prunePages(): void {
    for (const [id, page] of this.pages) if (page.expires < Date.now()) this.pages.delete(id)
    while (this.pages.size > 16) this.pages.delete(this.pages.keys().next().value!)
    for (const [id, choice] of this.copyChoices) if (!this.pages.has(choice.snapshotId)) this.copyChoices.delete(id)
  }
  private page(kind: string, rows: unknown[], cursor: string | undefined, limit: number): { rows: unknown[]; revision: string; nextCursor: string | null } {
    this.prunePages()
    let revision: string, position = 0
    if (cursor && cursor !== 'restart') {
      const match = /^([a-f0-9-]{36}):(\d+)$/u.exec(cursor), page = match && this.pages.get(match[1]!)
      if (!page || page.kind !== kind) refuse('CURSOR_EXPIRED', 'This list changed or its cursor expired. Read its first page again.', true)
      revision = match![1]!; position = Number(match![2]); rows = page.rows
    } else { revision = randomUUID(); this.pages.set(revision, { kind, rows, expires: Date.now() + 60_000 }) }
    this.prunePages()
    return { rows: rows.slice(position, position + limit), revision, nextCursor: position + limit < rows.length ? `${revision}:${position + limit}` : null }
  }
  private listThreads(input: WatcherToolInput<'list_threads'>) {
    if (input.hostId && input.hostId !== this.hostId() || input.project && input.project.hostId !== this.hostId()) refuse('HOST_FEATURE_UNAVAILABLE', 'Remote Watcher thread reads are not available yet.')
    const record = this.record(), snapshot = this.snapshot()
    const rows = watcherOverview({ host: snapshot }, Date.now(), this.wakes.observations).filter(row => (!input.hostId || (row.thread.hostId ?? this.hostId()) === input.hostId)
      && (!input.project || row.thread.projectId === input.project.projectId && (row.thread.hostId ?? this.hostId()) === input.project.hostId)
      && (!input.group || row.group === input.group) && (input.includeSettled || !isWorkspaceThreadSettled(row.thread, this.owningSnapshot(row.thread.hostId ?? this.hostId())?.projects.find(item => item.id === row.thread.projectId))))
      .map(row => { const thread = row.thread, target = { hostId: thread.hostId ?? this.hostId(), threadId: thread.id }
        return { target, title: thread.title, projectId: thread.projectId, provider: thread.providerId ?? resolveModel(this.owningSnapshot(target.hostId)?.models ?? [], thread.modelId)?.providerId,
          modelId: thread.modelId, ...(thread.reasoningEffort ? { reasoningEffort: thread.reasoningEffort } : {}), status: thread.status, group: row.group,
          waitsOn: thread.requests.map(item => ({ id: item.id, kind: item.kind, label: item.kind === 'permission' ? 'Open to answer permission' : 'Open to answer question', openTarget: target })),
          branch: thread.worktree?.branch ?? null, workingCopy: thread.worktree ? { kind: thread.worktree.mode === 'shared' ? 'shared' as const : 'new-worktree' as const } : null,
          pullRequests: (thread.pullRequests ?? []).map(item => ({ number: item.number, url: item.url, title: item.title ?? '', state: item.state, draft: item.draft ?? false })),
          evidence: this.wakes.evidence.read(target, this.connected(thread)), lastActivityAt: this.wakes.observations.get(JSON.stringify([thread.hostId ?? null, thread.id]))?.lastProgressAt ?? null, observedAt: row.observedAt ?? null, connected: this.connected(thread),
          freshness: row.freshness, userReadAt: null, watcherReadAt: record.reads.find(item => key(item.target) === key(target))?.readAt ?? null,
          participation: record.requests.flatMap(request => request.participants.filter(item => key(item.target) === key(target)).map(({ target: _target, promptCount: _count, lastUserMessageId: _head, ...participant }) => { void _target; void _count; void _head; return participant })).slice(-WATCHER_PARTICIPATION_HISTORY_MAX),
          protected: this.protectedThread(thread) } })
    const page = this.page(`threads:${digest([input.hostId, input.project, input.group, input.includeSettled])}`, rows, input.cursor, input.limit)
    return { status: 'ok', rows: page.rows, snapshotRevision: page.revision, nextCursor: page.nextCursor, observedAt: now(), staleHosts: [],
      counts: Object.fromEntries(['Needs you', 'Ready for review', 'Working', 'Landing', 'Quiet', 'Idle'].map(group => [group, rows.filter(row => row.group === group).length])) }
  }
  private listProjects(input: WatcherToolInput<'list_projects'>) {
    if (input.hostId && input.hostId !== this.hostId()) refuse('HOST_FEATURE_UNAVAILABLE', 'Remote Watcher projects are not available yet.')
    const state = this.options.control.shell()
    const snapshots = [state.host, ...this.remote?.hosts().flatMap(host => this.owningSnapshot(host.hostId) ?? []) ?? []]
    const rows = snapshots.filter(snapshot => !input.hostId || (snapshot.hostId ?? this.hostId()) === input.hostId).flatMap(snapshot => snapshot.projects.filter(item => !this.reservedProject(item.path)).map(project => ({
      target: { hostId: snapshot.hostId ?? this.hostId(), projectId: project.id }, title: project.title, displayRoot: project.path,
      workers: snapshot.models.filter(model => model.ready).slice(0, 100).map(model => {
        let defaultPermission: ReturnType<WatcherService['permission']> | null = null
        try { defaultPermission = this.permission(model) } catch { /* Explicitly incomparable. */ }
        return { provider: model.providerId, modelId: model.id, reasoningEfforts: model.reasoningEfforts ?? [], defaultPermission, permissionComparable: defaultPermission !== null }
      }), controlAvailable: snapshot.hostId === this.hostId() || Boolean(this.remote?.hosts().find(item => item.hostId === snapshot.hostId)?.control),
      readsAvailable: snapshot.hostId === this.hostId() || Boolean(this.remote?.hosts().find(item => item.hostId === snapshot.hostId)?.reads),
      readOnlyProfileAvailable: true, freshness: snapshot.connected ? 'fresh' : 'stale' })))
    const page = this.page('projects', rows, input.cursor, input.limit)
    return { status: 'ok', projects: page.rows, nextCursor: page.nextCursor, observedAt: now(), staleHosts: [] }
  }
  private async listWorkingCopies(input: WatcherToolInput<'list_working_copies'>) {
    if (input.project.hostId !== this.hostId()) refuse('HOST_FEATURE_UNAVAILABLE', 'Remote Watcher working-copy choices are not available yet.')
    const kind = `copies:${input.project.projectId}`
    if (input.cursor && input.cursor !== 'restart') {
      const page = this.page(kind, [], input.cursor, input.limit), snapshot = this.pages.get(page.revision)!.workingCopies!
      return { status: 'ok', project: input.project, revision: snapshot.revision, choices: page.rows, baseRefs: snapshot.baseRefs,
        nextCursor: page.nextCursor, observedAt: now(), staleHosts: [] }
    }
    const options = await this.options.host.workingCopyOptions(input.project.projectId), revision = digest(options)
    const entries: { choiceId: string; path?: string; branch?: string }[] = []
    const choices = [{ choiceId: randomUUID(), kind: 'shared', branch: options.currentBranch, occupied: false, locked: false, limitations: [] as string[] },
      ...(options.isGit ? [{ choiceId: randomUUID(), kind: 'new-worktree', branch: options.currentBranch, occupied: false, locked: false, limitations: [] as string[] }] : [])]
    for (const copy of options.worktrees) {
      const occupied = this.options.control.watcherSnapshot().threads.some(thread => thread.worktree?.path === copy.path)
      const choiceId = randomUUID(); entries.push({ choiceId, path: copy.path })
      choices.push({ choiceId, kind: 'existing-worktree', branch: copy.branch, occupied, locked: false, limitations: occupied ? ['Already used by a thread'] : [] })
    }
    const baseRefs = options.branches.slice(0, 100).map(branch => { const choiceId = randomUUID(); entries.push({ choiceId, branch }); return { choiceId, name: branch } })
    const page = this.page(kind, choices, undefined, input.limit)
    this.pages.get(page.revision)!.workingCopies = { revision, baseRefs }
    for (const { choiceId, ...choice } of entries) this.copyChoices.set(choiceId, { ...choice, projectId: input.project.projectId, revision, snapshotId: page.revision })
    return { status: 'ok', project: input.project, revision, choices: page.rows, baseRefs, nextCursor: page.nextCursor, observedAt: now(), staleHosts: [] }
  }
  private async resolveCopies(input: WatcherToolInput<'start_thread'>) {
    if (input.workingCopy.kind === 'shared' && !input.baseRefChoiceId) return { workingCopy: 'shared' as const }
    const options = await this.options.host.workingCopyOptions(input.project.projectId), revision = digest(options)
    this.prunePages()
    const copy = input.workingCopy.kind === 'existing-worktree' ? this.copyChoices.get(input.workingCopy.choiceId) : undefined
    const base = input.baseRefChoiceId ? this.copyChoices.get(input.baseRefChoiceId) : undefined
    if (copy && (copy.projectId !== input.project.projectId || copy.revision !== revision || !options.worktrees.some(item => item.path === copy.path))
      || base && (base.projectId !== input.project.projectId || base.revision !== revision) || input.workingCopy.kind === 'existing-worktree' && !copy?.path
      || input.baseRefChoiceId && !base?.branch || !options.isGit && input.workingCopy.kind !== 'shared') refuse('WORKING_COPY_CHANGED', 'The working-copy choices changed. Read them again. Nothing was started.')
    if (copy && this.options.control.watcherSnapshot().threads.some(thread => thread.worktree?.path === copy.path)) refuse('WORKING_COPY_UNAVAILABLE', 'That working copy is already used by a thread.')
    return { workingCopy: input.workingCopy.kind === 'shared' ? 'shared' as const : 'independent' as const,
      ...(copy?.path ? { existingWorktreePath: copy.path } : {}), ...(base?.branch ? { baseBranch: base.branch } : {}) }
  }
  private async readThread(input: WatcherToolInput<'read_thread'>) {
    const thread = this.thread(input.target)
    // docs/plans/2026-10-08-command-center.md section 2: other special jobs are readable but protected.
    // Their mutation guards still refuse reserved projects; current and retired masters are excluded here.
    if (thread.kind === 'watcher' || thread.kind === 'watcher-history') refuse('RESERVED_THREAD', 'Watcher tools read workers. Open Watcher history in its own pane.')
    const read = await this.options.host.watcherRead(thread.id, input.position?.afterPosition, input.limit)
    if (!read) refuse('HISTORY_UNAVAILABLE', 'This thread’s history is unavailable. Reconnect its provider and read again.', true)
    if (input.position && input.position.historyEpoch !== read.historyEpoch) return { ...watcherRefusal('HISTORY_RESET', 'This thread’s history changed. Start a fresh read.'), historyCursor: { historyEpoch: read.historyEpoch, afterPosition: -1 } }
    const messages = read.messages.map(({ message, position }) => ({ id: message.id, position, role: message.role, text: message.text, createdAt: message.createdAt }))
    let result = { status: 'ok' as const, target: input.target, messages, waitsOn: this.thread(input.target).requests.map(item => ({ id: item.id, kind: item.kind,
      label: item.kind === 'permission' ? 'Open to answer permission' : 'Open to answer question', openTarget: input.target })), activities: input.includeActivities ? read.activities : [], evidence: this.wakes.evidence.read(input.target, this.connected(thread)),
      historyEpoch: read.historyEpoch, firstPosition: messages[0]?.position ?? null, lastPosition: messages.at(-1)?.position ?? null,
      nextPosition: read.hasMore ? messages.at(-1)?.position ?? null : null, truncated: read.hasMore, earlierAvailable: read.earlierAvailable, observedAt: now() }
    while (Buffer.byteLength(JSON.stringify(result)) > WATCHER_READ_BYTES_MAX && result.messages.length > 1) {
      if (input.position) result.messages.pop()
      else result.messages.shift()
      result = { ...result, firstPosition: result.messages[0]?.position ?? null, lastPosition: result.messages.at(-1)?.position ?? null, truncated: true,
        ...(input.position ? { nextPosition: result.messages.at(-1)?.position ?? null } : { earlierAvailable: true }) }
    }
    while (Buffer.byteLength(JSON.stringify(result)) > WATCHER_READ_BYTES_MAX && result.activities.length) { result.activities.shift(); result.truncated = true }
    if (Buffer.byteLength(JSON.stringify(result)) > WATCHER_READ_BYTES_MAX) {
      const message = result.messages[0]
      if (message) { message.text = Buffer.from(message.text).subarray(0, 32 * 1024).toString('utf8'); result.truncated = true }
    }
    if (Buffer.byteLength(JSON.stringify(result)) > WATCHER_READ_BYTES_MAX) refuse('HISTORY_UNAVAILABLE', 'This thread’s read exceeds the bounded response size. Read fewer messages.')
    if (result.lastPosition !== null) await this.options.control.updateWatcher(record => {
      record.reads = record.reads.filter(item => key(item.target) !== key(input.target)); record.reads.push({ target: input.target,
        position: { historyEpoch: read.historyEpoch, afterPosition: result.lastPosition! }, readAt: now() })
    })
    return result
  }

  private stopAllScope(): { targets: WatcherThreadTarget[]; signature: string } {
    const ownership = this.record().requests.filter(request => request.state === 'active').flatMap(request => request.participants
      .filter(item => item.startedBy === 'watcher' && item.state === 'participating')
      .map(item => ({ target: item.target, requestId: request.id, watcher: request.watcher })))
      .sort((a, b) => key(a.target).localeCompare(key(b.target)) || a.requestId.localeCompare(b.requestId))
    // Sign eligibility and ownership, not prompt counts, generations or message heads that normal work changes.
    return { targets: [...new Map(ownership.map(item => [key(item.target), item.target])).values()],
      signature: digest(ownership.map(item => [key(item.target), item.requestId, key(item.watcher)])) }
  }
  private pruneConfirmations(): void {
    for (const [id, confirmation] of this.confirmations) if (confirmation.expires < Date.now()) this.confirmations.delete(id)
  }
  /** Omitting the authenticated phone ID selects the desktop room's separate client. */
  prepareStopAll(phoneClientId?: string): WatcherPrepareStopAllResult {
    if (this.closed) return watcherRefusal('NOT_CURRENT_WATCHER', 'Watcher is stopping. Nothing was stopped. Reopen Sotto.')
    this.pruneConfirmations()
    const { targets, signature } = this.stopAllScope(), id = randomUUID(), expires = Date.now() + 60_000
    this.confirmations.set(id, { targets, expires, signature, phoneClientId })
    const clientPreviews = [...this.confirmations].filter(([, confirmation]) => confirmation.phoneClientId === phoneClientId)
    for (const [oldest] of clientPreviews.slice(0, -WATCHER_STOP_ALL_PREVIEW_LIMIT)) this.confirmations.delete(oldest)
    return { status: 'ok', confirmationId: id, targets, expiresAt: new Date(expires).toISOString() }
  }
  async stopAll(confirmationId: string, userGuard: () => void = () => undefined, phoneClientId?: string): Promise<WatcherStopAllResult> {
    if (this.closed) return watcherRefusal('NOT_CURRENT_WATCHER', 'Watcher is stopping. Nothing was stopped. Reopen Sotto.')
    this.pruneConfirmations()
    const confirmation = this.confirmations.get(confirmationId)
    if (!confirmation) return watcherRefusal('TARGET_CHANGED', 'That Stop all preview expired, was replaced by a newer one, or is unavailable. Review Stop all again. Nothing was stopped.')
    if (confirmation.phoneClientId !== phoneClientId) return watcherRefusal('TARGET_CHANGED', 'That Stop all preview was opened somewhere else. Review Stop all again here. Nothing was stopped.')
    this.confirmations.delete(confirmationId)
    if (confirmation.expires < Date.now() || confirmation.signature !== this.stopAllScope().signature) {
      return watcherRefusal('TARGET_CHANGED', 'The threads to stop changed or the confirmation expired. Review Stop all again.')
    }
    userGuard()
    const targets = confirmation.targets
    const requestIds = new Set(this.record().requests.filter(request => request.participants.some(item => targets.some(target => key(item.target) === key(target)))).map(item => item.id))
    const operationIds = new Set(this.record().operations.filter(item => requestIds.has(item.requestId)).map(item => item.id))
    await this.options.control.updateWatcher(record => {
      for (const request of record.requests) if (requestIds.has(request.id) && request.state === 'active') { request.state = 'stopped'; request.closedAt = now() }
      for (const operation of record.operations) if (operationIds.has(operation.id) && operation.deliveryState === 'queued') { operation.deliveryState = 'failed'; operation.refusalCode = 'REQUEST_NOT_ACTIVE' }
    })
    await this.options.control.cancelWatcherQueue(operationIds)
    await this.reconcileRemote()
    const results: Extract<WatcherStopAllResult, { status: 'ok' }>['results'] = []
    for (const target of targets) {
      const guard = () => {
        userGuard()
        if (this.closed) refuse('NOT_CURRENT_WATCHER', 'Watcher is stopping. Nothing was stopped.')
        const participant = this.record().requests.flatMap(request => request.participants).find(item => key(item.target) === key(target) && item.startedBy === 'watcher' && item.state === 'participating')
        if (!participant) refuse('THREAD_TAKEN_OVER', 'This thread was taken over and was not stopped.')
        this.protect(this.thread(target))
      }
      try {
        guard()
        if (target.hostId !== this.hostId()) {
          this.requireRemote(target.hostId, true)
          const request = this.record().requests.find(item => requestIds.has(item.id) && item.participants.some(participant => key(participant.target) === key(target)))!
          const input = { requestId: request.id, retryKey: randomUUID(), target }
          const participant = request.participants.find(item => key(item.target) === key(target))!
          const stamp = now(), operation: WatcherOperation = { id: randomUUID(), requestId: request.id, retryKey: input.retryKey,
            digest: digest(['stop_thread', input]), action: 'stop', target, generation: participant.generation, deliveryState: 'queued',
            createdAt: stamp, updatedAt: stamp, receiptId: randomUUID(), cardId: randomUUID(), anchorMessageId: request.rootUserMessageId, confirmedStop: true }
          await this.options.control.updateWatcher(record => record.operations.push(operation))
          const running = this.executeRemote('stop_thread', operation, input, guard)
          this.active.set(operation.id, running)
          let result: { status: string }
          try { result = await running as { status: string } }
          finally {
            this.active.delete(operation.id)
            this.dispatchRefusals.delete(operation.id)
            this.pruneRemoteGuards()
            if (this.record().operations.find(item => item.id === operation.id)?.deliveryState === 'uncertain') this.scheduleRemote(target.hostId, true)
          }
          const state = this.operationState(target)
          results.push({ target, status: result.status === 'refused' ? 'uncertain' : state.stopped ? 'stopped' : 'requested', message: result.status === 'refused' ? 'The stop was not confirmed. Reconnect and check this thread.' : 'Stop requested.' })
          continue
        }
        const result = await this.options.control.commandFromWatcher({ type: 'interrupt', threadId: target.threadId }, { guard })
        const state = this.operationState(target)
        results.push({ target, status: result.error ? 'uncertain' : state.stopped ? 'stopped' : 'requested', message: result.error ? 'The stop was not confirmed. Reconnect and check this thread.' : state.stopped ? 'Stopped.' : 'Stop requested. Background work may remain.' })
      } catch { results.push({ target, status: 'refused', message: 'This thread changed or is unavailable. It was not stopped.' }) }
    }
    this.publish(); return { status: 'ok', state: this.state(), results }
  }
  close(): void { this.closed = true; this.remoteOff?.(); clearTimeout(this.remoteTimer); this.remotePending.clear(); this.remoteFailures.clear(); this.remoteGuards.clear(); this.remoteProgress.clear(); this.wakes.close(); this.unsubscribe(); this.listeners.clear(); this.confirmations.clear(); this.pages.clear(); this.copyChoices.clear() }
}
