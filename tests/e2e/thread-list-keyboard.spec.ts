import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { defaultAgentConfiguration } from '../../src/shared/agents'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { holdContentSize } from './support/sottoWindow'

// The Threads keyboard path (ADR-0164, Zach's pick A of #1827): the thread list is one Tab stop walked with the arrow
// keys, a row's actions are its menu on Shift+F10, the menu key and a right-click, and F6 and Shift+F6 go round the
// sidebar, the focused pane and its composer. Run after `npm run build`. Captures go to disposable run evidence;
// `SOTTO_E2E_EVIDENCE=publish` writes artifacts/thread-list-keyboard.
const SHOTS = evidenceDirectory('artifacts/thread-list-keyboard')

/** What has the focus, by its name, and whether it is in the thread list or the composer's field. */
const focused = (page: Page): Promise<{ name: string; list: boolean; sidebar: boolean; composer: boolean }> => page.evaluate(() => {
  const element = document.activeElement as HTMLElement
  const name = element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent?.trim().slice(0, 48) ?? element.tagName
  return { name, list: element.closest('.thread-nav__list') !== null, sidebar: element.closest('aside.thread-nav') !== null,
    composer: element.closest('.thread-workspace__compose') !== null && element.matches('[contenteditable="true"], textarea') }
})

/** Tab from Search threads until the focused pane's composer has the focus, naming every stop on the way. */
async function tabWalk(page: Page, limit = 90): Promise<{ name: string; list: boolean; sidebar: boolean }[]> {
  await page.getByRole('searchbox', { name: 'Search threads' }).focus()
  const stops: { name: string; list: boolean; sidebar: boolean }[] = []
  for (let press = 0; press < limit; press += 1) {
    await page.keyboard.press('Tab')
    const here = await focused(page)
    stops.push({ name: here.name, list: here.list, sidebar: here.sidebar })
    if (here.composer) return stops
  }
  throw new Error(`The composer was not reached in ${limit} presses of Tab: ${stops.map(stop => stop.name).join(' | ')}`)
}

/** The window's content at exactly this size, held: the nested Linux desktop can hand a new window its first size back. */
async function size(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await holdContentSize(launched, width, height, [820, 560])
}

async function capture(page: Page, name: string, keep: () => Promise<void>): Promise<void> {
  for (const appearance of ['dark', 'light'] as const) {
    await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode, accent: 'teal' }), appearance)
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
    await keep()
    await page.screenshot({ path: `${SHOTS}/${name}-${appearance}.png`, animations: 'disabled' })
  }
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark', accent: 'teal' }))
}

/** The menu lies wholly inside the window. */
async function insideWindow(page: Page, menu: Locator): Promise<void> {
  const box = (await menu.boundingBox())!
  const view = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(view.width)
  expect(box.y + box.height).toBeLessThanOrEqual(view.height)
}

