import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'

// Real Windows Electron renders of the Threads page transcript with Codex activity records (#48).
// The fixture mounts the real ThreadsView, transcript, composer and tokens; only the agent connection is stubbed.
const shots = resolve(process.cwd(), 'artifacts/thread-activity')
type Scenario = 'settled' | 'live' | 'disconnected' | 'restored'
declare global { interface Window { activityFixture?: { show: (scenario: Scenario) => void } } }

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--config', 'tests/fixtures/threadActivity/vite.config.mjs'], { stdio: 'inherit' })
  await mkdir(shots, { recursive: true })
})

async function launch(options: { width?: number; height?: number; scale?: string } = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const env = Object.fromEntries(Object.entries({
    ...process.env,
    SOTTO_ACTIVITY_FIXTURE: '1',
    SOTTO_ACTIVITY_FIXTURE_WIDTH: String(options.width ?? 1280),
    SOTTO_ACTIVITY_FIXTURE_HEIGHT: String(options.height ?? 860),
    SOTTO_ACTIVITY_FIXTURE_SCALE: options.scale,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const app = await electron.launch({ args: [resolve('tests/fixtures/threadActivity/electronMain.cjs')], env })
  const page = await app.firstWindow()
  await page.waitForLoadState('load')
  await page.evaluate(() => document.fonts.ready)
  await expect(page.getByRole('log', { name: 'Thread transcript' })).toBeVisible()
  return { app, page }
}

const transcript = (page: Page): Locator => page.getByRole('log', { name: 'Thread transcript' })
const theme = (page: Page, mode: 'dark' | 'light', accent = 'teal'): Promise<void> => page.evaluate(([mode, accent]) => {
  document.documentElement.dataset.theme = mode!; document.documentElement.dataset.accent = accent!
}, [mode, accent])
const show = (page: Page, scenario: Scenario): Promise<void> => page.evaluate(scenario => window.activityFixture!.show(scenario), scenario)
const overflow = (page: Page): Promise<number> => transcript(page).evaluate(element => element.scrollWidth - element.clientWidth)
async function scrollTo(page: Page, locator: Locator, offset = 80): Promise<void> {
  await locator.evaluate((element, offset) => {
    const scroller = element.closest('[role="log"]')!
    scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset
  }, offset)
}

test('settled turn folds under its messages, keeps the failure in view and opens by keyboard', async () => {
  const { app, page } = await launch()
  try {
    const log = transcript(page)
    const summary = log.getByRole('button', { name: 'Worked for 2m 04s, Ran 2 commands, 1 reasoning summary' })
    await expect(summary).toHaveAttribute('aria-expanded', 'false')
    const later = log.getByRole('button', { name: 'Ran 2 commands, changed 2 files, 1 agent action' })
    await expect(later).toHaveAttribute('aria-expanded', 'false')
    await expect(log.getByRole('button', { name: 'npm run lint, Exit 1' })).toBeVisible()
    // Messages keep their order and count; activity sits between them.
    await expect(log.locator('.thread-message')).toHaveCount(3)
    await expect(log.locator('.thread-message, .thread-activity')).toHaveCount(5)
    await expect(summary).toHaveCSS('font-size', '14px')
    await expect(log.locator('.thread-message .rich-message').first()).toHaveCSS('font-size', '16px')
    expect(await overflow(page)).toBeLessThanOrEqual(0)

    for (const mode of ['dark', 'light'] as const) {
      await theme(page, mode)
      await scrollTo(page, log.locator('.thread-message').first(), 12)
      await page.screenshot({ path: resolve(shots, `settled-1280-${mode}.png`) })
    }
    await theme(page, 'dark')

    await summary.focus()
    await page.keyboard.press('Enter')
    await expect(summary).toHaveAttribute('aria-expanded', 'true')
    const top = await summary.evaluate(element => element.getBoundingClientRect().top)
    const search = log.getByRole('button', { name: 'rg -n "patchLength" src/main/audio, completed in 0.3s' })
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    await expect(search).toBeFocused()
    await page.keyboard.press('Space')
    await expect(search).toHaveAttribute('aria-expanded', 'true')
    expect(Math.abs(await summary.evaluate(element => element.getBoundingClientRect().top) - top)).toBeLessThanOrEqual(1)
    const details = page.locator(`#${await search.getAttribute('aria-controls')}`.replaceAll(':', '\\:'))
    await expect(details.getByLabel('command code block')).toContainText('rg -n "patchLength" src/main/audio')
    await expect(details.getByLabel('output code block')).toContainText('wavStream.ts:24')
    await expect(details).toContainText('Reported by Codex')
    await details.getByRole('button', { name: 'Copy output code' }).click()
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { activityFixture: { copied: string[] } }).activityFixture.copied.at(-1))).toContain('wavStream.ts:46')
    for (const mode of ['dark', 'light'] as const) {
      await theme(page, mode)
      await page.screenshot({ path: resolve(shots, `expanded-command-1280-${mode}.png`) })
    }
    await theme(page, 'dark')

    await later.click()
    const files = log.getByRole('button', { name: 'Edited src/main/audio/wavStream.ts, and 1 more file, completed' })
    await files.click()
    await expect(files).toHaveText('Changed 2 files')
    await expect(log.getByLabel('diff code block').first()).toContainText('this.patchLength(this.written)')
    await expect(log.locator('.rich-code[data-language="diff"] .hljs-addition').first()).toBeVisible()
    await log.getByRole('button', { name: 'Spawn agent, 1 agent, completed in 31s' }).click()
    await expect(log.getByRole('list', { name: 'Agents' })).toContainText('Agent 1CompletedNo other caller depends on close-time patching.')
    await expect(log.getByRole('list', { name: 'Agents' }).getByRole('button')).toHaveCount(0)
    expect(await overflow(page)).toBeLessThanOrEqual(0)
    for (const mode of ['dark', 'light'] as const) {
      await theme(page, mode)
      await scrollTo(page, later, 60)
      await page.screenshot({ path: resolve(shots, `expanded-diff-agents-1280-${mode}.png`) })
    }
    expect((await app.evaluate(() => (globalThis as unknown as { activityFixture: { navigations: string[] } }).activityFixture.navigations))).toEqual([])
  } finally { await app.close() }
})

