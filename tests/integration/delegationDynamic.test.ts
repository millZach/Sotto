// @vitest-environment node
// ADR-0191: a Dynamic thread's overseer chooses each worker's model, and `delegate` holds it to the limits in Settings: the
// firm allowed list, the highest effort and workers at once. A worker under it may delegate, inside the same list.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { DelegationService } from '../../src/main/agents/delegation'
import type { AgentRuntimeMode, ProviderId } from '../../src/shared/agents'
import { DEFAULT_DYNAMIC_THREADS, type DynamicThreadSettings } from '../../src/shared/dynamicThreads'
import type { UsageQuotaRead } from '../../src/shared/usageDashboard'
import type { WorkerRoleChoices } from '../../src/shared/workerRoles'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const ALL_MODES: AgentRuntimeMode[] = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
const FIVE = ['low', 'medium', 'high', 'xhigh', 'max']

type Result = { status: 'ok'; delegation: { id: string; thread: string; outcome: string; limitStop?: unknown; effortHeld?: string }; role?: unknown; heldToRole?: string }
  | { status: 'refused'; code: string; message: string; delegation?: string }

async function fixture(options: { enabled?: boolean; limits?: Partial<DynamicThreadSettings>; quota?: (provider: ProviderId) => Promise<UsageQuotaRead | undefined> } = {}) {
  const workspace = await workspaceFixture(undefined, { history: true, watcherEnabled: false })
  cleanups.push(workspace.remove)
  const enabled = options.enabled !== false
  if (enabled) workspace.host.allowDynamicThreads()
  for (const adapter of Object.values(workspace.adapters)) {
    adapter.state.models[0]!.runtimeModes = [...ALL_MODES]
    adapter.state.models[0]!.reasoningEfforts = [...FIVE]
  }
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { historyEnabled: () => true, watcherEnabled: false, dynamicThreadsEnabled: enabled } })
  let settings: DynamicThreadSettings = { ...DEFAULT_DYNAMIC_THREADS, providers: ['claude', 'codex'], ...options.limits }
  const choices: WorkerRoleChoices = {}
  const service = new DelegationService({ directory: f.root, control: f.control, host: workspace.host, historyEnabled: () => true, roles: () => choices,
    ...enabled ? { dynamicThreads: () => settings, ...options.quota ? { providerLimits: options.quota } : {} } : {} })
  cleanups.push(async () => { service.close(); f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start()
  for (const provider of ['claude', 'codex', 'grok'] as const) await f.control.commandShell({ type: 'connect', provider })
  await f.control.commandShell({ type: 'configure', patch: { newThreadRuntimeMode: 'full-access' } })
  await service.recover()
  const model = (provider: ProviderId) => f.control.shell().host.models.find(item => item.providerId === provider)!
  const overseer = async (dynamic = true, text = 'Synthetic user request') => {
    const project = f.control.shell().host.projects.find(item => item.providerId === 'claude')!, threadId = randomUUID()
    expect((await f.control.commandShell({ type: 'create-thread', threadId, projectId: project.id, title: 'Synthetic overseer', modelId: model('claude').id, runtimeMode: 'full-access' })).error).toBeNull()
    if (dynamic) expect((await f.control.commandShell({ type: 'set-thread-dynamic', threadId, dynamic: true })).error).toBeNull()
    expect((await f.control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text })).error).toBeNull()
    const binding = workspace.registry.byThread(threadId)!
    workspace.adapters.claude.state.threads.find(item => item.id === binding.sessionId)!.runtimeMode = 'full-access'
    workspace.adapters.claude.emit()
    await f.control.commandShell({ type: 'refresh', provider: 'claude' })
    return threadId
  }
  const named = (provider: ProviderId, extra: Record<string, unknown> = {}) => ({ work: 'code-review', brief: 'Synthetic brief', wait_seconds: 0, provider, model: model(provider).id, effort: 'high', permission: 'auto', why: 'Synthetic reason.', ...extra })
  const delegate = async (threadId: string, input: Record<string, unknown>) => await service.delegate(threadId, input) as Result
  const ok = (result: Result) => { if (result.status !== 'ok') throw new Error(`refused ${result.code}: ${result.message}`); return result }
  const created = (threadId: string) => {
    const binding = workspace.registry.byThread(threadId)!
    const command = workspace.adapters[binding.provider as keyof typeof workspace.adapters].commands.find(item => item.type === 'create-thread' && item.threadId === binding.sessionId)
    if (command?.type !== 'create-thread') throw new Error('not created')
    return { provider: binding.provider, reasoningEffort: command.reasoningEffort, runtimeMode: command.runtimeMode }
  }
  return { ...f, workspace, service, model, overseer, named, delegate, ok, created, setLimits: (next: Partial<DynamicThreadSettings>) => { settings = { ...settings, ...next } } }
}

