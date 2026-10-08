// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import type { AgentHost, AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import type { BabysitNews } from '../../../src/main/agents/babysitNews'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import type { AgentHostSnapshot, AgentThread } from '../../../src/shared/agents'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

/**
 * A wake-up through the thread's own send path (ADR-0061 decisions 8 and 14): sent at once to a ready thread, and
 * otherwise held as Sotto's own item after the user's follow-ups, folded, removable, never editable, behind any request
 * the user has not answered, and never keeping the thread in the watched set.
 */
const roots: string[] = []; const controls: AgentControl[] = []
afterEach(async () => {
  for (const c of controls.splice(0)) { c.dispose(); await c.privacyChanged() }
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-wake-up-')) throw new Error('Unexpected fixture path')
    await rm(root, { recursive: true, force: true })
  }
})
class Host implements AgentHost {
  state!: AgentHostSnapshot
  listeners = new Set<(s: AgentHostSnapshot) => void>()
  attempts: AgentHostCommand[] = []
  observed: string[][] = []
  async connect() { this.state ??= await new E2EAgentHost().connect(); this.state.connected = true; return this.snapshot() }
  async snapshot() { return structuredClone(this.state) }
  subscribe(fn: (s: AgentHostSnapshot) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  disconnect() { this.state.connected = false }
  observeThreads(ids: readonly string[]) { this.observed.push([...ids]) }
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
  const root = await mkdtemp(join(tmpdir(), 'sotto-wake-up-')); roots.push(root)
  const host = new Host()
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: t => Buffer.from(t), decryptString: t => t.toString() }); await credentials.load()
  const create = () => { const c = new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner }); controls.push(c); return c }
  const control = create(); await control.start(); await control.command({ type: 'connect' })
  return { root, host, control, create }
}
const news = (number: number, patch: Partial<BabysitNews> = {}): BabysitNews => ({ pullRequest: { url: `https://github.com/o/r/pull/${number}`, number, title: `Pull ${number}` },
  startedBy: 'agent', head: 'head-1', changes: [{ kind: 'checks-failed', checks: [{ name: `build-${number}`, status: 'failure', url: null }] }], ended: null, ...patch })
const complete = (host: Host, id = 'workshop') => host.update(id, { status: 'idle', lastTurn: { id: randomUUID(), status: 'completed' } })
const sends = (host: Host) => host.attempts.filter((c): c is Extract<AgentHostCommand, { type: 'send' }> => c.type === 'send')

