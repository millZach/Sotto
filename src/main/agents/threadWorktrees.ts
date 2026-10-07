import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, opendir, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { RECLAIM_WORKTREE_NEEDS_CONFIRMATION, type AgentWorkingCopyOptions, type AgentWorkingCopySelection, type AgentWorktree } from '../../shared/agents'
import { nativeEnvironment } from './subscriptionCodex'

export type RunGit = (cwd: string, args: string[]) => Promise<string>
export const runWorktreeGit: RunGit = (cwd, args) => runWorktreeGitProcess(cwd, args)

/** The executable and deadline seam lets a real launcher/checkout tree exercise timeout recovery. */
export function runWorktreeGitProcess(cwd: string, args: string[], options: { executable?: string; prefix?: string[]; timeout?: number } = {}): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawn(options.executable ?? 'git', [...(options.prefix ?? ['-c', 'core.quotePath=false']), ...args], {
      cwd, windowsHide: true, shell: false, detached: process.platform !== 'win32',
      // No optional locks: a status read here never takes the index lock from a commit running beside it.
      env: { ...nativeEnvironment(), LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    })
    let timedOut = false
    let processError: Error | undefined
    let stopping: Promise<void> = Promise.resolve()
    const output: Buffer[] = [], errors: Buffer[] = []
    let bytes = 0
    const stop = (): void => {
      if (!child.pid) return
      stopping = process.platform === 'win32'
        ? new Promise<void>((done, fail) => { execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, error => error ? fail(error) : done()) })
        : new Promise<void>((done, fail) => { try { process.kill(-child.pid!, 'SIGKILL'); done() } catch (error) { fail(error) } })
      void stopping.catch(() => reject(new Error('Git took too long and its checkout processes could not be stopped. The folder was kept.')))
    }
    const collect = (target: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes <= 2_000_000) target.push(chunk)
      else if (!processError) { processError = new Error('Git returned too much output. Nothing was removed.'); clearTimeout(timer); stop() }
    }
    child.stdout.on('data', (chunk: Buffer) => collect(output, chunk))
    child.stderr.on('data', (chunk: Buffer) => collect(errors, chunk))
    child.on('error', error => { processError = error })
    const timer = setTimeout(() => { timedOut = true; stop() }, options.timeout ?? (args[0] === 'worktree' && args[1] === 'add' ? 300_000 : 30_000))
    // close follows exit and closed pipes; the tree termination command must finish before cleanup can start.
    child.on('close', code => {
      clearTimeout(timer)
      void stopping.then(() => {
        if (timedOut || processError || code !== 0) {
          const unavailable = (processError as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
          reject(Object.assign(new Error(unavailable ? 'Git is unavailable. Install Git or explicitly choose a shared working copy.' : timedOut ? 'Git took too long.' : Buffer.concat(errors).toString('utf8').trim() || processError?.message || 'Git could not finish this action.'), { code: (processError as NodeJS.ErrnoException | undefined)?.code ?? code, timedOut }))
        } else accept(Buffer.concat(output).toString('utf8'))
      }, () => reject(new Error('Git took too long and its checkout processes could not be stopped. The folder was kept.')))
    })
  })
}

export async function existingWorkingDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('The working folder must be an absolute path.')
  // A project whose folder was moved or deleted says so in plain words rather than as the file system's error code.
  const canonical = await realpath(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error(`The folder ${path} is not there any more. Move it back, or add the project again from where it is now.`, { cause: error })
    throw error
  })
  if (!(await stat(canonical)).isDirectory()) throw new Error('The working folder is not a directory.')
  return canonical
}
function pathKey(path: string): string { const key = resolve(path); return process.platform === 'win32' ? key.toLowerCase() : key }

/** Resolve missing owned worktrees through their existing parent without mistaking the parent for their checkout. */
async function canonicalCheckoutPath(folder: string): Promise<string> {
  let candidate = folder
  const suffix: string[] = []
  for (;;) {
    try { return pathKey(join(await realpath(candidate), ...suffix)) }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') || dirname(candidate) === candidate) throw error
      suffix.unshift(basename(candidate)); candidate = dirname(candidate)
    }
  }
}
const missing = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')

/**
 * Git's own discovery for a folder, read from the `.git` entries on disk so that asking starts no process. `root`
 * is the nearest folder, this one or above, holding a `.git` file or a `.git` directory with a HEAD, objects and
 * refs; Git passes over a `.git` directory without them, and so does this. A null root is a folder in no
 * repository, with the nearest `.git` of any kind as `marker`, which is where a refused Git discovery has always
 * grouped it. Undefined when the file system would not answer, and then Git is asked.
 */
type CheckoutOnDisk = { readonly root: string } | { readonly root: null; readonly marker: string | undefined }
async function checkoutOnDisk(folder: string): Promise<CheckoutOnDisk | undefined> {
  let marker: string | undefined
  for (let candidate = folder;; candidate = dirname(candidate)) {
    let entry: Awaited<ReturnType<typeof stat>> | undefined
    try { entry = await stat(join(candidate, '.git')) }
    catch (error) { if (!missing(error)) return undefined }
    if (entry?.isFile()) return { root: candidate }
    if (entry?.isDirectory()) {
      const [head, objects, refs] = await Promise.all(['HEAD', 'objects', 'refs'].map(name => stat(join(candidate, '.git', name)).catch(() => undefined)))
      if (head?.isFile() && objects?.isDirectory() && refs?.isDirectory()) return { root: candidate }
    }
    if (entry) marker ??= candidate
    if (dirname(candidate) === candidate) return { root: null, marker }
  }
}

/**
 * One implementation for ownership, checkpoint records and reservations, including when Git refuses discovery.
 * A send reserves its checkout through this, so the answer comes from the files on disk and Git is asked only
 * when they leave it open (issue #766).
 */
export async function checkoutIdentity(folder: string, git: RunGit = runWorktreeGit): Promise<string> {
  const canonical = await canonicalCheckoutPath(folder)
  let real: string
  try { real = await realpath(folder) }
  catch (error) {
    if (missing(error)) return canonical
    throw error
  }
  const found = await checkoutOnDisk(real)
  if (found) return pathKey(found.root ?? found.marker ?? canonical)
  try { return await canonicalCheckoutPath((await git(folder, ['rev-parse', '--show-toplevel'])).trim()) }
  catch {
    // Git can refuse safe.directory ownership checks. Its on-disk marker still groups root and subfolders.
    for (let candidate = canonical;; candidate = dirname(candidate)) {
      try { await lstat(join(candidate, '.git')); return candidate }
      catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
      if (dirname(candidate) === candidate) return canonical
    }
  }
}

