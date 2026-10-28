// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
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
/** Who moves a branch for a start from a thread's branch (#1033): Watcher's and delegation's mover, the same one. */
const movers = (host: Awaited<ReturnType<typeof runtime>>) => [host.watcher, host.delegation].map(service => (service as unknown as { options: { branchMoves?: unknown } } | undefined)?.options.branchMoves)
/** This machine's checks (#1312), one at a time: delegation's queue. */
const checks = (host: Awaited<ReturnType<typeof runtime>>) => (host.delegation as unknown as { options: { checks?: { machine: string } } } | undefined)?.options.checks
/** Watcher's queue for its starts marked as checks (#1312), which must be delegation's own: one queue per machine. */
const watcherChecks = (host: Awaited<ReturnType<typeof runtime>>) => (host.watcher as unknown as { options: { checks?: { machine: string } } } | undefined)?.options.checks

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
    expect(movers(host)).toEqual([undefined, undefined])
    expect(checks(host)).toBeUndefined()
    expect(watcherChecks(host)).toBeUndefined()
    expect(host.hostService.supportsWatcherCheckQueue).toBe(false)
    expect(startOffers(host)).not.toContain('fromThread')
    expect(host.hostService.supportsProjectOrigins).toBe(false)
    expect(host.hostService.supportsProjectSetup).toBe(false)
  } finally { await host.close() }
})

it('offers the choice on the desktop when the Owl answer is on, and a headless host reports its origins without placing anything', async () => {
  const desktop = await runtime(true)
  try {
    expect(startOffers(desktop)).toEqual(expect.arrayContaining(['machine', 'os']))
    expect(desktop.watcherTools!.instructions).toContain('newWorkersStart')
    expect(delegationMachines(desktop)).toBeDefined()
    const [watcherMover, delegationMover] = movers(desktop)
    expect(watcherMover).toBeDefined()
    expect(delegationMover).toBe(watcherMover)
    expect(checks(desktop)?.machine).toBe('This computer')
    // Watcher's checks and delegated ones wait in the same queue, in the order asked (#1312).
    expect(watcherChecks(desktop)).toBe(checks(desktop))
    expect(startOffers(desktop)).toEqual(expect.arrayContaining(['fromThread', 'testRun']))
    expect(desktop.hostService.supportsProjectOrigins).toBe(true)
    expect(await desktop.hostService.projectOrigins()).toEqual({ projects: expect.any(Array) })
    expect(desktop.hostService.supportsProjectSetup).toBe(true)
  } finally { await desktop.close() }
  const headless = await runtime(true, 'headless-host')
  try {
    expect(headless.watcherTools).toBeUndefined()
    // A headless host moves branches only when the desktop asks over its socket; it places and moves nothing itself.
    expect(movers(headless)[0]).toBeUndefined()
    expect(headless.hostService.supportsProjectOrigins).toBe(true)
    expect(headless.hostService.supportsProjectSetup).toBe(true)
    // A host keeps its own queue, shared by its own threads' checks and the desktop's Watcher starts on it (#1312).
    // Named as the relay's away words name the host: its own machine name until a desktop sends the name it saved (#1316).
    expect(watcherChecks(headless)?.machine).toBe(hostname().trim().slice(0, 64) || 'this machine')
    expect(headless.hostService.supportsWatcherCheckQueue).toBe(true)
  } finally { await headless.close() }
})
