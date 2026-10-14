// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { AgentStateBroadcaster } from '../../../src/main/agents/agentStateBroadcast'
import { cloneAgentThread } from '../../../src/shared/cloneAgentThread'
import type { AgentThreadsBroadcast } from '../../../src/shared/agents'
import { agentThread, threadsStateFixture } from '../../fixtures/agentState'

const fixture = () => threadsStateFixture({ threads: [{ id: 'a', summary: { messageCount: 1, activityCount: 0, lastAssistant: { id: 'message', text: 'First', createdAt: 'today' } }, worktree: { mode: 'shared', status: 'ready', branch: 'main' } }, { id: 'b' }] })

describe('desktop thread broadcast', () => {
  it.each([1, 3, 6])('carries exactly %i changed whole bodies while keeping every roster entry', count => {
    const shell = threadsStateFixture({ threads: Array.from({ length: 12 }, (_, i) => ({ id: `thread-${i}` })) })
    const broadcaster = new AgentStateBroadcaster({ streamingPublishCost: true })
    broadcaster.send(shell, () => true)
    for (const thread of shell.host.threads.slice(0, count)) thread.status = 'running'
    broadcaster.send(shell, payload => {
      const envelope = payload.host.threads as AgentThreadsBroadcast
      expect(envelope.roster).toHaveLength(12)
      expect(envelope.changed).toHaveLength(count)
      expect(envelope.changed.map(body => body.thread)).toEqual(shell.host.threads.slice(0, count))
      return true
    })
  })
  it('leaves the disabled payload exact and allocates no thread snapshots', () => {
    const shell = fixture(), legacy = new AgentStateBroadcaster(), disabled = new AgentStateBroadcaster({ streamingPublishCost: false })
    const clone = vi.spyOn(globalThis, 'structuredClone')
    for (let i = 0; i < 2; i++) {
      let expected: unknown
      legacy.send(shell, payload => { expected = payload; return true })
      disabled.send(shell, payload => { expect(payload).toEqual(expected); expect(payload.host.threads).toBe(shell.host.threads); return true })
    }
    expect(clone).not.toHaveBeenCalled()
    clone.mockRestore()
  })

  it('names first, unchanged, changed, reordered, deleted and readded content', () => {
    const broadcaster = new AgentStateBroadcaster({ streamingPublishCost: true }), shell = fixture()
    const send = (success = true): AgentThreadsBroadcast => { let envelope!: AgentThreadsBroadcast; broadcaster.send(shell, payload => { envelope = payload.host.threads as AgentThreadsBroadcast; return success }); return envelope }
    const first = send()
    expect(first.baseRevision).toBeNull()
    expect(first.changed.map(body => body.thread.id)).toEqual(['a', 'b'])
    expect(send().changed).toEqual([])
    // A whole new object equal by content is unchanged, but a nested mutation of the same object is not.
    shell.host.threads = structuredClone(shell.host.threads)
    expect(send().changed).toEqual([])
    shell.host.threads[0]!.summary!.lastAssistant!.text = 'Changed'
    shell.host.threads[0]!.worktree!.branch = 'next'
    const changed = send()
    expect(changed.changed.map(body => body.thread.id)).toEqual(['a'])
    shell.host.threads.reverse()
    const reordered = send()
    expect(reordered.roster.map(body => body.id)).toEqual(['b', 'a'])
    expect(reordered.changed).toEqual([])
    const removed = shell.host.threads.pop()!
    expect(send().roster.map(body => body.id)).toEqual(['b'])
    shell.host.threads.push(removed)
    const readded = send()
    expect(readded.changed[0]!.revision).toBeGreaterThan(changed.changed[0]!.revision)
    shell.host.threads.push(agentThread({ id: 'other-host:a', hostId: 'aaaaaaaa-0000-4000-8000-000000000000' }))
    expect(send().changed[0]!.thread.id).toBe('other-host:a')
  })

  it('advances delivery only on success and isolates its snapshots from callback edits', () => {
    const broadcaster = new AgentStateBroadcaster({ streamingPublishCost: true }), shell = fixture()
    let first!: AgentThreadsBroadcast
    broadcaster.send(shell, payload => { first = payload.host.threads as AgentThreadsBroadcast; return false })
    broadcaster.send(shell, payload => { expect((payload.host.threads as AgentThreadsBroadcast).baseRevision).toBeNull(); return true })
    shell.host.threads[0]!.title = 'Update'
    broadcaster.send(shell, () => false)
    broadcaster.send(shell, payload => {
      const envelope = payload.host.threads as AgentThreadsBroadcast
      expect(envelope.changed).toHaveLength(1)
      envelope.changed[0]!.thread.title = 'Callback edits'
      envelope.roster[0]!.revision = 999
      shell.host.threads[0]!.title = 'Live callback edit'
      return true
    })
    broadcaster.send(shell, payload => { expect((payload.host.threads as AgentThreadsBroadcast).changed[0]!.thread.title).toBe('Live callback edit'); return true })
    expect(first.changed[0]!.thread.title).not.toBe('Live callback edit')
  })

  it('does not let receipts certify delivery, and resets force a complete next broadcast', () => {
    const broadcaster = new AgentStateBroadcaster({ streamingPublishCost: true }), shell = fixture()
    expect(broadcaster.encodeReceipt(shell).host.threads).toEqual(shell.host.threads)
    broadcaster.send(shell, payload => { expect((payload.host.threads as AgentThreadsBroadcast).changed).toHaveLength(2); return true })
    broadcaster.send(shell, () => { broadcaster.resetThreadDelivery(); return true })
    broadcaster.send(shell, payload => { expect((payload.host.threads as AgentThreadsBroadcast).baseRevision).toBeNull(); return true })
  })

  it('detects nested same-reference usage, requests and configuration without changing other bodies', () => {
    const broadcaster = new AgentStateBroadcaster({ streamingPublishCost: true }), shell = fixture()
    const thread = shell.host.threads[0]!
    thread.usage = { rateVersions: ['test'], partial: false, updatedAt: 'today', total: { input: 1 } }
    broadcaster.send(shell, () => true)
    thread.usage.total!.input = 2
    thread.requests.push({ id: 'question', kind: 'question', text: 'Which option?', options: [] })
    thread.runtimeMode = 'full-access'
    broadcaster.send(shell, payload => {
      const envelope = payload.host.threads as AgentThreadsBroadcast
      expect(envelope.changed).toHaveLength(1)
      expect(envelope.changed[0]!.thread).toEqual(thread)
      return true
    })
  })

  it('owns schema data and safely falls back for non-schema graph values', () => {
    const thread = agentThread()
    const dangerous = JSON.parse('{"__proto__":{"owned":true},"constructor":{"value":"own"}}') as Record<string, unknown>
    Object.assign(thread, { extra: dangerous })
    const copied = cloneAgentThread(thread) as typeof thread & { extra: typeof dangerous }
    expect(Object.prototype.hasOwnProperty.call(copied.extra, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(copied.extra)).toBe(Object.prototype)
    expect(copied.extra).toEqual(dangerous)
    expect(copied.extra).not.toBe(dangerous)
    const date = new Date(), input = Object.assign(thread, { first: date, second: date, graph: new Map([['self', thread]]) })
    const native = cloneAgentThread(input) as typeof input
    expect(native.first).toEqual(date)
    expect(native.first).not.toBe(date)
    expect(native.first).toBe(native.second)
    expect(native.graph.get('self')).toBe(native)
  })
})
