import { z } from 'zod'
import { AGENT_TEXT_MAX, agentRuntimeModeSchema, handoverCountsSchema, PROVIDER_LABELS, providerIdSchema, type AgentModel, type AgentRuntimeMode, type AgentThread,
  type ProviderId } from './agents'
import { branchMoveIdSchema } from './branchMoves'
import { continuePermission, sourcePermission } from './continueThread'
import { hostNewThreadPermission, RUNTIME_MODE_ORDER } from './newThreadDefaults'
import { isThreadArchived, isThreadTurnRunning } from './threadActivity'
import { RUNTIME_MODE_WORDS } from './workerRoles'

/**
 * Moving a thread to another machine (#1178, ADR-0105 decision 7): "continue on another machine" (ADR-0089). The **move**
 * makes a new thread with its own Sotto thread ID on the target machine, in its copy of the project, from the source's
 * branch, on the same provider, model and effort, whose first prompt is the source's handover and a facts block Sotto
 * writes. It starts working at once (Zach, October 29, 2026). The source is fenced while it moves and settled once the new
 * thread's first turn has ended; its worktree is kept. Nothing is a moved session.
 *
 * Part of the Owl feature Work across machines (`cross-machine-work`, ADR-0072): stable builds no service, registers no
 * bridge and lists no host feature. This part moves This computer's threads to a paired host, with no window of its own.
 */

/** What the Move threads sheet would do now, and why a thread stays. */
export const THREAD_MOVE_PREPARE = 'sotto:thread-move:prepare'
/** Starts the moves the user confirmed. */
export const THREAD_MOVE_START = 'sotto:thread-move:start'
/** How long a prepared plan can be confirmed, as Stop all's preview. */
export const THREAD_MOVE_CONFIRMATION_MS = 60_000
/** The most threads one sheet names. */
export const THREAD_MOVE_THREADS_MAX = 100

const id = z.string().min(1).max(512)
const words = z.string().min(1).max(600)
const machineName = z.string().min(1).max(200)

export const threadMovePrepareRequestSchema = z.object({
  /** The threads to move, by the window's IDs for them. */
  threadIds: z.array(id).min(1).max(THREAD_MOVE_THREADS_MAX),
  /** The machine they go to, by its host ID. */
  hostId: z.uuid(),
}).strict()
export type ThreadMovePrepareRequest = z.infer<typeof threadMovePrepareRequestSchema>

/**
 * What the sheet says of one thread: it moves now, it asks first because it would start narrower there, or it stays, and
 * why. `words` is said for the last two.
 */
export const threadMoveOutcomeSchema = z.enum(['moves', 'asks', 'stays'])
export type ThreadMoveOutcome = z.infer<typeof threadMoveOutcomeSchema>
/**
 * The model a move starts on there, by its name, and the source's own by its name when the machine lacks it, so the sheet
 * and the card say which model it runs on (Zach, October 29, 2026).
 */
const moveModelSchema = z.object({ name: machineName, instead: machineName.optional() }).strict()
export type ThreadMoveModel = z.infer<typeof moveModelSchema>
/** `startsOn` names the permission a thread that asks first would start on there, for the press that moves it anyway. */
const plannedSchema = z.object({ threadId: id, outcome: threadMoveOutcomeSchema, words: words.optional(), model: moveModelSchema.optional(), startsOn: machineName.optional() }).strict()
export type ThreadMovePlanned = z.infer<typeof plannedSchema>
export const threadMovePrepareSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), confirmationId: z.uuid(), expiresAt: z.iso.datetime(), machine: machineName,
    threads: z.array(plannedSchema).max(THREAD_MOVE_THREADS_MAX) }).strict(),
  z.object({ status: z.literal('refused'), message: words }).strict(),
])
export type ThreadMovePrepare = z.infer<typeof threadMovePrepareSchema>

