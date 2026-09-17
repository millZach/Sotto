// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import type { AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import type { AgentIntent } from '../../../src/main/agents/reasoning'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { agentCommandSchema, type AgentAttachment, type AgentHostSnapshot, type AgentState } from '../../../src/shared/agents'

const roots: string[] = []
const controls = new Set<AgentControl>()
afterEach(async () => {
  for (const control of controls) {
    control.dispose()
    await control.privacyChanged() // Drain snapshot persistence before removing its fixture directory.
  }
  controls.clear()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-navigation-delivery-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})
/** The saved coordinator state that carries an undispatched prompt's durable intent. */
function outboxHasSend(value: unknown): boolean {
  return (value as { outbox?: { type?: string }[] } | null)?.outbox?.some(item => item.type === 'send') === true
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const image: AgentAttachment = { id: 'image', name: 'same.png', mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZ0AAAAASUVORK5CYII=' }
class FixtureHost extends E2EAgentHost {
  attempts: AgentHostCommand[] = []
  observeThreads = vi.fn<(ids: string[]) => void>()
  withheld: 'uncertain' | 'accepted' | null = null
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    this.attempts.push(command)
    if (this.withheld) return this.withheld === 'uncertain' ? { accepted: false, uncertain: true } : { accepted: true }
    return super.execute(command)
  }
  async acknowledge() { await super.execute(this.attempts.at(-1)!) }
}
async function fixture(receiptIds: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-navigation-delivery-')); roots.push(root)
  const host = new FixtureHost()
  const reasoner = { ...e2eAgentReasoner, intent: vi.fn(e2eAgentReasoner.intent) }
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: text => Buffer.from(text), decryptString: value => value.toString() })
  await credentials.load()
  const create = () => {
    const control = new AgentControl({ directory: root, host, credentials, reasoner, membership: {
      status: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }),
    } }); controls.add(control); return control
  }
  let control = create()
  await control.start(); await control.command({ type: 'connect' })
  if (receiptIds.length) {
    control.dispose(); await control.privacyChanged(); controls.delete(control)
    const saved = JSON.parse(await readFile(join(root, 'agents.json'), 'utf8'))
    saved.deliveredDrafts = receiptIds.map(draftId => ({ threadId: 'workshop', draftId }))
    await writeFile(join(root, 'agents.json'), JSON.stringify(saved))
    control = create(); await control.start(); await control.command({ type: 'connect' })
  }
  return { root, host, reasoner, get control() { return control }, async restart() {
    control.dispose(); await control.privacyChanged(); controls.delete(control)
    control = create(); await control.start()
  } }
}

