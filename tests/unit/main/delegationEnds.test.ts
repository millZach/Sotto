// @vitest-environment node
/**
 * Every delegation ends (ADR-0081, #1029): a brief whose delivery was never confirmed, or whose delegated thread is gone,
 * reaches an outcome, holds no start slot after it, and the delegating thread is told.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DelegationService, type DelegationControlHooks, type DelegationCoordinator } from '../../../src/main/agents/delegation'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'
import type { DelegationNews } from '../../../src/shared/delegation'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-delegation-ends-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

const at = '2026-10-15T00:00:00.000Z'
const thread = (id: string, patch: Partial<AgentThread> = {}): AgentThread =>
  ({ id, projectId: 'project', providerId: 'codex', title: id, modelId: 'model', status: 'idle', messages: [], requests: [], ...patch })
const brief = (patch: Record<string, unknown>) => ({ id: randomUUID(), delegatingThreadId: 'parent', delegatedThreadId: 'child', action: 'start', work: 'code-review',
  rootUserMessageId: 'root', inputDigest: 'a'.repeat(64), draftId: randomUUID(), messageId: randomUUID(), expectedLastUserMessageId: null,
  deliveryState: 'accepted', outcome: 'working', told: 'working', charged: true, createdAt: at, updatedAt: at, ...patch })
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

async function service(delegations: Record<string, unknown>[], threads: AgentThread[]) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-delegation-ends-')); roots.push(root)
  const links = delegations.map(record => ({ threadId: record['delegatedThreadId'], delegatingThreadId: record['delegatingThreadId'], createdAt: at, seenHead: null }))
  await writeFile(join(root, 'delegations.json'), JSON.stringify({ version: 1, delegations: [], links, roots: [] }))
  const snapshot: AgentHostSnapshot = { ...EMPTY_AGENT_HOST, connected: true, threads }
  let hooks: DelegationControlHooks | undefined
  const told: DelegationNews[] = []
  const state = { pendingWork: false }
  const control: DelegationCoordinator = {
    hostId: () => 'host', watcherSnapshot: () => snapshot, configuration: () => ({}),
    useDelegation: given => { hooks = given; return () => { hooks = undefined } },
    commandFromDelegation: async () => ({ host: snapshot }) as never,
    hasPendingThreadWork: () => state.pendingWork, hasUserDraft: () => false, refreshDelegationObservation: () => undefined,
    deliverWakeUp: async (_threadId, news) => { told.push(news) },
  }
  const delegation = new DelegationService({ directory: root, control, host: { setDelegatedBy: async () => undefined, threadMessage: () => undefined },
    historyEnabled: () => true, limit: () => 1 })
  await delegation.recover()
  ;(delegation as unknown as { records: unknown[] }).records = structuredClone(delegations)
  const internals = delegation as unknown as { queuedBriefs: Map<string, string> }
  return { delegation, hooks: hooks!, snapshot, told, state, internals }
}

it('ends a brief whose delivery was never confirmed as unknown once nothing can prove it, frees its slot and tells the delegating thread', async () => {
  const lost = brief({ deliveryState: 'uncertain', outcome: undefined, told: undefined })
  const f = await service([lost], [thread('parent', { status: 'running' }), thread('child')])
  // While the coordinator still holds the send unresolved, the brief holds its slot, as Watcher's uncertain start does.
  f.state.pendingWork = true
  for (let pass = 0; pass < 3; pass++) f.hooks.observe(f.snapshot)
  await settle()
  expect(f.delegation.startsInFlight()).toBe(1)
  expect(f.hooks.observedThreadIds()).toEqual(['child'])
  // Once nothing is unresolved and its message never showed, Sotto cannot prove it landed: unknown, never resent.
  f.state.pendingWork = false
  f.hooks.observe(f.snapshot)
  await settle()
  expect(f.delegation.startsInFlight()).toBe(0)
  expect(f.hooks.observedThreadIds()).toEqual([])
  expect(f.told).toEqual([{ source: 'delegation', items: [{ delegationId: lost.id, threadId: 'child', outcome: 'unknown' }] }])
  expect(await f.delegation.read('parent', { delegation: lost.id })).toMatchObject({ delegation: { outcome: 'unknown' } })
  // The window's card says why: the provider never confirmed the brief, not a restart.
  expect(f.delegation.views('parent').made).toMatchObject([{ id: lost.id, outcome: 'unknown', unknownWhy: 'unconfirmed' }])
  // Unknown never moves again, even if its message turns up later.
  f.snapshot.threads[1] = thread('child', { messages: [{ id: lost.messageId, role: 'user', text: 'Synthetic brief', createdAt: at }], lastUserMessageId: lost.messageId })
  f.hooks.observe(f.snapshot)
  await settle()
  expect(f.delegation.startsInFlight()).toBe(0)
})

it('reconciles an unconfirmed brief as delivered when its own message shows in the thread', async () => {
  const lost = brief({ deliveryState: 'uncertain', outcome: undefined, told: undefined })
  const f = await service([lost], [thread('parent', { status: 'running' }),
    thread('child', { status: 'running', lastUserMessageId: lost.messageId, lastTurn: { id: lost.messageId, status: 'running' },
      messages: [{ id: lost.messageId, role: 'user', text: 'Synthetic brief', createdAt: at }] })])
  f.hooks.observe(f.snapshot)
  await settle()
  expect(f.delegation.startsInFlight()).toBe(1)
  expect(await f.delegation.read('parent', { delegation: lost.id })).toMatchObject({ delegation: { outcome: 'working' } })
})

it('ends the briefs of a delegated thread that is gone, frees what they held and tells the delegating thread', async () => {
  const working = brief({})
  const waiting = brief({ delegatedThreadId: 'other', action: 'send', deliveryState: 'queued', outcome: undefined, told: undefined })
  const f = await service([working, waiting], [thread('parent', { status: 'running' })])
  f.internals.queuedBriefs.set(waiting.id, 'Synthetic brief')
  expect(f.delegation.startsInFlight()).toBe(1)
  f.hooks.observe(f.snapshot)
  await settle()
  expect(f.delegation.startsInFlight()).toBe(0)
  expect(f.hooks.observedThreadIds()).toEqual([])
  expect(f.internals.queuedBriefs.size).toBe(0)
  expect(f.told).toEqual([{ source: 'delegation', items: [
    { delegationId: working.id, threadId: 'child', outcome: 'unknown' }, { delegationId: waiting.id, threadId: 'other', outcome: 'failed' }] }])
  const read = await f.delegation.read('parent', { delegation: working.id }) as { delegation: { outcome: string; note: string } }
  expect(read.delegation).toMatchObject({ outcome: 'unknown', note: expect.stringMatching(/gone from Sotto/u) })
  expect(f.delegation.views('parent').made).toMatchObject([{ id: working.id, unknownWhy: 'gone' }, { id: waiting.id, outcome: 'failed', notSent: 'provider' }])
})
