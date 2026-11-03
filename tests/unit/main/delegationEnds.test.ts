// @vitest-environment node
/**
 * Every delegation ends (ADR-0081, #1029): a brief whose delivery was never confirmed, or whose delegated thread is gone,
 * reaches an outcome, Sotto stops looking at it, and the delegating thread is told.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DelegationService, type DelegationControlHooks, type DelegationCoordinator } from '../../../src/main/agents/delegation'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'
import { delegateInputSchema, delegationNewsSchema, DELEGATION_NEWS_MAX, type DelegationNews } from '../../../src/shared/delegation'
import { swarmReceiptSchema, workerSwarmSchema, type SwarmReceipt, type WorkerSwarm } from '../../../src/shared/workerSwarms'
import { watcherToolSchemas } from '../../../src/shared/watcher'
import { foldWakeUpNews, queuedWakeUpText, wakeUpNewsSchema } from '../../../src/main/agents/wakeUp'
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

async function service(delegations: Record<string, unknown>[], threads: AgentThread[], saved = false, delivery?: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-delegation-ends-')); roots.push(root)
  const links = delegations.map(record => ({ threadId: record['delegatedThreadId'], delegatingThreadId: record['delegatingThreadId'], createdAt: at, seenHead: null }))
  await writeFile(join(root, 'delegations.json'), JSON.stringify({ version: 1, delegations: saved ? delegations : [], links, roots: [] }))
  const snapshot: AgentHostSnapshot = { ...EMPTY_AGENT_HOST, connected: true, threads }
  let hooks: DelegationControlHooks | undefined
  const told: DelegationNews[] = []
  const state = { pendingWork: false }
  const command = vi.fn(async () => ({ host: snapshot }) as never)
  const control: DelegationCoordinator = {
    hostId: () => 'host', watcherSnapshot: () => snapshot, configuration: () => ({}),
    useDelegation: given => { hooks = given; return () => { hooks = undefined } },
    commandFromDelegation: command,
    hasPendingThreadWork: () => state.pendingWork, hasUserDraft: () => false, refreshDelegationObservation: () => undefined,
    deliverWakeUp: async (_threadId, news) => { told.push(news); await delivery?.() },
  }
  const delegation = new DelegationService({ directory: root, control, host: { setDelegatedBy: async () => undefined,
    threadMessage: (id, messageId) => snapshot.threads.find(item => item.id === id)?.messages.find(message => message.id === messageId) },
    historyEnabled: () => true })
  await delegation.recover()
  if (!saved) (delegation as unknown as { records: unknown[] }).records = structuredClone(delegations)
  const internals = delegation as unknown as { queuedBriefs: Map<string, string> }
  return { delegation, hooks: hooks!, snapshot, told, state, internals, command }
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
  // Unconfirmed outside a restart stays final, even if its exact answering turn turns up later.
  f.snapshot.threads[1] = thread('child', { messages: [{ id: lost.messageId, role: 'user', text: 'Synthetic brief', createdAt: at }],
    lastUserMessageId: lost.messageId, lastTurn: { id: lost.messageId, status: 'completed' } })
  f.hooks.observe(f.snapshot)
  await settle()
  expect(await f.delegation.read('parent', { delegation: lost.id })).toMatchObject({ delegation: { outcome: 'unknown' } })
})

const recoveredTurns = [
  { status: 'completed', outcome: 'answered' },
  { status: 'failed', outcome: 'failed' },
  { status: 'interrupted', outcome: 'stopped' },
] as const

it.each(recoveredTurns)('recovers a $status turn at startup by its brief anchor, with its own reply only', async ({ status, outcome }) => {
  const derived = status === 'interrupted' ? 'paused' : outcome
  const lost = brief({ turnMessageId: 'stale-anchor', nativeTurnId: 'stale-turn', replyMessageId: 'stale-reply' })
  const f = await service([lost], [thread('parent'), thread('child', {
    messages: [{ id: lost.messageId, role: 'user', text: 'Synthetic brief', createdAt: at },
      { id: 'answer', role: 'assistant', text: 'Synthetic answer', turnMessageId: lost.messageId, createdAt: at },
      { id: 'later', role: 'user', text: 'Unrelated request', createdAt: at },
      { id: 'other-answer', role: 'assistant', text: 'Unrelated answer', turnMessageId: 'later', createdAt: at }],
    activities: [{ id: 'activity', sequence: 0, kind: 'turn', turnId: 'native-turn', afterMessageId: lost.messageId, status, title: 'Turn', startedAt: at }],
    lastUserMessageId: 'later', lastTurn: { id: 'later', status: 'completed' },
  })], true)
  await settle()
  const read = await f.delegation.read('parent', { delegation: lost.id })
  expect(read).toMatchObject({ delegation: { outcome: derived, turnMessageId: lost.messageId,
    ...(outcome === 'answered' ? { reply: { text: 'Synthetic answer', messageId: 'answer' } } : {}) } })
  expect(f.told).toEqual([{ source: 'delegation', items: [{ delegationId: lost.id, threadId: 'child', outcome: derived, turnMessageId: lost.messageId }] }])
  expect(f.hooks.observedThreadIds()).toEqual([])
  expect(f.command).not.toHaveBeenCalled()
  f.delegation.close()
})

it.each(recoveredTurns)('recovers a $status turn after provider reconnect, including an uncertain send', async ({ status, outcome }) => {
  const lost = brief({ deliveryState: 'dispatching' })
  const child = thread('child', { clientConnected: false,
    messages: [{ id: lost.messageId, role: 'user', text: 'Synthetic brief', createdAt: at }],
    lastUserMessageId: lost.messageId, lastTurn: { id: 'native-turn', messageId: lost.messageId, status } })
  const f = await service([lost], [thread('parent'), child], true)
  await vi.waitFor(() => {
    expect(f.told.map(news => news.items[0]?.outcome)).toEqual(['unknown'])
    expect((f.delegation as unknown as { telling: Set<string> }).telling.size).toBe(0)
  })
  expect(f.delegation.views('parent').made).toMatchObject([{ outcome: 'unknown', unknownWhy: 'restarted' }])
  expect(f.hooks.observedThreadIds()).toEqual(['child'])
  child.clientConnected = true
  f.hooks.observe(f.snapshot)
  await settle()
  await vi.waitFor(() => expect(f.told.map(news => news.items[0]?.outcome)).toEqual(['unknown', outcome]))
  expect(await f.delegation.read('parent', { delegation: lost.id })).toMatchObject({ delegation: { outcome, turnMessageId: lost.messageId } })
  f.hooks.observe(f.snapshot); await settle()
  expect(f.told).toHaveLength(2)
  expect(f.command).not.toHaveBeenCalled()
  f.delegation.close()
})

it('tells a recovered outcome after its earlier unknown news finishes delivery', async () => {
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const lost = brief({})
  const child = thread('child', { clientConnected: false,
    messages: [{ id: lost.messageId, role: 'user', text: 'Synthetic brief', createdAt: at }],
    lastTurn: { id: lost.messageId, status: 'completed' } })
  const f = await service([lost], [thread('parent'), child], true, () => pending)
  await vi.waitFor(() => expect(f.told.map(news => news.items[0]?.outcome)).toEqual(['unknown']))
  child.clientConnected = true
  f.hooks.observe(f.snapshot)
  expect(f.delegation.views('parent').made).toMatchObject([{ outcome: 'answered' }])
  finish()
  await vi.waitFor(() => expect(f.told.map(news => news.items[0]?.outcome)).toEqual(['unknown', 'answered']))
  f.hooks.observe(f.snapshot); await settle()
  expect(f.told).toHaveLength(2)
  expect(f.command).not.toHaveBeenCalled()
  f.delegation.close()
})

it.each(['absent', 'brief-only', 'unrelated'] as const)('keeps restart uncertainty with %s history, through observations and reads', async history => {
  const lost = brief({})
  const f = await service([lost], [thread('parent'), thread('child')], true)
  await settle()
  const child = f.snapshot.threads[1]!
  if (history !== 'absent') child.messages.push({ id: lost.messageId, role: 'user', text: 'Synthetic brief', createdAt: at })
  if (history === 'unrelated') {
    child.messages.push({ id: 'later', role: 'user', text: 'Unrelated request', createdAt: at },
      { id: 'other-answer', role: 'assistant', text: 'Unrelated answer', createdAt: at })
    child.lastUserMessageId = 'later'; child.lastTurn = { id: 'later', status: 'completed' }
  }
  f.hooks.observe(f.snapshot); await settle()
  expect(await f.delegation.read('parent', { delegation: lost.id })).toMatchObject({ delegation: { outcome: 'unknown' } })
  expect(await f.delegation.read('parent', {})).toMatchObject({ delegations: [{ outcome: 'unknown' }] })
  expect(f.told).toHaveLength(1)
  expect(f.hooks.observedThreadIds()).toEqual([])
  expect(f.command).not.toHaveBeenCalled()
  f.delegation.close()
})

it('waits for history, then retries restart proof on reconnect after an attempt found none', async () => {
  const lost = brief({})
  const child = thread('child', { historyStatus: 'loading', messages: [{ id: lost.messageId, role: 'user', text: 'Synthetic brief', createdAt: at }] })
  const f = await service([lost], [thread('parent'), child], true)
  expect(f.hooks.observedThreadIds()).toEqual(['child'])
  child.historyStatus = 'ready'; f.hooks.observe(f.snapshot)
  expect(f.hooks.observedThreadIds()).toEqual([])
  child.lastTurn = { id: lost.messageId, status: 'completed' }
  // New history alone does not keep a restart unknown on the per-snapshot observation path.
  f.hooks.observe(f.snapshot)
  expect(f.delegation.views('parent').made[0]?.outcome).toBe('unknown')
  f.snapshot.connected = false; f.hooks.observe(f.snapshot)
  expect(f.hooks.observedThreadIds()).toEqual(['child'])
  f.snapshot.connected = true; f.hooks.observe(f.snapshot)
  expect(f.delegation.views('parent').made[0]?.outcome).toBe('answered')
  expect(f.hooks.observedThreadIds()).toEqual([])
  expect(f.command).not.toHaveBeenCalled()
  f.delegation.close()
})

it.each(['single', 'listing'] as const)('recovers a saved restart unknown when its %s read finds the exact turn', async read => {
  const lost = brief({ outcome: 'unknown', unknownBecause: 'restarted', told: 'unknown' })
  const f = await service([lost], [thread('parent'), thread('child')], true)
  const child = f.snapshot.threads[1]!
  child.messages.push({ id: lost.messageId, role: 'user', text: 'Synthetic brief', createdAt: at },
    { id: 'answer', role: 'assistant', text: 'Synthetic answer', createdAt: at })
  child.lastTurn = { id: lost.messageId, status: 'completed' }
  const result = await f.delegation.read('parent', read === 'single' ? { delegation: lost.id } : {})
  expect(result).toMatchObject(read === 'single' ? { delegation: { outcome: 'answered', reply: { text: 'Synthetic answer' } } }
    : { delegations: [{ outcome: 'answered' }] })
  expect(f.hooks.observedThreadIds()).toEqual([])
  expect(f.command).not.toHaveBeenCalled()
  f.delegation.close()
})

it('never recovers or resends a queued brief dropped at restart, even if history names its message', async () => {
  const lost = brief({ deliveryState: 'queued', outcome: undefined, told: undefined })
  const f = await service([lost], [thread('parent'), thread('child', {
    messages: [{ id: lost.messageId, role: 'user', text: 'Synthetic brief', createdAt: at }], lastTurn: { id: lost.messageId, status: 'completed' },
  })], true)
  f.hooks.observe(f.snapshot); await settle()
  expect(await f.delegation.read('parent', { delegation: lost.id })).toMatchObject({ delegation: { outcome: 'unknown', note: expect.stringContaining('Nothing was sent') } })
  expect(f.hooks.observedThreadIds()).toEqual([])
  expect(f.command).not.toHaveBeenCalled()
  f.delegation.close()
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

it('stops looking for restart evidence after the delegated thread is deleted', async () => {
  const lost = brief({})
  const f = await service([lost], [thread('parent'), thread('child', { clientConnected: false })], true)
  expect(f.hooks.observedThreadIds()).toEqual(['child'])
  f.snapshot.threads = f.snapshot.threads.filter(item => item.id !== 'child')
  f.hooks.observe(f.snapshot)
  await settle()
  expect(f.hooks.observedThreadIds()).toEqual([])
  expect(f.delegation.views('parent').made).toMatchObject([{ id: lost.id, outcome: 'unknown', unknownWhy: 'gone' }])
  expect(f.command).not.toHaveBeenCalled()
  f.delegation.close()
})

/** Real admission and delivery, without a provider process or a worktree on disk. */
async function swarmService(ceiling = 4, saved?: { root: string; snapshot: AgentHostSnapshot },
  delivery: { beforeWakeUp?: () => Promise<void>; pending?: boolean; queued?: DelegationNews[] } = {}) {
  const root = saved?.root ?? await mkdtemp(join(tmpdir(), 'sotto-delegation-ends-'))
  if (!saved) roots.push(root)
  const snapshot: AgentHostSnapshot = saved?.snapshot ?? { ...EMPTY_AGENT_HOST, connected: true,
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
    hasPendingThreadWork: () => delivery.pending === true, hasUserDraft: () => false, refreshDelegationObservation: () => undefined,
    hasQueuedDelegationNews: (_threadId, ids) => delivery.queued?.some(news => news.swarmId !== undefined && ids.has(news.swarmId)
      || news.items.some(item => ids.has(item.delegationId))) === true,
    deliverWakeUp: async (threadId, news) => {
      await delivery.beforeWakeUp?.()
      told.push(news)
      const target = snapshot.threads.find(item => item.id === threadId)!, messageId = randomUUID()
      target.messages.push({ id: messageId, role: 'user', text: 'Swarm completion', wakeUp: true, hiddenWakeUp: true, createdAt: at })
      target.lastUserMessageId = messageId; target.lastTurn = { id: messageId, status: 'running' }; target.status = 'running'
    },
  }
  const delegation = new DelegationService({ directory: root, control,
    host: { setDelegatedBy: async (id, parent) => { snapshot.threads.find(item => item.id === id)!.delegatedBy = parent }, threadMessage: () => undefined },
    historyEnabled: () => true, swarms: { admission } })
  await delegation.recover()
  const finish = async (id: string, status: 'completed' | 'failed' | 'interrupted' = 'completed', reply = 'The checks found no permission bypass. Storage failures need a retry; the unavailable angle remains missing.') => {
    const target = snapshot.threads.find(item => item.id === id)!
    target.status = status === 'failed' ? 'error' : 'idle'; target.lastTurn = { id: target.lastUserMessageId!, status }
    if (status === 'completed') target.messages.push({ id: randomUUID(), role: 'assistant', text: reply, createdAt: at })
    hooks!.observe(snapshot); await settle(); await settle()
  }
  const start = async (prompts: string[] | null = ['Check errors', 'Check permissions']) => {
    const input = { work: 'code-review', brief: 'Review it', provider: 'codex', model: 'model', permission: 'approval-required',
      count: prompts?.length ?? 2, ...(prompts ? { prompts } : {}), retry_key: randomUUID(), wait_seconds: 0 }
    const receipt = await delegation.delegate('parent', input) as SwarmReceipt & { status: string }
    return { input, receipt }
  }
  const file = async (): Promise<{ swarms: WorkerSwarm[]; delegations: Record<string, unknown>[] }> => {
    await (delegation as unknown as { save(): Promise<void> }).save()
    return JSON.parse(await readFile(join(root, 'delegations.json'), 'utf8'))
  }
  return { root, delegation, admission, snapshot, created, sent, told, finish, start, file, observe: () => hooks!.observe(snapshot),
    observed: () => hooks!.observedThreadIds(),
    newsReady: (id: string, news: DelegationNews[]) => hooks!.newsReady!(id, news),
    newsText: (id: string, news: DelegationNews[]) => hooks!.newsText!(id, news) }
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
  expect(await f.delegation.delegate(receipt.lead.thread, { ...input, prompts: [' Review auth ', '\nReview storage\n'] }))
    .toMatchObject({ swarmId: receipt.swarmId })
  expect(await f.delegation.delegate(receipt.lead.thread, { ...input, prompts: ['Review storage', 'Review auth'] }))
    .toMatchObject({ status: 'refused', code: 'RETRY_KEY_CONFLICT' })
  expect(f.created).toHaveLength(3)
  await f.finish(filled.receipts[0]!.thread!)
  await f.finish(filled.receipts[1]!.thread!)
  await vi.waitFor(() => expect(f.told).toHaveLength(1))
  expect(await f.delegation.read(receipt.lead.thread, { delegation: filled.receipts[0]!.delegation })).toMatchObject({ delegation: { outcome: 'answered' } })
  expect(await f.delegation.read(receipt.lead.thread, { delegation: receipt.swarmId })).toMatchObject({ swarmId: receipt.swarmId, done: 2 })
  f.delegation.close(); f.admission.close()
})

