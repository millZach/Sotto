const { chromium } = require(process.argv[2])
const { pathToFileURL } = require('node:url')
const { join } = require('node:path')
const fs = require('node:fs')
;(async () => {
  const site = process.argv[3]
  const out = join(site, '..', 'shots')
  fs.mkdirSync(out, { recursive: true })
  const browser = await chromium.launch()
  const errors = []
  for (const [w, h] of [[1280, 800], [820, 560]]) {
    const page = await browser.newPage({ viewport: { width: w, height: h } })
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('requestfailed', (r) => errors.push('failed ' + r.url().split('/').pop()))
    for (const f of fs.readdirSync(site).filter((f) => f.endsWith('.html') && f !== 'index.html' && f !== 'benchmark.html')) {
      await page.goto(pathToFileURL(join(site, f)).href)
      await page.waitForTimeout(150)
      await page.screenshot({ path: join(out, `${f.replace('.html', '')}-${w}.png`) })
    }
    await page.close()
  }
  console.log('errors:', [...new Set(errors)].join(' | ') || 'none')
  await browser.close()
})()
