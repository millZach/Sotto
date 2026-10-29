// @vitest-environment node
// #1041: Watcher's start_thread names a worker role, and main fills the model, effort and permission from the user's
// Settings for that role, once, when the start is asked; never wider than the new-thread default.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import type { AgentRuntimeMode } from '../../src/shared/agents'
import { watcherToolSchemas, type WatcherToolOutput } from '../../src/shared/watcher'
import { watcherHostControlSchema, type WatcherHostControl, type WatcherRemoteHosts } from '../../src/shared/watcherHost'
import { roleInForce, type WorkerRoleChoices } from '../../src/shared/workerRoles'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const ALL_MODES: AgentRuntimeMode[] = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']

async function fixture(options: { roles?: boolean; newThread?: AgentRuntimeMode; otherModes?: AgentRuntimeMode[] } = {}) {
  const workspace = await workspaceFixture(undefined, { history: true })
  cleanups.push(workspace.remove)
  // Codex offers every mode and a second model, so only the ceiling narrows a permission and a named model can differ.
  const codex = workspace.adapters.codex.state
  codex.models[0]!.runtimeModes = [...ALL_MODES]
  codex.models[0]!.speeds = [{ id: 'fast', name: 'Fast' }, { id: 'ultrafast', name: 'Ultrafast' }]
  codex.models.push({ id: 'fake:other', provider: 'Fake', name: 'Synthetic other model', ready: true,
    speeds: [{ id: 'fast', name: 'Fast' }, { id: 'ultrafast', name: 'Ultrafast' }],
    reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium', runtimeModes: [...options.otherModes ?? ALL_MODES] })
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host,
    credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => true, watcherEnabled: true } })
  let choices: WorkerRoleChoices = {}, reads = 0
  const service = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => true,
    ...(options.roles === false ? {} : { roles: () => { reads++; return choices } }) })
  const tools = new WatcherToolServer(service, { roles: options.roles !== false })
  workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { service.close(); await tools.close(); f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start()
  await f.control.commandShell({ type: 'connect', provider: 'codex' })
  await f.control.commandShell({ type: 'configure', patch: { newThreadRuntimeMode: options.newThread ?? 'approval-required' } })
  await service.recover()
  const models = f.control.shell().host.models.filter(item => item.providerId === 'codex')
  const base = models.find(item => item.name === 'Test model')!, other = models.find(item => item.name === 'Synthetic other model')!
  const project = f.control.shell().host.projects.find(item => item.providerId === 'codex')!
  expect(await service.open({ provider: 'codex', modelId: base.id })).toMatchObject({ status: 'ok' })
  const id = service.state().current!.target.threadId
  expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Synthetic Watcher user request' })).error).toBeNull()
  const requestId = service.state().requests.at(-1)!.id
  const existing = new Set(f.control.shell().host.threads.map(thread => thread.id))
  const start = (extra: Record<string, unknown> = {}) => ({ requestId, retryKey: randomUUID(), project: { hostId: f.control.hostId()!, projectId: project.id },
    title: 'Synthetic worker', workingCopy: { kind: 'shared' as const }, firstPrompt: 'synthetic_role_prompt_5c1e', ...extra })
  const call = async (input: unknown): Promise<WatcherToolOutput<'start_thread'>> =>
    watcherToolSchemas.start_thread.output.parse((await tools.call(id, 'start_thread', input)).structuredContent)
  const ok = (result: WatcherToolOutput<'start_thread'>) => {
    if (result.status !== 'ok' || !('target' in result)) throw new Error(`start refused: ${result.status === 'refused' ? result.code : ''}`)
    return result
  }
  const workers = () => f.control.shell().host.threads.filter(thread => !existing.has(thread.id))
  // The fake provider keeps only the model, so how a worker started is read from the command it was sent.
  const created = (threadId: string) => {
    const sessionId = workspace.registry.byThread(threadId)!.sessionId
    const command = workspace.adapters.codex.commands.find(item => item.type === 'create-thread' && item.threadId === sessionId)
    if (command?.type !== 'create-thread') throw new Error('not created')
    return { modelId: command.modelId, reasoningEffort: command.reasoningEffort, speed: command.speed ?? null, runtimeMode: command.runtimeMode }
  }
  const sends = () => workspace.adapters.codex.commands.filter(item => item.type === 'send' && item.text === 'synthetic_role_prompt_5c1e').length
  return { ...f, workspace, service, tools, id, requestId, base, other, project, start, call, ok, workers, sends, created,
    setChoices: (next: WorkerRoleChoices) => { choices = next }, reads: () => reads }
}

