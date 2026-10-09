import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto } from './support/sottoLaunch'

const run = promisify(execFile)

async function addThreads(page: Page, paths: string[]): Promise<string[]> {
  return page.evaluate(async paths => {
    await window.sotto!.updateSettings({ onboardingComplete: true })
    const agents = window.sotto!.agents!
    await agents.command({ type: 'configure', patch: { enabled: true, speak: false } })
    await agents.command({ type: 'connect' })
    const ids: string[] = []
    for (const [index, path] of paths.entries()) {
      const title = `Phase three bridge ${index}`
      const created = await agents.command({ type: 'create-project', title, path, useExisting: true })
      if (created.error) throw new Error(created.error)
      const projectId = created.host.projects.find(project => project.title === title)!.id
      const state = await agents.command({ type: 'create-thread', projectId, title, modelId: 'claude:test', managed: false, workingCopy: 'shared' })
      if (state.error || !state.activeThreadId) throw new Error(state.error ?? 'Thread was not created')
      ids.push(state.activeThreadId)
    }
    return ids
  }, paths)
}

// These exercise production main/preload services in Electron. Only coding providers are fixtures.
test('terminal instances retain real output through renderer reload and reject another thread owner', async () => {
  test.skip(process.platform !== 'win32', 'Windows PTY acceptance')
  test.setTimeout(90_000)
  const root = await mkdtemp(join(tmpdir(), 'sotto-e2e-phase3-terminal-'))
  const directories = [join(root, 'first'), join(root, 'second')]
  for (const directory of directories) await mkdir(directory)
  await writeFile(join(directories[0]!, 'server.cjs'), [
    "const http = require('node:http'); const fs = require('node:fs');",
    "const server = http.createServer((request, response) => response.end('SOTTO_PTY_SERVER'));",
    "server.listen(0, '127.0.0.1', () => fs.writeFileSync('server-port.txt', String(server.address().port)));",
    "process.on('SIGINT', () => server.close(() => process.exit(0)));",
  ].join('\n'))
  const launched = await launchSotto()
  try {
    const [first, second] = await addThreads(launched.page, directories)
    const initial = await launched.page.evaluate(async threadId => {
      const bridge = window.sotto!.terminal!
      const listing = await bridge.list({ threadId })
      if (!listing.ok) throw new Error(listing.error.message)
      const target = { threadId, workspaceId: listing.value.workspace.workspaceId }
      const created = await bridge.create({ ...target, cols: 90, rows: 24 })
      if (!created.ok) throw new Error(created.error.message)
      const request = { ...target, sessionId: created.value.session.id }
      const written = await bridge.write({ ...request, data: `node -e "require('fs').writeFileSync('terminal-proof.txt', 'native-terminal-ran'); console.log('SOTTO_PHASE3_TERMINAL_READY')"\r` })
      if (!written.ok) throw new Error(written.error.message)
      return { request, directory: created.value.session.workspace.workingDirectory }
    }, first!)
    expect(initial.directory).toBe(directories[0])
    await expect.poll(() => readFile(join(directories[0]!, 'terminal-proof.txt'), 'utf8').catch(() => '')).toBe('native-terminal-ran')
    await expect.poll(async () => launched.page.evaluate(async request => {
      const value = await window.sotto!.terminal!.read(request)
      return value.ok ? value.value.output : ''
    }, initial.request)).toContain('SOTTO_PHASE3_TERMINAL_READY')
    const denied = await launched.page.evaluate(async ({ request, second }) => {
      const listing = await window.sotto!.terminal!.list({ threadId: second })
      if (!listing.ok) throw new Error(listing.error.message)
      return window.sotto!.terminal!.write({ threadId: second, workspaceId: listing.value.workspace.workspaceId,
        sessionId: request.sessionId, data: 'echo WRONG_OWNER\r' })
    }, { request: initial.request, second: second! })
    expect(denied.ok).toBe(false)
    await launched.page.reload()
    const retained = await launched.page.evaluate(async request => window.sotto!.terminal!.read(request), initial.request)
    expect(retained.ok).toBe(true)
    if (retained.ok) {
      expect(retained.value.session.id).toBe(initial.request.sessionId)
      expect(retained.value.session.status).toBe('running')
      expect(retained.value.output).toContain('SOTTO_PHASE3_TERMINAL_READY')
      expect(retained.value.output).not.toContain('WRONG_OWNER')
    }
    const resized = await launched.page.evaluate(async request => window.sotto!.terminal!.resize({ ...request, cols: 100, rows: 30 }), initial.request)
    expect(resized.ok).toBe(true)
    const started = await launched.page.evaluate(async request => window.sotto!.terminal!.write({ ...request, data: 'node server.cjs\r' }), initial.request)
    expect(started.ok).toBe(true)
    await expect.poll(() => readFile(join(directories[0]!, 'server-port.txt'), 'utf8').catch(() => '')).toMatch(/^\d+$/)
    const port = await readFile(join(directories[0]!, 'server-port.txt'), 'utf8')
    const serverUrl = `http://127.0.0.1:${port}/`
    expect(await (await fetch(serverUrl, { signal: AbortSignal.timeout(2_000) })).text()).toBe('SOTTO_PTY_SERVER')
    const interrupted = await launched.page.evaluate(async request => window.sotto!.terminal!.interrupt(request), initial.request)
    expect(interrupted.ok).toBe(true)
    await expect.poll(async () => {
      try { await fetch(serverUrl, { signal: AbortSignal.timeout(500) }); return 'running' }
      catch { return 'stopped' }
    }).toBe('stopped')
    const alive = await launched.page.evaluate(async request => window.sotto!.terminal!.read(request), initial.request)
    expect(alive.ok && alive.value.session.status).toBe('running')
    await launched.page.evaluate(async request => window.sotto!.terminal!.close(request), initial.request)
  } finally { await closeSotto(launched) }
})

