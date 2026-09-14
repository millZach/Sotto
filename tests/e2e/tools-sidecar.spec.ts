import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'

// Real Electron shell, native browser, PTY, files and Git. Only coding providers use E2E fixtures.
// Every file and shell command below belongs to the launch helper's disposable profile.
const run = promisify(execFile)
const SHOTS = resolve(process.cwd(), 'artifacts/tools-sidecar')
const SIZES = [[1280, 800], [1600, 1000], [820, 560]] as const
const MODES = ['dark', 'light'] as const
type Tool = 'Browser' | 'Terminal' | 'Files' | 'Changes'

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/index.html'))!
    window.setMinimumSize(800, 540)
    window.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => launched.page.evaluate(() => `${innerWidth}x${innerHeight}`)).toBe(`${width}x${height}`)
}

async function appearance(page: Page, mode: 'light' | 'dark'): Promise<void> {
  await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), mode)
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
}

async function nativeViews(launched: LaunchedSotto): Promise<{ url: string; bounds: Electron.Rectangle }[]> {
  return launched.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const host = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/index.html'))!
    return host.contentView.children.filter(view => view instanceof WebContentsView)
      .map(view => ({ url: (view as Electron.WebContentsView).webContents.getURL(), bounds: view.getBounds() }))
  })
}

async function browserBounds(launched: LaunchedSotto, url: string): Promise<Electron.Rectangle> {
  await launched.page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined)))
  })
  const expected = await launched.page.locator('.browser-viewport').evaluate(element => {
    const rect = element.getBoundingClientRect()
    const x = Math.round(rect.left), y = Math.round(rect.top)
    return { x, y, width: Math.round(rect.right) - x, height: Math.round(rect.bottom) - y }
  })
  expect(expected.height).toBeGreaterThan(150)
  await expect.poll(async () => (await nativeViews(launched)).filter(view => view.url === url)).toEqual([{ url, bounds: expected }])
  return expected
}

/** Capture the actual window including WebContentsView, omitted from a renderer-only screenshot. */
async function screenshot(launched: LaunchedSotto, name: string, native: boolean): Promise<void> {
  await launched.page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  if (!native) {
    await launched.page.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled', caret: 'hide' })
    return
  }
  const title = `Sotto Sidecar review ${name}`
  await launched.app.evaluate(({ BrowserWindow }, title) => {
    const host = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/index.html'))!
    host.setTitle(title)
    host.show()
  }, title)
  const png = await launched.app.evaluate(async ({ BrowserWindow, desktopCapturer, screen }, title) => {
    const bounds = BrowserWindow.getAllWindows().find(candidate => candidate.getTitle() === title)!.getBounds()
    const scale = screen.getDisplayMatching(bounds).scaleFactor
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale) } })
    const source = sources.find(candidate => candidate.name === title)
    if (!source) throw new Error(`No native capture for ${title}`)
    return source.thumbnail.toPNG().toString('base64')
  }, title)
  await writeFile(join(SHOTS, `${name}.png`), Buffer.from(png, 'base64'))
}

