// @vitest-environment node
// #1041 over ADR-0081: with worker roles on, `delegate` names the kind of work and main fills the provider, model, effort
// and permission from the user's Settings for that role, within the delegation's ceiling.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { DelegationService } from '../../src/main/agents/delegation'
import type { AgentRuntimeMode, ProviderId } from '../../src/shared/agents'
import type { WorkerRoleChoices } from '../../src/shared/workerRoles'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const ALL_MODES: AgentRuntimeMode[] = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']

type Result = { status: 'ok'; delegation: { id: string; thread: string; outcome: string }; role?: { work: string; named: string[]; note: string } }
  | { status: 'refused'; code: string; message: string }

async function fixture(options: { roles?: boolean; newThread?: AgentRuntimeMode; grokModes?: AgentRuntimeMode[] } = {}) {
  const workspace = await workspaceFixture(undefined, { history: true, watcherEnabled: false })
  cleanups.push(workspace.remove)
  // Every provider offers every mode, so only the ceiling narrows a permission.
  for (const adapter of Object.values(workspace.adapters)) adapter.state.models[0]!.runtimeModes = [...ALL_MODES]
  if (options.grokModes) workspace.adapters.grok.state.models[0]!.runtimeModes = [...options.grokModes]
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host,
    credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => true, watcherEnabled: false } })
  let choices: WorkerRoleChoices = {}, reads = 0
  const service = new DelegationService({ directory: f.root, control: f.control, host: workspace.host, historyEnabled: () => true, limit: () => 4,
    ...(options.roles === false ? {} : { roles: () => { reads++; return choices } }) })
  cleanups.push(async () => { service.close(); f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start()
  for (const provider of ['claude', 'codex', 'grok'] as const) await f.control.commandShell({ type: 'connect', provider })
  await f.control.commandShell({ type: 'configure', patch: { newThreadRuntimeMode: options.newThread ?? 'full-access' } })
  await service.recover()
  const model = (provider: ProviderId) => f.control.shell().host.models.find(item => item.providerId === provider)!
  /** A thread the user opened on Claude Code with this permission and sent a message, as the user's own. */
  const userThread = async (runtimeMode: AgentRuntimeMode) => {
    const project = f.control.shell().host.projects.find(item => item.providerId === 'claude')!
    const threadId = randomUUID()
    expect((await f.control.commandShell({ type: 'create-thread', threadId, projectId: project.id, title: 'Synthetic delegating thread', modelId: model('claude').id, runtimeMode })).error).toBeNull()
    expect((await f.control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic user request' })).error).toBeNull()
    // The fake provider keeps only the model, so the thread's own permission is set where the provider reports it.
    const binding = workspace.registry.byThread(threadId)!
    workspace.adapters.claude.state.threads.find(item => item.id === binding.sessionId)!.runtimeMode = runtimeMode
    workspace.adapters.claude.emit()
    await f.control.commandShell({ type: 'refresh', provider: 'claude' })
    expect(f.control.shell().host.threads.find(item => item.id === threadId)?.runtimeMode).toBe(runtimeMode)
    return threadId
  }
  const delegate = async (threadId: string, input: Record<string, unknown>) =>
    await service.delegate(threadId, { work: 'code-review', brief: 'Synthetic brief', wait_seconds: 0, ...input }) as Result
  const ok = (result: Result) => { if (result.status !== 'ok') throw new Error(`refused ${result.code}: ${result.message}`); return result }
  /** How the delegated thread was created, read from the command its provider was sent: the fake keeps only the model. */
  const created = (threadId: string) => {
    const binding = workspace.registry.byThread(threadId)!
    const command = workspace.adapters[binding.provider as keyof typeof workspace.adapters].commands.find(item => item.type === 'create-thread' && item.threadId === binding.sessionId)
    if (command?.type !== 'create-thread') throw new Error('not created')
    return { provider: binding.provider, reasoningEffort: command.reasoningEffort, runtimeMode: command.runtimeMode }
  }
  const delegated = (parent: string) => f.control.shell().host.threads.filter(thread => thread.delegatedBy === parent)
  return { ...f, workspace, service, model, userThread, delegate, ok, created, delegated,
    setChoices: (next: WorkerRoleChoices) => { choices = next }, reads: () => reads }
}

it('starts a thread on its kind of work\'s worker role when the call names nothing else', async () => {
  const f = await fixture({ newThread: 'full-access' }), parent = await f.userThread('full-access')
  f.setChoices({ 'code-review': { modelId: f.model('grok').id, reasoningEffort: 'high', runtimeMode: 'auto-accept-edits' } })
  const reads = f.reads()
  const result = f.ok(await f.delegate(parent, {}))
  expect(f.reads()).toBe(reads + 1)
  expect(f.created(result.delegation.thread)).toEqual({ provider: 'grok', reasoningEffort: 'high', runtimeMode: 'auto-accept-edits' })
  expect(result.role).toMatchObject({ work: 'code-review', named: [] })
  expect(result.role!.note).toContain('Started as Code review, a worker role in the user\'s Settings.')
  expect(result.role!.note).not.toContain('held')
})

it('holds a role\'s permission to the narrower of the calling thread\'s own and the new-thread default', async () => {
  const f = await fixture({ newThread: 'full-access' }), parent = await f.userThread('approval-required')
  f.setChoices({ building: { modelId: f.model('codex').id, reasoningEffort: 'low' } })
  const result = f.ok(await f.delegate(parent, { work: 'building' }))
  expect(f.created(result.delegation.thread)).toMatchObject({ provider: 'codex', runtimeMode: 'approval-required' })
  // The calling thread's own Ask for approval is the narrower limit here, and the note names it rather than the default.
  expect(result.role!.note).toContain('Its permission, Allow edits, was held to Ask for approval, the delegating thread\'s own, since a delegated thread gets no more.')
})

it('says the model does not offer the limit\'s mode when that, not the limit itself, held a role\'s permission', async () => {
  // Grok Build offers no Allow edits, so a new-thread default of Allow edits starts it on the nearest it offers below.
  const f = await fixture({ newThread: 'auto-accept-edits', grokModes: ['approval-required', 'auto', 'full-access'] }), parent = await f.userThread('full-access')
  f.setChoices({ 'computer-use': { modelId: f.model('grok').id, reasoningEffort: 'high', runtimeMode: 'full-access' } })
  const result = f.ok(await f.delegate(parent, { work: 'computer-use' }))
  expect(f.created(result.delegation.thread)).toMatchObject({ provider: 'grok', runtimeMode: 'approval-required' })
  expect(result.role!.note).toContain('Its permission, Full access, was held to Ask for approval: the user\'s new-thread default is Allow edits, which this model does not offer, so it starts on the nearest mode the model does.')
  expect(result.role!.note).not.toContain('held to the user\'s new-thread default, Ask for approval')
})

it('lets a named provider and model override the role, with effort and permission still from the role', async () => {
  const f = await fixture({ newThread: 'full-access' }), parent = await f.userThread('full-access')
  f.setChoices({ research: { modelId: f.model('grok').id, reasoningEffort: 'high', runtimeMode: 'auto' } })
  const result = f.ok(await f.delegate(parent, { work: 'research', provider: 'codex', model: f.model('codex').id }))
  expect(f.created(result.delegation.thread)).toEqual({ provider: 'codex', reasoningEffort: 'high', runtimeMode: 'auto' })
  expect(result.role).toMatchObject({ work: 'research', named: ['model'] })
  expect(result.role!.note).toContain('which overrides Research for this start only.')
  expect(result.role!.note).toContain('Its effort and permission came from the role.')
  // A retry with the same key returns the delegation without the role block, and starts nothing new.
  const key = randomUUID(), first = f.ok(await f.delegate(parent, { work: 'research', retry_key: key }))
  expect(first.role).toBeDefined()
  const retry = f.ok(await f.delegate(parent, { work: 'research', retry_key: key }))
  expect(retry.delegation.id).toBe(first.delegation.id)
  expect(retry).not.toHaveProperty('role')
  expect(f.delegated(parent)).toHaveLength(2)
})

it('still refuses a named permission wider than the ceiling, and a provider or model named alone', async () => {
  const f = await fixture({ newThread: 'approval-required' }), parent = await f.userThread('full-access')
  expect(await f.delegate(parent, { permission: 'full-access' })).toMatchObject({ status: 'refused', code: 'PERMISSION_TOO_WIDE' })
  expect(await f.delegate(parent, { provider: 'codex' })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect(await f.delegate(parent, { model: f.model('codex').id })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect(f.delegated(parent)).toHaveLength(0)
})

it('lists what each kind of work would start on now, held to this thread\'s ceiling', async () => {
  const f = await fixture({ newThread: 'auto' }), parent = await f.userThread('full-access')
  f.setChoices({ 'computer-use': { modelId: f.model('codex').id, reasoningEffort: 'high' } })
  const listing = await f.service.read(parent, {}) as { status: 'ok'; roles?: { work: string; provider: string; model: string; effort?: string; permission?: string }[] }
  expect(listing.roles?.map(item => item.work)).toEqual(['building', 'ui', 'code-review', 'research', 'computer-use'])
  expect(listing.roles?.find(item => item.work === 'computer-use')).toEqual({ work: 'computer-use', provider: 'codex', model: f.model('codex').id, effort: 'high', permission: 'auto' })
})

it('with worker roles off, refuses a new thread that names no provider and model, as before', async () => {
  const f = await fixture({ roles: false }), parent = await f.userThread('full-access')
  const refused = await f.delegate(parent, { effort: 'low', permission: 'approval-required' })
  expect(refused).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  if (refused.status !== 'refused') throw new Error('not refused')
  expect(refused.message).toMatch(/^Name the provider and model for a new thread\./)
  const named = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, effort: 'low', permission: 'approval-required' }))
  expect(named).not.toHaveProperty('role')
  expect(await f.service.read(parent, {})).not.toHaveProperty('roles')
})
