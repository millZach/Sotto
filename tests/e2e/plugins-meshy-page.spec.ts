import { mkdir, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { FAKE_MESHY_KEY, startFakeMeshy } from '../fixtures/fakeMeshy'
import { stillPng, texturedCubeGlb } from '../fixtures/glb'
import { withShownPictureThread } from './support/shownPictureThread'
import { openPage, openThreads, resizeWindow } from './support/sottoLaunch'

/**
 * The 3D models page and Tools › 3D models (ADR-0141; the Meshy plan's ticket 5, Zach's variant C), on Owl, against the
 * made-up Meshy ticket 4's journey uses. A thread makes two 3D models; while the second is being made, Tools › 3D models
 * lights its rail item and lists both, and the page shows its step in its tile. Once both are done the page turns the
 * chosen one, moves along the filmstrip from the keyboard, shows a file in the folder app, and goes to the thread. With
 * one's files deleted, it says so and Remove from 3D models takes the record and no file. Nothing reaches Meshy, and the
 * key is made up. Captures go to artifacts/meshy-3d-models for the verification note.
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
async function make(page: Page, threadId: string, model: { readonly name: string; readonly words: string }): Promise<void> {
  await page.evaluate(({ request, key }) => {
    const held = window as unknown as Held
    held.__made = { ...held.__made, [key]: window.sottoE2E!.pluginTool!(request) }
  }, { request: { threadId, name: 'make_3d_model', arguments: model }, key: model.name })
}
async function allow(pane: Locator): Promise<void> {
  const card = pane.locator('section.agent-request[data-kind="permission"]')
  await expect(card).toHaveCount(1, { timeout: 30_000 })
  await card.getByRole('button', { name: 'Make the model', exact: true }).click()
  await expect(card).toHaveCount(0)
}
/** Anything on the page wider than the window, or a part that scrolls sideways that should not. */
async function overflow(page: Page, room: Locator): Promise<string[]> {
  return room.evaluate(element => {
    const width = document.documentElement.clientWidth
    const problems: string[] = []
    for (const part of [element, ...element.querySelectorAll<HTMLElement>('*')]) {
      const box = part.getBoundingClientRect()
      // The strip scrolls sideways on purpose, and a visually hidden name is clipped on purpose.
      const inStrip = (part.closest('.models-strip') !== null && part !== element.querySelector('.models-strip')) || part.matches('.tt-visually-hidden')
      if (box.width > 0 && !inStrip && (box.right > width + 1 || box.left < -1)) problems.push(`${part.tagName.toLowerCase()}.${part.getAttribute('class') ?? ''} ${Math.round(box.left)}-${Math.round(box.right)} outside 0-${width}`)
      if (part.scrollWidth > part.clientWidth + 1 && !inStrip && !part.matches('.models-strip, .models-files__name, .models-tile__name, .models-tile__sub, .models-tool__text b, .models-tool__text span') && getComputedStyle(part).overflowX !== 'visible') problems.push(`${part.tagName.toLowerCase()}.${part.getAttribute('class') ?? ''} scrolls ${part.scrollWidth} > ${part.clientWidth}`)
    }
    return problems.slice(0, 8)
  })
}
const shownFiles = (page: Page): Promise<string[]> => page.evaluate(async () => (await window.sottoE2E!.snapshot()).shownFiles ?? [])

test('The 3D models page and Tools › 3D models show what a thread made, and say when its files are gone', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance')
  test.setTimeout(480_000)
  await mkdir(evidence, { recursive: true })
  const meshy = await startFakeMeshy()
  meshy.behaviour.retryAfter = '1'
  meshy.behaviour.readsToFinish = 2
  meshy.behaviour.progress = reads => Math.min(92, reads * 9)
  meshy.behaviour.files.set('model.glb', texturedCubeGlb())
  meshy.behaviour.files.set('preview.png', stillPng())
  const previous = process.env.SOTTO_E2E_MESHY_API_URL
  process.env.SOTTO_E2E_MESHY_API_URL = meshy.base
  try {
    await withShownPictureThread('sotto-e2e-meshy-page-', async ({ launched, page, pane, threadId, project }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'system', appearance: 'dark' }) })

      // A Meshy account named Studio, checked with the made-up key's free balance read.
      await openPage(page, 'Settings')
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Plugins', exact: true }).click()
      const settings = page.getByRole('tabpanel', { name: 'Plugins', exact: true })
      await settings.getByRole('button', { name: /^Meshy/u }).click()
      await settings.getByRole('button', { name: 'Add a Meshy account' }).click()
      const form = settings.getByRole('form', { name: 'Add a Meshy account' })
      await form.getByLabel('Name').fill('Studio')
      await form.getByLabel('API key').fill(FAKE_MESHY_KEY)
      await form.getByRole('button', { name: 'Add account' }).click()
      await expect(settings.getByRole('region', { name: 'Meshy account Studio' })).toContainText('API key saved')

      // The thread makes an oak barrel, then a brass lantern whose texture Meshy holds.
      await openThreads(page)
      await resizeWindow(launched, 1280, 800)
      await make(page, threadId, BARREL)
      await allow(pane)
      await expect(pane.getByRole('group', { name: '3D model: Oak barrel' })).toContainText('3D model · 30 credits · 3 files', { timeout: 60_000 })
      meshy.behaviour.holding.add('refine')
      await make(page, threadId, LANTERN)
      await allow(pane)
      await expect(pane.getByRole('group', { name: '3D model: Brass lantern' })).toContainText(/Step 2 of 2: painting the texture · \d+%/u, { timeout: 60_000 })

      // Tools, on Files: the 3D models item between iPhone and Terminal carries a dot while one is being made.
      await pane.getByRole('button', { name: 'Tools', exact: true }).click()
      const tools = page.getByRole('complementary', { name: 'Tools', exact: true })
      const rail = tools.getByRole('tablist', { name: 'Tools' })
      await expect(rail.getByRole('tab')).toHaveText(['Browser', 'iPhone', '3D', 'Terminal', 'Files', 'Changes', 'PR', 'Agents'])
      const modelsTab = rail.getByRole('tab', { name: '3D models' })
      await expect(modelsTab).toHaveAttribute('aria-description', 'A 3D model is being made', { timeout: 30_000 })
      await expect(modelsTab.locator('.tools-rail__live')).toHaveCount(1)
      await modelsTab.click()
      await expect(tools).toContainText('Made with the Meshy account Studio · 60 credits in this thread')
      const rows = tools.getByRole('list', { name: 'Made in this thread' }).getByRole('button')
      await expect(rows).toHaveCount(2)
      await expect(rows.nth(0)).toContainText(/Brass lantern.*Step 2 of 2: painting the texture · \d+%/u)
      await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true')
      const card = tools.getByRole('region', { name: 'Oak barrel' })
      await expect(card.getByText('Drag or use the arrow keys to turn')).toBeVisible({ timeout: 30_000 })
      await expect(card.getByRole('list', { name: 'Files' }).getByRole('button')).toHaveCount(3)
      await shot(page, 'tools-making-dark-1280x800')

      // The page, from the cube at the sidebar's foot: the lantern's tile says its step while it is made.
      await page.getByRole('link', { name: '3D models', exact: true }).click()
      const room = page.getByRole('region', { name: '3D models' })
      await expect(room.getByRole('heading', { level: 1, name: '3D models' })).toBeVisible()
      // The lantern's texture is counted from when it was asked for.
      await expect(room).toContainText('2 3D models from 1 thread · 60 credits this month')
      const strip = room.getByRole('listbox', { name: 'Every 3D model' })
      await expect(strip.getByRole('option')).toHaveCount(2)
      const lanternTile = strip.getByRole('option', { name: /^Brass lantern, Step 2 of 2: painting the texture · \d+%$/u })
      await lanternTile.click()
      const lanternDetails = room.getByRole('complementary', { name: 'About the Brass lantern' })
      await expect(lanternDetails.getByRole('progressbar', { name: 'Step 2 of 2: painting the texture' })).toBeVisible()
      await expect(lanternDetails).toContainText('The files go to models/ in the thread’s folder when it is done.')
      await expect(lanternDetails).toContainText('30 credits, counted while it is made')
      await shot(page, 'page-making-dark-1280x800')

      // Done: the lantern's tile takes its date.
      meshy.behaviour.holding.delete('refine')
      await expect(strip.getByRole('option', { name: /^Brass lantern, [A-Z][a-z]{2} \d{1,2}$/u })).toBeVisible({ timeout: 60_000 })
      await expect(room).toContainText('2 3D models from 1 thread · 60 credits this month')
      await expect(room.getByText('Drag or use the arrow keys to turn')).toBeVisible({ timeout: 30_000 })
      await expect(lanternDetails).toContainText('3D model · Meshy · made from words')
      await expect(lanternDetails).toContainText(LANTERN.words)
      await expect(lanternDetails.getByRole('list', { name: 'Files' }).getByRole('listitem')).toHaveCount(3)

      // The filmstrip from the keyboard: Right moves along it and chooses as it goes, Left comes back.
      const chosen = strip.getByRole('option', { selected: true })
      await chosen.focus()
      await page.keyboard.press('ArrowRight')
      await expect(strip.getByRole('option', { name: /^Oak barrel/u })).toHaveAttribute('aria-selected', 'true')
      await expect(strip.getByRole('option', { name: /^Oak barrel/u })).toBeFocused()
      const barrelDetails = room.getByRole('complementary', { name: 'About the Oak barrel' })
      await expect(barrelDetails).toBeVisible()
      await page.keyboard.press('ArrowLeft')
      await expect(strip.getByRole('option', { name: /^Brass lantern/u })).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('ArrowRight')

      // The view turns from the keyboard as in a thread: Home faces the front, an arrow key turns it.
      const view = room.getByRole('slider', { name: 'Turn the Oak barrel. Drag, or use the arrow keys; Home faces it to the front.' })
      await expect(room.getByText('Drag or use the arrow keys to turn')).toBeVisible({ timeout: 30_000 })
      await view.focus()
      await page.keyboard.press('Home')
      await expect(view).toHaveAttribute('aria-valuetext', 'Facing the front')
      await page.keyboard.press('ArrowRight')
      await expect(view).toHaveAttribute('aria-valuenow', '15')
      await page.keyboard.press('Home')

      // Show in File Explorer shows the GLB; a file's own button shows that file. Only the record's own files are shown.
      await barrelDetails.getByRole('button', { name: 'Show in File Explorer', exact: true }).click()
      await barrelDetails.getByRole('button', { name: 'Show in File Explorer: Oak barrel.usdz' }).click()
      // By their real paths, which Windows may spell otherwise than the profile's own.
      await expect.poll(async () => (await shownFiles(page)).map(path => basename(path))).toEqual(['Oak barrel.glb', 'Oak barrel.usdz'])
      expect((await shownFiles(page)).every(path => basename(dirname(path)) === 'models' && basename(dirname(dirname(path))) === basename(project))).toBe(true)

      // Every size, dark and light: nothing past the window.
      for (const mode of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, mode)
        for (const [width, height] of SIZES) {
          await resizeWindow(launched, width, height)
          await expect(room.getByText('Drag or use the arrow keys to turn')).toBeVisible({ timeout: 30_000 })
          expect(await overflow(page, room), `page ${width}x${height} ${mode}`).toEqual([])
          await shot(page, `page-${mode}-${width}x${height}`)
        }
      }
      // Reduced motion: the view holds still and offers no turning.
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark', reducedMotion: 'on' }) })
      await resizeWindow(launched, 1280, 800)
      await strip.getByRole('option', { name: /^Brass lantern/u }).click()
      await strip.getByRole('option', { name: /^Oak barrel/u }).click()
      await expect(room.getByText('Drag or use the arrow keys to turn')).toBeVisible({ timeout: 30_000 })
      await expect(room.getByRole('button', { name: 'Stop turning' })).toHaveCount(0)
      await shot(page, 'page-reduced-motion-dark-1280x800')
      await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'system' }) })

      // Go to thread opens the thread the 3D model came from.
      await barrelDetails.getByRole('button', { name: 'Go to thread' }).click()
      await expect(pane.getByRole('group', { name: '3D model: Oak barrel' })).toBeVisible({ timeout: 30_000 })

      // Tools at every size, dark and light, with both done: the newest, the lantern, is chosen.
      await expect(tools.getByRole('region', { name: 'Brass lantern' }).getByText('Drag or use the arrow keys to turn')).toBeVisible({ timeout: 30_000 })
      for (const mode of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, mode)
        for (const [width, height] of SIZES) {
          await resizeWindow(launched, width, height)
          await expect(tools.getByRole('list', { name: 'Made in this thread' })).toBeVisible()
          expect(await overflow(page, tools.locator('.models-tool')), `tools ${width}x${height} ${mode}`).toEqual([])
          await shot(page, `tools-${mode}-${width}x${height}`)
        }
      }
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
      await resizeWindow(launched, 1280, 800)

      // The barrel's files are deleted outside Sotto: the page says so, and Remove from 3D models takes the record only.
      const folder = join(project, 'models')
      for (const name of await readdir(folder)) if (name.startsWith('Oak barrel.')) await rm(join(folder, name))
      await page.getByRole('link', { name: '3D models', exact: true }).click()
      const goneTile = strip.getByRole('option', { name: /^Oak barrel, [A-Z][a-z]{2} \d{1,2}, Its files are gone$/u })
      await goneTile.click()
      const gone = room.getByRole('group', { name: 'Its files are gone' })
      await expect(gone).toContainText('Its files are gone. The Oak barrel’s files are no longer in models/ in its thread’s folder: they were moved, renamed or deleted.')
      await expect(barrelDetails.getByRole('button', { name: 'Show in File Explorer', exact: true })).toHaveCount(0)
      await shot(page, 'page-files-gone-dark-1280x800')
      for (const [mode, width, height] of [['light', 1280, 800], ['dark', 820, 560]] as const) {
        await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, mode)
        await resizeWindow(launched, width, height)
        expect(await overflow(page, room), `files gone ${width}x${height} ${mode}`).toEqual([])
        await shot(page, `page-files-gone-${mode}-${width}x${height}`)
      }
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
      await resizeWindow(launched, 1280, 800)
      await gone.getByRole('button', { name: 'Remove from 3D models' }).click()
      await expect(strip.getByRole('option')).toHaveCount(1)
      await expect(strip.getByRole('option', { name: /^Brass lantern/u })).toBeFocused()
      await expect(room).toContainText('1 3D model from 1 thread · 60 credits this month')
      expect((await readdir(folder)).filter(name => name.startsWith('Brass lantern.')).sort()).toEqual(['Brass lantern.glb', 'Brass lantern.png', 'Brass lantern.usdz'])

      // With the lantern's files gone and removed too, the page says there are none yet; its credits stay counted.
      for (const name of await readdir(folder)) await rm(join(folder, name))
      await openThreads(page)
      await page.getByRole('link', { name: '3D models', exact: true }).click()
      await room.getByRole('group', { name: 'Its files are gone' }).getByRole('button', { name: 'Remove from 3D models' }).click()
      await expect(room.getByText('No 3D models yet')).toBeVisible()
      await shot(page, 'page-empty-dark-1280x800')

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