for (const status of ['failed', 'interrupted'] as const) it(`records a ${status} synthesis as missing, tells its owner and permits settlement and pruning after restart`, async () => {
  const f = await swarmService(), { receipt } = await f.start()
  await f.finish(receipt.lead.thread)
  for (const angle of receipt.receipts) await f.finish(angle.thread!)
  await vi.waitFor(() => expect(f.told).toHaveLength(1))
  expect(f.admission.reserved('this-computer')).toBe(1)
  await f.finish(receipt.lead.thread, status)
  const outcome = status === 'failed' ? 'failed' : 'stopped'
  await vi.waitFor(() => expect(f.told).toHaveLength(2))
  expect(f.told[1]).toMatchObject({ items: [{ delegationId: receipt.lead.delegation, threadId: receipt.lead.thread, outcome }] })
  expect(f.delegation.swarmForThread(receipt.lead.thread)).toMatchObject({ synthesisDone: false, synthesisFailed: outcome, stopped: false })
  expect(f.delegation.canSettle(receipt.lead.thread)).toBe(true)
  expect(f.admission.reserved('this-computer')).toBe(0)
  expect(await f.delegation.read('parent', { delegation: receipt.lead.delegation }))
    .toMatchObject({ delegation: { outcome, note: expect.stringContaining('synthesis result is missing') } })
  expect(f.newsText('parent', [f.told[1]!])).toContain('its result is missing')
  expect(f.delegation.swarmReceiptForLead(receipt.lead.thread))
    .toMatchObject({ synthesisFailed: outcome, note: expect.stringContaining('its result is missing') })
  const failed = (await f.file()).swarms[0]!
  expect(failed.synthesisDone).not.toBe(true)
  expect(failed.synthesisFailed).toBe(outcome)
  expect(failed.synthesisMessageId).toBeUndefined()
  expect(failed.synthesisAfterMessageId).toBe(f.snapshot.threads.find(item => item.id === receipt.lead.thread)!.lastUserMessageId)
  f.observe(); await settle()
  expect(f.told).toHaveLength(2)
  f.delegation.close(); f.admission.close()
  const restored = await swarmService(4, f)
  restored.observe(); await settle()
  expect(restored.delegation.swarmForThread(receipt.lead.thread)?.synthesisDone).toBe(false)
  expect(restored.delegation.canSettle(receipt.lead.thread)).toBe(true)
  expect(restored.delegation.swarmReceiptForLead(receipt.lead.thread)?.synthesisFailed).toBe(outcome)
  expect(restored.admission.reserved('this-computer')).toBe(0)
  expect(restored.told).toHaveLength(0)
  await restored.delegation.forgetThreads(new Set([receipt.lead.thread]))
  expect(restored.delegation.swarmForThread(receipt.lead.thread)).toBeUndefined()
  expect(restored.observed()).not.toContain(receipt.lead.thread)
  expect((await restored.file()).swarms).toBeUndefined()
  restored.delegation.close(); restored.admission.close()
})

