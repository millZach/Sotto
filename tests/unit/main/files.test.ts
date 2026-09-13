// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, rename, symlink, open, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { FilesService, type FilesBinding } from '../../../src/main/files/service'
import { FILES_MAX_IMAGE_BYTES, FILES_MAX_TEXT_BYTES, filePreviewSchema, type FilesResult } from '../../../src/shared/files'

const race = vi.hoisted(() => ({ beforeOpen: undefined as (() => Promise<void>) | undefined }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const hook = race.beforeOpen
    race.beforeOpen = undefined
    if (hook) await hook()
    return actual.open(...args)
  } }
})

let directory: string, root: string, other: string, service: FilesService, binding: FilesBinding | null
const copied = vi.fn(), revealed = vi.fn()
const value = <T>(result: FilesResult<T>): T => { expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(result.error.message); return result.value }
const error = (result: FilesResult<unknown>, code: string): void => { expect(result).toMatchObject({ ok: false, error: { code } }) }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=', 'base64')
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sotto-files-'))
  root = join(directory, 'workspace'); other = join(directory, 'outside')
  await mkdir(root); await mkdir(other)
  binding = { threadId: 'thread', projectId: 'project', workingDirectory: root }
  service = new FilesService({ resolveBinding: id => id === 'thread' ? binding : null, copyPath: copied, reveal: revealed })
})
afterEach(async () => {
  race.beforeOpen = undefined; vi.clearAllMocks()
  // Only delete this test's freshly-created directory under the OS temporary root.
  if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !directory.includes('sotto-files-')) throw new Error('Unsafe fixture cleanup')
  await rm(directory, { recursive: true, force: true })
})
async function request(path: string) {
  const listing = value(await service.list({ threadId: 'thread', path: '' }))
  return { threadId: 'thread', path, workspaceId: listing.workspace.workspaceId }
}

