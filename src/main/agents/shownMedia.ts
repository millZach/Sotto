import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { AGENT_VIDEO_MAX_BYTES, MAX_ACTIVITY_MEDIA, type AgentActivityMedia } from '../../shared/agentActivity'
import { AGENT_MAX_IMAGE_BYTES } from '../../shared/agents'
import type { ThreadMediaStore, WrittenVideoFile } from './threadMedia'

/**
 * Pictures and videos an agent shows in its thread (ADR-0170, request-only amendment of November 1, 2026): the files it
 * names through `sotto_media`'s `show_in_thread`, which it calls only when the user asked to see one. Nothing is looked
 * for on its own. A picture is kept in the thread media store as any picture is; a video stays where it is.
 */
/** A file the agent named: where it is and what its last change says of it. */
export interface MediaFile { readonly path: string; readonly sizeBytes: number; readonly modifiedMs: number }

/** The video type a file's first bytes say it is, of the three a tile plays: MP4, QuickTime (both `ftyp`) and WebM. */
export function videoTypeOf(head: Uint8Array): AgentActivityMedia['mimeType'] | undefined {
  const text = Buffer.from(head.subarray(0, 64)).toString('latin1')
  if (text.slice(4, 8) === 'ftyp') return text.slice(8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4'
  // WebM is Matroska (EBML) whose document type says `webm`; other Matroska files are not played.
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return text.includes('webm') ? 'video/webm' : undefined
  return undefined
}

/**
 * A video's handle, its digest the SHA-256 of the whole file, read once in parts so main is never held; or none
 * when it is not a video a tile plays, is over `AGENT_VIDEO_MAX_BYTES`, or changed while it was read. The handle names no
 * path: where the video is goes to the store (`keepVideo`), on this host alone.
 */
export async function videoHandle(path: string, index: number, file: MediaFile): Promise<{ handle: AgentActivityMedia; file: WrittenVideoFile } | undefined> {
  if (file.sizeBytes > AGENT_VIDEO_MAX_BYTES) return undefined
  const handle = await open(path, 'r').catch(() => undefined)
  if (!handle) return undefined
  try {
    const head = Buffer.alloc(64)
    await handle.read(head, 0, 64, 0)
    const mimeType = videoTypeOf(head)
    if (!mimeType) return undefined
    const hash = createHash('sha256')
    const part = Buffer.alloc(1024 * 1024)
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(part, 0, part.length, position)
      if (bytesRead === 0) break
      hash.update(part.subarray(0, bytesRead)); position += bytesRead
      if (position > file.sizeBytes) return undefined
    }
    const after = await handle.stat()
    if (position !== file.sizeBytes || after.size !== file.sizeBytes || after.mtimeMs !== file.modifiedMs) return undefined
    return { handle: { id: `m${index}`, digest: hash.digest('hex'), kind: 'video', mimeType, sizeBytes: file.sizeBytes, name: basename(path).slice(0, 200) || 'video', source: 'file' },
      file: { path, sizeBytes: file.sizeBytes, modifiedMs: file.modifiedMs } }
  } catch { return undefined } finally { await handle.close().catch(() => undefined) }
}

/** What keeps a shown picture and remembers where a shown video is: the thread media store. */
export type ShownMediaStore = Pick<ThreadMediaStore, 'captureFile' | 'keepVideo'>

/** Why one named file is not shown, in words the agent is told. */
export type ShownRefusal = 'missing' | 'not-media' | 'too-large'
/** What one call shows: each file kept by handle, and each one refused with why. */
export interface ShownMedia {
  readonly media: AgentActivityMedia[]
  readonly refused: { readonly path: string; readonly reason: ShownRefusal }[]
}

/**
 * The pictures and videos at `paths`, each relative to `folder` or absolute, kept for the thread: a video (MP4, QuickTime
 * or WebM by its first bytes, up to `AGENT_VIDEO_MAX_BYTES`) as a handle whose file the store remembers, a picture (up
 * to the image limit, its type from its own bytes) captured into the store. A file that is gone, is neither, or is too
 * large is refused and named. The same file named twice is shown once.
 */
export async function shownMedia(folder: string | undefined, paths: readonly string[], store: ShownMediaStore): Promise<ShownMedia> {
  const media: AgentActivityMedia[] = [], refused: ShownMedia['refused'] = [], seen = new Set<string>()
  for (const path of paths.slice(0, MAX_ACTIVITY_MEDIA)) {
    const absolute = isAbsolute(path) ? path : folder ? resolve(folder, path) : undefined
    if (!absolute || seen.has(absolute)) { if (!absolute) refused.push({ path, reason: 'missing' }); continue }
    seen.add(absolute)
    const info = await stat(absolute).catch(() => undefined)
    if (!info?.isFile() || info.size === 0) { refused.push({ path, reason: 'missing' }); continue }
    const file = { path: absolute, sizeBytes: info.size, modifiedMs: info.mtimeMs }
    const head = await readHead(absolute)
    let handle: AgentActivityMedia | undefined
    if (head && videoTypeOf(head)) {
      if (info.size > AGENT_VIDEO_MAX_BYTES) { refused.push({ path, reason: 'too-large' }); continue }
      const video = await videoHandle(absolute, media.length, file)
      if (video) { store.keepVideo(video.handle.digest, video.file); handle = video.handle }
    } else {
      if (info.size > AGENT_MAX_IMAGE_BYTES) { refused.push({ path, reason: 'too-large' }); continue }
      handle = (await store.captureFile(absolute, 'file'))[0]
    }
    if (!handle) { refused.push({ path, reason: 'not-media' }); continue }
    // The store names a picture by its place among the ones it was given; here it is its place among the call's.
    media.push({ ...handle, id: `m${media.length}`, name: basename(absolute).slice(0, 200) || handle.name })
  }
  return { media, refused }
}

/** A file's first 64 bytes, or undefined when it cannot be read. */
async function readHead(path: string): Promise<Uint8Array | undefined> {
  const file = await open(path, 'r').catch(() => undefined)
  if (!file) return undefined
  try { const head = Buffer.alloc(64); const { bytesRead } = await file.read(head, 0, 64, 0); return head.subarray(0, bytesRead) }
  catch { return undefined } finally { await file.close().catch(() => undefined) }
}

/**
 * `length` bytes of a shown video from `start`, read from its file only while that is still the file the store
 * remembered: the same size, changed last when it was found. Undefined otherwise, or past its end.
 */
export async function readVideo(video: WrittenVideoFile, start: number, length: number): Promise<Buffer | undefined> {
  if (start < 0 || start >= video.sizeBytes || length < 1) return undefined
  const file = await open(video.path, 'r').catch(() => undefined)
  if (!file) return undefined
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size !== video.sizeBytes || info.mtimeMs !== video.modifiedMs) return undefined
    const bytes = Buffer.alloc(Math.min(length, video.sizeBytes - start))
    let read = 0
    while (read < bytes.length) {
      const { bytesRead } = await file.read(bytes, read, bytes.length - read, start + read)
      if (bytesRead === 0) return undefined
      read += bytesRead
    }
    return bytes
  } catch { return undefined } finally { await file.close().catch(() => undefined) }
}
