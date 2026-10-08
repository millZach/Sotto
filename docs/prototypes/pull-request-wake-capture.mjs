// PROTOTYPE - throwaway. Captures pull-request-wake-prototype.html into pull-request-wake-review/ for #822's pick.
// Run with any Playwright install: PW_MODULE=<path to playwright's index.mjs> node docs/prototypes/pull-request-wake-capture.mjs
// One browser, one page at a time. The prototype's own bar is hidden (bar=0); captions.txt names each image.
/* global process, console, document, getComputedStyle, innerWidth */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const { chromium } = await import(process.env.PW_MODULE ?? 'playwright')
const here = dirname(fileURLToPath(import.meta.url))
const file = pathToFileURL(join(here, 'pull-request-wake-prototype.html')).href
const out = join(here, 'pull-request-wake-review')
mkdirSync(out, { recursive: true })

const NAMES = { a: 'A, On the surface', b: 'B, In the transcript', c: 'C, A state of its own' }
const shots = []
for (const v of ['a', 'b', 'c']) {
  shots.push([`${v}-passed-1280x800-dark`, `variant=${v}&step=passed`, 1280, 800, `${NAMES[v]}: checks passed (two wake-ups in the thread), 1280x800, dark`])
  shots.push([`${v}-passed-1280x800-light`, `variant=${v}&step=passed&theme=light`, 1280, 800, `${NAMES[v]}: checks passed, 1280x800, light`])
  shots.push([`${v}-passed-820x560-dark`, `variant=${v}&step=passed`, 820, 560, `${NAMES[v]}: checks passed at the 820x560 minimum, dark (the project sidebar steps aside while Tools is open)`])
  shots.push([`${v}-agent-1280x800-dark`, `variant=${v}&step=agent`, 1280, 800, `${NAMES[v]}: started by the agent, 1280x800, dark`])
  shots.push([`${v}-received-1280x800-dark`, `variant=${v}&step=passed&open=last`, 1280, 800, `${NAMES[v]}: checks passed with what Claude received shown, 1280x800, dark`])
  shots.push([`${v}-merged-1280x800-dark`, `variant=${v}&step=merged`, 1280, 800, `${NAMES[v]}: merged, babysitting ended, 1280x800, dark`])
  shots.push([`${v}-settings-1280x800-dark`, `variant=${v}&settings=1`, 1280, 800, `${NAMES[v]}: the Settings switch's row, 1280x800, dark`])
}

const browser = await chromium.launch()
const captions = []
for (const [name, query, width, height, caption] of shots) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' })
  await page.goto(`${file}?${query}&bar=0`)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(120)
  const overflow = await page.evaluate(() => {
    const wide = []
    for (const el of document.querySelectorAll('body *')) {
      // The babysat badge's dot sits on its corner on purpose; it is drawn outside the pill, not clipped.
      if (el.closest('.proto, .winctl, .btb--pr') || el.getClientRects().length === 0) continue
      const style = getComputedStyle(el)
      if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX)) continue
      if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && style.display !== 'inline') wide.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`)
    }
    return { page: document.documentElement.scrollWidth > innerWidth, wide: wide.slice(0, 8) }
  })
  if (overflow.page || overflow.wide.length) console.log(name, 'overflow', JSON.stringify(overflow))
  await page.screenshot({ path: join(out, `${name}.png`) })
  captions.push(`${name}.png\t${caption}`)
  await page.close()
}
await browser.close()
writeFileSync(join(out, 'captions.txt'), captions.join('\n') + '\n')
console.log(`captured ${shots.length}`)
