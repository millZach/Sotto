import type { Dirent } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { AgentProject } from '../../shared/agents'
import type { MainCheckoutBlock } from '../../shared/mainCheckout'
import { projectSetupRepositorySchema, type ProjectSetupRequest, type ProjectSetupResult } from '../../shared/workerMachine'
import { inTheWay } from './gitActions'
import { sameRepository, type GitHubRepository } from './github'
import { GitUnavailableError, QUIET_GIT_ENV, runGitStatusCommand, type RunGitCommand } from './gitStatus'
import { checkoutBlock, originDefaultBranch, type CheckoutGit } from './mainCheckout'
import { readGitHubOrigin } from './projectOrigins'

/** How many folders of the usual projects folder are asked for their origin, so a folder of thousands is not walked whole. */
const SCAN_MAX = 500
/** How many folders are asked at once: one `git config` read each, as project origins are read. */
const READS_AT_ONCE = 8
const CLONE_TIMEOUT_MS = 10 * 60_000
const FETCH_TIMEOUT_MS = 2 * 60_000
const MERGE_TIMEOUT_MS = 5 * 60_000

export type ProjectSetupEvent = 'project-setup-added' | 'project-setup-cloned' | 'project-setup-refused' | 'project-setup-failed'
export interface ProjectSetupOptions {
  /** The machine's projects as its coordinator has them now, read when a setup starts. */
  projects(): readonly Pick<AgentProject, 'path'>[]
  /** Where new projects go, as the user configured it; empty for none. */
  projectsDirectory(): string
  readonly home: string
  /** Sotto's own data folder: a project inside it, such as Watcher's working folder, never decides the usual projects folder. */
  readonly ownFolder?: string
  /**
   * Adds the folder as one of the machine's projects under the title, reusing a project that already has it, and resolves
   * with its ID. On a real machine, the coordinator's own `create-project` with `useExisting`.
   */
  addProject(title: string, path: string): Promise<string>
  readonly run?: RunGitCommand
  /** Where a repository is cloned from: GitHub over HTTPS, unless a test says otherwise. */
  readonly cloneUrl?: (repository: GitHubRepository) => string
  readonly cloneTimeoutMs?: number
  readonly fetchTimeoutMs?: number
  /** Stable event names only; never a path, a repository or a remote. */
  readonly log?: (event: ProjectSetupEvent) => void
}

/** A setup Sotto will not finish, in plain words that say what happened and what to do. Nothing of the user's was removed. */
class ProjectSetupRefusal extends Error {}

const gitHubCloneUrl = (repository: GitHubRepository): string => `https://${repository.host}/${repository.owner}/${repository.name}.git`
/** A folder as this machine compares folders: Windows' are the same whatever their case. */
const folderKey = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const inside = (folder: string, path: string): boolean => {
  const between = relative(folderKey(folder), folderKey(path))
  return between === '' || !between.startsWith('..') && !isAbsolute(between)
}
/** Why a copy that stays as it was is not up to date, as the end of a sentence: "...because it has uncommitted changes". */
function blockWords(block: MainCheckoutBlock): string {
  switch (block.reason) {
    case 'in-progress': return `a ${block.operation} is under way in it`
    case 'branch': return block.checkedOut ? 'it is on another branch' : 'it has no branch checked out'
    case 'diverged': return 'it has commits GitHub does not have'
    case 'changes': return 'it has uncommitted changes'
    default: return 'something in it stood in the way'
  }
}

/**
 * Sets up a copy of a project on this machine for a worker placed here (#1690), when the machine has no project that is a
 * copy of the start's GitHub repository. Electron-free, so the desktop runs it for This computer and a headless host for
 * itself. The copy goes in the machine's usual projects folder: the one Settings name, else the folder most of its projects
 * sit in, else `Projects` in the home folder.
 *
 * A clone of the repository already there becomes a project, and is brought up to date the way Keep main up to date
 * moves a checkout: fetched, and fast-forwarded only on `origin`'s default branch with no tracked changes and no commits
 * of its own. It never stashes, resets, discards or switches a branch; a copy left as it was says why, since a new
 * worktree starts from the checkout's commit. Without one, Sotto clones the repository into a new folder named for it,
 * never prompting for a password, and removes only that folder when the clone fails. A folder of that name that is
 * something else is refused. Setups of one repository run one at a time: a second asked meanwhile answers the first's.
 */
