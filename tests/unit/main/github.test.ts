// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { baseRepository, GitHubHosts, GitHubRateLimit, isOwnHead, isRateLimitAnswer, parseGitHubRemote, readGitHubRemotes, type GitHubRateLimitEvent } from '../../../src/main/agents/github'
import type { RunGitCommand } from '../../../src/main/agents/gitStatus'

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
  it('reads an SSH alias for github.com, and the port-443 SSH host, as github.com', () => {
    expect(parseGitHubRemote('git@github-work:me/repo.git')).toEqual({ host: 'github.com', owner: 'me', name: 'repo' })
    expect(parseGitHubRemote('git@github.com-work:me/repo.git')).toEqual({ host: 'github.com', owner: 'me', name: 'repo' })
    expect(parseGitHubRemote('ssh://git@ssh.github.com:443/me/repo.git')).toEqual({ host: 'github.com', owner: 'me', name: 'repo' })
    expect(parseGitHubRemote('git@github.company.com:me/repo.git')).toEqual({ host: 'github.company.com', owner: 'me', name: 'repo' })
    expect(parseGitHubRemote('git@gitlab-work:me/repo.git')).toBeNull()
  })
})

describe('the repository gh reads pull requests from', () => {
  const remotes = (...entries: [string, string, string?][]) => new Map(entries.map(([name, url, ghResolved]) => [name, { repository: parseGitHubRemote(url), ghResolved: ghResolved ?? null }]))
  it('takes the remote gh repo set-default marked over the others', () => {
    expect(baseRepository(remotes(['origin', 'https://github.com/me/fork'], ['upstream', 'https://github.com/them/repo', 'base']))).toMatchObject({ owner: 'them', name: 'repo' })
    expect(baseRepository(remotes(['upstream', 'https://github.com/them/repo'], ['origin', 'https://github.com/me/fork', 'base']))).toMatchObject({ owner: 'me', name: 'fork' })
  })
  it('reads a mark that names another repository on the host of the marked remote', () => {
    expect(baseRepository(remotes(['origin', 'git@github-work:me/fork.git', 'them/repo']))).toEqual({ host: 'github.com', owner: 'them', name: 'repo' })
    expect(baseRepository(remotes(['origin', 'https://github.example.com/me/fork', 'github.example.com/them/repo']))).toEqual({ host: 'github.example.com', owner: 'them', name: 'repo' })
  })
  it('without a mark, takes upstream, then github, then origin, then the first remote, as gh does', () => {
    expect(baseRepository(remotes(['origin', 'https://github.com/me/fork'], ['upstream', 'https://github.com/them/repo']))).toMatchObject({ owner: 'them', name: 'repo' })
    expect(baseRepository(remotes(['origin', 'https://github.com/me/fork'], ['GitHub', 'https://github.com/them/repo']))).toMatchObject({ owner: 'them', name: 'repo' })
    expect(baseRepository(remotes(['mine', 'https://github.com/me/other'], ['origin', 'https://github.com/me/fork']))).toMatchObject({ owner: 'me', name: 'fork' })
    expect(baseRepository(remotes(['mine', 'https://github.com/me/other'], ['theirs', 'https://github.com/them/repo']))).toMatchObject({ owner: 'me', name: 'other' })
    expect(baseRepository(remotes(['upstream', 'https://gitlab.com/them/repo'], ['origin', 'https://github.com/me/fork']))).toMatchObject({ owner: 'me', name: 'fork' })
    expect(baseRepository(remotes(['origin', 'C:/remotes/owned.git']))).toBeNull()
  })
})

