import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { capabilitiesForThread, isThreadProviderConnected, lastUserMessageIdOf,
  type AgentCommand, type AgentDelivery, type AgentHostSnapshot, type AgentModel, type AgentRuntimeMode, type AgentThread, type HandoverCounts } from '../../shared/agents'
import { resolveModel } from '../../shared/modelCatalog'
import { capRuntimeMode, roleStartNote, startFromRole, type HeldPermission, type RoleField, type WorkerKind, type WorkerRoleChoices } from '../../shared/workerRoles'
import { nearestReasoningEffort, RUNTIME_MODE_ORDER, resolveNewThreadPermission } from '../../shared/newThreadDefaults'
import { isThreadClosed, isThreadTurnRunning, isWorkspaceThreadSettled } from '../../shared/threadActivity'
import { countWorkingThreads, workingThreadsWarning } from '../../shared/workingThreads'
import { rebuildReservations } from './watcherRecords'
import { isWatcherWorkActive, watcherOverview, type WatcherObservation } from '../../shared/watcherOverview'
import { delegatedThreadsBelow } from '../../shared/delegation'
import { WATCHER_COMPACT_AT_TOKENS, WATCHER_PARTICIPATION_HISTORY_MAX, WATCHER_PROMPTS_PER_THREAD, WATCHER_READ_BYTES_MAX, WATCHER_REPLY_BYTES_MAX, WATCHER_STATE_COMPUTED_MAX, watcherToolSchemas,
  type WatcherIdentity, type WatcherOperation, type WatcherOutcome, type WatcherRecord, type WatcherRefusal, type WatcherRequest, type WatcherThreadTarget, type WatcherStandingWatch,
  type WatcherToolInput, type WatcherToolName, type WatcherToolOutput, WATCHER_MACHINES_MAX, type WatcherKeptState,
  type WatcherMergeQueueItem, type WatcherPendingSettle, type WatcherPullRequestSummary, type WatcherStaleNote, type WatcherStateThread } from '../../shared/watcher'
import type { HostMachineReport } from '../../shared/hostFacts'
import { takesPartInActiveRequest, watcherContinueHandoverRequestSchema, watcherOpenRequestSchema, watcherSetPermissionRequestSchema, watcherWatchThreadRequestSchema, WATCHER_STOP_ALL_PREVIEW_LIMIT, WATCHER_MERGE_TURNS_KEPT, type WatcherOpenRequest, type WatcherRoomResult, type WatcherRoomState,
  type WatcherMergeTurn, type WatcherMergeTurnsRead,
  type WatcherContinueHandoverRequest, type WatcherHandoverRead, type WatcherSetPermissionRequest, type WatcherWatchThreadRequest,
  type WatcherPrepareStopAllResult, type WatcherStopAllResult } from '../../shared/watcherRoom'
import type { AgentHostCommand } from './host'
import type { AgentControl, WatcherDraft } from './control'
import type { WorkspaceHost } from './workspace'
import { WatcherWakeUp, watcherBackgroundWorkCount, watcherProgressFingerprint, type WatcherWakeOptions } from './watcherWakeUp'
import { watcherHostInput, watcherOpenPullRequests, watcherPullRequestSummaries, watcherSlimRead } from './watcherSlimReads'
import { watcherMergeQueue, watcherSettlesWhen, watcherStaleNotes, type WatcherKnownPullRequest, type WatcherOpenPullRequest } from './watcherComputedState'
import { pullRequestKey } from '../../shared/gitPullRequests'
import { WATCHER_COMPACTED_NOTE, watcherRequestLine, watcherRequestNote } from './watcherRequestNote'
import { NO_TURN_TO_STEER, queuedSendHeld, queueHold, RUNNING_TURN_HOLD } from './watcherSendHolds'
import { WatcherStateStore, watcherWaitsOn } from './watcherState'
import { compactionPending } from '../../shared/compaction'
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
import { WATCHER_FINAL_OUTCOMES, watcherBriefTurnIsNewest, watcherLatestTurnMessageId, watcherNewestTurnReply, watcherTurnOutcome } from './watcherOutcomes'
import { watcherHostControlSchema, watcherHostReadSchema, watcherHostProjectionSchema, type WatcherHostControl, type WatcherHostRead, type WatcherHostProjection, type WatcherRemoteHosts } from '../../shared/watcherHost'

const now = () => new Date().toISOString()
const MACHINE_FACTS_OLDER = 'This machine’s host does not report what kind of machine it is. Update Sotto on it to see.'
const MACHINE_FACTS_UNREAD = 'This machine’s facts could not be read just now. Nothing was changed. Ask again.'
const MACHINE_NOT_CONNECTED = 'This machine is not connected. Connect it from the Threads page to see its facts.'
const key = (target: WatcherThreadTarget) => JSON.stringify([target.hostId, target.threadId])
/** Whether two targets name the same thread: what equal keys say, without building either key. */
const sameTarget = (left: WatcherThreadTarget, right: WatcherThreadTarget) => left.hostId === right.hostId && left.threadId === right.threadId
type Participant = WatcherRecord['requests'][number]['participants'][number]
/**
 * What one Watcher record says about each of this host's threads, in record order. The record is replaced on every change
 * and never edited, so this holds for as long as the record does. Watcher's observe pass runs on every update and asks
 * this of every thread; walking the whole record for each was most of main's work with a few hundred threads (#1231).
 */
