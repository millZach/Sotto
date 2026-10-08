// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { GitHubRateLimit, GitHubRateLimited, type GitHubRateLimitEvent } from '../../../src/main/agents/github'
import { PullRequestHeads } from '../../../src/main/agents/githubPullRequestHeads'
import type { RunGitCommand } from '../../../src/main/agents/gitStatus'

const repository = { host: 'github.com', owner: 'sotto-fixture', name: 'owned' }
const gather = { user: 1, background: 1 }

describe('what a failed head lookup counts as', () => {
  it('takes an answer that fails to parse at rateLimit for a failure, not a rate-limit refusal', async () => {
    const events: GitHubRateLimitEvent[] = []
    const rateLimit = new GitHubRateLimit({ log: event => events.push(event) })
    const run: RunGitCommand = async () => JSON.stringify({ data: { rateLimit: { limit: 'many' }, repository: { h0: { nodes: [] } } } })
    const heads = new PullRequestHeads({ run, rateLimit, gatherMs: gather })
    const error: unknown = await heads.lookup('C:/repo', repository, 'feature/x', 'background').then(() => null, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(GitHubRateLimited)
    expect(events).toEqual([])
    expect(rateLimit.retryAt('github.com', 'background')).toBeNull()
  })
  it('takes gh\'s rate-limit refusal for one, and pauses the host', async () => {
    const rateLimit = new GitHubRateLimit()
    const run: RunGitCommand = async () => { throw new Error('gh: You have exceeded a secondary rate limit. (HTTP 403)') }
    const heads = new PullRequestHeads({ run, rateLimit, gatherMs: gather })
    await expect(heads.lookup('C:/repo', repository, 'feature/x', 'background')).rejects.toBeInstanceOf(GitHubRateLimited)
    expect(rateLimit.retryAt('github.com', 'background')).not.toBeNull()
  })
})
