import { t } from '@lingui/core/macro'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { isThreadProviderConnected, PROVIDER_LABELS, type AgentCommand, type AgentHostSnapshot, type AgentMessage, type AgentModel, type AgentRuntimeMode, type AgentState,
  type AgentThread } from '../../shared/agents'
import type { AgentActivity } from '../../shared/agentActivity'
import { COUNCIL_CHAIR, COUNCIL_LETTERS, COUNCIL_PROMPT_LEAD, COUNCIL_REMOTE_PROVIDERS, COUNCIL_VIEWS_MAX, councilEffort, councilFramingViewSchema, type CouncilCitation, type CouncilCommand,
  type CouncilCommandResult, type CouncilEstimate, type CouncilKind, type CouncilRoundView, type CouncilSeatChoice, type CouncilView } from '../../shared/council'
import { citationQuoted, COUNCIL_BLOCK_NAMES, findCouncilBlock, parseCitation, readAmendBlock, readAnswerBlock, readCruxBlock, readCruxResultBlock, readFairnessBlock,
  readFramingBlock, readReviewBlock, withoutCouncilBlocks, type BlockRead, type CouncilAnswer, type CouncilCrux, type CouncilCruxResult, type CouncilReview } from '../../shared/councilBlocks'
import { councilCounts } from '../../shared/councilFlow'
import { resolveModel } from '../../shared/modelCatalog'
import { modelInForce } from '../../shared/modelLineup'
import { nearestRuntimeMode } from '../../shared/newThreadDefaults'
import { isThreadTurnRunning } from '../../shared/threadActivity'
import type { BranchBundles } from '../agents/branchBundles'
import type { HostThreadsView } from '../agents/control'
import { runGitStatusCommand, type RunGitCommand } from '../agents/gitStatus'
import { watcherTurnOutcome } from '../agents/watcherOutcomes'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { councilFileSchema, savedRecord, type CouncilFile, type CouncilRecord, type CouncilRound, type CouncilSeat, type CouncilTurn } from './councilRecord'
import { amendPrompt, answerPrompt, cutHistoryText, fairnessPrompt, framingPrompt, framingWords, historyFileWords, historyText, HISTORY_INLINE_MAX, preambleFor, quoteHistory,
  repairPrompt, reviewPrompt, verdictPrompt, cruxPrompt, type QuotedHistory } from './councilPrompts'
import { COUNCIL_WORKTREE_FOLDER, makeCouncilSnapshot, removeCouncilSnapshot, writeCouncilHistory } from './councilSnapshot'
import { activePanelists, addRound, advanceRound, answeredLetters, currentRound, currentTurn, fairnessDone, isComplete, isFinal, isLate, isPanelist, kindsOf, leaveOut, nextClockChange,
  reframable, reframe, replaceSeat, researchOf, retryTurn, rowActions, turnState, type StageClock } from './councilStages'

/**
 * The Council coordinator in main (ADR-0177). It starts each seat's thread on its own provider, in the Council's
 * snapshot, as an ordinary Sotto thread linked to the origin thread the way a delegated thread is linked to the thread
 * that started it (ADR-0081), so the sidebar lists it under that thread, which says when one waits on the user, and it
 * settles with it. It sends each stage's prompt once the thread is free, follows the turn the prompt began, reads the
 * result block where the reply arrives, and moves the stages on. Nothing it sends answers a question or a permission:
 * a thread waiting on the user is sent nothing until the user has answered. A prompt not confirmed before a restart is
 * unknown and is never sent again. It logs nothing.
 */

/** The commands the Council sends on the user's behalf: making a seat's thread, a stage's prompt, Stop, and settling. */
export type CouncilCoordinatorCommand = Extract<AgentCommand, { type: 'create-thread' | 'manual-send' | 'interrupt' | 'settle-thread' }>
/** What the coordinator tells the Council, and asks of it. Main-only; never crosses IPC or a socket. */
export interface CouncilControlHooks {
  /** Every snapshot the coordinator accepts, read without copying it; `threads` looks threads up by ID. */
  observe(snapshot: AgentHostSnapshot, threads?: Pick<HostThreadsView, 'thread'>): void
  /** The threads whose turns the Council follows, kept in the observed set so their messages are read. */
  observedThreadIds(): readonly string[]
  /** The message ID a stage's prompt carries, so its turn is known by it from the first echo. */
  messageIdFor(draftId: string): string | undefined
  /** The guard a prompt carries to the provider's writer, asked again after the thread's preparation. */
  guardFor(draftId: string): (() => void) | undefined
  /** Whether a message is one of the Council's prompts, so Watcher never takes it for the user's own. */
  ownsMessage(messageId: string): boolean
}
export interface CouncilCoordinator {
  hostId(): string | undefined
  watcherSnapshot(): AgentHostSnapshot
  configuration(): { readonly newThreadRuntimeMode?: AgentRuntimeMode | undefined }
  useCouncil(hooks: CouncilControlHooks): () => void
  commandFromCouncil(command: CouncilCoordinatorCommand, guard: () => void): Promise<AgentState>
  hasPendingThreadWork(threadId: string): boolean
  refreshCouncilObservation(): void
}
export interface CouncilHost {
  setDelegatedBy(threadId: string, delegatingThreadId: string): Promise<void>
  /** Records a prompt as Sotto's before the provider hears it, as a wake-up is, so no client shows it as the user's. */
  recordSottoMessage(threadId: string, messageId: string): Promise<void>
  threadMessage(threadId: string, messageId: string): { readonly id: string; readonly role: string; readonly text: string } | undefined
  threadMessages?(threadId: string): readonly AgentMessage[]
  threadActivities?(threadId: string): readonly AgentActivity[]
}
export interface CouncilServiceOptions {
  /** Sotto's data folder: `councils.json` and the snapshots' folder live in it. */
  readonly directory: string
  readonly control: CouncilCoordinator
  readonly host: CouncilHost
  readonly historyEnabled: () => boolean
  /** The stage deadline from Settings → Council, in minutes, read when a Council is asked. */
  readonly stageDeadline: () => number
  /** Takes a snapshot of uncommitted work; the check's own snapshot code, in a staging folder of the Council's. */
  readonly bundles: Pick<BranchBundles, 'snapshotOf'>
  readonly run?: RunGitCommand
  readonly now?: () => number
  readonly newId?: () => string
  readonly schedule?: (callback: () => void, delay: number) => () => void
}

