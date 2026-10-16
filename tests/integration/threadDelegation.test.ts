// @vitest-environment node
// ADR-0081's proof over fake providers: an ordinary thread delegates to a thread it starts, under rules main enforces.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { DelegationService } from '../../src/main/agents/delegation'
import { DelegationToolServer } from '../../src/main/agents/delegationTools'
import type { AgentThread, ProviderId } from '../../src/shared/agents'
import { DELEGATE_MCP_SERVER } from '../../src/shared/delegation'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { firstMessageTitleWriter } from '../../src/main/llm/threadTitle'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

type Read = { status: 'ok'; delegation: { id: string; thread: string; outcome: string; reply?: { from: string; text: string }; refusal?: string; userSentSince?: boolean }; limits: { inFlight: number; prompts?: number } }
type Refused = { status: 'refused'; code: string; message: string }

async function fixture(options: { limit?: number; otherStarts?: number; history?: boolean; titles?: boolean } = {}) {
  const history = options.history ?? true
  const workspace = await workspaceFixture(undefined, { history, watcherEnabled: false })
  cleanups.push(workspace.remove)
  // Codex offers every mode, so only the ceiling can refuse a wider one.
  workspace.adapters.codex.state.models[0]!.runtimeModes = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host,
    credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => history, watcherEnabled: false,
      // Sotto's own naming, as the app runs it: the first message's opening words, then a generated name after the first reply.
      ...options.titles ? { writeFirstMessageTitle: firstMessageTitleWriter(() => DEFAULT_SETTINGS), writeThreadTitle: async () => 'Synthetic generated name' } : {} } })
  const make = () => new DelegationService({ directory: f.root, control: f.control, host: workspace.host, historyEnabled: () => history,
    limit: () => options.limit ?? 4, otherStartsInFlight: () => options.otherStarts ?? 0 })
  let service = make()
  let tools = new DelegationToolServer(service)
  workspace.host.useThreadTools([tools])
  cleanups.push(async () => { service.close(); await tools.close(); f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start()
  for (const provider of ['claude', 'codex', 'grok'] as const) await f.control.commandShell({ type: 'connect', provider })
  await service.recover()
  const model = (provider: ProviderId) => f.control.shell().host.models.find(item => item.providerId === provider)!
  const native = (threadId: string): AgentThread => {
    const binding = workspace.registry.byThread(threadId)!
    return workspace.adapters[binding.provider as keyof typeof workspace.adapters].state.threads.find(item => item.id === binding.sessionId)!
  }
  const adapterOf = (threadId: string) => workspace.adapters[workspace.registry.byThread(threadId)!.provider as keyof typeof workspace.adapters]
  const emit = async (threadId: string) => {
    const binding = workspace.registry.byThread(threadId)!
    workspace.adapters[binding.provider as keyof typeof workspace.adapters].emit()
    await f.control.commandShell({ type: 'refresh', provider: binding.provider as ProviderId })
  }
  /** The provider ends the running turn, naming it by the user message it began with. */
  const endTurn = async (threadId: string, reply: string, status: 'completed' | 'interrupted' | 'failed' = 'completed') => {
    const thread = native(threadId)
    thread.messages.push({ id: randomUUID(), role: 'assistant', text: reply, createdAt: new Date().toISOString() })
    thread.lastTurn = { id: thread.messages.findLast(message => message.role === 'user')!.id, status }
    thread.status = 'idle'
    await emit(threadId)
  }
  /** A thread the user opened on `provider` and sent a message, as the user's own. */
  const userThread = async (provider: ProviderId) => {
    const project = f.control.shell().host.projects.find(item => item.providerId === provider) ?? f.control.shell().host.projects[0]!
    const threadId = randomUUID()
    expect((await f.control.commandShell({ type: 'create-thread', threadId, projectId: project.id, title: `Synthetic ${provider} thread`, modelId: model(provider).id })).error).toBeNull()
    expect((await f.control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic user request' })).error).toBeNull()
    return threadId
  }
  // A new thread names its effort and permission, as delegate requires; a send to a delegated thread names neither.
  const delegate = async (threadId: string, input: Record<string, unknown>) => await service.delegate(threadId, { work: 'code-review', brief: 'Synthetic brief',
    ...input.thread === undefined ? { effort: 'low', permission: 'approval-required' } : {}, ...input }) as Read | Refused
  const read = async (threadId: string, delegation: string) => await service.read(threadId, { delegation }) as Read
  const ok = (result: Read | Refused): Read => { if (result.status !== 'ok') throw new Error(`refused ${result.code}: ${result.message}`); return result }
  const restart = async () => {
    service.close(); await tools.close()
    service = make(); tools = new DelegationToolServer(service)
    workspace.host.useThreadTools([tools])
    await service.recover()
  }
  return { ...f, workspace, model, native, adapterOf, emit, endTurn, userThread, delegate, read, ok, restart, get service() { return service }, get tools() { return tools } }
}

it('starts a Codex thread for a Claude Code thread, and the wait returns its answer as the delegated thread\'s words', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const call = f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 60 })
  await vi.waitFor(() => expect(f.control.shell().host.threads.find(thread => thread.delegatedBy === parent)?.status).toBe('running'))
  const child = f.control.shell().host.threads.find(thread => thread.delegatedBy === parent)!
  expect(child.providerId).toBe('codex')
  expect(f.native(child.id).messages[0]).toMatchObject({ role: 'user', text: 'Synthetic brief' })
  await f.endTurn(child.id, 'Synthetic review reply')
  const result = f.ok(await call)
  expect(result.delegation).toMatchObject({ thread: child.id, outcome: 'answered', reply: { from: 'delegated-thread', text: 'Synthetic review reply' } })
  expect(result.limits.prompts).toBe(1)
  // The link is in the snapshot by Sotto thread ID, and the record keeps identities only.
  expect(f.control.shell().host.threads.find(thread => thread.id === child.id)?.delegatedBy).toBe(parent)
  const saved = await import('node:fs/promises').then(fs => fs.readFile(`${f.root}/delegations.json`, 'utf8'))
  expect(saved).not.toContain('Synthetic brief')
  expect(saved).not.toContain('Synthetic review reply')
})

