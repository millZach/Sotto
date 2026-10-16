// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { owlFeaturesForTrack } from '../../../src/shared/owlFeatures'
import { createAgentRuntime } from '../../../src/main/agents/runtime'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { testCredentials } from '../../fixtures/testCredentials'

/** Delegation between threads is an Owl feature (ADR-0081, ADR-0072): stable starts none of it and offers no server. */
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== tmpdir() || !root.includes('sotto-runtime-delegation-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

async function runtime(delegationEnabled: boolean | undefined, runsAs?: 'headless-host') {
  const root = await mkdtemp(join(tmpdir(), 'sotto-runtime-delegation-')); roots.push(root)
  const credentials = await testCredentials(root, { encryption: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('No test key') }, decryptString: () => '' } })
  return createAgentRuntime({ directory: root, credentials, settings: () => DEFAULT_SETTINGS, writingSettings: async () => DEFAULT_SETTINGS,
    historyEnabled: () => true, openExternal: async () => undefined, host: new E2EAgentHost(), reasoner: e2eAgentReasoner,
    ...(delegationEnabled === undefined ? {} : { delegationEnabled }), ...(runsAs ? { runsAs } : {}) })
}

it('is off on stable and on in Owl', () => {
  expect(owlFeaturesForTrack('stable')['thread-delegation']).toBe(false)
  expect(owlFeaturesForTrack('owl')['thread-delegation']).toBe(true)
})

it.each([[undefined], [false]] as const)('starts no delegation when the Owl answer is %s', async enabled => {
  const host = await runtime(enabled)
  try { expect(host.delegation).toBeUndefined() } finally { await host.close() }
})

it('starts delegation on the desktop\'s own host when the Owl answer is on, and never on a headless host', async () => {
  const desktop = await runtime(true)
  try { expect(desktop.delegation).toBeDefined() } finally { await desktop.close() }
  const headless = await runtime(true, 'headless-host')
  try { expect(headless.delegation).toBeUndefined() } finally { await headless.close() }
})