const RECORDS_MAX = 200
const REPLY_GONE = '(This reply is no longer held, so it cannot be read again.)'
const MODEL_NAME_MAX = 512
/** The longest verdict kept and shown, as the record's and the view's schemas allow. */
const VERDICT_MAX = 390_000
const STAGE_ORDER = ['framing', 'answer', 'review', 'crux', 'verdict', 'fairness', 'amend'] as const
const isOpen = (record: CouncilRecord): boolean => !record.settledAt
const clip = (text: string, max: number): string => text.length <= max ? text : `${text.slice(0, max - 1)}…`

export class CouncilService {
  private records: CouncilRecord[] = []
  private readonly store: AtomicJsonStore<CouncilFile>
  private readonly run: RunGitCommand
  private readonly clock: () => number
  private readonly newId: () => string
  private readonly schedule: (callback: () => void, delay: number) => () => void
  /** Each prompt by its draft, so the coordinator finds its message ID and guard. */
  private byDraft = new Map<string, { readonly record: CouncilRecord; readonly turn: CouncilTurn }>()
  private messages = new Set<string>()
  /** Threads with a create or a send on its way. */
  private readonly sending = new Set<string>()
  /** The conversation each Council's threads read, while Sotto runs. */
  private readonly histories = new Map<string, { readonly title: string; readonly quoted: QuotedHistory; readonly text: string; readonly cut: string }>()
  /** Whether each followed prompt's thread waited on the user at the last pass, so a change there is told. */
  private readonly waiting = new Map<string, boolean>()
  private readonly listeners = new Set<(councils: readonly string[]) => void>()
  private watched: readonly string[] = []
  private unhook: (() => void) | undefined
  private cancelTimer: (() => void) | undefined
  private closed = false

  constructor(private readonly options: CouncilServiceOptions) {
    this.run = options.run ?? runGitStatusCommand
    this.clock = options.now ?? Date.now
    this.newId = options.newId ?? randomUUID
    this.schedule = options.schedule ?? ((callback, delay) => { const timer = setTimeout(callback, Math.max(0, delay)); timer.unref?.(); return () => clearTimeout(timer) })
    this.store = new AtomicJsonStore(join(options.directory, 'councils.json'), input => councilFileSchema.parse(input), (): CouncilFile => ({ version: 1, councils: [] }))
  }

  /**
   * Reads the record and starts following the coordinator. A prompt that was on its way when Sotto stopped is unknown
   * from now on and is never sent again. A Council whose words were not kept, with Keep local history off, cannot go on.
   */
  async recover(): Promise<void> {
    // A record that cannot be read is left as it is rather than written over; Councils asked from now on are saved anew.
    const file = await this.store.read().catch((): undefined => undefined)
    this.records = file?.councils ?? []
    const at = new Date(this.clock()).toISOString()
    for (const record of this.records) {
      for (const turn of record.turns) if (turn.delivery === 'dispatching') { turn.delivery = 'unconfirmed'; turn.outcome = 'unknown' }
      const round = currentRound(record)
      if (isOpen(record) && !record.stoppedAt && round.stage !== 'done' && round.question === undefined) { record.stoppedAt = at; record.stoppedBecause = 'words-lost' }
      if (record.settledAt && !record.snapshot.removedAt) void this.removeSnapshot(record)
    }
    this.reindex()
    this.unhook = this.options.control.useCouncil({
      observe: (snapshot, threads) => this.observe(snapshot, threads),
      observedThreadIds: () => this.watched,
      messageIdFor: draftId => this.byDraft.get(draftId)?.turn.messageId,
      guardFor: draftId => { const held = this.byDraft.get(draftId); return held ? () => this.guard(held.record, held.turn) : undefined },
      ownsMessage: messageId => this.messages.has(messageId),
    })
    if (file) await this.persist()
    this.changed(this.records.filter(isOpen))
  }

  close(): void {
    this.closed = true
    this.unhook?.(); this.unhook = undefined
    this.cancelTimer?.(); this.cancelTimer = undefined
  }

