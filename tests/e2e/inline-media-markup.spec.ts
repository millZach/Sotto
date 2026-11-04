/**
 * Marking a picture up in the built app (ADR-0170, part 5): a Codex thread over the fake app server writes a screenshot,
 * which shows nothing of its own (request-only), then shows it through `sotto_media`'s show_in_thread, as an agent does
 * when the user asks to see it. The viewer's Mark up opens the editor. An arrow, a box and a note drawn with the pointer
 * go onto a copy at the picture's full size, Add to reply puts that copy in the reply box as an attachment, and the
 * picture in the thread stays as it was. The time from Add to reply to the copy in the box prints every run. Dark and
 * light, and the 820x560 minimum. The captures are run evidence (docs/ci.md), published to `artifacts/inline-media/` with SOTTO_E2E_EVIDENCE=publish.
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

test('marks move, text sizes and belongs to a shape, and the copy is what the editor showed', async () => {
  test.setTimeout(240_000)
  await withShownPictureThread('sotto-e2e-inline-markup-move-', async ({ launched, page, pane, threadId: sottoThreadId }) => {
    await page.evaluate(async request => window.sottoE2E!.mediaTool!(request),
      { threadId: sottoThreadId, arguments: { paths: ['test-results/checkout.png'], title: 'The checkout page' } })
    const tile = pane.getByRole('button', { name: 'Open picture 1 of 1, from The checkout page' })
    await expect(tile.locator('img')).toHaveJSProperty('complete', true, { timeout: 30_000 })
    await tile.click()
    const viewer = pane.getByRole('dialog')
    await expect(viewer.locator('img.rich-diagram-viewer__image')).toHaveJSProperty('complete', true, { timeout: 30_000 })
    await viewer.getByRole('button', { name: 'Mark up' }).click()
    const surface = viewer.getByRole('application', { name: 'Picture to mark up: Picture 1' })
    await expect(surface).toBeVisible()
    const marks = viewer.locator('.markup-editor__mark-name')
    const press = async (x: number, y: number): Promise<void> => { const box = (await surface.boundingBox())!; await page.mouse.click(box.x + box.width * x, box.y + box.height * y) }

    // A box, and a note written on it, sized up. Its words sit in the ink with no label behind them.
    await page.keyboard.press('b')
    await drag(page, surface, [0.2, 0.2], [0.5, 0.4])
    await page.keyboard.press('t')
    await viewer.getByRole('button', { name: 'Make the text larger' }).click()
    await press(0.25, 0.3)
    await viewer.getByRole('textbox', { name: 'Note' }).fill('This total is wrong')
    await page.keyboard.press('Enter')
    await expect(marks).toHaveText(['Box', 'Note on the box: This total is wrong'])
    // Another note, free, and an arrow drawn straight across the box: a drawing tool only draws.
    await press(0.6, 0.1)
    await viewer.getByRole('textbox', { name: 'Note' }).fill('Free words')
    await page.keyboard.press('Enter')
    await page.keyboard.press('a')
    await drag(page, surface, [0.3, 0.2], [0.65, 0.5])
    await expect(marks).toHaveText(['Box', 'Note on the box: This total is wrong', 'Note: Free words', 'Arrow'])
    await capture(page, 'markup-move-note-1280-dark')
    // At this size the bar's controls all fit on one line.
    const rows = await viewer.locator('.markup-editor__bar button').evaluateAll(buttons => new Set(buttons.filter(button => button.getClientRects().length).map(button => Math.round(button.getBoundingClientRect().top + button.getBoundingClientRect().height / 2))).size)
    expect(rows).toBe(1)

    // Move takes the box and its note together.
    await page.keyboard.press('v')
    await expect(viewer.getByRole('button', { name: 'Move', exact: true })).toHaveAttribute('aria-pressed', 'true')
    const positions = (): Promise<number[][]> => surface.locator('[data-markup-shape]').evaluateAll(shapes => shapes.map(shape => [Number(shape.getAttribute('x')), Number(shape.getAttribute('y'))]))
    const before = await positions()
    await drag(page, surface, [0.2, 0.3], [0.1, 0.6])
    const after = await positions()
    expect(after[0]![1]! - before[0]![1]!).toBeGreaterThan(100)
    expect(after[1]![1]! - before[1]![1]!).toBeCloseTo(after[0]![1]! - before[0]![1]!, 3)
    expect(after[2]).toEqual(before[2])
    await capture(page, 'markup-move-selected-1280-dark')
    await viewer.getByRole('button', { name: 'Undo' }).click()
    expect(await positions()).toEqual(before)
    await viewer.getByRole('button', { name: 'Redo' }).click()
    expect(await positions()).toEqual(after)

    // A handle resizes it. Dragged off, the note is free.
    const corner = await surface.locator('.markup-editor__handle').evaluateAll(handles => handles.map(handle => [Number(handle.getAttribute('cx')), Number(handle.getAttribute('cy'))]))
    await drag(page, surface, [corner[3]![0]! / 1920, corner[3]![1]! / 1203], [(corner[3]![0]! + 200) / 1920, (corner[3]![1]! + 100) / 1203])
    const resized = await positions()
    expect(resized[0]![0]).toBeCloseTo(after[0]![0]!, 3)
    const text = surface.locator('text').first()
    const words = (await text.boundingBox())!, box = (await surface.boundingBox())!
    await drag(page, surface, [(words.x + words.width / 2 - box.x) / box.width, (words.y + words.height / 2 - box.y) / box.height], [0.72, 0.85])
    await expect(marks.nth(1)).toHaveText('Note: This total is wrong')
    await expect(viewer.getByRole('status')).toHaveText('The note is free now. It stays where you put it.')

    // Nothing of the editor's outline is on the copy. Hold the copy against the editor, with the same picture under both.
    await page.keyboard.press('Escape')
    await expect(surface.locator('.markup-editor__selected')).toHaveCount(0)
    await expect(viewer.locator('.markup-editor__cross')).toHaveCount(0)
    await page.mouse.move(0, 0)
    const shot = (await surface.screenshot()).toString('base64')
    await capture(page, 'markup-move-free-1280-dark')
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'light' }) })
    await capture(page, 'markup-move-free-1280-light')
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
    await resizeWindow(launched, 820, 560)
    await expect(surface).toBeVisible()
    expect(await viewer.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await capture(page, 'markup-move-820-dark')
    await resizeWindow(launched, 1280, 800)
    await page.evaluate(() => {
      const original = HTMLCanvasElement.prototype.toBlob
      HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, ...args: Parameters<HTMLCanvasElement['toBlob']>) {
        ;(window as unknown as { markedPng: string }).markedPng = this.toDataURL('image/png')
        return original.apply(this, args)
      }
    })
    const place = await surface.locator('text').first().evaluate(element => { const b = (element as SVGGraphicsElement).getBBox(); return { x: b.x, y: b.y, width: b.width, height: b.height, ink: getComputedStyle(element).fill } })
    await viewer.getByRole('button', { name: 'Add to reply' }).click()
    await expect(pane.getByRole('img', { name: 'Picture 1 marked up.png' })).toBeVisible({ timeout: 30_000 })
    const compared = await page.evaluate(async ({ shot, place }) => {
      const load = async (source: string): Promise<HTMLImageElement> => { const image = new Image(); image.src = source; await image.decode(); return image }
      const screen = await load(`data:image/png;base64,${shot}`), copy = await load((window as unknown as { markedPng: string }).markedPng)
      const draw = (image: HTMLImageElement): Uint8ClampedArray => {
        const canvas = document.createElement('canvas')
        canvas.width = screen.naturalWidth; canvas.height = screen.naturalHeight
        const context = canvas.getContext('2d')!
        context.imageSmoothingQuality = 'high'
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        return context.getImageData(0, 0, canvas.width, canvas.height).data
      }
      const a = draw(screen), b = draw(copy)
      const swatch = document.createElement('canvas').getContext('2d')!
      swatch.fillStyle = place.ink
      swatch.fillRect(0, 0, 1, 1)
      const ink = swatch.getImageData(0, 0, 1, 1).data
      const inked = (data: Uint8ClampedArray, at: number, within: number): boolean => Math.abs(data[at]! - ink[0]!) + Math.abs(data[at + 1]! - ink[1]!) + Math.abs(data[at + 2]! - ink[2]!) < within
      // Every pixel of ink on one has ink beside it on the other, so each mark is where the editor showed it, the same size.
      const width = screen.naturalWidth, height = screen.naturalHeight
      const matched = (from: Uint8ClampedArray, to: Uint8ClampedArray): number => {
        let total = 0, met = 0
        for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
          if (!inked(from, (y * width + x) * 4, 45)) continue
          total += 1
          let near = false
          for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2 && !near; dx++) near = inked(to, ((y + dy) * width + x + dx) * 4, 150)
          if (near) met += 1
        }
        return total ? met / total : 0
      }
      // Behind the words the copy shows the picture: a label would have filled all of this rectangle with one colour.
      const full = document.createElement('canvas')
      full.width = copy.naturalWidth; full.height = copy.naturalHeight
      const context = full.getContext('2d')!
      context.drawImage(copy, 0, 0)
      const area = context.getImageData(Math.round(place.x), Math.round(place.y), Math.round(place.width), Math.round(place.height)).data
      let covered = 0
      for (let index = 0; index < area.length; index += 4) if (inked(area, index, 60)) covered += 1
      return { width: copy.naturalWidth, height: copy.naturalHeight, screenInkMatched: matched(a, b), copyInkMatched: matched(b, a), inkShare: covered / (area.length / 4) }
    }, { shot, place })
    console.info(`markup move copy: ${JSON.stringify(compared)}`)
    expect([compared.width, compared.height]).toEqual([1920, 1203])
    expect(compared.screenInkMatched).toBeGreaterThan(0.97)
    expect(compared.copyInkMatched).toBeGreaterThan(0.97)
    expect(compared.inkShare).toBeGreaterThan(0.03)
    expect(compared.inkShare).toBeLessThan(0.6)
    await capture(page, 'markup-move-added-1280-dark')
  })
})
