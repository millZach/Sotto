// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentStore, inlineStager, MISMATCHED_ATTACHMENT, MISSING_ATTACHMENT, MISSING_REMOTE_ATTACHMENT, UNOWNED_ATTACHMENT_GRACE_MS } from '../../../src/main/agents/attachmentStore'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { SCREENSHOT_NOT_ITS_TYPE, SCREENSHOT_TOO_LARGE, SCREENSHOT_WRONG_TYPE } from '../../../src/shared/agents'
import { handleOf, PIXEL_PNG, pngOfSize } from '../../fixtures/stagedImages'

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, readFile: vi.fn(fs.readFile) }
})

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-attachments-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})
async function directory() { const root = await mkdtemp(join(tmpdir(), 'sotto-attachments-')); roots.push(root); return root }
const folder = (root: string) => join(root, 'attachments')
const index = async (root: string) => JSON.parse(await readFile(join(folder(root), 'index.json'), 'utf8')) as { version: 1; entries: { digest: string }[] }
const png = { name: 'Screenshot.png', mimeType: 'image/png', bytes: PIXEL_PNG }

describe('the attachment store (ADR-0031)', () => {
  it('commits the bytes and the index before it answers with a handle, and keeps the same content once', async () => {
    const root = await directory(); const store = new AttachmentStore(root); await store.load()
    const handle = await store.stage(png)
    expect(handle).toEqual({ ...handleOf(PIXEL_PNG, handle.id, 'Screenshot.png') })
    // By the time the handle exists, a restart finds the content: the file under its digest and the index naming it.
    expect(await readFile(join(folder(root), `${handle.digest}.png`))).toEqual(PIXEL_PNG)
    expect((await index(root)).entries).toEqual([expect.objectContaining({ digest: handle.digest, mimeType: 'image/png', sizeBytes: PIXEL_PNG.length })])
    // No names, no thread IDs: the index says what content there is and when it came.
    expect(JSON.stringify(await index(root))).not.toContain('Screenshot')
    const again = await store.stage({ ...png, name: 'Again.png' })
    expect(again.id).not.toBe(handle.id); expect(again.digest).toBe(handle.digest)
    expect(await readdir(folder(root))).toHaveLength(2)
    expect(await store.read(handle.digest)).toEqual(PIXEL_PNG)
  })
  it('refuses content that is not the image it claims, whatever sent it', async () => {
    const root = await directory(); const store = new AttachmentStore(root); await store.load()
    // Each sentence says nothing was attached and what to do next.
    await expect(store.stage({ ...png, bytes: Buffer.from('<svg/>') })).rejects.toThrow(SCREENSHOT_NOT_ITS_TYPE)
    await expect(store.stage({ ...png, mimeType: 'image/svg+xml' })).rejects.toThrow(SCREENSHOT_WRONG_TYPE)
    await expect(store.stage({ ...png, mimeType: 'image/jpeg' })).rejects.toThrow(SCREENSHOT_NOT_ITS_TYPE)
    await expect(store.stage({ ...png, bytes: pngOfSize(10 * 1024 * 1024 + 1) })).rejects.toThrow(SCREENSHOT_TOO_LARGE)
    await expect(store.stage({ ...png, bytes: new Uint8Array() })).rejects.toThrow(SCREENSHOT_TOO_LARGE)
    for (const sentence of [SCREENSHOT_NOT_ITS_TYPE, SCREENSHOT_WRONG_TYPE, SCREENSHOT_TOO_LARGE]) expect(sentence).toContain('Nothing was attached.')
    expect(await readdir(root)).toEqual([])
  })
  it('checks a handle against what it keeps: missing content, and a type or size that disagree, are refused', async () => {
    const root = await directory(); const store = new AttachmentStore(root); await store.load()
    const handle = await store.stage(png)
    expect(() => store.verify([handle])).not.toThrow()
    expect(() => store.verify(undefined)).not.toThrow()
    expect(() => store.verify([handleOf(pngOfSize(32, 9))])).toThrow(MISSING_ATTACHMENT)
    expect(() => store.verify([{ ...handle, sizeBytes: handle.sizeBytes + 1 }])).toThrow(MISMATCHED_ATTACHMENT)
    expect(() => store.verify([{ ...handle, mimeType: 'image/gif' }])).toThrow(MISMATCHED_ATTACHMENT)
    expect(store.keeps(handle)).toBe(true); expect(store.keeps({ ...handle, sizeBytes: 2 })).toBe(false)
    // A headless host names itself: the desktop showing the refusal is not the machine that lost the image.
    const remote = new AttachmentStore(await directory(), { missing: MISSING_REMOTE_ATTACHMENT }); await remote.load()
    expect(() => remote.verify([handle])).toThrow(MISSING_REMOTE_ATTACHMENT)
  })
  it.each(['missing', 'corrupt'] as const)('treats %s content as gone, and writes it afresh when staged again', async condition => {
    const root = await directory(); const store = new AttachmentStore(root); await store.load()
    const handle = await store.stage(png)
    const file = join(folder(root), `${handle.digest}.png`)
    if (condition === 'missing') await rm(file)
    else await writeFile(file, PIXEL_PNG.subarray(0, PIXEL_PNG.length - 4))
    expect(await store.read(handle.digest)).toBeNull()
    expect(store.has(handle.digest)).toBe(false)
    expect(store.keeps(handle)).toBe(false)
    expect(() => store.verify([handle])).toThrow(MISSING_ATTACHMENT)
    // The damaged file and its index entry go too, so a restart does not take it back as the user's image.
    expect(await readdir(folder(root))).toEqual(['index.json'])
    expect((await index(root)).entries).toEqual([])
    const afterDamage = new AttachmentStore(root); await afterDamage.load()
    expect(afterDamage.has(handle.digest)).toBe(false)
    await store.stage(png)
    expect(await store.read(handle.digest)).toEqual(PIXEL_PNG)
    const restored = new AttachmentStore(root); await restored.load()
    expect(await restored.read(handle.digest)).toEqual(PIXEL_PNG)
    // Taken back at start the same way: a file that is not its digest's content is never read as it, and is removed once found.
    await writeFile(file, Buffer.concat([PIXEL_PNG, Buffer.from([0])]))
    const restarted = new AttachmentStore(root); await restarted.load()
    expect(restarted.has(handle.digest)).toBe(true)
    expect(await restarted.read(handle.digest)).toBeNull()
    expect(restarted.has(handle.digest)).toBe(false)
    const again = new AttachmentStore(root); await again.load()
    expect(again.has(handle.digest)).toBe(false)
  })
  it.each(['missing', 'corrupt'] as const)('leaves concurrently restaged content alone when an older %s read finishes', async condition => {
    const root = await directory(); const store = new AttachmentStore(root); await store.load()
    const handle = await store.stage(png)
    const file = join(folder(root), `${handle.digest}.png`)
    if (condition === 'missing') await rm(file)
    else await writeFile(file, Buffer.from('damaged'))
    // One read observed the bad file but finishes after another read invalidates it and staging repairs it.
    const stale = Promise.withResolvers<Buffer<ArrayBuffer>>()
    vi.mocked(readFile).mockReturnValueOnce(stale.promise)
    const reading = store.read(handle.digest)
    try {
      expect(await store.read(handle.digest)).toBeNull()
      const handles = await Promise.all([store.stage(png), store.stage({ ...png, name: 'Again.png' })])
      expect(handles.map(item => item.digest)).toEqual([handle.digest, handle.digest])
      expect(new Set(handles.map(item => item.id)).size).toBe(2)
    } finally {
      if (condition === 'missing') stale.reject(Object.assign(new Error('Gone'), { code: 'ENOENT' }))
      else stale.resolve(Buffer.from('damaged'))
      await reading
    }
    expect(await reading).toBeNull()
    expect(store.keeps(handle)).toBe(true)
    expect(await store.read(handle.digest)).toEqual(PIXEL_PNG)
    expect(await readdir(folder(root))).toEqual(expect.arrayContaining([`${handle.digest}.png`, 'index.json']))
    expect(await readdir(folder(root))).toHaveLength(2)
    const restarted = new AttachmentStore(root); await restarted.load()
    expect(await restarted.read(handle.digest)).toEqual(PIXEL_PNG)
  })
  it('propagates a read failure other than missing content without forgetting the image', async () => {
    const root = await directory(); const store = new AttachmentStore(root); await store.load()
    const handle = await store.stage(png)
    const denied = Object.assign(new Error('Read denied'), { code: 'EACCES' })
    vi.mocked(readFile).mockRejectedValueOnce(denied)
    await expect(store.read(handle.digest)).rejects.toBe(denied)
    expect(store.keeps(handle)).toBe(true)
    expect(await store.read(handle.digest)).toEqual(PIXEL_PNG)
  })
  it('keeps a missing image restaged with history off in memory alone', async () => {
    const root = await directory(); let history = true
    const store = new AttachmentStore(root, { historyEnabled: () => history }); await store.load()
    const handle = await store.stage(png)
    await rm(join(folder(root), `${handle.digest}.png`))
    expect(await store.read(handle.digest)).toBeNull()
    history = false
    await store.stage(png)
    expect(store.inMemory(handle.digest)).toBe(true)
    expect(await store.read(handle.digest)).toEqual(PIXEL_PNG)
    expect(await readdir(folder(root))).toEqual(['index.json'])
    expect((await index(root)).entries).toEqual([])
    const restarted = new AttachmentStore(root); await restarted.load()
    expect(restarted.has(handle.digest)).toBe(false)
  })
  it('converts an image an earlier version kept inline through one path, and answers null for one that is not an image', async () => {
    const root = await directory(); const store = new AttachmentStore(root); await store.load()
    const stage = inlineStager(store)
    const inline = { id: 'legacy', name: 'Legacy.png', mimeType: 'image/png' as const, dataUrl: `data:image/png;base64,${PIXEL_PNG.toString('base64')}` }
    expect(await stage(inline)).toEqual(handleOf(PIXEL_PNG, 'legacy', 'Legacy.png'))
    expect(await stage({ ...inline, dataUrl: 'data:image/png;base64,YWJj' })).toBeNull()
    // An inline image an earlier build saved with the sizes the composer scaled it to keeps them (ADR-0030).
    const dimensions = { original: { width: 3840, height: 2160 }, sent: { width: 2576, height: 1449 } }
    expect(await stage({ ...inline, dimensions })).toEqual({ ...handleOf(PIXEL_PNG, 'legacy', 'Legacy.png'), dimensions })
  })
  it('writes an image an earlier version kept inline to disk even while history is off, since those bytes are not new', async () => {
    const root = await directory(); const store = new AttachmentStore(root, { historyEnabled: () => false }); await store.load()
    const inline = { id: 'legacy', name: 'Legacy.png', mimeType: 'image/png' as const, dataUrl: `data:image/png;base64,${PIXEL_PNG.toString('base64')}` }
    const handle = await inlineStager(store)(inline)
    expect(store.inMemory(handle!.digest)).toBe(false)
    expect((await index(root)).entries.map(entry => entry.digest)).toEqual([handle!.digest])
    // Content first staged in memory while history was off also reaches disk when an older file names the same bytes.
    const fresh = await store.stage({ ...png, bytes: pngOfSize(64, 6) })
    expect(store.inMemory(fresh.digest)).toBe(true)
    await inlineStager(store)({ ...inline, id: 'legacy-2', dataUrl: `data:image/png;base64,${pngOfSize(64, 6).toString('base64')}` })
    expect(store.inMemory(fresh.digest)).toBe(false)
    const restarted = new AttachmentStore(root, { historyEnabled: () => false }); await restarted.load()
    expect(restarted.has(handle!.digest)).toBe(true); expect(restarted.has(fresh.digest)).toBe(true)
  })
  it('carries the sizes the composer attached and sent an image at on its handle, and nothing else about them', async () => {
    const root = await directory(); const store = new AttachmentStore(root); await store.load()
    const dimensions = { original: { width: 3840, height: 2160 }, sent: { width: 2576, height: 1449 } }
    const handle = await store.stage({ ...png, dimensions })
    expect(handle.dimensions).toEqual(dimensions)
    // Compared as fields and values, not as text: a staging time can contain the same digits as a size.
    const kept = (await index(root)).entries.map(entry => entry as Record<string, unknown>)
    expect(kept.flatMap(entry => Object.keys(entry))).not.toContain('dimensions')
    expect(kept.flatMap(entry => Object.values(entry)).filter(value => [3840, 2160, 2576, 1449].includes(value as number))).toEqual([])
    await expect(store.stage({ ...png, dimensions: { original: { width: 0, height: 1 }, sent: { width: 1, height: 1 } } })).rejects.toThrow()
  })
  it('asks what is owned when a sweep runs, not when it was asked for', async () => {
    const root = await directory(); let now = 1_800_000_000_000
    const store = new AttachmentStore(root, { now: () => now }); await store.load()
    const handle = await store.stage(png)
    now += UNOWNED_ATTACHMENT_GRACE_MS
    const owned = new Set<string>()
    const sweep = store.sweep(() => owned)
    // Something came to own the content after the sweep was queued and before it ran.
    owned.add(handle.digest)
    await sweep
    expect(store.has(handle.digest)).toBe(true)
  })
  it('removes content nothing owns only once it has been unowned for the grace period', async () => {
    const root = await directory(); let now = 1_800_000_000_000
    const store = new AttachmentStore(root, { now: () => now }); await store.load()
    const kept = await store.stage(png); const released = await store.stage({ ...png, bytes: pngOfSize(64, 1) })
    await store.sweep(new Set([kept.digest, released.digest]))
    // Released now: a draft cleared, a prompt refused. It stays through the grace period, so a refused prompt can come back.
    await store.sweep(new Set([kept.digest]))
    now += UNOWNED_ATTACHMENT_GRACE_MS - 1
    await store.sweep(new Set([kept.digest]))
    expect(store.has(released.digest)).toBe(true)
    now += 1
    await store.sweep(new Set([kept.digest]))
    expect(store.has(released.digest)).toBe(false); expect(store.has(kept.digest)).toBe(true)
    expect(await readdir(folder(root))).toEqual(expect.arrayContaining([`${kept.digest}.png`, 'index.json']))
    expect(await readdir(folder(root))).toHaveLength(2)
    expect((await index(root)).entries.map(entry => entry.digest)).toEqual([kept.digest])
    expect(await store.read(released.digest)).toBeNull()
    // Owned again before it expired: the grace starts over the next time nothing owns it.
    await store.sweep(new Set()); now += UNOWNED_ATTACHMENT_GRACE_MS / 2
    await store.sweep(new Set([kept.digest])); now += UNOWNED_ATTACHMENT_GRACE_MS / 2
    await store.sweep(new Set())
    expect(store.has(kept.digest)).toBe(true)
    // Content released now goes without a grace, which is what turning history off asks for what only previews kept.
    const other = await store.stage({ ...png, bytes: pngOfSize(64, 5) })
    await store.sweep(new Set([other.digest]), UNOWNED_ATTACHMENT_GRACE_MS, new Map([[kept.digest, now], [other.digest, now]]))
    expect(store.has(kept.digest)).toBe(false); expect(store.has(other.digest)).toBe(true)
  })
  it('keeps its grace for content a preview names that was staged again since, for a draft not saved yet', async () => {
    const root = await directory(); let now = 1_800_000_000_000
    const store = new AttachmentStore(root, { now: () => now }); await store.load()
    const sent = await store.stage(png); const previewOnly = await store.stage({ ...png, bytes: pngOfSize(64, 7) })
    // Both were sent and their previews stored; then the user attached the first again to a new draft.
    const previewedAt = now += 10
    now += 10; await store.stage(png)
    await store.sweep(new Set(), UNOWNED_ATTACHMENT_GRACE_MS, new Map([[sent.digest, previewedAt], [previewOnly.digest, previewedAt]]))
    expect(store.has(sent.digest)).toBe(true); expect(store.has(previewOnly.digest)).toBe(false)
    // It then goes by the ordinary rule, a grace period after nothing owns it.
    now += UNOWNED_ATTACHMENT_GRACE_MS
    await store.sweep(new Set())
    expect(store.has(sent.digest)).toBe(false)
  })
  it('finds and prunes what a crash between staging and saving the draft left behind', async () => {
    const root = await directory(); let now = 1_800_000_000_000
    const staged = await new AttachmentStore(root, { now: () => now }).stage(png)
    // A file the index does not name (a crash between the rename and the index write), a temporary file, and strays.
    const orphan = handleOf(pngOfSize(48, 2))
    await writeFile(join(folder(root), `${orphan.digest}.png`), pngOfSize(48, 2))
    await writeFile(join(folder(root), `${orphan.digest}.png.tmp-123-11111111-1111-4111-8111-111111111111`), 'partial')
    await writeFile(join(folder(root), 'notes.txt'), 'not ours')
    await writeFile(join(folder(root), `${'c'.repeat(64)}.svg`), '<svg/>')
    // An index entry whose file is gone.
    const index = JSON.parse(await readFile(join(folder(root), 'index.json'), 'utf8'))
    index.entries.push({ digest: 'd'.repeat(64), mimeType: 'image/png', sizeBytes: 10, stagedAt: now })
    await writeFile(join(folder(root), 'index.json'), JSON.stringify(index))
    now += 1000
    const restarted = new AttachmentStore(root, { now: () => now }); await restarted.load()
    expect(await readdir(folder(root))).toEqual(expect.arrayContaining([`${staged.digest}.png`, `${orphan.digest}.png`, 'index.json']))
    expect(await readdir(folder(root))).toHaveLength(3)
    expect(restarted.has(orphan.digest)).toBe(true); expect(restarted.has('d'.repeat(64))).toBe(false)
    // Nothing owns either: both go a grace period into this run.
    await restarted.sweep(new Set())
    now += UNOWNED_ATTACHMENT_GRACE_MS
    await restarted.sweep(new Set())
    expect(await readdir(folder(root))).toEqual(['index.json'])
  })
  it('keeps content in memory alone while history is off, so nothing new reaches disk', async () => {
    const root = await directory(); let history = false
    const store = new AttachmentStore(root, { historyEnabled: () => history }); await store.load()
    const handle = await store.stage(png)
    expect(await readdir(root)).toEqual([])
    expect(store.inMemory(handle.digest)).toBe(true)
    expect(await store.read(handle.digest)).toEqual(PIXEL_PNG)
    history = true
    const disk = await store.stage({ ...png, bytes: pngOfSize(64, 4) })
    expect(store.inMemory(disk.digest)).toBe(false)
    expect((await index(root)).entries.map(entry => entry.digest)).toEqual([disk.digest])
    const restarted = new AttachmentStore(root); await restarted.load()
    expect(restarted.has(handle.digest)).toBe(false); expect(restarted.has(disk.digest)).toBe(true)
  })
  it('leaves nothing behind that it did not name when the index cannot be written', async () => {
    const root = await directory(); const store = new AttachmentStore(root); await store.load()
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockRejectedValueOnce(new Error('Storage unavailable'))
    await expect(store.stage(png)).rejects.toThrow('Storage unavailable')
    expect(store.has(handleOf(PIXEL_PNG).digest)).toBe(false)
    expect(await readdir(folder(root))).toEqual([])
  })
})