describe('the hosts gh asks as GitHub', () => {
  const setup = (options: { signedIn?: string[]; json?: boolean; aliases?: Record<string, string> } = {}) => {
    let now = 1_000_000
    const calls: string[][] = []
    const aliasLookups: string[] = []
    const run: RunGitCommand = async (_cwd, command, args) => {
      calls.push([command, ...args])
      if (command !== 'gh' || args[0] !== 'auth') throw new Error('unexpected')
      const hosts = options.signedIn ?? []
      if (args.includes('--json')) { if (options.json === false) throw new Error('unknown flag: --json'); return hosts.map(host => `${host}\n`).join('') }
      // An older gh words it for a person, on its error output when any host has a problem.
      throw Object.assign(new Error(hosts.map(host => `${host}\n  X Failed to log in to other.example\n  \u2713 Logged in to ${host} as me (oauth_token)\n  \u2713 Token: gho_****`).join('\n')), { stdout: '' })
    }
    const hosts = new GitHubHosts({ run, now: () => now, sshHostName: async alias => { aliasLookups.push(alias); return options.aliases?.[alias] ?? alias } })
    return { hosts, calls, aliasLookups, advance: (ms: number) => { now += ms } }
  }
  it('takes a host gh is signed in to, an Enterprise server on its own domain or a GHE.com host, and no other', async () => {
    const f = setup({ signedIn: ['github.com', 'git.company.com', 'octocorp.ghe.com'] })
    expect(await f.hosts.repository('https://git.company.com/team/app.git')).toEqual({ host: 'git.company.com', owner: 'team', name: 'app' })
    expect(await f.hosts.repository('https://octocorp.ghe.com/team/app')).toEqual({ host: 'octocorp.ghe.com', owner: 'team', name: 'app' })
    expect(await f.hosts.repository('https://gitlab.com/team/app.git')).toBeNull()
    // Asked once, then kept: a GitLab remote on every read costs no more gh.
    expect(f.calls.filter(call => call[1] === 'auth')).toHaveLength(1)
    f.advance(10 * 60_000)
    await f.hosts.repository('https://gitlab.com/team/app.git')
    expect(f.calls.filter(call => call[1] === 'auth')).toHaveLength(2)
  })
  it('asks nothing for github.com, a host named for GitHub or a local path', async () => {
    const f = setup()
    expect(await f.hosts.repository('https://github.com/me/repo')).toEqual({ host: 'github.com', owner: 'me', name: 'repo' })
    expect(await f.hosts.repository('git@github.com:me/repo.git')).toEqual({ host: 'github.com', owner: 'me', name: 'repo' })
    expect(await f.hosts.repository('https://github.example.com/me/repo')).toEqual({ host: 'github.example.com', owner: 'me', name: 'repo' })
    expect(await f.hosts.repository('C:/remotes/owned.git')).toBeNull()
    expect(f.calls).toEqual([])
    expect(f.aliasLookups).toEqual([])
  })
  it('reads an SSH alias through ~/.ssh/config, as gh does', async () => {
    const f = setup({ signedIn: ['git.company.com'], aliases: { work: 'github.com', office: 'git.company.com', 'github-ghe': 'github.company.com' } })
    expect(await f.hosts.repository('git@work:me/repo.git')).toEqual({ host: 'github.com', owner: 'me', name: 'repo' })
    expect(await f.hosts.repository('ssh://git@office/team/app.git')).toEqual({ host: 'git.company.com', owner: 'team', name: 'app' })
    // An alias whose name says GitHub but that SSH sends to an Enterprise server is that server.
    expect(await f.hosts.repository('git@github-ghe:team/app.git')).toEqual({ host: 'github.company.com', owner: 'team', name: 'app' })
    // One SSH has no alias for keeps the name rule.
    expect(await f.hosts.repository('git@github-personal:me/repo.git')).toEqual({ host: 'github.com', owner: 'me', name: 'repo' })
    expect(await f.hosts.repository('git@gitlab-work:me/repo.git')).toBeNull()
  })
  it('reads an older gh that has no JSON for its status, host names only', async () => {
    const f = setup({ signedIn: ['git.company.com'], json: false })
    expect(await f.hosts.repository('https://git.company.com/team/app.git')).toEqual({ host: 'git.company.com', owner: 'team', name: 'app' })
    expect(await f.hosts.repository('https://other.example/team/app.git')).toBeNull()
  })
  it('names each remote of a folder by the repository gh would read', async () => {
    const f = setup({ signedIn: ['git.company.com'] })
    const run: RunGitCommand = async () => 'remote.origin.url https://git.company.com/me/app.git\nremote.upstream.url https://git.company.com/team/app.git\nremote.upstream.gh-resolved base\nremote.mirror.url https://gitlab.com/team/app.git\n'
    const remotes = await readGitHubRemotes(run, 'C:/work/app', f.hosts)
    expect(remotes.get('mirror')).toEqual({ repository: null, ghResolved: null })
    expect(baseRepository(remotes)).toEqual({ host: 'git.company.com', owner: 'team', name: 'app' })
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
    // A repository or branch with the words in its name, named in another error, is not a refusal.
    expect(isRateLimitAnswer("GraphQL: Could not resolve to a Repository with the name 'me/rate-limit'. (repository)")).toBe(false)
    expect(isRateLimitAnswer('fatal: could not find remote ref feature/rate-limit-banner')).toBe(false)
  })
})

