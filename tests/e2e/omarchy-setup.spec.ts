import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import sharp from 'sharp'
import { ownedE2EProfile } from './support/e2eProfile'
import { firstRunForwardButton, firstSottoWindow, launchSotto, closeSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'
import type { OmarchySetupState } from '../../src/shared/omarchySetup'
import { inspectDictationBindings } from '../../src/main/omarchy/setup'
import { evidenceDirectory } from '../fixtures/evidence'

const enabled = process.platform === 'linux' && process.env.SOTTO_OMARCHY_SETUP_PROOF === '1'
const packaged = process.env.SOTTO_SETUP_PROOF_PACKAGE === '1'
const home = process.env.SOTTO_SETUP_PROOF_HOME ?? ''
const root = process.env.SOTTO_SETUP_PROOF_ROOT ?? ''
const evidence = evidenceDirectory('artifacts/omarchy-setup')
const proofs: unknown[] = []
const hypr = (args: string[]) => execFileSync('hyprctl', args, { env: process.env, encoding: 'utf8', timeout: 15000 })
const bindings = join(home, '.config/hypr/bindings.lua'), snippet = join(home, '.config/hypr/sotto-bindings.lua')
const plugin = join(home, '.config/omarchy/plugins/sotto.dictation'), template = join(home, '.config/omarchy/themed/sotto.json.tpl')
const state = (page: Page): Promise<OmarchySetupState> => page.evaluate(() => window.sotto!.omarchySetup!.get())

async function size(launched: LaunchedSotto, width: number, height: number) {
  await launched.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Sotto')!.setMinimumSize(800, 540) })
  const find = () => (JSON.parse(hypr(['clients', '-j'])) as Array<{ pid: number; address: string; title: string }>).find(client => client.pid === launched.app.process().pid && client.title === 'Sotto')
  await expect.poll(() => !!find()).toBe(true)
  const client = find()!
  for (const action of [`hl.dsp.window.float({ action = "enable", window = "address:${client.address}" })`,
    `hl.dsp.window.resize({ x = ${width}, y = ${height}, window = "address:${client.address}" })`,
    `hl.dsp.window.move({ x = 0, y = 40, window = "address:${client.address}" })`]) hypr(['dispatch', action])
  await expect.poll(() => launched.page.evaluate(([w, h]) => [innerWidth, innerHeight].join('x') === [w, h].join('x'), [width, height])).toBe(true)
}
async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready)
  const geometry = await page.evaluate(() => {
    const root = document.querySelector('.omarchy-setup')!
    const elements = [...root.querySelectorAll('button, strong, input')]
    return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
      horizontalClips: elements.filter(element => { const r = element.getBoundingClientRect(); return r.width > 0 && (r.x < 0 || r.right > innerWidth) }).map(element => element.textContent) }
  })
  expect(geometry.overflow).toBe(false); expect(geometry.horizontalClips).toEqual([])
  await page.screenshot({ path: join(evidence, `${packaged ? 'packaged' : 'built'}-${name}.png`), animations: 'disabled' })
  proofs.push({ capture: `${packaged ? 'packaged' : 'built'}-${name}.png`, ...geometry })
}
async function settings(page: Page) {
  await openPage(page, 'Settings')
  await page.getByRole('tab', { name: 'Dictation', exact: true }).click()
  await page.locator('.omarchy-setup').scrollIntoViewIfNeeded()
}
async function bar(name: string): Promise<Buffer> {
  const file = join(evidence, `${packaged ? 'packaged' : 'built'}-${name}.png`)
  execFileSync('grim', ['-g', '760,0 80x32', file], { env: process.env })
  return sharp(file).removeAlpha().raw().toBuffer()
}
async function removeAll(page: Page) {
  const remove = page.getByRole('button', { name: 'Remove all', exact: true })
  if (await remove.isVisible()) await remove.click()
  await expect.poll(async () => (await state(page)).busy).toBe(false)
}

