import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { defaultAgentConfiguration } from '../../src/shared/agents'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, openThreads, paneMenuToggle, type LaunchedSotto } from './support/sottoLaunch'
import { promptField } from './support/prompt'
import { holdContentSize } from './support/sottoWindow'

// A pane's header (ADR-0163, #1828): the title, project and folder, then pinned to the right in a fixed order the Git
// action (only while there is something to commit, push or open), Watch, one ··· menu and, in a split, close. The ···
// menu holds the layout rows and the thread's own, Initialize Git among them; the title is the handle that moves a pane.
// Run after `npm run build`. Captures go to disposable run evidence; `SOTTO_E2E_EVIDENCE=publish` writes artifacts/pane-header-one-menu.
const SHOTS = evidenceDirectory('artifacts/pane-header-one-menu')

const pane = (page: Page, id: string): Locator => page.locator(`section.thread-pane[data-thread-id$="${id}"]`)
const header = (page: Page, id: string): Locator => pane(page, id).locator('header.thread-workspace__head')

/** The header's controls, left to right, by what they are. */
const controls = (scope: Locator): Promise<string[]> => scope.locator('.thread-workspace__actions').evaluate(actions =>
  [...actions.children].map(child => child.classList.contains('git-action') ? 'git' : child.classList.contains('watch-toggle') ? 'watch'
    : child.classList.contains('pane-menu') ? 'more' : child.classList.contains('thread-pane__close') ? 'close' : child.className))

/** Where each control sits, from the pane's right edge, so a control that keeps its place reads the same. */
const fromRight = (scope: Locator): Promise<number[]> => scope.evaluate(head => {
  const edge = head.closest('section.thread-pane')!.getBoundingClientRect().right
  return [...head.querySelectorAll<HTMLElement>('.thread-workspace__actions > *')].map(control => Math.round(edge - control.getBoundingClientRect().left))
})

/** The parts of the title that are cut off: the name, the project and the folder. */
const cut = (scope: Locator): Promise<string[]> => scope.evaluate(head =>
  [...head.querySelectorAll<HTMLElement>('h2, .thread-workspace__crumb > span:first-of-type, .working-copy__trigger, .working-copy__label')]
    .filter(part => part.offsetWidth > 0 && part.scrollWidth > part.clientWidth + 1).map(part => part.textContent ?? ''))

/** The window's content at exactly this size, held: the nested Linux desktop can hand a new window its first size back. */
async function size(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await holdContentSize(launched, width, height, [820, 560])
}

async function capture(page: Page, name: string): Promise<void> {
  for (const appearance of ['dark', 'light'] as const) {
    await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode, accent: 'teal' }), appearance)
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
    await page.screenshot({ path: `${SHOTS}/${name}-${appearance}.png`, animations: 'disabled' })
  }
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark', accent: 'teal' }))
}