  onChanged(listener: (councils: readonly string[]) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  // The window's reads and commands.

  /** What each thread would read of the origin conversation, for the Ask screen (decision 3). */
  estimate(originThreadId: string): CouncilEstimate {
    const thread = this.options.control.watcherSnapshot().threads.find(item => item.id === originThreadId)
    if (!thread?.providerId) return { unavailable: t`That thread is not on this computer.` }
    const quoted = this.quote(thread)
    return { messages: quoted.messages, words: quoted.words, tools: quoted.tools }
  }

  async command(command: CouncilCommand): Promise<CouncilCommandResult> {
    if (this.closed) return { ok: false, message: t`Sotto is closing. Nothing was changed.` }
    if (command.type === 'start') return this.start(command)
    const record = this.records.find(item => item.id === command.council)
    if (!record) return { ok: false, message: t`That Council is no longer here.` }
    switch (command.type) {
      case 'stop': await this.stop(record, 'user'); return { ok: true, council: record.id }
      case 'settle': await this.settle(record); return { ok: true, council: record.id }
      case 'reframe': {
        const running = reframe(record, { ...command.kinds ? { kinds: command.kinds } : {}, ...command.research !== undefined ? { research: command.research } : {} }, this.clock())
        if (!running) return { ok: false, message: t`The framing can change only after it is in and before the verdict, and only to something new. Nothing was changed.` }
        for (const thread of running) await this.interrupt(record, thread)
        return this.moved(record)
      }
      case 'follow-up': {
        if (record.stoppedAt || record.settledAt) return { ok: false, message: t`This Council has stopped, so it takes no follow-up. Ask a new Council instead.` }
        if (currentRound(record).stage !== 'done') return { ok: false, message: t`Wait for the verdict and its fairness check before asking a follow-up.` }
        addRound(record, command.question, this.clock())
        return this.moved(record)
      }
      default: return this.act(record, command)
    }
  }

  /** Every Council, newest first, as the window shows them. Reads the threads it names without copying the snapshot. */
  views(): CouncilView[] {
    const snapshot = this.options.control.watcherSnapshot()
    const threads = new Map<string, AgentThread>()
    const wanted = new Set(this.records.flatMap(record => [record.originThread, ...record.seats.map(seat => seat.thread)]))
    for (const thread of snapshot.threads) if (wanted.has(thread.id)) threads.set(thread.id, thread)
    return this.records.slice(-COUNCIL_VIEWS_MAX).reverse().map(record => this.view(record, threads))
  }

  // Starting.

  private async start(command: Extract<CouncilCommand, { type: 'start' }>): Promise<CouncilCommandResult> {
    const snapshot = this.options.control.watcherSnapshot()
    const origin = snapshot.threads.find(thread => thread.id === command.originThread)
    if (!origin || origin.remoteHost === true || origin.hostId !== undefined && origin.hostId !== this.options.control.hostId()) {
      return { ok: false, message: t`A Council starts from a thread on this computer. Choose one of this computer's threads. Nothing was started.` }
    }
    if (origin.kind === 'watcher' || origin.kind === 'watcher-history') return { ok: false, message: t`A Council starts from an ordinary thread, not Watcher. Nothing was started.` }
    const project = snapshot.projects.find(item => item.id === origin.projectId)
    const seats = [...command.panelists.map((choice, index) => ({ choice, seat: COUNCIL_LETTERS[index]!, role: 'panelist' as const })), { choice: command.chair, seat: COUNCIL_CHAIR, role: 'chair' as const }]
    const ready = seats.map(entry => ({ ...entry, model: this.readyModel(snapshot.models, entry.choice) }))
    if (ready.some(entry => !entry.model)) return { ok: false, message: t`A seat's model is not ready: its provider is not connected. Choose another model for it, then ask again. Nothing was started.` }
    const folder = origin.workingDirectory ?? project?.path
    if (!folder) return { ok: false, message: t`That thread has no folder Sotto can take a snapshot of. Nothing was started.` }
    const id = this.newId()
    const made = await makeCouncilSnapshot({ bundles: this.options.bundles, run: this.run, folder, path: join(this.options.directory, COUNCIL_WORKTREE_FOLDER, id) })
    if ('refused' in made) return { ok: false, message: made.refused }
    const quoted = this.quote(origin)
    const text = historyText(origin.title, quoted), cut = cutHistoryText(origin.title, quoted)
    const fits = text.length <= HISTORY_INLINE_MAX
    // Past what a prompt carries, the conversation goes in the snapshot for threads to read whole, but only while Keep
    // local history is on: with it off, Sotto writes no conversation to disk, and each thread reads its newest part.
    const file = !fits && this.options.historyEnabled() && await writeCouncilHistory(made.path, text).then(() => true, () => false)
    const now = new Date(this.clock()).toISOString()
    const record: CouncilRecord = {
      id, createdAt: now, originThread: origin.id, originTitle: clip(origin.title, 512), projectId: origin.projectId,
      snapshot: { path: made.path, repositoryRoot: made.repositoryRoot, commit: made.commit, branch: made.branch, untracked: made.untracked, dirty: made.dirty },
      history: { messages: quoted.messages, words: quoted.words, tools: quoted.tools, mode: fits ? 'inline' : file ? 'file' : 'cut', leftOut: fits || file ? 0 : cut.leftOut,
        ...quoted.lastMessageId ? { lastMessageId: quoted.lastMessageId } : {} },
      seats: ready.map(entry => this.seatOf(entry.seat, entry.role, entry.model!, entry.choice, this.newId())),
      rounds: [{ index: 0, askedAt: now, stage: 'framing', leftOut: [], objections: [], question: command.question }],
      turns: [], deadlineMinutes: this.options.stageDeadline(),
    }
    this.histories.set(id, { title: origin.title, quoted, text, cut: cut.text })
    this.records.push(record)
    if (this.records.length > RECORDS_MAX) this.records.splice(0, this.records.length - RECORDS_MAX)
    return this.moved(record)
  }

  private readyModel(models: readonly AgentModel[], choice: CouncilSeatChoice): AgentModel | undefined {
    const model = resolveModel(models, modelInForce(models, choice.modelId))
    return model?.ready ? model : undefined
  }
  private seatOf(seat: string, role: 'panelist' | 'chair', model: AgentModel, choice: CouncilSeatChoice, thread: string): CouncilSeat {
    return { seat, role, modelId: model.id, modelName: clip(model.name, MODEL_NAME_MAX), ...model.providerId ? { provider: model.providerId } : {},
      effort: councilEffort(choice.reasoningEffort, model), thread, formerThreads: [], started: false, context: false }
  }
  private quote(thread: AgentThread): QuotedHistory {
    const messages = this.options.host.threadMessages?.(thread.id) ?? thread.messages
    return quoteHistory({ provider: thread.providerId ?? 'claude', messages, activities: this.options.host.threadActivities?.(thread.id) ?? thread.activities ?? [] })
  }

  // The user's row actions, Stop and settling.

  private async act(record: CouncilRecord, command: Extract<CouncilCommand, { type: 'retry' | 'skip' | 'replace' }>): Promise<CouncilCommandResult> {
    const turn = record.turns.find(item => item.id === command.turn)
    const thread = turn ? this.options.control.watcherSnapshot().threads.find(item => item.id === turn.thread) : undefined
    const offered = turn ? rowActions(record, turn, this.clock(), (thread?.requests.length ?? 0) > 0) : []
    if (!turn || !offered.includes(command.type)) return { ok: false, message: t`That row has nothing to do now. Nothing was changed.` }
    let model: AgentModel | undefined
    if (command.type === 'replace') {
      model = this.readyModel(this.options.control.watcherSnapshot().models, command.seat)
      if (!model) return { ok: false, message: t`That model is not ready: its provider is not connected. Choose another. Nothing was changed.` }
    }
    // A prompt still running is stopped first, so nothing it does later is taken for the seat's answer.
    if (thread && isThreadTurnRunning(thread) && !isFinal(turn)) await this.interrupt(record, turn.thread)
    const clock = this.stageClock()
    if (command.type === 'retry') retryTurn(record, turn, clock)
    else if (command.type === 'skip') leaveOut(record, turn)
    else replaceSeat(record, turn, this.seatOf(turn.seat, turn.seat === COUNCIL_CHAIR ? 'chair' : 'panelist', model!, command.seat, ''), this.newId(), clock)
    return this.moved(record)
  }

  private async stop(record: CouncilRecord, because: 'user' | 'snapshot'): Promise<void> {
    if (record.stoppedAt || record.settledAt) return
    record.stoppedAt = new Date(this.clock()).toISOString(); record.stoppedBecause = because
    for (const turn of record.turns) if (turn.delivery === 'queued') turn.superseded = true
    const running = new Set(record.turns.filter(turn => !turn.superseded && !isFinal(turn) && turn.delivery !== 'queued').map(turn => turn.thread))
    await this.persist()
    this.changed([record])
    for (const thread of running) await this.interrupt(record, thread)
  }

  /** Settling a Council settles its threads with it and removes its snapshot (decision 2). */
  private async settle(record: CouncilRecord): Promise<void> {
    if (record.settledAt) return
    await this.stop(record, 'user')
    record.settledAt = new Date(this.clock()).toISOString()
    await this.persist()
    this.changed([record])
    const threads = record.seats.flatMap(seat => seat.started ? [seat.thread, ...seat.formerThreads] : seat.formerThreads)
    const known = new Set(this.options.control.watcherSnapshot().threads.map(thread => thread.id))
    for (const thread of threads) if (known.has(thread)) await this.options.control.commandFromCouncil({ type: 'settle-thread', threadId: thread }, () => undefined).catch(() => undefined)
    await this.removeSnapshot(record)
  }
  private async removeSnapshot(record: CouncilRecord): Promise<void> {
    await removeCouncilSnapshot(this.run, record.snapshot)
    record.snapshot.removedAt = new Date(this.clock()).toISOString()
    await this.persist()
    this.changed([record])
  }
  private async interrupt(record: CouncilRecord, threadId: string): Promise<void> {
    await this.options.control.commandFromCouncil({ type: 'interrupt', threadId }, () => undefined).catch(() => undefined)
  }

  // Following the threads.

  private observe(snapshot: AgentHostSnapshot, view?: Pick<HostThreadsView, 'thread'>): void {
    if (this.closed || this.watched.length === 0) return
    let list: Map<string, AgentThread> | undefined
    const thread = (id: string): AgentThread | undefined => view ? view.thread(id) : (list ??= new Map(snapshot.threads.map(item => [item.id, item]))).get(id)
    const moved: CouncilRecord[] = []
    let told = false
    for (const record of this.records) {
      if (!isOpen(record)) continue
      let changed = false
      for (const turn of record.turns) {
        if (turn.superseded || turn.delivery === 'queued' || isFinal(turn)) continue
        const held = thread(turn.thread)
        if (!held || !isThreadProviderConnected(snapshot, held) || held.clientConnected === false) continue
        const waiting = held.requests.length > 0
        if (this.waiting.get(turn.id) !== waiting) { this.waiting.set(turn.id, waiting); told = true }
        if (turn.delivery === 'dispatching') {
          if (held.messages.some(message => message.role === 'user' && message.id === turn.messageId)) { turn.delivery = 'accepted'; changed = true }
          else {
            if (!this.sending.has(turn.thread) && !isThreadTurnRunning(held) && !this.options.control.hasPendingThreadWork(held.id)) { turn.delivery = 'unconfirmed'; turn.outcome = 'unknown'; changed = true }
            continue
          }
        }
        const seen = watcherTurnOutcome({ messageId: turn.messageId, delivery: 'now' }, held, messageId => this.messages.has(messageId))
        if (!seen) continue
        const outcome = seen.outcome === 'answered' ? 'answered' : seen.outcome === 'failed' ? 'failed' : seen.outcome === 'stopped' || seen.outcome === 'paused' ? 'stopped'
          : seen.outcome === 'unknown' ? 'unknown' : 'working'
        if (outcome === (turn.outcome ?? 'working') && seen.replyMessageId === turn.replyMessageId) continue
        turn.outcome = outcome
        if (seen.replyMessageId) turn.replyMessageId = seen.replyMessageId
        if (outcome === 'answered') this.read(record, turn, held)
        changed = true
      }
      if (changed) moved.push(record)
    }
    for (const record of moved) void this.moved(record)
    if (!moved.length) this.dispatchFree(snapshot, thread)
    if (told && !moved.length) this.tell(this.records.filter(record => isOpen(record) && record.turns.some(turn => this.waiting.has(turn.id))).map(record => record.id))
  }

  /** Something about the Council moved: its stages go on, its record is saved, the window is told and free threads are sent their prompts. */
  private async moved(record: CouncilRecord): Promise<CouncilCommandResult> {
    advanceRound(record, this.stageClock())
    this.reindex()
    await this.persist()
    this.changed([record])
    const snapshot = this.options.control.watcherSnapshot()
    let list: Map<string, AgentThread> | undefined
    this.dispatchFree(snapshot, id => (list ??= new Map(snapshot.threads.map(item => [item.id, item]))).get(id))
    return { ok: true, council: record.id }
  }

  /** Sends each queued prompt whose thread is free: idle, connected, asking the user nothing and holding no other work. */
  private dispatchFree(snapshot: AgentHostSnapshot, thread: (id: string) => AgentThread | undefined): void {
    for (const record of this.records) {
      if (!isOpen(record) || record.stoppedAt) continue
      for (const turn of record.turns) {
        if (turn.superseded || turn.delivery !== 'queued' || this.sending.has(turn.thread)) continue
        const seat = record.seats.find(item => item.seat === turn.seat)!
        if (seat.thread !== turn.thread) { turn.superseded = true; continue }
        if (seat.started) {
          const held = thread(turn.thread)
          if (!held || !isThreadProviderConnected(snapshot, held) || held.clientConnected === false || isThreadTurnRunning(held) || held.requests.length > 0
            || this.options.control.hasPendingThreadWork(held.id)) continue
        }
        void this.dispatch(record, turn, seat)
      }
    }
  }

  private async dispatch(record: CouncilRecord, turn: CouncilTurn, seat: CouncilSeat): Promise<void> {
    this.sending.add(turn.thread)
    const fail = (): void => { turn.delivery = 'failed'; turn.outcome = 'failed' }
    try {
      if (!seat.started && !await this.createThread(record, seat)) return fail()
      const prompt = this.promptFor(record, turn, seat)
      if (prompt === undefined) return fail()
      const text = `${COUNCIL_PROMPT_LEAD}\n\n${prompt}`
      try { this.guard(record, turn) } catch { return }
      turn.delivery = 'dispatching'; turn.sentAt = new Date(this.clock()).toISOString()
      // Saved as on its way before the provider can hear it, so a restart reads it as unknown, never as unsent; and
      // recorded as Sotto's, never the user's, as a wake-up is.
      try { await this.save(); await this.options.host.recordSottoMessage(turn.thread, turn.messageId) } catch { return fail() }
      let result: AgentState
      try { result = await this.options.control.commandFromCouncil({ type: 'manual-send', threadId: turn.thread, draftId: turn.draftId, text }, () => this.guard(record, turn)) }
      catch { return fail() }
      const delivery = result.deliveries?.find(item => item.draftId === turn.draftId && item.threadId === turn.thread)
      if (delivery?.status === 'uncertain' || delivery?.status === 'submitting') seat.context = true
      else if (delivery?.status === 'accepted' || !delivery && !result.error) { turn.delivery = 'accepted'; seat.context = true }
      else fail()
    } finally {
      this.sending.delete(turn.thread)
      this.reindex()
      await this.persist()
      this.changed([record])
      this.options.control.refreshCouncilObservation()
    }
  }

  /** Makes a seat's thread in the snapshot, at the narrowest permission its provider offers, linked to the origin thread. */
  private async createThread(record: CouncilRecord, seat: CouncilSeat): Promise<boolean> {
    const models = this.options.control.watcherSnapshot().models
    const model = resolveModel(models, seat.modelId)
    if (!model?.ready) return false
    const name = seat.seat === COUNCIL_CHAIR ? 'Council chair' : `Council ${seat.seat}`
    try {
      const created = await this.options.control.commandFromCouncil({ type: 'create-thread', threadId: seat.thread, projectId: record.projectId, title: clip(`${name}: ${record.originTitle}`, 120),
        titleSource: 'user', modelId: seat.modelId, workingCopy: 'independent', existingWorktreePath: record.snapshot.path, ...seat.effort ? { reasoningEffort: seat.effort } : {},
        ...narrowestPermission(model) }, () => { if (record.stoppedAt || record.settledAt) throw new Error('This Council has stopped.') })
      if (created.error || !created.host.threads.some(thread => thread.id === seat.thread)) return false
      await this.options.host.setDelegatedBy(seat.thread, record.originThread)
      seat.started = true
      return true
    } catch { return false }
  }

  private guard(record: CouncilRecord, turn: CouncilTurn): void {
    if (this.closed || record.stoppedAt || record.settledAt || turn.superseded) throw new Error('This Council prompt is no longer wanted.')
  }

  // Reading what came back.

  private replyText(turn: CouncilTurn, thread?: AgentThread): string | undefined {
    if (!turn.replyMessageId) return undefined
    return thread?.messages.find(message => message.id === turn.replyMessageId && message.role === 'assistant')?.text
      ?? this.options.host.threadMessage(turn.thread, turn.replyMessageId)?.text
  }

  /** Reads a reply's result block once, where it arrives (decision 4). A repair's reply settles the prompt it repairs. */
  private read(record: CouncilRecord, turn: CouncilTurn, thread: AgentThread): void {
    const target = turn.repairOf ? record.turns.find(item => item.id === turn.repairOf) : turn
    if (!target) return
    const round = record.rounds[target.round]!
    const text = this.replyText(turn, thread)
    const unread = (): void => { target.result = 'unavailable'; if (turn !== target) turn.result = 'unavailable' }
    if (text === undefined) return unread()
    const letters = answeredLetters(record, round)
    let read: BlockRead<unknown> | undefined
    let summary: string | undefined
    switch (target.stage) {
      case 'framing': {
        const framing = readFramingBlock(text, activePanelists(record, round).map(seat => seat.seat))
        // A framing that cannot be read is not repaired: the Council goes on with the question alone (decision 4).
        if (!framing.ok) return unread()
        read = framing; summary = framing.value.kinds.join(', ')
        break
      }
      case 'answer': {
        const answer = readAnswerBlock(text, target.seat, round.framing?.criteria.map(criterion => criterion.id) ?? [])
        read = answer
        if (answer.ok) { summary = answer.value.answer; void this.checkCitations(record, target, answer.value.findings.flatMap(finding => finding.evidence ? [{ finding: finding.id, evidence: finding.evidence }] : [])) }
        break
      }
      case 'review': {
        const review = readReviewBlock(text, this.reviewContext(record, round, target.seat))
        read = review
        if (review.ok) {
          summary = reviewSummary(review.value)
          void this.checkCitations(record, target, review.value.evidence.map(evidence => ({ finding: target.seat, evidence })))
        }
        break
      }
      case 'crux': {
        const result = readCruxResultBlock(text, round.crux?.meanings.length ?? 2)
        read = result
        if (result.ok) summary = result.value.result
        break
      }
      case 'verdict': {
        if (!round.cruxDone && letters.length >= 2 && findCouncilBlock(text, COUNCIL_BLOCK_NAMES.crux)) {
          // A crux check the chair asked for and Sotto could not read is not repaired: the chair writes the verdict without one.
          const crux = readCruxBlock(text, letters)
          if (!crux.ok) return unread()
          read = crux; summary = crux.value.test
          break
        }
        round.verdict = clip(withoutCouncilBlocks(text), VERDICT_MAX)
        target.result = 'none'
        return
      }
      case 'fairness': {
        const fairness = readFairnessBlock(text, round.verdict ?? '')
        read = fairness
        if (fairness.ok) {
          summary = fairness.value.fair ? 'Fair' : 'Unfair'
          if (!fairness.value.fair && !round.objections.some(objection => objection.seat === target.seat)) {
            round.objections.push({ seat: target.seat, claim: clip(fairness.value.claim!, 2_000), passage: clip(fairness.value.passage!, 2_000), answer: 'pending' })
          }
        }
        break
      }
      case 'amend': {
        const amend = readAmendBlock(text, target.objections ?? [])
        read = amend
        if (amend.ok) {
          for (const answer of amend.value.objections) {
            const objection = round.objections.find(item => item.seat === answer.seat && item.turn === target.id)
            if (objection) { objection.answer = answer.answer; if (answer.reason) objection.reason = clip(answer.reason, 2_000) }
          }
          if (amend.value.objections.some(answer => answer.answer === 'amended')) {
            const body = withoutCouncilBlocks(this.replyText(target, thread) ?? '')
            if (body) { round.verdict = clip(body, VERDICT_MAX); round.amended = true }
          }
        } else if (turn.repairOf) for (const objection of round.objections) if (objection.turn === target.id) objection.answer = 'unanswered'
        break
      }
    }
    if (!read) return
    if (read.ok) {
      target.result = 'valid'; target.block = read.value
      if (summary) target.summary = clip(summary, 2_000)
      if (turn !== target) turn.result = 'valid'
      return
    }
    if (turn.repairOf) return unread()
    target.result = 'invalid'; target.reason = clip(read.reason, 2_000)
  }

  private reviewContext(record: CouncilRecord, round: CouncilRound, letter: string): { letter: string; kind: CouncilKind; reviewed: Map<string, string[]> } {
    const reviewed = new Map<string, string[]>()
    for (const other of round.reviewPlan?.[letter] ?? []) {
      const answer = currentTurn(record, round, 'answer', other)
      const block = held<CouncilAnswer>(answer)
      reviewed.set(other, block ? block.findings.map(finding => finding.id) : [other])
    }
    return { letter, kind: kindsOf(round)[0]!, reviewed }
  }

  /** Checks each cited `path:lines` against the snapshot and the reply's quotes (decision 4); a seat that cannot read the snapshot is unchecked. */
  private async checkCitations(record: CouncilRecord, turn: CouncilTurn, cited: readonly { readonly finding: string; readonly evidence: string }[]): Promise<void> {
    const places = cited.flatMap(item => { const place = parseCitation(item.evidence); return place ? [{ finding: item.finding, place }] : [] }).slice(0, 40)
    if (!places.length) return
    const seat = record.seats.find(item => item.seat === turn.seat)
    const remote = seat?.provider !== undefined && COUNCIL_REMOTE_PROVIDERS.has(seat.provider)
    const reply = [this.replyText(turn) ?? '', ...record.turns.filter(item => item.repairOf === turn.id).map(item => this.replyText(item) ?? '')].join('\n')
    const root = resolve(record.snapshot.path)
    const citations: CouncilCitation[] = []
    for (const { finding, place } of places) {
      const lines = place.start === place.end ? String(place.start) : `${place.start}-${place.end}`
      let check: CouncilCitation['check'] = 'unchecked'
      if (!remote && !record.snapshot.removedAt) {
        const file = resolve(root, place.path)
        if (relative(root, file).startsWith('..')) check = 'missing'
        else {
          const size = await stat(file).then(item => item.isFile() ? item.size : -1, () => -1)
          const text = size >= 0 && size <= 4_000_000 ? await readFile(file, 'utf8').catch(() => undefined) : undefined
          const quoted = text === undefined ? undefined : citationQuoted(text, place, reply)
          check = quoted === undefined ? 'missing' : quoted ? 'matches' : 'differs'
        }
      }
      citations.push({ finding, path: place.path, lines, check })
    }
    turn.citations = citations
    await this.persist()
    this.changed([record])
  }

  // The prompts.

  private history(record: CouncilRecord): { readonly title: string; readonly quoted: QuotedHistory; readonly text: string; readonly cut: string } | undefined {
    const held = this.histories.get(record.id)
    if (held) return held
    // After a restart: the origin conversation again, up to the message that was its last when the Council was asked.
    const origin = this.options.control.watcherSnapshot().threads.find(thread => thread.id === record.originThread)
    if (!origin) return undefined
    const messages = this.options.host.threadMessages?.(origin.id) ?? origin.messages
    const last = record.history.lastMessageId ? messages.findIndex(message => message.id === record.history.lastMessageId) : messages.length - 1
    const quoted = quoteHistory({ provider: origin.providerId ?? 'claude', messages: messages.slice(0, last + 1), activities: this.options.host.threadActivities?.(origin.id) ?? origin.activities ?? [] })
    const history = { title: record.originTitle, quoted, text: historyText(record.originTitle, quoted), cut: cutHistoryText(record.originTitle, quoted).text }
    this.histories.set(record.id, history)
    return history
  }

  private preamble(record: CouncilRecord, seat: CouncilSeat): string | undefined {
    const history = this.history(record)
    if (!history) return undefined
    const remote = seat.provider !== undefined && COUNCIL_REMOTE_PROVIDERS.has(seat.provider)
    const words = record.history.mode === 'inline' ? history.text : record.history.mode === 'file' && !remote ? historyFileWords(history.quoted) : history.cut
    return preambleFor({ role: seat.role, seat: seat.seat, panelists: record.seats.filter(isPanelist).length, snapshot: snapshotWords(record), history: words, remote })
  }

  private promptFor(record: CouncilRecord, turn: CouncilTurn, seat: CouncilSeat): string | undefined {
    const round = record.rounds[turn.round]!
    if (round.question === undefined) return undefined
    if (turn.repairOf) {
      const original = record.turns.find(item => item.id === turn.repairOf)
      return repairPrompt(blockName(turn.stage), original?.reason ?? 'the block is missing')
    }
    const preamble = seat.context ? undefined : this.preamble(record, seat)
    if (!seat.context && preamble === undefined) return undefined
    const previous = round.index > 0 ? record.rounds[round.index - 1]!.verdict : undefined
    const context = { ...preamble ? { preamble } : {}, question: round.question, ...previous ? { previousVerdict: previous } : {} }
    const remote = seat.provider !== undefined && COUNCIL_REMOTE_PROVIDERS.has(seat.provider)
    // A thread new to the seat, after Use another model, reads the conversation, the question and the framing first.
    const catchUp = preamble ? [preamble, `The question, verbatim:\n<question>\n${round.question}\n</question>`, ...seat.role === 'panelist' ? [framingWords(round.framing, seat.seat, kindsOf(round))] : []].join('\n\n') : undefined
    const answerOf = (letter: string): string => { const answer = currentTurn(record, round, 'answer', letter); return answer ? this.replyText(answer) ?? REPLY_GONE : REPLY_GONE }
    switch (turn.stage) {
      case 'framing': return framingPrompt(context, activePanelists(record, round).map(item => item.seat))
      // After the user changed the framing, a thread that read the earlier one is told to answer again from the start.
      case 'answer': return answerPrompt(context, { letter: seat.seat, framing: round.framing, kinds: kindsOf(round), research: researchOf(round), snapshot: snapshotWords(record), remote,
        again: round.reframedAt !== undefined && seat.context })
      case 'review': {
        const reviewContext = this.reviewContext(record, round, seat.seat)
        return reviewPrompt({ ...catchUp ? { preamble: catchUp, ownAnswer: answerOf(seat.seat) } : {}, letter: seat.seat, kind: reviewContext.kind,
          answers: [...reviewContext.reviewed.keys()].map(letter => ({ letter, text: answerOf(letter) })), ids: [...reviewContext.reviewed.values()].flat() })
      }
      case 'crux': {
        if (!round.crux) return undefined
        const establish = turn.establish === undefined ? undefined : round.crux.sides[turn.establish]
        const claims = (establish ?? []).flatMap(letter => { const answer = currentTurn(record, round, 'answer', letter); const block = held<CouncilAnswer>(answer); return block ? [block.answer] : [] })
        return cruxPrompt({ ...catchUp ? { preamble: catchUp } : {}, plan: round.crux, ...establish ? { establish: { letters: establish, claims } } : {} })
      }
      case 'verdict': {
        const letters = answeredLetters(record, round)
        const reviews = Object.keys(round.reviewPlan ?? {}).flatMap(reader => { const review = currentTurn(record, round, 'review', reader); return review && isComplete(review) ? [{ letter: reader, text: this.replyText(review) ?? REPLY_GONE }] : [] })
        const results = (round.cruxRunners ?? []).flatMap(runner => { const crux = currentTurn(record, round, 'crux', runner); return crux && isComplete(crux) ? [{ letter: runner, text: this.replyText(crux) ?? REPLY_GONE }] : [] })
        return verdictPrompt({ ...catchUp ? { preamble: catchUp, question: round.question } : {}, kinds: kindsOf(round), answers: letters.map(letter => ({ letter, text: answerOf(letter) })), reviews,
          leftOut: round.leftOut.filter(letter => letter !== COUNCIL_CHAIR), panelists: record.seats.filter(isPanelist).length,
          ...round.crux && round.cruxDone ? { crux: { plan: round.crux, results } } : {}, cruxAllowed: !round.cruxDone && letters.length >= 2 })
      }
      case 'fairness': {
        if (round.verdict === undefined) return undefined
        const crux = (round.cruxRunners ?? []).map(runner => held<CouncilCruxResult>(currentTurn(record, round, 'crux', runner))).find(item => item !== undefined)
        return fairnessPrompt({ ...catchUp ? { preamble: catchUp, ownAnswer: answerOf(seat.seat) } : {}, letter: seat.seat, verdict: round.verdict, ...crux ? { crux } : {} })
      }
      case 'amend': {
        const objections = round.objections.filter(objection => objection.turn === turn.id && objection.claim !== undefined && objection.passage !== undefined)
        if (!objections.length) return undefined
        return amendPrompt(objections.map(objection => ({ seat: objection.seat, claim: objection.claim!, passage: objection.passage! })), catchUp ? { preamble: catchUp, verdict: round.verdict ?? '' } : undefined)
      }
    }
  }

  // The window's view.

  private view(record: CouncilRecord, threads: ReadonlyMap<string, AgentThread>): CouncilView {
    const now = this.clock()
    const round0 = currentRound(record)
    const status: CouncilView['status'] = record.settledAt ? 'settled' : record.stoppedAt ? 'stopped' : round0.stage === 'done' ? 'done'
      : record.turns.some(turn => !turn.superseded && turn.round === round0.index && (rowActions(record, turn, now, (threads.get(turn.thread)?.requests.length ?? 0) > 0).length > 0
        || !isFinal(turn) && (threads.get(turn.thread)?.requests.length ?? 0) > 0)) ? 'waiting' : 'working'
    return {
      id: record.id, createdAt: record.createdAt,
      origin: { thread: record.originThread, title: threads.get(record.originThread)?.title ?? record.originTitle },
      status, ...record.stoppedBecause && record.stoppedAt ? { stoppedBecause: record.stoppedBecause } : {},
      snapshot: { commit: record.snapshot.commit.slice(0, 12), branch: record.snapshot.branch, untracked: record.snapshot.untracked, dirty: record.snapshot.dirty === true, removed: record.snapshot.removedAt !== undefined },
      history: { messages: record.history.messages, words: record.history.words, mode: record.history.mode, leftOut: record.history.leftOut },
      seats: record.seats.map(seat => ({ seat: seat.seat, role: seat.role, modelId: seat.modelId, modelName: seat.modelName, ...seat.provider ? { provider: seat.provider } : {}, effort: seat.effort,
        thread: seat.thread, remote: seat.provider !== undefined && COUNCIL_REMOTE_PROVIDERS.has(seat.provider) })),
      rounds: record.rounds.map(round => this.roundView(record, round, threads, now)),
      deadlineMinutes: record.deadlineMinutes,
    }
  }

  private roundView(record: CouncilRecord, round: CouncilRound, threads: ReadonlyMap<string, AgentThread>, now: number): CouncilRoundView {
    const deadline = record.deadlineMinutes * 60_000
    const rows = record.turns.filter(turn => turn.round === round.index && !turn.superseded)
      .sort((left, right) => STAGE_ORDER.indexOf(left.stage) - STAGE_ORDER.indexOf(right.stage) || Number(Boolean(left.repairOf)) - Number(Boolean(right.repairOf)))
      .map(turn => {
        const waiting = !isFinal(turn) && (threads.get(turn.thread)?.requests.length ?? 0) > 0
        return { turn: turn.id, seat: turn.seat, stage: turn.stage, state: turnState(turn, waiting), late: isLate(turn, now, deadline), repair: turn.repairOf !== undefined,
          result: turn.result === 'invalid' ? 'pending' as const : turn.result, ...turn.summary ? { summary: turn.summary } : {}, ...turn.citations?.length ? { citations: turn.citations } : {},
          ...sourcesOf(turn), thread: turn.thread, actions: rowActions(record, turn, now, waiting) }
      })
    const verdict = round.verdict === undefined && !(round.stage === 'fairness' || round.stage === 'done') ? null : {
      text: round.verdict ?? null, counts: this.counts(record, round), fairnessDone: fairnessDone(record, round, now),
      objections: round.objections.map(objection => ({ seat: objection.seat, claim: objection.claim ?? '', passage: objection.passage ?? '',
        answer: objection.answer === 'unanswered' ? 'pending' as const : objection.answer, ...objection.reason ? { reason: objection.reason } : {} })),
    }
    const research = { needed: researchOf(round), reason: round.research === undefined ? round.framing?.research.reason ?? '' : '', byUser: round.research !== undefined }
    const framing = round.framing || round.framingFallback ? councilFramingViewSchema.safeParse(round.framing
      ? { kinds: kindsOf(round), criteria: round.framing.criteria, headings: round.framing.headings, words: round.framing.words, angles: round.framing.angles, research, fallback: false }
      : { kinds: kindsOf(round), criteria: [], headings: [], words: 0, angles: [], research, fallback: true }).data ?? null : null
    return {
      index: round.index, question: round.question ?? null, askedAt: round.askedAt, stage: round.stage, framing, rows, leftOut: round.leftOut,
      reframable: round.index === currentRound(record).index && reframable(record),
      crux: round.crux ? { test: round.crux.test, lookup: round.crux.lookup, sides: round.crux.sides, meanings: round.crux.meanings.map(meaning => `${meaning.result} => ${meaning.meaning}`),
        ...(() => { const result = (round.cruxRunners ?? []).map(runner => held<CouncilCruxResult>(currentTurn(record, round, 'crux', runner))).find(item => item !== undefined); return result ? { result: result.result } : {} })() } : null,
      verdict, draft: verdict?.text && verdict.fairnessDone ? clip(this.draft(record, round, verdict.text), 400_000) : null,
    }
  }

  private counts(record: CouncilRecord, round: CouncilRound): ReturnType<typeof councilCounts> {
    const letters = answeredLetters(record, round)
    const answers = new Map(letters.map(letter => { const turn = currentTurn(record, round, 'answer', letter)!; return [letter, held<CouncilAnswer>(turn) ?? null] }))
    const reviews = Object.entries(round.reviewPlan ?? {}).map(([reader, assigned]) => {
      const turn = currentTurn(record, round, 'review', reader)
      return { reader, assigned, block: held<CouncilReview>(turn) ?? null }
    })
    return councilCounts({ kinds: kindsOf(round), answers, reviews })
  }

  /** What Send to the thread puts in its message box: the verdict, then Sotto's table of letters and its counts, never the chair's words changed. */
  private draft(record: CouncilRecord, round: CouncilRound, verdict: string): string {
    const counts = this.counts(record, round)
    const seat = (item: CouncilSeat): string => `${item.modelName}${item.provider ? ` (${PROVIDER_LABELS[item.provider]}${item.effort ? `, ${item.effort}` : ''})` : ''}`
    const panel = record.seats.filter(isPanelist).map(item => `${item.seat} = ${seat(item)}`).join('; ')
    const chair = record.seats.find(item => item.seat === COUNCIL_CHAIR)!
    const lines = [
      `The Council's verdict on: ${clip((round.question ?? '').replace(/\s+/gu, ' ').trim(), 300)}`, verdict,
      `Panelists: ${panel}. Chair: ${seat(chair)}.`,
      ...round.leftOut.filter(letter => letter !== COUNCIL_CHAIR).length ? [`The Council went on without ${round.leftOut.filter(letter => letter !== COUNCIL_CHAIR).join(', ')}.`] : [],
      ...counts.rankings.length ? [`Ranked first: ${counts.rankings.map(item => `${item.letter} by ${item.first} of ${item.of}`).join(', ')}${counts.partial ? ' (partial)' : ''}.`] : [],
      ...counts.findings.length ? [`Findings: ${counts.findings.map(item => `${item.finding} confirmed by ${item.confirmed}, rejected by ${item.rejected}, unchecked by ${item.unchecked} of ${item.of}`).join('; ')}${counts.partial ? ' (partial)' : ''}.`] : [],
      ...counts.supports.length ? [`The evidence supports: ${counts.supports.map(item => `${item.letter} for ${item.count} of ${item.of}`).join(', ')}.`] : [],
      ...counts.favourites.length ? [`Favourites: ${counts.favourites.map(item => `${item.finding} for ${item.count} of ${item.of}`).join(', ')}.`] : [],
      ...round.objections.map(objection => `${objection.seat} objected to "${objection.passage ?? ''}": ${objection.answer === 'amended' ? 'the chair amended it' : objection.answer === 'stands' ? `it stands${objection.reason ? `, because ${objection.reason}` : ''}` : 'the chair has not answered'}.`),
    ]
    return lines.join('\n\n')
  }

  // Bookkeeping.

  private stageClock(): StageClock { return { now: this.clock(), newId: this.newId } }

  private reindex(): void {
    const byDraft = new Map<string, { record: CouncilRecord; turn: CouncilTurn }>(), messages = new Set<string>(), watched = new Set<string>(), followed = new Set<string>()
    for (const record of this.records) {
      if (!isOpen(record)) continue
      for (const turn of record.turns) {
        byDraft.set(turn.draftId, { record, turn })
        messages.add(turn.messageId)
        if (!turn.superseded && !isFinal(turn)) { watched.add(turn.thread); followed.add(turn.id) }
      }
    }
    for (const id of [...this.waiting.keys()]) if (!followed.has(id)) this.waiting.delete(id)
    this.byDraft = byDraft; this.messages = messages
    const list = [...watched]
    if (list.join('\n') !== this.watched.join('\n')) { this.watched = list; this.options.control.refreshCouncilObservation() }
  }

  private save(): Promise<void> {
    const keep = this.options.historyEnabled()
    return this.store.writeLatest(() => ({ version: 1, councils: this.records.map(record => savedRecord(record, keep)) }))
  }
  private persist(): Promise<void> { return this.save().catch(() => undefined) }

  private changed(records: readonly CouncilRecord[]): void {
    this.reschedule()
    this.tell(records.map(record => record.id))
  }
  private tell(ids: readonly string[]): void {
    if (!ids.length) return
    for (const listener of this.listeners) listener(ids)
  }
  /** One wake for the next deadline or the fairness check's two minutes, never a poll. */
  private reschedule(): void {
    this.cancelTimer?.(); this.cancelTimer = undefined
    if (this.closed) return
    const now = this.clock()
    const next = Math.min(...this.records.filter(isOpen).map(record => nextClockChange(record, now) ?? Infinity))
    if (!Number.isFinite(next)) return
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = undefined
      const due = this.records.filter(record => isOpen(record) && !record.stoppedAt)
      for (const record of due) advanceRound(record, this.stageClock())
      this.changed(due)
    }, next - now)
  }
}