// A host has separate thread and terminal services. They still share Git's registry,
// including when their projects start in different linked checkouts of one repository.
const registryOperations = new Map<string, Promise<void>>()
interface RegistryIdentity { readonly common: string; readonly key: string }
interface InspectionReads { readonly root: string; readonly common?: string; readonly listing?: string }
async function coordinateRegistry<T>(identity: RegistryIdentity, run: () => Promise<T>): Promise<T> {
  const previous = registryOperations.get(identity.key) ?? Promise.resolve()
  const operation = previous.then(run)
  // A rejected command keeps its original error but cannot poison the next operation.
  const settled = operation.then(() => undefined, () => undefined)
  registryOperations.set(identity.key, settled)
  try { return await operation }
  finally { if (registryOperations.get(identity.key) === settled) registryOperations.delete(identity.key) }
}

/**
 * A checkout's own Git directory and its repository's common one, from the `.git` entry at its root: a directory
 * for a main checkout, or a file pointing at the directory Git keeps for a linked worktree (or a submodule).
 */
async function gitDirectories(root: string): Promise<{ gitDir: string; commonDir: string; linked: boolean } | undefined> {
  const marker = join(root, '.git')
  const entry = await stat(marker)
  if (entry.isDirectory()) return { gitDir: marker, commonDir: marker, linked: false }
  if (!entry.isFile()) return
  const pointer = /^gitdir: (.+)$/u.exec((await readFile(marker, 'utf8')).trim())
  if (!pointer) return
  const gitDir = resolve(root, pointer[1]!.trim())
  const common = await readFile(join(gitDir, 'commondir'), 'utf8').then(text => text.trim(), error => { if (missing(error)) return undefined; throw error })
  return common === undefined ? { gitDir, commonDir: gitDir, linked: false } : { gitDir, commonDir: resolve(gitDir, common), linked: true }
}

/**
 * What a checkout's own files settle: that it is the checkout a record names, with the branch its HEAD names (none
 * for a detached HEAD, or for a folder in no repository), or that only Git can say.
 */
type CheckoutFiles = { readonly kind: 'checked-out'; readonly branch: string | undefined } | { readonly kind: 'ask-git' }
const ASK_GIT = { kind: 'ask-git' } as const

/** The branch a Git directory's HEAD names, none for a detached HEAD, or a HEAD only Git can read. */
async function headBranch(gitDir: string): Promise<CheckoutFiles> {
  const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim()
  const symbolic = /^ref: (\S+)$/u.exec(head)
  if (symbolic) {
    const ref = symbolic[1]!
    // A reftable repository keeps this stand-in in HEAD and its real HEAD elsewhere.
    if (ref === 'refs/heads/.invalid') return ASK_GIT
    return { kind: 'checked-out', branch: ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : undefined }
  }
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(head) ? { kind: 'checked-out', branch: undefined } : ASK_GIT
}

/**
 * A ready record following the branch its folder has checked out (ADR-0014): none for a detached HEAD, and a
 * temporary branch the folder has moved off is no longer the thread's to rename.
 */
export function withCheckedOutBranch(metadata: AgentWorktree, branch: string | undefined): AgentWorktree {
  return { ...metadata, branch, ...(metadata.temporaryBranch && branch !== metadata.branch ? { temporaryBranch: false } : {}) }
}

function registeredWorktrees(output: string): Array<{ path: string; branch: string | undefined; locked: boolean; lockReason: string | undefined; prunable: boolean }> {
  return output.split('\0\0').filter(Boolean).map(record => {
    const fields = record.split('\0')
    return { path: fields.find(field => field.startsWith('worktree '))?.slice(9) ?? '', branch: fields.find(field => field.startsWith('branch '))?.slice(7),
      locked: fields.some(field => field === 'locked' || field.startsWith('locked ')), lockReason: fields.find(field => field.startsWith('locked '))?.slice(7), prunable: fields.some(field => field === 'prunable' || field.startsWith('prunable ')) }
  })
}

/** Where a set of worktrees lives under Sotto's data folder, and how their branches are named. */
export interface WorktreeHome {
  readonly folder: string
  readonly branchPrefix: string
}
const THREAD_WORKTREE_HOME: WorktreeHome = { folder: 'thread-worktrees', branchPrefix: 'sotto/' }
export const TERMINAL_WORKTREE_HOME: WorktreeHome = { folder: 'terminal-worktrees', branchPrefix: 'sotto/terminal-' }

/** What reclaiming a worktree would touch, so the caller can name it before asking. */
export interface WorktreeReclaimFacts {
  readonly path: string
  readonly branch: string | undefined
  readonly dirty: boolean
  /** Ignored paths other than installed dependencies: build output, captures, anything a rule may not discard unasked. */
  readonly ignored: readonly string[]
  readonly items: readonly { path: string; bytes: number; fileCount: number }[]
  readonly repositories: readonly { path: string; changeCount: number; unpushedCommitCount?: number | undefined; kind: 'worktree' | 'repository' }[]
  readonly untracked: readonly string[]
  /** A link inside the folder that leads out of it. Removing the folder could follow it, so nothing is removed while one is there. */
  readonly outsideLink: string | undefined
}
export interface WorktreeReclaimOptions {
  /** The exact ignored paths displayed in the user's confirmation. */
  readonly confirmedIgnored?: readonly string[]
  readonly confirmedItems?: readonly { path: string; fileCount: number }[]
  readonly confirmedRepositories?: readonly { path: string; changeCount: number; unpushedCommitCount?: number | undefined; kind: 'worktree' | 'repository' }[]
  /** The user's answer to the uncommitted-changes confirmation. */
  readonly withUncommittedChanges?: boolean
  /** A rule acting on its own: a folder with anything but dependencies in its ignored files is left alone. */
  readonly automatic?: boolean
}
const DEPENDENCY_FOLDER = /(^|\/)node_modules\/$/u

/**
 * Creates and inspects checkouts, and reclaims a folder only when asked (ADR-0041): the branch and
 * the thread are never removed, and `restore` puts the folder back. Allocation is persisted by
 * WorkspaceHost before ensure.
 */
export class ThreadWorktrees {
  constructor(private readonly directory: string, private readonly git: RunGit = runWorktreeGit, private readonly home: WorktreeHome = THREAD_WORKTREE_HOME) {}

  /** Identity belongs to this operation, never to a cached cwd or persisted worktree record. */
  private async registryIdentity(cwd: string, verifyRef?: string): Promise<RegistryIdentity> {
    const output = await this.git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir', ...(verifyRef ? ['--verify', verifyRef] : [])])
    // Restore already verifies its saved ref. Git can return common-dir in that same
    // invocation; only the final fixed-format object ID is removed from its output.
    const common = (verifyRef ? output.replace(/\r?\n[a-f0-9]{40}(?:[a-f0-9]{24})?\r?\n?$/u, '') : output).trim()
    return { common, key: pathKey(await realpath(common)) }
  }

  private async registry(cwd: string, args: string[], identity?: RegistryIdentity): Promise<string> {
    return coordinateRegistry(identity ?? await this.registryIdentity(cwd), () => this.git(cwd, args))
  }

