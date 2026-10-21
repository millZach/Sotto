import { fillPrompt, promptField } from './support/prompt'
/**
 * A queued message the user takes out with Remove is never sent, and the correction queued after it is (#1184). The
 * real Claude adapter runs over the fake CLI in `tests/fixtures/`, holding its first turn open while the queue is changed.
 *
 *   npm run build && npx playwright test tests/e2e/queue-remove-correction.spec.ts
 */
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { fakeClaudeLaunches, fakeClaudeRecords } from '../fixtures/fakeClaudeRecords'
import { writeProviderAction } from '../fixtures/providerRecords'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

const sentTexts = async (root: string): Promise<string[]> => (await fakeClaudeRecords(root)).filter(record => record.method === 'user')
  .map(record => JSON.stringify(record.params ?? {}))

// Whether the user stops the turn before or after taking the message out, the correction is what goes (#1184).
for (const order of ['remove', 'remove-then-stop', 'stop-then-remove'] as const) test(`a removed queued message is never sent, and the correction after it is (${order})`, async () => {
  test.setTimeout(180_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-queue-remove-' })).directory
  const root = join(profile, 'native-fixture')
  const claude = join(root, 'claude')
  const project = join(root, 'project')
  for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
  const previous = { root: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, executable: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE }
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      const configured = await window.sotto!.agents!.command({ type: 'configure', patch: { provider: 'claude', enabled: true, enabledProviders: ['claude'] } })
      if (configured.error) throw new Error(configured.error)
      const connected = await window.sotto!.agents!.command({ type: 'connect', provider: 'claude' })
      if (connected.error) throw new Error(connected.error)
    })
    await page.reload()
    await resizeWindow(launched, 1280, 800)
    const threadId = await page.evaluate(async path => {
      const agents = window.sotto!.agents!
      const created = await agents.command({ type: 'create-project', provider: 'claude', title: 'Lighthouses', path, useExisting: true })
      if (created.error) throw new Error(created.error)
      const projectId = created.host.projects.find(item => item.title === 'Lighthouses')!.id
      const model = (await agents.get()).host.models.find(item => item.providerId === 'claude' && item.ready)
      if (!model) throw new Error('No ready Claude model.')
      const thread = await agents.command({ type: 'create-thread', projectId, title: 'Lighthouse essay', titleSource: 'user', modelId: model.id, workingCopy: 'shared' })
      if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'No thread was created.')
      return thread.activeThreadId
    }, project)

    await openThreads(page)
    await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Lighthouse essay', exact: true }).click()
    const pane = page.locator('section.thread-pane:not([data-hidden])')
    await expect(pane).toHaveAttribute('data-thread-id', threadId)
    const prompt = promptField(pane)
    const queue = pane.getByRole('region', { name: 'Queued messages' })
    // The rows, not the head, which names a message just queued for a moment too.
    const row = (text: string) => queue.getByRole('listitem').filter({ hasText: text })

    await fillPrompt(prompt, 'Count the lighthouses on this coast.')
    await prompt.press('Enter')
    await expect.poll(async () => (await sentTexts(claude)).length, { timeout: 30_000 }).toBe(1)
    await expect(pane.getByRole('button', { name: 'Steer now', exact: true })).toBeVisible({ timeout: 30_000 })

    await fillPrompt(prompt, 'Sorry it shows you are watching 8')
    await prompt.press('Enter')
    await expect(row('Sorry it shows you are watching 8')).toBeVisible({ timeout: 30_000 })
    const stop = async (): Promise<void> => {
      await pane.locator('.thread-prompt__stop').click()
      await expect(pane.locator('.thread-prompt__stop')).toHaveCount(0, { timeout: 30_000 })
    }
    if (order === 'stop-then-remove') await stop()
    await queue.getByRole('button', { name: 'Remove queued message 1' }).click()
    await expect(row('Sorry it shows you are watching 8')).toHaveCount(0, { timeout: 30_000 })
    if (order === 'remove-then-stop') await stop()
    await expect(prompt).toHaveText('')

    await fillPrompt(prompt, 'Sorry it shows you are watching 12')
    await prompt.press('Enter')
    if (order === 'remove') {
      // The turn still runs, so the correction waits in the queue, owned by it rather than still on its way there.
      await expect(row('Sorry it shows you are watching 12')).toBeVisible({ timeout: 30_000 })
      await expect(queue.getByText('Queuing…')).toHaveCount(0, { timeout: 30_000 })
      const [launch] = await fakeClaudeLaunches(claude)
      await writeProviderAction(join(claude, `control-${launch!.session}.json`), { type: 'complete', text: 'Nine lighthouses.' })
    }
    await expect.poll(async () => (await sentTexts(claude)).length, { timeout: 30_000 }).toBe(2)
    const sent = await sentTexts(claude)
    expect(sent[1]).toContain('watching 12')
    expect(sent.some(text => text.includes('watching 8'))).toBe(false)
  } finally {
    if (launched) await closeSotto(launched)
    for (const [key, value] of [['SOTTO_E2E_NATIVE_FIXTURE_ROOT', previous.root], ['SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE', previous.executable]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    await removeOwnedE2EProfile(profile)
  }
})
