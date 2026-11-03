import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, type Locator, type Page } from '@playwright/test'
import { evidenceDirectory } from '../../fixtures/evidence'
import { ownedE2EProfile, removeOwnedE2EProfile } from './e2eProfile'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './sottoLaunch'

/** The picture the inline-media journeys show: a 1920 by 1203 screenshot of the viewer. */
export const SHOWN_PICTURE = resolve('artifacts/image-viewer/viewer-1280-dark.png')

/** A Codex thread over the fake app server whose turn wrote `test-results/checkout.png` and ended, opened at 1280x800. */
export interface ShownPictureThread {
  readonly launched: LaunchedSotto
  readonly page: Page
  /** The open thread pane. */
  readonly pane: Locator
  /** Sotto's ID for the thread, which `show_in_thread` is called for. */
  readonly threadId: string
  /** The fixture's folder and the thread's project, for a journey that plays a further turn. */
  readonly root: string
  readonly project: string
}

/**
 * Runs `journey` in a Codex thread over the fake app server (ADR-0170): its turn writes a screenshot into the project's
 * git-ignored `test-results/` and ends with "Here is the checkout page.", which shows nothing of its own with **Show every
 * picture and video an agent makes** off, as it is here unless `everyPicture` says otherwise. The journey shows it through
 * `sotto_media`'s show_in_thread, as an agent does when the user asks to see it. The profile, the fixture and the
 * environment are put back afterwards.
 */
export async function withShownPictureThread(prefix: string, journey: (thread: ShownPictureThread) => Promise<void>, options: { readonly everyPicture?: boolean } = {}): Promise<void> {
  const profile = (await ownedE2EProfile({ prefix })).directory
  const root = join(profile, 'native-fixture')
  const project = join(root, 'project')
  for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: project })
  await writeFile(join(project, '.gitignore'), 'test-results/\n')
  await writeFile(join(root, 'codex', 'script.json'), JSON.stringify({}))
  const previous = { root: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, executable: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE, owl: process.env.SOTTO_OWL_FEATURES }
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  process.env.SOTTO_OWL_FEATURES = 'inline-media=1'
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    const threadId = await page.evaluate(async ({ project, everyPicture }) => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', showEveryAgentPicture: everyPicture })
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { provider: 'codex', enabled: true, enabledProviders: ['codex'], checkClientUpdates: false } })
      await agents.command({ type: 'connect', provider: 'codex' })
      const created = await agents.command({ type: 'create-project', provider: 'codex', title: 'Lumen shop', path: project, useExisting: true })
      const projectId = created.host.projects.find(item => item.title === 'Lumen shop')!.id
      const modelId = (await agents.get()).host.models.find(model => model.providerId === 'codex' && model.ready)!.id
      const thread = await agents.command({ type: 'create-thread', projectId, title: 'Check the checkout page', titleSource: 'user', modelId, workingCopy: 'shared' })
      if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'No thread was created.')
      const sent = await agents.command({ type: 'manual-send', threadId: thread.activeThreadId, text: 'Take a screenshot of the checkout page.' })
      if (sent.error) throw new Error(sent.error)
      return thread.activeThreadId
    }, { project, everyPicture: options.everyPicture === true })
    const nativeThread = async () => {
      const state = JSON.parse(await readFile(join(root, 'codex', 'state.json'), 'utf8')) as { threads: Record<string, { id: string; turns: { id: string }[] }> }
      const thread = Object.values(state.threads)[0]
      return thread?.turns.at(-1) ? thread.id : undefined
    }
    await expect.poll(nativeThread, { timeout: 60_000 }).toBeTruthy()
    const native = (await nativeThread())!
    await mkdir(join(project, 'test-results'), { recursive: true })
    await copyFile(SHOWN_PICTURE, join(project, 'test-results', 'checkout.png'))
    const id = randomUUID()
    await writeFile(join(root, 'codex', 'control.json'), JSON.stringify({ id, threadId: native, type: 'complete', text: 'Here is the checkout page.' }))
    await expect.poll(async () => (await readFile(join(root, 'codex', 'actions.jsonl'), 'utf8').catch(() => '')).includes(id), { timeout: 30_000 }).toBe(true)

    await page.reload()
    await resizeWindow(launched, 1280, 800)
    await openThreads(page)
    await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Check the checkout page', exact: true }).click()
    const pane = page.locator('section.thread-pane:not([data-hidden])')
    await expect(pane.getByText('Here is the checkout page.')).toBeVisible({ timeout: 30_000 })
    await journey({ launched, page, pane, threadId, root, project })
  } finally {
    if (launched) await closeSotto(launched)
    for (const [key, value] of [['SOTTO_E2E_NATIVE_FIXTURE_ROOT', previous.root], ['SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE', previous.executable], ['SOTTO_OWL_FEATURES', previous.owl]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    await removeOwnedE2EProfile(profile)
  }
}

/** Where the inline-media journeys' captures go: `artifacts/e2e-runs/inline-media/`, or `artifacts/inline-media/` when published (docs/ci.md). */
const CAPTURES = evidenceDirectory('artifacts/inline-media')

/** Saves a capture of the page as `name`.png with the run's evidence. */
export async function captureInlineMedia(page: Page, name: string): Promise<void> {
  await mkdir(CAPTURES, { recursive: true })
  await page.screenshot({ path: join(CAPTURES, `${name}.png`) })
}
