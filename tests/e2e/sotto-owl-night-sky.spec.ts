import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { expect, test, type Page } from '@playwright/test'
import sharp from 'sharp'

import { contrastRatio, parseThemeRgb } from '../../src/shared/themes/color'
import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { captureWindow } from './support/sottoCapture'
import { openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { onReleaseTrack } from './support/releaseTrack'
import { holdOwlSky, releaseOwlSky } from './support/sottoOwl'
import { resizeContentWindow } from './support/sottoWindow'

/**
 * Sotto Owl's night sky behind the sidebar header, on the built app: in the Sotto, Fern and Citrine themes, dark
 * and light, at 1600x1000, 1280x800 and the 820x560 minimum; with reduced motion from the system and from Sotto's
 * own setting; in the macOS header layout; and absent on stable. Run after `npm run build`. Captures go to disposable
 * run evidence; `SOTTO_E2E_EVIDENCE=publish` writes artifacts/sotto-owl-night-sky.
 */
const evidenceRoot = evidenceDirectory('artifacts/sotto-owl-night-sky')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const THEMES = [['t3-code', 'sotto'], ['fern', 'fern'], ['citrine', 'citrine']] as const
const APPEARANCES = ['dark', 'light'] as const
const BLACK = { r: 0, g: 0, b: 0 }
const recorded = new Map<string, unknown>()

interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
interface Painted { readonly name: string; readonly ink: string; readonly stable: string; readonly owl: string }
interface SkyReading {
  readonly painted: boolean
  readonly stars: ReadonlyArray<Box & { readonly shown: boolean; readonly accent: boolean; readonly opacity: number; readonly caught: boolean }>
  readonly obstacles: ReadonlyArray<Box & { readonly name: string }>
  readonly twinkles: ReadonlyArray<{ readonly duration: number; readonly running: boolean }>
  readonly dragRegion: string
  readonly skyRegion: string | null
  readonly band: string
  readonly painting: readonly Painted[]
  /** The faint text token, which the placeholder must be painted in for its reading to mean anything. */
  readonly faint: string
}

/** Everything the header shows, measured in the page: the stars, what they must stay clear of, and the colours. */
async function readSky(page: Page): Promise<SkyReading> {
  return page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>('aside.thread-nav[data-mode]')!
    const row = sidebar.querySelector<HTMLElement>('.thread-nav__top')!
    const canvas = document.createElement('canvas')
    canvas.width = 1; canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    // The canvas resolves any CSS colour, oklch() included, to sRGB.
    const hex = (value: string): string => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = 'rgba(0, 0, 0, 0)'; context.fillStyle = value; context.fillRect(0, 0, 1, 1)
      return `#${[...context.getImageData(0, 0, 1, 1).data.slice(0, 3)].map(channel => channel.toString(16).padStart(2, '0')).join('')}`
    }
    // A token as the sidebar resolves it: what stable paints there, and what Owl's night is.
    const token = (name: string): string => {
      const probe = document.createElement('i')
      probe.style.cssText = `position:absolute;width:1px;height:1px;background:var(${name})`
      sidebar.append(probe)
      const value = getComputedStyle(probe).backgroundColor
      probe.remove()
      return hex(value)
    }
    const box = (element: Element): { x: number; y: number; width: number; height: number } => {
      const { x, y, width, height } = element.getBoundingClientRect()
      return { x, y, width, height }
    }
    const sky = sidebar.querySelector('.thread-nav__sky')
    const stars = [...sidebar.querySelectorAll<HTMLElement>('.thread-nav__star')].map((star) => {
      const style = getComputedStyle(star)
      const where = box(star)
      const hit = document.elementFromPoint(where.x + where.width / 2, where.y + where.height / 2)
      return {
        ...where, opacity: Number(style.opacity), accent: star.dataset.ink === 'accent',
        shown: style.display !== 'none' && Number(style.opacity) > 0,
        caught: hit !== null && hit.closest('.thread-nav__sky') !== null,
      }
    })
    const obstacles = [
      ...[...row.querySelectorAll('button')].map(control => ({ name: control.getAttribute('aria-label') ?? control.getAttribute('title') ?? '', ...box(control.querySelector('svg')!) })),
      { name: 'Sotto Owl tile', ...box(row.querySelector('.thread-nav__tile')!) },
      { name: 'Search threads', ...box(sidebar.querySelector('.threads-search input')!) },
    ]
    const twinkles = (sky?.getAnimations({ subtree: true }) ?? []).map(animation => ({
      duration: Number(animation.effect?.getComputedTiming().duration ?? 0), running: animation.playState === 'running',
    }))
    const input = sidebar.querySelector<HTMLInputElement>('.threads-search input')!
    const band = token('--tt-owl-night')
    const painting = [
      // The buttons on the band.
      ...[...row.querySelectorAll<HTMLElement>('button')].map(button => ({
        name: button.getAttribute('aria-label') ?? '', ink: hex(getComputedStyle(button).color), stable: token('--threads-sidebar'), owl: band,
      })),
      { name: 'Search placeholder', ink: hex(getComputedStyle(input, '::placeholder').color), stable: token('--threads-field'), owl: hex(getComputedStyle(input).backgroundColor) },
      { name: 'Search icon', ink: hex(getComputedStyle(sidebar.querySelector('.threads-search > svg')!).color), stable: token('--threads-field'), owl: hex(getComputedStyle(input).backgroundColor) },
    ]
    return {
      painted: sidebar.hasAttribute('data-sky') && sky !== null, stars, obstacles, twinkles,
      dragRegion: getComputedStyle(row).getPropertyValue('-webkit-app-region'),
      skyRegion: sky === null ? null : getComputedStyle(sky).getPropertyValue('-webkit-app-region'),
      band, painting, faint: token('--tt-text-faint'),
    }
  })
}

