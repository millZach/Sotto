import { execFile } from 'node:child_process'
import type { AgentHostSnapshot, AgentThread } from '../../shared/agents'
import type { WorktreeCleanupRules } from '../../shared/settings'
import type { ThreadClearKeptReason } from '../../shared/threadClear'
import { isWorkspaceThreadSettled } from '../../shared/threadActivity'
import { isWatcherWorkActive } from '../../shared/watcherOverview'
import { delegatedThreadsBelow } from '../../shared/delegation'
import { baseRepository, GitHubRateLimited, isRateLimitAnswer, readGitHubRemotes, type GitHubHosts, type GitHubRateLimit } from './github'
import { runWorktreeGit, type RunGit } from './threadWorktrees'
import { pullRequestKey } from '../../shared/gitPullRequests'
import type { PullRequestObservation } from './watcherEvidence'
import { PULL_REQUEST_HOST } from './backgroundPullRequestReads'

/**
 * The part of WorkspaceHost the sweep needs: what threads there are, a way to reclaim, a way to hear a settle,
 * and a way to settle a thread for Auto-settle merged threads.
 */
export interface WorktreeCleanupHost {
  workspaceSnapshot(): AgentHostSnapshot
  reclaimThreadWorktree(threadId: string, options: { automatic: true; expectedMergedTip?: string }): Promise<unknown>
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void
  /** Reports the current IDs immediately, then on publication, without copying histories. */
  subscribeSettledThreads?(listener: (ids: readonly string[]) => void): () => void
  setWorkspaceSettled?(kind: 'thread', id: string, settled: true, options?: MergedSettleExpectation): Promise<unknown>
  /** Brings the thread's links to a pull request to the state GitHub just gave (#1147). */
  notePullRequestState?(read: PullRequestObservation): void
}
/**
 * What Auto-settle merged threads saw when it decided, which the host checks again under the thread's lane before it
 * settles: the branch the thread last sent on, or null when it never recorded one, and that branch's local tip, or null
 * when the branch is gone.
 */
export interface MergedSettleExpectation { readonly expectedMergedBranch: string | null; readonly expectedMergedTip: string | null }
/** A pull request as GitHub reports it now: its state and the name and commit of its head branch. */
export interface PullRequestState { readonly state: 'open' | 'closed' | 'merged'; readonly headRefName: string; readonly headRefOid: string | null }
export interface WorktreeCleanupDependencies {
  readonly host: WorktreeCleanupHost
  /** The rules as the user has them now; read at every sweep so a change applies without a restart. */
  readonly rules: () => WorktreeCleanupRules
  /** The Auto-settle merged threads setting, read at every sweep; absent, no thread is settled on its own. */
  readonly autoSettleMerged?: () => boolean
  /**
   * Clear settled threads after (ADR-0140), given only while the Owl feature is on: the setting, read at every sweep, and
   * the coordinator's clear. It runs after the folders, so a folder a rule removes first is not read twice.
   */
  readonly clearSettledThreads?: {
    readonly afterDays: () => number | null
    /** `keep` is asked of each thread the coordinator would otherwise clear. */
    readonly clear: (days: number, keep?: (thread: AgentThread) => Promise<ThreadClearKeptReason | null>) => Promise<void>
  }
  /** Removes unsent threads no client holds (ADR-0155), on every host and track. It runs before the folders. */
  readonly removeUnsentThreads?: () => Promise<void>
  readonly git?: RunGit
  /** Whether GitHub reports this branch's pull request merged. Absent, neither the merged rule nor auto-settle fires. */
  readonly pullRequestMerged?: (repositoryRoot: string, branch: string, github?: SharedGitHub) => Promise<boolean>
  /**
   * One pull request a thread links, by URL. Given, Auto-settle merged threads also settles a thread whose branch is gone
   * or was never recorded, from its own pull request links.
   */
  readonly pullRequestState?: (url: string, github?: SharedGitHub) => Promise<PullRequestState>
  /**
   * The head branches of the repository's open pull requests on GitHub now. Given, Clear settled threads after keeps a
   * thread whose branch is among them, and every thread with a branch in a repository it could not ask (ADR-0140).
   */
  readonly openPullRequestBranches?: (repositoryRoot: string) => Promise<ReadonlySet<string>>
  readonly now?: () => number
  readonly intervalMs?: number
  /** Stable event names only; never a path, a branch or a message. */
  readonly log?: (code: WorktreeCleanupEvent) => void
}
export type WorktreeCleanupEvent = 'worktree-cleanup-reclaimed' | 'worktree-cleanup-skipped' | 'thread-auto-settled' | 'thread-auto-settle-skipped'
  | 'thread-auto-settle-branch-gone' | 'thread-auto-settle-pull-request-open' | 'thread-auto-settle-branch-differs'
