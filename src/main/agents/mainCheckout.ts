import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { LOCKFILE_NAMES, MAIN_CHECKOUT_FILES_MAX, MAIN_CHECKOUT_INTERVAL_MS, type MainCheckoutBlock, type MainCheckoutChanges, type MainCheckoutState,
  type ProjectMainCheckout } from '../../shared/mainCheckout'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { GitFastForwardResult } from './gitActions'
import { QUIET_GIT_ENV, runGitStatusCommand, type RunGitCommand } from './gitStatus'

/** The part of WorkspaceHost Keep main up to date needs. */
export interface MainCheckoutHost {
  /** This host's projects as the workspace has them now; a settled project is left where it is. */
  mainCheckoutProjects(): readonly { readonly id: string; readonly path: string; readonly settled: boolean }[]
  /**
   * Runs `work` under a mutation reservation of the checkout at `folder`, the one sends, Git actions and automatic pulls
   * share, once no thread working in that checkout is running, waiting on an answer, being set up, running a Git action or
   * holding queued work. Null, having run nothing, when anything holds it.
   */
  withProjectCheckout<T>(folder: string, work: () => Promise<T>): Promise<T | null>
  /** The checkout at `folder` moved forward: threads working in it read their Git status again. */
  projectCheckoutMoved?(folder: string): Promise<void>
}
export interface MainCheckoutDependencies {
  readonly host: MainCheckoutHost
  readonly status: { fetchRemote(cwd: string): Promise<boolean>; invalidate(folder?: string): void }
  readonly actions: { fastForward(cwd: string, expected: { readonly branch: string; readonly target: string }): Promise<GitFastForwardResult> }
  /** Whether the project's switch is on: its own override, else the Settings switch. Read at every pass. */
  readonly enabled: (projectId: string) => boolean
  /** Where a dependency notice is kept until the user dismisses it, across restarts. */
  readonly directory: string
  readonly run?: RunGitCommand
  readonly intervalMs?: number
  /** How long after start the first pass runs, so it never competes with the window opening. */
  readonly firstPassMs?: number
  /** How long a checkout a thread was working in waits before it is tried again. */
  readonly retryMs?: number
  /** How long merges are gathered before the checks they ask for run. */
  readonly mergeGatherMs?: number
  /** Stable event names only; never a path, a branch, a file or a remote. */
  readonly log?: (event: MainCheckoutEvent) => void
}
export type MainCheckoutEvent = 'main-checkout-updated' | 'main-checkout-blocked' | 'main-checkout-update-failed'

const FIRST_PASS_MS = 20_000
const RETRY_MS = 60_000
const MERGE_GATHER_MS = 3_000
/** Merged pull requests already acted on, so a merged one observed again asks for nothing; the oldest go first. */
const MERGED_REMEMBERED = 500
const IN_PROGRESS: readonly (readonly [string, 'merge' | 'rebase' | 'cherry-pick' | 'revert'])[] = [
  ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']]
const savedSchema = z.object({ version: z.literal(1), dependencies: z.record(z.string().min(1).max(256), z.object({
  branch: z.string().min(1).max(256), files: z.array(z.string().min(1).max(4_096)).min(1).max(MAIN_CHECKOUT_FILES_MAX) })) })
type Saved = z.infer<typeof savedSchema>

/** What one check of a checkout found: a line to show (null for none), or nothing new to say. */
type CheckOutcome = { readonly kind: 'line'; readonly line: Omit<ProjectMainCheckout, 'projectId' | 'dependencies'> | null
  readonly dependencies?: { readonly branch: string; readonly files: readonly string[] } }
  | { readonly kind: 'unchanged'; readonly retry: boolean }

/** `owner/repo` of a GitHub remote URL or pull request URL, lowercased; null for anything else. */
export function repositoryOf(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/u, '')
  const match = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?[^/:]+[:/]([^/]+)\/([^/]+?)(?:\.git)?(?:\/pull\/\d+.*)?$/iu.exec(trimmed)
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null
}