test('a pane header carries the Git action, Watch, one ··· menu and close, and keeps them still as the divider moves', async () => {
  test.setTimeout(180_000)
  await mkdir(SHOTS, { recursive: true })
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-pane-header-' })).directory
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
    await sidebar.getByRole('button', { name: 'Footer links', exact: true }).hover({ position: { x: 16, y: 12 } })
    await sidebar.getByRole('button', { name: 'Open Footer links beside', exact: true }).click()
    const left = header(page, 'wav-stall'), right = header(page, 'footer-links')
    await expect(pane(page, 'footer-links')).toBeVisible()

    // The order is fixed and the same in both panes; nothing is drawn for the layout outside the menu.
    for (const head of [left, right]) {
      expect((await controls(head)).filter(control => control !== 'git')).toEqual(['watch', 'more', 'close'])
      await expect(head.getByRole('button', { name: /^(Initialize Git|Terminal drawer|Tools|Zoom|Move)/ })).toHaveCount(0)
    }
    await expect(page.locator('.thread-pane__controls, .thread-pane__grip')).toHaveCount(0)
    // Two panes side by side at 1600x1000: the title, project and folder are shown, and whole.
    await expect(left.locator('.thread-workspace__crumb > span').first()).toHaveText('workshop')
    await expect(left.locator('.thread-workspace__crumb > span').first()).toBeVisible()
    await expect(right.locator('.thread-workspace__crumb > span').first()).toBeVisible()
    expect(await cut(left)).toEqual([])
    expect(await cut(right)).toEqual([])
    await capture(page, 'split-1600x1000')

    // The ··· menu: the layout rows with their keys, then the thread's own. The fixture's folders have no Git status, so
    // Initialize Git, first of the thread's own for a folder without Git, is proved in git-actions.spec.ts.
    const more = left.getByRole('button', { name: 'More actions', exact: true })
    await more.click()
    const menu = left.getByRole('menu', { name: 'More actions' })
    const rows = await menu.locator('[role^="menuitem"]').evaluateAll(items => items.map(item => item.querySelector('.pane-menu__label')?.textContent ?? item.textContent))
    expect(rows.slice(0, 5)).toEqual(['Open beside', 'Tools', 'Terminal drawer', 'Zoom pane', 'Move pane right'])
    expect(rows).toContain('Rename')
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Terminal drawer' })).toHaveAttribute('aria-keyshortcuts', /J$/)
    await expect(menu.getByRole('menuitem', { name: 'Zoom pane' })).toHaveAttribute('aria-keyshortcuts', /Shift\+M$/)
    await capture(page, 'menu-1600x1000')
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(more).toBeFocused()

    // The drawer's keys still find the pane though its button is a menu row now, and the row is ticked while it shows.
    await promptField(pane(page, 'wav-stall')).focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+KeyJ' : 'Control+KeyJ')
    await expect(pane(page, 'wav-stall').locator('.pane-terminal')).toBeVisible()
    await more.click()
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Terminal drawer' })).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
    await paneMenuToggle(pane(page, 'wav-stall'), 'Terminal drawer')
    await expect(pane(page, 'wav-stall').locator('.pane-terminal')).toHaveCount(0)

    // Dragging the divider moves the left pane's edge and its controls with it, and moves nothing in either header against
    // its own pane's right edge: the right pane's controls stay where they were on screen.
    const leftBefore = await fromRight(left), rightBefore = await fromRight(right)
    const rightOnScreen = await right.locator('.thread-workspace__actions').boundingBox()
    const divider = page.getByRole('separator', { name: 'Resize panes' })
    const box = (await divider.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x - 160, box.y + box.height / 2, { steps: 12 })
    await page.mouse.up()
    expect(await fromRight(left)).toEqual(leftBefore)
    expect(await fromRight(right)).toEqual(rightBefore)
    expect((await right.locator('.thread-workspace__actions').boundingBox())!.x).toBeCloseTo(rightOnScreen!.x, 0)
    await divider.dblclick()

    // Move pane from the menu, by the keyboard: the panes trade places and focus stays on the ··· button.
    await more.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('End')
    await expect(left.getByRole('menu', { name: 'More actions' }).getByRole('menuitem', { name: 'Move pane right' })).toBeVisible()
    await left.getByRole('menu', { name: 'More actions' }).getByRole('menuitem', { name: 'Move pane right' }).click()
    await expect.poll(() => page.locator('section.thread-pane').evaluateAll(sections => sections.map(section => section.getAttribute('aria-label')))).toEqual(['Footer links', 'Streaming WAV stall'])
    await expect(pane(page, 'wav-stall').getByRole('button', { name: 'More actions', exact: true })).toBeFocused()

    // The title is the handle: dragged onto the other pane, the panes trade places back.
    const title = pane(page, 'wav-stall').locator('.thread-workspace__title h2')
    await title.dragTo(pane(page, 'footer-links').locator('.thread-workspace__transcript, [role="log"]').first())
    await expect.poll(() => page.locator('section.thread-pane').evaluateAll(sections => sections.map(section => section.getAttribute('aria-label')))).toEqual(['Streaming WAV stall', 'Footer links'])

    await size(launched, 1280, 800)
    expect((await controls(left)).filter(control => control !== 'git')).toEqual(['watch', 'more', 'close'])
    await capture(page, 'split-1280x800')
    await size(launched, 820, 560)
    // At the minimum the panes become tabs, and the shown pane keeps the same header, nothing clipped.
    const shown = page.locator('section.thread-pane:not([data-hidden]) header.thread-workspace__head')
    expect((await controls(shown)).filter(control => control !== 'git')).toEqual(['watch', 'more', 'close'])
    const overflow = await shown.evaluate(head => [...head.querySelectorAll<HTMLElement>('.thread-workspace__actions > *')]
      .filter(control => control.getBoundingClientRect().right > head.getBoundingClientRect().right + 0.5 || control.getBoundingClientRect().left < head.getBoundingClientRect().left).length)
    expect(overflow).toBe(0)
    await capture(page, 'tabs-820x560')
  } finally {
    await closeSotto(launched)
  }
})
