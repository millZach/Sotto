import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { isThreadProviderConnected, lastUserMessageIdOf, threadTakesSottoTools,
  type AgentCommand, type AgentHostSnapshot, type AgentModel, type AgentRuntimeMode, type AgentThread } from '../../shared/agents'
import { resolveModel } from '../../shared/modelCatalog'
import { resolveNewThreadPermission, RUNTIME_MODE_ORDER } from '../../shared/newThreadDefaults'
import { isThreadClosed, isThreadTurnRunning } from '../../shared/threadActivity'
import { WATCHER_REPLY_BYTES_MAX, watcherOutcomeSchema, type WatcherOutcome } from '../../shared/watcher'
import { cancelDelegationInputSchema, delegatedThreadsBelow, delegateInputSchema, delegationWorkSchema, readDelegationInputSchema, DELEGATION_LEVELS_MAX,
  DELEGATION_PROMPTS_PER_THREAD, DELEGATION_WAIT_MAX_SECONDS, DELEGATION_WORK_TITLES,
  type DelegateInput, type DelegationNews, type DelegationRead, type DelegationRefusal, type DelegationRefusalCode } from '../../shared/delegation'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { WATCHER_FINAL_OUTCOMES, watcherTurnOutcome } from './watcherOutcomes'
import type { AgentState } from '../../shared/agents'

/** The commands delegation sends on a thread's behalf: create the delegated thread, send it a brief, stop it. */
export type DelegationCommand = Extract<AgentCommand, { type: 'create-thread' | 'manual-send' | 'interrupt' }>
/** What the coordinator tells delegation, and asks of it (ADR-0081). Main-only; never crosses IPC or a socket. */
export interface DelegationControlHooks {
  /** The user's own command on a thread, never one of Sotto's: a send pauses delegated sends to it, a Stop cascades. */
  userCommand(command: AgentCommand, threadId: string | undefined, answersQuestion: boolean): void
  /** Every snapshot the coordinator accepts. Reads it once; never copies it. */
  observe(snapshot: AgentHostSnapshot): void
  /** The delegated threads whose turns delegation is following, kept in the observed set. */
  observedThreadIds(): readonly string[]
  /** The message ID a delegation gave its brief, so the brief's turn is known by it from the first echo. */
  messageIdFor(draftId: string): string | undefined
  /** The guard a delegated brief carries to the provider's writer, asked again after the thread's preparation. */
  guardFor(draftId: string): (() => void) | undefined
}
/** The coordinator as delegation uses it: its threads, its commands, the user's composer and its wake-ups. */
export interface DelegationCoordinator {
  hostId(): string | undefined
  watcherSnapshot(): AgentHostSnapshot
  configuration(): { readonly newThreadRuntimeMode?: AgentRuntimeMode | undefined; readonly newThreadModelId?: string | undefined; readonly newThreadReasoningEffort?: string | undefined }
  useDelegation(hooks: DelegationControlHooks): () => void
  commandFromDelegation(command: DelegationCommand, guard: () => void): Promise<AgentState>
  hasPendingThreadWork(threadId: string): boolean
  hasUserDraft(threadId: string): boolean
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
  /** The starts-only in-flight limit Watcher's starts take from too (ADR-0073), read at every start. */
  readonly limit: () => number
  /** Watcher's own starts in flight, which share the limit (decision 5). */
  readonly otherStartsInFlight?: () => number
  /** Whether a thread has Sotto's pull request tools, for babysitting news a wake-up may be folded with. */
  readonly tool?: (threadId: string) => boolean
}

const now = (): string => new Date().toISOString()
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const nativeHead = (thread: AgentThread): string | null => lastUserMessageIdOf(thread) ?? thread.summary?.lastUser?.id ?? null
const id = z.string().min(1).max(512)
/** Why a delegation ended before its brief was delivered: the outcome each of these reads as. */
const failureSchema = z.enum(['target-changed', 'paused', 'stopped', 'provider', 'restarted'])
type Failure = z.infer<typeof failureSchema>
const FAILURE_OUTCOMES: Record<Failure, WatcherOutcome> = { 'target-changed': 'paused', paused: 'paused', stopped: 'stopped', provider: 'failed', restarted: 'unknown' }
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
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict()
type DelegationRecord = z.infer<typeof recordSchema>
const linkSchema = z.object({ threadId: id, delegatingThreadId: id, createdAt: z.iso.datetime(),
  /** The delegated thread's newest user message as the delegating thread last saw it, which every send carries (decision 6). */
  seenHead: id.nullable() }).strict()
