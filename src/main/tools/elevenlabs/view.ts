import { stat } from 'node:fs/promises'
import type { SoundView } from '../../../shared/sounds'
import { modelFilePath, readModelFile } from '../meshy/files'
import type { SoundRecord } from './records'
import { SOUND_BYTES_MAX } from './save'

/**
 * A sound as the window draws it in its thread (ADR-0205; the plugins plan's slice 12, part 3), the MP3 it plays, and
 * its file shown in the folder app. The window names a sound by its ID alone and is handed its name, size and bytes,
 * never a path. The file is read only by the name its record holds, from its record's folder, while that folder, and
 * the file through any link, is inside the thread's working folder: the same checked read a 3D model's files have,
 * capped at the most a sound is saved at.
 */

/** What the view, the bytes and the reveal are read from: the records, and the thread's working folder as it is now. */
export interface SoundViewSource {
  sound(id: string): Promise<SoundRecord | undefined>
  /** The thread's working folder now, for a record kept before records held their own; null when there is none. */
  folderOf(threadId: string): Promise<string | null>
}

/** Where a made sound's MP3 is, as the 3D model's checked reads take it; undefined when there is no file to look for. */
async function placeOf(source: SoundViewSource, sound: SoundRecord): Promise<{ readonly place: { root: string; folder: string; files: string[] }; readonly name: string } | undefined> {
  if (sound.state !== 'made' || !sound.fileName) return undefined
  const root = sound.root ?? await source.folderOf(sound.threadId).catch(() => null)
  return root ? { place: { root, folder: sound.folder, files: [sound.fileName] }, name: sound.fileName } : undefined
}

/** The file's real path, size and when it was saved, while it is there and inside; undefined otherwise. */
async function fileOf(source: SoundViewSource, sound: SoundRecord): Promise<{ readonly path: string; readonly bytes: number; readonly madeAt: string } | undefined> {
  const found = await placeOf(source, sound)
  if (!found) return undefined
  const path = await modelFilePath(found.place, found.name)
  if (!path) return undefined
  try {
    const info = await stat(path)
    return { path, bytes: info.size, madeAt: info.mtime.toISOString() }
  } catch { return undefined }
}

/** A sound's view: its words only while the record keeps them, and its file's size as it is now, which a gone file lacks. */
export async function soundView(source: SoundViewSource, sound: SoundRecord): Promise<SoundView> {
  const file = await fileOf(source, sound)
  return {
    id: sound.id, name: sound.name, kind: sound.kind, state: sound.state, cost: sound.cost,
    ...(sound.failure ? { failure: sound.failure } : {}),
    ...(sound.voice ? { voice: sound.voice } : {}),
    ...(sound.words !== undefined ? { words: sound.words } : {}),
    ...(sound.state === 'made' && sound.fileName ? { fileName: sound.fileName } : {}),
    ...(file ? { bytes: file.bytes, madeAt: file.madeAt } : {}),
  }
}

/**
 * What tells the window each time a sound's record changes, so its line moves from making to made or failed: the
 * view of the record as the service says it is now, sent in order, so a slower one never lands after a newer one. A
 * sound whose record went meanwhile, as its thread was forgotten, is not shown again.
 */
export function soundViewPush(source: SoundViewSource, send: (view: SoundView) => void): (sound: SoundRecord) => Promise<void> {
  let sent: Promise<void> = Promise.resolve()
  return sound => {
    sent = sent.then(async () => await source.sound(sound.id) ? await soundView(source, sound) : null)
      .then(view => { if (view) send(view) }, () => undefined)
    return sent
  }
}

/** A sound's view by its ID, as it stands now, or null when Sotto holds no such sound. */
export async function soundViewOf(source: SoundViewSource, id: string): Promise<SoundView | null> {
  const sound = await source.sound(id)
  return sound ? soundView(source, sound) : null
}

/** Whether bytes open as an MP3 does: an ID3 tag, or an MPEG audio frame's sync. */
export function looksLikeMp3(bytes: Uint8Array): boolean {
  if (bytes.byteLength >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true
  return bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0
}

/**
 * A made sound's MP3, whole, or null when the sound or its file is gone, the folder or the file is no longer inside the
 * thread's working folder, the file is past the cap, or it is not an MP3.
 */
export async function soundBytes(source: SoundViewSource, id: string, maxBytes = SOUND_BYTES_MAX): Promise<Uint8Array | null> {
  const sound = await source.sound(id)
  if (!sound) return null
  const found = await placeOf(source, sound)
  if (!found) return null
  const bytes = await readModelFile(found.place, found.name, maxBytes)
  return bytes && looksLikeMp3(bytes) ? bytes : null
}

/** Shows a made sound's MP3 in the folder app, by its record's own path, checked as the bytes are. False when there is none. */
export async function revealSoundFile(source: SoundViewSource, id: string, reveal: (path: string) => void): Promise<boolean> {
  const sound = await source.sound(id)
  const file = sound ? await fileOf(source, sound) : undefined
  if (!file) return false
  reveal(file.path)
  return true
}