const overlaps = (first: Box, second: Box): boolean =>
  first.x < second.x + second.width && second.x < first.x + first.width && first.y < second.y + second.height && second.y < first.y + first.height

/** The stars a sidebar shows clear of every icon, the tile and the field, catching no press, under a drag strip that still drags. */
function expectClear(reading: SkyReading, shown: number): void {
  expect(reading.painted).toBe(true)
  const visible = reading.stars.filter(star => star.shown)
  expect(visible).toHaveLength(shown)
  for (const star of visible) {
    for (const obstacle of reading.obstacles) expect(overlaps(star, obstacle), `a star at ${star.x},${star.y} on ${obstacle.name}`).toBe(false)
    expect(star.caught, `a star at ${star.x},${star.y} catches a press`).toBe(false)
    expect(star.y + star.height).toBeLessThanOrEqual(44)
  }
  expect(reading.dragRegion).toBe('drag')
  expect(reading.skyRegion).not.toBe('drag')
}

/** Every pair keeps 4.5:1 on the night and gives up no more than a twentieth of what stable paints. */
function contrasts(reading: SkyReading): Array<{ name: string; stable: number; owl: number }> {
  // The placeholder's colour is read from its pseudo-element; were it the field's own text colour, the check would mean nothing.
  expect(reading.painting.find(({ name }) => name === 'Search placeholder')!.ink, 'the placeholder, as read').toBe(reading.faint)
  return reading.painting.map(({ name, ink, stable, owl }) => {
    const on = (surface: string): number => Number(contrastRatio(parseThemeRgb(ink, BLACK), parseThemeRgb(surface, BLACK)).toFixed(2))
    const measured = { name, stable: on(stable), owl: on(owl) }
    expect(measured.owl, `${name} on the night`).toBeGreaterThanOrEqual(4.5)
    expect(measured.owl / measured.stable, `${name}: ${measured.stable} on stable, ${measured.owl} on Owl`).toBeGreaterThanOrEqual(0.94)
    return measured
  })
}

/**
 * Whether the stars are on screen, not just in the page: each shown star's strongest pixel against the median of a
 * ring around it, from a capture of the strip, with the twinkle stopped so every star is at its own strength. A star
 * the band painted over would read 0.
 */
