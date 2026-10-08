// PROTOTYPE - throwaway. Captures pull-request-wake-prototype.html into pull-request-wake-review/ for #822's pick.
// Run with any Playwright install: PW_MODULE=<file URL of playwright's index.mjs> node docs/prototypes/pull-request-wake-capture.mjs
// One browser, one page at a time. The prototype's own bar is hidden (bar=0); captions.txt names each image.
// Each capture is checked for three things and the findings printed: anything wider than its box, text cut short
// with an ellipsis (named, so a cut the design accepts can be told from one it does not), and text under 4.5:1
// (3:1 for large text) against the colours actually painted behind it.
/* global process, console, document, getComputedStyle, innerWidth, Node */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const { chromium } = await import(process.env.PW_MODULE ?? 'playwright')
const here = dirname(fileURLToPath(import.meta.url))
const file = pathToFileURL(join(here, 'pull-request-wake-prototype.html')).href
const out = join(here, 'pull-request-wake-review')
mkdirSync(out, { recursive: true })

const NAMES = { a: 'A, A quiet line', b: 'B, On the badge', c: 'C, A state of its own' }
const shots = []
const add = (v, name, query, w, h, caption) => shots.push([`${v}-${name}`, `variant=${v}&${query}`, w, h, `${NAMES[v]}: ${caption}`])
for (const v of ['a', 'b', 'c']) {
  add(v, 'before-1280x800-dark', `step=before${v === 'c' ? '&menu=1' : ''}`, 1280, 800, v === 'c'
    ? 'before, with the ··· menu open to show where Babysit pull request starts it, 1280x800, dark'
    : `before, with the off ${v === 'a' ? 'switch in the surface’s foot' : 'button in the surface’s header'} that starts it, 1280x800, dark`)
  add(v, 'agent-1280x800-dark', 'step=agent', 1280, 800, 'started by the agent, 1280x800, dark')
  add(v, 'agent-1600x1000-light', 'step=agent&theme=light', 1600, 1000, 'started by the agent, 1600x1000, light')
  add(v, 'passed-1280x800-dark', 'step=passed', 1280, 800, 'checks passed (two wake-ups in the thread), 1280x800, dark')
  add(v, 'passed-1280x800-light', 'step=passed&theme=light', 1280, 800, 'checks passed, 1280x800, light')
  add(v, 'passed-1600x1000-dark', 'step=passed', 1600, 1000, 'checks passed, 1600x1000, dark')
  add(v, 'passed-820x560-dark', 'step=passed', 820, 560, 'checks passed at the 820x560 minimum, dark (the project sidebar steps aside while Tools is open)')
  add(v, 'passed-820x560-light', 'step=passed&theme=light', 820, 560, 'checks passed at the 820x560 minimum, light')
  if (v !== 'c') add(v, 'received-1280x800-dark', 'step=passed&open=last', 1280, 800, 'checks passed with what Claude received shown, 1280x800, dark')
  add(v, 'failed-1280x800-dark', 'step=failed', 1280, 800, 'a check failed and Claude is working on it, 1280x800, dark')
  add(v, 'queued-1280x800-dark', 'step=queued', 1280, 800, 'a wake-up waiting in the follow-up queue behind your own follow-up, 1280x800, dark')
  add(v, 'queued-820x560-dark', 'step=queued', 820, 560, 'a wake-up waiting in the queue at the 820x560 minimum, dark')
  add(v, 'merged-1280x800-dark', 'step=merged', 1280, 800, 'merged, babysitting ended, 1280x800, dark')
  add(v, 'unread-1280x800-dark', 'step=unread', 1280, 800, 'ended because GitHub could not be read for 16 minutes, 1280x800, dark')
  add(v, 'switchoff-1280x800-dark', 'step=switchoff', 1280, 800, 'the Settings switch turned off, so what Claude started has ended (Workshop, started by you, goes on), 1280x800, dark')
  add(v, 'two-1280x800-dark', 'step=two', 1280, 800, 'two pull requests babysat at once, 1280x800, dark')
  add(v, 'monitor-1280x800-dark', 'step=monitor', 1280, 800, 'Claude also monitors a deploy, and the Monitoring creature outranks babysitting, 1280x800, dark')
  add(v, 'remote-1280x800-dark', 'step=remote', 1280, 800, 'a thread on another computer: no tool, so you started it, and the wake-up says only you can stop it, 1280x800, dark')
  add(v, 'settings-1280x800-dark', 'settings=1', 1280, 800, `the Settings switch’s row in Settings → ${v === 'a' ? 'Git' : 'Application'}, 1280x800, dark`)
  add(v, 'settings-1280x800-light', 'settings=1&theme=light', 1280, 800, `the Settings switch’s row in Settings → ${v === 'a' ? 'Git' : 'Application'}, 1280x800, light`)
  add(v, 'settings-820x560-dark', 'settings=1', 820, 560, `the Settings switch’s row at the 820x560 minimum, dark`)
}

