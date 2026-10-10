// PROTOTYPE — throwaway. Saves the real HTML of the setup key step and Settings → Transcription and
// Cleanup, so the local-transcription variants can be drawn on the app's own markup and styles.
// Runs only when SOTTO_PROTOTYPE_OUT names a folder.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, finishFirstRunSetupFrom, launchSotto, reachFirstRunStep, resizeWindow } from './support/sottoLaunch'

const out = process.env.SOTTO_PROTOTYPE_OUT

async function save(page: Page, name: string): Promise<void> {
  await page.mouse.move(1, 1)
  const html = await page.evaluate(() => {
    document.querySelectorAll('script').forEach((script) => script.remove())
    return '<!doctype html>\n' + document.documentElement.outerHTML
  })
  await writeFile(join(out!, `${name}.html`), html)
  await page.screenshot({ path: join(out!, `${name}.png`) })
}

test('prototype: capture setup and Settings markup', async () => {
  test.skip(out === undefined, 'Set SOTTO_PROTOTYPE_OUT to capture the prototype')
  test.setTimeout(180_000)
  await mkdir(out!, { recursive: true })
  const launched = await launchSotto()
  const { page } = launched
  try {
    await resizeWindow(launched, 1280, 800)
    await reachFirstRunStep(page, 'key')
    await expect(page.getByRole('heading', { name: 'Connect your OpenRouter key' })).toBeVisible()
    await save(page, 'setup-key')
    await page.reload()
    await finishFirstRunSetupFrom(page, 'welcome')
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    for (const [tab, name] of [['Transcription', 'settings-transcription'], ['Cleanup', 'settings-cleanup']] as const) {
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: tab, exact: true }).click()
      await page.locator('.settings-scroll').evaluate((element) => { element.scrollTop = 0 })
      await save(page, name)
    }
  } finally {
    await closeSotto(launched)
  }
})
