import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { hostKeysPerTest } from './support/hostKeys'
import { promptField } from './support/prompt'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'

// Three findings of the desktop UI review, in the built app: a right-click in a text field or on selected words opens an
// edit menu while the window's own menus stay as they were (#1821); Ctrl+, opens Settings through Sotto's own menu
// (#1825); and controls show the arrow while links keep the hand (#1832). Native menus are recorded, not shown, so
// nothing grabs the pointer: main's Menu.popup is replaced for the run.

const hostKeys = hostKeysPerTest()
const run = promisify(execFile)
const nested = process.platform === 'linux' && Boolean(process.env.SOTTO_NESTED_LIVE_SIGNATURE)
test.beforeEach(() => { hostKeys.reset() })

interface Shown { readonly items: readonly string[]; readonly enabled: readonly string[] }
interface Recorded { readonly events: number; readonly menus: readonly Shown[] }

async function prepare(launched: LaunchedSotto): Promise<void> {
  const { page } = launched
  await page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', accent: 'blue' })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  await page.reload()
  await hostKeys.read(page)
  await openThreads(page)
  // Every right-click Electron reports, and every menu main would pop up, in place of showing it.
  await launched.app.evaluate(({ BrowserWindow, Menu }) => {
    const record = globalThis as unknown as { sottoRecorded: { events: number; menus: { items: string[]; enabled: string[] }[] } }
    record.sottoRecorded = { events: 0, menus: [] }
    for (const window of BrowserWindow.getAllWindows()) window.webContents.on('context-menu', () => { record.sottoRecorded.events++ })
    Menu.prototype.popup = function (this: Electron.Menu) {
      const named = this.items.map(item => (item.role ?? item.type ?? item.label).toLowerCase())
      record.sottoRecorded.menus.push({ items: named, enabled: this.items.filter(item => item.enabled && item.type !== 'separator').map(item => (item.role ?? item.label).toLowerCase()) })
    }
  })
}

async function recorded(launched: LaunchedSotto): Promise<Recorded> {
  return launched.app.evaluate(() => {
    const record = (globalThis as unknown as { sottoRecorded: Recorded }).sottoRecorded
    const taken = { events: record.events, menus: [...record.menus] }
    ;(globalThis as unknown as { sottoRecorded: { events: number; menus: Shown[] } }).sottoRecorded = { events: 0, menus: [] }
    return taken
  })
}

interface HyprClient { readonly address: string; readonly pid: number; readonly mapped: boolean; readonly size: [number, number] }

/** Ctrl and a key from Hyprland's own keyboard, into Sotto's main window (as page-shortcuts.spec.ts presses them). */
async function pressThroughCompositor(launched: LaunchedSotto, key: string): Promise<void> {
  const pid = launched.app.process().pid
  const clients = JSON.parse((await run('hyprctl', ['clients', '-j'])).stdout) as HyprClient[]
  // The widget shares the process; the main window is the larger of its windows.
  const main = clients.filter(client => client.pid === pid && client.mapped).sort((a, b) => b.size[0] * b.size[1] - a.size[0] * a.size[1])[0]!
  await run('hyprctl', ['dispatch', `hl.dsp.focus({ window = "address:${main.address}" })`])
  await expect.poll(async () => JSON.parse((await run('hyprctl', ['activewindow', '-j'])).stdout).address).toBe(main.address)
  await launched.page.waitForTimeout(150)
  const sent = await run('hyprctl', ['dispatch', `hl.dsp.send_shortcut({ mods = "CTRL", key = "${key}", window = "address:${main.address}" })`])
  expect(sent.stdout.trim()).toBe('ok')
}

const EDIT = ['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectall']

async function cursorOf(locator: Locator): Promise<string> {
  return locator.evaluate(element => getComputedStyle(element).cursor)
}

async function open(page: Page, title: string): Promise<void> {
  const row = page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: title, exact: true })
  await row.click({ position: { x: 16, y: 12 } })
  await expect(row).toHaveAttribute('aria-current', 'page')
}

