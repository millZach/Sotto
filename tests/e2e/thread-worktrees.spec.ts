import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { closeSotto, launchSotto, openPage, openThreads, userMessageTexts, type LaunchedSotto } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

const SHOTS = evidenceDirectory('artifacts/new-thread-setup')
/** The host reads these folders on its own timer, and Git's index lock is held for a moment each time; a test command that meets it tries again. */
const git = (cwd: string, ...args: string[]): string => {
  for (let attempt = 0; ; attempt += 1) {
    try { return execFileSync('git', ['-c', 'user.name=Sotto E2E', '-c', 'user.email=e2e@sotto.invalid', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim() }
    catch (error) {
      if (attempt >= 30 || !/index\.lock/u.test(error instanceof Error ? error.message : '')) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
}
const sameFolder = (left: string, right: string): boolean => left.replace(/[\\/]+$/, '').replace(/\\/gu, '/').toLowerCase() === right.replace(/[\\/]+$/, '').replace(/\\/gu, '/').toLowerCase()
const countWorktrees = (repo: string): number => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length
async function commitFile(repo: string, name: string, text: string): Promise<void> {
  await writeFile(join(repo, name), text)
  git(repo, 'add', name)
  git(repo, 'commit', '-q', '-m', `Add ${name}`)
}
async function activeThread(page: Page) {
  return page.evaluate(async () => {
    const state = await window.sotto!.agents!.get()
    return state.host.threads.find(thread => thread.id === state.activeThreadId)!
  })
}
async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
    window.setMinimumSize(800, 540)
    window.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => launched.page.evaluate(() => `${innerWidth}x${innerHeight}`)).toBe(`${width}x${height}`)
}
/** The chooser at each size, appearance and motion setting; there is no options form left to check (issue #347). */
async function captureMatrix(launched: LaunchedSotto, dialog: Locator): Promise<void> {
  await mkdir(SHOTS, { recursive: true })
  for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
    await resize(launched, width, height)
    for (const appearance of ['dark', 'light'] as const) {
      await launched.page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
      await expect(launched.page.locator('html')).toHaveAttribute('data-theme', appearance)
      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        await launched.page.emulateMedia({ reducedMotion })
        await expect.poll(() => launched.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await expect(dialog.getByRole('searchbox', { name: 'Search projects' })).toBeInViewport()
        await expect(dialog.getByRole('button', { name: 'Local folder', exact: false })).toBeInViewport()
        await launched.page.screenshot({ path: `${SHOTS}/new-worktree-${width}x${height}-${appearance}-${reducedMotion}.png`, animations: 'disabled' })
      }
    }
  }
  await launched.page.emulateMedia({ reducedMotion: 'no-preference' })
  await launched.page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
  await resize(launched, 1280, 800)
}
/**
 * The chooser opens a thread at once, on defaults, once a project is chosen (issue #347): there is no name
 * field to set at creation, so this renames the freshly opened "New thread" the way the old dialog's own
 * naming field once did, and every caller keeps working with a distinctly titled thread.
 */
async function createInstant(page: Page, project: string, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New thread', exact: true }).first().focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
  await expect(dialog.getByRole('searchbox', { name: 'Search projects' })).toBeFocused()
  await page.keyboard.type(project)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'New thread', exact: true })).toBeVisible()
  const projects = page.getByRole('region', { name: 'Projects' })
  await projects.getByRole('button', { name: 'New thread', exact: true }).hover()
  await projects.getByRole('button', { name: 'Rename New thread', exact: true }).click()
  await page.getByLabel('Rename New thread').fill(title)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await expect.poll(async () => (await activeThread(page))?.title).toBe(title)
}
/** The composer's branch toolbar for the active pane, T3's row under the prompt (ADR-0027). */
const toolbar = (page: Page) => page.getByRole('group', { name: 'Branch toolbar', exact: true })
/** The workspace chip on the toolbar: the draft's choice of checkout, new worktree or another thread's worktree. */
async function chooseWorkspace(page: Page, option: string | RegExp): Promise<void> {
  await toolbar(page).getByRole('combobox', { name: 'Choose workspace', exact: true }).click()
  await page.getByRole('listbox', { name: 'Workspace', exact: true }).getByRole('option', { name: option }).click()
}
/** Open the branch picker by its shortcut and wait for the refs to arrive. */
async function openPicker(page: Page): Promise<void> {
  await page.keyboard.press('Control+Shift+G')
  await expect(page.getByLabel('Search refs')).toBeFocused()
  // Refs, or the line that says there are none yet (a repository with no commits).
  await expect(page.locator('[role="listbox"][aria-label="Refs"] [role="option"], .branch-toolbar__empty').first()).toBeVisible()
}
async function createByKeyboard(page: Page, project: string, title: string, independent = false, repository = true): Promise<void> {
  await createInstant(page, project, title)
  // The toolbar appears once the host has read the folder; a draft on the shared checkout starts as Current checkout.
  // A folder without Git has no toolbar to show.
  if (repository) await expect(toolbar(page).getByRole('combobox', { name: 'Choose workspace', exact: true })).toHaveText(/Current checkout/)
  else await expect(toolbar(page)).toHaveCount(0)
  if (independent) {
    await chooseWorkspace(page, 'New worktree')
    await expect.poll(async () => (await activeThread(page)).worktree?.mode).toBe('independent')
    // Start from the local branch as it is, as the older Start from control's "local" choice did.
    await openPicker(page)
    await page.getByRole('switch', { name: /Start from origin/ }).click()
    await expect.poll(async () => (await activeThread(page)).worktree?.startFromOrigin).toBe(false)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('listbox', { name: 'Refs', exact: true })).toHaveCount(0)
  }
}
async function send(page: Page, text: string): Promise<void> {
  const id = (await activeThread(page)).id
  const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
  await prompt.fill(text)
  await prompt.press('Enter')
  await expect.poll(() => userMessageTexts(page, id)).toContain(text)
  await page.evaluate(async threadId => window.sottoE2E!.agentEvent!({ type: 'ready', threadId, status: 'idle', text: 'Fixture turn completed.' }), id)
  await expect.poll(async () => (await activeThread(page)).status).toBe('idle')
}
async function launch(folders: readonly (readonly [string, string])[]): Promise<LaunchedSotto> {
  const launched = await launchSotto()
  await launched.page.evaluate(async folders => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
    const agents = window.sotto!.agents!
    await agents.command({ type: 'configure', patch: { enabled: true, } })
    await agents.command({ type: 'connect' })
    for (const [title, path] of folders) await agents.command({ type: 'create-project', title, path, useExisting: true })
  }, folders)
  await launched.page.reload()
  await openThreads(launched.page)
  await resize(launched, 1280, 800)
  return launched
}