for (const restart of [false, true]) it(`completes synthesis when a later lead turn answers after failure${restart ? ' across restart' : ''}`, async () => {
  const f = await swarmService(), { receipt } = await f.start()
  await f.finish(receipt.lead.thread)
  for (const angle of receipt.receipts) await f.finish(angle.thread!)
  await vi.waitFor(() => expect(f.told).toHaveLength(1))
  await f.finish(receipt.lead.thread, 'failed')
  await vi.waitFor(() => expect(f.told).toHaveLength(2))
  const failedTurn = (await f.file()).swarms[0]!.synthesisAfterMessageId
  let retry = f
  if (restart) {
    f.delegation.close(); f.admission.close()
    retry = await swarmService(4, f)
  }
  const lead = retry.snapshot.threads.find(item => item.id === receipt.lead.thread)!, messageId = randomUUID()
  // A normal later turn, without a new completion wake-up, can retry the missing synthesis.
  lead.messages.push({ id: messageId, role: 'user', text: 'Retry the synthesis', createdAt: at })
  lead.lastUserMessageId = messageId; lead.lastTurn = { id: messageId, status: 'running' }; lead.status = 'running'
  retry.observe(); await settle()
  expect(retry.delegation.canSettle(receipt.lead.thread)).toBe(false)
  expect((await retry.file()).swarms[0]).toMatchObject({ synthesisAfterMessageId: failedTurn, synthesisMessageId: messageId })
  await retry.finish(receipt.lead.thread)
  await vi.waitFor(() => expect(retry.told).toHaveLength(restart ? 1 : 3))
  expect(retry.told.at(-1)).toMatchObject({ items: [{ delegationId: receipt.lead.delegation, turnMessageId: messageId, outcome: 'answered' }] })
  expect(retry.delegation.swarmForThread(receipt.lead.thread)).toMatchObject({ synthesisDone: true, stopped: false })
  expect(retry.delegation.swarmReceiptForLead(receipt.lead.thread)?.synthesisFailed).toBeUndefined()
  expect(retry.delegation.canSettle(receipt.lead.thread)).toBe(true)
  expect(retry.admission.reserved('this-computer')).toBe(0)
  expect(retry.observed()).not.toContain(receipt.lead.thread)
  expect(await retry.delegation.read('parent', { delegation: receipt.lead.delegation }))
    .toMatchObject({ delegation: { outcome: 'answered', turnMessageId: messageId } })
  retry.delegation.close(); retry.admission.close()
})

