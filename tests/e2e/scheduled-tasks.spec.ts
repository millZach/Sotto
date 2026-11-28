import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { captureWindow, closeSotto, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'

const evidence = evidenceDirectory('artifacts/scheduled-tasks')
const taskName = 'Review the morning notes'
const question = 'Continue the review?'

async function openScheduledTasks(page: Page): Promise<void> {
  await openPage(page, 'Settings')
  await page.getByRole('tab', { name: 'Scheduled tasks', exact: true }).click()
}

test('an Owl task waits for a decision across a desktop restart', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance')
  test.setTimeout(150_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-scheduled-tasks-' })).directory
  const previous = process.env.SOTTO_OWL_FEATURES
  let launched: LaunchedSotto | undefined
  try {
    await mkdir(evidence, { recursive: true })
    await mkdir(join(profile, 'playbooks'))
    await writeFile(join(profile, 'settings.json'), JSON.stringify({
      ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: true, reducedMotion: 'on', appearance: 'dark',
    }))
    await writeFile(join(profile, 'playbooks', 'review.json'), JSON.stringify({
      format: 1, name: 'Review notes',
      steps: [{ id: 'review', kind: 'decision', question }],
    }))
    process.env.SOTTO_OWL_FEATURES = 'scheduled-tasks=1'
    launched = await launchSotto('phase3-workspace', profile)
    const { page } = launched
    await page.evaluate(async () => {
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { enabled: true } })
      await agents.command({ type: 'connect' })
    })
    await openScheduledTasks(page)
    const enabled = page.getByRole('switch', { name: 'Run scheduled tasks on this computer' })
    await expect(enabled).toHaveAttribute('aria-checked', 'false')
    await enabled.click()
    await expect(enabled).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('button', { name: 'New task' }).click()
    const editor = page.getByRole('form', { name: 'New scheduled task' })
    await editor.getByLabel('Name', { exact: true }).fill(taskName)
    await editor.getByRole('radio', { name: 'A playbook' }).click()
    await editor.getByLabel('Playbook', { exact: true }).selectOption('review')
    await editor.getByLabel('Schedule', { exact: true }).selectOption('none')
    await editor.getByRole('button', { name: 'Save task' }).click()
    await page.getByRole('button', { name: 'Run now' }).click()
    await expect(page.getByText(question, { exact: true })).toBeVisible()

    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(look => window.sotto!.updateSettings({ appearance: look }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
        await resizeContentWindow(launched, width, height)
        await expect.poll(() => page.locator('.settings-scroll').evaluate(room => room.scrollWidth - room.clientWidth)).toBeLessThanOrEqual(1)
        if (width === 820) {
          await page.getByText(question, { exact: true }).scrollIntoViewIfNeeded()
          await captureWindow(launched.app, join(evidence, `waiting-${appearance}-820x560.png`))
        }
      }
    }

    await closeSotto(launched)
    launched = undefined
    launched = await launchSotto('phase3-workspace', profile)
    await openScheduledTasks(launched.page)
    await expect(launched.page.getByText(question, { exact: true })).toBeVisible()
    await launched.page.getByRole('button', { name: 'Go on', exact: true }).click()
    await expect(launched.page.locator('[data-outcome="finished"]')).toContainText(taskName)
    await expect(launched.page.locator('.tasks-run')).toHaveCount(1)
  } finally {
    if (previous === undefined) delete process.env.SOTTO_OWL_FEATURES
    else process.env.SOTTO_OWL_FEATURES = previous
    if (launched) await closeSotto(launched)
    await removeOwnedE2EProfile(profile)
  }
})
