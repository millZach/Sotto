// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { Babysitter } from '../../../src/main/agents/babysitting'
import { createAgentRuntime } from '../../../src/main/agents/runtime'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'

/**
 * The switch at start (ADR-0061 decision 12 and its #824 amendment): turned off while Sotto was closed, it ends what
 * agents started before babysitting's first pass reads anything, so nothing they started is told once more.
 */
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(root) !== tmpdir() || !root.includes('sotto-runtime-babysitting-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

async function runtime(agentTool: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-runtime-babysitting-')); roots.push(root)
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('No test key') }, decryptString: () => '' })
  await credentials.load()
  return createAgentRuntime({
    directory: root, credentials, settings: () => DEFAULT_SETTINGS, writingSettings: async () => DEFAULT_SETTINGS,
    historyEnabled: () => true, coordinatorEnabled: () => false, openExternal: async () => undefined, host: new E2EAgentHost(), reasoner: e2eAgentReasoner,
    gitStatus: { fetchIntervalMs: () => 3_600_000, foreground: () => false },
    babysitting: { agentTool: () => agentTool, run: async () => { throw new Error('No gh in this test') } },
  })
}

describe('babysitting when the host starts', () => {
  it('ends what agents started before the first pass while the switch is off', async () => {
    const order: string[] = []
    vi.spyOn(Babysitter.prototype, 'stop').mockImplementation(async (selector, reason) => { order.push(`stop ${selector.startedBy} ${reason}`); return 0 })
    vi.spyOn(Babysitter.prototype, 'begin').mockImplementation(() => { order.push('begin') })
    const host = await runtime(false)
    try { expect(order).toEqual(['stop agent switch', 'begin']) } finally { await host.close() }
  })

  it('ends nothing while the switch is on', async () => {
    const order: string[] = []
    vi.spyOn(Babysitter.prototype, 'stop').mockImplementation(async () => { order.push('stop'); return 0 })
    vi.spyOn(Babysitter.prototype, 'begin').mockImplementation(() => { order.push('begin') })
    const host = await runtime(true)
    try { expect(order).toEqual(['begin']) } finally { await host.close() }
  })
})
