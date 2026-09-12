import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { defaultAgentConfiguration } from '../../src/shared/agents'
import { designThreadsFixture } from '../../src/shared/e2e'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto } from './support/sottoLaunch'

test('a saved draft elsewhere does not close the manual composer, including while the thread runs', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
      await window.sotto!.agents!.command({ type: 'select-thread', threadId: 'workshop' })
      await window.sotto!.agents!.command({ type: 'compose', text: 'Keep this saved draft in Workshop.' })
    })
    await page.reload()
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    await page.getByRole('button', { name: 'Docs', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Docs', exact: true })).toBeVisible()
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('A separate manual message.')
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(page.getByLabel('Thread transcript')).toContainText('A separate manual message.')
    await expect(prompt).toHaveValue('')
    await prompt.fill('Prepare the next message while Docs runs.')
    await expect(page.getByRole('button', { name: 'Send prompt', exact: true })).toBeDisabled()
    await prompt.press('Control+Enter')
    await page.screenshot({ animations: 'disabled', path: 'artifacts/crossing/thread-workspace-foreign-draft.png' })
    const state = await page.evaluate(async () => window.sotto!.agents!.get())
    expect(state).toMatchObject({ draft: 'Keep this saved draft in Workshop.', draftThreadId: 'workshop', assignments: [] })
    expect(state.host.threads.find(thread => thread.id === 'docs')!.messages.filter(message => message.role === 'user')).toHaveLength(1)
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    await expect(prompt).toHaveValue('Keep this saved draft in Workshop.')
    await page.getByRole('button', { name: 'Docs', exact: true }).click()
    await expect(prompt).toHaveValue('Prepare the next message while Docs runs.')
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'docs', text: 'Ready for the next message.' }))
    await expect(page.getByRole('button', { name: 'Send prompt', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(page.getByLabel('Thread transcript')).toContainText('Prepare the next message while Docs runs.')
  } finally { await closeSotto(launched) }
})

test('workspace sends a manual prompt to the selected thread without granting management', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Explain the next small change.')
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(page.getByLabel('Thread transcript')).toContainText('Explain the next small change.')
    // Visible pending text precedes native confirmation; wait for the matching receipt to clear the draft.
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('')
    const state = await page.evaluate(async () => window.sotto!.agents!.get())
    expect(state.assignments).toHaveLength(0)
    expect(state.host.threads.find(thread => thread.id === 'workshop')!.messages.filter(message => message.role === 'user')).toHaveLength(1)
    await page.getByRole('button', { name: 'Stop agent', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === 'workshop')!.status)).toBe('idle')
    expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).assignments)).toHaveLength(0)
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'workshop', text: 'Here is the next small change.' }))
    await expect(page.getByLabel('Thread transcript')).toContainText('Here is the next small change.')
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Keep this draft in Workshop.')
    await page.getByRole('button', { name: 'Docs', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('')
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Keep this draft in Workshop.')
    await page.screenshot({ animations: 'disabled', path: 'artifacts/crossing/thread-workspace-manual.png' })
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'permission', threadId: 'workshop', requestId: 'manual-permission', text: 'Allow the manual test step?' }))
    await page.getByRole('button', { name: 'Allow', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === 'workshop')!.requests.length)).toBe(0)
    expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).assignments)).toHaveLength(0)

  } finally { await closeSotto(launched) }
})

test('settled work stays off attention and session pills, with real timestamps and an expandable shelf', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-workspace-'))
  const fixture = designThreadsFixture()
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true }))
  await writeFile(join(profile, 'agents.json'), JSON.stringify({
    configuration: { ...defaultAgentConfiguration(), enabled: true, speak: false },
    assignments: fixture.assignments.map(assignment => ({ ...assignment, contextUpdatedAt: Date.now() })),
    queue: [{ id: 'stale-settled', threadId: 'release-notes', kind: 'ready', text: 'Old closed thread update.', createdAt: new Date().toISOString(), deferred: true }],
    activeThreadId: 'release-notes', activeProjectId: 'workshop', draft: '', draftThreadId: null, draftRequestId: null, composing: false, pendingRequest: '', outbox: [],
  }))
  const launched = await launchSotto('design-threads', profile)
  const { page } = launched
  try {
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    await page.getByRole('button', { name: 'Not now', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Open Footer links', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open Release notes 1.4', exact: true })).toHaveCount(0)
    await expect(page.getByText('Old closed thread update.', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Later', exact: true }).click()
    const mute = page.getByRole('button', { name: 'Enable spoken replies', exact: true })
    await expect(mute).toHaveAttribute('title', 'Enable spoken replies')
    await expect(mute.locator('svg')).toHaveClass(/lucide-volume-x/)
    await mute.click()
    const speak = page.getByRole('button', { name: 'Mute spoken replies', exact: true })
    await expect(speak.locator('svg')).toHaveClass(/lucide-volume-2/)
    await speak.click()
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await expect(sidebar.getByRole('region', { name: 'Unsettled', exact: true }).getByRole('button')).toHaveCount(5)
    await expect(sidebar.getByRole('button', { name: 'Release notes 1.4', exact: true })).toHaveCount(0)
    await sidebar.getByRole('button', { name: /Settled 4/ }).click()
    const release = sidebar.getByRole('button', { name: 'Release notes 1.4', exact: true })
    await expect(release.locator('time')).toHaveAttribute('datetime', fixture.threads.find(thread => thread.id === 'release-notes')!.updatedAt!)
    await release.click()
    await expect(page.getByRole('heading', { name: 'Release notes 1.4', exact: true })).toBeVisible()
    await expect(page.getByLabel('Thread transcript')).toContainText('Release notes are in the draft release.')
    await page.screenshot({ animations: 'disabled', path: 'artifacts/crossing/thread-workspace-settled.png' })
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Start a new manual task in this thread.')
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(page.getByLabel('Thread transcript')).toContainText('Start a new manual task in this thread.')
    expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).assignments.some(assignment => assignment.threadId === 'release-notes'))).toBe(false)
    await page.getByRole('button', { name: 'Stop agent', exact: true }).click()

    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    await expect(page.getByRole('heading', { name: /Needs your attention/ })).toHaveCount(0)
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
    expect(await page.locator('.side-sheet__body').evaluate(node => getComputedStyle(node).scrollbarColor)).toBe('rgb(42, 46, 44) rgba(0, 0, 0, 0)')
    await page.screenshot({ animations: 'disabled', path: 'artifacts/crossing/agent-configuration-scrollbar.png' })
  } finally {
    await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})
