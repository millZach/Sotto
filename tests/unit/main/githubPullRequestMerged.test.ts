// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { GitHubHosts, GitHubRateLimit, GitHubRateLimited } from '../../../src/main/agents/github'
import { runWorktreeGit } from '../../../src/main/agents/threadWorktrees'
import { githubPullRequestMerged } from '../../../src/main/agents/worktreeCleanup'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
vi.mock('../../../src/main/agents/threadWorktrees', () => ({ runWorktreeGit: vi.fn() }))
const tip = 'a'.repeat(40)
let prs: unknown[]
beforeEach(() => {
  prs = []
  vi.mocked(runWorktreeGit).mockResolvedValue(`${tip}\n`)
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string) => void
    callback(null, JSON.stringify(prs))
    return {} as ReturnType<typeof execFile>
  })
})
it('leaves current work alone when a merged PR has an older tip on a reused branch', async () => {
  prs = [{ number: 1, headRefOid: 'b'.repeat(40), isCrossRepository: false }]
  await expect(githubPullRequestMerged('repo', 'feature')).resolves.toBe(false)
})
it('leaves current work alone when a fork used the same branch name for different work', async () => {
  prs = [{ number: 1, headRefOid: 'c'.repeat(40), isCrossRepository: true }]
  await expect(githubPullRequestMerged('repo', 'feature')).resolves.toBe(false)
})
it('accepts the merged PR of this checkout branch at its current tip', async () => {
  prs = [{ number: 2, headRefOid: tip, isCrossRepository: false }]
  await expect(githubPullRequestMerged('repo', 'feature')).resolves.toBe(true)
})
it('never treats a missing local branch as merged', async () => {
  vi.mocked(runWorktreeGit).mockRejectedValue(new Error('Missing branch'))
  prs = [{ number: 2, headRefOid: tip, isCrossRepository: false }]
  await expect(githubPullRequestMerged('repo', 'feature')).resolves.toBe(false)
})

it('accepts a fork PR only when it merged the current branch tip', async () => {
  prs = [{ number: 2, headRefOid: tip, isCrossRepository: true }]
  await expect(githubPullRequestMerged('repo', 'feature')).resolves.toBe(true)
})
it('leaves a branch alone if its tip changes while GitHub answers', async () => {
  prs = [{ headRefOid: tip }]
  vi.mocked(runWorktreeGit).mockResolvedValueOnce(tip).mockResolvedValueOnce('d'.repeat(40))
  await expect(githubPullRequestMerged('repo', 'feature')).resolves.toBe(false)
})
describe('within the sign-in\'s GitHub rate limit (#820)', () => {
  const shared = () => {
    let now = 1_000_000
    const rateLimit = new GitHubRateLimit({ now: () => now })
    const hosts = new GitHubHosts({ run: async () => { throw new Error('unexpected') }, now: () => now })
    return { github: { rateLimit, hosts }, rateLimit, advance: (ms: number) => { now += ms }, at: (ms: number) => new Date(now + ms).toISOString() }
  }
  beforeEach(() => {
    vi.mocked(execFile).mockClear()
    vi.mocked(runWorktreeGit).mockImplementation(async (_cwd, args) => args[0] === 'config' ? 'remote.origin.url https://github.com/me/repo.git\n' : `${tip}\n`)
  })
  it('asks nothing while the reserve is reached, and asks once it resets', async () => {
    const f = shared()
    f.rateLimit.answered('github.com', f.rateLimit.asking(), { limit: 5000, remaining: 100, resetAt: f.at(60_000) })
    prs = [{ headRefOid: tip }]
    await expect(githubPullRequestMerged('repo', 'feature', f.github)).rejects.toBeInstanceOf(GitHubRateLimited)
    expect(execFile).not.toHaveBeenCalled()
    f.advance(60_001)
    await expect(githubPullRequestMerged('repo', 'feature', f.github)).resolves.toBe(true)
  })
  it('pauses the sign-in\'s background questions when GitHub refuses it for the rate limit', async () => {
    const f = shared()
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void
      callback(new Error('Command failed'), '', 'GraphQL: API rate limit exceeded for user ID 1.')
      return {} as ReturnType<typeof execFile>
    })
    await expect(githubPullRequestMerged('repo', 'feature', f.github)).rejects.toBeInstanceOf(GitHubRateLimited)
    expect(f.rateLimit.retryAt('github.com', 'background')).not.toBeNull()
    expect(f.rateLimit.retryAt('github.com', 'user')).toBeNull()
  })
})
it('finds the matching current tip among older reused branch results', async () => {
  prs = [{ headRefOid: 'b'.repeat(40) }, { headRefOid: tip }]
  await expect(githubPullRequestMerged('repo', 'feature')).resolves.toBe(true)
})
