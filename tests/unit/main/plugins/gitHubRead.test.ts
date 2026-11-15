// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { GitUnavailableError, type RunGitCommand } from '../../../../src/main/agents/git/gitStatus'
import { GITHUB_READ_MAX_CHARS, gitHubReadKind, gitHubReadRefusal, readGitHub } from '../../../../src/main/plugins/github/read'

function gh(answer: string | Error) {
  const calls: (readonly string[])[] = []
  const run: RunGitCommand = async (_cwd, command, args) => {
    if (command !== 'gh') throw new Error('only gh is asked')
    calls.push(args)
    if (answer instanceof Error) throw answer
    return answer
  }
  return { run, calls }
}

describe('reading GitHub through gh (ADR-0205)', () => {
  it('asks gh for a GET on github.com with raw fields, and nothing else', async () => {
    const f = gh('[{"number":12}]')
    await expect(readGitHub(f.run, 'repos/example-owner/example-repo/issues', { state: 'open', per_page: '5' })).resolves.toEqual({ ok: true, text: '[{"number":12}]', truncated: false })
    expect(f.calls).toEqual([['api', '--method', 'GET', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json',
      'repos/example-owner/example-repo/issues', '-f', 'state=open', '-f', 'per_page=5']])
    // A typed field would let a value name a file for gh to read.
    expect(f.calls[0]).not.toContain('-F')
  })

  it.each([
    ['/repos/a/b', 'a leading slash'],
    ['-X', 'an option of gh’s'],
    ['--method=POST', 'an option of gh’s'],
    ['repos/{owner}/{repo}/issues', 'a placeholder gh would fill from a folder'],
    ['repos/:owner/:repo/issues', 'the older spelling of that placeholder'],
    ['repos/a/b/issues?state=open', 'a query in the path'],
    ['repos/a/../../user', 'a path that climbs'],
    ['repos/a/%2E%2E/%2e%2e/user', 'a path that climbs, spelled with percent signs'],
    ['repos/a/b%2Fsecret-scanning%2Falerts', 'a slash spelled with percent signs'],
    ['repos/a/b/%ZZ', 'a percent sign that spells nothing'],
    ['https://example.com/x', 'another host'],
    ['repos/a/b issues', 'a space'],
    ['', 'nothing'],
  ])('refuses %j (%s) before gh is asked', async (path) => {
    const f = gh('never read')
    expect(gitHubReadRefusal(path, {})).toBe('path')
    await expect(readGitHub(f.run, path)).resolves.toEqual({ ok: false, reason: 'path' })
    expect(f.calls).toEqual([])
  })

  it('refuses GraphQL, which takes a POST, and a query that is not plain names and text', async () => {
    const f = gh('never read')
    await expect(readGitHub(f.run, 'graphql')).resolves.toEqual({ ok: false, reason: 'graphql' })
    await expect(readGitHub(f.run, 'user', { '-F': 'x' })).resolves.toEqual({ ok: false, reason: 'query' })
    await expect(readGitHub(f.run, 'user', { q: 'line\nbreak' })).resolves.toEqual({ ok: false, reason: 'query' })
    await expect(readGitHub(f.run, 'user', Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`p${index}`, '1'])))).resolves.toEqual({ ok: false, reason: 'query' })
    expect(f.calls).toEqual([])
    // A value that starts like a file reference is only text to a raw field.
    const at = gh('{}')
    await readGitHub(at.run, 'search/issues', { q: '@me is:open' })
    expect(at.calls[0]!.slice(-2)).toEqual(['-f', 'q=@me is:open'])
  })

  it.each([
    'repos/example-owner/example-repo/secret-scanning/alerts',
    'repos/example-owner/example-repo/secret-scanning/alerts/3',
    'repos/example-owner/example-repo/secret-scanning/alerts/3/locations',
    'orgs/example-org/secret-scanning/alerts',
    'enterprises/example-enterprise/secret-scanning/alerts',
    'repos/example-owner/example-repo/Secret-Scanning/alerts',
    'repos/example-owner/example-repo/secret%2Dscanning/alerts',
  ])('refuses %s, which hands back other credentials, before gh is asked', async (path) => {
    const f = gh('never read')
    await expect(readGitHub(f.run, path)).resolves.toEqual({ ok: false, reason: 'secrets' })
    expect(f.calls).toEqual([])
  })

  it('still reads a path that only mentions secrets by name, such as the names of Actions secrets', async () => {
    const f = gh('{"total_count":0,"secrets":[]}')
    await expect(readGitHub(f.run, 'repos/example-owner/example-repo/actions/secrets')).resolves.toMatchObject({ ok: true })
    await expect(readGitHub(f.run, 'repos/example-owner/example-repo/labels/needs%20triage')).resolves.toMatchObject({ ok: true })
  })

  it('cuts a long answer and says so', async () => {
    const result = await readGitHub(gh('x'.repeat(GITHUB_READ_MAX_CHARS + 10)).run, 'user')
    expect(result).toEqual({ ok: true, text: 'x'.repeat(GITHUB_READ_MAX_CHARS), truncated: true })
    // A character that takes two halves is never cut between them.
    const emoji = await readGitHub(gh('x'.repeat(GITHUB_READ_MAX_CHARS - 1) + '\u{1F989}' + 'tail').run, 'user')
    expect(emoji).toEqual({ ok: true, text: 'x'.repeat(GITHUB_READ_MAX_CHARS - 1), truncated: true })
  })

  it('tells a missing gh, a signed-out gh and GitHub’s own refusal apart', async () => {
    await expect(readGitHub(gh(new GitUnavailableError('gh is not installed')).run, 'user')).resolves.toEqual({ ok: false, reason: 'not-installed' })
    await expect(readGitHub(gh(new Error('To get started with GitHub CLI, please run:  gh auth login')).run, 'user')).resolves.toEqual({ ok: false, reason: 'signed-out' })
    await expect(readGitHub(gh(new Error('gh: Not Found (HTTP 404)\n{"message":"Not Found"}')).run, 'repos/a/b')).resolves.toEqual({ ok: false, reason: 'failed', said: 'gh: Not Found (HTTP 404)' })
    await expect(readGitHub(gh(new Error('gh timed out')).run, 'user')).resolves.toEqual({ ok: false, reason: 'failed' })
  })

  it('names the kind of thing a path reads, never which one', () => {
    expect(gitHubReadKind('repos/example-owner/example-repo/issues/12/comments')).toBe('issues')
    expect(gitHubReadKind('repos/example-owner/example-repo/pulls')).toBe('pull-requests')
    expect(gitHubReadKind('repos/example-owner/example-repo')).toBe('repository')
    expect(gitHubReadKind('repos/example-owner/example-repo/commits/abc')).toBe('commits')
    expect(gitHubReadKind('repos/example-owner/example-repo/commits/abc/check-runs')).toBe('checks')
    expect(gitHubReadKind('repos/example-owner/example-repo/commits/abc/status')).toBe('checks')
    // A part spelled with percent signs is named as what it spells, as it is checked.
    expect(gitHubReadKind('repo%73/example-owner/example-repo/issue%73')).toBe('issues')
    expect(gitHubReadKind('repos/example-owner/example-repo/actions/runs')).toBe('checks')
    expect(gitHubReadKind('repos/example-owner/example-repo/releases/latest')).toBe('releases')
    expect(gitHubReadKind('search/issues')).toBe('search')
    expect(gitHubReadKind('user')).toBe('account')
    expect(gitHubReadKind('rate_limit')).toBe('other')
  })
})
