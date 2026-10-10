// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentPreviews, ATTACHMENT_PREVIEW_RETENTION_MS, MAX_ATTACHMENT_PREVIEW_BYTES } from '../../../src/main/agents/attachmentPreviews'
import { AttachmentStore, inlineStager } from '../../../src/main/agents/attachmentStore'
import { AgentControl } from '../../../src/main/agents/control'

import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import type { AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { agentAttachmentPreviewSchema, type AgentAttachmentHandle, type AgentHostSnapshot } from '../../../src/shared/agents'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { handleOf, PIXEL_DATA_URL, PIXEL_PNG, stageInto } from '../../fixtures/stagedImages'
import { testCredentials } from '../../fixtures/testCredentials'
import { createAgentControl } from '../../fixtures/agentControlFixture'

const image = handleOf(PIXEL_PNG, 'image', 'Screenshot.png')
/** The preview store over a real attachment store on `root`, with the pixel image staged in it. */
async function previews(root: string, historyEnabled: () => boolean = () => true, now: () => number = Date.now) {
  const content = new AttachmentStore(root, { historyEnabled, now }); await content.load()
  await stageInto(content, PIXEL_PNG)
  const store = new AttachmentPreviews(root, content, historyEnabled, now); await store.load()
  return store
}
/** A handle the preview store can count without any bytes behind it. */
const sized = (id: string, sizeBytes: number, seed: string): AgentAttachmentHandle => ({ id, name: `${id}.png`, mimeType: 'image/png', sizeBytes, digest: seed.repeat(64) })
const roots: string[] = []
const controls = new Set<AgentControl>()
afterEach(async () => {
  for (const control of controls) { control.dispose(); await control.privacyChanged() }
  controls.clear(); vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-previews-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-previews-')); roots.push(root); return root
}
async function saved(root: string) { return JSON.parse(await readFile(join(root, 'attachment-previews.json'), 'utf8')) }
async function snapshot() {
  const state = await new E2EAgentHost().snapshot()
  state.threads[0]!.messages = [{ id: 'message', commandId: 'command', role: 'user', text: '', createdAt: new Date().toISOString() }]
  return state
}
function attachment(state: AgentHostSnapshot) { return state.threads[0]!.messages[0]?.attachments?.[0] }

describe('app-owned submitted attachment previews', () => {
  it('restores bytes and useful metadata on exact user identity, without changing host history or needing a provider connection', async () => {
    const root = await directory()
    const store = await previews(root)
    await store.remember('workshop', 'message', 'command', [image])
    const restarted = await previews(root)
    const source = await snapshot(); source.connected = false
    const decorated = structuredClone(source); restarted.decorate(decorated)
    expect(attachment(source)).toBeUndefined()
    // The published state says a preview exists; its bytes stay in main until the window asks for them.
    expect(attachment(decorated)).toEqual({ id: image.id, name: image.name, mimeType: image.mimeType, sizeBytes: 68, preview: { available: true } })
    expect(JSON.stringify(decorated)).not.toContain(PIXEL_PNG.toString('base64'))
    // The file names the staged image; its bytes are the attachment store's.
    expect(JSON.stringify(await saved(root))).not.toContain(PIXEL_PNG.toString('base64'))
    expect(await restarted.preview(source, 'workshop', 'message', image.id)).toBe(PIXEL_DATA_URL)
    expect(await restarted.preview(source, 'workshop', 'message', 'other')).toBeNull()
    expect(decorated.threads[0]!.id).toBe('workshop')
    expect(decorated.threads[0]!.messages[0]!.id).toBe('message')
    for (const change of ['thread', 'message', 'command', 'role'] as const) {
      const other = structuredClone(source)
      if (change === 'thread') other.threads[0]!.id = 'different'
      if (change === 'message') other.threads[0]!.messages[0]!.id = 'different'
      if (change === 'command') other.threads[0]!.messages[0]!.commandId = 'different'
      if (change === 'role') other.threads[0]!.messages[0]!.role = 'assistant'
      restarted.decorate(other); expect(attachment(other)).toBeUndefined()
      // The read path answers only where decoration would have placed a marker.
      expect(await restarted.preview(other, other.threads[0]!.id, other.threads[0]!.messages[0]!.id, image.id)).toBeNull()
    }
  })
  it('never turns provider markup, paths, URLs or forged previews into file reads; preserves metadata-only files', async () => {
    const root = await directory(); const store = await previews(root)
    const state = await snapshot()
    state.threads[0]!.messages[0]!.text = '![secret](file:///C:/secret.png) <img src="../../secret.png">'
    state.threads[0]!.messages[0]!.attachments = [{ id: '../../secret.png', name: '<script>alert(1)</script>.pdf', mimeType: 'application/pdf', sizeBytes: 99,
      preview: { dataUrl: PIXEL_DATA_URL } }]
    store.decorate(state)
    expect(attachment(state)).toEqual({ id: '../../secret.png', name: '<script>alert(1)</script>.pdf', mimeType: 'application/pdf', sizeBytes: 99 })
    expect((await saved(root)).entries).toEqual([])
    for (const dataUrl of ['file:///C:/secret.png', 'https://example.test/a.png', 'javascript:alert(1)',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:image/png;base64,PHN2Zz48L3N2Zz4=',
      PIXEL_DATA_URL.replace('image/png', 'image/jpeg'), PIXEL_DATA_URL + '\n']) {
      expect(agentAttachmentPreviewSchema.safeParse({ dataUrl }).success).toBe(false)
    }
    // A handle is a name for staged content: a path, a URL or another type in its place is refused.
    for (const forged of [{ ...image, digest: '../../secret.png' }, { ...image, digest: 'https://example.test/a.png' },
      { ...image, mimeType: 'image/svg+xml' }, { ...image, sizeBytes: 0 }, { ...image, dataUrl: PIXEL_DATA_URL }]) {
      await expect(store.remember('thread', 'bad', 'command', [forged as AgentAttachmentHandle])).rejects.toThrow()
    }
    expect((await saved(root)).entries).toEqual([])
  })
  it('expires from original submission and rejects reuse of an identity for different bytes', async () => {
    const root = await directory(); let now = 1_800_000_000_000
    const store = await previews(root, () => true, () => now)
    await store.remember('workshop', 'message', 'command', [image])
    now += ATTACHMENT_PREVIEW_RETENTION_MS - 1
    await store.remember('workshop', 'message', 'command', [image])
    await expect(store.remember('workshop', 'message', 'other', [image])).rejects.toThrow(/already owns/)
    await expect(store.remember('workshop', 'message', 'command', [{ ...image, name: 'replacement.png' }])).rejects.toThrow(/already owns/)
    const live = await snapshot(); store.decorate(live); expect(attachment(live)?.preview).toEqual({ available: true })
    expect(await store.preview(live, 'workshop', 'message', image.id)).toBe(PIXEL_DATA_URL)
    now += 1
    const expired = await snapshot(); store.decorate(expired); expect(attachment(expired)).toBeUndefined()
    expect(await store.preview(expired, 'workshop', 'message', image.id)).toBeNull()
    expect(store.digests()).toEqual(new Set())
    await store.maintain(); expect((await saved(root)).entries).toEqual([])
  })
  it('bounds retained content to 100 MiB and evicts the oldest submission first', async () => {
    const root = await directory(); let now = 1_800_000_000_000
    const store = await previews(root, () => true, () => now)
    // The limit counts the handles' sizes; none of these needs bytes behind it to be counted.
    const writing = vi.spyOn(AtomicJsonStore.prototype, 'write').mockResolvedValue(undefined)
    const size = 10 * 1024 * 1024
    for (let i = 0; i < 11; i++) {
      now += 1
      await store.remember('workshop', i === 0 ? 'message' : `message-${i}`, 'command', [sized('image', size, i.toString(16))])
    }
    const oldest = await snapshot(); store.decorate(oldest); expect(attachment(oldest)).toBeUndefined()
    const latest = await snapshot(); latest.threads[0]!.messages[0]!.id = 'message-10'
    store.decorate(latest); expect(attachment(latest)?.sizeBytes).toBe(size)
    expect(writing.mock.calls.at(-1)![0]).toMatchObject({ version: 2, entries: expect.any(Array) })
    expect((writing.mock.calls.at(-1)![0] as { entries: unknown[] }).entries).toHaveLength(MAX_ATTACHMENT_PREVIEW_BYTES / size)
    expect(store.digests().has('0'.repeat(64))).toBe(false)
  })
  it('clears old previews when history is disabled and never retroactively persists history-off submissions', async () => {
    const root = await directory(); let enabled = true
    const store = await previews(root, () => enabled)
    await store.remember('workshop', 'message', 'command', [image])
    enabled = false
    const redacted = await snapshot(); store.decorate(redacted); expect(attachment(redacted)).toBeUndefined()
    expect(await store.preview(redacted, 'workshop', 'message', image.id)).toBeNull()
    await store.maintain(); expect((await saved(root)).entries).toEqual([])
    await store.remember('workshop', 'message', 'command', [image])
    const current = await snapshot(); store.decorate(current); expect(attachment(current)?.preview).toBeDefined()
    expect((await saved(root)).entries).toEqual([])
    enabled = true; await store.maintain()
    expect((await saved(root)).entries).toEqual([])
    const restarted = await previews(root)
    const history = await snapshot(); restarted.decorate(history); expect(attachment(history)).toBeUndefined()
  })
  it('discards corrupt/private cache without backup copies and sanitizes individually invalid records', async () => {
    const root = await directory(); const path = join(root, 'attachment-previews.json')
    await writeFile(path, '{private bytes, broken JSON')
    const content = new AttachmentStore(root); await content.load()
    const store = new AttachmentPreviews(root, content); await store.load()
    expect(await readdir(root)).toEqual(['attachment-previews.json'])
    expect((await saved(root)).entries).toEqual([])
    // Version 1 kept the bytes inline: they are staged, and the file keeps only the handle.
    const inline = { id: image.id, name: image.name, mimeType: image.mimeType, dataUrl: PIXEL_DATA_URL }
    await writeFile(path, JSON.stringify({ version: 1, entries: [
      { threadId: 'workshop', messageId: 'message', commandId: 'command', storedAt: Date.now(), attachments: [inline] },
      { threadId: 'workshop', messageId: 'unsafe', commandId: 'unsafe', storedAt: Date.now(), attachments: [{ ...inline, dataUrl: 'file:///private' }] },
    ] }))
    await store.load(inlineStager(content))
    expect(await saved(root)).toEqual({ version: 2, entries: [expect.objectContaining({ messageId: 'message', attachments: [image] })] })
    expect(content.has(image.digest)).toBe(true)
    const state = await snapshot(); expect(await store.preview(state, 'workshop', 'message', image.id)).toBe(PIXEL_DATA_URL)
    const disabled = new AttachmentPreviews(root, content, () => false); await disabled.load()
    expect((await saved(root)).entries).toEqual([])
  })
  it('removes only its generated crash temporary files on startup', async () => {
    const root = await directory()
    await writeFile(join(root, 'attachment-previews.json.tmp-123-11111111-1111-4111-8111-111111111111'), PIXEL_DATA_URL)
    await writeFile(join(root, 'agents.json.tmp-123-11111111-1111-4111-8111-111111111111'), 'other store')
    await writeFile(join(root, 'attachment-previews.json.tmp-personal'), 'unrelated file')
    await new AttachmentPreviews(root, new AttachmentStore(root, { historyEnabled: () => false }), () => false).load()
    expect(await readdir(root)).toEqual(expect.arrayContaining(['attachment-previews.json', 'attachment-previews.json.tmp-personal',
      'agents.json.tmp-123-11111111-1111-4111-8111-111111111111']))
    expect(await readdir(root)).toHaveLength(3)
  })
  it('hides previews immediately on privacy changes and retries failed disk redaction', async () => {
    const root = await directory(); let enabled = true
    const store = await previews(root, () => enabled)
    await store.remember('workshop', 'message', 'command', [image])
    enabled = false
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockRejectedValueOnce(new Error('Storage unavailable'))
    await expect(store.maintain()).rejects.toThrow('Storage unavailable')
    const state = await snapshot(); store.decorate(state); expect(attachment(state)).toBeUndefined()
    await store.maintain(); expect((await saved(root)).entries).toEqual([])
  })
})

class FixtureHost extends E2EAgentHost {
  attempts: AgentHostCommand[] = []
  outcome: 'normal' | 'uncertain' | 'reject' | 'throw' = 'normal'
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    this.attempts.push(command)
    if (this.outcome === 'uncertain') return { accepted: false, uncertain: true }
    if (this.outcome === 'reject') return { accepted: false }
    if (this.outcome === 'throw') throw new Error('Definitive rejection')
    return super.execute(command)
  }
  async acknowledge() { await super.execute(this.attempts.at(-1)!) }
}
async function fixture() {
  const root = await directory(); const host = new FixtureHost(); let enabled = true
  const credentials = await testCredentials(root, { mode: 'unavailable' })

  const create = () => {
    const control = createAgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner, historyEnabled: () => enabled,
    })
    controls.add(control); return control
  }
  let control = create(); await control.start(); await stageInto(control, PIXEL_PNG); await control.command({ type: 'connect' })
  return { root, host, get control() { return control }, async disableHistory() { enabled = false; await control.privacyChanged() },
    async restart() { control.dispose(); await control.privacyChanged(); controls.delete(control); control = create(); await control.start() } }
}
const send = { type: 'manual-send' as const, threadId: 'workshop', text: '', attachments: [image] }

