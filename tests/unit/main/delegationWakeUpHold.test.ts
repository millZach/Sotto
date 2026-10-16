// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentControl } from '../../../src/main/agents/control'
import type { AgentHost, AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import type { BabysitNews } from '../../../src/main/agents/babysitNews'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import type { AgentHostSnapshot, AgentThread } from '../../../src/shared/agents'
import type { DelegationNews } from '../../../src/shared/delegation'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { testCredentials } from '../../fixtures/testCredentials'
import { createAgentControl } from '../../fixtures/agentControlFixture'

/**
 * A delegation's news while delegation is off (ADR-0081, ADR-0072): it waits in the queue, unsent and whole, as on a
 * stable run after an Owl one, and holds back no other news of the thread's, folded with it or queued after it.
 */
const roots: string[] = []; const controls: AgentControl[] = []
afterEach(async () => {
  for (const c of controls.splice(0)) { c.dispose(); await c.privacyChanged() }
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-delegation-hold-')) throw new Error('Unexpected fixture path')
    await rm(root, { recursive: true, force: true })
  }
})
class Host implements AgentHost {
  state!: AgentHostSnapshot
  listeners = new Set<(s: AgentHostSnapshot) => void>()
  attempts: AgentHostCommand[] = []
  async connect() { this.state ??= await new E2EAgentHost().connect(); this.state.connected = true; return this.snapshot() }
  async snapshot() { return structuredClone(this.state) }
  subscribe(fn: (s: AgentHostSnapshot) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  disconnect() { this.state.connected = false }
  observeThreads() { /* Every thread is in the snapshot. */ }
  update(id: string, patch: Partial<AgentThread>) { Object.assign(this.state.threads.find(t => t.id === id)!, patch); this.emit() }
  emit() { for (const fn of this.listeners) fn(structuredClone(this.state)) }
  async execute(c: AgentHostCommand): Promise<AgentHostResult> {
    this.attempts.push(c)
    if (c.type === 'send') {
      const thread = this.state.threads.find(t => t.id === c.threadId)!
      thread.messages.push({ id: c.messageId, commandId: c.commandId, role: 'user', text: c.text, createdAt: new Date().toISOString() })
      thread.status = 'running'; thread.lastTurn = { id: c.commandId, status: 'running' }; this.emit()
    }
    return { accepted: true }
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-delegation-hold-')); roots.push(root)
  const host = new Host()
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  const control = createAgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner }); controls.push(control)
  await control.start(); await control.command({ type: 'connect' })
  host.update('workshop', { status: 'running', lastTurn: { id: 'turn', status: 'running' } })
  return { host, control }
}
const pullRequest = (number: number): BabysitNews => ({ pullRequest: { url: `https://github.com/o/r/pull/${number}`, number, title: `Pull ${number}` },
  startedBy: 'agent', head: 'head-1', changes: [{ kind: 'checks-failed', checks: [{ name: `build-${number}`, status: 'failure', url: null }] }], ended: null })
const delegation = (): DelegationNews => ({ source: 'delegation', items: [{ delegationId: randomUUID(), threadId: 'delegated', outcome: 'answered' }] })
const complete = (host: Host) => host.update('workshop', { status: 'idle', lastTurn: { id: randomUUID(), status: 'completed' } })
const sends = (host: Host) => host.attempts.filter((c): c is Extract<AgentHostCommand, { type: 'send' }> => c.type === 'send')
const waiting = (control: AgentControl) => (control.get().followups ?? []).map(item => item.wakeUp ? `wake-up: ${item.text.includes('Delegation ') ? 'delegation' : 'pull request'}` : item.text)

it('keeps later news out of a delegation\'s waiting wake-up while delegation is off, and sends it', async () => {
  const f = await fixture()
  await f.control.deliverWakeUp('workshop', delegation(), { tool: false })
  await f.control.deliverWakeUp('workshop', pullRequest(1), { tool: false })
  complete(f.host)
  await expect.poll(() => sends(f.host).length).toBe(1)
  expect(sends(f.host)[0]!.text).toContain('Check build-1 failed')
  expect(sends(f.host)[0]!.text).not.toContain('Delegation ')
  expect(waiting(f.control)).toEqual(['wake-up: delegation'])
})

it('sets a delegation\'s news apart from what was folded with it while delegation was on, and sends the rest', async () => {
  const f = await fixture()
  const unhook = f.control.useDelegation({ userCommand: () => undefined, observe: () => undefined, observedThreadIds: () => [],
    messageIdFor: () => undefined, guardFor: () => undefined })
  await f.control.deliverWakeUp('workshop', delegation(), { tool: false })
  await f.control.deliverWakeUp('workshop', pullRequest(1), { tool: false })
  expect(f.control.get().followups).toHaveLength(1)
  unhook()
  complete(f.host)
  await expect.poll(() => sends(f.host).length).toBe(1)
  expect(sends(f.host)[0]!.text).toContain('Check build-1 failed')
  expect(sends(f.host)[0]!.text).not.toContain('Delegation ')
  expect(waiting(f.control)).toEqual(['wake-up: delegation'])
})
