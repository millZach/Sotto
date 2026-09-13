import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'
import sharp from 'sharp'

import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/settings'
import { themeBrand, widgetPaletteFor } from '../../src/shared/themeBranding'
import { parseThemeRgb, rgbToOklch } from '../../src/shared/themes/color'
import { createVividThemeColors } from '../../src/shared/themes/engine'
import { parseThemeFile } from '../../src/shared/themes/library'
import type { ThemeAppearance } from '../../src/shared/themes/palettes'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'

/**
 * Rendered evidence that the selected theme colours the app mark, the Agents
 * voice sphere and the floating widget's mark, voice bars and surfaces, live
 * and across restart. Run with SOTTO_THEME_BRANDING_EVIDENCE=1 after
 * `npm run build`; images and the sampled colours land in
 * artifacts/phase-three-theme-branding.
 */
const enabled = process.env.SOTTO_THEME_BRANDING_EVIDENCE === '1'
const evidenceRoot = resolve(process.cwd(), 'artifacts/phase-three-theme-branding')
const BLACK = { r: 0, g: 0, b: 0 }

type Settings = Partial<AppSettings>
interface Sample { readonly name: string; readonly expected: string; readonly measured: string; readonly distance: number }
interface HueSample { readonly name: string; readonly accentHue: number; readonly measuredHue: number; readonly distance: number }
const samples: Array<Sample | HueSample> = []

const saffron = parseThemeFile({ version: 1, id: 'saffron', name: 'Saffron', appearance: 'light', colors: createVividThemeColors('light', '#fbf7ee', '#c0392b') })

function hueDistance(a: number, b: number): number {
  const distance = Math.abs(((a - b) % 360) + 360) % 360
  return Math.min(distance, 360 - distance)
}

function brandFor(settings: Settings, mode: ThemeAppearance) {
  const palette = widgetPaletteFor({ ...DEFAULT_SETTINGS, ...settings })
  return { roles: palette[mode], brand: themeBrand(palette[mode], mode) }
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
}

/** The mark's tile, sampled left of the bar where only the tile shows. */
async function sampleTile(mark: Locator, name: string, expected: string): Promise<void> {
  const png = await mark.screenshot({ animations: 'disabled', path: resolve(evidenceRoot, `${name}.png`) })
  const image = sharp(png)
  const { width, height } = await image.metadata()
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true })
  const x = Math.round(width! * 0.16)
  const y = Math.round(height! * 0.5)
  const offset = (y * info.width + x) * info.channels
  const measured = `#${[0, 1, 2].map(index => data[offset + index]!.toString(16).padStart(2, '0')).join('')}`
  const want = parseThemeRgb(expected, BLACK)
  const got = parseThemeRgb(measured, BLACK)
  const distance = Math.max(Math.abs(want.r - got.r), Math.abs(want.g - got.g), Math.abs(want.b - got.b))
  samples.push({ name, expected, measured, distance: Math.round(distance) })
  expect(distance, `${name}: tile ${measured} should be ${expected}`).toBeLessThanOrEqual(6)
}

/** The chroma-weighted hue of whatever is vivid in a capture. */
async function sampleHue(target: Locator, name: string, accent: string): Promise<void> {
  const png = await target.screenshot({ animations: 'disabled', path: resolve(evidenceRoot, `${name}.png`) })
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  let x = 0
  let y = 0
  for (let index = 0; index < data.length; index += info.channels) {
    const color = rgbToOklch({ r: data[index]!, g: data[index + 1]!, b: data[index + 2]! })
    if (color.C < 0.04) continue
    x += color.C * Math.cos((color.h * Math.PI) / 180)
    y += color.C * Math.sin((color.h * Math.PI) / 180)
  }
  const measuredHue = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
  const accentHue = rgbToOklch(parseThemeRgb(accent, BLACK)).h
  const distance = hueDistance(measuredHue, accentHue)
  samples.push({ name, accentHue: Math.round(accentHue), measuredHue: Math.round(measuredHue), distance: Math.round(distance) })
  expect(Math.hypot(x, y), `${name}: capture has colour`).toBeGreaterThan(0)
  expect(distance, `${name}: hue ${measuredHue.toFixed(0)} should follow accent ${accentHue.toFixed(0)}`).toBeLessThan(30)
}

async function widgetOf(launched: LaunchedSotto): Promise<Page> {
  await expect.poll(() => launched.app.windows().some(candidate => candidate.url().endsWith('/widget.html'))).toBe(true)
  const widget = launched.app.windows().find(candidate => candidate.url().endsWith('/widget.html'))!
  await widget.waitForLoadState('domcontentloaded')
  return widget
}

