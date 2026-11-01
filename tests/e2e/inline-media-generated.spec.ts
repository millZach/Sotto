/**
 * An image an agent generates, in the built app (ADR-0170): a Codex thread over the fake app server starts an
 * `imageGeneration` item, and its turn shows the owl at the easel in a tile, playing; under reduced motion it holds still.
 * The item then finishes with only the file Codex saved, and the tile becomes the picture, read from that file, which
 * opens in the viewer. Dark and light, and the 820x560 minimum. The captures go to `artifacts/inline-media/` when
 * SOTTO_E2E_ARTIFACTS=1.
 *
 *   npm run build && npx playwright test tests/e2e/inline-media-generated.spec.ts
 */
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { owlEaselFrame, owlEaselGrid } from '../../src/renderer/src/agents/owlEasel'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

const PICTURE = resolve('artifacts/image-viewer/viewer-1280-dark.png')

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) })
  if (process.env.SOTTO_E2E_ARTIFACTS === '1' || process.env.SOTTO_NESTED_LIVE_SIGNATURE) {
    await mkdir(resolve('artifacts/inline-media'), { recursive: true })
    await page.screenshot({ path: resolve('artifacts/inline-media', `${name}.png`) })
  }
}

test('an image Codex generates plays the owl at the easel, then shows as a tile read from the file it saved', async () => {
  test.setTimeout(240_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-inline-generated-' })).directory
  const root = join(profile, 'native-fixture')
  const project = join(root, 'project')
  for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
  // No scripted reply, so the turn stays open while the image is made.
  await writeFile(join(root, 'codex', 'script.json'), JSON.stringify({}))
  const previous = { root: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, executable: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE, owl: process.env.SOTTO_OWL_FEATURES }
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  process.env.SOTTO_OWL_FEATURES = 'inline-media=1'
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    await page.evaluate(async project => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { provider: 'codex', enabled: true, enabledProviders: ['codex'], checkClientUpdates: false } })
      await agents.command({ type: 'connect', provider: 'codex' })
      const created = await agents.command({ type: 'create-project', provider: 'codex', title: 'Lumen shop', path: project, useExisting: true })
      const projectId = created.host.projects.find(item => item.title === 'Lumen shop')!.id
      const modelId = (await agents.get()).host.models.find(model => model.providerId === 'codex' && model.ready)!.id
      const thread = await agents.command({ type: 'create-thread', projectId, title: 'Draw the shop sign', titleSource: 'user', modelId, workingCopy: 'shared' })
      if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'No thread was created.')
      const sent = await agents.command({ type: 'manual-send', threadId: thread.activeThreadId, text: 'Make a sign for the shop: an owl at an easel.' })
      if (sent.error) throw new Error(sent.error)
    }, project)
    const nativeTurn = async () => {
      const state = JSON.parse(await readFile(join(root, 'codex', 'state.json'), 'utf8')) as { threads: Record<string, { id: string; turns: { id: string }[] }> }
      const thread = Object.values(state.threads)[0]
      return thread?.turns.at(-1) ? { threadId: thread.id, turnId: thread.turns.at(-1)!.id } : undefined
    }
    await expect.poll(nativeTurn, { timeout: 60_000 }).toBeTruthy()
    const { threadId, turnId } = (await nativeTurn())!
    // One notification from the thread's Codex process, waited for until the fake says it was carried out.
    const control = async (method: string, item: Record<string, unknown>): Promise<void> => {
      const id = randomUUID()
      await writeFile(join(root, 'codex', 'control.json'), JSON.stringify({ id, threadId, type: 'notify', persist: true, method, params: { turnId, item } }))
      await expect.poll(async () => (await readFile(join(root, 'codex', 'actions.jsonl'), 'utf8').catch(() => '')).includes(id), { timeout: 30_000 }).toBe(true)
    }

    await page.reload()
    await resizeWindow(launched, 1280, 800)
    await openThreads(page)
    await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Draw the shop sign', exact: true }).click()
    const pane = page.locator('section.thread-pane:not([data-hidden])')
    await control('item/started', { id: 'sign', type: 'imageGeneration', status: 'inProgress', revisedPrompt: null })

    // The owl paints while the image is made: its text changes from frame to frame.
    const making = pane.getByRole('img', { name: 'Making the image' })
    await expect(making).toBeVisible({ timeout: 30_000 })
    await expect(pane.getByText('It shows here when it is done')).toBeVisible()
    const sketch = making.locator('.owl-easel__sketch')
    await expect(sketch).toContainText('OvO')
    const first = await sketch.textContent()
    await expect.poll(() => sketch.textContent(), { timeout: 5_000 }).not.toBe(first)
    await capture(page, 'making-1280-dark')
    const box = await making.locator('.owl-easel').evaluate(element => [element.clientWidth, element.clientHeight] as const)
    const grid = owlEaselGrid(box[0], box[1])
    const stillPaint = owlEaselFrame(grid.cols, grid.rows, 0.5, 0).paint

    // Under reduced motion it holds one still frame.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    // The still frame is the painting half done, with no brush moving.
    await expect.poll(() => making.locator('.owl-easel__paint').textContent()).toBe(stillPaint)
    const held = await sketch.textContent()
    await page.waitForTimeout(500)
    expect(await sketch.textContent()).toBe(held)
    await page.emulateMedia({ reducedMotion: 'no-preference' })

    // Codex saved the picture to a file and the item names only that file.
    const saved = join(root, 'generated-sign.png')
    await copyFile(PICTURE, saved)
    await control('item/completed', { id: 'sign', type: 'imageGeneration', status: 'completed', fileId: 'file_sign', savedPath: saved, revisedPrompt: 'An owl at an easel painting the shop sign' })
    const tile = pane.getByRole('button', { name: 'Open picture 1 of 1, from Image: An owl at an easel painting the shop sign' })
    await expect(tile).toBeVisible({ timeout: 30_000 })
    await expect(making).toHaveCount(0)
    await expect(pane.locator('.owl-easel')).toHaveCount(0)
    await expect(tile.locator('img')).toHaveJSProperty('complete', true, { timeout: 30_000 })
    expect(await tile.locator('img').evaluate((image: HTMLImageElement) => [image.naturalWidth <= 416, image.src.startsWith('data:image/jpeg')])).toEqual([true, true])
    await expect(pane.getByText('PNG · 1920×1203')).toBeVisible()
    await capture(page, 'generated-1280-dark')
    await tile.click()
    const viewer = page.getByRole('dialog')
    await expect(viewer.locator('img').first()).toHaveJSProperty('naturalWidth', 1920, { timeout: 30_000 })
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)

    // A second image, still being made, in light and at the minimum.
    await control('item/started', { id: 'sign-2', type: 'imageGeneration', status: 'inProgress', revisedPrompt: null })
    await expect(making).toBeVisible({ timeout: 30_000 })
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'light' }) })
    await capture(page, 'making-1280-light')
    await resizeWindow(launched, 820, 560)
    await making.scrollIntoViewIfNeeded()
    await capture(page, 'making-820-light')
    expect(await pane.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  } finally {
    if (launched) await closeSotto(launched)
    for (const [key, value] of [['SOTTO_E2E_NATIVE_FIXTURE_ROOT', previous.root], ['SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE', previous.executable], ['SOTTO_OWL_FEATURES', previous.owl]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    await removeOwnedE2EProfile(profile)
  }
})
