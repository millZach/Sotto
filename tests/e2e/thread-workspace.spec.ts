import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { defaultAgentConfiguration } from '../../src/shared/agents'
import { designThreadsFixture } from '../../src/shared/e2e'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, enableVoiceCoordinator, launchSotto, openThreads, userMessageTexts } from './support/sottoLaunch'

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
    await openThreads(page)
    await page.getByRole('button', { name: 'Docs', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Docs', exact: true })).toBeVisible()
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('A separate manual message.')
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(page.getByLabel('Thread transcript')).toContainText('A separate manual message.')
    await expect(prompt).toHaveValue('')
    // While Docs runs, the next message queues; it is not a send and nothing reaches the provider yet.
    await prompt.fill('Prepare the next message while Docs runs.')
    await expect(page.getByRole('button', { name: 'Send prompt', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Queue prompt', exact: true })).toBeEnabled()
    await prompt.press('Control+Enter')
    const queue = page.getByRole('region', { name: 'Queued messages' })
    await expect(queue).toContainText('Prepare the next message while Docs runs.')
    await expect(prompt).toHaveValue('')
    await page.screenshot({ animations: 'disabled', path: 'artifacts/crossing/thread-workspace-foreign-draft.png' })
    const state = await page.evaluate(async () => window.sotto!.agents!.get())
    expect(state).toMatchObject({ draft: 'Keep this saved draft in Workshop.', draftThreadId: 'workshop', assignments: [] })
    expect(await userMessageTexts(page, 'docs')).toHaveLength(1)
    expect(state.followups).toEqual([expect.objectContaining({ threadId: 'docs', text: 'Prepare the next message while Docs runs.', status: 'queued' })])
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    await expect(prompt).toHaveValue('Keep this saved draft in Workshop.')
    await expect(queue).toHaveCount(0)
    await page.getByRole('button', { name: 'Docs', exact: true }).click()
    await expect(prompt).toHaveValue('')
    await expect(queue).toContainText('Prepare the next message while Docs runs.')
    // The fixture turn ends without native completion evidence, so the queue waits for an explicit resume.
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'docs', text: 'Ready for the next message.' }))
    await expect(queue).toContainText('Paused')
    await queue.getByRole('button', { name: 'Resume queue', exact: true }).click()
    await expect(page.getByLabel('Thread transcript')).toContainText('Prepare the next message while Docs runs.')
    await expect(queue).toHaveCount(0)
    expect(await userMessageTexts(page, 'docs'))
      .toEqual(['A separate manual message.', 'Prepare the next message while Docs runs.'])
  } finally { await closeSotto(launched) }
})

test('a queued follow-up keeps its skill reference and order through a reload, sends once, and a refused skill stays reviewable', async () => {
  const launched = await launchSotto()
  const { page } = launched
  const skill = { name: 'deploy', path: 'C:/sotto-test/.agents/skills/deploy/SKILL.md' }
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
      await window.sotto!.agents!.command({ type: 'select-thread', threadId: 'docs' })
    })
    await page.reload()
    await openThreads(page)
    await page.getByRole('button', { name: 'Docs', exact: true }).click()
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('Start the long job.')
    await prompt.press('Enter')
    await expect(page.getByLabel('Thread transcript')).toContainText('Start the long job.')
    await expect(prompt).toHaveValue('')
    // A durable draft carrying a selected skill, as the picker leaves it, returns to the composer after a reload.
    await page.evaluate(async reference => {
      await window.sotto!.agents!.command({ type: 'save-thread-draft', threadId: 'docs', draftId: crypto.randomUUID(), text: 'Then run $deploy for staging.', skills: [reference], requestId: null })
    }, skill)
    await page.reload()
    await openThreads(page)
    await page.getByRole('button', { name: 'Docs', exact: true }).click()
    await expect(prompt).toHaveValue('Then run $deploy for staging.')
    await prompt.press('Enter')
    const queue = page.getByRole('region', { name: 'Queued messages' })
    await expect(queue).toContainText('Then run $deploy for staging.')
    await expect(prompt).toHaveValue('')
    await prompt.fill('Then post the preview link.')
    await prompt.press('Enter')
    await expect(queue.getByRole('listitem')).toHaveCount(2)
    await queue.getByRole('button', { name: 'Move queued message 2 up', exact: true }).click()
    await expect(queue.getByRole('listitem').first()).toContainText('Then post the preview link.')
    const queued = await page.evaluate(async () => window.sotto!.agents!.get())
    expect(queued.followups!.map(item => [item.text, item.skills ?? []])).toEqual([['Then post the preview link.', []], ['Then run $deploy for staging.', [skill]]])
    expect(await userMessageTexts(page, 'docs')).toHaveLength(1)
    await page.screenshot({ animations: 'disabled', path: 'artifacts/crossing/thread-workspace-queue.png' })

    await page.reload()
    await openThreads(page)
    await page.getByRole('button', { name: 'Docs', exact: true }).click()
    await expect(queue.getByRole('listitem').first()).toContainText('Then post the preview link.')
    const reloaded = await page.evaluate(async () => window.sotto!.agents!.get())
    expect(reloaded.followups!.map(item => [item.text, item.skills ?? []])).toEqual([['Then post the preview link.', []], ['Then run $deploy for staging.', [skill]]])

    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'docs', text: 'The long job is done.' }))
    await expect(queue).toContainText('Paused')
    await queue.getByRole('button', { name: 'Resume queue', exact: true }).click()
    await expect(page.getByLabel('Thread transcript')).toContainText('Then post the preview link.')
    await expect(queue.getByRole('listitem')).toHaveCount(1)
    // Resume reviewed the unconfirmed turn for the whole queue, so the next item goes when this turn ends.
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'docs', text: 'Posted.' }))
    // The fixture thread is not a Codex thread, so the host refuses the selected skill. The item stays, with its reference, for review.
    await expect(queue).toContainText('Not sent')
    await expect(queue).toContainText('Selected skills are unavailable or belong to another provider. Refresh this draft’s skill catalog.')
    const done = await page.evaluate(async () => window.sotto!.agents!.get())
    expect(await userMessageTexts(page, 'docs'))
      .toEqual(['Start the long job.', 'Then post the preview link.'])
    expect(done.followups).toEqual([expect.objectContaining({ text: 'Then run $deploy for staging.', skills: [skill], status: 'failed' })])
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
    await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Explain the next small change.')
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(page.getByLabel('Thread transcript')).toContainText('Explain the next small change.')
    // Visible pending text precedes native confirmation; wait for the matching receipt to clear the draft.
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('')
    const state = await page.evaluate(async () => window.sotto!.agents!.get())
    expect(state.assignments).toHaveLength(0)
    expect(await userMessageTexts(page, 'workshop')).toHaveLength(1)
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
  await enableVoiceCoordinator(profile)
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
    await openThreads(page)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await expect(sidebar.getByRole('region', { name: 'Projects', exact: true }).locator('.thread-nav__row')).toHaveCount(5)
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
    await page.getByRole('button', { name: 'Configure agents', exact: true }).click()
    const scrollbar = await page.locator('.side-sheet__body').evaluate(node => {
      const style = getComputedStyle(node)
      return { actual: style.scrollbarColor, thumb: style.getPropertyValue('--tt-scrollbar').trim() }
    })
    expect(scrollbar.thumb).not.toBe('')
    expect(scrollbar.actual).toBe(`${scrollbar.thumb} rgba(0, 0, 0, 0)`)
    await page.screenshot({ animations: 'disabled', path: 'artifacts/crossing/agent-configuration-scrollbar.png' })
  } finally {
    await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})
