import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/settings'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'

/**
 * Settings → Appearance as a studio: the three cards beside the standing preview, at the three window sizes in both
 * modes, the split switch, the half switch, Watcher's room with its night scene, and keyboard focus on a tile. Checks that
 * nothing on the page clips or overflows, that the preview stays in view while the page scrolls where there are two
 * columns, and that the night scene is never blank. Publishes to artifacts/appearance-studio-page with
 * SOTTO_E2E_EVIDENCE=publish.
 */
const evidence = evidenceDirectory('artifacts/appearance-studio-page')
const sizes = [[1600, 1000], [1280, 800], [820, 560]] as const

async function withProfile(settings: Partial<AppSettings>, run: (launched: LaunchedSotto) => Promise<void>): Promise<void> {
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-appearance-studio-' })).directory
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, ...settings }), 'utf8')
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    await launched.page.emulateMedia({ reducedMotion: 'reduce' })
    await run(launched)
  } finally {
    if (launched !== undefined) await closeSotto(launched)
    await removeOwnedE2EProfile(profile)
  }
}

async function openAppearance(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Appearance', exact: true }).click()
  await expect(page.locator('#settings-appearance .appearance-preview')).toBeVisible()
}

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(1, 1)
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  await page.screenshot({ path: join(evidence, `${name}.png`), caret: 'hide', animations: 'disabled' })
}

/** Every control on the page inside the scroll area's width, and no element of the page wider than its card. */
async function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const scroll = document.querySelector('.settings-scroll')!.getBoundingClientRect()
    const page = document.querySelector('#settings-appearance')!
    const bad: string[] = []
    for (const element of page.querySelectorAll<HTMLElement>('button, input, select, .appearance-card, .appearance-preview, .theme-tile, .segmented-control')) {
      if (!element.getClientRects().length) continue
      const box = element.getBoundingClientRect()
      if (box.left < scroll.left - 1 || box.right > scroll.right + 1) bad.push(`${element.className || element.tagName} ${Math.round(box.left)}-${Math.round(box.right)} of ${Math.round(scroll.left)}-${Math.round(scroll.right)}`)
    }
    for (const card of page.querySelectorAll<HTMLElement>('.appearance-card, .appearance-preview')) {
      if (card.scrollWidth > card.clientWidth + 1) bad.push(`${card.className} scrolls sideways`)
    }
    return bad
  })
}

/** Whether the preview's night scene has any painted pixel. */
async function sceneDrawn(page: Page): Promise<boolean> {
  return page.locator('.studio-scene--land').evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('2d')
    if (context === null || canvas.width === 0) return false
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data
    for (let index = 3; index < data.length; index += 4) if (data[index]! > 0) return true
    return false
  })
}

test('Appearance as a studio: sizes, modes, split, preview halves, Watcher and keyboard', async () => {
  test.setTimeout(300_000)
  await mkdir(evidence, { recursive: true })
  await withProfile({ appearance: 'dark', reducedMotion: 'on' }, async launched => {
    const { page } = launched
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await openAppearance(page)
    const section = page.locator('#settings-appearance')

    for (const [width, height] of sizes) {
      await resizeContentWindow(launched, width, height, [800, 540])
      for (const mode of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), mode)
        await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
        await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0 })
        expect(await overflow(page), `${width}x${height} ${mode}`).toEqual([])
        await shot(page, `appearance-${mode}-${width}x${height}`)
      }
      // Two columns: the preview stays in view as the page scrolls. One column: it stands above the cards and scrolls away.
      const twoColumns = await page.evaluate(() => {
        const preview = document.querySelector('.appearance-preview')!.getBoundingClientRect()
        const cards = document.querySelector('.appearance-studio__cards')!.getBoundingClientRect()
        return preview.left > cards.right - 1
      })
      const before = await section.locator('.appearance-preview').evaluate(element => element.getBoundingClientRect().top)
      await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 400 })
      const after = await section.locator('.appearance-preview').evaluate(element => element.getBoundingClientRect().top)
      const scrolled = await page.locator('.settings-scroll').evaluate(element => element.scrollTop)
      if (twoColumns && scrolled > 100) expect(after, `preview stays in view at ${width}x${height}`).toBeGreaterThan(0)
      if (!twoColumns) expect(after).toBeLessThan(before)
      expect(twoColumns, `${width}x${height} columns`).toBe(width >= 1280)
      await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0 })
    }

    await resizeContentWindow(launched, 1280, 800, [800, 540])
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    // The split switch: two grids, each choosing its own half.
    const split = section.getByRole('switch', { name: 'A different theme when dark' })
    await split.click()
    await expect(section.getByRole('radiogroup', { name: 'Light theme', exact: true })).toBeVisible()
    await expect(section.getByRole('radiogroup', { name: 'Dark theme', exact: true })).toBeVisible()
    await shot(page, 'appearance-split-on-1280x800')

    // The other half, without saving and without repainting the window.
    await section.getByRole('radiogroup', { name: 'Color scheme the preview shows' }).getByRole('radio', { name: 'Light', exact: true }).click()
    await expect(section.locator('.appearance-preview__window')).toHaveAttribute('data-theme-scope', 'light')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    expect((await page.evaluate(() => window.sotto!.getSettings())).appearance).toBe('dark')
    await shot(page, 'appearance-preview-light-half-1280x800')
    await section.getByRole('radiogroup', { name: 'Color scheme the preview shows' }).getByRole('radio', { name: 'As set', exact: true }).click()

    // Watcher's room, with its night scene drawn, and drawn again at once on a theme change and a resize.
    await section.getByRole('radiogroup', { name: 'Room the preview shows' }).getByRole('radio', { name: 'Watcher', exact: true }).click()
    await expect(section.locator('.studio-watcher')).toBeVisible()
    expect(await sceneDrawn(page)).toBe(true)
    await shot(page, 'appearance-watcher-dark-1280x800')
    // A frame watcher: every animation frame after a change must find the scene painted.
    await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.studio-scene--land')!
      const record = window as unknown as { blankFrames: number; watching: boolean }
      record.blankFrames = 0; record.watching = true
      const look = (): void => {
        if (!record.watching) return
        const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
        let painted = false
        for (let index = 3; index < data.length; index += 64) if (data[index]! > 0) { painted = true; break }
        if (!painted) record.blankFrames += 1
        requestAnimationFrame(look)
      }
      requestAnimationFrame(look)
    })
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'light' }))
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await resizeContentWindow(launched, 1600, 1000, [800, 540])
    await page.waitForTimeout(400)
    await resizeContentWindow(launched, 1280, 800, [800, 540])
    await page.waitForTimeout(400)
    expect(await page.evaluate(() => { const record = window as unknown as { blankFrames: number; watching: boolean }; record.watching = false; return record.blankFrames })).toBe(0)
    await shot(page, 'appearance-watcher-light-1280x800')

    // Keyboard: a tile is a radio, reached by Tab; arrows move and choose.
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    await section.getByRole('radiogroup', { name: 'Room the preview shows' }).getByRole('radio', { name: 'Threads', exact: true }).click()
    const tile = section.getByRole('radiogroup', { name: 'Light theme', exact: true }).getByRole('radio', { checked: true })
    await tile.focus()
    await page.keyboard.press('ArrowRight')
    await expect(section.getByRole('radiogroup', { name: 'Light theme', exact: true }).locator('.theme-tile:focus-visible')).toHaveCount(1)
    await shot(page, 'appearance-keyboard-tile-1280x800')
    expect(errors).toEqual([])
  })
})
