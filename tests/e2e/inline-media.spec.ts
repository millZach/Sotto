/**
 * An agent's pictures in the built app (ADR-0170, request-only): a Claude Code thread over the fake CLI takes a screenshot
 * with Sotto's browser tool, and its turn shows no tile for it. Asked to show the picture, the agent calls `sotto_media`'s
 * show_in_thread with the file, and the turn shows it as a tile that opens in the viewer, in dark and light and at the
 * 820x560 minimum. With `inline-media` off nothing shows. The captures go to `artifacts/inline-media/` when
 * SOTTO_E2E_ARTIFACTS=1.
 *
 *   npm run build && npx playwright test tests/e2e/inline-media.spec.ts
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

const SHOT = resolve('artifacts/image-viewer/viewer-1280-dark.png')

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) })
  if (process.env.SOTTO_E2E_ARTIFACTS === '1' || process.env.SOTTO_NESTED_LIVE_SIGNATURE) {
    await mkdir(resolve('artifacts/inline-media'), { recursive: true })
    await page.screenshot({ path: resolve('artifacts/inline-media', `${name}.png`) })
  }
}

/** A Claude thread in its own project, sent one prompt so its CLI session is open, and that session's ID. */
async function claudeThread(page: Page, root: string, project: string): Promise<{ threadId: string; session: string }> {
  const threadId = await page.evaluate(async project => {
    const agents = window.sotto!.agents!
    const created = await agents.command({ type: 'create-project', provider: 'claude', title: 'Lumen shop', path: project, useExisting: true })
    if (created.error) throw new Error(created.error)
    const projectId = created.host.projects.find(item => item.title === 'Lumen shop')!.id
    const model = (await agents.get()).host.models.find(item => item.providerId === 'claude' && item.ready)
    if (!model) throw new Error('No ready Claude model.')
    const thread = await agents.command({ type: 'create-thread', projectId, title: 'Fix the checkout layout', titleSource: 'user', modelId: model.id, workingCopy: 'shared' })
    if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'No thread was created.')
    const sent = await agents.command({ type: 'manual-send', threadId: thread.activeThreadId, text: 'Open checkout and show me what is wrong.' })
    if (sent.error) throw new Error(sent.error)
    return thread.activeThreadId
  }, project)
  const alive = async () => (await readdir(root)).filter(name => /^alive-.+\.json$/u.test(name)).map(name => name.slice(6, -5))
  await expect.poll(async () => (await alive()).length, { timeout: 60_000 }).toBe(1)
  return { threadId, session: (await alive())[0]! }
}

/** The CLI takes a screenshot with Sotto's browser tool, hands it back as its result, and finishes the turn. */
async function takeScreenshot(root: string, session: string): Promise<void> {
  const control = join(root, `control-${session}.json`)
  const data = (await readFile(SHOT)).toString('base64')
  const frames = [
    { type: 'assistant', uuid: randomUUID(), session_id: session, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: 'shot', name: 'mcp__sotto_browser__screenshot', input: {} }] } },
    { type: 'user', uuid: randomUUID(), session_id: session, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shot',
      content: [{ type: 'text', text: 'Took a screenshot of http://localhost:5173/checkout.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }] } },
  ]
  await writeFile(control, JSON.stringify({ id: randomUUID(), type: 'raw-burst', persist: true, frames }))
  await expect.poll(() => existsSync(control), { timeout: 60_000 }).toBe(false)
  await writeFile(control, JSON.stringify({ id: randomUUID(), type: 'complete', text: 'The Pay button sits on top of the total. The screenshot shows it.' }))
  await expect.poll(() => existsSync(control), { timeout: 60_000 }).toBe(false)
}

for (const on of [true, false]) {
  test(`a screenshot an agent took shows no tile of its own, ${on ? 'and one it was asked to show tiles and opens in the viewer' : 'nor anything with inline-media off'}`, async () => {
    test.setTimeout(240_000)
    const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-inline-media-' })).directory
    const root = join(profile, 'native-fixture')
    const project = join(root, 'project')
    for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
    const previous = { root: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, executable: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE, owl: process.env.SOTTO_OWL_FEATURES }
    process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
    process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
    process.env.SOTTO_OWL_FEATURES = `inline-media=${on ? 1 : 0}`
    let launched: LaunchedSotto | undefined
    try {
      launched = await launchSotto('success', profile)
      const { page } = launched
      await page.evaluate(async () => {
        await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
        const configured = await window.sotto!.agents!.command({ type: 'configure', patch: { provider: 'claude', enabled: true, enabledProviders: ['claude'] } })
        if (configured.error) throw new Error(configured.error)
        const connected = await window.sotto!.agents!.command({ type: 'connect', provider: 'claude' })
        if (connected.error) throw new Error(connected.error)
      })
      await page.reload()
      await resizeWindow(launched, 1280, 800)
      const { threadId, session } = await claudeThread(page, join(root, 'claude'), project)
      await takeScreenshot(join(root, 'claude'), session)
      await openThreads(page)
      await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Fix the checkout layout', exact: true }).click()
      const pane = page.locator('section.thread-pane:not([data-hidden])')
      await expect(pane.getByText('The Pay button sits on top of the total.')).toBeVisible({ timeout: 30_000 })
      // Request-only (ADR-0170): the screenshot the agent took shows no tile of its own, with the feature on or off.
      await expect(pane.locator('.thread-media')).toHaveCount(0)
      if (!on) return
      // Asked to show it, the agent names the file to show_in_thread, and it shows as a tile under the title it gave.
      const shown = await page.evaluate(async request => window.sottoE2E!.mediaTool!(request), { threadId, arguments: { paths: [SHOT], title: 'The checkout page' } })
      expect(shown.isError).toBeFalsy()
      const tile = pane.getByRole('button', { name: 'Open picture 1 of 1, from The checkout page' })
      await expect(tile).toBeVisible()
      await expect(tile.locator('img')).toHaveJSProperty('complete', true, { timeout: 30_000 })
      // The tile holds main's thumbnail, never the whole picture.
      expect(await tile.locator('img').evaluate((image: HTMLImageElement) => [image.naturalWidth <= 416, image.src.startsWith('data:image/jpeg')])).toEqual([true, true])
      await expect(pane.getByText('PNG · 1920×1203')).toBeVisible()
      await capture(page, 'tile-1280-dark')
      await tile.click()
      const viewer = page.getByRole('dialog')
      await expect(viewer).toBeVisible()
      await expect(viewer.locator('img').first()).toHaveJSProperty('naturalWidth', 1920, { timeout: 30_000 })
      await capture(page, 'viewer-1280-dark')
      await page.keyboard.press('Escape')
      await expect(viewer).toHaveCount(0)
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'light' }) })
      await capture(page, 'tile-1280-light')
      await resizeWindow(launched, 820, 560)
      await tile.scrollIntoViewIfNeeded()
      await capture(page, 'tile-820-light')
      // Nothing at the minimum spills past the pane.
      expect(await pane.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    } finally {
      if (launched) await closeSotto(launched)
      for (const [key, value] of [['SOTTO_E2E_NATIVE_FIXTURE_ROOT', previous.root], ['SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE', previous.executable], ['SOTTO_OWL_FEATURES', previous.owl]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value
      }
      await removeOwnedE2EProfile(profile)
    }
  })
}