const HOUR_MS = 3_600_000
/**
 * A thread still at work or waiting on the user: its turn, background work, sub-agents working or not yet known to have
 * ended, or monitoring, as Settle finished threads counts them. Neither sweep settles it or takes its folder, where that
 * work may still be writing (October 23, 2026).
 */
const busy = (thread: AgentThread): boolean => thread.requests.length > 0 || isWatcherWorkActive(thread) || (thread.subagentSummary?.unknown ?? 0) > 0
/** The same of a thread or, when it is to be settled, a thread it delegated to (ADR-0081), which settles with it. */
function atWork(threads: readonly AgentThread[], threadId: string, delegated: boolean): boolean {
  const thread = threads.find(item => item.id === threadId)
  if (!thread || busy(thread)) return true
  if (!delegated || !threads.some(item => item.delegatedBy)) return false
  return delegatedThreadsBelow(threads, threadId).some(id => { const below = threads.find(item => item.id === id); return below !== undefined && busy(below) })
}
const DAY_MS = 86_400_000
const rulesOn = (rules: WorktreeCleanupRules): boolean => rules.afterDays !== null || rules.merged || rules.onSettle || rules.unchanged

/** When the thread last did something, for the idle rule. Unknown counts as now, so an unknown thread is never old. */
function lastActivity(thread: AgentThread, now: number): number {
  const stamps = [thread.updatedAt, thread.summary?.lastMessageAt, thread.messages.at(-1)?.createdAt, thread.workspaceSettledAt ?? undefined]
    .flatMap(value => { const time = value ? Date.parse(value) : Number.NaN; return Number.isFinite(time) ? [time] : [] })
  return stamps.length ? Math.max(...stamps) : now
}