it('starts a worker on its role\'s chosen model, effort and permission, reading Settings once for the start', async () => {
  const f = await fixture({ newThread: 'full-access' })
  f.setChoices({ building: { modelId: f.other.id, reasoningEffort: 'high', speed: 'ultrafast', runtimeMode: 'auto' } })
  const reads = f.reads()
  const result = f.ok(await f.call(f.start({ role: 'building' })))
  expect(result.effectiveChoices.modelId).toBe(f.other.id)
  expect(result.effectiveChoices.speed).toBe('ultrafast')
  expect(f.created(result.target.threadId)).toMatchObject({ reasoningEffort: 'high', speed: 'ultrafast', runtimeMode: 'auto' })
  expect(result.role).toMatchObject({ id: 'building', named: [], speed: 'ultrafast' })
  expect(result.role!.note).toContain('Started as Building, a worker role in the user\'s Settings.')
  expect(result.role!.note).toContain('Synthetic other model')
  expect(result.role!.note).not.toContain('held')
  expect(f.reads()).toBe(reads + 1)
  // Publishing and observing never read Settings again.
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  f.service.state()
  expect(f.reads()).toBe(reads + 1)
  const standard = f.ok(await f.call(f.start({ role: 'building', speed: null })))
  expect(f.created(standard.target.threadId).speed).toBeNull()
  expect(standard.role).toMatchObject({ named: ['speed'], speed: null })
})

it('starts on the role\'s default in force when the user chose nothing for it', async () => {
  const f = await fixture({ newThread: 'full-access' })
  const expected = roleInForce('building', {}, f.control.watcherSnapshot().models).start!
  const result = f.ok(await f.call(f.start({ role: 'building' })))
  expect(result.effectiveChoices.modelId).toBe(expected.modelId)
  expect(f.created(result.target.threadId)).toMatchObject({ reasoningEffort: expected.reasoningEffort, runtimeMode: expected.runtimeMode })
  expect(expected.runtimeMode).toBe('auto-accept-edits')
  expect(result.role).toMatchObject({ id: 'building', named: [] })
})

it('holds a role\'s wider permission to the new-thread default, and the receipt says it was held', async () => {
  const f = await fixture({ newThread: 'approval-required' })
  f.setChoices({ 'computer-use': { modelId: f.base.id, reasoningEffort: 'low' } })
  const result = f.ok(await f.call(f.start({ role: 'computer-use' })))
  expect(f.created(result.target.threadId)).toMatchObject({ reasoningEffort: 'low', runtimeMode: 'approval-required' })
  expect(result.role!.note).toContain('Its permission, Full access, was held to the user\'s new-thread default, Ask for approval.')
})

it('says the model does not offer the default\'s mode when that, not the default itself, held a role\'s permission', async () => {
  // The other model offers no Allow edits, so a new-thread default of Allow edits starts it on the nearest it offers below.
  const f = await fixture({ newThread: 'auto-accept-edits', otherModes: ['approval-required', 'auto', 'full-access'] })
  f.setChoices({ 'computer-use': { modelId: f.other.id, reasoningEffort: 'low', runtimeMode: 'full-access' } })
  const result = f.ok(await f.call(f.start({ role: 'computer-use' })))
  expect(f.created(result.target.threadId)).toMatchObject({ runtimeMode: 'approval-required' })
  expect(result.role!.note).toContain('Its permission, Full access, was held to Ask for approval: the user\'s new-thread default is Allow edits, which this model does not offer, so it starts on the nearest mode the model does.')
})

it('lets a named model override the role for this start only, with effort and permission still from the role', async () => {
  const f = await fixture({ newThread: 'full-access' })
  f.setChoices({ building: { modelId: f.base.id, reasoningEffort: 'high', runtimeMode: 'auto' } })
  const result = f.ok(await f.call(f.start({ role: 'building', modelId: f.other.id })))
  expect(result.effectiveChoices.modelId).toBe(f.other.id)
  expect(f.created(result.target.threadId)).toMatchObject({ reasoningEffort: 'high', runtimeMode: 'auto' })
  expect(result.role).toMatchObject({ id: 'building', named: ['model'] })
  expect(result.role!.note).toContain('(Synthetic other model, where Building uses Test model), which overrides Building for this start only.')
  expect(result.role!.note).toContain('Its effort, speed and permission came from the role.')
})

it('still refuses a named permission wider than the new-thread default, and starts nothing', async () => {
  const f = await fixture({ newThread: 'approval-required' })
  f.setChoices({ building: { modelId: f.base.id, reasoningEffort: 'high' } })
  expect(await f.call(f.start({ role: 'building', permission: { kind: 'runtime', mode: 'full-access' } })))
    .toMatchObject({ status: 'refused', code: 'PERMISSION_TOO_WIDE' })
  expect(f.workers()).toHaveLength(0)
  expect(f.sends()).toBe(0)
})

it('with worker roles off, refuses a role without a model and starts a named model as it always has', async () => {
  const f = await fixture({ roles: false })
  expect(f.tools.instructions).toBeUndefined()
  expect(await f.call(f.start({ role: 'building' }))).toMatchObject({ status: 'refused', code: 'INVALID_INPUT', message: 'Name the worker model for this start. Nothing was started.' })
  expect(await f.call(f.start())).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect(f.workers()).toHaveLength(0)
  const result = f.ok(await f.call(f.start({ role: 'building', modelId: f.base.id })))
  expect(result).not.toHaveProperty('role')
  expect(result.effectiveChoices.modelId).toBe(f.base.id)
  expect(f.created(result.target.threadId)).toMatchObject({ runtimeMode: 'approval-required' })
})