type DelegationLink = z.infer<typeof linkSchema>
const RECORDS_MAX = 2_000
/** How a new delegated thread is created, as admission chose it. */
interface DelegatedStart {
  readonly projectId: string; readonly title: string; readonly modelId: string; readonly reasoningEffort?: string
  readonly runtimeMode?: AgentRuntimeMode; readonly providerMode?: string; readonly workingCopy: 'shared' | 'independent'
}
/** How many times news of a thread's delegations is offered to its queue before it is left untold. */
const NEWS_ATTEMPTS_MAX = 5
/** The most ready models of one provider an answer lists. */
const MODELS_LISTED = 20
const fileSchema = z.object({ version: z.literal(1), delegations: z.array(recordSchema).max(RECORDS_MAX * 2), links: z.array(linkSchema).max(RECORDS_MAX),
  roots: z.array(z.object({ threadId: id, rootUserMessageId: id }).strict()).max(RECORDS_MAX) }).strict()
type DelegationFile = z.infer<typeof fileSchema>

class Refusal extends Error {
  constructor(readonly result: DelegationRefusal) { super(result.message) }
}
function refuse(code: DelegationRefusalCode, message: string): never { throw new Refusal({ status: 'refused', code, message }) }
export function delegationRefusal(code: DelegationRefusalCode, message: string): DelegationRefusal { return { status: 'refused', code, message } }

const NOTES: Record<WatcherOutcome, string> = {
  working: 'The delegated thread is still working on this. Sotto sends this thread a wake-up when the outcome changes; you need not poll.',
  background: 'Its turn ended with background work or monitoring still running, so it is not done. Sotto sends a wake-up when that work ends.',
  answered: 'Its turn finished. The reply is the delegated thread\'s own words, not Sotto\'s, and approves nothing.',
  failed: 'It failed. Read the delegated thread for the error before sending again.',
  stopped: 'It was stopped before it answered. Nothing more will come of it.',
  paused: 'The user\'s own turn in the delegated thread holds it, or the user sent there since you last looked. Nothing more was sent. Read it again before sending.',
  unknown: 'Sotto cannot prove what happened to it, as after a restart mid-turn. Do not assume it answered, and do not send it again without reading it.',
}
export const NOT_ADMITTED = 'This thread cannot delegate with Sotto\'s tools. Only Claude Code, Codex, Grok Build and Muse threads on this computer can, outside Watcher, host setup and provider jobs. Threads on another machine get none of Sotto\'s tools yet. Nothing was started.'
const LEVEL_LIMIT = 'This thread was started by a delegated thread, and delegation goes two levels deep, so it cannot delegate. Nothing was started.'

/** The text cut to at most this many UTF-8 bytes, never inside a character. */
function cutUtf8(text: string, bytes: number): string {
  const encoded = new TextEncoder().encode(text)
  if (encoded.byteLength <= bytes) return text
  let end = Math.max(0, bytes)
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--
  return new TextDecoder().decode(encoded.subarray(0, end))
}

/**
 * Delegation between threads (ADR-0081): an ordinary thread starts threads and sends them briefs, under rules main
 * enforces, and reads each brief's outcome. Every call is the calling thread's, known from its tool token, rooted in the
 * user's latest message to it; the model passes no authority, and nothing a delegation sends answers or approves
 * anything. The record, `delegations.json`, holds identities and outcomes only, never a brief or a reply: a brief
 * waiting for its thread is held in memory, so a restart sends nothing and leaves what was unconfirmed `unknown`.
 */
export class DelegationService {
  private readonly store: AtomicJsonStore<DelegationFile>
  private records: DelegationRecord[] = []
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
  private readonly answeredThisRun = new Set<string>()
  private readonly dispatchRefusals = new Map<string, Failure>()
  /** Briefs a Stop fenced while they were on their way: their guard refuses them at the writer. */
  private readonly fenced = new Set<string>()
  /** Delegations whose new outcome the delegating thread has not been told yet, by delegating thread, with attempts. */
  private readonly untold = new Map<string, { readonly ids: Set<string>; attempts: number }>()
  private readonly telling = new Set<string>()
  private newsScheduled = false
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  private unhook: (() => void) | undefined

  constructor(private readonly options: DelegationServiceOptions) {
    this.store = new AtomicJsonStore(join(options.directory, 'delegations.json'), input => fileSchema.parse(input),
      () => ({ version: 1, delegations: [], links: [], roots: [] }))
  }