test('the thread list is one Tab stop with a row menu, and F6 goes round the sidebar, the pane and its composer', async () => {
  test.setTimeout(240_000)
  await mkdir(SHOTS, { recursive: true })
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-thread-list-keyboard-' })).directory
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark', accent: 'teal' }))
  await writeFile(join(profile, 'agents.json'), JSON.stringify({
    configuration: { ...defaultAgentConfiguration(), enabled: true },
    activeThreadId: 'wav-stall', activeProjectId: 'workshop', draft: '', draftThreadId: null, draftRequestId: null, composing: false, outbox: [],
  }))
  const launched = await launchSotto('design-threads', profile)
  try {
    const page = launched.page
    await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'connect' }) })
    await size(launched, 1600, 1000)
    await openThreads(page)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    const row = sidebar.getByRole('button', { name: 'Streaming WAV stall', exact: true })
    await expect(row).toBeVisible()

    // Tab from Search threads to the composer: the thread list is one stop, and it is the thread on screen.
    const walk = await tabWalk(page)
    const inList = walk.filter(stop => stop.list)
    expect(inList.map(stop => stop.name)).toEqual(['Streaming WAV stall'])
    // 51 presses on main before this change (artifacts/thread-list-keyboard/tab-walk-before.json); the sidebar is now the
    // list, the foot's room tab and page links, and the resize handle.
    expect(walk.filter(stop => stop.sidebar).length).toBeLessThan(12)

    // Into the list again: Up and Down walk it, Home and End go to its ends, and the list keeps the row it held.
    await page.getByRole('searchbox', { name: 'Search threads' }).focus()
    while (!(await focused(page)).list) await page.keyboard.press('Tab')
    await expect(row).toBeFocused()
    await page.keyboard.press('ArrowDown')
    const below = (await focused(page)).name
    expect(below).not.toBe('Streaming WAV stall')
    await page.keyboard.press('ArrowUp')
    await expect(row).toBeFocused()
    await page.keyboard.press('Home')
    expect((await focused(page)).name).toMatch(/^workshop \d+ threads?$/u)
    await page.keyboard.press('End')
    expect((await focused(page)).name).toMatch(/^Settled/u)
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    expect((await focused(page)).name).toMatch(/^Settled/u)
    await page.keyboard.press('Home')
    for (let steps = 0; steps < 20 && !await row.evaluate(node => node === document.activeElement); steps += 1) await page.keyboard.press('ArrowDown')
    await expect(row).toBeFocused()
    // The row's own hover icons are out of the Tab order.
    await expect(sidebar.getByRole('button', { name: 'Rename Streaming WAV stall', exact: true })).toHaveAttribute('tabindex', '-1')
    await capture(page, 'focused-row-1600x1000', async () => { await expect(row).toBeFocused() })

    // Shift+F10 opens the row's menu in words with its keys; Escape puts it away and the focus back on the row.
    await page.keyboard.press('Shift+F10')
    const menu = sidebar.getByRole('menu', { name: 'Actions for Streaming WAV stall' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Open', exact: true })).toBeFocused()
    await expect(menu.getByRole('menuitem', { name: 'Rename', exact: true })).toHaveAttribute('aria-keyshortcuts', 'F2')
    await expect(menu.getByRole('menuitem', { name: 'Settle', exact: true })).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+E')
    await insideWindow(page, menu)
    await capture(page, 'row-menu-1600x1000', async () => { await expect(menu).toBeVisible() })
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitem', { name: 'Rename', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(row).toBeFocused()

    // The menu key, and a right-click at the pointer, open the same menu.
    await page.keyboard.press('ContextMenu')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(row).toBeFocused()
    const rowBox = (await row.boundingBox())!
    await page.mouse.click(rowBox.x + 40, rowBox.y + 12, { button: 'right' })
    await expect(menu).toBeVisible()
    const menuBox = (await menu.boundingBox())!
    expect(Math.abs(menuBox.x - (rowBox.x + 40))).toBeLessThan(4)
    await page.keyboard.press('Escape')
    await expect(row).toBeFocused()

    // F2 renames in place, and the focus comes back to the row.
    await page.keyboard.press('F2')
    await expect(sidebar.getByRole('textbox', { name: 'Rename Streaming WAV stall' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(row).toBeFocused()

    // F6 from the row: the focused pane's transcript, its composer, then the row again; Shift+F6 goes back round.
    const pane = page.locator('section.thread-pane[data-focused]')
    const transcript = pane.getByRole('log', { name: 'Thread transcript' })
    const prompt = pane.locator('.thread-workspace__compose .prompt-editor[contenteditable="true"]')
    await page.keyboard.press('F6')
    await expect(transcript).toBeFocused()
    await page.keyboard.press('F6')
    await expect(prompt).toBeFocused()
    await page.keyboard.press('F6')
    await expect(row).toBeFocused()
    await page.keyboard.press('Shift+F6')
    await expect(prompt).toBeFocused()
    await page.keyboard.press('Shift+F6')
    await expect(transcript).toBeFocused()
    await page.keyboard.press('Shift+F6')
    await expect(row).toBeFocused()

    // In a split, F6 from the sidebar starts at the focused pane and goes round every pane before it comes back. Ctrl+Enter
    // on a row opens it beside from the keyboard, which leaves the focus on the row and focuses the new pane.
    const footerRow = sidebar.getByRole('button', { name: 'Footer links', exact: true })
    while (!await footerRow.evaluate(node => node === document.activeElement)) await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Control+Enter')
    const footer = page.locator('section.thread-pane[data-thread-id$="footer-links"]')
    const wav = page.locator('section.thread-pane[data-thread-id$="wav-stall"]')
    await expect(footer).toHaveAttribute('data-focused')
    await expect(footerRow).toBeFocused()
    const trip = [footer.getByRole('log', { name: 'Thread transcript' }), footer.locator('.prompt-editor[contenteditable="true"]'),
      wav.getByRole('log', { name: 'Thread transcript' }), wav.locator('.prompt-editor[contenteditable="true"]'), footerRow]
    for (const stop of trip) {
      await page.keyboard.press('F6')
      await expect(stop).toBeFocused()
    }
    await expect(wav).toHaveAttribute('data-focused')
    await footer.getByRole('button', { name: 'Close Footer links pane' }).click()
    await expect(footer).toHaveCount(0)

    // At 1280x800 with reduced motion on, the menu is whole and still.
    await size(launched, 1280, 800)
    await row.focus()
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'on' }))
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
    await page.keyboard.press('Shift+F10')
    await expect(menu).toBeVisible()
    await insideWindow(page, menu)
    expect(await menu.evaluate(node => getComputedStyle(node).animationName)).toBe('none')
    await page.keyboard.press('Escape')
    await expect(row).toBeFocused()
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'system' }))

    // At the minimum window the row and its menu are whole.
    await size(launched, 820, 560)
    await row.focus()
    await capture(page, 'focused-row-820x560', async () => { await expect(row).toBeFocused() })
    await page.keyboard.press('Shift+F10')
    await expect(menu).toBeVisible()
    await insideWindow(page, menu)
    await capture(page, 'row-menu-820x560', async () => { await expect(menu).toBeVisible(); await insideWindow(page, menu) })
    await page.keyboard.press('Escape')
    await expect(row).toBeFocused()
    const narrow = await tabWalk(page)
    expect(narrow.filter(stop => stop.list).map(stop => stop.name)).toEqual(['Streaming WAV stall'])
    expect(narrow.length).toBe(walk.length)
  } finally {
    await closeSotto(launched)
  }
})
