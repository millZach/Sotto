// @vitest-environment node
/**
 * Every delegation ends (ADR-0081, #1029): a brief whose delivery was never confirmed, or whose delegated thread is gone,
 * reaches an outcome, Sotto stops looking at it, and the delegating thread is told.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DelegationService, type DelegationControlHooks, type DelegationCoordinator } from '../../../src/main/agents/delegation'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'
import type { DelegationNews } from '../../../src/shared/delegation'
import type { SwarmReceipt } from '../../../src/shared/workerSwarms'
import { WorkerAdmission } from '../../../src/main/agents/workerAdmission'

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
    historyEnabled: () => true })
  await delegation.recover()
  ;(delegation as unknown as { records: unknown[] }).records = structuredClone(delegations)
  const internals = delegation as unknown as { queuedBriefs: Map<string, string> }
  return { delegation, hooks: hooks!, snapshot, told, state, internals }
}

it('ends a brief whose delivery was never confirmed as unknown once nothing can prove it and tells the delegating thread', async () => {
  const lost = brief({ deliveryState: 'uncertain', outcome: undefined, told: undefined })
  const f = await service([lost], [thread('parent', { status: 'running' }), thread('child')])
  // While the coordinator still holds the send unresolved, the brief stays open and its thread is looked at.
  f.state.pendingWork = true
  for (let pass = 0; pass < 3; pass++) f.hooks.observe(f.snapshot)
  await settle()
  expect(f.hooks.observedThreadIds()).toEqual(['child'])
  // Once nothing is unresolved and its message never showed, Sotto cannot prove it landed: unknown, never resent.
  f.state.pendingWork = false
  f.hooks.observe(f.snapshot)
  await settle()
  expect(f.hooks.observedThreadIds()).toEqual([])
  expect(f.told).toEqual([{ source: 'delegation', items: [{ delegationId: lost.id, threadId: 'child', outcome: 'unknown' }] }])
  expect(await f.delegation.read('parent', { delegation: lost.id })).toMatchObject({ delegation: { outcome: 'unknown' } })
  // The window's card says why: the provider never confirmed the brief, not a restart.
  expect(f.delegation.views('parent').made).toMatchObject([{ id: lost.id, outcome: 'unknown', unknownWhy: 'unconfirmed' }])
  // Unknown never moves again, even if its message turns up later.
  f.snapshot.threads[1] = thread('child', { messages: [{ id: lost.messageId, role: 'user', text: 'Synthetic brief', createdAt: at }], lastUserMessageId: lost.messageId })
  f.hooks.observe(f.snapshot)
  await settle()
  expect(await f.delegation.read('parent', { delegation: lost.id })).toMatchObject({ delegation: { outcome: 'unknown' } })
})

it('reconciles an unconfirmed brief as delivered when its own message shows in the thread', async () => {
  const lost = brief({ deliveryState: 'uncertain', outcome: undefined, told: undefined })
  const f = await service([lost], [thread('parent', { status: 'running' }),
    thread('child', { status: 'running', lastUserMessageId: lost.messageId, lastTurn: { id: lost.messageId, status: 'running' },
      messages: [{ id: lost.messageId, role: 'user', text: 'Synthetic brief', createdAt: at }] })])
  f.hooks.observe(f.snapshot)
  await settle()
  expect(f.hooks.observedThreadIds()).toEqual(['child'])
  expect(await f.delegation.read('parent', { delegation: lost.id })).toMatchObject({ delegation: { outcome: 'working' } })
})

it('ends the briefs of a delegated thread that is gone, stops looking at them and tells the delegating thread', async () => {
  const working = brief({})
  const waiting = brief({ delegatedThreadId: 'other', action: 'send', deliveryState: 'queued', outcome: undefined, told: undefined })
  const f = await service([working, waiting], [thread('parent', { status: 'running' })])
  f.internals.queuedBriefs.set(waiting.id, 'Synthetic brief')
  f.hooks.observe(f.snapshot)
  await settle()
  expect(f.hooks.observedThreadIds()).toEqual([])
  expect(f.internals.queuedBriefs.size).toBe(0)
  expect(f.told).toEqual([{ source: 'delegation', items: [
    { delegationId: working.id, threadId: 'child', outcome: 'unknown' }, { delegationId: waiting.id, threadId: 'other', outcome: 'failed' }] }])
  const read = await f.delegation.read('parent', { delegation: working.id }) as { delegation: { outcome: string; note: string } }
  expect(read.delegation).toMatchObject({ outcome: 'unknown', note: expect.stringMatching(/gone from Sotto/u) })
  expect(f.delegation.views('parent').made).toMatchObject([{ id: working.id, unknownWhy: 'gone' }, { id: waiting.id, outcome: 'failed', notSent: 'provider' }])
})

/** Real admission and delivery, without a provider process or a worktree on disk. */
async function swarmService(ceiling = 4) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-delegation-ends-')); roots.push(root)
  const snapshot: AgentHostSnapshot = { ...EMPTY_AGENT_HOST, connected: true,
    projects: [{ id: 'project', providerId: 'codex', title: 'Project', path: join(root, 'project') }],
    models: [{ id: 'model', provider: 'codex', providerId: 'codex', name: 'Model', ready: true, runtimeModes: ['approval-required'] }],
    threads: [thread('parent', { lastUserMessageId: 'root', messages: [{ id: 'root', role: 'user', text: 'Review it', createdAt: at }] })] }
  let hooks: DelegationControlHooks | undefined
  const created: { id: string; workingCopy: string | undefined }[] = [], sent: string[] = [], told: DelegationNews[] = []
  const admission = new WorkerAdmission({ ceiling: () => ceiling,
    working: () => new Set(snapshot.threads.filter(item => item.status === 'running').map(item => item.id)) })
  const control: DelegationCoordinator = {
    hostId: () => 'host', watcherSnapshot: () => snapshot, configuration: () => ({}),
    useDelegation: given => { hooks = given; return () => { hooks = undefined } },
    commandFromDelegation: async (command, guard) => {
      guard()
      if (command.type === 'create-thread') {
        created.push({ id: command.threadId!, workingCopy: command.workingCopy })
        snapshot.threads.push(thread(command.threadId!, { modelId: command.modelId! }))
      } else if (command.type === 'manual-send') {
        const target = snapshot.threads.find(item => item.id === command.threadId)!, messageId = hooks!.messageIdFor(command.draftId!)!
        target.messages.push({ id: messageId, role: 'user', text: command.text, createdAt: at })
        target.lastUserMessageId = messageId; target.lastTurn = { id: messageId, status: 'running' }; target.status = 'running'
        sent.push(command.threadId)
      }
      return { host: snapshot } as never
    },
    hasPendingThreadWork: () => false, hasUserDraft: () => false, refreshDelegationObservation: () => undefined,
    deliverWakeUp: async (threadId, news) => {
      told.push(news)
      const target = snapshot.threads.find(item => item.id === threadId)!, messageId = randomUUID()
      target.messages.push({ id: messageId, role: 'user', text: 'Swarm completion', wakeUp: true, createdAt: at })
      target.lastUserMessageId = messageId; target.lastTurn = { id: messageId, status: 'running' }; target.status = 'running'
    },
  }
  const delegation = new DelegationService({ directory: root, control,
    host: { setDelegatedBy: async (id, parent) => { snapshot.threads.find(item => item.id === id)!.delegatedBy = parent }, threadMessage: () => undefined },
    historyEnabled: () => true, swarms: { admission } })
  await delegation.recover()
  const finish = async (id: string) => {
    const target = snapshot.threads.find(item => item.id === id)!
    target.status = 'idle'; target.lastTurn = { id: target.lastUserMessageId!, status: 'completed' }
    target.messages.push({ id: randomUUID(), role: 'assistant', text: 'Done', createdAt: at })
    hooks!.observe(snapshot); await settle(); await settle()
  }
  const start = async (prompts: string[] | null = ['Check errors', 'Check permissions']) => {
    const input = { work: 'code-review', brief: 'Review it', provider: 'codex', model: 'model', permission: 'approval-required',
      count: 2, ...(prompts ? { prompts } : {}), retry_key: randomUUID(), wait_seconds: 0 }
    const receipt = await delegation.delegate('parent', input) as SwarmReceipt & { status: string }
    return { input, receipt }
  }
  return { delegation, admission, snapshot, created, sent, told, finish, start, observe: () => hooks!.observe(snapshot) }
}