function audit() {
  const parse = (() => {
    const c = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    return value => {
      c.clearRect(0, 0, 1, 1); c.fillStyle = '#010203'; c.fillStyle = value; c.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = c.getImageData(0, 0, 1, 1).data
      return [r, g, b, a / 255]
    }
  })()
  const lum = ([r, g, b]) => { const f = x => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
  const over = (top, under) => { const a = top[3]; return [0, 1, 2].map(i => top[i] * a + under[i] * (1 - a)).concat(1) }
  const backdrop = el => {
    const layers = []
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const bg = parse(getComputedStyle(n).backgroundColor)
      if (bg[3] > 0) { layers.push(bg); if (bg[3] >= 1) break }
    }
    let base = parse(getComputedStyle(document.body).backgroundColor)
    for (const l of layers.reverse()) base = over(l, base)
    return base
  }
  const label = el => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`
  const wide = [], cut = [], low = []
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.proto, .winctl') || el.getClientRects().length === 0) continue
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden') continue
    const clips = ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX)
    if (!clips && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && style.display !== 'inline') wide.push(label(el))
    if (style.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth) cut.push(`${label(el)} "${el.textContent.trim().slice(0, 48)}"`)
    const own = [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim())
    if (!own || el.closest('[aria-hidden="true"]') || el.closest('svg')) continue
    const fg = parse(style.color)
    const bg = backdrop(el)
    const text = over(fg, bg)
    const [l1, l2] = [lum(text), lum(bg)].sort((x, y) => y - x)
    const ratio = (l1 + 0.05) / (l2 + 0.05)
    const size = parseFloat(style.fontSize)
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700)
    if (ratio < (large ? 3 : 4.5) && !el.closest('[aria-disabled="true"]')) low.push(`${label(el)} ${ratio.toFixed(2)} "${el.textContent.trim().slice(0, 30)}"`)
  }
  return { page: document.documentElement.scrollWidth > innerWidth, wide: wide.slice(0, 8), cut, low: low.slice(0, 12) }
}

const browser = await chromium.launch()
const captions = []
for (const [name, query, width, height, caption] of shots) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' })
  // A script error leaves a blank page that every check would pass, so it fails the run.
  page.on('pageerror', e => { console.log(name, 'SCRIPT ERROR', e.message); process.exitCode = 1 })
  await page.goto(`${file}?${query}&bar=0`)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(120)
  const found = await page.evaluate(audit)
  if (found.page || found.wide.length) console.log(name, 'OVERFLOW', JSON.stringify({ page: found.page, wide: found.wide }))
  if (found.cut.length) console.log(name, 'cut short:', found.cut.join(' | '))
  if (found.low.length) console.log(name, 'LOW CONTRAST:', found.low.join(' | '))
  await page.screenshot({ path: join(out, `${name}.png`) })
  captions.push(`${name}.png\t${caption}`)
  await page.close()
}
await browser.close()
writeFileSync(join(out, 'captions.txt'), captions.join('\n') + '\n')
console.log(`captured ${shots.length}`)
