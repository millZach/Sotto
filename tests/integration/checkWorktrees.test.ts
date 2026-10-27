// @vitest-environment node
// #1312, third part: a machine keeps one check worktree per repository. Each check moves it to that check's snapshot and
// keeps the packages it installed, and `npm ci` runs first, before the check's brief, only when package-lock.json changed.
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { PackageInstaller } from '../../src/main/agents/checkWorktree'
import type { RunGit } from '../../src/main/agents/threadWorktrees'
import { commitFile, git } from '../fixtures/branchRepositories'
import { delegationFixture, type DelegationResult } from '../fixtures/delegationFixture'

type CheckResult = DelegationResult & { delegation: { check?: { ahead: number; note: string } } }
const lf = (text: string): string => text.replace(/\r\n/gu, '\n')
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)
const sameFolder = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()
// Three checks over real Git and fake providers each: generous deadlines, which cost nothing when met (AGENTS.md).
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** An installer that writes a `node_modules` as `npm ci` would, each install waiting for the test to let it finish when `held`. */
function installer(held: boolean) {
  const installs: string[] = []
  let finish: (() => void) | undefined
  const install: PackageInstaller = async folder => {
    installs.push(folder)
    if (held) await new Promise<void>(resolve => { finish = resolve })
    await mkdir(join(folder, 'node_modules'), { recursive: true })
    await writeFile(join(folder, 'node_modules', 'installed.txt'), `install ${installs.length}\n`)
    return 'installed'
  }
  return { install, installs, finish: () => finish!() }
}

/** A delegating thread on `feat/p` in a repository that ignores `node_modules`, with or without a package-lock.json. */
async function fixture(install: PackageInstaller | undefined, lockfile = true) {
  const f = await delegationFixture(cleanups, { branchStarts: true, checks: true, ...install ? { checkWorktrees: install } : {} })
  const parent = await f.userThread('claude')
  const folder = f.control.shell().host.threads.find(thread => thread.id === parent)!.workingDirectory!
  git(folder, 'init', '-q'); await commitFile(folder, '.gitignore', 'node_modules/\n', 'Start the project')
  if (lockfile) await commitFile(folder, 'package-lock.json', '{ "lockfileVersion": 3 }\n')
  git(folder, 'switch', '-q', '-c', 'feat/p')
  await commitFile(folder, 'p.txt', 'first\n')
  const check = async (input: Record<string, unknown> = {}) =>
    f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0, test_run: true, from_my_branch: true, ...input })) as CheckResult
  const worktree = (threadId: string) => f.control.shell().host.threads.find(thread => thread.id === threadId)?.worktree
  const running = (threadId: string) => vi.waitFor(() => expect(JSON.stringify({ status: f.workspace.registry.byThread(threadId) ? f.native(threadId).status : 'unmade', worktree: worktree(threadId) })).toContain('"status":"running"'), { timeout: 20_000 })
  const incoming = () => git(folder, 'for-each-ref', '--format=%(refname)', 'refs/sotto/incoming').split('\n').filter(Boolean)
  return { ...f, parent, folder, check, worktree, running, incoming }
}

