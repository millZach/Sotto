import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { AgentRequest } from '../../src/shared/agents'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { textContrast } from './support/textContrast'
import { evidenceDirectory } from '../fixtures/evidence'

// The question card docks over the end of the agent's message, so the links in that message come with it as rows. The
// loopback review page is one of the question's pages (ADR-0085), so its row opens the page through main rather than as a
// link. The app is real end to end; only the provider's effects come from the E2E host, and only the OS browser is recorded.
const evidence = evidenceDirectory('artifacts/question-message-links')
const review = 'http://localhost:8075/'
const tag = 'https://github.com/millZach/Sotto/tree/prototype/cloud-iphone-settings-layout'

const message = [
  `**Review page:** ${review} (it’s open in your browser)`,
  'I found why the page looks different. Every other Settings page is a flat list of rows split by thin lines.',
  `The three layouts are also on [the prototype tag](${tag}).`,
].join('\n\n')

const question: AgentRequest = {
  id: 'layout-choice', kind: 'question', text: 'Which layout should Settings > Cloud iPhone use?', options: [], questions: [{
    id: 'layout', header: 'Layout', question: 'Which layout should Settings > Cloud iPhone use?', multiSelect: false, allowFreeText: true,
    options: [
      { id: 'a', label: 'A · Groups (Recommended)', description: 'Three small headings with icons, as Git groups its settings.' },
      { id: 'b', label: 'B · One list', description: 'No subheadings, one run of rows like Output.' },
      { id: 'c', label: 'C · Usage first', description: 'This month’s minutes lead with a wide meter.' },
    ],
  }],
}

async function resize(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [width, height]) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(width, height)
  }, [width, height] as const)
  // The window's own 820 × 560 minimum can round the content height up by a pixel or two.
  await expect.poll(() => page.evaluate(([width, height]) => window.innerWidth === width && Math.abs(window.innerHeight - height) <= 2, [width, height] as const)).toBe(true)
}

const opened = (app: ElectronApplication): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { questionLinksOpened: string[] }).questionLinksOpened)

let launched: LaunchedSotto | undefined
test.afterEach(async () => { if (launched) await closeSotto(launched); launched = undefined })

test('a question brings the links from the agent’s message before it, as rows that open the page and pick nothing', async () => {
  test.setTimeout(180_000)
  await mkdir(evidence, { recursive: true })
  launched = await launchSotto()
  const { page, app } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ shell }) => {
    const state = globalThis as unknown as { questionLinksOpened: string[] }
    state.questionLinksOpened = []
    shell.openExternal = async url => { state.questionLinksOpened.push(url) }
  })
  await page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  await page.reload()
  await openThreads(page)
  await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Workshop', exact: true }).click()
  await resize(app, page, 1280, 800)
  const event = (type: 'manual' | 'ready', text: string) => page.evaluate(async ([type, text]) => window.sottoE2E!.agentEvent!({ type, threadId: 'workshop', text, status: 'running' }), [type, text] as const)
  await event('manual', 'The cloud iPhone page in settings looks different. Can you make sure the layout matches?')
  await event('ready', message)
  await page.evaluate(async request => window.sottoE2E!.agentEvent!({ type: 'question', threadId: 'workshop', text: request.text, request, status: 'running' }), question)

  const card = page.locator('.thread-questions .agent-request')
  const links = card.getByRole('group', { name: 'Pages and links for this question' })
  await expect(links.getByRole('link')).toHaveCount(2)
  await expect(links.getByRole('link', { name: 'Open the prototype, localhost:8075', exact: true })).toBeVisible()
  await expect(links.getByRole('link', { name: 'Open the link, github.com/millZach/Sotto/tree/prototype/cloud-iphone-settings-layout', exact: true })).toBeVisible()

  for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
    await resize(app, page, width, height)
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      await links.scrollIntoViewIfNeeded()
      await expect(links).toBeInViewport()
      expect(await card.evaluate(element => element.scrollWidth - element.clientWidth), `${width} ${appearance}`).toBeLessThanOrEqual(1)
      for (const row of await links.getByRole('link').all()) {
        const [box, frame] = await Promise.all([row.boundingBox(), card.boundingBox()])
        expect(box!.x + box!.width, `${width} ${appearance} row inside the card`).toBeLessThanOrEqual(frame!.x + frame!.width + 1)
      }
      for (const { text, ratio } of await textContrast(links, 'strong, small')) expect(ratio, `${text} at ${width} ${appearance}`).toBeGreaterThanOrEqual(4.5)
      await page.mouse.move(1, 1)
      await page.screenshot({ path: join(evidence, `question-links-${width}x${height}-${appearance}.png`), animations: 'disabled', caret: 'hide' })
    }
  }

  // The keyboard path follows the eye: the collapse toggle, the question's words, each link, then the choices.
  await resize(app, page, 1280, 800)
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
  await card.getByRole('button', { name: 'Collapse question' }).focus()
  await page.keyboard.press('Tab')
  await expect(links.getByRole('link').nth(0)).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(links.getByRole('link').nth(1)).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(card.getByRole('radio').first()).toBeFocused()
  // Enter on a row opens the page in the system browser and picks no choice.
  await links.getByRole('link').nth(0).focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => opened(app)).toEqual([review])
  await expect(card.getByRole('radio', { checked: true })).toHaveCount(0)

  // While the choices can't be used, a row still opens its page.
  await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'disconnect', threadId: 'workshop', text: '' }))
  await expect(card.getByRole('radio').first()).toBeDisabled()
  await links.getByRole('link').nth(1).click()
  await expect.poll(() => opened(app)).toEqual([review, tag])
  await page.screenshot({ path: join(evidence, 'question-links-1280x800-dark-disconnected.png'), animations: 'disabled', caret: 'hide' })
  expect(errors).toEqual([])
})
