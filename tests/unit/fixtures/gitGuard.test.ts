// @vitest-environment node
/**
 * The test harness's Git guard (`tests/fixtures/gitGuard.ts`). On October 23, 2026 TEMP pointed inside the main
 * checkout, Git's discovery walked up from the Git actions test's plain folder into it, and the test committed the
 * user's untracked files there. The first block is that incident on an owned stand-in: the run now stops before any
 * test. The rest prove the guard `tests/setup.ts` installs refuses a change to a repository outside the temporary
 * folder, through every way a test or Sotto's own code starts Git, and lets a temporary repository's work through.
 *
 * Every command run here that the guard should refuse is a dry run, so a broken guard still changes nothing.
 */
import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from 'node:child_process'
import { realpathSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { assertTemporaryFolderOutsideRepositories, gitCallsInLine, gitCallsOf, gitCommandChanges, gitGuard, gitGuardRefusal, repositoryHoldingFolder, temporaryRoots } from '../../fixtures/gitGuard'
import { ownedGitRepository } from '../../fixtures/gitRepository'
import { GitActions } from '../../../src/main/agents/gitActions'
import { GitStatusReader } from '../../../src/main/agents/gitStatus'

const owned: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => { for (const owner of owned.splice(0)) await owner.dispose() })
async function repository() { const made = await ownedGitRepository(); owned.push(made); return made }

const roots = temporaryRoots()
/** A folder outside the temporary folder that every machine has: the checkout the tests run from. */
const outside = process.cwd()
const refused = /The test harness refused `git (commit|add|clean)` on .*: a test may change only repositories under the temporary folder/u

describe('a temporary folder inside a repository, the way the October 23 commit happened', () => {
  it('stops the run before a test, naming the repository a plain folder there would have found', async () => {
    // The stand-in for the main checkout, with the temporary folder where the thread put it: under an ignored .worktrees.
    const checkout = await repository()
    await writeFile(join(checkout.repo, '.gitignore'), '.worktrees/\n')
    await writeFile(join(checkout.repo, 'notes.md'), 'the user\'s untracked work\n')
    const temporary = join(checkout.repo, '.worktrees', '.kmc-cache', 'tmp')
    const plain = join(temporary, 'sotto-git-fixture-x', 'plain')
    await mkdir(plain, { recursive: true })

    // What the Git actions test met: its plain folder was not plain, and a commit there landed in the checkout.
    const found = repositoryHoldingFolder(plain)
    expect(found && realpathSync.native(found)).toBe(realpathSync.native(join(checkout.repo, '.git')))
    const actions = new GitActions({ status: new GitStatusReader({ fetchIntervalMs: () => 0 }), writeCommitMessage: async () => 'Write the commit from the diff', writePullRequestText: async () => null })
    const before = checkout.git('rev-parse', 'HEAD').trim()
    const result = await actions.runStackedAction({ threadId: 't', cwd: plain, action: 'commit' })
    expect(result.commit.status).toBe('created')
    expect(checkout.git('rev-parse', 'HEAD').trim()).not.toBe(before)
    expect(checkout.git('show', '--name-only', '--format=', 'HEAD').trim().split('\n')).toEqual(['.gitignore', 'notes.md'])

    // A test file's guard refuses the same commit on its own, from the temporary folder it was given, and lets reads by.
    const guard = gitGuard(temporaryRoots(temporary))
    expect(() => guard({ file: 'git', args: ['status', '--porcelain'], cwd: plain })).not.toThrow()
    expect(() => guard({ file: 'git', args: ['commit', '-F', '-'], cwd: plain })).toThrow(`The temporary folder ${temporary} is inside the Git repository at ${found}.`)
    // The run now refuses that temporary folder before any test makes a folder in it.
    expect(() => assertTemporaryFolderOutsideRepositories(temporary)).toThrow(`The temporary folder ${temporary} is inside the Git repository at ${found}. Tests make folders there and expect Git to find no repository, so a test could commit in that repository. No test ran. Point TEMP and TMP (TMPDIR on macOS and Linux) at a folder outside every repository, then run the tests again.`)
  }, 30_000)

  it('lets the run start when the temporary folder is outside every repository', () => {
    expect(repositoryHoldingFolder(tmpdir())).toBeNull()
    expect(() => assertTemporaryFolderOutsideRepositories()).not.toThrow()
  })
})