/** The narrowest permission a model offers (decision 2): Ask for approval where it is offered, or its provider's own mode that allows nothing. */
export function narrowestPermission(model: AgentModel): { readonly runtimeMode?: AgentRuntimeMode; readonly providerMode?: string } {
  if (model.providerModes?.length) return { providerMode: (model.providerModes.find(mode => mode.allows === 'nothing') ?? model.providerModes[0]!).id }
  const mode = nearestRuntimeMode('approval-required', model.runtimeModes ?? [])
  return mode ? { runtimeMode: mode } : {}
}

/** What Sotto read from a prompt's result block, while it holds it: a repair's block is its prompt's, and words not kept are gone. */
function held<Block>(turn: CouncilTurn | undefined): Block | undefined {
  return turn?.result === 'valid' && turn.block !== undefined ? turn.block as Block : undefined
}
function snapshotWords(record: CouncilRecord): string {
  return `commit ${record.snapshot.commit.slice(0, 12)} on ${record.snapshot.branch}${record.snapshot.dirty ? ', with the uncommitted changes it had' : ''}`
}
function blockName(stage: CouncilTurn['stage']): string {
  switch (stage) {
    case 'framing': return COUNCIL_BLOCK_NAMES.framing
    case 'answer': return COUNCIL_BLOCK_NAMES.answer
    case 'review': return COUNCIL_BLOCK_NAMES.review
    case 'crux': return COUNCIL_BLOCK_NAMES.cruxResult
    case 'verdict': return COUNCIL_BLOCK_NAMES.crux
    case 'fairness': return COUNCIL_BLOCK_NAMES.fairness
    case 'amend': return COUNCIL_BLOCK_NAMES.amend
  }
}
/** An answer's sources by finding, for its row: Sotto checks only a link's shape, so it shows them for reviewers to open. */
function sourcesOf(turn: CouncilTurn): { readonly sources?: { readonly finding: string; readonly url: string }[] } {
  const block = turn.stage === 'answer' && !turn.repairOf ? held<CouncilAnswer>(turn) : undefined
  if (!block) return {}
  const sources = block.findings.flatMap(finding => finding.kind === 'source' && finding.evidence ? [{ finding: finding.id, url: finding.evidence }] : []).slice(0, 40)
  return sources.length ? { sources } : {}
}
function reviewSummary(review: CouncilReview): string {
  return [review.ranking?.length ? review.ranking.join(' > ') : '', review.supports ? `supports ${review.supports}` : '', review.favourites.length ? `favourites ${review.favourites.join(', ')}` : '',
    review.answer === 'changed' ? `changed its answer: ${review.newAnswer ?? ''}` : ''].filter(Boolean).join('; ') || 'reviewed'
}
export type { CouncilCrux }
