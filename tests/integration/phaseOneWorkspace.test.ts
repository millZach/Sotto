// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
import { runWorktreeGit as git } from '../../src/main/agents/threadWorktrees'
import { immediatePublishScheduler } from '../fixtures/publishScheduler'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
const image: AgentAttachment = { id: 'draft-image', name: 'reference.png', mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZ0AAAAASUVORK5CYII=' }

/** A store's file and any write-ahead log beside it, so a search for what was said covers both. */
async function onDisk(directory: string, name: string): Promise<string> {
  const names = (await readdir(directory)).filter(item => item.startsWith(name))
  const parts = await Promise.all(names.map(item => readFile(join(directory, item), 'latin1').catch(() => '')))
  return parts.join(' ')
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-phase-one-'))
  let historyEnabled = true
  const adapters = { codex: new FakeProviderHost(), claude: new FakeProviderHost(), grok: new FakeProviderHost() }
  for (const adapter of Object.values(adapters)) {
    adapter.state.projects[0]!.path = directory
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
    const host = new WorkspaceHost(native, directory, () => historyEnabled)
    const control = new AgentControl({ schedule: immediatePublishScheduler, directory, host, credentials, historyEnabled: () => historyEnabled,
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
    current.host.dispose()
    await current.registry.flush()
  }
  cleanup.push(async () => {
    await close()
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-phase-one-')) throw new Error('Unexpected fixture directory')
    await rm(directory, { recursive: true, force: true })
  })
  return { adapters, directory, setHistory: (enabled: boolean) => { historyEnabled = enabled }, get control() { return current.control },
    async command(command: AgentCommand) { const state = await current.control.command(command); expect(state.error).toBeNull(); return state },
    async restart() { await close(); current = await create() } }
}

describe('integrated Phase 1 workspace persistence', () => {
  it('retains the exact thread draft and attachment through failed worktree setup, navigation and restart', async () => {
    const f = await fixture()
    await git(f.directory, ['init'])
    const initial = await f.command({ type: 'connect' })
    const project = initial.host.projects.find(project => project.providerId === 'codex')!
    const model = initial.host.models.find(model => model.providerId === 'codex')!
    const created = await f.command({ type: 'create-thread', projectId: project.id, modelId: model.id, title: 'Recover setup', managed: false })
    const threadId = created.activeThreadId!
    // The pane exists as soon as creation returns; its checkout is still being prepared.
    expect(created.host.threads.find(thread => thread.id === threadId)?.worktree?.status).toBe('pending')
    const draft = { threadId, draftId: randomUUID(), text: 'Keep this exact unsent task', attachments: [image] }
    await f.command({ type: 'save-thread-draft', ...draft })
    const failed = await f.control.command({ type: 'manual-send', ...draft })
    expect(failed.error).toContain('no commit')
    expect(failed.host.threads.find(thread => thread.id === threadId)?.worktree?.status).toBe('error')
    await f.command({ type: 'select-thread', threadId: initial.host.threads[0]!.id })
    await f.restart()
    expect(f.control.get().threadDrafts).toContainEqual(expect.objectContaining(draft))
    expect(f.control.get().host.threads.find(thread => thread.id === threadId)).toMatchObject({ projectId: project.id, nativeSessionStarted: false, worktree: { status: 'error' } })
    expect(Object.values(f.adapters).flatMap(adapter => adapter.commands)).toEqual([])
  })
  it('does not retain private transcript copies during corrupt workspace recovery', async () => {
    const f = await fixture()
    f.control.dispose()
    await f.control.privacyChanged()
    f.setHistory(false)
    const marker = 'PRIVATE WORKSPACE TRANSCRIPT'
    await writeFile(join(f.directory, 'workspace.json'), JSON.stringify({ invalidSnapshot: marker }))
    await writeFile(join(f.directory, `workspace.json.tmp-123-${randomUUID()}`), marker)
    await writeFile(join(f.directory, `workspace.json.corrupt-123-${randomUUID()}`), marker)
    await writeFile(join(f.directory, 'workspace.json.tmp-user-note'), 'Preserve unrelated files')
    const recovered = new WorkspaceHost(new FakeProviderHost(), f.directory, () => false)
    await recovered.initialize()
    recovered.dispose()
    const names = (await readdir(f.directory)).filter(name => name.startsWith('workspace.json'))
    expect(names.sort()).toEqual(['workspace.json', 'workspace.json.tmp-user-note'])
    expect(await readFile(join(f.directory, 'workspace.json'), 'utf8')).not.toContain(marker)
  })

  it.each(['preview', 'workspace'])('redacts other stores and retries a failed %s privacy cleanup', async failedStore => {
    const intervals = vi.spyOn(globalThis, 'setInterval')
    const f = await fixture()
    const connected = await f.command({ type: 'connect' })
    const thread = connected.host.threads.find(thread => thread.providerId === 'claude')!
    await f.command({ type: 'assign', threadId: thread.id, instruction: 'PRIVATE ASSIGNMENT CONTEXT' })
    await f.command({ type: 'compose', text: 'PRIVATE SENT TRANSCRIPT', attachments: [image] })
    await f.command({ type: 'send' })
    // The message reaches the workspace on the provider's own publish, whose write is gathered rather than immediate.
    // Messages are in the thread store; `workspace.json` keeps organization alone.
    await vi.waitFor(async () => expect(await onDisk(f.directory, 'threads.sqlite')).toContain('PRIVATE SENT TRANSCRIPT'))
    expect(await readFile(join(f.directory, 'workspace.json'), 'utf8')).not.toContain('PRIVATE SENT TRANSCRIPT')
    expect(await readFile(join(f.directory, 'agents.json'), 'utf8')).toContain('PRIVATE SENT TRANSCRIPT')
    f.setHistory(false)
    const write = AtomicJsonStore.prototype.write
    const failure = vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function (this: AtomicJsonStore<unknown>, value: unknown) {
      if (value && typeof value === 'object' && (failedStore === 'preview'
        ? 'version' in value && 'entries' in value : 'snapshot' in value && 'creations' in value)) throw new Error('Private storage unavailable')
      return write.call(this, value)
    })
    await expect(f.control.privacyChanged()).rejects.toThrow('Private storage unavailable')
    if (failedStore === 'preview') expect(await onDisk(f.directory, 'threads.sqlite')).not.toContain('PRIVATE SENT TRANSCRIPT')
    else expect(await readFile(join(f.directory, 'attachment-previews.json'), 'utf8')).not.toContain(image.dataUrl)
    expect(await readFile(join(f.directory, 'agents.json'), 'utf8')).not.toContain('PRIVATE SENT TRANSCRIPT')
    failure.mockRestore()
    const maintenance = intervals.mock.calls.find(([, milliseconds]) => milliseconds === 30_000)?.[0]
    expect(maintenance).toBeTypeOf('function')
    if (typeof maintenance === 'function') maintenance()
    await vi.waitFor(async () => {
      expect(await readFile(join(f.directory, 'attachment-previews.json'), 'utf8')).not.toContain(image.dataUrl)
      expect(await onDisk(f.directory, 'threads.sqlite')).not.toContain('PRIVATE SENT TRANSCRIPT')
    })
  })

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
    const sentMessage = sent.host.threads.find(item => item.id === thread.id)!.messages.at(-1)!
    expect(sentMessage.attachments).toContainEqual(expect.objectContaining({ id: image.id, preview: { available: true } }))
    expect(f.control.attachmentPreview({ threadId: thread.id, messageId: sentMessage.id, attachmentId: image.id })).toEqual({ dataUrl: image.dataUrl })
    expect(sent.assignments).toEqual([])
    await f.command({ type: 'settle-project', projectId: project.id })
    await f.restart()
    // The restarted coordinator says which thread is open, and the workspace loads that thread's window
    // out of the thread store: the messages are no longer in `workspace.json` (issue #119).
    await f.command({ type: 'manual-send', ...draft })
    expect(f.adapters.claude.commands.filter(command => command.type === 'send')).toHaveLength(1)
    expect(f.adapters.codex.commands.filter(command => command.type === 'send')).toHaveLength(0)
    expect(f.control.get().host.threads.find(item => item.id === thread.id)).toMatchObject({ providerId: 'claude', projectId: project.id, nativeSessionStarted: true })
    const restored = f.control.get().host.threads.find(item => item.id === thread.id)!.messages.at(-1)!
    expect(restored.attachments).toContainEqual(expect.objectContaining({ id: image.id, preview: { available: true } }))
    expect(f.control.attachmentPreview({ threadId: thread.id, messageId: restored.id, attachmentId: image.id })).toEqual({ dataUrl: image.dataUrl })
    expect(f.control.get().threadDrafts?.some(item => item.threadId === thread.id)).toBe(false)
  })
})
