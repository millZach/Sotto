// @vitest-environment node
/**
 * The refusal when nothing is connected names the machine and what to do, and claims a saved draft only where
 * there is one (#459, ADR-0036). The host's own wording, and the desktop naming a host, are in
 * `tests/integration/hostProviderLookup.test.ts` and `desktopHostRouter.test.ts`.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentControl } from '../../../src/main/agents/control'
import { nameHostInRefusal, noProviderRefusal } from '../../../src/shared/agents'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import { manualSendCoordinator } from '../../fixtures/manualSendCoordinator'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const step of cleanup.splice(0)) await step() })

async function disconnectedDesktop(): Promise<AgentControl> {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-no-provider-'))
  const host = new FakeProviderHost()
  const control = await manualSendCoordinator(directory, host)
  cleanup.push(async () => { control.dispose(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  await control.start()
  // Connected once, so its threads are known, then lost.
  expect((await control.command({ type: 'connect' })).error).toBeFalsy()
  host.disconnect(); host.emit()
  expect(control.shell().host.connected).toBe(false)
  return control
}

describe('the refusal with no provider connected', () => {
  it('on the desktop names this computer and Settings → Providers, and keeps the draft only for a send', async () => {
    const control = await disconnectedDesktop()
    expect((await control.command({ type: 'manual-send', threadId: 'session-workshop', text: 'Reply' })).error)
      .toBe('No provider is connected on this computer. Connect one in Settings > Providers. Your draft is saved.')
    expect((await control.command({ type: 'create-project', title: 'Site', path: join(tmpdir(), 'site') })).error)
      .toBe('No provider is connected on this computer. Connect one in Settings > Providers.')
  })

  it('from a host says "this host", which the desktop replaces with the name it saved the host under', () => {
    expect(noProviderRefusal('host', true)).toBe('No provider is connected on this host. Connect one in Settings > Hosts & phones. Your draft is saved.')
    expect(nameHostInRefusal(noProviderRefusal('host', false), ' forge ')).toBe('No provider is connected on forge. Connect one in Settings > Hosts & phones.')
    // Anything else, and a host saved without a name, passes through as it is.
    expect(nameHostInRefusal('Codex did not confirm the connection.', 'forge')).toBe('Codex did not confirm the connection.')
    expect(nameHostInRefusal(noProviderRefusal('host', false), '  ')).toBe(noProviderRefusal('host', false))
  })

  it('from a host names it where a provider says "this machine", so a remote sign-in is never read as this computer’s', () => {
    expect(nameHostInRefusal('Could not connect Muse. Sign in to Muse on this machine with muse login, then connect it again.', 'forge'))
      .toBe('Could not connect Muse. Sign in to Muse on forge with muse login, then connect it again.')
    // A host name is text, never a replacement pattern.
    expect(nameHostInRefusal('Grok Build is not signed in on this machine.', 'lab $&')).toBe('Grok Build is not signed in on lab $&.')
  })
})
