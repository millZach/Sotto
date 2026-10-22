// Usage: mise exec node@24.22.1 -- node tools/verify-omarchy-theme-prototype.mjs [evidence-directory]
/* global Element, window, document, CHECKS, MAPS, THEMES, build, ratio, innerWidth */
import assert from 'node:assert/strict'
import console from 'node:console'
import process from 'node:process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL, URL, URLSearchParams } from 'node:url'
import { chromium } from '@playwright/test'

const out = resolve(process.argv[2] ?? '/tmp/sotto-933-proof')
mkdirSync(out, { recursive: true })
const url = pathToFileURL(resolve('docs/prototypes/omarchy-theme-prototype.html')).href
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true })
const errors = []
const results = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  for (const hash of ['#map=constructor', '#theme=__proto__', '#theme=constructor', '#map=__proto__']) {
    await page.goto(url + hash)
    await page.locator('#deskFrame > *').waitFor()
    const state = Object.fromEntries(new URLSearchParams(new URL(page.url()).hash.slice(1)))
    assert.equal(state.map, 'm3')
    assert.equal(state.theme, 'tokyo-night')
    results.push({ hash, map: state.map, theme: state.theme })
  }
  await page.addInitScript(() => {
    const scroll = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (options) {
      window.prototypeScroll = options
      scroll.call(this, options)
    }
  })
  for (const [system, checkbox, expected] of [
    ['reduce', false, 'auto'], ['no-preference', true, 'auto'], ['no-preference', false, 'smooth'],
  ]) {
    await page.emulateMedia({ reducedMotion: system })
    await page.goto(url)
    await page.locator('#motion').setChecked(checkbox)
    for (const key of ['Enter', 'Space']) {
      const button = page.locator('[data-theme-pick="nord"]')
      await button.focus()
      await page.keyboard.press(key)
      assert.equal(await page.locator('#pickTheme').evaluate(el => el === document.activeElement), true)
      assert.equal(await page.locator('#pickTheme').inputValue(), 'nord')
      assert.equal(await page.evaluate(() => window.prototypeScroll.behavior), expected)
      await page.keyboard.press('Tab')
      assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'BODY')
    }
    results.push({ system, checkbox, behavior: expected, keys: ['Enter', 'Space'], focus: 'pickTheme' })
  }
  const contrast = await page.evaluate(() => {
    const checks = CHECKS.filter(check => check.id === 'muted' || check.id === 'sidemuted')
    const measured = []
    for (const map of Object.keys(MAPS)) for (const id of Object.keys(THEMES)) {
      const b = build(map, THEMES[id], THEMES[id].mode, true)
      for (const check of checks) for (const surface of check.on) {
        measured.push({ map, theme: id, foreground: check.fg, surface, ratio: ratio(b.paint[check.fg], b.paint[surface]) })
      }
    }
    return measured
  })
  assert.equal(contrast.length, 3 * 22 * 7)
  assert.ok(contrast.every(pair => pair.ratio >= 4.5 - 1e-9), JSON.stringify(contrast.filter(pair => pair.ratio < 4.5 - 1e-9)))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560], [390, 844]]) {
    await page.setViewportSize({ width, height })
    for (const theme of ['tokyo-night', 'catppuccin-latte']) {
      await page.goto(`${url}#theme=${theme}`)
      await page.locator('#deskFrame > *').waitFor()
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Overflow at ${width}, ${theme}`)
      await page.screenshot({ path: join(out, `${theme}-${width}x${height}.png`) })
    }
  }
  assert.deepEqual(errors, [])
  writeFileSync(join(out, 'proof.json'), JSON.stringify({ results, contrast, errors }, null, 2) + '\n')
  console.log(`Verified hash fallback, keyboard focus, reduced motion, ${contrast.length} muted contrast pairs, four widths in light and dark, and no console errors. Evidence: ${out}`)
} finally {
  await browser.close()
}
