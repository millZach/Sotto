// @vitest-environment node
/**
 * The page puts a broadcast's whole thread array back from the records main sends it (issue #1330, ADR-0028's
 * October 22 amendment). Every case runs main's own `AgentStateBroadcaster` and the page's own `wrapAgentBridge`, with
 * each payload copied by structured clone as Electron copies it, and checks that every state the page delivers is the
 * state main broadcast: the same records in the same order, whatever was sent, lost or read again in between.
 */
import { describe, expect, it, vi } from 'vitest'
import { AgentStateBroadcaster } from '../../../src/main/agents/agentStateBroadcast'
import { wrapAgentBridge } from '../../../src/renderer/src/agents/agentStateCatalogs'
import { createThreadReassembly } from '../../../src/renderer/src/agents/agentStateThreads'
import { createStateSharing } from '../../../src/renderer/src/agents/stateSharing'
import type { AgentModel, AgentState, AgentStateBroadcast, AgentThread, AgentWireBridge } from '../../../src/shared/agents'
import { agentThread, threadsStateFixture } from '../../fixtures/agentState'

const MODELS: AgentModel[] = [{ id: 'gpt-5', provider: 'codex', name: 'gpt-5', ready: true }]

function shell(threads: readonly AgentThread[]): AgentState {
  return threadsStateFixture({ cloneOverrides: false, host: { hostId: 'aaaaaaaa-0000-4000-8000-000000000000', models: MODELS, threads: [...threads] } })
}

/**
 * Main and one window between them: `publish` broadcasts a shell as `src/main/index.ts` does; `lose` makes the next
 * delivery report success without reaching the page, as a message sent while a window reloads does; the page's `get()`
 * reads the current shell and tells the broadcaster, as `AGENT_GET` does.
 */
function wire() {
  const broadcaster = new AgentStateBroadcaster()
  let current: AgentState = shell([])
  let listener: ((raw: unknown) => void) | null = null
  let lost = 0
  const get = vi.fn(async (): Promise<AgentState> => { broadcaster.windowRead(); return structuredClone(current) })
  const bridge = { get, command: vi.fn(), onState: (next: (raw: unknown) => void) => { listener = next; return () => { listener = null } } } as unknown as AgentWireBridge
  const delivered: AgentState[] = []
  const subscribe = (): void => { wrapAgentBridge(bridge).onState(state => delivered.push(state)) }
  const publish = (state: AgentState, ok = true): void => {
    current = state
    broadcaster.send(state, (payload: AgentStateBroadcast) => {
      if (!ok) return false
      if (lost > 0) { lost--; return true }
      listener?.(structuredClone(payload))
      return true
    })
  }
  return { broadcaster, get, delivered, subscribe, publish, lose: () => { lost++ }, emit: (raw: unknown) => listener?.(raw) }
}

/** A small seeded generator, so a failure names a sequence that can be run again. */
function random(seed: number): () => number {
  let value = seed
  return () => { value = (value * 1_103_515_245 + 12_345) % 2_147_483_648; return value / 2_147_483_648 }
}