/**
 * Reclaims worktrees under the rules the user turned on (ADR-0041): every hour, when the rules change,
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
  /** Pull requests GitHub reported merged while Sotto runs, by key, with their head branch: merged is final. */
  private readonly mergedPullRequests = new Map<string, string>()
  /** Each skip reason is logged once a sweep, so a thread left alone every hour does not fill the log. */
  private logged = new Set<WorktreeCleanupEvent>()
  /** Pull requests asked about in this sweep, by key, so threads that share one ask once. */
  private linkAnswers = new Map<string, Promise<PullRequestState>>()
  private defaults = new Map<string, string | null>()
  private disposed = false
  /** The rules and Auto-settle merged threads as the last sweep request saw them. */
  private seenSettings: string | undefined
  private readonly git: RunGit
  private readonly now: () => number
  constructor(private readonly dependencies: WorktreeCleanupDependencies) {
    this.git = dependencies.git ?? runWorktreeGit
    this.now = dependencies.now ?? Date.now
  }
  start(): void {
    const changed = (ids: Iterable<string>) => {
      const settled = new Set(ids)
      const newlySettled = [...settled].some(id => !this.settled.has(id))
      this.settled = settled
      if (newlySettled && this.dependencies.rules().onSettle) this.request()
    }
    const host = this.dependencies.host
    if (host.subscribeSettledThreads) {
      let initial = true
      this.unsubscribe = host.subscribeSettledThreads(ids => {
        // The immediate delivery seeds existing settlement; start requests its own sweep below.
        if (initial) { initial = false; this.settled = new Set(ids) }
        else changed(ids)
      })
    } else {
      this.settled = this.settledThreads(host.workspaceSnapshot())
      this.unsubscribe = host.subscribe(snapshot => changed(this.settledThreads(snapshot)))
    }
    this.timer = setInterval(() => this.request(), this.dependencies.intervalMs ?? HOUR_MS)
    this.timer.unref?.()
    this.seenSettings = this.settingsKey()
    this.request()
  }
  /**
   * A setting was saved: look again rather than wait for the hour, but only when the rules or Auto-settle merged threads
   * changed. Any other save asks GitHub nothing, so the merged check runs no more often than the sweep (#820).
   */
  settingsChanged(): void {
    const key = this.settingsKey()
    if (key === this.seenSettings) return
    this.seenSettings = key
    this.request()
  }
  /** What the sweep depends on among the settings, in one comparable string. */
  private settingsKey(): string {
    const rules = this.dependencies.rules()
    let settle = false
    try { settle = this.dependencies.autoSettleMerged?.() === true } catch { /* Read as off, as the sweep does. */ }
    return JSON.stringify([rules.afterDays, rules.merged, rules.onSettle, rules.unchanged, settle, this.clearAfterDays()])
  }
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
  private tipOf(repositoryRoot: string, branch: string): Promise<string> {
    return this.git(repositoryRoot, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}^{commit}`]).then(value => value.trim(), () => '')
  }
  private async merged(repositoryRoot: string, branch: string): Promise<string | null> {
    const tip = await this.tipOf(repositoryRoot, branch)
    if (!tip) return null
    const key = `${repositoryRoot}\0${branch}\0${tip}`
    let answer = this.mergedAnswers.get(key)
    if (!answer) {
      answer = this.dependencies.pullRequestMerged ? this.dependencies.pullRequestMerged(repositoryRoot, branch).catch(() => false) : Promise.resolve(false)
      this.mergedAnswers.set(key, answer)
    }
    return await answer && await this.tipOf(repositoryRoot, branch) === tip ? tip : null
  }
  /** Whether the branch is gone from a repository Git can still read; a folder Git cannot read says nothing about it. */
  private async branchGone(repositoryRoot: string, branch: string): Promise<boolean> {
    return !await this.tipOf(repositoryRoot, branch) && await this.git(repositoryRoot, ['rev-parse', '--git-dir']).then(() => true, () => false)
  }
  private skipped(event: WorktreeCleanupEvent): void {
    if (!this.logged.has(event)) this.dependencies.log?.(event)
    this.logged.add(event)
  }
  /** The thread's links not known closed, by key: its branch's own pull request and the ones it links. */
  private openLinks(thread: AgentThread | undefined): Map<string, string> {
    const links = new Map<string, string>()
    for (const link of [thread?.worktree?.git?.pullRequest, ...thread?.pullRequests ?? []]) {
      const key = link && link.state !== 'closed' ? pullRequestKey(link.url) : null
      if (key && !links.has(key)) links.set(key, link!.url)
    }
    return links
  }
  /**
   * The links asked about when the thread's own pull request links say its work merged, for a thread whose branch is
   * gone or was never recorded: GitHub reports none of them open, and one merged from `branch` (any, when there is no
   * branch); else null. Each answer also brings the thread's link up to date, so a merged one stops reading open even
   * when the thread is not settled.
   */
  private async linksMerged(thread: AgentThread, branch: string | null): Promise<ReadonlySet<string> | null> {
    const ask = this.dependencies.pullRequestState
    if (!ask) return null
    const links = this.openLinks(thread)
    let mergedFromBranch = false, mergedElsewhere = false
    for (const [key, url] of links) {
      let head = this.mergedPullRequests.get(key)
      if (head === undefined) {
        let answer = this.linkAnswers.get(key)
        if (!answer) { answer = ask(url); this.linkAnswers.set(key, answer) }
        const read = await answer
        this.dependencies.host.notePullRequestState?.({ url, head: read.headRefOid, state: read.state, availability: 'available', observedAt: new Date(this.now()).toISOString() })
        if (read.state === 'open') { this.skipped('thread-auto-settle-pull-request-open'); return null }
        if (read.state !== 'merged') continue
        head = read.headRefName
        this.mergedPullRequests.set(key, head)
      }
      if (branch === null || head === branch) mergedFromBranch = true
      else mergedElsewhere = true
    }
    if (!mergedFromBranch && mergedElsewhere) this.skipped('thread-auto-settle-branch-differs')
    return mergedFromBranch ? new Set(links.keys()) : null
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
      if (thread.nativeSessionStarted === false || thread.archivedAt || isWorkspaceThreadSettled(thread, project)) continue
      if (atWork(snapshot.threads, thread.id, true)) continue
      const branch = (worktree?.mode === 'independent' ? worktree.sentBranch ?? worktree.branch : worktree?.sentBranch) ?? null
      const key = `${thread.id}\0${branch ?? ''}`
      if (this.autoSettled.has(key)) continue
      try {
        let expected: MergedSettleExpectation
        let asked: ReadonlySet<string> | null = null
        if (branch === null) {
          // No branch to ask about, as in a folder that is not a repository or a checkout that was never on one.
          if (!(asked = await this.linksMerged(thread, null))) continue
          expected = { expectedMergedBranch: null, expectedMergedTip: null }
        } else {
          if (!worktree?.repositoryRoot || branch === await this.defaultBranchOf(worktree.repositoryRoot)) continue
          if (await this.tipOf(worktree.repositoryRoot, branch)) {
            const tip = await this.merged(worktree.repositoryRoot, branch)
            if (!tip) continue
            expected = { expectedMergedBranch: branch, expectedMergedTip: tip }
          } else {
            // The branch was deleted, as it is once its pull request merges: gone, it holds no current work.
            if (!await this.branchGone(worktree.repositoryRoot, branch)) continue
            this.skipped('thread-auto-settle-branch-gone')
            if (!(asked = await this.linksMerged(thread, branch))) continue
            expected = { expectedMergedBranch: branch, expectedMergedTip: null }
          }
        }
        // Asked again as it now stands: work may have started, or a pull request been linked, while Git and GitHub were asked.
        const now = this.dependencies.host.workspaceSnapshot().threads
        if (atWork(now, thread.id, true)) continue
        if (asked && [...this.openLinks(now.find(item => item.id === thread.id)).keys()].some(key => !asked.has(key))) continue
        await this.dependencies.host.setWorkspaceSettled!('thread', thread.id, true, expected)
        this.autoSettled.add(key)
        this.dependencies.log?.('thread-auto-settled')
      } catch { this.dependencies.log?.('thread-auto-settle-skipped') }
    }
  }
  /** The repository's default branch, looked up once per repository in a sweep. */
  private async defaultBranchOf(repositoryRoot: string): Promise<string | null> {
    if (!this.defaults.has(repositoryRoot)) this.defaults.set(repositoryRoot, await this.defaultBranch(repositoryRoot))
    return this.defaults.get(repositoryRoot) ?? null
  }
  private settledThreads(snapshot: AgentHostSnapshot): Set<string> {
    return new Set(snapshot.threads.filter(thread => isWorkspaceThreadSettled(thread, snapshot.projects.find(project => project.id === thread.projectId))).map(thread => thread.id))
  }
  /** Clear settled threads after's days, or null for Never or when the feature is off. */
  private clearAfterDays(): number | null {
    try { return this.dependencies.clearSettledThreads?.afterDays() ?? null } catch { return null }
  }
  async sweep(): Promise<void> {
    await this.dependencies.removeUnsentThreads?.().catch(() => undefined)
    if (this.disposed) return
    await this.sweepWorktrees()
    const days = this.clearAfterDays()
    if (days !== null && !this.disposed) await this.dependencies.clearSettledThreads!.clear(days, this.openPullRequestHold()).catch(() => undefined)
  }
  /**
   * What a sweep's clear asks of a thread before it goes (ADR-0140 decision 3): whether GitHub has an open pull request
   * for its branch now, since the one Sotto last read may be old or never read for a thread no one has opened in weeks.
   * GitHub is asked once per repository in a sweep; a repository it could not ask keeps every thread with a branch.
   */
  private openPullRequestHold(): ((thread: AgentThread) => Promise<ThreadClearKeptReason | null>) | undefined {
    const open = this.dependencies.openPullRequestBranches
    if (!open) return undefined
    const asked = new Map<string, Promise<ReadonlySet<string> | null>>()
    return async thread => {
      const worktree = thread.worktree
      const branch = worktree?.mode === 'independent' ? worktree.sentBranch ?? worktree.branch : worktree?.sentBranch
      if (!worktree?.repositoryRoot || !branch) return null
      let branches = asked.get(worktree.repositoryRoot)
      if (!branches) { branches = open(worktree.repositoryRoot).catch(() => null); asked.set(worktree.repositoryRoot, branches) }
      const read = await branches
      return read === null || read.has(branch) ? 'pull-request' : null
    }
  }
  private async sweepWorktrees(): Promise<void> {
    const rules = this.dependencies.rules()
    const settle = this.autoSettleOn()
    if (!rulesOn(rules) && !settle) return
    // GitHub is asked once per branch in a sweep, whichever of the two wants the answer.
    this.mergedAnswers = new Map()
    this.defaults = new Map()
    this.logged = new Set()
    this.linkAnswers = new Map()
    if (settle) await this.settleMerged()
    if (!rulesOn(rules) || this.disposed) return
    const snapshot = this.dependencies.host.workspaceSnapshot()
    const defaults = this.defaults
    for (const thread of snapshot.threads) {
      if (this.disposed) return
      const worktree = thread.worktree
      if (worktree?.mode !== 'independent' || worktree.status !== 'ready' || !worktree.path || !worktree.repositoryRoot || !worktree.branch || worktree.reused || worktree.reclaimedAt) continue
      if (busy(thread)) continue
      try {
        const eligibility = await this.eligible(thread, rules, defaults)
        if (!eligibility) continue
        // Asked again as it now stands: work may have started while the folder was looked at.
        if (atWork(this.dependencies.host.workspaceSnapshot().threads, thread.id, false)) continue
        await this.dependencies.host.reclaimThreadWorktree(thread.id, { automatic: true, ...eligibility })
        this.dependencies.log?.('worktree-cleanup-reclaimed')
      } catch { this.dependencies.log?.('worktree-cleanup-skipped') }
    }
  }
  private async eligible(thread: AgentThread, rules: WorktreeCleanupRules, defaults: Map<string, string | null>): Promise<{ expectedMergedTip?: string } | null> {
    const snapshot = this.dependencies.host.workspaceSnapshot()
    const worktree = thread.worktree!
    if (rules.onSettle && isWorkspaceThreadSettled(thread, snapshot.projects.find(project => project.id === thread.projectId))) return {}
    if (rules.afterDays !== null && lastActivity(thread, this.now()) < this.now() - rules.afterDays * DAY_MS) return {}
    if (rules.unchanged) {
      const repositoryRoot = worktree.repositoryRoot!
      if (!defaults.has(repositoryRoot)) defaults.set(repositoryRoot, await this.defaultBranch(repositoryRoot))
      const base = defaults.get(repositoryRoot)
      if (base) {
        const head = (await this.git(worktree.path!, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
        const integrated = await this.git(repositoryRoot, ['merge-base', '--is-ancestor', head, `refs/heads/${base}`]).then(() => true, () => false)
        if (integrated) return {}
      }
    }
    if (rules.merged && this.dependencies.pullRequestMerged) {
      const tip = await this.merged(worktree.repositoryRoot!, worktree.branch!)
      if (tip) return { expectedMergedTip: tip }
    }
    return null
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

/** The process's GitHub rate limit and its answer to which hosts gh asks as GitHub, which the merged check shares (#820). */
export interface SharedGitHub { readonly rateLimit: GitHubRateLimit; readonly hosts: GitHubHosts }

/** The GitHub host the repository at `cwd` is on, when the shared rate limit is given and a remote names one. */
async function githubHostOf(cwd: string, github: SharedGitHub | undefined): Promise<string | null> {
  return github ? baseRepository(await readGitHubRemotes((folder, command, args) => command === 'git' ? runWorktreeGit(folder, [...args]) : Promise.reject(new Error('Only Git reads remotes.')), cwd, github.hosts))?.host ?? null : null
}
/**
 * Asks `gh` once, as the timer does (#820) when the process's shared `github` and the host are given: not while GitHub has
 * paused the sign-in or the reserve is reached, which rejects with GitHubRateLimited; and a rate-limited answer pauses the
 * status reader's background questions too. gh's words are only tested, never kept.
 */
async function askGitHub(args: readonly string[], options: { cwd?: string; maxBuffer: number; github: SharedGitHub | undefined; host: string | null }): Promise<string> {
  const { github, host } = options
  const retryAt = github && host ? github.rateLimit.retryAt(host, 'background') : null
  if (retryAt !== null) throw new GitHubRateLimited(retryAt)
  const asked = github && host ? github.rateLimit.asking() : 0
  return new Promise<string>((accept, reject) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GCM_INTERACTIVE: 'never' }
    execFile('gh', [...args], { ...options.cwd ? { cwd: options.cwd } : {}, env, windowsHide: true, timeout: 30_000, maxBuffer: options.maxBuffer, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const words = typeof stderr === 'string' ? stderr : ''
        if (github && host && isRateLimitAnswer(words)) { reject(new GitHubRateLimited(github.rateLimit.limited(host, words))); return }
        reject(error); return
      }
      if (github && host) github.rateLimit.answered(host, asked, null)
      accept(stdout)
    })
  })
}

/** The head branches of the open pull requests GitHub lists for the repository at `cwd` (ADR-0140). Throws when it cannot ask. */
export async function githubOpenPullRequestBranches(cwd: string, github?: SharedGitHub): Promise<ReadonlySet<string>> {
  const stdout = await askGitHub(['pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'headRefName'], { cwd, maxBuffer: 2_000_000, github, host: await githubHostOf(cwd, github) })
  const prs: unknown = JSON.parse(stdout)
  if (!Array.isArray(prs)) throw new Error('GitHub did not list pull requests.')
  return new Set(prs.flatMap(pr => pr && typeof pr === 'object' && typeof pr.headRefName === 'string' ? [pr.headRefName as string] : []))
}
/**
 * Whether GitHub reports this branch's pull request merged at the branch's current local tip, asked as `askGitHub` says;
 * a rate-limited ask rejects, so the branch is taken as not merged until the next sweep.
 */
export async function githubPullRequestMerged(cwd: string, branch: string, github?: SharedGitHub): Promise<boolean> {
  const tipOf = () => runWorktreeGit(cwd, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}^{commit}`]).then(value => value.trim(), () => '')
  const tip = await tipOf()
  if (!tip) return false
  const stdout = await askGitHub(['pr', 'list', '--head', branch, '--state', 'merged', '--limit', '100', '--json', 'headRefOid'], { cwd, maxBuffer: 200_000, github, host: await githubHostOf(cwd, github) })
  const prs: unknown = JSON.parse(stdout)
  const merged = Array.isArray(prs) && prs.some(pr => pr && typeof pr === 'object' && pr.headRefOid === tip)
  // A branch moved while GitHub was answering is current work, even if its previous tip was merged.
  return merged && await tipOf() === tip
}
/** One pull request by its github.com URL, which gh reads from any folder, asked as `askGitHub` says. Throws when it cannot ask. */
export async function githubPullRequestState(url: string, github?: SharedGitHub): Promise<PullRequestState> {
  const stdout = await askGitHub(['pr', 'view', url, '--json', 'state,headRefName,headRefOid'], { maxBuffer: 200_000, github, host: PULL_REQUEST_HOST })
  const pr: unknown = JSON.parse(stdout)
  const { state, headRefName, headRefOid } = (pr && typeof pr === 'object' ? pr : {}) as Record<string, unknown>
  const known = typeof state === 'string' ? state.toLowerCase() : ''
  if ((known !== 'open' && known !== 'closed' && known !== 'merged') || typeof headRefName !== 'string') throw new Error('GitHub did not describe the pull request.')
  return { state: known, headRefName, headRefOid: typeof headRefOid === 'string' ? headRefOid : null }
}