export const threadMoveStartRequestSchema = z.object({
  confirmationId: z.uuid(),
  /** The threads the user confirmed, by the window's IDs for them: some or all of those the plan moves or asks about. */
  threadIds: z.array(id).min(1).max(THREAD_MOVE_THREADS_MAX),
  /** The threads that ask first and that the user pressed to move anyway, narrower as the plan said. */
  allowNarrower: z.array(id).max(THREAD_MOVE_THREADS_MAX),
}).strict()
export type ThreadMoveStartRequest = z.infer<typeof threadMoveStartRequestSchema>
/** What became of one thread: it is moving under its move's ID, it still asks first, or it stays, and why. */
const startedSchema = z.object({ threadId: id, outcome: z.enum(['moving', 'asks', 'stays']), moveId: z.uuid().optional(), words: words.optional() }).strict()
export const threadMoveStartSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), moves: z.array(startedSchema).max(THREAD_MOVE_THREADS_MAX) }).strict(),
  z.object({ status: z.literal('refused'), message: words }).strict(),
])
export type ThreadMoveStart = z.infer<typeof threadMoveStartSchema>

/** Every move's card for Watcher's conversation, as main holds them now. */
export const THREAD_MOVES_READ = 'sotto:thread-move:read'
/** The cards again, pushed whenever one changes. */
export const THREAD_MOVES_CHANGED = 'sotto:thread-move:changed'
/** The user's press on a card that asks first: move it anyway, or keep it here. */
export const THREAD_MOVE_ANSWER = 'sotto:thread-move:answer'
/** The most cards main holds for the window: the moves it keeps, and this run's cards that ask or say why a thread stayed. */
export const THREAD_MOVE_CARDS_MAX = 700

/**
 * Where a move's card stands (Zach's pick B, October 29, 2026). A move's own record steps through the first five and ends
 * in one of the next three. `asks` waits for the user's press because it would start narrower there, `kept` is a card the
 * user kept here from that press, and `stays` is one the confirmation itself could not move; those three are this run's
 * own and are not saved.
 */
export const THREAD_MOVE_CARD_STATES = ['fenced', 'branch-sent', 'thread-started', 'first-turn-ended', 'source-settled', 'given-back', 'stayed', 'asks', 'kept', 'stays'] as const
export type ThreadMoveCardState = typeof THREAD_MOVE_CARD_STATES[number]
const threadTargetSchema = z.object({ hostId: z.uuid(), threadId: id }).strict()
export const threadMoveCardSchema = z.object({
  /** The move's ID, or the card's own for one that asks, was kept here or stayed. */
  id: z.uuid(),
  state: z.enum(THREAD_MOVE_CARD_STATES),
  /** The thread here, and the thread that continues it there once the machine has made one. */
  source: threadTargetSchema,
  moved: threadTargetSchema.optional(),
  hostId: z.uuid(),
  machine: machineName,
  /** Why it asks, why it stayed or why it was given back, in its words. */
  words: z.string().min(1).max(1_200).optional(),
  model: moveModelSchema.optional(),
  /** The permission one that asks first would start on there. */
  startsOn: machineName.optional(),
  /** The move waits on a machine that is not connected or has not answered. Part 4 reconciles it. */
  waiting: z.literal(true).optional(),
  /** Whether Watcher watches the new thread now. */
  watched: z.literal(true).optional(),
  /** When the user confirmed it, where the card goes in Watcher's conversation; and when it last changed. */
  at: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict()
export type ThreadMoveCard = z.infer<typeof threadMoveCardSchema>
export const threadMovesViewSchema = z.object({ cards: z.array(threadMoveCardSchema).max(THREAD_MOVE_CARDS_MAX) }).strict()
export type ThreadMovesView = z.infer<typeof threadMovesViewSchema>

export const threadMoveAnswerRequestSchema = z.object({ cardId: z.uuid(), answer: z.enum(['move', 'keep']) }).strict()
export type ThreadMoveAnswerRequest = z.infer<typeof threadMoveAnswerRequestSchema>
/** What came of the press: the card as it stands now, or why nothing changed. */
export const threadMoveAnswerSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok') }).strict(),
  z.object({ status: z.literal('refused'), message: words }).strict(),
])
export type ThreadMoveAnswer = z.infer<typeof threadMoveAnswerSchema>

export interface ThreadMovesBridge {
  prepare(request: ThreadMovePrepareRequest): Promise<ThreadMovePrepare>
  start(request: ThreadMoveStartRequest): Promise<ThreadMoveStart>
  read(): Promise<ThreadMovesView>
  answer(request: ThreadMoveAnswerRequest): Promise<ThreadMoveAnswer>
  onChanged(listener: (view: ThreadMovesView) => void): () => void
}