it('moves one check worktree to each check’s snapshot, keeping its packages, and installs first only when package-lock.json changed (#1312)', async () => {
  const packages = installer(true)
  const f = await fixture(packages.install)
  const first = await f.check()
  // The check's turn came, but package-lock.json was never installed there: npm ci runs first, and the brief waits for it.
  await vi.waitFor(() => expect(packages.installs).toHaveLength(1), { timeout: 20_000 })
  expect(f.worktree(first.delegation.thread)).toMatchObject({ status: 'pending', check: { install: 'running' } })
  const installing = f.ok(await f.read(f.parent, first.delegation.id)) as CheckResult
  expect(installing.delegation).toMatchObject({ outcome: 'working', check: { ahead: 0,
    note: 'Installing packages first, because package-lock.json changed since the last check on This computer. The checks start when that finishes. '
      + "Install scripts do not run, so a package that needs one is ready only once the check's thread runs npm rebuild." } })
  expect(f.workspace.registry.byThread(first.delegation.thread)).toBeUndefined()
  packages.finish()
  await f.running(first.delegation.thread)
  expect(f.native(first.delegation.thread).messages[0]).toMatchObject({ role: 'user', text: 'Synthetic brief' })
  const path = f.worktree(first.delegation.thread)!.path!
  expect(path).toContain('check-worktrees')
  expect(f.worktree(first.delegation.thread)).toMatchObject({ status: 'ready', reused: true, check: {} })
  // It is the checks' own, so no thread is offered it among the project's worktrees.
  const project = f.control.shell().host.threads.find(thread => thread.id === f.parent)!.projectId
  const offered = await f.workspace.host.workingCopyOptions(project)
  expect(offered.worktrees.some(worktree => sameFolder(worktree.path, path))).toBe(false)
  expect((f.ok(await f.read(f.parent, first.delegation.id)) as CheckResult).delegation.check).toBeUndefined()
  await f.endTurn(first.delegation.thread, 'Synthetic verdict: passed')

  // The next check, from a later commit with the same lockfile, moves the same folder and installs nothing.
  await commitFile(f.folder, 'p.txt', 'second\n')
  const second = await f.check()
  await f.running(second.delegation.thread)
  expect(f.worktree(second.delegation.thread)!.path).toBe(path)
  expect(packages.installs).toHaveLength(1)
  expect(lf(await readFile(join(path, 'p.txt'), 'utf8'))).toBe('second\n')
  expect(lf(await readFile(join(path, 'node_modules', 'installed.txt'), 'utf8'))).toBe('install 1\n')
  // The thread before follows the folder it worked in, as any worktree-backed thread does (ADR-0014).
  expect(f.worktree(first.delegation.thread)!.path).toBe(path)
  await f.endTurn(second.delegation.thread, 'Synthetic verdict: passed')

  // An uncommitted change to package-lock.json is in the snapshot, so that check installs first again.
  await writeFile(join(f.folder, 'package-lock.json'), '{ "lockfileVersion": 3, "changed": true }\n')
  const third = await f.check()
  await vi.waitFor(() => expect(packages.installs).toHaveLength(2), { timeout: 20_000 })
  packages.finish()
  await f.running(third.delegation.thread)
  expect(f.worktree(third.delegation.thread)!.path).toBe(path)
  expect(lf(await readFile(join(path, 'node_modules', 'installed.txt'), 'utf8'))).toBe('install 2\n')
  // Each commit came in an incoming ref, which went once the check worktree had it checked out.
  expect(f.incoming()).toEqual([])
}, 60_000)

it('gives a check a worktree of its own, with its packages installed first, leaving the check worktree as it is, when moving it could lose work or cut off a turn (#1312)', async () => {
  const packages = installer(false)
  const f = await fixture(packages.install)
  const first = await f.check()
  await f.running(first.delegation.thread)
  const path = f.worktree(first.delegation.thread)!.path!
  expect(packages.installs).toHaveLength(1)
  await f.endTurn(first.delegation.thread, 'Synthetic verdict: passed')

  // An untracked file the first check left is work: the folder stays, and the next check gets a new worktree.
  await writeFile(join(path, 'notes.txt'), 'kept\n')
  const second = await f.check()
  await f.running(second.delegation.thread)
  expect(f.worktree(second.delegation.thread)!.path).not.toBe(path)
  expect(f.worktree(second.delegation.thread)!.path).not.toContain('check-worktrees')
  expect(lf(await readFile(join(path, 'notes.txt'), 'utf8'))).toBe('kept\n')
  // The worktree of its own has no packages yet, so they are installed there before its brief, as in the check worktree.
  const own = f.worktree(second.delegation.thread)!.path!
  expect(packages.installs).toHaveLength(2)
  expect(lf(await readFile(join(own, 'node_modules', 'installed.txt'), 'utf8'))).toBe('install 2\n')
  expect(f.worktree(second.delegation.thread)).toMatchObject({ status: 'ready', check: {} })
  await f.endTurn(second.delegation.thread, 'Synthetic verdict: passed')

  // A turn running in a thread there holds it too, though the folder is clean.
  git(path, 'clean', '-q', '-f')
  expect((await f.control.commandShell({ type: 'manual-send', threadId: first.delegation.thread, draftId: randomUUID(), text: 'Synthetic follow-up' })).error).toBeNull()
  await f.running(first.delegation.thread)
  const third = await f.check()
  await f.running(third.delegation.thread)
  expect(f.worktree(third.delegation.thread)!.path).not.toBe(path)
  expect(packages.installs).toHaveLength(3)
  expect(await exists(join(path, 'p.txt'))).toBe(true)
}, 60_000)

it('makes a check’s new worktree as before while the check worktree is off (#1312)', async () => {
  const f = await fixture(undefined)
  const first = await f.check()
  await f.running(first.delegation.thread)
  const worktree = f.worktree(first.delegation.thread)!
  expect(worktree.path).not.toContain('check-worktrees')
  expect(worktree.check).toBeUndefined()
  expect(worktree.reused).toBeUndefined()
})

