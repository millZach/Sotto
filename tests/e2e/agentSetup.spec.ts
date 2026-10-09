import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openThreads } from './support/sottoLaunch'

test('failed connection leaves one actionable error and allows a successful retry', async () => {
  // First-run setup's Coding agents step connects the providers it finds, so Threads is still disconnected
  // only on a profile that finished setup before; this one starts there.
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-agent-setup-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true }))
  const launched = await launchSotto('success', profile)
  const { page } = launched
  try {
    await openThreads(page)
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
  } finally {
    await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})