it('does not certify a bare Done as synthesis or let it erase a failed attempt', async () => {
  const f = await swarmService(), { receipt } = await f.start()
  await f.finish(receipt.lead.thread)
  for (const angle of receipt.receipts) await f.finish(angle.thread!)
  await vi.waitFor(() => expect(f.told).toHaveLength(1))
  const lead = f.snapshot.threads.find(item => item.id === receipt.lead.thread)!
  lead.status = 'idle'; lead.lastTurn = { id: lead.lastUserMessageId!, status: 'completed' }
  lead.messages.push({ id: randomUUID(), role: 'assistant', text: 'Done', createdAt: at })
  // Watcher observes first in the real coordinator, before the delegation pass saves the failed disposition.
  expect(f.delegation.swarmOutcome(lead.id, lead)).toMatchObject({ pending: false, outcome: 'failed' })
  f.observe()
  await vi.waitFor(() => expect(f.told).toHaveLength(2))
  expect(f.told[1]).toMatchObject({ items: [{ outcome: 'failed' }] })
  expect(f.delegation.swarmForThread(receipt.lead.thread)).toMatchObject({ synthesisDone: false, synthesisFailed: 'failed' })
  expect(f.delegation.canSettle(receipt.lead.thread)).toBe(true)
  lead.messages.push({ id: randomUUID(), role: 'assistant', text: 'Done', createdAt: at })
  f.observe(); await settle()
  expect(f.told).toHaveLength(2)
  expect((await f.file()).swarms[0]?.synthesisDone).not.toBe(true)
  f.delegation.close(); f.admission.close()
})