it('keeps the title the delegating thread gave, and names an untitled delegated thread as Sotto names any thread', async () => {
  const f = await fixture({ titles: true }), parent = await f.userThread('claude')
  const titled = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, title: 'Synthetic chosen name', wait_seconds: 0 })).delegation.thread
  const untitled = f.ok(await f.delegate(parent, { provider: 'grok', model: f.model('grok').id, wait_seconds: 0 })).delegation.thread
  const thread = (threadId: string) => f.control.shell().host.threads.find(item => item.id === threadId)!
  // The brief's opening words name the untitled thread as soon as it is sent.
  await vi.waitFor(() => expect(thread(untitled).title).toBe('Synthetic brief'))
  await f.endTurn(titled, 'Synthetic titled reply')
  await f.endTurn(untitled, 'Synthetic untitled reply')
  // After the first reply, a generated name replaces only the stand-in; the given title stays.
  await vi.waitFor(() => expect(thread(untitled).title).toBe('Synthetic generated name'))
  expect(thread(titled)).toMatchObject({ title: 'Synthetic chosen name', titleSource: 'user' })
})

it('turns a wait that ends first into a wake-up carrying identities only', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const result = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  expect(result.delegation.outcome).toBe('working')
  await f.endTurn(result.delegation.thread, 'Synthetic later reply')
  // The parent's own turn is still running, so the wake-up waits in its queue, where its words can be read.
  await vi.waitFor(() => expect(f.control.shell().followups?.find(item => item.threadId === parent && item.wakeUp)).toBeDefined())
  const wake = f.control.shell().followups!.find(item => item.threadId === parent && item.wakeUp)!
  expect(wake.text).toContain(`Delegation ${result.delegation.id} to thread ${result.delegation.thread}`)
  expect(wake.text).toContain('answered')
  expect(wake.text).not.toContain('Synthetic later reply')
  expect(f.ok(await f.read(parent, result.delegation.id)).delegation).toMatchObject({ outcome: 'answered', reply: { text: 'Synthetic later reply' } })
})

