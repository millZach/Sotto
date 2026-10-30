import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { pageBoundProblems } from './support/designCapture'
import { openPage } from './support/sottoLaunch'
import { holdContentSize } from './support/sottoWindow'

// #1831, from the desktop UI review: the last containers ADR-0110 had not reached. Settings' Microphone test is a row on
// the Microphone card, and Hosts & phones groups its rows on cards with no dashed box. First-run setup's card is checked
// by first-run-setup-fit.spec.ts. docs/verification/filled-cards-and-setup-card.md cites what this writes when run with
// SOTTO_E2E_EVIDENCE=publish.

const shots = evidenceDirectory('artifacts/filled-cards-and-setup-card')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
/** Dark and light, and dark again with reduced motion, each named by what its captures are called. */
const LOOKS = [
  { appearance: 'dark', motion: 'normal', name: 'dark' },
  { appearance: 'light', motion: 'normal', name: 'light' },
  { appearance: 'dark', motion: 'reduced', name: 'dark-reduced-motion' },
] as const

async function shoot(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, 0)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  expect(await pageBoundProblems(page), `${name} has clipped or overflowing controls`).toEqual([])
  await page.screenshot({ path: join(shots, name), animations: 'disabled', caret: 'hide' })
}

async function openSettingsPage(page: Page, name: string): Promise<Locator> {
  await openPage(page, 'Settings')
  await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name, exact: true }).click()
  return page.getByRole('tabpanel', { name, exact: true })
}

/** Every element in the panel drawn with a dashed or a solid outline all round, which a card's contents no longer have. */
async function outlinedBoxes(panel: Locator): Promise<string[]> {
  return panel.evaluate(root => [...root.querySelectorAll<HTMLElement>('*')].filter(element => {
    const style = getComputedStyle(element)
    const sides = [style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle]
    if (sides.includes('dashed')) return true
    // A box: all four sides drawn in a colour that shows, around something larger than a control.
    const drawn = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].every(width => width !== '0px')
      && ![style.borderTopColor, style.borderLeftColor].some(colour => colour === 'rgba(0, 0, 0, 0)' || colour === 'transparent')
    const box = element.getBoundingClientRect()
    return drawn && sides.every(side => side === 'solid') && box.height > 60 && !element.matches('input, select, textarea, button, [role="switch"]')
  }).map(element => `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`))
}

test.describe('the last containers as fills (#1831)', () => {
  test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 })
  test.beforeAll(async () => { await mkdir(shots, { recursive: true }) })

  test('the Microphone test is a row on the Microphone card: its label with its words, the level and the button at its end', async () => {
    for (const { appearance, motion, name } of LOOKS) {
      await withSotto({ onboardingComplete: true, appearance, motion }, async (launched) => {
        const { page } = launched
        const panel = await openSettingsPage(page, 'Dictation')
        const row = panel.locator('.settings-microphone-test')
        await expect(row.getByRole('button', { name: 'Test microphone' })).toBeVisible()
        expect(await outlinedBoxes(panel)).toEqual([])
        for (const [width, height] of SIZES) {
          await holdContentSize(launched, width, height)
          await row.scrollIntoViewIfNeeded()
          const gap = await row.evaluate(element => {
            const label = element.querySelector('.tt-field__label')!.getBoundingClientRect()
            const words = element.querySelector('.tt-field__description')!.getBoundingClientRect()
            return words.top - label.bottom
          })
          expect(gap, `the label sits with its words at ${width}x${height}`).toBeLessThan(12)
          await shoot(page, `microphone-${name}-${width}x${height}.png`)
        }
      })
    }
  })

  test('Hosts & phones groups its rows on cards, with no dashed or outlined box', async () => {
    for (const { appearance, motion, name } of LOOKS) {
      await withSotto({ onboardingComplete: true, appearance, motion }, async (launched) => {
        const { page } = launched
        const panel = await openSettingsPage(page, 'Hosts & phones')
        await expect(panel.getByRole('switch', { name: 'Run the local host' })).toBeVisible()
        await expect(panel.locator('.hosts-card')).toHaveCount(3)
        await expect(panel.getByText('No remote hosts yet.')).toBeVisible()
        expect(await outlinedBoxes(panel)).toEqual([])
        for (const [width, height] of SIZES) {
          await holdContentSize(launched, width, height)
          await page.evaluate(() => document.querySelector('.settings-scroll')?.scrollTo(0, 0))
          await shoot(page, `hosts-${name}-${width}x${height}.png`)
          await panel.locator('.phones-card').evaluate(element => element.scrollIntoView({ block: 'start' }))
          await shoot(page, `phones-${name}-${width}x${height}.png`)
        }
      })
    }
  })
})
