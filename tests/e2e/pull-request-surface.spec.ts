import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'

// The Pull request surface (#269), the merge checklist, against a real repository, an owned bare remote and a scripted
// gh (tests/fixtures/fakeGh.mjs): nothing to merge yet, Checkout pull request from the branch picker, the badge opening
// the checklist in Tools, Ready for review as a line's own press, an approval read on Refresh, the merge method chosen
// from the keyboard, the merge only after its confirmation, and the linked pull requests folded below.
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
interface GhState { pulls: Array<{ number: number; state: string; isDraft?: boolean; mergedWith?: string; reviewDecision?: string; reviews?: unknown[] }>; calls: string[] }
async function theme(page: Page, appearance: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: appearance })
  await page.evaluate(async value => { await window.sotto!.updateSettings({ appearance: value }) }, appearance)
  await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
}
/** The checklist's quieter text against the panel it sits on, and the disabled Merge against its own fill: each ratio, by what it is. */
async function contrasts(page: Page): Promise<Record<string, number>> {
  return page.locator('.pr-surface').evaluate(surface => {
    const context = document.createElement('canvas').getContext('2d')!
    const rgb = (color: string, under: string): number[] => {
      context.clearRect(0, 0, 1, 1)
      for (const fill of [under, color]) { context.fillStyle = fill; context.fillRect(0, 0, 1, 1) }
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
    }
    const luminance = (channels: number[]): number => {
      const [r, g, b] = channels.map(value => { const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4 })
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
    }
    const panel = getComputedStyle(surface.querySelector('.pr-surface__dock')!).backgroundColor
    const ratio = (text: string, under: string): number => {
      const a = luminance(rgb(text, under)), b = luminance(rgb(under, panel))
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    }
    const measured: Record<string, number> = {}
    for (const [name, selector] of [['count', '.pr-surface__heading small'], ['reason', '.pr-surface__why'], ['hint', '.pr-surface__hint'], ['tag', '.pr-surface__tag'], ['line', '.pr-surface__line strong']] as const) {
      const element = surface.querySelector(selector)
      if (element) measured[name] = ratio(getComputedStyle(element).color, panel)
    }
    const merge = surface.querySelector('.pr-surface__merge-go')
    if (merge) { const style = getComputedStyle(merge); measured.merge = ratio(style.color, style.backgroundColor) }
    return measured
  })
}
async function expectReadable(page: Page): Promise<void> {
  const measured = await contrasts(page)
  for (const [name, value] of Object.entries(measured)) expect(value, name).toBeGreaterThanOrEqual(4.5)
}

