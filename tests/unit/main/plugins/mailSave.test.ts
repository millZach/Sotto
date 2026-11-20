// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MailSaveError, mailFileName, numberedName, saveMailFile } from '../../../../src/main/plugins/mail/save'

const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))) })
async function threadFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'sotto-mail-files-'))
  folders.push(folder)
  return folder
}
const file = (name: string | null, type = 'application/pdf', section = '2') => ({ name, type, section })

describe('the name a file from an email is saved under (ADR-0205, #2727)', () => {
  it('keeps a plain name as the sender gave it', () => {
    expect(mailFileName(file('IMG_4640.jpeg', 'image/jpeg'))).toBe('IMG_4640.jpeg')
    expect(mailFileName(file('Rechnung für Oktober.pdf'))).toBe('Rechnung für Oktober.pdf')
  })

  it('takes out any folder, what Windows refuses, control characters and marks that turn the text around', () => {
    expect(mailFileName(file('..\\..\\Startup\\run.bat'))).toBe('run.bat')
    expect(mailFileName(file('../../.ssh/authorized_keys'))).toBe('authorized_keys')
    expect(mailFileName(file('a:b*c?"d"<e>|f.txt'))).toBe('a-b-c-d-e-f.txt')
    expect(mailFileName(file('one\u0007two\ttab.pdf'))).toBe('one-two-tab.pdf')
    // A file that would read as a PDF and is a program.
    expect(mailFileName(file('invoice‮fdp.exe'))).toBe('invoice-fdp.exe')
    // Windows drops dots and spaces at a name's end, and a name that starts with a dot is hidden.
    expect(mailFileName(file('.hidden.txt. . '))).toBe('hidden.txt')
  })

  it('never saves under a name Windows keeps for a device', () => {
    expect(mailFileName(file('CON'))).toBe('attachment-CON')
    expect(mailFileName(file('nul.txt', 'text/plain'))).toBe('attachment-nul.txt')
    expect(mailFileName(file('com1.pdf'))).toBe('attachment-com1.pdf')
    expect(mailFileName(file('console.pdf'))).toBe('console.pdf')
  })

  it('names a file that came without a usable name by where it is in the message and its kind', () => {
    expect(mailFileName(file(null, 'image/jpeg', '2'))).toBe('attachment-2.jpg')
    expect(mailFileName(file('', 'application/pdf', '1.2'))).toBe('attachment-1-2.pdf')
    expect(mailFileName(file('../..', 'application/x-made-up', '3'))).toBe('attachment-3.bin')
    expect(mailFileName(file(null, 'image/avif', '4'))).toBe('attachment-4.avif')
  })

  it('cuts a long name before its extension', () => {
    const named = mailFileName(file(`${'a'.repeat(300)}.pdf`))
    expect(named).toHaveLength(120)
    expect(named.endsWith('a.pdf')).toBe(true)
  })

  it('numbers a name that is taken: name (2).ext, name (3).ext', () => {
    expect([1, 2, 3].map(tried => numberedName('IMG_4640.jpeg', tried))).toEqual(['IMG_4640.jpeg', 'IMG_4640 (2).jpeg', 'IMG_4640 (3).jpeg'])
    expect(numberedName('README', 2)).toBe('README (2)')
  })
})

describe('saving a file from an email in the thread’s folder (ADR-0205, #2727)', () => {
  it('saves into mail-files, made where it is not there, and says the path from the thread’s folder', async () => {
    const root = await threadFolder()
    await expect(saveMailFile(Buffer.from('made-up pdf bytes'), { root, folder: 'mail-files', name: 'menu.pdf' })).resolves.toEqual({ path: 'mail-files/menu.pdf', fileName: 'menu.pdf', renamed: false })
    expect(await readFile(join(root, 'mail-files', 'menu.pdf'), 'utf8')).toBe('made-up pdf bytes')
    await expect(saveMailFile(Buffer.alloc(0), { root, folder: 'notes/from mail', name: 'empty.txt' })).resolves.toMatchObject({ path: 'notes/from mail/empty.txt' })
  })

  it('never writes over a file that is there: the new one is saved beside it as name (2), then name (3)', async () => {
    const root = await threadFolder()
    await saveMailFile(Buffer.from('one'), { root, folder: 'mail-files', name: 'IMG_4640.jpeg' })
    await expect(saveMailFile(Buffer.from('two'), { root, folder: 'mail-files', name: 'IMG_4640.jpeg' })).resolves.toEqual({ path: 'mail-files/IMG_4640 (2).jpeg', fileName: 'IMG_4640 (2).jpeg', renamed: true })
    await saveMailFile(Buffer.from('three'), { root, folder: 'mail-files', name: 'IMG_4640.jpeg' })
    const folder = join(root, 'mail-files')
    expect((await readdir(folder)).sort()).toEqual(['IMG_4640 (2).jpeg', 'IMG_4640 (3).jpeg', 'IMG_4640.jpeg'])
    expect(await Promise.all(['IMG_4640.jpeg', 'IMG_4640 (2).jpeg', 'IMG_4640 (3).jpeg'].map(name => readFile(join(folder, name), 'utf8')))).toEqual(['one', 'two', 'three'])
  })

  it('refuses a folder outside the thread’s folder and writes nothing there', async () => {
    const root = await threadFolder()
    const outside = await threadFolder()
    await writeFile(join(outside, 'kept.txt'), 'kept')
    for (const folder of ['..', `../${outside.split(/[\\/]/u).at(-1)!}`, outside]) {
      await expect(saveMailFile(Buffer.from('x'), { root, folder, name: 'a.txt' })).rejects.toBeInstanceOf(MailSaveError)
    }
    expect(await readdir(outside)).toEqual(['kept.txt'])
  })
})