test('real Git diffs stay in their working copy and embedded pages cannot access the app bridge', async () => {
  test.setTimeout(90_000)
  const root = await mkdtemp(join(tmpdir(), 'sotto-e2e-phase3-tools-'))
  const directories = [join(root, 'first'), join(root, 'second')]
  for (const [index, directory] of directories.entries()) {
    await mkdir(directory)
    const git = (args: string[]) => run('git', args, { cwd: directory, windowsHide: true, timeout: 10_000 })
    await git(['init', '--quiet'])
    await writeFile(join(directory, 'proof.txt'), `original ${index}\n`)
    await git(['add', 'proof.txt'])
    await git(['-c', 'user.name=Sotto verification', '-c', 'user.email=verification@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Owned fixture'])
    await writeFile(join(directory, 'proof.txt'), `changed in directory ${index}\n`)
  }
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>Sotto owned browser probe</title><h1>Local app</h1><script>document.body.dataset.bridge = typeof window.sotto; document.body.dataset.require = typeof window.require;</script>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Local server has no port')
  const url = `http://127.0.0.1:${address.port}/`
  const launched = await launchSotto().catch(error => { server.close(); throw error })
  try {
    const ids = await addThreads(launched.page, directories)
    for (const [index, threadId] of ids.entries()) {
      const diff = await launched.page.evaluate(async threadId => {
        const listing = await window.sotto!.gitChanges!.list({ threadId })
        if (!listing.ok) throw new Error(listing.error.message)
        const file = listing.value.files.find(file => file.path === 'proof.txt')
        if (!file) throw new Error('Changed file missing')
        const review = await window.sotto!.gitChanges!.review({ threadId, workspaceId: listing.value.workspace.workspaceId, scope: { kind: 'working' } })
        if (!review.ok) return review
        return { ok: true as const, value: review.value.files.find(item => item.path === file.path)! }
      }, threadId)
      expect(diff.ok).toBe(true)
      if (diff.ok) {
        expect(diff.value.content.kind).toBe('text')
        if (diff.value.content.kind === 'text') {
          expect(diff.value.content.patch).toContain(`changed in directory ${index}`)
          expect(diff.value.content.patch).not.toContain(`changed in directory ${1 - index}`)
        }
      }
    }
    const browser = await launched.page.evaluate(async ({ threadId, url }) => {
      const bridge = window.sotto!.browser!
      const listing = await bridge.list({ threadId })
      if (!listing.ok) throw new Error(listing.error.message)
      const target = { threadId, workspaceId: listing.value.workspace.workspaceId }
      const page = await bridge.create({ ...target, url })
      if (!page.ok) throw new Error(page.error.message)
      return { ...target, pageId: page.value.id }
    }, { threadId: ids[0]!, url })
    await expect.poll(() => launched.app.evaluate(({ webContents }, url) => {
      return webContents.getAllWebContents().find(contents => contents.getURL() === url)?.getTitle()
    }, url)).toBe('Sotto owned browser probe')
    const boundary = await launched.app.evaluate(async ({ webContents }, url) => {
      const page = webContents.getAllWebContents().find(contents => contents.getURL() === url)!
      return page.executeJavaScript('({bridge: document.body.dataset.bridge, require: document.body.dataset.require})')
    }, url)
    expect(boundary).toEqual({ bridge: 'undefined', require: 'undefined' })
    const secondPage = await launched.page.evaluate(async ({ browser, url }) => {
      const bridge = window.sotto!.browser!
      const bounds = { x: 450, y: 120, width: 600, height: 450 }
      const mounted = await bridge.mount({ ...browser, bounds })
      if (!mounted.ok) throw new Error(mounted.error.message)
      const created = await bridge.create({ threadId: browser.threadId, workspaceId: browser.workspaceId, url: `${url}second` })
      if (!created.ok) throw new Error(created.error.message)
      const second = { ...browser, pageId: created.value.id }
      const results = await Promise.all([
        bridge.mount({ ...browser, bounds: null }),
        bridge.mount({ ...second, bounds }),
      ])
      for (const result of results) if (!result.ok) throw new Error(result.error.message)
      return second
    }, { browser, url })
    await expect.poll(() => launched.app.evaluate(({ BrowserWindow, WebContentsView }, url) => {
      const host = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
      return host.contentView.children.filter(view => view instanceof WebContentsView && view.webContents.getURL() === `${url}second`).length
    }, url)).toBe(1)
    await launched.page.evaluate(async request => window.sotto!.browser!.close(request), secondPage)
    const unsafe = await launched.page.evaluate(async browser => {
      try { return await window.sotto!.browser!.navigate({ ...browser, url: 'file:///C:/Windows/win.ini' }) }
      catch { return { ok: false } }
    }, browser)
    expect(unsafe.ok).toBe(false)
    await launched.page.evaluate(async browser => window.sotto!.browser!.close(browser), browser)
  } finally {
    await closeSotto(launched)
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