test('a pull request is checked out from the branch picker, opened from its badge, and merged from its checklist only after its confirmation', async () => {
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
  // Origin is written as the pull request's GitHub repository, and Git rewrites it to the owned remote, so a checkout
  // takes the pull request from the repository it belongs to without leaving this machine.
  git(repository, 'config', `url.${remote}.insteadOf`, 'https://github.com/sotto-fixture/owned')
  git(repository, 'remote', 'set-url', 'origin', 'https://github.com/sotto-fixture/owned')
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

    // Before the checkout the thread is on main: nothing to merge yet, and Create PR says why it waits, as the Git action does.
    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    const picker = pane(page).getByRole('combobox', { name: 'Choose branch' })
    await expect(picker).toHaveText(/main/u, { timeout: 20_000 })
    const toolsToggle = page.getByRole('button', { name: 'Tools', exact: true })
    await toolsToggle.click()
    await panel.getByRole('tab', { name: 'Pull request', exact: true }).click()
    await expect(panel.getByRole('heading', { name: 'Nothing to merge yet' })).toBeVisible({ timeout: 30_000 })
    await expect(panel.getByRole('button', { name: 'Create PR', exact: true })).toHaveAttribute('aria-disabled', 'true')
    await expect(panel.getByRole('button', { name: 'Link pull request', exact: true })).toBeVisible()
    await capture(page, 'none-1280-dark')
    await toolsToggle.click()
    await expect(panel).toHaveCount(0)

    // The branch picker: a pull request number offers Checkout pull request first, and Enter opens it.
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

    // The badge under the composer opens the checklist in Tools.
    const badge = pane(page).getByRole('button', { name: 'Open PR #74 - Open: Greet the reviewer in Tools' })
    await badge.click({ timeout: 30_000 })
    await expect(panel.getByRole('tab', { name: 'Pull request', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(panel.getByRole('heading', { name: '#74 Greet the reviewer' })).toBeVisible({ timeout: 30_000 })
    const checklist = panel.getByRole('list', { name: 'Merge checklist' })
    const merge = panel.getByRole('button', { name: 'Merge #74', exact: true })
    await expect(panel.getByRole('heading', { name: /^Before merging/u })).toContainText('3 of 5 done')
    await expect(checklist).toContainText('CI / Owned build passed')
    await expect(checklist).toContainText('Reviewers wait until it is ready')
    await expect(checklist).toContainText('Still a draft')
    await expect(panel.getByText('Draft', { exact: true })).toBeVisible()
    await expect(merge).toHaveAttribute('aria-disabled', 'true')
    await panel.getByRole('button', { name: 'Description', exact: true }).click()
    await expect(panel.getByText('Says hello to whoever reviews this.', { exact: false })).toBeVisible()
    await capture(page, 'draft-1280-dark')
    // Text meets 4.5:1 on the panel in both themes, the disabled Merge included.
    await expectReadable(page)
    await theme(page, 'light')
    await expectReadable(page)
    await capture(page, 'draft-1280-light')
    await theme(page, 'dark')

    // Someone closes it on GitHub while the surface still shows it open: GitHub's refusal reaches the surface in the
    // host's words, the surface reads it again, and Reopen puts it back.
    const closedElsewhere = JSON.parse(await readFile(ghState, 'utf8')) as GhState
    closedElsewhere.pulls[0]!.state = 'CLOSED'
    await writeFile(ghState, JSON.stringify(closedElsewhere))
    await checklist.getByRole('button', { name: 'Ready for review', exact: true }).click()
    await expect(panel.getByRole('alert')).toHaveText('Could not mark this ready for review. GraphQL: Pull request is closed (markPullRequestReadyForReview)', { timeout: 30_000 })
    await expect(panel.getByText('Closed without merging', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Reopen', exact: true }).click()
    await expect(panel.getByText('Pull request reopened.', { exact: true })).toBeVisible({ timeout: 30_000 })

    // Ready for review is the draft line's own press and needs no confirmation. The review still holds the merge back.
    await checklist.getByRole('button', { name: 'Ready for review', exact: true }).click()
    await expect(panel.getByText('Marked ready for review.', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(checklist).toContainText('Nobody has reviewed it yet')
    await expect(merge).toHaveAttribute('aria-disabled', 'true')
    await expect(panel.getByText('1 line left before this can merge.', { exact: false })).toBeVisible()
    await merge.click({ force: true })
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // A reviewer approves on GitHub; Refresh reads it, and the last line is done.
    const approved = JSON.parse(await readFile(ghState, 'utf8')) as GhState
    Object.assign(approved.pulls[0]!, { reviewDecision: 'APPROVED', reviews: [{ state: 'APPROVED', url: `${url}#pullrequestreview-1`, author: { login: 'mira' } }] })
    await writeFile(ghState, JSON.stringify(approved))
    await panel.getByRole('button', { name: 'Refresh pull request', exact: true }).click()
    await expect(checklist).toContainText('Approved by mira', { timeout: 30_000 })
    await expect(panel.getByRole('heading', { name: /^Ready to merge/u })).toContainText('5 of 5 done')
    await expect(merge).not.toHaveAttribute('aria-disabled', 'true')

    // The method beside Merge, from the keyboard: the menu opens on the method in use, and the choice is remembered.
    await panel.getByRole('button', { name: 'Merge method: Merge', exact: true }).click()
    const methods = panel.getByRole('menu', { name: 'Merge method' })
    await expect(methods.getByRole('menuitemradio', { name: 'Merge', exact: true })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(methods).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Merge method: Squash and merge', exact: true })).toBeFocused()
    await expect(panel.getByText('One commit on main.', { exact: true })).toBeVisible()

    // The merge asks first, in the method chosen.
    await merge.click()
    const confirm = page.getByRole('dialog', { name: 'Merge pull request?' })
    await expect(confirm).toContainText('This merges #74 into main using squash and merge.')
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(confirm).toHaveCount(0)
    expect((JSON.parse(await readFile(ghState, 'utf8')) as GhState).calls.some(call => call.startsWith('pr merge'))).toBe(false)
    await expectReadable(page)
    await theme(page, 'light')
    await expectReadable(page)
    await capture(page, 'ready-1280-light')
    await resize(launched, 1600, 1000)
    await capture(page, 'ready-1600-light')
    await theme(page, 'dark')
    await capture(page, 'ready-1600-dark')

    // The minimum window before the merge: the method menu opens inside the panel.
    await resize(launched, 820, 560)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await panel.getByRole('button', { name: 'Merge method: Squash and merge', exact: true }).click()
    const menuBox = await methods.boundingBox(), panelBox = await panel.boundingBox()
    expect(menuBox && panelBox && menuBox.x >= panelBox.x && menuBox.x + menuBox.width <= panelBox.x + panelBox.width && menuBox.y >= 0).toBe(true)
    await capture(page, 'method-820-dark')
    await page.keyboard.press('Escape')
    await expect(methods).toHaveCount(0)
    await resize(launched, 1280, 800)

    await merge.click()
    await confirm.getByRole('button', { name: 'Squash and merge', exact: true }).click()
    await expect(panel.getByText('Pull request merged.', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(panel.locator('.pr-surface__finished')).toContainText('Merged into main')
    await expect(panel.getByRole('heading', { name: /^Merge checklist/u })).toBeVisible()
    const after = JSON.parse(await readFile(ghState, 'utf8')) as GhState
    expect(after.pulls[0]).toMatchObject({ number: 74, state: 'MERGED', isDraft: false, mergedWith: 'squash' })
    expect(after.calls.filter(call => call.startsWith('pr merge'))).toEqual([`pr merge ${url} --squash`])

    // Linked pull requests fold below, from the keyboard: the checkout linked it.
    const linked = panel.getByRole('button', { name: /^Linked pull requests/u })
    await linked.focus()
    await page.keyboard.press('Enter')
    await expect(linked).toHaveAttribute('aria-expanded', 'true')
    await expect(panel.getByRole('list', { name: 'Linked pull requests' })).toContainText('Checked out from the branch picker')

    // The minimum window: nothing overflows, the surface keeps its controls.
    await resize(launched, 820, 560)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(panel.getByRole('heading', { name: '#74 Greet the reviewer' })).toBeVisible()
    expect(await panel.evaluate(element => [...element.querySelectorAll('.pr-surface button')]
      .filter(control => control.scrollWidth > control.clientWidth + 1).map(control => control.getAttribute('aria-label') ?? control.textContent))).toEqual([])
    await capture(page, 'merged-820-dark')
    await theme(page, 'light')
    await capture(page, 'merged-820-light')
    expect(errors).toEqual([])
  } finally {
    if (launched) await closeSotto(launched)
    for (const [key, value] of [['SOTTO_E2E_GH_SCRIPT', previous.script], ['SOTTO_E2E_GH_EXECUTABLE', previous.executable], ['FAKE_GH_STATE', previous.state]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
  }
})