const PREVIEW = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fieldnotes</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f1e8;color:#273e34;font:15px system-ui}header{padding:20px 24px;border-bottom:1px solid #dedfd2;display:flex;justify-content:space-between}nav{font-size:13px}main{padding:30px 24px;display:grid;grid-template-columns:1fr 1fr;gap:22px;align-items:center}small{font-size:10px;letter-spacing:.12em}h1{font-weight:500;letter-spacing:-.05em;font-size:clamp(30px,4.5vw,54px);line-height:1.03;margin:18px 0}p{color:#677167;line-height:1.6}button{border:0;border-radius:4px;background:#304f3d;color:white;padding:12px 18px;font:inherit}.landscape{min-height:260px;background:linear-gradient(150deg,#dbe0d0 35%,#a7b8a0 35%,#a7b8a0 57%,#688a73 57%,#688a73 76%,#294b3e 76%);display:flex;align-items:end;padding:18px;color:white}.caption{padding:24px;border-top:1px solid #dedfd2}@media(max-width:450px){main{grid-template-columns:1fr}.landscape{min-height:160px}h1{font-size:42px}}
</style></head><body><header><strong>⌁ Fieldnotes</strong><nav>Explore &nbsp; Journal</nav></header><main><section><small>LESS SCROLLING. MORE WANDERING.</small><h1>A little more outside.</h1><p>Good trails. Quiet places. A reason to take the long way home.</p><button onclick="document.querySelector('h1').textContent='Find your next trail.'">Find a trail →</button></section><div class="landscape">The Pacific Northwest</div></main><div class="caption"><strong>Start somewhere close.</strong><p>Your next favorite place might be just around the bend.</p></div></body></html>`

test('Sidecar preserves native tools while giving the browser, terminal, files and changes room at three window sizes', async () => {
  test.skip(process.platform !== 'win32', 'Windows native PTY and window composition acceptance')
  test.setTimeout(240_000)
  await mkdir(SHOTS, { recursive: true })
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(PREVIEW) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The owned preview server has no port')
  const url = `http://127.0.0.1:${address.port}/`
  const launched = await launchSotto().catch(error => { server.close(); throw error })
  const { page } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const report: Record<string, unknown> = {}
  try {
    const folder = await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { enabled: true, speak: false } })
      const state = await agents.command({ type: 'connect' })
      const thread = state.host.threads.find(item => item.id === 'workshop')!
      return state.host.projects.find(project => project.id === thread.projectId)!.path
    })
    expect(folder.startsWith(launched.userData)).toBe(true)
    await mkdir(join(folder, 'src'), { recursive: true })
    const git = (args: string[]) => run('git', args, { cwd: folder, windowsHide: true, timeout: 15_000 })
    await git(['init', '--quiet'])
    await writeFile(join(folder, 'src/app.ts'), "export function greet(name: string): string {\n  return 'Hello ' + name\n}\n")
    await writeFile(join(folder, 'src/styles.css'), 'body { background: white; color: black; }\n')
    await writeFile(join(folder, 'README.md'), '# Fieldnotes\n\nFind your next trail.\n')
    await git(['add', '.'])
    await git(['-c', 'user.name=Sotto verification', '-c', 'user.email=verification@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Owned Sidecar fixture'])
    await writeFile(join(folder, 'src/app.ts'), 'export function greet(name: string): string {\n  return `Hello, ${name}!`\n}\n\nexport const version = 2\n')
    await writeFile(join(folder, 'src/styles.css'), 'body { background: #f3f1e8; color: #273e34; }\n')
    await writeFile(join(folder, 'CHANGELOG.md'), '# Changes\n\n- Warmer colors and a friendlier greeting.\n')
    await page.evaluate(async url => window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'workshop', status: 'idle', text: `The landing page has a warmer palette and more room to breathe. Review the changes and [open the preview](${url}).` }), url)
    // The onboarding decision is taken at app mount; reload the owned profile after completing fixture setup.
    await page.reload()
    await resize(launched, 1280, 800)
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    const sheet = panel.locator('.tools-panel__sheet')
    const select = async (tool: Tool): Promise<void> => { await panel.getByRole('tablist', { name: 'Tools', exact: true }).getByRole('tab', { name: tool, exact: true }).click() }

    await select('Files')
    await panel.getByRole('treeitem', { name: 'src', exact: true }).click()
    await panel.getByRole('treeitem', { name: 'app.ts', exact: true }).click()
    await expect(panel.locator('.files-preview__text')).toContainText('export const version = 2')
    await select('Changes')
    await panel.getByRole('option', { name: /^app\.ts/u }).click()
    await expect(panel.getByRole('region', { name: 'Changes in src/app.ts' })).toContainText('return `Hello, ${name}!`')
    await select('Terminal')
    await panel.getByRole('button', { name: 'Start terminal' }).click()
    await expect(panel.locator('.xterm-rows')).toBeVisible()
    await panel.locator('.xterm').click()
    await page.keyboard.type('echo SOTTO_SIDECAR_NATIVE_OK')
    await page.keyboard.press('Enter')
    await expect.poll(async () => ((await panel.locator('.xterm-rows').innerText()).match(/SOTTO_SIDECAR_NATIVE_OK/gu) ?? []).length).toBeGreaterThanOrEqual(2)
    await page.keyboard.type('echo Sidecar > sidecar-proof.txt')
    await page.keyboard.press('Enter')
    await expect.poll(() => readFile(join(folder, 'sidecar-proof.txt'), 'utf16le').catch(() => '')).toContain('Sidecar')
    await select('Browser')
    const addressBar = panel.getByRole('textbox', { name: /^Address/u })
    await addressBar.fill(url)
    await addressBar.press('Enter')
    await expect(panel.getByRole('tab', { name: /Fieldnotes/u })).toBeVisible()
    await browserBounds(launched, url)
    // The webpage is interactive in the actual sandboxed native view, not an image or a renderer mock.
    const clicked = await launched.app.evaluate(async ({ webContents }, url) => {
      const page = webContents.getAllWebContents().find(contents => contents.getURL() === url)!
      return page.executeJavaScript("document.querySelector('button').click(); ({heading:document.querySelector('h1').textContent, bridge:typeof window.sotto, require:typeof window.require})")
    }, url)
    expect(clicked).toEqual({ heading: 'Find your next trail.', bridge: 'undefined', require: 'undefined' })

    for (const [width, height] of SIZES) {
      await resize(launched, width, height)
      if (width === 820) {
        await expect(page.locator('.threads-view > .thread-nav')).toBeHidden()
        await expect(panel).toHaveAttribute('data-mode', 'docked')
      }
      for (const mode of MODES) {
        await appearance(page, mode)
        for (const tool of ['Browser', 'Terminal', 'Files', 'Changes'] as const) {
          await select(tool)
          const key = `${tool.toLowerCase()}-${width}x${height}-${mode}`
          await expect(sheet).toBeVisible()
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          const box = await sheet.boundingBox()
          expect(box).not.toBeNull()
          expect(box!.x).toBeGreaterThanOrEqual(0)
          expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1)
          const native = tool === 'Browser'
          const nativeBounds = native ? await browserBounds(launched, url) : null
          if (!native) await expect.poll(async () => (await nativeViews(launched)).length).toBe(0)
          if (tool === 'Terminal') await expect(panel.locator('.xterm-rows')).toContainText('SOTTO_SIDECAR_NATIVE_OK')
          if (tool === 'Files') await expect(panel.locator('.files-preview__text')).toContainText('export const version = 2')
          await screenshot(launched, key, native)
          report[key] = { panel: box, nativeBounds }
        }
      }
    }

    await resize(launched, 1280, 800)
    await appearance(page, 'dark')
    await select('Changes')
    await panel.getByRole('button', { name: 'Split view', exact: true }).click()
    await expect(panel.locator('.changes-diff__rows')).toHaveAttribute('data-layout', 'split')
    await expect(panel.locator('.changes-split__cell[data-kind="add"]')).toContainText(['return `Hello, ${name}!`', '', 'export const version = 2'])
    await screenshot(launched, 'changes-split-1280-dark', false)
    await panel.getByRole('button', { name: 'Split view', exact: true }).click()
    await select('Browser')
    await panel.getByRole('button', { name: 'Pin to Workshop', exact: true }).click()
    await panel.getByRole('button', { name: 'Unpin from Workshop', exact: true }).click()
    const initial = await browserBounds(launched, url)
    await panel.getByRole('button', { name: 'Expand tools panel', exact: true }).click()
    await expect.poll(async () => (await browserBounds(launched, url)).width).toBeGreaterThan(initial.width)
    await screenshot(launched, 'browser-expanded-1280-dark', true)
    await panel.getByRole('button', { name: 'Restore tools panel', exact: true }).click()
    await expect.poll(async () => (await browserBounds(launched, url)).width).toBe(initial.width)
    const divider = panel.getByRole('separator', { name: 'Resize tools panel', exact: true })
    await divider.focus()
    await page.keyboard.press('ArrowLeft')
    await expect.poll(async () => (await browserBounds(launched, url)).width).toBeGreaterThan(initial.width)
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await browserBounds(launched, url)).width).toBe(initial.width)
    await resize(launched, 820, 560)
    const compact = await browserBounds(launched, url)
    await panel.getByRole('button', { name: 'Expand tools panel', exact: true }).click()
    await expect.poll(async () => (await browserBounds(launched, url)).width).toBeGreaterThan(compact.width)
    await screenshot(launched, 'browser-expanded-820-dark', true)
    await panel.getByRole('button', { name: 'Restore tools panel', exact: true }).click()
    await expect.poll(async () => (await browserBounds(launched, url)).width).toBe(compact.width)
    await panel.getByRole('button', { name: 'Close tools panel', exact: true }).click()
    await expect(page.locator('.threads-view > .thread-nav')).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Collapsed tools' })).toHaveCount(0)
    await expect(page.locator('.thread-workspace__tools')).toBeHidden()
    await expect(page.getByRole('button', { name: 'Tools', exact: true })).toBeFocused()
    await screenshot(launched, 'tools-collapsed-820-dark', false)
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    await expect(page.locator('.threads-view > .thread-nav')).toBeHidden()
    await browserBounds(launched, url)
    await resize(launched, 1280, 800)
    await panel.getByRole('button', { name: 'Close tools panel', exact: true }).click()
    await expect(panel).toBeHidden()
    await expect.poll(async () => (await nativeViews(launched)).length).toBe(0)
    await screenshot(launched, 'tools-collapsed-1280-dark', false)
    await expect(page.getByRole('navigation', { name: 'Collapsed tools' })).toHaveCount(0)
    await expect(page.locator('.thread-workspace__tools')).toBeHidden()
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    await browserBounds(launched, url)
    await select('Terminal')
    await expect(panel.locator('.xterm-rows')).toContainText('SOTTO_SIDECAR_NATIVE_OK')
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'on' }))
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
    await panel.getByRole('button', { name: 'Close tools panel', exact: true }).click()
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    expect(await sheet.evaluate(element => getComputedStyle(element).animationName)).toBe('none')
    expect(await sheet.evaluate(element => element.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0)
    expect(errors).toEqual([])
    await writeFile(join(SHOTS, 'layout.json'), JSON.stringify({ errors, sizes: SIZES, captures: report }, null, 2))
  } catch (error) {
    await page.screenshot({ path: join(SHOTS, 'failure.png') }).catch(() => undefined)
    console.error('Sidecar renderer errors:', errors)
    console.error('Sidecar DOM:', await page.locator('body').innerText().catch(() => 'unavailable'))
    console.error('Sidecar layout:', await page.locator('.tools-panel').evaluate(element => {
      return [element, element.parentElement, element.parentElement?.parentElement, element.querySelector('.tools-panel__sheet')].map(item => {
        if (!item) return null
        const rect = item.getBoundingClientRect(), css = getComputedStyle(item)
        return { class: item.className, rect: rect.toJSON(), display: css.display, width: css.width, height: css.height, position: css.position, visibility: css.visibility }
      })
    }).catch(() => []))
    throw error
  } finally {
    await closeSotto(launched)
    await new Promise<void>(done => server.close(() => done()))
  }
})
