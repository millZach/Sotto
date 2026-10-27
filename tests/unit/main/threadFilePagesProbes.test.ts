// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// A link inside a thread's folder that leads somewhere else must be judged by its own words, before anything it leads to
// is touched: if it led to a network share, looking would reach the share (review finding on ADR-0085's October 27
// amendment). Every path the file system is asked about, and every path `realpath` answers with, is recorded here.
const touched = vi.hoisted(() => [] as string[])
// `aliases` stands in for a file system that spells a path one way and keeps it another (a Windows 8.3 short name), and
// `beforeOpen` runs just before a file is opened, to change the folder between the walk and the open.
const stubs = vi.hoisted(() => ({ aliases: new Map<string, string>(), beforeOpen: undefined as (() => Promise<void>) | undefined, opened: [] as string[] }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  // What realpath answers is where the system went to find it; what readlink answers is only the link's own words.
  const record = <A extends unknown[], R>(call: (...args: A) => Promise<R>, answers = false) => async (...args: A): Promise<R> => {
    if (typeof args[0] === 'string') touched.push(args[0])
    const result = await call(...args)
    if (answers && typeof result === 'string') touched.push(result)
    return result
  }
  const realpath = async (target: string): Promise<string> => stubs.aliases.get(target) ?? actual.realpath(target)
  const open = async (...args: Parameters<typeof actual.open>) => {
    if (typeof args[0] === 'string') stubs.opened.push(args[0])
    const hook = stubs.beforeOpen; stubs.beforeOpen = undefined
    await hook?.()
    return actual.open(...args)
  }
  return { ...actual, default: actual, stat: record(actual.stat), lstat: record(actual.lstat), realpath: record(realpath, true), readlink: record(actual.readlink), readdir: record(actual.readdir), open: record(open) }
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
  stubs.opened.length = 0
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

it('judges hidden folders by the file system\'s own spelling of the path, not the one asked for (review finding)', async () => {
  // As a short name would: `docs/alias/` is what the agent wrote, `docs/.hidden/` is where the file system keeps it.
  await mkdir(join(folder, 'docs', 'alias'), { recursive: true })
  await mkdir(join(folder, 'docs', '.hidden'), { recursive: true })
  await writeFile(join(folder, 'docs', 'alias', 'page.html'), 'SECRET page')
  await writeFile(join(folder, 'docs', '.hidden', 'page.html'), 'SECRET page')
  stubs.aliases.set(join(folder, 'docs', 'alias', 'page.html'), join(folder, 'docs', '.hidden', 'page.html'))
  try {
    expect(await pages.open('docs/alias/page.html', 'thread', folder)).toMatchObject({ ok: false, message: expect.stringContaining('does not open a file in a hidden folder or in .git') })
  } finally { stubs.aliases.clear() }
})

it('walks a page\'s folder again before looking at it, so a folder swapped for a link out is not touched (review finding)', async () => {
  const opening = await pages.open('docs/prototypes/page.html', 'thread', folder)
  if (!opening?.ok) throw new Error(JSON.stringify(opening))
  // The page's folder is replaced by a link to somewhere else, which holds a page of the same name.
  await writeFile(join(elsewhere, 'page.html'), 'SECRET swapped page')
  await rm(join(folder, 'docs', 'prototypes'), { recursive: true, force: true })
  await symlink(elsewhere, join(folder, 'docs', 'prototypes'), 'junction')
  touched.length = 0
  const response = await fetch(opening.url)
  expect(response.status).toBe(404)
  expect(await response.text()).not.toContain('SECRET')
  expect(reachedElsewhere()).toEqual([])
})

it('serves only the file the walk found, when another takes its place before it is opened (review finding)', async () => {
  const opening = await pages.open('docs/prototypes/page.html', 'thread', folder)
  if (!opening?.ok) throw new Error(JSON.stringify(opening))
  const page = join(folder, 'docs', 'prototypes', 'page.html')
  stubs.beforeOpen = async () => { await rm(page); await writeFile(page, 'SECRET swapped in') }
  const response = await fetch(opening.url)
  expect(response.status).toBe(404)
  expect(await response.text()).not.toContain('SECRET')
})

it('checks the thread\'s folder itself before reading a page directly in it, so a junction put in its place is not followed (review finding)', async () => {
  await writeFile(join(folder, 'top.html'), '<h1>Top</h1>')
  const opening = await pages.open('top.html', 'thread', folder)
  if (!opening?.ok) throw new Error(JSON.stringify(opening))
  expect((await fetch(opening.url)).status).toBe(200)
  // The thread's folder itself is moved away and a junction to an outside folder, with a page of the same name, stands in its place.
  await writeFile(join(elsewhere, 'top.html'), 'SECRET outside top')
  await rename(folder, join(base, 'moved'))
  await symlink(elsewhere, folder, 'junction')
  touched.length = 0
  const response = await fetch(opening.url)
  expect(response.status).toBe(404)
  expect(await response.text()).not.toContain('SECRET')
  expect(reachedElsewhere()).toEqual([])
})

it('serves nothing from a new folder made where the thread\'s folder was (review finding)', async () => {
  await writeFile(join(folder, 'top.html'), '<h1>Top</h1>')
  const opening = await pages.open('top.html', 'thread', folder)
  if (!opening?.ok) throw new Error(JSON.stringify(opening))
  await rename(folder, join(base, 'moved'))
  await mkdir(folder)
  await writeFile(join(folder, 'top.html'), 'SECRET new folder')
  const response = await fetch(opening.url)
  expect(response.status).toBe(404)
  expect(await response.text()).not.toContain('SECRET')
})

it('never opens an entry that is not a plain file, such as a folder named look.css (review finding)', async () => {
  await mkdir(join(folder, 'docs', 'prototypes', 'look.css'))
  const opening = await pages.open('docs/prototypes/page.html', 'thread', folder)
  if (!opening?.ok) throw new Error(JSON.stringify(opening))
  const response = await fetch(opening.url.replace(/page\.html$/u, 'look.css'))
  expect(response.status).toBe(404)
  expect(stubs.opened.filter(opened => opened.endsWith('look.css'))).toEqual([])
})

it('answers at once for a pipe named look.css, which an open would wait on for a writer (review finding)', async ctx => {
  // Windows has no named pipes in the file system (its pipes live under \\.\pipe\, which is refused as a device path).
  if (process.platform === 'win32') { ctx.skip(); return }
  const fifo = join(folder, 'docs', 'prototypes', 'look.css')
  execFileSync('mkfifo', [fifo])
  const opening = await pages.open('docs/prototypes/page.html', 'thread', folder)
  if (!opening?.ok) throw new Error(JSON.stringify(opening))
  try {
    const response = await fetch(opening.url.replace(/page\.html$/u, 'look.css'), { signal: AbortSignal.timeout(5_000) })
    expect(response.status).toBe(404)
  } finally {
    // Were an open waiting on the pipe, a writer lets it go, so a failure here does not hold a worker for the rest of the run.
    await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK).then(handle => handle.close(), () => undefined)
  }
})
