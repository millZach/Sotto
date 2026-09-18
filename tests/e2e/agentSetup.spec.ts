import { expect, test } from '@playwright/test'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { closeSotto, launchSottoWithVoice } from './support/sottoLaunch'

test('failed connection leaves one actionable error and allows a successful retry', async () => {
  const launched = await launchSottoWithVoice()
  const { page } = launched
  try {
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: /test microphone/i }).click()
    await expect(page.getByText(/microphone ready/i)).toBeVisible()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: /finish setup/i }).click()
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    await page.getByRole('button', { name: 'Not now', exact: true }).click()
    const error = 'Codex could not be found. Install it and sign in, then reconnect.'
    await page.evaluate(async message => {
      await (globalThis as unknown as { sottoE2E: SottoE2EBridge }).sottoE2E.agentEvent?.({ type: 'connect-reject', threadId: '', text: message })
    }, error)
    await page.getByRole('button', { name: 'Connect providers', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText(error)
    await expect(page.getByRole('button', { name: 'Connect providers', exact: true })).toBeEnabled()
    await expect(page.getByText(error, { exact: true })).toHaveCount(1)
    await page.screenshot({ path: 'artifacts/agent-control-smoke/connection-failed-e2e.png' })
    await page.getByRole('button', { name: 'Connect providers', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('Codex connected')
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.screenshot({ path: 'artifacts/agent-control-smoke/connection-retry-e2e.png' })
  } finally { await closeSotto(launched) }
})
