import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeSotto, firstRunForwardButton, launchSotto, resizeWindow } from './support/sottoLaunch'

/** Sotto's default window, the smallest it allows (`src/main/windows/windowManager.ts`), and the two larger sizes every UI change is checked at. */
const SIZES = [[1080, 720], [820, 560], [1280, 800], [1600, 1000]] as const

/**
 * Every first-run step fits its card with nothing to scroll, at the window Sotto opens with, at the minimum and larger. The
 * steps once scrolled at 1080x720 because they were drawn at 1280x800. The microphone step is measured after its test
 * has heard a voice, and each size is captured light and dark.
 */
test('every first-run setup step fits the default window, the minimum and larger ones without scrolling', async () => {
  test.setTimeout(240_000)
  const launched = await launchSotto()
  const { page } = launched
  const evidence = resolve('artifacts/first-run-setup-fit')
  await mkdir(evidence, { recursive: true })
  const overflows: string[] = []
  const checks: { step: string; width: number; height: number; overflow: number }[] = []
  try {
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'on' }))
    const body = page.locator('.onboarding-card__body')
    for (let step = 1; step <= 9; step += 1) {
      const title = (await page.locator('.onboarding-progress__text').textContent() ?? '').replace(/^Step \d+ of 9 · /u, '')
      if (step === 3) {
        await page.getByRole('button', { name: 'Test microphone', exact: true }).click()
        await expect(page.getByText('Sotto heard you. Your microphone works.')).toBeVisible()
      }
      for (const [width, height] of SIZES) {
        await resizeWindow(launched, width, height)
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
          await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
          const overflow = await body.evaluate(element => element.scrollHeight - element.clientHeight)
          checks.push({ step: title, width, height, overflow })
          if (overflow > 0) overflows.push(`${title} at ${width}x${height} ${appearance} scrolls ${overflow}px`)
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          await page.screenshot({ path: resolve(evidence, `step-${step}-${width}x${height}-${appearance}.png`) })
        }
      }
      await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
      if (step === 1) await page.getByRole('button', { name: 'Get started' }).click()
      else if (step < 9) await firstRunForwardButton(page).click()
      if (step < 9) await expect(page.locator('.onboarding-progress__text')).toContainText(`Step ${step + 1} of 9`)
    }
    expect(overflows).toEqual([])
  } finally {
    await writeFile(resolve(evidence, 'checks.json'), `${JSON.stringify(checks, null, 2)}\n`)
    await closeSotto(launched)
  }
})
