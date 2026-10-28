// Built-app proof of the page shortcuts (ADR-0158): Ctrl+1 to Ctrl+5 (⌘ on a Mac) open Dictate, Watcher, Threads, Usage
// and Settings from any page, a room opened so takes focus on its lit tab, and Settings › Keyboard lists them first.
// Run inside the owned nested Hyprland of scripts/verify-linux-window-minimum.mjs --exec, it also presses the keys
// through the compositor (Hyprland's send_shortcut), floats its own window to the checked sizes and captures it with grim, into the
// shared evidence folder (tests/fixtures/evidence.ts).
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type Page } from '@playwright/test'

import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { onReleaseTrack } from './support/releaseTrack'
import { openThreads, type LaunchedSotto } from './support/sottoLaunch'

const run = promisify(execFile)
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const nested = process.platform === 'linux' && Boolean(process.env.SOTTO_NESTED_LIVE_SIGNATURE)

interface HyprClient { readonly address: string; readonly pid: number; readonly mapped: boolean; readonly at: [number, number]; readonly size: [number, number] }

const rooms = (page: Page) => page.getByRole('tablist', { name: 'Page' }).first()
const litTab = (page: Page, name: string) => rooms(page).getByRole('tab', { name, exact: true })

async function expectRoom(page: Page, name: 'Dictate' | 'Watcher' | 'Threads'): Promise<void> {
  await expect(litTab(page, name)).toHaveAttribute('aria-selected', 'true')
  // As after pressing the room's tab: focus waits on the opened page's lit tab.
  await expect(litTab(page, name)).toBeFocused()
}

async function expectOpen(page: Page, key: string): Promise<void> {
  if (key === '1') return expectRoom(page, 'Dictate')
  if (key === '2') {
    await expect(page.getByRole('heading', { level: 1, name: 'Watcher' })).toBeVisible()
    return expectRoom(page, 'Watcher')
  }
  if (key === '3') return expectRoom(page, 'Threads')
  if (key === '4') return expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeVisible()
  await expect(page.getByRole('tablist', { name: 'Settings sections' })).toBeVisible()
}

test.describe('page shortcuts (ADR-0158)', () => {
  test('Ctrl+1 to Ctrl+5 open each page from any page, from a text box too, and Keyboard lists them first', async () => {
    test.setTimeout(300_000)
    const evidence = nested ? evidenceDirectory('artifacts/page-shortcuts') : undefined
    if (evidence) {
      expect(process.env.HYPRLAND_INSTANCE_SIGNATURE).toBeTruthy()
      expect(process.env.HYPRLAND_INSTANCE_SIGNATURE).not.toBe(process.env.SOTTO_NESTED_LIVE_SIGNATURE)
      await mkdir(evidence, { recursive: true })
      await run('hyprctl', ['dismissnotify'])
    }
    await onReleaseTrack('owl', () => withSotto({ onboardingComplete: true, scenario: 'design-threads', agents: 'design-threads', motion: 'reduced', appearance: 'dark' }, async (launched) => {
      const { page } = launched
      const keyboard = nestedKeyboard(launched)
      await openThreads(page)

      // Every page to every other, in the order the keys number them, then back down.
      for (const key of ['1', '2', '3', '4', '5', '4', '3', '2', '1']) {
        await page.keyboard.press(`ControlOrMeta+${key}`)
        await expectOpen(page, key)
      }

      // Settings › Keyboard: Switch pages comes first, and a clash is refused naming the row that holds the keys.
      await page.keyboard.press('ControlOrMeta+5')
      const keyboardTab = page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Keyboard', exact: true })
      await keyboardTab.click()
      const group = page.getByRole('region', { name: 'Switch pages' })
      // From a text box, as a thread shortcut works there: the page's own filter.
      const filter = page.getByRole('searchbox', { name: 'Filter shortcuts' })
      await filter.fill('open')
      await expect(filter).toBeFocused()
      await expect(group).toBeVisible()
      // First on the page, above the thread shortcuts' groups.
      expect(await group.evaluate(element => {
        const threads = [...document.querySelectorAll('section.settings-group')].find(section => section.querySelector('h3')?.textContent === 'Threads' && section.checkVisibility())
        return threads !== undefined && Boolean(element.compareDocumentPosition(threads) & Node.DOCUMENT_POSITION_FOLLOWING)
      })).toBe(true)
      await page.keyboard.press('ControlOrMeta+3')
      await expectRoom(page, 'Threads')

      // Keys that came through the compositor, not the page's own event queue.
      if (keyboard) {
        for (const key of ['1', '2', '5', '3']) {
          await keyboard.press(key)
          await expectOpen(page, key)
        }
      }

      // The room already open: its lit tab takes focus from the composer, as a click on it would.
      await page.getByRole('button', { name: 'Footer links', exact: true }).click({ position: { x: 16, y: 12 } })
      await page.getByRole('textbox', { name: 'Prompt' }).first().focus()
      await expect(page.getByRole('textbox', { name: 'Prompt' }).first()).toBeFocused()
      await page.keyboard.press('ControlOrMeta+3')
      await expectRoom(page, 'Threads')
      // With the sidebar folded to its rail there is no switch on screen; the page's main room takes focus.
      await page.getByRole('button', { name: 'Collapse sidebar' }).first().click()
      await page.keyboard.press('ControlOrMeta+5')
      await page.keyboard.press('ControlOrMeta+3')
      await expect(litTab(page, 'Threads')).toHaveCount(0)
      await expect(page.locator('#main-content')).toBeFocused()
      await page.getByRole('button', { name: 'Expand sidebar' }).first().click()

      await page.keyboard.press('ControlOrMeta+5')
      await keyboardTab.click()
      await page.getByRole('searchbox', { name: 'Filter shortcuts' }).fill('')
      await expect(group.getByRole('heading', { level: 3 })).toHaveText('Switch pages')
      for (const [name, key] of [['Dictate', '1'], ['Watcher', '2'], ['Threads', '3'], ['Usage', '4'], ['Settings', '5']] as const) {
        await expect(group.getByRole('group', { name }).getByRole('button', { name: new RegExp(`^Change shortcut, (Ctrl|Command) ${key}$`) })).toBeVisible()
      }
      const threadsRow = group.getByRole('group', { name: 'Threads' })
      await threadsRow.getByRole('button', { name: /^Change shortcut/ }).click()
      await page.keyboard.down('ControlOrMeta'); await page.keyboard.down('KeyL')
      await page.keyboard.up('KeyL'); await page.keyboard.up('ControlOrMeta')
      await expect(threadsRow.getByRole('alert')).toContainText('Focus the prompt already uses')
      await expect(threadsRow.getByRole('alert')).toContainText('Pick other keys.')

      if (evidence && keyboard) {
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(async value => { await window.sotto!.updateSettings({ appearance: value }) }, appearance)
          await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
          for (const [width, height] of SIZES) {
            await keyboard.resize(width, height)
            await group.evaluate(element => element.scrollIntoView({ block: 'start' }))
            await keyboard.capture(join(evidence, `keyboard-switch-pages-${width}x${height}-${appearance}.png`))
          }
        }
      }
    }))
  })

  test('with dictation turned off, Dictate has no row and Ctrl+1 opens nothing', async () => {
    test.setTimeout(180_000)
    await onReleaseTrack('owl', () => withSotto({ onboardingComplete: true, scenario: 'design-threads', agents: 'design-threads', motion: 'reduced', appearance: 'dark' }, async ({ page }) => {
      await openThreads(page)
      await page.evaluate(async () => { await window.sotto!.updateSettings({ dictationEnabled: false }) })
      await expect(rooms(page).getByRole('tab', { name: 'Dictate', exact: true })).toHaveCount(0)
      await page.keyboard.press('ControlOrMeta+1')
      await expect(litTab(page, 'Threads')).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('ControlOrMeta+5')
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Keyboard', exact: true }).click()
      const group = page.getByRole('region', { name: 'Switch pages' })
      await expect(group.getByRole('group')).toHaveCount(4)
      await expect(group.getByRole('group', { name: 'Dictate' })).toHaveCount(0)
      // The others keep their keys.
      await page.keyboard.press('ControlOrMeta+3')
      await expectRoom(page, 'Threads')
    }))
  })
})

