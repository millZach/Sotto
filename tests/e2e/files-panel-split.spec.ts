import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'

// The shared Files panel beside a real split: a Git worktree thread and a shared-folder thread on real temporary
// folders, real Git and Files IPC; only providers are fixtures. Captures are the inspected review evidence.
const SHOTS = 'artifacts/phase-two-tools-fixed'

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=Sotto Test', '-c', 'user.email=test@sotto.invalid', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true })

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
  }
}

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    // The shipped minimum is an outer size; relax it slightly so the content area can be exactly 820x560.
    window.setMinimumSize(800, 540)
    window.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => launched.page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`)).toBe(`${width}x${height}`)
}

async function capture(page: Page, name: string): Promise<void> {
  for (const appearance of ['dark', 'light'] as const) {
    await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
    await page.screenshot({ path: `${SHOTS}/${name}-${appearance}.png`, animations: 'disabled' })
  }
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
}

/** Activate Close from the keyboard and prove focus reached the toggle without ever resting on the page. */
async function closeWithKey(page: Page, panel: Locator, key: 'Enter' | 'Escape'): Promise<string> {
  if (key === 'Enter') await panel.getByRole('button', { name: 'Close tools panel' }).focus()
  else await panel.getByRole('tab', { name: 'Files' }).focus()
  await page.evaluate(() => {
    const probe = window as unknown as { __toolsFocusGaps: number }
    probe.__toolsFocusGaps = 0
    document.addEventListener('focusout', event => { if (event.relatedTarget === null) probe.__toolsFocusGaps++ }, { capture: true })
  })
  await page.keyboard.press(key)
  const immediate = await page.evaluate(() => {
    const active = document.activeElement
    return { gaps: (window as unknown as { __toolsFocusGaps: number }).__toolsFocusGaps, toggle: active?.getAttribute('aria-controls') === 'sotto-tools-panel', pane: active?.closest('[data-thread-id]')?.getAttribute('data-thread-id') ?? null }
  })
  await expect(panel).toHaveCount(0)
  expect(immediate).toMatchObject({ gaps: 0, toggle: true })
  // Still there once the panes have re-laid out for the freed width.
  await page.waitForTimeout(400)
  await expect(page.locator('[aria-controls="sotto-tools-panel"]')).toBeFocused()
  return immediate.pane!
}

test('Files beside a split: worktree identity, pinned ownership, docking choice and keyboard close', async () => {
  test.setTimeout(180_000)
  const root = await mkdtemp(join(tmpdir(), 'sotto-e2e-files-split-'))
  const repo = join(root, 'repo-app')
  const notes = join(root, 'field-notes')
  await write(repo, {
    'README.md': '# Repo app\n\nThe **worktree** checkout this thread works in.\n\n- Browse its files\n- Copy the folder path\n',
    'src/app.ts': 'export function main(): number {\n  return 42\n}\n',
    'docs/guide.md': '## Guide\n',
  })
  git(repo, 'init', '-q'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'Initial')
  await write(notes, { 'today.md': '# Today\n\n- Review the split\n', 'draft.txt': 'Plain text notes.\n' })
  const launched = await launchSotto()
  const { page } = launched
  await mkdir(SHOTS, { recursive: true })
  try {
    const ids = await page.evaluate(async folders => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await agents.command({ type: 'connect' })
      const created: Record<string, string> = {}
      for (const [title, path, thread, workingCopy] of [['repo-app', folders[0], 'Worktree checkout', 'independent'], ['field-notes', folders[1], 'Field notes', 'shared']] as const) {
        await agents.command({ type: 'create-project', title, path, useExisting: true })
        const projectId = (await agents.get()).host.projects.find(item => item.title === title)!.id
        await agents.command({ type: 'create-thread', projectId, title: thread, modelId: 'claude:test', managed: false, workingCopy })
        created[thread] = (await agents.get()).host.threads.find(item => item.title === thread)!.id
      }
      return created
    }, [repo, notes])
    const worktreeThread = ids['Worktree checkout']!
    const notesThread = ids['Field notes']!
    const actual = await page.evaluate(async id => {
      const thread = (await window.sotto!.agents!.get()).host.threads.find(item => item.id === id)!
      return { directory: thread.workingDirectory ?? thread.worktree?.path ?? '', branch: thread.worktree?.branch ?? '', status: thread.worktree?.status }
    }, worktreeThread)
    expect(actual.status).toBe('ready')
    expect(actual.directory).not.toBe(repo)

    await page.reload()
    await resize(launched, 1600, 900)
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await sidebar.getByRole('button', { name: 'Worktree checkout', exact: true }).click()
    await sidebar.getByRole('button', { name: 'Field notes', exact: true }).hover()
    await sidebar.getByRole('button', { name: 'Open Field notes beside', exact: true }).click()
    const panes = page.getByRole('group', { name: 'Thread panes' })
    const left = page.locator(`section.thread-pane[data-thread-id="${worktreeThread}"]`)
    const right = page.locator(`section.thread-pane[data-thread-id="${notesThread}"]`)
    await left.getByRole('textbox', { name: 'Prompt', exact: true }).click()
    await expect(left).toHaveAttribute('data-focused')

    // 1600: docked beside a two-pane split, reading the worktree's actual folder.
    await left.getByRole('button', { name: 'Files', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Tools' })
    await expect(panel).toHaveAttribute('data-mode', 'docked')
    await expect(panes).not.toHaveAttribute('data-narrow')
    await expect(panel.locator('.tools-panel__path-text')).toHaveAttribute('title', actual.directory)
    await expect(panel.locator('.tools-panel__path-text')).toHaveText(actual.directory)
    await expect(panel.locator('.tools-panel__copy')).toHaveText(`repo-app·${actual.branch}`)
    const tree = panel.getByRole('tree')
    await expect(tree.getByRole('treeitem')).toHaveText(['docs', 'src', 'README.md'])
    await tree.getByRole('treeitem', { name: 'README.md' }).click()
    await expect(panel.locator('.files-preview__markdown').getByRole('heading', { name: 'Repo app' })).toBeVisible()
    await capture(page, 'split-1600-worktree-docked')

    // Pinned to the worktree thread while the other pane holds focus: the panel says so, and that pane's toggle is not pressed-looking.
    await panel.getByRole('button', { name: 'Pin to Worktree checkout' }).click()
    await right.getByRole('textbox', { name: 'Prompt', exact: true }).click()
    await expect(right).toHaveAttribute('data-focused')
    const rightToggle = right.getByRole('button', { name: 'Files', exact: true })
    await expect(rightToggle).toHaveAttribute('data-pinned-elsewhere', 'true')
    await expect(rightToggle).toHaveAttribute('aria-description', 'Showing Worktree checkout, pinned')
    await expect(panel.locator('.tools-panel__thread')).toHaveText('Worktree checkoutPinned')
    await expect(panel.locator('.tools-panel__path-text')).toHaveAttribute('title', actual.directory)
    await capture(page, 'split-1600-pinned-other-pane-focused')
    expect(await closeWithKey(page, panel, 'Enter')).toBe(notesThread)

    // 1280: a default-width panel cannot sit beside two 400px panes, so the split shows as tabs while Files is open.
    await resize(launched, 1280, 800)
    await expect(panes).not.toHaveAttribute('data-narrow')
    await page.keyboard.press('Enter')
    await expect(panel.getByRole('tab', { name: 'Files' })).toBeFocused()
    await expect(panel).toHaveAttribute('data-mode', 'docked')
    await expect(panes).toHaveAttribute('data-narrow', 'true')
    const docked1280 = await page.evaluate(() => ({
      pane: Math.round(document.querySelector('section.thread-pane[data-focused]')!.getBoundingClientRect().width),
      panel: Math.round(document.querySelector('.tools-panel__sheet')!.getBoundingClientRect().width),
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    }))
    expect(docked1280.pane).toBeGreaterThanOrEqual(480)
    expect(docked1280.panel).toBe(380)
    expect(docked1280.overflow).toBe(false)
    await capture(page, 'split-1280-docked-tabs-pinned')
    // Closing by keyboard restores the same split and keeps focus on the toggle through that re-layout.
    expect(await closeWithKey(page, panel, 'Enter')).toBe(notesThread)
    await expect(panes).not.toHaveAttribute('data-narrow')
    await capture(page, 'split-1280-closed-split-restored')

    // Unpinned, the panel follows a focus change, and closing returns to the newly focused pane's toggle.
    await page.keyboard.press('Enter')
    await panel.getByRole('button', { name: 'Unpin from Worktree checkout' }).click()
    await expect(panel.locator('.tools-panel__copy')).toHaveText('field-notes·Project folder')
    await expect(panel.locator('.tools-panel__path-text')).toHaveAttribute('title', notes)
    await expect(panel.getByRole('tree').getByRole('treeitem')).toHaveText(['draft.txt', 'today.md'])
    await page.getByRole('tab', { name: 'Worktree checkout' }).click()
    await expect(left).toHaveAttribute('data-focused')
    await expect(panel.locator('.tools-panel__path-text')).toHaveAttribute('title', actual.directory)
    await expect(panel.locator('.files-preview__markdown').getByRole('heading', { name: 'Repo app' })).toBeVisible()
    await capture(page, 'split-1280-docked-tabs-following')
    expect(await closeWithKey(page, panel, 'Enter')).toBe(worktreeThread)

    // 820x560 minimum: the panel overlays the focused tab; Escape and Enter both return to its toggle.
    await resize(launched, 820, 560)
    await page.keyboard.press('Enter')
    await expect(panel).toHaveAttribute('data-mode', 'overlay')
    await expect(panel.getByRole('tab', { name: 'Files' })).toBeFocused()
    await capture(page, 'overlay-820x560-following')
    expect(await closeWithKey(page, panel, 'Escape')).toBe(worktreeThread)
    await page.keyboard.press('Enter')
    await panel.getByRole('button', { name: 'Pin to Worktree checkout' }).click()
    // The overlay covers the pane tabs, so the other thread takes focus from the sidebar.
    await sidebar.getByRole('button', { name: 'Field notes', exact: true }).click()
    await expect(right).toHaveAttribute('data-focused')
    await expect(right.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute('data-pinned-elsewhere', 'true')
    await capture(page, 'overlay-820x560-pinned-other-tab')
    expect(await closeWithKey(page, panel, 'Enter')).toBe(notesThread)
    await page.keyboard.press('Enter')
    await panel.getByRole('button', { name: 'Unpin from Worktree checkout' }).click()
    expect(await closeWithKey(page, panel, 'Escape')).toBe(notesThread)

    // Retained browsing: back at 1280 on the worktree thread, the open README is still selected.
    await resize(launched, 1280, 800)
    await page.getByRole('button', { name: 'Close Field notes pane' }).click()
    await expect(panes).not.toHaveAttribute('data-split')
    await left.getByRole('textbox', { name: 'Prompt', exact: true }).click()
    await left.getByRole('button', { name: 'Files', exact: true }).click()
    await expect(panel).toHaveAttribute('data-mode', 'docked')
    await expect(panel.getByRole('tree').getByRole('treeitem', { name: 'README.md' })).toHaveAttribute('aria-selected', 'true')
    await capture(page, 'single-1280-worktree-docked')
  } finally {
    await closeSotto(launched)
    await rm(root, { recursive: true, force: true })
  }
})
