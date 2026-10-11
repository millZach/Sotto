import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { capabilitiesForThread, isThreadProviderConnected, lastUserMessageIdOf,
  type AgentCommand, type AgentHostSnapshot, type AgentModel, type AgentThread } from '../../shared/agents'
import { resolveModel } from '../../shared/modelCatalog'
import { RUNTIME_MODE_ORDER, resolveNewThreadPermission } from '../../shared/newThreadDefaults'
import { isThreadClosed, isWorkspaceThreadSettled } from '../../shared/threadActivity'
import { watcherOverview, type WatcherObservation } from '../../shared/watcherOverview'
import { WATCHER_PROMPTS_PER_THREAD, WATCHER_READ_BYTES_MAX, watcherToolSchemas,
  type WatcherIdentity, type WatcherOperation, type WatcherRecord, type WatcherRefusal, type WatcherThreadTarget,
  type WatcherToolInput, type WatcherToolName } from '../../shared/watcher'
import { watcherOpenRequestSchema, type WatcherOpenRequest, type WatcherRoomResult, type WatcherRoomState,
  type WatcherPrepareStopAllResult, type WatcherStopAllResult } from '../../shared/watcherRoom'
import type { AgentHostCommand } from './host'
import type { AgentControl } from './control'
import type { WorkspaceHost } from './workspace'
import { WatcherWakeUp } from './watcherWakeUp'
import type { WatcherEvent } from '../../shared/watcherNews'
import type { CheckpointObservation, PullRequestObservation } from './watcherEvidence'
import type { WatcherCommand, WatcherCommandOrigin, WatcherControlHooks } from './watcherCommands'

