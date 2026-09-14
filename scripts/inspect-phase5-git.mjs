/* global window */
import { _electron as electron, expect } from '@playwright/test'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import console from 'node:console'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-phase5-pr-'))
const bundled = await build({ entryPoints: ['src/shared/settings.ts'], bundle: true, format: 'esm', platform: 'node', write: false })
const { DEFAULT_SETTINGS } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark' }))
const shots = resolve('artifacts/phase-five-git'); await mkdir(shots, { recursive: true })
const env = { ...process.env, SOTTO_E2E: '1', SOTTO_E2E_SCENARIO: 'success', SOTTO_E2E_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['out/main/index.js'], env })
try {
  let page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded')
  if (!page.url().endsWith('/index.html')) page = app.windows().find(page => page.url().endsWith('/index.html')) ?? await app.waitForEvent('window', { predicate: async page => { await page.waitForLoadState('domcontentloaded'); return page.url().endsWith('/index.html') } })
  const folder = await page.evaluate(async () => {
    await window.sotto.updateSettings({ onboardingComplete: true, appearance: 'dark' })
    await window.sotto.agents.command({ type: 'configure', patch: { enabled: true, speak: false } })
    const state = await window.sotto.agents.command({ type: 'connect' })
    return state.host.projects.find(project => project.id === state.host.threads.find(item => item.id === 'workshop').projectId).path
  })
  if (!folder.startsWith(profile)) throw new Error('Fixture folder escaped owned profile')
  await mkdir(folder, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: folder, windowsHide: true, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'feature/greeting'); git('config', 'user.name', 'Sotto verification'); git('config', 'user.email', 'verify@example.invalid'); git('config', 'commit.gpgSign', 'false')
  await writeFile(join(folder, 'app.ts'), 'export const greeting = "Hello, Sotto"\n'); git('add', '.'); git('commit', '-qm', 'Make the greeting friendlier')
  const remote = join(profile, 'owned-remote.git'); git('init', '--bare', '-q', remote); git('remote', 'add', 'origin', remote)
  await page.evaluate(() => window.sottoE2E.agentEvent({ type: 'ready', threadId: 'workshop', status: 'idle', text: 'The greeting is ready to review.' }))
  await page.getByRole('link', { name: 'Threads', exact: true }).click(); await page.getByRole('button', { name: 'Workshop', exact: true }).first().click(); await page.getByRole('button', { name: 'Tools', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'Tools' }); await panel.getByRole('tab', { name: 'Changes' }).click(); await panel.getByRole('button', { name: 'Pull request', exact: true }).click()
  await expect(panel.getByRole('textbox', { name: 'PR title' })).toHaveValue('Make the greeting friendlier')
  if (git('--git-dir', remote, 'for-each-ref', '--format=%(refname)', 'refs/heads')) throw new Error('Viewing published unexpectedly')
  await panel.getByRole('button', { name: 'Push branch', exact: true }).focus(); await page.keyboard.press('Enter'); await panel.getByText('Branch pushed.', { exact: true }).waitFor()
  const pushed = git('--git-dir', remote, 'rev-parse', 'refs/heads/feature/greeting'); if (pushed !== git('rev-parse', 'HEAD')) throw new Error('Wrong commit pushed')
  await page.screenshot({ path: join(shots, 'owned-push.png') })
  // Faithful reviewed/status IPC fixture for UI states. No GitHub write is issued.
  const review = await page.evaluate(async () => (await window.sotto.gitChanges.reviewPullRequest({ threadId: 'workshop' })).value)
  const pr = { number: 17, title: 'Make the greeting friendlier', url: 'https://github.com/sotto-fixture/owned/pull/17', state: 'OPEN', base: 'main', head: 'feature/greeting', draft: false, review: 'REVIEW_REQUIRED', checks: [{ name: 'Build Windows', status: 'SUCCESS', url: 'https://github.com/sotto-fixture/owned/actions/runs/17' }, { name: 'Review', status: 'IN_PROGRESS', url: null }] }
  const fixture = { ...review, remoteUrl: 'https://github.com/sotto-fixture/owned.git', repository: 'https://github.com/sotto-fixture/owned', base: 'main', error: null }
  await app.evaluate(({ ipcMain }, fixture) => { ipcMain.removeHandler('sotto:git-changes:reviewPullRequest'); ipcMain.handle('sotto:git-changes:reviewPullRequest', () => ({ ok: true, value: fixture })) }, fixture)
  await panel.getByRole('button', { name: 'Refresh pull request' }).click(); await panel.getByRole('textbox', { name: 'Base branch' }).fill('main'); await panel.getByRole('textbox', { name: 'PR body' }).fill('Clarifies the greeting when a new conversation opens.\n\nValidated on Windows.')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const [width, height] of [[1280, 860], [1600, 1000], [820, 560]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).setContentSize(...size), [width, height])
    for (const appearance of ['dark', 'light', 'system']) {
      await page.evaluate(appearance => window.sotto.updateSettings({ appearance }), appearance)
      await panel.getByRole('textbox', { name: 'Base branch' }).focus()
      await page.screenshot({ path: join(shots, `review-${width}-${appearance}.png`), animations: 'disabled' })
      const overflow = await panel.locator('.git-pr').evaluate(el => el.scrollWidth > el.clientWidth)
      if (overflow) throw new Error(`Horizontal overflow at ${width} ${appearance}`)
    }
  }
  // Built-in palettes from src/shared/themes/library.ts; imported custom themes
  // retain the same roles but are not a finite verification matrix.
  for (const [width, height] of [[1280, 860], [820, 560]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).setContentSize(...size), [width, height])
    for (const palette of ['t3-code', 't3-chat', 'grove', 'ocean', 'ember', 'iris']) for (const appearance of ['dark', 'light']) {
      await page.evaluate(({ palette, appearance }) => window.sotto.updateSettings({ appearance, lightTheme: palette, darkTheme: palette }), { palette, appearance })
      await panel.getByRole('textbox', { name: 'Base branch' }).focus()
      await page.screenshot({ path: join(shots, `palette-${palette}-${width}-${appearance}.png`), animations: 'disabled' })
      expect(await panel.locator('.git-pr').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    }
  }
  await page.evaluate(() => window.sotto.updateSettings({ appearance: 'system', lightTheme: 'ocean', darkTheme: 'ocean' }))
  await panel.getByRole('textbox', { name: 'PR body' }).focus(); await page.keyboard.press('Tab'); await expect(panel.getByRole('button', { name: 'Push branch' })).toBeFocused(); await page.keyboard.press('Tab'); await expect(panel.getByRole('button', { name: 'Create pull request' })).toBeFocused()
  await app.evaluate(({ ipcMain }, pr) => { ipcMain.removeHandler('sotto:git-changes:actPullRequest'); ipcMain.handle('sotto:git-changes:actPullRequest', (_event, payload) => { if (payload.action !== 'create' || payload.title !== 'Make the greeting friendlier' || payload.base !== 'main' || !payload.body.includes('Validated on Windows.')) throw new Error('Edited review not passed to action'); return { ok: true, value: { message: 'Pull request created.', pullRequest: pr } } }) }, pr)
  await page.keyboard.press('Enter'); await panel.getByRole('region', { name: 'Pull request status' }).waitFor(); await panel.getByRole('region', { name: 'Pull request status' }).evaluate(el => el.scrollIntoView({ block: 'start' })); await page.screenshot({ path: join(shots, 'status-820-system.png') })
  await app.evaluate(({ ipcMain }, fixture) => { ipcMain.removeHandler('sotto:git-changes:reviewPullRequest'); ipcMain.handle('sotto:git-changes:reviewPullRequest', () => ({ ok: true, value: { ...fixture, error: 'Could not refresh GitHub. Check gh authentication and network access. HTTP 401: Bad credentials' } })) }, fixture)
  await panel.getByRole('button', { name: 'Refresh pull request' }).click(); await panel.getByText(/HTTP 401/).waitFor(); await expect(panel.getByRole('button', { name: 'Create pull request' })).toBeDisabled(); await page.screenshot({ path: join(shots, 'authentication-820-system.png') })
  console.log(JSON.stringify({ profile, ownedRemote: remote, pushedCommit: pushed, realGitHubWrites: 0, dimensions: ['1280x860', '1600x1000', '820x560'], themes: ['dark', 'light', 'system'], reducedMotion: true, keyboardPushAndCreate: true, shots }))
} finally { await app.close() }
