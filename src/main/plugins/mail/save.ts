import { open, realpath, rm } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { publish } from '../../tools/elevenlabs/save'
import { isInside, modelFolder } from '../../tools/meshy/download'

/**
 * A file that came with an email, saved in its thread's folder (ADR-0205, November 19, 2026). It is written to a part
 * file of Sotto's own inside the folder the thread asked for, which is inside the thread's working folder, and given
 * its name only once it is whole: never over a file that is already there, and never through a folder swapped for a
 * link elsewhere. Its name is the sender's, made safe to write: a sender chooses it, so it can say anything. One gap
 * remains, as for a sound: a folder moved out of the thread's folder while the file is written takes Sotto's part file
 * with it. Nothing is named there, and the file is refused.
 */
export const MAIL_FILE_FOLDER = 'mail-files'
/** How many names are tried before a file is refused for want of one: "name.ext", then "name (2).ext" and on. */
const NAMES_TRIED = 100
/** The longest name a file is saved under, in characters, its extension included. */
const NAME_MAX = 120

/** The folder is not inside the thread's working folder, or the file could not be written there. */
export class MailSaveError extends Error {
  constructor() { super('mail-file-save-folder') }
}

/** A few kinds by the extension a file of that kind is saved with, when it came without a name. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf', 'application/zip': 'zip', 'application/json': 'json', 'application/msword': 'doc', 'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx', 'application/octet-stream': 'bin',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'image/svg+xml': 'svg',
  'text/plain': 'txt', 'text/html': 'html', 'text/csv': 'csv', 'text/calendar': 'ics', 'message/rfc822': 'eml',
  'audio/mpeg': 'mp3', 'video/mp4': 'mp4', 'video/quicktime': 'mov',
}
/** A name Windows keeps for a device, with or without an extension: `con`, `nul.txt`, `com1`. */
const RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu
/** What no file name may hold on Windows, a control character, and a mark that turns the text around it. */
const UNSAFE = /[\\/:*?"<>|\p{Cc}‪-‮⁦-⁩]+/gu

/**
 * The name a file is saved under: its own name, as the sender gave it, without any folder in it, without what Windows
 * refuses in a name, control characters and marks that turn text around, and not a name Windows keeps for a device.
 * A file with no usable name is `attachment-<where it is in the message>`, with an extension from its kind.
 */
export function mailFileName(file: { readonly name: string | null; readonly type: string; readonly section: string }): string {
  // Only the last step of a path: a sender can name a file `..\..\startup.bat`.
  const last = (file.name ?? '').normalize('NFC').split(/[\\/]/u).at(-1) ?? ''
  let name = last.replace(UNSAFE, '-').replace(/\s+/gu, ' ').trim()
    // Windows drops dots and spaces at the end of a name, and one starting with a dot is hidden elsewhere.
    .replace(/^[\s.-]+|[\s.]+$/gu, '')
  if (!/[\p{L}\p{N}]/u.test(name)) {
    const subtype = file.type.split('/')[1] ?? ''
    const extension = EXTENSIONS[file.type] ?? (/^[a-z0-9]{1,8}$/u.test(subtype) ? subtype : 'bin')
    return `attachment-${file.section.replace(/\./gu, '-')}.${extension}`
  }
  if (RESERVED.test(name)) name = `attachment-${name}`
  const characters = Array.from(name)
  if (characters.length <= NAME_MAX) return name
  // A long name is cut before its extension, which is kept.
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : ''
  return Array.from(name.slice(0, name.length - extension.length)).slice(0, NAME_MAX - extension.length).join('').trimEnd() + extension
}

/** The `tried`th name for a file: `name.ext`, then `name (2).ext` and on. */
export function numberedName(name: string, tried: number): string {
  if (tried === 1) return name
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} (${tried})${name.slice(dot)}` : `${name} (${tried})`
}

/** Where a saved file is: its path from the thread's working folder, with forward slashes, and the name it was given. */
export interface SavedMailFile { readonly path: string; readonly fileName: string; /** Whether a file of its own name was there already, and kept. */ readonly renamed: boolean }

/**
 * Writes a file's bytes into `folder`, relative to the thread's working folder `root`, under `name`, or the first of
 * "name (2)" and on that is free. The folder is made if it is not there. Node opens files by path alone, so the folder
 * is checked against the thread's working folder before the part file is made, once it is open, and the finished
 * file once named: a folder swapped for a link at any step has what Sotto wrote there removed, and nothing is saved.
 */
export async function saveMailFile(bytes: Buffer, target: { readonly root: string; readonly folder: string; readonly name: string }): Promise<SavedMailFile> {
  let realRoot: string
  let realFolder: string
  try {
    realRoot = await realpath(target.root)
    realFolder = await modelFolder(realRoot, target.folder)
  } catch { throw new MailSaveError() }
  /** Whether a path, as it resolves now, is inside the thread's working folder. */
  const stillInside = async (path: string): Promise<boolean> => { try { return isInside(realRoot, await realpath(path)) } catch { return false } }
  const partPath = join(realFolder, `.sotto-mail-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.part`)
  let file: Awaited<ReturnType<typeof open>>
  try { file = await open(partPath, 'wx', 0o644) } catch { throw new MailSaveError() }
  let finished = false
  try {
    // The file just opened, by where it really is: one opened through a swapped folder is outside, and refused.
    if (!await stillInside(partPath)) throw new MailSaveError()
    // A write may take part of what it is given: the rest is written until the whole of it is in.
    for (let at = 0; at < bytes.length;) {
      const { bytesWritten } = await file.write(bytes, at, bytes.length - at)
      if (bytesWritten <= 0) throw new MailSaveError()
      at += bytesWritten
    }
    finished = true
  } catch { throw new MailSaveError() } finally {
    await file.close().catch(() => undefined)
    if (!finished) await rm(partPath, { force: true }).catch(() => undefined)
  }
  try {
    if (!await stillInside(partPath)) throw new MailSaveError()
    for (let tried = 1; tried <= NAMES_TRIED; tried++) {
      const fileName = numberedName(target.name, tried)
      const path = join(realFolder, fileName)
      let named: boolean
      try { named = await publish(partPath, path) } catch { throw new MailSaveError() }
      if (!named) continue
      if (!await stillInside(path)) {
        await rm(path, { force: true }).catch(() => undefined)
        throw new MailSaveError()
      }
      return { path: relative(realRoot, path).split(sep).join('/'), fileName, renamed: tried > 1 }
    }
    throw new MailSaveError()
  } finally { await rm(partPath, { force: true }).catch(() => undefined) }
}
