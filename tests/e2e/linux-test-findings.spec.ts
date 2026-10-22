// Usage: node scripts/with-nested-hyprland.mjs .cache/findings/outer node scripts/verify-omarchy-setup.mjs --findings [--package]
import { execFileSync } from 'node:child_process'
import { chmod, cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { AGENT_STATE } from '../../src/shared/agents'
import { closeSotto, firstRunForwardButton, firstSottoWindow, openPage, skipThreadsTour, type LaunchedSotto } from './support/sottoLaunch'
import { forceDomTerminalRenderer } from './support/terminal'
import { OMARCHY_SETUP_CHANGED } from '../../src/shared/omarchySetup'
import { evidenceDirectory } from '../fixtures/evidence'
import type { OmarchySetupState } from '../../src/shared/omarchySetup'

const enabled = process.platform === 'linux' && process.env.SOTTO_LINUX_FINDINGS_PROOF === '1'
const packaged = process.env.SOTTO_SETUP_PROOF_PACKAGE === '1'
const home = process.env.SOTTO_SETUP_PROOF_HOME ?? ''
const root = process.env.SOTTO_SETUP_PROOF_ROOT ?? ''
const evidence = evidenceDirectory('artifacts/linux-test-findings')
const prefix = packaged ? 'packaged' : 'built'
const hypr = (args: string[]) => execFileSync('hyprctl', args, { encoding: 'utf8', timeout: 15000 })
const setup = (page: Page): Promise<OmarchySetupState> => page.evaluate(() => window.sotto!.omarchySetup!.get())
const proofs: unknown[] = []

async function fit(launched: LaunchedSotto, width: number, height: number) {
  const find = () => (JSON.parse(hypr(['clients', '-j'])) as Array<{ pid: number; address: string; title: string }>).find(item => item.pid === launched.app.process().pid && item.title === 'Sotto')
  await expect.poll(() => !!find()).toBe(true)
  const client = find()!
  for (const action of [`hl.dsp.window.float({ action = "enable", window = "address:${client.address}" })`,
    `hl.dsp.window.resize({ x = ${width}, y = ${height}, window = "address:${client.address}" })`]) hypr(['dispatch', action])
  await expect.poll(() => launched.page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height])
}
async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const file = `${prefix}-${name}.png`
  await page.screenshot({ path: join(evidence, file), animations: 'disabled' })
  proofs.push({ file, size: await page.evaluate(() => [innerWidth, innerHeight]) })
}
async function nativeZoomKey(launched: LaunchedSotto, key: string, shift = false) {
  await launched.app.evaluate(({ BrowserWindow }, { key, shift }) => {
    const contents = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.webContents
    const modifiers: Array<'control' | 'shift'> = shift ? ['control', 'shift'] : ['control']
    contents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
    contents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
  }, { key, shift })
}
async function clientNotice(launched: LaunchedSotto, ready = false) {
  const state = await launched.page.evaluate(() => window.sotto!.agents!.get())
  delete state.clientUpdatesDismissedAt
  // A complete thread list (ADR-0028's October 22 amendment). The read above told main to send its next broadcast
  // complete too, so revision 0, which main never uses, is never taken as the base of one of main's.
  const broadcast = { ...state,
    host: { ...state.host, models: { revision: 0, models: state.host.models }, threads: { revision: 0, base: null, changed: state.host.threads },
      clientHosts: state.host.clientHosts?.map(host => ({ ...host, models: { revision: 0, models: host.models } })) },
    clientUpdates: [{ id: 'grok', installed: '1.0.50', published: '1.0.52', behind: true, channel: 'npm',
      command: 'npm install -g @xai-official/grok@latest', canInstall: true, checkedAt: new Date().toISOString(), state: 'idle' }],
  }
  await launched.app.evaluate(({ BrowserWindow }, { state, channel, ready }) => {
    const contents = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.webContents
    const fixture = globalThis as typeof globalThis & { proofNoticeReady?: boolean; proofNoticePatched?: boolean }
    fixture.proofNoticeReady = ready
    if (!fixture.proofNoticePatched) {
      fixture.proofNoticePatched = true
      const send = contents.send.bind(contents)
      contents.send = (name, ...args) => {
        if (name === channel && args[0] && typeof args[0] === 'object') {
          const raw = args[0] as typeof state
          const providers = fixture.proofNoticeReady ? [{ id: 'codex', name: 'Codex', version: '0.162.1', connection: 'connected', capabilities: raw.host.capabilities }] : raw.host.providers
          args[0] = { ...raw, ...(fixture.proofNoticeReady ? { connections: undefined } : {}), clientUpdates: state.clientUpdates,
            host: { ...raw.host, providers, clientHosts: raw.host.clientHosts?.map(host => ({ ...host, providers: fixture.proofNoticeReady ? providers : host.providers })) } }
        }
        send(name, ...args)
      }
    }
    contents.send(channel, state)
  }, { state: broadcast, channel: AGENT_STATE, ready })
}

