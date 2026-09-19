import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto, openPage, openThreads, userMessageTexts, type LaunchedSotto } from './support/sottoLaunch'

const SHOTS = 'artifacts/issue-146'
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=Sotto E2E', '-c', 'user.email=e2e@sotto.invalid', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim()
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
  await expect(dialog.getByRole('textbox', { name: 'Thread name' })).toBeFocused()
  await page.keyboard.type(title)
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('radio', { name: 'Project folder', exact: true })).toBeFocused()
  await expect(dialog.getByRole('radio', { name: 'Project folder', exact: true })).toBeChecked()
}
async function createByKeyboard(page: Page, project: string, title: string, independent = false): Promise<void> {
  await openCreation(page, project, title)
  if (independent) await page.keyboard.press('ArrowRight')
  const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
  await expect(dialog.getByRole('radio', { name: independent ? 'New worktree' : 'Project folder', exact: true })).toBeChecked()
  if (independent) await dialog.getByRole('checkbox', { name: 'Start from origin', exact: true }).uncheck()
  await dialog.getByRole('button', { name: 'Create thread', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await expect.poll(async () => (await activeThread(page))?.title).toBe(title)
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
    await createByKeyboard(page, 'repo-app', 'Shared second')
    expect(sameFolder((await activeThread(page)).workingDirectory!, repo)).toBe(true)
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(initialWorktrees)
    expect(git(repo, 'branch', '--format=%(refname)')).toBe(initialBranches)

    await openCreation(page, 'repo-app', 'Abandoned worktree')
    await page.screenshot({ path: `${SHOTS}/shared-default-dialog.png`, animations: 'disabled' })
    await page.keyboard.press('ArrowRight')
    const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
    await expect(dialog.getByRole('combobox', { name: 'Base branch', exact: true })).toBeVisible()
    await captureMatrix(launched)
    await resize(launched, 820, 560)
    // Keyboard focus scrolls each remaining field into view at the minimum size.
    await dialog.getByRole('radio', { name: 'New worktree', exact: true }).focus()
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('combobox', { name: 'Worktree', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('combobox', { name: 'Base branch', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    const origin = dialog.getByRole('checkbox', { name: 'Start from origin', exact: true })
    await expect(origin).toBeFocused()
    await page.keyboard.press('Space')
    await expect(origin).not.toBeChecked()
    await page.keyboard.press('Space')
    await expect(origin).toBeChecked()
    await dialog.getByRole('button', { name: 'Create thread', exact: true }).focus()
    await page.screenshot({ path: `${SHOTS}/new-worktree-820x560-bottom.png`, animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await resize(launched, 1280, 800)
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(initialWorktrees)

    await createByKeyboard(page, 'repo-app', 'Changed before sending', true)
    expect((await activeThread(page)).worktree).toMatchObject({ mode: 'independent', status: 'pending' })
    await page.getByRole('button', { name: 'Working copy: New worktree', exact: true }).click()
    const details = page.getByRole('group', { name: 'Working copy details' })
    await details.getByRole('radio', { name: 'Project folder', exact: true }).check()
    await details.getByRole('button', { name: 'Apply working copy', exact: true }).click()
    await expect.poll(async () => (await activeThread(page)).worktree?.mode).toBe('shared')
    await details.press('Escape')
    await send(page, 'Use the existing project folder.')
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(initialWorktrees)

    await createByKeyboard(page, 'repo-app', 'Independent task', true)
    const pending = await activeThread(page)
    expect(pending).toMatchObject({ nativeSessionStarted: false, worktree: { mode: 'independent', status: 'pending' } })
    expect(pending.worktree?.path).toBeUndefined()
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(initialWorktrees)
    await resize(launched, 820, 560)
    await page.getByRole('button', { name: 'Working copy: New worktree', exact: true }).click()
    await details.getByRole('combobox', { name: 'Base branch', exact: true }).selectOption('release')
    await details.getByRole('button', { name: 'Apply working copy', exact: true }).focus()
    await page.screenshot({ path: `${SHOTS}/working-copy-editor-820x560.png`, animations: 'disabled' })
    await details.getByRole('button', { name: 'Apply working copy', exact: true }).click()
    await details.press('Escape')
    await expect(details).toHaveCount(0)
    await resize(launched, 1280, 800)
    await send(page, 'Work independently from release.')
    const independent = await activeThread(page)
    expect(independent.worktree).toMatchObject({ mode: 'independent', status: 'ready', baseBranch: 'release' })
    const branch = independent.worktree!.branch!, worktreePath = independent.worktree!.path!
    expect(branch).toMatch(/^sotto\/[a-z0-9-]{1,20}$/u)
    expect(sameFolder(worktreePath, repo)).toBe(false)
    expect(await readFile(join(worktreePath, 'README.md'), 'utf8')).toMatch(/^Committed checkout\r?\n$/u)
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('Uncommitted project edit\n')
    expect(git(repo, 'branch', '--show-current')).toBe('main')
    await page.getByRole('button', { name: `Working copy: ${branch}`, exact: true }).click()
    await details.getByRole('button', { name: 'Open folder', exact: true }).click()
    await expect.poll(async () => sameFolder((await page.evaluate(async () => (await window.sottoE2E!.snapshot()).openedThreadFolder)) ?? '', independent.workingDirectory!)).toBe(true)
    await details.press('Escape')

    git(worktreePath, 'checkout', '-q', '-b', 'feat/task-branch')
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Continue on the task branch.')
    await expect(page.getByRole('button', { name: 'Working copy: feat/task-branch', exact: true })).toBeVisible()
    await expect(page.locator('.branch-notice')).toHaveCount(0)
    await send(page, 'Continue on the task branch.')
    await openCreation(page, 'repo-app', 'Continue existing worktree')
    await page.keyboard.press('ArrowRight')
    const worktreeChoice = dialog.getByRole('combobox', { name: 'Worktree', exact: true })
    await expect(worktreeChoice.locator('option').filter({ hasText: 'feat/task-branch' })).toHaveCount(1)
    await worktreeChoice.selectOption({ label: await worktreeChoice.locator('option').filter({ hasText: 'feat/task-branch' }).innerText() })
    await dialog.getByRole('button', { name: 'Create thread', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await activeThread(page))?.title).toBe('Continue existing worktree')
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
    await createByKeyboard(page, 'plain-notes', 'Plain folder')
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