test('a running turn shows its rows and one ticking live line; disconnection stops the clocks', async () => {
  const { app, page } = await launch()
  try {
    await show(page, 'live')
    const log = transcript(page)
    const live = log.getByTestId('thread-activity-live')
    // The current action is the running row directly above, so the live line names only the time.
    await expect(live).toHaveText(/^Working for 1m 0\ds$/)
    const first = await live.locator('[data-elapsed]').textContent()
    await expect.poll(() => live.locator('[data-elapsed]').textContent(), { timeout: 3_000 }).not.toBe(first)
    await expect(log.getByRole('button', { name: 'npm test -- --run tests/unit/audio, Running' })).toContainText(/Running \d+s/)
    await expect(live.locator('.thread-activity__pulse')).toHaveCSS('animation-name', 'thread-activity-pulse')
    await expect(log.locator('.thread-activity[data-live]')).toHaveCount(1)
    for (const mode of ['dark', 'light'] as const) {
      await theme(page, mode)
      await transcript(page).evaluate(element => { element.scrollTop = element.scrollHeight })
      await page.screenshot({ path: resolve(shots, `live-1280-${mode}.png`) })
    }
    await log.getByRole('button', { name: 'Spawn agent, 2 agents, Running' }).click()
    await expect(log.getByRole('list', { name: 'Agents' })).toContainText('Agent 1RunningSearching src/rendererAgent 2Starting')
    await page.screenshot({ path: resolve(shots, `live-agents-1280-light.png`) })

    await theme(page, 'dark')
    await show(page, 'disconnected')
    await expect(live).toContainText('Last seen working')
    await expect(live.locator('[data-elapsed]')).toHaveCount(0)
    await expect(live.locator('.thread-activity__pulse')).toHaveCSS('animation-name', 'none')
    // Last-seen rows lose the running accent: they read in the same muted ink as the row icons.
    const lastSeen = log.getByRole('button', { name: 'npm test -- --run tests/unit/audio, Last seen running' })
    expect(await lastSeen.locator('.thread-activity__meta').evaluate(element => getComputedStyle(element).color))
      .toBe(await lastSeen.locator('.thread-activity__icon').evaluate(element => getComputedStyle(element).color))
    await transcript(page).evaluate(element => { element.scrollTop = element.scrollHeight })
    await page.screenshot({ path: resolve(shots, 'disconnected-1280-dark.png') })
  } finally { await app.close() }
})

test('restored history reads as unknown and trimmed, never as success', async () => {
  const { app, page } = await launch()
  try {
    await show(page, 'restored')
    const log = transcript(page)
    const summary = log.getByRole('button', { name: 'Outcome unknown, Ran 2 commands, 1 reasoning summary' })
    await summary.click()
    const read = log.getByRole('button', { name: 'Get-Content -Path src/main/audio/wavStream.ts -TotalCount 80, Outcome unknown' })
    await read.click()
    await expect(page.locator(`#${await read.getAttribute('aria-controls')}`.replaceAll(':', '\\:'))).toContainText('Time not recorded · Some details were not kept.')
    await expect(log.locator('.thread-activity__meta[data-status="completed"]')).toHaveCount(0)
    // The heading states the unknown outcome once; rows keep it in their accessible names only.
    await expect(log.locator('.thread-activity__meta').filter({ hasText: 'Outcome unknown' })).toHaveCount(0)
    for (const mode of ['dark', 'light'] as const) {
      await theme(page, mode)
      await scrollTo(page, summary, 60)
      await page.screenshot({ path: resolve(shots, `restored-1280-${mode}.png`) })
    }
  } finally { await app.close() }
})

test('the shipped minimum width and reduced motion keep rows readable without sideways scroll', async () => {
  const { app, page } = await launch({ width: 820, height: 800 })
  try {
    const log = transcript(page)
    await log.getByRole('button', { name: /^Ran 2 commands, changed 2 files/ }).click()
    await log.getByRole('button', { name: 'npm test -- --run tests/unit/wavStream.test.ts, completed in 4.2s' }).click()
    expect(await overflow(page)).toBeLessThanOrEqual(0)
    const label = log.locator('.thread-activity__row[data-kind="command"] .thread-activity__label').last()
    await expect(label).toHaveCSS('text-overflow', 'ellipsis')
    await expect(log.locator('.thread-activity__toggle').first()).toHaveCSS('min-height', '32px')
    for (const mode of ['dark', 'light'] as const) {
      await theme(page, mode, 'blue')
      await scrollTo(page, log.locator('.thread-activity').nth(1), 40)
      await page.screenshot({ path: resolve(shots, `minimum-820-${mode}.png`) })
    }
    await show(page, 'live')
    await page.evaluate(() => { document.documentElement.dataset.reducedMotion = 'on' })
    await expect(log.getByTestId('thread-activity-live').locator('.thread-activity__pulse')).toHaveCSS('animation-name', 'none')
    await transcript(page).evaluate(element => { element.scrollTop = element.scrollHeight })
    expect(await overflow(page)).toBeLessThanOrEqual(0)
    await page.screenshot({ path: resolve(shots, 'live-820-reduced-motion-light.png') })
  } finally { await app.close() }
})
