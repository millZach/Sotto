import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto } from '../../e2e/support/sottoLaunch'
import { evidence, focusedLabel, paneMetrics, shot, size } from './support'

// Real production Electron with the E2E fixture provider and real Git: an independent working copy of a repository
// with no commits cannot be set up. Its composer keeps the draft but cannot submit it to another folder.

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', windowsHide: true })

test('a thread whose working folder failed keeps its draft and cannot submit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-composer-worktree-'))
  const fresh = join(root, 'fresh-repo')
  await mkdir(fresh)
  git(fresh, 'init', '-q')
  const launched = await launchSotto()
  const { page } = launched
  const record: Record<string, unknown> = {}
  try {
    const id = await page.evaluate(async folder => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', accent: 'teal' })
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await agents.command({ type: 'connect' })
      await agents.command({ type: 'create-project', title: 'fresh-repo', path: folder, useExisting: true })
      const projectId = (await agents.get()).host.projects.find(item => item.title === 'fresh-repo')!.id
      await agents.command({ type: 'create-thread', projectId, title: 'Fresh repository', modelId: 'claude:test', managed: false, workingCopy: 'independent' })
      return (await agents.get()).host.threads.find(item => item.title === 'Fresh repository')?.id ?? null
    }, fresh)
    expect(id).not.toBeNull()
    await page.reload()
    await size(launched, 1280, 800)
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Fresh repository', exact: true }).click()
    const pane = page.locator(`section.thread-pane[data-thread-id="${id}"]`)
    const prompt = pane.getByRole('textbox', { name: 'Prompt', exact: true })
    const submit = pane.locator('.thread-prompt__actions button[type="submit"]')
    await prompt.fill('Draft kept while setup failed.')
    record.worktree = await page.evaluate(async threadId => (await window.sotto!.agents!.get()).host.threads.find(item => item.id === threadId)?.worktree ?? null, id)
    await expect(submit).toBeDisabled()
    record.status = await pane.locator('.thread-prompt__status').innerText()
    expect(record.status).toContain('Available once the working folder is ready.')
    record.compose1280 = await pane.locator('.thread-workspace__compose').innerText()
    record.metrics1280 = await paneMetrics(page)
    await shot(page, 'worktree-1-failed-1280-dark')

    const before = await page.evaluate(async () => (await window.sotto!.agents!.get()).deliveries?.length ?? 0)
    await prompt.press('Enter')
    await page.waitForTimeout(600)
    record.afterEnter = {
      value: await prompt.inputValue(), focus: await focusedLabel(page),
      deliveries: await page.evaluate(async () => (await window.sotto!.agents!.get()).deliveries?.length ?? 0),
      notSent: await pane.getByText('Not sent', { exact: true }).count(),
    }
    expect(record.afterEnter).toMatchObject({ value: 'Draft kept while setup failed.', deliveries: before, notSent: 0 })
    await expect(prompt).toBeFocused()
    await shot(page, 'worktree-2-failed-after-enter-1280-dark')

    await size(launched, 820, 560)
    record.metrics820 = await paneMetrics(page)
    expect((record.metrics820 as { cardFullyVisible: boolean }).cardFullyVisible).toBe(true)
    await shot(page, 'worktree-3-failed-820x560-dark')
  } finally {
    await evidence('failed-worktree', record)
    await closeSotto(launched)
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
})
