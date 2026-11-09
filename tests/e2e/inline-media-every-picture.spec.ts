/**
 * **Show every picture and video an agent makes** (ADR-0170, part 7), in the running app: on, as it starts, what a turn
 * wrote shows on its own, small, in its step's line (pictures in steps, November 9, 2026), and opens in the viewer with
 * Mark up. Off, from Settings, the next turn's file shows nothing. The captures are run evidence
 * (docs/ci.md), published to `artifacts/inline-media/`.
 */
import { randomUUID } from 'node:crypto'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { openThreads, resizeWindow } from './support/sottoLaunch'
import { captureInlineMedia as capture, SHOWN_PICTURE, withShownPictureThread } from './support/shownPictureThread'

test('what a turn wrote shows in its step with the switch on, opens in the viewer, and shows nothing after it is turned off', async () => {
  test.setTimeout(240_000)
  await withShownPictureThread('sotto-e2e-every-picture-', async ({ launched, page, pane, threadId, root, project }) => {
    const thumb = pane.getByRole('button', { name: /^Open picture 1 of 1, from Pictures and videos it wrote/u })
    await expect(thumb).toBeVisible({ timeout: 30_000 })
    await expect(thumb.locator('img')).toHaveJSProperty('complete', true, { timeout: 30_000 })
    // It sits small in the turn's line, not as a tile across the thread.
    await expect(thumb).toHaveClass(/step-pictures__thumb/u)
    await expect(pane.locator('.thread-media')).toHaveCount(0)
    const box = await thumb.boundingBox()
    expect(box!.width).toBeLessThan(40)
    await capture(page, 'written-in-step-1280-dark')
    // A press opens the viewer as a tile's did, with Mark up.
    await thumb.click()
    const viewer = pane.getByRole('dialog')
    await expect(viewer).toBeVisible()
    await expect(viewer.getByRole('button', { name: 'Mark up' })).toBeVisible()
    await capture(page, 'written-in-step-viewer-1280-dark')
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
    // Open, the turn's line lets its pictures go to the step that made them, at that line's end.
    await pane.getByRole('button', { name: /^Worked for/u }).click()
    const row = pane.locator('.thread-activity__row').filter({ has: page.locator('.step-pictures__thumb') })
    await expect(row).toHaveCount(1)
    await expect(pane.locator('.step-pictures__thumb')).toHaveCount(1)
    await capture(page, 'written-in-step-open-1280-dark')
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'light' }) })
    await capture(page, 'written-in-step-open-1280-light')
    await resizeWindow(launched, 820, 560)
    await capture(page, 'written-in-step-open-820-light')
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
    await resizeWindow(launched, 1280, 800)
    await pane.getByRole('button', { name: /^Worked for/u }).click()

    // The switch is under What agents can do without asking, and says what each position does.
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Threads', exact: true }).click()
    const toggle = page.getByRole('switch', { name: 'Show every picture and video an agent makes' })
    await toggle.scrollIntoViewIfNeeded()
    await expect(toggle).toBeChecked()
    await capture(page, 'switch-1280-dark')
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'light' }) })
    await capture(page, 'switch-1280-light')
    await resizeWindow(launched, 820, 560)
    await toggle.scrollIntoViewIfNeeded()
    await capture(page, 'switch-820-light')
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
    await resizeWindow(launched, 1280, 800)
    await toggle.click()
    await expect(toggle).not.toBeChecked()
    expect(await page.evaluate(async () => (await window.sotto!.getSettings()).showEveryAgentPicture)).toBe(false)
    await openThreads(page)

    // Off, the next turn writes a file and ends, and the thread gains no tile for it.
    await page.evaluate(async threadId => {
      const sent = await window.sotto!.agents!.command({ type: 'manual-send', threadId, text: 'Take another one.' })
      if (sent.error) throw new Error(sent.error)
    }, threadId)
    const state = JSON.parse(await readFile(join(root, 'codex', 'state.json'), 'utf8')) as { threads: Record<string, { id: string }> }
    const native = Object.values(state.threads)[0]!.id
    await copyFile(SHOWN_PICTURE, join(project, 'test-results', 'second.png'))
    const id = randomUUID()
    await writeFile(join(root, 'codex', 'control.json'), JSON.stringify({ id, threadId: native, type: 'complete', text: 'Here is another one.' }))
    await expect.poll(async () => (await readFile(join(root, 'codex', 'actions.jsonl'), 'utf8').catch(() => '')).includes(id), { timeout: 30_000 }).toBe(true)
    await expect(pane.getByText('Here is another one.')).toBeVisible({ timeout: 30_000 })
    await expect(pane.getByRole('button', { name: /^Open picture/u })).toHaveCount(1)
  }, { everyPicture: true })
})

test('a turn that wrote five pictures shows its newest three at the end of its line, and the count opens the first', async () => {
  test.setTimeout(240_000)
  await withShownPictureThread('sotto-e2e-step-pictures-', async ({ page, pane }) => {
    const strip = pane.getByRole('group', { name: 'Pictures: 5' })
    await expect(strip).toBeVisible({ timeout: 30_000 })
    await expect(strip.locator('.step-pictures__thumb')).toHaveCount(3)
    const count = strip.getByRole('button', { name: 'Open all 5 pictures' })
    await expect(count).toHaveText('+2')
    await expect(pane.locator('.thread-media')).toHaveCount(0)
    await expect(strip.locator('img').first()).toHaveJSProperty('complete', true, { timeout: 30_000 })
    await capture(page, 'five-in-step-1280-dark')
    await count.click()
    const viewer = pane.getByRole('dialog')
    await expect(viewer).toBeVisible()
    await expect(viewer.locator('.attachment-viewer__title')).toContainText(/^Picture 1\D/u)
    await page.keyboard.press('ArrowRight')
    await expect(viewer.locator('.attachment-viewer__title')).toContainText(/^Picture 2\D/u)
    await page.keyboard.press('Escape')
    await pane.getByRole('button', { name: /^Worked for/u }).click()
    await expect(pane.getByRole('group', { name: 'Pictures: 5' })).toHaveCount(1)
    // The fold settles before the capture, so it shows the row as it stays.
    await pane.locator('.thread-fold').first().evaluate(fold => Promise.all(fold.getAnimations({ subtree: true }).map(animation => animation.finished)))
    await capture(page, 'five-in-step-open-1280-dark')
  }, { everyPicture: true, pictures: 5 })
})