it('starts what an overseer names, whatever the role says, and fills in nothing from a role', async () => {
  const f = await fixture(), parent = await f.overseer()
  const result = f.ok(await f.delegate(parent, f.named('codex')))
  expect(f.created(result.delegation.thread)).toMatchObject({ provider: 'codex', reasoningEffort: 'high', runtimeMode: 'auto' })
  expect(result).not.toHaveProperty('role')
  expect(result).not.toHaveProperty('heldToRole')
})

it('refuses a call that does not say what it chose, or why', async () => {
  const f = await fixture(), parent = await f.overseer()
  expect(await f.delegate(parent, { work: 'code-review', brief: 'Synthetic brief', wait_seconds: 0, why: 'Synthetic reason.' })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  const { why: _why, ...withoutWhy } = f.named('codex'); void _why
  const refused = await f.delegate(parent, withoutWhy)
  expect(refused).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect((refused as { message: string }).message).toContain('why is required')
})

it('refuses a provider off the list in plain words, even where the user\'s own message names it, and records it', async () => {
  const f = await fixture(), parent = await f.overseer(true, 'Use Grok Build for the review')
  const refused = await f.delegate(parent, f.named('grok'))
  expect(refused).toMatchObject({ status: 'refused', code: 'PROVIDER_NOT_ALLOWED' })
  expect((refused as { message: string }).message).toContain('Grok Build is off the list Dynamic threads may use. Tell the user they can tick it in Settings, under Threads.')
  expect((refused as { delegation?: string }).delegation).toBeDefined()
  f.setLimits({ providers: ['claude', 'codex', 'grok'] })
  expect(f.created(f.ok(await f.delegate(parent, f.named('grok'))).delegation.thread)).toMatchObject({ provider: 'grok' })
})

it('keeps an overseer to its own provider until the user has seen a list', async () => {
  const f = await fixture({ limits: { providers: undefined } }), parent = await f.overseer()
  expect(await f.delegate(parent, f.named('codex'))).toMatchObject({ status: 'refused', code: 'PROVIDER_NOT_ALLOWED' })
  f.ok(await f.delegate(parent, f.named('claude')))
})

it('holds effort to the most Settings allow, and says so, rather than refusing', async () => {
  const f = await fixture({ limits: { highestEffort: 'high' } }), parent = await f.overseer()
  const result = f.ok(await f.delegate(parent, f.named('codex', { effort: 'max' })))
  expect(f.created(result.delegation.thread)).toMatchObject({ reasoningEffort: 'high' })
  expect(result.delegation.effortHeld).toContain('Its effort, max, was held to high')
  const under = f.ok(await f.delegate(parent, f.named('codex', { effort: 'low' })))
  expect(f.created(under.delegation.thread)).toMatchObject({ reasoningEffort: 'low' })
  expect(under.delegation).not.toHaveProperty('effortHeld')
})

it('turns away a worker past Workers at once without recording a row, and says what to do', async () => {
  const f = await fixture({ limits: { workersAtOnce: 1 } }), parent = await f.overseer()
  f.ok(await f.delegate(parent, f.named('codex')))
  const refused = await f.delegate(parent, f.named('codex'))
  expect(refused).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect((refused as { message: string }).message).toContain('Do this when one returns')
  expect((refused as { delegation?: string }).delegation).toBeUndefined()
})

it('holds a brief to an existing worker to the limits as they stand now', async () => {
  const f = await fixture(), parent = await f.overseer()
  const worker = f.ok(await f.delegate(parent, f.named('codex'))).delegation.thread
  // Its turn ends, so a brief to it is not simply waiting behind that turn.
  const session = f.workspace.registry.byThread(worker)!.sessionId
  // The fake keeps only the model, so the effort the worker runs at is set where the provider reports it.
  Object.assign(f.workspace.adapters.codex.state.threads.find(item => item.id === session)!, { status: 'idle', reasoningEffort: 'high' }); f.workspace.adapters.codex.emit()
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  f.setLimits({ providers: ['claude'] })
  const refused = await f.delegate(parent, { work: 'code-review', brief: 'Another brief', wait_seconds: 0, thread: worker })
  expect(refused).toMatchObject({ status: 'refused', code: 'PROVIDER_NOT_ALLOWED' })
  f.setLimits({ providers: ['claude', 'codex'], highestEffort: 'low' })
  const tooHigh = await f.delegate(parent, { work: 'code-review', brief: 'Another brief', wait_seconds: 0, thread: worker })
  expect(tooHigh).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect((tooHigh as { message: string }).message).toContain('above the most the user\'s Settings allow now')
})

it('says on a retry what Highest effort did, and does not ask for why again of a call made before Dynamic was on', async () => {
  const f = await fixture({ limits: { highestEffort: 'high' } }), parent = await f.overseer()
  const input = f.named('codex', { effort: 'max', retry_key: randomUUID() })
  const first = f.ok(await f.delegate(parent, input))
  expect(first.delegation.effortHeld).toContain('held to high')
  expect(f.ok(await f.delegate(parent, input)).delegation.effortHeld).toBe(first.delegation.effortHeld)
  const plain = await f.overseer(false), asked = { work: 'research', brief: 'Synthetic brief', wait_seconds: 0, retry_key: randomUUID() }
  const start = f.ok(await f.delegate(plain, asked))
  const binding = f.workspace.registry.byThread(plain)!
  f.workspace.adapters.claude.state.threads.find(item => item.id === binding.sessionId)!.status = 'idle'; f.workspace.adapters.claude.emit()
  await f.control.commandShell({ type: 'refresh', provider: 'claude' })
  expect((await f.control.commandShell({ type: 'set-thread-dynamic', threadId: plain, dynamic: true })).error).toBeNull()
  expect(f.ok(await f.delegate(plain, asked)).delegation.id).toBe(start.delegation.id)
})

it('treats an effort Sotto cannot place as past the limit, and refuses a model with none at or under it', async () => {
  const f = await fixture({ limits: { highestEffort: 'high' } }), parent = await f.overseer()
  f.workspace.adapters.codex.state.models[0]!.reasoningEfforts = ['low', 'high', 'ultra']
  f.workspace.adapters.codex.emit()
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  const held = f.ok(await f.delegate(parent, f.named('codex', { effort: 'ultra' })))
  expect(f.created(held.delegation.thread)).toMatchObject({ reasoningEffort: 'high' })
  f.workspace.adapters.codex.state.models[0]!.reasoningEfforts = ['ultra']
  f.workspace.adapters.codex.emit()
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  const refused = await f.delegate(parent, f.named('codex', { effort: 'ultra' }))
  expect(refused).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect((refused as { message: string }).message).toContain('offers no effort at or under high')
})

it('turns away a worker that asks for a machine or a system, rather than ignoring it', async () => {
  const f = await fixture(), parent = await f.overseer()
  const worker = f.ok(await f.delegate(parent, f.named('codex'))).delegation.thread
  expect(await f.delegate(worker, { work: 'research', brief: 'Synthetic brief', wait_seconds: 0, os: 'windows' })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
})

it('refuses a swarm and a machine on a Dynamic thread', async () => {
  const f = await fixture(), parent = await f.overseer()
  expect(await f.delegate(parent, f.named('codex', { count: 2 }))).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect(await f.delegate(parent, f.named('codex', { os: 'linux' }))).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
})

it('holds a worker\'s own start to the list above it, and its role still holds for it', async () => {
  const f = await fixture(), parent = await f.overseer()
  const worker = f.ok(await f.delegate(parent, f.named('codex'))).delegation.thread
  const refused = await f.delegate(worker, { work: 'research', brief: 'Synthetic brief', wait_seconds: 0, provider: 'grok', model: f.model('grok').id, effort: 'high', permission: 'auto' })
  // Its role holds first, as for any thread that is not the overseer, and a role's model off the list is refused too.
  expect(refused.status === 'refused' ? refused.code : (refused as { heldToRole?: string }).heldToRole).toBeTruthy()
  if (refused.status === 'ok') expect(f.created(refused.delegation.thread).provider).not.toBe('grok')
})

it('leaves every other thread as it was, with the role holding', async () => {
  const f = await fixture(), parent = await f.overseer(false)
  const result = f.ok(await f.delegate(parent, f.named('grok')))
  expect(result).toHaveProperty('heldToRole')
})

it('does nothing of this with the feature off, where a saved mark stays whole', async () => {
  const f = await fixture({ enabled: false }), parent = await f.overseer(false)
  const result = f.ok(await f.delegate(parent, f.named('grok')))
  expect(result).toHaveProperty('heldToRole')
  expect(f.created(result.delegation.thread).provider).not.toBe('grok')
})

it('reads an overseer only the models on its list, what each can do and what is left of its limits', async () => {
  const quota = vi.fn(async (provider: ProviderId): Promise<UsageQuotaRead | undefined> => provider === 'codex'
    ? { providerId: 'codex', status: 'available', refreshable: true, observedAt: '2026-11-04T10:00:00.000Z', windows: [{ id: 'week', label: 'Week', kind: 'weekly', usedPercent: 19, resetsAt: '2026-11-09T00:00:00.000Z' }] }
    : { providerId: 'claude', status: 'unavailable', refreshable: true, windows: [], reason: 'not-read' })
  const f = await fixture({ quota }), parent = await f.overseer()
  const read = await f.service.read(parent, {}) as { models: { provider: string }[]; roles?: unknown; providers: { provider: string; can: string[]; limits: unknown }[]; highestEffort: string; workersAtOnce: number }
  expect(new Set(read.models.map(model => model.provider))).toEqual(new Set(['claude', 'codex']))
  expect(read).not.toHaveProperty('roles')
  expect(read.highestEffort).toBe('xhigh')
  expect(read.workersAtOnce).toBe(4)
  const codex = read.providers.find(item => item.provider === 'codex')!
  expect(codex.limits).toEqual({ windows: [{ label: 'Week', usedPercent: 19, resetsAt: '2026-11-09T00:00:00.000Z' }], readAt: '2026-11-04T10:00:00.000Z' })
  expect(codex.can.join(' ')).toContain('Computer Use')
  expect(read.providers.find(item => item.provider === 'claude')!.limits).toContain('not known')
  // An ordinary thread's read is as it was.
  const plain = await f.service.read(await f.overseer(false), {}) as Record<string, unknown>
  expect(plain).toHaveProperty('roles')
  expect(plain).not.toHaveProperty('providers')
})

it('lets go of what a new worker replaces: its restart at the reset, and its turn if that restart has already gone', async () => {
  const f = await fixture(), parent = await f.overseer()
  const cancel = vi.fn(() => true)
  ;(f.control as unknown as { cancelLimitRestart: typeof cancel }).cancelLimitRestart = cancel
  const first = f.ok(await f.delegate(parent, f.named('codex')))
  const moved = f.ok(await f.delegate(parent, f.named('claude', { replaces: first.delegation.id, why: 'Codex stopped at its limit.' })))
  expect(moved.delegation.thread).not.toBe(first.delegation.thread)
  expect(cancel).toHaveBeenCalledWith(first.delegation.thread)
  // A worker cannot be made to let go of a delegation that is not its overseer's own.
  cancel.mockClear()
  const other = await f.overseer()
  f.ok(await f.delegate(other, f.named('claude', { replaces: first.delegation.id })))
  expect(cancel).not.toHaveBeenCalled()
})

it('leaves alone what the user has said since in the thread a new worker replaces', async () => {
  const f = await fixture(), parent = await f.overseer()
  const cancel = vi.fn(() => true)
  ;(f.control as unknown as { cancelLimitRestart: typeof cancel }).cancelLimitRestart = cancel
  const first = f.ok(await f.delegate(parent, f.named('codex')))
  // The worker's turn ends, and the user takes the thread up themselves.
  const session = f.workspace.registry.byThread(first.delegation.thread)!.sessionId
  f.workspace.adapters.codex.state.threads.find(item => item.id === session)!.status = 'idle'; f.workspace.adapters.codex.emit()
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect((await f.control.commandShell({ type: 'manual-send', threadId: first.delegation.thread, draftId: randomUUID(), text: 'My own message there' })).error).toBeNull()
  await expect.poll(() => f.control.shell().host.threads.find(item => item.id === first.delegation.thread)?.status).toBe('running')
  const stops = () => f.workspace.adapters.codex.commands.filter(command => command.type === 'interrupt').length
  const before = stops()
  f.ok(await f.delegate(parent, f.named('claude', { replaces: first.delegation.id })))
  expect(stops()).toBe(before)
  expect(cancel).not.toHaveBeenCalled()
})