const capital = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1)
/**
 * The words a move says. Each reason a thread stays says what holds it and what to do (Zach, October 21, 2026, the
 * decided list); the rest say what happened, whether anything moved, and what to do next. Not settled with Zach beyond
 * the fence's sentence.
 */
export const THREAD_MOVE_WORDS = {
  watcher: 'Watcher stays on This computer.',
  delegated: 'A delegated thread stays with the thread that delegated it.',
  delegating: 'Threads this one delegated to are still working. Move it once they finish.',
  running: 'A turn is running. Move it once the turn ends, or stop it.',
  waiting: 'This thread is waiting for your answer. Answer it, then move it.',
  background: 'Work this thread started is still running in the background. Move it once that finishes.',
  unresolved: 'A message to this thread is still on its way or unconfirmed. Move it once it has gone.',
  uncommitted: 'This thread has uncommitted changes. Commit them first, then move it.',
  notOnBranch: 'This thread isn’t on a branch. Check out a branch first, then move it.',
  remote: 'Only This computer’s threads move for now.',
  archived: 'This thread is archived. Restore it to move it.',
  empty: 'Nothing to hand over: this thread has no messages yet.',
  gone: 'This thread is no longer here.',
  moving: (machine: string): string => `This thread is already moving to ${machine}.`,
  noProvider: (provider: ProviderId, machine: string): string => `${capital(machine)} has no ${PROVIDER_LABELS[provider]} ready. Connect it there, then move this thread.`,
  /** The fence's sentence (Zach's, #1178): a send to a moving thread is refused with it. */
  fence: (machine: string): string => `This thread is moving to ${machine}. It takes no sends here while it moves.`,
  notConnected: (machine: string): string => `${capital(machine)} isn’t connected, so nothing can move there now. Connect it, then try again. Nothing was moved.`,
  olderHost: (machine: string): string => `${capital(machine)} needs a newer Sotto before threads can move there. Update it from the Threads page, then try again. Nothing was moved.`,
  unknownMachine: 'Sotto knows no machine by that name. Nothing was moved.',
  expired: 'The threads to move changed, or this preview expired. Review Move threads again. Nothing was moved.',
  notInPlan: 'That thread wasn’t in this preview. Review Move threads again. Nothing was moved.',
  unreadable: 'Sotto could not read this thread’s history, so nothing was moved. Try again.',
  /** The coordinator still fences the thread for a move whose record Sotto cannot account for (#1178). */
  fenced: 'An earlier move of this thread is still open, and Sotto can’t read its record, so it can’t move again. Nothing was moved. Restart Sotto to try again.',
  /** One preview names the same thread twice, by two of its IDs. */
  twice: 'This thread is already named in this preview.',
  unsaved: 'Sotto could not save this move, so nothing was moved. Try again.',
  unread: 'Sotto could not read that request. Nothing was moved.',
  /** A move given back before any thread was made for it: why, in the step's own words, and that the source is open again. */
  givenBack: (why: string): string => `${why} This thread stays on This computer and takes sends again.`,
  /** This computer's record of moves could not be read: no move starts, and the moves it named stay fenced. */
  unreadableRecord: 'Sotto could not read its record of thread moves, so no thread can move now. Nothing was moved. Restart Sotto to try again.',
  /** A thread a record Sotto cannot read names as moving. */
  unreadableFence: (machine: string | undefined): string => `This thread was moving${machine ? ` to ${machine}` : ''}, and Sotto cannot read its record of the move, so it takes no sends here. Nothing was lost. Restart Sotto to try again.`,
  /** A thread moving when Sotto last ran with Work across machines on, which this run does not have. */
  paused: (machine: string): string => `This thread is moving to ${machine}, and this Sotto doesn’t move threads, so it takes no sends here. Nothing was lost. Open Sotto Owl to finish the move.`,
  /** A move whose new thread did not finish its first turn: the source stays, and the new thread is left there. */
  stayed: (machine: string, failed: boolean): string =>
    `The new thread on ${machine} ${failed ? 'failed' : 'was stopped'} in its first turn, so this thread stays on This computer and takes sends again. The new thread is still on ${machine}.`,
  /** A card that asked first is no longer this run's: Sotto restarted, or the card was answered. */
  noCard: 'That move isn’t waiting for an answer any more. Nothing was moved.',
} as const

