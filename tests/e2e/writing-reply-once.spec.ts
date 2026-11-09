/**
 * "Writing a reply" said once (ADR-0134, November 9, 2026 amendment), in the built app with the real Claude adapter over the
 * fake CLI in `tests/fixtures/`. With Replies in threads set to When finished, a reply on its way is not drawn: the working
 * line alone says "Writing a reply", and the reply shows whole once the turn ends.
 *
 *   npm run build && npx playwright test tests/e2e/writing-reply-once.spec.ts
 */
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { fillPrompt, promptField } from './support/prompt'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'
import { fakeClaudeLaunches, fakeClaudePrompts as prompts } from '../fixtures/fakeClaudeRecords'
import { writeProviderAction } from '../fixtures/providerRecords'

const evidence = evidenceDirectory('artifacts/writing-reply-once')

test('with replies shown when finished, a reply on its way is said once, on the working line', async () => {
  test.setTimeout(180_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-writing-reply-' })).directory
  const root = join(profile, 'native-fixture'), claude = join(root, 'claude'), project = join(root, 'project')
  for (const folder of [claude, project, evidence]) await mkdir(folder, { recursive: true })
  const previous = { SOTTO_E2E_NATIVE_FIXTURE_ROOT: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE }
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const page = launched.page
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on', responseStreaming: 'complete' })
      const configured = await window.sotto!.agents!.command({ type: 'configure', patch: { provider: 'claude', enabled: true, enabledProviders: ['claude'] } })
      if (configured.error) throw new Error(configured.error)
      const connected = await window.sotto!.agents!.command({ type: 'connect', provider: 'claude' })
      if (connected.error) throw new Error(connected.error)
    })
    await page.reload()
    await page.evaluate(async path => {
      const agents = window.sotto!.agents!
      const created = await agents.command({ type: 'create-project', provider: 'claude', title: 'Lighthouses', path, useExisting: true })
      if (created.error) throw new Error(created.error)
      const projectId = created.host.projects.find(item => item.title === 'Lighthouses')!.id
      const model = (await agents.get()).host.models.find(item => item.providerId === 'claude' && item.ready)
      if (!model) throw new Error('No ready Claude model.')
      const thread = await agents.command({ type: 'create-thread', projectId, title: 'Lighthouse essay', titleSource: 'user', modelId: model.id, workingCopy: 'shared' })
      if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'No thread was created.')
    }, project)

    await openThreads(page)
    await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Lighthouse essay', exact: true }).click({ position: { x: 16, y: 12 } })
    const pane = page.locator('section.thread-pane:not([data-hidden])')
    await expect(pane.getByRole('heading', { name: 'Lighthouse essay', level: 2 })).toBeVisible()
    const transcript = pane.getByLabel('Thread transcript')
    const prompt = promptField(pane)
    await expect(async () => { await fillPrompt(prompt, 'Write a short essay on the lighthouse.') }).toPass({ timeout: 20_000 })
    await prompt.press('Enter')
    await expect.poll(() => prompts(claude), { timeout: 30_000 }).toBe(1)
    const session = (await fakeClaudeLaunches(claude)).at(-1)!.session
    const control = join(claude, `control-${session}.json`)
    const send = async (action: Record<string, unknown>): Promise<void> => {
      // The fake CLI holds one action at a time, so each waits for the one before it to be read.
      await expect.poll(() => stat(control).then(() => true, () => false), { timeout: 10_000 }).toBe(false)
      await writeProviderAction(control, action)
    }

    // Claude starts its reply and writes the first words of it.
    await send({ type: 'raw', frame: { type: 'stream_event', session_id: session, event: { type: 'message_start', message: { id: 'reply-on-its-way', role: 'assistant' } } } })
    await send({ type: 'raw', frame: { type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Lighthouses began as fires' } } } })
    const line = transcript.getByTestId('thread-activity-live')
    await expect(line).toContainText('Writing a reply', { timeout: 30_000 })
    // Said once: no reply is drawn for it, so no second "Writing a reply…" and none of its words yet.
    await expect(transcript.locator('[data-message-id="reply-on-its-way"]')).toHaveCount(0)
    await expect(transcript.getByText('Writing a reply…')).toHaveCount(0)
    await expect(transcript.getByText('Lighthouses began as fires')).toHaveCount(0)
    for (const [width, height] of [[1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await expect(line).toBeInViewport()
        expect(await transcript.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
        if (width === 1280 || appearance === 'dark') await page.screenshot({ path: join(evidence, `writing-${appearance}-${width}.png`), animations: 'disabled' })
      }
    }
    await resizeWindow(launched, 1280, 800)
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))

    // The turn ends: the reply shows whole, and the working line goes.
    await send({ type: 'complete', text: 'The essay is finished.' })
    await expect(transcript.getByText('The essay is finished.')).toBeVisible({ timeout: 30_000 })
    await expect(line).toHaveCount(0)
    await page.screenshot({ path: join(evidence, 'finished-dark-1280.png'), animations: 'disabled' })
  } finally {
    if (launched) await closeSotto(launched)
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    await removeOwnedE2EProfile(profile)
  }
})
