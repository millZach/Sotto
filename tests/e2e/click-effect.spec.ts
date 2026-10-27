import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { onReleaseTrack } from './support/releaseTrack'
import { captureWindow } from './support/sottoCapture'
import { openThreads } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'

// The click effect (ADR-0154): a press sends waves of 0s and 1s in the accent through the room, under the page.
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

        await mkdir(evidence, { recursive: true })
        for (const [index, share] of [0.3, 0.55, 0.42].entries()) {
          const at = await openSpace(page, share)
          await page.mouse.click(at.x + (index - 1) * 220, at.y)
          await page.waitForTimeout(140)
        }
        await expect.poll(() => glyphs(page)).toBeGreaterThan(200)
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
