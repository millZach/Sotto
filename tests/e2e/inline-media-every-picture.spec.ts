/**
 * **Show every picture and video an agent makes** (ADR-0170, part 7), in the running app: on, as it starts, what a turn
 * wrote shows on its own as a tile. Off, from Settings, the next turn's file shows nothing. The captures are run evidence
 * (docs/ci.md), published to `artifacts/inline-media/`.
 */
import { randomUUID } from 'node:crypto'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { openThreads, resizeWindow } from './support/sottoLaunch'
import { captureInlineMedia as capture, SHOWN_PICTURE, withShownPictureThread } from './support/shownPictureThread'

test('what a turn wrote shows on its own with the switch on, and not after it is turned off in Settings', async () => {
  test.setTimeout(240_000)
  await withShownPictureThread('sotto-e2e-every-picture-', async ({ launched, page, pane, threadId, root, project }) => {
    const tile = pane.getByRole('button', { name: /^Open picture 1 of 1, from Pictures and videos it wrote/u })
    await expect(tile).toBeVisible({ timeout: 30_000 })
    await expect(tile.locator('img')).toHaveJSProperty('complete', true, { timeout: 30_000 })
    await capture(page, 'written-tile-1280-dark')

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
