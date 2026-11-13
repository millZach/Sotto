// @vitest-environment node
import { expect, it } from 'vitest'
import { readHostGitHubSignIns, type SignInComputer, type SignInTarget } from '../../../../src/main/plugins/hostSignIns'
import type { GitHubSignIn } from '../../../../src/shared/plugins'

/** A connected host, and how its gh answers. Made-up logins: nothing here is a real account. */
const target = (hostId: string, answer: GitHubSignIn | Error | 'no-plugins', kind: 'local' | 'remote' = 'remote'): SignInTarget & { asked: number } => {
  const made = { hostId, kind, asked: 0, service: answer === 'no-plugins' ? {} : {
    supportsPluginGitHubSignIn: true,
    pluginGitHubSignIn: async () => { made.asked += 1; if (answer instanceof Error) throw answer; return answer },
  } }
  return made
}
const computer = (name: string, connected = true): SignInComputer => ({ id: `saved-${name}`, name, hostId: `host-${name}`, connected })

it('asks each connected computer’s own gh, and says why another cannot be asked', async () => {
  const forge = target('host-forge', { state: 'signed-in', login: 'host-user' })
  const anvil = target('host-anvil', { state: 'signed-out' })
  const stable = target('host-stable', 'no-plugins')
  const silent = target('host-silent', new Error('The host did not answer.'))
  const away = target('host-away', { state: 'signed-in', login: 'never-asked' })
  const saved = [computer('forge'), computer('anvil'), computer('stable'), computer('silent'), computer('away', false), { id: 'saved-new', name: 'new', connected: true }]
  await expect(readHostGitHubSignIns(saved, [forge, anvil, stable, silent, away])).resolves.toEqual([
    { computerId: 'saved-forge', name: 'forge', state: 'signed-in', login: 'host-user' },
    { computerId: 'saved-anvil', name: 'anvil', state: 'signed-out' },
    // Its Sotto runs no plugin tools: it is asked nothing.
    { computerId: 'saved-stable', name: 'stable', state: 'no-plugins' },
    // One that does not answer is not said to be signed out.
    { computerId: 'saved-silent', name: 'silent', state: 'unknown' },
    // One that is away, or has never connected, cannot be asked.
    { computerId: 'saved-away', name: 'away', state: 'away' },
    { computerId: 'saved-new', name: 'new', state: 'away' },
  ])
  expect([forge.asked, anvil.asked, away.asked]).toEqual([1, 1, 0])
})

it('asks no host this computer has not saved, and never this computer’s own host', async () => {
  const stranger = target('host-stranger', { state: 'signed-in', login: 'not-asked' })
  const here = target('host-forge', { state: 'signed-in', login: 'not-asked' }, 'local')
  await expect(readHostGitHubSignIns([computer('forge')], [stranger, here])).resolves.toEqual([{ computerId: 'saved-forge', name: 'forge', state: 'away' }])
  expect([stranger.asked, here.asked]).toEqual([0, 0])
})
