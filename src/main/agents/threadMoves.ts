import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { AGENT_TEXT_MAX, providerIdSchema, type AgentCommand, type AgentHostSnapshot, type AgentModel, type AgentRuntimeMode, type AgentState, type AgentThread,
  type ThreadContinuedIn } from '../../shared/agents'
import { branchNameSchema, commitIdSchema } from '../../shared/branchMoves'
import { hostEntityKey, parseHostEntityKey } from '../../shared/clientIdentity'
import { DELEGATION_LEVELS_MAX, delegatedThreadsBelow } from '../../shared/delegation'
import { resolveModel } from '../../shared/modelCatalog'
import { isThreadTurnRunning } from '../../shared/threadActivity'
import {
  movePermission, movePermissionWords, movePrompt, narrowedName, THREAD_MOVE_CARDS_MAX, THREAD_MOVE_CONFIRMATION_MS, THREAD_MOVE_UNDECIDED, THREAD_MOVE_WORDS, threadMoveAnswerRequestSchema,
  threadMovePrepareRequestSchema, threadMoveRefusal, threadMoveStartAnswerSchema, threadMoveStartRequestSchema, type MoveFacts, type ThreadMoveAnswer, type ThreadMoveCard,
  type ThreadMoveHost, type ThreadMoveModel, type ThreadMovePlanned, type ThreadMovePrepare, type ThreadMoveStart, type ThreadMovesView,
} from '../../shared/threadMoves'
import type { WatcherThreadTarget } from '../../shared/watcher'
import type { WatcherRemoteHosts } from '../../shared/watcherHost'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { readStrictJson } from '../storage/strictJsonFile'
import type { DesktopBranchMoves } from './branchMoves'
import type { CheckoutPendingWork } from './checkoutMutations'
import type { Handover } from './handover'
import { handoverCounts, handoverPrefixProof } from './watcherHandover'
import { watcherBackgroundWorkCount } from './watcherWakeUp'
import type { WatcherService } from './watcher'

/**
 * Moving This computer's threads to a paired host (#1178, part 1; ADR-0105 decision 7, Owl `cross-machine-work`). A move
 * is "continue on another machine" (ADR-0089): the host makes a new thread with its own Sotto thread ID from the source's
 * branch, and its first prompt, the source's handover and Sotto's facts, goes at once. The source is fenced while it moves
 * and settled once the new thread is listed and its first turn has ended; its worktree is kept.
 *
 * Every move has a **move record** in `moves.json`, written before anything is sent, which steps through fenced, branch
 * sent, thread started, first turn ended and source settled, or is given back while no thread exists for it. Each step is
 * idempotent by the move's ID, so a retry, or a restart in the middle, continues the move and never makes a second thread:
 * the branch lands once in its incoming ref, and the host answers the thread a first start made. A move that waits on a
 * machine that is not connected stays fenced with its state recorded and goes on once it is back.
 *
 * Driven over IPC as a prepare and confirm pair, as Stop all is: `prepare` says of each thread whether it moves now, asks
 * first because it would start narrower there, or stays and why, under a confirmation that lasts a minute; `move` starts
 * the confirmed ones. The window (part 2, Zach's pick B) shows the preview as Move threads' sheet and each move as a card
 * in Watcher's conversation (`view`): one that asks first waits there for the user's press (`answer`), and one the
 * confirmation could not move says why. Those cards are this run's and are not saved. Sotto runs the moves, not a Watcher
 * turn, and Watcher hears of each as it ends (`news`).
 *
 * Seams left for later parts: reconciling with a host whose answer was lost, by an exact read, and **Keep it here**, which
 * asks the host to fence the move (part 4, `stalled` below names what waits); a host's thread moving to This computer or
 * between hosts (part 3); starting babysitting on the target, which waits on reading the target's GitHub sign-in.
 */

/** What moving asks of main's coordinator. */
export interface MoveControl {
  hostId(): string | undefined
  /** This computer's threads as the coordinator holds them, read in place and never copied. */
  watcherSnapshot(): AgentHostSnapshot
  configuration(): { readonly newThreadRuntimeMode?: AgentRuntimeMode | undefined }
  moveHoldReason(threadId: string): CheckoutPendingWork | null
  /** Fences at once; the promise settles once the fence is in the coordinator's own record, and rejects when it could not be. */
  fenceForMove(threadId: string, words: string): void | Promise<void>
  liftMoveFence(threadId: string): void | Promise<void>
  /** The threads the coordinator's own record keeps fenced for a move, whatever this record says. */
  fencedForMove?(): readonly string[]
  /** Whether the coordinator fences this thread for a move now: its sentence, or undefined. */
  moveFenceOf?(threadId: string): string | undefined
  commandFromMove(command: Extract<AgentCommand, { type: 'settle-thread' }>, guard: () => void): Promise<AgentState>
}
/** What moving asks of this computer's workspace: a thread's handover, and the source's link to the thread that continues it. */
export interface MoveWorkspace {
  threadHandover(threadId: string): Handover | undefined
  addContinuedIn(threadId: string, link: ThreadContinuedIn): Promise<void>
}
/** Watcher's standing watches, which a move carries to the new thread. */
export type MoveWatch = Pick<WatcherService, 'hasStandingWatch' | 'moveWatch'>
/** Where moves go: the machines this computer is connected to, as Watcher reads them. */
export interface MoveTargets {
  /** The machine's name as this computer saved it, or undefined for a machine it does not know. */
  name(hostId: string): string | undefined
  /** The machine's threads, projects and models as this computer joins them, while it is connected. */
  snapshot(hostId: string): AgentHostSnapshot | undefined
  /** Whether the machine lets this computer answer there, and so give a thread a mode that acts without asking. */
  mayAnswer(hostId: string): boolean
  host(hostId: string): ThreadMoveHost | undefined
  /**
   * The machine's copy of a project on This computer, found by its GitHub origin as Watcher places a worker, set up when it
   * has none (#1690). `retryable` says the machine could not be asked just now.
   */
  place(project: { readonly hostId: string; readonly projectId: string }, hostId: string): Promise<{ readonly projectId: string } | { readonly refused: string; readonly retryable: boolean }>
  /** Hears a machine connecting, going or changing what it offers, by its host ID. Returns the unhook. */
  subscribe(listener: (hostId?: string) => void): () => void
  /**
   * Hears every change the desktop takes from any machine, a streamed reply included, for a new thread's first turn ending.
   * Returns the unhook.
   */
  subscribeUpdates?(listener: () => void): () => void
}
/** Delegation's own record, for a thread with delegations still open on any machine. */
export interface MoveDelegations { hasOpen(threadId: string): boolean }
/** A move that ended, as Watcher hears of it (#1178): the thread here, the one that continues it there, and how it ended. */
export interface MoveNews {
  readonly source: WatcherThreadTarget
  readonly movedTo?: WatcherThreadTarget | undefined
  readonly machine: string
  readonly outcome: 'moved' | 'stayed' | 'given-back'
}

