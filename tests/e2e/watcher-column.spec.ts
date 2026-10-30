import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { BUILT_IN_THEMES } from '../../src/shared/themes/library'
import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { pageBoundProblems } from './support/designCapture'
import { onReleaseTrack } from './support/releaseTrack'
import { captureWindow } from './support/sottoCapture'
import { openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { holdOwlSky } from './support/sottoOwl'
import { resizeContentWindow } from './support/sottoWindow'
import { seedWatcherRoom } from './support/watcherRoom'

/**
 * Watcher's conversation column on the built app (the user's picks on October 23, 2026: D of
 * `docs/prototypes/watcher-floating-composer-prototype.html`, and B of `docs/prototypes/composer-shrink-prototype.html`):
 * the composer floats over the conversation as a thread's does, as frosted glass with the night scene under it; the
 * scene runs under the column at 85% and never moves for the words; reading back slims the composer to one line without
 * moving the scene. Every word in the conversation keeps 4.5:1 against every pixel the scene draws in the column, the
 * glow left out, in every built-in theme, dark and light, and in every place the scene can be set in (ADR-0149), and
 * the composer's words keep it against the glass over the brightest of the scene. Run after `npm run build`. Captures go to disposable run evidence;
 * `SOTTO_E2E_EVIDENCE=publish` writes artifacts/watcher-column.
 */
const evidence = evidenceDirectory('artifacts/watcher-column')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
// Every built-in, so a palette added or replaced is covered without editing this list.
const THEMES = BUILT_IN_THEMES.map(theme => theme.id)
const recorded: Record<string, unknown> = {}

function launchOptions(appearance: 'dark' | 'light', options: { readonly live?: boolean } = {}) {
  return {
    onboardingComplete: true, appearance, motion: 'normal', agents: 'design-threads',
    // The capture scenario holds every clock still, the scene's included, so a ripple is a still spot and no owl flies.
    // A live run lets them move, over the same fixture threads.
    scenario: options.live ? 'phase3-workspace' : 'design-threads',
    ...(appearance === 'dark' ? { darkTheme: 't3-code' } : { lightTheme: 't3-code' }),
  } as const
}

/** What the scene drew behind the words over the column in its last painted frame: ripple cells and owl glyphs. */
async function behindWords(page: Page): Promise<{ ripple: number; owl: number }> {
  const [ripple = 0, owl = 0] = (await page.evaluate(() => document.getElementById('watcher-pane')!.dataset.nightSceneBehind ?? '0,0')).split(',').map(Number)
  return { ripple, owl }
}

/** Pixels the owls' canvas, which lies over the words, paints over the column below the header. None, ever. */
async function owlsOverColumn(page: Page): Promise<number> {
  return page.evaluate(() => {
    const pane = document.getElementById('watcher-pane')!, base = pane.getBoundingClientRect()
    const canvas = pane.querySelector<HTMLCanvasElement>(':scope > canvas.watcher-scene--owl')!, scale = canvas.width / canvas.clientWidth
    const card = pane.querySelector(':scope > .thread-workspace__compose > .thread-prompt')!.getBoundingClientRect()
    const header = Math.max(...[...pane.querySelectorAll(':scope > :is(.watcher-head, .watcher-glance)')].map(node => node.getBoundingClientRect().bottom))
    const x0 = Math.round((card.left - base.left + 6) * scale), x1 = Math.round((card.right - base.left - 6) * scale)
    const y0 = Math.round((header - base.top) * scale), y1 = Math.round((card.top - base.top) * scale)
    const data = canvas.getContext('2d')!.getImageData(x0, y0, x1 - x0, y1 - y0).data
    let painted = 0
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) painted++
    return painted
  })
}

/** `release-notes` as a Watcher with a long conversation, watching three threads of the design fixture. */
async function seedRoom(page: Page): Promise<void> {
  await seedWatcherRoom(page, { watched: ['footer-links', 'visual-gate', 'weekly-note'], idPrefix: 'column' })
}

async function openRoom(page: Page): Promise<void> {
  await page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name: 'Watcher', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Watcher' })).toBeVisible()
  await expect(page.locator('#watcher-pane [data-message-id="column-23"]')).toBeVisible()
}

