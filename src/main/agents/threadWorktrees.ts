import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AgentWorktree } from '../../shared/agents'
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
export const THREAD_WORKTREE_HOME: WorktreeHome = { folder: 'thread-worktrees', branchPrefix: 'sotto/thread-' }
export const TERMINAL_WORKTREE_HOME: WorktreeHome = { folder: 'terminal-worktrees', branchPrefix: 'sotto/terminal-' }

/** Never removes files or branches. Allocation is persisted by WorkspaceHost before ensure. */
export class ThreadWorktrees {
  constructor(private readonly directory: string, private readonly git: RunGit = runWorktreeGit, private readonly home: WorktreeHome = THREAD_WORKTREE_HOME) {}

  async allocate(projectPath: string, mode: 'independent' | 'shared'): Promise<AgentWorktree> {
    const cwd = await existingWorkingDirectory(projectPath)
    if (mode === 'shared') return { mode, status: 'ready', path: cwd }
    let repositoryRoot: string
    try { repositoryRoot = (await this.git(cwd, ['rev-parse', '--show-toplevel'])).trim() }
    catch (error) {
      if (error instanceof Error && /not a git repository/u.test(error.message)) return { mode: 'shared', status: 'ready', path: cwd }
      throw error
    }
    let baseCommit: string
    try { baseCommit = (await this.git(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim() }
    catch { throw new Error('This Git repository has no commit to branch from. Make its first commit, or create the thread with Project folder.') }
    const projectRelativePath = relative(await realpath(repositoryRoot), cwd).split(sep).join('/')
    if (projectRelativePath) {
      try {
        if ((await this.git(repositoryRoot, ['cat-file', '-t', `${baseCommit}:${projectRelativePath}`])).trim() !== 'tree') throw new Error('Not a committed directory')
      } catch { throw new Error('The project subdirectory is not present in the committed source. Commit that folder or explicitly choose a shared working copy, then retry.') }
    }
    const token = randomUUID()
    return { mode, status: 'pending', path: join(await realpath(this.directory), this.home.folder, token), repositoryRoot: await realpath(repositoryRoot), branch: `${this.home.branchPrefix}${token}`, baseCommit, projectRelativePath }
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
    if (metadata.mode === 'shared') return { ...metadata, path: await existingWorkingDirectory(metadata.path), status: 'ready', error: undefined }
    const { repositoryRoot, branch, baseCommit } = metadata
    if (!repositoryRoot || !branch || !baseCommit) throw new Error('The independent working-copy allocation is incomplete.')
    const allocationRoot = join(await realpath(this.directory), this.home.folder)
    if (pathKey(dirname(metadata.path)) !== pathKey(allocationRoot) || !/^[a-f0-9-]{36}$/u.test(basename(metadata.path))) throw new Error('The working-copy allocation is outside Sotto’s reserved folder.')
    await existingWorkingDirectory(repositoryRoot)
    const entries = registeredWorktrees(await this.git(repositoryRoot, ['worktree', 'list', '--porcelain', '-z']))
    const registered = entries.find(entry => pathKey(entry.path) === pathKey(metadata.path!))
    if (registered) {
      if (registered.locked || registered.prunable) throw new Error('Git has locked this worktree or reports an incomplete checkout. Wait for setup to finish or restore the checkout, then retry.')
      if (registered.branch !== `refs/heads/${branch}`) throw new Error('The reserved working folder belongs to a different branch. Nothing was changed.')
      const path = await existingWorkingDirectory(metadata.path)
      // A replaced symlink/junction is not the allocated checkout.
      if (pathKey(path) !== pathKey(metadata.path)) throw new Error('The reserved working folder was redirected. Nothing was changed.')
      return this.inspect({ ...metadata, status: 'ready', error: undefined })
    }
    if (await lstat(metadata.path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error })) throw new Error('The reserved working folder already exists but is not this thread’s Git worktree. Nothing was changed.')
    if (entries.some(entry => entry.branch === `refs/heads/${branch}`)) throw new Error('The reserved branch is already checked out in another folder. Nothing was changed.')
    // -b refuses any existing branch; never reset it with -B or force another checkout.
    await mkdir(allocationRoot, { recursive: true })
    if (pathKey(await realpath(allocationRoot)) !== pathKey(allocationRoot)) throw new Error('The reserved worktree parent folder was redirected. Nothing was changed.')
    await this.git(repositoryRoot, ['worktree', 'add', '-b', branch, '--', metadata.path, baseCommit])
    return this.inspect({ ...metadata, status: 'ready', error: undefined })
  }

  async inspect(metadata: AgentWorktree): Promise<AgentWorktree> {
    if (!metadata.path) throw new Error('The working folder is not allocated. Retry setup.')
    const path = await existingWorkingDirectory(metadata.path)
    if (metadata.mode === 'shared') return { ...metadata, status: 'ready', error: undefined }
    // Inspection never creates a replacement for a deleted checkout.
    if (!metadata.repositoryRoot || !metadata.branch) throw new Error('The worktree binding is incomplete.')
    const entries = registeredWorktrees(await this.git(metadata.repositoryRoot, ['worktree', 'list', '--porcelain', '-z']))
    const registered = entries.find(entry => pathKey(entry.path) === pathKey(path))
    if (registered?.locked || registered?.prunable) throw new Error('Git has locked this worktree or reports an incomplete checkout. Restore the checkout before continuing.')
    if (pathKey(path) !== pathKey(metadata.path) || !entries.some(entry => pathKey(entry.path) === pathKey(path) && entry.branch === `refs/heads/${metadata.branch}`)) throw new Error('The working folder or branch no longer matches this thread. Restore its checkout before continuing.')
    const [root, common, expectedCommon] = await Promise.all([
      this.git(path, ['rev-parse', '--show-toplevel']),
      this.git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      this.git(metadata.repositoryRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ])
    if (pathKey(root.trim()) !== pathKey(path) || pathKey(common.trim()) !== pathKey(expectedCommon.trim())) throw new Error('The working folder no longer belongs to the original repository.')
    await this.workingDirectory(metadata)
    return { ...metadata, status: 'ready', error: undefined, dirty: (await this.git(path, ['status', '--porcelain', '--untracked-files=normal'])).length > 0 }
  }
}
