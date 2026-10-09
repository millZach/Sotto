// PROTOTYPE — throwaway. Captures Settings > Cleanup with AI formatting on, so
// the section with and without the "Formatting quality" picker can be compared.
// Runs only when SOTTO_PROTOTYPE_OUT names a folder for the screenshots.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'

const out = process.env.SOTTO_PROTOTYPE_OUT
const sizes = [[1600, 1000], [1280, 800], [820, 560]] as const

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
    const host = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
    host.setMinimumSize(800, 540)
    host.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => launched.page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height])
}

test('prototype: Cleanup section captures', async () => {
  test.skip(out === undefined, 'Set SOTTO_PROTOTYPE_OUT to capture the prototype')
  test.setTimeout(180_000)
  await mkdir(out!, { recursive: true })
  const launched = await launchSotto()
  const { page } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on', llmFormatting: true })
    })
    await page.reload()
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    const tab = page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Cleanup', exact: true })
    for (const [width, height] of sizes) {
      await resize(launched, width, height)
      for (const mode of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), mode)
        await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
        await tab.click()
        await expect(tab).toHaveAttribute('aria-selected', 'true')
        await expect(page.getByRole('switch', { name: 'AI formatting' })).toHaveAttribute('aria-checked', 'true')
        await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0 })
        await page.mouse.move(1, 1)
        await page.screenshot({ path: join(out!, `cleanup-${width}-${mode}.png`), animations: 'disabled', caret: 'hide' })
      }
    }
  } finally {
    await closeSotto(launched)
  }
})
