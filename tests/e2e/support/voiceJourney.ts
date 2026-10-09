import type { Page } from '@playwright/test'

import { finishFirstRunSetupFrom } from './sottoLaunch'

export async function completeVoiceJourneySetup(page: Page): Promise<void> {
  await finishFirstRunSetupFrom(page, 'welcome', { microphone: 'test' })
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
