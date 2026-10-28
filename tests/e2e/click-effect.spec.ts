import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { onReleaseTrack } from './support/releaseTrack'
import { captureWindow } from './support/sottoCapture'
import { openThreads } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'
import { seedWatcherRoom } from './support/watcherRoom'

// The click effect (ADR-0156): a press sends waves of 0s and 1s in the accent through the room, under the page.
const evidence = evidenceDirectory('artifacts/click-effect')

function launchOptions(appearance: 'dark' | 'light', options: { readonly clickEffect?: boolean; readonly motion?: 'normal' | 'reduced' } = {}) {
  return {
    onboardingComplete: true, appearance, scenario: 'design-threads', agents: 'design-threads',
    motion: options.motion ?? 'normal', clickEffect: options.clickEffect ?? true,
    ...(appearance === 'dark' ? { darkTheme: 't3-code' } : { lightTheme: 't3-code' }),
  } as const
}

const layer = (page: Page) => page.locator('canvas.click-effect')
const glyphs = (page: Page): Promise<number> => layer(page).evaluate(canvas => Number((canvas as HTMLCanvasElement).dataset.clickEffectGlyphs ?? 0))
const running = (page: Page): Promise<boolean> => layer(page).evaluate(canvas => (canvas as HTMLCanvasElement).dataset.clickEffectRunning === 'true')
const frames = (page: Page): Promise<number> => layer(page).evaluate(canvas => Number((canvas as HTMLCanvasElement).dataset.clickEffectFrames ?? 0))

async function openConversation(page: Page): Promise<void> {
  await openThreads(page)
  const toggle = page.getByRole('button', { name: 'Footer links', exact: true })
  await toggle.click({ position: { x: 16, y: 12 } })
  await expect(page.getByLabel('Thread transcript')).toContainText('Fixing the footer links')
}

/** A point in the conversation's open space, beside the column of messages. */
async function openSpace(page: Page, share: number): Promise<{ x: number; y: number }> {
  return page.getByLabel('Thread transcript').evaluate((transcript, at) => {
    const box = transcript.getBoundingClientRect()
    return { x: box.left + box.width * 0.5, y: box.top + box.height * at }
  }, share)
}