describe('the page puts the broadcast thread array back (#1330)', () => {
  it('delivers exactly the state main broadcast, through changes, additions, removals and moves', () => {
    const { delivered, subscribe, publish, get } = wire()
    subscribe()
    const states: AgentState[] = []
    const send = (threads: AgentThread[]): void => { const state = shell(threads); states.push(state); publish(state) }
    const a = agentThread({ id: 'a', title: 'A' }), b = agentThread({ id: 'b', title: 'B' }), c = agentThread({ id: 'c', title: 'C' })
    send([a, b, c])
    send([{ ...a }, { ...b, status: 'running' }, { ...c }])
    send([{ ...c }, { ...a }])
    send([agentThread({ id: 'd', title: 'D' }), { ...c }, { ...a, title: 'A again' }])
    send([])
    send([{ ...b }])
    expect(get).not.toHaveBeenCalled()
    expect(delivered).toEqual(states)
  })

  it('hands back the record it holds for a thread that did not change', () => {
    const { delivered, subscribe, publish } = wire()
    subscribe()
    const a = agentThread({ id: 'a' }), b = agentThread({ id: 'b' })
    publish(shell([a, b]))
    publish(shell([{ ...a }, { ...b, title: 'Changed' }]))
    expect(delivered[1]!.host.threads[0]).toBe(delivered[0]!.host.threads[0])
    expect(delivered[1]!.host.threads[1]).not.toBe(delivered[0]!.host.threads[1])
    expect(delivered[1]!.host.threads).not.toBe(delivered[0]!.host.threads)
  })

  it('reads the whole state when a broadcast it never received is the base, then takes the complete broadcast that follows', async () => {
    const { delivered, subscribe, publish, lose, get } = wire()
    subscribe()
    const a = agentThread({ id: 'a' }), b = agentThread({ id: 'b' })
    publish(shell([a, b]))
    lose()
    publish(shell([{ ...a, title: 'Lost' }, { ...b }]))
    const third = shell([{ ...a, title: 'Lost' }, { ...b, status: 'running' }])
    publish(third)
    await vi.waitFor(() => expect(delivered).toHaveLength(2))
    expect(get).toHaveBeenCalledTimes(1)
    expect(delivered[1]).toEqual(third)
    await new Promise(resolve => { setImmediate(resolve) })
    const fourth = shell([{ ...a, title: 'Lost' }, { ...b, status: 'idle' }])
    publish(fourth)
    expect(delivered[2]).toEqual(fourth)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('gives a page that loads again the whole state first, from its own read', async () => {
    const { delivered, subscribe, publish, get } = wire()
    subscribe()
    const a = agentThread({ id: 'a' })
    publish(shell([a]))
    // A reload runs the page fresh: a new wrapper with nothing held, which reads the whole state as it starts.
    subscribe()
    await get()
    const next = shell([{ ...a, title: 'After the reload' }])
    publish(next)
    expect(delivered.at(-1)).toEqual(next)
  })

  it('stays equal to main over a long run with lost messages, failed sends and reads', async () => {
    for (const seed of [1, 7, 42]) {
      const next = random(seed)
      const { delivered, subscribe, publish, lose } = wire()
      subscribe()
      let threads: AgentThread[] = Array.from({ length: 6 }, (_, index) => agentThread({ id: `t${index}`, title: `T${index}` }))
      let made = threads.length, losing = 0
      // The state the page should show: the newest one that reached it, or that its read of the whole state answered.
      let shown: AgentState | undefined
      for (let step = 0; step < 200; step++) {
        const roll = next()
        if (roll < 0.25 && threads.length) { const index = Math.floor(next() * threads.length); threads[index] = { ...threads[index]!, title: `T${step}` } }
        else if (roll < 0.35) threads.splice(Math.floor(next() * (threads.length + 1)), 0, agentThread({ id: `t${made++}` }))
        else if (roll < 0.45 && threads.length) threads.splice(Math.floor(next() * threads.length), 1)
        else if (roll < 0.55 && threads.length > 1) threads.reverse()
        threads = threads.map(thread => ({ ...thread }))
        if (next() < 0.05) { lose(); losing++ }
        const state = shell(threads), ok = next() > 0.05
        publish(state, ok)
        if (ok && losing > 0) losing--
        else if (ok) shown = state
        await new Promise(resolve => { setImmediate(resolve) })
        if (shown !== undefined) expect(delivered.at(-1)).toEqual(shown)
      }
    }
  })

  it('stays equal to main when broadcasts arrive while its read of the whole state is in flight', async () => {
    const settle = async (): Promise<void> => { for (let turn = 0; turn < 3; turn++) await new Promise(resolve => { setImmediate(resolve) }) }
    for (const seed of [3, 11, 99]) {
      const next = random(seed)
      const broadcaster = new AgentStateBroadcaster()
      let current: AgentState = shell([])
      let listener: ((raw: unknown) => void) | null = null
      // Main handles a read some time after the page asks, as `AGENT_GET` does: broadcasts sent before then reach the
      // page while it waits, measured from the base main held, and only those sent after it follow the answer.
      const reads: Array<() => void> = []
      const get = vi.fn(() => new Promise<AgentState>(resolve => { reads.push(() => { broadcaster.windowRead(); resolve(structuredClone(current)) }) }))
      const bridge = { get, command: vi.fn(), onState: (next: (raw: unknown) => void) => { listener = next; return () => { listener = null } } } as unknown as AgentWireBridge
      const delivered: AgentState[] = []
      wrapAgentBridge(bridge).onState(state => delivered.push(state))
      let threads: AgentThread[] = Array.from({ length: 5 }, (_, index) => agentThread({ id: `t${index}`, title: `T${index}` }))
      let made = threads.length, lost = 0
      for (let step = 0; step < 300; step++) {
        const roll = next()
        if (roll < 0.3 && threads.length) { const index = Math.floor(next() * threads.length); threads[index] = { ...threads[index]!, title: `T${step}` } }
        else if (roll < 0.4) threads.splice(Math.floor(next() * (threads.length + 1)), 0, agentThread({ id: `t${made++}` }))
        else if (roll < 0.5 && threads.length) threads.splice(Math.floor(next() * threads.length), 1)
        else if (roll < 0.55 && threads.length > 1) threads.reverse()
        threads = threads.map(thread => ({ ...thread }))
        const state = shell(threads)
        current = state
        const reached = next() > 0.08
        if (!reached) lost++
        broadcaster.send(state, payload => { if (reached) listener?.(structuredClone(payload)); return true })
        // Applied at once, unless the page is waiting on a read or this broadcast sent it to one.
        if (reached && reads.length === 0) expect(delivered.at(-1)).toEqual(state)
        if (reads.length > 0 && next() < 0.4) {
          for (const read of reads.splice(0)) read()
          await settle()
          // The answer is the newest state; nothing kept while it was in flight is shown after it.
          expect(delivered.at(-1)).toEqual(current)
          expect(reads).toHaveLength(0)
        }
      }
      for (const read of reads.splice(0)) read()
      await settle()
      const last = shell(threads.map(thread => ({ ...thread, title: `${thread.title} last` })))
      current = last
      broadcaster.send(last, payload => { listener?.(structuredClone(payload)); return true })
      // Measured from a broadcast the page lost, it sends the page to a read once more.
      for (const read of reads.splice(0)) read()
      await settle()
      expect(delivered.at(-1)).toEqual(last)
      // Each lost broadcast costs at most one read, and the complete broadcast after it settles the page again.
      expect(get.mock.calls.length).toBeLessThanOrEqual(lost)
    }
  })

  it('reads the whole state rather than deliver threads it cannot put back', async () => {
    const { delivered, subscribe, emit, get } = wire()
    subscribe()
    const base = shell([agentThread({ id: 'a' })])
    const payload = (threads: unknown): unknown => ({ ...base, host: { ...base.host, models: { revision: 1, models: MODELS }, threads } })
    emit(payload({ revision: 1, base: null, changed: base.host.threads }))
    expect(delivered).toHaveLength(1)
    for (const threads of [
      base.host.threads,
      { revision: 2, base: 9, changed: [] },
      { revision: 2, base: 1, changed: [agentThread({ id: 'new' })] },
      { revision: 2, base: 1, changed: [], removed: ['missing'], order: [] },
      { revision: 2, base: 1, changed: [], order: ['a', 'a'] },
      { revision: 2, base: 1, changed: [], order: ['b'] },
      { revision: 2, base: 1, changed: [], order: [] },
    ]) {
      get.mockClear()
      const before = delivered.length
      emit(payload(threads))
      expect(delivered).toHaveLength(before)
      expect(get).toHaveBeenCalledTimes(1)
      // The read answers with the whole state, and only once it has settled does the next broadcast get its own look.
      await vi.waitFor(() => expect(delivered).toHaveLength(before + 1))
      await new Promise(resolve => { setImmediate(resolve) })
    }
  })
})

describe('createThreadReassembly', () => {
  it('changes nothing it holds for a broadcast it cannot apply', () => {
    const reassemble = createThreadReassembly()
    const a = agentThread({ id: 'a' })
    expect(reassemble({ revision: 1, base: null, changed: [a] })).toEqual([a])
    expect(reassemble({ revision: 2, base: 1, changed: [agentThread({ id: 'b' })] })).toBeUndefined()
    const renamed = { ...a, title: 'Renamed' }
    expect(reassemble({ revision: 3, base: 1, changed: [renamed] })).toEqual([renamed])
  })
})

describe('createStateSharing with records the page hands back', () => {
  it('meets a record it reconciled before by identity, and still answers with what it was handed', () => {
    const share = createStateSharing()
    const shown = { threads: [agentThread({ id: 'a', title: 'A' }), agentThread({ id: 'b', title: 'B' })] }
    // The page holds the records of a broadcast; equal to what is shown, but not the same objects.
    const held = structuredClone(shown.threads)
    const first = share(shown, { threads: [...held] })
    expect(first).toBe(shown)
    // The next broadcast hands back the same held records: the result is the state already shown.
    expect(share(first, { threads: [...held] })).toBe(shown)
    // Against a state shown since that differs, a remembered record is still answered with what it holds.
    const renamed = { threads: [{ ...shown.threads[0]!, title: 'Renamed' }, shown.threads[1]!] }
    const after = share(renamed, { threads: [...held] })
    expect(after).toEqual({ threads: held })
    expect(after.threads[1]).toBe(shown.threads[1])
  })
})