it('starts one lead and one independent worktree per angle, and retries the same group without more starts', async () => {
  const f = await swarmService(), { receipt, input } = await f.start()
  expect(receipt).toMatchObject({ status: 'ok', queued: 0, costShape: { angles: 2, lead: 1 } })
  expect(receipt.receipts).toHaveLength(2)
  expect(f.created).toHaveLength(3)
  expect(f.created.every(item => item.workingCopy === 'independent')).toBe(true)
  expect(f.snapshot.threads.filter(item => item.delegatedBy === receipt.lead.thread)).toHaveLength(2)
  expect(await f.delegation.delegate('parent', input)).toMatchObject({ swarmId: receipt.swarmId, lead: receipt.lead })
  expect(f.created).toHaveLength(3)
  expect(await f.delegation.delegate('parent', { ...input, prompts: ['Different', 'Angles'] })).toMatchObject({ status: 'refused', code: 'RETRY_KEY_CONFLICT' })
  f.delegation.close(); f.admission.close()
})

it('queues extra angles in order at a ceiling of one, removes a stopped angle, and reserves the synthesis', async () => {
  const f = await swarmService(1), { receipt } = await f.start()
  expect(receipt.queued).toBe(2)
  expect(f.created).toHaveLength(1)
  expect(f.delegation.cancelQueued(receipt.receipts[1]!.thread!)).toBe(true)
  await f.finish(receipt.lead.thread)
  expect(f.created.map(item => item.id)).toEqual([receipt.lead.thread, receipt.receipts[0]!.thread])
  await vi.waitFor(() => expect(f.sent).toContain(receipt.receipts[0]!.thread))
  expect(f.told).toHaveLength(0)
  expect(f.delegation.canSettle(receipt.lead.thread)).toBe(false)
  await f.finish(receipt.receipts[0]!.thread!)
  await vi.waitFor(() => expect(f.told).toHaveLength(1))
  expect(f.delegation.canSettle(receipt.lead.thread)).toBe(false)
  expect(f.delegation.swarmReceiptForLead(receipt.lead.thread)).toMatchObject({ done: 1, queued: 0,
    receipts: [{ state: 'answered' }, { state: 'stopped' }] })
  await f.finish(receipt.lead.thread)
  expect(f.delegation.canSettle(receipt.lead.thread)).toBe(true)
  expect(f.admission.reserved('this-computer')).toBe(0)
  f.delegation.close(); f.admission.close()
})