export class ProjectCopies {
  private readonly running = new Map<string, Promise<ProjectSetupResult>>()
  private readonly run: RunGitCommand
  /** Aborted when Sotto closes: a clone or fetch under way is stopped with its whole process tree. */
  private readonly closing = new AbortController()

  constructor(private readonly options: ProjectSetupOptions) { this.run = options.run ?? runGitStatusCommand }

  /** Stops every setup under way; each answers that Sotto is closing. */
  close(): void { this.closing.abort() }

  setUp(request: ProjectSetupRequest): Promise<ProjectSetupResult> {
    if (this.closing.signal.aborted) return Promise.resolve({ ok: false, message: 'Sotto is closing there, so it set nothing up. Try again once it is open.' })
    const { host, owner, name } = request.repository
    const key = `${host}/${owner}/${name}`.toLowerCase()
    const running = this.running.get(key)
    if (running) return running
    const task = this.setUpNow(request).finally(() => { this.running.delete(key) })
    this.running.set(key, task)
    return task
  }

  private async setUpNow(request: ProjectSetupRequest): Promise<ProjectSetupResult> {
    const repository = request.repository, named = `${repository.owner}/${repository.name}`
    try {
      // The repository names a folder and an address here, so it is checked here too, whoever asked.
      if (!projectSetupRepositorySchema.safeParse(repository).success) throw new ProjectSetupRefusal(`${named} is not a GitHub repository Sotto can clone. Nothing was set up.`)
      const folder = this.usualFolder()
      const found = await this.findClone(folder, repository)
      if (found) {
        // A folder another project already uses may have threads working in it, so it is left as it is.
        const listed = this.options.projects().some(project => project.path.trim() && folderKey(project.path) === folderKey(found))
        const update = listed ? { current: false, reason: 'another project there already uses that folder' } : await this.bringUpToDate(found)
        const projectId = await this.add(request.title, found, `Sotto found ${named} at ${found}`)
        this.options.log?.('project-setup-added')
        return { ok: true, projectId, title: request.title, path: found, how: 'added', ...update }
      }
      const target = join(folder, repository.name)
      if (folderKey(dirname(target)) !== folderKey(folder)) throw new ProjectSetupRefusal(`${named} is not a GitHub repository Sotto can clone. Nothing was set up.`)
      await this.clone(repository, folder, target)
      const projectId = await this.add(request.title, target, `Sotto cloned ${named} into ${target}`)
      this.options.log?.('project-setup-cloned')
      return { ok: true, projectId, title: request.title, path: target, how: 'cloned', current: true }
    } catch (error) {
      if (error instanceof ProjectSetupRefusal) { this.options.log?.('project-setup-refused'); return { ok: false, message: error.message } }
      this.options.log?.('project-setup-failed')
      return { ok: false, message: `Sotto could not set up a copy of ${named} there. Try again, or add the project there yourself.` }
    }
  }

  /** The folder Settings name for new projects, else the one most of the machine's projects sit in, else `Projects` at home. */
  private usualFolder(): string {
    const configured = this.options.projectsDirectory().trim()
    if (configured && isAbsolute(configured)) return resolve(configured)
    const home = folderKey(this.options.home)
    const counts = new Map<string, { folder: string; count: number }>()
    for (const project of this.options.projects()) {
      if (!project.path.trim() || !isAbsolute(project.path)) continue
      const path = resolve(project.path), parent = dirname(path)
      // A project that is the home folder itself says nothing of where projects go, nor does one of Sotto's own.
      if (folderKey(path) === home || parent === path || this.options.ownFolder && inside(this.options.ownFolder, path)) continue
      const entry = counts.get(folderKey(parent))
      if (entry) entry.count++; else counts.set(folderKey(parent), { folder: parent, count: 1 })
    }
    let best: { folder: string; count: number } | undefined
    for (const entry of counts.values()) if (!best || entry.count > best.count) best = entry
    return best?.folder ?? join(this.options.home, 'Projects')
  }