async function starsOnScreen(page: Page): Promise<Array<{ tier: number; change: number }>> {
  await holdOwlSky(page)
  const stars = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.thread-nav__star')]
    .filter(star => getComputedStyle(star).display !== 'none' && Number(getComputedStyle(star).opacity) > 0)
    .map(star => { const { x, y, width, height } = star.getBoundingClientRect(); return { x, y, width, height, tier: Number(star.dataset.tier) } }))
  const width = Math.ceil(await page.locator('aside.thread-nav[data-mode]').evaluate(node => node.getBoundingClientRect().width))
  const png = await page.screenshot({ clip: { x: 0, y: 0, width, height: 50 }, animations: 'allow', caret: 'hide' })
  await releaseOwlSky(page)
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  const scale = info.width / width
  const pixel = (x: number, y: number): number[] => {
    const offset = (Math.min(info.height - 1, Math.max(0, Math.round(y))) * info.width + Math.min(info.width - 1, Math.max(0, Math.round(x)))) * info.channels
    return [data[offset]!, data[offset + 1]!, data[offset + 2]!]
  }
  return stars.map(({ x, y, width: size, height, tier }) => {
    const [centreX, centreY] = [(x + size / 2) * scale, (y + height / 2) * scale]
    const ring = Array.from({ length: 8 }, (_, step) => pixel(centreX + Math.cos(step * Math.PI / 4) * 4 * scale, centreY + Math.sin(step * Math.PI / 4) * 4 * scale))
    const median = [0, 1, 2].map(channel => ring.map(sample => sample[channel]!).sort((a, b) => a - b)[4]!)
    let change = 0
    for (let px = Math.floor(x * scale); px <= Math.ceil((x + size) * scale); px++) for (let py = Math.floor(y * scale); py <= Math.ceil((y + height) * scale); py++) {
      change = Math.max(change, ...pixel(px, py).map((value, channel) => Math.abs(value - median[channel]!)))
    }
    return { tier, change }
  })
}

function expectOnScreen(stars: ReadonlyArray<{ tier: number; change: number }>): void {
  for (const { tier, change } of stars) if (tier <= 3) expect(change, `a tier ${tier} star changes its pixels by ${change}`).toBeGreaterThanOrEqual(12)
}

async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0)
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
}


async function header(launched: LaunchedSotto, name: string): Promise<void> {
  const width = await launched.page.locator('aside.thread-nav[data-mode]').evaluate(node => node.getBoundingClientRect().width)
  await launched.page.screenshot({ path: resolve(evidenceRoot, name), clip: { x: 0, y: 0, width: Math.ceil(width), height: 140 }, animations: 'allow', caret: 'hide' })
}

async function sidebarWidth(launched: LaunchedSotto, key: 'Home' | 'End' | 'reset'): Promise<number> {
  const handle = launched.page.getByRole('separator', { name: 'Resize sidebar' })
  if (key === 'reset') await handle.dblclick()
  else { await handle.focus(); await handle.press(key) }
  // The handle's focus ring would sit in the capture's edge.
  await handle.evaluate(node => (node as HTMLElement).blur())
  await settle(launched.page)
  await launched.page.mouse.move(0, 0)
  return launched.page.locator('aside.thread-nav[data-mode]').evaluate(node => Math.round(node.getBoundingClientRect().width))
}

async function onThreads(launched: LaunchedSotto): Promise<void> {
  await openThreads(launched.page)
  await launched.page.getByRole('button', { name: 'Visual gate flake', exact: true }).click()
  await expect(launched.page.getByRole('button', { name: 'Allow' })).toBeVisible()
}

function launchOptions(theme: string, appearance: 'dark' | 'light', motion: 'normal' | 'reduced' = 'normal') {
  return {
    onboardingComplete: true, appearance, motion, scenario: 'design-threads', agents: 'design-threads',
    ...(appearance === 'dark' ? { darkTheme: theme } : { lightTheme: theme }),
  } as const
}

