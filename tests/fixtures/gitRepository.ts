import { execFileSync } from 'node:child_process'
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
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }
  for (const key of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_PARAMETERS)$/u.test(key)) delete env[key as keyof typeof env]
  }
  return execFileSync('git', args, { cwd, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

async function configure(directory: string, options: GitRepositoryOptions, bare = false): Promise<void> {
  const config = join(directory, bare ? 'config' : '.git/config')
  const identity = options.identity ?? { name: 'Fixture', email: 'fixture@example.invalid' }
  // JSON strings use the same quoting/escaping for these simple Git config values.
  await writeFile(config, await readFile(config, 'utf8') + `\n[user]\n name = ${JSON.stringify(identity.name)}\n email = ${JSON.stringify(identity.email)}\n[commit]\n gpgSign = false\n[tag]\n gpgSign = false\n[core]\n autocrlf = false\n eol = lf\n hooksPath = ${bare ? 'hooks' : '.git/hooks'}\n`)
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
      runFixtureGit(root, 'clone', '--template=', '-q', '-b', options.branch ?? 'main', remote, other)
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
 * Make once in beforeAll, dispose in afterAll. Only copies are exposed: linked worktrees and remotes are refused.
 * Calls never share mutable repository state. Intended only for repeated, identical initial commits.
 */
export async function gitRepositorySeed(options: Omit<GitRepositoryOptions, 'remote' | 'secondClone'> = {}) {
  const seed = await ownedGitRepository(options)
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
      const linked = await addRemote(owner.root, repo, { ...options, ...remotes })
      return { ...owner, repo, ...linked, git: (...args: string[]) => runFixtureGit(repo, ...args) }
    } catch (error) { await owner.dispose(); throw error }
  } }
}
