// @vitest-environment node
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWorktreeGitProcess, ThreadWorktrees, type RunGit } from '../../../src/main/agents/threadWorktrees'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-origin-fetch-')))
  roots.push(root)
  const fetch = vi.fn<RunGit>().mockResolvedValue('')
  const remote = vi.fn<RunGit>().mockResolvedValue('')
  const git: RunGit = async (cwd, args, options) => {
    if (args[0] === 'fetch') return fetch(cwd, args, options)
    if (args[0] === 'ls-remote') return remote(cwd, args, options)
    if (args[0] === 'rev-parse') return args.includes('--verify') ? 'a'.repeat(40) : root
    return ''
  }
  const service = new ThreadWorktrees(root, git)
  const allocate = () => service.allocate(root, 'independent', { baseBranch: 'main', startFromOrigin: true })
  const diagnostic = async () => JSON.parse(await readFile(join(root, 'worktree-origin-fetch-failure.json'), 'utf8'))
  return { root, fetch, remote, service, allocate, diagnostic }
}

const collision = (branch = 'main') => Object.assign(new Error(`error: cannot lock ref 'refs/remotes/origin/${branch}': is at ${'a'.repeat(40)} but expected ${'b'.repeat(40)}`), { code: 1 })

describe('origin fetch recovery', () => {
  it('retries a shared-ref collision and keeps the failed Git diagnostic after recovery', async () => {
    const f = await fixture(), error = collision()
    f.fetch.mockRejectedValueOnce(error)
    expect(await f.allocate()).toMatchObject({ originBase: 'fetched', baseCommit: 'a'.repeat(40) })
    expect(f.fetch).toHaveBeenCalledTimes(2)
    expect(await f.diagnostic()).toMatchObject({ stage: 'fetch', baseBranch: 'main', code: 1, timedOut: false, stderr: error.message })
    expect(f.fetch.mock.calls.every(([, args]) => args.includes('--no-write-fetch-head'))).toBe(true)
  })

  it('bounds repeated collisions and lets the next setup attempt fetch again', async () => {
    const f = await fixture(), error = collision()
    f.fetch.mockRejectedValue(error)
    await expect(f.allocate()).rejects.toMatchObject({ cause: error })
    expect(f.fetch).toHaveBeenCalledTimes(3)
    f.fetch.mockResolvedValue('')
    expect(await f.allocate()).toMatchObject({ originBase: 'fetched' })
    expect(f.fetch).toHaveBeenCalledTimes(4)
  })

  it('retries when another fetch still holds the selected ref lock file', async () => {
    const f = await fixture()
    f.fetch.mockRejectedValueOnce(new Error("error: cannot lock ref 'refs/remotes/origin/main': Unable to create '/repo/.git/refs/remotes/origin/main.lock': File exists."))
    expect(await f.allocate()).toMatchObject({ originBase: 'fetched' })
    expect(f.fetch).toHaveBeenCalledTimes(2)
  })

  it.each(['ls-remote', 'fetch'] as const)('keeps %s connection failures fatal, preserves their cause and redacts diagnostic URLs', async stage => {
    const f = await fixture()
    const error = Object.assign(new Error("fatal: Authentication failed for 'https://user:secret@example.invalid/repo'"), { code: 128 })
    ;(stage === 'fetch' ? f.fetch : f.remote).mockRejectedValue(error)
    await expect(f.allocate()).rejects.toMatchObject({ message: expect.stringContaining('could not be fetched'), cause: error })
    expect(f.remote).toHaveBeenCalledTimes(1)
    expect(f.fetch).toHaveBeenCalledTimes(stage === 'fetch' ? 1 : 0)
    const diagnostic = await f.diagnostic()
    expect(diagnostic).toMatchObject({ stage, code: 128 })
    expect(diagnostic.stderr).toContain('Authentication failed')
    expect(diagnostic.stderr).not.toContain('secret')
  })

  it('does not retry a collision for another ref', async () => {
    const f = await fixture()
    f.fetch.mockRejectedValue(collision('other'))
    await expect(f.allocate()).rejects.toThrow('could not be fetched')
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })

  it('forgets a timed-out early fetch, retains stderr, and lets the send fetch again', async () => {
    const f = await fixture()
    const error = Object.assign(new Error('Git took too long.'), { timedOut: true, stderr: 'Connecting to origin', code: null })
    f.remote.mockRejectedValueOnce(error)
    await expect(f.service.prefetchOriginBase(f.root, 'main')).rejects.toMatchObject({ cause: error })
    expect(await f.diagnostic()).toMatchObject({ stage: 'ls-remote', quiet: true, timedOut: true, stderr: 'Connecting to origin' })
    expect(await f.allocate()).toMatchObject({ originBase: 'fetched' })
    expect(f.remote).toHaveBeenCalledTimes(2)
  })

  it('still uses the local branch only when a reachable origin lacks the branch', async () => {
    const f = await fixture()
    f.remote.mockRejectedValue(Object.assign(new Error('No matching ref'), { code: 2 }))
    expect(await f.allocate()).toMatchObject({ originBase: 'not-on-origin' })
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('retains the real process stderr on its error', async () => {
    await expect(runWorktreeGitProcess(process.cwd(), [], {
      executable: process.execPath, prefix: ['-e', "process.stderr.write('real Git failure'); process.exitCode = 1"],
    })).rejects.toMatchObject({ code: 1, stderr: 'real Git failure', timedOut: false })
  })
})
