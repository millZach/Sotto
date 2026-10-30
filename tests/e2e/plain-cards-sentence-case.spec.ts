import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

import { populatedHistory, withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { pageBoundProblems } from './support/designCapture'
import { openPage, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'

// #1830 and #1829, from the desktop UI review: a card says its status in words, with no coloured stripe down its left
// edge, and labels are written in sentence case rather than drawn in tracked capitals. docs/verification/
// plain-cards-sentence-case.md cites what this writes when run with SOTTO_E2E_EVIDENCE=publish.

const shots = evidenceDirectory('artifacts/plain-cards-sentence-case')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
/** Dark and light, and dark again with reduced motion, each named by what its captures are called. */
const LOOKS = [
  { appearance: 'dark', motion: 'normal', name: 'dark' },
  { appearance: 'light', motion: 'normal', name: 'light' },
  { appearance: 'dark', motion: 'reduced', name: 'dark-reduced-motion' },
] as const

/** `bounds: false` where the page's own clipping checks are another spec's: the Threads page is design-capture-threads'. */
async function shoot(page: Page, name: string, { bounds = true } = {}): Promise<void> {
  await page.mouse.move(0, 0)
  // Two frames, for the layout a resize asked for to land before it is measured.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  if (bounds) expect(await pageBoundProblems(page), `${name} has clipped or overflowing controls`).toEqual([])
  await page.screenshot({ path: join(shots, name), animations: 'disabled', caret: 'hide' })
}

/**
 * The nested desktop can hand a new window its first size back once after a resize, so the size is asked for until it
 * holds for a moment.
 */
async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await expect(async () => {
    await resizeContentWindow(launched, width, height, [820, 560])
    await launched.page.waitForTimeout(250)
    expect(await launched.page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height])
  }).toPass()
}

/** The words on the page a stylesheet turns into capitals; none should be. */
async function capitalised(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>('body *')]
    .filter(element => getComputedStyle(element).textTransform === 'uppercase' && (element.textContent ?? '').trim() !== '')
    .map(element => (element.textContent ?? '').trim().slice(0, 60)))
}

/** Every side of the card's border is drawn alike, so no side is a status edge. */
async function edges(card: Locator): Promise<{ left: string; top: string }> {
  return card.evaluate(element => {
    const style = getComputedStyle(element)
    return { left: `${style.borderLeftWidth} ${style.borderLeftColor}`, top: `${style.borderTopWidth} ${style.borderTopColor}` }
  })
}

test.describe('plain cards and sentence-case labels (#1830, #1829)', () => {
  test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 })
  test.beforeAll(async () => { await mkdir(shots, { recursive: true }) })

  test('first-run setup opens on "Step 1 of N" with no eyebrow over its heading', async () => {
    for (const { appearance, motion, name } of LOOKS) {
      await withSotto({ onboardingComplete: false, appearance, motion }, async (launched) => {
        const { page } = launched
        await expect(page.getByRole('heading', { level: 1, name: /talk to your computer and your coding agents/i })).toBeVisible()
        await expect(page.locator('.onboarding-progress__text')).toHaveText(/^Step 1 of \d+$/u)
        await expect(page.getByText('Welcome to Sotto', { exact: true })).toHaveCount(0)
        expect(await capitalised(page)).toEqual([])
        for (const [width, height] of SIZES) {
          await resize(launched, width, height)
          await shoot(page, `setup-welcome-${name}-${width}x${height}.png`)
        }
      })
    }
  })

  test('the Dictate room names its stats and its days in sentence case', async () => {
    for (const { appearance, motion, name } of LOOKS) {
      await withSotto({ onboardingComplete: true, history: populatedHistory, appearance, motion }, async (launched) => {
        const { page } = launched
        await openPage(page, 'Dictate')
        await expect(page.getByRole('region', { name: 'Today' })).toBeVisible()
        await expect(page.getByRole('heading', { name: 'This month', exact: true })).toBeVisible()
        for (const [width, height] of SIZES) {
          await resize(launched, width, height)
          expect(await capitalised(page)).toEqual([])
          await shoot(page, `dictate-${name}-${width}x${height}.png`)
        }
      })
    }
  })

  test('a waiting permission is a plain card: no side of it is drawn in a status colour', async () => {
    for (const { appearance, motion, name } of LOOKS) {
      await withSotto({ onboardingComplete: true, appearance, motion, scenario: 'design-threads', agents: 'design-threads' }, async (launched) => {
        const { page } = launched
        await openThreads(page)
        const row = page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Visual gate flake', exact: true })
        // Press the title, as a person does: a row's hover actions cover its middle.
        await row.click({ position: { x: 16, y: 12 } })
        await expect(row).toHaveAttribute('aria-current', 'page')
        const card = page.locator('.thread-transcript .agent-request[data-kind="permission"]')
        await expect(card.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
        const sides = await edges(card)
        expect(sides.left, JSON.stringify(sides)).toBe(sides.top)
        for (const [width, height] of SIZES) {
          await resize(launched, width, height)
          await card.scrollIntoViewIfNeeded()
          await shoot(page, `permission-${name}-${width}x${height}.png`, { bounds: false })
        }
      })
    }
  })
})
