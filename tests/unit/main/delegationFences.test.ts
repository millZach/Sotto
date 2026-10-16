// @vitest-environment node
/**
 * Delegation's fences at the writer (ADR-0081, #1029): a Stop reaches a brief already on its way, and news counts as
 * told only once the delegating thread's queue has saved it.
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
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-delegation-fences-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

const at = '2026-10-15T00:00:00.000Z'
const thread = (id: string, patch: Partial<AgentThread> = {}): AgentThread =>
  ({ id, projectId: 'project', providerId: 'codex', title: id, modelId: 'model', status: 'idle', messages: [], requests: [], ...patch })

async function service(delegations: Record<string, unknown>[], threads: AgentThread[], deliver: (news: DelegationNews) => Promise<void> = async () => undefined) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-delegation-fences-')); roots.push(root)
  const links = delegations.map(record => ({ threadId: record['delegatedThreadId'], delegatingThreadId: record['delegatingThreadId'], createdAt: at, seenHead: null }))
  await writeFile(join(root, 'delegations.json'), JSON.stringify({ version: 1, delegations: [], links, roots: [] }))
  const snapshot: AgentHostSnapshot = { ...EMPTY_AGENT_HOST, connected: true, threads }
  let hooks: DelegationControlHooks | undefined
  const interrupted: string[] = []
  const control: DelegationCoordinator = {
    hostId: () => 'host', watcherSnapshot: () => snapshot, configuration: () => ({}),
    useDelegation: given => { hooks = given; return () => { hooks = undefined } },
    commandFromDelegation: async command => { if (command.type === 'interrupt') interrupted.push(command.threadId); return { host: snapshot } as never },
    hasPendingThreadWork: () => false, hasUserDraft: () => false, refreshDelegationObservation: () => undefined,
    deliverWakeUp: async (_threadId, news) => deliver(news),
  }
  const delegation = new DelegationService({ directory: root, control, host: { setDelegatedBy: async () => undefined, threadMessage: () => undefined },
    historyEnabled: () => true, limit: () => 4 })
  await delegation.recover()
  ;(delegation as unknown as { records: unknown[] }).records = structuredClone(delegations)
  return { delegation, hooks: hooks!, snapshot, interrupted }
}
const brief = (patch: Record<string, unknown>) => ({ id: randomUUID(), delegatingThreadId: 'parent', delegatedThreadId: 'child', action: 'start', work: 'code-review',
  rootUserMessageId: 'root', inputDigest: 'a'.repeat(64), draftId: randomUUID(), messageId: randomUUID(), expectedLastUserMessageId: null,
  deliveryState: 'accepted', outcome: 'working', told: 'working', charged: true, createdAt: at, updatedAt: at, ...patch })

it('fences a brief already on its way to the writer when the user stops the thread that delegated it', async () => {
  const sending = brief({ deliveryState: 'dispatching', outcome: undefined, told: undefined })
  const f = await service([sending], [thread('parent', { status: 'running' }), thread('child')])
  const guard = f.hooks.guardFor(sending.draftId)!
  expect(() => guard()).not.toThrow()
  f.hooks.userCommand({ type: 'interrupt', threadId: 'parent' }, 'parent', false)
  expect(() => guard()).toThrow(/stopped/u)
})

it('counts an outcome as told only once the queue saved it, and offers it again on a later pass', async () => {
  const finished = brief({})
  const reply = randomUUID()
  const threads = [thread('parent', { status: 'running' }), thread('child', { lastUserMessageId: finished.messageId, lastTurn: { id: finished.messageId, status: 'completed' },
    messages: [{ id: finished.messageId, role: 'user', text: 'Synthetic brief', createdAt: at }, { id: reply, role: 'assistant', text: 'Synthetic reply', createdAt: at }] })]
  const offered: DelegationNews[] = []
  let refuse = true
  const f = await service([finished], threads, async news => { offered.push(news); if (refuse) throw new Error('The queue could not save it.') })
  f.hooks.observe(f.snapshot)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(offered).toHaveLength(1)
  refuse = false
  f.hooks.observe(f.snapshot)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(offered).toHaveLength(2)
  expect(offered[1]!.items).toEqual([{ delegationId: finished.id, threadId: 'child', outcome: 'answered', turnMessageId: finished.messageId }])
  // Told now, so a later pass sends nothing more.
  f.hooks.observe(f.snapshot)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(offered).toHaveLength(2)
})