  /**
   * Reads the record and starts following the coordinator. A brief that was unconfirmed or still working when Sotto
   * stopped is `unknown` from now on and is never sent again (decision 7); a brief that was waiting is dropped unsent.
   */
  async recover(): Promise<void> {
    const file = await this.store.read().catch(() => ({ version: 1 as const, delegations: [], links: [], roots: [] }))
    const time = now()
    this.records = file.delegations.map(record => {
      if (!this.open(record)) return record
      const unknown: DelegationRecord = { ...record, outcome: 'unknown', outcomeAt: time, told: 'unknown', updatedAt: time }
      if (record.deliveryState === 'queued') { unknown.deliveryState = 'failed'; unknown.failure = 'restarted' }
      if (record.deliveryState === 'dispatching') unknown.deliveryState = 'uncertain'
      delete unknown.turnMessageId; delete unknown.nativeTurnId; delete unknown.replyMessageId
      return unknown
    })
    for (const link of file.links) this.links.set(link.threadId, link)
    for (const root of file.roots) this.roots.set(root.threadId, root.rootUserMessageId)
    // A link whose thread record lost it, as when Sotto stopped between the two writes, is put back.
    const threads = new Map(this.options.control.watcherSnapshot().threads.map(thread => [thread.id, thread]))
    for (const link of this.links.values()) {
      const thread = threads.get(link.threadId)
      if (thread && thread.delegatedBy === undefined) await this.options.host.setDelegatedBy(link.threadId, link.delegatingThreadId).catch(() => undefined)
    }
    this.options.host.admitDelegationCommands?.()
    this.unhook = this.options.control.useDelegation({
      userCommand: (command, threadId, answersQuestion) => this.userCommand(command, threadId, answersQuestion),
      observe: snapshot => this.observe(snapshot),
      observedThreadIds: () => this.observedThreadIds(),
      messageIdFor: draftId => this.records.findLast(record => record.draftId === draftId && this.open(record))?.messageId,
      guardFor: draftId => {
        const record = this.records.findLast(item => item.draftId === draftId && this.open(item))
        return record ? () => this.guardSend(record.id) : undefined
      },
    })
    await this.persist()
  }
  close(): void {
    this.closed = true
    this.unhook?.(); this.unhook = undefined
    for (const waiting of this.waiters.values()) for (const wake of waiting) wake()
    this.waiters.clear()
  }

  /** Whether this thread is offered `sotto_delegate` (decisions 1 and 2), asked at every launch and every call. */
  admits(threadId: string): boolean {
    if (this.closed) return false
    try { this.caller(threadId, this.snapshot()); return true } catch { return false }
  }
  /** Delegation's starts in flight on this computer: the delegated threads it started that are still working on a brief. */
  startsInFlight(): number {
    const started = new Set(this.records.filter(record => record.action === 'start').map(record => record.delegatedThreadId))
    return new Set(this.records.filter(record => started.has(record.delegatedThreadId) && this.open(record)).map(record => record.delegatedThreadId)).size
  }

  async delegate(threadId: string, args: unknown, context: { readonly waitMs?: number } = {}): Promise<unknown> {
    const parsed = delegateInputSchema.safeParse(args)
    if (!parsed.success) return delegationRefusal('INVALID_INPUT', 'This call has invalid or oversized arguments. Use the offered tool schema. Nothing was started.')
    const input = parsed.data
    let admitted: { record: DelegationRecord; retry: boolean; start?: DelegatedStart }
    try { admitted = await this.transaction(() => this.admit(threadId, input)) }
    catch (error) { return error instanceof Refusal ? error.result : delegationRefusal('PROVIDER_UNAVAILABLE', 'Sotto could not start this delegation. Nothing was started.') }
    const record = admitted.record
    if (admitted.retry) return this.result(record)
    this.calling.add(record.id)
    try {
      await this.execute(record, input.brief, admitted.start)
      const waitMs = Math.max(0, Math.min((input.wait_seconds ?? DELEGATION_WAIT_MAX_SECONDS) * 1000,
        context.waitMs === undefined ? Infinity : context.waitMs - 2_000))
      if (this.open(this.record(record.id)!) && waitMs > 0) await this.wait(record.id, waitMs)
      return await this.result(this.record(record.id)!)
    } finally { this.calling.delete(record.id) }
  }

