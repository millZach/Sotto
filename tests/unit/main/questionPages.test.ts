// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { foundPages, pageAnswers, pageMentions, QUESTION_PAGE_LINGER_MS, QuestionPages } from '../../../src/main/agents/questionPages'
import type { AgentHostSnapshot, AgentMessage, AgentRequest, AgentThread } from '../../../src/shared/agents'

// A question's pages (ADR-0085): Sotto finds them in the question and the agent's message before it, whatever the
// provider wrote, so a prototype opens on the computer and the phone without the agent doing anything.

let folder: string
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'sotto-question-pages-'))
  await mkdir(join(folder, 'docs', 'prototypes'), { recursive: true })
  await writeFile(join(folder, 'docs', 'prototypes', 'greeting-prototype.html'), '<h1>Greeting</h1>')
})
afterEach(async () => { await rm(folder, { recursive: true, force: true }) })

const mentioned = (text: string) => pageMentions([text]).map(item => item.kind === 'file' ? `file ${item.path}` : `server ${item.url.href}`)

describe('pageMentions', () => {
  it('reads loopback addresses, file links and HTML paths the way agents write them', () => {
    expect(mentioned('Review page: http://localhost:8075/ (it’s open in your browser)')).toEqual(['server http://localhost:8075/'])
    expect(mentioned('Open **http://localhost:8072/** to compare.')).toEqual(['server http://localhost:8072/'])
    expect(mentioned('See http://127.0.0.1:8077/terminal.prototype.html?variant=A.')).toEqual(['server http://127.0.0.1:8077/terminal.prototype.html?variant=A'])
    expect(mentioned('On IPv6 at http://[::1]:8075/ too')).toEqual(['server http://[::1]:8075/'])
    expect(mentioned('[the page](http://localhost:8075/)')).toEqual(['server http://localhost:8075/'])
    expect(mentioned('The page is at docs/prototypes/greeting-prototype.html.')).toEqual(['file docs/prototypes/greeting-prototype.html'])
    expect(mentioned('I wrote `D:\\Talk to Text Application\\docs\\x.html` for you')).toEqual(['file D:\\Talk to Text Application\\docs\\x.html'])
    expect(mentioned('[the mock](docs/prototypes/greeting-prototype.html)')).toEqual(['file docs/prototypes/greeting-prototype.html'])
  })

  it('reads a file link whatever it escapes', () => {
    const file = join(folder, 'with space', 'page.html')
    expect(mentioned(`Open ${pathToFileURL(file).href} please`)).toEqual([`file ${file}`])
  })

  it('leaves out web pages elsewhere, files that are not pages and addresses with a sign-in', () => {
    expect(mentioned('https://github.com/millZach/Sotto/pull/1020 and https://example.com/page.html')).toEqual([])
    expect(mentioned('Edit src/renderer/index.tsx and README.md')).toEqual([])
    expect(mentioned('http://user:secret@localhost:8075/')).toEqual([])
    expect(mentioned('mailto:someone.html')).toEqual([])
  })

  it('names each page once, in the order written', () => {
    expect(mentioned('docs/a.html then http://localhost:1/ then docs/a.html and http://localhost:1/')).toEqual(['file docs/a.html', 'server http://localhost:1/'])
  })
})