/** What a thread's move eligibility reads beside the thread itself, each from the coordinator's own record. */
export interface MoveEligibility {
  /** The machine it would go to, by its saved name. */
  readonly machine: string
  /** Threads it delegated to are still working, here or on another machine. */
  readonly delegatedWorking: boolean
  /** Its provider's background work and monitors still running, as Watcher counts them. */
  readonly backgroundWork: number
  /** A send to it is on its way or unconfirmed, or news waits in its queue. */
  readonly unresolved: boolean
  /** It is moving already, and where to. */
  readonly movingTo?: string | undefined
  /** The coordinator still fences it for a move this computer's record does not hold. */
  readonly fenced?: boolean | undefined
}

/**
 * Why a thread cannot move now, in its plain words, or null when it can (Zach, October 21, 2026): a turn running, a
 * question or permission card, background work, an unresolved send, uncommitted work, a delegating thread with children
 * still working, any delegated thread, and Watcher's own thread. A thread on another machine, an archived one and one with
 * nothing to hand over stay too. Uncommitted work is read from the folder's last Git status here; the branch's own check
 * refuses it again as the move runs.
 */
export function threadMoveRefusal(thread: Pick<AgentThread, 'kind' | 'remoteHost' | 'archivedAt' | 'status' | 'lastTurn' | 'requests' | 'delegatedBy' | 'worktree'
  | 'messages' | 'summary' | 'nativeSessionStarted'>, context: MoveEligibility): string | null {
  if (thread.kind === 'watcher' || thread.kind === 'watcher-history') return THREAD_MOVE_WORDS.watcher
  if (thread.remoteHost === true) return THREAD_MOVE_WORDS.remote
  if (isThreadArchived(thread)) return THREAD_MOVE_WORDS.archived
  if (context.movingTo !== undefined) return THREAD_MOVE_WORDS.moving(context.movingTo)
  if (context.fenced === true) return THREAD_MOVE_WORDS.fenced
  if (thread.delegatedBy !== undefined) return THREAD_MOVE_WORDS.delegated
  if (context.delegatedWorking) return THREAD_MOVE_WORDS.delegating
  if (isThreadTurnRunning(thread)) return THREAD_MOVE_WORDS.running
  if (thread.requests.length > 0) return THREAD_MOVE_WORDS.waiting
  if (context.backgroundWork > 0) return THREAD_MOVE_WORDS.background
  if (context.unresolved) return THREAD_MOVE_WORDS.unresolved
  if (thread.nativeSessionStarted === false || (thread.summary?.messageCount ?? thread.messages.length) === 0 && thread.messages.length === 0) return THREAD_MOVE_WORDS.empty
  const git = thread.worktree?.git
  if (git && git.isRepository && git.branch === null) return THREAD_MOVE_WORDS.notOnBranch
  if (git?.dirty === true || thread.worktree?.dirty === true) return THREAD_MOVE_WORDS.uncommitted
  return null
}

/**
 * The permission a move's new thread starts on: as a continued thread's (ADR-0089 decision 5a), the source's own, mapped to the
 * nearest the model there offers and never wider, capped by the user's new-thread default; then held to Ask for approval
 * on a machine that does not let This computer answer there, as Watcher's starts on a paired host are (ADR-0074). The host
 * holds the start to the same rule again. `narrowed` says when it would start narrower than it runs now, and why, which
 * makes the move ask first (Zach, October 21, 2026).
 */
