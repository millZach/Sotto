import { expect, test } from '@playwright/test'

import { populatedHistory, withSotto } from '../fixtures/designCaptureProfile'
import { assertFocusPresentation, startSettingsAtHeading, assertDictateState, capturePage, captureSection, captureFullSurface } from './support/designCapture'
import { openPage } from './support/sottoLaunch'

const captureEnabled = process.env.SOTTO_DESIGN_CAPTURE === '1'

test.describe('authoritative design-review captures', () => {
  test.skip(!captureEnabled, 'Run through npm run design:capture or npm run design:verify')
  test.describe.configure({ mode: 'serial', timeout: 10 * 60_000 })

  test('onboarding, dictate, focus, and feedback matrix', async () => {
    await withSotto({ onboardingComplete: false }, async ({ page }) => {
      const onboarding = page.locator('.onboarding-shell')
      const forward = page.locator('.onboarding-actions').getByRole('button', { name: /^(Continue|Skip for now)$/ })
      const onboardingHeading = page.getByRole('heading', { name: /talk to your computer and your coding agents/i })
      await expect(onboardingHeading).toBeVisible()
      expect(await onboardingHeading.evaluate((heading: unknown) => (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement === heading)).toBe(true)
      expect(await onboardingHeading.evaluate((heading: unknown) => (globalThis as unknown as { getComputedStyle: (target: unknown) => { outlineStyle: string } }).getComputedStyle(heading).outlineStyle)).toBe('none')
      await captureSection(page, onboarding, 'onboarding-step-1-welcome.png', { category: 'onboarding', state: 'welcome' })

      const getStarted = page.getByRole('button', { name: 'Get started' })
      await assertFocusPresentation(getStarted)
      await getStarted.click()
      await expect(page.getByRole('heading', { name: /choose how sotto looks/i })).toBeVisible()
      await captureSection(page, onboarding, 'onboarding-step-2-look.png', { category: 'onboarding', state: 'look' })

      await forward.click()
      await page.getByRole('button', { name: /test microphone/i }).click()
      await expect(page.getByText('Sotto heard you. Your microphone works.')).toBeVisible()
      await captureSection(page, onboarding, 'onboarding-step-3-microphone-ready.png', { category: 'onboarding', state: 'microphone-ready' })

      await forward.click()
      await expect(page.getByText(/connect your openrouter key/i)).toBeVisible()
      await captureSection(page, onboarding, 'onboarding-step-4-openrouter.png', { category: 'onboarding', state: 'openrouter-key' })

      await forward.click()
      await expect(page.getByRole('heading', { name: /one shortcut/i })).toBeVisible()
      await captureSection(page, onboarding, 'onboarding-step-5-shortcut.png', { category: 'onboarding', state: 'shortcut-paste' })

      await forward.click()
      await expect(page.getByRole('heading', { name: 'Your coding agents', exact: true })).toBeVisible()
      await captureSection(page, onboarding, 'onboarding-step-6-agents.png', { category: 'onboarding', state: 'coding-agents' })

      await forward.click()
      await expect(page.getByRole('heading', { name: /choose a project folder/i })).toBeVisible()
      await captureSection(page, onboarding, 'onboarding-step-7-project.png', { category: 'onboarding', state: 'first-project' })

      await forward.click()
      await expect(page.getByRole('heading', { name: /run agents on another computer/i })).toBeVisible()
      await captureSection(page, onboarding, 'onboarding-step-8-computers.png', { category: 'onboarding', state: 'other-computers' })

      await forward.click()
      await expect(page.getByRole('heading', { name: /answer your threads from your iphone/i })).toBeVisible()
      await captureSection(page, onboarding, 'onboarding-step-9-phone.png', { category: 'onboarding', state: 'iphone' })

      await page.getByRole('button', { name: /finish setup/i }).click()
      await expect(page.getByRole('complementary', { name: /Thread sidebar|Terminal sidebar/ })).toBeVisible()
      const tour = page.locator('.threads-tour')
      await expect(tour).toBeVisible()
      await capturePage(page, 'threads-tour-projects.png', { category: 'threads', state: 'tour-projects' })
      await tour.getByRole('button', { name: 'Skip tour' }).click()
      await expect(tour).toHaveCount(0)
    })

    await withSotto({ voice: true, onboardingComplete: true, history: populatedHistory }, async ({ page }) => {
      await openPage(page, 'Dictate')
      await assertDictateState(page, 'idle', /ready when you are/i)
      // Dictate seats the Threads sidebar beside the room; the switch lives in the sidebar foot, not a strip.
      await expect(page.locator('.app-strip')).toHaveCount(0)
      await expect(page.getByRole('complementary', { name: 'Thread sidebar' })).toBeVisible()
      await expect(page.getByRole('tab', { name: 'Dictate' })).toHaveAttribute('aria-selected', 'true')
      await capturePage(page, 'dictate-ready.png', { category: 'dictate', state: 'ready' })

      const agentsTab = page.getByRole('tab', { name: 'Agents' })
      await assertFocusPresentation(agentsTab)
      await capturePage(page, 'focus-switch-tab.png', { focusTarget: 'tab', focus: true })

      const historyNavigation = page.getByRole('link', { name: 'History' })
      await assertFocusPresentation(historyNavigation)
      await capturePage(page, 'focus-navigation.png', { focusTarget: 'navigation', focus: true })

      await page.getByRole('button', { name: 'Start dictation' }).click()
      await assertDictateState(page, 'listening', /^listening\./i)
      await capturePage(page, 'dictate-listening.png', { category: 'dictate', state: 'listening' })
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      await assertDictateState(page, 'success', /^pasted\.$/i)
      await capturePage(page, 'dictate-pasted.png', { category: 'dictate', state: 'success-pasted' })
    })

    await withSotto({ onboardingComplete: true, scenario: 'design-processing' }, async ({ page }) => {
      await openPage(page, 'Dictate')
      await page.getByRole('button', { name: 'Start dictation' }).click()
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      await assertDictateState(page, 'processing', /turning speech into text/i)
      await capturePage(page, 'dictate-processing.png', { category: 'dictate', state: 'processing' })
    })

    await withSotto({ onboardingComplete: true, scenario: 'transcription-failure' }, async ({ page }) => {
      await openPage(page, 'Dictate')
      await page.getByRole('button', { name: 'Start dictation' }).click()
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      await assertDictateState(page, 'error', /dictation needs attention/i)
      await capturePage(page, 'dictate-error.png', { category: 'dictate', state: 'error' })
    })

    await withSotto({ onboardingComplete: true, motion: 'reduced' }, async ({ page }) => {
      await openPage(page, 'Dictate')
      await page.getByRole('button', { name: 'Start dictation' }).click()
      await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
      await assertDictateState(page, 'listening', /^listening\./i)
      await capturePage(page, 'dictate-reduced-motion.png', { category: 'dictate', state: 'listening-reduced-motion', reducedMotion: true })
    })

    await withSotto({ voice: true, onboardingComplete: true }, async ({ page }) => {
      await page.getByRole('tab', { name: 'Agents' }).click()
      await page.getByRole('button', { name: 'Not now', exact: true }).click()
      await expect(page.locator('.agent-orb')).toBeVisible()
      await expect(page.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true')
      await capturePage(page, 'agents-room.png', { category: 'agents', state: 'overview' })
    })

    await withSotto({ onboardingComplete: true, history: populatedHistory }, async ({ page }) => {
      await page.getByRole('link', { name: 'History' }).click()
      await expect(page.getByText(populatedHistory[0]!.text).first()).toBeVisible()
      const historySearch = page.getByRole('searchbox', { name: 'Search transcripts' })
      await assertFocusPresentation(historySearch)
      await capturePage(page, 'focus-input.png', { focusTarget: 'input', focus: true })
      const clearHistory = page.getByRole('button', { name: 'Clear history' })
      await assertFocusPresentation(clearHistory)
      await capturePage(page, 'focus-destructive.png', { focusTarget: 'destructive', focus: true })
      await page.locator('.history-entry__toggle').first().click()
      await page.getByRole('button', { name: 'Copy transcript' }).first().click()
      await expect(page.getByRole('status')).toContainText('Transcript copied')
      await capturePage(page, 'history-populated.png', { category: 'history', state: 'populated-feedback' })

      await historySearch.fill('installer')
      await capturePage(page, 'history-search.png')
      await historySearch.fill('')
      await page.getByRole('button', { name: 'Clear history' }).click()
      await page.getByRole('button', { name: 'Clear all transcripts' }).click()
      await expect(page.getByRole('heading', { name: 'Nothing here yet.' })).toBeVisible()
      await capturePage(page, 'history-empty.png', { category: 'history', state: 'empty-feedback' })
      await page.evaluate(async () => { await window.sotto!.updateSettings({ historyEnabled: false }) })
      await capturePage(page, 'history-off.png')
      await page.evaluate(async () => { await window.sotto!.updateSettings({ historyEnabled: true }) })

      await page.getByRole('link', { name: 'Settings' }).click()
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Output', exact: true }).click()
      const pasteSwitch = page.getByRole('switch', { name: 'Automatic paste' })
      await pasteSwitch.scrollIntoViewIfNeeded()
      await assertFocusPresentation(pasteSwitch)
      await capturePage(page, 'focus-switch.png', { focusTarget: 'switch', focus: true })
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Dictation', exact: true }).click()
      await page.getByRole('switch', { name: 'Sound cues' }).click()
      // The microphone test card carries a status of its own on this section, so the notice is named by its class.
      await expect(page.locator('.settings-notice')).toHaveText('Setting saved.')
      await startSettingsAtHeading(page)
      await capturePage(page, 'settings-feedback.png', { category: 'settings', state: 'saved-feedback' })

      const settingsSections = [
        ['Providers', 'providers'],
        ['Agents', 'agents'],
        ['Dictation', 'capture'],
        ['Transcription', 'transcription'],
        ['Cleanup', 'cleanup'],
        ['Output', 'output'],
        ['Appearance', 'appearance'],
        ['Application', 'application-privacy'],
        ['Git', 'git'],
      ] as const
      for (const [heading, state] of settingsSections) {
        await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: heading, exact: true }).click()
        const section = page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
        await expect(section).toHaveCount(1)
        if (state === 'agents') {
          await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Agents', exact: true }).click()
          await expect(section.getByLabel('Reasoning account', { exact: true })).toBeVisible()
          await expect(page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Agents', exact: true })).toHaveAttribute('aria-selected', 'true')
          await capturePage(page, 'settings-agents.png', { category: 'settings', state })
          continue
        }
        await captureSection(page, section, `settings-${state}.png`, { category: 'settings', state })
      }

      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Transcription', exact: true }).click()
      await page.getByRole('button', { name: 'Verify key', exact: true }).click()
      await expect(page.getByText('Key verified.')).toBeVisible()
      await capturePage(page, 'settings-key-verified.png')
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Output', exact: true }).click()
      await page.getByLabel('Paste delay').fill('10')
      await page.getByLabel('Paste delay').press('Tab')
      await expect(page.getByText('Enter a whole number between 50 and 1000.')).toBeVisible()
      await capturePage(page, 'settings-validation-error.png', { category: 'settings', state: 'validation-error' })

      await page.getByRole('link', { name: 'Help' }).click()
      await expect(page.getByRole('heading', { name: 'Help' })).toBeVisible()
      await captureFullSurface(page, page.locator('.help-view'), 'help.png', /Reset safely/i)
    })
  })
})
