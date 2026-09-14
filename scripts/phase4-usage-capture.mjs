/* global window, document */
import process from 'node:process'
import console from 'node:console'
import { _electron as electron } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Manual visual inspection harness. Synthetic renderer usage is injected over the
// real validated state bridge; this does not claim native provider verification.
const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-phase4-usage-'))
await writeFile(join(profile, 'settings.json'), JSON.stringify({ onboardingComplete: true, historyEnabled: true }))
const app = await electron.launch({ args: ['out/main/index.js'], env: Object.fromEntries(Object.entries({ ...process.env, SOTTO_E2E: '1', SOTTO_E2E_SCENARIO: 'success', SOTTO_E2E_USER_DATA: profile }).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')) })
try {
  const first = await app.firstWindow()
  await first.waitForLoadState('domcontentloaded')
  const page = first.url().endsWith('/index.html') ? first : app.windows().find(window => window.url().endsWith('/index.html')) ?? await app.waitForEvent('window')
  await page.evaluate(async () => {
    await window.sotto.updateSettings({ onboardingComplete: true })
    await window.sotto.agents.command({ type: 'configure', patch: { enabled: true, speak: false, reasoning: 'codex', reasoningModel: 'codex:test', reasoningEffort: 'low' } })
    await window.sotto.agents.command({ type: 'connect' })
    await window.sottoE2E.agentEvent({ type: 'ready', threadId: 'workshop', text: 'The usage indicators stay beside this thread while you work.' })
  })
  await page.getByRole('link', { name: 'Threads', exact: true }).click()
  await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
  for (const [width, height] of [[1280, 860], [1600, 1000], [820, 560]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setContentSize(...size), [width, height])
    for (const appearance of ['light', 'dark']) {
      await page.evaluate(async theme => { await window.sotto.updateSettings({ appearance: theme }) }, appearance)
      const state = await page.evaluate(() => window.sotto.agents.get())
      state.host.threads.find(thread => thread.id === 'workshop').usage = {
        latest: { input: 23551, output: 154, cached: 13056 }, contextUsed: 23561, contextWindow: 258400,
        elapsedMs: 4210, estimatedUsd: 0.118506, rateVersions: ['2026-09-13-standard-v1'], partial: true, updatedAt: new Date().toISOString(),
      }
      await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).webContents.send('sotto:agents:state', value), state)
      await page.locator('.thread-usage').waitFor()
      await page.screenshot({ path: resolve(`artifacts/phase-four-usage/usage-${width}-${appearance}.png`) })
      await page.locator('.thread-usage summary').focus()
      await page.keyboard.press('Enter')
      await page.screenshot({ path: resolve(`artifacts/phase-four-usage/usage-basis-${width}-${appearance}.png`) })
      await page.keyboard.press('Enter')
    }
  }
  await page.evaluate(async () => {
    const chats = window.sotto.personalChats
    await chats.connect()
    const id = (await chats.create()).selectedChatId
    await chats.saveDraft({ chatId: id, revision: 1, text: 'Build a quiet reading app with a single article view and a saved reading list. Keep the interface focused and support keyboard navigation.', skills: [] })
    await chats.send({ chatId: id, revision: 1 })
    await window.sottoE2E.agentEvent({ scope: 'personal', type: 'ready', threadId: id, text: 'We can keep reading central and put saved articles in a simple sidebar.' })
  })
  await page.getByRole('link', { name: 'Chats', exact: true }).click()
  await page.getByRole('button', { name: 'Make prompt', exact: true }).click()
  await page.getByRole('textbox', { name: 'Editable prompt' }).waitFor()
  for (const [width, height] of [[1280, 860], [820, 560]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setContentSize(...size), [width, height])
    for (const appearance of ['light', 'dark']) {
      await page.evaluate(async theme => { await window.sotto.updateSettings({ appearance: theme }) }, appearance)
      await page.screenshot({ path: resolve(`artifacts/phase-four-usage/prompt-${width}-${appearance}.png`) })
    }
  }
  await page.getByRole('textbox', { name: 'Editable prompt' }).fill('Build a quiet reading app. Keyboard navigation is required.')
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')); window.show(); window.focus(); window.webContents.focus() })
  await page.getByRole('button', { name: 'Copy prompt', exact: true }).click()
  await page.getByRole('status').filter({ hasText: /^Copied$/ }).waitFor({ timeout: 5000 }).catch(async () => console.log('Copy state:', await page.getByRole('dialog').innerText(), 'focused:', await page.evaluate(() => document.hasFocus())))
  console.log('Prompt clipboard:', await app.evaluate(({ clipboard }) => clipboard.readText()))
  await page.keyboard.press('Escape')
  console.log('After Escape focus:', await page.evaluate(() => document.activeElement?.textContent))
  console.log(JSON.stringify({ profile, captured: '1280,1600,820 light/dark, keyboard estimate disclosure' }))
} finally { await app.close() }
