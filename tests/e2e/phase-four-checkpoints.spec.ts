import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { closeSotto, launchSotto } from './support/sottoLaunch'

test('inspects a completed checkpoint and explicitly rewinds files and the same conversation', async () => {
  test.setTimeout(120000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-phase4-checkpoint-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark' }))
  const repo = join(profile, 'checkpoint-repo'); await mkdir(repo)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true })
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Sotto verification'); git('config', 'user.email', 'verification@example.invalid')
  await writeFile(join(repo, 'greeting.ts'), 'export const greeting = "Hello"\n')
  await writeFile(join(repo, 'notes.txt'), 'My notes\n')
  git('add', '.'); git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'Owned checkpoint fixture')
  const launched = await launchSotto('phase3-workspace', profile)
  const { page, app } = launched
  try {
    const threadId = await page.evaluate(async repo => {
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await agents.command({ type: 'connect' })
      const created = await agents.command({ type: 'create-project', title: 'Checkpoint project', path: repo, useExisting: true })
      const projectId = created.host.projects.find(project => project.title === 'Checkpoint project')!.id
      const state = await agents.command({ type: 'create-thread', projectId, title: 'Checkpoint review', modelId: 'codex:gpt', managed: false, workingCopy: 'shared' })
      if (!state.activeThreadId || state.error) throw new Error(state.error ?? 'No selected thread')
      await agents.command({ type: 'manual-send', threadId: state.activeThreadId, text: 'Make the greeting friendlier.' })
      return state.activeThreadId
    }, repo)
    await expect.poll(() => page.evaluate(async id => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === id)?.status, threadId)).toBe('running')
    await writeFile(join(repo, 'greeting.ts'), 'export const greeting = "Hello, Sotto"\n')
    await page.evaluate(async threadId => window.sottoE2E!.agentEvent!({ type: 'ready', threadId, status: 'idle', text: 'The greeting is friendlier now.' }), threadId)
    await expect.poll(() => page.evaluate(async threadId => {
      const result = await window.sotto!.gitChanges!.checkpoints!({ threadId })
      return result.ok ? result.value.checkpoints[0]?.status : result.error.message
    }, threadId)).toBe('ready')
    await writeFile(join(repo, 'notes.txt'), 'My unrelated later notes\n')
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    await page.getByRole('button', { name: 'Checkpoint review', exact: true }).first().click()
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Tools' })
    await panel.getByRole('tab', { name: 'Changes' }).click()
    await panel.getByRole('button', { name: 'Checkpoints', exact: true }).click()
    await panel.getByRole('button', { name: /Checkpoint 1 · 1 files? · ready/ }).click()
    await panel.locator('summary').filter({ hasText: 'greeting.ts' }).click()
    const review = panel.getByRole('region', { name: 'Checkpoint review' })
    await expect(review).toContainText('export const greeting = "Hello"')
    await expect(review).toContainText('export const greeting = "Hello, Sotto"')
    await expect(review.getByRole('button', { name: 'Revert files and conversation' })).toBeDisabled()
    const shots = resolve('artifacts/phase-four-git'); await mkdir(shots, { recursive: true })
    for (const [width, height] of [[1280, 860], [1600, 1000], [820, 560]]) {
      await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(width!, height!), [width, height])
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await review.getByRole('checkbox').scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(shots, `checkpoint-review-${width}-${appearance}.png`), animations: 'disabled' })
      }
    }
    await review.getByRole('checkbox').focus(); await page.keyboard.press('Space')
    await review.getByRole('button', { name: 'Revert files and conversation' }).focus(); await page.keyboard.press('Enter')
    await expect(panel.getByText('Files and native conversation reverted.', { exact: true })).toBeVisible()
    expect(await readFile(join(repo, 'greeting.ts'), 'utf8')).toBe('export const greeting = "Hello"\n')
    expect(await readFile(join(repo, 'notes.txt'), 'utf8')).toBe('My unrelated later notes\n')
    const thread = await page.evaluate(async id => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === id), threadId)
    expect(thread).toMatchObject({ id: threadId, providerId: 'codex', messages: [] })
  } finally { await closeSotto(launched) }
})
