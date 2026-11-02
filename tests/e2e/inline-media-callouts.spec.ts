/**
 * Callouts in the built app (ADR-0170, part 6): a Codex thread over the fake app server writes a screenshot, and the
 * agent shows it through `sotto_media`'s show_in_thread with two callouts on it, as when the user asked to see what is
 * wrong with the page. The tile draws their boxes, pins and count; the viewer draws them over the picture and lists their
 * notes beside it; the mark-up editor lists them with Show and Keep the callouts in the copy, and Add to reply puts a copy
 * with them drawn on it into the reply box. Dark and light, and the 820x560 minimum. The captures are run evidence (docs/ci.md), published to `artifacts/inline-media/` with SOTTO_E2E_EVIDENCE=publish.
 *
 *   npm run build && npx playwright test tests/e2e/inline-media-callouts.spec.ts
 */
import { expect, test } from '@playwright/test'
import { resizeWindow } from './support/sottoLaunch'
import { captureInlineMedia as capture, withShownPictureThread } from './support/shownPictureThread'

const NOTES = ['The zoom controls sit too close to Copy image.', 'The strip under the picture has no label.']

test('an agent\'s callouts show on the tile, in the viewer and the editor, and go into a marked copy', async () => {
  test.setTimeout(240_000)
  await withShownPictureThread('sotto-e2e-inline-callouts-', async ({ launched, page, pane, threadId }) => {
    // The picture is 1920 by 1203: one box near its top right, one across its lower part.
    const shown = await page.evaluate(async request => window.sottoE2E!.mediaTool!(request), { threadId, arguments: {
      paths: ['test-results/checkout.png'], title: 'The checkout page',
      callouts: [
        { path: 'test-results/checkout.png', x: 1380, y: 20, width: 480, height: 90, note: NOTES[0] },
        { path: 'test-results/checkout.png', x: 200, y: 1000, width: 1500, height: 160, note: NOTES[1] },
      ],
    } })
    expect(shown.isError).toBeFalsy()
    expect(JSON.stringify(shown)).toContain('with 2 callouts')

    const tile = pane.getByRole('button', { name: 'Open picture 1 of 1, from The checkout page, with 2 callouts' })
    await expect(tile.locator('img')).toHaveJSProperty('complete', true, { timeout: 30_000 })
    await expect(tile.locator('[data-callout]')).toHaveCount(2)
    await expect(tile.locator('.thread-media__callout-count')).toHaveText('2')
    await capture(page, 'callouts-tile-1280-dark')

    await tile.click()
    const viewer = pane.getByRole('dialog')
    await expect(viewer.locator('img.rich-diagram-viewer__image')).toHaveJSProperty('complete', true, { timeout: 30_000 })
    const list = viewer.getByRole('complementary', { name: 'Callouts from Codex' })
    await expect(list.locator('.callout-notes__note')).toHaveText(NOTES)
    await expect(viewer.locator('.attachment-viewer__callout-layer [data-callout]')).toHaveCount(2)
    // The layer lies over the picture exactly, so each box lands where the agent put it.
    const boxes = () => Promise.all([viewer.locator('img.rich-diagram-viewer__image').boundingBox(), viewer.locator('.attachment-viewer__callout-layer').boundingBox()])
    // Both grow into place together as the picture settles at its size, and match all the way.
    await expect.poll(async () => { const [picture, layer] = await boxes(); return picture !== null && JSON.stringify(layer) === JSON.stringify(picture) }).toBe(true)
    await capture(page, 'callouts-viewer-1280-dark')
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'light' }) })
    await capture(page, 'callouts-viewer-1280-light')
    await resizeWindow(launched, 820, 560)
    await expect(list).toBeVisible()
    expect(await viewer.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await capture(page, 'callouts-viewer-820-light')
    await resizeWindow(launched, 1280, 800)

    await viewer.getByRole('button', { name: 'Mark up' }).click()
    const side = viewer.getByRole('complementary', { name: 'Callouts and your marks' })
    await expect(side.locator('.callout-notes__note')).toHaveText(NOTES)
    await expect(side.getByRole('checkbox', { name: 'Show' })).toBeChecked()
    await expect(side.getByRole('checkbox', { name: 'Keep the callouts in the copy' })).toBeChecked()
    await expect(viewer.locator('.markup-editor__surface [data-callout]')).toHaveCount(2)
    await capture(page, 'callouts-markup-1280-light')

    // With the callouts kept, the copy goes in without a mark of the user's own, drawn with the theme's accent on the
    // second box's top edge.
    await page.evaluate(() => {
      const probe = document.createElement('span')
      document.querySelector('.markup-editor')!.appendChild(probe)
      probe.style.color = 'var(--tt-accent)'
      const swatch = document.createElement('canvas').getContext('2d')!
      swatch.fillStyle = getComputedStyle(probe).color
      swatch.fillRect(0, 0, 1, 1)
      const accent = [...swatch.getImageData(0, 0, 1, 1).data].slice(0, 3)
      probe.remove()
      const original = HTMLCanvasElement.prototype.toBlob
      HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, ...args: Parameters<HTMLCanvasElement['toBlob']>) {
        // Along the box's top edge, which is dashed, so the nearest of a run of pixels.
        const edge = this.getContext('2d')!.getImageData(400, 1000 - 2, 120, 5).data
        let nearest = Infinity
        for (let index = 0; index < edge.length; index += 4) nearest = Math.min(nearest, Math.hypot(edge[index]! - accent[0]!, edge[index + 1]! - accent[1]!, edge[index + 2]! - accent[2]!))
        ;(window as unknown as { markedCopy: unknown }).markedCopy = { width: this.width, height: this.height, accent, nearest }
        return original.apply(this, args)
      }
    })
    const started = Date.now()
    await viewer.getByRole('button', { name: 'Add to reply' }).click()
    await expect(pane.getByRole('img', { name: 'Picture 1 marked up.png' })).toBeVisible({ timeout: 30_000 })
    const addMs = Date.now() - started
    const copy = await page.evaluate(() => (window as unknown as { markedCopy: { width: number; height: number; nearest: number } }).markedCopy)
    expect([copy.width, copy.height]).toEqual([1920, 1203])
    expect(copy.nearest, JSON.stringify(copy)).toBeLessThan(12)
    console.info(`callouts copy: ${JSON.stringify({ width: copy.width, height: copy.height, addToReplyMs: addMs })}`)
    // The tile in the thread is as it was, callouts and all.
    await expect(tile.locator('[data-callout]')).toHaveCount(2)
  })
})