/**
 * Keep main up to date (ADR-0140). Every 15 minutes, once shortly after start, and when a pull request of a project's
 * repository merges, it fetches each project's checkout and fast-forwards the default branch there, but only when that
 * branch is checked out, has no local changes and no commits of its own, nothing is in progress, and no thread is working
 * in the checkout. It never switches a branch, stashes, resets, rebases or merges, and never installs anything. What
 * stopped it, and an update that changed a lockfile, become the project's line. A remote it cannot reach leaves the line
 * as it was, and a checkout a thread is working in is tried again a minute later.
 */
export class MainCheckoutKeeper {
  private readonly run: RunGitCommand
  private readonly store: AtomicJsonStore<Saved>
  private saved: Saved = { version: 1, dependencies: {} }
  private readonly lines = new Map<string, Omit<ProjectMainCheckout, 'dependencies'>>()
  /** The files Git named when it refused a fast-forward for an untracked file, by checkout, for Show changes. */
  private readonly untracked = new Map<string, readonly string[]>()
  private readonly listeners = new Set<(state: MainCheckoutState) => void>()
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>()
  /** Each checkout's folder as Git names it, by its comparison key, for the pass under way. */
  private readonly tops = new Map<string, string>()
  private readonly merged: string[] = []
  private readonly mergedRepositories = new Set<string>()
  private mergeTimer: ReturnType<typeof setTimeout> | undefined
  private interval: ReturnType<typeof setInterval> | undefined
  private firstPass: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> = Promise.resolve()
  /** The projects the next pass checks, or every project; undefined when no pass is queued. */
  private queued: Set<string> | 'all' | undefined
  private disposed = false
  private loaded: Promise<void> | undefined
  private lastPublished = ''

  constructor(private readonly dependencies: MainCheckoutDependencies) {
    this.run = dependencies.run ?? runGitStatusCommand
    this.store = new AtomicJsonStore<Saved>(join(dependencies.directory, 'main-checkout.json'), value => savedSchema.parse(value), () => ({ version: 1, dependencies: {} }))
  }

  start(): void {
    void this.load()
    this.firstPass = setTimeout(() => { void this.request('all') }, this.dependencies.firstPassMs ?? FIRST_PASS_MS)
    this.firstPass.unref?.()
    this.interval = setInterval(() => { void this.request('all') }, this.dependencies.intervalMs ?? MAIN_CHECKOUT_INTERVAL_MS)
    this.interval.unref?.()
  }

  /** Stops checking and waits for a pass under way, which stops before its next checkout. */
  close(): Promise<void> {
    this.disposed = true
    if (this.interval) clearInterval(this.interval)
    if (this.firstPass) clearTimeout(this.firstPass)
    if (this.mergeTimer) clearTimeout(this.mergeTimer)
    for (const timer of this.retries.values()) clearTimeout(timer)
    this.retries.clear()
    this.listeners.clear()
    return this.running
  }

  state(): MainCheckoutState {
    const projects: ProjectMainCheckout[] = []
    const known = new Set(this.dependencies.host.mainCheckoutProjects().map(project => project.id))
    for (const [projectId, saved] of Object.entries(this.saved.dependencies)) {
      if (known.has(projectId) && !this.lines.has(projectId)) projects.push({ projectId, branch: saved.branch, behind: 0, blocked: null, dependencies: [...saved.files] })
    }
    for (const [projectId, line] of this.lines) {
      const saved = this.saved.dependencies[projectId]
      if (known.has(projectId)) projects.push({ ...line, dependencies: saved ? [...saved.files] : null })
    }
    return { projects }
  }

