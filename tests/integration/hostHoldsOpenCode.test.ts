// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

// Until hosts and phones take OpenCode (#1107), a host holds it whatever its Owl answers are, so a desktop or phone that
// does not know the provider never reads it in a host's state. #1107 lifts this by adding OpenCode to HOST_PROVIDERS.
it.each([['stable', '0.1.37'], ['Owl', '0.1.37-owl.20261012.1']])('a headless host on %s starts no OpenCode and names none in its state', async (_track, sottoVersion) => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-host-opencode-'))
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const providers = { codex: new FakeProviderHost(), claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost(), muse: new FakeProviderHost(), opencode: new FakeProviderHost() }
  const host = await startHeadlessHost({ dataDirectory: root, providers, reasoner: {}, sottoVersion })
  cleanup.push(host.close)
  await expect.poll(() => host.service.shell().host.providers?.find(provider => provider.id === 'codex')?.connection).toBe('connected')
  // On Owl the host's own Owl answers are in force: Muse, held beside OpenCode on stable, starts there.
  if (sottoVersion.includes('owl')) await expect.poll(() => providers.muse.connectCalls).toBe(1)
  expect(providers.opencode.connectCalls).toBe(0)
  const shell = host.service.shell()
  expect(shell.configuration.enabledProviders ?? []).not.toContain('opencode')
  expect(shell.host.providers?.map(provider => provider.id)).not.toContain('opencode')
  expect(shell.host.models.some(model => model.providerId === 'opencode')).toBe(false)
  expect(shell.host.threads.some(thread => thread.providerId === 'opencode')).toBe(false)
  // Nothing in the state names it, so an older peer's provider schema never meets it.
  expect(JSON.stringify(shell)).not.toContain('"opencode"')
})
