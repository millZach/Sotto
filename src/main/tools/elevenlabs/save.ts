import { constants } from 'node:fs'
import { copyFile, link, open, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { SOUND_BYTES_MAX } from '../../../shared/sounds'
import { isInside, modelFolder } from '../meshy/download'

/**
 * A sound ElevenLabs made, saved into its thread's folder (ADR-0205; the plugins plan's slice 12, part 2). ElevenLabs
 * answers a request with the MP3 itself, so the answer is written straight to a part file of its own inside the folder
 * the thread asked for, which is inside the thread's working folder, and given its name only once it is whole: never
 * over a file that is already there, and never through a folder swapped for a link elsewhere. Each sound is capped.
 * One gap remains, as for a 3D model's files: a folder moved out of the thread's folder while a sound is written takes
 * Sotto's part file with it. Nothing is named there, and the sound is refused.
 */
export const SOUND_FOLDER = 'sounds'
/** The most one sound may be, shared with a host's sounds read over the connection. */
export { SOUND_BYTES_MAX }
/** How many names are tried before a sound is refused for want of one: "Name.mp3", then "Name 2.mp3" and on. */
const NAMES_TRIED = 100

/**
 * What went wrong, in one word. `folder`: the folder is not inside the thread's working folder, or the file could not
 * be written there. `too-large`: past the cap. `unreachable`: the answer stopped before it was whole.
 */
export type SoundSaveProblem = 'folder' | 'too-large' | 'unreachable'
export class SoundSaveError extends Error {
  constructor(readonly problem: SoundSaveProblem) { super(`elevenlabs-save-${problem}`) }
}

/** A sound's name as a file name: nothing Windows refuses, at most 80 characters, and never empty or reserved. */
export function soundFileBase(name: string): string {
  const cleaned = name.normalize('NFC').replace(/[\\/:*?"<>|\p{Cc}]+/gu, '-').replace(/\s+/gu, ' ').trim()
  let base = Array.from(cleaned).slice(0, 80).join('').replace(/^[\s.-]+|[\s.]+$/gu, '')
  if (base.length === 0) base = 'sound'
  if (/^(?:con|prn|aux|nul|com\d|lpt\d)$/iu.test(base)) base = `${base}-sound`
  return base
}

/** Where a saved sound is, and how many bytes it is. */
export interface SavedSound { readonly folder: string; readonly fileName: string; readonly bytes: number }

/**
 * Writes ElevenLabs' answer into `folder`, relative to the thread's working folder `root`, as `<name>.mp3`, or the
 * first of "<name> 2.mp3" and on that is free. The folder is made if it is not there. Node opens files by path alone,
 * so the folder is checked against the thread's working folder before the part file is made, once it is open, and the
 * finished file once named: a folder swapped for a link at any step has what Sotto wrote there removed, and nothing is
 * saved.
 */
export async function saveSound(answer: Response, target: { readonly root: string; readonly folder: string; readonly name: string },
  options: { readonly maxBytes?: number } = {}): Promise<SavedSound> {
  const body = answer.body
  if (!body) throw new SoundSaveError('unreachable')
  const maxBytes = options.maxBytes ?? SOUND_BYTES_MAX
  const length = Number(answer.headers.get('content-length'))
  if (Number.isFinite(length) && length > maxBytes) {
    await body.cancel().catch(() => undefined)
    throw new SoundSaveError('too-large')
  }
  let realRoot: string
  let realFolder: string
  try {
    realRoot = await realpath(target.root)
    realFolder = await modelFolder(realRoot, target.folder)
  } catch {
    await body.cancel().catch(() => undefined)
    throw new SoundSaveError('folder')
  }
  /** Whether a path, as it resolves now, is inside the thread's working folder. */
  const stillInside = async (path: string): Promise<boolean> => { try { return isInside(realRoot, await realpath(path)) } catch { return false } }
  const base = soundFileBase(target.name)
  const partPath = join(realFolder, `.sotto-sound-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.part`)
  let file: Awaited<ReturnType<typeof open>>
  try { file = await open(partPath, 'wx', 0o644) } catch {
    await body.cancel().catch(() => undefined)
    throw new SoundSaveError('folder')
  }
  let finished = false
  let written = 0
  const reader = body.getReader()
  try {
    // The file just opened, by where it really is: one opened through a swapped folder is outside, and refused.
    if (!await stillInside(partPath)) throw new SoundSaveError('folder')
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try { chunk = await reader.read() } catch { throw new SoundSaveError('unreachable') }
      if (chunk.done) break
      written += chunk.value.byteLength
      if (written > maxBytes) throw new SoundSaveError('too-large')
      // A write may take part of a chunk: the rest is written until the whole of it is in (Sol's review).
      try {
        for (let at = 0; at < chunk.value.byteLength;) {
          const { bytesWritten } = await file.write(chunk.value, at, chunk.value.byteLength - at)
          if (bytesWritten <= 0) throw new SoundSaveError('folder')
          at += bytesWritten
        }
      } catch { throw new SoundSaveError('folder') }
    }
    if (written === 0) throw new SoundSaveError('unreachable')
    finished = true
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined)
    await file.close().catch(() => undefined)
    if (!finished) await rm(partPath, { force: true }).catch(() => undefined)
  }
  try {
    if (!await stillInside(partPath)) throw new SoundSaveError('folder')
    for (let tried = 1; tried <= NAMES_TRIED; tried++) {
      const fileName = tried === 1 ? `${base}.mp3` : `${base} ${tried}.mp3`
      const path = join(realFolder, fileName)
      if (!await publish(partPath, path)) continue
      if (!await stillInside(path)) {
        await rm(path, { force: true }).catch(() => undefined)
        throw new SoundSaveError('folder')
      }
      return { folder: realFolder, fileName, bytes: written }
    }
    throw new SoundSaveError('folder')
  } finally { await rm(partPath, { force: true }).catch(() => undefined) }
}

/**
 * Gives a whole part file a name, never over a file already there, and never so that the name holds part of a sound:
 * a second link to it where the disk allows one. Where it does not, the name is taken first as an empty file of
 * Sotto's own, and a whole copy of the part file is moved over it in one step (Sol's review). False when the name is
 * taken.
 */
async function publish(partPath: string, path: string): Promise<boolean> {
  const taken = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
  try { await link(partPath, path); return true } catch (error) { if (taken(error)) return false }
  try { await (await open(path, 'wx', 0o644)).close() } catch (error) {
    if (taken(error)) return false
    throw new SoundSaveError('folder')
  }
  const copy = `${partPath}.copy`
  try {
    await copyFile(partPath, copy, constants.COPYFILE_EXCL)
    await rename(copy, path)
    return true
  } catch {
    await rm(copy, { force: true }).catch(() => undefined)
    await rm(path, { force: true }).catch(() => undefined)
    throw new SoundSaveError('folder')
  }
}
