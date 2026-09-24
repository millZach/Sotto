import { hostEntityKey } from '../../src/shared/clientIdentity'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openThreads, userMessageTexts, type LaunchedSotto } from './support/sottoLaunch'
import { terminalOutput } from './support/terminal'

// Full app, real controller/IPC/files/PTY/browser/Git/worktrees; coding providers are explicit fixtures.
// GitHub is a scripted gh (tests/fixtures/fakeGh.mjs), reached AFTER a real push to an owned local bare repository.
const SHOTS = resolve('artifacts/issue-74-daily-workspace')
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim()
async function size(launched: LaunchedSotto, width = 1600, height = 1000): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
    window.setMinimumSize(800, 540); window.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => launched.page.evaluate(() => `${innerWidth}x${innerHeight}`)).toBe(`${width}x${height}`)
}
async function profile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-e2e-daily-workspace-'))
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark' }))
  return directory
}
async function connect(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
}
async function capture(page: Page, name: string): Promise<void> {
  await mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' })
}
async function focusThread(page: Page, id: string, title: string): Promise<void> {
  // The sidebar stays available while a restored split changes from narrow tabs to wide panes.
  await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: title, exact: true }).click()
  await page.locator(`section.thread-pane[data-thread-id="${id}"]`).getByRole('textbox', { name: 'Prompt', exact: true }).click()
}
async function beside(page: Page, title: string): Promise<void> {
  const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
  await sidebar.getByRole('button', { name: title, exact: true }).hover()
  await sidebar.getByRole('button', { name: `Open ${title} beside`, exact: true }).click()
}