const id = z.string().min(1).max(512)
export const MOVE_STATES = ['fenced', 'branch-sent', 'thread-started', 'first-turn-ended', 'source-settled', 'given-back', 'stayed'] as const
export type MoveState = typeof MOVE_STATES[number]
const recordSchema = z.object({
  id: z.uuid(),
  /** The thread moving, by this computer's own thread ID. */
  sourceThreadId: id,
  targetHostId: z.uuid(),
  /** The machine's name when the move began, for its words while it is away. */
  machine: z.string().min(1).max(200),
  state: z.enum(MOVE_STATES),
  /** What the new thread starts on, decided when the move was confirmed. */
  start: z.object({ provider: providerIdSchema, modelId: z.string().min(1).max(6_144), reasoningEffort: z.string().min(1).max(64).optional(),
    runtimeMode: z.enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access']).optional(), title: id, titleSource: z.literal('user').optional() }).strict(),
  /** Whether Watcher had a standing watch on the source when the move began. */
  watched: z.boolean(),
  /** The target's copy of the project, once found. */
  projectId: id.optional(),
  /** The branch and commit that landed in the move's incoming ref there. */
  branch: z.object({ name: branchNameSchema, commit: commitIdSchema }).strict().optional(),
  /** The start was asked of the host at least once, so a thread may exist there and the move is never given back. */
  startAsked: z.literal(true).optional(),
  /** The new thread, by the target's own thread ID, and whether its first prompt went. */
  threadId: id.optional(), sent: z.boolean().optional(),
  firstTurn: z.enum(['completed', 'interrupted', 'failed']).optional(),
  /** Whether Watcher now watches the new thread. */
  watchMoved: z.boolean().optional(),
  /** Why the move was given back, or why the source stayed, in its words. */
  givenBack: z.string().min(1).max(1_200).optional(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict()
export type MoveRecord = z.infer<typeof recordSchema>
const fileSchema = z.object({ version: z.literal(1), moves: z.array(recordSchema).max(10_000),
  /**
   * The sources of moves not given back and not stayed, whose worktrees no automatic cleanup removes (Zach, October 21, 2026).
   * Kept apart from the moves' history, which is trimmed, and let go of only when the thread itself is deleted.
   */
  kept: z.array(id).max(100_000).optional() }).strict()
type MovesFile = z.infer<typeof fileSchema>
const empty = (): MovesFile => ({ version: 1, moves: [] })
/** Finished moves kept, newest last; a move under way is never dropped. */
const FINISHED_KEPT = 500
/** How long a step that could not reach the target waits before it is tried again, whatever else the machine says. */
const RETRY_MS = 5_000
/** How many times in a row Watcher's watch is tried before the move waits, unsettled and fenced, for part 4 to show it. */
const WATCH_TRIES = 5
const UNFINISHED = new Set<string>(MOVE_STATES.filter(state => state !== 'source-settled' && state !== 'given-back' && state !== 'stayed'))
/**
 * What a record that does not read as a whole still names: each move it calls unfinished, with its source and machine, and
 * every source whose worktree it keeps. Read leniently, so a source is fenced and kept whenever anything says it might move.
 */
function namedIn(raw: unknown): { readonly moving: readonly { readonly threadId: string; readonly machine?: string | undefined }[]; readonly kept: readonly string[] } {
  const file = raw !== null && typeof raw === 'object' ? raw as { moves?: unknown; kept?: unknown } : {}
  const moves = Array.isArray(file.moves) ? file.moves.filter((move): move is Record<string, unknown> => move !== null && typeof move === 'object') : []
  const moving = moves.filter(move => typeof move.sourceThreadId === 'string' && !(typeof move.state === 'string' && !UNFINISHED.has(move.state)))
    .map(move => ({ threadId: move.sourceThreadId as string, machine: typeof move.machine === 'string' ? move.machine.slice(0, 200) : undefined }))
  const kept = [...Array.isArray(file.kept) ? file.kept.filter((item): item is string => typeof item === 'string') : [],
    ...moves.flatMap(move => typeof move.sourceThreadId === 'string' && move.state !== 'given-back' && move.state !== 'stayed' ? [move.sourceThreadId] : [])]
  return { moving, kept }
}
/**
 * This computer's moves while this run does not move threads, as with Work across machines or Watcher off (ADR-0072): the
 * record is read, never written, and every source of a move not finished is fenced, so a thread that may already work on
 * another machine takes no sends here; the worktrees it keeps stay kept. Nothing steps and nothing is shown.
 */
export interface HeldMoves {
  keepsWorktree(threadId: string): boolean
  /**
   * Once the coordinator has read its own record: lifts each fence it kept that a record that reads shows no move under way
   * for, as one whose lift was not saved. With a record that does not read, or none, every fence it kept stays.
   */
  settleFences(): void
}
export async function holdUnfinishedMoves(directory: string, control: Pick<MoveControl, 'fenceForMove' | 'liftMoveFence' | 'fencedForMove'>): Promise<HeldMoves> {
  const read = await readStrictJson(join(directory, 'moves.json'), input => fileSchema.parse(input))
  const keep = (): void => undefined
  if (read.status === 'missing') return { keepsWorktree: () => false, settleFences: keep }
  if (read.status === 'unreadable') {
    const named = namedIn(read.raw)
    for (const move of named.moving) void control.fenceForMove(move.threadId, THREAD_MOVE_WORDS.unreadableFence(move.machine))
    const kept = new Set(named.kept)
    return { keepsWorktree: threadId => kept.has(threadId), settleFences: keep }
  }
  const unfinished = new Set<string>()
  for (const record of read.value.moves) if (!terminal(record.state)) { unfinished.add(record.sourceThreadId); void control.fenceForMove(record.sourceThreadId, THREAD_MOVE_WORDS.paused(record.machine)) }
  const kept = new Set([...read.value.kept ?? [], ...unfinished])
  return { keepsWorktree: threadId => kept.has(threadId),
    settleFences: () => { for (const threadId of control.fencedForMove?.() ?? []) if (!unfinished.has(threadId)) void Promise.resolve(control.liftMoveFence(threadId)).catch(() => undefined) } }
}
const terminal = (state: MoveState): boolean => state === 'source-settled' || state === 'given-back' || state === 'stayed'
const now = (): string => new Date().toISOString()
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** A thread at rest: no turn running, nothing waiting on the user, and no background work or monitor, as Watcher reads quiet. */
const quiet = (thread: AgentThread): boolean => !isThreadTurnRunning(thread) && thread.requests.length === 0 && watcherBackgroundWorkCount(thread) === 0
/**
 * Whether the new thread's first turn has ended there, and how: the first prompt reached it, and it is quiet, with nothing
 * running, waiting on the user or left working in the background. A new thread has no turn before its first prompt, so
 * any turn it reports is that one or a later one. `firstTurnOver` adds the threads it delegated to there.
 */
export function firstTurnEnded(thread: AgentThread): MoveRecord['firstTurn'] {
  const userAt = thread.summary?.lastUser?.createdAt ?? thread.messages.findLast(message => message.role === 'user')?.createdAt
  if (thread.lastUserMessageId === undefined && userAt === undefined && thread.lastTurn === undefined) return undefined
  if (!quiet(thread)) return undefined
  if (thread.lastTurn) return thread.lastTurn.status === 'running' ? undefined : thread.lastTurn.status
  if (thread.status === 'error') return 'failed'
  const replyAt = thread.summary?.lastAssistant?.createdAt ?? thread.messages.findLast(message => message.role === 'assistant')?.createdAt
  return replyAt !== undefined && userAt !== undefined && Date.parse(replyAt) >= Date.parse(userAt) ? 'completed' : undefined
}

/**
 * The model a move's card names: the one it starts on there, by its name, and the source's own, by its name, when that
 * is another (Zach, October 29, 2026). A model no list names any more is named by its ID.
 */
function movedModel(source: AgentThread | undefined, sourceModel: AgentModel | undefined, there: AgentModel | undefined, modelId: string): ThreadMoveModel {
  const cut = (name: string): string => name.slice(0, 200)
  const same = source !== undefined && (source.modelId === modelId || there !== undefined && resolveModel([there], source.modelId) !== undefined)
  const name = there?.name ?? (same ? sourceModel?.name : undefined) ?? modelId
  return { name: cut(name), ...source && !same ? { instead: cut(sourceModel?.name ?? source.modelId) } : {} }
}
/** The model a move's new thread starts on there: the source's own where it is ready there, else its provider's first ready one. */
function targetModel(source: AgentThread, sourceModel: AgentModel | undefined, models: readonly AgentModel[]): AgentModel | undefined {
  const same = resolveModel(models, source.modelId)
  if (same?.ready && same.providerId === source.providerId) return same
  return models.find(model => model.ready && model.providerId === (sourceModel?.providerId ?? source.providerId))
}

/** A machine snapshot's threads by ID and by the thread that delegated to them, made once for each snapshot. */
interface SnapshotIndex { readonly threads: ReadonlyMap<string, AgentThread>; readonly children: ReadonlyMap<string, readonly string[]> }
/**
 * Whether the new thread's first turn is over there: it ended, and every thread it delegated to there, at any depth, is
 * quiet too, so the work it started is not still running when the source is settled or takes sends again (#1178).
 */
function firstTurnOver(index: SnapshotIndex, threadId: string): MoveRecord['firstTurn'] {
  const thread = index.threads.get(threadId)
  const ended = thread ? firstTurnEnded(thread) : undefined
  if (!ended) return undefined
  const seen = new Set([threadId])
  let level = index.children.get(threadId) ?? []
  for (let depth = 0; depth < DELEGATION_LEVELS_MAX && level.length; depth++) {
    const next: string[] = []
    for (const child of level) {
      if (seen.has(child)) continue
      seen.add(child)
      const delegated = index.threads.get(child)
      if (delegated && !quiet(delegated)) return undefined
      next.push(...index.children.get(child) ?? [])
    }
    level = next
  }
  return ended
}

interface Plan extends ThreadMovePlanned {
  /** The source by this computer's own thread ID. */
  readonly sourceThreadId?: string
  readonly start?: MoveRecord['start']
}
/**
 * A card this run holds and does not save: a thread that asks first and waits for the user's press, one the user kept
 * here from that press, or one the confirmation could not move. `threadId` is the window's ID for it, as the sheet named it.
 */
interface RunCard {
  readonly id: string
  readonly state: 'asks' | 'kept' | 'stays'
  readonly threadId: string
  readonly source: WatcherThreadTarget
  readonly hostId: string
  readonly machine: string
  readonly words?: string | undefined
  readonly model?: ThreadMoveModel | undefined
  readonly startsOn?: string | undefined
  readonly at: string
  readonly updatedAt: string
}
/** The most cards this run holds beside the moves' records; the oldest that wait on nothing go first. */
const RUN_CARDS_KEPT = 200
interface Confirmation { readonly hostId: string; readonly expires: number; readonly plans: ReadonlyMap<string, Plan>; readonly signature: string }

export class ThreadMoveService {
  private readonly store: AtomicJsonStore<MovesFile>
  /** Every move whose record was saved; a move is in none of the sets below before its first write has succeeded. */
  private records = new Map<string, MoveRecord>()
  /** The moves under way: finished ones are history, which nothing on the update path walks. */
  private readonly live = new Set<string>()
  /** The moves under way by their source, and by the machine they go to, so a change looks only at the moves it touches. */
  private readonly moving = new Map<string, string>()
  private readonly byHost = new Map<string, Set<string>>()
  /** The moves whose new thread runs its first turn, the only ones an update from a machine is read for. */
  private readonly waitingTurn = new Set<string>()
  /** The snapshot each of those was last read in, so an update that changed nothing there reads nothing. */
  private readonly lastRead = new Map<string, AgentHostSnapshot>()
  /** Each machine snapshot's threads by ID and by delegating thread, made once for each snapshot. */
  private readonly threadIndex = new WeakMap<AgentHostSnapshot, SnapshotIndex>()
  /** Sources whose worktrees no automatic cleanup removes (`kept` in the file), never trimmed with the history. */
  private readonly kept = new Set<string>()
  /** Moves whose watch could not be carried, after `WATCH_TRIES`: they wait, fenced and unsettled, and nothing steps them. */
  private readonly stuck = new Set<string>()
  private readonly watchTries = new Map<string, number>()
  /** The record could not be read at start: no move starts, nothing is written, and the sources it named stay fenced. */
  private unreadable = false
  /** Whether the record read whole at start, which alone lets a fence the coordinator kept be lifted for want of a move. */
  private recordRead = false
  /** New moves being written, by source: reserved before anything awaits, so a second confirmation finds the source moving. */
  private readonly reserved = new Map<string, MoveRecord>()
  private readonly confirmations = new Map<string, Confirmation>()
  private readonly advancing = new Set<string>()
  private readonly again = new Set<string>()
  /** A move's next try after a step could not reach the target, and its timer. */
  private readonly retryAt = new Map<string, { readonly at: number; readonly timer: ReturnType<typeof setTimeout> }>()
  /** This run's cards that are no move's record, oldest first (`RunCard`). */
  private readonly runCards = new Map<string, RunCard>()
  /** A move made from a card that asked first keeps that card's place in Watcher's conversation, for this run. */
  private readonly placedAt = new Map<string, string>()
  private readonly listeners = new Set<(view: ThreadMovesView) => void>()
  private targets: MoveTargets | undefined
  private unhook: (() => void)[] = []
  private closed = false
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly directory: string, private readonly options: {
    readonly control: MoveControl
    readonly workspace: MoveWorkspace
    readonly branches: Pick<DesktopBranchMoves, 'forStart' | 'forget'>
    readonly watch?: MoveWatch | undefined
    readonly delegations?: MoveDelegations | undefined
    /** Tells Watcher of each move as it ends. */
    readonly news?: ((move: MoveNews) => void) | undefined
    readonly newMoveId?: () => string
    readonly retryMs?: number
  }) {
    this.store = new AtomicJsonStore(join(directory, 'moves.json'), input => fileSchema.parse(input), empty)
  }

  /**
   * Reads the record and fences every source of a move under way, before any window or send can reach it. The moves go on
   * once the machines are known (`useTargets`).
   */
  async load(): Promise<void> {
    const read = await readStrictJson(join(this.directory, 'moves.json'), input => fileSchema.parse(input))
    if (read.status === 'unreadable') {
      // Fail safe: what the record still names stays fenced and kept, the file is left as it is, and no move starts.
      this.unreadable = true
      const named = namedIn(read.raw)
      for (const move of named.moving) void this.options.control.fenceForMove(move.threadId, THREAD_MOVE_WORDS.unreadableFence(move.machine))
      for (const threadId of named.kept) this.kept.add(threadId)
      return
    }
    this.recordRead = read.status === 'valid'
    const file = read.status === 'valid' ? read.value : empty()
    this.records = new Map(file.moves.map(record => [record.id, record]))
    for (const threadId of file.kept ?? []) this.kept.add(threadId)
    for (const record of this.records.values()) {
      if (!terminal(record.state)) this.kept.add(record.sourceThreadId)
      this.track(record)
      if (!terminal(record.state)) void this.options.control.fenceForMove(record.sourceThreadId, THREAD_MOVE_WORDS.fence(record.machine))
    }
  }
  /**
   * Once the coordinator has read its own record: lifts each fence it kept for a thread this record, read whole, shows no
   * move under way for, as one whose lift was not saved before Sotto stopped. With a record that did not read, or none,
   * every fence the coordinator kept stays: only the move's record can say a move is over.
   */
  settleFences(): void {
    if (!this.recordRead) return
    for (const threadId of this.options.control.fencedForMove?.() ?? []) if (!this.moving.has(threadId) && !this.reserved.has(threadId)) this.lift(threadId)
  }
  private lift(threadId: string): void { void Promise.resolve(this.options.control.liftMoveFence(threadId)).catch(() => undefined) }
  /** The machines moves go to. Every move under way is taken up again, and again whenever a machine changes. */
  useTargets(targets: MoveTargets): void {
    for (const unhook of this.unhook.splice(0)) unhook()
    this.targets = targets
    this.unhook.push(targets.subscribe(hostId => this.targetChanged(hostId)), ...targets.subscribeUpdates ? [targets.subscribeUpdates(() => this.updated())] : [])
    this.targetChanged()
  }
  /** Threads that were deleted keep no worktree here, so their sources are let go of (ADR-0140 decision 4). */
  forgetThreads(threadIds: ReadonlySet<string>): void {
    let changed = false
    for (const threadId of threadIds) if (this.kept.delete(threadId)) changed = true
    if (changed && !this.unreadable) void this.save().catch(() => undefined)
  }
  close(): void {
    this.closed = true
    for (const unhook of this.unhook.splice(0)) unhook()
    for (const { timer } of this.retryAt.values()) clearTimeout(timer)
    this.retryAt.clear(); this.confirmations.clear()
  }
  /** Whether this thread is the source of a move not given back, whose worktree is kept. */
  keepsWorktree(threadId: string): boolean { return this.kept.has(threadId) }
  /** Every move as its record holds it, oldest first. */
  list(): readonly MoveRecord[] { return [...this.records.values()] }
  /**
   * Every card for Watcher's conversation: each move this computer keeps a record of, and this run's cards beside them,
   * in the order they were confirmed. Made only when the window reads them or a card changes, never on the update path.
   */
  view(): ThreadMovesView {
    const here = this.options.control.hostId()
    if (!here) return { cards: [] }
    const waiting = new Set(this.stalled().map(record => record.id))
    const local = this.options.control.watcherSnapshot()
    const moves = [...this.records.values()].map((record): ThreadMoveCard => {
      const model = this.modelOf(record, local)
      return { id: record.id, state: record.state, source: { hostId: here, threadId: record.sourceThreadId },
        ...record.threadId ? { moved: { hostId: record.targetHostId, threadId: record.threadId } } : {}, hostId: record.targetHostId, machine: record.machine,
        ...record.givenBack ? { words: record.givenBack } : {}, model, ...waiting.has(record.id) ? { waiting: true as const } : {},
        ...record.watchMoved === true ? { watched: true as const } : {}, at: this.placedAt.get(record.id) ?? record.createdAt, updatedAt: record.updatedAt }
    })
    const run = [...this.runCards.values()].map((card): ThreadMoveCard => ({ id: card.id, state: card.state, source: card.source, hostId: card.hostId, machine: card.machine,
      ...card.words ? { words: card.words } : {}, ...card.model ? { model: card.model } : {}, ...card.state === 'asks' && card.startsOn ? { startsOn: card.startsOn } : {},
      at: card.at, updatedAt: card.updatedAt }))
    return { cards: [...moves, ...run].sort((a, b) => a.at.localeCompare(b.at)).slice(-THREAD_MOVE_CARDS_MAX) }
  }
  /** Hears every change to the cards. Returns the unhook. */
  subscribe(listener: (view: ThreadMovesView) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private changed(): void {
    if (this.closed || !this.listeners.size) return
    const view = this.view()
    for (const listener of this.listeners) listener(view)
  }
  /** The model a move's card names: its name there, and the source's when the machine lacked it (Zach, October 29, 2026). */
  private modelOf(record: MoveRecord, local: AgentHostSnapshot): ThreadMoveModel {
    const there = this.targets?.snapshot(record.targetHostId)?.models.find(model => model.id === record.start.modelId)
    const source = local.threads.find(thread => thread.id === record.sourceThreadId)
    return movedModel(source, source ? resolveModel(local.models, source.modelId) : undefined, there ?? local.models.find(model => model.id === record.start.modelId), record.start.modelId)
  }

  /**
   * The user's press on a card that asks first: move it anyway, on the permission the card names, or keep it here. A move
   * is planned again for that one thread as it stands now, so one that has since started narrower still or no longer can
   * move says so on its card; one that moves takes the card's place in Watcher's conversation.
   */
  async answer(input: unknown): Promise<ThreadMoveAnswer> {
    const parsed = threadMoveAnswerRequestSchema.safeParse(input)
    if (!parsed.success) return { status: 'refused', message: THREAD_MOVE_WORDS.unread }
    const card = this.runCards.get(parsed.data.cardId)
    if (!card || card.state !== 'asks') return { status: 'refused', message: THREAD_MOVE_WORDS.noCard }
    if (parsed.data.answer === 'keep') {
      this.runCards.set(card.id, { ...card, state: 'kept', updatedAt: now() })
      this.changed()
      return { status: 'ok' }
    }
    const preview = this.prepare({ threadIds: [card.threadId], hostId: card.hostId })
    if (preview.status === 'refused') return preview
    const started = await this.move({ confirmationId: preview.confirmationId, threadIds: [card.threadId], allowNarrower: [card.threadId] }, card)
    return started.status === 'refused' ? started : { status: 'ok' }
  }
  /** The moves under way that wait on a machine that is not connected, or on an answer it has not given (part 4's reconciling). */
  stalled(): readonly MoveRecord[] {
    return [...this.live].map(moveId => this.records.get(moveId)!).filter(record => this.stuck.has(record.id)
      || !this.advancing.has(record.id) && (this.retryAt.has(record.id) || !this.targets?.snapshot(record.targetHostId)))
  }

  /** What moving these threads to that machine would do now, under a confirmation that lasts a minute. */
  prepare(input: unknown): ThreadMovePrepare {
    const parsed = threadMovePrepareRequestSchema.safeParse(input)
    if (!parsed.success) return { status: 'refused', message: THREAD_MOVE_WORDS.unread }
    if (this.unreadable) return { status: 'refused', message: THREAD_MOVE_WORDS.unreadableRecord }
    const reach = this.reach(parsed.data.hostId)
    if ('refused' in reach) return { status: 'refused', message: reach.refused }
    const plans = this.planAll(parsed.data.threadIds, parsed.data.hostId, reach.name, reach.snapshot)
    this.pruneConfirmations()
    const confirmationId = randomUUID(), expires = Date.now() + THREAD_MOVE_CONFIRMATION_MS
    this.confirmations.set(confirmationId, { hostId: parsed.data.hostId, expires, plans, signature: this.signature(parsed.data.hostId, plans) })
    while (this.confirmations.size > 8) this.confirmations.delete(this.confirmations.keys().next().value!)
    return { status: 'ok', confirmationId, expiresAt: new Date(expires).toISOString(), machine: reach.name,
      threads: [...plans.values()].map(plan => ({ threadId: plan.threadId, outcome: plan.outcome, ...plan.words ? { words: plan.words } : {}, ...plan.model ? { model: plan.model } : {},
        ...plan.startsOn ? { startsOn: plan.startsOn } : {} })) }
  }

  /**
   * Starts the moves the user confirmed: each thread the preview moves now, and each that asks first and that the user
   * pressed for anyway. The preview is read once and must still say the same of every thread named, or nothing moves.
   * Each move is fenced and recorded before this answers, and goes on by itself. Each that asks first, and each that could
   * not move, gets a card of this run's in Watcher's conversation; `from` is the card that asked, when its press moves it.
   */
  async move(input: unknown, from?: RunCard): Promise<ThreadMoveStart> {
    const parsed = threadMoveStartRequestSchema.safeParse(input)
    if (!parsed.success) return { status: 'refused', message: THREAD_MOVE_WORDS.unread }
    if (this.unreadable) return { status: 'refused', message: THREAD_MOVE_WORDS.unreadableRecord }
    this.pruneConfirmations()
    const confirmation = this.confirmations.get(parsed.data.confirmationId)
    if (!confirmation) return { status: 'refused', message: THREAD_MOVE_WORDS.expired }
    this.confirmations.delete(parsed.data.confirmationId)
    if (parsed.data.threadIds.some(threadId => !confirmation.plans.has(threadId))) return { status: 'refused', message: THREAD_MOVE_WORDS.notInPlan }
    const reach = this.reach(confirmation.hostId)
    if ('refused' in reach) return { status: 'refused', message: reach.refused }
    // The threads named, as they stand now, must be planned as they were.
    const named = new Map(parsed.data.threadIds.map(threadId => [threadId, confirmation.plans.get(threadId)!]))
    const current = this.planAll(parsed.data.threadIds, confirmation.hostId, reach.name, reach.snapshot)
    if (confirmation.expires < Date.now() || this.signature(confirmation.hostId, named) !== this.signature(confirmation.hostId, current)) return { status: 'refused', message: THREAD_MOVE_WORDS.expired }
    const allowed = new Set(parsed.data.allowNarrower)
    const moves: Extract<ThreadMoveStart, { status: 'ok' }>['moves'] = []
    const here = this.options.control.hostId()
    const starting: { readonly threadId: string; readonly record: MoveRecord; readonly fenced: void | Promise<void> }[] = []
    for (const plan of current.values()) {
      if (plan.outcome === 'stays' || !plan.sourceThreadId || !plan.start || !here) { moves.push({ threadId: plan.threadId, outcome: 'stays', ...plan.words ? { words: plan.words } : {} }); continue }
      if (plan.outcome === 'asks' && !allowed.has(plan.threadId)) { moves.push({ threadId: plan.threadId, outcome: 'asks', ...plan.words ? { words: plan.words } : {} }); continue }
      if (this.reserved.has(plan.sourceThreadId)) { moves.push({ threadId: plan.threadId, outcome: 'stays', words: THREAD_MOVE_WORDS.twice }); continue }
      // Fenced in the same moment its plan was read, so nothing reaches it between the check and the record.
      const at = now()
      const record: MoveRecord = { id: this.options.newMoveId?.() ?? randomUUID(), sourceThreadId: plan.sourceThreadId, targetHostId: confirmation.hostId, machine: reach.name,
        state: 'fenced', start: plan.start, watched: this.options.watch?.hasStandingWatch({ hostId: here, threadId: plan.sourceThreadId }) === true, createdAt: at, updatedAt: at }
      // Reserved before anything awaits: a second confirmation of the same thread now reads it as moving.
      this.reserved.set(record.sourceThreadId, record)
      starting.push({ threadId: plan.threadId, record, fenced: this.options.control.fenceForMove(record.sourceThreadId, THREAD_MOVE_WORDS.fence(reach.name)) })
    }
    // Every fence is in the coordinator's own record, then every move in this one, before anything is sent, and none of
    // them is a move anything steps until both writes have succeeded. One that cannot be written lifts every fence it set,
    // and nothing is sent.
    let saved = true
    if (starting.length) {
      try { await Promise.all(starting.map(item => item.fenced)); await this.save(starting.map(item => item.record)) } catch { saved = false }
    }
    for (const { threadId, record } of starting) {
      this.reserved.delete(record.sourceThreadId)
      if (!saved) this.lift(record.sourceThreadId)
      moves.push(saved ? { threadId, outcome: 'moving', moveId: record.id } : { threadId, outcome: 'stays', words: THREAD_MOVE_WORDS.unsaved })
    }
    if (saved) for (const { record } of starting) void this.advance(record.id)
    // In the order the user named them.
    const order = new Map(parsed.data.threadIds.map((threadId, index) => [threadId, index]))
    const sorted = moves.sort((a, b) => order.get(a.threadId)! - order.get(b.threadId)!)
    this.cardsFor(sorted, current, confirmation.hostId, reach.name, from)
    return { status: 'ok', moves: sorted }
  }

  /**
   * This run's cards for what a confirmation did: one for each thread that asks first, and one for each it could not move.
   * A card the user pressed for gives its place to the move it made, or says why that thread could not move after all.
   */
  private cardsFor(results: Extract<ThreadMoveStart, { status: 'ok' }>['moves'], plans: ReadonlyMap<string, Plan>, hostId: string, machine: string, from: RunCard | undefined): void {
    const here = this.options.control.hostId()
    if (!here) return
    const at = now()
    for (const result of results) {
      if (from && result.threadId === from.threadId) {
        if (result.outcome === 'moving' && result.moveId) { this.runCards.delete(from.id); this.placedAt.set(result.moveId, from.at) }
        else this.runCards.set(from.id, { ...from, state: result.outcome === 'asks' ? 'asks' : 'stays', ...result.words ? { words: result.words } : {},
          ...plans.get(result.threadId)?.startsOn ? { startsOn: plans.get(result.threadId)!.startsOn } : {}, updatedAt: at })
        continue
      }
      if (result.outcome === 'moving') continue
      const plan = plans.get(result.threadId), key = parseHostEntityKey(result.threadId)
      const source = plan?.sourceThreadId ? { hostId: here, threadId: plan.sourceThreadId } : key ? { hostId: key.hostId, threadId: key.id } : { hostId: here, threadId: result.threadId }
      const id = randomUUID()
      this.runCards.set(id, { id, state: result.outcome, threadId: result.threadId, source, hostId, machine, ...result.words ? { words: result.words } : {},
        ...plan?.model ? { model: plan.model } : {}, ...plan?.startsOn ? { startsOn: plan.startsOn } : {}, at, updatedAt: at })
    }
    for (const card of this.runCards.values()) {
      if (this.runCards.size <= RUN_CARDS_KEPT) break
      if (card.state !== 'asks') this.runCards.delete(card.id)
    }
    this.changed()
  }
  /** A connected machine that takes moves, or why not. */
  private reach(hostId: string): { readonly name: string; readonly snapshot: AgentHostSnapshot } | { readonly refused: string } {
    const name = this.targets?.name(hostId)
    if (name === undefined || hostId === this.options.control.hostId()) return { refused: THREAD_MOVE_WORDS.unknownMachine }
    const snapshot = this.targets?.snapshot(hostId), host = this.targets?.host(hostId)
    if (!snapshot || !host) return { refused: THREAD_MOVE_WORDS.notConnected(name) }
    if (!host.supportsThreadMove) return { refused: THREAD_MOVE_WORDS.olderHost(name) }
    return { name, snapshot }
  }
  /**
   * What each named thread would do, by the window's ID for it. A thread named twice, by its own ID and as
   * `host:<this computer>:<id>`, is planned once: the second names it again, and stays.
   */
  private planAll(threadIds: readonly string[], hostId: string, machine: string, target: AgentHostSnapshot): Map<string, Plan> {
    const plans = new Map<string, Plan>(), sources = new Set<string>()
    for (const threadId of threadIds) {
      if (plans.has(threadId)) continue
      const plan = this.plan(threadId, hostId, machine, target)
      const source = plan.sourceThreadId ?? this.localId(threadId)
      if (source !== undefined && sources.has(source)) { plans.set(threadId, { threadId, outcome: 'stays', words: THREAD_MOVE_WORDS.twice }); continue }
      if (source !== undefined) sources.add(source)
      plans.set(threadId, plan)
    }
    return plans
  }
  /** This computer's own thread ID for a window's ID, or undefined for another machine's thread. */
  private localId(threadId: string): string | undefined {
    const key = parseHostEntityKey(threadId)
    return key ? key.hostId === this.options.control.hostId() ? key.id : undefined : threadId
  }
  /** What one thread would do: move now, ask first, or stay and why. */
  private plan(threadId: string, hostId: string, machine: string, target: AgentHostSnapshot): Plan {
    const here = this.options.control.hostId(), key = parseHostEntityKey(threadId)
    if (key && key.hostId !== here) return { threadId, outcome: 'stays', words: THREAD_MOVE_WORDS.remote }
    const snapshot = this.options.control.watcherSnapshot()
    const source = snapshot.threads.find(thread => thread.id === (key?.id ?? threadId))
    if (!source?.providerId) return { threadId, outcome: 'stays', words: THREAD_MOVE_WORDS.gone }
    const moving = this.movingRecord(source.id)
    const refusal = threadMoveRefusal(source, { machine, movingTo: moving?.machine, fenced: !moving && this.options.control.moveFenceOf?.(source.id) !== undefined,
      backgroundWork: watcherBackgroundWorkCount(source),
      unresolved: this.options.control.moveHoldReason(source.id) !== null,
      delegatedWorking: this.options.delegations?.hasOpen(source.id) === true
        || delegatedThreadsBelow(snapshot.threads, source.id).some(child => { const thread = snapshot.threads.find(item => item.id === child); return thread !== undefined && isThreadTurnRunning(thread) }) })
    if (refusal) return { threadId, outcome: 'stays', words: refusal }
    const sourceModel = resolveModel(snapshot.models, source.modelId), model = targetModel(source, sourceModel, target.models)
    if (!model) return { threadId, outcome: 'stays', words: THREAD_MOVE_WORDS.noProvider(source.providerId, machine) }
    const permission = movePermission(source, sourceModel, model, this.options.control.configuration().newThreadRuntimeMode, this.targets?.mayAnswer(hostId) === true)
    // TODO(#1178): a thread babysitting a pull request also asks first when the machine has no GitHub sign-in (Zach, October 21),
    // once a host says whether it has one; no host does yet, so only the permission asks.
    const effort = source.reasoningEffort && model.reasoningEfforts?.includes(source.reasoningEffort) ? source.reasoningEffort : undefined
    const start: MoveRecord['start'] = { provider: source.providerId, modelId: model.id, title: source.title, ...effort ? { reasoningEffort: effort } : {},
      ...permission.runtimeMode ? { runtimeMode: permission.runtimeMode } : {}, ...source.titleSource === 'user' ? { titleSource: 'user' as const } : {} }
    return { threadId, sourceThreadId: source.id, start, model: movedModel(source, sourceModel, model, model.id),
      ...permission.narrowed ? { outcome: 'asks', words: movePermissionWords(permission.narrowed, machine), startsOn: narrowedName(permission.narrowed).slice(0, 200) } : { outcome: 'moves' } }
  }
  /** What a confirmation holds to: each thread's outcome, its words and what it would start on there. */
  private signature(hostId: string, plans: ReadonlyMap<string, Plan>): string {
    return digest([hostId, [...plans.values()].map(plan => [plan.threadId, plan.outcome, plan.words ?? null, plan.start ?? null])])
  }
  private pruneConfirmations(): void {
    for (const [confirmationId, confirmation] of this.confirmations) if (confirmation.expires < Date.now()) this.confirmations.delete(confirmationId)
  }
  private movingRecord(threadId: string): MoveRecord | undefined {
    const moveId = this.moving.get(threadId)
    return this.reserved.get(threadId) ?? (moveId === undefined ? undefined : this.records.get(moveId))
  }
  /** Threads the new thread delegated to on another machine, This computer or a third, still open, as delegation's record names them. */
  private delegatesElsewhere(record: MoveRecord): boolean {
    return record.threadId !== undefined && this.options.delegations?.hasOpen(hostEntityKey(record.targetHostId, record.threadId)) === true
  }
  /** Puts a saved move in the indexes its state calls for, or takes it out of all of them once it is finished. */
  private track(record: MoveRecord): void {
    const moveId = record.id
    if (terminal(record.state)) {
      this.live.delete(moveId); this.waitingTurn.delete(moveId); this.lastRead.delete(moveId); this.stuck.delete(moveId); this.watchTries.delete(moveId)
      if (this.moving.get(record.sourceThreadId) === moveId) this.moving.delete(record.sourceThreadId)
      const host = this.byHost.get(record.targetHostId)
      host?.delete(moveId)
      if (host?.size === 0) this.byHost.delete(record.targetHostId)
      return
    }
    this.live.add(moveId); this.moving.set(record.sourceThreadId, moveId)
    let host = this.byHost.get(record.targetHostId)
    if (!host) { host = new Set(); this.byHost.set(record.targetHostId, host) }
    host.add(moveId)
    if (record.state === 'thread-started' && record.sent !== false) this.waitingTurn.add(moveId)
    else { this.waitingTurn.delete(moveId); this.lastRead.delete(moveId) }
  }

  /** A machine connected, went or changed what it offers: the moves going there are taken up again, and no others. */
  private targetChanged(hostId?: string): void {
    if (this.closed || !this.live.size) return
    // Whether a move waits on its machine changes with the machine.
    this.changed()
    for (const moveId of hostId === undefined ? this.live : this.byHost.get(hostId) ?? []) {
      // A move already advancing takes the change once its step is over, so nothing that happens meanwhile is missed.
      if (!this.retryAt.has(moveId) && !this.stuck.has(moveId)) void this.advance(moveId)
    }
  }
  /**
   * Runs on every update the desktop takes, a streamed reply included. It reads only the moves whose new thread runs its
   * first turn, each in a snapshot it has not read yet, by an index made once for that snapshot, so the work follows the
   * threads that changed rather than every move times every thread; with none waiting it does nothing.
   */
  private updated(): void {
    if (this.closed || !this.waitingTurn.size || !this.targets) return
    for (const moveId of this.waitingTurn) {
      const record = this.records.get(moveId)
      // One already advancing takes this after its step (`again`), so a turn that ends meanwhile is not missed.
      if (!record?.threadId || this.retryAt.has(moveId)) continue
      const snapshot = this.targets.snapshot(record.targetHostId)
      if (!snapshot || this.lastRead.get(moveId) === snapshot) continue
      // Not over there: nothing new until that machine's snapshot changes. Over there but for threads it delegated to on
      // another machine: read again on the next update, since those change elsewhere.
      if (!firstTurnOver(this.indexOf(snapshot), record.threadId)) { this.lastRead.set(moveId, snapshot); continue }
      this.lastRead.delete(moveId)
      if (!this.delegatesElsewhere(record)) void this.advance(moveId)
    }
  }
  private indexOf(snapshot: AgentHostSnapshot): SnapshotIndex {
    let index = this.threadIndex.get(snapshot)
    if (!index) {
      const threads = new Map<string, AgentThread>(), children = new Map<string, string[]>()
      for (const thread of snapshot.threads) {
        threads.set(thread.id, thread)
        if (thread.delegatedBy) { const list = children.get(thread.delegatedBy); if (list) list.push(thread.id); else children.set(thread.delegatedBy, [thread.id]) }
      }
      index = { threads, children }
      this.threadIndex.set(snapshot, index)
    }
    return index
  }
  /** Takes a move through as many steps as it can now, one run at a time for each move. */
  private async advance(moveId: string): Promise<void> {
    if (this.closed) return
    if (this.advancing.has(moveId)) { this.again.add(moveId); return }
    this.advancing.add(moveId)
    try {
      for (;;) {
        const record = this.records.get(moveId)
        if (this.closed || !record || terminal(record.state)) return
        let moved: boolean
        try { moved = await this.step(record) } catch { this.later(moveId); return }
        if (!moved) return
      }
    } finally {
      this.advancing.delete(moveId)
      if (this.again.delete(moveId)) void this.advance(moveId)
    }
  }
  /** A step that could not reach the target is tried again a little later, not on every change the machine pushes. */
  private later(moveId: string): void {
    if (this.closed || this.retryAt.has(moveId)) return
    const delay = this.options.retryMs ?? RETRY_MS
    const timer = setTimeout(() => { this.retryAt.delete(moveId); void this.advance(moveId) }, delay)
    timer.unref?.()
    this.retryAt.set(moveId, { at: Date.now() + delay, timer })
    this.changed()
  }

  /** One step of a move. Answers true when it moved on, false when it waits for the machine. */
  private async step(record: MoveRecord): Promise<boolean> {
    const targets = this.targets, here = this.options.control.hostId()
    if (!targets || !here) return false
    const target = record.targetHostId, name = targets.name(target) ?? record.machine
    // Read only by the steps that need it, never while a move waits on its first turn.
    const sourceOf = (): AgentThread | undefined => this.options.control.watcherSnapshot().threads.find(thread => thread.id === record.sourceThreadId)
    switch (record.state) {
      case 'fenced': {
        if (!targets.snapshot(target)) return false
        const source = sourceOf()
        if (!source) return this.giveBack(record, THREAD_MOVE_WORDS.gone)
        let projectId = record.projectId
        if (projectId === undefined) {
          const placed = await targets.place({ hostId: here, projectId: source.projectId }, target)
          if ('refused' in placed) { if (placed.retryable) { this.later(record.id); return false } return this.giveBack(record, placed.refused) }
          projectId = placed.projectId
          record = await this.update(record, { projectId })
        }
        const receipt = await this.options.branches.forStart({ from: { hostId: here, threadId: source.id }, to: { hostId: target, projectId }, here, moveId: record.id, snapshot: false })
        if (receipt.type === 'refused') {
          // A connection that dropped, or a machine gone meanwhile, is tried again once it is back; anything else is the move's answer.
          if (receipt.reason === 'cut-off' || receipt.reason === 'unsupported' && !targets.snapshot(target)) { this.later(record.id); return false }
          return this.giveBack(record, receipt.message)
        }
        await this.update(record, { state: 'branch-sent', branch: { name: receipt.branch, commit: receipt.commit } })
        return true
      }
      case 'branch-sent':
      case 'thread-started': {
        if (record.state === 'thread-started' && record.sent !== false) return this.confirm(record, targets)
        const host = targets.host(target)
        if (!host) return false
        if (!host.supportsThreadMove) { if (record.startAsked) return false; return this.giveBack(record, THREAD_MOVE_WORDS.olderHost(name)) }
        const source = sourceOf()
        const prompt = source ? this.prompt(record, source, name) : undefined
        if (!prompt) {
          // Nothing reached the machine yet, so the move is given back; once it has, only the machine's answer decides.
          if (!record.startAsked) return this.giveBack(record, source ? THREAD_MOVE_WORDS.unreadable : THREAD_MOVE_WORDS.gone)
          return false
        }
        if (!record.startAsked) record = await this.update(record, { startAsked: true })
        let raw: unknown
        try {
          raw = await host.threadMove({ action: 'start', moveId: record.id, projectId: record.projectId!, title: record.start.title,
            ...record.start.titleSource ? { titleSource: record.start.titleSource } : {}, modelId: record.start.modelId,
            ...record.start.reasoningEffort ? { reasoningEffort: record.start.reasoningEffort } : {}, ...record.start.runtimeMode ? { runtimeMode: record.start.runtimeMode } : {},
            from: { threadId: record.sourceThreadId, provider: record.start.provider, hostId: here }, prompt: prompt.text, handover: prompt.proof })
        } catch { this.later(record.id); return false }
        const answer = threadMoveStartAnswerSchema.safeParse(raw)
        if (!answer.success) { this.later(record.id); return false }
        if (answer.data.type === 'refused') {
          // Another start under this move's ID, or a machine that cannot read its own record, proves nothing about this
          // move: it stays fenced and is asked again later.
          if (THREAD_MOVE_UNDECIDED.has(answer.data.reason)) { this.later(record.id); return false }
          return this.giveBack(record, answer.data.message)
        }
        await this.update(record, { state: 'thread-started', threadId: answer.data.threadId, sent: answer.data.sent })
        if (!answer.data.sent) { this.later(record.id); return false }
        return true
      }
      // A thread that fails to transfer stays where it is (#1178): only a first turn that completed settles the source.
      case 'first-turn-ended': return record.firstTurn === 'completed' ? this.settleSource(record, here, sourceOf()) : this.stay(record, sourceOf())
      default: return false
    }
  }
  /** The first prompt and its proof: the handover, Sotto's facts, and the length and digest of the whole, all Sotto's. */
  private prompt(record: MoveRecord, source: AgentThread, machine: string): { readonly text: string; readonly proof: { prefixLength: number; prefixDigest: string; counts: ReturnType<typeof handoverCounts> } } | undefined {
    let handover: Handover | undefined
    try { handover = this.options.workspace.threadHandover(source.id) } catch { handover = undefined }
    if (!handover || handover.summary.total === 0 || !record.branch) return undefined
    const linked = (source.pullRequests ?? []).filter(item => item.state === 'open')
    const own = source.worktree?.git?.pullRequest
    const pullRequests = [...linked, ...own && own.state === 'open' && !linked.some(item => item.number === own.number) ? [own] : []]
      .map(item => ({ number: item.number, title: item.title, draft: item.draft }))
    const facts: MoveFacts = { title: source.title, from: 'This computer', to: machine, branch: record.branch.name, commit: record.branch.commit, pullRequests,
      babysat: (source.babysitting ?? []).map(item => item.number), watched: record.watched }
    const text = movePrompt(handover.text, facts)
    if (text.length > AGENT_TEXT_MAX) return undefined
    return { text, proof: { ...handoverPrefixProof(text), counts: handoverCounts(handover.summary) } }
  }
  /** The move counts once the new thread is listed there and its first turn has ended. */
  private async confirm(record: MoveRecord, targets: MoveTargets): Promise<boolean> {
    const snapshot = targets.snapshot(record.targetHostId)
    const ended = snapshot && record.threadId ? firstTurnOver(this.indexOf(snapshot), record.threadId) : undefined
    if (!ended || this.delegatesElsewhere(record)) return false
    await this.update(record, { state: 'first-turn-ended', firstTurn: ended })
    return true
  }
  /**
   * The move is confirmed: Watcher's watch goes to the new thread first, since a settled thread's watch ends; the source
   * links to the new thread; then the source is settled, its worktree kept, and takes sends again.
   */
  private async settleSource(record: MoveRecord, here: string, source: AgentThread | undefined): Promise<boolean> {
    // The watch goes first, and the source settles only once it has: a watch on a settled thread ends, and would be lost.
    // One that will not go is tried again a few times, then the move waits, fenced and unsettled, for part 4 to show it.
    if (record.watched && record.watchMoved !== true && record.threadId && this.options.watch) {
      const moved = await this.options.watch.moveWatch({ hostId: here, threadId: record.sourceThreadId }, { hostId: record.targetHostId, threadId: record.threadId }).catch(() => false)
      if (!moved) {
        const tries = (this.watchTries.get(record.id) ?? 0) + 1
        this.watchTries.set(record.id, tries)
        if (record.watchMoved === undefined) await this.update(record, { watchMoved: false })
        if (tries >= WATCH_TRIES) this.stuck.add(record.id); else this.later(record.id)
        return false
      }
      record = await this.update(record, { watchMoved: true })
    }
    if (source) {
      // The link is Sotto's record and must survive (ADR-0089): a write that fails fails the step, which is tried again.
      if (record.threadId) await this.options.workspace.addContinuedIn(source.id, { threadId: record.threadId, provider: record.start.provider, at: record.updatedAt, host: record.targetHostId })
      const settled = await this.options.control.commandFromMove({ type: 'settle-thread', threadId: source.id }, () => { if (this.closed) throw new Error('Sotto is stopping.') })
      if (settled.error && !this.options.control.watcherSnapshot().threads.find(thread => thread.id === source.id)?.workspaceSettledAt) throw new Error('The source did not settle.')
    }
    await this.update(record, { state: 'source-settled' })
    this.lift(record.sourceThreadId)
    return true
  }
  /**
   * The new thread's first turn failed or was stopped, so it did not pick up the work: the source stays here, unsettled,
   * still watched where it was, and takes sends again. It links to the new thread, which is left there for the user.
   */
  private async stay(record: MoveRecord, source: AgentThread | undefined): Promise<boolean> {
    if (source && record.threadId) await this.options.workspace.addContinuedIn(source.id, { threadId: record.threadId, provider: record.start.provider, at: record.updatedAt, host: record.targetHostId })
    await this.update(record, { state: 'stayed', givenBack: THREAD_MOVE_WORDS.stayed(record.machine, record.firstTurn === 'failed').slice(0, 1_200) }, true)
    this.lift(record.sourceThreadId)
    return true
  }
  /**
   * Gives a move back while no thread exists for it: the record says why, the source takes sends again, and the branch it
   * landed there is let go of. A record that cannot be saved keeps the source fenced, and the step is tried again.
   */
  private async giveBack(record: MoveRecord, why: string): Promise<boolean> {
    await this.update(record, { state: 'given-back', givenBack: THREAD_MOVE_WORDS.givenBack(why).slice(0, 1_200) }, true)
    this.lift(record.sourceThreadId)
    const here = this.options.control.hostId()
    if (record.projectId && here) await this.options.branches.forget({ hostId: record.targetHostId, projectId: record.projectId, moveId: record.id, here }).catch(() => undefined)
    return true
  }

  /**
   * Writes a step of a move before it counts; a write that fails leaves the record as it was, and rejects. `release` lets
   * go of the source's worktree with it, for a move given back or one whose source stays.
   */
  private async update(record: MoveRecord, patch: Partial<MoveRecord>, release = false): Promise<MoveRecord> {
    const next: MoveRecord = { ...record, ...patch, updatedAt: now() }
    const keptBefore = this.kept.has(record.sourceThreadId)
    this.records.set(record.id, next)
    if (release) this.kept.delete(record.sourceThreadId)
    try { await this.save() } catch (error) {
      this.records.set(record.id, record)
      if (keptBefore) this.kept.add(record.sourceThreadId)
      throw error
    }
    this.track(next)
    if (terminal(next.state) && !terminal(record.state)) this.told(next)
    this.changed()
    return next
  }
  /** Watcher hears of a move as it ends, watched or not (#1178). */
  private told(record: MoveRecord): void {
    const here = this.options.control.hostId()
    if (!here) return
    try {
      this.options.news?.({ source: { hostId: here, threadId: record.sourceThreadId }, machine: record.machine,
        ...record.threadId ? { movedTo: { hostId: record.targetHostId, threadId: record.threadId } } : {},
        outcome: record.state === 'source-settled' ? 'moved' : record.state === 'stayed' ? 'stayed' : 'given-back' })
    } catch { /* Watcher's news is Watcher's: a move never fails for it. */ }
  }
  /**
   * Saves every move, one write after another, with the sources whose worktrees are kept; finished moves beyond the newest
   * kept go first, which never lets go of a worktree. `first` are new moves: they join the record, its indexes and the
   * kept sources in the same step as the write that holds them, so nothing steps one before it is saved and no later
   * write leaves one out.
   */
  private save(first: readonly MoveRecord[] = []): Promise<void> {
    const write = this.writes.catch(() => undefined).then(async () => {
      const finished = [...this.records.values()].filter(record => terminal(record.state))
      for (const old of finished.slice(0, Math.max(0, finished.length - FINISHED_KEPT))) this.records.delete(old.id)
      await this.store.write({ version: 1, moves: [...this.records.values(), ...first], kept: [...this.kept, ...first.map(record => record.sourceThreadId).filter(threadId => !this.kept.has(threadId))] })
      for (const record of first) { this.records.set(record.id, record); this.kept.add(record.sourceThreadId); this.track(record) }
      if (first.length) this.changed()
    })
    this.writes = write
    return write
  }
}

/**
 * The machines a move reaches, as Watcher reads them through the hosts this desktop joins (`DesktopHostRouter`): their
 * names, their threads and models while connected, whether this computer may answer there, their thread-move socket, and
 * Watcher's own placement, which finds a project's copy by its GitHub origin or sets one up.
 */
export function moveTargetsOf(hosts: WatcherRemoteHosts, watcher: Pick<WatcherService, 'placement'>, changes?: (listener: () => void) => () => void): MoveTargets {
  const listed = (hostId: string) => hosts.hosts().find(host => host.hostId === hostId)
  return {
    name: hostId => { const host = listed(hostId); return host ? host.name?.trim().slice(0, 200) || 'Paired machine' : undefined },
    snapshot: hostId => { if (!listed(hostId)?.connected) return undefined; try { return hosts.snapshot(hostId) } catch { return undefined } },
    mayAnswer: hostId => listed(hostId)?.permissionCeiling === 'full-access',
    host: hostId => hosts.threadMoves?.(hostId),
    place: async (project, hostId) => {
      const placed = await watcher.placement({ machine: hostId, newWorktree: true }, project)
      if ('status' in placed) return { refused: placed.message, retryable: placed.retryable === true }
      return placed.hostId === hostId ? { projectId: placed.projectId } : { refused: THREAD_MOVE_WORDS.notConnected(listed(hostId)?.name ?? 'That machine'), retryable: true }
    },
    // A machine connecting or going is Watcher's news; a thread's turn ending there is any change the router hears.
    subscribe: listener => hosts.subscribe(hostId => listener(hostId)),
    ...changes ? { subscribeUpdates: changes } : {},
  }
}
/** The window's ID for a thread a move made on another machine. */
export const movedThreadKey = (record: Pick<MoveRecord, 'targetHostId' | 'threadId'>): string | undefined =>
  record.threadId === undefined ? undefined : hostEntityKey(record.targetHostId, record.threadId)
