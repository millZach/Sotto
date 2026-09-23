import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto, openPage, openThreads, userMessageTexts, type LaunchedSotto } from './support/sottoLaunch'

const SHOTS = 'artifacts/new-thread-setup'
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
async function captureMatrix(launched: LaunchedSotto): Promise<void> {
  await mkdir(SHOTS, { recursive: true })
  for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
    await resize(launched, width, height)
    for (const appearance of ['dark', 'light'] as const) {
      await launched.page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
      await expect(launched.page.locator('html')).toHaveAttribute('data-theme', appearance)
      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        await launched.page.emulateMedia({ reducedMotion })
        await expect.poll(() => launched.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await expect(launched.page.getByRole('button', { name: 'Create thread', exact: true })).toBeInViewport()
        await expect(launched.page.locator('.new-thread-dialog summary')).toBeInViewport()
        await launched.page.screenshot({ path: `${SHOTS}/new-worktree-${width}x${height}-${appearance}-${reducedMotion}.png`, animations: 'disabled' })
      }
    }
  }
  await launched.page.emulateMedia({ reducedMotion: 'no-preference' })
  await launched.page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
  await resize(launched, 1280, 800)
}
async function openCreation(page: Page, project: string, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New thread', exact: true }).first().focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
  await expect(dialog.getByRole('searchbox', { name: 'Search projects' })).toBeFocused()
  await page.keyboard.type(project)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(dialog.locator('summary')).toBeFocused()
  await dialog.locator('summary').click()
  await dialog.getByRole('textbox', { name: 'Thread name' }).fill(title)
  await dialog.locator('summary').click()
  await expect(dialog.getByText('Starts in the project folder. Change it under the composer.')).toBeVisible()
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
  await openCreation(page, project, title)
  const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
  await dialog.getByRole('button', { name: 'Create thread', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await expect.poll(async () => (await activeThread(page))?.title).toBe(title)
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
    await agents.command({ type: 'configure', patch: { enabled: true, speak: false } })
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

    await openCreation(page, 'repo-app', 'Abandoned worktree')
    await page.screenshot({ path: `${SHOTS}/shared-default-dialog.png`, animations: 'disabled' })
    const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
    await captureMatrix(launched)
    await resize(launched, 820, 560)
    // Keyboard creation continues at Thread options at the minimum size; Escape folds it and then closes the dialog.
    await dialog.locator('summary').focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('textbox', { name: 'Thread name' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog.locator('summary')).toBeFocused()
    await expect(dialog.locator('details')).not.toHaveAttribute('open')
    await dialog.getByRole('button', { name: 'Create thread', exact: true }).focus()
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
    await expect(toolbar(page).getByRole('combobox', { name: 'Choose workspace', exact: true })).toHaveText('WorkspacePrevious worktree (feat/task-branch)')
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

const RECLAIM_SHOTS = 'artifacts/reclaim-worktrees'
test('a worktree can be reclaimed from the pane or on settle, keeps its branch, and comes back on the next send', async () => {
  test.setTimeout(180_000)
  const root = await mkdtemp(join(tmpdir(), 'sotto-e2e-reclaim-')), repo = join(root, 'repo-app')
  await mkdir(repo)
  git(repo, 'init', '-q')
  await commitFile(repo, 'README.md', 'Committed checkout\n')
  await commitFile(repo, '.gitignore', 'node_modules/\n')
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
    // With uncommitted work the question says so, and the folder goes only on that answer.
    await writeFile(join(worktreePath, 'README.md'), 'Unsaved work\n')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(async () => (await activeThread(page)).worktree?.dirty).toBe(true)
    await details.getByRole('button', { name: 'Remove worktree folder, keeping its branch', exact: true }).click()
    await expect(question).toContainText('This folder has uncommitted changes.')
    await page.screenshot({ path: `${RECLAIM_SHOTS}/remove-worktree-dirty.png`, animations: 'disabled' })
    await question.getByRole('button', { name: 'Remove and lose changes', exact: true }).click()
    await expect(question).toHaveCount(0)
    await expect.poll(() => existsSync(worktreePath)).toBe(false)
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

    // Settle asks the same question; Keep folder settles without removing, a yes removes.
    await page.getByRole('button', { name: 'More actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Settle', exact: true }).click()
    const settleQuestion = page.getByRole('dialog', { name: 'Remove its worktree too?', exact: true })
    await expect(settleQuestion).toBeVisible()
    await page.screenshot({ path: `${RECLAIM_SHOTS}/settle-asks.png`, animations: 'disabled' })
    await settleQuestion.getByRole('button', { name: 'Keep folder', exact: true }).click()
    await expect(settleQuestion).toHaveCount(0)
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
