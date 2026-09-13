// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../src/main/agents/control'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { ConfiguredProviderHost } from '../../src/main/agents/providerSwitch'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { AtomicJsonStore } from '../../src/main/storage/atomicJsonStore'
import type { AgentAttachment, AgentCommand } from '../../src/shared/agents'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
const image: AgentAttachment = { id: 'draft-image', name: 'reference.png', mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZ0AAAAASUVORK5CYII=' }

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-phase-one-'))
  const adapters = { codex: new FakeProviderHost(), claude: new FakeProviderHost(), grok: new FakeProviderHost() }
  for (const adapter of Object.values(adapters)) {
    adapter.state.capabilities.configureThread = true
    adapter.state.models[0]!.supportsImages = true
  }
  const credentials = new AgentCredentials(directory, { isEncryptionAvailable: () => false,
    encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
  await credentials.load()
  const create = async () => {
    const registry = new ThreadRegistry(directory)
    const native = new ConfiguredProviderHost({ directory,
      hosts: { codex: new SottoThreadHost('codex', adapters.codex, registry),
        claude: new SottoThreadHost('claude', adapters.claude, registry), grok: new SottoThreadHost('grok', adapters.grok, registry) },
      provider: () => 'codex', enabledProviders: () => ['codex', 'claude', 'grok'],
      threadProvider: id => registry.byThread(id)?.provider })
    const host = new WorkspaceHost(native, directory)
    const control = new AgentControl({ directory, host, credentials,
      reasoner: { intent: async () => ({ type: 'clarify', text: 'Choose a thread' }), decide: async () => ({ decision: 'human', text: 'Review' }) },
      membership: { status: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }),
        action: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }) } })
    await control.start()
    return { control, host, registry }
  }
  let current = await create()
  const close = async () => {
    current.control.dispose()
    await current.control.privacyChanged()
    await current.host.privacyChanged()
    await current.registry.flush()
  }
  cleanup.push(async () => {
    await close()
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-phase-one-')) throw new Error('Unexpected fixture directory')
    await rm(directory, { recursive: true, force: true })
  })
  return { adapters, get control() { return current.control },
    async command(command: AgentCommand) { const state = await current.control.command(command); expect(state.error).toBeNull(); return state },
    async restart() { await close(); current = await create() } }
}

