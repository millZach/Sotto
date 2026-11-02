import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { pageBoundProblems } from './support/designCapture'
import { openPage, openThreads } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'
import { seedWatcherFirstEntry } from './support/watcherRoom'

// #1834 and the Help half of #1822, from the desktop UI review: a room with nothing in it says so once, in its own
// sentence, instead of drawing the scaffolding of a busy one. docs/verification/watcher-start-and-empty-rooms.md cites
// what this writes when run with SOTTO_E2E_EVIDENCE=publish.

const shots = evidenceDirectory('artifacts/watcher-start-and-empty-rooms')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
/** Dark and light, and dark again with reduced motion, each named by what its captures are called. */
const LOOKS = [
  { appearance: 'dark', motion: 'normal', name: 'dark' },
  { appearance: 'light', motion: 'normal', name: 'light' },
  { appearance: 'dark', motion: 'reduced', name: 'dark-reduced-motion' },
] as const

async function shoot(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, 0)
  // Two frames, for the layout a resize asked for to land before it is measured.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  expect(await pageBoundProblems(page), `${name} has clipped or overflowing controls`).toEqual([])
  await page.screenshot({ path: join(shots, name), animations: 'disabled', caret: 'hide' })
}

async function atEverySize(launched: Parameters<Parameters<typeof withSotto>[1]>[0], name: string, aim?: () => Promise<void>): Promise<void> {
  for (const [width, height] of SIZES) {
    // The nested desktop can hand a new window its first size back once after a resize, so the size is asked for until
    // it holds for a moment.
    await expect(async () => {
      await resizeContentWindow(launched, width, height, [820, 560])
      await launched.page.waitForTimeout(250)
      expect(await launched.page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height])
    }).toPass()
    await aim?.()
    await shoot(launched.page, `${name}-${width}x${height}.png`)
  }
}

test.describe('empty rooms say so once (#1834), and Help explains Watcher (#1822)', () => {
  test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 })
  test.beforeAll(async () => { await mkdir(shots, { recursive: true }) })

  test('the Dictate room with nothing dictated: one sentence under Your numbers in place of the stats', async () => {
    for (const { appearance, motion, name } of LOOKS) {
      await withSotto({ onboardingComplete: true, appearance, motion }, async (launched) => {
        const { page } = launched
        await openPage(page, 'Dictate')
        const column = page.getByRole('complementary', { name: 'Your dictation' })
        await expect(column.getByRole('heading', { name: 'Your numbers', exact: true })).toBeVisible()
        await expect(column).toHaveText('Your numbersWords, speed, streak and where your words went show here once you have dictated on two days.')
        await expect(page.getByRole('heading', { name: 'Speed, last 30 days' })).toHaveCount(0)
        await atEverySize(launched, `dictate-${name}`)
      })
    }
  })

  test('Usage with nothing recorded: one card, and no views or filters until there is data', async () => {
    for (const { appearance, motion, name } of LOOKS) {
      await withSotto({ onboardingComplete: true, appearance, motion }, async (launched) => {
        const { page } = launched
        await page.getByRole('link', { name: 'Usage', exact: true }).click()
        await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeVisible()
        await expect(page.getByRole('region', { name: 'No usage yet' })).toBeVisible({ timeout: 30_000 })
        await expect(page.getByRole('tablist', { name: 'Usage views' })).toHaveCount(0)
        await expect(page.getByRole('button', { name: /^Date range/u })).toHaveCount(0)
        await atEverySize(launched, `usage-${name}`)
      })
    }
  })

  test('the Threads sidebar with empty projects: each folder its name alone, and the room says it once', async () => {
    for (const { appearance, motion, name } of LOOKS) {
      await withSotto({ onboardingComplete: true, appearance, motion, scenario: 'design-threads-empty', agents: 'design-threads-empty' }, async (launched) => {
        const { page } = launched
        await openThreads(page)
        await expect(page.getByRole('heading', { name: 'No threads yet.' })).toBeVisible()
        const projects = page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('region', { name: 'Projects' })
        await expect(projects.locator('.thread-folder').first()).toBeVisible()
        await expect(projects).not.toContainText('No open threads.')
        await expect(projects).not.toContainText('No threads yet.')
        await expect(projects.locator('.thread-folder__count')).toHaveCount(0)
        await atEverySize(launched, `threads-${name}`)
      })
    }
  })

  test('Watcher before it starts: one sentence over the composer, and How Watcher works opens Help at its topic (#1822)', async () => {
    for (const { appearance, motion, name } of LOOKS) {
      await withSotto({ onboardingComplete: true, appearance, motion, scenario: 'design-threads', agents: 'design-threads' }, async (launched) => {
        const { page } = launched
        await openThreads(page)
        await seedWatcherFirstEntry(page)
        await page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name: 'Watcher', exact: true }).click()
        await expect(page.getByRole('heading', { level: 2, name: 'Start Watcher' })).toBeAttached()
        const intro = page.locator('.watcher-first__intro')
        await expect(intro.locator('p').first()).toHaveText('Watcher starts your other threads, briefs them and keeps an eye on them while they work. Your first message starts it. How Watcher works')
        expect(await intro.evaluate(element => getComputedStyle(element).textAlign)).toBe('start')
        await expect(page.getByRole('textbox', { name: 'Watcher message' })).toHaveAttribute('data-placeholder', 'Say what to start or check.')
        await atEverySize(launched, `watcher-${name}`)
        await page.getByRole('button', { name: 'How Watcher works' }).click()
        await expect(page.getByRole('heading', { level: 1, name: 'Help' })).toBeVisible()
        await expect(page.locator('#help-watcher > summary')).toBeFocused()
        await shoot(page, `watcher-help-${name}-820x560.png`)
      })
    }
  })

  test('Help explains Watcher under its own topic', async () => {
    for (const { appearance, motion, name } of LOOKS) {
      await withSotto({ onboardingComplete: true, appearance, motion }, async (launched) => {
        const { page } = launched
        await openPage(page, 'Help')
        const topic = page.locator('#help-watcher')
        await expect(topic.getByRole('heading', { name: 'How Watcher works' })).toBeVisible()
        await expect(topic).toContainText('It hands changes to your threads rather than making them itself')
        await atEverySize(launched, `help-${name}`, () => topic.evaluate(element => element.scrollIntoView({ block: 'start' })))
      })
    }
  })
})
