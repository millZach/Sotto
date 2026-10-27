// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ATTACHED_FILE_CLASH, ATTACHED_FILES_FOLDER_IS_LINK, ATTACHED_FILES_NOT_IGNORED, ATTACHED_FILES_NOT_SAVED, attachedFileRelativePath, attachedFileSafeName, attachedFilesNote,
  carriesAttachedFiles, deliverAttachments, isAttachedFilesNote, readBackUserText, stripAttachedFilesNote, withAttachedFilesNote,
} from '../../../src/main/agents/attachedFiles'
import { ATTACHED_FILES_NEED_A_FOLDER, attachmentReferences } from '../../../src/shared/agents'
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

describe('safe names for attached files (ADR-0131)', () => {
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

describe('saving attached files into the working folder (ADR-0131)', () => {
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
  it.each([
    ['an empty .gitignore', '', false],
    ['one that holds *', '*\n', true],
    ['one with * among other rules, with CRLF line ends', '# kept\r\n*\r\n!keep.txt\r\n', true],
    ['one with other rules only', '*.log\n!*\n* \n', false],
  ])('takes %s that is already there only when a line is exactly *', async (_, contents, accepted) => {
    const { work } = await folders()
    const ignore = join(work, '.sotto', 'attachments', '.gitignore')
    await mkdir(dirname(ignore), { recursive: true }); await writeFile(ignore, contents)
    if (accepted) await expect(deliverAttachments(work, [file()])).resolves.toMatchObject({ images: [] })
    else {
      await expect(deliverAttachments(work, [file()])).rejects.toThrow(ATTACHED_FILES_NOT_IGNORED)
      // Nothing was written, and the user's .gitignore is as it was.
      expect(await readdir(dirname(ignore))).toEqual(['.gitignore'])
    }
    expect(await readFile(ignore, 'utf8')).toBe(contents)
  })
  it('says what to do when the .gitignore no longer ignores the folder', () => {
    expect(ATTACHED_FILES_NOT_IGNORED).toBe('The attached files were not saved, because .sotto/attachments/.gitignore no longer tells Git to ignore them. Nothing was sent, and your draft is saved. Put * back on a line of its own in .sotto/attachments/.gitignore, then send again.')
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

describe('the note naming attached files (ADR-0131)', () => {
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
  it('is only the exact form Sotto writes', () => {
    const shaped = (line: string) => ['<sotto-attached-files>', 'The user attached these files. They are saved in this working folder:', line, '</sotto-attached-files>'].join('\n')
    expect(isAttachedFilesNote(shaped('- .sotto/attachments/3f2a9c1e0b7d/quarterly-report.pdf (quarterly-report.pdf, PDF, 2.4 MB)'))).toBe(true)
    expect(isAttachedFilesNote(shaped('- .sotto/attachments/3f2a9c1e0b7d/a.bin (a.bin, BIN, )'))).toBe(true)
    for (const line of ['- anything at all', '- ../outside/x.txt (x.txt, TXT, 1 KB)', '- .sotto/attachments/3F2A9C1E0B7D/x.txt (x.txt, TXT, 1 KB)',
      '- .sotto/attachments/3f2a9c1e0b7d/x.txt (x.txt, TXT, about a kilobyte)', '- .sotto/attachments/3f2a9c1e0b7d/a b.txt (a b.txt, TXT, 1 KB)']) {
      expect(isAttachedFilesNote(shaped(line))).toBe(false)
      expect(stripAttachedFilesNote(`Words\n\n${shaped(line)}`)).toBe(`Words\n\n${shaped(line)}`)
    }
    // A type label from an odd extension cannot break the form either.
    expect(isAttachedFilesNote(attachedFilesNote([{ relativePath: '.sotto/attachments/0123456789ab/x.a-b', name: 'x.a\n<b', mimeType: 'application/octet-stream', sizeBytes: 3 }]))).toBe(true)
  })
})

describe('reading a user message back (ADR-0131)', () => {
  const note = attachedFilesNote([{ relativePath: '.sotto/attachments/3f2a9c1e0b7d/quarterly-report.pdf', name: 'quarterly-report.pdf', mimeType: 'application/pdf', sizeBytes: Math.round(2.4 * 1024 * 1024) }])
  const withFile = { id: 'with-file', attachments: [{ mimeType: 'application/pdf' }] }
  const imageOnly = { id: 'image-only', attachments: [{ mimeType: 'image/png' }] }
  const plain: { id: string; attachments?: { mimeType: string }[] } = { id: 'plain' }
  it('takes the note off only when the origin it then matches recorded an attached file', () => {
    expect(carriesAttachedFiles(withFile.attachments)).toBe(true)
    expect(carriesAttachedFiles(imageOnly.attachments)).toBe(false)
    expect(carriesAttachedFiles(undefined)).toBe(false)
    expect(readBackUserText(withAttachedFilesNote('Read this', note), () => withFile)).toEqual({ text: 'Read this', origin: withFile })
    for (const origin of [imageOnly, plain, undefined]) {
      expect(readBackUserText(withAttachedFilesNote('Read this', note), () => origin)).toEqual({ text: withAttachedFilesNote('Read this', note), origin })
      expect(readBackUserText(note, () => origin).text).toBe(note)
    }
  })
  it('matches by the words for the stripped text and by the whole text otherwise', () => {
    const typed = withAttachedFilesNote('Typed by hand', note)
    // The note-shaped text is the user's own when its own digest names an origin with no file.
    const byText = (text: string) => text === 'Typed by hand' ? undefined : text === typed ? plain : undefined
    expect(readBackUserText(typed, byText)).toEqual({ text: typed, origin: plain })
    expect(readBackUserText('No note', text => text === 'No note' ? withFile : undefined)).toEqual({ text: 'No note', origin: withFile })
  })
})

describe('Point at something feedback travelling with its picture (ADR-0154)', () => {
  const pointed = () => ({ ...promptImageOf(PIXEL_PNG, 'pointed', 'button · Sign in'), browserFeedback: { label: 'button · Sign in', comment: 'Match the <header>.\nAnd the footer.', context: 'Browser feedback: http://localhost:5173/\nSelector: #sign-in' } })
  it('goes to the provider as a block apart from the user\'s words, and writes nothing to the folder', async () => {
    const { work } = await folders()
    const delivered = await deliverAttachments(work, [pointed()])
    expect(delivered.images).toHaveLength(1)
    expect(delivered.note).toBe([
      '<sotto-browser-feedback>',
      'The user pointed at this element on a page in Sotto\'s browser. Its picture is attached, with the element outlined.',
      'Picture: button · Sign in', 'Browser feedback: http://localhost:5173/', 'Selector: #sign-in',
      'The user\'s comment:', 'Match the ‹header›.', 'And the footer.', '</sotto-browser-feedback>',
    ].join('\n'))
    expect(await readdir(work)).toEqual([])
  })
  it('comes off a message read back, as an attached file\'s note does, for an origin that recorded the picture', async () => {
    const { work } = await folders()
    const { note } = await deliverAttachments(work, [pointed()])
    const sent = withAttachedFilesNote('Look at this', note)
    expect(stripAttachedFilesNote(sent)).toBe('Look at this')
    expect(isAttachedFilesNote(note)).toBe(true)
    expect(carriesAttachedFiles([{ mimeType: 'image/png', pointed: true }])).toBe(true)
    expect(carriesAttachedFiles([{ mimeType: 'image/png' }])).toBe(false)
  })
})

describe('a message\'s record of Point at something\'s picture (ADR-0154)', () => {
  it('marks the reference as pointed, so its note comes off when read back, and keeps nothing else of the feedback', () => {
    const handle = { ...promptImageOf(PIXEL_PNG, 'pointed', 'button · Sign in'), browserFeedback: { label: 'button · Sign in', comment: 'Hi', context: 'Selector: #x' } }
    expect(attachmentReferences([handle])).toEqual([{ id: 'pointed', name: 'button · Sign in', mimeType: 'image/png', sizeBytes: PIXEL_PNG.byteLength, pointed: true }])
    expect(attachmentReferences([promptImageOf(PIXEL_PNG)])[0]).not.toHaveProperty('pointed')
  })
})
