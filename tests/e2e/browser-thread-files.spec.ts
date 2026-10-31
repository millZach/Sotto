import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { captureSotto } from './support/sottoCapture'
import { resizeContentWindow } from './support/sottoWindow'
import { closeSotto, launchSotto, openThreads, toggleTools } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

// Agents show a prototype by opening the HTML file they made in their thread's folder. Sotto's browser opens no file://
// page, so the tool used to answer "This browser request is invalid" and the agent went to the shell instead
// (docs/research/2026-10-27-built-in-browser.md, cause 4). Sotto now serves the file read-only on this computer's loopback,
// with phone access off, and refuses a file outside the folder in words (ADR-0085, October 27, 2026 amendment).
const SHOTS = evidenceDirectory('artifacts/browser-thread-files')
const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trail picker</title>
<link rel="stylesheet" href="assets/look.css"></head><body><header>Trail picker</header><main><p class="variant" id="variant"></p>
<h1>Take the long way home.</h1><p>Two ways to save a trail. This page was opened from a file in the thread's folder.</p>
<div class="landscape"></div><button>Save trail</button></main><script src="assets/variant.js"></script></body></html>`
const LOOK = `*{box-sizing:border-box}body{margin:0;background:#f3f1e8;color:#273e34;font:16px system-ui}header{padding:20px 24px;border-bottom:1px solid #ced8c9}
main{padding:24px;max-width:660px}h1{font-size:40px;font-weight:500;letter-spacing:-.04em;margin:10px 0;color:rgb(48, 79, 61)}p{line-height:1.6;color:#546850}
.variant{display:inline-block;margin:0;padding:4px 10px;border-radius:999px;background:#304f3d;color:#fff;font-size:13px}
.landscape{height:120px;background:linear-gradient(150deg,#dbe0d0 35%,#a7b8a0 35%,#a7b8a0 57%,#688a73 57%,#688a73 76%,#294b3e 76%);margin:20px 0}
button{background:#304f3d;color:white;border:0;border-radius:5px;padding:12px 18px;font:inherit}`
// The script beside the page reads the variant from the query string, and says in the title whether the style beside it loaded.
const VARIANT = `const variant = new URLSearchParams(location.search).get('variant') ?? 'none'
document.getElementById('variant').textContent = 'Variant ' + variant
const styled = getComputedStyle(document.querySelector('h1')).color === 'rgb(48, 79, 61)'
document.title = 'Trail picker, variant ' + variant + (styled ? ', styled' : ', unstyled')`

test('an agent opens an HTML file from its thread\'s folder in Sotto\'s browser, and a file outside it is refused in words', async () => {
  test.setTimeout(180_000)
  await mkdir(SHOTS, { recursive: true })
  const outside = await mkdtemp(join(tmpdir(), 'sotto-e2e-outside-'))
  await writeFile(join(outside, 'elsewhere.html'), '<!doctype html><title>Elsewhere</title>')
  const launched = await launchSotto().catch(async error => { await rm(outside, { recursive: true, force: true }); throw error })
  const { page } = launched
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  try {
    await page.evaluate(async () => {
      // The default, Let agents use the browser without asking, stays on (ADR-0029); phone access stays off.
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload(); await resizeContentWindow(launched, 1280, 800, [800, 540]); await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    const folder = await page.evaluate(async () => {
      const listed = await window.sotto!.browser!.list({ threadId: 'workshop' })
      if (!listed.ok) throw new Error(listed.error.message)
      return listed.value.workspace.workingDirectory
    })
    const prototypes = join(folder, 'docs', 'prototypes')
    await mkdir(join(prototypes, 'assets'), { recursive: true })
    await writeFile(join(prototypes, 'trail-prototype.html'), PAGE)
    await writeFile(join(prototypes, 'assets', 'look.css'), LOOK)
    await writeFile(join(prototypes, 'assets', 'variant.js'), VARIANT)

    const agent = (name: string, args: unknown) => page.evaluate(async request => window.sottoE2E!.browserAgent!(request), { threadId: 'workshop', name, arguments: args })
    const body = (called: { content: { type: string }[] }) => JSON.parse((called.content[0] as unknown as { text: string }).text) as { task?: { id: string; pageId: string }; code?: string; message?: string }
    const listed = () => page.evaluate(async () => {
      const result = await window.sotto!.browser!.list({ threadId: 'workshop' })
      return result.ok ? result.value.pages.map(({ url, title, status }) => ({ url, title, status })) : []
    })

    // The file outside the folder is refused in plain words, and no page opens for it.
    const refused = await agent('browser_open', { url: pathToFileURL(join(outside, 'elsewhere.html')).href, description: 'Show the prototype' })
    expect(refused.isError).toBe(true)
    const refusal = body(refused).message ?? ''
    expect(refusal).toMatch(/^Only HTML files inside this thread's folder can open in Sotto's browser\. .*elsewhere\.html is outside it\./u)
    expect(await listed()).toEqual([])

    const written = `${pathToFileURL(join(prototypes, 'trail-prototype.html')).href}?variant=B`
    const opened = await agent('browser_open', { url: written, description: 'Show the trail picker prototype, variant B' })
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true)
    // The page's own script ran, read the variant from the query string, and found the style beside the page.
    await expect.poll(async () => (await listed())[0]?.title).toBe('Trail picker, variant B, styled')
    const shown = (await listed())[0]!
    expect(shown.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/page\/[A-Za-z0-9_-]{32}\/trail-prototype\.html\?variant=B$/u)

    // The agent sees the page it opened: the thread's grant shares it, so its inspect reads the page.
    const task = body(opened).task!
    const inspected = await agent('browser_action', { pageId: task.pageId, taskId: task.id, action: { type: 'inspect' } })
    expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true)

    const player = page.getByRole('complementary', { name: 'Browser for Workshop' })
    await expect(player).toBeVisible()
    await captureSotto(launched, join(SHOTS, 'thread-file-player.png'), { mode: 'native-window', title: 'Sotto thread file player', retries: 9, retryDelayMs: 500 })

    await toggleTools(page)
    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    await panel.getByRole('tab', { name: 'Browser' }).click()
    await expect(panel.getByRole('textbox', { name: 'Address' })).toHaveValue(shown.url)
    await captureSotto(launched, join(SHOTS, 'thread-file-tools.png'), { mode: 'native-window', title: 'Sotto thread file tools', retries: 9, retryDelayMs: 500 })
    expect(errors).toEqual([])
    await writeFile(join(SHOTS, 'thread-file.json'), JSON.stringify({
      opened: written.replace(pathToFileURL(folder).href, '<thread folder>'),
      servedAt: shown.url.replace(/\/page\/[A-Za-z0-9_-]{32}\//u, '/page/<token>/').replace(/:\d+\//u, ':<port>/'),
      title: shown.title, outsideRefusal: refusal.replace(outside, '<outside folder>').replace(folder, '<thread folder>'), inspectRan: true, errors,
    }, null, 2))
  } catch (error) {
    await page.screenshot({ path: join(SHOTS, 'thread-file-failure.png') }).catch(() => undefined)
    throw error
  } finally {
    await closeSotto(launched)
    await rm(outside, { recursive: true, force: true })
  }
})
