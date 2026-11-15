import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { FAKE_MESHY_KEY, startFakeMeshy } from '../fixtures/fakeMeshy'
import { stillPng, texturedCubeGlb } from '../fixtures/glb'
import { withShownPictureThread } from './support/shownPictureThread'
import { openPage, openThreads, resizeWindow } from './support/sottoLaunch'

/**
 * A 3D model Meshy makes for a thread, drawn in that thread (ADR-0141; the Meshy plan's ticket 4, Zach's variant A), on
 * Owl, against a made-up Meshy on this computer that answers the API and serves the files from one address. The thread
 * asks with make_3d_model; the user answers its card; the line says each step with Meshy's percent and the time left,
 * offers the shape while the texture is painted, and once done stays closed until Show the model opens a view that
 * turns. A second 3D model whose texture fails says what happened. Nothing reaches Meshy, and the key is made up.
 * Captures go to artifacts/meshy-3d-models for the verification note.
 */
const evidence = evidenceDirectory('artifacts/meshy-3d-models')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const BARREL = { name: 'Oak barrel', words: 'An oak barrel with iron hoops and moss on the lid' }
const LANTERN = { name: 'Brass lantern', words: 'A brass storm lantern with a glass chimney' }

type Called = { content: { type: string; text?: string }[]; isError?: boolean | undefined }
interface Held { __made?: Record<string, Promise<Called>> }

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(1, 1)
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  await page.screenshot({ path: join(evidence, `${name}.png`), caret: 'hide' })
}
/** Asks for a 3D model as the thread's agent would, and leaves the call waiting, as it does until the model is made. */
async function make(page: Page, threadId: string, model: { readonly name: string; readonly words: string }): Promise<void> {
  await page.evaluate(({ request, key }) => {
    const held = window as unknown as Held
    held.__made = { ...held.__made, [key]: window.sottoE2E!.pluginTool!(request) }
  }, { request: { threadId, name: 'make_3d_model', arguments: model }, key: model.name })
}
async function answered(page: Page, name: string): Promise<{ text: string; isError: boolean }> {
  const result = await page.evaluate(key => (window as unknown as Held).__made![key]!, name)
  return { text: result.content.map(part => part.text ?? '').join('\n'), isError: result.isError === true }
}
/** Answers the 3D model's card with Make the model. */
async function allow(pane: Locator): Promise<void> {
  const card = pane.locator('section.agent-request[data-kind="permission"]')
  await expect(card).toHaveCount(1, { timeout: 30_000 })
  await card.getByRole('button', { name: 'Make the model', exact: true }).click()
  await expect(card).toHaveCount(0)
}
/** Anything in the line wider than the thread's pane, or the line itself past it. */
async function overflow(line: Locator, pane: Locator): Promise<string[]> {
  return line.evaluate((element, paneElement) => {
    const room = paneElement!.getBoundingClientRect()
    const problems: string[] = []
    for (const part of [element, ...element.querySelectorAll<HTMLElement>('*')]) {
      const box = part.getBoundingClientRect()
      if (box.width > 0 && (box.right > room.right + 1 || box.left < room.left - 1)) problems.push(`${part.tagName.toLowerCase()}.${part.getAttribute('class') ?? ''} ${Math.round(box.left)}-${Math.round(box.right)} outside ${Math.round(room.left)}-${Math.round(room.right)}`)
      if (part.scrollWidth > part.clientWidth + 1 && getComputedStyle(part).overflowX !== 'visible' && !part.matches('.model-line__name')) problems.push(`${part.tagName.toLowerCase()}.${part.getAttribute('class') ?? ''} scrolls ${part.scrollWidth} > ${part.clientWidth}`)
    }
    return problems.slice(0, 8)
  }, await pane.elementHandle())
}
/** The view's drawing as it is now, as a picture's bytes, to tell whether it moved. */
async function drawing(stage: Locator): Promise<Buffer> { return stage.locator('canvas').screenshot() }

