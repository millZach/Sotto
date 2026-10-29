import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { AGENT_TEXT_MAX, providerIdSchema, type AgentCommand, type AgentHostSnapshot, type AgentModel, type AgentRuntimeMode, type AgentState, type AgentThread,
  type ThreadContinuedIn } from '../../shared/agents'
import { branchNameSchema, commitIdSchema } from '../../shared/branchMoves'
import { hostEntityKey, parseHostEntityKey } from '../../shared/clientIdentity'
import { delegatedThreadsBelow } from '../../shared/delegation'
import { resolveModel } from '../../shared/modelCatalog'
import { isThreadTurnRunning } from '../../shared/threadActivity'
import {
  movePermission, movePermissionWords, movePrompt, THREAD_MOVE_CONFIRMATION_MS, THREAD_MOVE_WORDS, threadMovePrepareRequestSchema, threadMoveRefusal,
  threadMoveStartAnswerSchema, threadMoveStartRequestSchema, type MoveFacts, type ThreadMoveHost, type ThreadMovePlanned, type ThreadMovePrepare, type ThreadMoveStart,
} from '../../shared/threadMoves'
import type { WatcherRemoteHosts } from '../../shared/watcherHost'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
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
 * the confirmed ones. No window shows it yet (part 2).
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
  fenceForMove(threadId: string, words: string): void
  liftMoveFence(threadId: string): void
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
  /** Hears any change on a connected machine, or a machine connecting. Returns the unhook. */
  subscribe(listener: (hostId?: string) => void): () => void
}
/** Delegation's own record, for a thread with delegations still open on any machine. */
export interface MoveDelegations { hasOpen(threadId: string): boolean }

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
const fileSchema = z.object({ version: z.literal(1), moves: z.array(recordSchema).max(10_000) }).strict()
type MovesFile = z.infer<typeof fileSchema>
const empty = (): MovesFile => ({ version: 1, moves: [] })
/** Finished moves kept, newest last; a move under way is never dropped. */
const FINISHED_KEPT = 500
/** How long a step that could not reach the target waits before it is tried again, whatever else the machine says. */
const RETRY_MS = 5_000
const terminal = (state: MoveState): boolean => state === 'source-settled' || state === 'given-back' || state === 'stayed'
const now = (): string => new Date().toISOString()
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/**
 * Whether the new thread's first turn has ended there, and how: the first prompt reached it, and nothing runs or waits on
 * the user. A new thread has no turn before its first prompt, so any turn it reports is that one or a later one.
 */
export function firstTurnEnded(thread: Pick<AgentThread, 'status' | 'lastTurn' | 'requests' | 'lastUserMessageId' | 'messages' | 'summary'>): MoveRecord['firstTurn'] {
  const userAt = thread.summary?.lastUser?.createdAt ?? thread.messages.findLast(message => message.role === 'user')?.createdAt
  if (thread.lastUserMessageId === undefined && userAt === undefined && thread.lastTurn === undefined) return undefined
  if (isThreadTurnRunning(thread) || thread.requests.length > 0) return undefined
  if (thread.lastTurn) return thread.lastTurn.status === 'running' ? undefined : thread.lastTurn.status
  if (thread.status === 'error') return 'failed'
  const replyAt = thread.summary?.lastAssistant?.createdAt ?? thread.messages.findLast(message => message.role === 'assistant')?.createdAt
  return replyAt !== undefined && userAt !== undefined && Date.parse(replyAt) >= Date.parse(userAt) ? 'completed' : undefined
}

/** The model a move's new thread starts on there: the source's own where it is ready there, else its provider's first ready one. */
function targetModel(source: AgentThread, sourceModel: AgentModel | undefined, models: readonly AgentModel[]): AgentModel | undefined {
  const same = resolveModel(models, source.modelId)
  if (same?.ready && same.providerId === source.providerId) return same
  return models.find(model => model.ready && model.providerId === (sourceModel?.providerId ?? source.providerId))
}

interface Plan extends ThreadMovePlanned {
  /** The source by this computer's own thread ID. */
  readonly sourceThreadId?: string
  readonly start?: MoveRecord['start']
}
interface Confirmation { readonly hostId: string; readonly expires: number; readonly plans: ReadonlyMap<string, Plan>; readonly signature: string }

