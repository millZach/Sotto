import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

// Real Windows Electron renders of the rich message components inside the Threads layout classes.
// The fixture is built per worktree into test-results/rich-messages-fixture; the Threads page wiring is checked by the workspace lane.
const shots = resolve(process.cwd(), 'artifacts/rich-messages')

interface FixtureRecord { opened: string[]; navigations: string[]; popups: string[] }
declare global { interface Window { richFixture?: { stream: (text: string, streaming: boolean) => void } } }
interface Launched { app: ElectronApplication; page: Page }

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--config', 'tests/fixtures/richMessages/vite.config.mjs'], { stdio: 'inherit' })
  await mkdir(shots, { recursive: true })
})

async function launch(options: { width?: number; height?: number; scale?: string } = {}): Promise<Launched> {
  const env = Object.fromEntries(Object.entries({
    ...process.env,
    SOTTO_RICH_FIXTURE: '1',
    SOTTO_RICH_FIXTURE_WIDTH: String(options.width ?? 1080),
    SOTTO_RICH_FIXTURE_HEIGHT: String(options.height ?? 720),
    SOTTO_RICH_FIXTURE_SCALE: options.scale,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const app = await electron.launch({ args: [resolve('tests/fixtures/richMessages/electronMain.cjs')], env })
  const page = await app.firstWindow()
  await page.waitForLoadState('load')
  await page.evaluate(() => document.fonts.ready)
  await expect(page.getByRole('img', { name: 'help-page-404.png' })).toBeVisible()
  await expect.poll(() => page.getByRole('img', { name: 'help-page-404.png' }).evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  return { app, page }
}

const record = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { richFixture: FixtureRecord }).richFixture)

async function withClipboard<T>(app: ElectronApplication, run: () => Promise<T>): Promise<T> {
  const saved = await app.evaluate(({ clipboard }) => clipboard.readText())
  try { return await run() } finally { await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved) }
}

async function horizontalOverflow(page: Page) {
  return page.getByLabel('Thread transcript').evaluate(element => element.scrollWidth - element.clientWidth)
}

test('desktop render shows readable Markdown, highlighted code, tables and attachment previews', async () => {
  const { app, page } = await launch()
  try {
    const transcript = page.getByLabel('Thread transcript')
    await expect(transcript.getByRole('heading', { name: 'What changed' })).toBeVisible()
    await expect(page.getByRole('list', { name: '3 attachments' })).toContainText('help-page-404.png')
    await expect(page.getByRole('list', { name: '3 attachments' })).toContainText('PNG · 2.2 MB · Preview unavailable')
    await expect(page.getByRole('list', { name: '3 attachments' })).toContainText('PDF · 180 KB · No preview for this file type')
    await expect(page.getByRole('note')).toHaveCSS('font-size', '14px')
    await expect(transcript.locator('.rich-message').last()).toHaveCSS('font-size', '16px')
    const tileHeights = await page.locator('.rich-attachment').evaluateAll(tiles => tiles.map(tile => tile.getBoundingClientRect().height))
    expect(Math.max(...tileHeights.slice(1))).toBeLessThan(tileHeights[0]! / 2)
    await expect(page.getByText('Raw markup stays text: <img src=x onerror="alert(1)">')).toBeVisible()
    await expect(page.getByRole('img', { name: 'Image not loaded: build badge' })).toContainText('not loaded from tracker.example')
    expect(await page.locator('img').count()).toBe(1)
    expect(await page.locator('.rich-code .hljs-keyword').count()).toBeGreaterThan(3)
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
    await page.screenshot({ path: resolve(shots, 'desktop-1080-top.png') })
    await page.locator('.rich-table').scrollIntoViewIfNeeded()
    await transcript.evaluate(element => { element.scrollTop = element.querySelector('.rich-table')!.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop - 90 })
    await page.screenshot({ path: resolve(shots, 'desktop-1080-table-code.png') })
    expect((await record(app)).navigations).toEqual([])
  } finally { await app.close() }
})

test('links open through the bridge on click and Enter, and a failed open offers Copy link', async () => {
  const { app, page } = await launch()
  try {
    await page.getByRole('link', { name: 'Netlify redirect docs' }).click()
    await expect.poll(async () => (await record(app)).opened).toEqual(['https://docs.netlify.com/routing/redirects/'])
    await page.evaluate(() => window.richFixture!.stream('Status is on [the failing page](https://fail.example/status).', false))
    const failing = page.getByRole('link', { name: 'the failing page' })
    await failing.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByText('Could not open fail.example.')).toBeVisible()
    await withClipboard(app, async () => {
      await page.getByRole('button', { name: 'Copy link' }).click()
      await expect(page.getByText('Link copied')).toBeVisible()
      expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('https://fail.example/status')
    })
    const result = await record(app)
    expect(result.opened).toEqual(['https://docs.netlify.com/routing/redirects/', 'https://fail.example/status'])
    expect(result.navigations).toEqual([])
    expect(result.popups).toEqual([])
    expect(page.url()).toMatch(/rich-messages-fixture\/index\.html$/u)
  } finally { await app.close() }
})

