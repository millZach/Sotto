// @vitest-environment node
/**
 * What the iPhone's Agents read (ADR-0103) touches of delegation's record, counted rather than timed (#1291), beside
 * `ownerScaleWorkBudget.perf.test.ts`. A read is a user action, and the record keeps every delegation the user's threads
 * made, up to its bound, so a read that walked all of it grew with the user's history. The read may touch the
 * delegations and refusals of the threads it shows and no others: it stays flat as unrelated history grows. It counts the
 * records read and the briefs asked for, never time, so it runs in the default suite.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { threadDelegations } from '../../src/main/agents/agentsView'
import { DelegationService, type DelegationCoordinator } from '../../src/main/agents/delegation'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../src/shared/agents'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-agents-view-work-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

const BASE = Date.parse('2026-10-01T00:00:00.000Z')
const at = (step: number): string => new Date(BASE + step * 1_000).toISOString()

/**
 * The owner's thread with three delegated threads, each of which delegated one more, and one refused start, read with
 * `history` delegations and a quarter as many refusals by other threads around them. Counts what the read touched.
 */
async function read(history: number) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-agents-view-work-')); roots.push(root)
  const tally = { records: new Set<string>(), refusals: new Set<string>(), briefs: 0 }
  let measuring = false
  // Every record and refusal counted the first time the read reads it.
  const counted = <T extends { id: string }>(value: T, seen: Set<string>): T => new Proxy(value, { get: (target, property, receiver) => {
    if (measuring) seen.add(target.id)
    return Reflect.get(target, property, receiver) as unknown
  } })
  const records: Record<string, unknown>[] = [], refusals: Record<string, unknown>[] = []
  const threads: Pick<AgentThread, 'id' | 'delegatedBy'>[] = [{ id: 'owner' }]
  let step = 0
  const delegation = (delegatingThreadId: string, delegatedThreadId: string, action: 'start' | 'send' = 'start') => {
    const time = at(step++)
    records.push({ id: randomUUID(), delegatingThreadId, delegatedThreadId, action, work: 'code-review', rootUserMessageId: 'root', inputDigest: 'a'.repeat(64),
      draftId: randomUUID(), messageId: randomUUID(), expectedLastUserMessageId: null, deliveryState: 'accepted', outcome: 'answered', outcomeAt: time,
      told: 'answered', charged: true, createdAt: time, updatedAt: time })
  }
  const refusal = (delegatingThreadId: string) => {
    refusals.push({ id: randomUUID(), delegatingThreadId, action: 'start', work: 'research', code: 'LEVEL_LIMIT', message: 'Synthetic refusal.', createdAt: at(step++) })
  }
  // Half the unrelated history comes before the owner's delegations and half after, so a walk from either end meets it.
  const unrelated = (count: number) => {
    for (let index = 0; index < count; index++) {
      const parent = `old-parent-${index % 40}`, thread = `old-thread-${records.length}`
      delegation(parent, thread)
      threads.push({ id: thread, delegatedBy: parent })
      if (index % 4 === 0) refusal(parent)
    }
  }
  unrelated(history / 2)
  for (let index = 0; index < 3; index++) {
    const agent = `agent-${index}`, helper = `helper-${index}`
    delegation('owner', agent); delegation(agent, helper)
    threads.push({ id: agent, delegatedBy: 'owner' }, { id: helper, delegatedBy: agent })
  }
  refusal('owner')
  delegation('owner', 'agent-0', 'send')
  unrelated(history / 2)

  const snapshot: AgentHostSnapshot = { ...EMPTY_AGENT_HOST, connected: true, threads: [] }
  const control: DelegationCoordinator = {
    hostId: () => 'host', watcherSnapshot: () => snapshot, configuration: () => ({}), useDelegation: () => () => undefined,
    commandFromDelegation: async () => { throw new Error('This read sends nothing.') },
    hasPendingThreadWork: () => false, hasUserDraft: () => false, refreshDelegationObservation: () => undefined, deliverWakeUp: async () => undefined,
  }
  const service = new DelegationService({ directory: root, control, historyEnabled: () => true, host: { setDelegatedBy: async () => undefined,
    threadMessage: (_threadId, messageId) => { if (measuring) tally.briefs++; return { id: messageId, role: 'user', text: 'Synthetic brief', createdAt: at(0) } } } })
  await service.recover()
  const internals = service as unknown as { records: unknown[]; refusals: unknown[] }
  internals.records = records.map(record => counted(record as { id: string }, tally.records))
  internals.refusals = refusals.map(item => counted(item as { id: string }, tally.refusals))
  measuring = true
  let shown: number
  try { shown = threadDelegations(service, threads, 'owner').threads.length } finally { measuring = false }
  service.close()
  return { shown, records: tally.records.size, refusals: tally.refusals.size, briefs: tally.briefs }
}

it('touches only the shown threads\' delegations, however much unrelated history the record holds', async () => {
  const none = await read(0), some = await read(400), full = await read(1_900)
  // Six rows: three agents and their helpers. Seven delegations name them (each start, and one later send to agent-0),
  // the owner's one refusal, and one brief per row.
  expect(none).toEqual({ shown: 6, records: 7, refusals: 1, briefs: 6 })
  // History, with the rows held: the work stays flat.
  expect(some).toEqual(none)
  expect(full).toEqual(none)
}, 60_000)