async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0)
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(done => setTimeout(done, 250))
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
}

async function capture(launched: LaunchedSotto, name: string): Promise<void> {
  await settle(launched.page)
  await holdOwlSky(launched.page)
  await captureWindow(launched.app, resolve(evidence, name))
}

/** Reads Watcher's conversation `fromEnd` pixels above its end, as a wheel would. */
async function readBack(page: Page, fromEnd: number): Promise<void> {
  await page.locator('#watcher-pane .thread-workspace__transcript').evaluate((log, fromEnd) => {
    log.scrollTop = log.scrollHeight - log.clientHeight - fromEnd
    log.dispatchEvent(new Event('scroll'))
  }, fromEnd)
}

const compose = (page: Page) => page.locator('#watcher-pane > .thread-workspace__compose')

/** A short digest of the landscape the scene draws under the column, so a change of even one glyph shows. */
async function columnDigest(page: Page): Promise<string> {
  return page.evaluate(() => {
    const pane = document.getElementById('watcher-pane')!
    const canvas = pane.querySelector<HTMLCanvasElement>(':scope > canvas.watcher-scene--land')!
    const card = pane.querySelector(':scope > .thread-workspace__compose > .thread-prompt')!.getBoundingClientRect()
    const base = pane.getBoundingClientRect(), scale = canvas.width / canvas.clientWidth
    const data = canvas.getContext('2d')!.getImageData(Math.round((card.left - base.left) * scale), 0, Math.round(card.width * scale), canvas.height).data
    let hash = 0
    for (let i = 0; i < data.length; i += 4) hash = (Math.imul(hash, 31) + data[i + 3]! * 7 + data[i]!) | 0
    return `${data.length}:${hash}`
  })
}

interface ColumnReading {
  readonly pixels: number
  /** The glass card's opacity, and the lowest contrast of its words over pure white and over pure black behind it. */
  readonly glassAlpha: number
  readonly backdrop: Record<string, number>
  readonly worstBackdrop: number
  /** The lowest contrast of each colour the conversation's words are written in, against the scene's pixels in the column. */
  readonly words: Record<string, number>
  /** The lowest contrast of the composer's placeholder and words against the glass over the brightest of the scene. */
  readonly glass: Record<string, number>
  readonly worstWord: number
  readonly worstGlass: number
}

/**
 * Every pixel the landscape paints in the column below the header, laid over the pane's surface as the screen shows it,
 * against every colour a word in the conversation is written in, the glow left out. Under the composer, the glass card's
 * colour over each of those pixels, unblurred (the blur only evens them out), against the placeholder and the composer's
 * own words.
 */
