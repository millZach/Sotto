import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Sotto E2E', '-c', 'user.email=e2e@sotto.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', windowsHide: true })
}
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
async function resize(launched: LaunchedSotto, width: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, width) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
    window.setContentSize(width, 800)
  }, width)
  await expect.poll(() => launched.page.evaluate(() => window.innerWidth)).toBe(width)
}
async function capture(launched: LaunchedSotto, name: string): Promise<void> {
  for (const appearance of ['dark', 'light'] as const) {
    await launched.page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
    await expect(launched.page.locator('html')).toHaveAttribute('data-theme', appearance)
    await launched.page.screenshot({ path: `artifacts/crossing/phase-two-worktree-${name}-${appearance}.png`, animations: 'disabled' })
  }
}
/** Keyboard only: open New thread, pick a project by search, name it, choose the working copy and create. */
async function createByKeyboard(page: Page, project: string, title: string, workingCopy: 'New worktree' | 'Project folder'): Promise<void> {
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
  await expect(dialog.getByRole('radio', { name: 'New worktree' })).toBeFocused()
  if (workingCopy === 'Project folder') await page.keyboard.press('ArrowRight')
  await expect(dialog.getByRole('radio', { name: workingCopy })).toBeChecked()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
}

test('creates independent, shared, non-Git and recoverable worktree threads from the keyboard', async () => {
  test.setTimeout(120_000)
  const root = await mkdtemp(join(tmpdir(), 'sotto-e2e-worktrees-'))
  const repo = join(root, 'repo-app'); const plain = join(root, 'plain-notes'); const fresh = join(root, 'fresh-repo')
  await mkdir(repo); await mkdir(plain); await mkdir(fresh)
  git(repo, 'init', '-q'); await commitFile(repo, 'README.md', 'Original checkout\n')
  await writeFile(join(plain, 'notes.txt'), 'Not a repository\n')
  git(fresh, 'init', '-q')
  const previousFolder = process.env.SOTTO_E2E_PROJECT_DIRECTORY
  process.env.SOTTO_E2E_PROJECT_DIRECTORY = repo
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto()
    const { page } = launched
    await page.evaluate(async folders => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
      for (const [title, path] of folders) await window.sotto!.agents!.command({ type: 'create-project', title, path, useExisting: true })
    }, [['repo-app', repo], ['plain-notes', plain], ['fresh-repo', fresh]])
    await page.reload()
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    await resize(launched, 1280)

    // An existing thread keeps its folder and gains no setup notice.
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Working copy: Project folder' })).toBeVisible()
    await expect(page.locator('.working-copy-notice')).toHaveCount(0)

    // The creation form with the working-copy choice.
    await page.getByRole('button', { name: 'New thread', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
    await page.keyboard.type('repo-app'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
    await expect(dialog.getByRole('radio', { name: 'New worktree' })).toBeChecked()
    await capture(launched, 'dialog')
    await resize(launched, 820)
    await capture(launched, 'dialog-minimum')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await resize(launched, 1280)

    // Independent: its own branch and folder; the original checkout is untouched.
    await createByKeyboard(page, 'repo-app', 'Independent task', 'New worktree')
    const independent = await activeThread(page)
    expect(independent.worktree).toMatchObject({ mode: 'independent', status: 'ready' })
    const branch = independent.worktree!.branch!
    const worktreePath = independent.worktree!.path!
    expect(branch).toMatch(/^sotto\/thread-/)
    await expect(page.getByRole('button', { name: `Working copy: ${branch}` })).toBeVisible()
    expect(git(repo, 'branch', '--show-current').trim()).toBe('main')
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(`branch refs/heads/${branch}`)
    expect(await readFile(join(worktreePath, 'README.md'), 'utf8')).toBe('Original checkout\n')
    const chip = page.getByRole('button', { name: `Working copy: ${branch}` })
    await chip.focus(); await page.keyboard.press('Enter')
    const details = page.getByRole('group', { name: 'Working copy details' })
    await expect(details).toContainText(worktreePath)
    await expect(details).toContainText('No uncommitted changes')
    await capture(launched, 'independent-details')
    await resize(launched, 820)
    await capture(launched, 'independent-details-minimum')
    await page.keyboard.press('Escape')
    await expect(details).toHaveCount(0)
    await expect(chip).toBeFocused()
    await resize(launched, 1280)

    // Shared: deliberately works in the project folder.
    await createByKeyboard(page, 'repo-app', 'Shared task', 'Project folder')
    expect((await activeThread(page)).worktree).toMatchObject({ mode: 'shared', status: 'ready' })
    await expect(page.getByRole('button', { name: 'Working copy: Project folder' })).toBeVisible()
    await capture(launched, 'shared')

    // Ordinary folder: New worktree remains usable in the folder itself.
    await createByKeyboard(page, 'plain-notes', 'Notes task', 'New worktree')
    expect((await activeThread(page)).worktree).toMatchObject({ mode: 'shared', status: 'ready' })
    await expect(page.getByRole('button', { name: 'Working copy: Project folder' })).toBeVisible()
    expect(existsSync(join(plain, '.git'))).toBe(false)

    // Failure: the local thread and its draft stay; nothing is sent or redirected.
    await createByKeyboard(page, 'fresh-repo', 'Fresh task', 'New worktree')
    const notice = page.getByRole('alert').filter({ hasText: 'Worktree not ready.' })
    await expect(notice).toBeVisible()
    await expect(page.getByRole('button', { name: 'Working copy: Worktree not ready' })).toBeVisible()
    const failed = await activeThread(page)
    expect(failed).toMatchObject({ nativeSessionStarted: false, messages: [], worktree: { status: 'error' } })
    expect(failed.workingDirectory).toBeUndefined()
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('Draft kept after failed setup.')
    await page.getByRole('button', { name: 'Notes task', exact: true }).click()
    await page.getByRole('button', { name: 'Fresh task', exact: true }).click()
    await expect(prompt).toHaveValue('Draft kept after failed setup.')
    await capture(launched, 'failed')
    await resize(launched, 820)
    await capture(launched, 'failed-minimum')
    await resize(launched, 1280)

    // Retry after the repository gains a commit.
    await commitFile(fresh, 'START.md', 'First commit\n')
    const retry = notice.getByRole('button', { name: 'Retry setup' })
    await retry.focus()
    await capture(launched, 'retry-focus')
    await page.keyboard.press('Enter')
    await expect(notice).toHaveCount(0)
    const recovered = await activeThread(page)
    expect(recovered.worktree).toMatchObject({ mode: 'independent', status: 'ready' })
    await expect(page.getByRole('button', { name: `Working copy: ${recovered.worktree!.branch}` })).toBeVisible()
    await expect(prompt).toBeFocused()
    await expect(prompt).toHaveValue('Draft kept after failed setup.')
    expect(recovered.messages).toEqual([])
    await capture(launched, 'recovered')
  } finally {
    if (previousFolder === undefined) delete process.env.SOTTO_E2E_PROJECT_DIRECTORY
    else process.env.SOTTO_E2E_PROJECT_DIRECTORY = previousFolder
    if (launched) await closeSotto(launched)
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
})
