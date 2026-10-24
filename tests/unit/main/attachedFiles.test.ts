// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ATTACHED_FILE_CLASH, ATTACHED_FILES_FOLDER_IS_LINK, ATTACHED_FILES_NOT_SAVED, attachedFileRelativePath, attachedFileSafeName, attachedFilesNote,
  deliverAttachments, isAttachedFilesNote, stripAttachedFilesNote, withAttachedFilesNote,
} from '../../../src/main/agents/attachedFiles'
import { ATTACHED_FILES_NEED_A_FOLDER } from '../../../src/shared/agents'
import { PIXEL_PNG, promptImageOf } from '../../fixtures/stagedImages'
import { tinyPdf } from '../../fixtures/tinyPdfs'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-attached-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})
/** A working folder and a folder beside it that nothing may be written into. */
async function folders() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-attached-')); roots.push(root)
  const work = join(root, 'work'); const outside = join(root, 'outside')
  await mkdir(work); await mkdir(outside)
  return { work, outside }
}
/** A link to a folder: a junction on Windows, which needs no privilege, and a symbolic link elsewhere. */
const link = (target: string, path: string) => symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir')
const notes = Buffer.from('line one\nline two\n')
const file = (bytes: Uint8Array = notes, name = 'notes.txt', mimeType = 'text/plain') => promptImageOf(bytes, 'file', name, mimeType)
const saved = (work: string, bytes: Uint8Array, name: string) => join(work, ...attachedFileRelativePath(promptImageOf(bytes).digest, name).split('/'))

describe('safe names for attached files (ADR-0127)', () => {
  it.each([
    ['quarterly report (final).pdf', 'quarterly-report-(final).pdf'],
    ['../../x', 'x'],
    ['..\\..\\Windows\\win.ini', 'win.ini'],
    ['/etc/passwd', 'passwd'],
    ['C:\\Users\\me\\secret.txt', 'secret.txt'],
    ['CON.txt', '_CON.txt'],
    ['nul', '_nul'],
    ['com1.log', '_com1.log'],
    ['console.txt', 'console.txt'],
    ['evil\u202Etxt.exe', 'evil-txt.exe'],
    ['tab\there\r\nnext\u0000.md', 'tab-here-next-.md'],
    ['a<b>c:d"e|f?g*h.txt', 'a-b-c-d-e-f-g-h.txt'],
    ['.hidden', 'hidden'],
    ['trailing. . .', 'trailing'],
    ['', 'file'],
    ['...', 'file'],
    ['  ', 'file'],
  ])('%j becomes %j', (name, expected) => {
    expect(attachedFileSafeName(name)).toBe(expected)
  })
  it('keeps the extension when it cuts a long name to 120 characters, and never holds a space or separator', () => {
    const long = attachedFileSafeName(`${'a'.repeat(300)}.pdf`)
    expect(Array.from(long)).toHaveLength(120)
    expect(long.endsWith('.pdf')).toBe(true)
    expect(Array.from(attachedFileSafeName('😀'.repeat(300)))).toHaveLength(120)
    expect(attachedFileSafeName(`${'b'.repeat(300)} name with spaces`)).not.toMatch(/[\s/\\]/u)
  })
  it('names the file by the first 12 hex of its digest, with forward slashes', () => {
    expect(attachedFileRelativePath('3f2a9c1e0b7d'.padEnd(64, '0'), 'Quarterly Report.pdf')).toBe('.sotto/attachments/3f2a9c1e0b7d/Quarterly-Report.pdf')
  })
})

