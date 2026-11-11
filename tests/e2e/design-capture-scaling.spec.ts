import { expect, test } from '@playwright/test'

import { populatedHistory, withSotto } from '../fixtures/designCaptureProfile'
import { scales, widgetThemes, setAppearance, assertDictateState, capturePage, captureFullSurface, captureWidget, widgetPage } from './support/designCapture'
import { openPage, reachSetupStop, setupNote } from './support/sottoLaunch'

const captureEnabled = process.env.SOTTO_DESIGN_CAPTURE === '1'

test.describe('authoritative design-review captures', () => {
  test.skip(!captureEnabled, 'Run through npm run design:capture or npm run design:verify')
  test.describe.configure({ mode: 'serial', timeout: 10 * 60_000 })

  test('dense scaling matrix remains bounded', async () => {
    for (const scalePercent of scales) {
      await withSotto({ onboardingComplete: false, scalePercent }, async ({ page }) => {
        // First-run setup's speech model stop (ADR-0200), the window with its note over Settings › Dictation.
        await reachSetupStop(page, 'microphone')
        await page.locator('.settings-microphone-test').getByRole('button', { name: 'Test microphone', exact: true }).click()
        await expect(setupNote(page)).toContainText('Sotto heard you. Your microphone works.')
        await reachSetupStop(page, 'speech-model')
        await expect(setupNote(page).getByRole('heading', { name: 'Choose a speech model' })).toBeVisible()
        await capturePage(page, `scale-${scalePercent}-setup.png`)
      })

      await withSotto({ onboardingComplete: true, history: populatedHistory, scalePercent }, async (launched) => {
        const { page } = launched
        await openPage(page, 'Dictate')
        await assertDictateState(page, 'idle', /ready when you are/i)
        await capturePage(page, `scale-${scalePercent}-dictate.png`)

        await page.getByRole('button', { name: 'Start dictation' }).click()
        for (const theme of widgetThemes) {
          const liveWidget = await widgetPage(launched, theme)
          await expect(liveWidget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
          await captureWidget(liveWidget, `scale-${scalePercent}-widget-${theme}.png`, { theme })
        }
        const liveWidget = await widgetPage(launched, 'dark')
        await liveWidget.evaluate(() => window.sottoWidget!.requestCancel())

        // The Journal, from the bar to the last day it shows, once the cancelled dictation has gone back to rest.
        await expect(page.locator('.dictate')).toHaveAttribute('data-status', 'idle', { timeout: 15_000 })
        await captureFullSurface(page, page.locator('.dictate'), `scale-${scalePercent}-journal.png`, /Draft the launch summary/i)

        await page.getByRole('link', { name: 'Settings' }).click()
        await captureFullSurface(page, page.locator('.settings-view'), `scale-${scalePercent}-settings.png`, /^Application$/i)

        await page.getByRole('link', { name: 'Help' }).click()
        await captureFullSurface(page, page.locator('.help-view'), `scale-${scalePercent}-help.png`, /Reset safely/i)

        // The light room at the same scale, switched live.
        await setAppearance(page, { appearance: 'light' }, 'light')
        await page.getByRole('tab', { name: 'Dictate', exact: true }).click()
        await assertDictateState(page, 'idle', /ready when you are/i)
        await capturePage(page, `scale-${scalePercent}-dictate-light.png`, { theme: 'light' })
        await page.getByRole('link', { name: 'Settings' }).click()
        await captureFullSurface(page, page.locator('.settings-view'), `scale-${scalePercent}-settings-light.png`, /^Application$/i, { theme: 'light' })
      })
    }
  })
})
