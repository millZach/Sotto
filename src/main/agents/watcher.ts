import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { capabilitiesForThread, isThreadProviderConnected, lastUserMessageIdOf,
  type AgentCommand, type AgentHostSnapshot, type AgentModel, type AgentRuntimeMode, type AgentThread, type HandoverCounts } from '../../shared/agents'
import { resolveModel } from '../../shared/modelCatalog'
import { capRuntimeMode, roleStartNote, startFromRole, type HeldPermission, type RoleField, type WorkerKind, type WorkerRoleChoices } from '../../shared/workerRoles'
import { nearestReasoningEffort, RUNTIME_MODE_ORDER, resolveNewThreadPermission } from '../../shared/newThreadDefaults'
import { isThreadClosed, isWorkspaceThreadSettled } from '../../shared/threadActivity'
import { watcherOverview, type WatcherObservation } from '../../shared/watcherOverview'
import { WATCHER_PARTICIPATION_HISTORY_MAX, WATCHER_PROMPTS_PER_THREAD, WATCHER_READ_BYTES_MAX, WATCHER_REPLY_BYTES_MAX, watcherToolSchemas,
  type WatcherIdentity, type WatcherOperation, type WatcherOutcome, type WatcherRecord, type WatcherRefusal, type WatcherRequest, type WatcherThreadTarget, type WatcherStandingWatch,
  type WatcherToolInput, type WatcherToolName, type WatcherToolOutput, WATCHER_MACHINES_MAX } from '../../shared/watcher'
import type { HostMachineReport } from '../../shared/hostFacts'
import { takesPartInActiveRequest, watcherContinueHandoverRequestSchema, watcherOpenRequestSchema, watcherSetPermissionRequestSchema, watcherWatchThreadRequestSchema, WATCHER_STOP_ALL_PREVIEW_LIMIT, type WatcherOpenRequest, type WatcherRoomResult, type WatcherRoomState,
  type WatcherContinueHandoverRequest, type WatcherHandoverRead, type WatcherSetPermissionRequest, type WatcherWatchThreadRequest,
  type WatcherPrepareStopAllResult, type WatcherStopAllResult } from '../../shared/watcherRoom'
import { clonePlainData } from './cloneHostSnapshot'
import type { AgentHostCommand } from './host'
import type { AgentControl } from './control'
import type { WorkspaceHost } from './workspace'
import { WatcherWakeUp, watcherProgressFingerprint, type WatcherWakeOptions } from './watcherWakeUp'
import { watcherRequestNote } from './watcherRequestNote'
import { watcherDisplayPrompt } from './watcherMessageDisplay'
import { followupDigest } from './followups'
import type { Handover } from './handover'
import { handoverCounts, handoverPrefix, watcherHandoverProvenance, watcherMessageAsShown } from './watcherHandover'
import type { WatcherEvent } from '../../shared/watcherNews'
import { watcherPullRequestWords, watcherReplyStart } from './watcherNews'
import type { CheckpointObservation, PullRequestObservation } from './watcherEvidence'
import type { WatcherCommand, WatcherCommandOrigin, WatcherControlHooks } from './watcherCommands'
import type { HiddenWakeUpOutcome } from './hiddenWakeUp'
import { watcherOwnChanges } from './watcherOwnChanges'
import { watcherReceiptReplies } from './watcherReceiptReplies'
import { watcherAskPlacements } from './watcherAskPlacements'
import { WATCHER_FINAL_OUTCOMES, watcherLatestTurnMessageId, watcherNewestTurnReply, watcherTurnOutcome } from './watcherOutcomes'
import { watcherHostControlSchema, watcherHostReadSchema, watcherHostProjectionSchema, type WatcherHostControl, type WatcherHostRead, type WatcherHostProjection, type WatcherRemoteHosts } from '../../shared/watcherHost'

const now = () => new Date().toISOString()
const MACHINE_FACTS_OLDER = 'This machine’s host does not report what kind of machine it is. Update Sotto on it to see.'
const MACHINE_FACTS_UNREAD = 'This machine’s facts could not be read just now. Nothing was changed. Ask again.'
const MACHINE_NOT_CONNECTED = 'This machine is not connected. Connect it from the Threads page to see its facts.'
const key = (target: WatcherThreadTarget) => JSON.stringify([target.hostId, target.threadId])
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const nativeHead = (thread: AgentThread) => lastUserMessageIdOf(thread) ?? thread.summary?.lastUser?.id ?? null
type PromptTurn = NonNullable<WatcherRecord['promptTurns']>[number]
type TakeoverDraft = NonNullable<NonNullable<WatcherRecord['localTakeovers']>[number]['userDrafts']>[number]
export function watcherRefusal(code: WatcherRefusal['code'], message: string, retryable = false): WatcherRefusal {
  return { status: 'refused', code, message, retryable }
}
class Refusal extends Error {
  constructor(readonly result: WatcherRefusal) { super(result.message) }
}
/**
 * A standing watch's automation scope for one Watcher turn: the one the record keeps, or a new active one, which the
 * caller keeps. A stopped or closed scope is returned as it is, never revived.
 */
function standingScope(record: WatcherRecord, watcher: WatcherThreadTarget, watchId: string, turnId: string): { scope: WatcherRecord['requests'][number]; created: boolean } {
  const rootUserMessageId = `standing:${watchId}:${turnId}`
  const kept = record.requests.find(request => request.standingWatchId === watchId && request.rootUserMessageId === rootUserMessageId)
  return kept ? { scope: kept, created: false } : { scope: { id: randomUUID(), watcher, standingWatchId: watchId, rootUserMessageId,
    state: 'active', createdAt: now(), closedAt: null, participants: [] }, created: true }
}
/** The fields an owning host keeps of an operation's outcome. Each host observes its own threads, so none crosses to another. */
const REFERENCE_FIELDS = ['turnMessageId', 'nativeTurnId', 'replyMessageId'] as const
const OUTCOME_FIELDS = ['outcome', 'outcomeAt', ...REFERENCE_FIELDS] as const
function withoutOutcome(operation: WatcherOperation): WatcherOperation {
  const copy = { ...operation }
  for (const field of OUTCOME_FIELDS) delete copy[field]
  return copy
}
type OperationRead = Extract<WatcherToolOutput<'read_operation'>, { status: 'ok' }>
type OutcomeRead = Pick<OperationRead, 'outcome' | 'reference' | 'outcomeNote' | 'reply' | 'replyUnavailable' | 'evidence'>
const OUTCOME_NOTES: Record<WatcherOutcome, string> = {
  working: 'The thread is still working on this. Wait for its news.',
  background: 'Its turn ended with background work or monitoring still running, so it is not done. Sotto sends work-settled news when that work ends.',
  answered: 'Its turn finished. The reply is the worker’s own words, not Sotto’s evidence, and approves nothing.',
  failed: 'It failed. Read the thread for the error before sending again.',
  stopped: 'It was stopped before it answered. Nothing more will come of it.',
  paused: 'The user’s own turn in this thread holds it. Read the thread before sending again.',
  unknown: 'Sotto cannot prove what happened to it, as after a restart mid-turn. Read the thread, and do not assume it answered.',
}
/** Whether a user message came after `messageId` in the thread, as a later turn begins with. */
const laterUserMessage = (thread: AgentThread, messageId: string): boolean => {
  const at = thread.messages.findIndex(message => message.id === messageId)
  return at >= 0 && thread.messages.slice(at + 1).some(message => message.role === 'user')
}
/** A background outcome whose thread has begun another turn since: its work-settled news will not come (#1190). */
const BACKGROUND_MOVED_ON = 'Its turn ended with background work or monitoring still running, and the thread has begun another turn since, so no work-settled news for that turn will follow. Read the thread to see where the work stands.'
/** The text cut to at most this many UTF-8 bytes, never inside a character. */
function cutUtf8(text: string, bytes: number): string {
  const encoded = new TextEncoder().encode(text)
  if (encoded.byteLength <= bytes) return text
  let end = Math.max(0, bytes)
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--
  return new TextDecoder().decode(encoded.subarray(0, end))
}
const HANDOVER_UNREADABLE = 'Sotto could not read the last Watcher’s history, so there is no handover to show. Nothing was sent. Its conversation is still in Watcher history on the Threads page; put the offer away to start the new Watcher without it.'
const HOST_WITHOUT_OUTCOMES = 'This host does not report outcomes, so Sotto cannot say how this ended. Update Sotto on that host, or read the thread.'
/** A start's worker role as its receipt says it (#1041). */
type RoleReceipt = { readonly id: WorkerKind; readonly named: RoleField[]; readonly note: string }
/** `base` replaces this computer's new-thread default; `paired` narrows it. */
type PermissionLimits = { readonly base?: AgentRuntimeMode; readonly paired?: AgentRuntimeMode }
const ROLE_STARTS_KEPT = 500
/**
 * How long before a client's own limit on one tool call Watcher's tools answer, when the client declares that limit
 * (`Sotto-Tool-Wait`, Muse's 300 seconds, ADR-0079). A call still under way then carries on, and its answer says how
 * to read the result: a start or send by its receipt, which never sends it twice; anything else by reading again.
 */
