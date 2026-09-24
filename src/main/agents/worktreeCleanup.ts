import { execFile } from 'node:child_process'
import type { AgentHostSnapshot, AgentThread } from '../../shared/agents'
import type { WorktreeCleanupRules } from '../../shared/settings'
import { isWorkspaceThreadSettled } from '../../shared/threadActivity'
import { runWorktreeGit, type RunGit } from './threadWorktrees'

/**
 * The part of WorkspaceHost the sweep needs: what threads there are, a way to reclaim, a way to hear a settle,
 * and a way to settle a thread for Auto-settle merged threads.
 */
export interface WorktreeCleanupHost {
  workspaceSnapshot(): AgentHostSnapshot
  reclaimThreadWorktree(threadId: string, options: { automatic: true }): Promise<unknown>
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void
  setWorkspaceSettled?(kind: 'thread', id: string, settled: true): Promise<unknown>
}
export interface WorktreeCleanupDependencies {
  readonly host: WorktreeCleanupHost
  /** The rules as the user has them now; read at every sweep so a change applies without a restart. */
  readonly rules: () => WorktreeCleanupRules
  /** The Auto-settle merged threads setting, read at every sweep; absent, no thread is settled on its own. */
  readonly autoSettleMerged?: () => boolean
  readonly git?: RunGit
  /** Whether GitHub reports this branch's pull request merged. Absent, neither the merged rule nor auto-settle fires. */
  readonly pullRequestMerged?: (repositoryRoot: string, branch: string) => Promise<boolean>
  readonly now?: () => number
  readonly intervalMs?: number
  /** Stable event names only; never a path, a branch or a message. */
  readonly log?: (code: WorktreeCleanupEvent) => void
}
export type WorktreeCleanupEvent = 'worktree-cleanup-reclaimed' | 'worktree-cleanup-skipped' | 'thread-auto-settled' | 'thread-auto-settle-skipped'
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const rulesOn = (rules: WorktreeCleanupRules): boolean => rules.afterDays !== null || rules.merged || rules.onSettle || rules.unchanged

/** When the thread last did something, for the idle rule. Unknown counts as now, so an unknown thread is never old. */
function lastActivity(thread: AgentThread, now: number): number {
  const stamps = [thread.updatedAt, thread.summary?.lastMessageAt, thread.messages.at(-1)?.createdAt, thread.workspaceSettledAt ?? undefined]
    .flatMap(value => { const time = value ? Date.parse(value) : Number.NaN; return Number.isFinite(time) ? [time] : [] })
  return stamps.length ? Math.max(...stamps) : now
}

/**
 * Reclaims worktrees under the rules the user turned on (ADR-0019): every hour, when the rules change,
 * and when a thread is settled. It only ever asks WorkspaceHost, whose own checks and the folder's own
 * state decide; a folder with uncommitted work or anything but dependencies in its ignored files is left
 * alone, and the branch is always kept. The same sweep settles threads whose pull request merged, when the
 * user turned Auto-settle merged threads on.
 */
