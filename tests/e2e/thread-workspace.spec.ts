import { expectPromptText, fillPrompt, promptField } from './support/prompt'
import { agentState } from './support/agentAccess'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { defaultAgentConfiguration } from '../../src/shared/agents'
import { designThreadsFixture } from '../../src/shared/e2e'
import { hostKeys } from './support/hostKeys'
import { closeSotto, launchSotto, openThreads, userMessageTexts } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

const evidence = evidenceDirectory('artifacts/crossing')
const docsTitle = 'Workspace Docs'
const workshopTitle = 'Workspace Workshop'

async function nameWorkspaceThreads(page: Page): Promise<void> {
  // These journeys switch by name; user titles stay stable when the first send generates a title.
  await page.evaluate(async ({ docs, workshop }) => {
    await window.sotto!.agents!.command({ type: 'rename-thread', threadId: 'docs', title: docs })
    await window.sotto!.agents!.command({ type: 'rename-thread', threadId: 'workshop', title: workshop })
  }, { docs: docsTitle, workshop: workshopTitle })
}

test('a saved draft elsewhere does not close the manual composer, including while the thread runs', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, } })
      await window.sotto!.agents!.command({ type: 'connect' })
      await window.sotto!.agents!.command({ type: 'select-thread', threadId: 'workshop' })
      await window.sotto!.agents!.command({ type: 'compose', text: 'Keep this saved draft in Workshop.' })
    })
    await nameWorkspaceThreads(page)
    await page.reload()
    await openThreads(page)
    const key = await hostKeys(page)
    await page.getByRole('button', { name: docsTitle, exact: true }).click()
    await expect(page.getByRole('heading', { name: docsTitle, exact: true })).toBeVisible()
    const prompt = promptField(page)
    await fillPrompt(prompt, 'A separate manual message.')
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(page.getByLabel('Thread transcript')).toContainText('A separate manual message.')
    await expectPromptText(prompt, '')
    // The transcript and emptied composer are optimistic; queue only after the provider confirms this turn.
    await expect.poll(async () => page.evaluate(async docs => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === docs)?.status, key('docs'))).toBe('running')
    // While Docs runs, the next message queues; it is not a send and nothing reaches the provider yet.
    await fillPrompt(prompt, 'Prepare the next message while Docs runs.')
    await expect(page.getByRole('button', { name: 'Send prompt', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Queue prompt', exact: true })).toBeEnabled()
    await prompt.press('Control+Enter')
    const queue = page.getByRole('region', { name: 'Queued messages' })
    await expect(queue).toContainText('Prepare the next message while Docs runs.')
    await expectPromptText(prompt, '')
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'thread-workspace-foreign-draft.png') })
    const state = await agentState(page)
    expect(state).toMatchObject({ draft: 'Keep this saved draft in Workshop.', draftThreadId: key('workshop') })
    expect(await userMessageTexts(page, 'docs')).toHaveLength(1)
    expect(state.followups).toEqual([expect.objectContaining({ threadId: key('docs'), text: 'Prepare the next message while Docs runs.', status: 'queued' })])
    await page.getByRole('button', { name: workshopTitle, exact: true }).click()
    await expectPromptText(prompt, 'Keep this saved draft in Workshop.')
    await expect(queue).toHaveCount(0)
    await page.getByRole('button', { name: docsTitle, exact: true }).click()
    await expectPromptText(prompt, '')
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
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, } })
      await window.sotto!.agents!.command({ type: 'connect' })
      await window.sotto!.agents!.command({ type: 'select-thread', threadId: 'docs' })
    })
    await nameWorkspaceThreads(page)
    await page.reload()
    await openThreads(page)
    const key = await hostKeys(page)
    await page.getByRole('button', { name: docsTitle, exact: true }).click()
    const prompt = promptField(page)
    await fillPrompt(prompt, 'Start the long job.')
    await prompt.press('Enter')
    await expect(page.getByLabel('Thread transcript')).toContainText('Start the long job.')
    await expectPromptText(prompt, '')
    // Direct fixture writes must wait for the composer's post-send empty revision to finish saving.
    await expect.poll(() => page.evaluate(async docs => {
      const state = await window.sotto!.agents!.get()
      const delivery = state.deliveries?.findLast(item => item.threadId === docs)
      const saved = state.threadDraftPersistence?.find(item => item.threadId === docs)
      return state.host.threads.find(thread => thread.id === docs)?.status === 'running'
        && delivery?.status === 'accepted' && !state.busyThreadIds?.includes(docs)
        && saved?.status === 'saved' && saved.draftId !== delivery.draftId
        && !state.threadDrafts?.some(item => item.threadId === docs)
    }, key('docs'))).toBe(true)
    // A durable draft carrying a selected skill, as the picker leaves it, returns to the composer after a reload.
    await page.evaluate(async reference => {
      await window.sotto!.agents!.command({ type: 'save-thread-draft', threadId: 'docs', draftId: crypto.randomUUID(), text: 'Then run $deploy for staging.', skills: [reference], requestId: null })
    }, skill)
    await page.reload()
    await openThreads(page)
    await page.getByRole('button', { name: docsTitle, exact: true }).click()
    await expectPromptText(prompt, 'Then run $deploy for staging.')
    await expect(prompt.locator('[data-skill-token="$deploy"]')).toHaveCount(1)
    await prompt.press('Enter')
    const queue = page.getByRole('region', { name: 'Queued messages' })
    await expect(queue).toContainText('Then run $deploy for staging.')
    await expectPromptText(prompt, '')
    await fillPrompt(prompt, 'Then post the preview link.')
    await prompt.press('Enter')
    await expect(queue.getByRole('listitem')).toHaveCount(2)
    await queue.getByRole('button', { name: 'Move queued message 2 up', exact: true }).click()
    await expect(queue.getByRole('listitem').first()).toContainText('Then post the preview link.')
    const queued = await agentState(page)
    expect(queued.followups!.map(item => [item.text, item.skills ?? []])).toEqual([['Then post the preview link.', []], ['Then run $deploy for staging.', [skill]]])
    expect(await userMessageTexts(page, 'docs')).toHaveLength(1)
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'thread-workspace-queue.png') })

    await page.reload()
    await openThreads(page)
    await page.getByRole('button', { name: docsTitle, exact: true }).click()
    await expect(queue.getByRole('listitem').first()).toContainText('Then post the preview link.')
    const reloaded = await agentState(page)
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
    const done = await agentState(page)
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
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await nameWorkspaceThreads(page)
    await page.reload()
    await openThreads(page)
    const workshop = (await hostKeys(page))('workshop')
    await page.getByRole('button', { name: workshopTitle, exact: true }).click()
    await fillPrompt(promptField(page), 'Explain the next small change.')
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(page.getByLabel('Thread transcript')).toContainText('Explain the next small change.')
    // Visible pending text precedes native confirmation; wait for the matching receipt to clear the draft.
    await expectPromptText(promptField(page), '')
    await expect.poll(() => userMessageTexts(page, 'workshop')).toHaveLength(1)
    await page.getByRole('button', { name: 'Stop agent', exact: true }).click()
    await expect.poll(() => page.evaluate(async id => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === id)!.status, workshop)).toBe('idle')

    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'workshop', text: 'Here is the next small change.' }))
    await expect(page.getByLabel('Thread transcript')).toContainText('Here is the next small change.')
    await fillPrompt(promptField(page), 'Keep this draft in Workshop.')
    await page.getByRole('button', { name: docsTitle, exact: true }).click()
    await expectPromptText(promptField(page), '')
    await page.getByRole('button', { name: workshopTitle, exact: true }).click()
    await expectPromptText(promptField(page), 'Keep this draft in Workshop.')
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'thread-workspace-manual.png') })
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'permission', threadId: 'workshop', requestId: 'manual-permission', text: 'Allow the manual test step?' }))
    await page.getByRole('button', { name: 'Allow', exact: true }).click()
    await expect.poll(() => page.evaluate(async id => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === id)!.requests.length, workshop)).toBe(0)


  } finally { await closeSotto(launched) }
})

test('settled work stays off the active shelf, with real timestamps and an expandable shelf', async () => {
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-workspace-' })).directory
  const fixture = designThreadsFixture()
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true }))
  await writeFile(join(profile, 'agents.json'), JSON.stringify({
    configuration: { ...defaultAgentConfiguration(), enabled: true, },
    queue: [{ id: 'stale-settled', threadId: 'release-notes', kind: 'ready', text: 'Old closed thread update.', createdAt: new Date().toISOString(), deferred: true }],
    activeThreadId: 'release-notes', activeProjectId: 'workshop', draft: '', draftThreadId: null, draftRequestId: null, composing: false, outbox: [],
  }))
  const launched = await launchSotto('design-threads', profile)
  const { page } = launched
  try {
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
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'thread-workspace-settled.png') })
    await fillPrompt(promptField(page), 'Start a new manual task in this thread.')
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(page.getByLabel('Thread transcript')).toContainText('Start a new manual task in this thread.')
    await page.getByRole('button', { name: 'Stop agent', exact: true }).click()

  } finally {
    await closeSotto(launched)
    await removeOwnedE2EProfile(profile)
  }
})
