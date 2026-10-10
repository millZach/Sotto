import { initializeGitRepository } from '../fixtures/gitRepository'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'

/**
 * A worktree thread's terminal drawer (#908): a real Git project and a thread with its own worktree, real Git and
 * terminal IPC; only the provider is a fixture. The drawer's shell starts in the project folder, not the worktree,
 * and its bar leaves out the worktree's branch. Captures go to artifacts/e2e-runs/pane-terminal-project-folder/.
 */
const SHOTS = resolve('artifacts/e2e-runs/pane-terminal-project-folder')

async function drawerOutput(page: Page, threadId: string): Promise<string> {
  return page.evaluate(async thread => {
    const list = await window.sotto!.terminal!.list({ threadId: thread, place: 'drawer' })
    const session = list.ok ? list.value.sessions[0] : undefined
    if (!list.ok || !session) return ''
    const read = await window.sotto!.terminal!.read({ threadId: thread, workspaceId: list.value.workspace.workspaceId, sessionId: session.id })
    return read.ok ? read.value.output : ''
  }, threadId)
}

test('a worktree thread’s terminal drawer starts in the project folder and names no branch', async () => {
  test.skip(process.platform !== 'win32', 'Native Windows ConPTY acceptance')
  test.setTimeout(180_000)
  const root = (await ownedE2EProfile({ prefix: 'sotto-e2e-drawer-project-' })).directory
  const repo = join(root, 'drawer-project')
  await initializeGitRepository(repo, { files: { 'README.md': '# Drawer project\n' }, message: 'Initial', identity: { name: 'Sotto Test', email: 'test@sotto.invalid' } })
  const project = await realpath(repo)
  const launched = await launchSotto()
  const { page } = launched
  await mkdir(SHOTS, { recursive: true })
  try {
    const threadId = await page.evaluate(async path => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' })
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { enabled: true } })
      await agents.command({ type: 'connect' })
      await agents.command({ type: 'create-project', title: 'drawer-project', path, useExisting: true })
      const projectId = (await agents.get()).host.projects.find(item => item.title === 'drawer-project')!.id
      await agents.command({ type: 'create-thread', projectId, title: 'Worktree drawer', modelId: 'claude:test', workingCopy: 'independent' })
      const id = (await agents.get()).host.threads.find(item => item.title === 'Worktree drawer')!.id
      // The worktree is made on the first send.
      await agents.command({ type: 'manual-send', threadId: id, text: 'Look around.' })
      await window.sottoE2E!.agentEvent!({ type: 'ready', threadId: id, status: 'idle', text: 'Looked around.' })
      return id
    }, repo)
    const worktree = await page.evaluate(async id => {
      const thread = (await window.sotto!.agents!.get()).host.threads.find(item => item.id === id)!
      return { status: thread.worktree?.status, mode: thread.worktree?.mode, path: thread.worktree?.path ?? '', branch: thread.worktree?.branch ?? '' }
    }, threadId)
    expect(worktree).toMatchObject({ status: 'ready', mode: 'independent' })
    expect(worktree.path.toLowerCase()).not.toBe(project.toLowerCase())
    expect(worktree.branch).not.toBe('')

    await page.evaluate(async id => { await window.sotto!.agents!.command({ type: 'select-thread', threadId: id }) }, threadId)
    await page.reload()
    await resizeWindow(launched, 1280, 800)
    await openThreads(page)
    const pane = page.locator(`section.thread-pane[data-thread-id="${threadId}"]`)
    await expect(pane).toBeVisible()
    await pane.locator('[data-pane-terminal-toggle]').click()
    const drawer = page.locator('.pane-terminal')
    await expect(drawer.getByRole('tab', { selected: true })).toBeVisible()

    const input = drawer.locator('.xterm-helper-textarea')
    await input.click()
    // The marker is joined by the shell, so the echoed command line never matches it.
    await input.pressSequentially('Write-Output ("start" + "-cwd=" + (Get-Location).Path + "=end")')
    await input.press('Enter')
    await expect.poll(async () => {
      const output = (await drawerOutput(page, threadId)).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r?\n/g, '')
      return /start-cwd=(.+?)=end/.exec(output)?.[1]?.trim().toLowerCase() ?? ''
    }, { timeout: 30_000 }).toBe(project.toLowerCase())
    // The worktree's branch would name a checkout the shell is not in.
    await expect(drawer.locator('.pane-terminal__branch')).toHaveCount(0)
    await expect(drawer).not.toContainText(worktree.branch)
    await page.screenshot({ path: join(SHOTS, 'drawer-project-folder-1280x800-dark.png'), animations: 'disabled' })
  } finally {
    await closeSotto(launched)
    await removeOwnedE2EProfile(root)
  }
})
