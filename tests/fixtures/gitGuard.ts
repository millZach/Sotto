/**
 * Keeps every Git command a test starts away from the developer's own repositories.
 *
 * Tests make plain folders under the OS temporary folder and expect Git to find no repository there, and they run real
 * commits, resets and checkouts in repositories they made there. Both rely on the temporary folder sitting outside
 * every repository. On October 23, 2026 a thread pointed TEMP at a folder inside the main checkout to get off a full C:
 * drive; Git's discovery walked up from a test's plain folder into that checkout, and the Git actions test committed
 * the user's untracked files there under the user's own name.
 *
 * Two checks stop that. `assertTemporaryFolderOutsideRepositories` runs once before any test (`tests/globalSetup.ts`)
 * and refuses a temporary folder inside a repository. `installGitGuard` runs in every test file (`tests/setup.ts`) and
 * refuses a Git command that could change a repository unless everything it would change is under the temporary
 * folder, confirming once that the temporary folder is outside every repository. A command it does not know as a read
 * counts as a change. It imports only Node builtins, so the Git launcher's worker thread can carry it too
 * (`gitLauncherWorker.ts`).
 */
import childProcess, { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

/** Variables that point Git at another repository, index or object store, whatever folder it runs in. */
export const REDIRECTING_GIT_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX'] as const

/** Drops what a Git hook or alias that ran the tests would have left, so no child Git inherits another repository. */
export function scrubRedirectingGitVariables(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of REDIRECTING_GIT_VARIABLES) delete env[key]
}

/**
 * Where `path` really is: links and junctions followed, and Windows 8.3 names written out long, through its nearest
 * folder that exists, so a target Git has yet to make (an init or clone) is placed by the folder it would be made in.
 */
function physical(path: string): string {
  const below: string[] = []
  for (let current = resolve(path); ; current = dirname(current)) {
    try { return join(realpathSync.native(current), ...below.reverse()) } catch { /* Not there yet: try its folder. */ }
    if (dirname(current) === current) return resolve(path)
    below.push(basename(current))
  }
}

/** The temporary folder as given and where it really is: Windows runners give an 8.3 TEMP, macOS a linked /var. */
export function temporaryRoots(folder: string = tmpdir()): string[] {
  return [...new Set([resolve(folder), physical(folder)])]
}

const comparable = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
function under(path: string, root: string): boolean {
  const between = relative(comparable(root), comparable(path))
  return between === '' || (!between.startsWith('..') && !isAbsolute(between))
}
/** Whether `path` really is `roots`' folder or inside it: a link under the folder to anywhere else is outside. */
export function insideTemporaryFolder(path: string, roots: readonly string[]): boolean {
  const real = physical(path)
  return roots.some(root => under(real, root))
}

/**
 * The Git directory of the repository that holds `folder`, or null when Git finds none. Asked without the redirecting
 * variables and without GIT_CEILING_DIRECTORIES, the way Sotto's own Git runs (`gitStatus.ts`).
 */
