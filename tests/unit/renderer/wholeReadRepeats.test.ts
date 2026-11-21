import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentStateBroadcaster } from '../../../src/main/agents/agentStateBroadcast'
import { wrapAgentBridge } from '../../../src/renderer/src/agents/agentStateCatalogs'
import type { AgentModel, AgentState, AgentStateBroadcast, AgentThread, AgentThreadsBroadcast, AgentWireBridge } from '../../../src/shared/agents'
import { agentThread, threadsStateFixture } from '../../fixtures/agentState'

const MODELS: AgentModel[] = [{ id: 'gpt-5', provider: 'codex', name: 'gpt-5', ready: true }]
const shell = (threads: readonly AgentThread[]): AgentState =>
  threadsStateFixture({ cloneOverrides: false, host: { hostId: 'aaaaaaaa-0000-4000-8000-000000000000', models: MODELS, threads: [...threads] } })
const settle = async (): Promise<void> => { for (let turn = 0; turn < 3; turn++) await new Promise(resolve => { setImmediate(resolve) }) }
const threadsOf = (payload: AgentStateBroadcast): AgentThreadsBroadcast => payload.host.threads as unknown as AgentThreadsBroadcast

const stops: (() => void)[] = []
afterEach(() => { for (const stop of stops.splice(0)) stop() })

/**
 * Main and one window. A read of the whole state is answered as `AGENT_GET` answers the main window (`readWhole`), at the
 * moment main handles it; `holdAnswers` keeps answers from the page until `releaseAnswers`, so broadcasts main sends after
 * an answer can reach the page first, which Electron does not rule out.
 */
function wire() {
  const broadcaster = new AgentStateBroadcaster()
  let current: AgentState = shell([])
  let listener: ((raw: unknown) => void) | null = null
  let lose = false, holding = false
  const held: (() => void)[] = []
  const sent: AgentStateBroadcast[] = []
  const get = vi.fn(() => {
    const answer = structuredClone(broadcaster.readWhole(current))
    return new Promise<AgentState>(resolve => { if (holding) held.push(() => resolve(answer)); else resolve(answer) })
  })
  const bridge = { get, command: vi.fn(), onState: (next: (raw: unknown) => void) => { listener = next; return () => { listener = null } } } as unknown as AgentWireBridge
  return {
    bridge, get, sent,
    lose: () => { lose = true },
    holdAnswers: () => { holding = true },
    releaseAnswers: () => { holding = false; for (const answer of held.splice(0)) answer() },
    publish: (state: AgentState) => {
      current = state
      broadcaster.send(state, payload => { sent.push(payload); if (!lose) listener?.(structuredClone(payload)); lose = false; return true })
    },
  }
}

const six = (): AgentThread[] => Array.from({ length: 6 }, (_, index) => agentThread({ id: `t${index}`, title: `T${index}` }))
const retitled = (threads: readonly AgentThread[], index: number, title: string): AgentThread[] => threads.map((thread, at) => at === index ? { ...thread, title } : thread)

describe('the complete list after a whole read of the state (#2733)', () => {
  it('marks the records it repeats from the read, and the page keeps its own copies of them', async () => {
    const link = wire()
    const delivered: AgentState[] = []
    const page = wrapAgentBridge(link.bridge)
    stops.push(page.onState(state => delivered.push(state)))
    link.publish(shell(six()))
    await settle()
    const read = await page.get()
    expect(read).not.toHaveProperty('readRevision')
    const after = shell(retitled(read.host.threads, 2, 'Third'))
    link.publish(after)
    await settle()
    // Every record is listed, so the list can be taken in on its own; five of the six are marked as the read's.
    const list = threadsOf(link.sent.at(-1)!)
    expect(list.base).toBeNull()
    expect(list.changed).toHaveLength(after.host.threads.length)
    expect(list.repeats?.positions).toEqual(after.host.threads.map((_, at) => at).filter(at => at !== 2))
    // The page holds the state main sent, and the repeated records are the very objects of its read.
    expect(delivered.at(-1)).toEqual(after)
    const shown = delivered.at(-1)!.host.threads
    expect(shown.filter((thread, at) => thread === read.host.threads[at]).length).toBe(read.host.threads.length - 1)
    expect(shown[2]).not.toBe(read.host.threads[2])
    expect(link.get).toHaveBeenCalledTimes(1)
  })

  it('takes the list as it is when it reaches the page before the read’s answer, and reads nothing more', async () => {
    const link = wire()
    const delivered: AgentState[] = []
    const page = wrapAgentBridge(link.bridge)
    stops.push(page.onState(state => delivered.push(state)))
    link.publish(shell(six()))
    await settle()
    // A broadcast the page never received: the next sends it to read the whole state, whose answer is held back.
    link.lose()
    link.publish(shell(retitled(six(), 0, 'Lost')))
    link.holdAnswers()
    link.publish(shell(retitled(six(), 1, 'Second')))
    await settle()
    expect(link.get).toHaveBeenCalledTimes(1)
    // Main has answered; the complete list after it reaches the page before the answer does.
    const newest = shell(retitled(retitled(six(), 1, 'Second'), 4, 'Fifth'))
    link.publish(newest)
    link.releaseAnswers()
    await settle()
    const next = shell(retitled(newest.host.threads, 5, 'Sixth'))
    link.publish(next)
    await settle()
    expect(delivered.at(-1)).toEqual(next)
    expect(link.get).toHaveBeenCalledTimes(1)
  })

  it('takes a list naming another read as it is', async () => {
    const link = wire()
    const delivered: AgentState[] = []
    const page = wrapAgentBridge(link.bridge)
    stops.push(page.onState(state => delivered.push(state)))
    link.publish(shell(six()))
    await page.get()
    // Main is read again by a caller the page does not hear of, so the next list names a read the page never held.
    void link.get()
    const after = shell(retitled(six(), 3, 'Fourth'))
    link.publish(after)
    await settle()
    expect(threadsOf(link.sent.at(-1)!).repeats).toBeDefined()
    expect(delivered.at(-1)).toEqual(after)
  })
})
