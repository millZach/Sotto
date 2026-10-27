// Captures the prototype at 2x, 1280x800: each variant at rest and with the pointer on a tick.
// Run: npm i --prefix /tmp/pw playwright@1.64.1 && NODE_PATH=/tmp/pw/node_modules node capture.cjs
const { chromium } = require('playwright')
const path = require('node:path')

;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
  for (const v of ['before', 'a', 'b', 'c']) {
    await page.goto(`file://${path.join(__dirname, 'index.html')}?v=${v}`)
    await page.waitForLoadState('load')
    await page.screenshot({ path: path.join(__dirname, `${v}-rest.png`) })
    const tick = await page.locator('.message-scrubber__tick').nth(5).boundingBox()
    await page.mouse.move(tick.x + tick.width - 24, tick.y + tick.height / 2)
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(__dirname, `${v}-hover.png`) })
  }
  await browser.close()
})()
