// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { ThreadRegistry, SottoThreadHost } from '../../../src/main/agents/threads'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { agentCommandSchema } from '../../../src/shared/agents'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

vi.mock('node:fs/promises', async () => { const actual = await vi.importActual<typeof fs>('node:fs/promises'); return { ...actual, link: vi.fn(actual.link) } })

const roots: string[] = []
const controls: AgentControl[] = []
afterEach(async () => { vi.restoreAllMocks(); controls.splice(0).forEach(control => control.dispose()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-retirement-')); roots.push(root)
  const decrypt = vi.fn((value: Buffer) => value.toString())
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: decrypt })
  await credentials.load()
  const host = new FakeProviderHost(); const connect = vi.spyOn(host, 'connect'); const execute = vi.spyOn(host, 'execute')
  let historyEnabled = true
  const create = () => {
    const control = new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, historyEnabled: () => historyEnabled,
      reasoner: { intent: vi.fn(), decide: vi.fn() } as never,
      membership: { status: async () => ({ status: 'beta', label: 'Beta', expiresAt: null }), action: vi.fn() } })
    controls.push(control); return control
  }
  const seed = create(); await seed.start(); seed.dispose()
  const path = join(root, 'agents.json'); const initial = JSON.parse(await readFile(path, 'utf8'))
  const state = { ...initial, configuration: { ...initial.configuration, provider: 't3', enabled: true, endpoint: 'http://old-host', defaultModelId: 'old-model' },
    assignments: [{ threadId: 'old-id', mode: 'managed', instruction: 'Private task', followups: 2, paused: false, seenMessageIds: [], ownMessageIds: [], handledRequestIds: [], lastFailure: '', contextUpdatedAt: Date.now() }],
    queue: [{ id: 'permission', threadId: 'old-id', kind: 'permission', text: 'Private question', requestId: 'request', createdAt: new Date().toISOString(), deferred: false }],
    draft: 'Recovered answer', draftThreadId: 'old-id', draftRequestId: 'request',
    draftAttachments: [{ id: 'image', name: 'image.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,YWJj' }],
    activeThreadId: 'old-id', activeProjectId: 'old-project', pendingRequest: 'Private utterance', contextSavedAt: Date.now(), composing: true,
    outbox: [{ id: 'unknown-command', type: 'answer', threadId: 'old-id', requestId: 'request' }] }
  return { root, path, state, credentials, decrypt, host, connect, execute, create,
    history(value: boolean) { historyEnabled = value },
    async save(value = state) { await writeFile(path, JSON.stringify(value)) },
    async recovery() { return JSON.parse(await readFile(join(root, 'provider-retirement-v1.json'), 'utf8')) },
  }
}