it('gives the lead one swarm read instruction while retaining the standalone completion formatter', async () => {
  const f = await swarmService(), { receipt } = await f.start()
  await f.finish(receipt.lead.thread)
  for (const angle of receipt.receipts) await f.finish(angle.thread!)
  await vi.waitFor(() => expect(f.told).toHaveLength(1))
  const text = f.newsText(receipt.lead.thread, f.told)!
  expect(text.match(/Swarm /gu)).toHaveLength(1)
  expect(text).toContain('Read the swarm receipt with read_delegation')
  expect(queuedWakeUpText(f.told, { tool: false })).toContain(receipt.swarmId)
  f.delegation.close(); f.admission.close()
})

it('rejects exact duplicate trimmed angle briefs before accepting a plan or starting any of its workers', async () => {
  const f = await swarmService()
  const { input, receipt: rejected } = await f.start(['Check auth', ' \nCheck auth\n '])
  expect(rejected).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect(f.created).toHaveLength(0)
  expect((await f.file()).swarms).toBeUndefined()
  const valid = await f.delegation.delegate('parent', { ...input, prompts: ['Check auth', 'Check Auth'] }) as SwarmReceipt
  expect(valid.receipts).toHaveLength(2)
  expect(f.created).toHaveLength(3)
  const unplanned = await f.start(null)
  expect(await f.delegation.delegate(unplanned.receipt.lead.thread, { ...unplanned.input, prompts: ['Same', ' Same '] }))
    .toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  const saved = (await f.file()).swarms.find(swarm => swarm.id === unplanned.receipt.swarmId)!
  expect(saved.planDigest).toBeUndefined()
  expect(saved.members.map(member => member.state)).toEqual(['planned', 'planned'])
  const filled = await f.delegation.delegate(unplanned.receipt.lead.thread, { ...unplanned.input, prompts: ['First', 'Second'] }) as SwarmReceipt
  expect(filled.receipts.every(member => member.delegation)).toBe(true)
  f.delegation.close(); f.admission.close()
})

it('rejects duplicate briefs through both tool schemas while allowing distinct case and wording', () => {
  const delegation = { work: 'research', brief: 'Review', count: 2, prompts: ['Same', ' Same '] }
  const watcher = { requestId: randomUUID(), retryKey: randomUUID(), project: { hostId: randomUUID(), projectId: 'project' }, role: 'research',
    title: 'Review', firstPrompt: 'Review', count: 2, prompts: ['Same', ' Same '], workingCopy: { kind: 'new-worktree' } }
  expect(delegateInputSchema.safeParse(delegation).success).toBe(false)
  expect(watcherToolSchemas.start_thread.input.safeParse(watcher).success).toBe(false)
  expect(delegateInputSchema.safeParse({ ...delegation, prompts: ['Same', 'same'] }).success).toBe(true)
  expect(watcherToolSchemas.start_thread.input.safeParse({ ...watcher, prompts: ['Same', 'same'] }).success).toBe(true)
})

it('keeps refused angle IDs and reasons in the receipt across restart and sends no fabricated answered item', async () => {
  const f = await swarmService(), { receipt, input } = await f.start(null)
  await f.finish(receipt.lead.thread)
  f.snapshot.models[0]!.ready = false
  const filled = await f.delegation.delegate(receipt.lead.thread, { ...input, prompts: ['First', 'Second'] }) as SwarmReceipt
  expect(swarmReceiptSchema.parse(f.delegation.swarmReceiptForLead(receipt.lead.thread)).receipts).toEqual(filled.receipts)
  expect(filled.receipts).toEqual([0, 1].map(index => ({ index, state: 'refused', delegation: expect.any(String), refusal: expect.any(String) })))
  expect(f.created).toHaveLength(1)
  for (const angle of filled.receipts) {
    expect(await f.delegation.read(receipt.lead.thread, { delegation: angle.delegation }))
      .toMatchObject({ delegation: { id: angle.delegation, outcome: 'refused', note: angle.refusal } })
  }
  await vi.waitFor(() => expect(f.told).toHaveLength(1))
  const news: DelegationNews = { source: 'delegation', swarmId: receipt.swarmId, items: [] }
  expect(f.told).toEqual([news])
  expect(wakeUpNewsSchema.parse(news)).toEqual(news)
  expect(delegationNewsSchema.safeParse({ source: 'delegation', items: [] }).success).toBe(false)
  expect(foldWakeUpNews([news], news)).toEqual([news])
  expect(queuedWakeUpText([news], { tool: false })).toContain(receipt.swarmId)
  expect(f.newsText(receipt.lead.thread, [news])).toContain('2 failed')
  const saved = (await f.file()).swarms[0]!
  expect(workerSwarmSchema.parse(saved).members).toEqual(filled.receipts.map(angle => ({ index: angle.index,
    key: expect.any(String), state: angle.state, delegationId: angle.delegation, refusal: angle.refusal })))
  f.delegation.close(); f.admission.close()
  const restored = await swarmService(4, f)
  expect(restored.delegation.swarmReceiptForLead(receipt.lead.thread)?.receipts).toEqual(filled.receipts)
  restored.observe(); await settle()
  expect(restored.told).toHaveLength(0)
  await restored.finish(receipt.lead.thread)
  expect(restored.delegation.canSettle(receipt.lead.thread)).toBe(true)
  restored.delegation.close(); restored.admission.close()
})

