import { createHash } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { MESHY_PHOTO_BYTES_MAX } from './api'
import { isInside } from './download'

/**
 * A photo a thread asks Meshy to make a 3D model from (ADR-0141): a JPEG or PNG file inside the thread's working
 * folder, of at most Meshy's 20 MB. It is checked when the agent asks, and checked again right before it is sent: one
 * that moved, changed or grew since is refused. What is sent is the photo redrawn, which carries none of its location
 * or camera details, as a data address and never as a link to somewhere else.
 */

/** Why a photo is not sent: outside the thread's folder, not there, not a JPEG or PNG, too large, or changed since. */
export type PhotoProblem = 'outside' | 'missing' | 'kind' | 'too-large' | 'changed' | 'unreadable'

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
  try {
    const file = await open(real, 'r')
    try {
      const info = await file.stat()
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
  // Where the path leads once it has been read: a folder swapped for a link meanwhile leads somewhere else.
  const after = await realpath(named).catch(() => null)
  if (after !== real) return 'changed'
  const kind = kindOf(bytes)
  if (kind === null) return 'kind'
  return { path: real, bytes, kind }
}

/** A JPEG or PNG by its first bytes, whatever its name says. */
function kindOf(bytes: Buffer): CheckedPhoto['kind'] | null {
  if (bytes.byteLength >= 3 && bytes.subarray(0, 3).equals(JPEG)) return 'image/jpeg'
  if (bytes.byteLength >= 8 && bytes.subarray(0, 8).equals(PNG)) return 'image/png'
  return null
}
