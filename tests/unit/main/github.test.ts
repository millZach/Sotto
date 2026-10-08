// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { baseRepository, GitHubRateLimit, isRateLimitAnswer, parseGitHubRemote, type GitHubRateLimitEvent } from '../../../src/main/agents/github'

describe('the GitHub repository a remote names', () => {
  it('reads HTTPS, scp-like and ssh URLs on GitHub hosts, and nothing else', () => {
    expect(parseGitHubRemote('https://github.com/Owner/Repo.git')).toEqual({ host: 'github.com', owner: 'Owner', name: 'Repo' })
    expect(parseGitHubRemote('https://token@github.com/owner/repo')).toEqual({ host: 'github.com', owner: 'owner', name: 'repo' })
    expect(parseGitHubRemote('git@github.com:owner/repo.git')).toEqual({ host: 'github.com', owner: 'owner', name: 'repo' })
    expect(parseGitHubRemote('ssh://git@github.example.com:2222/owner/repo')).toEqual({ host: 'github.example.com', owner: 'owner', name: 'repo' })
    expect(parseGitHubRemote('https://gitlab.com/owner/repo.git')).toBeNull()
    expect(parseGitHubRemote('C:/remotes/owned.git')).toBeNull()
    expect(parseGitHubRemote('/srv/git/owned.git')).toBeNull()
  })
  it('takes the remote gh repo set-default marked over origin', () => {
    const remotes = new Map([['origin', { url: 'https://github.com/me/fork', ghResolved: null }], ['upstream', { url: 'https://github.com/them/repo', ghResolved: 'base' }]])
    expect(baseRepository(remotes)).toMatchObject({ owner: 'them', name: 'repo' })
    expect(baseRepository(new Map([['origin', { url: 'https://github.com/me/fork', ghResolved: null }]]))).toMatchObject({ owner: 'me', name: 'fork' })
  })
})

describe('what counts as a rate-limited answer', () => {
  it('knows the primary and secondary limits and GitHub\'s other wordings for them', () => {
    expect(isRateLimitAnswer('GraphQL: API rate limit exceeded for user ID 1.')).toBe(true)
    expect(isRateLimitAnswer('gh: API rate limit already exceeded for user ID 1. (HTTP 403)')).toBe(true)
    expect(isRateLimitAnswer('You have exceeded a secondary rate limit. Please wait a few minutes before you try again.')).toBe(true)
    expect(isRateLimitAnswer('HTTP 429: Too Many Requests')).toBe(true)
    expect(isRateLimitAnswer('You have triggered an abuse detection mechanism.')).toBe(true)
    expect(isRateLimitAnswer('HTTP 403: Resource not accessible by integration')).toBe(false)
    expect(isRateLimitAnswer('error connecting to api.github.com')).toBe(false)
  })
})

describe('the allowance of a sign-in', () => {
  const setup = () => {
    let now = 1_000_000
    const events: GitHubRateLimitEvent[] = []
    const limit = new GitHubRateLimit({ now: () => now, log: event => events.push(event) })
    return { limit, events, advance: (ms: number) => { now += ms }, at: (ms: number) => new Date(now + ms).toISOString(), now: () => now }
  }
  it('holds the timer back below the reserve and lets the user through, until the reset', () => {
    const f = setup()
    f.limit.answered('github.com', { limit: 5000, remaining: 499, resetAt: f.at(600_000) }, 'me')
    expect(f.limit.retryAt('github.com', 'background')).toBe(f.now() + 600_000)
    expect(f.limit.retryAt('github.com', 'user')).toBeNull()
    expect(f.limit.retryAt('ghe.example.com', 'background')).toBeNull() // another host is another allowance
    expect(f.events).toEqual(['github-reserve-reached'])
    f.advance(600_001)
    expect(f.limit.retryAt('github.com', 'background')).toBeNull()
  })
  it('refuses even the user once GitHub reports nothing left, until the reset', () => {
    const f = setup()
    f.limit.answered('github.com', { limit: 5000, remaining: 0, resetAt: f.at(60_000) }, 'me')
    expect(f.limit.retryAt('github.com', 'user')).toBe(f.now() + 60_000)
  })
  it('forgets the reading of a sign-in that is no longer the one gh uses', () => {
    const f = setup()
    f.limit.answered('github.com', { limit: 5000, remaining: 10, resetAt: f.at(600_000) }, 'me')
    f.limit.answered('github.com', null, 'someone-else')
    expect(f.limit.retryAt('github.com', 'background')).toBeNull()
  })
  it('pauses until the reset after a primary limit, and logs only the event name', () => {
    const f = setup()
    f.limit.answered('github.com', { limit: 5000, remaining: 3, resetAt: f.at(900_000) }, 'me')
    const until = f.limit.limited('github.com', 'GraphQL: API rate limit exceeded for user ID 1.')
    expect(until).toBe(f.now() + 900_000)
    expect(f.limit.retryAt('github.com', 'user')).toBeNull()
    expect(f.events).toContain('github-rate-limited')
  })
})
