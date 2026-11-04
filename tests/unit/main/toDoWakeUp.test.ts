// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentControl } from '../../../src/main/agents/control'
import type { BabysitNews } from '../../../src/main/agents/babysitNews'
import type { AgentHost, AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import type { AgentHostSnapshot, AgentThread } from '../../../src/shared/agents'
import { createAgentControl } from '../../fixtures/agentControlFixture'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { testCredentials } from '../../fixtures/testCredentials'

/** A checked-off to-do's news on its way to a waiting thread (ADR-0188), and on a stable run after an Owl one (ADR-0072). */
const roots: string[] = []; const controls: AgentControl[] = []
afterEach(async () => {
  for (const c of controls.splice(0)) { c.dispose(); await c.privacyChanged() }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
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
async function fixture(toDoListEnabled: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-to-do-wake-')); roots.push(root)
  const host = new Host()
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  const control = createAgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner, toDoListEnabled }); controls.push(control)
  await control.start(); await control.command({ type: 'connect' })
  host.update('workshop', { status: 'running', lastTurn: { id: 'turn', status: 'running' } })
  return { host, control }
}
const complete = (host: Host) => host.update('workshop', { status: 'idle', lastTurn: { id: randomUUID(), status: 'completed' } })
const sends = (host: Host) => host.attempts.filter((c): c is Extract<AgentHostCommand, { type: 'send' }> => c.type === 'send')
const pullRequest: BabysitNews = { pullRequest: { url: 'https://github.com/o/r/pull/7', number: 7, title: 'Pull 7' }, startedBy: 'agent', head: 'head-1',
  changes: [{ kind: 'checks-failed', checks: [{ name: 'build', status: 'failure', url: null }] }], ended: null }

it('goes to the thread as a wake-up when its turn ends, folding check-offs into one message', async () => {
  const { host, control } = await fixture(true)
  await control.deliverWakeUp('workshop', { source: 'to-do', items: [{ title: 'Hand test' }] }, { tool: false })
  await control.deliverWakeUp('workshop', { source: 'to-do', items: [{ title: 'Listen', didNotWork: 'It cut out' }] }, { tool: false })
  expect(sends(host)).toEqual([])
  complete(host)
  await expect.poll(() => sends(host).length).toBe(1)
  expect(sends(host)[0]!.text).toContain('"Hand test"')
  expect(sends(host)[0]!.text).toContain('Their words: "It cut out"')
  expect(sends(host)[0]!.text).toContain('This approves nothing.')
})

it('stays whole and unsent where the feature is off, and holds back no other news', async () => {
  const { host, control } = await fixture(false)
  await control.deliverWakeUp('workshop', { source: 'to-do', items: [{ title: 'Hand test' }] }, { tool: false })
  await control.deliverWakeUp('workshop', pullRequest, { tool: false })
  complete(host)
  await expect.poll(() => sends(host).length).toBe(1)
  expect(sends(host)[0]!.text).toContain('pull/7')
  expect(sends(host)[0]!.text).not.toContain('Hand test')
  const held = (control as unknown as { followupStore: { peek(): { items: readonly { text: string }[] } } }).followupStore.peek().items
  expect(held.map(item => item.text)).toEqual([expect.stringContaining('"Hand test"')])
})

it('says a settled or missing thread takes no wake-up, so its check-off simply stands', async () => {
  const { host, control } = await fixture(true)
  expect(control.takesWakeUps('workshop')).toBe(true)
  expect(control.takesWakeUps('no-such-thread')).toBe(false)
  host.update('workshop', { archivedAt: new Date().toISOString() })
  await expect.poll(() => control.takesWakeUps('workshop')).toBe(false)
})
