import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { isThreadProviderConnected, lastUserMessageIdOf, providerIdSchema, threadTakesSottoTools,
  type AgentCommand, type AgentHostSnapshot, type AgentModel, type AgentRuntimeMode, type AgentThread } from '../../shared/agents'
import { resolveModel } from '../../shared/modelCatalog'
import { withoutUltracode } from '../../shared/ultracode'
import { resolveNewThreadPermission, RUNTIME_MODE_ORDER } from '../../shared/newThreadDefaults'
import { capRuntimeMode, roleInForce, roleStartNote, startFromRole, WORKER_KINDS, type HeldPermission, type RoleField, type RoleStart, type WorkerRoleChoices } from '../../shared/workerRoles'
import { isThreadClosed, isThreadTurnRunning } from '../../shared/threadActivity'
import { countWorkingThreads, workingThreadsWarning } from '../../shared/workingThreads'
import { workerMachineHostId, type WorkerMachineSetting, type WorkerPlacementReceipt } from '../../shared/workerMachine'
import type { WatcherRefusal } from '../../shared/watcher'
import { HOST_CEILING_HOLD_WORDS, type HostCeilingHold } from '../../shared/desktopDefaults'
import type { PlacementAsk, WorkerPlacement } from './workerPlacement'
import type { DesktopBranchMoves } from './branchMoves'
import { branchStartWords, systemClockTime, type BranchStartReceipt } from '../../shared/branchMoves'
import { CHECK_HOLDS_THROUGH_BACKGROUND, checkWaitingWords, type CheckQueue } from './checkQueue'
import { WATCHER_REPLY_BYTES_MAX, watcherOutcomeSchema, type WatcherOutcome } from '../../shared/watcher'
import { cancelDelegationInputSchema, delegatedThreadsBelow, delegateInputSchema, delegationRefusalCodeSchema, delegationWorkSchema, readDelegationInputSchema,
  DELEGATION_BRIEF_MAX, DELEGATION_LEVELS_MAX, DELEGATION_PROMPTS_PER_THREAD, DELEGATION_VIEWS_MAX, DELEGATION_WAIT_MAX_SECONDS, DELEGATION_WORK_TITLES, RECORDED_REFUSALS,
  delegationAskedSchema, delegationHostHoldSchema, type DelegateInput, type DelegationWork, type DelegationNews, type DelegationOutcome, type DelegationRead, type DelegationRefusal, type DelegationRefusalCode, type DelegatedView, type DelegationView, type RefusedView } from '../../shared/delegation'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { WATCHER_FINAL_OUTCOMES, watcherBriefTurnIsNewest, watcherNewestTurnReply, watcherTurnOutcome } from './watcherOutcomes'
import { delegationNewsText, foldDelegationNews, heldWords, type DelegationNewsDetail } from './delegationNews'
import { WATCHER_QUIET_MS } from '../../shared/watcherOverview'
import type { AgentState } from '../../shared/agents'
import type { HostThreadsView } from './control'
import { RelayUnanswered, type HostDelegationRelay } from './delegationRelayHost'
import { DELEGATION_RELAY_ANSWER_GRACE_MS, DELEGATION_RELAY_WAIT_MAX_MS, type RelayedReply } from '../../shared/delegationRelay'

/** The commands delegation sends on a thread's behalf: create the delegated thread, send it a brief, stop it. */
export type DelegationCommand = Extract<AgentCommand, { type: 'create-thread' | 'manual-send' | 'interrupt' }>
/** What the coordinator tells delegation, and asks of it (ADR-0081). Main-only; never crosses IPC or a socket. */
export interface DelegationControlHooks {
  /** The user's own command on a thread, never one of Sotto's: a send pauses delegated sends to it, a Stop cascades. */
  userCommand(command: AgentCommand, threadId: string | undefined, answersQuestion: boolean): void
  /**
   * Every snapshot the coordinator accepts. Reads it without copying it; `threads` looks its threads up by ID, when the
   * coordinator can, so the pass reads only the threads its delegations name (#925 step 5).
   */
  observe(snapshot: AgentHostSnapshot, threads?: HostThreadsView): void
  /** The delegated threads whose turns delegation is following, kept in the observed set. */
  observedThreadIds(): readonly string[]
  /** The message ID a delegation gave its brief, so the brief's turn is known by it from the first echo. */
  messageIdFor(draftId: string): string | undefined
  /** Whether a message is one of delegation's briefs, so a thread's watcher never takes it for the user's own. */
  ownsMessage?(messageId: string): boolean
  /**
   * A number that moves whenever a message stops being one of delegation's briefs, as when an old delegation is let go,
   * so Watcher reads again a thread whose newest message it took for a brief (#925 step 5).
   */
  briefsRevision?(): number
  /** The guard a delegated brief carries to the provider's writer, asked again after the thread's preparation. */
  guardFor(draftId: string): (() => void) | undefined
  /**
   * The words of a delegating thread's hidden news as it is sent (ADR-0081, October 19, 2026), from delegation's own
   * record: an answered delegation's reply labelled as the delegated thread's words, and why a brief was never sent.
   */
  newsText?(threadId: string, news: readonly DelegationNews[]): string | undefined
}
/** The coordinator as delegation uses it: its threads, its commands, the user's composer and its wake-ups. */
export interface DelegationCoordinator {
  hostId(): string | undefined
  watcherSnapshot(): AgentHostSnapshot
  configuration(): { readonly newThreadRuntimeMode?: AgentRuntimeMode | undefined; readonly newThreadModelId?: string | undefined; readonly newThreadReasoningEffort?: string | undefined }
  useDelegation(hooks: DelegationControlHooks): () => void
  commandFromDelegation(command: DelegationCommand, guard: () => void): Promise<AgentState>
  hasPendingThreadWork(threadId: string): boolean
  /** Why a thread's own queue or sends hold its next prompt, when they do; a held queue refuses a brief at admission. */
  pendingThreadWorkReason?(threadId: string): string | null
  hasUserDraft(threadId: string): boolean
  /** Restores a settled thread a brief is queued for, as new work does; nothing when it is not settled. */
  reopenSettledForWork?(threadId: string): Promise<void>
  refreshDelegationObservation(): void
  deliverWakeUp(threadId: string, news: DelegationNews, options: { readonly tool: boolean }): Promise<void>
}
export interface DelegationHost {
  setDelegatedBy(threadId: string, delegatingThreadId: string): Promise<void>
  /** Lets delegation's guarded commands through to the provider, as Watcher's are. */
  admitDelegationCommands?(): void
  threadMessage(threadId: string, messageId: string): { readonly id: string; readonly role: string; readonly text: string } | undefined
}
export interface DelegationServiceOptions {
  /** Sotto's data folder: the delegation record lives in it, and its reserved project folders are found from it. */
  readonly directory: string
  readonly control: DelegationCoordinator
  readonly host: DelegationHost
  readonly historyEnabled: () => boolean
  /** Whether a thread has Sotto's pull request tools, for babysitting news a wake-up may be folded with. */
  readonly tool?: (threadId: string) => boolean
  /**
   * The user's worker roles, present only while that Owl feature is on (#1041): a new thread's model, effort and
   * permission come from its kind of work unless the call names them. Read once per `delegate` call, in admission.
   */
  readonly roles?: () => WorkerRoleChoices
  /**
   * Where a delegated thread starts (#1032), present only while the Owl feature `cross-machine-work` is on and Watcher runs:
   * the machine list a delegating thread reads, the placement a start that names a machine or a system asks for, a
   * machine's saved name, and where new workers start. A delegated thread starts on This computer for now, whatever the
   * setting says, until delegation reaches other machines (#1316).
   */
  readonly machines?: {
    list(): Promise<unknown>
    place(ask: PlacementAsk, project: { readonly hostId: string; readonly projectId: string }, setting: WorkerMachineSetting): Promise<WorkerPlacement | WatcherRefusal>
    name(hostId: string): string | undefined
    setting(): WorkerMachineSetting
  }
  /**
   * Starting a new delegated thread from the delegating thread's branch (#1033), present only while Work across machines
   * is on: the branch, or for a test run a snapshot of uncommitted work too, lands in the project's incoming ref for the
   * new thread's worktree, and is let go again when the start is refused before it runs.
   */
  readonly branchMoves?: Pick<DesktopBranchMoves, 'forStart' | 'forgetHere'>
  /**
   * This machine's checks (#1312), present only while Work across machines is on and `test_run` is offered: a new thread
   * started as a check waits in the queue until the check ahead of it on this machine has finished, then starts. Absent, a
   * check starts at once, as any start does.
   */
  readonly checks?: CheckQueue
  /** A time of day as the user's computer writes it in the interface language, for when a check's snapshot was taken. */
  readonly clockTime?: (at: Date) => string
  /**
   * Bringing changes back (#1030), on only while Work across machines is on: a new delegated thread's own worktree is made
   * from the delegating thread's branch, so its commits can be brought back to it. Off, it is made as any new worktree is.
   */
  readonly bringBack?: boolean
  /**
   * The user's new-thread default as this machine may use it, in place of its own coordinator's (#1310). A headless host
   * gives it: the desktop defaults its desktop last sent, held to Ask for approval when it was never told them or that
   * desktop may not answer there, with why. Absent, the coordinator's own new-thread default applies, as on the desktop.
   */
  readonly newThreadCeiling?: () => { readonly mode: AgentRuntimeMode; readonly held?: HostCeilingHold }
  /**
   * The warning a start's result carries while more than ten threads are working on this machine after it, counted on
   * this machine's own list. Absent, This computer's words, which mention its battery.
   */
  readonly warning?: (count: number) => string | undefined
  /**
   * The desktop's side of the relay (#1316, Owl `cross-machine-work`): threads on other machines that delegate here, by
   * the window's key for each (`host:<hostId>:<threadId>`), as the relay last heard them ask, and how their news goes back
   * to their machine. Such a thread is admitted as one of this computer's own, under the same rules: its levels, its turn's
   * root and its permission are its machine's word, which can only narrow a start.
   */
  readonly relayedCallers?: {
    caller(threadId: string): RelayedCaller | undefined
    /** With each answered delegation's reply, cut as `read_delegation` cuts it, so the wake-up there carries it (ADR-0105 decision 6). */
    tell(threadId: string, news: DelegationNews, replies: readonly RelayedReply[]): Promise<void>
  }
  /**
   * A headless host's side of the relay (#1316, Owl `cross-machine-work`): a thread here delegates to a thread on another
   * machine through the desktop that relays, while one is connected.
   */
  readonly relay?: Pick<HostDelegationRelay, 'start' | 'holds' | 'holdsThread' | 'read' | 'cancel' | 'list' | 'useDelivery' | 'awayWords' | 'detail'>
  /** The clock a held background outcome's release reads, and how it waits for it; tests give their own. */
  readonly now?: () => number
  readonly schedule?: (callback: () => void, delay: number) => () => void
}
/** A thread on another machine that delegates through the desktop relay (#1316), as its machine says it. */
export interface RelayedCaller {
  /** The window's key for it, `host:<hostId>:<threadId>`. */
  readonly id: string
  /** This computer's copy of its project, found by GitHub origin. */
  readonly projectId: string
  readonly runtimeMode: AgentRuntimeMode
  /** How many threads delegated above it on its machine. */
  readonly levels: number
  readonly rootUserMessageId: string
  readonly callerMessageId?: string | undefined
}
/** What a relayed start asked that the relay does not carry yet (#1316 part 1): a branch to start from. */
export const RELAY_NO_BRANCH = 'A thread started on another machine cannot start from your branch yet. Leave out from_my_branch and test_run, or start it on this machine. Nothing was started.'
/** A second brief to a thread on another machine, which the relay does not carry yet (#1316 part 1). */
export const RELAY_SEND_LATER = 'That thread is on another machine, and Sotto cannot send it another brief from here yet. Start a new delegation instead, or ask the user to send it there. Nothing was sent.'
/** A start's worker role as the `delegate` result says it (#1041). Never saved: a retry's result has none. */
interface RoleReceipt { readonly work: DelegationWork; readonly named: RoleField[]; readonly note: string }

const now = (): string => new Date().toISOString()
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const nativeHead = (thread: AgentThread): string | null => lastUserMessageIdOf(thread) ?? thread.summary?.lastUser?.id ?? null
/** Whether a thread's message is one of Sotto's wake-ups, by the host's own record of the send, never by its words. */
const isWakeUpOf = (thread: AgentThread, messageId: string): boolean =>
  thread.wakeUpMessageIds?.includes(messageId) === true || thread.messages.some(message => message.id === messageId && message.wakeUp === true)
/**
 * A delegated thread's newest message from the user's side that is not one of Sotto's wake-ups: the user's own, or a
 * brief. A wake-up (a resume note after a restart, babysitting's news, a delegation's) is Sotto's, not an instruction of
 * the user's, so it never makes a brief read as landing on top of one. Where the messages before it are not loaded, the
 * head stands as the host gives it, which can only refuse a brief, never let one through on a guess.
 */
const userHead = (thread: AgentThread): string | null => {
  const head = nativeHead(thread)
  if (head === null || !isWakeUpOf(thread, head)) return head
  const at = thread.messages.findIndex(message => message.id === head)
  if (at === -1) return head
  for (let index = at - 1; index >= 0; index--) {
    const message = thread.messages[index]!
    if (message.role === 'user' && !isWakeUpOf(thread, message.id)) return message.id
  }
  return thread.earlierAvailable ? head : null
}
const id = z.string().min(1).max(512)
const REFUSAL_MESSAGE_MAX = 4_000
/** The newest refused delegations kept, across every thread, so a thread that keeps asking cannot grow the record. */
const REFUSALS_MAX = 500
/** Why a delegation ended before its brief was delivered: the outcome each of these reads as. */
const failureSchema = z.enum(['target-changed', 'paused', 'stopped', 'provider', 'restarted'])
type Failure = z.infer<typeof failureSchema>
const FAILURE_OUTCOMES: Record<Failure, WatcherOutcome> = { 'target-changed': 'paused', paused: 'paused', stopped: 'stopped', provider: 'failed', restarted: 'unknown' }
/**
 * What happened to a brief that was never sent, by why (October 19, 2026): what happened, that nothing reached the
 * delegated thread, and what to do. Never the delegated thread's words, and never a code.
 */
