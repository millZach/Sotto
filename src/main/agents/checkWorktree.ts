import { createHash } from 'node:crypto'
import { access, constants, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { findCli, withCliPath } from './cliLookup'
import { launchProcess, runToExit } from './gitLauncher'
import { nativeEnvironment } from './subscriptionCodex'

/**
 * A machine's one **check worktree** per project (#1312, third part): a linked worktree under Sotto's own data folder that
 * each check on the machine moves to its own snapshot, keeping the `node_modules` the checks before it installed, so a
 * check does not cost a fresh `npm ci` (about 1.4 GB) or fill the disk (ADR-0041). An Owl feature (`cross-machine-work`,
 * ADR-0072): only a start the machine's check queue marks as a check takes it, and the queue exists only while that is on.
 *
 * This file holds what the check worktree knows of its packages: which `package-lock.json` its `node_modules` was installed
 * from, whether a snapshot needs `npm ci` first, and how that runs. Moving the folder is `ThreadWorktrees.takeCheckWorktree`.
 */

/** The folder under Sotto's data folder where each repository's check worktree lives, named by the repository. */
export const CHECK_WORKTREE_FOLDER = 'check-worktrees'

/**
 * What happens to the thread of the check before when the next check moves the worktree (#1312, not settled; Needs Zach).
 * `follows`: the folder moves only when that cannot lose work, and the thread before follows its checkout, as a
 * worktree-backed thread does (ADR-0014). The folder stays where it is, and the new check gets a new worktree of its own
 * as before this part, when any thread working in it has a turn running, a question open or work queued, when it holds
 * uncommitted changes or untracked files, or when its HEAD has commits of its own that only it holds.
 */
export const CHECK_WORKTREE_PREVIOUS_THREAD = 'follows' as const

/**
 * Whether a check starts when `npm ci` failed before it (#1312, not settled; Needs Zach). The check's thread finds the
 * packages missing when it runs, and its reply says so; nothing is recorded as installed, so the next check installs again.
 */
export const CHECK_STARTS_AFTER_FAILED_INSTALL = true

/** The longest `npm ci` runs in a check worktree before Sotto stops it and counts the install as failed. */
export const CHECK_INSTALL_TIMEOUT_MS = 30 * 60 * 1000

/** The lockfile whose change sends a check through `npm ci` first. A project without one installs nothing. */
export const CHECK_LOCKFILE = 'package-lock.json'

/**
 * Where the check worktree records the lockfile its `node_modules` was installed from: a file inside `node_modules`, so a
 * `node_modules` that is removed, or emptied by an `npm ci` that then failed, takes the record with it.
 */
export const CHECK_INSTALLED_FROM = '.sotto-check-installed-from'

/** Where the check worktree records the commit Sotto last moved it to: a file in that worktree's own Git folder. */
export const CHECK_MOVED_TO = 'sotto-check-moved-to'

/**
 * Zach's words (October 23) for a check that installs packages first, for the model: English, never shown on screen.
 * `machine` is named the way the queue's waiting words name it.
 */
export function checkInstallWords(machine: string): string {
  return `Installing packages first, because package-lock.json changed since the last check on ${machine}. The checks start when that finishes.`
}
/** For the model when `npm ci` failed before a check: what happened and what to expect. English, never shown on screen. */
export function checkInstallFailedWords(machine: string): string {
  return `Installing packages failed on ${machine}, so the check started without them. Its thread finds them missing when it runs, and the next check on ${machine} installs them again.`
}

/** The lockfile's hash in a project folder, or undefined when it has none. */
export async function lockfileHash(projectFolder: string): Promise<string | undefined> {
  let text: Buffer
  try { text = await readFile(join(projectFolder, CHECK_LOCKFILE)) } catch { return undefined }
  return createHash('sha256').update(text).digest('hex')
}

/** The lockfile hash `node_modules` in this project folder was installed from, as the check worktree recorded it. */
export async function installedFrom(projectFolder: string): Promise<string | undefined> {
  try { return (await readFile(join(projectFolder, 'node_modules', CHECK_INSTALLED_FROM), 'utf8')).trim() || undefined } catch { return undefined }
}

/**
 * Records that `node_modules` in this project folder was installed from the lockfile with this hash. A lockfile with no
 * packages installs to no `node_modules` at all, so the folder is made to hold the record.
 */
export async function recordInstalled(projectFolder: string, hash: string): Promise<void> {
  await mkdir(join(projectFolder, 'node_modules'), { recursive: true })
  await writeFile(join(projectFolder, 'node_modules', CHECK_INSTALLED_FROM), `${hash}\n`, 'utf8')
}

/**
 * Whether a check in this project folder installs packages first: its lockfile differs from the one `node_modules` was
 * installed from, or nothing was recorded. Undefined when the project has no lockfile, which installs nothing.
 */
export async function installNeeded(projectFolder: string): Promise<{ readonly hash: string } | undefined> {
  const hash = await lockfileHash(projectFolder)
  if (hash === undefined || await installedFrom(projectFolder) === hash) return undefined
  return { hash }
}

/**
 * Runs `npm ci` in a project folder: `installed`, or `failed` for any reason. Its output is never kept or logged. When
 * `signal` aborts it stops the install's whole process tree and settles once that is gone.
 */
export type PackageInstaller = (projectFolder: string, signal: AbortSignal) => Promise<'installed' | 'failed'>

/** npm's own entry point beside a Node found the way Sotto finds a client (ADR-0036), so npm runs under the user's Node. */
async function npmUnder(node: string): Promise<string | undefined> {
  const folder = dirname(node)
  for (const candidate of [join(folder, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(folder, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    try { await access(candidate, constants.F_OK); return candidate } catch { /* Try the next layout. */ }
  }
  return undefined
}

/** Stops a process tree, and settles only once it is seen gone. */
async function stopTree(pid: number): Promise<void> {
  if (process.platform === 'win32') { await runToExit('taskkill', ['/pid', String(pid), '/T', '/F']); return }
  const gone = (signal: NodeJS.Signals | 0): boolean => {
    try { process.kill(-pid, signal); return false } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error }
  }
  if (gone('SIGKILL')) return
  // kill only sends the signal: wait until the whole group is gone, as Git's own stop does.
  const until = Date.now() + 5_000
  while (!gone(0)) {
    if (Date.now() > until) throw new Error('The install process group outlived its kill.')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * Runs an install to its end: `installed` when it exits with 0, `failed` otherwise. When `signal` aborts, as when Sotto
 * closes, or `timeoutMs` passes, the whole process tree is stopped, and this settles only once the tree is stopped and the
 * process has closed, so nothing of the install is still writing into the folder when a caller goes on. Its output is
 * read and dropped: a full pipe would stall it, and what it prints is the project's, never Sotto's to keep.
 */
export function runInstall(command: string, args: readonly string[], options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly signal: AbortSignal; readonly timeoutMs: number }): Promise<'installed' | 'failed'> {
  if (options.signal.aborted) return Promise.resolve('failed')
  return new Promise(done => {
    const child = launchProcess(command, args, { cwd: options.cwd, env: options.env, detached: process.platform !== 'win32' })
    let stopping: Promise<void> | undefined
    const closed = new Promise<number | null>(resolve => {
      child.on('close', code => resolve(code))
      child.on('error', () => resolve(null))
    })
    const stop = (event: string): void => {
      if (stopping) return
      console.warn(event)
      stopping = (async () => {
        // A launch on the worker has its pid once it has started.
        if (!child.pid) await new Promise<void>(resolve => child.once('spawn', resolve))
        try { await stopTree(child.pid!) } catch { console.warn('check-install-stop-failed'); child.kill('SIGKILL') }
      })()
    }
    const timer = setTimeout(() => stop('check-install-timed-out'), options.timeoutMs)
    timer.unref?.()
    const abort = (): void => stop('check-install-stopped')
    options.signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', () => undefined); child.stderr.on('data', () => undefined)
    void closed.then(async code => {
      clearTimeout(timer)
      options.signal.removeEventListener('abort', abort)
      if (stopping) { await stopping.catch(() => undefined); done('failed'); return }
      done(code === 0 ? 'installed' : 'failed')
    })
  })
}

/**
 * `npm ci` under the user's own Node, not Sotto's: install scripts and native builds see the Node the project's checks run
 * under. No shell, so nothing is quoted. Stopped, with its whole process tree, after CHECK_INSTALL_TIMEOUT_MS or when
 * Sotto closes.
 */
export const npmCi: PackageInstaller = async (projectFolder, signal) => {
  const node = await findCli({ name: 'node' })
  const npm = node ? await npmUnder(node) : undefined
  if (!node || !npm) { console.warn('check-install-no-npm'); return 'failed' }
  return await runInstall(node, [npm, 'ci', '--no-audit', '--no-fund'], { cwd: projectFolder, env: withCliPath(nativeEnvironment(), node), signal, timeoutMs: CHECK_INSTALL_TIMEOUT_MS })
}

/**
 * Prepares a check's packages in its project folder, whichever worktree it got (#1312): nothing when it has no lockfile or
 * `node_modules` was installed from this one. Otherwise the record of what `node_modules` was installed from is removed
 * first, before anything changes it, so an install that stops partway never leaves the old record behind; then the
 * install runs, and the record is written only when it succeeded. A record that cannot be removed is not trusted to be
 * replaced, so nothing is installed and the install counts as failed. `installing` is told just before the install starts.
 */
export async function preparePackages(projectFolder: string, install: PackageInstaller, signal: AbortSignal, installing: () => void): Promise<'none' | 'installed' | 'failed'> {
  const needed = await installNeeded(projectFolder)
  if (!needed) return 'none'
  if (signal.aborted) return 'failed'
  try { await rm(join(projectFolder, 'node_modules', CHECK_INSTALLED_FROM), { force: true }) }
  catch { console.warn('check-install-record-stuck'); return 'failed' }
  installing()
  const outcome = await install(projectFolder, signal).catch(() => 'failed' as const)
  if (outcome !== 'installed') { console.warn('check-install-failed'); return 'failed' }
  try { await recordInstalled(projectFolder, needed.hash) } catch { return 'failed' }
  return 'installed'
}