export class WorktreeCleanup {
  private timer: ReturnType<typeof setInterval> | undefined
  private unsubscribe: (() => void) | undefined
  private running: Promise<void> = Promise.resolve()
  private queued = false
  private settled = new Set<string>()
  /** Thread and branch pairs Auto-settle merged threads already settled while Sotto runs, so a restore sticks. */
  private readonly autoSettled = new Set<string>()
  private mergedAnswers = new Map<string, Promise<boolean>>()
  private disposed = false
  private readonly git: RunGit
  private readonly now: () => number
  constructor(private readonly dependencies: WorktreeCleanupDependencies) {
    this.git = dependencies.git ?? runWorktreeGit
    this.now = dependencies.now ?? Date.now
  }
  start(): void {
    this.settled = this.settledThreads(this.dependencies.host.workspaceSnapshot())
    this.unsubscribe = this.dependencies.host.subscribe(snapshot => {
      const settled = this.settledThreads(snapshot)
      const newlySettled = [...settled].some(id => !this.settled.has(id))
      this.settled = settled
      if (newlySettled && this.dependencies.rules().onSettle) this.request()
    })
    this.timer = setInterval(() => this.request(), this.dependencies.intervalMs ?? HOUR_MS)
    this.timer.unref?.()
    this.request()
  }
  /** The rules changed; look again rather than wait for the hour. */
  settingsChanged(): void { this.request() }
  dispose(): void { this.disposed = true; if (this.timer) clearInterval(this.timer); this.unsubscribe?.() }
  /** Stops sweeping and waits for a sweep already under way, which stops before its next worktree. */
  close(): Promise<void> { this.dispose(); return this.running }
  /** One sweep at a time; a request during a sweep runs one more afterwards. */
  request(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.queued) return this.running
    this.queued = true
    this.running = this.running.then(async () => { this.queued = false; await this.sweep() }).catch(() => undefined)
    return this.running
  }
  private autoSettleOn(): boolean {
    try { return this.dependencies.autoSettleMerged?.() === true && Boolean(this.dependencies.pullRequestMerged && this.dependencies.host.setWorkspaceSettled) } catch { return false }
  }
  private merged(repositoryRoot: string, branch: string): Promise<boolean> {
    const key = `${repositoryRoot}\0${branch}`
    let answer = this.mergedAnswers.get(key)
    if (!answer) {
      answer = this.dependencies.pullRequestMerged ? this.dependencies.pullRequestMerged(repositoryRoot, branch).catch(() => false) : Promise.resolve(false)
      this.mergedAnswers.set(key, answer)
    }
    return answer
  }
  /**
   * Auto-settle merged threads: a thread at rest whose branch's pull request GitHub reports merged is settled,
   * once per thread and branch while Sotto runs, so a thread the user restores stays restored. Settling removes
   * nothing; the on-settle cleanup rule, when the user turned it on, then decides about the folder as it would
   * for any settle. The branch is the one the thread last sent on (a worktree's own branch before its first
   * send), never the repository's default branch.
   */
  private async settleMerged(): Promise<void> {
    const snapshot = this.dependencies.host.workspaceSnapshot()
    for (const thread of snapshot.threads) {
      if (this.disposed || !this.autoSettleOn()) return
      const worktree = thread.worktree
      const project = snapshot.projects.find(item => item.id === thread.projectId)
      if (!worktree?.repositoryRoot || thread.nativeSessionStarted === false || thread.archivedAt || isWorkspaceThreadSettled(thread, project)) continue
      if (thread.status === 'running' || thread.requests.length) continue
      const branch = worktree.mode === 'independent' ? worktree.sentBranch ?? worktree.branch : worktree.sentBranch
      if (!branch || branch === worktree.git?.defaultBranch || branch === 'main' || branch === 'master') continue
      const key = `${thread.id}\0${branch}`
      if (this.autoSettled.has(key)) continue
      try {
        if (!await this.merged(worktree.repositoryRoot, branch)) continue
        await this.dependencies.host.setWorkspaceSettled!('thread', thread.id, true)
        this.autoSettled.add(key)
        this.dependencies.log?.('thread-auto-settled')
      } catch { this.dependencies.log?.('thread-auto-settle-skipped') }
    }
  }
  private settledThreads(snapshot: AgentHostSnapshot): Set<string> {
    return new Set(snapshot.threads.filter(thread => isWorkspaceThreadSettled(thread, snapshot.projects.find(project => project.id === thread.projectId))).map(thread => thread.id))
  }
  async sweep(): Promise<void> {
    const rules = this.dependencies.rules()
    const settle = this.autoSettleOn()
    if (!rulesOn(rules) && !settle) return
    // GitHub is asked once per branch in a sweep, whichever of the two wants the answer.
    this.mergedAnswers = new Map()
    if (settle) await this.settleMerged()
    if (!rulesOn(rules) || this.disposed) return
    const snapshot = this.dependencies.host.workspaceSnapshot()
    const defaults = new Map<string, string | null>()
    for (const thread of snapshot.threads) {
      if (this.disposed) return
      const worktree = thread.worktree
      if (worktree?.mode !== 'independent' || worktree.status !== 'ready' || !worktree.path || !worktree.repositoryRoot || !worktree.branch || worktree.reused || worktree.reclaimedAt) continue
      if (thread.status === 'running' || thread.requests.length) continue
      try {
        if (!await this.eligible(thread, rules, defaults)) continue
        await this.dependencies.host.reclaimThreadWorktree(thread.id, { automatic: true })
        this.dependencies.log?.('worktree-cleanup-reclaimed')
      } catch { this.dependencies.log?.('worktree-cleanup-skipped') }
    }
  }
  private async eligible(thread: AgentThread, rules: WorktreeCleanupRules, defaults: Map<string, string | null>): Promise<boolean> {
    const snapshot = this.dependencies.host.workspaceSnapshot()
    const worktree = thread.worktree!
    if (rules.onSettle && isWorkspaceThreadSettled(thread, snapshot.projects.find(project => project.id === thread.projectId))) return true
    if (rules.afterDays !== null && lastActivity(thread, this.now()) < this.now() - rules.afterDays * DAY_MS) return true
    if (rules.unchanged) {
      const repositoryRoot = worktree.repositoryRoot!
      if (!defaults.has(repositoryRoot)) defaults.set(repositoryRoot, await this.defaultBranch(repositoryRoot))
      const base = defaults.get(repositoryRoot)
      if (base) {
        const head = (await this.git(worktree.path!, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
        const integrated = await this.git(repositoryRoot, ['merge-base', '--is-ancestor', head, `refs/heads/${base}`]).then(() => true, () => false)
        if (integrated) return true
      }
    }
    if (rules.merged && this.dependencies.pullRequestMerged && await this.merged(worktree.repositoryRoot!, worktree.branch!)) return true
    return false
  }
  /** The repository's default branch as the local clone knows it: origin's HEAD when recorded, else main or master. */
  private async defaultBranch(repositoryRoot: string): Promise<string | null> {
    const origin = await this.git(repositoryRoot, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']).then(value => value.trim().replace(/^origin\//u, ''), () => '')
    for (const candidate of [origin, 'main', 'master'].filter(Boolean)) {
      if (await this.git(repositoryRoot, ['rev-parse', '--verify', '-q', `refs/heads/${candidate}`]).then(() => true, () => false)) return candidate
    }
    return null
  }
}

/** Asks GitHub through `gh`, the way the Changes panel already does, whether this branch's pull request is merged. */
export function githubPullRequestMerged(cwd: string, branch: string): Promise<boolean> {
  return new Promise((accept, reject) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GCM_INTERACTIVE: 'never' }
    execFile('gh', ['pr', 'list', '--head', branch, '--state', 'merged', '--limit', '1', '--json', 'number'], { cwd, env, windowsHide: true, timeout: 30_000, maxBuffer: 200_000, encoding: 'utf8' }, (error, stdout) => {
      if (error) { reject(error); return }
      try { accept(Array.isArray(JSON.parse(stdout)) && JSON.parse(stdout).length > 0) } catch (parseError) { reject(parseError) }
    })
  })
}
