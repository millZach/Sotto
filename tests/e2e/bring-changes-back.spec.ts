/**
 * Bring changes to <branch> (#1030) as the window shows it, Zach's pick B of the continue prototype (in place), on the Owl
 * track with the real Claude and Codex adapters over the fake CLIs in `tests/fixtures/` and a real Git repository. A Claude
 * thread on the shared project folder delegates to a Codex thread in a new worktree made from `main`; the Codex thread's
 * commits come back to `main` from the strip above its composer and from the Git action's menu: a fast-forward, then the
 * merge-commit question with Not now and yes, then a conflict refused in Git's own words.
 *
 *   npm run build && npx playwright test tests/e2e/bring-changes-back.spec.ts
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { initializeGitRepository } from '../fixtures/gitRepository'
import { pageBoundProblems } from './support/designCapture'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { e2eGit as git } from './support/git'
import { onReleaseTrack } from './support/releaseTrack'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'
import { textContrast } from './support/textContrast'

const evidence = evidenceDirectory('artifacts/bring-changes-back')
const PARENT = 'WAV preview stall'
const CHILD = 'WAV mid-chunk test'
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const

/** A fresh profile whose app finds the fake CLIs, each answering every turn at once, and a project that is a Git repository. */
async function fixtureProfile() {
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-bring-back-' })).directory
  const root = join(profile, 'native-fixture'), project = join(root, 'project')
  for (const folder of ['claude', 'codex']) await mkdir(join(root, folder), { recursive: true })
  await writeFile(join(root, 'claude', 'script.json'), JSON.stringify({ reply: 'I’ll have Codex add the test.' }))
  await writeFile(join(root, 'codex', 'script.json'), JSON.stringify({ reply: 'Added the test and fixed the dropped chunk, in one commit.' }))
  await initializeGitRepository(project, { files: { 'wavStream.ts': 'export const chunk = 4096\nexport const flush = true\n' }, message: 'Baseline', identity: { name: 'Sotto E2E', email: 'e2e@sotto.invalid' } })
  const previous = { SOTTO_E2E_NATIVE_FIXTURE_ROOT: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE }
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  const restore = async (): Promise<void> => {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    await removeOwnedE2EProfile(profile)
  }
  return { profile, project, restore }
}

/** Claude and Codex connected, the project, and a Claude thread on the shared project folder that has had a reply. */
async function parentThread(page: Page, project: string): Promise<string> {
  return page.evaluate(async ({ path, title }) => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
    const agents = window.sotto!.agents!
    const configured = await agents.command({ type: 'configure', patch: { provider: 'claude', enabled: true, enabledProviders: ['claude', 'codex'], checkClientUpdates: false } })
    if (configured.error) throw new Error(configured.error)
    for (const provider of ['claude', 'codex'] as const) {
      const connected = await agents.command({ type: 'connect', provider })
      if (connected.error) throw new Error(connected.error)
    }
    const created = await agents.command({ type: 'create-project', provider: 'claude', title: 'Harbour', path, useExisting: true })
    if (created.error) throw new Error(created.error)
    const projectId = created.host.projects.find(item => item.title === 'Harbour')!.id
    const model = (await agents.get()).host.models.find(item => item.providerId === 'claude' && item.ready)
    if (!model) throw new Error('No ready Claude model.')
    const thread = await agents.command({ type: 'create-thread', projectId, title, titleSource: 'user', modelId: model.id, workingCopy: 'shared', runtimeMode: 'approval-required' })
    if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'No thread was created.')
    const sent = await agents.command({ type: 'manual-send', threadId: thread.activeThreadId, text: 'The WAV preview stalls when a stream ends mid-chunk. Have Codex add a test and fix it.' })
    if (sent.error) throw new Error(sent.error)
    return thread.activeThreadId
  }, { path: project, title: PARENT })
}

type ToolResult = { status: string; delegation?: { id: string; thread: string }; models?: { provider: string; model: string; efforts: string[] }[]; code?: string; message?: string }
const tool = (page: Page, threadId: string, name: 'delegate' | 'read_delegation', args: Record<string, unknown>): Promise<ToolResult> =>
  page.evaluate(async ({ threadId, name, args }) => {
    const result = await window.sottoE2E!.delegationTool!({ threadId, name, arguments: args })
    const text = result.content.find(item => item.type === 'text')
    return JSON.parse(text && 'text' in text ? text.text : '{}') as ToolResult
  }, { threadId, name, args })

type Facts = { status: string | undefined; folder: string | undefined; ready: boolean; branch: string | undefined; worktree: string | undefined; error?: string }
const facts = (page: Page, threadId: string): Promise<Facts> => page.evaluate(async threadId => {
  const thread = (await window.sotto!.agents!.get()).host.threads.find(item => item.id === threadId)
  return { status: thread?.status, folder: thread?.worktree?.path, ready: thread?.worktree?.status === 'ready', branch: thread?.worktree?.git?.branch ?? thread?.worktree?.branch,
    worktree: thread?.worktree?.status, ...(thread?.worktree?.error ? { error: thread.worktree.error } : {}) }
}, threadId)
/** The host reads both threads' folders again, as the window's own refresh does. */
const refresh = (page: Page, ...threadIds: string[]): Promise<void> => page.evaluate(async ids => {
  for (const threadId of ids) await window.sotto!.agents!.command({ type: 'refresh-thread-worktree', threadId })
}, threadIds)
const commit = async (folder: string, file: string, text: string, message: string): Promise<string> => {
  await writeFile(join(folder, file), text)
  git(folder, 'add', file); git(folder, 'commit', '-qm', message)
  return git(folder, 'rev-parse', 'HEAD')
}

