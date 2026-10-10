import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { decodedSize, openWorkshopComposer, pasteDrawnScreenshot, savedAttachment } from '../fixtures/drawnScreenshot'
import { closeSotto, launchSotto } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

const RUN = evidenceDirectory('artifacts/screenshot-resize-run')

test('a screenshot past the bound is scaled down in its own format, and its chip says so', async () => {
  test.setTimeout(90_000)
  await mkdir(RUN, { recursive: true })
  const launched = await launchSotto()
  const { page } = launched
  try {
    const prompt = await openWorkshopComposer(page)
    const previews = page.getByLabel('Attached screenshots')
    await expect(page.getByRole('button', { name: 'Attach screenshots', exact: true })).toBeEnabled()

    await pasteDrawnScreenshot(prompt, { name: '4K capture.png', type: 'image/png', width: 3840, height: 2160, photo: 0.25 })
    await expect(previews.getByAltText('4K capture.png')).toBeVisible()
    const large = await savedAttachment(page, '4K capture.png')
    expect(large.mimeType).toBe('image/png')
    expect(large.dimensions).toEqual({ original: { width: 3840, height: 2160 }, sent: { width: 2576, height: 1449 } })
    expect(await decodedSize(page, large)).toEqual({ width: 2576, height: 1449 })
    // Both sizes are on the chip, where a keyboard user sees them as well as a pointer user.
    await expect(previews.getByText('Resized from 3840 x 2160 to 2576 x 1449', { exact: true })).toBeVisible()
    await expect(previews.getByText('Resized from 3840 by 2160 to 2576 by 1449 pixels')).toBeAttached()

    await pasteDrawnScreenshot(prompt, { name: 'Small capture.png', type: 'image/png', width: 1200, height: 800, photo: 0.25 })
    await expect(previews.getByAltText('Small capture.png')).toBeVisible()
    const small = await savedAttachment(page, 'Small capture.png')
    expect(small.dimensions).toEqual({ original: { width: 1200, height: 800 }, sent: { width: 1200, height: 800 } })
    expect(await decodedSize(page, small)).toEqual({ width: 1200, height: 800 })

    await pasteDrawnScreenshot(prompt, { name: 'Photo.jpg', type: 'image/jpeg', width: 4032, height: 3024, photo: 0.5 })
    await expect(previews.getByAltText('Photo.jpg')).toBeVisible()
    const photo = await savedAttachment(page, 'Photo.jpg')
    expect(photo.mimeType).toBe('image/jpeg')
    expect(photo.dimensions?.sent).toEqual({ width: 2576, height: 1932 })
    expect(await decodedSize(page, photo)).toEqual({ width: 2576, height: 1932 })

    // A capture of flat panels and text alone scales down to a larger PNG, so it goes as the user attached it.
    await pasteDrawnScreenshot(prompt, { name: 'Flat capture.png', type: 'image/png', width: 3840, height: 2160, photo: 0 })
    await expect(previews.getByAltText('Flat capture.png')).toBeVisible()
    const flat = await savedAttachment(page, 'Flat capture.png')
    expect(flat.dimensions).toEqual({ original: { width: 3840, height: 2160 }, sent: { width: 3840, height: 2160 } })
    expect(await decodedSize(page, flat)).toEqual({ width: 3840, height: 2160 })

    // Exactly the two scaled-down images carry the note.
    await expect(previews.getByText(/^Resized from \d+\sx\s/u)).toHaveCount(2)

    await page.emulateMedia({ reducedMotion: 'reduce' })
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await launched.app.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(size.width, size.height)
      }, { width, height })
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        await expect(page.getByRole('button', { name: 'Send prompt', exact: true })).toBeInViewport()
        const note = previews.getByText(/^Resized from \d+\sx\s/u).first()
        await note.scrollIntoViewIfNeeded()
        await expect(note).toBeInViewport()
        // The note sits inside its chip: no wider than the chip and not clipped by it.
        const [chip, label] = await Promise.all([previews.locator('figure').first().boundingBox(), note.boundingBox()])
        expect(label!.x).toBeGreaterThanOrEqual(chip!.x)
        expect(label!.x + label!.width).toBeLessThanOrEqual(chip!.x + chip!.width)
        expect(label!.y + label!.height).toBeLessThanOrEqual(chip!.y + chip!.height)
        await page.screenshot({ path: `${RUN}/composer-${width}-${appearance}.png`, animations: 'disabled' })
        await previews.screenshot({ path: `${RUN}/chips-${width}-${appearance}.png`, animations: 'disabled' })
      }
    }
  } finally { await closeSotto(launched) }
})