describe('the Git guard every test file has', () => {
  it('refuses a commit, reset or checkout outside the temporary folder, however a test starts Git', async () => {
    expect(() => execFileSync('git', ['commit', '--dry-run', '--allow-empty', '-m', 'Refused'], { cwd: outside, stdio: 'ignore' })).toThrow(refused)
    expect(() => spawnSync('git', ['add', '--dry-run', '.'], { cwd: outside })).toThrow(refused)
    expect(() => spawn('git', ['clean', '-n'], { cwd: outside })).toThrow(refused)
    expect(() => execFile('git', ['commit', '--dry-run'], { cwd: outside }, () => undefined)).toThrow(refused)
    expect(() => execSync('git commit --dry-run', { cwd: outside, stdio: 'ignore' })).toThrow(refused)
    expect(() => exec('git add --dry-run .', { cwd: outside })).toThrow(refused)
    await expect(Promise.resolve().then(() => promisify(execFile)('git', ['commit', '--dry-run'], { cwd: outside }))).rejects.toThrow(refused)
    // No folder at all is the test process's own folder, which is where Node runs it.
    expect(() => spawn('git', ['commit', '--dry-run'], { cwd: '' })).toThrow(refused)
    expect(() => spawn('git', ['commit', '--dry-run'])).toThrow(refused)
  })

  it('lets reads run anywhere and a temporary repository change, keeping promisified execFile whole', async () => {
    expect(execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: outside, encoding: 'utf8' }).trim()).toBe('true')
    expect((await promisify(execFile)('git', ['--version'])).stdout).toMatch(/^git version/u)
    const made = await repository()
    await writeFile(join(made.repo, 'work.txt'), 'changed\n')
    execFileSync('git', ['add', 'work.txt'], { cwd: made.repo })
    execFileSync('git', ['commit', '-qm', 'Allowed'], { cwd: made.repo })
    expect(made.git('log', '-1', '--format=%s').trim()).toBe('Allowed')
  })

  it('follows Git to the folder it would change: -C, --git-dir, --work-tree, redirecting variables, init and clone targets', () => {
    const inside = join(tmpdir(), 'sotto-guard-case')
    const refusal = (args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => gitGuardRefusal({ file: 'git', args, cwd: inside, env: {}, ...options }, roots)
    expect(refusal(['commit', '-m', 'x'])).toBeNull()
    expect(refusal(['-C', outside, 'commit', '-m', 'x'])).toMatch(refused)
    expect(refusal(['--no-optional-locks', '-c', 'core.quotePath=false', '-C', outside, 'reset', '--hard'])).toMatch(/refused `git reset`/u)
    expect(refusal([`--git-dir=${join(outside, '.git')}`, 'commit'])).toMatch(refused)
    expect(refusal(['--work-tree', outside, 'checkout', '.'])).toMatch(/refused `git checkout`/u)
    expect(refusal(['commit'], { env: { GIT_DIR: join(outside, '.git') } })).toMatch(refused)
    expect(refusal(['init', '-q', '-b', 'main'])).toBeNull()
    expect(refusal(['init', '-q', outside])).toMatch(/refused `git init`/u)
    expect(refusal(['clone', '-q', '-b', 'main', outside, join(inside, 'copy')])).toBeNull()
    expect(refusal(['clone', '-q', join(inside, 'remote.git'), join(outside, 'copy')])).toMatch(/refused `git clone`/u)
    expect(refusal(['status'], { cwd: outside })).toBeNull()
    expect(gitGuardRefusal({ file: 'C:\\Program Files\\Git\\cmd\\git.exe', args: ['commit'], cwd: outside }, roots)).toMatch(refused)
    expect(gitGuardRefusal({ file: 'gh', args: ['pr', 'create'], cwd: outside }, roots)).toBeNull()
    // What else a command run from the temporary folder can write: a separate Git folder, a new worktree, a config file.
    expect(refusal(['init', `--separate-git-dir=${join(outside, 'x.git')}`])).toMatch(/refused `git init`/u)
    expect(refusal(['clone', '--separate-git-dir', join(outside, 'x.git'), join(inside, 'remote.git'), 'copy'])).toMatch(/refused `git clone`/u)
    expect(refusal(['worktree', 'add', '-b', 'x', join(outside, 'tree')])).toMatch(/refused `git worktree`/u)
    expect(refusal(['worktree', 'add', '-b', 'x', join(inside, 'tree')])).toBeNull()
    expect(refusal(['config', '--file', join(outside, '.git', 'config'), 'core.bare', 'true'])).toMatch(/refused `git config`/u)
    expect(refusal(['config', '--global', 'user.name', 'x'])).toMatch(/refused `git config`/u)
    expect(refusal(['config', '--global', 'user.name', 'x'], { env: { GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } })).toBeNull()
  })

  it('refuses through a link under the temporary folder, and from a linked worktree whose repository is outside it', async () => {
    const made = await repository()
    // A junction (a symlink off Windows) under the temporary folder that leads out of it. It is unlinked before the
    // folder is removed, so the removal never walks into what it points at.
    const link = join(made.root, 'link-out')
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      expect(gitGuardRefusal({ file: 'git', args: ['commit'], cwd: link, env: {} }, roots)).toMatch(refused)
      expect(gitGuardRefusal({ file: 'git', args: ['commit'], cwd: join(link, 'not-made-yet'), env: {} }, roots)).toMatch(refused)
    } finally { if (process.platform === 'win32') rmdirSync(link); else unlinkSync(link) }
    // A worktree folder under the temporary folder whose .git file names a Git folder outside it.
    const tree = join(made.root, 'tree')
    await mkdir(join(tree, 'src'), { recursive: true })
    await writeFile(join(tree, '.git'), `gitdir: ${join(outside, '.git', 'worktrees', 'tree')}\n`)
    expect(gitGuardRefusal({ file: 'git', args: ['commit'], cwd: join(tree, 'src'), env: {} }, roots)).toMatch(/refused `git commit` on .*worktrees/u)
    expect(gitGuardRefusal({ file: 'git', args: ['status'], cwd: join(tree, 'src'), env: {} }, roots)).toBeNull()
  })

  it('reads every Git command in a shell line, in the folder each runs in', () => {
    const inside = join(tmpdir(), 'sotto-guard-case')
    const refusal = (file: string, args: string[], options: { cwd?: string; shell?: boolean } = {}) =>
      gitCallsOf(file, args, { cwd: inside, env: {}, ...options }).map(call => gitGuardRefusal(call, roots)).find(Boolean) ?? null
    expect(refusal('cmd.exe', ['/d', '/s', '/c', `cd /d "${outside}" && git reset --hard`])).toMatch(/refused `git reset`/u)
    expect(refusal('sh', ['-c', `git status; cd '${outside}' && git checkout .`])).toMatch(/refused `git checkout`/u)
    expect(refusal('git', ['status', '&&', 'git', '-C', `"${outside}"`, 'commit'], { shell: true })).toMatch(refused)
    expect(refusal('bash', ['-c', 'git status && git commit -qm x'])).toBeNull()
    expect(gitCallsInLine(`GIT_TRACE=1 git -C ${inside} commit -m "a && b" | cat`, outside, {}).map(call => call.args)).toEqual([['-C', inside, 'commit', '-m', 'a && b']])
    expect(() => execSync('git status && git commit --dry-run', { cwd: outside, stdio: 'ignore' })).toThrow(refused)
  })

  it.each([
    ['commit', ['-qm', 'x'], true], ['reset', ['-q', 'HEAD'], true], ['checkout', ['main', '--'], true], ['switch', ['-c', 'x'], true],
    ['push', ['origin', 'main'], true], ['fetch', ['origin'], true], ['read-tree', ['abc'], true], ['update-ref', ['refs/heads/x', 'abc'], true],
    ['stash', [], true], ['stash', ['push'], true], ['stash', ['list'], false],
    ['branch', ['feature'], true], ['branch', ['-D', 'feature'], true], ['branch', [], false], ['branch', ['--show-current'], false], ['branch', ['--list', '--no-column', '--format=%(refname:short)'], false],
    ['tag', ['v1'], true], ['tag', ['-l'], false],
    ['config', ['user.name', 'Fixture'], true], ['config', ['--unset', 'x'], true], ['config', ['--get', 'remote.pushDefault'], false], ['config', ['core.hooksPath'], false], ['config', ['get', 'x'], false],
    ['remote', ['add', 'origin', 'x'], true], ['remote', ['set-head', 'origin', 'main'], true], ['remote', [], false], ['remote', ['get-url', 'origin'], false],
    ['worktree', ['add', 'x'], true], ['worktree', ['list', '--porcelain'], false],
    ['symbolic-ref', ['HEAD', 'refs/heads/x'], true], ['symbolic-ref', ['--short', '-q', 'refs/remotes/origin/HEAD'], false],
    ['apply', ['--check', 'x.patch'], false], ['apply', ['x.patch'], true],
    ['status', ['--porcelain=v2'], false], ['diff', ['--cached'], false], ['log', ['-1'], false], ['write-tree', [], false], ['rev-parse', ['HEAD'], false],
    // A command it does not know as a read counts as a change.
    ['gc', ['--prune=now'], true], ['reflog', ['expire', '--expire=now', '--all'], true], ['reflog', [], false], ['hash-object', ['-w', 'x'], true], ['hash-object', ['x'], false],
    ['submodule', ['foreach', 'git reset --hard'], true], ['submodule', ['status'], false], ['maintenance', ['run'], true], ['some-future-command', [], true],
  ] as const)('counts git %s %j as a change: %s', (command, args, changes) => {
    expect(gitCommandChanges(command, args)).toBe(changes)
  })
})
