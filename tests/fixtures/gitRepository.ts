import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, type Dirent } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export interface GitRepositoryOptions {
  files?: Readonly<Record<string, string | Uint8Array>>
  branch?: string
  message?: string
  identity?: { name: string; email: string }
  remote?: boolean
  secondClone?: boolean
}

/** Fixture commands ignore machine config; local config also protects Git run by the service under test. */
export function runFixtureGit(cwd: string, ...args: string[]): string {
  const env = fixtureGitEnvironment()
  // Git's own trace goes to its stderr, which is read only when the command fails: it says whether Git started, how
  // far it got and whether it ended itself. On the Windows runner fixture commands have exited 1 with nothing on
  // stderr (#1002), which the trace tells apart from Git refusing on its own.
  try { return execFileSync('git', args, { cwd, env: { GIT_TRACE2: '2', ...env }, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (error) { throw describeFixtureGitFailure(error, cwd, args, env) }
}

function fixtureGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }
  for (const key of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_PARAMETERS)$/u.test(key)) delete env[key]
  }
  return env
}

/**
 * Rewrites a failed fixture command's message so the failure names its cause: how it ended, Git's trace and stderr,
 * which GIT_* variables it saw, any lock files in the repository and what `git status` says there now. The error keeps
 * its own status, signal and output for callers that read them.
 */
function describeFixtureGitFailure(error: unknown, cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): unknown {
  if (!(error instanceof Error)) return error
  const failed = error as Error & { status?: number | null; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string; code?: string }
  const stderr = (failed.stderr ?? '').trim()
  const ended = failed.code && failed.status === undefined ? `could not start (${failed.code})`
    : failed.signal ? `was ended by ${failed.signal}` : `exited ${failed.status ?? 'without a status'}`
  // The trace's exit line is written by Git as it ends itself; a trace without one was cut off from outside.
  const trace = !stderr ? 'Git wrote nothing, not even its trace, so it ended before it started or was ended from outside.'
    : /\bexit elapsed:/u.test(stderr) ? 'Git reported its own exit.' : 'Git never reported its own exit, so something outside it ended it.'
  const lines = [
    `Fixture command \`git ${args.join(' ')}\` in ${cwd} ${ended}. ${trace}`,
    `stdout: ${(failed.stdout ?? '').trim() || '(empty)'}`,
    `stderr and trace:\n${stderr || '(empty)'}`,
    `GIT_* variables: ${Object.keys(env).filter(key => key.startsWith('GIT_')).sort().join(', ')}`,
    `lock files: ${lockFiles(cwd).join(', ') || 'none'}`,
    `git status: ${fixtureGitStatus(cwd, env)}`,
  ]
  failed.message = lines.join('\n')
  return failed
}

