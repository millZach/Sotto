// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { GitUnavailableError, type RunGitCommand } from '../../../../src/main/agents/git/gitStatus'
import { readGitHubSignIn } from '../../../../src/main/plugins/github/signIn'

/** A gh that answers each call from a list, in order, and keeps what it was asked. */
function gh(...answers: readonly (string | Error)[]) {
  const calls: (readonly string[])[] = []
  let next = 0
  const run: RunGitCommand = async (_cwd, command, args) => {
    if (command !== 'gh') throw new Error('only gh is asked')
    calls.push(args)
    const answer = answers[next++]
    if (answer === undefined) throw new Error('asked more than expected')
    if (answer instanceof Error) throw answer
    return answer
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

  it('says gh is not installed when it cannot be started', async () => {
    await expect(readGitHubSignIn(gh(new GitUnavailableError('gh is not installed')).run)).resolves.toEqual({ state: 'not-installed' })
  })

  it('reads an older gh’s words when it has no --json, and only the account’s name from them', async () => {
    const older = gh(new Error('unknown flag: --json'), 'github.com\n  ✓ Logged in to github.com account example-user (keyring)\n  - Token: gho_************\n')
    await expect(readGitHubSignIn(older.run)).resolves.toEqual({ state: 'signed-in', login: 'example-user' })
    expect(older.calls[1]).toEqual(['auth', 'status', '--hostname', 'github.com'])
    const oldest = gh(new Error('unknown flag: --json'), '✓ Logged in to github.com as example-user (oauth_token)')
    await expect(readGitHubSignIn(oldest.run)).resolves.toEqual({ state: 'signed-in', login: 'example-user' })
    const signedOut = gh(new Error('unknown flag: --json'), new Error('You are not logged into any GitHub hosts. To log in, run: gh auth login'))
    await expect(readGitHubSignIn(signedOut.run)).resolves.toEqual({ state: 'signed-out' })
  })

  it('says it could not tell, rather than signed out, when gh’s answer cannot be read', async () => {
    await expect(readGitHubSignIn(gh('not json').run)).resolves.toEqual({ state: 'unknown' })
    await expect(readGitHubSignIn(gh(new Error('timed out'), new Error('timed out')).run)).resolves.toEqual({ state: 'unknown' })
    // A name GitHub could not have issued is not shown as one.
    await expect(readGitHubSignIn(gh(hosts([{ active: true, login: '<b>not a name</b>', state: 'success' }])).run)).resolves.toEqual({ state: 'unknown' })
  })
})
