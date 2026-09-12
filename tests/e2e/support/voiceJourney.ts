import { expect, type Page } from '@playwright/test'

export async function completeVoiceJourneySetup(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: /test microphone/i }).click()
  await expect(page.getByText(/microphone ready/i)).toBeVisible()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: /finish setup/i }).click()
}

/** Working preferences are offered again after each renderer restart. */
export async function openVoiceJourneyAgents(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: 'Not now', exact: true }).click()
}
