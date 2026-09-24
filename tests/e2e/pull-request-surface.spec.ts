import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'

// The Pull request surface (#269) against a real repository, an owned bare remote and a scripted gh
// (tests/fixtures/fakeGh.mjs): Checkout pull request from the branch picker, the badge opening the surface in Tools,
// Ready for review, the merge method remembered, the merge only after its confirmation, and the linked list.
const SHOTS = resolve('artifacts/pull-request-surface')
const git = (cwd: string, ...args: string[]): string => {
  for (let attempt = 0; ; attempt += 1) {
    try { return execFileSync('git', ['-c', 'user.name=Sotto E2E', '-c', 'user.email=e2e@sotto.invalid', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim() }
    catch (error) {
      if (attempt >= 30 || !/index\.lock/u.test(error instanceof Error ? error.message : '')) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
}
async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
    window.setMinimumSize(800, 540)
    window.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => launched.page.evaluate(() => `${innerWidth}x${innerHeight}`)).toBe(`${width}x${height}`)
}
async function capture(page: Page, name: string): Promise<void> {
  await mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' })
}
const pane = (page: Page) => page.locator('section.thread-pane[data-focused]')
interface GhState { pulls: Array<{ number: number; state: string; isDraft?: boolean; mergedWith?: string }>; calls: string[] }

test('a pull request is checked out from the branch picker, opened from its badge, made ready and merged only after its confirmation', async () => {
  test.setTimeout(240_000)
  const directory = await mkdtemp(join(tmpdir(), 'sotto-e2e-pull-request-'))
  const repository = join(directory, 'project'), remote = join(directory, 'owned-remote.git'), author = join(directory, 'author')
  const ghState = join(directory, 'gh-state.json')
  await mkdir(repository)
  git(repository, 'init', '-q', '-b', 'main')
  git(repository, 'config', 'core.hooksPath', join(directory, 'no-hooks'))
  await writeFile(join(repository, 'greeting.txt'), 'Hello\n')
  git(repository, 'add', '.'); git(repository, 'commit', '-qm', 'Owned baseline')
  git(directory, 'init', '--bare', '-q', '-b', 'main', remote); git(repository, 'remote', 'add', 'origin', remote)
  git(repository, 'push', '-q', '-u', 'origin', 'main'); git(repository, 'remote', 'set-head', 'origin', 'main')
  // Someone else's pull request: a branch on the remote the project folder has never had.
  git(directory, 'clone', '-q', '-b', 'main', remote, author)
  git(author, 'checkout', '-q', '-b', 'feat/greeting')
  await writeFile(join(author, 'greeting.txt'), 'Hello, reviewer\n')
  git(author, 'commit', '-qam', 'Greet the reviewer'); git(author, 'push', '-q', 'origin', 'feat/greeting')
  const url = 'https://github.com/sotto-fixture/owned/pull/74'
  await writeFile(ghState, JSON.stringify({ calls: [], pulls: [{ number: 74, title: 'Greet the reviewer', url, state: 'OPEN', isDraft: true, baseRefName: 'main', headRefName: 'feat/greeting',
    body: 'Says hello to whoever reviews this.\n\n- One line changed', reviewDecision: 'REVIEW_REQUIRED' }] }))
  const previous = { script: process.env.SOTTO_E2E_GH_SCRIPT, executable: process.env.SOTTO_E2E_GH_EXECUTABLE, state: process.env.FAKE_GH_STATE }
  process.env.SOTTO_E2E_GH_SCRIPT = resolve('tests/fixtures/fakeGh.mjs')
  process.env.SOTTO_E2E_GH_EXECUTABLE = process.execPath
  process.env.FAKE_GH_STATE = ghState
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto()
    const { page } = launched
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.evaluate(async path => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await agents.command({ type: 'connect' })
      await agents.command({ type: 'create-project', title: 'Review app', path, useExisting: true })
    }, repository)
    await page.reload()
    await openThreads(page)
    await resize(launched, 1280, 800)
    await page.getByRole('button', { name: 'New thread', exact: true }).first().click()
    const newThread = page.getByRole('dialog', { name: 'New thread', exact: true })
    await newThread.getByRole('searchbox', { name: 'Search projects' }).fill('Review app')
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
    await newThread.getByRole('button', { name: 'Create thread', exact: true }).click()
    await expect(newThread).toHaveCount(0)

    // The branch picker: a pull request number offers Checkout pull request first, and Enter opens it.
    const picker = pane(page).getByRole('combobox', { name: 'Choose branch' })
    await expect(picker).toHaveText(/main/u, { timeout: 20_000 })
    await picker.click()
    await page.getByRole('textbox', { name: 'Search refs' }).fill('#74')
    await expect(page.getByRole('option', { name: /Checkout pull request/u })).toBeVisible()
    await page.keyboard.press('Enter')
    const checkout = page.getByRole('dialog', { name: 'Checkout pull request' })
    await expect(checkout.getByText('Greet the reviewer')).toBeVisible({ timeout: 20_000 })
    await expect(checkout).toContainText('#74 · feat/greeting to main')
    await checkout.getByRole('button', { name: 'Local', exact: true }).click()
    await expect(checkout).toHaveCount(0, { timeout: 60_000 })
    await expect(pane(page).locator('.branch-toolbar__notice')).toHaveText('Checked out PR #74 on feat/greeting.')
    expect(git(repository, 'branch', '--show-current')).toBe('feat/greeting')
    await expect(picker).toBeFocused()

    // The badge under the composer opens the surface in Tools.
    const badge = pane(page).getByRole('button', { name: 'Open PR #74 - Open: Greet the reviewer in Tools' })
    await badge.click({ timeout: 30_000 })
    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    await expect(panel.getByRole('tab', { name: 'PR', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(panel.getByRole('heading', { name: 'Greet the reviewer' })).toBeVisible({ timeout: 30_000 })
    await expect(panel.getByText('Says hello to whoever reviews this.', { exact: false })).toBeVisible()
    await expect(panel.getByRole('list', { name: 'Checks' })).toContainText('CI / Owned build')
    await expect(panel.getByText('Draft', { exact: true })).toBeVisible()
    await capture(page, 'draft-1280-dark')

    // Ready for review needs no confirmation; the merge does, in the method chosen, which is remembered.
    await panel.getByRole('button', { name: 'Ready for review', exact: true }).click()
    await expect(panel.getByText('Marked ready for review.', { exact: true })).toBeVisible({ timeout: 30_000 })
    const method = panel.getByRole('combobox', { name: 'Merge method' })
    await expect(method).toBeVisible()
    await method.selectOption('squash')
    await panel.getByRole('button', { name: 'Squash and merge', exact: true }).click()
    const confirm = page.getByRole('dialog', { name: 'Merge pull request?' })
    await expect(confirm).toContainText('This merges #74 using squash and merge.')
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(confirm).toHaveCount(0)
    expect((JSON.parse(await readFile(ghState, 'utf8')) as GhState).calls.some(call => call.startsWith('pr merge'))).toBe(false)
    await page.emulateMedia({ colorScheme: 'light' })
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'light' }) })
    await capture(page, 'ready-1280-light')
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
    await panel.getByRole('button', { name: 'Squash and merge', exact: true }).click()
    await confirm.getByRole('button', { name: 'Squash and merge', exact: true }).click()
    await expect(panel.getByText('Pull request merged.', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(panel.getByText('Merged.', { exact: true })).toBeVisible()
    const after = JSON.parse(await readFile(ghState, 'utf8')) as GhState
    expect(after.pulls[0]).toMatchObject({ number: 74, state: 'MERGED', isDraft: false, mergedWith: 'squash' })
    expect(after.calls.filter(call => call.startsWith('pr merge'))).toEqual([`pr merge ${url} --squash`])

    // Linked pull requests: checked out from the branch picker, and the way back.
    await panel.getByRole('button', { name: /Linked pull requests/u }).click()
    await expect(panel.getByRole('list', { name: 'Linked pull requests' })).toContainText('Checked out from the branch picker')
    await expect(panel.getByRole('button', { name: 'Back', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(panel.getByRole('button', { name: /Linked pull requests/u })).toBeFocused()

    // The minimum window: nothing overflows, the surface keeps its controls.
    await resize(launched, 820, 560)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(panel.getByRole('heading', { name: 'Greet the reviewer' })).toBeVisible()
    expect(await panel.evaluate(element => [...element.querySelectorAll('.pr-surface button')]
      .filter(control => control.scrollWidth > control.clientWidth + 1).map(control => control.getAttribute('aria-label') ?? control.textContent))).toEqual([])
    await capture(page, 'merged-820-dark')
    expect(errors).toEqual([])
  } finally {
    if (launched) await closeSotto(launched)
    for (const [key, value] of [['SOTTO_E2E_GH_SCRIPT', previous.script], ['SOTTO_E2E_GH_EXECUTABLE', previous.executable], ['FAKE_GH_STATE', previous.state]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
  }
})
