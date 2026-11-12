// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { downloadName, FileDownloads } from '../../../src/main/files/downloads'
import type { FileDownloadProgress, FilesResult, LinkedFile, LinkedFileRequest } from '../../../src/shared/files'

type PartRequest = Extract<LinkedFileRequest, { want: 'part' }>
let folder: string
const revision = 'a'.repeat(64)
const request = { threadId: 'host:22222222-2222-4222-8222-222222222222:thread', path: 'out/report.pdf' }
/** A host that sends `bytes` three at a time under `name`. */
function host(bytes: Buffer, name = 'report.pdf') {
  return vi.fn(async ({ offset }: PartRequest): Promise<FilesResult<LinkedFile>> => ({ ok: true, value: { is: 'part', name, size: bytes.length, offset, data: bytes.subarray(offset, offset + 3).toString('base64'), revision } }))
}
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'sotto-downloads-')) })
afterEach(async () => {
  if (!resolve(folder).startsWith(resolve(tmpdir()) + sep) || !folder.includes('sotto-downloads-')) throw new Error('Unsafe fixture cleanup')
  await rm(folder, { recursive: true, force: true })
})

describe('saving a file from a paired host to Downloads (ADR-0120, November 12 amendment)', () => {
  it('writes every part into Downloads under the file\'s name, says how far it is, and keeps the saved file only by a handle', async () => {
    const part = host(Buffer.from('12345678'))
    const progress: FileDownloadProgress[] = []
    const downloads = new FileDownloads({ part, folder: () => folder, progress: event => progress.push(event) })
    const result = await downloads.download(request)
    expect(result).toMatchObject({ ok: true, value: { name: 'report.pdf', size: 8 } })
    expect(await readdir(folder)).toEqual(['report.pdf'])
    expect(await readFile(join(folder, 'report.pdf'), 'utf8')).toBe('12345678')
    expect(part.mock.calls.map(([asked]) => [asked.offset, asked.revision])).toEqual([[0, undefined], [3, revision], [6, revision]])
    expect(progress).toEqual([3, 6, 8].map(received => ({ ...request, received, size: 8 })))
    // The window is handed a handle and the name, never where the file is.
    if (!result.ok) throw new Error('not saved')
    expect(Object.keys(result.value).sort()).toEqual(['downloadId', 'name', 'size'])
    expect(downloads.savedPath(result.value.downloadId)).toBe(join(folder, 'report.pdf'))
    expect(downloads.savedPath('0'.repeat(32))).toBeUndefined()
  })

  it('numbers a name already taken, as a browser does, and saves an empty file', async () => {
    await writeFile(join(folder, 'report.pdf'), 'mine'); await writeFile(join(folder, 'report (1).pdf'), 'mine too')
    const downloads = new FileDownloads({ part: host(Buffer.from('new')), folder: () => folder, progress: () => undefined })
    expect(await downloads.download(request)).toMatchObject({ ok: true, value: { name: 'report (2).pdf' } })
    expect(await readFile(join(folder, 'report.pdf'), 'utf8')).toBe('mine')
    const empty = new FileDownloads({ part: host(Buffer.alloc(0), 'empty'), folder: () => folder, progress: () => undefined })
    expect(await empty.download(request)).toMatchObject({ ok: true, value: { name: 'empty', size: 0 } })
    expect((await readdir(folder)).sort()).toEqual(['empty', 'report (1).pdf', 'report (2).pdf', 'report.pdf'])
  })

  it('leaves nothing behind when it is stopped, when the host refuses, and when the host answers something else', async () => {
    const bytes = Buffer.from('123456789')
    const running: { downloads?: FileDownloads } = {}
    const stopping = vi.fn(async ({ offset }: PartRequest): Promise<FilesResult<LinkedFile>> => {
      if (offset === 3) expect(running.downloads?.stop(request)).toEqual({ ok: true, value: { stopped: true } })
      return { ok: true, value: { is: 'part', name: 'report.pdf', size: bytes.length, offset, data: bytes.subarray(offset, offset + 3).toString('base64'), revision } }
    })
    const downloads = running.downloads = new FileDownloads({ part: stopping, folder: () => folder, progress: () => undefined })
    expect(await downloads.download(request)).toMatchObject({ ok: false, error: { message: 'Download stopped. Nothing was saved.' } })
    expect(stopping).toHaveBeenCalledTimes(2)
    expect(downloads.stop(request)).toEqual({ ok: true, value: { stopped: false } })

    const changed = { ok: false as const, error: { code: 'path-unavailable' as const, message: 'This file changed while it was being downloaded. Nothing was saved.' } }
    const refusing = vi.fn(async ({ offset }: PartRequest): Promise<FilesResult<LinkedFile>> => offset === 0 ? { ok: true, value: { is: 'part', name: 'report.pdf', size: 9, offset, data: 'MTIz', revision } } : changed)
    expect(await new FileDownloads({ part: refusing, folder: () => folder, progress: () => undefined }).download(request)).toEqual(changed)

    const answers: FilesResult<LinkedFile>[] = [
      { ok: true, value: { is: 'place', name: 'report.pdf', kind: 'file', size: 9, inside: null } },
      { ok: true, value: { is: 'part', name: 'report.pdf', size: 9, offset: 5, data: 'MTIz', revision } },
      { ok: true, value: { is: 'part', name: 'report.pdf', size: 2, offset: 0, data: 'MTIz', revision } },
      { ok: true, value: { is: 'part', name: 'report.pdf', size: 9, offset: 0, data: '', revision } },
    ]
    for (const answer of answers) expect(await new FileDownloads({ part: async () => answer, folder: () => folder, progress: () => undefined }).download(request)).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    const throwing = new FileDownloads({ part: async () => { throw new Error('socket closed') }, folder: () => folder, progress: () => undefined })
    expect(await throwing.download(request)).toMatchObject({ ok: false, error: { message: 'The download did not finish. Nothing was saved. Try again.' } })
    expect(await readdir(folder)).toEqual([])
  })

  it('never replaces a file that took the name while the download ran, and stops even on its last part', async () => {
    // Another program saves report.pdf between the first part and the last.
    const racing = vi.fn(async ({ offset }: PartRequest): Promise<FilesResult<LinkedFile>> => {
      if (offset === 3) await writeFile(join(folder, 'report.pdf'), 'theirs')
      return { ok: true, value: { is: 'part', name: 'report.pdf', size: 6, offset, data: Buffer.from('123456').subarray(offset, offset + 3).toString('base64'), revision } }
    })
    expect(await new FileDownloads({ part: racing, folder: () => folder, progress: () => undefined }).download(request)).toMatchObject({ ok: true, value: { name: 'report (1).pdf' } })
    expect(await readFile(join(folder, 'report.pdf'), 'utf8')).toBe('theirs')
    expect(await readFile(join(folder, 'report (1).pdf'), 'utf8')).toBe('123456')

    // A stop that arrives with the last part still leaves nothing.
    const running: { downloads?: FileDownloads } = {}
    const last = vi.fn(async ({ offset }: PartRequest): Promise<FilesResult<LinkedFile>> => ({ ok: true, value: { is: 'part', name: 'late.txt', size: 3, offset, data: 'MTIz', revision } }))
    const downloads = running.downloads = new FileDownloads({ part: last, folder: () => folder, progress: () => { running.downloads?.stop(request) } })
    expect(await downloads.download(request)).toMatchObject({ ok: false, error: { message: 'Download stopped. Nothing was saved.' } })
    expect((await readdir(folder)).sort()).toEqual(['report (1).pdf', 'report.pdf'])
  })

  it('downloads one file once at a time, and another beside it', async () => {
    let release = (): void => undefined
    const held = new Promise<void>(done => { release = done })
    const part = vi.fn(async ({ offset, path }: PartRequest): Promise<FilesResult<LinkedFile>> => {
      if (path === request.path) await held
      return { ok: true, value: { is: 'part', name: path.split('/').pop()!, size: 3, offset, data: 'MTIz', revision } }
    })
    const downloads = new FileDownloads({ part, folder: () => folder, progress: () => undefined })
    const first = downloads.download(request)
    expect(await downloads.download(request)).toMatchObject({ ok: false, error: { code: 'busy', message: 'This file is already downloading.' } })
    expect(await downloads.download({ ...request, path: 'out/other.txt' })).toMatchObject({ ok: true, value: { name: 'other.txt' } })
    release()
    expect(await first).toMatchObject({ ok: true, value: { name: 'report.pdf' } })
  })

  it('saves under a name this computer can hold, whatever the host called the file', () => {
    expect(downloadName('report.pdf')).toBe('report.pdf')
    expect(downloadName('../../etc/passwd')).toBe('.._.._etc_passwd')
    expect(downloadName('C:\\Windows\\win.ini')).toBe('C__Windows_win.ini')
    expect(downloadName('a<b>c:d"e|f?g*h\u0000i')).toBe('a_b_c_d_e_f_g_h_i')
    expect(downloadName('trailing. . ')).toBe('trailing')
    // A name this computer can hold is kept, a leading dot included.
    expect(downloadName('.bashrc')).toBe('.bashrc')
    expect(downloadName('.env')).toBe('.env')
    expect(downloadName('CON')).toBe('_CON')
    expect(downloadName('nul.txt')).toBe('_nul.txt')
    expect(downloadName('...')).toBe('download')
    expect(downloadName('x'.repeat(400))).toHaveLength(200)
  })
})