function lockFiles(cwd: string): string[] {
  const found: string[] = []
  const visit = (folder: string, depth: number): void => {
    let entries: Dirent[]
    try { entries = readdirSync(folder, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(folder, entry.name)
      if (entry.isDirectory() && depth < 3 && entry.name !== 'objects') visit(path, depth + 1)
      else if (entry.name.endsWith('.lock')) found.push(relative(cwd, path))
    }
  }
  for (const git of [join(cwd, '.git'), cwd]) if (existsSync(join(git, 'HEAD'))) { visit(git, 0); break }
  return found
}

function fixtureGitStatus(cwd: string, env: NodeJS.ProcessEnv): string {
  try {
    const status = execFileSync('git', ['status', '--porcelain=v2', '--branch', '--untracked-files=all'], { cwd, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    return status ? `\n${status}` : '(clean)'
  } catch (statusError) {
    const failed = statusError as { status?: number | null; signal?: string | null; stderr?: string; message?: string }
    return `could not read it (${failed.signal ?? `exit ${failed.status ?? '?'}`}): ${(failed.stderr ?? failed.message ?? '').trim()}`
  }
}

async function configure(directory: string, options: GitRepositoryOptions, bare = false): Promise<void> {
  const config = join(directory, bare ? 'config' : '.git/config')
  const identity = options.identity ?? { name: 'Fixture', email: 'fixture@example.invalid' }
  // A finished fixture command must not leave maintenance changing metadata while a seed is copied.
  // Keep this local so Git invoked by the service under test has the same rule as fixture commands.
  // JSON strings use the same quoting/escaping for these simple Git config values.
  await writeFile(config, await readFile(config, 'utf8') + `\n[user]\n name = ${JSON.stringify(identity.name)}\n email = ${JSON.stringify(identity.email)}\n[commit]\n gpgSign = false\n[tag]\n gpgSign = false\n[core]\n autocrlf = false\n eol = lf\n hooksPath = ${bare ? 'hooks' : '.git/hooks'}\n[maintenance]\n auto = false\n[gc]\n auto = 0\n`)
}

/** Borrowed directory: used by workspaceFixture/sendGit, whose owner already removes the enclosing root. */
export async function initializeGitRepository(directory: string, options: GitRepositoryOptions = {}): Promise<void> {
  await mkdir(directory, { recursive: true })
  runFixtureGit(directory, 'init', '--template=', '-q', '-b', options.branch ?? 'main')
  await configure(directory, options)
  for (const [path, contents] of Object.entries(options.files ?? { 'tracked.txt': 'baseline' })) {
    const target = resolve(directory, path)
    if (isAbsolute(path) || relative(directory, target).startsWith('..') || path.split(/[\\/]/u).includes('.git')) throw new Error('Unexpected fixture file path')
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, contents)
  }
  runFixtureGit(directory, 'add', '-A')
  runFixtureGit(directory, 'commit', '--allow-empty', '-qm', options.message ?? 'Baseline')
}

async function addRemote(root: string, repo: string, options: GitRepositoryOptions) {
  const remote = join(root, 'remote.git'), other = join(root, 'other')
  if (options.remote || options.secondClone) {
    await initializeBareGitRepository(remote, options)
    runFixtureGit(repo, 'remote', 'add', 'origin', remote)
    runFixtureGit(repo, 'push', '-q', '-u', 'origin', options.branch ?? 'main')
    runFixtureGit(repo, 'remote', 'set-head', 'origin', options.branch ?? 'main')
    if (options.secondClone) {
      // Apply the rule during clone's initial fetch, before configure() can see its metadata.
      runFixtureGit(root, 'clone', '--template=', '--config', 'maintenance.auto=false', '--config', 'gc.auto=0', '-q', '-b', options.branch ?? 'main', remote, other)
      await configure(other, options)
    }
  }
  return { remote, other }
}

export async function initializeBareGitRepository(directory: string, options: GitRepositoryOptions = {}): Promise<void> {
  await mkdir(directory, { recursive: true })
  runFixtureGit(directory, 'init', '--template=', '--bare', '-q', '-b', options.branch ?? 'main')
  await configure(directory, options, true)
}

async function ownedRoot() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-git-fixture-'))
  return { root, dispose: async () => {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-git-fixture-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } }
}

/** Every call owns a separate repository, remote and optional clone. */
export async function ownedGitRepository(options: GitRepositoryOptions = {}) {
  const owner = await ownedRoot()
  const repo = join(owner.root, 'repo')
  try {
    await initializeGitRepository(repo, options)
    const remotes = await addRemote(owner.root, repo, options)
    return { ...owner, repo, ...remotes, git: (...args: string[]) => runFixtureGit(repo, ...args) }
  } catch (error) { await owner.dispose(); throw error }
}

/**
 * Refuses a repository copy Git would not see as the seed: a copy cut short (a full disk) without an error can leave a
 * folder whose Git looks above it for a repository, or one whose HEAD or objects are gone. Git must find the copy's
 * own `.git`, read the seed's tree at HEAD there, and have an index to stage against.
 */
export async function assertWholeRepositoryCopy(repo: string, tree: string): Promise<void> {
  const refuse = (what: string): never => { throw new Error(`The repository copy at ${repo} is incomplete: ${what}. Nothing ran in it; free some disk space, then run the test again.`) }
  if (!(await lstat(join(repo, '.git', 'index')).then(() => true, () => false))) refuse('.git/index is missing')
  let found: string[]
  try { found = runFixtureGit(repo, 'rev-parse', '--absolute-git-dir', 'HEAD^{tree}').trim().split(/\r?\n/u) } catch { return refuse('Git cannot read its HEAD') }
  if (comparablePath(found[0] ?? '') !== comparablePath(join(repo, '.git'))) refuse(`Git found the repository at ${found[0]} instead of its own`)
  if (found[1] !== tree) refuse('its HEAD is not the seed\'s')
}
const comparablePath = (path: string): string => {
  let real = path
  try { real = realpathSync.native(path) } catch { /* Compared as written. */ }
  return process.platform === 'win32' ? resolve(real).toLowerCase() : resolve(real)
}

/**
 * Make once in beforeAll, dispose in afterAll. Only copies are exposed: linked worktrees and remotes are refused.
 * Calls never share mutable repository state. Intended only for repeated, identical initial commits.
 */
export async function gitRepositorySeed(options: Omit<GitRepositoryOptions, 'remote' | 'secondClone'> = {}) {
  const seed = await ownedGitRepository(options)
  const tree = seed.git('rev-parse', 'HEAD^{tree}').trim()
  return { dispose: seed.dispose, copy: async (remotes: Pick<GitRepositoryOptions, 'remote' | 'secondClone'> = {}) => {
    const owner = await ownedRoot()
    const repo = join(owner.root, 'repo')
    try {
      if (!(await lstat(join(seed.repo, '.git'))).isDirectory()) throw new Error('Cannot copy linked-worktree metadata')
      // Refuse seed metadata that would link mutable state outside the copied directory.
      for (const path of ['worktrees', 'commondir', 'objects/info/alternates']) {
        if (await lstat(join(seed.repo, '.git', path)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) throw new Error('Cannot copy linked repository metadata')
      }
      await cp(seed.repo, repo, { recursive: true, dereference: false })
      await assertWholeRepositoryCopy(repo, tree)
      const linked = await addRemote(owner.root, repo, { ...options, ...remotes })
      return { ...owner, repo, ...linked, git: (...args: string[]) => runFixtureGit(repo, ...args) }
    } catch (error) { await owner.dispose(); throw error }
  } }
}
