// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { LEGACY_VOICE_CONFIGURATION, MANAGEMENT_REMOVED, protocolAgentStateSchema, shellForProtocolV1 } from '../../../src/shared/hostProtocol'
import { agentCommandSchema, type AgentCommand } from '../../../src/shared/agents'
import { remoteCommandRefusal } from '../../../src/host/remoteCommands'
import { maintainProviderRecovery } from '../../../src/main/agents/providerRetirement'
import { olderDesktopAccountSchema } from '../../fixtures/olderDesktopAccountSchema'
import { PIXEL_DATA_URL } from '../../fixtures/stagedImages'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { DesktopHostRouter } from '../../../src/main/hosts/desktopHostRouter'
import { desktopWindowClient } from '../../../src/main/agents/hostService'
import { hostEntityKey } from '../../../src/shared/clientIdentity'

const roots: string[] = [], controls: AgentControl[] = []
const encryption = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-voice-upgrade-')); roots.push(root)
  const credentials = new AgentCredentials(root, encryption); await credentials.load()
  const host = new E2EAgentHost()
  const legacy = new AgentControl({ directory: root, host, credentials, reasoner: e2eAgentReasoner, schedule: immediatePublishScheduler })
  await legacy.start(); await legacy.command({ type: 'connect' }); legacy.dispose(); await legacy.closed()
  const path = join(root, 'agents.json'), saved = JSON.parse(await readFile(path, 'utf8'))
  const reasoner = { ...e2eAgentReasoner, intent: vi.fn(e2eAgentReasoner.intent), decide: vi.fn(e2eAgentReasoner.decide) }
  const control = new AgentControl({ directory: root, host, credentials, reasoner, removalMode: true, coordinatorEnabled: () => true, schedule: immediatePublishScheduler })
  controls.push(control)
  return { root, path, saved, host, control, reasoner, credentials }
}
afterEach(async () => {
  for (const control of controls.splice(0)) control.dispose()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

describe('voice control upgrade', () => {
  it('ends both assignment modes before refresh and preserves drafts, images, queues and uncertain delivery', async () => {
    const f = await fixture(), draftId = randomUUID(), queuedId = randomUUID(), receiptId = randomUUID()
    const image = { id: 'image', name: 'Synthetic.png', mimeType: 'image/png', dataUrl: PIXEL_DATA_URL }
    Object.assign(f.saved, {
      assignments: ['managed', 'manual'].map((mode, i) => ({ threadId: i ? 'docs' : 'workshop', mode, instruction: 'Old work',
        followups: 3, paused: false, seenMessageIds: [], ownMessageIds: [], handledRequestIds: [], lastFailure: '', contextUpdatedAt: Date.now() })),
      queue: [{ id: 'old-attention', threadId: 'workshop', kind: 'question', text: 'Old attention', requestId: 'old-question', createdAt: new Date().toISOString(), deferred: false }],
      activeThreadId: 'workshop', draft: 'Unsent answer', draftThreadId: 'workshop', draftRequestId: 'native-question', composing: true,
      draftAttachments: [image], manualDraftId: draftId, coordinatorConversation: true, pendingRequest: 'Spoken clarification',
      deliveredDrafts: [{ threadId: 'docs', draftId: receiptId }],
      outbox: [{ id: 'unknown-dispatch', type: 'send', threadId: 'docs', messageId: 'missing-message', draftId: receiptId }],
      deliveries: [{ threadId: 'docs', draftId: receiptId, status: 'uncertain', commandId: 'unknown-dispatch', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    })
    f.saved.configuration = { ...f.saved.configuration, reasoning: 'claude', reasoningModel: 'claude:test',
      newThreadModelId: 'claude:test', newThreadReasoningEffort: 'high', newThreadRuntimeMode: 'approval-required',
      speak: true, wakeModelDirectory: 'user-selected-wake' }
    await writeFile(f.path, JSON.stringify(f.saved), 'utf8')
    await writeFile(join(f.root, 'followups.json'), JSON.stringify({ items: [{ id: queuedId, threadId: 'docs', draftId: queuedId,
      text: 'Queued by the user', attachments: [], status: 'paused', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }], receipts: [] }), 'utf8')
    const execute = vi.spyOn(f.host, 'execute')
    await f.control.start()
    f.host.event({ type: 'question', threadId: 'workshop', requestId: 'native-question', text: 'Native question' })
    await f.control.command({ type: 'refresh' })
    const state = f.control.get()
    expect(state).toMatchObject({ assignments: [], queue: [], pendingRequest: '', composing: false,
      draft: 'Unsent answer', draftThreadId: 'workshop', draftRequestId: 'native-question',
      configuration: { reasoning: 'claude', reasoningModel: 'claude:test', newThreadModelId: 'claude:test', newThreadReasoningEffort: 'high', newThreadRuntimeMode: 'approval-required', speak: false } })
    expect(state.draftAttachments).toHaveLength(1)
    expect(state.threadDrafts).toEqual(expect.arrayContaining([expect.objectContaining({ threadId: 'workshop', draftId, text: 'Unsent answer', requestId: 'native-question', attachments: state.draftAttachments })]))
    expect(state.followups).toEqual(expect.arrayContaining([expect.objectContaining({ id: queuedId, text: 'Queued by the user', status: 'paused' })]))
    expect(state.deliveredDrafts).toEqual(f.saved.deliveredDrafts)
    expect(state.deliveries).toEqual(expect.arrayContaining([expect.objectContaining({ draftId: receiptId, status: 'uncertain' })]))
    expect(state.host.threads.find(thread => thread.id === 'workshop')?.requests).toHaveLength(1)
    expect(execute.mock.calls.filter(([command]) => ['send', 'answer'].includes(command.type))).toEqual([])
    expect(f.reasoner.intent).not.toHaveBeenCalled(); expect(f.reasoner.decide).not.toHaveBeenCalled()
    const migrated = JSON.parse(await readFile(f.path, 'utf8'))
    expect(migrated.outbox).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'unknown-dispatch' })]))
    for (const key of Object.keys(LEGACY_VOICE_CONFIGURATION)) expect(migrated.configuration).not.toHaveProperty(key)
    expect((await readdir(f.root)).some(name => name.includes('.corrupt-'))).toBe(false)
    f.control.dispose(); await f.control.closed()
    const again = new AgentControl({ directory: f.root, host: f.host, credentials: f.credentials, reasoner: f.reasoner, removalMode: true })
    controls.push(again); await again.start()
    expect(again.get()).toMatchObject({ assignments: [], draft: 'Unsent answer', draftRequestId: 'native-question' })
  })

  it('keeps drafts readable and management inert when the migration save fails', async () => {
    const f = await fixture()
    f.saved.draft = 'Keep this'; f.saved.pendingRequest = 'Old speech'
    f.saved.assignments = [{ threadId: 'workshop', mode: 'managed', instruction: 'Old work' }]
    await writeFile(f.path, JSON.stringify(f.saved), 'utf8')
    const realWrite = AtomicJsonStore.prototype.write
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function (this: AtomicJsonStore<unknown>, value, compact) {
      return String((this as unknown as { filePath: string }).filePath).endsWith('agents.json')
        ? Promise.reject(new Error('Storage unavailable')) : realWrite.call(this, value, compact)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await f.control.start()
    expect(f.control.get()).toMatchObject({ draft: 'Keep this', assignments: [], queue: [], pendingRequest: '', error: expect.stringContaining('Your drafts are readable') })
    expect(warn).toHaveBeenCalledWith('management-removal-save-failed')
    expect(f.reasoner.decide).not.toHaveBeenCalled()
    expect((await f.control.command({ type: 'assign', threadId: 'workshop' })).error).toBe(MANAGEMENT_REMOVED)
    expect(JSON.parse(await readFile(f.path, 'utf8')).draft).toBe('Keep this')
  })

  it('refuses every retired admission and still accepts explicit manual work', async () => {
    const f = await fixture(); await f.control.start()
    const commands = [
      { type: 'assign', threadId: 'workshop' }, { type: 'unassign', threadId: 'workshop' }, { type: 'pause', threadId: 'workshop' }, { type: 'resume', threadId: 'workshop' },
      { type: 'utterance', text: 'Manage workshop' }, { type: 'voice', action: 'mute' }, { type: 'voice-state', status: 'idle', error: null }, { type: 'preview-voice' },
      { type: 'create-thread', projectId: 'project', title: 'Managed', modelId: 'claude:test', managed: true },
      { type: 'configure', patch: { speak: true } }, { type: 'credential', slot: 'grokSpeech', value: 'fixture' },
    ] as AgentCommand[]
    for (const command of commands) expect((await f.control.command(command)).error, command.type).toBe(MANAGEMENT_REMOVED)
    const manual = await f.control.command({ type: 'manual-send', threadId: 'workshop', text: 'Explicit prompt' })
    expect(manual.error).toBeNull(); expect(manual.assignments).toEqual([]); expect(manual.speech.text).toBe('')
    expect(f.reasoner.intent).not.toHaveBeenCalled(); expect(f.reasoner.decide).not.toHaveBeenCalled()
    for (const managed of [undefined, false]) {
      const created = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Manual thread', modelId: 'claude:test', ...(managed === undefined ? {} : { managed }) })
      expect(created.error).toBeNull(); expect(created.assignments).toEqual([])
    }
  })

  it('keeps frozen v1 placeholders readable and detects authority before stripping old host state', async () => {
    const f = await fixture(); await f.control.start()
    const state = f.control.shell(), wire = shellForProtocolV1(state)
    expect(olderDesktopAccountSchema.safeParse(wire).success).toBe(true)
    expect(wire).toMatchObject({ assignments: [], queue: [], pendingRequest: '', credentials: { grokSpeech: false }, configuration: LEGACY_VOICE_CONFIGURATION })
    const legacy = { ...wire, assignments: [{ threadId: 'workshop', mode: 'managed' }], configuration: { ...wire.configuration, speak: true } }
    const read = protocolAgentStateSchema.parse(legacy)
    expect(read).toMatchObject({ legacyManagement: true, assignments: [], queue: [], configuration: { speak: false } })
    expect(protocolAgentStateSchema.parse(read).legacyManagement).toBe(true)
    expect(protocolAgentStateSchema.parse(wire).legacyManagement).toBe(false)
    expect(protocolAgentStateSchema.safeParse({ ...legacy, configuration: { ...legacy.configuration, unknownGrant: true } }).success).toBe(false)
    for (const managed of [undefined, false, true]) {
      const command = agentCommandSchema.parse({ type: 'create-thread', projectId: 'project', title: 'Manual', modelId: 'claude:test', ...(managed === undefined ? {} : { managed }) })
      expect(remoteCommandRefusal(command, { mayAnswer: true })).toBe(managed === true ? 'forbidden' : null)
    }
  })

  it('removes grants from bounded provider recovery without losing its saved draft', async () => {
    const f = await fixture(), path = join(f.root, 'provider-retirement-v1.json')
    await mkdir(f.root, { recursive: true })
    await writeFile(path, JSON.stringify({ version: 1, sourceDigest: 'a'.repeat(64), migratedAt: Date.now(), expiresAt: Date.now() + 86_400_000,
      state: { ...f.saved, assignments: [{ threadId: 'workshop', mode: 'managed', instruction: 'Old work' }], draft: 'Historical draft' } }), 'utf8')
    await maintainProviderRecovery(f.root, true, Date.now(), true)
    expect(JSON.parse(await readFile(path, 'utf8')).state).toMatchObject({ assignments: [], queue: [], draft: 'Historical draft' })
  })
  it('keeps an old host readable with draft saves and Stop, but requires updating before new work', async () => {
    const f = await fixture(); await f.control.start()
    const state = { ...f.control.get(), legacyManagement: true }, hostId = randomUUID()
    const command = vi.fn(async () => state)
    const router = new DesktopHostRouter(() => f.control.shell(), { removalMode: true })
    router.add({ hostId, name: 'Old host', kind: 'remote', service: { shell: () => state, command, subscribe: () => () => undefined },
      detail: id => f.control.threadDetail(id), preview: request => f.control.attachmentPreview(request) })
    const threadId = hostEntityKey(hostId, 'workshop'), client = desktopWindowClient()
    expect(router.requiresManagementUpdate(hostId)).toBe(true)
    expect(await router.threadDetail(threadId)).not.toBeNull()
    expect((await router.command({ type: 'manual-send', threadId, text: 'New work' }, client)).error).toContain('Update the host')
    expect((await router.command({ type: 'start-thread-session', threadId }, client)).error).toContain('Update the host')
    expect(command).not.toHaveBeenCalled()
    await router.command({ type: 'save-thread-draft', threadId, draftId: randomUUID(), text: 'Keep this draft' }, client)
    await router.command({ type: 'interrupt', threadId }, client)
    expect(command).toHaveBeenCalledTimes(2)
    state.legacyManagement = false
    expect(router.requiresManagementUpdate(hostId)).toBe(false)
    await router.command({ type: 'manual-send', threadId, text: 'Explicit work' }, client)
    expect(command).toHaveBeenCalledTimes(3)
    router.dispose()
  })
})