  async read(threadId: string, args: unknown): Promise<unknown> {
    const parsed = readDelegationInputSchema.safeParse(args)
    if (!parsed.success) return delegationRefusal('INVALID_INPUT', 'Name the delegation by its ID, or leave it out to list them.')
    try {
      const snapshot = this.snapshot(), caller = this.caller(threadId, snapshot)
      if (parsed.data.delegation === undefined) return this.listing(caller, snapshot)
      const record = this.owned(caller.id, parsed.data.delegation)
      return await this.result(record, true)
    } catch (error) { return error instanceof Refusal ? error.result : delegationRefusal('PROVIDER_UNAVAILABLE', 'Sotto could not read this delegation just now. Nothing was changed.') }
  }

  async cancel(threadId: string, args: unknown): Promise<unknown> {
    const parsed = cancelDelegationInputSchema.safeParse(args)
    if (!parsed.success) return delegationRefusal('INVALID_INPUT', 'Name the delegation to cancel by its ID. Nothing was stopped.')
    try {
      const caller = this.caller(threadId, this.snapshot())
      const record = this.owned(caller.id, parsed.data.delegation)
      if (!this.open(record)) return { ...(await this.result(record)), note: 'This delegation had already ended. Nothing was stopped.' }
      this.update(record.id, saved => { saved.told = 'stopped' })
      if (record.deliveryState === 'queued') this.fail(record.id, 'stopped')
      else {
        const thread = this.snapshot().threads.find(item => item.id === record.delegatedThreadId)
        if (thread && isThreadTurnRunning(thread) && this.answering(record, thread)) await this.stopThreads([record.delegatedThreadId], new Set([caller.id]))
      }
      await this.persist()
      return await this.result(this.record(record.id)!)
    } catch (error) { return error instanceof Refusal ? error.result : delegationRefusal('PROVIDER_UNAVAILABLE', 'Sotto could not cancel this delegation. Call read_delegation to see where it stands.') }
  }

