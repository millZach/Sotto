import { createHash } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { MESHY_PHOTO_BYTES_MAX } from './api'
import { isInside } from './download'

/**
 * A photo a thread asks Meshy to make a 3D model from (ADR-0141): a JPEG or PNG file inside the thread's working
 * folder, of at most Meshy's 20 MB. It is checked when the agent asks, and checked again right before it is sent: one
 * that moved, changed or grew since is refused. What is sent is the photo redrawn, which carries none of its location
 * or camera details, as a data address and never as a link to somewhere else.
 */

/**
 * Why a photo is not sent: outside the thread's folder, not there, not a JPEG or PNG, too large in bytes, too many
 * pixels to draw again, or changed since.
 */
export type PhotoProblem = 'outside' | 'missing' | 'kind' | 'too-large' | 'too-many-pixels' | 'changed' | 'unreadable'

/**
 * The most pixels a photo may have, read from its header before anything decodes it (Bug Bot on #2594, L1): drawing
 * it again holds every pixel in main, so a small file that asks for a huge picture would stall or end Sotto. 40 million
 * covers a 48-megapixel phone camera's 12-megapixel photos many times over, and a side of 10,000 covers any of them.
 */
export const PHOTO_PIXELS_MAX = 40_000_000
export const PHOTO_SIDE_MAX = 10_000

/** A photo as it was when the agent asked: where it really is, what it was then, and a fingerprint of its bytes. */
export interface CheckedPhoto {
  readonly path: string
  readonly fileName: string
  readonly size: number
  readonly kind: 'image/jpeg' | 'image/png'
  /** The SHA-256 of the bytes checked: what is sent must be these bytes, wherever they are read from. */
  readonly sha256: string
}

/** A photo redrawn: its pixels again, in a JPEG or PNG of their own. Null when it could not be read as one. */
export type RedrawPhoto = (bytes: Buffer, kind: CheckedPhoto['kind']) => Promise<{ readonly bytes: Buffer; readonly kind: CheckedPhoto['kind'] } | null>

const JPEG = Buffer.from([0xff, 0xd8, 0xff])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The photo at `path`, relative to the thread's working folder `root`, as it is now, or why it is not sent. */
export async function checkPhoto(root: string, path: string): Promise<CheckedPhoto | PhotoProblem> {
  const read = await readPhoto(root, path)
  if (typeof read === 'string') return read
  return { path: read.path, fileName: basename(read.path), size: read.bytes.byteLength, kind: read.kind, sha256: createHash('sha256').update(read.bytes).digest('hex') }
}

/**
 * The photo once more, right before it goes: read again from inside the thread's folder, and refused unless its bytes
 * are the very ones checked, so a photo swapped since, for another file or through a link, is never sent. Then
 * redrawn and written as a data address of at most Meshy's 20 MB.
 */
export async function photoToSend(root: string, checked: CheckedPhoto, relativePath: string, redraw: RedrawPhoto): Promise<{ readonly photo: string } | PhotoProblem> {
  const now = await readPhoto(root, relativePath)
  if (typeof now === 'string') return now === 'missing' || now === 'outside' ? 'changed' : now
  if (now.path !== checked.path || now.kind !== checked.kind || createHash('sha256').update(now.bytes).digest('hex') !== checked.sha256) return 'changed'
  const drawn = await redraw(now.bytes, now.kind).catch(() => null)
  if (!drawn) return 'unreadable'
  if (drawn.bytes.byteLength > MESHY_PHOTO_BYTES_MAX) return 'too-large'
  return { photo: `data:${drawn.kind};base64,${drawn.bytes.toString('base64')}` }
}

/**
 * The photo's bytes, read through one open file of at most 20 MB, and where that file really is: checked inside the
 * thread's folder before it is opened and again once it has been read.
 */
async function readPhoto(root: string, path: string): Promise<{ readonly path: string; readonly bytes: Buffer; readonly kind: CheckedPhoto['kind'] } | PhotoProblem> {
  if (path.includes('\0')) return 'outside'
  let realRoot: string
  try { realRoot = await realpath(root) } catch { return 'outside' }
  const named = isAbsolute(path) ? path : resolve(realRoot, path)
  let real: string
  try { real = await realpath(named) } catch { return 'missing' }
  if (!isInside(realRoot, real)) return 'outside'
  let bytes: Buffer
  let opened: { readonly dev: number; readonly ino: number }
  try {
    const file = await open(real, 'r')
    try {
      const info = await file.stat()
      opened = { dev: info.dev, ino: info.ino }
      if (!info.isFile()) return 'missing'
      if (info.size > MESHY_PHOTO_BYTES_MAX) return 'too-large'
      const buffer = Buffer.alloc(Math.min(info.size, MESHY_PHOTO_BYTES_MAX) + 1)
      let filled = 0
      for (;;) {
        const { bytesRead } = await file.read(buffer, filled, buffer.length - filled, filled)
        if (bytesRead === 0) break
        filled += bytesRead
        if (filled > MESHY_PHOTO_BYTES_MAX) return 'too-large'
        if (filled === buffer.length) break
      }
      bytes = buffer.subarray(0, filled)
    } finally { await file.close() }
  } catch { return 'unreadable' }
  // Where the path leads once it has been read: a folder swapped for a link meanwhile leads somewhere else, or to
  // another file than the one that was open.
  const after = await realpath(named).catch(() => null)
  if (after !== real) return 'changed'
  const now = await stat(real).catch(() => null)
  if (!now || now.dev !== opened.dev || now.ino !== opened.ino) return 'changed'
  const kind = kindOf(bytes)
  if (kind === null) return 'kind'
  const size = pixelsOf(bytes, kind)
  if (!size) return 'kind'
  if (size.width > PHOTO_SIDE_MAX || size.height > PHOTO_SIDE_MAX || size.width * size.height > PHOTO_PIXELS_MAX) return 'too-many-pixels'
  return { path: real, bytes, kind }
}

/**
 * A photo's size in pixels, from its header alone: a PNG's IHDR, or a JPEG's first start-of-frame. Null when the header
 * cannot be read, which is not drawn either.
 */
export function pixelsOf(bytes: Buffer, kind: CheckedPhoto['kind']): { readonly width: number; readonly height: number } | null {
  if (kind === 'image/png') {
    // The IHDR chunk comes first, right after the signature: its length, its name, then width and height.
    if (bytes.byteLength < 24 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  let at = 2
  while (at + 4 <= bytes.byteLength) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1]!
    // Fill bytes, and the markers that stand alone with no length.
    if (marker === 0xff) { at++; continue }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { at += 2; continue }
    const length = bytes.readUInt16BE(at + 2)
    if (length < 2) return null
    // A start of frame, of any kind but the three that share its range and are not one.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > bytes.byteLength) return null
      return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) }
    }
    at += 2 + length
  }
  return null
}

/** A JPEG or PNG by its first bytes, whatever its name says. */
function kindOf(bytes: Buffer): CheckedPhoto['kind'] | null {
  if (bytes.byteLength >= 3 && bytes.subarray(0, 3).equals(JPEG)) return 'image/jpeg'
  if (bytes.byteLength >= 8 && bytes.subarray(0, 8).equals(PNG)) return 'image/png'
  return null
}
