import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { pageBoundProblems } from './support/designCapture'
import { openPage } from './support/sottoLaunch'
import { holdContentSize } from './support/sottoWindow'

// #1907: Settings' footer status sat in the room's bottom-right corner on a patch of canvas, over whatever row had
// scrolled under it; the design baselines showed it covering a switch. Every room now keeps the status on a line of its
// own, so no control or its words is ever under it, at a section's heading or at its end. Beside the sidebar the room's
// foot line already did that; the rooms are checked too, so a layout that goes back to an overlay fails here.
// docs/verification/settings-footer-status-clearance.md cites what this writes when run with SOTTO_E2E_EVIDENCE=publish.

const shots = evidenceDirectory('artifacts/settings-footer-status-clearance')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
/** Dark and light, photographed, and dark again with reduced motion, checked only: the status itself never moves. */
const LOOKS = [
  { appearance: 'dark', motion: 'normal', name: 'dark', photographed: true },
  { appearance: 'light', motion: 'normal', name: 'light', photographed: true },
  { appearance: 'dark', motion: 'reduced', name: 'dark with reduced motion', photographed: false },
] as const
/** The sections photographed at their end for the note: the one the issue showed, and the longest. */
const PHOTOGRAPHED = new Map([['Providers', 'providers'], ['Application', 'application']])

interface Corner {
  /** The footer status's own element. */
  readonly status: string
  /** What scrolls beside or under it. */
  readonly scroller: string
  /** The content whose controls and words must stay clear of it. */
  readonly content: string
}

const SETTINGS: Corner = { status: '.page-status', scroller: '.settings-scroll', content: '.settings-form > [role="tabpanel"]:not([hidden])' }
const ROOM: Corner = { status: '.app-room__foot .app-footer__status', scroller: '.app-room', content: '.app-room' }

/** Lets the pointer, a section's arrival and the next two frames settle; a looping animation is not waited for. */
async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0)
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter(animation => {
      const end = animation.effect?.getComputedTiming().endTime
      return typeof end === 'number' && Number.isFinite(end) && end <= 1000
    })
    await Promise.all(finite.map(animation => animation.finished.catch(() => undefined)))
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
}

/** Scrolls to the end and holds it there, scrolling again if content that arrived late made the column longer. */
async function scrollToEnd(page: Page, scroller: string): Promise<void> {
  await expect(async () => {
    await page.evaluate(selector => { const port = document.querySelector(selector)!; port.scrollTop = port.scrollHeight }, scroller)
    await settle(page)
    expect(await page.evaluate(selector => { const port = document.querySelector(selector)!; return port.scrollHeight - port.clientHeight - port.scrollTop }, scroller)).toBeLessThanOrEqual(1)
  }).toPass()
}

async function scrollToTop(page: Page, scroller: string): Promise<void> {
  await page.evaluate(selector => document.querySelector(selector)!.scrollTo(0, 0), scroller)
  await settle(page)
}

/**
 * Every control, and every run of words, whose shown part sits under the footer status's box. What shows of a box is
 * the part inside the scroller's frame: a row the frame clips away is not under anything.
 */
function underStatus(page: Page, corner: Corner): Promise<string[]> {
  return page.evaluate(({ status, scroller, content }) => {
    const sentence = document.querySelector(status)
    const port = document.querySelector(scroller)
    const root = document.querySelector(content)
    if (sentence === null || port === null || root === null) return [`missing: ${sentence === null ? status : port === null ? scroller : content}`]
    const box = sentence.getBoundingClientRect()
    if (box.width === 0 || box.height === 0 || !sentence.textContent?.trim()) return ['the footer status is not drawn']
    const frame = port.getBoundingClientRect()
    const under = (rect: DOMRect): boolean => {
      // A visually hidden live region is a pixel square; it shows nothing.
      if (rect.width <= 1 || rect.height <= 1) return false
      const left = Math.max(rect.left, frame.left), right = Math.min(rect.right, frame.right)
      const top = Math.max(rect.top, frame.top), bottom = Math.min(rect.bottom, frame.bottom)
      return right > left && bottom > top && left < box.right && right > box.left && top < box.bottom && bottom > box.top
    }
    const shown = (element: Element): boolean => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
    const found: string[] = []
    for (const control of root.querySelectorAll('button, input, select, textarea, a[href], [role="switch"], [role="slider"], [role="radio"], [role="tab"]')) {
      if (shown(control) && under(control.getBoundingClientRect())) {
        found.push(`control "${control.getAttribute('aria-label') ?? control.textContent?.trim().slice(0, 40)}"`)
      }
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent?.trim()
      if (!text || node.parentElement === null || !shown(node.parentElement)) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      if ([...range.getClientRects()].some(under)) found.push(`words "${text.slice(0, 40)}"`)
    }
    return found
  }, corner)
}

async function shoot(page: Page, name: string): Promise<void> {
  await settle(page)
  expect.soft(await pageBoundProblems(page), `${name} has clipped or overflowing controls`).toEqual([])
  await page.screenshot({ path: join(shots, name), animations: 'disabled', caret: 'hide' })
}

test.describe('the footer status keeps a line of its own (#1907)', () => {
  test.describe.configure({ timeout: 5 * 60_000 })
  test.beforeAll(async () => { await mkdir(shots, { recursive: true }) })

  for (const { appearance, motion, name: look, photographed } of LOOKS) {
    test(`in ${look}, no Settings section's control or words sit under the status, at its heading or at its end`, async () => {
      await withSotto({ onboardingComplete: true, appearance, motion }, async launched => {
        const { page } = launched
        await openPage(page, 'Settings')
        const tabs = page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab')
        await expect(tabs.first()).toBeVisible()
        const names = (await tabs.allTextContents()).map(name => name.trim())
        expect(names).toEqual(expect.arrayContaining([...PHOTOGRAPHED.keys()]))
        for (const [width, height] of SIZES) {
          await holdContentSize(launched, width, height)
          for (const name of names) {
            const tab = page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name, exact: true })
            await tab.click()
            await expect(tab).toHaveAttribute('aria-selected', 'true')
            await scrollToTop(page, SETTINGS.scroller)
            const slug = photographed ? PHOTOGRAPHED.get(name) : undefined
            if (slug === 'providers' && width === 820) await shoot(page, `${slug}-heading-${appearance}-${width}x${height}.png`)
            expect.soft(await underStatus(page, SETTINGS), `${name} at its heading, ${width}x${height}`).toEqual([])
            await scrollToEnd(page, SETTINGS.scroller)
            if (slug !== undefined) await shoot(page, `${slug}-end-${appearance}-${width}x${height}.png`)
            expect.soft(await underStatus(page, SETTINGS), `${name} at its end, ${width}x${height}`).toEqual([])
          }
        }
      })
    })
  }

  test('beside the sidebar, the Dictate room and Help end above their foot line', async () => {
    await withSotto({ onboardingComplete: true }, async launched => {
      const { page } = launched
      for (const room of ['Dictate', 'Help'] as const) {
        await openPage(page, room)
        await expect(page.locator(ROOM.status)).not.toBeEmpty()
        for (const [width, height] of SIZES) {
          await holdContentSize(launched, width, height)
          await scrollToEnd(page, ROOM.scroller)
          expect.soft(await underStatus(page, ROOM), `${room} at its end, ${width}x${height}`).toEqual([])
        }
      }
    })
  })
})
