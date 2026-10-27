// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// A link inside a thread's folder that leads somewhere else must be judged by its own words, before anything it leads to
// is touched: if it led to a network share, looking would reach the share (review finding on ADR-0085's October 27
// amendment). Every path the file system is asked about, and every path `realpath` answers with, is recorded here.
const touched = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  // What realpath answers is where the system went to find it; what readlink answers is only the link's own words.
  const record = <A extends unknown[], R>(call: (...args: A) => Promise<R>, answers = false) => async (...args: A): Promise<R> => {
    if (typeof args[0] === 'string') touched.push(args[0])
    const result = await call(...args)
    if (answers && typeof result === 'string') touched.push(result)
    return result
  }
  return { ...actual, default: actual, stat: record(actual.stat), lstat: record(actual.lstat), realpath: record(actual.realpath, true), readlink: record(actual.readlink), readdir: record(actual.readdir) }
})

const { ThreadFilePages } = await import('../../../src/main/tools/threadFilePages')

let base: string, folder: string, elsewhere: string, pages: InstanceType<typeof ThreadFilePages>
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'sotto-thread-probes-')))
  folder = join(base, 'thread'); elsewhere = join(base, 'elsewhere')
  await mkdir(join(folder, 'docs', 'prototypes'), { recursive: true })
  await mkdir(elsewhere, { recursive: true })
  await writeFile(join(folder, 'docs', 'prototypes', 'page.html'), '<h1>Page</h1>')
  await writeFile(join(elsewhere, 'outside.html'), 'SECRET outside')
  await writeFile(join(elsewhere, 'outside.css'), 'SECRET outside style')
  // Folder links (junctions on Windows, which need no Developer Mode) into the place nothing may touch.
  await symlink(elsewhere, join(folder, 'docs', 'out'), 'junction')
  await symlink(elsewhere, join(folder, 'docs', 'prototypes', 'out'), 'junction')
  pages = new ThreadFilePages()
  touched.length = 0
})
afterEach(async () => {
  pages.dispose()
  await rm(base, { recursive: true, force: true })
})

const reachedElsewhere = (): string[] => touched.filter(value => { const way = relative(elsewhere, value); return way === '' || (!way.startsWith('..') && !/^[A-Za-z]:/u.test(way)) })

it('refuses a page behind a link that leads out of the folder without touching anything there', async () => {
  const opening = await pages.open('docs/out/outside.html', 'thread', folder)
  expect(opening).toMatchObject({ ok: false, message: expect.stringContaining('is outside it') })
  expect(reachedElsewhere()).toEqual([])
})

it('refuses a page\'s file behind such a link without touching anything there', async () => {
  const opening = await pages.open('docs/prototypes/page.html', 'thread', folder)
  if (!opening?.ok) throw new Error(JSON.stringify(opening))
  touched.length = 0
  const response = await fetch(opening.url.replace(/page\.html$/u, 'out/outside.css'))
  expect(response.status).toBe(403)
  expect(await response.text()).not.toContain('SECRET')
  expect(reachedElsewhere()).toEqual([])
})

it('refuses a share or device path before looking at anything, the thread\'s own folder included', async () => {
  for (const written of ['file://server/share/page.html', String.raw`\\server\share\page.html`, '//server/share/page.html', String.raw`\\?\UNC\server\share\page.html`, String.raw`\\.\pipe\page.html`]) {
    touched.length = 0
    expect(await pages.open(written, 'thread', folder), written).toMatchObject({ ok: false, message: expect.stringContaining('is outside it') })
    expect(touched, written).toEqual([])
  }
})