  subscribe(listener: (state: MainCheckoutState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The folder Open folder opens: the project's own path. */
  projectFolder(projectId: string): string | null {
    return this.dependencies.host.mainCheckoutProjects().find(project => project.id === projectId)?.path ?? null
  }

  async dismissDependencies(projectId: string): Promise<MainCheckoutState> {
    await this.load()
    if (this.saved.dependencies[projectId]) {
      const dependencies = { ...this.saved.dependencies }
      delete dependencies[projectId]
      this.saved = { version: 1, dependencies }
      await this.store.write(this.saved).catch(() => undefined)
      this.publish()
    }
    return this.state()
  }

  /** A setting was saved: check again at once, since a switch may have turned on or off. */
  settingsChanged(): void { void this.request('all') }

  /**
   * A pull request merged, as the Pull request surface, babysitting or a thread's status read saw it: the projects whose
   * `origin` is its repository are checked after a short gathering, once per pull request.
   */
  pullRequestMerged(url: string): void {
    if (this.disposed) return
    const key = url.trim().toLowerCase()
    if (this.merged.includes(key)) return
    this.merged.push(key)
    if (this.merged.length > MERGED_REMEMBERED) this.merged.shift()
    const repository = repositoryOf(url)
    if (!repository) return
    this.mergedRepositories.add(repository)
    if (this.mergeTimer) return
    this.mergeTimer = setTimeout(() => { void this.checkMerged() }, this.dependencies.mergeGatherMs ?? MERGE_GATHER_MS)
    this.mergeTimer.unref?.()
  }

  /** What Show changes lists for the project's line now: the tracked changes, the files in the way, or the local commits. */
  async changes(projectId: string): Promise<MainCheckoutChanges> {
    const line = this.lines.get(projectId)
    const folder = this.projectFolder(projectId)
    if (!line?.blocked || folder === null) return { items: [], more: 0 }
    const top = await this.topLevel(folder)
    if (!top) return { items: [], more: 0 }
    const blocked = line.blocked
    let items: MainCheckoutChanges['items'] = []
    if (blocked.reason === 'untracked') items = (this.untracked.get(top) ?? []).map(text => ({ kind: 'untracked' as const, text }))
    else if (blocked.reason === 'diverged') {
      const log = await this.git(top, ['log', '--format=%h %s', `refs/remotes/origin/${line.branch}..refs/heads/${line.branch}`, '--']).catch(() => '')
      items = log.split('\n').map(text => text.trim()).filter(Boolean).map(text => ({ kind: 'commit' as const, text }))
    } else if (blocked.reason === 'changes' || blocked.reason === 'in-progress') {
      const porcelain = await this.git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=no']).catch(() => '')
      items = trackedChanges(porcelain)
    }
    return { items: items.slice(0, MAIN_CHECKOUT_FILES_MAX), more: Math.max(0, items.length - MAIN_CHECKOUT_FILES_MAX) }
  }

  /** One pass at a time; a request during a pass adds its projects to the next. */
  request(projects: readonly string[] | 'all'): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.queued === undefined) {
      this.queued = projects === 'all' ? 'all' : new Set(projects)
      this.running = this.running.then(async () => {
        const asked = this.queued
        this.queued = undefined
        if (asked !== undefined) await this.pass(asked)
      }).catch(() => undefined)
    } else if (this.queued !== 'all') {
      if (projects === 'all') this.queued = 'all'
      else for (const id of projects) this.queued.add(id)
    }
    return this.running
  }

  private async checkMerged(): Promise<void> {
    this.mergeTimer = undefined
    const repositories = new Set(this.mergedRepositories)
    this.mergedRepositories.clear()
    const matching: string[] = []
    for (const project of this.dependencies.host.mainCheckoutProjects()) {
      if (this.disposed) return
      const url = (await this.git(project.path, ['remote', 'get-url', 'origin']).catch(() => '')).trim()
      const repository = url ? repositoryOf(url) : null
      if (repository && repositories.has(repository)) matching.push(project.id)
    }
    if (matching.length) await this.request(matching)
  }

  private load(): Promise<void> {
    this.loaded ??= this.store.read().then(saved => { this.saved = saved; this.publish() }, () => undefined)
    return this.loaded
  }