  /** A clone of the repository directly in `folder`, the one named for it first, or null. */
  private async findClone(folder: string, repository: GitHubRepository): Promise<string | null> {
    let entries: Dirent[]
    try { entries = await readdir(folder, { withFileTypes: true }) } catch { return null }
    const folders = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    const wanted = repository.name.toLowerCase()
    const namedFor = folders.filter(entry => entry.name.toLowerCase() === wanted).sort((a, b) => Number(b.name === repository.name) - Number(a.name === repository.name))
    const order = [...namedFor, ...folders.filter(entry => entry.name.toLowerCase() !== wanted).slice(0, SCAN_MAX)].map(entry => join(folder, entry.name))
    for (let at = 0; at < order.length; at += READS_AT_ONCE) {
      const batch = order.slice(at, at + READS_AT_ONCE)
      const origins = await Promise.all(batch.map(path => readGitHubOrigin(path, this.run)))
      for (const [index, path] of batch.entries()) {
        const origin = origins[index]
        // A folder inside another repository reads that repository's origin: only a clone's own top folder counts.
        if (origin && sameRepository(origin, repository) && await this.topLevel(path)) return path
      }
    }
    return null
  }

  private async topLevel(path: string): Promise<boolean> {
    return (await this.git(path, ['rev-parse', '--show-cdup']).then(text => text.trim() === '', () => false))
  }

