// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { serialize } from 'node:v8'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl, DRAFT_IMAGE_NOT_SAVED } from '../../../src/main/agents/control'

import { LOST_IMAGES } from '../../../src/main/agents/followups'
import { MISSING_ATTACHMENT, UNOWNED_ATTACHMENT_GRACE_MS } from '../../../src/main/agents/attachmentStore'
import type { AgentHost, AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import type { AgentAttachmentHandle, AgentHostSnapshot, AgentState, AgentThread } from '../../../src/shared/agents'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { handleOf, pngOfSize } from '../../fixtures/stagedImages'
import { testCredentials } from '../../fixtures/testCredentials'
import { createAgentControl } from '../../fixtures/agentControlFixture'

const roots: string[] = []; const controls: AgentControl[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const control of controls.splice(0)) { control.dispose(); await control.privacyChanged().catch(() => undefined) }
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-staged-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})

/** A provider that reads each image it is sent, the way an adapter does at its boundary, and keeps the bytes it read. */
class Host implements AgentHost {
  state!: AgentHostSnapshot
  listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  attempts: AgentHostCommand[] = []
  received: Buffer[] = []
  result: AgentHostResult | undefined
  async connect() {
    this.state ??= await new E2EAgentHost().connect()
    this.state.connected = true; this.state.models.forEach(model => { model.supportsImages = true })
    return this.snapshot()
  }
  async snapshot() { return structuredClone(this.state) }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  disconnect() { this.state.connected = false }
  update(id: string, patch: Partial<AgentThread>) { Object.assign(this.state.threads.find(thread => thread.id === id)!, patch); this.emit() }
  emit() { for (const listener of this.listeners) listener(structuredClone(this.state)) }
  async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    this.attempts.push(command)
    if (command.type === 'send' || command.type === 'steer') for (const image of command.attachments ?? []) this.received.push(Buffer.from(await image.read()))
    if (this.result) return this.result
    if (command.type === 'send' || command.type === 'steer') {
      const thread = this.state.threads.find(item => item.id === command.threadId)!
      thread.messages.push({ id: command.messageId, commandId: command.commandId, role: 'user', text: command.text, createdAt: new Date().toISOString(),
        ...(command.attachments?.length ? { attachments: command.attachments.map(({ id, name, mimeType, sizeBytes }) => ({ id, name, mimeType, sizeBytes })) } : {}) })
      thread.status = 'running'; thread.lastTurn = { id: command.commandId, status: 'running' }; this.emit()
    }
    return { accepted: true }
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-staged-')); roots.push(root)
  const host = new Host(); let history = true
  const credentials = await testCredentials(root, { mode: 'unavailable' })

  const create = () => {
    const control = createAgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner, historyEnabled: () => history,
    })
    controls.push(control); return control
  }
  let control = create(); await control.start(); await control.command({ type: 'connect' })
  const stage = async (bytes: Buffer, name = 'Screenshot.png') => ({ ...await control.stageAttachment({ name, mimeType: 'image/png', bytes }) })
  return {
    root, host, stage, get control() { return control }, setHistory(value: boolean) { history = value },
    files: async () => (await readdir(join(root, 'attachments')).catch(() => [])).filter(name => name !== 'index.json'),
    disk: async (name: string) => readFile(join(root, name), 'utf8'),
    /** A restart after a crash: nothing is tidied on the way out. */
    async crash() { control.dispose(); control = create(); await control.start(); await control.command({ type: 'connect' }) },
    async restart() { control.dispose(); await control.privacyChanged(); control = create(); await control.start(); await control.command({ type: 'connect' }) },
  }
}
const digestOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
/** A run of the image's own base64, long enough that finding it means the bytes are there. */
const trace = (bytes: Buffer) => bytes.toString('base64').slice(40, 120)
/** Moves every clock past the grace period and runs the upkeep that removes content nothing owns. */
async function afterGrace(control: AgentControl) {
  const later = Date.now() + UNOWNED_ATTACHMENT_GRACE_MS + 1000
  vi.spyOn(Date, 'now').mockReturnValue(later)
  await control.privacyChanged()
}

