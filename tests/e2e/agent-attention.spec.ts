import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { defaultAgentConfiguration } from '../../src/shared/agents'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto } from './support/sottoLaunch'

test('saved attention does not cover the room while its provider is disconnected', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-attention-'))
  const savedQueue = [{ id: 'old-update', threadId: 'missing-thread', kind: 'ready', text: 'Saved update from a previous connection.', createdAt: new Date().toISOString(), deferred: false }]
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true }))
  await writeFile(join(profile, 'agents.json'), JSON.stringify({ configuration: defaultAgentConfiguration(), assignments: [], queue: savedQueue, activeThreadId: 'missing-thread', activeProjectId: null, draft: '', draftThreadId: null, draftRequestId: null, composing: false, pendingRequest: '', outbox: [] }))
  const launched = await launchSotto('success', profile)
  try {
    await launched.page.getByRole('tab', { name: 'Agents', exact: true }).click()
    await expect(launched.page.getByRole('button', { name: 'Connect T3 Code', exact: true })).toBeVisible()
    await expect(launched.page.getByRole('heading', { name: /Needs your attention/ })).toHaveCount(0)
    expect(await launched.page.evaluate(async () => (await window.sotto!.agents!.get()).queue)).toEqual(savedQueue)
    await launched.page.screenshot({ path: 'artifacts/crossing/attention-disconnected.png' })
  } finally {
    await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})

test('Later returns to the orb without answering a pending permission', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await page.evaluate(async () => { await window.sotto!.updateSettings({ onboardingComplete: true }); await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } }); await window.sotto!.agents!.command({ type: 'connect' }) })
    await page.reload()
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'assign', threadId: 'workshop' }); await window.sottoE2E!.agentEvent!({ type: 'permission', threadId: 'workshop', text: 'Allow this test change?' }) })
    await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
    const pending = await page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === 'workshop')!.requests)
    await page.getByRole('button', { name: 'Later', exact: true }).click()
    await expect(page.getByRole('heading', { name: /Needs your attention/ })).toHaveCount(0)
    expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === 'workshop')!.requests)).toEqual(pending)
    await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'configure', patch: { orbColor: 'violet' } }) })
    await expect(page.getByRole('heading', { name: /Needs your attention/ })).toHaveCount(0)
    await page.getByRole('link', { name: 'History', exact: true }).click()
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    await expect(page.getByRole('heading', { name: /Needs your attention/ })).toHaveCount(0)
    expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === 'workshop')!.requests)).toEqual(pending)
    await page.screenshot({ path: 'artifacts/crossing/attention-later.png' })
    await page.getByRole('button', { name: /Review attention/ }).click()
    await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
    const panel = await page.locator('.agent-room__attention').boundingBox()
    const caption = await page.locator('.agent-room__caption').boundingBox()
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(caption!.y)
    await page.screenshot({ path: 'artifacts/crossing/attention-review.png' })
    await page.getByRole('button', { name: 'Later', exact: true }).click()
    await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'assign', threadId: 'docs' }); await window.sottoE2E!.agentEvent!({ type: 'permission', threadId: 'docs', text: 'A new request needs review.' }) })
    await expect(page.getByRole('heading', { name: /Needs your attention/ })).toBeVisible()
  } finally { await closeSotto(launched) }
})

test('Next finishes a review instead of cycling through the same requests', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await page.evaluate(async () => { await window.sotto!.updateSettings({ onboardingComplete: true }); await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } }); await window.sotto!.agents!.command({ type: 'connect' }) })
    await page.reload()
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    await page.getByRole('button', { name: 'Enable spoken replies', exact: true }).click()
    await page.getByRole('button', { name: 'Mute spoken replies', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).configuration.speak)).toBe(false)
    await page.evaluate(async () => {
      for (const threadId of ['workshop', 'docs']) {
        await window.sotto!.agents!.command({ type: 'assign', threadId })
        await window.sottoE2E!.agentEvent!({ type: 'permission', threadId, requestId: `review-${threadId}`, text: `Review ${threadId}.` })
      }
      await window.sotto!.agents!.command({ type: 'select-thread', threadId: 'workshop' })
    })
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(page.locator('.agent-room__attention')).toContainText('Review docs.')
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(page.getByRole('heading', { name: /Needs your attention/ })).toHaveCount(0)
    expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).queue.length)).toBe(2)
    await expect(page.getByRole('heading', { name: 'Sotto is speaking', exact: true })).toHaveCount(0)
    await page.screenshot({ path: 'artifacts/crossing/attention-review-finished.png' })
    await page.getByRole('button', { name: /Review attention/ }).click()
    await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
    await page.reload()
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Enable spoken replies', exact: true })).toHaveAttribute('aria-pressed', 'true')
  } finally { await closeSotto(launched) }
})
