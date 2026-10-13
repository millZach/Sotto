// Usage: node scripts/with-nested-hyprland.mjs .cache/codex-terminal-state/nested node scripts/verify-codex-terminal-state.mjs [packaged-executable]
// Runs one synthetic GPT-6-Luna turn in an isolated profile; requires installed Codex sign-in and an owned nested display.
/* global window */
import assert from 'node:assert/strict'
import console from 'node:console'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { stripVTControlCharacters } from 'node:util'
import { _electron as electron, expect } from '@playwright/test'
import { readAsarText } from './asar-entries.mjs'

assert.ok(process.env.SOTTO_PACKAGE_NESTED_PID, 'Use the owned nested Hyprland wrapper')
const compositor = JSON.parse(execFileSync('hyprctl', ['instances', '-j'], { encoding: 'utf8' }))
  .find(item => item.instance === process.env.HYPRLAND_INSTANCE_SIGNATURE)
assert.equal(compositor?.pid, Number(process.env.SOTTO_PACKAGE_NESTED_PID))
const root = await mkdtemp(resolve('.cache/c950-'))
let app
let page
const errors = []
try {
  const temporary = resolve('.cache/t')
  await mkdir(temporary, { recursive: true })
  const home = join(root, 'home'), profile = join(root, 'profile'), project = home, codexHome = join(root, 'codex')
  const evidence = resolve('artifacts/codex-terminal-state')
  for (const folder of [home, profile, codexHome, evidence]) await mkdir(folder, { recursive: true, mode: 0o700 })
  execFileSync('git', ['init', '-q', project])
  await copyFile(join(process.env.HOME, '.codex/auth.json'), join(codexHome, 'auth.json'))
  await chmod(join(codexHome, 'auth.json'), 0o600)
  await writeFile(join(codexHome, 'config.toml'), `[projects."${project}"]\ntrust_level = "trusted"\n`)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ onboardingComplete: true, showWidgetWhenIdle: false, reducedMotion: 'on', phoneAccess: false }))
  const codex = execFileSync('mise', ['which', 'codex'], { encoding: 'utf8' }).trim()
  const version = execFileSync(codex, ['--version'], { encoding: 'utf8' }).trim()
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'), TMPDIR: temporary,
    PATH: dirname(codex) + ':' + process.env.PATH, SHELL: '/bin/bash', SOTTO_CODEX_PROOF_PROFILE: profile }
  for (const key of Object.keys(env)) if (/^(CODEX_|CLAUDE|SOTTO_E2E)/u.test(key) && key !== 'CODEX_HOME') delete env[key]
  delete env.ELECTRON_RUN_AS_NODE
  const packaged = process.argv[2]
  const mainHash = createHash('sha256').update(await readFile('out/main/index.js')).digest('hex')
  if (packaged) assert.equal(createHash('sha256').update(readAsarText(join(dirname(resolve(packaged)), 'resources/app.asar'), 'out/main/index.js')).digest('hex'), mainHash)
  const entry = join(root, 'main.cjs')
  await writeFile(entry, `const {app}=require('electron'); app.setPath('userData', process.env.SOTTO_CODEX_PROOF_PROFILE); require(${JSON.stringify(resolve('out/main/index.js'))});\n`)
  // The bootstrap lives below the checkout so its Electron require resolves this checkout's installed binary.
  app = await electron.launch({ ...(packaged ? { executablePath: resolve(packaged), args: ['--ozone-platform=wayland'] } : { args: [entry, '--ozone-platform=wayland'] }), env, timeout: 60000 })
  console.log(`proof app PID: ${app.process().pid}; ${version}`)
  page = await app.firstWindow()
  await page.waitForLoadState('load')
  if (!page.url().endsWith('/index.html')) page = await app.waitForEvent('window', { predicate: candidate => candidate.url().endsWith('/index.html'), timeout: 30000 })
  await page.waitForFunction(() => !!window.sotto?.agents)
  await expect.poll(async () => {
    try { await page.evaluate(() => window.sotto.agents.get()); return true } catch { return false }
  }, { timeout: 30000 }).toBe(true)
  if (packaged) {
    await page.evaluate(() => window.sotto.updateSettings({ onboardingComplete: true, showWidgetWhenIdle: false, reducedMotion: 'on' }))
    await page.reload()
  }
  page.on('pageerror', error => errors.push(error.message))
  const metadata = { ...await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged, executable: process.execPath, userData: app.getPath('userData') })),
    sourceVersion: JSON.parse(await readFile('package.json', 'utf8')).version, mainSha256: mainHash }
  const capture = async path => {
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))
      return (await window.webContents.capturePage()).toPNG().toString('base64')
    })
    await writeFile(path, Buffer.from(png, 'base64'))
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setSize(1600, 1000))
  const command = async value => {
    const result = await page.evaluate(value => window.sotto.agents.command(value), value)
    assert.ok(!result.error, result.error)
    return result
  }
  await command({ type: 'configure', patch: { provider: 'codex', enabled: true, enabledProviders: ['codex'], reasoning: 'none', checkClientUpdates: false } })
  await command({ type: 'connect', provider: 'codex' })
  await expect.poll(async () => (await page.evaluate(() => window.sotto.agents.get())).host.models.some(model => model.ready && /gpt-6-luna$/iu.test(model.id)), { timeout: 60000 }).toBe(true)
  await command({ type: 'create-project', provider: 'codex', title: 'Codex state check', path: project, useExisting: true })
  if (!await page.locator('.threads-view').isVisible()) {
    const link = page.getByRole('link', { name: 'Threads', exact: true })
    if (await link.count()) await link.click()
    else await page.getByRole('tab', { name: 'Threads', exact: true }).click()
  }
  await page.getByRole('radio', { name: 'Terminal', exact: true }).click()
  const sidebar = page.getByRole('complementary', { name: 'Terminal sidebar', exact: true })
  await sidebar.getByRole('button', { name: 'New terminal in Codex state check', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New terminal', exact: true })
  await dialog.getByLabel('Terminal name', { exact: true }).fill('Say hi')
  await dialog.getByLabel('Terminal provider', { exact: true }).selectOption('codex')
  await dialog.getByRole('combobox', { name: 'Thread model', exact: true }).click()
  await page.getByRole('dialog', { name: 'Choose model', exact: true }).getByRole('option', { name: /GPT-6-Luna/iu }).click()
  await dialog.getByLabel('Terminal reasoning', { exact: true }).selectOption('low')
  await dialog.getByRole('button', { name: 'Open terminal', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const id = await page.evaluate(async () => {
    const listing = await window.sotto.terminals.list()
    if (!listing.ok) throw new Error(listing.error.message)
    return listing.value.terminals.find(terminal => terminal.title === 'Say hi').id
  })
  let replied = false
  const read = async () => {
    const current = await page.evaluate(async id => {
      const result = await window.sotto.terminals.read({ id })
      if (!result.ok) throw new Error(result.error.message)
      return { state: result.value.terminal.agentState, detection: result.value.terminal.stateDetection, output: result.value.output }
    }, id)
    const output = stripVTControlCharacters(current.output)
    return { state: current.state, detection: current.detection, replied, nativeWork: /\bWorking\b/u.test(output) }
  }
  await expect.poll(async () => (await read()).state, { timeout: 45000 }).toBe('idle')
  const input = page.locator('.terminal-pane .xterm-helper-textarea')
  await input.pressSequentially('Say hi', { delay: 30 }); await wait(300); await input.press('Enter')
  await expect.poll(async () => {
    const current = await read()
    return current.state === 'working' && current.nativeWork
  }, { timeout: 30000, intervals: [50, 100] }).toBe(true)
  await expect(sidebar.locator('.terminal-nav__row[data-terminal-state="working"]')).toHaveCount(1)
  const suffix = packaged ? 'packaged' : 'built'
  await capture(join(evidence, `${suffix}-working.png`))
  await expect.poll(async () => (await read()).state, { timeout: 60000 }).toBe('idle')
  // Search the rendered terminal buffer: native incremental redraws can split the reply across PTY writes.
  await input.press('Control+f')
  const search = page.getByRole('search', { name: 'Search terminal output', exact: true })
  const query = search.getByRole('textbox', { name: 'Find in terminal', exact: true })
  await query.fill('Hi!')
  await expect.poll(async () => {
    await query.press('Enter')
    return search.locator('output').textContent()
  }, { timeout: 60000 }).toMatch(/(?:\d+ of \d+|\d+ matches)/u)
  replied = true
  await search.getByRole('button', { name: 'Close search', exact: true }).click()
  await expect.poll(async () => {
    const current = await read()
    return current.state === 'idle' && current.replied
  }, { timeout: 60000 }).toBe(true)
  assert.equal((await read()).detection, 'available')
  await expect(sidebar.locator('.terminal-nav__row[data-terminal-state="working"]')).toHaveCount(0)
  await expect(page.getByText("Sotto can't tell when this Codex version needs you.", { exact: true })).toHaveCount(0)
  for (const [width, height, appearance] of [[1280, 800, 'dark'], [1600, 1000, 'dark'], [820, 560, 'light']]) {
    await page.evaluate(appearance => window.sotto.updateSettings({ appearance }), appearance)
    await app.evaluate(({ BrowserWindow }, { width, height }) => {
      const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))
      window.setSize(width, height)
    }, { width, height })
    await wait(400)
    await expect.poll(async () => (await read()).state).toBe('idle')
    await capture(join(evidence, `${suffix}-idle-${width}x${height}-${appearance}.png`))
  }
  assert.deepEqual(errors, [])
  await writeFile(join(evidence, `${suffix}-result.json`), JSON.stringify({ ...metadata, codex: version, model: 'GPT-6-Luna', reasoning: 'low', states: ['idle', 'working', 'idle'], final: await read(), pageErrors: errors, nestedPid: compositor.pid }, null, 2) + '\n')
  console.log(JSON.stringify({ ...metadata, codex: version, final: await read(), pageErrors: errors }))
} catch (error) {
  await page?.screenshot({ path: resolve('.cache/codex-terminal-state/gui-failure.png') }).catch(() => {})
  throw error
} finally {
  try { await app?.close() }
  finally { await rm(root, { recursive: true, force: true }) }
}
