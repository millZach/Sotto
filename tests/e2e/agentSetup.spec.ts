import { expect, test } from '@playwright/test'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { closeSotto, launchSotto } from './support/sottoLaunch'

test('failed connection leaves one actionable error and allows a successful retry', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: /test microphone/i }).click()
    await expect(page.getByText(/microphone ready/i)).toBeVisible()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: /finish setup/i }).click()
    await page.getByRole('link', { name: 'Agents', exact: true }).click()
    const error = 'Codex could not be found. Install it and sign in, then reconnect.'
    await page.evaluate(async message => {
      await (globalThis as unknown as { sottoE2E: SottoE2EBridge }).sottoE2E.agentEvent?.({ type: 'connect-reject', threadId: '', text: message })
    }, error)
    await page.getByRole('button', { name: 'Connect Codex', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText(error)
    await expect(page.getByRole('button', { name: 'Connect Codex', exact: true })).toBeEnabled()
    await expect(page.getByText(error, { exact: true })).toHaveCount(1)
    await page.getByRole('button', { name: 'Connect Codex', exact: true }).click()
    await expect(page.getByText('Codex connected · fixture', { exact: true })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
  } finally { await closeSotto(launched) }
})
