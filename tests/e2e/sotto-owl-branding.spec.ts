import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

import { getReleaseTrack, releaseTrackName, type ReleaseTrack } from '../../src/shared/releaseTrack'
import { contrastRatio, parseThemeRgb } from '../../src/shared/themes/color'
import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { captureWindow } from './support/sottoCapture'
import { openPage, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'

/**
 * The built app on both release tracks: the sidebar top row on Threads and Settings, the window and document
 * titles, and the version lines in Help and Settings. Run after `npm run build`. Captures go to disposable run
 * evidence; `SOTTO_E2E_EVIDENCE=publish` writes artifacts/sotto-owl-branding.
 */
const OWL_VERSION = '0.1.35-owl.20261010.1'
const evidenceRoot = evidenceDirectory('artifacts/sotto-owl-branding')
const SIZES = [[1280, 800], [820, 560]] as const
const APPEARANCES = ['dark', 'light'] as const
const BLACK = { r: 0, g: 0, b: 0 }

interface Geometry { readonly name: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
const recorded = new Map<string, unknown>()
const geometry = new Map<string, readonly Geometry[]>()

/**
 * Electron takes an app's version from the package.json in the folder it starts, which is all packaging changes
 * for Owl; this folder points that manifest at the same built main entry with an Owl version. Its name keeps any
 * default path Electron derives from it away from Sotto's own data folder; the run's profile is the owned one.
 */
async function owlEntry(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-owl-entry-'))
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({
    name: 'sotto-owl-branding-e2e', version: OWL_VERSION, main: resolve('out/main/index.js'),
  }, null, 2)}\n`, 'utf8')
  return directory
}

async function onTrack(track: ReleaseTrack, run: () => Promise<void>): Promise<void> {
  if (track === 'stable') { await run(); return }
  const previous = process.env.SOTTO_E2E_MAIN_ENTRY
  const entry = await owlEntry()
  process.env.SOTTO_E2E_MAIN_ENTRY = entry
  try { await run() } finally {
    if (previous === undefined) delete process.env.SOTTO_E2E_MAIN_ENTRY
    else process.env.SOTTO_E2E_MAIN_ENTRY = previous
    await rm(entry, { recursive: true, force: true })
  }
}

async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0)
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
}

/** The rendered sRGB of a text element and of the opaque surface under it, composited the way the window paints it. */
async function textContrast(element: Locator): Promise<number> {
  const { text, surface } = await element.evaluate((node) => {
    const canvas = document.createElement('canvas')
    canvas.width = 1; canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    // The canvas resolves any CSS colour syntax to sRGB and keeps its alpha.
    const rgba = (value: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = 'rgba(0, 0, 0, 0)'; context.fillStyle = value; context.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
      return [r!, g!, b!, a! / 255]
    }
    const layers: Array<[number, number, number, number]> = []
    for (let current: Element | null = node; current !== null; current = current.parentElement) {
      const layer = rgba(getComputedStyle(current).backgroundColor)
      if (layer[3] > 0) layers.unshift(layer)
    }
    let base: [number, number, number] = [0, 0, 0]
    for (const [r, g, b, a] of layers) base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)]
    const [r, g, b, a] = rgba(getComputedStyle(node).color)
    const hex = (channels: readonly number[]): string => `#${channels.map(value => Math.round(value).toString(16).padStart(2, '0')).join('')}`
    return { text: hex([r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)]), surface: hex(base) }
  })
  return contrastRatio(parseThemeRgb(text, BLACK), parseThemeRgb(surface, BLACK))
}

