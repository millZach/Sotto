import { expect, test } from '@playwright/test'
import { closeSotto, completeFirstRunSetup, launchSotto, openPage, openThreads } from './support/sottoLaunch'

test('Crossing keeps dictation, history, settings and sessions usable', async () => {
  const launched = await launchSotto()
  const { page } = launched
  page.setDefaultTimeout(5_000)
  try {
    await completeFirstRunSetup(page, { microphone: 'test' })
    // Onboarding hands over to Threads now, so dictation is a deliberate stop.
    await openPage(page, 'Dictate')
    await page.screenshot({ animations: 'disabled', path: 'artifacts/crossing/dictate.png' })
    await page.getByRole('button', { name: 'Start dictation', exact: true }).click()
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await page.getByRole('link', { name: 'History', exact: true }).click()
    await expect(page.locator('.history-entry')).toHaveCount(1)
    await page.locator('.history-entry__toggle').click()
    await page.getByRole('button', { name: 'Copy transcript', exact: true }).click()
    await expect(page.getByText('Transcript copied.', { exact: true })).toBeAttached()
    await page.screenshot({ animations: 'disabled', path: 'artifacts/crossing/history.png' })
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Dictation', exact: true })).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: 'artifacts/crossing/settings.png' })
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Output', exact: true }).click()
    await page.getByLabel('Paste delay', { exact: true }).fill('10')
    await page.getByLabel('Paste delay', { exact: true }).press('Tab')
    await expect(page.getByText(/between 50 and 1000/i)).toBeVisible()
    await page.getByLabel('Paste delay', { exact: true }).fill('250')
    await page.getByLabel('Paste delay', { exact: true }).press('Tab')
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).pasteDelayMs)).toBe(250)
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Agents', exact: true }).click()
    const coordinator = page.locator('#settings-agents')
    await expect(coordinator.getByLabel('Default projects directory', { exact: true })).toBeVisible()
    await page.getByRole('link', { name: 'Help', exact: true }).click()
    await page.screenshot({ animations: 'disabled', path: 'artifacts/crossing/help.png' })
    await page.keyboard.press('Control+k')
    await expect(page.getByRole('searchbox', { name: 'Search transcripts' })).toBeFocused()
    await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    await page.getByLabel('Prompt', { exact: true }).fill('Keep this draft until I explicitly send it.')
    await openPage(page, 'Dictate')
    await openThreads(page)
    await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue('Keep this draft until I explicitly send it.')
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(page.getByLabel('Thread transcript')).toContainText('Keep this draft until I explicitly send it.')
    await page.getByRole('button', { name: 'New thread', exact: true }).click()
    const newThread = page.getByRole('dialog', { name: 'New thread', exact: true })
    await expect(newThread).toBeVisible()
    // Choosing the project opens the thread at once, on the defaults from Settings → Agents, with no form after it (#347).
    await newThread.getByRole('button', { name: /^Sotto test / }).click()
    await expect(newThread).toHaveCount(0)
    await expect(page.locator('form.thread-prompt').first()).toBeVisible()
    // The page still names itself for assistive technology; the heading is no longer drawn.
    await expect(page.getByRole('heading', { name: 'Threads', exact: true })).toBeAttached()
  } catch (error) {
    await page.screenshot({ path: 'artifacts/crossing/failure.png' }).catch(() => undefined)
    throw error
  } finally { await closeSotto(launched) }
})