describe('native provider retirement', () => {
  it('keeps the recovered draft through new-thread creation and binds it only by explicit choice', async () => {
    const f = await fixture(); await f.save(); const control = f.create(); await control.start()
    await control.command({ type: 'connect' })
    const created = await control.command({ type: 'create-thread', projectId: 'project', title: 'New native work', modelId: 'fake:model', managed: false })
    expect(created.error).toBeNull()
    expect(created).toMatchObject({ draft: f.state.draft, draftAttachments: f.state.draftAttachments, draftThreadId: null, composing: false })
    const threadId = created.activeThreadId!
    expect(agentCommandSchema.safeParse({ type: 'recover-draft', threadId }).success).toBe(true)
    const restored = await control.command({ type: 'recover-draft', threadId })
    expect(restored).toMatchObject({ draft: f.state.draft, draftAttachments: f.state.draftAttachments, draftThreadId: threadId, draftRequestId: null, composing: true, assignments: [] })
    expect(f.host.commands.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
  })

  it('fresh startup is disabled Codex with no connection or recovery', async () => {
    const f = await fixture(); const control = f.create(); await control.start()
    expect(control.get()).toMatchObject({ configuration: { provider: 'codex', enabled: false }, providerUpgrade: null })
    expect(f.connect).not.toHaveBeenCalled(); expect(await readdir(f.root)).not.toContain('provider-retirement-v1.json')
  })
  it.each(['explicit', 'omitted'])('archives %s legacy authority before keeping the draft unbound, without provider effects', async kind => {
    const f = await fixture(); if (kind === 'omitted') delete (f.state.configuration as Record<string, unknown>).provider
    await f.credentials.set('t3', 'old encrypted secret'); await f.credentials.set('reasoning', 'independent')
    await f.save(); const control = f.create(); await control.start()
    expect(control.get()).toMatchObject({ configuration: { provider: 'codex', enabled: false, defaultModelId: '' },
      assignments: [], queue: [], draft: 'Recovered answer', draftAttachments: f.state.draftAttachments,
      draftThreadId: null, draftRequestId: null, activeThreadId: null, activeProjectId: null, pendingRequest: '', composing: false,
      providerUpgrade: { recoveryPath: join(f.root, 'provider-retirement-v1.json') } })
    const recovery = await f.recovery()
    expect(recovery.state).toMatchObject({ outbox: f.state.outbox, assignments: f.state.assignments, draftRequestId: 'request', draftThreadId: 'old-id', pendingRequest: 'Private utterance' })
    expect(JSON.stringify(recovery)).not.toContain('old encrypted secret'); expect(f.decrypt).not.toHaveBeenCalled()
    expect(f.credentials.has('t3')).toBe(false); expect(f.credentials.has('reasoning')).toBe(true)
    expect(f.connect).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
    expect((await readdir(f.root)).some(name => name.includes('corrupt'))).toBe(false)
    control.dispose(); const restarted = f.create(); await restarted.start()
    expect(restarted.get().providerUpgrade).toEqual(control.get().providerUpgrade)
    expect(await f.recovery()).toEqual(recovery); expect(f.connect).not.toHaveBeenCalled()
    expect((await restarted.command({ type: 'configure', patch: { provider: 'claude' } })).error).toBeNull()
    expect(f.execute).not.toHaveBeenCalled()
  })
  it.each(['codex', 'claude', 'grok'])('preserves existing %s configuration and authority while dropping its obsolete endpoint', async provider => {
    const f = await fixture(); f.state.configuration.provider = provider; f.state.configuration.enabled = false; await f.save()
    const control = f.create(); await control.start()
    expect(control.get()).toMatchObject({ configuration: { provider, defaultModelId: 'old-model' }, draftThreadId: 'old-id', draftRequestId: 'request', assignments: f.state.assignments, providerUpgrade: null })
    expect(JSON.parse(await readFile(f.path, 'utf8')).outbox).toEqual(f.state.outbox.map((item: Record<string, unknown>) => ({ ...item, provider })))
    await control.command({ type: 'configure', patch: { provider: provider === 'grok' ? 'codex' : 'grok' } })
    expect(JSON.parse(await readFile(f.path, 'utf8')).outbox[0].provider).toBe(provider)
    expect(control.get().configuration).not.toHaveProperty('endpoint')
    expect(await readdir(f.root)).not.toContain('provider-retirement-v1.json')
  })
  it.each(['disabled', 'expired'])('redacts %s private contexts in recovery while retaining the intentional draft and images', async privacy => {
    const f = await fixture(); if (privacy === 'disabled') f.history(false)
    else { f.state.contextSavedAt = 0; f.state.assignments[0]!.contextUpdatedAt = 0; f.state.queue[0]!.createdAt = '2000-01-01T00:00:00.000Z' }
    await f.save(); const control = f.create(); await control.start()
    const recovery = await f.recovery()
    expect(JSON.stringify(recovery)).not.toContain('Private'); expect(recovery.state.draft).toBe('Recovered answer')
    expect(recovery.state.draftAttachments).toEqual(f.state.draftAttachments)
    expect(recovery.state.outbox).toEqual(f.state.outbox)
  })
  it('applies later history changes and deletes expired recovery on restart', async () => {
    const f = await fixture(); await f.save(); const control = f.create(); await control.start()
    f.history(false); await control.privacyChanged(); expect(JSON.stringify(await f.recovery())).not.toContain('Private')
    const recovery = await f.recovery(); recovery.expiresAt = 0
    await writeFile(join(f.root, 'provider-retirement-v1.json'), JSON.stringify(recovery)); control.dispose()
    await f.create().start(); expect(await readdir(f.root)).not.toContain('provider-retirement-v1.json')
  })
  it('keeps original state and credentials if exclusive recovery publication fails', async () => {
    const f = await fixture(); await f.save(); await f.credentials.set('t3', 'secret'); const before = await readFile(f.path, 'utf8')
    vi.spyOn(fs, 'link').mockRejectedValueOnce(new Error('disk unavailable'))
    const control = f.create(); await expect(control.start()).rejects.toThrow('disk unavailable')
    expect(await readFile(f.path, 'utf8')).toBe(before); expect(f.credentials.has('t3')).toBe(true)
    expect((await control.command({ type: 'connect' })).error).toContain('safely recover')
    expect(await readFile(f.path, 'utf8')).toBe(before)
    expect(f.connect).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
  })
  it('fails closed on an unrelated recovery collision', async () => {
    const f = await fixture(); await f.save(); const control = f.create(); await control.start(); control.dispose()
    f.state.draft = 'Different legacy save'; await f.save(); const before = await readFile(f.path, 'utf8')
    await expect(f.create().start()).rejects.toThrow('different saved state')
    expect(await readFile(f.path, 'utf8')).toBe(before); expect((await f.recovery()).state.draft).toBe('Recovered answer')
    expect(f.connect).not.toHaveBeenCalled()
  })
  it('reuses recovery after a failed live-state write and never replays the unknown command', async () => {
    const f = await fixture(); await f.save(); const before = await readFile(f.path, 'utf8')
    const original = AtomicJsonStore.prototype.write
    const spy = vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function (this: AtomicJsonStore<unknown>, value) {
      if ((this as unknown as { filePath: string }).filePath === f.path) return Promise.reject(new Error('live save failed'))
      return original.call(this, value)
    })
    const failed = f.create(); await expect(failed.start()).rejects.toThrow('live save failed')
    expect(await readFile(f.path, 'utf8')).toBe(before); const recovery = await f.recovery()
    spy.mockRestore(); await f.create().start(); expect(await f.recovery()).toEqual(recovery)
    expect(f.connect).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
    expect((await readdir(f.root)).filter(name => name.startsWith('provider-retirement'))).toEqual(['provider-retirement-v1.json'])
  })
  it('preserves credentials and original live bytes when encrypted-slot deletion cannot commit', async () => {
    const f = await fixture(); await f.save(); await f.credentials.set('t3', 'secret'); await f.credentials.set('membership', 'unrelated')
    const before = await readFile(f.path, 'utf8'); const ciphertext = await readFile(join(f.root, 'credentials.json'), 'utf8')
    const original = AtomicJsonStore.prototype.write
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function (this: AtomicJsonStore<unknown>, value) {
      if ((this as unknown as { filePath: string }).filePath === join(f.root, 'credentials.json')) return Promise.reject(new Error('vault save failed'))
      return original.call(this, value)
    })
    const failed = f.create(); await expect(failed.start()).rejects.toThrow('vault save failed')
    expect(await readFile(f.path, 'utf8')).toBe(before); expect(await readFile(join(f.root, 'credentials.json'), 'utf8')).toBe(ciphertext)
    expect(f.credentials.has('t3')).toBe(true); expect(f.credentials.has('membership')).toBe(true); expect(f.decrypt).not.toHaveBeenCalled()
    await expect(failed.privacyChanged()).rejects.toThrow('safely recover')
    expect(await readFile(f.path, 'utf8')).toBe(before); expect(f.connect).not.toHaveBeenCalled()
  })
  it('keeps existing bindings and never sends through a retired binding even when native discovery has the same session ID', async () => {
    const f = await fixture(); await f.save()
    const binding = { threadId: 'old-id', provider: 't3', sessionId: 'session-workshop', projectId: 'project', createdAt: new Date().toISOString() }
    const registryPath = join(f.root, 'threads.json'); const bytes = JSON.stringify({ bindings: [binding] })
    await writeFile(registryPath, bytes); await f.create().start(); expect(await readFile(registryPath, 'utf8')).toBe(bytes)
    const registry = new ThreadRegistry(f.root); const wrapped = new SottoThreadHost('codex', f.host, registry)
    const snapshot = await wrapped.connect()
    expect(snapshot.threads[0]!.id).not.toBe('old-id'); expect(registry.byThread('old-id')).toEqual(binding)
    await expect(wrapped.execute({ type: 'send', commandId: 'old', threadId: 'old-id', messageId: 'old', text: 'Must not send' })).rejects.toThrow('not known')
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('continues normal explicit-native reconnect behavior', async () => {
    const f = await fixture(); f.state.configuration.provider = 'claude'; f.state.assignments = []; f.state.outbox = []; await f.save()
    await f.create().start(); expect(f.connect).toHaveBeenCalledExactlyOnceWith()
    expect(f.execute).not.toHaveBeenCalled(); expect(await readdir(f.root)).not.toContain('provider-retirement-v1.json')
  })
  it('removes an interrupted recovery staging copy when retrying a live save', async () => {
    const f = await fixture(); await f.save()
    const original = AtomicJsonStore.prototype.write
    const spy = vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function (this: AtomicJsonStore<unknown>, value) {
      if ((this as unknown as { filePath: string }).filePath === f.path) return Promise.reject(new Error('interrupted'))
      return original.call(this, value)
    })
    await expect(f.create().start()).rejects.toThrow('interrupted'); spy.mockRestore()
    await writeFile(join(f.root, 'provider-retirement-v1.json.stage'), JSON.stringify(await f.recovery()))
    await writeFile(join(f.root, 'provider-retirement-v1.json.stage.tmp-interrupted'), JSON.stringify(await f.recovery()))
    f.history(false); await f.create().start()
    expect(JSON.stringify(await f.recovery())).not.toContain('Private')
    expect((await readdir(f.root)).filter(name => name.startsWith('provider-retirement'))).toEqual(['provider-retirement-v1.json'])
    expect(f.connect).not.toHaveBeenCalled()
  })
  it('rejects retired public provider, endpoint and credential configuration', () => {
    for (const command of [{ type: 'configure', patch: { provider: 't3' } }, { type: 'configure', patch: { endpoint: 'http://old-host' } }, { type: 'credential', slot: 't3', value: 'secret' }]) {
      expect(agentCommandSchema.safeParse(command).success).toBe(false)
    }
  })
})
