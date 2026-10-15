import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { promptField } from './support/prompt'
import { closeSotto, launchSotto, openThreads } from './support/sottoLaunch'

// The built app: a screenshot sent in a thread opens over that thread's pane, and Copy image goes through main's
// clipboard channel. Checked at the three window sizes in both appearances.
const evidence = evidenceDirectory('artifacts/image-viewer')

test('a sent screenshot opens over its pane at every window size and copies through main', async () => {
  test.setTimeout(90_000)
  const launched = await launchSotto()
  const { page } = launched
  const image = (await readFile('build/icon.png')).toString('base64')
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload(); await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    await promptField(page).evaluate((element, data) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([Uint8Array.from(atob(data), char => char.charCodeAt(0))], 'Screenshot.png', { type: 'image/png' }))
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
    }, image)
    await expect(page.getByLabel('Attached screenshots').getByAltText('Screenshot.png')).toBeVisible()
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    const transcript = page.getByLabel('Thread transcript', { exact: true })
    const thumbnail = transcript.getByRole('button', { name: 'Open Screenshot.png' })
    await expect(thumbnail).toBeVisible()
    await page.emulateMedia({ reducedMotion: 'reduce' })

    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await launched.app.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(size.width, size.height)
      }, { width, height })
      await thumbnail.scrollIntoViewIfNeeded()
      await thumbnail.click()
      const viewer = page.getByRole('dialog', { name: /Screenshot\.png/u })
      await expect(viewer).toBeVisible()
      await expect(viewer.getByRole('group', { name: 'Image view' })).toBeFocused()
      // Over the pane, not the window: the pane's box is the viewer's, and every control is inside the window
      // (whose minimum size can leave it a few pixels larger than asked).
      expect(await viewer.boundingBox()).toEqual(await page.locator('.thread-pane').first().boundingBox())
      const inner = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      for (const name of ['Zoom out', 'Zoom in', 'Fit to view', 'Copy image', 'Close image']) {
        const box = (await viewer.getByRole('button', { name }).boundingBox())!
        expect(box.x + box.width).toBeLessThanOrEqual(inner.width)
        expect(box.y + box.height).toBeLessThanOrEqual(inner.height)
      }
      const hint = (await viewer.locator('.rich-diagram-viewer__hint').boundingBox())!
      expect(hint.y + hint.height).toBeLessThanOrEqual(inner.height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        await page.screenshot({ path: join(evidence, `app-viewer-${width}-${appearance}.png`), animations: 'disabled' })
      }
      await viewer.getByRole('button', { name: 'Copy image' }).click()
      await expect(viewer.locator('.rich-code__status')).toHaveText('Copied image')
      await page.keyboard.press('Escape')
      await expect(viewer).toBeHidden()
      await expect(thumbnail).toBeFocused()
    }
  } finally { await closeSotto(launched) }
})
