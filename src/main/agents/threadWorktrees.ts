import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AgentWorkingCopyOptions, AgentWorkingCopySelection, AgentWorktree } from '../../shared/agents'
import { nativeEnvironment } from './subscriptionCodex'

export type RunGit = (cwd: string, args: string[]) => Promise<string>
export const runWorktreeGit: RunGit = (cwd, args) => new Promise((accept, reject) => {
  execFile('git', ['-c', 'core.quotePath=false', ...args], {
    cwd, windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 2_000_000,
    env: { ...nativeEnvironment(), LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
  }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(new Error(error.code === 'ENOENT' ? 'Git is unavailable. Install Git or explicitly choose a shared working copy.' : stderr.trim() || error.message), { code: error.code }))
    else accept(stdout)
  })
})

export async function existingWorkingDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('The working folder must be an absolute path.')
  const canonical = await realpath(path)
  if (!(await stat(canonical)).isDirectory()) throw new Error('The working folder is not a directory.')
  return canonical
}
function pathKey(path: string): string { const key = resolve(path); return process.platform === 'win32' ? key.toLowerCase() : key }
function registeredWorktrees(output: string): Array<{ path: string; branch: string | undefined; locked: boolean; prunable: boolean }> {
  return output.split('\0\0').filter(Boolean).map(record => {
    const fields = record.split('\0')
    return { path: fields.find(field => field.startsWith('worktree '))?.slice(9) ?? '', branch: fields.find(field => field.startsWith('branch '))?.slice(7),
      locked: fields.some(field => field === 'locked' || field.startsWith('locked ')), prunable: fields.some(field => field === 'prunable' || field.startsWith('prunable ')) }
  })
}

/** Where a set of worktrees lives under Sotto's data folder, and how their branches are named. */
export interface WorktreeHome {
  readonly folder: string
  readonly branchPrefix: string
}
const THREAD_WORKTREE_HOME: WorktreeHome = { folder: 'thread-worktrees', branchPrefix: 'sotto/' }
export const TERMINAL_WORKTREE_HOME: WorktreeHome = { folder: 'terminal-worktrees', branchPrefix: 'sotto/terminal-' }

/** Never removes files or branches. Allocation is persisted by WorkspaceHost before ensure. */
export class ThreadWorktrees {
  constructor(private readonly directory: string, private readonly git: RunGit = runWorktreeGit, private readonly home: WorktreeHome = THREAD_WORKTREE_HOME) {}

  async allocate(projectPath: string, mode: 'independent' | 'shared', selection: Partial<AgentWorkingCopySelection> = {}): Promise<AgentWorktree> {
    const cwd = await existingWorkingDirectory(projectPath)
    if (mode === 'shared') return { mode, status: 'ready', path: cwd }
    let repositoryRoot: string
    try { repositoryRoot = (await this.git(cwd, ['rev-parse', '--show-toplevel'])).trim() }
    catch (error) {
      if (error instanceof Error && /not a git repository/u.test(error.message)) return { mode: 'shared', status: 'ready', path: cwd }
      throw error
    }
    if (selection.existingWorktreePath) {
      const path = await existingWorkingDirectory(selection.existingWorktreePath)
      const entries = registeredWorktrees(await this.git(repositoryRoot, ['worktree', 'list', '--porcelain', '-z']))
      const entry = entries.find(item => pathKey(item.path) === pathKey(path))
      if (!entry || entry.locked || entry.prunable) throw new Error('That folder is not an available worktree of this project. Refresh the worktree list and choose again.')
      const projectRelativePath = relative(await realpath(repositoryRoot), cwd).split(sep).join('/')
      return this.inspect({ mode, status: 'ready', path, repositoryRoot: await realpath(repositoryRoot), projectRelativePath, reused: true })
    }
    const baseBranch = selection.baseBranch ?? (selection.startFromOrigin ? (await this.git(repositoryRoot, ['branch', '--show-current'])).trim() || undefined : undefined)
    if (baseBranch) await this.git(repositoryRoot, ['check-ref-format', `refs/heads/${baseBranch}`])
    if (selection.startFromOrigin && !baseBranch) throw new Error('Choose a base branch before starting from origin.')
    const base = baseBranch ? `${selection.startFromOrigin ? 'refs/remotes/origin/' : 'refs/heads/'}${baseBranch}` : 'HEAD'
    if (selection.startFromOrigin) {
      try { await this.git(repositoryRoot, ['fetch', '--no-tags', 'origin', `refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`]) }
      catch { throw new Error(`The origin branch ${baseBranch} could not be fetched. Check the remote and connection, or turn off Start from origin.`) }
    }
    let baseCommit: string
    try { baseCommit = (await this.git(repositoryRoot, ['rev-parse', '--verify', `${base}^{commit}`])).trim() }
    catch { throw new Error(baseBranch ? `The base branch ${baseBranch} is unavailable. Choose an existing branch and retry.` : 'This Git repository has no commit to branch from. Make its first commit, or create the thread with Project folder.') }
    const projectRelativePath = relative(await realpath(repositoryRoot), cwd).split(sep).join('/')
    if (projectRelativePath) {
      try {
        if ((await this.git(repositoryRoot, ['cat-file', '-t', `${baseCommit}:${projectRelativePath}`])).trim() !== 'tree') throw new Error('Not a committed directory')
      } catch { throw new Error('The project subdirectory is not present in the committed source. Commit that folder or explicitly choose a shared working copy, then retry.') }
    }
    const token = randomUUID()
    return { mode, status: 'pending', path: join(await realpath(this.directory), this.home.folder, token), repositoryRoot: await realpath(repositoryRoot), branch: `${this.home.branchPrefix}${this.home === THREAD_WORKTREE_HOME ? token.slice(0, 8) : token}`, baseCommit, projectRelativePath, baseBranch, startFromOrigin: selection.startFromOrigin, temporaryBranch: this.home === THREAD_WORKTREE_HOME }
  }


