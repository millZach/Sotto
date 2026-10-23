import { expect, test, type Page } from '@playwright/test'
import { withSotto } from '../fixtures/designCaptureProfile'
import { onReleaseTrack } from './support/releaseTrack'
import { openPage } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'

/**
 * Settings lays its sections out beside a column as wide as the Threads sidebar is, so the room they have shrinks
 * as the sidebar is widened. Every section, on both tracks, still fits at the widths that leave it the least: the
 * sidebar dragged to the widest the window lets it be (470px of room at 820 and at 920 wide) or to 320, and at larger
 * windows dragged to its widest. A classic 17px scrollbar's room is taken from the sections, as Windows draws one and a
 * Mac does not. Run after `npm run build`.
 */
const SIDEBAR_KEY = 'sotto.threadWorkspace.sidebar'
/** The window's size, then the width the sidebar was dragged to. */
const CASES = [[820, 560, 480], [820, 560, 320], [920, 600, 480], [1000, 700, 480], [1120, 800, 480], [1280, 800, 480], [1600, 1000, 480]] as const

interface Fit { readonly pageOverflow: boolean; readonly formOverflow: boolean; readonly clipped: readonly string[] }

/** Whether the open section, scrolled to its top, spills past its column or the window. */
async function fits(page: Page): Promise<Fit> {
  return page.evaluate(() => {
    const scroll = document.querySelector('.settings-scroll')!
    const panel = scroll.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!
    const frame = scroll.getBoundingClientRect()
    const controls = [...panel.querySelectorAll<HTMLElement>('input,select,button,textarea')]
      .filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
    return {
      pageOverflow: document.documentElement.scrollWidth > innerWidth,
      formOverflow: scroll.scrollWidth > scroll.clientWidth + 1,
      clipped: controls.filter(element => { const box = element.getBoundingClientRect(); return box.left < frame.left - 1 || box.right > frame.right + 1 })
        .map(element => element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 60) ?? ''),
    }
  })
}

for (const track of ['stable', 'owl'] as const) {
  test(`${track}: every Settings section fits beside the widest sidebar column`, async () => {
    test.setTimeout(240_000)
    await onReleaseTrack(track, () => withSotto({ onboardingComplete: true, appearance: 'dark', motion: 'reduced', scenario: 'hotkey-conflict' }, async launched => {
      const { page } = launched
      for (const [width, height, saved] of CASES) {
        await resizeContentWindow(launched, width, height, [800, 540])
        await page.evaluate(([key, value]) => localStorage.setItem(key!, value!), [SIDEBAR_KEY, JSON.stringify({ width: saved, chosen: true, collapsed: false })])
        await page.reload()
        await openPage(page, 'Settings')
        await page.addStyleTag({ content: '.settings-detail { padding-right: 17px !important }' })
        const tabs = page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab')
        const names = (await tabs.allInnerTexts()).map(name => name.trim())
        // Stable has nine pages and Owl eleven (ADR-0112); a page added later is checked without changing this list.
        expect(names.length, `${track} sections`).toBeGreaterThanOrEqual(track === 'owl' ? 11 : 9)
        for (const name of names) {
          await tabs.filter({ hasText: new RegExp(`^\\s*${name}\\s*$`) }).first().click()
          await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0 })
          expect(await fits(page), `${track} ${width}x${height}, sidebar saved at ${saved}: ${name}`).toEqual({ pageOverflow: false, formOverflow: false, clipped: [] })
        }
      }
    }))
  })
}
