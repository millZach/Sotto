// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hostSoundViews } from '../../../../../src/main/tools/elevenlabs/hostViews'
import type { SoundRecord } from '../../../../../src/main/tools/elevenlabs/records'
import type { SoundViewSource } from '../../../../../src/main/tools/elevenlabs/view'
import { SOUND_BYTES_MAX, SOUND_HOST_PART_BYTES, soundHostBytesSchema, type SoundHostNews } from '../../../../../src/shared/sounds'

/**
 * A headless host's sounds as a recorded desktop reads them (the plugins plan's slice 12, part 4b): a view by the host's
 * own ID, the MP3 in parts cut from the one file it checked, and news as a record changes. Every file is made up here.
 */
let root: string
let outside: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-sound-host-views-')))
  outside = await realpath(await mkdtemp(join(tmpdir(), 'sotto-sound-host-views-outside-')))
})
afterEach(async () => { await Promise.all([root, outside].map(folder => rm(folder, { recursive: true, force: true }))) })

/** An MP3 frame header and then `length` bytes of `fill`, so it opens as an MP3. */
const mp3 = (length: number, fill = 1): Uint8Array => { const bytes = new Uint8Array(4 + length).fill(fill); bytes.set([0xff, 0xfb, 0x90, 0x64]); return bytes }
/** An MP3 a little over one part, so it crosses the connection in two. */
const twoParts = (fill: number): Uint8Array => mp3(SOUND_HOST_PART_BYTES + 1_000, fill)
const decoded = (data: string): Buffer => Buffer.from(data, 'base64')

function made(id: string, change: Partial<SoundRecord> = {}): SoundRecord {
  return { id, threadId: 'thread-1', accountId: '55555555-5555-4555-8555-000000000001', kind: 'speech', name: 'Opening narration', voice: 'Rachel',
    folder: join(root, 'sounds'), fileName: `${id}.mp3`, cost: 0.02, askedAt: '2026-11-16T09:00:00.000Z', state: 'made', ...change }
}
function source(records: SoundRecord[]): SoundViewSource {
  return { sound: async id => records.find(record => record.id === id), folderOf: async () => root }
}
async function saved(name: string, bytes: Uint8Array, folder = join(root, 'sounds')): Promise<void> {
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, name), bytes)
}

describe('a host’s sounds for a recorded desktop', () => {
  it('views one by the host’s own ID, with no path, and says nothing of an unknown ID', async () => {
    const bytes = mp3(100)
    await saved('narration.mp3', bytes)
    const views = hostSoundViews(source([made('narration')]))
    const view = await views.view('narration')
    expect(view).toMatchObject({ id: 'narration', name: 'Opening narration', state: 'made', fileName: 'narration.mp3', bytes: bytes.byteLength })
    expect(JSON.stringify(view)).not.toContain(root.replace(/\\/gu, '\\\\'))
    await expect(views.view('nothing')).resolves.toBeNull()
    views.close()
  })

  it('hands over an MP3 in parts cut from the one file it checked, and refuses an unknown ID, a folder outside the thread’s or a file that is not an MP3', async () => {
    const sound = twoParts(7)
    await saved('narration.mp3', sound)
    await saved('away.mp3', mp3(100), join(outside, 'sounds'))
    await saved('not.mp3', new Uint8Array(200).fill(4))
    const views = hostSoundViews(source([made('narration'), made('away', { folder: join(outside, 'sounds') }), made('not')]))
    const first = soundHostBytesSchema.parse(await views.bytes({ id: 'narration', offset: 0 }, 'desktop'))!
    expect(first.total).toBe(sound.byteLength)
    expect(first.digest).toBe(createHash('sha256').update(sound).digest('hex'))
    expect(decoded(first.data).byteLength).toBe(SOUND_HOST_PART_BYTES)
    // The file changes on disk; the rest still comes from what was checked.
    await saved('narration.mp3', twoParts(9))
    const second = soundHostBytesSchema.parse(await views.bytes({ id: 'narration', offset: SOUND_HOST_PART_BYTES, digest: first.digest }, 'desktop'))!
    expect(Buffer.concat([decoded(first.data), decoded(second.data)]).equals(Buffer.from(sound))).toBe(true)
    // With nothing held, a later part of a file that changed since its first is refused rather than mixed.
    await expect(views.bytes({ id: 'narration', offset: SOUND_HOST_PART_BYTES, digest: first.digest }, 'desktop')).resolves.toBeNull()
    await expect(views.bytes({ id: 'nothing', offset: 0 }, 'desktop')).resolves.toBeNull()
    await expect(views.bytes({ id: 'away', offset: 0 }, 'desktop')).resolves.toBeNull()
    await expect(views.bytes({ id: 'not', offset: 0 }, 'desktop')).resolves.toBeNull()
    views.close()
  })

  it('hands over nothing past the cap', async () => {
    await saved('huge.mp3', mp3(SOUND_BYTES_MAX))
    await expect(hostSoundViews(source([made('huge')])).bytes({ id: 'huge', offset: 0 }, 'desktop')).resolves.toBeNull()
  })

  it('tells its listeners each change as the record’s view now, with the thread that made it, while the record is there', async () => {
    const records = [made('making', { state: 'making', fileName: undefined }), made('other', { threadId: 'thread-2', state: 'making', fileName: undefined })]
    const views = hostSoundViews(source(records))
    // With nobody listening, nothing is read.
    views.changed(records[0]!)
    const news: SoundHostNews[] = []
    views.subscribe(item => { news.push(item) })
    // The record failed since it was told: the view is read as it is now, not as it was told.
    records[0] = { ...records[0]!, state: 'failed', failure: 'busy', cost: 0 }
    views.changed(made('making', { state: 'making' }))
    await expect.poll(() => news.length).toBe(1)
    expect(news[0]).toEqual({ threadId: 'thread-1', view: expect.objectContaining({ id: 'making', state: 'failed', failure: 'busy' }) as unknown })
    // Its thread was forgotten: its next change is not told, and views go in order, so the next one told is the other's.
    records.shift()
    views.changed(made('making'))
    views.changed(records[0]!)
    await expect.poll(() => news.length).toBe(2)
    expect(news[1]).toMatchObject({ threadId: 'thread-2', view: { id: 'other' } })
    views.close()
  })
})
