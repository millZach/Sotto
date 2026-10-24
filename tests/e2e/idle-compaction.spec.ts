import { fillPrompt, promptField } from './support/prompt'
/**
 * Idle compaction in the built app (ADR-0127). The real Claude adapter runs over the fake CLI in `tests/fixtures/`. A turn
 * ends with a reply whose context is 250,000 tokens, dated 54½ minutes ago, as a thread left quiet that long would read.
 * Sotto's own sweep sends `/compact` with nobody pressing anything, the line under the composer says Sotto did it, and
 * its Turn off opens Claude Code's page in Settings › Providers with the switch in focus.
 *
 *   npm run build && npx playwright test tests/e2e/idle-compaction.spec.ts
 */
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { fakeClaudeLaunches, fakeClaudePrompts as prompts, fakeClaudeRecords } from '../fixtures/fakeClaudeRecords'
import { writeProviderAction } from '../fixtures/providerRecords'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/idle-compaction')

/** The `/compact` prompts the fake CLIs were sent. */
const compactions = async (root: string): Promise<number> => (await fakeClaudeRecords(root))
  .filter(record => record.method === 'user' && (record.params?.frame as { message?: { content?: unknown } } | undefined)?.message?.content === '/compact').length

test('Sotto compacts a quiet Claude thread on its own, says so, and Turn off leads to the switch', async () => {
  test.setTimeout(240_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-idle-compaction-' })).directory
  const root = join(profile, 'native-fixture')
  const claude = join(root, 'claude')
  const project = join(root, 'project')
  for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
  // The client advertises /compact, as Claude Code does.
  await writeFile(join(claude, 'skills.json'), JSON.stringify([{ name: 'compact', description: 'Clear conversation history but keep a summary in context' }]))
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
      const thread = await agents.command({ type: 'create-thread', projectId, title: 'Lighthouse survey', titleSource: 'user', modelId: model.id, workingCopy: 'shared' })
      if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'No thread was created.')
      return thread.activeThreadId
    }, project)

    await openThreads(page)
    await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Lighthouse survey', exact: true }).click()
    const pane = page.locator('section.thread-pane:not([data-hidden])')
    await expect(pane).toHaveAttribute('data-thread-id', threadId)
    const transcript = pane.getByLabel('Thread transcript')
    await fillPrompt(promptField(pane), 'Survey every lighthouse on the Atlantic coast.')
    await promptField(pane).press('Enter')
    await expect.poll(() => prompts(claude), { timeout: 30_000 }).toBe(1)
    const [launch] = await fakeClaudeLaunches(claude)
    const control = join(claude, `control-${launch!.session}.json`)
    const act = async (action: Record<string, unknown>): Promise<void> => {
      await writeProviderAction(control, action)
      await expect.poll(() => existsSync(control), { timeout: 10_000 }).toBe(false)
    }
    // The turn's last model request, 54½ minutes ago, read 250,000 tokens of context.
    const model = JSON.parse(await readFile(join(claude, `settings-${launch!.session}.json`), 'utf8')).model as string
    await act({ type: 'raw', persist: true, frame: { type: 'assistant', uuid: randomUUID(), session_id: launch!.session, timestamp: new Date(Date.now() - 54.5 * 60_000).toISOString(),
      message: { id: randomUUID(), role: 'assistant', model, content: [{ type: 'text', text: 'Surveyed 212 lighthouses.' }],
        usage: { input_tokens: 4, cache_read_input_tokens: 240_000, cache_creation_input_tokens: 9_996, output_tokens: 40 } } } })
    await act({ type: 'raw', frame: { type: 'result', subtype: 'success', session_id: launch!.session, is_error: false, result: 'Surveyed 212 lighthouses.' } })
    await expect(transcript.getByText('Surveyed 212 lighthouses.')).toBeVisible({ timeout: 30_000 })

    // Nobody presses anything: Sotto's own sweep, every 30 seconds, sends /compact.
    await expect.poll(() => compactions(claude), { timeout: 75_000 }).toBe(1)
    await act({ type: 'raw', frame: { type: 'system', subtype: 'compact_boundary', session_id: launch!.session, uuid: randomUUID(), compact_metadata: { trigger: 'manual', pre_tokens: 250_000, post_tokens: 41_000 } } })
    await act({ type: 'raw', frame: { type: 'result', subtype: 'success', session_id: launch!.session, is_error: false, result: '' } })
    const line = pane.getByRole('status').filter({ hasText: 'Sotto compacted this idle thread before its cache expired.' })
    await expect(line).toBeVisible({ timeout: 30_000 })
    const turnOff = pane.getByRole('button', { name: 'Turn off idle compaction in Settings' })
    await expect(turnOff).toBeVisible()
    expect(await page.evaluate(() => window.sotto!.agents!.get().then(state => state.error ?? null))).toBeNull()

    for (const [width, height] of [[1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await expect(line).toBeVisible()
        expect(await pane.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
        await page.screenshot({ path: join(evidence, `thread-${appearance}-${width}.png`), animations: 'disabled' })
      }
    }

    // The quiet stretch is compacted once: another sweep sends nothing.
    await page.waitForTimeout(35_000)
    expect(await compactions(claude)).toBe(1)

    // Turn off, by keyboard: Claude Code's page, with the switch in focus, and Space turns it off.
    await resizeWindow(launched, 1280, 800)
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
    await turnOff.focus()
    await page.keyboard.press('Enter')
    const toggle = page.getByRole('switch', { name: 'Compact idle threads' })
    await expect(toggle).toBeFocused({ timeout: 10_000 })
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await page.screenshot({ path: join(evidence, 'settings-claude-code-1280.png'), animations: 'disabled' })
    await page.keyboard.press('Space')
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect.poll(() => page.evaluate(() => window.sotto!.getSettings().then(settings => settings.compactIdleThreads))).toBe(false)
    for (const [width, height] of [[820, 560]] as const) {
      await resizeWindow(launched, width, height)
      await expect(toggle).toBeVisible()
      await page.screenshot({ path: join(evidence, `settings-claude-code-off-${width}.png`), animations: 'disabled' })
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