describe('a wake-up', () => {
  it('goes at once to a ready thread, as a send the workspace marks as a wake-up', async () => {
    const f = await fixture()
    await f.control.deliverWakeUp('workshop', news(1), { tool: true })
    await expect.poll(() => sends(f.host).length).toBe(1)
    expect(sends(f.host)[0]).toMatchObject({ threadId: 'workshop', wakeUp: true })
    expect(sends(f.host)[0]!.text).toContain('Check build-1 failed')
    expect(sends(f.host)[0]!.text).toContain('call stop_babysitting')
    await expect.poll(() => f.control.get().followups ?? []).toEqual([])
  })

  it('leaves no draft or delivery receipt when it goes, so the user\'s receipts are not spent on it', async () => {
    const f = await fixture()
    await f.control.deliverWakeUp('workshop', news(1), { tool: true })
    await expect.poll(() => sends(f.host).length).toBe(1)
    await expect.poll(() => f.control.get().followups ?? []).toEqual([])
    const state = f.control.get()
    expect(state.deliveredDrafts ?? []).toEqual([])
    expect(state.deliveries ?? []).toEqual([])
    // A restart reads the same: nothing of the wake-up was kept as a draft's.
    f.control.dispose(); await f.control.privacyChanged()
    const restored = f.create(); await restored.start(); await restored.command({ type: 'connect' })
    expect(restored.get().deliveredDrafts ?? []).toEqual([])
    expect(restored.get().deliveries ?? []).toEqual([])
  })

  it('waits after the user\'s follow-ups while a turn runs, folds later news, cannot be edited or steered, and goes last', async () => {
    const f = await fixture(); f.host.update('workshop', { status: 'running', lastTurn: { id: 'turn', status: 'running' } })
    await f.control.command({ type: 'queue-followup', threadId: 'workshop', draftId: randomUUID(), text: 'first of mine' })
    await f.control.deliverWakeUp('workshop', news(1), { tool: false })
    await f.control.deliverWakeUp('workshop', news(2), { tool: false })
    await f.control.command({ type: 'queue-followup', threadId: 'workshop', draftId: randomUUID(), text: 'second of mine' })
    const queue = f.control.get().followups!
    expect(queue.map(item => item.wakeUp ? 'wake-up' : item.text)).toEqual(['first of mine', 'second of mine', 'wake-up'])
    const wakeUp = queue[2]!
    expect(wakeUp.text).toContain('Sotto has news of 2 pull requests this thread babysits.')
    expect(wakeUp.text).toContain('The user can stop it from the Pull request surface.')
    expect(wakeUp).not.toHaveProperty('news')
    expect((await f.control.command({ type: 'edit-followup', threadId: 'workshop', itemId: wakeUp.id, text: 'Merge it.' })).error).toContain('cannot be edited')
    expect((await f.control.command({ type: 'steer-followup', threadId: 'workshop', itemId: wakeUp.id })).error).toContain('never into a running turn')
    await f.control.command({ type: 'reorder-followups', threadId: 'workshop', itemIds: [wakeUp.id, queue[1]!.id, queue[0]!.id] })
    expect(f.control.get().followups!.map(item => item.wakeUp ? 'wake-up' : item.text)).toEqual(['second of mine', 'first of mine', 'wake-up'])
    expect(sends(f.host)).toHaveLength(0)
    for (const expected of ['second of mine', 'first of mine']) {
      complete(f.host)
      await expect.poll(() => sends(f.host).at(-1)?.text).toBe(expected)
    }
    complete(f.host)
    await expect.poll(() => sends(f.host).length).toBe(3)
    expect(sends(f.host)[2]).toMatchObject({ wakeUp: true })
    expect(sends(f.host)[2]!.text).toContain('Pull request #2')
  })

  it('waits behind a request the user has not answered and answers nothing', async () => {
    const f = await fixture()
    f.host.update('workshop', { requests: [{ id: 'permit', kind: 'permission', text: 'Allow?', options: [] }] })
    await f.control.deliverWakeUp('workshop', news(1), { tool: true })
    f.host.emit()
    expect(f.host.attempts).toHaveLength(0)
    f.host.update('workshop', { requests: [] })
    await expect.poll(() => sends(f.host).length).toBe(1)
    expect(f.host.attempts.map(command => command.type)).toEqual(['send'])
  })

  it('leaves the user\'s own Send as it would be without it, while it waits behind a request', async () => {
    const f = await fixture()
    for (const threadId of ['workshop', 'docs']) f.host.update(threadId, { requests: [{ id: `permit-${threadId}`, kind: 'permission', text: 'Allow?', options: [] }] })
    const without = await f.control.command({ type: 'manual-send', threadId: 'docs', draftId: randomUUID(), text: 'Do this instead.' })
    expect(without.error).toContain('Answer the pending question or permission')
    await f.control.deliverWakeUp('workshop', news(1), { tool: true })
    const sent = await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId: randomUUID(), text: 'Do this instead.' })
    expect(sent.error).toBe(without.error)
    expect(f.control.get().followups!.map(item => item.wakeUp ? 'wake-up' : item.text)).toEqual(['wake-up'])
    expect(f.host.attempts).toHaveLength(0)
  })

  it('is taken back, part by part, when babysitting ends quietly, and can be removed as the user\'s follow-ups can', async () => {
    const f = await fixture(); f.host.update('workshop', { status: 'running', lastTurn: { id: 'turn', status: 'running' } })
    await f.control.deliverWakeUp('workshop', news(1), { tool: true })
    await f.control.deliverWakeUp('workshop', news(2), { tool: true })
    await f.control.withdrawWakeUp('workshop', 'https://github.com/O/R/pull/1/files', { tool: true })
    const [only] = f.control.get().followups!
    expect(only!.text).not.toContain('Pull request #1')
    expect(only!.text).toContain('Pull request #2')
    await f.control.withdrawWakeUp('workshop', 'https://github.com/o/r/pull/2', { tool: true })
    expect(f.control.get().followups).toEqual([])
    await f.control.deliverWakeUp('workshop', news(3), { tool: true })
    await f.control.command({ type: 'remove-followup', threadId: 'workshop', itemId: f.control.get().followups![0]!.id })
    expect(f.control.get().followups).toEqual([])
    complete(f.host); f.host.emit()
    expect(sends(f.host)).toHaveLength(0)
  })

  it('is taken back by a quiet ending that comes while its save is still pending, and never sent', async () => {
    const f = await fixture(); f.host.update('workshop', { status: 'running', lastTurn: { id: 'turn', status: 'running' } })
    const queued = f.control.deliverWakeUp('workshop', news(1), { tool: true })
    await f.control.withdrawWakeUp('workshop', 'https://github.com/o/r/pull/1', { tool: true })
    await queued
    expect(f.control.get().followups).toEqual([])
    complete(f.host); f.host.emit()
    expect(sends(f.host)).toHaveLength(0)
  })

  it('does not put the thread in the watched set or hold its working copy while only Sotto\'s item waits', async () => {
    const f = await fixture(); f.host.update('workshop', { status: 'running', lastTurn: { id: 'turn', status: 'running' } })
    f.host.observed.length = 0
    await f.control.deliverWakeUp('workshop', news(1), { tool: true })
    await f.control.command({ type: 'select-thread', threadId: 'docs' })
    expect(f.host.observed.at(-1) ?? []).not.toContain('workshop')
    expect(f.control.hasPendingThreadWork('workshop')).toBe(false)
    await f.control.command({ type: 'queue-followup', threadId: 'workshop', draftId: randomUUID(), text: 'mine' })
    expect(f.host.observed.at(-1)).toContain('workshop')
    expect(f.control.hasPendingThreadWork('workshop')).toBe(true)
  })

  it('folds later news of a pull request into that pull request\'s part, so one that merged is told once, as ended', async () => {
    const f = await fixture(); f.host.update('workshop', { status: 'running', lastTurn: { id: 'turn', status: 'running' } })
    await f.control.deliverWakeUp('workshop', news(7), { tool: true })
    await f.control.deliverWakeUp('workshop', news(7, { changes: [{ kind: 'remarks', remarks: [{ kind: 'comment', author: 'lead', review: null, path: null, url: null, edited: false }] }] }), { tool: true })
    await f.control.deliverWakeUp('workshop', news(7, { changes: [], ended: 'merged' }), { tool: true })
    const [wakeUp] = f.control.get().followups!
    expect(wakeUp!.text.split('\n')[0]).toBe('Sotto has stopped babysitting a pull request for this thread.')
    expect(wakeUp!.text.match(/Pull request #7/gu)).toHaveLength(1)
    expect(wakeUp!.text).toContain('- Check build-7 failed\n- lead commented\nIt merged')
    expect(wakeUp!.text).not.toContain('keeps babysitting')
  })

  it('keeps the user\'s queue across a restart however much news a waiting wake-up gathers', async () => {
    const f = await fixture(); f.host.update('workshop', { status: 'running', lastTurn: { id: 'turn', status: 'running' } })
    await f.control.command({ type: 'queue-followup', threadId: 'workshop', draftId: randomUUID(), text: 'mine' })
    for (let number = 1; number <= 60; number++) await f.control.deliverWakeUp('workshop', news(number), { tool: true })
    f.control.dispose(); await f.control.privacyChanged()
    const restored = f.create(); await restored.start(); await restored.command({ type: 'connect' })
    const queue = restored.get().followups!
    expect(queue.map(item => item.wakeUp ? 'wake-up' : item.text)).toEqual(['mine', 'wake-up'])
    expect(queue[1]!.text).toContain('Pull request #60')
  })

  it('is kept across a restart, and refused for a settled thread so the news stays untold', async () => {
    const f = await fixture(); f.host.update('workshop', { status: 'running', lastTurn: { id: 'turn', status: 'running' } })
    await f.control.deliverWakeUp('workshop', news(1), { tool: true })
    f.control.dispose(); await f.control.privacyChanged()
    const restored = f.create(); await restored.start(); await restored.command({ type: 'connect' })
    expect(restored.get().followups).toEqual([expect.objectContaining({ wakeUp: true, status: 'queued' })])
    await restored.deliverWakeUp('workshop', news(2), { tool: true })
    expect(restored.get().followups).toHaveLength(1)
    expect(restored.get().followups![0]!.text).toContain('Sotto has news of 2 pull requests')
    f.host.update('docs', { workspaceSettledAt: new Date().toISOString() })
    await expect(restored.deliverWakeUp('docs', news(3), { tool: true })).rejects.toThrow('settled or archived')
    await expect(restored.deliverWakeUp('gone', news(3), { tool: true })).rejects.toThrow('not on this host')
  })
})