  private snapshot(): AgentHostSnapshot { return this.options.control.watcherSnapshot() }
  private record(delegationId: string): DelegationRecord | undefined { return this.records.find(record => record.id === delegationId) }
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
    if (!thread || (thread.kind ?? 'project') !== 'project' || !threadTakesSottoTools(thread)
      || snapshot.projects.some(project => project.id === thread.projectId && this.reserved(project.path))) refuse('NOT_ADMITTED', NOT_ADMITTED)
    let level = 0
    for (let at: string | undefined = this.parentOf(thread.id, snapshot.threads); at !== undefined && level <= DELEGATION_LEVELS_MAX; at = this.parentOf(at, snapshot.threads)) level++
    if (level >= DELEGATION_LEVELS_MAX) refuse('LEVEL_LIMIT', LEVEL_LIMIT)
    return thread
  }
  /**
   * The user's latest message to the calling thread, which roots its turn's budget (decision 3). A wake-up's turn keeps
   * the root of the turn before it and renews nothing.
   */
  private rootOf(caller: AgentThread): string {
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
    return { inFlight: this.startsInFlight() + (this.options.otherStartsInFlight?.() ?? 0), inFlightLimit: this.options.limit(),
      ...(record ? { prompts: this.prompts(record.delegatingThreadId, record.rootUserMessageId, record.delegatedThreadId) } : {}), promptLimit: DELEGATION_PROMPTS_PER_THREAD }
  }
  /**
   * The permission a delegated thread may have: no wider than the narrower of the delegating thread's own and the user's
   * new-thread default, compared as Watcher compares (decision 4). A provider profile that allows more than nothing
   * cannot be compared, so it is refused rather than guessed.
   */
  private permission(model: AgentModel, caller: AgentThread, models: readonly AgentModel[], explicit?: AgentRuntimeMode): { runtimeMode?: AgentRuntimeMode; providerMode?: string } {
    const index = (mode: AgentRuntimeMode) => RUNTIME_MODE_ORDER.indexOf(mode)
    let own: AgentRuntimeMode = caller.runtimeMode ?? 'approval-required'
    if (caller.providerMode) {
      const mode = resolveModel(models, caller.modelId)?.providerModes?.find(item => item.id === caller.providerMode)
      if (mode?.allows !== 'nothing') refuse('PERMISSION_NOT_COMPARABLE', 'This thread\'s own permission profile cannot be compared with Sotto\'s modes, so Sotto cannot tell how much a thread it starts may have. Nothing was started.')
      own = 'approval-required'
    }
    const configured = this.options.control.configuration().newThreadRuntimeMode ?? 'approval-required'
    const ceiling = resolveNewThreadPermission(model, index(own) < index(configured) ? own : configured)
    if (ceiling.providerMode !== undefined) {
      const mode = model.providerModes?.find(item => item.id === ceiling.providerMode)
      if (mode?.allows !== 'nothing' || explicit) refuse('PERMISSION_NOT_COMPARABLE', 'This provider\'s permission profile cannot be compared safely. Choose a provider with an asking mode. Nothing was started.')
      return { providerMode: ceiling.providerMode }
    }
    if (!ceiling.runtimeMode) refuse('PERMISSION_NOT_COMPARABLE', 'This model has no permission mode Sotto can compare. Choose another model. Nothing was started.')
    const mode = explicit ?? ceiling.runtimeMode
    if (!model.runtimeModes?.includes(mode)) refuse('PERMISSION_NOT_COMPARABLE', 'This model does not offer that permission mode. Nothing was started.')
    if (index(mode) > index(ceiling.runtimeMode)) refuse('PERMISSION_TOO_WIDE', 'A delegated thread cannot have more permission than this thread has, or than the user\'s new-thread default. Nothing was started.')
    return { runtimeMode: mode }
  }
  private humanTurnRunning(thread: AgentThread): boolean {
    if (!isThreadTurnRunning(thread)) return false
    const head = nativeHead(thread)
    return !head || !this.records.some(record => record.delegatedThreadId === thread.id && record.messageId === head)
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
      const retry = this.records.find(record => record.delegatingThreadId === caller.id && record.retryKey === input.retry_key)
      if (retry) {
        if (retry.inputDigest !== inputDigest) refuse('RETRY_KEY_CONFLICT', 'This retry key belongs to another delegation. Nothing was started.')
        return { record: retry, retry: true }
      }
    }
    const root = this.rootOf(caller), time = now()
    const base = { id: randomUUID(), delegatingThreadId: caller.id, work: input.work, rootUserMessageId: root, ...(input.retry_key ? { retryKey: input.retry_key } : {}),
      inputDigest, draftId: randomUUID(), messageId: randomUUID(), deliveryState: 'queued' as const, charged: true, createdAt: time, updatedAt: time }
    if (input.thread !== undefined) {
      const link = this.links.get(input.thread)
      if (!link || link.delegatingThreadId !== caller.id) refuse('UNKNOWN_THREAD', 'This thread can send a brief only to a thread it delegated to. Leave thread out to start a new one. Nothing was sent.')
      const thread = snapshot.threads.find(item => item.id === input.thread)
      if (!thread || isThreadClosed(thread)) refuse('UNKNOWN_THREAD', 'That delegated thread is gone or archived. Nothing was sent.')
      if (!isThreadProviderConnected(snapshot, thread) || thread.clientConnected === false) refuse('PROVIDER_UNAVAILABLE', 'That delegated thread\'s provider is disconnected. Nothing was sent.')
      if (thread.requests.length) refuse('PENDING_USER_REQUEST', 'That delegated thread is waiting for the user\'s answer, which only the user gives on its own card. Nothing was sent.')
      if (this.pausedThread(thread)) refuse('PAUSED', 'The user is working in that delegated thread, so delegated sends to it are paused until their turn ends. Nothing was sent.')
      if (nativeHead(thread) !== link.seenHead) refuse('TARGET_CHANGED', 'The user has sent their own message in that delegated thread since this thread last looked. Call read_delegation on its newest delegation first. Nothing was sent.')
      const model = resolveModel(snapshot.models, thread.modelId)
      if (!model) refuse('PROVIDER_UNAVAILABLE', 'That delegated thread\'s model is unavailable. Nothing was sent.')
      const current = this.permission(model, caller, snapshot.models, thread.providerMode ? undefined : thread.runtimeMode ?? 'approval-required')
      if (thread.providerMode && current.providerMode !== thread.providerMode) refuse('PERMISSION_NOT_COMPARABLE', 'That delegated thread\'s permission cannot be compared safely. Nothing was sent.')
      if (this.prompts(caller.id, root, thread.id) >= DELEGATION_PROMPTS_PER_THREAD) refuse('PROMPT_LIMIT', `That thread has had ${DELEGATION_PROMPTS_PER_THREAD} briefs in this turn of this thread. Retries, reads and wake-ups do not renew the limit; the user's next message does. Nothing was sent.`)
      const record: DelegationRecord = recordSchema.parse({ ...base, delegatedThreadId: thread.id, action: 'send', expectedLastUserMessageId: link.seenHead })
      this.records.push(record)
      await this.saveAdmission(record)
      return { record, retry: false }
    }
    if (!input.provider || !input.model) refuse('INVALID_INPUT', `Name the provider and model for a new thread. ${this.readyModels(snapshot, input.provider)} Nothing was started.`)
    const model = resolveModel(snapshot.models, input.model)
    if (!model?.ready || model.providerId !== input.provider) refuse('PROVIDER_UNAVAILABLE', `That model is not ready on this computer. ${this.readyModels(snapshot, input.provider)} Nothing was started.`)
    const efforts = model.reasoningEfforts ?? []
    if (input.effort === undefined ? efforts.length > 0 : !efforts.includes(input.effort)) refuse('INVALID_INPUT', `Name the effort for this model, one of: ${efforts.join(', ') || 'none, so leave it out'}. Nothing was started.`)
    if (!model.providerModes?.length && input.permission === undefined) refuse('INVALID_INPUT', `Name the permission for a new thread, one of: ${(model.runtimeModes ?? []).join(', ') || 'none'}. It may be no wider than this thread's own or the user's new-thread default. Nothing was started.`)
    const project = snapshot.projects.find(item => item.id === caller.projectId)
    if (!project || this.reserved(project.path)) refuse('NOT_ADMITTED', NOT_ADMITTED)
    const permission = this.permission(model, caller, snapshot.models, input.permission)
    const inFlight = this.startsInFlight() + (this.options.otherStartsInFlight?.() ?? 0), limit = this.options.limit()
    if (inFlight >= limit) refuse('IN_FLIGHT_LIMIT', `${inFlight} new ${inFlight === 1 ? 'thread is' : 'threads are'} in flight on this computer, delegated or Watcher's, against a limit of ${limit}. Wait for one to finish. Nothing was started.`)
    const delegatedThreadId = randomUUID()
    const record: DelegationRecord = recordSchema.parse({ ...base, delegatedThreadId, action: 'start', expectedLastUserMessageId: null })
    this.records.push(record)
    this.links.set(delegatedThreadId, { threadId: delegatedThreadId, delegatingThreadId: caller.id, createdAt: time, seenHead: null })
    await this.saveAdmission(record)
    const start: DelegatedStart = { projectId: project.id, title: input.title ?? DELEGATION_WORK_TITLES[input.work], modelId: model.id,
      ...(input.effort ? { reasoningEffort: input.effort } : {}), ...permission, workingCopy: input.working_copy ?? 'shared' }
    return { record, retry: false, start }
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
      if (record.action === 'start') this.links.delete(record.delegatedThreadId)
      refuse('PROVIDER_UNAVAILABLE', 'Sotto could not save this delegation, so nothing was started or sent. Try again.')
    }
  }

  /** Creates the delegated thread when this is a start, links it, then sends the brief now or once the thread is free. */
  private async execute(record: DelegationRecord, brief: string, start?: DelegatedStart): Promise<void> {
    if (record.action === 'start' && start) {
      try {
        const created = await this.options.control.commandFromDelegation({ type: 'create-thread', threadId: record.delegatedThreadId, projectId: start.projectId,
          title: start.title, modelId: start.modelId, workingCopy: start.workingCopy,
          ...(start.reasoningEffort ? { reasoningEffort: start.reasoningEffort } : {}),
          ...(start.runtimeMode ? { runtimeMode: start.runtimeMode } : {}), ...(start.providerMode ? { providerMode: start.providerMode } : {}) },
        () => { this.guardLive(record.id); this.guardCeiling(record, start) })
        if (created.error || !created.host.threads.some(thread => thread.id === record.delegatedThreadId)) { this.fail(record.id, 'provider', true); await this.persist(); return }
        // Linked on the thread's own record before its first send, so its first launch already knows its level.
        await this.options.host.setDelegatedBy(record.delegatedThreadId, record.delegatingThreadId)
      } catch { this.fail(record.id, 'provider', true); await this.persist(); return }
    }
    this.queuedBriefs.set(record.id, brief)
    const snapshot = this.snapshot(), thread = snapshot.threads.find(item => item.id === record.delegatedThreadId)
    if (thread && this.free(thread, snapshot)) await this.dispatch(record.id)
    else this.options.control.refreshDelegationObservation()
  }
  /** Whether a delegated thread can take a brief now: idle, connected, asking nothing and holding nothing of the user's. */
  private free(thread: AgentThread, snapshot: AgentHostSnapshot): boolean {
    return !isThreadTurnRunning(thread) && !thread.requests.length && !this.sending.has(thread.id) && thread.clientConnected !== false
      && isThreadProviderConnected(snapshot, thread) && !this.options.control.hasPendingThreadWork(thread.id)
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
    const caller = snapshot.threads.find(thread => thread.id === record.delegatingThreadId), model = resolveModel(snapshot.models, start.modelId)
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
    if (nativeHead(thread) !== record.expectedLastUserMessageId) { this.dispatchRefusals.set(delegationId, 'target-changed'); throw new Error('This thread received another instruction. Nothing was sent.') }
  }
  private async dispatch(delegationId: string): Promise<void> {
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
      else this.accept(delegationId, state)
    } finally {
      this.dispatchRefusals.delete(delegationId)
      this.sending.delete(record.delegatedThreadId)
      await this.persist()
      this.options.control.refreshDelegationObservation()
    }
  }
  private accept(delegationId: string, state: 'accepted' | 'uncertain'): void {
    this.update(delegationId, saved => {
      if (saved.deliveryState !== 'accepted') saved.deliveryState = state
      const link = this.links.get(saved.delegatedThreadId)
      if (link && saved.deliveryState === 'accepted') link.seenHead = saved.messageId
    })
  }
  /** Ends a brief that was never delivered. One refused before anything was sent costs its thread no prompt. */
  private fail(delegationId: string, failure: Failure, refund = false): void {
    this.queuedBriefs.delete(delegationId)
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

  private observedThreadIds(): string[] {
    return [...new Set([...this.records.filter(record => this.open(record)).map(record => record.delegatedThreadId), ...this.paused])]
  }
  /**
   * One pass over the coordinator's snapshot: each open brief's outcome from its thread, pauses whose turn has ended, and
   * briefs whose thread is free. Reads the snapshot's thread list once, whatever the number of delegations.
   */
  private observe(snapshot: AgentHostSnapshot): void {
    if (this.closed) return
    const open = this.records.filter(record => this.open(record))
    if (this.untold.size) this.scheduleNews()
    if (!open.length && !this.paused.size) return
    const threads = new Map(snapshot.threads.map(thread => [thread.id, thread]))
    const briefs = new Set(this.records.map(record => record.messageId))
    let changed = false
    for (const threadId of [...this.paused]) {
      const thread = threads.get(threadId)
      if (!thread || !isThreadTurnRunning(thread) && !this.options.control.hasPendingThreadWork(threadId)) { this.paused.delete(threadId); changed = true }
    }
    for (const record of open) {
      const thread = threads.get(record.delegatedThreadId)
      if (!thread || !isThreadProviderConnected(snapshot, thread) || thread.clientConnected === false) continue
      if (record.deliveryState === 'queued') {
        if (this.queuedBriefs.has(record.id) && this.free(thread, snapshot)) void this.dispatch(record.id).catch(() => undefined)
        continue
      }
      if ((record.deliveryState === 'dispatching' || record.deliveryState === 'uncertain') && thread.messages.some(message => message.role === 'user' && message.id === record.messageId)) {
        this.accept(record.id, 'accepted'); changed = true
      }
      if (record.deliveryState !== 'accepted') continue
      const seen = watcherTurnOutcome({ messageId: record.messageId, delivery: 'now', ...(record.outcome ? { outcome: record.outcome } : {}) }, thread, messageId => briefs.has(messageId))
      if (!seen || seen.outcome === record.outcome && seen.turnMessageId === record.turnMessageId && seen.replyMessageId === record.replyMessageId) continue
      this.update(record.id, saved => {
        saved.outcome = seen.outcome; saved.outcomeAt = now()
        for (const field of ['turnMessageId', 'nativeTurnId', 'replyMessageId'] as const) { if (seen[field]) saved[field] = seen[field]; else delete saved[field] }
      })
      if (seen.outcome === 'answered') this.answeredThisRun.add(record.id)
      changed = true
      this.changed(record.id)
    }
    if (changed) { void this.persist(); this.options.control.refreshDelegationObservation() }
  }
  /**
   * An outcome moved: a call waiting on it hears it; otherwise, once it says something new, the delegating thread is sent
   * it as a wake-up carrying identities only (decision 7).
   */
  private changed(delegationId: string): void {
    const record = this.record(delegationId)
    if (!record) return
    const outcome = this.outcomeOf(record)
    if (!this.open(record)) this.waiters.get(record.id)?.forEach(wake => wake())
    if (this.calling.has(record.id) || outcome === 'working' || outcome === record.told) return
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
    await Promise.allSettled([...this.untold].map(async ([threadId, pending]) => {
      if (this.telling.has(threadId)) return
      const records = [...pending.ids].flatMap(id => { const record = this.record(id); return record ? [record] : [] })
        .filter(record => !this.calling.has(record.id) && this.outcomeOf(record) !== 'working' && this.outcomeOf(record) !== record.told)
      if (!records.length || !threads.has(threadId) || pending.attempts >= NEWS_ATTEMPTS_MAX) { this.untold.delete(threadId); return }
      const told = records.map(record => ({ record, outcome: this.outcomeOf(record) }))
      const news: DelegationNews = { source: 'delegation', items: told.map(({ record, outcome }) => ({ delegationId: record.id, threadId: record.delegatedThreadId, outcome,
        ...(record.turnMessageId ? { turnMessageId: record.turnMessageId } : {}) })) }
      this.telling.add(threadId); pending.attempts++
      try {
        await this.options.control.deliverWakeUp(threadId, news, { tool: this.options.tool?.(threadId) ?? false })
        for (const { record, outcome } of told) { record.told = outcome; pending.ids.delete(record.id) }
        if (!pending.ids.size) this.untold.delete(threadId)
        else pending.attempts = 0
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
    const head = thread ? nativeHead(thread) : null
    const read: { -readonly [K in keyof DelegationRead]: DelegationRead[K] } = { id: record.id, thread: record.delegatedThreadId, work: record.work, action: record.action,
      outcome, note: NOTES[outcome], createdAt: record.createdAt, ...(record.turnMessageId ? { turnMessageId: record.turnMessageId } : {}),
      ...(latest && head !== null && head !== latest.messageId ? { userSentSince: true } : {}),
      ...(record.failure === 'target-changed' ? { refusal: 'TARGET_CHANGED' as const } : record.failure === 'paused' ? { refusal: 'PAUSED' as const } : {}) }
    if (outcome === 'answered' && record.replyMessageId) {
      const replyId = record.replyMessageId
      const message = thread?.messages.find(item => item.id === replyId && item.role === 'assistant') ?? this.options.host.threadMessage(record.delegatedThreadId, replyId)
      if (!this.options.historyEnabled() && !this.answeredThisRun.has(record.id)) read.replyUnavailable = 'Keep local history is off, so Sotto did not keep this reply after it restarted. Read the delegated thread for what it said.'
      else if (!message || message.role !== 'assistant') read.replyUnavailable = 'Sotto no longer holds this reply. Read the delegated thread for what it said.'
      else {
        const text = cutUtf8(message.text, WATCHER_REPLY_BYTES_MAX)
        read.reply = { from: 'delegated-thread', thread: record.delegatedThreadId, messageId: message.id, text, truncated: text !== message.text }
      }
    }
    record.told = outcome
    if (reading && thread) { const link = this.links.get(record.delegatedThreadId); if (link) link.seenHead = head }
    await this.persist()
    return { status: 'ok' as const, delegation: read, limits: this.limits(record) }
  }
  private listing(caller: AgentThread, snapshot: AgentHostSnapshot) {
    const own = this.records.filter(record => record.delegatingThreadId === caller.id).slice(-20)
    const ready = this.ready(snapshot).map(model => ({ provider: model.providerId!, model: model.id, name: model.name,
      efforts: model.reasoningEfforts ?? [], permissions: model.runtimeModes ?? [] }))
    return { status: 'ok' as const, delegations: own.map(record => ({ id: record.id, thread: record.delegatedThreadId, work: record.work, action: record.action,
      outcome: this.outcomeOf(record), createdAt: record.createdAt })), models: ready, limits: this.limits() }
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
    this.records = this.records.filter(record => this.open(record) || this.roots.get(record.delegatingThreadId) === record.rootUserMessageId || dropped++ >= excess)
    const kept = new Set(this.records.map(record => record.delegatedThreadId))
    if (this.links.size > RECORDS_MAX) for (const threadId of [...this.links.keys()].slice(0, this.links.size - RECORDS_MAX)) if (!kept.has(threadId)) this.links.delete(threadId)
  }
  /** Writes the record as it is now; rejects when it could not be saved. */
  private save(): Promise<void> {
    return this.store.writeLatest(() => ({ version: 1, delegations: this.records.slice(-RECORDS_MAX * 2), links: [...this.links.values()].slice(-RECORDS_MAX),
      roots: [...this.roots].slice(-RECORDS_MAX).map(([threadId, rootUserMessageId]) => ({ threadId, rootUserMessageId })) }))
  }
  /** Writes the record where a failed write changes nothing already decided: the next write carries it. */
  private persist(): Promise<void> { return this.save().catch(() => undefined) }
}
