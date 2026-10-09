import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { EMPTY_AGENT_HOST, defaultAgentConfiguration } from '../../src/shared/agents'
import { computerUseNeeds } from '../../src/main/agents/codexActivity'
import { closeSotto, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'

test('Computer Use connection guidance wraps in the built app and opens from the keyboard', async () => {
  test.setTimeout(120_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-computer-use-' })).directory
  const providerError = 'Computer Use native pipe is unavailable: failed to connect native pipe: The system cannot find the file specified. (os error 2)'
  const guidance = computerUseNeeds(providerError, false)!
  const snapshot = { ...EMPTY_AGENT_HOST, projects: [{ id: 'project', title: 'Test project', path: profile }],
    threads: [{ id: 'workshop', projectId: 'project', title: 'Computer Use connection', modelId: 'codex:test', runtimeMode: 'full-access', status: 'idle', requests: [],
      messages: [{ id: 'prompt', role: 'user', text: 'Use Computer Use to inspect the open apps.', createdAt: '2026-10-05T10:00:00.000Z' }],
      activities: [{ id: 'computer-use', turnId: 'turn', sequence: 0, afterMessageId: 'prompt', kind: 'tool', status: 'failed', title: 'Computer Use', error: `${guidance}\n${providerError}` }] }] }
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, voiceCoordinator: true }))
  await writeFile(join(profile, 'agents.json'), JSON.stringify({ configuration: { ...defaultAgentConfiguration(), enabled: true, speak: false }, activeProjectId: 'project', activeThreadId: 'workshop' }))
  await writeFile(join(profile, 'workspace.json'), JSON.stringify({ snapshot, creations: [], projectAliases: [] }))
  const shots = test.info().outputPath('captures')
  await mkdir(shots, { recursive: true })
  try {
    const launched = await launchSotto('success', profile)
    try {
      const { page } = launched
      await openThreads(page)
      await page.evaluate(() => window.sotto!.agents!.command({ type: 'select-thread', threadId: 'workshop' }))
      const log = page.getByRole('log', { name: 'Thread transcript' })
      await expect(log).toContainText('Use Computer Use to inspect the open apps.')
      const row = log.getByRole('button', { name: /Computer Use/ })
      if (!await row.isVisible()) await log.locator('.thread-activity__summary').click()
      await row.focus()
      await page.keyboard.press('Enter')
      const error = log.locator('.thread-activity__error')
      await expect(error).toContainText(guidance)
      await expect(error).toContainText('Open Codex if it is closed. Keep it open and try again.')
      await expect(error).toContainText(providerError)
      await expect(error).not.toContainText('Nothing was changed')
      await page.emulateMedia({ reducedMotion: 'reduce' })
      for (const mode of ['dark', 'light'] as const) {
        await page.evaluate(mode => window.sotto!.updateSettings({ appearance: mode }), mode)
        for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
          await resizeWindow(launched, width!, height!)
          await expect(error).toBeVisible()
          expect(await log.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0)
          const bounds = await error.boundingBox()
          expect(bounds!.x).toBeGreaterThanOrEqual(0)
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth))
          if (width === 820 || width === 1600 && mode === 'dark') await page.screenshot({ animations: 'disabled', path: resolve(shots, `${width}-${height}-${mode}.png`) })
        }
      }
      await row.focus()
      await page.keyboard.press('Enter')
      await expect(error).toHaveCount(0)
    } finally { await closeSotto(launched) }
  } finally { await removeOwnedE2EProfile(profile) }
})
