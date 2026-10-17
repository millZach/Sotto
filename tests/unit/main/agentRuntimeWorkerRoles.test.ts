// @vitest-environment node
// #1042: the runtime hands every provider the role table only while worker roles are on, and only on this computer.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'
import { createAgentRuntime } from '../../../src/main/agents/runtime'
import type { WorkerRoleSource } from '../../../src/main/agents/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { testCredentials } from '../../fixtures/testCredentials'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function runtime(options: { workerRolesEnabled?: boolean; runsAs?: 'headless-host' }, settings: () => AppSettings = () => DEFAULT_SETTINGS) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-runtime-worker-roles-')); roots.push(root)
  const credentials = await testCredentials(root, { encryption: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('No test key') }, decryptString: () => '' } })
  const host = new E2EAgentHost()
  const given = vi.fn<(roles: WorkerRoleSource) => void>()
  Object.assign(host, { useWorkerRoles: given })
  const created = await createAgentRuntime({ directory: root, credentials, settings, writingSettings: async () => settings(),
    historyEnabled: () => true, openExternal: async () => undefined, host, reasoner: e2eAgentReasoner, ...options })
  return { created, given }
}

it('gives the providers the table while worker roles are on, read from Settings only when asked', async () => {
  const read = vi.fn(() => DEFAULT_SETTINGS)
  const { created, given } = await runtime({ workerRolesEnabled: true }, read)
  try {
    expect(given).toHaveBeenCalledTimes(1)
    expect(given.mock.calls[0]![0]).toBe(created.workerRoles)
    const before = read.mock.calls.length
    await created.agentControl.command({ type: 'connect' })
    // The table is what Settings give each kind of work over the models ready now; Orchestrating is Watcher's own.
    const table = given.mock.calls[0]![0].table()
    expect(read.mock.calls.length).toBeGreaterThan(before)
    expect(table.every(role => role.kind !== ('orchestrating' as string))).toBe(true)
  } finally { await created.close() }
})

it('gives none on stable or on a headless host', async () => {
  for (const options of [{}, { workerRolesEnabled: false }, { workerRolesEnabled: true, runsAs: 'headless-host' as const }]) {
    const { created, given } = await runtime(options)
    try {
      expect(given).not.toHaveBeenCalled()
      expect(created.workerRoles).toBeUndefined()
    } finally { await created.close() }
  }
})
