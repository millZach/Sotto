// @vitest-environment node
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ConfiguredAgentReasoner } from '../../../src/main/agents/reasoning'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { DispatchEventHost, fixture, registerAgentControlRecoveryCleanup } from '../../fixtures/agentControlRecovery'

registerAgentControlRecoveryCleanup()

describe('supervision event ordering', () => {
  it.each([false, true])('keeps management active when shutdown cancels a decision and the final save fails: %s', async saveFails => {
    const f = await fixture()
    await f.account()
    const failure = new Error('Sotto reasoning stopped.')
    const decide = vi.spyOn(ConfiguredAgentReasoner.prototype, 'decide').mockImplementationOnce(async () => {
      await decisionGate
      throw failure
    })
    let release!: () => void
    const decisionGate = new Promise<void>(resolve => { release = resolve })
    const write = AtomicJsonStore.prototype.write
    let rejectWrites = false
    const save = vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function (this: AtomicJsonStore<unknown>, value: unknown) {
      if (saveFails && rejectWrites) return decisionGate.then(() => { throw new Error('Synthetic final save failure') })
      return write.call(this, value)
    })
    try {
      await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Keep watching' })
      rejectWrites = true
      f.host.event({ type: 'ready', threadId: 'workshop', text: 'Review this result' })
      await expect.poll(() => decide.mock.calls.length).toBe(1)
      f.control.dispose()
      release()
      await expect.poll(() => decide.mock.settledResults[0]?.type).toBe('rejected')
      expect(f.control.get().assignments[0]).toMatchObject({ mode: 'managed', paused: false, stopReason: 'none' })
      expect(f.control.get().queue).toEqual([])
    } finally { release(); save.mockRestore(); decide.mockRestore() }
    await f.control.privacyChanged()
    const saved = JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8'))
    expect(saved.assignments[0]).toMatchObject({ mode: 'managed', paused: false, stopReason: 'none' })
    expect(saved.queue).toEqual([])
    await f.restart()
    expect(f.control.get().assignments[0]).toMatchObject({ mode: 'managed', paused: false })
    expect(f.control.get().queue.some(item => item.text === failure.message)).toBe(false)
  })
  it('detects a manual prompt after restarting before takeover was saved', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Keep watching' })
    const file = join(f.root, 'agents.json')
    const saved = await readFile(file, 'utf8')
    f.host.event({ type: 'manual', threadId: 'workshop', text: 'I will handle this myself.' })
    expect(f.control.get().assignments[0]?.mode).toBe('manual')
    await f.control.command({ type: 'refresh' })
    f.control.dispose()
    await writeFile(file, saved)
    const startup = await f.host.snapshot()
    Object.assign(f.host, { workspaceSnapshot: () => structuredClone(startup) })
    await f.restart()
    expect(f.control.get().assignments[0]?.mode).toBe('manual')
    expect(f.decisions).toEqual([])
  })

  it.each([1, 2001])('keeps management and context age when %s earlier messages are loaded', async count => {
    const f = await fixture()
    f.host.event({ type: 'history', threadId: 'workshop', text: '', messages: [
      { id: 'recent', role: 'user', text: 'Recent prompt', createdAt: new Date().toISOString() },
    ] })
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Keep watching' })
    await f.control.command({ type: 'pause', threadId: 'workshop' })
    const before = f.control.get()
    Object.assign(f.host, { loadEarlierMessages: async () => {
      f.host.event({ type: 'history', threadId: 'workshop', text: '', messages: [
        ...Array.from({ length: count }, (_, index) => ({ id: `older-${index}`, role: 'user' as const, text: 'Earlier prompt', createdAt: '2026-01-01T00:00:00.000Z' })),
        ...before.host.threads.find(thread => thread.id === 'workshop')!.messages,
      ] })
      return f.host.snapshot()
    } })
    const after = await f.control.command({ type: 'load-earlier-messages', threadId: 'workshop' })
    expect(after.assignments).toEqual(before.assignments.map(assignment => ({ ...assignment, seenMessageIds: after.assignments[0]!.seenMessageIds })))
    expect(after.assignments[0]!.seenMessageIds.length).toBeLessThanOrEqual(2000)
    const saved = JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8'))
    expect(saved.assignments[0].seenMessageIds.length).toBeLessThanOrEqual(2000)
    expect(after.queue).toEqual(before.queue)
    expect(after.speech).toEqual(before.speech)
    for (let refresh = 0; refresh < 2; refresh += 1) {
      const refreshed = await f.control.command({ type: 'refresh' })
      expect(refreshed.assignments[0]).toMatchObject({ mode: 'managed', contextUpdatedAt: before.assignments[0]!.contextUpdatedAt })
      expect(refreshed.queue).toEqual(before.queue)
      expect(refreshed.speech).toEqual(before.speech)
    }
    f.host.event({ type: 'manual', threadId: 'workshop', text: 'A new prompt' })
    expect(f.control.get().assignments[0]?.mode).toBe('manual')
  })
  it('bounds message identities when management starts and saved state is restored', async () => {
    const f = await fixture()
    const messages = Array.from({ length: 2500 }, (_, index) => ({ id: `message-${index}`, role: 'user' as const,
      text: 'Earlier prompt', createdAt: '2026-01-01T00:00:00.000Z' }))
    f.host.event({ type: 'history', threadId: 'workshop', text: '', messages })
    const assigned = await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Keep watching' })
    expect(assigned.assignments[0]!.seenMessageIds).toEqual(messages.slice(-2000).map(message => message.id))
    const file = join(f.root, 'agents.json')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    saved.assignments[0].seenMessageIds = messages.map(message => message.id)
    await writeFile(file, JSON.stringify(saved), 'utf8')
    await f.restart()
    const restored = await f.control.command({ type: 'refresh' })
    expect(restored.assignments[0]!.seenMessageIds).toEqual(messages.slice(-2000).map(message => message.id))
    expect(restored.assignments[0]!.mode).toBe('managed')
    expect(JSON.parse(await readFile(file, 'utf8')).assignments[0].seenMessageIds).toHaveLength(2000)
  })
  it('detects a new manual prompt while earlier messages are still loading', async () => {
    const f = await fixture()
    f.host.event({ type: 'history', threadId: 'workshop', text: '', messages: [
      { id: 'recent', role: 'user', text: 'Recent prompt', createdAt: new Date().toISOString() },
    ] })
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Keep watching' })
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const waiting = new Promise<void>(resolve => { started = resolve })
    Object.assign(f.host, { loadEarlierMessages: async () => {
      const snapshot = await f.host.snapshot()
      f.host.event({ type: 'history', threadId: 'workshop', text: '', messages: [
        { id: 'older', role: 'user', text: 'Earlier prompt', createdAt: '2026-01-01T00:00:00.000Z' },
        ...snapshot.threads.find(thread => thread.id === 'workshop')!.messages,
      ] })
      started(); await gate
      return f.host.snapshot()
    } })
    const loading = f.control.command({ type: 'load-earlier-messages', threadId: 'workshop' })
    try {
      await waiting
      expect(f.control.get().assignments[0]?.mode).toBe('managed')
      f.host.event({ type: 'manual', threadId: 'workshop', text: 'I am handling this now' })
      expect(f.control.get().assignments[0]?.mode).toBe('manual')
    } finally { release(); await loading }
    expect(f.control.get().assignments[0]?.mode).toBe('manual')
  })
  it('restores a completed response without paying for another review, while new responses and explicit resume still work', async () => {
    const f = await fixture()
    await f.account()
    f.service.decision = { decision: 'done', text: 'The assigned change is complete.' }
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Finish the assigned change.' })
    f.host.event({ type: 'ready', threadId: 'workshop', text: 'The implementation is complete.' })
    await expect.poll(() => f.control.get().queue[0]?.text).toBe(f.service.decision.text)
    const before = await f.control.command({ type: 'refresh' })
    expect(f.decisions).toHaveLength(1)
    await f.restart()
    const restored = await f.control.command({ type: 'refresh' })
    expect(f.decisions).toHaveLength(1)
    expect(restored.queue).toEqual(before.queue)
    f.host.event({ type: 'ready', threadId: 'workshop', text: 'A genuinely new response arrived.' })
    await expect.poll(() => f.decisions.length).toBe(2)
    await f.control.command({ type: 'refresh' })
    await f.control.command({ type: 'resume', threadId: 'workshop' })
    await expect.poll(() => f.decisions.length).toBe(3)
    await f.control.command({ type: 'refresh' })
  })

  it.each(['blocked', 'question'] as const)('restores a completed %s review and allows explicit resume', async kind => {
    const f = await fixture()
    await f.account()
    f.service.decision = { decision: 'human', text: 'Your choice is needed.' }
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Finish the assigned change.' })
    f.host.event({ type: kind === 'question' ? 'question' : 'ready', threadId: 'workshop', text: 'Choose the final behavior.', requestId: 'request:with:colons' })
    await expect.poll(() => f.control.get().queue[0]?.kind).toBe(kind)
    const before = await f.control.command({ type: 'refresh' })
    await f.restart()
    const restored = await f.control.command({ type: 'refresh' })
    expect(f.decisions).toHaveLength(1)
    expect(restored.queue).toEqual(before.queue)
    await f.control.command({ type: 'resume', threadId: 'workshop' })
    await expect.poll(() => f.decisions.length).toBe(2)
    await f.control.command({ type: 'refresh' })
    if (kind === 'question') {
      await f.host.execute({ type: 'answer', commandId: 'external-answer', threadId: 'workshop', requestId: 'request:with:colons', answer: 'The original behavior.' })
      f.host.event({ type: 'question', threadId: 'workshop', text: 'A new question needs review.', requestId: 'new:request' })
      await expect.poll(() => f.decisions.length).toBe(3)
      const next = await f.control.command({ type: 'refresh' })
      expect(next.queue.some(item => item.requestId === 'new:request')).toBe(true)
      expect(next.queue.some(item => item.requestId === 'request:with:colons')).toBe(false)
    }
  })

  it('keeps another restored pending question in the attention queue after the first is answered', async () => {
    const f = await fixture()
    await f.account()
    f.service.decision = { decision: 'human', text: 'Your choice is needed.' }
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Finish the assigned change.' })
    await f.control.command({ type: 'pause', threadId: 'workshop' })
    f.host.event({ type: 'question', threadId: 'workshop', text: 'First choice.', requestId: 'first:request' })
    f.host.event({ type: 'question', threadId: 'workshop', text: 'Second choice.', requestId: 'second:request' })
    await f.control.command({ type: 'resume', threadId: 'workshop' })
    await expect.poll(() => f.decisions.length).toBe(1)
    await f.control.command({ type: 'refresh' })
    await f.restart()
    await f.control.command({ type: 'answer', threadId: 'workshop', requestId: 'first:request', answer: 'Use the first option.' })
    const next = await f.control.command({ type: 'refresh' })
    expect(f.decisions).toHaveLength(1)
    expect(next.queue.map(item => item.requestId)).toEqual(['second:request'])
  })

  it('recovers unfinished reasoning after a crash instead of treating a merely observed message as complete', async () => {
    const f = await fixture()
    await f.account()
    f.service.decision = { decision: 'done', text: 'Review finished.' }
    let release!: () => void
    f.service.decisionGate = new Promise<void>(resolve => { release = resolve })
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Finish the assigned change.' })
    f.host.event({ type: 'ready', threadId: 'workshop', text: 'This result was still being reviewed at the crash.' })
    await expect.poll(() => f.decisions.length).toBe(1)
    await f.control.command({ type: 'refresh' })
    const interruptedState = await readFile(join(f.root, 'agents.json'), 'utf8')
    expect(JSON.parse(interruptedState).queue).toEqual([])
    release()
    await expect.poll(() => f.control.get().queue.length).toBe(1)
    await f.control.command({ type: 'refresh' })
    // Reopen the exact durable state that existed before the external result.
    await writeFile(join(f.root, 'agents.json'), interruptedState)
    await f.restart()
    await expect.poll(() => f.decisions.length).toBe(2)
    await expect.poll(() => f.control.get().queue[0]?.text).toBe('Review finished.')
    await f.control.command({ type: 'refresh' })
  })

  it('processes failures arriving during dispatch and still enforces the follow-up limit and repeated-failure stop', async () => {
    const host = new DispatchEventHost([
      [{ type: 'failure', threadId: 'workshop', text: 'Fixable test two' }],
      [{ type: 'failure', threadId: 'workshop', text: 'Fixable test three' }],
      [{ type: 'failure', threadId: 'workshop', text: 'Fixable test three' }],
    ])
    const f = await fixture(host)
    await f.account()
    await f.control.command({ type: 'configure', patch: { followupLimit: 2 } })
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Fix the existing failing tests.' })
    host.event({ type: 'failure', threadId: 'workshop', text: 'Fixable test one' })
    await expect.poll(() => f.control.get().assignments[0]?.followups).toBe(2)
    await expect.poll(() => f.control.get().assignments[0]?.paused).toBe(true)
    expect(host.sendCalls).toBe(2)
    expect(f.decisions).toEqual(['Fixable test one', 'Fixable test two'])
    expect(f.control.get().queue.some(item => item.text.includes('follow-up limit'))).toBe(true)
    await f.control.command({ type: 'resume', threadId: 'workshop' })
    await expect.poll(() => f.control.get().queue.some(item => item.text.includes('repeating a failure'))).toBe(true)
    expect(host.sendCalls).toBe(3)
    expect(f.control.get().assignments[0]).toMatchObject({ followups: 1, paused: true })
  })

  it('reasons about the newest failure when an earlier decision becomes stale before dispatch', async () => {
    const f = await fixture()
    await f.account()
    let release!: () => void
    f.service.decisionGate = new Promise<void>(resolve => { release = resolve })
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Fix the existing failing tests.' })
    f.host.event({ type: 'failure', threadId: 'workshop', text: 'Superseded failure' })
    await expect.poll(() => f.decisions.length).toBe(1)
    f.host.event({ type: 'failure', threadId: 'workshop', text: 'Newest failure' })
    release()
    await expect.poll(() => f.control.get().host.threads[0]?.messages.filter(message => message.role === 'user').length).toBe(1)
    expect(f.decisions).toEqual(['Superseded failure', 'Newest failure'])
    expect(f.control.get().assignments[0]).toMatchObject({ followups: 1, paused: false })
  })

  it('does not continue automatically after manual takeover during an earlier dispatch', async () => {
    const host = new DispatchEventHost([[
      { type: 'manual', threadId: 'workshop', text: 'I am handling this now.' },
      { type: 'failure', threadId: 'workshop', text: 'New failure under manual control' },
    ]])
    const f = await fixture(host)
    await f.account()
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Fix the existing failing tests.' })
    host.event({ type: 'failure', threadId: 'workshop', text: 'Original failure' })
    await expect.poll(() => f.control.get().assignments[0]?.mode).toBe('manual')
    await f.control.command({ type: 'refresh' })
    expect(host.sendCalls).toBe(1)
    expect(f.decisions).toEqual(['Original failure'])
    expect(f.control.get().queue.some(item => item.text === 'New failure under manual control')).toBe(true)
  })
})
