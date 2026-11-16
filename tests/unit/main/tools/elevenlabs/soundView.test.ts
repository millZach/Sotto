// @vitest-environment node
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SoundRecord } from '../../../../../src/main/tools/elevenlabs/records'
import { looksLikeMp3, revealSoundFile, soundBytes, soundView, soundViewOf, soundViewPush, type SoundViewSource } from '../../../../../src/main/tools/elevenlabs/view'
import { soundViewSchema, type SoundView } from '../../../../../src/shared/sounds'

/**
 * A sound as the window draws it in its thread (ADR-0205; the plugins plan's slice 12, part 3): its view, its MP3 and its
 * file shown in the folder app, each by its ID alone and read only from inside the thread's working folder, and the push
 * that moves its line from making to made or failed. Every file here is made up in a temporary folder.
 */
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64])
let root: string
let outside: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-sound-view-')))
  outside = await realpath(await mkdtemp(join(tmpdir(), 'sotto-sound-view-outside-')))
})
afterEach(async () => { await Promise.all([root, outside].map(folder => rm(folder, { recursive: true, force: true }))) })

const WORDS = 'Welcome to Lumen. In the next two minutes you will set up your shop.'
function made(overrides: Partial<SoundRecord> = {}): SoundRecord {
  return { id: 'sound-1', threadId: 'thread-one', accountId: '55555555-5555-4555-8555-000000000001', kind: 'speech', name: 'Opening narration', words: WORDS, voice: 'Rachel',
    folder: join(root, 'sounds'), fileName: 'Opening narration.mp3', bytes: MP3.byteLength, cost: 0.02, askedAt: '2026-11-15T18:52:00.000Z', state: 'made', ...overrides }
}
/** The records as main holds them, and the thread's working folder as it is now. */
function source(records: readonly SoundRecord[], folder: string | null = root): SoundViewSource & { asked: string[] } {
  const asked: string[] = []
  return { asked, sound: async id => { asked.push(id); return records.find(record => record.id === id) }, folderOf: async () => folder }
}
async function saved(bytes: Uint8Array = MP3, name = 'Opening narration.mp3'): Promise<void> {
  await mkdir(join(root, 'sounds'), { recursive: true })
  await writeFile(join(root, 'sounds', name), bytes)
}

describe('a sound’s view', () => {
  it('names the sound, its kind, voice, cost and words, its file by its name and size, and when it was saved, never a path', async () => {
    await saved()
    const view = await soundViewOf(source([made()]), 'sound-1')
    expect(view).toMatchObject({ id: 'sound-1', name: 'Opening narration', kind: 'speech', state: 'made', cost: 0.02, voice: 'Rachel', words: WORDS,
      fileName: 'Opening narration.mp3', bytes: MP3.byteLength })
    expect(Date.parse(view!.madeAt!)).not.toBeNaN()
    expect(soundViewSchema.parse(view)).toEqual(view)
    expect(JSON.stringify(view)).not.toContain(root.replace(/\\/gu, '\\\\'))
    expect(await soundViewOf(source([made()]), 'no-such-sound')).toBeNull()
  })

  it('carries no words once Keep local history took them out, and no file while it is being made or once it failed', async () => {
    expect((await soundView(source([]), made({ words: undefined }))).words).toBeUndefined()
    const making = await soundView(source([]), made({ state: 'making', fileName: undefined, bytes: undefined }))
    expect(making).toEqual({ id: 'sound-1', name: 'Opening narration', kind: 'speech', state: 'making', cost: 0.02, voice: 'Rachel', words: WORDS })
    const failed = await soundView(source([]), made({ state: 'failed', failure: 'rejected', cost: 0, fileName: undefined, bytes: undefined }))
    expect(failed).toMatchObject({ state: 'failed', failure: 'rejected', cost: 0 })
    expect(failed.fileName).toBeUndefined()
  })

  it('has no size for a file that is gone, or a folder swapped for a link outside the thread’s', async () => {
    expect((await soundViewOf(source([made()]), 'sound-1'))).toMatchObject({ fileName: 'Opening narration.mp3' })
    expect((await soundViewOf(source([made()]), 'sound-1'))!.bytes).toBeUndefined()
    await writeFile(join(outside, 'Opening narration.mp3'), MP3)
    await symlink(outside, join(root, 'sounds'), 'junction')
    const view = await soundViewOf(source([made()]), 'sound-1')
    expect(view!.bytes).toBeUndefined()
    expect(view!.madeAt).toBeUndefined()
  })
})

