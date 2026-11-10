// PROTOTYPE, throwaway. Opens the prototype in headless Chromium and takes pictures of it, so its builder can look at
// what it draws. Run: node _build/shots.cjs <plan.json>, where the plan is a list of
// { name, query, width, height, wait, run?, clip? }: `run` is script evaluated in the page before the wait.
const { execSync } = require('node:child_process')
const { createRequire } = require('node:module')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const here = __dirname
let load
try { require.resolve('@playwright/test'); load = require } catch {
  const common = execSync('git rev-parse --path-format=absolute --git-common-dir', { cwd: here }).toString().trim()
  load = createRequire(path.join(path.dirname(common), 'package.json'))
}
const { chromium } = load('@playwright/test')

;(async () => {
  const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  const out = path.join(here, 'shots')
  fs.mkdirSync(out, { recursive: true })
  const browser = await chromium.launch()
  for (const shot of plan) {
    const page = await browser.newPage({ deviceScaleFactor: shot.scale || 1, viewport: { width: shot.width || 1600, height: shot.height || 1000 }, reducedMotion: shot.reducedMotion ? 'reduce' : 'no-preference' })
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.goto(shot.url || pathToFileURL(path.join(here, '..', 'index.html')).href + '?' + (shot.query || ''))
    await page.waitForFunction(() => window.ProtoScene !== undefined && document.querySelector('.watcher-pane') !== null)
    await page.waitForTimeout(shot.settle || 600)
    if (shot.run) await page.evaluate(shot.run)
    for (const step of shot.steps || [{ wait: shot.wait || 1000, name: shot.name }]) {
      if (step.run) await page.evaluate(step.run)
      if (step.move) await page.mouse.move(step.move[0], step.move[1], { steps: 6 })
      if (step.click) await page.mouse.click(step.click[0], step.click[1])
      if (step.key) await page.keyboard.press(step.key)
      await page.waitForTimeout(step.wait || 0)
      if (step.name) await page.screenshot({ path: path.join(out, step.name + '.png'), ...(step.clip || shot.clip ? { clip: step.clip || shot.clip } : {}) })
    }
    if (errors.length > 0) console.log(shot.name || shot.query, 'ERRORS:', errors.slice(0, 5).join(' | '))
    if (shot.report) console.log(shot.name || shot.query, JSON.stringify(await page.evaluate('(' + shot.report + ')()')))
    await page.close()
  }
  await browser.close()
  console.log('shots done')
})().catch(error => { console.error(error); process.exit(1) })
