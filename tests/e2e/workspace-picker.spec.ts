import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { EMPTY_AGENT_HOST, defaultAgentConfiguration } from '../../src/shared/agents'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'

test('keeps workspace choices and project actions reachable with many worktrees and a long name', async () => {
  test.setTimeout(120_000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-workspace-picker-'))
  const repository = join(profile, 'project')
  await mkdir(repository)
  const git = (...args: string[]): void => { execFileSync('git', ['-c', 'user.name=Sotto E2E', '-c', 'user.email=e2e@sotto.invalid', '-c', 'commit.gpgSign=false', ...args], { cwd: repository, windowsHide: true, stdio: 'pipe' }) }
  git('init', '-b', 'main')
  git('commit', '--allow-empty', '-m', 'Initial fixture')
  const title = 'Sotto Workspace Projects with a very long project name'
  const threads = Array.from({ length: 12 }, (_, index) => {
    const path = join(profile, `worktree-${index}`)
    const branch = `fix/task-${index}-with-a-long-branch-name`
    git('worktree', 'add', '-b', branch, path)
    return { id: `recent-${index}`, projectId: 'project', title: `Earlier task ${index}`, modelId: '', status: 'idle', messages: [], requests: [], nativeSessionStarted: true,
      updatedAt: `2026-09-${String(index + 10).padStart(2, '0')}T00:00:00Z`, worktree: { mode: 'independent', status: 'ready', path, repositoryRoot: repository, branch } }
  })
  const current = { id: 'draft', projectId: 'project', title: 'New thread', modelId: '', status: 'idle', messages: [], requests: [], nativeSessionStarted: false,
    worktree: { mode: 'shared', status: 'ready', path: repository, repositoryRoot: repository, branch: 'main', git: { isRepository: true, branch: 'main', upstream: null, hasRemote: false, defaultBranch: 'main', isDefaultBranch: true, dirty: false, changedFiles: 0, insertions: 0, deletions: 0, ahead: 0, behind: 0, aheadOfDefault: null, pullRequest: null, fetchedAt: null, readAt: '2026-09-28T00:00:00Z' } } }
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true }))
  await writeFile(join(profile, 'agents.json'), JSON.stringify({ configuration: { ...defaultAgentConfiguration(), enabled: true, speak: false }, activeProjectId: 'project', activeThreadId: 'draft' }))
  await writeFile(join(profile, 'workspace.json'), JSON.stringify({ snapshot: { ...EMPTY_AGENT_HOST, projects: [{ id: 'project', title, path: repository }], threads: [current, ...threads] }, creations: [{ threadId: 'draft', projectId: 'project', commandId: 'fixture-draft', phase: 'unstarted' }], projectAliases: [] }))
  const launched = await launchSotto('success', profile)
  try {
    const { page } = launched
    await openThreads(page)
    await page.getByRole('region', { name: 'Projects' }).getByRole('button', { name: 'New thread', exact: true }).click()
    const chip = page.getByRole('combobox', { name: 'Choose workspace' })
    await expect(chip).toBeVisible()
    const head = page.locator('.thread-folder__head').filter({ has: page.getByRole('button', { name: new RegExp(`^${title}`) }) }).first()
    // Supply the remote-presence badge markup without opening an SSH connection. The HostBadge component's
    // host visibility and accessible names are covered in hostVisibility.test.tsx; here we exercise its layout
    // in the real Electron sidebar, including the icon and the new label span.
    await head.locator('.thread-folder__toggle').evaluate(element => {
      const badge = document.createElement('span')
      badge.className = 'host-badge'; badge.dataset.kind = 'local'; badge.title = 'On This computer'; badge.setAttribute('aria-hidden', 'true')
      badge.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 4h16v12H4zM2 20h20"/></svg><span class="host-badge__name">This computer</span>'
      element.querySelector('.thread-folder__title')!.after(badge)
    })
    const separator = page.getByRole('separator', { name: 'Resize sidebar' })
    for (const key of ['End', 'Home']) {
      await separator.focus()
      await separator.press(key)
      await head.hover()
      expect(await head.evaluate(element => {
        const badge = element.querySelector('.host-badge')!.getBoundingClientRect()
        return badge.right <= element.querySelector('.thread-folder__actions')!.getBoundingClientRect().left
      })).toBe(true)
      if (key === 'End') {
        await expect(head.locator('.host-badge__name')).toBeVisible()
        expect(await head.locator('.host-badge__name').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      }
      else await expect(head.locator('.host-badge__name')).toBeHidden()
      await head.screenshot({ path: test.info().outputPath(`project-header-${key === 'End' ? 'wide' : 'narrow'}.png`) })
    }
    await separator.dblclick()
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        for (const reducedMotion of ['no-preference', 'reduce'] as const) {
          await page.emulateMedia({ reducedMotion })
          await head.hover()
          expect(await head.evaluate(element => {
            const badge = element.querySelector('.host-badge')!.getBoundingClientRect()
            const actions = element.querySelector('.thread-folder__actions')!.getBoundingClientRect()
            return badge.right <= actions.left && actions.right <= element.getBoundingClientRect().right
          })).toBe(true)
          await chip.click()
          const picker = page.getByRole('dialog', { name: 'Choose workspace' })
          await expect(picker.getByRole('searchbox', { name: 'Search worktrees' })).toBeFocused()
          await expect(picker.getByRole('option')).toHaveCount(7)
          await expect(picker.getByRole('option', { name: 'Current checkout' })).toBeInViewport()
          await expect(picker.getByRole('option', { name: 'New worktree' })).toBeInViewport()
          expect(await picker.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && element.scrollWidth <= element.clientWidth })).toBe(true)
          await page.screenshot({ path: test.info().outputPath(`workspace-${width}-${appearance}-${reducedMotion}.png`), animations: 'disabled' })
          await page.keyboard.press('Escape')
          await expect(chip).toBeFocused()
        }
      }
    }
    await chip.click()
    const picker = page.getByRole('dialog', { name: 'Choose workspace' })
    const search = picker.getByRole('searchbox', { name: 'Search worktrees' })
    await search.fill('task-0-')
    await expect(picker.getByRole('option')).toHaveCount(3)
    await search.fill('no-such-worktree')
    await expect(picker.getByRole('status')).toHaveText('No matching worktrees.')
    await expect(picker.getByRole('option', { name: 'New worktree' })).toBeInViewport()
    await search.fill('task-')
    await expect(picker.getByRole('option')).toHaveCount(14)
    await search.press('ArrowDown')
    await expect(picker.getByRole('option', { name: 'Current checkout' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(picker.getByRole('option', { name: 'New worktree' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(chip).toHaveText(/New worktree/)
    await expect(chip).toBeFocused()
    await chip.click()
    await expect(search).toHaveValue('')
    await expect(picker.getByRole('option', { name: 'New worktree' })).toHaveAttribute('aria-selected', 'true')
    await search.fill('worktree-0')
    await picker.getByRole('option', { name: 'Previous worktree (fix/task-0-with-a-long-branch-name)' }).click()
    await expect(chip).toHaveText(/Previous worktree/)
    await chip.click()
    await picker.getByRole('option', { name: 'Current checkout' }).click()
    await expect(chip).toHaveText(/Current checkout/)

    // A lower grid pane clips its descendants. A popup inside it must use the pane's available height,
    // not the much larger distance from its trigger to the top of the window.
    await resizeWindow(launched, 1280, 800)
    await page.evaluate(async () => {
      const state = await window.sotto!.agents!.get()
      const draft = state.host.threads.find(thread => thread.title === 'New thread')!
      const others = state.host.threads.filter(thread => thread.id !== draft.id).slice(0, 2)
      localStorage.setItem('sotto.threadWorkspace.layout', JSON.stringify({ version: 1, panes: [...others.map(thread => thread.id), draft.id], focused: draft.id, arrangement: 'grid', sizes: [], grid: { rows: [], columns: [] }, zoomed: false }))
    })
    await page.reload()
    await openThreads(page)
    const lowerPane = page.locator('section.thread-pane').filter({ has: chip })
    expect((await lowerPane.boundingBox())!.y).toBeGreaterThan(300)
    await chip.click()
    await expect(search).toBeFocused()
    await search.fill('task-')
    await expect(picker.getByRole('option')).toHaveCount(14)
    expect(await picker.evaluate(element => {
      const menu = element.getBoundingClientRect()
      const pane = element.closest('.thread-pane')!.getBoundingClientRect()
      return menu.top >= pane.top && menu.bottom <= pane.bottom && menu.left >= pane.left && menu.right <= pane.right && menu.height <= 380
    })).toBe(true)
    await expect(picker.getByRole('option', { name: 'Current checkout' })).toBeInViewport()
    await expect(picker.getByRole('option', { name: 'New worktree' })).toBeInViewport()
    await page.screenshot({ path: test.info().outputPath('workspace-lower-pane.png'), animations: 'disabled' })
    await picker.getByRole('option', { name: 'New worktree' }).click()
    await expect(chip).toHaveText(/New worktree/)
  } finally {
    await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})
