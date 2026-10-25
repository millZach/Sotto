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

/** Work across machines is an Owl feature (#1032, ADR-0072): stable reads no setting for it, offers none of it and reports no origins. */
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== tmpdir() || !root.includes('sotto-runtime-machines-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

async function runtime(crossMachineEnabled: boolean | undefined, runsAs?: 'headless-host') {
  const root = await mkdtemp(join(tmpdir(), 'sotto-runtime-machines-')); roots.push(root)
  const credentials = await testCredentials(root, { encryption: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('No test key') }, decryptString: () => '' } })
  return createAgentRuntime({ directory: root, credentials, settings: () => DEFAULT_SETTINGS, writingSettings: async () => DEFAULT_SETTINGS,
    historyEnabled: () => true, openExternal: async () => undefined, host: new E2EAgentHost(), reasoner: e2eAgentReasoner, watcherEnabled: true, delegationEnabled: true,
    ...(crossMachineEnabled === undefined ? {} : { crossMachineEnabled }), ...(runsAs ? { runsAs } : {}) })
}
const startOffers = (host: Awaited<ReturnType<typeof runtime>>) =>
  Object.keys((host.watcherTools!.definitions.find(tool => tool.name === 'start_thread')!.inputSchema as { properties: Record<string, unknown> }).properties)
const delegationMachines = (host: Awaited<ReturnType<typeof runtime>>) => (host.delegation as unknown as { options: { machines?: unknown } }).options.machines

it('is off on stable and on in Owl', () => {
  expect(owlFeaturesForTrack('stable')['cross-machine-work']).toBe(false)
  expect(owlFeaturesForTrack('owl')['cross-machine-work']).toBe(true)
})

it.each([[undefined], [false]] as const)('offers no machine choice and reports no origins when the Owl answer is %s', async enabled => {
  const host = await runtime(enabled)
  try {
    expect(startOffers(host)).not.toContain('machine')
    expect(host.watcherTools!.instructions ?? '').not.toContain('newWorkersStart')
    expect(delegationMachines(host)).toBeUndefined()
    expect(host.hostService.supportsProjectOrigins).toBe(false)
  } finally { await host.close() }
})

it('offers the choice on the desktop when the Owl answer is on, and a headless host reports its origins without placing anything', async () => {
  const desktop = await runtime(true)
  try {
    expect(startOffers(desktop)).toEqual(expect.arrayContaining(['machine', 'os']))
    expect(desktop.watcherTools!.instructions).toContain('newWorkersStart')
    expect(delegationMachines(desktop)).toBeDefined()
    expect(desktop.hostService.supportsProjectOrigins).toBe(true)
    expect(await desktop.hostService.projectOrigins()).toEqual({ projects: expect.any(Array) })
  } finally { await desktop.close() }
  const headless = await runtime(true, 'headless-host')
  try {
    expect(headless.watcherTools).toBeUndefined()
    expect(headless.hostService.supportsProjectOrigins).toBe(true)
  } finally { await headless.close() }
})
