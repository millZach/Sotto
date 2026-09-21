import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { EMPTY_AGENT_HOST, defaultAgentConfiguration } from '../../src/shared/agents'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openThreads } from './support/sottoLaunch'

test('desktop migration keeps raw host IDs and restores scoped panes and drafts after restart', async () => {
  const testInfo = test.info()
  test.setTimeout(120_000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-host-identity-'))
  const snapshot = { ...EMPTY_AGENT_HOST, projects: [{ id: 'project', title: 'Identity project', path: profile }],
    threads: ['first', 'second'].map(id => ({ id, projectId: 'project', title: `${id} identity task`, modelId: '', status: 'idle', messages: [], requests: [], nativeSessionStarted: false })) }
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true }))
  await writeFile(join(profile, 'agents.json'), JSON.stringify({ configuration: { ...defaultAgentConfiguration(), enabled: true, speak: false }, activeProjectId: 'project', activeThreadId: 'first' }))
  await writeFile(join(profile, 'workspace.json'), JSON.stringify({ snapshot, creations: [], projectAliases: [] }))
  let originalHost: string | undefined
  try {
    for (const phase of ['migrated', 'restarted']) {
      const launched = await launchSotto('success', profile)
      try {
        const { page } = launched
        await openThreads(page)
        const identity = JSON.parse(await readFile(join(profile, 'host.json'), 'utf8')) as { hostId: string }
        originalHost ??= identity.hostId
        expect(identity.hostId).toBe(originalHost)
        const first = hostEntityKey(identity.hostId, 'first'), second = hostEntityKey(identity.hostId, 'second')
        const state = await page.evaluate(() => window.sotto!.agents!.get())
        expect(state.hostId).toBe(identity.hostId)
        expect(state.host.threads.find(thread => thread.id === first)?.hostId).toBe(identity.hostId)
        expect(state.host.threads.find(thread => thread.id === second)?.projectId).toBe(hostEntityKey(identity.hostId, 'project'))
        const saved = JSON.parse(await readFile(join(profile, 'workspace.json'), 'utf8')) as { snapshot: typeof snapshot }
        expect(saved.snapshot.threads.map(thread => thread.id)).toContain('first')
        expect(saved.snapshot.threads.some(thread => thread.id.startsWith('host:'))).toBe(false)
        if (phase === 'migrated') {
          const result = await page.evaluate(async threadId => window.sotto!.agents!.command({ type: 'save-thread-draft', threadId, draftId: '33333333-3333-4333-8333-333333333333', text: 'Draft retained across host migration', requestId: null }), first)
          expect(result.error).toBeNull()
          const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
          await sidebar.getByRole('button', { name: 'first identity task', exact: true }).click()
          await sidebar.getByRole('button', { name: 'second identity task', exact: true }).hover()
          await sidebar.getByRole('button', { name: 'Open second identity task beside', exact: true }).click()
        }
        await expect(page.locator('section.thread-pane')).toHaveCount(2)
        const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('sotto.threadWorkspace.layout')!) as { panes: string[] })
        expect(stored.panes).toEqual([first, second])
        const draft = await page.evaluate(async () => (await window.sotto!.agents!.get()).threadDrafts)
        expect(draft).toContainEqual(expect.objectContaining({ threadId: first, text: 'Draft retained across host migration' }))
        await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'first identity task', exact: true }).click()
        await expect(page.locator(`section.thread-pane[data-thread-id="${first}"]`).getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Draft retained across host migration')
        await page.screenshot({ path: testInfo.outputPath(`${phase}.png`), animations: 'disabled' })
      } finally { await closeSotto(launched) }
    }
  } finally { await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true }) }
})
