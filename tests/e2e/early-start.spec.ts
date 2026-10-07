/**
 * Early start (#769, ADR-0055) in the built app. The real Claude adapter runs over the fake CLI in `tests/fixtures/`
 * (`SOTTO_E2E_NATIVE_FIXTURE_ROOT` in `src/main/index.ts`). Typing in a new thread's composer starts the CLI its first
 * send will use, before Send and without a session file; Send then runs on that CLI and starts no other.
 *
 *   npm run build && npx playwright test tests/e2e/early-start.spec.ts
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { fakeClaudeLaunches, fakeClaudePrompts as prompts, fakeClaudeSessionFiles as sessionFiles } from '../fixtures/fakeClaudeRecords'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

/** The fake CLI's thread launches, each by the session ID it was started on. */
const launches = async (root: string) => (await fakeClaudeLaunches(root)).map(({ resume, session }) => ({ resume, session }))

test('typing in a new Claude thread starts its CLI before Send, and Send starts no other', async () => {
  test.setTimeout(180_000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-early-start-'))
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
      const configured = await window.sotto!.agents!.command({ type: 'configure', patch: { provider: 'claude', enabled: true, enabledProviders: ['claude'], speak: false } })
      if (configured.error) throw new Error(configured.error)
      const connected = await window.sotto!.agents!.command({ type: 'connect', provider: 'claude' })
      if (connected.error) throw new Error(connected.error)
    })
    await page.reload()
    await resizeWindow(launched, 1280, 800)
    const threadId = await page.evaluate(async path => {
      const agents = window.sotto!.agents!
      const created = await agents.command({ type: 'create-project', provider: 'claude', title: 'Early start', path, useExisting: true })
      if (created.error) throw new Error(created.error)
      const projectId = created.host.projects.find(item => item.title === 'Early start')!.id
      const model = (await agents.get()).host.models.find(item => item.providerId === 'claude' && item.ready)
      if (!model) throw new Error('No ready Claude model.')
      const thread = await agents.command({ type: 'create-thread', projectId, title: 'Typed into first', titleSource: 'user', modelId: model.id, workingCopy: 'shared', managed: false })
      if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'No thread was created.')
      return thread.activeThreadId
    }, project)

    await openThreads(page)
    await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Typed into first', exact: true }).click()
    const pane = page.locator('section.thread-pane:not([data-hidden])')
    await expect(pane).toHaveAttribute('data-thread-id', threadId)
    // Nothing has started for a thread whose first send has not happened.
    expect(await launches(claude)).toEqual([])

    const prompt = pane.getByRole('textbox', { name: 'Prompt' })
    await prompt.click()
    await page.keyboard.type('Synthetic early start prompt')
    // The first keystrokes started the CLI the first send will use, and Claude Code has no session for it yet.
    await expect.poll(() => launches(claude), { timeout: 30_000 }).toEqual([{ resume: false, session: expect.any(String) }])
    const [spare] = await launches(claude)
    expect(await sessionFiles(claude)).toEqual([])
    expect(await prompts(claude)).toBe(0)

    await page.keyboard.press('Enter')
    await expect.poll(() => prompts(claude), { timeout: 30_000 }).toBe(1)
    await expect(pane.getByLabel('Thread transcript').getByText('Synthetic early start prompt')).toBeVisible({ timeout: 30_000 })
    // The send ran on the CLI typing started.
    expect(await launches(claude)).toEqual([spare])
    await expect.poll(() => sessionFiles(claude), { timeout: 30_000 }).toEqual([spare!.session])
    expect(await readFile(join(claude, 'violations.jsonl'), 'utf8').catch(() => '')).toBe('')
  } finally {
    if (launched) await closeSotto(launched)
    for (const [key, value] of [['SOTTO_E2E_NATIVE_FIXTURE_ROOT', previous.root], ['SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE', previous.executable]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})
