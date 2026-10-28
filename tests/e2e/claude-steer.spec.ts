import { fillPrompt, promptField } from './support/prompt'
/**
 * Steer now on a Claude thread in the built app (ADR-0075). The real Claude adapter runs over the fake CLI in
 * `tests/fixtures/` (`SOTTO_E2E_NATIVE_FIXTURE_ROOT` in `src/main/index.ts`), which cuts a turn for a prompt sent now as
 * Claude Code 2.1.296 does. A steer typed while the turn runs is answered as the next turn, and the turn it cut reads
 * Steered rather than Stopped.
 *
 *   npm run build && npx playwright test tests/e2e/claude-steer.spec.ts
 */
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { fakeClaudeLaunches, fakeClaudePrompts as prompts } from '../fixtures/fakeClaudeRecords'
import { writeProviderAction } from '../fixtures/providerRecords'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/claude-steer')

test('Steer now answers the steer at once and the turn it cut reads Steered', async () => {
  test.setTimeout(180_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-claude-steer-' })).directory
  const root = join(profile, 'native-fixture')
  const claude = join(root, 'claude')
  const project = join(root, 'project')
  for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
  await writeFile(join(claude, 'script.json'), JSON.stringify({ steering: true }))
  await mkdir(evidence, { recursive: true })
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
    const transcript = pane.getByLabel('Thread transcript')
    const prompt = promptField(pane)

    await fillPrompt(prompt, 'Write a long essay on the history of the lighthouse.')
    await prompt.press('Enter')
    await expect.poll(() => prompts(claude), { timeout: 30_000 }).toBe(1)
    const steerNow = pane.getByRole('button', { name: 'Steer now', exact: true })
    // The turn is running once Stop is the plate; Steer now waits for text to steer (ADR-0153).
    await expect(pane.locator('.thread-prompt__stop')).toBeVisible({ timeout: 30_000 })
    await expect(steerNow).toHaveCount(0)

    // Typed while the turn runs, the steer goes in from the composer's Steer now, by keyboard as by click.
    await fillPrompt(prompt, 'Skip the essay. Just name the oldest lighthouse still standing.')
    await expect(steerNow).toBeEnabled()
    await steerNow.focus()
    await page.keyboard.press('Enter')
    await expect(transcript.getByText('Skip the essay. Just name the oldest lighthouse still standing.')).toBeVisible({ timeout: 30_000 })
    await expect(transcript.getByRole('region', { name: /^Steered after/ })).toBeVisible({ timeout: 30_000 })
    await expect(transcript.getByText(/^Stopped/)).toHaveCount(0)

    // The steer's own turn is running; the fake CLI answers it.
    const [launch] = await fakeClaudeLaunches(claude)
    await writeProviderAction(join(claude, `control-${launch!.session}.json`), { type: 'complete', text: 'The Tower of Hercules in Spain, lit since the first century.' })
    await expect(transcript.getByText('The Tower of Hercules in Spain, lit since the first century.')).toBeVisible({ timeout: 30_000 })
    await expect(steerNow).toHaveCount(0)
    expect(await page.evaluate(() => window.sotto!.agents!.get().then(state => state.error ?? state.host.error ?? null))).toBeNull()

    for (const [width, height] of [[1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await expect(transcript.getByRole('region', { name: /^Steered after/ })).toBeVisible()
        expect(await transcript.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
        await page.screenshot({ path: join(evidence, `steered-${appearance}-${width}.png`), animations: 'disabled' })
      }
    }
    expect(await readFile(join(claude, 'violations.jsonl'), 'utf8').catch(() => '')).toBe('')
  } finally {
    if (launched) await closeSotto(launched)
    for (const [key, value] of [['SOTTO_E2E_NATIVE_FIXTURE_ROOT', previous.root], ['SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE', previous.executable]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    await removeOwnedE2EProfile(profile)
  }
})
