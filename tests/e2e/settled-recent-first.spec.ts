import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { defaultAgentConfiguration } from '../../src/shared/agents'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { holdContentSize } from './support/sottoWindow'

// By status, the Settled shelf is one list, newest settled first (ADR-0201, Zach's call of November 13, 2026): no project
// folders, each row's time saying when it was settled, Restore project on a row settled with its project, and thirty rows
// at a time. Run after `npm run build`. Captures go to disposable run evidence; `SOTTO_E2E_EVIDENCE=publish` writes
// artifacts/settled-recent-first.
const SHOTS = evidenceDirectory('artifacts/settled-recent-first')

async function capture(page: Page, name: string): Promise<void> {
  for (const appearance of ['dark', 'light'] as const) {
    await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode, accent: 'teal' }), appearance)
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
    await page.screenshot({ path: `${SHOTS}/${name}-${appearance}.png`, animations: 'disabled' })
  }
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark', accent: 'teal' }))
}

/** The shelf's thread rows by name, in the order they are drawn. */
const titles = (shelf: Locator): Promise<(string | null)[]> => shelf.locator('.thread-nav__row > .thread-nav__item').evaluateAll(items => items.map(item => item.getAttribute('aria-label')))

test('by status, Settled is one list, newest settled first, with Restore project on the row and thirty rows at a time', async () => {
  test.setTimeout(240_000)
  await mkdir(SHOTS, { recursive: true })
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-settled-recent-' })).directory
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark', accent: 'teal' }))
  await writeFile(join(profile, 'agents.json'), JSON.stringify({
    configuration: { ...defaultAgentConfiguration(), enabled: true },
    activeThreadId: 'visual-gate', activeProjectId: 'workshop', draft: '', draftThreadId: null, draftRequestId: null, composing: false, outbox: [],
  }))
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('design-threads', profile)
    const { page } = launched
    await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'connect' }) })
    await holdContentSize(launched, 1600, 1000)
    await openThreads(page)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    const shelf = sidebar.getByRole('region', { name: 'Settled', exact: true })
    const rowOf = (scope: Locator, title: string): Locator => scope.locator('.thread-nav__row', { has: page.getByRole('button', { name: title, exact: true }) })

    // The fixture's four settled threads, the one settled last first, under no folder.
    await sidebar.getByRole('button', { name: /^Settled / }).click()
    await expect(shelf.locator('.thread-folder')).toHaveCount(0)
    await expect.poll(() => titles(shelf)).toEqual(['Release notes 1.4', 'Thread routing', 'Notes cleanup', 'Benchmark rerun'])

    // A thread settled now leads the list, though three of them moved after it did, and its time says when it was settled.
    const recent = sidebar.locator('.thread-group[data-group="recent"]')
    const before = Date.now()
    await rowOf(recent, 'Grok voice previews').hover()
    await rowOf(recent, 'Grok voice previews').getByRole('button', { name: 'Settle Grok voice previews', exact: true }).click()
    await page.mouse.move(1200, 500)
    await expect.poll(() => titles(shelf)).toEqual(['Grok voice previews', 'Release notes 1.4', 'Thread routing', 'Notes cleanup', 'Benchmark rerun'])
    const time = rowOf(shelf, 'Grok voice previews').locator('time')
    await expect(time).toHaveAttribute('title', /^Settled /u)
    expect(Date.parse((await time.getAttribute('datetime'))!)).toBeGreaterThanOrEqual(before - 1000)
    // Settled today, it shows its clock; the fixture's threads, settled in July, show their dates.
    await expect(time).toHaveText(/\d{1,2}:\d{2}/u)
    await expect(rowOf(shelf, 'Release notes 1.4').locator('time')).toHaveText(/^Jul \d{1,2}$/u)

    // A project settled whole: its threads stand in the list, and each row offers Restore project, not Restore.
    await page.evaluate(async () => {
      const agents = window.sotto!.agents!
      const notes = (await agents.get()).host.projects.find(project => project.title === 'notes')!
      await agents.command({ type: 'settle-project', projectId: notes.id })
    })
    await expect.poll(() => titles(shelf)).toEqual(['Weekly note', 'Notes cleanup', 'Grok voice previews', 'Release notes 1.4', 'Thread routing', 'Benchmark rerun'])
    const weekly = rowOf(shelf, 'Weekly note')
    await weekly.hover()
    await expect(weekly.getByRole('button', { name: 'Restore project notes', exact: true })).toBeVisible()
    await expect(weekly.getByRole('button', { name: 'Restore Weekly note', exact: true })).toHaveCount(0)
    for (const [width, height] of [[1600, 1000], [1280, 800]] as const) {
      await holdContentSize(launched, width, height)
      await weekly.hover()
      await capture(page, `shelf-${width}`)
    }
    // At the minimum the sidebar is the rail, and Expand sidebar opens the whole of it over the conversation.
    await holdContentSize(launched, 820, 560)
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    await expect(shelf.getByRole('button', { name: 'Grok voice previews', exact: true })).toBeVisible()
    // Nothing in the shelf is wider than the list it scrolls in.
    expect(await shelf.evaluate(node => { const list = node.closest('.thread-nav__scroll')!; return [...node.querySelectorAll('.thread-nav__row')].every(row => row.getBoundingClientRect().right <= list.getBoundingClientRect().right + 1) })).toBe(true)
    await capture(page, 'shelf-820')
    await page.keyboard.press('Escape')
    await holdContentSize(launched, 1600, 1000)

    // The row's menu says Restore project in words; pressing it brings the project's threads back to the open list.
    await rowOf(shelf, 'Notes cleanup').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Restore project', exact: true }).click()
    await expect.poll(() => titles(shelf)).toEqual(['Grok voice previews', 'Release notes 1.4', 'Thread routing', 'Notes cleanup', 'Benchmark rerun'])
    await expect(sidebar.locator('.thread-group').getByRole('button', { name: 'Weekly note', exact: true })).toBeVisible()

    // Thirty at a time: with thirty-eight settled, the shelf shows thirty and Show 8 more brings the rest.
    await page.evaluate(async () => {
      const agents = window.sotto!.agents!
      const projectId = (await agents.get()).host.projects.find(project => project.title === 'workshop')!.id
      for (let index = 1; index <= 33; index++) {
        const title = `Put away ${String(index).padStart(2, '0')}`
        const made = await agents.command({ type: 'create-thread', projectId, title, titleSource: 'user', modelId: 'codex:gpt', workingCopy: 'shared' })
        if (made.error) throw new Error(made.error)
        const settled = await agents.command({ type: 'settle-thread', threadId: made.host.threads.find(thread => thread.title === title)!.id })
        if (settled.error) throw new Error(settled.error)
      }
    })
    await expect.poll(async () => (await titles(shelf)).slice(0, 2)).toEqual(['Put away 33', 'Put away 32'])
    await expect(shelf.locator('.thread-nav__row > .thread-nav__item')).toHaveCount(30)
    const more = shelf.getByRole('button', { name: 'Show 8 more settled threads', exact: true })
    await more.scrollIntoViewIfNeeded()
    await expect(more).toHaveText('Show 8 more')
    await capture(page, 'show-more')
    // The keys reach it after the last row, and a press shows the rest.
    await shelf.locator('.thread-nav__row > .thread-nav__item').nth(29).focus()
    await page.keyboard.press('ArrowDown')
    await expect(more).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(shelf.locator('.thread-nav__row > .thread-nav__item')).toHaveCount(38)
    await expect(shelf.getByRole('button', { name: /^Show /u })).toHaveCount(0)
    expect((await titles(shelf)).at(-1)).toBe('Benchmark rerun')

    // A search lists every settled match, with no Show more.
    await page.getByRole('searchbox', { name: 'Search threads' }).fill('Put away')
    await expect(shelf.locator('.thread-nav__row > .thread-nav__item')).toHaveCount(33)
    await expect(shelf.getByRole('button', { name: /^Show /u })).toHaveCount(0)
  } finally { if (launched) await closeSotto(launched) }
})
