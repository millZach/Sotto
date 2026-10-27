/**
 * Restarting stopped threads (ADR-0144) in the built app, on the Owl track, with the real Claude adapter over the fake CLI
 * in `tests/fixtures/`. A turn stops at Claude Code's usage limit with the reset Claude Code appends; the Threads sidebar
 * shows the band, the row says when, and a strip sits over the composer. A minute after the reset the thread is sent the
 * restart note, tagged Restarted, word for word.
 *
 *   npm run build && npx playwright test tests/e2e/restart-stopped.spec.ts
 */
import { fillPrompt, promptField } from './support/prompt'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { limitRestartNote } from '../../src/shared/limitRestart'
import { evidenceDirectory } from '../fixtures/evidence'
import { fakeClaudeLaunches, fakeClaudePrompts as prompts } from '../fixtures/fakeClaudeRecords'
import { writeProviderAction } from '../fixtures/providerRecords'
import { onReleaseTrack } from './support/releaseTrack'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/restart-stopped-threads')

async function nativeFixtureProfile() {
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-restart-stopped-' })).directory
  const root = join(profile, 'native-fixture')
  for (const folder of ['claude', 'project']) await mkdir(join(root, folder), { recursive: true })
  const previous = { SOTTO_E2E_NATIVE_FIXTURE_ROOT: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE }
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  const restore = async (): Promise<void> => {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    await removeOwnedE2EProfile(profile)
  }
  return { profile, root, project: join(root, 'project'), restore }
}
async function openThread(page: Page, title: string) {
  await openThreads(page)
  await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: title, exact: true }).click({ position: { x: 16, y: 12 } })
  const pane = page.locator('section.thread-pane:not([data-hidden])')
  return { pane, transcript: pane.getByLabel('Thread transcript') }
}

test('a thread Claude Code’s usage limit stopped is restarted, with the restart note, once the limit resets', async () => {
  test.setTimeout(300_000)
  const { profile, root, project, restore } = await nativeFixtureProfile()
  const claude = join(root, 'claude')
  await mkdir(evidence, { recursive: true })
  let launched: LaunchedSotto | undefined
  try {
    await onReleaseTrack('owl', async () => {
      launched = await launchSotto('success', profile)
      const page = launched.page
      await page.evaluate(async () => {
        await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' })
        const configured = await window.sotto!.agents!.command({ type: 'configure', patch: { provider: 'claude', enabled: true, enabledProviders: ['claude'] } })
        if (configured.error) throw new Error(configured.error)
        const connected = await window.sotto!.agents!.command({ type: 'connect', provider: 'claude' })
        if (connected.error) throw new Error(connected.error)
      })
      await page.reload()
      await page.evaluate(async path => {
        const agents = window.sotto!.agents!
        const created = await agents.command({ type: 'create-project', provider: 'claude', title: 'Lighthouses', path, useExisting: true })
        if (created.error) throw new Error(created.error)
        const projectId = created.host.projects.find(item => item.title === 'Lighthouses')!.id
        const model = (await agents.get()).host.models.find(item => item.providerId === 'claude' && item.ready)
        if (!model) throw new Error('No ready Claude model.')
        const thread = await agents.command({ type: 'create-thread', projectId, title: 'Lighthouse essay', titleSource: 'user', modelId: model.id, workingCopy: 'shared' })
        if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'No thread was created.')
      }, project)

      // A turn starts, and Claude Code stops it at the usage limit, with the reset it appends.
      const { pane, transcript } = await openThread(page, 'Lighthouse essay')
      const prompt = promptField(pane)
      await fillPrompt(prompt, 'Write a long essay on the history of the lighthouse.')
      await prompt.press('Enter')
      await expect.poll(() => prompts(claude), { timeout: 30_000 }).toBe(1)
      const session = (await fakeClaudeLaunches(claude)).at(-1)!.session
      const reset = Math.floor(Date.now() / 1000) + 20
      await writeProviderAction(join(claude, `control-${session}.json`), { type: 'raw', frame: { type: 'result', subtype: 'success', session_id: session,
        is_error: true, api_error_status: 429, result: `Claude AI usage limit reached|${reset}` } })

      // The band, the row and the strip say when Sotto restarts it.
      const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
      const band = sidebar.locator('.restart-band')
      await expect(band).toBeVisible({ timeout: 30_000 })
      await expect(band).toContainText('Claude Code’s limit resets at')
      await expect(band.getByRole('button', { name: 'Lighthouse essay' })).toBeVisible()
      await expect(sidebar.getByText(/Restarts at /u).first()).toBeVisible()
      const strip = pane.locator('.restart-strip')
      await expect(strip).toContainText('when Claude Code’s limit resets')
      await expect(strip.getByRole('button', { name: 'Don’t restart this thread' })).toBeVisible()

      for (const [width, height] of [[1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
          expect(await sidebar.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
          expect(await strip.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
          await page.screenshot({ path: join(evidence, `scheduled-${appearance}-${width}.png`), animations: 'disabled' })
        }
      }
      await resizeWindow(launched, 1280, 800)
      await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))

      // A minute after the reset the thread is sent the note, once, and the band goes.
      const note = limitRestartNote('Claude Code')
      await expect.poll(() => prompts(claude), { timeout: 150_000 }).toBe(2)
      const shown = transcript.locator('.thread-message[data-from="sotto"]')
      await expect(shown).toHaveCount(1, { timeout: 30_000 })
      await expect(shown.locator('.thread-message__tag')).toHaveText('Restarted')
      await expect(shown).toContainText(note)
      await expect(band).toHaveCount(0)
      await shown.scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(evidence, 'restarted-dark-1280.png'), animations: 'disabled' })

      await writeProviderAction(join(claude, `control-${session}.json`), { type: 'complete', text: 'The essay is finished.' })
      await expect(transcript.getByText('The essay is finished.')).toBeVisible({ timeout: 30_000 })
      expect(await prompts(claude)).toBe(2)
    })
  } finally {
    if (launched) await closeSotto(launched)
    await restore()
  }
})