  async options(projectPath: string): Promise<AgentWorkingCopyOptions> {
    const cwd = await existingWorkingDirectory(projectPath)
    try { await this.git(cwd, ['rev-parse', '--show-toplevel']) }
    catch (error) {
      if (error instanceof Error && /not a git repository|Git is unavailable/u.test(error.message)) return { isGit: false, currentBranch: null, branches: [], worktrees: [] }
      throw error
    }
    const [branch, branches, entries] = await Promise.all([
      this.git(cwd, ['branch', '--show-current']), this.git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
      this.git(cwd, ['worktree', 'list', '--porcelain', '-z']),
    ])
    return { isGit: true, currentBranch: branch.trim() || null, branches: branches.split(/\r?\n/u).filter(Boolean),
      worktrees: registeredWorktrees(entries).filter(entry => !entry.locked && !entry.prunable).map(entry => ({ path: entry.path, branch: entry.branch?.replace(/^refs\/heads\//u, '') ?? null })) }
  }

  async renameTemporaryBranch(metadata: AgentWorktree, name: string): Promise<AgentWorktree> {
    if (!metadata.temporaryBranch || metadata.reused || !metadata.branch) return metadata
    const inspected = await this.inspect(metadata)
    if (inspected.branch !== metadata.branch) return { ...inspected, temporaryBranch: false }
    const slug = name.replace(/^sotto\//u, '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 60).replace(/-$/u, '')
    if (!slug) return inspected
    const branch = `sotto/${slug}`
    await this.git(inspected.path!, ['branch', '-m', metadata.branch, branch])
    return { ...inspected, branch, temporaryBranch: false }
  }

  async workingDirectory(metadata: AgentWorktree): Promise<string> {
    if (!metadata.path) throw new Error('The working folder is not allocated.')
    const root = await existingWorkingDirectory(metadata.path)
    const requested = resolve(root, metadata.projectRelativePath ?? '.')
    const local = relative(root, requested)
    if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) throw new Error('The project subdirectory is outside its allocated worktree.')
    const directory = await existingWorkingDirectory(requested)
    const actual = relative(root, directory)
    if (isAbsolute(actual) || actual === '..' || actual.startsWith(`..${sep}`)) throw new Error('The project subdirectory was redirected outside its allocated worktree.')
    return directory
  }

  async ensure(metadata: AgentWorktree): Promise<AgentWorktree> {
    if (!metadata.path) throw new Error('The working-copy allocation is missing.')
    if (metadata.mode === 'shared' || metadata.reused) return this.inspect(metadata)
    const { repositoryRoot, branch, baseCommit } = metadata
    if (!repositoryRoot || !baseCommit) throw new Error('The independent working-copy allocation is incomplete.')
    const allocationRoot = join(await realpath(this.directory), this.home.folder)
    if (pathKey(dirname(metadata.path)) !== pathKey(allocationRoot) || !/^[a-f0-9-]{36}$/u.test(basename(metadata.path))) throw new Error('The working-copy allocation is outside Sotto’s reserved folder.')
    await existingWorkingDirectory(repositoryRoot)
    // A checkout Sotto already made and then lost is recreated from its recorded branch (ADR-0014).
    if (metadata.status !== 'pending') await this.restore(metadata)
    const entries = registeredWorktrees(await this.git(repositoryRoot, ['worktree', 'list', '--porcelain', '-z']))
    const registered = entries.find(entry => pathKey(entry.path) === pathKey(metadata.path!))
    if (registered) {
      if (registered.locked || registered.prunable) throw new Error('Git has locked this worktree or reports an incomplete checkout. Wait for setup to finish or restore the checkout, then retry.')
      const path = await existingWorkingDirectory(metadata.path)
      // A replaced symlink/junction is not the allocated checkout.
      if (pathKey(path) !== pathKey(metadata.path)) throw new Error('The reserved working folder was redirected. Nothing was changed.')
      // An existing checkout is reused on whatever branch it has (ADR-0014); inspect records it.
      return this.inspect({ ...metadata, status: 'ready', error: undefined })
    }
    if (!branch) throw new Error('The independent working-copy allocation is incomplete.')
    if (await lstat(metadata.path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error })) throw new Error('The reserved working folder already exists but is not this thread’s Git worktree. Nothing was changed.')
    if (entries.some(entry => entry.branch === `refs/heads/${branch}`)) throw new Error('The reserved branch is already checked out in another folder. Nothing was changed.')
    // -b refuses any existing branch; never reset it with -B or force another checkout.
    await mkdir(allocationRoot, { recursive: true })
    if (pathKey(await realpath(allocationRoot)) !== pathKey(allocationRoot)) throw new Error('The reserved worktree parent folder was redirected. Nothing was changed.')
    await this.git(repositoryRoot, ['worktree', 'add', '-b', branch, '--', metadata.path, baseCommit])
    return this.inspect({ ...metadata, status: 'ready', error: undefined })
  }

  /**
   * Puts back a checkout Sotto made and then lost, on the branch it recorded (ADR-0014). Best effort: a
   * folder that is still there, a thread with no recorded branch and a branch that no longer exists are
   * all returned unchanged, so the caller reports the real problem. Never resets a branch, never removes
   * a checkout, and never takes a branch another folder has.
   */
  async restore(metadata: AgentWorktree): Promise<AgentWorktree> {
    const { path, repositoryRoot, branch } = metadata
    if (metadata.mode !== 'independent' || !path || !repositoryRoot || !branch) return metadata
    if (await lstat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error })) return metadata
    let allocationRoot: string
    // Sotto's own data folder and the repository have to be there before anything is put back.
    try { allocationRoot = join(await realpath(this.directory), this.home.folder); await existingWorkingDirectory(repositoryRoot) }
    catch { return metadata }
    if (pathKey(dirname(path)) !== pathKey(allocationRoot) || !/^[a-f0-9-]{36}$/u.test(basename(path))) return metadata
    try { await this.git(repositoryRoot, ['rev-parse', '--verify', `refs/heads/${branch}`]) }
    catch { return metadata }
    const refuseAnotherFolder = async () => {
      const entries = registeredWorktrees(await this.git(repositoryRoot, ['worktree', 'list', '--porcelain', '-z']))
      const occupant = entries.find(entry => entry.branch === `refs/heads/${branch}` && pathKey(entry.path) !== pathKey(path))
      if (occupant) throw new Error(`The branch ${branch} is checked out in ${occupant.path}, so this thread’s folder cannot be put back on it. Nothing was lost or changed. Close that folder’s checkout or move it to another branch, then retry.`)
    }
    await refuseAnotherFolder()
    // Prune drops only the registry entry for the folder that is gone; it never touches files or branches.
    await this.git(repositoryRoot, ['worktree', 'prune'])
    await refuseAnotherFolder()
    await mkdir(allocationRoot, { recursive: true })
    if (pathKey(await realpath(allocationRoot)) !== pathKey(allocationRoot)) throw new Error('The reserved worktree parent folder was redirected. Nothing was changed.')
    // No -b and no -B: the recorded branch is checked out as it stands, with its commits.
    try { await this.git(repositoryRoot, ['worktree', 'add', '--', path, branch]) }
    catch (error) { throw new Error(`This thread’s working folder was missing and Sotto could not put it back on ${branch}. Nothing was lost; the branch still has its commits. ${error instanceof Error ? error.message : ''}`.trim(), { cause: error }) }
    return { ...metadata, status: 'ready', error: undefined }
  }

  /**
   * Switches the thread's own worktree back to `branch`, which the user asked for by hand: Sotto never
   * switches a branch on its own (ADR-0014). The folder is verified first, the branch must already exist,
   * and uncommitted work is left where it is for Git to carry across or refuse.
   */
  async switchBranch(metadata: AgentWorktree, branch: string): Promise<AgentWorktree> {
    // The name came from Git itself; refuse anything that could read as an option or a path.
    if (!/^(?!-)(?!.*\.\.)[^\s:?*~^[\]\\]+$/u.test(branch)) throw new Error('That branch name cannot be restored. Switch it in the folder itself.')
    const inspected = await this.inspect(metadata)
    if (inspected.branch === branch) return inspected
    try { await this.git(inspected.path!, ['rev-parse', '--verify', `refs/heads/${branch}`]) }
    catch { throw new Error(`The branch ${branch} no longer exists in this repository. Nothing was changed.`) }
    // --no-guess never creates a branch from a remote; a conflicting change makes Git refuse and nothing moves.
    await this.git(inspected.path!, ['switch', '--no-guess', branch])
    return this.inspect(inspected)
  }

  async inspect(metadata: AgentWorktree): Promise<AgentWorktree> {
    if (!metadata.path) throw new Error('The working folder is not allocated. Retry setup.')
    const path = await existingWorkingDirectory(metadata.path)
    if (metadata.mode === 'shared') {
      let repositoryRoot: string
      try { repositoryRoot = (await this.git(path, ['rev-parse', '--show-toplevel'])).trim() }
      catch (error) {
        if (error instanceof Error && /not a git repository|Git is unavailable/u.test(error.message)) return { ...metadata, branch: undefined, dirty: false, status: 'ready', error: undefined }
        throw error
      }
      const branch = (await this.git(path, ['branch', '--show-current'])).trim() || undefined
      return { ...metadata, repositoryRoot, branch, dirty: (await this.git(path, ['status', '--porcelain', '--untracked-files=normal'])).length > 0, status: 'ready', error: undefined }
    }
    // Inspection never creates a replacement for a deleted checkout.
    if (!metadata.repositoryRoot) throw new Error('The worktree binding is incomplete.')
    const entries = registeredWorktrees(await this.git(metadata.repositoryRoot, ['worktree', 'list', '--porcelain', '-z']))
    const registered = entries.find(entry => pathKey(entry.path) === pathKey(path))
    if (registered?.locked || registered?.prunable) throw new Error('Git has locked this worktree or reports an incomplete checkout. Restore the checkout before continuing.')
    if (pathKey(path) !== pathKey(metadata.path) || !registered) throw new Error('The working folder is no longer this thread’s Git worktree. Restore its checkout before continuing.')
    // The thread follows whatever its worktree has checked out (ADR-0014): Sotto records the branch it
    // sees, none for a detached HEAD, and never switches one itself.
    const branch = registered.branch?.startsWith('refs/heads/') ? registered.branch.slice('refs/heads/'.length) : undefined
    const [root, common, expectedCommon] = await Promise.all([
      this.git(path, ['rev-parse', '--show-toplevel']),
      this.git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      this.git(metadata.repositoryRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ])
    if (pathKey(root.trim()) !== pathKey(path) || pathKey(common.trim()) !== pathKey(expectedCommon.trim())) throw new Error('The working folder no longer belongs to the original repository.')
    await this.workingDirectory(metadata)
    return { ...metadata, branch, ...(metadata.temporaryBranch && branch !== metadata.branch ? { temporaryBranch: false } : {}), status: 'ready', error: undefined, dirty: (await this.git(path, ['status', '--porcelain', '--untracked-files=normal'])).length > 0 }
  }
}