test('outside changes, removal, corner notice, launch environments and terminal Plus on Omarchy', async () => {
  test.skip(!enabled, 'Requires the private Omarchy shell and nested display wrapper')
  test.setTimeout(240_000)
  expect(home.startsWith(resolve('.cache'))).toBe(true)
  expect(process.env.SOTTO_PACKAGE_NESTED_PID).toBeTruthy()
  await mkdir(evidence, { recursive: true })
  const profile = join(root, 'profile'); await mkdir(profile)
  if (packaged) {
    // Only this private scripted CLI answers account/model checks; no agent turn is sent.
    const cli = join(root, 'cli'); await mkdir(cli)
    await writeFile(join(cli, 'version.txt'), '2.1.268')
    const executable = join(home, 'bin/claude')
    await writeFile(executable, `#!/bin/sh\nexec '${process.execPath}' '${resolve('tests/fixtures/fakeClaudeThread.mjs')}' '${cli}' "$@"\n`)
    await chmod(executable, 0o755)
  }
  // A packaged first run uses the actual local model, copied into this worktree, never downloaded to /tmp.
  if (packaged) await cp('/home/zach/.config/sotto/speech-models', join(profile, 'speech-models'), { recursive: true })
  const executable = packaged ? resolve('release/linux-unpacked/sotto') : resolve('node_modules/electron/dist/electron')
  const launcher = packaged ? join(root, 'installed/bin/sotto') : resolve('apps/omarchy/sotto')
  if (packaged) {
    // The PKGBUILD puts the public launcher beside the runtime, outside the tarball.
    await mkdir(join(root, 'installed/bin'), { recursive: true })
    await cp(resolve('apps/omarchy/sotto'), launcher)
    await symlink(executable, join(root, 'installed/sotto'))
    await symlink(resolve('release/linux-unpacked/resources'), join(root, 'installed/resources'))
  }
  const launch = async (mode: 'terminal' | 'launcher' | 'autostart' | 'bridge'): Promise<LaunchedSotto> => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/does-not-exist',
      SOTTO_E2E: '1', SOTTO_E2E_SCENARIO: 'success', SOTTO_E2E_USER_DATA: profile }
    // Sign-in entries execute the binary directly; OMARCHY_PATH is a shell variable, not an XDG guarantee.
    if (mode === 'autostart' || mode === 'bridge') delete env.OMARCHY_PATH
    if (mode === 'bridge') env.WAYLAND_DISPLAY = join(env.XDG_RUNTIME_DIR!, env.WAYLAND_DISPLAY!)
    let target = mode === 'launcher' ? launcher : executable
    if (mode === 'autostart' && packaged) {
      const entry = await readFile(join(home, '.config/autostart/sotto.desktop'), 'utf8')
      target = entry.match(/^Exec="([^"\n]+)"$/mu)![1]!
      expect(target).toBe(executable)
    }
    const app = await electron.launch({ executablePath: target,
      args: ['--ozone-platform=wayland', '--password-store=basic', `--user-data-dir=${profile}`, ...(packaged || mode === 'launcher' ? [] : ['out/main/index.js'])],
      env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)) })
    const page = await firstSottoWindow(app)
    return { app, page, userData: profile, ownsUserData: false }
  }
  let launched: LaunchedSotto | undefined
  try {
    launched = await launch('terminal')
    let { page, app } = launched
    proofs.push({ build: await app.evaluate(({ app }) => {
      const { readFileSync } = process.getBuiltinModule('node:fs'), { join } = process.getBuiltinModule('node:path'), { createHash } = process.getBuiltinModule('node:crypto')
      return { version: app.getVersion(), packaged: app.isPackaged, mainSha256: createHash('sha256').update(readFileSync(join(app.getAppPath(), app.isPackaged ? 'out/main/index.js' : 'index.js'))).digest('hex') }
    }) })
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.evaluate(() => window.sotto!.agents!.command({ type: 'configure', patch: { checkClientUpdates: false } }))
    await page.evaluate(() => window.sotto!.updateSettings({ reducedMotion: 'on' }))
    await fit(launched, 1280, 800)
    await page.getByRole('button', { name: 'Get started' }).click()
    await expect(page.getByRole('button', { name: 'Set up all three' })).toBeVisible()
    await page.getByRole('button', { name: 'Set up all three' }).click()
    await expect(page.getByText('Sotto is set up in Omarchy.', { exact: true })).toBeVisible()
    // Remove only this proof's key line and snippet outside Sotto, then reopen the step.
    const bindings = join(home, '.config/hypr/bindings.lua')
    const installedBindings = await readFile(bindings, 'utf8')
    await writeFile(bindings, '-- My bindings\n'); await rm(join(home, '.config/hypr/sotto-bindings.lua'))
    hypr(['reload'])
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await page.getByRole('button', { name: 'Get started' }).click()
    await expect(page.getByRole('button', { name: 'Set up the keys', exact: true })).toBeVisible()
    await capture(page, 'outside-change-1280x800-dark')
    // Keep the existing ownership boundary: explicitly restore the known require line before repairing its missing snippet.
    await writeFile(bindings, installedBindings)
    await page.getByRole('button', { name: 'Set up the keys', exact: true }).click()
    await expect(page.getByText('Sotto is set up in Omarchy.', { exact: true })).toBeVisible()

    // Feed the real corner card a client-update reading through its normal state channel.
    await clientNotice(launched)
    await expect(page.getByText('Client updates', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    // Walk the genuine setup path; the microphone is explicitly skipped.
    for (let n = 0; n < 4; n++) await firstRunForwardButton(page).click()
    await expect(page.getByRole('heading', { name: 'Your coding agents' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Check again', exact: true })).toBeEnabled()
    await clientNotice(launched, !packaged)
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible()
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
      await fit(launched, width!, height!)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await clientNotice(launched, !packaged)
        await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible()
        const button = firstRunForwardButton(page)
        await expect(button).toBeInViewport({ ratio: 1 })
        expect(await button.evaluate(element => {
          const r = element.getBoundingClientRect()
          return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
        })).toBe(true)
        await capture(page, `onboarding-${width}x${height}-${appearance}`)
      }
    }
    for (let n = 0; n < 3; n++) await firstRunForwardButton(page).click()
    await page.getByRole('button', { name: 'Finish setup', exact: true }).click()
    await skipThreadsTour(page)
    await clientNotice(launched)
    await expect(page.getByText('Client updates', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Not now', exact: true }).click()
    await expect(page.getByText('Client updates', { exact: true })).toHaveCount(0)

    await openPage(page, 'Settings'); await page.getByRole('tab', { name: 'Dictation', exact: true }).click()
    // Hold the proof's luac wrapper to inspect the actual removal label.
    await writeFile(join(root, 'hold-keys'), '')
    await page.getByRole('button', { name: 'Remove the keys', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Removing', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Setting up', exact: true })).toHaveCount(0)
    for (const [width, height, appearance] of [[1280, 800, 'dark'], [820, 560, 'light']] as const) {
      await fit(launched, width, height)
      await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
      await page.locator('.omarchy-setup').scrollIntoViewIfNeeded()
      await capture(page, `removing-${width}x${height}-${appearance}`)
    }
    await rm(join(root, 'hold-keys'))
    await expect(page.getByRole('button', { name: 'Set up the keys', exact: true })).toBeEnabled()
    // Script a failed inspection through main's normal channel after real removal, then use the real read.
    await app.evaluate(({ BrowserWindow }, { channel, state }) => {
      const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
      main.webContents.send(channel, { ...state, pieces: { ...state.pieces,
        keys: { status: 'failed', owned: false, message: 'Sotto could not check these files. Try again.', retry: 'inspect' } } })
    }, { channel: OMARCHY_SETUP_CHANGED, state: await setup(page) })
    await expect(page.getByRole('button', { name: 'Try the keys again', exact: true })).toBeVisible()
    await page.locator('.omarchy-setup__piece[data-piece=keys]').scrollIntoViewIfNeeded()
    await capture(page, 'inspection-retry-820x560-light')
    await page.getByRole('button', { name: 'Try the keys again', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Set up the keys', exact: true })).toBeFocused()
    expect(await readFile(join(home, '.config/hypr/sotto-bindings.lua'), 'utf8').catch(() => null)).toBeNull()
    proofs.push({ inspectionRetry: { filesStillAbsent: true, nextActionFocused: true } })
    await page.getByRole('button', { name: 'Set up the keys', exact: true }).click()
    await expect.poll(async () => (await setup(page)).busy).toBe(false)
    // Settings retains hidden panels. Returning through the actual tabs must inspect again without a window focus change.
    await page.getByRole('tab', { name: 'Application', exact: true }).click()
    await writeFile(bindings, '-- My bindings\n'); await rm(join(home, '.config/hypr/sotto-bindings.lua')); hypr(['reload'])
    await page.getByRole('tab', { name: 'Dictation', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Set up the keys', exact: true })).toBeVisible()
    await writeFile(bindings, installedBindings)
    await page.getByRole('button', { name: 'Set up the keys', exact: true }).click()
    await expect.poll(async () => (await setup(page)).busy).toBe(false)
    // Focus refresh after outside removal; do not call setup.get(), which would hide a missing refresh.
    const other = await app.evaluate(async ({ BrowserWindow }) => {
      const window = new BrowserWindow({ width: 220, height: 160, title: 'Focus proof' })
      await window.loadURL('about:blank'); window.focus(); return window.id
    })
    const findFocusWindow = () => (JSON.parse(hypr(['clients', '-j'])) as Array<{ pid: number; address: string; title: string }>).find(client => client.pid === app.process().pid && client.title === 'Focus proof')
    await expect.poll(() => !!findFocusWindow()).toBe(true)
    hypr(['dispatch', `hl.dsp.focus({ window = "address:${findFocusWindow()!.address}" })`])
    await expect.poll(() => JSON.parse(hypr(['activewindow', '-j'])).title).toBe('Focus proof')
    await writeFile(bindings, '-- My bindings\n'); await rm(join(home, '.config/hypr/sotto-bindings.lua')); hypr(['reload'])
    await app.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.fromId(id)!.close()
      BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.focus()
    }, other)
    const mainClient = (JSON.parse(hypr(['clients', '-j'])) as Array<{ pid: number; address: string; title: string }>).find(client => client.pid === app.process().pid && client.title === 'Sotto')!
    hypr(['dispatch', `hl.dsp.focus({ window = "address:${mainClient.address}" })`])
    await expect.poll(() => JSON.parse(hypr(['activewindow', '-j'])).title).toBe('Sotto')
    await expect(page.getByRole('button', { name: 'Set up the keys', exact: true })).toBeVisible()
    await writeFile(bindings, installedBindings)
    await page.getByRole('button', { name: 'Set up the keys', exact: true }).click()
    await expect.poll(async () => (await setup(page)).busy).toBe(false)
    if (packaged) {
      await page.getByRole('tab', { name: 'Application', exact: true }).click()
      const startup = page.getByRole('switch', { name: 'Launch when you sign in' })
      await startup.click()
      await expect(startup).toHaveAttribute('aria-checked', 'true')
      await expect.poll(() => readFile(join(home, '.config/autostart/sotto.desktop'), 'utf8')).toContain(`Exec="${executable}"`)
    }
    expect(errors).toEqual([])
    await closeSotto(launched); launched = undefined
    for (const mode of ['launcher', 'bridge', 'autostart'] as const) {
      launched = await launch(mode); ({ page, app } = launched)
      expect((await setup(page)).shellRunning).toBe(true)
      proofs.push({ launch: mode, packaged: await app.evaluate(({ app }) => app.isPackaged), environment: await app.evaluate(() =>
        Object.fromEntries(['OMARCHY_PATH', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'HYPRLAND_INSTANCE_SIGNATURE'].map(key => [key, process.env[key] ?? null]))) })
      await closeSotto(launched); launched = undefined
    }
    // A real shell, all three terminal zoom chords and the external-link modifier.
    launched = await launch('terminal'); ({ page, app } = launched)
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
    await fit(launched, 1280, 800); await forceDomTerminalRenderer(page)
    if (packaged) {
      await page.evaluate(() => window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, enabledProviders: ['claude'], provider: 'claude', checkClientUpdates: false } }))
      await page.evaluate(() => window.sotto!.agents!.command({ type: 'connect', provider: 'claude' }))
    }
    const project = await page.evaluate(path => window.sotto!.agents!.command({ type: 'create-project', title: 'Zoom proof', path, useExisting: true }), root)
    expect(project.error ?? null).toBeNull()
    await page.getByRole('radio', { name: 'Terminal', exact: true }).click()
    await page.getByRole('button', { name: 'New terminal', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New terminal', exact: true })
    if (await dialog.getByRole('textbox', { name: 'Terminal name', exact: true }).count() === 0) {
      await dialog.locator('.new-thread-choice').filter({ hasText: 'Zoom proof' }).click()
    }
    await dialog.getByRole('textbox', { name: 'Terminal name', exact: true }).fill('Zoom check')
    await dialog.getByRole('combobox', { name: 'Terminal provider' }).selectOption('')
    await dialog.getByRole('button', { name: 'Open terminal', exact: true }).click()
    const input = page.locator('.terminal-pane .xterm-helper-textarea')
    await input.click()
    const zoom = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.webContents.getZoomFactor())
    const font = () => page.evaluate(async () => (await window.sotto!.getSettings()).terminalFontSize)
    for (const [key, shift, expected] of [['=', true, 14], ['+', false, 15], ['-', false, 14], ['0', false, 13]] as const) {
      await nativeZoomKey(launched, key, shift); await expect.poll(font).toBe(expected); expect(await zoom()).toBe(1)
    }
    await input.pressSequentially("printf 'https://example.com/terminal\\n'"); await input.press('Enter')
    await expect(page.locator('.xterm-rows')).toContainText('https://example.com/terminal')
    await app.evaluate(({ shell }) => { shell.openExternal = async url => { (globalThis as typeof globalThis & { proofLink?: string }).proofLink = url } })
    const link = page.locator('.xterm-rows > div').filter({ hasText: /^https:\/\/example.com\/terminal$/ }).last()
    const point = await link.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element)
      const r = range.getBoundingClientRect(); return { x: r.x + 6, y: r.y + r.height / 2 }
    })
    await page.mouse.move(point.x, point.y)
    await page.mouse.click(point.x, point.y)
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { proofLink?: string }).proofLink)).toBeUndefined()
    await page.keyboard.down('Control')
    try { await page.mouse.click(point.x, point.y) } finally { await page.keyboard.up('Control') }
    await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { proofLink?: string }).proofLink)).toBe('https://example.com/terminal')
    await capture(page, 'terminal-1280x800-dark')
    await fit(launched, 820, 560)
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'light' }))
    await capture(page, 'terminal-820x560-light')
    await input.press('Control+f')
    await page.getByRole('textbox', { name: 'Find in terminal' }).press('Escape')
    // Move focus out of the terminal, then the same Plus shortcut still zooms the interface.
    await page.getByRole('button', { name: 'New terminal', exact: true }).first().focus()
    await expect(page.getByRole('button', { name: 'New terminal', exact: true }).first()).toBeFocused()
    proofs.push({ menuRoles: await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.flatMap(item => item.submenu?.items.map(item => item.role) ?? []) ?? []) })
    await nativeZoomKey(launched, '+')
    await expect.poll(zoom).toBeGreaterThan(1)
    await nativeZoomKey(launched, '0')
    await expect.poll(zoom).toBe(1)
    proofs.push({ terminalZoom: true, appZoom: true, modifierLink: true })
  } finally {
    if (launched) await closeSotto(launched)
    await rm(join(root, 'hold-keys'), { force: true })
    await writeFile(join(evidence, `${prefix}-results.json`), JSON.stringify(proofs, null, 2))
  }
})
