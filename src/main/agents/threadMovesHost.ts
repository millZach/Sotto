import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { AGENT_TEXT_MAX, type AgentCommand, type AgentHostSnapshot, type AgentModel, type AgentState, type ThreadContinuedFrom, type ThreadContinuedIn } from '../../shared/agents'
import { delegatedThreadsBelow } from '../../shared/delegation'
import { resolveModel } from '../../shared/modelCatalog'
import { hostNewThreadPermission } from '../../shared/newThreadDefaults'
import { isThreadTurnRunning } from '../../shared/threadActivity'
import {
  HOST_THREAD_MOVE_WORDS, hostThreadMoveRequestSchema, THREAD_MOVE_WORDS, threadMoveRefusal, type HostThreadMoveSource, type HostThreadMoveStart, type ThreadMoveLink,
  type ThreadMoveSourceAnswer, type ThreadMoveStartAnswer,
} from '../../shared/threadMoves'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { readStrictJson } from '../storage/strictJsonFile'
import type { CheckoutPendingWork } from './checkoutMutations'
import type { Handover } from './handover'
import type { ClientIdentity } from './hostService'
import { handoverCounts } from './watcherHandover'
import { watcherBackgroundWorkCount } from './watcherWakeUp'

/** What a move asks of this machine's coordinator: its threads as they are, and its own commands. */
export interface HostThreadMovesControl {
  watcherSnapshot(): AgentHostSnapshot
  commandFromMove(command: Extract<AgentCommand, { type: 'create-thread' | 'manual-send' }>, guard: () => void): Promise<AgentState>
}
/** The new thread's link back to the thread it continues, on its own record. */
export interface HostThreadMovesWorkspace {
  setContinuedFrom(threadId: string, from: ThreadContinuedFrom): Promise<void>
}
/**
 * What a move whose source is one of this machine's threads asks of it (#1178 part 3): the coordinator's fence and what
 * holds a thread here, its settle, and the workspace's handover and link to the thread that continues it.
 */
export interface HostThreadMoveSourceControl {
  watcherSnapshot(): AgentHostSnapshot
  moveHoldReason(threadId: string): CheckoutPendingWork | null
  /** Fences at once; the promise settles once the fence is in the coordinator's own record, and rejects when it could not be. */
  fenceForMove(threadId: string, words: string): void | Promise<void>
  liftMoveFence(threadId: string): void | Promise<void>
  moveFenceOf(threadId: string): string | undefined
  /** The threads the coordinator's own record keeps fenced for a move. */
  fencedForMove(): readonly string[]
  commandFromMove(command: Extract<AgentCommand, { type: 'settle-thread' }>, guard: () => void): Promise<AgentState>
}
export interface HostThreadMoveSourceWorkspace {
  threadHandover(threadId: string): Handover | undefined
  addContinuedIn(threadId: string, link: ThreadContinuedIn): Promise<void>
}