describe('foundPages', () => {
  it('finds a file by its path, its file link or its name alone, inside the thread’s folder', async () => {
    const file = join(folder, 'docs', 'prototypes', 'greeting-prototype.html')
    for (const text of ['docs/prototypes/greeting-prototype.html', pathToFileURL(file).href, 'greeting-prototype.html', 'Application\\docs\\prototypes\\greeting-prototype.html']) {
      const pages = await foundPages(pageMentions([text]), folder)
      expect(pages.map(item => item.page), text).toEqual([{ kind: 'file', name: 'greeting-prototype.html', start: 'greeting-prototype.html' }])
      expect(pages[0]!.target).toEqual({ kind: 'file', root: expect.stringContaining('prototypes'), file: expect.stringContaining('greeting-prototype.html'), folder: expect.any(String), hidden: 'git-only' })
    }
  })

  it('never opens a network share named in the text, and takes no file here for a path elsewhere that only shares its name', async () => {
    const pages = await foundPages(pageMentions(['\\\\fileserver.invalid\\share\\greeting-prototype.html','//fileserver.invalid/share/greeting-prototype.html']), folder)
    expect(pages).toEqual([])
    await writeFile(join(folder, 'index.html'), 'x')
    expect(await foundPages(pageMentions(['/elsewhere/checkout/index.html']), folder)).toEqual([])
  })

  it('offers nothing outside the thread’s folder, inside .git, or that is not there', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'sotto-question-pages-outside-'))
    try {
      await writeFile(join(outside, 'secret.html'), 'x')
      await mkdir(join(folder, '.git'), { recursive: true })
      await writeFile(join(folder, '.git', 'hook.html'), 'x')
      const linked = await symlink(join(outside, 'secret.html'), join(folder, 'linked.html')).then(() => true, () => false)
      const texts = [join(outside, 'secret.html'), '../secret.html', '.git/hook.html', 'missing.html', ...(linked ? ['linked.html'] : [])]
      expect(await foundPages(pageMentions(texts), folder)).toEqual([])
    } finally { await rm(outside, { recursive: true, force: true }) }
  })

  it('keeps a loopback page’s fragment, so each variant named by one opens at itself', async () => {
    const pages = await foundPages(pageMentions(['http://localhost:8075/#/a and http://localhost:8075/#/b']), undefined)
    expect(pages.map(item => item.page.start)).toEqual(['#/a', '#/b'])
  })

  it('takes a loopback page as its address and start, and needs no folder for it', async () => {
    const pages = await foundPages(pageMentions(['http://localhost:8075/variants/index.html?variant=B']), undefined)
    expect(pages).toEqual([{ page: { kind: 'server', name: 'localhost:8075', start: 'variants/index.html?variant=B' }, target: { kind: 'server', origin: 'http://localhost:8075' } }])
  })

  it('leaves a name it finds in two places alone unless the path picks one', async () => {
    await mkdir(join(folder, 'other'), { recursive: true })
    await writeFile(join(folder, 'other', 'greeting-prototype.html'), 'x')
    expect(await foundPages(pageMentions(['greeting-prototype.html']), folder)).toEqual([])
    expect((await foundPages(pageMentions(['Somewhere/other/greeting-prototype.html']), folder)).map(item => item.target.kind === 'file' && item.target.file))
      .toEqual([expect.stringMatching(/other[\\/]greeting-prototype\.html$/u)])
  })
})

const question = (id: string, text: string): AgentRequest => ({ id, kind: 'question', text, options: [] })
const reply = (text: string): AgentMessage => ({ id: `m-${text.length}`, role: 'assistant', text, createdAt: '2026-10-14T00:00:00.000Z' })
function snapshot(requests: AgentRequest[], messages: AgentMessage[] = []): AgentHostSnapshot {
  const thread: AgentThread = { id: 'thread', title: 'Greeting', projectId: 'project', modelId: 'm', status: 'idle', workingDirectory: folder, messages, requests }
  return { connected: true, name: 'Fixture', version: '1', capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true },
    models: [], projects: [], threads: [thread] } as AgentHostSnapshot
}

