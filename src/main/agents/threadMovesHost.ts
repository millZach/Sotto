import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentCommand, AgentHostSnapshot, AgentModel, AgentState, ThreadContinuedFrom } from '../../shared/agents'
import { resolveModel } from '../../shared/modelCatalog'
import { hostNewThreadPermission } from '../../shared/newThreadDefaults'
import { HOST_THREAD_MOVE_WORDS, hostThreadMoveRequestSchema, type HostThreadMoveRequest, type ThreadMoveStartAnswer } from '../../shared/threadMoves'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { readStrictJson } from '../storage/strictJsonFile'
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
  }) {
    this.path = join(directory, 'thread-moves.json')
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
  close(): void { this.closed = true }

  /** One `thread-move` request from a recorded desktop. A step that cannot run at all rejects, and the desktop asks again. */
  async handle(raw: unknown, client: ClientIdentity): Promise<ThreadMoveStartAnswer> {
    const request = hostThreadMoveRequestSchema.parse(raw)
    // Not a definite refusal: this machine cannot say whether it made a thread for the move, so the desktop keeps it fenced.
    if (!await this.load()) return refused('unreadable', HOST_THREAD_MOVE_WORDS.unreadable)
    const before = this.running.get(request.moveId) ?? Promise.resolve()
    const run = before.catch(() => undefined).then(() => this.start(request, client))
    this.running.set(request.moveId, run)
    try { return await run } finally { if (this.running.get(request.moveId) === run) this.running.delete(request.moveId) }
  }

  private async start(request: HostThreadMoveRequest, client: ClientIdentity): Promise<ThreadMoveStartAnswer> {
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
    await this.options.workspace.setContinuedFrom(record.threadId, { threadId: request.from.threadId, provider: request.from.provider, host: request.from.hostId,
      at: record.createdAt, handover: request.handover }).catch(() => undefined)
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
