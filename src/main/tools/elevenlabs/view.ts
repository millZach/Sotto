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
  // The record holds no working folder, so a build from before the line reads it whole and keeps counting its cost
  // (Sol's review): its folder is checked against the thread's working folder as it is now.
  const root = await source.folderOf(sound.threadId).catch(() => null)
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
    // The record as it is now, not as it was told: words cleared since are not sent again (Sol's review).
    sent = sent.then(async () => { const now = await source.sound(sound.id); return now ? await soundView(source, now) : null })
      .then(view => { if (view) send(view) }, () => undefined)
    return sent
  }
}

/** A sound's view by its ID, as it stands now, or null when Sotto holds no such sound. */
export async function soundViewOf(source: SoundViewSource, id: string): Promise<SoundView | null> {
  const sound = await source.sound(id)
  return sound ? soundView(source, sound) : null
}

/**
 * Whether bytes open as an MP3 does: an MPEG audio Layer III frame header, with a version, bitrate and sample rate
 * that exist, at the start or right after an ID3v2 tag. AAC, another layer, or a tag with nothing after it is not one
 * (Sol's review).
 */
export function looksLikeMp3(bytes: Uint8Array): boolean {
  let at = 0
  if (bytes.byteLength >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const version = bytes[3]!
    const size = [bytes[6]!, bytes[7]!, bytes[8]!, bytes[9]!]
    if (version < 2 || version > 4 || size.some(byte => byte >= 0x80)) return false
    // The tag's size is syncsafe, seven bits a byte; a footer adds ten more.
    at = 10 + ((size[0]! << 21) | (size[1]! << 14) | (size[2]! << 7) | size[3]!) + ((bytes[5]! & 0x10) !== 0 ? 10 : 0)
  }
  return isLayer3Header(bytes, at)
}

/** An MPEG audio frame header at `at`: the sync, a version that exists, Layer III, and a bitrate and sample rate that do. */
function isLayer3Header(bytes: Uint8Array, at: number): boolean {
  if (bytes.byteLength < at + 4) return false
  const [b0, b1, b2] = [bytes[at]!, bytes[at + 1]!, bytes[at + 2]!]
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return false
  const version = (b1 >> 3) & 0x03, layer = (b1 >> 1) & 0x03
  const bitrate = (b2 >> 4) & 0x0f, rate = (b2 >> 2) & 0x03
  return version !== 0x01 && layer === 0x01 && bitrate !== 0x00 && bitrate !== 0x0f && rate !== 0x03
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
