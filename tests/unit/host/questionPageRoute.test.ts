// @vitest-environment node
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { QuestionPageTarget } from '../../../src/main/agents/questionPages'
import { serveQuestionPage } from '../../../src/host/questionPageRoute'

// A question page's route (ADR-0085): its token opens one HTML file's folder read-only, or passes reads on to the
// loopback page an agent serves, and says in plain words when the page is gone.

const FILE = 'f'.repeat(32), SERVER = 's'.repeat(32), SELF = 'o'.repeat(32), STOPPED = 'x'.repeat(32)
let folder: string, listener: Server, upstream: Server, base: string
const targets = new Map<string, QuestionPageTarget>()
const opened: string[] = []

const listen = (server: Server): Promise<number> => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
const closed = (server: Server): Promise<void> => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) })

beforeEach(async () => {
  // The host keeps a page's folder as it is after links are followed, so the test does too.
  folder = await realpath(await mkdtemp(join(tmpdir(), 'sotto-page-route-')))
  await mkdir(join(folder, 'page', 'assets'), { recursive: true })
  await writeFile(join(folder, 'page', 'greeting.html'), '<link rel="stylesheet" href="assets/look.css"><h1>Greeting</h1>')
  await writeFile(join(folder, 'page', 'assets', 'look.css'), 'h1{color:teal}')
  await writeFile(join(folder, 'page', '.env'), 'SECRET=1')
  await mkdir(join(folder, 'page', '.private'), { recursive: true })
  await writeFile(join(folder, 'page', '.private', 'secret.json'), '{"SECRET":2}')
  await writeFile(join(folder, 'page', 'notes.ts'), 'export {}')
  await mkdir(join(folder, 'page', 'config'), { recursive: true })
  await writeFile(join(folder, 'page', 'config', 'secrets.json'), '{"SECRET":3}')
  await writeFile(join(folder, 'page', 'notes.txt'), 'SECRET notes')
  await writeFile(join(folder, 'secret.html'), 'outside')
  upstream = createServer((request, response) => {
    if (request.url === '/moved') { response.writeHead(302, { Location: '/variants/b.html', 'Set-Cookie': 'id=1' }); response.end(); return }
    if (request.url === '/containers/json') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('[{"Id":"SECRET"}]'); return }
    response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'id=1' })
    response.end(`served ${request.url} cookie=${request.headers.cookie ?? 'none'}`)
  })
  const upstreamPort = await listen(upstream)
  listener = createServer((request, response) => { void serveQuestionPage(request, response, { target: token => targets.get(token), ownPort: () => (listener.address() as AddressInfo).port, opened: token => opened.push(token) }) })
  const port = await listen(listener)
  base = `http://127.0.0.1:${port}`
  targets.set(FILE, { kind: 'file', root: join(folder, 'page'), file: join(folder, 'page', 'greeting.html') })
  targets.set(SERVER, { kind: 'server', origin: `http://localhost:${upstreamPort}` })
  targets.set(SELF, { kind: 'server', origin: `http://127.0.0.1:${port}` })
  // A port nothing listens on: taken, then let go.
  const spare = createServer()
  const free = await listen(spare)
  await closed(spare)
  targets.set(STOPPED, { kind: 'server', origin: `http://127.0.0.1:${free}` })
})
afterEach(async () => {
  targets.clear()
  opened.length = 0
  await Promise.all([closed(listener), closed(upstream)])
  await rm(folder, { recursive: true, force: true })
})

const get = (path: string, init?: RequestInit) => fetch(`${base}${path}`, { redirect: 'manual', ...init })

it('serves the page and the files it is made of from its folder, sandboxed and never cached', async () => {
  const page = await get(`/page/${FILE}/greeting.html`)
  expect(page.status).toBe(200)
  expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
  expect(page.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts/u)
  expect(page.headers.get('cache-control')).toBe('no-store')
  expect(await page.text()).toContain('<h1>Greeting</h1>')
  const style = await get(`/page/${FILE}/assets/look.css`)
  expect([style.status, await style.text()]).toEqual([200, 'h1{color:teal}'])
})

