/* global window */
import { _electron as electron, expect } from '@playwright/test'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import console from 'node:console'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-phase5-compaction-'))
const bundled = await build({ entryPoints: ['src/shared/settings.ts'], bundle: true, format: 'esm', platform: 'node', write: false })
const { DEFAULT_SETTINGS } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
const themesBundle = await build({ entryPoints: ['src/shared/themes/library.ts'], bundle: true, format: 'esm', platform: 'node', write: false })
const { BUILT_IN_THEMES } = await import(`data:text/javascript;base64,${Buffer.from(themesBundle.outputFiles[0].text).toString('base64')}`)
const themeIds = BUILT_IN_THEMES.map(theme => theme.id)
await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark' }))
const shots = resolve('artifacts/phase-five-compaction'); await mkdir(shots, { recursive: true })
const env = { ...process.env, SOTTO_E2E: '1', SOTTO_E2E_SCENARIO: 'success', SOTTO_E2E_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['out/main/index.js'], env })
try {
  let page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded')
  if (!page.url().endsWith('/index.html')) page = app.windows().find(page => page.url().endsWith('/index.html')) ?? await app.waitForEvent('window', { predicate: async page => { await page.waitForLoadState('domcontentloaded'); return page.url().endsWith('/index.html') } })
  await page.evaluate(async () => {
    await window.sotto.agents.command({ type: 'configure', patch: { enabled: true, speak: false } })
    await window.sotto.agents.command({ type: 'connect' })
    await window.sottoE2E.agentEvent({ type: 'ready', threadId: 'workshop', status: 'idle', text: 'The implementation is ready to review.' })
  })
  await page.getByRole('link', { name: 'Threads', exact: true }).click()
  await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
  const state = await page.evaluate(() => window.sotto.agents.get())
  const current = state.host.threads.find(thread => thread.id === 'workshop')
  current.providerId = 'claude'; current.status = 'idle'; current.requests = []; current.manualCompactionSupported = true
  current.usage = { contextUsed: 120000, contextWindow: 200000, contextUpdatedAt: new Date(Date.now() - 71 * 60000).toISOString(), updatedAt: new Date().toISOString(), partial: false, rateVersions: [] }
  current.messages = [{ id: 'prompt', role: 'user', text: 'Review the implementation and preserve the current plan.', createdAt: new Date().toISOString() }, { id: 'answer', role: 'assistant', text: 'The implementation is ready to review.', createdAt: new Date().toISOString() }]
  state.host.capabilities.compact = true
  state.host.providers = [{ id: 'claude', name: 'Claude Code', version: 'Fixture', connection: 'connected', capabilities: state.host.capabilities }]
  state.configuration.provider = 'claude'
  const emit = async () => app.evaluate(({ BrowserWindow }, state) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('sotto:agents:state', state) }, state)
  await emit()
  await page.getByRole('button', { name: 'Keep full history', exact: true }).waitFor()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const [width, height] of [[1280, 860], [820, 560]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).setContentSize(...size), [width, height])
    for (const appearance of ['dark', 'light']) {
      for (const themeId of themeIds) {
        await page.evaluate(({ appearance, themeId }) => window.sotto.updateSettings({ appearance, darkTheme: themeId, lightTheme: themeId }), { appearance, themeId })
        await emit()
        await page.getByRole('button', { name: 'Keep full history', exact: true }).focus()
        await page.screenshot({ path: join(shots, `recommendation-${width}-${appearance}-${themeId}.png`), animations: 'disabled' })
        expect(await page.locator('.thread-compaction').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      }
    }
  }
  await page.evaluate(() => window.sotto.updateSettings({ appearance: 'light', darkTheme: 'ocean', lightTheme: 'ocean' }))
  await emit()
  await page.getByRole('button', { name: 'Keep full history', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Keep full history' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Compact context' }).focus()
  await expect(page.getByRole('button', { name: 'Compact context' })).toBeFocused()
  current.compaction = { commandId: 'fixture', status: 'running' }; current.status = 'running'; await emit()
  await expect(page.getByRole('button', { name: 'Compact context' })).toBeDisabled()
  await page.screenshot({ path: join(shots, 'running-820-light.png'), animations: 'disabled' })
  current.compaction = { commandId: 'fixture', status: 'failed', error: 'Native compaction failed. The provider could not complete this request.' }; current.status = 'idle'; await emit()
  await page.screenshot({ path: join(shots, 'failure-820-light.png'), animations: 'disabled' })
  current.compaction = { commandId: 'fixture', status: 'completed' }; await emit()
  await expect(page.getByRole('status').filter({ hasText: 'Context compacted' })).toBeVisible()
  await page.screenshot({ path: join(shots, 'completed-820-light.png'), animations: 'disabled' })
  console.log(JSON.stringify({ profile, providerCalls: 0, fixture: true, sizes: ['1280x860', '820x560'], appearance: ['dark', 'light'], themes: themeIds, keyboardDismissal: true, overflow: false, shots }))
} finally { await app.close() }
