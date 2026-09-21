import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { cloneHostSnapshot } from './cloneHostSnapshot'
import { readdir, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { agentHostSnapshotSchema, EMPTY_AGENT_HOST, isThreadProviderConnected, RESTORE_BRANCH_NEEDS_CONFIRMATION, summarizeThread, type AgentWorkingCopyOptions, type AgentWorkingCopySelection, type AgentHostSnapshot, type AgentMessage, type AgentThread, type AgentThreadSummary, type AgentWorktree, type ProviderId } from '../../shared/agents'
import type { AgentSkillReference } from '../../shared/agentSkills'
import type { AnswerGivenEvent, StoredThreadEvent, ThreadEvent } from '../../shared/threadEvents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { AgentHost, AgentHostCommand, AgentHostResult, StoredMessageIdentity } from './host'
import { FIRST_WINDOW_TURNS, LATER_WINDOW_TURNS, ThreadStore } from './threadStore'
import { validateThreadOptions } from './threadOptions'
import { resolveThreadWorkingDirectory } from '../../shared/threadWorkingDirectory'
import { existingWorkingDirectory, ThreadWorktrees } from './threadWorktrees'
import { MAX_AGENT_ACTIVITIES, isTerminalActivity, mergeAgentActivities, type AgentActivity } from '../../shared/agentActivity'

/** Milliseconds a burst of tool activity is left to settle before the worktree is read again. */
const WORKTREE_REFRESH_DELAY_MS = 1_500
/** Work that can leave the worktree on another branch: a finished turn, a shell command it ran, or files it changed. */
const HEAD_MOVING_KINDS: ReadonlySet<AgentActivity['kind']> = new Set(['turn', 'command', 'file-change', 'tool'])
/** The finished records that could have moved HEAD, by ID, so only new ones ask for a re-read. */
function settledHeadMovers(activities: readonly AgentActivity[] | undefined): Set<string> {
  return new Set((activities ?? []).filter(activity => HEAD_MOVING_KINDS.has(activity.kind) && isTerminalActivity(activity.status)).map(activity => activity.id))
}

/** Said when the branch on a working-copy record could not be written; the folder itself was verified. */
const BRANCH_SAVE_ERROR = 'The branch name could not be saved. Restore local storage and refresh.'
/** Said when a thread's own history could not be written. The thread still works; what it said is at risk. */
const HISTORY_SAVE_ERROR = 'Thread messages could not be saved. Restore access to local storage and refresh.'
/** Said when the thread history database could not be opened at all. This run keeps its messages in memory. */
const HISTORY_OPEN_ERROR = 'Thread messages could not be opened. Restore access to local storage and restart Sotto.'

/** How much of a message the last publish left behind: enough to tell an append from a rewrite. */
interface MessageMark { readonly id: string; readonly length: number; readonly attachments: number; readonly tail: string }
/** The characters of a message kept for comparison; a rewrite of the same length still differs here. */
const TAIL = 24
const markOf = (message: AgentMessage): MessageMark =>
  ({ id: message.id, length: message.text.length, attachments: message.attachments?.length ?? 0, tail: message.text.slice(-TAIL) })

/**
 * One thread as `workspace.json` keeps it: no messages, and no summary either, because the summary
 * quotes them. Both are read back from the thread store, which is what the history switch governs.
 */
function organizationOnly(thread: AgentThread, keepActivities = false): AgentThread {
  const { summary, earlierAvailable, activities, monitoring, ...rest } = thread
  void summary; void earlierAvailable; void monitoring
  return { ...rest, messages: [], ...(keepActivities && activities ? { activities } : {}) }
}

const workspaceSchema = z.object({
  snapshot: agentHostSnapshotSchema,
  projectAliases: z.array(z.object({ providerProjectId: z.string(), projectId: z.string() })).default([]),
  creations: z.array(z.object({ threadId: z.string(), projectId: z.string(), commandId: z.string(), phase: z.enum(['unstarted', 'starting', 'retryable', 'started']) })),
})
type Workspace = z.infer<typeof workspaceSchema>

/** How long a burst of provider snapshots is gathered into one publish. The coordinator's own
 * broadcast window is the same 16 ms, so this costs a window rather than a visible delay. */
const PUBLISH_WINDOW_MS = 16
/** How long a provider-driven cache write waits for the state to settle. A user command never
 * waits this out: it writes through `flush()` and returns after its own write. */
const WRITE_WINDOW_MS = 250

/** Durable Sotto organization above the existing native identity/transport boundary.
 * Only an unstarted local thread can change provider. Native bindings are never rewritten. */
export class WorkspaceHost implements AgentHost {
  readonly concurrentProviders: boolean
  private state: Workspace = { snapshot: structuredClone(EMPTY_AGENT_HOST), creations: [], projectAliases: [] }
  private readonly store: AtomicJsonStore<Workspace>
  private loading: Promise<void> | undefined
  private ready = false
  private dirty = false
  private saving: Promise<void> | undefined
  /** Someone asked for the state to be on disk before they continue, so a write in flight is followed by another. */
  private flushWanted = false
  private saveError: string | undefined
  /** Only a successfully committed organization snapshot can suppress another write. */
  private savedOrganization: Workspace | undefined
  /** A failed activity migration keeps the legacy JSON payload recoverable this run. */
  private activityStoreUnavailable = false
  /** Once retention is disabled, the live timeline must never become a plaintext fallback. */
  private activityJsonFallbackAllowed = true
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  private publishTimer: ReturnType<typeof setTimeout> | undefined
  private publishPending = false
  private writeTimer: ReturnType<typeof setTimeout> | undefined
  private readonly lanes = new Map<string, Promise<unknown>>()
  /** In-flight working-copy setup per thread, so a send waits for it instead of starting a second one. */
  private readonly preparations = new Map<string, Promise<void>>()
  private readonly worktrees: ThreadWorktrees
  private checkpointHooks: { beforeTurn(threadId: string): Promise<void>; isBlocked(threadId: string): boolean | Promise<boolean> } | undefined
  /** One pending worktree re-read per thread, so a busy turn asks for a single read rather than one per record. */
  private readonly worktreeRefreshes = new Map<string, ReturnType<typeof setTimeout>>()
  /** A thread's own history: the log and the message projection every window reads (issue #119). */
  private readonly threadStore: ThreadStore
  /** True once opening the history database failed; this run then keeps its messages in memory alone. */
  private storeUnavailable = false
  /** What the store already holds for a thread, so a publish appends the difference rather than the history. */
  private readonly known = new Map<string, { epoch: string | undefined; messages: MessageMark[] }>()
  /** The threads a window is looking at, each with how many turns of its history it has been given. */
  private readonly watched = new Map<string, number>()
  /** False until a window has said what it is looking at. Until then no thread's history is put away. */
  private declared = false
  /** How many of a watched thread's messages sit before the window loaded into memory. */
  private readonly hidden = new Map<string, number>()
  /** True when the provider host says what changed rather than publishing a whole history to compare. */
  private readonly eventSourced: boolean
  /** Events waiting to be written, so a streamed reply costs one transaction per publish, not per word. */
  private readonly pendingEvents = new Map<string, ThreadEvent[]>()
  /** The threads whose window and summary the next publish has to read again. */
  private readonly eventChanged = new Set<string>()

  private workingCopyDefault: (projectId: string) => 'independent' | 'shared' = () => 'shared'
  private branchNameWriter: ((prompt: string) => Promise<string | null>) | undefined
  private readonly namingBranches = new Set<string>()
  setWorkingCopyDefaults(resolver: (projectId: string) => 'independent' | 'shared'): void { this.workingCopyDefault = resolver }
  setBranchNameWriter(writer: (prompt: string) => Promise<string | null>): void { this.branchNameWriter = writer }
  async workingCopyOptions(projectId: string): Promise<AgentWorkingCopyOptions> {
    await this.initialize()
    const project = this.state.snapshot.projects.find(item => item.id === projectId)
    if (!project) throw new Error('Choose an available project.')
    return this.worktrees.options(project.path)
  }
  private async selectedWorkingCopy(projectId: string, selection: AgentWorkingCopySelection): Promise<AgentWorktree> {
    const project = this.state.snapshot.projects.find(item => item.id === projectId)
    if (!project) throw new Error('Choose an available project.')
    if (selection.workingCopy === 'shared') return this.worktrees.inspect(await this.worktrees.allocate(project.path, 'shared'))
    return { mode: 'independent', status: 'pending', baseBranch: selection.baseBranch,
      startFromOrigin: selection.startFromOrigin, existingWorktreePath: selection.existingWorktreePath }
  }
  configureThreadWorkingCopy(threadId: string, selection: AgentWorkingCopySelection): Promise<AgentHostSnapshot> {
    return this.onLane(threadId, async () => {
      await this.initialize()
      const thread = this.thread(threadId)
      const creation = this.state.creations.find(item => item.threadId === threadId)
      if (thread.nativeSessionStarted !== false || creation?.phase !== 'unstarted' || thread.worktree?.mode === 'independent' && thread.worktree.path) {
        throw new Error('This thread already has a working folder. Start a new thread to choose another one.')
      }
      const previous = { worktree: thread.worktree, workingDirectory: thread.workingDirectory }
      const worktree = await this.selectedWorkingCopy(thread.projectId, selection)
      const current = this.thread(threadId)
      current.worktree = worktree
      current.workingDirectory = worktree.mode === 'shared' ? worktree.path : undefined
      this.dirty = true
      try { await this.flush() } catch (error) { Object.assign(this.thread(threadId), previous); throw error }
      this.publish()
      return this.workspaceSnapshot()
    })
  }
  /** Folder ownership includes legacy sessions and project subdirectories, not just stored worktree paths. */
  private async exclusivelyOwnsCheckout(threadId: string): Promise<boolean> {
    const thread = this.thread(threadId)
    const metadata = thread.worktree
    if (!metadata?.temporaryBranch || metadata.reused || !metadata.path) return false
    try {
      const identity = await this.worktrees.checkoutIdentity(metadata.path)
      const others = this.state.snapshot.threads.filter(other => other.id !== threadId)
      for (const other of others) {
        if (other.nativeSessionStarted === false && other.worktree?.mode === 'independent' && !other.worktree.path && !other.worktree.existingWorktreePath) continue
        const path = other.workingDirectory ?? other.worktree?.path ?? other.worktree?.existingWorktreePath
          ?? this.state.snapshot.projects.find(project => project.id === other.projectId)?.path
        if (!path || await this.worktrees.checkoutIdentity(path) === identity) return false
      }
      return true
    } catch { return false } // An unavailable folder makes exclusive ownership unprovable.
  }
  async renameTemporaryBranch(threadId: string, name: string): Promise<void> {
    return this.onLane(threadId, async () => {
      if (!await this.exclusivelyOwnsCheckout(threadId)) return
      const metadata = this.thread(threadId).worktree!
      const renamed = await this.worktrees.renameTemporaryBranch(metadata, name)
      this.thread(threadId).worktree = renamed
      this.dirty = true
      await this.flush()
      this.publish()
    })
  }
  private nameBranch(threadId: string, prompt: string): void {
    if (!this.branchNameWriter || this.namingBranches.has(threadId)) return
    this.namingBranches.add(threadId)
    const writer = this.branchNameWriter
    void this.exclusivelyOwnsCheckout(threadId).then(exclusive => exclusive && this.thread(threadId).worktree?.temporaryBranch ? writer(prompt) : null)
      .then(name => name ? this.renameTemporaryBranch(threadId, name) : undefined).catch(() => undefined)
  }
  private async discoverWorkingCopy(threadId: string): Promise<void> {
    const thread = this.thread(threadId)
    if (thread.worktree || thread.nativeSessionStarted === false) return
    const project = this.state.snapshot.projects.find(item => item.id === thread.projectId)
    const directory = thread.workingDirectory ?? project?.path
    if (!directory) throw new Error('This thread’s working folder is unavailable.')
    const metadata = await this.worktrees.discover(directory, project?.path ?? directory)
    const current = this.thread(threadId)
    if (current.worktree) return
    current.worktree = metadata
    this.dirty = true
    try { await this.flush() } catch { this.saveError = BRANCH_SAVE_ERROR }
    this.publish()
  }

  setCheckpointHooks(hooks: { beforeTurn(threadId: string): Promise<void>; isBlocked(threadId: string): boolean | Promise<boolean> }): void { this.checkpointHooks = hooks }
  rollbackCapability(threadId: string) { return this.inner.rollbackCapability?.(threadId) ?? { supported: false, reason: 'This provider does not expose verified conversation rewind.' } }
  rollbackThread(threadId: string, removedUserMessages: number, expectedUserMessageIds: readonly string[]): Promise<AgentHostResult> {
    return this.onLane(threadId, async () => {
      if (!this.inner.rollbackThread) throw new Error('Native conversation rewind is unavailable.')
      return this.inner.rollbackThread(threadId, removedUserMessages, expectedUserMessageIds)
    })
  }

  constructor(private readonly inner: AgentHost, private readonly directory: string, private readonly historyEnabled: () => boolean = () => true,
    private readonly worktreeRefreshDelayMs: number = WORKTREE_REFRESH_DELAY_MS) {
    this.concurrentProviders = inner.concurrentProviders === true
    this.worktrees = new ThreadWorktrees(directory)
    this.threadStore = new ThreadStore(join(directory, 'threads.sqlite'))
    this.store = new AtomicJsonStore(join(directory, 'workspace.json'), workspaceSchema.parse, () => this.state)
    inner.subscribe(snapshot => {
      if (!this.ready) return
      this.accept(snapshot)
      this.writeSoon()
      this.publishSoon()
    })
    // A host that says what changed is believed: its events are this thread's history, and the array
    // comparison below is left for a host that publishes whole histories and nothing else.
    this.eventSourced = typeof inner.subscribeEvents === 'function'
    inner.subscribeEvents?.(({ threadId, event }) => this.recordEvent(threadId, event))
  }

  initialize(): Promise<void> {
    this.loading ??= (async () => {
      // Native history is recoverable from the providers. Never create independent
      // private transcript backups, and remove this cache's abandoned write copies.
      const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      for (const name of names) if (/^workspace\.json\.(?:tmp|corrupt)-\d+-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(name)) {
        await unlink(join(this.directory, name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      }
      try { this.threadStore.open({ ephemeral: !this.historyEnabled() }) }
      catch { this.storeUnavailable = true; this.saveError = HISTORY_OPEN_ERROR }
      this.state = await this.store.peek()
      const snapshot = this.state.snapshot
      snapshot.connected = false
      snapshot.models.forEach(model => { model.ready = false })
      snapshot.providers?.forEach(provider => { provider.connection = 'disconnected'; delete provider.error })
      delete snapshot.error
      for (const thread of snapshot.threads) delete thread.monitoring
      if (!this.historyEnabled()) {
        this.activityJsonFallbackAllowed = false
        for (const thread of snapshot.threads) {
          if (!this.storeUnavailable) {
            try { this.threadStore.redactActivityIdentities(thread.id, (thread.activities ?? []).map(activity => activity.id)) }
            catch { this.activityStoreUnavailable = true; this.saveError = HISTORY_OPEN_ERROR }
          }
          thread.messages = []; thread.requests = []; delete thread.activities
        }
      }
      this.adoptSavedActivities(snapshot)
      // Cached running activity is evidence of an unfinished observation, not a live process.
      for (const thread of snapshot.threads) for (const activity of thread.activities ?? []) if (activity.status === 'running') activity.status = 'unknown'
      this.adoptSavedMessages(snapshot)
      if (!this.storeUnavailable) this.inner.useThreadHistory?.(this)
      await this.inner.initialize?.()
      // The store below is what a provider's own transcript would otherwise be re-read to rebuild.
      // Handing it back before the first connection is what lets an adapter resume where it stopped.
      // A host that publishes events asks the store itself, one thread at a time, rather than being
      // handed every thread's whole history before it has read anything.
      if (!this.eventSourced) await this.inner.restoreThreadHistory?.(this.storeUnavailable ? [] : snapshot.threads.flatMap(thread => {
        const messages = this.readWindow(thread.id)?.messages ?? []
        return messages.length ? [{ threadId: thread.id, messages, ...(thread.activities ? { activities: thread.activities.slice(-MAX_AGENT_ACTIVITIES) } : {}), ...(thread.historyEpoch ? { historyEpoch: thread.historyEpoch } : {}) }] : []
      }))
      this.ready = true
      await this.privacyChanged()
    })().catch(error => { this.loading = undefined; throw error })
    return this.loading
  }

  /**
   * The one-time move of every thread's messages out of `workspace.json` and into the store (issue #119).
   * `workspace.json` keeps organization from here on. A store that refuses the write leaves the file
   * exactly as it was, so the next start can try again with nothing lost.
   */
  private adoptSavedMessages(snapshot: AgentHostSnapshot): void {
    if (this.storeUnavailable) return
    const carrying = snapshot.threads.filter(thread => thread.messages.length)
    if (carrying.length) {
      try { for (const thread of carrying) this.threadStore.replaceThreadMessages(thread.id, thread.messages, thread.historyEpoch) }
      catch { this.saveError = HISTORY_SAVE_ERROR; return }
      this.dirty = true
    }
    // Nothing has said what it is looking at yet, so every thread starts with the window the store holds;
    // the first observation puts away the ones no pane wants. A host that publishes no events is compared
    // against its own arrays instead, and starts from its summary alone until one arrives.
    for (const thread of snapshot.threads) {
      if (this.eventSourced) { this.loadWindow(thread.id); continue }
      this.known.set(thread.id, { epoch: thread.historyEpoch, messages: this.readWindow(thread.id)?.messages.map(markOf) ?? [] })
      thread.messages = []
      delete thread.earlierAvailable
      thread.summary = this.threadSummary(thread)
    }
  }
  /** Import old JSON activity before removing it there; a committed store copy wins after an interrupted migration. */
  private adoptSavedActivities(snapshot: AgentHostSnapshot): void {
    if (this.storeUnavailable) { this.activityStoreUnavailable = true; return }
    try {
      for (const thread of snapshot.threads) {
        if (!this.threadStore.hasActivities(thread.id) && thread.activities !== undefined) {
          this.threadStore.syncActivities(thread.id, thread.activities, thread.historyEpoch)
        }
        if (this.threadStore.hasActivities(thread.id)) {
          const epoch = this.threadStore.readActivityEpoch(thread.id)
          // SQLite commits before organization JSON. Do not relabel stale legacy messages
          // or revive activity from the old generation after an interrupted JSON save.
          if (thread.historyEpoch !== epoch) thread.messages = []
          if (epoch === undefined) delete thread.historyEpoch
          else thread.historyEpoch = epoch
          thread.activities = this.threadStore.readActivities(thread.id)
        }
      }
    } catch {
      this.activityStoreUnavailable = true
      this.saveError = 'Thread activity could not be saved. Saved activity remains available. Restore local storage and restart Sotto.'
    }
  }
  private saveActivities(): void {
    if (this.storeUnavailable || this.activityStoreUnavailable) return
    for (const thread of this.state.snapshot.threads) {
      if (thread.activities !== undefined) this.threadStore.syncActivities(thread.id, thread.activities, thread.historyEpoch)
    }
  }
  /** One window of a thread's messages, or nothing when the store cannot answer. */
  private readWindow(threadId: string, turns?: number) {
    if (this.storeUnavailable) return undefined
    this.writeEvents()
    try { return this.threadStore.readMessages(threadId, turns === undefined ? {} : { turns }) }
    catch { this.saveError = HISTORY_SAVE_ERROR; return undefined }
  }
  /**
   * The sidebar's facts about a thread. With the history in hand they come from it; without it they come
   * from the store's projection, with the activity counted from the records the thread still carries.
   */
  private threadSummary(thread: AgentThread, messages?: readonly AgentMessage[]): AgentThreadSummary {
    const beside = summarizeThread({ messages: [], activities: thread.activities })
    if (messages !== undefined) return summarizeThread({ messages: [...messages], activities: thread.activities })
    if (this.storeUnavailable) return beside
    this.writeEvents()
    try { return { ...this.threadStore.summary(thread.id), activityCount: beside.activityCount,
      ...(beside.runningTurnStartedAt === undefined ? {} : { runningTurnStartedAt: beside.runningTurnStartedAt }) } }
    catch { return beside }
  }
  /**
   * What changed between the history the store holds for a thread and the one its provider just published.
   * A message that grew is an append, an id that is new is an addition, anything else about a known message
   * is a replacement, and a history that no longer starts the same way — a rewind, a compaction — is a reset.
   */
  private differences(threadId: string, messages: readonly AgentMessage[], epoch: string | undefined, previousEpoch: string | undefined): ThreadEvent[] {
    const at = new Date().toISOString()
    const added = (message: AgentMessage): ThreadEvent => ({ kind: 'message-added', at: message.createdAt || at, message })
    const reset = (): ThreadEvent[] => [{ kind: 'messages-reset', at, ...(epoch === undefined ? {} : { historyEpoch: epoch }) }, ...messages.map(added)]
    let known = this.known.get(threadId)
    if (known === undefined) {
      known = { epoch: previousEpoch, messages: this.readWindow(threadId)?.messages.map(markOf) ?? [] }
      this.known.set(threadId, known)
    }
    if (known.epoch !== epoch) return reset()
    if (messages.length < known.messages.length) return reset()
    const events: ThreadEvent[] = []
    for (const [index, message] of messages.entries()) {
      const mark = known.messages[index]
      if (mark === undefined) { events.push(added(message)); continue }
      if (mark.id !== message.id) return reset()
      const attachments = message.attachments?.length ?? 0
      if (mark.length === message.text.length && mark.attachments === attachments && mark.tail === message.text.slice(-TAIL)) continue
      // A true append leaves the characters the store already holds exactly where they were.
      if (message.text.length > mark.length && mark.attachments === attachments
        && message.text.slice(Math.max(0, mark.length - TAIL), mark.length) === mark.tail) {
        events.push({ kind: 'message-text-appended', at, messageId: message.id, appendText: message.text.slice(mark.length) })
      } else events.push({ kind: 'message-replaced', at, message })
    }
    return events
  }
  /**
   * One change a provider host reported. Events are the record from an adapter that publishes them, so
   * they are written whole and in order; the window a pane holds and the sidebar's facts are read again
   * at the next publish rather than per event, which keeps a streamed reply at one publish per window.
   */
  private recordEvent(threadId: string, event: ThreadEvent): void {
    const waiting = this.pendingEvents.get(threadId)
    if (waiting) waiting.push(event)
    else this.pendingEvents.set(threadId, [event])
    this.eventChanged.add(threadId)
    if (this.ready) this.publishSoon()
  }
  /** Write what the events said. Called before anything reads the store, and at every publish. */
  private writeEvents(): void {
    if (this.pendingEvents.size === 0 || !this.ready || this.storeUnavailable) return
    const waiting = [...this.pendingEvents]
    this.pendingEvents.clear()
    for (const [threadId, events] of waiting) {
      try { this.threadStore.appendMany(threadId, events) }
      catch { this.saveError = HISTORY_SAVE_ERROR }
      // The store, not the published array, is now what this thread's history is compared against.
      this.known.delete(threadId)
      if (events.some(event => event.kind === 'messages-reset')) this.hidden.delete(threadId)
    }
    this.dirty = true
  }
  /** Give every thread an event touched its window again, and its summary from the projection. */
  private applyEvents(): void {
    this.writeEvents()
    if (this.eventChanged.size === 0) return
    const changed = [...this.eventChanged]
    this.eventChanged.clear()
    for (const id of changed) {
      const thread = this.state.snapshot.threads.find(item => item.id === id)
      if (!thread) continue
      if (this.watched.has(id) || !this.declared) this.loadWindow(id)
      else { thread.messages = []; delete thread.earlierAvailable; thread.summary = this.threadSummary(thread) }
    }
  }
  /** Every message the store holds for a thread, for an adapter about to read its provider's history. */
  messageIdentities(threadId: string): readonly StoredMessageIdentity[] {
    if (this.storeUnavailable) return []
    this.writeEvents()
    try { return this.threadStore.messageIdentities(threadId) }
    catch { return [] }
  }
  /** Historical classification only; live monitoring is never handed back to an adapter. */
  activities(threadId: string, historyEpoch?: string): readonly AgentActivity[] | undefined {
    const thread = this.state.snapshot.threads.find(item => item.id === threadId)
    if (!thread?.activities || thread.historyEpoch !== historyEpoch) return undefined
    return structuredClone(thread.activities.slice(-MAX_AGENT_ACTIVITIES))
  }
  /**
   * Records what a provider published and answers with the messages this thread keeps in memory: the
   * loaded window while a pane is looking at it, nothing at all while none is.
   */
  private record(thread: AgentThread, messages: readonly AgentMessage[], previousEpoch: string | undefined): AgentMessage[] {
    if (this.storeUnavailable) return [...messages]
    const events = this.differences(thread.id, messages, thread.historyEpoch, previousEpoch)
    if (events.length) {
      try { this.threadStore.appendMany(thread.id, events) }
      catch { this.saveError = HISTORY_SAVE_ERROR; return [...messages] }
      if (events[0]?.kind === 'messages-reset') this.hidden.delete(thread.id)
      this.known.set(thread.id, { epoch: thread.historyEpoch, messages: messages.map(markOf) })
    }
    if (!this.watched.has(thread.id)) return this.declared ? [] : [...messages]
    const hidden = Math.min(this.hidden.get(thread.id) ?? 0, messages.length)
    if (hidden > 0) thread.earlierAvailable = true
    return hidden > 0 ? messages.slice(hidden) : [...messages]
  }
  /** Puts this thread's current window into memory: what the pane draws, and how much sits before it. */
  private loadWindow(threadId: string): void {
    const thread = this.state.snapshot.threads.find(item => item.id === threadId)
    if (!thread) return
    const window = this.readWindow(threadId, this.watched.get(threadId) ?? FIRST_WINDOW_TURNS)
    if (!window) return
    this.hidden.set(threadId, Math.max(0, window.firstPosition))
    thread.messages = window.messages
    if (window.earlierAvailable) thread.earlierAvailable = true
    else delete thread.earlierAvailable
    thread.summary = this.threadSummary(thread, window.earlierAvailable ? undefined : window.messages)
  }
  /** A thread no pane is looking at goes back to its summary alone. */
  private unloadWindow(threadId: string): void {
    const thread = this.state.snapshot.threads.find(item => item.id === threadId)
    if (!thread) return
    thread.summary = this.threadSummary(thread, thread.earlierAvailable ? undefined : thread.messages)
    thread.messages = []
    delete thread.earlierAvailable
  }
  /**
   * Widens the pane's window by another twenty turns, because the user pressed Show earlier messages.
   * The store holds the whole history; only how much of it is in memory changes here.
   */
  async loadEarlierMessages(threadId: string): Promise<AgentHostSnapshot> {
    await this.initialize()
    this.watched.set(threadId, (this.watched.get(threadId) ?? FIRST_WINDOW_TURNS) + LATER_WINDOW_TURNS)
    this.loadWindow(threadId)
    this.publish()
    return this.workspaceSnapshot()
  }
  /** One thread's whole history, whatever window is loaded: the store is the record, not the pane. */
  threadMessages(threadId: string): readonly AgentMessage[] {
    this.writeEvents()
    const thread = this.state.snapshot.threads.find(item => item.id === threadId)
    if (this.storeUnavailable) return thread?.messages ?? []
    if (thread && thread.messages.length > 0 && !thread.earlierAvailable) return thread.messages
    return this.readWindow(threadId)?.messages ?? thread?.messages ?? []
  }
  /**
   * Records that a request was answered, and by which client, in the thread's own log (ADR-0016). The
   * answer's words are never written: an answer can read like a prompt, and the log says what happened
   * rather than what was said. Nothing is projected from it, so a failed write costs the record alone.
   */
  recordAnswer(threadId: string, event: AnswerGivenEvent): void {
    if (this.storeUnavailable) return
    try { this.threadStore.append(threadId, event) }
    catch { this.saveError = HISTORY_SAVE_ERROR }
  }
  /** What a client reads to catch up: every thread event after `seq`, with anything still buffered written first (ADR-0016). */
  eventsAfter(seq: number, threadId?: string): StoredThreadEvent[] {
    if (this.storeUnavailable) return []
    this.writeEvents()
    return this.threadStore.eventsAfter(seq, threadId)
  }
  /** Closes the history store. Called when the app quits, after the last flush. */
  dispose(): void {
    clearTimeout(this.publishTimer); clearTimeout(this.writeTimer)
    for (const timer of this.worktreeRefreshes.values()) clearTimeout(timer)
    this.worktreeRefreshes.clear()
    try { this.writeEvents(); this.saveActivities() }
    catch { this.saveError = 'Thread activity could not be saved. Restore local storage and restart Sotto.' }
    finally { this.threadStore.close() }
  }

  async listThreadSkills(threadId: string, forceReload = false) {
    await this.initialize()
    const thread = this.state.snapshot.threads.find(thread => thread.id === threadId)
    if (!thread || !this.inner.listThreadSkills) throw new Error('Skills are unavailable for this thread.')
    const workingDirectory = thread.nativeSessionStarted === false && thread.worktree?.status === 'pending' && !thread.worktree.path
      ? await existingWorkingDirectory(this.state.snapshot.projects.find(item => item.id === thread.projectId)!.path)
      : await this.threadWorkingDirectory(threadId)
    const creation = this.state.creations.find(item => item.threadId === threadId)
    if (creation && (creation.phase === 'unstarted' || creation.phase === 'retryable')) {
      const project = this.state.snapshot.projects.find(project => project.id === thread.projectId)
      if (!project || !thread.providerId) throw new Error('This thread has no available working folder.')
      return this.inner.listThreadSkills(threadId, forceReload, { providerId: thread.providerId, workingDirectory })
    }
    return this.inner.listThreadSkills(threadId, forceReload)
  }
  workspaceSnapshot(): AgentHostSnapshot {
    this.applyEvents()
    const snapshot = cloneHostSnapshot(this.state.snapshot)
    if (this.saveError) snapshot.error = this.saveError
    return snapshot
  }
  private publish(): void { for (const listener of this.listeners) listener(this.workspaceSnapshot()) }
  /**
   * A publish the providers asked for. The first of a burst goes out at once, so a reply appearing
   * still feels immediate, and everything inside the window behind it becomes one publish at its
   * end with the last state. No adapter can make the host copy the workspace per event.
   */
  private publishSoon(): void {
    if (this.publishTimer) { this.publishPending = true; return }
    this.publish()
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined
      if (this.publishPending) { this.publishPending = false; this.publishSoon() }
    }, PUBLISH_WINDOW_MS)
    this.publishTimer.unref?.()
  }
  /** A cache write the providers asked for: never more than one waiting, and the state it finds
   * when it runs is the one that is written. */
  private writeSoon(): void {
    if (this.writeTimer) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined
      void this.flush().catch(() => { this.saveError = 'Workspace history could not be saved. Restore access to local storage and refresh.'; this.publish() })
    }, WRITE_WINDOW_MS)
    this.writeTimer.unref?.()
  }
  private accept(snapshot: AgentHostSnapshot): void {
    const previous = this.state.snapshot
    const projects = new Map(previous.projects.map(project => [project.id, project]))
    for (const project of snapshot.projects) {
      // Hide only registrations introduced for our pending creation, never merge
      // pre-existing project scopes just because they happen to share a folder.
      if (!projects.has(project.id) && !this.state.projectAliases.some(alias => alias.providerProjectId === project.id)) {
        const creation = this.state.creations.find(item => item.phase === 'starting'
          && previous.threads.find(thread => thread.id === item.threadId)?.providerId === project.providerId
          && previous.projects.some(source => source.id === item.projectId && source.path === project.path && source.id !== project.id))
        if (creation) this.state.projectAliases.push({ providerProjectId: project.id, projectId: creation.projectId })
      }
      if (!this.state.projectAliases.some(alias => alias.providerProjectId === project.id)) projects.set(project.id, { ...project, workspaceSettledAt: projects.get(project.id)?.workspaceSettledAt ?? null })
    }
    const threads = new Map(previous.threads.map(thread => [thread.id, { ...thread, monitoring: undefined } as AgentThread]))
    for (const thread of snapshot.threads) {
      const old = threads.get(thread.id)
      const creation = this.state.creations.find(item => item.threadId === thread.id)
      if (creation) creation.phase = 'started'
      // A new provider registration may have a different project ID. The original Sotto
      // project remains the workspace/memory scope for a thread created beneath it.
      const merged: AgentThread = { ...thread,
        // A name the user set by hand, or one Sotto wrote for this thread, outranks whatever the provider still calls it.
        ...(old?.titleSource === 'user' || old?.titleSource === 'generated' ? { title: old.title, titleSource: old.titleSource } : {}),
        ...(old?.worktree ? { worktree: old.worktree, workingDirectory: old.workingDirectory } : {}),
        messages: [],
        ...(old?.activities || thread.activities ? { activities: old?.historyEpoch !== thread.historyEpoch ? thread.activities ?? [] : mergeAgentActivities(old?.activities, thread.activities) } : {}),
        projectId: creation?.projectId ?? old?.projectId ?? this.state.projectAliases.find(alias => alias.providerProjectId === thread.projectId)?.projectId ?? thread.projectId,
        workspaceSettledAt: old?.workspaceSettledAt ?? null, nativeSessionStarted: true }
      // A provider that is still loading a thread's history has published no history yet, so the
      // store keeps what it already holds and the pane keeps the window it was given.
      if (this.eventSourced) {
        // The events already said what this thread's history is. What the snapshot carries beside them
        // is the window this host loaded, which only an event or an observation changes.
        merged.messages = old?.messages ?? []
        if (old?.earlierAvailable) merged.earlierAvailable = true
        merged.summary = old?.summary ?? this.threadSummary(merged)
        if (!old) this.eventChanged.add(thread.id)
      } else if ((thread.historyStatus === 'loading' || thread.historyStatus === 'error') && !thread.messages.length) {
        merged.messages = old?.messages ?? []
        merged.summary = old?.summary ?? this.threadSummary(merged)
      } else {
        merged.messages = this.record(merged, thread.messages, old?.historyEpoch)
        merged.summary = this.threadSummary(merged, this.storeUnavailable ? merged.messages : thread.messages)
      }
      threads.set(thread.id, merged)
    }
    const models = new Map(previous.models.map(model => [model.id, { ...model, ready: false }]))
    for (const model of snapshot.models) models.set(model.id, model)
    this.state.snapshot = { ...snapshot, models: [...models.values()], projects: [...projects.values()], threads: [...threads.values()] }
    for (const thread of this.state.snapshot.threads) if (!isThreadProviderConnected(snapshot, thread)) delete thread.monitoring
    // An agent that switched branches mid-turn moved HEAD without a send, so finished work asks for a re-read.
    for (const thread of this.state.snapshot.threads) {
      const old = previous.threads.find(item => item.id === thread.id)
      if (!old) continue
      const before = settledHeadMovers(old.activities)
      if (old.status === 'running' && thread.status !== 'running'
        || [...settledHeadMovers(thread.activities)].some(id => !before.has(id))) this.scheduleWorktreeRefresh(thread.id)
    }
    this.dirty = true
  }
  /** Queues one trailing re-read of this thread's worktree; a burst of records still reads the folder once. */
  private scheduleWorktreeRefresh(threadId: string): void {
    const thread = this.state.snapshot.threads.find(thread => thread.id === threadId)
    if (!thread || thread.nativeSessionStarted === false || thread.worktree && thread.worktree.status !== 'ready' || this.worktreeRefreshes.has(threadId)) return
    const timer = setTimeout(() => { this.worktreeRefreshes.delete(threadId); void this.refreshWorktreeRecord(threadId) }, this.worktreeRefreshDelayMs)
    timer.unref?.()
    this.worktreeRefreshes.set(threadId, timer)
  }
  /** Reads the folder on the thread's own lane and publishes only a record that actually changed.
   * A folder problem found here is left for the next send to report: a background read refuses nothing. */
  private refreshWorktreeRecord(threadId: string): Promise<void> {
    return this.onLane(threadId, async () => {
      try { await this.discoverWorkingCopy(threadId) } catch { return }
      const worktree = this.state.snapshot.threads.find(thread => thread.id === threadId)?.worktree
      if (!worktree || worktree.status !== 'ready') return
      let inspected: AgentWorktree
      try { inspected = await this.worktrees.inspect(worktree) } catch { return }
      const current = this.state.snapshot.threads.find(thread => thread.id === threadId)
      if (current?.worktree?.status !== 'ready') return
      if (inspected.branch === current.worktree.branch && inspected.dirty === current.worktree.dirty) return
      current.worktree = { ...inspected, ...(current.worktree.sentBranch !== undefined ? { sentBranch: current.worktree.sentBranch } : {}) }
      this.dirty = true
      try { await this.flush() } catch { this.saveError = BRANCH_SAVE_ERROR }
      this.publish()
    })
  }
  /** Runs `work` after whatever this thread's lane already holds, so a folder read never races a command on it. */
  private onLane<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const pending = (this.lanes.get(threadId) ?? Promise.resolve()).catch(() => undefined).then(work)
    this.lanes.set(threadId, pending)
    void pending.finally(() => { if (this.lanes.get(threadId) === pending) this.lanes.delete(threadId) }).catch(() => undefined)
    return pending
  }
  private flush(): Promise<void> {
    this.writeEvents()
    // This write covers whatever a waiting one would have written, so it takes its place.
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = undefined }
    this.flushWanted = true
    if (this.saving) return this.saving
    this.saving = Promise.resolve().then(async () => {
      try {
        // A state dirtied again while a write was in flight is written again only for a caller who asked; a
        // provider that kept publishing during a slow write waits for the window like any other burst, so a
        // slow disk cannot turn one flush into a run of back-to-back writes.
        while (this.dirty && this.flushWanted) {
          this.flushWanted = false
          this.dirty = false
          // Messages live in the thread store, never here: `workspace.json` keeps organization alone,
          // so what it costs to write follows the number of threads rather than what they said (#119).
          try { this.saveActivities() }
          catch (error) { this.dirty = true; throw error }
          const saved = structuredClone({ ...this.state,
            snapshot: { ...this.state.snapshot, threads: this.state.snapshot.threads.map(thread => organizationOnly(thread, this.activityJsonFallbackAllowed && (this.storeUnavailable || this.activityStoreUnavailable))) } })
          if (!this.historyEnabled()) for (const thread of saved.snapshot.threads) {
            thread.requests = []
            delete thread.activities
            if (thread.nativeSessionStarted) {
              thread.historyStatus = 'loading'
              delete thread.historyError
            }
          }
          try {
            if (!isDeepStrictEqual(this.savedOrganization, saved)) {
              await this.store.write(saved)
              this.savedOrganization = saved
            }
            if (!this.activityStoreUnavailable) this.saveError = undefined
          }
          catch (error) { this.dirty = true; throw error }
        }
        if (this.dirty) this.writeSoon()
      } finally { this.saving = undefined }
    })
    return this.saving
  }
  /**
   * Keep local history changed. Turning it off takes the words out of `threads.sqlite` and moves this run
   * into memory, so the state on screen stays right while nothing said reaches the file again; turning it
   * back on hands the file over from here, and what was not kept is gone.
   */
  async privacyChanged(): Promise<void> {
    if (!this.historyEnabled()) this.activityJsonFallbackAllowed = false
    if (!this.storeUnavailable) {
      const wanted = this.historyEnabled()
      if (wanted === this.threadStore.ephemeral) {
        try {
          if (wanted) {
            this.saveActivities()
            this.threadStore.becomeDurable()
          } else {
            // Identity suppression needs no output validation. Even if it fails, erase the durable text.
            try {
              for (const thread of this.state.snapshot.threads) this.threadStore.redactActivityIdentities(thread.id, (thread.activities ?? []).map(activity => activity.id))
            } finally { this.threadStore.becomeEphemeral() }
          }
        } catch { this.storeUnavailable = true; this.saveError = HISTORY_OPEN_ERROR }
        // The switch emptied the store either way, so what mirrored it is no longer true.
        this.known.clear()
        this.hidden.clear()
        for (const thread of this.state.snapshot.threads) delete thread.earlierAvailable
      }
    }
    this.dirty = true
    await this.flush()
  }
  async connect(provider?: ProviderId): Promise<AgentHostSnapshot> {
    await this.initialize(); this.accept(await this.inner.connect(provider)); await this.flush(); return this.workspaceSnapshot()
  }
  async snapshot(provider?: ProviderId): Promise<AgentHostSnapshot> {
    await this.initialize(); this.accept(await this.inner.snapshot(provider)); await this.flush(); return this.workspaceSnapshot()
  }
  async refreshThread(threadId: string): Promise<AgentHostSnapshot> {
    await this.initialize()
    const thread = this.thread(threadId)
    if (thread.nativeSessionStarted === false || !isThreadProviderConnected(this.state.snapshot, thread)) return this.workspaceSnapshot()
    const creation = this.state.creations.find(item => item.threadId === threadId)
    this.accept(await (creation && creation.phase !== 'started' ? this.inner.snapshot(thread.providerId)
      : this.inner.refreshThread?.(threadId) ?? this.inner.snapshot(thread.providerId)))
    await this.flush(); this.publish(); return this.workspaceSnapshot()
  }
  async setWorkspaceSettled(kind: 'project' | 'thread', id: string, settled: boolean): Promise<AgentHostSnapshot> {
    await this.initialize()
    const entity = (kind === 'project' ? this.state.snapshot.projects : this.state.snapshot.threads).find(item => item.id === id)
    if (!entity) throw new Error(`That ${kind} is unavailable.`)
    const previous = entity.workspaceSettledAt ?? null
    entity.workspaceSettledAt = settled ? previous ?? new Date().toISOString() : null
    this.dirty = true
    try { await this.flush() }
    catch (error) {
      const current = (kind === 'project' ? this.state.snapshot.projects : this.state.snapshot.threads).find(item => item.id === id)
      if (current) current.workspaceSettledAt = previous
      throw error
    }
    this.publish(); return this.workspaceSnapshot()
  }
  /**
   * The thread's new name, kept in Sotto's own workspace: the provider is never told, and its own
   * title stops overwriting this one. A blank name is the caller's to refuse before it gets here.
   */
  async renameThread(threadId: string, title: string, source: 'user' | 'generated' = 'user'): Promise<AgentHostSnapshot> {
    await this.initialize()
    const thread = this.thread(threadId)
    const previous = { title: thread.title, titleSource: thread.titleSource }
    thread.title = title
    thread.titleSource = source
    this.dirty = true
    try { await this.flush() }
    catch (error) { Object.assign(this.thread(threadId), previous); throw error }
    this.publish(); return this.workspaceSnapshot()
  }
  private thread(id: string): AgentThread {
    const thread = this.state.snapshot.threads.find(thread => thread.id === id)
    if (!thread) throw new Error('This thread is not known to Sotto. Refresh and select it again.')
    return thread
  }
  /** Starts working-copy setup, or returns the setup already running for this thread.
   * The checkout runs after `create-thread` has returned, so the pane appears at once; the
   * promise is also this thread's lane, so every later command queues behind it. */
  private startWorkingCopy(thread: AgentThread): Promise<void> {
    const existing = this.preparations.get(thread.id)
    if (existing) return existing
    const pending = this.prepareWorkingCopy(thread).catch(() => {
      this.saveError = 'Working-copy setup could not be saved. Restore local storage and retry setup.'
      this.publish()
    })
    this.preparations.set(thread.id, pending)
    void pending.finally(() => {
      if (this.preparations.get(thread.id) === pending) this.preparations.delete(thread.id)
    }).catch(() => undefined)
    return pending
  }
  private async prepareWorkingCopy(thread: AgentThread): Promise<void> {
    if (!thread.worktree) return // Existing threads keep their native directory.
    // Native events can replace the thread object while Git is pending; always write the current one.
    const current = (): AgentThread => this.state.snapshot.threads.find(item => item.id === thread.id) ?? thread
    try {
      let metadata = current().worktree ?? thread.worktree
      if (!metadata.path) {
        const project = this.state.snapshot.projects.find(project => project.id === thread.projectId)
        if (!project) throw new Error('The original project is unavailable.')
        metadata = await this.worktrees.allocate(project.path, metadata.mode, { baseBranch: metadata.baseBranch, startFromOrigin: metadata.startFromOrigin, existingWorktreePath: metadata.existingWorktreePath })
        current().worktree = metadata
        this.dirty = true
        await this.flush() // Allocation owns its exact path/branch before Git mutates anything.
      }
      metadata = await this.worktrees.ensure(metadata)
      const workingDirectory = await this.worktrees.workingDirectory(metadata)
      const target = current()
      target.worktree = metadata
      target.workingDirectory = workingDirectory
    } catch (error) {
      const target = current()
      target.worktree = { ...(target.worktree ?? thread.worktree), status: 'error', error: error instanceof Error ? error.message : 'Working-copy setup failed. Retry after restoring the folder and Git.' }
    }
    this.dirty = true; await this.flush(); this.publish()
  }
  async updateThreadWorktree(threadId: string, retry: boolean): Promise<AgentHostSnapshot> {
    return this.onLane(threadId, async () => {
      await this.initialize()
      await this.discoverWorkingCopy(threadId)
      const thread = this.thread(threadId)
      if (retry && thread.nativeSessionStarted === false && thread.worktree?.status === 'error') await this.prepareWorkingCopy(thread)
      else if (thread.worktree?.path) {
        // Native events can replace the thread object while Git is pending.
        let metadata = thread.worktree
        // A folder that was deleted is put back before it is read, so a refresh never turns a missing
        // folder into an error that the next send would then refuse to repair (ADR-0014).
        try { metadata = await this.worktrees.inspect(await this.worktrees.restore(metadata)) }
        catch (error) { metadata = { ...metadata, status: 'error', error: error instanceof Error ? error.message : 'The working folder is unavailable.' } }
        this.thread(threadId).worktree = metadata
        this.dirty = true; await this.flush(); this.publish()
      }
      return this.workspaceSnapshot()
    })
  }
  /**
   * Switches this thread's worktree back to the branch of its last send, because the user pressed Restore
   * branch. `withUncommittedChanges` is their answer to the confirmation; without it a worktree with
   * uncommitted work is left exactly as it is.
   */
  async restoreThreadBranch(threadId: string, withUncommittedChanges: boolean): Promise<AgentHostSnapshot> {
    return this.onLane(threadId, async () => {
      await this.initialize()
      const worktree = this.thread(threadId).worktree
      if (worktree?.mode !== 'shared' || worktree.status !== 'ready') throw new Error('This thread has no project checkout to switch.')
      const target = worktree.sentBranch
      if (!target) throw new Error('Sotto has not sent to this thread yet, so there is no earlier branch to restore.')
      const inspected = await this.worktrees.inspect(worktree)
      if (inspected.dirty && !withUncommittedChanges && inspected.branch !== target) {
        this.thread(threadId).worktree = { ...inspected, sentBranch: target }
        this.dirty = true; await this.flush().catch(() => undefined); this.publish()
        throw new Error(RESTORE_BRANCH_NEEDS_CONFIRMATION)
      }
      this.thread(threadId).worktree = { ...(await this.worktrees.switchBranch(inspected, target)), sentBranch: target }
      this.dirty = true
      try { await this.flush() } catch { this.saveError = BRANCH_SAVE_ERROR }
      this.publish()
      return this.workspaceSnapshot()
    })
  }
  /** The branch this thread's work went to, so the pane can say what changed under it afterwards. */
  private async recordSentBranch(threadId: string): Promise<void> {
    const worktree = this.thread(threadId).worktree
    if (!worktree || worktree.status !== 'ready' || worktree.sentBranch === worktree.branch) return
    worktree.sentBranch = worktree.branch
    this.dirty = true
    // The prompt is about to go out; a cache write that fails must not refuse the send.
    try { await this.flush() } catch { this.saveError = BRANCH_SAVE_ERROR }
    this.publish()
  }
  async threadWorkingDirectory(threadId: string): Promise<string> {
    await this.initialize()
    await this.preparations.get(threadId) // A folder question asked during setup waits for its answer.
    await this.discoverWorkingCopy(threadId)
    const thread = this.thread(threadId)
    const worktree = thread.worktree
    if (worktree?.path && (worktree.status === 'ready' || worktree.status === 'error')) {
      // A folder that was deleted is put back on its recorded branch before the turn (ADR-0014). A record
      // an earlier read marked as an error gets the same chance; when it cannot be put back, the error it
      // already carries is the one reported below.
      let inspected: AgentWorktree | undefined
      try { inspected = await this.worktrees.inspect(await this.worktrees.restore(worktree)) }
      catch (error) { if (worktree.status === 'ready') throw error }
      // A branch switched inside the worktree is adopted, so the pane's label follows it (ADR-0014).
      // A newer working-copy choice or refresh wins; provider snapshots preserve the worktree object.
      if (inspected && this.thread(threadId).worktree === worktree) {
        // Setup can fail after Git creates the checkout but before its verified folder is recorded.
        const workingDirectory = this.thread(threadId).workingDirectory ?? await this.worktrees.workingDirectory(inspected)
        const current = this.thread(threadId)
        if (current.worktree === worktree && (inspected.branch !== worktree.branch || worktree.status !== 'ready' || current.workingDirectory === undefined)) {
          current.worktree = inspected; current.workingDirectory ??= workingDirectory; this.dirty = true
          // The folder was just verified; a cache write that fails must not refuse the send.
          try { await this.flush() } catch { this.saveError = BRANCH_SAVE_ERROR }
          this.publish()
        }
      }
    }
    const current = this.thread(threadId)
    return existingWorkingDirectory(resolveThreadWorkingDirectory(current, this.state.snapshot.projects.find(project => project.id === current.projectId)))
  }
  execute(command: AgentHostCommand): Promise<AgentHostResult> {
    const key = 'threadId' in command ? command.threadId : command.projectId
    const pending = (this.lanes.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => this.executeOne(command))
    this.lanes.set(key, pending)
    void pending.finally(() => { if (this.lanes.get(key) === pending) this.lanes.delete(key) }).catch(() => undefined)
    return pending
  }
  private async executeOne(command: AgentHostCommand): Promise<AgentHostResult> {
    await this.initialize()
    let preparedSkills: AgentSkillReference[] | undefined
    let firstSend = false
    if ('threadId' in command && command.type !== 'create-thread' && command.type !== 'interrupt' && await this.checkpointHooks?.isBlocked(command.threadId)) throw new Error('Wait for Git changes or resolve the interrupted checkpoint revert before changing this thread.')
    if ((command.type === 'send' || command.type === 'steer') && command.skills?.length) {
      const thread = this.thread(command.threadId)
      const capabilities = this.state.snapshot.providers?.find(provider => provider.id === thread.providerId)?.capabilities ?? this.state.snapshot.capabilities
      if (!capabilities.skills || !this.inner.listThreadSkills) throw new Error('Selected skills are unavailable or belong to another provider. Refresh this draft’s skill catalog.')
      const catalog = await this.listThreadSkills(command.threadId, true)
      if (thread.nativeSessionStarted === false && thread.worktree?.path && thread.workingDirectory) {
        const projectPath = await existingWorkingDirectory(this.state.snapshot.projects.find(item => item.id === thread.projectId)!.path)
        preparedSkills = command.skills.map(selected => {
          const local = relative(projectPath, selected.path)
          return { ...selected, path: !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) ? join(thread.workingDirectory!, local) : selected.path }
        })
      }
      if (catalog.status !== 'ready' || catalog.providerId !== thread.providerId || (preparedSkills ?? command.skills).some(selected => !catalog.skills.some(skill => skill.name === selected.name && skill.path === selected.path && skill.enabled !== false && skill.userInvocable !== false))) {
        throw new Error('Selected skills are unavailable or belong to another provider. Refresh this draft’s skill catalog.')
      }
    }
    if (command.type === 'create-project') {
      const result = await this.inner.execute(command)
      // The existing coordinator reconciles creation; a cache failure cannot change
      // an acknowledged/uncertain native result into a definitive rejection.
      try { this.accept(await this.inner.snapshot(command.provider)); await this.flush() }
      catch { this.saveError = 'Refresh to confirm the project and save workspace history.' }
      return result
    }
    if (command.type === 'create-thread') {
      if (this.state.snapshot.threads.some(thread => thread.id === command.threadId)) throw new Error('This thread already exists. Select it instead of creating it again.')
      if (!this.state.snapshot.projects.some(project => project.id === command.projectId)) throw new Error('Choose an available project.')
      validateThreadOptions(this.state.snapshot, command)
      const model = this.state.snapshot.models.find(model => model.id === command.modelId)!
      this.requireCreation(model.providerId)
      const thread: AgentThread = { id: command.threadId, projectId: command.projectId, title: command.title, modelId: command.modelId,
        titleSource: command.titleSource ?? 'default',
        ...(model.providerId ? { providerId: model.providerId } : {}),
        ...(command.reasoningEffort ?? model.defaultReasoningEffort ? { reasoningEffort: command.reasoningEffort ?? model.defaultReasoningEffort! } : {}),
        ...(command.runtimeMode ? { runtimeMode: command.runtimeMode } : {}),
        worktree: await this.selectedWorkingCopy(command.projectId, { ...command, workingCopy: command.workingCopy ?? this.workingCopyDefault(command.projectId) }),
        status: 'idle', messages: [], requests: [], workspaceSettledAt: null, nativeSessionStarted: false }
      if (thread.worktree?.mode === 'shared') thread.workingDirectory = thread.worktree.path
      this.state.snapshot.threads.push(thread)
      this.state.creations.push({ threadId: thread.id, projectId: thread.projectId, commandId: randomUUID(), phase: 'unstarted' })
      this.dirty = true
      try { await this.flush() }
      catch (error) {
        this.state.snapshot.threads = this.state.snapshot.threads.filter(item => item.id !== thread.id)
        this.state.creations = this.state.creations.filter(item => item.threadId !== thread.id)
        throw error
      }
      this.publish()
      // Opening a thread never allocates a worktree. Its choice remains editable until first send.
      return { accepted: true }
    }
    let thread = this.thread(command.threadId)
    const creation = this.state.creations.find(item => item.threadId === thread.id)
    if (command.type === 'configure-thread' && creation?.phase === 'unstarted') {
      validateThreadOptions(this.state.snapshot, command, thread.modelId)
      const model = this.state.snapshot.models.find(model => model.id === (command.modelId ?? thread.modelId))!
      this.requireCreation(model.providerId)
      const previous = structuredClone(thread)
      if (command.modelId !== undefined) {
        thread.modelId = model.id
        if (model.providerId) thread.providerId = model.providerId
        delete thread.reasoningEffort
        if (model.defaultReasoningEffort) thread.reasoningEffort = model.defaultReasoningEffort
        if (thread.runtimeMode && !model.runtimeModes?.includes(thread.runtimeMode)) delete thread.runtimeMode
      }
      if (command.reasoningEffort !== undefined) thread.reasoningEffort = command.reasoningEffort
      if (command.runtimeMode !== undefined) thread.runtimeMode = command.runtimeMode
      this.dirty = true
      try { await this.flush() }
      catch (error) { Object.keys(thread).forEach(key => { delete (thread as unknown as Record<string, unknown>)[key] }); Object.assign(thread, previous); throw error }
      this.publish(); return { accepted: true }
    }
    if (command.type === 'send' && creation && creation.phase !== 'started') {
      firstSend = true
      if (creation.phase === 'starting') {
        await this.refreshThread(thread.id)
        if (this.state.creations.find(item => item.threadId === thread.id)?.phase !== 'started') throw new Error('Native thread creation is not confirmed. Reconnect its original provider and refresh; Sotto will not create it twice. Your prompt has not been sent.')
      } else {
        // Waits for setup already running from creation; only an unstarted or failed one starts here.
        if (thread.worktree?.status !== 'ready') await this.startWorkingCopy(thread)
        thread = this.thread(command.threadId)
        const workingDirectory = await this.threadWorkingDirectory(thread.id)
        if (command.skills?.length) {
          const projectPath = await existingWorkingDirectory(this.state.snapshot.projects.find(project => project.id === thread.projectId)!.path)
          const catalog = await this.listThreadSkills(thread.id, true)
          const skills = (preparedSkills ?? command.skills).map(selected => {
            const local = relative(projectPath, selected.path)
            const path = !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) ? join(workingDirectory, local) : selected.path
            return { ...selected, path }
          })
          if (catalog.status !== 'ready' || skills.some(selected => !catalog.skills.some(skill => skill.name === selected.name && skill.path === selected.path && skill.enabled !== false && skill.userInvocable !== false))) {
            throw new Error('A selected skill is unavailable in the chosen working copy. Refresh the skill catalog and select it again. Your prompt has not been sent.')
          }
          preparedSkills = skills
        }
        validateThreadOptions(this.state.snapshot, thread)
        this.requireCreation(thread.providerId)
        const priorPhase = creation.phase
        creation.phase = 'starting'; thread.nativeSessionStarted = true; this.dirty = true
        try { await this.flush() }
        catch (error) { creation.phase = priorPhase; thread.nativeSessionStarted = priorPhase !== 'unstarted'; throw error }
        this.publish()
        const project = this.state.snapshot.projects.find(project => project.id === thread.projectId)!
        // This creation intent is durable separately from AgentControl's prompt outbox.
        // A failure here precedes prompt dispatch; retry may observe but never replay creation.
        const rejected = async (): Promise<void> => {
          // A definitive rejection permits another attempt. Preserve any identity
          // already reserved by the registry; only an entirely unbound thread unlocks.
          const current = this.thread(thread.id)
          if (this.state.creations.find(item => item.threadId === thread.id)?.phase === 'started') return
          creation.phase = this.inner.providerForThread?.(thread.id) ? 'retryable' : 'unstarted'
          current.nativeSessionStarted = creation.phase !== 'unstarted'
          this.dirty = true; await this.flush(); this.publish()
        }
        let result: AgentHostResult
        try {
          result = await this.inner.execute({ type: 'create-thread', commandId: creation.commandId, threadId: thread.id,
            projectId: thread.projectId, project, title: thread.title, modelId: thread.modelId,
            workingDirectory,
            ...(thread.reasoningEffort ? { reasoningEffort: thread.reasoningEffort } : {}),
            ...(thread.runtimeMode ? { runtimeMode: thread.runtimeMode } : {}) })
        } catch (error) { await rejected(); throw error }
        if (!result.accepted && !result.uncertain) { await rejected(); throw new Error('The provider rejected thread creation. Check its connection and settings, then retry your prompt.') }
        this.accept(await this.inner.snapshot(thread.providerId)); await this.flush()
        if (!result.accepted || this.state.creations.find(item => item.threadId === thread.id)?.phase !== 'started') throw new Error('Native thread creation is not confirmed. Refresh its original provider; your prompt has not been sent.')
      }
      thread = this.thread(command.threadId)
    }
    if (thread.nativeSessionStarted === false) throw new Error('This thread has no native work yet.')
    if (command.type === 'configure-thread') {
      if (creation && creation.phase !== 'started') throw new Error('Native thread creation is not confirmed. Refresh or retry the first prompt with its original provider before changing settings.')
      const capabilities = this.state.snapshot.providers?.find(provider => provider.id === thread.providerId)?.capabilities ?? this.state.snapshot.capabilities
      if (!capabilities.configureThread) throw new Error('This provider does not support changing thread settings.')
      if (thread.status === 'running' || thread.requests.length) throw new Error('Wait for this thread to finish and answer its pending requests before changing settings.')
      validateThreadOptions(this.state.snapshot, command, thread.modelId)
      if (command.modelId && this.state.snapshot.models.find(model => model.id === command.modelId)?.providerId !== thread.providerId) throw new Error('Existing sessions cannot move between providers.')
    }
    // Native command uncertainty belongs to the existing outbox; do not add a failing
    // history read after dispatch that could turn unknown delivery into a rejection.
    // Never send into a deleted/failed working copy, even if the native client is still live.
    if (command.type === 'send' || command.type === 'steer') {
      await this.threadWorkingDirectory(thread.id)
      // The folder was just read, so this is the branch the prompt goes to; the pane compares against it afterwards.
      await this.recordSentBranch(thread.id)
    }
    if (command.type === 'send') await this.checkpointHooks?.beforeTurn(thread.id)
    const result = await this.inner.execute(command.type === 'send' && preparedSkills ? { ...command, skills: preparedSkills } : command)
    if (command.type === 'send' && firstSend && result.accepted) this.nameBranch(thread.id, command.text)
    return result
  }
  private requireCreation(provider?: ProviderId): void {
    const status = this.state.snapshot.providers?.find(item => item.id === provider)
    if (!(status ? status.connection === 'connected' && status.capabilities.threads : this.state.snapshot.connected && this.state.snapshot.capabilities.threads)) throw new Error('Choose a ready provider that can create threads.')
  }
  createProjectId(provider: ProviderId): string { return this.inner.createProjectId?.(provider) ?? randomUUID() }
  resolveProjectId(id: string): string { return this.inner.resolveProjectId?.(id) ?? id }
  resolveModelId(id: string): string { return this.inner.resolveModelId?.(id) ?? id }
  providerForThread(id: string): ProviderId | undefined { return this.state.snapshot.threads.find(thread => thread.id === id)?.providerId ?? this.inner.providerForThread?.(id) }
  /**
   * The threads a window says it is looking at. Only those hold their messages in memory: one leaving the
   * set drops to its summary, one joining it is given the first window of its history from the store.
   */
  observeThreads(ids: readonly string[]): void {
    this.inner.observeThreads?.(ids.filter(id => this.state.snapshot.threads.find(thread => thread.id === id)?.nativeSessionStarted !== false))
    if (!this.ready) return
    const wanted = new Set(ids)
    let changed = !this.declared
    if (!this.declared) {
      this.declared = true
      // Everything held only because nobody had said otherwise goes back to its summary now.
      for (const thread of this.state.snapshot.threads) if (!wanted.has(thread.id) && thread.messages.length) this.unloadWindow(thread.id)
    }
    for (const id of [...this.watched.keys()]) if (!wanted.has(id)) {
      this.watched.delete(id)
      this.hidden.delete(id)
      this.unloadWindow(id)
      changed = true
    }
    for (const id of wanted) if (!this.watched.has(id) && this.state.snapshot.threads.some(thread => thread.id === id)) {
      this.watched.set(id, FIRST_WINDOW_TURNS)
      this.loadWindow(id)
      changed = true
    }
    if (changed) this.publish()
  }
  disconnect(provider?: ProviderId): void {
    this.inner.disconnect(provider)
    const snapshot = this.state.snapshot
    snapshot.providers?.filter(item => !provider || item.id === provider).forEach(item => { item.connection = 'disconnected' })
    snapshot.models.filter(model => !provider || model.providerId === provider).forEach(model => { model.ready = false })
    snapshot.connected = snapshot.providers?.some(item => item.connection === 'connected') ?? false
    for (const thread of snapshot.threads) if (!provider || thread.providerId === provider) delete thread.monitoring
    this.dirty = true
    void this.flush().catch(() => { this.saveError = 'Workspace history could not be saved. Restore access to local storage and refresh.'; this.publish() })
    this.publish()
  }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
}