  /**
   * Fetches the copy and fast-forwards its default branch when nothing stands in the way, as Keep main up to date does.
   * Current when the commit a new worktree starts from is `origin`'s newest on that branch.
   */
  private async bringUpToDate(top: string): Promise<{ current: boolean; reason?: string }> {
    const timeoutMs = this.options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS
    try { await this.stoppable(top, ['fetch', '--quiet', 'origin'], timeoutMs) } catch { return { current: false, reason: 'Sotto could not fetch it from GitHub' } }
    // A clone made without `origin/HEAD` learns it from the remote; one that cannot falls back to `main` or `master`.
    const head = await this.git(top, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']).then(text => text.trim(), () => '')
    if (!head) await this.git(top, ['remote', 'set-head', 'origin', '--auto'], timeoutMs).catch(() => undefined)
    const git: CheckoutGit = (cwd, args) => this.git(cwd, args)
    const branch = await originDefaultBranch(git, top)
    if (!branch) return { current: false, reason: 'Sotto could not tell which branch is its default' }
    const local = `refs/heads/${branch}`, remote = `refs/remotes/origin/${branch}`
    const counts = await this.git(top, ['rev-list', '--left-right', '--count', `${local}...${remote}`, '--']).then(text => text.trim().split(/\s+/u).map(Number), () => null)
    const ahead = counts?.[0] ?? 0, behind = counts?.[1] ?? Number.NaN
    const block = await checkoutBlock(git, top, branch, ahead).catch(() => ({ reason: 'changes' }) as const)
    if (block?.reason === 'branch') return { current: false, reason: blockWords(block) }
    if (!Number.isFinite(behind)) return { current: false, reason: 'Sotto could not compare it with GitHub' }
    // Tracked changes stay out of a new worktree, which starts from the commit; at the newest one, the copy is current.
    if (behind === 0 && (block === null || block.reason === 'changes')) return { current: true }
    if (block) return { current: false, reason: blockWords(block) }
    // The fetch took a while: a project added on that folder meanwhile may have work in it, so it is left as it is.
    if (this.options.projects().some(project => project.path.trim() && folderKey(project.path) === folderKey(top))) return { current: false, reason: 'another project there already uses that folder' }
    try {
      await this.git(top, ['merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', '--quiet', '--end-of-options', remote], MERGE_TIMEOUT_MS)
    } catch (error) {
      const refused = inTheWay(error instanceof Error ? error.message : '')
      return { current: false, reason: refused?.reason === 'untracked' ? 'files in it that Git does not track are in the way' : refused ? 'it has uncommitted changes' : 'Git could not move it forward' }
    }
    return { current: true }
  }

  /**
   * Clones into a new folder Sotto makes for it, so a failure removes only what Sotto made. A folder already there is the
   * user's, whatever it holds.
   */
  private async clone(repository: GitHubRepository, folder: string, target: string): Promise<void> {
    const named = `${repository.owner}/${repository.name}`
    try { await mkdir(folder, { recursive: true }) } catch {
      throw new ProjectSetupRefusal(`Sotto could not make the folder ${folder} there. Clone ${named} there yourself, or name another machine.`)
    }
    try { await mkdir(target) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ProjectSetupRefusal(`There is already a folder named ${repository.name} in ${folder} that is not a copy of ${named}. Clone ${named} there under another name yourself, or name another machine.`)
      }
      throw new ProjectSetupRefusal(`Sotto could not make the folder ${target} there. Clone ${named} there yourself, or name another machine.`)
    }
    try {
      await this.stoppable(folder, ['clone', '--quiet', '--filter=blob:none', '--', (this.options.cloneUrl ?? gitHubCloneUrl)(repository), target], this.options.cloneTimeoutMs ?? CLONE_TIMEOUT_MS)
    } catch (error) {
      const removed = await rm(target, { recursive: true, force: true, maxRetries: 3 }).then(() => true, () => false)
      const leftover = removed ? 'Sotto removed the unfinished copy.' : `Sotto could not remove the unfinished copy at ${target}; remove it before trying again.`
      if (error instanceof GitUnavailableError) throw new ProjectSetupRefusal(`Git is not installed there, so Sotto could not clone ${named}. Install Git there, or name another machine.`)
      if (this.closing.signal.aborted) throw new ProjectSetupRefusal(`Sotto closed there while cloning ${named}. ${leftover} Try again once it is open.`)
      if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        throw new ProjectSetupRefusal(`Cloning ${named} into ${target} took more than ten minutes, so Sotto stopped it. ${leftover} Clone it there yourself, or name another machine.`)
      }
      throw new ProjectSetupRefusal(`Git could not clone ${named} into ${target}; that machine may not reach GitHub or may not be signed in to it. ${leftover} Clone it there yourself, or name another machine.`)
    }
  }

  /**
   * A clone or fetch, which may take minutes: stopped with its whole process tree at its deadline or when Sotto closes, since
   * on Windows a stopped git's own children otherwise keep the folder open. A deadline rejects with `ETIMEDOUT`.
   */
  private async stoppable(cwd: string, args: readonly string[], timeoutMs: number): Promise<string> {
    const deadline = AbortSignal.timeout(timeoutMs)
    try {
      // The runner's own timeout stays further off, so the stop that ends the whole tree is the one that comes first.
      return await this.run(cwd, 'git', args, { env: QUIET_GIT_ENV, signal: AbortSignal.any([deadline, this.closing.signal]), timeoutMs: timeoutMs + 60_000 })
    } catch (error) {
      if (deadline.aborted && !this.closing.signal.aborted) throw Object.assign(new Error('git did not finish in time.'), { code: 'ETIMEDOUT' })
      throw error
    }
  }

  private async add(title: string, path: string, done: string): Promise<string> {
    try { return await this.options.addProject(title, path) } catch (error) {
      const said = error instanceof Error && error.message.trim() ? error.message.trim() : 'Try again.'
      throw new ProjectSetupRefusal(`${done} but could not add it as a project. ${said}`)
    }
  }

  private git(cwd: string, args: readonly string[], timeoutMs?: number): Promise<string> {
    return this.run(cwd, 'git', args, { env: QUIET_GIT_ENV, ...timeoutMs !== undefined ? { timeoutMs } : {} })
  }
}