it('lets an unplanned lead fill its reserved angles once and keeps their outcomes readable', async () => {
  const f = await swarmService(), { receipt, input } = await f.start(null)
  expect(f.created).toHaveLength(1)
  expect(receipt.receipts.map(item => item.state)).toEqual(['planned', 'planned'])
  const filled = await f.delegation.delegate(receipt.lead.thread, { ...input, prompts: ['Review auth', 'Review storage'] }) as SwarmReceipt
  expect(filled.swarmId).toBe(receipt.swarmId)
  expect(f.created).toHaveLength(3)
  await f.delegation.delegate(receipt.lead.thread, { ...input, prompts: ['Review auth', 'Review storage'] })
  expect(f.created).toHaveLength(3)
  await f.finish(filled.receipts[0]!.thread!)
  await f.finish(filled.receipts[1]!.thread!)
  expect(f.told).toHaveLength(1)
  expect(await f.delegation.read(receipt.lead.thread, { delegation: filled.receipts[0]!.delegation })).toMatchObject({ delegation: { outcome: 'answered' } })
  expect(await f.delegation.read(receipt.lead.thread, { delegation: receipt.swarmId })).toMatchObject({ swarmId: receipt.swarmId, done: 2 })
  f.delegation.close(); f.admission.close()
})

it('keeps a single start ordinary and uses the one requested angle brief', async () => {
  const f = await swarmService()
  const answer = await f.delegation.delegate('parent', { work: 'code-review', brief: 'Overall task', provider: 'codex', model: 'model',
    permission: 'approval-required', count: 1, prompts: ['Only this angle'], retry_key: randomUUID(), wait_seconds: 0 }) as { delegation: { thread: string } }
  expect(f.created).toHaveLength(1)
  expect(f.delegation.swarmForThread(answer.delegation.thread)).toBeUndefined()
  expect(f.snapshot.threads.find(item => item.id === answer.delegation.thread)?.messages[0]?.text).toBe('Only this angle')
  expect(await f.delegation.delegate('parent', { work: 'code-review', brief: 'Task', prompts: ['One angle'] })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  f.delegation.close(); f.admission.close()
})

it('cancels the whole swarm when the caller names the lead delegation', async () => {
  const f = await swarmService(1), { receipt } = await f.start()
  const cancelled = await f.delegation.cancel('parent', { delegation: receipt.lead.delegation }) as SwarmReceipt
  expect(cancelled.receipts.map(item => item.state)).toEqual(['stopped', 'stopped'])
  expect(f.admission.waiting('this-computer')).toBe(0)
  expect(f.created).toHaveLength(1)
  f.delegation.close(); f.admission.close()
})
