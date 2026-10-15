import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { AgentCommand, AgentRequest, AgentState } from '../../src/shared/agents'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { textContrast } from './support/textContrast'
import { evidenceDirectory } from '../fixtures/evidence'

// A question's pages (ADR-0084): the agent names its prototype by a path in the thread's folder, as agents mostly do, and
// the question card offers it as a row that opens the file in this computer's browser. The app is real end to end; only
// the provider's effects come from the E2E host, and only the operating system's opening of the file is recorded.
const evidence = evidenceDirectory('artifacts/question-prototype-pages')

const question: AgentRequest = {
  id: 'greeting-choice', kind: 'question', text: 'Which greeting should a new thread show?', options: [], questions: [{
    id: 'greeting', header: 'Greeting', question: 'Which greeting should a new thread show?', multiSelect: false, allowFreeText: true,
    options: [
      { id: 'a', label: 'A · Quiet line (Recommended)', description: 'One sentence under the composer.' },
      { id: 'b', label: 'B · Card with suggestions', description: 'Three starter prompts in a card.' },
      { id: 'c', label: 'C · Nothing', description: 'Keep today’s empty thread.' },
    ],
  }],
}

const command = (page: Page, input: AgentCommand): Promise<AgentState> => page.evaluate(async input => window.sotto!.agents!.command(input) as Promise<AgentState>, input)

async function resize(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [width, height]) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => page.evaluate(([width, height]) => window.innerWidth === width && Math.abs(window.innerHeight - height) <= 2, [width, height] as const)).toBe(true)
}

const opened = (app: ElectronApplication): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { pagesOpened: string[] }).pagesOpened)

let launched: LaunchedSotto | undefined
test.afterEach(async () => { if (launched) await closeSotto(launched); launched = undefined })

test('a prototype named by its path in the thread’s folder opens from the question, and says so when it is gone', async () => {
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
  const folder = join(userData, 'greeting-project')
  const file = join(folder, 'docs', 'prototypes', 'greeting-prototype.html')
  await mkdir(join(folder, 'docs', 'prototypes'), { recursive: true })
  await writeFile(file, '<!doctype html><h1>Greeting</h1>')
  let state = await command(page, { type: 'create-project', title: 'Greeting', path: folder, useExisting: true })
  expect(state.error).toBeNull()
  const project = state.host.projects.find(item => item.title === 'Greeting')!
  state = await command(page, { type: 'create-thread', title: 'Greeting choice', projectId: project.id, modelId: 'claude:test' })
  expect(state.error).toBeNull()
  const threadId = state.host.threads.find(item => item.title === 'Greeting choice')!.id
  // The provider's session starts with the first send (ADR-0057).
  state = await command(page, { type: 'manual-send', threadId, text: 'Make three greetings for a new thread and let me pick one.' })
  expect(state.error).toBeNull()
  await page.reload()
  await openThreads(page)
  // The first send names the thread after its first message, so it is opened by its ID.
  await command(page, { type: 'select-thread', threadId })
  await resize(app, page, 1280, 800)
  await page.evaluate(async threadId => window.sottoE2E!.agentEvent!({ type: 'ready', threadId, status: 'running',
    text: 'I made three greetings. The page is at docs/prototypes/greeting-prototype.html, with A, B and C side by side.' }), threadId)
  await page.evaluate(async ([request, threadId]) => window.sottoE2E!.agentEvent!({ type: 'question', threadId, text: request.text, request, status: 'running' }), [question, threadId] as const)

  const card = page.locator('.thread-questions .agent-request')
  const rows = card.getByRole('group', { name: 'Pages and links for this question' })
  const row = rows.getByRole('link', { name: 'Open the prototype, greeting-prototype.html', exact: true })
  await expect(row).toBeVisible()
  await expect(rows.getByRole('link')).toHaveCount(1)

  for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
    await resize(app, page, width, height)
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      await rows.scrollIntoViewIfNeeded()
      await expect(rows).toBeInViewport()
      expect(await card.evaluate(element => element.scrollWidth - element.clientWidth), `${width} ${appearance}`).toBeLessThanOrEqual(1)
      const [box, frame] = await Promise.all([row.boundingBox(), card.boundingBox()])
      expect(box!.x + box!.width, `${width} ${appearance} row inside the card`).toBeLessThanOrEqual(frame!.x + frame!.width + 1)
      for (const { text, ratio } of await textContrast(rows, 'strong, small')) expect(ratio, `${text} at ${width} ${appearance}`).toBeGreaterThanOrEqual(4.5)
      await page.mouse.move(1, 1)
      await page.screenshot({ path: join(evidence, `question-pages-${width}x${height}-${appearance}.png`), animations: 'disabled', caret: 'hide' })
    }
  }

  // The keyboard path: the collapse toggle, the page's row, then the choices. Enter opens the file and picks nothing.
  await resize(app, page, 1280, 800)
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
  await card.getByRole('button', { name: 'Collapse question' }).focus()
  await page.keyboard.press('Tab')
  await expect(row).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(card.getByRole('radio').first()).toBeFocused()
  await row.focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => opened(app)).toEqual([expect.stringMatching(/greeting-prototype\.html$/u)])
  await expect(card.getByRole('radio', { checked: true })).toHaveCount(0)

  // While the choices can't be used, the row still opens its page.
  await page.evaluate(async threadId => window.sottoE2E!.agentEvent!({ type: 'disconnect', threadId, text: '' }), threadId)
  await expect(card.getByRole('radio').first()).toBeDisabled()
  await row.click()
  await expect.poll(async () => (await opened(app)).length).toBe(2)

  // A file moved after the question was asked: the row says so, and nothing else changes.
  await rm(file)
  await row.click()
  await expect(card.getByText('That page is no longer there. The file was moved or deleted, or the question was answered. Nothing else changed.')).toBeVisible()
  expect(await opened(app)).toHaveLength(2)
  await page.screenshot({ path: join(evidence, 'question-pages-1280x800-dark-gone.png'), animations: 'disabled', caret: 'hide' })
  expect(errors).toEqual([])
})
