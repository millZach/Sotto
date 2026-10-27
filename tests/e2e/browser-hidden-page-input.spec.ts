import { captureSotto } from './support/sottoCapture'
import { resizeContentWindow } from './support/sottoWindow'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, openThreads } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

// An agent's scroll on a page nobody is looking at used to wait for a frame that never came, until Claude Code gave
// up after 300 seconds and every later action on that page said it was still running
// (docs/research/2026-10-27-built-in-browser.md). The page now borrows an off-screen surface for input, as captures do.
const SHOTS = evidenceDirectory('artifacts/browser-launch-reliability')
const NOTES = Array.from({ length: 60 }, (_, index) => `<li>Note ${index + 1}</li>`).join('')
const CONTENT = `<!doctype html><html><head><title>Fieldnotes</title><style>body{font:18px system-ui;margin:24px}li{height:48px}</style></head>
<body><h1>Fieldnotes</h1><ol>${NOTES}</ol><script>addEventListener('scroll', () => { document.title = 'Fieldnotes, scrolled to ' + Math.round(scrollY) })</script></body></html>`

test('an agent scrolls a page that is not on screen, and the page is free for its next action', async () => {
  test.setTimeout(180_000)
  await mkdir(SHOTS, { recursive: true })
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(CONTENT) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Preview server unavailable')
  const url = `http://127.0.0.1:${address.port}/`
  const launched = await launchSotto().catch(error => { server.close(); throw error })
  const { page } = launched
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  try {
    await page.evaluate(async () => {
      // The default, Let agents use the browser without asking, stays on (ADR-0029).
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload(); await resizeContentWindow(launched, 1280, 800, [800, 540]); await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    const agent = (name: string, args: unknown) => page.evaluate(async request => window.sottoE2E!.browserAgent!(request), { threadId: 'workshop', name, arguments: args })
    const body = (called: { content: { type: string }[] }) => JSON.parse((called.content[0] as unknown as { text: string }).text) as { task: { id: string; pageId: string }; message?: string }
    const title = () => page.evaluate(async () => {
      const listed = await window.sotto!.browser!.list({ threadId: 'workshop' })
      return listed.ok ? listed.value.pages[0]?.title ?? '' : ''
    })

    const opened = await agent('browser_open', { url, description: 'Reading the notes' })
    expect(opened.isError).not.toBe(true)
    const task = body(opened).task
    await expect.poll(title).toBe('Fieldnotes')

    // Hide the player: the page is now on no window at all, the case that hung.
    const player = page.getByRole('complementary', { name: 'Browser for Workshop' })
    await expect(player).toBeVisible()
    await player.getByRole('button', { name: 'Hide the browser; the agent keeps working' }).click()
    await expect(player).toBeHidden()

    const started = Date.now()
    const scrolled = await agent('browser_action', { pageId: task.pageId, taskId: task.id, action: { type: 'scroll', x: 300, y: 300, deltaX: 0, deltaY: 900 } })
    const scrollMs = Date.now() - started
    expect(scrolled.isError, JSON.stringify(scrolled)).not.toBe(true)
    await expect.poll(title).toMatch(/^Fieldnotes, scrolled to [1-9]/u)
    // The page is free: a second action on it runs rather than saying one is still running.
    const again = await agent('browser_action', { pageId: task.pageId, taskId: task.id, action: { type: 'scroll', x: 300, y: 300, deltaX: 0, deltaY: 300 } })
    expect(again.isError, JSON.stringify(again)).not.toBe(true)

    // Show it: the page is where the agent left it.
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    await panel.getByRole('tab', { name: 'Browser' }).click()
    await expect(panel.getByRole('textbox', { name: 'Address' })).toHaveValue(url)
    await captureSotto(launched, join(SHOTS, 'hidden-scroll-landed.png'), { mode: 'native-window', title: 'Sotto browser hidden scroll', retries: 9, retryDelayMs: 500 })
    expect(errors).toEqual([])
    await writeFile(join(SHOTS, 'hidden-scroll.json'), JSON.stringify({ hiddenScrollReturned: true, scrollMs, pageTitleAfter: await title(), secondActionRan: true, errors }, null, 2))
  } catch (error) {
    await page.screenshot({ path: join(SHOTS, 'hidden-scroll-failure.png') }).catch(() => undefined)
    throw error
  } finally { await closeSotto(launched); await new Promise<void>(done => server.close(() => done())) }
})