const CLIENT_WAIT_MARGIN_MS = 5_000
const STILL_DELIVERING = 'Sotto is still carrying this out, so its result is not known yet. Nothing was lost, and it will not be sent twice. Read its receipt with read_operation for how it went. Do not send it again.'
const STILL_ADMITTING = 'Sotto is still checking this call, so its result is not known yet. Nothing was lost, and it will not be sent twice. Call it again with the same retryKey to read its receipt.'
const STILL_WATCHING = 'Sotto is still carrying this out, so its result is not known yet. It may still finish, and calling it again is safe. Read list_threads to see where it stands.'
const STILL_READING = 'This read took longer than your provider waits for a tool call. Nothing changed. Read again.'
/** What a call that may outlast its client's wait has reached: the operation its start, send, stop or settle admitted. */
interface CallProgress { operationId?: string }
const MUTATIONS: ReadonlySet<WatcherToolName> = new Set(['start_thread', 'send_to_thread', 'stop_thread', 'settle_thread'])
const LATE: unique symbol = Symbol('late')
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
  private readonly pendingWatchAssignments = new Map<string, WatcherStandingWatch>()
  private readonly remoteGuards = new Map<string, () => void>()
  /** Whether each paired desktop may answer on this host, as its latest admission's socket says (ADR-0004). */
  private readonly remoteAnswers = new Map<string, () => boolean>()
  private readonly pendingPromptTurns = new Map<string, { watcher: WatcherThreadTarget; messageId: string }>()
  /** Operations this run saw answered. With history off, a reply from before a restart is not Sotto's to show. */
  private readonly answeredThisRun = new Set<string>()
  /**
   * The handover offered to the current Watcher after a provider change (ADR-0073), until its first message goes or the
   * user puts the offer away. In memory only: a restart drops the offer and sends nothing. `acceptedDraftId` is the draft
   * the user chose to continue with, and `sendingCommandId` the send carrying the handover until the provider has it.
   */
  private handoverOffer: { readonly source: WatcherIdentity; readonly to: WatcherThreadTarget; readonly counts: HandoverCounts
    acceptedDraftId?: string; sendingCommandId?: string } | null = null
  /** Drafts chosen to carry a handover that another send to the new Watcher overtook. */
  private readonly overtakenHandovers = new Set<string>()
  /**
   * What each recent start by worker role was given, for its receipt (#1041). In memory only and never in the saved
   * record, so the record keeps its shape; a retry after a restart reads its receipt without this block.
   */
  private readonly roleStarts = new Map<string, RoleReceipt>()
  private readonly unsubscribe: () => void
  constructor(private readonly options: { directory: string; control: AgentControl; host: WorkspaceHost;
    limit: () => number; historyEnabled: () => boolean; workerHost?: boolean; streamingPublishCost?: boolean; revoke?: (id: string) => void
    /** Delegation's starts in flight, which share Watcher's starts-only limit (ADR-0081 decision 5). */
    otherStartsInFlight?: () => number
    /**
     * The user's worker roles, present only while that Owl feature is on (#1041). Read once per start that names a role,
     * when it is asked, never on publish or observe.
     */
    roles?: () => WorkerRoleChoices
    /** This computer's host facts and running threads, read as a host reads its own (#1031). Without it they read unknown. */
    machineFacts?: () => Promise<HostMachineReport>
    /** The ordinary news batch's timing (WatcherWakeOptions), for tests on the real clock; the default is #1190's. */
    ordinaryBatch?: WatcherWakeOptions['ordinaryBatch'] }) {
    this.wakes = new WatcherWakeUp({ snapshot: () => this.snapshot(), record: () => this.view(), ...options.ordinaryBatch ? { ordinaryBatch: options.ordinaryBatch } : {},
      progress: target => this.remoteProgress.get(key(target))?.fingerprint,
      reportsWork: () => {
        // One host list per pass, and only once a paired host's thread asks.
        let reporting: Set<string> | undefined
        return hostId => hostId === options.control.hostId()
          || (reporting ??= new Set(this.remote?.hosts().flatMap(host => host.workSettled === true ? [host.hostId] : []) ?? [])).has(hostId)
      },
      answers: (target, thread, record) => this.answeringOperation(target, thread, record),
      restoredEvents: () => options.control.restoredWatcherEvents(), wakeUpQueued: () => options.control.watcherWakeUpQueued(),
      canDeliver: target => options.control.canDeliverWatcherNews(target),
      deliver: news => options.control.deliverWakeUp(news.watcher.threadId, news, { tool: false }),
      prune: () => options.control.pruneWatcherWakeUps(), remember: ids => options.control.updateWatcher(record => { record.wakeEventIds = [...new Set([...record.wakeEventIds ?? [], ...ids])].slice(-1_000) }),
      changed: () => this.publish(), failed: () => { this.recoveryNotice = 'Watcher news could not be saved. Reconnect or refresh its threads to retry. Nothing was approved.' } })
    const unhook = options.control.useWatcher(this), unsubscribe = options.control.subscribe(() => { this.endFinishedPauses(); this.closeAnsweredRequests(); this.publish() })
    this.unsubscribe = () => { unhook(); unsubscribe() }
  }
  private record(): WatcherRecord { return this.options.control.watcherRecord() }
  /** The record for reading only. It is replaced on every change, never edited, so no copy is needed to look at it. */
  private view(): Readonly<WatcherRecord> { return this.options.control.watcherRecordView() }
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
  /**
   * A watch paused by the user's own turn waits for that turn and for the user's own sends with it. Those sends can
   * settle after the provider's last snapshot, which observe read while they were still pending, and no snapshot may
   * follow; so whenever main publishes, a pause whose turn is over and whose sends have settled ends.
   */
  private endFinishedPauses(): void {
    const hostId = this.options.control.hostId()
    if (this.closed || !hostId) return
    const snapshot = this.options.control.watcherSnapshot()
    const ended = (this.view().watches ?? []).filter(watch => {
      if (!watch.pausedByUserMessageId || watch.target.hostId !== hostId) return false
      const thread = snapshot.threads.find(item => item.id === watch.target.threadId)
      return thread !== undefined && this.connected(thread) && !this.humanTurnRunning(thread) && !this.options.control.hasPendingThreadWork(thread.id)
    }).map(watch => watch.id)
    if (ended.length) void this.options.control.updateWatcher(record => {
      for (const watch of record.watches ?? []) if (ended.includes(watch.id)) watch.pausedByUserMessageId = null
    }).catch(() => undefined)
  }
  private publish(observe = true): void {
    if (this.closed) return
    // A pass put off while threads stream publishes again once it has run, without asking for another.
    if (observe && !this.options.workerHost) this.wakes.observeSoon(() => this.publish(false))
    this.options.control.refreshWatcherObservation()
    // One room state for every listener: each only reads it, and the window's room copies what it keeps.
    let state: WatcherRoomState | undefined
    for (const listener of this.listeners) listener(state ??= this.state())
  }
  watchedThreadIds(): string[] {
    const record = this.view()
    return [...new Set([...this.wakes.watchedThreadIds(this.hostId()).filter(id => this.options.control.watcherSnapshot().threads.some(thread => thread.id === id)),
      ...(record.watches ?? []).filter(watch => watch.target.hostId === this.hostId()).map(watch => watch.target.threadId),
      ...record.requests.filter(request => request.remoteOrigin && request.state === 'active').flatMap(request => request.participants.filter(item => item.target.hostId === this.hostId() && item.state === 'participating' && !item.automationStopped).map(item => item.target.threadId))])]
  }
  wakeDueAll(events: readonly WatcherEvent[]): boolean[] { return this.wakes.dueAll(events) }
  wakeReady(): boolean { return this.wakes.ready() }
  /** Watcher's hidden wake-up left its queue; the coordinator has already saved any of its news as untold again. */
  wakeUpSettled(events: readonly WatcherEvent[], outcome: HiddenWakeUpOutcome): void { if (!this.closed) this.wakes.settled(events, outcome) }
  pullRequestObserved(read: PullRequestObservation): void { this.wakes.pullRequest(read) }
  restoreCheckpoint(read: CheckpointObservation): void { this.wakes.restoreCheckpoint(read) }
  checkpointObserved(read: CheckpointObservation): void { this.wakes.checkpoint(read) }
  /**
   * What a wake-up's news carries beside its events (#1190), read once for the note from the threads as they stand, so
   * Watcher need not read a thread to learn what it said: the start of a finished turn's reply, in the worker's words, and
   * what each of a thread's pull requests now says that needs Watcher. Only the note carries it: the queue and the control
   * record never hold it, though the provider's history keeps what it was sent, and Grok Build's, Sotto's history too.
   */
  newsDetail(): (event: WatcherEvent) => string | undefined {
    let snapshot: AgentHostSnapshot | undefined
    return event => {
      snapshot ??= this.snapshot()
      const thread = snapshot.threads.find(item => item.id === event.target.threadId && (item.hostId ?? snapshot!.hostId) === event.target.hostId)
      if (!thread) return undefined
      // Only what Watcher has not been told: a comment that moved once is not told again with every later turn's end.
      if (event.kind === 'evidence-changed') return watcherPullRequestWords(this.wakes.untoldAttention(event.target), thread)
      if (event.kind !== 'turn-finished' && event.kind !== 'turn-failed' && event.kind !== 'work-settled') return undefined
      // A finish held for its work whose thread began another turn first: its work-settled news will not come.
      if (event.kind !== 'work-settled' && event.backgroundWorkCount && thread.lastTurn && thread.lastTurn.id !== event.turnId)
        return 'Its thread has begun another turn since, so no work-settled news for this turn will follow.'
      return watcherReplyStart(thread, event.turnId, watcherNewestTurnReply(thread))
    }
  }
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
  /**
   * What a request's workers on `owner` are held to (ADR-0074). The user's new-thread default is the desktop's: this
   * computer's own, or, for a request a paired desktop sent here, the ceiling it carries; this host's own stored default
   * never applies to it, because Settings saves the default on the desktop only. That default lets a thread act without
   * asking only where the host lets the desktop answer (ADR-0004), so elsewhere `paired` holds it to Ask for approval.
   */
  private permissionLimits(request: Pick<WatcherRequest, 'remoteOrigin'> | undefined, owner: string): PermissionLimits {
    const origin = request?.remoteOrigin
    if (origin) return { base: origin.ceiling, ...this.remoteAnswers.get(origin.clientId)?.() ? {} : { paired: 'approval-required' as const } }
    const paired = owner === this.hostId() ? undefined : this.remote?.hosts().find(host => host.hostId === owner)?.permissionCeiling
    return paired ? { paired } : {}
  }
  /** The widest a new worker may start on: the new-thread default, narrowed by what its host lets the desktop give, as the model offers it. */
  private ceiling(model: AgentModel | undefined, limits: PermissionLimits = {}) {
    const configured = limits.base ?? this.options.control.configuration().newThreadRuntimeMode ?? 'approval-required'
    const paired = limits.paired !== undefined && RUNTIME_MODE_ORDER.indexOf(limits.paired) < RUNTIME_MODE_ORDER.indexOf(configured)
    const desired = paired ? limits.paired! : configured
    // Which limit this is, for a receipt that says what held a role's permission back.
    const by: NonNullable<HeldPermission['by']> = paired ? 'paired-host' : 'new-thread-default'
    return { ...resolveNewThreadPermission(model, desired), by, limit: desired }
  }
  private permission(model: AgentModel | undefined, explicit?: WatcherToolInput<'start_thread'>['permission'], limits?: PermissionLimits) {
    const ceiling = this.ceiling(model, limits)
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
    const tooWide = () => refuse('PERMISSION_TOO_WIDE', ceiling.by === 'paired-host'
      ? 'That host does not let this computer answer there, so Watcher can give a thread on it no more than Ask for approval. Nothing was sent or started. To give it more, let this computer answer on that host first.'
      : 'Watcher cannot give a thread more permission than your new-thread default. Nothing was sent or started. To give it more, widen New threads start with in Settings → Agents first.')
    // A model without an asking mode fits the hold-back to its nearest mode, which skips asking: a grant the host withheld.
    if (ceiling.by === 'paired-host' && RUNTIME_MODE_ORDER.indexOf(ceiling.runtimeMode) > RUNTIME_MODE_ORDER.indexOf(ceiling.limit)) tooWide()
    if (RUNTIME_MODE_ORDER.indexOf(mode) > RUNTIME_MODE_ORDER.indexOf(ceiling.runtimeMode)) tooWide()
    return { kind: 'runtime' as const, mode }
  }
  private checkPermission(thread: AgentThread, request: Pick<WatcherRequest, 'remoteOrigin'> | undefined): void {
    const owner = thread.hostId ?? this.hostId()
    const model = resolveModel(this.owningSnapshot(owner)?.models ?? [], thread.modelId)
    const permission = thread.providerMode ? { kind: 'provider' as const, choiceId: thread.providerMode }
      : { kind: 'runtime' as const, mode: thread.runtimeMode ?? 'approval-required' as const }
    this.permission(model, permission, this.permissionLimits(request, owner))
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
  /** Watcher's own starts in flight, for delegation, whose starts share the limit (ADR-0081 decision 5). */
  startsInFlight(): number { return this.inFlight() }
  /** Watcher's starts in flight, on every machine or on the one `hostId` names. */
  private inFlight(record: Readonly<WatcherRecord> = this.view(), hostId?: string): number { return new Set(record.reservations.filter(item => (hostId === undefined || item.target.hostId === hostId) && record.operations.some(operation => operation.id === item.operationId && operation.action === 'start')).map(item => key(item.target))).size }
  private limits(operation: WatcherOperation) {
    const record = this.record()
    return { inFlight: this.inFlight(record), inFlightLimit: this.options.limit(), promptCount: Math.min(WATCHER_PROMPTS_PER_THREAD,
      this.promptCount(record, operation.target, operation.promptTurnId, operation.requestId)), promptLimit: WATCHER_PROMPTS_PER_THREAD }
  }
  private promptCount(record: WatcherRecord, target: WatcherThreadTarget, promptTurnId: string | undefined, requestId: string): number {
    return promptTurnId ? record.operations.filter(operation => operation.promptTurnId === promptTurnId && key(operation.target) === key(target)
      && (operation.action === 'start' || operation.action === 'send') && !operation.promptRefunded).length
      : record.requests.find(request => request.id === requestId)?.participants.find(participant => key(participant.target) === key(target))?.promptCount ?? 0
  }
  private promptTurn(record: WatcherRecord, watcher: WatcherThreadTarget, importedId?: string): PromptTurn {
    if (importedId) {
      const retained = record.promptTurns?.find(turn => turn.id === importedId)
      if (retained) { if (key(retained.watcher) !== key(watcher)) refuse('RETRY_KEY_CONFLICT', 'This turn budget belongs to another Watcher. Nothing was sent.'); return retained }
      const created: PromptTurn = { id: importedId, watcher, createdAt: now() }; (record.promptTurns ??= []).push(created); return created
    }
    const thread = this.thread(watcher), nativeTurnId = thread.lastTurn?.id
    let latest = record.promptTurns?.findLast(turn => key(turn.watcher) === key(watcher))
    if (latest) {
      // Native IDs and heads are observations. Only an actual Sotto Send may open another prompt budget.
      if (nativeTurnId && nativeTurnId !== latest.previousNativeTurnId) latest.nativeTurnId = nativeTurnId
      return latest
    }
    latest = { id: randomUUID(), watcher, createdAt: now(), ...(nativeTurnId ? { nativeTurnId } : {}), ...(nativeHead(thread) ? { rootUserMessageId: nativeHead(thread)! } : {}) }
    ;(record.promptTurns ??= []).push(latest)
    // On an Owl upgrade, retain all legacy accounting until a true new Send opens another budget.
    for (const operation of record.operations) if (!operation.promptTurnId && record.requests.some(request => request.id === operation.requestId
      && key(request.watcher) === key(watcher))) {
      operation.promptTurnId = latest.id
      if (operation.deliveryState === 'failed' && !['THREAD_TAKEN_OVER', 'REQUEST_NOT_ACTIVE', 'NOT_CURRENT_WATCHER'].includes(operation.refusalCode ?? 'PROVIDER_UNAVAILABLE')) operation.promptRefunded = true
    }
    return latest
  }
  /** Whether `promptTurn` would leave the record as it is: the Watcher's latest turn exists and already names its native turn. */
  private promptTurnCurrent(record: Readonly<WatcherRecord>, watcher: WatcherThreadTarget): boolean {
    const latest = record.promptTurns?.findLast(turn => key(turn.watcher) === key(watcher))
    if (!latest) return false
    const nativeTurnId = this.thread(watcher).lastTurn?.id
    return !nativeTurnId || nativeTurnId === latest.previousNativeTurnId || nativeTurnId === latest.nativeTurnId
  }
  private beginPromptTurn(record: WatcherRecord, watcher: WatcherThreadTarget, messageId: string): void {
    if (record.promptTurns?.some(turn => key(turn.watcher) === key(watcher) && turn.rootUserMessageId === messageId)) return
    const previous = this.promptTurn(record, watcher)
    ;(record.promptTurns ??= []).push({ id: randomUUID(), watcher, rootUserMessageId: messageId, createdAt: now(),
      ...(previous.nativeTurnId ? { previousNativeTurnId: previous.nativeTurnId } : {}) })
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
    // The room is public state its readers may change, so the records it hands out are detached. The rest is read in
    // place: prompt turns, wake-up IDs, reads and the private takeover proofs are most of the record, which grows with
    // every prompt and wake-up Watcher has had, and this runs on every publish.
    const { localTakeovers: _localTakeovers, ...view } = this.view(); void _localTakeovers
    const record = { ...view, ...clonePlainData({ current: view.current, history: view.history, requests: view.requests,
      watches: view.watches, operations: view.operations }) }
    const current = this.options.control.watcherSnapshot().threads.find(item => item.id === record.current?.target.threadId)
    const watches = record.watches ?? [], targets = new Map([...record.requests.flatMap(request => request.participants.map(item => [key(item.target), item.target] as const)),
      ...watches.map(watch => [key(watch.target), watch.target] as const)])
    const roomInputs = this.options.streamingPublishCost === true && this.remote?.roomThreads ? new Map<string, ReturnType<NonNullable<WatcherRemoteHosts['roomThreads']>>>() : undefined
    if (roomInputs) for (const target of targets.values()) {
      if (target.hostId === this.hostId() || roomInputs.has(target.hostId)) continue
      roomInputs.set(target.hostId, this.remote!.roomThreads!(target.hostId,
        [...targets.values()].filter(item => item.hostId === target.hostId).map(item => item.threadId)))
    }
    // The requests Watcher acts for: the current Watcher's, and a paired master's on the threads this host owns.
    const acting = new Set(record.requests.filter(request => request.state === 'active'
      && (request.remoteOrigin || record.current && key(request.watcher) === key(record.current.target))).map(request => request.id))
    const offer = this.currentOffer()
    // One host list for the whole read: each list reads every paired host, so asking per operation grew with them (#1023).
    let hosts: ReturnType<WatcherRemoteHosts['hosts']> | undefined
    const reportsOutcomes = (hostId: string) => (hosts ??= this.remote?.hosts() ?? []).find(host => host.hostId === hostId)?.outcomes === true
    return { current: record.current, currentOptions: current ? { modelId: current.modelId, reasoningEffort: current.reasoningEffort ?? null,
      runtimeMode: current.runtimeMode ?? 'approval-required', status: current.status, connected: this.connected(current) } : null,
      runtimeMode: record.lastRuntimeMode ?? current?.runtimeMode ?? 'approval-required', standingWatches: watches,
      ownChanges: current ? watcherOwnChanges(current) : [], history: record.history, requests: record.requests,
      watchedThreads: [...targets.values()].map(target => {
        const watch = watches.find(item => key(item.target) === key(target))
        const participation = record.requests.flatMap(request => request.participants.filter(item => key(item.target) === key(target)))
        if (roomInputs?.has(target.hostId)) {
          const input = roomInputs.get(target.hostId)?.find(item => item.id === target.threadId)
          const observation = this.wakes.observations.get(JSON.stringify([target.hostId, target.threadId]))
          return { target, watched: Boolean(watch) || takesPartInActiveRequest(participation, acting), paused: Boolean(watch?.pausedByUserMessageId),
            title: input?.title ?? 'Unavailable thread', status: input?.status ?? 'unavailable',
            connected: input?.connected ?? false, settled: input?.settled ?? false, backgroundWorkCount: input?.backgroundWorkCount ?? 0,
            evidence: this.wakes.evidence.read(target, input?.connected ?? false),
            ...(input && observation ? { observation: this.roomObservation(observation) } : {}),
            waitsOn: input?.waitsOn.map(request => ({ ...request, openTarget: target })) ?? [],
            participation }
        }
        const thread = this.owningSnapshot(target.hostId)?.threads.find(item => item.id === target.threadId)
        // One definition of watched for every surface: a standing watch, or taking part in an active request.
        return { target, watched: Boolean(watch) || takesPartInActiveRequest(participation, acting), paused: Boolean(watch?.pausedByUserMessageId), title: thread?.title ?? 'Unavailable thread', status: thread?.status ?? 'unavailable', connected: Boolean(thread && this.connected(thread)),
          settled: Boolean(thread && isWorkspaceThreadSettled(thread, this.owningSnapshot(target.hostId)?.projects.find(item => item.id === thread.projectId))),
          backgroundWorkCount: (thread?.backgroundWork?.length ?? 0) + (thread?.monitoring?.length ?? 0),
          evidence: this.wakes.evidence.read(target, Boolean(thread && this.connected(thread))),
          ...(thread && this.wakes.observations.get(JSON.stringify([thread.hostId ?? null, thread.id])) ? { observation: this.roomObservation(this.wakes.observations.get(JSON.stringify([thread.hostId ?? null, thread.id]))!) } : {}),
          waitsOn: thread?.requests.map(request => ({ id: request.id, kind: request.kind, openTarget: target })) ?? [],
          participation }
      }), inFlight: this.inFlight(record), inFlightLimit: this.options.limit(),
      receipts: record.operations.map(operation => { const outcome = this.outcomeOf(operation, reportsOutcomes); return outcome ? { ...operation, outcome } : operation }),
      news: this.wakes.news(), recoveryNotice: this.recoveryNotice, observedAt: now(),
      handover: offer ? { source: offer.source.target, provider: offer.source.provider, counts: offer.counts } : null,
      receiptReplies: watcherReceiptReplies(record, current), asks: watcherAskPlacements(current, record) }
  }
  private roomObservation(observation: WatcherObservation) { const { landing: _landing, ...result } = observation; void _landing; return result }
  get(): WatcherRoomResult { return { status: 'ok', state: this.state() } }

  /** A handover of an earlier Watcher conversation, its messages as its pane shows them (ADR-0073). */
  private buildHandover(source: WatcherIdentity): Handover | undefined {
    const requests = this.record().requests
    return this.options.host.watcherHandover(source.target.threadId, message => watcherMessageAsShown(source.target.hostId, source.target.threadId, message, requests))
  }
  /**
   * After a provider change, offers a handover of the conversation the new Watcher replaced, when that one has history.
   * Any earlier offer goes with it. A history that cannot be read offers nothing.
   */
  private offerHandover(previous: WatcherIdentity, to: WatcherThreadTarget): void {
    this.handoverOffer = null
    let handover: Handover | undefined
    try { handover = this.buildHandover(previous) } catch { handover = undefined }
    if (handover && handover.summary.total > 0) this.handoverOffer = { source: previous, to, counts: handoverCounts(handover.summary) }
  }
  /** The offer, while it is still for the current Watcher. */
  // Read in place: every state read asks this, twice per coordinator update, and a copy of the record for one field was
  // two whole-record copies per update.
  private currentOffer(): NonNullable<WatcherService['handoverOffer']> | null {
    const offer = this.handoverOffer, current = this.view().current
    return offer && current && key(offer.to) === key(current.target) ? offer : null
  }
  /** The offered handover's words, as the new Watcher would receive them. Read only when the user asks to read it. */
  readHandover(): WatcherHandoverRead {
    try {
      const offer = this.currentOffer()
      if (!offer) refuse('TARGET_CHANGED', 'There is no handover to read: the new Watcher has had its first message, or the offer was put away. The last Watcher’s conversation is in Watcher history on the Threads page.')
      const handover = this.buildHandover(offer.source)
      if (!handover || handover.summary.total === 0) refuse('HISTORY_UNAVAILABLE', HANDOVER_UNREADABLE)
      return { status: 'ok', text: handoverPrefix(handover.text).trimEnd(), counts: handoverCounts(handover.summary) }
    } catch (error) { return error instanceof Refusal ? error.result : watcherRefusal('HISTORY_UNAVAILABLE', HANDOVER_UNREADABLE) }
  }
  /** The user chose to continue: the send of this draft carries the handover ahead of its words. */
  continueWithHandover(input: WatcherContinueHandoverRequest): WatcherRoomResult {
    try {
      const parsed = watcherContinueHandoverRequestSchema.safeParse(input)
      if (!parsed.success) refuse('INVALID_INPUT', 'Write a message to send with the handover.')
      const offer = this.currentOffer()
      if (!offer) refuse('TARGET_CHANGED', 'The handover is no longer offered, so nothing was sent. Retry sends your message to the new Watcher without it.')
      offer.acceptedDraftId = parsed.data.draftId
      return this.get()
    } catch (error) { return error instanceof Refusal ? error.result : watcherRefusal('TARGET_CHANGED', 'Sotto could not take the handover. Nothing was sent. Send your message again.', true) }
  }
  /** Puts the offer away. Nothing is sent, and the new Watcher's first message goes without a handover. */
  dismissHandover(): WatcherRoomResult {
    if (this.currentOffer()) { this.handoverOffer = null; this.publish() }
    return this.get()
  }
  /**
   * What a user send to the current Watcher carries ahead of its words. Only the draft the user chose to continue with,
   * as the first message of a new request, gets the handover, built afresh; any other send begins the new Watcher's
   * conversation without one, so the offer goes. A history that can no longer be read refuses the send, since the user
   * asked for the handover, and the next send goes without it.
   */
  private handoverFor(threadId: string, commandId: string, draftId: string | undefined): { prefix: string; provenance: NonNullable<WatcherRequest['handover']> } | undefined {
    if (draftId !== undefined && this.overtakenHandovers.delete(draftId)) {
      refuse('TARGET_CHANGED', 'Another message reached the new Watcher first, so the handover is no longer offered and nothing was sent. Retry sends your message without it.')
    }
    const offer = this.currentOffer()
    if (!offer || offer.to.threadId !== threadId) return undefined
    if (offer.acceptedDraftId === undefined || offer.acceptedDraftId !== draftId) {
      // The user chose to continue with a draft that has not gone yet: when it comes, it is refused rather than sent bare.
      if (offer.acceptedDraftId !== undefined) this.overtakenHandovers.add(offer.acceptedDraftId)
      this.handoverOffer = null
      return undefined
    }
    let built: Handover | undefined
    try { built = this.buildHandover(offer.source) } catch { built = undefined }
    if (!built || built.summary.total === 0) {
      this.handoverOffer = null
      refuse('HISTORY_UNAVAILABLE', 'Sotto could not read the last Watcher’s history, so nothing was sent. Retry sends your message to the new Watcher without the handover.')
    }
    const prefix = handoverPrefix(built.text)
    offer.sendingCommandId = commandId
    return { prefix, provenance: watcherHandoverProvenance(prefix, offer.source, handoverCounts(built.summary)) }
  }

  async setPermission(input: WatcherSetPermissionRequest, guard?: () => void): Promise<WatcherRoomResult> {
    try {
      const parsed = watcherSetPermissionRequestSchema.safeParse(input)
      if (!parsed.success) refuse('INVALID_INPUT', 'Choose a supported Watcher permission mode.')
      if (this.closed || this.options.workerHost) refuse('NOT_CURRENT_WATCHER', 'Open Watcher on its desktop to change its permissions.')
      guard?.()
      if (this.opening || this.changing) refuse('THREAD_BUSY', 'Wait for Watcher to finish opening before changing its permissions.', true)
      const record = this.record(), current = record.current
      if (current) {
        const snapshot = this.options.control.watcherSnapshot()
        const thread = snapshot.threads.find(item => item.id === current.target.threadId)
        const pending = record.creation && key(record.creation.identity.target) === key(current.target) ? record.creation : undefined
        if (!thread && !pending) this.thread(current.target)
        if (!thread && (this.options.control.hasPendingThreadWork(current.target.threadId)
          || this.options.host.watcherCreationPhase(current.target.threadId) === 'starting')) refuse('THREAD_BUSY', 'Watcher creation is still being checked. Wait before changing its permissions.', true)
        const model = resolveModel(snapshot.models, thread?.modelId ?? pending?.modelId ?? '')
        if (!thread && (!model?.ready || model.providerId !== current.provider)) refuse('PROVIDER_UNAVAILABLE', 'Reconnect Watcher’s chosen provider before changing its pending permission mode.', true)
        if (!model?.runtimeModes?.includes(parsed.data.runtimeMode)) refuse('PERMISSION_NOT_COMPARABLE', 'This model does not offer that permission mode.')
        if (thread) {
          // Guarded and saved before the live thread changes, so a refused guard or a failed save leaves it as it was.
          // A change the provider then refuses takes the saved choice back, and the two never disagree.
          const previous = record.lastRuntimeMode
          await this.options.control.updateWatcher(next => { guard?.(); next.lastRuntimeMode = parsed.data.runtimeMode })
          let changed = false
          try { changed = !(await this.options.control.commandForWatcherRoom({ type: 'configure-thread', threadId: thread.id, runtimeMode: parsed.data.runtimeMode }, guard)).error }
          finally {
            if (!changed) await this.options.control.updateWatcher(next => {
              if (next.lastRuntimeMode !== parsed.data.runtimeMode) return
              if (previous === undefined) delete next.lastRuntimeMode
              else next.lastRuntimeMode = previous
            })
          }
          if (!changed) refuse('PROVIDER_UNAVAILABLE', 'Watcher’s permissions could not be changed. Check its provider and try again.', true)
          this.scheduleRemote(); this.publish(); return this.get()
        }
      }
      await this.options.control.updateWatcher(record => { guard?.(); record.lastRuntimeMode = parsed.data.runtimeMode })
      this.scheduleRemote(); this.publish(); return this.get()
    } catch (error) { return error instanceof Refusal ? error.result : watcherRefusal('HOST_DISCONNECTED', 'The connection changed. Check Watcher’s permissions before trying again.', true) }
  }
  async watchThread(input: WatcherWatchThreadRequest, guard?: () => void): Promise<WatcherRoomResult> {
    try { await this.assignWatch(input, guard); return this.get() }
    catch (error) { return error instanceof Refusal ? error.result : watcherRefusal('HOST_DISCONNECTED', 'The watch could not be saved. Reconnect and try again.', true) }
  }
  private async assignWatch(input: WatcherWatchThreadRequest, guard?: () => void): Promise<WatcherStandingWatch> {
    const parsed = watcherWatchThreadRequestSchema.safeParse(input)
    if (!parsed.success) refuse('INVALID_INPUT', 'Choose a thread to watch.')
    if (this.closed || this.options.workerHost) refuse('NOT_CURRENT_WATCHER', 'Assign watched threads on Watcher’s desktop.')
    const target = parsed.data.target
    if (target.hostId !== this.hostId()) { this.requireRemote(target.hostId, true); if (!this.remote?.hosts().find(host => host.hostId === target.hostId)?.standingWatch) refuse('HOST_FEATURE_UNAVAILABLE', 'Update this host before assigning a watch.') }
    guard?.(); const thread = this.thread(target); this.protect(thread)
    const previous = this.record().watches?.find(item => key(item.target) === key(target)), created = previous ?? this.newWatch(target, thread)
    const assignmentMaster = target.hostId !== this.hostId() ? this.record().current : null
    if (target.hostId !== this.hostId()) {
      const master = assignmentMaster
      if (!master) refuse('NOT_CURRENT_WATCHER', 'Open Watcher before assigning threads on another host.')
      // Establish assignment on the owning host before exposing local automation authority.
      this.pendingWatchAssignments.set(key(target), created)
      try {
        const result = await this.remote!.read(target.hostId, { master, standingWatches: this.hostWatches(target.hostId) })
        guard?.()
        if (JSON.stringify(this.record().current) !== JSON.stringify(master)) refuse('NOT_CURRENT_WATCHER', 'Watcher changed while its host confirmed this assignment. Assign the watch again.')
        if (result && typeof result === 'object' && 'status' in result && result.status === 'refused') throw new Refusal(result as WatcherRefusal)
        const projection = watcherHostProjectionSchema.safeParse(result)
        if (!projection.success || projection.data.hostId !== target.hostId || JSON.stringify(projection.data.master) !== JSON.stringify(master)) refuse('HOST_DISCONNECTED', 'The host did not confirm this watch. Reconnect and try again.', true)
        const accepted = projection.data.standingWatches?.find(watch => watch.id === created.id && key(watch.target) === key(target))
        if (!accepted) refuse('REQUEST_NOT_ACTIVE', 'The owning host did not accept this watch. Refresh its threads and try again.')
        created.generation = accepted.generation; created.pausedByUserMessageId = accepted.pausedByUserMessageId ?? null; created.lastUserMessageId = accepted.lastUserMessageId
      } catch (error) { this.pendingWatchAssignments.delete(key(target)); this.scheduleRemote(target.hostId); throw error }
    }
    try {
      await this.transaction(async () => {
        guard?.()
        await this.options.control.updateWatcher(record => {
          guard?.()
          if (assignmentMaster && JSON.stringify(record.current) !== JSON.stringify(assignmentMaster)) refuse('NOT_CURRENT_WATCHER', 'Watcher changed before this watch was saved. Assign it again.')
          if (target.hostId !== this.hostId() && this.pendingWatchAssignments.get(key(target))?.id !== created.id) refuse('TARGET_CHANGED', 'This watch was stopped while its host was confirming it.')
          const live = record.watches?.find(watch => key(watch.target) === key(target))
          if (live && live.id !== created.id) refuse('TARGET_CHANGED', 'This watch changed while it was being saved. Refresh the thread.')
          if (live) Object.assign(live, created)
          else {
            (record.watches ??= []).push(created)
            if (target.hostId === this.hostId() && (record.localTakeovers?.some(item => key(item.target) === key(target))
              || record.watchFences?.some(item => item.target && !item.remoteOrigin && key(item.target) === key(target))
              || record.requests.some(request => request.participants.some(item => key(item.target) === key(target) && item.state === 'taken-over')))) this.recordLocalTakeover(record, target)
          }
        })
      })
    } finally {
      if (this.pendingWatchAssignments.get(key(target))?.id === created.id) this.pendingWatchAssignments.delete(key(target))
      if (target.hostId !== this.hostId()) this.scheduleRemote(target.hostId)
    }
    this.publish(); return created
  }
  private newWatch(target: WatcherThreadTarget, thread?: AgentThread): WatcherStandingWatch {
    const head = thread ? nativeHead(thread) : null
    return { id: randomUUID(), target, createdAt: now(), generation: 0, lastUserMessageId: head,
      pausedByUserMessageId: thread && this.humanTurnRunning(thread) ? head ?? 'unobserved-user-turn' : null }
  }
  async unwatchThread(input: WatcherWatchThreadRequest, guard?: () => void): Promise<WatcherRoomResult> {
    try {
      const parsed = watcherWatchThreadRequestSchema.safeParse(input)
      if (!parsed.success) refuse('INVALID_INPUT', 'Choose a thread to stop watching.')
      if (this.closed || this.options.workerHost) refuse('NOT_CURRENT_WATCHER', 'Stop watching from Watcher’s desktop.')
      const operations = new Set<string>(), target = parsed.data.target
      await this.transaction(async () => {
        guard?.()
        this.pendingWatchAssignments.delete(key(target))
        await this.options.control.updateWatcher(record => { guard?.(); this.withdrawWatch(record, target, operations) })
      })
      await this.options.control.cancelWatcherQueue(operations)
      if (target.hostId !== this.hostId()) {
        this.requireRemote(target.hostId, true)
        const master = this.record().current
        if (!master) refuse('NOT_CURRENT_WATCHER', 'Open Watcher to confirm this host stopped watching.')
        const result = await this.remote!.read(target.hostId, { master, standingWatches: this.hostWatches(target.hostId) })
        guard?.()
        if (result && typeof result === 'object' && 'status' in result && result.status === 'refused') throw new Refusal(result as WatcherRefusal)
        const projection = watcherHostProjectionSchema.safeParse(result)
        if (!projection.success || projection.data.hostId !== target.hostId || JSON.stringify(projection.data.master) !== JSON.stringify(master)
          || projection.data.standingWatches?.some(watch => key(watch.target) === key(target))) refuse('HOST_DISCONNECTED', 'The host has not confirmed it stopped watching. Reconnect and stop watching again.', true)
      }
      this.publish(); return this.get()
    } catch (error) { this.scheduleRemote(input.target?.hostId); this.publish(); return error instanceof Refusal ? error.result : watcherRefusal('HOST_DISCONNECTED', 'The host has not confirmed it stopped watching. Reconnect and stop watching again.', true) }
  }
  private withdrawWatch(record: WatcherRecord, target: WatcherThreadTarget, operations: Set<string>): void {
    const watches = record.watches?.filter(item => key(item.target) === key(target)) ?? []
    for (const watch of watches) if (!record.watchFences?.some(item => item.id === watch.id)) (record.watchFences ??= []).push({ id: watch.id, target: watch.target, ...(watch.remoteOrigin ? { remoteOrigin: watch.remoteOrigin } : {}) })
    record.watches = record.watches?.filter(item => key(item.target) !== key(target)) ?? []
    for (const request of record.requests) {
      if (request.standingWatchId && watches.some(watch => watch.id === request.standingWatchId) && request.state === 'active') { request.state = 'stopped'; request.closedAt = now() }
      for (const participant of request.participants) if (key(participant.target) === key(target) && participant.state === 'participating') { participant.generation++; participant.automationStopped = true }
    }
    for (const operation of record.operations) if (key(operation.target) === key(target)) {
      operations.add(operation.id)
      if (operation.deliveryState === 'queued') this.recordOutcome(record, operation, 'failed', 'REQUEST_NOT_ACTIVE')
    }
  }
  private humanTurnRunning(thread: AgentThread, record: Readonly<WatcherRecord> = this.view()): boolean {
    if (thread.status !== 'running' && thread.lastTurn?.status !== 'running') return false
    const target = { hostId: thread.hostId ?? this.hostId(), threadId: thread.id }
    let head = nativeHead(thread)
    // Remote shells can omit message excerpts. The freshly reconciled owning head remains text-free evidence;
    // the owning writer still rechecks its live native turn after this master's admission.
    if (!head && target.hostId !== this.hostId()) head = record.watches?.find(watch => key(watch.target) === key(target))?.lastUserMessageId
      ?? record.requests.flatMap(request => request.participants).findLast(participant => key(participant.target) === key(target) && participant.lastUserMessageId)?.lastUserMessageId ?? null
    const machineMessage = (id: string) => record.operations.some(operation => key(operation.target) === key(target) && operation.messageId === id)
    if (!head || !machineMessage(head)) return true
    // Conversation events can publish before the adapter's native head. A later non-machine user message in the
    // same ordered window proves human work behind a stale machine head; never downgrade an explicit human head.
    const userIndex = thread.messages.findLastIndex(message => message.role === 'user')
    // The common streaming case already names this latest user. Do not revisit an expanded older history per update.
    if (userIndex < 0 || thread.messages[userIndex]!.id === head) return false
    const headIndex = thread.messages.findIndex(message => message.id === head)
    return headIndex >= 0 && userIndex > headIndex && !machineMessage(thread.messages[userIndex]!.id)
  }
  private hostWatches(hostId: string): WatcherStandingWatch[] {
    return [...new Map([...(this.record().watches ?? []).filter(watch => watch.target.hostId === hostId),
      ...[...this.pendingWatchAssignments.values()].filter(watch => watch.target.hostId === hostId)].map(watch => [key(watch.target), watch])).values()]
      .filter(watch => this.owningSnapshot(hostId)?.threads.some(thread => thread.id === watch.target.threadId))
  }
  private checkHumanTurn(thread: AgentThread, record = this.record()): void {
    const watch = record.watches?.find(item => key(item.target) === key({ hostId: thread.hostId ?? this.hostId(), threadId: thread.id }))
    if (watch?.pausedByUserMessageId || this.humanTurnRunning(thread, record)) refuse('THREAD_TAKEN_OVER', 'Your turn is still running. Watcher will wait until it finishes.', true)
  }
  /** Old requests stay fenced. Only a later local user request under a standing watch can outlive the local fence. */
  private requestTakenOver(record: WatcherRecord, request: WatcherRequest, target: WatcherThreadTarget): boolean {
    if (request.standingWatchId) return false
    const previous = record.requests.flatMap(item => item.participants).filter(item => key(item.target) === key(target) && item.state === 'taken-over')
    const latest = record.localTakeovers?.find(item => key(item.target) === key(target))
    if (!previous.length && !latest) return false
    // Paired requests do not share this host's request insertion order. Keep their existing fence: a taken-over
    // participation alone. The local marker orders only this host's own requests and fences nothing paired.
    if (request.remoteOrigin || target.hostId !== this.hostId()) return previous.length > 0
    const watch = record.watches?.find(item => key(item.target) === key(target))
    if (!watch || !latest || previous.some(item => item.requestId === request.id)) return true
    const requestIndex = record.requests.findIndex(item => item.id === request.id)
    if (latest.lastRequestId === null) return requestIndex < 0
    const frontier = record.requests.findIndex(item => item.id === latest.lastRequestId)
    // The local list is append-only. If retention ever removes the anchor, missing evidence keeps the fence.
    return frontier < 0 || requestIndex <= frontier
  }
  /**
   * Whether a user takeover, or a renewed watch's boundary, came after this request on a thread it takes part in. A request
   * that has reached no thread yet is fenced on every watched thread taken over after it, and has no work to strand, so
   * any later takeover counts. One that has reached threads counts only theirs, so it is not split from them.
   */
  private takenOverSince(record: WatcherRecord, request: WatcherRequest): boolean {
    if (request.participants.some(item => item.state === 'taken-over')) return true
    const index = record.requests.findIndex(item => item.id === request.id), targets = new Set(request.participants.map(item => key(item.target)))
    return index >= 0 && (record.localTakeovers ?? []).some(item => item.lastRequestId !== null && (!targets.size || targets.has(key(item.target)))
      && record.requests.findIndex(other => other.id === item.lastRequestId) >= index)
  }
  /** Every instruction still queued to Watcher was given before this takeover, Stop or Stop all, so none is fresh now. */
  private revokeQueuedFreshness(record: WatcherRecord): void {
    for (const request of record.requests) for (const followup of request.userFollowups ?? []) if (followup.messageId === undefined) delete followup.afterTakeover
  }
  private recordLocalTakeover(record: WatcherRecord, target: WatcherThreadTarget, at = now(), userDraft?: TakeoverDraft): void {
    const represented = new Set([...(record.watches ?? []).map(watch => key(watch.target)),
      ...record.requests.flatMap(request => request.participants.map(item => key(item.target)))])
    const lastRequestId = record.requests.findLast(request => request.watcher.hostId === this.hostId() && !request.remoteOrigin && !request.standingWatchId)?.id ?? null
    const sends = this.options.control.watcherSendRecords(), retained = new Set([...sends.followups, ...sends.deliveries]
      .filter(item => item.threadId === target.threadId).map(item => item.draftId))
    const userDrafts = record.localTakeovers?.find(item => key(item.target) === key(target))?.userDrafts
      ?.filter(item => retained.has(item.draftId) && item.draftId !== userDraft?.draftId) ?? []
    if (userDraft) userDrafts.push(userDraft)
    record.localTakeovers = [...(record.localTakeovers ?? []).filter(item => item.target.hostId === this.hostId()
      && key(item.target) !== key(target) && represented.has(key(item.target))), { target, at, lastRequestId, ...(userDrafts.length ? { userDrafts } : {}) }]
  }
  private fenceStandingTurn(record: WatcherRecord, target: WatcherThreadTarget): void {
    const watch = record.watches?.find(item => key(item.target) === key(target)), current = record.current
    if (!watch || !current || this.options.workerHost) return
    const master = this.options.control.watcherSnapshot().threads.find(thread => thread.id === current.target.threadId)
    if (!master) return
    const { scope, created } = standingScope(record, current.target, watch.id, this.promptTurn(record, current.target).id)
    if (created) record.requests.push(scope)
    let participant = scope.participants.find(item => key(item.target) === key(target))
    if (!participant) {
      participant = { requestId: scope.id, target, startedBy: record.requests.some(request => request.participants.some(item => key(item.target) === key(target) && item.startedBy === 'watcher')) ? 'watcher' : 'user',
        state: 'participating', generation: watch.generation, promptCount: 0 }
      scope.participants.push(participant)
    }
    participant.automationStopped = true
  }

  async recover(): Promise<void> {
    try {
      const record = this.record()
      if (record.creation && !this.options.workerHost) await this.finishCreation(record.creation.identity, record.creation.modelId ? { provider: record.creation.identity.provider, modelId: record.creation.modelId, ...(record.creation.reasoningEffort ? { reasoningEffort: record.creation.reasoningEffort } : {}) } : undefined)
      const current = this.record().current
      if (current && !this.options.workerHost && (this.thread(current.target).kind !== 'watcher' || this.thread(current.target).providerId !== current.provider)) {
        refuse('NOT_CURRENT_WATCHER', 'Watcher’s saved thread does not match its identity. Nothing was started. Restore its saved records before continuing.')
      }
      await this.options.control.updateWatcher(next => {
        // Owl owns this upgrade. Stable retains dormant records unchanged.
        next.reservations = next.reservations.filter(item => next.operations.some(operation => operation.id === item.operationId && operation.action === 'start'))
        if (!this.options.workerHost) for (const request of next.requests) if (request.state === 'active' && next.current && key(request.watcher) === key(next.current.target)) {
          for (const participant of request.participants) if (participant.state === 'participating' && !participant.automationStopped
            && (participant.target.hostId === this.hostId() || this.remote?.hosts().find(host => host.hostId === participant.target.hostId)?.standingWatch)
            && !next.watches?.some(watch => key(watch.target) === key(participant.target))) {
            const thread = this.owningSnapshot(participant.target.hostId)?.threads.find(item => item.id === participant.target.threadId)
            if (thread && isThreadClosed(thread)) continue
            const watch = this.newWatch(participant.target, thread)
            if (participant.lastUserMessageId !== undefined) watch.lastUserMessageId = participant.lastUserMessageId
            else if (!thread) watch.lastUserMessageId = null
            ;(next.watches ??= []).push(watch)
          }
        }
        for (const operation of next.operations) {
          // A start or send this host had in flight when Sotto stopped cannot prove how its turn ended: its outcome is
          // unknown from now on, never guessed as answered. A paired desktop leaves the owning host's word as it was.
          if ((operation.action === 'start' || operation.action === 'send') && operation.target.hostId === this.options.control.hostId()
            && (['dispatching', 'uncertain'].includes(operation.deliveryState)
              || operation.deliveryState === 'accepted' && (!operation.outcome || !WATCHER_FINAL_OUTCOMES.has(operation.outcome)))) {
            operation.outcome = 'unknown'; operation.outcomeAt = now()
            for (const field of REFERENCE_FIELDS) delete operation[field]
          }
          if (operation.deliveryState === 'dispatching') operation.deliveryState = 'uncertain'
          if (!this.options.historyEnabled() && operation.deliveryState === 'queued') {
            operation.deliveryState = 'failed'; operation.refusalCode = 'HISTORY_UNAVAILABLE'
          }
        }
      })
      this.observe(this.options.control.watcherSnapshot(), new Set())
    } catch (error) {
      this.recoveryNotice = error instanceof Refusal && error.result.code === 'PERMISSION_NOT_COMPARABLE'
        ? error.result.message : 'Watcher could not be recovered safely. Nothing was started. Restore its saved records and reopen Watcher.'
    }
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
        // A replacement whose creation stopped part-way and is finished now offers the replaced conversation's handover too.
        const replaced = record.history.at(-1)
        if (replaced && previous && key(previous.target) === key(record.creation.identity.target) && replaced.provider !== previous.provider) this.offerHandover(replaced, previous.target)
        this.recoveryNotice = null; this.publish(); return this.get()
      }
      if (!previous || previous.provider !== input.provider) this.creationPermission(model)
      if (previous) {
        const thread = this.thread(previous.target)
        if (thread.kind !== 'watcher' || thread.providerId !== previous.provider || thread.projectId !== previous.projectId) refuse('NOT_CURRENT_WATCHER', 'The saved Watcher identity does not match its thread. Nothing was changed.')
        if (previous.provider === input.provider && thread.modelId === input.modelId
          && (!input.reasoningEffort || thread.reasoningEffort === input.reasoningEffort)) return this.get()
        if (thread.status === 'running' || thread.requests.length || this.invocations || this.active.size || previous.provider !== input.provider && this.inFlight(record) > 0 || this.options.control.hasPendingThreadWork(thread.id, { setAsideIgnored: true })
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
        creationOperationId: randomUUID(), createdAt: new Date(Math.max(Date.now(), previous ? Date.parse(previous.createdAt) + 1 : 0)).toISOString() }
      await this.options.control.updateWatcher(next => {
        next.creation = { identity, modelId: input.modelId, ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}), phase: 'intent', replaces: previous?.target ?? null }
        // The old native conversation keeps its binding. New profile admission follows the durable reference.
        if (previous) next.history.push(previous)
        next.current = identity
        next.creation.replaces = null
      })
      if (previous) { this.options.revoke?.(previous.target.threadId); await this.options.host.setWatcherKind(previous.target.threadId, 'watcher-history') }
      await this.finishCreation(identity, input)
      if (previous) this.offerHandover(previous, identity.target)
      this.scheduleRemote(); this.publish(); return this.get()
    } catch (error) { return error instanceof Refusal ? error.result : watcherRefusal('PROVIDER_UNAVAILABLE', 'Watcher could not be opened. Nothing was sent. Check its provider and reopen Watcher.', true) }
    finally { this.changing = false }
  }
  private creationPermission(model: AgentModel) {
    const runtimeMode = this.record().lastRuntimeMode ?? 'approval-required'
    if (!model.runtimeModes?.includes(runtimeMode)) refuse('PERMISSION_NOT_COMPARABLE', 'That model does not offer Watcher’s chosen permission mode. Choose a supported permission mode, then reopen Watcher. Nothing was sent.')
    return runtimeMode
  }
  private async finishCreation(identity: WatcherIdentity, input?: WatcherOpenRequest): Promise<void> {
    let thread = this.options.control.watcherSnapshot().threads.find(item => item.id === identity.target.threadId)
    if (!thread) {
      const model = input ? resolveModel(this.options.control.watcherSnapshot().models, input.modelId)
        : this.options.control.watcherSnapshot().models.find(item => item.providerId === identity.provider && item.ready)
      // A creation intent with no thread has no saved model choice. Refuse recovery instead of picking another model.
      if (!input || !model) refuse('PROVIDER_UNAVAILABLE', 'Watcher creation stopped before its model was saved. Reopen Watcher with the same choice.')
      const runtimeMode = this.creationPermission(model)
      const result = await this.options.control.commandForWatcherRoom({ type: 'create-thread', threadId: identity.target.threadId,
        projectId: identity.projectId, title: 'Watcher', modelId: model.id, runtimeMode, workingCopy: 'shared',
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}) })
      // The provider's own refusal says what to do, as a Muse that cannot take Watcher's tools does (ADR-0079).
      if (result.error) refuse('PROVIDER_UNAVAILABLE', result.error.length <= 2_000 ? result.error : 'Watcher’s thread could not be created. Check its provider and reopen Watcher.', true)
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
      const latest = this.record().requests.findLast(item => item.watcher.threadId === threadId && !item.standingWatchId)
      if (!latest) refuse('REQUEST_NOT_ACTIVE', 'Send an instruction to Watcher before queuing a continuation.')
      if ((latest.userFollowups?.length ?? 0) >= 1_000) refuse('REQUEST_NOT_ACTIVE', 'This request has too many queued continuations. Send a new instruction instead.')
      this.options.control.mutateWatcher(record => {
        const request = record.requests.findLast(item => item.watcher.threadId === threadId && !item.standingWatchId)
        if (request && (request.userFollowups?.length ?? 0) < 1_000) {
          request.userFollowups ??= []
          if (!request.userFollowups.some(item => item.draftId === command.draftId)) request.userFollowups.push({ draftId: command.draftId!,
            ...(this.takenOverSince(record, request) ? { afterTakeover: true as const } : {}) })
        }
      })
    }
    const reason = ['send', 'manual-send', 'queue-followup', 'steer', 'steer-followup'].includes(command.type) ? 'user-send'
      : command.type === 'interrupt' ? 'user-stop' : command.type === 'settle-thread' ? 'user-settle'
      : ['configure-thread', 'configure-thread-working-copy', 'edit-followup', 'remove-followup', 'resume-followups', 'reorder-followups', 'compact-thread', 'git-switch-branch', 'git-checkout-pull-request', 'git-pull', 'git-pull-request-action', 'git-action'].includes(command.type) ? 'user-reconfigure' : undefined
    // The user's own message has no ID until the provider records it, so a send pauses on the unobserved-turn sentinel,
    // which observe swaps for the message once it appears. A draft ID is never a message ID.
    if (reason) {
      const draftId = 'draftId' in command ? command.draftId : command.type === 'send' ? command.draft?.draftId
        : command.type === 'steer-followup' ? this.options.control.watcherSendRecords().followups.find(item => item.id === command.itemId)?.draftId : undefined
      const packet = command.type === 'send' ? command.draft : command.type === 'steer-followup'
        ? this.options.control.watcherSendRecords().followups.find(item => item.id === command.itemId) : 'text' in command ? command : undefined
      this.takeover(threadId, reason, reason === 'user-send' ? 'unobserved-user-turn' : undefined,
        reason === 'user-send' && draftId && packet ? { draftId, digest: followupDigest(packet) } : undefined)
    }
    if (command.type === 'interrupt' && this.record().current?.target.threadId === threadId) {
      const stopped = new Set(this.record().requests.filter(item => item.state === 'active').map(item => item.id))
      const operations = new Set(this.record().operations.filter(item => stopped.has(item.requestId)).map(item => item.id))
      this.options.control.mutateWatcher(record => {
        this.revokeQueuedFreshness(record)
        for (const request of record.requests) if (stopped.has(request.id)) { request.state = 'stopped'; request.closedAt = now() }
        for (const operation of record.operations) if (operations.has(operation.id) && operation.deliveryState === 'queued') { operation.deliveryState = 'failed'; operation.refusalCode = 'REQUEST_NOT_ACTIVE' }
      })
      void this.reconcileRemote().catch(() => { this.recoveryNotice = 'The host has not confirmed this stopped request. Its pending slots remain held.'; this.publish() })
      void this.options.control.cancelWatcherQueue(operations).catch(() => { this.recoveryNotice = 'A stopped request has a queued message that could not be removed. It is fenced and will not be sent.'; this.publish() })
    }
  }
  /**
   * Whether the user's own sends to a thread are still on their way: queued, dispatching or unconfirmed, and none of them
   * Watcher's own or a wake-up. While one is, a pause from the user's send holds even if Watcher's message is the head.
   */
  private userWorkPending(threadId: string, record: Readonly<WatcherRecord>): boolean {
    const machine = new Set(record.operations.flatMap(operation => operation.draftId ? [operation.draftId] : []))
    const sends = this.options.control.watcherSendRecords()
    return sends.followups.some(item => item.threadId === threadId && !item.wakeUp && !machine.has(item.draftId))
      || sends.deliveries.some(item => item.threadId === threadId && !machine.has(item.draftId) && ['queued', 'submitting', 'uncertain'].includes(item.status))
  }
  private takeover(threadId: string, reason: 'user-send' | 'native-user-send' | 'user-stop' | 'user-settle' | 'user-reconfigure', userMessageId?: string, userDraft?: TakeoverDraft): void {
    const target = this.target(threadId)
    const owned = this.record().watches?.some(watch => key(watch.target) === key(target))
      || this.record().requests.some(request => request.participants.some(item => key(item.target) === key(target)))
    if (!owned) return
    const operations = new Set<string>()
    // One send is one takeover, whichever requests it ends: every participant it fences shares its time (the takeover line).
    const at = now()
    this.options.control.mutateWatcher(record => {
      // A renewed watch also records a boundary, but only a takeover, Stop or Stop all is the user acting after the queue.
      this.revokeQueuedFreshness(record)
      this.recordLocalTakeover(record, target, at, userDraft)
      const watch = record.watches?.find(item => key(item.target) === key(target))
      if (watch) { watch.generation++; watch.pausedByUserMessageId = userMessageId ?? nativeHead(this.thread(target)) ?? 'unobserved-user-turn' }
      for (const request of record.requests) for (const participant of request.participants) if (key(participant.target) === key(target) && participant.state === 'participating') {
        participant.state = 'taken-over'; participant.generation++; participant.takeover = { reason, at }
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
    if (!origin?.operationId && _draftId && (command.type === 'send' && !command.wakeUp || command.type === 'steer')) {
      const target = this.target(command.threadId), proof = this.record().localTakeovers?.find(item => key(item.target) === key(target))
        ?.userDrafts?.find(item => item.draftId === _draftId && item.digest === followupDigest(command))
      if (proof) this.options.control.mutateWatcher(record => {
        record.localTakeovers!.find(item => key(item.target) === key(target))!.userDrafts!.find(item => item.draftId === _draftId)!.messageId = command.messageId
      })
    }
    if (command.type === 'send' && command.threadId === this.record().current?.target.threadId) this.pendingPromptTurns.set(command.commandId, {
      watcher: this.record().current!.target, messageId: command.messageId,
    })
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
    // An instruction the user queued after a takeover fenced its request, with no takeover since, is their fresh word.
    // On its first delivery it starts its own request, ordered after that takeover as a Send to an idle Watcher would
    // be, even if the old one has closed. A later takeover, Stop or Stop all clears the mark, and a request the user
    // stopped keeps it, so those still hold; a retry keeps the request its first delivery made.
    const fresh = request !== undefined && request.state !== 'stopped' && request.rootUserMessageId !== command.messageId
      && request.userFollowups?.some(item => item.draftId === _draftId && item.afterTakeover && item.messageId === undefined)
    // Decided before anything is recorded, so a refused handover leaves no request behind.
    const continuing = request !== undefined && !fresh && request.rootUserMessageId !== command.messageId
    const handover = continuing ? undefined : this.handoverFor(command.threadId, command.commandId, _draftId)
    if (!request || fresh) {
      const from = fresh ? request!.id : undefined
      const created: WatcherRequest = { id: randomUUID(), watcher: this.target(command.threadId), rootUserMessageId: command.messageId,
        state: 'active', createdAt: now(), closedAt: null, participants: [], ...(from ? { userFollowups: [{ draftId: _draftId! }] } : {}),
        ...(origin?.phoneOrigin ? { phoneOrigin: origin.phoneOrigin } : {}) }
      request = created
      this.options.control.mutateWatcher(next => {
        const old = from ? next.requests.find(item => item.id === from) : undefined
        if (old) old.userFollowups = old.userFollowups!.filter(item => item.draftId !== _draftId)
        next.requests.push(created)
      })
    }
    // The user's text goes as typed. The request rides beside it, through the provider's own context channel.
    const note = watcherRequestNote(request.id, this.hostId())
    // Codex and Claude Code are sent the words alone, and their display proof says so: a proven message is never
    // searched for an older footer, even one the user typed. Grok Build's request line is taken off by its exact
    // provenance instead (watcherRequestNote.ts), since a skill prompt can change what its adapter sends.
    const displayPrompt = record.current?.provider === 'grok' ? undefined : watcherDisplayPrompt(command.text, command.text)
    const followup = request.userFollowups?.find(item => item.draftId === _draftId)
    this.options.control.mutateWatcher(next => {
      const saved = next.requests.find(item => item.id === request!.id)!
      if (followup) {
        const delivered = saved.userFollowups!.find(item => item.draftId === _draftId)!
        const sameMessage = delivered.messageId === command.messageId
        delivered.messageId = command.messageId
        // The proof belongs to the message it was made for. A retry under a new message keeps none of the old one's,
        // so a Grok retry, which records none, is matched by its request line's provenance like any Grok send.
        if (!sameMessage) { if (displayPrompt) delivered.displayPrompt = displayPrompt; else delete delivered.displayPrompt }
        else if (displayPrompt && delivered.displayPrompt === undefined) delivered.displayPrompt = displayPrompt
      }
      // A fresh request's root is its moved instruction's own message, so both claims carry the same proof.
      if (displayPrompt && saved.rootUserMessageId === command.messageId && saved.displayPrompt === undefined) saved.displayPrompt = displayPrompt
      // The handover goes ahead of the words in the same message; its record is how every copy shows the two apart.
      if (handover && saved.rootUserMessageId === command.messageId) saved.handover = handover.provenance
    })
    return { ...command, ...(handover ? { text: handover.prefix + command.text } : {}), watcherRequestNote: note }
  }
  private activatePromptTurn(commandId: string): void {
    const candidate = this.pendingPromptTurns.get(commandId)
    if (candidate && this.record().current && key(candidate.watcher) === key(this.record().current!.target)) this.options.control.mutateWatcher(record => {
      this.beginPromptTurn(record, candidate.watcher, candidate.messageId)
    })
    this.pendingPromptTurns.delete(commandId)
  }
  dispatched(command: AgentHostCommand): void {
    this.activatePromptTurn(command.commandId)
    // The provider has the handover, or may have: it is never offered again.
    if (this.handoverOffer?.sendingCommandId === command.commandId) { this.handoverOffer = null; this.publish() }
  }
  dispatchAborted(command: AgentHostCommand): void {
    this.pendingPromptTurns.delete(command.commandId)
    if (this.handoverOffer?.sendingCommandId === command.commandId) delete this.handoverOffer.sendingCommandId
  }
  observe(snapshot: AgentHostSnapshot, knownUserMessages: ReadonlySet<string>): void {
    // This pass runs on every update and walks every thread, so it reads the record without copying it. A copy per thread
    // made Watcher most of main's work with a few hundred threads.
    const masterId = this.view().current?.target.threadId
    const master = snapshot.threads.find(thread => thread.id === masterId)
    if (master) for (const [commandId, candidate] of this.pendingPromptTurns) if (candidate.watcher.threadId === master.id && knownUserMessages.has(candidate.messageId)
      && (nativeHead(master) === candidate.messageId || master.messages.some(message => message.role === 'user' && message.id === candidate.messageId))) this.activatePromptTurn(commandId)
    // Each change copies and checks the whole record, which grows with every prompt and wake-up Watcher has had, so the
    // changes below are made only when the record does not already hold them.
    const current = this.view().current
    if (!this.options.workerHost && current?.target.hostId === this.hostId()
      && snapshot.threads.some(thread => thread.id === current.target.threadId) && !this.promptTurnCurrent(this.view(), current.target)) this.options.control.mutateWatcher(record => {
      this.promptTurn(record, record.current!.target)
    })
    const record = this.view()
    for (const thread of snapshot.threads) {
      const head = nativeHead(thread), previous = this.nativeHeads.get(thread.id)
      this.nativeHeads.set(thread.id, head)
      const participants = record.requests.flatMap(request => request.participants).filter(item => item.target.hostId === this.hostId() && item.target.threadId === thread.id && item.state === 'participating')
      const machineHead = record.operations.some(item => item.target.hostId === this.hostId() && item.target.threadId === thread.id && item.messageId === head)
      const watch = this.view().watches?.find(item => item.target.hostId === this.hostId() && item.target.threadId === thread.id)
      if (watch && head && !machineHead && watch.lastUserMessageId !== undefined && head !== watch.lastUserMessageId) {
        // Main bound this exact already-fenced user packet to its native message before dispatch. A known delivery
        // from stable, or an edited queued packet, has no matching proof and still takes over when Owl sees it.
        const ownHead = knownUserMessages.has(head) && record.localTakeovers?.find(item => key(item.target) === key(watch.target))
          ?.userDrafts?.some(item => item.messageId === head)
        if (!ownHead) this.takeover(thread.id, 'native-user-send', head)
      }
      if (head && !machineHead && participants.some(participant => {
        const durableHead = record.operations.findLast(item => item.target.hostId === this.hostId() && item.target.threadId === thread.id && item.messageId)?.messageId
        const baseline = participant.lastUserMessageId !== undefined ? participant.lastUserMessageId : previous ?? durableHead
        return baseline !== undefined && head !== baseline && (participant.lastUserMessageId !== undefined || durableHead !== undefined || !knownUserMessages.has(head))
      }) && !watch) this.takeover(thread.id, 'native-user-send')
      if (watch && this.connected(thread)) {
        // Takeover above can replace the record. Compare against that fresh view before copying and parsing it.
        const observed = this.view(), live = observed.watches!.find(item => item.id === watch.id)!
        let paused = live.pausedByUserMessageId
        if (this.humanTurnRunning(thread, observed)) paused = head ?? 'unobserved-user-turn'
        else if (!this.options.control.hasPendingThreadWork(thread.id)
          || machineHead && !this.userWorkPending(thread.id, observed) && (paused === 'unobserved-user-turn' || paused === head)) paused = null
        if (live.lastUserMessageId !== head || live.pausedByUserMessageId !== paused) this.options.control.mutateWatcher(next => {
          const changed = next.watches!.find(item => item.id === watch.id)!
          changed.lastUserMessageId = head; changed.pausedByUserMessageId = paused
        })
      }
      if (participants.length && this.connected(thread) && this.view().requests.some(request => request.participants.some(participant =>
        participant.target.hostId === this.hostId() && participant.target.threadId === thread.id && participant.state === 'participating'
        && participant.lastUserMessageId !== head))) this.options.control.mutateWatcher(next => {
        for (const request of next.requests) for (const participant of request.participants) if (participant.target.hostId === this.hostId() && participant.target.threadId === thread.id && participant.state === 'participating') participant.lastUserMessageId = head
      })
    }
    this.options.control.mutateWatcher(next => {
      for (const operation of next.operations.filter(item => item.target.hostId === this.hostId())) {
        const thread = snapshot.threads.find(item => item.id === operation.target.threadId)
        const delivery = this.options.control.watcherSendRecords().deliveries.find(item => item.draftId === operation.draftId && item.threadId === operation.target.threadId)
        if (operation.action === 'stop' && operation.deliveryState === 'uncertain' && operation.commandId && !this.active.has(operation.id)
          && !this.options.control.watcherCommandOutstanding(operation.commandId) && thread && this.connected(thread) && thread.status === 'idle') operation.deliveryState = 'accepted'
        if (operation.creationUncertain && thread && this.connected(thread) && this.options.host.watcherCreationPhase(thread.id) !== 'starting') {
          operation.deliveryState = 'failed'; operation.refusalCode = 'PROVIDER_UNAVAILABLE'; delete operation.creationUncertain
          this.refundPrompt(next, operation, 'PROVIDER_UNAVAILABLE')
        }
        if (delivery?.status === 'accepted' || operation.messageId && thread?.messages.some(item => item.role === 'user' && item.id === operation.messageId)) this.recordAccepted(next, operation)
        else if (delivery?.status === 'uncertain' && !this.active.has(operation.id)) operation.deliveryState = 'uncertain'
        else if (this.options.control.watcherSendRecords().followups.some(item => item.draftId === operation.draftId && item.status === 'failed')) this.recordQueueFailure(next, operation)
      }
      const watcherMessages = new Set(next.operations.flatMap(item => item.messageId ? [item.messageId] : []))
      for (const operation of next.operations) this.observeOutcome(operation, snapshot, watcherMessages)
      this.pruneReservations(next, snapshot)
      for (const request of this.answeredWithoutWorkers(next, snapshot)) { request.state = 'closed'; request.closedAt = now() }
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
  /**
   * Records what this host's thread now proves about an accepted start or send it owns: its outcome and the text-free
   * reference to the turn that answers it. An outcome nothing later can change is never moved again.
   */
  private observeOutcome(operation: WatcherOperation, snapshot: AgentHostSnapshot, watcherMessages: ReadonlySet<string>): void {
    if (operation.target.hostId !== this.options.control.hostId() || operation.action !== 'start' && operation.action !== 'send'
      || operation.deliveryState !== 'accepted' || operation.outcome && WATCHER_FINAL_OUTCOMES.has(operation.outcome)) return
    const thread = snapshot.threads.find(item => item.id === operation.target.threadId)
    if (!thread || !this.connected(thread)) return
    const seen = watcherTurnOutcome(operation, thread, id => watcherMessages.has(id))
    if (!seen || seen.outcome === operation.outcome && seen.turnMessageId === operation.turnMessageId
      && seen.nativeTurnId === operation.nativeTurnId && seen.replyMessageId === operation.replyMessageId) return
    operation.outcome = seen.outcome; operation.outcomeAt = now()
    for (const field of REFERENCE_FIELDS) {
      const value = seen[field]
      if (value) operation[field] = value
      else delete operation[field]
    }
    if (seen.outcome === 'answered') this.answeredThisRun.add(operation.id)
  }
  /**
   * The start or send a thread's newest turn answers, which its news names: the brief whose own message began the turn,
   * or else the newest steer of Watcher's read into it. None when the turn is the user's own.
   */
  private answeringOperation(target: WatcherThreadTarget, thread: AgentThread, record: Readonly<WatcherRecord>): string | undefined {
    const turn = watcherLatestTurnMessageId(thread)
    if (!turn) return undefined
    const watcherMessages = new Set(record.operations.flatMap(item => item.messageId ? [item.messageId] : []))
    const briefs = record.operations.filter(item => (item.action === 'start' || item.action === 'send') && key(item.target) === key(target)
      && item.messageId !== undefined && item.deliveryState !== 'failed')
    return (briefs.find(item => item.messageId === turn)
      ?? briefs.findLast(item => item.delivery === 'steer' && watcherTurnOutcome(item, thread, id => watcherMessages.has(id))?.turnMessageId === turn))?.id
  }
  /**
   * Where a start or send stands: from its receipt until it is delivered, then as its owning host observed its turn.
   * Undefined for stop and settle, which carry no brief. A paired host that does not report outcomes reads as unknown.
   */
  outcomeOf(operation: WatcherOperation, reportsOutcomes = (hostId: string) => this.remoteReportsOutcomes(hostId)): WatcherOutcome | undefined {
    if (operation.action !== 'start' && operation.action !== 'send') return undefined
    if (operation.deliveryState === 'failed') return operation.refusalCode === 'THREAD_TAKEN_OVER' ? 'paused'
      : operation.refusalCode === 'REQUEST_NOT_ACTIVE' ? 'stopped' : 'failed'
    if (operation.outcome === 'unknown' || operation.deliveryState === 'uncertain') return 'unknown'
    if (operation.deliveryState !== 'accepted') return 'working'
    if (operation.outcome) return operation.outcome
    return operation.target.hostId === this.options.control.hostId() || reportsOutcomes(operation.target.hostId) ? 'working' : 'unknown'
  }
  private remoteReportsOutcomes(hostId: string): boolean { return this.remote?.hosts().find(host => host.hostId === hostId)?.outcomes === true }
  /** The outcome, its turn's evidence and, once answered, the worker's reply, for a start or send this host owns. */
  private async outcomeRead(operation: WatcherOperation): Promise<OutcomeRead> {
    const outcome = this.outcomeOf(operation)
    if (!outcome) return {}
    let thread: AgentThread | undefined
    try { thread = this.thread(operation.target) } catch { /* An unavailable thread still has its recorded outcome. */ }
    const turnIds = new Set([operation.turnMessageId, operation.nativeTurnId].filter(id => id !== undefined))
    const evidence = turnIds.size ? this.wakes.evidence.read(operation.target, Boolean(thread && this.connected(thread)))
      .filter(item => item.turnId !== undefined && turnIds.has(item.turnId)).slice(-20) : []
    const read: OutcomeRead = { outcome, reference: { target: operation.target, ...(operation.turnMessageId ? { turnMessageId: operation.turnMessageId } : {}),
      ...(operation.nativeTurnId ? { nativeTurnId: operation.nativeTurnId } : {}), ...(operation.replyMessageId ? { replyMessageId: operation.replyMessageId } : {}) },
    // A message after the one that began this brief's turn, which has ended, began another turn in the thread.
    outcomeNote: outcome === 'background' && thread && operation.turnMessageId !== undefined && laterUserMessage(thread, operation.turnMessageId)
      ? BACKGROUND_MOVED_ON : OUTCOME_NOTES[outcome],
    ...(evidence.length ? { evidence } : {}) }
    if (outcome !== 'answered' || !operation.replyMessageId) return read
    if (!this.options.historyEnabled() && !this.answeredThisRun.has(operation.id)) return { ...read, replyUnavailable: { reason: 'history-off',
      message: 'Keep local history is off, so Sotto did not keep this reply after it restarted. Read the thread for what the worker said.' } }
    const replyId = operation.replyMessageId
    const message = thread?.messages.find(item => item.id === replyId && item.role === 'assistant') ?? await this.storedReply(operation.target.threadId, replyId)
    if (!message) return { ...read, replyUnavailable: { reason: 'not-retained', message: 'Sotto no longer holds this reply. Read the thread for what the worker said.' } }
    const text = cutUtf8(message.text, WATCHER_REPLY_BYTES_MAX)
    return { ...read, reply: { from: 'worker', messageId: message.id, text, createdAt: message.createdAt, truncated: text !== message.text } }
  }
  /**
   * A reply the thread's loaded window no longer holds, read from its history: the newest page first, where it usually
   * is, then forward from the start until the history ends. Undefined only when the history does not hold it.
   */
  private async storedReply(threadId: string, replyId: string) {
    const found = (read: Awaited<ReturnType<WorkspaceHost['watcherRead']>>) => read?.messages.find(item => item.message.id === replyId && item.message.role === 'assistant')?.message
    const newest = await this.options.host.watcherRead(threadId, undefined, 50).catch(() => undefined)
    if (!newest || found(newest) || !newest.earlierAvailable) return found(newest)
    let after = -1
    for (let page = 0; page < 1_000; page++) {
      const read = await this.options.host.watcherRead(threadId, after, 50).catch(() => undefined)
      const message = found(read)
      if (message || !read?.hasMore || !read.messages.length) return message
      after = read.messages.at(-1)!.position
    }
    return undefined
  }
  /** What a paired host's exact read said of an operation's outcome, kept as identities only. */
  private copyOutcome(own: WatcherOperation, result: OperationRead): void {
    for (const field of OUTCOME_FIELDS) delete own[field]
    if (!result.outcome || own.deliveryState !== 'accepted') return
    own.outcome = result.outcome; own.outcomeAt = now()
    const reference = result.reference
    if (reference?.turnMessageId) own.turnMessageId = reference.turnMessageId
    if (reference?.nativeTurnId) own.nativeTurnId = reference.nativeTurnId
    if (reference?.replyMessageId) own.replyMessageId = reference.replyMessageId
  }
  private confirmedWorkerStop(operation: WatcherOperation, request: WatcherRecord['requests'][number]): boolean {
    return operation.action === 'stop' && operation.confirmedStop === true && request.participants.some(item => key(item.target) === key(operation.target)
      && item.startedBy === 'watcher' && item.state === 'participating')
  }
  private pruneRemoteGuards(): void {
    const live = new Set(this.view().operations.filter(item => this.active.has(item.id) || ['queued', 'dispatching', 'uncertain'].includes(item.deliveryState)).map(item => item.id))
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
      this.checkRemoteAuthority(operation, request.remoteOrigin.master, request.remoteOrigin.clientId, request.standingWatchId)
      const guard = this.remoteGuards.get(operation.id)
      if (!guard) refuse('HOST_DISCONNECTED', 'The master connection is unavailable. Reconcile this operation before continuing.')
      guard()
    } else if (!record.current || key(record.current.target) !== key(request.watcher)) refuse('NOT_CURRENT_WATCHER', 'This operation no longer belongs to the current Watcher.')
    if (operation.deliveryState === 'failed') refuse(operation.refusalCode ?? 'REQUEST_NOT_ACTIVE', 'This operation was cancelled before dispatch. Nothing was sent.')
    if (request.state !== 'active' && !this.confirmedWorkerStop(operation, request)) refuse('REQUEST_NOT_ACTIVE', 'This Watcher request has stopped. Nothing was sent.')
    if (!request.remoteOrigin) this.checkLocalWithdrawal(operation)
    const participant = request.participants.find(item => key(item.target) === key(operation.target))
    if (operation.standingWatchId) {
      const assignment = record.watches?.find(watch => watch.id === operation.standingWatchId && key(watch.target) === key(operation.target))
      if (!assignment && !(request.remoteOrigin && operation.action === 'start')) refuse('REQUEST_NOT_ACTIVE', 'This watch changed or stopped. Nothing was sent.')
      if (assignment && assignment.generation !== operation.generation) refuse(assignment.pausedByUserMessageId || participant?.state === 'taken-over' ? 'THREAD_TAKEN_OVER' : 'REQUEST_NOT_ACTIVE', 'This watch changed or stopped. Nothing was sent.')
    }
    if (request.standingWatchId) {
      const watch = record.watches?.find(item => item.id === request.standingWatchId && key(item.target) === key(operation.target))
      if (!watch || watch.generation !== operation.generation) refuse('THREAD_TAKEN_OVER', 'This watch changed. Read its thread before sending again.')
      if (request.remoteOrigin && watch.remoteOrigin?.masterCreationOperationId !== request.remoteOrigin.creationOperationId) refuse('NOT_CURRENT_WATCHER', 'That Watcher conversation was replaced. Nothing was sent.')
    }
    if (participant?.state === 'relinquished' && (operation.action === 'start' || operation.action === 'send')) refuse('REQUEST_NOT_ACTIVE', 'Watcher settled this participation. Nothing was sent.')
    if (!participant || participant.state !== 'participating' || participant.generation !== operation.generation) refuse('THREAD_TAKEN_OVER', 'You took over this thread. Watcher stopped sending to it.')
    if (participant.automationStopped && (operation.action === 'start' || operation.action === 'send')) refuse('REQUEST_NOT_ACTIVE', 'Watcher stopped this participation. It will not send another prompt for this request.')
    if (operation.action === 'start' && !this.options.control.watcherSnapshot().threads.some(item => item.id === operation.target.threadId)) return
    const thread = this.thread(operation.target); this.protect(thread)
    if (!this.connected(thread)) refuse('HOST_DISCONNECTED', 'This thread is disconnected. Nothing was sent. Reconnect its provider.', true)
    if (operation.action === 'start' || operation.action === 'send') {
      this.checkHumanTurn(thread, record)
      this.pending(thread); this.checkPermission(thread, request)
      this.checkRemoteCeiling(request.id, thread.runtimeMode)
      if (operation.expectedLastUserMessageId && operation.expectedLastUserMessageId !== nativeHead(thread)) refuse('TARGET_CHANGED', 'This thread received another instruction. Read it before sending.')
      if (operation.delivery === 'steer' && (thread.status !== 'running' || operation.expectedTurnId !== thread.lastTurn?.id)) refuse('TURN_CHANGED', 'The running turn changed. Nothing was steered.')
      if (operation.delivery !== 'queue' && operation.delivery !== 'steer' && thread.status === 'running') refuse('THREAD_BUSY', 'This thread is working. Choose queue explicitly.', true)
    }
    if (operation.action === 'settle') {
      this.checkSettlement(thread)
      if (record.operations.some(item => item.id !== operation.id && key(item.target) === key(operation.target) && ['queued', 'dispatching', 'uncertain'].includes(item.deliveryState))) refuse('DELIVERY_UNCERTAIN', 'This thread still has an outstanding delivery. Reconcile it before settling.')
    }
  }

  /**
   * A watch is the user's to give. A watched thread is Watcher's to keep going, so Watcher may take one with watch_thread
   * only while it answers the user's own message: the turn's latest user message must be the root or a continuation of
   * an active request the user started. A wake-up, a standing scope or Watcher's own initiative grants no watch.
   */
  private checkUserAskedWatch(): void {
    const record = this.record(), current = record.current!
    const head = nativeHead(this.thread(current.target))
    if (!head || !record.requests.some(request => request.state === 'active' && !request.standingWatchId && !request.remoteOrigin
      && key(request.watcher) === key(current.target)
      && (request.rootUserMessageId === head || request.userFollowups?.some(followup => followup.messageId === head)))) {
      refuse('REQUEST_NOT_ACTIVE', 'Only the user gives Watcher a thread to watch, with Watch or by asking in a message to Watcher. Nothing was watched.')
    }
  }
  /**
   * One sotto_threads call. A client that declares how long it waits for a call (`waitMs`) is answered before that, and the
   * call carries on: a start or send still under way answers with its receipt, which read_operation reads (ADR-0079).
   */
  invoke(threadId: string, name: WatcherToolName, args: unknown, context: { readonly waitMs?: number } = {}): Promise<unknown> {
    return this.startCall(threadId, name, args, context).answer
  }
  /**
   * The same call, with when its work truly ends: `answer` may come first, inside the client's wait, while `settled` waits
   * for the work itself. The tool server holds the call's place in its in-flight count until then.
   */
  startCall(threadId: string, name: WatcherToolName, args: unknown, context: { readonly waitMs?: number } = {}): { readonly answer: Promise<unknown>; readonly settled: Promise<void> } {
    const progress: CallProgress = {}
    const work = this.invokeNow(threadId, name, args, progress)
    const settled = work.then(() => undefined, () => undefined)
    if (context.waitMs === undefined) return { answer: work.then(result => this.toldReceipt(result)), settled }
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<typeof LATE>(resolve => { timer = setTimeout(() => resolve(LATE), Math.max(context.waitMs! - CLIENT_WAIT_MARGIN_MS, context.waitMs! / 2)) })
    const answer = Promise.race([work, late]).then(result => this.toldReceipt(result === LATE ? this.stillWorking(name, progress) : result))
      .finally(() => { clearTimeout(timer) })
    return { answer, settled }
  }
  /**
   * A tool's answer that carries a receipt gives Watcher that receipt as it stands now, a refusal included, so the same
   * receipt is no news to it afterwards (#1190). Only a later change to it is.
   */
  private toldReceipt<T>(result: T): T {
    const operationId = (result as { receipt?: { operationId?: unknown } } | null)?.receipt?.operationId
    const operation = typeof operationId === 'string' ? this.view().operations.find(item => item.id === operationId) : undefined
    if (operation) this.wakes.toldReceipt(operation)
    return result
  }
  /** The answer to a call its client would otherwise give up on: where it stands, and how to read how it ends. */
  private stillWorking(name: WatcherToolName, progress: CallProgress): unknown {
    if (!MUTATIONS.has(name)) return watcherRefusal('PROVIDER_UNAVAILABLE', name === 'watch_thread' || name === 'unwatch_thread' ? STILL_WATCHING : STILL_READING, true)
    const operation = progress.operationId ? this.record().operations.find(item => item.id === progress.operationId) : undefined
    return operation ? { ...watcherRefusal('DELIVERY_UNCERTAIN', STILL_DELIVERING, true), receipt: this.receipt(operation) }
      : watcherRefusal('DELIVERY_UNCERTAIN', STILL_ADMITTING, true)
  }
  private async invokeNow(threadId: string, name: WatcherToolName, args: unknown, progress: CallProgress): Promise<unknown> {
    this.invocations++
    try {
      this.checkCaller(threadId)
      if (this.changing) refuse('THREAD_BUSY', 'Wait for Watcher’s provider change before using its tools.', true)
      const parsed = watcherToolSchemas[name].input.safeParse(args)
      if (!parsed.success) refuse('INVALID_INPUT', 'This call has invalid or oversized arguments. Use the offered tool schema.')
      if (name === 'watch_thread') {
        this.checkUserAskedWatch()
        return { status: 'ok', watch: await this.assignWatch(parsed.data as WatcherToolInput<'watch_thread'>) }
      }
      if (name === 'unwatch_thread') {
        const result = await this.unwatchThread(parsed.data as WatcherToolInput<'unwatch_thread'>)
        return result.status === 'refused' ? result : { status: 'ok', target: (parsed.data as WatcherToolInput<'unwatch_thread'>).target, watched: false }
      }
      if (name === 'list_machines') return await this.listMachines()
      const input = parsed.data as { hostId?: string; target?: WatcherThreadTarget; project?: { hostId: string } }
      const hostId = input.hostId ?? input.target?.hostId ?? input.project?.hostId
      const requestId = 'requestId' in parsed.data ? parsed.data.requestId : undefined
      if (hostId && hostId !== this.hostId() && requestId && input.target) await this.reconcileRemote(hostId)
      // A paired host's projects are listed here, from its snapshot, so their permission is the one start and send hold to.
      if (hostId && hostId !== this.hostId() && ['list_threads', 'list_working_copies', 'read_thread'].includes(name)) {
        this.requireRemote(hostId, false)
        return await this.remote!.read(hostId, { master: this.record().current!, call: { name, input: parsed.data } } as WatcherHostRead)
      }
      if (name === 'list_threads' || name === 'list_projects' || name === 'list_working_copies' || name === 'read_thread' || name === 'read_operation') {
        const call = watcherHostReadSchema.shape.call.unwrap().parse({ name, input: parsed.data })
        let operation: WatcherOperation | undefined
        if (call.name === 'read_operation') {
          operation = this.record().operations.find(item => item.id === call.input.operationId)
          if (!operation || !this.record().requests.some(item => item.id === operation!.requestId && key(item.watcher) === key(this.target(threadId)))) refuse('UNKNOWN_OPERATION', 'That operation does not belong to this Watcher request.')
          let hosted: OutcomeRead | undefined
          if (operation.target.hostId !== this.hostId()) {
            this.requireRemote(operation.target.hostId, false)
            // Only a host that lists watcher-outcomes is asked for them; an older one would refuse the field.
            const outcomes = this.remoteReportsOutcomes(operation.target.hostId)
            const result = watcherToolSchemas.read_operation.output.parse(await this.remote!.read(operation.target.hostId,
              { master: this.record().current!, call: { name: 'read_operation', input: { operationId: operation.id } }, ...(outcomes ? { outcomes: true as const } : {}) }))
            if (result.status === 'refused') return result
            if (result.receipt.operationId !== operation.id || key(result.receipt.target) !== key(operation.target) || result.receipt.requestId !== operation.requestId) refuse('INVALID_INPUT', 'The owning host returned another receipt. Nothing was sent.')
            const { operationId: _operationId, ...receipt } = result.receipt; void _operationId
            const id = operation.id
            await this.options.control.updateWatcher(record => {
              const own = record.operations.find(item => item.id === id)!
              Object.assign(own, receipt)
              if (outcomes) this.copyOutcome(own, result)
            })
            await this.reconcileRemote(operation.target.hostId)
            const reported = outcomes && result.outcome !== undefined
            const { outcome, reference, outcomeNote, reply, replyUnavailable, evidence } = result
            const fallback = this.outcomeOf(this.record().operations.find(item => item.id === id)!)
            hosted = reported ? { outcome, reference, outcomeNote, ...(reply ? { reply } : {}), ...(replyUnavailable ? { replyUnavailable } : {}), ...(evidence ? { evidence } : {}) }
              : fallback ? { outcome: fallback, reference: { target: operation.target }, outcomeNote: fallback === 'unknown' && !outcomes ? HOST_WITHOUT_OUTCOMES : OUTCOME_NOTES[fallback] } : {}
          }
          operation = this.record().operations.find(item => item.id === operation!.id)!
          return await this.dispatchRead(call, operation, true, hosted)
        }
        return await this.dispatchRead(call, operation)
      }
      return await this.mutate(threadId, name, parsed.data as WatcherToolInput<'start_thread'> | WatcherToolInput<'send_to_thread'> | WatcherToolInput<'stop_thread'>, undefined, undefined, progress)
    } catch (error) { return error instanceof Refusal ? error.result : watcherRefusal('PROVIDER_UNAVAILABLE', 'This Watcher call could not be completed. Check the operation receipt before trying again.', true) }
    finally { this.invocations-- }
  }
  private async mutate(threadId: string, name: WatcherToolName, input: WatcherToolInput<'start_thread'> | WatcherToolInput<'send_to_thread'> | WatcherToolInput<'stop_thread'>, imported?: WatcherOperation, connectionGuard?: () => void, progress?: CallProgress): Promise<unknown> {
    const admitted = await this.transaction(async () => {
      if (imported && this.record().remoteAbsences?.some(item => item.operationId === imported.id)) refuse('OPERATION_NOT_RECORDED', 'An exact read fenced this unrecorded operation. Nothing was sent.')
      if (imported && this.closed) refuse('NOT_CURRENT_WATCHER', 'Watcher is stopping. Nothing was sent. Reopen Sotto.')
      if (!imported) this.checkCaller(threadId)
      const record = this.record(), originalInputDigest = digest([name, input])
      let request = record.requests.find(item => item.id === input.requestId), newStandingRequest: WatcherRecord['requests'][number] | undefined
      // The Watcher turn a new call counts against. A retry of a recorded operation returns its receipt without reading one.
      let turnRead: { readonly value: PromptTurn | undefined } | undefined
      const turnOf = (): PromptTurn | undefined => (turnRead ??= { value: imported ? imported.promptTurnId ? this.promptTurn(record, request!.watcher, imported.promptTurnId) : undefined
        : this.promptTurn(record, record.current!.target) }).value
      const offeredTarget = 'target' in input ? input.target : undefined
      const offeredWatch = !imported && offeredTarget ? record.watches?.find(watch => watch.id === input.requestId && key(watch.target) === key(offeredTarget)) : undefined
      if (offeredWatch) {
        const retry = record.operations.find(operation => operation.retryKey === input.retryKey
          && record.requests.some(scope => scope.id === operation.requestId && scope.standingWatchId === offeredWatch.id))
        if (retry) {
          if (retry.inputDigest !== originalInputDigest) refuse('RETRY_KEY_CONFLICT', 'This retry key belongs to another watch operation. Read the original receipt.')
          return { operation: retry, retry: true }
        }
        // Four prompts per Watcher turn and assignment. A stopped scope stays stopped; a later turn gets a new scope.
        const standing = standingScope(record, record.current!.target, offeredWatch.id, turnOf()!.id)
        request = standing.scope
        if (standing.created) newStandingRequest = request
        else {
          const participant = request.participants.find(item => key(item.target) === key(offeredWatch.target))
          // A human turn fences this scope; subsequent automation requires a later Watcher turn.
          if (participant?.state === 'taken-over') refuse('THREAD_TAKEN_OVER', 'Read the user’s turn in a new Watcher turn before sending again.')
        }
        input = { ...input, requestId: request.id }
      }
      if (!request || request.watcher.threadId !== threadId || !imported && request.watcher.hostId !== this.hostId()) refuse('REQUEST_NOT_ACTIVE', 'This request is not active. Only a user Send to Watcher can start a request.')
      const inputDigest = digest([name, input])
      const existing = record.operations.find(item => item.requestId === input.requestId && item.retryKey === input.retryKey)
      if (existing) {
        if ((imported ? existing.digest : existing.inputDigest ?? existing.digest) !== inputDigest) refuse('RETRY_KEY_CONFLICT', 'This retry key already belongs to a different call. Use the original receipt.')
        return { operation: existing, retry: true }
      }
      const turn = turnOf()
      if (imported && request.remoteOrigin) this.checkRemoteAuthority(imported, request.remoteOrigin.master, request.remoteOrigin.clientId, request.standingWatchId)
      if (request.state !== 'active' && !(imported && this.confirmedWorkerStop(imported, request))) {
        const stoppedTarget = 'target' in input ? input.target : undefined
        if (stoppedTarget && record.requests.some(item => item.participants.some(participant => key(participant.target) === key(stoppedTarget) && participant.state === 'taken-over'))) refuse('THREAD_TAKEN_OVER', 'You took over this thread. Watcher stopped sending to it.')
        refuse('REQUEST_NOT_ACTIVE', 'This request is not active. Only a user Send to Watcher can start a request.')
      }
      const start = name === 'start_thread', send = name === 'send_to_thread'
      const owner = start ? (input as WatcherToolInput<'start_thread'>).project.hostId : (input as WatcherToolInput<'send_to_thread'>).target.hostId
      const remote = owner !== this.hostId()
      if (remote) this.requireRemote(owner, true)
      if (remote && request.standingWatchId && !this.remote?.hosts().find(host => host.hostId === owner)?.standingWatch) refuse('HOST_FEATURE_UNAVAILABLE', 'Update this host before Watcher manages a standing watch.')
      const target = imported?.target ?? (start ? { hostId: owner, threadId: randomUUID() } : (input as WatcherToolInput<'send_to_thread'>).target)
      if (!imported && !record.watches?.some(watch => key(watch.target) === key(target)) && record.watchFences?.some(fence => !fence.remoteOrigin && fence.target && key(fence.target) === key(target))) refuse('REQUEST_NOT_ACTIVE', 'This thread was unwatched. Watch it again before using another automatic action.')
      if (start && this.options.control.watcherSnapshot().threads.some(item => item.id === target.threadId) && target.hostId === this.hostId()) refuse('TARGET_CHANGED', 'That thread identity already exists. Nothing was started.')
      const thread = start ? undefined : this.thread(target)
      if (thread) { this.protect(thread); if (!this.connected(thread)) refuse('HOST_DISCONNECTED', 'This thread is disconnected. Reconnect it before sending.', true) }
      const takenOver = name === 'send_to_thread' ? this.requestTakenOver(record, request, target)
        : !request.standingWatchId && record.requests.some(item => item.participants.some(participant => key(participant.target) === key(target) && participant.state === 'taken-over'))
      if (takenOver) refuse('THREAD_TAKEN_OVER', 'You took over this thread. Watcher stopped sending to it.')
      if (request.standingWatchId) {
        const watch = record.watches?.find(item => item.id === request!.standingWatchId && key(item.target) === key(target))
        if (!watch) refuse('REQUEST_NOT_ACTIVE', 'This thread is no longer watched. Nothing was sent.')
        if (imported && imported.generation !== watch.generation) refuse('THREAD_TAKEN_OVER', 'This watch changed. Read the thread before sending again.')
      }
      let roleResult: RoleReceipt | undefined
      if (start) {
        const create = input as WatcherToolInput<'start_thread'>
        const snapshot = this.owningSnapshot(owner)!
        const project = snapshot.projects.find(item => item.id === create.project.projectId)
        if (!project) refuse('UNKNOWN_TARGET', 'That project is unavailable. Read the project list again.')
        if (this.reservedProject(project.path)) refuse('RESERVED_THREAD', 'This project has a special job and is not a worker project.')
        const limits = this.permissionLimits(request, owner)
        // A start by worker role reads the user's Settings here, once, and only when a start is asked (#1041). What the
        // request named wins; a retry of a recorded start returned above and never resolves the role again.
        const byRole = !imported && create.role && this.options.roles ? startFromRole(create.role, this.options.roles(), snapshot.models, { modelId: create.modelId,
          reasoningEffort: create.reasoningEffort, runtimeMode: create.permission?.kind === 'runtime' ? create.permission.mode : undefined }) : undefined
        const modelId = byRole ? byRole.modelId : create.modelId
        if (!modelId) refuse(byRole ? 'PROVIDER_UNAVAILABLE' : 'INVALID_INPUT', byRole
          ? 'No ready model can do that kind of work. Connect a provider in Settings, under Providers. Nothing was started.'
          : 'Name the worker model for this start. Nothing was started.')
        const model = resolveModel(snapshot.models, modelId)
        if (!model?.ready) refuse('PROVIDER_UNAVAILABLE', 'Choose a ready worker model. Sotto will not switch accounts.')
        if (create.reasoningEffort && !model.reasoningEfforts?.includes(create.reasoningEffort)) refuse('INVALID_INPUT', 'Choose an effort this worker model offers.')
        const roleEffort = byRole?.reasoningEffort && !byRole.named.includes('effort') && model.reasoningEfforts?.includes(byRole.reasoningEffort) ? byRole.reasoningEffort : undefined
        // A permission the request named keeps its refusal. One the role gave is held to the ceiling instead.
        let explicit = create.permission, held: HeldPermission | undefined
        if (byRole?.runtimeMode && !explicit) {
          const ceiling = this.ceiling(model, limits)
          if (ceiling.providerMode === undefined && ceiling.runtimeMode) {
            const mode = capRuntimeMode(byRole.runtimeMode, ceiling.runtimeMode)
            // A limit the model does not offer starts on the nearest mode it does, and the receipt says that is why.
            if (mode !== byRole.runtimeMode) held = { wanted: byRole.runtimeMode, startedOn: mode, by: ceiling.by, ...(ceiling.nearestFit ? { unoffered: ceiling.limit } : {}) }
            explicit = { kind: 'runtime', mode }
          }
        }
        const permission = this.permission(model, explicit, limits)
        if (!imported) {
          const configuration = this.options.control.configuration()
          const reference = resolveModel(this.options.control.watcherSnapshot().models, configuration.newThreadModelId)?.reasoningEfforts ?? model.reasoningEfforts ?? []
          const effort = create.reasoningEffort ?? roleEffort ?? (configuration.newThreadReasoningEffort
            ? nearestReasoningEffort(configuration.newThreadReasoningEffort, reference, model.reasoningEfforts ?? []) : undefined)
          // The concrete start carries no role, so its digest and a paired host's packet keep their shape.
          const { role: _role, ...concrete } = create; void _role
          input = watcherToolSchemas.start_thread.input.parse({ ...concrete, modelId, ...(effort !== undefined ? { reasoningEffort: effort } : {}), permission })
        }
        if (byRole) {
          const named = create.permission?.kind === 'provider' && !byRole.named.includes('permission') ? [...byRole.named, 'permission' as const] : byRole.named
          roleResult = { id: byRole.role, named: [...named], note: roleStartNote({ ...byRole, named }, snapshot.models, held) }
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
        this.checkHumanTurn(thread, record)
        if (request.standingWatchId && isWorkspaceThreadSettled(thread, this.owningSnapshot(owner)?.projects.find(project => project.id === thread.projectId))) refuse('REQUEST_NOT_ACTIVE', 'This watched thread is settled. Its next user instruction starts new work.')
        this.checkPermission(thread, request)
        this.checkRemoteCeiling(request.id, thread.runtimeMode)
        const sent = input as WatcherToolInput<'send_to_thread'>
        if (sent.expectedLastUserMessageId && sent.expectedLastUserMessageId !== nativeHead(thread)) refuse('TARGET_CHANGED', 'This thread received another instruction. Read it before sending.')
        if (sent.delivery === 'now' && (thread.status === 'running' || !remote && this.options.control.hasPendingThreadWork(thread.id))) refuse('THREAD_BUSY', 'This thread is working or has a queued prompt. Choose queue explicitly.')
        if (sent.delivery === 'steer' && (!capabilitiesForThread(this.owningSnapshot(owner)!, thread).steer || !sent.expectedTurnId || sent.expectedTurnId !== thread.lastTurn?.id || thread.status !== 'running')) refuse('STEER_UNAVAILABLE', 'Steer needs a supported, confirmed running turn. Read the thread and its turn first.')
      }
      if (thread && name === 'settle_thread') {
        this.checkSettlement(thread)
        if (!remote && this.options.control.hasPendingThreadWork(thread.id)) refuse('DELIVERY_UNCERTAIN', 'Reconcile this thread’s pending delivery before settling.')
      }
      if (start || send) {
        const shared = start && !imported ? this.inFlight(record) + (this.options.otherStartsInFlight?.() ?? 0) : 0
        if (start && !imported && (shared > this.options.limit() || !record.reservations.some(item => key(item.target) === key(target)) && shared >= this.options.limit())) refuse('IN_FLIGHT_LIMIT', 'Watcher’s threads in flight limit is reached. Wait for a thread to finish.', true)
        if (this.promptCount(record, target, turn?.id, request.id) >= WATCHER_PROMPTS_PER_THREAD) refuse('PROMPT_LIMIT', 'This thread has received four prompts in this Watcher turn. A retry or another request cannot renew the limit.')
      }
      const assignment = record.watches?.find(watch => key(watch.target) === key(target))
        ?? ((start || send) && !imported && (!remote || this.remote?.hosts().find(host => host.hostId === owner)?.standingWatch) ? this.newWatch(target, thread) : undefined)
      const time = now(), id = randomUUID()
      const operation: WatcherOperation = imported ?? { id, requestId: request.id, retryKey: input.retryKey, digest: digest([name, input]),
        ...(start || offeredWatch ? { inputDigest: offeredWatch ? originalInputDigest : inputDigest } : {}),
        action: start ? 'start' : send ? 'send' : name === 'stop_thread' ? 'stop' : 'settle', target,
        ...(turn ? { promptTurnId: turn.id } : {}), ...(assignment ? { standingWatchId: assignment.id } : {}),
        generation: previous?.generation ?? assignment?.generation ?? 0, anchorMessageId: request.rootUserMessageId, deliveryState: 'queued', createdAt: time, updatedAt: time, receiptId: randomUUID(), cardId: randomUUID(),
        ...(start || send ? { draftId: randomUUID(), messageId: randomUUID(), delivery: start ? 'now' : (input as WatcherToolInput<'send_to_thread'>).delivery } : {}),
        ...(start ? { creationReceiptId: randomUUID(), firstPromptReceiptId: randomUUID() } : {}),
        ...(send && (input as WatcherToolInput<'send_to_thread'>).expectedTurnId ? { expectedTurnId: (input as WatcherToolInput<'send_to_thread'>).expectedTurnId } : {}),
        ...(send && (input as WatcherToolInput<'send_to_thread'>).expectedLastUserMessageId ? { expectedLastUserMessageId: (input as WatcherToolInput<'send_to_thread'>).expectedLastUserMessageId } : {}) }
      if (imported && (imported.generation !== (previous?.generation ?? assignment?.generation ?? 0) || record.operations.some(item => item.id === imported.id
        || ['receiptId', 'cardId', 'draftId', 'messageId', 'creationReceiptId', 'firstPromptReceiptId'].some(field => {
          const name = field as 'receiptId' | 'cardId' | 'draftId' | 'messageId' | 'creationReceiptId' | 'firstPromptReceiptId'
          return imported[name] && imported[name] === item[name]
        })))) refuse('TARGET_CHANGED', 'This operation identity or ownership generation changed. Nothing was sent.')
      await this.options.control.updateWatcher(next => {
        if (imported && connectionGuard) { connectionGuard(); this.remoteGuards.set(imported.id, connectionGuard) }
        if (turn) next.promptTurns = record.promptTurns
        if (newStandingRequest) next.requests.push(newStandingRequest)
        const owned = next.requests.find(item => item.id === request.id)!
        if (remote && !owned.pairedPermissionCeiling) owned.pairedPermissionCeiling = this.options.control.configuration().newThreadRuntimeMode ?? 'approval-required'
        let participant = owned.participants.find(item => key(item.target) === key(target))
        if (!participant) { participant = { requestId: request.id, target, startedBy: start || next.requests.some(item => item.participants.some(worker => key(worker.target) === key(target) && worker.startedBy === 'watcher')) ? 'watcher' : 'user', generation: operation.generation, state: 'participating', promptCount: 0, lastUserMessageId: thread ? nativeHead(thread) : null }; owned.participants.push(participant) }
        if (assignment && !next.watches?.some(watch => key(watch.target) === key(target)) && !imported) (next.watches ??= []).push(assignment)
        if (start || send) participant.promptCount = this.promptCount(next, target, turn?.id, request.id) + 1
        next.operations.push(operation)
        if (start && !next.reservations.some(item => key(item.target) === key(target))) next.reservations.push({ target, requestId: request.id, operationId: operation.id, generation: participant.generation, reason: 'creation' })
      })
      if (roleResult) this.rememberRoleStart(operation.id, roleResult)
      return { operation, retry: false }
    })
    if (progress) progress.operationId = admitted.operation.id
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
        // Admission named the model of every start it let through, by role or by name.
        const modelId = create.modelId
        if (!modelId) throw new Error('model-missing')
        const choices = await this.resolveCopies(create)
        const limits = this.permissionLimits(this.record().requests.find(item => item.id === operation.requestId), this.hostId())
        const permission = this.permission(resolveModel(this.options.control.watcherSnapshot().models, modelId), create.permission, limits)
        const createOrigin: WatcherCommandOrigin = { operationId: operation.id, guard: () => {
          origin.guard()
          this.permission(resolveModel(this.options.control.watcherSnapshot().models, modelId), permission,
            this.permissionLimits(this.record().requests.find(item => item.id === operation.requestId), this.hostId()))
          this.checkRemoteCeiling(operation.requestId, permission.kind === 'runtime' ? permission.mode : undefined)
        } }
        const created = await this.options.control.commandFromWatcher({ type: 'create-thread', threadId: operation.target.threadId,
          projectId: create.project.projectId, title: create.title, titleSource: 'user', modelId,
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
          const request = record.requests.find(item => item.id === operation.requestId)!
          const watch = record.watches?.find(item => item.id === (request.standingWatchId ?? operation.standingWatchId))
          if (watch) watch.generation++
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
  queueFailed(operationIds: ReadonlySet<string>): void {
    // Never throws: the queue has already removed or failed the items, and its caller still has to save and publish that.
    // A record that cannot take the failure is left as it was, and the next snapshot reconciles it.
    try {
      const hostId = this.options.control.hostId(), snapshot = this.options.control.watcherSnapshot()
      this.options.control.mutateWatcher(record => {
        for (const operation of record.operations) if (operationIds.has(operation.id) && operation.target.hostId === hostId
          && operation.deliveryState !== 'accepted' && operation.deliveryState !== 'failed') this.recordQueueFailure(record, operation)
        // A failed send no longer holds its thread's place, here as after a snapshot.
        if (hostId) this.pruneReservations(record, snapshot)
      })
    } catch { /* The next snapshot records it. */ }
  }
  /** Keeps a reservation only while its thread's delivery is unresolved, queued or still working for a participating request. */
  private pruneReservations(record: WatcherRecord, snapshot: AgentHostSnapshot): void {
    record.reservations = record.reservations.filter(reservation => {
      if (reservation.target.hostId !== this.hostId()) return true
      const request = record.requests.find(item => item.id === reservation.requestId)
      const participant = request?.participants.find(item => key(item.target) === key(reservation.target))
      const thread = snapshot.threads.find(item => item.id === reservation.target.threadId)
      const operations = record.operations.filter(item => key(item.target) === key(reservation.target))
      if (operations.some(item => ['dispatching', 'uncertain'].includes(item.deliveryState))) return true
      if (participant?.state !== 'participating') return false
      if (operations.some(item => item.deliveryState === 'queued')) return true
      if (!thread && operations.every(item => item.deliveryState === 'failed')) return false
      if (!thread || !isThreadProviderConnected(snapshot, thread) || thread.clientConnected === false) return true
      return thread.status === 'running' || thread.lastTurn?.status === 'running' || Boolean(thread.requests.length || thread.backgroundWork?.length || thread.monitoring?.length)
    })
  }
  /** A send seen delivered after its failure was refunded takes its prompt back, so the count matches what was sent. */
  private recordAccepted(record: WatcherRecord, operation: WatcherOperation): void {
    if (operation.deliveryState !== 'accepted' && operation.promptRefunded) {
      const participant = record.requests.find(item => item.id === operation.requestId)?.participants.find(item => key(item.target) === key(operation.target))
      if (participant) participant.promptCount++
      delete operation.promptRefunded
    }
    operation.deliveryState = 'accepted'
  }
  private recordQueueFailure(record: WatcherRecord, operation: WatcherOperation): void {
    const refusal = this.dispatchRefusals.get(operation.id)?.result.code
    this.recordOutcome(record, operation, 'failed', refusal ?? operation.refusalCode ?? 'PROVIDER_UNAVAILABLE')
    this.dispatchRefusals.delete(operation.id)
  }
  /**
   * Requests with no workers that Watcher's last turn answered, once nothing is left queued to Watcher. A later request
   * answering the head means Watcher has gone past this one, as when a queued instruction moved from it to a fresh
   * request and the user then removed the rest of its queue.
   */
  private answeredWithoutWorkers<R extends Readonly<WatcherRecord>>(record: R, snapshot: AgentHostSnapshot): R['requests'][number][] {
    return record.requests.filter((request, index) => {
      if (request.state !== 'active' || request.participants.length || record.operations.some(item => item.requestId === request.id)) return false
      const master = request.watcher.hostId === this.hostId() ? snapshot.threads.find(item => item.id === request.watcher.threadId) : undefined
      const head = master && nativeHead(master)
      const answered = (item: WatcherRequest) => item.rootUserMessageId === head || item.userFollowups?.some(followup => followup.messageId === head)
      return Boolean(master?.lastTurn && master.lastTurn.status !== 'running' && master.status !== 'running' && !this.options.control.hasPendingThreadWork(master.id)
        && (answered(request) || record.requests.some((item, later) => later > index && answered(item))))
    })
  }
  /**
   * Watcher's turn ending arrives with a provider snapshot, but its queue can empty after it, with only a publish to say
   * so. A request that has been waiting on that queue ends then.
   */
  private closeAnsweredRequests(): void {
    const snapshot = this.options.control.watcherSnapshot()
    if (this.answeredWithoutWorkers(this.view(), snapshot).length) this.options.control.mutateWatcher(next => {
      for (const request of this.answeredWithoutWorkers(next, snapshot)) { request.state = 'closed'; request.closedAt = now() }
    })
  }
  private recordOutcome(record: WatcherRecord, operation: WatcherOperation, state: WatcherOperation['deliveryState'], code?: WatcherRefusal['code']): void {
    const wasFailed = operation.deliveryState === 'failed', before = JSON.stringify(operation)
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
    if ((operation.action === 'stop' || operation.action === 'settle') && operation.deliveryState === 'accepted') this.fenceStandingTurn(record, operation.target)
    // A failed send waiting in the queue is recorded again on every snapshot: only a change is one, so the record stays.
    if (JSON.stringify(operation) !== before) operation.updatedAt = now()
  }
  private refundPrompt(record: WatcherRecord, operation: WatcherOperation, code: WatcherRefusal['code']): void {
    // A failure heard twice, from the queue and again from a snapshot, refunds once.
    if ((operation.action !== 'start' && operation.action !== 'send') || operation.promptRefunded || ['THREAD_TAKEN_OVER', 'REQUEST_NOT_ACTIVE', 'NOT_CURRENT_WATCHER'].includes(code)) return
    operation.promptRefunded = true
    const participant = record.requests.find(item => item.id === operation.requestId)!.participants.find(item => key(item.target) === key(operation.target))!
    participant.promptCount = Math.max(0, participant.promptCount - 1)
  }
  private rememberRoleStart(operationId: string, role: RoleReceipt): void {
    this.roleStarts.set(operationId, role)
    for (const kept of this.roleStarts.keys()) { if (this.roleStarts.size <= ROLE_STARTS_KEPT) break; this.roleStarts.delete(kept) }
  }
  private roleBlock(operationId: string): { role: RoleReceipt } | Record<string, never> {
    const role = this.roleStarts.get(operationId)
    return role ? { role } : {}
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
          workingCopy: create.workingCopy, ...(create.baseRefChoiceId ? { baseRefChoiceId: create.baseRefChoiceId } : {}) }, ...this.roleBlock(operation.id) }
    }
    if (name === 'send_to_thread') return { status: 'ok', ...base, delivery: operation.delivery }
    return { status: 'ok', ...base, state: this.operationState(operation.target), ...(name === 'stop_thread' ? { stopRequested: true } : {}) }
  }

  private requireRemote(hostId: string, mutation: boolean): void {
    const host = this.remote?.hosts().find(item => item.hostId === hostId)
    if (!host?.connected) refuse('HOST_DISCONNECTED', 'That host is disconnected. Its pending slots remain held. Reconnect it to continue.', true)
    if (!host.reads || mutation && !host.control) refuse('HOST_FEATURE_UNAVAILABLE', 'Update this host before Watcher directs its threads. Nothing was sent.')
    if (!this.takesMaster(host)) refuse('HOST_FEATURE_UNAVAILABLE', 'Update Sotto on this host before Watcher on Muse reads or directs its threads. Nothing was sent.')
  }
  /** An older host refuses a Watcher identity that names Muse, so a Watcher on Muse asks only hosts that list `watcher-muse`. */
  private takesMaster(host: { readonly muse?: boolean }): boolean { return this.view().current?.provider !== 'muse' || host.muse === true }
  private takingHost(hostId: string | undefined) {
    const host = this.remote?.hosts().find(item => item.hostId === hostId)
    return host && this.takesMaster(host) ? host : undefined
  }
  private async executeRemote(name: WatcherToolName, operation: WatcherOperation, input: WatcherToolInput<'start_thread'> | WatcherToolInput<'send_to_thread'> | WatcherToolInput<'stop_thread'>, confirmedStop?: () => void): Promise<unknown> {
    const request = this.record().requests.find(item => item.id === operation.requestId)!
    const guard = () => {
      this.checkCaller(request.watcher.threadId); this.requireRemote(operation.target.hostId, true)
      if (!confirmedStop) {
        const record = this.record(), live = record.operations.find(item => item.id === operation.id)!, scope = record.requests.find(item => item.id === operation.requestId)!
        this.checkLocalWithdrawal(live)
        const participant = scope.participants.find(item => key(item.target) === key(operation.target))
        if (live.deliveryState === 'failed') refuse(live.refusalCode ?? 'REQUEST_NOT_ACTIVE', 'This operation was cancelled before dispatch.')
        if (!participant || participant.state !== 'participating' || participant.generation !== live.generation) refuse('THREAD_TAKEN_OVER', 'You took over this thread. Nothing was sent.')
        if (scope.standingWatchId && !record.watches?.some(watch => watch.id === scope.standingWatchId && watch.generation === live.generation)) refuse('REQUEST_NOT_ACTIVE', 'This watch changed. Nothing was sent.')
        if (live.standingWatchId && !record.watches?.some(watch => watch.id === live.standingWatchId && watch.generation === live.generation)) refuse('REQUEST_NOT_ACTIVE', 'This watch changed. Nothing was sent.')
        if (live.action === 'send') this.checkHumanTurn(this.thread(live.target), record)
      }
      if (confirmedStop) confirmedStop()
      else if (this.record().requests.find(item => item.id === operation.requestId)?.state !== 'active') refuse('REQUEST_NOT_ACTIVE', 'This Watcher request has stopped. Nothing was sent.')
    }
    try {
      if (operation.action === 'send' && operation.standingWatchId) await this.reconcileRemote(operation.target.hostId)
      guard()
      await this.options.control.updateWatcher(record => { record.operations.find(item => item.id === operation.id)!.deliveryState = 'dispatching' })
      guard()
      const capable = this.remote!.hosts().find(host => host.hostId === operation.target.hostId)?.standingWatch
      const { promptTurnId: _turn, promptRefunded: _refunded, standingWatchId: _watch, ...legacyOperation } = operation
      void _turn; void _refunded; void _watch
      const result = await this.remote!.control(operation.target.hostId, { master: this.record().current!,
        request: { id: request.id, watcher: request.watcher, rootUserMessageId: request.rootUserMessageId, createdAt: request.createdAt,
          ...(request.standingWatchId ? { standingWatchId: request.standingWatchId } : {}) },
        ceiling: request.pairedPermissionCeiling ?? this.options.control.configuration().newThreadRuntimeMode ?? 'approval-required', operation: withoutOutcome(capable ? operation : legacyOperation),
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
      return parsed.status === 'ok' ? { ...parsed, limits: this.limits(this.record().operations.find(item => item.id === operation.id)!),
        ...(name === 'start_thread' ? this.roleBlock(operation.id) : {}) } : parsed
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
      if (!this.owningSnapshot(saved.target.hostId)?.threads.some(thread => thread.id === saved.target.threadId)) record.watches = record.watches?.filter(watch => key(watch.target) !== key(saved.target)) ?? []
    }
    record.reservations = record.reservations.filter(item => item.operationId !== operationId)
  }
  private copyRemoteReceipt(record: WatcherRecord, own: WatcherOperation, receipt: Pick<WatcherOperation, 'deliveryState' | 'refusalCode' | 'commandId' | 'itemId' | 'messageId' | 'updatedAt' | 'creationUncertain'>): void {
    // A read started before the control reply can arrive afterward. Definitive outcomes cannot become pending again.
    if ((own.deliveryState === 'accepted' || own.deliveryState === 'failed') && receipt.deliveryState !== own.deliveryState) return
    const wasFailed = own.deliveryState === 'failed'
    if (own.deliveryState !== 'accepted') own.deliveryState = receipt.deliveryState
    if (own.deliveryState === 'accepted') delete own.refusalCode
    else if (receipt.refusalCode) own.refusalCode = receipt.refusalCode
    if (receipt.commandId) own.commandId = receipt.commandId
    if (receipt.itemId) own.itemId = receipt.itemId
    if (receipt.messageId) own.messageId = receipt.messageId
    if ((own.action === 'stop' || own.action === 'settle') && own.deliveryState === 'accepted') this.fenceStandingTurn(record, own.target)
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
    for (const host of this.remote.hosts().filter(item => item.reads && item.connected && this.takesMaster(item) && (!hostId || item.hostId === hostId))) {
      const owned = this.record().requests.filter(request => key(request.watcher) === key(master.target))
      if (!host.standingWatch && !owned.some(request => request.participants.some(item => item.target.hostId === host.hostId)
        || this.record().operations.some(item => item.requestId === request.id && item.target.hostId === host.hostId))) continue
      let receiptFailed = false
      try {
        const stoppedRequests = this.record().requests.filter(request => request.state === 'stopped' && key(request.watcher) === key(master.target)
          && (request.participants.some(item => item.target.hostId === host.hostId) || this.record().operations.some(item => item.requestId === request.id && item.target.hostId === host.hostId)))
          .slice(-1_000).map(request => ({ request: { id: request.id, watcher: request.watcher, rootUserMessageId: request.rootUserMessageId, createdAt: request.createdAt },
            ceiling: request.pairedPermissionCeiling ?? this.options.control.configuration().newThreadRuntimeMode ?? 'approval-required' as const }))
        const cached = !force ? this.remote.projection?.(host.hostId, master) : undefined
        const projection = cached ?? await this.remote.read(host.hostId, { master,
          ...(host.standingWatch ? { standingWatches: this.hostWatches(host.hostId) } : {}),
          ...(stoppedRequests.length ? { stoppedRequests } : {}) }) as WatcherHostProjection
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
          for (const watch of projection.standingWatches ?? []) {
            const own = record.watches?.find(item => item.id === watch.id && key(item.target) === key(watch.target))
            if (!own || watch.target.hostId !== host.hostId || watch.generation < own.generation) continue
            own.generation = watch.generation; own.pausedByUserMessageId = watch.pausedByUserMessageId ?? null
            own.lastUserMessageId = watch.lastUserMessageId
          }
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
            // The owning host can accept a start before this desktop's copy of the thread shows its first turn. A thread
            // with an accepted start and no turn or message yet is still starting, not finished.
            if (!thread.lastTurn && (thread.summary?.messageCount ?? thread.messages.length) === 0
              && operations.some(item => item.action === 'start' && item.deliveryState === 'accepted')) return true
            return thread.status === 'running' || thread.lastTurn?.status === 'running' || Boolean(thread.requests.length || thread.backgroundWork?.length || thread.monitoring?.length)
          })
        }
        const before = this.record(), next = structuredClone(before); apply(next)
        if (digest(before) !== digest(next)) await this.options.control.updateWatcher(apply)
        for (const [target, progress] of this.remoteProgress) if (progress.hostId === host.hostId) this.remoteProgress.delete(target)
        const targets = new Set([...projection.requests.flatMap(request => request.participants.map(item => key(item.target))),
          ...(this.record().watches ?? []).filter(watch => watch.target.hostId === host.hostId).map(watch => key(watch.target))])
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
  /** The socket supplies the authenticated client, live guard and answer policy; none can be submitted as an argument. */
  async admitRemote(raw: WatcherHostControl, clientId: string, guard: () => void, mayAnswer: () => boolean = () => false): Promise<unknown> {
    this.remoteAnswers.set(clientId, mayAnswer)
    try {
      if (this.closed) refuse('NOT_CURRENT_WATCHER', 'Watcher is stopping. Nothing was sent. Reopen Sotto.')
      const packet = watcherHostControlSchema.parse(raw), { operation, request, master, call } = packet
      guard()
      this.checkRemoteMaster(master, clientId)
      if (master.target.hostId === this.hostId() || key(master.target) !== key(request.watcher)
        || operation.target.hostId !== this.hostId() || operation.requestId !== request.id || call.input.requestId !== request.id || operation.retryKey !== call.input.retryKey
        || operation.digest !== digest([call.name, call.input]) || operation.deliveryState !== 'queued'
        || operation.commandId || operation.itemId || operation.refusalCode || operation.creationUncertain || operation.promptRefunded
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
        guard()
        this.checkRemoteMaster(master, clientId)
        if (this.record().remoteAbsences?.some(item => item.operationId === operation.id)) refuse('OPERATION_NOT_RECORDED', 'An exact read fenced this unrecorded operation. Nothing was sent.')
        const existing = this.record().requests.find(item => item.id === request.id)
        if (existing && (key(existing.watcher) !== key(master.target) || existing.rootUserMessageId !== request.rootUserMessageId
          || existing.createdAt !== request.createdAt || existing.remoteOrigin?.clientId !== clientId
          || JSON.stringify(existing.remoteOrigin.master) !== JSON.stringify(master)
          || existing.remoteOrigin.creationOperationId !== master.creationOperationId || existing.remoteOrigin.ceiling !== packet.ceiling)) refuse('RETRY_KEY_CONFLICT', 'This request identity belongs to another origin. Nothing was sent.')
        const retry = this.record().operations.find(item => item.requestId === request.id && item.retryKey === operation.retryKey)
        if (retry && (retry.id !== operation.id || retry.digest !== operation.digest || retry.confirmedStop !== operation.confirmedStop || key(retry.target) !== key(operation.target))) refuse('RETRY_KEY_CONFLICT', 'This operation identity changed. Read the original receipt.')
        if (!retry) this.checkRemoteAuthority(operation, master, clientId, request.standingWatchId)
        if (!existing) await this.options.control.updateWatcher(record => { guard(); record.requests.push({ ...request, state: 'active', closedAt: null,
          participants: [], remoteOrigin: { clientId, master, creationOperationId: master.creationOperationId, ceiling: packet.ceiling } }) })
        if (!retry || this.remoteGuards.has(operation.id) && ['queued', 'dispatching', 'uncertain'].includes(retry.deliveryState)) this.remoteGuards.set(operation.id, guard)
      })
      return await this.mutate(master.target.threadId, call.name, call.input, operation, guard)
    } catch (error) { return error instanceof Refusal ? error.result : watcherRefusal('INVALID_INPUT', 'This machine request could not be admitted. Nothing was sent.') }
  }
  private checkRemoteAuthority(operation: WatcherOperation, master: WatcherIdentity, clientId: string, standingWatchId?: string): void {
    this.checkRemoteMaster(master, clientId)
    const record = this.record()
    if (operation.standingWatchId && record.watchFences?.some(fence => fence.id === operation.standingWatchId)) refuse('REQUEST_NOT_ACTIVE', 'This watch was removed. Nothing was sent.')
    const assignmentId = standingWatchId ?? (operation.action !== 'start' ? operation.standingWatchId : undefined)
    if (assignmentId && !record.watches?.some(watch => watch.id === assignmentId && key(watch.target) === key(operation.target)
      && watch.remoteOrigin?.clientId === clientId && watch.remoteOrigin.masterHostId === master.target.hostId
      && watch.remoteOrigin.masterCreationOperationId === master.creationOperationId)) refuse('REQUEST_NOT_ACTIVE', 'The owning host has no matching watch assignment. Nothing was sent.')
    if (!operation.standingWatchId && !operation.confirmedStop && record.watchFences?.some(fence => fence.target && key(fence.target) === key(operation.target)
      && fence.remoteOrigin?.clientId === clientId && fence.remoteOrigin.masterHostId === master.target.hostId)) refuse('REQUEST_NOT_ACTIVE', 'This thread was unwatched. Use a new watch assignment before continuing.')
  }
  private checkLocalWithdrawal(operation: WatcherOperation): void {
    const fences = this.record().watchFences ?? []
    if (operation.standingWatchId ? fences.some(fence => fence.id === operation.standingWatchId)
      : !operation.confirmedStop && fences.some(fence => !fence.remoteOrigin && fence.target && key(fence.target) === key(operation.target))) refuse('REQUEST_NOT_ACTIVE', 'This watch was removed. Nothing was sent.')
  }
  remoteProjection(master: WatcherIdentity, clientId: string): WatcherHostProjection {
    const record = this.record(), owned = record.requests.filter(item => key(item.watcher) === key(master.target)
      && item.remoteOrigin?.clientId === clientId && item.remoteOrigin.creationOperationId === master.creationOperationId)
    const ids = new Set(owned.map(item => item.id)), all = record.operations.filter(item => ids.has(item.requestId))
    const pending = all.filter(item => ['queued', 'dispatching', 'uncertain'].includes(item.deliveryState))
    const recentCount = Math.max(0, 1_000 - pending.length)
    const operations = [...(recentCount ? all.filter(item => !pending.includes(item)).slice(-recentCount) : []), ...pending].slice(-1_000)
    const required = new Set(operations.map(item => item.requestId)), requests = owned.filter(item => required.has(item.id)).slice(-1_000)
    const standingWatches = (record.watches ?? []).filter(watch => watch.remoteOrigin?.clientId === clientId && watch.remoteOrigin.masterHostId === master.target.hostId
      && watch.remoteOrigin.masterCreationOperationId === master.creationOperationId)
    const targetRows = new Map([...requests.flatMap(request => request.participants.map(item => [key(item.target), item.target] as const)),
      ...standingWatches.map(watch => [key(watch.target), watch.target] as const)])
    const evidence = [...targetRows.values()].flatMap(target => this.wakes.evidence.read(target, true)).slice(-1_000)
    const targets = new Set(targetRows.keys())
    const progress = this.options.control.watcherSnapshot().threads.filter(thread => targets.has(key(this.target(thread.id))))
      .map(thread => ({ target: this.target(thread.id), fingerprint: watcherProgressFingerprint(thread) })).slice(-1_000)
    // Outcomes travel only in exact operation reads, which a desktop asks for; an older desktop could not read them here.
    const projected = operations.map(withoutOutcome)
    return { hostId: this.hostId(), master, requests, operations: projected, evidence, progress, standingWatches,
      revision: digest([requests, projected, evidence, progress, standingWatches]), observedAt: now() }
  }
  private async syncRemoteWatches(master: WatcherIdentity, watches: WatcherStandingWatch[], clientId: string, guard?: () => void): Promise<void> {
    const operations = new Set<string>()
    await this.transaction(async () => {
      guard?.()
      if (master.target.hostId === this.hostId() || watches.some(watch => watch.target.hostId !== this.hostId() || watch.remoteOrigin)) refuse('INVALID_INPUT', 'The watch assignment does not match its owning host.')
      const record = this.record()
      this.checkRemoteMaster(master, clientId)
      for (const watch of watches) {
        if (record.watchFences?.some(fence => fence.id === watch.id)) refuse('REQUEST_NOT_ACTIVE', 'This watch was removed. Assign a new watch to continue.')
        this.protect(this.thread(watch.target))
        const previous = record.watches?.find(item => item.id === watch.id || key(item.target) === key(watch.target))
        if (previous && (previous.id !== watch.id || key(previous.target) !== key(watch.target) || previous.remoteOrigin?.clientId !== clientId
          || previous.remoteOrigin.masterHostId !== master.target.hostId)) refuse('THREAD_TAKEN_OVER', 'Another watch owns this thread. Nothing was changed.')
      }
      await this.options.control.updateWatcher(next => {
        guard?.()
        const retained = next.remoteMasters?.find(origin => origin.clientId === clientId && origin.masterHostId === master.target.hostId)
        if (retained) { retained.creationOperationId = master.creationOperationId; retained.createdAt = master.createdAt }
        else {
          if ((next.remoteMasters?.length ?? 0) >= 1_000) refuse('HOST_FEATURE_UNAVAILABLE', 'This host cannot retain another Watcher desktop. Use a desktop already paired here.')
          ;(next.remoteMasters ??= []).push({ clientId, masterHostId: master.target.hostId, creationOperationId: master.creationOperationId, createdAt: master.createdAt })
        }
        for (const watch of next.watches ?? []) if (watch.remoteOrigin?.clientId === clientId && watch.remoteOrigin.masterHostId === master.target.hostId
          && !watches.some(item => item.id === watch.id)) this.withdrawWatch(next, watch.target, operations)
        for (const watch of watches) {
          const previous = next.watches?.find(item => item.id === watch.id)
          const remoteOrigin = { clientId, masterHostId: master.target.hostId, masterCreationOperationId: master.creationOperationId, masterCreatedAt: master.createdAt }
          if (previous) { previous.remoteOrigin = remoteOrigin; continue }
          const thread = this.thread(watch.target), head = nativeHead(thread)
          ;(next.watches ??= []).push({ ...watch, lastUserMessageId: head,
            pausedByUserMessageId: this.humanTurnRunning(thread, next) ? head ?? 'unobserved-user-turn' : null,
            remoteOrigin })
        }
      })
    })
    if (this.options.control.hasWatcherQueue(operations)) await this.options.control.cancelWatcherQueue(operations)
    this.observe(this.options.control.watcherSnapshot(), new Set())
  }
  private checkRemoteMaster(master: WatcherIdentity, clientId: string): void {
    const record = this.record(), origins = [...(record.watches ?? []).map(watch => watch.remoteOrigin), ...(record.watchFences ?? []).map(fence => fence.remoteOrigin)]
    const retained = record.remoteMasters?.find(origin => origin.clientId === clientId && origin.masterHostId === master.target.hostId)
    if (retained && (retained.createdAt > master.createdAt || retained.createdAt === master.createdAt && retained.creationOperationId !== master.creationOperationId)) refuse('NOT_CURRENT_WATCHER', 'That Watcher conversation was replaced. Its old assignments cannot be restored.')
    if (origins.some(origin => origin?.clientId === clientId && origin.masterHostId === master.target.hostId && origin.masterCreatedAt
      && (origin.masterCreatedAt > master.createdAt || origin.masterCreatedAt === master.createdAt && origin.masterCreationOperationId !== master.creationOperationId))) refuse('NOT_CURRENT_WATCHER', 'That Watcher conversation was replaced. Its old assignments cannot be restored.')
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
  async readRemote(raw: WatcherHostRead, clientId: string, guard?: () => void, mayAnswer?: () => boolean): Promise<unknown> {
    // A read after a restart is what reconnects restored operations, so it carries the answer policy as admission does.
    if (guard && mayAnswer) this.remoteAnswers.set(clientId, mayAnswer)
    try {
      if (this.closed) refuse('NOT_CURRENT_WATCHER', 'Watcher is stopping. Reopen Sotto before reading its threads.')
      const { master, call, stoppedRequests, standingWatches, outcomes } = watcherHostReadSchema.parse(raw)
      guard?.()
      if (standingWatches) await this.syncRemoteWatches(master, standingWatches, clientId, guard)
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
      return await this.dispatchRead(call, operation, outcomes === true)
    } catch (error) { return error instanceof Refusal ? error.result : watcherRefusal('INVALID_INPUT', 'This Watcher read could not be completed.') }
  }

  /** Entry points validate caller or paired receipt ownership before reaching this shared read path. */
  private async dispatchRead(call: NonNullable<WatcherHostRead['call']>, operation?: WatcherOperation, outcomes = false, hosted?: OutcomeRead): Promise<unknown> {
    // Passes look only at watched threads, so a read that may name any thread looks at all of them first.
    this.wakes.observeAll()
    if (call.name === 'read_operation') {
      if (!operation) refuse('UNKNOWN_OPERATION', 'That operation is unavailable.')
      const base = { status: 'ok' as const, receipt: this.receipt(operation), limits: this.limits(operation), action: operation.action, state: this.operationState(operation.target) }
      // A desktop that did not ask is answered as before, since it could not read the outcome fields.
      if (!outcomes) return base
      const read = { ...base, ...hosted ?? await this.outcomeRead(operation) }
      // The reply gives way first, so the whole read stays inside the read bound.
      while (read.reply && Buffer.byteLength(JSON.stringify(read)) > WATCHER_READ_BYTES_MAX && read.reply.text) {
        const over = Buffer.byteLength(JSON.stringify(read)) - WATCHER_READ_BYTES_MAX
        read.reply = { ...read.reply, text: cutUtf8(read.reply.text, Buffer.byteLength(read.reply.text) - over - 64), truncated: true }
      }
      return read
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
    // A thread waits on the cards of the threads it delegated to as well as its own (#1190): they are its to see through.
    const delegatedCards = new Map<string, { id: string; kind: 'question' | 'permission'; openTarget: WatcherThreadTarget }[]>()
    for (const child of snapshot.threads) if (child.delegatedBy && child.requests.length) {
      const hostId = child.hostId ?? this.hostId(), parent = key({ hostId, threadId: child.delegatedBy })
      delegatedCards.set(parent, [...delegatedCards.get(parent) ?? [], ...child.requests.map(card => ({ id: card.id, kind: card.kind, openTarget: { hostId, threadId: child.id } }))])
    }
    const rows = watcherOverview({ host: snapshot }, Date.now(), this.wakes.observations).filter(row => (!input.hostId || (row.thread.hostId ?? this.hostId()) === input.hostId)
      && (!input.project || row.thread.projectId === input.project.projectId && (row.thread.hostId ?? this.hostId()) === input.project.hostId)
      && (!input.group || row.group === input.group) && (input.includeSettled || !isWorkspaceThreadSettled(row.thread, this.owningSnapshot(row.thread.hostId ?? this.hostId())?.projects.find(item => item.id === row.thread.projectId))))
      .map(row => { const thread = row.thread, target = { hostId: thread.hostId ?? this.hostId(), threadId: thread.id }
        const watch = record.watches?.find(item => key(item.target) === key(target))
        const standingWatch = watch && { id: watch.id, target: watch.target, createdAt: watch.createdAt, generation: watch.generation,
          pausedByUserMessageId: watch.pausedByUserMessageId ?? null }
        return { target, title: thread.title, projectId: thread.projectId, provider: thread.providerId ?? resolveModel(this.owningSnapshot(target.hostId)?.models ?? [], thread.modelId)?.providerId,
          ...(standingWatch ? { standingWatch } : {}),
          modelId: thread.modelId, ...(thread.reasoningEffort ? { reasoningEffort: thread.reasoningEffort } : {}), status: thread.status, group: row.group,
          waitsOn: [...thread.requests.map(item => ({ id: item.id, kind: item.kind, openTarget: target })), ...delegatedCards.get(key(target)) ?? []].slice(0, 100)
            .map(item => ({ ...item, label: item.kind === 'permission' ? 'Open to answer permission' : 'Open to answer question' })),
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
    if (input.hostId && input.hostId !== this.hostId()) this.requireRemote(input.hostId, false)
    const state = this.options.control.shell()
    const snapshots = [state.host, ...this.remote?.hosts().flatMap(host => this.owningSnapshot(host.hostId) ?? []) ?? []]
    // Read once per host: a paired host's limit reads its whole cached shell.
    const limits = new Map(snapshots.map(snapshot => [snapshot, this.permissionLimits(undefined, snapshot.hostId ?? this.hostId())]))
    const rows = snapshots.filter(snapshot => !input.hostId || (snapshot.hostId ?? this.hostId()) === input.hostId).flatMap(snapshot => snapshot.projects.filter(item => !this.reservedProject(item.path)).map(project => ({
      target: { hostId: snapshot.hostId ?? this.hostId(), projectId: project.id }, title: project.title, displayRoot: project.path,
      workers: snapshot.models.filter(model => model.ready).slice(0, 100).map(model => {
        let defaultPermission: ReturnType<WatcherService['permission']> | null = null
        try { defaultPermission = this.permission(model, undefined, limits.get(snapshot)) } catch { /* Explicitly incomparable. */ }
        return { provider: model.providerId, modelId: model.id, reasoningEfforts: model.reasoningEfforts ?? [], defaultPermission, permissionComparable: defaultPermission !== null }
      }), controlAvailable: snapshot.hostId === this.hostId() || Boolean(this.takingHost(snapshot.hostId)?.control),
      readsAvailable: snapshot.hostId === this.hostId() || Boolean(this.takingHost(snapshot.hostId)?.reads),
      readOnlyProfileAvailable: true, freshness: snapshot.connected ? 'fresh' : 'stale' })))
    const page = this.page(`projects:${input.hostId ?? ''}`, rows, input.cursor, input.limit)
    return { status: 'ok', projects: page.rows, nextCursor: page.nextCursor, observedAt: now(), staleHosts: [] }
  }
  /**
   * This computer and every host the desktop holds a connection to, each with its host facts when it reports them (#1031).
   * A host that does not list host-facts, or whose read fails, reads unknown; one not connected now reads not connected.
   * The in-flight limit is the one computer-wide limit, shown against each machine's own starts.
   */
  private async listMachines() {
    const record = this.record(), inFlightLimit = this.options.limit()
    const unknown = (note: string) => ({ factsState: 'unknown' as const, facts: null, note, runningThreads: null })
    const read = async (facts: () => Promise<HostMachineReport | undefined>, older: string) => {
      try {
        const report = await facts()
        return report ? { factsState: 'reported' as const, facts: report.facts, runningThreads: report.runningThreads } : unknown(older)
      } catch { return unknown(MACHINE_FACTS_UNREAD) }
    }
    const local = { hostId: this.hostId(), name: 'This computer', thisComputer: true, connected: true,
      ...(this.options.machineFacts ? await read(this.options.machineFacts, MACHINE_FACTS_UNREAD) : unknown(MACHINE_FACTS_UNREAD)),
      inFlight: this.inFlight(record, this.hostId()), inFlightLimit }
    const notConnected = { factsState: 'not-connected' as const, facts: null, note: MACHINE_NOT_CONNECTED, runningThreads: null }
    const stillConnected = (hostId: string) => this.remote?.hosts().some(item => item.hostId === hostId && item.connected) === true
    const remotes = await Promise.all((this.remote?.hosts() ?? []).filter(host => host.hostId !== this.hostId()).slice(0, WATCHER_MACHINES_MAX - 1).map(async host => {
      const facts = !host.connected ? notConnected
        : host.facts && this.remote?.machineFacts ? await read(() => this.remote!.machineFacts!(host.hostId), MACHINE_FACTS_OLDER) : unknown(MACHINE_FACTS_OLDER)
      // A connection that dropped while its facts were read is not connected, whatever the read came back with.
      const connected = host.connected && stillConnected(host.hostId)
      return { hostId: host.hostId, name: host.name?.trim().slice(0, 200) || 'Paired machine', thisComputer: false, connected,
        ...connected ? facts : notConnected, inFlight: this.inFlight(record, host.hostId), inFlightLimit }
    }))
    return { status: 'ok', machines: [local, ...remotes], observedAt: now() }
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
      this.revokeQueuedFreshness(record)
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
  close(): void { this.closed = true; this.handoverOffer = null; this.overtakenHandovers.clear(); this.remoteOff?.(); clearTimeout(this.remoteTimer); this.remotePending.clear(); this.remoteFailures.clear(); this.remoteGuards.clear(); this.remoteProgress.clear(); this.pendingPromptTurns.clear(); this.wakes.close(); this.unsubscribe(); this.listeners.clear(); this.confirmations.clear(); this.pages.clear(); this.copyChoices.clear() }
}