test('shared checkout is the default; independent worktrees are lazy, editable and reusable', async () => {
  test.setTimeout(180_000)
  const root = await mkdtemp(join(tmpdir(), 'sotto-e2e-worktrees-')), repo = join(root, 'repo-app')
  await mkdir(repo)
  git(repo, 'init', '-q')
  await commitFile(repo, 'README.md', 'Committed checkout\n')
  git(repo, 'branch', 'release')
  await writeFile(join(repo, 'README.md'), 'Uncommitted project edit\n')
  const initialWorktrees = git(repo, 'worktree', 'list', '--porcelain'), initialBranches = git(repo, 'branch', '--format=%(refname)')
  let launched: LaunchedSotto | undefined
  try {
    launched = await launch([['repo-app', repo]])
    const { page } = launched
    await createByKeyboard(page, 'repo-app', 'Shared first')
    const shared = await activeThread(page)
    expect(shared.worktree).toMatchObject({ mode: 'shared', status: 'ready' })
    expect(sameFolder(shared.workingDirectory!, repo)).toBe(true)
    expect(await readFile(join(shared.workingDirectory!, 'README.md'), 'utf8')).toBe('Uncommitted project edit\n')
    await send(page, 'Inspect the project as it stands.')
    await expect(page.getByRole('button', { name: 'Working copy: main', exact: true })).toBeVisible()
    // Once sent, Workspace and Run on read as static text; the picker keeps working.
    await expect(toolbar(page)).toContainText('Run on This computer')
    await expect(toolbar(page)).toContainText('Workspace Current checkout')
    await expect(toolbar(page).getByRole('combobox', { name: 'Choose workspace', exact: true })).toHaveCount(0)
    // The picker switches the shared checkout: a search, a pick, and the folder is on release. The sent branch
    // follows a switch made here, so no branch-changed notice appears for it.
    await openPicker(page)
    const refs = page.getByRole('listbox', { name: 'Refs', exact: true })
    await expect(refs.getByRole('option', { name: /^main/ })).toContainText('current')
    await page.keyboard.type('rel')
    await expect(refs.getByRole('option').first()).toHaveText(/^release/)
    await refs.getByRole('option', { name: /^release/ }).click({ button: 'right' })
    // Main's E2E output boundary keeps a private clipboard instead of writing the machine's clipboard.
    await expect.poll(() => page.evaluate(async () => (await window.sottoE2E!.snapshot()).clipboardText)).toBe('release')
    const search = page.getByLabel('Search refs')
    await search.fill('')
    await expect(refs.getByRole('option', { name: /^main/ })).toBeVisible()
    await mkdir(SHOTS, { recursive: true })
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resize(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance, reducedMotion: 'on' }), appearance)
        await expect(search).toBeInViewport()
        await expect(refs.getByRole('option', { name: /^main/ })).toBeInViewport()
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: `${SHOTS}/pkg25-branch-${width}x${height}-${appearance}.png`, animations: 'disabled' })
      }
    }
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark', reducedMotion: 'system' }))
    await resize(launched, 1280, 800)
    await search.fill('rel')
    await expect(refs.getByRole('option').first()).toHaveText(/^release/)
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      await search.evaluate((element, detail) => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...detail })), composition)
      await expect(search).toBeVisible()
      await search.evaluate((element, detail) => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, ...detail })), composition)
      await expect(refs).toBeVisible()
      await expect(search).toHaveValue('rel')
      expect(git(repo, 'branch', '--show-current')).toBe('main')
    }
    await page.keyboard.press('Enter')
    await expect.poll(() => git(repo, 'branch', '--show-current')).toBe('release')
    await expect(toolbar(page).getByRole('combobox', { name: 'Choose branch', exact: true })).toHaveText(/release/)
    await expect(page.getByRole('button', { name: 'Working copy: release', exact: true })).toBeVisible()
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Still no notice after a switch made here.')
    await expect(page.locator('.branch-notice')).toHaveCount(0)
    await expect.poll(async () => (await activeThread(page)).worktree?.sentBranch).toBe('release')
    // Create new ref: a name nothing matches becomes a branch from HEAD, checked out.
    await openPicker(page)
    await page.keyboard.type('feat/from picker')
    await expect(page.getByLabel('Search refs')).toHaveValue('feat/from picker')
    await refs.getByRole('option', { name: 'Create new ref “feat/from-picker”', exact: true }).click()
    await expect.poll(() => git(repo, 'branch', '--show-current')).toBe('feat/from-picker')
    await expect(toolbar(page).getByRole('combobox', { name: 'Choose branch', exact: true })).toHaveText(/feat\/from-picker/)
    // Git's refusal is shown in its words: a dirty file that the switch would overwrite.
    git(repo, 'checkout', '-q', 'main')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(toolbar(page).getByRole('combobox', { name: 'Choose branch', exact: true })).toHaveText(/main/)
    await writeFile(join(repo, 'README.md'), 'Conflicting edit\n'); git(repo, 'checkout', '-q', 'release'); await writeFile(join(repo, 'README.md'), 'Release edit\n'); git(repo, 'commit', '-qam', 'Release edit'); git(repo, 'checkout', '-q', 'main'); await writeFile(join(repo, 'README.md'), 'Uncommitted project edit\n')
    await openPicker(page)
    await refs.getByRole('option', { name: /^release/ }).click()
    await expect(toolbar(page).getByRole('alert')).toContainText('Failed to switch ref.')
    await expect(page.locator('.thread-workspace__error')).toHaveCount(0) // said once, under the row, not again by the pane
    expect(git(repo, 'branch', '--show-current')).toBe('main')
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('Uncommitted project edit\n')
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('')
    await createByKeyboard(page, 'repo-app', 'Shared second')
    expect(sameFolder((await activeThread(page)).workingDirectory!, repo)).toBe(true)
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(initialWorktrees)
    expect(git(repo, 'branch', '--format=%(refname)')).toBe(`refs/heads/feat/from-picker
${initialBranches}`) // only the picker's own branch was added

    // Opening the chooser and abandoning it (Escape, with no project chosen) creates nothing: no thread, no worktree.
    await page.getByRole('button', { name: 'New thread', exact: true }).first().focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
    await expect(dialog.getByRole('searchbox', { name: 'Search projects' })).toBeFocused()
    await page.screenshot({ path: `${SHOTS}/shared-default-dialog.png`, animations: 'disabled' })
    await captureMatrix(launched, dialog)
    await resize(launched, 820, 560)
    await page.screenshot({ path: `${SHOTS}/new-worktree-820x560-bottom.png`, animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await resize(launched, 1280, 800)
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(initialWorktrees)

    await createByKeyboard(page, 'repo-app', 'Changed before sending', true)
    expect((await activeThread(page)).worktree).toMatchObject({ mode: 'independent', status: 'pending' })
    await expect(page.getByRole('button', { name: 'Working copy: New worktree', exact: true })).toBeVisible()
    // The Workspace shortcut opens the chip; the choice goes back to the checkout without creating anything.
    await page.keyboard.press('Control+Shift+X')
    await expect(page.getByRole('listbox', { name: 'Workspace', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(toolbar(page).getByRole('combobox', { name: 'Choose workspace', exact: true })).toBeFocused()
    await chooseWorkspace(page, 'Current checkout')
    await expect.poll(async () => (await activeThread(page)).worktree?.mode).toBe('shared')
    await send(page, 'Use the existing project folder.')
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(initialWorktrees)

    await createByKeyboard(page, 'repo-app', 'Independent task', true)
    const pending = await activeThread(page)
    expect(pending).toMatchObject({ nativeSessionStarted: false, worktree: { mode: 'independent', status: 'pending', startFromOrigin: false } })
    expect(pending.worktree?.path).toBeUndefined()
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(initialWorktrees)
    await resize(launched, 820, 560)
    // At the minimum size the picker's panel stays inside the window, and a pick records the base without a checkout.
    await openPicker(page)
    const panel = page.getByRole('group', { name: 'Branches', exact: true })
    const panelBounds = await panel.boundingBox()
    expect(panelBounds!.x).toBeGreaterThanOrEqual(0)
    expect(panelBounds!.x + panelBounds!.width).toBeLessThanOrEqual(820)
    expect(panelBounds!.y).toBeGreaterThanOrEqual(0)
    expect(panelBounds!.y + panelBounds!.height).toBeLessThanOrEqual(560)
    await page.screenshot({ path: `${SHOTS}/branch-picker-820x560.png`, animations: 'disabled' })
    await page.getByRole('listbox', { name: 'Refs', exact: true }).getByRole('option', { name: /^release/ }).click()
    await expect.poll(async () => (await activeThread(page)).worktree?.baseBranch).toBe('release')
    await expect(toolbar(page).getByRole('combobox', { name: 'Choose branch', exact: true })).toHaveText(/From release/)
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(initialWorktrees)
    await resize(launched, 1280, 800)
    await send(page, 'Work independently from release.')
    const independent = await activeThread(page)
    expect(independent.worktree).toMatchObject({ mode: 'independent', status: 'ready', baseBranch: 'release' })
    const branch = independent.worktree!.branch!, worktreePath = independent.worktree!.path!
    expect(branch).toMatch(/^sotto\/[a-z0-9-]{1,20}$/u)
    expect(sameFolder(worktreePath, repo)).toBe(false)
    expect(await readFile(join(worktreePath, 'README.md'), 'utf8')).toMatch(/^Release edit\r?\n$/u) // release's own commit, made above
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('Uncommitted project edit\n')
    expect(git(repo, 'branch', '--show-current')).toBe('main')
    await page.getByRole('button', { name: `Working copy: ${branch}`, exact: true }).click()
    const details = page.getByRole('group', { name: 'Working copy details' })
    await details.getByRole('button', { name: 'Open folder', exact: true }).click()
    await expect.poll(async () => sameFolder((await page.evaluate(async () => (await window.sottoE2E!.snapshot()).openedThreadFolder)) ?? '', independent.workingDirectory!)).toBe(true)
    await details.press('Escape')

    git(worktreePath, 'checkout', '-q', '-b', 'feat/task-branch')
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Continue on the task branch.')
    await expect(page.getByRole('button', { name: 'Working copy: feat/task-branch', exact: true })).toBeVisible()
    await expect(page.locator('.branch-notice')).toHaveCount(0)
    await send(page, 'Continue on the task branch.')
    // Another thread's worktree is offered as Previous worktree, and the picker re-points a draft at the worktree
    // a branch is already checked out in rather than checking it out twice.
    await createByKeyboard(page, 'repo-app', 'Continue existing worktree')
    await openPicker(page)
    const busy = page.getByRole('listbox', { name: 'Refs', exact: true }).getByRole('option', { name: /^feat\/task-branch/ })
    await expect(busy).toContainText('worktree')
    await busy.click()
    await expect.poll(async () => (await activeThread(page)).worktree?.existingWorktreePath ?? '').not.toBe('')
    await expect(toolbar(page).getByRole('combobox', { name: 'Choose workspace', exact: true })).toHaveText('Previous worktree (feat/task-branch)')
    await expect(toolbar(page).getByRole('combobox', { name: 'Choose branch', exact: true })).toHaveText(/feat\/task-branch/)
    await openPicker(page)
    await expect(page.getByRole('listbox', { name: 'Refs', exact: true }).getByRole('option', { name: /^feat\/task-branch/ })).toContainText('current')
    await page.keyboard.press('Escape')
    await chooseWorkspace(page, 'Current checkout')
    await expect.poll(async () => (await activeThread(page)).worktree?.mode).toBe('shared')
    // The shortcut waits for the row to be free: a change still being confirmed keeps the chips disabled.
    await expect(toolbar(page).getByRole('combobox', { name: 'Choose workspace', exact: true })).toBeEnabled()
    await page.keyboard.press('Control+Shift+L')
    await expect.poll(async () => (await activeThread(page)).worktree?.existingWorktreePath ?? '').not.toBe('')
    await send(page, 'Continue in the existing working copy.')
    expect(sameFolder((await activeThread(page)).workingDirectory!, independent.workingDirectory!)).toBe(true)
    expect(countWorktrees(repo)).toBe(2)
    await page.reload()
    await expect.poll(async () => sameFolder((await activeThread(page)).workingDirectory!, independent.workingDirectory!)).toBe(true)
  } finally {
    if (launched) await closeSotto(launched)
    await rm(root, { recursive: true, force: true })
  }
})

test('shared branch notices survive pane remount dismissal and restore safely with a draft', async () => {
  test.setTimeout(120_000)
  const root = await mkdtemp(join(tmpdir(), 'sotto-e2e-branch-notices-')), repo = join(root, 'repo-app')
  await mkdir(repo)
  git(repo, 'init', '-q')
  await commitFile(repo, 'README.md', 'Original checkout\n')
  let launched: LaunchedSotto | undefined
  try {
    launched = await launch([['repo-app', repo]])
    const { page } = launched
    await createByKeyboard(page, 'repo-app', 'Shared branch task')
    await send(page, 'First turn on main.')
    git(repo, 'checkout', '-q', '-b', 'feat/other-task')
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('Keep this draft while inspecting the checkout.')
    const notice = page.locator('.branch-notice')
    await expect(notice).toContainText('Branch changed, was main.')
    await mkdir(SHOTS, { recursive: true })
    await page.screenshot({ path: `${SHOTS}/shared-branch-notice.png`, animations: 'disabled' })
    await notice.getByRole('button', { name: 'Dismiss the branch notice', exact: true }).click()
    await openPage(page, 'Settings')
    await openThreads(page)
    await expect(prompt).toHaveValue('Keep this draft while inspecting the checkout.')
    await expect(notice).toHaveCount(0)
    git(repo, 'checkout', '-q', '-b', 'feat/another-task')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(notice).toContainText('Sending will continue on feat/another-task.')
    await writeFile(join(repo, 'README.md'), 'Uncommitted changes survive a restore\n')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await notice.getByRole('button', { name: 'Restore branch main', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: 'Switch back to main?', exact: true })
    await expect(confirmation).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/dirty-branch-confirmation.png`, animations: 'disabled' })
    await confirmation.getByRole('button', { name: 'Keep this branch', exact: true }).click()
    expect(git(repo, 'branch', '--show-current')).toBe('feat/another-task')
    await expect(prompt).toHaveValue('Keep this draft while inspecting the checkout.')
    await notice.getByRole('button', { name: 'Restore branch main', exact: true }).click()
    await confirmation.getByRole('button', { name: 'Switch branch', exact: true }).click()
    await expect(notice).toHaveCount(0)
    expect(git(repo, 'branch', '--show-current')).toBe('main')
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('Uncommitted changes survive a restore\n')
    await expect(prompt).toHaveValue('Keep this draft while inspecting the checkout.')
    git(repo, 'checkout', '-q', 'feat/other-task')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await send(page, 'Adopt the current shared checkout.')
    expect((await activeThread(page)).worktree?.sentBranch).toBe('feat/other-task')
    git(repo, 'checkout', '-q', '--detach')
    await prompt.fill('Detached checkout remains usable.')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByRole('button', { name: 'Working copy: Detached HEAD', exact: true })).toBeVisible()
    await expect(notice).toHaveCount(0)
  } finally {
    if (launched) await closeSotto(launched)
    await rm(root, { recursive: true, force: true })
  }
})

test('failed first-send setup preserves the draft and retries without dispatching twice', async () => {
  test.setTimeout(120_000)
  const root = await mkdtemp(join(tmpdir(), 'sotto-e2e-worktree-retry-')), fresh = join(root, 'fresh-repo'), plain = join(root, 'plain-notes')
  await mkdir(fresh); await mkdir(plain)
  git(fresh, 'init', '-q')
  let launched: LaunchedSotto | undefined
  try {
    launched = await launch([['fresh-repo', fresh], ['plain-notes', plain]])
    const { page } = launched
    await createByKeyboard(page, 'plain-notes', 'Plain folder', false, false)
    await send(page, 'Use this ordinary folder.')
    expect(sameFolder((await activeThread(page)).workingDirectory!, plain)).toBe(true)
    expect(existsSync(join(plain, '.git'))).toBe(false)
    await createByKeyboard(page, 'fresh-repo', 'Fresh task', true)
    await expect(page.locator('.working-copy-notice')).toHaveCount(0)
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('Draft kept after failed setup.')
    await prompt.press('Enter')
    const notice = page.getByRole('alert').filter({ hasText: 'Worktree not ready.' })
    await expect(notice).toBeVisible()
    const failed = await activeThread(page)
    expect(failed).toMatchObject({ nativeSessionStarted: false, worktree: { status: 'error' } })
    expect(await userMessageTexts(page, failed.id)).toEqual([])
    await expect(prompt).toHaveValue('Draft kept after failed setup.')
    await commitFile(fresh, 'START.md', 'First commit\n')
    await notice.getByRole('button', { name: 'Retry setup', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(notice).toHaveCount(0)
    await expect(prompt).toHaveValue('Draft kept after failed setup.')
    expect(await userMessageTexts(page, failed.id)).toEqual([])
    await send(page, 'Draft kept after failed setup.')
    expect(await userMessageTexts(page, failed.id)).toEqual(['Draft kept after failed setup.'])
    expect(countWorktrees(fresh)).toBe(2)
  } finally {
    if (launched) await closeSotto(launched)
    await rm(root, { recursive: true, force: true })
  }
})

const RECLAIM_SHOTS = evidenceDirectory('artifacts/reclaim-worktrees')
test('a worktree can be reclaimed from the pane or on settle, keeps its branch, and comes back on the next send', async () => {
  test.setTimeout(180_000)
  const root = await mkdtemp(join(tmpdir(), 'sotto-e2e-reclaim-')), repo = join(root, 'repo-app')
  await mkdir(repo)
  git(repo, 'init', '-q')
  await commitFile(repo, 'README.md', 'Committed checkout\n')
  await commitFile(repo, '.gitignore', 'node_modules/\n.env\n.local/\n.worktrees/\n')
  let launched: LaunchedSotto | undefined
  try {
    launched = await launch([['repo-app', repo]])
    const { page } = launched
    await mkdir(RECLAIM_SHOTS, { recursive: true })
    const details = page.getByRole('group', { name: 'Working copy details' })

    // Settings: the four rules, every one off, under Application at each size and in both appearances.
    await openPage(page, 'Settings')
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Application', exact: true }).click()
    const idleRule = page.getByRole('combobox', { name: 'Remove idle worktrees after' })
    await expect(idleRule).toHaveValue('never')
    for (const rule of ['Remove a worktree when its thread is settled', 'Remove a worktree once its commits are in the default branch', 'Remove a worktree when its pull request is merged']) {
      await expect(page.getByRole('switch', { name: rule })).toHaveAttribute('aria-checked', 'false')
    }
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resize(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        await idleRule.scrollIntoViewIfNeeded()
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: `${RECLAIM_SHOTS}/settings-worktree-cleanup-${width}x${height}-${appearance}.png`, animations: 'disabled' })
      }
    }
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    await resize(launched, 1280, 800)
    // The rule saves and comes back; it is off again afterwards so the settle below asks.
    await idleRule.selectOption('30')
    await expect(page.locator('.settings-notice')).toHaveText('Setting saved.')
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).worktreeCleanup.afterDays)).toBe(30)
    await idleRule.selectOption('never')
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).worktreeCleanup.afterDays)).toBe(null)

    // A thread with its own worktree, with dependencies "installed" in it.
    await openThreads(page)
    await createByKeyboard(page, 'repo-app', 'Reclaim me', true)
    await send(page, 'Work in a worktree of your own.')
    const thread = await activeThread(page)
    const worktreePath = thread.worktree!.path!, branch = thread.worktree!.branch!
    await mkdir(join(worktreePath, 'node_modules', 'dep'), { recursive: true })
    await writeFile(join(worktreePath, 'node_modules', 'dep', 'index.js'), '')
    expect(countWorktrees(repo)).toBe(2)

    // Remove worktree from the pane: the question names the branch, Escape keeps the folder.
    await page.getByRole('button', { name: `Working copy: ${branch}`, exact: true }).click()
    await page.screenshot({ path: `${RECLAIM_SHOTS}/working-copy-panel.png`, animations: 'disabled' })
    await details.getByRole('button', { name: 'Remove worktree folder, keeping its branch', exact: true }).click()
    const question = page.getByRole('dialog', { name: 'Remove this worktree?', exact: true })
    await expect(question).toContainText(`The branch ${branch} keeps its commits`)
    await expect(question).not.toContainText('uncommitted changes')
    await page.screenshot({ path: `${RECLAIM_SHOTS}/remove-worktree-clean.png`, animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(question).toHaveCount(0)
    expect(existsSync(worktreePath)).toBe(true)
    // Ignored files require their own acknowledgement, and a changed set needs a fresh question.
    await writeFile(join(worktreePath, '.env'), 'synthetic local secret')
    await details.getByRole('button', { name: 'Remove worktree folder, keeping its branch', exact: true }).click()
    await expect(question.getByText('.env', { exact: true })).toBeVisible()
    const remove = question.getByRole('button', { name: 'Remove with these files', exact: true })
    await expect(remove).toBeDisabled()
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resize(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
        for (const reducedMotion of ['no-preference', 'reduce'] as const) {
          await page.emulateMedia({ reducedMotion })
          await expect(remove).toBeInViewport()
          await expect(question.getByRole('checkbox')).toBeInViewport()
          await page.screenshot({ path: `${RECLAIM_SHOTS}/ignored-items-${width}x${height}-${appearance}-${reducedMotion}.png`, animations: 'disabled' })
        }
      }
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    await resize(launched, 1280, 800)
    await question.getByRole('checkbox', { name: 'Delete this 1 ignored item with the folder' }).focus()
    await page.keyboard.press('Space')
    await expect(remove).toBeEnabled()
    await mkdir(join(worktreePath, '.local'))
    await writeFile(join(worktreePath, '.local', 'new.txt'), 'new local work')
    await remove.click()
    await expect(question.getByRole('alert')).toContainText('Nothing was removed')
    expect(await readFile(join(worktreePath, '.env'), 'utf8')).toBe('synthetic local secret')
    await page.keyboard.press('Escape')
    await expect(question).toHaveCount(0)
    // A new file inside an already listed folder also needs a fresh question.
    await details.getByRole('button', { name: 'Remove worktree folder, keeping its branch', exact: true }).click()
    await expect(question.getByText('.local/', { exact: true })).toBeVisible()
    await expect(question).toContainText('1 file, ignored')
    await writeFile(join(worktreePath, '.local', 'secret.txt'), 'unseen local secret')
    await question.getByRole('checkbox').check()
    await question.getByRole('button', { name: 'Remove with these files', exact: true }).click()
    await expect(question.getByRole('alert')).toContainText('The folder changed. Nothing was removed. Choose Remove worktree again to see the new list.')
    expect(await readFile(join(worktreePath, '.local', 'secret.txt'), 'utf8')).toBe('unseen local secret')
    await page.keyboard.press('Escape')
    await expect(question).toHaveCount(0)
    // Nested work is named plainly and goes only after the separate tick.
    const nested = join(worktreePath, '.worktrees', 'n')
    await mkdir(nested, { recursive: true })
    git(nested, 'init', '-q')
    await commitFile(nested, 'saved.txt', 'committed nested history')
    await writeFile(join(nested, 'unsaved.txt'), 'nested uncommitted work')
    await details.getByRole('button', { name: 'Remove worktree folder, keeping its branch', exact: true }).click()
    await expect(question).toContainText('Nested repository · 1 uncommitted change · 1 commit not on any remote')
    await expect(question).not.toContainText('?? unsaved.txt')
    await expect(remove).toBeDisabled()
    await question.getByRole('checkbox', { name: 'Delete these 4 ignored items with the folder, including the nested repository’s uncommitted work' }).check()
    await expect(remove).toBeEnabled()
    await resize(launched, 820, 560)
    await expect(question.getByRole('heading', { name: 'Remove this worktree?' })).toBeInViewport()
    await expect(remove).toBeInViewport()
    const nestedPath = question.getByText('.worktrees/n/', { exact: true })
    await expect(nestedPath).toBeInViewport()
    await expect.poll(() => nestedPath.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(100)
    await page.screenshot({ path: `${RECLAIM_SHOTS}/nested-items-820x560-dark.png`, animations: 'disabled' })
    await resize(launched, 1600, 1000)
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'light' }))
    await page.screenshot({ path: `${RECLAIM_SHOTS}/nested-items-1600x1000-light.png`, animations: 'disabled' })
    await page.keyboard.press('Escape')
    expect(await readFile(join(nested, 'unsaved.txt'), 'utf8')).toBe('nested uncommitted work')
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    await resize(launched, 1280, 800)
    // With uncommitted work the question says so, and the folder goes only on that answer.
    await writeFile(join(worktreePath, 'README.md'), 'Unsaved work\n')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(async () => (await activeThread(page)).worktree?.dirty).toBe(true)
    await details.getByRole('button', { name: 'Remove worktree folder, keeping its branch', exact: true }).click()
    await expect(question).toContainText('This folder has uncommitted changes.')
    await expect(question.getByText('.local/', { exact: true })).toBeVisible()
    await question.getByRole('checkbox', { name: 'Delete these 4 ignored items with the folder, including the nested repository’s uncommitted work' }).check()
    await page.screenshot({ path: `${RECLAIM_SHOTS}/remove-worktree-dirty.png`, animations: 'disabled' })
    await question.getByRole('button', { name: 'Remove with these files', exact: true }).click()
    await expect(question).toHaveCount(0)
    await expect.poll(() => existsSync(worktreePath)).toBe(false)
    expect(existsSync(nested)).toBe(false)
    expect(countWorktrees(repo)).toBe(1)
    expect(git(repo, 'branch', '--list', branch)).toContain(branch)
    await expect.poll(async () => (await activeThread(page)).worktree?.reclaimedAt).toBeTruthy()
    await page.getByRole('button', { name: `Working copy: ${branch}`, exact: true }).click()
    await expect(details).toContainText(`Folder removed. Sending to this thread puts it back on ${branch}.`)
    await expect(details.getByRole('button', { name: 'Open folder', exact: true })).toHaveCount(0)
    await page.screenshot({ path: `${RECLAIM_SHOTS}/working-copy-reclaimed.png`, animations: 'disabled' })
    await details.press('Escape')

    // The next send puts the folder back on its branch, and the unsaved work is what was lost.
    await send(page, 'Carry on where the branch left off.')
    await expect.poll(() => existsSync(worktreePath)).toBe(true)
    expect(countWorktrees(repo)).toBe(2)
    expect(git(worktreePath, 'branch', '--show-current')).toBe(branch)
    expect(await readFile(join(worktreePath, 'README.md'), 'utf8')).toMatch(/^Committed checkout\r?\n$/u)
    await expect.poll(async () => (await activeThread(page)).worktree?.reclaimedAt).toBeUndefined()

    // The sidebar row moves to the closed Settled shelf before its separate removal question opens.
    const sidebarSettle = page.getByRole('button', { name: 'Settle Reclaim me', exact: true })
    await sidebarSettle.focus()
    await sidebarSettle.press('Enter')
    const settleQuestion = page.getByRole('dialog', { name: 'Remove its worktree too?', exact: true })
    await expect(settleQuestion).toBeVisible()
    await page.screenshot({ path: `${RECLAIM_SHOTS}/settle-asks.png`, animations: 'disabled' })
    await settleQuestion.getByRole('button', { name: 'Keep folder', exact: true }).click()
    await expect(settleQuestion).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Settled 1 thread', exact: true })).toBeFocused()
    await expect.poll(async () => Boolean((await activeThread(page)).workspaceSettledAt)).toBe(true)
    expect(existsSync(worktreePath)).toBe(true)
    await page.getByRole('button', { name: `Working copy: ${branch}`, exact: true }).click()
    await details.getByRole('button', { name: 'Remove worktree folder, keeping its branch', exact: true }).click()
    await question.getByRole('button', { name: 'Remove worktree', exact: true }).click()
    await expect.poll(() => existsSync(worktreePath)).toBe(false)
    expect(git(repo, 'branch', '--list', branch)).toContain(branch)
  } finally {
    if (launched) await closeSotto(launched)
    await rm(root, { recursive: true, force: true })
  }
})

test('clean submodule branch and tag history is listed and requires the tick in both removal questions', async () => {
  test.setTimeout(120_000)
  const root = await mkdtemp(join(tmpdir(), 'sotto-e2e-submodule-history-')), repo = join(root, 'repo-app'), origin = join(root, 'module-origin'), childOrigin = join(root, 'child-origin')
  await mkdir(repo); await mkdir(origin); await mkdir(childOrigin)
  git(repo, 'init', '-q'); git(origin, 'init', '-q'); git(childOrigin, 'init', '-q')
  // The app's own Git reads the repository's config, so its worktree checks files out the way this test's Git does
  // rather than by the machine's global line-ending setting; the status checks below compare the two.
  git(repo, 'config', 'core.autocrlf', 'false')
  await commitFile(repo, 'README.md', 'Parent checkout\n')
  await commitFile(origin, 'module.txt', 'Published module\n')
  await commitFile(childOrigin, 'child.txt', 'Published child\n')
  git(origin, '-c', 'protocol.file.allow=always', 'submodule', 'add', childOrigin, 'child')
  git(origin, 'commit', '-q', '-am', 'Add child module')
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', origin, 'module')
  git(repo, 'commit', '-q', '-am', 'Add module')
  let launched: LaunchedSotto | undefined
  try {
    launched = await launch([['repo-app', repo]])
    const { page } = launched
    await createByKeyboard(page, 'repo-app', 'Submodule history', true)
    await send(page, 'Work independently.')
    const thread = await activeThread(page), worktreePath = thread.worktree!.path!, branch = thread.worktree!.branch!
    git(worktreePath, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive')
    const module = join(worktreePath, 'module'), recorded = git(module, 'rev-parse', 'HEAD')
    const gitDirectory = git(module, 'rev-parse', '--absolute-git-dir')
    git(module, 'checkout', '-q', '-b', 'private')
    await commitFile(module, 'branch.txt', 'Private branch\n')
    const branchCommit = git(module, 'rev-parse', 'HEAD')
    await commitFile(module, 'tag.txt', 'Private tag\n')
    const tagCommit = git(module, 'rev-parse', 'HEAD')
    git(module, 'tag', 'private-save')
    git(module, 'checkout', '-q', '--detach', recorded)
    git(module, 'branch', '-f', 'private', branchCommit)
    expect(git(module, 'status', '--porcelain')).toBe('')
    expect(git(worktreePath, 'status', '--porcelain', '--ignore-submodules=none')).toBe('')

    await page.getByRole('button', { name: `Working copy: ${branch}`, exact: true }).click()
    await page.getByRole('group', { name: 'Working copy details' }).getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect.poll(async () => (await activeThread(page)).worktree?.dirty).toBe(false)
    await page.getByRole('group', { name: 'Working copy details' }).getByRole('button', { name: 'Remove worktree folder, keeping its branch', exact: true }).click()
    const question = page.getByRole('dialog', { name: 'Remove this worktree?', exact: true })
    await expect(question.getByText('module/', { exact: true })).toBeVisible()
    await expect(question).toContainText('Nested repository · 0 uncommitted changes · 2 commits not on any remote')
    await expect(question).not.toContainText('This folder has uncommitted changes.')
    await expect(question.getByRole('button', { name: 'Remove with these files', exact: true })).toBeDisabled()
    await expect(question.getByRole('checkbox')).not.toBeChecked()
    await mkdir(RECLAIM_SHOTS, { recursive: true })
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resize(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await expect(question.getByText('module/', { exact: true })).toBeInViewport()
        await expect(question.getByRole('checkbox')).toBeInViewport()
        await expect(question.getByRole('button', { name: 'Remove with these files', exact: true })).toBeInViewport()
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        if ((width === 820 && appearance === 'dark') || (width === 1600 && appearance === 'light')) {
          await page.screenshot({ path: `${RECLAIM_SHOTS}/submodule-history-${width}x${height}-${appearance}.png`, animations: 'disabled' })
        }
      }
    }
    await page.keyboard.press('Escape')
    await expect(question).toHaveCount(0)
    expect(git(module, 'cat-file', '-t', branchCommit)).toBe('commit')
    expect(git(module, 'cat-file', '-t', tagCommit)).toBe('commit')
    expect(existsSync(gitDirectory)).toBe(true)
    const child = join(module, 'child'), childRecorded = git(child, 'rev-parse', 'HEAD')
    const childDirectory = git(child, 'rev-parse', '--absolute-git-dir')
    git(child, 'checkout', '-q', '-b', 'private-child')
    await commitFile(child, 'private-child.txt', 'Private recursive history\n')
    const childCommit = git(child, 'rev-parse', 'HEAD')
    git(child, 'checkout', '-q', '--detach', childRecorded)
    expect(git(worktreePath, 'status', '--porcelain', '--ignore-submodules=none')).toBe('')
    // Emptying the submodule checkout keeps its private history in metadata removed with the parent.
    git(worktreePath, 'submodule', 'deinit', '--', 'module')
    expect(existsSync(join(module, '.git'))).toBe(false)
    expect(existsSync(child)).toBe(false)
    await page.getByRole('group', { name: 'Working copy details' }).getByRole('button', { name: 'Remove worktree folder, keeping its branch', exact: true }).click()
    await expect(question.getByText('module/', { exact: true })).toBeVisible()
    await expect(question).toContainText('2 commits not on any remote')
    await expect(question.getByText('.git/modules/module/modules/child/', { exact: true })).toBeInViewport()
    await expect(question).toContainText('1 commit not on any remote')
    await expect(question.getByRole('checkbox')).toBeInViewport()
    await expect(question.getByRole('button', { name: 'Remove with these files', exact: true })).toBeDisabled()
    await expect(question.getByRole('button', { name: 'Remove with these files', exact: true })).toBeInViewport()
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
    await page.screenshot({ path: `${RECLAIM_SHOTS}/submodule-recursive-history-820x560-dark.png`, animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(question).toHaveCount(0)
    expect(git(gitDirectory, '--git-dir', gitDirectory, 'cat-file', '-t', tagCommit)).toBe('commit')
    expect(git(childDirectory, '--git-dir', childDirectory, '--work-tree', childDirectory, 'cat-file', '-t', childCommit)).toBe('commit')
    await resize(launched, 1280, 800)
    await page.getByRole('button', { name: 'More actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Settle', exact: true }).click()
    const settle = page.getByRole('dialog', { name: 'Remove its worktree too?', exact: true })
    await expect(settle.getByText('module/', { exact: true })).toBeVisible()
    await expect(settle).toContainText('2 commits not on any remote')
    await expect(settle.getByText('.git/modules/module/modules/child/', { exact: true })).toBeVisible()
    await expect(settle).toContainText('1 commit not on any remote')
    const remove = settle.getByRole('button', { name: 'Remove with these files', exact: true })
    await expect(remove).toBeDisabled()
    await settle.getByRole('checkbox').focus()
    await page.keyboard.press('Space')
    await expect(remove).toBeEnabled()
    await remove.click()
    await expect.poll(async () => {
      if (await settle.count() === 0) return 'removed'
      const refusal = settle.getByRole('alert')
      return await refusal.count() ? await refusal.textContent() : 'removing'
    }).toBe('removed')
    await expect.poll(() => existsSync(worktreePath)).toBe(false)
    expect(existsSync(gitDirectory)).toBe(false)
    expect(git(repo, 'branch', '--list', branch)).toContain(branch)
  } finally {
    if (launched) await closeSotto(launched)
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * The images the verification note names are copied to artifacts/worktree-origin-fallback/.
 * See "E2e evidence" in docs/ci.md for default, publish and root override paths.
 */
const ORIGIN_SHOTS = evidenceDirectory('artifacts/worktree-origin-fallback-run')
test('a new worktree with Start from origin on starts from the local branch when origin does not have it, and says so', async () => {
  test.setTimeout(120_000)
  // A repository with a real origin that has main, and a local-only branch the shared folder is left on: the case
  // the shared-checkout default makes common, and the one that used to refuse setup (ADR-0014, #328).
  const root = await mkdtemp(join(tmpdir(), 'sotto-e2e-origin-fallback-')), repo = join(root, 'repo-app'), remote = join(root, 'origin.git')
  await mkdir(repo); await mkdir(remote)
  git(repo, 'init', '-q', '-b', 'main')
  await commitFile(repo, 'README.md', 'Committed checkout\n')
  git(remote, 'init', '-q', '--bare')
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-q', 'origin', 'main')
  git(repo, 'checkout', '-q', '-b', 'feat/local-only')
  await commitFile(repo, 'NOTES.md', 'Only on this computer\n')
  let launched: LaunchedSotto | undefined
  try {
    launched = await launch([['repo-app', repo]])
    const { page } = launched
    await createByKeyboard(page, 'repo-app', 'Local base')
    await chooseWorkspace(page, 'New worktree')
    await expect.poll(async () => (await activeThread(page)).worktree?.mode).toBe('independent')
    expect((await activeThread(page)).worktree?.startFromOrigin).toBe(true)
    await send(page, 'Start from what is here.')
    const thread = await activeThread(page)
    expect(thread.worktree).toMatchObject({ mode: 'independent', status: 'ready', baseBranch: 'feat/local-only', originBase: 'not-on-origin' })
    expect((await readFile(join(thread.workingDirectory!, 'NOTES.md'), 'utf8')).trim()).toBe('Only on this computer')
    const notice = page.getByRole('status').filter({ hasText: 'was not found' })
    await expect(notice).toContainText('origin/feat/local-only was not found, so the worktree started from the local branch feat/local-only.')
    await expect(notice).toHaveAttribute('data-tone', 'status')
    await expect(page.getByRole('alert')).toHaveCount(0)
    await mkdir(ORIGIN_SHOTS, { recursive: true })
    await page.screenshot({ path: `${ORIGIN_SHOTS}/local-branch-notice-1280x800-dark.png`, animations: 'disabled' })
    // The notice at the minimum size and in light: it wraps, and nothing overflows the pane.
    await resize(launched, 820, 560)
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'light' }))
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `${ORIGIN_SHOTS}/local-branch-notice-820x560-light.png`, animations: 'disabled' })
    await notice.getByRole('button', { name: 'Dismiss the local branch notice', exact: true }).click()
    await expect(notice).toHaveCount(0)
    // Remembered on this computer: a reload does not bring it back.
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Local base', exact: true })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'was not found' })).toHaveCount(0)
  } finally {
    if (launched) await closeSotto(launched)
    await rm(root, { recursive: true, force: true })
  }
})
