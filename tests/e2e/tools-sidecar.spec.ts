import { execFile, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { AgentActivity, ObservedAgent } from '../../src/shared/agentActivity'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { terminalOutput } from './support/terminal'

// Real Electron shell, native browser, PTY, files and Git. Only coding providers use E2E fixtures.
// Every file and shell command below belongs to the launch helper's disposable profile. Captures go to a
// generated folder; the verification note's images are copied from it into artifacts/tools-rail.
const run = promisify(execFile)
const SHOTS = resolve(process.cwd(), 'artifacts/tools-rail-run')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const MODES = ['dark', 'light'] as const
const TOOLS = ['Browser', 'Terminal', 'Files', 'Changes', 'Agents'] as const
/** Changes' Git scopes, each captured through the whole matrix. */
const GIT_SCOPES = ['working', 'branch'] as const
type Tool = typeof TOOLS[number]
type Width = 'normal' | 'minimum' | 'wide'
const MIN_WIDTH = 380
const STEP = 24
/** Wide enough that Files and Changes sit side by side at every window size (content of at least 640px). */
const WIDE_STEPS = 17

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

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined)))
  })
}

async function browserBounds(launched: LaunchedSotto, url: string): Promise<Electron.Rectangle> {
  await settle(launched.page)
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
  const title = `Sotto Tools rail review ${name}`
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

/** The rail, the surface's line of chrome and the footer, measured against the window and its own controls. */
async function railLayout(panel: Locator): Promise<{
  sheet: { x: number; width: number }; main: number; overflow: number; chromeHeight: number; chromeUnderControls: number
  railBottom: number; footBottom: number; tileTop: number; controlsBottom: number; height: number; stacked: boolean | null
  detailStubs: string[]
}> {
  return panel.evaluate(element => {
    const box = (node: Element | null) => node?.getBoundingClientRect() ?? null
    const sheet = box(element.querySelector('.tools-panel__sheet'))!
    const main = element.querySelector<HTMLElement>('.tools-panel__main')!
    const chrome = element.querySelector('.tools-chrome')!
    const controls = box(document.querySelector('.threads-view__winctl'))
    const overlaps = (rect: DOMRect) => controls !== null && rect.right > controls.left && rect.left < controls.right && rect.bottom > controls.top && rect.top < controls.bottom
    const underControls = [...chrome.querySelectorAll('button, input, select, [role="tab"]')].filter(control => overlaps(control.getBoundingClientRect())).length
    const list = box(element.querySelector('.files-surface[data-preview] > .files-tree, .changes-review[data-tree] > .changes-tree'))
    const detail = box(element.querySelector('.files-surface[data-preview] > .files-preview, .changes-review[data-tree] > .changes-files'))
    return {
      sheet: { x: sheet.x, width: sheet.width },
      main: main.clientWidth,
      overflow: main.scrollWidth - main.clientWidth,
      chromeHeight: chrome.getBoundingClientRect().height,
      chromeUnderControls: underControls,
      railBottom: box(element.querySelector('.tools-rail'))!.bottom,
      footBottom: box(element.querySelector('.tools-rail__foot'))!.bottom,
      tileTop: box(element.querySelector('.tools-rail__tab'))!.top,
      controlsBottom: controls?.bottom ?? 0,
      height: innerHeight,
      stacked: list && detail ? list.bottom <= detail.top + 1 : null,
      // A fact beside a title shows as a readable run (six characters, about 40px) or drops out of the line whole.
      detailStubs: [...element.querySelectorAll('.tools-chrome__lead')].flatMap(lead => {
        const fact = lead.querySelector('.tools-chrome__detail')
        if (!fact) return []
        const shown = fact.getBoundingClientRect(), line = lead.getBoundingClientRect()
        return shown.top < line.bottom && shown.width < 40 ? [fact.textContent ?? ''] : []
      }),
    }
  })
}

/**
 * Lowest text contrast in the panel's chrome, on whatever it sits on: the rail's words, the line of chrome (its
 * title and fact, page and shell tabs, worded actions) and the footer (the working copy, and the pinned thread
 * and its tag while pinned). Each text is painted over every background between it and the sheet.
 */
async function chromeContrast(panel: Locator): Promise<{ lowest: number; name: string }> {
  return panel.evaluate(element => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1
    const context = canvas.getContext('2d')!
    const paint = (colors: string[]): number[] => { context.clearRect(0, 0, 1, 1); for (const color of colors) { context.fillStyle = color; context.fillRect(0, 0, 1, 1) } return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3) }
    const luminance = (rgb: number[]): number => rgb.map(value => { const n = value / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4 }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0)
    const sheet = element.querySelector('.tools-panel__sheet')!
    const texts = [
      '.tools-rail__tab', '.tools-chrome__title', '.tools-chrome__detail', '.tools-chrome .terminal-tabs__tab', '.tools-chrome__button:not(:disabled)',
      '.tools-panel__copy', '.tools-panel__branch', '.tools-panel__label', '.tools-panel__foot', '.tools-panel__pinned-owner .tools-panel__thread-title', '.tools-panel__tag',
      '.changes-scope__select', '.changes-counts__add', '.changes-counts__remove', '.changes-bar__fact', '.changes-base__head', '.changes-base__value', '.changes-file__base', '.changes-file__folder',
    ].join(', ')
    const ratios = [...element.querySelectorAll(texts)].map(node => {
      const layers: string[] = []
      for (let at: Element | null = node; at && at !== sheet.parentElement; at = at.parentElement) {
        const color = getComputedStyle(at).backgroundColor
        if (color !== 'rgba(0, 0, 0, 0)') layers.unshift(color)
      }
      const base = luminance(paint(layers))
      const text = luminance(paint([...layers, getComputedStyle(node).color]))
      return { ratio: (Math.max(base, text) + .05) / (Math.min(base, text) + .05), name: `${node.className}: ${node.textContent}` }
    })
    const lowest = ratios.reduce((low, item) => item.ratio < low.ratio ? item : low)
    return { lowest: lowest.ratio, name: lowest.name }
  })
}

