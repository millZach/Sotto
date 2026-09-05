/* global document, process */
// Renders every direction × tab × theme to PNG at 2× so the mockups can be
// reviewed as pictures. Run from the repo root: node design/redesign-2/capture.mjs
import { chromium } from '@playwright/test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const directions = ['01-notebook', '02-deck', '03-tidepool']
const views = ['home', 'history', 'settings', 'help']
const themes = ['light', 'dark']

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 2 })
const page = await context.newPage()

for (const direction of directions) {
  const url = pathToFileURL(join(here, `${direction}.html`)).href
  for (const view of views) {
    for (const theme of themes) {
      await page.goto(`${url}?view=${view}&theme=${theme}`)
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(250)
      const path = join(here, `${direction}-${view}-${theme}.png`)
      await page.locator('.window').screenshot({ path })
      process.stdout.write(`${direction}-${view}-${theme}.png\n`)
    }
  }
}

await browser.close()
