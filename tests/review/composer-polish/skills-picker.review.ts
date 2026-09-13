import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test'
import type { LaunchedSotto } from '../../e2e/support/sottoLaunch'
import { evidence, focusedLabel, paneMetrics, shot, size, type PaneMetrics } from './support'

// The critic's component fixture (copied unmodified from the visual review): the real ThreadWorkspace with a synthetic
// Codex-capable state (steer, skills, queued follow-ups) the E2E provider cannot produce. No native calls.

type Scenario = 'compose' | 'catalog-error' | 'catalog-loading' | 'catalog-empty' | 'request-failed' | 'idle-queue'
declare global { interface Window { phaseTwoFixture?: { show: (scenario: Scenario) => void } } }

test.beforeAll(() => {
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--config', 'tests/fixtures/phaseTwoReview/vite.config.mjs'], { stdio: 'inherit' })
})

async function launch(width = 1280, height = 800): Promise<LaunchedSotto> {
  const env = Object.fromEntries(Object.entries({ ...process.env, SOTTO_PHASE_TWO_FIXTURE: '1', SOTTO_PHASE_TWO_FIXTURE_WIDTH: String(width), SOTTO_PHASE_TWO_FIXTURE_HEIGHT: String(height) })
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const app = await electron.launch({ args: [resolve('tests/fixtures/phaseTwoReview/electronMain.cjs')], env })
  const page = await app.firstWindow()
  await page.waitForLoadState('load')
  await page.evaluate(() => document.fonts.ready)
  await expect(page.getByRole('log', { name: 'Thread transcript' }).first()).toBeVisible()
  return { app, page } as unknown as LaunchedSotto
}

const theme = (page: Page, mode: 'dark' | 'light', accent = 'teal'): Promise<void> => page.evaluate(([mode, accent]) => {
  document.documentElement.dataset.theme = mode!; document.documentElement.dataset.accent = accent!
}, [mode, accent])
const show = (page: Page, scenario: Scenario): Promise<void> => page.evaluate(scenario => window.phaseTwoFixture!.show(scenario), scenario)

/** The picker overlays the transcript: it sits above the card, inside the window, and the prompt and its actions stay put. */
async function expectOverlay(page: Page, pane: Locator, scope: string, before: PaneMetrics): Promise<Record<string, unknown>> {
  const metrics = await paneMetrics(page, scope)
  const facts = await pane.evaluate(element => {
    const picker = element.querySelector('.skill-picker')!.getBoundingClientRect()
    const card = element.querySelector('.thread-prompt')!.getBoundingClientRect()
    const list = element.querySelector('.skill-picker [role="listbox"]')
    const active = list?.querySelector('[aria-selected="true"]')
    return {
      pickerTop: Math.round(picker.top), pickerBottom: Math.round(picker.bottom), cardTop: Math.round(card.top), paneTop: Math.round(element.getBoundingClientRect().top),
      visibleOptions: [...(list?.querySelectorAll('[role="option"]') ?? [])].filter(option => { const r = option.getBoundingClientRect(); const l = list!.getBoundingClientRect(); return r.bottom <= l.bottom + 1 && r.top >= l.top - 1 }).length,
      activeInView: active ? (() => { const r = active.getBoundingClientRect(); const l = list!.getBoundingClientRect(); return r.top >= l.top - 1 && r.bottom <= l.bottom + 1 })() : null,
    }
  })
  expect(metrics.cardFullyVisible, JSON.stringify(metrics)).toBe(true)
  expect(metrics.outsideControls, JSON.stringify(metrics)).toEqual([])
  expect(metrics.card, 'the card does not move when the picker opens').toEqual(before.card)
  expect(facts.pickerBottom).toBeLessThanOrEqual(facts.cardTop)
  expect(facts.pickerTop).toBeGreaterThanOrEqual(facts.paneTop)
  expect(facts.visibleOptions).toBeGreaterThanOrEqual(2)
  if (facts.activeInView !== null) expect(facts.activeInView).toBe(true)
  for (const name of [/Queue prompt|Send prompt/u, /Steer now/u]) {
    const button = pane.getByRole('button', { name })
    if (await button.count()) await expect(button.first()).toBeInViewport({ ratio: 1 })
  }
  return { metrics, facts }
}

test('skill picker overlays the transcript with a queue while Codex runs: 1280, 820x560, keyboard, catalog states', async () => {
  const launched = await launch()
  const { page } = launched
  const record: Record<string, unknown> = {}
  const scope = 'section.thread-pane[data-thread-id="wav-preview"]'
  try {
    const pane = page.locator(scope)
    const prompt = pane.getByRole('textbox', { name: 'Prompt', exact: true })
    const queue = pane.getByRole('region', { name: 'Queued messages' })
    await expect(queue).toBeVisible()

    await prompt.click()
    record.closed1280 = await paneMetrics(page, scope)
    await prompt.pressSequentially('Also run $')
    await expect(pane.getByRole('listbox', { name: 'Skills' })).toBeVisible()
    record.dollar1280 = await expectOverlay(page, pane, scope, record.closed1280 as PaneMetrics)
    await shot(page, 'skills-1-picker-queue-1280-dark')
    await theme(page, 'light', 'blue')
    await shot(page, 'skills-1-picker-queue-1280-light-blue')
    await theme(page, 'dark')
    await page.keyboard.press('Escape')
    await expect(prompt).toHaveValue('Also run $')
    await prompt.fill('')

    // The shipped minimum: the queue rests as one line and the picker still overlays, arrow keys keep the active option in view.
    await size(launched, 820, 560)
    await prompt.click()
    await prompt.pressSequentially('Then ')
    record.closed820 = await paneMetrics(page, scope)
    await prompt.pressSequentially('$')
    await expect(pane.getByRole('listbox', { name: 'Skills' })).toBeVisible()
    record.dollar820 = await expectOverlay(page, pane, scope, record.closed820 as PaneMetrics)
    await shot(page, 'skills-2-picker-queue-820x560-dark')
    for (let step = 0; step < 6; step++) await page.keyboard.press('ArrowDown')
    record.arrowed820 = await expectOverlay(page, pane, scope, record.closed820 as PaneMetrics)
    await shot(page, 'skills-3-picker-arrowed-820x560-dark')
    await theme(page, 'light')
    await shot(page, 'skills-3-picker-arrowed-820x560-light')
    await theme(page, 'dark')
    await page.keyboard.press('Enter')
    await expect(pane.getByRole('listbox', { name: 'Skills' })).toHaveCount(0)
    await prompt.pressSequentially('and summarise the result.')
    record.inserted820 = { value: await prompt.inputValue(), metrics: await paneMetrics(page, scope) }
    await shot(page, 'skills-4-inserted-820x560-dark')

    // Steer now by pointer: the skill steers and focus returns to the prompt (F19).
    const steer = pane.getByRole('button', { name: 'Steer now', exact: true })
    await expect(steer).toBeInViewport({ ratio: 1 })
    await steer.click()
    await expect(prompt).toHaveValue('')
    record.afterSteer = { commands: await page.evaluate(() => window.phaseTwoCommands?.filter(item => item.type === 'steer').length), focus: await focusedLabel(page) }
    await expect(prompt).toBeFocused()

    // Queue a 4th with Enter: the collapsed queue names the message just added (F20).
    const count = async () => Number((await queue.locator('.thread-followups__count').innerText()).trim())
    const before = await count()
    await prompt.pressSequentially('$changelog note the fix')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Enter')
    await expect.poll(count).toBe(before + 1)
    await expect(queue.getByRole('button', { name: /Queued/u })).toContainText('Added')
    await expect(queue.getByRole('button', { name: /Queued/u })).toContainText('note the fix')
    record.afterQueueEnter = { head: await queue.locator('.thread-followups__head').innerText(), focus: await focusedLabel(page), metrics: await paneMetrics(page, scope) }
    await shot(page, 'skills-5-after-steer-and-queue-820x560-dark')
    // Opened, the new row is the one in view.
    await queue.getByRole('button', { name: /Queued/u }).click()
    await expect(queue.locator('.thread-followup').last()).toBeInViewport()
    await queue.getByRole('button', { name: /Queued/u }).click()

    for (const scenario of ['catalog-error', 'catalog-loading', 'catalog-empty', 'request-failed'] as const) {
      await show(page, scenario)
      await prompt.fill('')
      await prompt.click()
      const closed = await paneMetrics(page, scope)
      await prompt.pressSequentially('$')
      await expect(pane.locator('.skill-picker')).toBeVisible()
      await page.waitForTimeout(150)
      const metrics = await paneMetrics(page, scope)
      expect(metrics.cardFullyVisible).toBe(true)
      expect(metrics.card).toEqual(closed.card)
      record[scenario] = metrics
      await shot(page, `skills-6-${scenario}-820x560-dark`)
      await page.keyboard.press('Escape')
    }
    await show(page, 'compose')
  } finally {
    await evidence('skills-picker', record)
    await launched.app.close()
  }
})

test('split: the picker overlays one pane at 1600x900, 1280x800 and 1280x560', async () => {
  const launched = await launch(1600, 900)
  const { page } = launched
  const record: Record<string, unknown> = {}
  const scope = 'section.thread-pane[data-thread-id="wav-preview"]'
  try {
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await sidebar.getByRole('button', { name: 'Footer links', exact: true }).hover()
    await sidebar.getByRole('button', { name: 'Open Footer links beside', exact: true }).click()
    const left = page.locator(scope)
    const right = page.locator('section.thread-pane[data-thread-id="footer-links"]')
    await expect(right).toHaveAttribute('data-focused')
    await right.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Right pane draft.')
    const prompt = left.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.click()
    await prompt.pressSequentially('Left uses ')
    const sizes: [number, number][] = [[1600, 900], [1280, 800], [1280, 560]]
    for (const [width, height] of sizes) {
      await size(launched, width, height)
      await prompt.click()
      const closed = await paneMetrics(page, scope)
      await prompt.pressSequentially('$')
      await expect(left.getByRole('listbox', { name: 'Skills' })).toBeVisible()
      record[`split${width}x${height}`] = { left: await expectOverlay(page, left, scope, closed), right: await paneMetrics(page, 'section.thread-pane[data-thread-id="footer-links"]') }
      await shot(page, `skills-7-split-picker-${width}x${height}-dark`)
      await page.keyboard.press('Escape')
      await page.keyboard.press('Backspace')
    }
    await expect(right.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Right pane draft.')
  } finally {
    await evidence('skills-picker-split', record)
    await launched.app.close()
  }
})
