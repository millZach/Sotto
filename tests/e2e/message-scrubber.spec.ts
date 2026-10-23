import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'

import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { pageBoundProblems } from './support/designCapture'
import { onReleaseTrack } from './support/releaseTrack'
import { captureWindow } from './support/sottoCapture'
import { openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'

/**
 * The message scrubber in the built app (ADR-0109; Owl only): a long thread's ticks in the left margin, the card a tick
 * shows under the pointer and from the keyboard, a press that lands on its message, and the same at every size the
 * design gate checks, in dark, light and with motion reduced.
 */
const shots = evidenceDirectory('artifacts/message-scrubber')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const THREAD = 'release-notes'
const TURNS = 24
const ASKS = [
  'The host update pill flickers when two hosts reconnect at the same moment. Can you find out why?',
  'Go with the debounce, but keep it under 200 ms so a real update still shows quickly.',
  'Can you also make a video of this app being used with two hosts reconnecting, so I can show Pat?',
  'Now run the host contract tests, only the reconnect ones. RAM is tight.',
  'Light theme: the pill text looks washed out. Check it against 4.5:1.',
  'What happens at 820 by 560? Does the pill still fit beside the window controls?',
]
const REPLY = 'Both hosts send their update inside the same frame, and the router replaces the whole list for each one. Between the two writes the list is briefly empty, so the pill unmounts and mounts again. Batching the writes for 150 ms fixes it and keeps the router’s shape.'

test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 })
test.beforeAll(async () => { await mkdir(shots, { recursive: true }) })

function options(appearance: 'dark' | 'light', motion: 'normal' | 'reduced' = 'normal') {
  return { onboardingComplete: true, appearance, motion, scenario: 'design-threads', agents: 'design-threads', ...(appearance === 'dark' ? { darkTheme: 't3-code' } : { lightTheme: 't3-code' }) } as const
}

