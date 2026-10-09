import { expect, test, type Locator } from '@playwright/test'
import type { LaunchedSotto } from './sottoLaunch'
import { resizeWindow } from './sottoWindow'

/** Host settings matrix, retaining each journey's checks between sizing and capture. */
export async function captureHostMatrix(launched: LaunchedSotto, name: string, check: () => Promise<void>,
  options: { checkBeforeOverflow?: boolean } = {}): Promise<void> {
  const { page } = launched
  for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
    await resizeWindow(launched, width, height)
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      if (options.checkBeforeOverflow) await check()
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      if (!options.checkBeforeOverflow) await check()
      await page.screenshot({ path: test.info().outputPath(`${name}-${width}x${height}-${appearance}.png`), animations: 'disabled' })
    }
  }
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
  await resizeWindow(launched, 1280, 800)
}

/** Half-pixel geometry tolerance; overflow is checked only by callers that previously requested it. */
export function insideWindow(locator: Locator, checkOverflow = false): Promise<boolean> {
  return locator.evaluate((element, checkOverflow) => {
    const box = element.getBoundingClientRect()
    return box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5 &&
      (!checkOverflow || element.scrollWidth <= element.clientWidth + 1)
  }, checkOverflow)
}