const now = () => new Date().toISOString()
const key = (target: WatcherThreadTarget) => JSON.stringify([target.hostId, target.threadId])
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
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
  private readonly confirmations = new Map<string, { targets: WatcherThreadTarget[]; signature: string; expires: number }>()
  private readonly pages = new Map<string, { kind: string; rows: unknown[]; expires: number }>()
  private readonly copyChoices = new Map<string, { projectId: string; path?: string; branch?: string; revision: string }>()
  private closed = false
  private readonly unsubscribe: () => void
  constructor(private readonly options: { directory: string; control: AgentControl; host: WorkspaceHost;
    limit: () => number; historyEnabled: () => boolean; revoke?: (id: string) => void }) {
    this.wakes = new WatcherWakeUp({ snapshot: () => options.control.watcherSnapshot(), record: () => this.record(),
      deliver: news => options.control.deliverWakeUp(news.watcher.threadId, news, { tool: false }),
      prune: () => options.control.pruneWatcherWakeUps(), remember: ids => options.control.updateWatcher(record => { record.wakeEventIds = [...new Set([...record.wakeEventIds ?? [], ...ids])].slice(-1_000) }),
      changed: () => this.publish(), failed: () => { this.recoveryNotice = 'Watcher news could not be saved. Reconnect or refresh its threads to retry. Nothing was approved.' } })
    const unhook = options.control.useWatcher(this), unsubscribe = options.control.subscribe(() => this.publish())
    this.unsubscribe = () => { unhook(); unsubscribe() }
  }
  private record(): WatcherRecord { return this.options.control.watcherRecord() }
  private hostId(): string { const id = this.options.control.hostId(); if (!id) refuse('HOST_DISCONNECTED', 'This computer is not ready. Reconnect its provider.', true); return id }
  private target(threadId: string): WatcherThreadTarget { return { hostId: this.hostId(), threadId } }
  private thread(target: WatcherThreadTarget): AgentThread {
    if (target.hostId !== this.hostId()) refuse('HOST_FEATURE_UNAVAILABLE', 'Watcher can direct threads on this computer. Remote Watcher tools are not available yet.')
    const thread = this.options.control.watcherSnapshot().threads.find(item => item.id === target.threadId)
    if (!thread) refuse('UNKNOWN_TARGET', 'That thread is unavailable. Read the thread list again.')
    return thread
  }
  private checkCaller(threadId: string): void {
    if (this.closed || this.record().current?.target.threadId !== threadId || this.record().current?.target.hostId !== this.hostId()
      || this.options.control.watcherSnapshot().threads.some(item => item.id === threadId && item.kind !== 'watcher')) refuse('NOT_CURRENT_WATCHER', 'Only the current Watcher can use these tools. Open Watcher to continue.')
  }
  isCurrent(threadId: string): boolean {
    try { this.checkCaller(threadId); return true } catch { return false }
  }
  subscribe(listener: (state: WatcherRoomState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private publish(): void { if (!this.closed) { this.wakes.observe(); this.options.control.refreshWatcherObservation(); for (const listener of this.listeners) listener(this.state()) } }
  watchedThreadIds(): string[] { return this.wakes.watchedThreadIds() }
  wakeDue(event: WatcherEvent): boolean { return this.wakes.due(event) }
  wakeReady(): boolean { return this.wakes.ready() }
  pullRequestObserved(read: PullRequestObservation): void { this.wakes.pullRequest(read) }
  checkpointObserved(read: CheckpointObservation): void { this.wakes.checkpoint(read) }
  private transaction<T>(work: () => Promise<T>): Promise<T> {
    const task = this.tail.catch(() => undefined).then(work); this.tail = task; return task
  }
  private reservedProject(path: string): boolean {
    const normalized = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
    return [join(this.options.directory, 'watcher', 'workspace'), join(this.options.directory, 'host-setup')].some(folder => normalized(path) === normalized(folder))
  }
  private protectedThread(thread: AgentThread): boolean {
    return Boolean(thread.kind && thread.kind !== 'project' || this.options.control.watcherSnapshot().projects.some(project => project.id === thread.projectId && this.reservedProject(project.path)))
  }
  private protect(thread: AgentThread): void {
    if (this.protectedThread(thread)) refuse('RESERVED_THREAD', 'This thread has a special job and cannot be directed by Watcher.')
    if (isThreadClosed(thread)) refuse('TARGET_CHANGED', 'This thread is closed. Open another thread.')
  }
  private connected(thread: AgentThread): boolean { return isThreadProviderConnected(this.options.control.watcherSnapshot(), thread) && thread.clientConnected !== false }
  private pending(thread: AgentThread): void { if (thread.requests.length) refuse('PENDING_USER_REQUEST', 'This thread needs your answer. Open its own request card. Nothing was sent.') }
  private permission(model: AgentModel | undefined, explicit?: WatcherToolInput<'start_thread'>['permission']) {
    const ceiling = resolveNewThreadPermission(model, this.options.control.configuration().newThreadRuntimeMode ?? 'approval-required')
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
    const model = resolveModel(this.options.control.watcherSnapshot().models, thread.modelId)
    const permission = thread.providerMode ? { kind: 'provider' as const, choiceId: thread.providerMode }
      : { kind: 'runtime' as const, mode: thread.runtimeMode ?? 'approval-required' as const }
    this.permission(model, permission)
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
      settled: Boolean(thread && isWorkspaceThreadSettled(thread, this.options.control.watcherSnapshot().projects.find(item => item.id === thread!.projectId))),
      backgroundWorkCount: (thread?.backgroundWork?.length ?? 0) + (thread?.monitoring?.length ?? 0), observedAt: thread ? now() : null,
      freshness: thread && this.connected(thread) ? 'fresh' as const : 'stale' as const }
  }
  state(): WatcherRoomState {
    const record = this.record(), state = this.options.control.shell()
    const current = this.options.control.watcherSnapshot().threads.find(item => item.id === record.current?.target.threadId)
    const targets = new Map(record.requests.flatMap(request => request.participants.map(item => [key(item.target), item.target] as const)))
    return { current: record.current, currentOptions: current ? { modelId: current.modelId, reasoningEffort: current.reasoningEffort ?? null,
      status: current.status, connected: this.connected(current) } : null, history: record.history, requests: record.requests,
      watchedThreads: [...targets.values()].map(target => {
        const thread = state.host.threads.find(item => item.id === target.threadId && target.hostId === state.host.hostId)
        return { target, title: thread?.title ?? 'Unavailable thread', status: thread?.status ?? 'unavailable', connected: Boolean(thread && this.connected(thread)),
          settled: Boolean(thread && isWorkspaceThreadSettled(thread, state.host.projects.find(item => item.id === thread.projectId))),
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
      if (record.creation) await this.finishCreation(record.creation.identity, record.creation.modelId ? { provider: record.creation.identity.provider, modelId: record.creation.modelId, ...(record.creation.reasoningEffort ? { reasoningEffort: record.creation.reasoningEffort } : {}) } : undefined)
      const current = this.record().current
      if (current && (this.thread(current.target).kind !== 'watcher' || this.thread(current.target).providerId !== current.provider)) {
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
    this.wakes.start(); this.publish()
  }
  open(input: WatcherOpenRequest): Promise<WatcherRoomResult> {
    if (this.opening) return this.opening
    this.opening = this.openOne(input).finally(() => { this.opening = undefined })
    return this.opening
  }
  private async openOne(input: WatcherOpenRequest): Promise<WatcherRoomResult> {
    try {
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
      void this.options.control.cancelWatcherQueue(operations).catch(() => { this.recoveryNotice = 'A stopped request has a queued message that could not be removed. It is fenced and will not be sent.'; this.publish() })
    }
  }
  private takeover(threadId: string, reason: 'user-send' | 'native-user-send' | 'user-stop' | 'user-settle' | 'user-reconfigure'): void {
    const owned = this.record().requests.some(request => request.participants.some(item => item.target.threadId === threadId && item.state === 'participating'))
    if (!owned) return
    const operations = new Set<string>()
    this.options.control.mutateWatcher(record => {
      for (const request of record.requests) for (const participant of request.participants) if (participant.target.threadId === threadId && participant.state === 'participating') {
        participant.state = 'taken-over'; participant.generation++; participant.takeover = { reason, at: now() }
        for (const operation of record.operations.filter(item => item.requestId === request.id && item.target.threadId === threadId)) {
          operations.add(operation.id)
          if (operation.deliveryState === 'queued') { operation.deliveryState = 'failed'; operation.refusalCode = 'THREAD_TAKEN_OVER'; operation.updatedAt = now() }
        }
      }
      record.reservations = record.reservations.filter(item => item.target.threadId !== threadId
        || record.operations.some(operation => key(operation.target) === key(item.target) && ['dispatching', 'uncertain'].includes(operation.deliveryState)))
    })
    void this.options.control.cancelWatcherQueue(operations).catch(() => { this.recoveryNotice = 'A taken-over thread’s queued Watcher message could not be removed. It is fenced and will not be sent.'; this.publish() })
  }
  preserveUserQueue(threadId: string): boolean {
    return this.record().requests.some(request => request.participants.some(participant => participant.target.threadId === threadId
      && participant.state === 'participating' && (participant.automationStopped || request.state === 'stopped' && participant.startedBy === 'watcher')))
  }
  beforeDispatch(command: AgentHostCommand, _draftId: string | undefined, origin?: WatcherCommandOrigin): AgentHostCommand {
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
        state: 'active', createdAt: now(), closedAt: null, participants: [] }
      const created = request
      this.options.control.mutateWatcher(next => { next.requests.push(created) })
    }
    const followup = request.userFollowups?.find(item => item.draftId === _draftId)
    if (followup) this.options.control.mutateWatcher(next => {
      next.requests.find(item => item.id === request!.id)!.userFollowups!.find(item => item.draftId === _draftId)!.messageId = command.messageId
    })
    const projects = this.options.control.watcherSnapshot().projects.filter(item => item.id !== record.current?.projectId)
    return { ...command, text: `${command.text}\n\n[Sotto Watcher request: ${request.id}. Local host: ${this.hostId()}. Use this requestId for sotto_threads mutations. Known project IDs: ${projects.slice(0, 100).map(item => item.id).join(', ')}. Call list_projects for choices.]` }
  }
  observe(snapshot: AgentHostSnapshot, knownUserMessages: ReadonlySet<string>): void {
    const record = this.record()
    for (const thread of snapshot.threads) {
      const head = lastUserMessageIdOf(thread), previous = this.nativeHeads.get(thread.id)
      this.nativeHeads.set(thread.id, head)
      const participants = record.requests.flatMap(request => request.participants).filter(item => item.target.threadId === thread.id && item.state === 'participating')
      const machineHead = record.operations.some(item => item.target.threadId === thread.id && item.messageId === head)
      if (head && !machineHead && participants.some(participant => {
        const durableHead = record.operations.findLast(item => item.target.threadId === thread.id && item.messageId)?.messageId
        const baseline = participant.lastUserMessageId !== undefined ? participant.lastUserMessageId : previous ?? durableHead
        return baseline !== undefined && head !== baseline && (participant.lastUserMessageId !== undefined || durableHead !== undefined || !knownUserMessages.has(head))
      })) this.takeover(thread.id, 'native-user-send')
      if (participants.length && this.connected(thread)) this.options.control.mutateWatcher(next => {
        for (const request of next.requests) for (const participant of request.participants) if (participant.target.threadId === thread.id && participant.state === 'participating') participant.lastUserMessageId = head
      })
    }
    this.options.control.mutateWatcher(next => {
      for (const operation of next.operations) {
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
          if (operation.deliveryState !== 'failed' && refusal) this.refundPrompt(next, operation, refusal)
          operation.deliveryState = 'failed'; operation.refusalCode = refusal ?? operation.refusalCode ?? 'PROVIDER_UNAVAILABLE'
          this.dispatchRefusals.delete(operation.id)
        }
      }
      next.reservations = next.reservations.filter(reservation => {
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
        const master = snapshot.threads.find(item => item.id === request.watcher.threadId)
        const head = master && lastUserMessageIdOf(master)
        if (master?.lastTurn && (head === request.rootUserMessageId || request.userFollowups?.some(item => item.messageId === head))
          && master.lastTurn.status !== 'running' && master.status !== 'running' && !this.options.control.hasPendingThreadWork(master.id)) { request.state = 'closed'; request.closedAt = now() }
      }
      for (const request of next.requests) if (request.state === 'active' && request.participants.length
        && request.participants.every(item => item.state !== 'participating' || snapshot.threads.some(thread => thread.id === item.target.threadId
          && isWorkspaceThreadSettled(thread, snapshot.projects.find(project => project.id === thread.projectId))))
        && !this.options.control.hasPendingThreadWork(request.watcher.threadId)
        && !next.operations.some(item => item.requestId === request.id && ['queued', 'dispatching', 'uncertain'].includes(item.deliveryState))) {
        request.state = 'closed'; request.closedAt = now()
      }
    })
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
    if (!operation || record.current?.target.threadId !== record.requests.find(item => item.id === operation.requestId)?.watcher.threadId) refuse('NOT_CURRENT_WATCHER', 'This operation no longer belongs to the current Watcher.')
    const request = record.requests.find(item => item.id === operation.requestId)!
    if (operation.deliveryState === 'failed') refuse(operation.refusalCode ?? 'REQUEST_NOT_ACTIVE', 'This operation was cancelled before dispatch. Nothing was sent.')
    if (request.state !== 'active') refuse('REQUEST_NOT_ACTIVE', 'This Watcher request has stopped. Nothing was sent.')
    const participant = request.participants.find(item => key(item.target) === key(operation.target))
    if (!participant || participant.state !== 'participating' || participant.generation !== operation.generation) refuse('THREAD_TAKEN_OVER', 'You took over this thread. Watcher stopped sending to it.')
    if (participant.automationStopped && (operation.action === 'start' || operation.action === 'send')) refuse('REQUEST_NOT_ACTIVE', 'Watcher stopped this participation. It will not send another prompt for this request.')
    if (operation.action === 'start' && !this.options.control.watcherSnapshot().threads.some(item => item.id === operation.target.threadId)) return
    const thread = this.thread(operation.target); this.protect(thread)
    if (!this.connected(thread)) refuse('HOST_DISCONNECTED', 'This thread is disconnected. Nothing was sent. Reconnect its provider.', true)
    if (operation.action === 'start' || operation.action === 'send') {
      this.pending(thread); this.checkPermission(thread)
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
      if (name === 'list_threads') return this.listThreads(parsed.data as WatcherToolInput<'list_threads'>)
      if (name === 'list_projects') return this.listProjects(parsed.data as WatcherToolInput<'list_projects'>)
      if (name === 'list_working_copies') return await this.listWorkingCopies(parsed.data as WatcherToolInput<'list_working_copies'>)
      if (name === 'read_thread') return await this.readThread(parsed.data as WatcherToolInput<'read_thread'>)
      if (name === 'read_operation') {
        const operation = this.record().operations.find(item => item.id === (parsed.data as WatcherToolInput<'read_operation'>).operationId)
        if (!operation || !this.record().requests.some(item => item.id === operation.requestId && item.watcher.threadId === threadId)) refuse('UNKNOWN_OPERATION', 'That operation does not belong to this Watcher request.')
        return { status: 'ok', receipt: this.receipt(operation), limits: this.limits(operation), action: operation.action, state: this.operationState(operation.target) }
      }
      return await this.mutate(threadId, name, parsed.data as WatcherToolInput<'start_thread'> | WatcherToolInput<'send_to_thread'> | WatcherToolInput<'stop_thread'>)
    } catch (error) { return error instanceof Refusal ? error.result : watcherRefusal('PROVIDER_UNAVAILABLE', 'This Watcher call could not be completed. Check the operation receipt before trying again.', true) }
    finally { this.invocations-- }
  }
  private async mutate(threadId: string, name: WatcherToolName, input: WatcherToolInput<'start_thread'> | WatcherToolInput<'send_to_thread'> | WatcherToolInput<'stop_thread'>): Promise<unknown> {
    const admitted = await this.transaction(async () => {
      this.checkCaller(threadId)
      const record = this.record(), request = record.requests.find(item => item.id === input.requestId)
      if (!request || request.watcher.threadId !== threadId || request.state !== 'active') refuse('REQUEST_NOT_ACTIVE', 'This request is not active. Only a user Send to Watcher can start a request.')
      const fingerprint = digest([name, input])
      const existing = record.operations.find(item => item.requestId === input.requestId && item.retryKey === input.retryKey)
      if (existing) {
        if (existing.digest !== fingerprint) refuse('RETRY_KEY_CONFLICT', 'This retry key already belongs to a different call. Use the original receipt.')
        return { operation: existing, retry: true }
      }
      const start = name === 'start_thread', send = name === 'send_to_thread'
      const target = start ? this.target(randomUUID()) : (input as WatcherToolInput<'send_to_thread'>).target
      const thread = start ? undefined : this.thread(target)
      if (thread) { this.protect(thread); if (!this.connected(thread)) refuse('HOST_DISCONNECTED', 'This thread is disconnected. Reconnect it before sending.', true) }
      if (record.requests.some(item => item.participants.some(participant => key(participant.target) === key(target) && participant.state === 'taken-over'))) refuse('THREAD_TAKEN_OVER', 'You took over this thread. Watcher stopped sending to it.')
      if (start) {
        const create = input as WatcherToolInput<'start_thread'>
        if (create.project.hostId !== this.hostId()) refuse('HOST_FEATURE_UNAVAILABLE', 'Remote Watcher control is not available yet.')
        const project = this.options.control.watcherSnapshot().projects.find(item => item.id === create.project.projectId)
        if (!project) refuse('UNKNOWN_TARGET', 'That project is unavailable. Read the project list again.')
        if (this.reservedProject(project.path)) refuse('RESERVED_THREAD', 'This project has a special job and is not a worker project.')
        const model = resolveModel(this.options.control.watcherSnapshot().models, create.modelId)
        if (!model?.ready) refuse('PROVIDER_UNAVAILABLE', 'Choose a ready worker model. Sotto will not switch accounts.')
        if (create.reasoningEffort && !model.reasoningEfforts?.includes(create.reasoningEffort)) refuse('INVALID_INPUT', 'Choose an effort this worker model offers.')
        this.permission(model, create.permission)
        if (create.workingCopy.kind === 'existing-worktree' && !this.copyChoices.has(create.workingCopy.choiceId)
          || create.baseRefChoiceId && !this.copyChoices.has(create.baseRefChoiceId)) refuse('WORKING_COPY_CHANGED', 'Read the working-copy choices again before starting this thread.')
      }
      if (thread && (send || name === 'settle_thread')) this.pending(thread)
      if (thread && send) {
        this.checkPermission(thread)
        const sent = input as WatcherToolInput<'send_to_thread'>
        if (sent.expectedLastUserMessageId && sent.expectedLastUserMessageId !== lastUserMessageIdOf(thread)) refuse('TARGET_CHANGED', 'This thread received another instruction. Read it before sending.')
        if (sent.delivery === 'now' && (thread.status === 'running' || this.options.control.hasPendingThreadWork(thread.id))) refuse('THREAD_BUSY', 'This thread is working or has a queued prompt. Choose queue explicitly.')
        if (sent.delivery === 'steer' && (!capabilitiesForThread(this.options.control.watcherSnapshot(), thread).steer || !sent.expectedTurnId || sent.expectedTurnId !== thread.lastTurn?.id || thread.status !== 'running')) refuse('STEER_UNAVAILABLE', 'Steer needs a supported, confirmed running turn. Read the thread and its turn first.')
      }
      if (thread && name === 'settle_thread') {
        this.checkSettlement(thread)
        if (this.options.control.hasPendingThreadWork(thread.id)) refuse('DELIVERY_UNCERTAIN', 'Reconcile this thread’s pending delivery before settling.')
      }
      const previous = request.participants.find(item => key(item.target) === key(target))
      if (send && previous?.automationStopped) refuse('REQUEST_NOT_ACTIVE', 'Watcher stopped this participation. It will not send another prompt for this request.')
      if (start || send) {
        if (this.inFlight(record) > this.options.limit() || !record.reservations.some(item => key(item.target) === key(target)) && this.inFlight(record) >= this.options.limit()) refuse('IN_FLIGHT_LIMIT', 'Watcher’s threads in flight limit is reached. Wait for a thread to finish.', true)
        if ((previous?.promptCount ?? 0) >= WATCHER_PROMPTS_PER_THREAD) refuse('PROMPT_LIMIT', 'This thread has received four prompts for this Watcher request. The limit cannot be renewed by a retry.')
      }
      const time = now(), id = randomUUID()
      const operation: WatcherOperation = { id, requestId: request.id, retryKey: input.retryKey, digest: fingerprint,
        action: start ? 'start' : send ? 'send' : name === 'stop_thread' ? 'stop' : 'settle', target,
        generation: previous?.generation ?? 0, anchorMessageId: request.rootUserMessageId, deliveryState: 'queued', createdAt: time, updatedAt: time, receiptId: randomUUID(), cardId: randomUUID(),
        ...(start || send ? { draftId: randomUUID(), messageId: randomUUID(), delivery: start ? 'now' : (input as WatcherToolInput<'send_to_thread'>).delivery } : {}),
        ...(start ? { creationReceiptId: randomUUID(), firstPromptReceiptId: randomUUID() } : {}),
        ...(send && (input as WatcherToolInput<'send_to_thread'>).expectedTurnId ? { expectedTurnId: (input as WatcherToolInput<'send_to_thread'>).expectedTurnId } : {}),
        ...(send && (input as WatcherToolInput<'send_to_thread'>).expectedLastUserMessageId ? { expectedLastUserMessageId: (input as WatcherToolInput<'send_to_thread'>).expectedLastUserMessageId } : {}) }
      await this.options.control.updateWatcher(next => {
        const owned = next.requests.find(item => item.id === request.id)!
        let participant = owned.participants.find(item => key(item.target) === key(target))
        if (!participant) { participant = { requestId: request.id, target, startedBy: start || next.requests.some(item => item.participants.some(worker => key(worker.target) === key(target) && worker.startedBy === 'watcher')) ? 'watcher' : 'user', generation: 0, state: 'participating', promptCount: 0, lastUserMessageId: thread ? lastUserMessageIdOf(thread) : null }; owned.participants.push(participant) }
        if (start || send) participant.promptCount++
        next.operations.push(operation)
        if ((start || send) && !next.reservations.some(item => key(item.target) === key(target))) next.reservations.push({ target, requestId: request.id, operationId: id, generation: participant.generation, reason: start ? 'creation' : operation.delivery === 'queue' ? 'queued' : 'dispatching' })
      })
      return { operation, retry: false }
    })
    if (admitted.retry) { const active = this.active.get(admitted.operation.id); if (active) return await active; return this.operationResult(name, admitted.operation, input) }
    const running = this.executeOperation(name, admitted.operation, input)
    this.active.set(admitted.operation.id, running)
    try { return await running } finally { this.active.delete(admitted.operation.id); this.dispatchRefusals.delete(admitted.operation.id); this.publish() }
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
        const permission = this.permission(resolveModel(this.options.control.watcherSnapshot().models, create.modelId), create.permission)
        const createOrigin: WatcherCommandOrigin = { operationId: operation.id, guard: () => {
          origin.guard()
          this.permission(resolveModel(this.options.control.watcherSnapshot().models, create.modelId), permission)
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
        const saved = record.operations.find(item => item.id === operation.id)!, wasFailed = saved.deliveryState === 'failed'
        const creationUncertain = saved.action === 'start' && this.options.host.watcherCreationPhase(saved.target.threadId) === 'starting'
        const unresolved = creationUncertain || this.options.control.watcherCommandOutstanding(saved.commandId)
        const queue = result.followups?.find(item => item.draftId === operation.draftId && item.threadId === operation.target.threadId)
        saved.deliveryState = saved.deliveryState === 'accepted' || delivery?.status === 'accepted' ? 'accepted'
          : delivery?.status === 'uncertain' || delivery?.status === 'submitting' ? 'uncertain' : queue ? 'queued' : result.error && unresolved ? 'uncertain' : result.error ? 'failed' : 'accepted'
        if (creationUncertain) saved.creationUncertain = true
        if (saved.deliveryState === 'failed') { saved.refusalCode = 'PROVIDER_UNAVAILABLE'; if (!wasFailed) this.refundPrompt(record, saved, saved.refusalCode) }
        if (creationUncertain) saved.refusalCode = 'DELIVERY_UNCERTAIN'
        if (queue) saved.itemId = queue.id
        if (saved.action === 'settle' && saved.deliveryState === 'accepted') record.requests.find(item => item.id === saved.requestId)!.participants.find(item => key(item.target) === key(saved.target))!.state = 'relinquished'
        saved.updatedAt = now()
      })
    } catch (error) {
      await this.options.control.updateWatcher(record => { const saved = record.operations.find(item => item.id === operation.id)!, wasFailed = saved.deliveryState === 'failed';
        const creationUncertain = saved.action === 'start' && this.options.host.watcherCreationPhase(saved.target.threadId) === 'starting'
        if (creationUncertain) saved.creationUncertain = true
        if (saved.deliveryState !== 'accepted' && saved.deliveryState !== 'uncertain') saved.deliveryState = creationUncertain || this.options.control.watcherCommandOutstanding(saved.commandId) ? 'uncertain' : 'failed'
        saved.refusalCode = saved.deliveryState === 'uncertain' ? 'DELIVERY_UNCERTAIN' : error instanceof Refusal ? error.result.code : 'PROVIDER_UNAVAILABLE'; saved.updatedAt = now()
        if (!wasFailed && saved.deliveryState === 'failed') {
          if (error instanceof Refusal) this.refundPrompt(record, saved, error.result.code)
          else if (saved.action === 'start' && !this.options.control.watcherSnapshot().threads.some(item => item.id === saved.target.threadId)) this.refundPrompt(record, saved, 'PROVIDER_UNAVAILABLE')
        }
      })
    }
    this.observe(this.options.control.watcherSnapshot(), new Set())
    return this.operationResult(name, this.record().operations.find(item => item.id === operation.id)!, input)
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
      const thread = this.options.control.watcherSnapshot().threads.find(item => item.id === operation.target.threadId)
      if (!thread) return { ...watcherRefusal('DELIVERY_UNCERTAIN', 'The creation is recorded, but its thread is unavailable. This retry started nothing. Reconcile the original receipt.', true), receipt: base.receipt }
      return { status: 'ok', ...base, target: operation.target, creationReceiptId: operation.creationReceiptId!, firstPromptReceiptId: operation.firstPromptReceiptId!,
        effectiveChoices: { modelId: thread.modelId, reasoningEffort: thread.reasoningEffort ?? null,
          permission: thread.providerMode ? { kind: 'provider', choiceId: thread.providerMode } : { kind: 'runtime', mode: thread.runtimeMode ?? 'approval-required' },
          workingCopy: create.workingCopy, ...(create.baseRefChoiceId ? { baseRefChoiceId: create.baseRefChoiceId } : {}) } }
    }
    if (name === 'send_to_thread') return { status: 'ok', ...base, delivery: operation.delivery }
    return { status: 'ok', ...base, state: this.operationState(operation.target), ...(name === 'stop_thread' ? { stopRequested: true } : {}) }
  }

  private page(kind: string, rows: unknown[], cursor: string | undefined, limit: number): { rows: unknown[]; revision: string; nextCursor: string | null } {
    for (const [id, page] of this.pages) if (page.expires < Date.now()) this.pages.delete(id)
    if (this.pages.size > 16) this.pages.delete(this.pages.keys().next().value!)
    let revision: string, position = 0
    if (cursor) {
      const match = /^([a-f0-9-]{36}):(\d+)$/u.exec(cursor), page = match && this.pages.get(match[1]!)
      if (!page || page.kind !== kind) refuse('CURSOR_EXPIRED', 'This list changed or its cursor expired. Read its first page again.', true)
      revision = match![1]!; position = Number(match![2]); rows = page.rows
    } else { revision = randomUUID(); this.pages.set(revision, { kind, rows, expires: Date.now() + 60_000 }) }
    return { rows: rows.slice(position, position + limit), revision, nextCursor: position + limit < rows.length ? `${revision}:${position + limit}` : null }
  }
  private listThreads(input: WatcherToolInput<'list_threads'>) {
    if (input.hostId && input.hostId !== this.hostId() || input.project && input.project.hostId !== this.hostId()) refuse('HOST_FEATURE_UNAVAILABLE', 'Remote Watcher thread reads are not available yet.')
    const state = this.options.control.shell(), record = this.record()
    const rows = watcherOverview({ host: this.options.control.watcherSnapshot() }, Date.now(), this.wakes.observations).filter(row => (!input.project || row.thread.projectId === input.project.projectId)
      && (!input.group || row.group === input.group) && (input.includeSettled || !isWorkspaceThreadSettled(row.thread, state.host.projects.find(item => item.id === row.thread.projectId))))
      .map(row => { const thread = row.thread, target = this.target(thread.id)
        return { target, title: thread.title, projectId: thread.projectId, provider: thread.providerId ?? resolveModel(state.host.models, thread.modelId)?.providerId,
          modelId: thread.modelId, ...(thread.reasoningEffort ? { reasoningEffort: thread.reasoningEffort } : {}), status: thread.status, group: row.group,
          waitsOn: thread.requests.map(item => ({ id: item.id, kind: item.kind, label: item.kind === 'permission' ? 'Open to answer permission' : 'Open to answer question', openTarget: target })),
          branch: thread.worktree?.branch ?? null, workingCopy: thread.worktree ? { kind: thread.worktree.mode === 'shared' ? 'shared' as const : 'new-worktree' as const } : null,
          pullRequests: (thread.pullRequests ?? []).map(item => ({ number: item.number, url: item.url, title: item.title ?? '', state: item.state, draft: item.draft ?? false })),
          evidence: this.wakes.evidence.read(target, row.available), lastActivityAt: this.wakes.observations.get(JSON.stringify([thread.hostId ?? null, thread.id]))?.lastProgressAt ?? null, observedAt: row.observedAt ?? null, connected: row.available,
          freshness: row.freshness, userReadAt: null, watcherReadAt: record.reads.find(item => key(item.target) === key(target))?.readAt ?? null,
          participation: record.requests.flatMap(request => request.participants.filter(item => key(item.target) === key(target)).map(({ target: _target, promptCount: _count, lastUserMessageId: _head, ...participant }) => { void _target; void _count; void _head; return participant })),
          protected: this.protectedThread(thread) } })
    const page = this.page(`threads:${digest([input.hostId, input.project, input.group, input.includeSettled])}`, rows, input.cursor, input.limit)
    return { status: 'ok', rows: page.rows, snapshotRevision: page.revision, nextCursor: page.nextCursor, observedAt: now(), staleHosts: [],
      counts: Object.fromEntries(['Needs you', 'Ready for review', 'Working', 'Landing', 'Quiet', 'Idle'].map(group => [group, rows.filter(row => row.group === group).length])) }
  }
  private listProjects(input: WatcherToolInput<'list_projects'>) {
    if (input.hostId && input.hostId !== this.hostId()) refuse('HOST_FEATURE_UNAVAILABLE', 'Remote Watcher projects are not available yet.')
    const state = this.options.control.shell()
    const rows = state.host.projects.filter(item => !this.reservedProject(item.path)).map(project => ({
      target: { hostId: this.hostId(), projectId: project.id }, title: project.title, displayRoot: project.path,
      workers: state.host.models.filter(model => model.ready).slice(0, 100).map(model => {
        let defaultPermission: ReturnType<WatcherService['permission']> | null = null
        try { defaultPermission = this.permission(model) } catch { /* Explicitly incomparable. */ }
        return { provider: model.providerId, modelId: model.id, reasoningEfforts: model.reasoningEfforts ?? [], defaultPermission, permissionComparable: defaultPermission !== null }
      }), controlAvailable: true, readsAvailable: true, readOnlyProfileAvailable: true, freshness: 'fresh' }))
    const page = this.page('projects', rows, input.cursor, input.limit)
    return { status: 'ok', projects: page.rows, nextCursor: page.nextCursor, observedAt: now(), staleHosts: [] }
  }
  private async listWorkingCopies(input: WatcherToolInput<'list_working_copies'>) {
    if (input.project.hostId !== this.hostId()) refuse('HOST_FEATURE_UNAVAILABLE', 'Remote Watcher working-copy choices are not available yet.')
    const options = await this.options.host.workingCopyOptions(input.project.projectId), revision = digest(options)
    const choices = [{ choiceId: randomUUID(), kind: 'shared', branch: options.currentBranch, occupied: false, locked: false, limitations: [] as string[] },
      ...(options.isGit ? [{ choiceId: randomUUID(), kind: 'new-worktree', branch: options.currentBranch, occupied: false, locked: false, limitations: [] as string[] }] : [])]
    for (const copy of options.worktrees) {
      const occupied = this.options.control.watcherSnapshot().threads.some(thread => thread.worktree?.path === copy.path)
      const choiceId = randomUUID(); this.copyChoices.set(choiceId, { projectId: input.project.projectId, path: copy.path, revision })
      choices.push({ choiceId, kind: 'existing-worktree', branch: copy.branch, occupied, locked: false, limitations: occupied ? ['Already used by a thread'] : [] })
    }
    const baseRefs = options.branches.slice(0, 100).map(branch => { const choiceId = randomUUID(); this.copyChoices.set(choiceId, { projectId: input.project.projectId, branch, revision }); return { choiceId, name: branch } })
    const page = this.page(`copies:${input.project.projectId}`, choices, input.cursor, input.limit)
    return { status: 'ok', project: input.project, revision, choices: page.rows, baseRefs, nextCursor: page.nextCursor, observedAt: now(), staleHosts: [] }
  }
  private async resolveCopies(input: WatcherToolInput<'start_thread'>) {
    if (input.workingCopy.kind === 'shared' && !input.baseRefChoiceId) return { workingCopy: 'shared' as const }
    const options = await this.options.host.workingCopyOptions(input.project.projectId), revision = digest(options)
    const copy = input.workingCopy.kind === 'existing-worktree' ? this.copyChoices.get(input.workingCopy.choiceId) : undefined
    const base = input.baseRefChoiceId ? this.copyChoices.get(input.baseRefChoiceId) : undefined
    if (copy && (copy.projectId !== input.project.projectId || copy.revision !== revision || !options.worktrees.some(item => item.path === copy.path))
      || base && (base.projectId !== input.project.projectId || base.revision !== revision) || input.workingCopy.kind === 'existing-worktree' && !copy
      || input.baseRefChoiceId && !base || !options.isGit && input.workingCopy.kind !== 'shared') refuse('WORKING_COPY_CHANGED', 'The working-copy choices changed. Read them again. Nothing was started.')
    if (copy && this.options.control.watcherSnapshot().threads.some(thread => thread.worktree?.path === copy.path)) refuse('WORKING_COPY_UNAVAILABLE', 'That working copy is already used by a thread.')
    return { workingCopy: input.workingCopy.kind === 'shared' ? 'shared' as const : 'independent' as const,
      ...(copy?.path ? { existingWorktreePath: copy.path } : {}), ...(base?.branch ? { baseBranch: base.branch } : {}) }
  }
  private async readThread(input: WatcherToolInput<'read_thread'>) {
    const thread = this.thread(input.target)
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
      result.messages.pop(); result = { ...result, lastPosition: result.messages.at(-1)?.position ?? null, nextPosition: result.messages.at(-1)?.position ?? null, truncated: true }
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

  private eligible(): WatcherThreadTarget[] {
    const record = this.record()
    return [...new Map(record.requests.filter(request => request.state === 'active').flatMap(request => request.participants
      .filter(item => item.startedBy === 'watcher' && item.state === 'participating').map(item => [key(item.target), item.target] as const))).values()]
  }
  prepareStopAll(): WatcherPrepareStopAllResult {
    const targets = this.eligible(), id = randomUUID(), expires = Date.now() + 60_000
    this.confirmations.set(id, { targets, expires, signature: digest([targets, this.record().requests]) })
    return { status: 'ok', confirmationId: id, targets, expiresAt: new Date(expires).toISOString() }
  }
  async stopAll(confirmationId: string): Promise<WatcherStopAllResult> {
    const confirmation = this.confirmations.get(confirmationId); this.confirmations.delete(confirmationId)
    if (!confirmation || confirmation.expires < Date.now() || confirmation.signature !== digest([this.eligible(), this.record().requests])) {
      return watcherRefusal('TARGET_CHANGED', 'The threads to stop changed or the confirmation expired. Review Stop all again.')
    }
    const targets = confirmation.targets
    const requestIds = new Set(this.record().requests.filter(request => request.participants.some(item => targets.some(target => key(item.target) === key(target)))).map(item => item.id))
    const operationIds = new Set(this.record().operations.filter(item => requestIds.has(item.requestId)).map(item => item.id))
    await this.options.control.updateWatcher(record => {
      for (const request of record.requests) if (requestIds.has(request.id) && request.state === 'active') { request.state = 'stopped'; request.closedAt = now() }
      for (const operation of record.operations) if (operationIds.has(operation.id) && operation.deliveryState === 'queued') { operation.deliveryState = 'failed'; operation.refusalCode = 'REQUEST_NOT_ACTIVE' }
    })
    await this.options.control.cancelWatcherQueue(operationIds)
    const results: Extract<WatcherStopAllResult, { status: 'ok' }>['results'] = []
    for (const target of targets) {
      const guard = () => {
        const participant = this.record().requests.flatMap(request => request.participants).find(item => key(item.target) === key(target) && item.startedBy === 'watcher' && item.state === 'participating')
        if (!participant) refuse('THREAD_TAKEN_OVER', 'This thread was taken over and was not stopped.')
        this.protect(this.thread(target))
      }
      try {
        guard()
        const result = await this.options.control.commandFromWatcher({ type: 'interrupt', threadId: target.threadId }, { guard })
        const state = this.operationState(target)
        results.push({ target, status: result.error ? 'uncertain' : state.stopped ? 'stopped' : 'requested', message: result.error ? 'The stop was not confirmed. Reconnect and check this thread.' : state.stopped ? 'Stopped.' : 'Stop requested. Background work may remain.' })
      } catch { results.push({ target, status: 'refused', message: 'This thread changed or is unavailable. It was not stopped.' }) }
    }
    this.publish(); return { status: 'ok', state: this.state(), results }
  }
  close(): void { this.closed = true; this.wakes.close(); this.unsubscribe(); this.listeners.clear(); this.confirmations.clear(); this.pages.clear(); this.copyChoices.clear() }
}
