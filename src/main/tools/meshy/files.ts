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
  const named = join(place.folder, name)
  let real: string
  try { real = await realpath(named) } catch { return null }
  if (!isInside(place.folder, real)) return null
  let bytes: Uint8Array
  let opened: { readonly dev: bigint; readonly ino: bigint }
  try {
    const file = await open(real, 'r')
    try {
      const info = await file.stat({ bigint: true })
      opened = { dev: info.dev, ino: info.ino }
      if (!info.isFile() || info.size === 0n || info.size > BigInt(maxBytes)) return null
      bytes = new Uint8Array(Number(info.size))
      let read = 0
      while (read < bytes.byteLength) {
        const { bytesRead } = await file.read(bytes, read, bytes.byteLength - read, read)
        if (bytesRead === 0) break
        read += bytesRead
      }
      if (read !== bytes.byteLength) return null
    } finally { await file.close().catch(() => undefined) }
  } catch { return null }
  // Node opens by path, so the file that was open is bound to where the path leads now: a folder swapped for a link
  // while it was opened, and put back since, leaves the path leading to another file than the one read, and nothing is
  // handed over. The folder is looked at once more against the thread's working folder too.
  const after = await realpath(named).catch(() => null)
  if (after !== real || !(await realFolder(model))) return null
  const now = await stat(real, { bigint: true }).catch(() => null)
  if (!now || now.dev !== opened.dev || now.ino !== opened.ino) return null
  return bytes
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

/**
 * Where one of the 3D model's files is, to show it in the folder app: its real path, only by a name its record holds,
 * only while its folder is inside the thread's working folder and the file, through any link, is inside its folder.
 * Null when it is not its own, is gone, is not a file, or is outside.
 */
export async function modelFilePath(model: Place, name: string): Promise<string | null> {
  if (!model.files.includes(name)) return null
  const place = await realFolder(model)
  if (!place) return null
  try {
    const real = await realpath(join(place.folder, name))
    if (!isInside(place.folder, real)) return null
    return (await stat(real)).isFile() ? real : null
  } catch { return null }
}
