// @vitest-environment node
import { expect, it } from 'vitest'
import { readHostGitHubSignIns, type SignInComputer, type SignInTarget } from '../../../../src/main/plugins/hostSignIns'
import type { GitHubSignIn } from '../../../../src/shared/plugins'

/**
 * A connected host, and how its gh answers. `no-plugins` is a host that runs no plugin tools; `before-the-read` is one
 * that runs them, and keeps account copies, on a Sotto from before it could say whose gh that is. Made-up logins.
 */
const target = (hostId: string, answer: GitHubSignIn | Error | 'no-plugins' | 'before-the-read', kind: 'local' | 'remote' = 'remote'): SignInTarget & { asked: number } => {
  const made = { hostId, kind, asked: 0, service: answer === 'no-plugins' ? {} : answer === 'before-the-read' ? { supportsPluginAccountCopies: true } : {
    supportsPluginGitHubSignIn: true, supportsPluginAccountCopies: true,
    pluginGitHubSignIn: async () => { made.asked += 1; if (answer instanceof Error) throw answer; return answer },
  } }
  return made
}
const computer = (name: string, connected = true): SignInComputer => ({ id: `saved-${name}`, name, hostId: `host-${name}`, connected })

it('asks each connected computer’s own gh, and says why another cannot be asked', async () => {
  const forge = target('host-forge', { state: 'signed-in', login: 'host-user' })
  const anvil = target('host-anvil', { state: 'signed-out' })
  const stable = target('host-stable', 'no-plugins')
  const older = target('host-older', 'before-the-read')
  const silent = target('host-silent', new Error('The host did not answer.'))
  const away = target('host-away', { state: 'signed-in', login: 'never-asked' })
  const saved = [computer('forge'), computer('anvil'), computer('stable'), computer('older'), computer('silent'), computer('away', false), { id: 'saved-new', name: 'new', connected: true }]
  await expect(readHostGitHubSignIns(saved, () => [forge, anvil, stable, older, silent, away])).resolves.toEqual([
    { computerId: 'saved-forge', name: 'forge', state: 'signed-in', login: 'host-user' },
    { computerId: 'saved-anvil', name: 'anvil', state: 'signed-out' },
    // Its Sotto runs no plugin tools: it is asked nothing, and its threads do not use GitHub through Sotto.
    { computerId: 'saved-stable', name: 'stable', state: 'no-plugins' },
    // Its Sotto runs plugin tools and is from before it could be asked: its threads still use its own gh.
    { computerId: 'saved-older', name: 'older', state: 'too-old' },
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
  await expect(readHostGitHubSignIns([computer('forge')], () => [stranger, here])).resolves.toEqual([{ computerId: 'saved-forge', name: 'forge', state: 'away' }])
  expect([stranger.asked, here.asked]).toEqual([0, 0])
})

it('asks again on the connection that took the place of one a read was cut off on, as a move to the tailnet does', async () => {
  // The read is on the SSH connection when the host moves to its tailnet: the old connection closes, and the read fails.
  const tailnet = target('host-forge', { state: 'signed-in', login: 'host-user' })
  let current: SignInTarget
  const ssh: SignInTarget = { hostId: 'host-forge', kind: 'remote', service: {
    supportsPluginGitHubSignIn: true,
    pluginGitHubSignIn: async () => { current = tailnet; throw new Error('The connection closed.') },
  } }
  current = ssh
  await expect(readHostGitHubSignIns([computer('forge')], () => [current])).resolves.toEqual([{ computerId: 'saved-forge', name: 'forge', state: 'signed-in', login: 'host-user' }])
  expect(tailnet.asked).toBe(1)

  // A host that does not answer on the connection it has is asked once, not again and again.
  const silent = target('host-forge', new Error('The host did not answer.'))
  await expect(readHostGitHubSignIns([computer('forge')], () => [silent])).resolves.toEqual([{ computerId: 'saved-forge', name: 'forge', state: 'unknown' }])
  expect(silent.asked).toBe(1)
  // And one that has gone by then is not asked at all.
  const gone: SignInTarget = { hostId: 'host-forge', kind: 'remote', service: { supportsPluginGitHubSignIn: true, pluginGitHubSignIn: async () => { left = true; throw new Error('The connection closed.') } } }
  let left = false
  await expect(readHostGitHubSignIns([computer('forge')], () => left ? [] : [gone])).resolves.toEqual([{ computerId: 'saved-forge', name: 'forge', state: 'unknown' }])
})