test('set up Omarchy, handle every decision, undo and update through the real window', async () => {
  test.skip(!enabled, 'Use scripts/verify-omarchy-setup.mjs inside the nested wrapper')
  test.setTimeout(300000)
  expect(home).toContain(resolve('.cache'))
  await mkdir(evidence, { recursive: true })
  const profile = await ownedE2EProfile({ prefix: 'sotto-e2e-omarchy-setup-' })
  if (!packaged) {
    await mkdir(join(profile.directory, 'omarchy'))
    for (const piece of ['bindings.lua', 'sotto.json.tpl', 'install-theme.sh', 'shell-plugin']) {
      await cp(resolve('apps/omarchy', piece), join(profile.directory, 'omarchy', piece), { recursive: true })
    }
  }
  const resources = packaged ? resolve('release/linux-unpacked/resources/omarchy') : join(profile.directory, 'omarchy')
  const launch = () => launchSotto('success', profile.directory, {
    createProfile: async () => profile.directory, removeProfile: async () => undefined, firstWindow: firstSottoWindow,
    launch: (options = {}) => electron.launch({ ...options,
      ...(packaged ? { executablePath: resolve('release/linux-unpacked/sotto') } : {}),
      args: ['--ozone-platform=wayland', '--password-store=basic', `--user-data-dir=${profile.directory}`, ...(packaged ? [] : options.args!)],
      env: { ...options.env, HOME: home, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/does-not-exist', SOTTO_OWL_FEATURES: 'watcher=0' },
    }),
  })
  let app: LaunchedSotto | undefined
  try {
    app = await launch(); let page = app.page
    expect(await app.app.evaluate(() => process.env.PATH?.split(':')[0])).toBe(join(home, 'bin'))
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await size(app, 1280, 800)
    await page.getByRole('button', { name: 'Get started' }).click()
    await expect(page.getByRole('heading', { name: 'Set up Sotto in Omarchy' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Set up all three' })).toBeVisible()
    await writeFile(join(root, 'detected.json'), JSON.stringify({ binds: JSON.parse(hypr(['binds', '-j'])), state: await state(page) }, null, 2))
    expect((await state(page)).voxtype).toBe(true)
    for (const [width, height] of [[1280, 800], [820, 560]]) {
      await size(app, width!, height!)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await expect(page.getByRole('button', { name: 'Set up all three' })).toBeInViewport({ ratio: 1 })
        await capture(page, `offer-${width}x${height}-${appearance}`)
      }
    }
    await size(app, 1280, 800)
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
    await writeFile(join(root, 'hold-keys'), '')
    await page.getByRole('button', { name: 'Set up all three' }).click()
    await expect(page.locator('.omarchy-setup__piece[data-state="working"]').first()).toBeVisible()
    await expect(firstRunForwardButton(page)).toBeDisabled()
    await capture(page, 'working-1280x800-dark')
    await rm(join(root, 'hold-keys'))
    await expect(page.getByText('Sotto is set up in Omarchy.', { exact: true })).toBeVisible()
    expect(Object.values((await state(page)).pieces).map(piece => piece.status)).toEqual(['done', 'done', 'done'])
    expect(inspectDictationBindings(JSON.parse(hypr(['binds', '-j']))).manual).toBe(true)
    expect(hypr(['configerrors']).trim()).toBe('')
    expect(await page.evaluate(() => window.sotto!.getSettings())).toMatchObject({ appearance: 'system', lightTheme: '__omarchy', darkTheme: '__omarchy' })
    await capture(page, 'done-1280x800-dark')
    await firstRunForwardButton(page).click() // Look
    for (let i = 0; i < 3; i++) await firstRunForwardButton(page).click()
    await expect(page.getByRole('heading', { name: 'Hold F9 to try it' })).toBeVisible()
    // Continue the actual first-use journey through Finish setup before opening Settings.
    for (let i = 0; i < 4; i++) await firstRunForwardButton(page).click()
    await page.getByRole('button', { name: 'Finish setup' }).click()
    await page.locator('.threads-tour').getByRole('button', { name: 'Skip tour' }).click()
    await settings(page)
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
      await size(app, width!, height!)
      for (const mode of ['dark', 'light'] as const) {
        await page.evaluate(mode => window.sotto!.updateSettings({ appearance: mode }), mode)
        await page.locator('.omarchy-setup').scrollIntoViewIfNeeded()
        await capture(page, `settings-${width}x${height}-${mode}`)
      }
    }
    const before = await readFile(bindings, 'utf8')
    await page.evaluate(() => window.sotto!.omarchySetup!.command({ type: 'setup', pieces: ['keys', 'owl', 'theme'], keys: 'give' }))
    expect(await readFile(bindings, 'utf8')).toBe(before)
    proofs.push({ journey: 'fresh setup with Voxtype; first use; repeated setup; all sizes and modes', passed: true })
    await size(app, 1280, 800)
    for (const piece of ['keys', 'owl', 'theme']) {
      await page.getByRole('button', { name: `Remove the ${piece === 'keys' ? 'keys' : piece}` }).click()
      await expect.poll(async () => (await state(page)).pieces[piece as 'keys' | 'owl' | 'theme'].status).toBe('missing')
    }
    await capture(page, 'undo-1280x800-light')
    expect(await readFile(bindings, 'utf8')).toBe('-- My bindings\n')
    await page.getByRole('button', { name: 'Set up all three' }).click()
    await expect(page.getByText('Sotto is set up in Omarchy.', { exact: true })).toBeVisible()
    await removeAll(page)
    proofs.push({ journey: 'each Remove; set up again; Remove all; Voxtype restored', passed: true })
    if (packaged) return

    // Real non-Voxtype conflict, both answers from the row's native radio controls.
    await writeFile(bindings, 'o.bind("F9", "Toggle screen recording", "true")\n')
    hypr(['reload'])
    await settings(page)
    await page.reload(); await settings(page)
    await expect(page.getByRole('radio', { name: 'Give F9 to Sotto' })).toBeChecked()
    await capture(page, 'conflict-1280x800-light')
    await page.getByRole('radio', { name: 'Leave my keys alone' }).check()
    await page.getByRole('button', { name: 'Set up all three' }).click()
    await expect.poll(async () => (await state(page)).pieces.keys.status).toBe('skipped')
    expect(await readFile(bindings, 'utf8')).toBe('o.bind("F9", "Toggle screen recording", "true")\n')
    await page.getByRole('radio', { name: 'Give F9 to Sotto' }).check()
    await page.getByRole('button', { name: 'Set up the keys' }).click()
    await expect.poll(async () => (await state(page)).pieces.keys.status).toBe('done')
    await removeAll(page)
    await writeFile(bindings, '-- My bindings\n'); hypr(['reload'])
    proofs.push({ journey: 'non-Voxtype conflict answered both ways', passed: true })

    // Stop only this private shell. Nothing may be copied while it is down.
    execFileSync('qs', ['kill', '-p', '/usr/share/omarchy/shell'], { env: process.env })
    await page.reload(); await settings(page)
    await page.getByRole('button', { name: 'Set up all three' }).click()
    await expect.poll(async () => (await state(page)).pieces.owl.status).toBe('failed')
    expect(await readFile(join(plugin, 'manifest.json'), 'utf8').catch(() => null)).toBeNull()
    await capture(page, 'shell-down-1280x800-light')
    execFileSync(process.execPath, ['scripts/verify-omarchy-setup-restart.mjs'], { env: process.env, timeout: 30000 })
    await page.getByRole('button', { name: 'Try the owl again' }).click()
    await expect.poll(async () => (await state(page)).pieces.owl.status).toBe('done')
    await removeAll(page)
    proofs.push({ journey: 'shell down leaves no plugin; restart and retry', passed: true })

    // The Lua parses, but Hyprland gets an invalid option only after setup adds its require.
    const hyprConfig = process.env.SOTTO_SETUP_PROOF_HYPR_CONFIG!
    const originalConfig = await readFile(hyprConfig, 'utf8')
    await writeFile(hyprConfig, `${originalConfig}\nif o.shell_succeeds([[grep -q 'Sotto Omarchy setup' "$HOME/.config/hypr/bindings.lua"]]) then hl.config({ sotto_invalid_option = true }) end\n`)
    hypr(['reload'])
    await page.reload(); await settings(page)
    await page.getByRole('button', { name: 'Set up all three' }).click()
    await expect.poll(async () => (await state(page)).pieces.keys.status).toBe('failed')
    expect(await readFile(bindings, 'utf8')).toBe('-- My bindings\n')
    expect(await readFile(snippet, 'utf8').catch(() => null)).toBeNull()
    await capture(page, 'rollback-1280x800-light')
    await writeFile(hyprConfig, originalConfig); hypr(['reload'])
    await page.getByRole('button', { name: 'Try the keys again' }).click()
    await expect.poll(async () => (await state(page)).pieces.keys.status).toBe('done')
    proofs.push({ journey: 'injected real Hyprland error rolls back; retry after correction', passed: true })

    // A new bundled copy simulates a package update across a real app restart.
    await closeSotto(app); app = undefined
    const keySource = join(resources, 'bindings.lua'), themeSource = join(resources, 'sotto.json.tpl'), owlSource = join(resources, 'shell-plugin/sotto.dictation/Model.mjs')
    await writeFile(keySource, `${await readFile(keySource, 'utf8')}\n-- package update\n`)
    await writeFile(themeSource, `${await readFile(themeSource, 'utf8')}\n`)
    await writeFile(owlSource, `${await readFile(owlSource, 'utf8')}\n// package update\n`)
    app = await launch(); page = app.page; await size(app, 1280, 800); await settings(page)
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
    await expect.poll(async () => (await state(page)).pieces.keys.message).toContain('Updated for Sotto')
    await expect.poll(async () => (await state(page)).pieces.theme.message).toContain('Updated for Sotto')
    await expect(page.getByRole('button', { name: 'Update the owl' })).toBeVisible()
    await capture(page, 'update-1280x800-dark')
    await page.getByRole('button', { name: 'Update the owl' }).click()
    await expect(page.getByRole('dialog', { name: 'Update the owl?' })).toBeVisible()
    await page.keyboard.press('Escape')
    expect((await state(page)).pieces.owl.status).toBe('stale')
    await page.getByRole('button', { name: 'Update the owl' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Update the owl', exact: true }).click()
    await writeFile(join(root, 'after-update.json'), JSON.stringify(await state(page), null, 2))
    await expect.poll(async () => (await state(page)).pieces.owl.status).toBe('done')
    proofs.push({ journey: 'package update refreshes keys and theme; owl waits; Escape cancels; press restarts private bar', passed: true })
    const inkPixels = (pixels: Buffer): number => {
      let ink = 0
      for (let at = 0; at < pixels.length; at += 3) if (pixels[at]! > 100 && pixels[at + 1]! > 100 && pixels[at + 2]! > 100) ink++
      return ink
    }
    await expect.poll(async () => inkPixels(await bar('bar-installed'))).toBeGreaterThan(100)

    // Uninstall fallback without removing any real package: hide just the owned PATH launcher.
    await rename(join(home, 'bin/sotto'), join(home, 'bin/sotto-off'))
    hypr(['reload'])
    expect(inspectDictationBindings(JSON.parse(hypr(['binds', '-j']))).manual).toBe(false)
    expect(inspectDictationBindings(JSON.parse(hypr(['binds', '-j']))).voxtype).toBe(true)
    await expect.poll(async () => {
      return inkPixels(await bar('bar-uninstalled'))
    }, { timeout: 15000 }).toBeLessThan(10)
    await capture(page, 'uninstalled-1280x800-dark')
    await rename(join(home, 'bin/sotto-off'), join(home, 'bin/sotto')); hypr(['reload'])
    proofs.push({ journey: 'sotto removed from PATH; owl disappears; keys fall back to Voxtype', passed: true })
    await removeAll(page)

    // Hand-installed files stay byte-for-byte whole, even across a request to remove all.
    await cp(keySource, snippet); await writeFile(bindings, 'require("hypr.sotto-bindings")\n'); hypr(['reload'])
    await cp(join(resources, 'shell-plugin/sotto.dictation'), plugin, { recursive: true })
    execFileSync('omarchy-shell', ['shell', 'rescanPlugins'], { env: process.env })
    execFileSync('omarchy', ['bar', 'put', 'sotto.dictation', '--section', 'center'], { env: process.env })
    execFileSync('bash', [join(resources, 'install-theme.sh')], { env: process.env })
    await page.reload(); await settings(page)
    await expect.poll(async () => Object.values((await state(page)).pieces).map(piece => piece.status)).toEqual(['manual', 'manual', 'manual'])
    await capture(page, 'by-hand-1280x800-dark')
    const hand = [await readFile(bindings, 'utf8'), await readFile(template, 'utf8'), await readFile(join(plugin, 'Model.mjs'), 'utf8')]
    await page.evaluate(() => window.sotto!.omarchySetup!.command({ type: 'remove', pieces: ['keys', 'owl', 'theme'] }))
    expect([await readFile(bindings, 'utf8'), await readFile(template, 'utf8'), await readFile(join(plugin, 'Model.mjs'), 'utf8')]).toEqual(hand)
    proofs.push({ journey: 'hand-installed keys, owl and theme counted as done; never removed', passed: true })
    expect(errors).toEqual([])
  } finally {
    // The restarted shell is an owned descendant of the app's command. Stop it before app close.
    try { execFileSync('qs', ['kill', '-p', '/usr/share/omarchy/shell'], { env: process.env, timeout: 5000, stdio: 'ignore' }) } catch { /* Already stopped. */ }
    if (app) await closeSotto(app)
    await profile.dispose()
    await writeFile(join(evidence, `${packaged ? 'packaged' : 'built'}-results.json`), JSON.stringify({ timestamp: new Date().toISOString(), home, root,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      worktreeChanges: execFileSync('git', ['diff', '--name-only', 'HEAD'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean), proofs }, null, 2))
  }
})
