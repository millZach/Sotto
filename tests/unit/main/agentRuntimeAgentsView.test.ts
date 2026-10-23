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

/** The iPhone's Agents view is an Owl feature (ADR-0103, ADR-0072): stable offers none of it. */
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== tmpdir() || !root.includes('sotto-runtime-agents-view-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

async function runtime(options: { agentsViewEnabled?: boolean; delegationEnabled?: boolean; runsAs?: 'headless-host' }) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-runtime-agents-view-')); roots.push(root)
  const credentials = await testCredentials(root, { encryption: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('No test key') }, decryptString: () => '' } })
  return createAgentRuntime({ directory: root, credentials, settings: () => DEFAULT_SETTINGS, writingSettings: async () => DEFAULT_SETTINGS,
    historyEnabled: () => true, openExternal: async () => undefined, host: new E2EAgentHost(), reasoner: e2eAgentReasoner, ...options })
}

it('is on in both tracks now that it is sent to stable', () => {
  expect(owlFeaturesForTrack('stable')['iphone-agents-view']).toBe(true)
  expect(owlFeaturesForTrack('owl')['iphone-agents-view']).toBe(true)
})

it('offers the Agents view only when the Owl answer is on, and reads delegated threads only where delegation runs', async () => {
  const stable = await runtime({ delegationEnabled: true })
  try { expect(stable.hostService.supportsAgentsView).toBe(false) } finally { await stable.close() }
  const desktop = await runtime({ agentsViewEnabled: true, delegationEnabled: true })
  try {
    expect(desktop.hostService.supportsAgentsView).toBe(true)
    expect(await desktop.hostService.threadDelegations('no-such-thread')).toEqual({ threadId: 'no-such-thread', threads: [] })
  } finally { await desktop.close() }
  // A headless host runs no delegation: the view lists sub-agents alone, and every thread reads as having no delegated threads.
  const headless = await runtime({ agentsViewEnabled: true, delegationEnabled: true, runsAs: 'headless-host' })
  try {
    expect(headless.hostService.supportsAgentsView).toBe(true)
    expect(await headless.hostService.threadDelegations('thread')).toEqual({ threadId: 'thread', threads: [] })
  } finally { await headless.close() }
})