it('returns the original receipt for a retry after the role\'s setting changed, and starts nothing new', async () => {
  const f = await fixture({ newThread: 'full-access' })
  f.setChoices({ building: { modelId: f.base.id, reasoningEffort: 'low', runtimeMode: 'auto-accept-edits' } })
  const input = f.start({ role: 'building' })
  const first = f.ok(await f.call(input))
  const reads = f.reads()
  f.setChoices({ building: { modelId: f.other.id, reasoningEffort: 'high', runtimeMode: 'full-access' } })
  const retry = await f.call(input)
  expect(retry).toEqual(first)
  expect(f.reads()).toBe(reads)
  expect(f.workers()).toHaveLength(1)
  expect(f.sends()).toBe(1)
  // The saved operation keeps today's shape: its digest is of the concrete start, with no role in it.
  const saved = f.control.watcherRecord().operations.find(item => item.id === first.receipt.operationId)!
  expect(JSON.stringify(saved)).not.toContain('building')
})

/** A paired host that takes every start and answers with its receipt, holding new threads to `permissionCeiling`. */
function acceptingHost(f: Awaited<ReturnType<typeof fixture>>, permissionCeiling: AgentRuntimeMode) {
  const hostId = randomUUID()
  const remote: WatcherRemoteHosts = {
    hosts: () => [{ hostId, control: true, reads: true, connected: true, permissionCeiling }],
    read: async () => { throw new Error('Synthetic host has no reads') },
    control: async (_hostId, request) => {
      const { operation, call } = request
      if (call.name !== 'start_thread') throw new Error('Synthetic host takes starts only')
      return { status: 'ok', receipt: { operationId: operation.id, target: operation.target, requestId: operation.requestId, deliveryState: 'accepted',
        receiptId: operation.receiptId, cardId: operation.cardId }, limits: { promptCount: 1, promptLimit: 4 }, target: operation.target,
        effectiveChoices: { modelId: call.input.modelId!, reasoningEffort: call.input.reasoningEffort ?? null, permission: call.input.permission!, workingCopy: call.input.workingCopy },
        creationReceiptId: operation.creationReceiptId!, firstPromptReceiptId: operation.firstPromptReceiptId! }
    },
    snapshot: id => id === hostId ? { ...f.control.watcherSnapshot(), hostId, threads: [] } : undefined,
    subscribe: () => () => undefined,
  }
  f.service.useRemoteHosts(remote)
  return hostId
}

it('names the paired host, not the new-thread default, when the host\'s limit held a role\'s permission', async () => {
  const f = await fixture({ newThread: 'full-access' })
  f.setChoices({ 'computer-use': { modelId: f.base.id, reasoningEffort: 'low' } })
  const hostId = acceptingHost(f, 'approval-required')
  const result = f.ok(await f.call(f.start({ role: 'computer-use', project: { hostId, projectId: f.project.id } })))
  expect(result.effectiveChoices.permission).toEqual({ kind: 'runtime', mode: 'approval-required' })
  expect(result.role!.note).toContain('Its permission, Full access, was held to Ask for approval, the most that host lets this computer give a thread it starts there.')
  expect(result.role!.note).not.toContain('new-thread default')
})

it('sends a paired host the concrete start, with no role key an older host would refuse', async () => {
  const f = await fixture({ newThread: 'full-access' })
  f.setChoices({ research: { modelId: f.other.id, reasoningEffort: 'medium', runtimeMode: 'approval-required' } })
  const hostId = randomUUID(), packets: WatcherHostControl[] = []
  const remote: WatcherRemoteHosts = {
    hosts: () => [{ hostId, control: true, reads: true, connected: true, permissionCeiling: 'full-access' }],
    read: async () => { throw new Error('Synthetic host has no reads') },
    control: async (_hostId, request) => { packets.push(request); return { status: 'refused', code: 'HOST_FEATURE_UNAVAILABLE', message: 'Synthetic refusal.', retryable: false } },
    snapshot: id => id === hostId ? { ...f.control.watcherSnapshot(), hostId, threads: [] } : undefined,
    subscribe: () => () => undefined,
  }
  f.service.useRemoteHosts(remote)
  const result = await f.call(f.start({ role: 'research', project: { hostId, projectId: f.project.id } }))
  expect(result).toMatchObject({ status: 'refused', code: 'HOST_FEATURE_UNAVAILABLE' })
  expect(packets).toHaveLength(1)
  const input = packets[0]!.call.input as Record<string, unknown>
  expect(input).not.toHaveProperty('role')
  expect(input).toMatchObject({ modelId: f.other.id, reasoningEffort: 'medium', permission: { kind: 'runtime', mode: 'approval-required' } })
  expect(watcherHostControlSchema.safeParse(packets[0]).success).toBe(true)
})