describe('integrated Phase 1 workspace persistence', () => {
  it('measures provider latency separately from submitted-image persistence', async () => {
    const f = await fixture()
    const initial = await f.command({ type: 'connect' })
    const thread = initial.host.threads.find(thread => thread.providerId === 'claude')!
    let measuredNow = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => measuredNow)
    const write = AtomicJsonStore.prototype.write
    let savedPreview = false
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function (this: AtomicJsonStore<unknown>, value: unknown) {
      if (!savedPreview && value && typeof value === 'object' && 'version' in value && 'entries' in value
        && Array.isArray(value.entries) && value.entries.length > 0) {
        savedPreview = true
        measuredNow += 500
      }
      return write.call(this, value)
    })
    const execute = f.adapters.claude.execute.bind(f.adapters.claude)
    vi.spyOn(f.adapters.claude, 'execute').mockImplementation(async command => {
      if (command.type === 'send') measuredNow += 7
      return execute(command)
    })
    const draftId = randomUUID()
    const sent = await f.command({ type: 'manual-send', threadId: thread.id, draftId, text: 'Inspect this image', attachments: [image] })
    expect(savedPreview).toBe(true)
    expect(sent.deliveries?.find(delivery => delivery.draftId === draftId)).toMatchObject({ status: 'accepted', providerLatencyMs: 7 })
  })

  it('restores independent drafts and individual settlement beneath a settled project while disconnected', async () => {
    const f = await fixture()
    const connected = await f.command({ type: 'connect' })
    const threads = connected.host.threads.filter(thread => thread.providerId === 'codex')
    const first = threads[0]!, second = threads[1]!
    const firstDraft = { threadId: first.id, draftId: randomUUID(), text: 'Keep this reference', attachments: [image] }
    const secondDraft = { threadId: second.id, draftId: randomUUID(), text: 'Independent prompt', attachments: [] }
    await f.command({ type: 'save-thread-draft', ...firstDraft })
    await f.command({ type: 'save-thread-draft', ...secondDraft })
    await f.command({ type: 'settle-thread', threadId: first.id })
    await f.command({ type: 'settle-project', projectId: first.projectId })
    await f.command({ type: 'disconnect', provider: 'codex' })
    await f.restart()
    const restored = f.control.get()
    expect(restored.threadDrafts).toEqual(expect.arrayContaining([expect.objectContaining(firstDraft), expect.objectContaining(secondDraft)]))
    expect(restored.host.projects.find(project => project.id === first.projectId)?.workspaceSettledAt).toBeTruthy()
    expect(restored.host.threads.find(thread => thread.id === first.id)?.workspaceSettledAt).toBeTruthy()
    expect(restored.host.threads.find(thread => thread.id === second.id)?.workspaceSettledAt).toBeFalsy()
    const activeProject = await f.command({ type: 'restore-project', projectId: first.projectId })
    expect(activeProject.host.projects.find(project => project.id === first.projectId)?.workspaceSettledAt).toBeNull()
    expect(activeProject.host.threads.find(thread => thread.id === first.id)?.workspaceSettledAt).toBeTruthy()
    expect(Object.values(f.adapters).flatMap(adapter => adapter.commands)).toEqual([])
  })

  it('keeps a draft and project scope through an unstarted provider choice, then reconciles one accepted send after restart', async () => {
    const f = await fixture()
    const initial = await f.command({ type: 'connect' })
    const project = initial.host.projects.find(project => project.providerId === 'codex')!
    const codexModel = initial.host.models.find(model => model.providerId === 'codex')!
    const claudeModel = initial.host.models.find(model => model.providerId === 'claude')!
    const created = await f.command({ type: 'create-thread', projectId: project.id, modelId: codexModel.id, title: 'Independent task', managed: false })
    const thread = created.host.threads.find(thread => thread.title === 'Independent task')!
    const draft = { threadId: thread.id, draftId: randomUUID(), text: 'Implement the agreed task', attachments: [image] }
    await f.command({ type: 'save-thread-draft', ...draft })
    const changed = await f.command({ type: 'configure-thread', threadId: thread.id, modelId: claudeModel.id })
    expect(changed.threadDrafts).toContainEqual(expect.objectContaining(draft))
    expect(changed.host.threads.find(item => item.id === thread.id)).toMatchObject({ providerId: 'claude', projectId: project.id, nativeSessionStarted: false })
    const sent = await f.command({ type: 'manual-send', ...draft })
    expect(sent.deliveries).toContainEqual(expect.objectContaining({ threadId: thread.id, draftId: draft.draftId, status: 'accepted' }))
    expect(sent.host.threads.find(item => item.id === thread.id)?.messages.at(-1)?.attachments)
      .toContainEqual(expect.objectContaining({ id: image.id, preview: { dataUrl: image.dataUrl } }))
    expect(sent.assignments).toEqual([])
    await f.command({ type: 'settle-project', projectId: project.id })
    await f.restart()
    await f.command({ type: 'manual-send', ...draft })
    expect(f.adapters.claude.commands.filter(command => command.type === 'send')).toHaveLength(1)
    expect(f.adapters.codex.commands.filter(command => command.type === 'send')).toHaveLength(0)
    expect(f.control.get().host.threads.find(item => item.id === thread.id)).toMatchObject({ providerId: 'claude', projectId: project.id, nativeSessionStarted: true })
    expect(f.control.get().host.threads.find(item => item.id === thread.id)?.messages.at(-1)?.attachments)
      .toContainEqual(expect.objectContaining({ id: image.id, preview: { dataUrl: image.dataUrl } }))
    expect(f.control.get().threadDrafts?.some(item => item.threadId === thread.id)).toBe(false)
  })
})
