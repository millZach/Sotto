// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfiguredProviderHost, providerEntityId } from '../../../src/main/agents/providerSwitch'
import { SottoThreadHost, ThreadRegistry } from '../../../src/main/agents/threads'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { agentCommandSchema, agentConfigurationSchema, capabilitiesForThread, defaultAgentConfiguration, enabledThreadProviders, isThreadProviderConnected, type AgentConfiguration, } from '../../../src/shared/agents'
import { MemoryStore } from '../../../src/main/memory/store'
import { MemoryProfile } from '../../../src/main/memory/profile'
import { PolicyStore } from '../../../src/main/memory/policies'
import { memoryTopics } from '../../../src/shared/memory'
import type { AgentReasoner } from '../../../src/main/agents/reasoning'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-independent-providers-'))
  const registry = new ThreadRegistry(root)
  const adapters = { codex: new FakeProviderHost(), claude: new FakeProviderHost(), grok: new FakeProviderHost() }
  for (const adapter of Object.values(adapters)) adapter.state.capabilities.configureThread = true
  let configuration: AgentConfiguration = { ...defaultAgentConfiguration(), enabledProviders: ['codex', 'claude', 'grok'] }
  const host = new ConfiguredProviderHost({
    directory: root,
    hosts: { codex: new SottoThreadHost('codex', adapters.codex, registry), claude: new SottoThreadHost('claude', adapters.claude, registry), grok: new SottoThreadHost('grok', adapters.grok, registry) },
    provider: () => configuration.provider, enabledProviders: () => enabledThreadProviders(configuration), threadProvider: id => registry.byThread(id)?.provider,
  })
  cleanup.push(async () => { host.disconnect(); await registry.flush(); await rm(root, { recursive: true, force: true }) })
  return { root, registry, adapters, host, configuration: (value: AgentConfiguration) => { configuration = value } }
}
async function coordinator(f: Awaited<ReturnType<typeof fixture>>, decide: AgentReasoner['decide'] = async () => ({ decision: 'human', text: 'Review' })) {
  const credentials = new AgentCredentials(join(f.root, 'vault'), { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
  await credentials.load()
  const control = new AgentControl({ directory: f.root, host: f.host, credentials,
    reasoner: { intent: async () => ({ type: 'clarify', text: 'Choose a thread' }), decide },
    membership: { status: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }) } })
  control.subscribe(state => f.configuration(state.configuration))
  await control.start(); f.configuration(control.get().configuration)
  cleanup.push(async () => { control.dispose() })
  return control
}

