// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentPreviews } from '../../../src/main/agents/attachmentPreviews'
import { AttachmentStore, RefusedImage } from '../../../src/main/agents/attachmentStore'
import type { AgentControl } from '../../../src/main/agents/control'
import type { AgentHost, AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import { validatePromptAttachments } from '../../../src/main/agents/threadOptions'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { ATTACHED_FILE_TOO_LARGE, ATTACHED_FILES_NEED_A_FOLDER, SCREENSHOT_NOT_ITS_TYPE, SCREENSHOT_TOO_LARGE, SCREENSHOT_WRONG_TYPE,
  type AgentAttachmentHandle, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'
import { createAgentControl } from '../../fixtures/agentControlFixture'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { handleOf, PIXEL_PNG } from '../../fixtures/stagedImages'
import { testCredentials } from '../../fixtures/testCredentials'

const roots: string[] = []; const controls: AgentControl[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const control of controls.splice(0)) { control.dispose(); await control.privacyChanged().catch(() => undefined) }
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-files-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})
async function directory() { const root = await mkdtemp(join(tmpdir(), 'sotto-files-')); roots.push(root); return root }
const MB = 1024 * 1024
const pdf = { name: 'quarterly-report.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.7 not inspected') }
const digestOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const index = async (root: string) => JSON.parse(await readFile(join(root, 'attachments', 'index.json'), 'utf8')) as { entries: { digest: string; mimeType: string }[] }

