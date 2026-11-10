import { expect, test, type Page } from '@playwright/test'

import { withSotto } from '../fixtures/designCaptureProfile'
import { onReleaseTrack } from './support/releaseTrack'
import { openThreads } from './support/sottoLaunch'

/**
 * Show earlier messages in a thread whose newest ten turns are more than the pane's first 80 rows (#214): once the pane
 * shows every message the thread holds, the next press asks the store, and what arrives shows above the reader, who stays
 * where they were (Zach's pick B, November 9, 2026; ADR-0016).
 */
const THREAD = 'release-notes'
// Ten messages a turn, so the store's newest ten turns are 100 messages and the store holds 20 turns in all.
const TURNS = 20, PER_TURN = 10

async function openThread(page: Page, title: string): Promise<void> {
  const search = page.getByRole('searchbox', { name: 'Search threads' })
  await search.fill(title)
  await page.getByRole('button', { name: title, exact: true }).click()
  await search.fill('')
}

test('Show earlier messages from the store shows what arrived above the reader and keeps every row they had', async () => {
  test.setTimeout(180_000)
  await onReleaseTrack('owl', () => withSotto({ onboardingComplete: true, appearance: 'dark', scenario: 'design-threads', agents: 'design-threads' }, async launched => {
    const { page } = launched
    await openThreads(page)
    await openThread(page, 'Release notes 1.4')
    await page.evaluate(async ({ thread, turns, perTurn }) => {
      await window.sottoE2E!.agentEvent!({ type: 'history', threadId: thread, text: '', messages: Array.from({ length: turns * perTurn }, (_, index) => ({
        id: `long-${index}`, role: index % perTurn ? 'assistant' as const : 'user' as const, text: `Message ${index}`,
        createdAt: new Date(Date.UTC(2026, 10, 9, 9, 0, index)).toISOString() })) })
    }, { thread: THREAD, turns: TURNS, perTurn: PER_TURN })
    // Away and back, so the pane opens on the newest ten turns the store holds.
    await openThread(page, 'Thread routing')
    await openThread(page, 'Release notes 1.4')
    const log = page.getByRole('log', { name: 'Thread transcript' })
    const newest = TURNS * PER_TURN - 1
    await expect(log.locator(`[data-message-id="long-${newest}"]`)).toBeVisible()
    // A turn's earlier replies fold under its work, so a turn's prompt is what shows the rows a window holds.

    // The 20 the pane holds but hasn't drawn.
    await log.getByRole('button', { name: 'Show earlier messages (20)' }).click()
    const oldestHeld = log.locator(`[data-message-id="long-${newest - 99}"]`)
    // The reader goes up to the button, at the top of what the pane holds, as they would to press it.
    const fromStore = log.getByRole('button', { name: 'Show earlier messages', exact: true })
    await fromStore.scrollIntoViewIfNeeded()
    await expect(oldestHeld).toBeVisible()
    const before = (await oldestHeld.boundingBox())!.y
    // While the store answers, the loading line takes the button's place; at the top there is no room to make up the
    // difference, so that line's height is all the reader may move.
    const buttonLine = await log.locator('.thread-transcript__earlier').evaluate(line => line.getBoundingClientRect().height + parseFloat(getComputedStyle(line).marginBottom))

    // Now the store: its earlier 100 arrive above, and the row the reader was on stays where it was.
    await fromStore.click()
    await expect(log.locator('[data-message-id="long-0"]')).toHaveCount(1, { timeout: 15_000 })
    for (let turn = 0; turn < TURNS; turn++) await expect(log.locator(`[data-message-id="long-${turn * PER_TURN}"]`)).toHaveCount(1)
    await expect.poll(async () => Math.abs(Math.round((await oldestHeld.boundingBox())!.y - before)) <= Math.ceil(buttonLine)).toBe(true)
    await expect(log.getByRole('button', { name: /^Show earlier messages/u })).toHaveCount(0)
  }))
})