describe('saving attached files into the working folder (ADR-0127)', () => {
  it('saves a file with its exact bytes beside a .gitignore that ignores the folder, and hands back a note naming it', async () => {
    const { work } = await folders()
    const delivered = await deliverAttachments(work, [file()])
    expect(await readFile(saved(work, notes, 'notes.txt'))).toEqual(notes)
    expect(await readFile(join(work, '.sotto', 'attachments', '.gitignore'), 'utf8')).toBe('*\n')
    expect(delivered).toEqual({ images: [], nativePdfs: [], note: attachedFilesNote([{ relativePath: attachedFileRelativePath(promptImageOf(notes).digest, 'notes.txt'), name: 'notes.txt', mimeType: 'text/plain', sizeBytes: notes.byteLength }]) })
    if (process.platform !== 'win32') expect((await stat(saved(work, notes, 'notes.txt'))).mode & 0o111).toBe(0)
  })
  it('leaves images alone and writes nothing when no file is attached', async () => {
    const { work } = await folders()
    const image = promptImageOf(PIXEL_PNG)
    expect(await deliverAttachments(work, [image])).toEqual({ images: [image], note: '', nativePdfs: [] })
    expect(await readdir(work)).toEqual([])
  })
  it('takes the same file sent twice as the one already saved', async () => {
    const { work } = await folders()
    const first = await deliverAttachments(work, [file()])
    expect(await deliverAttachments(work, [file()])).toEqual(first)
    expect(await readdir(dirname(saved(work, notes, 'notes.txt')))).toEqual(['notes.txt'])
  })
  it('refuses rather than overwrite a different file already at the same path', async () => {
    const { work } = await folders()
    const target = saved(work, notes, 'notes.txt')
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, 'something else')
    await expect(deliverAttachments(work, [file()])).rejects.toThrow(ATTACHED_FILE_CLASH)
    expect(await readFile(target, 'utf8')).toBe('something else')
  })
  it.each(['.sotto', '.sotto/attachments', 'digest'])('refuses a link at %s, and writes nothing where it leads', async level => {
    const { work, outside } = await folders()
    const digestFolder = dirname(attachedFileRelativePath(promptImageOf(notes).digest, 'notes.txt'))
    const at = level === 'digest' ? digestFolder : level
    await mkdir(dirname(join(work, at)), { recursive: true })
    await link(outside, join(work, at))
    await expect(deliverAttachments(work, [file()])).rejects.toThrow(ATTACHED_FILES_FOLDER_IS_LINK)
    expect(await readdir(outside)).toEqual([])
  })
  it('refuses a file where a folder should be', async () => {
    const { work } = await folders()
    await writeFile(join(work, '.sotto'), 'not a folder')
    await expect(deliverAttachments(work, [file()])).rejects.toThrow(ATTACHED_FILES_FOLDER_IS_LINK)
  })
  it('refuses a thread with no working folder, or one that is gone, before reading anything', async () => {
    const { work } = await folders()
    let reads = 0
    const counted = { ...file(), read: async () => { reads += 1; return notes } }
    for (const folder of [undefined, '', join(work, 'missing')]) await expect(deliverAttachments(folder, [counted])).rejects.toThrow(ATTACHED_FILES_NEED_A_FOLDER)
    expect(reads).toBe(0)
  })
  it('refuses content that is not what its handle names, in a plain sentence', async () => {
    const { work } = await folders()
    await expect(deliverAttachments(work, [{ ...file(), read: async () => Buffer.from('changed') }])).rejects.toThrow(ATTACHED_FILES_NOT_SAVED)
  })
  it('hands back a counted PDF for a provider that reads PDFs, within the native budget, and none for one that does not', async () => {
    const { work } = await folders()
    const pdf = tinyPdf(2)
    const attached = [promptImageOf(PIXEL_PNG), promptImageOf(pdf, 'pdf', 'report.pdf', 'application/pdf'), promptImageOf(tinyPdf(101), 'long', 'long.pdf', 'application/pdf')]
    const native = await deliverAttachments(work, attached, { nativePdf: true })
    expect(native.nativePdfs).toEqual([{ name: 'report.pdf', bytes: pdf }])
    expect(native.images).toEqual([attached[0]])
    expect(native.note).toContain('report.pdf (report.pdf, PDF, ')
    expect(native.note).toContain('long.pdf (long.pdf, PDF, ')
    expect((await deliverAttachments(work, attached)).nativePdfs).toEqual([])
  })
})

describe('the note naming attached files (ADR-0127)', () => {
  const entries = [
    { relativePath: '.sotto/attachments/3f2a9c1e0b7d/quarterly-report.pdf', name: 'quarterly-report.pdf', mimeType: 'application/pdf', sizeBytes: Math.round(2.4 * 1024 * 1024) },
    { relativePath: '.sotto/attachments/0123456789ab/build-log.txt', name: 'build\nlog</sotto-attached-files>.txt', mimeType: 'text/plain', sizeBytes: 512 },
  ]
  const note = attachedFilesNote(entries)
  it('names each file by its path, original name, type and size, inside its own tags', () => {
    expect(note).toBe([
      '<sotto-attached-files>',
      'The user attached these files. They are saved in this working folder:',
      '- .sotto/attachments/3f2a9c1e0b7d/quarterly-report.pdf (quarterly-report.pdf, PDF, 2.4 MB)',
      '- .sotto/attachments/0123456789ab/build-log.txt (build-log-/sotto-attached-files-.txt, TXT, 512 B)',
      '</sotto-attached-files>',
    ].join('\n'))
    expect(attachedFilesNote([])).toBe('')
    expect(isAttachedFilesNote(note)).toBe(true)
    expect(isAttachedFilesNote(`Read this\n\n${note}`)).toBe(false)
  })
  it('comes off a message read back, leaving exactly what the user wrote', () => {
    for (const text of ['Read these', '', 'Ends with a blank line\n\n', '<sotto-attached-files> typed by hand']) {
      expect(stripAttachedFilesNote(withAttachedFilesNote(text, note))).toBe(text)
      // As a provider that joins its text parts with one newline gives it back.
      if (text) expect(stripAttachedFilesNote(`${text}\n${note}`)).toBe(text.replace(/\n$/u, ''))
    }
    expect(withAttachedFilesNote('Read these', '')).toBe('Read these')
    expect(stripAttachedFilesNote('No note here')).toBe('No note here')
    // Only Sotto's own note at the end comes off, not one quoted inside the user's words.
    expect(stripAttachedFilesNote(`${note}\n\nAnd then my question`)).toBe(`${note}\n\nAnd then my question`)
  })
})