/** Every value the preview store is asked to write, so a test can say nothing reached its file. */
function previewWrites() {
  const writes: { entries: unknown[] }[] = []
  const write = AtomicJsonStore.prototype.write
  vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function (this: AtomicJsonStore<unknown>, value: unknown) {
    if ((this as unknown as { filePath: string }).filePath.endsWith('attachment-previews.json')) writes.push(structuredClone(value) as { entries: unknown[] })
    await write.call(this, value)
  })
  return writes
}

describe('coordinator attachment dispatch boundary', () => {
  it('sends the prompt when the preview cannot be saved, and shows that preview as unavailable', async () => {
    const f = await fixture()
    const write = AtomicJsonStore.prototype.write
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function (this: AtomicJsonStore<unknown>, value: unknown) {
      if ((this as unknown as { filePath: string }).filePath.endsWith('attachment-previews.json') && typeof value === 'object' && value !== null && 'entries' in value
        && Array.isArray(value.entries) && value.entries.length) throw new Error('Synthetic storage failure')
      await write.call(this, value)
    })
    expect((await f.control.command(send)).error).toBeNull()
    expect(f.host.attempts).toHaveLength(1)
    const messageId = f.control.get().host.threads[0]!.messages.at(-1)!.id
    await vi.waitFor(async () => expect(await f.control.attachmentPreview({ threadId: 'workshop', messageId, attachmentId: image.id })).toBeNull())
    expect(attachment(f.control.get().host)?.preview).toBeUndefined()
    expect((await saved(f.root)).entries).toEqual([])
  })
  it('records previews only once the provider has the prompt, and reconciles uncertain delivery once after restart', async () => {
    const f = await fixture(); f.host.outcome = 'uncertain'
    const execute = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementation(async command => {
      // The provider hears the prompt before the preview store is written.
      expect((await saved(f.root)).entries).toEqual([])
      return execute(command)
    })
    expect((await f.control.command(send)).error).toMatch(/confirm/)
    expect(attachment(f.control.get().host)).toBeUndefined()
    await vi.waitFor(async () => expect((await saved(f.root)).entries[0]).toMatchObject({ threadId: 'workshop', attachments: [image] }))
    await f.restart()
    expect((await f.control.command(send)).error).toMatch(/unknown result/)
    await f.host.acknowledge()
    expect(attachment(f.control.get().host)?.preview).toEqual({ available: true })
    const messageId = f.control.get().host.threads[0]!.messages[0]!.id
    expect(await f.control.attachmentPreview({ threadId: 'workshop', messageId, attachmentId: image.id })).toEqual({ dataUrl: PIXEL_DATA_URL })
    expect(await f.control.attachmentPreview({ threadId: 'workshop', messageId: 'unknown', attachmentId: image.id })).toBeNull()
    expect(attachment(await f.host.snapshot())?.preview).toBeUndefined()
    expect(f.control.get().draftAttachments).toEqual([])
    expect(f.host.attempts).toHaveLength(1)
    await f.restart(); await f.control.command({ type: 'connect' })
    expect(attachment(f.control.get().host)?.preview).toBeDefined()
  })
  it('sends the preview marker to a window that already holds the echoed message', async () => {
    const f = await fixture()
    // The fixture provider echoes the user message before execute returns, as a native adapter can.
    const held = new Map<string, AgentHostSnapshot['threads'][number]['messages'][number]>()
    f.control.subscribeThreadDetail(update => {
      if (update.threadId !== 'workshop') return
      if ('messages' in update) { held.clear(); for (const message of update.messages) held.set(message.id, message) }
      else for (const item of update.messageDeltas) if ('message' in item) held.set(item.message.id, item.message)
    })
    await f.control.command({ type: 'observe-threads', threadIds: ['workshop'] })
    expect((await f.control.command(send)).error).toBeNull()
    const messageId = f.control.get().host.threads[0]!.messages.at(-1)!.id
    expect(held.get(messageId)?.attachments?.[0]?.preview).toEqual({ available: true })
  })
  it.each(['reject', 'throw'] as const)('writes nothing to the preview store after a definitive provider %s and keeps the unsent draft', async outcome => {
    const f = await fixture(); f.host.outcome = outcome
    const writes = previewWrites()
    expect((await f.control.command(send)).error).toMatch(/reject/i)
    expect(f.host.attempts).toHaveLength(1)
    // Anything the store had queued lands before this cleanup finishes.
    await f.control.privacyChanged()
    expect(writes.filter(value => value.entries.length)).toEqual([])
    expect((await saved(f.root)).entries).toEqual([])
    expect(f.control.get().draftAttachments).toEqual([image])
  })
  it('preserves capability validation, cleans history-off previews, and retains the explicit unsent-draft exception', async () => {
    const f = await fixture()
    const original = await f.host.snapshot()
    vi.spyOn(f.host, 'snapshot').mockResolvedValue({ ...original, models: original.models.map(model => ({ ...model, supportsImages: false })) })
    expect((await f.control.command(send)).error).toMatch(/image support/)
    expect(f.host.attempts).toEqual([]); expect((await saved(f.root)).entries).toEqual([])
    vi.restoreAllMocks()
    f.host.outcome = 'uncertain'; await f.control.command(send)
    await vi.waitFor(async () => expect((await saved(f.root)).entries).toHaveLength(1))
    await f.disableHistory()
    expect((await saved(f.root)).entries).toEqual([])
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).draftAttachments).toEqual([image])
    await f.host.acknowledge()
    expect(attachment(f.control.get().host)?.preview).toBeUndefined()
  })
})
