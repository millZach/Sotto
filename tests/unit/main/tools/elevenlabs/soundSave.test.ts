// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { saveSound, SoundSaveError, soundFileBase, type SoundSaveProblem } from '../../../../../src/main/tools/elevenlabs/save'

/** A sound ElevenLabs made, saved into its thread's folder (ADR-0205; slice 12, part 2). */
const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))) })
async function thread(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'sotto-sound-save-'))
  folders.push(folder)
  return folder
}
const mp3 = (bytes = 2_048): Uint8Array<ArrayBuffer> => new Uint8Array(bytes).map((_, index) => index % 251)
const answer = (bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}): Response => new Response(bytes, { status: 200, headers: { 'content-type': 'audio/mpeg', ...headers } })
async function problem(saved: Promise<unknown>): Promise<SoundSaveProblem> {
  try { await saved } catch (error) { if (error instanceof SoundSaveError) return error.problem; throw error }
  throw new Error('It was saved.')
}

describe('saving a sound', () => {
  it('writes it whole into sounds/ in the thread\'s folder under its name, and the next one of that name beside it', async () => {
    const root = await thread()
    const bytes = mp3()
    const first = await saveSound(answer(bytes), { root, folder: 'sounds', name: 'Opening narration' })
    expect(first).toMatchObject({ fileName: 'Opening narration.mp3', bytes: bytes.byteLength })
    expect(new Uint8Array(await readFile(join(root, 'sounds', 'Opening narration.mp3')))).toEqual(bytes)
    const second = await saveSound(answer(mp3(10)), { root, folder: 'sounds', name: 'Opening narration' })
    expect(second.fileName).toBe('Opening narration 2.mp3')
    // Nothing of Sotto's own is left beside them.
    expect((await readdir(join(root, 'sounds'))).sort()).toEqual(['Opening narration 2.mp3', 'Opening narration.mp3'])
  })

  it('never writes over a file the user already has under that name', async () => {
    const root = await thread()
    await mkdir(join(root, 'sounds'))
    await writeFile(join(root, 'sounds', 'Chime.mp3'), 'the user\'s own')
    expect((await saveSound(answer(mp3()), { root, folder: 'sounds', name: 'Chime' })).fileName).toBe('Chime 2.mp3')
    expect(await readFile(join(root, 'sounds', 'Chime.mp3'), 'utf8')).toBe('the user\'s own')
  })

  it('refuses a folder outside the thread\'s, by its name or through a link, and writes nothing there', async () => {
    const root = await thread()
    const elsewhere = await thread()
    expect(await problem(saveSound(answer(mp3()), { root, folder: '../outside', name: 'Chime' }))).toBe('folder')
    expect(await problem(saveSound(answer(mp3()), { root, folder: elsewhere, name: 'Chime' }))).toBe('folder')
    await symlink(elsewhere, join(root, 'linked'), 'junction')
    expect(await problem(saveSound(answer(mp3()), { root, folder: 'linked', name: 'Chime' }))).toBe('folder')
    expect(await readdir(elsewhere)).toEqual([])
  })

  it('keeps nothing of an answer past the cap, or one that is empty', async () => {
    const root = await thread()
    expect(await problem(saveSound(answer(mp3(4_096), { 'content-length': '4096' }), { root, folder: 'sounds', name: 'Big' }, { maxBytes: 1_024 }))).toBe('too-large')
    expect(await problem(saveSound(answer(mp3(4_096)), { root, folder: 'sounds', name: 'Big' }, { maxBytes: 1_024 }))).toBe('too-large')
    expect(await problem(saveSound(answer(new Uint8Array(0)), { root, folder: 'sounds', name: 'Empty' }))).toBe('unreachable')
    expect(await readdir(join(root, 'sounds'))).toEqual([])
  })

  it('names a file after the sound with nothing Windows refuses', () => {
    expect(soundFileBase('Intro: "take 2"?')).toBe('Intro- -take 2-')
    expect(soundFileBase('   ')).toBe('sound')
    expect(soundFileBase('CON')).toBe('CON-sound')
    expect(soundFileBase('..hidden..')).toBe('hidden')
  })
})
