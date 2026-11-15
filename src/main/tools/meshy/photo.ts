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

/** Why a photo is not sent: outside the thread's folder, not there, not a JPEG or PNG, too large, or changed since. */
export type PhotoProblem = 'outside' | 'missing' | 'kind' | 'too-large' | 'changed' | 'unreadable'

/** A photo as it was when the agent asked: where it really is, and what it was then. */
export interface CheckedPhoto {
  readonly path: string
  readonly fileName: string
  readonly size: number
  readonly modifiedMs: number
  readonly kind: 'image/jpeg' | 'image/png'
}

/** A photo redrawn: its pixels again, in a JPEG or PNG of their own. Null when it could not be read as one. */
export type RedrawPhoto = (bytes: Buffer, kind: CheckedPhoto['kind']) => Promise<{ readonly bytes: Buffer; readonly kind: CheckedPhoto['kind'] } | null>

const JPEG = Buffer.from([0xff, 0xd8, 0xff])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The photo at `path`, relative to the thread's working folder `root`, as it is now, or why it is not sent. */
export async function checkPhoto(root: string, path: string): Promise<CheckedPhoto | PhotoProblem> {
  if (path.includes('\0')) return 'outside'
  let realRoot: string
  try { realRoot = await realpath(root) } catch { return 'outside' }
  const named = isAbsolute(path) ? path : resolve(realRoot, path)
  let real: string
  try { real = await realpath(named) } catch { return 'missing' }
  if (!isInside(realRoot, real)) return 'outside'
  let info: Awaited<ReturnType<typeof stat>>
  try { info = await stat(real) } catch { return 'missing' }
  if (!info.isFile()) return 'missing'
  if (info.size > MESHY_PHOTO_BYTES_MAX) return 'too-large'
  const kind = await kindOf(real)
  if (kind === null) return 'kind'
  return { path: real, fileName: basename(real), size: info.size, modifiedMs: info.mtimeMs, kind }
}

/**
 * The photo once more, right before it goes: refused if it is no longer the file that was checked, then redrawn and
 * written as a data address of at most Meshy's 20 MB.
 */
export async function photoToSend(root: string, checked: CheckedPhoto, relativePath: string, redraw: RedrawPhoto): Promise<{ readonly photo: string } | PhotoProblem> {
  const now = await checkPhoto(root, relativePath)
  if (typeof now === 'string') return now === 'missing' || now === 'outside' ? 'changed' : now
  if (now.path !== checked.path || now.size !== checked.size || now.modifiedMs !== checked.modifiedMs || now.kind !== checked.kind) return 'changed'
  let bytes: Buffer
  try {
    const file = await open(now.path, 'r')
    try { bytes = await file.readFile() } finally { await file.close() }
  } catch { return 'unreadable' }
  if (bytes.byteLength !== checked.size) return 'changed'
  const drawn = await redraw(bytes, now.kind).catch(() => null)
  if (!drawn) return 'unreadable'
  if (drawn.bytes.byteLength > MESHY_PHOTO_BYTES_MAX) return 'too-large'
  return { photo: `data:${drawn.kind};base64,${drawn.bytes.toString('base64')}` }
}

/** A JPEG or PNG by its first bytes, whatever its name says. */
async function kindOf(path: string): Promise<CheckedPhoto['kind'] | null> {
  try {
    const file = await open(path, 'r')
    try {
      const head = Buffer.alloc(8)
      const { bytesRead } = await file.read(head, 0, 8, 0)
      if (bytesRead >= 3 && head.subarray(0, 3).equals(JPEG)) return 'image/jpeg'
      if (bytesRead === 8 && head.equals(PNG)) return 'image/png'
      return null
    } finally { await file.close() }
  } catch { return null }
}
