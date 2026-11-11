import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { closeSotto, launchSotto, openPage, reachSetupStop, resizeWindow, setupForwardButton, setupNote, skipSetup } from './support/sottoLaunch'

/**
 * First-run setup's microphone stop lights Settings' own microphone test (ADR-0200). Ending setup saves the microphone
 * as skipped unless that test opened the microphone during the walk, and the walk stops the test as it moves on.
 */
for (const skip of [false, true]) {
  test(`setup's microphone stop decides whether the microphone is skipped (${skip ? 'access refused' : 'test heard a voice'})`, async () => {
    test.setTimeout(120_000)
    const launched = await launchSotto(skip ? 'microphone-denied-once' : 'success')
    const { page } = launched
    const evidence = evidenceDirectory('artifacts/review-386')
    await mkdir(evidence, { recursive: true })
    try {
      await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'on' }))
      await reachSetupStop(page, 'microphone')
      const next = setupForwardButton(page)
      const microphoneTest = page.locator('.settings-microphone-test')
      const testButton = microphoneTest.getByRole('button', { name: 'Test microphone', exact: true })
      await expect(next).toHaveText('Skip for now')
      await expect(setupNote(page)).toContainText('Sotto opens the microphone only while you dictate or run this test.')
      if (skip) {
        // A refused test never opens the microphone, so moving on is still a skip.
        await testButton.click()
        await expect(microphoneTest).toHaveAttribute('data-state', 'denied')
        await expect(next).toHaveText('Skip for now')
        await expect(testButton).toBeEnabled()
      }
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
          await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
          await next.scrollIntoViewIfNeeded()
          await expect(next).toBeInViewport()
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          await page.screenshot({ path: resolve(evidence, `${skip ? 'denied' : 'untested'}-${width}-${appearance}.png`) })
        }
      }
      // From the keyboard: the lit test and the note's way forward each answer Enter.
      if (!skip) {
        await testButton.focus()
        await page.keyboard.press('Enter')
        await expect(microphoneTest).toHaveAttribute('data-heard', 'true')
        await expect(setupNote(page)).toContainText('Sotto heard you. Your microphone works.')
        await expect(next).toHaveText('Continue')
        await expect(microphoneTest).toHaveAttribute('data-state', 'ready')
      }
      await next.focus()
      await page.keyboard.press('Enter')
      // Each note takes focus as it arrives, and Settings' test, on the same page, is stopped once the walk moves on.
      await expect(setupNote(page).getByRole('heading', { name: 'Choose a speech model' })).toBeFocused()
      await expect(microphoneTest).not.toHaveAttribute('data-state', 'ready')
      await setupNote(page).getByRole('button', { name: 'Back', exact: true }).click()
      await expect(setupNote(page).getByRole('heading', { name: 'Check your microphone' })).toBeFocused()
      await reachSetupStop(page, 'shortcut')
      await expect(setupNote(page).getByRole('heading', { name: 'Try the shortcut' })).toBeFocused()
      await skipSetup(page)
      expect(await page.evaluate(async () => {
        const settings = await window.sotto!.getSettings()
        return { completed: settings.onboardingComplete, skipped: settings.microphoneSkipped, key: settings.llmApiKey }
      })).toEqual({ completed: true, skipped: skip, key: '' })
      // A microphone setup never opened is what Dictate asks for before it offers a start. At the smallest window the
      // sidebar is a rail, which has no room switch, so the window is given room first.
      await resizeWindow(launched, 1280, 800)
      await openPage(page, 'Dictate')
      if (skip) {
        await expect(page.getByRole('heading', { level: 1, name: 'No microphone is set up.' })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Microphone needed', exact: true })).toBeDisabled()
      } else {
        await expect(page.getByRole('heading', { level: 1, name: 'Ready when you are.' })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Microphone needed', exact: true })).toHaveCount(0)
      }
      await page.reload()
      await expect(page.getByRole('complementary', { name: 'Thread sidebar', exact: true })).toBeVisible()
      await expect(page.locator('.setup-walk')).toHaveCount(0)
    } finally { await closeSotto(launched) }
  })
}

test('Settings’ microphone test at setup’s microphone stop notices an ended microphone, allows retry, and closes when the walk moves on', async () => {
  const launched = await launchSotto('microphone-browser')
  const { page } = launched
  const evidence = evidenceDirectory('artifacts/pkg-18-e2e/onboarding')
  await mkdir(evidence, { recursive: true })
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ reducedMotion: 'on' })
      const context = new AudioContext()
      const streams: MediaStream[] = []
      Object.assign(window, { onboardingMicrophoneFixture: { context, streams } })
      navigator.mediaDevices.getUserMedia = async () => {
        const stream = context.createMediaStreamDestination().stream
        streams.push(stream)
        return stream
      }
    })
    const tracksEnded = (index: number): Promise<boolean> => page.evaluate(at => (window as unknown as { onboardingMicrophoneFixture: { streams: MediaStream[] } }).onboardingMicrophoneFixture.streams[at]!.getTracks().every(track => track.readyState === 'ended'), index)
    await reachSetupStop(page, 'microphone')
    const next = setupForwardButton(page)
    const microphoneTest = page.locator('.settings-microphone-test')
    const testButton = microphoneTest.getByRole('button', { name: 'Test microphone', exact: true })
    await testButton.click()
    // The fixture's stream is silent, so the test keeps listening with the stream open.
    await expect(microphoneTest.getByText('Listening. Say something.')).toBeVisible()
    await page.evaluate(() => {
      const fixture = (window as unknown as { onboardingMicrophoneFixture: { streams: MediaStream[] } }).onboardingMicrophoneFixture
      fixture.streams[0]!.getTracks()[0]!.dispatchEvent(new Event('ended'))
    })
    await expect(microphoneTest.getByText('No microphone was found.', { exact: true })).toBeVisible()
    await expect(microphoneTest).toHaveAttribute('data-state', 'missing')
    await expect(microphoneTest.getByRole('meter', { name: 'Microphone level' })).toHaveCount(0)
    await expect(microphoneTest.locator('.voice-wave')).toHaveAttribute('data-stage', 'idle')
    await expect(next).toHaveText('Skip for now')
    expect(await tracksEnded(0)).toBe(true)
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        await testButton.scrollIntoViewIfNeeded()
        await expect(testButton).toBeInViewport()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: resolve(evidence, `ended-${width}-${appearance}.png`) })
      }
    }
    await testButton.focus()
    await page.keyboard.press('Enter')
    await expect(microphoneTest.getByText('Listening. Say something.')).toBeVisible()
    // Access is confirmed but nothing was heard, so moving on is still a skip.
    await expect(next).toHaveText('Skip for now')
    await next.click()
    await expect(setupNote(page).getByRole('heading', { name: 'Choose a speech model' })).toBeFocused()
    // Moving on closed the microphone the test opened.
    await expect(microphoneTest).not.toHaveAttribute('data-state', 'ready')
    await expect.poll(() => tracksEnded(1)).toBe(true)
    await page.evaluate(async () => {
      await (window as unknown as { onboardingMicrophoneFixture: { context: AudioContext } }).onboardingMicrophoneFixture.context.close()
    })
  } finally { await closeSotto(launched) }
})
