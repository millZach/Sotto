// @vitest-environment node
/**
 * The coordinator's answer to a Git command refused because something holds the folder (#1823): the host's words, and
 * on that reply alone the thread holding it, so the window can offer to open it.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentControl } from '../../../src/main/agents/control'
import { CheckoutHeldRefusal } from '../../../src/main/agents/checkoutMutations'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import { createAgentControl } from '../../fixtures/agentControlFixture'
import { testCredentials } from '../../fixtures/testCredentials'

const roots: string[] = []
const controls = new Set<AgentControl>()
afterEach(async () => {
  for (const control of controls) control.dispose()
  controls.clear()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-checkout-hold-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})

/** The fixture host, whose Git action is refused with whatever the test sets. */
class HeldHost extends E2EAgentHost {
  refusal: Error = new Error('Push failed.')
  async runGitAction(): Promise<never> { throw this.refusal }
}

async function start() {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-checkout-hold-')); roots.push(directory)
  const host = new HeldHost()
  const control = createAgentControl({ directory, host, credentials: await testCredentials(directory, { mode: 'unavailable' }) })
  controls.add(control)
  await control.start()
  if (!control.get().host.connected) await control.command({ type: 'connect' })
  return { host, control }
}

const press = { type: 'git-action', threadId: 'workshop', actionId: 'press', action: 'commit' } as const

it('names the thread holding the folder on the refusal\'s reply, both shell and whole, and on no later one', async () => {
  const { host, control } = await start()
  const words = 'Thread "Docs" is waiting for your answer. Nothing was changed. Answer it, then try again.'
  host.refusal = new CheckoutHeldRefusal(words, 'docs')
  const shell = await control.commandShell(press)
  expect(shell.error).toBe(words)
  expect(shell.checkoutHold).toEqual({ threadId: 'docs' })
  expect((await control.command({ ...press, actionId: 'again' })).checkoutHold).toEqual({ threadId: 'docs' })
  expect(control.get().checkoutHold).toBeUndefined()
  // Held by Sotto itself: a hold with no thread. A refusal that is no hold names nothing.
  host.refusal = new CheckoutHeldRefusal('Sotto is pulling this folder. Nothing was changed. Try again in a moment.', undefined)
  expect((await control.commandShell({ ...press, actionId: 'pull' })).checkoutHold).toEqual({})
  host.refusal = new Error('Push failed.')
  const failed = await control.commandShell({ ...press, actionId: 'push' })
  expect(failed.error).toBe('Push failed.')
  expect(failed.checkoutHold).toBeUndefined()
})
