import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { populatedHistory, withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { pageBoundProblems } from './support/designCapture'
import { openPage } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'

/** docs/verification/dictate-journal.md cites what this writes when run with SOTTO_E2E_EVIDENCE=publish. */
const shots = evidenceDirectory('artifacts/dictate-journal')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const

async function shoot(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, 0)
  expect(await pageBoundProblems(page), `${name} has clipped or overflowing controls`).toEqual([])
  await page.screenshot({ path: join(shots, name), animations: 'disabled', caret: 'hide' })
}

test.describe('the Dictate room as a Journal (#1293)', () => {
  test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 })

  test('shows the Journal and its stats in both rooms at every reviewed size, with nothing clipped', async () => {
    await mkdir(shots, { recursive: true })
    for (const appearance of ['dark', 'light'] as const) {
      await withSotto({ onboardingComplete: true, history: populatedHistory, appearance }, async (launched) => {
        const { page } = launched
        await openPage(page, 'Dictate')
        await expect(page.getByRole('heading', { level: 1, name: 'Ready when you are.' })).toBeVisible()
        // No page link leads to History any more; transcripts live here.
        await expect(page.getByRole('link', { name: 'History', exact: true })).toHaveCount(0)
        const today = page.getByRole('region', { name: 'Today' })
        await expect(today).toContainText('Windows Terminal · 26 words')
        await expect(page.getByRole('region', { name: 'Yesterday' })).toContainText('Draft the launch summary')
        await expect(page.getByText('Write a short note in docs verification')).toHaveCount(0)
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height, [820, 560])
          const wide = width - await page.locator('.thread-nav').evaluate((node) => node.getBoundingClientRect().width) >= 900
          await expect(page.getByRole('heading', { name: 'Speed, last 30 days' })).toBeVisible({ visible: wide })
          await expect(page.getByRole('heading', { name: 'This month' })).toBeVisible()
          await shoot(page, `journal-${appearance}-${width}x${height}.png`)
        }
      })
    }
  })

  test('opens a row in place, keeps Clear history in the More menu, and closes both with Escape', async () => {
    await withSotto({ onboardingComplete: true, history: populatedHistory }, async (launched) => {
      const { page } = launched
      await openPage(page, 'Dictate')
      await resizeContentWindow(launched, 1280, 800, [820, 560])
      const toggle = page.getByRole('button', { name: /^Transcript from/ }).first()
      await toggle.focus()
      await page.keyboard.press('Enter')
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(page.getByText(/^12 seconds, 26 words at 134 wpm\.$/)).toBeVisible()
      await expect(page.getByRole('button', { name: 'Delete saved transcript' })).toBeVisible()
      await shoot(page, 'journal-open-row-1280x800.png')
      await page.keyboard.press('Escape')
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(toggle).toBeFocused()

      await page.getByRole('button', { name: 'More transcript actions' }).click()
      await expect(page.getByRole('menuitem', { name: 'Clear history' })).toBeFocused()
      await shoot(page, 'journal-more-menu-1280x800.png')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'More transcript actions' })).toBeFocused()

      // Ctrl+K comes back to the Journal's search from another page.
      await openPage(page, 'Help')
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K')
      await expect(page.getByRole('searchbox', { name: 'Search transcripts' })).toBeFocused()
      await page.keyboard.type('switchgear')
      await expect(page.getByRole('region', { name: 'Today' })).toContainText('Running about ten minutes late')
      await expect(page.getByText('Draft the launch summary')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('searchbox', { name: 'Search transcripts' })).toHaveValue('')

      await page.getByRole('group', { name: 'Show transcripts from' }).getByRole('button', { name: 'Slack' }).click()
      await expect(page.getByText('Draft the launch summary')).toHaveCount(0)
      await expect(page.getByText('Remember to confirm the accessibility review')).toBeVisible()
    })
  })

  test('says History is off over the older transcripts and keeps counting, and holds still under reduced motion', async () => {
    await withSotto({ onboardingComplete: true, history: populatedHistory }, async (launched) => {
      const { page } = launched
      await openPage(page, 'Dictate')
      await page.evaluate(async () => { await window.sotto!.updateSettings({ historyEnabled: false }) })
      await expect(page.getByText('History is off. New dictations keep their numbers only; older transcripts stay here until you delete them.')).toBeVisible()
      await page.getByRole('button', { name: 'Start dictation' }).click()
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      await expect(page.getByRole('heading', { level: 1, name: 'Pasted into Sotto.' })).toBeVisible()
      // Its numbers count today; its words were not kept.
      await expect(page.getByRole('complementary', { name: 'Your dictation' })).toContainText('in 4 dictations')
      for (const [width, height] of [[1280, 800], [820, 560]] as const) {
        await resizeContentWindow(launched, width, height, [820, 560])
        await shoot(page, `journal-history-off-${width}x${height}.png`)
      }
    })
    await withSotto({ onboardingComplete: true, history: populatedHistory, motion: 'reduced', appearance: 'light' }, async (launched) => {
      const { page } = launched
      await openPage(page, 'Dictate')
      await resizeContentWindow(launched, 1280, 800, [820, 560])
      await page.getByRole('button', { name: 'Start dictation' }).click()
      await expect(page.getByRole('heading', { level: 1, name: /^Listening\./ })).toBeVisible()
      await shoot(page, 'journal-listening-reduced-motion-light-1280x800.png')
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      await expect(page.getByRole('heading', { level: 1, name: 'Pasted into Sotto.' })).toBeVisible()
    })
  })
})
