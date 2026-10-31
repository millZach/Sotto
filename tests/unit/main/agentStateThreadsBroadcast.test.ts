// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { AgentStateBroadcaster, samePlainData } from '../../../src/main/agents/agentStateBroadcast'
import type { AgentState, AgentStateBroadcast, AgentThread } from '../../../src/shared/agents'
import { agentThread, threadsStateFixture } from '../../fixtures/agentState'

/** A shell with these threads, built afresh each time as the router builds one on every publish. */
function shell(threads: readonly AgentThread[]): AgentState {
  return threadsStateFixture({ cloneOverrides: false, host: { threads: [...threads] } })
}

/** Each thread rebuilt as a new record holding the same parts, as the router and `clientAgentState` rebuild them. */
const rebuilt = (threads: readonly AgentThread[]): AgentThread[] => threads.map(thread => ({ ...thread }))

function recorder(): { sent: AgentStateBroadcast[]; deliver: (payload: AgentStateBroadcast) => boolean } {
  const sent: AgentStateBroadcast[] = []
  return { sent, deliver: payload => { sent.push(payload); return true } }
}

const threads = (): AgentThread[] => [
  agentThread({ id: 'one', title: 'One', summary: { messageCount: 2, activityCount: 0, lastUser: { id: 'u1', text: 'Hello', createdAt: '2026-10-22T00:00:00.000Z' } } }),
  agentThread({ id: 'two', title: 'Two', requests: [] }),
  agentThread({ id: 'three', title: 'Three', worktree: { mode: 'independent', status: 'ready', path: 'D:/w', branch: 'sotto/abc' } }),
]