  private async pass(asked: Set<string> | 'all'): Promise<void> {
    await this.load()
    // Checkouts that several projects share (subfolders of one repository) are checked once.
    const groups = new Map<string, string[]>()
    for (const project of this.dependencies.host.mainCheckoutProjects()) {
      if (this.disposed) return
      if (asked !== 'all' && !asked.has(project.id)) continue
      let on = false
      try { on = !project.settled && this.dependencies.enabled(project.id) } catch { /* Read as off. */ }
      if (!on) { this.forget(project.id); continue }
      const top = await this.topLevel(project.path)
      if (!top) { this.forget(project.id); continue }
      const key = process.platform === 'win32' ? top.toLowerCase() : top
      groups.set(key, [...groups.get(key) ?? [], project.id])
      // The first project of a checkout names it; every project of it gets the same line.
      if (groups.get(key)!.length === 1) this.tops.set(key, top)
    }
    for (const [key, projectIds] of groups) {
      if (this.disposed) return
      const top = this.tops.get(key)!
      let outcome: CheckOutcome
      try { outcome = await this.check(top) } catch { outcome = { kind: 'unchanged', retry: false } }
      if (outcome.kind === 'unchanged') { if (outcome.retry) for (const id of projectIds) this.retry(id); continue }
      for (const id of projectIds) {
        if (outcome.line) this.lines.set(id, { projectId: id, ...outcome.line }); else this.lines.delete(id)
      }
      if (outcome.dependencies) {
        const dependencies = { ...this.saved.dependencies }
        const { branch, files } = outcome.dependencies
        for (const id of projectIds) { if (files.length) dependencies[id] = { branch, files: [...files] }; else delete dependencies[id] }
        this.saved = { version: 1, dependencies }
        await this.store.write(this.saved).catch(() => undefined)
      }
    }
    this.publish()
  }
  private forget(projectId: string): void { this.lines.delete(projectId) }

  private retry(projectId: string): void {
    if (this.disposed || this.retries.has(projectId)) return
    const timer = setTimeout(() => { this.retries.delete(projectId); void this.request([projectId]) }, this.dependencies.retryMs ?? RETRY_MS)
    timer.unref?.()
    this.retries.set(projectId, timer)
  }

  /**
   * One checkout: fetch, read what stands in the way, and fast-forward under the checkout's reservation when nothing does.
   * The read is made again inside the reservation, since a thread or a terminal may have changed the folder meanwhile.
   */
  private async check(top: string): Promise<CheckOutcome> {
    if (!await this.dependencies.status.fetchRemote(top)) return { kind: 'unchanged', retry: false }
    const facts = await this.facts(top)
    if (facts === null) return { kind: 'line', line: null }
    if (facts.behind === 0) return { kind: 'line', line: null }
    if (facts.blocked) {
      this.dependencies.log?.('main-checkout-blocked')
      return { kind: 'line', line: { branch: facts.branch, behind: facts.behind, blocked: facts.blocked } }
    }
    let result: GitFastForwardResult | null
    try {
      result = await this.dependencies.host.withProjectCheckout(top, async () => {
        const now = await this.facts(top)
        if (now === null || now.blocked || now.behind === 0 || now.branch !== facts.branch) return { status: 'moved' } as const
        return this.dependencies.actions.fastForward(top, { branch: facts.branch, target: `refs/remotes/origin/${facts.branch}` })
      })
    } catch {
      this.dependencies.log?.('main-checkout-update-failed')
      return { kind: 'unchanged', retry: true }
    }
    if (result === null || result.status === 'moved') return { kind: 'unchanged', retry: true }
    if (result.status === 'refused') {
      this.dependencies.log?.('main-checkout-blocked')
      if (result.reason === 'untracked') this.untracked.set(top, result.files)
      return { kind: 'line', line: { branch: facts.branch, behind: facts.behind, blocked: { reason: result.reason } } }
    }
    if (result.status === 'up-to-date') return { kind: 'line', line: null }
    this.untracked.delete(top)
    this.dependencies.status.invalidate(top)
    void this.dependencies.host.projectCheckoutMoved?.(top).catch(() => undefined)
    this.dependencies.log?.('main-checkout-updated')
    const changed = await this.git(top, ['diff', '--name-only', '-z', result.before, result.after, '--', ...LOCKFILE_NAMES.map(name => `:(glob)**/${name}`)]).catch(() => '')
    const dependencies = changed.split('\0').filter(Boolean).slice(0, MAIN_CHECKOUT_FILES_MAX)
    const after = await this.facts(top).catch(() => null)
    return { kind: 'line', line: after && after.behind > 0 ? { branch: after.branch, behind: after.behind, blocked: after.blocked } : null, dependencies: { branch: facts.branch, files: dependencies } }
  }