async function openAgents(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Agents', exact: true }).click()
  const notNow = page.getByRole('button', { name: 'Not now', exact: true })
  if (await notNow.isVisible().catch(() => false)) await notNow.click()
  await expect(page.locator('canvas.agent-orb')).toBeVisible()
}

async function expectRoom(page: Page, settings: Settings, mode: ThemeAppearance, name: string): Promise<void> {
  const { brand, roles } = brandFor(settings, mode)
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
  const mark = page.locator('svg.app-mark__glyph')
  await expect(mark).toHaveAttribute('data-tile', brand.tile)
  await expect(mark).toHaveAttribute('data-glyph', brand.glyph)
  const orb = page.locator('canvas.agent-orb')
  await expect(orb).toHaveAttribute('data-orb-colors', brand.orb.join(' '))
  await settle(page)
  await sampleTile(mark, `${name}-app-mark`, brand.tile)
  await sampleHue(orb, `${name}-agents-orb`, roles.accent)
  await page.screenshot({ path: resolve(evidenceRoot, `${name}-agents-room.png`), animations: 'disabled' })
}

async function expectWidget(widget: Page, settings: Settings, scheme: ThemeAppearance, name: string, listening: Page | null): Promise<void> {
  const { brand, roles } = brandFor(settings, scheme)
  await widget.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
  const root = widget.locator('html')
  await expect(root).toHaveAttribute('data-theme', scheme)
  await expect.poll(() => widget.evaluate(() => document.documentElement.style.getPropertyValue('--theme-accent'))).toBe(roles.accent)
  await expect.poll(() => widget.evaluate(() => document.documentElement.style.getPropertyValue('--theme-surface'))).toBe(roles.surface)
  if (listening === null) {
    await widget.locator('[data-testid="widget-sliver"]').hover()
    await settle(widget)
    await widget.screenshot({ path: resolve(evidenceRoot, `${name}-widget-idle-hover.png`), animations: 'disabled' })
    return
  }
  await expect(widget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
  const mark = widget.locator('[data-testid="widget-glyph"] svg')
  await expect(mark).toHaveAttribute('data-tile', brand.tile)
  await settle(widget)
  await widget.screenshot({ path: resolve(evidenceRoot, `${name}-widget-listening.png`), animations: 'disabled' })
  await sampleTile(mark, `${name}-widget-mark`, brand.tile)
  await sampleHue(widget.getByTestId('listening-bars'), `${name}-widget-voice-bars`, roles.accent)
}

/** Starts from the widget's own click-to-dictate sliver, so the Agents room stays in view. */
async function startDictation(widget: Page): Promise<void> {
  await widget.getByTestId('widget-sliver').hover()
  await widget.getByTestId('widget-sliver').click({ position: { x: 40, y: 14 }, timeout: 5000 })
  await expect(widget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
}

async function cancelDictation(widget: Page): Promise<void> {
  await widget.getByRole('button', { name: 'Cancel dictation' }).click()
  await expect(widget.locator('.widget-shell[data-status="idle"]')).toBeVisible({ timeout: 15_000 })
}

async function update(page: Page, patch: Settings): Promise<void> {
  await page.evaluate(async (next) => { await window.sotto!.updateSettings(next) }, patch)
}

test.describe('theme branding evidence', () => {
  test.skip(!enabled, 'Run with SOTTO_THEME_BRANDING_EVIDENCE=1 after npm run build')
  test.setTimeout(240_000)

  test('mark, sphere and widget wear Ocean and contrasting themes, live, in both modes and after restart', async () => {
    await mkdir(evidenceRoot, { recursive: true })
    const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-theme-branding-'))
    let settings: Settings = { onboardingComplete: true, theme: 'system', appearance: 'dark', lightTheme: 'ocean', darkTheme: 'ocean', customThemes: [saffron] }
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, ...settings }), 'utf8')
    let launched: LaunchedSotto | undefined
    try {
      launched = await launchSotto('success', profile)
      let { page } = launched
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await openAgents(page)
      let widget = await widgetOf(launched)

      // Ocean, dark room and dark widget.
      await expectRoom(page, settings, 'dark', 'ocean-dark')
      await expectWidget(widget, settings, 'dark', 'ocean-dark', null)
      await startDictation(widget)
      await expectWidget(widget, settings, 'dark', 'ocean-dark', page)

      // Iris selected mid-session: the capsule repaints without a new session.
      settings = { ...settings, darkTheme: 'iris' }
      await update(page, { darkTheme: 'iris' })
      await expectRoom(page, settings, 'dark', 'iris-dark-live')
      await expectWidget(widget, settings, 'dark', 'iris-dark-live', page)
      await cancelDictation(widget)

      // Light room with Ember; the widget follows the system to its light half while idle.
      settings = { ...settings, appearance: 'light', lightTheme: 'ember' }
      await update(page, { appearance: 'light', lightTheme: 'ember' })
      await expectRoom(page, settings, 'light', 'ember-light-live')
      await expectWidget(widget, settings, 'light', 'ember-light-idle', null)
      await startDictation(widget)
      await expectWidget(widget, settings, 'light', 'ember-light', page)
      // The system turning dark flips the widget to the dark half, Iris, mid-session.
      await expectWidget(widget, settings, 'dark', 'system-dark-iris', page)
      await cancelDictation(widget)

      // A custom theme on the light half.
      settings = { ...settings, lightTheme: saffron.id }
      await update(page, { lightTheme: saffron.id })
      await expectRoom(page, settings, 'light', 'custom-light-live')
      await startDictation(widget)
      await expectWidget(widget, settings, 'light', 'custom-light', page)
      await cancelDictation(widget)

      // Restart on the same profile keeps every choice.
      await closeSotto(launched)
      launched = await launchSotto('success', profile)
      page = launched.page
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await openAgents(page)
      widget = await widgetOf(launched)
      await expectRoom(page, settings, 'light', 'restart-custom-light')
      await expectWidget(widget, settings, 'dark', 'restart-iris-dark-idle', null)
      await startDictation(widget)
      await expectWidget(widget, settings, 'dark', 'restart-iris-dark', page)
      await expectWidget(widget, settings, 'light', 'restart-custom-light', page)
      await cancelDictation(widget)
      settings = { ...settings, appearance: 'dark' }
      await update(page, { appearance: 'dark' })
      await expectRoom(page, settings, 'dark', 'restart-iris-dark')
    } finally {
      await writeFile(resolve(evidenceRoot, 'samples.json'), `${JSON.stringify(samples, null, 2)}\n`, 'utf8')
      if (launched !== undefined) await closeSotto(launched)
      await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
    }
  })

  test('a failed dictation keeps the theme error role, distinct from the accent', async () => {
    await mkdir(evidenceRoot, { recursive: true })
    const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-theme-branding-error-'))
    const settings: Settings = { onboardingComplete: true, theme: 'system', appearance: 'light', lightTheme: 'ember', darkTheme: 'iris' }
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, ...settings }), 'utf8')
    let launched: LaunchedSotto | undefined
    try {
      launched = await launchSotto('transcription-failure', profile)
      const widget = await widgetOf(launched)
      for (const scheme of ['light', 'dark'] as const) {
        const { roles } = brandFor(settings, scheme)
        await widget.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
        await expect(widget.locator('html')).toHaveAttribute('data-theme', scheme)
        await startDictation(widget)
        await widget.getByRole('button', { name: 'Stop dictation' }).click()
        const shell = widget.locator('.widget-shell[data-tone="error"]')
        await expect(shell).toBeVisible({ timeout: 15_000 })
        const colors = await widget.evaluate(() => {
          const probe = (value: string): string => {
            const element = document.createElement('span')
            element.style.color = value
            document.body.append(element)
            const color = getComputedStyle(element).color
            element.remove()
            return color
          }
          return {
            copy: getComputedStyle(document.querySelector('.widget-copy')!).color,
            error: probe('var(--theme-error-foreground)'),
            accent: probe('var(--theme-accent)'),
          }
        })
        expect(colors.copy).toBe(colors.error)
        expect(colors.error).not.toBe(colors.accent)
        expect(await widget.evaluate(() => document.documentElement.style.getPropertyValue('--theme-error-foreground'))).toBe(roles.errorForeground)
        await settle(widget)
        await widget.screenshot({ path: resolve(evidenceRoot, `error-${scheme === 'light' ? 'ember-light' : 'iris-dark'}-widget.png`), animations: 'disabled' })
        const dismiss = widget.getByRole('button', { name: /dismiss|close/i })
        if (await dismiss.isVisible().catch(() => false)) await dismiss.click()
        await expect(widget.locator('.widget-shell[data-status="idle"]')).toBeVisible({ timeout: 20_000 })
      }
    } finally {
      if (launched !== undefined) await closeSotto(launched)
      await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
    }
  })
})
