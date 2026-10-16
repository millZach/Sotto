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
import { DelegationService, type DelegationCommand, type DelegationControlHooks, type DelegationCoordinator } from '../../../src/main/agents/delegation'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentModel, type AgentState, type AgentThread } from '../../../src/shared/agents'
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

interface Options {
  readonly deliver?: (news: DelegationNews) => Promise<void>
  /** The coordinator's answer to a brief, given the guard it carries to the writer. */
  readonly send?: (command: Extract<DelegationCommand, { type: 'manual-send' }>, guard: () => void, snapshot: AgentHostSnapshot) => Promise<AgentState>
  readonly setDelegatedBy?: () => Promise<void>
}
async function service(delegations: Record<string, unknown>[], threads: AgentThread[], options: Options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-delegation-fences-')); roots.push(root)
  const links = delegations.map(record => ({ threadId: record['delegatedThreadId'], delegatingThreadId: record['delegatingThreadId'], createdAt: at, seenHead: null }))
  await writeFile(join(root, 'delegations.json'), JSON.stringify({ version: 1, delegations: [], links, roots: [] }))
  const model: AgentModel = { id: 'model', provider: 'codex', providerId: 'codex', name: 'Synthetic model', ready: true, runtimeModes: ['approval-required'] }
  const snapshot: AgentHostSnapshot = { ...EMPTY_AGENT_HOST, connected: true, threads, models: [model],
    projects: [{ id: 'project', providerId: 'codex', title: 'Synthetic project', path: join(root, 'project') }] }
  let hooks: DelegationControlHooks | undefined
  const interrupted: string[] = []
  const control: DelegationCoordinator = {
    hostId: () => 'host', watcherSnapshot: () => snapshot, configuration: () => ({}),
    useDelegation: given => { hooks = given; return () => { hooks = undefined } },
    commandFromDelegation: async (command, guard) => {
      if (command.type === 'interrupt') interrupted.push(command.threadId)
      if (command.type === 'create-thread' && command.threadId) snapshot.threads.push(thread(command.threadId))
      if (command.type === 'manual-send' && options.send) return options.send(command, guard, snapshot)
      return { host: snapshot } as never
    },
    hasPendingThreadWork: () => false, hasUserDraft: () => false, refreshDelegationObservation: () => undefined,
    deliverWakeUp: async (_threadId, news) => (options.deliver ?? (async () => undefined))(news),
  }
  const delegation = new DelegationService({ directory: root, control,
    host: { setDelegatedBy: options.setDelegatedBy ?? (async () => undefined), threadMessage: () => undefined }, historyEnabled: () => true, limit: () => 4 })
  await delegation.recover()
  ;(delegation as unknown as { records: unknown[] }).records = structuredClone(delegations)
  const internals = delegation as unknown as { queuedBriefs: Map<string, string>; fenced: Set<string> }
  return { delegation, hooks: hooks!, snapshot, interrupted, internals }
}
/** A promise the test releases, and one that resolves once the code under test reaches it. */
function gate() {
  let release!: () => void, entered!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  const reached = new Promise<void>(resolve => { entered = resolve })
  return { release: () => release(), reached, wait: async () => { entered(); await released } }
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
  const f = await service([finished], threads, { deliver: async news => { offered.push(news); if (refuse) throw new Error('The queue could not save it.') } })
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

it('fences a brief already on its way when the delegating thread cancels it, and reports it stopped, not working', async () => {
  const waiting = brief({ deliveryState: 'queued', outcome: undefined, told: undefined })
  const writer = gate(), written: string[] = []
  const f = await service([waiting], [thread('parent', { status: 'running', messages: [{ id: 'root', role: 'user', text: 'Synthetic request', createdAt: at }] }), thread('child')], {
    send: async (command, guard, snapshot) => {
      await writer.wait()
      // The provider's writer asks the guard last, as the coordinator's does.
      try { guard() } catch (error) { return { host: snapshot, error: (error as Error).message } as never }
      written.push(command.draftId ?? '')
      return { host: snapshot, deliveries: [{ threadId: command.threadId, draftId: command.draftId, status: 'accepted' }] } as never
    },
  })
  f.internals.queuedBriefs.set(waiting.id, 'Synthetic brief')
  f.hooks.observe(f.snapshot)
  await writer.reached
  const cancelled = f.delegation.cancel('parent', { delegation: waiting.id })
  writer.release()
  expect(await cancelled).toMatchObject({ status: 'ok', delegation: { outcome: 'stopped' } })
  expect(written).toEqual([])
})

it('keeps no brief and no fence for a start the user stopped while its thread was being linked', async () => {
  const linking = gate()
  const f = await service([], [thread('parent', { status: 'running', lastUserMessageId: 'root', messages: [{ id: 'root', role: 'user', text: 'Synthetic request', createdAt: at }] })],
    { setDelegatedBy: linking.wait })
  const call = f.delegation.delegate('parent', { work: 'code-review', brief: 'Synthetic brief', provider: 'codex', model: 'model', permission: 'approval-required', wait_seconds: 0 })
  await linking.reached
  f.hooks.userCommand({ type: 'interrupt', threadId: 'parent' }, 'parent', false)
  linking.release()
  expect(await call).toMatchObject({ status: 'ok', delegation: { outcome: 'stopped' } })
  expect(f.internals.queuedBriefs.size).toBe(0)
  expect(f.internals.fenced.size).toBe(0)
})
