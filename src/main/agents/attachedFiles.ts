import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ATTACHED_FILES_NEED_A_FOLDER, AGENT_GENERIC_FILE_MIME_TYPE, isImageAttachment } from '../../shared/agents'
import { attachmentExtension, fileTypeLabel, formatAttachmentSize } from '../../shared/attachmentLabels'
import type { PromptImage } from './host'
import { isPdfBytes, nativePdfSelection } from './pdfPages'

/**
 * How an attached file reaches an agent (ADR-0127): copied into the thread's working folder under
 * `.sotto/attachments/<first 12 hex of its digest>/<safe name>`, and named in a note the adapter adds to what the
 * provider receives, apart from the user's own words. Adapters call this at the protocol boundary, where they read staged
 * images (ADR-0031). Nothing here logs a name, a path or a byte, and nothing it writes is ever opened or run by Sotto.
 */

// Each says what happened, that nothing was sent and the draft is kept, and what to do.
export const ATTACHED_FILES_FOLDER_IS_LINK = 'The attached files were not saved, because .sotto or a folder inside it in this thread’s working folder is a link or not a folder. Nothing was sent, and your draft is saved. Move it aside, then send again.'
export const ATTACHED_FILE_CLASH = 'The attached files were not saved, because a different file is already saved under the same name in .sotto/attachments. Nothing was sent, and your draft is saved. Remove that file, then send again.'
export const ATTACHED_FILES_NOT_IGNORED = 'The attached files were not saved, because .sotto/attachments/.gitignore no longer tells Git to ignore them. Nothing was sent, and your draft is saved. Put * back on a line of its own in .sotto/attachments/.gitignore, then send again.'
export const ATTACHED_FILES_NOT_SAVED ='The attached files could not be saved in this thread’s working folder. Nothing was sent, and your draft is saved. Check that the folder can be written to, then send again.'

/** A refusal whose sentence is already the user's; any other failure is said as `ATTACHED_FILES_NOT_SAVED`. */
class AttachedFilesRefusal extends Error {}

/** Where attached files go, from the working folder, as path segments. */
const FOLDERS = ['.sotto', 'attachments'] as const
const SAFE_NAME_MAX = 120
/** Path separators, control, format (bidi included) and line-separator characters, what Windows refuses, and whitespace. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>:"/\\|?*\s]+/gu
const DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?:\.|$)/iu
const trimDots = (name: string): string => name.replace(/^\.+/u, '').replace(/[. ]+$/u, '')

/**
 * The name a file is saved under: its base name only, with every unsafe run of characters one `-`, no leading or trailing
 * dots, a Windows device name prefixed with `_`, at most 120 characters with its extension kept, and `file` when nothing
 * is left. It never holds a space or a separator, so it can be named as an `@path` token.
 */
export function attachedFileSafeName(name: string): string {
  const base = (name.normalize('NFC').split(/[/\\]/u).at(-1) ?? '').replace(/^[\s.]+/u, '').replace(/[\s.]+$/u, '')
  let safe = trimDots(base.replace(UNSAFE, '-'))
  if (DEVICE.test(safe)) safe = `_${safe}`
  const characters = Array.from(safe)
  if (characters.length > SAFE_NAME_MAX) {
    const dot = safe.lastIndexOf('.')
    const extension = dot > 0 ? Array.from(safe.slice(dot)) : []
    const kept = extension.length > 1 && extension.length <= 16 ? extension : []
    safe = trimDots(characters.slice(0, SAFE_NAME_MAX - kept.length).join('')) + kept.join('')
  }
  return trimDots(safe) || 'file'
}

/** Where a file is saved, relative to the working folder, with forward slashes whatever the platform. */
export function attachedFileRelativePath(digest: string, name: string): string {
  return [...FOLDERS, digest.slice(0, 12), attachedFileSafeName(name)].join('/')
}

/** An attached file as the note names it. */
export interface AttachedFileEntry { readonly relativePath: string; readonly name: string; readonly mimeType: string; readonly sizeBytes: number }

const NOTE_OPEN = '<sotto-attached-files>'
const NOTE_CLOSE = '</sotto-attached-files>'
const NOTE_HEADER = 'The user attached these files. They are saved in this working folder:'
/**
 * One line exactly as `attachedFilesNote` writes it: the saved path, then the name, type and size in brackets, the size
 * as `formatAttachmentSize` gives it or nothing.
 */
