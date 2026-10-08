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

describe('a pause and the answers around it', () => {
  const answer = JSON.stringify({ data: { rateLimit: { limit: 5000, remaining: 4000, resetAt: new Date(Date.now() + 3_600_000).toISOString() }, viewer: { login: 'me' }, repository: { h0: { nodes: [] } } } })
  it('holds the pause when a query sent before the refusal is answered after it', async () => {
    const rateLimit = new GitHubRateLimit()
    let sent!: () => void, answerEarly!: (text: string) => void
    const earlySent = new Promise<void>(resolve => { sent = resolve })
    const run: RunGitCommand = async (_cwd, _command, args) => {
      if (args.includes('name=early')) { sent(); return await new Promise<string>(resolve => { answerEarly = resolve }) }
      throw new Error('gh: You have exceeded a secondary rate limit. (HTTP 403)')
    }
    const heads = new PullRequestHeads({ run, rateLimit, gatherMs: gather })
    const early = heads.lookup('C:/early', { ...repository, name: 'early' }, 'main', 'background')
    await earlySent
    await expect(heads.lookup('C:/late', { ...repository, name: 'late' }, 'main', 'background')).rejects.toBeInstanceOf(GitHubRateLimited)
    const pausedUntil = rateLimit.retryAt('github.com', 'background')
    expect(pausedUntil).not.toBeNull()
    answerEarly(answer)
    await expect(early).resolves.toEqual([])
    // GitHub answered that query before it began refusing; the pause holds until its own end.
    expect(rateLimit.retryAt('github.com', 'background')).toBe(pausedUntil)
  })
  it('ends the pause when a query sent after the refusal is answered', async () => {
    const rateLimit = new GitHubRateLimit()
    let refuse = true
    const run: RunGitCommand = async () => { if (refuse) throw new Error('gh: You have exceeded a secondary rate limit. (HTTP 403)'); return answer }
    const heads = new PullRequestHeads({ run, rateLimit, gatherMs: gather })
    await expect(heads.lookup('C:/repo', repository, 'main', 'background')).rejects.toBeInstanceOf(GitHubRateLimited)
    refuse = false
    await expect(heads.lookup('C:/repo', repository, 'main', 'user')).resolves.toEqual([])
    expect(rateLimit.retryAt('github.com', 'background')).toBeNull()
  })
})
