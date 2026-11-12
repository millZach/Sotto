// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { FilesService, type FilesBinding } from '../../../src/main/files/service'
import { FILES_DOWNLOAD_PART_BYTES, isProgramPath, linkedFileSchema, type FilesResult, type LinkedFile } from '../../../src/shared/files'

let directory: string, root: string, other: string, service: FilesService, binding: FilesBinding | null
const revealed = vi.fn(), opened = vi.fn<(path: string) => Promise<void>>(async () => undefined)
const value = <T>(result: FilesResult<T>): T => { expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(result.error.message); return result.value }
const error = (result: FilesResult<unknown>, code: string): void => { expect(result).toMatchObject({ ok: false, error: { code } }) }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=', 'base64')
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sotto-linked-'))
  root = join(directory, 'workspace'); other = join(directory, 'outside')
  await mkdir(root); await mkdir(other)
  binding = { threadId: 'thread', projectId: 'project', workingDirectory: root }
  service = new FilesService({ resolveBinding: id => id === 'thread' ? binding : null, copyPath: vi.fn(), reveal: revealed, open: opened })
})
afterEach(async () => {
  vi.clearAllMocks()
  // Only delete this test's freshly-created directory under the OS temporary root.
  if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !directory.includes('sotto-linked-')) throw new Error('Unsafe fixture cleanup')
  await rm(directory, { recursive: true, force: true })
})

describe('opening a file a message links to (ADR-0120, November 12 amendment)', () => {
  it('opens a file anywhere on this computer and a folder, in the app the computer chooses, and says only that it did', async () => {
    await mkdir(join(root, 'out')); await writeFile(join(root, 'out', 'report.pdf'), '%PDF-1.7'); await writeFile(join(other, 'sales.csv'), 'a,b')
    expect(value(await service.openLink({ threadId: 'thread', path: 'out/report.pdf' }))).toEqual({ did: 'opened' })
    value(await service.openLink({ threadId: 'thread', path: join(other, 'sales.csv') }))
    value(await service.openLink({ threadId: 'thread', path: 'out/report.pdf:12' }))
    value(await service.openLink({ threadId: 'thread', path: 'out' }))
    expect(opened.mock.calls).toEqual([[await realpath(join(root, 'out', 'report.pdf'))], [await realpath(join(other, 'sales.csv'))], [await realpath(join(root, 'out', 'report.pdf'))], [await realpath(join(root, 'out'))]])
    expect(revealed).not.toHaveBeenCalled()
  })

  it('never opens a program, installer, shortcut or script by its name: it is shown in its folder', async () => {
    for (const name of ['setup.exe', 'build.BAT', 'deploy.sh', 'tool.ps1', 'run.js', 'Report.pdf.lnk', 'install.msi', 'start.desktop', 'job.py', 'App.command']) {
      await writeFile(join(root, name), 'echo hi')
      expect(value(await service.openLink({ threadId: 'thread', path: name })), name).toEqual({ did: 'shown' })
      expect(revealed).toHaveBeenLastCalledWith(await realpath(join(root, name)))
    }
    // A Mac's app is a folder, and opening that folder starts it.
    await mkdir(join(root, 'Notes.app'))
    expect(value(await service.openLink({ threadId: 'thread', path: 'Notes.app' }))).toEqual({ did: 'shown' })
    expect(opened).not.toHaveBeenCalled()
  })

  it('never opens a program whatever it is called: by how the file starts, and by the file a link really leads to', async () => {
    // Windows, Linux and Mac executables, and a script that names its interpreter, all named as documents.
    const starts: [string, Buffer][] = [['windows.pdf', Buffer.from('MZ\x90\x00rest')], ['linux.txt', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])], ['mac.png', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7])],
      ['fat.doc', Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0])], ['notes', Buffer.from('#!/bin/sh\nrm -rf ~\n')]]
    for (const [name, bytes] of starts) {
      await writeFile(join(root, name), bytes)
      expect(value(await service.openLink({ threadId: 'thread', path: name })), name).toEqual({ did: 'shown' })
    }
    expect(opened).not.toHaveBeenCalled()
    // A real picture named as one still opens.
    await writeFile(join(root, 'chart.png'), png)
    expect(value(await service.openLink({ threadId: 'thread', path: 'chart.png' }))).toEqual({ did: 'opened' })
  })

  it.skipIf(process.platform === 'win32')('never opens a document name that is a link to a program', async () => {
    await writeFile(join(other, 'payload.sh'), 'echo hi'); await chmod(join(other, 'payload.sh'), 0o755)
    await symlink(join(other, 'payload.sh'), join(other, 'report.pdf'))
    expect(value(await service.openLink({ threadId: 'thread', path: join(other, 'report.pdf') }))).toEqual({ did: 'shown' })
    expect(opened).not.toHaveBeenCalled()
  })

  it('refuses what showing a file refuses, says when no app took the file, and opens nothing on a host\'s own reads', async () => {
    await writeFile(join(other, 'b.pdf'), 'b')
    error(await service.openLink({ threadId: 'thread', path: join(other, 'missing.pdf') }), 'path-unavailable')
    error(await service.openLink({ threadId: 'unknown', path: join(other, 'b.pdf') }), 'thread-unavailable')
    error(await service.openLink({ threadId: 'thread', path: '../outside/b.pdf' }), 'path-outside-workspace')
    for (const path of ['\\\\evil.example\\share\\a.pdf', '//evil.example/share/a.pdf', 'C:a.pdf', 'a\u0000b']) error(await service.openLink({ threadId: 'thread', path }), 'invalid-request')
    expect(opened).not.toHaveBeenCalled()
    opened.mockRejectedValueOnce(new Error('No app'))
    expect(await service.openLink({ threadId: 'thread', path: join(other, 'b.pdf') })).toMatchObject({ ok: false, error: { code: 'unavailable', message: 'This computer has no app set to open this file. Nothing was opened.' } })
    const reads = new FilesService({ resolveBinding: () => binding, copyPath: vi.fn(), reveal: revealed })
    error(await reads.openLink({ threadId: 'thread', path: join(other, 'b.pdf') }), 'unavailable')
    expect(revealed).not.toHaveBeenCalled()
  })

  it('reads a path\'s ending as a program\'s with or without a line after it, and leaves documents and source alone', () => {
    for (const path of ['D:/Reports/build-report.bat', 'setup.EXE', '~/bin/deploy.sh:12', 'C:\\Tools\\run.ps1', '/Applications/Notes.app', 'a/b.lnk', 'trailing.exe. ', 'tool.pyzw', 'cache.pyo']) expect(isProgramPath(path), path).toBe(true)
    for (const path of ['D:/Reports/q3-report.pdf', 'src/main.ts', 'notes.md#L4', 'photo.png', '/home/me/out', 'archive.zip', 'page.html', 'data.json']) expect(isProgramPath(path), path).toBe(false)
  })
})

