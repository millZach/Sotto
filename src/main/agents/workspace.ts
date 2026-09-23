import { loadHostIdentity, migrateWorkspaceHost, stampHostSnapshot } from './hostIdentity'
import type { BrowserAgentTools } from './browserAgentServer'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { cloneHostSnapshot } from './cloneHostSnapshot'
import { readdir, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { agentHostSnapshotSchema, EMPTY_AGENT_HOST, isThreadProviderConnected, RESTORE_BRANCH_NEEDS_CONFIRMATION, summarizeThread, type AgentWorkingCopyOptions, type AgentWorkingCopySelection, type AgentHostSnapshot, type AgentMessage, type AgentThread, type AgentThreadSummary, type AgentWorktree, type ProviderId } from '../../shared/agents'
import type { AgentSkillReference } from '../../shared/agentSkills'
import type { AnswerGivenEvent, StoredThreadEvent, ThreadEvent } from '../../shared/threadEvents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { AgentHost, AgentHostCommand, AgentHostResult, ShortTextPrompt, StoredMessageIdentity } from './host'
import { FIRST_WINDOW_TURNS, LATER_WINDOW_TURNS, ThreadStore } from './threadStore'
import { SubagentStore, subagentActivityClassification } from './subagentStore'
import { observedSubagentStatus, EMPTY_SUBAGENT_SUMMARY, type SubagentChange, type SubagentSummary, type SubagentPageRequest, type SubagentAssignmentsRequest } from '../../shared/subagents'
import { validateThreadOptions } from './threadOptions'
import { resolveThreadWorkingDirectory } from '../../shared/threadWorkingDirectory'
import { existingWorkingDirectory, ThreadWorktrees } from './threadWorktrees'
import { gitStatusFingerprint, type GitStatus } from '../../shared/gitStatus'
import type { GitStatusSource } from './gitStatus'
import { GitActionRefusal, type GitActionEvent, type GitActions } from './gitActions'
import type { GitActionProgress, GitPullResult, GitStackedAction } from '../../shared/gitActions'
import { MAX_AGENT_ACTIVITIES, isTerminalActivity, mergeAgentActivities, type AgentActivity } from '../../shared/agentActivity'

/** Milliseconds a burst of tool activity is left to settle before the worktree is read again. */
const WORKTREE_REFRESH_DELAY_MS = 1_500
/** How often the Git status timer looks at whether a remote read is due. */
const GIT_STATUS_TICK_MS = 5_000
/** Work that can leave the worktree on another branch: a finished turn, a shell command it ran, or files it changed. */
const HEAD_MOVING_KINDS: ReadonlySet<AgentActivity['kind']> = new Set(['turn', 'command', 'file-change', 'tool'])
/** The finished records that could have moved HEAD, by ID, so only new ones ask for a re-read. */
function settledHeadMovers(activities: readonly AgentActivity[] | undefined): Set<string> {
  return new Set((activities ?? []).filter(activity => HEAD_MOVING_KINDS.has(activity.kind) && isTerminalActivity(activity.status)).map(activity => activity.id))
}

/**
 * The turn still being worked: the latest running turn record's, or, with none and the thread running, the
 * turn of its newest record. A running record alone is not enough: a re-read tool call with no result is one.
 */
function liveTurn(activities: readonly AgentActivity[], status: AgentThread['status']): string | undefined {
  let latest: AgentActivity | undefined
  let newest: AgentActivity | undefined
  for (const record of activities) {
    if (record.kind === 'turn' && record.status === 'running' && (!latest || record.sequence > latest.sequence)) latest = record
    if (!newest || record.sequence > newest.sequence) newest = record
  }
  return latest?.turnId ?? (status === 'running' ? newest?.turnId : undefined)
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
 * Subagent task/result text has only one durable copy, in the roster store. The ordinary activity
 * store and JSON migration fallback retain only text-free subagent classification.
 */
function retainedActivities(activities: AgentActivity[]): AgentActivity[] {
  return activities.map(activity => activity.kind === 'subagent' || activity.agents?.length || activity.taskUpdatesExcluded !== undefined ? subagentActivityClassification(activity) : activity)
}

function organizationOnly(thread: AgentThread, keepActivities = false): AgentThread {
  const { summary, earlierAvailable, monitoring, backgroundWork, subagentSummary, activities, ...rest } = thread
  void summary; void earlierAvailable; void monitoring; void backgroundWork; void subagentSummary
  return { ...rest, messages: [], ...(keepActivities && activities ? { activities: retainedActivities(activities) } : {}) }
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
  useBrowserTools(tools: BrowserAgentTools): void { this.inner.useBrowserTools?.(tools) }
  readonly concurrentProviders: boolean
  private state: Workspace = { snapshot: structuredClone(EMPTY_AGENT_HOST), creations: [], projectAliases: [] }
  private readonly store: AtomicJsonStore<Workspace>
  private loading: Promise<void> | undefined
  private hostId: string | undefined
  private ready = false
  private stopping = false
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
  private readonly organizationLanes = new Map<string, Promise<unknown>>()
  /** In-flight working-copy setup per thread, so a send waits for it instead of starting a second one. */
  private readonly preparations = new Map<string, Promise<void>>()
  private readonly worktrees: ThreadWorktrees
  private checkpointHooks: { beforeTurn(threadId: string): Promise<void>; isBlocked(threadId: string): boolean | Promise<boolean> } | undefined
  /** One pending worktree re-read per thread, so a busy turn asks for a single read rather than one per record. */
  private readonly worktreeRefreshes = new Map<string, ReturnType<typeof setTimeout>>()
  /** Reads a folder's Git status the way T3 does; without one, records carry no status. */
  private gitStatus: GitStatusSource | undefined
  private gitStatusOptions: { foreground: () => boolean; pollIntervalMs: () => number } = { foreground: () => true, pollIntervalMs: () => 0 }
  private gitStatusTimer: ReturnType<typeof setInterval> | undefined
  private gitStatusPolledAt = 0
  private gitStatusPolling = false
  /** Runs the Git actions on a thread's folder the way T3 does; without one, the commands say so. */
  private gitActions: GitActions | undefined
  /** The desktop's own reason a folder may not change yet (a revert in flight); absent on a host, which has none. */
  private mutationGuard: ((threadId: string) => Promise<boolean> | boolean) | undefined
  /** A thread's own history: the log and the message projection every window reads (issue #119). */
  private readonly subagentStore: SubagentStore
  private subagentUnavailable = false
  private readonly subagentSummaries = new Map<string, SubagentSummary>()
  private readonly subagentInputs = new Map<string, { epoch: string | undefined; records: Map<string, string>; activities: readonly AgentActivity[] | undefined }>()
  private readonly subagentListeners = new Set<(change: SubagentChange) => void>()
  private readonly subagentChanges = new Map<string, SubagentChange>()
  private subagentTimer: ReturnType<typeof setTimeout> | undefined
  private readonly subagentLiveSince = new Map<string, number>()
  private readonly startedAt = Date.now()
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
  /**
   * Per thread a pane is looking at, what the store said when asked whether it holds a message an activity
   * record names above the window. Only the asked IDs are kept, so each costs one indexed lookup however
   * often the thread is published. The answers go with a reset, a failed write, a store switch or the pane.
   */
  private readonly storedAnchors = new Map<string, { readonly answers: Map<string, boolean>; generation: number }>()
  /** Stamps each change to those answers, so a view worked out against older ones is never reused. */
  private anchorGeneration = 0
  /** The message IDs of a loaded window, worked out once per loaded array. */
  private readonly loadedIds = new WeakMap<readonly AgentMessage[], ReadonlySet<string>>()
  /** The last pane view worked out for an activity list, reused while nothing it depends on has moved. */
  private readonly paneViews = new WeakMap<readonly AgentActivity[], { readonly messages: readonly AgentMessage[]; readonly hidden: number;
    readonly watched: boolean; readonly status: AgentThread['status']; readonly generation: number; readonly records: readonly AgentActivity[] }>()
  /** True when the provider host says what changed rather than publishing a whole history to compare. */
  private readonly eventSourced: boolean
  /** Events waiting to be written, so a streamed reply costs one transaction per publish, not per word. */
  private readonly pendingEvents = new Map<string, ThreadEvent[]>()
  /** The threads whose window and summary the next publish has to read again. */
  private readonly eventChanged = new Set<string>()

  private workingCopyDefault: (projectId: string) => 'independent' | 'shared' = () => 'shared'
  private branchNameWriter: ((threadId: string, prompt: string) => Promise<string | null>) | undefined
  private readonly namingBranches = new Set<string>()
  private readonly branchWrites = new Set<Promise<void>>()
  setWorkingCopyDefaults(resolver: (projectId: string) => 'independent' | 'shared'): void { this.workingCopyDefault = resolver }
  /** Names a new worktree's branch from its first prompt, asking that thread's own provider (ADR-0026). */
  setBranchNameWriter(writer: (threadId: string, prompt: string) => Promise<string | null>): void { this.branchNameWriter = writer }
  /** Whether something outside this host, a Tools terminal, still runs in the thread's folder. */
  private worktreeInUse: (threadId: string) => boolean = () => false
  setWorktreeInUse(inUse: (threadId: string) => boolean): void { this.worktreeInUse = inUse }
  /**
   * Gives the workspace its Git status source. Status is read with the worktree after a turn, with the
   * remote on a refresh, and for the threads a window is looking at on a timer while that window is in
   * front, once per fetch interval; an interval of zero leaves the timer with nothing to do.
   */
  setGitStatus(source: GitStatusSource, options: { foreground?: () => boolean; pollIntervalMs: () => number; tickMs?: number }): void {
    this.gitStatus = source
    this.gitStatusOptions = { foreground: options.foreground ?? (() => true), pollIntervalMs: options.pollIntervalMs }
    if (this.gitStatusTimer) clearInterval(this.gitStatusTimer)
    this.gitStatusTimer = setInterval(() => { void this.pollGitStatus() }, options.tickMs ?? GIT_STATUS_TICK_MS)
    this.gitStatusTimer.unref?.()
  }
  setGitActions(actions: GitActions): void { this.gitActions = actions }
  setMutationGuard(guard: (threadId: string) => Promise<boolean> | boolean): void { this.mutationGuard = guard }
  /** The folder a Git command may act on now, or the reason it may not, in plain words. */
  private async gitActionFolder(threadId: string): Promise<string> {
    await this.initialize()
    const thread = this.thread(threadId)
    if (thread.status === 'running') throw new GitActionRefusal('Wait for the thread to finish its turn before changing Git.')
    if (thread.requests.length > 0) throw new GitActionRefusal('Answer the thread\'s waiting request before changing Git.')
    if (this.preparations.has(threadId)) throw new GitActionRefusal('Wait for the working copy to be set up before changing Git.')
    if (thread.gitAction?.status === 'running') throw new GitActionRefusal('Git action in progress.')
    if (this.mutationGuard && !await this.mutationGuard(threadId)) throw new GitActionRefusal('Wait for active or pending thread work before changing Git.')
    return this.threadWorkingDirectory(threadId)
  }
  private setGitActionProgress(threadId: string, progress: GitActionProgress): void {
    const thread = this.state.snapshot.threads.find(item => item.id === threadId)
    if (!thread) return
    thread.gitAction = progress
    this.dirty = true
    this.publishSoon()
  }
  /**
   * T3's stacked action, run on the thread's lane so nothing is sent to the thread while its folder
   * changes. Progress lands on the thread record as it comes; the result or the refusal stays there
   * for the notice, and the folder's status is read again with the remote once it is over.
   */
  runGitAction(command: { threadId: string; actionId: string; action: GitStackedAction; commitMessage?: string | undefined; featureBranch?: boolean | undefined; filePaths?: readonly string[] | undefined; allowDefaultBranch?: boolean | undefined }): Promise<AgentHostSnapshot> {
    return this.onLane(command.threadId, async () => {
      if (!this.gitActions) throw new Error('Git actions are unavailable on this host.')
      const cwd = await this.gitActionFolder(command.threadId)
      const startedAt = new Date().toISOString()
      let progress: GitActionProgress = { actionId: command.actionId, action: command.action, status: 'running', phases: [], phase: null, stage: null, hook: null, startedAt, finishedAt: null, result: null, error: null }
      const update = (change: Partial<GitActionProgress>): void => { progress = { ...progress, ...change }; this.setGitActionProgress(command.threadId, progress) }
      update({})
      const onProgress = (event: GitActionEvent): void => {
        if (event.kind === 'action_started') update({ phases: [...event.phases], stage: event.stages[0] ?? null })
        else if (event.kind === 'phase_started') update({ phase: event.phase, stage: event.stage, hook: null })
        else if (event.kind === 'hook_started') update({ hook: { name: event.hookName, output: null } })
        else if (event.kind === 'hook_output') update({ hook: { name: event.hookName ?? progress.hook?.name ?? 'hook', output: event.text } })
        else if (event.kind === 'hook_finished') update({ hook: null })
      }
      try {
        const result = await this.gitActions.runStackedAction({ threadId: command.threadId, cwd, action: command.action, commitMessage: command.commitMessage, featureBranch: command.featureBranch, filePaths: command.filePaths, allowDefaultBranch: command.allowDefaultBranch, onProgress })
        update({ status: 'done', phase: null, stage: null, hook: null, finishedAt: new Date().toISOString(), result })
      } catch (error) {
        update({ status: 'failed', phase: null, stage: null, hook: null, finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : 'The Git action failed.' })
      }
      try { await this.flush() } catch { this.saveError = BRANCH_SAVE_ERROR }
      await this.refreshAfterGitAction(command.threadId)
      return this.workspaceSnapshot()
    })
  }
  /** A commit, push, switch or pull moved the folder: the worktree record and the status follow at once. */
  private async refreshAfterGitAction(threadId: string): Promise<void> {
    this.gitStatus?.invalidate()
    const worktree = this.state.snapshot.threads.find(item => item.id === threadId)?.worktree
    if (worktree?.status === 'ready' && worktree.path) {
      try {
        const inspected = await this.worktrees.inspect(worktree)
        const current = this.state.snapshot.threads.find(item => item.id === threadId)
        if (current?.worktree === worktree) { current.worktree = { ...inspected, ...(worktree.sentBranch !== undefined ? { sentBranch: worktree.sentBranch } : {}) }; this.dirty = true }
      } catch { /* The next send reports a folder that stopped being the thread's. */ }
    }
    await this.readGitStatus(threadId, true)
    this.publish()
  }
  pullThreadBranch(threadId: string): Promise<{ snapshot: AgentHostSnapshot; result: GitPullResult }> {
    return this.onLane(threadId, async () => {
      if (!this.gitActions) throw new Error('Git actions are unavailable on this host.')
      const result = await this.gitActions.pull(await this.gitActionFolder(threadId))
      await this.refreshAfterGitAction(threadId)
      return { snapshot: this.workspaceSnapshot(), result }
    })
  }
  /** T3's switch: Git refuses when work would be lost, and the thread follows whatever branch the folder ends up on (ADR-0014). */
  switchThreadBranch(threadId: string, ref: string, create: boolean): Promise<AgentHostSnapshot> {
    return this.onLane(threadId, async () => {
      if (!this.gitActions) throw new Error('Git actions are unavailable on this host.')
      await this.gitActions.switchBranch(await this.gitActionFolder(threadId), ref, { create })
      await this.refreshAfterGitAction(threadId)
      return this.workspaceSnapshot()
    })
  }
  initThreadRepository(threadId: string): Promise<AgentHostSnapshot> {
    return this.onLane(threadId, async () => {
      if (!this.gitActions) throw new Error('Git actions are unavailable on this host.')
      await this.gitActions.init(await this.gitActionFolder(threadId))
      // A folder that just became a repository is discovered again so its record says so.
      const thread = this.thread(threadId)
      if (thread.worktree?.mode === 'shared') { delete thread.worktree; this.dirty = true }
      await this.discoverWorkingCopy(threadId).catch(() => undefined)
      await this.refreshAfterGitAction(threadId)
      return this.workspaceSnapshot()
    })
  }
  publishThreadRepository(threadId: string, options: { repository: string; visibility: 'private' | 'public' }): Promise<{ snapshot: AgentHostSnapshot; url: string }> {
    return this.onLane(threadId, async () => {
      if (!this.gitActions) throw new Error('Git actions are unavailable on this host.')
      const { url } = await this.gitActions.publish(await this.gitActionFolder(threadId), options)
      await this.refreshAfterGitAction(threadId)
      return { snapshot: this.workspaceSnapshot(), url }
    })
  }
  /** A Git action changed this thread's folder: read it again, remote and all, without waiting for the timer. */
  gitActionFinished(threadId: string): Promise<void> {
    this.gitStatus?.invalidate()
    return this.onLane(threadId, () => this.readGitStatus(threadId, true))
  }
  private async pollGitStatus(): Promise<void> {
    if (this.gitStatusPolling || this.stopping || !this.gitStatus || !this.declared) return
    const interval = this.gitStatusOptions.pollIntervalMs()
    if (interval <= 0 || Date.now() - this.gitStatusPolledAt < interval || !this.gitStatusOptions.foreground()) return
    this.gitStatusPolling = true
    this.gitStatusPolledAt = Date.now()
    try {
      for (const threadId of [...this.watched.keys()]) {
        if (this.stopping) break
        await this.onLane(threadId, () => this.readGitStatus(threadId, true)).catch(() => undefined)
      }
    } finally { this.gitStatusPolling = false }
  }
  /** Reads the thread's folder and publishes only a status that changed. Callers hold the thread's lane. */
  private async readGitStatus(threadId: string, remote: boolean): Promise<void> {
    if (!this.gitStatus || this.stopping) return
    const thread = this.state.snapshot.threads.find(item => item.id === threadId)
    const worktree = thread?.worktree
    if (!thread || !worktree || worktree.status !== 'ready' || worktree.reclaimedAt) return
    let folder: string
    try { folder = resolveThreadWorkingDirectory(thread, this.state.snapshot.projects.find(project => project.id === thread.projectId)) } catch { return }
    let status: GitStatus
    try { status = await this.gitStatus.read(folder, { remote }) } catch { return }
    const current = this.state.snapshot.threads.find(item => item.id === threadId)
    if (!current?.worktree || current.worktree.status !== 'ready' || this.stopping) return
    if (gitStatusFingerprint(current.worktree.git) === gitStatusFingerprint(status)) return
    current.worktree = { ...current.worktree, git: status }
    this.dirty = true
    try { await this.flush() } catch { this.saveError = BRANCH_SAVE_ERROR }
    this.publish()
  }
  /**
   * Removes this thread's own worktree folder because the user asked, or a rule the user turned on did
   * (ADR-0019). The thread keeps its record and its branch keeps its commits; the next send puts the
   * folder back. Refused while the thread is running, waiting on an answer, sharing the folder with
   * another thread, or has a terminal open in it. `withUncommittedChanges` is the user's answer to the
   * confirmation; a rule never gives it.
   */
  async reclaimThreadWorktree(threadId: string, options: { withUncommittedChanges?: boolean; automatic?: boolean } = {}): Promise<AgentHostSnapshot> {
    return this.onLane(threadId, async () => {
      await this.initialize()
      const thread = this.thread(threadId)
      const worktree = thread.worktree
      if (worktree?.mode !== 'independent' || !worktree.path || worktree.reused) throw new Error('This thread has no worktree of its own to remove.')
      if (worktree.reclaimedAt) return this.workspaceSnapshot()
      if (thread.status === 'running' || thread.requests.length || this.preparations.has(threadId)) throw new Error('This thread is still working. Wait for it to finish and answer its requests before removing its folder.')
      if (!await this.ownsCheckoutAlone(threadId)) throw new Error('Another thread works in this folder too, so it stays.')
      if (this.worktreeInUse(threadId)) throw new Error('A terminal is open in this folder. Close it before removing the folder.')
      const reclaimed = await this.worktrees.reclaim(worktree, options)
      this.thread(threadId).worktree = reclaimed
      this.dirty = true
      try { await this.flush() } catch { this.saveError = BRANCH_SAVE_ERROR }
      this.publish()
      return this.workspaceSnapshot()
    })
  }
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
    const metadata = this.thread(threadId).worktree
    if (!metadata?.temporaryBranch) return false
    return this.ownsCheckoutAlone(threadId)
  }
  /** No other thread, by its own folder or its project's, works in this thread's checkout. */
  private async ownsCheckoutAlone(threadId: string): Promise<boolean> {
    const metadata = this.thread(threadId).worktree
    if (!metadata || metadata.reused || !metadata.path) return false
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
      if (this.stopping || !await this.exclusivelyOwnsCheckout(threadId) || this.stopping) return
      const metadata = this.thread(threadId).worktree!
      const renamed = await this.worktrees.renameTemporaryBranch(metadata, name)
      this.thread(threadId).worktree = renamed
      this.dirty = true
      await this.flush()
      this.publish()
    })
  }
  private nameBranch(threadId: string, prompt: string): void {
    if (this.stopping || !this.branchNameWriter || this.namingBranches.has(threadId)) return
    this.namingBranches.add(threadId)
    const writer = this.branchNameWriter
    const pending = this.exclusivelyOwnsCheckout(threadId).then(exclusive => !this.stopping && exclusive && this.thread(threadId).worktree?.temporaryBranch ? writer(threadId, prompt) : null)
      .then(name => !this.stopping && name ? this.renameTemporaryBranch(threadId, name) : undefined).catch(() => undefined)
    this.branchWrites.add(pending)
    void pending.finally(() => this.branchWrites.delete(pending))
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
    this.subagentStore = new SubagentStore(join(directory, 'subagents.sqlite'))
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
      this.hostId = await loadHostIdentity(this.directory)
      try { await migrateWorkspaceHost(this.directory, this.hostId) }
      catch (error) {
        // History-off recovery already discards an unreadable snapshot without keeping private
        // copies. Identity validation must not prevent that explicit privacy cleanup. A refused
        // write, unreadable file or valid workspace belonging to another host still stops startup.
        if (this.historyEnabled() || !(error instanceof SyntaxError || error instanceof z.ZodError)) throw error
      }
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
      try { this.subagentStore.open({ ephemeral: !this.historyEnabled() }) }
      catch { this.subagentUnavailable = true; this.saveError = 'Agent history could not be opened. Restore access to local storage and restart Sotto.' }
      this.state = await this.store.peek()
      this.state.snapshot = stampHostSnapshot(this.state.snapshot, this.hostId)
      const snapshot = this.state.snapshot
      snapshot.connected = false
      // A Git action that was running when the host stopped did not finish here; the folder says what it did.
      for (const thread of snapshot.threads) if (thread.gitAction?.status === 'running') thread.gitAction = { ...thread.gitAction, status: 'failed', phase: null, stage: null, hook: null, finishedAt: new Date().toISOString(), error: 'Sotto stopped while this action ran. Check the folder before running it again.' }
      snapshot.models.forEach(model => { model.ready = false })
      snapshot.providers?.forEach(provider => { provider.connection = 'disconnected'; delete provider.error })
      delete snapshot.error
      for (const thread of snapshot.threads) { delete thread.monitoring; delete thread.backgroundWork }
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
      for (const thread of snapshot.threads) {
        this.trackSubagents(thread, false)
        thread.subagentSummary = this.subagentSummaries.get(thread.id) ?? EMPTY_SUBAGENT_SUMMARY
      }
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
      try { for (const thread of carrying) { this.threadStore.replaceThreadMessages(thread.id, thread.messages, thread.historyEpoch); this.storedAnchors.delete(thread.id) } }
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
  /** Import old JSON activity without replacing a committed message generation after an interrupted save. */
  private adoptSavedActivities(snapshot: AgentHostSnapshot): void {
    if (this.storeUnavailable) { this.activityStoreUnavailable = true; return }
    try {
      for (const thread of snapshot.threads) {
        let messageGeneration = this.threadStore.readMessageEpoch(thread.id)
        if (messageGeneration) {
          // A committed reset, including an unversioned or empty reset, outranks legacy JSON.
          thread.messages = []
          if (thread.historyEpoch !== messageGeneration.epoch) thread.activities = []
          if (messageGeneration.epoch === undefined) delete thread.historyEpoch
          else thread.historyEpoch = messageGeneration.epoch
        }
        if (!this.threadStore.hasActivities(thread.id) && thread.activities !== undefined) {
          if (!messageGeneration && thread.messages.length) {
            // Both legacy projections describe the same JSON generation. Commit its first message
            // reset before activity so even an exit before the later flush leaves a matching marker.
            this.threadStore.replaceThreadMessages(thread.id, thread.messages, thread.historyEpoch)
            this.storedAnchors.delete(thread.id)
            thread.messages = []
            messageGeneration = this.threadStore.readMessageEpoch(thread.id)
          }
          // Retain legacy child tasks before the activity migration removes their payload.
          this.trackSubagents(thread, false)
          this.threadStore.syncActivities(thread.id, retainedActivities(thread.activities), thread.historyEpoch)
        }
        if (this.threadStore.hasActivities(thread.id)) {
          const activityEpoch = this.threadStore.readActivityEpoch(thread.id)
          const activityReset = this.threadStore.readActivityResetSequence(thread.id)
          if (messageGeneration && (activityEpoch !== messageGeneration.epoch || (activityReset !== undefined && activityReset !== messageGeneration.sequence))) {
            // The message reset may commit before activity sync. Old activity must not roll it back.
            thread.activities = []
            this.threadStore.syncActivities(thread.id, [], messageGeneration.epoch)
          } else {
            const epoch = messageGeneration ? messageGeneration.epoch : activityEpoch
            if (thread.historyEpoch !== epoch) thread.messages = []
            if (epoch === undefined) delete thread.historyEpoch
            else thread.historyEpoch = epoch
            thread.activities = this.threadStore.readActivities(thread.id)
          }
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
      if (thread.activities !== undefined) this.threadStore.syncActivities(thread.id, retainedActivities(thread.activities), thread.historyEpoch)
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
      try { this.threadStore.appendMany(threadId, events); this.noteWritten(threadId, events) }
      catch { this.saveError = HISTORY_SAVE_ERROR; this.storedAnchors.delete(threadId) }
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
  /** Indexed historical task classification, never live monitoring or task/result text. */
  activity(threadId: string, activityId: string, historyEpoch?: string): AgentActivity | undefined {
    if (this.subagentUnavailable) return undefined
    try { return this.subagentStore.activity(threadId, activityId, historyEpoch) }
    catch { return undefined }
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
      try { this.threadStore.appendMany(thread.id, events); this.noteWritten(thread.id, events) }
      catch {
        // The whole history goes to the pane as it is, so nothing is above a window any more.
        this.saveError = HISTORY_SAVE_ERROR; this.hidden.delete(thread.id); this.storedAnchors.delete(thread.id)
        return [...messages]
      }
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
  /**
   * The records a pane is given beside this thread's loaded window, decided a turn at a time. A turn's
   * anchors are the messages its records followed, and its own ID when that names a message (Claude, Grok
   * and Devin name a turn after its prompt). The window is the newest tail of the store, so a turn with an
   * anchor among the loaded messages is inside it; one whose anchors the store holds elsewhere is above it
   * and waits there with its messages until the window widens, however new a provider re-read made its
   * records; one the store knows nothing of is given, for the pane to place. The live turn is always given.
   *
   * A thread no pane is looking at holds no messages, so everything but its live turn is above its window.
   * The records themselves are untouched: the store, the summary and the adapters read them whole.
   */
  paneActivities(threadId: string, activities: readonly AgentActivity[]): readonly AgentActivity[] {
    const thread = this.state.snapshot.threads.find(item => item.id === threadId)
    if (this.storeUnavailable || !thread || !activities.length) return activities
    const watched = !this.declared || this.watched.has(threadId)
    const hidden = watched ? this.hidden.get(threadId) ?? 0 : 0
    if (watched && hidden <= 0) return activities
    const held = this.paneViews.get(activities)
    if (held && held.messages === thread.messages && held.hidden === hidden && held.watched === watched && held.status === thread.status
      && held.generation === (this.storedAnchors.get(threadId)?.generation ?? 0)) return held.records

    const live = liveTurn(activities, thread.status)
    let records: readonly AgentActivity[]
    if (!watched) records = activities.filter(record => record.turnId === live)
    else {
      let loaded = this.loadedIds.get(thread.messages)
      if (!loaded) { loaded = new Set(thread.messages.map(message => message.id)); this.loadedIds.set(thread.messages, loaded) }
      const anchors = new Map<string, Set<string>>()
      for (const record of activities) {
        let ids = anchors.get(record.turnId)
        if (!ids) { ids = new Set(); anchors.set(record.turnId, ids) }
        if (record.afterMessageId !== undefined) ids.add(record.afterMessageId)
      }
      const above = new Set<string>()
      for (const [turnId, ids] of anchors) {
        ids.add(turnId)
        if (turnId === live || [...ids].some(id => loaded.has(id))) continue
        const stored = this.storesAny(threadId, ids)
        if (stored === undefined) return activities
        if (stored) above.add(turnId)
      }
      records = above.size ? activities.filter(record => !above.has(record.turnId)) : activities
    }
    this.paneViews.set(activities, { messages: thread.messages, hidden, watched, status: thread.status,
      generation: this.storedAnchors.get(threadId)?.generation ?? 0, records })
    return records
  }
  /** Whether the store holds any of these messages, asking only about the ones it has not answered for yet. */
  private storesAny(threadId: string, ids: Iterable<string>): boolean | undefined {
    let entry = this.storedAnchors.get(threadId)
    if (!entry) { entry = { answers: new Map(), generation: ++this.anchorGeneration }; this.storedAnchors.set(threadId, entry) }
    for (const id of ids) {
      let answer = entry.answers.get(id)
      if (answer === undefined) {
        try { answer = this.threadStore.hasMessage(threadId, id) }
        catch { return undefined }
        entry.answers.set(id, answer)
      }
      if (answer) return true
    }
    return false
  }
  /** Keeps the store's answers true to what was just written: a reset voids them, an added message is now held. */
  private noteWritten(threadId: string, events: readonly ThreadEvent[]): void {
    const entry = this.storedAnchors.get(threadId)
    if (!entry) return
    if (events.some(event => event.kind === 'messages-reset')) { this.storedAnchors.delete(threadId); return }
    let changed = false
    for (const event of events) {
      if (event.kind === 'message-added' && entry.answers.get(event.message.id) === false) { entry.answers.set(event.message.id, true); changed = true }
    }
    if (changed) entry.generation = ++this.anchorGeneration
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
  eventsAfter(seq: number, threadId?: string, limit?: number): StoredThreadEvent[] {
    if (this.storeUnavailable) return []
    this.writeEvents()
    return this.threadStore.eventsAfter(seq, threadId, limit)
  }
  /** Stop provider delivery first, then drain organization writes before closing SQLite. */
  async close(): Promise<void> {
    this.stopping = true
    await Promise.allSettled([...this.branchWrites, ...this.lanes.values()])
    try { if (this.ready) await this.flush() } finally { this.dispose() }
  }

  /** Closes the history store. Called when the app quits, after the last flush. */
  dispose(): void {
    this.stopping = true
    clearTimeout(this.publishTimer); clearTimeout(this.writeTimer)
    for (const timer of this.worktreeRefreshes.values()) clearTimeout(timer)
    this.worktreeRefreshes.clear()
    if (this.gitStatusTimer) { clearInterval(this.gitStatusTimer); this.gitStatusTimer = undefined }
    try { if (this.ready) { this.writeEvents(); this.saveActivities() } }
    catch { this.saveError = 'Thread activity could not be saved. Restore local storage and restart Sotto.' }
    finally { this.threadStore.close(); this.subagentStore.close() }
    if (this.subagentTimer) clearTimeout(this.subagentTimer)
    this.subagentChanges.clear(); this.subagentListeners.clear()
  }

  async subagentPage(request: SubagentPageRequest) {
    await this.initialize(); this.thread(request.threadId)
    if (this.subagentUnavailable) throw new Error('Agent history is unavailable. Restore access to local storage and restart Sotto.')
    return this.subagentStore.page(request)
  }
  async subagentAssignments(request: SubagentAssignmentsRequest) {
    await this.initialize(); this.thread(request.threadId)
    if (this.subagentUnavailable) throw new Error('Agent history is unavailable. Restore access to local storage and restart Sotto.')
    return this.subagentStore.assignments(request)
  }
  subscribeSubagents(listener: (change: SubagentChange) => void): () => void {
    this.subagentListeners.add(listener)
    return () => this.subagentListeners.delete(listener)
  }
  private subagentsChanged(change: SubagentChange | undefined): void {
    if (!change) return
    this.subagentSummaries.set(change.threadId, change.summary)
    const pending = this.subagentChanges.get(change.threadId)
    const rows = new Map((change.reset ? [] : pending?.rows ?? []).map(row => [row.id, row]))
    for (const row of change.rows) rows.set(row.id, row)
    this.subagentChanges.set(change.threadId, { ...change, rows: [...rows.values()], ...(pending?.reset ? { reset: true } : {}) })
    if (this.subagentTimer) return
    this.subagentTimer = setTimeout(() => {
      this.subagentTimer = undefined
      const changes = [...this.subagentChanges.values()]; this.subagentChanges.clear()
      for (const next of changes) for (const listener of this.subagentListeners) listener(next)
    }, PUBLISH_WINDOW_MS)
    this.subagentTimer.unref?.()
  }
  /** Only changed native observations enter the indexed roster; its archive never enters a host snapshot. */
  private trackSubagents(thread: AgentThread, connected: boolean): void {
    if (this.subagentUnavailable) return
    try {
      let input = this.subagentInputs.get(thread.id)
      if (!input || input.epoch !== thread.historyEpoch) {
        input = { epoch: thread.historyEpoch, records: new Map(), activities: undefined }
        this.subagentInputs.set(thread.id, input)
        this.subagentsChanged(this.subagentStore.ingest(thread.id, [], thread.historyEpoch))
      }
      if (input.activities !== thread.activities) {
        const observations: NonNullable<AgentActivity['agents']> = []
        const classifications: AgentActivity[] = []
        const retained = new Set<string>()
        for (const activity of thread.activities ?? []) {
          if (activity.kind !== 'subagent' && !activity.agents?.length && activity.taskUpdatesExcluded === undefined) continue
          retained.add(activity.id)
          const fingerprint = createHash('sha256').update(JSON.stringify([subagentActivityClassification(activity), activity.agents])).digest('hex')
          if (input.records.get(activity.id) === fingerprint) continue
          input.records.set(activity.id, fingerprint)
          classifications.push(activity)
          for (const agent of activity.agents ?? []) {
            const fresh = agent.observedAt !== undefined && Date.parse(agent.observedAt) >= (this.subagentLiveSince.get(thread.id) ?? this.startedAt)
            const working = observedSubagentStatus(agent.status) === 'running'
            observations.push(working && (!connected || !fresh) ? { ...agent, status: 'unknown' } : agent)
          }
        }
        for (const id of input.records.keys()) if (!retained.has(id)) input.records.delete(id)
        input.activities = thread.activities
        if (observations.length || classifications.length) this.subagentsChanged(this.subagentStore.ingest(thread.id, observations, thread.historyEpoch, classifications))
      }
      if (!connected) {
        this.subagentLiveSince.set(thread.id, Date.now())
        this.subagentsChanged(this.subagentStore.markUnknown(thread.id))
      }
      if (!this.subagentSummaries.has(thread.id)) this.subagentSummaries.set(thread.id, this.subagentStore.state(thread.id).summary)
    } catch {
      // An unchanged provider snapshot still needs retrying when its store transaction failed.
      this.subagentInputs.delete(thread.id)
      this.saveError = 'Agent history could not be saved. Restore access to local storage and refresh.'
    }
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
    const threads = new Map(previous.threads.map(thread => [thread.id, { ...thread, monitoring: undefined, backgroundWork: undefined } as AgentThread]))
    for (const thread of snapshot.threads) {
      const old = threads.get(thread.id)
      this.trackSubagents(thread, isThreadProviderConnected(snapshot, thread))
      const creation = this.state.creations.find(item => item.threadId === thread.id)
      if (creation) creation.phase = 'started'
      // A new provider registration may have a different project ID. The original Sotto
      // project remains the workspace/memory scope for a thread created beneath it.
      const merged: AgentThread = { ...thread,
        subagentSummary: this.subagentSummaries.get(thread.id) ?? EMPTY_SUBAGENT_SUMMARY,
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
    this.state.snapshot = stampHostSnapshot({ ...snapshot, models: [...models.values()], projects: [...projects.values()], threads: [...threads.values()] }, this.hostId!)
    for (const thread of this.state.snapshot.threads) if (!isThreadProviderConnected(snapshot, thread)) { delete thread.monitoring; delete thread.backgroundWork }
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
      if (inspected.branch !== current.worktree.branch || inspected.dirty !== current.worktree.dirty) {
        current.worktree = { ...inspected, ...(current.worktree.sentBranch !== undefined ? { sentBranch: current.worktree.sentBranch } : {}) }
        this.dirty = true
        try { await this.flush() } catch { this.saveError = BRANCH_SAVE_ERROR }
        this.publish()
      }
      // Finished work may have committed, so the counts are read again; the remote waits for the timer or a refresh.
      await this.readGitStatus(threadId, false)
    })
  }
  /** Serializes work for one thread or project without holding up unrelated provider work. */
  private onLane<T>(key: string, work: () => Promise<T>, lanes = this.lanes): Promise<T> {
    const pending = (lanes.get(key) ?? Promise.resolve()).catch(() => undefined).then(work)
    lanes.set(key, pending)
    void pending.finally(() => { if (lanes.get(key) === pending) lanes.delete(key) }).catch(() => undefined)
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
    if (!this.subagentUnavailable && this.subagentStore.ephemeral === this.historyEnabled()) {
      try {
        const unsettled = new Map(this.state.snapshot.threads.map(thread => {
          const observations = this.subagentStore.unsettled(thread.id)
          return [thread.id, { observations, activities: this.subagentStore.unsettledActivities(thread.id, observations) }]
        }))
        this.subagentStore.privacyChanged(this.historyEnabled())
        this.subagentChanges.clear()
        for (const thread of this.state.snapshot.threads) {
          // Retention changes do not end native work. Restore only text-free live/uncertain metadata,
          // including children whose original activity already left the bounded provider window.
          const retained = unsettled.get(thread.id)
          const seeded = this.subagentStore.ingest(thread.id, retained?.observations ?? [], thread.historyEpoch, retained?.activities ?? [])
          const current = this.subagentStore.state(thread.id)
          thread.subagentSummary = current.summary
          this.subagentsChanged({ threadId: thread.id, ...current, rows: seeded?.rows ?? [], reset: true })
        }
      } catch { this.saveError = 'Saved agent history could not be removed. Restore access to local storage and try again.'; throw new Error(this.saveError) }
    }
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
        this.storedAnchors.clear()
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
    const projectId = kind === 'project' ? id : this.state.snapshot.threads.find(thread => thread.id === id)?.projectId
    if (!projectId) throw new Error('That thread is unavailable.')
    return this.onLane(projectId, async () => {
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
    }, this.organizationLanes)
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
        // A folder Sotto reclaimed is not put back by a refresh, only by the next send; a refresh reads it if it came back.
        if (metadata.reclaimedAt) { try { metadata = await this.worktrees.inspect(metadata) } catch { /* Still reclaimed; the record already says so. */ } }
        else {
          try { metadata = await this.worktrees.inspect(await this.worktrees.restore(metadata)) }
          catch (error) { metadata = { ...metadata, status: 'error', error: error instanceof Error ? error.message : 'The working folder is unavailable.' } }
        }
        this.thread(threadId).worktree = metadata
        this.dirty = true; await this.flush(); this.publish()
        // A refresh is the user's or the window's ask, so the remote is read too, fetching when the interval allows.
        await this.readGitStatus(threadId, true)
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
      await this.readGitStatus(threadId, false)
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
        if (current.worktree === worktree && (inspected.branch !== worktree.branch || worktree.status !== 'ready' || worktree.reclaimedAt || current.workingDirectory === undefined)) {
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
    // Creation changes older threads' settlement too. Keep that transaction apart from
    // settlement edits in the same project so failed writes cannot cross their rollbacks.
    return this.onLane(key, () => command.type === 'create-thread'
      ? this.onLane(command.projectId, () => this.executeOne(command), this.organizationLanes)
      : this.executeOne(command))
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
      const thread: AgentThread = { hostId: this.hostId, id: command.threadId, projectId: command.projectId, title: command.title, modelId: command.modelId,
        titleSource: command.titleSource ?? 'default',
        ...(model.providerId ? { providerId: model.providerId } : {}),
        ...(command.reasoningEffort ?? model.defaultReasoningEffort ? { reasoningEffort: command.reasoningEffort ?? model.defaultReasoningEffort! } : {}),
        ...(command.runtimeMode ? { runtimeMode: command.runtimeMode } : {}),
        ...(command.providerMode ? { providerMode: command.providerMode } : {}),
        worktree: await this.selectedWorkingCopy(command.projectId, { ...command, workingCopy: command.workingCopy ?? this.workingCopyDefault(command.projectId) }),
        status: 'idle', messages: [], requests: [], workspaceSettledAt: null, nativeSessionStarted: false }
      if (thread.worktree?.mode === 'shared') thread.workingDirectory = thread.worktree.path
      // New work reopens the folder, while the work put aside stays settled.
      // Re-read after working-copy preparation, which can accept a fresh snapshot.
      const project = this.state.snapshot.projects.find(item => item.id === command.projectId)!
      const projectSettledAt = project.workspaceSettledAt ?? null
      const previousSettlement = new Map<string, string | null | undefined>()
      if (projectSettledAt !== null) {
        for (const existing of this.state.snapshot.threads) {
          if (existing.projectId !== project.id || existing.workspaceSettledAt != null) continue
          previousSettlement.set(existing.id, existing.workspaceSettledAt)
          existing.workspaceSettledAt = projectSettledAt
        }
        project.workspaceSettledAt = null
      }
      this.state.snapshot.threads.push(thread)
      this.state.creations.push({ threadId: thread.id, projectId: thread.projectId, commandId: randomUUID(), phase: 'unstarted' })
      this.dirty = true
      try { await this.flush() }
      catch (error) {
        this.state.snapshot.threads = this.state.snapshot.threads.filter(item => item.id !== thread.id)
        this.state.creations = this.state.creations.filter(item => item.threadId !== thread.id)
        const currentProject = this.state.snapshot.projects.find(item => item.id === command.projectId)
        if (currentProject && projectSettledAt !== null) currentProject.workspaceSettledAt = projectSettledAt
        for (const existing of this.state.snapshot.threads) {
          if (previousSettlement.has(existing.id)) existing.workspaceSettledAt = previousSettlement.get(existing.id)
        }
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
        if (thread.providerMode && !model.providerModes?.some(mode => mode.id === thread.providerMode)) delete thread.providerMode
      }
      if (command.reasoningEffort !== undefined) thread.reasoningEffort = command.reasoningEffort
      if (command.runtimeMode !== undefined) thread.runtimeMode = command.runtimeMode
      if (command.providerMode !== undefined) thread.providerMode = command.providerMode
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
            ...(thread.runtimeMode ? { runtimeMode: thread.runtimeMode } : {}),
            ...(thread.providerMode ? { providerMode: thread.providerMode } : {}) })
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
   * A side call on the thread's own client (ADR-0026). A thread whose native session has not started has
   * no client, model or folder to ask yet, so it gets nothing rather than a session started for it.
   */
  async writeShortText(threadId: string, prompt: ShortTextPrompt, signal?: AbortSignal): Promise<string | null> {
    const thread = this.state.snapshot.threads.find(item => item.id === threadId)
    if (!thread || thread.nativeSessionStarted === false || !this.inner.writeShortText) return null
    return this.inner.writeShortText(threadId, prompt, signal)
  }
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
      for (const thread of this.state.snapshot.threads) if (!wanted.has(thread.id)) {
        this.storedAnchors.delete(thread.id)
        if (thread.messages.length) this.unloadWindow(thread.id)
      }
    }
    for (const id of [...this.watched.keys()]) if (!wanted.has(id)) {
      this.watched.delete(id)
      this.hidden.delete(id)
      this.storedAnchors.delete(id)
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
    if (!this.ready) return
    const snapshot = this.state.snapshot
    snapshot.providers?.filter(item => !provider || item.id === provider).forEach(item => { item.connection = 'disconnected' })
    snapshot.models.filter(model => !provider || model.providerId === provider).forEach(model => { model.ready = false })
    snapshot.connected = snapshot.providers?.some(item => item.connection === 'connected') ?? false
    for (const thread of snapshot.threads) if (!provider || thread.providerId === provider) {
      delete thread.monitoring; delete thread.backgroundWork
      this.trackSubagents(thread, false)
      thread.subagentSummary = this.subagentSummaries.get(thread.id) ?? EMPTY_SUBAGENT_SUMMARY
    }
    this.dirty = true
    void this.flush().catch(() => { this.saveError = 'Workspace history could not be saved. Restore access to local storage and refresh.'; this.publish() })
    this.publish()
  }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
}