test('A 3D model Meshy makes for a thread is a quiet line in it that opens into a view that turns', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance')
  test.setTimeout(420_000)
  await mkdir(evidence, { recursive: true })
  const meshy = await startFakeMeshy()
  // Meshy is read every second, and its tasks stay in progress until this journey lets each step go.
  meshy.behaviour.retryAfter = '1'
  meshy.behaviour.readsToFinish = 2
  meshy.behaviour.progress = reads => Math.min(92, reads * 9)
  meshy.behaviour.files.set('model.glb', texturedCubeGlb())
  meshy.behaviour.files.set('preview.png', stillPng())
  const previous = process.env.SOTTO_E2E_MESHY_API_URL
  process.env.SOTTO_E2E_MESHY_API_URL = meshy.base
  try {
    await withShownPictureThread('sotto-e2e-meshy-model-', async ({ launched, page, pane, threadId }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'system', appearance: 'dark' }) })

      // A Meshy account named Studio, checked with the made-up key's free balance read.
      await openPage(page, 'Settings')
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Plugins', exact: true }).click()
      const panel = page.getByRole('tabpanel', { name: 'Plugins', exact: true })
      await panel.getByRole('button', { name: /^Meshy/u }).click()
      await panel.getByRole('button', { name: 'Add a Meshy account' }).click()
      const form = panel.getByRole('form', { name: 'Add a Meshy account' })
      await form.getByLabel('Name').fill('Studio')
      await form.getByLabel('API key').fill(FAKE_MESHY_KEY)
      await form.getByRole('button', { name: 'Add account' }).click()
      await expect(panel.getByRole('region', { name: 'Meshy account Studio' })).toContainText('API key saved')

      // The thread asks for a 3D model from words, and the user makes it.
      await openThreads(page)
      await resizeWindow(launched, 1280, 800)
      meshy.behaviour.holding.add('preview')
      await make(page, threadId, BARREL)
      await allow(pane)
      const line = pane.getByRole('group', { name: '3D model: Oak barrel' })
      await expect(line).toBeVisible({ timeout: 30_000 })

      // The shape: the step, Meshy's percent and the time left at the rate so far, with a bar, and nothing to open yet.
      await expect(line).toContainText(/Step 1 of 2: making the shape · \d+%, about (?:\d+ seconds|a minute) left/u, { timeout: 30_000 })
      await expect(line.getByRole('progressbar', { name: 'Step 1 of 2: making the shape' })).toBeVisible()
      await expect(line.getByRole('button')).toHaveCount(0)
      await line.scrollIntoViewIfNeeded()
      await shot(page, 'line-shape-dark-1280x800')

      // The texture: the shape Meshy made can be turned meanwhile.
      meshy.behaviour.holding.add('refine')
      meshy.behaviour.holding.delete('preview')
      await expect(line).toContainText(/Step 2 of 2: painting the texture · \d+%, about (?:\d+ seconds|a minute) left/u, { timeout: 30_000 })
      const showShape = line.getByRole('button', { name: 'Show the shape' })
      await expect(showShape).toBeVisible()
      await shot(page, 'line-texture-dark-1280x800')
      await showShape.click()
      const stage = line.getByRole('slider', { name: 'Turn the Oak barrel. Drag, or use the arrow keys; Home faces it to the front.' })
      await expect(stage).toBeFocused()
      await expect(line.getByText('Drag or use the arrow keys to turn')).toBeVisible({ timeout: 30_000 })
      await expect(line).toContainText('The shape is ready to turn. The texture follows, then the files go to models/.')
      await line.scrollIntoViewIfNeeded()
      await shot(page, 'shape-open-dark-1280x800')
      await page.keyboard.press('Escape')
      await expect(stage).toHaveCount(0)
      await expect(line.getByRole('button', { name: 'Show the shape' })).toBeFocused()

      // Done: the closed line, until it is pressed.
      meshy.behaviour.holding.delete('refine')
      await expect(line).toContainText('3D model · 30 credits · 3 files', { timeout: 60_000 })
      const made = await answered(page, BARREL.name)
      expect(made.isError).toBe(false)
      expect(made.text).toContain('The 3D model "Oak barrel" is made, for 30 credits.')
      const toggle = line.getByRole('button', { name: /^(?:Show|Hide) the model$/u })
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(line.getByRole('slider')).toHaveCount(0)
      await line.scrollIntoViewIfNeeded()
      await shot(page, 'line-done-dark-1280x800')

      // Show the model: the view draws, takes focus and turns by itself; the facts and a chip for each file.
      await toggle.click()
      const view = line.getByRole('slider', { name: 'Turn the Oak barrel. Drag, or use the arrow keys; Home faces it to the front.' })
      await expect(view).toBeFocused()
      await expect(line.getByText('Drag or use the arrow keys to turn')).toBeVisible({ timeout: 30_000 })
      await expect(line.getByText('Sotto could not draw this 3D model.')).toHaveCount(0)
      await expect(line).toContainText('Made from words · 30 credits')
      await expect(line.getByRole('list', { name: 'Files' }).getByRole('listitem')).toHaveText([/^\.png\d+ KB$/u, /^\.glb\d+ KB$/u, /^\.usdz\d+ KB$/u])
      const turning = await drawing(view)
      await page.waitForTimeout(800)
      expect(Buffer.compare(turning, await drawing(view)), 'the model turns by itself').not.toBe(0)

      // The keyboard: Home faces the front and stops it turning by itself, an arrow key turns it 15 degrees from there,
      // and Escape closes it.
      await page.keyboard.press('Home')
      await expect(view).toHaveAttribute('aria-valuenow', '0')
      await expect(view).toHaveAttribute('aria-valuetext', 'Facing the front')
      const facing = await drawing(view)
      await page.keyboard.press('ArrowRight')
      await expect(view).toHaveAttribute('aria-valuenow', '15')
      await expect(view).toHaveAttribute('aria-valuetext', 'Turned 15 degrees from the front')
      const turned = await drawing(view)
      await page.waitForTimeout(500)
      expect(Buffer.compare(turned, await drawing(view)), 'a turned model holds still').toBe(0)
      await page.keyboard.press('ArrowRight')
      await expect(view).toHaveAttribute('aria-valuenow', '30')
      await page.keyboard.press('Home')
      await expect(view).toHaveAttribute('aria-valuenow', '0')
      await expect(view).toHaveAttribute('aria-valuetext', 'Facing the front')
      expect(Buffer.compare(await drawing(view), facing), 'Home turns it back to the same front').toBe(0)
      expect(Buffer.compare(facing, turned), 'an arrow key turns it').not.toBe(0)
      await page.keyboard.press('Escape')
      await expect(view).toHaveCount(0)
      await expect(toggle).toBeFocused()
      await expect(toggle).toHaveAccessibleName('Show the model')

      // Open at every size, dark and light: nothing past the pane.
      await toggle.click()
      await expect(line.getByText('Drag or use the arrow keys to turn')).toBeVisible({ timeout: 30_000 })
      await page.keyboard.press('Home')
      for (const mode of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, mode)
        for (const [width, height] of SIZES) {
          await resizeWindow(launched, width, height)
          await line.scrollIntoViewIfNeeded()
          expect(await overflow(line, pane), `open line ${width}x${height} ${mode}`).toEqual([])
          await shot(page, `model-open-${mode}-${width}x${height}`)
        }
      }

      // Reduced motion: it does not turn by itself.
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark', reducedMotion: 'on' }) })
      await resizeWindow(launched, 1280, 800)
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await toggle.click()
      const still = line.getByRole('slider')
      await expect(line.getByText('Drag or use the arrow keys to turn')).toBeVisible({ timeout: 30_000 })
      await expect(line.getByRole('button', { name: 'Stop turning' })).toHaveCount(0)
      const first = await drawing(still)
      await page.waitForTimeout(800)
      expect(Buffer.compare(first, await drawing(still)), 'with motion reduced it holds still').toBe(0)
      await line.scrollIntoViewIfNeeded()
      await shot(page, 'model-open-reduced-motion-dark-1280x800')
      await page.keyboard.press('Escape')
      await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'system' }) })

      // A second 3D model whose texture fails: the line says what happened, that nothing was saved and what was counted.
      meshy.behaviour.failing.add('refine')
      await make(page, threadId, LANTERN)
      await allow(pane)
      const failed = pane.getByRole('group', { name: '3D model: Brass lantern' })
      await expect(failed).toContainText('Could not finish · nothing saved · 20 credits counted', { timeout: 60_000 })
      const failedAnswer = await answered(page, LANTERN.name)
      expect(failedAnswer.isError).toBe(true)
      const what = failed.getByRole('button', { name: 'Show what happened' })
      await what.click()
      await expect(failed).toContainText('The Brass lantern was not made.')
      await expect(failed).toContainText('Meshy could not finish it, and gave back the credits of what it could not make. Sotto saved no files. 20 credits were counted against this month’s limit.')
      await expect(failed.getByRole('button', { name: /try again/iu })).toHaveCount(0)
      for (const [mode, width, height] of [['dark', 1280, 800], ['light', 1280, 800], ['dark', 820, 560]] as const) {
        await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, mode)
        await resizeWindow(launched, width, height)
        await failed.scrollIntoViewIfNeeded()
        expect(await overflow(failed, pane), `failed line ${width}x${height} ${mode}`).toEqual([])
        await shot(page, `line-failed-${mode}-${width}x${height}`)
      }
      await page.keyboard.press('Escape')
      await expect(what).toBeFocused()
      await expect(what).toHaveAttribute('aria-expanded', 'false')

      // Only Meshy's made-up API and files were reached, and the window saw no error.
      expect(meshy.requests.every(request => request.path.startsWith('/openapi/') || request.path.startsWith('/files/'))).toBe(true)
      expect(errors).toEqual([])
    }, { owlFeatures: 'plugins=1' })
  } finally {
    if (previous === undefined) delete process.env.SOTTO_E2E_MESHY_API_URL
    else process.env.SOTTO_E2E_MESHY_API_URL = previous
    await meshy.close()
  }
})