describe('a linked file read for Files on another computer (ADR-0120, November 12 amendment)', () => {
  const read = async (request: Record<string, unknown>): Promise<LinkedFile> => linkedFileSchema.parse(value(await service.linkedFile({ threadId: 'thread', ...request })))

  it('says where a file or folder is: its place in the thread\'s folder as Files lists it, or nowhere Files browses', async () => {
    await mkdir(join(root, 'out', 'figures'), { recursive: true }); await writeFile(join(root, 'out', 'report.pdf'), 'abc'); await writeFile(join(other, 'sales.csv'), 'a,b\n')
    const inside = await read({ want: 'place', path: join(root, 'out', 'report.pdf') })
    expect(inside).toMatchObject({ is: 'place', name: 'report.pdf', kind: 'file', size: 3, inside: { path: 'out/report.pdf', workspace: { threadId: 'thread', projectId: 'project' } } })
    // The workspace is the one Files' own listing names, so the tree it already holds is the one shown.
    expect(inside.is === 'place' && inside.inside?.workspace).toEqual(value(await service.list({ threadId: 'thread', path: '' })).workspace)
    expect(await read({ want: 'place', path: 'out/figures' })).toMatchObject({ kind: 'directory', size: 0, inside: { path: 'out/figures' } })
    expect(await read({ want: 'place', path: 'out/report.pdf:3' })).toMatchObject({ kind: 'file', inside: { path: 'out/report.pdf' } })
    expect(await read({ want: 'place', path: root })).toMatchObject({ kind: 'directory', inside: { path: '' } })
    expect(await read({ want: 'place', path: join(other, 'sales.csv') })).toEqual({ is: 'place', name: 'sales.csv', kind: 'file', size: 4, inside: null })
    error(await service.linkedFile({ threadId: 'thread', want: 'place', path: '../outside/sales.csv' }), 'path-outside-workspace')
    error(await service.linkedFile({ threadId: 'thread', want: 'place', path: join(other, 'missing.csv') }), 'path-unavailable')
    error(await service.linkedFile({ threadId: 'unknown', want: 'place', path: join(other, 'sales.csv') }), 'thread-unavailable')
    error(await service.linkedFile({ threadId: 'thread', want: 'place', path: '//evil.example/share/a' }), 'invalid-request')
    error(await service.linkedFile({ threadId: 'thread', want: 'everything', path: join(other, 'sales.csv') }), 'invalid-request')
  })

  it.skipIf(process.platform === 'win32')('shows a link in the folder that leads out of it alone, as the file it really is', async () => {
    await writeFile(join(other, 'sales.csv'), 'a,b\n'); await symlink(join(other, 'sales.csv'), join(root, 'data.csv'))
    // Shown alone, under the link's own name: where the path led is not said.
    expect(await read({ want: 'place', path: join(root, 'data.csv') })).toEqual({ is: 'place', name: 'data.csv', kind: 'file', size: 4, inside: null })
    expect(await read({ want: 'preview', path: join(root, 'data.csv') })).toMatchObject({ name: 'data.csv' })
    expect(await read({ want: 'part', path: join(root, 'data.csv'), offset: 0 })).toMatchObject({ name: 'data.csv', size: 4 })
    // Written relative to the thread's folder it must stay inside it, as in Files.
    error(await service.linkedFile({ threadId: 'thread', want: 'place', path: 'data.csv' }), 'path-outside-workspace')
  })

  it.skipIf(process.platform === 'win32')('shows a saved download that has become a link to a program, by the file it really is', async () => {
    await writeFile(join(other, 'task.cmd'), 'echo hi\r\n'); await symlink(join(other, 'task.cmd'), join(other, 'report.pdf'))
    expect(value(await service.openHere(join(other, 'report.pdf')))).toEqual({ did: 'shown' })
    await writeFile(join(other, 'real.pdf'), '%PDF-1.7')
    expect(value(await service.openHere(join(other, 'real.pdf')))).toEqual({ did: 'opened' })
    expect(opened).toHaveBeenCalledOnce()
    error(await service.openHere(join(other, 'gone.pdf')), 'path-unavailable')
  })

  it('previews text, Markdown and pictures within Files\' own limits, and says when there is none', async () => {
    await writeFile(join(other, 'sales.csv'), 'a,b\n'); await writeFile(join(other, 'notes.md'), '# Notes'); await writeFile(join(other, 'chart.png'), png)
    await writeFile(join(other, 'report.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 1, 2])); await writeFile(join(other, 'big.log'), Buffer.alloc(600 * 1024, 'a'))
    expect(await read({ want: 'preview', path: join(other, 'sales.csv') })).toEqual({ is: 'preview', name: 'sales.csv', size: 4, content: { kind: 'text', text: 'a,b\n' } })
    expect(await read({ want: 'preview', path: join(other, 'notes.md') })).toMatchObject({ content: { kind: 'markdown', text: '# Notes' } })
    expect(await read({ want: 'preview', path: join(other, 'chart.png') })).toMatchObject({ content: { kind: 'image', mime: 'image/png' } })
    error(await service.linkedFile({ threadId: 'thread', want: 'preview', path: join(other, 'report.pdf') }), 'binary')
    error(await service.linkedFile({ threadId: 'thread', want: 'preview', path: join(other, 'big.log') }), 'too-large')
    error(await service.linkedFile({ threadId: 'thread', want: 'preview', path: other }), 'not-file')
  })

  it('sends a file in parts that join into the same bytes, and refuses a file that changed between two', async () => {
    const bytes = Buffer.alloc(FILES_DOWNLOAD_PART_BYTES + 1000)
    for (let index = 0; index < bytes.length; index += 997) bytes[index] = index % 251
    const path = join(other, 'movie.bin')
    await writeFile(path, bytes)
    const first = await read({ want: 'part', path, offset: 0 })
    if (first.is !== 'part') throw new Error('not a part')
    expect(first).toMatchObject({ name: 'movie.bin', size: bytes.length, offset: 0 })
    const second = await read({ want: 'part', path, offset: FILES_DOWNLOAD_PART_BYTES, revision: first.revision })
    if (second.is !== 'part') throw new Error('not a part')
    expect(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(second.data, 'base64')]).equals(bytes)).toBe(true)
    expect(second.revision).toBe(first.revision)
    // An empty file is one empty part.
    await writeFile(join(other, 'empty.txt'), '')
    expect(await read({ want: 'part', path: join(other, 'empty.txt'), offset: 0 })).toMatchObject({ size: 0, data: '' })
    error(await service.linkedFile({ threadId: 'thread', want: 'part', path, offset: bytes.length + 1, revision: first.revision }), 'invalid-request')
    error(await service.linkedFile({ threadId: 'thread', want: 'part', path: other, offset: 0 }), 'not-file')
    await writeFile(path, Buffer.concat([bytes, Buffer.from('more')]))
    expect(await service.linkedFile({ threadId: 'thread', want: 'part', path, offset: FILES_DOWNLOAD_PART_BYTES, revision: first.revision })).toMatchObject({ ok: false, error: { code: 'path-unavailable', message: 'This file changed while it was being downloaded. Nothing was saved.' } })
  })
})
