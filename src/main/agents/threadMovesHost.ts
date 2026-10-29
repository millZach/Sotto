import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentCommand, AgentHostSnapshot, AgentState, ThreadContinuedFrom } from '../../shared/agents'
import { resolveModel } from '../../shared/modelCatalog'
import { hostNewThreadPermission } from '../../shared/newThreadDefaults'
import { HOST_THREAD_MOVE_WORDS, hostThreadMoveRequestSchema, type HostThreadMoveRequest, type ThreadMoveStartAnswer } from '../../shared/threadMoves'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { ClientIdentity } from './hostService'

/** What a move asks of this machine's coordinator: its threads as they are, and its own commands. */
export interface HostThreadMovesControl {
  watcherSnapshot(): AgentHostSnapshot
  commandFromMove(command: Extract<AgentCommand, { type: 'create-thread' | 'manual-send' }>, guard: () => void): Promise<AgentState>
}
/** The new thread's link back to the thread it continues, on its own record. */
export interface HostThreadMovesWorkspace {
  setContinuedFrom(threadId: string, from: ThreadContinuedFrom): Promise<void>
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
const fileSchema = z.object({ version: z.literal(1), moves: z.array(recordSchema).max(10_000) }).strict()
type MovesFile = z.infer<typeof fileSchema>
/** The moves kept, newest last: a move is answered again for as long as its desktop might retry it. */
const MOVES_KEPT = 2_000
const empty = (): MovesFile => ({ version: 1, moves: [] })
const refused = (reason: Extract<ThreadMoveStartAnswer, { type: 'refused' }>['reason'], message: string): ThreadMoveStartAnswer => ({ type: 'refused', reason, message })
const identity = (request: HostThreadMoveRequest): string =>
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
 * approval where the desktop may not answer.
 */
export class HostThreadMoves {
  private readonly store: AtomicJsonStore<MovesFile>
  private records = new Map<string, MoveRecord>()
  /** Each move's start running now, so two asks for one move run one after the other. */
  private readonly running = new Map<string, Promise<unknown>>()
  private loaded: Promise<void> | undefined
  private closed = false

  constructor(directory: string, private readonly options: {
    readonly control: HostThreadMovesControl
    readonly workspace: HostThreadMovesWorkspace
    /** Whether this client may answer here, and so give a thread a mode that acts without asking. Read at every start. */
    readonly mayAnswer: (client: ClientIdentity) => boolean
  }) {
    this.store = new AtomicJsonStore(join(directory, 'thread-moves.json'), input => fileSchema.parse(input), empty)
  }
  private load(): Promise<void> {
    this.loaded ??= this.store.read().catch(empty).then(file => { this.records = new Map(file.moves.map(record => [record.moveId, record])) })
    return this.loaded
  }
  close(): void { this.closed = true }

  /** One `thread-move` request from a recorded desktop. A step that cannot run at all rejects, and the desktop asks again. */
  async handle(raw: unknown, client: ClientIdentity): Promise<ThreadMoveStartAnswer> {
    const request = hostThreadMoveRequestSchema.parse(raw)
    await this.load()
    const before = this.running.get(request.moveId) ?? Promise.resolve()
    const run = before.catch(() => undefined).then(() => this.start(request, client))
    this.running.set(request.moveId, run)
    try { return await run } finally { if (this.running.get(request.moveId) === run) this.running.delete(request.moveId) }
  }

  private async start(request: HostThreadMoveRequest, client: ClientIdentity): Promise<ThreadMoveStartAnswer> {
    const guard = (): void => { if (this.closed) throw new Error('Sotto is stopping.') }
    guard()
    const digest = identity(request)
    let record = this.records.get(request.moveId)
    if (record && (record.clientId !== client.clientId || record.digest !== digest)) return refused('move-differs', HOST_THREAD_MOVE_WORDS.moveDiffers)
    const snapshot = this.options.control.watcherSnapshot()
    const model = resolveModel(snapshot.models, request.modelId)
    const made = (threadId: string): boolean => this.options.control.watcherSnapshot().threads.some(thread => thread.id === threadId)
    if (!record) {
      if (!snapshot.projects.some(project => project.id === request.projectId)) return refused('unknown-project', HOST_THREAD_MOVE_WORDS.unknownProject)
      if (!model?.ready) return refused('model-unavailable', HOST_THREAD_MOVE_WORDS.modelUnavailable)
      const at = new Date().toISOString()
      record = { moveId: request.moveId, clientId: client.clientId, threadId: randomUUID(), draftId: randomUUID(), digest, createdAt: at, updatedAt: at }
      await this.put(record)
    }
    // Held to what this machine lets that desktop give, read now (ADR-0074).
    const permission = hostNewThreadPermission(model, request.runtimeMode, this.options.mayAnswer(client))
    const held = { ...permission.runtimeMode ? { runtimeMode: permission.runtimeMode } : {}, ...permission.providerMode ? { providerMode: permission.providerMode } : {} }
    if (!made(record.threadId)) {
      if (!model?.ready) return await this.unmade(record, refused('model-unavailable', HOST_THREAD_MOVE_WORDS.modelUnavailable))
      const created = await this.options.control.commandFromMove({ type: 'create-thread', threadId: record.threadId, projectId: request.projectId, title: request.title,
        ...request.titleSource ? { titleSource: request.titleSource } : {}, modelId: request.modelId, workingCopy: 'independent', startFromMove: request.moveId,
        ...request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}, ...held }, guard)
      // Nothing was made, so nothing owns the move here and the answer is definite.
      if (!made(record.threadId)) return await this.unmade(record, refused('failed', created.error?.slice(0, 600) || HOST_THREAD_MOVE_WORDS.failed))
    }
    // Linked before its first prompt goes, so that prompt is told apart as Sotto's from its first echo (ADR-0089 decision 3).
    await this.options.workspace.setContinuedFrom(record.threadId, { threadId: request.from.threadId, provider: request.from.provider, host: request.from.hostId,
      at: record.createdAt, handover: request.handover }).catch(() => undefined)
    if (!record.sent) {
      const { threadId, draftId } = record
      const sent = await this.options.control.commandFromMove({ type: 'manual-send', threadId, draftId, text: request.prompt }, guard)
      const delivery = sent.deliveries?.find(item => item.threadId === threadId && item.draftId === draftId)
      const went = delivery?.status === 'accepted' || delivery?.status === 'uncertain' || delivery?.status === 'submitting'
        || sent.deliveredDrafts?.some(item => item.threadId === threadId && item.draftId === draftId) === true
      if (!went) return { type: 'started', moveId: request.moveId, threadId: record.threadId, ...held, sent: false, message: HOST_THREAD_MOVE_WORDS.notSent }
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
    while (this.records.size > MOVES_KEPT) this.records.delete(this.records.keys().next().value!)
    try { await this.save() } catch (error) {
      if (previous) this.records.set(record.moveId, previous); else this.records.delete(record.moveId)
      throw error
    }
  }
  private save(): Promise<void> { return this.store.write({ version: 1, moves: [...this.records.values()] }) }
}