describe('QuestionPages', () => {
  it('puts the pages from the question and the reply before it on the question, and serves each by its token', async () => {
    const changed = vi.fn()
    let next = 0
    const pages = new QuestionPages({ changed, token: () => `${'t'.repeat(31)}${next++}` })
    const first = snapshot([question('q', 'Which greeting?')], [reply('The page is at docs/prototypes/greeting-prototype.html and http://localhost:8075/.')])
    expect(pages.decorate(first)).toBe(first)
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    const shown = pages.decorate(first)
    expect(shown.threads[0]!.requests[0]!.pages).toEqual([
      { token: `${'t'.repeat(31)}0`, kind: 'file', name: 'greeting-prototype.html', start: 'greeting-prototype.html' },
      { token: `${'t'.repeat(31)}1`, kind: 'server', name: 'localhost:8075', start: '' },
    ])
    expect(pages.target(`${'t'.repeat(31)}1`)).toEqual({ kind: 'server', origin: 'http://localhost:8075' })
    // Decorating again changes nothing.
    expect(pages.decorate(shown)).toBe(shown)
  })

  it('keeps the pages it found when the agent writes on after asking, and gives a permission none', async () => {
    const changed = vi.fn()
    const pages = new QuestionPages({ changed })
    pages.decorate(snapshot([question('q', 'Pick one'), { id: 'p', kind: 'permission', text: 'Run docs/prototypes/greeting-prototype.html?', options: [] }],
      [reply('docs/prototypes/greeting-prototype.html')]))
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    const later = pages.decorate(snapshot([question('q', 'Pick one'), { id: 'p', kind: 'permission', text: 'Run docs/prototypes/greeting-prototype.html?', options: [] }],
      [reply('docs/prototypes/greeting-prototype.html'), reply('Meanwhile I also looked at nothing.')]))
    expect(later.threads[0]!.requests[0]!.pages).toHaveLength(1)
    expect(later.threads[0]!.requests[1]!.pages).toBeUndefined()
  })

  it('reads the stored reply when the snapshot carries no messages, and drops pages a provider put on a request', async () => {
    const changed = vi.fn()
    const pages = new QuestionPages({ changed, messages: () => [reply('See greeting-prototype.html')] })
    const forged = { ...question('q', 'Pick'), pages: [{ token: 'x'.repeat(32), kind: 'file' as const, name: 'forged.html', start: '' }] }
    expect(pages.decorate(snapshot([forged])).threads[0]!.requests[0]!.pages).toBeUndefined()
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    expect(pages.decorate(snapshot([forged])).threads[0]!.requests[0]!.pages?.map(page => page.name)).toEqual(['greeting-prototype.html'])
  })

  it('looks again when the reply naming a page reaches the store after the question, and stops after three searches', async () => {
    let now = 0, stored: AgentMessage[] = []
    const changed = vi.fn()
    const pages = new QuestionPages({ changed, now: () => now, messages: () => stored })
    pages.decorate(snapshot([question('q', 'Which greeting?')]))
    // The first search reads no reply, finds nothing and settles.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(pages.decorate(snapshot([question('q', 'Which greeting?')])).threads[0]!.requests[0]!.pages).toBeUndefined()
    stored = [reply('The page is at docs/prototypes/greeting-prototype.html')]
    // Too soon: no second search yet.
    now = 1_000
    pages.decorate(snapshot([question('q', 'Which greeting?')]))
    now = 2_000
    pages.decorate(snapshot([question('q', 'Which greeting?')]))
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    expect(pages.decorate(snapshot([question('q', 'Which greeting?')])).threads[0]!.requests[0]!.pages?.map(page => page.name)).toEqual(['greeting-prototype.html'])
    // A question that never names one is searched three times in all.
    const searches = vi.fn(() => [] as AgentMessage[])
    const noneChanged = vi.fn()
    const none = new QuestionPages({ changed: noneChanged, now: () => now, messages: searches })
    for (let step = 0; step < 6; step++) { none.decorate(snapshot([question('n', 'Nothing here')])); await new Promise(resolve => setTimeout(resolve, 20)); now += 2_000 }
    expect(searches).toHaveBeenCalledTimes(3)
    // The last search that finds none is news too: a prototype question held for it (ADR-0108) waits on nothing else.
    expect(none.searched('thread', 'request:n')?.finished).toBe(true)
    expect(noneChanged).toHaveBeenCalledTimes(1)
  })

  it('serves a page for an hour after its question leaves, and not after', async () => {
    let now = 0
    const changed = vi.fn()
    const pages = new QuestionPages({ changed, now: () => now })
    pages.decorate(snapshot([question('q', 'docs/prototypes/greeting-prototype.html')]))
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    const token = pages.decorate(snapshot([question('q', 'docs/prototypes/greeting-prototype.html')])).threads[0]!.requests[0]!.pages![0]!.token
    pages.decorate(snapshot([]))
    now = QUESTION_PAGE_LINGER_MS - 1
    expect(pages.target(token)).toBeDefined()
    now = QUESTION_PAGE_LINGER_MS
    expect(pages.target(token)).toBeUndefined()
  })
})

// A working page (ADR-0108): one that opens. A file found in the folder works; a loopback address works when it answers
// one GET with a status below 400 within a moment. A dead loopback page is still offered on a question.
describe('pageAnswers', () => {
  const servers: Server[] = []
  afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))) })
  async function serve(handler: RequestListener): Promise<string> {
    const server = createServer(handler)
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  it('says a page works when it answers below 400, a redirect included, and not when it fails, refuses or hangs', async () => {
    const seen: string[] = []
    const origin = await serve((request, response) => {
      seen.push(`${request.method} ${request.url}`)
      if (request.url === '/missing') { response.writeHead(404); response.end(); return }
      if (request.url === '/moved') { response.writeHead(302, { Location: '/elsewhere' }); response.end(); return }
      if (request.url === '/slow') return
      response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<h1>ok</h1>')
    })
    expect(await pageAnswers(`${origin}/page.html?variant=A#b`)).toBe(true)
    expect(await pageAnswers(`${origin}/moved`)).toBe(true)
    expect(await pageAnswers(`${origin}/missing`)).toBe(false)
    expect(await pageAnswers(`${origin}/slow`, 100)).toBe(false)
    // The redirect is not followed: one GET for each page.
    expect(seen).toEqual(['GET /page.html?variant=A', 'GET /moved', 'GET /missing', 'GET /slow'])
    const spare = await serve(() => undefined)
    const closing = servers.pop()!
    await new Promise<void>(resolve => closing.close(() => resolve()))
    expect(await pageAnswers(spare)).toBe(false)
  })
})

