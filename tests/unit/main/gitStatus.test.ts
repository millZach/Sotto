// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitStatusReader, parsePorcelain, runGitStatusCommand, type RunGitCommand } from '../../../src/main/agents/gitStatus'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim()
const commit = (cwd: string, file: string, text: string, message: string) => { execFileSync('git', ['add', '.'], { cwd, windowsHide: true }); git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', message) }

/** A repository on `main`, pushed to an owned bare remote, with a second clone that can move the remote under it. */
async function fixture(options: { remote?: boolean; fetchIntervalMs?: number; gh?: (args: readonly string[]) => Promise<string> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-git-status-')); roots.push(root)
  const repo = join(root, 'repo'), remote = join(root, 'remote.git'), other = join(root, 'other')
  await mkdir(repo)
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid'); git(repo, 'config', 'commit.gpgSign', 'false'); git(repo, 'config', 'core.autocrlf', 'false')
  await writeFile(join(repo, 'work.txt'), 'first\n'); commit(repo, 'work.txt', 'first\n', 'First')
  if (options.remote !== false) {
    git(root, 'init', '--bare', '-q', '-b', 'main', remote); git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', '-u', 'origin', 'main'); git(repo, 'remote', 'set-head', 'origin', 'main')
    git(root, 'clone', '-q', '-b', 'main', remote, other); git(other, 'config', 'user.name', 'Fixture'); git(other, 'config', 'user.email', 'fixture@example.invalid'); git(other, 'config', 'commit.gpgSign', 'false'); git(other, 'config', 'core.autocrlf', 'false')
  }
  const calls: string[][] = []
  let now = 1_000_000
  const run: RunGitCommand = async (cwd, command, args, runOptions) => {
    calls.push([command, ...args])
    if (command === 'gh') { if (!options.gh) throw new Error('gh: not signed in'); return options.gh(args) }
    return runGitStatusCommand(cwd, command, args, runOptions)
  }
  const reader = new GitStatusReader({ run, now: () => now, fetchIntervalMs: () => options.fetchIntervalMs ?? 30_000 })
  return { root, repo, remote, other, reader, calls, advance: (ms: number) => { now += ms }, fetches: () => calls.filter(call => call[1] === 'fetch').length, ghCalls: () => calls.filter(call => call[0] === 'gh').length }
}

describe('Git status the way T3 reads it', () => {
  it('says when a folder is not a repository', async () => {
    const f = await fixture({ remote: false })
    const plain = join(f.root, 'plain'); await mkdir(plain)
    expect(await f.reader.read(plain, { remote: true })).toMatchObject({ isRepository: false, branch: null, hasRemote: false, dirty: false, ahead: 0, behind: 0, pullRequest: null, fetchedAt: null })
  })
  it('reads the branch, its upstream, the default branch and a clean tree', async () => {
    const f = await fixture()
    const status = await f.reader.read(f.repo, { remote: false })
    expect(status).toMatchObject({ isRepository: true, branch: 'main', upstream: 'origin/main', hasRemote: true, defaultBranch: 'main', isDefaultBranch: true, dirty: false, changedFiles: 0, insertions: 0, deletions: 0, ahead: 0, behind: 0, aheadOfDefault: null, fetchedAt: null })
    expect(f.fetches()).toBe(0) // a local read never fetches
  })
  it('counts changed files and lines, untracked files included', async () => {
    const f = await fixture({ remote: false })
    await writeFile(join(f.repo, 'work.txt'), 'first\nsecond\n')
    await writeFile(join(f.repo, 'new.txt'), 'new\n')
    expect(await f.reader.read(f.repo, { remote: false })).toMatchObject({ dirty: true, changedFiles: 2, insertions: 1, deletions: 0, hasRemote: false, defaultBranch: 'main', upstream: null })
  })
  it('reports ahead and behind against the fetched tracking ref, and diverged as both', async () => {
    const f = await fixture()
    await writeFile(join(f.repo, 'work.txt'), 'local\n'); commit(f.repo, 'work.txt', 'local\n', 'Local commit')
    expect(await f.reader.read(f.repo, { remote: false })).toMatchObject({ ahead: 1, behind: 0 })
    await writeFile(join(f.other, 'other.txt'), 'remote\n'); commit(f.other, 'other.txt', 'remote\n', 'Remote commit'); git(f.other, 'push', '-q')
    // The tracking ref is stale until the remote half fetches.
    expect(await f.reader.read(f.repo, { remote: false })).toMatchObject({ ahead: 1, behind: 0 })
    const fetched = await f.reader.read(f.repo, { remote: true })
    expect(fetched).toMatchObject({ ahead: 1, behind: 1 })
    expect(fetched.fetchedAt).not.toBeNull()
    expect(f.fetches()).toBe(1)
  })
  it('fetches at most once per fresh window, backs off after a failure, and never fetches with the interval off', async () => {
    const f = await fixture()
    await f.reader.read(f.repo, { remote: true }); await f.reader.read(f.repo, { remote: true })
    expect(f.fetches()).toBe(1)
    f.advance(15_001)
    await f.reader.read(f.repo, { remote: true })
    expect(f.fetches()).toBe(2)
    // The remote goes away: one quiet failure, then a wait before the next attempt.
    git(f.repo, 'remote', 'set-url', 'origin', join(f.root, 'gone.git'))
    f.advance(15_001)
    const failed = await f.reader.read(f.repo, { remote: true })
    expect(failed).toMatchObject({ isRepository: true, branch: 'main' })
    expect(failed.fetchedAt).not.toBeNull() // the last successful fetch still stands
    expect(f.fetches()).toBe(3)
    f.advance(15_001)
    await f.reader.read(f.repo, { remote: true })
    expect(f.fetches()).toBe(3) // backing off
    f.advance(30_000)
    await f.reader.read(f.repo, { remote: true })
    expect(f.fetches()).toBe(4)
    const off = await fixture({ fetchIntervalMs: 0 })
    expect((await off.reader.read(off.repo, { remote: true })).fetchedAt).toBeNull()
    expect(off.fetches()).toBe(0)
  })
  it('reads a detached HEAD as no branch, and a feature branch with no upstream by its distance from the default branch', async () => {
    const f = await fixture()
    git(f.repo, 'switch', '-q', '--detach')
    expect(await f.reader.read(f.repo, { remote: false })).toMatchObject({ branch: null, upstream: null, isDefaultBranch: false, aheadOfDefault: null })
    git(f.repo, 'switch', '-q', '-c', 'feature', 'main')
    await writeFile(join(f.repo, 'feature.txt'), 'feature\n'); commit(f.repo, 'feature.txt', 'feature\n', 'Feature work')
    expect(await f.reader.read(f.repo, { remote: false })).toMatchObject({ branch: 'feature', upstream: null, isDefaultBranch: false, aheadOfDefault: 1, ahead: 1, behind: 0 })
  })
  it('asks GitHub for the branch pull request only once it is published, caches the answer, and asks again after an action', async () => {
    const answers: string[] = [JSON.stringify([
      { number: 7, title: 'Older', url: 'https://github.com/o/r/pull/7', state: 'MERGED', isDraft: false, headRefName: 'feature', updatedAt: '2026-09-01T00:00:00Z' },
      { number: 9, title: 'Newer', url: 'https://github.com/o/r/pull/9', state: 'OPEN', isDraft: true, headRefName: 'feature', updatedAt: '2026-09-02T00:00:00Z' },
      { number: 8, title: 'Other branch', url: 'https://github.com/o/r/pull/8', state: 'OPEN', isDraft: false, headRefName: 'elsewhere', updatedAt: '2026-09-03T00:00:00Z' },
    ])]
    const f = await fixture({ gh: async () => answers[0]! })
    git(f.repo, 'switch', '-q', '-c', 'feature')
    await writeFile(join(f.repo, 'feature.txt'), 'feature\n'); commit(f.repo, 'feature.txt', 'feature\n', 'Feature work')
    expect((await f.reader.read(f.repo, { remote: true })).pullRequest).toBeNull()
    expect(f.ghCalls()).toBe(0) // unpublished: nothing to ask about
    git(f.repo, 'push', '-q', '-u', 'origin', 'feature')
    f.advance(60_001)
    expect((await f.reader.read(f.repo, { remote: true })).pullRequest).toEqual({ number: 9, title: 'Newer', url: 'https://github.com/o/r/pull/9', state: 'open', draft: true })
    expect(f.ghCalls()).toBe(1)
    await f.reader.read(f.repo, { remote: true }); await f.reader.read(f.repo, { remote: false })
    expect(f.ghCalls()).toBe(1) // cached for a minute; a local read never asks
    f.reader.invalidate()
    expect((await f.reader.read(f.repo, { remote: true })).pullRequest?.number).toBe(9)
    expect(f.ghCalls()).toBe(2)
    // On the default branch only an open pull request counts.
    answers[0] = JSON.stringify([{ number: 3, title: 'Landed', url: 'https://github.com/o/r/pull/3', state: 'MERGED', isDraft: false, headRefName: 'main' }])
    git(f.repo, 'switch', '-q', 'main')
    expect((await f.reader.read(f.repo, { remote: true })).pullRequest).toBeNull()
  })
  it('keeps the last pull request answer while GitHub cannot be asked, and waits before asking again', async () => {
    let fail = false
    const f = await fixture({ gh: async () => { if (fail) throw new Error('gh: rate limited'); return JSON.stringify([{ number: 4, title: 'Open', url: 'https://github.com/o/r/pull/4', state: 'OPEN', isDraft: false, headRefName: 'main' }]) } })
    expect((await f.reader.read(f.repo, { remote: true })).pullRequest?.number).toBe(4)
    fail = true; f.reader.invalidate()
    expect((await f.reader.read(f.repo, { remote: true })).pullRequest?.number).toBe(4)
    expect(f.ghCalls()).toBe(2)
    await f.reader.read(f.repo, { remote: true })
    expect(f.ghCalls()).toBe(2) // backing off, not retrying on every read
    f.advance(20_001)
    await f.reader.read(f.repo, { remote: true })
    expect(f.ghCalls()).toBe(3)
  })
  it('shares one read between callers asking for the same folder at once', async () => {
    const f = await fixture({ remote: false })
    const [a, b] = await Promise.all([f.reader.read(f.repo, { remote: false }), f.reader.read(f.repo, { remote: false })])
    expect(a).toBe(b)
  })
})

describe('porcelain v2 parsing', () => {
  it('reads the branch headers and counts records, a rename once', () => {
    const output = ['# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 abc abc work.txt', '2 R. N... 100644 100644 100644 abc abc R100 new.txt', 'old.txt', '? untracked.txt', ''].join('\0')
    expect(parsePorcelain(output)).toEqual({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, changedFiles: 3, unborn: false })
    expect(parsePorcelain(['# branch.oid (initial)', '# branch.head (detached)', ''].join('\0'))).toEqual({ branch: null, upstream: null, ahead: 0, behind: 0, changedFiles: 0, unborn: true })
  })
})