it('stops both levels below the thread the user stops, and only the second level when that is the one stopped', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const first = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  const child = first.delegation.thread
  // The delegated thread delegates once more, to a third provider.
  const second = f.ok(await f.delegate(child, { provider: 'grok', model: f.model('grok').id, wait_seconds: 0 }))
  const grandchild = second.delegation.thread
  await vi.waitFor(() => expect(f.native(grandchild).status).toBe('running'))
  // Stop on the second level stops only it.
  await f.control.commandShell({ type: 'interrupt', threadId: grandchild })
  expect(f.native(child).status).toBe('running')
  // Stop on the top thread stops every working thread below it in the same press.
  const third = f.ok(await f.delegate(child, { provider: 'grok', model: f.model('grok').id, wait_seconds: 0, work: 'research' }))
  await vi.waitFor(() => expect(f.native(third.delegation.thread).status).toBe('running'))
  await f.control.commandShell({ type: 'interrupt', threadId: parent })
  await vi.waitFor(() => {
    expect(f.native(child).status).toBe('idle')
    expect(f.native(third.delegation.thread).status).toBe('idle')
  })
  expect(f.adapterOf(child).commands.filter(command => command.type === 'interrupt')).toHaveLength(1)
  expect(f.adapterOf(third.delegation.thread).commands.filter(command => command.type === 'interrupt' && command.threadId === f.workspace.registry.byThread(third.delegation.thread)!.sessionId)).toHaveLength(1)
})

it('refuses a start wider than the delegating thread\'s permission and the new-thread default, or one that names none', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  expect(await f.service.delegate(parent, { work: 'research', brief: 'Synthetic brief', provider: 'codex', model: f.model('codex').id, effort: 'low' }))
    .toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect(await f.service.delegate(parent, { work: 'research', brief: 'Synthetic brief', provider: 'codex', model: f.model('codex').id, permission: 'approval-required' }))
    .toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  const refused = await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, permission: 'full-access' }) as Refused
  expect(refused).toMatchObject({ status: 'refused', code: 'PERMISSION_TOO_WIDE' })
  expect(f.control.shell().host.threads.some(thread => thread.delegatedBy === parent)).toBe(false)
})

it('offers sotto_delegate to the first level and not to a thread a delegated thread started', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const child = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 })).delegation.thread
  const grandchild = f.ok(await f.delegate(child, { provider: 'grok', model: f.model('grok').id, wait_seconds: 0 })).delegation.thread
  expect((await f.tools.mcpServer(parent))?.name).toBe(DELEGATE_MCP_SERVER)
  expect((await f.tools.mcpServer(child))?.name).toBe(DELEGATE_MCP_SERVER)
  expect(await f.tools.mcpServer(grandchild)).toBeUndefined()
  expect(await f.delegate(grandchild, { provider: 'codex', model: f.model('codex').id })).toMatchObject({ status: 'refused', code: 'LEVEL_LIMIT' })
  expect((await f.tools.call(grandchild, 'delegate', { work: 'research', brief: 'Synthetic brief', provider: 'codex', model: f.model('codex').id })).isError).toBe(true)
})

it('pauses delegated sends while the user is typing in the delegated thread', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const first = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  await f.endTurn(first.delegation.thread, 'Synthetic first reply')
  await vi.waitFor(async () => expect(f.ok(await f.read(parent, first.delegation.id)).delegation.outcome).toBe('answered'))
  await f.control.commandShell({ type: 'save-thread-draft', threadId: first.delegation.thread, draftId: randomUUID(), text: 'The user is typing', requestId: null })
  expect(await f.delegate(parent, { thread: first.delegation.thread, brief: 'Synthetic second brief' })).toMatchObject({ status: 'refused', code: 'PAUSED' })
  expect(f.native(first.delegation.thread).messages.some(message => message.text === 'Synthetic second brief')).toBe(false)
})

