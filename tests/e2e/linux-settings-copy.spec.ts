// Built-app proof that Settings says what applies on Linux: the bindings' setup steps, pacman updates, and the
// idle widget row with and without the shell pill. Run inside the owned nested Hyprland of
// scripts/verify-linux-window-minimum.mjs --exec, it also floats its own window there and captures it with grim,
// into the shared evidence folder (tests/fixtures/evidence.ts).
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron, expect, test, type Locator } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { LINUX_BINDINGS_GUIDE_URL } from '../../src/renderer/src/platformCopy'
import { closeSotto, firstSottoWindow, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { evidenceDirectory } from '../fixtures/evidence'

const run = promisify(execFile)
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const SHELL_PILL = 'On Omarchy, the owl in the bar replaces the widget. Remove the shell plugin to bring it back.'
const WIDGET = 'Keep the small dictation sliver on screen between sessions. Click it to dictate.'

interface HyprClient { readonly address: string; readonly pid: number; readonly mapped: boolean; readonly at: [number, number]; readonly size: [number, number] }

test('Linux Settings says what applies, with and without the shell pill', async () => {
  test.skip(process.platform !== 'linux', 'Linux Settings copy')
  test.setTimeout(240_000)
  // Captures and window moves go only to the owned nested compositor, which names the live one it must not touch.
  const output = process.env.SOTTO_NESTED_LIVE_SIGNATURE ? evidenceDirectory('artifacts/linux-settings-copy') : undefined
  if (output) {
    expect(process.env.HYPRLAND_INSTANCE_SIGNATURE).toBeTruthy()
    expect(process.env.HYPRLAND_INSTANCE_SIGNATURE).not.toBe(process.env.SOTTO_NESTED_LIVE_SIGNATURE)
    await mkdir(output, { recursive: true })
    await run('hyprctl', ['dismissnotify'])
  }
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-'))
  const home = join(profile, 'home')
  const plugin = join(home, '.config/omarchy/plugins/sotto.dictation')
  const statePath = join(profile, 'sotto/dictation-state.json')
  let launched: LaunchedSotto | undefined
  try {
    await mkdir(home)
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, reducedMotion: 'on' }))
    launched = await launchSotto('success', profile, {
      createProfile: async () => { throw new Error('Use the owned profile') },
      launch: options => electron.launch({ ...options, env: { ...options?.env, HOME: home } }),
      firstWindow: firstSottoWindow,
      removeProfile: path => rm(requireOwnedE2EProfile(path), { recursive: true, force: true }),
    })
    const { app, page } = launched
    // A live state file is half of what lets the shell pill stand in; the plugin folder is the other half.
    await expect.poll(() => stat(statePath).then(() => true, () => false)).toBe(true)
    const widgetVisible = () => app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/widget.html'))?.isVisible() ?? false)
    await expect.poll(widgetVisible).toBe(true)
    await openPage(page, 'Settings')
    const tab = (name: string) => page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name, exact: true })
    const widgetSwitch = page.getByRole('switch', { name: 'Show floating widget when idle' })
    const bindingsButton = page.getByRole('button', { name: 'Open setup steps in your browser' })
    const updates = page.locator('#settings-updates')

    // Dictation: the bindings say where they live and open their setup steps; nothing edits Hyprland.
    await expect(page.getByText('Compositor bindings', { exact: true })).toBeVisible()
    await expect(page.getByText('These are set in Hyprland, not here. Once installed, hold F9 to talk or press Super+Ctrl+X to start and stop.')).toBeVisible()
    await app.evaluate(({ shell }) => {
      const state = globalThis as unknown as { openedLinks: string[] }
      state.openedLinks = []
      shell.openExternal = async url => { state.openedLinks.push(url) }
    })
    await bindingsButton.click()
    expect(await app.evaluate(() => (globalThis as unknown as { openedLinks: string[] }).openedLinks)).toEqual([LINUX_BINDINGS_GUIDE_URL])
    await expect(page.getByRole('alert')).toHaveCount(0)
    // Linux has no in-app updater, so the sidebar foot offers nothing to press.
    await expect(page.locator('.update-control')).toHaveCount(0)

    // Application: pacman updates, and the widget row working as before without the plugin.
    await tab('Application').click()
    await expect(updates.getByText('Sotto never updates itself on Linux. New versions come through pacman.')).toBeVisible()
    await expect(updates.getByText('Install the next sotto-bin package with sudo pacman -U. Once sotto-bin is in a package repository, omarchy update brings it.')).toBeVisible()
    await expect(updates.getByRole('button')).toHaveCount(0)
    await expect(updates.getByRole('switch')).toHaveCount(0)
    await expect(updates).not.toContainText('GitHub')
    await expect(widgetSwitch).toBeEnabled()
    await expect(widgetSwitch).toHaveAccessibleDescription(WIDGET)
    await expect(widgetSwitch).toBeChecked()

    const capture = async (target: Locator, name: string): Promise<void> => {
      if (!output) return
      await target.evaluate(element => element.scrollIntoView({ block: 'center' }))
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const client = await mainClient()
      // The nested output draws the pointer into its frames; park it beyond the window.
      await run('hyprctl', ['dispatch', `hl.dsp.cursor.move({ x = ${client.at[0] + client.size[0] + 40}, y = ${client.at[1] + client.size[1] + 40} })`])
      await page.waitForTimeout(300)
      await run('grim', ['-g', `${client.at[0]},${client.at[1]} ${client.size[0]}x${client.size[1]}`, join(output, name)])
    }
    const mainClient = async (): Promise<HyprClient> => {
      const pid = app.process().pid
      const clients = JSON.parse((await run('hyprctl', ['clients', '-j'])).stdout) as HyprClient[]
      // The widget shares the process; the main window is the larger of its windows.
      const owned = clients.filter(client => client.pid === pid && client.mapped).sort((a, b) => b.size[0] * b.size[1] - a.size[0] * a.size[1])
      expect(owned.length).toBeGreaterThan(0)
      return owned[0]!
    }
    const resize = async (width: number, height: number): Promise<void> => {
      const { address } = await mainClient()
      await run('hyprctl', ['dispatch', `hl.dsp.window.float({ action = "enable", window = "address:${address}" })`])
      await run('hyprctl', ['dispatch', `hl.dsp.window.resize({ x = ${width}, y = ${height}, window = "address:${address}" })`])
      await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height])
      // Nothing overflows sideways at any size.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    const eachLook = async (shoot: (suffix: string) => Promise<void>): Promise<void> => {
      if (!output) return
      for (const appearance of ['light', 'dark'] as const) {
        await page.evaluate(async value => { await window.sotto!.updateSettings({ appearance: value }) }, appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        for (const [width, height] of SIZES) {
          await resize(width, height)
          await shoot(`${width}x${height}-${appearance}`)
        }
      }
    }

    await eachLook(async suffix => {
      await tab('Dictation').click()
      await expect(bindingsButton).toBeVisible()
      await capture(bindingsButton, `bindings-${suffix}.png`)
      await tab('Application').click()
      await expect(widgetSwitch).toBeEnabled()
      await capture(widgetSwitch, `widget-without-plugin-${suffix}.png`)
      await capture(updates, `updates-${suffix}.png`)
    })

    // A fake plugin folder plus the live state file: the shell pill stands in, and the row says so live.
    await mkdir(plugin, { recursive: true })
    await expect.poll(widgetVisible).toBe(false)
    await tab('Application').click()
    await expect(widgetSwitch).toBeDisabled()
    await expect(widgetSwitch).toHaveAccessibleDescription(SHELL_PILL)
    await expect(widgetSwitch).toBeChecked()
    await widgetSwitch.click({ force: true })
    expect((await page.evaluate(() => window.sotto!.getSettings())).showWidgetWhenIdle).toBe(true)
    await expect(page.getByText(WIDGET)).toHaveCount(0)
    await eachLook(async suffix => {
      await tab('Application').click()
      await expect(widgetSwitch).toBeDisabled()
      await capture(widgetSwitch, `widget-with-plugin-${suffix}.png`)
    })

    // A browser that cannot open the steps leaves the user knowing where they are.
    await app.evaluate(({ shell }) => { shell.openExternal = async () => { throw new Error('No browser') } })
    await tab('Dictation').click()
    await bindingsButton.click()
    await expect(page.getByRole('alert')).toHaveText(`The setup steps could not open in your browser. They are at ${LINUX_BINDINGS_GUIDE_URL}`)
    if (output) {
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
      await resize(820, 560)
      await capture(bindingsButton, 'bindings-open-failed-820x560-dark.png')
    }

    // Removing the plugin brings the widget, and the switch, back.
    await rm(plugin, { recursive: true })
    await expect.poll(widgetVisible).toBe(true)
    await tab('Application').click()
    await expect(widgetSwitch).toBeEnabled()
    await expect(widgetSwitch).toHaveAccessibleDescription(WIDGET)
  } finally {
    if (launched) await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})
