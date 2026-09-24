import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'

// T3's Git action in the pane header, against a real repository and an owned bare remote. GitHub is a scripted gh
// (tests/fixtures/fakeGh.mjs) reached through the host's test seam, so the pull request is "created" without a network.
/** The host reads these folders on its own timer, and Git's index lock is held for a moment each time; a test command that meets it tries again. */
const git = (cwd: string, ...args: string[]): string => {
  for (let attempt = 0; ; attempt += 1) {
    try { return execFileSync('git', ['-c', 'user.name=Sotto E2E', '-c', 'user.email=e2e@sotto.invalid', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim() }
    catch (error) {
      if (attempt >= 30 || !/index\.lock/u.test(error instanceof Error ? error.message : '')) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
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
/** The host reads the folder again with its remote, the way a refresh does; the button follows the record. */
async function refresh(page: Page): Promise<void> {
  const id = (await activeThread(page)).id
  await page.evaluate(async threadId => { await window.sotto!.agents!.command({ type: 'refresh-thread-worktree', threadId }) }, id)
}
async function command(page: Page, request: Record<string, unknown>): Promise<void> {
  const id = (await activeThread(page)).id
  const error = await page.evaluate(async ([threadId, body]) => (await window.sotto!.agents!.command({ ...(body as object), threadId } as never)).error, [id, request] as const)
  if (error) throw new Error(error)
}
const pane = (page: Page) => page.locator('section.thread-pane[data-focused]')
const quick = (page: Page) => pane(page).locator('.git-action__quick')
/** The visible label alone; the button's text also carries the reason it is disabled, for screen readers. */
const label = (page: Page) => pane(page).locator('.git-action__label')
const notice = (page: Page) => pane(page).locator('.git-action-notice')
// The captures for the Git interface's verification note (#272). The run writes every one here, uncommitted; the note
// copies the ones it cites to artifacts/git-interface/.
const SHOTS = resolve(process.cwd(), 'artifacts/git-interface-run')
/** One state at 1280x800 and the 820x560 minimum, dark and light: nothing scrolls sideways, and each is captured. */
async function captureMatrix(launched: LaunchedSotto, name: string, ready?: () => Promise<void>): Promise<void> {
  const { page } = launched
  await mkdir(SHOTS, { recursive: true })
  for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
    await resize(launched, width, height)
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      if (ready) await ready()
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: join(SHOTS, `${name}-${width}x${height}-${appearance}.png`), animations: 'disabled' })
    }
  }
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await resize(launched, 1280, 800)
}
async function createThread(page: Page, project: string, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New thread', exact: true }).first().focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
  await expect(dialog.getByRole('searchbox', { name: 'Search projects' })).toBeFocused()
  await page.keyboard.type(project)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await dialog.locator('summary').click()
  await dialog.getByRole('textbox', { name: 'Thread name' }).fill(title)
  await dialog.getByRole('button', { name: 'Create thread', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await expect.poll(async () => (await activeThread(page))?.title).toBe(title)
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

test('the Git action commits and pushes from the header, asks before the default branch, opens a pull request through gh, pulls, and initializes Git', async () => {
  test.setTimeout(420_000)
  const directory = await mkdtemp(join(tmpdir(), 'sotto-e2e-git-actions-'))
  const repository = join(directory, 'project'), remote = join(directory, 'owned-remote.git'), other = join(directory, 'other'), plain = join(directory, 'plain')
  const ghState = join(directory, 'gh-state.json')
  await mkdir(repository); await mkdir(plain)
  git(repository, 'init', '-q', '-b', 'main')
  git(repository, 'config', 'core.hooksPath', join(directory, 'no-hooks'))
  await writeFile(join(repository, 'greeting.txt'), 'Hello\n')
  git(repository, 'add', '.'); git(repository, 'commit', '-qm', 'Owned baseline')
  git(directory, 'init', '--bare', '-q', '-b', 'main', remote); git(repository, 'remote', 'add', 'origin', remote)
  git(repository, 'push', '-q', '-u', 'origin', 'main'); git(repository, 'remote', 'set-head', 'origin', 'main')
  git(directory, 'clone', '-q', '-b', 'main', remote, other)
  await writeFile(join(plain, 'notes.txt'), 'Not a repository yet\n')
  const previous = { script: process.env.SOTTO_E2E_GH_SCRIPT, executable: process.env.SOTTO_E2E_GH_EXECUTABLE, state: process.env.FAKE_GH_STATE }
  process.env.SOTTO_E2E_GH_SCRIPT = resolve('tests/fixtures/fakeGh.mjs')
  process.env.SOTTO_E2E_GH_EXECUTABLE = process.execPath
  process.env.FAKE_GH_STATE = ghState
  let launched: LaunchedSotto | undefined
  try {
    launched = await launch([['Git app', repository], ['Plain folder', plain]])
    const { page } = launched
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await createThread(page, 'Git app', 'Header commit')
    // Clean, on the default branch, level with its upstream: Commit with T3's reason, nothing to do.
    await expect(label(page)).toHaveText('Commit', { timeout: 20_000 })
    await expect(quick(page)).toHaveAttribute('aria-disabled', 'true')
    await expect(quick(page)).toHaveAttribute('title', 'Branch is up to date. No action needed.')
    await expect(pane(page).getByRole('button', { name: 'More Git actions' })).toBeVisible()

    // A change in the folder: Commit & push, since the branch is the default one.
    await writeFile(join(repository, 'greeting.txt'), 'Hello, header\n')
    await refresh(page)
    await expect(label(page)).toHaveText('Commit & push', { timeout: 20_000 })
    // From the keyboard: the button opens the dialog, Escape closes it and gives focus back, Enter opens it again.
    await quick(page).focus()
    await page.keyboard.press('Enter')
    const commitDialog = page.getByRole('dialog', { name: 'Commit changes' })
    await expect(commitDialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(commitDialog).toHaveCount(0)
    await expect(quick(page)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(commitDialog).toBeVisible()
    await expect(commitDialog.getByText('Default branch')).toBeVisible()
    await expect(commitDialog.getByRole('list', { name: 'Changed files' })).toContainText('greeting.txt')
    await expect(commitDialog.getByRole('list', { name: 'Changed files' })).toContainText('+1 −1')
    await expect(commitDialog.getByRole('textbox', { name: 'Commit message (optional)' })).toBeFocused()
    await page.keyboard.type('Make the greeting friendlier')
    await captureMatrix(launched, 'commit-dialog', () => expect(commitDialog.getByRole('button', { name: 'Commit & push' })).toBeInViewport())
    await commitDialog.getByRole('button', { name: 'Commit & push' }).click()
    // Pushing from main asks first.
    const question = page.getByRole('dialog', { name: 'Push to default ref?' })
    await expect(question.getByRole('button', { name: 'Abort' })).toBeFocused()
    await captureMatrix(launched, 'default-branch-question', () => expect(question.getByRole('button', { name: 'Check out feature branch & continue' })).toBeInViewport())
    await expect(question.getByRole('button', { name: 'Abort' })).toBeFocused()
    await question.getByRole('button', { name: 'Push to main' }).click()
    await expect(notice(page)).toContainText(/Pushed [0-9a-f]{7} to origin\/main/u, { timeout: 60_000 })
    const pushed = git(repository, 'rev-parse', 'HEAD')
    expect(git(repository, 'log', '-1', '--pretty=%s')).toBe('Make the greeting friendlier')
    expect(git(repository, '--git-dir', remote, 'rev-parse', 'refs/heads/main')).toBe(pushed)
    await expect(notice(page).getByRole('button', { name: 'Dismiss the Git notice' })).toBeVisible()
    await captureMatrix(launched, 'pushed-notice', () => expect(notice(page)).toBeInViewport())
    await notice(page).getByRole('button', { name: 'Dismiss the Git notice' }).click()
    await expect(notice(page)).toHaveCount(0)
    await expect(pane(page).locator('.thread-workspace__error')).toHaveCount(0)

    // On a topic branch with a change: Commit, push & PR, the message written by the host, the pull request through gh.
    await command(page, { type: 'git-switch-branch', ref: 'feat/header', create: true })
    await writeFile(join(repository, 'greeting.txt'), 'Hello, header, from a branch\n')
    await refresh(page)
    await expect(label(page)).toHaveText('Commit, push & PR', { timeout: 20_000 })
    // Reduced motion: the running notice keeps its words and drops its spin.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await quick(page).click()
    await expect(commitDialog.getByText('Default branch')).toHaveCount(0)
    await commitDialog.getByRole('button', { name: 'Commit, push & PR' }).click()
    await expect(notice(page)).toBeVisible({ timeout: 30_000 })
    expect(await notice(page).locator('.git-action-notice__spinner').evaluate(element => getComputedStyle(element).animationName).catch(() => 'none')).toBe('none')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(notice(page)).toContainText('Created PR #74', { timeout: 90_000 })
    await expect(notice(page).getByRole('button', { name: 'View PR' })).toBeVisible()
    const state = JSON.parse(await readFile(ghState, 'utf8')) as { pulls: Array<{ number: number; headRefName: string; baseRefName: string; title: string }> }
    expect(state.pulls).toHaveLength(1)
    expect(state.pulls[0]).toMatchObject({ number: 74, headRefName: 'feat/header', baseRefName: 'main' })
    expect(git(repository, '--git-dir', remote, 'rev-parse', 'refs/heads/feat/header')).toBe(git(repository, 'rev-parse', 'HEAD'))
    // The branch's pull request reaches the toolbar's badge from the same gh, and View PR becomes the quick action.
    await expect(pane(page).getByRole('link', { name: /Open PR #74/u }).or(pane(page).getByRole('button', { name: /Open PR #74/u }))).toBeVisible({ timeout: 30_000 })
    await expect(label(page)).toHaveText('View PR')
    await captureMatrix(launched, 'pull-request-created', () => expect(notice(page).getByRole('button', { name: 'View PR' })).toBeInViewport())
    // The branch picker on the toolbar, open on the topic branch: locals then remotes, with their badges.
    const search = page.getByLabel('Search refs')
    const openPicker = async (): Promise<void> => {
      if (!(await search.isVisible())) {
        await quick(page).focus()
        await page.keyboard.press('Control+Shift+G')
      }
      await expect(search).toBeFocused()
      await expect(page.getByRole('listbox', { name: 'Refs', exact: true }).getByRole('option').first()).toBeVisible()
      const bounds = await page.getByRole('group', { name: 'Branches', exact: true }).boundingBox()
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth))
    }
    await captureMatrix(launched, 'branch-picker', openPicker)
    await openPicker()
    await page.keyboard.press('Escape')
    await expect(search).toHaveCount(0)

    // The remote moves ahead of main: Pull, fast-forward only.
    git(other, 'pull', '-q', '--ff-only', 'origin', 'main')
    await writeFile(join(other, 'greeting.txt'), 'Hello, header\nAnd from elsewhere\n')
    git(other, 'commit', '-qam', 'Elsewhere'); git(other, 'push', '-q', 'origin', 'main')
    await command(page, { type: 'git-switch-branch', ref: 'main' })
    await refresh(page)
    await expect(label(page)).toHaveText('Pull', { timeout: 30_000 })
    await quick(page).click()
    await expect(notice(page)).toContainText('Pulled. Updated main from origin/main.', { timeout: 60_000 })
    expect(git(repository, 'rev-parse', 'HEAD')).toBe(git(other, 'rev-parse', 'HEAD'))

    // The minimum window: the label leaves, the name stays.
    await resize(launched, 820, 560)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(quick(page)).toBeInViewport()
    await expect(quick(page)).toHaveAccessibleName(/Commit/u)
    expect(await pane(page).locator('.git-action__label').evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(1)
    await resize(launched, 1280, 800)

    // A folder without Git: Initialize Git, then Publish repository, since the new repository has no remote.
    await createThread(page, 'Plain folder', 'Plain thread')
    await expect(pane(page).getByRole('button', { name: 'Initialize Git' })).toBeVisible({ timeout: 20_000 })
    await pane(page).getByRole('button', { name: 'Initialize Git' }).click()
    await expect(notice(page)).toContainText('Git initialized.', { timeout: 30_000 })
    expect(existsSync(join(plain, '.git'))).toBe(true)
    // The new repository has an untracked file and no remote: Commit stands, and Publish repository waits in the menu.
    await expect(label(page)).toHaveText('Commit', { timeout: 20_000 })
    await expect(quick(page)).not.toHaveAttribute('aria-disabled', 'true')
    await pane(page).getByRole('button', { name: 'More Git actions' }).click()
    await page.getByRole('menuitem', { name: 'Publish repository...' }).click()
    const publish = page.getByRole('dialog', { name: 'Publish repository' })
    await expect(publish.getByRole('textbox', { name: 'Repository' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(publish).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    if (launched) await closeSotto(launched)
    for (const [key, value] of [['SOTTO_E2E_GH_SCRIPT', previous.script], ['SOTTO_E2E_GH_EXECUTABLE', previous.executable], ['FAKE_GH_STATE', previous.state]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
  }
})