/**
 * Motion inside the panel that reduced motion should have stopped, named for the failure message. The setting
 * shortens every transition and animation to 1ms rather than removing it, so only longer or endless ones count.
 */
async function runningAnimations(panel: Locator): Promise<string[]> {
  return panel.evaluate(element => document.getAnimations().filter(animation => {
    const target = (animation.effect as KeyframeEffect | null)?.target
    const timing = animation.effect?.getComputedTiming()
    const moving = timing !== undefined && (timing.iterations === Infinity || Number(timing.duration) > 1)
    return animation.playState === 'running' && moving && target instanceof Element && element.contains(target)
  }).map(animation => {
    const effect = animation.effect as KeyframeEffect
    const name = animation instanceof CSSAnimation ? animation.animationName : animation instanceof CSSTransition ? `transition ${animation.transitionProperty}` : 'script'
    return `${name} on ${effect.target instanceof Element ? effect.target.getAttribute('class') : ''}${effect.pseudoElement ?? ''}`
  }))
}

const PREVIEW = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fieldnotes</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f1e8;color:#273e34;font:15px system-ui}header{padding:20px 24px;border-bottom:1px solid #dedfd2;display:flex;justify-content:space-between}nav{font-size:13px}main{padding:30px 24px;display:grid;grid-template-columns:1fr 1fr;gap:22px;align-items:center}small{font-size:10px;letter-spacing:.12em}h1{font-weight:500;letter-spacing:-.05em;font-size:clamp(30px,4.5vw,54px);line-height:1.03;margin:18px 0}p{color:#677167;line-height:1.6}button{border:0;border-radius:4px;background:#304f3d;color:white;padding:12px 18px;font:inherit}.landscape{min-height:260px;background:linear-gradient(150deg,#dbe0d0 35%,#a7b8a0 35%,#a7b8a0 57%,#688a73 57%,#688a73 76%,#294b3e 76%);display:flex;align-items:end;padding:18px;color:white}.caption{padding:24px;border-top:1px solid #dedfd2}@media(max-width:450px){main{grid-template-columns:1fr}.landscape{min-height:160px}h1{font-size:42px}}
</style></head><body><header><strong>⌁ Fieldnotes</strong><nav>Explore &nbsp; Journal</nav></header><main><section><small>LESS SCROLLING. MORE WANDERING.</small><h1>A little more outside.</h1><p>Good trails. Quiet places. A reason to take the long way home.</p><button onclick="document.querySelector('h1').textContent='Find your next trail.'">Find a trail →</button></section><div class="landscape">The Pacific Northwest</div></main><div class="caption"><strong>Start somewhere close.</strong><p>Your next favorite place might be just around the bend.</p></div></body></html>`

const AGENTS: ObservedAgent[] = [
  { id: 'claude:review', assignmentId: 'task-review', title: 'Review the diff for standards', description: 'Check the change against the brief.', prompt: 'Review the working copy against AGENTS.md.', model: 'Claude Opus 5.5', status: 'running' },
  { id: 'claude:refute', assignmentId: 'task-refute', title: 'Refute: the page keeps its place', description: 'Try to break the retained browser page.', prompt: 'Look for a way the page loses its place.', model: 'Claude Opus 5.5', status: 'running' },
  { id: 'claude:mark', assignmentId: 'task-mark', title: 'Find the landing page mark', description: 'Locate the logo files.', prompt: 'Find the mark used on the landing page.', model: 'Claude Sonnet 4.6', status: 'completed', durationMs: 71_000 },
]

test('The Tools rail keeps every surface usable at three window sizes and three panel widths, dark and light', async () => {
  test.skip(process.platform !== 'win32', 'Windows native PTY and window composition acceptance')
  test.setTimeout(900_000)
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
      // The renderer names a thread by its host's key (`host:<host>:<id>`); main and the fixture use the bare ID.
      const thread = state.host.threads.find(item => item.id === (state.hostId === undefined ? 'workshop' : `host:${state.hostId}:workshop`))!
      return state.host.projects.find(project => project.id === thread.projectId)!.path
    })
    expect(folder.startsWith(launched.userData)).toBe(true)
    await mkdir(join(folder, 'src'), { recursive: true })
    const git = (args: string[]) => run('git', args, { cwd: folder, windowsHide: true, timeout: 15_000 })
    await git(['init', '--quiet', '-b', 'main'])
    await writeFile(join(folder, 'src/app.ts'), "export function greet(name: string): string {\n  return 'Hello ' + name\n}\n")
    await writeFile(join(folder, 'src/styles.css'), 'body { background: white; color: black; }\n')
    await writeFile(join(folder, 'README.md'), '# Fieldnotes\n\nFind your next trail.\n')
    await git(['add', '.'])
    const commit = (message: string) => git(['-c', 'user.name=Sotto verification', '-c', 'user.email=verification@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', message])
    await commit('Owned Tools fixture')
    await git(['switch', '--quiet', '-c', 'feature/warmer'])
    await writeFile(join(folder, 'src/trail.ts'), "export const trail = 'Start somewhere close.'\n")
    await git(['add', '.'])
    await commit('Add the trail line')
    await writeFile(join(folder, 'src/app.ts'), 'export function greet(name: string): string {\n  return `Hello, ${name}!`\n}\n\nexport const version = 2\n')
    await writeFile(join(folder, 'src/styles.css'), 'body { background: #f3f1e8; color: #273e34; }\n')
    await writeFile(join(folder, 'CHANGELOG.md'), '# Changes\n\n- Warmer colors and a friendlier greeting.\n')
    const startedAt = new Date(Date.now() - 240_000).toISOString()
    await page.evaluate(async ({ url, agents, startedAt }) => {
      const observedAt = new Date().toISOString()
      await window.sottoE2E!.agentEvent!({
        type: 'ready', threadId: 'workshop', status: 'idle', text: `The landing page has a warmer palette and more room to breathe. Review the changes and [open the preview](${url}).`,
        activities: agents.map((agent, sequence): AgentActivity => ({ id: `spawn-${agent.assignmentId}`, turnId: 'turn-agents', sequence, kind: 'subagent', title: 'Spawn agent', status: 'completed', agents: [{ ...agent, startedAt, observedAt }] })),
      })
    }, { url, agents: AGENTS, startedAt })
    // The onboarding decision is taken at app mount; reload the owned profile after completing fixture setup.
    await page.reload()
    await resize(launched, 1280, 800)
    await openThreads(page)
    await page.evaluate(() => document.fonts.ready)
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    const toggle = page.getByRole('button', { name: 'Tools', exact: true })
    await toggle.click()
    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    const sheet = panel.locator('.tools-panel__sheet')
    const rail = panel.getByRole('tablist', { name: 'Tools', exact: true })
    const tab = (tool: Tool) => rail.getByRole('tab', { name: tool, exact: true })
    const select = async (tool: Tool): Promise<void> => { await tab(tool).click(); await expect(tab(tool)).toHaveAttribute('aria-selected', 'true') }
    const separator = panel.getByRole('separator', { name: 'Resize tools panel', exact: true })
    const changesScope = async (scope: typeof GIT_SCOPES[number]): Promise<void> => {
      await panel.getByRole('combobox', { name: 'Diff scope' }).selectOption(scope)
      if (scope === 'working') await expect(panel.getByRole('group', { name: 'src/app.ts' })).toContainText('export const version = 2')
      else {
        await expect(panel.getByRole('group', { name: 'src/trail.ts' })).toContainText('Start somewhere close.')
        await expect(panel.getByRole('button', { name: 'Change the base. Comparing feature/warmer with main, chosen automatically', exact: true })).toBeVisible()
      }
    }

    // Opening lands on the rail; the keyboard walks the rail, then its foot, then the surface's line of chrome.
    await expect(rail).toHaveAttribute('aria-orientation', 'vertical')
    await expect(tab('Files')).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(tab('Changes')).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(tab('Files')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(panel.getByRole('button', { name: 'Pin to Workshop', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(panel.getByRole('button', { name: 'Expand tools panel', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(panel.getByRole('button', { name: 'Close tools panel', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(panel.getByRole('button', { name: 'Refresh files', exact: true })).toBeFocused()
    // Working agents put a dot on Agents; the tab says so in words.
    await expect(tab('Agents')).toHaveAttribute('aria-description', '2 agents are working')
    await expect(tab('Agents').locator('.tools-rail__live')).toBeVisible()

    await panel.getByRole('treeitem', { name: 'src', exact: true }).click()
    await panel.getByRole('treeitem', { name: 'app.ts', exact: true }).click()
    await expect(panel.locator('.files-preview__text')).toContainText('export const version = 2')
    await expect(panel.locator('.files-preview__meta')).toContainText('Read only')
    await select('Changes')
    await expect(panel.getByRole('group', { name: 'src/app.ts' })).toContainText('return `Hello, ${name}!`')
    await expect(tab('Changes')).toHaveAttribute('aria-description', '3 changed files')
    // The file tree stays open through the matrix, so its place beside or above the files is measured too.
    await panel.getByRole('button', { name: 'Show file tree', exact: true }).click()
    await select('Terminal')
    await panel.getByRole('button', { name: 'Start terminal' }).click()
    await expect(panel.locator('.xterm-screen')).toBeVisible()
    await expect(panel.locator('.xterm-screen canvas:not(.xterm-link-layer)')).toBeVisible()
    await panel.locator('.xterm').click()
    await page.keyboard.type('echo SOTTO_RAIL_NATIVE_OK')
    await page.keyboard.press('Enter')
    await expect.poll(async () => ((await terminalOutput(page)).match(/SOTTO_RAIL_NATIVE_OK/gu) ?? []).length).toBeGreaterThanOrEqual(2)
    await page.keyboard.type('echo Rail > rail-proof.txt')
    await page.keyboard.press('Enter')
    await expect.poll(() => readFile(join(folder, 'rail-proof.txt'), 'utf16le').catch(() => '')).toContain('Rail')
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

    const setWidth = async (width: Width): Promise<void> => {
      const measured = await page.locator('.thread-workspace__body').evaluate(element => element.clientWidth)
      const target = width === 'minimum' ? MIN_WIDTH : width === 'wide' ? MIN_WIDTH + WIDE_STEPS * STEP : Math.min(1200, Math.max(MIN_WIDTH, measured * .56))
      await separator.focus()
      await page.keyboard.press('Home')
      for (let step = 0; step < Math.round((target - MIN_WIDTH) / STEP); step++) {
        await page.keyboard.press('ArrowLeft')
        await expect(separator, `resize handle keeps focus at step ${step} toward ${width}`).toBeFocused()
      }
      await page.mouse.move(4, 400)
    }

    for (const [width, height] of SIZES) {
      await resize(launched, width, height)
      if (width === 820) await expect(page.locator('.threads-view > .thread-nav')).toBeHidden()
      for (const panelWidth of ['normal', 'minimum', 'wide'] as const) {
        await setWidth(panelWidth)
        for (const mode of MODES) {
          await appearance(page, mode)
          const contrast = await chromeContrast(panel)
          expect(contrast.lowest, `${width}x${height} ${panelWidth} ${mode} chrome contrast, lowest on ${contrast.name}`).toBeGreaterThanOrEqual(4.5)
          expect(await rail.evaluate(element => [...element.querySelectorAll('.tools-rail__word')].filter(word => word.scrollWidth > word.clientWidth).map(word => word.textContent)), 'rail words cut short').toEqual([])
          expect(await panel.evaluate(element => [...element.querySelectorAll('.tools-rail button, .tools-panel__foot button')]
            .filter(control => control.scrollWidth > control.clientWidth + 1 || control.scrollHeight > control.clientHeight + 1).map(control => control.getAttribute('aria-label') ?? control.textContent)), 'rail and footer controls clipped').toEqual([])
          for (const [tool, scope] of TOOLS.flatMap((tool): [Tool, typeof GIT_SCOPES[number] | null][] => tool === 'Changes' ? GIT_SCOPES.map(scope => [tool, scope]) : [[tool, null]])) {
            await select(tool)
            if (scope !== null) await changesScope(scope)
            const key = `${tool.toLowerCase()}${scope === null ? '' : `-${scope}`}-${width}x${height}-${panelWidth}-${mode}`
            await expect(sheet).toBeVisible()
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), key).toBe(true)
            const layout = await railLayout(panel)
            expect(layout.sheet.x, key).toBeGreaterThanOrEqual(0)
            expect(layout.sheet.x + layout.sheet.width, key).toBeLessThanOrEqual(width + 1)
            expect(layout.overflow, `${key} horizontal overflow`).toBeLessThanOrEqual(1)
            expect(layout.chromeUnderControls, `${key} chrome under the window controls`).toBe(0)
            expect(layout.tileTop, `${key} rail under the window controls`).toBeGreaterThanOrEqual(layout.controlsBottom)
            expect(layout.footBottom, `${key} rail foot clipped`).toBeLessThanOrEqual(height)
            expect(layout.chromeHeight, `${key} one line of chrome`).toBeLessThanOrEqual(46)
            expect(layout.detailStubs, `${key} a fact in the line of chrome cut to a stub`).toEqual([])
            expect(await panel.evaluate(element => [...element.querySelectorAll('.tools-chrome button:not([role="tab"]), .files-preview__head button, .changes-bar button, .changes-file__head button.files-icon')]
              .filter(control => control.scrollWidth > control.clientWidth + 1).map(control => control.getAttribute('aria-label') ?? control.textContent)), `${key} line and head controls clipped`).toEqual([])
            if (tool === 'Files' || tool === 'Changes') expect(layout.stacked, `${key} list and detail`).toBe(layout.main < 640)
            const native = tool === 'Browser'
            const nativeBounds = native ? await browserBounds(launched, url) : null
            if (!native) await expect.poll(async () => (await nativeViews(launched)).length).toBe(0)
            if (tool === 'Terminal') {
              await expect(panel.locator('.xterm-screen canvas:not(.xterm-link-layer)')).toBeVisible()
              await expect.poll(() => terminalOutput(page)).toContain('SOTTO_RAIL_NATIVE_OK')
            }
            if (tool === 'Files') await expect(panel.locator('.files-preview__text')).toContainText('export const version = 2')
            if (tool === 'Agents') await expect(panel.locator('.subagent-item')).toHaveCount(3)
            await screenshot(launched, key, native)
            report[key] = { layout, nativeBounds, mode: await panel.getAttribute('data-mode') }
          }
        }
      }
    }

    await resize(launched, 1280, 800)
    await setWidth('normal')
    await appearance(page, 'dark')
    await select('Changes')
    await changesScope('working')
    const app = panel.getByRole('group', { name: 'src/app.ts' })
    await panel.getByRole('button', { name: 'Split diff view', exact: true }).click()
    await expect(app.locator('.changes-diff__rows')).toHaveAttribute('data-layout', 'split')
    await expect(app.locator('.changes-split__cell[data-kind="add"]')).toContainText(['return `Hello, ${name}!`', '', 'export const version = 2'])
    await screenshot(launched, 'changes-split-1280-dark', false)
    await panel.getByRole('button', { name: 'Stacked diff view', exact: true }).click()
    // The shortcut: mod+d closes Tools while it shows Changes and opens it on Changes again (the fixture's hotkey is not mod+d).
    await tab('Changes').focus()
    await page.keyboard.press('Control+d')
    await expect(panel).toBeHidden()
    await expect(toggle).toBeFocused()
    await page.keyboard.press('Control+d')
    await expect(tab('Changes')).toHaveAttribute('aria-selected', 'true')
    await expect(tab('Changes')).toBeFocused()
    await select('Browser')
    await panel.getByRole('button', { name: 'Pin to Workshop', exact: true }).click()
    await expect(panel.locator('.tools-panel__pinned-owner')).toHaveText('WorkshopPinned')
    // The pinned footer (the thread's name and its Pinned tag) meets the same bar in both appearances.
    for (const mode of MODES) {
      await appearance(page, mode)
      const pinnedContrast = await chromeContrast(panel)
      expect(pinnedContrast.lowest, `pinned ${mode} chrome contrast, lowest on ${pinnedContrast.name}`).toBeGreaterThanOrEqual(4.5)
    }
    await appearance(page, 'dark')
    await screenshot(launched, 'browser-pinned-1280-dark', true)
    await panel.getByRole('button', { name: 'Unpin from Workshop', exact: true }).click()
    const initial = await browserBounds(launched, url)
    await panel.getByRole('button', { name: 'Expand tools panel', exact: true }).click()
    await expect.poll(async () => (await browserBounds(launched, url)).width).toBeGreaterThan(initial.width)
    await screenshot(launched, 'browser-expanded-1280-dark', true)
    await panel.getByRole('button', { name: 'Restore tools panel', exact: true }).click()
    await expect.poll(async () => (await browserBounds(launched, url)).width).toBe(initial.width)
    await separator.focus()
    await page.keyboard.press('ArrowLeft')
    await expect.poll(async () => (await browserBounds(launched, url)).width).toBeGreaterThan(initial.width)
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await browserBounds(launched, url)).width).toBe(initial.width)
    // A wide panel overlays the panes at this size, and Escape closes the overlay back to the toggle.
    await setWidth('wide')
    await expect(panel).toHaveAttribute('data-mode', 'overlay')
    await select('Files')
    await tab('Files').focus()
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    await expect(toggle).toBeFocused()
    await toggle.click()
    await setWidth('normal')
    await select('Browser')
    await resize(launched, 820, 560)
    await setWidth('normal')
    await expect(panel).toHaveAttribute('data-mode', 'docked')
    const compact = await browserBounds(launched, url)
    await panel.getByRole('button', { name: 'Expand tools panel', exact: true }).click()
    await expect.poll(async () => (await browserBounds(launched, url)).width).toBeGreaterThan(compact.width)
    await screenshot(launched, 'browser-expanded-820-dark', true)
    await panel.getByRole('button', { name: 'Restore tools panel', exact: true }).click()
    await expect.poll(async () => (await browserBounds(launched, url)).width).toBe(compact.width)
    await panel.getByRole('button', { name: 'Close tools panel', exact: true }).click()
    await expect(page.locator('.threads-view > .thread-nav')).toBeVisible()
    await expect(page.locator('.thread-workspace__tools')).toBeHidden()
    await expect(toggle).toBeFocused()
    await toggle.click()
    await expect(page.locator('.threads-view > .thread-nav')).toBeHidden()
    await browserBounds(launched, url)
    await resize(launched, 1280, 800)
    await panel.getByRole('button', { name: 'Close tools panel', exact: true }).click()
    await expect(panel).toBeHidden()
    await expect.poll(async () => (await nativeViews(launched)).length).toBe(0)
    await toggle.click()
    await browserBounds(launched, url)

    // Reduced motion: the panel arrives without animating and nothing on any surface keeps moving.
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'on' }))
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
    await panel.getByRole('button', { name: 'Close tools panel', exact: true }).click()
    await toggle.click()
    expect(await sheet.evaluate(element => getComputedStyle(element).animationName)).toBe('none')
    for (const tool of TOOLS) {
      await select(tool)
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
      expect(await runningAnimations(panel), `${tool} animations with reduced motion`).toEqual([])
      if (tool === 'Terminal') await expect.poll(() => terminalOutput(page)).toContain('SOTTO_RAIL_NATIVE_OK')
    }
    await screenshot(launched, 'agents-reduced-motion-1280-dark', false)

    // A browser task waiting on another surface puts the corner preview up while Tools shows Files; it stands
    // inside the rail rather than over its lower tiles.
    await select('Files')
    // The request waits for an answer; a teardown that closes the page first must not hide the failure that caused it.
    const opening = page.evaluate(async request => window.sottoE2E!.browserAgent!(request), { threadId: 'workshop', name: 'browser_open', arguments: { url, description: 'Checking the trail list' } })
      .catch((error: unknown) => ({ failed: String(error) }))
    const corner = page.getByRole('complementary', { name: 'Browser preview for Workshop' })
    for (const [width, height] of [[1280, 800], [820, 560]] as const) {
      await resize(launched, width, height)
      await expect(corner).toBeVisible()
      await expect(corner).toContainText('Waiting for your permission')
      await expect(tab('Browser')).toHaveAttribute('aria-description', 'A browser request is waiting for your answer')
      expect(await page.evaluate(() => {
        const preview = document.querySelector('.browser-corner')!.getBoundingClientRect()
        return [...document.querySelectorAll('.tools-rail__tab, .tools-rail__foot button')].filter(control => {
          const box = control.getBoundingClientRect()
          return box.left < preview.right && box.right > preview.left && box.top < preview.bottom && box.bottom > preview.top
        }).map(control => control.getAttribute('aria-label') ?? control.textContent)
      }), `${width}x${height} rail under the corner preview`).toEqual([])
      await screenshot(launched, `corner-preview-files-${width}x${height}-dark`, false)
    }
    await page.evaluate(async () => {
      const listed = await window.sotto!.browser!.tasks({ threadId: 'workshop' })
      const task = listed.ok ? listed.value.find(item => item.pendingAction) : undefined
      if (!task) throw new Error('No waiting request')
      await window.sotto!.browser!.answerAction({ threadId: 'workshop', workspaceId: task.workspaceId, pageId: task.pageId, taskId: task.id, actionId: task.pendingAction!.id, allow: false })
    })
    await opening
    expect(errors).toEqual([])
    await writeFile(join(SHOTS, 'layout.json'), JSON.stringify({ errors, sizes: SIZES, captures: report }, null, 2))
  } catch (error) {
    await page.screenshot({ path: join(SHOTS, 'failure.png') }).catch(() => undefined)
    console.error('Tools rail renderer errors:', errors)
    console.error('Tools rail layout:', await page.locator('.tools-panel').evaluate(element => {
      return [element, element.parentElement, element.querySelector('.tools-panel__sheet'), element.querySelector('.tools-rail'), element.querySelector('.tools-panel__main')].map(item => {
        if (!item) return null
        const rect = item.getBoundingClientRect(), css = getComputedStyle(item)
        return { class: item.className, rect: rect.toJSON(), display: css.display, width: css.width, height: css.height, position: css.position }
      })
    }).catch(() => []))
    throw error
  } finally {
    await closeSotto(launched)
    await new Promise<void>(done => server.close(() => done()))
  }
})

/**
 * Changes' four scopes, T3's: Working tree, Branch changes against its automatic base, Latest turn and Turn N from
 * Sotto's checkpoints, including a turn whose checkpoint is unavailable. Each is captured at the three window sizes
 * in both appearances; nothing clips and the page never scrolls sideways.
 */
test('Changes reads every scope, turns from checkpoints, at three window sizes, dark and light', async () => {
  test.setTimeout(600_000)
  await mkdir(SHOTS, { recursive: true })
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-changes-scopes-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark' }))
  const repo = join(profile, 'scopes-repo')
  await mkdir(join(repo, 'src'), { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true })
  git('init', '-q', '-b', 'main'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Sotto verification'); git('config', 'user.email', 'verification@example.invalid'); git('config', 'commit.gpgSign', 'false')
  await writeFile(join(repo, 'src/app.ts'), "export function greet(name: string): string {\n  return 'Hello ' + name\n}\n")
  await writeFile(join(repo, 'README.md'), '# Fieldnotes\n\nFind your next trail.\n')
  git('add', '.'); git('commit', '-qm', 'Owned scopes fixture')
  git('switch', '-q', '-c', 'feature/scopes')
  await writeFile(join(repo, 'src/trail.ts'), "export const trail = 'Start somewhere close.'\n")
  git('add', '.'); git('commit', '-qm', 'Add the trail line')
  const launched = await launchSotto('phase3-workspace', profile)
  const { page } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    const threadId = await page.evaluate(async repo => {
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await agents.command({ type: 'connect' })
      const created = await agents.command({ type: 'create-project', title: 'Scopes project', path: repo, useExisting: true })
      const projectId = created.host.projects.find(project => project.title === 'Scopes project')!.id
      const state = await agents.command({ type: 'create-thread', projectId, title: 'Scopes review', modelId: 'codex:gpt', managed: false, workingCopy: 'shared' })
      if (!state.activeThreadId || state.error) throw new Error(state.error ?? 'No selected thread')
      return state.activeThreadId
    }, repo)
    const checkpointStates = () => page.evaluate(async threadId => {
      const result = await window.sotto!.gitChanges!.checkpoints!({ threadId })
      return result.ok ? result.value.checkpoints.map(checkpoint => checkpoint.status) : [result.error.message]
    }, threadId)
    // Three turns, each editing files while the thread works. The first also stages a file, so its checkpoint is unavailable.
    const turns: [string, () => Promise<void>][] = [
      ['Note where the trail starts.', async () => { await writeFile(join(repo, 'notes.txt'), 'Trailhead by the old mill.\n'); git('add', 'notes.txt') }],
      ['Make the greeting friendlier.', async () => { await writeFile(join(repo, 'src/app.ts'), 'export function greet(name: string): string {\n  return `Hello, ${name}!`\n}\n') }],
      ['Say more in the README.', async () => { await writeFile(join(repo, 'README.md'), '# Fieldnotes\n\nFind your next trail.\n\nLess scrolling. More wandering.\n') }],
    ]
    for (const [index, [text, edit]] of turns.entries()) {
      await page.evaluate(async ({ threadId, text }) => { await window.sotto!.agents!.command({ type: 'manual-send', threadId, text }) }, { threadId, text })
      await expect.poll(() => page.evaluate(async id => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === id)?.status, threadId)).toBe('running')
      await edit()
      await page.evaluate(async threadId => window.sottoE2E!.agentEvent!({ type: 'ready', threadId, status: 'idle', text: 'Done.' }), threadId)
      await expect.poll(async () => (await checkpointStates()).length).toBe(index + 1)
      await expect.poll(async () => (await checkpointStates())[0]).toBe(index === 0 ? 'unavailable' : 'ready')
    }
    await openThreads(page)
    await page.evaluate(() => document.fonts.ready)
    await page.getByRole('button', { name: 'Scopes review', exact: true }).first().click()
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    await panel.getByRole('tab', { name: 'Changes', exact: true }).click()
    const scope = panel.getByRole('combobox', { name: 'Diff scope' })
    await expect(scope.locator('option')).toHaveText(['Working tree', 'Branch changes', 'Latest turn', 'Turn 3', 'Turn 2', 'Turn 1 (unavailable)'])
    const scopes: { readonly key: string; readonly pick: { label: string }; readonly shows: () => Promise<void> }[] = [
      { key: 'working', pick: { label: 'Working tree' }, shows: async () => {
        await expect(panel.getByRole('group', { name: 'src/app.ts' })).toContainText('return `Hello, ${name}!`')
        await expect(panel.getByRole('group', { name: 'notes.txt' })).toContainText('Trailhead by the old mill.')
      } },
      { key: 'branch', pick: { label: 'Branch changes' }, shows: async () => {
        await expect(panel.getByRole('group', { name: 'src/trail.ts' })).toContainText('Start somewhere close.')
        await expect(panel.locator('.changes-file')).toHaveCount(1)
        await expect(panel.getByRole('button', { name: 'Change the base. Comparing feature/scopes with main, chosen automatically', exact: true })).toBeVisible()
      } },
      { key: 'latest-turn', pick: { label: 'Latest turn' }, shows: async () => {
        await expect(panel.getByRole('group', { name: 'README.md' })).toContainText('Less scrolling. More wandering.')
        await expect(panel.locator('.changes-file')).toHaveCount(1)
      } },
      { key: 'turn-2', pick: { label: 'Turn 2' }, shows: async () => {
        await expect(panel.getByRole('group', { name: 'src/app.ts' })).toContainText('return `Hello, ${name}!`')
        await expect(panel.locator('.changes-file')).toHaveCount(1)
      } },
      { key: 'turn-1-unavailable', pick: { label: 'Turn 1 (unavailable)' }, shows: async () => {
        await expect(panel.getByRole('status').filter({ hasText: 'Turn 1’s checkpoint is unavailable, so its changes cannot be shown.' })).toBeVisible()
        await expect(panel.locator('.changes-file')).toHaveCount(0)
      } },
    ]
    for (const [width, height] of SIZES) {
      await resize(launched, width, height)
      for (const mode of MODES) {
        await appearance(page, mode)
        for (const item of scopes) {
          await scope.selectOption(item.pick)
          await item.shows()
          const key = `changes-scope-${item.key}-${width}x${height}-${mode}`
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), key).toBe(true)
          expect(await panel.evaluate(element => { const main = element.querySelector<HTMLElement>('.tools-panel__main')!; return main.scrollWidth - main.clientWidth }), `${key} horizontal overflow`).toBeLessThanOrEqual(1)
          expect(await panel.evaluate(element => [...element.querySelectorAll('.tools-chrome button:not([role="tab"]), .changes-bar button, .changes-file__head button.files-icon')]
            .filter(control => control.scrollWidth > control.clientWidth + 1 || control.scrollHeight > control.clientHeight + 1).map(control => control.getAttribute('aria-label') ?? control.textContent)), `${key} controls clipped`).toEqual([])
          expect(await panel.locator('.tools-chrome').first().evaluate(element => element.getBoundingClientRect().height), `${key} one line of chrome`).toBeLessThanOrEqual(46)
          // The comparison's totals show at every size: on the line of chrome, or at the head of the view bar in a narrow panel.
          if (item.key !== 'turn-1-unavailable') await expect(panel.locator('.changes-counts:not(.changes-counts--file)').filter({ visible: true }), `${key} totals`).toHaveCount(1)
          await screenshot(launched, key, false)
        }
      }
    }
    expect(errors).toEqual([])
  } catch (error) {
    await page.screenshot({ path: join(SHOTS, 'changes-scopes-failure.png') }).catch(() => undefined)
    throw error
  } finally {
    await closeSotto(launched)
  }
})
