// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { Babysitter } from '../../../src/main/agents/babysitting'
import { toldAtStart, type BabysitNews } from '../../../src/main/agents/babysitNews'
import { FollowupStore } from '../../../src/main/agents/followups'
import type { AgentHostCommand } from '../../../src/main/agents/host'
import { createAgentRuntime } from '../../../src/main/agents/runtime'
import { AgentControl } from '../../../src/main/agents/control'
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

async function runtime(agentTool: boolean, root?: string, host = new E2EAgentHost()) {
  if (!root) { root = await mkdtemp(join(tmpdir(), 'sotto-runtime-babysitting-')); roots.push(root) }
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('No test key') }, decryptString: () => '' })
  await credentials.load()
  return createAgentRuntime({
    directory: root, credentials, settings: () => DEFAULT_SETTINGS, writingSettings: async () => DEFAULT_SETTINGS,
    historyEnabled: () => true, openExternal: async () => undefined, host, reasoner: e2eAgentReasoner,
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

  it('takes back what an agent\'s babysitting left waiting before the queue can send it', async () => {
    const url = 'https://github.com/o/r/pull/1'
    const first = await runtime(true)
    const root = roots.at(-1)!
    await first.agentControl.command({ type: 'connect' })
    const startedAt = new Date().toISOString()
    await first.agentHost.changeBabysitting('workshop', () => [{ url, number: 1, startedBy: 'agent', startedAt, told: toldAtStart(startedAt) }])
    await first.close()
    // The wake-up was saved for a thread at rest just before Sotto closed, so the queue would send it at the first chance.
    const queue = new FollowupStore(root); await queue.load()
    const news: BabysitNews = { pullRequest: { url, number: 1, title: 'Pull 1' }, startedBy: 'agent', head: 'head-1', changes: [{ kind: 'checks-failed', checks: [{ name: 'build', status: 'failure', url: null }] }], ended: null }
    await queue.queueWakeUp('workshop', news, () => 'Sotto is babysitting a pull request for this thread, and it needs you.', 'unknown')

    const host = new E2EAgentHost(); const sent: AgentHostCommand[] = []
    const execute = host.execute.bind(host)
    host.execute = async command => { sent.push(command); return execute(command) }
    const second = await runtime(false, root, host)
    try {
      await expect.poll(() => second.agentControl.get().followups ?? []).toEqual([])
      expect(second.agentControl.get().host.connected).toBe(true)
      expect(second.babysitter!.list('workshop')).toEqual([])
      expect(sent.filter(command => command.type === 'send')).toEqual([])
    } finally { await second.close() }
  })

  it('sends no wake-up an agent left waiting even when taking it back fails at start', async () => {
    const url = 'https://github.com/o/r/pull/1'
    const first = await runtime(true)
    const root = roots.at(-1)!
    await first.agentControl.command({ type: 'connect' })
    const startedAt = new Date().toISOString()
    await first.agentHost.changeBabysitting('workshop', () => [{ url, number: 1, startedBy: 'agent', startedAt, told: toldAtStart(startedAt) }])
    await first.close()
    const queue = new FollowupStore(root); await queue.load()
    const news: BabysitNews = { pullRequest: { url, number: 1, title: 'Pull 1' }, startedBy: 'agent', startedAt, head: 'head-1', changes: [{ kind: 'checks-failed', checks: [{ name: 'build', status: 'failure', url: null }] }], ended: null }
    await queue.queueWakeUp('workshop', news, () => 'Sotto is babysitting a pull request for this thread, and it needs you.', 'unknown')

    vi.spyOn(FollowupStore.prototype, 'withdrawWakeUp').mockRejectedValue(new Error('The disk is full.'))
    // The queue asks babysitting before any wake-up goes from the moment the coordinator can hear the host.
    const order: string[] = []
    const useBabysitting = AgentControl.prototype.useBabysitting
    vi.spyOn(AgentControl.prototype, 'useBabysitting').mockImplementation(function (this: AgentControl, ...args) { order.push('guard'); useBabysitting.apply(this, args) })
    const host = new E2EAgentHost(); const sent: AgentHostCommand[] = []
    const execute = host.execute.bind(host), connect = host.connect.bind(host)
    host.execute = async command => { sent.push(command); return execute(command) }
    host.connect = async (...args) => { order.push('connect'); return connect(...args) }
    const second = await runtime(false, root, host)
    try {
      expect(order[0]).toBe('guard')
      await expect.poll(() => second.agentControl.get().followups ?? []).toEqual([])
      expect(second.agentControl.get().host.connected).toBe(true)
      expect(sent.filter(command => command.type === 'send')).toEqual([])
    } finally { await second.close() }
  })

  it('ends nothing while the switch is on', async () => {
    const order: string[] = []
    vi.spyOn(Babysitter.prototype, 'stop').mockImplementation(async () => { order.push('stop'); return 0 })
    vi.spyOn(Babysitter.prototype, 'begin').mockImplementation(() => { order.push('begin') })
    const host = await runtime(true)
    try { expect(order).toEqual(['begin']) } finally { await host.close() }
  })
})
