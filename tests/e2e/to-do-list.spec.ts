/**
 * The to-do list's corner scroll (ADR-0188), in the built app with the `to-do-list` Owl feature on. A list saved on this
 * computer holds a thread's to-do with steps and a link, and enough others to overflow the smallest window. The icon stands
 * on every page, a press unrolls the list, the new count goes quiet, a check-off waits five seconds with Undo, and the
 * corner gives a pane's header no less than it needs at any size. Stable shows none of it.
 *
 *   npm run build && npx playwright test tests/e2e/to-do-list.spec.ts
 *
 * With `SOTTO_E2E_EVIDENCE=publish` the screenshots go to artifacts/to-do-list/ for the verification note.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { closeSotto, launchSotto, openPage, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { elementContrast } from './support/elementContrast'
import { resizeContentWindow } from './support/sottoWindow'

const shots = evidenceDirectory('artifacts/to-do-list')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const at = '2026-11-03T12:00:00.000Z'
const saved = {
  items: [
    { id: 'hand-test', title: 'Hand test links on a paired host', why: 'Links in a host\'s thread now open in the system browser.', link: { label: 'Open #2127', url: 'https://github.com/millZach/Sotto/pull/2127' },
      steps: ['Open a thread on forge', 'Press a link in a reply', 'See it open in your browser'], by: 'watcher', waits: false, seen: false, addedAt: at },
    { id: 'soundtrack', title: 'Listen to the new soundtrack', by: 'user', waits: false, seen: true, addedAt: at },
    ...Array.from({ length: 12 }, (_, index) => ({ id: `extra-${index}`, title: `Walk through part ${index + 1} on the laptop`, why: 'So it is proved by hand before it goes out.', by: 'watcher', waits: false, seen: true, addedAt: at })),
  ],
}

async function launch(enabled: boolean): Promise<LaunchedSotto & { readonly folder: string }> {
  const folder = await mkdtemp(join(tmpdir(), 'sotto-to-do-'))
  await writeFile(join(folder, 'to-dos.json'), JSON.stringify(saved))
  const previous = process.env['SOTTO_OWL_FEATURES']
  process.env['SOTTO_OWL_FEATURES'] = `to-do-list=${enabled ? 1 : 0}`
  try { return { ...await launchSotto('phase3-workspace', folder), folder } } finally {
    if (previous === undefined) delete process.env['SOTTO_OWL_FEATURES']; else process.env['SOTTO_OWL_FEATURES'] = previous
  }
}
async function close(launched: LaunchedSotto & { readonly folder: string }): Promise<void> {
  await closeSotto(launched)
  await rm(launched.folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
async function ready(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
    await window.sotto!.agents!.command({ type: 'connect' })
    const state = await window.sotto!.agents!.get()
    const thread = state.host.threads[0]
    if (thread) await window.sotto!.agents!.command({ type: 'select-thread', threadId: thread.id })
  })
  await page.reload()
  await openThreads(page)
  await page.evaluate(() => document.fonts.ready)
}
const icon = (page: Page) => page.locator('.to-do__icon')
const scroll = (page: Page) => page.locator('.to-do-scroll')
async function shot(page: Page, name: string): Promise<void> {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
}
async function settled(page: Page): Promise<void> {
  await page.waitForTimeout(800)
}

test('the icon stands on every page, and the list unrolls, quiets and rolls up', async () => {
  test.setTimeout(120_000)
  const launched = await launch(true)
  const { page } = launched
  try {
    await ready(page)
    await expect(icon(page)).toHaveAccessibleName(/14 to do, 1 new\. Unroll/u)
    await expect(page.locator('.to-do__badge')).toHaveText('1')
    await expect(page.locator('.to-do__badge')).toHaveAttribute('data-loud')
    await shot(page, 'badge-new-dark')
    expect(await elementContrast(page.locator('.to-do__badge')), 'The new count in dark').toBeGreaterThanOrEqual(4.5)
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'light' }) })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    expect(await elementContrast(page.locator('.to-do__badge')), 'The new count in light').toBeGreaterThanOrEqual(4.5)
    await shot(page, 'badge-new-light')
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    for (const [width, height] of SIZES) {
      await resizeContentWindow(launched, width, height)
      await icon(page).click()
      await settled(page)
      const box = await scroll(page).boundingBox()
      expect(box, 'The list stands in the window').not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      expect(box!.y + box!.height).toBeLessThanOrEqual(height)
      // A long list scrolls inside the sheet, with its box and Roll up still in view.
      await expect(page.getByRole('button', { name: 'Roll up', exact: true })).toBeInViewport()
      await expect(page.getByRole('textbox', { name: 'Add a to-do of your own' })).toBeInViewport()
      const overflow = await page.locator('.to-do-scroll__body').evaluate(body => body.scrollHeight > body.clientHeight)
      if (height <= 800) expect(overflow).toBe(true)
      await shot(page, `open-${width}x${height}-dark`)
      await icon(page).click()
      await expect(icon(page)).toHaveAttribute('aria-expanded', 'false')
      await expect(scroll(page)).toHaveCount(0)
    }
    // The first opening told this computer, so the count is quiet now and stays so.
    await expect(page.locator('.to-do__badge')).toHaveText('14')
    await expect(page.locator('.to-do__badge')).not.toHaveAttribute('data-loud')

    // Steps fold, Escape rolls up, and focus goes back to the icon.
    await icon(page).click()
    await page.getByRole('button', { name: 'Show 3 steps' }).click()
    await expect(page.getByText('Press a link in a reply')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(icon(page)).toBeFocused()
    await expect(scroll(page)).toHaveCount(0)

    // Both sides, with the steps open and a thread's words in place: every line is readable on what it sits on.
    await icon(page).click()
    await page.getByRole('button', { name: 'Show 3 steps' }).click()
    await settled(page)
    for (const appearance of ['light', 'dark'] as const) {
      await page.evaluate(async value => { await window.sotto!.updateSettings({ appearance: value }) }, appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      await settled(page)
      for (const part of ['.to-do-scroll__head h2', '.to-do-scroll__head span', '.to-do-row__title', '.to-do-row__why', '.to-do-row__meta span', '.to-do-row__link', '.to-do-row__steps > li', '.to-do-scroll__rollup', '.to-do__badge']) {
        expect(await elementContrast(page.locator(part).first()), `${part} in ${appearance}`).toBeGreaterThanOrEqual(4.5)
      }
      await shot(page, `open-steps-${appearance}`)
    }
    await page.keyboard.press('Escape')
    await expect(scroll(page)).toHaveCount(0)

    // A press outside rolls it up.
    await icon(page).click()
    await settled(page)
    await page.mouse.click(120, 400)
    await expect(icon(page)).toHaveAttribute('aria-expanded', 'false')

    // A check-off waits with Undo, through rolling up. Undo takes it back; left alone it goes.
    await icon(page).click()
    await page.getByRole('checkbox', { name: 'Check off: Listen to the new soundtrack' }).click()
    await expect(page.getByRole('button', { name: 'Undo checking off: Listen to the new soundtrack' })).toBeFocused()
    await shot(page, 'undo-dark')
    await page.getByRole('button', { name: 'Undo checking off: Listen to the new soundtrack' }).click()
    await page.getByRole('checkbox', { name: 'Check off: Listen to the new soundtrack' }).click()
    await page.keyboard.press('Escape')
    await expect(page.locator('.to-do__badge')).toHaveText('13')
    await expect(scroll(page)).toHaveCount(0)
    await page.waitForTimeout(5_300)
    await icon(page).click()
    await expect(page.getByText('Listen to the new soundtrack')).toHaveCount(0)

    // The user's own goes on the list.
    await page.getByRole('textbox', { name: 'Add a to-do of your own' }).fill('Call the plant')
    await page.keyboard.press('Enter')
    await expect(page.getByText('Call the plant')).toBeVisible()
    await page.keyboard.press('Escape')

    // It stands on the other pages too.
    for (const name of ['Settings', 'Help'] as const) {
      await openPage(page, name)
      await expect(icon(page)).toBeVisible()
      await icon(page).click()
      await settled(page)
      await shot(page, `open-${name.toLowerCase()}-dark`)
      await expect(scroll(page)).toBeVisible()
      await page.keyboard.press('Escape')
    }
  } finally { await close(launched) }
})

test('reduced motion fades the list in place', async () => {
  const launched = await launch(true)
  const { page } = launched
  try {
    await ready(page)
    await page.evaluate(() => { document.documentElement.setAttribute('data-reduced-motion', 'on') })
    await icon(page).click()
    const properties = await scroll(page).evaluate(element => getComputedStyle(element).transitionProperty)
    expect(properties).toBe('opacity')
    await page.keyboard.press('Escape')
  } finally { await close(launched) }
})

test('a prototype waiting for review is on the list, and opening its page takes it off (ADR-0188, decision 10)', async () => {
  test.setTimeout(120_000)
  const previous = process.env['SOTTO_OWL_FEATURES']
  process.env['SOTTO_OWL_FEATURES'] = 'to-do-list=1'
  const launched = await launchSotto().finally(() => { if (previous === undefined) delete process.env['SOTTO_OWL_FEATURES']; else process.env['SOTTO_OWL_FEATURES'] = previous })
  const { page, app, userData } = launched
  try {
    await app.evaluate(({ shell }) => {
      const state = globalThis as unknown as { pagesOpened: string[] }
      state.pagesOpened = []
      shell.openPath = async path => { state.pagesOpened.push(path); return '' }
    })
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, defaultModelId: 'claude:test' } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    const folder = join(userData, 'prototype-project')
    await mkdir(join(folder, 'docs'), { recursive: true })
    await writeFile(join(folder, 'docs', 'greeting-prototype.html'), '<!doctype html><h1>Hello</h1>')
    const threadId = await page.evaluate(async folder => {
      const agents = window.sotto!.agents!
      let state = await agents.command({ type: 'create-project', title: 'Greeting', path: folder, useExisting: true })
      const project = state.host.projects.find(item => item.title === 'Greeting')!
      state = await agents.command({ type: 'create-thread', title: 'Greeting restyle', projectId: project.id, modelId: 'claude:test' })
      const id = state.host.threads.find(item => item.title === 'Greeting restyle')!.id
      await agents.command({ type: 'manual-send', threadId: id, text: 'Make a prototype first.' })
      return id
    }, folder)
    await page.reload()
    await openThreads(page)
    await page.evaluate(async threadId => window.sottoE2E!.agentEvent!({ type: 'ready', threadId, status: 'idle', text: 'The prototype is at docs/greeting-prototype.html.' }), threadId)

    await expect(page.locator('.to-do__badge')).toHaveText('1')
    await expect(page.locator('.to-do__badge')).toHaveAttribute('data-loud')
    await icon(page).click()
    await expect(page.getByText('Review the prototype')).toBeVisible()
    await expect(scroll(page).getByRole('button', { name: /^Open the thread / })).toBeVisible()
    await expect(scroll(page).getByRole('button', { name: 'It didn\'t work' })).toHaveCount(0)
    await expect(page.locator('.to-do__badge')).not.toHaveAttribute('data-loud')
    await shot(page, 'prototype-dark')
    await scroll(page).getByRole('link', { name: 'Open the prototype, greeting-prototype.html', exact: true }).click()
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { pagesOpened: string[] }).pagesOpened.length)).toBe(1)
    // Opening clears the mark, which takes the to-do off, and the last item going rolls the list up.
    await expect(page.locator('.to-do__badge')).toHaveCount(0)
    await expect(scroll(page)).toHaveCount(0)
    await expect(page.locator('.prototype-ready')).toHaveCount(0)
  } finally { await closeSotto(launched) }
})

test('stable shows nothing of it, and keeps its saved list whole', async () => {
  const launched = await launch(false)
  const { page } = launched
  try {
    await ready(page)
    await expect(icon(page)).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { sotto: { toDos?: unknown } }).sotto.toDos === undefined)).toBe(true)
  } finally { await close(launched) }
})
