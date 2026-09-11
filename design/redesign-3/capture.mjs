/* global document, process */
// Renders every direction × page × state to PNG at 2× so the mockups can be
// reviewed as pictures. Run from the repo root: node design/redesign-3/capture.mjs [direction]
// The orb is drawn once with `still=1` so captures are deterministic.
import { chromium } from '@playwright/test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const only = process.argv[2]
const directions = ['01-crossing', '02-harbor', '03-spine'].filter((d) => !only || d.startsWith(only))
const shots = [
  ['dictate-ready-dark', 'view=dictate&state=ready&theme=dark'],
  ['dictate-ready-light', 'view=dictate&state=ready&theme=light', { skip: ['01-crossing'] }],
  ['dictate-listening-dark', 'view=dictate&state=listening&theme=dark'],
  ['agents-wake', 'view=agents&orb=wake&still=1'],
  ['agents-listening', 'view=agents&orb=listening&still=1&color=ice'],
  ['agents-attention', 'view=agents&orb=working&still=1&attention=1'],
  ['agents-session', 'view=agents&orb=speaking&still=1&drawer=1&color=teal'],
  ['history', 'view=history', { only: ['01-crossing'] }],
  ['history-search', 'view=history&q=footer', { only: ['01-crossing'] }],
  ['history-empty', 'view=history&hist=none', { only: ['01-crossing'] }],
  ['settings', 'view=settings&still=1', { only: ['01-crossing'] }],
  ['settings-account', 'view=settings&sec=account&still=1', { only: ['01-crossing'] }],
  ['settings-server', 'view=settings&sec=transcription&guide=1&still=1', { only: ['01-crossing'] }],
  ['dictionary', 'view=dictionary', { only: ['01-crossing'] }],
  ['settings-application', 'view=settings&sec=application&still=1', { only: ['01-crossing'] }],
  ['threads', 'view=threads', { only: ['01-crossing'] }],
  ['threads-open-running', 'view=threads&open=1', { only: ['01-crossing'] }],
  ['threads-empty', 'view=threads&thr=none', { only: ['01-crossing'] }],
  ['threads-stopped', 'view=threads&open=5', { only: ['01-crossing'] }],
]

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1180, height: 800 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
const page = await context.newPage()

for (const direction of directions) {
  const url = pathToFileURL(join(here, `${direction}.html`)).href
  for (const [name, query, opts = {}] of shots) {
    if (opts.skip?.includes(direction)) continue;
    if (opts.only && !opts.only.includes(direction)) continue;
    await page.goto(`${url}?${query}`)
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(400)
    const path = join(here, `${direction}-${name}.png`)
    await page.locator('.window').screenshot({ path })
    process.stdout.write(`${direction}-${name}.png\n`)
  }
}

await browser.close()
