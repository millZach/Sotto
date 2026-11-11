// @vitest-environment node
/**
 * A host's own browser against a real Chrome, Chromium or Edge (ADR-0198): started headless over the DevTools pipe,
 * driving pages on a loopback server the test runs. Opt-in through SOTTO_REAL_BROWSER=1, since it needs a browser
 * installed; the Linux CI job sets it (docs/ci.md).
 */
import { createServer, type Server } from 'node:http'
import { access, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HostBrowser, HostBrowserMissing, NEW_WINDOW_BLOCKED, NO_HOST_BROWSER, PAGE_BLOCKED, PAGE_UNAVAILABLE, type HostBrowserPage, type HostPageFrame } from '../../src/host/browser/hostBrowser'
import { HostBrowserService } from '../../src/host/browser/hostBrowserService'
import { createHostBrowserAgentServer } from '../../src/main/tools/browserAgentTools'
import type { BrowserToolResult } from '../../src/main/agents/browserAgentServer'

const enabled = process.env.SOTTO_REAL_BROWSER === '1'
if (!enabled && process.env.SOTTO_REAL_BROWSER_REQUIRED === '1') throw new Error('The real-browser journey would be skipped: set SOTTO_REAL_BROWSER=1.')

const PAGES: Record<string, string> = {
  '/a': `<!doctype html><title>Page A</title><body style="margin:0">
    <button id="go" style="position:absolute;left:20px;top:20px;width:120px;height:40px" onclick="document.title='Clicked'">Sign in</button>
    <input id="name" style="position:absolute;left:20px;top:100px;width:200px;height:30px" oninput="document.title='Typed ' + this.value">
    <button id="pop" style="position:absolute;left:20px;top:160px;width:120px;height:40px" onclick="window.open('/b')">Pop</button>
    <a id="file" href="file:///etc/hostname" style="position:absolute;left:20px;top:220px">File</a>
    <div style="height:3000px"></div></body>`,
  '/b': '<!doctype html><title>Page B</title><p>B</p>',
  '/frame': '<!doctype html><title>Framed</title><iframe id="inner" src="data:text/html,<p>inside</p>"></iframe>',
}

let server: Server, origin: string, profileRoot: string, browser: HostBrowser

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
async function loaded(page: HostBrowserPage, path: string): Promise<void> {
  await until(() => page.state.url === origin + path && page.state.status === 'ready', `${path} to load`)
}

