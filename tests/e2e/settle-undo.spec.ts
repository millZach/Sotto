import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { defaultAgentConfiguration } from '../../src/shared/agents'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { holdContentSize } from './support/sottoWindow'

// After a Settle the user pressed (ADR-0167, Zach's pick B of #1826): the settled row's place stays empty while the pointer
// stays over the list, so a second click lands on nothing rather than on the next row's Settle, and a toast at the sidebar's
// foot offers Undo, which is Restore. Run after `npm run build`. Captures go to disposable run evidence;
// `SOTTO_E2E_EVIDENCE=publish` writes artifacts/settle-undo.
const SHOTS = evidenceDirectory('artifacts/settle-undo')

async function capture(page: Page, name: string, keep: () => Promise<void>): Promise<void> {
  for (const appearance of ['dark', 'light'] as const) {
    await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode, accent: 'teal' }), appearance)
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
    await keep()
    await page.screenshot({ path: `${SHOTS}/${name}-${appearance}.png`, animations: 'disabled' })
  }
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark', accent: 'teal' }))
}

/** The threads settled on the shelf by Sotto, by their fixture IDs; the fixture's provider-settled threads are not among them. */
const shelved = (page: Page): Promise<string[]> => page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads
  .filter(thread => Boolean(thread.workspaceSettledAt)).map(thread => thread.id.replace(/^host:[^:]+:/u, '')).sort())

/** A box wholly inside another, to the pixel. */
async function inside(inner: Locator, outer: Locator): Promise<void> {
  const box = (await inner.boundingBox())!, around = (await outer.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(Math.floor(around.x))
  expect(box.y).toBeGreaterThanOrEqual(Math.floor(around.y))
  expect(box.x + box.width).toBeLessThanOrEqual(Math.ceil(around.x + around.width))
  expect(box.y + box.height).toBeLessThanOrEqual(Math.ceil(around.y + around.height))
}

/** The contrast of a control's text on the toast it sits on, from the colours the window drew them in. */
async function contrastOnToast(text: Locator, toast: Locator): Promise<number> {
  const surface = await toast.elementHandle()
  return text.evaluate((element, card) => {
    const paint = document.createElement('canvas').getContext('2d')!
    const rgb = (color: string): number[] => { paint.clearRect(0, 0, 1, 1); paint.fillStyle = color; paint.fillRect(0, 0, 1, 1); return [...paint.getImageData(0, 0, 1, 1).data] }
    const [r, g, b, alpha] = rgb(getComputedStyle(card as Element).backgroundColor)
    if (alpha !== 255) throw new Error('The toast is not opaque, so its contrast cannot be read this way.')
    const luminance = ([red, green, blue]: number[]): number => [red, green, blue].map(value => { const v = value! / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 })
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0)
    const [light, dark] = [luminance(rgb(getComputedStyle(element).color)), luminance([r!, g!, b!])].sort((x, y) => y - x)
    return (light! + 0.05) / (dark! + 0.05)
  }, surface)
}