export interface MovePermission {
  readonly runtimeMode?: AgentRuntimeMode
  readonly providerMode?: string
  /** `to` in Sotto's four; `toName` the provider's own name for it, for a thread that starts on a provider's profile. */
  readonly narrowed?: { readonly from: AgentRuntimeMode; readonly to: AgentRuntimeMode; readonly by: 'default' | 'provider' | 'machine'; readonly toName?: string }
}
/** A provider profile as Sotto's four, as continuing reads one: what it allows, or asking when it says nothing. */
const PROFILE_ALLOWS: Readonly<Record<'nothing' | 'edits' | 'everything', AgentRuntimeMode>> = { nothing: 'approval-required', edits: 'auto-accept-edits', everything: 'full-access' }
export function movePermission(source: Pick<AgentThread, 'runtimeMode' | 'providerMode'>, sourceModel: AgentModel | undefined, target: AgentModel | undefined,
  newThreadDefault: AgentRuntimeMode | undefined, mayAnswer: boolean): MovePermission {
  const index = (mode: AgentRuntimeMode): number => RUNTIME_MODE_ORDER.indexOf(mode)
  const own = sourcePermission(source, sourceModel)
  // A provider's own profile, as Devin's are, is compared by what it allows, so a narrower one asks first too.
  const profile = (providerMode: string): MovePermission => {
    const mode = target?.providerModes?.find(item => item.id === providerMode)
    const to = mode?.allows ? PROFILE_ALLOWS[mode.allows] : 'approval-required'
    return { providerMode, ...own.known && index(to) < index(own.mode) ? { narrowed: { from: own.mode, to, by: 'provider' as const, ...mode ? { toName: mode.name } : {} } } : {} }
  }
  const continued = continuePermission(source, sourceModel, target, newThreadDefault)
  if (continued.providerMode !== undefined) return profile(continued.providerMode)
  const held = hostNewThreadPermission(target, continued.runtimeMode, mayAnswer)
  if (held.providerMode !== undefined) return profile(held.providerMode)
  if (held.runtimeMode === undefined) return {}
  const narrower = own.known && index(held.runtimeMode) < index(own.mode)
  const by = held.heldBack ? 'machine' as const : continued.narrowed?.by
  return { runtimeMode: held.runtimeMode, ...narrower && by ? { narrowed: { from: own.mode, to: held.runtimeMode, by } } : {} }
}
/** The name of the permission a move that asks first would start on there. */
export const narrowedName = (narrowed: NonNullable<MovePermission['narrowed']>): string => narrowed.toName ?? RUNTIME_MODE_WORDS[narrowed.to]
/** Why a move asks first, in words: what it would start on there, and what holds it back. */
export function movePermissionWords(narrowed: NonNullable<MovePermission['narrowed']>, machine: string): string {
  const to = narrowed.toName ?? RUNTIME_MODE_WORDS[narrowed.to], from = RUNTIME_MODE_WORDS[narrowed.from]
  const why = narrowed.by === 'default' ? 'your new-thread default allows no more'
    : narrowed.by === 'machine' ? `${machine} doesn’t let This computer answer there`
      : narrowed.toName ? `a new thread on that provider starts on ${narrowed.toName}` : 'the model there offers nothing as wide'
  return `It would start on ${to} on ${machine}, not this thread’s ${from}, since ${why}.`
}

/**
 * What the facts block says (#1178): where the thread ran and what it is called, its branch and commit, its open pull
 * requests and whether babysitting ran for them, and whether Watcher watched it. Sotto's own record; no model is asked.
 */