export function repositoryHoldingFolder(folder: string): string | null {
  const env = { ...process.env }
  scrubRedirectingGitVariables(env)
  delete env.GIT_CEILING_DIRECTORIES
  try {
    return execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: folder, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch { return null }
}

/** Refuses a temporary folder inside a repository, before any test makes a folder there. */
export function assertTemporaryFolderOutsideRepositories(folder: string = tmpdir()): void {
  const repository = repositoryHoldingFolder(folder)
  if (repository === null) return
  throw new Error(`The temporary folder ${folder} is inside the Git repository at ${repository}. Tests make folders there and expect Git to find no repository, so a test could commit in that repository. No test ran. Point TEMP and TMP (TMPDIR on macOS and Linux) at a folder outside every repository, then run the tests again.`)
}

/** Git's own options that come before the command, with the ones that take the next argument as their value. */
const GLOBAL_WITH_VALUE = new Set(['-c', '--config-env', '--namespace', '--super-prefix', '--list-cmds'])
/** Commands that never change a repository. Anything else counts as a change unless a read form below says not. */
const READS = new Set(['annotate', 'archive', 'blame', 'cat-file', 'check-attr', 'check-ignore', 'check-mailmap', 'check-ref-format', 'cherry', 'commit-tree', 'count-objects', 'describe', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'for-each-ref', 'fsck', 'get-tar-commit-id', 'grep', 'help', 'interpret-trailers', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge-base', 'merge-tree', 'mktree', 'name-rev', 'patch-id', 'range-diff', 'rev-list', 'rev-parse', 'shortlog', 'show', 'show-branch', 'show-ref', 'status', 'stripspace', 'var', 'verify-commit', 'verify-pack', 'verify-tag', 'version', 'whatchanged', 'write-tree'])
/** The subcommands of a mixed command that only read; none at all is listed as '' where it reads. */
const READ_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  bundle: ['verify', 'list-heads'], lfs: ['ls-files', 'env', 'version', 'status', 'logs'], notes: ['', 'list', 'show', 'get-ref'],
  reflog: ['', 'show', 'exists', 'list'], remote: ['', 'show', 'get-url'], 'sparse-checkout': ['list'], stash: ['list', 'show'],
  submodule: ['', 'status', 'summary'], worktree: ['list'],
}
function positionals(args: readonly string[], withValue: ReadonlySet<string> = new Set()): string[] {
  const found: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') { found.push(...args.slice(i + 1)); break }
    if (withValue.has(arg)) i++
    else if (!arg.startsWith('-')) found.push(arg)
  }
  return found
}
const has = (args: readonly string[], ...flags: string[]): boolean => args.some(arg => flags.some(flag => arg === flag || arg.startsWith(`${flag}=`)))
/** `git branch` and `git tag`: a change when a changing flag is given, or a name with no listing flag beside it. */
const namesOrLists = (args: readonly string[], changing: readonly string[], listing: readonly string[]): boolean =>
  has(args, ...changing) || (!has(args, ...listing) && positionals(args, new Set(['--sort', '--format', '--column'])).length > 0)
const CONFIG_WITH_VALUE = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value'])

/** Whether `git <command> <args>` could change a repository or Git's configuration. Only known reads do not. */
export function gitCommandChanges(command: string, args: readonly string[]): boolean {
  if (READS.has(command)) return false
  const reads = READ_SUBCOMMANDS[command]
  if (reads) return !reads.includes(positionals(args)[0] ?? '')
  switch (command) {
    case 'hash-object': return has(args, '-w')
    case 'apply': return !has(args, '--check', '--stat', '--numstat', '--summary') || has(args, '--apply', '--index', '--cached')
    case 'branch': return namesOrLists(args, ['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description'],
      ['-l', '--list', '--show-current', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at'])
    case 'tag': return namesOrLists(args, ['-d', '--delete', '-a', '--annotate', '-s', '--sign', '-u', '-f', '--force', '-m', '--message', '-F', '--file'],
      ['-l', '--list', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '-n'])
    case 'config': {
      if (has(args, '--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '-l', '--list')) return false
      const named = positionals(args, CONFIG_WITH_VALUE)
      if (named[0] === 'get' || named[0] === 'list') return false
      return has(args, '--unset', '--unset-all', '--add', '--replace-all', '--remove-section', '--rename-section', '-e', '--edit')
        || ['set', 'unset', 'rename-section', 'remove-section', 'edit'].includes(named[0] ?? '') || named.length >= 2
    }
    case 'symbolic-ref': return has(args, '-d', '--delete') || positionals(args, new Set(['-m'])).length >= 2
    default: return true
  }
}

export interface GitCall {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd?: string | URL | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
}
const unquoted = (word: string): string => word.replace(/^["']|["']$/gu, '')
const isGit = (file: string): boolean => /(^|[\\/])git(\.exe|\.cmd)?$/iu.test(unquoted(file))
/** Where the value of `flag` (`--flag value` or `--flag=value`) points, for each time it is given. */
function valuesOf(args: readonly string[], ...flags: string[]): string[] {
  const values: string[] = []
  args.forEach((arg, i) => {
    for (const flag of flags) {
      if (arg === flag && args[i + 1] !== undefined) values.push(args[i + 1]!)
      else if (arg.startsWith(`${flag}=`)) values.push(arg.slice(flag.length + 1))
    }
  })
  return values
}
/**
 * The Git folders a working folder under the temporary folder leads to: a linked worktree's or submodule's `.git` file
 * names its Git folder, and that folder's `commondir` the repository's own. Looked for only as far up as `roots`.
 */
function linkedGitFolders(folder: string, roots: readonly string[]): string[] {
  for (let current = folder; insideTemporaryFolder(current, roots); current = dirname(current)) {
    const dotGit = join(current, '.git')
    try {
      if (statSync(dotGit).isDirectory()) return []
      const gitFolder = resolve(current, readFileSync(dotGit, 'utf8').replace(/^gitdir:\s*/u, '').trim())
      let common: string | undefined
      try { common = resolve(gitFolder, readFileSync(join(gitFolder, 'commondir'), 'utf8').trim()) } catch { /* A submodule's Git folder has none. */ }
      return common === undefined ? [gitFolder] : [gitFolder, common]
    } catch { /* No .git here: Git looks in the folder above. */ }
    if (dirname(current) === current) break
  }
  return []
}

/**
 * The Git command `call` would change a repository with, and everything it would change: its working folder after any
 * `-C` and the Git folder a linked worktree there leads to, any `--git-dir`, `--work-tree` or variable that redirects
 * it, an init, clone or new worktree's folder, a `--separate-git-dir`, and a configuration file it writes. Null for
 * anything that is not Git or changes nothing.
 */
export function gitChange(call: GitCall, roots: readonly string[]): { readonly command: string; readonly targets: readonly string[] } | null {
  if (!isGit(call.file)) return null
  const cwd = call.cwd instanceof URL ? fileURLToPath(call.cwd) : call.cwd
  // An empty folder is no folder: spawn runs the command in the test process's own folder then.
  let folder = cwd ? resolve(cwd) : process.cwd()
  const redirected: string[] = []
  let at = 0
  for (; at < call.args.length; at++) {
    const arg = call.args[at]!
    if (arg === '-C') folder = resolve(folder, call.args[++at] ?? '.')
    else if (arg === '--git-dir' || arg === '--work-tree') redirected.push(call.args[++at] ?? '.')
    else if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')) redirected.push(arg.slice(arg.indexOf('=') + 1))
    else if (GLOBAL_WITH_VALUE.has(arg)) at++
    else if (!arg.startsWith('-')) break
  }
  const command = call.args[at]
  if (command === undefined) return null
  const args = call.args.slice(at + 1)
  if (!gitCommandChanges(command, args)) return null
  const env = call.env ?? process.env
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'] as const) if (env[key]) redirected.push(env[key])
  redirected.push(...valuesOf(args, '--separate-git-dir'))
  const targets = redirected.map(path => resolve(folder, path))
  if (command === 'init') targets.push(resolve(folder, positionals(args, new Set(['-b', '--initial-branch', '--separate-git-dir', '--object-format', '--ref-format', '--template']))[0] ?? '.'))
  else if (command === 'clone') targets.push(resolve(folder, positionals(args, new Set(['-b', '--branch', '-o', '--origin', '-c', '--config', '--depth', '--reference', '--reference-if-able', '-u', '--upload-pack', '--separate-git-dir', '--filter', '-j', '--jobs', '--server-option', '--template', '--shallow-since', '--shallow-exclude', '--bundle-uri', '--ref-format']))[1] ?? '.'))
  else {
    targets.push(folder, ...linkedGitFolders(folder, roots))
    if (command === 'worktree' && positionals(args)[0] === 'add') {
      const path = positionals(args.slice(args.indexOf('add') + 1), new Set(['-b', '-B', '--reason']))[0]
      if (path !== undefined) targets.push(resolve(folder, path))
    }
    if (command === 'config') {
      targets.push(...valuesOf(args, '-f', '--file').map(path => resolve(folder, path)))
      const global = env.GIT_CONFIG_GLOBAL
      if (has(args, '--global') && global !== 'NUL' && global !== '/dev/null') targets.push(resolve(folder, global ?? join(homedir(), '.gitconfig')))
      if (has(args, '--system') && env.GIT_CONFIG_SYSTEM !== 'NUL' && env.GIT_CONFIG_SYSTEM !== '/dev/null') targets.push(resolve(folder, env.GIT_CONFIG_SYSTEM ?? '/etc/gitconfig'))
    }
  }
  return { command, targets }
}

/** Why the guard refuses `call`, or null when it may run: a change may reach only folders under `roots`. */
export function gitGuardRefusal(call: GitCall, roots: readonly string[]): string | null {
  const change = gitChange(call, roots)
  const outside = change?.targets.find(target => !insideTemporaryFolder(target, roots))
  if (!change || outside === undefined) return null
  return `The test harness refused \`git ${change.command}\` on ${outside}: a test may change only repositories under the temporary folder ${roots[0]}. Nothing was run. Make the repository under the temporary folder (tests/fixtures/gitRepository.ts) instead.`
}

/** A shell running a command line: its own name, and the flag that comes before the line. */
const SHELL = /(^|[\\/])(cmd|sh|bash|zsh|dash|powershell|pwsh)(\.exe)?$/iu
const SHELL_LINE_FLAGS = new Set(['/c', '/C', '/k', '/K', '-c', '-Command', '-command'])
/**
 * Every Git command a command line runs, each in the folder the line has moved to by then with `cd`. Separators
 * (`&&`, `||`, `;`, `|`, `&`, line breaks) start a new command; quotes keep their contents one word.
 */
export function gitCallsInLine(line: string, cwd: string | URL | undefined, env: NodeJS.ProcessEnv | undefined): GitCall[] {
  const calls: GitCall[] = []
  let folder = (cwd instanceof URL ? fileURLToPath(cwd) : cwd) || process.cwd()
  let words: string[] = []
  const finish = (): void => {
    // Leading `NAME=value` words set the command's environment; the first other word is what runs.
    const start = words.findIndex(word => !/^[A-Za-z_]\w*=/u.test(word))
    const [file, ...args] = start < 0 ? [] : words.slice(start)
    words = []
    if (file === undefined) return
    if (/^(cd|pushd|chdir|set-location)$/iu.test(file)) folder = resolve(folder, args.find(arg => !/^\/[a-z]$/iu.test(arg)) ?? homedir())
    else if (isGit(file)) calls.push({ file, args, cwd: folder, env })
    else if (SHELL.test(file)) calls.push(...gitCallsOf(file, args, { cwd: folder, env }))
  }
  for (const match of line.matchAll(/"([^"]*)"|'([^']*)'|(&&|\|\||[;&|\r\n])|([^\s"';&|]+)/gu)) {
    if (match[3] !== undefined) finish()
    else words.push(match[1] ?? match[2] ?? match[4]!)
  }
  finish()
  return calls
}

type Options = { cwd?: string | URL | undefined; env?: NodeJS.ProcessEnv | undefined; shell?: boolean | string | undefined } | undefined
/** The Git commands one launch would run: Git itself, or Git inside a shell's command line. */
export function gitCallsOf(file: string, args: readonly string[], options: Options): GitCall[] {
  if (options?.shell) return gitCallsInLine([file, ...args].join(' '), options.cwd, options.env)
  if (SHELL.test(unquoted(file))) {
    const at = args.findIndex(arg => SHELL_LINE_FLAGS.has(arg))
    return at < 0 ? [] : gitCallsInLine(args.slice(at + 1).join(' '), options?.cwd, options?.env)
  }
  return isGit(file) ? [{ file, args, cwd: options?.cwd, env: options?.env }] : []
}

/**
 * The check every Git launch passes: throws for a refused call. A folder under `roots` is safe only while `roots` is
 * outside every repository, since Git looks above a folder that is not one, so the first change it lets through
 * confirms that once (`assertTemporaryFolderOutsideRepositories`). The global setup confirmed it for the run already;
 * this covers a run without it, or a test that moved the temporary folder.
 */
export function gitGuard(roots: readonly string[]): (call: GitCall) => void {
  let confirmed = false
  return call => {
    const refusal = gitGuardRefusal(call, roots)
    if (refusal) throw new Error(refusal)
    if (confirmed || !gitChange(call, roots)) return
    assertTemporaryFolderOutsideRepositories(roots[0])
    confirmed = true
  }
}

const optionsOf = (value: unknown): Options => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Options : undefined

let installed = false
/** Wraps `node:child_process` so a refused Git command throws before it starts. Once per module instance. */
export function installGitGuard(roots: readonly string[] = temporaryRoots()): void {
  if (installed) return
  installed = true
  const module = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>
  const guard = gitGuard(roots)
  const wrap = (name: string, inspect: (args: unknown[]) => void): void => {
    const original = module[name]!
    const guarded = function (this: unknown, ...args: unknown[]) { inspect(args); return original.apply(this, args) }
    const custom = (original as unknown as Record<symbol, ((...args: unknown[]) => unknown) | undefined>)[promisify.custom]
    // `promisify(execFile)` resolves with { stdout, stderr } only through the original's own promisified form.
    if (custom) Object.defineProperty(guarded, promisify.custom, { value: function (this: unknown, ...args: unknown[]) { inspect(args); return custom.apply(this, args) } })
    module[name] = guarded
  }
  const byFile = (args: unknown[]): void => {
    if (typeof args[0] !== 'string') return
    const list = Array.isArray(args[1]) ? args[1].map(String) : []
    for (const call of gitCallsOf(args[0], list, optionsOf(Array.isArray(args[1]) ? args[2] : args[1]))) guard(call)
  }
  const byLine = (args: unknown[]): void => {
    if (typeof args[0] !== 'string') return
    const options = optionsOf(args[1])
    for (const call of gitCallsInLine(args[0], options?.cwd, options?.env)) guard(call)
  }
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) wrap(name, byFile)
  for (const name of ['exec', 'execSync']) wrap(name, byLine)
  // `import { spawn } from 'node:child_process'` binds the builtin's exports as they were; this republishes them.
  syncBuiltinESMExports()
}
