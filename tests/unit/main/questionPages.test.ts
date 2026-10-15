// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { foundPages, pageMentions, QUESTION_PAGE_LINGER_MS, QuestionPages } from '../../../src/main/agents/questionPages'
import type { AgentHostSnapshot, AgentMessage, AgentRequest, AgentThread } from '../../../src/shared/agents'

// A question's pages (ADR-0084): Sotto finds them in the question and the agent's message before it, whatever the
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
      expect(pages[0]!.target).toEqual({ kind: 'file', root: expect.stringContaining('prototypes'), file: expect.stringContaining('greeting-prototype.html') })
    }
  })

  it('looks a path outside the folder up by its name inside it, so a network share in the text is never opened', async () => {
    const pages = await foundPages(pageMentions(['\\\\fileserver.invalid\\share\\greeting-prototype.html', '//fileserver.invalid/share/greeting-prototype.html']), folder)
    expect(pages.map(item => item.target.kind === 'file' && item.target.file)).toEqual([expect.stringMatching(/prototypes[\\/]greeting-prototype\.html$/u)])
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