it('holds the check worktree’s checkout from before it reads the folder, so a send there that starts meanwhile is refused (#1312)', async () => {
  const packages = installer(false)
  const f = await fixture(packages.install, false)
  const first = await f.check()
  await f.running(first.delegation.thread)
  const path = f.worktree(first.delegation.thread)!.path!
  await f.endTurn(first.delegation.thread, 'Synthetic verdict: passed')
  // The next check reads whether the folder holds work; the earlier check's thread is sent a follow-up just then.
  const worktrees = (f.workspace.host as unknown as { worktrees: { git: RunGit } }).worktrees
  const run = worktrees.git
  // The send is held at the folder's checkout reservation, whichever way it goes, before the read goes on.
  const mutations = (f.workspace.host as unknown as { checkoutMutations: { acquire: (folder: string, kind: string, ...rest: unknown[]) => Promise<() => void> } }).checkoutMutations
  const acquire = mutations.acquire.bind(mutations)
  let reached!: () => void
  const reaching = new Promise<void>(resolve => { reached = resolve })
  const asks = vi.spyOn(mutations, 'acquire').mockImplementation(async (folder, kind, ...rest) => {
    if (kind === 'send' && sameFolder(folder, path)) { try { return await acquire(folder, kind, ...rest) } finally { reached() } }
    return acquire(folder, kind, ...rest)
  })
  let sibling: Promise<{ error: unknown }> | undefined
  const reads = vi.spyOn(worktrees, 'git').mockImplementation(async (cwd, args, options) => {
    if (!sibling && args[0] === 'status' && args.includes('--untracked-files=all') && sameFolder(cwd, path)) {
      sibling = f.control.commandShell({ type: 'manual-send', threadId: first.delegation.thread, draftId: randomUUID(), text: 'Synthetic follow-up' })
      await reaching
    }
    return run(cwd, args, options)
  })
  try {
    const second = await f.check()
    await f.running(second.delegation.thread)
    expect(sibling).toBeDefined()
    expect(JSON.stringify((await sibling!).error)).toMatch(/setting up the working copy/u)
    expect(f.worktree(second.delegation.thread)!.path).toBe(path)
    expect(f.native(first.delegation.thread).status).toBe('idle')
    // A project with no package-lock.json installs nothing.
    expect(packages.installs).toEqual([])
  } finally { reads.mockRestore(); asks.mockRestore() }
}, 60_000)

it('leaves an ignored file an earlier check left when the next check’s commit tracks that path, and gives that check a worktree of its own (#1312)', async () => {
  const f = await fixture(installer(false).install, false)
  await commitFile(f.folder, '.gitignore', 'node_modules/\nreports/\n', 'Ignore reports')
  const first = await f.check()
  await f.running(first.delegation.thread)
  const path = f.worktree(first.delegation.thread)!.path!
  await mkdir(join(path, 'reports'))
  await writeFile(join(path, 'reports', 'result.json'), '{ "left": "by the first check" }\n')
  await f.endTurn(first.delegation.thread, 'Synthetic verdict: passed')
  // The project starts tracking that path, so the next check's commit would overwrite the ignored file.
  await commitFile(f.folder, '.gitignore', 'node_modules/\n', 'Track reports')
  await mkdir(join(f.folder, 'reports'))
  await commitFile(f.folder, 'reports/result.json', '{ "tracked": true }\n')
  const second = await f.check()
  await f.running(second.delegation.thread)
  expect(f.worktree(second.delegation.thread)!.path).not.toBe(path)
  expect(lf(await readFile(join(path, 'reports', 'result.json'), 'utf8'))).toBe('{ "left": "by the first check" }\n')
}, 60_000)

it('stops a check’s install, and waits for its setup to end, when Sotto closes (#1312)', async () => {
  let stopped = false, ended = false
  const install: PackageInstaller = async (_folder, signal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    stopped = true
    // Its process tree takes a moment to go, and closing waits for it.
    await new Promise(resolve => setTimeout(resolve, 200))
    ended = true
    return 'failed'
  }
  const f = await fixture(install)
  const first = await f.check()
  await vi.waitFor(() => expect(f.worktree(first.delegation.thread)?.check?.install).toBe('running'), { timeout: 20_000 })
  await f.workspace.host.close().catch(() => undefined)
  // Closed: the fixture's own stop would save the history setting again into the store that closing closed.
  vi.spyOn(f.workspace.host, 'privacyChanged').mockResolvedValue(undefined)
  expect(stopped).toBe(true)
  expect(ended).toBe(true)
}, 60_000)
