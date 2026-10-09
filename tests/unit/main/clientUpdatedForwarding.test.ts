// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { createAgentRuntime } from '../../../src/main/agents/runtime'

import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { testCredentials } from '../../fixtures/testCredentials'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== tmpdir() || !root.includes('sotto-client-updated-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

/** A provider host that records being told a new client is on disk, and whether anything else reached it. */
function provider() {
  return Object.assign(new E2EAgentHost(), { clientUpdated: vi.fn(async () => undefined), disconnect: vi.fn(() => undefined) })
}

it('hands a client update through the workspace, the provider switch and the thread IDs to that provider alone (ADR-0042)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-client-updated-')); roots.push(root)
  const credentials = await testCredentials(root, { encryption: {
    isEncryptionAvailable: () => false, encryptString: () => { throw new Error('No test key') }, decryptString: () => '',
  } })

  const providers = { codex: provider(), claude: provider(), grok: provider(), devin: provider() }
  const runtime = await createAgentRuntime({
    directory: root, credentials, settings: () => DEFAULT_SETTINGS, writingSettings: async () => DEFAULT_SETTINGS,
    historyEnabled: () => true, coordinatorEnabled: () => false, openExternal: async () => undefined,
    providers, reasoner: e2eAgentReasoner,
  })
  try {
    for (const host of Object.values(providers)) host.disconnect.mockClear()
    await runtime.agentHost.clientUpdated('grok')
    expect(providers.grok.clientUpdated).toHaveBeenCalledOnce()
    expect(providers.codex.clientUpdated).not.toHaveBeenCalled()
    expect(providers.claude.clientUpdated).not.toHaveBeenCalled()
    expect(providers.devin.clientUpdated).not.toHaveBeenCalled()
    for (const host of Object.values(providers)) expect(host.disconnect, 'an update disconnects nothing').not.toHaveBeenCalled()
  } finally { await runtime.close() }
})
