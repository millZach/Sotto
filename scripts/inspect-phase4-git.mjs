/* global window */
import { _electron as electron } from '@playwright/test'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import console from 'node:console'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

// Repeatable visual inspection in a disposable profile and a disposable Git repository.
const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-phase4-git-'))
const bundled = await build({ entryPoints: ['src/shared/settings.ts'], bundle: true, format: 'esm', platform: 'node', write: false })
const { DEFAULT_SETTINGS } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark' }))
const shots = resolve('artifacts/phase-four-git')
await mkdir(shots, { recursive: true })
const env = { ...process.env, SOTTO_E2E: '1', SOTTO_E2E_SCENARIO: 'success', SOTTO_E2E_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['out/main/index.js'], env })
try {
  let page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (!page.url().endsWith('/index.html')) page = app.windows().find(page => page.url().endsWith('/index.html')) ?? await app.waitForEvent('window', { predicate: async page => { await page.waitForLoadState('domcontentloaded'); return page.url().endsWith('/index.html') } })
  const folder = await page.evaluate(async () => {
    await window.sotto.updateSettings({ onboardingComplete: true, appearance: 'dark' })
    await window.sotto.agents.command({ type: 'configure', patch: { enabled: true, speak: false } })
    const state = await window.sotto.agents.command({ type: 'connect' })
    const thread = state.host.threads.find(item => item.id === 'workshop')
    return state.host.projects.find(project => project.id === thread.projectId).path
  })
  if (!folder.startsWith(profile)) throw new Error('Fixture working folder escaped its owned profile.')
  await mkdir(join(folder, 'src'), { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: folder, windowsHide: true, encoding: 'utf8' })
  git('init', '-q'); git('config', 'user.name', 'Sotto verification'); git('config', 'user.email', 'verify@example.invalid'); git('config', 'core.autocrlf', 'false'); git('config', 'commit.gpgSign', 'false')
  await writeFile(join(folder, 'src/app.ts'), 'export const greeting = "Hello"\n')
  git('add', '.'); git('commit', '-qm', 'Owned fixture')
  await writeFile(join(folder, 'src/app.ts'), 'export const greeting = "Hello, Sotto"\n')
  await page.evaluate(() => window.sottoE2E.agentEvent({ type: 'ready', threadId: 'workshop', status: 'idle', text: 'The greeting is ready to review.' }))
  await page.getByRole('link', { name: 'Threads', exact: true }).click()
  await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
  await page.getByRole('button', { name: 'Tools', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'Tools' })
  await panel.getByRole('tab', { name: 'Changes' }).click()
  await panel.getByRole('option', { name: /^app\.ts/ }).click()
  await panel.getByRole('button', { name: 'Stage file', exact: true }).click()
  await panel.getByRole('button', { name: 'Unstage file', exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Git actions', exact: true }).click()
  await panel.getByRole('textbox', { name: 'Commit message' }).fill('Make the greeting friendlier')
  await panel.getByRole('button', { name: 'Refresh changes' }).click()
  await panel.getByRole('region', { name: 'Changes in src/app.ts' }).getByText('export const greeting = "Hello, Sotto"', { exact: false }).waitFor()
  for (const [width, height] of [[1280, 860], [1600, 1000], [820, 560]]) {
    await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setContentSize(width, height), [width, height])
    for (const appearance of ['dark', 'light']) {
      await page.evaluate(appearance => window.sotto.updateSettings({ appearance }), appearance)
      await page.screenshot({ path: join(shots, `git-actions-${width}-${appearance}.png`), animations: 'disabled' })
    }
  }
  await panel.getByRole('button', { name: 'Commit staged changes (1)' }).click()
  await panel.getByText('Commit created.', { exact: true }).waitFor()
  console.log(JSON.stringify({ profile, commit: git('log', '-1', '--pretty=%s').trim(), files: git('status', '--porcelain').trim(), shots }))
  await panel.getByRole('combobox', { name: 'Local branch' }).fill('feature/greeting')
  await panel.getByRole('button', { name: 'Create branch', exact: true }).focus()
  await page.keyboard.press('Enter')
  await panel.getByText('Branch changed.', { exact: true }).waitFor()
  await page.screenshot({ path: join(shots, 'git-branch-820-light.png'), animations: 'disabled' })
  console.log(JSON.stringify({ branch: git('branch', '--show-current').trim() }))
  await panel.getByRole('button', { name: 'Checkpoints', exact: true }).click()
  await page.screenshot({ path: join(shots, 'checkpoints-820-light.png'), animations: 'disabled' })
} finally { await app.close() }
