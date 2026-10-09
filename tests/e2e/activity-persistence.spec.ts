import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { EMPTY_AGENT_HOST, defaultAgentConfiguration } from '../../src/shared/agents'
import { closeSotto, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

const evidence = evidenceDirectory('artifacts/activity-performance')

test('legacy activity remains readable after migration and a full app restart', async () => {
  test.setTimeout(120_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-activity-' })).directory
  const output = 'Retained inspection output survives restart.'
  const snapshot = {
    ...EMPTY_AGENT_HOST, projects: [{ id: 'project', title: 'Test project', path: profile }],
    threads: [{ id: 'workshop', projectId: 'project', title: 'Workshop', modelId: 'claude:test', status: 'idle', requests: [],
      messages: [{ id: 'prompt', role: 'user', text: 'Inspect the retained work.', createdAt: '2026-09-20T10:00:00.000Z' }],
      activities: [{ id: 'inspection', turnId: 'turn', sequence: 0, afterMessageId: 'prompt', kind: 'command', status: 'completed',
        title: 'Saved inspection', command: 'echo saved', output }] }],
  }
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true }))
  await writeFile(join(profile, 'agents.json'), JSON.stringify({ configuration: { ...defaultAgentConfiguration(), enabled: true, speak: false },
    activeProjectId: 'project', activeThreadId: 'workshop' }))
  await writeFile(join(profile, 'workspace.json'), JSON.stringify({ snapshot, creations: [], projectAliases: [] }))
  await mkdir(evidence, { recursive: true })
  try {
    for (const phase of ['migrated', 'restarted']) {
      const launched = await launchSotto('success', profile)
      try {
        const { page } = launched
        await resizeWindow(launched, 1280, 800)
        await openThreads(page)
        await page.evaluate(() => window.sotto!.agents!.command({ type: 'select-thread', threadId: 'workshop' }))
        await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.threadDetail!('workshop'))?.activities?.[0]?.output)).toBe(output)
        await expect.poll(async () => (await readFile(join(profile, 'workspace.json'), 'utf8')).includes(output)).toBe(false)
        const log = page.getByRole('log', { name: 'Thread transcript' })
        await expect(log).toContainText('Inspect the retained work.')
        const command = log.getByRole('button', { name: /echo saved/ })
        if (!await command.isVisible()) await log.getByRole('button', { name: /Ran 1 command/ }).click()
        await command.click()
        await expect(log.getByLabel('output code block')).toContainText(output)
        await page.screenshot({ animations: 'disabled', path: join(evidence, `${phase}.png`) })
      } finally { await closeSotto(launched) }
    }
  } finally { await removeOwnedE2EProfile(profile) }
})
