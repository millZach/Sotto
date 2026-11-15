// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { GitUnavailableError, type RunGitCommand } from '../../../../src/main/agents/git/gitStatus'
import { readGitHubSignIn, sharedGitHubSignIn } from '../../../../src/main/plugins/github/signIn'
import type { GitHubSignIn } from '../../../../src/shared/plugins'
import { deferred } from '../../../fixtures/deferred'

/** What gh printed on its error stream while ending well, as an older gh prints a good status. */
const onStderr = (text: string) => ({ stderr: text })

/** A gh that answers each call from a list, in order, and keeps what it was asked. */
function gh(...answers: readonly (string | Error | { readonly stderr: string })[]) {
  const calls: (readonly string[])[] = []
  let next = 0
  const run: RunGitCommand = async (_cwd, command, args, options) => {
    if (command !== 'gh') throw new Error('only gh is asked')
    calls.push(args)
    const answer = answers[next++]
    if (answer === undefined) throw new Error('asked more than expected')
    if (answer instanceof Error) throw answer
    if (typeof answer === 'string') return answer
    // The runner hands back standard output alone; the other stream reaches a caller only line by line.
    for (const line of answer.stderr.split('\n')) options?.onLine?.(line, 'stderr')
    return ''
  }
  return { run, calls }
}

const hosts = (accounts: readonly object[], host = 'github.com'): string => JSON.stringify({ hosts: { [host]: accounts } })

