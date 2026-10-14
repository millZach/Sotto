// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gitRepositorySeed } from '../../fixtures/gitRepository'

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
})