describe('thread-bound Files service', () => {
  it('lazily lists a directory, previews UTF-8/Markdown/raster content and copies/reveals only canonical bound paths', async () => {
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'z.md'), '# Hello\n[unsafe](javascript:alert(1))')
    await writeFile(join(root, 'nested', 'image.bin'), png)
    const listing = value(await service.list({ threadId: 'thread', path: '' }))
    expect(listing.workspace).toMatchObject({ threadId: 'thread', projectId: 'project', workingDirectory: root })
    expect(listing.entries).toEqual([{ name: 'nested', path: 'nested', kind: 'directory' }, { name: 'z.md', path: 'z.md', kind: 'file' }])
    const markdown = value(await service.preview(await request('z.md')))
    expect(markdown.content).toEqual({ kind: 'markdown', text: '# Hello\n[unsafe](javascript:alert(1))' })
    expect(filePreviewSchema.parse(markdown)).toEqual(markdown)
    const image = value(await service.preview(await request('nested/image.bin')))
    expect(image.content).toEqual({ kind: 'image', mime: 'image/png', dataUrl: `data:image/png;base64,${png.toString('base64')}` })
    expect(filePreviewSchema.parse(image)).toEqual(image)
    const nested = value(await service.list(await request('nested')))
    expect(nested.entries.map(entry => entry.path)).toEqual(['nested/image.bin'])
    const copiedPath = value(await service.copyPath(await request('z.md')))
    expect(copiedPath.absolutePath).toBe(await realpath(join(root, 'z.md')))
    expect(copied).toHaveBeenCalledWith(copiedPath.absolutePath)
    value(await service.reveal(await request('')))
    expect(revealed).toHaveBeenCalledWith(await realpath(root))
  })

  it.each(['../outside/private.txt', '/etc/passwd', 'C:/Windows/win.ini', 'C:relative', '\\server\\share', '..\\outside', 'a/../b', 'a//b', 'a/./b', 'file:stream', 'NUL', 'aux.txt', 'COM1', 'trailing.', 'trailing ', 'a\u0000b'])('rejects noncanonical/escaping path %j for every operation', async path => {
    const input = await request(path)
    for (const method of ['list', 'preview', 'copyPath', 'reveal'] as const) error(await service[method](input), 'invalid-request')
    expect(copied).not.toHaveBeenCalled(); expect(revealed).not.toHaveBeenCalled()
  })

  it('rejects injected roots, unknown threads, tokenless subdirectories and cross-thread workspace tokens', async () => {
    error(await service.list({ threadId: 'thread', path: '', root: other }), 'invalid-request')
    error(await service.list({ threadId: 'missing', path: '' }), 'thread-unavailable')
    error(await service.list({ threadId: 'thread', path: 'nested' }), 'invalid-request')
    const first = await request('')
    const second = new FilesService({ resolveBinding: id => ({ threadId: id, projectId: 'project', workingDirectory: root }), copyPath: copied, reveal: revealed })
    error(await second.reveal({ ...first, threadId: 'second' }), 'workspace-changed')
  })

  it('allows internal junctions but marks escaping and broken links unavailable without disclosing external contents', async () => {
    await mkdir(join(root, 'inside')); await writeFile(join(root, 'inside', 'allowed.md'), 'inside')
    await writeFile(join(other, 'private.txt'), 'outside secret')
    await symlink(other, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(join(root, 'inside'), join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(join(directory, 'missing'), join(root, 'broken'), process.platform === 'win32' ? 'junction' : 'dir')
    const listing = value(await service.list({ threadId: 'thread', path: '' }))
    expect(listing.entries).toEqual(expect.arrayContaining([{ name: 'escape', path: 'escape', kind: 'unavailable' }, { name: 'broken', path: 'broken', kind: 'unavailable' }, { name: 'link', path: 'link', kind: 'directory' }]))
    const result = await service.preview(await request('escape/private.txt'))
    error(result, 'path-outside-workspace')
    expect(JSON.stringify(result)).not.toContain(other)
    for (const method of ['list', 'copyPath', 'reveal'] as const) error(await service[method](await request('escape')), 'path-outside-workspace')
    expect(value(await service.preview(await request('link/allowed.md'))).content).toEqual({ kind: 'markdown', text: 'inside' })
    error(await service.preview(await request('broken/private.txt')), 'path-unavailable')
    expect(copied).not.toHaveBeenCalled(); expect(revealed).not.toHaveBeenCalled()
  })

  it('rejects stale paths when native cwd, project binding, or the physical root changes', async () => {
    await writeFile(join(root, 'same.txt'), 'original'); await writeFile(join(other, 'same.txt'), 'different')
    const original = await request('same.txt')
    binding = { ...binding!, workingDirectory: other }
    for (const method of ['preview', 'copyPath', 'reveal'] as const) error(await service[method](original), 'workspace-changed')
    binding = { ...binding!, workingDirectory: root, projectId: 'another-project' }
    error(await service.preview(original), 'workspace-changed')
    binding = { ...binding!, projectId: 'project' }
    await rename(root, join(directory, 'old-root')); await mkdir(root); await writeFile(join(root, 'same.txt'), 'replacement')
    error(await service.preview(original), 'workspace-changed')
    expect(value(await service.preview(await request('same.txt'))).content).toEqual({ kind: 'text', text: 'replacement' })
  })

  it('recovers from missing folder/file, non-file selection, binary and oversized content', async () => {
    const current = await request('gone.txt')
    error(await service.preview(current), 'path-unavailable')
    await writeFile(join(root, 'gone.txt'), 'back')
    expect(value(await service.preview(current)).content).toEqual({ kind: 'text', text: 'back' })
    error(await service.preview({ ...current, path: '' }), 'not-file')
    error(await service.list(current), 'not-directory')
    await writeFile(join(root, 'binary'), Buffer.from([0, 1, 2, 3])); error(await service.preview({ ...current, path: 'binary' }), 'binary')
    await writeFile(join(root, 'invalid'), Buffer.from([0xc3, 0x28])); error(await service.preview({ ...current, path: 'invalid' }), 'binary')
    await writeFile(join(root, 'long.txt'), 'x'.repeat(FILES_MAX_TEXT_BYTES + 1)); error(await service.preview({ ...current, path: 'long.txt' }), 'too-large')
    const oversized = await open(join(root, 'huge.png'), 'w'); await oversized.truncate(FILES_MAX_IMAGE_BYTES + 1); await oversized.close()
    error(await service.preview({ ...current, path: 'huge.png' }), 'too-large')
    await rename(root, join(directory, 'unavailable'))
    error(await service.preview(current), 'workspace-unavailable')
    await rename(join(directory, 'unavailable'), root)
    expect(value(await service.preview(current)).content).toEqual({ kind: 'text', text: 'back' })
  })

  it('keeps SVG/HTML and spoofed image extensions inert text and caps decoded image dimensions', async () => {
    for (const name of ['image.svg', 'page.html', 'fake.png']) {
      await writeFile(join(root, name), '<svg onload="alert(1)"></svg>')
      expect(value(await service.preview(await request(name))).content).toEqual({ kind: 'text', text: '<svg onload="alert(1)"></svg>' })
    }
    const bomb = Buffer.from(png); bomb.writeUInt32BE(100_000, 16)
    await writeFile(join(root, 'bomb.png'), bomb)
    error(await service.preview(await request('bomb.png')), 'too-large')
  })

  it('refuses a replacement between resolution and descriptor open, then permits a fresh retry', async () => {
    await writeFile(join(root, 'file.txt'), 'old')
    const input = await request('file.txt')
    race.beforeOpen = async () => { await rename(join(root, 'file.txt'), join(root, 'old.txt')); await writeFile(join(root, 'file.txt'), 'new') }
    error(await service.preview(input), 'path-unavailable')
    expect(value(await service.preview(input)).content).toEqual({ kind: 'text', text: 'new' })
  })

  it('refuses an escaping junction exchanged immediately before open', async () => {
    await mkdir(join(root, 'folder')); await writeFile(join(root, 'folder', 'file.txt'), 'inside')
    await writeFile(join(other, 'file.txt'), 'secret')
    const input = await request('folder/file.txt')
    race.beforeOpen = async () => { await rename(join(root, 'folder'), join(root, 'moved')); await symlink(other, join(root, 'folder'), process.platform === 'win32' ? 'junction' : 'dir') }
    error(await service.preview(input), 'path-unavailable')
  })

  it('rejects cwd changes during resolution and bounds concurrent requests', async () => {
    let calls = 0
    const changing = new FilesService({ resolveBinding: () => ({ ...binding!, workingDirectory: ++calls === 1 ? root : other }), copyPath: copied, reveal: revealed })
    error(await changing.list({ threadId: 'thread', path: '' }), 'workspace-changed')
    const results = await Promise.all(Array.from({ length: 5 }, () => service.list({ threadId: 'thread', path: '' })))
    expect(results.filter(result => !result.ok && result.error.code === 'busy')).toHaveLength(1)
    expect(results.filter(result => result.ok)).toHaveLength(4)
  })

  it('bounds directory enumeration without losing ordinary directory browsing', async () => {
    for (let offset = 0; offset < 1005; offset += 20) {
      await Promise.all(Array.from({ length: Math.min(20, 1005 - offset) }, (_, index) => writeFile(join(root, `file-${index + offset}`), '')))
    }
    const listing = value(await service.list({ threadId: 'thread', path: '' }))
    expect(listing.entries).toHaveLength(1000); expect(listing.truncated).toBe(true)
  })
})
