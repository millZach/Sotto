// @vitest-environment node
import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it } from 'vitest'
import { MAX_AGENT_ACTIVITIES, findAgentActivity, isTerminalActivity, mergeAgentActivities, withoutCutActivities, type AgentActivity } from '../../../src/shared/agentActivity'

type Same = (next: AgentActivity, old: AgentActivity) => boolean
const terminalAgent = (status: string): boolean => ['completed', 'failed', 'errored', 'interrupted', 'shutdown', 'notFound'].includes(status)
/**
 * The merge as it was before it read the window in one pass (main at e25a5361f), with the Claude projector's
 * `mergeChanged` around it for `same`. The merge must give exactly what this gives, for any list it is handed.
 */
function reference(previous: readonly AgentActivity[], incoming: readonly AgentActivity[], same?: Same): AgentActivity[] {
  const records = new Map(previous.map(record => [record.id, record]))
  let sequence = previous.reduce((next, record) => Math.max(next, record.sequence + 1), 0)
  for (const record of incoming) {
    const old = records.get(record.id)
    if (old && isTerminalActivity(old.status) && !isTerminalActivity(record.status)) continue
    records.set(record.id, old ? { ...old, ...record, sequence: old.sequence,
      ...(old.afterMessageId ? { afterMessageId: old.afterMessageId } : {}),
      ...(old.startedAt ? { startedAt: old.startedAt, timingSource: old.timingSource } : {}),
      ...(old.completedAt && isTerminalActivity(old.status) ? { completedAt: old.completedAt } : {}),
      ...(record.agents ? { agents: record.agents.map(agent => {
        const prior = old.agents?.find(candidate => candidate.id === agent.id)
        if (prior && prior.assignmentId === agent.assignmentId && terminalAgent(prior.status) && !terminalAgent(agent.status)) return prior
        return prior && prior.assignmentId !== undefined && agent.assignmentId !== undefined && prior.assignmentId !== agent.assignmentId ? agent : { ...prior, ...agent }
      }) } : {}),
    } : { ...record, sequence: sequence++ })
  }
  const sorted = [...records.values()].sort((a, b) => a.sequence - b.sequence)
  const bounded = sorted.slice(-MAX_AGENT_ACTIVITIES)
  if (sorted.length > bounded.length && bounded[0]) bounded[0] = { ...bounded[0], truncated: true }
  if (!same || bounded.length !== previous.length) return bounded
  for (const [index, record] of bounded.entries()) if (record !== previous[index] && !same(record, previous[index]!)) return bounded
  return previous as AgentActivity[]
}

let seed = 7
const random = (): number => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648 }
const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!
const statuses: AgentActivity['status'][] = ['running', 'unknown', 'completed', 'failed', 'interrupted']
const row = (id: string, extra: Partial<AgentActivity> = {}): AgentActivity => ({ id, turnId: 'turn', sequence: 0, kind: 'tool', title: id, status: pick(statuses),
  ...(random() < 0.3 ? { startedAt: '2026-10-01T00:00:00.000Z', timingSource: 'provider' as const } : {}),
  ...(random() < 0.3 ? { agents: [{ id: `agent-${Math.floor(random() * 4)}`, status: pick(['running', 'completed']), assignmentId: `a-${Math.floor(random() * 2)}` }] } : {}), ...extra })

/** The merge and the reference agree on this list, including on whether `previous` itself comes back. */
function agree(previous: AgentActivity[], incoming: AgentActivity[], same?: Same): AgentActivity[] {
  const before = previous.map(record => ({ ...record }))
  const expected = reference(previous, incoming, same)
  const merged = mergeAgentActivities(previous, incoming, same)
  expect(merged).toEqual(expected)
  expect(merged === previous).toBe(expected === previous)
  expect(previous, 'The merge does not change the list it is given.').toEqual(before)
  for (const record of incoming) expect(findAgentActivity(merged, record.id)).toBe(merged.find(candidate => candidate.id === record.id))
  return merged
}

