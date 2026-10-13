import { fillPrompt, promptField } from './support/prompt'
/**
 * Resuming threads after a restart (ADR-0076) in the built app, on the Owl track, with the real Claude adapter over the
 * fake CLI in `tests/fixtures/` (`SOTTO_E2E_NATIVE_FIXTURE_ROOT` in `src/main/index.ts`). A turn is still running when
 * Sotto quits; when Sotto opens again, the session is resumed and sent the resume note, which the thread shows as
 * Sotto's with the Resumed tag, word for word.
 *
 *   npm run build && npx playwright test tests/e2e/restart-resume.spec.ts
 */
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { RESUME_NOTE } from '../../src/shared/restartResume'
import { evidenceDirectory } from '../fixtures/evidence'
import { fakeClaudeLaunches, fakeClaudePrompts as prompts, fakeClaudeSessionFolder } from '../fixtures/fakeClaudeRecords'
import { writeProviderAction } from '../fixtures/providerRecords'
import { onReleaseTrack } from './support/releaseTrack'
import { closeSotto, launchSotto, openPage, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/restart-resume')
const recorded = async (profile: string): Promise<string[]> => {
  const file = await readFile(join(profile, 'restart-resume.json'), 'utf8').catch(() => '{"working":[]}')
  return (JSON.parse(file) as { working: { threadId: string }[] }).working.map(item => item.threadId)
}
async function openThread(page: Page, title: string) {
  await openThreads(page)
  await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: title, exact: true }).click()
  const pane = page.locator('section.thread-pane:not([data-hidden])')
  return { pane, transcript: pane.getByLabel('Thread transcript') }
}

test('a thread working when Sotto quits carries on, with the resume note, when Sotto opens again', async () => {
  test.setTimeout(240_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-restart-resume-' })).directory
  const root = join(profile, 'native-fixture')
  const claude = join(root, 'claude')
  const project = join(root, 'project')
  for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
  await mkdir(evidence, { recursive: true })
  const previous = { root: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, executable: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE }
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  let launched: LaunchedSotto | undefined
  try {
    await onReleaseTrack('owl', async () => {
      launched = await launchSotto('success', profile)
      let page = launched.page
      await page.evaluate(async () => {
        await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' })
        const configured = await window.sotto!.agents!.command({ type: 'configure', patch: { provider: 'claude', enabled: true, enabledProviders: ['claude'] } })
        if (configured.error) throw new Error(configured.error)
        const connected = await window.sotto!.agents!.command({ type: 'connect', provider: 'claude' })
        if (connected.error) throw new Error(connected.error)
      })
      await page.reload()
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
      // The window names threads by host; the record keeps the local host's own thread ID.
      const recordId = threadId.slice(threadId.lastIndexOf(':') + 1)

      // The setting is there, on, in Settings → Application.
      await openPage(page, 'Settings')
      await page.getByRole('tab', { name: 'Application', exact: true }).click()
      await expect(page.getByRole('switch', { name: 'Resume threads after a restart' })).toBeChecked()

      // A turn starts and is still running: the fake CLI holds it open.
      const { pane } = await openThread(page, 'Lighthouse essay')
      await expect(pane).toHaveAttribute('data-thread-id', threadId)
      const prompt = promptField(pane)
      await fillPrompt(prompt, 'Write a long essay on the history of the lighthouse.')
      await prompt.press('Enter')
      await expect.poll(() => prompts(claude), { timeout: 30_000 }).toBe(1)
      await expect.poll(() => recorded(profile), { timeout: 30_000 }).toEqual([recordId])

      // Sotto quits mid-turn. Closing stops the CLI, and the record keeps the thread.
      await launched.app.close()
      launched = undefined
      expect(await recorded(profile)).toEqual([recordId])

      // Sotto opens again: the session is resumed and sent the note, once.
      launched = await launchSotto('success', profile)
      page = launched.page
      await expect.poll(() => prompts(claude), { timeout: 60_000 }).toBe(2)
      const launches = await fakeClaudeLaunches(claude)
      expect(launches.at(-1)!.resume).toBe(true)
      expect(launches.at(-1)!.session).toBe(launches[0]!.session)
      const log = await readFile(join(fakeClaudeSessionFolder(claude, project), `${launches[0]!.session}.jsonl`), 'utf8')
      const sent = log.trim().split('\n').map(line => JSON.parse(line) as { type?: string; message?: { content?: unknown } })
        .filter(frame => frame.type === 'user').map(frame => typeof frame.message?.content === 'string' ? frame.message.content
          : (frame.message?.content as { type: string; text?: string }[] | undefined)?.find(item => item.type === 'text')?.text)
      expect(sent).toEqual(['Write a long essay on the history of the lighthouse.', RESUME_NOTE])

      const { transcript } = await openThread(page, 'Lighthouse essay')
      const note = transcript.locator('.thread-message[data-from="sotto"]')
      await expect(note).toHaveCount(1, { timeout: 30_000 })
      await expect(note.locator('.thread-message__tag')).toHaveText('Resumed')
      await expect(note).toContainText(RESUME_NOTE)
      await expect.poll(() => recorded(profile)).toEqual([recordId])

      for (const [width, height] of [[1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
          await note.scrollIntoViewIfNeeded()
          expect(await transcript.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
          // Two of the four are the evidence the verification note names.
          if ((appearance === 'dark') === (width === 1280)) await page.screenshot({ path: join(evidence, `resumed-${appearance}-${width}.png`), animations: 'disabled' })
        }
      }

      // The resumed turn finishes, and the thread leaves the record.
      await writeProviderAction(join(claude, `control-${launches[0]!.session}.json`), { type: 'complete', text: 'The test run was cut off, so I ran it again. It passes.' })
      await expect(transcript.getByText('The test run was cut off, so I ran it again. It passes.')).toBeVisible({ timeout: 30_000 })
      await expect.poll(() => recorded(profile), { timeout: 30_000 }).toEqual([])
      expect(await readFile(join(claude, 'violations.jsonl'), 'utf8').catch(() => '')).toBe('')
      await writeFile(test.info().outputPath('restart-resume.json'), JSON.stringify({ sent }, null, 2))
    })
  } finally {
    if (launched) await closeSotto(launched)
    for (const [key, value] of [['SOTTO_E2E_NATIVE_FIXTURE_ROOT', previous.root], ['SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE', previous.executable]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    await removeOwnedE2EProfile(profile)
  }
})
