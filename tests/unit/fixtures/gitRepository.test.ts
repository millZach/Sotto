// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertWholeRepositoryCopy, gitRepositorySeed, ownedGitRepository } from '../../fixtures/gitRepository'

const owned: Array<{ dispose: () => Promise<void> }> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const owner of owned.splice(0).reverse()) await owner.dispose()
})

// Deliberately use ordinary Git, as the service does, without fixture command-line overrides.
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

describe('independent Git repository fixtures', () => {
  it('copies valid independent baselines without leaving automatic maintenance behind', async () => {
    const traceRoot = await mkdtemp(join(tmpdir(), 'sotto-git-fixture-trace-'))
    owned.push({ dispose: () => rm(traceRoot, { recursive: true, force: true }) })
    const trace = join(traceRoot, 'git.jsonl')
    vi.stubEnv('GIT_TRACE2_EVENT', trace)

    const seed = await gitRepositorySeed({ files: { 'tracked.txt': 'baseline\n' } })
    owned.push(seed)
    const first = await seed.copy({ secondClone: true })
    owned.push(first)
    const baseline = git(first.repo, 'rev-parse', 'HEAD')
    await writeFile(join(first.repo, 'tracked.txt'), 'first copy\n')
    git(first.repo, 'add', '-A')
    git(first.repo, 'commit', '-qm', 'Change the first copy')
    git(first.repo, 'push', '-q')
    git(first.other, 'pull', '-q', '--ff-only')
    await writeFile(join(first.other, 'other.txt'), 'second clone\n')
    git(first.other, 'add', '-A')
    git(first.other, 'commit', '-qm', 'Change the second clone')
    git(first.other, 'push', '-q')
    git(first.repo, 'fetch', '-q')

    const second = await seed.copy()
    owned.push(second)
    expect(git(second.repo, 'rev-parse', 'HEAD')).toBe(baseline)
    expect(await readFile(join(second.repo, 'tracked.txt'), 'utf8')).toBe('baseline\n')
    expect(git(first.repo, 'rev-parse', 'HEAD')).not.toBe(baseline)
    expect(git(first.other, 'show', 'HEAD:other.txt')).toBe('second clone')
    for (const repo of [first.repo, first.other, first.remote, second.repo]) git(repo, 'fsck', '--no-reflogs')

    const events = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { event: string; argv?: string[] })
    const children = events.filter(event => event.event === 'child_start').map(event => event.argv ?? [])
    // Prove tracing observed real subprocesses, then check that no command detached metadata work.
    expect(children.some(args => args.some(arg => arg.includes('receive-pack')))).toBe(true)
    expect(children.filter(args => args.includes('maintenance') || args.includes('gc'))).toEqual([])
  })

  it('does not run automatic GC even when the pack-count threshold is exceeded', async () => {
    const seed = await gitRepositorySeed()
    owned.push(seed)
    const copy = await seed.copy()
    owned.push(copy)
    git(copy.repo, 'repack')
    await writeFile(join(copy.repo, 'another.txt'), 'another object\n')
    git(copy.repo, 'add', '-A')
    git(copy.repo, 'commit', '-qm', 'Add another object')
    git(copy.repo, 'repack')
    const packDirectory = join(copy.repo, '.git', 'objects', 'pack')
    const before = (await readdir(packDirectory)).filter(name => name.endsWith('.pack')).sort()
    expect(before).toHaveLength(2)
    git(copy.repo, 'config', 'gc.autoPackLimit', '1')
    // Foreground execution makes an unwanted automatic collection fail deterministically, without a sleep.
    git(copy.repo, 'gc', '--auto', '--no-detach')
    expect((await readdir(packDirectory)).filter(name => name.endsWith('.pack')).sort()).toEqual(before)
    expect(git(copy.repo, 'show', 'HEAD:another.txt')).toBe('another object')
    git(copy.repo, 'fsck', '--no-reflogs')
  })

  it('refuses a copy Git would not see as the seed: another HEAD, an unreadable HEAD, or no index', async () => {
    const seed = await gitRepositorySeed()
    owned.push(seed)
    const copy = await seed.copy()
    owned.push(copy)
    const tree = git(copy.repo, 'rev-parse', 'HEAD^{tree}')
    await expect(assertWholeRepositoryCopy(copy.repo, tree)).resolves.toBeUndefined()
    await expect(assertWholeRepositoryCopy(copy.repo, '0'.repeat(40))).rejects.toThrow(`The repository copy at ${copy.repo} is incomplete: its HEAD is not the seed's.`)
    await writeFile(join(copy.repo, '.git', 'HEAD'), '')
    await expect(assertWholeRepositoryCopy(copy.repo, tree)).rejects.toThrow('is incomplete: Git cannot read its HEAD. Nothing ran in it; free some disk space, then run the test again.')
    await unlink(join(copy.repo, '.git', 'index'))
    await expect(assertWholeRepositoryCopy(copy.repo, tree)).rejects.toThrow('is incomplete: .git/index is missing.')
  })

  // #1002: fixture commands on the Windows runner exited 1 with nothing on stderr, so the cause was never recorded.
  it('names how a failed fixture command ended, with Git\'s trace, its locks and the repository\'s status', async () => {
    const made = await ownedGitRepository()
    owned.push(made)
    await writeFile(join(made.repo, 'tracked.txt'), 'changed\n')
    await writeFile(join(made.repo, '.git', 'index.lock'), '')
    // `diff --quiet` exits 1 with nothing on stdout or stderr: the same outward shape as the runner's failures.
    const quiet = (() => { try { made.git('diff', '--quiet'); return undefined } catch (error) { return error as Error & { status?: number } } })()
    expect(quiet?.status).toBe(1)
    expect(quiet?.message).toContain(`Fixture command \`git diff --quiet\` in ${made.repo} exited 1. Git reported its own exit.`)
    expect(quiet?.message).toMatch(/stderr and trace:\n[\s\S]*\| d0 \|[^\n]*\| start +\|[^\n]*git diff --quiet\n[\s\S]*\| d0 \|[^\n]*\| exit +\|[^\n]*code:1\n/u)
    expect(quiet?.message).toMatch(/GIT_\* variables: .*GIT_CONFIG_NOSYSTEM/u)
    expect(quiet?.message).toContain(`lock files: ${join('.git', 'index.lock')}`)
    expect(quiet?.message).toMatch(/git status: \n# branch\.oid [0-9a-f]{40}\n# branch\.head main\n1 \.M .* tracked\.txt/u)
  })

  it.skipIf(process.platform === 'win32')('says when Git was ended from outside before it could report its exit, even after a child Git reported its own', async () => {
    const made = await ownedGitRepository()
    owned.push(made)
    // A shell alias that kills the Git running it stands in for a process ended from outside, as taskkill /F would.
    // The child Git it runs first writes its own exit to the same trace, one level deeper.
    const killed = (() => { try { made.git('-c', 'alias.vanish=!git --version; kill -9 $PPID', 'vanish'); return undefined } catch (error) { return error as Error } })()
    expect(killed?.message).toMatch(/\| d1 \|[^\n]*\| exit +\|/u)
    expect(killed?.message).toMatch(/was ended by SIGKILL\. Git never reported its own exit, so something outside it ended it\./u)
  })

  it('keeps Git\'s trace on when the inherited environment turns it off', async () => {
    const made = await ownedGitRepository()
    owned.push(made)
    await writeFile(join(made.repo, 'tracked.txt'), 'changed\n')
    vi.stubEnv('GIT_TRACE2', '0')
    vi.stubEnv('GIT_TRACE2_PERF', '0')
    const quiet = (() => { try { made.git('diff', '--quiet'); return undefined } catch (error) { return error as Error & { status?: number } } })()
    expect(quiet?.status).toBe(1)
    expect(quiet?.message).toContain('exited 1. Git reported its own exit.')
    expect(quiet?.message).toMatch(/GIT_\* variables: .*GIT_TRACE2_PERF/u)
  })

  it('names the launch error when Git could not start', async () => {
    const made = await ownedGitRepository()
    owned.push(made)
    vi.stubEnv('PATH', join(made.root, 'no-git-here'))
    vi.stubEnv('Path', join(made.root, 'no-git-here'))
    const missing = (() => { try { made.git('status'); return undefined } catch (error) { return error as Error & { code?: string } } })()
    expect(missing?.code).toBe('ENOENT')
    expect(missing?.message).toContain(`Fixture command \`git status\` in ${made.repo} could not start (ENOENT). Git never ran.`)
  })
})