export class ThreadMoveService {
  private readonly store: AtomicJsonStore<MovesFile>
  private records = new Map<string, MoveRecord>()
  /** The moves under way, the only ones a change on a machine looks at: finished ones are history and are never walked then. */
  private readonly live = new Set<string>()
  /** Sources of moves not given back, whose worktrees no automatic cleanup removes. */
  private readonly sources = new Map<string, string>()
  private readonly confirmations = new Map<string, Confirmation>()
  private readonly advancing = new Set<string>()
  private readonly again = new Set<string>()
  /** A move's next try after a step could not reach the target, and its timer. */
  private readonly retryAt = new Map<string, { readonly at: number; readonly timer: ReturnType<typeof setTimeout> }>()
  private targets: MoveTargets | undefined
  private unhook: (() => void) | undefined
  private closed = false
  private writes: Promise<unknown> = Promise.resolve()

  constructor(directory: string, private readonly options: {
    readonly control: MoveControl
    readonly workspace: MoveWorkspace
    readonly branches: Pick<DesktopBranchMoves, 'forStart' | 'forget'>
    readonly watch?: MoveWatch | undefined
    readonly delegations?: MoveDelegations | undefined
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
    const file = await this.store.read().catch(empty)
    this.records = new Map(file.moves.map(record => [record.id, record]))
    for (const record of this.records.values()) {
      if (record.state !== 'given-back') this.sources.set(record.sourceThreadId, record.id)
      if (terminal(record.state)) continue
      this.live.add(record.id)
      this.options.control.fenceForMove(record.sourceThreadId, THREAD_MOVE_WORDS.fence(record.machine))
    }
  }
  /** The machines moves go to. Every move under way is taken up again, and again whenever a machine changes. */
  useTargets(targets: MoveTargets): void {
    this.unhook?.()
    this.targets = targets
    this.unhook = targets.subscribe(hostId => this.targetChanged(hostId))
    this.targetChanged()
  }
  close(): void {
    this.closed = true
    this.unhook?.(); this.unhook = undefined
    for (const { timer } of this.retryAt.values()) clearTimeout(timer)
    this.retryAt.clear(); this.confirmations.clear()
  }
  /** Whether this thread is the source of a move not given back, whose worktree is kept. */
  keepsWorktree(threadId: string): boolean { return this.sources.has(threadId) }
  /** Every move as its record holds it, oldest first. */
  list(): readonly MoveRecord[] { return [...this.records.values()] }
  /** The moves under way that wait on a machine that is not connected, or on an answer it has not given (part 4's reconciling). */
  stalled(): readonly MoveRecord[] {
    return [...this.live].map(moveId => this.records.get(moveId)!).filter(record => !this.advancing.has(record.id) && (this.retryAt.has(record.id) || !this.targets?.snapshot(record.targetHostId)))
  }

  /** What moving these threads to that machine would do now, under a confirmation that lasts a minute. */
  prepare(input: unknown): ThreadMovePrepare {
    const parsed = threadMovePrepareRequestSchema.safeParse(input)
    if (!parsed.success) return { status: 'refused', message: THREAD_MOVE_WORDS.unread }
    const reach = this.reach(parsed.data.hostId)
    if ('refused' in reach) return { status: 'refused', message: reach.refused }
    const plans = new Map(parsed.data.threadIds.map(threadId => [threadId, this.plan(threadId, parsed.data.hostId, reach.name, reach.snapshot)]))
    this.pruneConfirmations()
    const confirmationId = randomUUID(), expires = Date.now() + THREAD_MOVE_CONFIRMATION_MS
    this.confirmations.set(confirmationId, { hostId: parsed.data.hostId, expires, plans, signature: this.signature(parsed.data.hostId, plans) })
    while (this.confirmations.size > 8) this.confirmations.delete(this.confirmations.keys().next().value!)
    return { status: 'ok', confirmationId, expiresAt: new Date(expires).toISOString(), machine: reach.name,
      threads: [...plans.values()].map(plan => ({ threadId: plan.threadId, outcome: plan.outcome, ...plan.words ? { words: plan.words } : {} })) }
  }

  /**
   * Starts the moves the user confirmed: each thread the preview moves now, and each that asks first and that the user
   * pressed for anyway. The preview is read once and must still say the same of every thread named, or nothing moves.
   * Each move is fenced and recorded before this answers, and goes on by itself.
   */
  async move(input: unknown): Promise<ThreadMoveStart> {
    const parsed = threadMoveStartRequestSchema.safeParse(input)
    if (!parsed.success) return { status: 'refused', message: THREAD_MOVE_WORDS.unread }
    this.pruneConfirmations()
    const confirmation = this.confirmations.get(parsed.data.confirmationId)
    if (!confirmation) return { status: 'refused', message: THREAD_MOVE_WORDS.expired }
    this.confirmations.delete(parsed.data.confirmationId)
    if (parsed.data.threadIds.some(threadId => !confirmation.plans.has(threadId))) return { status: 'refused', message: THREAD_MOVE_WORDS.notInPlan }
    const reach = this.reach(confirmation.hostId)
    if ('refused' in reach) return { status: 'refused', message: reach.refused }
    // The threads named, as they stand now, must be planned as they were.
    const named = new Map(parsed.data.threadIds.map(threadId => [threadId, confirmation.plans.get(threadId)!]))
    const current = new Map(parsed.data.threadIds.map(threadId => [threadId, this.plan(threadId, confirmation.hostId, reach.name, reach.snapshot)]))
    if (confirmation.expires < Date.now() || this.signature(confirmation.hostId, named) !== this.signature(confirmation.hostId, current)) return { status: 'refused', message: THREAD_MOVE_WORDS.expired }
    const allowed = new Set(parsed.data.allowNarrower)
    const moves: Extract<ThreadMoveStart, { status: 'ok' }>['moves'] = []
    const here = this.options.control.hostId()
    const starting: { readonly threadId: string; readonly record: MoveRecord }[] = []
    for (const plan of current.values()) {
      if (plan.outcome === 'stays' || !plan.sourceThreadId || !plan.start || !here) { moves.push({ threadId: plan.threadId, outcome: 'stays', ...plan.words ? { words: plan.words } : {} }); continue }
      if (plan.outcome === 'asks' && !allowed.has(plan.threadId)) { moves.push({ threadId: plan.threadId, outcome: 'asks', ...plan.words ? { words: plan.words } : {} }); continue }
      // Fenced in the same moment its plan was read, so nothing reaches it between the check and the record.
      const at = now()
      const record: MoveRecord = { id: this.options.newMoveId?.() ?? randomUUID(), sourceThreadId: plan.sourceThreadId, targetHostId: confirmation.hostId, machine: reach.name,
        state: 'fenced', start: plan.start, watched: this.options.watch?.hasStandingWatch({ hostId: here, threadId: plan.sourceThreadId }) === true, createdAt: at, updatedAt: at }
      this.options.control.fenceForMove(record.sourceThreadId, THREAD_MOVE_WORDS.fence(reach.name))
      this.records.set(record.id, record); this.sources.set(record.sourceThreadId, record.id); this.live.add(record.id)
      starting.push({ threadId: plan.threadId, record })
    }
    // Every record is written before anything is sent; one that cannot be lifts every fence it set, and nothing moves.
    let saved = true
    if (starting.length) try { await this.save() } catch { saved = false }
    for (const { threadId, record } of starting) {
      if (!saved) {
        this.records.delete(record.id); this.sources.delete(record.sourceThreadId); this.live.delete(record.id)
        this.options.control.liftMoveFence(record.sourceThreadId)
      }
      moves.push(saved ? { threadId, outcome: 'moving', moveId: record.id } : { threadId, outcome: 'stays', words: THREAD_MOVE_WORDS.unsaved })
    }
    if (saved) for (const { record } of starting) void this.advance(record.id)
    // In the order the user named them.
    const order = new Map(parsed.data.threadIds.map((threadId, index) => [threadId, index]))
    return { status: 'ok', moves: moves.sort((a, b) => order.get(a.threadId)! - order.get(b.threadId)!) }
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
  /** What one thread would do: move now, ask first, or stay and why. */
  private plan(threadId: string, hostId: string, machine: string, target: AgentHostSnapshot): Plan {
    const here = this.options.control.hostId(), key = parseHostEntityKey(threadId)
    if (key && key.hostId !== here) return { threadId, outcome: 'stays', words: THREAD_MOVE_WORDS.remote }
    const snapshot = this.options.control.watcherSnapshot()
    const source = snapshot.threads.find(thread => thread.id === (key?.id ?? threadId))
    if (!source?.providerId) return { threadId, outcome: 'stays', words: THREAD_MOVE_WORDS.gone }
    const moving = this.movingRecord(source.id)
    const refusal = threadMoveRefusal(source, { machine, movingTo: moving?.machine, backgroundWork: watcherBackgroundWorkCount(source),
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
    return { threadId, sourceThreadId: source.id, start, ...permission.narrowed ? { outcome: 'asks', words: movePermissionWords(permission.narrowed, machine) } : { outcome: 'moves' } }
  }
  /** What a confirmation holds to: each thread's outcome, its words and what it would start on there. */
  private signature(hostId: string, plans: ReadonlyMap<string, Plan>): string {
    return digest([hostId, [...plans.values()].map(plan => [plan.threadId, plan.outcome, plan.words ?? null, plan.start ?? null])])
  }
  private pruneConfirmations(): void {
    for (const [confirmationId, confirmation] of this.confirmations) if (confirmation.expires < Date.now()) this.confirmations.delete(confirmationId)
  }
  private movingRecord(threadId: string): MoveRecord | undefined {
    const moveId = this.sources.get(threadId), record = moveId === undefined ? undefined : this.records.get(moveId)
    return record && !terminal(record.state) ? record : undefined
  }

  /** Runs on every change a machine pushes: it looks only at the moves under way, and at nothing while none is. */
  private targetChanged(hostId?: string): void {
    if (this.closed || !this.live.size) return
    for (const moveId of this.live) {
      const record = this.records.get(moveId)
      // A move already advancing takes the change once its step is over, so a turn that ends meanwhile is not missed.
      if (!record || hostId !== undefined && record.targetHostId !== hostId || this.retryAt.has(moveId)) continue
      void this.advance(moveId)
    }
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
  }

  /** One step of a move. Answers true when it moved on, false when it waits for the machine. */
  private async step(record: MoveRecord): Promise<boolean> {
    const targets = this.targets, here = this.options.control.hostId()
    if (!targets || !here) return false
    const target = record.targetHostId, name = targets.name(target) ?? record.machine
    const source = this.options.control.watcherSnapshot().threads.find(thread => thread.id === record.sourceThreadId)
    switch (record.state) {
      case 'fenced': {
        if (!targets.snapshot(target)) return false
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
          // Another start under this move's ID proves nothing about this one: it stays fenced for the machine to answer.
          if (answer.data.reason === 'move-differs') return false
          return this.giveBack(record, answer.data.message)
        }
        await this.update(record, { state: 'thread-started', threadId: answer.data.threadId, sent: answer.data.sent })
        if (!answer.data.sent) { this.later(record.id); return false }
        return true
      }
      // A thread that fails to transfer stays where it is (#1178): only a first turn that completed settles the source.
      case 'first-turn-ended': return record.firstTurn === 'completed' ? this.settleSource(record, here, source) : this.stay(record, source)
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
    const thread = targets.snapshot(record.targetHostId)?.threads.find(item => item.id === record.threadId)
    const ended = thread ? firstTurnEnded(thread) : undefined
    if (!ended) return false
    await this.update(record, { state: 'first-turn-ended', firstTurn: ended })
    return true
  }
  /**
   * The move is confirmed: Watcher's watch goes to the new thread first, since a settled thread's watch ends; the source
   * links to the new thread; then the source is settled, its worktree kept, and takes sends again.
   */
  private async settleSource(record: MoveRecord, here: string, source: AgentThread | undefined): Promise<boolean> {
    if (record.watched && record.watchMoved === undefined && record.threadId) {
      const moved = await this.options.watch?.moveWatch({ hostId: here, threadId: record.sourceThreadId }, { hostId: record.targetHostId, threadId: record.threadId }).catch(() => false) ?? false
      record = await this.update(record, { watchMoved: moved })
    }
    if (source) {
      if (record.threadId) await this.options.workspace.addContinuedIn(source.id, { threadId: record.threadId, provider: record.start.provider, at: record.updatedAt, host: record.targetHostId }).catch(() => undefined)
      const settled = await this.options.control.commandFromMove({ type: 'settle-thread', threadId: source.id }, () => { if (this.closed) throw new Error('Sotto is stopping.') })
      if (settled.error && !this.options.control.watcherSnapshot().threads.find(thread => thread.id === source.id)?.workspaceSettledAt) throw new Error('The source did not settle.')
    }
    await this.update(record, { state: 'source-settled' })
    this.options.control.liftMoveFence(record.sourceThreadId)
    return true
  }
  /**
   * The new thread's first turn failed or was stopped, so it did not pick up the work: the source stays here, unsettled,
   * still watched where it was, and takes sends again. It links to the new thread, which is left there for the user.
   */
  private async stay(record: MoveRecord, source: AgentThread | undefined): Promise<boolean> {
    if (source && record.threadId) await this.options.workspace.addContinuedIn(source.id, { threadId: record.threadId, provider: record.start.provider, at: record.updatedAt, host: record.targetHostId }).catch(() => undefined)
    await this.update(record, { state: 'stayed', givenBack: THREAD_MOVE_WORDS.stayed(record.machine, record.firstTurn === 'failed').slice(0, 1_200) })
    if (this.sources.get(record.sourceThreadId) === record.id) this.sources.delete(record.sourceThreadId)
    this.options.control.liftMoveFence(record.sourceThreadId)
    return true
  }
  /**
   * Gives a move back while no thread exists for it: the record says why, the source takes sends again, and the branch it
   * landed there is let go of. A record that cannot be saved keeps the source fenced, and the step is tried again.
   */
  private async giveBack(record: MoveRecord, why: string): Promise<boolean> {
    await this.update(record, { state: 'given-back', givenBack: THREAD_MOVE_WORDS.givenBack(why).slice(0, 1_200) })
    if (this.sources.get(record.sourceThreadId) === record.id) this.sources.delete(record.sourceThreadId)
    this.options.control.liftMoveFence(record.sourceThreadId)
    const here = this.options.control.hostId()
    if (record.projectId && here) await this.options.branches.forget({ hostId: record.targetHostId, projectId: record.projectId, moveId: record.id, here }).catch(() => undefined)
    return true
  }

  /** Writes a step of a move before it counts; a write that fails leaves the record as it was, and rejects. */
  private async update(record: MoveRecord, patch: Partial<MoveRecord>): Promise<MoveRecord> {
    const next: MoveRecord = { ...record, ...patch, updatedAt: now() }
    this.records.set(record.id, next)
    try { await this.save() } catch (error) { this.records.set(record.id, record); throw error }
    if (terminal(next.state)) this.live.delete(next.id)
    return next
  }
  /** Saves every move, one write after another; finished ones beyond the newest kept go first. */
  private save(): Promise<void> {
    const finished = [...this.records.values()].filter(record => terminal(record.state))
    for (const old of finished.slice(0, Math.max(0, finished.length - FINISHED_KEPT))) {
      this.records.delete(old.id)
      if (this.sources.get(old.sourceThreadId) === old.id) this.sources.delete(old.sourceThreadId)
    }
    const write = this.writes.catch(() => undefined).then(() => this.store.write({ version: 1, moves: [...this.records.values()] }))
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
    subscribe: listener => {
      const off = [hosts.subscribe(hostId => listener(hostId)), ...changes ? [changes(() => listener())] : []]
      return () => { for (const unhook of off) unhook() }
    },
  }
}
/** The window's ID for a thread a move made on another machine. */
export const movedThreadKey = (record: Pick<MoveRecord, 'targetHostId' | 'threadId'>): string | undefined =>
  record.threadId === undefined ? undefined : hostEntityKey(record.targetHostId, record.threadId)