export interface MoveFacts {
  readonly title: string
  /** The machine it ran on, as This computer names machines: "This computer" for this one. */
  readonly from: string
  readonly to: string
  readonly branch: string
  readonly commit: string
  readonly pullRequests: readonly { readonly number: number; readonly title: string; readonly draft?: boolean | undefined }[]
  /** The pull requests babysitting ran for on the source, by number. */
  readonly babysat: readonly number[]
  readonly watched: boolean
}
/** The line after a move's handover that says Sotto's facts follow. */
export const MOVE_HANDOVER_CLOSE = '[End of the handover. Sotto’s facts about the move follow.]'
/** The facts block, as plain lines after the handover. */
export function moveFacts(facts: MoveFacts): string {
  const listed = facts.pullRequests.map(pr => `#${pr.number} “${pr.title}”${pr.draft ? ' (draft)' : ''}`)
  return [
    `This thread continues “${facts.title}”, which ran on ${facts.from} until the user moved it here, to ${facts.to}. These facts are Sotto’s own:`,
    `- Branch: ${facts.branch}, at commit ${facts.commit}. This thread’s worktree was made from it.`,
    listed.length ? `- Open pull request${listed.length === 1 ? '' : 's'}: ${listed.join(', ')}.` : '- No open pull request is linked to it.',
    ...facts.babysat.length ? [`- Sotto was babysitting ${facts.babysat.map(number => `#${number}`).join(', ')} on ${facts.from}.`] : [],
    facts.watched ? `- Watcher watched it on ${facts.from}, and watches this thread now.` : '- Watcher did not watch it.',
    '',
    'Pick up the work where the handover leaves it.',
  ].join('\n')
}
/** A move's first prompt: the handover, the line that closes it, and the facts block. */
export function movePrompt(handover: string, facts: MoveFacts): string {
  return `${handover}\n\n${MOVE_HANDOVER_CLOSE}\n\n${moveFacts(facts)}`
}

/**
 * What a desktop asks of a host that lists `thread-move` (`thread-move` on the socket, #1178). `start` makes the moved
 * thread in a new worktree from the move's incoming ref, which the desktop landed in `projectId` first, and sends it its
 * first prompt; a second `start` with the same move answers the thread the first made. The host holds its permission to
 * what it lets that desktop give there. `from` names the source on the desktop's side, for the new thread's link back.
 * Later parts add an exact read and a fence for a move the desktop gives up on (ADR-0105 decision 7, "Reconciling").
 */
export const hostThreadMoveRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), moveId: branchMoveIdSchema, projectId: id,
    title: id, titleSource: z.literal('user').optional(), modelId: z.string().min(1).max(6_144),
    reasoningEffort: z.string().min(1).max(64).optional(), runtimeMode: agentRuntimeModeSchema.optional(),
    from: z.object({ threadId: id, provider: providerIdSchema, hostId: z.uuid() }).strict(),
    prompt: z.string().min(1).max(AGENT_TEXT_MAX),
    /** The handover's length and digest within `prompt`, and what it carried, never its words: the new thread's link back keeps them. */
    handover: z.object({ prefixLength: z.number().int().nonnegative().max(AGENT_TEXT_MAX), prefixDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      counts: handoverCountsSchema }).strict() }).strict(),
])
export type HostThreadMoveRequest = z.infer<typeof hostThreadMoveRequestSchema>
/**
 * Why a host refuses a start. Each is definite, the host holds no thread and no record for the move, except `move-differs`,
 * where it holds another start under that ID, and `unreadable`, where it cannot read its own record and so cannot say: the
 * desktop keeps those moves fenced and asks again later.
 */
export const THREAD_MOVE_REFUSALS = ['unknown-project', 'model-unavailable', 'move-differs', 'failed', 'full', 'unreadable'] as const
/** The refusals that do not prove the host made no thread for the move. */
export const THREAD_MOVE_UNDECIDED: ReadonlySet<string> = new Set(['move-differs', 'unreadable'])
export const threadMoveRefusalSchema = z.object({ type: z.literal('refused'), reason: z.enum(THREAD_MOVE_REFUSALS), message: words }).strict()
/**
 * The host's answer to `start`: the thread it made for the move, by its own Sotto thread ID, the permission it started on,
 * and whether its first prompt went; or a refusal, definite but for those `THREAD_MOVE_UNDECIDED` names.
 */
export const threadMoveStartAnswerSchema = z.union([
  z.object({ type: z.literal('started'), moveId: branchMoveIdSchema, threadId: id, runtimeMode: agentRuntimeModeSchema.optional(),
    providerMode: z.string().min(1).max(6_144).optional(), sent: z.boolean(), message: words.optional() }).strict(),
  threadMoveRefusalSchema,
])
export type ThreadMoveStartAnswer = z.infer<typeof threadMoveStartAnswerSchema>
/** The host's words for a start it refused or could not send. */
export const HOST_THREAD_MOVE_WORDS = {
  unknownProject: 'That project is not on this machine. Nothing was made.',
  modelUnavailable: 'That model isn’t ready on this machine. Nothing was made.',
  moveDiffers: 'Another start already used this move. Nothing was made.',
  failed: 'This machine could not make the thread for this move. Nothing was made.',
  notSent: 'This machine made the thread for this move, but its first prompt did not go. It is sent again when the move is retried.',
  /** The desktop's answers grant here was taken away while the start waited (ADR-0004: policy is read at dispatch). */
  grantGone: 'This machine no longer lets that computer answer here, so it starts nothing that acts without asking. Nothing was sent.',
  full: 'This machine holds the records of 10,000 moves already, so it takes no more. Nothing was made. Move the thread to another machine.',
  unreadable: 'This machine could not read its record of moves, so it starts none until it can. Nothing was made. Restart Sotto on this machine, then try again.',
} as const
/** The part of a connected host's socket a move uses (`SocketHostService`). */
export interface ThreadMoveHost {
  readonly supportsThreadMove: boolean
  threadMove(request: HostThreadMoveRequest): Promise<unknown>
}