it('refuses a send queued before the user\'s newer message as the target having changed, and delivers nothing', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const first = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  const child = first.delegation.thread
  // The delegated thread is still working on the first brief, so the second waits for it.
  const queued = f.ok(await f.delegate(parent, { thread: child, brief: 'Synthetic queued brief', wait_seconds: 0 }))
  expect(queued.delegation.outcome).toBe('working')
  // The user sends their own message to the delegated thread meanwhile.
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: child, draftId: randomUUID(), text: 'Synthetic user instruction' })).error).toBeNull()
  const read = f.ok(await f.read(parent, queued.delegation.id))
  expect(read.delegation).toMatchObject({ outcome: 'paused', refusal: 'TARGET_CHANGED' })
  await f.endTurn(child, 'Synthetic first reply')
  await vi.waitFor(() => expect(f.native(child).messages.some(message => message.text === 'Synthetic user instruction')).toBe(true))
  expect(f.native(child).messages.some(message => message.text === 'Synthetic queued brief')).toBe(false)
})

it('leaves a brief unknown after a restart and sends nothing again', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const first = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  const child = first.delegation.thread
  const sends = () => f.adapterOf(child).commands.filter(command => command.type === 'send').length
  const before = sends()
  await f.restart()
  expect(f.ok(await f.read(parent, first.delegation.id)).delegation.outcome).toBe('unknown')
  await f.endTurn(child, 'Synthetic reply after restart')
  const read = f.ok(await f.read(parent, first.delegation.id))
  expect(read.delegation.outcome).toBe('unknown')
  expect(read.delegation.reply).toBeUndefined()
  expect(sends()).toBe(before)
  // The link survives the restart, on the thread's own record and in the delegation record.
  expect(f.control.shell().host.threads.find(thread => thread.id === child)?.delegatedBy).toBe(parent)
  expect((await f.tools.mcpServer(child))?.name).toBe(DELEGATE_MCP_SERVER)
  expect(f.control.shell().followups?.some(item => item.threadId === parent && item.wakeUp)).toBeFalsy()
})

it('shares the starts limit with Watcher and refuses a full one with how many are in flight', async () => {
  const f = await fixture({ limit: 2, otherStarts: 1 }), parent = await f.userThread('claude')
  f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  const refused = await f.delegate(parent, { provider: 'grok', model: f.model('grok').id, wait_seconds: 0 }) as Refused
  expect(refused).toMatchObject({ status: 'refused', code: 'IN_FLIGHT_LIMIT' })
  expect(refused.message).toMatch(/^2 new threads are in flight/u)
})

it('gives each delegated thread four briefs per turn of the delegating thread, renewed by the user\'s next message alone', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const first = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  const child = first.delegation.thread
  for (let brief = 2; brief <= 4; brief++) {
    await f.endTurn(child, `Synthetic reply ${brief - 1}`)
    await vi.waitFor(async () => expect(f.ok(await f.read(parent, (await f.service.read(parent, {}) as { delegations: { id: string }[] }).delegations.at(-1)!.id)).delegation.outcome).toBe('answered'))
    const sent = f.ok(await f.delegate(parent, { thread: child, brief: `Synthetic brief ${brief}`, wait_seconds: 0 }))
    expect(sent.limits.prompts).toBe(brief)
  }
  await f.endTurn(child, 'Synthetic reply 4')
  await vi.waitFor(async () => expect(f.ok(await f.read(parent, (await f.service.read(parent, {}) as { delegations: { id: string }[] }).delegations.at(-1)!.id)).delegation.outcome).toBe('answered'))
  expect(await f.delegate(parent, { thread: child, brief: 'Synthetic brief 5' })).toMatchObject({ status: 'refused', code: 'PROMPT_LIMIT' })
  // A retry with the same key returns the first delegation and charges nothing.
  const key = randomUUID()
  expect(await f.delegate(parent, { thread: child, brief: 'Synthetic brief 5', retry_key: key })).toMatchObject({ status: 'refused', code: 'PROMPT_LIMIT' })
})