async function columnContrast(page: Page, extra: readonly string[] = []): Promise<ColumnReading> {
  return page.evaluate(extra => {
    const pane = document.getElementById('watcher-pane')!
    const pixel = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
    const rgba = (css: string): number[] => { pixel.clearRect(0, 0, 1, 1); pixel.fillStyle = 'rgba(0, 0, 0, 0)'; pixel.fillStyle = css; pixel.fillRect(0, 0, 1, 1); const d = pixel.getImageData(0, 0, 1, 1).data; return [d[0]!, d[1]!, d[2]!, d[3]! / 255] }
    const lin = (c: number): number => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
    const lum = (c: number[]): number => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!)
    const ratio = (a: number[], b: number[]): number => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
    const over = (under: number[], top: number[], alpha: number): number[] => under.slice(0, 3).map((c, k) => c + (top[k]! - c) * alpha)
    let surface = [0, 0, 0]
    for (let node: Element | null = pane; node !== null; node = node.parentElement) { const c = rgba(getComputedStyle(node).backgroundColor); if (c[3]! > 0) { surface = c.slice(0, 3); break } }
    // The colours words in the conversation are written in, where they sit on the scene rather than on a surface of their own.
    const log = pane.querySelector('.thread-workspace__transcript')!
    const own = ".thread-message[data-role='user'], pre, code, button, input, textarea, table, .agent-request, [class*='card'], [class*='chip']"
    const colours = new Map<string, number[]>()
    for (const element of log.querySelectorAll('*')) {
      if (element.closest(own) !== null || element.closest('[aria-hidden="true"]') !== null || ![...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.nodeValue!.trim())) continue
      const colour = getComputedStyle(element).color
      colours.set(colour, rgba(colour))
    }
    // Colours words take only for a moment, such as a link under the pointer.
    for (const colour of extra) colours.set(`${colour} (pointed at)`, rgba(colour))
    const formEl = pane.querySelector<HTMLElement>(':scope > .thread-workspace__compose > .thread-prompt')!
    const cardColour = rgba(getComputedStyle(formEl).backgroundColor)
    const inCard = new Map<string, number[]>()
    // The placeholder is drawn by a pseudo-element, so it is not read here; it is solid muted ink, a tier the glass
    // counts, and paintedTextPairs.ts holds it to 4.5:1 on the solid card (#1819).
    for (const element of formEl.querySelectorAll('*')) {
      // A decorative mark, such as the faint dot between New Watcher and the model, is not a word.
      if (element.closest('.tt-visually-hidden, [aria-hidden="true"]') !== null || ![...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.nodeValue!.trim())) continue
      if ((element as HTMLElement).offsetParent === null) continue
      const colour = getComputedStyle(element).color
      inCard.set(colour, rgba(colour))
    }
    const canvas = pane.querySelector<HTMLCanvasElement>(':scope > canvas.watcher-scene--land')!
    const base = pane.getBoundingClientRect(), card = formEl.getBoundingClientRect(), scale = canvas.width / canvas.clientWidth
    const header = Math.max(...[...pane.querySelectorAll(':scope > :is(.watcher-head, .watcher-glance)')].map(node => node.getBoundingClientRect().bottom))
    const x0 = Math.round((card.left - base.left) * scale), x1 = Math.round((card.right - base.left) * scale)
    const y0 = Math.round((header - base.top) * scale), y1 = canvas.height
    const data = canvas.getContext('2d')!.getImageData(x0, y0, x1 - x0, y1 - y0).data
    const words: Record<string, number> = {}, glass: Record<string, number> = {}
    for (const key of colours.keys()) words[key] = Number.POSITIVE_INFINITY
    for (const key of inCard.keys()) glass[key] = Number.POSITIVE_INFINITY
    // The pane's surface alone, for words over an empty stretch and for the glass over it.
    const bare = [surface]
    let pixels = 0
    const under = (x: number, y: number): boolean => x >= (card.left - base.left) * scale && x <= (card.right - base.left) * scale && y >= (card.top - base.top) * scale && y <= (card.bottom - base.top) * scale
    const visit = (colour: number[], x: number, y: number): void => {
      for (const [key, word] of colours) words[key] = Math.min(words[key]!, ratio(word, colour))
      if (under(x, y)) { const behind = over(colour, cardColour, cardColour[3]!); for (const [key, word] of inCard) glass[key] = Math.min(glass[key]!, ratio(word, behind)) }
    }
    for (const colour of bare) visit(colour, (card.left - base.left + 2) * scale, (card.top - base.top + 2) * scale)
    const w = x1 - x0
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3]! / 255
      if (alpha === 0) continue
      pixels++
      const p = i / 4
      visit(over(surface, [data[i]!, data[i + 1]!, data[i + 2]!], alpha), x0 + (p % w), y0 + Math.floor(p / w))
    }
    // Whatever passes under the glass, a white or black picture at worst, its words keep their contrast.
    const backdrop: Record<string, number> = {}
    for (const [name, behind] of [['white', [255, 255, 255]], ['black', [0, 0, 0]]] as const) {
      const surfaceUnder = over([...behind], cardColour, cardColour[3]!)
      for (const [key, word] of inCard) backdrop[`${key} over ${name}`] = ratio(over(surfaceUnder, word, word[3]!), surfaceUnder)
    }
    const round = (record: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, Math.round(value * 100) / 100]))
    return { pixels, glassAlpha: Math.round(cardColour[3]! * 100) / 100, backdrop: round(backdrop), worstBackdrop: Math.min(...Object.values(backdrop)),
      words: round(words), glass: round(glass), worstWord: Math.min(...Object.values(words)), worstGlass: Math.min(...Object.values(glass)) }
  }, extra)
}

