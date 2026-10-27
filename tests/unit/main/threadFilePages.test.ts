// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ThreadFilePages, type ThreadFileOpening } from '../../../src/main/tools/threadFilePages'

// A thread file page (ADR-0085's October 27, 2026 amendment): an agent opens an HTML file in its thread's folder in Sotto's
// browser, and Sotto serves it read-only on this computer's loopback, by the question page route's rules. Nothing outside
// the folder opens, and each refusal says so in words.

let base: string, folder: string, elsewhere: string, pages: ThreadFilePages

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'sotto-thread-files-')))
  folder = join(base, 'thread')
  elsewhere = join(base, 'elsewhere')
  await mkdir(join(folder, 'docs', 'prototypes', 'assets'), { recursive: true })
  await mkdir(join(folder, '.git'), { recursive: true })
  await mkdir(join(folder, 'docs', 'prototypes', '.git'), { recursive: true })
  await writeFile(join(folder, 'docs', 'prototypes', '.git', 'index.html'), 'SECRET in the page folder\'s git')
  await mkdir(elsewhere, { recursive: true })
  await writeFile(join(folder, 'docs', 'prototypes', 'x-prototype.html'), '<!doctype html><title>Picker</title><link rel="stylesheet" href="assets/look.css"><script src="assets/run.js"></script><img src="assets/logo.png"><h1>Picker</h1>')
  await writeFile(join(folder, 'docs', 'prototypes', 'assets', 'look.css'), 'h1{color:teal}')
  await writeFile(join(folder, 'docs', 'prototypes', 'assets', 'run.js'), 'document.title += "!"')
  await writeFile(join(folder, 'docs', 'prototypes', 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await writeFile(join(folder, 'docs', 'prototypes', 'data.json'), '{"SECRET":1}')
  await writeFile(join(folder, 'docs', 'prototypes', '.env'), 'SECRET=2')
  await writeFile(join(folder, 'docs', 'prototypes', '.hidden.html'), 'SECRET hidden page')
  await writeFile(join(folder, '.git', 'page.html'), 'SECRET in git')
  await writeFile(join(folder, 'docs', 'secret.html'), 'SECRET one folder up')
  await writeFile(join(elsewhere, 'outside.html'), 'SECRET outside')
  await writeFile(join(elsewhere, 'outside.css'), 'SECRET outside style')
  pages = new ThreadFilePages()
})
afterEach(async () => {
  pages.dispose()
  await rm(base, { recursive: true, force: true })
})

const served = (opening: ThreadFileOpening | undefined): string => {
  if (!opening?.ok) throw new Error(`Expected a served page, got ${JSON.stringify(opening)}`)
  return opening.url
}
const refusal = (opening: ThreadFileOpening | undefined): string => {
  if (!opening || opening.ok) throw new Error(`Expected a refusal, got ${JSON.stringify(opening)}`)
  return opening.message
}
const page = join('docs', 'prototypes', 'x-prototype.html')

it('opens a file:// URL inside the thread\'s folder at a loopback address, keeping its query and fragment', async () => {
  const written = `${pathToFileURL(join(folder, page)).href}?variant=A#second`
  const url = new URL(served(await pages.open(written, 'thread', folder)))
  expect(url.protocol).toBe('http:')
  expect(url.hostname).toBe('127.0.0.1')
  expect(url.pathname).toMatch(/^\/page\/[A-Za-z0-9_-]{32}\/x-prototype\.html$/u)
  expect([url.search, url.hash]).toEqual(['?variant=A', '#second'])
  const response = await fetch(url, { redirect: 'manual' })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
  expect(response.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts/u)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.text()).toContain('<h1>Picker</h1>')
})

it('opens the same file by an absolute or a relative path, under the same token', async () => {
  const fromUrl = served(await pages.open(pathToFileURL(join(folder, page)).href, 'thread', folder))
  const absolute = served(await pages.open(join(folder, page), 'thread', folder))
  const relative = served(await pages.open('docs/prototypes/x-prototype.html?variant=B', 'thread', folder))
  expect(absolute).toBe(fromUrl)
  expect(relative).toBe(`${fromUrl}?variant=B`)
})

it('serves the files beside the page that a page is made of', async () => {
  const url = served(await pages.open(page, 'thread', folder))
  const folderUrl = url.slice(0, url.lastIndexOf('/') + 1)
  for (const [name, type] of [['assets/look.css', 'text/css; charset=utf-8'], ['assets/run.js', 'text/javascript; charset=utf-8'], ['assets/logo.png', 'image/png']] as const) {
    const response = await fetch(folderUrl + name, { redirect: 'manual' })
    expect([name, response.status, response.headers.get('content-type')]).toEqual([name, 200, type])
  }
})

