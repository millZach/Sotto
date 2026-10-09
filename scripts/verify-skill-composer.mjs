// Usage: npm run build; node scripts/verify-skill-composer.mjs (one Electron journey, synthetic providers).
/* global window */
import { _electron as electron, chromium, expect } from '@playwright/test'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { log } from 'node:console'
import { requireOwnedE2EProfile } from '../scripts/e2e-profile-policy.mjs'

const root = resolve(import.meta.dirname, '..')
const output = join(root, 'artifacts/e2e-runs/skill-pill-core')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-skill-pill-'))
await writeFile(join(profile, 'settings.json'), JSON.stringify({ onboardingComplete: true, appearance: 'dark' }))
const env = Object.fromEntries(Object.entries({ ...process.env, SOTTO_E2E: '1', SOTTO_E2E_SCENARIO: 'phase3-workspace', SOTTO_E2E_USER_DATA: profile }).filter(([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined))
const app = await electron.launch({ args: [join(root, 'out/main/index.js')], env })
const errors = []
const evidence = []
let mainPage
try {
  const first = await app.firstWindow()
  await first.waitForLoadState('domcontentloaded')
  const page = app.windows().find(candidate => candidate.url().endsWith('/index.html')) ?? await app.waitForEvent('window', { predicate: candidate => candidate.url().endsWith('/index.html') })
  mainPage = page
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForLoadState('domcontentloaded')
  await page.screenshot({ path: join(output, 'first-use.png') })
  await page.evaluate(async () => {
    await window.sotto.agents.command({ type: 'configure', patch: { enabled: true, speak: false } })
    await window.sotto.agents.command({ type: 'connect' })
    await window.sotto.agents.command({ type: 'select-thread', threadId: 'grok-previews' })
  })
  if (!await page.getByRole('complementary', { name: 'Thread sidebar' }).isVisible()) {
    const link = page.getByRole('link', { name: 'Threads', exact: true })
    if (await link.count()) await link.click()
    else await page.getByRole('tab', { name: 'Threads', exact: true }).click()
  }
  const hostId = await page.evaluate(async () => (await window.sotto.agents.get()).hostId)
  const paneFor = id => page.locator(`section.thread-pane[data-thread-id="host:${hostId}:${id}"]`)
  for (const [threadId, token] of [['grok-previews', '/review'], ['release-notes', '$review'], ['benchmark', '/review']]) {
    await page.evaluate(id => window.sotto.agents.command({ type: 'select-thread', threadId: id }), threadId)
    const pane = paneFor(threadId)
    const prompt = pane.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('$rev')
    const list = pane.getByRole('listbox', { name: 'Skills' })
    await expect(list.getByRole('option')).toHaveCount(1)
    await expect(list.getByRole('option')).toContainText('review')
    await prompt.press('Tab')
    await expect(prompt).toHaveAttribute('data-prompt-text', `${token} `)
    await expect(prompt.locator('[data-skill-token]')).toHaveAttribute('data-skill-token', token)
    await prompt.locator('.composer-skill').hover()
    await expect(page.locator('.skill-card')).toContainText('Review the current changes.')
    await page.screenshot({ path: join(output, `${threadId}-hover.png`) })
    await prompt.press('End')
    await prompt.press('ArrowLeft')
    await expect.poll(() => prompt.evaluate(element => element.editor.state.selection.from)).toBe(2)
    await prompt.press('Backspace')
    await expect(prompt).toHaveAttribute('data-prompt-text', ' ')
    await expect.poll(() => page.evaluate(async id => (await window.sotto.agents.get()).threadDrafts?.find(draft => draft.threadId === id)?.skills ?? [], `host:${hostId}:${threadId}`)).toEqual([])
    evidence.push({ threadId, token, picked: true, hover: true, atomicDelete: true })
  }
  await page.evaluate(() => window.sotto.agents.command({ type: 'select-thread', threadId: 'grok-previews' }))
  const prompt = paneFor('grok-previews').getByRole('textbox', { name: 'Prompt', exact: true })
  await prompt.fill('$rev')
  await prompt.press('Tab')
  await prompt.press('Shift+Enter')
  await prompt.press('Shift+Enter')
  await expect(prompt).toHaveAttribute('data-prompt-text', '/review \n\n')
  for (const appearance of ['dark', 'light']) for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
    await page.evaluate(mode => window.sotto.updateSettings({ appearance: mode }), appearance)
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/index.html')).setContentSize(size.width, size.height), { width, height })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
    await expect(prompt).toBeVisible()
    const geometry = await prompt.evaluate(element => {
      const box = element.getBoundingClientRect(), style = window.getComputedStyle(element)
      return { left: box.left, right: box.right, bottom: box.bottom, top: box.top, minHeight: style.minHeight, maxHeight: style.maxHeight, resize: style.resize, fontSize: style.fontSize, overflow: style.overflowY }
    })
    expect(geometry.left).toBeGreaterThanOrEqual(0)
    expect(geometry.right).toBeLessThanOrEqual(width)
    expect(geometry.bottom).toBeLessThanOrEqual(height)
    await prompt.locator('.composer-skill').hover()
    await expect(page.locator('.skill-card')).toBeVisible()
    await page.screenshot({ path: join(output, `${appearance}-${width}x${height}.png`) })
    evidence.push({ appearance, width, height, geometry })
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await prompt.locator('.composer-skill').hover()
  await page.screenshot({ path: join(output, 'reduced-motion.png') })
  // Send the first prompt through the field, then queue the next one while the fixture works.
  await prompt.press('Enter')
  await expect(prompt).toHaveAttribute('data-prompt-text', '')
  await prompt.fill('$rev')
  await prompt.press('Tab')
  await prompt.press('Shift+Enter')
  await prompt.press('Shift+Enter')
  await expect(prompt).toHaveAttribute('data-prompt-text', '/review \n\n')
  await prompt.press('Enter')
  await expect(prompt).toHaveAttribute('data-prompt-text', '')
  const toggle = paneFor('grok-previews').locator('.thread-followups__toggle')
  await expect(toggle).toBeVisible()
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  await paneFor('grok-previews').getByRole('button', { name: 'Edit queued message 1' }).click()
  const queued = page.getByRole('textbox', { name: 'Edit queued message', exact: true })
  await expect(queued.locator('[data-skill-token]')).toHaveAttribute('data-skill-token', '/review')
  await queued.locator('.composer-skill').hover()
  await expect(page.locator('.skill-card')).toContainText('Review the current changes.')
  await page.screenshot({ path: join(output, 'queued-editor.png') })
  await queued.fill('/review queue edit\n\n')
  await queued.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Edit queued message' })).not.toBeVisible()
  await expect.poll(() => page.evaluate(async () => (await window.sotto.agents.get()).followups?.some(item => item.text === '/review queue edit\n\n'))).toBe(true)
  evidence.push({ queuedPill: true, queueSavedNativeText: true, reducedMotion: true })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/index.html')).setContentSize(1600, 800))
  const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
  await sidebar.getByRole('button', { name: 'Footer links', exact: true }).click({ modifiers: ['Control'] })
  await sidebar.getByRole('button', { name: 'Weekly note', exact: true }).click({ modifiers: ['Control'] })
  await expect(page.locator('.thread-panes')).toHaveAttribute('data-rows')
  const compact = await page.locator('.thread-pane .prompt-editor').evaluateAll(elements => elements.map(element => {
    const style = window.getComputedStyle(element)
    return { focused: element.closest('.thread-pane').hasAttribute('data-focused'), min: style.minHeight, max: style.maxHeight }
  }))
  expect(compact).toHaveLength(3)
  for (const field of compact) expect([field.min, field.max]).toEqual(field.focused ? ['50px', '120px'] : ['25px', '50px'])
  await page.screenshot({ path: join(output, 'compact-grid.png') })
  await page.evaluate(() => window.sottoE2E.agentEvent({ type: 'question', threadId: 'weekly-note', text: 'Choose a layout.', request: {
    id: 'core-layout', kind: 'question', text: 'Choose a layout.', options: [], questions: [
      { id: 'layout', question: 'Which layout should this change use?', multiSelect: false, allowFreeText: true, options: [{ id: 'quiet', label: 'Quiet' }, { id: 'wide', label: 'Wide' }] },
    ],
  } }))
  await expect(paneFor('weekly-note').locator('.thread-questions')).toBeVisible()
  await expect(paneFor('weekly-note').locator('.prompt-editor')).toHaveCSS('max-height', '32px')
  await page.screenshot({ path: join(output, 'compact-question.png') })
  evidence.push({ compactGrid: compact, compactQuestion: { min: '32px', max: '32px' } })
  expect(errors).toEqual([])
  const version = await app.evaluate(({ app }) => app.getVersion())
  const builtAt = (await stat(join(root, 'out/main/index.js'))).mtime.toISOString()
  await writeFile(join(output, 'proof.json'), JSON.stringify({ surface: 'built Electron on Windows, synthetic providers', version, builtAt, verifiedAt: new Date().toISOString(), evidence, errors }, null, 2))
  log(`Verified built Electron skill composer; captures: ${output}`)
} catch (error) {
  if (mainPage) {
    await mainPage.screenshot({ path: join(output, 'failure.png') })
    await writeFile(join(output, 'failure.html'), await mainPage.content())
  }
  log({ errors })
  throw error
} finally {
  await app.close()
  await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  for (const [file, variant] of [['skill-selected-prototype.html', 'A'], ['skill-symbol-prototype.html', 'D']]) {
    await page.goto(`${pathToFileURL(join(root, 'docs/prototypes', file)).href}?variant=${variant}`)
    await page.screenshot({ path: join(output, `reference-${variant}.png`) })
  }
} finally { await browser.close() }
