// Usage: node scripts/with-nested-hyprland.mjs <scope-dir> node scripts/verify-linux-autostart-review.mjs <packaged-executable> <completed-profile> <evidence-dir>
// First run verify-linux-package.mjs to complete real onboarding. This checks isolated startup failures and moved entries without compositor key events.
/* global window, document, requestAnimationFrame */
import assert from 'node:assert/strict'
import console from 'node:console'
import process from 'node:process'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { chromium } from '@playwright/test'
import { fetchProofJson, openProofDebugger } from './proof-debugger.mjs'

const [input, completedInput, evidenceInput] = process.argv.slice(2)
assert.ok(input && completedInput && evidenceInput)
const executable = resolve(input)
const output = resolve(evidenceInput)
const completed = JSON.parse(readFileSync(join(resolve(completedInput), 'chromium/settings.json'), 'utf8'))
assert.equal(completed.onboardingComplete, true, 'Complete the real onboarding journey first')
const shellPid = execFileSync('pgrep', ['-x', 'quickshell']).toString().trim().split('\n')[0]
const liveSignature = readFileSync(`/proc/${shellPid}/environ`, 'utf8').split('\0').find(entry => entry.startsWith('HYPRLAND_INSTANCE_SIGNATURE=')).split('=')[1]
assert.notEqual(process.env.HYPRLAND_INSTANCE_SIGNATURE, liveSignature)
const compositor = JSON.parse(execFileSync('hyprctl', ['instances', '-j'], { encoding: 'utf8' })).find(item => item.instance === process.env.HYPRLAND_INSTANCE_SIGNATURE)
assert.equal(compositor?.pid, Number(process.env.SOTTO_PACKAGE_NESTED_PID), 'The wrapper must own the display')
mkdirSync(output, { recursive: true })
mkdirSync('.cache', { recursive: true })
const entry = fields => `[Desktop Entry]\nType=Application\n${fields}Exec="/deleted/Sotto/sotto"\nTryExec=/deleted/Sotto/sotto\n`
const cases = [
  ...[false, true].flatMap(enabled => ['EACCES', 'EISDIR'].map(error => ({ name: `${error}-${enabled}`, enabled, error }))),
  { name: 'write-EACCES', enabled: true, error: 'write-EACCES' },
  { name: 'stale-owned', enabled: true, contents: entry('Name=Sotto\nX-Sotto-Autostart=true\n'), refreshed: true },
  { name: 'unmarked', enabled: true, contents: entry('Name=Sotto\n') },
  { name: 'different-name', enabled: true, contents: entry('Name=Another app\nX-Sotto-Autostart=true\n') },
  { name: 'hidden', enabled: true, contents: entry('Name=Sotto\nX-Sotto-Autostart=true\nHidden=true\n') },
  { name: 'gnome-disabled', enabled: true, contents: entry('Name=Sotto\nX-Sotto-Autostart=true\nX-GNOME-Autostart-enabled=false\n') },
]
const results = []
for (const scenario of cases) {
  const root = join(output, scenario.name)
  const folder = join(root, 'config/autostart')
  const file = join(folder, 'sotto.desktop')
  assert.equal(existsSync(root), false, 'Use a fresh evidence directory')
  mkdirSync(folder, { recursive: true })
  mkdirSync(join(root, 'chromium'))
  writeFileSync(join(root, 'chromium/settings.json'), JSON.stringify({ ...completed, launchAtStartup: scenario.enabled, localHostEnabled: false }))
  if (scenario.error === 'EISDIR') mkdirSync(file)
  else if (scenario.error === 'EACCES') {
    writeFileSync(file, entry('Name=Sotto\nX-Sotto-Autostart=true\n'), { mode: 0o000 })
    assert.throws(() => readFileSync(file), { code: 'EACCES' })
  } else if (scenario.error === 'write-EACCES') chmodSync(folder, 0o500)
  else writeFileSync(file, scenario.contents)
  const runtime = mkdtempSync(resolve('.cache/ar-'))
  const env = { ...process.env, HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), XDG_RUNTIME_DIR: runtime,
    WAYLAND_DISPLAY: join(process.env.XDG_RUNTIME_DIR, process.env.WAYLAND_DISPLAY) }
  mkdirSync(env.HOME)
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, ['--inspect=9348', '--remote-debugging-port=9349', '--ozone-platform=wayland', `--user-data-dir=${join(root, 'chromium')}`], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  console.log(`autostart case ${scenario.name}: packaged PID ${child.pid}`)
  let stderr = '', inspector, browser
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  try {
    const deadline = Date.now() + 30000
    let target
    while (!target && Date.now() < deadline) {
      assert.equal(child.exitCode, null, 'Packaged startup must survive the autostart case')
      try { target = (await fetchProofJson('http://127.0.0.1:9348/json/list'))[0] } catch { await wait(100) }
    }
    assert.ok(target)
    inspector = await openProofDebugger(target.webSocketDebuggerUrl)
    assert.equal(await inspector.evaluate('process.pid', 15000, false), child.pid, 'The inspector must belong to this launch')
    let page
    while (!page && Date.now() < deadline) {
      try {
        browser ??= await chromium.connectOverCDP('http://127.0.0.1:9349')
        page = browser.contexts().flatMap(context => context.pages()).find(candidate => /\/index.html$/u.test(candidate.url()))
      } catch { /* Renderer is still starting. */ }
      if (!page) await wait(100)
    }
    assert.ok(page, 'The packaged renderer must open')
    const rendererSession = await page.context().newCDPSession(page)
    await rendererSession.send('Emulation.clearDeviceMetricsOverride')
    await page.getByRole('link', { name: 'Settings', exact: true }).waitFor()
    const tour = page.getByRole('button', { name: 'Skip tour', exact: true })
    if (await tour.isVisible()) await tour.click()
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Application', exact: true }).click()
    const toggle = page.getByRole('switch', { name: 'Launch when you sign in', exact: true })
    await toggle.waitFor()
    const state = await page.evaluate(() => window.sotto.getStartup())
    assert.deepEqual(state, { enabled: scenario.refreshed === true, supported: scenario.refreshed === true })
    assert.equal(await toggle.isEnabled(), scenario.refreshed === true)
    if (scenario.refreshed) {
      const saved = readFileSync(file, 'utf8')
      assert.ok(saved.includes(`Exec="${executable}"\n`))
      assert.ok(saved.includes(`TryExec=${executable}\n`))
      assert.ok(!saved.includes('/deleted/Sotto/sotto'))
      execFileSync('desktop-file-validate', [file])
      await toggle.click()
      await page.waitForFunction(() => document.querySelector('[role=switch][aria-label="Launch when you sign in"]')?.getAttribute('aria-checked') === 'false')
      assert.equal(existsSync(file), false)
    } else {
      await page.getByText('Sotto cannot change sign-in startup here.', { exact: true }).waitFor()
      if (scenario.error === 'EISDIR') assert.equal(statSync(file).isDirectory(), true)
      else if (scenario.error === 'EACCES') assert.equal(statSync(file).mode & 0o777, 0)
      else if (scenario.error === 'write-EACCES') assert.equal(existsSync(file), false)
      else assert.equal(readFileSync(file, 'utf8'), scenario.contents)
    }
    if (scenario.error) assert.ok(stderr.includes(scenario.error === 'write-EACCES' ? 'linux-autostart-write-failed' : 'linux-autostart-read-failed'), 'Only the expected stable autostart event is needed')
    if (scenario.name === 'EACCES-false') {
      // Use the same renderer viewport matrix as the Linux e2e specs. The normal
      // packaged journey separately measures the real native window at these sizes.
      for (const appearance of ['dark', 'light']) {
        await page.evaluate(appearance => window.sotto.updateSettings({ appearance, reducedMotion: 'on' }), appearance)
        for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
          await page.setViewportSize({ width, height })
          await page.waitForFunction(size => window.innerWidth === size.width && window.innerHeight === size.height, { width, height })
          await toggle.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }))
          await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))))
          const rect = await toggle.boundingBox()
          assert.ok(rect && rect.y >= 0 && rect.y + rect.height <= height, `Startup row must fit at ${appearance} ${width}x${height}: ${JSON.stringify(rect)}`)
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
          if (width === 820) await page.screenshot({ path: join('artifacts/linux-package', `settings-unavailable-${appearance}.png`) })
        }
      }
    }
    assert.equal(child.exitCode, null)
    const result = { case: scenario.name, ready: true, startup: state, preserved: !scenario.refreshed, refreshedAndRemoved: scenario.refreshed === true }
    results.push(result)
    console.log(JSON.stringify(result))
    await inspector.evaluate("setTimeout(() => process.mainModule.require('electron').app.quit(), 100); true", 15000, false)
  } finally {
    inspector?.close()
    await browser?.close().catch(() => undefined)
    if (child.exitCode === null) child.kill('SIGTERM')
    await Promise.race([new Promise(resolveExit => child.exitCode !== null ? resolveExit() : child.once('exit', resolveExit)), wait(5000)])
    if (child.exitCode === null) child.kill('SIGKILL')
    chmodSync(folder, 0o700)
    if (scenario.error === 'EACCES') chmodSync(file, 0o600)
    rmSync(runtime, { recursive: true, force: true })
  }
}
writeFileSync(join(output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
console.log(`packaged autostart review: ${results.length} cases passed`)