it('says a page was opened when a GET of it is served, and not for a HEAD, a refusal or a page that has gone (ADR-0108)', async () => {
  await (await get(`/page/${FILE}/greeting.html`, { method: 'HEAD' })).arrayBuffer()
  await (await get(`/page/${FILE}/.env`)).arrayBuffer()
  await (await get(`/page/${STOPPED}/`)).arrayBuffer()
  await (await get(`/page/${'n'.repeat(32)}/`)).arrayBuffer()
  expect(opened).toEqual([])
  await (await get(`/page/${FILE}/greeting.html`)).arrayBuffer()
  await (await get(`/page/${SERVER}/variants/a.html`)).arrayBuffer()
  expect(opened).toEqual([FILE, SERVER])
})

it('sends the token alone to the page, and the bare token to its folder', async () => {
  expect((await get(`/page/${FILE}`)).headers.get('location')).toBe(`/page/${FILE}/`)
  expect((await get(`/page/${FILE}/`)).headers.get('location')).toBe(`/page/${FILE}/greeting.html`)
})

it('refuses hidden files, files a page is not made of, and anything outside the folder', async () => {
  for (const path of ['.env', 'notes.ts', 'config/secrets.json', 'notes.txt', '..%2Fsecret.html', 'assets/..%5C..%5Csecret.html', 'assets%2f..%2f.private%2fsecret.json', 'assets%2F..%2F..%2Fsecret.html']) {
    const response = await get(`/page/${FILE}/${path}`)
    expect(response.status, path).toBe(403)
    expect(await response.text()).not.toContain('SECRET')
  }
  // A client resolves dot segments before it asks, so these never name the page's route at all.
  for (const path of ['../secret.html', '%2E%2E/secret.html']) {
    const response = await get(`/page/${FILE}/${path}`)
    expect(response.status, path).not.toBe(200)
    expect(await response.text()).not.toContain('outside')
  }
  expect((await get(`/page/${FILE}/greeting.html`, { method: 'POST' })).status).toBe(405)
})

it('says the page has closed for a token nobody holds, and the file is gone when it is', async () => {
  const closedPage = await get(`/page/${'n'.repeat(32)}/greeting.html`)
  expect([closedPage.status, await closedPage.text()]).toEqual([404, expect.stringContaining('This page has closed')])
  await rm(join(folder, 'page', 'greeting.html'))
  const gone = await get(`/page/${FILE}/greeting.html`)
  expect([gone.status, await gone.text()]).toEqual([404, expect.stringContaining('The prototype file was moved or deleted')])
})

it('passes reads to the agent’s loopback page, keeps its redirects on the route and its cookies off the phone', async () => {
  const page = await get(`/page/${SERVER}/variants/a.html?variant=A`, { headers: { Cookie: 'host=private' } })
  expect(page.status).toBe(200)
  expect(page.headers.get('set-cookie')).toBeNull()
  expect(page.headers.get('content-security-policy')).toMatch(/^sandbox/u)
  expect(await page.text()).toBe('served /variants/a.html?variant=A cookie=none')
  expect((await get(`/page/${SERVER}/moved`)).headers.get('location')).toBe(`/page/${SERVER}/variants/b.html`)
})

it('passes on only what a page is drawn from, so naming a service’s port does not put the service on the tailnet', async () => {
  const api = await get(`/page/${SERVER}/containers/json`)
  expect(api.status).toBe(403)
  expect(await api.text()).not.toContain('SECRET')
})

it('says the page’s server has stopped, and never passes a page on to the listener itself', async () => {
  for (const token of [STOPPED, SELF]) {
    const response = await get(`/page/${token}/`)
    expect(response.status, token).toBe(502)
    expect(await response.text()).toContain('The page’s server has stopped')
  }
})

it('serves nothing once the page’s folder has become a link to somewhere else', async () => {
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'sotto-page-route-outside-')))
  try {
    await writeFile(join(outside, 'greeting.html'), 'outside')
    await rename(join(folder, 'page'), join(folder, 'moved'))
    if (!await symlink(outside, join(folder, 'page'), 'junction').then(() => true, () => false)) return
    const response = await get(`/page/${FILE}/greeting.html`)
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('outside')
  } finally { await rm(outside, { recursive: true, force: true }) }
})

it('judges a linked file by what it leads to, so a page’s style that leads to .env is refused', async () => {
  if (!await symlink(join(folder, 'page', '.env'), join(folder, 'page', 'assets', 'linked.css')).then(() => true, () => false)) return
  const response = await get(`/page/${FILE}/assets/linked.css`)
  expect(response.status).toBe(403)
  expect(await response.text()).not.toContain('SECRET')
})
