import { expect, type Page } from '@playwright/test'

export async function completeVoiceJourneySetup(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: /test microphone/i }).click()
  await expect(page.getByText(/microphone ready/i)).toBeVisible()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: /finish setup/i }).click()
}

/**
 * Working preferences are offered again after each renderer restart. The Agents
 * tab only exists once `voiceCoordinatorEnabled` is on, so a caller has to seed
 * that setting into the profile — `enableVoiceCoordinator` or
 * `launchSottoWithVoice` — before the window opens.
 */
export async function openVoiceJourneyAgents(page: Page): Promise<void> {
  // The switch is the strip's Mode tablist on most pages and the sidebar foot's Page tablist on Threads, which is where a cold start lands.
  await page.getByRole('tablist', { name: /^(Mode|Page)$/ }).getByRole('tab', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: 'Not now', exact: true }).click()
}