const FAILURE_NOTES: Record<Failure, string> = {
  'target-changed': 'The user sent their own message in the delegated thread before this brief went, so Sotto did not send it. Nothing was sent. Call read_delegation on its newest delegation to see what the user asked, then send again if the work is still needed.',
  paused: 'The user\'s own work in the delegated thread held this brief when it was due: their turn there, a message they were typing, or their paused queue there. Nothing was sent. Send again once that has ended, if the work is still needed.',
  stopped: 'It was stopped before the brief was sent. Nothing was sent, and nothing more will come of it.',
  provider: 'Sotto could not send this brief: the delegated thread was gone or could not take it, or its provider refused it. Nothing was sent. Call read_delegation with no delegation to see what is ready, then send again or start a new delegation.',
  restarted: 'Sotto restarted before this brief was sent, and a brief waiting for its thread is not kept across a restart. Nothing was sent. Send it again if the work is still needed.',
}
/** Why a send is refused when the delegated thread's own queue holds its next prompt until the user acts there. */
const QUEUE_HELD: Record<string, string> = {
  'paused-followups': 'That delegated thread\'s own queue is paused after a turn there that stopped or did not finish, and only the user can resume or clear it, so it would take no brief until then. Nothing was sent.',
  'failed-followups': 'A queued message in that delegated thread failed to send, and only the user can resume or clear it, so it would take no brief until then. Nothing was sent.',
  'uncertain-send': 'A message to that delegated thread has an unknown result, and only the user can check it there, so it would take no brief until then. Nothing was sent.',
}
const recordSchema = z.object({
  id: z.uuid(), delegatingThreadId: id, delegatedThreadId: id, action: z.enum(['start', 'send']), work: delegationWorkSchema,
  /** The user's message to the delegating thread this delegation counts against: its turn's budget (decision 5). */
  rootUserMessageId: id, retryKey: z.uuid().optional(), inputDigest: z.string().length(64),
  draftId: z.uuid(), messageId: z.uuid(), expectedLastUserMessageId: id.nullable(),
  deliveryState: z.enum(['queued', 'dispatching', 'accepted', 'uncertain', 'failed']), failure: failureSchema.optional(),
  outcome: watcherOutcomeSchema.optional(), outcomeAt: z.iso.datetime().optional(),
  turnMessageId: id.optional(), nativeTurnId: id.optional(), replyMessageId: id.optional(),
  /** The outcome the delegating thread was last told, by a call's result, a read or a wake-up; a change since is news. */
  told: watcherOutcomeSchema.optional(),
  /** Counts against the prompt budget. A brief refused before anything was sent does not. */
  charged: z.boolean(),
  /** How long the `delegate` call waited for the outcome and when it began; the window's card says it (decision 8). */
  waitSeconds: z.number().int().min(0).max(DELEGATION_WAIT_MAX_SECONDS).optional(), waitStartedAt: z.iso.datetime().optional(),
  /** When the call returned with the brief still working, so its outcome reaches the delegating thread as a wake-up. */
  wentOnAt: z.iso.datetime().optional(),
  /** The delegating thread's newest message when it called, a wake-up's included: the turn the window's card goes in. */
  callerMessageId: id.optional(),
  /** Why the outcome became unknown, which the window's card says: a restart, a brief never confirmed, or a thread gone. */
  unknownBecause: z.enum(['restarted', 'unconfirmed', 'gone']).optional(),
  /**
   * When a background outcome was released: its thread sat idle, no turn running, for twenty minutes, and the work its turn
   * left running was never seen to end (#1263). Whether the delegating thread has been told so, by a wake-up or a read.
   */
  releasedAt: z.iso.datetime().optional(), releaseTold: z.literal(true).optional(),
  /**
   * A start on a headless host whose role asked for more than Ask for approval and got Ask for approval because the host had
   * no desktop defaults yet, or no desktop that sent them may answer there (#1310): what the desktop's roster says.
   */
  held: delegationHostHoldSchema.optional(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict()
type DelegationRecord = z.infer<typeof recordSchema>
const linkSchema = z.object({ threadId: id, delegatingThreadId: id, createdAt: z.iso.datetime(),
  /** The delegated thread's newest user message as the delegating thread last saw it, which every send carries (decision 6). */
  seenHead: id.nullable() }).strict()
type DelegationLink = z.infer<typeof linkSchema>
const RECORDS_MAX = 2_000
/**
 * A delegation main refused under ADR-0081's rules when it was asked for: outcome `refused`, with the rule and its plain
 * words. Nothing was started or sent, so it names no started thread, holds no start slot, charges no budget and is never
 * news: the call that asked for it was told.
 */
const refusedSchema = z.object({ id: z.uuid(), delegatingThreadId: id, action: z.enum(['start', 'send']), work: delegationWorkSchema,
  /** The thread a refused send named, when it is one this thread delegated to. A refused start names none. */
  delegatedThreadId: id.optional(),
  /** The provider a refused start named. */
  provider: providerIdSchema.optional(),
  code: delegationRefusalCodeSchema, message: z.string().min(1).max(REFUSAL_MESSAGE_MAX),
  /**
   * The machine or system a start refused as `MACHINE_UNAVAILABLE` asked for (#1310), which its card names. Only a call
   * Work across machines offers a machine or system to can carry one; a record from before it has none.
   */
  asked: delegationAskedSchema.optional(),
  /** Refused because no desktop that relays was connected to this host (#1316), which its card says in Zach's words. */
  away: z.literal(true).optional(),
  /** Refused by the desktop this host relayed it to (#1316), which its card says. */
  relayed: z.literal(true).optional(),
  /** The user's message to the delegating thread the call answered, when Sotto can find one (decision 3). */
  rootUserMessageId: id.optional(),
  /** The delegating thread's newest message when it called, a wake-up's included: the turn the call was made in. */
  callerMessageId: id.optional(),
  createdAt: z.iso.datetime() }).strict()
type RefusedDelegation = z.infer<typeof refusedSchema>
/** How a new delegated thread is created, as admission chose it. */
interface DelegatedStart {
  /** A title the delegating thread gave is a deliberate name, kept as a user's is; without one, Sotto's naming applies. */
  readonly projectId: string; readonly title: string; readonly titleSource: 'user' | 'default'; readonly modelId: string; readonly reasoningEffort?: string
  readonly runtimeMode?: AgentRuntimeMode; readonly providerMode?: string; readonly workingCopy: 'shared' | 'independent'
  /** The move that landed the delegating thread's branch for this thread's worktree (#1033). */
  readonly startFromMove?: string
  /** A new worktree starts from the delegating thread's branch, so its commits can be brought back to it (#1030). */
  readonly baseBranch?: string
}
/** The branch the delegating thread works on, as its folder was last read; none for a detached HEAD or a folder that is no repository. */
function callerBranch(caller: AgentThread): string | undefined {
  const worktree = caller.worktree
  return (worktree?.git ? worktree.git.branch : worktree?.branch) ?? undefined
}
/** A delegating thread's branch landed for a new thread to start from (#1033), and when its check's snapshot was taken. */
interface LandedBranch { readonly moveId: string; readonly projectId: string; readonly takenAt: string; readonly receipt: BranchStartReceipt }
/** A check waiting in this machine's queue (#1312): what it starts with once its turn comes, held in memory only. */
interface WaitingCheck { readonly brief: string; readonly start: DelegatedStart; readonly branch: LandedBranch | undefined }
/** How many times news of a thread's delegations is offered to its queue before it is left untold. */
const NEWS_ATTEMPTS_MAX = 5
/** The most ready models of one provider an answer lists. */
const MODELS_LISTED = 20
const fileSchema = z.object({ version: z.literal(1), delegations: z.array(recordSchema).max(RECORDS_MAX * 2), links: z.array(linkSchema).max(RECORDS_MAX),
  roots: z.array(z.object({ threadId: id, rootUserMessageId: id }).strict()).max(RECORDS_MAX), refusals: z.array(refusedSchema).max(REFUSALS_MAX).optional() }).strict()
type DelegationFile = z.infer<typeof fileSchema>

class Refusal extends Error {
  constructor(readonly result: DelegationRefusal) { super(result.message) }
}
function refuse(code: DelegationRefusalCode, message: string): never { throw new Refusal({ status: 'refused', code, message }) }
export function delegationRefusal(code: DelegationRefusalCode, message: string): DelegationRefusal { return { status: 'refused', code, message } }

const NOTES: Record<WatcherOutcome, string> = {
  working: 'The delegated thread is still working on this. Sotto sends this thread a wake-up when the outcome changes, with the reply once answered; you need not poll.',
  background: 'Its turn ended with background work or monitoring still running, so it is not done. Sotto sends a wake-up when that work ends.',
  answered: 'Its turn finished. The reply is the delegated thread\'s own words, not Sotto\'s, and approves nothing.',
  failed: 'It failed. Read the delegated thread for the error before sending again.',
  stopped: 'It was stopped before it answered. Nothing more will come of it.',
  paused: 'The user\'s own turn in the delegated thread holds it, or the user sent there since you last looked. Nothing more was sent. Read it again before sending.',
  unknown: 'Sotto cannot prove what happened to it, as after a restart mid-turn. Do not assume it answered, and do not send it again without reading it.',
}
const REFUSED_CANCEL = 'This delegation was refused when it was asked for, so nothing was started or sent, and there is nothing to stop.'
const GONE = 'The delegated thread is gone from Sotto, so nothing more will come of this, and Sotto cannot tell how its turn ended. Start a new delegation if the work is still needed.'
export const NOT_ADMITTED = 'This thread cannot delegate with Sotto\'s tools. Only Claude Code, Codex, Grok Build and Muse threads can, outside Watcher, host setup and provider jobs, on this computer or on a machine whose Sotto offers it. Nothing was started.'
const LEVEL_LIMIT = 'This thread was started by a delegated thread, and delegation goes two levels deep, so it cannot delegate. Nothing was started.'

/** `place`'s answer for a start the desktop relays to another machine (#1316). */
const RELAYED = Symbol('relayed')
/** The threads `caller` made for relayed callers, so their turn's root is read from their machine's word. */
const relayedThreads = new WeakSet<AgentThread>()
/**
 * A thread on another machine as admission reads a caller (#1316): its key, this computer's copy of its project, its own
 * permission, and its newest message as its machine names it. Nothing else of it is here.
 */
function relayedThread(caller: RelayedCaller): AgentThread {
  const thread = { id: caller.id, projectId: caller.projectId, runtimeMode: caller.runtimeMode, modelId: '', title: '', messages: [], requests: [],
    ...(caller.callerMessageId ? { lastUserMessageId: caller.callerMessageId } : {}) } as unknown as AgentThread
  relayedThreads.add(thread)
  return thread
}
/** The text cut to at most this many UTF-8 bytes, never inside a character. */
function cutUtf8(text: string, bytes: number): string {
  const encoded = new TextEncoder().encode(text)
  if (encoded.byteLength <= bytes) return text
  let end = Math.max(0, bytes)
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--
  return new TextDecoder().decode(encoded.subarray(0, end))
}

/** The list `index` holds for `key`, made empty the first time it is asked for. */
function listed<T>(index: Map<string, T[]>, key: string): T[] {
  let list = index.get(key)
  if (!list) { list = []; index.set(key, list) }
  return list
}
/** The key `byRetryKey` files a record under: its delegating thread and retry key. */
const retryIndex = (callerId: string, retryKey: string): string => `${callerId}\n${retryKey}`

/**
 * Delegation between threads (ADR-0081): an ordinary thread starts threads and sends them briefs, under rules main
 * enforces, and reads each brief's outcome. Every call is the calling thread's, known from its tool token, rooted in the
 * user's latest message to it; the model passes no authority, and nothing a delegation sends answers or approves
 * anything. The record, `delegations.json`, holds identities and outcomes only, never a brief or a reply: a brief
 * waiting for its thread is held in memory, so a restart sends nothing and leaves what was unconfirmed `unknown`.
 */
export class DelegationService {
  private readonly store: AtomicJsonStore<DelegationFile>
  /** The record, oldest first. Change it only through `records =` and `add`, which keep the index by thread with it. */
  private entries: DelegationRecord[] = []
  /**
   * Each thread's part of the record, oldest first as in `entries`: by the thread that delegated, and by the thread
   * delegated to (#1291). A read of a few threads' delegations walks only theirs, however long the user's history.
   */
  private readonly byDelegating = new Map<string, DelegationRecord[]>()
  private readonly byDelegated = new Map<string, DelegationRecord[]>()
  /** Each record by its delegating thread and retry key, so a retry is found without walking the user's history. */
  private readonly byRetryKey = new Map<string, DelegationRecord>()
  private refusalEntries: RefusedDelegation[] = []
  /** Each delegating thread's refusals, oldest first as in `refusalEntries`. */
  private readonly refusedBy = new Map<string, RefusedDelegation[]>()
  private get records(): readonly DelegationRecord[] { return this.entries }
  private set records(records: DelegationRecord[]) {
    this.entries = records
    this.byDelegating.clear(); this.byDelegated.clear(); this.byRetryKey.clear()
    for (const record of records) this.indexed(record)
  }
  private get refusals(): readonly RefusedDelegation[] { return this.refusalEntries }
  private set refusals(refusals: RefusedDelegation[]) {
    this.refusalEntries = refusals
    this.refusedBy.clear()
    for (const refusal of refusals) listed(this.refusedBy, refusal.delegatingThreadId).push(refusal)
  }
  private readonly links = new Map<string, DelegationLink>()
  private readonly roots = new Map<string, string>()
  /** Briefs waiting for a busy delegated thread, held in memory only. */
  private readonly queuedBriefs = new Map<string, string>()
  /** Threads whose user's own turn pauses delegated sends until it ends (decision 6). */
  private readonly paused = new Set<string>()
  /** Delegations a `delegate` call is still answering: their news goes in the call's result, not a wake-up. */
  private readonly calling = new Set<string>()
  private readonly waiters = new Map<string, Set<() => void>>()
  private readonly sending = new Set<string>()
  /** Briefs being sent now, by delegation, until the send settles. */
  private readonly dispatches = new Map<string, Promise<void>>()
  /** Starts admitted whose delegated thread is still being created, which a snapshot without it does not end. */
  private readonly creating = new Set<string>()
  private readonly answeredThisRun = new Set<string>()
  private readonly dispatchRefusals = new Map<string, Failure>()
  /**
   * The starts this run made as checks (#1312), until each leaves its machine's queue, by the ticket each took in it as it
   * was asked for, and the other way round.
   */
  private readonly checkTickets = new Map<string, string>()
  private readonly ticketRecords = new Map<string, string>()
  private lettingGo: Promise<void> = Promise.resolve()
  /** The checks waiting their turn, with what each starts with; never saved, so a restart starts none of them. */
  private readonly waitingChecks = new Map<string, WaitingCheck>()
  /** Briefs a Stop fenced while they were on their way: their guard refuses them at the writer. */
  private readonly fenced = new Set<string>()
  /** Delegations whose new outcome the delegating thread has not been told yet, by delegating thread, with attempts. */
  private readonly untold = new Map<string, { readonly ids: Set<string>; attempts: number }>()
  private readonly telling = new Set<string>()
  private newsScheduled = false
  /** The wait for the next held background outcome's release, while one waits (`releaseHeld`). */
  private cancelRelease: (() => void) | undefined
  /** When each held background outcome's delegated thread was last seen working, so a release waits for twenty idle minutes. */
  private readonly lastWorking = new Map<string, number>()
  private readonly clock: () => number
  private readonly schedule: NonNullable<DelegationServiceOptions['schedule']>
  /** Delegating threads whose delegations changed since the window was last told, and who listens (#1029). */
  private readonly viewsChanged = new Set<string>()
  private readonly viewListeners = new Set<(threadIds: readonly string[]) => void>()
  private viewsScheduled = false
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  /** Moves whenever a record, and with it a brief's message, is let go (`DelegationControlHooks.briefsRevision`). */
  private briefsRevision = 0
  private unhook: (() => void) | undefined

  constructor(private readonly options: DelegationServiceOptions) {
    this.clock = options.now ?? Date.now
    this.schedule = options.schedule ?? ((callback, delay) => { const timer = setTimeout(callback, Math.max(0, delay)); timer.unref?.(); return () => clearTimeout(timer) })
    this.store = new AtomicJsonStore(join(options.directory, 'delegations.json'), input => fileSchema.parse(input),
      (): DelegationFile => ({ version: 1, delegations: [], links: [], roots: [] }))
  }

  /**
   * Reads the record and starts following the coordinator. A brief that was unconfirmed or still working when Sotto
   * stopped is `unknown` from now on and is never sent again (decision 7); a brief that was waiting is dropped unsent.
   */
  async recover(): Promise<void> {
    const file = await this.store.read().catch((): DelegationFile => ({ version: 1, delegations: [], links: [], roots: [] }))
    const time = now()
    this.records = file.delegations.map(record => {
      if (!this.open(record)) return record
      // Left untold, so the delegating thread hears it once (#1194): an idle one waiting for the outcome would otherwise wait forever.
      const unknown: DelegationRecord = { ...record, outcome: 'unknown', unknownBecause: 'restarted', outcomeAt: time, updatedAt: time }
      if (record.deliveryState === 'queued') { unknown.deliveryState = 'failed'; unknown.failure = 'restarted' }
      if (record.deliveryState === 'dispatching') unknown.deliveryState = 'uncertain'
      delete unknown.turnMessageId; delete unknown.nativeTurnId; delete unknown.replyMessageId
      return unknown
    })
    this.refusals = file.refusals ?? []
    for (const link of file.links) this.links.set(link.threadId, link)
    for (const root of file.roots) this.roots.set(root.threadId, root.rootUserMessageId)
    // A link whose thread record lost it, as when Sotto stopped between the two writes, is put back.
    const threads = new Map(this.options.control.watcherSnapshot().threads.map(thread => [thread.id, thread]))
    for (const link of this.links.values()) {
      const thread = threads.get(link.threadId)
      if (thread && thread.delegatedBy === undefined) await this.options.host.setDelegatedBy(link.threadId, link.delegatingThreadId).catch(() => undefined)
    }
    this.options.host.admitDelegationCommands?.()
    // News of relayed delegations reaches the thread that delegated as delegation's own does (#1316).
    this.options.relay?.useDelivery((threadId, news) => this.options.control.deliverWakeUp(threadId, news, { tool: this.options.tool?.(threadId) ?? false }))
    this.unhook = this.options.control.useDelegation({
      userCommand: (command, threadId, answersQuestion) => this.userCommand(command, threadId, answersQuestion),
      observe: (snapshot, threads) => this.observe(snapshot, threads),
      observedThreadIds: () => this.observedThreadIds(),
      messageIdFor: draftId => this.records.findLast(record => record.draftId === draftId && this.open(record))?.messageId,
      ownsMessage: messageId => this.records.some(record => record.messageId === messageId),
      briefsRevision: () => this.briefsRevision,
      guardFor: draftId => {
        const record = this.records.findLast(item => item.draftId === draftId && this.open(item))
        return record ? () => this.guardSend(record.id) : undefined
      },
      newsText: (threadId, news) => this.newsText(threadId, news),
    })
    await this.persist()
    // What a restart left unknown is news, told once; it never moves again and nothing is resent (decision 7).
    for (const record of this.records) {
      if (this.outcomeOf(record) === 'unknown' && record.told !== 'unknown' && (record.unknownBecause === 'restarted' || record.failure === 'restarted')) this.changed(record.id)
    }
  }
  close(): void {
    this.closed = true
    // Checks still waiting will never start, and a restart keeps none of them, so each lets go of the branch it would have
    // started from now, rather than leave its incoming ref behind (#1312).
    const waiting = [...this.waitingChecks]
    this.waitingChecks.clear()
    for (const [delegationId] of waiting) this.leaveQueue(delegationId)
    this.lettingGo = Promise.all(waiting.map(([, check]) => this.letGo(check.branch))).then(() => undefined)
    this.cancelRelease?.(); this.cancelRelease = undefined
    this.viewListeners.clear()
    this.unhook?.(); this.unhook = undefined
    for (const waiting of this.waiters.values()) for (const wake of waiting) wake()
    this.waiters.clear()
  }

  /** Settles once `close` has let go of the branches its waiting checks would have started from. */
  drained(): Promise<void> { return this.lettingGo }

  /**
   * The delegation a caller's call with this retry key made, from the record admission saves before anything is sent
   * (#1316): how the desktop relay finds what a relayed start made after its answer was lost, or after a restart.
   */
  retriedDelegation(callerId: string, retryKey: string): string | undefined { return this.retried(callerId, retryKey)?.id }
  /** Whether a delegation is still open, or a thread has one open: what the relay's record keeps whatever its size (#1316). */
  isOpen(delegationId: string): boolean { const record = this.record(delegationId); return record !== undefined && this.open(record) }
  hasOpen(delegatingThreadId: string): boolean { return (this.byDelegating.get(delegatingThreadId) ?? []).some(record => this.open(record)) }
  /** Whether this thread is offered `sotto_delegate` (decisions 1 and 2), asked at every launch and every call. */
  admits(threadId: string): boolean {
    if (this.closed) return false
    try { this.caller(threadId, this.snapshot()); return true } catch { return false }
  }

  async delegate(threadId: string, args: unknown, context: { readonly waitMs?: number } = {}): Promise<unknown> {
    const parsed = delegateInputSchema.safeParse(args)
    if (!parsed.success) {
      return this.admits(threadId) ? delegationRefusal('INVALID_INPUT', 'This call has invalid or oversized arguments. Use the offered tool schema. Nothing was started.')
        : delegationRefusal('NOT_ADMITTED', NOT_ADMITTED)
    }
    const input = parsed.data
    if (input.thread !== undefined && this.options.relay?.holdsThread(threadId, input.thread)) return delegationRefusal('UNKNOWN_THREAD', RELAY_SEND_LATER)
    // A check takes its place in this machine's queue as it is asked for, before its snapshot is taken (#1312), so a check
    // whose snapshot takes longer is never overtaken by one asked after it. A call that ends without a check keeps none.
    const checks = this.options.checks
    const ticket = checks && input.test_run === true && input.thread === undefined ? randomUUID() : undefined
    if (!checks || !ticket) return await this.ask(threadId, input, context)
    checks.join(ticket, () => this.checkTurn(ticket))
    try { return await this.ask(threadId, input, context, ticket) }
    finally { if (!this.ticketRecords.has(ticket)) checks.leave(ticket) }
  }
  private async ask(threadId: string, input: DelegateInput, context: { readonly waitMs?: number }, ticket?: string): Promise<unknown> {
    const placed = await this.place(threadId, input)
    if (placed === RELAYED) return await this.relayStart(threadId, input, context)
    if (placed && 'status' in placed) return placed
    const branch = await this.fromBranch(threadId, input)
    if (branch && 'status' in branch) return branch
    let admitted: { record: DelegationRecord; retry: boolean; start?: DelegatedStart; role?: RoleReceipt }
    try { admitted = await this.transaction(() => this.admit(threadId, input)) }
    catch (error) {
      // A start refused here never runs, so the branch landed for it is let go.
      await this.letGo(branch)
      return error instanceof Refusal ? await this.refused(threadId, input, error.result)
        : delegationRefusal('PROVIDER_UNAVAILABLE', 'Sotto could not start this delegation. Nothing was started.')
    }
    const record = admitted.record
    // A call that raced the first one with the same retry key copied a branch of its own, which no thread will use.
    if (admitted.retry) { await this.letGo(branch); return this.result(record) }
    const start = admitted.start && branch ? { ...admitted.start, workingCopy: 'independent' as const, startFromMove: branch.moveId } : admitted.start
    // A check waits for this machine's check ahead of it, in the order asked, before its thread is made (#1312). One
    // stopped while it was admitted holds no place, brief or snapshot: it goes on as any stopped start, which makes nothing.
    const live = this.record(record.id)?.deliveryState === 'queued'
    const waiting = start !== undefined && live && ticket !== undefined && this.queueCheck(record, input.brief, start, branch, ticket)
    this.calling.add(record.id)
    try {
      if (!waiting) await this.execute(record, input.brief, start)
      // A new thread that could not be made owns no branch, and nothing started from it. A waiting check's thread is
      // made once its turn comes, and its branch is let go then if it cannot be.
      const made = !admitted.start || waiting || this.snapshot().threads.some(thread => thread.id === record.delegatedThreadId)
      if (!made) await this.letGo(branch)
      // Nothing is held back at any count (#1183); past ten working threads on this computer a start's reply says so. The
      // new thread counts as working while its first brief is on its way or its turn has not ended, whatever its status
      // says yet; one whose brief failed, or whose turn already ended, counts only if it is working.
      const started = this.record(record.id)
      const pending = started !== undefined && !this.waitingChecks.has(started.id) && (started.deliveryState === 'queued' || started.deliveryState === 'dispatching'
        || started.deliveryState === 'uncertain' || started.deliveryState === 'accepted' && started.outcomeAt === undefined)
      const warning = admitted.start ? (this.options.warning ?? workingThreadsWarning)(countWorkingThreads(this.snapshot().threads, pending ? record.delegatedThreadId : undefined)) : undefined
      const waitMs = Math.max(0, Math.min((input.wait_seconds ?? DELEGATION_WAIT_MAX_SECONDS) * 1000,
        context.waitMs === undefined ? Infinity : context.waitMs - 2_000))
      if (this.open(this.record(record.id)!)) {
        // The window's card says how long this call waits, and that it went on when the wait ends first.
        this.update(record.id, saved => { saved.waitSeconds = Math.round(waitMs / 1000); saved.waitStartedAt = now() })
        if (waitMs > 0) await this.wait(record.id, waitMs)
        if (this.open(this.record(record.id)!)) this.update(record.id, saved => { saved.wentOnAt = now() })
      }
      const answer = await this.result(this.record(record.id)!)
      return { ...answer, ...admitted.role ? { role: admitted.role } : {}, ...admitted.start && placed ? { placement: placed } : {},
        ...admitted.start && branch && made ? { startedFrom: this.startedFrom(record.id, branch) } : {}, ...warning ? { warning } : {} }
    } finally { this.calling.delete(record.id); this.touched(record) }
  }

  /**
   * What the window shows of a thread's delegations (#1029), oldest first: the ones it made, every open one and the
   * newest finished or refused ones, and the briefs it was sent. Identities, outcome and timing from this service's own
   * record, never a brief, a reply or a refusal's words. Reads no snapshot, so the window may ask whenever a pane opens
   * or main names the thread.
   */
  views(threadId: string): { readonly made: DelegationView[]; readonly received: DelegatedView[] } {
    return this.viewsOf([threadId]).get(threadId)!
  }
  /**
   * `views` for several threads, each read from its own part of the record (#1291), so a read that needs many threads'
   * views, as the iPhone's Agents view does (ADR-0103), touches only their delegations, however long the history.
   */
  viewsOf(threadIds: readonly string[]): ReadonlyMap<string, { readonly made: DelegationView[]; readonly received: DelegatedView[] }> {
    const views = new Map<string, { readonly made: DelegationView[]; readonly received: DelegatedView[] }>()
    for (const threadId of threadIds) if (!views.has(threadId)) {
      views.set(threadId, { made: this.made(threadId), received: (this.byDelegated.get(threadId) ?? []).slice(-DELEGATION_VIEWS_MAX).map(record => this.view(record)) })
    }
    return views
  }
  /** What `threadId` delegated, oldest first: every open one and the newest finished or refused ones. */
  private made(threadId: string): DelegationView[] {
    const records = this.byDelegating.get(threadId) ?? [], refused = this.refusedBy.get(threadId) ?? []
    const made: DelegationView[] = []
    let finished = 0, next = refused.length - 1
    // Newest first through both lists at once: a refusal is a finished delegation that never started.
    const refusedAfter = (createdAt: string): void => {
      for (; next >= 0 && refused[next]!.createdAt > createdAt; next--) {
        if (finished < DELEGATION_VIEWS_MAX && made.length < DELEGATION_VIEWS_MAX * 2) { made.push(this.refusedView(refused[next]!)); finished++ }
      }
    }
    for (let index = records.length - 1; index >= 0 && made.length < DELEGATION_VIEWS_MAX * 2; index--) {
      const record = records[index]!
      refusedAfter(record.createdAt)
      if ((finished < DELEGATION_VIEWS_MAX || this.open(record)) && made.length < DELEGATION_VIEWS_MAX * 2) {
        made.push(this.view(record))
        if (!this.open(record)) finished++
      }
    }
    refusedAfter('')
    return made.reverse()
  }
  /**
   * The newest brief `threadId` was sent that Sotto still holds, for Tools › Agents when a row is opened: the user
   * message a delegation names in that thread, once it was sent, read by its ID from the thread's record, never from a
   * snapshot, and never a reply. Undefined when none is held, as with Keep local history off after a restart.
   */
  brief(threadId: string): string | undefined {
    return this.briefsOf([threadId]).get(threadId)
  }
  /**
   * `brief` for several threads, in the order asked, each read newest first from the briefs that thread was sent
   * (#1291) and stopping at the first one held.
   */
  briefsOf(threadIds: readonly string[]): ReadonlyMap<string, string> {
    const briefs = new Map<string, string>()
    for (const threadId of new Set(threadIds)) {
      const sent = this.byDelegated.get(threadId) ?? []
      for (let index = sent.length - 1; index >= 0; index--) {
        const record = sent[index]!
        if (record.deliveryState === 'queued') continue
        const message = this.options.host.threadMessage(threadId, record.messageId)
        if (message?.role === 'user') { briefs.set(threadId, message.text.slice(0, DELEGATION_BRIEF_MAX)); break }
      }
    }
    return briefs
  }
  /**
   * Hears which delegating threads' delegations changed, batched so a pass that moves many outcomes, for many threads,
   * tells the window once. Returns the way to stop listening.
   */
  onViewsChanged(listener: (threadIds: readonly string[]) => void): () => void {
    if (this.closed) return () => undefined
    this.viewListeners.add(listener)
    return () => { this.viewListeners.delete(listener) }
  }
  private view(record: DelegationRecord): DelegatedView {
    const outcome = this.outcomeOf(record)
    const outcomeAt = record.outcomeAt ?? (record.deliveryState === 'failed' ? record.updatedAt : undefined)
    // Recovery marks what was open when Sotto stopped `unknown`; a brief the provider never confirmed reads unknown without it.
    // A record saved before the reason was kept went unknown at a restart; an unconfirmed brief reads unknown before it is ended.
    const unknownWhy = outcome !== 'unknown' ? undefined : record.unknownBecause ?? (record.outcome === 'unknown' || record.failure === 'restarted' ? 'restarted' : 'unconfirmed')
    return { id: record.id, thread: record.delegatedThreadId, action: record.action, work: record.work, rootUserMessageId: record.rootUserMessageId,
      anchorMessageId: record.callerMessageId ?? record.rootUserMessageId, briefMessageId: record.messageId, outcome,
      ...(unknownWhy ? { unknownWhy } : {}), told: record.told === outcome, createdAt: record.createdAt, ...(outcomeAt ? { outcomeAt } : {}),
      ...(record.deliveryState === 'failed' ? { notSent: record.failure ?? 'provider' } : {}),
      ...(record.waitSeconds !== undefined && record.waitStartedAt ? { wait: { seconds: record.waitSeconds, startedAt: record.waitStartedAt, ...(record.wentOnAt ? { wentOnAt: record.wentOnAt } : {}) } } : {}),
      waiting: this.calling.has(record.id) && record.wentOnAt === undefined && this.open(record), ...(record.held ? { held: record.held } : {}) }
  }
  /** A refused delegation as the window shows it: the rule that turned it down, and the turn the call was made in. */
  private refusedView(refused: RefusedDelegation): RefusedView {
    const anchor = refused.callerMessageId ?? refused.rootUserMessageId
    return { id: refused.id, ...(refused.delegatedThreadId ? { thread: refused.delegatedThreadId } : {}), ...(refused.provider ? { provider: refused.provider } : {}),
      action: refused.action, work: refused.work, outcome: 'refused', refusal: refused.code, ...(refused.asked ? { asked: refused.asked } : {}), ...(refused.away ? { away: true as const } : {}), ...(refused.relayed ? { relayed: true as const } : {}),
      ...(refused.rootUserMessageId ? { rootUserMessageId: refused.rootUserMessageId } : {}), ...(anchor ? { anchorMessageId: anchor } : {}), createdAt: refused.createdAt }
  }
  /**
   * A delegation changed: the window hears, once the current pass is over, that the thread that made it and the thread
   * it went to, when it went to one, have something new to show.
   */
  private touched(record: { readonly delegatingThreadId: string; readonly delegatedThreadId?: string | undefined }): void {
    if (this.closed || !this.viewListeners.size) return
    this.viewsChanged.add(record.delegatingThreadId)
    if (record.delegatedThreadId !== undefined) this.viewsChanged.add(record.delegatedThreadId)
    if (this.viewsScheduled) return
    this.viewsScheduled = true
    queueMicrotask(() => {
      this.viewsScheduled = false
      const threadIds = [...this.viewsChanged]
      this.viewsChanged.clear()
      if (!threadIds.length || this.closed) return
      for (const listener of [...this.viewListeners]) { try { listener(threadIds) } catch { /* A listener's failure is its own. */ } }
    })
  }

  async read(threadId: string, args: unknown): Promise<unknown> {
    const parsed = readDelegationInputSchema.safeParse(args)
    if (!parsed.success) return delegationRefusal('INVALID_INPUT', 'Name the delegation by its ID, or leave it out to list them.')
    try {
      const snapshot = this.snapshot(), caller = this.caller(threadId, snapshot)
      if (parsed.data.delegation === undefined) return this.listing(caller, snapshot)
      const refused = this.refusedOf(caller.id, parsed.data.delegation)
      if (refused) return this.refusedResult(refused)
      // One relayed to another machine is read there, exactly, while the desktop is connected (#1316).
      if (this.options.relay?.holds(caller.id, parsed.data.delegation)) return await this.options.relay.read(caller.id, parsed.data.delegation)
      const record = this.owned(caller.id, parsed.data.delegation)
      return await this.result(record, true)
    } catch (error) { return error instanceof Refusal ? error.result : delegationRefusal('PROVIDER_UNAVAILABLE', 'Sotto could not read this delegation just now. Nothing was changed.') }
  }

  async cancel(threadId: string, args: unknown): Promise<unknown> {
    const parsed = cancelDelegationInputSchema.safeParse(args)
    if (!parsed.success) return delegationRefusal('INVALID_INPUT', 'Name the delegation to cancel by its ID. Nothing was stopped.')
    try {
      const caller = this.caller(threadId, this.snapshot())
      const refused = this.refusedOf(caller.id, parsed.data.delegation)
      if (refused) return { ...this.refusedResult(refused), note: REFUSED_CANCEL }
      if (this.options.relay?.holds(caller.id, parsed.data.delegation)) return await this.options.relay.cancel(caller.id, parsed.data.delegation)
      const record = this.owned(caller.id, parsed.data.delegation)
      if (!this.open(record)) return { ...(await this.result(record)), note: 'This delegation had already ended. Nothing was stopped.' }
      // A stop it asked for is not news to it, however it lands. A check still waiting its turn leaves the queue.
      const queued = this.waitingChecks.has(record.id)
      this.update(record.id, saved => { saved.told = 'stopped' })
      // A brief on its way is fenced as a Stop fences it: the writer refuses it, or it landed and its turn is stopped below.
      if (record.deliveryState === 'queued' || record.deliveryState === 'dispatching') this.fenced.add(record.id)
      if (record.deliveryState === 'queued') this.fail(record.id, 'stopped')
      else await this.dispatches.get(record.id)
      let stopping = false
      const current = this.record(record.id)!
      if (this.open(current)) {
        const thread = this.snapshot().threads.find(item => item.id === current.delegatedThreadId)
        if (thread && isThreadTurnRunning(thread) && this.answering(current, thread)) { await this.stopThreads([current.delegatedThreadId], new Set([caller.id])); stopping = true }
      }
      const answer = await this.result(this.record(record.id)!)
      if (queued) return { ...answer, note: `It was waiting for its turn among ${this.options.checks!.machine}'s checks, and Sotto took it out of the queue. Nothing was started.` }
      if (!stopping || !this.open(current)) return answer
      this.update(current.id, saved => { saved.told = 'stopped' })
      await this.persist()
      return { ...answer, note: 'Sotto asked the delegated thread to stop. Nothing more will be sent to it for this delegation; read it again for how its turn ended.' }
    } catch (error) { return error instanceof Refusal ? error.result : delegationRefusal('PROVIDER_UNAVAILABLE', 'Sotto could not cancel this delegation. Call read_delegation to see where it stands.') }
  }

  private snapshot(): AgentHostSnapshot { return this.options.control.watcherSnapshot() }
  /**
   * Where a new delegated thread starts (#1032): This computer, the only machine delegation reaches for now (#1316). A
   * machine or system the call named is placed as Watcher's starts are, and one that resolves anywhere else is refused in
   * plain words and recorded. With none named, a setting that puts new workers on another machine is noted, not followed.
   * Undefined when there is nothing to say: Work across machines is off, the call sends to a thread, or retries one. With
   * the feature off, a call naming a machine or system is refused as invalid, since the tool offers neither.
   */
  private async place(threadId: string, input: DelegateInput): Promise<WorkerPlacementReceipt | DelegationRefusal | typeof RELAYED | undefined> {
    const asks = input.machine !== undefined || input.os !== undefined
    const machines = this.options.machines
    if (!machines) return asks ? delegationRefusal('INVALID_INPUT', 'This call has invalid or oversized arguments. Use the offered tool schema. Nothing was started.') : undefined
    if (input.thread !== undefined) return asks ? delegationRefusal('INVALID_INPUT', 'A machine or system is only for a new thread. Leave them out to send another brief. Nothing was sent.') : undefined
    // A caller that may not delegate is refused by admission, under its own rule; a retry reads the first call's result.
    const caller = this.snapshot().threads.find(thread => thread.id === threadId), local = this.options.control.hostId()
    if (!caller || !local || !this.admits(threadId)) return undefined
    if (this.retried(caller.id, input.retry_key)) return undefined
    if (!asks) {
      const away = workerMachineHostId(machines.setting())
      if (away === undefined || away === local) return undefined
      const name = machines.name(away)
      return { hostId: local, name: 'This computer', awayFromDefault: true,
        note: `New workers start on ${name ?? 'another machine'}, but a delegated thread starts on This computer for now.` }
    }
    let placed: WorkerPlacement | WatcherRefusal
    try { placed = await machines.place({ machine: input.machine, os: input.os }, { hostId: local, projectId: caller.projectId }, 'this-computer') }
    catch { return delegationRefusal('PROVIDER_UNAVAILABLE', 'Sotto could not read the machines just now. Nothing was started. Try again.') }
    // A host with no desktop that relays connected refuses by name (#1316); its card says so in Zach's words.
    if ('status' in placed) return await this.refused(threadId, input, delegationRefusal('MACHINE_UNAVAILABLE', placed.message), this.options.relay && placed.code === 'HOST_DISCONNECTED')
    // Elsewhere, through the desktop that relays, where this machine has one (#1316).
    if (placed.hostId !== local && this.options.relay) return RELAYED
    if (placed.hostId !== local) return await this.refused(threadId, input, delegationRefusal('MACHINE_UNAVAILABLE',
      `A delegated thread starts only on This computer for now, so it cannot start on ${placed.receipt.name}. Leave out the machine and system to start it here. Nothing was started.`))
    return { ...placed.receipt, awayFromDefault: false }
  }
  /**
   * A start on another machine through the desktop that relays (#1316): admitted here as any start of this thread's is,
   * then asked of the desktop, which admits it again under its own rules and starts it. A refusal from either is recorded
   * here, as this machine's own are; a start whose answer was lost reads `unknown` and is never asked again (ADR-0058).
   */
  private async relayStart(threadId: string, input: DelegateInput, context: { readonly waitMs?: number }): Promise<unknown> {
    const relay = this.options.relay!
    if (input.from_my_branch === true || input.test_run === true) return await this.refused(threadId, input, delegationRefusal('BRANCH_UNAVAILABLE', RELAY_NO_BRANCH))
    let caller: AgentThread, root: string, levels: number
    try {
      const snapshot = this.snapshot()
      caller = this.caller(threadId, snapshot); root = this.rootOf(caller); levels = this.levelOf(caller.id, snapshot.threads)
    } catch (error) {
      if (error instanceof Refusal) return await this.refused(threadId, input, error.result)
      return delegationRefusal('PROVIDER_UNAVAILABLE', 'Sotto could not start this delegation. Nothing was started.')
    }
    const own: AgentRuntimeMode = caller.providerMode ? 'approval-required' : caller.runtimeMode ?? 'approval-required'
    const { machine, os, from_my_branch: _branch, test_run: _test, ...rest } = input
    void _branch; void _test
    // The desktop's answer must come back inside this call's own deadline, with room for the way there and back.
    const budget = context.waitMs === undefined ? DELEGATION_RELAY_WAIT_MAX_MS : context.waitMs - DELEGATION_RELAY_ANSWER_GRACE_MS - 5_000
    const waitMs = Math.max(0, Math.min(DELEGATION_RELAY_WAIT_MAX_MS, budget))
    const head = nativeHead(caller)
    let answer: Record<string, unknown>
    try {
      answer = await relay.start(caller.id, input.work, { levels, rootUserMessageId: root, ...(head ? { callerMessageId: head } : {}), runtimeMode: own,
        projectId: caller.projectId, ...(machine ? { machine } : {}), ...(os ? { os } : {}), input: rest, waitMs })
    } catch (error) {
      if (error instanceof RelayUnanswered && error.stage === 'away') return await this.refused(threadId, input, delegationRefusal('MACHINE_UNAVAILABLE', relay.awayWords()), true)
      return delegationRefusal('PROVIDER_UNAVAILABLE', 'Sotto could not start this delegation. Nothing was started.')
    }
    if (answer.status !== 'refused') return answer
    const code = delegationRefusalCodeSchema.safeParse(answer.code)
    const message = typeof answer.message === 'string' && answer.message.trim() ? answer.message.slice(0, REFUSAL_MESSAGE_MAX) : 'This computer could not start this delegation. Nothing was started.'
    return await this.refused(threadId, input, delegationRefusal(code.success ? code.data : 'PROVIDER_UNAVAILABLE', message), false, true)
  }
  /**
   * Lands the delegating thread's branch for a new thread that starts from it (#1033): in the incoming ref of a move of
   * its own in the delegating thread's project, from which the new thread's worktree is made. Committed work only, as a
   * move; a test run's uncommitted work goes too, as a snapshot, and nothing in the delegating thread changes. Undefined
   * when there is nothing to land: no branch asked for, a send to a thread, a retry, or a caller admission refuses. A
   * test run with no branch to start from is a check all the same: it queues, and starts where any start does (#1312).
   */
  private async fromBranch(threadId: string, input: DelegateInput): Promise<LandedBranch | DelegationRefusal | undefined> {
    if (input.from_my_branch === undefined && input.test_run === undefined) return undefined
    // A host's thread may ask for a check, which queues there (#1312), but has no branch to start from.
    const moves = this.options.branchMoves
    if (!moves && !(this.options.checks && input.from_my_branch === undefined)) return delegationRefusal('INVALID_INPUT', 'This call has invalid or oversized arguments. Use the offered tool schema. Nothing was started.')
    if (input.thread !== undefined) return delegationRefusal('INVALID_INPUT', 'from_my_branch and test_run are only for a new thread. Leave them out to send another brief. Nothing was sent.')
    if (input.from_my_branch !== true || !moves) return undefined
    if (input.working_copy === 'shared') return delegationRefusal('INVALID_INPUT', 'A thread started from your branch gets a worktree of its own. Leave working_copy out. Nothing was started.')
    const caller = this.snapshot().threads.find(thread => thread.id === threadId), local = this.options.control.hostId()
    if (!caller || !local || !this.admits(threadId)) return undefined
    if (this.retried(caller.id, input.retry_key)) return undefined
    // A check's snapshot is taken now, when it is asked for, even when the check then waits its turn (#1312).
    const moveId = randomUUID(), takenAt = (this.options.clockTime ?? systemClockTime)(new Date(this.clock()))
    let moved: Awaited<ReturnType<DesktopBranchMoves['forStart']>>
    try { moved = await moves.forStart({ from: { hostId: local, threadId: caller.id }, to: { hostId: local, projectId: caller.projectId }, here: local, moveId, snapshot: input.test_run === true }) }
    catch { return delegationRefusal('PROVIDER_UNAVAILABLE', 'Sotto could not read this thread\'s branch just now. Nothing was started. Try again.') }
    if (moved.type === 'refused') return await this.refused(threadId, input, delegationRefusal('BRANCH_UNAVAILABLE', moved.message))
    const name = 'This computer'
    return { moveId, projectId: caller.projectId, takenAt, receipt: { hostId: local, name, branch: moved.branch, ...moved.snapshot ? { snapshot: moved.snapshot } : {},
      note: branchStartWords(name, moved.branch, moved.snapshot, { takenAt }) } }
  }
  /**
   * Records a delegation main refused under its rules, when a thread Sotto holds asked for it, and answers with the
   * refusal and that delegation's ID. Nothing is started, sent, reserved or charged, and no wake-up goes for it.
   */
  private async refused(threadId: string, input: DelegateInput, refusal: DelegationRefusal, away = false, relayed = false): Promise<DelegationRefusal> {
    if (this.closed || !RECORDED_REFUSALS.has(refusal.code)) return refusal
    const caller = this.snapshot().threads.find(thread => thread.id === threadId)
    if (!caller) return refusal
    let root: string | undefined
    try { root = this.rootOf(caller) } catch { root = undefined }
    const head = nativeHead(caller), target = input.thread
    const record = refusedSchema.parse({ id: randomUUID(), delegatingThreadId: caller.id, action: target === undefined ? 'start' : 'send', work: input.work,
      ...(target !== undefined && this.links.get(target)?.delegatingThreadId === caller.id ? { delegatedThreadId: target } : {}),
      ...(target === undefined && input.provider ? { provider: input.provider } : {}),
      ...(refusal.code === 'MACHINE_UNAVAILABLE' && (input.machine !== undefined || input.os !== undefined)
        ? { asked: { ...(input.machine !== undefined ? { machine: input.machine } : {}), ...(input.os !== undefined ? { os: input.os } : {}) } } : {}),
      ...(away && refusal.code === 'MACHINE_UNAVAILABLE' ? { away: true } : {}), ...(relayed && refusal.code === 'MACHINE_UNAVAILABLE' ? { relayed: true } : {}),
      code: refusal.code, message: refusal.message.slice(0, REFUSAL_MESSAGE_MAX), ...(root ? { rootUserMessageId: root } : {}), ...(head ? { callerMessageId: head } : {}),
      createdAt: now() })
    this.refusalEntries.push(record)
    listed(this.refusedBy, record.delegatingThreadId).push(record)
    // The oldest go first, and each was the oldest of its own thread's too.
    if (this.refusalEntries.length > REFUSALS_MAX) for (const dropped of this.refusalEntries.splice(0, this.refusalEntries.length - REFUSALS_MAX)) {
      const own = this.refusedBy.get(dropped.delegatingThreadId)!
      own.shift()
      if (!own.length) this.refusedBy.delete(dropped.delegatingThreadId)
    }
    await this.persist()
    // The window draws its card. A thread a refused send named was sent nothing, so it has nothing new to show.
    this.touched({ delegatingThreadId: record.delegatingThreadId })
    return { ...refusal, delegation: record.id }
  }
  private refusedOf(callerId: string, delegationId: string): RefusedDelegation | undefined {
    return this.refusals.find(item => item.id === delegationId && item.delegatingThreadId === callerId)
  }
  /** A refused delegation as a call reads it: its rule and plain words, and no thread, reply or budget of its own. */
  private refusedResult(refused: RefusedDelegation) {
    const read: DelegationRead = { id: refused.id, ...(refused.delegatedThreadId ? { thread: refused.delegatedThreadId } : {}),
      ...(refused.provider ? { provider: refused.provider } : {}), work: refused.work, action: refused.action, outcome: 'refused', note: refused.message,
      createdAt: refused.createdAt, refusal: refused.code }
    return { status: 'ok' as const, delegation: read, limits: this.limits() }
  }
  private record(delegationId: string): DelegationRecord | undefined { return this.records.find(record => record.id === delegationId) }
  /** Adds a newly admitted delegation to the record and to its threads' parts of it. */
  private add(record: DelegationRecord): void {
    this.entries.push(record)
    this.indexed(record)
  }
  /** A record's threads never change once it is admitted, so it is indexed once, under both. */
  private indexed(record: DelegationRecord): void {
    listed(this.byDelegating, record.delegatingThreadId).push(record)
    listed(this.byDelegated, record.delegatedThreadId).push(record)
    if (record.retryKey) this.byRetryKey.set(retryIndex(record.delegatingThreadId, record.retryKey), record)
  }
  /** Lets go of the incoming ref a branch copy landed for a start that will not use it. Best effort. */
  private async letGo(branch: { readonly moveId: string; readonly projectId: string } | undefined): Promise<void> {
    if (branch) await this.options.branchMoves?.forgetHere({ projectId: branch.projectId, moveId: branch.moveId }).catch(() => undefined)
  }
  /** The delegation `callerId` already made under `retryKey`, if any. */
  private retried(callerId: string, retryKey: string | undefined): DelegationRecord | undefined {
    return retryKey ? this.byRetryKey.get(retryIndex(callerId, retryKey)) : undefined
  }
  private owned(callerId: string, delegationId: string): DelegationRecord {
    const record = this.record(delegationId)
    if (!record || record.delegatingThreadId !== callerId) refuse('UNKNOWN_DELEGATION', 'This thread has no delegation with that ID. Call read_delegation with no delegation to list them.')
    return record
  }
  /** A brief that has not reached an outcome nothing later can change. */
  private open(record: DelegationRecord): boolean {
    if (record.deliveryState === 'failed') return false
    if (record.deliveryState !== 'accepted') return record.outcome !== 'unknown'
    return !record.outcome || !WATCHER_FINAL_OUTCOMES.has(record.outcome)
  }
  private outcomeOf(record: DelegationRecord): WatcherOutcome {
    if (record.deliveryState === 'failed') return FAILURE_OUTCOMES[record.failure ?? 'provider']
    if (record.outcome === 'unknown' || record.deliveryState === 'uncertain') return 'unknown'
    if (record.deliveryState !== 'accepted') return 'working'
    return record.outcome ?? 'working'
  }
  private reserved(path: string): boolean {
    const normalized = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
    return [join(this.options.directory, 'watcher', 'workspace'), join(this.options.directory, 'host-setup')].some(folder => normalized(path) === normalized(folder))
  }
  /** The thread that delegated to this one: the record's link first, then the thread's own record of it. */
  private parentOf(threadId: string, threads: ReadonlyMap<string, AgentThread> | readonly AgentThread[]): string | undefined {
    const linked = this.links.get(threadId)?.delegatingThreadId
    if (linked) return linked
    return threads instanceof Map ? threads.get(threadId)?.delegatedBy : (threads as readonly AgentThread[]).find(thread => thread.id === threadId)?.delegatedBy
  }
  /**
   * The calling thread, when it may delegate: an ordinary project thread this computer holds, on a provider that takes
   * Sotto's tools, outside Watcher's and host setup's folders, and not started by a delegated thread (decision 2).
   */
  private caller(threadId: string, snapshot: AgentHostSnapshot): AgentThread {
    const thread = snapshot.threads.find(item => item.id === threadId)
    const relayed = thread ? undefined : this.options.relayedCallers?.caller(threadId)
    if (relayed) {
      if (relayed.levels >= DELEGATION_LEVELS_MAX) refuse('LEVEL_LIMIT', LEVEL_LIMIT)
      return relayedThread(relayed)
    }
    if (!thread || (thread.kind ?? 'project') !== 'project' || !threadTakesSottoTools(thread)
      || snapshot.projects.some(project => project.id === thread.projectId && this.reserved(project.path))) refuse('NOT_ADMITTED', NOT_ADMITTED)
    if (this.levelOf(thread.id, snapshot.threads) >= DELEGATION_LEVELS_MAX) refuse('LEVEL_LIMIT', LEVEL_LIMIT)
    return thread
  }
  /**
   * How many threads delegated above this one: through the record's links, and, where the chain reaches a thread on another
   * machine that delegated here through the relay (#1316), however many that machine said were above it.
   */
  private levelOf(threadId: string, threads: readonly AgentThread[]): number {
    let level = 0
    for (let at: string | undefined = this.parentOf(threadId, threads); at !== undefined && level <= DELEGATION_LEVELS_MAX; at = this.parentOf(at, threads)) {
      level++
      const relayed = this.options.relayedCallers?.caller(at)
      if (relayed) { level += relayed.levels; break }
    }
    return level
  }
  /**
   * The user's latest message to the calling thread, which roots its turn's budget (decision 3). A wake-up's turn keeps
   * the root of the turn before it and renews nothing.
   */
  private rootOf(caller: AgentThread): string {
    // A thread on another machine roots its turn there, and its machine says which message that is (#1316).
    if (relayedThreads.has(caller)) return this.options.relayedCallers!.caller(caller.id)!.rootUserMessageId
    const wakeUps = new Set(caller.wakeUpMessageIds ?? [])
    const head = nativeHead(caller)
    if (head && !wakeUps.has(head) && caller.messages.find(message => message.id === head)?.wakeUp !== true) {
      this.roots.set(caller.id, head); return head
    }
    const kept = this.roots.get(caller.id)
    if (kept) return kept
    const found = caller.messages.findLast(message => message.role === 'user' && message.wakeUp !== true && !wakeUps.has(message.id))?.id
    if (found) { this.roots.set(caller.id, found); return found }
    refuse('NO_USER_MESSAGE', 'Delegation answers the user\'s own message to this thread, and Sotto cannot find one. Nothing was started.')
  }
  private prompts(callerId: string, root: string, threadId: string): number {
    return this.records.filter(record => record.delegatingThreadId === callerId && record.rootUserMessageId === root && record.delegatedThreadId === threadId && record.charged).length
  }
  private limits(record?: DelegationRecord) {
    return { ...(record ? { prompts: this.prompts(record.delegatingThreadId, record.rootUserMessageId, record.delegatedThreadId) } : {}), promptLimit: DELEGATION_PROMPTS_PER_THREAD }
  }
  /**
   * The permission a delegated thread may have: no wider than the narrower of the delegating thread's own and the user's
   * new-thread default, compared as Watcher compares (decision 4). A provider profile that allows more than nothing
   * cannot be compared, so it is refused rather than guessed.
   */
  private permission(model: AgentModel, caller: AgentThread, models: readonly AgentModel[], explicit?: AgentRuntimeMode): { runtimeMode?: AgentRuntimeMode; providerMode?: string } {
    const index = (mode: AgentRuntimeMode) => RUNTIME_MODE_ORDER.indexOf(mode)
    const ceiling = this.ceiling(model, caller, models)
    if (ceiling.providerMode !== undefined) {
      const mode = model.providerModes?.find(item => item.id === ceiling.providerMode)
      if (mode?.allows !== 'nothing' || explicit) refuse('PERMISSION_NOT_COMPARABLE', 'This provider\'s permission profile cannot be compared safely. Choose a provider with an asking mode. Nothing was started.')
      return { providerMode: ceiling.providerMode }
    }
    if (!ceiling.runtimeMode) refuse('PERMISSION_NOT_COMPARABLE', 'This model has no permission mode Sotto can compare. Choose another model. Nothing was started.')
    const mode = explicit ?? ceiling.runtimeMode
    if (!model.runtimeModes?.includes(mode)) refuse('PERMISSION_NOT_COMPARABLE', 'This model does not offer that permission mode. Nothing was started.')
    if (index(mode) > index(ceiling.runtimeMode)) {
      // On a host that holds starts to Ask for approval, the refusal says why when that, not the calling thread, held it.
      const held = this.newThreadDefault().held, own = caller.providerMode ? 'approval-required' : caller.runtimeMode ?? 'approval-required'
      refuse('PERMISSION_TOO_WIDE', `A delegated thread cannot have more permission than this thread has, or than the user's new-thread default.${held && index(own) > 0 ? ` ${HOST_CEILING_HOLD_WORDS[held]}` : ''} Nothing was started.`)
    }
    return { runtimeMode: mode }
  }
  /** The user's new-thread default as this machine may use it: the coordinator's own, or what a host was told (#1310). */
  private newThreadDefault(): { readonly mode: AgentRuntimeMode; readonly held?: HostCeilingHold } {
    return this.options.newThreadCeiling?.() ?? { mode: this.options.control.configuration().newThreadRuntimeMode ?? 'approval-required' }
  }
  /** The widest a delegated thread may start on: the narrower of the calling thread's own and the new-thread default. */
  private ceiling(model: AgentModel, caller: AgentThread, models: readonly AgentModel[]) {
    const index = (mode: AgentRuntimeMode) => RUNTIME_MODE_ORDER.indexOf(mode)
    let own: AgentRuntimeMode = caller.runtimeMode ?? 'approval-required'
    if (caller.providerMode) {
      const mode = resolveModel(models, caller.modelId)?.providerModes?.find(item => item.id === caller.providerMode)
      if (mode?.allows !== 'nothing') refuse('PERMISSION_NOT_COMPARABLE', 'This thread\'s own permission profile cannot be compared with Sotto\'s modes, so Sotto cannot tell how much a thread it starts may have. Nothing was started.')
      own = 'approval-required'
    }
    const configured = this.newThreadDefault().mode
    return resolveNewThreadPermission(model, index(own) < index(configured) ? own : configured)
  }
  /**
   * A role's permission held to the ceiling: what it starts on, and, when that was narrower than the role wanted, which
   * limit held it: the calling thread's own permission when it is the narrower, the new-thread default otherwise.
   */
  private heldToCeiling(wanted: AgentRuntimeMode, model: AgentModel, caller: AgentThread, models: readonly AgentModel[]): { mode: AgentRuntimeMode; held?: HeldPermission } | undefined {
    const ceiling = this.ceiling(model, caller, models)
    if (ceiling.providerMode !== undefined || !ceiling.runtimeMode) return undefined
    const mode = capRuntimeMode(wanted, ceiling.runtimeMode)
    if (mode === wanted) return { mode }
    const index = (value: AgentRuntimeMode) => RUNTIME_MODE_ORDER.indexOf(value)
    const own = caller.providerMode ? 'approval-required' : caller.runtimeMode ?? 'approval-required'
    const { mode: configured, held: hostHeld } = this.newThreadDefault()
    const thread = index(own) < index(configured)
    // A limit the model does not offer starts on the nearest mode it does, and the receipt says that is why. A host that held
    // the default to Ask for approval says why it did (#1310).
    return { mode, held: { wanted, startedOn: mode, by: thread ? 'delegating-thread' : hostHeld ?? 'new-thread-default', ...(ceiling.nearestFit ? { unoffered: thread ? own : configured } : {}) } }
  }
  /**
   * Whether the turn running in a delegated thread is the user's own: its newest message is neither a brief nor one of
   * Sotto's wake-ups, such as the resume note a restart sends. A turn Sotto started holds a brief only until it ends.
   */
  private humanTurnRunning(thread: AgentThread): boolean {
    if (!isThreadTurnRunning(thread)) return false
    const head = nativeHead(thread)
    return !head || !isWakeUpOf(thread, head) && !this.records.some(record => record.delegatedThreadId === thread.id && record.messageId === head)
  }
  private pausedThread(thread: AgentThread): boolean {
    return this.paused.has(thread.id) || this.humanTurnRunning(thread) || this.options.control.hasUserDraft(thread.id)
  }
  /** Ready models, at most `MODELS_LISTED` of each provider, or of the one named: a provider such as Muse can offer hundreds. */
  private ready(snapshot: AgentHostSnapshot, provider?: string): AgentModel[] {
    const listed = new Map<string, number>()
    return snapshot.models.filter(model => {
      if (!model.ready || !model.providerId || provider !== undefined && model.providerId !== provider) return false
      const count = listed.get(model.providerId) ?? 0
      listed.set(model.providerId, count + 1)
      return count < MODELS_LISTED
    })
  }
  private readyModels(snapshot: AgentHostSnapshot, provider?: string): string {
    const ready = this.ready(snapshot, provider)
    return ready.length ? `Ready models${provider ? ` for ${provider}` : ''}: ${ready.map(model => `${model.providerId} ${model.id}`).join('; ')}.` : `No ${provider ? `${provider} ` : ''}model is ready on this computer.`
  }

  /** Admission, in one transaction: who calls, under which root, within which ceiling and limits. Records the brief. */
  private async admit(threadId: string, input: DelegateInput) {
    if (this.closed) refuse('STOPPING', 'Sotto is stopping. Nothing was started.')
    const snapshot = this.snapshot(), caller = this.caller(threadId, snapshot)
    const inputDigest = digest(input)
    if (input.retry_key) {
      const retry = this.retried(caller.id, input.retry_key)
      if (retry) {
        if (retry.inputDigest !== inputDigest) refuse('RETRY_KEY_CONFLICT', 'This retry key belongs to another delegation. Nothing was started.')
        return { record: retry, retry: true }
      }
    }
    const root = this.rootOf(caller), time = now()
    const callerHead = nativeHead(caller)
    const base = { id: randomUUID(), delegatingThreadId: caller.id, work: input.work, rootUserMessageId: root, ...(callerHead ? { callerMessageId: callerHead } : {}),
      ...(input.retry_key ? { retryKey: input.retry_key } : {}),
      inputDigest, draftId: randomUUID(), messageId: randomUUID(), deliveryState: 'queued' as const, charged: true, createdAt: time, updatedAt: time }
    if (input.thread !== undefined) {
      const link = this.links.get(input.thread)
      if (!link || link.delegatingThreadId !== caller.id) refuse('UNKNOWN_THREAD', 'This thread can send a brief only to a thread it delegated to. Leave thread out to start a new one. Nothing was sent.')
      const thread = snapshot.threads.find(item => item.id === input.thread)
      if (!thread || isThreadClosed(thread)) refuse('UNKNOWN_THREAD', 'That delegated thread is gone or archived. Nothing was sent.')
      if (!isThreadProviderConnected(snapshot, thread) || thread.clientConnected === false) refuse('PROVIDER_UNAVAILABLE', 'That delegated thread\'s provider is disconnected. Nothing was sent.')
      if (thread.requests.length) refuse('PENDING_USER_REQUEST', 'That delegated thread is waiting for the user\'s answer, which only the user gives on its own card. Nothing was sent.')
      // A held queue says why first: the user's send there pauses delegated sends too, but only their resuming it ends that.
      const held = this.queueHeld(thread.id, true)
      if (held) refuse('QUEUE_HELD', QUEUE_HELD[held]!)
      if (this.pausedThread(thread)) refuse('PAUSED', 'The user is working in that delegated thread, so delegated sends to it are paused until their turn ends. Nothing was sent.')
      if (userHead(thread) !== link.seenHead) refuse('TARGET_CHANGED', 'The user has sent their own message in that delegated thread since this thread last looked. Call read_delegation on its newest delegation first. Nothing was sent.')
      const model = resolveModel(snapshot.models, thread.modelId)
      if (!model) refuse('PROVIDER_UNAVAILABLE', 'That delegated thread\'s model is unavailable. Nothing was sent.')
      const current = this.permission(model, caller, snapshot.models, thread.providerMode ? undefined : thread.runtimeMode ?? 'approval-required')
      if (thread.providerMode && current.providerMode !== thread.providerMode) refuse('PERMISSION_NOT_COMPARABLE', 'That delegated thread\'s permission cannot be compared safely. Nothing was sent.')
      if (this.prompts(caller.id, root, thread.id) >= DELEGATION_PROMPTS_PER_THREAD) refuse('PROMPT_LIMIT', `That thread has had ${DELEGATION_PROMPTS_PER_THREAD} briefs in this turn of this thread. Retries, reads and wake-ups do not renew the limit; the user's next message does. Nothing was sent.`)
      const record: DelegationRecord = recordSchema.parse({ ...base, delegatedThreadId: thread.id, action: 'send', expectedLastUserMessageId: link.seenHead })
      this.add(record)
      await this.saveAdmission(record)
      this.touched(record)
      return { record, retry: false }
    }
    // With worker roles on, a new thread names its kind of work and the user's Settings fill in the rest (#1041): read
    // here, once per call. A provider and model named together override the role's; one without the other is refused.
    const named = input.provider !== undefined && input.model !== undefined
    let byRole: RoleStart | undefined
    if (this.options.roles && (named || input.provider === undefined && input.model === undefined)) {
      byRole = startFromRole(input.work, this.options.roles(), snapshot.models, { ...(named ? { modelId: input.model } : {}), reasoningEffort: input.effort, runtimeMode: input.permission })
      if (!byRole.modelId) refuse('PROVIDER_UNAVAILABLE', 'No ready model can do that kind of work. Connect a provider in Settings, under Providers. Nothing was started.')
    } else if (!named) refuse('INVALID_INPUT', `Name the provider and model for a new thread. ${this.readyModels(snapshot, input.provider)} Nothing was started.`)
    const model = resolveModel(snapshot.models, byRole?.modelId ?? input.model!)
    if (!model?.ready || named && model.providerId !== input.provider) refuse('PROVIDER_UNAVAILABLE', `That model is not ready on this computer. ${this.readyModels(snapshot, input.provider)} Nothing was started.`)
    // Ultracode is the user's own choice in a thread, never a delegating agent's (ADR-0148).
    const efforts = withoutUltracode(model.reasoningEfforts ?? [])
    const roleEffort = byRole && input.effort === undefined && byRole.reasoningEffort && efforts.includes(byRole.reasoningEffort) ? byRole.reasoningEffort : undefined
    const effort = input.effort ?? roleEffort
    if (effort === undefined ? efforts.length > 0 && !byRole : !efforts.includes(effort)) refuse('INVALID_INPUT', `Name the effort for this model, one of: ${efforts.join(', ') || 'none, so leave it out'}. Nothing was started.`)
    if (!byRole && !model.providerModes?.length && input.permission === undefined) refuse('INVALID_INPUT', `Name the permission for a new thread, one of: ${(model.runtimeModes ?? []).join(', ') || 'none'}. It may be no wider than this thread's own or the user's new-thread default. Nothing was started.`)
    const project = snapshot.projects.find(item => item.id === caller.projectId)
    if (!project || this.reserved(project.path)) refuse('NOT_ADMITTED', NOT_ADMITTED)
    // A permission the call named keeps its refusal. One the role gave is held to the ceiling instead.
    const fromRole = byRole?.runtimeMode && input.permission === undefined ? this.heldToCeiling(byRole.runtimeMode, model, caller, snapshot.models) : undefined
    const permission = this.permission(model, caller, snapshot.models, input.permission ?? fromRole?.mode)
    const delegatedThreadId = randomUUID()
    const by = fromRole?.held?.by
    const hostHeld = by === 'not-told' || by === 'no-answer-grant' || by === 'answers-revoked' ? by : undefined
    const record: DelegationRecord = recordSchema.parse({ ...base, delegatedThreadId, action: 'start', expectedLastUserMessageId: null, ...(hostHeld ? { held: hostHeld } : {}) })
    this.add(record)
    this.creating.add(record.id)
    this.links.set(delegatedThreadId, { threadId: delegatedThreadId, delegatingThreadId: caller.id, createdAt: time, seenHead: null })
    await this.saveAdmission(record)
    this.touched(record)
    const start: DelegatedStart = { projectId: project.id, title: input.title ?? DELEGATION_WORK_TITLES[input.work], titleSource: input.title ? 'user' : 'default',
      // A role's own choice may name a long-context variant the catalog lists under its base, so its ID is kept.
      modelId: byRole && !named ? byRole.modelId! : model.id, ...(effort ? { reasoningEffort: effort } : {}), ...permission, workingCopy: input.working_copy ?? 'shared',
      ...(this.options.bringBack === true && input.working_copy === 'independent' && callerBranch(caller) ? { baseBranch: callerBranch(caller)! } : {}) }
    const role: RoleReceipt | undefined = byRole ? { work: input.work, named: [...byRole.named], note: roleStartNote(byRole, snapshot.models, fromRole?.held) } : undefined
    return { record, retry: false, start, ...(role ? { role } : {}) }
  }
  /**
   * Saves an admitted brief before anything is sent, so a retry after a restart finds it. A save that fails takes the
   * brief back and refuses the call: nothing was started or sent.
   */
  private async saveAdmission(record: DelegationRecord): Promise<void> {
    this.trim()
    try { await this.save() }
    catch {
      this.records = this.records.filter(item => item.id !== record.id)
      this.briefsRevision++
      this.creating.delete(record.id)
      if (record.action === 'start') this.links.delete(record.delegatedThreadId)
      refuse('PROVIDER_UNAVAILABLE', 'Sotto could not save this delegation, so nothing was started or sent. Try again.')
    }
  }

  /** Creates the delegated thread when this is a start, links it, then sends the brief now or once the thread is free. */
  private async execute(record: DelegationRecord, brief: string, start?: DelegatedStart): Promise<void> {
    if (record.action === 'start' && start) {
      try {
        const created = await this.options.control.commandFromDelegation({ type: 'create-thread', threadId: record.delegatedThreadId, projectId: start.projectId,
          title: start.title, titleSource: start.titleSource, modelId: start.modelId, workingCopy: start.workingCopy,
          // A start from the delegating thread's branch cuts its worktree from the moved branch; any other new worktree from that branch (#1030).
          ...start.startFromMove ? { startFromMove: start.startFromMove } : start.baseBranch ? { baseBranch: start.baseBranch } : {},
          ...(start.reasoningEffort ? { reasoningEffort: start.reasoningEffort } : {}),
          ...(start.runtimeMode ? { runtimeMode: start.runtimeMode } : {}), ...(start.providerMode ? { providerMode: start.providerMode } : {}) },
        () => { this.guardLive(record.id); this.guardCeiling(record, start) })
        if (created.error || !created.host.threads.some(thread => thread.id === record.delegatedThreadId)) { this.fail(record.id, 'provider', true); await this.persist(); return }
        // Linked on the thread's own record before its first send, so its first launch already knows its level.
        await this.options.host.setDelegatedBy(record.delegatedThreadId, record.delegatingThreadId)
      } catch { this.fail(record.id, 'provider', true); await this.persist(); return }
      finally { this.creating.delete(record.id) }
    }
    // A Stop while the thread was created or linked ended the brief: it is not held for a send that will never come.
    if (this.record(record.id)?.deliveryState !== 'queued') return
    this.queuedBriefs.set(record.id, brief)
    const snapshot = this.snapshot(), thread = snapshot.threads.find(item => item.id === record.delegatedThreadId)
    if (thread && this.free(thread, snapshot)) await this.dispatch(record.id)
    else {
      // Queued work restores a settled thread now, not once it goes; its send restores it then if this could not.
      if (thread) await this.options.control.reopenSettledForWork?.(thread.id).catch(() => undefined)
      this.options.control.refreshDelegationObservation()
    }
  }
  /**
   * Puts a new check in this machine's queue (#1312), in the order asked, whoever asked. Answers whether it waits: then its
   * thread is made, and its brief sent, once the check ahead of it has finished, and until then its outcome is `working`.
   * Without a queue, as with Work across machines off, nothing waits.
   */
  private queueCheck(record: DelegationRecord, brief: string, start: DelegatedStart, branch: LandedBranch | undefined, ticket: string): boolean {
    this.checkTickets.set(record.id, ticket); this.ticketRecords.set(ticket, record.id)
    if (this.options.checks!.running(ticket)) return false
    this.waitingChecks.set(record.id, { brief, start, branch })
    return true
  }
  /**
   * A check's turn came. One still being asked for, its snapshot not yet taken, finds itself first in the queue once it is
   * admitted and starts then.
   */
  private checkTurn(ticket: string): void {
    const delegationId = this.ticketRecords.get(ticket)
    if (delegationId !== undefined && this.waitingChecks.has(delegationId)) void this.runCheck(delegationId).catch(() => undefined)
  }
  /** Takes a check out of its machine's queue, so the next one ahead takes its turn. */
  private leaveQueue(delegationId: string): void {
    const ticket = this.checkTickets.get(delegationId)
    if (ticket === undefined) return
    this.checkTickets.delete(delegationId); this.ticketRecords.delete(ticket)
    this.options.checks?.leave(ticket)
  }
  /** A waiting check whose turn came: its thread is made and sent its brief, as a start that never waited is. */
  private async runCheck(delegationId: string): Promise<void> {
    const waiting = this.waitingChecks.get(delegationId)
    if (!waiting) return
    this.waitingChecks.delete(delegationId)
    const record = this.record(delegationId)
    if (!record || this.closed || record.deliveryState !== 'queued') {
      this.creating.delete(delegationId); this.leaveQueue(delegationId)
      await this.letGo(waiting.branch)
      return
    }
    try { await this.execute(record, waiting.brief, waiting.start) }
    finally {
      if (!this.snapshot().threads.some(thread => thread.id === record.delegatedThreadId)) await this.letGo(waiting.branch)
      this.touched(record)
    }
  }
  /**
   * A check leaves its machine's queue once it no longer holds its place: it ended, failed, was stopped or never started.
   * One still waiting is let go with the branch it would have started from, and the next check ahead takes its turn.
   */
  private releaseCheck(record: DelegationRecord): void {
    if (!this.checkTickets.has(record.id) || this.holdsCheck(record)) return
    const waiting = this.waitingChecks.get(record.id)
    if (waiting) { this.waitingChecks.delete(record.id); this.creating.delete(record.id); void this.letGo(waiting.branch) }
    this.leaveQueue(record.id)
  }
  /**
   * Whether a check still holds its machine's place: waiting, working, in background work not yet seen to end, or sent
   * with its delivery unconfirmed. An unconfirmed brief reads `unknown` but may yet have reached its thread, so it holds
   * its place until it is seen to arrive or is proved never started, as it holds its start's slot.
   */
  private holdsCheck(record: DelegationRecord): boolean {
    if (!this.open(record)) return false
    if (record.deliveryState === 'dispatching' || record.deliveryState === 'uncertain') return true
    const outcome = this.outcomeOf(record)
    return outcome === 'working' || CHECK_HOLDS_THROUGH_BACKGROUND && outcome === 'background' && record.releasedAt === undefined
  }
  /** Where a start from a branch begins, as its result says: a check still waiting its turn "Starts" there. */
  private startedFrom(delegationId: string, branch: LandedBranch): BranchStartReceipt {
    if (!this.waitingChecks.has(delegationId)) return branch.receipt
    const { receipt } = branch
    return { ...receipt, note: branchStartWords(receipt.name, receipt.branch, receipt.snapshot, { takenAt: branch.takenAt, waiting: true }) }
  }
  /** Whether a delegated thread can take a brief now: idle, connected, asking nothing and holding nothing of the user's. */
  private free(thread: AgentThread, snapshot: AgentHostSnapshot): boolean {
    return !isThreadTurnRunning(thread) && !thread.requests.length && !this.sending.has(thread.id) && thread.clientConnected !== false
      && isThreadProviderConnected(snapshot, thread) && !this.options.control.hasPendingThreadWork(thread.id)
  }
  /**
   * Why the delegated thread's own queue holds its next prompt until the user acts there, when it does: a paused or failed
   * follow-up, or, at admission, a send whose result is unknown. A brief waiting for it would wait without end.
   */
  private queueHeld(threadId: string, admitting = false): string | undefined {
    const reason = this.options.control.pendingThreadWorkReason?.(threadId)
    return reason === 'paused-followups' || reason === 'failed-followups' || admitting && reason === 'uncertain-send' ? reason : undefined
  }
  private guardLive(delegationId: string): void {
    if (this.closed) throw new Error('Sotto is stopping. Nothing was sent.')
    if (this.fenced.has(delegationId)) { this.dispatchRefusals.set(delegationId, 'stopped'); throw new Error('This delegation was stopped. Nothing was sent.') }
    if (this.record(delegationId)?.deliveryState === 'failed') throw new Error('This delegation was stopped. Nothing was sent.')
  }
  /**
   * Asked again as the delegated thread is created: the permission it starts with is still within the ceiling as it is
   * now, so a narrower new-thread default, or a narrower delegating thread, set since admission is kept to (decision 4).
   */
  private guardCeiling(record: DelegationRecord, start: DelegatedStart): void {
    const snapshot = this.snapshot()
    // A thread on another machine that asked through the relay (#1316) is held to its permission as its machine last said it.
    const relayed = this.options.relayedCallers?.caller(record.delegatingThreadId)
    const caller = snapshot.threads.find(thread => thread.id === record.delegatingThreadId) ?? (relayed ? relayedThread(relayed) : undefined), model = resolveModel(snapshot.models, start.modelId)
    if (!caller || !model) throw new Error('The thread that delegated, or the chosen model, is gone. Nothing was started.')
    const current = this.permission(model, caller, snapshot.models, start.runtimeMode)
    if (start.providerMode !== undefined && current.providerMode !== start.providerMode) throw new Error('The permission changed. Nothing was started.')
  }
  /**
   * Asked as the brief dispatches: the delegation still stands, the user is not working in the thread, and its newest user
   * message is the one the delegating thread saw when it asked, so a brief never lands on top of a newer instruction.
   */
  private guardSend(delegationId: string): void {
    this.guardLive(delegationId)
    const record = this.record(delegationId)!
    const thread = this.snapshot().threads.find(item => item.id === record.delegatedThreadId)
    if (!thread) { this.dispatchRefusals.set(delegationId, 'provider'); throw new Error('The delegated thread is gone. Nothing was sent.') }
    if (this.pausedThread(thread)) { this.dispatchRefusals.set(delegationId, 'paused'); throw new Error('The user is working in this thread. Nothing was sent.') }
    if (userHead(thread) !== record.expectedLastUserMessageId) { this.dispatchRefusals.set(delegationId, 'target-changed'); throw new Error('This thread received another instruction. Nothing was sent.') }
  }
  /** Sends a waiting brief, known while it is on its way so that a cancel can wait for where it landed. */
  private async dispatch(delegationId: string): Promise<void> {
    const running = this.dispatchOnce(delegationId)
    this.dispatches.set(delegationId, running)
    try { await running } finally { if (this.dispatches.get(delegationId) === running) this.dispatches.delete(delegationId) }
  }
  private async dispatchOnce(delegationId: string): Promise<void> {
    const record = this.record(delegationId), brief = this.queuedBriefs.get(delegationId)
    if (!record || brief === undefined || record.deliveryState !== 'queued' || this.sending.has(record.delegatedThreadId)) return
    this.sending.add(record.delegatedThreadId)
    try {
      try { this.guardSend(delegationId) }
      catch { this.fail(delegationId, this.dispatchRefusals.get(delegationId) ?? 'provider', true); return }
      this.queuedBriefs.delete(delegationId)
      this.update(delegationId, saved => { saved.deliveryState = 'dispatching' })
      // Saved as dispatching before the provider can hear it, so a restart reads it as unknown, never as unsent.
      try { await this.save() } catch { this.fail(delegationId, 'provider', true); return }
      let state: DelegationRecord['deliveryState'] = 'failed'
      try {
        const result = await this.options.control.commandFromDelegation({ type: 'manual-send', threadId: record.delegatedThreadId, draftId: record.draftId, text: brief },
          () => this.guardSend(delegationId))
        const delivery = result.deliveries?.find(item => item.draftId === record.draftId && item.threadId === record.delegatedThreadId)
        state = delivery?.status === 'accepted' ? 'accepted' : delivery?.status === 'uncertain' || delivery?.status === 'submitting' ? 'uncertain'
          : result.error ? 'failed' : 'accepted'
      } catch { state = 'failed' }
      if (state === 'failed') this.fail(delegationId, this.dispatchRefusals.get(delegationId) ?? 'provider', true)
      else {
        this.accept(delegationId, state)
        // An unconfirmed brief reads `unknown` until a snapshot proves it either way, and the delegating thread is told so.
        if (this.record(delegationId)?.deliveryState === 'uncertain') this.changed(delegationId)
      }
    } finally {
      this.dispatchRefusals.delete(delegationId)
      this.sending.delete(record.delegatedThreadId)
      await this.persist()
      this.options.control.refreshDelegationObservation()
    }
  }
  private accept(delegationId: string, state: 'accepted' | 'uncertain'): void {
    // Past the writer, a fence has nothing left to refuse.
    this.fenced.delete(delegationId)
    this.update(delegationId, saved => {
      if (saved.deliveryState !== 'accepted') saved.deliveryState = state
      const link = this.links.get(saved.delegatedThreadId)
      if (link && saved.deliveryState === 'accepted') link.seenHead = saved.messageId
    })
  }
  /** Ends a brief that was never delivered. One refused before anything was sent costs its thread no prompt. */
  private fail(delegationId: string, failure: Failure, refund = false): void {
    this.queuedBriefs.delete(delegationId); this.fenced.delete(delegationId)
    this.update(delegationId, saved => {
      if (saved.deliveryState === 'accepted' || saved.deliveryState === 'failed') return
      saved.deliveryState = 'failed'; saved.failure = failure
      if (refund && failure !== 'target-changed' && failure !== 'paused') saved.charged = false
    })
    this.changed(delegationId)
  }
  private update(delegationId: string, change: (record: DelegationRecord) => void): void {
    const record = this.record(delegationId)
    if (!record) return
    change(record); record.updatedAt = now()
    this.touched(record)
  }

  /**
   * The user's own command (decision 6): a send to a delegated thread pauses delegated sends to it until their turn ends,
   * and any brief still waiting for it is refused, so it never lands on top of the user's newer instruction. Stop on a
   * thread stops every working thread it delegated to, at both levels, in the same press.
   */
  private userCommand(command: AgentCommand, threadId: string | undefined, answersQuestion: boolean): void {
    if (this.closed || !threadId) return
    if (['send', 'manual-send', 'queue-followup', 'steer', 'steer-followup'].includes(command.type) && !answersQuestion && this.links.has(threadId)) {
      this.paused.add(threadId)
      for (const record of this.records) if (record.delegatedThreadId === threadId && record.deliveryState === 'queued') this.fail(record.id, 'target-changed')
      void this.persist()
      this.options.control.refreshDelegationObservation()
    }
    if (command.type === 'interrupt') void this.stopThreads(this.below(threadId), new Set([threadId])).catch(() => undefined)
  }
  /** The threads below this one, both levels, from the record's links. */
  private below(threadId: string): string[] {
    return delegatedThreadsBelow([...this.links.values()].map(link => ({ id: link.threadId, delegatedBy: link.delegatingThreadId })), threadId)
  }
  /**
   * Stops these delegated threads and everything they delegated to that is still working, without waking the thread the
   * stop came from: news of a stop the user asked for is not news to the threads above it.
   */
  private async stopThreads(threadIds: readonly string[], above: ReadonlySet<string>): Promise<void> {
    const targets = [...new Set(threadIds.flatMap(threadId => [threadId, ...this.below(threadId)]))]
    if (!targets.length) return
    const quiet = new Set([...above, ...targets])
    for (const record of this.records) if (targets.includes(record.delegatedThreadId) && quiet.has(record.delegatingThreadId)) {
      if (this.open(record)) record.told = 'stopped'
      if (record.deliveryState === 'queued' || record.deliveryState === 'dispatching') this.fenced.add(record.id)
      if (record.deliveryState === 'queued') this.fail(record.id, 'stopped')
    }
    for (const delegatingId of quiet) for (const record of this.records) if (record.delegatingThreadId === delegatingId) this.waiters.get(record.id)?.forEach(wake => wake())
    await this.persist()
    const threads = new Map(this.snapshot().threads.map(thread => [thread.id, thread]))
    await Promise.allSettled(targets.filter(threadId => { const thread = threads.get(threadId); return thread !== undefined && isThreadTurnRunning(thread) })
      .map(threadId => this.options.control.commandFromDelegation({ type: 'interrupt', threadId }, () => { if (this.closed) throw new Error('Sotto is stopping.') })))
  }

  /**
   * Whether a brief whose delivery was not confirmed can no longer be proved delivered (ADR-0058, ADR-0073): no send of
   * it is on its way, the coordinator holds nothing unresolved for its thread, the thread is not working, and its own
   * message never showed there. Until then it holds its start's slot, as Watcher's uncertain start holds its
   * reservation while its delivery is unresolved; after, it reads `unknown`, is never sent again, and holds nothing.
   */
  /**
   * Ends a brief whose delegated thread is gone from Sotto, deleted or never created, unless that thread is still being
   * created or the brief is on its way: one still waiting is refused unsent, and any other reads `unknown`, since Sotto
   * cannot tell how its turn ended. Either way it holds nothing after, and the delegating thread is told.
   */
  private gone(record: DelegationRecord): boolean {
    if (this.creating.has(record.id) || this.sending.has(record.delegatedThreadId)) return false
    if (record.deliveryState === 'queued') { this.fail(record.id, 'provider', true); return true }
    this.update(record.id, saved => {
      if (saved.deliveryState === 'dispatching') saved.deliveryState = 'uncertain'
      saved.outcome = 'unknown'; saved.unknownBecause = 'gone'; saved.outcomeAt = now()
    })
    this.changed(record.id)
    return true
  }
  private unproved(record: DelegationRecord, thread: AgentThread): boolean {
    return (record.deliveryState === 'dispatching' || record.deliveryState === 'uncertain') && !this.sending.has(record.delegatedThreadId)
      && !isThreadTurnRunning(thread) && !this.options.control.hasPendingThreadWork(thread.id)
  }
  private observedThreadIds(): string[] {
    return [...new Set([...this.records.filter(record => this.open(record)).map(record => record.delegatedThreadId), ...this.paused])]
  }
  /**
   * One pass over the coordinator's snapshot: each open brief's outcome from its thread, pauses whose turn has ended, and
   * briefs whose thread is free. It reads only the threads its open delegations and its pauses name: by `view`, the
   * coordinator's index, when it gives one (#925 step 5), otherwise from the snapshot's thread list read once, whatever the
   * number of delegations. Each of those threads is read on every pass, since what the pass decides of one also follows
   * the queue, the user's composer, delegation's own sends and the clock, which move without the thread.
   */
  private observe(snapshot: AgentHostSnapshot, view?: HostThreadsView): void {
    if (this.closed) return
    const open = this.records.filter(record => this.open(record))
    if (this.untold.size) this.scheduleNews()
    if (!open.length && !this.paused.size) return
    let listed: Map<string, AgentThread> | undefined
    const threads: Pick<ReadonlyMap<string, AgentThread>, 'get'> = view
      ? { get: id => view.thread(id) }
      : { get: id => (listed ??= new Map(snapshot.threads.map(thread => [thread.id, thread]))).get(id) }
    let briefIds: Set<string> | undefined
    const briefs = { has: (messageId: string) => (briefIds ??= new Set(this.records.map(record => record.messageId))).has(messageId) }
    let changed = false
    for (const threadId of [...this.paused]) {
      const thread = threads.get(threadId)
      if (!thread || !isThreadTurnRunning(thread) && !this.options.control.hasPendingThreadWork(threadId)) { this.paused.delete(threadId); changed = true }
    }
    for (const record of open) {
      const thread = threads.get(record.delegatedThreadId)
      if (!thread) {
        if (this.gone(record)) changed = true
        continue
      }
      if (!isThreadProviderConnected(snapshot, thread) || thread.clientConnected === false) continue
      if (record.deliveryState === 'queued') {
        // The user's own queue there came to hold it, as a Stop in that thread does: it ends unsent rather than wait unseen.
        if (this.queuedBriefs.has(record.id) && !this.sending.has(record.delegatedThreadId) && this.queueHeld(thread.id)) { this.fail(record.id, 'paused'); changed = true; continue }
        if (this.queuedBriefs.has(record.id) && this.free(thread, snapshot)) void this.dispatch(record.id).catch(() => undefined)
        continue
      }
      if ((record.deliveryState === 'dispatching' || record.deliveryState === 'uncertain') && thread.messages.some(message => message.role === 'user' && message.id === record.messageId)) {
        this.accept(record.id, 'accepted'); changed = true
      }
      if (record.deliveryState !== 'accepted') {
        if (this.unproved(record, thread)) {
          this.update(record.id, saved => { saved.deliveryState = 'uncertain'; saved.outcome = 'unknown'; saved.unknownBecause = 'unconfirmed'; saved.outcomeAt = now() })
          changed = true
          this.changed(record.id)
        }
        continue
      }
      const seen = watcherTurnOutcome({ messageId: record.messageId, delivery: 'now', ...(record.outcome ? { outcome: record.outcome } : {}) }, thread, messageId => briefs.has(messageId))
      if (!seen || seen.outcome === record.outcome && seen.turnMessageId === record.turnMessageId && seen.replyMessageId === record.replyMessageId) continue
      this.update(record.id, saved => {
        saved.outcome = seen.outcome; saved.outcomeAt = now(); delete saved.releasedAt; delete saved.releaseTold
        for (const field of ['turnMessageId', 'nativeTurnId', 'replyMessageId'] as const) { if (seen[field]) saved[field] = seen[field]; else delete saved[field] }
      })
      if (seen.outcome === 'answered') this.answeredThisRun.add(record.id)
      changed = true
      this.changed(record.id)
    }
    if (this.releaseHeld(snapshot, threads)) changed = true
    if (changed) { void this.persist(); this.options.control.refreshDelegationObservation() }
  }
  /**
   * Releases each background outcome whose delegated thread has sat idle, no turn running, for WATCHER_QUIET_MS since that
   * outcome, the work its turn left running never seen to end (#1263). The delegating thread is told once, plainly, rather
   * than wait for work-settled news that may never come. One wait runs, for the next such outcome due, only while one waits.
   */
  private releaseHeld(snapshot: AgentHostSnapshot, threads: Pick<ReadonlyMap<string, AgentThread>, 'get'>): boolean {
    this.cancelRelease?.(); this.cancelRelease = undefined
    let released = false, next = Infinity
    const clock = this.clock()
    for (const record of this.records) {
      if (record.releasedAt || !record.outcomeAt || this.outcomeOf(record) !== 'background') continue
      const thread = threads.get(record.delegatedThreadId)
      if (!thread || !isThreadProviderConnected(snapshot, thread) || thread.clientConnected === false) continue
      if (isThreadTurnRunning(thread)) { this.lastWorking.set(record.id, clock); continue }
      // Twenty minutes idle: from the outcome, or from when its thread was last seen working, whichever is later.
      const due = Math.max(Date.parse(record.outcomeAt), this.lastWorking.get(record.id) ?? 0) + WATCHER_QUIET_MS
      if (clock < due) { next = Math.min(next, due); continue }
      this.lastWorking.delete(record.id)
      this.update(record.id, saved => { saved.releasedAt = new Date(clock).toISOString(); delete saved.releaseTold })
      released = true
      this.changed(record.id)
    }
    if (Number.isFinite(next) && !this.closed) this.cancelRelease = this.schedule(() => { this.cancelRelease = undefined; if (!this.closed) this.observe(this.snapshot()) }, next - clock)
    return released
  }
  /**
   * A released background outcome as it stands now: how long it was held, and whether its thread has run another turn
   * since. Undefined unless its delegated thread is idle now, so nothing ever says "idle" of a thread that is working.
   */
  private heldNow(record: DelegationRecord, thread: AgentThread | undefined, untold = true): { minutes: number; laterTurn: boolean } | undefined {
    const minutes = this.heldMinutes(record, untold)
    if (minutes === undefined || !thread || isThreadTurnRunning(thread)) return undefined
    return { minutes, laterTurn: record.turnMessageId !== undefined && !watcherBriefTurnIsNewest(thread, record.turnMessageId) }
  }
  /** How long a released background outcome was held, in minutes; with `untold`, only while its delegating thread has not been told so. */
  private heldMinutes(record: DelegationRecord, untold = true): number | undefined {
    if (!record.releasedAt || !record.outcomeAt || untold && record.releaseTold || this.outcomeOf(record) !== 'background') return undefined
    return Math.max(0, Math.floor((Date.parse(record.releasedAt) - Date.parse(record.outcomeAt)) / 60_000))
  }
  /**
   * An outcome moved: a call waiting on it hears it; otherwise, once it says something new, the delegating thread is sent
   * it as a wake-up carrying identities only (decision 7).
   */
  private changed(delegationId: string): void {
    const record = this.record(delegationId)
    if (!record) return
    this.releaseCheck(record)
    const outcome = this.outcomeOf(record)
    if (!this.open(record)) this.waiters.get(record.id)?.forEach(wake => wake())
    if (this.calling.has(record.id) || outcome === 'working' || outcome === record.told && this.heldMinutes(record) === undefined) return
    const pending = this.untold.get(record.delegatingThreadId) ?? { ids: new Set<string>(), attempts: 0 }
    pending.ids.add(record.id); this.untold.set(record.delegatingThreadId, pending)
    this.scheduleNews()
  }
  /** Tells each delegating thread its news once the current pass is over: one wake-up per thread, however many changed. */
  private scheduleNews(): void {
    if (this.newsScheduled || this.closed) return
    this.newsScheduled = true
    queueMicrotask(() => { this.newsScheduled = false; void this.tellNews().catch(() => undefined) })
  }
  /**
   * Hands each delegating thread the outcomes it has not been told, as one wake-up. An outcome counts as told once the
   * queue has saved it; a thread that cannot take it now is offered it again on a later pass, a few times, then left.
   */
  private async tellNews(): Promise<void> {
    const threads = new Set(this.snapshot().threads.map(thread => thread.id))
    const relayed = this.options.relayedCallers
    await Promise.allSettled([...this.untold].map(async ([threadId, pending]) => {
      if (this.telling.has(threadId)) return
      const records = [...pending.ids].flatMap(id => { const record = this.record(id); return record ? [record] : [] })
        .filter(record => !this.calling.has(record.id) && this.outcomeOf(record) !== 'working' && (this.outcomeOf(record) !== record.told || this.heldMinutes(record) !== undefined))
      const elsewhere = !threads.has(threadId) && relayed?.caller(threadId) !== undefined
      if (!records.length || !threads.has(threadId) && !elsewhere || pending.attempts >= NEWS_ATTEMPTS_MAX) { this.untold.delete(threadId); return }
      const told = records.map(record => ({ record, outcome: this.outcomeOf(record), held: this.heldMinutes(record) }))
      const news: DelegationNews = { source: 'delegation', items: told.map(({ record, outcome, held }) => ({ delegationId: record.id, threadId: record.delegatedThreadId, outcome,
        ...(record.turnMessageId ? { turnMessageId: record.turnMessageId } : {}), ...(held !== undefined ? { heldMinutes: held } : {}) })) }
      this.telling.add(threadId); pending.attempts++
      try {
        // A thread on another machine is told on its machine, through the desktop's connection to it (#1316).
        if (elsewhere) {
          const snapshot = this.snapshot()
          const replies = told.flatMap(({ record, outcome }) => {
            if (outcome !== 'answered') return []
            const reply = this.replyOf(record, snapshot.threads.find(thread => thread.id === record.delegatedThreadId)).reply
            return reply ? [{ delegationId: record.id, ...reply }] : []
          })
          await relayed!.tell(threadId, news, replies)
        }
        else await this.options.control.deliverWakeUp(threadId, news, { tool: this.options.tool?.(threadId) ?? false })
        for (const { record, outcome, held } of told) { record.told = outcome; if (held !== undefined) record.releaseTold = true; pending.ids.delete(record.id) }
        // News that came while this was being told goes next, rather than wait for another snapshot.
        if (!pending.ids.size) this.untold.delete(threadId)
        else { pending.attempts = 0; this.scheduleNews() }
        await this.persist()
      } catch { /* Offered again on a later pass. */ } finally { this.telling.delete(threadId) }
    }))
  }
  private wait(delegationId: string, ms: number): Promise<void> {
    return new Promise(resolveWait => {
      const waiting = this.waiters.get(delegationId) ?? new Set<() => void>()
      this.waiters.set(delegationId, waiting)
      const wake = () => { clearTimeout(timer); waiting.delete(wake); if (!waiting.size) this.waiters.delete(delegationId); resolveWait() }
      const timer = setTimeout(wake, ms)
      timer.unref?.()
      waiting.add(wake)
      if (this.closed) wake()
    })
  }

  /**
   * What a call returns of a delegation: its outcome and, once answered, the delegated thread's reply, labelled as its
   * words. The delegating thread is told the outcome by it, so the same outcome is not sent again as a wake-up. A read
   * also records the delegated thread's newest user message as seen, which the next brief to it carries.
   */
  private async result(record: DelegationRecord, reading = false) {
    const outcome = this.outcomeOf(record)
    const thread = this.snapshot().threads.find(item => item.id === record.delegatedThreadId)
    const latest = this.records.findLast(item => item.delegatedThreadId === record.delegatedThreadId && item.deliveryState === 'accepted')
    const head = thread ? userHead(thread) : null
    const held = this.heldNow(record, thread, false)
    const note = record.deliveryState === 'failed' ? FAILURE_NOTES[record.failure ?? 'provider'] : !thread && (outcome === 'unknown' || outcome === 'failed') ? GONE
      : held ? heldWords(held.minutes, held.laterTurn).replace(/^h/u, 'H') : NOTES[outcome]
    const read: { -readonly [K in keyof DelegationRead]: DelegationRead[K] } = { id: record.id, thread: record.delegatedThreadId, work: record.work, action: record.action,
      outcome, note, createdAt: record.createdAt, ...(record.turnMessageId ? { turnMessageId: record.turnMessageId } : {}),
      ...(latest && head !== null && head !== latest.messageId ? { userSentSince: true } : {}),
      ...(record.failure === 'target-changed' ? { refusal: 'TARGET_CHANGED' as const } : record.failure === 'paused' ? { refusal: 'PAUSED' as const } : {}) }
    const ticket = this.waitingChecks.has(record.id) ? this.checkTickets.get(record.id) : undefined
    const ahead = ticket !== undefined ? this.options.checks?.ahead(ticket) : undefined
    if (ahead !== undefined) read.check = { ahead, note: checkWaitingWords(this.options.checks!.machine, ahead) }
    if (outcome === 'answered' && record.replyMessageId) {
      const reply = this.replyOf(record, thread)
      if (reply.replyUnavailable) read.replyUnavailable = reply.replyUnavailable
      else if (reply.reply) read.reply = { from: 'delegated-thread', thread: record.delegatedThreadId, ...reply.reply }
    }
    record.told = outcome
    if (held !== undefined) record.releaseTold = true
    if (reading && thread) { const link = this.links.get(record.delegatedThreadId); if (link) link.seenHead = head }
    await this.persist()
    return { status: 'ok' as const, delegation: read, limits: this.limits(record) }
  }
  /**
   * An answered brief's reply, cut to `WATCHER_REPLY_BYTES_MAX`, as `read_delegation` and the hidden news both give it, or
   * why it is not there: with Keep local history off, a reply from before a restart is not kept.
   */
  private replyOf(record: DelegationRecord, thread: AgentThread | undefined): DelegationNewsDetail {
    const replyId = record.replyMessageId
    if (!replyId) return {}
    if (!this.options.historyEnabled() && !this.answeredThisRun.has(record.id)) return { replyUnavailable: 'Keep local history is off, so Sotto did not keep this reply after it restarted. Read the delegated thread for what it said.' }
    const message = thread?.messages.find(item => item.id === replyId && item.role === 'assistant') ?? this.options.host.threadMessage(record.delegatedThreadId, replyId)
    if (!message || message.role !== 'assistant') return { replyUnavailable: 'Sotto no longer holds this reply. Read the delegated thread for what it said.' }
    const text = cutUtf8(message.text, WATCHER_REPLY_BYTES_MAX)
    return { reply: { messageId: message.id, text, truncated: text !== message.text } }
  }
  /**
   * The words of a delegating thread's hidden news as Sotto sends it (ADR-0081, October 19, 2026): each delegation's outcome
   * from this record, an answered one's reply labelled as the delegated thread's own words, and why a brief that never
   * went did not. Read as it is sent, so the queue never holds a reply.
   */
  private newsText(threadId: string, news: readonly DelegationNews[]): string | undefined {
    const queued = news.reduce<DelegationNews | undefined>((all, part) => foldDelegationNews(all, part), undefined)
    if (!queued || this.closed) return undefined
    const threads = new Map(this.snapshot().threads.map(thread => [thread.id, thread]))
    // A release queued while the thread that delegated was busy says "held" only if the delegated thread is idle still.
    const folded: DelegationNews = { ...queued, items: queued.items.map(item => {
      if (item.heldMinutes === undefined) return item
      const record = this.record(item.delegationId)
      if (record && this.heldNow(record, threads.get(record.delegatedThreadId), false)) return item
      // Its thread is working again: the release is not used up. It comes again after twenty more idle minutes.
      if (record?.releasedAt) {
        this.lastWorking.set(record.id, this.clock())
        this.update(record.id, saved => { delete saved.releasedAt; delete saved.releaseTold })
      }
      const { heldMinutes, ...rest } = item; void heldMinutes
      return rest
    }) }
    const details = new Map<string, DelegationNewsDetail>()
    for (const item of folded.items) {
      const record = this.record(item.delegationId)
      // A delegation relayed to another machine (#1316) carries its reply as that machine sent it with the news.
      if (!record) { const relayed = this.options.relay?.detail(item.delegationId); if (relayed && item.outcome === 'answered') details.set(item.delegationId, relayed); continue }
      if (record.delegatingThreadId !== threadId) continue
      if (record.deliveryState === 'failed') details.set(record.id, { notSent: FAILURE_NOTES[record.failure ?? 'provider'] })
      else if (item.outcome === 'answered' && this.outcomeOf(record) === 'answered') details.set(record.id, this.replyOf(record, threads.get(record.delegatedThreadId)))
      else if (item.heldMinutes !== undefined) {
        // The brief's turn's own reply, while that turn is still the thread's newest: never a later turn's words.
        const thread = threads.get(record.delegatedThreadId), held = this.heldNow(record, thread, false)
        const reply = thread && held && !held.laterTurn ? watcherNewestTurnReply(thread) : undefined
        details.set(record.id, { ...reply ? { lastReply: reply.text } : {}, ...held?.laterTurn ? { laterTurn: true as const } : {} })
      }
    }
    return delegationNewsText(folded, details)
  }
  private listing(caller: AgentThread, snapshot: AgentHostSnapshot) {
    // The newest twenty, refused ones among them, oldest first.
    const own = [...this.records.filter(record => record.delegatingThreadId === caller.id).slice(-20).map(record => ({ id: record.id,
      thread: record.delegatedThreadId as string | undefined, work: record.work, action: record.action, outcome: this.outcomeOf(record) as DelegationOutcome,
      refusal: undefined as DelegationRefusalCode | undefined, createdAt: record.createdAt })),
    ...this.refusals.filter(refused => refused.delegatingThreadId === caller.id).slice(-20).map(refused => ({ id: refused.id, thread: refused.delegatedThreadId,
      work: refused.work, action: refused.action, outcome: 'refused' as DelegationOutcome, refusal: refused.code as DelegationRefusalCode | undefined, createdAt: refused.createdAt }))]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-20)
      .map(({ thread, refusal, ...item }) => ({ ...item, ...(thread ? { thread } : {}), ...(refusal ? { refusal } : {}) }))
    // Those started on another machine through the desktop (#1316), with the machine, as last read there.
    const elsewhere = this.options.relay?.list(caller.id) ?? []
    const ready = this.ready(snapshot).map(model => ({ provider: model.providerId!, model: model.id, name: model.name,
      efforts: withoutUltracode(model.reasoningEfforts ?? []), permissions: model.runtimeModes ?? [] }))
    // On a headless host (#1310), the new-thread default it holds starts to, and why when it holds them to Ask for approval.
    const hold = this.options.newThreadCeiling?.()
    return { status: 'ok' as const, delegations: own, ...(elsewhere.length ? { onOtherMachines: elsewhere } : {}), models: ready, ...(this.options.roles ? { roles: this.roles(caller, snapshot, this.options.roles()) } : {}),
      ...(hold ? { newThreadDefault: { permission: hold.mode, ...(hold.held ? { note: HOST_CEILING_HOLD_WORDS[hold.held] } : {}) } } : {}), limits: this.limits() }
  }
  /**
   * The machines this thread could name, as Watcher's `list_machines` gives them (#1032), while Work across machines is on.
   * Reads each machine's facts when asked, and only then.
   */
  async machines(threadId: string): Promise<unknown> {
    try {
      this.caller(threadId, this.snapshot())
      if (!this.options.machines) return delegationRefusal('INVALID_INPUT', 'That tool is unavailable.')
      return await this.options.machines.list()
    } catch (error) { return error instanceof Refusal ? error.result : delegationRefusal('PROVIDER_UNAVAILABLE', 'Sotto could not read the machines just now. Nothing was changed.') }
  }
  /**
   * What each kind of work would start on now with nothing named (#1041): the worker role's model, effort and permission,
   * held to this thread's ceiling. A kind no ready model can do is left out.
   */
  private roles(caller: AgentThread, snapshot: AgentHostSnapshot, choices: WorkerRoleChoices) {
    return WORKER_KINDS.flatMap(work => {
      const start = roleInForce(work, choices, snapshot.models).start
      if (!start) return []
      let permission: AgentRuntimeMode | undefined
      try { permission = start.runtimeMode ? this.heldToCeiling(start.runtimeMode, start.model, caller, snapshot.models)?.mode : undefined } catch { permission = undefined }
      return [{ work, provider: start.model.providerId, model: start.modelId, ...(start.reasoningEffort ? { effort: start.reasoningEffort } : {}), ...(permission ? { permission } : {}) }]
    })
  }
  /** Whether the thread's running turn is this brief's own. */
  private answering(record: DelegationRecord, thread: AgentThread): boolean {
    const head = nativeHead(thread)
    return head === record.messageId || record.deliveryState !== 'accepted'
  }

  private transaction<T>(work: () => Promise<T>): Promise<T> {
    const task = this.tail.catch(() => undefined).then(work); this.tail = task; return task
  }
  /** Keeps the newest records, dropping only ended ones, so the file stays bounded and nothing open is forgotten. */
  private trim(): void {
    if (this.records.length <= RECORDS_MAX) return
    const excess = this.records.length - RECORDS_MAX
    let dropped = 0
    // A brief still open, or one the delegating thread's current turn counts against its budget, is never dropped.
    this.briefsRevision++
    this.records = this.records.filter(record => this.open(record) || this.roots.get(record.delegatingThreadId) === record.rootUserMessageId || dropped++ >= excess)
    const kept = new Set(this.records.map(record => record.delegatedThreadId))
    if (this.links.size > RECORDS_MAX) for (const threadId of [...this.links.keys()].slice(0, this.links.size - RECORDS_MAX)) if (!kept.has(threadId)) this.links.delete(threadId)
  }
  /**
   * Cleared threads leave the record (ADR-0140 decision 4): every finished delegation either side of them, their links,
   * their turn roots and the refusals they were told. A delegation still open is kept: clearing never takes a thread
   * whose delegated threads are working, so one is left only by a race, and its outcome still needs its record.
   */
  forgetThreads(threadIds: ReadonlySet<string>): Promise<void> {
    const named = (record: { readonly delegatingThreadId: string; readonly delegatedThreadId?: string | undefined }): boolean =>
      threadIds.has(record.delegatingThreadId) || record.delegatedThreadId !== undefined && threadIds.has(record.delegatedThreadId)
    const records = this.records.filter(record => !named(record) || this.open(record))
    const refusals = this.refusals.filter(refusal => !named(refusal))
    let changed = records.length !== this.records.length || refusals.length !== this.refusals.length
    if (records.length !== this.records.length) this.records = records
    if (refusals.length !== this.refusals.length) this.refusals = refusals
    for (const [threadId, link] of [...this.links]) if (threadIds.has(threadId) || threadIds.has(link.delegatingThreadId)) { this.links.delete(threadId); changed = true }
    for (const threadId of threadIds) {
      if (this.roots.delete(threadId)) changed = true
      this.queuedBriefs.delete(threadId); this.paused.delete(threadId); this.untold.delete(threadId); this.lastWorking.delete(threadId); this.viewsChanged.delete(threadId)
    }
    return changed ? this.persist() : Promise.resolve()
  }
  /** Writes the record as it is now; rejects when it could not be saved. */
  private save(): Promise<void> {
    return this.store.writeLatest(() => ({ version: 1, delegations: this.records.slice(-RECORDS_MAX * 2), links: [...this.links.values()].slice(-RECORDS_MAX),
      roots: [...this.roots].slice(-RECORDS_MAX).map(([threadId, rootUserMessageId]) => ({ threadId, rootUserMessageId })), refusals: this.refusals.slice(-REFUSALS_MAX) }))
  }
  /** Writes the record where a failed write changes nothing already decided: the next write carries it. */
  private persist(): Promise<void> { return this.save().catch(() => undefined) }
}
