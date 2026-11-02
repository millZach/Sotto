/**
 * A picture and a video an agent shows when asked, in the built app (ADR-0170, request-only): a Codex thread over the fake
 * app server works in a Git project that ignores `test-results/`, writes a screenshot and a recording there, and ends its
 * turn, which shows nothing of them. Then the agent names both to `sotto_media`'s show_in_thread, and the turn shows them
 * as tiles under its title: the screenshot read from the store, the recording played from its file through
 * `sotto-media:`, which shows its first frame, never plays on its own, plays when pressed and pauses when it leaves the
 * screen. Dark and light, and the 820x560 minimum. The captures go to `artifacts/inline-media/` when
 * SOTTO_E2E_ARTIFACTS=1.
 *
 *   npm run build && npx playwright test tests/e2e/inline-media-shown.spec.ts
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

const PICTURE = resolve('artifacts/image-viewer/viewer-1280-dark.png')
const RECORDING = resolve('tests/fixtures/media/recording.webm')

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) })
  if (process.env.SOTTO_E2E_ARTIFACTS === '1' || process.env.SOTTO_NESTED_LIVE_SIGNATURE) {
    await mkdir(resolve('artifacts/inline-media'), { recursive: true })
    await page.screenshot({ path: resolve('artifacts/inline-media', `${name}.png`) })
  }
}

test('a screenshot and a recording a turn wrote show nothing until the agent shows them, and the recording plays only when pressed', async () => {
  test.setTimeout(240_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-inline-written-' })).directory
  const root = join(profile, 'native-fixture')
  const project = join(root, 'project')
  for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: project })
  await writeFile(join(project, '.gitignore'), 'test-results/\n')
  await writeFile(join(root, 'codex', 'script.json'), JSON.stringify({}))
  const previous = { root: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, executable: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE, owl: process.env.SOTTO_OWL_FEATURES }
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  process.env.SOTTO_OWL_FEATURES = 'inline-media=1'
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    const sottoThreadId = await page.evaluate(async project => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { provider: 'codex', enabled: true, enabledProviders: ['codex'], checkClientUpdates: false } })
      await agents.command({ type: 'connect', provider: 'codex' })
      const created = await agents.command({ type: 'create-project', provider: 'codex', title: 'Lumen shop', path: project, useExisting: true })
      const projectId = created.host.projects.find(item => item.title === 'Lumen shop')!.id
      const modelId = (await agents.get()).host.models.find(model => model.providerId === 'codex' && model.ready)!.id
      const thread = await agents.command({ type: 'create-thread', projectId, title: 'Record the sign-up flow', titleSource: 'user', modelId, workingCopy: 'shared' })
      if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'No thread was created.')
      const sent = await agents.command({ type: 'manual-send', threadId: thread.activeThreadId, text: 'Record the sign-up flow and take a screenshot of the last step.' })
      if (sent.error) throw new Error(sent.error)
      return thread.activeThreadId
    }, project)
    const nativeThread = async () => {
      const state = JSON.parse(await readFile(join(root, 'codex', 'state.json'), 'utf8')) as { threads: Record<string, { id: string; turns: { id: string }[] }> }
      const thread = Object.values(state.threads)[0]
      return thread?.turns.at(-1) ? thread.id : undefined
    }
    await expect.poll(nativeThread, { timeout: 60_000 }).toBeTruthy()
    const threadId = (await nativeThread())!

    // The agent writes a screenshot and a recording into the ignored folder, then its turn ends.
    await mkdir(join(project, 'test-results', 'signup'), { recursive: true })
    await copyFile(PICTURE, join(project, 'test-results', 'signup', 'last-step.png'))
    await copyFile(RECORDING, join(project, 'test-results', 'signup', 'flow.webm'))
    const id = randomUUID()
    await writeFile(join(root, 'codex', 'control.json'), JSON.stringify({ id, threadId, type: 'complete', text: 'Recorded the flow and took a screenshot.' }))
    await expect.poll(async () => (await readFile(join(root, 'codex', 'actions.jsonl'), 'utf8').catch(() => '')).includes(id), { timeout: 30_000 }).toBe(true)

    await page.reload()
    await resizeWindow(launched, 1280, 800)
    await openThreads(page)
    await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Record the sign-up flow', exact: true }).click()
    const pane = page.locator('section.thread-pane:not([data-hidden])')
    await expect(pane.getByText('Recorded the flow and took a screenshot.')).toBeVisible({ timeout: 30_000 })
    // Request-only: what the turn wrote shows nothing of its own.
    await expect(pane.locator('.thread-media')).toHaveCount(0)
    const shown = await page.evaluate(async request => window.sottoE2E!.mediaTool!(request),
      { threadId: sottoThreadId, arguments: { paths: ['test-results/signup/last-step.png', 'test-results/signup/flow.webm'], title: 'The sign-up flow' } })
    expect(shown.isError).toBeFalsy()
    const picture = pane.getByRole('button', { name: 'Open picture 1 of 1, from The sign-up flow' })
    await expect(picture).toBeVisible({ timeout: 30_000 })
    await expect(picture.locator('img')).toHaveJSProperty('complete', true, { timeout: 30_000 })
    await expect(pane.getByText('PNG · 1920×1203')).toBeVisible()

    // The recording shows its first frame, read through `sotto-media:`, and does not play.
    const player = pane.locator('.thread-media--video video')
    await expect(player).toHaveCount(1, { timeout: 30_000 })
    await expect(pane.getByText(/^WebM · /u)).toBeVisible()
    await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
    expect(await player.evaluate((video: HTMLVideoElement) => [video.paused, video.videoWidth, video.src.startsWith('sotto-media://video/')])).toEqual([true, 320, true])
    await page.waitForTimeout(500)
    expect(await player.evaluate((video: HTMLVideoElement) => [video.paused, video.currentTime])).toEqual([true, 0])
    await capture(page, 'shown-1280-dark')

    // Pressed, it plays from its file.
    await pane.getByRole('button', { name: 'Play video 1' }).click()
    await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.3)
    await capture(page, 'shown-playing-1280-dark')

    // Scrolled off the screen, it pauses at once.
    await pane.locator('.thread-workspace__transcript').evaluate(element => { element.scrollTop = 0 })
    await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.paused).catch(() => true), { timeout: 10_000 }).toBe(true)

    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'light' }) })
    await pane.locator('.thread-workspace__transcript').evaluate(element => { element.scrollTop = element.scrollHeight })
    await capture(page, 'shown-1280-light')
    await resizeWindow(launched, 820, 560)
    await pane.locator('.thread-media--video').scrollIntoViewIfNeeded()
    await capture(page, 'shown-820-light')
    expect(await pane.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  } finally {
    if (launched) await closeSotto(launched)
    for (const [key, value] of [['SOTTO_E2E_NATIVE_FIXTURE_ROOT', previous.root], ['SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE', previous.executable], ['SOTTO_OWL_FEATURES', previous.owl]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    await removeOwnedE2EProfile(profile)
  }
})