interface RecordIndex {
  readonly record: Readonly<WatcherRecord>
  readonly hostId: string | undefined
  /** Each thread's participations still taking part, across every request. */
  readonly participating: ReadonlyMap<string, readonly Participant[]>
  /** Each thread's operations. */
  readonly operations: ReadonlyMap<string, readonly WatcherOperation[]>
  /** Each thread's standing watch: the first, as a search of the record finds it. */
  readonly watches: ReadonlyMap<string, WatcherStandingWatch>
}
/** The target key of every participation and standing watch in one record, by position, for the room state. */
interface RoomKeys {
  readonly record: Readonly<WatcherRecord>
  readonly participants: readonly (readonly string[])[]
  readonly watches: readonly string[]
  /** A thread's observation key when its thread names no host, by thread ID: `JSON.stringify([null, threadId])`. */
  readonly hostless: Map<string, string>
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const nativeHead = (thread: AgentThread) => lastUserMessageIdOf(thread) ?? thread.summary?.lastUser?.id ?? null
type PromptTurn = NonNullable<WatcherRecord['promptTurns']>[number]
type TakeoverDraft = NonNullable<NonNullable<WatcherRecord['localTakeovers']>[number]['userDrafts']>[number]
type TakeoverReason = NonNullable<Participant['takeover']>['reason']
/** One owning host's threads as a look for finished threads first read them, with the threads some thread delegated from. */
interface FinishedHost { readonly snapshot: AgentHostSnapshot | undefined; readonly threads: ReadonlyMap<string, AgentThread>; readonly delegators: ReadonlySet<string>; readonly reportsWork: boolean }
/** What one look for finished threads reads once (Settle finished threads). */
interface FinishedLook {
  readonly watches: ReadonlyMap<string, WatcherStandingWatch>
  readonly busy: ReadonlySet<string>
  readonly takenOver: ReadonlySet<string>
  readonly hosts: Map<string, FinishedHost>
}
/** What Settle finished threads did with a watched thread, as stable event names. */
export type WatcherAutoSettleEvent = 'watcher-thread-auto-settled' | 'watcher-thread-auto-settle-skipped'
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
/** A participation a standing watch keeps: one still taking part, or one the user's message took before watches outlasted it. */
function keptByWatch(participant: WatcherRecord['requests'][number]['participants'][number], target: WatcherThreadTarget): boolean {
  return key(participant.target) === key(target) && !participant.automationStopped && participant.state !== 'relinquished'
}
/**
 * Moves a standing watch and every participation it keeps to one new generation, higher than any of them had, so
 * whatever was prepared before is fenced and the next send under either is admitted. Never lowers one: a lower
 * generation could let an older, fenced operation through.
 */
function alignGeneration(record: WatcherRecord, watch: WatcherStandingWatch): number {
  const participants = record.requests.flatMap(request => request.participants).filter(item => keptByWatch(item, watch.target))
  const generation = Math.max(watch.generation, ...participants.map(item => item.generation)) + 1
  watch.generation = generation
  for (const participant of participants) {
    participant.generation = generation
    if (participant.state === 'taken-over') { participant.state = 'participating'; delete participant.takeover }
  }
  return generation
}
function withoutOutcome(operation: WatcherOperation): WatcherOperation {
  const copy = { ...operation }
  for (const field of OUTCOME_FIELDS) delete copy[field]
  return copy
}
/** A request as the room hands it out: itself, or, when it names the phone that started it, a new record without it. */
function withoutPhoneOrigin(request: WatcherRequest): WatcherRequest {
  if (!('phoneOrigin' in request)) return request
  const copy = { ...request }
  delete copy.phoneOrigin
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
const UNSETTLES_KEPT = 500
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
interface CallProgress {
  operationId?: string
  /** Called once the call's operation is admitted, before it runs: a send's merge turn is remembered here (#1339). */
  admitted?: (operation: WatcherOperation) => void
}
const MUTATIONS: ReadonlySet<WatcherToolName> = new Set(['start_thread', 'send_to_thread', 'stop_thread', 'settle_thread'])
const LATE: unique symbol = Symbol('late')
function refuse(code: WatcherRefusal['code'], message: string, retryable = false): never { throw new Refusal({ ...watcherRefusal(code, message, retryable), ...(code === 'CURSOR_EXPIRED' ? { restartCursor: 'restart' } : {}) }) }

/** One main-owned admission transaction; provider work always runs after this lane is released. */
/** A message the user queued, now steered in, leaves whichever request it joined when it was queued, other than `keep`. */
function withdrawQueuedDraft(record: WatcherRecord, draftId: string, messageId: string, keep?: string): void {
  for (const request of record.requests) if (request.id !== keep && request.userFollowups?.some(item => item.draftId === draftId && item.messageId !== messageId)) {
    request.userFollowups = request.userFollowups.filter(item => item.draftId !== draftId)
  }
}
/**
 * The user's newest request to this Watcher thread, by when it began rather than by its place in the record: a request a
 * queued message started after its own had ended takes that request's place among takeovers (#1184), so it can sit
 * before it. Of two that began at the same moment, the active one.
 */
function newestUserRequest(record: Readonly<WatcherRecord>, threadId: string): WatcherRequest | undefined {
  let newest: WatcherRequest | undefined
  for (const request of record.requests) {
    if (request.watcher.threadId !== threadId || request.standingWatchId) continue
    if (!newest || request.createdAt > newest.createdAt || request.createdAt === newest.createdAt && (request.state === 'active' || newest.state !== 'active')) newest = request
  }
  return newest
}

/** A thread's linked pull requests and its branch's, each once, as a thread's links list them first. */
function threadPullRequests(thread: AgentThread): { number: number; url: string; state: 'open' | 'closed' | 'merged'; draft: boolean }[] {
  const seen = new Set<string>()
  return [...thread.pullRequests ?? [], ...thread.worktree?.git?.pullRequest ? [thread.worktree.git.pullRequest] : []].filter(pr => {
    const prKey = pullRequestKey(pr.url) ?? pr.url
    if (seen.has(prKey)) return false
    seen.add(prKey)
    return true
  })
}
const withSince = (checksPassedAt: string | undefined) => checksPassedAt === undefined ? {} : { checksPassedAt }
/** One row of read_state's pages: the watched thread, merge queue item and pending settle at the same place in each list. */
interface StatePageRow { readonly watching: (WatcherStateThread & { pullRequests: WatcherPullRequestSummary[] }) | undefined; readonly queue: WatcherMergeQueueItem | undefined; readonly settle: WatcherPendingSettle | undefined }

/**
 * A participation Watcher stopped: Watcher's own Stop of the thread, or a stopped request on a thread Watcher started.
 * It holds the thread's queue for the user's review, and the user's own command in the thread is that review (ADR-0073).
 */
const stoppedParticipation = (request: Readonly<WatcherRequest>, participant: Readonly<WatcherRequest['participants'][number]>): boolean =>
  participant.automationStopped === true || request.state === 'stopped' && participant.startedBy === 'watcher'

export class WatcherService implements WatcherControlHooks {
  readonly wakes: WatcherWakeUp
  private tail: Promise<unknown> = Promise.resolve()
  private opening: Promise<WatcherRoomResult> | undefined
  /** What `opening` is doing: an open (a first Watcher or a change of its choices) or New Watcher. */
  private openingKind: 'open' | 'new' | undefined
  private recoveryNotice: string | null = null
  private readonly listeners = new Set<(state: WatcherRoomState) => void>()
  /**
   * The sends Watcher marked as giving a thread its merge turn (#1339), oldest first, for Watcher's picture. In memory
   * only: the saved record keeps no new key, since a build that cannot read it loses the whole file, and a restart
   * forgets them until history is kept (#1340).
   */
  private readonly mergeTurns: WatcherMergeTurn[] = []
  /**
   * The watched rows of the room last published, as they were built for it: the picture's merge read takes the threads
   * Watcher watches from here, rather than walking the record's requests again (#1339). Read only, never copied.
   */
  private publishedWatched: WatcherRoomState['watchedThreads'] | undefined
  private readonly active = new Map<string, Promise<unknown>>()
  private invocations = 0
  /** What Watcher keeps through compaction (#1189), and whether a compaction since it last read it owes it a note. */
  private readonly kept: WatcherStateStore
  private stateOwed = false
  private seenCompaction: string | null = null
  /**
   * The Watcher thread the last look was at, and its context then: the thread's model and the reading's time, with no
   * tokens just after a model change until a reading newer than the one at the change.
   */
  private seenFor: string | undefined
  private lastTokens: { tokens: number | null; modelId: string | undefined; at: string | undefined } | undefined
  /**
   * Sotto's sends to Watcher's thread this run, and their count at the last compaction tried or seen: none again until
   * Sotto sends Watcher another message. Counted here rather than read from the provider's turns, since a provider may
   * report the compaction as a turn of its own, before or after it reports the compaction finished.
   */
  private sendsToWatcher = 0
  private compactTried: number | undefined
  private compactingNow = false
  private changing = false
  private readonly dispatchRefusals = new Map<string, Refusal>()
  private readonly nativeHeads = new Map<string, string | null>()
  /** What the record says per thread on this host, for the record it was worked out from (`recordIndex`). */
  private indexed: RecordIndex | undefined
  /** The room's target keys, for the record they were built from (`roomKeys`). */
  private roomKeyed: RoomKeys | undefined
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
  private readonly pendingPromptTurns = new Map<string, { watcher: WatcherThreadTarget; messageId: string; headBefore: string | null }>()
  /**
   * What this run last sent Watcher's thread, Sotto's wake-up or the user's message: whose turn runs, before every provider
   * has echoed it (#1188). `headAtSend` is the thread's newest user message before it was sent, so a newer one, from
   * anywhere, is seen to have taken its place.
   */
  private lastSend: { readonly threadId: string; readonly wakeUp: boolean; readonly messageId: string; readonly headAtSend: string | null } | undefined
  /**
   * The request the user's last steer into Watcher's running turn opened, with the thread's newest message before it, so
   * Watcher may act on it before the provider shows the steer, a restart in the middle of the turn included (#1188).
   */
  private lastSteer: { readonly threadId: string; readonly requestId: string; readonly messageId: string; readonly headBefore: string | null } | undefined
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
  /**
   * Settle finished threads: the turn each watched thread was last settled or tried at, so one that is refused is not
   * tried again until it has worked again; the wait before the next look; and whether a look is under way.
   */
  private readonly settleTried = new Map<string, string>()
  /**
   * unsettle_thread's answered calls, by request and retry key, to the target each restored: a retry answers as the first
   * did and restores nothing again, even after the thread was settled once more. Kept in memory, the newest UNSETTLES_KEPT.
   */
  private readonly unsettles = new Map<string, string>()
  private settleTimer: ReturnType<typeof setTimeout> | undefined
  private settlingFinished = false
  private readonly unsubscribe: () => void
  constructor(private readonly options: { directory: string; control: AgentControl; host: WorkspaceHost;
    historyEnabled: () => boolean; workerHost?: boolean; streamingPublishCost?: boolean; revoke?: (id: string) => void
    /**
     * The user's worker roles, present only while that Owl feature is on (#1041). Read once per start that names a role,
     * when it is asked, never on publish or observe.
     */
    roles?: () => WorkerRoleChoices
    /** This computer's host facts and running threads, read as a host reads its own (#1031). Without it they read unknown. */
    machineFacts?: () => Promise<HostMachineReport>
    /** The ordinary news batch's timing (WatcherWakeOptions), for tests on the real clock; the default is #1190's. */
    ordinaryBatch?: WatcherWakeOptions['ordinaryBatch']
    /**
     * Settle finished threads (`watcherSettlesFinishedThreads`), read at every look; absent, Watcher settles nothing by
     * itself. `settleFinishedAfterMs` is the most often it looks, one second unless a test says otherwise.
     */
    settleFinished?: () => boolean
    settleFinishedAfterMs?: number
    /** What Settle finished threads did, as stable event names; never a thread, a title or a pull request. */
    log?: (event: WatcherAutoSettleEvent) => void }) {
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
    this.kept = new WatcherStateStore(options.directory, options.historyEnabled)
    // The coordinator publishes from its own timers too, so this listener refuses nothing: while this computer has no host
    // ID, as while Sotto starts, none of its threads can be named, and the publish that brings the ID runs every step here.
    const unhook = options.control.useWatcher(this), unsubscribe = options.control.subscribe(() => {
      if (!options.control.hostId()) return
      this.endFinishedPauses(); this.closeAnsweredRequests(); this.compactWhenDue(); this.publish()
    })
    this.unsubscribe = () => { unhook(); unsubscribe() }
  }
  /**
   * Compacts Watcher's conversation once it passes WATCHER_COMPACT_AT_TOKENS (#1189), when Watcher rests: no turn, no card,
   * no compaction, nothing queued for it. Every Watcher call rereads its whole conversation, so its cost grows with it.
   * One try per message Sotto sends Watcher, so a compaction that fails, or leaves the context high until Watcher's next
   * turn reports it, is tried again only after that turn. A compaction that finished, this one or the user's, owes Watcher its state: the
   * note of its next turn says to read it.
   */
  private compactWhenDue(): void {
    if (this.closed) return
    const seen = this.lookAtState()
    if (!seen) return
    const { snapshot, thread, tokens } = seen
    if (tokens === null || tokens <= WATCHER_COMPACT_AT_TOKENS || this.compactingNow || this.changing || !this.canCompact(snapshot, thread)) return
    if (thread.status === 'running' || thread.requests.length || compactionPending(thread.compaction) || thread.nativeSessionStarted === false
      || this.options.control.watcherWakeUpQueued() || this.options.control.hasPendingThreadWork(thread.id)) return
    if (this.compactTried === this.sendsToWatcher) return
    this.compactTried = this.sendsToWatcher; this.compactingNow = true
    void this.options.control.command({ type: 'compact-thread', threadId: thread.id }).catch(() => undefined).finally(() => { this.compactingNow = false })
  }
  /**
   * Brings stateOwed up to date with Watcher's thread as it is now, so a send or a wake-up before the next snapshot tick
   * carries the reminder too, and returns that thread.
   */
  private lookAtState(): { snapshot: AgentHostSnapshot; thread: AgentThread; tokens: number | null } | undefined {
    const current = this.view().current
    const snapshot = current ? this.options.control.watcherSnapshot() : undefined
    const thread = current && snapshot?.threads.find(item => item.id === current.target.threadId)
    if (!thread || !snapshot) return undefined
    const done = thread.compaction?.status === 'completed' ? thread.compaction.commandId : null, tokens = this.contextTokens(thread)
    if (this.seenFor !== thread.id) {
      // A new Watcher conversation starts from its state, and so does every start of Sotto, since a compaction may have
      // come before it that Watcher has not read its state since, and the reminder is not saved: one small call.
      this.stateOwed = true
      this.seenFor = thread.id; this.seenCompaction = done; this.lastTokens = undefined; this.compactTried = undefined
    } else if (done !== null && done !== this.seenCompaction) { this.stateOwed = true; this.seenCompaction = done; this.compactTried = this.sendsToWatcher }
    // A sharp drop in context is a compaction too: Muse reports no compaction of its own, and a provider may compact by
    // itself. Only readings for one model count, since another model's context is another conversation's size, and the
    // reading at a model change may still be the old model's, as with a provider that names no model for it: after a
    // change, only a reading with a time of its own, newer than the one at the change, starts the comparison again.
    const last = this.lastTokens, modelId = thread.modelId, at = thread.usage?.contextUpdatedAt
    if (last && last.modelId !== modelId) this.lastTokens = { tokens: null, modelId, at }
    else if (tokens !== null && !(last?.tokens === null && (at === undefined || at === last.at))) {
      if (last?.tokens != null && last.tokens >= 50_000 && tokens < last.tokens / 2) { this.stateOwed = true; this.compactTried = this.sendsToWatcher }
      this.lastTokens = { tokens, modelId, at }
    }
    return { snapshot, thread, tokens }
  }
  /** Watcher's context in tokens as its provider last reported it for its current model, or null. */
  private contextTokens(thread: AgentThread): number | null {
    const usage = thread.usage
    return usage?.contextUsed !== undefined && (usage.modelId === undefined || usage.modelId === thread.modelId) ? usage.contextUsed : null
  }
  private canCompact(snapshot: AgentHostSnapshot, thread: AgentThread): boolean {
    return capabilitiesForThread(snapshot, thread).compact === true && thread.manualCompactionSupported !== false
  }
  /** The line a Watcher turn's note carries after a compaction, until Watcher reads its state back (#1189). */
  stateNote(): string | undefined { this.lookAtState(); return this.stateOwed ? WATCHER_COMPACTED_NOTE : undefined }
  privacyChanged(): Promise<void> { return this.kept.privacyChanged() }
  private record(): WatcherRecord { return this.options.control.watcherRecord() }
  /** The record for reading only. It is replaced on every change, never edited, so no copy is needed to look at it. */
  private view(): Readonly<WatcherRecord> { return this.options.control.watcherRecordView() }
  /** What `record` says per thread on this host, worked out once per record (RecordIndex). */
  private recordIndex(record: Readonly<WatcherRecord>): RecordIndex {
    const connected = this.options.control.hostId() ?? undefined
    if (this.indexed?.record === record && this.indexed.hostId === connected) return this.indexed
    // A record with nothing in it says nothing per thread, and needs no host to say so; otherwise a missing host refuses.
    const hostId = record.operations.length || record.watches?.length || record.requests.some(request => request.participants.length) ? this.hostId() : connected
    const participating = new Map<string, Participant[]>(), operations = new Map<string, WatcherOperation[]>()
    const watches = new Map<string, WatcherStandingWatch>()
    const add = <T>(map: Map<string, T[]>, threadId: string, item: T) => { const list = map.get(threadId); if (list) list.push(item); else map.set(threadId, [item]) }
    for (const request of record.requests) for (const participant of request.participants)
      if (participant.target.hostId === hostId && participant.state === 'participating') add(participating, participant.target.threadId, participant)
    for (const operation of record.operations) if (operation.target.hostId === hostId) add(operations, operation.target.threadId, operation)
    for (const watch of record.watches ?? []) if (watch.target.hostId === hostId && !watches.has(watch.target.threadId)) watches.set(watch.target.threadId, watch)
    return this.indexed = { record, hostId, participating, operations, watches }
  }
  /** The target keys the room state needs of `record`, built once per record (RoomKeys). */
  private roomKeys(record: Readonly<WatcherRecord>): RoomKeys {
    if (this.roomKeyed?.record === record) return this.roomKeyed
    return this.roomKeyed = { record, participants: record.requests.map(request => request.participants.map(item => key(item.target))),
      watches: (record.watches ?? []).map(watch => key(watch.target)), hostless: new Map() }
  }
  private hostId(): string { const id = this.options.control.hostId(); if (!id) refuse('HOST_DISCONNECTED', 'This computer is not ready. Reconnect its provider.', true); return id }
  private target(threadId: string): WatcherThreadTarget { return { hostId: this.hostId(), threadId } }
  phoneSnapshot(): AgentHostSnapshot { return this.snapshot() }
  private owningSnapshot(hostId: string): AgentHostSnapshot | undefined {
    return hostId === this.hostId() ? this.options.control.watcherSnapshot() : this.remote?.snapshot(hostId)
  }
  /**
   * Every host's threads as one snapshot. The news timers read it, so a moment without this computer's host ID, as while
   * Sotto starts, gives this computer's threads without one rather than refusing: the news pass skips them until it is back.
   */
  private snapshot() {
    const local = this.options.control.watcherSnapshot(), localId = this.options.control.hostId()
    const others = this.remote?.hosts().flatMap(host => (localId !== undefined && host.hostId === localId ? local : this.remote!.snapshot(host.hostId)) ?? []) ?? []
    return { ...local, connected: local.connected || others.some(host => host.connected),
      clientHosts: [local, ...others].flatMap(host => { const hostId = host.hostId ?? localId
        return hostId ? [{ hostId, connected: host.connected, models: host.models, capabilities: host.capabilities, providers: host.providers }] : [] }),
      threads: [local, ...others].flatMap(host => host.threads.map(thread => ({ ...thread, clientConnected: host.connected && isThreadProviderConnected(host, thread) }))),
      projects: [...local.projects, ...others.flatMap(host => host.projects.map(project => ({ ...project, hostId: host.hostId })))] }
  }
  useRemoteHosts(remote: WatcherRemoteHosts): void {
    this.remoteOff?.(); this.remote = remote
    this.remoteOff = remote.subscribe((hostId, force = true) => this.scheduleRemote(hostId, force))
    void this.reconcileRemote().catch(() => undefined)
  }
  /**
   * unsettle_thread (October 23, 2026): a settled thread on this computer back to active, as Restore does, a settled project
   * returning with it alone, under the user's own active request, never a standing watch's. Its watch stays as it is. It
   * keeps no operation: a retry answers from memory and restores nothing more, and the record, the phone and paired hosts
   * see no new action. A paired host's thread is refused: the only way there now is
   * the user's own Restore, which that host would read as a takeover.
   */
  private async unsettleThread(callerThreadId: string, input: WatcherToolInput<'unsettle_thread'>): Promise<WatcherToolOutput<'unsettle_thread'>> {
    const target = input.target, retry = `${input.requestId}\0${input.retryKey}`, earlier = this.unsettles.get(retry)
    if (earlier) {
      if (earlier !== key(target)) refuse('RETRY_KEY_CONFLICT', 'This retry key already belongs to a different call. Nothing was changed.')
      return { status: 'ok', target, settled: false }
    }
    // Read in place: an admission that only reads copies nothing, whatever the size of Watcher's history.
    const allowed = (): void => {
      const record = this.view(), request = record.requests.find(item => item.id === input.requestId)
      // The user's own request, still active: a standing watch's continuation is never one, nor is a stopped request.
      if (!request || request.standingWatchId || request.state !== 'active' || request.watcher.threadId !== callerThreadId || request.watcher.hostId !== this.hostId()) {
        refuse('REQUEST_NOT_ACTIVE', 'This request is not active. Only a user Send to Watcher can start a request.')
      }
      if (record.userUnwatches?.some(item => key(item.target) === key(target))) refuse('REQUEST_NOT_ACTIVE', 'The user stopped Watcher watching this thread. Nothing was changed.')
      const participant = request.participants.find(item => key(item.target) === key(target))
      if (participant?.state === 'taken-over') refuse('THREAD_TAKEN_OVER', 'You took over this thread. Watcher stopped sending to it.')
      if (participant?.automationStopped || participant?.state === 'relinquished') refuse('REQUEST_NOT_ACTIVE', 'Watcher stopped working with this thread for this request. Nothing was changed.')
    }
    allowed()
    if (target.hostId !== this.hostId()) refuse('HOST_FEATURE_UNAVAILABLE', 'Watcher restores only this computer’s threads. Ask the user to restore it from Settled. Nothing was changed.')
    const thread = this.thread(target)
    // A thread with a special job, or an archived one, is not Watcher's to restore, as it is not Watcher's to settle.
    this.protect(thread)
    if (isWorkspaceThreadSettled(thread, this.options.control.watcherSnapshot().projects.find(project => project.id === thread.projectId))) {
      if (!this.options.host.reopenThreadForWork) refuse('PROVIDER_UNAVAILABLE', 'Sotto cannot restore threads here. Nothing was changed.')
      // Asked again inside the workspace's lane, so a Stop or a takeover while the restore waited for it holds it back.
      try { await this.options.host.reopenThreadForWork(target.threadId, allowed) }
      catch (error) { if (error instanceof Refusal) throw error; refuse('PROVIDER_UNAVAILABLE', 'Sotto could not save the thread as restored. It is still settled. Try again.', true) }
    }
    this.unsettles.set(retry, key(target))
    if (this.unsettles.size > UNSETTLES_KEPT) this.unsettles.delete(this.unsettles.keys().next().value!)
    return { status: 'ok', target, settled: false }
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
  /** A setting was saved: Settle finished threads looks now, not at the next update. */
  settingsChanged(): void { this.lookForFinished() }
  /**
   * Settle finished threads: at most once a second while updates come, a look for a watched thread whose work is done.
   * Each look reads the setting, so turning it off stops the next one and turning it on settles what already qualifies.
   */
  private lookForFinished(): void {
    if (this.closed || this.options.workerHost || this.settleTimer !== undefined || this.options.settleFinished?.() !== true) return
    this.settleTimer = setTimeout(() => { this.settleTimer = undefined; void this.settleFinished() }, this.options.settleFinishedAfterMs ?? 1_000)
    this.settleTimer.unref?.()
  }
  private async settleFinished(): Promise<void> {
    if (this.settlingFinished || this.closed || this.options.settleFinished?.() !== true || !this.view().watches?.length || !this.watcherAtRest()) return
    this.settlingFinished = true
    try {
      const look = this.finishedLook()
      const finished = [...look.watches.values()].flatMap(watch => {
        const turnId = this.finishedWork(watch.target, look)
        return turnId === undefined || this.settleTried.get(key(watch.target)) === turnId ? [] : [{ target: watch.target, turnId }]
      })
      for (const { target, turnId } of finished) {
        if (this.closed || this.options.settleFinished?.() !== true || !this.watcherAtRest()) return
        // Once per turn: a refusal waits for the thread to work again rather than being asked again on every update.
        this.settleTried.set(key(target), turnId)
        try {
          await this.settleWatched(target, turnId)
          this.options.log?.('watcher-thread-auto-settled')
        } catch { this.options.log?.('watcher-thread-auto-settle-skipped') }
      }
    } finally { this.settlingFinished = false }
  }
  /**
   * Whether Watcher has nothing under way: no turn running or about to, no card of its own, and nothing queued for it,
   * news included. A thread's news is told in Watcher's next turn, which has to end before the thread is settled.
   */
  private watcherAtRest(): boolean {
    const current = this.view().current
    if (this.changing || !current || current.target.hostId !== this.options.control.hostId()) return false
    const watcher = this.options.control.watcherSnapshot().threads.find(thread => thread.id === current.target.threadId)
    if (!watcher || watcher.status === 'running' || watcher.lastTurn?.status === 'running' || watcher.requests.length) return false
    if (this.options.control.watcherWakeUpQueued() || this.options.control.hasPendingThreadWork(watcher.id)) return false
    // A message sent that its provider has yet to show is a turn about to run.
    const sent = this.currentSend(watcher.id)
    return !sent || nativeHead(watcher) === sent.messageId
  }
  /**
   * What one look for finished threads reads once, whatever the number of watches: the watches, the targets a Watcher
   * start or send is still on its way to or the user took over, and each owning host's threads as the look first asks.
   */
  private finishedLook(): FinishedLook {
    const record = this.view(), busy = new Set<string>(), takenOver = new Set<string>()
    for (const operation of record.operations) if (operation.deliveryState === 'queued' || operation.deliveryState === 'dispatching' || operation.deliveryState === 'uncertain') busy.add(key(operation.target))
    for (const request of record.requests) if (request.state === 'active') for (const item of request.participants) if (item.state === 'taken-over') takenOver.add(key(item.target))
    return { watches: new Map((record.watches ?? []).map(watch => [key(watch.target), watch])), busy, takenOver, hosts: new Map() }
  }
  private lookAtHost(look: FinishedLook, hostId: string): FinishedHost {
    let host = look.hosts.get(hostId)
    if (!host) {
      const snapshot = this.owningSnapshot(hostId), threads = new Map<string, AgentThread>(), delegators = new Set<string>()
      for (const thread of snapshot?.threads ?? []) { threads.set(thread.id, thread); if (thread.delegatedBy) delegators.add(thread.delegatedBy) }
      // A host that does not report background work leaves it unknown, and unknown work is not none.
      host = { snapshot, threads, delegators, reportsWork: hostId === this.options.control.hostId() || this.remote?.hosts().find(item => item.hostId === hostId)?.workSettled === true }
      look.hosts.set(hostId, host)
    }
    return host
  }
  /**
   * The turn a watched thread finished all its work with, or undefined while it has not: its last turn completed, nothing
   * runs and no work is unknown, no card waits on the user, nothing is queued for it or on its way from Watcher, the user is
   * not in the middle of a turn there and has not taken it over, every pull request it has is merged or closed, the same
   * holds for every thread it delegated to, and Watcher has heard all of it. `letGo` asks again of a paired host's thread
   * Watcher has just stopped watching, whose news is no longer Watcher's.
   */
  private finishedWork(target: WatcherThreadTarget, look: FinishedLook, letGo = false): string | undefined {
    const hold = this.settleHold(target, look, letGo)
    return hold && !hold.pullRequests.length && (letGo || !hold.unheard) ? hold.turnId : undefined
  }
  /**
   * A watched thread whose work is done but for its pull requests and Watcher hearing of it: the turn it finished with, the
   * open pull requests of it and the threads it delegated to, and whether Watcher has yet to hear all its news. Undefined
   * while anything else is unfinished. read_state says the same of each such thread, as a pending settle (#1274).
   */
  private settleHold(target: WatcherThreadTarget, look: FinishedLook, letGo = false): { turnId: string; pullRequests: string[]; unheard: boolean } | undefined {
    const watch = look.watches.get(key(target))
    if (!letGo && (!watch || watch.remoteOrigin || watch.pausedByUserMessageId)) return undefined
    const local = target.hostId === this.options.control.hostId()
    if (!local && !this.remote?.settle) return undefined
    const host = this.lookAtHost(look, target.hostId), snapshot = host.snapshot, thread = host.threads.get(target.threadId), turn = thread?.lastTurn
    if (!snapshot?.connected || !host.reportsWork || !thread || !turn || turn.status !== 'completed' || thread.status !== 'idle') return undefined
    const quiet = (item: AgentThread) => !item.requests.length && !isWatcherWorkActive(item) && watcherBackgroundWorkCount(item) === 0
    const open = (item: AgentThread) => [...(item.pullRequests ?? []).filter(pr => pr.state === 'open').map(pr => pr.url),
      ...item.worktree?.git?.pullRequest?.state === 'open' ? [item.worktree.git.pullRequest.url] : [],
      // One it babysits is unfinished until babysitting ends, linked or not, and a settle would end it (ADR-0061 decision 9).
      ...(item.babysitting ?? []).map(pr => pr.url)]
    if (!quiet(thread) || !this.connected(thread) || this.protectedThread(thread) || isThreadClosed(thread)
      || isWorkspaceThreadSettled(thread, snapshot.projects.find(project => project.id === thread.projectId))) return undefined
    // Nothing on its way to it: queued here, or a Watcher start or send, and the user has not taken it over.
    const clear = (id: string) => !(local && this.options.control.hasPendingThreadWork(id)) && !look.busy.has(key({ hostId: target.hostId, threadId: id }))
      && !look.takenOver.has(key({ hostId: target.hostId, threadId: id }))
    if (!clear(thread.id)) return undefined
    // Work it delegated (ADR-0081) is its work too, and settles with it.
    const delegated = host.delegators.has(thread.id) ? delegatedThreadsBelow(snapshot.threads, thread.id).flatMap(id => host.threads.get(id) ?? []) : []
    if (delegated.some(item => !quiet(item) || !clear(item.id))) return undefined
    const pullRequests = [...new Map([thread, ...delegated].flatMap(open).map(url => [pullRequestKey(url) ?? url, url])).values()]
    // Asked only once nothing else holds it, as the settle itself asks.
    return { turnId: turn.id, pullRequests, unheard: !letGo && !pullRequests.length && !this.wakes.heardAllOf(target, turn.id) }
  }
  /**
   * Settles a finished watched thread and stops watching it, quietly: no notice, no news, and not the user's own settle,
   * so nothing reads it as a takeover. This computer's thread is settled first, checked again as it is written, so a
   * thread just given more work keeps its watch. A paired host's thread is let go first, so its host does not take the
   * settle for the user's, asked again as it now stands, then settled the way the user settles it from here; one that
   * changed meanwhile, or that its host does not settle, is watched again.
   */
  private async settleWatched(target: WatcherThreadTarget, turnId: string): Promise<void> {
    const unwatch = async () => {
      const result = await this.unwatchThread({ target }, undefined, 'watcher')
      if (result.status !== 'ok') throw new Error('unwatch-refused')
    }
    const still = (letGo = false) => !this.closed && this.options.settleFinished?.() === true && this.watcherAtRest() && this.finishedWork(target, this.finishedLook(), letGo) === turnId
    if (target.hostId === this.options.control.hostId()) {
      await this.options.host.setWorkspaceSettled('thread', target.threadId, true, undefined, () => { if (!still()) throw new Error('changed') })
      await unwatch()
      return
    }
    await unwatch()
    try {
      if (!still(true)) throw new Error('changed')
      await this.remote!.settle!(target.hostId, target.threadId)
    } catch (error) {
      await this.assignWatch({ target }, undefined, 'watcher').catch(() => undefined)
      throw error
    }
  }
  private publish(observe = true): void {
    // The room names this computer's threads by its host ID. Without one there is no room to tell, and nothing to refuse
    // to the news timers and catch handlers that publish: the coordinator's publish once the ID is back tells it.
    if (this.closed || !this.options.control.hostId()) return
    this.lookForFinished()
    // A pass put off while threads stream publishes again once it has run, without asking for another.
    if (observe && !this.options.workerHost) this.wakes.observeSoon(() => this.publish(false))
    this.options.control.refreshWatcherObservation()
    // One room state for every listener: each only reads it, and the window's room copies what it keeps.
    let state: WatcherRoomState | undefined
    for (const listener of this.listeners) listener(state ??= this.state())
    if (state) this.publishedWatched = state.watchedThreads
  }
  /**
   * This computer's threads Watcher needs observed, which the coordinator asks whenever it observes. Without a host ID none
   * can be named, so none are asked for; the coordinator asks again on Watcher's publish once the ID is back.
   */
  watchedThreadIds(): string[] {
    const record = this.view(), hostId = this.options.control.hostId()
    if (!hostId) return []
    return [...new Set([...this.wakes.watchedThreadIds(hostId).filter(id => this.options.control.watcherSnapshot().threads.some(thread => thread.id === id)),
      ...(record.watches ?? []).filter(watch => watch.target.hostId === hostId).map(watch => watch.target.threadId),
      ...record.requests.filter(request => request.remoteOrigin && request.state === 'active').flatMap(request => request.participants.filter(item => item.target.hostId === hostId && item.state === 'participating' && !item.automationStopped).map(item => item.target.threadId))])]
  }
  /**
   * Whether Watcher watches this thread, on this computer or a paired host: it is under a standing watch, or takes part in
   * an active Watcher request, as the glossary's **Watched thread** says. Desktop notifications ask it: Watcher keeps a
   * watched thread going and brings its questions and permissions, so that thread's finish is not the last word and it is
   * never told as finished (ADR-0117).
   */
  watches(target: WatcherThreadTarget): boolean {
    const wanted = key(target), record = this.view()
    return (record.watches ?? []).some(watch => key(watch.target) === wanted)
      || record.requests.some(request => request.state === 'active'
        && request.participants.some(part => part.state === 'participating' && part.automationStopped !== true && key(part.target) === wanted))
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
      return watcherReplyStart(thread, event.turnId, watcherNewestTurnReply(thread), event.operationId !== undefined)
    }
  }
  /** How long each held finish in a wake-up's news was held, in minutes, when it went by itself with its thread idle (#1263). */
  newsHeld(): (event: WatcherEvent) => number | undefined { return event => this.wakes.heldMinutes(event) }
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
      : 'Watcher cannot give a thread more permission than your new-thread default. Nothing was sent or started. To give it more, widen New threads start with in Settings → Threads first.')
    // A model without an asking mode fits the hold-back to its nearest mode, which skips asking: a grant the host withheld.
    if (ceiling.by === 'paired-host' && RUNTIME_MODE_ORDER.indexOf(ceiling.runtimeMode) > RUNTIME_MODE_ORDER.indexOf(ceiling.limit)) tooWide()
    if (RUNTIME_MODE_ORDER.indexOf(mode) > RUNTIME_MODE_ORDER.indexOf(ceiling.runtimeMode)) tooWide()
    return { kind: 'runtime' as const, mode }
  }
  /** A thread a start made, checked again before its first prompt goes. A send checks nothing here: it gives no permission. */
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
    // A provider may report the thread idle before its turn's completion arrives.
    if (isThreadTurnRunning(thread)) refuse('THREAD_BUSY', 'Wait for this thread to finish before settling it.')
    // Sub-agents still working, or not yet known to have ended, count as Settle finished threads counts them.
    if (watcherBackgroundWorkCount(thread) > 0) refuse('BACKGROUND_WORK_RUNNING', 'This thread still has background work. Stop it explicitly before settling.')
    // The threads it delegated to settle with it (ADR-0081), so their work holds it too.
    const threads = this.owningSnapshot(thread.hostId ?? this.hostId())?.threads ?? []
    if (threads.some(item => item.delegatedBy) && delegatedThreadsBelow(threads, thread.id).some(id => {
      const below = threads.find(item => item.id === id)
      return below !== undefined && (isThreadTurnRunning(below) || below.requests.length > 0 || watcherBackgroundWorkCount(below) > 0)
    })) refuse('BACKGROUND_WORK_RUNNING', 'A thread this one delegated to is still working or waits on the user. Wait for it before settling.')
  }
  /**
   * Watcher's starts still working, on every machine: the count the phone's page and sends carry where host protocol
   * version 1 has one. Nothing is held back at any number (#1183).
   */
  startsInFlight(): number { return this.inFlight() }
  /** One pass over the operations whatever the number of reservations: the phone's page asks on every build. */
  private inFlight(record: Readonly<WatcherRecord> = this.view()): number {
    if (record.reservations.length === 0) return 0
    const reserved = new Map(record.reservations.map(item => [item.operationId, key(item.target)]))
    const targets = new Set<string>()
    for (const operation of record.operations) {
      const target = operation.action === 'start' ? reserved.get(operation.id) : undefined
      if (target !== undefined) targets.add(target)
    }
    return targets.size
  }
  /** The working threads warning (#1183) after a start on this computer, counting the new thread as working: only above ten. */
  private workingWarning(threadId: string): { warning: string } | Record<string, never> {
    const warning = workingThreadsWarning(countWorkingThreads(this.options.control.watcherSnapshot().threads, threadId))
    return warning ? { warning } : {}
  }
  private limits(operation: WatcherOperation) {
    const record = this.record()
    return { promptCount: Math.min(WATCHER_PROMPTS_PER_THREAD,
      this.promptCount(record, operation.target, operation.promptTurnId, operation.requestId)), promptLimit: WATCHER_PROMPTS_PER_THREAD }
  }
  private promptCount(record: WatcherRecord, target: WatcherThreadTarget, promptTurnId: string | undefined, requestId: string): number {
    return promptTurnId ? record.operations.filter(operation => operation.promptTurnId === promptTurnId && key(operation.target) === key(target)
      && (operation.action === 'start' || operation.action === 'send') && !operation.promptRefunded).length
      : record.requests.find(request => request.id === requestId)?.participants.find(participant => key(participant.target) === key(target))?.promptCount ?? 0
  }
  /** `observedThread` is Watcher's thread as the caller already read it; without it, the thread is read from its owning host. */
  private promptTurn(record: WatcherRecord, watcher: WatcherThreadTarget, importedId?: string, observedThread?: AgentThread): PromptTurn {
    if (importedId) {
      const retained = record.promptTurns?.find(turn => turn.id === importedId)
      if (retained) { if (key(retained.watcher) !== key(watcher)) refuse('RETRY_KEY_CONFLICT', 'This turn budget belongs to another Watcher. Nothing was sent.'); return retained }
      const created: PromptTurn = { id: importedId, watcher, createdAt: now() }; (record.promptTurns ??= []).push(created); return created
    }
    const thread = observedThread ?? this.thread(watcher), nativeTurnId = thread.lastTurn?.id
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
  /**
   * Whether `promptTurn` would leave the record as it is: the Watcher's latest turn exists and already names its native
   * turn, as `thread`, the Watcher thread the caller read, has it.
   */
  private promptTurnCurrent(record: Readonly<WatcherRecord>, watcher: WatcherThreadTarget, thread: AgentThread): boolean {
    const latest = record.promptTurns?.findLast(turn => key(turn.watcher) === key(watcher))
    if (!latest) return false
    const nativeTurnId = thread.lastTurn?.id
    return !nativeTurnId || nativeTurnId === latest.previousNativeTurnId || nativeTurnId === latest.nativeTurnId
  }
  private beginPromptTurn(record: WatcherRecord, watcher: WatcherThreadTarget, messageId: string, observedThread?: AgentThread): void {
    if (record.promptTurns?.some(turn => key(turn.watcher) === key(watcher) && turn.rootUserMessageId === messageId)) return
    const previous = this.promptTurn(record, watcher, undefined, observedThread)
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
    // The room hands out the record's own records rather than copies (#1327). Every change replaces the record instead of
    // editing it (AgentControl.watcherRecordView), and every reader of the room only reads it: the window and a phone are
    // sent a serialized copy, and the desktop room copies what it keeps for its publish window. This runs on every
    // publish and for every phone on every update, and the records it copied here grow with every request Watcher has had.
    const live = this.view(), { localTakeovers: _localTakeovers, ...view } = live; void _localTakeovers
    // Which phone started a request is main's alone, for its own checks: no window or phone is sent a phone's client ID.
    // Only a request that names one is handed out as a new record without it; the record keeps it.
    const record = { ...view, requests: view.requests.map(withoutPhoneOrigin) }
    const current = this.options.control.watcherSnapshot().threads.find(item => item.id === record.current?.target.threadId)
    // Every target the record names, with its standing watch and every participation, gathered in one walk of the record by
    // keys built once per record. A walk of every request for each target, building both keys each time, was most of what
    // a publish cost once the record held a few hundred participations (#1231).
    const keys = this.roomKeys(live), watches = record.watches ?? []
    const targets = new Map<string, WatcherThreadTarget>(), participations = new Map<string, Participant[]>(), watchOf = new Map<string, WatcherStandingWatch>()
    record.requests.forEach((request, position) => request.participants.forEach((item, at) => {
      const targetKey = keys.participants[position]![at]!
      targets.set(targetKey, item.target)
      const list = participations.get(targetKey)
      if (list) list.push(item); else participations.set(targetKey, [item])
    }))
    watches.forEach((watch, position) => {
      const targetKey = keys.watches[position]!
      targets.set(targetKey, watch.target)
      if (!watchOf.has(targetKey)) watchOf.set(targetKey, watch)
    })
    const roomInputs = this.options.streamingPublishCost === true && this.remote?.roomThreads ? new Map<string, ReturnType<NonNullable<WatcherRemoteHosts['roomThreads']>>>() : undefined
    if (roomInputs) for (const target of targets.values()) {
      if (target.hostId === this.hostId() || roomInputs.has(target.hostId)) continue
      roomInputs.set(target.hostId, this.remote!.roomThreads!(target.hostId,
        [...targets.values()].filter(item => item.hostId === target.hostId).map(item => item.threadId)))
    }
    // The requests Watcher acts for: the current Watcher's, and a paired master's on the threads this host owns.
    const acting = new Set(record.requests.filter(request => request.state === 'active'
      && (request.remoteOrigin || record.current && sameTarget(request.watcher, record.current.target))).map(request => request.id))
    const offer = this.currentOffer()
    // One host list for the whole read: each list reads every paired host, so asking per operation grew with them (#1023).
    let hosts: ReturnType<WatcherRemoteHosts['hosts']> | undefined
    const reportsOutcomes = (hostId: string) => (hosts ??= this.remote?.hosts() ?? []).find(host => host.hostId === hostId)?.outcomes === true
    // Each owning host's snapshot and its threads by ID, read once for the whole read rather than searched per target.
    const owners = new Map<string, { snapshot: AgentHostSnapshot | undefined; threads: Map<string, AgentThread> }>()
    const owner = (hostId: string) => {
      let found = owners.get(hostId)
      if (!found) {
        const snapshot = this.owningSnapshot(hostId), threads = new Map<string, AgentThread>()
        for (const thread of snapshot?.threads ?? []) if (!threads.has(thread.id)) threads.set(thread.id, thread)
        owners.set(hostId, found = { snapshot, threads })
      }
      return found
    }
    const room: WatcherRoomState = { current: record.current, currentOptions: current ? { modelId: current.modelId, reasoningEffort: current.reasoningEffort ?? null,
      runtimeMode: current.runtimeMode ?? 'approval-required', status: current.status, connected: this.connected(current) } : null,
      runtimeMode: record.lastRuntimeMode ?? current?.runtimeMode ?? 'approval-required', standingWatches: watches,
      ownChanges: current ? watcherOwnChanges(current) : [], history: record.history, requests: record.requests,
      watchedThreads: [...targets].map(([targetKey, target]) => {
        const watch = watchOf.get(targetKey)
        const participation = participations.get(targetKey) ?? []
        if (roomInputs?.has(target.hostId)) {
          const input = roomInputs.get(target.hostId)?.find(item => item.id === target.threadId)
          const observation = this.wakes.observations.get(targetKey)
          return { target, watched: Boolean(watch) || takesPartInActiveRequest(participation, acting), paused: Boolean(watch?.pausedByUserMessageId),
            title: input?.title ?? 'Unavailable thread', status: input?.status ?? 'unavailable',
            connected: input?.connected ?? false, settled: input?.settled ?? false, backgroundWorkCount: input?.backgroundWorkCount ?? 0,
            evidence: this.wakes.evidence.read(target, input?.connected ?? false, undefined, targetKey),
            ...(input && observation ? { observation: this.roomObservation(observation) } : {}),
            waitsOn: input?.waitsOn.map(request => ({ ...request, openTarget: target })) ?? [],
            participation }
        }
        const owning = owner(target.hostId), thread = owning.threads.get(target.threadId)
        // A thread's observation is kept under the host its snapshot names, or null when it names none (watcherObservationKey).
        const observationKey = thread === undefined ? undefined : thread.hostId === target.hostId ? targetKey : thread.hostId === undefined
          ? keys.hostless.get(thread.id) ?? keys.hostless.set(thread.id, JSON.stringify([null, thread.id])).get(thread.id)! : JSON.stringify([thread.hostId, thread.id])
        const observation = observationKey === undefined ? undefined : this.wakes.observations.get(observationKey)
        // One definition of watched for every surface: a standing watch, or taking part in an active request.
        return { target, watched: Boolean(watch) || takesPartInActiveRequest(participation, acting), paused: Boolean(watch?.pausedByUserMessageId), title: thread?.title ?? 'Unavailable thread', status: thread?.status ?? 'unavailable', connected: Boolean(thread && this.connected(thread)),
          settled: Boolean(thread && isWorkspaceThreadSettled(thread, owning.snapshot?.projects.find(item => item.id === thread.projectId))),
          backgroundWorkCount: (thread?.backgroundWork?.length ?? 0) + (thread?.monitoring?.length ?? 0),
          evidence: this.wakes.evidence.read(target, Boolean(thread && this.connected(thread)), undefined, targetKey),
          ...(thread && observation ? { observation: this.roomObservation(observation) } : {}),
          waitsOn: thread?.requests.map(request => ({ id: request.id, kind: request.kind, openTarget: target })) ?? [],
          participation }
      }),
      receipts: record.operations.map(operation => { const outcome = this.outcomeOf(operation, reportsOutcomes); return outcome ? { ...operation, outcome } : operation }),
      news: this.wakes.news(), recoveryNotice: this.recoveryNotice, observedAt: now(),
      // A replacement whose creation stopped part-way, with nothing finishing it now: the room offers to try again.
      creationStopped: view.creation !== null && this.opening === undefined,
      handover: offer ? { source: offer.source.target, provider: offer.source.provider, counts: offer.counts } : null,
      receiptReplies: watcherReceiptReplies(record, current), asks: watcherAskPlacements(current, record) }
    // Watcher's conversation against its compaction point, and what it keeps through compaction (#1189).
    const snapshot = this.options.control.watcherSnapshot()
    room.context = current ? { tokens: this.contextTokens(current), compactAt: WATCHER_COMPACT_AT_TOKENS, canCompact: this.canCompact(snapshot, current),
      compacting: compactionPending(current.compaction) } : null
    room.state = { watching: this.watching(room.watchedThreads), kept: this.kept.read(), ...this.kept.readable() ? {} : { unread: true as const } }
    if (current && !live.creation) room.newWatcher = this.newWatcherAnswer(live, current)
    return room
  }
  /** The watched threads and what each waits on, in Sotto's words, for Watcher's state (#1189). */
  private watching(threads: WatcherRoomState['watchedThreads']) {
    // This computer's threads only: this runs on every room update, and a paired host's shell is not read again for it.
    // A paired host's thread keeps the count its room input carries, which leaves its sub-agents out.
    const local = this.options.control.watcherSnapshot(), hostId = this.hostId()
    return threads.filter(thread => thread.watched !== false).map(thread => {
      // The work its last turn left running, sub-agents working or left unknown included, as its news counts it.
      const owned = thread.target.hostId === hostId ? local.threads.find(item => item.id === thread.target.threadId) : undefined
      const work = owned ? watcherBackgroundWorkCount(owned) : thread.backgroundWorkCount
      // The cards of the threads it delegated to, as list_threads gives them; a paired host's are left out, as above.
      const delegatedWaitsOn = owned ? local.threads.filter(child => child.delegatedBy === owned.id).flatMap(child => child.requests) : []
      return { target: thread.target, title: thread.title, waitsOn: watcherWaitsOn({ ...thread, backgroundWorkCount: work, delegatedWaitsOn, prototypeReady: owned?.prototypeReady !== undefined }) }
    })
  }
  /**
   * read_state's watched threads (#1274), each with its open pull requests as Sotto last read them and what the merge queue
   * reads of each: whether it is a draft and since when its checks have passed. A thread its host no longer lists gives
   * what its evidence says.
   */
  private stateThreads() { return this.withOpenPullRequests(this.watching(this.state().watchedThreads)) }
  /** Each row with its open pull requests and what the merge queue reads of each (`stateThreads`). */
  private withOpenPullRequests<Row extends { readonly target: WatcherThreadTarget }>(rows: readonly Row[]): (Row & { open: WatcherOpenPullRequest[] })[] {
    const hosts = new Map<string, Map<string, AgentThread>>()
    const threadOf = (target: WatcherThreadTarget) => {
      let threads = hosts.get(target.hostId)
      if (!threads) hosts.set(target.hostId, threads = new Map((this.owningSnapshot(target.hostId)?.threads ?? []).map(thread => [thread.id, thread])))
      return threads.get(target.threadId)
    }
    return rows.map(row => {
      const thread = threadOf(row.target), evidence = this.wakes.evidence.read(row.target, Boolean(thread && this.connected(thread)))
      const since = (url: string | undefined) => url === undefined ? undefined : this.wakes.evidence.checksPassedSince(row.target, url)
      const open: WatcherOpenPullRequest[] = thread
        ? watcherOpenPullRequests(threadPullRequests(thread), evidence).filter(item => item.summary.state === 'open')
          .map(({ pr, summary }) => ({ summary, draft: pr.draft, ...withSince(since(pr.url)) }))
        // Evidence does not say whether a pull request is a draft, so one read only from it is never queued.
        : watcherPullRequestSummaries(evidence).filter(summary => summary.state === 'open').map(summary => ({ summary, draft: undefined, ...withSince(since(summary.url)) }))
      return { ...row, open }
    })
  }
  /** Whether Settle finished threads settles anything here: its setting is on, on a computer that settles its watches. */
  private settlesFinishedThreads(): boolean { return !this.options.workerHost && this.options.settleFinished?.() === true }
  /** The watched threads Settle finished threads waits to settle and what holds each, while it is on (#1274). */
  private pendingSettles(titles: ReadonlyMap<string, string>): WatcherPendingSettle[] {
    if (!this.settlesFinishedThreads()) return []
    const look = this.finishedLook()
    // A thread already tried for its turn waits for another turn, so it is not pending.
    return [...look.watches.values()].flatMap(watch => {
      const hold = this.settleHold(watch.target, look)
      return !hold || this.settleTried.get(key(watch.target)) === hold.turnId ? []
        : [{ target: watch.target, title: titles.get(key(watch.target)) ?? 'Unavailable thread', settlesWhen: watcherSettlesWhen(hold) }]
    })
  }
  /**
   * The kept notes that name a thread that is settled or not watched, or a pull request that is merged or closed (#1274):
   * every thread Sotto lists, and every pull request linked to one, with GitHub's own read of it first where Sotto has one.
   */
  private staleNotes(kept: WatcherKeptState, watching: readonly { readonly target: WatcherThreadTarget }[]): WatcherStaleNote[] {
    const watched = new Set(watching.map(row => key(row.target))), watcher = this.view().current?.target
    const projects = new Map<string, AgentHostSnapshot['projects']>()
    const projectsOf = (hostId: string) => projects.get(hostId) ?? projects.set(hostId, this.owningSnapshot(hostId)?.projects ?? []).get(hostId)!
    const all = this.snapshot().threads.map(thread => ({ thread, target: { hostId: thread.hostId ?? this.hostId(), threadId: thread.id } }))
      .filter(({ target }) => !watcher || !sameTarget(target, watcher))
    const threads = all.map(({ thread, target }) => ({ target, title: thread.title,
      settled: isWorkspaceThreadSettled(thread, projectsOf(target.hostId).find(project => project.id === thread.projectId)), watched: watched.has(key(target)) }))
    const pullRequests = new Map<string, WatcherKnownPullRequest>()
    for (const { thread } of all) for (const pr of threadPullRequests(thread)) {
      const prKey = pullRequestKey(pr.url) ?? pr.url
      if (!pullRequests.has(prKey)) pullRequests.set(prKey, { url: pr.url, number: pr.number, state: pr.state })
    }
    for (const { target } of all) for (const summary of watcherPullRequestSummaries(this.wakes.evidence.read(target))) {
      if (summary.url === undefined || summary.state === undefined) continue
      const prKey = pullRequestKey(summary.url) ?? summary.url, number = pullRequests.get(prKey)?.number ?? summary.number
      if (number !== undefined) pullRequests.set(prKey, { url: summary.url, number, state: summary.state })
    }
    return watcherStaleNotes(kept, threads, [...pullRequests.values()])
  }
  private roomObservation(observation: WatcherObservation) { const { landing: _landing, ...result } = observation; void _landing; return result }
  get(): WatcherRoomResult { return { status: 'ok', state: this.state() } }

  /** A handover of an earlier Watcher conversation, its messages as its pane shows them (ADR-0073). */
  private buildHandover(source: WatcherIdentity): Handover | undefined {
    const requests = this.record().requests
    return this.options.host.watcherHandover(source.target.threadId, message => watcherMessageAsShown(source.target.hostId, source.target.threadId, message, requests))
  }
  /**
   * After a replacement (a provider change or New Watcher), offers a handover of the conversation the new Watcher
   * replaced, when that one has history. Any earlier offer goes with it. A history that cannot be read offers nothing.
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
  private noteMergeTurn(operation: WatcherOperation, pullRequest: number): void {
    if (this.mergeTurns.some(turn => turn.operationId === operation.id)) return
    this.mergeTurns.push({ operationId: operation.id, target: operation.target, pullRequest, at: now() })
    if (this.mergeTurns.length > WATCHER_MERGE_TURNS_KEPT) this.mergeTurns.splice(0, this.mergeTurns.length - WATCHER_MERGE_TURNS_KEPT)
  }
  /**
   * The merge turns for Watcher's picture (#1339): the merge queue read_state computes from live data (#1274), for the
   * threads the room last published as watched, and the merge turns Watcher gave, each with its thread from the moment
   * its send was admitted. Nothing here walks Watcher's history: the window drops a turn whose send failed from its own
   * receipts. Read only while the picture shows, never published.
   */
  readMergeTurns(): WatcherMergeTurnsRead {
    try {
      if (!this.view().current) return { status: 'ok', queue: [], turns: [] }
      // The window's room listens whenever the picture shows; with no room published yet, one is built for this read.
      const watched = (this.publishedWatched ?? this.state().watchedThreads).filter(row => row.watched !== false).map(row => ({ target: row.target, title: row.title }))
      return { status: 'ok', queue: watcherMergeQueue(this.withOpenPullRequests(watched)).slice(0, WATCHER_STATE_COMPUTED_MAX), turns: [...this.mergeTurns] }
    } catch (error) { return error instanceof Refusal ? error.result : watcherRefusal('PROVIDER_UNAVAILABLE', 'Sotto could not read the merge turns just now. Nothing was changed.', true) }
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
  /** The user's own Watch, from the room, a thread's page or the iPhone. It hands back a thread the user stopped watching. */
  async watchThread(input: WatcherWatchThreadRequest, guard?: () => void): Promise<WatcherRoomResult> {
    try { await this.assignWatch(input, guard, 'user'); return this.get() }
    catch (error) { return error instanceof Refusal ? error.result : watcherRefusal('HOST_DISCONNECTED', 'The watch could not be saved. Reconnect and try again.', true) }
  }
  private async assignWatch(input: WatcherWatchThreadRequest, guard: (() => void) | undefined, by: 'user' | 'watcher'): Promise<WatcherStandingWatch> {
    const parsed = watcherWatchThreadRequestSchema.safeParse(input)
    if (!parsed.success) refuse('INVALID_INPUT', 'Choose a thread to watch.')
    if (this.closed || this.options.workerHost) refuse('NOT_CURRENT_WATCHER', 'Assign watched threads on Watcher’s desktop.')
    const target = parsed.data.target
    if (by === 'watcher') this.checkHandedBack(this.record(), target)
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
          if (by === 'watcher') this.checkHandedBack(record, target)
          if (live) Object.assign(live, created)
          else {
            (record.watches ??= []).push(created)
            if (target.hostId === this.hostId() && (record.localTakeovers?.some(item => key(item.target) === key(target))
              || record.watchFences?.some(item => item.target && !item.remoteOrigin && key(item.target) === key(target))
              || record.requests.some(request => request.participants.some(item => key(item.target) === key(target) && item.state === 'taken-over')))) this.recordLocalTakeover(record, target)
          }
          record.userUnwatches = record.userUnwatches?.filter(item => key(item.target) !== key(target))
          if (!record.userUnwatches?.length) delete record.userUnwatches
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
  /**
   * Stops watching a thread. The user's own Stop watching (`by` user: the room, a thread's page or the iPhone) also keeps
   * Watcher from watching it again by itself until the user hands it back; Watcher's own unwatch_thread does not.
   */
  async unwatchThread(input: WatcherWatchThreadRequest, guard?: () => void, by: 'user' | 'watcher' = 'user'): Promise<WatcherRoomResult> {
    try {
      const parsed = watcherWatchThreadRequestSchema.safeParse(input)
      if (!parsed.success) refuse('INVALID_INPUT', 'Choose a thread to stop watching.')
      if (this.closed || this.options.workerHost) refuse('NOT_CURRENT_WATCHER', 'Stop watching from Watcher’s desktop.')
      const operations = new Set<string>(), target = parsed.data.target
      await this.transaction(async () => {
        guard?.()
        this.pendingWatchAssignments.delete(key(target))
        await this.options.control.updateWatcher(record => {
          guard?.(); this.withdrawWatch(record, target, operations)
          if (by === 'user') {
            const current = record.current
            const master = current && this.options.control.watcherSnapshot().threads.find(thread => thread.id === current.target.threadId)
            // Without Watcher's thread in view, the newest user message its requests recorded stands in, so an older one
            // cannot later pass for a newer message.
            const known = current ? record.requests.filter(request => !request.standingWatchId && key(request.watcher) === key(current.target))
              .flatMap(request => [request.rootUserMessageId, ...(request.userFollowups ?? []).flatMap(item => item.messageId ? [item.messageId] : [])]).at(-1) : undefined
            record.userUnwatches = [...(record.userUnwatches ?? []).filter(item => key(item.target) !== key(target)),
              { target, watcherHead: (master ? nativeHead(master) : null) ?? known ?? null, at: now() }].slice(-10_000)
          }
        })
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
  /**
   * A thread the user stopped watching is Watcher's again only when the user hands it back: with Watch, or in a message
   * to Watcher sent after Stop watching, which the Watcher turn calling watch_thread must be answering.
   */
  private checkHandedBack(record: Readonly<WatcherRecord>, target: WatcherThreadTarget): void {
    const unwatched = record.userUnwatches?.find(item => key(item.target) === key(target))
    if (!unwatched || !record.current) return
    const master = this.options.control.watcherSnapshot().threads.find(thread => thread.id === record.current!.target.threadId)
    const head = master ? nativeHead(master) : null
    if (!head || head === unwatched.watcherHead) refuse('REQUEST_NOT_ACTIVE', 'The user stopped watching this thread. Only the user can hand it back, with Watch or in a new message to Watcher. Nothing was watched.')
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
    if (!head && target.hostId !== this.hostId()) head = record.watches?.find(watch => sameTarget(watch.target, target))?.lastUserMessageId
      ?? record.requests.flatMap(request => request.participants).findLast(participant => sameTarget(participant.target, target) && participant.lastUserMessageId)?.lastUserMessageId ?? null
    // Watcher's own message, or one Sotto sent itself, such as a wake-up or a delegated brief, is never the user's. Asked
    // on every update for each watched thread, so targets are compared without building keys.
    const machineMessage = (id: string) => record.operations.some(operation => sameTarget(operation.target, target) && operation.messageId === id)
      || this.sottoMessage(thread, id)
    if (!head || !machineMessage(head)) return true
    // Conversation events can publish before the adapter's native head. A later non-machine user message in the
    // same ordered window proves human work behind a stale machine head; never downgrade an explicit human head.
    const userIndex = thread.messages.findLastIndex(message => message.role === 'user')
    // The common streaming case already names this latest user. Do not revisit an expanded older history per update.
    if (userIndex < 0 || thread.messages[userIndex]!.id === head) return false
    const headIndex = thread.messages.findIndex(message => message.id === head)
    return headIndex >= 0 && userIndex > headIndex && !machineMessage(thread.messages[userIndex]!.id)
  }
  /**
   * Whether a thread's message is Sotto's own rather than the user's: a wake-up, such as babysitting's or delegation's news,
   * by the host's own record of what it sent, or a brief delegation sent. Neither is ever the user's turn or a takeover.
   * Watcher's own sends are known by their operations.
   */
  private sottoMessage(thread: AgentThread, messageId: string): boolean {
    return thread.wakeUpMessageIds?.includes(messageId) === true || thread.messages.some(message => message.id === messageId && message.wakeUp === true)
      || this.options.control.delegationMessage(messageId)
  }
  private hostWatches(hostId: string): WatcherStandingWatch[] {
    return [...new Map([...(this.record().watches ?? []).filter(watch => watch.target.hostId === hostId),
      ...[...this.pendingWatchAssignments.values()].filter(watch => watch.target.hostId === hostId)].map(watch => [key(watch.target), watch])).values()]
      .filter(watch => this.owningSnapshot(hostId)?.threads.some(thread => thread.id === watch.target.threadId))
  }
  /** While the user's own turn runs, Watcher may steer it and nothing else: a send or a queued prompt waits for it to end. */
  private checkHumanTurn(thread: AgentThread, record: WatcherRecord, delivery: WatcherOperation['delivery']): void {
    if (delivery === 'steer') return
    const watch = record.watches?.find(item => key(item.target) === key({ hostId: thread.hostId ?? this.hostId(), threadId: thread.id }))
    if (watch?.pausedByUserMessageId || this.humanTurnRunning(thread, record)) refuse('THREAD_BUSY', 'The user’s own turn in this thread is running. Steer it, or send once it ends. Nothing was sent.', true)
  }
  /**
   * Watcher on its own never stops the user's running turn. It may only while it answers the user's own message asking
   * it to (`askedNow`, decided at admission), never under a standing watch's scope. Watcher's own turn it may stop while
   * a user prompt waits behind it: a machine Stop keeps the user's queue.
   */
  private checkStopTurn(thread: AgentThread, record: WatcherRecord, requestId: string, askedNow = true): void {
    const automatic = Boolean(record.requests.find(request => request.id === requestId)?.standingWatchId)
    if ((automatic || !askedNow) && this.humanTurnRunning(thread, record)) refuse('THREAD_BUSY', 'The user’s own turn in this thread is running, and Watcher does not stop it. Nothing was stopped.', true)
  }
  /**
   * Whether a takeover fences this request on a thread. Admission asks only for a thread with no standing watch, since a
   * standing watch outlasts the user's own message (ADR-0073, October 19); there a takeover fences every request. The
   * ordering by the local takeover record below is what applied to watched threads from October 17 to 19.
   */
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
        // The file holds at most eight reservations (#1183): those left off come back, and what no thread needs goes again.
        if (rebuildReservations(next) && !this.options.workerHost) this.pruneReservations(next, this.options.control.watcherSnapshot())
        const starts = new Set(next.operations.flatMap(operation => operation.action === 'start' ? [operation.id] : []))
        next.reservations = next.reservations.filter(item => starts.has(item.operationId))
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
        // Before a standing watch outlasted the user's own message, that message took its thread's participation away for
        // good. A thread still watched here is Watcher's again; a thread watched for a request alone stays the user's.
        for (const watch of next.watches ?? []) if (watch.target.hostId === this.options.control.hostId()
          && next.requests.some(request => request.participants.some(participant => keptByWatch(participant, watch.target) && participant.state === 'taken-over'))) alignGeneration(next, watch)
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
    // An open joins an open under way. One during New Watcher would answer with New Watcher's result and drop its choice.
    if (this.opening && this.openingKind === 'new') return Promise.resolve(watcherRefusal('THREAD_BUSY', 'Wait for the new Watcher to start before changing its model.', true))
    return this.begin('open', () => this.openOne(input))
  }
  /**
   * The one open or New Watcher under way, which a second of the same kind joins. Published once it settles, so the room
   * learns whether a creation stopped part-way (`creationStopped`) and what New Watcher would answer.
   */
  private begin(kind: 'open' | 'new', run: () => Promise<WatcherRoomResult>): Promise<WatcherRoomResult> {
    if (this.opening) return this.opening
    this.openingKind = kind
    this.opening = run().finally(() => { this.opening = undefined; this.openingKind = undefined; this.publish() })
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
        return await this.finishPending(record, input)
      }
      if (!previous || previous.provider !== input.provider) this.creationPermission(model)
      if (previous) {
        const thread = this.currentThread(previous)
        if (previous.provider === input.provider && thread.modelId === input.modelId
          && (!input.reasoningEffort || thread.reasoningEffort === input.reasoningEffort)) return this.get()
        const held = this.changeHeld(record, thread, previous.provider === input.provider ? 'model' : 'provider')
        if (held) refuse('THREAD_BUSY', held, true)
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
      return await this.replace(previous, input)
    } catch (error) { return error instanceof Refusal ? error.result : watcherRefusal('PROVIDER_UNAVAILABLE', 'Watcher could not be opened. Nothing was sent. Check its provider and reopen Watcher.', true) }
    finally { this.changing = false }
  }
  /**
   * New Watcher (ADR-0073): a new Watcher on the current one's own provider, model, effort and permission mode, all read
   * from the current Watcher's thread, through the same replacement a provider change makes. The last conversation goes
   * to Watcher history with its tools revoked, workers, receipts and standing watches carry on, and its handover is
   * offered. Refused, nothing is sent and nothing changes. A creation left pending is finished, as open finishes it.
   */
  startNew(): Promise<WatcherRoomResult> {
    // A second press joins the first. During an open it would answer with that open's result and start nothing.
    if (this.opening && this.openingKind === 'open') return Promise.resolve(watcherRefusal('THREAD_BUSY', 'Wait for Watcher to finish changing before starting a new one.', true))
    return this.begin('new', () => this.startNewOne())
  }
  private async startNewOne(): Promise<WatcherRoomResult> {
    try {
      if (this.options.workerHost) refuse('HOST_FEATURE_UNAVAILABLE', 'Open Watcher on the desktop that coordinates this host.')
      if (this.closed) refuse('NOT_CURRENT_WATCHER', this.recoveryNotice ?? 'Watcher is stopping. Reopen Sotto.')
      const record = this.record(), previous = record.current
      if (record.creation) {
        const { identity, modelId, reasoningEffort } = record.creation
        if (modelId === undefined) refuse('PROVIDER_UNAVAILABLE', 'Watcher creation stopped before its model was saved. Reopen Watcher with the same choice.')
        return await this.finishPending(record, { provider: identity.provider, modelId, ...(reasoningEffort ? { reasoningEffort } : {}) })
      }
      if (!previous) refuse('NOT_CURRENT_WATCHER', 'There is no Watcher yet. Send Watcher your first message to start it.')
      const thread = this.currentThread(previous)
      const held = this.changeHeld(record, thread, 'new')
      if (held) refuse('THREAD_BUSY', held, true)
      if (!this.hasHistory(previous)) refuse('INVALID_INPUT', 'This Watcher is new, so there is nothing to hand over yet. Nothing was changed.')
      const model = resolveModel(this.options.control.watcherSnapshot().models, thread.modelId)
      if (!model?.ready || model.providerId !== previous.provider) refuse('PROVIDER_UNAVAILABLE', 'Watcher’s model is not ready. Connect its provider and try again.', true)
      // The new Watcher starts with the permission mode the current one has in force: the saved choice, which a change
      // saves before the live thread takes it. Where the thread reports another, nothing is started rather than either
      // mode chosen for the user.
      if (thread.runtimeMode !== undefined && this.creationPermission(model) !== thread.runtimeMode) {
        refuse('PERMISSION_NOT_COMPARABLE', 'Watcher’s saved permission mode is not the one in force, so nothing was started. Choose its permission mode again, then start a new Watcher.')
      }
      const reasoningEffort = thread.reasoningEffort && model.reasoningEfforts?.includes(thread.reasoningEffort) ? thread.reasoningEffort : undefined
      this.changing = true
      return await this.replace(previous, { provider: previous.provider, modelId: model.id, ...(reasoningEffort ? { reasoningEffort } : {}) })
    } catch (error) { return error instanceof Refusal ? error.result : watcherRefusal('PROVIDER_UNAVAILABLE', 'Sotto could not start a new Watcher. Nothing was sent. Check its provider and try again.', true) }
    finally { this.changing = false }
  }
  /** The current Watcher's thread, refused when it no longer matches the saved identity. */
  private currentThread(current: WatcherIdentity): AgentThread {
    const thread = this.thread(current.target)
    if (thread.kind !== 'watcher' || thread.providerId !== current.provider || thread.projectId !== current.projectId) refuse('NOT_CURRENT_WATCHER', 'The saved Watcher identity does not match its thread. Nothing was changed.')
    return thread
  }
  /**
   * What holds Watcher back from changing its model or effort, changing provider or being replaced, said as the refusal;
   * null when nothing does. Only Watcher's own work holds it: its turn, a request card, a tool call under way, or a message
   * on its way to it. A replacement also waits for its sends queued behind a working thread, which a new Watcher could not
   * send, and for threads it started on a paired host that are still working, which a host stops only for the Watcher that
   * started them. Threads it started on this computer and deliveries not yet confirmed carry on and are tracked as before,
   * since they belong to the record and not to a conversation (ADR-0073, #1325).
   */
  private changeHeld(record: Readonly<WatcherRecord>, thread: AgentThread, change: 'model' | 'provider' | 'new'): string | null {
    const then = change === 'model' ? 'change its model or effort' : change === 'provider' ? 'change its provider' : 'start a new Watcher'
    if (thread.status === 'running') return `Watcher is working. Wait for this turn to finish, or stop it, then ${then}. Nothing was changed.`
    if (thread.requests.length > 0) return `Watcher is waiting for your answer. Answer its request, then ${then}. Nothing was changed.`
    if (this.invocations > 0 || this.active.size > 0) return 'Watcher is sending to a thread right now. Try again in a moment. Nothing was changed.'
    switch (this.options.control.pendingThreadWorkReason(thread.id, { setAsideIgnored: true })) {
      case 'uncertain-send': return `A message to Watcher is not confirmed yet. Open Watcher to check whether it arrived, or continue with a new message, then ${then}. Nothing was changed.`
      case 'failed-followups': return `A message queued for Watcher did not send. Send or remove it in Watcher’s queue, then ${then}. Nothing was changed.`
      case 'paused-followups': return `Watcher’s queue is paused. Resume or clear it, then ${then}. Nothing was changed.`
      case 'pending-work': return 'A message to Watcher is on its way. Try again once it arrives. Nothing was changed.'
      case null: break
    }
    if (change === 'model') return null
    // A send that waits on the user's review, or for a thread put aside, would wait for good: only one behind a thread's
    // turn holds a replacement. A paired host's queue is its own to read, so a send queued there still holds it.
    // Read once, and only when a send of this computer's is queued: this runs on every publish (newWatcherAnswer).
    const local = this.hostId()
    let queued = 0, waiting: ReadonlySet<string> | undefined
    for (const operation of record.operations) if (operation.deliveryState === 'queued'
      && (operation.target.hostId !== local || (waiting ??= this.options.control.watcherQueuedSendsWaiting()).has(operation.id))) queued++
    if (queued === 0) {
      const remote = record.reservations.some(item => item.target.hostId !== local && record.operations.some(operation => operation.id === item.operationId && operation.action === 'start'))
      return remote ? `A thread Watcher started on another computer is still working, and only this Watcher can stop it there. Wait for it to finish, or stop it with Stop all, then ${then}. Nothing was changed.` : null
    }
    return queued === 1 ? `Watcher has a message queued for a thread that is still working, which a new Watcher could not send. Wait until it has gone, or stop it with Stop all, then ${then}. Nothing was changed.`
      : `Watcher has ${queued} messages queued for threads that are still working, which a new Watcher could not send. Wait until they have gone, or stop them with Stop all, then ${then}. Nothing was changed.`
  }
  /**
   * What New Watcher would answer now, for the room's chip: main's own busy conditions, and whether the conversation has
   * said anything by the thread's own record of it. Cheap enough for every publish, so it builds no handover; a press
   * still asks the handover itself (`hasHistory`).
   */
  private newWatcherAnswer(record: Readonly<WatcherRecord>, thread: AgentThread): NonNullable<WatcherRoomState['newWatcher']> {
    if (this.opening !== undefined || this.changeHeld(record, thread, 'new') !== null) return 'busy'
    const said = thread.messages.length > 0 || thread.lastUserMessageId !== undefined || (thread.summary?.messageCount ?? 0) > 0 || thread.earlierAvailable === true
    return said ? 'available' : 'empty'
  }
  /** Whether a Watcher conversation has said anything: what its handover would carry. One that cannot be read counts as having history. */
  private hasHistory(source: WatcherIdentity): boolean {
    try { return (this.buildHandover(source)?.summary.total ?? 0) > 0 } catch { return true }
  }
  /**
   * Finishes a creation that stopped part-way, with the choice it was saved with. A replacement's offers the replaced
   * conversation's handover too. The pending creation is the current Watcher, and Watcher history grows only in the write
   * that makes a replacement current (`replace`), so when that history has any conversation its last is the one replaced,
   * whichever provider either is on; the first Watcher's creation has none.
   */
  private async finishPending(record: Readonly<WatcherRecord>, input: WatcherOpenRequest): Promise<WatcherRoomResult> {
    const creation = record.creation!, current = record.current
    await this.finishCreation(creation.identity, input)
    const replaced = record.history.at(-1)
    if (replaced && current && key(current.target) === key(creation.identity.target)) this.offerHandover(replaced, current.target)
    this.recoveryNotice = null; this.publish(); return this.get()
  }
  /**
   * Makes a new Watcher thread on `input` the current Watcher. The one it replaces goes to Watcher history, its tools
   * revoked, and its handover is offered; workers, receipts and standing watches stay as they are, since they belong to
   * the record and not to a conversation (ADR-0073). The first Watcher replaces nothing.
   */
  private async replace(previous: WatcherIdentity | null, input: WatcherOpenRequest): Promise<WatcherRoomResult> {
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
    // A message queued while Watcher reads news joins no request, so nothing of the newest one holds it back: it goes as its
    // own turn, under a request of its own (#1188).
    if (threadId === this.record().current?.target.threadId && command.type === 'queue-followup' && command.draftId && !this.options.control.watcherWakeUpTurn(threadId)) {
      const latest = newestUserRequest(this.record(), threadId)
      if (!latest) refuse('REQUEST_NOT_ACTIVE', 'Send an instruction to Watcher before queuing a continuation.')
      if ((latest.userFollowups?.length ?? 0) >= 1_000) refuse('REQUEST_NOT_ACTIVE', 'This request has too many queued continuations. Send a new instruction instead.')
      this.options.control.mutateWatcher(record => {
        const request = newestUserRequest(record, threadId)
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
      void this.reconcileRemote().catch(() => { this.recoveryNotice = 'The host has not confirmed this stopped request. Its unconfirmed starts and sends are kept until it does.'; this.publish() })
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
  private takeover(threadId: string, reason: TakeoverReason, userMessageId?: string, userDraft?: TakeoverDraft): void {
    const target = this.target(threadId)
    if (!this.ownsThread(this.view(), target)) return
    let operations = new Set<string>()
    // One send is one takeover, whichever requests it ends: every participant it fences shares its time (the takeover line).
    const at = now()
    this.options.control.mutateWatcher(record => { operations = this.takeoverChange(record, target, reason, at, userMessageId, userDraft) })
    this.cancelTakenOver(operations)
  }
  /** Whether Watcher watches a thread, or ever had it take part in a request, so the user's act there is a takeover. */
  private ownsThread(record: Readonly<WatcherRecord>, target: WatcherThreadTarget): boolean {
    return record.watches?.some(watch => sameTarget(watch.target, target)) === true
      || record.requests.some(request => request.participants.some(item => sameTarget(item.target, target)))
  }
  /** Records a takeover of a thread Watcher owns in `record`. Returns the operations whose queued sends it fences. */
  private takeoverChange(record: WatcherRecord, target: WatcherThreadTarget, reason: TakeoverReason, at: string, userMessageId?: string, userDraft?: TakeoverDraft): Set<string> {
    const operations = new Set<string>()
    // A renewed watch also records a boundary, but only a takeover, Stop or Stop all is the user acting after the queue.
    this.revokeQueuedFreshness(record)
    this.recordLocalTakeover(record, target, at, userDraft)
    // A standing watch lasts until the user stops it (ADR-0073): the user's own instruction fences what Watcher had
    // already prepared and holds Watcher to steering while the turn runs, but the thread stays Watcher's to keep going.
    const watch = record.watches?.find(item => key(item.target) === key(target))
    if (watch) { alignGeneration(record, watch); watch.pausedByUserMessageId = userMessageId ?? nativeHead(this.thread(target)) ?? 'unobserved-user-turn' }
    for (const request of record.requests) for (const participant of request.participants) if (key(participant.target) === key(target) && participant.state === 'participating') {
      if (!watch) participant.generation++
      // Only a thread watched for a request alone, as on an older paired host, becomes the user's again, and so does a
      // participation Watcher had already stopped, which the user's own command reviews: its held queue goes on.
      if (!watch || stoppedParticipation(request, participant)) { participant.state = 'taken-over'; participant.takeover = { reason, at } }
      for (const operation of record.operations.filter(item => item.requestId === request.id && key(item.target) === key(target))) {
        operations.add(operation.id)
        if (operation.deliveryState === 'queued') { operation.deliveryState = 'failed'; operation.refusalCode = 'THREAD_TAKEN_OVER'; operation.updatedAt = now() }
      }
    }
    record.reservations = record.reservations.filter(item => key(item.target) !== key(target)
      || record.operations.some(operation => key(operation.target) === key(item.target) && ['dispatching', 'uncertain'].includes(operation.deliveryState)))
    return operations
  }
  /** Takes a taken-over thread's fenced sends out of the queue, once the takeover is in the record. */
  private cancelTakenOver(operations: ReadonlySet<string>): void {
    void this.options.control.cancelWatcherQueue(operations).catch(() => { this.recoveryNotice = 'A taken-over thread’s queued Watcher message could not be removed. It is fenced and will not be sent.'; this.publish() })
  }
  preserveUserQueue(threadId: string): boolean {
    // Read, not copied: the follow-up queue asks this on the update path, from its own timers too, where nothing catches a
    // refusal. Without this computer's host ID, a hold on a thread of this ID on any host keeps the queue waiting until it is
    // back (#1129).
    const hostId = this.options.control.hostId()
    return this.view().requests.some(request => request.participants.some(participant => (hostId === undefined || participant.target.hostId === hostId) && participant.target.threadId === threadId
      && participant.state === 'participating' && stoppedParticipation(request, participant)))
  }
  beforeDispatch(command: AgentHostCommand, _draftId: string | undefined, origin?: WatcherCommandOrigin): AgentHostCommand {
    if (origin?.phoneOrigin && (command.type === 'send' || command.type === 'steer')) this.guardPhoneSend(command.threadId)
    if (!origin?.operationId && _draftId && (command.type === 'send' && !command.wakeUp || command.type === 'steer')) {
      const target = this.target(command.threadId), proof = this.record().localTakeovers?.find(item => key(item.target) === key(target))
        ?.userDrafts?.find(item => item.draftId === _draftId && item.digest === followupDigest(command))
      if (proof) this.options.control.mutateWatcher(record => {
        record.localTakeovers!.find(item => key(item.target) === key(target))!.userDrafts!.find(item => item.draftId === _draftId)!.messageId = command.messageId
      })
    }
    // Compact context for Watcher's own conversation, the user's or Sotto's, owes it its state whatever the provider
    // reports of it afterwards: Muse reports no compaction of its own (#1189). Here, once control has let it through.
    if (command.type === 'compact-thread' && command.threadId === this.record().current?.target.threadId) this.stateOwed = true
    if (command.type === 'send' && command.threadId === this.record().current?.target.threadId) {
      this.sendsToWatcher += 1
      // The thread's newest message is read before the provider has this one, so one that comes while it is acknowledged
      // is never taken for the message before it (#1188).
      this.pendingPromptTurns.set(command.commandId, { watcher: this.record().current!.target, messageId: command.messageId, headBefore: this.headOf(command.threadId) })
    }
    if (origin?.operationId) {
      this.options.control.mutateWatcher(record => {
        const operation = record.operations.find(item => item.id === origin.operationId)!
        operation.commandId = command.commandId
        if ('messageId' in command) operation.messageId = command.messageId
        operation.deliveryState = 'dispatching'; operation.updatedAt = now()
      })
      return command
    }
    // The user may steer Watcher whatever it is doing, and every steer reaches it under an active request of the user's
    // (#1188). One into a turn that answers such a request is part of that request, so Watcher may act on it as on the
    // turn's own message.
    if (command.type === 'steer' && _draftId && command.threadId === this.record().current?.target.threadId) {
      // A try of the same message again keeps what its first try recorded.
      const opened = this.record().requests.find(item => item.rootUserMessageId === command.messageId)
      if (opened) return { ...command, text: command.text + watcherRequestLine(watcherRequestNote(opened.id, this.hostId())) }
      const answered = this.turnRequest(command.threadId)
      if (answered) {
        // A request that has recorded a thousand of the user's messages takes no more: the steer is refused rather than
        // reach Watcher under a request that does not hold it.
        if (!answered.userFollowups?.some(item => item.draftId === _draftId) && (answered.userFollowups?.length ?? 0) >= 1_000) {
          refuse('REQUEST_NOT_ACTIVE', 'This request has too many messages. Send a new instruction instead.')
        }
        this.options.control.mutateWatcher(record => {
          // A queued message steered in may have joined another request when it was queued; it is this turn's now.
          withdrawQueuedDraft(record, _draftId, command.messageId, answered.id)
          const request = record.requests.find(item => item.id === answered.id)!
          request.userFollowups ??= []
          const followup = request.userFollowups.find(item => item.draftId === _draftId)
          if (followup) followup.messageId = command.messageId
          else request.userFollowups.push({ draftId: _draftId, messageId: command.messageId })
        })
        return command
      }
      // A turn that answers none, as one Sotto's news started, gets the steer as the user's fresh word: it opens a request
      // of its own, rooted in its own message, as a Send to an idle Watcher does. A steer has no context channel, so its
      // note goes as one bracketed line after the user's words, as a Grok Build send's does, and every copy of the message
      // is shown without it (watcherRequestNote.ts). Later steers into the same turn join that request.
      const created: WatcherRequest = { id: randomUUID(), watcher: this.target(command.threadId), rootUserMessageId: command.messageId,
        state: 'active', createdAt: now(), closedAt: null, participants: [], ...(origin?.phoneOrigin ? { phoneOrigin: origin.phoneOrigin } : {}) }
      this.options.control.mutateWatcher(record => { withdrawQueuedDraft(record, _draftId, command.messageId); record.requests.push(created) })
      this.lastSteer = { threadId: command.threadId, requestId: created.id, messageId: command.messageId, headBefore: this.headOf(command.threadId) }
      return { ...command, text: command.text + watcherRequestLine(watcherRequestNote(created.id, this.hostId())) }
    }
    if (command.type !== 'send' || command.wakeUp || command.threadId !== this.record().current?.target.threadId) return command
    const record = this.record()
    let request = record.requests.find(item => item.rootUserMessageId === command.messageId
      || _draftId && item.userFollowups?.some(followup => followup.draftId === _draftId))
    // Every Send of the user's reaches Watcher under an active request (#1184). An instruction queued as a continuation
    // keeps its request only while that request is still active when it is delivered: one the user stopped, or one that
    // closed, while it waited is over, and the instruction starts its own request, as a Send to an idle Watcher would.
    // Its request takes the old one's place among takeovers, since the instruction is no newer than it was: a takeover
    // that fenced the old request fences it too. One the user queued after a takeover fenced its request, with no
    // takeover since, is their fresh word instead, ordered after that takeover. A retry keeps the request its first
    // delivery made.
    // A continuation whose recorded message is not this one never reached Watcher: a queued message goes again only as a
    // new message, after a definite failure. An older build kept that failed message on it, so it is matched this way.
    const queued = request?.userFollowups?.find(item => item.draftId === _draftId && item.messageId !== command.messageId)
    const fresh = request !== undefined && request.rootUserMessageId !== command.messageId && queued !== undefined
      && (queued.afterTakeover === true || request.state !== 'active')
    const inPlace = fresh && queued?.afterTakeover !== true
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
        if (old && inPlace) next.requests.splice(next.requests.indexOf(old), 0, created)
        else next.requests.push(created)
      })
    }
    // The user's text goes as typed. The request rides beside it, through the provider's own context channel.
    // After a compaction the note also tells Watcher to read its state back first (#1189).
    this.lookAtState()
    const note = watcherRequestNote(request.id, this.hostId(), this.stateOwed)
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
  /** `observedThread` is Watcher's thread as the observe pass has it, so the pass reads no other copy of it. */
  private activatePromptTurn(commandId: string, observedThread?: AgentThread): void {
    const candidate = this.pendingPromptTurns.get(commandId)
    // Read without copying: this runs once per Watcher send, and the change below makes the one copy it needs.
    const current = this.view().current
    if (candidate && current && key(candidate.watcher) === key(current.target)) this.options.control.mutateWatcher(record => {
      this.beginPromptTurn(record, candidate.watcher, candidate.messageId, observedThread)
    })
    this.pendingPromptTurns.delete(commandId)
  }
  dispatched(command: AgentHostCommand): void {
    const pending = this.pendingPromptTurns.get(command.commandId)
    this.activatePromptTurn(command.commandId)
    if (command.type === 'send' && command.threadId === this.record().current?.target.threadId) {
      this.lastSend = { threadId: command.threadId, wakeUp: command.wakeUp === true, messageId: command.messageId, headAtSend: pending ? pending.headBefore : this.headOf(command.threadId) }
      // A new turn: a steer into the one before it answers nothing here.
      if (this.lastSteer?.threadId === command.threadId) this.lastSteer = undefined
    }
    // The provider has the handover, or may have: it is never offered again.
    if (this.handoverOffer?.sendingCommandId === command.commandId) { this.handoverOffer = null; this.publish() }
  }
  lastSendWasWakeUp(threadId: string): boolean | undefined { return this.currentSend(threadId)?.wakeUp }
  dispatchAborted(command: AgentHostCommand): void {
    this.pendingPromptTurns.delete(command.commandId)
    if (command.type === 'steer' && this.lastSteer?.messageId === command.messageId) this.lastSteer = undefined
    if (this.handoverOffer?.sendingCommandId === command.commandId) delete this.handoverOffer.sendingCommandId
    // A message that definitely never reached the provider was not delivered: its continuation keeps no message, so its
    // next try is a first delivery again and takes an active request if its own has ended since (#1184). A request it
    // started, which nothing has acted under, goes with it, so the next try starts one rooted in a message that exists.
    const messageId = 'messageId' in command ? command.messageId : undefined
    // One a takeover has since taken as its boundary stays: dropping it would fence every request after it.
    const unsent = (request: Readonly<WatcherRequest>, record: Readonly<WatcherRecord>): boolean => request.rootUserMessageId === messageId
      && !request.participants.length && !record.operations.some(operation => operation.requestId === request.id)
      && !record.localTakeovers?.some(takeover => takeover.lastRequestId === request.id)
    const view = this.view()
    if (messageId && view.requests.some(request => unsent(request, view) || request.userFollowups?.some(item => item.messageId === messageId))) this.options.control.mutateWatcher(record => {
      record.requests = record.requests.filter(request => !unsent(request, record))
      for (const request of record.requests) for (const item of request.userFollowups ?? []) if (item.messageId === messageId) { delete item.messageId; delete item.displayPrompt }
    })
  }
  observe(snapshot: AgentHostSnapshot, knownUserMessages: Pick<ReadonlySet<string>, 'has'>): void {
    // This pass runs on every update and walks every thread. It reads the record without copying it, asks what the record
    // says of each thread from an index built once per record, and changes the record at most once, only when something
    // changed. The record grows with every prompt and wake-up Watcher has had; copying, comparing or walking all of it for
    // each thread made Watcher most of main's work with a few hundred threads (#1231).
    // It names this computer's threads by its host ID and runs from the snapshot subscriber, where nothing would catch a
    // refusal (#1129). Without the ID, as while Sotto starts, it waits: what it would read stays for the next snapshot's pass.
    const localId = this.options.control.hostId()
    if (!localId) return
    const threads = new Map<string, AgentThread>()
    for (const thread of snapshot.threads) if (!threads.has(thread.id)) threads.set(thread.id, thread)
    const masterId = this.view().current?.target.threadId
    const master = masterId === undefined ? undefined : threads.get(masterId)
    if (master) for (const [commandId, candidate] of this.pendingPromptTurns) if (candidate.watcher.threadId === master.id && knownUserMessages.has(candidate.messageId)
      && (nativeHead(master) === candidate.messageId || master.messages.some(message => message.role === 'user' && message.id === candidate.messageId))) this.activatePromptTurn(commandId, candidate.watcher.hostId === localId ? master : undefined)
    // What this pass changes, made together at its end. A takeover is the user's act and is made as it is found, on a
    // copy of the record (`draft`) that the rest of the pass reads and that the end of the pass changes and keeps.
    const changes: ((record: WatcherRecord) => void)[] = []
    let draft: WatcherDraft | undefined
    const fenced: ReadonlySet<string>[] = []
    const read = (): Readonly<WatcherRecord> => draft?.record ?? this.view()
    const takeover = (threadId: string, userMessageId?: string) => {
      const target = { hostId: localId, threadId }
      if (!this.ownsThread(read(), target)) return
      draft ??= this.options.control.watcherDraft()
      fenced.push(this.takeoverChange(draft.record, target, 'native-user-send', now(), userMessageId))
      // The draft was changed in place, so what was worked out from it is worked out again.
      if (this.indexed?.record === draft.record) this.indexed = undefined
    }
    // Watcher's own thread as its host last published it, read once. The check and the change both read this one thread,
    // never one copy for the check and another for the change, which may not hold it yet or any more (#1249). A thread
    // that copy does not hold has nothing to record, and the next update asks again.
    const current = this.view().current, watcherTarget = current?.target.hostId === localId ? current.target : undefined
    const watcherThread = watcherTarget && this.options.control.watcherSnapshot().threads.find(item => item.id === watcherTarget.threadId)
    if (!this.options.workerHost && watcherTarget && watcherThread && !this.promptTurnCurrent(this.view(), watcherTarget, watcherThread)) changes.push(record => {
      const target = record.current?.target
      if (target && sameTarget(target, watcherTarget)) this.promptTurn(record, target, undefined, watcherThread)
    })
    const record = this.view(), index = this.recordIndex(record), hostId = index.hostId
    for (const thread of snapshot.threads) {
      const head = nativeHead(thread), previous = this.nativeHeads.get(thread.id)
      this.nativeHeads.set(thread.id, head)
      const participants = index.participating.get(thread.id) ?? []
      // Watcher's own message, or one Sotto sent itself, such as a wake-up or a delegated brief, is never the user's. Asked
      // only of a head that would otherwise be a takeover, since this pass runs for every thread on every update.
      const ownOperation = index.operations.get(thread.id)?.some(item => item.messageId === head) === true
      let sotto: boolean | undefined
      const machineHead = () => ownOperation || head !== null && (sotto ??= this.sottoMessage(thread, head))
      // A takeover earlier in this pass changes the record, so the watch is read from the record as it now stands.
      const watch = this.recordIndex(read()).watches.get(thread.id)
      if (watch && head && watch.lastUserMessageId !== undefined && head !== watch.lastUserMessageId && !machineHead()) {
        // Main bound this exact already-fenced user packet to its native message before dispatch. A known delivery
        // from stable, or an edited queued packet, has no matching proof and still takes over when Owl sees it.
        const ownHead = knownUserMessages.has(head) && record.localTakeovers?.find(item => sameTarget(item.target, watch.target))
          ?.userDrafts?.some(item => item.messageId === head)
        if (!ownHead) takeover(thread.id, head)
      }
      if (head && !watch && participants.some(participant => {
        const durableHead = index.operations.get(thread.id)?.findLast(item => item.messageId)?.messageId
        const baseline = participant.lastUserMessageId !== undefined ? participant.lastUserMessageId : previous ?? durableHead
        return baseline !== undefined && head !== baseline && (participant.lastUserMessageId !== undefined || durableHead !== undefined || !knownUserMessages.has(head))
      }) && !machineHead()) takeover(thread.id)
      if (watch && this.connected(thread)) {
        // Takeover above can change the record. Compare against the record as it now stands before changing it.
        const observed = read(), live = observed.watches!.find(item => item.id === watch.id)!
        let paused = live.pausedByUserMessageId
        if (this.humanTurnRunning(thread, observed)) paused = head ?? 'unobserved-user-turn'
        else if (!this.options.control.hasPendingThreadWork(thread.id)
          || machineHead() && !this.userWorkPending(thread.id, observed) && (paused === 'unobserved-user-turn' || paused === head)) paused = null
        if (live.lastUserMessageId !== head || live.pausedByUserMessageId !== paused) changes.push(next => {
          const changed = next.watches!.find(item => item.id === watch.id)!
          changed.lastUserMessageId = head; changed.pausedByUserMessageId = paused
        })
      }
      if (participants.length && this.connected(thread) && this.recordIndex(read()).participating.get(thread.id)?.some(participant =>
        participant.lastUserMessageId !== head)) changes.push(next => {
        for (const request of next.requests) for (const participant of request.participants) if (participant.target.hostId === hostId && participant.target.threadId === thread.id && participant.state === 'participating') participant.lastUserMessageId = head
      })
    }
    // Each operation's delivery, read once for the pass rather than once per operation.
    const sends = this.options.control.watcherSendRecords(), deliveries = new Map<string, Readonly<AgentDelivery>>()
    for (const item of sends.deliveries) if (!deliveries.has(`${item.threadId}\n${item.draftId}`)) deliveries.set(`${item.threadId}\n${item.draftId}`, item)
    const failedDrafts = new Set(sends.followups.flatMap(item => item.status === 'failed' ? [item.draftId] : []))
    const aside = this.setAsideDrafts(sends.deliveries)
    const delivery = (operation: Readonly<WatcherOperation>) => operation.draftId === undefined ? sends.deliveries.find(item => item.draftId === undefined && item.threadId === operation.target.threadId)
      : deliveries.get(`${operation.target.threadId}\n${operation.draftId}`)
    const passHost = this.options.control.hostId()
    // A record loaded with prompt turns nothing reads lets go of them on its first pass, as every pass once did.
    if (!changes.length && !draft && !this.options.control.watcherNeedsPruning()
      && this.recordSettled(this.view(), snapshot, threads, delivery, failedDrafts, passHost, aside)) { this.pruneRemoteGuards(); return }
    this.options.control.mutateWatcher(next => {
      for (const change of changes) change(next)
      for (const operation of next.operations.filter(item => item.target.hostId === localId)) {
        const thread = threads.get(operation.target.threadId), moves = this.deliveryChange(operation, thread, delivery(operation), failedDrafts)
        if (moves.stopAccepted) operation.deliveryState = 'accepted'
        if (moves.creationFailed) {
          operation.deliveryState = 'failed'; operation.refusalCode = 'PROVIDER_UNAVAILABLE'; delete operation.creationUncertain
          this.refundPrompt(next, operation, 'PROVIDER_UNAVAILABLE')
        }
        if (moves.then === 'accepted') this.recordAccepted(next, operation)
        else if (moves.then === 'uncertain') operation.deliveryState = 'uncertain'
        else if (moves.then === 'queue-failure') this.recordQueueFailure(next, operation)
      }
      const watcherMessages = new Set(next.operations.flatMap(item => item.messageId ? [item.messageId] : []))
      for (const operation of next.operations) this.observeOutcome(operation, threads, id => watcherMessages.has(id), passHost)
      this.pruneReservations(next, snapshot, aside)
      for (const request of this.answeredWithoutWorkers(next, snapshot)) { request.state = 'closed'; request.closedAt = now() }
      for (const request of next.requests) if (this.requestDone(request, next, snapshot, threads, aside)) { request.state = 'closed'; request.closedAt = now() }
    }, draft)
    // A taken-over thread's fenced sends leave the queue once the takeover is in the record, in the order they were found.
    for (const operations of fenced) this.cancelTakenOver(operations)
    this.pruneRemoteGuards()
  }
  /**
   * What the end of an observe pass does to an operation's delivery, worked out without changing it: a Stop seen through
   * accepted, a start that never began failed, then the delivery it is now seen to have. `changes` says whether doing so
   * would change the operation; `recordSettled` asks only that, and the end of the pass does the rest.
   */
  private deliveryChange(operation: Readonly<WatcherOperation>, thread: AgentThread | undefined, sent: Readonly<AgentDelivery> | undefined, failedDrafts: ReadonlySet<string | undefined>) {
    const stopAccepted = operation.action === 'stop' && operation.deliveryState === 'uncertain' && Boolean(operation.commandId && !this.active.has(operation.id)
      && !this.options.control.watcherCommandOutstanding(operation.commandId) && thread && this.connected(thread) && thread.status === 'idle')
    const creationFailed = Boolean(operation.creationUncertain && thread && this.connected(thread) && this.options.host.watcherCreationPhase(thread.id) !== 'starting')
    // Its own message in the thread, looked for only when its delivery does not already say it was accepted.
    const seen = () => Boolean(operation.messageId && thread?.messages.some(item => item.role === 'user' && item.id === operation.messageId))
    const then = sent?.status === 'accepted' || seen() ? 'accepted' as const : sent?.status === 'uncertain' && !this.active.has(operation.id) ? 'uncertain' as const
      : failedDrafts.has(operation.draftId) ? 'queue-failure' as const : undefined
    const changes = stopAccepted || creationFailed || then === 'accepted' && operation.deliveryState !== 'accepted'
      || then === 'uncertain' && operation.deliveryState !== 'uncertain' || then === 'queue-failure' && !this.queueFailureRecorded(operation)
    return { stopAccepted, creationFailed, then, changes }
  }
  /**
   * Whether recording a queued send's failure again would leave the operation as it is: it is already failed with its
   * refusal, no refusal from its dispatch waits to replace that, and nothing it waits on could still make it uncertain.
   */
  private queueFailureRecorded(operation: Readonly<WatcherOperation>): boolean {
    return operation.deliveryState === 'failed' && operation.refusalCode !== undefined && !operation.creationUncertain && !this.dispatchRefusals.has(operation.id)
      && !(operation.action === 'start' && this.options.host.watcherCreationPhase(operation.target.threadId) === 'starting')
      && !this.options.control.watcherCommandOutstanding(operation.commandId)
  }
  /**
   * Whether the end of an observe pass would leave `record` as it is: no operation's delivery or outcome moves, no
   * reservation goes and no request closes. Asked of the record itself, without a copy, so an update that changes nothing
   * costs no copy and no comparison of the whole record. It must never answer yes when the pass would change something;
   * where the answer is not plain, as for a queued send that failed, it answers no and the pass decides as it always did.
   */
  private recordSettled(record: Readonly<WatcherRecord>, snapshot: AgentHostSnapshot, threads: ReadonlyMap<string, AgentThread>,
    delivery: (operation: Readonly<WatcherOperation>) => Readonly<AgentDelivery> | undefined, failedDrafts: ReadonlySet<string | undefined>, passHost: string | undefined,
    aside: ReadonlySet<string>): boolean {
    for (const operation of record.operations) if (operation.target.hostId === passHost
      && this.deliveryChange(operation, threads.get(operation.target.threadId), delivery(operation), failedDrafts).changes) return false
    let watcherMessages: Set<string> | undefined
    const isWatcherMessage = (id: string) => (watcherMessages ??= new Set(record.operations.flatMap(item => item.messageId ? [item.messageId] : []))).has(id)
    if (record.operations.some(operation => this.outcomeChange(operation, threads, isWatcherMessage, passHost))) return false
    if (record.reservations.some(reservation => !this.keepsReservation(record, snapshot, reservation, aside))) return false
    if (this.answeredWithoutWorkers(record, snapshot).length) return false
    return !record.requests.some(request => this.requestDone(request, record, snapshot, threads, aside))
  }
  /**
   * Whether an active request is done: every thread taking part has settled, nothing is left queued to Watcher or to them,
   * and no Watcher turn answering it still runs. A settle relinquishes its thread at once, so a turn settling several
   * threads would otherwise close its own request after the first (#1254). Asked last, since it reads Watcher's turn.
   */
  private requestDone(request: Readonly<WatcherRequest>, record: Readonly<WatcherRecord>, snapshot: AgentHostSnapshot, threads: ReadonlyMap<string, AgentThread>, aside: ReadonlySet<string>): boolean {
    const local = request.watcher.hostId === this.hostId(), master = local ? threads.get(request.watcher.threadId) : undefined
    return request.state === 'active' && request.participants.length > 0 && request.participants.every(item => {
      if (item.state !== 'participating') return true
      const local = item.target.hostId === this.hostId(), owner = local ? snapshot : this.owningSnapshot(item.target.hostId)
      const thread = local ? threads.get(item.target.threadId) : owner?.threads.find(thread => thread.id === item.target.threadId)
      return Boolean(owner?.connected && thread && this.connected(thread)
        && isWorkspaceThreadSettled(thread, owner.projects.find(project => project.id === thread.projectId)))
    })
      && (!local || !this.options.control.hasPendingThreadWork(request.watcher.threadId))
      && !record.operations.some(item => item.requestId === request.id && this.unresolved(item, aside))
      && !(master && isThreadTurnRunning(master) && record.current && key(record.current.target) === key(request.watcher)
        && this.turnRequest(master.id, record, master)?.id === request.id)
  }
  /**
   * Records what this host's thread now proves about an accepted start or send it owns: its outcome and the text-free
   * reference to the turn that answers it. An outcome nothing later can change is never moved again.
   */
  private observeOutcome(operation: WatcherOperation, threads: ReadonlyMap<string, AgentThread>, isWatcherMessage: (id: string) => boolean, hostId: string | undefined): void {
    const seen = this.outcomeChange(operation, threads, isWatcherMessage, hostId)
    if (!seen) return
    operation.outcome = seen.outcome; operation.outcomeAt = now()
    for (const field of REFERENCE_FIELDS) {
      const value = seen[field]
      if (value) operation[field] = value
      else delete operation[field]
    }
    if (seen.outcome === 'answered') this.answeredThisRun.add(operation.id)
  }
  /** What `observeOutcome` would record of an operation, or nothing when it would leave the operation as it is. */
  private outcomeChange(operation: Readonly<WatcherOperation>, threads: ReadonlyMap<string, AgentThread>, isWatcherMessage: (id: string) => boolean, hostId: string | undefined) {
    if (operation.target.hostId !== hostId || operation.action !== 'start' && operation.action !== 'send'
      || operation.deliveryState !== 'accepted' || operation.outcome && WATCHER_FINAL_OUTCOMES.has(operation.outcome)) return undefined
    const thread = threads.get(operation.target.threadId)
    if (!thread || !this.connected(thread)) return undefined
    const seen = watcherTurnOutcome(operation, thread, isWatcherMessage)
    if (!seen || seen.outcome === operation.outcome && seen.turnMessageId === operation.turnMessageId
      && seen.nativeTurnId === operation.nativeTurnId && seen.replyMessageId === operation.replyMessageId) return undefined
    return seen
  }
  /**
   * The start or send a thread's newest turn answers, which its news names: the brief whose own message began the turn,
   * or else the newest steer of Watcher's read into it. None when the turn is the user's own.
   */
  private answeringOperation(target: WatcherThreadTarget, thread: AgentThread, record: Readonly<WatcherRecord>): string | undefined {
    const turn = watcherLatestTurnMessageId(thread)
    if (!turn) return undefined
    const watcherMessages = new Set(record.operations.flatMap(item => item.messageId ? [item.messageId] : []))
    const briefs = record.operations.filter(item => (item.action === 'start' || item.action === 'send') && sameTarget(item.target, target)
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
    const held = outcome === 'working' && operation.deliveryState === 'queued' && operation.target.hostId === this.options.control.hostId()
      ? this.options.control.watcherQueuedSendHeld(operation.id) : null
    let thread: AgentThread | undefined
    try { thread = this.thread(operation.target) } catch { /* An unavailable thread still has its recorded outcome. */ }
    const turnIds = new Set([operation.turnMessageId, operation.nativeTurnId].filter(id => id !== undefined))
    const evidence = turnIds.size ? this.wakes.evidence.read(operation.target, Boolean(thread && this.connected(thread)))
      .filter(item => item.turnId !== undefined && turnIds.has(item.turnId)).slice(-20) : []
    const read: OutcomeRead = { outcome, reference: { target: operation.target, ...(operation.turnMessageId ? { turnMessageId: operation.turnMessageId } : {}),
      ...(operation.nativeTurnId ? { nativeTurnId: operation.nativeTurnId } : {}), ...(operation.replyMessageId ? { replyMessageId: operation.replyMessageId } : {}) },
    outcomeNote: outcome === 'background' && thread && operation.turnMessageId !== undefined && !watcherBriefTurnIsNewest(thread, operation.turnMessageId)
      ? BACKGROUND_MOVED_ON : held ? queuedSendHeld(held) : OUTCOME_NOTES[outcome],
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
    if (operation.action === 'stop') this.checkStopTurn(thread, record, operation.requestId)
    if (operation.action === 'start' || operation.action === 'send') {
      this.checkHumanTurn(thread, record, operation.delivery)
      this.pending(thread)
      // Only a start gives a thread its permission; a send leaves the thread's own as the user set it (#1145).
      if (operation.action === 'start') { this.checkPermission(thread, request); this.checkRemoteCeiling(request.id, thread.runtimeMode) }
      if (operation.expectedLastUserMessageId && operation.expectedLastUserMessageId !== nativeHead(thread)) refuse('TARGET_CHANGED', 'This thread received another instruction. Read it before sending.')
      if (operation.delivery === 'steer' && (thread.status !== 'running' || operation.expectedTurnId !== thread.lastTurn?.id)) refuse('TURN_CHANGED', 'The running turn changed. Nothing was steered.')
      if (operation.delivery !== 'queue' && operation.delivery !== 'steer' && thread.status === 'running') refuse('THREAD_BUSY', RUNNING_TURN_HOLD, true)
    }
    if (operation.action === 'settle') {
      this.checkSettlement(thread)
      const aside = this.setAsideDrafts()
      if (record.operations.some(item => item.id !== operation.id && key(item.target) === key(operation.target) && this.unresolved(item, aside))) refuse('DELIVERY_UNCERTAIN', 'This thread still has an outstanding delivery. Reconcile it before settling.')
    }
  }

  /**
   * A watch is the user's to give. A watched thread is Watcher's to keep going, so Watcher may take one with watch_thread
   * only while it answers the user's own message: the turn's latest user message must be the root or a continuation of
   * an active request the user started. A wake-up, a standing scope or Watcher's own initiative grants no watch.
   */
  /** Whether the current Watcher turn answers the user's own message in this request, its root or a continuation. */
  private answersUserNow(record: Readonly<WatcherRecord>, request: WatcherRecord['requests'][number]): boolean {
    const current = record.current
    const master = current && this.options.control.watcherSnapshot().threads.find(thread => thread.id === current.target.threadId)
    const head = master ? nativeHead(master) : null
    return !request.standingWatchId && head !== null && (request.rootUserMessageId === head || request.userFollowups?.some(item => item.messageId === head) === true)
  }
  /**
   * The user's active request whose root or recorded continuation is the current Watcher's newest user message, if any.
   * An observe pass hands in the record it reads and the current Watcher's thread, so it copies and refuses nothing.
   */
  private requestAnsweredByHead(record: Readonly<WatcherRecord> = this.record(), master?: AgentThread): WatcherRequest | undefined {
    const current = record.current
    const head = current && nativeHead(master ?? this.thread(current.target))
    return head ? record.requests.findLast(request => request.state === 'active' && !request.standingWatchId && !request.remoteOrigin
      && key(request.watcher) === key(current.target)
      && (request.rootUserMessageId === head || request.userFollowups?.some(followup => followup.messageId === head))) : undefined
  }
  /**
   * The user's active request the running Watcher turn answers: the one whose message this run last sent Watcher, or the
   * one a steer into a news turn opened, while that message is the thread's newest or the provider has yet to show it.
   * Otherwise, the one the newest message started or continued, unless that turn is Sotto's own.
   */
  private turnRequest(threadId: string, record: Readonly<WatcherRecord> = this.record(), master?: AgentThread): WatcherRequest | undefined {
    const head = master ? nativeHead(master) : this.headOf(threadId)
    const sent = this.currentSend(threadId, head), steer = this.lastSteer
    const active = (match: (request: WatcherRequest) => boolean): WatcherRequest | undefined => record.requests.findLast(request =>
      request.state === 'active' && !request.standingWatchId && !request.remoteOrigin && match(request))
    const steered = steer?.threadId === threadId && (head === steer.messageId || head === steer.headBefore) ? active(request => request.id === steer.requestId) : undefined
    if (steered) return steered
    if (sent) return sent.wakeUp ? undefined : active(request => request.rootUserMessageId === sent.messageId || request.userFollowups?.some(item => item.messageId === sent.messageId) === true)
    // A message of Sotto's starts and continues no request, so the newest message answers for news as well.
    return this.requestAnsweredByHead(record, master)
  }
  /** The last send this run made to Watcher's thread, while it is still the newest message or the provider has yet to show it. */
  private currentSend(threadId: string, head = this.headOf(threadId)): typeof this.lastSend {
    const sent = this.lastSend
    return sent?.threadId === threadId && (head === sent.messageId || head === sent.headAtSend) ? sent : undefined
  }
  private headOf(threadId: string): string | null {
    const thread = this.options.control.watcherSnapshot().threads.find(item => item.id === threadId)
    return thread ? nativeHead(thread) : null
  }
  private checkUserAskedWatch(): void {
    const current = this.record().current
    if (!(current && this.turnRequest(current.target.threadId)) && !this.requestAnsweredByHead()) {
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
    if (!MUTATIONS.has(name)) return watcherRefusal('PROVIDER_UNAVAILABLE', name === 'watch_thread' || name === 'unwatch_thread' || name === 'unsettle_thread' ? STILL_WATCHING : STILL_READING, true)
    const operation = progress.operationId ? this.record().operations.find(item => item.id === progress.operationId) : undefined
    return operation ? { ...watcherRefusal('DELIVERY_UNCERTAIN', STILL_DELIVERING, true), receipt: this.receipt(operation) }
      : watcherRefusal('DELIVERY_UNCERTAIN', STILL_ADMITTING, true)
  }
  private async invokeNow(threadId: string, name: WatcherToolName, args: unknown, progress: CallProgress): Promise<unknown> {
    // The room's New Watcher waits while a call runs, so it hears when the first starts and the last ends.
    if (this.invocations++ === 0) this.publish()
    try {
      this.checkCaller(threadId)
      if (this.changing) refuse('THREAD_BUSY', 'Wait for Watcher’s provider change before using its tools.', true)
      const parsed = watcherToolSchemas[name].input.safeParse(args)
      if (!parsed.success) refuse('INVALID_INPUT', 'This call has invalid or oversized arguments. Use the offered tool schema.')
      if (name === 'watch_thread') {
        this.checkUserAskedWatch()
        return { status: 'ok', watch: await this.assignWatch(parsed.data as WatcherToolInput<'watch_thread'>, undefined, 'watcher') }
      }
      if (name === 'unwatch_thread') {
        const result = await this.unwatchThread(parsed.data as WatcherToolInput<'unwatch_thread'>, undefined, 'watcher')
        return result.status === 'refused' ? result : { status: 'ok', target: (parsed.data as WatcherToolInput<'unwatch_thread'>).target, watched: false }
      }
      if (name === 'unsettle_thread') return await this.unsettleThread(threadId, parsed.data as WatcherToolInput<'unsettle_thread'>)
      if (name === 'list_machines') return await this.listMachines()
      if (name === 'keep_state') {
        const kept = await this.kept.keep(parsed.data as WatcherToolInput<'keep_state'>, now())
          .catch(() => refuse('HISTORY_UNAVAILABLE', 'Sotto could not read Watcher’s kept state just now, so nothing was kept and nothing kept was lost. Try again.', true))
        return { status: 'ok', kept }
      }
      if (name === 'read_state') {
        const kept = await this.kept.current()
          .catch(() => refuse('HISTORY_UNAVAILABLE', 'Sotto could not read Watcher’s kept state just now. Nothing kept was lost. Try read_state again.', true))
        const current = this.view().current, thread = current && this.options.control.watcherSnapshot().threads.find(item => item.id === current.target.threadId)
        const input = parsed.data as WatcherToolInput<'read_state'>, first = !input.cursor || input.cursor === 'restart'
        // Computed from live data at each read (#1274), never kept, so none of it can go stale. The watched threads, the
        // merge queue and the pending settles are read once, at the first page, and paged together, a hundred of each to a
        // page; a later page reads on from what the first one found.
        const threads = first ? this.stateThreads() : [], settles = first ? this.pendingSettles(new Map(threads.map(row => [key(row.target), row.title]))) : []
        const watching = threads.map(({ open, ...row }) => ({ ...row, pullRequests: open.map(item => item.summary) })), queue = watcherMergeQueue(threads)
        const rows: StatePageRow[] = Array.from({ length: Math.max(watching.length, queue.length, settles.length) },
          (_, at) => ({ watching: watching[at], queue: queue[at], settle: settles[at] }))
        const page = this.page('state', rows, input.cursor, 100), shown = page.rows as StatePageRow[]
        const staleNotes = this.staleNotes(kept, first ? threads : this.watching(this.state().watchedThreads))
        // Read, and only once the read is answered: a refused one, as for an expired cursor, leaves the reminder. The look
        // comes first, so a reminder owed but not yet noticed is not raised again after this read.
        this.lookAtState(); this.stateOwed = false
        return { status: 'ok', watching: shown.flatMap(row => row.watching ?? []), nextCursor: page.nextCursor,
          mergeQueue: shown.flatMap(row => row.queue ?? []), settlesFinishedThreads: this.settlesFinishedThreads(),
          pendingSettles: shown.flatMap(row => row.settle ?? []), kept, staleNotes,
          contextTokens: thread ? this.contextTokens(thread) : null, compactAtTokens: WATCHER_COMPACT_AT_TOKENS }
      }
      const input = parsed.data as { hostId?: string; target?: WatcherThreadTarget; project?: { hostId: string } }
      const hostId = input.hostId ?? input.target?.hostId ?? input.project?.hostId
      const requestId = 'requestId' in parsed.data ? parsed.data.requestId : undefined
      if (hostId && hostId !== this.hostId() && requestId && input.target) await this.reconcileRemote(hostId)
      // A paired host's projects are listed here, from its snapshot, so their permission is the one start and send hold to.
      if (hostId && hostId !== this.hostId() && ['list_threads', 'list_working_copies', 'read_thread'].includes(name)) {
        this.requireRemote(hostId, false)
        // The host is asked as any host can answer, and what Watcher asked for is taken from its full answer here (#1191).
        return this.slim(name, parsed.data, await this.remote!.read(hostId, { master: this.record().current!, call: { name, input: watcherHostInput(name, parsed.data) } } as WatcherHostRead))
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
        return this.slim(name, parsed.data, await this.dispatchRead(call, operation))
      }
      if (name === 'send_to_thread') {
        // The merge turn marks the send for Watcher's picture alone (#1339): the send is admitted, digested, retried and
        // forwarded without it, so it changes nothing about the send, and is remembered once the send is admitted.
        const { mergeTurn, ...send } = parsed.data as WatcherToolInput<'send_to_thread'>
        if (mergeTurn) progress.admitted = operation => this.noteMergeTurn(operation, mergeTurn.pullRequest)
        return await this.mutate(threadId, name, send, undefined, undefined, progress)
      }
      return await this.mutate(threadId, name, parsed.data as WatcherToolInput<'start_thread'> | WatcherToolInput<'stop_thread'>, undefined, undefined, progress)
    } catch (error) { return error instanceof Refusal ? error.result : watcherRefusal('PROVIDER_UNAVAILABLE', 'This Watcher call could not be completed. Check the operation receipt before trying again.', true) }
    finally { if (--this.invocations === 0) this.publish() }
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
      // This host closes its copy of a paired request once the threads it holds have settled, but cannot see the master's
      // turn going on to settle more (#1254). A new operation the master admitted opens the copy again, in the change that
      // records it (ADR-0073). Only Stop makes a copy stopped, and a stopped copy stays stopped.
      const reopens = Boolean(imported && request.remoteOrigin && request.state === 'closed')
      if (request.state !== 'active' && !reopens && !(imported && this.confirmedWorkerStop(imported, request))) {
        const stoppedTarget = 'target' in input ? input.target : undefined
        if (stoppedTarget && !record.watches?.some(watch => key(watch.target) === key(stoppedTarget))
          && record.requests.some(item => item.participants.some(participant => key(participant.target) === key(stoppedTarget) && participant.state === 'taken-over'))) refuse('THREAD_TAKEN_OVER', 'You took over this thread. Watcher stopped sending to it.')
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
      // A standing watch lasts until the user stops watching (ADR-0073, October 19): the user's own message takes back only
      // a thread watched for a request alone, so no takeover fences a request on a watched thread. A participation Watcher
      // stopped is refused below as stopped.
      const watchedTarget = record.watches?.some(watch => key(watch.target) === key(target))
      const takenOver = !watchedTarget && (name === 'send_to_thread' ? this.requestTakenOver(record, request, target)
        : !request.standingWatchId && record.requests.some(item => item.participants.some(participant => key(participant.target) === key(target) && participant.state === 'taken-over')))
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
      // A paired master decided whether its Watcher turn answers the user; this host cannot read that thread.
      if (thread && name === 'stop_thread') this.checkStopTurn(thread, record, request.id, Boolean(imported) || this.answersUserNow(record, request))
      if (thread && send) {
        this.checkHumanTurn(thread, record, (input as WatcherToolInput<'send_to_thread'>).delivery)
        // A send gives the thread no permission, so neither the new-thread default nor a host's hold-back limits it (#1145).
        const sent = input as WatcherToolInput<'send_to_thread'>
        if (sent.expectedLastUserMessageId && sent.expectedLastUserMessageId !== nativeHead(thread)) refuse('TARGET_CHANGED', 'This thread received another instruction. Read it before sending.')
        // Only the foreground turn and the thread's own queue hold a send, never background work, and a refusal says which (#1203).
        if (sent.delivery === 'now' && thread.status === 'running') refuse('THREAD_BUSY', RUNNING_TURN_HOLD)
        const queued = sent.delivery === 'now' && !remote ? this.options.control.pendingThreadWorkReason(thread.id) : null
        if (queued) refuse('THREAD_BUSY', queueHold(queued, this.preserveUserQueue(thread.id) && this.userWorkPending(thread.id, record)))
        // A queue the user must review first takes nothing more, as a delegated brief is refused, rather than hold it unsaid.
        const review = sent.delivery === 'queue' && !remote ? this.options.control.queueAwaitsReview(thread.id) : null
        if (review) refuse('THREAD_BUSY', queueHold(review, false))
        if (sent.delivery === 'steer' && thread.status !== 'running' && thread.lastTurn?.status !== 'running') refuse('STEER_UNAVAILABLE', NO_TURN_TO_STEER)
        if (sent.delivery === 'steer' && (!capabilitiesForThread(this.owningSnapshot(owner)!, thread).steer || !sent.expectedTurnId || sent.expectedTurnId !== thread.lastTurn?.id || thread.status !== 'running')) refuse('STEER_UNAVAILABLE', 'Steer needs a supported, confirmed running turn. Read the thread and its turn first.')
      }
      if (thread && name === 'settle_thread') {
        this.checkSettlement(thread)
        if (!remote && this.options.control.hasPendingThreadWork(thread.id)) refuse('DELIVERY_UNCERTAIN', 'Reconcile this thread’s pending delivery before settling.')
      }
      if (start || send) {
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
        if (reopens) { owned.state = 'active'; owned.closedAt = null }
        // A participation the user's message took from a watched thread before standing watches outlasted it, or one whose
        // generation fell behind its watch's, would refuse every send; the watch decides, so both move to one generation.
        // A paired host's thread keeps the generation its own host publishes.
        const watched = imported || remote ? undefined : next.watches?.find(watch => key(watch.target) === key(target))
        if (watched && (operation.generation !== watched.generation
          || next.requests.some(item => item.participants.some(worker => keptByWatch(worker, target) && (worker.state === 'taken-over' || worker.generation !== watched.generation))))) {
          operation.generation = alignGeneration(next, watched)
        }
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
    if (progress) { progress.operationId = admitted.operation.id; progress.admitted?.(admitted.operation) }
    if (admitted.retry) {
      // A retry reads its receipt again; only the start's first run says how many threads are working (#1183).
      const active = this.active.get(admitted.operation.id)
      if (active) { const answer = await active; if (typeof answer !== 'object' || answer === null || !('warning' in answer)) return answer; const { warning: _warning, ...rest } = answer; void _warning; return rest }
      return this.operationResult(name, admitted.operation, input)
    }
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
        // The user may have sent since admission; nothing is fenced for a stop that will not go.
        this.checkStopTurn(this.thread(operation.target), this.record(), operation.requestId)
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
    return this.operationResult(name, this.record().operations.find(item => item.id === operation.id)!, input, true)
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
  /**
   * The prompts the user set aside in their own thread with Continue with a new message (#1156), as `thread
draft`. Sotto
   * never sends one again and nothing confirms it, so a Watcher send carrying one stays unconfirmed for good and holds
   * nothing open: not its request, its thread's slot or a settle.
   */
  private setAsideDrafts(deliveries = this.options.control.watcherSendRecords().deliveries): ReadonlySet<string> {
    return new Set(deliveries.flatMap(item => item.setAside === true ? [`${item.threadId}
${item.draftId}`] : []))
  }
  /** Whether an operation still waits on its delivery: queued, dispatching, or unconfirmed with its prompt not set aside. */
  private unresolved(operation: Readonly<WatcherOperation>, aside: ReadonlySet<string>): boolean {
    if (operation.deliveryState === 'uncertain') return operation.draftId === undefined || operation.target.hostId !== this.hostId()
      || !aside.has(`${operation.target.threadId}
${operation.draftId}`)
    return operation.deliveryState === 'queued' || operation.deliveryState === 'dispatching'
  }
  /** Keeps a reservation only while its thread's delivery is unresolved, queued or still working for a participating request. */
  private pruneReservations(record: WatcherRecord, snapshot: AgentHostSnapshot, aside = this.setAsideDrafts()): void {
    record.reservations = record.reservations.filter(reservation => this.keepsReservation(record, snapshot, reservation, aside))
  }
  private keepsReservation(record: Readonly<WatcherRecord>, snapshot: AgentHostSnapshot, reservation: Readonly<WatcherRecord['reservations'][number]>, aside: ReadonlySet<string>): boolean {
    if (reservation.target.hostId !== this.hostId()) return true
    const request = record.requests.find(item => item.id === reservation.requestId)
    const participant = request?.participants.find(item => sameTarget(item.target, reservation.target))
    const thread = snapshot.threads.find(item => item.id === reservation.target.threadId)
    const operations = record.operations.filter(item => sameTarget(item.target, reservation.target))
    if (operations.some(item => item.deliveryState !== 'queued' && this.unresolved(item, aside))) return true
    if (participant?.state !== 'participating') return false
    if (operations.some(item => item.deliveryState === 'queued')) return true
    if (!thread && operations.every(item => item.deliveryState === 'failed')) return false
    if (!thread || !isThreadProviderConnected(snapshot, thread) || thread.clientConnected === false) return true
    return thread.status === 'running' || thread.lastTurn?.status === 'running' || Boolean(thread.requests.length || thread.backgroundWork?.length || thread.monitoring?.length)
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
  /** `firstRun`: the answer to the call that ran the operation, not to a retry reading its receipt again. */
  private operationResult(name: WatcherToolName, operation: WatcherOperation, input: WatcherToolInput<'start_thread'> | WatcherToolInput<'send_to_thread'> | WatcherToolInput<'stop_thread'>, firstRun = false): unknown {
    const base = { receipt: this.receipt(operation), limits: this.limits(operation) }
    // A refusal met at the writer keeps only its code. The writer's busy refusals are a turn that began meanwhile (#1203)
    // and the user's own turn, which Watcher may only steer.
    if (operation.refusalCode) {
      const watched = this.record().watches?.find(watch => key(watch.target) === key(operation.target))
      return { ...watcherRefusal(operation.refusalCode, operation.refusalCode === 'THREAD_TAKEN_OVER'
        ? watched ? 'The user sent this thread an instruction first, so this was not sent. The thread is still watched. Read it before sending again.'
          : 'You took over this thread. Watcher stopped sending to it.'
        : operation.refusalCode === 'THREAD_BUSY' ? watched?.pausedByUserMessageId ? 'The user’s own turn in this thread is running. Steer it, or send once it ends. Nothing was sent.' : RUNNING_TURN_HOLD
        : 'The operation could not be completed. Read its receipt before trying again.'), receipt: base.receipt }
    }
    if (name === 'start_thread') {
      const create = input as WatcherToolInput<'start_thread'>
      const thread = this.owningSnapshot(operation.target.hostId)?.threads.find(item => item.id === operation.target.threadId)
      if (!thread) return { ...watcherRefusal('DELIVERY_UNCERTAIN', 'The creation is recorded, but its thread is unavailable. This retry started nothing. Reconcile the original receipt.', true), receipt: base.receipt }
      return { status: 'ok', ...base, target: operation.target, creationReceiptId: operation.creationReceiptId!, firstPromptReceiptId: operation.firstPromptReceiptId!,
        effectiveChoices: { modelId: thread.modelId, reasoningEffort: thread.reasoningEffort ?? null,
          permission: thread.providerMode ? { kind: 'provider', choiceId: thread.providerMode } : { kind: 'runtime', mode: thread.runtimeMode ?? 'approval-required' },
          workingCopy: create.workingCopy, ...(create.baseRefChoiceId ? { baseRefChoiceId: create.baseRefChoiceId } : {}) }, ...this.roleBlock(operation.id),
        // Nothing is held back at any count; past ten working threads the start's own answer says so, for Watcher to tell
        // the user. A retry's does not: its thread may have finished long since, and it would count it again.
        ...firstRun && operation.target.hostId === this.hostId() ? this.workingWarning(operation.target.threadId) : {} }
    }
    if (name === 'send_to_thread') return { status: 'ok', ...base, delivery: operation.delivery }
    return { status: 'ok', ...base, state: this.operationState(operation.target), ...(name === 'stop_thread' ? { stopRequested: true } : {}) }
  }

  private requireRemote(hostId: string, mutation: boolean): void {
    const host = this.remote?.hosts().find(item => item.hostId === hostId)
    if (!host?.connected) refuse('HOST_DISCONNECTED', 'That host is disconnected. Its unconfirmed starts and sends are kept. Reconnect it to continue.', true)
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
        if (live.action === 'send') this.checkHumanTurn(this.thread(live.target), record, live.delivery)
        if (live.action === 'stop') this.checkStopTurn(this.thread(live.target), record, live.requestId)
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
      return { ...watcherRefusal('DELIVERY_UNCERTAIN', 'The host did not confirm this operation, so it stays unconfirmed. Reconnect and read the original receipt.', true), receipt: this.receipt(this.record().operations.find(item => item.id === operation.id)!) }
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
      })().catch(() => { this.recoveryNotice = 'A paired host could not be reconciled. Its unconfirmed starts and sends are kept until it is.' })
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
      // A replaced Watcher's starts and sends on this host are still tracked (#1325): their slots are freed and their receipts
      // read as the current Watcher's are, so a host where only they remain is reconciled too.
      if (!host.standingWatch && !owned.some(request => request.participants.some(item => item.target.hostId === host.hostId)
        || this.record().operations.some(item => item.requestId === request.id && item.target.hostId === host.hostId))
        && !this.view().reservations.some(item => item.target.hostId === host.hostId)
        && !this.view().operations.some(item => item.target.hostId === host.hostId && ['queued', 'dispatching', 'uncertain'].includes(item.deliveryState))) continue
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
        let masterOf: ((operation: Readonly<WatcherOperation>) => WatcherIdentity | undefined) | undefined
        for (const operation of this.record().operations.filter(item => item.target.hostId === host.hostId
          && ['dispatching', 'uncertain'].includes(item.deliveryState) && !this.active.has(item.id) && !projected.has(item.id))) {
          try {
            // The host keeps a receipt under the Watcher conversation that made it, so a replaced one's is read under its own.
            const result = watcherToolSchemas.read_operation.output.parse(await this.remote.read(host.hostId, { master: (masterOf ??= this.operationMasters())(operation) ?? master,
              call: { name: 'read_operation', input: { operationId: operation.id } } }))
            if (result.status === 'refused' && result.code === 'OPERATION_NOT_RECORDED') exact.set(operation.id, null)
            else if (result.status === 'ok' && result.receipt.operationId === operation.id && result.receipt.requestId === operation.requestId
              && key(result.receipt.target) === key(operation.target)) exact.set(operation.id, result.receipt)
          } catch { receiptFailed = true; this.recoveryNotice = 'An exact host receipt could not be read. That start or send stays unconfirmed.' }
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
              // The master owns prompt counts; only an exact failed receipt can refund one. The one change of state it takes
              // back from the owning host is a still-watched thread's participation that an older build had taken over.
              const revived = own.state === 'taken-over' && participant.state === 'participating' && participant.generation > own.generation
                && !own.automationStopped && Boolean(record.watches?.some(watch => key(watch.target) === key(participant.target)))
              if (participant.generation < own.generation || own.state !== 'participating' && !revived) continue
              own.generation = participant.generation; own.state = participant.state
              if (revived) delete own.takeover
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
        this.recoveryNotice = 'A paired host could not be reconciled. Its unconfirmed starts and sends are kept until it is. Other hosts continue to refresh.'
      }
    }
    const beforeObservation = digest(this.record())
    this.observe(this.options.control.watcherSnapshot(), new Set())
    if (beforeObservation !== digest(this.record())) await this.options.control.updateWatcher(() => undefined)
    this.publish()
  }
  /**
   * The Watcher conversation, current or in Watcher history, whose request each operation belongs to. Built once for a
   * reconcile pass that needs it, so a pass's reads do not each search the record.
   */
  private operationMasters(): (operation: Readonly<WatcherOperation>) => WatcherIdentity | undefined {
    const record = this.view(), identities = new Map<string, WatcherIdentity>()
    for (const identity of [...record.history, ...record.current ? [record.current] : []]) identities.set(key(identity.target), identity)
    const watchers = new Map(record.requests.map(request => [request.id, key(request.watcher)]))
    return operation => { const watcher = watchers.get(operation.requestId); return watcher === undefined ? undefined : identities.get(watcher) }
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
          const installed: WatcherStandingWatch = { ...watch, lastUserMessageId: head,
            pausedByUserMessageId: this.humanTurnRunning(thread, next) ? head ?? 'unobserved-user-turn' : null,
            remoteOrigin }
          ;(next.watches ??= []).push(installed)
          // A user send that reached this host before the watch did took the participation as if watched for a request
          // alone. The watch the desktop had already given decides, as recovery does, and the desktop takes the revival.
          if (next.requests.some(request => request.participants.some(item => keptByWatch(item, installed.target) && item.state === 'taken-over'))) alignGeneration(next, installed)
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
      // A copy this host closed is stopped as well, so no operation the master sent before its Stop opens it again.
      const changed = stops.some(item => !record.requests.some(request => request.id === item.request.id && request.state === 'stopped'))
        || record.operations.some(item => operations.has(item.id) && item.deliveryState === 'queued')
      if (changed) await this.options.control.updateWatcher(next => {
        for (const { request, ceiling } of stops) {
          let existing = next.requests.find(item => item.id === request.id)
          if (!existing) { existing = { ...request, state: 'stopped', closedAt: now(), participants: [], remoteOrigin: { clientId, master, creationOperationId: master.creationOperationId, ceiling } }; next.requests.push(existing) }
          if (existing.state !== 'stopped') { existing.state = 'stopped'; existing.closedAt = now() }
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
            if ((record.remoteAbsences?.length ?? 0) >= 1_000) refuse('DELIVERY_UNCERTAIN', 'This host cannot keep track of another missing thread. That start or send stays unconfirmed.')
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

  /** What Watcher is given of a read's full result (#1191): slim unless it asked for all of it. */
  private slim(name: WatcherToolName, input: unknown, result: unknown): unknown {
    const watched = this.wakes.watchedKeys()
    const thread = (target: WatcherThreadTarget) => this.owningSnapshot(target.hostId)?.threads.find(item => item.id === target.threadId)
    return watcherSlimRead(name, input, result, target => watched.has(key(target)), target => thread(target)?.lastTurn?.status === 'failed',
      target => thread(target)?.prototypeReady !== undefined)
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
    const record = this.record(), snapshot = this.snapshot(), watched = input.watchedOnly ? this.wakes.watchedKeys() : new Set<string>()
    // A thread waits on the cards of the threads it delegated to as well as its own (#1190): they are its to see through.
    const delegatedCards = new Map<string, { id: string; kind: 'question' | 'permission'; openTarget: WatcherThreadTarget }[]>()
    for (const child of snapshot.threads) if (child.delegatedBy && child.requests.length) {
      const hostId = child.hostId ?? this.hostId(), parent = key({ hostId, threadId: child.delegatedBy })
      delegatedCards.set(parent, [...delegatedCards.get(parent) ?? [], ...child.requests.map(card => ({ id: card.id, kind: card.kind, openTarget: { hostId, threadId: child.id } }))])
    }
    const rows = watcherOverview({ host: snapshot }, Date.now(), this.wakes.observations).filter(row => (!input.hostId || (row.thread.hostId ?? this.hostId()) === input.hostId)
      && (!input.project || row.thread.projectId === input.project.projectId && (row.thread.hostId ?? this.hostId()) === input.project.hostId)
      && (!input.group || row.group === input.group) && (!input.watchedOnly || watched.has(key({ hostId: row.thread.hostId ?? this.hostId(), threadId: row.thread.id })))
      && (input.includeSettled || !isWorkspaceThreadSettled(row.thread, this.owningSnapshot(row.thread.hostId ?? this.hostId())?.projects.find(item => item.id === row.thread.projectId))))
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
    const page = this.page(`threads:${digest([input.hostId, input.project, input.group, input.includeSettled, input.watchedOnly === true])}`, rows, input.cursor, input.limit)
    return { status: 'ok', rows: page.rows, snapshotRevision: page.revision, nextCursor: page.nextCursor, observedAt: now(), staleHosts: [],
      counts: Object.fromEntries(['Needs you', 'Ready for review', 'Working', 'Landing', 'Quiet', 'Idle'].map(group => [group, rows.filter(row => row.group === group).length])) }
  }
  private listProjects(input: WatcherToolInput<'list_projects'>) {
    if (input.hostId && input.hostId !== this.hostId()) this.requireRemote(input.hostId, false)
    const state = this.options.control.shell()
    const snapshots = [state.host, ...this.remote?.hosts().flatMap(host => this.owningSnapshot(host.hostId) ?? []) ?? []]
    // Read once per host: a paired host's limit reads its whole cached shell.
    const limits = new Map(snapshots.map(snapshot => [snapshot, this.permissionLimits(undefined, snapshot.hostId ?? this.hostId())]))
    const query = input.query?.toLowerCase()
    const rows = snapshots.filter(snapshot => !input.hostId || (snapshot.hostId ?? this.hostId()) === input.hostId).flatMap(snapshot => snapshot.projects.filter(item => !this.reservedProject(item.path)
      && (!input.projectId || item.id === input.projectId) && (!query || item.title.toLowerCase().includes(query) || item.path.toLowerCase().includes(query))).map(project => ({
      target: { hostId: snapshot.hostId ?? this.hostId(), projectId: project.id }, title: project.title, displayRoot: project.path,
      workers: snapshot.models.filter(model => model.ready).slice(0, 100).map(model => {
        let defaultPermission: ReturnType<WatcherService['permission']> | null = null
        try { defaultPermission = this.permission(model, undefined, limits.get(snapshot)) } catch { /* Explicitly incomparable. */ }
        return { provider: model.providerId, modelId: model.id, reasoningEfforts: model.reasoningEfforts ?? [], defaultPermission, permissionComparable: defaultPermission !== null }
      }), controlAvailable: snapshot.hostId === this.hostId() || Boolean(this.takingHost(snapshot.hostId)?.control),
      readsAvailable: snapshot.hostId === this.hostId() || Boolean(this.takingHost(snapshot.hostId)?.reads),
      readOnlyProfileAvailable: true, freshness: snapshot.connected ? 'fresh' : 'stale' })))
    const page = this.page(`projects:${digest([input.hostId ?? '', input.projectId, input.query])}`, rows, input.cursor, input.limit)
    return { status: 'ok', projects: page.rows, nextCursor: page.nextCursor, observedAt: now(), staleHosts: [] }
  }
  /**
   * This computer and every host the desktop holds a connection to, each with its host facts when it reports them (#1031).
   * A host that does not list host-facts, or whose read fails, reads unknown; one not connected now reads not connected.
   */
  private async listMachines() {
    const unknown = (note: string) => ({ factsState: 'unknown' as const, facts: null, note, runningThreads: null })
    const read = async (facts: () => Promise<HostMachineReport | undefined>, older: string) => {
      try {
        const report = await facts()
        return report ? { factsState: 'reported' as const, facts: report.facts, runningThreads: report.runningThreads } : unknown(older)
      } catch { return unknown(MACHINE_FACTS_UNREAD) }
    }
    const local = { hostId: this.hostId(), name: 'This computer', thisComputer: true, connected: true,
      ...(this.options.machineFacts ? await read(this.options.machineFacts, MACHINE_FACTS_UNREAD) : unknown(MACHINE_FACTS_UNREAD)) }
    const notConnected = { factsState: 'not-connected' as const, facts: null, note: MACHINE_NOT_CONNECTED, runningThreads: null }
    const stillConnected = (hostId: string) => this.remote?.hosts().some(item => item.hostId === hostId && item.connected) === true
    const remotes = await Promise.all((this.remote?.hosts() ?? []).filter(host => host.hostId !== this.hostId()).slice(0, WATCHER_MACHINES_MAX - 1).map(async host => {
      const facts = !host.connected ? notConnected
        : host.facts && this.remote?.machineFacts ? await read(() => this.remote!.machineFacts!(host.hostId), MACHINE_FACTS_OLDER) : unknown(MACHINE_FACTS_OLDER)
      // A connection that dropped while its facts were read is not connected, whatever the read came back with.
      const connected = host.connected && stillConnected(host.hostId)
      return { hostId: host.hostId, name: host.name?.trim().slice(0, 200) || 'Paired machine', thisComputer: false, connected,
        ...connected ? facts : notConnected }
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

  /** Whether the user's own turn holds a watched thread: Stop all leaves it running. */
  private userTurnHolds(target: WatcherThreadTarget, record: Readonly<WatcherRecord> = this.view()): boolean {
    return Boolean(record.watches?.find(watch => key(watch.target) === key(target))?.pausedByUserMessageId)
  }
  private stopAllScope(): { targets: WatcherThreadTarget[]; signature: string } {
    const record = this.view()
    const ownership = record.requests.filter(request => request.state === 'active').flatMap(request => request.participants
      .filter(item => item.startedBy === 'watcher' && item.state === 'participating' && !this.userTurnHolds(item.target, record))
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
        if (this.userTurnHolds(target)) refuse('THREAD_TAKEN_OVER', 'The user’s own turn is running in this thread, so it was not stopped.')
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
  close(): void { this.closed = true; clearTimeout(this.settleTimer); this.settleTimer = undefined; this.handoverOffer = null; this.overtakenHandovers.clear(); this.remoteOff?.(); clearTimeout(this.remoteTimer); this.remotePending.clear(); this.remoteFailures.clear(); this.remoteGuards.clear(); this.remoteProgress.clear(); this.pendingPromptTurns.clear(); this.wakes.close(); this.unsubscribe(); this.listeners.clear(); this.confirmations.clear(); this.pages.clear(); this.copyChoices.clear() }
}