describe('navigation independent of action latency', () => {
  it('keeps both open panes observed through refresh without moving focus or granting authority', async () => {
    const f = await fixture()
    await f.control.command({ type: 'select-thread', threadId: 'docs' })
    const before = f.control.get()
    const request = agentCommandSchema.parse({ type: 'observe-threads', threadIds: ['workshop', 'docs', 'workshop', 'missing'] })
    await f.control.command(request)
    expect(f.host.observeThreads).toHaveBeenLastCalledWith(['docs', 'workshop'])
    expect(f.control.get()).toMatchObject({ activeThreadId: 'docs', assignments: before.assignments, draft: before.draft })
    expect(f.host.attempts).toEqual([])
    await f.control.command({ type: 'refresh' })
    expect(f.host.observeThreads).toHaveBeenLastCalledWith(['docs', 'workshop'])
    await f.restart()
    expect(f.host.observeThreads).toHaveBeenLastCalledWith(['docs'])
    await f.control.command(request)
    await f.control.command(agentCommandSchema.parse({ type: 'observe-threads', threadIds: [] }))
    expect(f.host.observeThreads).toHaveBeenLastCalledWith(['docs'])
    expect(f.control.get().assignments).toEqual([])
  })

  it('updates pane observation immediately while coordinator reasoning is pending', async () => {
    const f = await fixture()
    const request = agentCommandSchema.parse({ type: 'observe-threads', threadIds: ['workshop', 'docs'] })
    const gate = deferred<AgentIntent>()
    f.reasoner.intent.mockReturnValueOnce(gate.promise)
    const reasoning = f.control.command({ type: 'utterance', text: 'A slow coordinator request' })
    await vi.waitFor(() => expect(f.reasoner.intent).toHaveBeenCalled())
    const observed = f.control.command(request)
    try {
      expect(f.host.observeThreads).toHaveBeenLastCalledWith(['workshop', 'docs'])
      expect(f.control.get().assignments).toEqual([])
      expect(f.host.attempts).toEqual([])
    } finally {
      gate.resolve({ type: 'clarify', text: 'Choose a thread.' })
      await reasoning
      await observed
    }
  })

  it('sends a manual prompt on B while preserving the saved draft on A', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: 'Keep A', attachments: [image] })
    await f.control.command({ type: 'select-thread', threadId: 'docs' })
    const draftId = randomUUID()
    const result = await f.control.command({ type: 'manual-send', threadId: 'docs', text: 'Only B', draftId })
    expect(result.error).toBeNull()
    expect(f.host.attempts.at(-1)).toMatchObject({ type: 'send', threadId: 'docs', text: 'Only B' })
    expect(result).toMatchObject({ draft: 'Keep A', draftThreadId: 'workshop', draftAttachments: [image], deliveredDrafts: [{ threadId: 'docs', draftId }] })
    expect(result.assignments.map(assignment => assignment.threadId)).toEqual(['workshop'])
    await f.restart()
    expect(f.control.get()).toMatchObject({ draft: 'Keep A', draftThreadId: 'workshop', draftAttachments: [image] })
  })

  it('publishes cached B and observes it during deferred refresh, retaining the draft and send authority on A', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: 'Only A', attachments: [image] })
    const before = f.control.get()
    const gate = deferred<AgentHostSnapshot>()
    vi.spyOn(f.host, 'snapshot').mockReturnValueOnce(gate.promise)
    const refresh = f.control.command({ type: 'refresh' })
    await vi.waitFor(() => expect(f.control.get().busy).toBe(true))
    const states: AgentState[] = []; f.control.subscribe(state => states.push(state))
    const select = f.control.command({ type: 'select-thread', threadId: 'docs' })
    try {
      expect(f.control.get().activeThreadId).toBe('docs')
      expect(states.at(-1)?.host.threads.find(t => t.id === states.at(-1)?.activeThreadId)?.title).toBe('Docs')
      expect(f.host.observeThreads).toHaveBeenLastCalledWith(['workshop', 'docs'])
      expect(f.control.get()).toMatchObject({ draftThreadId: 'workshop', draft: 'Only A', draftAttachments: [image], assignments: before.assignments })
      expect(f.host.attempts).toEqual([])
    } finally { gate.resolve(before.host); await refresh; await select }
    expect(f.control.get().activeThreadId).toBe('docs')
    await f.control.command({ type: 'send' })
    expect(f.host.attempts).toEqual([expect.objectContaining({ type: 'send', threadId: 'workshop', text: 'Only A' })])
    expect(f.control.get().activeThreadId).toBe('docs')
  })

  it.each<AgentIntent>([
    { type: 'select-thread', threadId: 'workshop' },
    { type: 'select-project', projectId: 'project' },
    { type: 'compose', threadId: 'workshop', text: 'For A' },
    { type: 'assign', threadId: 'workshop', instruction: '' },
  ])('does not let an older reasoning result %j override newer selection', async intent => {
    const f = await fixture()
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    const gate = deferred<AgentIntent>(); f.reasoner.intent.mockReturnValueOnce(gate.promise)
    const reasoning = f.control.command({ type: 'utterance', text: 'Resolve my request' })
    await vi.waitFor(() => expect(f.reasoner.intent).toHaveBeenCalled())
    const select = f.control.command({ type: 'select-thread', threadId: 'docs' })
    try {
      expect(f.control.get().activeThreadId).toBe('docs')
      expect(f.host.observeThreads).toHaveBeenLastCalledWith(['docs'])
      expect(f.control.get().assignments).toEqual([])
      expect(f.host.attempts).toEqual([])
    } finally { gate.resolve(intent); await reasoning; await select }
    expect(f.control.get().activeThreadId).toBe('docs')
    if (intent.type === 'compose') {
      expect(f.control.get()).toMatchObject({ draft: 'For A', draftThreadId: 'workshop', assignments: [] })
      expect((await f.control.command({ type: 'send' })).error).toMatch(/Assign/)
      expect(f.host.attempts).toEqual([])
    }
  })

  it('does not let creation completion bind its draft or selection to a newly selected thread', async () => {
    const f = await fixture()
    const gate = deferred<void>(); const original = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementationOnce(async command => { await gate.promise; return original(command) })
    const creating = f.control.command({ type: 'create-thread', projectId: 'project', title: 'New A', modelId: 'claude:test' })
    await vi.waitFor(() => expect(f.host.execute).toHaveBeenCalled())
    const select = f.control.command({ type: 'select-thread', threadId: 'docs' })
    try { expect(f.control.get().activeThreadId).toBe('docs') }
    finally { gate.resolve(); await creating; await select }
    const created = f.control.get().host.threads.find(t => t.title === 'New A')!
    expect(f.control.get()).toMatchObject({ activeThreadId: 'docs', draftThreadId: created.id, assignments: [expect.objectContaining({ threadId: created.id })] })
    await f.control.command({ type: 'compose', text: 'Only new A' })
    await f.control.command({ type: 'send' })
    expect(f.host.attempts.at(-1)).toMatchObject({ type: 'send', threadId: created.id })
  })

  it('preserves selected project when an older project creation finishes', async () => {
    const f = await fixture()
    const gate = deferred<void>(); const original = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementationOnce(async command => { await gate.promise; return original(command) })
    const creating = f.control.command({ type: 'create-project', title: 'New project', path: join(f.root, 'new-project') })
    await vi.waitFor(() => expect(f.host.execute).toHaveBeenCalled())
    await f.control.command({ type: 'select-thread', threadId: 'docs' })
    gate.resolve(); await creating
    expect(f.control.get()).toMatchObject({ activeThreadId: 'docs', activeProjectId: 'project' })
    expect(f.control.get().host.projects).toHaveLength(2)
  })

  it('does not let an older answer completion force selection back to its remaining queue item', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    for (const requestId of ['one', 'two']) f.host.event({ type: 'permission', threadId: 'workshop', requestId, text: 'Allow?' })
    const gate = deferred<void>(); const original = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementationOnce(async command => { await gate.promise; return original(command) })
    const answering = f.control.command({ type: 'answer', threadId: 'workshop', requestId: 'one', answer: 'Deny', approved: false })
    await vi.waitFor(() => expect(f.host.execute).toHaveBeenCalled())
    await f.control.command({ type: 'select-thread', threadId: 'docs' })
    gate.resolve(); await answering
    expect(f.control.get()).toMatchObject({ activeThreadId: 'docs', queue: [expect.objectContaining({ threadId: 'workshop', requestId: 'two' })] })
    expect(f.host.attempts).toEqual([expect.objectContaining({ type: 'answer', threadId: 'workshop', requestId: 'one' })])
  })

  it('selects cached history while disconnected without granting action authority', async () => {
    const f = await fixture()
    await f.control.command({ type: 'disconnect' })
    expect(await f.control.command({ type: 'select-thread', threadId: 'docs' })).toMatchObject({ activeThreadId: 'docs', assignments: [], error: null, connection: 'disconnected' })
    expect(f.host.attempts).toEqual([])
  })
})

