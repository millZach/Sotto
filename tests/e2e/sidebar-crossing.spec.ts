import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { onReleaseTrack } from './support/releaseTrack'
import { openPage, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'

/**
 * Going to Settings and back leaves the sidebar's frame where it was: the column, the brand in the top row and the foot
 * (its hairline, the room switch, the page links, the update control) are the same boxes on both pages, at the
 * sidebar's default (30% of the window until its edge is dragged, ADR-0110) and at its narrowest, a middle and its widest
 * dragged widths. Run after `npm run build`. Captures go to disposable run evidence; `SOTTO_E2E_EVIDENCE=publish`
 * writes artifacts/sidebar-crossing.
 */
const evidence = evidenceDirectory('artifacts/sidebar-crossing')
/** The Threads sidebar's saved size (src/renderer/src/agents/sidebarSize.ts); the Settings column reads it too. */
const SIDEBAR_KEY = 'sotto.threadWorkspace.sidebar'
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
/** The width the user dragged the sidebar to; null is a sidebar never dragged, which follows the window. */
const SAVED_WIDTHS = [null, 260, 320, 480] as const
const PROFILE = { onboardingComplete: true, appearance: 'dark', motion: 'reduced', scenario: 'design-threads', agents: 'design-threads' } as const

interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
interface Frame {
  readonly column: Box
  readonly brand: Box
  readonly foot: Box
  /** The foot's top border: its width and colour. */
  readonly hairline: string
  /** The switch's row; its width follows the open room, which Settings does not light. */
  readonly switch: Pick<Box, 'y' | 'height'>
  /** Each tile's height. */
  readonly tabs: readonly number[]
  /** The open room's tile shows its whole name inside the foot; true where no room is open. */
  readonly litFits: boolean
  readonly tabFonts: readonly string[]
  readonly links: readonly Box[]
  readonly linkIcons: readonly number[]
  readonly update: Box | null
}

/** Where the sidebar's frame is on the open page, whichever page draws it. */
async function frame(page: Page): Promise<Frame> {
  return page.evaluate(() => {
    const box = (element: Element | null): { x: number; y: number; width: number; height: number } | null => {
      if (element === null) return null
      const { x, y, width, height } = element.getBoundingClientRect()
      const round = (value: number): number => Math.round(value * 100) / 100
      return { x: round(x), y: round(y), width: round(width), height: round(height) }
    }
    const aside = document.querySelector('aside.thread-nav')!
    const foot = aside.querySelector('.thread-nav__foot')!
    const room = foot.querySelector('.thread-nav__seg')!
    const links = [...foot.querySelectorAll('.thread-nav__pages a')]
    const border = getComputedStyle(foot)
    return {
      column: box(aside)!,
      brand: box(aside.querySelector('.thread-nav__brand'))!,
      foot: box(foot)!,
      hairline: `${border.borderTopWidth} ${border.borderTopColor}`,
      // The switch is centred and its open room's tile widens to show its name; Settings opens no room, so only
      // its row and the tiles' height carry over between the pages.
      switch: { y: box(room)!.y, height: box(room)!.height },
      tabs: [...room.querySelectorAll('button')].map(tab => box(tab)!.height),
      tabFonts: [...room.querySelectorAll('button')].map(tab => getComputedStyle(tab).fontSize),
      litFits: (() => {
        const lit = room.querySelector('[aria-selected="true"]'), name = lit?.querySelector('.room-tab__name')
        if (!lit || !name) return true
        return name.scrollWidth <= name.clientWidth + 0.5 && lit.getBoundingClientRect().right <= foot.getBoundingClientRect().right
      })(),
      links: links.map(link => box(link)!),
      linkIcons: links.map(link => box(link.querySelector('svg'))?.width ?? 0),
      update: box(foot.querySelector('.update-control')),
    }
  })
}

async function onThreads(page: Page): Promise<Frame> {
  await openThreads(page)
  // The sidebar with its mode, not the stand-in drawn while agent controls load.
  await expect(page.locator('aside.thread-nav[data-mode]')).toBeVisible()
  return frame(page)
}

async function onSettings(page: Page): Promise<Frame> {
  await openPage(page, 'Settings')
  await expect(page.locator('aside.settings-sidebar')).toBeVisible()
  return frame(page)
}

/** What the sidebar's width comes to in a window, as `useSidebarSize` works it out: a dragged width, or 30% of the window from 260 to 280, kept to 470px short of the window's width. */
function shownWidth(saved: number | null, viewport: number): number {
  const preferred = saved ?? Math.round(Math.max(260, Math.min(280, viewport * 0.3)))
  return Math.min(preferred, Math.min(480, Math.max(260, viewport - 470)))
}

/** Saves the width the user dragged the sidebar to, or with null the record of a sidebar never dragged; then reloads. */
async function saveWidth(page: Page, width: number | null, collapsed = false): Promise<void> {
  const record = width === null ? { collapsed } : { width, chosen: true, collapsed }
  await page.evaluate(([key, value]) => localStorage.setItem(key!, value!), [SIDEBAR_KEY, JSON.stringify(record)])
  await page.reload()
}

async function checkCrossing(launched: LaunchedSotto, track: 'stable' | 'owl'): Promise<void> {
  const { page } = launched
  for (const [width, height] of SIZES) {
    await resizeContentWindow(launched, width, height, [800, 540])
    for (const saved of SAVED_WIDTHS) {
      await saveWidth(page, saved)
      const threads = await onThreads(page)
      const settings = await onSettings(page)
      const again = await onThreads(page)
      const label = `${track} ${width}x${height}, saved ${saved}`
      expect(threads.column.width, label).toBe(shownWidth(saved, width))
      expect(settings, label).toEqual(threads)
      expect(again, label).toEqual(threads)
      // The look the Settings column had: the hairline stops 10px short of each edge (the column's own border is the
      // last pixel), the links sit 6px inside it, and the switch is one tile per room.
      expect(threads.hairline, label).toMatch(/^1px /u)
      expect(threads.foot.x, label).toBe(10)
      expect(threads.foot.x + threads.foot.width, label).toBe(threads.column.width - 1 - 10)
      expect(threads.tabs, label).toHaveLength(3)
      expect(threads.litFits, label).toBe(true)
    }
  }
}

for (const track of ['stable', 'owl'] as const) {
  test(`${track}: Threads and Settings draw the sidebar's frame the same`, async () => {
    test.setTimeout(240_000)
    await onReleaseTrack(track, () => withSotto(PROFILE, launched => checkCrossing(launched, track)))
  })
}

test('owl with dictation off: the owl and Threads draw the foot the same on both pages (ADR-0107)', async () => {
  test.setTimeout(120_000)
  await onReleaseTrack('owl', () => withSotto(PROFILE, async launched => {
    const { page } = launched
    await resizeContentWindow(launched, 1280, 800, [800, 540])
    await page.evaluate(async () => window.sotto!.updateSettings({ dictationEnabled: false }))
    await page.reload()
    const threads = await onThreads(page)
    const settings = await onSettings(page)
    expect(threads.tabs).toHaveLength(2)
    expect(settings).toEqual(threads)
    expect(threads.foot.x).toBe(10)
  }))
})

test('the top row meets the window corner on Windows and Linux as it does on a Mac', async () => {
  test.setTimeout(120_000)
  await withSotto(PROFILE, async launched => {
    const { page } = launched
    await resizeContentWindow(launched, 1280, 800, [800, 540])
    // The platform is the machine's; take the macOS class off to draw the path Windows and Linux take, and let what the
    // change sets moving settle before the boxes are read.
    const withoutMacClass = async (): Promise<void> => {
      await page.evaluate(async () => {
        document.querySelectorAll('.thread-nav--mac').forEach(element => element.classList.remove('thread-nav--mac'))
        await Promise.all(document.getAnimations().filter(animation => animation instanceof CSSTransition).map(animation => animation.finished.catch(() => undefined)))
      })
    }
    for (const saved of [260, 320] as const) {
      await saveWidth(page, saved)
      await openThreads(page)
      await expect(page.locator('aside.thread-nav[data-mode]')).toBeVisible()
      await withoutMacClass()
      const threads = await frame(page)
      await openPage(page, 'Settings')
      await expect(page.locator('aside.settings-sidebar')).toBeVisible()
      await withoutMacClass()
      const settings = await frame(page)
      // At the narrowest widths the wordmark gives way to the mark on both pages, so the brand is the same box too.
      expect(settings.brand, `saved ${saved}`).toEqual(threads.brand)
      expect(threads.brand.x, `saved ${saved}`).toBe(14)
      expect(threads.brand.y + threads.brand.height / 2, `saved ${saved}`).toBeCloseTo(22, 0)
      expect(settings, `saved ${saved}`).toEqual(threads)
    }
  })
})

test('Settings keeps the width the sidebar expands to while the Threads sidebar is collapsed', async () => {
  test.setTimeout(120_000)
  await withSotto(PROFILE, async launched => {
    const { page } = launched
    await resizeContentWindow(launched, 1280, 800, [800, 540])
    await saveWidth(page, 400)
    await onThreads(page)
    // Collapsed from the page: a collapsed rail has no switch to reach Threads by, so it is not saved before the page loads.
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible()
    expect((await onSettings(page)).column.width).toBe(400)
  })
})

test('evidence: the sidebar foot on Threads and on Settings', async () => {
  test.setTimeout(180_000)
  for (const [track, appearance] of [['stable', 'dark'], ['stable', 'light'], ['owl', 'dark']] as const) {
    await onReleaseTrack(track, () => withSotto({ ...PROFILE, appearance }, async launched => {
      const { page } = launched
      const pages = [['threads', onThreads], ['settings', onSettings]] as const
      await resizeContentWindow(launched, 1280, 800, [800, 540])
      for (const [name, open] of pages) {
        const { column } = await open(page)
        await page.mouse.move(700, 400)
        await page.screenshot({ path: join(evidence, `${track === 'owl' ? 'owl-' : ''}${name}-foot-${appearance}.png`), animations: 'disabled', caret: 'hide',
          clip: { x: 0, y: 800 - 130, width: column.width + 40, height: 130 } })
      }
      if (track !== 'stable' || appearance !== 'dark') return
      // The window at its minimum, where the column is as wide as on a large one and the sections still fit beside it.
      await resizeContentWindow(launched, 820, 560, [800, 540])
      for (const [name, open] of pages) {
        await open(page)
        await page.mouse.move(700, 300)
        await page.screenshot({ path: join(evidence, `${name}-820x560-dark.png`), animations: 'disabled', caret: 'hide' })
      }
    }))
  }
})
