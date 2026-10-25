/**
 * Keep main up to date (ADR-0140) in the built app with the `keep-main-current` Owl feature on, over a real project
 * repository and a real local remote: a local change holds main back and the project row says so, Show changes lists
 * the file, and once the change is gone the folder is fast-forwarded and the row says dependencies changed until
 * dismissed. Saving the switch asks for a check at once, so nothing waits for the 15-minute timer.
 *
 *   npm run build && npx playwright test tests/e2e/keep-main-current.spec.ts
 *
 * With `SOTTO_E2E_EVIDENCE=publish` the screenshots go to artifacts/keep-main-current/ for the verification note.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { captureWindow, closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'

const shots = evidenceDirectory('artifacts/keep-main-current')
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim()
const identity = (cwd: string, directory: string): void => {
  for (const [key, value] of [['user.name', 'Sotto verification'], ['user.email', 'verification@example.invalid'], ['commit.gpgSign', 'false'], ['core.hooksPath', join(directory, 'no-hooks')], ['core.autocrlf', 'false']] as const) git(cwd, 'config', key, value)
}

async function launch(directory: string): Promise<LaunchedSotto> {
  const previous = process.env['SOTTO_OWL_FEATURES']
  process.env['SOTTO_OWL_FEATURES'] = 'keep-main-current=1'
  try { return await launchSotto('phase3-workspace', directory) }
  finally { if (previous === undefined) delete process.env['SOTTO_OWL_FEATURES']; else process.env['SOTTO_OWL_FEATURES'] = previous }
}

/** Saving the switch asks for a check of every project at once. */
async function checkNow(page: Page): Promise<void> {
  await page.evaluate(async () => { await window.sotto!.updateSettings({ keepMainCurrent: false }); await window.sotto!.updateSettings({ keepMainCurrent: true }) })
}

test('an Owl build keeps a project\'s main up to date, and says on the project row why it could not', async () => {
  test.setTimeout(180_000)
  await mkdir(shots, { recursive: true })
  const directory = (await ownedE2EProfile({ prefix: 'sotto-e2e-keep-main-' })).directory
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark' }))
  const repository = join(directory, 'project'), remote = join(directory, 'remote.git'), other = join(directory, 'other')
  await mkdir(repository)
  git(repository, 'init', '-q', '-b', 'main'); identity(repository, directory)
  await writeFile(join(repository, 'tracked.txt'), 'baseline\n')
  await writeFile(join(repository, 'package-lock.json'), '{"lockfileVersion":3}\n')
  git(repository, 'add', '.'); git(repository, 'commit', '-qm', 'Baseline')
  git(directory, 'init', '--bare', '-q', '-b', 'main', remote)
  git(repository, 'remote', 'add', 'origin', remote); git(repository, 'push', '-q', '-u', 'origin', 'main'); git(repository, 'remote', 'set-head', 'origin', 'main')
  git(directory, 'clone', '-q', remote, other); identity(other, directory)
  await writeFile(join(other, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n')
  await writeFile(join(other, 'incoming.txt'), 'merged elsewhere\n')
  git(other, 'add', '.'); git(other, 'commit', '-qm', 'Merged pull request'); git(other, 'push', '-q', 'origin', 'main')
  // The user's own edit, which an update must never touch.
  await writeFile(join(repository, 'tracked.txt'), 'my local edit\n')
  const before = git(repository, 'rev-parse', 'HEAD')

  const sotto = await launch(directory)
  const { page } = sotto
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  try {
    await page.evaluate(async path => {
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { enabled: true } })
      await agents.command({ type: 'connect' })
      const project = await agents.command({ type: 'create-project', title: 'Keep main', path, useExisting: true })
      if (project.error) throw new Error(project.error)
      const projectId = project.host.projects.find(item => item.title === 'Keep main')!.id
      const thread = await agents.command({ type: 'create-thread', projectId, title: 'Shared folder thread', titleSource: 'user', modelId: 'codex:gpt', workingCopy: 'shared' })
      if (thread.error) throw new Error(thread.error)
    }, repository)
    await resizeContentWindow(sotto, 1280, 800)
    await openThreads(page)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })

    await checkNow(page)
    await expect(sidebar.getByText('main is 1 behind')).toBeVisible({ timeout: 60_000 })
    await expect(sidebar.getByText(/local changes block the update/u)).toBeVisible()
    expect(git(repository, 'rev-parse', 'HEAD')).toBe(before)
    await sidebar.getByRole('button', { name: 'Show changes in Keep main' }).click()
    await expect(sidebar.getByText('tracked.txt')).toBeVisible()
    await expect(sidebar.getByRole('button', { name: 'Open the Keep main folder' })).toBeVisible()
    for (const [width, height, theme] of [[1280, 800, 'dark'], [1280, 800, 'light'], [820, 560, 'dark']] as const) {
      await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, theme)
      await resizeContentWindow(sotto, width, height, [800, 540])
      const openFolder = sidebar.getByRole('button', { name: 'Open the Keep main folder' })
      await expect(async () => { await openFolder.scrollIntoViewIfNeeded(); await expect(openFolder).toBeInViewport() }).toPass({ timeout: 10_000 })
      await captureWindow(sotto.app, join(shots, `blocked-${width}x${height}-${theme}.png`))
    }
    await page.keyboard.press('Escape')
    await expect(sidebar.getByText('tracked.txt')).toBeHidden()

    // The user clears the way; the next check moves main forward and says the lockfile changed.
    git(repository, 'checkout', '--', 'tracked.txt')
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
    await resizeContentWindow(sotto, 1280, 800)
    await checkNow(page)
    await expect(sidebar.getByText('Updated main')).toBeVisible({ timeout: 60_000 })
    await expect(sidebar.getByText(/dependencies changed, run install/u)).toBeVisible()
    expect(git(repository, 'rev-parse', 'HEAD')).toBe(git(other, 'rev-parse', 'HEAD'))
    await sidebar.getByRole('button', { name: 'What changed in Keep main' }).click()
    await expect(sidebar.getByText('package-lock.json')).toBeVisible()
    // The thread sharing the folder reads its status again, so its Git action no longer offers Pull.
    await expect(page.getByRole('button', { name: /^Pull/u })).toHaveCount(0, { timeout: 30_000 })
    await captureWindow(sotto.app, join(shots, 'updated-1280x800-dark.png'))
    await sidebar.getByRole('button', { name: 'Dismiss dependencies changed in Keep main' }).click()
    await expect(sidebar.getByText('Updated main')).toBeHidden()
    expect(errors).toEqual([])
  } finally {
    await closeSotto(sotto)
    await removeOwnedE2EProfile(directory)
  }
})
