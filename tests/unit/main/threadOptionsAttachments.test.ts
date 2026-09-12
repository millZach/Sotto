// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentAttachmentsSchema, agentCommandSchema, agentHostSnapshotSchema, type AgentAttachment, type AgentHostSnapshot } from '../../../src/shared/agents'
import { T3CodeHost } from '../../../src/main/agents/t3'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { validatePromptAttachments } from '../../../src/main/agents/threadOptions'
import type { AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import { SottoThreadHost, ThreadRegistry } from '../../../src/main/agents/threads'
import { ConfiguredProviderHost } from '../../../src/main/agents/providerSwitch'

const image: AgentAttachment = { id: 'shot-1', name: 'Screenshot.png', mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZ0AAAAASUVORK5CYII=' }
const roots: string[] = []
const disposers: (() => void)[] = []
afterEach(async () => {
  disposers.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-options-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})

function t3Fixture() {
  const host = new T3CodeHost(); disposers.push(() => host.disconnect())
  const thread = { id: 'thread', projectId: 'project', title: 'Thread',
    modelSelection: { instanceId: 'account', model: 'model', options: [{ id: 'effort', value: 'low' as string | boolean }, { id: 'fastMode', value: true }] },
    runtimeMode: 'approval-required', interactionMode: 'default', latestTurn: null, session: null,
    messages: [] as unknown[], activities: [] as unknown[] }
  const payloads: Record<string, unknown>[] = []
  const transport = host as unknown as { request(path: string, init?: { body?: string }): Promise<unknown>; rpc(tag: string, payload: unknown): Promise<unknown> }
  let unknown = false
  vi.spyOn(transport, 'request').mockImplementation(async (path, init) => {
    if (path === '/api/orchestration/shell') return { snapshotSequence: 1, projects: [{ id: 'project', title: 'Project', workspaceRoot: 'C:/fixture' }], threads: [thread] }
    if (path.startsWith('/api/orchestration/threads/')) return { thread }
    if (path === '/api/orchestration/dispatch') {
      const payload = JSON.parse(init!.body!)
      payloads.push(payload)
      if (payload.type === 'thread.meta.update') thread.modelSelection = payload.modelSelection
      if (payload.type === 'thread.runtime-mode.set') thread.runtimeMode = payload.runtimeMode
      if (payload.type === 'thread.turn.start') thread.messages.push({ id: payload.message.messageId, role: 'user', text: payload.message.text, createdAt: payload.createdAt,
        attachments: payload.message.attachments.map((a: { name: string; mimeType: string; sizeBytes: number }) => ({ type: 'image', id: 'persisted-provider-id', name: a.name, mimeType: a.mimeType, sizeBytes: a.sizeBytes })) })
      if (unknown) throw new Error('Fixture lost acknowledgment')
      return {}
    }
    throw new Error(`Unexpected fixture request: ${path}`)
  })
  vi.spyOn(transport, 'rpc').mockResolvedValue({ providers: [{ instanceId: 'account', driver: 'codex', installed: true, enabled: true, status: 'ready', auth: { status: 'authenticated' },
    models: [{ slug: 'model', name: 'Model', capabilities: { optionDescriptors: [{ id: 'effort', type: 'select', options: [{ id: 'low', label: 'Low', isDefault: true }, { id: 'high', label: 'High' }] }] } },
      { slug: 'plain', name: 'Plain', capabilities: null }] }] })
  host['connected'] = true
  host.observeThreads(['thread'])
  return { host, payloads, setUnknown: () => { unknown = true }, permission: () => { thread.activities.push({ id: 'permission', kind: 'approval.requested', summary: 'Publish?', payload: { requestId: 'request' }, createdAt: new Date().toISOString() }) } }
}

class FixtureHost extends E2EAgentHost {
  attempts: AgentHostCommand[] = []
  unknown = false
  hideMessages = false
  cosmetic = false
  override async snapshot(): Promise<AgentHostSnapshot> {
    const snapshot = await super.snapshot()
    return this.hideMessages ? { ...snapshot, threads: snapshot.threads.map(thread => ({ ...thread, messages: [] })) } : snapshot
  }
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    this.attempts.push(command)
    if (this.cosmetic) return { accepted: true }
    if (this.unknown) return { accepted: false, uncertain: true }
    return super.execute(command)
  }
  async reveal(): Promise<void> { await super.execute(this.attempts.at(-1)!) }
}
async function controlFixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-options-')); roots.push(root)
  const host = new FixtureHost()
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(value), decryptString: value => value.toString() }); await credentials.load()
  const create = () => new AgentControl({ directory: root, host, credentials, reasoner: e2eAgentReasoner,
    membership: { status: async () => ({ status: 'beta', label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Test', expiresAt: null }) } })
  let control = create(); disposers.push(() => control.dispose())
  await control.start(); await control.command({ type: 'connect' })
  return { root, host, get control() { return control }, async restart() { control.dispose(); control = create(); await control.start() } }
}

describe('bounded image contract', () => {
  it('accepts image-only manual prompts and rejects invalid encodings, duplicate IDs and excessive counts/sizes', () => {
    expect(agentCommandSchema.parse({ type: 'manual-send', threadId: 'thread', text: '', attachments: [image] })).toMatchObject({ attachments: [image] })
    for (const attachments of [[{ ...image, dataUrl: 'https://example.com/image.png' }], [{ ...image, mimeType: 'image/svg+xml' }],
      [{ ...image, dataUrl: image.dataUrl.replace('image/png', 'image/jpeg') }], [image, image], Array.from({ length: 9 }, (_, i) => ({ ...image, id: String(i) })),
      [{ ...image, dataUrl: 'data:image/png;base64,' + Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') }],
      Array.from({ length: 3 }, (_, i) => ({ ...image, id: String(i), dataUrl: 'data:image/png;base64,' + Buffer.alloc(8 * 1024 * 1024).toString('base64') }))]) {
      expect(agentAttachmentsSchema.safeParse(attachments).success).toBe(false)
    }
  })
  it('rejects a disguised non-image before sending', async () => {
    const f = t3Fixture(); const snapshot = await f.host.snapshot()
    expect(() => validatePromptAttachments(snapshot, 'account:model', [{ ...image, dataUrl: 'data:image/png;base64,YWJj' }])).toThrow(/content/)
  })
})

describe('T3 shipped option and attachment protocol', () => {
  it('advertises actual model reasoning descriptors and reads persisted selections', async () => {
    const f = t3Fixture(); const snapshot = agentHostSnapshotSchema.parse(await f.host.snapshot())
    expect(snapshot.models[0]).toMatchObject({ reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low', supportsImages: true,
      runtimeModes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] })
    expect(snapshot.models[1]?.reasoningEfforts).toEqual([])
    expect(snapshot.threads[0]).toMatchObject({ reasoningEffort: 'low', runtimeMode: 'approval-required' })
  })
  it('dispatches actual metadata/runtime commands, preserving unrelated options and rejecting unsupported reasoning', async () => {
    const f = t3Fixture(); await f.host.snapshot()
    await expect(f.host.execute({ type: 'configure-thread', commandId: 'bad', threadId: 'thread', reasoningEffort: 'invented' })).rejects.toThrow(/reasoning/)
    await f.host.execute({ type: 'configure-thread', commandId: 'settings', threadId: 'thread', reasoningEffort: 'high' })
    expect(f.payloads[0]).toEqual({ type: 'thread.meta.update', commandId: 'settings', threadId: 'thread', modelSelection: { instanceId: 'account', model: 'model', options: [{ id: 'fastMode', value: true }, { id: 'effort', value: 'high' }] } })
    await f.host.execute({ type: 'configure-thread', commandId: 'runtime', threadId: 'thread', runtimeMode: 'full-access' })
    expect(f.payloads[1]).toMatchObject({ type: 'thread.runtime-mode.set', commandId: 'runtime', runtimeMode: 'full-access' })
    expect((await f.host.snapshot()).threads[0]).toMatchObject({ reasoningEffort: 'high', runtimeMode: 'full-access' })
    await f.host.execute({ type: 'configure-thread', commandId: 'model', threadId: 'thread', modelId: 'account:plain' })
    expect((await f.host.snapshot()).threads[0]).not.toHaveProperty('reasoningEffort')
  })
  it('sends an image in one turn-start request and retains provider transcript references after an uncertain response', async () => {
    const f = t3Fixture(); await f.host.snapshot(); f.setUnknown()
    expect(await f.host.execute({ type: 'send', commandId: 'once', threadId: 'thread', messageId: 'message', text: '', attachments: [image] })).toEqual({ accepted: false, uncertain: true })
    expect(f.payloads).toHaveLength(1)
    expect(f.payloads[0]).toMatchObject({ type: 'thread.turn.start', commandId: 'once', message: { messageId: 'message', text: '', attachments: [{ type: 'image', name: image.name, dataUrl: image.dataUrl }] } })
    const message = (await f.host.snapshot()).threads[0]?.messages[0]
    expect(message).toMatchObject({ id: 'message', commandId: 'once', attachments: [{ id: 'persisted-provider-id', name: image.name, mimeType: 'image/png' }] })
    expect(message?.attachments?.[0]).not.toHaveProperty('dataUrl')
  })
  it('rejects settings and images when a permission is pending', async () => {
    const f = t3Fixture(); await f.host.snapshot(); f.permission()
    await expect(f.host.execute({ type: 'configure-thread', commandId: 'config', threadId: 'thread', runtimeMode: 'full-access' })).rejects.toThrow(/pending requests/)
    await expect(f.host.execute({ type: 'send', commandId: 'send', threadId: 'thread', messageId: 'message', text: '', attachments: [image] })).rejects.toThrow(/permission/)
    expect(f.payloads).toEqual([])
  })
})

describe('coordinator images, authority and durable settings', () => {
  it('forwards settings and attachments through provider selection and Sotto thread identity wrappers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-options-')); roots.push(root)
    const provider = new FixtureHost()
    const registry = new ThreadRegistry(root)
    const host = new ConfiguredProviderHost({ provider: () => 't3', hosts: { t3: new SottoThreadHost('t3', provider, registry), codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost() } })
    disposers.push(() => host.disconnect())
    const initial = await host.connect({ endpoint: '', credential: '' })
    const threadId = initial.threads[0]!.id
    expect(threadId).not.toBe('workshop')
    await host.execute({ type: 'configure-thread', commandId: 'configure', threadId, reasoningEffort: 'high' })
    await host.execute({ type: 'send', commandId: 'send', threadId, messageId: 'message', text: '', attachments: [image] })
    expect(provider.attempts[0]).toMatchObject({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'high' })
    expect(provider.attempts[1]).toMatchObject({ type: 'send', threadId: 'workshop', attachments: [image] })
    expect((await host.snapshot()).threads[0]).toMatchObject({ id: threadId, messages: [{ attachments: [{ id: image.id }] }] })
    await registry.flush()
  })
  it('does not announce a cosmetic settings acknowledgement as saved', async () => {
    const f = await controlFixture(); f.host.cosmetic = true
    const state = await f.control.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'high' })
    expect(state.error).toMatch(/not confirmed/)
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox).toHaveLength(1)
    expect((await f.control.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'high' })).error).toMatch(/unknown result/)
    expect(f.host.attempts).toHaveLength(1)
  })
  it('creates an unmanaged thread with selected options; legacy creation stays managed', async () => {
    const f = await controlFixture()
    const created = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Manual', modelId: 'claude:test', reasoningEffort: 'high', runtimeMode: 'full-access', managed: false })
    expect(created.error).toBeNull(); expect(created.assignments).toEqual([])
    expect(created.host.threads.find(t => t.id === created.activeThreadId)).toMatchObject({ reasoningEffort: 'high', runtimeMode: 'full-access' })
    expect((await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Managed', modelId: 'claude:test' })).assignments).toHaveLength(1)
  })
  it('persists image-only manual drafts and never creates an assignment or duplicates an uncertain send', async () => {
    const f = await controlFixture(); f.host.unknown = true
    const command = { type: 'manual-send' as const, threadId: 'workshop', text: '', attachments: [image] }
    expect((await f.control.command(command)).error).toMatch(/confirm/)
    await f.restart()
    expect(f.control.get().draftAttachments).toEqual([image])
    expect((await f.control.command(command)).error).toMatch(/unknown result/)
    expect(f.host.attempts).toHaveLength(1)
    await f.host.reveal()
    const state = f.control.get()
    expect(state.draftAttachments).toEqual([]); expect(state.assignments).toEqual([])
    expect(state.host.threads[0]?.messages[0]?.attachments).toHaveLength(1)
    expect(f.host.attempts).toHaveLength(1)
  })
  it('does not clear an edited image draft when the previous uncertain message appears', async () => {
    const f = await controlFixture(); f.host.unknown = true
    await f.control.command({ type: 'manual-send', threadId: 'workshop', text: 'Look', attachments: [image] })
    const replacement = { ...image, id: 'shot-2', name: 'Replacement.png' }
    await f.control.command({ type: 'compose', text: 'Look', attachments: [replacement] })
    await f.host.reveal()
    expect(f.control.get().draftAttachments).toEqual([replacement])
  })
  it('keeps managed attachments across text edits, sends once, and never puts images into assignment authority', async () => {
    const f = await controlFixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: 'Look', attachments: [image] })
    await f.control.command({ type: 'compose', text: '' })
    expect(f.control.get().draftAttachments).toEqual([image])
    f.host.unknown = true
    expect((await f.control.command({ type: 'send' })).error).toMatch(/confirm/)
    await f.restart()
    expect((await f.control.command({ type: 'send' })).error).toMatch(/unknown result/)
    await f.host.reveal()
    expect(f.host.attempts).toHaveLength(1)
    expect(f.control.get().assignments[0]?.instruction).toBe('')
    expect(f.control.get().draftAttachments).toEqual([])
  })
  it('rejects permission bypass and preserves the existing image draft when changing threads', async () => {
    const f = await controlFixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: '', attachments: [image] })
    const moved = await f.control.command({ type: 'manual-send', threadId: 'docs', text: '', attachments: [image] })
    expect(moved.error).toBeNull()
    expect(moved).toMatchObject({ draftThreadId: 'workshop', draft: '', draftAttachments: [image] })
    f.host.event({ type: 'permission', threadId: 'workshop', text: 'Publish?', status: 'idle' })
    expect((await f.control.command({ type: 'send' })).error).toMatch(/permission/)
    expect(f.host.attempts).toEqual([expect.objectContaining({ type: 'send', threadId: 'docs', attachments: [image] })])
    expect((await f.control.command({ type: 'cancel-draft' })).draftAttachments).toEqual([])
  })
  it('validates a combined save before dispatch and persists uncertain settings until actual readback', async () => {
    const f = await controlFixture()
    expect((await f.control.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'invalid', runtimeMode: 'full-access' })).error).toMatch(/reasoning/)
    expect(f.host.attempts).toEqual([])
    const saved = await f.control.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'high', runtimeMode: 'full-access' })
    expect(saved.error).toBeNull(); expect(f.host.attempts).toHaveLength(2)
    expect(saved.host.threads[0]).toMatchObject({ reasoningEffort: 'high', runtimeMode: 'full-access' })
    f.host.unknown = true
    expect((await f.control.command({ type: 'configure-thread', threadId: 'workshop', runtimeMode: 'approval-required' })).error).toMatch(/confirm/)
    await f.restart()
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox[0]).toMatchObject({ type: 'configure-thread', options: { runtimeMode: 'approval-required' } })
    await f.host.reveal()
    await f.control.command({ type: 'refresh' })
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox).toEqual([])
    expect(f.host.attempts).toHaveLength(3)
  })
})
