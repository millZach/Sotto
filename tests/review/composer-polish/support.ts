import { mkdir, writeFile } from 'node:fs/promises'
import { expect, type Locator, type Page } from '@playwright/test'
import type { LaunchedSotto } from '../../e2e/support/sottoLaunch'

export const SHOTS = 'artifacts/phase-two-composer-fixed'

export async function size(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    // 760 is a stress width below the shipped 820 minimum.
    window.setMinimumSize(700, 500)
    window.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => launched.page.evaluate(() => [window.innerWidth, window.innerHeight].join('x'))).toBe(`${width}x${height}`)
  await launched.page.waitForTimeout(150)
}

export async function appTheme(page: Page, appearance: 'dark' | 'light', accent = 'teal'): Promise<void> {
  await page.evaluate(async ([mode, color]) => window.sotto!.updateSettings({ appearance: mode as 'dark' | 'light', accent: color as 'teal' }), [appearance, accent] as const)
  await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
}

export async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'disabled' })
}

/** Electron zoom is not followed by Playwright's capture, so the window captures itself. */
export async function windowShot(launched: LaunchedSotto, name: string): Promise<void> {
  await mkdir(SHOTS, { recursive: true })
  const png = await launched.app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!.webContents.capturePage()).toPNG().toString('base64'))
  await writeFile(`${SHOTS}/${name}.png`, Buffer.from(png, 'base64'))
}

export async function zoom(launched: LaunchedSotto, factor: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, factor) => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!.webContents.setZoomFactor(factor), factor)
}

export async function evidence(name: string, data: unknown): Promise<void> {
  await mkdir(SHOTS, { recursive: true })
  await writeFile(`${SHOTS}/${name}.json`, `${JSON.stringify(data, null, 2)}\n`)
}

/** The focused element as a short label, for keyboard records. */
export async function focusedLabel(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.activeElement
    if (!element || element === document.body) return '(body)'
    const label = element.getAttribute('aria-label') || element.getAttribute('title') || (element.id ? `#${element.id}` : '') || (element as HTMLElement).innerText || ''
    return `${element.tagName.toLowerCase()}:${label.trim().replace(/\s+/gu, ' ').slice(0, 50)}`
  })
}

export interface PaneMetrics {
  readonly viewport: string
  readonly pane: Rect | null
  readonly paneScroll: string | null
  readonly transcriptClientHeight: number | null
  readonly compose: Rect | null
  readonly followups: Rect | null
  readonly card: Rect | null
  readonly cardFullyVisible: boolean | null
  readonly picker: Rect | null
  /** Regions whose content is currently taller than their box: `class:client/scroll`. */
  readonly scrollers: string[]
  /** Controls outside the window or the pane's visible area. */
  readonly outsideControls: string[]
  readonly queueHead: string | null
  readonly status: string | null
  readonly fonts: Record<string, string | null>
}
interface Rect { readonly top: number; readonly bottom: number; readonly height: number }

/**
 * Layout facts for one pane: rectangles, every region that is actually scrolling, controls outside the window or the
 * pane's visible area, and the type sizes a composing user reads.
 */
export async function paneMetrics(page: Page, scope = 'section.thread-pane[data-focused]'): Promise<PaneMetrics> {
  return page.evaluate(scope => {
    const root = document.querySelector(scope) ?? document.querySelector('section.thread-pane') ?? document.body
    const round = (rect: DOMRect) => ({ top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) })
    const box = (element: Element | null) => element ? round(element.getBoundingClientRect()) : null
    const paneRect = root.getBoundingClientRect()
    const visibleTop = Math.max(0, paneRect.top)
    const visibleBottom = Math.min(window.innerHeight, paneRect.bottom)
    const controls = [...root.querySelectorAll('button, textarea, .thread-followup__text')]
      // Transcript content scrolls inside its own log; only the pane's fixed controls count.
      .filter(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && !element.closest('[aria-label="Thread transcript"]') })
    const label = (element: Element) => (element.getAttribute('aria-label') || element.textContent || element.tagName).trim().slice(0, 50)
    const outsideControls = controls.filter(element => { const rect = element.getBoundingClientRect(); return rect.bottom > visibleBottom + 1 || rect.top < visibleTop - 1 }).map(label)
    const scrollers = [root, ...root.querySelectorAll('*')].filter(element => /(auto|scroll)/u.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 1)
      .map(element => `${element.className.toString().split(' ')[0] || element.tagName}:${element.clientHeight}/${element.scrollHeight}`)
    const transcript = root.querySelector('[aria-label="Thread transcript"]')
    const card = root.querySelector('.thread-prompt, .agent-composer, .thread-draft-notice')
    const cardRect = card?.getBoundingClientRect()
    const font = (selector: string) => { const element = root.querySelector(selector); return element ? getComputedStyle(element).fontSize : null }
    return {
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      pane: box(root),
      paneScroll: root instanceof HTMLElement ? `${root.clientHeight}/${root.scrollHeight}` : null,
      transcriptClientHeight: transcript instanceof HTMLElement ? transcript.clientHeight : null,
      compose: box(root.querySelector('.thread-workspace__compose')),
      followups: box(root.querySelector('.thread-followups')),
      card: box(card ?? null),
      cardFullyVisible: cardRect ? cardRect.bottom <= visibleBottom + 1 && cardRect.top >= visibleTop - 1 : null,
      picker: box(root.querySelector('.skill-picker')),
      scrollers,
      outsideControls,
      queueHead: root.querySelector('.thread-followups__head')?.textContent ?? null,
      status: root.querySelector('.thread-prompt__status')?.textContent ?? null,
      fonts: {
        prompt: font('.thread-prompt textarea, .agent-composer textarea'), queueRow: font('.thread-followup__text'), queueToggle: font('.thread-followups__toggle'),
        queueNote: font('.thread-followups__note'), status: font('.thread-prompt__status'), pickerName: font('.skill-picker__name'),
      },
    }
  }, scope)
}

/** Each visible control can be brought fully on screen by scrolling: the stress sizes promise reachability, not fit. */
export async function unreachable(controls: Locator): Promise<string[]> {
  const missed: string[] = []
  for (const control of await controls.all()) {
    if (!await control.isVisible()) continue
    await control.scrollIntoViewIfNeeded()
    const inside = await control.evaluate(element => {
      const rect = element.getBoundingClientRect()
      let top = 0
      let bottom = window.innerHeight
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (getComputedStyle(parent).overflowY === 'visible') continue
        const clip = parent.getBoundingClientRect()
        top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom)
      }
      return rect.top >= top - 1 && rect.bottom <= bottom + 1
    })
    if (!inside) missed.push((await control.getAttribute('aria-label')) ?? (await control.innerText()).slice(0, 40))
  }
  return missed
}
