import { open, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isInside, MODEL_FILE_BYTES_MAX } from './download'
import type { ThreeDModel } from './records'

/**
 * Reading a 3D model's own files back for the window that draws it (ADR-0141). A file is read only by a name its record
 * holds, from its folder, and only while that folder, and the file through any link, is still inside the thread's
 * working folder: a folder swapped for a link elsewhere since the files were saved is refused, as the download refuses
 * one. Each file is capped at the size a download takes.
 */

type Place = Pick<ThreeDModel, 'root' | 'folder' | 'files'>

/** The real folder, while it is still inside the thread's working folder; undefined otherwise. */
async function realFolder(model: Place): Promise<{ readonly root: string; readonly folder: string } | undefined> {
  try {
    const [root, folder] = await Promise.all([realpath(model.root), realpath(model.folder)])
    return isInside(root, folder) ? { root, folder } : undefined
  } catch { return undefined }
}

/** One of the 3D model's files, whole, or null when it is not its own, is gone, is outside, or is past the cap. */
export async function readModelFile(model: Place, name: string, maxBytes = MODEL_FILE_BYTES_MAX): Promise<Uint8Array | null> {
  if (!model.files.includes(name)) return null
  const place = await realFolder(model)
  if (!place) return null
  const path = join(place.folder, name)
  /** The file as it resolves now, through any link, is in the 3D model's folder. */
  const stillInside = async (): Promise<boolean> => { try { return isInside(place.folder, await realpath(path)) && isInside(place.root, await realpath(model.folder)) } catch { return false } }
  if (!await stillInside()) return null
  let file: Awaited<ReturnType<typeof open>>
  try { file = await open(path, 'r') } catch { return null }
  try {
    // Opened by path, so the folder and the file are looked at again once it is open.
    if (!await stillInside()) return null
    const info = await file.stat()
    if (!info.isFile() || info.size === 0 || info.size > maxBytes) return null
    const bytes = new Uint8Array(info.size)
    let read = 0
    while (read < bytes.byteLength) {
      const { bytesRead } = await file.read(bytes, read, bytes.byteLength - read, read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return read === bytes.byteLength ? bytes : null
  } catch { return null } finally { await file.close().catch(() => undefined) }
}

/** Each file's size as it is now, by name; a file that is gone or outside the thread's working folder has none. */
export async function modelFileSizes(model: Place): Promise<ReadonlyMap<string, number>> {
  const sizes = new Map<string, number>()
  const place = await realFolder(model)
  if (!place) return sizes
  await Promise.all(model.files.map(async name => {
    try {
      const path = join(place.folder, name)
      if (!isInside(place.folder, await realpath(path))) return
      const info = await stat(path)
      if (info.isFile()) sizes.set(name, info.size)
    } catch { /* Gone: no size. */ }
  }))
  return sizes
}
