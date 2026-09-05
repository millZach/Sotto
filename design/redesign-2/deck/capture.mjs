/* global document, process */
// Renders every Deck variant × tab × theme to PNG at 2×, plus Home in the
// listening state. Run from the repo root: node design/redesign-2/deck/capture.mjs
import { chromium } from '@playwright/test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const variants = ['a-stage', 'b-rail', 'c-capsule']
const shots = [
  ['home', 'ready'], ['home', 'listening'], ['history', 'ready'], ['settings', 'ready'], ['help', 'ready'],
]
const themes = ['dark', 'light']

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 2 })
const page = await context.newPage()

for (const variant of variants) {
  const url = pathToFileURL(join(here, `${variant}.html`)).href
  for (const [view, state] of shots) {
    for (const theme of themes) {
      await page.goto(`${url}?view=${view}&theme=${theme}&state=${state}`)
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(state === 'listening' ? 450 : 250)
      const name = `${variant}-${view}${state === 'listening' ? '-listening' : ''}-${theme}.png`
      await page.locator('.window').screenshot({ path: join(here, name) })
      process.stdout.write(`${name}\n`)
    }
  }
}

await browser.close()