  /**
   * The checkout's default branch, as `origin` names it, how far the local one is behind the remote's, and what stands in
   * the way of moving it forward. Null for a checkout with no default branch to keep, locally or on `origin`.
   */
  private async facts(top: string): Promise<{ branch: string; behind: number; blocked: MainCheckoutBlock | null } | null> {
    const branch = await this.defaultBranch(top)
    if (!branch) return null
    const local = `refs/heads/${branch}`, remote = `refs/remotes/origin/${branch}`
    if (!await this.git(top, ['rev-parse', '--verify', '-q', `${local}^{commit}`]).then(() => true, () => false)) return null
    const counts = (await this.git(top, ['rev-list', '--left-right', '--count', `${local}...${remote}`, '--'])).trim().split(/\s+/u).map(Number)
    const ahead = counts[0] ?? 0, behind = counts[1] ?? 0
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null
    const blocked = await this.blocked(top, branch, ahead)
    return { branch, behind, blocked }
  }

  private async blocked(top: string, branch: string, ahead: number): Promise<MainCheckoutBlock | null> {
    for (const [marker, operation] of IN_PROGRESS) {
      const path = (await this.git(top, ['rev-parse', '--git-path', marker]).catch(() => '')).trim()
      if (path && await stat(isAbsolute(path) ? path : join(top, path)).then(() => true, () => false)) return { reason: 'in-progress', operation }
    }
    const current = (await this.git(top, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim()
    if (current !== branch) return { reason: 'branch', checkedOut: current || null }
    if (ahead > 0) return { reason: 'diverged', ahead }
    const porcelain = await this.git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=no'])
    if (porcelain.length > 0) return { reason: 'changes' }
    return null
  }

  /** `origin`'s default branch (`origin/HEAD`), else a remote `main` or `master`. */
  private async defaultBranch(top: string): Promise<string | null> {
    const head = (await this.git(top, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']).catch(() => '')).trim()
    if (head.startsWith('origin/') && head.length > 'origin/'.length) return head.slice('origin/'.length)
    for (const candidate of ['main', 'master']) {
      if (await this.git(top, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${candidate}^{commit}`]).then(() => true, () => false)) return candidate
    }
    return null
  }

  private async topLevel(folder: string): Promise<string | null> {
    const top = (await this.git(folder, ['rev-parse', '--show-toplevel']).catch(() => '')).trim()
    return top || null
  }

  private git(cwd: string, args: readonly string[]): Promise<string> { return this.run(cwd, 'git', args, { env: QUIET_GIT_ENV }) }

  private publish(): void {
    const state = this.state()
    const fingerprint = JSON.stringify(state)
    if (fingerprint === this.lastPublished) return
    this.lastPublished = fingerprint
    for (const listener of this.listeners) { try { listener(state) } catch { /* A listener's failure is its own. */ } }
  }
}

/** The tracked changes `status --porcelain=v1 -z` lists, as Show changes names them. */
export function trackedChanges(porcelain: string): MainCheckoutChanges['items'] {
  const fields = porcelain.split('\0')
  const items: MainCheckoutChanges['items'] = []
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!
    if (field.length < 4) continue
    const code = field.slice(0, 2), path = field.slice(3)
    // A rename or copy carries its original path in the next field.
    if (code.includes('R') || code.includes('C')) index++
    const kind = code === 'UU' || code === 'AA' || code === 'DD' || code.includes('U') ? 'conflict'
      : code.includes('R') ? 'renamed' : code.includes('D') ? 'deleted' : code.includes('A') ? 'added' : 'modified'
    items.push({ kind, text: path })
  }
  return items
}
