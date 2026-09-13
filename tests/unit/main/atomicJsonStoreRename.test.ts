// @vitest-environment node
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, rename: vi.fn(fs.rename) }
})

const nativeFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const roots: string[] = []
const renameMock = vi.mocked(rename)

beforeEach(() => { renameMock.mockReset(); renameMock.mockImplementation(nativeFs.rename) })
afterEach(async () => {
  Object.defineProperty(process, 'platform', originalPlatform)
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const errorWithCode = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`Synthetic rename ${code}`), { code })
async function fixture(platform: NodeJS.Platform = 'win32') {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform })
  const root = await mkdtemp(join(tmpdir(), 'sotto-atomic-rename-')); roots.push(root)
  const path = join(root, 'store.json')
  await writeFile(path, '{"value":"original"}\n')
  const store = new AtomicJsonStore(path, input => input as { value: string }, () => ({ value: 'default' }))
  return { root, path, store }
}

it.each(['EPERM', 'EBUSY'])('retries transient Windows %s using the same synced temporary file', async code => {
  const f = await fixture()
  let temporary: string | undefined
  renameMock.mockImplementationOnce(async (source, destination) => {
    temporary = String(source)
    expect(String(destination)).toBe(f.path)
    expect(await readFile(f.path, 'utf8')).toBe('{"value":"original"}\n')
    expect(JSON.parse(await readFile(source, 'utf8'))).toEqual({ value: 'replacement' })
    throw errorWithCode(code)
  })
  await expect(f.store.write({ value: 'replacement' })).resolves.toBeUndefined()
  expect(renameMock).toHaveBeenCalledTimes(2)
  expect(renameMock.mock.calls[1]).toEqual([temporary, f.path])
  expect(await f.store.read()).toEqual({ value: 'replacement' })
  expect(await readdir(f.root)).toEqual(['store.json'])
})

it.each(['EPERM', 'EBUSY'])('bounds persistent Windows %s, preserves the original and cleans its temp', async code => {
  const f = await fixture()
  const failure = errorWithCode(code)
  renameMock.mockImplementation(async () => {
    expect(await readFile(f.path, 'utf8')).toBe('{"value":"original"}\n')
    throw failure
  })
  await expect(f.store.write({ value: 'replacement' })).rejects.toBe(failure)
  expect(renameMock).toHaveBeenCalledTimes(6)
  expect(new Set(renameMock.mock.calls.map(([source]) => source)).size).toBe(1)
  expect(await readFile(f.path, 'utf8')).toBe('{"value":"original"}\n')
  expect(await readdir(f.root)).toEqual(['store.json'])
  renameMock.mockImplementation(nativeFs.rename)
  await f.store.write({ value: 'later successful write' })
  expect(await f.store.read()).toEqual({ value: 'later successful write' })
})

it.each([
  ['linux', 'EPERM'], ['linux', 'EBUSY'], ['darwin', 'EPERM'], ['darwin', 'EBUSY'],
  ['win32', 'EACCES'], ['win32', 'EIO'], ['win32', 'ENOSPC'], ['win32', 'ENOENT'], ['win32', 'EXDEV'],
] as const)('does not retry %s %s', async (platform, code) => {
  const f = await fixture(platform)
  const failure = errorWithCode(code)
  renameMock.mockRejectedValue(failure)
  await expect(f.store.write({ value: 'replacement' })).rejects.toBe(failure)
  expect(renameMock).toHaveBeenCalledTimes(1)
  expect(await readFile(f.path, 'utf8')).toBe('{"value":"original"}\n')
  expect(await readdir(f.root)).toEqual(['store.json'])
})

it('keeps later writes queued behind the retried replacement', async () => {
  const f = await fixture()
  const replacements: string[] = []
  renameMock.mockImplementation(async (source, destination) => {
    const value = JSON.parse(await readFile(source, 'utf8')).value as string
    replacements.push(value)
    if (replacements.length === 1) throw errorWithCode('EPERM')
    await nativeFs.rename(source, destination)
  })
  const first = f.store.write({ value: 'first' })
  const second = f.store.write({ value: 'second' })
  await Promise.all([first, second])
  expect(replacements).toEqual(['first', 'first', 'second'])
  expect(await f.store.read()).toEqual({ value: 'second' })
  expect(await readdir(f.root)).toEqual(['store.json'])
})