describe('staged images through the coordinator (ADR-0031)', () => {
  it('keeps the bytes out of draft saves, the shell, every broadcast while a thread streams, and the saved state', async () => {
    const f = await fixture()
    const bytes = pngOfSize(256 * 1024, 5)
    const image = await f.stage(bytes)
    f.host.update('docs', { status: 'running' })
    await f.control.command({ type: 'queue-followup', threadId: 'docs', draftId: randomUUID(), text: 'After this', attachments: [image] })
    const broadcasts: Buffer[] = []
    f.control.subscribe(state => { broadcasts.push(serialize(state)) })
    const save = await f.control.command({ type: 'save-thread-draft', threadId: 'workshop', draftId: randomUUID(), text: 'Look', attachments: [image], requestId: null })
    expect(save.error).toBeNull()
    for (let chunk = 0; chunk < 20; chunk += 1) f.host.update('docs', { title: `Streaming ${chunk}` })
    expect(broadcasts.length).toBeGreaterThanOrEqual(20)
    for (const payload of [...broadcasts, serialize(f.control.shell()), serialize(save)]) {
      expect(payload.toString('latin1')).not.toContain(trace(bytes))
      expect(payload.length).toBeLessThan(64 * 1024)
    }
    expect(f.control.shell().threadDrafts).toEqual([expect.objectContaining({ threadId: 'workshop', attachments: [image] })])
    for (const name of ['agents.json', 'followups.json', 'attachment-previews.json']) expect(await f.disk(name).catch(() => '')).not.toContain(trace(bytes))
    // One file for the content, however many drafts and follow-ups name it.
    expect(await f.files()).toEqual([`${image.digest}.png`])
  })
  it('sends the digest the user attached, after a refusal, a restart and a retry of the same revision', async () => {
    const f = await fixture()
    const bytes = pngOfSize(64 * 1024, 6)
    const image = await f.stage(bytes)
    const draftId = randomUUID()
    const send = { type: 'manual-send' as const, threadId: 'workshop', draftId, text: 'Look at this', attachments: [image] }
    f.host.result = { accepted: false }
    expect((await f.control.command(send)).error).toMatch(/reject/i)
    await f.restart()
    f.host.result = undefined
    expect((await f.control.command(send)).error).toBeNull()
    expect(f.host.received.map(digestOf)).toEqual([image.digest, image.digest])
    // The provider's answer names the message; the preview is the content's next owner.
    const message = f.control.get().host.threads.find(thread => thread.id === 'workshop')!.messages.at(-1)!
    expect(await f.control.attachmentPreview({ threadId: 'workshop', messageId: message.id, attachmentId: image.id }))
      .toEqual({ dataUrl: `data:image/png;base64,${bytes.toString('base64')}` })
  })
  it('sends a queued image with its digest after a restart and a resumed queue', async () => {
    const f = await fixture()
    const bytes = pngOfSize(32 * 1024, 7)
    const image = await f.stage(bytes)
    f.host.update('workshop', { status: 'running', lastTurn: { id: 'running-turn', status: 'running' } })
    await f.control.command({ type: 'queue-followup', threadId: 'workshop', draftId: randomUUID(), text: '', attachments: [image] })
    await f.restart()
    f.host.update('workshop', { status: 'idle', lastTurn: { id: 'running-turn', status: 'interrupted' } })
    await expect.poll(() => f.control.get().followups?.[0]?.status).toBe('paused')
    await f.control.command({ type: 'resume-followups', threadId: 'workshop' })
    await expect.poll(() => f.host.received.length).toBe(1)
    expect(digestOf(f.host.received[0]!)).toBe(image.digest)
  })
  it('releases content that clearing, cancelling and removing leave unowned, a grace period later, and keeps what is still owned', async () => {
    const f = await fixture()
    const cleared = await f.stage(pngOfSize(1024, 1), 'Cleared.png')
    const cancelled = await f.stage(pngOfSize(1024, 2), 'Cancelled.png')
    const removed = await f.stage(pngOfSize(1024, 3), 'Removed.png')
    const queued = await f.stage(pngOfSize(1024, 4), 'Queued.png')
    const sent = await f.stage(pngOfSize(1024, 8), 'Sent.png')
    await f.control.command({ type: 'save-thread-draft', threadId: 'docs', draftId: randomUUID(), text: 'Draft', attachments: [cleared], requestId: null })
    await f.control.command({ type: 'save-thread-draft', threadId: 'docs', draftId: randomUUID(), text: '', attachments: [], requestId: null })
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: 'Coordinator draft', attachments: [cancelled] })
    await f.control.command({ type: 'cancel-draft' })
    await f.control.command({ type: 'manual-send', threadId: 'workshop', text: 'Sent', attachments: [sent] })
    await f.control.command({ type: 'queue-followup', threadId: 'workshop', draftId: randomUUID(), text: 'One', attachments: [removed] })
    await f.control.command({ type: 'queue-followup', threadId: 'workshop', draftId: randomUUID(), text: 'Two', attachments: [queued] })
    const item = f.control.get().followups!.find(entry => entry.text === 'One')!
    await f.control.command({ type: 'remove-followup', threadId: 'workshop', itemId: item.id })
    // Unowned, but inside the grace period, nothing goes: a refused prompt could still come back to its composer.
    await f.control.privacyChanged()
    expect(await f.files()).toHaveLength(5)
    await afterGrace(f.control)
    expect((await f.files()).sort()).toEqual([`${queued.digest}.png`, `${sent.digest}.png`].sort())
  })
  it('finds and prunes an image staged just before a crash, whose draft was never saved', async () => {
    const f = await fixture()
    const orphan = await f.stage(pngOfSize(2048, 9))
    await f.crash()
    expect(await f.files()).toEqual([`${orphan.digest}.png`])
    await afterGrace(f.control)
    expect(await f.files()).toEqual([])
    expect(JSON.parse(await f.disk('attachments/index.json')).entries).toEqual([])
  })
  it('stages images an earlier version saved inline and rewrites them as handles', async () => {
    const f = await fixture()
    const bytes = pngOfSize(4096, 10)
    const inline = { id: 'legacy', name: 'Legacy.png', mimeType: 'image/png', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }
    const saved = JSON.parse(await f.disk('agents.json'))
    // Earlier versions saved an inline image unchecked; one that is not an image is dropped rather than stopping start.
    const broken = { ...inline, id: 'broken', dataUrl: 'data:image/png;base64,YWJj' }
    saved.threadDrafts = [{ threadId: 'docs', draftId: randomUUID(), text: 'Old draft', attachments: [inline, broken], requestId: null, updatedAt: new Date().toISOString() }]
    f.control.dispose()
    await writeFile(join(f.root, 'agents.json'), JSON.stringify(saved))
    const now = new Date().toISOString()
    await writeFile(join(f.root, 'followups.json'), JSON.stringify({ items: [{ id: randomUUID(), threadId: 'workshop', draftId: randomUUID(), text: 'Old follow-up', attachments: [inline],
      createdAt: now, updatedAt: now, status: 'paused', error: 'Paused before the upgrade.' },
    // A queued follow-up that loses its image this way is paused, never sent without it.
    { id: randomUUID(), threadId: 'workshop', draftId: randomUUID(), text: 'Broken follow-up', attachments: [broken],
      createdAt: now, updatedAt: now, status: 'queued' }], receipts: [] }))
    await f.crash()
    const handle: AgentAttachmentHandle = { ...handleOf(bytes, 'legacy', 'Legacy.png') }
    expect(f.control.get().threadDrafts).toEqual([expect.objectContaining({ threadId: 'docs', attachments: [handle] })])
    expect(f.control.get().followups).toEqual([expect.objectContaining({ text: 'Old follow-up', attachments: [handle] }),
      expect.objectContaining({ text: 'Broken follow-up', attachments: [], status: 'paused', error: LOST_IMAGES })])
    for (const name of ['agents.json', 'followups.json']) expect(await f.disk(name)).not.toContain(trace(bytes))
    expect(await f.files()).toEqual([`${handle.digest}.png`])
  })
  it('keeps a draft’s image in memory while history is off; after a restart the draft comes back without it and a queued follow-up is paused', async () => {
    const f = await fixture(); f.setHistory(false)
    const image = await f.stage(pngOfSize(2048, 11))
    await f.control.command({ type: 'save-thread-draft', threadId: 'docs', draftId: randomUUID(), text: 'Private draft', attachments: [image], requestId: null })
    f.host.update('workshop', { status: 'running' })
    await f.control.command({ type: 'queue-followup', threadId: 'workshop', draftId: randomUUID(), text: 'Queued', attachments: [image] })
    expect(await f.files()).toEqual([])
    await f.crash()
    expect(f.control.get().threadDrafts).toEqual([expect.objectContaining({ threadId: 'docs', text: 'Private draft', attachments: [] })])
    expect(f.control.get().followups).toEqual([expect.objectContaining({ text: 'Queued', attachments: [], status: 'paused', error: LOST_IMAGES })])
  })
  it('removes at once, when history is turned off, the content only previews kept, and nothing a draft or a pending attach needs', async () => {
    const f = await fixture()
    const sent = await f.stage(pngOfSize(1024, 13), 'Sent.png')
    const drafted = await f.stage(pngOfSize(1024, 14), 'Drafted.png')
    await f.control.command({ type: 'manual-send', threadId: 'workshop', text: 'Sent', attachments: [sent] })
    await expect.poll(async () => (await f.disk('attachment-previews.json')).includes(sent.digest)).toBe(true)
    await f.control.command({ type: 'save-thread-draft', threadId: 'docs', draftId: randomUUID(), text: 'Draft', attachments: [drafted], requestId: null })
    // Staged a moment ago for a draft the window has not saved yet.
    const pending = await f.stage(pngOfSize(1024, 15), 'Pending.png')
    f.setHistory(false)
    await f.control.privacyChanged()
    expect((await f.files()).sort()).toEqual([`${drafted.digest}.png`, `${pending.digest}.png`].sort())
  })
  it('keeps, when history is turned off, content a preview names that was attached again since for a draft not saved yet', async () => {
    const f = await fixture()
    const bytes = pngOfSize(1024, 20)
    const sent = await f.stage(bytes, 'Sent.png')
    await f.control.command({ type: 'manual-send', threadId: 'workshop', text: 'Sent', attachments: [sent] })
    await expect.poll(async () => (await f.disk('attachment-previews.json')).includes(sent.digest)).toBe(true)
    // A moment later the user attaches the same screenshot to another draft, and turns history off before it is saved.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000)
    const again = await f.stage(bytes, 'Again.png')
    f.setHistory(false)
    await f.control.privacyChanged()
    expect(await f.files()).toEqual([`${sent.digest}.png`])
    const saved = await f.control.command({ type: 'save-thread-draft', threadId: 'docs', draftId: randomUUID(), text: 'Again', attachments: [again], requestId: null })
    expect(saved.error).toBeNull()
    expect(saved.threadDrafts).toEqual([expect.objectContaining({ threadId: 'docs', attachments: [again] })])
  })
  it('keeps an image an earlier version saved inline in a draft across restarts while history is off', async () => {
    const f = await fixture(); f.setHistory(false)
    const bytes = pngOfSize(4096, 21)
    const inline = { id: 'legacy', name: 'Legacy.png', mimeType: 'image/png', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }
    const saved = JSON.parse(await f.disk('agents.json'))
    saved.threadDrafts = [{ threadId: 'docs', draftId: randomUUID(), text: 'Old draft', attachments: [inline], requestId: null, updatedAt: new Date().toISOString() }]
    f.control.dispose()
    await writeFile(join(f.root, 'agents.json'), JSON.stringify(saved))
    await f.crash()
    const handle: AgentAttachmentHandle = { ...handleOf(bytes, 'legacy', 'Legacy.png') }
    expect(f.control.get().threadDrafts).toEqual([expect.objectContaining({ threadId: 'docs', attachments: [handle] })])
    // Those bytes were on disk already, inside agents.json; moving them to the store is not new content reaching disk.
    expect(await f.files()).toEqual([`${handle.digest}.png`])
    await f.crash()
    expect(f.control.get().threadDrafts).toEqual([expect.objectContaining({ threadId: 'docs', attachments: [handle] })])
  })
  it('saves a draft’s text without an image no longer kept, and says so', async () => {
    const f = await fixture()
    const kept = await f.stage(pngOfSize(512, 16))
    const gone = handleOf(pngOfSize(64, 17))
    const result = await f.control.command({ type: 'save-thread-draft', threadId: 'docs', draftId: randomUUID(), text: 'Typed after the hour', attachments: [kept, gone], requestId: null })
    expect(result.error).toBe(DRAFT_IMAGE_NOT_SAVED)
    expect(result.threadDrafts).toEqual([expect.objectContaining({ threadId: 'docs', text: 'Typed after the hour', attachments: [kept] })])
    expect(await f.disk('agents.json')).toContain('Typed after the hour')
  })
  it.each(['missing', 'corrupt'] as const)('refuses a send with %s content, then sends the same image attached again', async condition => {
    const f = await fixture()
    const bytes = pngOfSize(1024, 18)
    const image = await f.stage(bytes)
    const file = join(f.root, 'attachments', `${image.digest}.png`)
    if (condition === 'missing') await rm(file)
    else await writeFile(file, pngOfSize(1024, 19))
    const draftId = randomUUID()
    const result = await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Look', attachments: [image] })
    expect(result.error).toBe(MISSING_ATTACHMENT)
    expect(f.host.received).toEqual([])
    expect(result.deliveries).toEqual([expect.objectContaining({ draftId, status: 'failed' })])
    const again = await f.stage(bytes)
    expect(again.digest).toBe(image.digest)
    expect(again.id).not.toBe(image.id)
    const retry = await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId: randomUUID(), text: 'Look', attachments: [again] })
    expect(retry.error).toBeNull()
    expect(f.host.received).toEqual([bytes])
  })
  it('refuses a command naming content this host does not keep, before anything is sent', async () => {
    const f = await fixture()
    const draftId = randomUUID()
    const result: AgentState = await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Look', attachments: [handleOf(pngOfSize(64, 12))] })
    expect(result.error).toBe(MISSING_ATTACHMENT)
    expect(f.host.attempts).toEqual([])
    expect(result.deliveries).toEqual([expect.objectContaining({ draftId, status: 'failed' })])
  })
})
