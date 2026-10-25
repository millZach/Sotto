// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { owlFeaturesForTrack } from '../../../src/shared/owlFeatures'
import { createAgentRuntime } from '../../../src/main/agents/runtime'
import { HostFactsSource } from '../../../src/main/agents/hostFacts'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { testCredentials } from '../../fixtures/testCredentials'

/**
 * Live load and work placed but not started (#1311) are part of the Owl feature Work across machines (ADR-0072, ADR-0082):
 * stable samples nothing, answers its host facts and running threads as before, and offers list_machines without them.
 */
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(root) !== tmpdir() || !root.includes('sotto-runtime-load-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

async function runtime(crossMachineEnabled: boolean | undefined, runsAs?: 'headless-host') {
  const root = await mkdtemp(join(tmpdir(), 'sotto-runtime-load-')); roots.push(root)
  const credentials = await testCredentials(root, { encryption: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('No test key') }, decryptString: () => '' } })
  return createAgentRuntime({ directory: root, credentials, settings: () => DEFAULT_SETTINGS, writingSettings: async () => DEFAULT_SETTINGS,
    historyEnabled: () => true, openExternal: async () => undefined, host: new E2EAgentHost(), reasoner: e2eAgentReasoner, watcherEnabled: true,
    ...(crossMachineEnabled === undefined ? {} : { crossMachineEnabled }), ...(runsAs ? { runsAs } : {}) })
}
const listMachines = (host: Awaited<ReturnType<typeof runtime>>) => host.watcherTools!.definitions.find(tool => tool.name === 'list_machines')!
const machineFields = (host: Awaited<ReturnType<typeof runtime>>) => {
  const output = listMachines(host).outputSchema as { anyOf: { properties?: { machines?: { items: { properties: Record<string, unknown> } } } }[] }
  return Object.keys(output.anyOf.find(branch => branch.properties?.machines)!.properties!.machines!.items.properties)
}

it('is off on stable and on in Owl', () => {
  expect(owlFeaturesForTrack('stable')['cross-machine-work']).toBe(false)
  expect(owlFeaturesForTrack('owl')['cross-machine-work']).toBe(true)
})

it.each([[undefined], [false]] as const)('samples nothing and answers the facts alone when the Owl answer is %s', async enabled => {
  const prime = vi.spyOn(HostFactsSource.prototype, 'primeLoad')
  const load = vi.spyOn(HostFactsSource.prototype, 'load')
  for (const runsAs of [undefined, 'headless-host'] as const) {
    const host = await runtime(enabled, runsAs)
    try {
      const report = await host.hostService.hostFacts!()
      expect(Object.keys(report).sort()).toEqual(['facts', 'runningThreads'])
    } finally { await host.close() }
  }
  expect(prime).not.toHaveBeenCalled()
  expect(load).not.toHaveBeenCalled()
  const desktop = await runtime(enabled)
  try {
    expect(machineFields(desktop)).not.toContain('load')
    expect(listMachines(desktop).description).not.toContain('how busy')
  } finally { await desktop.close() }
})

it('samples the load at start, answers it with the facts and offers it in list_machines when the Owl answer is on', async () => {
  const prime = vi.spyOn(HostFactsSource.prototype, 'primeLoad')
  for (const runsAs of [undefined, 'headless-host'] as const) {
    const host = await runtime(true, runsAs)
    try {
      expect(await host.hostService.hostFacts!()).toMatchObject({ runningThreads: 0, placedNotStarted: 0, load: expect.objectContaining({ windowMs: expect.any(Number) }) })
    } finally { await host.close() }
  }
  expect(prime).toHaveBeenCalledTimes(2)
  const desktop = await runtime(true)
  try {
    expect(machineFields(desktop)).toEqual(expect.arrayContaining(['load', 'placedNotStarted', 'memoryState', 'cpuState']))
    expect(listMachines(desktop).description).toContain('how busy its CPU and memory are now')
  } finally { await desktop.close() }
}, 30_000)
