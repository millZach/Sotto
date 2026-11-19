import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { onReleaseTrack } from './support/releaseTrack'
import { openThreads } from './support/sottoLaunch'
import { holdContentSize } from './support/sottoWindow'

/**
 * Search threads finds a thread by what was said in it (ADR-0209, Zach's pick A of November 19, 2026): a phrase only one
 * thread's messages hold, in neither its title nor its row, finds that thread a moment after typing stops, quoted under its
 * name with the phrase marked, after the rows found by their own words. Run after `npm run build`. Captures go to
 * disposable run evidence; `SOTTO_E2E_EVIDENCE=publish` writes artifacts/thread-word-search.
 */
const SHOTS = evidenceDirectory('artifacts/thread-word-search')
const THREAD = 'release-notes'
const PHRASE = 'zebra crossing timer'

async function capture(page: Page, name: string): Promise<void> {
  for (const appearance of ['dark', 'light'] as const) {
    await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode, accent: 'teal' }), appearance)
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
    await page.screenshot({ path: `${SHOTS}/${name}-${appearance}.png`, animations: 'disabled' })
  }
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark', accent: 'teal' }))
}

test('a phrase only inside a thread finds it, quoted under its name after the title matches', async () => {
  test.setTimeout(180_000)
  await mkdir(SHOTS, { recursive: true })
  await onReleaseTrack('stable', () => withSotto({ onboardingComplete: true, appearance: 'dark', scenario: 'design-threads', agents: 'design-threads' }, async launched => {
    const { page } = launched
    await openThreads(page)
    // Release notes 1.4 says the phrase twice, deep in its history: once in a reply, then in the user's own message, which
    // is not their last.
    await page.evaluate(async ({ thread, phrase }) => {
      const at = (index: number): string => new Date(Date.UTC(2026, 10, 19, 9, 0, index)).toISOString()
      await window.sottoE2E!.agentEvent!({ type: 'history', threadId: thread, text: '', messages: [
        ...Array.from({ length: 300 }, (_, index) => ({ id: `filler-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const, text: `Release step ${index} is done.`, createdAt: at(index) })),
        { id: 'said-reply', role: 'assistant' as const, text: `The notes now cover the ${phrase} on the release page, below the changelog.`, createdAt: at(301) },
        { id: 'said-user', role: 'user' as const, text: `Keep the ${phrase} paragraph short.`, createdAt: at(302) },
        { id: 'last-reply', role: 'assistant' as const, text: 'Done.', createdAt: at(303) },
        // The user's last message is part of what the row says, so it must not say the phrase.
        { id: 'last-user', role: 'user' as const, text: 'Ship it.', createdAt: at(304) },
        { id: 'last-done', role: 'assistant' as const, text: 'Shipped.', createdAt: at(305) },
      ] })
    }, { thread: THREAD, phrase: PHRASE })

    const search = page.getByRole('searchbox', { name: 'Search threads' })
    const row = page.getByRole('button', { name: 'Release notes 1.4', exact: true })
    const started = Date.now()
    await search.fill(PHRASE)
    // The row says nothing of it, so only the thread's own words find it.
    await expect(row).toBeVisible({ timeout: 10_000 })
    const shownAfter = Date.now() - started
    const quote = row.locator('.thread-nav__quote')
    await expect(quote).toContainText(`You: Keep the ${PHRASE} paragraph short.`)
    await expect(quote).toContainText('1 more in this thread')
    await expect(quote.locator('mark')).toHaveText(PHRASE)
    await expect(page.getByText(`Nothing matches "${PHRASE}".`)).toHaveCount(0)
    test.info().annotations.push({ type: 'shown after', description: `${shownAfter} ms from typing to the quoted row` })
    for (const [width, height] of [[1600, 1000], [1280, 800]] as const) {
      await holdContentSize(launched, width, height)
      await capture(page, `found-${width}`)
    }

    // A search that matches one thread's title and another's words lists the title match first.
    await holdContentSize(launched, 1280, 800)
    await search.fill('routing')
    const routing = page.getByRole('button', { name: 'Thread routing', exact: true })
    await expect(routing).toBeVisible()
    await page.evaluate(async thread => {
      await window.sottoE2E!.agentEvent!({ type: 'history', threadId: thread, text: '', messages: [
        { id: 'routing-word', role: 'assistant' as const, text: 'The routing table is in the release notes.', createdAt: new Date(Date.UTC(2026, 10, 19, 10)).toISOString() },
        { id: 'routing-user', role: 'user' as const, text: 'Ship it.', createdAt: new Date(Date.UTC(2026, 10, 19, 10, 1)).toISOString() },
        { id: 'routing-done', role: 'assistant' as const, text: 'Shipped.', createdAt: new Date(Date.UTC(2026, 10, 19, 10, 2)).toISOString() },
      ] })
    }, THREAD)
    await search.fill('')
    await search.fill('routing')
    await expect(row.locator('.thread-nav__quote')).toContainText('routing table')
    const order = await page.locator('.thread-nav__row > .thread-nav__item').evaluateAll(items => items.map(item => item.getAttribute('aria-label')))
    expect(order.indexOf('Thread routing')).toBeLessThan(order.indexOf('Release notes 1.4'))
    await expect(routing.locator('.thread-nav__quote')).toHaveCount(0)

    // At the minimum the sidebar is the rail; opened over the thread, the quoted row fits the list.
    await holdContentSize(launched, 820, 560)
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    await expect(row.locator('.thread-nav__quote')).toBeVisible()
    expect(await row.evaluate(node => { const list = node.closest('.thread-nav__scroll')!; return node.getBoundingClientRect().right <= list.getBoundingClientRect().right + 1 })).toBe(true)
    await capture(page, 'found-820')
  }))
})