it('recovers queued completion news with no accepted angles without resending or bypassing capacity', async () => {
  let attempted = false
  const f = await swarmService(4, undefined, { beforeWakeUp: async () => { attempted = true; throw new Error('Delivery unconfirmed') } })
  const { receipt, input } = await f.start(null)
  await f.finish(receipt.lead.thread)
  f.snapshot.models[0]!.ready = false
  await f.delegation.delegate(receipt.lead.thread, { ...input, prompts: ['First', 'Second'] })
  await vi.waitFor(() => expect(attempted).toBe(true))
  await settle()
  await f.file()
  f.delegation.close(); f.admission.close()
  const news: DelegationNews = { source: 'delegation', swarmId: receipt.swarmId, items: [] }
  f.snapshot.threads.push(thread('busy', { status: 'running' }))
  const restored = await swarmService(1, f, { queued: [news] })
  restored.observe(); await settle()
  expect(restored.newsReady(receipt.lead.thread, [news])).toBe(false)
  expect(restored.admission.waiting('this-computer')).toBe(1)
  expect(restored.told).toHaveLength(0)
  restored.snapshot.threads.find(item => item.id === 'busy')!.status = 'idle'
  restored.admission.refresh()
  expect(restored.newsReady(receipt.lead.thread, [news])).toBe(true)
  expect(restored.admission.reserved('this-computer')).toBe(1)
  expect(restored.told).toHaveLength(0)
  restored.delegation.close(); restored.admission.close()
})

for (const count of [DELEGATION_NEWS_MAX, DELEGATION_NEWS_MAX + 2]) it(`delivers ${count} angle results with an explicit count of any omitted results`, async () => {
  const f = await swarmService(count + 1), { receipt } = await f.start(Array.from({ length: count }, (_, index) => `Angle ${index}`))
  await f.finish(receipt.lead.thread)
  for (const angle of receipt.receipts) await f.finish(angle.thread!)
  await vi.waitFor(() => expect(f.told).toHaveLength(1))
  expect(f.told[0]?.items).toHaveLength(DELEGATION_NEWS_MAX)
  const text = f.newsText(receipt.lead.thread, f.told)!
  if (count > DELEGATION_NEWS_MAX) {
    expect(text).toContain('2 angle results omitted from this news')
    expect(text).toContain(`delegation: "${receipt.swarmId}"`)
  } else expect(text).not.toContain('omitted')
  const saved = await f.file()
  for (const [index, angle] of receipt.receipts.entries()) {
    const record = saved.delegations.find(item => item['id'] === angle.delegation)!
    expect(record['told']).toBe(index < DELEGATION_NEWS_MAX ? 'answered' : 'working')
  }
  const last = receipt.receipts.at(-1)!
  expect(await f.delegation.read(receipt.lead.thread, { delegation: last.delegation }))
    .toMatchObject({ delegation: { id: last.delegation, outcome: 'answered' } })
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
  expect(f.delegation.swarmForThread(receipt.lead.thread)).toMatchObject({ stopped: true, synthesisDone: false })
  expect(f.admission.waiting('this-computer')).toBe(0)
  expect(f.created).toHaveLength(1)
  f.delegation.close(); f.admission.close()
})

it('recovers a synthesis that was only waiting for the machine ceiling', async () => {
  const f = await swarmService(1), { receipt } = await f.start()
  await f.finish(receipt.lead.thread)
  await vi.waitFor(() => expect(f.sent).toContain(receipt.receipts[0]!.thread))
  await f.finish(receipt.receipts[0]!.thread!)
  await vi.waitFor(() => expect(f.sent).toContain(receipt.receipts[1]!.thread))
  f.snapshot.threads.push(thread('busy', { status: 'running' }))
  await f.finish(receipt.receipts[1]!.thread!)
  expect(f.admission.waiting('this-computer')).toBe(1)
  const queued = (await f.file()).swarms[0]!
  expect(queued.synthesisStarted).toBeUndefined()
  expect(queued.completionSent).toBeUndefined()
  f.delegation.close(); f.admission.close()
  const restored = await swarmService(1, f)
  restored.observe()
  expect(restored.admission.waiting('this-computer')).toBe(1)
  restored.snapshot.threads.find(item => item.id === 'busy')!.status = 'idle'
  restored.observe()
  await vi.waitFor(() => expect(restored.told.some(news => news.items[0]?.delegationId === receipt.receipts[0]!.delegation)).toBe(true))
  restored.delegation.close(); restored.admission.close()
})

