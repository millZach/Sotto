import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { AgentCommand, AgentRequest, AgentState } from '../../src/shared/agents'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { textContrast } from './support/textContrast'
import { evidenceDirectory } from '../fixtures/evidence'

// A prototype waiting for review (ADR-0108, variant A): a thread whose finished reply names a page in its folder reads
// Prototype ready in the sidebar and offers the page above the composer until it is opened. A question about a prototype
// that names no page and only takes listed choices shows at once, marked link missing. The app is real end to end; only
// the provider's effects come from the E2E host, and only the operating system's opening of the file is recorded.
const evidence = evidenceDirectory('artifacts/prototype-ready')

const choiceOnly: AgentRequest = {
  id: 'chart-choice', kind: 'question', text: 'Which usage chart prototype should I build?', options: [], questions: [{
    id: 'chart', header: 'Chart', question: 'Which usage chart prototype should I build?', multiSelect: false, allowFreeText: false,
    options: [
      { id: 'a', label: 'Stacked bars (Recommended)', description: 'One bar a day, split by model.' },
      { id: 'b', label: 'Stepped area', description: 'Shows each day’s limit as a line above the area.' },
    ],
  }],
}

const command = (page: Page, input: AgentCommand): Promise<AgentState> => page.evaluate(async input => window.sotto!.agents!.command(input) as unknown as Promise<AgentState>, input)

async function resize(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [width, height]) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => page.evaluate(([width, height]) => window.innerWidth === width && Math.abs(window.innerHeight - height) <= 2, [width, height] as const)).toBe(true)
}

const opened = (app: ElectronApplication): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { pagesOpened: string[] }).pagesOpened)

let launched: LaunchedSotto | undefined
test.afterEach(async () => { if (launched) await closeSotto(launched); launched = undefined })

test('a finished reply naming a page marks its thread Prototype ready until the page is opened, and a prototype question without a page says its link is missing', async () => {
  test.setTimeout(180_000)
  await mkdir(evidence, { recursive: true })
  launched = await launchSotto()
  const { page, app, userData } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ shell }) => {
    const state = globalThis as unknown as { pagesOpened: string[] }
    state.pagesOpened = []
    shell.openPath = async path => { state.pagesOpened.push(path); return '' }
    shell.openExternal = async url => { state.pagesOpened.push(url) }
  })
  await page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, defaultModelId: 'claude:test' } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  const folder = join(userData, 'settings-project')
  await mkdir(join(folder, 'docs', 'prototypes'), { recursive: true })
  await writeFile(join(folder, 'docs', 'prototypes', 'settings-restyle-prototype.html'), '<!doctype html><h1>Settings</h1>')
  let state = await command(page, { type: 'create-project', title: 'Settings', path: folder, useExisting: true })
  expect(state.error).toBeNull()
  const project = state.host.projects.find(item => item.title === 'Settings')!
  state = await command(page, { type: 'create-thread', title: 'Settings restyle', projectId: project.id, modelId: 'claude:test' })
  expect(state.error).toBeNull()
  const threadId = state.host.threads.find(item => item.title === 'Settings restyle')!.id
  // The provider's session starts with the first send (ADR-0057).
  state = await command(page, { type: 'manual-send', threadId, text: 'Restyle the Settings page as one column. Make a prototype first.' })
  expect(state.error).toBeNull()
  await page.reload()
  await openThreads(page)
  await command(page, { type: 'select-thread', threadId })
  await resize(app, page, 1280, 800)
  await page.evaluate(async threadId => window.sottoE2E!.agentEvent!({ type: 'ready', threadId, status: 'idle',
    text: 'The prototype is at docs/prototypes/settings-restyle-prototype.html, with three variants.' }), threadId)

  const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
  const strip = page.getByRole('region', { name: 'Prototype ready for review' })
  const row = strip.getByRole('link', { name: 'Open the prototype, settings-restyle-prototype.html', exact: true })
  await expect(row).toBeVisible()
  await expect(sidebar.getByText(/, Prototype ready$/u)).toBeVisible()

  for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
    await resize(app, page, width, height)
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      await expect(strip).toBeInViewport()
      expect(await strip.evaluate(element => element.scrollWidth - element.clientWidth), `${width} ${appearance}`).toBeLessThanOrEqual(1)
      const [box, frame] = await Promise.all([row.boundingBox(), strip.boundingBox()])
      expect(box!.x + box!.width, `${width} ${appearance} row inside the strip`).toBeLessThanOrEqual(frame!.x + frame!.width + 1)
      for (const { text, ratio } of await textContrast(strip, 'strong, small, .prototype-ready__title')) expect(ratio, `${text} at ${width} ${appearance}`).toBeGreaterThanOrEqual(4.5)
      await page.mouse.move(1, 1)
      await page.screenshot({ path: join(evidence, `prototype-ready-${width}x${height}-${appearance}.png`), animations: 'disabled', caret: 'hide' })
    }
  }

  // Enter on the row opens the file in the system browser, as Web links in threads says, and opening it clears the mark.
  await resize(app, page, 1280, 800)
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
  await row.focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => opened(app)).toEqual([expect.stringMatching(/settings-restyle-prototype\.html$/u)])
  await expect(strip).toHaveCount(0)
  await expect(sidebar.getByText(/, Prototype ready$/u)).toHaveCount(0)

  // A question about a prototype that names no page, and only takes listed choices, cannot be sent back for one: it shows,
  // marked link missing, once Sotto has looked for its pages. The reply before it names no page either, since a question's
  // pages are also read from the reply before it (ADR-0085).
  await page.evaluate(async threadId => window.sottoE2E!.agentEvent!({ type: 'ready', threadId, status: 'running', text: 'Next, the usage chart.' }), threadId)
  await page.evaluate(async ([request, threadId]) => window.sottoE2E!.agentEvent!({ type: 'question', threadId, text: request.text, request, status: 'running' }), [choiceOnly, threadId] as const)
  const card = page.locator('.thread-questions .agent-request')
  await expect(card.getByText('No working link. This question is about a prototype, and no page it names opens.')).toBeVisible({ timeout: 15_000 })
  await expect(card.getByRole('link', { name: /Open the prototype/u })).toHaveCount(0)
  for (const appearance of ['dark', 'light'] as const) {
    await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
    for (const { text, ratio } of await textContrast(card, '.agent-request__no-link span')) expect(ratio, `${text} ${appearance}`).toBeGreaterThanOrEqual(4.5)
    await page.mouse.move(1, 1)
    await page.screenshot({ path: join(evidence, `link-missing-1280x800-${appearance}.png`), animations: 'disabled', caret: 'hide' })
  }
  expect(errors).toEqual([])
})