test('keyboard reaches code copy with a visible focus ring and copies the exact code', async () => {
  const { app, page } = await launch()
  try {
    const copy = page.getByRole('button', { name: 'Copy ts code' })
    let reached = false
    for (let step = 0; step < 30 && !reached; step += 1) {
      await page.keyboard.press('Tab')
      reached = await copy.evaluate(element => element === document.activeElement)
    }
    expect(reached).toBe(true)
    await expect(copy).toHaveCSS('outline-style', 'solid')
    await withClipboard(app, async () => {
      await page.keyboard.press('Enter')
      await expect(page.locator('.rich-code__status').filter({ hasText: 'Copied' })).toBeVisible()
      const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
      expect(copied.startsWith("import { test, expect } from '@playwright/test'")).toBe(true)
      expect(copied.endsWith('})')).toBe(true)
      await copy.evaluate(element => element.closest('.rich-code')!.scrollIntoView({ block: 'center' }))
      await page.screenshot({ path: resolve(shots, 'focus-copy-code.png') })
    })
    await page.keyboard.press('Tab')
    await expect(page.getByLabel('ts code block')).toBeFocused()
    await page.keyboard.press('ArrowRight')
  } finally { await app.close() }
})

test('minimum width keeps the transcript fixed while tables and code scroll inside themselves', async () => {
  const { app, page } = await launch({ width: 760, height: 600 })
  try {
    expect(await page.evaluate(() => window.innerWidth)).toBe(760)
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
    const table = page.getByRole('region', { name: 'Table' })
    expect(await table.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
    const code = page.getByLabel('ts code block')
    expect(await code.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
    await page.screenshot({ path: resolve(shots, 'minimum-760-top.png') })
    await page.getByLabel('Thread transcript').evaluate(element => { element.scrollTop = element.querySelector('.rich-table')!.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop - 60 })
    await table.focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => table.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
    await page.screenshot({ path: resolve(shots, 'minimum-760-table-code.png') })
  } finally { await app.close() }
})

test('150% scale and reduced motion keep the streaming answer legible and still', async () => {
  const { app, page } = await launch({ width: 1080, height: 720, scale: '1.5' })
  try {
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1.5)
    const partial = 'Checking the footer now.\n\n- Found `site/partials/footer.html`\n- Updating the links to `/help`'
    await page.evaluate(text => window.richFixture!.stream(text, true), partial)
    const caretItem = page.locator('.rich-message[data-streaming] > ul > li').last()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await expect.poll(() => caretItem.evaluate(element => getComputedStyle(element, '::after').animationName)).toBe('rich-caret')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(() => caretItem.evaluate(element => getComputedStyle(element, '::after').animationName)).toBe('none')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(() => { document.documentElement.dataset.reducedMotion = 'on' })
    await expect.poll(() => caretItem.evaluate(element => getComputedStyle(element, '::after').animationName)).toBe('none')
    await expect(page.locator('.rich-message[aria-busy="true"]')).toHaveCount(1)
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
    await page.getByLabel('Thread transcript').evaluate(element => { element.scrollTop = element.scrollHeight })
    await page.screenshot({ path: resolve(shots, 'scale-150-streaming-reduced-motion.png') })
  } finally { await app.close() }
})