test('a right-click edits text, Ctrl+, opens Settings, and only links show the hand', async () => {
  test.setTimeout(150_000)
  const launched = await launchSotto('design-threads')
  const { page } = launched
  try {
    await prepare(launched)
    await open(page, 'Visual gate flake')
    const pane = page.locator(`section.thread-pane[data-thread-id="${hostKeys.key('visual-gate')}"]`)

    // #1821: the composer and Search threads answer a right-click with the edit menu, its Cut and Copy live once words
    // are selected.
    const prompt = promptField(pane)
    await prompt.click()
    await page.keyboard.type('hello')
    await prompt.click({ button: 'right' })
    let seen = await recorded(launched)
    expect(seen.events).toBe(1)
    expect(seen.menus.map(menu => menu.items)).toEqual([EDIT])
    expect(seen.menus[0]!.enabled).toEqual(expect.arrayContaining(['undo', 'selectall']))
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await prompt.click({ button: 'right', position: { x: 10, y: 10 } })
    seen = await recorded(launched)
    expect(seen.menus.map(menu => menu.items)).toEqual([EDIT])
    expect(seen.menus[0]!.enabled).toEqual(expect.arrayContaining(['cut', 'copy']))
    await page.getByRole('searchbox', { name: 'Search threads' }).click({ button: 'right' })
    expect((await recorded(launched)).menus.map(menu => menu.items)).toEqual([EDIT])

    // Words selected in a reply get Copy; a reply with nothing selected gets nothing.
    const reply = pane.locator('[data-message-id="visual-gate-2"] p').first()
    await reply.click({ button: 'right' })
    expect((await recorded(launched)).menus).toEqual([])
    await reply.click({ clickCount: 3 })
    await reply.click({ button: 'right' })
    expect((await recorded(launched)).menus.map(menu => menu.items)).toEqual([['copy']])

    // The window's own menus cancel the page's event, so Electron reports no right-click and the edit menu never joins them.
    // The reply is still being written, so its Copy is not drawn yet; the message before it has one.
    const asked = pane.locator('[data-message-id="visual-gate-1"]')
    await asked.hover()
    await asked.getByRole('button', { name: 'Copy message as Markdown', exact: true }).click({ button: 'right' })
    await expect(page.getByRole('menu')).toBeVisible()
    expect(await recorded(launched)).toEqual({ events: 0, menus: [] })
    await page.keyboard.press('Escape')

    // #1832: controls show the arrow, the composer the I-beam.
    expect(await cursorOf(pane.getByRole('button', { name: 'Allow', exact: true }))).toBe('default')
    expect(await cursorOf(page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Footer links', exact: true }))).toBe('default')
    expect(await cursorOf(page.getByRole('tab').first())).toBe('default')
    expect(['auto', 'text']).toContain(await cursorOf(prompt))
    // A link in a reply keeps the hand.
    const link = await pane.evaluate(element => {
      const anchor = document.createElement('a')
      anchor.href = 'https://example.com/'
      anchor.className = 'rich-link'
      anchor.textContent = 'example'
      element.querySelector('[data-message-id="visual-gate-2"] p')!.append(anchor)
      const cursor = getComputedStyle(anchor).cursor
      anchor.remove()
      return cursor
    })
    expect(link).toBe('pointer')

    // #1825: Sotto's own menu is installed off a Mac too; this unpackaged run keeps developer tools, as a Mac's would.
    const menu = await launched.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map(item => ({
      label: item.label, items: item.submenu?.items.map(entry => ({ role: entry.role ?? entry.type, label: entry.label, accelerator: entry.accelerator ?? null })) ?? [],
    })) ?? null)
    if (process.platform !== 'darwin') {
      expect(menu?.map(item => item.label)).toHaveLength(2)
      expect(menu?.[0]?.items.find(item => item.label === 'Settings…')?.accelerator).toBe('Control+,')
      expect(menu?.flatMap(item => item.items.map(entry => entry.role))).not.toContain('forcereload')
    }
    // The chord itself needs a key from the system, which a page's synthetic keys never are; the owned nested desktop
    // presses it through the compositor. Elsewhere the menu's own item is chosen, which runs the same path.
    if (nested) await pressThroughCompositor(launched, 'comma')
    else await launched.app.evaluate(({ Menu }) => { Menu.getApplicationMenu()?.items.flatMap(item => item.submenu?.items ?? []).find(item => item.accelerator?.endsWith('+,'))?.click() })
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  } finally { await closeSotto(launched) }
})