describe('the attachment store with attached files (ADR-0131)', () => {
  it('keeps the type each handle was attached as when the same bytes are an image and then a file', async () => {
    const root = await directory(); const store = new AttachmentStore(root, { acceptsFiles: true }); await store.load()
    const image = await store.stage({ name: 'shot.png', mimeType: 'image/png', bytes: PIXEL_PNG })
    const file = await store.stage({ name: 'data.bin', mimeType: 'application/octet-stream', bytes: PIXEL_PNG })
    expect(file).toMatchObject({ mimeType: 'application/octet-stream', digest: image.digest })
    expect(() => store.verify([image, file])).not.toThrow()
    expect(store.keeps(file)).toBe(true)
    // The content stays the image it was checked as, so the image's chip and preview still read it.
    expect(store.mimeType(image.digest)).toBe('image/png')
    expect(await store.read(file.digest)).toEqual(PIXEL_PNG)
    // A file handle on a model without image support is a file, which goes by path.
    const snapshot = { models: [{ id: 'text', name: 'Text', provider: 'Grok', ready: true, runtimeModes: [], supportsImages: false }] } as unknown as AgentHostSnapshot
    expect(() => validatePromptAttachments(snapshot, 'text', [file], { workingDirectory: root })).not.toThrow()
    expect(() => validatePromptAttachments(snapshot, 'text', [image], { workingDirectory: root })).toThrow()
  })

  it('keeps bytes first staged as a file as the image they are once they are attached as one', async () => {
    const root = await directory(); const store = new AttachmentStore(root, { acceptsFiles: true }); await store.load()
    const file = await store.stage({ name: 'data.bin', mimeType: 'application/octet-stream', bytes: PIXEL_PNG })
    const image = await store.stage({ name: 'shot.png', mimeType: 'image/png', bytes: PIXEL_PNG })
    expect(image.mimeType).toBe('image/png')
    expect(store.mimeType(file.digest)).toBe('image/png')
    expect(() => store.verify([file, image])).not.toThrow()
    expect((await readdir(join(root, 'attachments'))).filter(name => name !== 'index.json').sort()).toEqual([`${file.digest}.png`])
    expect(await index(root)).toMatchObject({ entries: [{ digest: file.digest, mimeType: 'image/png' }] })
    expect(await store.read(file.digest)).toEqual(PIXEL_PNG)
    const restarted = new AttachmentStore(root, { acceptsFiles: true }); await restarted.load()
    expect(() => restarted.verify([file, image])).not.toThrow()
    expect(await restarted.read(image.digest)).toEqual(PIXEL_PNG)
  })

  it('still refuses an image handle whose type the kept content does not have', async () => {
    const root = await directory(); const store = new AttachmentStore(root, { acceptsFiles: true }); await store.load()
    const image = await store.stage({ name: 'shot.png', mimeType: 'image/png', bytes: PIXEL_PNG })
    expect(() => store.verify([{ ...image, mimeType: 'image/jpeg' }])).toThrow()
    expect(() => store.verify([{ ...image, mimeType: 'application/octet-stream', sizeBytes: image.sizeBytes + 1 }])).toThrow()
  })

  it('keeps a file as <digest>.bin with its type in the index, without reading its bytes, and finds it again after a restart', async () => {
    const root = await directory(); const store = new AttachmentStore(root, { acceptsFiles: true }); await store.load()
    const handle = await store.stage(pdf)
    expect(handle).toEqual({ id: handle.id, name: 'quarterly-report.pdf', mimeType: 'application/pdf', sizeBytes: pdf.bytes.byteLength, digest: digestOf(pdf.bytes) })
    expect(await readFile(join(root, 'attachments', `${handle.digest}.bin`))).toEqual(pdf.bytes)
    expect((await index(root)).entries).toEqual([expect.objectContaining({ digest: handle.digest, mimeType: 'application/pdf' })])
    expect(JSON.stringify(await index(root))).not.toContain('quarterly')
    const restarted = new AttachmentStore(root, { acceptsFiles: true }); await restarted.load()
    expect(restarted.mimeType(handle.digest)).toBe('application/pdf')
    expect(restarted.keeps(handle)).toBe(true)
    expect(await restarted.read(handle.digest)).toEqual(pdf.bytes)
  })

  it('takes a file of no particular type, and one whose index entry was lost comes back as that', async () => {
    const root = await directory(); const store = new AttachmentStore(root, { acceptsFiles: true }); await store.load()
    const handle = await store.stage({ name: 'blob', mimeType: 'application/octet-stream', bytes: Buffer.from([0, 1, 2]) })
    const text = await store.stage({ name: 'notes.txt', mimeType: 'text/plain', bytes: Buffer.from('Notes') })
    await writeFile(join(root, 'attachments', 'index.json'), JSON.stringify({ version: 1, entries: [] }))
    const restarted = new AttachmentStore(root, { acceptsFiles: true }); await restarted.load()
    expect(restarted.mimeType(handle.digest)).toBe('application/octet-stream')
    expect(restarted.mimeType(text.digest)).toBe('application/octet-stream')
  })

  it('holds files to 25 MiB and images to their own rules', async () => {
    const root = await directory(); const store = new AttachmentStore(root, { acceptsFiles: true }); await store.load()
    await expect(store.stage({ name: 'big.zip', mimeType: 'application/zip', bytes: Buffer.alloc(25 * MB, 1) })).resolves.toMatchObject({ sizeBytes: 25 * MB })
    await expect(store.stage({ name: 'bigger.zip', mimeType: 'application/zip', bytes: Buffer.alloc(25 * MB + 1, 1) })).rejects.toThrow(ATTACHED_FILE_TOO_LARGE)
    await expect(store.stage({ name: 'big.png', mimeType: 'image/png', bytes: Buffer.alloc(10 * MB + 1, 1) })).rejects.toThrow(SCREENSHOT_TOO_LARGE)
    await expect(store.stage({ name: 'fake.png', mimeType: 'image/png', bytes: Buffer.from('not a png') })).rejects.toThrow(SCREENSHOT_NOT_ITS_TYPE)
    await expect(store.stage({ name: 'odd', mimeType: 'Not/A Type', bytes: Buffer.from('x') })).rejects.toThrow(SCREENSHOT_WRONG_TYPE)
  })

  it('refuses every file that is not an image while the Owl feature is off, as before', async () => {
    const root = await directory(); const store = new AttachmentStore(root); await store.load()
    await expect(store.stage(pdf)).rejects.toBeInstanceOf(RefusedImage)
    await expect(store.stage(pdf)).rejects.toThrow(SCREENSHOT_WRONG_TYPE)
    await expect(readdir(join(root, 'attachments'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(store.stage({ name: 'pixel.png', mimeType: 'image/png', bytes: PIXEL_PNG })).resolves.toMatchObject({ mimeType: 'image/png' })
  })

  it('records a sent file in a preview for its tile, with no preview to ask for and none of its bytes owned', async () => {
    const root = await directory(); const content = new AttachmentStore(root, { acceptsFiles: true }); await content.load()
    const file = await content.stage(pdf)
    const image = await content.stage({ name: 'pixel.png', mimeType: 'image/png', bytes: PIXEL_PNG })
    const previews = new AttachmentPreviews(root, content); await previews.load()
    await previews.remember('workshop', 'message', 'command', [image, file])
    const state = await new E2EAgentHost().snapshot()
    state.threads[0]!.messages = [{ id: 'message', commandId: 'command', role: 'user', text: '', createdAt: new Date().toISOString() }]
    previews.decorate(state)
    expect(state.threads[0]!.messages[0]!.attachments).toEqual([
      { id: image.id, name: 'pixel.png', mimeType: 'image/png', sizeBytes: PIXEL_PNG.byteLength, preview: { available: true } },
      { id: file.id, name: 'quarterly-report.pdf', mimeType: 'application/pdf', sizeBytes: pdf.bytes.byteLength },
    ])
    expect(await previews.preview(state, 'workshop', 'message', file.id)).toBeNull()
    expect([...previews.digests()]).toEqual([image.digest])
    expect([...previews.named().keys()]).toEqual([image.digest])
  })
})

describe('attached files in prompts (ADR-0131)', () => {
  const file: AgentAttachmentHandle = { id: 'file', name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 5, digest: 'a'.repeat(64) }
  it('asks image support of images alone, a working folder of files alone, and refuses files where this build takes none', async () => {
    const snapshot = await new E2EAgentHost().connect()
    const model = snapshot.models[0]!
    model.supportsImages = false
    expect(validatePromptAttachments(snapshot, model.id, [file])).toEqual([file])
    expect(() => validatePromptAttachments(snapshot, model.id, [file, handleOf(PIXEL_PNG)])).toThrow('This model does not advertise image support.')
    // Where files can be attached, the refusal names the image, since the files beside it are taken.
    const shot = { ...handleOf(PIXEL_PNG), name: 'photo.png' }
    expect(() => validatePromptAttachments(snapshot, model.id, [file, shot], { acceptsFiles: true }))
      .toThrow('This model does not read images. Choose a model with image support, or remove photo.png.')
    expect(() => validatePromptAttachments(snapshot, model.id, [shot], { acceptsFiles: false })).toThrow('This model does not advertise image support.')
    // A thread whose folder the adapter names has somewhere to copy a file; one with none is refused before anything is read.
    expect(validatePromptAttachments(snapshot, model.id, [file], { workingDirectory: '/work' })).toEqual([file])
    for (const workingDirectory of [undefined, null, '']) expect(() => validatePromptAttachments(snapshot, model.id, [file], { workingDirectory })).toThrow(ATTACHED_FILES_NEED_A_FOLDER)
    model.supportsImages = true
    expect(validatePromptAttachments(snapshot, model.id, [handleOf(PIXEL_PNG)], { workingDirectory: undefined, acceptsFiles: false })).toHaveLength(1)
    // With the Owl feature off, a file is refused even when a handle names one: a defence behind the composer.
    expect(() => validatePromptAttachments(snapshot, model.id, [file], { acceptsFiles: false })).toThrow(SCREENSHOT_WRONG_TYPE)
  })
})

/** A provider that records what it is asked to do; nothing it is sent is read. */
class Host implements AgentHost {
  state!: AgentHostSnapshot
  listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  attempts: AgentHostCommand[] = []
  async connect() { this.state ??= await new E2EAgentHost().connect(); this.state.connected = true; return this.snapshot() }
  async snapshot() { return structuredClone(this.state) }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  disconnect() { this.state.connected = false }
  update(id: string, patch: Partial<AgentThread>) { Object.assign(this.state.threads.find(thread => thread.id === id)!, patch); for (const listener of this.listeners) listener(structuredClone(this.state)) }
  async execute(command: AgentHostCommand): Promise<AgentHostResult> { this.attempts.push(command); return { accepted: true } }
}

async function coordinator(attachAnyFile: boolean) {
  const root = await directory(); const host = new Host()
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  const create = () => {
    const control = createAgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner, ...(attachAnyFile ? { attachAnyFile: true } : {}) })
    controls.push(control); return control
  }
  let control = create(); await control.start(); await control.command({ type: 'connect' })
  return { root, host, get control() { return control }, async restart() { control.dispose(); await control.privacyChanged(); control = create(); await control.start(); await control.command({ type: 'connect' }) } }
}

describe('attached files through the coordinator (ADR-0131)', () => {
  it('keeps a file handle in a draft and a follow-up across a restart, and hands none of its bytes back for a chip', async () => {
    const f = await coordinator(true)
    const file = await f.control.stageAttachment(pdf)
    expect(await f.control.attachmentContent(file.digest)).toBeNull()
    expect((await f.control.command({ type: 'save-thread-draft', threadId: 'workshop', draftId: randomUUID(), text: 'Read this', attachments: [file], requestId: null })).error).toBeNull()
    f.host.update('docs', { status: 'running', lastTurn: { id: 'running-turn', status: 'running' } })
    expect((await f.control.command({ type: 'queue-followup', threadId: 'docs', draftId: randomUUID(), text: 'And this', attachments: [file] })).error).toBeNull()
    await f.restart()
    expect(f.control.shell().threadDrafts).toEqual([expect.objectContaining({ threadId: 'workshop', attachments: [file] })])
    expect(f.control.get().followups).toEqual([expect.objectContaining({ threadId: 'docs', attachments: [file] })])
    expect((await readdir(join(f.root, 'attachments'))).filter(name => name !== 'index.json')).toEqual([`${file.digest}.bin`])
  })

  it('hands a file to the provider as a handle whose bytes it reads at the boundary, as an image is', async () => {
    const f = await coordinator(true)
    const file = await f.control.stageAttachment(pdf)
    // This host records nothing it is sent, so the send stays unconfirmed; what matters is what crossed the boundary.
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId: randomUUID(), text: 'Read this', attachments: [file] })
    const sent = f.host.attempts.find(command => command.type === 'send')
    expect(sent).toMatchObject({ text: 'Read this', attachments: [expect.objectContaining(file)] })
    const [attached] = (sent as Extract<AgentHostCommand, { type: 'send' }>).attachments!
    expect(Buffer.from(await attached!.read())).toEqual(pdf.bytes)
  })

  it('refuses to send a file once the Owl feature is off, before the provider hears anything, even though the store still keeps it', async () => {
    const root = await directory(); const host = new Host()
    const credentials = await testCredentials(root, { mode: 'unavailable' })
    const create = (attachAnyFile: boolean) => {
      const control = createAgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner, ...(attachAnyFile ? { attachAnyFile: true } : {}) })
      controls.push(control); return control
    }
    const on = create(true); await on.start(); await on.command({ type: 'connect' })
    const file = await on.stageAttachment(pdf)
    expect((await on.command({ type: 'save-thread-draft', threadId: 'workshop', draftId: randomUUID(), text: 'Read this', attachments: [file], requestId: null })).error).toBeNull()
    on.dispose(); await on.privacyChanged()
    const off = create(false); await off.start(); await off.command({ type: 'connect' })
    const result = await off.command({ type: 'manual-send', threadId: 'workshop', draftId: randomUUID(), text: 'Read this', attachments: [file] })
    expect(result.error).toContain(SCREENSHOT_WRONG_TYPE)
    expect(host.attempts.filter(command => command.type === 'send')).toEqual([])
  })

  it('stages no file while the Owl feature is off', async () => {
    const f = await coordinator(false)
    await expect(f.control.stageAttachment(pdf)).rejects.toThrow(SCREENSHOT_WRONG_TYPE)
  })
})