it('recovers proven angle outcomes through synthesis before allowing the lead to settle', async () => {
  const f = await swarmService(), { receipt } = await f.start()
  await f.finish(receipt.lead.thread)
  await f.file()
  f.delegation.close(); f.admission.close()
  // The provider finished the angles while Sotto was down, before delegation could record their outcomes.
  for (const [index, member] of receipt.receipts.entries()) {
    const child = f.snapshot.threads.find(item => item.id === member.thread)!
    child.status = 'idle'
    child.lastTurn = { id: child.lastUserMessageId!, status: index === 0 ? 'completed' : 'failed' }
    child.messages.push({ id: randomUUID(), role: 'assistant', text: `Angle ${index}`, createdAt: at })
  }
  const restored = await swarmService(4, f)
  expect(restored.delegation.swarmReceiptForLead(receipt.lead.thread)).toMatchObject({ done: 1, failed: 1,
    receipts: [{ state: 'answered' }, { state: 'failed' }] })
  expect(restored.delegation.canSettle(receipt.lead.thread)).toBe(false)
  await vi.waitFor(() => expect(restored.told).toHaveLength(1))
  expect(restored.told[0]?.items.map(item => item.outcome)).toEqual(['answered', 'failed'])
  expect(restored.created).toEqual([])
  expect(restored.sent).toEqual([])
  await restored.finish(receipt.lead.thread)
  expect(restored.delegation.canSettle(receipt.lead.thread)).toBe(true)
  expect(restored.delegation.swarmForThread(receipt.lead.thread)).toMatchObject({ synthesisDone: true })
  restored.delegation.close(); restored.admission.close()
})

it('keeps a swarm unfinished while an angle has no exact turn, then recovers it on a swarm read', async () => {
  const f = await swarmService(), { receipt } = await f.start()
  await f.finish(receipt.lead.thread)
  await f.file()
  f.delegation.close(); f.admission.close()
  const children = receipt.receipts.map(member => f.snapshot.threads.find(item => item.id === member.thread)!)
  for (const child of children) { child.status = 'idle'; delete child.lastTurn }
  const restored = await swarmService(4, f)
  restored.observe(); await settle()
  expect(restored.delegation.swarmReceiptForLead(receipt.lead.thread)?.receipts.map(item => item.state)).toEqual(['unknown', 'unknown'])
  expect(restored.delegation.canSettle(receipt.lead.thread)).toBe(false)
  expect(restored.told).toEqual([])
  for (const child of children) child.lastTurn = { id: child.lastUserMessageId!, status: 'completed' }
  expect(await restored.delegation.read('parent', { delegation: receipt.swarmId })).toMatchObject({ done: 2,
    receipts: [{ state: 'answered' }, { state: 'answered' }] })
  await vi.waitFor(() => expect(restored.told).toHaveLength(1))
  await restored.finish(receipt.lead.thread)
  expect(restored.delegation.canSettle(receipt.lead.thread)).toBe(true)
  restored.delegation.close(); restored.admission.close()
})

it('persists an angle recovered on a swarm read even when the lead delegation is missing', async () => {
  const f = await swarmService(), { receipt } = await f.start()
  await f.finish(receipt.lead.thread)
  const saved = await f.file()
  f.delegation.close(); f.admission.close()
  saved.delegations = saved.delegations.filter(record => record['id'] !== receipt.lead.delegation)
  await writeFile(join(f.root, 'delegations.json'), JSON.stringify(saved))
  const children = receipt.receipts.map(member => f.snapshot.threads.find(item => item.id === member.thread)!)
  for (const child of children) { child.status = 'idle'; delete child.lastTurn }
  const restored = await swarmService(4, f)
  children[0]!.lastTurn = { id: children[0]!.lastUserMessageId!, status: 'completed' }
  expect(await restored.delegation.read('parent', { delegation: receipt.swarmId })).toMatchObject({ done: 1,
    receipts: [{ state: 'answered' }, { state: 'unknown' }] })
  // Read the disk directly: another save or a synthesis wake-up must not be needed to make recovery durable.
  const persisted = JSON.parse(await readFile(join(f.root, 'delegations.json'), 'utf8')) as typeof saved
  expect(persisted.swarms[0]?.members.map(member => member.state)).toEqual(['answered', 'unknown'])
  expect(persisted.delegations.find(record => record['id'] === receipt.receipts[0]!.delegation)).toMatchObject({ outcome: 'answered' })
  expect(restored.told).toEqual([])
  restored.delegation.close(); restored.admission.close()
})

it('reconciles a saved synthesis queue and an uncertain send before retrying a wake-up that never landed', async () => {
  let entered = false
  const f = await swarmService(4, undefined, { beforeWakeUp: () => { entered = true; return new Promise(() => undefined) } })
  const { receipt } = await f.start()
  await f.finish(receipt.lead.thread)
  await f.finish(receipt.receipts[0]!.thread!)
  await f.finish(receipt.receipts[1]!.thread!)
  await vi.waitFor(() => expect(entered).toBe(true))
  const unsent = (await f.file()).swarms[0]!
  expect(unsent.synthesisStarted).toBe(true)
  expect(unsent.completionSent).toBeUndefined()
  f.delegation.close(); f.admission.close()
  const queued: DelegationNews = { source: 'delegation', items: receipt.receipts.map(item => ({ delegationId: item.delegation!, threadId: item.thread!, outcome: 'answered' })) }
  const delivery = { queued: [queued], pending: false }
  f.snapshot.threads.push(thread('busy', { status: 'running' }))
  const restored = await swarmService(1, f, delivery)
  restored.observe(); await settle()
  expect(restored.told.some(news => news.items[0]?.delegationId === receipt.receipts[0]!.delegation)).toBe(false)
  expect(restored.newsReady(receipt.lead.thread, [queued])).toBe(false)
  expect(restored.admission.waiting('this-computer')).toBe(1)
  restored.snapshot.threads.find(item => item.id === 'busy')!.status = 'idle'
  restored.admission.refresh()
  expect(restored.newsReady(receipt.lead.thread, [queued])).toBe(true)
  delivery.queued = []; delivery.pending = true
  const lead = restored.snapshot.threads.find(item => item.id === receipt.lead.thread)!
  lead.messages.push({ id: 'restart-note', role: 'user', text: 'Resume after restart', wakeUp: true, createdAt: at })
  lead.lastUserMessageId = 'restart-note'; lead.lastTurn = { id: 'restart-note', status: 'completed' }
  restored.observe(); await settle()
  expect(restored.told.some(news => news.items[0]?.delegationId === receipt.receipts[0]!.delegation)).toBe(false)
  delivery.pending = false
  restored.observe()
  await vi.waitFor(() => expect(restored.told.filter(news => news.items[0]?.delegationId === receipt.receipts[0]!.delegation)).toHaveLength(1))
  restored.delegation.close(); restored.admission.close()
})

