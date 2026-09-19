// PROTOTYPE — throwaway. Captures composer-selectors-prototype.html into artifacts/composer-selectors-prototypes/.
/* global process, console, document */
const { chromium } = await import(process.env.PW_MODULE ?? 'playwright')
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const file = pathToFileURL(resolve('docs/prototypes/composer-selectors-prototype.html')).href
const out = 'artifacts/composer-selectors-prototypes'
const browser = await chromium.launch()
const shots = []
for (const variant of ['a', 'b', 'c']) {
  shots.push([`${variant}-closed`, `variant=${variant}`, { width: 1280, height: 800 }])
  shots.push([`${variant}-model`, `variant=${variant}&open=model`, { width: 1280, height: 800 }])
  shots.push([`${variant}-effort`, `variant=${variant}&open=effort`, { width: 1280, height: 800 }])
  shots.push([`${variant}-mode`, `variant=${variant}&open=mode`, { width: 1280, height: 800 }])
  shots.push([`${variant}-model-started`, `variant=${variant}&open=model&started=1`, { width: 1280, height: 800 }])
  shots.push([`${variant}-model-light`, `variant=${variant}&open=model&theme=light`, { width: 1280, height: 800 }])
  shots.push([`${variant}-model-820`, `variant=${variant}&open=model`, { width: 820, height: 560 }])
}
for (const [name, query, viewport] of shots) {
  const page = await browser.newPage({ viewport, reducedMotion: 'reduce' })
  await page.goto(`${file}?${query}`)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(150)
  await page.screenshot({ path: `${out}/${name}.png` })
  await page.close()
}
await browser.close()
console.log(`captured ${shots.length}`)
