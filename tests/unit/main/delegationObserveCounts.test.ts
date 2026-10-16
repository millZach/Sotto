// @vitest-environment node
/**
 * The count guard for delegation's observation pass (ADR-0081, #1029), beside `watcherObserveCounts.test.ts`. Main runs
 * the pass on every snapshot it accepts, every streamed chunk included, so it may not grow with the number of delegated
 * threads or delegations: it reads the snapshot's thread list once and asks the coordinator for nothing else per thread
 * it does not need, whatever the size.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DelegationService, type DelegationControlHooks, type DelegationCoordinator } from '../../../src/main/agents/delegation'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-delegation-counts-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

/** Counts per pass for `size` delegated threads, each with one accepted brief whose turn has finished, and as many still working. */
async function counts(size: number) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-delegation-counts-')); roots.push(root)
  const at = '2026-10-15T00:00:00.000Z', parent = 'parent'
  const threads: AgentThread[] = [{ id: parent, projectId: 'project', providerId: 'claude', title: 'Parent', modelId: 'model', status: 'running', messages: [], requests: [] }]
  const delegations = [], links = []
  for (let index = 0; index < size * 2; index++) {
    const threadId = `delegated-${index}`, messageId = randomUUID(), finished = index % 2 === 0
    threads.push({ id: threadId, projectId: 'project', providerId: 'codex', title: 'Delegated', modelId: 'model', delegatedBy: parent,
      status: finished ? 'idle' : 'running', lastUserMessageId: messageId, requests: [],
      lastTurn: { id: messageId, status: finished ? 'completed' : 'running' },
      messages: [{ id: messageId, role: 'user', text: 'Synthetic brief', createdAt: at },
        ...finished ? [{ id: randomUUID(), role: 'assistant' as const, text: 'Synthetic reply', createdAt: at }] : []] })
    delegations.push({ id: randomUUID(), delegatingThreadId: parent, delegatedThreadId: threadId, action: 'start', work: 'code-review', rootUserMessageId: 'root',
      inputDigest: 'a'.repeat(64), draftId: randomUUID(), messageId, expectedLastUserMessageId: null, deliveryState: 'accepted', outcome: 'working', told: 'working',
      charged: true, createdAt: at, updatedAt: at })
    links.push({ threadId, delegatingThreadId: parent, createdAt: at, seenHead: messageId })
  }
  await writeFile(join(root, 'delegations.json'), JSON.stringify({ version: 1, delegations, links, roots: [] }))
  const tally = { threadLists: 0, snapshots: 0, pendingWork: 0 }
  let measuring = false
  const base: AgentHostSnapshot = { ...EMPTY_AGENT_HOST, connected: true, threads }
  // The snapshot as main hands it to the pass, its thread list counted each time it is read.
  const snapshot = new Proxy(base, { get: (target, property, receiver) => {
    if (property === 'threads' && measuring) tally.threadLists++
    return Reflect.get(target, property, receiver) as unknown
  } })
  let hooks: DelegationControlHooks | undefined
  const control: DelegationCoordinator = {
    hostId: () => 'host', watcherSnapshot: () => { if (measuring) tally.snapshots++; return snapshot }, configuration: () => ({}),
    useDelegation: given => { hooks = given; return () => { hooks = undefined } },
    commandFromDelegation: async () => { throw new Error('This pass sends nothing.') },
    hasPendingThreadWork: () => { if (measuring) tally.pendingWork++; return false }, hasUserDraft: () => false,
    refreshDelegationObservation: () => undefined, deliverWakeUp: async () => undefined,
  }
  const live = new DelegationService({ directory: root, control, host: { setDelegatedBy: async () => undefined, threadMessage: () => undefined },
    historyEnabled: () => true, limit: () => 4 })
  await live.recover()
  // Recovery leaves every brief from before a restart unknown; these are this run's, open for the pass to follow.
  ;(live as unknown as { records: unknown[] }).records = structuredClone(delegations)
  const measure = (read: () => void) => {
    for (const name of Object.keys(tally) as (keyof typeof tally)[]) tally[name] = 0
    measuring = true
    try { read() } finally { measuring = false }
    return { ...tally }
  }
  const observe = measure(() => hooks!.observe(snapshot))
  // The pass did reach the finished turns: each finished brief now reads answered.
  const answered = (live as unknown as { records: { outcome?: string }[] }).records.filter(record => record.outcome === 'answered').length
  expect(answered).toBe(size)
  const observed = measure(() => { expect(hooks!.observedThreadIds()).toHaveLength(size) })
  live.close()
  return { observe, observed }
}

it('reads the snapshot\'s threads once per pass and asks nothing per delegated thread, whatever the size', async () => {
  const small = await counts(2), large = await counts(24)
  expect(large).toEqual(small)
  expect(small.observe).toEqual({ threadLists: 1, snapshots: 0, pendingWork: 0 })
  expect(small.observed).toEqual({ threadLists: 0, snapshots: 0, pendingWork: 0 })
}, 60_000)