test.describe('the click effect', () => {
  test.describe.configure({ timeout: 4 * 60_000 })

  for (const appearance of ['dark', 'light'] as const) {
    test(`a press sends waves under the page that leave the press its target and stop when calm, ${appearance}`, async () => {
      await onReleaseTrack('owl', () => withSotto(launchOptions(appearance), async (launched) => {
        const { page } = launched
        await resizeContentWindow(launched, 1280, 800)
        await openConversation(page)
        await expect(layer(page)).toHaveCount(1)
        await expect(layer(page)).toHaveAttribute('aria-hidden', 'true')
        // Opening the thread was a press too; its waves calm, and then nothing runs until the next press.
        await expect.poll(() => running(page), { timeout: 30_000 }).toBe(false)
        const calm = await frames(page)
        await page.waitForTimeout(400)
        expect(await frames(page)).toBe(calm)
        // A press in the composer sends no waves.
        const composer = page.locator('.thread-prompt :is(.prompt-editor, textarea)').first()
        await composer.click()
        await page.locator('.thread-prompt').first().click({ position: { x: 8, y: 8 } })
        await page.waitForTimeout(400)
        expect(await running(page)).toBe(false)
        expect(await frames(page)).toBe(calm)

        await mkdir(evidence, { recursive: true })
        for (const [index, share] of [0.3, 0.55, 0.42].entries()) {
          const at = await openSpace(page, share)
          await page.mouse.click(at.x + (index - 1) * 220, at.y)
          await page.waitForTimeout(140)
        }
        await expect.poll(() => glyphs(page)).toBeGreaterThan(200)
        // No glyph is stronger than leaves every word over it at 4.5:1, nor than the effect's own 65%.
        const ceiling = await layer(page).evaluate(canvas => Number((canvas as HTMLCanvasElement).dataset.clickEffectCeiling))
        expect(ceiling).toBeGreaterThan(0)
        expect(ceiling).toBeLessThanOrEqual(0.65)
        for (const name of ['spreading', 'crossing']) {
          await captureWindow(launched.app, resolve(evidence, `${name}-${appearance}.png`))
          await page.waitForTimeout(450)
        }

        // While waves run, a press still reaches what it was aimed at: the composer takes focus and a thread opens.
        const prompt = page.locator('.thread-prompt :is(.prompt-editor, textarea)').first()
        await prompt.click()
        await expect(prompt).toBeFocused()
        const other = page.getByRole('button', { name: 'Streaming WAV stall', exact: true })
        await other.click({ position: { x: 16, y: 12 } })
        await expect(other).toHaveAttribute('aria-current', 'page')

        // The water calms, the canvas is cleared and the loop stops.
        await expect.poll(() => running(page), { timeout: 30_000 }).toBe(false)
        expect(await glyphs(page)).toBe(0)
        const stopped = await frames(page)
        await page.waitForTimeout(600)
        expect(await frames(page)).toBe(stopped)
      }))
    })
  }

  for (const [width, height] of [[1600, 1000], [820, 560]] as const) {
    test(`fills the window at ${width} by ${height}, at the ceiling as the canvas's own opacity`, async () => {
      await onReleaseTrack('owl', () => withSotto(launchOptions('dark'), async (launched) => {
        const { page } = launched
        await resizeContentWindow(launched, width, height)
        await openConversation(page)
        await expect.poll(() => running(page), { timeout: 30_000 }).toBe(false)
        const at = await openSpace(page, 0.4)
        await page.mouse.click(at.x, at.y)
        await expect.poll(() => glyphs(page)).toBeGreaterThan(50)
        const drawn = await layer(page).evaluate(canvas => {
          const c = canvas as HTMLCanvasElement
          return { width: c.width / devicePixelRatio, height: c.height / devicePixelRatio, innerWidth, innerHeight, opacity: Number(getComputedStyle(c).opacity), ceiling: Number(c.dataset.clickEffectCeiling) }
        })
        expect(drawn.width).toBe(drawn.innerWidth)
        expect(drawn.height).toBe(drawn.innerHeight)
        expect(drawn.opacity).toBeCloseTo(drawn.ceiling, 3)
        await mkdir(evidence, { recursive: true })
        await page.waitForTimeout(300)
        await captureWindow(launched.app, resolve(evidence, `spreading-dark-${width}x${height}.png`))
      }))
    })
  }

  test("in Watcher's room the waves keep to the margins, clear of the column the night scene already inks", async () => {
    await onReleaseTrack('owl', () => withSotto({ ...launchOptions('dark'), scenario: 'phase3-workspace' }, async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedWatcherRoom(page, { watched: ['footer-links', 'visual-gate', 'weekly-note'], idPrefix: 'column' })
      await page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name: 'Watcher', exact: true }).click()
      await expect(page.getByRole('heading', { level: 1, name: 'Watcher' })).toBeVisible()
      await resizeContentWindow(launched, 1280, 800)
      await expect.poll(() => running(page), { timeout: 30_000 }).toBe(false)
      const press = await page.evaluate(() => {
        const card = document.querySelector('#watcher-pane > .thread-workspace__compose > .thread-prompt')!.getBoundingClientRect()
        return { x: card.left - 40, y: card.top * 0.5 }
      })
      await page.mouse.click(press.x, press.y)
      await expect.poll(() => glyphs(page)).toBeGreaterThan(50)
      const lit = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('canvas.click-effect')!, scale = canvas.width / innerWidth
        const card = document.querySelector('#watcher-pane > .thread-workspace__compose > .thread-prompt')!.getBoundingClientRect()
        const count = (x0: number, x1: number, y0: number, y1: number): number => {
          const data = canvas.getContext('2d')!.getImageData(Math.round(x0 * scale), Math.round(y0 * scale), Math.round((x1 - x0) * scale), Math.round((y1 - y0) * scale)).data
          let n = 0
          for (let i = 3; i < data.length; i += 4) if (data[i]) n++
          return n
        }
        return { column: count(card.left + 2, card.right - 2, 120, innerHeight - 10), margin: count(0, card.left - 2, 120, innerHeight - 10) }
      })
      expect(lit.column).toBe(0)
      expect(lit.margin).toBeGreaterThan(0)
    }))
  })

  test('no glyph is drawn under text selected while waves run, whose own fill lies over them', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('dark'), async (launched) => {
      const { page } = launched
      await resizeContentWindow(launched, 1280, 800)
      await openConversation(page)
      await expect.poll(() => running(page), { timeout: 30_000 }).toBe(false)
      const reply = page.locator('.thread-message:not([data-role="user"]) p').first()
      const box = (await reply.boundingBox())!
      for (const dx of [-160, 0, 160]) await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height + 24)
      await expect.poll(() => glyphs(page)).toBeGreaterThan(50)
      await reply.evaluate(paragraph => { getSelection()!.selectAllChildren(paragraph) })
      await page.waitForTimeout(250)
      const lit = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('canvas.click-effect')!, scale = canvas.width / innerWidth
        const selected = getSelection()!.getRangeAt(0).getBoundingClientRect()
        const count = (x0: number, x1: number, y0: number, y1: number): number => {
          const data = canvas.getContext('2d')!.getImageData(Math.round(x0 * scale), Math.round(y0 * scale), Math.max(1, Math.round((x1 - x0) * scale)), Math.max(1, Math.round((y1 - y0) * scale))).data
          let n = 0
          for (let i = 3; i < data.length; i += 4) if (data[i]) n++
          return n
        }
        return { selected: count(selected.left, selected.right, selected.top, selected.bottom), still: getSelection()!.toString().length, room: count(0, innerWidth, selected.bottom + 4, innerHeight) }
      })
      expect(lit.still).toBeGreaterThan(0)
      expect(lit.selected).toBe(0)
      expect(lit.room).toBeGreaterThan(0)
    }))
  })

  test('a theme changed while waves run takes the new accent in the next frames', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('dark'), async ({ page }) => {
      await openConversation(page)
      await expect.poll(() => running(page), { timeout: 30_000 }).toBe(false)
      const at = await openSpace(page, 0.4)
      await page.mouse.click(at.x, at.y)
      await expect.poll(() => running(page)).toBe(true)
      const before = await layer(page).evaluate(canvas => (canvas as HTMLCanvasElement).dataset.clickEffectInk)
      await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'light' }))
      await expect.poll(() => layer(page).evaluate(canvas => (canvas as HTMLCanvasElement).dataset.clickEffectInk)).not.toBe(before)
      expect(await running(page)).toBe(true)
    }))
  })

  test('the switch in Settings turns it off, and the setting is saved', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('dark'), async ({ page }) => {
      await openConversation(page)
      await expect(layer(page)).toHaveCount(1)
      await page.evaluate(() => window.sotto!.updateSettings({ clickEffect: false }))
      await expect(layer(page)).toHaveCount(0)
      expect(await page.evaluate(() => window.sotto!.getSettings().then(settings => settings.clickEffect))).toBe(false)
    }))
  })

  test('stable holds it, and reduced motion leaves nothing of it', async () => {
    await onReleaseTrack('stable', () => withSotto(launchOptions('dark'), async ({ page }) => {
      await openConversation(page)
      await expect(layer(page)).toHaveCount(0)
    }))
    await onReleaseTrack('owl', () => withSotto(launchOptions('dark', { motion: 'reduced' }), async ({ page }) => {
      await openConversation(page)
      await expect(layer(page)).toHaveCount(0)
    }))
  })
})