const NOTE_LINE = String.raw`- \.sotto/attachments/[0-9a-f]{12}/[^\s/\\<>]+ \([^\n<>]*, [^\n<>]+, (?:\d+ B|\d+ KB|\d+(?:\.\d)? MB)?\)`
const NOTE_BODY = `${NOTE_OPEN}\\n${NOTE_HEADER.replace(/[.]/gu, '\\.')}\\n(?:${NOTE_LINE}\\n)+${NOTE_CLOSE.replace('/', '\\/')}`
const NOTE = new RegExp(`^${NOTE_BODY}$`, 'u')
/** The note at the end of a message, with the one separator the adapters put before it. */
const TRAILING_NOTE = new RegExp(`(?:\\n\\n|\\n)?${NOTE_BODY}\\s*$`, 'u')
/** A name as the note shows it: nothing that could end a line or the note. */
const noteName = (name: string): string => name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]+/gu, '-')

/**
 * The block naming a message's attached files, given to the provider apart from the user's words:
 *
 *   <sotto-attached-files>
 *   The user attached these files. They are saved in this working folder:
 *   - .sotto/attachments/3f2a9c1e0b7d/quarterly-report.pdf (quarterly-report.pdf, PDF, 2.4 MB)
 *   </sotto-attached-files>
 *
 * Empty when there are none.
 */
export function attachedFilesNote(files: readonly AttachedFileEntry[]): string {
  if (!files.length) return ''
  return [NOTE_OPEN, NOTE_HEADER, ...files.map(file =>
    `- ${file.relativePath} (${noteName(file.name)}, ${noteName(fileTypeLabel(file.mimeType, file.name) ?? 'File')}, ${formatAttachmentSize(file.sizeBytes) ?? ''})`), NOTE_CLOSE].join('\n')
}

/** Whether a text is exactly a note, as a provider that keeps each text part apart gives it back. */
export function isAttachedFilesNote(text: string): boolean { return NOTE.test(text) }

/** The user's words with a note after them, as the providers that take one text are sent them. */
export function withAttachedFilesNote(text: string, note: string): string {
  return !note ? text : text ? `${text}\n\n${note}` : note
}

/**
 * Text without a note in the generated form at its end, whoever wrote it. Readers call `readBackUserText`, or check the
 * origin themselves first: a note is Sotto's only when the message's origin recorded an attached file.
 */
export function stripAttachedFilesNote(text: string): string {
  return text.includes(NOTE_OPEN) ? text.replace(TRAILING_NOTE, '') : text
}

/** Whether a message's recorded attachments include a file that is not an image: the only message Sotto adds a note to. */
export function carriesAttachedFiles(attachments: readonly { readonly mimeType: string }[] | undefined): boolean {
  return attachments?.some(attachment => !isImageAttachment(attachment.mimeType)) ?? false
}

/**
 * A user message read back from a provider's own history, and the origin it matches. The note comes off only when the
 * origin the text then matches, by message ID or by digest as the adapter's `match` decides, recorded an attached file,
 * since only then did Sotto put it there. Any other text, one the user typed in the note's shape included, is shown and
 * matched as it is.
 */
export function readBackUserText<T extends { readonly attachments?: readonly { readonly mimeType: string }[] | undefined }>(
  text: string, match: (text: string) => T | undefined): { readonly text: string; readonly origin: T | undefined } {
  const words = stripAttachedFilesNote(text)
  if (words !== text) {
    const origin = match(words)
    if (origin && carriesAttachedFiles(origin.attachments)) return { text: words, origin }
  }
  return { text, origin: match(text) }
}

/** What an adapter hands its provider for a message's attachments. */
export interface DeliveredAttachments {
  /** The images, which go as each provider takes them today. */
  readonly images: readonly PromptImage[]
  /** The note naming every attached file that is not an image, or '' when there is none. */
  readonly note: string
  /** The PDFs that also go as part of the prompt, when the caller's provider reads them and they pass `nativePdfSelection`. */
  readonly nativePdfs: readonly { readonly name: string; readonly bytes: Uint8Array }[]
}

const isPdf = (file: Pick<PromptImage, 'mimeType' | 'name'>): boolean =>
  file.mimeType === 'application/pdf' || file.mimeType === AGENT_GENERIC_FILE_MIME_TYPE && attachmentExtension(file.name) === 'pdf'

/**
 * Splits a message's attachments into images, which go as they always have, and files, which are saved into the working
 * folder and named in the note. With `nativePdf`, PDFs that may go natively are handed back too. Throws a sentence for the
 * user, before the provider hears anything, when a file cannot be saved.
 */