describe('QuestionPages working pages and reply pages (ADR-0108)', () => {
  const tokens = (): (() => string) => { let next = 0; return () => `${'w'.repeat(30)}${String(next++).padStart(2, '0')}` }
  const words = 'The prototype is at docs/prototypes/greeting-prototype.html, served at http://localhost:8075/ too.'

  it('keeps offering a dead loopback page on a question, and says which of its pages work', async () => {
    const changed = vi.fn(), live = vi.fn(async (url: string) => url !== 'http://localhost:8075/')
    const pages = new QuestionPages({ changed, token: tokens(), live })
    const first = snapshot([question('q', 'Which greeting?')], [reply(words)])
    pages.decorate(first)
    expect(pages.searched('thread', 'request:q')).toEqual({ finished: false, pages: [], working: [], aboutPrototype: false })
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    expect(pages.decorate(first).threads[0]!.requests[0]!.pages?.map(page => page.kind)).toEqual(['file', 'server'])
    const search = pages.searched('thread', 'request:q')!
    expect(search.finished).toBe(true)
    expect(search.working.map(page => page.kind)).toEqual(['file'])
    expect(search.working[0]!.token).toBe(search.pages[0]!.token)
    expect(live).toHaveBeenCalledWith('http://localhost:8075/')
    expect(pages.source(search.pages[1]!.token)).toEqual({ threadId: 'thread', source: 'request:q' })
  })

  it('says a question’s search is not finished while it may look again, and finished after its last look', async () => {
    // Each search that finds nothing says so: by the timer that brings the next look, on Vitest's clock here, or at once
    // after the last. That word is the sign the search has ended.
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      let now = 0
      const changed = vi.fn()
      const pages = new QuestionPages({ changed, now: () => now, live: async () => true })
      for (let step = 0; step < 3; step++) {
        pages.decorate(snapshot([question('n', 'Nothing here')]))
        await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(2_000); expect(changed).toHaveBeenCalledTimes(step + 1) })
        expect(pages.searched('thread', 'request:n')?.finished, `search ${step + 1}`).toBe(step === 2)
        now += 2_000
      }
    } finally { vi.useRealTimers() }
  })

  it('looks once for the pages a reply names when asked to, and serves them by their tokens', async () => {
    const changed = vi.fn()
    const pages = new QuestionPages({ changed, token: tokens(), live: async () => false })
    const shown = snapshot([], [reply(words)])
    const replyOf = vi.fn(() => ({ id: 'm-1', text: words }))
    expect(pages.decorate(shown, replyOf)).toBe(shown)
    expect(replyOf).toHaveBeenCalledWith(shown.threads[0])
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    const search = pages.searched('thread', 'reply:m-1')!
    expect(search).toMatchObject({ finished: true })
    expect(search.pages.map(page => page.kind)).toEqual(['file', 'server'])
    expect(search.working.map(page => page.name)).toEqual(['greeting-prototype.html'])
    expect(pages.target(search.working[0]!.token)).toMatchObject({ kind: 'file' })
    expect(pages.source(search.working[0]!.token)).toEqual({ threadId: 'thread', source: 'reply:m-1' })
    // The reply is searched once, however often the snapshot comes, and a reply puts nothing on the thread's requests.
    expect(pages.decorate(shown, replyOf)).toBe(shown)
    pages.decorate(shown, replyOf)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('reads a reply the snapshot carries only a summary of from the summary, or from the store when the summary is cut', async () => {
    const stored = vi.fn(() => [{ ...reply(words), id: 'long' }])
    const pages = new QuestionPages({ changed: vi.fn(), live: async () => true, messages: stored })
    pages.decorate(snapshot([]), () => ({ id: 'short', summary: words }))
    await vi.waitFor(() => expect(pages.searched('thread', 'reply:short')?.finished).toBe(true))
    expect(pages.searched('thread', 'reply:short')!.working).toHaveLength(2)
    expect(stored).not.toHaveBeenCalled()
    pages.decorate(snapshot([]), () => ({ id: 'long', summary: 'x'.repeat(2_000) }))
    await vi.waitFor(() => expect(pages.searched('thread', 'reply:long')?.finished).toBe(true))
    expect(stored).toHaveBeenCalledWith('thread')
    expect(pages.searched('thread', 'reply:long')!.working).toHaveLength(2)
  })

  it('says whether the words a question’s search read say prototype, the whole stored reply included', async () => {
    const cut = 'Here is what I built. '.padEnd(2_000, 'x')
    const changed = vi.fn()
    const pages = new QuestionPages({ changed, live: async () => true, messages: () => [{ ...reply(`${cut} The prototype is at http://localhost:8075/.`), id: 'whole' }] })
    const summarized = (requests: AgentRequest[]): AgentHostSnapshot => {
      const shown = snapshot(requests)
      return { ...shown, threads: [{ ...shown.threads[0]!, summary: { messageCount: 1, activityCount: 0, lastAssistant: { id: 'whole', text: cut, createdAt: '2026-10-14T00:00:00.000Z' } } }] }
    }
    pages.decorate(summarized([question('q', 'Which variant?')]))
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    expect(pages.searched('thread', 'request:q')).toMatchObject({ finished: true, aboutPrototype: true })
    const plainChanged = vi.fn()
    const plain = new QuestionPages({ changed: plainChanged, live: async () => true, messages: () => [{ ...reply(`${cut} It is at http://localhost:8075/.`), id: 'whole' }] })
    plain.decorate(summarized([question('q', 'Which variant?')]))
    await vi.waitFor(() => expect(plainChanged).toHaveBeenCalled())
    expect(plain.searched('thread', 'request:q')).toMatchObject({ finished: true, aboutPrototype: false })
  })

  it('keeps two replies of a thread named together, and reads one known only by its ID from the thread or its store', async () => {
    const stored = vi.fn(() => [{ ...reply(words), id: 'stored' }])
    const pages = new QuestionPages({ changed: vi.fn(), live: async () => true, messages: stored })
    const carried = snapshot([], [{ ...reply(words), id: 'carried' }, { ...reply('Done.'), id: 'newest' }])
    pages.decorate(carried, () => [{ id: 'newest', text: 'Done.' }, { id: 'carried' }])
    await vi.waitFor(() => expect(pages.searched('thread', 'reply:carried')?.finished).toBe(true))
    expect(pages.searched('thread', 'reply:carried')!.working).toHaveLength(2)
    expect(pages.searched('thread', 'reply:newest')).toMatchObject({ finished: true, pages: [] })
    expect(stored).not.toHaveBeenCalled()
    pages.decorate(carried, () => [{ id: 'newest', text: 'Done.' }, { id: 'stored' }])
    await vi.waitFor(() => expect(pages.searched('thread', 'reply:stored')?.finished).toBe(true))
    expect(stored).toHaveBeenCalledWith('thread')
    expect(pages.searched('thread', 'reply:stored')!.working).toHaveLength(2)
  })

  it('keeps no search for a reply that named no page once it is no longer looked for, however many replies come', () => {
    const pages = new QuestionPages({ changed: vi.fn(), live: async () => true })
    for (let index = 0; index < 100; index++) pages.decorate(snapshot([]), () => ({ id: `ordinary-${index}`, text: `Done with step ${index}.` }))
    expect(pages.searchCount).toBeLessThanOrEqual(1)
    expect(pages.searched('thread', 'reply:ordinary-99')).toMatchObject({ finished: true, pages: [] })
    expect(pages.searched('thread', 'reply:ordinary-98')).toBeUndefined()
  })

  it('lets a reply’s pages linger an hour once it is no longer looked for', async () => {
    let now = 0
    const pages = new QuestionPages({ changed: vi.fn(), now: () => now, live: async () => true })
    pages.decorate(snapshot([]), () => ({ id: 'm', text: words }))
    await vi.waitFor(() => expect(pages.searched('thread', 'reply:m')?.finished).toBe(true))
    const page = pages.searched('thread', 'reply:m')!.working[0]!
    pages.decorate(snapshot([]))
    now = QUESTION_PAGE_LINGER_MS - 1
    expect(pages.target(page.token)).toBeDefined()
    now = QUESTION_PAGE_LINGER_MS
    expect(pages.target(page.token)).toBeUndefined()
    expect(pages.searched('thread', 'reply:m')).toBeUndefined()
  })
})