describe('whose head a pull request has', () => {
  it('is the branch\'s own only in the repository the branch is pushed to, whatever the case of the owner', () => {
    const pushedToBase = { owner: 'Sotto-Fixture', crossRepository: false }
    expect(isOwnHead({ owner: 'sotto-fixture', crossRepository: false }, pushedToBase)).toBe(true)
    // A fork's branch of the same name: another owner, and another repository than the base.
    expect(isOwnHead({ owner: 'someone', crossRepository: true }, pushedToBase)).toBe(false)
    // The owner's own fork of a repository it also owns is still another repository.
    expect(isOwnHead({ owner: 'sotto-fixture', crossRepository: true }, pushedToBase)).toBe(false)
    expect(isOwnHead({ owner: null, crossRepository: false }, pushedToBase)).toBe(false)
    // A triangular branch pushed to the user's fork finds the pull request it opened against the base.
    expect(isOwnHead({ owner: 'me', crossRepository: true }, { owner: 'me', crossRepository: true })).toBe(true)
  })
})

describe('the rate limit of a sign-in', () => {
  const setup = () => {
    let now = 1_000_000
    const events: GitHubRateLimitEvent[] = []
    const limit = new GitHubRateLimit({ now: () => now, log: event => events.push(event) })
    return { limit, events, advance: (ms: number) => { now += ms }, at: (ms: number) => new Date(now + ms).toISOString(), now: () => now }
  }
  it('holds the timer back below the reserve and lets the user through, until the reset', () => {
    const f = setup()
    f.limit.answered('github.com', f.limit.asking(), { limit: 5000, remaining: 499, resetAt: f.at(600_000) }, 'me')
    expect(f.limit.retryAt('github.com', 'background')).toBe(f.now() + 600_000)
    expect(f.limit.retryAt('github.com', 'user')).toBeNull()
    expect(f.limit.retryAt('ghe.example.com', 'background')).toBeNull() // another host is another rate limit
    expect(f.events).toEqual(['github-reserve-reached'])
    f.advance(600_001)
    expect(f.limit.retryAt('github.com', 'background')).toBeNull()
  })
  it('refuses even the user once GitHub reports nothing left, until the reset', () => {
    const f = setup()
    f.limit.answered('github.com', f.limit.asking(), { limit: 5000, remaining: 0, resetAt: f.at(60_000) }, 'me')
    expect(f.limit.retryAt('github.com', 'user')).toBe(f.now() + 60_000)
  })
  it('forgets the reading of a sign-in that is no longer the one gh uses', () => {
    const f = setup()
    f.limit.answered('github.com', f.limit.asking(), { limit: 5000, remaining: 10, resetAt: f.at(600_000) }, 'me')
    f.limit.answered('github.com', f.limit.asking(), null, 'someone-else')
    expect(f.limit.retryAt('github.com', 'background')).toBeNull()
  })
  it('pauses until the reset after a primary limit, and logs only the event name', () => {
    const f = setup()
    f.limit.answered('github.com', f.limit.asking(), { limit: 5000, remaining: 3, resetAt: f.at(900_000) }, 'me')
    const until = f.limit.limited('github.com', 'GraphQL: API rate limit exceeded for user ID 1.')
    expect(until).toBe(f.now() + 900_000)
    expect(f.limit.retryAt('github.com', 'user')).toBeNull()
    expect(f.events).toContain('github-rate-limited')
  })
})