const id = z.string().min(1).max(512)
const recordSchema = z.object({
  moveId: z.uuid(),
  /** The desktop that asked: only it may ask about this move again. */
  clientId: id,
  /** The thread made for the move, minted and saved before it was made, so a retry makes this one and no other. */
  threadId: z.uuid(),
  /** The first prompt's draft, so a retry of its send is the same send. */
  draftId: z.uuid(),
  /** What names the move: its project, model and source, never its prompt. A retry that differs is another move. */
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  /** The first prompt went. */
  sent: z.literal(true).optional(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict()
type MoveRecord = z.infer<typeof recordSchema>
/**
 * The most moves this machine keeps. None is ever dropped, since a desktop may ask about a move again for as long as it
 * waits, however long this machine was away; a new move past this many is refused, definitely, rather than any forgotten.
 */
export const HOST_THREAD_MOVES_MAX = 10_000
const fileSchema = z.object({ version: z.literal(1), moves: z.array(recordSchema).max(HOST_THREAD_MOVES_MAX) }).strict()
type MovesFile = z.infer<typeof fileSchema>
const empty = (): MovesFile => ({ version: 1, moves: [] })
const refused = (reason: Extract<ThreadMoveStartAnswer, { type: 'refused' }>['reason'], message: string): ThreadMoveStartAnswer => ({ type: 'refused', reason, message })
/** A permission that lets a thread act without asking: any of Sotto's modes but Ask for approval, or a profile that allows more than nothing. */
function actsWithoutAsking(permission: { readonly runtimeMode?: string | undefined; readonly providerMode?: string | undefined }, model: AgentModel | undefined): boolean {
  if (permission.providerMode !== undefined) return model?.providerModes?.find(mode => mode.id === permission.providerMode)?.allows !== 'nothing'
  return permission.runtimeMode !== undefined && permission.runtimeMode !== 'approval-required'
}
const identity = (request: HostThreadMoveStart): string =>
  createHash('sha256').update(JSON.stringify([request.projectId, request.modelId, request.from.threadId, request.from.hostId])).digest('hex')

/**
 * This machine's side of a thread moved here from another one (#1178, ADR-0105 decision 7, Owl `cross-machine-work`):
 * the desktop moved the source's branch into the project's incoming ref first, and asks once more with the move's ID to
 * make the thread. The thread is made in a new worktree from that ref, linked back to the thread it continues, and sent
 * its first prompt, the handover and Sotto's facts, at once. The move's record, `thread-moves.json`, is written before the
 * thread is made, with the thread's ID minted then, so the same move asked again answers the same thread and never makes a
 * second; a refusal is given only while nothing was made, and is definite. No prompt is kept or logged.
 *
 * The start is held to what this machine lets that desktop give a thread here, as Watcher's starts are (ADR-0074): Ask for
 * approval where the desktop may not answer. That is read again as the thread is made and as its prompt goes (ADR-0004:
 * policy at dispatch), so a grant taken away while the start waits starts nothing that acts without asking.
 *
 * A record that cannot be read is never taken for an empty one: this machine then refuses every move, saying it cannot
 * tell, and writes nothing, so it never forgets a move it made a thread for and makes a second.
 */
export class HostThreadMoves {
  private readonly store: AtomicJsonStore<MovesFile>
  private records = new Map<string, MoveRecord>()
  /** Each move's start running now, so two asks for one move run one after the other. */
  private readonly running = new Map<string, Promise<unknown>>()
  /** The record as read, once it read; until then each request reads it again. */
  private loaded: Promise<boolean> | undefined
  private closed = false

  constructor(directory: string, private readonly options: {
    readonly control: HostThreadMovesControl
    readonly workspace: HostThreadMovesWorkspace
    /** Whether this client may answer here, and so give a thread a mode that acts without asking. Read at every start. */
    readonly mayAnswer: (client: ClientIdentity) => boolean
    /** This machine's own threads as a move's source (`thread-move-source`), where it offers that. */
    readonly sources?: HostThreadMoveSources | undefined
    /** The record's file name: the desktop keeps the moves made on This computer apart from a host's (`thread-moves-here.json`). */
    readonly file?: string | undefined
  }) {
    this.path = join(directory, options.file ?? 'thread-moves.json')
    this.store = new AtomicJsonStore(this.path, input => fileSchema.parse(input), empty)
  }
  private readonly path: string
  /** Whether the record reads: missing is empty; anything else that does not read leaves it unread, to be read again. */
  private load(): Promise<boolean> {
    this.loaded ??= readStrictJson(this.path, input => fileSchema.parse(input)).then(read => {
      if (read.status === 'unreadable') { this.loaded = undefined; return false }
      this.records = new Map((read.status === 'valid' ? read.value : empty()).moves.map(record => [record.moveId, record]))
      return true
    })
    return this.loaded
  }
  close(): void { this.closed = true; this.options.sources?.close() }
  /** Whether this machine's own threads can be a move's source here (`thread-move-source`). */
  get holdsSources(): boolean { return this.options.sources !== undefined }

  /** One `thread-move` request from a recorded desktop. A step that cannot run at all rejects, and the desktop asks again. */
  async handle(raw: unknown, client: ClientIdentity): Promise<ThreadMoveStartAnswer | ThreadMoveSourceAnswer> {
    const request = hostThreadMoveRequestSchema.parse(raw)
    if (request.action !== 'start') {
      if (!this.options.sources) throw new Error('This machine does not hold its threads for moves.')
      return this.options.sources.handle(request, client)
    }
    // Not a definite refusal: this machine cannot say whether it made a thread for the move, so the desktop keeps it fenced.
    if (!await this.load()) return refused('unreadable', HOST_THREAD_MOVE_WORDS.unreadable)
    const before = this.running.get(request.moveId) ?? Promise.resolve()
    const run = before.catch(() => undefined).then(() => this.start(request, client))
    this.running.set(request.moveId, run)
    try { return await run } finally { if (this.running.get(request.moveId) === run) this.running.delete(request.moveId) }
  }

  private async start(request: HostThreadMoveStart, client: ClientIdentity): Promise<ThreadMoveStartAnswer> {
    const stopping = (): void => { if (this.closed) throw new Error('Sotto is stopping.') }
    stopping()
    const digest = identity(request)
    let record = this.records.get(request.moveId)
    if (record && (record.clientId !== client.clientId || record.digest !== digest)) return refused('move-differs', HOST_THREAD_MOVE_WORDS.moveDiffers)
    const snapshot = this.options.control.watcherSnapshot()
    const model = resolveModel(snapshot.models, request.modelId)
    const made = (threadId: string): boolean => this.options.control.watcherSnapshot().threads.some(thread => thread.id === threadId)
    if (!record) {
      if (!snapshot.projects.some(project => project.id === request.projectId)) return refused('unknown-project', HOST_THREAD_MOVE_WORDS.unknownProject)
      if (!model?.ready) return refused('model-unavailable', HOST_THREAD_MOVE_WORDS.modelUnavailable)
      if (this.records.size >= HOST_THREAD_MOVES_MAX) return refused('full', HOST_THREAD_MOVE_WORDS.full)
      const at = new Date().toISOString()
      record = { moveId: request.moveId, clientId: client.clientId, threadId: randomUUID(), draftId: randomUUID(), digest, createdAt: at, updatedAt: at }
      await this.put(record)
    }
    // Held to what this machine lets that desktop give, read now (ADR-0074).
    const permission = hostNewThreadPermission(model, request.runtimeMode, this.options.mayAnswer(client))
    const held = { ...permission.runtimeMode ? { runtimeMode: permission.runtimeMode } : {}, ...permission.providerMode ? { providerMode: permission.providerMode } : {} }
    /**
     * Asked as each command dispatches, not only now (ADR-0004): a permission that acts without asking needs that desktop's
     * answers grant at that moment, so one taken away while the start waited refuses it rather than start it wide.
     */
    let grantGone = false
    const guard = (permission: { readonly runtimeMode?: string | undefined; readonly providerMode?: string | undefined }) => (): void => {
      stopping()
      if (!actsWithoutAsking(permission, model) || this.options.mayAnswer(client)) return
      grantGone = true
      throw new Error(HOST_THREAD_MOVE_WORDS.grantGone)
    }
    if (!made(record.threadId)) {
      if (!model?.ready) return await this.unmade(record, refused('model-unavailable', HOST_THREAD_MOVE_WORDS.modelUnavailable))
      let created: AgentState | undefined
      try {
        created = await this.options.control.commandFromMove({ type: 'create-thread', threadId: record.threadId, projectId: request.projectId, title: request.title,
          ...request.titleSource ? { titleSource: request.titleSource } : {}, modelId: request.modelId, workingCopy: 'independent', startFromMove: request.moveId,
          ...request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}, ...held }, guard(held))
      } catch (error) { if (made(record.threadId)) throw error }
      // Nothing was made, so nothing owns the move here and the answer is definite.
      if (!made(record.threadId)) {
        return await this.unmade(record, refused('failed', grantGone ? HOST_THREAD_MOVE_WORDS.grantGone : created?.error?.slice(0, 600) || HOST_THREAD_MOVE_WORDS.failed))
      }
    }
    // Linked before its first prompt goes, so that prompt is told apart as Sotto's from its first echo (ADR-0089 decision 3).
    // The link is Sotto's record and must survive: one that cannot be saved sends nothing, and the step fails for the
    // desktop to ask again.
    await this.options.workspace.setContinuedFrom(record.threadId, { threadId: request.from.threadId, provider: request.from.provider, host: request.from.hostId,
      at: record.createdAt, handover: request.handover })
    if (!record.sent) {
      const { threadId, draftId } = record
      // The prompt goes under the permission the thread was made with, which the grant must still allow as it dispatches.
      const there = this.options.control.watcherSnapshot().threads.find(thread => thread.id === threadId)
      const own = { runtimeMode: there?.runtimeMode, providerMode: there?.providerMode }
      let sent: AgentState | undefined
      try { sent = await this.options.control.commandFromMove({ type: 'manual-send', threadId, draftId, text: request.prompt }, guard(own)) } catch { sent = undefined }
      const delivery = sent?.deliveries?.find(item => item.threadId === threadId && item.draftId === draftId)
      const went = delivery?.status === 'accepted' || delivery?.status === 'uncertain' || delivery?.status === 'submitting'
        || sent?.deliveredDrafts?.some(item => item.threadId === threadId && item.draftId === draftId) === true
      if (!went) return { type: 'started', moveId: request.moveId, threadId: record.threadId, ...held, sent: false, message: grantGone ? HOST_THREAD_MOVE_WORDS.grantGone : HOST_THREAD_MOVE_WORDS.notSent }
      record = { ...record, sent: true, updatedAt: new Date().toISOString() }
      await this.put(record).catch(() => undefined)
    }
    return { type: 'started', moveId: request.moveId, threadId: record.threadId, ...held, sent: true }
  }

  /** A start that made nothing lets go of its record, so the refusal it answers is the move's last word here. */
  private async unmade(record: MoveRecord, answer: ThreadMoveStartAnswer): Promise<ThreadMoveStartAnswer> {
    this.records.delete(record.moveId)
    await this.save()
    return answer
  }
  private async put(record: MoveRecord): Promise<void> {
    const previous = this.records.get(record.moveId)
    this.records.delete(record.moveId); this.records.set(record.moveId, record)
    try { await this.save() } catch (error) {
      if (previous) this.records.set(record.moveId, previous); else this.records.delete(record.moveId)
      throw error
    }
  }
  private save(): Promise<void> { return this.store.write({ version: 1, moves: [...this.records.values()] }) }
}

const heldSchema = z.object({
  moveId: z.uuid(),
  /** The desktop that asked: only it may step this move. */
  clientId: id,
  /** The thread held here, by this machine's own thread ID. */
  threadId: id,
  /** Where it goes, as that desktop names it, for the words of a second move asked meanwhile. */
  machine: z.string().min(1).max(200),
  /** Held and fenced; settled once the thread that continues it took the work; released when it stays here. */
  state: z.enum(['held', 'settled', 'released']),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict()
type HeldRecord = z.infer<typeof heldSchema>
/** The most held moves this machine keeps: every one still held, and the newest finished ones beside them. */
const HELD_FINISHED_KEPT = 1_000
const heldFileSchema = z.object({ version: z.literal(1), held: z.array(heldSchema).max(HOST_THREAD_MOVES_MAX + HELD_FINISHED_KEPT),
  /**
   * The threads held or moved away whose worktrees no automatic cleanup removes (Zach, October 21, 2026), kept apart from
   * the moves, which are trimmed, and let go of only when the thread stays here or is deleted.
   */
  kept: z.array(id).max(100_000).optional() }).strict()
type HeldFile = z.infer<typeof heldFileSchema>
const sourceRefused = (reason: Extract<ThreadMoveSourceAnswer, { type: 'refused' }>['reason'], message: string): ThreadMoveSourceAnswer => ({ type: 'refused', reason, message })
const continuedIn = (link: ThreadMoveLink): ThreadContinuedIn => ({ threadId: link.threadId, provider: link.provider, at: link.at, host: link.hostId })

/**
 * Settles a move's source on its own machine once the thread that continues it took the work: linked first, since the link
 * is Sotto's record and must survive (ADR-0089), then settled, its worktree kept. A link that cannot be saved, or a thread
 * that did not settle, fails the step, which is tried again. This computer's moves and a host's held threads both use it.
 */
export async function settleMovedSource(control: Pick<HostThreadMoveSourceControl, 'watcherSnapshot' | 'commandFromMove'>, workspace: Pick<HostThreadMoveSourceWorkspace, 'addContinuedIn'>,
  threadId: string, link: ThreadContinuedIn | undefined, stopping: () => void): Promise<void> {
  if (link) await workspace.addContinuedIn(threadId, link)
  const settled = await control.commandFromMove({ type: 'settle-thread', threadId }, stopping)
  if (settled.error && !control.watcherSnapshot().threads.find(thread => thread.id === threadId)?.workspaceSettledAt) throw new Error('The thread did not settle.')
}

/**
 * This machine's own threads as a move's source (#1178 part 3, `thread-move-source`, Owl `cross-machine-work`): a desktop
 * moves one of them to This computer, or to another machine through the desktop. This machine says whether the thread can
 * move by its own record, as This computer does for its own (`threadMoveRefusal`), and fences it under the move's ID in the
 * coordinator's own record, so it takes no sends here while it moves and stays fenced across a restart. It gives the held
 * thread's handover for the first prompt the desktop builds, links it to the thread that continues it, and settles it, or
 * lets go of it when the move ends without taking the work.
 *
 * Its record, `thread-moves-held.json`, is written before each step counts and names each move's desktop and thread, so
 * only that desktop steps it and the same step asked again answers the same. A held move is never dropped; past 10,000
 * held at once a new one is refused. A record that does not read is never taken for an empty one: every step is refused
 * as `unreadable`, and nothing is fenced or let go of until it reads.
 */
export class HostThreadMoveSources {
  private readonly store: AtomicJsonStore<HeldFile>
  private records = new Map<string, HeldRecord>()
  /** Threads whose worktrees cleanup keeps (`kept` in the file). */
  private kept = new Set<string>()
  /** The record read whole: until then every worktree is kept, since any might be a moved thread's. */
  private read = false
  private loaded: Promise<boolean> | undefined
  /** One step at a time, so two asks for one move, or two moves of one thread, never interleave. */
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  private readonly path: string

  constructor(directory: string, private readonly options: {
    readonly control: HostThreadMoveSourceControl
    readonly workspace: HostThreadMoveSourceWorkspace
    /** Delegation's record here, for a thread whose delegations are still open. */
    readonly delegations?: { hasOpen(threadId: string): boolean } | undefined
  }) {
    this.path = join(directory, 'thread-moves-held.json')
    this.store = new AtomicJsonStore<HeldFile>(this.path, input => heldFileSchema.parse(input), () => ({ version: 1, held: [] }))
  }
  private load(): Promise<boolean> {
    this.loaded ??= readStrictJson(this.path, input => heldFileSchema.parse(input)).then(read => {
      if (read.status === 'unreadable') { this.loaded = undefined; return false }
      const file: HeldFile = read.status === 'valid' ? read.value : { version: 1, held: [] }
      this.records = new Map(file.held.map(record => [record.moveId, record]))
      this.kept = new Set([...file.kept ?? [], ...file.held.filter(record => record.state === 'held').map(record => record.threadId)])
      this.read = true
      return true
    })
    return this.loaded
  }
  /**
   * Reads the record once the coordinator has read its own, and makes the fences agree with it: every thread it holds is
   * fenced, and a fence no held move names, left by a stop between the fence and the record, is lifted. A record that does
   * not read changes no fence.
   */
  async start(): Promise<void> {
    if (!await this.load()) return
    const held = new Map([...this.records.values()].filter(record => record.state === 'held').map(record => [record.threadId, record.machine] as const))
    for (const [threadId, machine] of held) if (this.options.control.moveFenceOf(threadId) === undefined) await Promise.resolve(this.options.control.fenceForMove(threadId, THREAD_MOVE_WORDS.fence(machine))).catch(() => undefined)
    for (const threadId of this.options.control.fencedForMove()) if (!held.has(threadId)) await Promise.resolve(this.options.control.liftMoveFence(threadId)).catch(() => undefined)
  }
  /** Whether cleanup keeps this thread's worktree: one held or moved away, and every one until the record has read. */
  keepsWorktree(threadId: string): boolean { return !this.read || this.kept.has(threadId) }
  /** Deleted threads keep no worktree, so their moves let go of it (ADR-0140 decision 4). */
  forgetThreads(threadIds: readonly string[]): void {
    let changed = false
    for (const threadId of threadIds) if (this.kept.delete(threadId)) changed = true
    if (changed) this.queue = this.queue.catch(() => undefined).then(() => this.write())
  }
  close(): void { this.closed = true }

  async handle(request: HostThreadMoveSource, client: ClientIdentity): Promise<ThreadMoveSourceAnswer> {
    if (!await this.load()) return sourceRefused('unreadable', HOST_THREAD_MOVE_WORDS.unreadable)
    const run = this.queue.catch(() => undefined).then(() => this.step(request, client))
    this.queue = run
    return run
  }

  private async step(request: HostThreadMoveSource, client: ClientIdentity): Promise<ThreadMoveSourceAnswer> {
    if (this.closed) throw new Error('Sotto is stopping.')
    const record = this.records.get(request.moveId)
    if (record && record.clientId !== client.clientId) return sourceRefused('move-differs', HOST_THREAD_MOVE_WORDS.sourceDiffers)
    if (request.action === 'hold') {
      if (record) {
        if (record.threadId !== request.threadId) return sourceRefused('move-differs', HOST_THREAD_MOVE_WORDS.sourceDiffers)
        return record.state === 'held' ? { type: 'held', moveId: record.moveId } : sourceRefused('unknown-move', HOST_THREAD_MOVE_WORDS.unknownMove)
      }
      return this.hold(request.moveId, request.threadId, request.machine, client)
    }
    if (!record) return sourceRefused('unknown-move', HOST_THREAD_MOVE_WORDS.unknownMove)
    switch (request.action) {
      case 'handover': {
        if (record.state !== 'held') return sourceRefused('unknown-move', HOST_THREAD_MOVE_WORDS.unknownMove)
        let handover: Handover | undefined
        try { handover = this.options.workspace.threadHandover(record.threadId) } catch { handover = undefined }
        if (!handover || handover.summary.total === 0 || handover.text.length === 0 || handover.text.length > AGENT_TEXT_MAX)
          return sourceRefused('not-movable', HOST_THREAD_MOVE_WORDS.noHandover)
        return { type: 'handover', moveId: record.moveId, text: handover.text, counts: handoverCounts(handover.summary) }
      }
      case 'settle': {
        if (record.state === 'settled') { await this.unfence(record.threadId); return { type: 'done', moveId: record.moveId } }
        if (record.state !== 'held') return sourceRefused('unknown-move', HOST_THREAD_MOVE_WORDS.unknownMove)
        await settleMovedSource(this.options.control, this.options.workspace, record.threadId, continuedIn(request.link), () => { if (this.closed) throw new Error('Sotto is stopping.') })
        await this.finish(record, 'settled')
        return { type: 'done', moveId: record.moveId }
      }
      case 'release': {
        if (record.state !== 'held') { await this.unfence(record.threadId); return { type: 'done', moveId: record.moveId } }
        if (request.link) await this.options.workspace.addContinuedIn(record.threadId, continuedIn(request.link))
        await this.finish(record, 'released')
        return { type: 'done', moveId: record.moveId }
      }
    }
  }

  /**
   * Says whether the thread can move by this machine's record, and fences it in the same turn, so nothing reaches it between.
   * The move's record is written before the fence is known saved, so a stop between them leaves a record `start` fences
   * again, or a fence no record names, which `start` lifts; one that cannot be saved lets go of both.
   */
  private async hold(moveId: string, threadId: string, machine: string, client: ClientIdentity): Promise<ThreadMoveSourceAnswer> {
    const control = this.options.control
    const snapshot = control.watcherSnapshot()
    const byId = new Map(snapshot.threads.map(item => [item.id, item] as const))
    const thread = byId.get(threadId)
    if (!thread) return sourceRefused('not-movable', THREAD_MOVE_WORDS.gone)
    const other = [...this.records.values()].find(item => item.threadId === threadId && item.state === 'held')
    const refusal = threadMoveRefusal(thread, { machine, movingTo: other?.machine, fenced: !other && control.moveFenceOf(threadId) !== undefined,
      backgroundWork: watcherBackgroundWorkCount(thread),
      unresolved: control.moveHoldReason(threadId) !== null,
      delegatedWorking: this.options.delegations?.hasOpen(threadId) === true
        || delegatedThreadsBelow(snapshot.threads, threadId).some(child => { const item = byId.get(child); return item !== undefined && isThreadTurnRunning(item) }) })
    if (refusal) return sourceRefused('not-movable', refusal)
    if ([...this.records.values()].filter(item => item.state === 'held').length >= HOST_THREAD_MOVES_MAX) return sourceRefused('not-movable', HOST_THREAD_MOVE_WORDS.full)
    const fenced = control.fenceForMove(threadId, THREAD_MOVE_WORDS.fence(machine))
    const at = new Date().toISOString()
    const keptBefore = this.kept.has(threadId)
    try {
      await this.put({ moveId, clientId: client.clientId, threadId, machine, state: 'held', createdAt: at, updatedAt: at }, true)
      await fenced
    } catch (error) {
      if (this.records.get(moveId)?.state === 'held') {
        this.records.delete(moveId)
        if (!keptBefore) this.kept.delete(threadId)
        await this.write().catch(() => undefined)
      }
      await Promise.resolve(control.liftMoveFence(threadId)).catch(() => undefined)
      throw error
    }
    return { type: 'held', moveId }
  }
  /** Ends a held move: the record says so first, then the fence goes. A fence that will not lift is lifted when asked again. */
  private async finish(record: HeldRecord, state: 'settled' | 'released'): Promise<void> {
    // A thread that stays here is no moved thread, so cleanup may treat its worktree as any other's again.
    await this.put({ ...record, state, updatedAt: new Date().toISOString() }, state === 'settled')
    await this.unfence(record.threadId)
  }
  /** Lifts the thread's fence unless another move holds it now. */
  private async unfence(threadId: string): Promise<void> {
    if ([...this.records.values()].some(item => item.threadId === threadId && item.state === 'held')) return
    await this.options.control.liftMoveFence(threadId)
  }
  /** Saves a step of a move, and whether its thread's worktree is kept; one that cannot be saved leaves both as they were. */
  private async put(record: HeldRecord, keep: boolean): Promise<void> {
    const previous = this.records.get(record.moveId), keptBefore = this.kept.has(record.threadId)
    this.records.delete(record.moveId); this.records.set(record.moveId, record)
    const held = [...this.records.values()].some(item => item.threadId === record.threadId && item.state === 'held')
    if (keep) this.kept.add(record.threadId); else if (!held) this.kept.delete(record.threadId)
    const finished = [...this.records.values()].filter(item => item.state !== 'held')
    const dropped = finished.slice(0, Math.max(0, finished.length - HELD_FINISHED_KEPT))
    for (const item of dropped) this.records.delete(item.moveId)
    try { await this.write() } catch (error) {
      for (const item of dropped) this.records.set(item.moveId, item)
      if (previous) this.records.set(record.moveId, previous); else this.records.delete(record.moveId)
      if (keptBefore) this.kept.add(record.threadId); else this.kept.delete(record.threadId)
      throw error
    }
  }
  private write(): Promise<void> { return this.store.write({ version: 1, held: [...this.records.values()], kept: [...this.kept] }) }
}