test.describe('Sotto Owl night sky on the built app', () => {
  test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 })

  test.beforeAll(async () => { await mkdir(evidenceRoot, { recursive: true }) })

  for (const [theme, label] of THEMES) for (const appearance of APPEARANCES) {
    test(`owl build, ${label}, ${appearance}`, async () => {
      await onReleaseTrack('owl', () => withSotto(launchOptions(theme, appearance), async (launched) => {
        await onThreads(launched)
        const result: Record<string, unknown> = {}
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height)
          await settle(launched.page)
          const reading = await readSky(launched.page)
          // Dark shows all eleven; light drops the faintest four.
          expectClear(reading, appearance === 'dark' ? 11 : 7)
          expect(reading.stars.filter(star => star.shown && star.accent)).toHaveLength(3)
          // Four stars twinkle by night, each on its own slow cycle. By day the fourth goes with the faintest stars,
          // so it runs no animation at all.
          expect(reading.twinkles.filter(twinkle => twinkle.running).map(twinkle => twinkle.duration).sort((a, b) => a - b))
            .toEqual(appearance === 'dark' ? [9000, 11000, 13000, 15000] : [9000, 11000, 15000])
          const onScreen = await starsOnScreen(launched.page)
          expectOnScreen(onScreen)
          result[`${width}x${height}`] = { band: reading.band, contrast: contrasts(reading), stars: reading.stars.filter(star => star.shown).length, pixelChange: onScreen.map(star => star.change) }
          await holdOwlSky(launched.page)
          await captureWindow(launched.app, resolve(evidenceRoot, `threads-owl-${label}-${appearance}-${width}x${height}.png`))
          if (width === 1280) await header(launched, `header-owl-${label}-${appearance}.png`)
          await releaseOwlSky(launched.page)
        }
        if (label === 'sotto') {
          // The sidebar's narrowest and widest: the scatter keeps clear of everything at both ends.
          await resizeContentWindow(launched, 1280, 800)
          for (const key of ['Home', 'End'] as const) {
            const width = await sidebarWidth(launched, key)
            expectClear(await readSky(launched.page), appearance === 'dark' ? 11 : 7)
            result[`sidebar-${width}`] = 'clear'
            await holdOwlSky(launched.page)
            await header(launched, `header-owl-${label}-${appearance}-sidebar-${width}.png`)
          }
          await sidebarWidth(launched, 'reset')
        }
        recorded.set(`owl-${label}-${appearance}`, result)
      }))
    })
  }

  // Zach's own screen runs at 150%, where his screenshots of the look were taken: the stars at the size he sees them.
  for (const [theme, label, appearance] of [['t3-code', 'sotto', 'dark'], ['t3-code', 'sotto', 'light'], ['fern', 'fern', 'dark'], ['citrine', 'citrine', 'dark']] as const) {
    test(`owl build at 150%, ${label}, ${appearance}`, async () => {
      await onReleaseTrack('owl', () => withSotto({ ...launchOptions(theme, appearance), scalePercent: 150 }, async (launched) => {
        await onThreads(launched)
        await resizeContentWindow(launched, 1280, 800)
        await settle(launched.page)
        expectClear(await readSky(launched.page), appearance === 'dark' ? 11 : 7)
        const onScreen = await starsOnScreen(launched.page)
        expectOnScreen(onScreen)
        recorded.set(`owl-${label}-${appearance}-150`, { pixelChange: onScreen.map(star => star.change) })
        await holdOwlSky(launched.page)
        await header(launched, `header-owl-${label}-${appearance}-150.png`)
      }))
    })
  }

  test('owl build with reduced motion from the system, then from Sotto\'s own setting', async () => {
    await onReleaseTrack('owl', async () => {
      // The system asks for reduced motion; Sotto's setting is left to follow it.
      await withSotto(launchOptions('t3-code', 'dark'), async (launched) => {
        await onThreads(launched)
        await resizeContentWindow(launched, 1280, 800)
        expect((await readSky(launched.page)).twinkles.filter(twinkle => twinkle.running)).toHaveLength(4)
        // The twinkle moves: its time goes on, and a star out of step is below its own strength.
        const twinkling = (): Promise<{ time: number; dimmed: number }> => launched.page.evaluate(() => {
          const animations = document.querySelector('.thread-nav__sky')!.getAnimations({ subtree: true })
          const stars = [...document.querySelectorAll<HTMLElement>('.thread-nav__star[data-twinkle]')]
          return {
            time: Math.min(...animations.map(animation => Number(animation.currentTime ?? 0))),
            dimmed: stars.filter(star => Number(getComputedStyle(star).opacity) < Number(getComputedStyle(star).getPropertyValue('--owl-star-strength')) - 0.005).length,
          }
        })
        const start = (await twinkling()).time
        await expect.poll(async () => (await twinkling()).time).toBeGreaterThan(start + 250)
        expect((await twinkling()).dimmed).toBeGreaterThan(0)
        await launched.page.emulateMedia({ reducedMotion: 'reduce' })
        await settle(launched.page)
        const reading = await readSky(launched.page)
        expectClear(reading, 11)
        expect(reading.twinkles).toEqual([])
        expectOnScreen(await starsOnScreen(launched.page))
        await header(launched, 'header-owl-sotto-dark-reduced-motion-system.png')
        recorded.set('owl-reduced-motion-system', { twinkles: reading.twinkles.length, stars: reading.stars.filter(star => star.shown).length })
      })
      // Sotto's own setting is on and the system does not ask.
      await withSotto(launchOptions('t3-code', 'dark', 'reduced'), async (launched) => {
        await onThreads(launched)
        await resizeContentWindow(launched, 1280, 800)
        await launched.page.emulateMedia({ reducedMotion: 'no-preference' })
        await expect(launched.page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
        await settle(launched.page)
        const reading = await readSky(launched.page)
        expectClear(reading, 11)
        expect(reading.twinkles).toEqual([])
        // Still, every star is at its own strength: exactly the night without the twinkle.
        expect(reading.stars.map(star => star.opacity)).toEqual([0.38, 0.62, 0.13, 0.22, 0.13, 0.22, 0.13, 0.22, 0.13, 0.22, 0.22])
        expectOnScreen(await starsOnScreen(launched.page))
        await header(launched, 'header-owl-sotto-dark-reduced-motion-setting.png')
        recorded.set('owl-reduced-motion-setting', { twinkles: reading.twinkles.length, stars: reading.stars.filter(star => star.shown).length })
      })
    })
  })

  test('owl build in the macOS header layout', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('t3-code', 'dark'), async (launched) => {
      await onThreads(launched)
      await resizeContentWindow(launched, 1280, 800)
      // A Windows run has no traffic lights; the sidebar's own macOS layout is what moves the sky. A macOS build
      // draws no brand beside the lights, so the Windows build's is hidden to match.
      await launched.page.locator('aside.thread-nav[data-mode]').evaluate(node => {
        node.classList.add('thread-nav--mac')
        node.querySelector<HTMLElement>('.thread-nav__brand')?.style.setProperty('display', 'none')
      })
      const result: Record<string, unknown> = {}
      for (const [key, shown] of [['reset', 11], ['Home', 5]] as const) {
        const width = await sidebarWidth(launched, key)
        await settle(launched.page)
        const reading = await readSky(launched.page)
        expectClear(reading, shown)
        const tile = reading.obstacles.find(obstacle => obstacle.name === 'Sotto Owl tile')!
        // No tile sits beside the traffic lights: the hidden brand has no box for a star to meet.
        expect(tile.width).toBe(0)
        // Nothing sits where the traffic lights are drawn, 16 to about 76 pixels in (macOS 26 and later).
        for (const star of reading.stars.filter(candidate => candidate.shown)) expect(star.x, `a star at ${star.x},${star.y}`).toBeGreaterThan(78)
        // Even at the narrowest sidebar the row holds every action at its full 28px, inside the sidebar.
        const row = await launched.page.locator('aside.thread-nav[data-mode] .thread-nav__top').evaluate(node => ({
          right: node.getBoundingClientRect().right - parseFloat(getComputedStyle(node).paddingRight),
          buttons: [...node.querySelectorAll('.tt-button, .thread-nav__collapse')].map(button => button.getBoundingClientRect()).map(box => ({ width: box.width, right: box.right })),
        }))
        expect(row.buttons).toHaveLength(3)
        for (const button of row.buttons) expect(button.width).toBeCloseTo(28, 1)
        expect(Math.max(...row.buttons.map(button => button.right))).toBeLessThanOrEqual(row.right + 0.5)
        expectOnScreen(await starsOnScreen(launched.page))
        result[`sidebar-${width}`] = { stars: reading.stars.filter(star => star.shown).length, tile: 'none' }
        await holdOwlSky(launched.page)
        await header(launched, `header-owl-sotto-dark-mac-${width}.png`)
      }
      recorded.set('owl-mac-layout', result)
    }))
  })

  for (const appearance of APPEARANCES) {
    test(`stable build, sotto, ${appearance}, paints no sky`, async () => {
      await withSotto(launchOptions('t3-code', appearance), async (launched) => {
        await onThreads(launched)
        await resizeContentWindow(launched, 1280, 800)
        await settle(launched.page)
        const sidebar = launched.page.locator('aside.thread-nav[data-mode]')
        await expect(sidebar).not.toHaveAttribute('data-sky')
        await expect(sidebar.locator('.thread-nav__sky, .thread-nav__star')).toHaveCount(0)
        expect(await sidebar.evaluate(node => getComputedStyle(node).backgroundImage)).toBe('none')
        await header(launched, `header-stable-sotto-${appearance}.png`)
        recorded.set(`stable-sotto-${appearance}`, { sky: 'none' })
      })
    })
  }

  test.afterAll(async () => {
    await writeFile(resolve(evidenceRoot, 'night-sky.json'), `${JSON.stringify(Object.fromEntries(recorded), null, 2)}\n`, 'utf8')
  })
})
