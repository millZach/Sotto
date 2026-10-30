/**
 * Settle without asking, in Settings under Watcher, on the Owl track: the toggle sits first, under Watched threads, on by
 * default, above Compaction and worker roles under their own headings (Zach's pick A on October 20, 2026). It was Settle
 * finished threads until Watcher, not Sotto, came to decide a settle (October 29, 2026); its description says what on
 * and off do. It works from the keyboard and saves as it changes, and nothing clips at any size, in dark or light.
 *
 *   npm run build && npx playwright test tests/e2e/watcher-settle-finished.spec.ts
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { pageBoundProblems } from './support/designCapture'
import { onReleaseTrack } from './support/releaseTrack'
import { settingsLayoutProblems, settingsTextContrast } from './support/settingsChecks'
import { closeSotto, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'
import { resizeWindow } from './support/sottoWindow'

const evidence = evidenceDirectory('artifacts/watcher-settle-finished')

async function capture(page: Page, name: string): Promise<void> {
  await mkdir(evidence, { recursive: true })
  await page.mouse.move(0, 0)
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled', caret: 'hide' })
}
const saved = (page: Page): Promise<boolean> => page.evaluate(async () => (await window.sotto!.getSettings()).watcherSettlesFinishedThreads)

test('Settle without asking leads Settings under Watcher, on by default, says what on and off do, and saves from the keyboard', async () => {
  test.setTimeout(180_000)
  let launched: LaunchedSotto | undefined
  try {
    await onReleaseTrack('owl', async () => {
      launched = await launchSotto('success')
      const { page } = launched
      await page.evaluate(async () => { await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' }) })
      await page.reload()
      await openPage(page, 'Settings')
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Watcher', exact: true }).click()
      const panel = page.locator('#settings-watcher')
      await expect(panel.getByRole('heading', { name: 'Watched threads' })).toBeVisible()
      await expect(panel.getByRole('heading', { name: 'Worker roles' })).toBeVisible()
      // The toggle comes before Compaction and worker roles, as the eye reads the section.
      const order = await panel.evaluate(element => [...element.querySelectorAll('h3')].map(heading => heading.textContent?.trim()))
      // Where new workers start, Work across machines' own heading, may sit between them on Owl.
      expect(order.slice(0, 2)).toEqual(['Watched threads', 'Compaction'])
      expect(order.indexOf('Worker roles')).toBeGreaterThan(1)
      const toggle = panel.getByRole('switch', { name: 'Settle without asking' })
      await expect(toggle).toBeChecked()
      await expect(panel.getByText('Watcher decides when a thread it watches is finished, then settles it and stops watching it. On, it settles without asking you. Off, it asks you first.')).toBeVisible()
      expect(await saved(page)).toBe(true)

      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        for (const appearance of width === 1280 ? ['dark', 'light'] as const : ['dark'] as const) {
          await page.evaluate(async mode => { await window.sotto!.updateSettings({ appearance: mode }) }, appearance)
          await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
          await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0 })
          const where = `${width}x${height} ${appearance}`
          expect(await pageBoundProblems(page), where).toEqual([])
          expect(await settingsLayoutProblems(page, 'settings-watcher', '.settings-group, .tt-toggle, .worker-roles__head'), where)
            .toEqual({ pageOverflow: false, formOverflow: false, clipped: [] })
          const low = (await settingsTextContrast(page, 'settings-watcher', '.settings-group > h3, .tt-toggle *, .worker-roles__head h3'))
            .filter(item => item.text.trim() && item.ratio < 4.5)
          expect(low, where).toEqual([])
          await capture(page, `watcher-settings-${width}x${height}-${appearance}`)
        }
      }

      // From the keyboard: Space turns it off and on again, and each press saves.
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
      await resizeWindow(launched, 1280, 800)
      await toggle.focus()
      await page.keyboard.press('Space')
      await expect(toggle).not.toBeChecked()
      await expect.poll(() => saved(page)).toBe(false)
      await capture(page, 'watcher-settings-1280x800-dark-off')
      await page.keyboard.press('Space')
      await expect(toggle).toBeChecked()
      await expect.poll(() => saved(page)).toBe(true)
    })
  } finally {
    if (launched) await closeSotto(launched)
  }
})