export async function deliverAttachments(workingDirectory: string | undefined, attachments: readonly PromptImage[] = [], options: { readonly nativePdf?: boolean } = {}): Promise<DeliveredAttachments> {
  const images = attachments.filter(attachment => isImageAttachment(attachment.mimeType))
  const files = attachments.filter(attachment => !isImageAttachment(attachment.mimeType))
  if (!files.length) return { images: attachments, note: '', nativePdfs: [] }
  const saved = await saveAttachedFiles(workingDirectory, files)
  const pdfs = saved.filter(file => options.nativePdf && isPdf(file) && isPdfBytes(file.bytes))
  const chosen = nativePdfSelection(images.reduce((sum, image) => sum + image.sizeBytes, 0), pdfs.map(file => file.bytes))
  return { images, note: attachedFilesNote(saved), nativePdfs: pdfs.filter((_, index) => chosen[index]).map(({ name, bytes }) => ({ name, bytes })) }
}

/** Each file read, checked against its digest, and saved; what was saved, with its bytes, in order. */
export async function saveAttachedFiles(workingDirectory: string | undefined, files: readonly PromptImage[]): Promise<(AttachedFileEntry & { readonly bytes: Uint8Array })[]> {
  if (!workingDirectory || !(await stat(workingDirectory).catch(() => undefined))?.isDirectory()) throw new Error(ATTACHED_FILES_NEED_A_FOLDER)
  try {
    await prepareFolder(workingDirectory)
    const saved:(AttachedFileEntry & { readonly bytes: Uint8Array })[] = []
    for (const file of files) {
      const bytes = await file.read()
      if (bytes.byteLength !== file.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== file.digest) throw new Error('content changed')
      await saveOne(workingDirectory, file.digest, file.name, bytes)
      saved.push({ relativePath: attachedFileRelativePath(file.digest, file.name), name: file.name, mimeType: file.mimeType, sizeBytes: file.sizeBytes, bytes })
    }
    return saved
  } catch (error) { throw error instanceof AttachedFilesRefusal ? new Error(error.message) : new Error(ATTACHED_FILES_NOT_SAVED) }
}

const missing = (error: unknown): undefined => {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
  throw error
}
/** A folder Sotto made or found as a real folder: never a symbolic link, a junction or anything else. */
async function ensureFolder(path: string): Promise<void> {
  let info = await lstat(path).catch(missing)
  if (!info) {
    await mkdir(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
    info = await lstat(path)
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new AttachedFilesRefusal(ATTACHED_FILES_FOLDER_IS_LINK)
}
const samePath = (a: string, b: string): boolean => process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b

/**
 * `.sotto/attachments`, made or found as real folders, and its `.gitignore` holding `*`: written once, and when one is
 * already there, kept only while one of its lines is exactly `*`, so Git ignores what is saved. Checked before any file is
 * written.
 */
async function prepareFolder(workingDirectory: string): Promise<void> {
  const sotto = join(workingDirectory, FOLDERS[0]); const attachments = join(sotto, FOLDERS[1]); const ignore = join(attachments, '.gitignore')
  await ensureFolder(sotto); await ensureFolder(attachments)
  try { await writeFile(ignore, '*\n', { flag: 'wx', mode: 0o644 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!(await lstat(ignore)).isFile() || !(await readFile(ignore, 'utf8')).split(/\r?\n/u).includes('*')) throw new AttachedFilesRefusal(ATTACHED_FILES_NOT_IGNORED)
  }
}

async function saveOne(workingDirectory: string, digest: string, name: string, bytes: Uint8Array): Promise<void> {
  const sotto = join(workingDirectory, FOLDERS[0]); const attachments = join(sotto, FOLDERS[1]); const folder = join(attachments, digest.slice(0, 12))
  await ensureFolder(sotto); await ensureFolder(attachments); await ensureFolder(folder)
  // Checked once more where it resolves to, in case a folder above was swapped for a link between the checks.
  if (!samePath(await realpath(folder), join(await realpath(workingDirectory), ...FOLDERS, digest.slice(0, 12)))) throw new AttachedFilesRefusal(ATTACHED_FILES_FOLDER_IS_LINK)
  const target = join(folder, attachedFileSafeName(name))
  const kept = async (): Promise<boolean> => {
    const info = await lstat(target).catch(missing)
    if (!info) return false
    // The same content is the same file sent again; anything else there is not overwritten.
    if (info.isSymbolicLink() || !info.isFile() || info.size !== bytes.byteLength
      || createHash('sha256').update(await readFile(target)).digest('hex') !== digest) throw new AttachedFilesRefusal(ATTACHED_FILE_CLASH)
    return true
  }
  if (await kept()) return
  try { await writeFile(target, bytes, { flag: 'wx', mode: 0o644 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !await kept()) throw error }
}