it('records a delegation it refuses as refused, holding no slot, starting and sending nothing, and telling no wake-up', async () => {
  const f = await fixture({ limit: 2, otherStarts: 1 }), parent = await f.userThread('claude')
  const first = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  const started = () => f.control.shell().host.threads.filter(thread => thread.delegatedBy === parent).length
  const refused = await f.delegate(parent, { provider: 'grok', model: f.model('grok').id, wait_seconds: 0 }) as Refused & { delegation?: string }
  expect(refused).toMatchObject({ status: 'refused', code: 'IN_FLIGHT_LIMIT' })
  expect(refused.delegation).toBeDefined()
  expect(started()).toBe(1)
  const read = f.ok(await f.read(parent, refused.delegation!))
  expect(read.delegation).toMatchObject({ id: refused.delegation, outcome: 'refused', refusal: 'IN_FLIGHT_LIMIT', note: refused.message, provider: 'grok', action: 'start' })
  expect(read.delegation.thread).toBeUndefined()
  // It holds no slot: the in-flight count is the first delegation's and Watcher's alone.
  expect(read.limits.inFlight).toBe(2)
  expect(f.service.startsInFlight()).toBe(1)
  // A cancel has nothing to stop, and the listing names it beside the delegation that started.
  expect(await f.service.cancel(parent, { delegation: refused.delegation })).toMatchObject({ status: 'ok', delegation: { outcome: 'refused' } })
  const listed = await f.service.read(parent, {}) as { delegations: { id: string; outcome: string }[] }
  expect(listed.delegations.map(item => [item.id, item.outcome])).toEqual([[first.delegation.id, 'working'], [refused.delegation, 'refused']])
  // A refused send to a thread it delegated to names that thread, and sends nothing.
  await f.control.commandShell({ type: 'save-thread-draft', threadId: first.delegation.thread, draftId: randomUUID(), text: 'The user is typing', requestId: null })
  const send = await f.delegate(parent, { thread: first.delegation.thread, brief: 'Synthetic second brief', wait_seconds: 0 }) as Refused & { delegation?: string }
  expect(send).toMatchObject({ status: 'refused', code: 'PAUSED' })
  expect(f.ok(await f.read(parent, send.delegation!)).delegation).toMatchObject({ outcome: 'refused', refusal: 'PAUSED', thread: first.delegation.thread, action: 'send' })
  expect(f.native(first.delegation.thread).messages.some(message => message.text === 'Synthetic second brief')).toBe(false)
  // A call with arguments to correct is not a delegation, so nothing is recorded.
  const invalid = await f.service.delegate(parent, { work: 'research', brief: 'Synthetic brief', provider: 'codex', model: f.model('codex').id }) as Refused & { delegation?: string }
  expect(invalid).toMatchObject({ code: 'INVALID_INPUT' })
  expect(invalid.delegation).toBeUndefined()
  // It is kept across a restart, and nothing about it reaches the delegating thread as a wake-up.
  await f.restart()
  expect(f.ok(await f.read(parent, refused.delegation!)).delegation).toMatchObject({ outcome: 'refused', refusal: 'IN_FLIGHT_LIMIT' })
  expect(f.control.shell().followups?.some(item => item.threadId === parent && item.wakeUp)).toBeFalsy()
})

it('records the refusal of a thread that may not delegate, with its rule, through the tool server', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const child = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 })).delegation.thread
  const grandchild = f.ok(await f.delegate(child, { provider: 'grok', model: f.model('grok').id, wait_seconds: 0 })).delegation.thread
  const call = await f.tools.call(grandchild, 'delegate', { work: 'research', brief: 'Synthetic brief', provider: 'codex', model: f.model('codex').id, effort: 'low', permission: 'approval-required' })
  expect(call.isError).toBe(true)
  expect(call.structuredContent).toMatchObject({ status: 'refused', code: 'LEVEL_LIMIT', delegation: expect.any(String) })
  const saved = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(`${f.root}/delegations.json`, 'utf8'))) as { refusals?: { delegatingThreadId: string; code: string; provider?: string }[] }
  expect(saved.refusals).toEqual([expect.objectContaining({ delegatingThreadId: grandchild, code: 'LEVEL_LIMIT', provider: 'codex' })])
  expect(JSON.stringify(saved)).not.toContain('Synthetic brief')
})
