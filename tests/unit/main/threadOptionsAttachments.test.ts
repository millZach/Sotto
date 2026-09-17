// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentAttachmentsSchema, agentCommandSchema, type AgentAttachment, type AgentHostSnapshot } from '../../../src/shared/agents'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { validatePromptAttachments } from '../../../src/main/agents/threadOptions'
import type { AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import { SottoThreadHost, ThreadRegistry } from '../../../src/main/agents/threads'
import { ConfiguredProviderHost } from '../../../src/main/agents/providerSwitch'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

const image: AgentAttachment = { id: 'shot-1', name: 'Screenshot.png', mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZ0AAAAASUVORK5CYII=' }
const roots: string[] = []
const disposers: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-options-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})

class FixtureHost extends E2EAgentHost {
  attempts: AgentHostCommand[] = []
  unknown = false
  hideMessages = false
  cosmetic = false
  override async snapshot(): Promise<AgentHostSnapshot> {
    const snapshot = await super.snapshot()
    return this.hideMessages ? { ...snapshot, threads: snapshot.threads.map(thread => ({ ...thread, messages: [] })) } : snapshot
  }
  gate: Promise<void> | undefined
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    this.attempts.push(command)
    await this.gate
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
  const create = () => new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner,
    membership: { status: async () => ({ status: 'beta', label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Test', expiresAt: null }) } })
  let control = create(); disposers.push(async () => { control.dispose(); await control.privacyChanged() })
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
    const snapshot = await new E2EAgentHost().snapshot()
    expect(() => validatePromptAttachments(snapshot, 'claude:test', [{ ...image, dataUrl: 'data:image/png;base64,YWJj' }])).toThrow(/content/)
  })
})

describe('coordinator images, authority and durable settings', () => {
  it('forwards settings and attachments through provider selection and Sotto thread identity wrappers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-options-')); roots.push(root)
    const provider = new FixtureHost()
    const registry = new ThreadRegistry(root)
    const host = new ConfiguredProviderHost({ provider: () => 'codex', hosts: { codex: new SottoThreadHost('codex', provider, registry), claude: new E2EAgentHost(), grok: new E2EAgentHost() } })
    disposers.push(() => host.disconnect())
    const initial = await host.connect()
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
  it('recovers a restart in the middle of a thread-scoped command from its durable intent alone', async () => {
    const f = await controlFixture()
    let release!: () => void
    f.host.gate = new Promise<void>(done => { release = done })
    const pending = f.control.command({ type: 'configure-thread', threadId: 'workshop', runtimeMode: 'full-access' })
    await vi.waitFor(() => expect(f.host.attempts).toHaveLength(1))
    // The thread is marked busy in its own lane; the global flag still stands for global work alone.
    expect(f.control.get()).toMatchObject({ busyThreadIds: ['workshop'], busy: false })
    // Crash while that lane holds the command: only the dispatched intent reached the disk.
    f.control.dispose()
    release(); await pending
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox[0])
      .toMatchObject({ type: 'configure-thread', threadId: 'workshop', options: { runtimeMode: 'full-access' } })
    f.host.gate = undefined
    await f.restart()
    // A busy mark is as ephemeral as the global flag: nothing restores it, and reconciliation is unchanged.
    expect(f.control.get()).toMatchObject({ busy: false })
    expect(f.control.get().busyThreadIds).toBeUndefined()
    await f.control.command({ type: 'refresh' })
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox).toEqual([])
    expect(f.control.get().host.threads.find(thread => thread.id === 'workshop')?.runtimeMode).toBe('full-access')
  })
})