it('refuses traversal, hidden files, .git, JSON and a link that leads out of the folder', async () => {
  const url = served(await pages.open(page, 'thread', folder))
  const folderUrl = url.slice(0, url.lastIndexOf('/') + 1)
  // A folder link (a junction on Windows, which needs no Developer Mode) and, where the system allows it, a file link.
  expect(await symlink(elsewhere, join(folder, 'docs', 'prototypes', 'out'), 'junction').then(() => true, () => false)).toBe(true)
  const linked = await symlink(join(elsewhere, 'outside.css'), join(folder, 'docs', 'prototypes', 'assets', 'linked.css')).then(() => true, () => false)
  const paths = ['..%2Fsecret.html', 'assets%2F..%2F..%2Fsecret.html', 'assets/..%5C..%5Csecret.html', '.env', '.hidden.html', '.git/index.html', '..%2F..%2F.git%2Fpage.html', 'data.json', 'out/outside.css', ...linked ? ['assets/linked.css'] : []]
  for (const path of paths) {
    const response = await fetch(folderUrl + path, { redirect: 'manual' })
    expect(response.status, path).toBe(403)
    expect(await response.text(), path).not.toContain('SECRET')
  }
  expect((await fetch(url, { method: 'POST' })).status).toBe(405)
})

it('refuses a file outside the thread\'s folder in plain words, and looks at nothing there', async () => {
  for (const written of [join(elsewhere, 'outside.html'), pathToFileURL(join(elsewhere, 'outside.html')).href, '../elsewhere/outside.html', ...process.platform === 'win32' ? ['\\\\server\\share\\page.html'] : []]) {
    expect(refusal(await pages.open(written, 'thread', folder)), written).toMatch(/^Only HTML files inside this thread's folder can open in Sotto's browser\. .+ is outside it\. Nothing was opened\./u)
  }
})

it('refuses a file that is not HTML, one that is not there, a hidden one and one in .git', async () => {
  expect(refusal(await pages.open('docs/prototypes/data.json', 'thread', folder))).toContain('is not one, or leads to one that is not. Nothing was opened.')
  expect(refusal(await pages.open('docs/prototypes/assets/look.css', 'thread', folder))).toContain('Only HTML files can open')
  expect(refusal(await pages.open('docs/prototypes/missing.html', 'thread', folder))).toContain('is not in this thread\'s folder, so nothing was opened')
  expect(refusal(await pages.open('docs/prototypes/.hidden.html', 'thread', folder))).toContain('does not open a file in a hidden folder or in .git')
  expect(refusal(await pages.open('.git/page.html', 'thread', folder))).toContain('does not open a file in a hidden folder or in .git')
})

it('judges a linked page by where it leads, so a page that leads out of the folder does not open', async () => {
  expect(await symlink(elsewhere, join(folder, 'docs', 'out'), 'junction').then(() => true, () => false)).toBe(true)
  expect(refusal(await pages.open('docs/out/outside.html', 'thread', folder))).toContain('is outside it')
  if (!await symlink(join(elsewhere, 'outside.html'), join(folder, 'docs', 'linked.html')).then(() => true, () => false)) return
  expect(refusal(await pages.open('docs/linked.html', 'thread', folder))).toContain('is outside it')
})

it('leaves an address that names no file to the caller', async () => {
  for (const written of ['ftp://example.com/page.html', 'javascript:alert(1)', 'localhost:3000']) expect(await pages.open(written, 'thread', folder), written).toBeUndefined()
})

it('closes a thread\'s pages when the thread has gone, and says so in words', async () => {
  const url = served(await pages.open(page, 'thread', folder))
  pages.forget('thread')
  const response = await fetch(url, { redirect: 'manual' })
  expect(response.status).toBe(404)
  const body = await response.text()
  expect(body).toContain('This page has closed')
  expect(body).toContain('Ask the agent to open the page again.')
  expect(body).not.toContain('question')
})

it('refuses a page in a hidden folder, which would otherwise become the folder it serves (review finding)', async () => {
  await mkdir(join(folder, '.private'), { recursive: true })
  await writeFile(join(folder, '.private', 'page.html'), 'SECRET private page')
  await mkdir(join(folder, 'docs', '.drafts', 'inner'), { recursive: true })
  await writeFile(join(folder, 'docs', '.drafts', 'inner', 'page.html'), 'SECRET draft page')
  for (const written of ['.private/page.html', join(folder, '.private', 'page.html'), pathToFileURL(join(folder, 'docs', '.drafts', 'inner', 'page.html')).href]) {
    expect(refusal(await pages.open(written, 'thread', folder)), written).toContain('does not open a file in a hidden folder or in .git')
  }
})

it('answers at most its budget of page requests a minute, all pages together, and says so in words (review finding)', async () => {
  pages.dispose()
  pages = new ThreadFilePages({ pageBudget: 3 })
  const url = served(await pages.open(page, 'thread', folder))
  const folderUrl = url.slice(0, url.lastIndexOf('/') + 1)
  for (const path of ['x-prototype.html', 'assets/look.css', 'assets/run.js']) expect((await fetch(folderUrl + path)).status, path).toBe(200)
  const refused = await fetch(folderUrl + 'assets/logo.png')
  expect(refused.status).toBe(429)
  expect(await refused.text()).toContain('Wait a minute, then reload the page.')
})

it('says what to do next when the thread\'s folder is not there (review finding)', async () => {
  const message = refusal(await pages.open(page, 'thread', join(base, 'gone')))
  expect(message).toContain('Nothing was opened. Check that the thread\'s folder is still there, then open the file again')
})