test('a Settle pressed with the pointer holds its row\'s place, settles nothing else on a second click, and Undo restores it', async () => {
  test.setTimeout(180_000)
  await mkdir(SHOTS, { recursive: true })
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-settle-undo-' })).directory
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark', accent: 'teal' }))
  await writeFile(join(profile, 'agents.json'), JSON.stringify({
    configuration: { ...defaultAgentConfiguration(), enabled: true },
    activeThreadId: 'visual-gate', activeProjectId: 'workshop', draft: '', draftThreadId: null, draftRequestId: null, composing: false, outbox: [],
  }))
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('design-threads', profile)
    const { page } = launched
    await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'connect' }) })
    await holdContentSize(launched, 1600, 1000)
    await openThreads(page)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    const projects = sidebar.getByRole('region', { name: 'Projects' })
    const rowOf = (title: string): Locator => projects.locator('.thread-nav__row', { has: page.getByRole('button', { name: title, exact: true }) })
    const grok = rowOf('Grok voice previews'), wav = rowOf('Streaming WAV stall')
    const gap = projects.locator('.thread-nav__gap')
    const toast = sidebar.locator('.thread-nav__toast [role="status"]')
    const undo = toast.getByRole('button', { name: 'Undo: restore Grok voice previews', exact: true })
    await expect(grok).toBeVisible()
    expect(await shelved(page)).toEqual([])

    /** Points at the row's Settle and presses it, where the pointer then stays; answers where it pressed. */
    const pointerSettle = async (): Promise<{ x: number; y: number }> => {
      await grok.hover()
      const box = (await grok.getByRole('button', { name: 'Settle Grok voice previews', exact: true }).boundingBox())!
      const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      await page.mouse.move(at.x, at.y)
      await page.mouse.down()
      await page.mouse.up()
      await expect(projects.getByRole('button', { name: 'Grok voice previews', exact: true })).toHaveCount(0)
      return at
    }

    // The press: the row goes, its place stays, and the row below does not move under the still pointer.
    const grokAt = (await grok.boundingBox())!, wavAt = (await wav.boundingBox())!
    const pressed = await pointerSettle()
    await expect(gap).toHaveCount(1)
    const gapAt = (await gap.boundingBox())!
    expect(Math.round(gapAt.y)).toBe(Math.round(grokAt.y))
    expect(Math.round(gapAt.height)).toBe(Math.round(grokAt.height))
    expect(Math.round((await wav.boundingBox())!.y)).toBe(Math.round(wavAt.y))
    await expect.poll(() => shelved(page)).toEqual(['grok-previews'])
    // The pointer is still where it pressed, over the empty place.
    expect(pressed.y).toBeGreaterThan(gapAt.y)
    expect(pressed.y).toBeLessThan(gapAt.y + gapAt.height)

    // The second click, without moving: it lands on the empty place and settles nothing else.
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForTimeout(400)
    expect(await shelved(page)).toEqual(['grok-previews'])
    await expect(wav.getByRole('button', { name: 'Streaming WAV stall', exact: true })).toBeVisible()
    expect(Math.round((await wav.boundingBox())!.y)).toBe(Math.round(wavAt.y))

    // The toast at the sidebar's foot says what was settled, with Undo and its keys, and has not taken the focus.
    await expect(toast).toHaveText(/^Settled Grok voice previews/)
    await expect(undo).toHaveAttribute('aria-keyshortcuts', 'Control+Z')
    await expect(undo).toHaveAttribute('title', 'Undo (Ctrl+Z)')
    await expect(undo).not.toBeFocused()
    await inside(toast, sidebar)
    expect((await toast.boundingBox())!.y).toBeGreaterThan((await projects.boundingBox())!.y)
    // Its words and Undo read at 4.5:1 or better on the toast, by night and by day.
    const contrasts: Record<string, number> = {}
    await capture(page, 'held-gap-1600x1000', async () => {
      await expect(gap).toHaveCount(1)
      await expect(undo).toBeVisible()
      const mode = await page.locator('html').getAttribute('data-theme')
      contrasts[`${mode} words`] = await contrastOnToast(toast.locator('.settle-toast__words'), toast)
      contrasts[`${mode} Undo`] = await contrastOnToast(undo, toast)
    })
    for (const ratio of Object.values(contrasts)) expect(ratio).toBeGreaterThanOrEqual(4.5)
    await writeFile(join(SHOTS, 'contrast.json'), `${JSON.stringify(Object.fromEntries(Object.entries(contrasts).map(([part, ratio]) => [part, Math.round(ratio * 100) / 100])), null, 2)}\n`)

    // Undo restores it where it stood; nothing else was ever settled.
    await undo.click()
    await expect(grok).toBeVisible()
    await expect(toast).toHaveCount(0)
    expect(Math.round((await grok.boundingBox())!.y)).toBe(Math.round(grokAt.y))
    await expect.poll(() => shelved(page)).toEqual([])

    // The pointer leaving the list closes the gap, and the next row moves up into it. Ctrl+Z, from no field, undoes.
    await pointerSettle()
    await expect(gap).toHaveCount(1)
    const room = (await page.locator('section.thread-pane[data-focused]').boundingBox())!
    await page.mouse.move(room.x + room.width / 2, room.y + room.height / 2)
    await expect(gap).toHaveCount(0)
    await expect.poll(async () => Math.round((await wav.boundingBox())!.y)).toBe(Math.round(grokAt.y))
    await page.keyboard.press('Control+Z')
    await expect(grok).toBeVisible()
    await expect.poll(() => shelved(page)).toEqual([])

    // From the keyboard nothing is held: the row menu's Settle moves the focus to the row now in its place, as the thread
    // list does (ADR-0164), and the toast still offers Undo, which Ctrl+Z presses from the row.
    const grokButton = projects.getByRole('button', { name: 'Grok voice previews', exact: true })
    await grokButton.focus()
    await page.keyboard.press('Shift+F10')
    const menu = sidebar.getByRole('menu', { name: 'Actions for Grok voice previews' })
    await expect(menu).toBeVisible()
    for (let steps = 0; steps < 10 && !await menu.getByRole('menuitem', { name: 'Settle', exact: true }).evaluate(item => item === document.activeElement); steps += 1) await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(grokButton).toHaveCount(0)
    await expect(gap).toHaveCount(0)
    await expect(wav.getByRole('button', { name: 'Streaming WAV stall', exact: true })).toBeFocused()
    await expect(undo).toBeVisible()
    await page.keyboard.press('Control+Z')
    await expect(grokButton).toBeVisible()
    await expect(wav.getByRole('button', { name: 'Streaming WAV stall', exact: true })).toBeFocused()

    // The Settle shortcut gets the same toast for the thread on screen.
    await page.locator('section.thread-pane[data-focused]').getByRole('log', { name: 'Thread transcript' }).focus()
    await page.keyboard.press('Control+Shift+E')
    const shortcutUndo = toast.getByRole('button', { name: 'Undo: restore Visual gate flake', exact: true })
    await expect(shortcutUndo).toBeVisible()
    await expect.poll(() => shelved(page)).toEqual(['visual-gate'])
    await page.keyboard.press('Control+Z')
    await expect(shortcutUndo).toHaveCount(0)
    await expect.poll(() => shelved(page)).toEqual([])

    // At the minimum window the gap and the toast are whole, in both modes; under reduced motion the gap goes at once.
    await holdContentSize(launched, 820, 560)
    await expect(grok).toBeVisible()
    await pointerSettle()
    await expect(gap).toHaveCount(1)
    await inside(toast, sidebar)
    expect(await toast.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await capture(page, 'held-gap-820x560', async () => { await expect(gap).toHaveCount(1); await expect(undo).toBeVisible() })
    await undo.click()
    await expect(grok).toBeVisible()

    // Collapsed to the rail, the shortcut's toast stands beside the rail's foot, whole and inside the window.
    await sidebar.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    await page.locator('section.thread-pane[data-focused]').getByRole('log', { name: 'Thread transcript' }).focus()
    await page.keyboard.press('Control+Shift+E')
    await expect(shortcutUndo).toBeVisible()
    const view = { width: 820, height: 560 }
    const railToast = (await toast.boundingBox())!
    expect(railToast.x).toBeGreaterThan((await sidebar.boundingBox())!.x + 40)
    expect(railToast.x + railToast.width).toBeLessThanOrEqual(view.width)
    expect(railToast.y + railToast.height).toBeLessThanOrEqual(view.height)
    await capture(page, 'rail-toast-820x560', async () => { await expect(shortcutUndo).toBeVisible() })
    await shortcutUndo.click()
    await expect.poll(() => shelved(page)).toEqual([])
    await sidebar.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    await expect(grok).toBeVisible()

    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'on' }))
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
    await pointerSettle()
    await expect(gap).toHaveCount(1)
    const smallRoom = (await page.locator('section.thread-pane[data-focused]').boundingBox())!
    await page.mouse.move(smallRoom.x + 40, smallRoom.y + 40)
    expect(await page.evaluate(() => new Promise<number>(done => requestAnimationFrame(() => done(document.querySelectorAll('.thread-nav__gap').length))))).toBe(0)
    await undo.click()
    await expect(grok).toBeVisible()
    await expect.poll(() => shelved(page)).toEqual([])
  } finally {
    if (launched) await closeSotto(launched)
  }
})