const pane = (page: Page) => page.locator('section.thread-pane:not([data-hidden])')
const strip = (page: Page): Locator => pane(page).locator('.bring-back')

/** Every size and both appearances: nothing wider than the window, the strip's text at 4.5:1 or better, and a capture. */
async function judge(launched: LaunchedSotto, name: string, checks: unknown[]): Promise<void> {
  const { page } = launched
  await mkdir(evidence, { recursive: true })
  for (const [width, height] of SIZES) for (const appearance of ['dark', 'light'] as const) {
    await resizeWindow(launched, width, height)
    await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
    await expect(strip(page)).toBeVisible()
    expect(await pageBoundProblems(page), `${name} ${width}x${height} ${appearance}`).toEqual([])
    expect(await strip(page).evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    const contrast = await textContrast(pane(page), '.bring-back__text p, .bring-back__text strong, .bring-back__git-said, .bring-back .tt-button', true)
    expect(contrast.length).toBeGreaterThan(0)
    const lowest = Math.min(...contrast.map(item => item.ratio))
    expect(lowest, `${name} ${width}x${height} ${appearance}: ${JSON.stringify(contrast.filter(item => item.ratio < 4.5))}`).toBeGreaterThanOrEqual(4.5)
    checks.push({ name, width, height, appearance, lowestContrast: lowest })
    await page.mouse.move(2, 2)
    await page.screenshot({ path: join(evidence, `${name}-${width}x${height}-${appearance}.png`), animations: 'disabled' })
  }
  await resizeWindow(launched, 1280, 800)
  await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
}

test('a delegated thread brings its commits to main: a fast-forward, the merge-commit question, and a conflict refused', async () => {
  test.setTimeout(300_000)
  const { profile, project, restore } = await fixtureProfile()
  let launched: LaunchedSotto | undefined
  const checks: unknown[] = []
  try {
    await onReleaseTrack('owl', async () => {
      launched = await launchSotto('success', profile)
      const { page } = launched
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const parentId = await parentThread(page, project)
      await expect.poll(async () => (await facts(page, parentId)).status, { timeout: 30_000 }).toBe('idle')

      // The parent hands the work to Codex in a new worktree; it starts from main, the branch the parent is on.
      const listing = await tool(page, parentId, 'read_delegation', {})
      const model = listing.models?.find(item => item.provider === 'codex')
      expect(model, JSON.stringify(listing)).toBeDefined()
      const delegated = await tool(page, parentId, 'delegate', { work: 'building', title: CHILD, brief: 'Add a test for a stream that ends mid-chunk, and fix what it finds.',
        provider: 'codex', model: model!.model, ...model!.efforts.length ? { effort: model!.efforts[0] } : {}, permission: 'approval-required', working_copy: 'independent', wait_seconds: 0 })
      expect(delegated.status, JSON.stringify(delegated)).toBe('ok')
      // The window names threads its own way; the delegated thread is the one the parent delegated to.
      let childId = ''
      await expect.poll(async () => {
        childId = await page.evaluate(async parentId => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.delegatedBy === parentId)?.id ?? '', parentId)
        return childId
      }, { timeout: 30_000 }).not.toBe('')
      await expect.poll(() => facts(page, childId), { timeout: 60_000 }).toMatchObject({ ready: true, status: 'idle' })
      const folder = (await facts(page, childId)).folder!
      // The worktree's temporary branch takes the name the thread's provider writes from its first message (ADR-0014).
      await expect.poll(() => git(folder, 'branch', '--show-current'), { timeout: 30_000 }).not.toMatch(/^sotto\/[0-9a-f]{8}$/u)
      const branch = git(folder, 'branch', '--show-current')
      expect(git(folder, 'rev-parse', 'HEAD')).toBe(git(project, 'rev-parse', 'main'))

      // The agent's work, committed in its worktree.
      const first = await commit(folder, 'wavStream.test.ts', 'test("a stream that ends mid-chunk", () => {})\n', 'Test a stream that ends mid-chunk')
      await refresh(page, childId, parentId)
      await page.reload()
      await openThreads(page)
      await resizeWindow(launched, 1280, 800)
      await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: CHILD, exact: true }).click()
      await expect(pane(page).locator('.thread-workspace__head h2')).toHaveText(CHILD)

      // The strip: what this branch came from, where main is checked out, and the press named for main.
      const offer = pane(page).getByRole('region', { name: 'Bring changes back' })
      await expect(offer).toHaveText(`${branch} was made from main. main is checked out in the project folder, where ${PARENT} works.Bring changes to main`, { timeout: 30_000 })
      await judge(launched, 'ready', checks)

      // By keyboard: the press fast-forwards main, and the outcome takes the strip's place and the focus.
      await offer.getByRole('button', { name: 'Bring changes to main' }).focus()
      await page.keyboard.press('Enter')
      const fastForward = pane(page).getByRole('status', { name: 'Brought 1 commit to main.' })
      await expect(fastForward).toBeFocused({ timeout: 30_000 })
      await expect(fastForward).toContainText(`Git fast-forwarded main to ${first.slice(0, 7)}; nothing else changed. ${PARENT} works on main in the project folder and sees them now.`)
      expect(git(project, 'rev-parse', 'main')).toBe(first)
      expect(await readFile(join(project, 'wavStream.test.ts'), 'utf8')).toContain('mid-chunk')
      await judge(launched, 'fast-forward', checks)
      await page.keyboard.press('Escape')
      await expect(fastForward).toHaveCount(0)

      // main moves on in the project folder while the worktree commits again: Git can't fast-forward, so Sotto asks.
      const second = await commit(folder, 'wavStream.ts', 'export const chunk = 4096\nexport const flush = true\nexport const keepPartial = true\n', 'Keep the last partial chunk')
      const meanwhile = await commit(project, 'NOTES.md', 'The stall reproduces on Windows only.\n', 'Note where the stall reproduces')
      await refresh(page, childId, parentId)
      // From the Git action's menu this time: the same press, first in the menu.
      await pane(page).getByRole('button', { name: 'More Git actions' }).click()
      const menu = page.getByRole('menu', { name: 'More Git actions' })
      await expect(menu.getByRole('menuitem').first()).toHaveText('Bring changes to main')
      await menu.getByRole('menuitem', { name: 'Bring changes to main' }).click()
      const question = pane(page).getByRole('group', { name: 'Make a merge commit on main?' })
      await expect(question).toContainText(`main has 1 commit that ${branch} doesn’t, so Git can’t fast-forward. Sotto can make a merge commit on main that brings in this branch’s 1 commit. Nothing is rebased or forced, and this worktree stays as it is.`, { timeout: 30_000 })
      await expect(question.getByRole('button', { name: 'Make merge commit' })).toBeFocused()
      expect(git(project, 'rev-parse', 'main')).toBe(meanwhile)
      await judge(launched, 'question', checks)
      // Escape is Not now: nothing changes, and the offer comes back with the focus.
      await question.getByRole('button', { name: 'Make merge commit' }).focus()
      await page.keyboard.press('Escape')
      await expect(question).toHaveCount(0)
      await expect(offer.getByRole('button', { name: 'Bring changes to main' })).toBeFocused()
      expect(git(project, 'rev-parse', 'main')).toBe(meanwhile)
      // Asked again, and this time yes, once the press that asked has finished.
      await page.keyboard.press('Enter')
      const yes = question.getByRole('button', { name: 'Make merge commit' })
      await expect(yes).toBeFocused({ timeout: 30_000 })
      await expect(yes).not.toHaveAttribute('aria-busy', 'true')
      await page.keyboard.press('Enter')
      const merged = pane(page).getByRole('status', { name: 'Brought 1 commit to main with a merge commit.' })
      await expect(merged).toBeVisible({ timeout: 30_000 })
      expect(git(project, 'rev-list', '--parents', '-n', '1', 'main').split(' ').slice(1)).toEqual([meanwhile, second])
      await expect(merged).toContainText(`Merge commit ${git(project, 'rev-parse', '--short=7', 'main')} on main: “Merge branch '${branch}' into main”.`)
      expect(git(project, 'status', '--porcelain')).toBe('')
      await judge(launched, 'merged', checks)
      await merged.getByRole('button', { name: 'Dismiss' }).click()

      // Both sides change the same line: Git finds a conflict, and Sotto resolves nothing.
      await commit(folder, 'wavStream.ts', 'export const chunk = 8192\nexport const flush = true\nexport const keepPartial = true\n', 'Read bigger chunks')
      const theirs = await commit(project, 'wavStream.ts', 'export const chunk = 2048\nexport const flush = true\nexport const keepPartial = true\n', 'Read smaller chunks')
      await refresh(page, childId, parentId)
      await offer.getByRole('button', { name: 'Bring changes to main' }).click()
      const conflict = pane(page).getByRole('alert', { name: 'Nothing was brought to main, and main is unchanged.' })
      await expect(conflict).toContainText('Git found a conflict, and Sotto doesn’t resolve conflicts. Ask this thread to merge main into its branch and resolve it, then try again. Git said:', { timeout: 30_000 })
      await expect(conflict.locator('.bring-back__git-said')).toHaveText('CONFLICT (content): Merge conflict in wavStream.ts')
      expect(git(project, 'rev-parse', 'main')).toBe(theirs)
      expect(git(project, 'status', '--porcelain')).toBe('')
      await judge(launched, 'conflict', checks)
      expect(errors).toEqual([])
    })
  } finally {
    await writeFile(join(evidence, 'checks.json'), JSON.stringify(checks, null, 2)).catch(() => undefined)
    if (launched) await closeSotto(launched)
    await restore()
  }
})
