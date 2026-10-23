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
 * refuses a Git command that changes a repository unless the folder it would change is under the temporary folder,
 * confirming once that the temporary folder is outside every repository. It imports only Node builtins, so the Git
 * launcher's worker thread can carry it too (`gitLauncherWorker.ts`).
 */
import childProcess, { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

/** Variables that point Git at another repository, index or object store, whatever folder it runs in. */
export const REDIRECTING_GIT_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX'] as const

/** Drops what a Git hook or alias that ran the tests would have left, so no child Git inherits another repository. */
export function scrubRedirectingGitVariables(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of REDIRECTING_GIT_VARIABLES) delete env[key]
}

/** The temporary folder as given and as it resolves: Windows runners give an 8.3 TEMP, and Git answers in long names. */
export function temporaryRoots(folder: string = tmpdir()): string[] {
  const roots = [resolve(folder)]
  try { roots.push(realpathSync.native(folder)) } catch { /* A folder that does not exist yet is compared as written. */ }
  return [...new Set(roots)]
}

const comparable = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
function under(path: string, root: string): boolean {
  const between = relative(comparable(root), comparable(path))
  return between === '' || (!between.startsWith('..') && !isAbsolute(between))
}
/** Whether `path`, as written or as it resolves, is `roots`' folder or inside it. */
export function insideTemporaryFolder(path: string, roots: readonly string[]): boolean {
  const forms = [resolve(path)]
  try { forms.push(realpathSync.native(path)) } catch { /* Not made yet: an init or clone target. */ }
  return forms.some(form => roots.some(root => under(form, root)))
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
/** Commands that change a repository's files, index, HEAD, refs or remotes, whatever their arguments. */
const CHANGES = new Set(['add', 'am', 'apply', 'bisect', 'checkout', 'checkout-index', 'cherry-pick', 'clean', 'clone', 'commit', 'fetch', 'filter-branch', 'init', 'merge', 'mv', 'pull', 'push', 'read-tree', 'rebase', 'replace', 'reset', 'restore', 'revert', 'rm', 'switch', 'update-index', 'update-ref'])
const positionals = (args: readonly string[], withValue: ReadonlySet<string> = new Set()): string[] => {
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

/** Whether `git <command> <args>` would change the repository it runs in. Read forms of mixed commands do not. */
export function gitCommandChanges(command: string, args: readonly string[]): boolean {
  if (CHANGES.has(command)) return !(command === 'apply' && has(args, '--check', '--stat', '--numstat', '--summary') && !has(args, '--apply', '--index', '--cached'))
  const first = positionals(args)[0]
  switch (command) {
    case 'branch': return has(args, '-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description')
      || (!has(args, '-l', '--list', '--show-current', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at') && positionals(args, new Set(['--sort', '--format', '--column'])).length > 0)
    case 'tag': return has(args, '-d', '--delete', '-a', '--annotate', '-s', '--sign', '-u', '-f', '--force', '-m', '--message', '-F', '--file')
      || (!has(args, '-l', '--list', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '-n') && positionals(args, new Set(['--sort', '--format', '--column'])).length > 0)
    case 'config': {
      if (has(args, '--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '-l', '--list')) return false
      const named = positionals(args, new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value']))
      if (named[0] === 'get' || named[0] === 'list') return false
      return has(args, '--unset', '--unset-all', '--add', '--replace-all', '--remove-section', '--rename-section', '-e', '--edit')
        || ['set', 'unset', 'rename-section', 'remove-section', 'edit'].includes(named[0] ?? '') || named.length >= 2
    }
    case 'remote': return first !== undefined && !['show', 'get-url'].includes(first)
    case 'stash': return first === undefined || !['list', 'show'].includes(first)
    case 'worktree': return first !== 'list'
    case 'symbolic-ref': return has(args, '-d', '--delete') || positionals(args, new Set(['-m'])).length >= 2
    case 'notes': return first !== undefined && !['list', 'show', 'get-ref'].includes(first)
    case 'submodule': return first !== undefined && !['status', 'summary', 'foreach'].includes(first)
    case 'sparse-checkout': return first !== 'list'
    default: return false
  }
}

export interface GitCall {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd?: string | URL | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
}
const isGit = (file: string): boolean => /(^|[\\/])git(\.exe|\.cmd)?$/iu.test(file.replace(/^["']|["']$/gu, ''))

/**
 * The Git command `call` would change a repository with, and the folders it would change: its working folder after any
 * `-C`, any `--git-dir`, `--work-tree` or variable that redirects it, and an init or clone target. Null for anything
 * that is not Git or changes nothing.
 */
export function gitChange(call: GitCall): { readonly command: string; readonly targets: readonly string[] } | null {
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
  const targets = redirected.map(path => resolve(folder, path))
  if (command === 'init') targets.push(resolve(folder, positionals(args, new Set(['-b', '--initial-branch', '--separate-git-dir', '--object-format', '--ref-format', '--template']))[0] ?? '.'))
  else if (command === 'clone') targets.push(resolve(folder, positionals(args, new Set(['-b', '--branch', '-o', '--origin', '-c', '--config', '--depth', '--reference', '--reference-if-able', '-u', '--upload-pack', '--separate-git-dir', '--filter', '-j', '--jobs', '--server-option', '--template', '--shallow-since', '--shallow-exclude', '--bundle-uri', '--ref-format']))[1] ?? '.'))
  else targets.push(folder)
  return { command, targets }
}

/** Why the guard refuses `call`, or null when it may run: a change may reach only folders under `roots`. */
export function gitGuardRefusal(call: GitCall, roots: readonly string[]): string | null {
  const change = gitChange(call)
  const outside = change?.targets.find(target => !insideTemporaryFolder(target, roots))
  if (!change || outside === undefined) return null
  return `The test harness refused \`git ${change.command}\` in ${outside}: a test may change only repositories under the temporary folder ${roots[0]}. Nothing was run.`
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
    if (confirmed || !gitChange(call)) return
    assertTemporaryFolderOutsideRepositories(roots[0])
    confirmed = true
  }
}

type Options = { cwd?: string | URL; env?: NodeJS.ProcessEnv } | undefined
const optionsOf = (value: unknown): Options => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Options : undefined
/** `exec`'s command line split into words, honouring quotes; enough to find a Git command and its arguments. */
function words(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)].map(match => match[1] ?? match[2] ?? match[3]!)
}

let installed = false
/** Wraps `node:child_process` so a refused Git command throws before it starts. Once per module instance. */
export function installGitGuard(roots: readonly string[] = temporaryRoots()): void {
  if (installed) return
  installed = true
  const module = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>
  const guard = gitGuard(roots)
  const check = (file: unknown, args: unknown, options: Options): void => {
    if (typeof file === 'string') guard({ file, args: Array.isArray(args) ? args.map(String) : [], cwd: options?.cwd, env: options?.env })
  }
  const wrap = (name: string, inspect: (args: unknown[]) => void): void => {
    const original = module[name]!
    const guarded = function (this: unknown, ...args: unknown[]) { inspect(args); return original.apply(this, args) }
    const custom = (original as unknown as Record<symbol, ((...args: unknown[]) => unknown) | undefined>)[promisify.custom]
    // `promisify(execFile)` resolves with { stdout, stderr } only through the original's own promisified form.
    if (custom) Object.defineProperty(guarded, promisify.custom, { value: function (this: unknown, ...args: unknown[]) { inspect(args); return custom.apply(this, args) } })
    module[name] = guarded
  }
  const byFile = (args: unknown[]): void => check(args[0], Array.isArray(args[1]) ? args[1] : [], optionsOf(Array.isArray(args[1]) ? args[2] : args[1]))
  const byLine = (args: unknown[]): void => { if (typeof args[0] === 'string') { const [file, ...rest] = words(args[0]); check(file, rest, optionsOf(args[1])) } }
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) wrap(name, byFile)
  for (const name of ['exec', 'execSync']) wrap(name, byLine)
  // `import { spawn } from 'node:child_process'` binds the builtin's exports as they were; this republishes them.
  syncBuiltinESMExports()
}