describe('independent thread providers', () => {
  it('keeps legacy selection and strictly parses scoped commands without injecting configuration defaults', () => {
    const legacy = { ...defaultAgentConfiguration(), provider: 'claude' as const }
    expect(enabledThreadProviders(agentConfigurationSchema.parse(legacy))).toEqual(['claude'])
    expect(enabledThreadProviders({ ...legacy, enabledProviders: [] })).toEqual([])
    expect(agentCommandSchema.parse({ type: 'configure', patch: { reasoning: 'grok' } })).toEqual({ type: 'configure', patch: { reasoning: 'grok' } })
    expect(agentCommandSchema.parse({ type: 'connect', provider: 'grok' })).toEqual({ type: 'connect', provider: 'grok' })
    expect(agentConfigurationSchema.safeParse({ ...legacy, enabledProviders: ['codex', 'codex'] }).success).toBe(false)
  })
  it('aggregates colliding native IDs and routes durable threads independently of the default provider', async () => {
    const f = await fixture(); const snapshot = await f.host.connect()
    expect(snapshot.providers?.map(provider => provider.connection)).toEqual(['connected', 'connected', 'connected'])
    expect(new Set(snapshot.models.map(model => model.id)).size).toBe(3)
    expect(new Set(snapshot.projects.map(project => project.id)).size).toBe(3)
    expect(new Set(snapshot.threads.map(thread => thread.id)).size).toBe(6)
    f.configuration({ ...defaultAgentConfiguration(), provider: 'grok', reasoning: 'claude' })
    for (const provider of ['codex', 'claude', 'grok'] as const) {
      const thread = snapshot.threads.find(thread => thread.providerId === provider && thread.title === 'Workshop')!
      await f.host.execute({ type: 'interrupt', commandId: `stop-${provider}`, threadId: thread.id })
      expect(f.adapters[provider].commands.at(-1)).toMatchObject({ type: 'interrupt', threadId: 'session-workshop' })
      expect(f.registry.byThread(thread.id)?.provider).toBe(provider)
    }
    expect(Object.values(f.adapters).map(adapter => adapter.commands.length)).toEqual([1, 1, 1])
  })
  it('keeps healthy providers usable after another fails or is disabled, retaining its identities and capabilities', async () => {
    const f = await fixture(); const initial = await f.host.connect()
    const claude = initial.threads.find(thread => thread.providerId === 'claude')!
    f.adapters.claude.state.connected = false; f.adapters.claude.state.error = 'Claude sign-in expired'; f.adapters.claude.emit()
    const failed = await f.host.snapshot('codex')
    expect(failed.connected).toBe(true)
    expect(failed.providers?.find(provider => provider.id === 'claude')).toMatchObject({ connection: 'error', error: 'Claude sign-in expired' })
    expect(isThreadProviderConnected(failed, claude)).toBe(false)
    expect(capabilitiesForThread(failed, claude).permissions).toBe(true)
    expect(failed.models.find(model => model.providerId === 'claude')?.ready).toBe(false)
    await expect(f.host.execute({ type: 'interrupt', commandId: 'wrong', threadId: claude.id })).rejects.toThrow('Reconnect Claude')
    f.host.disconnect('claude')
    const codex = initial.threads.find(thread => thread.providerId === 'codex')!
    await f.host.execute({ type: 'interrupt', commandId: 'healthy', threadId: codex.id })
    expect((await f.host.snapshot('codex')).threads.some(thread => thread.id === claude.id)).toBe(true)
    expect(f.adapters.grok.state.connected).toBe(true)
  })
  it('registers a selected folder with the chosen model provider and never migrates an existing session', async () => {
    const f = await fixture(); f.adapters.claude.state.projects[0]!.path = join(f.root, 'other')
    const initial = await f.host.connect()
    const project = initial.projects.find(project => project.providerId === 'codex')!
    const model = initial.models.find(model => model.providerId === 'claude')!
    await f.host.execute({ type: 'create-thread', commandId: 'new', threadId: 'new-sotto-thread', title: 'Independent', projectId: project.id, modelId: model.id })
    const commands = f.adapters.claude.commands
    expect(commands[0]).toMatchObject({ type: 'create-project', path: project.path })
    expect(commands[1]).toMatchObject({ type: 'create-thread', modelId: 'fake:model', projectId: commands[0]!.type === 'create-project' ? commands[0]!.projectId : '' })
    expect(f.registry.byThread('new-sotto-thread')?.provider).toBe('claude')
    const thread = initial.threads.find(thread => thread.providerId === 'codex')!
    await expect(f.host.execute({ type: 'configure-thread', commandId: 'migrate', threadId: thread.id, modelId: model.id })).rejects.toThrow('belonging to Codex')
    expect(f.adapters.codex.commands).toHaveLength(0)
    const recovered = new ThreadRegistry(f.root); await recovered.load()
    expect(recovered.byThread('new-sotto-thread')).toEqual(f.registry.byThread('new-sotto-thread'))
  })
  it('isolates stalled discovery and ignores its late result after explicit disconnect', async () => {
    const f = await fixture(); let release!: () => void
    const connect = f.adapters.grok.connect.bind(f.adapters.grok)
    vi.spyOn(f.adapters.grok, 'connect').mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve }); return connect() })
    const pending = f.host.connect('grok')
    const healthy = await f.host.connect('codex')
    const thread = healthy.threads.find(thread => thread.providerId === 'codex')!
    await f.host.refreshThread(thread.id)
    f.host.disconnect('grok'); release(); await pending
    expect((await f.host.snapshot('codex')).providers?.find(provider => provider.id === 'grok')?.connection).toBe('disconnected')
    expect(f.adapters.grok.state.connected).toBe(false)
  })
  it('does not promote a capability supported only by another provider into thread authority', async () => {
    const f = await fixture(); f.adapters.claude.state.capabilities.interrupt = false
    const snapshot = await f.host.connect(); expect(snapshot.capabilities.interrupt).toBe(true)
    const thread = snapshot.threads.find(thread => thread.providerId === 'claude')!
    expect(capabilitiesForThread(snapshot, thread).interrupt).toBe(false)
    await expect(f.host.execute({ type: 'interrupt', commandId: 'unsupported', threadId: thread.id })).rejects.toThrow('does not support')
    expect(f.adapters.claude.commands).toHaveLength(0)
  })
  it('keeps coordinator model changes independent from native connections, assignments, and drafts', async () => {
    const f = await fixture(); const control = await coordinator(f)
    await control.command({ type: 'connect', provider: 'codex' }); await control.command({ type: 'connect', provider: 'claude' })
    const thread = control.get().host.threads.find(thread => thread.providerId === 'codex')!
    await control.command({ type: 'assign', threadId: thread.id }); await control.command({ type: 'compose', text: 'Keep this draft.' })
    const changed = await control.command({ type: 'configure', patch: { reasoning: 'grok', reasoningModel: 'independent-coordinator-model', provider: 'claude' } })
    expect(changed.error).toBeNull(); expect(changed.draft).toBe('Keep this draft.')
    expect(changed.activeThreadId).toBe(thread.id); expect(changed.assignments[0]?.threadId).toBe(thread.id)
    expect(changed.host.providers?.filter(provider => provider.connection === 'connected').map(provider => provider.id)).toEqual(['codex', 'claude'])
    const sent = await control.command({ type: 'send' }); expect(sent.error).toBeNull()
    expect(f.adapters.codex.commands.some(command => command.type === 'send')).toBe(true)
    expect(f.adapters.claude.commands).toHaveLength(0)
  })
  it('persists enabled-but-failed connections without blocking another provider or losing a saved draft', async () => {
    const f = await fixture(); const control = await coordinator(f)
    await control.command({ type: 'connect', provider: 'codex' })
    const thread = control.get().host.threads[0]!
    await control.command({ type: 'assign', threadId: thread.id }); await control.command({ type: 'compose', text: 'Still here.' })
    vi.spyOn(f.adapters.grok, 'connect').mockRejectedValue(new Error('Grok unavailable'))
    const failed = await control.command({ type: 'connect', provider: 'grok' })
    expect(failed.error).toBe('Grok unavailable'); expect(failed.connection).toBe('connected'); expect(failed.draft).toBe('Still here.')
    expect(failed.configuration.enabledProviders).toEqual(['codex', 'grok'])
    const saved = JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8'))
    expect(saved.configuration.enabledProviders).toEqual(['codex', 'grok'])
    const disconnected = await control.command({ type: 'disconnect', provider: 'grok' })
    expect(disconnected.configuration.enabledProviders).toEqual(['codex'])
    expect((await control.command({ type: 'send' })).error).toBeNull()
  })
  it.each(['scoped', 'all-enabled'] as const)('does not put a %s connection into the global command queue', async mode => {
    const f = await fixture(); const control = await coordinator(f)
    await control.command({ type: 'connect', provider: 'codex' })
    const thread = control.get().host.threads[0]!
    let release!: () => void
    const connect = f.adapters.grok.connect.bind(f.adapters.grok)
    vi.spyOn(f.adapters.grok, 'connect').mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve }); return connect() })
    if (mode === 'all-enabled') await control.command({ type: 'configure', patch: { enabledProviders: ['codex', 'grok'] } })
    const pending = control.command(mode === 'scoped' ? { type: 'connect', provider: 'grok' } : { type: 'connect' })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    try {
      const sent = await control.command({ type: 'manual-send', threadId: thread.id, text: 'Healthy provider work' })
      expect(sent.error).toBeNull(); expect(sent.busy).toBe(false)
      expect(f.adapters.codex.commands.at(-1)).toMatchObject({ type: 'send', text: 'Healthy provider work' })
    } finally { release(); await pending }
  })
  it('recovers an uncertain folder registration across restart without replaying it or submitting a thread early', async () => {
    const f = await fixture(); f.adapters.claude.state.projects[0]!.path = join(f.root, 'other')
    const initial = await f.host.connect()
    const project = initial.projects.find(project => project.providerId === 'codex')!
    const model = initial.models.find(model => model.providerId === 'claude')!
    const execute = f.adapters.claude.execute.bind(f.adapters.claude)
    let registration: Parameters<typeof execute>[0] | undefined
    const spy = vi.spyOn(f.adapters.claude, 'execute').mockImplementation(async command => {
      if (command.type === 'create-project') { registration = command; return { accepted: false, uncertain: true } }
      return execute(command)
    })
    const create = { type: 'create-thread' as const, commandId: 'first', threadId: 'not-yet-submitted', title: 'New task', projectId: project.id, modelId: model.id }
    await expect(f.host.execute(create)).rejects.toThrow('has not confirmed this project registration')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(f.registry.byThread(create.threadId)).toBeUndefined()
    f.host.disconnect()
    const registry = new ThreadRegistry(f.root)
    const host = new ConfiguredProviderHost({ directory: f.root, provider: () => 'codex', enabledProviders: () => ['codex', 'claude'],
      threadProvider: id => registry.byThread(id)?.provider,
      hosts: { codex: new SottoThreadHost('codex', f.adapters.codex, registry), claude: new SottoThreadHost('claude', f.adapters.claude, registry), grok: f.adapters.grok } })
    cleanup.push(async () => { host.disconnect(); await registry.flush() })
    await host.connect()
    await expect(host.execute({ ...create, commandId: 'retry' })).rejects.toThrow('earlier project registration')
    expect(spy).toHaveBeenCalledTimes(1)
    await execute(registration!)
    expect((await host.execute({ ...create, commandId: 'confirmed-retry' })).accepted).toBe(true)
    expect(spy.mock.calls.map(([command]) => command.type)).toEqual(['create-project', 'create-thread'])
    expect(registry.byThread(create.threadId)?.provider).toBe('claude')
    expect(JSON.parse(await readFile(join(f.root, 'provider-project-registrations.json'), 'utf8'))).toEqual([])
  })
  it('retains a disabled provider draft, assignment, and attention through a cold coordinator restart', async () => {
    const f = await fixture(); const first = await coordinator(f)
    await first.command({ type: 'connect', provider: 'codex' }); await first.command({ type: 'connect', provider: 'claude' })
    const claude = first.get().host.threads.find(thread => thread.providerId === 'claude')!
    await first.command({ type: 'assign', threadId: claude.id }); await first.command({ type: 'compose', text: 'Recover this Claude draft.' })
    f.adapters.claude.state.threads[0]!.requests.push({ id: 'approval', kind: 'permission', text: 'Publish this?', options: [] })
    f.adapters.claude.emit()
    await vi.waitFor(() => expect(first.get().queue).toHaveLength(1))
    await first.command({ type: 'disconnect', provider: 'claude' }); first.dispose()
    const registry = new ThreadRegistry(f.root)
    let configuration = defaultAgentConfiguration()
    const host = new ConfiguredProviderHost({ directory: f.root, provider: () => configuration.provider, enabledProviders: () => enabledThreadProviders(configuration),
      threadProvider: id => registry.byThread(id)?.provider,
      hosts: { codex: new SottoThreadHost('codex', f.adapters.codex, registry), claude: new SottoThreadHost('claude', f.adapters.claude, registry), grok: f.adapters.grok } })
    cleanup.push(async () => { host.disconnect(); await registry.flush() })
    const restored = await coordinator({ ...f, host, configuration: value => { configuration = value } })
    expect(restored.get()).toMatchObject({ draft: 'Recover this Claude draft.', draftThreadId: claude.id,
      assignments: [{ threadId: claude.id }], queue: [{ threadId: claude.id, requestId: 'approval' }], configuration: { enabledProviders: ['codex'], enabled: false } })
    const reconnected = await restored.command({ type: 'connect', provider: 'claude' })
    expect(reconnected.host.threads.find(thread => thread.id === claude.id)?.providerId).toBe('claude')
    expect(reconnected.queue).toMatchObject([{ threadId: claude.id, requestId: 'approval' }])
    expect(reconnected.draft).toBe('Recover this Claude draft.')
  })
  it('preserves historical project memory and policies across default changes and restart without cross-provider scope leakage', async () => {
    const f = await fixture(); f.configuration({ ...defaultAgentConfiguration(), provider: 'claude', enabledProviders: ['codex', 'claude', 'grok'] })
    await f.host.initialize()
    f.configuration({ ...defaultAgentConfiguration(), provider: 'grok', enabledProviders: ['codex', 'claude', 'grok'] })
    const first = await f.host.connect()
    expect(first.projects.find(project => project.providerId === 'claude')?.id).toBe('project')
    expect(first.projects.find(project => project.providerId === 'codex')?.id).not.toBe('project')
    const store = new MemoryStore(join(f.root, 'memory.sqlite')); store.open(); cleanup.push(async () => { store.close() })
    const profile = new MemoryProfile(store)
    const base = profile.command({ type: 'complete-questionnaire', answers: memoryTopics.map(topic => ({ topic, content: `${topic} preference` })), boundaries: [] }).memories[0]!
    store.insert({ ...base, id: 'legacy-project-memory', scope: 'project', content: 'Bug verification: run focused tests.' })
    const policies = new PolicyStore(store); policies.grant({ action: 'publish', scope: 'project', effect: 'allow', note: 'Existing project permission' })
    f.host.disconnect()
    const registry = new ThreadRegistry(f.root)
    const host = new ConfiguredProviderHost({ directory: f.root, provider: () => 'grok', enabledProviders: () => ['codex', 'claude', 'grok'],
      hosts: { codex: new SottoThreadHost('codex', f.adapters.codex, registry), claude: new SottoThreadHost('claude', f.adapters.claude, registry), grok: new SottoThreadHost('grok', f.adapters.grok, registry) } })
    cleanup.push(async () => { host.disconnect(); await registry.flush() })
    const restarted = await host.connect()
    for (const project of restarted.projects) {
      const preferences = profile.retrieve({ query: 'Bug verification', projectId: project.id })
      expect(preferences.some(memory => memory.id === 'legacy-project-memory')).toBe(project.providerId === 'claude')
      expect(policies.authorizes({ action: 'publish', resource: '*', scope: project.id }).allowed).toBe(project.providerId === 'claude')
    }
    expect(JSON.parse(await readFile(join(f.root, 'provider-project-identity.json'), 'utf8'))).toEqual({ legacyProjectProvider: 'claude' })
  })
  it('keeps native providers connected when the coordinator is disabled and rejects its in-flight automatic reply', async () => {
    const f = await fixture(); let release!: (value: Awaited<ReturnType<AgentReasoner['decide']>>) => void
    const decide = vi.fn<AgentReasoner['decide']>(() => new Promise(resolve => { release = resolve }))
    const control = await coordinator(f, decide)
    await control.command({ type: 'connect', provider: 'codex' })
    expect(control.get().configuration.enabled).toBe(false)
    await control.command({ type: 'configure', patch: { enabled: true, reasoning: 'claude' } })
    const thread = control.get().host.threads[0]!
    await control.command({ type: 'assign', threadId: thread.id, instruction: 'Fix the failing checks.' })
    f.adapters.codex.state.threads[0]!.messages.push({ id: 'failure', role: 'assistant', text: 'Checks failed', createdAt: new Date().toISOString() })
    f.adapters.codex.emit(); await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1))
    const disabled = await control.command({ type: 'configure', patch: { enabled: false } })
    expect(disabled.host.providers?.find(provider => provider.id === 'codex')?.connection).toBe('connected')
    const finished = new Promise<void>(resolve => { const unsubscribe = control.subscribe(() => { unsubscribe(); resolve() }) })
    release({ decision: 'followup', text: 'Do not dispatch this revoked reply.' }); await finished
    expect(f.adapters.codex.commands).toHaveLength(0)
    await control.command({ type: 'disconnect', provider: 'codex' }); await control.command({ type: 'connect', provider: 'codex' })
    expect(control.get().configuration.enabled).toBe(false)
    await control.command({ type: 'connect' }); expect(control.get().configuration.enabled).toBe(false)
  })
  it('fails closed on damaged project-scope identity rather than assigning legacy policies to a different provider', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'provider-project-identity.json'), '{broken')
    await expect(f.host.connect('claude')).rejects.toThrow()
    expect(Object.values(f.adapters).map(adapter => adapter.connectCalls)).toEqual([0, 0, 0])
    expect(await readFile(join(f.root, 'provider-project-identity.json'), 'utf8')).toBe('{broken')
  })
  it('does not start a connection cancelled while reading identity metadata', async () => {
    const f = await fixture(); const pending = f.host.connect('grok'); f.host.disconnect('grok'); await pending
    expect(f.adapters.grok.connectCalls).toBe(0)
  })
  it('resolves legacy project/model choices to their original default provider', async () => {
    const f = await fixture(); await f.host.connect('codex')
    expect(f.host.resolveProjectId('project')).toBe('project')
    expect(f.host.resolveModelId('fake:model')).toBe(providerEntityId('codex', 'model', 'fake:model'))
    expect(f.host.resolveModelId(providerEntityId('grok', 'model', 'fake:model'))).toBe(providerEntityId('grok', 'model', 'fake:model'))
  })
})
