import { expect, test } from '@playwright/test'

import { withSotto } from '../fixtures/designCaptureProfile'
import { captureWidget, widgetPage, widgetThemes } from './support/designCapture'
import { openPage } from './support/sottoLaunch'

const captureEnabled = process.env.SOTTO_DESIGN_CAPTURE === '1'

test.describe('authoritative design-review captures', () => {
  test.skip(!captureEnabled, 'Run through npm run design:capture or npm run design:verify')
  test.describe.configure({ mode: 'serial', timeout: 10 * 60_000 })

  for (const theme of widgetThemes) {
    test(`${theme} widget states missing from the established widget baseline are captured`, async () => {
      await withSotto({ onboardingComplete: true, motion: 'reduced' }, async (launched) => {
        await openPage(launched.page, 'Dictate')
        // Bootstrap seeds the idle snapshot after showing both windows. Wait
        // for that seed so it cannot overwrite the first recording snapshot.
        const widget = await widgetPage(launched, theme, 'reduced')
        await expect(widget.locator('.widget-shell[data-status="idle"]')).toBeVisible()
        await launched.page.getByRole('button', { name: 'Start dictation' }).click()
        await expect(widget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
        await widget.getByRole('button', { name: 'Cancel dictation' }).click()
        await expect(widget.locator('.widget-shell[data-status="idle"]')).toBeVisible({ timeout: 15_000 })
        await expect(widget.locator('.widget-sliver')).toBeVisible()
        await captureWidget(
          widget,
          `widget-idle-${theme}.png`,
          { category: 'widget', state: 'idle-sliver', theme, reducedMotion: true },
          { width: 124, height: 54 },
        )
      })

      await withSotto({ onboardingComplete: true, motion: 'reduced', scenario: 'design-permission' }, async (launched) => {
        await openPage(launched.page, 'Dictate')
        const widget = await widgetPage(launched, theme, 'reduced')
        await expect(widget.locator('.widget-shell[data-status="idle"]')).toBeVisible()
        await launched.page.getByRole('button', { name: 'Start dictation' }).click()
        await expect(widget.getByText('Waiting for microphone', { exact: true })).toBeVisible()
        await captureWidget(widget, `widget-permission-${theme}.png`, { category: 'widget', state: 'requesting-permission', theme, reducedMotion: true })
      })

      await withSotto({ onboardingComplete: true, motion: 'reduced' }, async (launched) => {
        await openPage(launched.page, 'Dictate')
        const widget = await widgetPage(launched, theme, 'reduced')
        await expect(widget.locator('.widget-shell[data-status="idle"]')).toBeVisible()
        await launched.page.getByRole('button', { name: 'Start dictation' }).click()
        await expect(widget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
        await widget.getByRole('button', { name: 'Cancel dictation' }).click()
        await expect(widget.getByText('Cancelled', { exact: true })).toBeVisible()
        await captureWidget(widget, `widget-cancelled-${theme}.png`, { category: 'widget', state: 'cancelled', theme, reducedMotion: true })
      })
    })
  }
})