describe('a sound’s MP3 for the window', () => {
  it('is read by the sound’s ID alone, from its record’s own file', async () => {
    await saved()
    const sounds = source([made()])
    expect(await soundBytes(sounds, 'sound-1')).toEqual(MP3)
    expect(await soundBytes(sounds, 'no-such-sound')).toBeNull()
    // A model's ID, or a path, is not a sound's.
    expect(await soundBytes(sounds, join(root, 'sounds', 'Opening narration.mp3'))).toBeNull()
    expect(sounds.asked).toEqual(['sound-1', 'no-such-sound', join(root, 'sounds', 'Opening narration.mp3')])
  })

  it('is nothing while it is being made, once it failed, or once its file is gone', async () => {
    await saved()
    expect(await soundBytes(source([made({ state: 'making' })]), 'sound-1')).toBeNull()
    expect(await soundBytes(source([made({ state: 'failed', failure: 'folder' })]), 'sound-1')).toBeNull()
    await rm(join(root, 'sounds', 'Opening narration.mp3'))
    expect(await soundBytes(source([made()]), 'sound-1')).toBeNull()
  })

  it('is nothing through a folder swapped for a link outside the thread’s folder, or a file that is a link outside', async () => {
    await writeFile(join(outside, 'Opening narration.mp3'), MP3)
    await symlink(outside, join(root, 'sounds'), 'junction')
    expect(await soundBytes(source([made()]), 'sound-1')).toBeNull()
    await rm(join(root, 'sounds'), { recursive: true, force: true })
    await mkdir(join(root, 'sounds'))
    await mkdir(join(outside, 'away'))
    await symlink(join(outside, 'away'), join(root, 'sounds', 'Opening narration.mp3'), 'junction')
    expect(await soundBytes(source([made()]), 'sound-1')).toBeNull()
  })

  it('is nothing for a file that is not an MP3 or is past the cap', async () => {
    await saved(new TextEncoder().encode('<html>not a sound</html>'))
    expect(await soundBytes(source([made()]), 'sound-1')).toBeNull()
    await saved()
    expect(await soundBytes(source([made()]), 'sound-1', MP3.byteLength - 1)).toBeNull()
    // An MPEG Layer III frame header, at the start or after an ID3 tag (Sol's review).
    expect(looksLikeMp3(new Uint8Array([0xff, 0xfb, 0x90, 0x64]))).toBe(true)
    expect(looksLikeMp3(MP3)).toBe(true)
    for (const [what, bytes] of [
      ['a PNG', [0x89, 0x50, 0x4e, 0x47]],
      ['an ID3 tag with nothing after it', [0x49, 0x44, 0x33]],
      ['an ID3 tag followed by no frame', [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0x3c, 0x68, 0x74, 0x6d]],
      ['a sync that is no layer', [0xff, 0xff, 0x90, 0x64]],
      ['AAC in ADTS', [0xff, 0xf1, 0x50, 0x80]],
      ['a free bitrate', [0xff, 0xfb, 0x00, 0x64]],
      ['a sample rate that does not exist', [0xff, 0xfb, 0x9c, 0x64]],
      ['a frame cut short', [0xff, 0xfb, 0x90]],
    ] as const) expect(looksLikeMp3(new Uint8Array(bytes)), what).toBe(false)
  })

  it('asks for the folder again while Files is busy, and never calls an MP3 on disk gone for it', async () => {
    // Bug Bot on #2653, L1: Files answers busy while more than four of its requests are in flight.
    await saved()
    let busy = 2
    const asked = { sound: async () => made(), folderOf: async () => busy-- > 0 ? 'busy' as const : root }
    expect(await soundBytes(asked, 'sound-1')).toEqual(MP3)
    busy = 2
    expect((await soundView(asked, made())).bytes).toBe(MP3.byteLength)
    // Busy for good: it throws, so the window keeps what it shows and asks again, rather than being told it is gone.
    const always = { sound: async () => made(), folderOf: async () => 'busy' as const }
    await expect(soundView(always, made())).rejects.toThrow()
  })

  it('reads a record against the thread’s working folder as it is now, so the record holds no folder of its own', async () => {
    await saved()
    const older = made()
    expect(await soundBytes(source([older]), 'sound-1')).toEqual(MP3)
    // A thread with no working folder now hands over nothing; nor does one whose folder no longer holds the sound's.
    expect(await soundBytes(source([older], null), 'sound-1')).toBeNull()
    expect(await soundBytes(source([older], outside), 'sound-1')).toBeNull()
  })
})

describe('a sound’s file in the folder app', () => {
  it('is shown by the sound’s ID alone, at its record’s own path, and not once it is gone or outside', async () => {
    await saved()
    const shown: string[] = []
    expect(await revealSoundFile(source([made()]), 'sound-1', path => shown.push(path))).toBe(true)
    expect(shown).toEqual([await realpath(join(root, 'sounds', 'Opening narration.mp3'))])
    expect(await revealSoundFile(source([made()]), 'no-such-sound', path => shown.push(path))).toBe(false)
    expect(await revealSoundFile(source([made({ state: 'failed', failure: 'folder' })]), 'sound-1', path => shown.push(path))).toBe(false)
    await rename(join(root, 'sounds'), join(root, 'moved'))
    expect(await revealSoundFile(source([made()]), 'sound-1', path => shown.push(path))).toBe(false)
    await writeFile(join(outside, 'Opening narration.mp3'), MP3)
    await symlink(outside, join(root, 'sounds'), 'junction')
    expect(await revealSoundFile(source([made()]), 'sound-1', path => shown.push(path))).toBe(false)
    expect(shown).toHaveLength(1)
  })
})

describe('the push of a sound’s change to the window', () => {
  it('sends each change as its view, in order, and nothing for a sound whose record went', async () => {
    await saved()
    const records = [made({ state: 'making', fileName: undefined, bytes: undefined })]
    const sent: SoundView[] = []
    const push = soundViewPush(source(records), view => { sent.push(view) })
    await push(records[0]!)
    records[0] = made()
    await push(records[0])
    expect(sent.map(view => [view.state, view.bytes])).toEqual([['making', undefined], ['made', MP3.byteLength]])
    // A change told with words the record has since let go, as Keep local history was turned off: the view is the
    // record as it is now, without them (Sol's review).
    records[0] = made({ words: undefined })
    await push(made())
    expect(sent[2]!.words).toBeUndefined()
    sent.splice(2)
    // Its thread was forgotten: the record went, and its line is not told of it again.
    records.splice(0)
    await push(made({ state: 'failed', failure: 'folder' }))
    expect(sent).toHaveLength(2)
  })
})