  /** Only the fresh token path this add started may be cleaned up after its own deadline. */
  private async addWorktree(repositoryRoot: string, path: string, branch: string, args: string[], identity: RegistryIdentity): Promise<void> {
    await coordinateRegistry(identity, async () => {
      try { return await this.git(repositoryRoot, args) }
      catch (error) {
        if (!(error instanceof Error) || !('timedOut' in error) || error.timedOut !== true) throw error
        try {
          const entries = registeredWorktrees(await this.git(repositoryRoot, ['worktree', 'list', '--porcelain', '-z']))
          const entry = entries.find(item => pathKey(item.path) === pathKey(path))
          if (entry && (entry.lockReason !== 'initializing' || (entry.branch && entry.branch !== `refs/heads/${branch}`))) throw new Error('The incomplete checkout is no longer initializing on its reserved branch.', { cause: error })
          if (entry) {
            const present = await lstat(path).then(() => true, (failure: NodeJS.ErrnoException) => { if (failure.code === 'ENOENT') return false; throw failure })
            if (present) {
              if (pathKey(await realpath(path)) !== pathKey(path) || !(await lstat(join(path, '.git'))).isFile()) throw new Error('The incomplete folder was replaced.', { cause: error })
              const common = (await this.git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
              if (pathKey(common) !== pathKey(identity.common) || await this.outsideLink(path)) throw new Error('The incomplete folder was redirected.', { cause: error })
              await this.verifyIncompleteCheckout(path, branch)
            }
            await this.git(repositoryRoot, ['worktree', 'unlock', '--', path])
            await this.git(repositoryRoot, ['worktree', 'remove', '--force', '--', path])
          } else if (await lstat(path).then(() => true, (failure: NodeJS.ErrnoException) => { if (failure.code === 'ENOENT') return false; throw failure })) {
            throw new Error('The incomplete folder is not registered to this checkout.', { cause: error })
          }
        } catch (cleanupError) {
          throw new Error('Worktree setup took too long. The incomplete folder was kept because it could not be safely removed. Move any local files out and restore the checkout before retrying.', { cause: cleanupError })
        }
        throw new Error('Worktree setup took too long. Retry setup to continue on the same branch.', { cause: error })
      }
    })
  }

  /** A killed reset may not have written the index. Compare present files with the branch itself. */
  private async verifyIncompleteCheckout(path: string, branch: string): Promise<void> {
    const files: string[] = []
    const links = new Map<string, Buffer>()
    const visit = async (directory: string): Promise<void> => {
      const handle = await opendir(directory)
      for await (const entry of handle) {
        if (directory === path && entry.name === '.git') continue
        const full = join(directory, entry.name)
        if (entry.isDirectory()) await visit(full)
        else {
          const local = relative(path, full).split(sep).join('/')
          if (entry.isSymbolicLink()) links.set(local, await readlink(full, { encoding: 'buffer' }))
          else if (!entry.isFile()) throw new Error('The incomplete folder contains local files.')
          files.push(local)
        }
      }
    }
    await visit(path)
    // Bound each argument list on Windows. Hashing applies the checkout's normal clean filters.
    for (let offset = 0; offset < files.length; offset += 32) {
      const batch = files.slice(offset, offset + 32)
      // Read only these files, not the whole potentially huge branch tree. Paths are always literal.
      const tree = await this.git(path, ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--full-tree', `refs/heads/${branch}`, '--', ...batch])
      const blobs = new Map(tree.split('\0').filter(Boolean).map(record => {
        const tab = record.indexOf('\t')
        const [mode, , hash] = record.slice(0, tab).split(' ')
        return [record.slice(tab + 1), { mode, hash: hash! }]
      }))
      if (batch.some(file => !blobs.has(file))) throw new Error('The incomplete folder contains local files.')
      for (const file of batch) {
        const target = links.get(file), blob = blobs.get(file)!
        if (target) {
          const hash = createHash(blob.hash.length === 64 ? 'sha256' : 'sha1').update(`blob ${target.length}\0`).update(target).digest('hex')
          if (blob.mode !== '120000' || hash !== blob.hash) throw new Error('The incomplete folder contains local changes.')
        } else if (blob.mode !== '100644' && blob.mode !== '100755' && blob.mode !== '120000') throw new Error('The incomplete folder contains local changes.')
      }
      const regular = batch.filter(file => !links.has(file))
      if (!regular.length) continue
      const hashes = (await this.git(path, ['hash-object', '--', ...regular])).trim().split(/\r?\n/u)
      if (hashes.length !== regular.length || regular.some((file, index) => hashes[index] !== blobs.get(file)!.hash)) throw new Error('The incomplete folder contains local changes.')
    }
  }

  /**
   * Start from origin, T3's way (ADR-0014, amended September 24, 2026): fetch the base when origin has it, fall back
   * to the local branch when origin does not, and skip the fetch for a project with no origin at all. Only a fetch
   * that fails for another reason, the connection or the credentials, stops setup. The answer is kept on the
   * worktree so the pane can say which happened.
   */
  private async resolveOriginBase(repositoryRoot: string, baseBranch: string): Promise<NonNullable<AgentWorktree['originBase']>> {
    // No origin is an answer; Git being unavailable is not, and the message runWorktreeGit gives it must reach the user.
    try { await this.git(repositoryRoot, ['remote', 'get-url', 'origin']) }
    catch (error) { if (error instanceof Error && /Git is unavailable/u.test(error.message)) throw error; return 'no-origin' }
    const failure = new Error(`The origin branch ${baseBranch} could not be fetched. Check the remote and connection, or choose a local branch under Start from.`)
    // --exit-code answers 2 for a remote that is reachable and has no such branch; anything else is a real failure.
    try { await this.git(repositoryRoot, ['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${baseBranch}`]) }
    catch (error) { if ((error as { code?: unknown }).code === 2) return 'not-on-origin'; throw failure }
    try { await this.git(repositoryRoot, ['fetch', '--no-tags', 'origin', `refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`]) }
    catch { throw failure }
    return 'fetched'
  }

  /**
   * `checkoutBranch` names a branch that exists already, such as a pull request's head: the worktree checks it
   * out as it stands rather than cutting a new branch from a base.
   */
  async allocate(projectPath: string, mode: 'independent' | 'shared', selection: Partial<AgentWorkingCopySelection> & { readonly checkoutBranch?: string | undefined } = {}): Promise<AgentWorktree> {
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
      const identity = await this.registryIdentity(repositoryRoot)
      const entries = registeredWorktrees(await this.registry(repositoryRoot, ['worktree', 'list', '--porcelain', '-z'], identity))
      const entry = entries.find(item => pathKey(item.path) === pathKey(path))
      if (!entry || entry.locked || entry.prunable) throw new Error('That folder is not an available worktree of this project. Refresh the worktree list and choose again.')
      const projectRelativePath = relative(await realpath(repositoryRoot), cwd).split(sep).join('/')
      return (await this.inspectWithin({ mode, status: 'ready', path, repositoryRoot: await realpath(repositoryRoot), projectRelativePath, reused: true }, identity)).worktree
    }
    const checkoutBranch = selection.checkoutBranch
    if (checkoutBranch) {
      await this.git(repositoryRoot, ['check-ref-format', `refs/heads/${checkoutBranch}`])
      let branchCommit: string
      try { branchCommit = (await this.git(repositoryRoot, ['rev-parse', '--verify', `refs/heads/${checkoutBranch}^{commit}`])).trim() }
      catch { throw new Error(`The branch ${checkoutBranch} is gone. Check the pull request out again from the branch picker.`) }
      const relativePath = relative(await realpath(repositoryRoot), cwd).split(sep).join('/')
      const token = randomUUID()
      return { mode, status: 'pending', path: join(await realpath(this.directory), this.home.folder, token), repositoryRoot: await realpath(repositoryRoot), branch: checkoutBranch, baseCommit: branchCommit, projectRelativePath: relativePath, checkoutBranch: true, temporaryBranch: false }
    }
    const baseBranch = selection.baseBranch ?? (selection.startFromOrigin ? (await this.git(repositoryRoot, ['branch', '--show-current'])).trim() || undefined : undefined)
    if (baseBranch) await this.git(repositoryRoot, ['check-ref-format', `refs/heads/${baseBranch}`])
    if (selection.startFromOrigin && !baseBranch) throw new Error('Choose a base branch before starting from origin.')
    const originBase = selection.startFromOrigin && baseBranch ? await this.resolveOriginBase(repositoryRoot, baseBranch) : undefined
    const base = baseBranch ? `${originBase === 'fetched' ? 'refs/remotes/origin/' : 'refs/heads/'}${baseBranch}` : 'HEAD'
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
    return { mode, status: 'pending', ...(originBase ? { originBase } : {}), path: join(await realpath(this.directory), this.home.folder, token), repositoryRoot: await realpath(repositoryRoot), branch: `${this.home.branchPrefix}${this.home === THREAD_WORKTREE_HOME ? token.slice(0, 8) : token}`, baseCommit, projectRelativePath, baseBranch, startFromOrigin: selection.startFromOrigin, temporaryBranch: this.home === THREAD_WORKTREE_HOME }
  }


  async options(projectPath: string): Promise<AgentWorkingCopyOptions> {
    const cwd = await existingWorkingDirectory(projectPath)
    let identity: RegistryIdentity
    try { identity = await this.registryIdentity(cwd) }
    catch (error) {
      if (error instanceof Error && /not a git repository|Git is unavailable/u.test(error.message)) return { isGit: false, currentBranch: null, branches: [], worktrees: [] }
      throw error
    }
    const [branch, branches, entries] = await Promise.all([
      this.git(cwd, ['branch', '--show-current']), this.git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
      this.registry(cwd, ['worktree', 'list', '--porcelain', '-z'], identity),
    ])
    return { isGit: true, currentBranch: branch.trim() || null, branches: branches.split(/\r?\n/u).filter(Boolean),
      worktrees: registeredWorktrees(entries).filter(entry => !entry.locked && !entry.prunable).map(entry => ({ path: entry.path, branch: entry.branch?.replace(/^refs\/heads\//u, '') ?? null })) }
  }

  /** Canonical checkout root, so a subdirectory and its root count as the same working copy. */
  async checkoutIdentity(directory: string): Promise<string> {
    return checkoutIdentity(await existingWorkingDirectory(directory), this.git)
  }

  /** Discover an established session's folder without moving it or creating anything. */
  async discover(directory: string, projectPath: string): Promise<AgentWorktree> {
    const path = await existingWorkingDirectory(directory)
    let root: string
    try { root = await existingWorkingDirectory((await this.git(path, ['rev-parse', '--show-toplevel'])).trim()) }
    catch (error) {
      if (error instanceof Error && /not a git repository|Git is unavailable/u.test(error.message)) return { mode: 'shared', status: 'ready', path }
      throw error
    }
    let projectRoot: string | undefined
    try { projectRoot = await this.checkoutIdentity(projectPath) } catch { /* The established folder still defines its session. */ }
    // Equal checkout roots already establish the shared-folder result; no registry scan is needed.
    if (pathKey(root) === projectRoot) return (await this.inspectWithin({ mode: 'shared', status: 'ready', path }, undefined, { root })).worktree
    const identity = await this.registryIdentity(root)
    const listing = await this.registry(root, ['worktree', 'list', '--porcelain', '-z'], identity)
    const entries = registeredWorktrees(listing)
    const registered = entries.find(entry => pathKey(entry.path) === pathKey(root))
    if (pathKey(root) !== projectRoot && registered && pathKey(entries[0]?.path ?? root) !== pathKey(root)) {
      // Carry this discovery's reads, not a cached binding. Inspection still obtains
      // the main checkout's common directory independently before allowing status.
      return (await this.inspectWithin({ mode: 'independent', status: 'ready', path: root, repositoryRoot: await existingWorkingDirectory(entries[0]!.path),
        projectRelativePath: relative(root, path).split(sep).join('/'), reused: true }, undefined, { root, common: identity.common, listing })).worktree
    }
    return (await this.inspectWithin({ mode: 'shared', status: 'ready', path }, undefined, { root })).worktree
  }

  async renameTemporaryBranch(metadata: AgentWorktree, name: string): Promise<AgentWorktree> {
    if (!metadata.temporaryBranch || metadata.reused || !metadata.branch) return metadata
    const { worktree: inspected, identity } = await this.inspectWithin(metadata)
    if (inspected.branch !== metadata.branch) return { ...inspected, temporaryBranch: false }
    const slug = name.replace(/^sotto\//u, '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 60).replace(/-$/u, '')
    if (!slug) return inspected
    const branch = `sotto/${slug}`
    await this.registry(inspected.path!, ['branch', '-m', metadata.branch, branch], identity)
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
    const identity = await this.registryIdentity(repositoryRoot)
    // A checkout Sotto already made and then lost is recreated from its recorded branch (ADR-0014).
    if (metadata.status !== 'pending') await this.restore(metadata)
    const entries = registeredWorktrees(await this.registry(repositoryRoot, ['worktree', 'list', '--porcelain', '-z'], identity))
    const registered = entries.find(entry => pathKey(entry.path) === pathKey(metadata.path!))
    if (registered) {
      if (registered.locked || registered.prunable) throw new Error('Git has locked this worktree or reports an incomplete checkout. Wait for setup to finish or restore the checkout, then retry.')
      const path = await existingWorkingDirectory(metadata.path)
      // A replaced symlink/junction is not the allocated checkout.
      if (pathKey(path) !== pathKey(metadata.path)) throw new Error('The reserved working folder was redirected. Nothing was changed.')
      // An existing checkout is reused on whatever branch it has (ADR-0014); inspect records it.
      return (await this.inspectWithin({ ...metadata, status: 'ready', error: undefined }, identity)).worktree
    }
    if (!branch) throw new Error('The independent working-copy allocation is incomplete.')
    if (await lstat(metadata.path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error })) throw new Error('The reserved working folder already exists but is not this thread’s Git worktree. Nothing was changed.')
    if (entries.some(entry => entry.branch === `refs/heads/${branch}`)) throw new Error('The reserved branch is already checked out in another folder. Nothing was changed.')
    // -b refuses any existing branch; never reset it with -B or force another checkout. A pull request's branch
    // exists already and is checked out as it stands, with no -b.
    await mkdir(allocationRoot, { recursive: true })
    if (pathKey(await realpath(allocationRoot)) !== pathKey(allocationRoot)) throw new Error('The reserved worktree parent folder was redirected. Nothing was changed.')
    await this.addWorktree(repositoryRoot, metadata.path, branch, metadata.checkoutBranch ? ['worktree', 'add', '--', metadata.path, branch] : ['worktree', 'add', '-b', branch, '--', metadata.path, baseCommit], identity)
    return (await this.inspectWithin({ ...metadata, status: 'ready', error: undefined }, identity)).worktree
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
    let identity: RegistryIdentity
    try { identity = await this.registryIdentity(repositoryRoot, `refs/heads/${branch}`) }
    catch { return metadata }
    const refuseAnotherFolder = async () => {
      const entries = registeredWorktrees(await this.registry(repositoryRoot, ['worktree', 'list', '--porcelain', '-z'], identity))
      const occupant = entries.find(entry => entry.branch === `refs/heads/${branch}` && pathKey(entry.path) !== pathKey(path))
      if (occupant) throw new Error(`The branch ${branch} is checked out in ${occupant.path}, so this thread’s folder cannot be put back on it. Nothing was lost or changed. Close that folder’s checkout or move it to another branch, then retry.`)
      return entries
    }
    const entries = await refuseAnotherFolder()
    // Remove only this missing folder's registration. Other missing checkouts may be on unplugged drives.
    if (entries.some(entry => pathKey(entry.path) === pathKey(path))) await this.registry(repositoryRoot, ['worktree', 'remove', '--', path], identity)
    await refuseAnotherFolder()
    await mkdir(allocationRoot, { recursive: true })
    if (pathKey(await realpath(allocationRoot)) !== pathKey(allocationRoot)) throw new Error('The reserved worktree parent folder was redirected. Nothing was changed.')
    // No -b and no -B: the recorded branch is checked out as it stands, with its commits.
    try { await this.addWorktree(repositoryRoot, path, branch, ['worktree', 'add', '--', path, branch], identity) }
    catch (error) { throw new Error(`This thread’s working folder was missing and Sotto could not put it back on ${branch}. Nothing was lost; the branch still has its commits. ${error instanceof Error ? error.message : ''}`.trim(), { cause: error }) }
    return { ...metadata, status: 'ready', error: undefined, reclaimedAt: undefined }
  }

  /**
   * What reclaiming this thread's worktree would discard, read from the folder: uncommitted changes,
   * ignored files other than installed dependencies, and any link that leads out of the folder.
   */
  async reclaimFacts(metadata: AgentWorktree): Promise<WorktreeReclaimFacts> {
    return (await this.reclaimFactsWithin(metadata)).facts
  }

  private async reclaimFactsWithin(metadata: AgentWorktree, identityInLane?: RegistryIdentity): Promise<{ facts: WorktreeReclaimFacts; identity?: RegistryIdentity; submodules: string[]; nestedWorktrees: { path: string; commonDirectory: string }[] }> {
    const observed = identityInLane ? { root: (await this.git(metadata.path!, ['rev-parse', '--show-toplevel'])).trim(), listing: await this.git(metadata.repositoryRoot!, ['worktree', 'list', '--porcelain', '-z']) } : undefined
    const { worktree: inspected, identity } = await this.inspectWithin(metadata, identityInLane, observed, true)
    const path = inspected.path!
    const [listing, untrackedListing] = await Promise.all([
      this.git(path, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']),
      this.git(path, ['ls-files', '--others', '--exclude-standard', '-z']),
    ])
    const ignored = listing.split('\0').filter(entry => entry && !DEPENDENCY_FOLDER.test(entry)).sort()

    const items: Array<{ path: string; bytes: number; fileCount: number }> = []
    const repositories: Array<{ path: string; changeCount: number; unpushedCommitCount?: number | undefined; kind: 'worktree' | 'repository' }> = []
    const submodules: string[] = []
    const inspectedSubmoduleDirectories = new Set<string>()
    const nestedWorktrees: { path: string; commonDirectory: string }[] = []
    const canonicalRoot = await realpath(path)
    let outsideLink: string | undefined
    const visit = async (directory: string, row?: { path: string; bytes: number; fileCount: number }, gitMetadata = false, indexRoot = path): Promise<void> => {
      const handle = await opendir(directory)
      for await (const entry of handle) {
        if (directory === path && entry.name === '.git') continue
        const full = join(directory, entry.name)
        const local = relative(path, full).split(sep).join('/')
        const info = await lstat(full)
        if (info.isSymbolicLink()) {
          const target = resolve(directory, await readlink(full))
          const canonical = await realpath(target).catch(() => target)
          const delta = relative(canonicalRoot, canonical)
          if (isAbsolute(delta) || delta === '..' || delta.startsWith(`..${sep}`)) outsideLink ??= local
        }
        const ignoredPath = ignored.find(item => item === local || item === local + '/')
        const summary = ignoredPath ? { path: ignoredPath, bytes: 0, fileCount: 0 } : row
        if (ignoredPath) items.push(summary!)
        if (info.isDirectory() && !info.isSymbolicLink()) {
          // Dependencies need link inspection but never become rows. A gitlink belongs to the parent index.
          const gitMarker = await lstat(join(full, '.git')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
          const bareCandidate = !gitMarker && entry.name !== '.git' && !gitMetadata && await lstat(join(full, 'HEAD')).then(info => info.isFile(), () => false) && await lstat(join(full, 'objects')).then(info => info.isDirectory(), () => false)
          const bare = bareCandidate && (await this.git(full, ['rev-parse', '--is-bare-repository'])).trim() === 'true'
          if (!gitMetadata && entry.name !== '.git' && (gitMarker || bare)) {
            const indexedPath = relative(indexRoot, full).split(sep).join('/')
            const indexEntry = await this.git(indexRoot, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', indexedPath])
            const submodule = indexEntry.split('\0').some(record => record.startsWith('160000 ') && record.slice(record.indexOf('\t') + 1) === indexedPath)
            const status = bare ? '' : await this.git(full, ['status', '--porcelain', '--untracked-files=all', '-z'])
            const ignoredModule = submodule ? (await this.git(full, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])).split('\0').filter(item => item && !DEPENDENCY_FOLDER.test(item)) : []
            // A submodule's .git file points into metadata removed with the parent worktree.
            // Its history is at risk even when its checkout matches the parent's recorded commit.
            const kind = !submodule && gitMarker?.isFile() ? 'worktree' : 'repository'
            const history = kind === 'repository' ? { unpushedCommitCount: Number((await this.git(full, ['rev-list', '--count', '--all', '--not', '--remotes'])).trim()) } : {}
            if (submodule) {
              submodules.push(local)
              const directory = gitMarker!.isFile() ? resolve(full, (await readFile(join(full, '.git'), 'utf8')).trim().replace(/^gitdir: /u, '')) : join(full, '.git')
              inspectedSubmoduleDirectories.add(pathKey(await realpath(directory)))
            }
            if (!submodule && gitMarker?.isFile()) {
              const commonDirectory = (await this.git(full, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
              const registration = registeredWorktrees(await this.git(commonDirectory, ['worktree', 'list', '--porcelain', '-z'])).find(item => pathKey(item.path) === pathKey(full))
              if (registration?.locked) throw new Error('A nested worktree is locked. Nothing was removed. Unlock it in its own repository, then choose Remove worktree again.')
              const delta = relative(canonicalRoot, commonDirectory)
              // A repository inside the removed folder loses its own registry with it.
              if (isAbsolute(delta) || delta === '..' || delta.startsWith(`..${sep}`)) nestedWorktrees.push({ path: full, commonDirectory })
            }
            if (!submodule || status.length || ignoredModule.length || history.unpushedCommitCount) {
              const records = status.split('\0').filter(Boolean)
              // Porcelain -z gives a second path for renames, not a second change.
              let changeCount = 0
              for (let i = 0; i < records.length; i++) { changeCount++; if (/^[RC]|^.[RC]/u.test(records[i]!)) i++ }
              const repositoryPath = local + '/'
              repositories.push({ path: repositoryPath, changeCount, ...history, kind })
              if (!ignored.includes(repositoryPath)) { ignored.push(repositoryPath); items.push({ path: repositoryPath, bytes: 0, fileCount: 0 }) }
            }
          }
          await visit(full, entry.name === 'node_modules' ? undefined : summary, gitMetadata || entry.name === '.git' || bare, gitMarker && !gitMetadata && entry.name !== '.git' ? full : indexRoot)
        } else {
          if (summary) { summary.bytes += info.size; summary.fileCount++ }
          // Nested repository rows can overlap an ignored parent row. Count their contents too,
          // including ignored files that their own status output does not name.
          for (const item of items) {
            if (item !== summary && item.path.endsWith('/') && local.startsWith(item.path)) { item.bytes += info.size; item.fileCount++ }
          }
        }
      }
    }
    await visit(path)
    // Deinitializing a submodule empties its checkout but keeps its history in this worktree's
    // Git directory. Force removal destroys that metadata too, including recursive submodules.
    const rootMarker = await lstat(join(path, '.git'))
    if (rootMarker.isFile()) {
      const gitDirectory = resolve(path, (await readFile(join(path, '.git'), 'utf8')).trim().replace(/^gitdir: /u, ''))
      const modulesDirectory = join(gitDirectory, 'modules')
      let modulePaths: Map<string, string> | undefined
      const retainedModules = async (directory: string): Promise<void> => {
        const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
        if (!info) return
        if (info.isSymbolicLink()) { outsideLink ??= '.git/modules/'; return }
        if (!info.isDirectory()) return
        const head = await lstat(join(directory, 'HEAD')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
        if (head?.isFile()) {
          if (!inspectedSubmoduleDirectories.has(pathKey(await realpath(directory)))) {
            // Recursive deinit keeps core.worktree pointing at a deleted checkout. History reads
            // need no checkout, so override that path with the existing metadata directory.
            const unpushedCommitCount = Number((await this.git(directory, ['--git-dir', directory, '--work-tree', directory, 'rev-list', '--count', '--all', '--not', '--remotes'])).trim())
            // Git also refuses ordinary removal for retained recursive metadata. The final
            // scan must cover its history before force removal, even when every ref is published.
            submodules.push(`.git/modules/${relative(modulesDirectory, directory).split(sep).join('/')}/`)
            if (unpushedCommitCount) {
              // Read the checkout path from the parent's .gitmodules when it is still recorded;
              // orphaned or recursive metadata retains its own visible path.
              if (!modulePaths) {
                modulePaths = new Map()
                if (await lstat(join(path, '.gitmodules')).then(info => info.isFile(), (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error })) {
                  for (const record of (await this.git(path, ['config', '--file', join(path, '.gitmodules'), '--null', '--list'])).split('\0')) {
                    const match = /^submodule\.(.+)\.path\n([\s\S]+)$/u.exec(record)
                    if (match) modulePaths.set(match[1]!, match[2]!)
                  }
                }
              }
              const moduleName = relative(modulesDirectory, directory).split(sep).join('/')
              const recordedPath = modulePaths.get(moduleName)
              const checkout = recordedPath ? relative(canonicalRoot, resolve(path, recordedPath)) : ''
              const metadataPath = `.git/modules/${moduleName}/`
              const local = checkout && !isAbsolute(checkout) && checkout !== '..' && !checkout.startsWith(`..${sep}`) ? checkout.split(sep).join('/') + '/' : metadataPath
              // A replacement checkout may already have its own row; retained history still needs one.
              const repositoryPath = repositories.some(item => item.path === local) ? metadataPath : local
              const existingRow = items.find(item => item.path === repositoryPath)
              const row = existingRow ?? { path: repositoryPath, bytes: 0, fileCount: 0 }
              repositories.push({ path: repositoryPath, changeCount: 0, unpushedCommitCount, kind: 'repository' })
              if (!ignored.includes(repositoryPath)) ignored.push(repositoryPath)
              if (!existingRow) items.push(row)
              await visit(directory, row, true)
            }
          }
          await retainedModules(join(directory, 'modules'))
          return
        }
        const handle = await opendir(directory)
        for await (const entry of handle) await retainedModules(join(directory, entry.name))
      }
      await retainedModules(modulesDirectory)
    }
    ignored.sort()
    repositories.sort((a, b) => a.path.localeCompare(b.path))
    return { ...(identity ? { identity } : {}), submodules, nestedWorktrees, facts: { path, branch: inspected.branch, dirty: inspected.dirty === true, ignored, items, repositories, untracked: untrackedListing.split('\0').filter(Boolean).sort(), outsideLink } }
  }

  /**
   * Removes this thread's own worktree folder and nothing else (ADR-0041). The branch keeps its
   * commits, the thread keeps its record, and `restore` puts the folder back on the next send. It
   * refuses a folder that is not the registered checkout, one with no branch to come back on, one
   * holding a link out of itself, and, for a rule acting alone, one with anything but dependencies
   * among its ignored files. Uncommitted work goes only after the user's answer.
   */
  async reclaim(metadata: AgentWorktree, options: WorktreeReclaimOptions = {}): Promise<AgentWorktree> {
    if (metadata.mode !== 'independent' || metadata.reused) throw new Error('Only a worktree Sotto made for this thread can be removed. A shared or reused folder stays.')
    const allocationRoot = join(await realpath(this.directory), this.home.folder)
    if (!metadata.path || pathKey(dirname(metadata.path)) !== pathKey(allocationRoot) || !/^[a-f0-9-]{36}$/u.test(basename(metadata.path))) throw new Error('This folder is outside Sotto’s reserved worktree folder. Nothing was changed.')
    const { facts, identity } = await this.reclaimFactsWithin(metadata)
    if (!facts.branch) throw new Error('This folder has no branch checked out, so Sotto could not put it back. Switch it to a branch first. Nothing was changed.')
    if (facts.outsideLink) throw new Error(`This folder contains a link to another folder (${facts.outsideLink}). Remove the link first so nothing outside the folder is touched. Nothing was changed.`)
    if (options.automatic && facts.ignored.length) throw new Error('This folder holds ignored files besides installed dependencies, so a rule leaves it alone.')
    if (!options.automatic && facts.ignored.length && !options.confirmedIgnored) throw new Error('This folder holds ignored files. Nothing was removed. Choose Remove worktree to review them.')
    if (!options.automatic && ((facts.ignored.length && !options.confirmedIgnored) || (options.confirmedIgnored && JSON.stringify([...options.confirmedIgnored].sort()) !== JSON.stringify(facts.ignored)))) throw new Error('The ignored items changed. Nothing was removed. Close this question and choose Remove worktree again to review them.')
    if (facts.repositories.length && JSON.stringify(options.confirmedRepositories) !== JSON.stringify(facts.repositories)) throw new Error('The nested work changed. Nothing was removed. Choose Remove worktree again to review it.')
    // A rule never answers the confirmation on the user's behalf.
    if (facts.dirty && (options.automatic || !options.withUncommittedChanges)) throw new Error(RECLAIM_WORKTREE_NEEDS_CONFIRMATION)
    // A linked worktree's .git is a file; a directory there is a repository of its own and is never removed.
    if (!(await lstat(join(facts.path, '.git'))).isFile()) throw new Error('This folder is a repository of its own, not a worktree. Nothing was changed.')
    // Take the last observation inside the registry lane, immediately before the destructive command.
    const nestedWorktrees = await coordinateRegistry(identity!, async () => {
      const { facts: latest, submodules, nestedWorktrees } = await this.reclaimFactsWithin(metadata, identity)
      const counts = (items: readonly { path: string; fileCount: number }[]) => JSON.stringify(items.map(({ path, fileCount }) => ({ path, fileCount })).sort((a, b) => a.path.localeCompare(b.path)))
      if (!options.automatic && counts(options.confirmedItems ?? []) !== counts(latest.items)) throw new Error('The folder changed. Nothing was removed. Choose Remove worktree again to see the new list.')
      if (latest.outsideLink || latest.branch !== facts.branch || latest.dirty !== facts.dirty ||
        JSON.stringify(latest.ignored) !== JSON.stringify(facts.ignored) ||
        JSON.stringify(latest.untracked) !== JSON.stringify(facts.untracked) ||
        JSON.stringify(latest.repositories) !== JSON.stringify(facts.repositories)) throw new Error('The files changed. Nothing was removed. Choose Remove worktree again to review them.')
      const [ignoredNow, untrackedNow, statusNow] = await Promise.all([
        this.git(facts.path, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']),
        this.git(facts.path, ['ls-files', '--others', '--exclude-standard', '-z']),
        this.git(facts.path, ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none']),
      ])
      const ignoredRows = [...new Set([...ignoredNow.split('\0').filter(item => item && !DEPENDENCY_FOLDER.test(item)), ...latest.repositories.map(item => item.path)])].sort()
      if (JSON.stringify(ignoredRows) !== JSON.stringify(facts.ignored) ||
        JSON.stringify(untrackedNow.split('\0').filter(Boolean).sort()) !== JSON.stringify(facts.untracked) ||
        Boolean(statusNow.length) !== facts.dirty) throw new Error('The files changed. Nothing was removed. Choose Remove worktree again to review them.')
      // Git's ordinary clean check refuses initialized submodules. Our final check covered their contents.
      await this.git(metadata.repositoryRoot!, ['worktree', 'remove', ...(facts.dirty || facts.repositories.length || submodules.length ? ['--force'] : []), '--', facts.path])
      return nestedWorktrees
    })
    for (const nested of nestedWorktrees) {
      try { await this.registry(nested.commonDirectory, ['worktree', 'remove', '--force', '--', nested.path]) }
      catch (error) { throw new Error('The folder was removed, but Git could not clear a nested worktree registration. Run git worktree prune in that repository before using its branch again.', { cause: error }) }
    }
    return { ...metadata, branch: facts.branch, status: 'ready', error: undefined, dirty: undefined, reclaimedAt: new Date().toISOString() }
  }

  /** The first link under `root` whose target is outside it, if any. Walks without following links. */
  private async outsideLink(root: string): Promise<string | undefined> {
    const canonicalRoot = await realpath(root)
    const pending = [root]
    while (pending.length) {
      const directory = pending.pop()!
      const handle = await opendir(directory)
      try {
        for await (const entry of handle) {
          const full = join(directory, entry.name)
          if (entry.isSymbolicLink()) {
            const target = resolve(directory, await readlink(full).catch(() => full))
            const canonical = await realpath(target).catch(() => target)
            const local = relative(canonicalRoot, canonical)
            if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) return relative(root, full)
          } else if (entry.isDirectory()) pending.push(full)
        }
      } finally { await handle.close().catch(() => undefined) }
    }
    return undefined
  }

  /**
   * Switches the thread's own worktree back to `branch`, which the user asked for by hand: Sotto never
   * switches a branch on its own (ADR-0014). The folder is verified first, the branch must already exist,
   * and uncommitted work is left where it is for Git to carry across or refuse.
   */
  async switchBranch(metadata: AgentWorktree, branch: string): Promise<AgentWorktree> {
    // The name came from Git itself; refuse anything that could read as an option or a path.
    if (!/^(?!-)(?!.*\.\.)[^\s:?*~^[\]\\]+$/u.test(branch)) throw new Error('That branch name cannot be restored. Switch it in the folder itself.')
    const inspection = await this.inspectWithin(metadata)
    const inspected = inspection.worktree
    let identity = inspection.identity
    if (inspected.branch === branch) return inspected
    try {
      if (identity) await this.git(inspected.path!, ['rev-parse', '--verify', `refs/heads/${branch}`])
      else identity = await this.registryIdentity(inspected.path!, `refs/heads/${branch}`)
    }
    catch { throw new Error(`The branch ${branch} no longer exists in this repository. Nothing was changed.`) }
    // --no-guess never creates a branch from a remote; a conflicting change makes Git refuse and nothing moves.
    await this.registry(inspected.path!, ['switch', '--no-guess', branch], identity)
    return this.inspect(inspected)
  }

  async inspect(metadata: AgentWorktree): Promise<AgentWorktree> {
    return (await this.inspectWithin(metadata)).worktree
  }

  /**
   * What `inspect` would record of a ready record, read from the checkout's own files instead of Git, so a send
   * starts no Git process before its prompt goes out (issue #766): the folder is there, it is the checkout the
   * record names (for a worktree, not reached through a link, and one the original repository's registry lists,
   * points back at and has not locked), and the record follows the branch its HEAD names. `ask-git` whenever the
   * files do not settle all of that, and then the caller asks Git with `inspect`. It reads no uncommitted changes;
   * the inspection after the send does. Each refusal here is one `inspectWithin` makes with Git, and
   * `threadWorktrees.test.ts` runs both over the same folders.
   */
  async readyOnDisk(metadata: AgentWorktree): Promise<{ readonly kind: 'ready'; readonly worktree: AgentWorktree } | typeof ASK_GIT> {
    let files: CheckoutFiles
    try { files = await this.checkoutFiles(metadata) } catch { return ASK_GIT }
    return files.kind === 'ask-git' ? files : { kind: 'ready', worktree: withCheckedOutBranch(metadata, files.branch) }
  }

  private async checkoutFiles(metadata: AgentWorktree): Promise<CheckoutFiles> {
    if (!metadata.path || metadata.status !== 'ready' || metadata.reclaimedAt) return ASK_GIT
    const path = await realpath(metadata.path)
    if (!(await stat(path)).isDirectory()) return ASK_GIT
    if (metadata.mode === 'shared') {
      const found = await checkoutOnDisk(path)
      if (!found) return ASK_GIT
      // A folder outside any repository, as it was when it was last inspected.
      if (found.root === null) return metadata.repositoryRoot === undefined ? { kind: 'checked-out', branch: undefined } : ASK_GIT
      if (!metadata.repositoryRoot || pathKey(found.root) !== pathKey(metadata.repositoryRoot)) return ASK_GIT
      const directories = await gitDirectories(found.root)
      return directories ? headBranch(directories.gitDir) : ASK_GIT
    }
    // A worktree reached through a link is not the checkout Sotto made.
    if (!metadata.repositoryRoot || pathKey(path) !== pathKey(metadata.path)) return ASK_GIT
    const directories = await gitDirectories(path)
    if (!directories) return ASK_GIT
    let gitDir = directories.gitDir
    if (directories.linked) {
      // Git's registry entry for this checkout: under the original repository's worktrees, naming this folder.
      // An entry whose `gitdir` is missing or names another folder is one Git reports as prunable.
      const expected = await gitDirectories(await realpath(metadata.repositoryRoot))
      if (!expected) return ASK_GIT
      const [common, expectedCommon] = await Promise.all([realpath(directories.commonDir), realpath(expected.commonDir)])
      gitDir = await realpath(gitDir)
      if (pathKey(common) !== pathKey(expectedCommon) || pathKey(dirname(gitDir)) !== pathKey(join(common, 'worktrees'))) return ASK_GIT
      if (pathKey(resolve(gitDir, (await readFile(join(gitDir, 'gitdir'), 'utf8')).trim())) !== pathKey(join(path, '.git'))) return ASK_GIT
      if (await stat(join(gitDir, 'locked')).then(() => true, error => { if (missing(error)) return false; throw error })) return ASK_GIT
    } else if (pathKey(path) !== pathKey(await realpath(metadata.repositoryRoot))) return ASK_GIT
    if (metadata.projectRelativePath) {
      const directory = await realpath(resolve(path, metadata.projectRelativePath))
      const local = relative(path, directory)
      if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`) || !(await stat(directory)).isDirectory()) return ASK_GIT
    }
    return headBranch(gitDir)
  }

  private async inspectWithin(metadata: AgentWorktree, identity?: RegistryIdentity, observed?: InspectionReads, reclaiming = false): Promise<{ worktree: AgentWorktree; identity?: RegistryIdentity }> {
    if (!metadata.path) throw new Error('The working folder is not allocated. Retry setup.')
    const path = await existingWorkingDirectory(metadata.path)
    if (metadata.mode === 'shared') {
      let repositoryRoot = observed?.root
      try { repositoryRoot ??= (await this.git(path, ['rev-parse', '--show-toplevel'])).trim() }
      catch (error) {
        if (error instanceof Error && /not a git repository|Git is unavailable/u.test(error.message)) return { worktree: { ...metadata, branch: undefined, dirty: false, status: 'ready', error: undefined } }
        throw error
      }
      const branch = (await this.git(path, ['branch', '--show-current'])).trim() || undefined
      return { worktree: { ...metadata, repositoryRoot, branch, dirty: (await this.git(path, ['status', '--porcelain', '--untracked-files=normal'])).length > 0, status: 'ready', error: undefined } }
    }
    // Inspection never creates a replacement for a deleted checkout.
    if (!metadata.repositoryRoot) throw new Error('The worktree binding is incomplete.')
    identity ??= await this.registryIdentity(metadata.repositoryRoot)
    // These were already inspection's ownership reads. Run them beside the registry
    // read so moving expected-common discovery earlier adds no subprocess or Git phase.
    const [rootResult, commonResult, listing] = await Promise.allSettled([
      observed ? Promise.resolve(observed.root) : this.git(path, ['rev-parse', '--show-toplevel']),
      observed?.common === undefined ? this.git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']) : Promise.resolve(observed.common),
      observed?.listing === undefined ? this.registry(metadata.repositoryRoot, ['worktree', 'list', '--porcelain', '-z'], identity) : Promise.resolve(observed.listing),
    ])
    if (listing.status === 'rejected') throw listing.reason
    const entries = registeredWorktrees(listing.value)
    const registered = entries.find(entry => pathKey(entry.path) === pathKey(path))
    if (registered?.locked || registered?.prunable) throw new Error('Git has locked this worktree or reports an incomplete checkout. Restore the checkout before continuing.')
    if (pathKey(path) !== pathKey(metadata.path) || !registered) throw new Error('The working folder is no longer this thread’s Git worktree. Restore its checkout before continuing.')
    // The thread follows whatever its worktree has checked out (ADR-0014): Sotto records the branch it
    // sees, none for a detached HEAD, and never switches one itself.
    const branch = registered.branch?.startsWith('refs/heads/') ? registered.branch.slice('refs/heads/'.length) : undefined
    if (rootResult.status === 'rejected') throw rootResult.reason
    if (commonResult.status === 'rejected') throw commonResult.reason
    const root = rootResult.value, common = commonResult.value
    if (pathKey(root.trim()) !== pathKey(path) || pathKey(common.trim()) !== pathKey(identity.common)) throw new Error('The working folder no longer belongs to the original repository.')
    await this.workingDirectory(metadata)
    // A folder that is there was not reclaimed, whatever the record last said.
    return { identity, worktree: { ...withCheckedOutBranch(metadata, branch), status: 'ready', error: undefined, reclaimedAt: undefined, dirty: (await this.git(path, ['status', '--porcelain', '--untracked-files=normal', ...(reclaiming ? ['--ignore-submodules=none'] : [])])).length > 0 } }
  }
}