describe.skipIf(!enabled)('a host\'s own browser against a real Chromium (requires SOTTO_REAL_BROWSER=1)', () => {
  beforeAll(async () => {
    server = createServer((request, response) => {
      const body = PAGES[request.url ?? '']
      response.writeHead(body ? 200 : 404, { 'content-type': 'text/html' }).end(body ?? 'missing')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    profileRoot = await mkdtemp(join(tmpdir(), 'sotto-host-browser-test-'))
    browser = new HostBrowser({ profileRoot })
  })
  afterAll(async () => {
    await browser?.dispose()
    await new Promise(resolve => server?.close(resolve))
    if (profileRoot) await rm(profileRoot, { recursive: true, force: true })
  })

  // This cold-start journey includes several navigations and captures. Each wait keeps its own 15 s deadline;
  // the complete journey needs a separate budget so a slow CI runner does not cut off otherwise bounded steps.
  it('opens, follows and drives a page as the agent and the user do', async () => {
    const page = await browser.open('workspace-1')
    expect((await readdir(profileRoot)).length).toBe(1)
    await page.navigate(`${origin}/a`)
    await loaded(page, '/a')
    await until(() => page.state.title === 'Page A', 'the title')

    const inspected = JSON.parse(await page.automation.inspect()) as { url: string; elements: { name: string }[] }
    expect(inspected.url).toBe(`${origin}/a`)
    expect(inspected.elements.map(element => element.name)).toContain('Sign in')

    await page.automation.input({ type: 'click', x: 80, y: 40 }, () => undefined)
    await until(() => page.state.title === 'Clicked', 'the click')

    await page.input({ type: 'mouse', action: 'down', x: 60, y: 115, button: 'left', clickCount: 1, modifiers: 0 })
    await page.input({ type: 'mouse', action: 'up', x: 60, y: 115, button: 'left', clickCount: 1, modifiers: 0 })
    expect(await page.automation.target({ type: 'type', text: 'x' })).toContain('INPUT')
    await page.automation.input({ type: 'type', text: 'forge' }, () => undefined)
    await until(() => page.state.title === 'Typed forge', 'the agent\'s typing')
    await page.input({ type: 'text', text: '!' })
    await until(() => page.state.title === 'Typed forge!', 'the user\'s typing')

    const capture = await page.automation.capture(page.state.url)
    expect(capture.image.startsWith('data:image/png;base64,')).toBe(true)
    // The page is 1280 by 800; its scrollbar takes its width from what a capture sees, as on the desktop.
    expect(capture.height).toBe(800)
    expect(capture.width).toBeGreaterThan(1250)
    expect(capture.width).toBeLessThanOrEqual(1280)
    const evidence = await page.automation.evidence(capture)
    expect(evidence?.image.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect((await page.automation.thumbnail())?.startsWith('data:image/jpeg;base64,')).toBe(true)

    await page.navigate(`${origin}/b`)
    await loaded(page, '/b')
    await until(() => page.state.canGoBack, 'history')
    await page.back()
    await loaded(page, '/a')
    await until(() => page.state.canGoForward, 'forward history')
    await page.forward()
    await loaded(page, '/b')
    await page.reload()
    await loaded(page, '/b')
    await page.close()
    expect(page.closed).toBe(true)
  }, 60_000)

  it('sends pictures to a pane at its size, newest first, until it stops watching', async () => {
    const page = await browser.open('workspace-1')
    await page.navigate(`${origin}/a`)
    await loaded(page, '/a')
    await page.resize({ width: 800, height: 600 })
    const frames: HostPageFrame[] = []
    const stop = page.watch({ width: 800, height: 600 }, frame => frames.push(frame))
    await until(() => frames.length > 0, 'a picture')
    expect(frames[0]!.data.length).toBeGreaterThan(100)
    expect(frames[0]!.height).toBe(600)
    expect(frames[0]!.width).toBe(800)
    const before = frames.length
    await page.automation.input({ type: 'scroll', x: 100, y: 100, deltaX: 0, deltaY: 400 }, () => undefined)
    await until(() => frames.length > before, 'a picture after scrolling')
    stop()
    // Watching and stopping in a burst leaves no stream running, whatever order the changes finish in.
    const late: HostPageFrame[] = []
    const stops = [page.watch({ width: 400, height: 300 }, frame => late.push(frame)), page.watch({ width: 900, height: 700 }, frame => late.push(frame))]
    for (const stopWatching of stops) stopWatching()
    await new Promise(resolve => setTimeout(resolve, 500))
    late.length = 0
    await page.automation.input({ type: 'scroll', x: 100, y: 100, deltaX: 0, deltaY: -400 }, () => undefined)
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(late).toEqual([])
    await page.close()
  })

  it('refuses what the desktop\'s browser refuses, and says when a page is unavailable', async () => {
    const page = await browser.open('workspace-2')
    await page.navigate('file:///etc/hostname')
    expect(page.state.error).toBe(PAGE_BLOCKED)
    expect(page.state.url).toBe('about:blank')

    await page.navigate(`${origin}/a`)
    await loaded(page, '/a')
    const pages = (await browser.pages()).length
    await page.automation.input({ type: 'click', x: 80, y: 180 }, () => undefined)
    await until(() => page.state.error === NEW_WINDOW_BLOCKED, 'the new window to be refused')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect((await browser.pages()).length).toBe(pages)

    await page.navigate(`${origin}/frame`)
    await loaded(page, '/frame')
    const frames = async () => (await page.send('Page.getFrameTree') as { frameTree: { childFrames?: { frame: { url: string } }[] } }).frameTree.childFrames?.map(child => child.frame.url)
    const deadline = Date.now() + 15_000
    while (JSON.stringify(await frames()) !== JSON.stringify(['about:blank']) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    expect(await frames()).toEqual(['about:blank'])
    await page.navigate('http://127.0.0.1:9/nothing-here')
    await until(() => page.state.status === 'unavailable', 'the failure')
    expect(page.state.error).toBe(PAGE_UNAVAILABLE)
    await page.close()
  })

  it('lets a host thread\'s agent open, inspect and screenshot a page through its browser tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-host-browser-tools-'))
    const workspace = { threadId: 'thread-1', projectId: 'project', workingDirectory: root, workspaceId: 'a'.repeat(64) }
    const service = new HostBrowserService({ browser: new HostBrowser({ profileRoot: root }), emit: () => undefined, withoutAsking: true, saveWithoutAsking: async () => undefined,
      files: { resolveWorkspace: async () => ({ ok: true as const, value: workspace }), hasThread: () => true } })
    const tools = createHostBrowserAgentServer(service)
    const body = (result: BrowserToolResult) => JSON.parse((result.content[0] as { text: string }).text) as { task: { id: string; pageId: string; status: string }; output?: string; approvalRequired?: boolean }
    try {
      const opened = body(await tools.call('thread-1', 'browser_open', { url: `${origin}/a`, description: 'Check page A' }))
      expect(opened.approvalRequired).toBe(false)
      const target = { pageId: opened.task.pageId, taskId: opened.task.id }
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const listing = await service.list({ threadId: 'thread-1' })
        if (listing.ok && listing.value.pages[0]?.status === 'ready' && listing.value.pages[0].title === 'Page A') break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      const inspected = body(await tools.call('thread-1', 'browser_action', { ...target, action: { type: 'inspect' } }))
      expect(inspected.output).toContain('Sign in')
      const shot = await tools.call('thread-1', 'browser_action', { ...target, action: { type: 'screenshot' } })
      expect(shot.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' })
      const finished = body(await tools.call('thread-1', 'browser_finish', { ...target, status: 'completed', summary: 'Page A shows Sign in.', unchecked: [] }))
      expect(finished.task.status).toBe('completed')
    } finally {
      await tools.close()
      await service.shutDown()
      expect(await readdir(root)).toEqual([])
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps each workspace apart, and deletes its profile when it closes', async () => {
    const first = await browser.open('workspace-3'), second = await browser.open('workspace-4')
    await first.navigate(`${origin}/a`); await second.navigate(`${origin}/a`)
    await loaded(first, '/a'); await loaded(second, '/a')
    await first.send('Runtime.evaluate', { expression: 'localStorage.setItem("kept", "yes")' })
    const read = await second.send('Runtime.evaluate', { expression: 'localStorage.getItem("kept")', returnByValue: true }) as { result: { value: unknown } }
    expect(read.result.value).toBeNull()
    const [profile] = await readdir(profileRoot)
    let closed = 0
    browser.onClose(() => closed++)
    await browser.close()
    expect(first.closed && second.closed).toBe(true)
    expect(closed).toBe(1)
    await expect(access(join(profileRoot, profile!))).rejects.toThrow()
  })
})

describe('a host without a browser', () => {
  it('says so in words the agent can act on, and makes no profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-host-browser-none-'))
    try {
      const none = new HostBrowser({ find: async () => undefined, profileRoot: root })
      expect(await none.available()).toBe(false)
      await expect(none.open('workspace')).rejects.toBeInstanceOf(HostBrowserMissing)
      await expect(none.open('workspace')).rejects.toThrow(NO_HOST_BROWSER)
      expect(await readdir(root)).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
