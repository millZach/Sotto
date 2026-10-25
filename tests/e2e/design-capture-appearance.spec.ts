import { expect, test } from '@playwright/test'

import { DESIGN_CAPTURE_BUILT_IN_THEMES, DESIGN_CAPTURE_DEFAULT_THEME, DESIGN_CAPTURE_MINIMUM_WIDTH } from '../../scripts/design-capture-matrix.mjs'
import { populatedHistory, withSotto } from '../fixtures/designCaptureProfile'
import { appThemes, assertDictateState, assertFocusPresentation, assertRenderedRoom, captureFullSurface, capturePage, captureSection, setAppearance, setMainWindowWidth, startSettingsAtHeading } from './support/designCapture'
import { openJournalRow, openPage } from './support/sottoLaunch'

const captureEnabled = process.env.SOTTO_DESIGN_CAPTURE === '1'

test.describe('authoritative design-review captures', () => {
  test.skip(!captureEnabled, 'Run through npm run design:capture or npm run design:verify')
  test.describe.configure({ mode: 'serial', timeout: 10 * 60_000 })

  test('light room, accents, System and the minimum width', async () => {
    await withSotto({ onboardingComplete: false, appearance: 'light' }, async ({ page }) => {
      const onboarding = page.locator('.onboarding-shell')
      const forward = page.locator('.onboarding-actions').getByRole('button', { name: /^(Continue|Skip for now)$/ })
      await assertRenderedRoom(page, 'light')
      await page.getByRole('button', { name: 'Get started' }).click()
      await forward.click()
      await page.getByRole('button', { name: /test microphone/i }).click()
      await expect(page.getByText('Sotto heard you. Your microphone works.')).toBeVisible()
      await forward.click()
      await expect(page.getByRole('heading', { name: 'Choose a speech model' })).toBeVisible()
      await captureSection(page, onboarding, 'onboarding-step-4-speech-model-light.png', { theme: 'light' })
    })

    await withSotto({ memory: true, onboardingComplete: true, history: populatedHistory, appearance: 'light' }, async ({ page }) => {
      await openPage(page, 'Dictate')
      await assertDictateState(page, 'idle', /ready when you are/i)
      await assertRenderedRoom(page, 'light')
      await capturePage(page, 'dictate-ready-light.png', { theme: 'light' })
      await assertFocusPresentation(page.getByRole('tab', { name: 'Threads' }))
      await capturePage(page, 'focus-switch-tab-light.png', { focusTarget: 'tab', focus: true, theme: 'light' })
      await assertFocusPresentation(page.getByRole('link', { name: 'Settings' }))
      await capturePage(page, 'focus-navigation-light.png', { focusTarget: 'navigation', focus: true, theme: 'light' })
      await page.getByRole('button', { name: 'Start dictation' }).click()
      await assertDictateState(page, 'listening', /^listening\./i)
      await capturePage(page, 'dictate-listening-light.png', { theme: 'light' })
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      await assertDictateState(page, 'success', /^pasted into sotto\.$/i)
      await capturePage(page, 'dictate-pasted-light.png', { theme: 'light' })
    })

    await withSotto({ onboardingComplete: true, scenario: 'transcription-failure', appearance: 'light' }, async ({ page }) => {
      await openPage(page, 'Dictate')
      await page.getByRole('button', { name: 'Start dictation' }).click()
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      await assertDictateState(page, 'error', /dictation needs attention/i)
      await capturePage(page, 'dictate-error-light.png', { theme: 'light' })
    })

    await withSotto({ onboardingComplete: true, motion: 'reduced', appearance: 'light' }, async ({ page }) => {
      await openPage(page, 'Dictate')
      await page.getByRole('button', { name: 'Start dictation' }).click()
      await assertDictateState(page, 'listening', /^listening\./i)
      await capturePage(page, 'dictate-reduced-motion-light.png', { reducedMotion: true, theme: 'light' })
    })

    await withSotto({ onboardingComplete: true, history: populatedHistory, appearance: 'light' }, async ({ page }) => {
      await openPage(page, 'Dictate')
      await expect(page.getByText(populatedHistory[0]!.text).first()).toBeVisible()
      await assertFocusPresentation(page.getByRole('searchbox', { name: 'Search transcripts' }))
      await capturePage(page, 'focus-input-light.png', { focusTarget: 'input', focus: true, theme: 'light' })
      await openJournalRow(page)
      await assertFocusPresentation(page.getByRole('button', { name: 'Delete saved transcript' }))
      await capturePage(page, 'focus-destructive-light.png', { focusTarget: 'destructive', focus: true, theme: 'light' })
      await page.getByRole('button', { name: 'Copy transcript' }).first().click()
      await expect(page.getByRole('status').filter({ hasText: 'Transcript copied' })).toBeAttached()
      await capturePage(page, 'dictate-journal-open-light.png', { theme: 'light' })

      await page.getByRole('link', { name: 'Settings' }).click()
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
      await assertRenderedRoom(page, 'light')
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Dictation', exact: true }).click()
      const pasteSwitch = page.getByRole('switch', { name: 'Automatic paste' })
      await pasteSwitch.scrollIntoViewIfNeeded()
      await assertFocusPresentation(pasteSwitch)
      await capturePage(page, 'focus-switch-light.png', { focusTarget: 'switch', focus: true, theme: 'light' })
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Dictation', exact: true }).click()
      await page.getByRole('switch', { name: 'Sound cues' }).click()
      // The microphone test card carries a status of its own on this section, so the notice is named by its class.
      await expect(page.locator('.settings-notice')).toHaveText('Setting saved.')
      await startSettingsAtHeading(page)
      await capturePage(page, 'settings-feedback-light.png', { theme: 'light' })
      for (const [heading, state] of [
        ['Providers', 'providers'],
        ['Dictation', 'capture'],
        ['Appearance', 'appearance'],
        ['Application', 'application-privacy'],
        ['Git & worktrees', 'git'],
      ] as const) {
        await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: heading, exact: true }).click()
        const section = page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
        // Appearance's Creature previews walk on a frame loop the capture's settling step cannot freeze: hold them still.
        if (state === 'appearance') await page.emulateMedia({ reducedMotion: 'reduce' })
        await captureSection(page, section, `settings-${state}-light.png`, { category: 'settings', state, theme: 'light' })
        if (state === 'appearance') await page.emulateMedia({ reducedMotion: null })
      }
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Dictation', exact: true }).click()
      await page.getByLabel('Paste delay').fill('10')
      await page.getByLabel('Paste delay').press('Tab')
      await expect(page.getByText('Enter a whole number between 50 and 1000.')).toBeVisible()
      await capturePage(page, 'settings-validation-error-light.png', { theme: 'light' })
      await page.getByRole('link', { name: 'Help' }).click()
      await expect(page.getByRole('heading', { name: 'Help' })).toBeVisible()
      await captureFullSurface(page, page.locator('.help-view'), 'help-light.png', /Reset safely/i, { theme: 'light' })
    })

    await withSotto({ onboardingComplete: true, history: populatedHistory }, async ({ page }) => {
      await openPage(page, 'Dictate')
      await assertDictateState(page, 'idle', /ready when you are/i)
      for (const theme of appThemes) {
        for (const builtIn of DESIGN_CAPTURE_BUILT_IN_THEMES.filter(candidate => candidate !== DESIGN_CAPTURE_DEFAULT_THEME)) {
          await setAppearance(page, { appearance: theme, lightTheme: builtIn, darkTheme: builtIn }, theme)
          await assertRenderedRoom(page, theme)
          await capturePage(page, `theme-${builtIn}-${theme}.png`, { category: 'appearance', state: `theme-${builtIn}`, theme })
        }
      }

      // System follows the scheme Windows reports, live, without a relaunch.
      await page.getByRole('link', { name: 'Settings' }).click()
      await page.emulateMedia({ colorScheme: 'light' })
      await setAppearance(page, { appearance: 'system', lightTheme: DESIGN_CAPTURE_DEFAULT_THEME, darkTheme: DESIGN_CAPTURE_DEFAULT_THEME }, 'light')
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Appearance', exact: true }).click()
      const section = page.locator('#settings-appearance')
      // The Creature previews walk on a frame loop the capture's settling step cannot freeze: hold them still.
      await page.emulateMedia({ reducedMotion: 'reduce' })
      for (const theme of ['dark', 'light'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        await expect(section.getByRole('radio', { name: /^Match (Windows|macOS)$/u })).toHaveAttribute('aria-checked', 'true')
        await assertRenderedRoom(page, theme)
        await captureSection(page, section, `appearance-system-${theme}.png`, { category: 'appearance', state: 'system-settings', theme })
      }
    })

    await withSotto({ memory: true, onboardingComplete: true, history: populatedHistory }, async (launched) => {
      const { page } = launched
      await openPage(page, 'Dictate')
      await setMainWindowWidth(launched, DESIGN_CAPTURE_MINIMUM_WIDTH)
      for (const theme of appThemes) {
        if (theme === 'light') await setAppearance(page, { appearance: 'light' }, 'light')
        await page.getByRole('tab', { name: 'Dictate', exact: true }).click()
        await assertDictateState(page, 'idle', /ready when you are/i)
        await capturePage(page, `width-${DESIGN_CAPTURE_MINIMUM_WIDTH}-dictate-${theme}.png`, { theme })
        await page.getByRole('link', { name: 'Settings' }).click()
        await captureFullSurface(page, page.locator('.settings-view'), `width-${DESIGN_CAPTURE_MINIMUM_WIDTH}-settings-${theme}.png`, /^Application$/i, { theme })
      }
    })
  })
})
