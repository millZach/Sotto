import { expect, test } from '@playwright/test'

import { E2E_TRANSCRIPT } from '../../src/shared/e2e'
import { populatedHistory, withSotto } from '../fixtures/designCaptureProfile'
import { assertDictateState, assertFocusPresentation, captureFullSurface, capturePage, captureSection, startSettingsAtHeading } from './support/designCapture'
import { openJournalRow, openPage, reachSetupStop, setupForwardButton, setupNote, skipSetup } from './support/sottoLaunch'

const captureEnabled = process.env.SOTTO_DESIGN_CAPTURE === '1'

test.describe('authoritative design-review captures', () => {
  test.skip(!captureEnabled, 'Run through npm run design:capture or npm run design:verify')
  test.describe.configure({ mode: 'serial', timeout: 10 * 60_000 })

  test('first-run setup, dictate, focus, and feedback matrix', async () => {
    await withSotto({ onboardingComplete: false }, async ({ page }) => {
      // First-run setup is a walk of notes over the real pages (ADR-0200); each stop is captured as the whole window.
      const welcomeHeading = setupNote(page).getByRole('heading', { name: /talk to your computer and your coding agents/i })
      await expect(welcomeHeading).toBeVisible()
      expect(await welcomeHeading.evaluate((heading: unknown) => (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement === heading)).toBe(true)
      expect(await welcomeHeading.evaluate((heading: unknown) => (globalThis as unknown as { getComputedStyle: (target: unknown) => { outlineStyle: string } }).getComputedStyle(heading).outlineStyle)).toBe('none')
      await expect(setupNote(page).getByRole('radiogroup', { name: 'Appearance' })).toBeVisible()
      await capturePage(page, 'setup-welcome.png', { category: 'setup', state: 'welcome' })

      const start = setupForwardButton(page)
      await expect(start).toHaveText('Start')
      await assertFocusPresentation(start)
      await start.click()
      await expect(setupNote(page).getByRole('heading', { name: 'Sign in to a coding agent' })).toBeVisible()
      await capturePage(page, 'setup-agents.png', { category: 'setup', state: 'agents' })

      await reachSetupStop(page, 'microphone')
      await page.locator('.settings-microphone-test').getByRole('button', { name: 'Test microphone', exact: true }).click()
      await expect(setupNote(page)).toContainText('Sotto heard you. Your microphone works.')
      await capturePage(page, 'setup-microphone.png', { category: 'setup', state: 'microphone' })

      await reachSetupStop(page, 'speech-model')
      await expect(setupNote(page).getByRole('heading', { name: 'Choose a speech model' })).toBeVisible()
      await capturePage(page, 'setup-speech-model.png', { category: 'setup', state: 'speech-model' })

      await reachSetupStop(page, 'shortcut')
      await expect(setupNote(page).getByRole('heading', { name: 'Try the shortcut' })).toBeVisible()
      await capturePage(page, 'setup-shortcut.png', { category: 'setup', state: 'shortcut' })

      await reachSetupStop(page, 'tailscale')
      await expect(setupNote(page).getByRole('heading', { name: 'Tailscale joins your devices' })).toBeVisible()
      await capturePage(page, 'setup-tailscale.png', { category: 'setup', state: 'tailscale' })

      await reachSetupStop(page, 'computers')
      await expect(setupNote(page).getByRole('heading', { name: 'Run threads on another computer' })).toBeVisible()
      await capturePage(page, 'setup-computers.png', { category: 'setup', state: 'computers' })

      await reachSetupStop(page, 'iphone')
      await expect(setupNote(page).getByRole('heading', { name: 'Answer threads from your iPhone' })).toBeVisible()
      await capturePage(page, 'setup-iphone.png', { category: 'setup', state: 'iphone' })

      await reachSetupStop(page, 'end')
      await expect(setupNote(page).getByRole('heading', { name: 'That’s setup' })).toBeVisible()
      await capturePage(page, 'setup-end.png', { category: 'setup', state: 'end' })

      // Done ends the walk on the Threads page, with no tour after it.
      await skipSetup(page)
    })

    await withSotto({ memory: true, onboardingComplete: true, history: populatedHistory }, async ({ page }) => {
      await openPage(page, 'Dictate')
      await assertDictateState(page, 'idle', /ready when you are/i)
      // Dictate seats the Threads sidebar beside the room; the switch lives in the sidebar foot, not a strip.
      await expect(page.locator('.app-strip')).toHaveCount(0)
      await expect(page.getByRole('complementary', { name: 'Thread sidebar' })).toBeVisible()
      await expect(page.getByRole('tab', { name: 'Dictate' })).toHaveAttribute('aria-selected', 'true')
      await capturePage(page, 'dictate-ready.png', { category: 'dictate', state: 'ready' })

      const threadsTab = page.getByRole('tab', { name: 'Threads' })
      await assertFocusPresentation(threadsTab)
      await capturePage(page, 'focus-switch-tab.png', { focusTarget: 'tab', focus: true })

      const settingsNavigation = page.getByRole('link', { name: 'Settings' })
      await assertFocusPresentation(settingsNavigation)
      await capturePage(page, 'focus-navigation.png', { focusTarget: 'navigation', focus: true })

      await page.getByRole('button', { name: 'Start dictation' }).click()
      await assertDictateState(page, 'listening', /^listening\./i)
      await capturePage(page, 'dictate-listening.png', { category: 'dictate', state: 'listening' })
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      await expect.poll(() => page.evaluate(() => window.sottoE2E!.snapshot())).toMatchObject({
        clipboardText: E2E_TRANSCRIPT, pasteAttempts: 1,
      })
      await assertDictateState(page, 'idle', /ready when you are/i)
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

    await withSotto({ onboardingComplete: true, history: populatedHistory }, async ({ page }) => {
      await openPage(page, 'Dictate')
      await expect(page.getByText(populatedHistory[0]!.text).first()).toBeVisible()
      const journalSearch = page.getByRole('searchbox', { name: 'Search transcripts' })
      await assertFocusPresentation(journalSearch)
      await capturePage(page, 'focus-input.png', { focusTarget: 'input', focus: true })
      await openJournalRow(page)
      await assertFocusPresentation(page.getByRole('button', { name: 'Delete saved transcript' }))
      await capturePage(page, 'focus-destructive.png', { focusTarget: 'destructive', focus: true })
      await page.getByRole('button', { name: 'Copy transcript' }).first().click()
      await expect(page.getByRole('status').filter({ hasText: 'Transcript copied' })).toBeAttached()
      await capturePage(page, 'dictate-journal-open.png', { category: 'dictate', state: 'journal-open-feedback' })
      await page.keyboard.press('Escape')

      await page.getByRole('button', { name: 'More transcript actions' }).click()
      await expect(page.getByRole('menuitem', { name: 'Clear history' })).toBeFocused()
      await capturePage(page, 'dictate-journal-more.png', { category: 'dictate', state: 'journal-more-menu' })
      await page.keyboard.press('Escape')

      await journalSearch.fill('installer')
      await capturePage(page, 'dictate-journal-search.png', { category: 'dictate', state: 'journal-search' })
      await journalSearch.fill('')
      await page.evaluate(async () => { await window.sotto!.updateSettings({ historyEnabled: false }) })
      await expect(page.getByText(/^History is off\./)).toBeVisible()
      await capturePage(page, 'dictate-journal-off.png', { category: 'dictate', state: 'journal-off' })
      await page.evaluate(async () => { await window.sotto!.updateSettings({ historyEnabled: true }) })
      await page.getByRole('button', { name: 'More transcript actions' }).click()
      await page.getByRole('menuitem', { name: 'Clear history' }).click()
      await page.getByRole('button', { name: 'Clear all transcripts' }).click()
      await expect(page.getByRole('heading', { name: 'Nothing here yet.' })).toBeVisible()
      await capturePage(page, 'dictate-journal-empty.png', { category: 'dictate', state: 'journal-empty-feedback' })

      await page.getByRole('link', { name: 'Settings' }).click()
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Dictation', exact: true }).click()
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

      // Each capture is a page, or a group on Dictation where Transcription and Output were pages of their own: the
      // group keeps the old page's id and its capture keeps the old name.
      const settingsSections = [
        ['Providers', 'providers', null],
        ['Threads', 'agents', null],
        ['Dictation', 'capture', null],
        ['Dictation', 'transcription', '#settings-transcription'],
        ['Cleanup', 'cleanup', null],
        ['Dictation', 'output', '#settings-output'],
        ['Appearance', 'appearance', null],
        ['Application', 'application-privacy', null],
        ['Git & worktrees', 'git', null],
      ] as const
      for (const [heading, state, group] of settingsSections) {
        const tab = page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: heading, exact: true })
        await tab.click()
        await expect(tab).toHaveAttribute('aria-selected', 'true')
        const section = group === null
          ? page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
          : page.locator(group)
        await expect(section).toHaveCount(1)
        if (state === 'agents') {
          await expect(section.getByRole('button', { name: /^(Choose|Change) the default projects directory on this computer$/ })).toBeVisible()
          await capturePage(page, 'settings-agents.png', { category: 'settings', state })
          continue
        }
        // Appearance's Creature previews walk on a frame loop the capture's settling step cannot freeze: hold them still.
        if (state === 'appearance') await page.emulateMedia({ reducedMotion: 'reduce' })
        await captureSection(page, section, `settings-${state}.png`, { category: 'settings', state })
        if (state === 'appearance') await page.emulateMedia({ reducedMotion: null })
      }

      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Cleanup', exact: true }).click()
      await page.getByRole('button', { name: 'Verify key', exact: true }).click()
      await expect(page.getByText('Key verified.')).toBeVisible()
      await capturePage(page, 'settings-key-verified.png')
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Dictation', exact: true }).click()
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