/** Replaces Release notes 1.4's history with a long conversation and opens it. */
async function longThread(page: Page): Promise<Locator> {
  await openThreads(page)
  // It is settled, so a search opens its group.
  await page.getByRole('searchbox', { name: 'Search threads' }).fill('Release notes')
  await page.getByRole('button', { name: 'Release notes 1.4', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search threads' }).fill('')
  await page.evaluate(async ({ thread, turns, asks, reply }) => {
    await window.sottoE2E!.agentEvent!({ type: 'history', threadId: thread, text: '', messages: Array.from({ length: turns * 2 }, (_, index) => ({
      id: `scrub-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const,
      text: index % 2 ? `${reply} (${(index - 1) / 2 + 1})` : `${asks[(index / 2) % asks.length]} (${index / 2 + 1})`,
      createdAt: new Date(Date.UTC(2026, 9, 22, 9, index * 3)).toISOString() })) })
  }, { thread: THREAD, turns: TURNS, asks: ASKS, reply: REPLY })
  const log = page.getByRole('log', { name: 'Thread transcript' })
  await expect(log.locator('[data-message-id="scrub-47"]')).toBeVisible()
  return log
}

const scrubber = (page: Page) => page.getByRole('navigation', { name: 'Messages you sent' })
const card = (page: Page) => page.locator('.message-scrubber__card')

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready
    // The card fades in over 120 ms; a capture waits for it, and for the ticks' rise, to finish.
    await Promise.all([...document.querySelectorAll('.message-scrubber, .message-scrubber__card')].flatMap(element => element.getAnimations({ subtree: true }).map(animation => animation.finished)))
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
}

/** Points at a tick by its place in the column, the way a hand moving through the lane would. */
async function pointAt(page: Page, tick: Locator): Promise<void> {
  const box = (await tick.boundingBox())!
  await page.mouse.move(box.x + box.width / 2 - 4, box.y + box.height / 2 - 30)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
}

async function capture(launched: LaunchedSotto, name: string): Promise<void> {
  await settle(launched.page)
  await captureWindow(launched.app, resolve(shots, `${name}.png`))
}

for (const appearance of ['dark', 'light'] as const) {
  test(`a long thread's ticks preview and reach every message sent, in ${appearance}`, async () => {
    await onReleaseTrack('owl', () => withSotto(options(appearance), async launched => {
      const { page } = launched
      const log = await longThread(page)
      const nav = scrubber(page)
      await expect(nav).toBeVisible()
      const ticks = nav.getByRole('button')
      await expect(ticks).toHaveCount(TURNS)
      for (const [width, height] of SIZES) {
        await resizeContentWindow(launched, width, height)
        await page.mouse.move(0, 0)
        await expect(card(page)).toHaveCount(0)
        await settle(page)
        expect(await pageBoundProblems(page), `${width}x${height}`).toEqual([])
        // The lane sits wholly in the margin, left of the column's first word.
        const lane = (await nav.boundingBox())!
        const column = (await log.locator('.thread-transcript__content').boundingBox())!
        expect(lane.x + lane.width).toBeLessThanOrEqual(column.x + 0.5)
        expect(lane.x).toBeGreaterThanOrEqual((await log.boundingBox())!.x - 0.5)
        await capture(launched, `rest-${appearance}-${width}x${height}`)
        await pointAt(page, ticks.nth(5))
        await expect(card(page)).toBeVisible()
        await expect(card(page)).toContainText(`Message 6 of ${TURNS}`)
        await expect(card(page)).toContainText(`${ASKS[5]} (6)`)
        await expect(card(page)).toContainText('replied')
        const cardBox = (await card(page).boundingBox())!
        const view = (await log.boundingBox())!
        expect(cardBox.y).toBeGreaterThanOrEqual(view.y)
        expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(view.y + view.height + 0.5)
        expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(view.x + view.width)
        expect(cardBox.x).toBeGreaterThanOrEqual(lane.x + lane.width)
        // The tick under the pointer is the longest; its neighbours rise less the further they are.
        const widths = await ticks.evaluateAll(items => items.map(item => Number.parseFloat(getComputedStyle(item, '::before').width)))
        expect(widths[5]).toBeGreaterThan(widths[4]!)
        expect(widths[4]).toBeGreaterThan(widths[2]!)
        await capture(launched, `hover-${appearance}-${width}x${height}`)
      }
      // A press lands its message at the top of the transcript, marked.
      await resizeContentWindow(launched, 1280, 800)
      await pointAt(page, ticks.nth(2))
      await ticks.nth(2).click()
      const target = log.locator('[data-message-id="scrub-4"]')
      await expect(target).toHaveAttribute('data-sought', '')
      await expect.poll(async () => Math.round((await target.boundingBox())!.y - (await log.boundingBox())!.y)).toBeLessThan(60)
      await expect(card(page)).toHaveCount(0)
      // From the keyboard: Tab from the thread's header reaches the column, the arrows move, Enter lands with focus.
      await ticks.nth(2).focus()
      await page.keyboard.press('ArrowDown')
      await expect(ticks.nth(3)).toBeFocused()
      await expect(card(page)).toContainText(`Message 4 of ${TURNS}`)
      await expect(card(page)).toContainText('Enter goes there.')
      await capture(launched, `keys-${appearance}-1280x800`)
      await page.keyboard.press('Escape')
      await expect(card(page)).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(log).toBeFocused()
      await ticks.nth(0).focus()
      await page.keyboard.press('Enter')
      await expect(log.locator('[data-message-id="scrub-0"]')).toBeFocused()
    }))
  })
}

test('with motion reduced the ticks rise without moving and the card appears in place', async () => {
  await onReleaseTrack('owl', () => withSotto(options('dark', 'reduced'), async launched => {
    const { page } = launched
    await longThread(page)
    const ticks = scrubber(page).getByRole('button')
    await pointAt(page, ticks.nth(8))
    await expect(card(page)).toBeVisible()
    // Sotto's own reduced-motion rule leaves a thousandth of a second, which no eye sees move.
    expect(Number.parseFloat(await ticks.nth(8).evaluate(item => getComputedStyle(item, '::before').transitionDuration))).toBeLessThanOrEqual(0.001)
    expect(await card(page).evaluate(item => { const style = getComputedStyle(item); return style.animationName === 'none' || Number.parseFloat(style.animationDuration) <= 0.001 })).toBe(true)
    await capture(launched, 'hover-reduced-dark-1280x800')
  }))
})

test('stable shows no scrubber', async () => {
  await onReleaseTrack('stable', () => withSotto(options('dark'), async ({ page }) => {
    await longThread(page)
    await expect(scrubber(page)).toHaveCount(0)
  }))
})