/** Where every control in the top row and the search field sit, by accessible name. */
async function rowGeometry(page: Page, row: Locator): Promise<Geometry[]> {
  const controls = [
    ...await row.getByRole('radio').all(),
    ...await row.getByRole('button').all(),
    page.getByRole('searchbox', { name: 'Search threads' }),
  ]
  return Promise.all(controls.map(async control => {
    const box = (await control.boundingBox())!
    const name = (await control.getAttribute('aria-label')) ?? (await control.getAttribute('title')) ?? 'Search threads'
    return { name, x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
  }))
}

/** The brand at the start of the row, checked for the track, and nothing in the row clipped or overlapping it. */
async function checkBrand(row: Locator, track: ReleaseTrack): Promise<Record<string, unknown>> {
  const rowBox = (await row.boundingBox())!
  if (track === 'stable') {
    const brand = row.getByLabel('Sotto application')
    await expect(brand).toHaveText('Sotto')
    await expect(row.getByRole('img', { name: 'Sotto Owl' })).toHaveCount(0)
    return { brand: 'mark and wordmark' }
  }
  const tile = row.getByRole('img', { name: 'Sotto Owl', exact: true })
  await expect(tile).toBeVisible()
  await expect(tile).toHaveText('')
  await expect(row.getByLabel('Sotto application')).toHaveCount(0)
  const mark = tile.locator('svg')
  await expect(mark).toHaveCount(1)
  const box = (await mark.boundingBox())!
  expect(box.width).toBeCloseTo(24, 0)
  expect(box.height).toBeCloseTo(24, 0)
  // Centred in the row, inside it, and clear of the first control after it.
  expect(Math.abs(box.y + box.height / 2 - (rowBox.y + rowBox.height / 2))).toBeLessThanOrEqual(1)
  expect(box.x).toBeGreaterThanOrEqual(rowBox.x)
  // The Settings column's row carries the brand alone; the Threads sidebar's carries its toolbar after it.
  const controls = row.locator('[role="radio"], button')
  if (await controls.count() > 0) expect(box.x + box.width).toBeLessThan((await controls.first().boundingBox())!.x)
  // The tile is a picture in the drag region, never a stop in the Tab order.
  expect(await tile.evaluate(node => (node as HTMLElement).tabIndex)).toBe(-1)
  expect(await tile.evaluate(node => node.querySelector('[tabindex], a, button, input') === null)).toBe(true)
  const colours = { tile: await mark.getAttribute('data-tile'), glyph: await mark.getAttribute('data-glyph') }
  const glyphContrast = contrastRatio(parseThemeRgb(colours.tile!, BLACK), parseThemeRgb(colours.glyph!, BLACK))
  expect(glyphContrast).toBeGreaterThanOrEqual(3)
  return { brand: 'tile', size: [Math.round(box.width), Math.round(box.height)], ...colours, glyphContrast: Number(glyphContrast.toFixed(2)) }
}

async function windowTitles(launched: LaunchedSotto): Promise<{ readonly window: string; readonly document: string }> {
  const window = await launched.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/index.html'))!.getTitle())
  return { window, document: await launched.page.title() }
}

test.describe('Sotto Owl branding on the built app', () => {
  test.describe.configure({ mode: 'serial', timeout: 4 * 60_000 })

  test.beforeAll(async () => { await mkdir(evidenceRoot, { recursive: true }) })

  for (const track of ['stable', 'owl'] as const) for (const appearance of APPEARANCES) {
    test(`${track} build, ${appearance}`, async () => {
      const name = releaseTrackName(track)
      const version = track === 'owl' ? OWL_VERSION : null
      await onTrack(track, () => withSotto({ onboardingComplete: true, appearance, scenario: 'design-threads', agents: 'design-threads' }, async (launched) => {
        const { page } = launched
        const reported = await page.evaluate(async () => {
          const status = await window.sotto!.getUpdateStatus()
          return 'currentVersion' in status ? status : null
        })
        expect(reported).not.toBeNull()
        if (version !== null) expect(reported!.currentVersion).toBe(version)
        expect(getReleaseTrack(reported!.currentVersion)).toBe(track)
        expect(reported!.releaseTrack).toBe(track)

        await openThreads(page)
        await page.getByRole('button', { name: 'Visual gate flake', exact: true }).click()
        await expect(page.getByRole('button', { name: 'Allow' })).toBeVisible()
        await expect.poll(() => windowTitles(launched)).toEqual({ window: name, document: name })

        const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
        const row = sidebar.locator('.thread-nav__top')
        const result: Record<string, unknown> = { track, appearance, reportedVersion: reported!.currentVersion, titles: await windowTitles(launched) }
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height)
          await settle(page)
          result[`threads-${width}x${height}`] = await checkBrand(row, track)
          // The toolbar and search beside the brand sit exactly where the stable build puts them.
          const key = `${appearance}-${width}x${height}`, where = await rowGeometry(page, row)
          if (track === 'stable') geometry.set(key, where)
          else if (geometry.has(key)) { expect(where).toEqual(geometry.get(key)); result[`controls-${width}x${height}`] = 'same as stable' }
          await captureWindow(launched.app, resolve(evidenceRoot, `threads-${track}-${appearance}-${width}x${height}.png`))
          if (width === 1280) await row.screenshot({ path: resolve(evidenceRoot, `header-${track}-${appearance}.png`), animations: 'disabled' })
        }

        await openPage(page, 'Help')
        await expect(page.getByRole('heading', { level: 1, name: 'Help' })).toBeVisible()
        await expect(page.locator('.thread-nav__top').getByRole('img', { name: 'Sotto Owl' })).toHaveCount(track === 'owl' ? 1 : 0)
        const about = page.locator('.help-about')
        await expect(about).toContainText(`${name} ${reported!.currentVersion}, Windows. No account with Sotto and no telemetry.`)
        result.helpAbout = { text: (await about.innerText()).split('\n')[0], contrast: Number((await textContrast(about)).toFixed(2)) }
        await about.screenshot({ path: resolve(evidenceRoot, `help-about-${track}-${appearance}.png`), animations: 'disabled' })

        await openPage(page, 'Settings')
        await page.getByRole('tab', { name: 'Application' }).click()
        const updates = page.locator('.settings-update-version')
        await updates.scrollIntoViewIfNeeded()
        await expect(updates).toHaveText(`${name} ${reported!.currentVersion}`)
        result.settingsVersion = { text: await updates.innerText(), contrast: Number((await textContrast(updates)).toFixed(2)) }
        const column = page.locator('.settings-sidebar .thread-nav__top')
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height)
          await updates.scrollIntoViewIfNeeded()
          // Pressing Application scrolls the column at the minimum size; the capture shows it at rest under its top row.
          await page.locator('.settings-sidebar__body').evaluate(node => { node.scrollTop = 0 })
          await settle(page)
          result[`settings-${width}x${height}`] = await checkBrand(column, track)
          await captureWindow(launched.app, resolve(evidenceRoot, `settings-${track}-${appearance}-${width}x${height}.png`))
        }
        expect((result.helpAbout as { contrast: number }).contrast).toBeGreaterThanOrEqual(4.5)
        expect((result.settingsVersion as { contrast: number }).contrast).toBeGreaterThanOrEqual(4.5)
        expect(await windowTitles(launched)).toEqual({ window: name, document: name })
        recorded.set(`${track}-${appearance}`, result)
      }))
    })
  }

  test('owl build with reduced motion', async () => {
    await onTrack('owl', () => withSotto({ onboardingComplete: true, appearance: 'dark', motion: 'reduced', scenario: 'design-threads', agents: 'design-threads' }, async (launched) => {
      await openThreads(launched.page)
      const row = launched.page.getByRole('complementary', { name: 'Thread sidebar' }).locator('.thread-nav__top')
      await resizeContentWindow(launched, 1280, 800)
      await settle(launched.page)
      const brand = await checkBrand(row, 'owl')
      // Nothing about the tile moves, with or without reduced motion.
      expect(await row.getByRole('img', { name: 'Sotto Owl' }).evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0)
      await row.screenshot({ path: resolve(evidenceRoot, 'header-owl-dark-reduced-motion.png'), animations: 'disabled' })
      recorded.set('owl-dark-reduced-motion', brand)
    }))
  })

  test('owl build in the strip over first-run setup', async () => {
    await onTrack('owl', () => withSotto({ onboardingComplete: false, appearance: 'dark' }, async (launched) => {
      const { page } = launched
      await expect(page.getByRole('button', { name: 'Get started', exact: true })).toBeVisible()
      await resizeContentWindow(launched, 1280, 800)
      await settle(page)
      const strip = page.getByRole('banner')
      const tile = strip.getByRole('img', { name: 'Sotto Owl', exact: true })
      await expect(tile).toBeVisible()
      await expect(strip.getByLabel('Sotto application')).toHaveCount(0)
      const box = (await tile.locator('svg').boundingBox())!, stripBox = (await strip.boundingBox())!
      expect([Math.round(box.width), Math.round(box.height)]).toEqual([24, 24])
      expect(Math.abs(box.y + box.height / 2 - (stripBox.y + stripBox.height / 2))).toBeLessThanOrEqual(1)
      await expect.poll(() => windowTitles(launched)).toEqual({ window: 'Sotto Owl', document: 'Sotto Owl' })
      await captureWindow(launched.app, resolve(evidenceRoot, 'first-run-owl-dark-1280x800.png'))
      recorded.set('owl-first-run-strip', { brand: 'tile', size: [Math.round(box.width), Math.round(box.height)] })
    }))
  })

  test.afterAll(async () => {
    await writeFile(resolve(evidenceRoot, 'branding.json'), `${JSON.stringify(Object.fromEntries(recorded), null, 2)}\n`, 'utf8')
  })
})
