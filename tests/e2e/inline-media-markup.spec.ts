/**
 * Marking a picture up in the built app (ADR-0170, part 5): a Codex thread over the fake app server writes a screenshot,
 * which shows nothing of its own (request-only), then shows it through `sotto_media`'s show_in_thread, as an agent does
 * when the user asks to see it. The viewer's Mark up opens the editor. An arrow, a box and a note drawn with the pointer
 * go onto a copy at the picture's full size, Add to reply puts that copy in the reply box as an attachment, and the
 * picture in the thread stays as it was. The time from Add to reply to the copy in the box prints every run. Dark and
 * light, and the 820x560 minimum. The captures go to `artifacts/inline-media/` when SOTTO_E2E_ARTIFACTS=1.
 *
 *   npm run build && npx playwright test tests/e2e/inline-media-markup.spec.ts
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { resizeWindow } from './support/sottoLaunch'
import { captureInlineMedia as capture, withShownPictureThread } from './support/shownPictureThread'

/** Drags across the picture from one share of its width and height to another. */
async function drag(page: Page, surface: Locator, from: readonly [number, number], to: readonly [number, number]): Promise<void> {
  const box = (await surface.boundingBox())!
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1])
  await page.mouse.down()
  for (let step = 1; step <= 8; step++) await page.mouse.move(box.x + box.width * (from[0] + (to[0] - from[0]) * step / 8), box.y + box.height * (from[1] + (to[1] - from[1]) * step / 8))
  await page.mouse.up()
}

test('a picture marked up goes into the reply as a copy, and the picture in the thread stays as it was', async () => {
  test.setTimeout(240_000)
  await withShownPictureThread('sotto-e2e-inline-markup-', async ({ launched, page, pane, threadId: sottoThreadId }) => {
    // Request-only: the screenshot the turn wrote shows nothing until the agent shows it.
    await expect(pane.locator('.thread-media')).toHaveCount(0)
    const shown = await page.evaluate(async request => window.sottoE2E!.mediaTool!(request),
      { threadId: sottoThreadId, arguments: { paths: ['test-results/checkout.png'], title: 'The checkout page' } })
    expect(shown.isError).toBeFalsy()
    const tile = pane.getByRole('button', { name: 'Open picture 1 of 1, from The checkout page' })
    await expect(tile.locator('img')).toHaveJSProperty('complete', true, { timeout: 30_000 })
    await tile.click()
    const viewer = pane.getByRole('dialog')
    await expect(viewer.locator('img.rich-diagram-viewer__image')).toHaveJSProperty('complete', true, { timeout: 30_000 })
    await viewer.getByRole('button', { name: 'Mark up' }).click()

    // The editor opens on the arrow, over the pane.
    const surface = viewer.getByRole('application', { name: 'Picture to mark up: Picture 1' })
    await expect(surface).toBeVisible()
    await expect(viewer.getByRole('button', { name: 'Arrow' })).toBeFocused()
    await drag(page, surface, [0.62, 0.2], [0.45, 0.42])
    await viewer.getByRole('button', { name: 'Box' }).click()
    await drag(page, surface, [0.2, 0.45], [0.5, 0.62])
    await page.keyboard.press('t')
    const box = (await surface.boundingBox())!
    await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.15)
    await viewer.getByRole('textbox', { name: 'Note' }).fill('This total is wrong')
    await page.keyboard.press('Enter')
    await expect(viewer.locator('.markup-editor__mark-name')).toHaveText(['Arrow', 'Box', 'Note: This total is wrong'])
    await capture(page, 'markup-1280-dark')

    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'light' }) })
    await capture(page, 'markup-1280-light')
    await resizeWindow(launched, 820, 560)
    await expect(surface).toBeVisible()
    expect(await viewer.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await capture(page, 'markup-820-light')
    await resizeWindow(launched, 1280, 800)

    // The copy is drawn at the picture's own size, with the red ink, the theme's error colour, where the box was drawn.
    await page.evaluate(() => {
      const probe = document.createElement('span')
      document.querySelector('.markup-editor')!.appendChild(probe)
      probe.style.color = 'var(--tt-ink-red)'
      const swatch = document.createElement('canvas').getContext('2d')!
      swatch.fillStyle = getComputedStyle(probe).color
      swatch.fillRect(0, 0, 1, 1)
      const ink = [...swatch.getImageData(0, 0, 1, 1).data].slice(0, 3)
      probe.remove()
      const original = HTMLCanvasElement.prototype.toBlob
      HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, ...args: Parameters<HTMLCanvasElement['toBlob']>) {
        // A strip across the box's top edge, wide enough for where a pointer lands on a picture shown smaller than it is.
        const strip = this.getContext('2d')!.getImageData(Math.round(this.width * 0.35), Math.round(this.height * 0.45) - 15, 1, 31).data
        let nearest = Infinity
        for (let index = 0; index < strip.length; index += 4) nearest = Math.min(nearest, Math.hypot(strip[index]! - ink[0]!, strip[index + 1]! - ink[1]!, strip[index + 2]! - ink[2]!))
        const colours: number[][] = []
        for (let index = 0; index < strip.length; index += 4 * 5) colours.push([strip[index]!, strip[index + 1]!, strip[index + 2]!])
        ;(window as unknown as { markedCopy: unknown }).markedCopy = { width: this.width, height: this.height, ink, nearest, colours }
        return original.apply(this, args)
      }
    })
    const started = Date.now()
    await viewer.getByRole('button', { name: 'Add to reply' }).click()
    const chip = pane.getByRole('img', { name: 'Picture 1 marked up.png' })
    await expect(chip).toBeVisible({ timeout: 30_000 })
    const addMs = Date.now() - started
    await expect(pane.getByRole('dialog')).toHaveCount(0)
    const copy = await page.evaluate(() => (window as unknown as { markedCopy: { width: number; height: number; ink: number[]; nearest: number } }).markedCopy)
    expect([copy.width, copy.height]).toEqual([1920, 1203])
    expect(copy.nearest, JSON.stringify(copy)).toBeLessThan(12)
    console.info(`markup copy: ${JSON.stringify({ width: copy.width, height: copy.height, addToReplyMs: addMs })}`)
    // The reply box has the focus, and the picture in the thread is the same tile it was.
    await expect(pane.locator('.screenshot-input [contenteditable="true"], .screenshot-input textarea').first()).toBeFocused()
    await expect(tile).toBeVisible()
    await capture(page, 'markup-added-1280-light')
  })
})
