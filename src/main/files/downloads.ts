import { randomBytes } from 'node:crypto'
import { mkdir, open, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { FileDownload, FileDownloadProgress, FileDownloadRequest, FileDownloadStopped, FilesError, FilesResult, LinkedFile, LinkedFileRequest } from '../../shared/files'

export interface FileDownloadDependencies {
  /** One part of the file from the paired host its thread runs on. */
  part(request: Extract<LinkedFileRequest, { want: 'part' }>): Promise<FilesResult<LinkedFile>>
  /** This computer's Downloads folder. */
  folder(): string
  progress(progress: FileDownloadProgress): void
}

const KEPT = 50
const refusal = (code: FilesError['code'], message: string): { ok: false; error: FilesError } => ({ ok: false, error: { code, message } })
const NOT_SAVED = msg`The download did not finish. Nothing was saved. Try again.`
const STOPPED = msg`Download stopped. Nothing was saved.`
const NO_FOLDER = msg`Sotto could not write to the Downloads folder. Nothing was saved.`

/**
 * A name this computer can save under, from the name a host gave: no folder separators, control characters or characters
 * Windows refuses, no trailing dot or space, and never one of Windows' device names. A name that is already one is kept,
 * a leading dot included.
 */
export function downloadName(name: string): string {
  // eslint-disable-next-line no-control-regex -- A file name must not carry control characters.
  const clean = name.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/gu, '_').slice(0, 200).replace(/[. ]+$/u, '')
  if (!clean) return 'download'
  return /^(?:con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(clean) ? `_${clean}` : clean
}
/** `report.pdf`, then `report (1).pdf`, as a browser numbers a name already taken. */
function numbered(name: string, count: number): string {
  if (count === 0) return name
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} (${count})${name.slice(dot)}` : `${name} (${count})`
}
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false)
/** Every byte, however many writes the system takes for them: one write may take fewer than it was handed. */
async function writeAll(file: FileHandle, bytes: Buffer): Promise<void> {
  for (let written = 0; written < bytes.length;) {
    const { bytesWritten } = await file.write(bytes, written, bytes.length - written)
    if (bytesWritten <= 0) throw new Error('Nothing was written.')
    written += bytesWritten
  }
}

/**
 * Saves files from paired hosts to this computer's Downloads folder (ADR-0120, November 12 amendment). The bytes come part
 * by part into a `.part` file beside the name they will have, which takes that name only once every part has arrived, so a
 * download that stops or fails leaves nothing behind. The window names a download by its thread and path and a saved file
 * by a handle; it never learns or says where on this computer a file is.
 */
export class FileDownloads {
  private readonly running = new Map<string, { stopped: boolean }>()
  private readonly saved = new Map<string, string>()
  constructor(private readonly dependencies: FileDownloadDependencies) {}

  async download(request: FileDownloadRequest): Promise<FilesResult<FileDownload>> {
    const key = `${request.threadId}\n${request.path}`
    if (this.running.has(key)) return refusal('busy', i18n._(msg`This file is already downloading.`))
    const run = { stopped: false }
    this.running.set(key, run)
    let file: FileHandle | undefined, partPath: string | undefined
    try {
      let offset = 0, size = 0, revision: string | undefined, name = ''
      do {
        const answer = await this.dependencies.part({ ...request, want: 'part', offset, ...(revision === undefined ? {} : { revision }) })
        if (run.stopped) return refusal('unavailable', i18n._(STOPPED))
        if (!answer.ok) return answer
        const part = answer.value
        if (part.is !== 'part' || part.offset !== offset || revision !== undefined && (part.revision !== revision || part.size !== size)) return refusal('unavailable', i18n._(NOT_SAVED))
        const bytes = Buffer.from(part.data, 'base64')
        if (bytes.length === 0 && offset < part.size || offset + bytes.length > part.size) return refusal('unavailable', i18n._(NOT_SAVED))
        if (file === undefined) {
          ({ revision, size } = part)
          name = downloadName(part.name)
          try { ({ file, partPath, name } = await this.begin(name)) } catch { return refusal('unavailable', i18n._(NO_FOLDER)) }
        }
        await writeAll(file, bytes)
        offset += bytes.length
        this.dependencies.progress({ ...request, received: offset, size })
      } while (offset < size)
      await file!.close()
      file = undefined
      // A stop that came with the last part still stops: the file has no name yet, so nothing is left.
      if (run.stopped) return refusal('unavailable', i18n._(STOPPED))
      const final = await this.finish(partPath!, name)
      partPath = undefined
      // And a stop that came while the file took its name: it is removed again, so a stop the window was told of leaves nothing.
      if (run.stopped) { await rm(final.path, { force: true }); return refusal('unavailable', i18n._(STOPPED)) }
      const downloadId = randomBytes(16).toString('hex')
      this.saved.set(downloadId, final.path)
      while (this.saved.size > KEPT) this.saved.delete(this.saved.keys().next().value!)
      return { ok: true, value: { downloadId, name: final.name, size } }
    } catch {
      return refusal('unavailable', i18n._(NOT_SAVED))
    } finally {
      this.running.delete(key)
      await file?.close().catch(() => undefined)
      if (partPath !== undefined) await rm(partPath, { force: true }).catch(() => undefined)
    }
  }

  /** Stops a download after the part it is reading; what arrived is removed. */
  stop(request: FileDownloadRequest): FilesResult<FileDownloadStopped> {
    const run = this.running.get(`${request.threadId}\n${request.path}`)
    if (run) run.stopped = true
    return { ok: true, value: { stopped: run !== undefined } }
  }

  /** Where a download was saved, for main alone; undefined once it is forgotten. */
  savedPath(downloadId: string): string | undefined { return this.saved.get(downloadId) }

  /** Claims the first free name by creating its `.part` file, which fails when another download holds it. */
  private async begin(wanted: string): Promise<{ file: FileHandle; partPath: string; name: string }> {
    const folder = this.dependencies.folder()
    await mkdir(folder, { recursive: true })
    for (let count = 0; count < 1000; count++) {
      const name = numbered(wanted, count)
      if (await exists(join(folder, name))) continue
      const partPath = join(folder, `${name}.part`)
      try { return { file: await open(partPath, 'wx'), partPath, name } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    throw new Error('No free name in Downloads.')
  }

  /**
   * Gives the finished `.part` file its name, or the next free one when the name was taken while it downloaded. The name
   * is claimed first by creating it, which fails when a file is already there, so the rename replaces only that claim and
   * never a file someone else put under the name.
   */
  private async finish(partPath: string, wanted: string): Promise<{ path: string; name: string }> {
    const folder = this.dependencies.folder()
    for (let count = 0; count < 1000; count++) {
      const name = numbered(wanted, count)
      const path = join(folder, name)
      let claim: FileHandle
      try { claim = await open(path, 'wx') }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error }
      // From here the name is this download's, so a failure takes the claim away again.
      try { await claim.close(); await rename(partPath, path) }
      catch (error) { await rm(path, { force: true }).catch(() => undefined); throw error }
      return { path, name }
    }
    throw new Error('No free name in Downloads.')
  }
}