test('daily mixed-provider workspace joins independent work, tools, reviewed commit and owned publish', async () => {
  test.skip(process.platform !== 'win32', 'Windows PTY and desktop acceptance; macOS must be run separately')
  test.setTimeout(180000)
  const directory = await profile(), repository = join(directory, 'project'), remote = join(directory, 'owned-remote.git')
  await mkdir(repository)
  git(repository, 'init', '-q', '-b', 'main')
  for (const [key, value] of [['user.name', 'Sotto verification'], ['user.email', 'verification@example.invalid'], ['commit.gpgSign', 'false'], ['core.hooksPath', join(directory, 'no-hooks')], ['core.autocrlf', 'false']]) git(repository, 'config', key!, value!)
  await writeFile(join(repository, 'greeting.txt'), 'Hello\n')
  git(repository, 'add', '.'); git(repository, 'commit', '-qm', 'Owned daily baseline')
  const original = git(repository, 'rev-parse', 'HEAD')
  git(repository, 'init', '--bare', '-q', remote); git(repository, 'remote', 'add', 'origin', remote)
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Daily local preview</title><h1>Hello, daily workspace</h1>') })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Owned server has no address')
  const url = `http://127.0.0.1:${address.port}/`
  const ghState = join(directory, 'gh-state.json')
  const previousGh = { script: process.env.SOTTO_E2E_GH_SCRIPT, executable: process.env.SOTTO_E2E_GH_EXECUTABLE, state: process.env.FAKE_GH_STATE }
  process.env.SOTTO_E2E_GH_SCRIPT = resolve('tests/fixtures/fakeGh.mjs')
  process.env.SOTTO_E2E_GH_EXECUTABLE = process.execPath
  process.env.FAKE_GH_STATE = ghState
  const launched = await launchSotto('phase3-workspace', directory)
  const { page, app } = launched
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  try {
    await connect(page)
    const threads = await page.evaluate(async path => {
      const agents = window.sotto!.agents!
      const project = await agents.command({ type: 'create-project', title: 'Daily workspace', path, useExisting: true })
      if (project.error) throw new Error(project.error)
      const projectId = project.host.projects.find(project => project.title === 'Daily workspace')!.id
      const created = []
      for (const [title, modelId] of [['Daily implementation', 'codex:gpt'], ['Daily review', 'claude:sonnet']]) {
        const state = await agents.command({ type: 'create-thread', projectId, title: title!, modelId: modelId!, managed: false, workingCopy: 'independent' })
        if (state.error) throw new Error(state.error)
        created.push(state.host.threads.find(thread => thread.id === state.activeThreadId)!)
      }
      return created
    }, repository)
    const [implementation, review] = threads
    expect(implementation!.providerId).toBe('codex'); expect(review!.providerId).toBe('claude')
    expect(implementation!.worktree).toMatchObject({ status: 'pending', mode: 'independent' })
    expect(review!.worktree).toMatchObject({ status: 'pending', mode: 'independent' })
    const first = implementation!.id, second = review!.id
    await size(launched)
    await openThreads(page)
    await page.getByRole('button', { name: 'Daily implementation', exact: true }).first().click()
    await beside(page, 'Daily review')
    const pane = (id: string) => page.locator(`section.thread-pane[data-thread-id="${id}"]`)
    const prompt = (id: string) => pane(id).getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt(first).fill('Make the greeting friendlier.'); await prompt(first).press('Enter')
    await prompt(second).fill('Review the greeting independently.'); await prompt(second).press('Enter')
    await expect.poll(() => page.evaluate(async ids => (await window.sotto!.agents!.get()).host.threads.filter(thread => ids.includes(thread.id)).map(thread => thread.status), [first, second])).toEqual(['running', 'running'])
    const readyThreads = await page.evaluate(async ids => (await window.sotto!.agents!.get()).host.threads.filter(thread => ids.includes(thread.id)), [first, second])
    Object.assign(implementation!, readyThreads.find(thread => thread.id === first))
    Object.assign(review!, readyThreads.find(thread => thread.id === second))
    expect(implementation!.worktree).toMatchObject({ status: 'ready', mode: 'independent' })
    expect(review!.worktree).toMatchObject({ status: 'ready', mode: 'independent' })
    const working = implementation!.worktree!.path!, other = review!.worktree!.path!
    expect(working).not.toBe(other)
    await page.evaluate(async threadId => window.sottoE2E!.agentEvent!({ type: 'ready', threadId, status: 'idle', text: 'Review prepared in my own working copy.' }), second)
    await prompt(second).fill('Keep this review draft private to this pane.')
    await page.evaluate(async threadId => window.sottoE2E!.agentEvent!({ type: 'ready', threadId, status: 'idle', text: 'The greeting is ready.\n\n```mermaid\nflowchart LR\n  Draft --> Review --> Commit\n```', activities: [{ id: 'daily-command', turnId: 'daily-turn', sequence: 0, kind: 'command', status: 'completed', title: 'Inspect greeting', command: 'Get-Content greeting.txt', output: 'Hello', exitCode: 0 }] }), first)
    await expect(pane(first).locator('.rich-diagram__canvas img')).toBeVisible()
    const activity = pane(first).getByRole('button', { name: /Ran 1 command/ })
    await activity.click()
    await pane(first).getByRole('button', { name: /Get-Content greeting.txt/ }).click()
    await expect(pane(first).getByLabel('output code block')).toContainText('Hello')
    await capture(page, 'mixed-threads-diagram-activity')
    await focusThread(page, first, 'Daily implementation')
    await pane(first).getByRole('button', { name: 'Tools', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    await panel.getByRole('button', { name: 'Pin to Daily implementation', exact: true }).click()
    await focusThread(page, second, 'Daily review')
    await expect(pane(second)).toHaveAttribute('data-focused')
    await expect(panel.getByRole('button', { name: 'Unpin from Daily implementation', exact: true })).toBeVisible()
    await panel.getByRole('tab', { name: 'Terminal', exact: true }).click()
    await panel.getByRole('button', { name: 'Start terminal' }).click()
    await panel.locator('.xterm').click()
    await page.keyboard.type("Set-Content -LiteralPath greeting.txt -Value 'Hello, daily workspace' -Encoding utf8; Write-Output SOTTO_DAILY_TERMINAL")
    await page.keyboard.press('Enter')
    await expect.poll(() => terminalOutput(page, first)).toContain('SOTTO_DAILY_TERMINAL')
    await expect.poll(() => readFile(join(working, 'greeting.txt'), 'utf8')).toContain('Hello, daily workspace')
    expect(await readFile(join(other, 'greeting.txt'), 'utf8')).toBe('Hello\n')
    await panel.getByRole('tab', { name: 'Files', exact: true }).click()
    await panel.getByRole('treeitem', { name: 'greeting.txt', exact: true }).click()
    await expect(panel.locator('.files-preview__text')).toContainText('Hello, daily workspace')
    await panel.getByRole('button', { name: 'Unpin from Daily implementation', exact: true }).click()
    await focusThread(page, second, 'Daily review')
    await expect(panel.getByRole('button', { name: 'Pin to Daily review', exact: true })).toBeVisible()
    await panel.getByRole('treeitem', { name: 'greeting.txt', exact: true }).click()
    await expect(panel.locator('.files-preview__text')).toHaveText('Hello\n')
    await focusThread(page, first, 'Daily implementation')
    await panel.getByRole('tab', { name: 'Browser', exact: true }).click()
    await panel.getByRole('textbox', { name: /^Address/ }).fill(url); await page.keyboard.press('Enter')
    await expect(panel.getByRole('tab', { name: /Daily local preview/ })).toBeVisible()
    expect(await app.evaluate(async ({ webContents }, url) => {
      const view = webContents.getAllWebContents().find(view => view.getURL() === url)!
      return view.executeJavaScript('({title: document.title, bridge: typeof window.sotto, require: typeof window.require})')
    }, url)).toEqual({ title: 'Daily local preview', bridge: 'undefined', require: 'undefined' })
    await panel.getByRole('tab', { name: 'Changes', exact: true }).click()
    // Changes reads the working tree against HEAD; there is no staging to do first (ADR-0027).
    await expect(panel.getByRole('group', { name: 'greeting.txt' })).toContainText('Hello, daily workspace')
    await expect(panel.getByRole('button', { name: 'Stage file', exact: true })).toHaveCount(0)
    // The commit is the pane header's Git action (ADR-0027): Commit from its menu, the message typed in the dialog.
    await pane(first).getByRole('button', { name: 'More Git actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Commit', exact: true }).click()
    const commitDialog = page.getByRole('dialog', { name: 'Commit changes' })
    await commitDialog.getByRole('textbox', { name: 'Commit message (optional)' }).fill('Make the daily greeting friendlier')
    await commitDialog.getByRole('button', { name: 'Commit', exact: true }).click()
    await expect(pane(first).locator('.git-action-notice')).toContainText(/Committed [0-9a-f]{7}/u, { timeout: 60_000 })
    const committed = git(working, 'rev-parse', 'HEAD')
    expect(committed).not.toBe(original); expect(git(other, 'rev-parse', 'HEAD')).toBe(original)
    expect(git(repository, 'rev-parse', 'HEAD')).toBe(original)
    // The pull request is T3's (ADR-0027): Create PR in the pane header pushes to the owned remote and opens it through
    // the scripted gh, the badge under the composer opens it in Tools, and it merges only after its confirmation.
    expect(git(repository, '--git-dir', remote, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('')
    await pane(first).getByRole('button', { name: 'More Git actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Create PR', exact: true }).click()
    await expect(pane(first).locator('.git-action-notice')).toContainText('Created PR #74', { timeout: 90_000 })
    const branch = git(working, 'branch', '--show-current')
    expect(git(repository, '--git-dir', remote, 'rev-parse', `refs/heads/${branch}`)).toBe(committed)
    await pane(first).getByRole('button', { name: /^Open PR #74 - Open: .* in Tools$/u }).click({ timeout: 30_000 })
    await expect(panel.getByRole('tab', { name: 'Pull request', exact: true })).toHaveAttribute('aria-selected', 'true')
    const created = (JSON.parse(await readFile(ghState, 'utf8')) as { pulls: Array<{ title: string }> }).pulls[0]!
    await expect(panel.getByRole('heading', { name: `#74 ${created.title}`, exact: true })).toBeVisible({ timeout: 30_000 })
    // The merge checklist: the owned repository requires no review, the one check passed, and every line is done.
    const checklist = panel.getByRole('list', { name: 'Merge checklist' })
    await expect(checklist).toContainText('CI / Owned build passed')
    await expect(checklist).toContainText('No review required')
    await expect(panel.getByRole('heading', { name: /^Ready to merge/u })).toContainText('5 of 5 done')
    await panel.getByRole('button', { name: 'Merge #74', exact: true }).click()
    const confirmMerge = page.getByRole('dialog', { name: 'Merge pull request?' })
    await expect(confirmMerge).toContainText('This merges #74 into main using merge.')
    expect((JSON.parse(await readFile(ghState, 'utf8')) as { calls: string[] }).calls.some(call => call.startsWith('pr merge'))).toBe(false)
    await confirmMerge.getByRole('button', { name: 'Merge', exact: true }).click()
    await expect(panel.getByText('Pull request merged.', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(panel.locator('.pr-surface__finished')).toContainText('Merged into main')
    const merged = JSON.parse(await readFile(ghState, 'utf8')) as { pulls: Array<{ number: number; state: string; mergedWith?: string; headRefName: string }>; calls: string[] }
    expect(merged.pulls).toEqual([expect.objectContaining({ number: 74, state: 'MERGED', mergedWith: 'merge', headRefName: branch })])
    expect(merged.calls.filter(call => call.startsWith('pr merge'))).toHaveLength(1)
    await panel.getByRole('button', { name: /^Linked pull requests/u }).click()
    await expect(panel.getByRole('list', { name: 'Linked pull requests' })).toContainText('Created from this thread')
    await capture(page, 'owned-push-fixture-pr')
    await focusThread(page, second, 'Daily review')
    await expect(prompt(second)).toHaveValue('Keep this review draft private to this pane.')
    const state = await page.evaluate(async () => window.sotto!.agents!.get())
    expect(state.assignments).toEqual([])
    for (const [id, own, foreign] of [[first, 'Make the greeting friendlier.', 'Review the greeting independently.'], [second, 'Review the greeting independently.', 'Make the greeting friendlier.']]) {
      const messages = await userMessageTexts(page, id!)
      expect(messages.filter(message => message === own)).toHaveLength(1)
      expect(messages.some(message => message === foreign)).toBe(false)
    }
    await writeFile(join(SHOTS, 'daily-proof.json'), JSON.stringify({ lane: 'provider fixtures; real Electron services; scripted gh', original, committed, pushed: committed, first, second, working, other, realGitHubWrites: 0, errors }, null, 2))
    expect(errors).toEqual([])
  } catch (error) { await capture(page, 'failure').catch(() => undefined); throw error }
  finally {
    await closeSotto(launched); await new Promise<void>(done => server.close(() => done()))
    for (const [key, value] of [['SOTTO_E2E_GH_SCRIPT', previousGh.script], ['SOTTO_E2E_GH_EXECUTABLE', previousGh.executable], ['FAKE_GH_STATE', previousGh.state]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    await rm(requireOwnedE2EProfile(directory), { recursive: true, force: true })
  }
})

test('mixed pane drafts, queued work, settlement and preferences recover without automatic replay', async () => {
  test.setTimeout(120000)
  const directory = await profile()
  let launched = await launchSotto('phase3-workspace', directory)
  try {
    let page = launched.page
    await connect(page); await size(launched)
    await openThreads(page)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await sidebar.getByRole('button', { name: 'Grok voice previews', exact: true }).click()
    await beside(page, 'Footer links')
    const hostId = await page.evaluate(async () => (await window.sotto!.agents!.get()).hostId)
    const key = (id: string): string => hostEntityKey(hostId, id)
    const pane = (id: string) => page.locator(`section.thread-pane[data-thread-id="${key(id)}"]`)
    const prompt = (id: string) => pane(id).getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt('grok-previews').fill('Unsent Claude draft for tomorrow.')
    await prompt('footer-links').fill('Queued Codex follow-up after this turn.')
    await prompt('footer-links').press('Enter')
    await expect(pane('footer-links').getByRole('region', { name: 'Queued messages' })).toContainText('Queued Codex follow-up after this turn.')
    await prompt('footer-links').fill('Newer unsent Codex draft.')
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ appearance: 'light', darkTheme: 'nocturne', lightTheme: 'linen', webLinkDestination: 'embedded' })
      await window.sotto!.agents!.command({ type: 'settle-thread', threadId: 'grok-previews' })
      await window.sotto!.agents!.command({ type: 'settle-project', projectId: 'workshop' })
      await window.sotto!.agents!.command({ type: 'restore-project', projectId: 'workshop' })
    })
    await sidebar.getByRole('button', { name: /^Settled/ }).click()
    await expect(sidebar.getByRole('region', { name: 'Settled' }).getByRole('button', { name: 'Grok voice previews', exact: true })).toBeVisible()
    await expect(sidebar.getByRole('region', { name: 'Projects' }).getByRole('button', { name: 'Grok voice previews', exact: true })).toHaveCount(0)
    await page.evaluate(async () => window.sotto!.agents!.command({ type: 'restore-thread', threadId: 'grok-previews' }))
    await expect(sidebar.getByRole('region', { name: 'Projects' }).getByRole('button', { name: 'Grok voice previews', exact: true })).toBeVisible()
    await focusThread(page, key('grok-previews'), 'Grok voice previews')
    await pane('grok-previews').getByRole('button', { name: 'Tools', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Tools' })
    await panel.getByRole('button', { name: 'Pin to Grok voice previews', exact: true }).click()
    await focusThread(page, key('footer-links'), 'Footer links')
    await expect(panel.getByRole('button', { name: 'Unpin from Grok voice previews', exact: true })).toBeVisible()
    const drafts = async () => page.evaluate(async ids => (await window.sotto!.agents!.get()).threadDrafts?.filter(draft => ids.includes(draft.threadId)).map(draft => [draft.threadId, draft.text]).sort(), [key('grok-previews'), key('footer-links')])
    const expected = [[key('footer-links'), 'Newer unsent Codex draft.'], [key('grok-previews'), 'Unsent Claude draft for tomorrow.']]
    await expect.poll(drafts).toEqual(expected)
    await expect(prompt('footer-links')).toHaveValue('Newer unsent Codex draft.')
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'disconnect', threadId: 'footer-links', text: '' }))
    await expect(prompt('footer-links')).toHaveValue('Newer unsent Codex draft.')
    await page.evaluate(async () => window.sotto!.agents!.command({ type: 'connect' }))
    const before = await page.evaluate(async () => window.sotto!.agents!.get())
    expect(before.followups).toEqual([expect.objectContaining({ threadId: key('footer-links'), text: 'Queued Codex follow-up after this turn.' })])
    expect(before.host.threads.flatMap(thread => thread.messages).some(message => message.text === 'Queued Codex follow-up after this turn.')).toBe(false)
    await capture(page, 'reconnect-pinned-drafts-light')
    await closeSotto(launched)
    // The synthetic provider starts from its seeded history again. Only actual Sotto-owned recovery is claimed here.
    launched = await launchSotto('phase3-workspace', directory); page = launched.page
    await connect(page); await size(launched)
    await openThreads(page)
    await focusThread(page, key('grok-previews'), 'Grok voice previews')
    await expect(prompt('grok-previews')).toHaveValue('Unsent Claude draft for tomorrow.')
    await focusThread(page, key('footer-links'), 'Footer links')
    await expect(prompt('footer-links')).toHaveValue('Newer unsent Codex draft.')
    // Tools chrome is explicitly session-scoped; reopening follows the currently focused thread.
    await expect(page.getByRole('complementary', { name: 'Tools' })).toBeHidden()
    await pane('footer-links').getByRole('button', { name: 'Tools', exact: true }).click()
    await expect(page.getByRole('complementary', { name: 'Tools' }).getByRole('button', { name: 'Pin to Footer links', exact: true })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    expect(await page.evaluate(async () => window.sotto!.getSettings())).toMatchObject({ appearance: 'light', lightTheme: 'linen', darkTheme: 'nocturne', webLinkDestination: 'embedded' })
    const restored = await page.evaluate(async () => window.sotto!.agents!.get())
    expect(restored.followups).toEqual([expect.objectContaining({ threadId: key('footer-links'), text: 'Queued Codex follow-up after this turn.' })])
    expect((await userMessageTexts(page, 'footer-links')).some(text => text === 'Queued Codex follow-up after this turn.')).toBe(false)
    expect(restored.assignments).toEqual([])
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'footer-links', text: 'The original Codex turn is complete.' }))
    const queue = pane('footer-links').getByRole('region', { name: 'Queued messages' })
    await queue.getByRole('button', { name: 'Resume queue', exact: true }).click()
    await expect.poll(() => userMessageTexts(page, 'footer-links').then(texts => texts.filter(text => text === 'Queued Codex follow-up after this turn.').length)).toBe(1)
    await page.evaluate(async () => window.sotto!.agents!.command({ type: 'connect' }))
    const delivered = await page.evaluate(async () => window.sotto!.agents!.get())
    expect((await userMessageTexts(page, 'footer-links')).filter(text => text === 'Queued Codex follow-up after this turn.')).toHaveLength(1)
    for (const thread of delivered.host.threads.filter(thread => thread.id !== key('footer-links'))) {
      expect((await userMessageTexts(page, thread.id)).some(text => text === 'Queued Codex follow-up after this turn.'), thread.id).toBe(false)
    }
    await expect(prompt('footer-links')).toHaveValue('Newer unsent Codex draft.')
    await page.getByRole('complementary', { name: 'Tools' }).getByRole('button', { name: 'Close tools panel', exact: true }).click()
    await size(launched, 820, 560)
    await expect(prompt('footer-links')).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await capture(page, 'restored-queue-minimum-light')
  } catch (error) { await capture(launched.page, 'recovery-failure').catch(() => undefined); throw error }
  finally { await closeSotto(launched); await rm(requireOwnedE2EProfile(directory), { recursive: true, force: true }) }
})