it('does not resend a synthesis wake-up that landed before its completion marker was saved', async () => {
  const f = await swarmService(), { receipt } = await f.start()
  await f.finish(receipt.lead.thread)
  await f.finish(receipt.receipts[0]!.thread!)
  await f.finish(receipt.receipts[1]!.thread!)
  await vi.waitFor(() => expect(f.told).toHaveLength(1))
  const saved = await f.file()
  f.delegation.close(); f.admission.close()
  saved.swarms[0]!.completionSent = false
  delete saved.swarms[0]!.synthesisMessageId
  await writeFile(join(f.root, 'delegations.json'), JSON.stringify(saved))
  const restored = await swarmService(4, f)
  restored.observe(); await settle()
  expect(restored.told.some(news => news.items[0]?.delegationId === receipt.receipts[0]!.delegation)).toBe(false)
  await restored.finish(receipt.lead.thread)
  expect(restored.delegation.canSettle(receipt.lead.thread)).toBe(true)
  restored.delegation.close(); restored.admission.close()
})

it('delivers synthesis after more than five failed attempts without restarting or duplicating it', async () => {
  let attempts = 0
  const f = await swarmService(4, undefined, { beforeWakeUp: async () => {
    if (++attempts <= 6) throw new Error('Provider unavailable')
  } })
  const { receipt } = await f.start()
  await f.finish(receipt.lead.thread)
  await f.finish(receipt.receipts[0]!.thread!)
  await f.finish(receipt.receipts[1]!.thread!)
  await vi.waitFor(() => expect(attempts).toBe(1))
  for (let expected = 2; expected <= 7; expected++) {
    await settle()
    f.observe()
    await vi.waitFor(() => expect(attempts).toBe(expected))
  }
  await vi.waitFor(() => expect(f.told).toHaveLength(1))
  expect((await f.file()).swarms[0]?.completionSent).toBe(true)
  f.observe(); await settle()
  expect(attempts).toBe(7)
  expect(f.told).toHaveLength(1)
  await f.finish(receipt.lead.thread)
  expect(f.delegation.canSettle(receipt.lead.thread)).toBe(true)
  f.delegation.close(); f.admission.close()
})

it('lets the original plan retry fill only angles with no saved start after a restart', async () => {
  const f = await swarmService(), { receipt, input } = await f.start()
  const saved = await f.file()
  f.delegation.close(); f.admission.close()
  const swarm = saved.swarms[0]!, first = swarm.members[0]!, second = swarm.members[1]!
  const originalFirstId = first.threadId, originalSecondId = second.threadId
  // The first admission reached disk before its link; the second never reached admission.
  first.state = 'planned'; delete first.delegationId; delete first.threadId
  saved.delegations = saved.delegations.filter(record => record['id'] !== second.delegationId)
  second.state = 'planned'; delete second.delegationId; delete second.threadId
  swarm.planned = true
  f.snapshot.threads = f.snapshot.threads.filter(item => item.id !== originalSecondId)
  await writeFile(join(f.root, 'delegations.json'), JSON.stringify(saved))
  const restored = await swarmService(4, f)
  expect(restored.delegation.swarmReceiptForLead(receipt.lead.thread)?.receipts.map(item => item.state)).toEqual(['working', 'planned'])
  expect(await restored.delegation.delegate(receipt.lead.thread, { ...input, prompts: ['Changed', 'Plan'] }))
    .toMatchObject({ status: 'refused', code: 'RETRY_KEY_CONFLICT' })
  expect(restored.created).toHaveLength(0)
  const retried = await restored.delegation.delegate('parent', input) as SwarmReceipt
  expect(retried.receipts[0]).toMatchObject({ thread: originalFirstId, state: 'working' })
  expect(retried.receipts[1]?.thread).toBeDefined()
  expect(restored.created).toHaveLength(1)
  restored.delegation.close(); restored.admission.close()
})

it('keeps saved swarms readable after their history exceeds two thousand groups', async () => {
  const f = await swarmService(), { receipt } = await f.start(null)
  const saved = await f.file(), template = saved.swarms[0]!
  f.delegation.close(); f.admission.close()
  saved.swarms = Array.from({ length: 2_001 }, (_, index) => ({ ...template, id: randomUUID(), retryKey: randomUUID(), leadKey: randomUUID(), leadThreadId: `lead-${index}` }))
  await writeFile(join(f.root, 'delegations.json'), JSON.stringify(saved))
  const restored = await swarmService(4, f)
  expect(restored.delegation.swarmRows()).toHaveLength(2_001)
  expect((await restored.file()).swarms).toHaveLength(2_001)
  expect(restored.delegation.swarmReceiptForLead('lead-2000')?.receipts).toHaveLength(receipt.receipts.length)
  restored.delegation.close(); restored.admission.close()
})
