import { fillPrompt, promptField } from './support/prompt'
/**
 * Resuming threads after a restart (ADR-0076) in the built app, on the Owl track, with the real Claude adapter over the
 * fake CLI in `tests/fixtures/` (`SOTTO_E2E_NATIVE_FIXTURE_ROOT` in `src/main/index.ts`). A turn is still running when
 * Sotto quits; when Sotto opens again, the session is resumed and sent the resume note, which the thread shows as
 * Sotto's with the Resumed tag, word for word. The same holds for the real Codex adapter over the fake app-server, whose
 * thread is reported idle before its turns are read back.
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
import { parseProviderRecords, writeProviderAction } from '../fixtures/providerRecords'
import { onReleaseTrack } from './support/releaseTrack'
import { closeSotto, launchSotto, openPage, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/restart-resume')
const recorded = async (profile: string): Promise<string[]> => {
  const file = await readFile(join(profile, 'restart-resume.json'), 'utf8').catch(() => '{"working":[]}')
  return (JSON.parse(file) as { working: { threadId: string }[] }).working.map(item => item.threadId)
}
/** A fresh profile whose app finds the fake CLIs under its `native-fixture` folder, and how to put everything back. */
async function nativeFixtureProfile() {
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-restart-resume-' })).directory
  const root = join(profile, 'native-fixture')
  for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
  const previous = { SOTTO_E2E_NATIVE_FIXTURE_ROOT: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE }
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  const restore = async (): Promise<void> => {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    await removeOwnedE2EProfile(profile)
  }
  return { profile, root, project: join(root, 'project'), restore }
}
async function openThread(page: Page, title: string) {
  await openThreads(page)
  await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: title, exact: true }).click()
  const pane = page.locator('section.thread-pane:not([data-hidden])')
  return { pane, transcript: pane.getByLabel('Thread transcript') }
}

test('a thread working when Sotto quits carries on, with the resume note, when Sotto opens again', async () => {
  test.setTimeout(240_000)
  const { profile, root, project, restore } = await nativeFixtureProfile()
  const claude = join(root, 'claude')
  await mkdir(evidence, { recursive: true })
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
      const sent = parseProviderRecords<{ type?: string; message?: { content?: unknown } }>(log)
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
    await restore()
  }
})

/** The Codex requests Sotto made, in order: the fake app-server's journal of every frame it was sent. */
const codexRequests = async (codex: string) =>
  parseProviderRecords<{ method?: string; params?: Record<string, unknown> }>(await readFile(join(codex, 'requests.jsonl'), 'utf8').catch(() => ''))
const codexPrompts = async (codex: string): Promise<string[]> => (await codexRequests(codex)).filter(request => request.method === 'turn/start')
  .map(request => (request.params?.input as { type: string; text?: string }[] | undefined)?.find(item => item.type === 'text')?.text ?? '')

test('a Codex thread working when Sotto quits is sent the resume note when Sotto opens again', async () => {
  test.setTimeout(240_000)
  const { profile, root, project, restore } = await nativeFixtureProfile()
  const codex = join(root, 'codex')
  // No scripted reply: the fake app-server holds each turn open until the test completes it.
  await writeFile(join(codex, 'script.json'), '{}')
  let launched: LaunchedSotto | undefined
  try {
    await onReleaseTrack('owl', async () => {
      launched = await launchSotto('success', profile)
      let page = launched.page
      const threadId = await page.evaluate(async path => {
        await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' })
        const agents = window.sotto!.agents!
        const configured = await agents.command({ type: 'configure', patch: { provider: 'codex', enabled: true, enabledProviders: ['codex'], checkClientUpdates: false } })
        if (configured.error) throw new Error(configured.error)
        const connected = await agents.command({ type: 'connect', provider: 'codex' })
        if (connected.error) throw new Error(connected.error)
        const created = await agents.command({ type: 'create-project', provider: 'codex', title: 'Harbour', path, useExisting: true })
        if (created.error) throw new Error(created.error)
        const projectId = created.host.projects.find(item => item.title === 'Harbour')!.id
        const model = (await agents.get()).host.models.find(item => item.providerId === 'codex' && item.ready)
        if (!model) throw new Error('No ready Codex model.')
        const thread = await agents.command({ type: 'create-thread', projectId, title: 'Tide tables', titleSource: 'user', modelId: model.id, workingCopy: 'shared' })
        if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'No thread was created.')
        const sent = await agents.command({ type: 'manual-send', threadId: thread.activeThreadId, text: 'Work out next week’s tide tables.' })
        if (sent.error) throw new Error(sent.error)
        return thread.activeThreadId
      }, project)
      const recordId = threadId.slice(threadId.lastIndexOf(':') + 1)
      await expect.poll(() => codexPrompts(codex), { timeout: 30_000 }).toEqual(['Work out next week’s tide tables.'])
      await expect.poll(() => recorded(profile), { timeout: 30_000 }).toEqual([recordId])

      // Sotto quits mid-turn, and its app-servers with it.
      await launched.app.close()
      launched = undefined
      expect(await recorded(profile)).toEqual([recordId])
      // A new Codex app-server reads a turn whose app-server went back as interrupted, and the thread idle.
      const statePath = join(codex, 'state.json')
      const state = JSON.parse(await readFile(statePath, 'utf8')) as { threads: Record<string, { status: unknown; turns: { status: string }[] }> }
      const native = Object.values(state.threads)
      expect(native).toHaveLength(1)
      expect(native[0]!.turns.at(-1)!.status).toBe('inProgress')
      native[0]!.turns.at(-1)!.status = 'interrupted'; native[0]!.status = { type: 'idle' }
      await writeFile(statePath, JSON.stringify(state))

      // Sotto opens again: the thread is sent the note, once, and nothing waits unsent in its queue.
      launched = await launchSotto('success', profile)
      page = launched.page
      await expect.poll(() => codexPrompts(codex), { timeout: 60_000 }).toEqual(['Work out next week’s tide tables.', RESUME_NOTE])
      await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).followups ?? []), { timeout: 30_000 }).toEqual([])

      // The resumed turn finishes, and the thread leaves the record.
      const nativeId = Object.keys(state.threads)[0]!
      await writeProviderAction(join(codex, 'control.json'), { type: 'complete', threadId: nativeId, text: 'The tide tables are done.' })
      const { transcript } = await openThread(page, 'Tide tables')
      await expect(transcript.getByText('The tide tables are done.')).toBeVisible({ timeout: 30_000 })
      await expect.poll(() => recorded(profile), { timeout: 30_000 }).toEqual([])
      expect(await codexPrompts(codex)).toHaveLength(2)
    })
  } finally {
    if (launched) await closeSotto(launched)
    await restore()
  }
})