describe('AgentStateBroadcaster thread records (#1330)', () => {
  it('lists every thread the first time, then only the records that changed', () => {
    const broadcaster = new AgentStateBroadcaster()
    const { sent, deliver } = recorder()
    const first = threads()
    broadcaster.send(shell(first), deliver)
    expect(sent[0]!.host.threads).toEqual({ revision: 1, base: null, changed: first })

    broadcaster.send(shell(rebuilt(first)), deliver)
    expect(sent[1]!.host.threads).toEqual({ revision: 2, base: 1, changed: [] })

    const next = rebuilt(first)
    next[1] = { ...next[1]!, status: 'running' }
    broadcaster.send(shell(next), deliver)
    expect(sent[2]!.host.threads).toEqual({ revision: 3, base: 2, changed: [next[1]] })
  })

  it('takes equal data in new objects as unchanged, as a remote host\'s push carries it', () => {
    const broadcaster = new AgentStateBroadcaster()
    const { sent, deliver } = recorder()
    broadcaster.send(shell(threads()), deliver)
    broadcaster.send(shell(structuredClone(threads())), deliver)
    expect(sent[1]!.host.threads.changed).toEqual([])
  })

  it('names the threads that went and the new order, and sends a new thread whole', () => {
    const broadcaster = new AgentStateBroadcaster()
    const { sent, deliver } = recorder()
    const [one, two, three] = threads()
    broadcaster.send(shell([one!, two!, three!]), deliver)
    const four = agentThread({ id: 'four', title: 'Four' })
    broadcaster.send(shell([four, ...rebuilt([three!, one!])]), deliver)
    expect(sent[1]!.host.threads).toEqual({ revision: 2, base: 1, changed: [four], removed: ['two'], order: ['four', 'three', 'one'] })
    // A move alone carries the order and no record.
    broadcaster.send(shell(rebuilt([one!, four, three!])), deliver)
    expect(sent[2]!.host.threads).toEqual({ revision: 3, base: 2, changed: [], order: ['one', 'four', 'three'] })
  })

  it('measures from the last broadcast delivered, never from one that failed', () => {
    const broadcaster = new AgentStateBroadcaster()
    const { sent, deliver } = recorder()
    const first = threads()
    broadcaster.send(shell(first), deliver)
    const changed = rebuilt(first)
    changed[0] = { ...changed[0]!, title: 'Renamed' }
    const failed: AgentStateBroadcast[] = []
    expect(broadcaster.send(shell(changed), payload => { failed.push(payload); return false })).toBe(false)
    expect(failed[0]!.host.threads).toMatchObject({ base: 1, changed: [changed[0]] })
    broadcaster.send(shell(rebuilt(changed)), deliver)
    expect(sent[1]!.host.threads).toEqual({ revision: 3, base: 1, changed: [changed[0]] })
  })

  it('lists every thread again after the window reads the whole state', () => {
    const broadcaster = new AgentStateBroadcaster()
    const { sent, deliver } = recorder()
    const first = threads()
    broadcaster.send(shell(first), deliver)
    broadcaster.windowRead()
    broadcaster.send(shell(rebuilt(first)), deliver)
    expect(sent[1]!.host.threads).toMatchObject({ base: null, changed: first })
    broadcaster.send(shell(rebuilt(first)), deliver)
    expect(sent[2]!.host.threads).toEqual({ revision: 3, base: 2, changed: [] })
  })

  it('takes no base from a send the window read the whole state during', () => {
    const broadcaster = new AgentStateBroadcaster()
    const { sent, deliver } = recorder()
    const first = threads()
    broadcaster.send(shell(first), deliver)
    broadcaster.send(shell(rebuilt(first)), payload => { sent.push(payload); broadcaster.windowRead(); return true })
    broadcaster.send(shell(rebuilt(first)), deliver)
    expect(sent.map(payload => payload.host.threads.base)).toEqual([null, 1, null])
  })

  it('lists every thread, and keeps no base, while two records share an ID', () => {
    const broadcaster = new AgentStateBroadcaster()
    const { sent, deliver } = recorder()
    const twins = [agentThread({ id: 'same', title: 'A' }), agentThread({ id: 'same', title: 'B' })]
    broadcaster.send(shell(twins), deliver)
    broadcaster.send(shell(rebuilt(twins)), deliver)
    expect(sent.map(payload => payload.host.threads.base)).toEqual([null, null])
    expect(sent[1]!.host.threads.changed).toEqual(twins)
  })

  it('leaves every thread in a command receipt, and a receipt moves no base', () => {
    const broadcaster = new AgentStateBroadcaster()
    const { sent, deliver } = recorder()
    const first = threads()
    broadcaster.send(shell(first), deliver)
    const changed = rebuilt(first)
    changed[2] = { ...changed[2]!, status: 'error' }
    expect(broadcaster.encodeReceipt(shell(changed)).host.threads).toEqual(changed)
    broadcaster.send(shell(rebuilt(changed)), deliver)
    expect(sent[1]!.host.threads).toEqual({ revision: 2, base: 1, changed: [changed[2]] })
  })

  it('gives a reply asked for as changes only the records changed since the last broadcast, and moves no base', () => {
    const broadcaster = new AgentStateBroadcaster()
    const { sent, deliver } = recorder()
    const first = threads()
    // No broadcast yet: the reply lists every thread, as a complete broadcast does.
    expect(broadcaster.encodeChangedThreadRecordsReceipt(shell(first)).host.threads).toMatchObject({ base: null, changed: first })
    broadcaster.send(shell(first), deliver)
    const held = sent[0]!.host.threads.revision
    const changed = rebuilt(first)
    changed[2] = { ...changed[2]!, status: 'error' }
    const reply = broadcaster.encodeChangedThreadRecordsReceipt(shell(changed))
    expect(reply.host.threads).toMatchObject({ base: held, changed: [changed[2]] })
    expect(reply.host.threads.removed).toBeUndefined()
    expect(reply.host.threads.order).toBeUndefined()
    // The next broadcast is measured from the same one, and carries the same change.
    broadcaster.send(shell(rebuilt(changed)), deliver)
    expect(sent[1]!.host.threads).toMatchObject({ base: held, changed: [changed[2]] })
    // After the window read the whole state, a reply lists every thread again.
    broadcaster.windowRead()
    expect(broadcaster.encodeChangedThreadRecordsReceipt(shell(changed)).host.threads).toMatchObject({ base: null, changed })
  })
})

describe('samePlainData', () => {
  it('answers as isDeepStrictEqual does for the data a shell holds', () => {
    expect(samePlainData({ a: [1, { b: 'c' }] }, { a: [1, { b: 'c' }] })).toBe(true)
    expect(samePlainData({ a: [1, { b: 'c' }] }, { a: [1, { b: 'd' }] })).toBe(false)
    expect(samePlainData({ a: undefined }, {})).toBe(false)
    expect(samePlainData({}, { a: undefined })).toBe(false)
    expect(samePlainData([1, 2], [1, 2, 3])).toBe(false)
    expect(samePlainData([1], { 0: 1 })).toBe(false)
    expect(samePlainData(null, {})).toBe(false)
    expect(samePlainData(0, -0)).toBe(false)
    expect(samePlainData(Number.NaN, Number.NaN)).toBe(true)
    expect(samePlainData(Object.create(null) as object, {})).toBe(false)
    expect(samePlainData({ a: { b: [1, { c: null }] } }, { a: { b: [1, { c: undefined }] } })).toBe(false)
    expect(samePlainData({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(samePlainData(new Map([['a', 1]]), new Map([['a', 1]]))).toBe(true)
    expect(samePlainData(new Map([['a', 1]]), new Map([['a', 2]]))).toBe(false)
  })
})