describe('mergeAgentActivities', () => {
  it('gives what the reference merge gives through 300 random upserts, edits in place, the bound and `same`', () => {
    let list = mergeAgentActivities([], Array.from({ length: MAX_AGENT_ACTIVITIES - 40 }, (_, index) => row(`r-${index}`)))
    let next = MAX_AGENT_ACTIVITIES - 40
    let sorted = 0, deduplicated = 0, cut = 0
    for (let step = 0; step < 300; step++) {
      // Some lists come back changed in place: out of order, with an id held twice, or with a sequence moved.
      const edit = random()
      if (edit < 0.05) { list.reverse(); sorted++ }
      else if (edit < 0.1) { list[Math.floor(random() * list.length)] = { ...list[Math.floor(random() * list.length)]! }; deduplicated++ }
      else if (edit < 0.15) { const at = Math.floor(random() * list.length); list[at] = { ...list[at]!, sequence: Math.floor(random() * 3 * MAX_AGENT_ACTIVITIES) } }
      const incoming = Array.from({ length: 1 + Math.floor(random() * 4) }, () => random() < 0.4 ? row(`r-${next++}`)
        : row(list[Math.floor(random() * list.length)]!.id, random() < 0.5 ? { text: `step ${step}` } : {}))
      if (random() < 0.2) incoming.push({ ...incoming[0]!, status: pick(statuses), output: 'repeated' })
      const before = list.length
      list = agree(list, incoming, random() < 0.5 ? isDeepStrictEqual : undefined)
      if (list[0]?.truncated && before === MAX_AGENT_ACTIVITIES) cut++
    }
    // The run did reach each path it is meant to check.
    expect([sorted, deduplicated, cut].every(count => count > 0)).toBe(true)
    expect(list).toHaveLength(MAX_AGENT_ACTIVITIES)
  })

  it('merges a list whose record was renamed in place since it was returned', () => {
    const list = mergeAgentActivities([], [row('a', { status: 'running' }), row('b', { status: 'running' })])
    list[1] = { ...list[1]!, id: 'c' }
    const merged = agree(list, [row('c', { status: 'completed' })])
    expect(merged.map(record => record.id)).toEqual(['a', 'c'])
    expect(findAgentActivity(merged, 'c')?.status).toBe('completed')
  })

  it('puts a list reversed in place back in sequence order', () => {
    const list = mergeAgentActivities([], [row('a', { status: 'running' }), row('b', { status: 'running' })])
    list.reverse()
    expect(agree(list, [row('d', { status: 'running' })]).map(record => record.id)).toEqual(['a', 'b', 'd'])
  })

  it('gives a new record the sequence after one moved in place', () => {
    const list = mergeAgentActivities([], [row('a', { status: 'running' }), row('b', { status: 'running' })])
    list[1] = { ...list[1]!, sequence: 99 }
    expect(agree(list, [row('d', { status: 'running' })]).at(-1)).toMatchObject({ id: 'd', sequence: 100 })
  })

  it('keeps a full list it was given when `same` finds the bounded merge unchanged, even past the bound', () => {
    const list = mergeAgentActivities([], Array.from({ length: MAX_AGENT_ACTIVITIES }, (_, index) => row(`r-${index}`)))
    expect(agree(list, [row('new', { status: 'running' })], () => true)).toBe(list)
    expect(agree(list, [row('new', { status: 'running' })])).not.toBe(list)
  })
})

describe('withoutCutActivities', () => {
  const step = (n: number): AgentActivity => ({ id: `step-${n}`, turnId: 'turn', sequence: n, kind: 'tool', title: 'Ran', status: 'completed' })
  const order = (records: readonly AgentActivity[]) => records.map(record => Number(record.id.slice(5)))

  it('keeps a list at the limit in step order once its provider takes a record back (#2330)', () => {
    // The provider takes back a record the workspace, whose merge never removes, keeps. From then on the workspace cuts
    // one old step more than the provider does, and the provider's next list starts on it.
    const run = (guarded: boolean) => {
      let provider = Array.from({ length: 1600 }, (_, n) => step(n))
      let held = mergeAgentActivities([], provider)
      provider = provider.filter(record => record.id !== 'step-1500')
      const merge = () => { held = mergeAgentActivities(held, guarded ? withoutCutActivities(held, provider, provider) : provider) }
      for (let n = 1600; n < 2600; n += 10) {
        provider = mergeAgentActivities(provider, Array.from({ length: 10 }, (_, k) => step(n + k)))
        // Published, then read: the same list merged twice.
        merge(); merge()
      }
      return held
    }
    const unguarded = order(run(false))
    expect(unguarded.some((value, index) => index > 0 && value < unguarded[index - 1]!), 'merged as new, cut steps come back numbered past newer ones').toBe(true)
    const guarded = run(true)
    expect(order(guarded)).toEqual([...order(guarded)].sort((a, b) => a - b))
    expect(order(guarded).at(-1)).toBe(2599)
    expect(guarded).toHaveLength(MAX_AGENT_ACTIVITIES)
  })

  it('leaves a list that has cut nothing, a provider list that starts on a held record, and a new record listed first alone', () => {
    const at = (second: number) => new Date(Date.UTC(2026, 10, 8, 0, 0, second)).toISOString()
    const full = Array.from({ length: MAX_AGENT_ACTIVITIES }, (_, n) => ({ ...step(n + 10), startedAt: at(n + 10) }))
    const list = [step(5), full[0]!, step(9999)]
    expect(withoutCutActivities(full.slice(1), list, list)).toBe(list)
    const held = list.slice(1)
    expect(withoutCutActivities(full, held, held)).toBe(held)
    expect(withoutCutActivities(full, [step(1), step(2)], [step(2)])).toEqual([step(2)])
    // Only the changed records come in: the cut one stays out of them too.
    expect(withoutCutActivities(full, list, [step(5), step(9999)])).toEqual([step(9999)])
    // One that started after the oldest record held is new, however the provider lists it.
    const live = { ...step(9998), startedAt: at(5000) }
    expect(withoutCutActivities(full, [live, ...list], [live, step(5)])).toEqual([live])
  })

  it('still leaves the cut records out once a record is taken out of a list at the limit', () => {
    // Merged past the limit, the list marks its first record cut; taking a record out leaves it one short of the limit.
    const held = mergeAgentActivities([], Array.from({ length: MAX_AGENT_ACTIVITIES + 1 }, (_, n) => step(n))).filter(record => record.id !== 'step-100')
    expect(held).toHaveLength(MAX_AGENT_ACTIVITIES - 1)
    const list = Array.from({ length: MAX_AGENT_ACTIVITIES + 1 }, (_, n) => step(n)).filter(record => record.id !== 'step-100')
    expect(withoutCutActivities(held, list, list).map(record => record.id)).not.toContain('step-0')
  })
})