test.describe("Watcher's conversation column on the built app", () => {
  test.describe.configure({ mode: 'serial', timeout: 6 * 60_000 })
  test.beforeAll(async () => { await mkdir(evidence, { recursive: true }) })
  test.afterAll(async () => {
    if (Object.keys(recorded).length > 0) await writeFile(resolve(evidence, 'readings.json'), `${JSON.stringify(recorded, null, 2)}\n`, 'utf8')
  })

  for (const appearance of ['dark', 'light'] as const) {
    test(`the composer floats as glass, slims while reading back, and the scene holds still, ${appearance}`, async () => {
      await onReleaseTrack('owl', () => withSotto(launchOptions(appearance), async (launched) => {
        const { page } = launched
        await openThreads(page)
        await seedRoom(page)
        await openRoom(page)
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height)
          await readBack(page, 0)
          await settle(page)
          expect(await pageBoundProblems(page), `room at ${width}x${height}`).toEqual([])
          // The composer floats: the conversation runs on under it, keeps room to bring its last line clear, and the strip
          // beside the card lets presses through.
          const float = await page.evaluate(() => {
            const pane = document.getElementById('watcher-pane')!
            const box = pane.querySelector<HTMLElement>(':scope > .thread-workspace__compose')!
            const log = pane.querySelector<HTMLElement>('.thread-workspace__transcript')!
            const card = box.querySelector(':scope > .thread-prompt')!.getBoundingClientRect()
            const last = [...log.querySelectorAll('.thread-transcript__content > *')].at(-1)!.getBoundingClientRect()
            const glass = getComputedStyle(box.querySelector(':scope > .thread-prompt')!)
            return { height: box.offsetHeight, marginTop: parseFloat(getComputedStyle(box).marginTop), padding: parseFloat(getComputedStyle(log).paddingBottom),
              lastClear: last.bottom <= box.getBoundingClientRect().top + 1, floorClear: card.bottom <= innerHeight,
              glass: { background: glass.backgroundColor, filter: glass.backdropFilter } }
          })
          const context = `${width}x${height} ${JSON.stringify(float)}`
          expect(float.marginTop, context).toBeCloseTo(-float.height, 0)
          expect(float.padding, context).toBeGreaterThanOrEqual(float.height)
          expect(float.lastClear, context).toBe(true)
          expect(float.floorClear, context).toBe(true)
          expect(float.glass.filter, context).toContain('blur(14px)')
          // At least the picked 72%, and thicker where the card's words need it over pure white or black.
          const glassAlpha = await page.evaluate(css => { const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); return ctx.getImageData(0, 0, 1, 1).data[3]! / 255 }, float.glass.background)
          expect(glassAlpha, context).toBeGreaterThanOrEqual(0.71)
          expect(glassAlpha, context).toBeLessThan(1)
          await capture(launched, `full-${appearance}-${width}x${height}.png`)

          // Reading back: the slim line, and the scene keeps every glyph where it was.
          const before = await columnDigest(page)
          await readBack(page, 420)
          await expect(compose(page)).toHaveAttribute('data-slim', 'true')
          await settle(page)
          expect(await columnDigest(page), `the scene under the column at ${width}x${height} as the composer slims and the words scroll`).toBe(before)
          expect(await pageBoundProblems(page), `slim at ${width}x${height}`).toEqual([])
          await capture(launched, `slim-${appearance}-${width}x${height}.png`)
          // Scrolling further moves the words and nothing in the scene.
          await readBack(page, 900)
          await settle(page)
          expect(await columnDigest(page), `the scene under the column at ${width}x${height} as the words scroll on`).toBe(before)
          // Back at the end, full again.
          await readBack(page, 0)
          await expect(compose(page)).not.toHaveAttribute('data-slim')
        }
        await resizeContentWindow(launched, 1280, 800)
        await expect(page.locator('#watcher-pane [data-message-id="column-23"]')).toBeVisible()
        // A key typed in the conversation goes to Watcher's composer, which comes back full.
        await readBack(page, 420)
        await expect(compose(page)).toHaveAttribute('data-slim', 'true')
        await page.locator('#watcher-pane .thread-workspace__transcript').focus()
        await page.keyboard.press('w')
        await expect(page.getByRole('textbox', { name: 'Watcher message' })).toBeFocused()
        await expect(compose(page)).not.toHaveAttribute('data-slim')
      }))
    })
  }

  for (const appearance of ['dark', 'light'] as const) {
    test(`every word keeps 4.5:1 over the scene in every built-in theme, ${appearance}`, async () => {
      await onReleaseTrack('owl', () => withSotto(launchOptions(appearance), async (launched) => {
        const { page } = launched
        await openThreads(page)
        await seedRoom(page)
        await openRoom(page)
        for (const [width, height] of [[1600, 1000], [1280, 800]] as const) {
          await resizeContentWindow(launched, width, height)
          for (const theme of THEMES) {
            await page.evaluate(async ([appearance, theme]) => window.sotto!.updateSettings(appearance === 'dark' ? { darkTheme: theme } : { lightTheme: theme }), [appearance, theme] as const)
            await expect(page.locator('html')).toHaveAttribute('data-theme-id', new RegExp(theme))
            await readBack(page, 0)
            await settle(page)
            // A link under the pointer takes its hover colour, which counts as one of the conversation's words.
            const link = page.locator('#watcher-pane .thread-workspace__transcript a').last()
            await link.hover()
            const pointedAt = await link.evaluate(element => getComputedStyle(element).color)
            await page.mouse.move(0, 0)
            await settle(page)
            const reading = await columnContrast(page, [pointedAt])
            // Watcher's names and times are in the secondary tier, never the muted one (pick D2), and a link is among the words.
            const tiers = await page.evaluate(() => {
              const log = document.querySelector('#watcher-pane .thread-workspace__transcript')!
              const probe = document.createElement('span'); log.append(probe)
              const colour = (token: string): string => { probe.style.color = `var(${token})`; return getComputedStyle(probe).color }
              const secondary = colour('--tt-text-2')
              probe.remove()
              const time = log.querySelector('.thread-message[data-role="assistant"] header time')
              return { secondary, time: time === null ? null : getComputedStyle(time).color, links: log.querySelectorAll('a').length }
            })
            expect(tiers.time, `${appearance} ${theme}`).toBe(tiers.secondary)
            expect(tiers.links, `${appearance} ${theme}`).toBeGreaterThan(0)
            recorded[`${appearance}-${theme}-${width}x${height}`] = { ...reading, cap: await page.evaluate(() => JSON.parse(document.getElementById('watcher-pane')!.dataset.nightSceneCap ?? 'null') as unknown) }
            const context = `${appearance} ${theme} ${width}x${height}: ${JSON.stringify(reading)}`
            // The column has a landscape to read against, and none of it takes a word under 4.5:1.
            expect(reading.pixels, context).toBeGreaterThan(0)
            expect(reading.worstWord, context).toBeGreaterThanOrEqual(4.5)
            expect(reading.worstGlass, context).toBeGreaterThanOrEqual(4.5)
            expect(reading.worstBackdrop, context).toBeGreaterThanOrEqual(4.5)
            expect(Object.keys(reading.words).some(key => key.endsWith('(pointed at)')), context).toBe(true)
          }
        }
      }))
    })
  }

  for (const appearance of ['dark', 'light'] as const) {
    test(`every word keeps 4.5:1 over the scene in every place, its moving glyphs included, ${appearance}`, async () => {
      await onReleaseTrack('owl', () => withSotto(launchOptions(appearance, { live: true }), async (launched) => {
        const { page } = launched
        await openThreads(page)
        await seedRoom(page)
        await openRoom(page)
        await resizeContentWindow(launched, 1280, 800)
        await readBack(page, 0)
        for (const place of ['harbour', 'snowfield', 'desert', 'night-wood'] as const) {
          await page.evaluate(async scene => { await window.sotto!.updateSettings({ watcherScene: scene }) }, place)
          await expect(page.locator('#watcher-pane')).toHaveAttribute('data-night-scene-place', place)
          await settle(page)
          // The last place's copy has faded; the snow, the sand and the beam move between readings.
          await page.waitForTimeout(700)
          let worst = Number.POSITIVE_INFINITY, worstGlass = Number.POSITIVE_INFINITY, pixels = 0
          for (let sample = 0; sample < 3; sample++) {
            const reading = await columnContrast(page)
            worst = Math.min(worst, reading.worstWord); worstGlass = Math.min(worstGlass, reading.worstGlass); pixels = Math.max(pixels, reading.pixels)
            await page.waitForTimeout(400)
          }
          recorded[`place-${place}-${appearance}`] = { worst, worstGlass, pixels }
          expect(pixels, `${place} ${appearance}`).toBeGreaterThan(0)
          expect(worst, `every word over ${place}, ${appearance}`).toBeGreaterThanOrEqual(4.5)
          expect(worstGlass, `every word on the glass over ${place}, ${appearance}`).toBeGreaterThanOrEqual(4.5)
        }
      }))
    })
  }

  for (const appearance of ['dark', 'light'] as const) {
    test(`a ripple from the margin runs on under the column, and every word keeps 4.5:1 over it, ${appearance}`, async () => {
      await onReleaseTrack('owl', () => withSotto(launchOptions(appearance, { live: true }), async (launched) => {
        const { page } = launched
        await openThreads(page)
        await seedRoom(page)
        await openRoom(page)
        await resizeContentWindow(launched, 1280, 800)
        await readBack(page, 0)
        await settle(page)
        expect((await behindWords(page)).ripple, 'no ripple before the press').toBe(0)
        const press = await page.evaluate(() => {
          const card = document.querySelector('#watcher-pane > .thread-workspace__compose > .thread-prompt')!.getBoundingClientRect()
          return { x: card.left - 40, y: card.top * 0.45 }
        })
        await page.mouse.click(press.x, press.y)
        let reached = 0
        let worst = Number.POSITIVE_INFINITY
        for (let sample = 0; sample < 14; sample++) {
          await page.waitForTimeout(100)
          const behind = (await behindWords(page)).ripple
          reached = Math.max(reached, behind)
          if (behind > 0) worst = Math.min(worst, (await columnContrast(page)).worstWord)
        }
        recorded[`ripple-${appearance}`] = { reached, worst }
        expect(reached, 'the ripple runs on under the column').toBeGreaterThan(0)
        expect(worst, 'every word over the ripple in the column').toBeGreaterThanOrEqual(4.5)
      }))
    })
  }

  test("an owl crossing the column shows behind the words, never over them, and leaves nothing behind", async () => {
    test.setTimeout(4 * 60_000)
    await onReleaseTrack('owl', () => withSotto(launchOptions('dark', { live: true }), async (launched) => {
      const { page } = launched
      // Every roll is 0: Watcher's owl leaves home after the shortest stay and flies to the other tree, across the column.
      await page.addInitScript(() => { Math.random = () => 0 })
      await openThreads(page)
      await seedRoom(page)
      await openRoom(page)
      await resizeContentWindow(launched, 1280, 800)
      await readBack(page, 0)
      await page.mouse.move(0, 0)
      const owl = page.locator('#watcher-pane > canvas.watcher-scene--owl')
      await expect(owl).toHaveAttribute('data-owl', 'flying', { timeout: 120_000 })
      let behind = 0
      let worst = Number.POSITIVE_INFINITY
      let over = 0
      for (let sample = 0; sample < 80 && await owl.getAttribute('data-owl') === 'flying'; sample++) {
        const now = (await behindWords(page)).owl
        if (now > 0) {
          behind = Math.max(behind, now)
          worst = Math.min(worst, (await columnContrast(page)).worstWord)
        }
        over = Math.max(over, await owlsOverColumn(page))
        await page.waitForTimeout(80)
      }
      await expect(owl).toHaveAttribute('data-owl', 'perched', { timeout: 10_000 })
      await page.waitForTimeout(300)
      recorded['owl-crossing'] = { behind, worst, over }
      expect(behind, 'owl glyphs drawn behind the words while it crossed').toBeGreaterThan(0)
      expect(worst, 'every word over the owl in the column').toBeGreaterThanOrEqual(4.5)
      expect(over, 'owl pixels over the words').toBe(0)
      expect((await behindWords(page)).owl, 'owl glyphs left behind the words after it landed').toBe(0)
    }))
  })
})