/** On the owned nested desktop: real key presses through the compositor, window sizes and captures. Elsewhere, none. */
function nestedKeyboard(launched: LaunchedSotto) {
  if (!nested) return null
  const { app, page } = launched
  const mainClient = async (): Promise<HyprClient> => {
    const pid = app.process().pid
    const clients = JSON.parse((await run('hyprctl', ['clients', '-j'])).stdout) as HyprClient[]
    // The widget shares the process; the main window is the larger of its windows.
    const owned = clients.filter(client => client.pid === pid && client.mapped).sort((a, b) => b.size[0] * b.size[1] - a.size[0] * a.size[1])
    expect(owned.length).toBeGreaterThan(0)
    return owned[0]!
  }
  const settle = (): Promise<unknown> => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  return {
    async press(key: string): Promise<void> {
      const client = await mainClient()
      await run('hyprctl', ['dispatch', `hl.dsp.focus({ window = "address:${client.address}" })`])
      await expect.poll(async () => JSON.parse((await run('hyprctl', ['activewindow', '-j'])).stdout).address).toBe(client.address)
      await page.waitForTimeout(150)
      // Hyprland's own keyboard, not a virtual one: wtype's fresh keymap per call left Chromium reading the first one.
      const sent = await run('hyprctl', ['dispatch', `hl.dsp.send_shortcut({ mods = "CTRL", key = "${key}", window = "address:${client.address}" })`])
      expect(sent.stdout.trim()).toBe('ok')
    },
    async resize(width: number, height: number): Promise<void> {
      const { address } = await mainClient()
      await run('hyprctl', ['dispatch', `hl.dsp.window.float({ action = "enable", window = "address:${address}" })`])
      await run('hyprctl', ['dispatch', `hl.dsp.window.resize({ x = ${width}, y = ${height}, window = "address:${address}" })`])
      await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height])
      // Nothing overflows sideways at any size.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    },
    async capture(path: string): Promise<void> {
      await settle()
      const client = await mainClient()
      // The nested output draws the pointer into its frames; park it beyond the window.
      await run('hyprctl', ['dispatch', `hl.dsp.cursor.move({ x = ${client.at[0] + client.size[0] + 40}, y = ${client.at[1] + client.size[1] + 40} })`])
      await page.waitForTimeout(300)
      await run('grim', ['-g', `${client.at[0]},${client.at[1]} ${client.size[0]}x${client.size[1]}`, path])
    },
  }
}