describe('manual delivery receipts', () => {
  it('preserves a foreign answer and images through uncertain manual delivery, restart, and acknowledgement', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    f.host.event({ type: 'question', threadId: 'workshop', requestId: 'question-a', text: 'Which color?' })
    await f.control.command({ type: 'compose', text: 'Keep this answer', attachments: [image] })
    const saved = f.control.get()
    expect(saved.draftRequestId).toBe('question-a')
    f.host.withheld = 'uncertain'
    const draftId = randomUUID()
    const result = await f.control.command({ type: 'manual-send', threadId: 'docs', text: 'Only B', draftId })
    expect(result.error).toMatch(/confirm/)
    const expected = { draft: saved.draft, draftThreadId: saved.draftThreadId, draftRequestId: saved.draftRequestId, draftAttachments: saved.draftAttachments }
    expect(result).toMatchObject(expected)
    await f.restart()
    await f.host.acknowledge()
    expect(f.control.get()).toMatchObject({ ...expected, deliveredDrafts: [{ threadId: 'docs', draftId }] })
    await f.control.command({ type: 'manual-send', threadId: 'docs', text: 'Only B', draftId })
    expect(f.host.attempts).toHaveLength(1)
  })

  it('accepts optional UUID identities and retains legacy callers', () => {
    const command = { type: 'manual-send', threadId: 'workshop', text: 'Hello' }
    expect(agentCommandSchema.safeParse(command).success).toBe(true)
    expect(agentCommandSchema.safeParse({ ...command, draftId: randomUUID() }).success).toBe(true)
    expect(agentCommandSchema.safeParse({ ...command, draftId: 'filename-text-size' }).success).toBe(false)
  })
  it.each(['normal', 'late', 'restart'] as const)('publishes an actual-message receipt on %s acknowledgement and never resends that revision', async path => {
    const f = await fixture(); const draftId = randomUUID()
    const command = { type: 'manual-send' as const, threadId: 'workshop', draftId, text: 'Look', attachments: [image] }
    if (path !== 'normal') f.host.withheld = 'uncertain'
    const state = await f.control.command(command)
    if (path !== 'normal') {
      expect(state.error).toMatch(/confirm/)
      expect(state.deliveredDrafts ?? []).toEqual([])
      expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox[0]).toMatchObject({ draftId })
      if (path === 'restart') await f.restart()
      await f.host.acknowledge()
    }
    expect(f.control.get().deliveredDrafts).toEqual([{ threadId: 'workshop', draftId }])
    expect(f.control.get()).toMatchObject({ draft: '', draftAttachments: [], assignments: [] })
    f.host.event({ type: 'ready', threadId: 'workshop', text: 'Done', status: 'idle' })
    await f.control.command(command)
    expect(f.host.attempts).toHaveLength(1)
    await f.restart()
    expect(f.control.get().deliveredDrafts).toEqual([{ threadId: 'workshop', draftId }])
    await f.control.command(command)
    expect(f.host.attempts).toHaveLength(1)
  })
  it('keeps an accepted response pending until the actual user message is visible', async () => {
    const f = await fixture(); f.host.withheld = 'accepted'; const draftId = randomUUID()
    const state = await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Hello' })
    expect(state.error).toMatch(/confirm/)
    expect(state.deliveredDrafts ?? []).toEqual([])
    expect(state.draft).toBe('Hello')
    await f.host.acknowledge()
    expect(f.control.get().deliveredDrafts).toEqual([{ threadId: 'workshop', draftId }])
  })
  it('keeps outbox targets observed after navigating away and after restart', async () => {
    const f = await fixture(); f.host.withheld = 'uncertain'; const draftId = randomUUID()
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Hello' })
    await f.control.command({ type: 'select-thread', threadId: 'docs' })
    expect(f.host.observeThreads).toHaveBeenLastCalledWith(['docs', 'workshop'])
    await f.restart()
    expect(f.host.observeThreads).toHaveBeenLastCalledWith(['docs', 'workshop'])
    await f.host.acknowledge()
    expect(f.control.get()).toMatchObject({ activeThreadId: 'docs', deliveredDrafts: [{ threadId: 'workshop', draftId }] })
  })
  it('reconciles receipts on startup from a snapshot without needing a provider event', async () => {
    const f = await fixture(); f.host.withheld = 'uncertain'; const draftId = randomUUID()
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Hello' })
    f.control.dispose()
    await f.host.acknowledge()
    await f.restart()
    expect(f.control.get()).toMatchObject({ deliveredDrafts: [{ threadId: 'workshop', draftId }], draft: '' })
    expect(f.host.attempts).toHaveLength(1)
  })
  it('does not reconcile an assistant message with the expected ID or an unrelated identical user payload', async () => {
    const f = await fixture(); f.host.withheld = 'uncertain'; const draftId = randomUUID()
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Hello' })
    const sent = f.host.attempts[0]!
    if (sent.type !== 'send') throw new Error('Missing send')
    const snapshot = await f.host.snapshot()
    snapshot.threads[0]!.messages.push({ id: sent.messageId, role: 'assistant', text: sent.text, createdAt: new Date().toISOString() },
      { id: 'unrelated', role: 'user', text: sent.text, createdAt: new Date().toISOString() })
    vi.spyOn(f.host, 'snapshot').mockResolvedValueOnce(snapshot)
    await f.control.command({ type: 'refresh' })
    expect(f.control.get()).toMatchObject({ deliveredDrafts: [], draft: 'Hello' })
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox).toHaveLength(1)
  })
  it.each(['text', 'image', 'identical replacement'] as const)('does not deliver or clear a %s edit on an earlier receipt', async edit => {
    const f = await fixture(); f.host.withheld = 'uncertain'
    const draftId = randomUUID()
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Look', attachments: [image] })
    const text = edit === 'text' ? 'Changed' : 'Look'
    // Same name, size, and attachment ID; changed bytes must remain an edit.
    const replacement = edit === 'image' ? { ...image, dataUrl: image.dataUrl.replace('AAAAASUV', 'AAABASUV') } : image
    await f.control.command({ type: 'compose', text, attachments: [replacement] })
    await f.host.acknowledge()
    expect(f.control.get()).toMatchObject({ draft: text, draftThreadId: 'workshop', draftAttachments: [replacement], deliveredDrafts: [{ threadId: 'workshop', draftId }] })
  })
  it('does not report a replacement UUID delivered when retry reconciles an older payload', async () => {
    const f = await fixture(); f.host.withheld = 'uncertain'
    const draftId = randomUUID(); const replacementId = randomUUID()
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Old' })
    const snapshot = await f.host.snapshot(); const sent = f.host.attempts[0]!
    if (sent.type !== 'send') throw new Error('Missing send')
    snapshot.threads[0]!.messages.push({ id: sent.messageId, role: 'user', text: sent.text, createdAt: new Date().toISOString() })
    vi.spyOn(f.host, 'snapshot').mockResolvedValueOnce(snapshot)
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId: replacementId, text: 'Replacement' })
    expect(f.control.get().deliveredDrafts).toEqual([{ threadId: 'workshop', draftId }])
    expect(f.host.attempts).toHaveLength(1)
  })
  it('shows the prompt as Sending before its durable write finishes, and still writes the outbox before dispatch', async () => {
    const f = await fixture()
    const gate = deferred<void>()
    const write = AtomicJsonStore.prototype.write
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function (this: AtomicJsonStore<unknown>, value: unknown) {
      if (outboxHasSend(value)) await gate.promise
      return write.call(this, value)
    })
    const states: AgentState[] = []; f.control.subscribe(state => states.push(state))
    const draftId = randomUUID()
    const sending = f.control.command({ type: 'manual-send', threadId: 'docs', text: 'Appears at once', draftId })
    try {
      await vi.waitFor(() => expect(states.at(-1)?.deliveries).toContainEqual(expect.objectContaining({ threadId: 'docs', draftId, status: 'submitting' })))
      // Durability still gates the provider: the outbox entry is written before anything is dispatched.
      expect(f.host.attempts).toEqual([])
    } finally { gate.resolve(); await sending }
    expect(f.host.attempts.filter(command => command.type === 'send')).toHaveLength(1)
    expect(f.control.get().deliveredDrafts).toContainEqual({ threadId: 'docs', draftId })
  })

  it('marks the delivery failed and dispatches nothing when its durable write fails', async () => {
    const f = await fixture()
    const write = AtomicJsonStore.prototype.write
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function (this: AtomicJsonStore<unknown>, value: unknown) {
      if (outboxHasSend(value)) throw new Error('Disk unavailable')
      return write.call(this, value)
    })
    const draftId = randomUUID()
    const result = await f.control.command({ type: 'manual-send', threadId: 'docs', text: 'Never sent', draftId })
    expect(result.error).toContain('Disk unavailable')
    expect(result.deliveries).toContainEqual(expect.objectContaining({ threadId: 'docs', draftId, status: 'failed' }))
    expect(f.host.attempts).toEqual([])
    expect(result.threadDrafts).toContainEqual(expect.objectContaining({ threadId: 'docs', draftId, text: 'Never sent' }))
  })

  it('bounds receipt history to 128 persisted identities', async () => {
    // Load a full durable history, then cross its retention boundary through real
    // sends. Recreating all 128 prior conversations only measures filesystem load.
    const ids = Array.from({ length: 128 }, () => randomUUID())
    const f = await fixture(ids)
    expect(f.control.get().deliveredDrafts).toHaveLength(128)
    for (let i = 0; i < 2; i++) {
      const draftId = randomUUID(); ids.push(draftId)
      await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: `Prompt ${i}` })
      f.host.event({ type: 'ready', threadId: 'workshop', text: 'Done', status: 'idle' })
    }
    await f.control.privacyChanged()
    const receipts = ids.slice(-128).map(draftId => ({ threadId: 'workshop', draftId }))
    expect(f.control.get().deliveredDrafts).toEqual(receipts)
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).deliveredDrafts).toEqual(receipts)
    await f.restart(); expect(f.control.get().deliveredDrafts).toEqual(receipts)
  })
})