describe('who gh is signed in to github.com as (ADR-0205)', () => {
  it('reads the active account’s name, asks for github.com alone and never for a token', async () => {
    const f = gh(hosts([
      { active: false, login: 'older-account', state: 'success' },
      { active: true, login: 'example-user', state: 'success' },
    ]))
    await expect(readGitHubSignIn(f.run)).resolves.toEqual({ state: 'signed-in', login: 'example-user' })
    expect(f.calls).toEqual([['auth', 'status', '--hostname', 'github.com', '--json', 'hosts']])
    expect(f.calls.flat()).not.toContain('--show-token')
  })

  it('says signed out when gh has no good sign-in to github.com', async () => {
    await expect(readGitHubSignIn(gh(hosts([])).run)).resolves.toEqual({ state: 'signed-out' })
    await expect(readGitHubSignIn(gh(JSON.stringify({ hosts: {} })).run)).resolves.toEqual({ state: 'signed-out' })
    await expect(readGitHubSignIn(gh(hosts([{ active: true, login: 'example-user', state: 'error' }])).run)).resolves.toEqual({ state: 'signed-out' })
    await expect(readGitHubSignIn(gh(hosts([{ active: true, login: 'example-user', state: 'success' }], 'ghe.example.com')).run)).resolves.toEqual({ state: 'signed-out' })
  })

  it('reads the account gh acts as, not a good older sign-in listed beside a failing one', async () => {
    const refused = gh(hosts([{ active: true, login: 'current-user', state: 'error' }, { active: false, login: 'older-account', state: 'success' }]))
    await expect(readGitHubSignIn(refused.run)).resolves.toEqual({ state: 'signed-out' })
    // No account marked active among several: gh's answer does not say who it acts as.
    const unmarked = gh(hosts([{ login: 'one-user', state: 'success' }, { login: 'other-user', state: 'success' }]))
    await expect(readGitHubSignIn(unmarked.run)).resolves.toEqual({ state: 'unknown' })
  })

  it('says it could not tell, not signed out, when gh could not reach GitHub to check the sign-in', async () => {
    await expect(readGitHubSignIn(gh(hosts([{ active: true, login: 'example-user', state: 'timeout' }])).run)).resolves.toEqual({ state: 'unknown' })
  })

  it('says signed out for a sign-in gh has already removed because it could not be renewed', async () => {
    await expect(readGitHubSignIn(gh(hosts([{ active: true, login: 'example-user', state: 'refresh_expired' }])).run)).resolves.toEqual({ state: 'signed-out' })
  })

  it('asks gh once when it fails for a reason other than being too old for --json', async () => {
    const hung = gh(new Error('gh timed out after 15000 ms'))
    await expect(readGitHubSignIn(hung.run)).resolves.toEqual({ state: 'unknown' })
    expect(hung.calls).toHaveLength(1)
    const signedOut = gh(new Error('You are not logged into any accounts on github.com'))
    await expect(readGitHubSignIn(signedOut.run)).resolves.toEqual({ state: 'signed-out' })
    expect(signedOut.calls).toHaveLength(1)
  })

  it('reads the account an older gh marks active when it keeps several, as the --json answer is read', async () => {
    const several = (active: string, older: string): string => `github.com\n  ${active}\n  - Active account: true\n  - Git operations protocol: https\n\n  ${older}\n  - Active account: false\n`
    const failing = gh(new Error('unknown flag: --json'), new Error(several('X Failed to log in to github.com account current-user (keyring)', '\u2713 Logged in to github.com account older-account (keyring)')))
    await expect(readGitHubSignIn(failing.run)).resolves.toEqual({ state: 'signed-out' })
    const good = gh(new Error('unknown flag: --json'), several('\u2713 Logged in to github.com account current-user (keyring)', 'X Failed to log in to github.com account older-account (keyring)'))
    await expect(readGitHubSignIn(good.run)).resolves.toEqual({ state: 'signed-in', login: 'current-user' })
    const slow = gh(new Error('unknown flag: --json'), new Error(several('X Timeout trying to log in to github.com account current-user (keyring)', '\u2713 Logged in to github.com account older-account (keyring)')))
    await expect(readGitHubSignIn(slow.run)).resolves.toEqual({ state: 'unknown' })
  })

  it('says gh is not installed when it cannot be started', async () => {
    await expect(readGitHubSignIn(gh(new GitUnavailableError('gh is not installed')).run)).resolves.toEqual({ state: 'not-installed' })
  })

  it('reads an older gh’s words when it has no --json, and only the account’s name from them', async () => {
    const older = gh(new Error('unknown flag: --json'), 'github.com\n  ✓ Logged in to github.com account example-user (keyring)\n  - Token: gho_************\n')
    await expect(readGitHubSignIn(older.run)).resolves.toEqual({ state: 'signed-in', login: 'example-user' })
    expect(older.calls[1]).toEqual(['auth', 'status', '--hostname', 'github.com'])
    const oldest = gh(new Error('unknown flag: --json'), '✓ Logged in to github.com as example-user (oauth_token)')
    await expect(readGitHubSignIn(oldest.run)).resolves.toEqual({ state: 'signed-in', login: 'example-user' })
    // gh 2.0 prints a good status on its error stream and ends well, so standard output is empty.
    const onErrorStream = gh(new Error('unknown flag: --json'), onStderr('github.com\n  \u2713 Logged in to github.com as example-user (oauth_token)\n  \u2713 Token: *******************'))
    await expect(readGitHubSignIn(onErrorStream.run)).resolves.toEqual({ state: 'signed-in', login: 'example-user' })
    const signedOut = gh(new Error('unknown flag: --json'), new Error('You are not logged into any GitHub hosts. To log in, run: gh auth login'))
    await expect(readGitHubSignIn(signedOut.run)).resolves.toEqual({ state: 'signed-out' })
  })

  it('says it could not tell, rather than signed out, when gh’s answer cannot be read', async () => {
    await expect(readGitHubSignIn(gh('not json').run)).resolves.toEqual({ state: 'unknown' })
    await expect(readGitHubSignIn(gh(new Error('unknown flag: --json'), new Error('timed out')).run)).resolves.toEqual({ state: 'unknown' })
    // A name GitHub could not have issued is not shown as one.
    await expect(readGitHubSignIn(gh(hosts([{ active: true, login: '<b>not a name</b>', state: 'success' }])).run)).resolves.toEqual({ state: 'unknown' })
  })
})

describe('reads of gh’s sign-in asked for at once', () => {
  it('share one read while it runs, and start another once it has answered', async () => {
    const first = deferred<GitHubSignIn>()
    let started = 0
    const read = sharedGitHubSignIn(() => { started += 1; return started === 1 ? first.promise : Promise.resolve({ state: 'signed-out' }) })
    const one = read(), two = read()
    expect(started).toBe(1)
    first.resolve({ state: 'signed-in', login: 'example-user' })
    await expect(one).resolves.toEqual({ state: 'signed-in', login: 'example-user' })
    await expect(two).resolves.toEqual({ state: 'signed-in', login: 'example-user' })
    await expect(read()).resolves.toEqual({ state: 'signed-out' })
    expect(started).toBe(2)
  })
})
