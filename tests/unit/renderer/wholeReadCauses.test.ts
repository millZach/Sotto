import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentStateBroadcaster } from '../../../src/main/agents/agentStateBroadcast'
import { onWholeRead, wrapAgentBridge, type WholeReadCause } from '../../../src/renderer/src/agents/agentStateCatalogs'
import type { AgentModel, AgentState, AgentThread, AgentWireBridge } from '../../../src/shared/agents'
import { agentThread, threadsStateFixture } from '../../fixtures/agentState'

const MODELS: AgentModel[] = [{ id: 'gpt-5', provider: 'codex', name: 'gpt-5', ready: true }]
const shell = (threads: readonly AgentThread[]): AgentState =>
  threadsStateFixture({ cloneOverrides: false, host: { hostId: 'aaaaaaaa-0000-4000-8000-000000000000', models: MODELS, threads: [...threads] } })
const settle = async (): Promise<void> => { for (let turn = 0; turn < 3; turn++) await new Promise(resolve => { setImmediate(resolve) }) }

const stops: (() => void)[] = []
afterEach(() => { for (const stop of stops.splice(0)) stop() })

/** Main and one window, the page's whole read answered as `AGENT_GET` answers it; `fail` makes the next read fail. */
function wire() {
  const broadcaster = new AgentStateBroadcaster()
  let current: AgentState = shell([])
  let listener: ((raw: unknown) => void) | null = null
  let lose = false, fail = 0
  const get = vi.fn(async () => {
    if (fail > 0) { fail--; throw new Error('The read did not reach main.') }
    broadcaster.windowRead()
    return structuredClone(current)
  })
  const bridge = { get, command: vi.fn(), onState: (next: (raw: unknown) => void) => { listener = next; return () => { listener = null } } } as unknown as AgentWireBridge
  return {
    bridge, get,
    lose: () => { lose = true },
    fail: (times: number) => { fail = times },
    publish: (state: AgentState) => {
      current = state
      broadcaster.send(state, payload => { if (!lose) listener?.(structuredClone(payload)); lose = false; return true })
    },
  }
}

describe('why the page reads the whole state (#2733)', () => {
  it('names each read it asks main for, by why, and only those', async () => {
    const causes: WholeReadCause[] = []
    stops.push(onWholeRead(cause => causes.push(cause)))
    const link = wire()
    const page = wrapAgentBridge(link.bridge)
    stops.push(page.onState(() => undefined))
    // The page's own first read is not one it needed to put anything back.
    await page.get()
    const threads = [agentThread({ id: 't0' }), agentThread({ id: 't1' })]
    link.publish(shell(threads))
    await settle()
    expect(causes).toEqual([])
    // A broadcast that never reached the page: the next is measured from it, and its kept parts are found missing first.
    link.lose()
    link.publish(shell([...threads].reverse()))
    link.publish(shell(threads))
    await settle()
    expect(causes).toEqual(['broadcastParts'])
    expect(link.get).toHaveBeenCalledTimes(2)
  })

  it('counts a read asked again after the first failed as two, and every request once', async () => {
    const causes: WholeReadCause[] = []
    stops.push(onWholeRead(cause => causes.push(cause)))
    const link = wire()
    const page = wrapAgentBridge(link.bridge)
    stops.push(page.onState(() => undefined))
    const threads = [agentThread({ id: 't0' }), agentThread({ id: 't1' })]
    link.publish(shell(threads))
    await settle()
    const before = link.get.mock.calls.length
    // The read a missed broadcast sets off fails; the next broadcast asks again, and that one is answered.
    link.lose()
    link.publish(shell([...threads].reverse()))
    link.fail(1)
    link.publish(shell(threads))
    await settle()
    link.publish(shell([...threads].reverse()))
    await settle()
    expect(causes.length).toBe(link.get.mock.calls.length - before)
    expect(causes.length).toBeGreaterThanOrEqual(2)
  })
})
